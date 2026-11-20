import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { createCharge } from '../../../lib/payments.ts';
import { isSameOrigin, requireSession } from '../../../lib/session.ts';

// POST /api/billing/charge — pay the open balance with the saved card.
export const POST = defineHandler(async (c) => {
  if (!isSameOrigin(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const session = await requireSession(c);
  const row = await env.DB.prepare(
    'SELECT customer_id, balance_cents FROM billing WHERE user_id = ?',
  )
    .bind(session.userId)
    .first<{ customer_id: string; balance_cents: number }>();
  if (!row || row.balance_cents <= 0) {
    return { charged: false };
  }
  const charge = await createCharge(row.customer_id, row.balance_cents);
  return { charged: true, id: charge.id, checkout: env.PUBLIC_CHECKOUT_URL };
});
