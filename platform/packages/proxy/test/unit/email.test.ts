import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `cloudflare:email` is a workerd built-in with no npm shim. The root
// vite.config.ts aliases `cloudflare:workers` to a stub for the same reason;
// until it does the same for `cloudflare:email`, this file registers its own
// mock (vi.mock is hoisted above the import below).
vi.mock('cloudflare:email', () => ({
  EmailMessage: class MockEmailMessage {
    constructor(
      public readonly from: string,
      public readonly to: string,
      public readonly raw: unknown,
    ) {}
  },
}));

const worker = (await import('../../src/index.ts')).default;
const { readMimeFromAddrSpec } = await import('../../src/email.ts');
const { clearProxyTokenStateCache } = await import('../../src/proxy-token.ts');
// The framework's own MIME builder — the ONLY legitimate producer of the
// `mimeBase64` a tenant posts — so the proxy's From pin is checked against
// every `From:` shape it really renders, not against hand-typed lookalikes.
const { buildMime, normalizeEmail } =
  await import('../../../../../packages/void/src/runtime/email/mime.ts');

const JWT_SECRET = 'test-secret-key';
const EMAIL_SIGNING_SECRET = 'test-email-signing-key-independent';
const PROD_DOMAIN = 'mail.void.cloud';
const STAGING_DOMAIN = 'mail.voidcloud.dev';

// --- HMAC helper (mirrors the worker's project token signing) ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function signHmac(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64urlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))),
  );
}

// --- Mock env ---

type MockKv = ReturnType<typeof createMockKv>;

function createMockKv(data: Record<string, string> = {}) {
  const store = new Map(Object.entries(data));
  return {
    store,
    get: vi.fn(async (key: string, _options?: unknown) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, _options?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createMockEnv(
  kv: MockKv,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const actions = new Map<
    string,
    {
      operationId: string;
      digest: string;
      recipients: Array<{
        recipient: string;
        state: string;
        errorCode: string | null;
        providerReference: string | null;
      }>;
    }
  >();
  const apiFetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path.endsWith('/admit')) {
      const key = body.key as string;
      const previous = actions.get(key);
      if (previous && previous.digest !== body.digest) {
        return Response.json({ code: 'CONFLICT' }, { status: 409 });
      }
      if (previous) {
        return Response.json({
          operationId: previous.operationId,
          replay: true,
          recipients: previous.recipients,
        });
      }
      const entry = {
        operationId: `act_${actions.size + 1}`,
        digest: body.digest as string,
        recipients: (body.recipients as Array<string>).map((recipient) => ({
          recipient,
          state: 'reserved',
          errorCode: null,
          providerReference: null,
        })),
      };
      actions.set(key, entry);
      return Response.json({
        operationId: entry.operationId,
        replay: false,
        recipients: entry.recipients,
      });
    }
    const operationId = path.split('/').at(-2)!;
    const entry = [...actions.values()].find((action) => action.operationId === operationId)!;
    if (path.endsWith('/start')) {
      for (const recipient of body.recipients as Array<string>) {
        entry.recipients.find((row) => row.recipient === recipient)!.state = 'attempt_started';
      }
    }
    if (path.endsWith('/finish')) {
      for (const recipient of body.recipients as Array<string>) {
        const row = entry.recipients.find((item) => item.recipient === recipient)!;
        row.state = body.state as string;
        row.errorCode = (body.errorCode as string) ?? null;
        row.providerReference = (body.providerReference as string) ?? null;
      }
    }
    return Response.json({ recipients: entry.recipients });
  });
  return {
    AI: {},
    JWT_SECRET,
    EMAIL_SIGNING_SECRET,
    ROUTING: kv,
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
    API: { fetch: apiFetch },
    DISPATCH: { get: vi.fn(() => ({ email: vi.fn(async () => []) })) },
    SEND_EMAIL: { send: vi.fn(async () => ({ messageId: 'msg_1' })) },
    EMAIL_SENDER_DOMAIN: PROD_DOMAIN,
    ...overrides,
  };
}

const DEFAULT_FROM = `acme+noreply@${PROD_DOMAIN}`;

/** The smallest message `/email/send` accepts for `from`: a matching `From:` and a body. */
function mimeFor(from: string, rest = 'Subject: hi\r\n\r\nhello\r\n'): string {
  return `From: ${from}\r\n${rest}`;
}

/** Minimal base64 of an RFC 5322-ish body — content beyond `From:` is irrelevant here. */
function mimeBase64(body = mimeFor(DEFAULT_FROM)): string {
  let binary = '';
  for (const b of new TextEncoder().encode(body)) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

async function postSend(
  env: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<Response> {
  return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
    new Request('https://email-proxy/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/**
 * A `/email/send` body that passes every gate for `proj_000000000001` / slug `acme`.
 * The MIME `From:` follows the envelope under test, exactly as the framework
 * renders both from one `from.email`; pass `mimeBase64` to diverge them.
 */
async function sendBody(overrides: Record<string, unknown> = {}) {
  const from = typeof overrides.from === 'string' ? overrides.from : DEFAULT_FROM;
  return {
    projectId: 'proj_000000000001',
    aiToken: await signHmac('proj_000000000001', JWT_SECRET),
    from,
    recipients: ['dev@example.com'],
    mimeBase64: mimeBase64(mimeFor(from)),
    requestId: 'req_1',
    ...overrides,
  };
}

/** KV contents that let `proj_000000000001` send to `dev@example.com`. */
function happyPathKv(extra: Record<string, string> = {}) {
  return createMockKv({
    'email-slug:proj_000000000001': 'acme',
    'email-allowlist:proj_000000000001': JSON.stringify(['dev@example.com']),
    ...extra,
  });
}

/** KV keys read outside the project token check. */
function nonAuthKvReads(kv: MockKv): Array<string> {
  return kv.get.mock.calls.map((c) => c[0]).filter((key) => !key.startsWith('proxy-token:'));
}

// The floor cache lives for the whole isolate; start every test cold.
beforeEach(clearProxyTokenStateCache);

// --- wrangler.jsonc ---

/**
 * Strip `//` line comments and trailing commas so JSON.parse can read the
 * JSONC config. String-aware so a `//` inside a value is preserved.
 */
function parseJsonc(source: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++;
      }
      out += '\n';
      continue;
    }
    out += ch;
  }
  return JSON.parse(out.replaceAll(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

const wranglerConfig = parseJsonc(
  readFileSync(fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)), 'utf8'),
);

describe('proxy wrangler config', () => {
  // Wrangler does NOT inherit `send_email` or `vars` into a named env, and
  // `deploy` runs `--env production`. A binding declared only at the top
  // level (or only in staging) ships a production proxy where
  // `env.SEND_EMAIL` is undefined — which staging never reproduces.
  const scopes: Array<[string, Record<string, unknown>]> = [
    ['top level', wranglerConfig],
    ['env.production', (wranglerConfig.env as Record<string, Record<string, unknown>>).production],
    ['env.staging', (wranglerConfig.env as Record<string, Record<string, unknown>>).staging],
  ];

  for (const [name, scope] of scopes) {
    it(`declares the SEND_EMAIL binding in ${name}`, () => {
      expect(scope, `${name} scope is missing from wrangler.jsonc`).toBeDefined();
      expect(scope.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    });

    it(`declares EMAIL_SENDER_DOMAIN in ${name}`, () => {
      const vars = scope.vars as Record<string, string> | undefined;
      expect(vars?.EMAIL_SENDER_DOMAIN).toBeTruthy();
    });
  }

  it('points staging at its own mail zone', () => {
    const env = wranglerConfig.env as Record<string, Record<string, unknown>>;
    expect((wranglerConfig.vars as Record<string, string>).EMAIL_SENDER_DOMAIN).toBe(PROD_DOMAIN);
    expect((env.production.vars as Record<string, string>).EMAIL_SENDER_DOMAIN).toBe(PROD_DOMAIN);
    expect((env.staging.vars as Record<string, string>).EMAIL_SENDER_DOMAIN).toBe(STAGING_DOMAIN);
  });

  it('keeps each API and public gateway environment on the same email routing identity', () => {
    const config = parseJsonc(
      readFileSync(new URL('../../../api/wrangler.jsonc', import.meta.url), 'utf8'),
    );
    const gatewayConfig = parseJsonc(
      readFileSync(new URL('../../../email-gateway/wrangler.jsonc', import.meta.url), 'utf8'),
    );
    const env = config.env as Record<string, Record<string, unknown>>;
    const proxyEnv = wranglerConfig.env as Record<string, Record<string, unknown>>;
    const gatewayEnv = gatewayConfig.env as Record<string, Record<string, unknown>>;
    for (const [name, scope, proxy, gateway] of [
      ['top level', config, wranglerConfig, gatewayConfig],
      ['env.production', env.production, proxyEnv.production, gatewayEnv.production],
      ['env.staging', env.staging, proxyEnv.staging, gatewayEnv.staging],
    ] as const) {
      const vars = scope.vars as Record<string, string>;
      const domain = vars.EMAIL_SENDER_DOMAIN;
      const binding = (
        scope.send_email as Array<{
          name?: string;
          allowed_sender_addresses?: Array<string>;
        }>
      ).find((entry) => entry.name === 'EMAIL');
      expect(domain, `${name} EMAIL_SENDER_DOMAIN`).toBeTruthy();
      expect(binding?.allowed_sender_addresses, `${name} EMAIL binding`).toContain(
        `noreply@${domain}`,
      );
      expect(gateway.workers_dev, `${name} public email gateway`).toBe(true);
      const proxyVars = proxy.vars as Record<string, string>;
      const gatewayVars = gateway.vars as Record<string, string>;
      expect(proxyVars.EMAIL_SENDER_DOMAIN, `${name} proxy sender domain`).toBe(domain);
      expect(gatewayVars.EMAIL_SENDER_DOMAIN, `${name} gateway sender domain`).toBe(domain);
      for (const key of ['EMAIL_SHARED_ACCOUNT_ID', 'EMAIL_SHARED_ZONE_ID']) {
        expect(vars[key], `${name} API ${key}`).toMatch(/^[0-9a-f]{32}$/);
        expect(gatewayVars[key], `${name} gateway ${key}`).toBe(vars[key]);
      }
      expect(vars.EMAIL_GATEWAY_ORIGIN, `${name} confirmation gateway origin`).toBe(
        `https://${String(gateway.name)}.voidzer0.workers.dev`,
      );
      expect(vars.EMAIL_SHARED_INGRESS_NAME).toBe(gateway.name);
      expect(gatewayVars.EMAIL_SHARED_INGRESS_NAME).toBe(gateway.name);
      expect(proxy.services).toContainEqual({ binding: 'API', service: scope.name });
      expect(gateway.services).toContainEqual({ binding: 'API', service: scope.name });
      if (name !== 'top level') {
        expect(scope.secrets).toEqual({ required: ['EMAIL_SIGNING_SECRET'] });
        expect(proxy.secrets).toEqual({ required: ['EMAIL_SIGNING_SECRET'] });
        expect(gateway.secrets).toEqual({ required: ['EMAIL_SIGNING_SECRET'] });
      }
    }
    const productionVars = env.production.vars as Record<string, string>;
    const stagingVars = env.staging.vars as Record<string, string>;
    expect(stagingVars.EMAIL_SHARED_ACCOUNT_ID).toBe(productionVars.EMAIL_SHARED_ACCOUNT_ID);
    expect(stagingVars.EMAIL_SHARED_ZONE_ID).not.toBe(productionVars.EMAIL_SHARED_ZONE_ID);
    expect(stagingVars.EMAIL_SENDER_DOMAIN).not.toBe(productionVars.EMAIL_SENDER_DOMAIN);
  });
});

describe('POST /email/send — sender domain', () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = happyPathKv();
  });

  it('sends when `from` is on the configured domain', async () => {
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'msg_1', state: 'provider_accepted' }],
      operationId: 'act_1',
    });
  });

  it('rejects a production `from` when the worker is configured for staging', async () => {
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: STAGING_DOMAIN });
    const res = await postSend(env, await sendBody());
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UPSTREAM_ERROR');
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('accepts a staging `from` when the worker is configured for staging', async () => {
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: STAGING_DOMAIN });
    const res = await postSend(env, await sendBody({ from: `acme+noreply@${STAGING_DOMAIN}` }));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('escapes the domain so a `.` cannot match an arbitrary character', async () => {
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody({ from: 'acme+noreply@mailxvoid.cloud' }));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('fails closed — and burns no quota — when EMAIL_SENDER_DOMAIN is unset', async () => {
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: undefined });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UPSTREAM_ERROR');
    expect(kv.put).not.toHaveBeenCalled();
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('fails closed — and burns no quota — when the SEND_EMAIL binding is missing', async () => {
    const env = createMockEnv(kv, { SEND_EMAIL: undefined });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe('POST /email/send — platform capability', () => {
  let kv: MockKv;

  beforeEach(() => {
    kv = happyPathKv();
  });

  it('returns the standard 501 when the platform has no email module', async () => {
    // The bindings are configured on purpose: the gate must refuse on the
    // capability alone, not on the missing configuration an installed
    // platform happens to have.
    const env = createMockEnv(kv, { PLATFORM_CAPABILITIES: JSON.stringify({ email: false }) });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: 'platform capability unavailable',
      capability: 'email',
      message: 'This Void platform does not enable email.',
    });
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect(nonAuthKvReads(kv)).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('still authenticates before checking email capabilities', async () => {
    const env = createMockEnv(kv, { PLATFORM_CAPABILITIES: JSON.stringify({ email: false }) });
    const res = await postSend(env, await sendBody({ aiToken: 'nope' }));
    expect(res.status).toBe(403);
  });

  it.each([
    ['email: true', JSON.stringify({ email: true })],
    ['unset (hosted platform)', undefined],
  ])('sends when the capability is %s', async (_, capabilities) => {
    const env = createMockEnv(kv, { PLATFORM_CAPABILITIES: capabilities });
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledTimes(1);
  });
});

async function drainStream(raw: unknown): Promise<Uint8Array> {
  if (typeof raw === 'string') {
    return new TextEncoder().encode(raw);
  }
  if (!(raw instanceof ReadableStream)) {
    return new Uint8Array(0);
  }
  const reader = (raw as ReadableStream<Uint8Array>).getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface SenderCall {
  from: string;
  to: string;
  bytes: Uint8Array;
}

/** Recording `send_email` binding: captures from/to and the delivered bytes. */
function createSender(
  options: {
    fail?: (to: string) => Error | undefined;
    result?: (n: number) => unknown;
    onSend?: (to: string) => void;
  } = {},
) {
  const calls: Array<SenderCall> = [];
  const send = vi.fn(async (msg: { from: string; to: string; raw: unknown }) => {
    const bytes = await drainStream(msg.raw);
    calls.push({ from: msg.from, to: msg.to, bytes });
    options.onSend?.(msg.to);
    const failure = options.fail?.(msg.to);
    if (failure) {
      throw failure;
    }
    return options.result ? options.result(calls.length) : { messageId: `cf-msg-${calls.length}` };
  });
  return {
    calls,
    send,
    binding: { send },
    texts: (): Array<string> => calls.map((c) => new TextDecoder().decode(c.bytes)),
    recipients: (): Array<string> => calls.map((c) => c.to),
  };
}

function monthKeyFor(projectId: string): string {
  const now = new Date();
  return `email-sent:${projectId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface SendResponseBody {
  ok: boolean;
  error?: { code: string; message: string };
  ids?: Array<{ recipient: string; messageId: string }>;
  deliveries?: Array<{
    recipient: string;
    ok: boolean;
    state?: string;
    messageId?: string;
    error?: { code: string };
  }>;
}

async function readSend(res: Response): Promise<SendResponseBody> {
  return (await res.json()) as SendResponseBody;
}

describe('POST /email/send — request validation', () => {
  it.each([
    ['from', { from: undefined }],
    ['mimeBase64', { mimeBase64: undefined }],
    ['recipients', { recipients: undefined }],
  ])('rejects a body missing `%s` with 400', async (_field, override) => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody(override));
    expect(res.status).toBe(400);
    expect((await readSend(res)).error?.code).toBe('UPSTREAM_ERROR');
  });

  it('rejects a non-array `recipients` with 400', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ recipients: 'dev@example.com' }));
    expect(res.status).toBe(400);
  });

  it.each([
    ['an empty array', []],
    ['only non-string entries', [123, null, { to: 'dev@example.com' }]],
    ['only blank strings', ['', '   ']],
  ])('answers INVALID_TO when recipients are %s', async (_label, recipients) => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ recipients }));
    expect(res.status).toBe(200);
    expect((await readSend(res)).error?.code).toBe('INVALID_TO');
  });

  it('dedupes + normalizes recipients before quota math and fan-out', async () => {
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({
        recipients: ['Dev@Example.com', 'dev@example.com', '  DEV@EXAMPLE.COM  '],
      }),
    );
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients()).toEqual(['dev@example.com']);
    expect(kv.store.get(monthKeyFor('proj_000000000001'))).toBeUndefined();
  });

  it('shares one request deadline across admission and binding fan-out', async () => {
    vi.useFakeTimers();
    try {
      const recipients = ['first@example.com', 'second@example.com', 'third@example.com'];
      const kv = happyPathKv({
        'email-allowlist:proj_000000000001': JSON.stringify(recipients),
      });
      let markFirst!: () => void;
      let markSecond!: () => void;
      const firstSubmitted = new Promise<void>((resolve) => {
        markFirst = resolve;
      });
      const secondSubmitted = new Promise<void>((resolve) => {
        markSecond = resolve;
      });
      let submissions = 0;
      const send = vi.fn(() => {
        submissions++;
        (submissions === 1 ? markFirst : markSecond)();
        return new Promise(() => {});
      });
      const env = createMockEnv(kv, { SEND_EMAIL: { send } });
      const apiFetch = (env.API as { fetch: ReturnType<typeof vi.fn<typeof fetch>> }).fetch;
      const normalFetch = apiFetch.getMockImplementation()!;
      let markAdmissionStarted!: () => void;
      const admissionStarted = new Promise<void>((resolve) => {
        markAdmissionStarted = resolve;
      });
      apiFetch.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/admit')) {
          markAdmissionStarted();
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
        return normalFetch(url, init);
      });
      const pending = postSend(env, await sendBody({ recipients }));

      await admissionStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      await firstSubmitted;
      await vi.advanceTimersByTimeAsync(30_000);
      await secondSubmitted;
      await vi.advanceTimersByTimeAsync(5000);
      const body = await readSend(await pending);

      expect(send).toHaveBeenCalledTimes(2);
      expect(body.deliveries?.map((delivery) => delivery.state)).toEqual([
        'outcome_unknown',
        'outcome_unknown',
        'cancelled',
      ]);
      const finishes = (env.API as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls
        .filter(([url]) => String(url).endsWith('/finish'))
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { state: string });
      expect(finishes.map((entry) => entry.state)).toEqual([
        'outcome_unknown',
        'outcome_unknown',
        'cancelled',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects invalid base64 with 400 MIME_ERROR', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ mimeBase64: '!!!not-base64!!!' }));
    expect(res.status).toBe(400);
    expect((await readSend(res)).error?.code).toBe('MIME_ERROR');
  });

  it('rejects over 16 KiB of custom MIME headers before admission or provider send', async () => {
    const env = createMockEnv(happyPathKv());
    const raw = mimeFor(DEFAULT_FROM, `X-Large: ${'a'.repeat(16 * 1024)}\r\n\r\nbody`);
    const res = await postSend(env, await sendBody({ mimeBase64: mimeBase64(raw) }));
    expect(res.status).toBe(413);
    expect((await readSend(res)).error?.code).toBe('MIME_ERROR');
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
    expect((env.API as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });

  it('rejects a bad project HMAC with 403 before any handler work', async () => {
    const kv = happyPathKv();
    const env = createMockEnv(kv);
    const res = await postSend(env, await sendBody({ aiToken: 'not-a-valid-hmac' }));
    expect(res.status).toBe(403);
    expect(kv.get).not.toHaveBeenCalled();
    expect((env.SEND_EMAIL as { send: ReturnType<typeof vi.fn> }).send).not.toHaveBeenCalled();
  });

  it('rejects a missing project token with 400', async () => {
    const env = createMockEnv(happyPathKv());
    const res = await postSend(env, await sendBody({ aiToken: undefined }));
    expect(res.status).toBe(400);
  });

  // Authenticated tenants still need a work bound before per-recipient processing.
  it('rejects a recipient list one over the cap, before any KV read', async () => {
    const MAX_RECIPIENTS = 50;
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({
        recipients: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `dev${i}@example.com`),
      }),
    );

    expect(res.status).toBe(413);
    const body = await readSend(res);
    expect(body.error?.code).toBe('INVALID_TO');
    // Refused above the normalization loop, so not one per-recipient
    // delivery object was built.
    expect(body.deliveries).toBeUndefined();
    expect(nonAuthKvReads(kv)).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it('still sends a recipient list sitting exactly at the cap', async () => {
    const MAX_RECIPIENTS = 50;
    const recipients = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `dev${i}@example.com`);
    const kv = createMockKv({
      'email-slug:proj_000000000001': 'acme',
      'email-allowlist:proj_000000000001': JSON.stringify(recipients),
      // Raised so the burst + monthly gates cannot answer first and hide
      // whether the cap itself let the list through.
      'email-burst-limit:proj_000000000001': '1000',
      'email-limit:proj_000000000001': '1000',
    });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients }));

    expect((await readSend(res)).ok).toBe(true);
    expect(sender.recipients()).toEqual(recipients);
    expect(kv.store.get(monthKeyFor('proj_000000000001'))).toBeUndefined();
  });

  // Bound each address before normalization copies it.
  it('rejects an over-long recipient before normalization allocates', async () => {
    const MAX_RECIPIENT_LENGTH = 320;
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(
      env,
      await sendBody({ recipients: [`${'a'.repeat(MAX_RECIPIENT_LENGTH)}@example.com`] }),
    );

    expect(res.status).toBe(413);
    const body = await readSend(res);
    expect(body.error?.code).toBe('INVALID_TO');
    expect(body.deliveries).toBeUndefined();
    expect(nonAuthKvReads(kv)).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  // The sender is one string, but `from.toLowerCase()` copies it whole and
  // a valid-shaped sender (`<slug>+<unbounded tag>@<domain>`) is then echoed
  // verbatim into the MIME `From:` refusal and serialized into the
  // response — all above the quota gates. The bound has to come first.
  it('rejects an over-long sender before the slug read, the copy, or the echo', async () => {
    const MAX_SENDER_LENGTH = 320;
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    // Shaped to pass the strict regex AND the slug pin, so the only thing
    // that can refuse it is the length bound.
    const tag = 'a'.repeat(MAX_SENDER_LENGTH);
    const from = `acme+${tag}@${PROD_DOMAIN}`;
    const res = await postSend(
      env,
      // A MIME with no `From:` at all: without the bound this request would
      // reach the addr-spec refusal that interpolates the whole sender.
      await sendBody({ from, mimeBase64: mimeBase64('Subject: hi\r\n\r\nhello\r\n') }),
    );

    expect(res.status).toBe(413);
    const body = await readSend(res);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).not.toContain(tag);
    expect(body.deliveries).toBeUndefined();
    expect(nonAuthKvReads(kv)).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it('still sends from a sender sitting exactly at the cap', async () => {
    const MAX_SENDER_LENGTH = 320;
    const prefix = 'acme+';
    const suffix = `@${PROD_DOMAIN}`;
    const from = `${prefix}${'a'.repeat(MAX_SENDER_LENGTH - prefix.length - suffix.length)}${suffix}`;
    expect(from).toHaveLength(MAX_SENDER_LENGTH);
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));

    expect(res.status).toBe(200);
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].from).toBe(from);
  });
});

describe('POST /email/send — MIME From pin (what the recipient sees)', () => {
  /** A tenant that owns `acme` and wants to look like `victim`. */
  function twoTenantsKv() {
    return happyPathKv({ 'email-slug:proj_2': 'victim' });
  }

  async function sendMime(mime: string, overrides: Record<string, unknown> = {}) {
    const kv = twoTenantsKv();
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ mimeBase64: mimeBase64(mime), ...overrides }));
    return { res, body: await readSend(res), sender, kv };
  }

  it("refuses a MIME From naming another project's sender under an authorized envelope", async () => {
    // The envelope `acme+noreply@` passes the slug pin; the bytes the
    // recipient's client renders as the sender say `victim+noreply@`.
    const { res, body, sender, kv } = await sendMime(mimeFor(`victim+noreply@${PROD_DOMAIN}`));
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
    // Refused before the suspension, allowlist and quota reads.
    expect(nonAuthKvReads(kv)).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it.each([
    ['a display name in front of the victim', `"Acme Billing" <victim+noreply@${PROD_DOMAIN}>`],
    [
      'the victim in the phrase, the envelope in brackets',
      `victim@${PROD_DOMAIN} <${DEFAULT_FROM}>`,
    ],
    ['a mailbox list, envelope first', `${DEFAULT_FROM}, victim@${PROD_DOMAIN}`],
    ['a mailbox list, victim first', `victim@${PROD_DOMAIN}, ${DEFAULT_FROM}`],
    ['a group', `Acme: victim@${PROD_DOMAIN};`],
    ['two angle-addrs', `<victim@${PROD_DOMAIN}> <${DEFAULT_FROM}>`],
    ['a comment carrying the victim', `${DEFAULT_FROM} (victim@${PROD_DOMAIN})`],
    ['trailing text after the angle-addr', `<${DEFAULT_FROM}> victim@${PROD_DOMAIN}`],
    ['an unterminated quoted-string', `"Acme <${DEFAULT_FROM}>`],
    ['an empty angle-addr', '<>'],
    ['an empty value', ''],
    ['whitespace inside the brackets', `< ${DEFAULT_FROM} >`],
  ])(
    'refuses a From that is not a single mailbox naming the envelope (%s)',
    async (_label, value) => {
      const { body, sender } = await sendMime(mimeFor(value));
      expect(body.ok, `${JSON.stringify(value)} should have been refused`).toBe(false);
      expect(body.error?.code).toBe('INVALID_FROM');
      expect(sender.calls).toHaveLength(0);
    },
  );

  it('refuses a From that only case-folds INTO the envelope sender', async () => {
    // U+212A KELVIN SIGN lower-cases to `k`. Without the printable-ASCII
    // check the compare would pass and CF would receive a From the envelope
    // check never saw.
    const from = `acme+link@${PROD_DOMAIN}`;
    const { body, sender } = await sendMime(mimeFor(`acme+lin\u212A@${PROD_DOMAIN}`), { from });
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it('refuses a message with no From header at all', async () => {
    const { body, sender } = await sendMime('Subject: hi\r\n\r\nhello\r\n');
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).toContain('no From header');
    expect(sender.calls).toHaveLength(0);
  });

  it.each([
    ['plain duplicates', `From: ${DEFAULT_FROM}\r\nFrom: victim@${PROD_DOMAIN}\r\n`],
    [
      'the second one spelled `From :`',
      `From: ${DEFAULT_FROM}\r\nFrom : victim@${PROD_DOMAIN}\r\n`,
    ],
    ['the second one upper-cased', `From: ${DEFAULT_FROM}\r\nFROM: victim@${PROD_DOMAIN}\r\n`],
    [
      'the second one after an unrelated header',
      `From: ${DEFAULT_FROM}\r\nSubject: x\r\nFrom: victim@${PROD_DOMAIN}\r\n`,
    ],
    [
      'the second one hidden behind a bare LF',
      `From: ${DEFAULT_FROM}\nFrom: victim@${PROD_DOMAIN}\r\n`,
    ],
  ])('refuses two From headers (%s)', async (_label, headers) => {
    const { body, sender } = await sendMime(`${headers}Subject: hi\r\n\r\nhello\r\n`);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(body.error?.message).toContain('more than one From');
    expect(sender.calls).toHaveLength(0);
  });

  it('refuses a bare CR that a LF-splitting parser would read as a second line', async () => {
    const { body, sender } = await sendMime(
      `From: ${DEFAULT_FROM}\rFrom: victim@${PROD_DOMAIN}\r\nSubject: hi\r\n\r\nhello\r\n`,
    );
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  it('does not read a From inside a MIME part as the message From', async () => {
    // The scan ends at the first empty line; a part's own `From:` is body.
    const { body } = await sendMime(
      `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nFrom: victim@${PROD_DOMAIN}\r\n\r\nx\r\n--b--\r\n`,
    );
    expect(body.ok).toBe(false);
    expect(body.error?.message).toContain('no From header');
  });

  it.each([
    ['ASCII case differences', `ACME+NoReply@${PROD_DOMAIN.toUpperCase()}`],
    ['a display name', `Acme Billing <${DEFAULT_FROM}>`],
    ['a quoted display name with a comma', `"Smith, John" <${DEFAULT_FROM}>`],
    [
      'a quoted display name with escaped quotes and brackets',
      `"Acme \\"<Billing>\\" \\\\ Co" <${DEFAULT_FROM}>`,
    ],
    ['an encoded-word display name', `=?UTF-8?B?SsO8cmdlbg==?= <${DEFAULT_FROM}>`],
    [
      'a quoted display name that holds the victim (handed back: display names are not inspected)',
      `"victim@${PROD_DOMAIN}" <${DEFAULT_FROM}>`,
    ],
    ['a folded value', `Acme\r\n Billing\r\n <${DEFAULT_FROM}>`],
    ['a tab-folded value', `Acme\r\n\tBilling <${DEFAULT_FROM}>`],
    ['surrounding whitespace', `   ${DEFAULT_FROM}   `],
    ['the header name upper-cased', undefined],
  ])('accepts a single mailbox naming the envelope (%s)', async (_label, value) => {
    const mime =
      value === undefined
        ? `FROM: ${DEFAULT_FROM}\r\nSubject: hi\r\n\r\nhello\r\n`
        : mimeFor(value);
    const { body, sender } = await sendMime(mime);
    expect(body.ok, `${JSON.stringify(value)} should have been accepted`).toBe(true);
    expect(sender.calls).toHaveLength(1);
    // The pin inspects; it never rewrites. CF receives the tenant's bytes.
    expect(sender.texts()[0]).toBe(mime);
  });

  it('accepts a message whose header block runs to the end of the bytes', async () => {
    const { body } = await sendMime(`From: ${DEFAULT_FROM}\r\nSubject: hi`);
    expect(body.ok).toBe(true);
  });

  it('accepts a +tag envelope whose From carries the same tag', async () => {
    const from = `acme+billing@${PROD_DOMAIN}`;
    const { body } = await sendMime(mimeFor(from), { from });
    expect(body.ok).toBe(true);
  });

  it('refuses a +tag envelope whose From carries a different tag', async () => {
    const { body, sender } = await sendMime(mimeFor(`acme+billing@${PROD_DOMAIN}`), {
      from: `acme+support@${PROD_DOMAIN}`,
    });
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('INVALID_FROM');
    expect(sender.calls).toHaveLength(0);
  });

  describe("every From shape the framework's buildMime renders is accepted", () => {
    // 200 CJK characters: 600 UTF-8 bytes → 14 encoded-words → folded over
    // many continuation lines, with `<addr>` alone on the last one.
    const longName = '東京都千代田区'.repeat(29).slice(0, 200);
    it.each([
      ['a bare address', { email: DEFAULT_FROM }],
      ['a plain display name', { email: DEFAULT_FROM, name: 'Acme Billing' }],
      ['a quoted display name', { email: DEFAULT_FROM, name: 'Smith, John' }],
      [
        'a display name with quotes and backslashes',
        { email: DEFAULT_FROM, name: String.raw`Acme "Co" \ Ltd <x>` },
      ],
      ['a short non-ASCII display name', { email: DEFAULT_FROM, name: 'Jürgen Müller' }],
      ['a 200-character CJK display name (folded)', { email: DEFAULT_FROM, name: longName }],
      ['an upper-case address', { email: `ACME+NoReply@${PROD_DOMAIN}` }],
    ])('%s', async (_label, from) => {
      const email = await normalizeEmail({
        from,
        to: 'dev@example.com',
        subject: 'hi',
        text: 'hello',
      });
      const { raw } = buildMime(email);
      const parsed = readMimeFromAddrSpec(raw);
      expect(parsed).toEqual({ ok: true, addrSpec: from.email });

      // And through the route, as the framework would post it.
      const kv = twoTenantsKv();
      const sender = createSender();
      const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
      let binary = '';
      for (const b of raw) {
        binary += String.fromCharCode(b);
      }
      const res = await postSend(
        env,
        await sendBody({ from: from.email, mimeBase64: btoa(binary) }),
      );
      expect((await readSend(res)).ok).toBe(true);
      expect(sender.calls).toHaveLength(1);
    });

    it('the CJK fixture really is folded across continuation lines', async () => {
      const email = await normalizeEmail({
        from: { email: DEFAULT_FROM, name: longName },
        to: 'dev@example.com',
        subject: 'hi',
        text: 'hello',
      });
      const text = new TextDecoder().decode(buildMime(email).raw);
      const fromHeader = text.slice(text.indexOf('From:'), text.indexOf('\r\nTo:'));
      expect(fromHeader.split('\r\n ').length).toBeGreaterThan(5);
      expect(fromHeader.endsWith(`<${DEFAULT_FROM}>`)).toBe(true);
    });
  });

  describe('the scan keeps nothing per line', () => {
    const MAX_MIME_BYTES = 5 * 1024 * 1024;

    /** `From: <value>` folded over as many `<fold>` continuations as fit in 5 MiB. */
    function foldedToTheCap(value: string, fold: string): { raw: Uint8Array; lines: number } {
      const head = new TextEncoder().encode(`From: ${value}\r\n`);
      const cont = new TextEncoder().encode(fold);
      const lines = Math.floor((MAX_MIME_BYTES - head.byteLength) / cont.byteLength);
      const raw = new Uint8Array(head.byteLength + lines * cont.byteLength);
      raw.set(head, 0);
      for (let i = 0, at = head.byteLength; i < lines; i++, at += cont.byteLength) {
        raw.set(cont, at);
      }
      return { raw, lines };
    }

    it.each([
      ['CRLF', ' \r\n', 1_747_623],
      ['bare LF', ' \n', 2_621_434],
    ])(
      'unfolds a From spread over millions of %s continuations in bounded heap',
      (_label, fold, expectedLines) => {
        // Every continuation is one space: a value that is the address
        // followed by millions of spaces, which trim away, so the scan
        // still has to visit every line. `MAX_MIME_BYTES` bounds bytes, not
        // lines, and one retained view per line was ~125 bytes of heap
        // each — 437 MB for the CRLF case and 694 MB for bare LF, measured,
        // against a 128 MB isolate that every tenant shares; the same bytes
        // with no `From:` cost 1 MB. The offsets-only scan measured 0.2 MB
        // of heap and 85 ms (CRLF) / 111 ms (LF) on the same input; the
        // ceilings below leave room for the test runner, not for a
        // per-line allocation.
        const { raw, lines } = foldedToTheCap('a@b', fold);
        expect(lines).toBe(expectedLines);
        expect(raw.byteLength).toBeLessThanOrEqual(MAX_MIME_BYTES);
        const heapBefore = process.memoryUsage().heapUsed;
        const started = performance.now();
        const parsed = readMimeFromAddrSpec(raw);
        const elapsed = performance.now() - started;
        const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
        expect(parsed).toEqual({ ok: true, addrSpec: 'a@b' });
        expect(elapsed).toBeLessThan(2000);
        expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
      },
    );

    it('refuses the same shape through /email/send before any KV read past the slug', async () => {
      // The pathological fold names a sender that is not the envelope, so
      // the pin refuses it — after unfolding, not by a size gate: the
      // scan's bound is the message itself, which `MAX_MIME_BYTES` already
      // holds in memory. The base64 is built with Buffer: 10 MiB of
      // per-byte string concatenation is the test's own cost, not the
      // proxy's.
      const { raw } = foldedToTheCap(`victim+noreply@${PROD_DOMAIN}`, ' \r\n');
      const kv = twoTenantsKv();
      const sender = createSender();
      const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
      const started = performance.now();
      const res = await postSend(
        env,
        await sendBody({ mimeBase64: Buffer.from(raw).toString('base64') }),
      );
      expect(performance.now() - started).toBeLessThan(5000);
      const body = await readSend(res);
      expect(res.status).toBe(403);
      expect(body.error?.code).toBe('INVALID_FROM');
      expect(body.error?.message).toContain('does not match the envelope sender');
      expect(sender.calls).toHaveLength(0);
      expect(nonAuthKvReads(kv)).toEqual([]);
    });

    it.each([
      [
        'a continuation after the NEXT header belongs to that header',
        `From: ${DEFAULT_FROM}\r\nSubject: a\r\n b\r\n\r\nx`,
      ],
      [
        'a continuation before the From belongs to the header before it',
        `Subject: a\r\n b\r\nFrom: ${DEFAULT_FROM}\r\n\r\nx`,
      ],
      ['a whitespace-only continuation line', `From: ${DEFAULT_FROM}\r\n \r\nSubject: a\r\n\r\nx`],
      ['the From on the last line, unterminated', `Subject: a\r\nFrom: ${DEFAULT_FROM}`],
      ['a fold on the last line, unterminated', `From: Acme\r\n <${DEFAULT_FROM}>`],
    ])('tracks the From by offsets: %s', (_label, mime) => {
      expect(readMimeFromAddrSpec(new TextEncoder().encode(mime))).toEqual({
        ok: true,
        addrSpec: DEFAULT_FROM,
      });
    });

    it('still refuses a bare CR on a line after the one From', () => {
      // The lazy CR search restarts past each terminator; a bare CR inside
      // a LATER header must still fail the scan (an LF-splitting parser
      // would read what follows it as part of that header).
      const mime = `From: ${DEFAULT_FROM}\r\nSubject: a\rFrom: victim@${PROD_DOMAIN}\r\n\r\nx`;
      expect(readMimeFromAddrSpec(new TextEncoder().encode(mime))).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    it('accepts a From value of any length the framework renders (no value bound)', async () => {
      // `buildMime` bounds the ADDRESS at 320 (`MAX_ADDRESS_LENGTH`) and
      // deliberately leaves the display name unbounded — it is encoded and
      // folded at any length (mime.ts). A 100k-character CJK name renders as
      // a ~486 KB `From:` over ~6.7k continuation lines, and the proxy must
      // keep accepting what the framework's own preflight accepts: the fix
      // for the per-line cost was to stop retaining lines, not to cap the
      // value, and a cap would be a contract change owned by the framework.
      const name = '東京都千代田区'.repeat(15_000).slice(0, 100_000);
      const email = await normalizeEmail({
        from: { email: DEFAULT_FROM, name },
        to: 'dev@example.com',
        subject: 'hi',
        text: 'hello',
      });
      const { raw } = buildMime(email);
      const text = new TextDecoder().decode(raw);
      const fromHeader = text.slice(text.indexOf('From:'), text.indexOf('\r\nTo:'));
      expect(fromHeader.length).toBeGreaterThan(400_000);
      expect(fromHeader.split('\r\n ').length).toBeGreaterThan(6000);
      expect(readMimeFromAddrSpec(raw)).toEqual({ ok: true, addrSpec: DEFAULT_FROM });
    });
  });
});

describe('POST /email/send — per-recipient fan-out', () => {
  it('gives every recipient its own message with a FRESH body stream', async () => {
    // A regression that hoisted `bytesToStream(raw)` out of the loop would
    // still record three sends — but recipients 2 and 3 would receive an
    // already-drained (empty) stream. Assert the delivered BYTES.
    const mime = mimeFor(DEFAULT_FROM, 'Subject: fan-out\r\n\r\nbody bytes\r\n');
    const recipients = ['a@example.com', 'b@example.com', 'c@example.com'];
    const kv = happyPathKv({ 'email-allowlist:proj_000000000001': JSON.stringify(recipients) });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients, mimeBase64: mimeBase64(mime) }));

    const body = await readSend(res);
    expect(body.ok).toBe(true);
    expect(sender.recipients()).toEqual(recipients);
    expect(sender.texts()).toEqual([mime, mime, mime]);
    // One envelope sender for the whole batch; one message per recipient.
    expect(new Set(sender.calls.map((c) => c.from)).size).toBe(1);
    expect(body.ids).toEqual([
      { recipient: 'a@example.com', messageId: 'cf-msg-1', state: 'provider_accepted' },
      { recipient: 'b@example.com', messageId: 'cf-msg-2', state: 'provider_accepted' },
      { recipient: 'c@example.com', messageId: 'cf-msg-3', state: 'provider_accepted' },
    ]);
  });

  it('surfaces an empty messageId rather than crashing when CF returns none', async () => {
    const sender = createSender({ result: () => ({}) });
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody());
    const body = await readSend(res);
    expect(body.ok).toBe(true);
    expect(body.ids).toEqual([
      { recipient: 'dev@example.com', messageId: '', state: 'provider_accepted' },
    ]);
  });

  it('records per-recipient outcomes when one send fails mid-batch', async () => {
    const recipients = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
    const kv = happyPathKv({ 'email-allowlist:proj_000000000001': JSON.stringify(recipients) });
    const sender = createSender({
      fail: (to) => (to === 'bob@example.com' ? new Error('upstream blew up') : undefined),
    });
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ recipients }));

    expect(res.status).toBe(200);
    const body = await readSend(res);
    expect(body.ok).toBe(false);
    expect(body.deliveries).toHaveLength(3);
    expect(body.deliveries?.find((d) => d.recipient === 'alice@example.com')?.ok).toBe(true);
    expect(body.deliveries?.find((d) => d.recipient === 'carol@example.com')?.ok).toBe(true);
    const bob = body.deliveries?.find((d) => d.recipient === 'bob@example.com');
    expect(bob?.ok).toBe(false);
    expect(bob?.error?.code).toBe('OUTCOME_UNKNOWN');
    // One failure does not abort the batch.
    expect(sender.calls).toHaveLength(3);
  });
});

describe('POST /email/send — sender domain is configuration, never a baked-in default', () => {
  it('accepts multiple safe plus-tag segments on a shared sender', async () => {
    const from = `acme+support+forward.run@${PROD_DOMAIN}`;
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from }));

    expect((await readSend(res)).ok).toBe(true);
    expect(sender.calls).toMatchObject([{ from }]);
  });

  it.each([
    ['unset', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a non-string', 123],
  ])('fails closed with 502 when EMAIL_SENDER_DOMAIN is %s', async (_label, value) => {
    // The old build hard-coded `mail.void.cloud`. A fallback here would let a
    // misconfigured staging proxy accept — and send — production senders.
    const kv = happyPathKv();
    const sender = createSender();
    const env = createMockEnv(kv, { EMAIL_SENDER_DOMAIN: value, SEND_EMAIL: sender.binding });
    const res = await postSend(env, await sendBody({ from: `acme@${PROD_DOMAIN}` }));
    expect(res.status).toBe(502);
    expect((await readSend(res)).error?.message).toContain('domain');
    expect(sender.calls).toHaveLength(0);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('trims and lowercases the configured domain before pinning the regex', async () => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), {
      EMAIL_SENDER_DOMAIN: `  MAIL.VOID.CLOUD  `,
      SEND_EMAIL: sender.binding,
    });
    const res = await postSend(env, await sendBody({ from: `acme@${PROD_DOMAIN}` }));
    expect((await readSend(res)).ok).toBe(true);
    expect(sender.calls).toHaveLength(1);
  });
});

describe('POST /email/send — the envelope handed to CF', () => {
  /**
   * The regex is tested against `from.toLowerCase()` but `EmailMessage`
   * receives the ORIGINAL string, so the validated value and the transmitted
   * value are not the same bytes. That divergence is only safe while nothing
   * can fold INTO the allowed set from outside it — no Unicode code point
   * lower-cases to CR, LF or NUL, so header injection stays closed. This test
   * pins the invariant that actually matters, whichever way the divergence is
   * resolved: nothing with a control character reaches the shared sender.
   *
   * (U+212A KELVIN SIGN does fold to `k`, so a slug containing `k` currently
   * lets a non-ASCII byte through into the envelope — reported separately,
   * deliberately not asserted here so a tightening fix does not read as a
   * regression.)
   */
  it.each([
    ['ASCII upper case', `ACME@${PROD_DOMAIN}`, 'acme'],
    ['a code point that case-folds into the slug', `acmeK@${PROD_DOMAIN}`, 'acmek'],
    ['a carriage return', `acme\r\nX-Bcc: attacker@evil.com@${PROD_DOMAIN}`, 'acme'],
    ['a null byte', `acme\u0000@${PROD_DOMAIN}`, 'acme'],
  ])('never hands a control character to the send binding (%s)', async (_label, from, slug) => {
    const kv = happyPathKv({ 'email-slug:proj_000000000001': slug });
    const sender = createSender();
    const env = createMockEnv(kv, { SEND_EMAIL: sender.binding });
    await postSend(env, await sendBody({ from }));
    for (const call of sender.calls) {
      // oxlint-disable-next-line no-control-regex
      expect(new RegExp(String.raw`[\u0000-\u001f\u007f]`).test(call.from)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// `requestId` is a caller-supplied log correlation id. The framework sends 16
// hex chars, but a hand-built tenant worker holding a valid project HMAC can
// send any string, and `logSend` used to interpolate it verbatim into one
// `[email-log]` line per delivery — so a `\n` in it forged a second line under
// any project id, and a multi-megabyte one was repeated per recipient into
// the shared proxy log stream. It is bounded and sanitized once at intake.
// ---------------------------------------------------------------------------

describe('POST /email/send — requestId is bounded and sanitized at intake', () => {
  // oxlint-disable-next-line no-control-regex
  const CONTROL = new RegExp(String.raw`[\u0000-\u001f\u007f]`);

  it('a 5 MB control-heavy requestId still sends, and logs a short clean id', async () => {
    // Alternating LF / letter: one regex match per LF, the shape that made
    // the old replace-then-slice order materialize one part per match
    // (measured: +170 MB on this input, past the 128 MB isolate ceiling).
    const requestId = `\na`.repeat((5 * 1024 * 1024) / 2);
    const forged = `req_1\n[email-log] proj_victim x@example.com sent forged @0`;
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const t0 = performance.now();
      const res = await postSend(env, await sendBody({ requestId }));
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      expect((await readSend(res)).ok).toBe(true);
      expect(sender.calls).toHaveLength(1);
      const lines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[email-log] '));
      expect(lines).toHaveLength(1);
      // The id is sliced to 128 code units and each LF becomes one space,
      // so the whole line is the fixed fields plus at most 128 chars of id.
      const fixed = `[email-log] proj_000000000001  dev@example.com sent cf-msg-1 @${Date.now()}`
        .length;
      expect(lines[0]!.length).toBeLessThanOrEqual(fixed + 128);
      expect(lines[0]).not.toMatch(CONTROL);
      expect(lines[0]!.split(' ')[1]).toBe('proj_000000000001');
      // Generous: the slice-first path is ~0 ms; the JSON body is ~5 MB.
      expect(elapsed).toBeLessThan(500);

      // And a newline can no longer forge a second `[email-log]` line.
      logSpy.mockClear();
      const res2 = await postSend(env, await sendBody({ requestId: forged }));
      expect(res2.status).toBe(200);
      const lines2 = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[email-log] '));
      expect(lines2).toHaveLength(1);
      expect(lines2[0]).not.toMatch(CONTROL);
      expect(lines2[0]).not.toContain('\n[email-log]');
      expect(lines2[0]!.split(' ')[1]).toBe('proj_000000000001');
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each([
    ['missing', undefined],
    ['not a string', 42],
  ])('a requestId that is %s logs as `unknown`', async (_label, requestId) => {
    const sender = createSender();
    const env = createMockEnv(happyPathKv(), { SEND_EMAIL: sender.binding });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await postSend(env, await sendBody({ requestId }));
      expect(res.status).toBe(200);
      const lines = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[email-log] '));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.split(' ')[2]).toBe('unknown');
    } finally {
      logSpy.mockRestore();
    }
  });
});
