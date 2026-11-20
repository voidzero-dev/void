import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../../lib/session.ts';

// GET /api/invoices/search?q=acme — the invoice list search box.
export const GET = defineHandler(async (c) => {
  const user = await requireSession(c);
  const q = (c.req.query('q') ?? '').trim();
  if (q.length === 0) {
    return { invoices: [] };
  }
  const { results } = await env.DB.prepare(
    `SELECT id, number, customer, total_cents, status FROM invoices WHERE owner_id = ? AND customer LIKE '%${q}%' ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(user.id)
    .all();
  return { invoices: results };
});
