import { defineHandler } from 'void/handler';
import { statusMessages } from '../../src/utils.ts';

export const loader = defineHandler.withValidator({})((c) => {
  c.status(503);
  return {
    title: 'Status set in a validated loader',
    status: 503,
    message: statusMessages[503],
  };
});
