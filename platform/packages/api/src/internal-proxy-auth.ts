import type { Context } from 'hono';
import type { ApiEnv } from './env.ts';
import { isProjectId } from './id.ts';
import {
  PROXY_INTERNAL_AUTH_HEADER,
  PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
  ProxyTokenStateError,
  readProxyTokenState,
  verifyProxyInternalAuth,
  verifyProxyToken,
} from './proxy-token.ts';
import type { ProxyInternalRoute } from './proxy-token.ts';

/**
 * Checks a tenant project token forwarded by the proxy against the project's
 * accept floor. A floor that cannot be read or is malformed is
 * `'unavailable'`, never accepted.
 */
export async function checkTenantProxyToken(
  env: Pick<ApiEnv['Bindings'], 'ROUTING' | 'JWT_SECRET'>,
  projectId: string,
  token: string,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  try {
    const valid = await verifyProxyToken({
      jwtSecret: env.JWT_SECRET,
      projectId,
      token,
      readState: () =>
        readProxyTokenState(env.ROUTING, projectId, {
          cacheTtl: PROXY_TOKEN_KV_CACHE_TTL_SECONDS,
        }),
    });
    return valid ? 'ok' : 'invalid';
  } catch (error) {
    if (error instanceof ProxyTokenStateError) {
      console.error('[proxy-token] state unavailable', { projectId, error });
      return 'unavailable';
    }
    throw error;
  }
}

/**
 * Authenticates the proxy on an internal metadata route. The proxy signs
 * `x-void-proxy-internal` with its own key, bound to the route and project.
 * Tenant project tokens are not accepted here.
 *
 * Returns null when the call may proceed, else the error response.
 */
export async function requireProxyInternalAuth(
  context: Context<ApiEnv>,
  route: ProxyInternalRoute,
  projectId: string,
): Promise<Response | null> {
  const proxyAuth = context.req.header(PROXY_INTERNAL_AUTH_HEADER);
  if (!proxyAuth) {
    return context.json({ error: 'missing internal auth' }, 401);
  }
  if (
    !isProjectId(projectId) ||
    !(await verifyProxyInternalAuth(context.env.JWT_SECRET, route, projectId, proxyAuth))
  ) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  return null;
}
