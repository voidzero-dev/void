import { Hono } from 'hono';
import type { Context } from 'hono';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import {
  hasProjectCapability,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
} from '../project-access.ts';
import { pokeSecurityScanScheduler } from '../security/enqueue.ts';
import { SecurityApiError } from '../security/errors.ts';
import {
  createSecurityLocalCheck,
  parseSecurityLocalCheckRequest,
  previewSecurityLocalCheck,
  readSecurityLocalCheck,
  startSecurityLocalCheck,
} from '../security/local-check.ts';
import { previewSecurityRescan, queueSecurityRescan } from '../security/operator.ts';
import { mintSecurityPageToken } from '../security/page-token.ts';
import {
  commentOnSecurityFinding,
  editSecurityFindingSeverity,
  listSecurityFindings,
  parseSecurityComment,
  parseSecurityResolution,
  parseSecuritySeverityEdit,
  reopenSecurityFinding,
  resolveSecurityFinding,
  showSecurityFinding,
} from '../security/project-findings.ts';
import type { SecurityFindingFilter } from '../security/project-findings.ts';
import {
  parseSecurityBudgetRequest,
  parseSecurityModelRequest,
  readSecurityProjectModelChoices,
  setProjectSecurityBudget,
  setProjectSecurityModel,
} from '../security/project-settings.ts';
import {
  decodeSecurityCursor,
  listSecurityScans,
  parseSecurityPageLimit,
  projectSecurityStatus,
  securityDetailLevel,
} from '../security/project-view.ts';
import type { SecurityViewer } from '../security/project-view.ts';
import { recheckPublicRequestBestEffort } from '../security/public-gate-flow.ts';
import { openPublicRequestView, publicRequestView } from '../security/public-gate.ts';
import { SECURITY_SEVERITIES } from '../security/schema.ts';
import type { SecuritySeverity } from '../security/schema.ts';
import { requireProjectRouteCapability } from './project-access.ts';

function capabilityOn(context: Context<ApiEnv>): boolean {
  try {
    return getPlatformCapabilities(context.env).securityAudits;
  } catch {
    return false;
  }
}

/** Write and scan routes answer the standard 501 while the capability is off (spec §13.5). */
function capabilityOff(context: Context<ApiEnv>): Response {
  return context.json(
    {
      error: 'platform capability unavailable',
      capability: 'securityAudits',
      message: 'This Void platform does not enable securityAudits.',
    },
    501,
  );
}

function failure(context: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
    return context.json(projectAccessErrorBody(error), error.status);
  }
  if (error instanceof SecurityApiError) {
    return context.json(
      { error: error.code, message: error.message, ...error.details },
      error.status,
    );
  }
  // The rescan checks are shared with the operator route and throw its error type.
  if (error instanceof OperatorError) {
    return context.json(
      { error: error.code, message: error.message, ...error.details },
      error.status,
    );
  }
  throw error;
}

// oxlint-disable-next-line quality/no-unknown-returns -- Each route validates the JSON fields it reads.
async function readJson(context: Context<ApiEnv>): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw SecurityApiError.invalid('A JSON body is required.');
  }
}

// oxlint-disable-next-line quality/no-unknown-returns -- Each caller validates the field it reads.
function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function viewer(context: Context<ApiEnv>, role: SecurityViewer['role']): SecurityViewer {
  // A deploy token (CI, a remote build, GitHub Actions OIDC) sets `deployScope`.
  return { role, credential: context.get('deployScope') !== undefined };
}

function parseFilter(context: Context<ApiEnv>): SecurityFindingFilter {
  const state = context.req.query('state') ?? 'open';
  if (state !== 'open' && state !== 'resolved' && state !== 'all') {
    throw SecurityApiError.invalid('state must be open, resolved or all.');
  }
  const severity = context.req.query('severity') ?? null;
  if (severity !== null && !SECURITY_SEVERITIES.some((value) => value === severity)) {
    throw SecurityApiError.invalid(`severity must be one of: ${SECURITY_SEVERITIES.join(', ')}.`);
  }
  const urgent = context.req.query('urgent');
  return {
    state,
    urgent: urgent === '1' || urgent === 'true',
    severity: severity as SecuritySeverity | null,
  };
}

const app = new Hono<ApiEnv>()
  .get('/:id/security', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    const status = await projectSecurityStatus({
      db: context.get('db'),
      project: access.project,
      viewer: viewer(context, access.role),
      capability: capabilityOn(context),
    });
    return context.json({
      ...status,
      publicRequest: await openPublicRequestView(context.get('db'), projectId),
      // The caller may resolve findings (`settings`, a user session): the deploy notice
      // then names the resolve command (spec §11.1).
      canResolve:
        context.get('deployScope') === undefined && hasProjectCapability(access.role, 'settings'),
      // What the model picker lists (page, dashboard); the PUT checks the same rules.
      modelChoices: await readSecurityProjectModelChoices(context.get('db'), projectId),
    });
  })
  .get('/:id/security/findings', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    try {
      const limit = parseSecurityPageLimit(context.req.query('limit'));
      if (limit === null) {
        throw SecurityApiError.invalid('limit must be a whole number from 1 to 100.');
      }
      const cursor = context.req.query('cursor');
      if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) {
        throw SecurityApiError.invalid('cursor is not valid. Start again without a cursor.');
      }
      return context.json(
        await listSecurityFindings(
          context.get('db'),
          projectId,
          securityDetailLevel(viewer(context, access.role)),
          parseFilter(context),
          { limit, afterNumber: cursor === undefined ? null : Number(cursor) },
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .get('/:id/security/findings/:fid', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    try {
      return context.json(
        await showSecurityFinding(
          context.get('db'),
          projectId,
          context.req.param('fid'),
          securityDetailLevel(viewer(context, access.role)),
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .post('/:id/security/findings/:fid/comments', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'configure');
    if (access instanceof Response) {
      return access;
    }
    try {
      const text = parseSecurityComment(field(await readJson(context), 'text'), 'text');
      return context.json(
        await commentOnSecurityFinding(context.get('db'), {
          projectId,
          ref: context.req.param('fid'),
          userId: context.get('user').id,
          role: access.role,
          text,
        }),
        201,
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .post('/:id/security/findings/:fid/resolve', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    try {
      const body = await readJson(context);
      const resolution = parseSecurityResolution(field(body, 'reason'));
      const comment = parseSecurityComment(field(body, 'comment'), 'comment');
      const resolved = await resolveSecurityFinding(context.get('db'), {
        projectId,
        ref: context.req.param('fid'),
        userId: context.get('user').id,
        resolution,
        comment,
        expectedRevision: field(body, 'expectedRevision'),
      });
      // An open public request is judged again: the last urgent finding may be gone.
      const request = await recheckPublicRequestBestEffort(
        context.env,
        context.get('db'),
        projectId,
        'a resolve',
      );
      return context.json({
        ...resolved,
        ...(request ? { publicRequest: await publicRequestView(context.get('db'), request) } : {}),
      });
    } catch (error) {
      return failure(context, error);
    }
  })
  .post('/:id/security/findings/:fid/reopen', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    try {
      const body = await readJson(context);
      const comment = parseSecurityComment(field(body, 'comment'), 'comment');
      const reopened = await reopenSecurityFinding(context.get('db'), {
        projectId,
        ref: context.req.param('fid'),
        userId: context.get('user').id,
        comment,
        expectedRevision: field(body, 'expectedRevision'),
      });
      // The alarm sends the "reopened" email when the finding was urgent.
      await pokeSecurityScanScheduler(context.env);
      const request = await recheckPublicRequestBestEffort(
        context.env,
        context.get('db'),
        projectId,
        'a reopen',
      );
      return context.json({
        ...reopened,
        ...(request ? { publicRequest: await publicRequestView(context.get('db'), request) } : {}),
      });
    } catch (error) {
      return failure(context, error);
    }
  })
  /**
   * Severity edit (M35): a person sets the severity of an open finding (`null`: back to
   * the scan value). Open while the capability is off, like resolve.
   */
  .post('/:id/security/findings/:fid/severity', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    try {
      const body = await readJson(context);
      const severity = parseSecuritySeverityEdit(field(body, 'severity'));
      const comment = parseSecurityComment(field(body, 'comment'), 'comment');
      const edited = await editSecurityFindingSeverity(context.get('db'), {
        projectId,
        ref: context.req.param('fid'),
        userId: context.get('user').id,
        severity,
        comment,
        expectedRevision: field(body, 'expectedRevision'),
      });
      // Lowering the last urgent finding frees a held public request, as a resolve does.
      const request = edited.changed
        ? await recheckPublicRequestBestEffort(
            context.env,
            context.get('db'),
            projectId,
            'a severity edit',
          )
        : null;
      return context.json({
        ...edited,
        ...(request ? { publicRequest: await publicRequestView(context.get('db'), request) } : {}),
      });
    } catch (error) {
      return failure(context, error);
    }
  })
  .get('/:id/security/scans', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      const limit = parseSecurityPageLimit(context.req.query('limit'));
      if (limit === null) {
        throw SecurityApiError.invalid('limit must be a whole number from 1 to 100.');
      }
      const raw = context.req.query('cursor');
      const cursor = raw === undefined ? null : decodeSecurityCursor(raw);
      if (raw !== undefined && cursor === null) {
        throw SecurityApiError.invalid('cursor is not valid. Start again without a cursor.');
      }
      return context.json(
        await listSecurityScans(
          context.get('db'),
          projectId,
          securityDetailLevel(viewer(context, access.role)),
          { limit, cursor },
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  /**
   * Project rescan (M25): the operator rescan rule (a full scan of the live deployment,
   * never `no changes`), for project admins. `dryRun` is the cost confirm.
   */
  .post('/:id/security/scans', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      const body = await readJson(context);
      const dryRun = field(body, 'dryRun');
      if (dryRun !== undefined && typeof dryRun !== 'boolean') {
        throw SecurityApiError.invalid('dryRun must be true or false.');
      }
      // M31: the client asset pass (sources of client bundles from their source maps).
      const clientAssets = field(body, 'clientAssets');
      if (clientAssets !== undefined && typeof clientAssets !== 'boolean') {
        throw SecurityApiError.invalid('clientAssets must be true or false.');
      }
      const options = { by: 'project' as const, clientAssets: clientAssets === true };
      const db = context.get('db');
      if (dryRun === true) {
        const preview = await previewSecurityRescan(context.env, db, projectId, options);
        return context.json({
          dryRun: true,
          deploymentId: preview.target.deploymentId,
          alreadyScanned: preview.alreadyScanned,
          tier: preview.tier,
          clientAssets: preview.clientAssets,
          model: preview.model,
          thirdParty: preview.thirdParty,
          worstCaseUsd: preview.worstCaseUsd,
          budget: preview.budget,
        });
      }
      const { preview, scanId } = await queueSecurityRescan(context.env, db, projectId, options);
      await pokeSecurityScanScheduler(context.env);
      return context.json(
        {
          ok: true,
          scanId,
          deploymentId: preview.target.deploymentId,
          tier: preview.tier,
          clientAssets: preview.clientAssets,
          model: preview.model,
          alreadyScanned: preview.alreadyScanned,
        },
        202,
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  /**
   * Local check (M32): a scan of the caller's working tree, uploaded by the CLI. `dryRun`
   * says what it would run (model, provider notice, cost) before any code is sent.
   */
  .post('/:id/security/checks', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      const request = parseSecurityLocalCheckRequest(await readJson(context));
      const project = { id: projectId, slug: access.project.slug };
      const db = context.get('db');
      if (request.dryRun) {
        return context.json({ dryRun: true, ...(await previewSecurityLocalCheck(db, project)) });
      }
      return context.json(
        { ok: true, ...(await createSecurityLocalCheck(context.env, db, project, request)) },
        201,
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .post('/:id/security/checks/:checkId/start', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      return context.json(
        await startSecurityLocalCheck(
          context.env,
          context.get('db'),
          projectId,
          context.req.param('checkId'),
        ),
        202,
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .get('/:id/security/checks/:checkId', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'deploy');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      return context.json(
        await readSecurityLocalCheck(
          context.env,
          context.get('db'),
          projectId,
          context.req.param('checkId'),
        ),
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .put('/:id/security/model', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      return context.json(
        await setProjectSecurityModel(context.get('db'), {
          projectId,
          userId: context.get('user').id,
          request: parseSecurityModelRequest(await readJson(context)),
        }),
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .put('/:id/security/budget', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    if (!capabilityOn(context)) {
      return capabilityOff(context);
    }
    try {
      return context.json(
        await setProjectSecurityBudget(context.get('db'), {
          projectId,
          slug: access.project.slug,
          userId: context.get('user').id,
          role: access.role,
          cents: parseSecurityBudgetRequest(await readJson(context)),
        }),
      );
    } catch (error) {
      return failure(context, error);
    }
  })
  .post('/:id/security/page-link', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    const { token, expiresAt } = await mintSecurityPageToken(
      { userId: context.get('user').id, projectId },
      context.env.JWT_SECRET,
    );
    const origin = new URL(context.req.url).origin;
    return context.json({
      url: `${origin}/security/projects/${encodeURIComponent(access.project.slug)}?t=${encodeURIComponent(token)}`,
      expiresAt,
    });
  });

export default app;
