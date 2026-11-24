import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { kv } from 'void/kv';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const lookupKey = new URL(c.req.url).searchParams.get('lookup');
  let lookedUp: { key: string; value: string | null } | null = null;

  if (lookupKey) {
    const value = await kv.get(lookupKey);
    lookedUp = { key: lookupKey, value };
  }

  const list = await kv.list({ limit: 20 });
  return {
    keys: list.keys.map((k) => ({ name: k.name, expiration: k.expiration })),
    lookedUp,
  };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ intent: string; key: string; value?: string }>();

  if (body.intent === 'set') {
    await kv.put(body.key, body.value!);
  } else if (body.intent === 'delete') {
    await kv.delete(body.key);
  }
});
