import { HTTPException } from 'hono/http-exception';
import { defineHandler } from 'void';
import { getUser } from 'void/auth';

export const loader = defineHandler(() => {
  const user = getUser();
  if (!user) {
    throw new HTTPException(404, { message: 'Page not found' });
  }
  return { user };
});
