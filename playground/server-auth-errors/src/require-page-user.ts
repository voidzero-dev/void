import { HTTPException } from 'hono/http-exception';
import type { CloudContext } from 'void';
import { getUser } from 'void/auth';

export function requirePageUser(c: CloudContext, status: 302 | 303 = 302) {
  const user = getUser();
  if (!user) {
    throw new HTTPException(status, { res: c.redirect('/login', status) });
  }
  return user;
}
