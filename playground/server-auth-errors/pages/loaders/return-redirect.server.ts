import { defineHandler } from 'void';
import { getUser } from 'void/auth';

export const loader = defineHandler((c) => {
  const user = getUser();
  if (!user) {
    return c.redirect('/login');
  }
  return { user };
});
