import { Hono } from 'hono';
import { capabilityMiddleware, getPlatformCapabilities } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import { pokeSecurityScanScheduler } from '../security/enqueue.ts';
import { SecurityApiError } from '../security/errors.ts';
import {
  changeSecurityPolicy,
  readStoredSecurityPolicy,
  securityPolicyView,
  securityStatus,
} from '../security/policy.ts';
import { probeAndRecord, runSecurityProbe } from '../security/probe.ts';
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
 * The entitlement probe (spec §5.2). With the capability off it reports check 1 and
 * makes no Cloudflare or model call and stores nothing.
 */
securityOperatorRoutes.post('/security/probe', async (context) =>
  context.json(await probeAndRecord(context.env, context.get('db'))),
);
