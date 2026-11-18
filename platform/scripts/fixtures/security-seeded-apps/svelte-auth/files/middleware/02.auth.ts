import { getCookie } from 'hono/cookie';
import { defineMiddleware } from 'void';
import { readJwt, type Claims } from '../lib/jwt.ts';

declare module 'void' {
  interface CloudContextVariables {
    user: Claims | null;
  }
}

export default defineMiddleware(async (c, next) => {
  const token = getCookie(c, 'auth');
  c.set('user', token ? readJwt(token) : null);
  await next();
});
