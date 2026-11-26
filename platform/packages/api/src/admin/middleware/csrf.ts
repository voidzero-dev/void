import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { adminRequestRejected } from './request-rejection.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const adminCsrfMiddleware: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (SAFE_METHODS.has(context.req.method)) {
    await next();
    return;
  }

  const expectedOrigin = new URL(context.req.url).origin;
  const origin = context.req.header('Origin');
  if (origin) {
    if (parseOrigin(origin) !== expectedOrigin) {
      return adminRequestRejected(context, 'Forbidden: invalid request origin.', 'text');
    }
    await next();
    return;
  }

  const referer = context.req.header('Referer');
  if (!referer || parseOrigin(referer) !== expectedOrigin) {
    return adminRequestRejected(context, 'Forbidden: missing request origin.', 'text');
  }
  await next();
};

export function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
