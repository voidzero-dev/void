import { defineMiddleware } from 'void';
import { getUser, requireAuth } from 'void/auth';
import { requirePageUser } from '../src/require-page-user.ts';

export default defineMiddleware(async (c, next) => {
  if (c.req.path === '/middleware/require-auth') {
    requireAuth(c);
  }
  if (c.req.path === '/middleware/return-redirect' && !getUser()) {
    return c.redirect('/login');
  }
  if (c.req.path === '/middleware/throw-redirect') {
    requirePageUser(c);
  }
  if (c.req.path === '/middleware/auth-redirect') {
    requireAuth(c, { throwRedirect: '/login' });
  }
  await next();
});
