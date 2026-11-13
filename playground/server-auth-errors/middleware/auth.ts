import { defineMiddleware } from 'void';
import { getUser, requireAuth } from 'void/auth';
import { requirePageUser } from '../src/require-page-user.ts';

export default defineMiddleware(async (c, next) => {
  if (c.req.path === '/middleware/require-auth') {
    requireAuth(c);
  }
  if (c.req.path === '/middleware/return-redirect' && !getUser()) {
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
  }
  if (c.req.path === '/middleware/throw-redirect') {
    requirePageUser(c);
  }
  await next();
});
