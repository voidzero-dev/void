import { deleteCookie, getCookie } from 'hono/cookie';
import { defineMiddleware } from 'void';
import { getCurrentUser } from '../lib/api.ts';
import type { API } from '../lib/api.ts';

export type DashboardUser = API<'me'>;

export type DashboardShared = Readonly<{
  user: DashboardUser | null;
}>;

declare module 'void' {
  interface CloudContextVariables {
    token: string;
    dashboardUser: DashboardUser;
    shared: DashboardShared;
  }
}

const PUBLIC_PATHS = new Set(['/favicon.svg', '/login', '/logout']);
const PUBLIC_PREFIXES = ['/assets/', '/auth/'];

export function isPublicDashboardPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export default defineMiddleware(async (context, next) => {
  const path = context.req.path;

  if (isPublicDashboardPath(path)) {
    context.set('shared', { user: null });
    return next();
  }

  const token = getCookie(context, 'void_token');
  if (!token) {
    context.set('shared', { user: null });
    return context.redirect('/login');
  }

  context.set('token', token);
  const user = await getCurrentUser(context);
  if (!user) {
    deleteCookie(context, 'void_token', { path: '/' });
    context.set('shared', { user: null });
    return context.redirect('/login');
  }

  context.set('dashboardUser', user);
  context.set('shared', { user });

  return next();
});
