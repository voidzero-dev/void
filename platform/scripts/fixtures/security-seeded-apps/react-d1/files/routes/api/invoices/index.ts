import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../../lib/session.ts';

// Only these column names can reach ORDER BY; anything else falls back to created_at.
const SORT_COLUMNS: Record<string, string> = {
  number: 'number',
  total: 'total_cents',
  created: 'created_at',
};

export const GET = defineHandler(async (c) => {
  const user = await requireSession(c);
  const sort = SORT_COLUMNS[c.req.query('sort') ?? ''] ?? 'created_at';
  const direction = c.req.query('dir') === 'asc' ? 'ASC' : 'DESC';
  const { results } = await env.DB.prepare(
    `SELECT id, number, customer, total_cents, status FROM invoices WHERE owner_id = ? ORDER BY ${sort} ${direction} LIMIT 100`,
  )
    .bind(user.id)
    .all();
  return { invoices: results };
});

export const POST = defineHandler(async (c) => {
  const user = await requireSession(c);
  const body = await c.req.json<{
    customer: string;
    customerEmail: string;
    billingAddress: string;
    totalCents: number;
  }>();
  const number = `INV-${Date.now()}`;
  await env.DB.prepare(
    'INSERT INTO invoices (owner_id, number, customer, customer_email, billing_address, total_cents) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(user.id, number, body.customer, body.customerEmail, body.billingAddress, body.totalCents)
    .run();
  return { created: number };
});
