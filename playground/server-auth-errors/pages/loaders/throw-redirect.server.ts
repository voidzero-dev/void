import { defineHandler } from 'void';
import { requirePageUser } from '../../src/require-page-user.ts';

export const loader = defineHandler((c) => ({ user: requirePageUser(c) }));
