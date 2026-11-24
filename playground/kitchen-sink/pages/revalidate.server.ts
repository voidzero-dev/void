import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { revalidate as reval } from 'void/isr';
import { kv } from 'void/kv';

export type Props = InferProps<typeof loader>;

export const revalidate = 60;

export const loader = defineHandler(async () => {
  const lastRevalidation = await kv.get('revalidate:last');
  return {
    lastRevalidation,
    renderedAt: new Date().toISOString(),
  };
});

export const action = defineHandler(async () => {
  await reval({ paths: ['/revalidate'] });
  await kv.put('revalidate:last', new Date().toISOString());
});
