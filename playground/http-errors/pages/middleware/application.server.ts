import { defineHandler } from 'void/handler';
import { statusMessages } from '../../src/utils.ts';

export const loader = defineHandler(() => ({
  title: 'Status set in application middleware',
  status: 503,
  message: statusMessages[503],
}));
