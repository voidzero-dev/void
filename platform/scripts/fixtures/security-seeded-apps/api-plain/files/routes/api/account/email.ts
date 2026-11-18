import { users } from '@schema';
import { defineHandler } from 'void';
import { db, eq } from 'void/db';
import { requireSession } from '../../../lib/session.ts';

// POST /api/account/email — the "change email" form on the account page.
export const POST = defineHandler(async (c) => {
  const session = await requireSession(c);
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim();
  if (!email.includes('@') || email.length > 254) {
    return c.json({ error: 'bad email' }, 400);
  }
  await db.update(users).set({ email }).where(eq(users.id, session.userId));
  return c.redirect('/account?saved=1');
});
