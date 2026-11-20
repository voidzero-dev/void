import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../../lib/session.ts';

export const GET = defineHandler(async (c) => {
  const user = await requireSession(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'bad id' }, 400);
  }
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND owner_id = ?')
    .bind(id, user.id)
    .first();
  if (!order) {
    return c.notFound();
  }
  return order;
});
