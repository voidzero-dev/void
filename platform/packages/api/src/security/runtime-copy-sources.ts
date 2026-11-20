/**
 * Fixed code the runtime copy runs (design doc 0095, M30; spike S13). Plain JavaScript
 * text: the copy's guard and entry modules, and the copy sandbox Worker.
 *
 *   copy script = __void_copy_entry.mjs (main)
 *                   ├─ imports __void_copy_guard.mjs first: global fetch → sandbox, WebSocket throws
 *                   ├─ answers /__void_copy/* (ready check, test rows)
 *                   └─ everything else → the deployed app's own entry, unchanged
 *
 * The guard runs in the app's own isolate, so it stops the app's own calls; it is not a
 * wall against code written to escape it. The dispatch namespace's outbound Worker (the
 * sandbox) is the second layer for the Worker itself; a Durable Object's fetch does not
 * pass through an outbound Worker (S13), so the guard is what covers those.
 */

/** Every global `fetch()` goes to the sandbox through a service binding; `new WebSocket` throws. */
export const COPY_GUARD_MODULE = String.raw`
import { env } from 'cloudflare:workers';

const blocked = () => new Response('blocked by the void security copy', { status: 403, headers: { 'x-void-copy-blocked': '1' } });
async function guardedFetch(input, init) {
  const request = new Request(input, init);
  const egress = env.__VOID_COPY_EGRESS;
  if (!egress) return blocked();
  const headers = new Headers(request.headers);
  headers.set('x-void-copy-guard', '1');
  return egress.fetch(new Request(request, { headers }));
}
class BlockedWebSocket {
  constructor() { throw new Error('outbound WebSocket blocked by the void security copy'); }
}
for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) BlockedWebSocket[name] = value;
for (const [name, value] of Object.entries({ fetch: guardedFetch, WebSocket: BlockedWebSocket })) {
  Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
}
`;

export const COPY_GUARD_MODULE_NAME = '__void_copy_guard.mjs';
export const COPY_ENTRY_MODULE_NAME = '__void_copy_entry.mjs';

/** Largest test-data request body and answer the entry handles. */
const CONTROL_BODY_LIMIT = 64 * 1024;
const CONTROL_ROWS_LIMIT = 100;

/**
 * The copy's main module. It loads the guard, re-exports the app's named exports (its
 * Durable Object classes), and answers the copy control routes before the app:
 *
 *   GET  /__void_copy/ready                      {"ready":true}
 *   POST /__void_copy/d1  {binding, sql, params}  runs one statement on an empty copy D1
 *   POST /__void_copy/kv  {binding, key, value}   writes one key into an empty copy KV
 *
 * Only the scan's own container reaches the copy, and the stores are the copy's own empty
 * ones (`__VOID_COPY_STORES` lists them), so the test data never touches the live app.
 */
export function copyEntryModule(appMainModule: string): string {
  const app = `./${appMainModule}`;
  return String.raw`
import './${COPY_GUARD_MODULE_NAME}';
import App from ${JSON.stringify(app)};
export * from ${JSON.stringify(app)};

const LIMIT = ${CONTROL_BODY_LIMIT};
const ROWS = ${CONTROL_ROWS_LIMIT};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function stores(env) {
  try {
    const value = JSON.parse(env.__VOID_COPY_STORES || '{}');
    return { d1: Array.isArray(value.d1) ? value.d1 : [], kv: Array.isArray(value.kv) ? value.kv : [] };
  } catch {
    return { d1: [], kv: [] };
  }
}

async function body(request) {
  const text = await request.text();
  if (text.length > LIMIT) throw new Error('body is larger than ' + LIMIT + ' bytes');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object');
  return value;
}

async function control(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/__void_copy/')) return null;
  const path = url.pathname;
  if (path === '/__void_copy/ready' && request.method === 'GET') {
    return json({ ready: true, stores: stores(env) });
  }
  try {
    if (path === '/__void_copy/d1' && request.method === 'POST') {
      const input = await body(request);
      if (!stores(env).d1.includes(input.binding)) return json({ error: 'not a D1 binding of this copy' }, 400);
      if (typeof input.sql !== 'string' || input.sql.length === 0) return json({ error: 'sql must be a string' }, 400);
      const params = Array.isArray(input.params) ? input.params : [];
      const result = await env[input.binding].prepare(input.sql).bind(...params).all();
      return json({ results: (result.results || []).slice(0, ROWS), meta: { changes: result.meta && result.meta.changes } });
    }
    if (path === '/__void_copy/kv' && request.method === 'POST') {
      const input = await body(request);
      if (!stores(env).kv.includes(input.binding)) return json({ error: 'not a KV binding of this copy' }, 400);
      if (typeof input.key !== 'string' || typeof input.value !== 'string') return json({ error: 'key and value must be strings' }, 400);
      await env[input.binding].put(input.key, input.value);
      return json({ ok: true });
    }
  } catch (error) {
    return json({ error: String((error && error.message) || error).slice(0, 500) }, 400);
  }
  return json({ error: 'unknown copy route' }, 404);
}

let Entry;
if (typeof App === 'function') {
  Entry = class extends App {
    async fetch(request) {
      const answer = await control(request, this.env);
      return answer || super.fetch(request);
    }
  };
} else {
  Entry = {
    ...App,
    async fetch(request, env, ctx) {
      const answer = await control(request, env);
      return answer || App.fetch(request, env, ctx);
    },
  };
}
export default Entry;
`;
}

/**
 * The copy sandbox: an account Worker with no workers.dev route. It is the copies'
 * outbound Worker (every global fetch of a copy ends here: 403) and holds the stubs the
 * copies' platform and queue bindings point at. It keeps no data.
 */
export const COPY_SANDBOX_SOURCE = String.raw`
import { WorkerEntrypoint } from 'cloudflare:workers';

const blocked = () => new Response('blocked by the void security copy sandbox', { status: 403, headers: { 'x-void-copy-blocked': '1' } });

/** The platform proxy binding of a copy (AI, email, revalidation): a fixed stub answer. */
export class PlatformStub extends WorkerEntrypoint {
  async fetch() {
    return new Response(JSON.stringify({ error: 'stubbed in the void security copy', stub: true }), { status: 503, headers: { 'content-type': 'application/json', 'x-void-copy-stub': '1' } });
  }
}

/** A queue producer binding of a copy: messages are accepted and dropped. */
export class QueueStub extends WorkerEntrypoint {
  async send() {}
  async sendBatch() {}
}

export default {
  async fetch() {
    return blocked();
  },
};
`;
