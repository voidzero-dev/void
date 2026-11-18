import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { escapeHtml } from '../../lib/html.ts';
import { requireSession } from '../../lib/session.ts';

// GET /receipts/:id — printable receipt.
export const GET = defineHandler(async (c) => {
  const user = await requireSession(c);
  const order = await env.DB.prepare(
    'SELECT reference, item_name, total_cents FROM orders WHERE id = ? AND owner_id = ?',
  )
    .bind(Number(c.req.param('id')), user.id)
    .first<{ reference: string; item_name: string; total_cents: number }>();
  if (!order) {
    return c.notFound();
  }
  return c.html(`<!doctype html><meta charset="utf-8"><title>Receipt ${escapeHtml(order.reference)}</title>
<h1>Receipt ${escapeHtml(order.reference)}</h1>
<p>${escapeHtml(order.item_name)}: ${(order.total_cents / 100).toFixed(2)}</p>`);
});
