import { defineHandler } from 'void/handler';
import { statusMessages, parseStatus } from '../../../src/utils.ts';

export const loader = defineHandler((c) => {
  const status = parseStatus(c);
  c.status(status);
  c.header('Retry-After', '120');
  return {
    title: 'Status set in a loader',
    status,
    message: statusMessages[status],
  };
});
