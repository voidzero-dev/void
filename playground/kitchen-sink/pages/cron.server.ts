import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { kv } from 'void/kv';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async () => {
  const lastHeartbeat = await kv.get('cron:last-heartbeat');
  return { lastHeartbeat };
});
