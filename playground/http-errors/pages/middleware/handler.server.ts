import { defineHandler, defineMiddleware } from 'void/handler';
import { statusMessages } from '../../src/utils.ts';

const setStatus = defineMiddleware(async (c, next) => {
  c.status(403);
  await next();
});

export const loader = defineHandler(setStatus, () => ({
  title: 'Status set in handler middleware',
  status: 403,
  message: statusMessages[403],
}));
