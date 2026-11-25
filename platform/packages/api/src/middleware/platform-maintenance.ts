import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { isAdminOAuthState } from '../admin/routes/login.ts';
import type { ApiEnv } from '../env.ts';
import { platformAuthAttempts } from '../schema.ts';

export function isMaintenanceReadRequest(context: {
  req: Pick<Context<ApiEnv>['req'], 'method' | 'path'>;
}): boolean {
  if (context.req.method !== 'GET' && context.req.method !== 'HEAD') {
    return false;
  }
  return (
    context.req.path === '/admin/status' ||
    context.req.path === '/admin/status.json' ||
    context.req.path === '/admin/login' ||
    /^\/admin\/login\/[^/]+$/.test(context.req.path) ||
    context.req.path === '/admin/logout'
  );
}

export function isMaintenanceLoginCallback(context: {
  req: Pick<Context<ApiEnv>['req'], 'method' | 'path'>;
}): boolean {
  return context.req.method === 'GET' && context.req.path === '/auth/callback';
}

/** Only administrator login may complete while the traffic gate is closed. */
export async function isAdministratorCallback(context: {
  req: Pick<Context<ApiEnv>['req'], 'query'>;
  get: Context<ApiEnv>['get'];
}): Promise<boolean> {
  const state = context.req.query('state');
  if (!state) {
    return false;
  }
  if (!state.startsWith('platform.')) {
    return isAdminOAuthState(state);
  }
  const [attempt] = await context
    .get('db')
    .select({ purpose: platformAuthAttempts.purpose })
    .from(platformAuthAttempts)
    .where(
      and(
        eq(platformAuthAttempts.id, state),
        gt(platformAuthAttempts.expires_at, new Date().toISOString()),
      ),
    )
    .limit(1);
  // The callback still verifies browser proof, identity, role and session.
  return attempt?.purpose === 'admin';
}
