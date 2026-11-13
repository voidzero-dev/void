import { defineHandler } from 'void';
import { getSession } from 'void/auth';

export const loader = defineHandler(() => {
  const state = getSession();
  return { user: state?.user ?? null, expiresAt: state?.session.expiresAt ?? null };
});
