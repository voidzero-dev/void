import { parseSecurityWebhookUrl } from '@void/platform/security-policy';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { capabilityMiddleware, getPlatformCapabilities } from '../capabilities.ts';
import { getProject } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  changeSecurityProviderKey,
  parseSecurityProviderKeyRequest,
  previewSecurityProviderKey,
} from '../security/byok.ts';
import { pokeSecurityScanScheduler } from '../security/enqueue.ts';
import { SecurityApiError } from '../security/errors.ts';
import {
  changeSecurityBudgets,
  listOperatorBypasses,
  listOperatorPublicRequests,
  listOperatorSecurityFindings,
  listOperatorSecurityScans,
  parseOperatorFindingFilter,
  parseOperatorRequestFilter,
  parseOperatorScanFilter,
  parseSecurityCeilingRequest,
  previewInRollback,
  previewSecurityRescan,
  queueSecurityRescan,
  readCancelableScan,
  SECURITY_SCAN_CANCELABLE,
  securityBudgetStatus,
  setProjectSecurityCeiling,
  setProjectSecurityPolicyOverride,
} from '../security/operator.ts';
import {
  changeSecurityPolicy,
  readStoredSecurityPolicy,
  securityPolicyView,
  securityStatus,
} from '../security/policy.ts';
import { probeAndRecord, runSecurityProbe } from '../security/probe.ts';
import {
  commentOnSecurityFinding,
  parseSecurityComment,
  parseSecurityResolution,
  reopenSecurityFinding,
  resolveSecurityFinding,
  showSecurityFinding,
} from '../security/project-findings.ts';
import { parseSecurityProjectPolicyRequest } from '../security/project-policy.ts';
import {
  parseSecurityModelRequest,
  setProjectSecurityModel,
} from '../security/project-settings.ts';
import { securityProviderKeysView } from '../security/provider-keys.ts';
import {
  bypassPublicRequest,
  recheckPublicRequestBestEffort,
} from '../security/public-gate-flow.ts';
import { checkBypassable, parseBypassReason, publicRequestView } from '../security/public-gate.ts';
import { previewSecurityBackfill, queueSecurityBackfill } from '../security/sweeps.ts';
import { securityWebhookView, setSecurityWebhook } from '../security/webhook.ts';
import { ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { operatorProjectZeroTrustState } from '../zero-trust/state.ts';
import { dryRun, OperatorError, pagination, preview, readBody } from './common.ts';

export const securityOperatorRoutes = new Hono<ApiEnv>();

/** Map a refused security request to the operator error shape. */
export function securityOperatorError<T>(error: T): T | OperatorError {
  if (error instanceof SecurityApiError) {
    return new OperatorError(error.status, error.message, error.code, error.details);
  }
  if (error instanceof ZeroTrustUnavailableError) {
    // Today's reply for a Zero Trust change that cannot run now; nothing was recorded.
    return new OperatorError(409, error.message, 'zero trust not ready');
  }
  return error;
}

// Set before `operatorApi.route()` mounts these routes: the parent renders the OperatorError.
securityOperatorRoutes.onError((error) => {
  throw securityOperatorError(error);
});

const capability = capabilityMiddleware('securityAudits');

export async function requireProject(db: Db, projectId: string) {
  const project = await getProject(db, projectId);
  if (!project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }
  return project;
}

/** A finding write result, plus the open public request judged again after it. */
export async function withRecheckedPublicRequest<T extends object>(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  what: string,
  result: T,
) {
  const request = await recheckPublicRequestBestEffort(env, db, projectId, what);
  return { ...result, ...(request ? { publicRequest: await publicRequestView(db, request) } : {}) };
}

type RescanPreview = Awaited<ReturnType<typeof previewSecurityRescan>>;

/** What a rescan preview shows (operator and project routes). */
export function rescanPreviewView(result: RescanPreview) {
  return {
    deploymentId: result.target.deploymentId,
    alreadyScanned: result.alreadyScanned,
    tier: result.tier,
    clientAssets: result.clientAssets,
    model: result.model,
    thirdParty: result.thirdParty,
    worstCaseUsd: result.worstCaseUsd,
    budget: result.budget,
  };
}

/** What a queued rescan answers (operator and project routes). */
export function rescanQueuedView(scanId: string, result: RescanPreview) {
  const {
    thirdParty: _thirdParty,
    worstCaseUsd: _cost,
    budget: _budget,
    ...shown
  } = rescanPreviewView(result);
  return { ok: true as const, scanId, ...shown };
}

securityOperatorRoutes.get('/security/status', async (context) =>
  context.json(
    await securityStatus(context.get('db'), getPlatformCapabilities(context.env).securityAudits),
  ),
);

securityOperatorRoutes.get('/security/policy', async (context) =>
  context.json({
    ...securityPolicyView(
      await readStoredSecurityPolicy(context.get('db')),
      getPlatformCapabilities(context.env).securityAudits,
      Date.now(),
    ),
    providerKeys: await securityProviderKeysView(context.get('db')),
  }),
);

securityOperatorRoutes.post('/security/policy', capability, async (context) => {
  const body = await readBody(context);
  const db = context.get('db');
  const result = await changeSecurityPolicy(db, body, {
    userId: context.get('user').id,
    preview: dryRun(body),
    // Leaving `disabled` re-runs the probe (and provisions the scanner) first.
    probe: async () =>
      runSecurityProbe(context.env, db, (await readStoredSecurityPolicy(db)).policy),
  });
  // Canceled requests queued their emails in the policy transaction.
  if ('canceledRequests' in result && result.canceledRequests > 0) {
    await pokeSecurityScanScheduler(context.env);
  }
  return context.json(result);
});

/** `{url}` sets the webhook (a new signing secret, returned once); `{url: null}` removes it. */
securityOperatorRoutes.post('/security/webhook', capability, async (context) => {
  const body = await readBody(context);
  for (const key of Object.keys(body)) {
    if (key !== 'url' && key !== 'dryRun') {
      throw new OperatorError(400, `Unknown webhook field: ${key}.`, 'invalid_argument');
    }
  }
  if (body.url !== null && typeof body.url !== 'string') {
    throw new OperatorError(
      400,
      'url must be an https URL, or null to turn the webhook off.',
      'invalid_argument',
    );
  }
  let url: string | null = null;
  if (body.url !== null) {
    try {
      url = parseSecurityWebhookUrl(body.url);
    } catch (error) {
      throw new OperatorError(
        400,
        error instanceof Error ? error.message : 'Invalid webhook URL.',
        'invalid_argument',
      );
    }
  }
  const db = context.get('db');
  const current = await securityWebhookView(db);
  if (dryRun(body)) {
    const lines =
      url === null
        ? [
            current
              ? `Turn off: the security webhook to ${current.url}.`
              : 'The security webhook is already off.',
          ]
        : [
            `${current ? 'Change' : 'Turn on'}: send security events to ${url}.`,
            '  Each event is a signed JSON body with ids and counts only (no titles, files or code).',
            current
              ? '  A new signing secret is made; the old one stops working at once. It is shown once.'
              : '  A signing secret is made and shown once. Keep it to check the X-Void-Signature header.',
          ];
    return context.json(
      preview('security.webhook', 'platform', { webhook: current, preview: lines }),
    );
  }
  const result = await setSecurityWebhook(context.env, db, {
    url,
    userId: context.get('user').id,
    now: Date.now(),
  });
  return context.json({ ok: true as const, ...result });
});

/** `{host, key}` saves a provider key after a 1-token test call; `{host, key: null}` removes it. */
securityOperatorRoutes.post('/security/provider-keys', capability, async (context) => {
  const body = await readBody(context);
  const request = parseSecurityProviderKeyRequest(body);
  const db = context.get('db');
  if (dryRun(body)) {
    return context.json(await previewSecurityProviderKey(db, request));
  }
  return context.json(
    await changeSecurityProviderKey(context.env, db, request, {
      userId: context.get('user').id,
      now: Date.now(),
    }),
  );
});

// With the capability off the probe reports check 1, makes no call and stores nothing.
securityOperatorRoutes.post('/security/probe', async (context) =>
  context.json(await probeAndRecord(context.env, context.get('db'))),
);

securityOperatorRoutes.get('/security/budget', async (context) =>
  context.json(await securityBudgetStatus(context.get('db'))),
);

securityOperatorRoutes.post('/security/budget', capability, async (context) => {
  const body = await readBody(context);
  return context.json(
    await changeSecurityBudgets(context.get('db'), body, { preview: dryRun(body) }),
  );
});

// Reads stay open with the capability off, so old findings and records can still be seen.
securityOperatorRoutes.get('/security/findings', async (context) =>
  context.json(
    await listOperatorSecurityFindings(
      context.get('db'),
      parseOperatorFindingFilter((name) => context.req.query(name)),
      pagination(context),
    ),
  ),
);

securityOperatorRoutes.get('/security/scans', async (context) =>
  context.json(
    await listOperatorSecurityScans(
      context.get('db'),
      parseOperatorScanFilter((name) => context.req.query(name)),
      pagination(context),
    ),
  ),
);

securityOperatorRoutes.get('/security/public-requests', async (context) =>
  context.json(
    await listOperatorPublicRequests(
      context.get('db'),
      parseOperatorRequestFilter((name) => context.req.query(name)),
      pagination(context),
    ),
  ),
);

securityOperatorRoutes.get('/security/bypasses', async (context) =>
  context.json(
    await listOperatorBypasses(
      context.get('db'),
      { project: context.req.query('project') },
      pagination(context),
    ),
  ),
);

/** One scan of each in-scope project whose live deployment was never scanned. */
securityOperatorRoutes.post('/security/backfill', capability, async (context) => {
  const body = await readBody(context);
  const db = context.get('db');
  if (dryRun(body)) {
    return context.json(
      preview('security.backfill', 'platform', await previewSecurityBackfill(db)),
    );
  }
  const result = await queueSecurityBackfill(context.env, db);
  if (result.queued.length > 0) {
    await pokeSecurityScanScheduler(context.env);
  }
  return context.json({ ok: true, ...result }, 202);
});

/** A scan that may be canceled, or the refusal (operator and admin routes). */
export async function requireCancelableScan(db: Db, scanId: string) {
  const scan = await readCancelableScan(db, scanId);
  if (!scan) {
    throw new OperatorError(404, 'Scan not found.', 'not_found');
  }
  if (!SECURITY_SCAN_CANCELABLE.includes(scan.status)) {
    throw new OperatorError(
      409,
      `Scan ${scan.id} is ${scan.status}; only a waiting or running scan can be canceled.`,
      'security_scan_not_cancelable',
      { status: scan.status },
    );
  }
  return scan;
}

/** Cancels through the scheduler, which ends the attempt at the controller too. */
export async function cancelScanThroughScheduler(env: ApiEnv['Bindings'], scanId: string) {
  try {
    const scheduler = env.SECURITY_SCAN_SCHEDULER;
    return await scheduler
      .get(scheduler.idFromName('global'))
      .cancelScans([scanId], 'operator_canceled');
  } catch (error) {
    console.error('[security-scan] operator cancel failed', error);
    throw new OperatorError(
      502,
      'The scan scheduler did not answer. Run the cancel again.',
      'security_scheduler_unavailable',
    );
  }
}

securityOperatorRoutes.post('/security/scans/:sid/cancel', capability, async (context) => {
  const body = await readBody(context);
  const scan = await requireCancelableScan(context.get('db'), context.req.param('sid'));
  if (dryRun(body)) {
    return context.json(
      preview('security.scan-cancel', scan.id, {
        project: scan.slug,
        projectId: scan.projectId,
        status: scan.status,
      }),
    );
  }
  const canceled = await cancelScanThroughScheduler(context.env, scan.id);
  return context.json({ ok: true, scanId: scan.id, project: scan.slug, canceled });
});

// Project writes for an installation admin. A preview runs the real write and rolls back.

securityOperatorRoutes.get('/projects/:id/security/findings/:fid', async (context) => {
  const projectId = context.req.param('id');
  await requireProject(context.get('db'), projectId);
  return context.json(
    await showSecurityFinding(context.get('db'), projectId, context.req.param('fid'), 'full'),
  );
});

async function findingWrite(context: Context<ApiEnv>) {
  const body = await readBody(context);
  const projectId = context.req.param('id') ?? '';
  const db = context.get('db');
  await requireProject(db, projectId);
  const input = {
    projectId,
    ref: context.req.param('fid') ?? '',
    userId: context.get('user').id,
    actor: 'installation_admin' as const,
  };
  return { body, projectId, db, input };
}

securityOperatorRoutes.post('/projects/:id/security/findings/:fid/comments', async (context) => {
  const { body, projectId, db, input: base } = await findingWrite(context);
  const input = { ...base, role: null, text: parseSecurityComment(body.text, 'text') };
  if (dryRun(body)) {
    const result = await previewInRollback(db, (tx) => commentOnSecurityFinding(tx, input));
    return context.json(preview('security.finding-comment', { projectId, finding: result.id }));
  }
  return context.json(await commentOnSecurityFinding(db, input), 201);
});

securityOperatorRoutes.post('/projects/:id/security/findings/:fid/resolve', async (context) => {
  const { body, projectId, db, input: base } = await findingWrite(context);
  const input = {
    ...base,
    resolution: parseSecurityResolution(body.reason),
    comment: parseSecurityComment(body.comment, 'comment'),
    expectedRevision: body.expectedRevision,
  };
  if (dryRun(body)) {
    const result = await previewInRollback(db, (tx) => resolveSecurityFinding(tx, input));
    return context.json(
      preview('security.finding-resolve', { projectId, finding: result.id }, { result }),
    );
  }
  const resolved = await resolveSecurityFinding(db, input);
  return context.json(
    await withRecheckedPublicRequest(context.env, db, projectId, 'a resolve', resolved),
  );
});

securityOperatorRoutes.post('/projects/:id/security/findings/:fid/reopen', async (context) => {
  const { body, projectId, db, input: base } = await findingWrite(context);
  const input = {
    ...base,
    comment: parseSecurityComment(body.comment, 'comment'),
    expectedRevision: body.expectedRevision,
  };
  if (dryRun(body)) {
    const result = await previewInRollback(db, (tx) => reopenSecurityFinding(tx, input));
    return context.json(
      preview('security.finding-reopen', { projectId, finding: result.id }, { result }),
    );
  }
  const reopened = await reopenSecurityFinding(db, input);
  // The alarm sends the "reopened" email when the finding was urgent.
  await pokeSecurityScanScheduler(context.env);
  return context.json(
    await withRecheckedPublicRequest(context.env, db, projectId, 'a reopen', reopened),
  );
});

/** Manual rescan (T3 full scan, never `no changes`). A preview is the cost check (edge #43). */
securityOperatorRoutes.post('/projects/:id/security/scans', capability, async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  if (body.clientAssets !== undefined && typeof body.clientAssets !== 'boolean') {
    throw new OperatorError(400, 'clientAssets must be true or false.', 'invalid_argument');
  }
  const options = { clientAssets: body.clientAssets === true };
  if (dryRun(body)) {
    const result = await previewSecurityRescan(context.env, db, projectId, options);
    return context.json(
      preview('security.rescan', projectId, {
        project: result.target.slug,
        ...rescanPreviewView(result),
      }),
    );
  }
  const { preview: queued, scanId } = await queueSecurityRescan(
    context.env,
    db,
    projectId,
    options,
  );
  await pokeSecurityScanScheduler(context.env);
  return context.json({ project: queued.target.slug, ...rescanQueuedView(scanId, queued) }, 202);
});

securityOperatorRoutes.post('/projects/:id/security/model', capability, async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  await requireProject(db, projectId);
  const input = {
    projectId,
    userId: context.get('user').id,
    request: parseSecurityModelRequest(body),
  };
  if (dryRun(body)) {
    const result = await previewInRollback(db, (tx) => setProjectSecurityModel(tx, input));
    return context.json(preview('security.project-model', projectId, { model: result.model }));
  }
  return context.json(await setProjectSecurityModel(db, input));
});

/** Sets the most a project admin may give the project (the per-project limit). */
securityOperatorRoutes.post('/projects/:id/security/budget', capability, async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  await requireProject(db, projectId);
  const input = {
    projectId,
    userId: context.get('user').id,
    cents: parseSecurityCeilingRequest(body),
  };
  if (dryRun(body)) {
    const result = await previewInRollback(db, (tx) => setProjectSecurityCeiling(tx, input));
    return context.json(preview('security.project-budget', projectId, { budget: result.budget }));
  }
  return context.json(await setProjectSecurityCeiling(db, input));
});

/** The project's own scan rule (M34): inherit, always or never. */
securityOperatorRoutes.post('/projects/:id/security/policy', capability, async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  await requireProject(db, projectId);
  const input = {
    projectId,
    userId: context.get('user').id,
    override: parseSecurityProjectPolicyRequest(body),
  };
  if (dryRun(body)) {
    const { ok: _ok, ...shown } = await previewInRollback(db, (tx) =>
      setProjectSecurityPolicyOverride(tx, input),
    );
    return context.json(preview('security.project-policy', projectId, shown));
  }
  return context.json(await setProjectSecurityPolicyOverride(db, input));
});

securityOperatorRoutes.post('/projects/:id/security/public-request/bypass', async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  const project = await requireProject(db, projectId);
  const reason = parseBypassReason(body.reason);
  if (dryRun(body)) {
    // The same refusal rules as the real bypass, including Zero Trust readiness.
    const { open } = await checkBypassable(db, context.env, {
      projectId,
      slug: project.slug,
      requestId: null,
    });
    return context.json(
      preview('security.public-request-bypass', projectId, {
        project: project.slug,
        publicRequest: await publicRequestView(db, open),
      }),
    );
  }
  const result = await bypassPublicRequest(context.env, db, {
    projectId,
    reason,
    actor: { kind: 'installation_admin', userId: context.get('user').id, role: null },
  });
  return context.json({
    ok: true,
    project: operatorProjectZeroTrustState(result.row),
    publicRequest: result.publicRequest ? await publicRequestView(db, result.publicRequest) : null,
    skipped: result.skipped,
  });
});
