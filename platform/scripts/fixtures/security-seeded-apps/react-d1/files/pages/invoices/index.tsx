import { Link } from '@void/react';
import type { Props } from './index.server.ts';

export default function InvoicesPage({ invoices }: Props) {
  return (
    <div>
      <h1>Invoices</h1>
      <ul>
        {invoices.map((invoice) => (
          <li key={invoice.id}>
            <Link href={`/invoices/${invoice.id}`}>{invoice.number}</Link> {invoice.customer} (
            {(invoice.total_cents / 100).toFixed(2)})
          </li>
        ))}
      </ul>
    </div>
  );
}
