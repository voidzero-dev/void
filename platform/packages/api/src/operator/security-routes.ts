import { parseSecurityWebhookUrl } from '@void/platform/security-policy';
import { Hono } from 'hono';
import { capabilityMiddleware, getPlatformCapabilities } from '../capabilities.ts';
import { getProject, type Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
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
import {
  parseSecurityModelRequest,
  setProjectSecurityModel,
} from '../security/project-settings.ts';
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
export function securityOperatorError(error: unknown): unknown {
  if (error instanceof SecurityApiError) {
    return new OperatorError(error.status, error.message, error.code, error.details);
  }
  if (error instanceof ZeroTrustUnavailableError) {
    // Today's reply for a Zero Trust change that cannot run now; nothing was recorded.
    return new OperatorError(409, error.message, 'zero trust not ready');
  }
  return error;
}

securityOperatorRoutes.get('/security/status', async (context) =>
  context.json(
    await securityStatus(context.get('db'), getPlatformCapabilities(context.env).securityAudits),
  ),
);

securityOperatorRoutes.get('/security/policy', async (context) =>
  context.json(
    securityPolicyView(
      await readStoredSecurityPolicy(context.get('db')),
      getPlatformCapabilities(context.env).securityAudits,
      Date.now(),
    ),
  ),
);

securityOperatorRoutes.post(
  '/security/policy',
  capabilityMiddleware('securityAudits'),
  async (context) => {
    const body = await readBody(context);
    try {
      const result = await changeSecurityPolicy(context.get('db'), body, {
        userId: context.get('user').id,
        preview: dryRun(body),
        // Leaving `disabled` re-runs the probe (and provisions the scanner) first.
        probe: async () =>
          runSecurityProbe(context.env, (await readStoredSecurityPolicy(context.get('db'))).policy),
      });
      // Canceled requests queued their emails in the policy transaction.
      if ('canceledRequests' in result && result.canceledRequests > 0) {
        await pokeSecurityScanScheduler(context.env);
      }
      return context.json(result);
    } catch (error) {
      throw securityOperatorError(error);
    }
  },
);

/**
 * The security webhook (M26): `{url}` sets it (a new signing secret, returned once),
 * `{url: null}` removes it. A preview says what changes; the secret never shows again.
 */
securityOperatorRoutes.post(
  '/security/webhook',
  capabilityMiddleware('securityAudits'),
  async (context) => {
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
  },
);

/**
 * The entitlement probe (spec §5.2). With the capability off it reports check 1 and
 * makes no Cloudflare or model call and stores nothing.
 */
securityOperatorRoutes.post('/security/probe', async (context) =>
  context.json(await probeAndRecord(context.env, context.get('db'))),
);

// ---------------------------------------------------------------------------
// Installation budget, lists, cancel (spec §13.5 operator row, design doc 0095 M17)
// ---------------------------------------------------------------------------

securityOperatorRoutes.get('/security/budget', async (context) =>
  context.json(await securityBudgetStatus(context.get('db'))),
);

securityOperatorRoutes.post(
  '/security/budget',
  capabilityMiddleware('securityAudits'),
  async (context) => {
    const body = await readBody(context);
    try {
      return context.json(
        await changeSecurityBudgets(context.get('db'), body, { preview: dryRun(body) }),
      );
    } catch (error) {
      throw securityOperatorError(error);
    }
  },
);

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

/**
 * Backfill (M25): one scan of each in-scope project whose live deployment was never
 * scanned, queued as `trigger=backfill`. A preview is the cost check.
 */
securityOperatorRoutes.post(
  '/security/backfill',
  capabilityMiddleware('securityAudits'),
  async (context) => {
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
  },
);

securityOperatorRoutes.post(
  '/security/scans/:sid/cancel',
  capabilityMiddleware('securityAudits'),
  async (context) => {
    const body = await readBody(context);
    const scanId = context.req.param('sid');
    const scan = await readCancelableScan(context.get('db'), scanId);
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
    if (dryRun(body)) {
      return context.json(
        preview('security.scan-cancel', scan.id, {
          project: scan.slug,
          projectId: scan.projectId,
          status: scan.status,
        }),
      );
    }
    let canceled: number;
    try {
      const scheduler = context.env.SECURITY_SCAN_SCHEDULER;
      canceled = await scheduler
        .get(scheduler.idFromName('global'))
        .cancelScans([scan.id], 'operator_canceled');
    } catch (error) {
      console.error('[security-scan] operator cancel failed', error);
      throw new OperatorError(
        502,
        'The scan scheduler did not answer. Run the cancel again.',
        'security_scheduler_unavailable',
      );
    }
    return context.json({ ok: true, scanId: scan.id, project: scan.slug, canceled });
  },
);

// ---------------------------------------------------------------------------
// Project writes for an installation admin
// ---------------------------------------------------------------------------

async function requireProject(db: Db, projectId: string) {
  const project = await getProject(db, projectId);
  if (!project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }
  return project;
}

securityOperatorRoutes.get('/projects/:id/security/findings/:fid', async (context) => {
  const projectId = context.req.param('id');
  await requireProject(context.get('db'), projectId);
  try {
    return context.json(
      await showSecurityFinding(context.get('db'), projectId, context.req.param('fid'), 'full'),
    );
  } catch (error) {
    throw securityOperatorError(error);
  }
});

securityOperatorRoutes.post('/projects/:id/security/findings/:fid/comments', async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  await requireProject(db, projectId);
  try {
    const input = {
      projectId,
      ref: context.req.param('fid'),
      userId: context.get('user').id,
      role: null,
      actor: 'installation_admin' as const,
      text: parseSecurityComment(body.text, 'text'),
    };
    if (dryRun(body)) {
      const result = await previewInRollback(db, (tx) => commentOnSecurityFinding(tx, input));
      return context.json(preview('security.finding-comment', { projectId, finding: result.id }));
    }
    return context.json(await commentOnSecurityFinding(db, input), 201);
  } catch (error) {
    throw securityOperatorError(error);
  }
});

securityOperatorRoutes.post('/projects/:id/security/findings/:fid/resolve', async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  await requireProject(db, projectId);
  try {
    const input = {
      projectId,
      ref: context.req.param('fid'),
      userId: context.get('user').id,
      actor: 'installation_admin' as const,
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
    // An open public request is judged again: the last urgent finding may be gone.
    const request = await recheckPublicRequestBestEffort(context.env, db, projectId, 'a resolve');
    return context.json({
      ...resolved,
      ...(request ? { publicRequest: await publicRequestView(db, request) } : {}),
    });
  } catch (error) {
    throw securityOperatorError(error);
  }
});

securityOperatorRoutes.post('/projects/:id/security/findings/:fid/reopen', async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  await requireProject(db, projectId);
  try {
    const input = {
      projectId,
      ref: context.req.param('fid'),
      userId: context.get('user').id,
      actor: 'installation_admin' as const,
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
    const request = await recheckPublicRequestBestEffort(context.env, db, projectId, 'a reopen');
    return context.json({
      ...reopened,
      ...(request ? { publicRequest: await publicRequestView(db, request) } : {}),
    });
  } catch (error) {
    throw securityOperatorError(error);
  }
});

/** `clientAssets` of a rescan request (M31): absent is off. */
function rescanClientAssets(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new OperatorError(400, 'clientAssets must be true or false.', 'invalid_argument');
  }
  return value === true;
}

/** Manual rescan (T3 full scan, never `no changes`). A preview is the cost check (edge #43). */
securityOperatorRoutes.post(
  '/projects/:id/security/scans',
  capabilityMiddleware('securityAudits'),
  async (context) => {
    const body = await readBody(context);
    const projectId = context.req.param('id');
    const db = context.get('db');
    const options = { clientAssets: rescanClientAssets(body.clientAssets) };
    if (dryRun(body)) {
      const result = await previewSecurityRescan(context.env, db, projectId, options);
      return context.json(
        preview('security.rescan', projectId, {
          deploymentId: result.target.deploymentId,
          project: result.target.slug,
          alreadyScanned: result.alreadyScanned,
          tier: result.tier,
          clientAssets: result.clientAssets,
          model: result.model,
          thirdParty: result.thirdParty,
          worstCaseUsd: result.worstCaseUsd,
          budget: result.budget,
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
    return context.json(
      {
        ok: true,
        scanId,
        project: queued.target.slug,
        deploymentId: queued.target.deploymentId,
        tier: queued.tier,
        clientAssets: queued.clientAssets,
        model: queued.model,
        alreadyScanned: queued.alreadyScanned,
      },
      202,
    );
  },
);

securityOperatorRoutes.post(
  '/projects/:id/security/model',
  capabilityMiddleware('securityAudits'),
  async (context) => {
    const body = await readBody(context);
    const projectId = context.req.param('id');
    const db = context.get('db');
    await requireProject(db, projectId);
    try {
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
    } catch (error) {
      throw securityOperatorError(error);
    }
  },
);

/** Sets the most a project admin may give the project (the per-project limit). */
securityOperatorRoutes.post(
  '/projects/:id/security/budget',
  capabilityMiddleware('securityAudits'),
  async (context) => {
    const body = await readBody(context);
    const projectId = context.req.param('id');
    const db = context.get('db');
    await requireProject(db, projectId);
    try {
      const input = {
        projectId,
        userId: context.get('user').id,
        cents: parseSecurityCeilingRequest(body),
      };
      if (dryRun(body)) {
        const result = await previewInRollback(db, (tx) => setProjectSecurityCeiling(tx, input));
        return context.json(
          preview('security.project-budget', projectId, { budget: result.budget }),
        );
      }
      return context.json(await setProjectSecurityCeiling(db, input));
    } catch (error) {
      throw securityOperatorError(error);
    }
  },
);

securityOperatorRoutes.post('/projects/:id/security/public-request/bypass', async (context) => {
  const body = await readBody(context);
  const projectId = context.req.param('id');
  const db = context.get('db');
  const project = await requireProject(db, projectId);
  try {
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
      publicRequest: result.publicRequest
        ? await publicRequestView(db, result.publicRequest)
        : null,
      skipped: result.skipped,
    });
  } catch (error) {
    throw securityOperatorError(error);
  }
});
