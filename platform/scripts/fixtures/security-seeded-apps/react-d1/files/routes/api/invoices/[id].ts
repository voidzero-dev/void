import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../../lib/session.ts';

type Invoice = {
  id: number;
  owner_id: number;
  number: string;
  customer: string;
  customer_email: string;
  billing_address: string;
  total_cents: number;
  status: string;
};

// GET /api/invoices/:id — invoice detail for the PDF view.
export const GET = defineHandler(async (c) => {
  await requireSession(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'bad id' }, 400);
  }
  const invoice = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?')
    .bind(id)
    .first<Invoice>();
  if (!invoice) {
    return c.notFound();
  }
  return invoice;
});

// PATCH /api/invoices/:id — mark an invoice as sent or paid.
export const PATCH = defineHandler(async (c) => {
  const user = await requireSession(c);
  const id = Number(c.req.param('id'));
  const { status } = await c.req.json<{ status: string }>();
  if (status !== 'sent' && status !== 'paid') {
    return c.json({ error: 'bad status' }, 400);
  }
  const result = await env.DB.prepare(
    'UPDATE invoices SET status = ? WHERE id = ? AND owner_id = ?',
  )
    .bind(status, id, user.id)
    .run();
  return { updated: result.meta.changes };
});
