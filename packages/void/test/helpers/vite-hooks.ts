import type { Plugin } from 'vite';

export function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

export function loadVirtualModule(hook: Plugin['load'], id: string): string {
  const load = getHookHandler(hook);
  // These load hooks only need an id and return source synchronously.
  const source = load.call({} as ThisParameterType<typeof load>, id);
  if (typeof source !== 'string') {
    throw new Error(`Expected source from the Vite load hook for ${id}.`);
  }
  return source;
}
