import {
  SECURITY_MODEL_IDS,
  SECURITY_PROVIDER_NOTICE_VERSION,
} from '@void/platform/security-models';
import { Hono, type Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import { getProject } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import { securityOperatorError } from '../../operator/security-routes.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { pokeSecurityScanScheduler } from '../../security/enqueue.ts';
import {
  changeSecurityBudgets,
  parseSecurityCeilingRequest,
  queueSecurityRescan,
  readCancelableScan,
  SECURITY_SCAN_CANCELABLE,
  setProjectSecurityCeiling,
} from '../../security/operator.ts';
import {
  changeSecurityPolicy,
  readStoredSecurityPolicy,
  type SecurityPolicyChangeResult,
} from '../../security/policy.ts';
import { probeAndRecord, runSecurityProbe } from '../../security/probe.ts';
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

function text(form: Form, name: string): string {
  const value = form[name];
  return typeof value === 'string' ? value : '';
}

function requireCapability(context: Context<ApiEnv>): void {
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

function revision(form: Form): number | undefined {
  const value = Number(text(form, 'expectedRevision'));
  return text(form, 'expectedRevision') !== '' && Number.isSafeInteger(value) ? value : undefined;
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

app.get('/', (context) => renderFateListPage(context, 'security'));
app.get('/findings', (context) => renderFateListPage(context, 'security'));
app.get('/scans', (context) => renderFateListPage(context, 'security'));
app.get('/requests', (context) => renderFateListPage(context, 'security'));

// ---------------------------------------------------------------------------
// Policy and budgets: a preview step shows the plan, a second step applies it
// ---------------------------------------------------------------------------

function policyBody(form: Form): Record<string, unknown> {
  const expectedRevision = revision(form);
  return {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    mode: text(form, 'mode'),
    publicGate: text(form, 'publicGate') === 'yes',
    defaultModel: text(form, 'defaultModel'),
    // A ticked box lets projects pick the model; an unticked one blocks it.
    blockedModels: SECURITY_MODEL_IDS.filter((id) => text(form, `allow:${id}`) !== 'yes'),
    limits: {
      concurrency: wholeNumber(form, 'concurrency'),
      timeoutMinutes: wholeNumber(form, 'timeoutMinutes'),
    },
    ...(text(form, 'acceptNotice') === 'yes'
      ? { acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION }
      : {}),
  };
}

function policyFields(form: Form, expectedRevision: number): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ['expectedRevision', String(expectedRevision)],
    ['mode', text(form, 'mode')],
    ['defaultModel', text(form, 'defaultModel')],
    ['concurrency', text(form, 'concurrency')],
    ['timeoutMinutes', text(form, 'timeoutMinutes')],
  ];
  for (const name of ['publicGate', 'acceptNotice']) {
    if (text(form, name) === 'yes') {
      fields.push([name, 'yes']);
    }
  }
  for (const id of SECURITY_MODEL_IDS) {
    if (text(form, `allow:${id}`) === 'yes') {
      fields.push([`allow:${id}`, 'yes']);
    }
  }
  return fields;
}

function previewPage(
  context: Context<ApiEnv>,
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

app.post('/policy', async (context) => {
  const form = (await context.req.parseBody()) as Form;
  const body = policyBody(form);
  const db = context.get('db');
  const userId = context.get('user').id;
  if (text(form, 'step') !== 'apply') {
    let result: SecurityPolicyChangeResult;
    try {
      result = await changeSecurityPolicy(db, body, { userId, preview: true });
    } catch (error) {
      throw securityOperatorError(error);
    }
    if (!('dryRun' in result)) {
      throw new OperatorError(500, 'The preview did not return a plan.');
    }
    return previewPage(context, {
      title: 'Review the security policy change',
      lines: result.preview,
      action: `${SECURITY_HOME}/policy`,
      fields: policyFields(form, result.expectedRevision),
    });
  }
  return executeAuditedMutation(context, operatorAuditIntent('security/policy', body), async () => {
    try {
      const result = await changeSecurityPolicy(db, body, {
        userId,
        preview: false,
        // Leaving `disabled` re-runs the probe (and provisions the scanner) first.
        probe: async () =>
          runSecurityProbe(context.env, (await readStoredSecurityPolicy(db)).policy),
      });
      if ('canceledRequests' in result && result.canceledRequests > 0) {
        await pokeSecurityScanScheduler(context.env);
      }
    } catch (error) {
      throw securityOperatorError(error);
    }
    return { response: context.redirect(SECURITY_HOME), succeeded: true };
  });
});

function budgetBody(form: Form): Record<string, unknown> {
  const expectedRevision = revision(form);
  return {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    platformMonthlyUsd:
      text(form, 'platformCapOn') === 'yes' ? dollars(form, 'platformMonthlyUsd') : null,
    projectDefaultMonthlyUsd:
      text(form, 'projectCapsOn') === 'yes' ? dollars(form, 'projectDefaultMonthlyUsd') : null,
  };
}

function capLine(label: string, on: boolean, usd: number): string {
  return `${label}: ${on ? `on, $${usd} / month` : 'off'}`;
}

app.post('/budget', async (context) => {
  const form = (await context.req.parseBody()) as Form;
  const body = budgetBody(form);
  const db = context.get('db');
  if (text(form, 'step') !== 'apply') {
    let result: Awaited<ReturnType<typeof changeSecurityBudgets>>;
    try {
      result = await changeSecurityBudgets(db, body, { preview: true });
    } catch (error) {
      throw securityOperatorError(error);
    }
    if (!result.dryRun || !result.from || !result.to) {
      throw new OperatorError(500, 'The preview did not return a plan.');
    }
    const fields: Array<[string, string]> = [
      ['expectedRevision', String(result.expectedRevision)],
      ['platformMonthlyUsd', text(form, 'platformMonthlyUsd')],
      ['projectDefaultMonthlyUsd', text(form, 'projectDefaultMonthlyUsd')],
    ];
    for (const name of ['platformCapOn', 'projectCapsOn']) {
      if (text(form, name) === 'yes') {
        fields.push([name, 'yes']);
      }
    }
    const { from, to } = result;
    return previewPage(context, {
      title: 'Review the security budget change',
      lines: [
        `${capLine('Platform cap', from.platformCapOn, from.platformMonthlyUsd)} -> ${capLine('Platform cap', to.platformCapOn, to.platformMonthlyUsd)}`,
        `${capLine('Project caps', from.projectCapsOn, from.projectDefaultMonthlyUsd)} -> ${capLine('Project caps', to.projectCapsOn, to.projectDefaultMonthlyUsd)}`,
      ],
      action: `${SECURITY_HOME}/budget`,
      fields,
    });
  }
  return executeAuditedMutation(context, operatorAuditIntent('security/budget', body), async () => {
    try {
      await changeSecurityBudgets(db, body, { preview: false });
    } catch (error) {
      throw securityOperatorError(error);
    }
    return { response: context.redirect(SECURITY_HOME), succeeded: true };
  });
});

app.post('/probe', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('security/probe'), async () => {
    await probeAndRecord(context.env, context.get('db'));
    return { response: context.redirect(SECURITY_HOME), succeeded: true };
  }),
);

app.post('/scans/:sid/cancel', async (context) => {
  const scanId = context.req.param('sid');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`security/scans/${scanId}/cancel`),
    async () => {
      const scan = await readCancelableScan(context.get('db'), scanId);
      if (!scan) {
        throw new OperatorError(404, 'Scan not found.', 'not_found');
      }
      if (!SECURITY_SCAN_CANCELABLE.includes(scan.status)) {
        throw new OperatorError(
          409,
          `Scan ${scan.id} is ${scan.status}; only a waiting or running scan can be canceled.`,
          'security_scan_not_cancelable',
        );
      }
      try {
        const scheduler = context.env.SECURITY_SCAN_SCHEDULER;
        await scheduler
          .get(scheduler.idFromName('global'))
          .cancelScans([scan.id], 'operator_canceled');
      } catch (error) {
        console.error('[security-scan] admin cancel failed', error);
        throw new OperatorError(
          502,
          'The scan scheduler did not answer. Run the cancel again.',
          'security_scheduler_unavailable',
        );
      }
      return { response: context.redirect(`${SECURITY_HOME}/scans`), succeeded: true };
    },
  );
});

app.post('/bypasses/seen', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('security/bypasses-seen'), async () => {
    const form = (await context.req.parseBody()) as Form;
    await markBypassesSeen(context.get('db'), context.get('user').id, text(form, 'through'));
    return { response: context.redirect(`${SECURITY_HOME}/requests`), succeeded: true };
  }),
);

export default app;

// ---------------------------------------------------------------------------
// Project detail: model, budget limit, rescan and the bypass
// ---------------------------------------------------------------------------

export const adminProjectSecurity = new Hono<ApiEnv>();
adminProjectSecurity.onError(renderOperationError);
// Scoped to the security paths: this app shares its mount point with the project routes.
// The bypass stays open with the capability off, like the operator route: a request held
// before the capability went off is no longer re-checked, and this is how an admin lets it out.
adminProjectSecurity.use('/:id/security/*', async (context, next) => {
  if (!context.req.path.endsWith('/security/bypass')) {
    requireCapability(context);
  }
  await next();
});

async function requireProject(context: Context<ApiEnv>, projectId: string) {
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }
  return project;
}

function back(context: Context<ApiEnv>, projectId: string, anchor: string): Response {
  return context.redirect(`/admin/projects/${encodeURIComponent(projectId)}#${anchor}`);
}

adminProjectSecurity.post('/:id/security/model', async (context) => {
  const projectId = context.req.param('id');
  const form = (await context.req.parseBody()) as Form;
  const model = text(form, 'model');
  const body = {
    model: model === '' ? null : model,
    ...(text(form, 'acceptNotice') === 'yes'
      ? { acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION }
      : {}),
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/security/model`, body),
    async () => {
      await requireProject(context, projectId);
      try {
        await setProjectSecurityModel(context.get('db'), {
          projectId,
          userId: context.get('user').id,
          request: parseSecurityModelRequest(body),
        });
      } catch (error) {
        throw securityOperatorError(error);
      }
      return { response: back(context, projectId, 'security'), succeeded: true };
    },
  );
});

adminProjectSecurity.post('/:id/security/budget', async (context) => {
  const projectId = context.req.param('id');
  const form = (await context.req.parseBody()) as Form;
  const raw = text(form, 'monthlyUsd').trim();
  const body = { monthlyUsd: raw === '' ? null : Number(raw) };
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/security/budget`, body),
    async () => {
      await requireProject(context, projectId);
      try {
        await setProjectSecurityCeiling(context.get('db'), {
          projectId,
          userId: context.get('user').id,
          cents: parseSecurityCeilingRequest(body),
        });
      } catch (error) {
        throw securityOperatorError(error);
      }
      return { response: back(context, projectId, 'security'), succeeded: true };
    },
  );
});

adminProjectSecurity.post('/:id/security/rescan', async (context) => {
  const projectId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/security/scans`),
    async () => {
      await requireProject(context, projectId);
      try {
        await queueSecurityRescan(context.env, context.get('db'), projectId);
      } catch (error) {
        throw securityOperatorError(error);
      }
      await pokeSecurityScanScheduler(context.env);
      return { response: back(context, projectId, 'security'), succeeded: true };
    },
  );
});

adminProjectSecurity.post('/:id/security/bypass', async (context) => {
  const projectId = context.req.param('id');
  const form = (await context.req.parseBody()) as Form;
  // The reason is stored with the bypass record and never copied into the audit row.
  const reason = text(form, 'reason');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/security/public-request/bypass`),
    async () => {
      await requireProject(context, projectId);
      try {
        await bypassPublicRequest(context.env, context.get('db'), {
          projectId,
          reason,
          actor: { kind: 'installation_admin', userId: context.get('user').id, role: null },
        });
      } catch (error) {
        throw securityOperatorError(error);
      }
      return { response: back(context, projectId, 'zero-trust'), succeeded: true };
    },
  );
});
