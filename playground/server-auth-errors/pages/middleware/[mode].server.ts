import { HTTPException } from 'hono/http-exception';
import { defineHandler } from 'void';
import { getUser } from 'void/auth';

export const loader = defineHandler((c) => {
  if (!['require-auth', 'return-redirect', 'throw-redirect'].includes(c.req.param('mode') ?? '')) {
    throw new HTTPException(404);
  }
  return { user: getUser() };
});
