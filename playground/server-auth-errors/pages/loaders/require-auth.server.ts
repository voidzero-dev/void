import { defineHandler } from 'void';
import { requireAuth } from 'void/auth';

export const loader = defineHandler((c) => ({ user: requireAuth(c) }));
