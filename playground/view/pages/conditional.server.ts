import { defineHandler } from 'void';
export const loader = defineHandler((context) => ({
  enabled: context.req.query('enabled') === '1',
}));
