import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { name: user.name, email: user.email };
});
