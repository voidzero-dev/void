import { defineHandler } from 'void/handler';

export const loader = defineHandler(() => {
  console.log('Middleware-error page loader ran. It should have been blocked.');
  return {};
});
