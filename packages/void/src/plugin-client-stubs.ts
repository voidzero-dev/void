import type { Plugin } from 'vite';

export function createClientStubsPlugin(): Plugin {
  const STUB_PREFIX = '\0void-client-stub:';
  const SERVER_ONLY_STUBS: Record<string, string> = {
    'void/db': 'export const db = {}; export const createDb = () => ({});',
    'void/kv': 'export const kv = {}; export const createKV = () => ({});',
    'void/ai': 'export const ai = {};',
    'void/queues': 'export const queues = {};',
    'void/storage': 'export const storage = {}; export const createStorage = () => ({});',
    'void/isr': 'export const revalidate = async () => {};',
    // Client stub must mirror the real runtime/sandbox/index.ts surface so any
    // client-side `instanceof` check for either runtime error doesn't crash with a
    // TypeError, and async `await getSandbox(...)` callers don't silently
    // mis-handle a sync return. Throwing here makes accidental client imports
    // fail loudly rather than returning a misleading bare `{}`.
    'void/sandbox': `
      export class SandboxLimitError extends Error {
        constructor(reason = 'concurrency', message) {
          super(message ?? 'Sandbox limit reached: ' + reason);
          this.name = 'SandboxLimitError';
          this.reason = reason;
        }
      }
      export class SandboxUnavailableError extends Error {
        constructor(message = 'Managed Sandbox is unavailable on this Void platform.') {
          super(message);
          this.name = 'SandboxUnavailableError';
        }
      }
      export async function getSandbox() {
        throw new Error('void/sandbox is server-only and cannot be imported by browser code.');
      }
      export const sandbox = { get: getSandbox };
    `,
    // `void/email` reaches `runtime/env/raw.ts` (`node:async_hooks`), so an
    // unstubbed client import builds with only a warning and white-screens on
    // load. `void/email/testing` needs its own entry (the filter is anchored)
    // because it pulls build-time router code and Node built-ins. Both throw,
    // like `void/sandbox`, so an accidental client send fails legibly instead
    // of silently no-oping.
    'void/email': `
      const serverOnly = (name) => () => {
        throw new Error(name + ' is server-only and cannot be imported by browser code.');
      };
      export const sendEmail = serverOnly('sendEmail');
      export const createEmail = serverOnly('createEmail');
      export const defineEmail = serverOnly('defineEmail');
      export const parseEmail = serverOnly('parseEmail');
      export const replyEmail = serverOnly('replyEmail');
      export const createMessageProxy = serverOnly('createMessageProxy');
    `,
    'void/email/testing': `
      const serverOnly = (name) => () => {
        throw new Error(name + ' is server-only and cannot be imported by browser code.');
      };
      export const createEmailTestHarness = serverOnly('createEmailTestHarness');
      export const createInboundTestHarness = serverOnly('createInboundTestHarness');
    `,
    'void/live': '',
    'void/durable': '',
  };
  const STUB_RESOLVE_FILTER = new RegExp(
    `^(${Object.keys(SERVER_ONLY_STUBS)
      .join('|')
      .replaceAll('/', String.raw`\/`)})$`,
  );
  // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
  const STUB_LOAD_FILTER = new RegExp(`^\\0void-client-stub:`);

  const clientStubsPlugin: Plugin = {
    name: 'void:client-stubs',
    enforce: 'pre',
    resolveId: {
      filter: { id: STUB_RESOLVE_FILTER },
      handler(id) {
        if (this.environment?.name === 'client') {
          if (id === 'void/live' || id === 'void/durable') {
            this.error(
              id === 'void/live'
                ? 'void/live is server-only and cannot be imported by browser code. Import void/live/client instead.'
                : 'void/durable is server-only and cannot be imported by browser code.',
            );
          }
          return STUB_PREFIX + id;
        }
      },
    },
    load: {
      filter: { id: STUB_LOAD_FILTER },
      handler(id) {
        return SERVER_ONLY_STUBS[id.slice(STUB_PREFIX.length)] ?? 'export default {};';
      },
    },
  };

  return clientStubsPlugin;
}
