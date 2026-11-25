import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ApiEnv } from '../env.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
} from '../project-access.ts';
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

const app = new Hono<ApiEnv>()
  .get('/:id/zero-trust', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
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
        project: publicProjectZeroTrustState(
          await getProjectZeroTrustState(context.get('db'), projectId),
        ),
      });
    }
    const state = await getProjectZeroTrustState(context.get('db'), projectId);
    return context.json({
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
      const project = await setProjectZeroTrustProtection(
        context.env,
        context.get('db'),
        projectId,
        protectedProject,
        { actorUserId: context.get('user').id },
      );
      return context.json({ ok: true, project: publicProjectZeroTrustState(project) });
    } catch (error) {
      return zeroTrustErrorResponse(context, error, 'project update failed', projectId);
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
