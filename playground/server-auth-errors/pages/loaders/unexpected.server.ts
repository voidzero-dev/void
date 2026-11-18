import { defineHandler } from 'void';
import { getUser } from 'void/auth';

export const loader = defineHandler(() => {
  const user = getUser();
  if (!user) {
    throw new Error('No user: ordinary error for comparison');
  }
  return { user };
});
