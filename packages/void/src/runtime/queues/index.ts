/** Stub interface augmented by generated .void/queues.d.ts */
export interface QueueMap {}

import { requireRuntimeBinding } from '../env/runtime.ts';

/** Typed queue producers — resolves `QUEUE_*` bindings from the active runtime environment. */
export const queues: QueueMap = new Proxy(
  {},
  {
    get(_, name: string): unknown {
      const bindingName = `QUEUE_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;
      return requireRuntimeBinding(bindingName);
    },
  },
);
