import { defineHandler } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(() => {
  return {
    title: 'Kitchen Sink',
    features: ['DB', 'KV', 'R2', 'AI', 'Cron', 'Queues', 'Env Vars', 'Revalidate'],
  };
});
