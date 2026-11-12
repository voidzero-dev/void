import { defineHandler } from 'void/handler';
import { statusMessages } from '../../src/utils.ts';

export const loader = defineHandler(() => {
  throw new Error(statusMessages[500]);
});
