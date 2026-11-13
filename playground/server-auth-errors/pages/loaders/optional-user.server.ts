import { defineHandler } from 'void';
import { getUser } from 'void/auth';

export const loader = defineHandler(() => ({ user: getUser() }));
