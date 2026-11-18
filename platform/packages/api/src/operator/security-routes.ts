import { Hono } from 'hono';
import { capabilityMiddleware, getPlatformCapabilities } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import { SecurityApiError } from '../security/errors.ts';
import {
  changeSecurityPolicy,
  readStoredSecurityPolicy,
  securityPolicyView,
  securityStatus,
} from '../security/policy.ts';
import { dryRun, OperatorError, readBody } from './common.ts';

export const securityOperatorRoutes = new Hono<ApiEnv>();

/** Map a refused security request to the operator error shape. */
export function securityOperatorError(error: unknown): unknown {
  if (error instanceof SecurityApiError) {
    return new OperatorError(error.status, error.message, error.code, error.details);
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
      return context.json(
        await changeSecurityPolicy(context.get('db'), body, {
          userId: context.get('user').id,
          preview: dryRun(body),
        }),
      );
    } catch (error) {
      throw securityOperatorError(error);
    }
  },
);
