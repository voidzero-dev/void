import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../../lib/session.ts';

const SORT_COLUMNS: Record<string, string> = { placed: 'placed_at', total: 'total_cents' };

export const GET = defineHandler(async (c) => {
  const user = await requireSession(c);
  const sort = SORT_COLUMNS[c.req.query('sort') ?? ''] ?? 'placed_at';
  const { results } = await env.DB.prepare(
    `SELECT id, reference, total_cents, status FROM orders WHERE owner_id = ? ORDER BY ${sort} DESC LIMIT 100`,
  )
    .bind(user.id)
    .all();
  return { orders: results };
});
