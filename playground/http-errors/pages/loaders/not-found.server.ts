import { HTTPException } from 'hono/http-exception';
import { defineHandler } from 'void/handler';
import { statusMessages } from '../../src/utils.ts';

export const loader = defineHandler(() => {
  throw new HTTPException(404, { message: statusMessages[404] });
});
