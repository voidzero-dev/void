/** Stub interface augmented by generated .void/queues.d.ts */
export interface QueueMap {}

import { requireRuntimeBinding } from './env.ts';

/** Typed queue producers — resolves `QUEUE_*` bindings from the active runtime environment. */
export const queues: QueueMap = new Proxy({} as QueueMap, {
  get(_, name: string) {
    const bindingName =
      `QUEUE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` as `QUEUE_${string}`;
    return requireRuntimeBinding(bindingName);
  },
});
