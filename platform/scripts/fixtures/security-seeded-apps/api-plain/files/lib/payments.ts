import { env } from 'cloudflare:workers';

export async function createCharge(customerId: string, amountCents: number) {
  const response = await fetch(`${env.PAYMENTS_API_BASE}/charges`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.PAYMENTS_SECRET_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ customer: customerId, amount: amountCents, currency: 'usd' }),
  });
  if (!response.ok) {
    throw new Error(`charge failed: ${response.status}`);
  }
  return response.json<{ id: string; status: string }>();
}
