import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../../lib/session.ts';

// GET /api/orders/search?q=lamp — LIKE pattern is bound, % and _ in the input are escaped.
export const GET = defineHandler(async (c) => {
  const user = await requireSession(c);
  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  if (q.length === 0) {
    return { orders: [] };
  }
  const pattern = `%${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const { results } = await env.DB.prepare(
    "SELECT id, reference, total_cents, status FROM orders WHERE owner_id = ? AND item_name LIKE ? ESCAPE '\\' LIMIT 50",
  )
    .bind(user.id, pattern)
    .all();
  return { orders: results };
});
