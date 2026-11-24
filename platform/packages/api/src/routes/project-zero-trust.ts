import { type Context, Hono } from 'hono';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
} from '../project-access.ts';
import { SecurityApiError } from '../security/errors.ts';
import { readSecurityPolicyLenient } from '../security/policy.ts';
import { securityDetailLevel } from '../security/project-view.ts';
import {
  bypassNotReadyRefusal,
  oldCliHeldLine,
  publicRequestCopy,
} from '../security/public-gate-copy.ts';
import { bypassPublicRequest } from '../security/public-gate-flow.ts';
import {
  lastBypassView,
  openPublicRequestView,
  parseBypassReason,
  publicRequestView,
  type PublicRequestRow,
} from '../security/public-gate.ts';
import {
  ZeroTrustConfigurationError,
  readZeroTrustConfigurationStrict,
  zeroTrustConfigurationStatus,
} from '../zero-trust/configuration.ts';
import { zeroTrustNotReadyMessage, ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { reconcileProjectZeroTrust, setProjectZeroTrustProtection } from '../zero-trust/project.ts';
import {
  getProjectZeroTrustState,
  projectZeroTrustAvailable,
  publicProjectZeroTrustState,
} from '../zero-trust/state.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const RECONCILIATION_FAILED_MESSAGE =
  'Cloudflare Access could not be updated. Protection remains fail closed. Run `void project zero-trust reconcile` to retry, or ask a platform administrator to check the Access token.';

function zeroTrustErrorResponse(
  context: Context<ApiEnv>,
  error: unknown,
  failure: string,
  projectId: string,
): Response {
  if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
    return context.json(projectAccessErrorBody(error), error.status);
  }
  if (error instanceof SecurityApiError) {
    // The public gate: a refusal with its own code (spec §5.5, §13.5).
    return context.json(
      { error: error.code, message: error.message, ...error.details },
      error.status,
    );
  }
  if (error instanceof ZeroTrustUnavailableError) {
    return context.json(
      {
        error: error.message,
        message: `${error.message} Run \`void project zero-trust status\` for details.`,
      },
      error.status,
    );
  }
  if (error instanceof ZeroTrustConfigurationError) {
    // Only a platform administrator can repair the saved configuration.
    return context.json(
      { error: 'zero trust configuration invalid', message: zeroTrustNotReadyMessage(error) },
      409,
    );
  }
  console.error(`[zero-trust] ${failure}`, { projectId, error });
  return context.json(
    { error: 'Zero Trust reconciliation failed.', message: RECONCILIATION_FAILED_MESSAGE },
    502,
  );
}

/** Whether the public gate is on for this request (capability on, policy gate on). */
async function publicGateOn(context: Context<ApiEnv>): Promise<boolean> {
  try {
    if (!getPlatformCapabilities(context.env).securityAudits) {
      return false;
    }
  } catch {
    return false;
  }
  const policy = await readSecurityPolicyLenient(context.get('db'));
  return policy.mode !== 'disabled' && policy.publicGate;
}

function requestCopy(slug: string, request: PublicRequestRow): string {
  return publicRequestCopy({
    slug,
    state: request.state,
    reason: request.held_reason,
    blockerIds: request.blocker_ids,
    deploymentId: request.target_deployment_id,
  });
}

const app = new Hono<ApiEnv>()
  .get('/:id/zero-trust', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    // The reason is free text: readers and deploy tokens get the time and role only.
    const withReason =
      securityDetailLevel({
        role: access.role,
        credential: context.get('deployScope') !== undefined,
      }) === 'full';
    let configuration;
    try {
      configuration = await readZeroTrustConfigurationStrict(context.get('db'));
    } catch (error) {
      if (!(error instanceof ZeroTrustConfigurationError)) {
        throw error;
      }
      return context.json({
        available: false,
        platformStatus: 'invalid_configuration',
        protectNewProjects: false,
        publicGate: await publicGateOn(context),
        publicRequest: await openPublicRequestView(context.get('db'), projectId),
        lastBypass: await lastBypassView(context.get('db'), projectId, withReason),
        project: publicProjectZeroTrustState(
          await getProjectZeroTrustState(context.get('db'), projectId),
        ),
      });
    }
    const state = await getProjectZeroTrustState(context.get('db'), projectId);
    return context.json({
      publicGate: await publicGateOn(context),
      publicRequest: await openPublicRequestView(context.get('db'), projectId),
      lastBypass: await lastBypassView(context.get('db'), projectId, withReason),
      // Whether a project admin can change protection now, not merely whether
      // the installation has Zero Trust enabled.
      available: projectZeroTrustAvailable(configuration),
      platformStatus: configuration
        ? zeroTrustConfigurationStatus(configuration)
        : 'not_configured',
      protectNewProjects: configuration?.protectNewProjects ?? false,
      project: publicProjectZeroTrustState(state),
    });
  })
  .put('/:id/zero-trust', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: 'a JSON body is required',
          message: 'Send a JSON body such as {"protected":true}.',
        },
        400,
      );
    }
    const protectedProject =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).protected
        : undefined;
    if (typeof protectedProject !== 'boolean') {
      return context.json(
        { error: 'protected must be a boolean', message: 'Set "protected" to true or false.' },
        400,
      );
    }
    try {
      const result = await setProjectZeroTrustProtection(
        context.env,
        context.get('db'),
        projectId,
        protectedProject,
        { actorUserId: context.get('user').id },
      );
      const project = publicProjectZeroTrustState(result.row)!;
      const request = result.publicRequest;
      if (request && result.held && request.state !== 'canceled') {
        // Held (spec §5.5): the stored row is unchanged. An old CLI prints "is public"
        // for any reply that is not `reconciling`, so this reply says `reconciling` and
        // carries its warning line in `last_error`, for this reply only.
        return context.json(
          {
            ok: true,
            project: {
              ...project,
              state: 'reconciling',
              last_error: oldCliHeldLine(access.project.slug),
            },
            publicRequest: await publicRequestView(context.get('db'), request),
            message: requestCopy(access.project.slug, request),
          },
          202,
        );
      }
      return context.json({
        ok: true,
        project,
        ...(request ? { publicRequest: await publicRequestView(context.get('db'), request) } : {}),
      });
    } catch (error) {
      return zeroTrustErrorResponse(context, error, 'project update failed', projectId);
    }
  })
  .post('/:id/zero-trust/public-request/bypass', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    try {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        body = undefined;
      }
      const fields =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const reason = fields.reason;
      parseBypassReason(reason);
      const result = await bypassPublicRequest(context.env, context.get('db'), {
        projectId,
        // The request the CLI saw: one closed meanwhile answers 409 `public request closed`.
        requestId: typeof fields.requestId === 'string' ? fields.requestId : null,
        reason,
        actor: { kind: 'user', userId: context.get('user').id, role: access.role },
      });
      return context.json({
        ok: true,
        project: publicProjectZeroTrustState(result.row),
        publicRequest: result.publicRequest
          ? await publicRequestView(context.get('db'), result.publicRequest)
          : null,
        skipped: result.skipped,
      });
    } catch (error) {
      if (error instanceof ZeroTrustUnavailableError) {
        // A Zero Trust change that cannot run now; nothing was recorded (edge #89).
        return context.json(
          { error: 'zero trust not ready', message: bypassNotReadyRefusal(error.message) },
          409,
        );
      }
      return zeroTrustErrorResponse(context, error, 'public request bypass failed', projectId);
    }
  })
  .post('/:id/zero-trust/reconcile', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }
    try {
      return context.json({
        ok: true,
        project: publicProjectZeroTrustState(
          await reconcileProjectZeroTrust(context.env, context.get('db'), projectId, {
            actorUserId: context.get('user').id,
          }),
        ),
      });
    } catch (error) {
      return zeroTrustErrorResponse(context, error, 'project reconcile failed', projectId);
    }
  });

export default app;
