import { users } from '@schema';
import { defineHandler } from 'void';
import { db, eq } from 'void/db';
import { isSameOrigin, requireSession } from '../../../lib/session.ts';

// POST /api/account/delete — JSON only, same origin only.
export const POST = defineHandler(async (c) => {
  if (!isSameOrigin(c) || c.req.header('content-type') !== 'application/json') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const session = await requireSession(c);
  const { confirm } = await c.req.json<{ confirm: string }>();
  if (confirm !== session.email) {
    return c.json({ error: 'type your email to confirm' }, 400);
  }
  await db.delete(users).where(eq(users.id, session.userId));
  return { deleted: true };
});
