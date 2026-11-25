import {
  SECURITY_MODEL_IDS,
  SECURITY_PROVIDER_NOTICE_VERSION,
} from '@void/platform/security-models';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  cancelScanThroughScheduler,
  requireCancelableScan,
  requireProject,
  securityOperatorError,
} from '../../operator/security-routes.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { pokeSecurityScanScheduler } from '../../security/enqueue.ts';
import {
  changeSecurityBudgets,
  parseSecurityCeilingRequest,
  queueSecurityRescan,
  setProjectSecurityCeiling,
  setProjectSecurityPolicyOverride,
} from '../../security/operator.ts';
import { changeSecurityPolicy, readStoredSecurityPolicy } from '../../security/policy.ts';
import { probeAndRecord, runSecurityProbe } from '../../security/probe.ts';
import { parseSecurityProjectPolicyRequest } from '../../security/project-policy.ts';
import {
  parseSecurityModelRequest,
  setProjectSecurityModel,
} from '../../security/project-settings.ts';
import { bypassPublicRequest } from '../../security/public-gate-flow.ts';
import { renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';
import { renderAdminPage } from '../react/server.ts';
import { markBypassesSeen, SECURITY_HOME } from '../security-data.ts';

type Form = Record<string, string | File | Array<string | File>>;
type AdminContext = Context<ApiEnv>;

function text(form: Form, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : '';
}

function requireCapability(context: Pick<AdminContext, 'env'>): void {
  if (!getPlatformCapabilities(context.env).securityAudits) {
    throw new OperatorError(
      501,
      'This Void platform does not enable security audits. Run: void platform upgrade --security-audits',
      'platform capability unavailable',
    );
  }
}

function wholeNumber(form: Form, name: string): number {
  const value = Number(text(form, name).trim());
  if (!Number.isSafeInteger(value)) {
    throw new OperatorError(400, `${name} must be a whole number.`, 'invalid_argument');
  }
  return value;
}

function dollars(form: Form, name: string): number {
  const raw = text(form, name).trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0) {
    throw new OperatorError(
      400,
      `${name} must be a dollar amount of 0 or more.`,
      'invalid_argument',
    );
  }
  return value;
}

function withRevision(form: Form) {
  const value = Number(text(form, 'expectedRevision'));
  return text(form, 'expectedRevision') !== '' && Number.isSafeInteger(value)
    ? { expectedRevision: value }
    : {};
}

function acceptNotice(form: Form) {
  return text(form, 'acceptNotice') === 'yes'
    ? { acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION }
    : {};
}

/** The form fields to post again on apply: these text fields plus the ticked boxes. */
function repost(
  form: Form,
  expectedRevision: number,
  names: ReadonlyArray<string>,
  boxes: ReadonlyArray<string>,
): Array<[string, string]> {
  return [
    ['expectedRevision', String(expectedRevision)],
    ...names.map((name): [string, string] => [name, text(form, name)]),
    ...boxes.flatMap((name): Array<[string, string]> =>
      text(form, name) === 'yes' ? [[name, 'yes']] : [],
    ),
  ];
}

/**
 * An audited write: refusals of the security operations map to the operator error (so
 * the audit row keeps their status), then the browser goes to `redirect`.
 */
function audited<T>(
  context: AdminContext,
  action: string,
  body: Record<string, unknown> | undefined,
  redirect: string,
  run: () => Promise<T>,
) {
  return executeAuditedMutation(context, operatorAuditIntent(action, body), async () => {
    try {
      await run();
    } catch (error) {
      throw securityOperatorError(error);
    }
    return { response: context.redirect(redirect), succeeded: true };
  });
}

async function preview<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw securityOperatorError(error);
  }
}

function previewPage(
  context: AdminContext,
  props: Readonly<{
    title: string;
    lines: ReadonlyArray<string>;
    action: string;
    fields: ReadonlyArray<[string, string]>;
  }>,
) {
  return renderAdminPage(context, 'securityPreview', props.title, {
    ...props,
    back: SECURITY_HOME,
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  });
}

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);
// Admin pages return their own Responses, so the headers go on the final one.
app.use('*', async (context, next) => {
  await next();
  context.res.headers.set('Cache-Control', 'no-store');
});
app.use('*', async (context, next) => {
  if (context.req.method !== 'GET') {
    requireCapability(context);
  }
  await next();
});

for (const path of ['/', '/findings', '/scans', '/requests']) {
  app.get(path, (context) => renderFateListPage(context, 'security'));
}

// Policy and budgets: a preview step shows the plan, a second step applies it.

app.post('/policy', async (context) => {
  const form = (await context.req.parseBody()) as Form;
  const body = {
    ...withRevision(form),
    mode: text(form, 'mode'),
    publicGate: text(form, 'publicGate') === 'yes',
    defaultModel: text(form, 'defaultModel'),
    // A ticked box lets projects pick the model; an unticked one blocks it.
    blockedModels: SECURITY_MODEL_IDS.filter((id) => text(form, `allow:${id}`) !== 'yes'),
    limits: {
      concurrency: wholeNumber(form, 'concurrency'),
      timeoutMinutes: wholeNumber(form, 'timeoutMinutes'),
    },
    ...acceptNotice(form),
  };
  const db = context.get('db');
  const userId = context.get('user').id;
  if (text(form, 'step') !== 'apply') {
    const result = await preview(() => changeSecurityPolicy(db, body, { userId, preview: true }));
    if (!('dryRun' in result)) {
      throw new OperatorError(500, 'The preview did not return a plan.');
    }
    return previewPage(context, {
      title: 'Review the security policy change',
      lines: result.preview,
      action: `${SECURITY_HOME}/policy`,
      fields: repost(
        form,
        result.expectedRevision,
        ['mode', 'defaultModel', 'concurrency', 'timeoutMinutes'],
        ['publicGate', 'acceptNotice', ...SECURITY_MODEL_IDS.map((id) => `allow:${id}`)],
      ),
    });
  }
  return audited(context, 'security/policy', body, SECURITY_HOME, async () => {
    const result = await changeSecurityPolicy(db, body, {
      userId,
      preview: false,
      // Leaving `disabled` re-runs the probe (and provisions the scanner) first.
      probe: async () =>
        runSecurityProbe(context.env, db, (await readStoredSecurityPolicy(db)).policy),
    });
    if ('canceledRequests' in result && result.canceledRequests > 0) {
      await pokeSecurityScanScheduler(context.env);
    }
  });
});

function capLine(label: string, on: boolean, usd: number): string {
  return `${label}: ${on ? `on, $${usd} / month` : 'off'}`;
}

app.post('/budget', async (context) => {
  const form = (await context.req.parseBody()) as Form;
  const body = {
    ...withRevision(form),
    platformMonthlyUsd:
      text(form, 'platformCapOn') === 'yes' ? dollars(form, 'platformMonthlyUsd') : null,
    projectDefaultMonthlyUsd:
      text(form, 'projectCapsOn') === 'yes' ? dollars(form, 'projectDefaultMonthlyUsd') : null,
  };
  const db = context.get('db');
  if (text(form, 'step') !== 'apply') {
    const result = await preview(() => changeSecurityBudgets(db, body, { preview: true }));
    if (!result.dryRun || !result.from || !result.to) {
      throw new OperatorError(500, 'The preview did not return a plan.');
    }
    const { from, to } = result;
    return previewPage(context, {
      title: 'Review the security budget change',
      lines: [
        `${capLine('Platform cap', from.platformCapOn, from.platformMonthlyUsd)} -> ${capLine('Platform cap', to.platformCapOn, to.platformMonthlyUsd)}`,
        `${capLine('Project caps', from.projectCapsOn, from.projectDefaultMonthlyUsd)} -> ${capLine('Project caps', to.projectCapsOn, to.projectDefaultMonthlyUsd)}`,
      ],
      action: `${SECURITY_HOME}/budget`,
      fields: repost(
        form,
        result.expectedRevision,
        ['platformMonthlyUsd', 'projectDefaultMonthlyUsd'],
        ['platformCapOn', 'projectCapsOn'],
      ),
    });
  }
  return audited(context, 'security/budget', body, SECURITY_HOME, () =>
    changeSecurityBudgets(db, body, { preview: false }),
  );
});

app.post('/probe', async (context) =>
  audited(context, 'security/probe', undefined, SECURITY_HOME, () =>
    probeAndRecord(context.env, context.get('db')),
  ),
);

app.post('/scans/:sid/cancel', async (context) => {
  const scanId = context.req.param('sid');
  return audited(
    context,
    `security/scans/${scanId}/cancel`,
    undefined,
    `${SECURITY_HOME}/scans`,
    async () => {
      const scan = await requireCancelableScan(context.get('db'), scanId);
      await cancelScanThroughScheduler(context.env, scan.id);
    },
  );
});

app.post('/bypasses/seen', async (context) =>
  audited(context, 'security/bypasses-seen', undefined, `${SECURITY_HOME}/requests`, async () => {
    const form = (await context.req.parseBody()) as Form;
    await markBypassesSeen(context.get('db'), context.get('user').id, text(form, 'through'));
  }),
);

export default app;

// Project detail: model, budget limit, scan rule, rescan and the bypass.

export const adminProjectSecurity = new Hono<ApiEnv>();
adminProjectSecurity.onError(renderOperationError);
// Scoped to the security paths: this app shares its mount point with the project routes.
// The bypass route is not behind the capability guard, like the operator route, so it
// answers with the request's real state instead of 501. With the capability off the gate
// reads off: a request held before that no longer holds anything (making the project
// public goes straight through), and a bypass is refused as "already canceled".
adminProjectSecurity.use('/:id/security/*', async (context, next) => {
  if (!context.req.path.endsWith('/security/bypass')) {
    requireCapability(context);
  }
  await next();
});

/** One project form: audited, the project must exist, then back to its section. */
function projectForm<T>(
  path: string,
  readBody: (form: Form) => Record<string, unknown>,
  run: (context: AdminContext, projectId: string, body: Record<string, unknown>) => Promise<T>,
) {
  const bypass = path === 'bypass';
  const auditPath = path === 'rescan' ? 'scans' : bypass ? 'public-request/bypass' : path;
  adminProjectSecurity.post(`/:id/security/${path}`, async (context) => {
    const projectId = context.req.param('id');
    const body = readBody((await context.req.parseBody()) as Form);
    return audited(
      context,
      `projects/${projectId}/security/${auditPath}`,
      // The bypass reason is stored with the bypass record, never in the audit row.
      bypass ? undefined : body,
      `/admin/projects/${encodeURIComponent(projectId)}#${bypass ? 'zero-trust' : 'security'}`,
      async () => {
        await requireProject(context.get('db'), projectId);
        await run(context, projectId, body);
      },
    );
  });
}

projectForm(
  'model',
  (form) => {
    const model = text(form, 'model');
    return { model: model === '' ? null : model, ...acceptNotice(form) };
  },
  (context, projectId, body) =>
    setProjectSecurityModel(context.get('db'), {
      projectId,
      userId: context.get('user').id,
      request: parseSecurityModelRequest(body),
    }),
);

projectForm(
  'budget',
  (form) => {
    const raw = text(form, 'monthlyUsd').trim();
    return { monthlyUsd: raw === '' ? null : Number(raw) };
  },
  (context, projectId, body) =>
    setProjectSecurityCeiling(context.get('db'), {
      projectId,
      userId: context.get('user').id,
      cents: parseSecurityCeilingRequest(body),
    }),
);

projectForm(
  'policy',
  (form) => ({ override: text(form, 'override') }),
  (context, projectId, body) =>
    setProjectSecurityPolicyOverride(context.get('db'), {
      projectId,
      userId: context.get('user').id,
      override: parseSecurityProjectPolicyRequest(body),
    }),
);

projectForm(
  'rescan',
  () => ({}),
  async (context, projectId) => {
    await queueSecurityRescan(context.env, context.get('db'), projectId);
    await pokeSecurityScanScheduler(context.env);
  },
);

projectForm(
  'bypass',
  (form) => ({ reason: text(form, 'reason') }),
  (context, projectId, body) =>
    bypassPublicRequest(context.env, context.get('db'), {
      projectId,
      reason: body.reason,
      actor: { kind: 'installation_admin', userId: context.get('user').id, role: null },
    }),
);
