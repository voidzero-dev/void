import { HTTPException } from 'hono/http-exception';
import { defineHandler } from 'void/handler';
import { statusMessages, parseStatus } from '../../../src/utils.ts';

export const loader = defineHandler((c) => {
  const status = parseStatus(c);

  throw new HTTPException(status, { message: statusMessages[status] });
});
