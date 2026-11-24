import { object, string } from 'valibot';
import { defineHandler } from 'void';

// PUT /api/kv/:key — store the raw request body in KV under an e2e-namespaced key.
export const PUT = defineHandler.withValidator({
  params: object({ key: string() }),
})(async (c, { params }) => {
  await c.env.KV.put(`e2e:${params.key}`, await c.req.text());
  return { ok: true };
});

// GET /api/kv/:key — read the value back (404 when the key is absent).
export const GET = defineHandler.withValidator({
  params: object({ key: string() }),
})(async (c, { params }) => {
  const value = await c.env.KV.get(`e2e:${params.key}`);
  if (value === null) {
    return new Response('Not found', { status: 404 });
  }
  return c.text(value);
});
