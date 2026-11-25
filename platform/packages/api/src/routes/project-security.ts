import { Hono } from 'hono';
import type { Context } from 'hono';
import { capabilityUnavailable, securityAuditsEnabled } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import {
  rescanPreviewView,
  rescanQueuedView,
  withRecheckedPublicRequest,
} from '../operator/security-routes.ts';
import {
  hasProjectCapability,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
} from '../project-access.ts';
import type { ProjectAccess } from '../project-access.ts';
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
import { openPublicRequestView } from '../security/public-gate.ts';
import { SECURITY_SEVERITIES } from '../security/schema.ts';
import type { SecuritySeverity } from '../security/schema.ts';
import type { ProjectCapability } from '../types.ts';
import { requireProjectRouteCapability } from './project-access.ts';

type RouteContext = Context<ApiEnv>;

function failure(context: RouteContext, error: unknown): Response {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
    return context.json(projectAccessErrorBody(error), error.status);
  }
  // The rescan checks are shared with the operator route and throw its error type.
  if (error instanceof SecurityApiError || error instanceof OperatorError) {
    return context.json(
      { error: error.code, message: error.message, ...error.details },
      error.status,
    );
  }
  throw error;
}

/**
 * One project route: the access check first (a private project 404s / 403s before
 * anything else), then the 501 when the route needs the capability (spec §13.5), then
 * `run`, whose refusals answer with their own status and code.
 */
function route(
  capability: ProjectCapability,
  run: (context: RouteContext, access: ProjectAccess, projectId: string) => Promise<Response>,
  needsAudits = false,
) {
  return async (context: RouteContext) => {
    const projectId = context.req.param('id') ?? '';
    const access = await requireProjectRouteCapability(context, projectId, capability);
    if (access instanceof Response) {
      return access;
    }
    if (needsAudits && !securityAuditsEnabled(context.env)) {
      return capabilityUnavailable(context, 'securityAudits');
    }
    try {
      return await run(context, access, projectId);
    } catch (error) {
      return failure(context, error);
    }
  };
}

// oxlint-disable-next-line quality/no-unknown-returns -- Each route validates the JSON fields it reads.
async function readJson(context: RouteContext): Promise<unknown> {
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

function detail(context: RouteContext, access: ProjectAccess) {
  // A deploy token (CI, a remote build, GitHub Actions OIDC) sets `deployScope`.
  return securityDetailLevel({
    role: access.role,
    credential: context.get('deployScope') !== undefined,
  });
}

function pageLimit(context: RouteContext): number {
  const limit = parseSecurityPageLimit(context.req.query('limit'));
  if (limit === null) {
    throw SecurityApiError.invalid('limit must be a whole number from 1 to 100.');
  }
  return limit;
}

const BAD_CURSOR = 'cursor is not valid. Start again without a cursor.';

function findingFilter(context: RouteContext): SecurityFindingFilter {
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

/** The fields a finding write takes from the route. */
function findingRef(context: RouteContext, projectId: string) {
  return { projectId, ref: context.req.param('fid') ?? '', userId: context.get('user').id };
}

function booleanField(body: unknown, name: string): boolean | undefined {
  const value = field(body, name);
  if (value === undefined || typeof value === 'boolean') {
    return value;
  }
  throw SecurityApiError.invalid(`${name} must be true or false.`);
}

const app = new Hono<ApiEnv>()
  .get(
    '/:id/security',
    route('read', async (context, access, projectId) => {
      const db = context.get('db');
      const status = await projectSecurityStatus({
        db,
        project: access.project,
        viewer: { role: access.role, credential: context.get('deployScope') !== undefined },
        capability: securityAuditsEnabled(context.env),
      });
      return context.json({
        ...status,
        publicRequest: await openPublicRequestView(db, projectId),
        // The caller may resolve findings (`settings`, a user session): the deploy notice
        // then names the resolve command (spec §11.1).
        canResolve:
          context.get('deployScope') === undefined && hasProjectCapability(access.role, 'settings'),
        // What the model picker lists (page, dashboard); the PUT checks the same rules.
        modelChoices: await readSecurityProjectModelChoices(db, projectId),
      });
    }),
  )
  .get(
    '/:id/security/findings',
    route('read', async (context, access, projectId) => {
      const limit = pageLimit(context);
      const cursor = context.req.query('cursor');
      if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) {
        throw SecurityApiError.invalid(BAD_CURSOR);
      }
      return context.json(
        await listSecurityFindings(
          context.get('db'),
          projectId,
          detail(context, access),
          findingFilter(context),
          { limit, afterNumber: cursor === undefined ? null : Number(cursor) },
        ),
      );
    }),
  )
  .get(
    '/:id/security/findings/:fid',
    route('read', async (context, access, projectId) =>
      context.json(
        await showSecurityFinding(
          context.get('db'),
          projectId,
          context.req.param('fid') ?? '',
          detail(context, access),
        ),
      ),
    ),
  )
  .post(
    '/:id/security/findings/:fid/comments',
    route('configure', async (context, access, projectId) => {
      const text = parseSecurityComment(field(await readJson(context), 'text'), 'text');
      return context.json(
        await commentOnSecurityFinding(context.get('db'), {
          ...findingRef(context, projectId),
          role: access.role,
          text,
        }),
        201,
      );
    }),
  )
  .post(
    '/:id/security/findings/:fid/resolve',
    route('settings', async (context, _access, projectId) => {
      const body = await readJson(context);
      const resolution = parseSecurityResolution(field(body, 'reason'));
      const comment = parseSecurityComment(field(body, 'comment'), 'comment');
      const db = context.get('db');
      const resolved = await resolveSecurityFinding(db, {
        ...findingRef(context, projectId),
        resolution,
        comment,
        expectedRevision: field(body, 'expectedRevision'),
      });
      return context.json(
        await withRecheckedPublicRequest(context.env, db, projectId, 'a resolve', resolved),
      );
    }),
  )
  .post(
    '/:id/security/findings/:fid/reopen',
    route('settings', async (context, _access, projectId) => {
      const body = await readJson(context);
      const comment = parseSecurityComment(field(body, 'comment'), 'comment');
      const db = context.get('db');
      const reopened = await reopenSecurityFinding(db, {
        ...findingRef(context, projectId),
        comment,
        expectedRevision: field(body, 'expectedRevision'),
      });
      // The alarm sends the "reopened" email when the finding was urgent.
      await pokeSecurityScanScheduler(context.env);
      return context.json(
        await withRecheckedPublicRequest(context.env, db, projectId, 'a reopen', reopened),
      );
    }),
  )
  // Severity edit (M35); `null` goes back to the scan value. Open while the capability is off.
  .post(
    '/:id/security/findings/:fid/severity',
    route('settings', async (context, _access, projectId) => {
      const body = await readJson(context);
      const severity = parseSecuritySeverityEdit(field(body, 'severity'));
      const comment = parseSecurityComment(field(body, 'comment'), 'comment');
      const db = context.get('db');
      const edited = await editSecurityFindingSeverity(db, {
        ...findingRef(context, projectId),
        severity,
        comment,
        expectedRevision: field(body, 'expectedRevision'),
      });
      // Lowering the last urgent finding frees a held public request, as a resolve does.
      return context.json(
        edited.changed
          ? await withRecheckedPublicRequest(context.env, db, projectId, 'a severity edit', edited)
          : edited,
      );
    }),
  )
  .get(
    '/:id/security/scans',
    route(
      'deploy',
      async (context, access, projectId) => {
        const limit = pageLimit(context);
        const raw = context.req.query('cursor');
        const cursor = raw === undefined ? null : decodeSecurityCursor(raw);
        if (raw !== undefined && cursor === null) {
          throw SecurityApiError.invalid(BAD_CURSOR);
        }
        return context.json(
          await listSecurityScans(context.get('db'), projectId, detail(context, access), {
            limit,
            cursor,
          }),
        );
      },
      true,
    ),
  )
  // Project rescan (M25): the operator rescan rule, for project admins. `dryRun` is the cost confirm.
  .post(
    '/:id/security/scans',
    route(
      'settings',
      async (context, _access, projectId) => {
        const body = await readJson(context);
        const dryRun = booleanField(body, 'dryRun');
        const clientAssets = booleanField(body, 'clientAssets');
        const options = { by: 'project' as const, clientAssets: clientAssets === true };
        const db = context.get('db');
        if (dryRun === true) {
          const preview = await previewSecurityRescan(context.env, db, projectId, options);
          return context.json({ dryRun: true, ...rescanPreviewView(preview) });
        }
        const { preview, scanId } = await queueSecurityRescan(context.env, db, projectId, options);
        await pokeSecurityScanScheduler(context.env);
        return context.json(rescanQueuedView(scanId, preview), 202);
      },
      true,
    ),
  )
  // Local check (M32): a scan of the caller's working tree. `dryRun` says what it would run.
  .post(
    '/:id/security/checks',
    route(
      'deploy',
      async (context, access, projectId) => {
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
      },
      true,
    ),
  )
  .post(
    '/:id/security/checks/:checkId/start',
    route(
      'deploy',
      async (context, _access, projectId) =>
        context.json(
          await startSecurityLocalCheck(
            context.env,
            context.get('db'),
            projectId,
            context.req.param('checkId') ?? '',
          ),
          202,
        ),
      true,
    ),
  )
  .get(
    '/:id/security/checks/:checkId',
    route(
      'deploy',
      async (context, _access, projectId) =>
        context.json(
          await readSecurityLocalCheck(
            context.env,
            context.get('db'),
            projectId,
            context.req.param('checkId') ?? '',
          ),
        ),
      true,
    ),
  )
  .put(
    '/:id/security/model',
    route(
      'settings',
      async (context, _access, projectId) =>
        context.json(
          await setProjectSecurityModel(context.get('db'), {
            projectId,
            userId: context.get('user').id,
            request: parseSecurityModelRequest(await readJson(context)),
          }),
        ),
      true,
    ),
  )
  .put(
    '/:id/security/budget',
    route(
      'settings',
      async (context, access, projectId) =>
        context.json(
          await setProjectSecurityBudget(context.get('db'), {
            projectId,
            slug: access.project.slug,
            userId: context.get('user').id,
            role: access.role,
            cents: parseSecurityBudgetRequest(await readJson(context)),
          }),
        ),
      true,
    ),
  )
  .post(
    '/:id/security/page-link',
    route('read', async (context, access, projectId) => {
      const { token, expiresAt } = await mintSecurityPageToken(
        { userId: context.get('user').id, projectId },
        context.env.JWT_SECRET,
      );
      const origin = new URL(context.req.url).origin;
      return context.json({
        url: `${origin}/security/projects/${encodeURIComponent(access.project.slug)}?t=${encodeURIComponent(token)}`,
        expiresAt,
      });
    }),
  );

export default app;
