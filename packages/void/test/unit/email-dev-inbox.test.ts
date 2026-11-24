/**
 * In `void dev`, `sendEmail` runs in workerd while the inbox lives in the Vite
 * (Node) process, so these tests drive the wire boundary: the capture POST reaches
 * the real dev-inbox middleware through a fake `ASSETS` fetcher.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { shouldInjectEmailDevInboxVar } from '../../src/plugin-binding-utils.ts';
import { emailDevInboxPlugin } from '../../src/plugin-email-dev-inbox.ts';
import {
  captureMessage,
  clearDevBuffer,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_URL,
  DEV_INBOX_ENV_VAR,
  DEV_INBOX_MAX_CAPTURE_BYTES,
  DEV_INBOX_TOKEN_ENV_VAR,
  DEV_INBOX_TOKEN_HEADER,
  DEV_INBOX_TOKEN_QUERY,
  hasActiveSink,
  listDevMessages,
  parseCapturedMessage,
  pushToDevBuffer,
  serializeCapturedMessage,
  type CapturedMessage,
} from '../../src/runtime/email/dev-inbox.ts';
import { sendEmail } from '../../src/runtime/email/index.ts';
import {
  buildMime,
  MAX_ADDRESS_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  normalizeEmail,
} from '../../src/runtime/email/mime.ts';
import { withRuntimeEnv } from '../../src/runtime/env/runtime.ts';

/** The per-project dev-trigger token `voidPlugin()` hands the plugin. */
const TOKEN = 'dev-token-test';

/** The worker env `mergeBindings` produces under `void dev`: binding var + token var. */
function devEnv(assets: unknown, bindingName = 'ASSETS'): Record<string, unknown> {
  return {
    [DEV_INBOX_ENV_VAR]: bindingName,
    [DEV_INBOX_TOKEN_ENV_VAR]: TOKEN,
    [bindingName]: assets,
  };
}

/** A request that presents the token the way curl and the worker do. */
function authed(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set(DEV_INBOX_TOKEN_HEADER, TOKEN);
  return new Request(url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// A minimal connect-style middleware stack, so the plugin's real
// `configureServer` handler runs against real Node req/res objects.
// ---------------------------------------------------------------------------

type NodeHandler = (req: unknown, res: unknown, next: () => void) => void;

interface FakeServer {
  dispatch(request: Request): Promise<Response>;
}

function createFakeViteServer(): FakeServer {
  const stack: Array<{ route: string; handle: NodeHandler }> = [];
  const server = {
    config: { command: 'serve' as const },
    httpServer: undefined,
    middlewares: {
      use(route: string | NodeHandler, handle?: NodeHandler) {
        if (typeof route === 'function') {
          stack.push({ route: '/', handle: route });
        } else {
          stack.push({ route, handle: handle as NodeHandler });
        }
      },
    },
  };

  const plugin = emailDevInboxPlugin({ devTriggerToken: TOKEN });
  const configureServer = plugin.configureServer as (this: unknown, s: unknown) => void;
  configureServer.call(plugin, server);

  return {
    async dispatch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const entry = stack.find(
        (s) => url.pathname === s.route || url.pathname.startsWith(`${s.route}/`),
      );
      if (!entry) {
        return new Response('no middleware', { status: 404 });
      }
      // connect strips the mounted prefix from req.url.
      const rest = url.pathname.slice(entry.route.length) || '/';
      const bodyBytes = new Uint8Array(await request.arrayBuffer());

      const req = Readable.from(
        bodyBytes.byteLength > 0 ? [Buffer.from(bodyBytes)] : [],
      ) as Readable & {
        url: string;
        method: string;
        headers: Record<string, string>;
      };
      req.url = rest + url.search;
      req.method = request.method;
      req.headers = Object.fromEntries(request.headers.entries());

      return await new Promise<Response>((resolve) => {
        let status = 200;
        let headers: Record<string, string> = {};
        const chunks: Array<Buffer> = [];
        const res = {
          writeHead(code: number, h?: Record<string, string>) {
            status = code;
            if (h) {
              headers = { ...headers, ...h };
            }
            return res;
          },
          setHeader(k: string, v: string) {
            headers[k] = v;
          },
          end(chunk?: Buffer | string) {
            if (chunk) {
              chunks.push(Buffer.from(chunk));
            }
            // A WHATWG Response rejects a body on 204/304, which the plugin's
            // DELETE answers with; node:http has no such rule.
            const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status, headers }));
          },
        };
        entry.handle(req, res, () => {
          resolve(new Response('next()', { status: 404 }));
        });
      });
    },
  };
}

/**
 * Stand-in for the dev `env.ASSETS` binding. In a real `void dev` this is a
 * miniflare service binding whose implementation is the Vite dev server's Node
 * middleware stack; here it is the same middleware stack, reached over a real
 * Request/Response pair.
 */
function fakeAssetsBinding(server: FakeServer): {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  return {
    calls,
    async fetch(req, init) {
      const request = typeof req === 'string' ? new Request(req, init) : req;
      calls.push({ url: request.url, method: request.method });
      return server.dispatch(request);
    },
  };
}

function subjectsInListHtml(html: string): Array<string> {
  return [...html.matchAll(/<a href="\/__void\/inbox\/[^"]+">([^<]*)<\/a>/g)].map((m) => m[1]);
}

function hrefsInHtml(html: string): Array<string> {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

beforeEach(() => {
  clearDevBuffer();
});
afterEach(() => {
  clearDevBuffer();
});

describe('dev inbox capture wire format', () => {
  it('round-trips a captured message through JSON', () => {
    const original: CapturedMessage = {
      id: 'dev_abc',
      capturedAt: 1234,
      raw: new Uint8Array([0, 1, 2, 250, 255]),
      messageId: '<mid@x>',
      from: { email: 'a@x.dev', name: 'A' },
      to: [{ email: 'b@y.dev' }],
      cc: [],
      bcc: [],
      subject: 'hi',
      text: 'body',
      headers: { 'X-Custom': '1' },
      attachments: [
        { filename: 'a.txt', contentType: 'text/plain', size: 3, disposition: 'attachment' },
      ],
    };
    const parsed = parseCapturedMessage(JSON.parse(serializeCapturedMessage(original)));
    expect(parsed).toBeDefined();
    expect(parsed?.id).toBe('dev_abc');
    expect(parsed?.subject).toBe('hi');
    expect([...(parsed?.raw ?? [])]).toEqual([0, 1, 2, 250, 255]);
    expect(parsed?.attachments[0].filename).toBe('a.txt');
    expect(parsed?.headers['X-Custom']).toBe('1');
  });

  it('rejects a malformed payload instead of throwing', () => {
    expect(parseCapturedMessage(null)).toBeUndefined();
    expect(parseCapturedMessage({ id: 1 })).toBeUndefined();
    expect(parseCapturedMessage({ id: 'x', raw: 'not-base64!!!', to: 'nope' })).toBeUndefined();
  });
});

/** Serialized capture size of a message, alongside the MIME it was built from. */
async function serializedSizeOf(
  opts: Parameters<typeof normalizeEmail>[0],
): Promise<{ mimeBytes: number; jsonBytes: number }> {
  const normalized = await normalizeEmail(opts);
  const { raw, messageId } = buildMime(normalized);
  const json = serializeCapturedMessage(captureMessage(normalized, raw, messageId));
  return { mimeBytes: raw.byteLength, jsonBytes: Buffer.byteLength(json, 'utf8') };
}

describe('dev inbox capture cap (sized for the serialized capture)', () => {
  // A control byte is `=01` in the quoted-printable MIME but `\u0001` in the
  // JSON text, so this legal message serializes past three MIME budgets.
  it('captures a legal message whose serialized capture exceeds three MIME budgets', async () => {
    const text = '\x01'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3.15));
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'control-heavy', text }),
    );
    expect(result).toMatchObject({ ok: true });
    const [message] = listDevMessages();
    expect(message.subject).toBe('control-heavy');
    expect(message.raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(message.text).toBe(text);
    // ASCII JSON, so its length is its byte size.
    expect(serializeCapturedMessage(message).length).toBeGreaterThan(3 * MAX_MESSAGE_BYTES);
  });

  // The ratio is per octet, so checking the real serializer at a small scale
  // holds at any size.
  it('covers base64 raw (4/3) plus caller strings at their worst JSON expansion (3.75x)', async () => {
    const worstExpansion = 6 / 1.6;
    const framing = 1024;
    const bound =
      (4 / 3 + worstExpansion) * MAX_MESSAGE_BYTES + MAX_RECIPIENTS * MAX_ADDRESS_LENGTH + framing;
    expect(DEV_INBOX_MAX_CAPTURE_BYTES).toBeGreaterThan(bound);

    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's' };
    const control = '\x01'.repeat(30_000);
    const shapes: Array<[string, Parameters<typeof normalizeEmail>[0]]> = [
      // encoded-word header: base64 plus framing (1.6) in the MIME, 6 in JSON — 3.75x
      ['control subject', { ...base, subject: control, text: 't' }],
      ['control display name', { ...base, to: [{ email: 'b@y.dev', name: control }], text: 't' }],
      [
        'control custom header value',
        { ...base, headers: { 'X-Note': control.slice(0, 8192) }, text: 't' },
      ],
      // body: `=01` (3) in the MIME, `\u0001` (6) in JSON — 2x
      ['control text', { ...base, text: control }],
      // body, 7bit path: CRLF (2) in the MIME, `\r\n` (4) in JSON — exactly 2x
      ['crlf text', { ...base, text: '\r\n'.repeat(30_000) }],
      // body, quoted-printable path: a mid-line HTAB is 1 octet, `\t` in JSON is 2 — 2x
      ['tab text', { ...base, text: '\t'.repeat(30_000) }],
      // custom header names: printable ASCII, `"` is 1 in the MIME and 2 in JSON — 2x
      [
        'quote header names',
        {
          ...base,
          text: 't',
          headers: Object.fromEntries(
            Array.from({ length: 12 }, (_, i) => [`${'"'.repeat(900)}${i}`, 'v']),
          ),
        },
      ],
    ];
    for (const [label, opts] of shapes) {
      const { mimeBytes, jsonBytes } = await serializedSizeOf(opts);
      expect(mimeBytes, label).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(jsonBytes, label).toBeLessThanOrEqual((4 / 3 + worstExpansion) * mimeBytes + framing);
    }
  });
});

describe('sendEmail -> dev inbox (cross-process transport)', () => {
  it('POSTs the captured message to the dev inbox when no in-process sink exists', async () => {
    // This is the shape workerd sees during `void dev`: the Node-side sink
    // registry is unreachable, so hasActiveSink() is false.
    expect(hasActiveSink()).toBe(false);

    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);

    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({
        from: 'Acme <hello@acme.dev>',
        to: 'user@example.com',
        subject: 'Cross-process hello',
        text: 'Hi there',
        html: '<p>Hi there</p>',
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toHaveLength(1);
      expect(result.ids[0].recipient).toBe('user@example.com');
      expect(result.ids[0].messageId).toMatch(/^dev_/);
    }

    expect(assets.calls).toEqual([
      { url: `http://localhost${DEV_INBOX_CAPTURE_URL}`, method: 'POST' },
    ]);

    // ...and the Node-side buffer that `/__void/inbox` renders now has it.
    const messages = listDevMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('Cross-process hello');
    expect(messages[0].from.email).toBe('hello@acme.dev');
    expect(messages[0].to[0].email).toBe('user@example.com');
    expect(messages[0].html).toBe('<p>Hi there</p>');
    expect(new TextDecoder().decode(messages[0].raw)).toContain('Subject: Cross-process hello');

    const listed = await server.dispatch(authed('http://localhost/__void/inbox'));
    expect(subjectsInListHtml(await listed.text())).toContain('Cross-process hello');
  });

  // The cross-process capture answers with the same `ids` the in-process
  // sink does — one per unique address, lowercased, as production sends —
  // while the buffered message the inbox renders keeps every field as given.
  it('reports one id per unique address while the buffered message keeps the fields', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv(devEnv(assets), () =>
      sendEmail({
        from: 'a@x.dev',
        to: ['A@x.dev'],
        cc: ['a@x.dev'],
        bcc: ['Bob <B@x.dev>', 'b@x.dev'],
        subject: 'dedup-check',
        text: 't',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids.map((d) => d.recipient)).toEqual(['a@x.dev', 'b@x.dev']);
    }
    const [message] = listDevMessages();
    expect(message.to).toEqual([{ email: 'A@x.dev' }]);
    expect(message.cc).toEqual([{ email: 'a@x.dev' }]);
    expect(message.bcc).toEqual([{ email: 'B@x.dev', name: 'Bob' }, { email: 'b@x.dev' }]);
  });

  it('reports an honest error when the dev inbox is unreachable — no hang, no crash', async () => {
    const broken = {
      async fetch() {
        throw new Error('socket hang up');
      },
    };
    const result = await withRuntimeEnv(devEnv(broken), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toContain('/__void/inbox');
    }
  });

  it('does not mistake a non-inbox 200 (a real asset response) for a capture', async () => {
    const assetOnly = {
      async fetch() {
        return new Response('<!DOCTYPE html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    };
    const result = await withRuntimeEnv(devEnv(assetOnly), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
    }
    expect(listDevMessages()).toHaveLength(0);
  });

  it('falls back to the proxy path when the dev-inbox var is absent (production shape)', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv({ ASSETS: assets }, () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('BINDING_MISSING');
    }
    expect(assets.calls).toHaveLength(0);
    expect(listDevMessages()).toHaveLength(0);
  });

  it('uses the binding name the var names, not a hardcoded ASSETS', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    await withRuntimeEnv(devEnv(assets, 'STATIC_FILES'), () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'named-binding', text: 't' }),
    );
    expect(assets.calls).toHaveLength(1);
    expect(listDevMessages()[0].subject).toBe('named-binding');
  });
});

function seeded(): CapturedMessage {
  return {
    id: 'dev_seeded',
    capturedAt: Date.now(),
    raw: new TextEncoder().encode('Subject: seeded\r\nBcc: hidden@bcc.dev\r\n\r\nbody'),
    messageId: '<seeded@x>',
    from: { email: 'a@x.dev' },
    to: [{ email: 'b@y.dev' }],
    cc: [],
    bcc: [{ email: 'hidden@bcc.dev' }],
    subject: 'seeded',
    text: 'body',
    headers: {},
    attachments: [],
  };
}

describe('dev inbox auth (dev-trigger token on every route)', () => {
  const captureInit = (): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: serializeCapturedMessage({ ...seeded(), id: 'dev_planted' }),
  });

  it.each([
    ['GET list', 'http://localhost/__void/inbox', {}],
    ['GET detail', 'http://localhost/__void/inbox/dev_seeded', {}],
    ['GET raw', 'http://localhost/__void/inbox/dev_seeded/raw', {}],
    ['DELETE clear', 'http://localhost/__void/inbox', { method: 'DELETE' }],
    ['POST capture', `http://localhost${DEV_INBOX_CAPTURE_URL}`, captureInit()],
  ] as Array<[string, string, RequestInit]>)(
    '%s: 401 without the token, 401 with a wrong one, and nothing happens',
    async (_label, url, init) => {
      const server = createFakeViteServer();
      pushToDevBuffer(seeded());

      const missing = await server.dispatch(new Request(url, init));
      expect(missing.status).toBe(401);
      expect(missing.headers.get(DEV_INBOX_ACK_HEADER)).toBeNull();
      const body = await missing.text();
      expect(body.split('\n')).toHaveLength(1);
      expect(body).toContain(DEV_INBOX_TOKEN_HEADER);
      expect(body).toContain(`?${DEV_INBOX_TOKEN_QUERY}=`);
      expect(body).not.toContain(TOKEN);

      const wrongHeader = await server.dispatch(
        new Request(url, {
          ...init,
          headers: { ...init.headers, [DEV_INBOX_TOKEN_HEADER]: 'nope' },
        }),
      );
      expect(wrongHeader.status).toBe(401);
      const wrongQuery = await server.dispatch(
        new Request(`${url}?${DEV_INBOX_TOKEN_QUERY}=nope`, init),
      );
      expect(wrongQuery.status).toBe(401);
      // A header that is wrong is not rescued by a query that is right — the
      // header is what the worker and curl send, so it is what gets checked.
      const wrongHeaderRightQuery = await server.dispatch(
        new Request(`${url}?${DEV_INBOX_TOKEN_QUERY}=${TOKEN}`, {
          ...init,
          headers: { ...init.headers, [DEV_INBOX_TOKEN_HEADER]: 'nope' },
        }),
      );
      expect(wrongHeaderRightQuery.status).toBe(401);

      // The refusal had no side effect: the seeded message is still the only one.
      expect(listDevMessages().map((m) => m.id)).toEqual(['dev_seeded']);
    },
  );

  it('serves every route with the token in the header (worker, curl)', async () => {
    const server = createFakeViteServer();
    pushToDevBuffer(seeded());

    const list = await server.dispatch(authed('http://localhost/__void/inbox'));
    expect(list.status).toBe(200);
    expect(subjectsInListHtml(await list.text())).toContain('seeded');

    const detail = await server.dispatch(authed('http://localhost/__void/inbox/dev_seeded'));
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('hidden@bcc.dev');

    const raw = await server.dispatch(authed('http://localhost/__void/inbox/dev_seeded/raw'));
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain('Bcc: hidden@bcc.dev');

    const planted = await server.dispatch(
      authed(`http://localhost${DEV_INBOX_CAPTURE_URL}`, captureInit()),
    );
    expect(planted.status).toBe(200);
    expect(planted.headers.get(DEV_INBOX_ACK_HEADER)).toBe(DEV_INBOX_ACK_VALUE);
    expect(listDevMessages().map((m) => m.id)).toEqual(['dev_planted', 'dev_seeded']);

    const cleared = await server.dispatch(
      authed('http://localhost/__void/inbox', { method: 'DELETE' }),
    );
    expect(cleared.status).toBe(204);
    expect(listDevMessages()).toHaveLength(0);
  });

  it('accepts the token as ?token= so the printed URL works in a browser, and keeps the session in its links', async () => {
    const server = createFakeViteServer();
    pushToDevBuffer(seeded());
    const q = `?${DEV_INBOX_TOKEN_QUERY}=${TOKEN}`;

    const list = await server.dispatch(new Request(`http://localhost/__void/inbox${q}`));
    expect(list.status).toBe(200);
    const listHrefs = hrefsInHtml(await list.text());
    expect(listHrefs).toEqual([`/__void/inbox/dev_seeded${q}`, `/__void/inbox/dev_seeded/raw${q}`]);

    const detail = await server.dispatch(
      new Request(`http://localhost/__void/inbox/dev_seeded${q}`),
    );
    expect(detail.status).toBe(200);
    expect(hrefsInHtml(await detail.text())).toEqual([
      `/__void/inbox${q}`,
      `/__void/inbox/dev_seeded/raw${q}`,
    ]);

    const raw = await server.dispatch(
      new Request(`http://localhost/__void/inbox/dev_seeded/raw${q}`),
    );
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('message/rfc822');
  });

  it('sendEmail reports the 401 by name when the worker env lacks the token, and nothing is captured', async () => {
    const server = createFakeViteServer();
    const assets = fakeAssetsBinding(server);
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
      sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'no-token', text: 't' }),
    );
    expect(assets.calls).toHaveLength(1);
    expect(listDevMessages()).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toContain('dev server responded 401');
      expect(result.error.message).toContain(DEV_INBOX_TOKEN_HEADER);
    }
  });

  it('never hangs on a refusal whose body stalls — the excerpt read has its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const stalled = {
        async fetch() {
          // Status arrives, the body never does.
          return new Response(new ReadableStream({ start() {} }), { status: 401 });
        },
      };
      const pending = withRuntimeEnv(devEnv(stalled), () =>
        sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 'stall', text: 't' }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('UPSTREAM_ERROR');
        expect(result.error.message).toContain('dev server responded 401');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints the inbox URL with the token once the dev server is listening', async () => {
    const httpServer = new EventEmitter() as EventEmitter & { address: () => { port: number } };
    httpServer.address = () => ({ port: 5173 });
    const server = { config: { command: 'serve' as const }, httpServer, middlewares: { use() {} } };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const plugin = emailDevInboxPlugin({ devTriggerToken: TOKEN });
      (plugin.configureServer as (this: unknown, s: unknown) => void).call(plugin, server);
      expect(log).not.toHaveBeenCalled();
      httpServer.emit('listening');
      await new Promise((r) => setTimeout(r, 150));
      const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
      expect(output).toContain(
        `Email inbox: http://localhost:5173/__void/inbox?${DEV_INBOX_TOKEN_QUERY}=${TOKEN}`,
      );
    } finally {
      log.mockRestore();
    }
  });
});

describe('shouldInjectEmailDevInboxVar (dev-only gate)', () => {
  it('does not inject when there is no assets binding to loop back through', () => {
    expect(shouldInjectEmailDevInboxVar('dev', true, undefined)).toBe(false);
    expect(shouldInjectEmailDevInboxVar('dev', true, '')).toBe(false);
  });
});

// The buffer lives in the dev server's Node process, so it is bounded by retained bytes.

const MIB = 1024 * 1024;

function capturedOfSize(id: string, rawBytes: number, htmlChars = 0): CapturedMessage {
  return {
    id,
    capturedAt: Date.now(),
    raw: new Uint8Array(rawBytes),
    messageId: `<${id}@x>`,
    from: { email: 'a@x.dev' },
    to: [{ email: 'b@y.dev' }],
    cc: [],
    bcc: [],
    subject: id,
    ...(htmlChars > 0 && { html: 'x'.repeat(htmlChars) }),
    headers: {},
    attachments: [],
  };
}

describe('dev inbox buffer bounds', () => {
  it('evicts on the retained-byte budget well below the count cap', () => {
    // 16 MiB charged per message, so the fifth push crosses the 64 MiB budget.
    for (let i = 1; i <= 5; i++) {
      pushToDevBuffer(capturedOfSize(`msg-${i}`, 8 * MIB, 8 * MIB));
    }
    const retained = listDevMessages();
    expect(retained).toHaveLength(4);
    // listDevMessages() is newest-first: the send that just happened survives,
    // and the oldest is the one that went.
    expect(retained[0].id).toBe('msg-5');
    expect(retained.map((m) => m.id)).not.toContain('msg-1');
  });

  it('keeps the newest message even when it alone exceeds the budget', () => {
    pushToDevBuffer(capturedOfSize('small', 1024));
    pushToDevBuffer(capturedOfSize('huge', 1024, 70 * MIB));
    // A send must always be visible in the inbox, whatever its size.
    const retained = listDevMessages();
    expect(retained).toHaveLength(1);
    expect(retained[0].id).toBe('huge');
  });

  it('resets the byte accounting in clearDevBuffer', () => {
    for (let i = 1; i <= 5; i++) {
      pushToDevBuffer(capturedOfSize(`big-${i}`, 8 * MIB, 8 * MIB));
    }
    clearDevBuffer();
    // A stale counter would leave the buffer permanently over budget, so every
    // later push would evict its predecessor and the inbox would silently show
    // exactly one message.
    for (let i = 1; i <= 3; i++) {
      pushToDevBuffer(capturedOfSize(`small-${i}`, 1024));
    }
    expect(listDevMessages().map((m) => m.id)).toEqual(['small-3', 'small-2', 'small-1']);
  });
});
