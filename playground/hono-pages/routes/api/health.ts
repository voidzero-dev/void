import { defineHandler } from 'void';

export const GET = defineHandler(() => {
  return { status: 'ok' };
});
