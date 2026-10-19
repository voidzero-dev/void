import { and, eq, gt, isNull } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { verifyJwt } from '../auth/jwt.ts';
import { activeOAuthApproval, OAuthError } from '../auth/oauth.ts';
import { validateHumanSession } from '../auth/sessions.ts';
import { ACTIVE_BUILD_STATUSES, getBuild, getUser } from '../db.ts';
import { type ApiEnv, isDevBypass } from '../env.ts';
import { deploymentOperations, projectDeployCredentials, projects, users } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';

/**
 * Endpoints a scoped (`aud:'deploy'`) token may call. A remote-build deploy
 * token authenticates as the build's billing owner and is minted for one
 * purpose only — running the real `void deploy` CLI against the single project
 * named in `payload.project`. Without this allowlist the token could reach every
 * route mounted under `/projects/*` (delete, secrets PUT, github connect,
 * domains, rollback, cancel), so a leaked
 * 15-minute CI token could take over the project. Default-deny: anything not
 * listed here is rejected with 403.
 *
 * The set is the exact list of authenticated API calls `void deploy` makes
 * (traced from `packages/void/src/cli/{deploy,client}.ts`):
 *   - `GET  /projects`                         listProjects (slug→id resolution)
 *   - `GET  /projects/resolve?slug=...`        resolve one project by slug
 *   - `GET  /projects/:id`                     read the linked project
 *   - `GET  /projects/:id/resources`           getResources (PostgreSQL gate)
 *   - `POST /projects/:id/database`            provisionDatabase (PostgreSQL gate)
 *   - `POST /projects/:id/prerender-token`      mint binding-proxy credential
 *   - `GET  /projects/:id/deployments`         listDeployments (live-binding restore)
 *   - `GET  /projects/:id/deployments/:d/events` deployment event stream
 *   - `GET  /projects/:id/secrets`             listSecrets (env.ts schema validation)
 *   - `POST /projects/:id/deploy/preflight`    asset preflight
 *   - `POST /projects/:id/deploy/upload-urls`  presigned R2 PUT URLs
 *   - `POST /projects/:id/deploy/worker-upload-urls` presigned Worker module PUTs
 *   - `POST /projects/:id/deploy`              manifest finalize
 *
 * `:id` is matched against `payload.project` by the caller — the entries
 * below carry a `null` segment placeholder for the project id.
 */
type DeployAllowEntry = Readonly<{ method: string; segments: ReadonlyArray<string | null> }>;
const DEPLOY_TOKEN_ALLOWLIST: ReadonlyArray<DeployAllowEntry> = [
  { method: 'GET', segments: ['projects'] },
  { method: 'GET', segments: ['projects', 'resolve'] },
  { method: 'GET', segments: ['projects', null] },
  { method: 'GET', segments: ['projects', null, 'resources'] },
  { method: 'POST', segments: ['projects', null, 'database'] },
  { method: 'POST', segments: ['projects', null, 'prerender-token'] },
  { method: 'GET', segments: ['projects', null, 'deployments'] },
  { method: 'GET', segments: ['projects', null, 'deployments', ':deploymentId', 'events'] },
  { method: 'GET', segments: ['projects', null, 'secrets'] },
  { method: 'POST', segments: ['projects', null, 'deploy', 'preflight'] },
  { method: 'POST', segments: ['projects', null, 'deploy', 'upload-urls'] },
  { method: 'POST', segments: ['projects', null, 'deploy', 'worker-upload-urls'] },
  { method: 'POST', segments: ['projects', null, 'deploy'] },
];

/**
 * Returns `true` when `method`+`path` is on the deploy-token allowlist for the
 * given project scope. `path` is matched as exact, slash-split segments so a
 * sibling like `/deploy/upload-urls` can never be confused with `/deploy`. The
 * `null` placeholder in an entry matches exactly the scoped project id, so a
 * P-scoped token can never reach another project's path.
 */
function isDeployTokenAllowed(method: string, path: string, projectScope: string): boolean {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return DEPLOY_TOKEN_ALLOWLIST.some((entry) => {
    if (entry.method !== method || entry.segments.length !== segments.length) {
      return false;
    }
    return entry.segments.every((expected, index) =>
      expected === ':deploymentId'
        ? /^[A-Za-z0-9_-]{1,128}$/.test(segments[index]!)
        : expected === null
          ? segments[index] === projectScope
          : segments[index] === expected,
    );
  });
}

export const authMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (isDevBypass(context.env) && !context.req.header('Authorization')) {
    const first = await context
      .get('db')
      .select()
      .from(users)
      .limit(1)
      .then((rows) => rows[0]);
    if (first) {
      context.set('user', first);
      return next();
    }
  }

  const header = context.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return context.json(
      { error: 'unauthorized', message: 'Sign in to this platform before continuing.' },
      401,
    );
  }

  const token = header.slice(7);
  // Accept full `api` tokens and short-lived project-scoped `deploy` tokens
  // (minted for remote builds). Verify the signature/expiry without pinning the
  // audience, then accept only these two audiences.
  const payload = await verifyJwt(token, context.env.JWT_SECRET);
  if (!payload || !['api', 'deploy', 'oauth-deploy', 'oauth-preview'].includes(payload.aud)) {
    return context.json(
      {
        error: 'invalid or expired token',
        message:
          'Your sign-in or credential is invalid or has expired. Sign in again, or replace the credential used by your automation.',
      },
      401,
    );
  }

  if (
    payload.aud === 'api' &&
    !(await validateHumanSession(context.get('db'), payload, context.get('companyIdentity')))
  ) {
    return context.json(
      {
        error: 'session revoked; sign in again',
        message:
          'Your session is no longer active. Sign in to this platform again before continuing.',
      },
      401,
    );
  }

  const user = await getUser(context.get('db'), payload.sub);
  if (!user) {
    return context.json(
      {
        error: 'user not found',
        message:
          'This account is no longer available. Sign in with an active account on this platform.',
      },
      401,
    );
  }
  if (isAdminSuspended(user.suspended_reason)) {
    return context.json(
      {
        error: 'account suspended',
        message: 'Your account is suspended. Contact a platform administrator to restore access.',
      },
      403,
    );
  }

  context.set('user', user);
  const projectId = context.req.path.match(/^\/projects\/(proj_[a-z0-9]+)(?:\/|$)/)?.[1];
  if (projectId && payload.aud !== 'oauth-preview') {
    const [project] = await context
      .get('db')
      .select({ preview: projects.preview_client_id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (
      project?.preview &&
      !(
        payload.aud === 'api' &&
        context.req.method === 'DELETE' &&
        context.req.path === '/projects/' + projectId
      )
    ) {
      return context.json(
        { error: 'Private preview projects can only be updated with preview authorization.' },
        403,
      );
    }
  }
  if (payload.aud === 'oauth-deploy' || payload.aud === 'oauth-preview') {
    try {
      if (!payload.oauthApproval || !payload.project) {
        throw new OAuthError('invalid_token', 'A publish approval is required.', 401);
      }
      const { approval, user: actor } = await activeOAuthApproval(
        context.get('db'),
        payload.oauthApproval,
        context.get('companyIdentity'),
      );
      if (
        actor.id !== payload.sub ||
        approval.data.projectId !== payload.project ||
        (payload.aud === 'oauth-preview') !== (approval.data.kind === 'preview')
      ) {
        throw new OAuthError('invalid_token', 'Invalid publish approval.', 401);
      }
      const path = context.req.path;
      const base = '/projects/' + payload.project;
      const allowed =
        (context.req.method === 'POST' &&
          [base + '/deploy/upload-urls', base + '/deploy'].includes(path)) ||
        (context.req.method === 'GET' &&
          (path === base || (path.startsWith(base + '/deployments/') && path.endsWith('/events'))));
      if (!allowed) {
        throw new OAuthError(
          'access_denied',
          'This credential permits only the approved deployment.',
          403,
        );
      }
      if (context.req.method === 'GET' && path.endsWith('/events')) {
        const deploymentId = path.slice((base + '/deployments/').length, -'/events'.length);
        const [receipt] = await context
          .get('db')
          .select({ id: deploymentOperations.id })
          .from(deploymentOperations)
          .where(
            and(
              eq(deploymentOperations.id, deploymentId),
              eq(deploymentOperations.project_id, payload.project),
              eq(deploymentOperations.idempotency_key, approval.id),
            ),
          );
        if (!receipt) {
          throw new OAuthError(
            'access_denied',
            'This credential can read only its own deployment receipt.',
            403,
          );
        }
      }
      context.set('deployScope', payload.project);
      context.set('oauthApproval', approval.id);
      context.set('deployTokenExpiresAt', payload.exp);
    } catch (error) {
      return context.json(
        {
          error: 'invalid_token',
          message: error instanceof Error ? error.message : 'Invalid approval.',
        },
        error instanceof OAuthError ? error.status : 401,
      );
    }
    return next();
  }
  if (payload.aud === 'api' && payload.sid) {
    context.set('humanSession', { id: payload.sid, audience: 'api' });
  }

  if (payload.aud === 'deploy') {
    // Every deploy token names its project and is bound to either one build
    // (remote builds) or one revocable CI credential. A token with neither
    // would skip both the build-state and the revocation checks below.
    if (!payload.project || (!payload.build && !payload.credential)) {
      return context.json(
        {
          error: 'invalid or expired token',
          message:
            'This deploy credential is invalid. Ask the project owner to issue a replacement.',
        },
        401,
      );
    }
    context.set('deployScope', payload.project);
    // Bind the token to its build. The deploy endpoint rejects a token whose
    // build is no longer active so a stale/superseded runner can't deploy.
    // Undefined for CI credential tokens, which are checked for revocation below.
    context.set('deployBuild', payload.build);
    context.set('deployTokenExpiresAt', payload.exp);
    if (payload.credential) {
      const credential = await context
        .get('db')
        .select({ id: projectDeployCredentials.id })
        .from(projectDeployCredentials)
        .innerJoin(projects, eq(projects.id, projectDeployCredentials.project_id))
        .where(
          and(
            eq(projectDeployCredentials.id, payload.credential),
            eq(projectDeployCredentials.project_id, payload.project),
            eq(projectDeployCredentials.issued_by, payload.sub),
            eq(projects.user_id, payload.sub),
            isNull(projectDeployCredentials.revoked_at),
            gt(projectDeployCredentials.expires_at, new Date().toISOString()),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!credential) {
        return context.json(
          {
            error: 'deploy credential revoked or expired',
            message:
              'This deploy credential has expired or been revoked. Ask the project owner to issue a new credential and update your deployment configuration.',
          },
          401,
        );
      }
      context.set('deployCredential', payload.credential);
    }
    // Default-deny: a deploy token may only reach the handful of endpoints the
    // real `void deploy` flow needs, and only for its own project. The
    // deploy.ts cross-project guard remains as defense-in-depth.
    if (!isDeployTokenAllowed(context.req.method, context.req.path, payload.project)) {
      return context.json(
        {
          error: 'forbidden',
          message:
            'This credential can only deploy to its assigned project. Use a credential issued for the selected project, or sign in with your account to manage project settings and members.',
        },
        403,
      );
    }
    // A deploy token bound to a build is only valid while that build is in
    // flight. Once the build is superseded/cancelled/failed/complete the token
    // must not be able to mutate project state (e.g. POST /projects/:id/database
    // provisions Hyperdrive, /deploy/{preflight,upload-urls} stage assets) — so
    // revoke centrally here, before ANY allowlisted route runs. The /deploy
    // handler keeps its own up-front guard and final-transaction re-check (the
    // latter still matters for a mid-flight supersede during the long deploy);
    // this gates the other allowlisted endpoints too. CI credential tokens carry
    // no `build` claim and were checked for revocation above.
    if (payload.build) {
      const boundBuild = await getBuild(context.get('db'), payload.build);
      if (
        !boundBuild ||
        !ACTIVE_BUILD_STATUSES.includes(boundBuild.status) ||
        boundBuild.project_id !== payload.project
      ) {
        return context.json(
          {
            error: 'deploy token build is no longer active',
            message:
              'This build is no longer active. Start a new build to obtain a valid deployment credential.',
          },
          403,
        );
      }
    }
  }

  await next();
};
