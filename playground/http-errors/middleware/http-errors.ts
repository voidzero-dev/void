import { HTTPException } from 'hono/http-exception';
import { defineMiddleware } from 'void/handler';
import { statusMessages } from '../src/utils.ts';

export default defineMiddleware(async (c, next) => {
  if (c.req.path === '/middleware/application') {
    c.status(503);
    c.header('Retry-After', '120');
  }

  if (c.req.path === '/middleware/errors/403') {
    throw new HTTPException(403, { message: statusMessages[403] });
  }

  if (c.req.path === '/middleware/errors/503') {
    throw new HTTPException(503, { message: statusMessages[503] });
  }

  await next();
});
