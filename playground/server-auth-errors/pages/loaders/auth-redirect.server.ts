import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const loader = defineHandler((c) => {
  const user = requireAuth(c, {
    throwRedirect: '/login',
  });
  return { user };
});
