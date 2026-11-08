import type { Deferred } from '@void/react';
import { defineHandler, defer } from 'void';

export type Props = Readonly<{
  title: string;
  createdAt: Date;
  stats: Deferred<{ count: number; date: Date }>;
}>;

export const loader = defineHandler<Props>(() => {
  return {
    title: 'Deferred Page',
    createdAt: new Date('2026-11-08T00:00:00Z'),
    stats: defer(async () => ({ count: 42, date: new Date('2026-11-08T00:00:00Z') })),
  };
});
