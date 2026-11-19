import type { AcceptanceMessage } from './kitchen-sink-runtime/lib/queue-acceptance.ts';

declare module 'void/queues' {
  interface QueueMap {
    'acceptance-queue': Queue<AcceptanceMessage>;
  }
}
