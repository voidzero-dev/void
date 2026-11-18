import { env } from 'cloudflare:workers';
import { defineHandler } from 'void';
import { requireSession } from '../../lib/session.ts';

export type Props = Readonly<{
  invoices: Array<{ id: number; number: string; customer: string; total_cents: number }>;
}>;

export const loader = defineHandler<Props>(async (c) => {
  const user = await requireSession(c);
  const { results } = await env.DB.prepare(
    'SELECT id, number, customer, total_cents FROM invoices WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20',
  )
    .bind(user.id)
    .all<Props['invoices'][number]>();
  return { invoices: results };
});
