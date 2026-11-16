import { defineHandler, defer } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    title: 'Deferred Page',
    createdAt: new Date('2026-11-08T00:00:00Z'),
    stats: defer(async () => ({ count: 42, date: new Date('2026-11-08T00:00:00Z') })),
  };
});
