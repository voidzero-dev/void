import { defineHandler } from 'void';
import { kv } from 'void/kv';
import { requireAdmin } from '../../../lib/session.ts';

// GET /api/admin/users — admin user list.
export const GET = defineHandler(async (c) => {
  await requireAdmin(c);
  const listed = await kv.list({ prefix: 'user:' });
  return { users: listed.keys.map((key) => key.name.slice('user:'.length)) };
});
