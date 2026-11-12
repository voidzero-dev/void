import { signEmailReceipt } from '@void/platform/email-protocol';
import { deriveAiUsageTag, deriveProxyToken } from '@voidcloud/api/proxy-token';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vite-plus/test';
import worker from '../../src/index.ts';
import { PLATFORM_DISABLED_KEY } from '../../src/platform-lifecycle.ts';
import { clearProxyTokenStateCache } from '../../src/proxy-token.ts';
import { readRequestJson } from '../../src/request-body.ts';

const JWT_SECRET = 'test-secret-key';
const EMAIL_SIGNING_SECRET = 'test-email-signing-key-independent';

// --- JWT helper (mirrors the worker's HMAC-SHA256 signing) ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signJwt(
  payload: {
    sub: string;
    login: string;
    aud?: string;
    exp?: number;
    project?: string;
    build?: string;
    credential?: string;
  },
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64urlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64urlEncode(
    encoder.encode(
      JSON.stringify({
        ...payload,
        aud: payload.aud ?? 'api',
        iat: Math.floor(Date.now() / 1000),
        exp: payload.exp ?? Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`)),
  );
  return `${header}.${body}.${base64urlEncode(sig)}`;
}

// --- HMAC helper (mirrors the worker's project token signing) ---

async function signAiToken(projectId: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(projectId)));
  return base64urlEncode(sig);
}

// --- Mock env factory ---

type MockAi = {
  run: ReturnType<typeof vi.fn>;
  models: ReturnType<typeof vi.fn>;
  toMarkdown: ReturnType<typeof vi.fn>;
  gateway: ReturnType<typeof vi.fn>;
};

function createMockKv(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

/**
 * User-to-project deploy-access map used by the mock API. The endpoint retains
 * its legacy verify-owner URL while the API now resolves roles dynamically.
 */
const DEFAULT_OWNERSHIP: Record<string, Array<string>> = {
  user_1: ['proj_000000000001', 'proj_000000000042', 'proj_000000000099', 'proj_000000000000'],
};

type ApiFetchHandler = (input: string | Request, init?: RequestInit) => Promise<Response>;

function createMockApi(
  handler?: ApiFetchHandler,
  ownership: Record<string, Array<string>> = DEFAULT_OWNERSHIP,
) {
  // Fetcher.fetch() is called as (url: string, init: RequestInit), not (Request).
  const defaultHandler = async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);

    // Handle live project deploy-access requests.
    if (url.includes('/internal/verify-owner/')) {
      const projectId = url.split('/').pop()!;
      const parsed = typeof body === 'string' ? JSON.parse(body) : {};
      const userProjects = ownership[parsed.userId] ?? [];
      if (userProjects.includes(projectId)) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/internal/ai-logging/')) {
      return Response.json({ mode: 'inherit' });
    }

    // Default: generic success response
    return new Response(JSON.stringify({ purged: 1 }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    fetch: handler
      ? async (input: string | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.url;
          if (url.includes('/internal/ai-logging/')) {
            return Response.json({ mode: 'inherit' });
          }
          return handler(input, init);
        }
      : defaultHandler,
  };
}

function createEnv(
  aiOverrides?: Partial<MockAi>,
  kvData?: Record<string, string>,
  apiOverride?: { fetch: ReturnType<typeof vi.fn> | ((req: Request) => Promise<Response>) },
  platformInstallationId?: string,
  healthProbeToken?: string,
  trafficState?: string,
) {
  return {
    AI: {
      run: vi.fn(async () => ({ response: 'hello' })),
      models: vi.fn(async () => [{ name: 'model-a' }]),
      toMarkdown: vi.fn(async () => ({ markdown: '# Hi' })),
      gateway: vi.fn(() => ({ run: vi.fn(async () => new Response('{}')) })),
      ...aiOverrides,
    },
    JWT_SECRET,
    EMAIL_SIGNING_SECRET,
    ROUTING: createMockKv(kvData),
    CF_ACCOUNT_ID: 'test-account-id',
    CF_API_TOKEN: 'test-api-token',
    API: apiOverride ?? createMockApi(),
    DISPATCH: {
      get: vi.fn(() => {
        throw new Error('worker not found');
      }),
    },
    ...(platformInstallationId ? { PLATFORM_INSTALLATION_ID: platformInstallationId } : {}),
    ...(healthProbeToken ? { PLATFORM_HEALTH_PROBE_TOKEN: healthProbeToken } : {}),
    ...(trafficState ? { PLATFORM_TRAFFIC_STATE: trafficState } : {}),
  };
}

function post(path: string, body: unknown, headers?: Record<string, string>): Request {
  // Service-binding callers use bare hosts and no header; HTTPS callers send Bearer.
  const origin =
    headers?.authorization === undefined ? 'https://proxy' : 'https://proxy.void.cloud';
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// --- Tests ---

describe('proxy worker', () => {
  let validToken: string;
  const aiTokens: Record<string, string> = {};
  const usageTags: Record<string, string> = {};

  beforeEach(clearProxyTokenStateCache);

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    validToken = await signJwt({ sub: 'user_1', login: 'testuser' }, JWT_SECRET);
    for (const pid of [
      'proj_000000000001',
      'proj_000000000042',
      'proj_000000000099',
      'proj_000000000000',
    ]) {
      aiTokens[pid] = await signAiToken(pid, JWT_SECRET);
      usageTags[pid] = await deriveAiUsageTag(JWT_SECRET, pid);
    }
  });

  it('rejects every request while the platform is disabled', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.void.cloud/health'),
      createEnv(undefined, { [PLATFORM_DISABLED_KEY]: 'disabled' }, undefined, 'installation-id'),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Platform disabled' });
  });

  it('fails closed in staging even when routing KV is missing the disabled value', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.void.cloud/health'),
      createEnv(undefined, undefined, undefined, 'installation-id', undefined, 'staging'),
    );
    expect(res.status).toBe(503);
  });

  it('fails closed during a sandbox drain even when routing KV is missing the disabled value', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.void.cloud/health'),
      createEnv(undefined, undefined, undefined, 'installation-id', undefined, 'sandbox-drain'),
    );
    expect(res.status).toBe(503);
  });

  it('admits installer health checks during a sandbox drain', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.void.cloud/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(undefined, undefined, undefined, 'installation-id', 'probe-token', 'sandbox-drain'),
    );
    expect(res.status).toBe(200);
  });

  it('admits installer health checks while public traffic is disabled', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.void.cloud/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(
        undefined,
        { [PLATFORM_DISABLED_KEY]: 'disabled' },
        undefined,
        'installation-id',
        'probe-token',
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('rejects the legacy public installer header while disabled', async () => {
    const res = await worker.fetch(
      new Request('https://proxy.void.cloud/health', {
        headers: { 'X-Health-Check': 'void-admin' },
      }),
      createEnv(
        undefined,
        { [PLATFORM_DISABLED_KEY]: 'disabled' },
        undefined,
        'installation-id',
        'probe-token',
      ),
    );
    expect(res.status).toBe(503);
  });

  it('does not read the lifecycle gate for hosted Void Cloud', async () => {
    const env = createEnv();
    const res = await worker.fetch(new Request('https://proxy.void.cloud/health'), env);
    expect(res.status).toBe(200);
    expect(env.ROUTING.get).not.toHaveBeenCalled();
  });

  describe('CORS', () => {
    it('returns 204 with CORS headers on OPTIONS', async () => {
      const req = new Request('https://proxy.void.cloud/ai/run', { method: 'OPTIONS' });
      const res = await worker.fetch(req, createEnv());

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    });
  });

  describe('method validation', () => {
    it('rejects non-POST requests with 405', async () => {
      const req = new Request('https://proxy.void.cloud/ai/run', { method: 'GET' });
      const res = await worker.fetch(req, createEnv());

      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: 'method not allowed' });
    });
  });

  describe('non-email request body bounds', () => {
    it('rejects an oversized declared body before reading or authenticating it', async () => {
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      });
      const cancel = vi.fn();
      const request = new Request('https://ai-proxy/ai/models', {
        method: 'POST',
        headers: { 'content-length': String(1024 * 1024 + 1) },
        body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
        duplex: 'half',
      } as RequestInit);

      const response = await worker.fetch(request, createEnv());
      expect(response.status).toBe(413);
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    });

    it('enforces the byte cap when Content-Length is missing', async () => {
      const body = new TextEncoder().encode(JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }));
      const request = new Request('https://ai-proxy/ai/models', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      expect(request.headers.get('content-length')).toBeNull();

      const response = await worker.fetch(request, createEnv());
      expect(response.status).toBe(413);
    });

    it('ends a stalled unauthenticated body at the read deadline', async () => {
      vi.useFakeTimers();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let cancelled = false;
      const request = new Request('https://ai-proxy/ai/models', {
        method: 'POST',
        body: new ReadableStream({
          start(value) {
            controller = value;
          },
          cancel() {
            cancelled = true;
          },
        }),
        duplex: 'half',
      } as RequestInit);
      let status: number | undefined;
      const response = worker.fetch(request, createEnv()).then((value) => {
        status = value.status;
      });

      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(status).toBe(408);
      } finally {
        if (!cancelled) {
          controller?.close();
        }
        await response;
      }
    });

    it('allows a larger remote write body through to authentication', async () => {
      const response = await worker.fetch(
        post('/r2/put', {
          projectId: 'proj_000000000001',
          aiToken: 'invalid',
          pad: 'x'.repeat(1024 * 1024),
        }),
        createEnv(),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('email receipt verification', () => {
    it('initiates cancellation without awaiting an uncooperative request stream', async () => {
      vi.useFakeTimers();
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
          return new Promise<void>(() => {});
        },
      });
      const request = new Request('https://proxy.void.cloud/email/verify-receipt', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit);
      const outcome = readRequestJson(request, 2 * 1024).then(
        () => 'resolved',
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await outcome).toBeInstanceOf(Error);
      expect(String(await outcome)).toContain('timeout');
      expect(cancelled).toBe(1);
    });

    it('ends a stalled unauthenticated request body at five seconds', async () => {
      vi.useFakeTimers();
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      const request = new Request('https://proxy.void.cloud/email/verify-receipt', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit);
      const response = worker.fetch(request, createEnv());

      await vi.advanceTimersByTimeAsync(5_000);

      expect((await response).status).toBe(400);
    });

    it('rejects invalid UTF-8 before receipt authentication', async () => {
      const response = await worker.fetch(
        new Request('https://proxy.void.cloud/email/verify-receipt', {
          method: 'POST',
          headers: { 'content-length': '1' },
          body: new Uint8Array([0xff]),
        }),
        createEnv(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ valid: false });
    });

    it('rejects a mismatched declared request length', async () => {
      const response = await worker.fetch(
        new Request('https://proxy.void.cloud/email/verify-receipt', {
          method: 'POST',
          headers: { 'content-length': '3' },
          body: '{}',
        }),
        createEnv(),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ valid: false });
    });
  });

  describe('email send request bounds', () => {
    it('allows a maximum-size MIME envelope through to authentication', async () => {
      const response = await worker.fetch(
        new Request('https://email-proxy/email/send', {
          method: 'POST',
          body: JSON.stringify({
            projectId: 'proj_000000000001',
            aiToken: 'invalid-project-token',
            mimeBase64: 'AAAA'.repeat(Math.ceil((5 * 1024 * 1024) / 3)),
          }),
        }),
        createEnv(),
      );
      expect(response.status).toBe(403);
    });

    it.each(['/email/send', '/email/unknown'])(
      'rejects an oversized declared body before reading %s',
      async (path) => {
        const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        });
        const cancel = vi.fn();
        const request = new Request(`https://email-proxy${path}`, {
          method: 'POST',
          headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
          body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
          duplex: 'half',
        } as RequestInit);
        const response = await worker.fetch(request, createEnv());
        expect(response.status).toBe(400);
        expect(pull).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledOnce();
      },
    );

    it('ends a stalled unauthenticated send body without waiting for cancellation', async () => {
      vi.useFakeTimers();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const request = new Request('https://email-proxy/email/send', {
        method: 'POST',
        body: new ReadableStream({ cancel }),
        duplex: 'half',
      } as RequestInit);
      let status: number | undefined;
      const response = worker.fetch(request, createEnv()).then((value) => {
        status = value.status;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status).toBe(400);
      expect(cancel).toHaveBeenCalledOnce();
      await response;
    });
  });

  describe('authentication before the body is read', () => {
    function streamedPost(url: string, headers: Record<string, string> = {}) {
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      });
      const request = new Request(url, {
        method: 'POST',
        headers,
        body: new ReadableStream({ pull, cancel: vi.fn() }, { highWaterMark: 0 }),
        duplex: 'half',
      } as RequestInit);
      return { request, pull };
    }

    it.each(['https://proxy.void.cloud', 'https://void-proxy.example.workers.dev'])(
      'refuses a request to %s without a header before reading its body',
      async (host) => {
        const { request, pull } = streamedPost(`${host}/ai/run`);
        const response = await worker.fetch(request, createEnv());
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: 'authorization required' });
        expect(pull).not.toHaveBeenCalled();
      },
    );

    it('refuses an invalid bearer token before reading the body', async () => {
      const { request, pull } = streamedPost('https://proxy.void.cloud/ai/run', {
        authorization: 'Bearer junk',
      });
      const response = await worker.fetch(request, createEnv());
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'invalid or expired token' });
      expect(pull).not.toHaveBeenCalled();
    });

    it('never accepts a body project token next to a non-bearer header', async () => {
      const env = createEnv();
      const response = await worker.fetch(
        post(
          '/ai/run',
          {
            model: 'm',
            inputs: {},
            projectId: 'proj_000000000001',
            aiToken: aiTokens['proj_000000000001'],
          },
          { authorization: 'Basic x' },
        ),
        env,
      );
      expect(response.status).toBe(401);
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it.each([
      'https://ai-proxy/ai/run',
      'https://proxy/revalidate',
      'https://email-proxy/email/send',
    ])('checks the body project token on the binding host %s', async (url) => {
      const response = await worker.fetch(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: 'proj_000000000001', aiToken: 'invalid' }),
        }),
        createEnv(),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid project token' });
    });
  });

  it('verifies email receipts independently of project login authentication', async () => {
    const claims = {
      version: 1 as const,
      receiptId: 'a'.repeat(64),
      projectId: 'proj_000000000001',
      deploymentId: 'deploy_1',
      recipient: 'support@example.com',
      expiresAt: Date.now() + 30_000,
    };
    const projectToken = await signAiToken(claims.projectId, JWT_SECRET);
    const call = async (receiptKey: string, auth = projectToken, env = createEnv()) =>
      worker.fetch(
        post(
          '/email/verify-receipt',
          { ...claims, receipt: await signEmailReceipt(claims, receiptKey) },
          { 'x-void-internal': auth },
        ),
        env,
      );
    expect(await (await call(EMAIL_SIGNING_SECRET)).json()).toEqual({
      valid: true,
      receiptId: claims.receiptId,
    });
    expect(await (await call(JWT_SECRET)).json()).toEqual({ valid: false });
    expect(
      (await call(EMAIL_SIGNING_SECRET, await signAiToken(claims.projectId, EMAIL_SIGNING_SECRET)))
        .status,
    ).toBe(403);
    const missing = { ...createEnv(), EMAIL_SIGNING_SECRET: '' };
    expect((await call(JWT_SECRET, projectToken, missing)).status).toBe(503);
  });

  it('rejects a receipt check for a non-project id even when its HMAC matches', async () => {
    for (const projectId of ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ', 'proj_1']) {
      const claims = {
        version: 1 as const,
        receiptId: 'a'.repeat(64),
        projectId,
        deploymentId: 'deploy_1',
        recipient: 'support@example.com',
        expiresAt: Date.now() + 30_000,
      };
      const res = await worker.fetch(
        post(
          '/email/verify-receipt',
          { ...claims, receipt: await signEmailReceipt(claims, EMAIL_SIGNING_SECRET) },
          { 'x-void-internal': await signAiToken(projectId, JWT_SECRET) },
        ),
        createEnv(),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ valid: false });
    }
  });

  describe('JWT authentication (HTTPS path)', () => {
    it('accepts valid JWT for the project owner', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it('rejects expired JWT with 401', async () => {
      const expiredToken = await signJwt(
        { sub: 'user_1', login: 'testuser', exp: Math.floor(Date.now() / 1000) - 60 },
        JWT_SECRET,
      );

      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'proj_000000000000' },
          { authorization: `Bearer ${expiredToken}` },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid or expired token',
        message: expect.stringMatching(/Sign in.*restart the build/),
      });
    });

    it('rejects login JWTs signed with the email key', async () => {
      const badToken = await signJwt({ sub: 'user_1', login: 'testuser' }, EMAIL_SIGNING_SECRET);

      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'proj_000000000000' },
          { authorization: `Bearer ${badToken}` },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
    });

    it('rejects malformed JWT with 401', async () => {
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'proj_000000000000' },
          { authorization: 'Bearer not.a.valid.jwt.at.all' },
        ),
        createEnv(),
      );

      expect(res.status).toBe(401);
    });

    it('requires projectId with JWT auth', async () => {
      const res = await worker.fetch(
        post('/ai/run', { model: 'm', inputs: {} }, { authorization: `Bearer ${validToken}` }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId required' });
    });
  });

  describe('JWT project ownership verification', () => {
    it('accepts a prerender token only for its scoped project', async () => {
      const token = await signJwt(
        { sub: 'user_1', login: 'testuser', aud: 'prerender', project: 'proj_000000000001' },
        JWT_SECRET,
      );
      const api = createMockApi();
      const apiFetch = vi.spyOn(api, 'fetch');
      const env = createEnv(undefined, undefined, api);

      const allowed = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${token}` },
        ),
        env,
      );
      expect(allowed.status).toBe(200);
      expect(apiFetch).toHaveBeenCalledTimes(2);
      expect(String(apiFetch.mock.calls[0]?.[0])).toContain(
        '/internal/verify-prerender-build/proj_000000000001',
      );

      const denied = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000042' },
          { authorization: `Bearer ${token}` },
        ),
        env,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: 'forbidden',
        message: expect.stringMatching(/does not match.*Restart the build/),
      });
      expect(apiFetch).toHaveBeenCalledTimes(2);
      expect(env.AI.run).toHaveBeenCalledTimes(1);
    });

    it('revokes an already-minted manual prerender token when project access changes', async () => {
      const token = await signJwt(
        { sub: 'user_1', login: 'testuser', aud: 'prerender', project: 'proj_000000000001' },
        JWT_SECRET,
      );
      let active = true;
      const api = createMockApi(async (input) => {
        expect(String(input)).toContain('/internal/verify-prerender-build/proj_000000000001');
        return active
          ? Response.json({ ok: true })
          : Response.json({ error: 'forbidden' }, { status: 403 });
      });
      const env = createEnv(undefined, undefined, api);
      const request = () =>
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${token}` },
        );

      expect((await worker.fetch(request(), env)).status).toBe(200);
      active = false;
      const revoked = await worker.fetch(request(), env);
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toEqual({
        error: 'prerender token authority is no longer active',
        message: expect.stringMatching(/Confirm your project access.*restart the build/),
      });
      expect(env.AI.run).toHaveBeenCalledTimes(1);
    });

    it('accepts a manual prerender token while the previous API revision is active', async () => {
      const token = await signJwt(
        { sub: 'user_1', login: 'testuser', aud: 'prerender', project: 'proj_000000000001' },
        JWT_SECRET,
      );
      const api = createMockApi(async (input) => {
        expect(String(input)).toContain('/internal/verify-prerender-build/proj_000000000001');
        return Response.json(
          { error: 'userId and credential provenance required' },
          { status: 400 },
        );
      });

      const response = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${token}` },
        ),
        createEnv(undefined, undefined, api),
      );

      expect(response.status).toBe(200);
    });

    it('revokes an already-minted build-bound prerender token when its build terminates', async () => {
      const token = await signJwt(
        {
          sub: 'user_1',
          login: 'testuser',
          aud: 'prerender',
          project: 'proj_000000000001',
          build: 'bld_1',
        },
        JWT_SECRET,
      );
      let active = true;
      const api = createMockApi(async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/internal/verify-owner/')) {
          return Response.json({ ok: true });
        }
        expect(url).toContain('/internal/verify-prerender-build/proj_000000000001');
        return active
          ? Response.json({ ok: true })
          : Response.json({ error: 'build is no longer active' }, { status: 403 });
      });
      const env = createEnv(undefined, undefined, api);
      const request = () =>
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${token}` },
        );

      expect((await worker.fetch(request(), env)).status).toBe(200);
      active = false;
      const revoked = await worker.fetch(request(), env);
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toEqual({
        error: 'prerender token build is no longer active',
        message: expect.stringMatching(/Start a new build.*fresh prerender token/),
      });
      expect(env.AI.run).toHaveBeenCalledTimes(1);
    });

    it('rejects deploy tokens at the binding proxy', async () => {
      const token = await signJwt(
        { sub: 'user_1', login: 'testuser', aud: 'deploy', project: 'proj_000000000001' },
        JWT_SECRET,
      );
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${token}` },
        ),
        createEnv(),
      );
      expect(res.status).toBe(401);
    });

    it('revokes credential-derived prerendering without invoking a resource handler', async () => {
      const token = await signJwt(
        {
          sub: 'user_1',
          login: 'testuser',
          aud: 'prerender',
          project: 'proj_000000000001',
          credential: 'cred_1',
        },
        JWT_SECRET,
      );
      let active = true;
      const api = createMockApi(async (input, init) => {
        expect(String(input)).toContain('/internal/verify-prerender-build/proj_000000000001');
        expect(JSON.parse(String(init?.body))).toEqual({
          userId: 'user_1',
          credentialId: 'cred_1',
        });
        return active
          ? Response.json({ ok: true })
          : Response.json({ error: 'forbidden' }, { status: 403 });
      });
      const env = createEnv(undefined, undefined, api);
      const request = () =>
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${token}` },
        );
      expect((await worker.fetch(request(), env)).status).toBe(200);
      active = false;
      const denied = await worker.fetch(request(), env);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({
        error: 'prerender token credential is no longer active',
        message: expect.stringMatching(
          /Ask the project owner for an active deploy credential.*restart the build/,
        ),
      });
      expect(env.AI.run).toHaveBeenCalledTimes(1);
    });

    it.each([403, 404, 500, 'network-error'] as const)(
      'gives the same neutral denial when the authority returns %s',
      async (status) => {
        const api = {
          fetch: vi.fn(async () => {
            if (status === 'network-error') {
              throw new Error('private authority failure');
            }
            return Response.json({ error: 'private owner and project details' }, { status });
          }),
        };
        const env = createEnv(undefined, undefined, api);
        const response = await worker.fetch(
          post(
            '/ai/run',
            { model: 'test-model', inputs: {}, projectId: 'proj_unknown' },
            { authorization: `Bearer ${validToken}` },
          ),
          env,
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: 'forbidden',
          message:
            'Remote access could not be authorized. Check the selected platform and project, then ask a project admin or owner to confirm your access. If your access is correct, retry shortly.',
        });
        expect(api.fetch).toHaveBeenCalledTimes(1);
        expect(env.AI.run).not.toHaveBeenCalled();
        expect(env.ROUTING.put).not.toHaveBeenCalled();
      },
    );

    it('rejects access when user does not own the project', async () => {
      // user_1 has no deploy role on "proj_other"
      const env = createEnv();
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_other' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        message: expect.stringMatching(
          /could not be authorized.*Check the selected platform and project.*retry shortly/,
        ),
      });
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it("rejects cross-tenant access to another user's project", async () => {
      // user_2 owns proj_cross but user_1 (validToken) does not
      const ownership = { user_2: ['proj_cross'] };
      const env = createEnv(undefined, undefined, createMockApi(undefined, ownership));
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_cross' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        message: expect.stringMatching(
          /could not be authorized.*Check the selected platform and project.*retry shortly/,
        ),
      });
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it('allows a non-owner whose live role has deploy access', async () => {
      const collaboratorToken = await signJwt(
        { sub: 'user_2', login: 'collaborator', aud: 'api' },
        JWT_SECRET,
      );
      const access = { user_2: ['proj_shared'] };
      const env = createEnv(undefined, undefined, createMockApi(undefined, access));
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_shared' },
          { authorization: `Bearer ${collaboratorToken}` },
        ),
        env,
      );

      expect(res.status).toBe(200);
    });

    it('returns 403 when the live deploy-access API call fails', async () => {
      // API returns 500 for all requests
      const failingApi = createMockApi(async () => new Response('error', { status: 500 }));
      const env = createEnv(undefined, undefined, failingApi);
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'test-model', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        message: expect.stringMatching(
          /could not be authorized.*Check the selected platform and project.*retry shortly/,
        ),
      });
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it('passes the actual proxy origin and revalidates every R2 download chunk', async () => {
      let ownerValid = true;
      const ownerChecks: Array<Record<string, unknown>> = [];
      const api = createMockApi(async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/internal/verify-owner/')) {
          ownerChecks.push(JSON.parse(init?.body as string));
          return ownerValid
            ? Response.json({ ok: true })
            : Response.json({ error: 'revoked' }, { status: 403 });
        }
        if (url.includes('/internal/resolve-worker/')) {
          return Response.json({ error: 'not found' }, { status: 404 });
        }
        if (url.includes('/internal/resolve-resource/')) {
          return Response.json({ cf_id: 'bucket' });
        }
        throw new Error(`unexpected API request: ${url}`);
      });
      let chunk = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(new Uint8Array([++chunk]));
                },
              }),
              { headers: { 'content-type': 'application/octet-stream' } },
            ),
        ),
      );
      const response = await worker.fetch(
        post(
          '/r2/get',
          { binding: 'FILES', key: 'large.bin', projectId: 'proj_000000000001' },
          { authorization: `Bearer ${validToken}` },
        ),
        createEnv(undefined, undefined, api),
      );
      const reader = response.body!.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([1]));
      ownerValid = false;
      await expect(reader.read()).rejects.toThrow('revoked');
      expect(ownerChecks.length).toBeGreaterThanOrEqual(3);
      expect(ownerChecks.every((body) => body.proxyOrigin === 'https://proxy.void.cloud')).toBe(
        true,
      );
    });

    it('HMAC path bypasses ownership check (service binding is trusted)', async () => {
      // Even for a project not in user_1's ownership, HMAC path should work
      const env = createEnv(undefined, undefined, createMockApi(undefined, {}));
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });
  });

  describe('service binding path (no auth header)', () => {
    it('accepts requests with valid aiToken', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalled();
    });

    it('requires projectId and aiToken', async () => {
      const res = await worker.fetch(post('/ai/run', { model: 'm', inputs: {} }), createEnv());

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId and aiToken required' });
    });

    it('rejects request with missing aiToken', async () => {
      const res = await worker.fetch(
        post('/ai/run', { model: 'm', inputs: {}, projectId: 'proj_000000000001' }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'projectId and aiToken required' });
    });

    it('rejects request with wrong aiToken', async () => {
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: 'invalid-token',
        }),
        createEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
    });

    it('rejects request with aiToken for different projectId', async () => {
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000042'],
        }),
        createEnv(),
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
    });

    it('rejects a login JWT split into projectId and aiToken', async () => {
      const [header, body, signature] = validToken.split('.');
      // The JWT signature is the same HMAC a project token would carry for this string.
      expect(await signAiToken(`${header}.${body}`, JWT_SECRET)).toBe(signature);
      const env = createEnv();
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: `${header}.${body}`,
          aiToken: signature,
        }),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it('rejects a project id outside the generated format even with a matching token', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: 'proj_1',
          aiToken: await signAiToken('proj_1', JWT_SECRET),
        }),
        env,
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
      expect(env.AI.run).not.toHaveBeenCalled();
    });
  });

  describe('project token generations', () => {
    const projectId = 'proj_000000000001';
    const floorKey = `proxy-token:${projectId}`;

    function floorReads(env: ReturnType<typeof createEnv>): number {
      return env.ROUTING.get.mock.calls.filter((call) => String(call[0]).startsWith('proxy-token:'))
        .length;
    }

    function aiRun(env: ReturnType<typeof createEnv>, aiToken: string) {
      return worker.fetch(
        post('/ai/run', { model: 'test-model', inputs: {}, projectId, aiToken }),
        env,
      );
    }

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('accepts the legacy and generation 1 tokens while no floor is set', async () => {
      for (const gen of [0, 1]) {
        clearProxyTokenStateCache();
        const env = createEnv();
        const res = await aiRun(env, await deriveProxyToken(JWT_SECRET, projectId, gen));
        expect(res.status).toBe(200);
        expect(env.AI.run).toHaveBeenCalledOnce();
      }
    });

    it('accepts generations at or above the floor and rejects the legacy token', async () => {
      for (const gen of [1, 2]) {
        clearProxyTokenStateCache();
        const res = await aiRun(
          createEnv({}, { [floorKey]: '{"gen":1}' }),
          await deriveProxyToken(JWT_SECRET, projectId, gen),
        );
        expect(res.status).toBe(200);
      }

      clearProxyTokenStateCache();
      const env = createEnv({}, { [floorKey]: '{"gen":1}' });
      const res = await aiRun(env, aiTokens[projectId]);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it('rejects a wrong MAC without reading the floor', async () => {
      const other = await deriveProxyToken(JWT_SECRET, 'proj_000000000042', 1);
      const env = createEnv();
      const res = await aiRun(env, other);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'invalid project token' });
      expect(floorReads(env)).toBe(0);
    });

    it('fails closed with 503 when the floor is malformed', async () => {
      const env = createEnv({}, { [floorKey]: 'not json' });
      const res = await aiRun(env, aiTokens[projectId]);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'project token state unavailable' });
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it('reads the floor once for repeated calls in the same isolate', async () => {
      const env = createEnv();
      expect((await aiRun(env, aiTokens[projectId])).status).toBe(200);
      expect((await aiRun(env, aiTokens[projectId])).status).toBe(200);
      expect(floorReads(env)).toBe(1);
    });

    describe('/email/verify-receipt', () => {
      const claims = {
        version: 1 as const,
        receiptId: 'a'.repeat(64),
        projectId,
        deploymentId: 'deploy_1',
        recipient: 'support@example.com',
        expiresAt: Date.now() + 60_000,
      };

      async function verifyReceipt(
        env: ReturnType<typeof createEnv>,
        headers: Record<string, string>,
      ) {
        return worker.fetch(
          post(
            '/email/verify-receipt',
            { ...claims, receipt: await signEmailReceipt(claims, EMAIL_SIGNING_SECRET) },
            headers,
          ),
          env,
        );
      }

      it('accepts a token at the floor and rejects the legacy token below it', async () => {
        const accepted = await verifyReceipt(createEnv(undefined, { [floorKey]: '{"gen":1}' }), {
          'x-void-internal': await deriveProxyToken(JWT_SECRET, projectId, 1),
        });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ valid: true, receiptId: claims.receiptId });

        clearProxyTokenStateCache();
        const rejected = await verifyReceipt(createEnv(undefined, { [floorKey]: '{"gen":1}' }), {
          'x-void-internal': aiTokens[projectId],
        });
        expect(rejected.status).toBe(403);
        expect(await rejected.json()).toEqual({ valid: false });
      });

      it('fails closed with 503 when the floor cannot be read', async () => {
        const env = createEnv();
        env.ROUTING.get.mockRejectedValue(new Error('kv unavailable'));
        const res = await verifyReceipt(env, { 'x-void-internal': aiTokens[projectId] });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ valid: false });
      });

      it('rejects a missing token without reading the floor', async () => {
        const env = createEnv();
        const res = await verifyReceipt(env, {});
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ valid: false });
        expect(floorReads(env)).toBe(0);
      });
    });
  });

  describe('AI usage limit (KV block)', () => {
    it('returns 429 when ai-block key exists (service binding path)', async () => {
      const env = createEnv({}, { 'ai-block:proj_000000000001': '1' });
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        code: 'usage_limit',
        resource: 'ai',
        reason: 'monthly_quota',
        message: 'AI usage limit exceeded',
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('returns 429 when ai-block key exists (JWT path)', async () => {
      const env = createEnv({}, { 'ai-block:proj_000000000001': '1' });
      const res = await worker.fetch(
        post(
          '/ai/run',
          { model: 'm', inputs: {}, projectId: 'proj_000000000001' },
          { authorization: `Bearer ${validToken}` },
        ),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        code: 'usage_limit',
        resource: 'ai',
        reason: 'monthly_quota',
        message: 'AI usage limit exceeded',
      });
    });

    it('allows request when ai-block key does not exist', async () => {
      const env = createEnv({}, {});
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
    });
  });

  describe('AI platform capability', () => {
    it.each(
      ['/ai/run', '/ai/models', '/ai/toMarkdown', '/ai/provider'].flatMap((path) =>
        ['project token', 'user token'].map((credential) => ({ path, credential })),
      ),
    )('denies $path with a valid $credential when AI is disabled', async ({ path, credential }) => {
      const env = { ...createEnv(), PLATFORM_CAPABILITIES: '{"ai":false}' };
      const res = await worker.fetch(
        post(
          path,
          {
            model: 'test-model',
            inputs: {},
            projectId: 'proj_000000000001',
            aiToken: aiTokens['proj_000000000001'],
          },
          credential === 'user token' ? { authorization: `Bearer ${validToken}` } : undefined,
        ),
        env,
      );

      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({
        error: 'platform capability unavailable',
        capability: 'ai',
        message: 'This Void platform does not enable AI.',
      });
      for (const binding of Object.values(env.AI)) {
        expect(binding).not.toHaveBeenCalled();
      }
      expect(env.ROUTING.get.mock.calls.some(([key]) => key.startsWith('ai-block:'))).toBe(false);
    });

    it.each(['{}', '{"email":true}', '{"ai":"true"}', 'null', '[]', 'invalid JSON'])(
      'denies AI when its capability is not enabled in %s',
      async (capabilities) => {
        const env = { ...createEnv(), PLATFORM_CAPABILITIES: capabilities };
        const res = await worker.fetch(
          post('/ai/run', {
            model: 'test-model',
            inputs: {},
            projectId: 'proj_000000000001',
            aiToken: aiTokens['proj_000000000001'],
          }),
          env,
        );

        expect(res.status).toBe(501);
        expect(env.AI.run).not.toHaveBeenCalled();
      },
    );

    it('authenticates before checking the AI capability', async () => {
      const env = { ...createEnv(), PLATFORM_CAPABILITIES: '{"ai":false}' };
      const res = await worker.fetch(
        post('/ai/run', {
          model: 'test-model',
          inputs: {},
          projectId: 'proj_000000000001',
          aiToken: 'invalid-token',
        }),
        env,
      );

      expect(res.status).toBe(403);
      expect(env.AI.run).not.toHaveBeenCalled();
    });

    it.each([undefined, '', '{"ai":true}'])(
      'allows AI with enabled or unspecified capabilities (%s)',
      async (capabilities) => {
        const env = { ...createEnv(), PLATFORM_CAPABILITIES: capabilities };
        const res = await worker.fetch(
          post('/ai/run', {
            model: 'test-model',
            inputs: {},
            projectId: 'proj_000000000001',
            aiToken: aiTokens['proj_000000000001'],
          }),
          env,
        );

        expect(res.status).toBe(200);
        expect(env.AI.run).toHaveBeenCalledOnce();
      },
    );
  });

  describe('operator-controlled AI logging', () => {
    it('strips logging controls from binding session headers as well as request headers', async () => {
      const env = createEnv(undefined, undefined, {
        fetch: vi.fn(async () => Response.json({ mode: 'metadata' })),
      });
      await worker.fetch(
        post('/ai/run', {
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
          model: 'm',
          inputs: {},
          options: {
            sessionOptions: {
              extraHeaders: {
                'CF-AIG-Collect-Log': 'false',
                'cf-aig-collect-log-payload': 'true',
                'cf-aig-metadata': '{"projectId":"forged"}',
                'x-keep': 'session-header',
              },
            },
          },
        }),
        env,
      );
      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        {},
        expect.objectContaining({
          sessionOptions: { extraHeaders: { 'x-keep': 'session-header' } },
          extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
        }),
      );
    });
    it.each(['off', 'metadata', 'full'])(
      'enforces %s logging for inference and Markdown conversion',
      async (mode) => {
        const api = { fetch: vi.fn(async () => Response.json({ mode })) };
        const env = createEnv(undefined, undefined, api);
        for (const path of ['/ai/run', '/ai/toMarkdown']) {
          const response = await worker.fetch(
            post(path, {
              projectId: 'proj_000000000042',
              aiToken: aiTokens['proj_000000000042'],
              model: 'm',
              inputs: {},
              options: {
                gateway: { collectLog: mode === 'off', metadata: { projectId: 'forged' } },
                extraHeaders: {
                  'CF-AIG-Collect-Log-Payload': 'true',
                  'cf-aig-collect-log': 'true',
                  'x-keep': 'yes',
                },
              },
            }),
            env,
          );
          expect(response.status).toBe(200);
        }
        for (const method of [env.AI.run, env.AI.toMarkdown]) {
          const options = method.mock.calls[0]!.at(-1);
          expect(options).toMatchObject({
            gateway: {
              collectLog: mode !== 'off',
              metadata: { projectId: usageTags['proj_000000000042'] },
            },
            extraHeaders: {
              'cf-aig-collect-log-payload': String(mode === 'full'),
              'x-keep': 'yes',
            },
          });
        }
        expect(api.fetch).toHaveBeenCalledTimes(2);
      },
    );

    it.each(['off', 'metadata', 'full'])('enforces %s logging for provider calls', async (mode) => {
      const env = createEnv(
        {
          gateway: vi.fn(() => ({
            getUrl: async () => 'https://gateway.test/v1/account/void/openai',
            run: vi.fn(),
          })),
        },
        undefined,
        { fetch: vi.fn(async () => Response.json({ mode })) },
      );
      const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
      const response = await worker.fetch(
        post('/ai/provider', {
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
          provider: 'openai',
          providerKey: 'test-key',
          path: 'chat/completions',
          body: {},
          headers: { 'CF-AIG-Collect-Log': 'true', 'cf-aig-collect-log-payload': 'true' },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const headers = new Headers(request.mock.calls[0]![1]!.headers);
      expect(headers.get('cf-aig-collect-log')).toBe(String(mode !== 'off'));
      expect(headers.get('cf-aig-collect-log-payload')).toBe(String(mode === 'full'));
    });

    it.each([null, { mode: 'invalid' }, { mode: false }])(
      'refuses inference if the saved policy cannot be verified: %j',
      async (policy) => {
        const env = createEnv(undefined, undefined, {
          fetch: vi.fn(async () =>
            policy === null ? new Response(null, { status: 503 }) : Response.json(policy),
          ),
        });
        const response = await worker.fetch(
          post('/ai/run', {
            projectId: 'proj_000000000042',
            aiToken: aiTokens['proj_000000000042'],
            model: 'm',
            inputs: {},
          }),
          env,
        );
        expect(response.status).toBe(503);
        expect(env.AI.run).not.toHaveBeenCalled();
      },
    );
  });

  describe('AI: /ai/run', () => {
    it('replaces a serialized signal with native request cancellation', async () => {
      const env = createEnv();
      const controller = new AbortController();
      const request = new Request(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          options: { signal: {}, returnRawResponse: true },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        { signal: controller.signal },
      );
      const res = await worker.fetch(request, env);
      expect(res.status).toBe(200);
      const options = env.AI.run.mock.calls[0]![2];
      expect(options.returnRawResponse).toBe(true);
      expect(options.signal).toBe(request.signal);
      expect(options.signal.aborted).toBe(false);
      controller.abort();
      expect(options.signal.aborted).toBe(true);
    });

    it('calls AI.run with model, inputs, and gateway metadata', async () => {
      const env = createEnv();
      const res = await worker.fetch(
        post('/ai/run', {
          model: '@cf/meta/llama-3-8b-instruct',
          inputs: { prompt: 'hi' },
          options: { max_tokens: 100 },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(env.AI.run).toHaveBeenCalledWith(
        '@cf/meta/llama-3-8b-instruct',
        { prompt: 'hi' },
        {
          signal: expect.any(AbortSignal),
          max_tokens: 100,
          gateway: { id: 'void', metadata: { projectId: usageTags['proj_000000000042'] } },
        },
      );
    });

    it('uses the installation-specific AI Gateway', async () => {
      const env = { ...createEnv(), AI_GATEWAY_ID: 'void-team' };
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        {},
        {
          signal: expect.any(AbortSignal),
          gateway: { id: 'void-team', metadata: { projectId: usageTags['proj_000000000042'] } },
        },
      );
    });

    it('preserves user gateway options while forcing Void gateway id and project metadata', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: { prompt: 'hi' },
          options: {
            gateway: {
              id: 'custom',
              skipCache: true,
              cacheTtl: 60,
              metadata: { user: 'alice', projectId: 'wrong' },
            },
          },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        { prompt: 'hi' },
        {
          signal: expect.any(AbortSignal),
          gateway: {
            id: 'void',
            skipCache: true,
            cacheTtl: 60,
            metadata: { projectId: usageTags['proj_000000000042'] },
          },
        },
      );
    });

    it.each([
      { a: '1', b: '2', c: '3', d: '4', e: '5' },
      { '0': '1', '1': '2', '2': '3', '3': '4', '4': '5' },
    ])('keeps the project as the only gateway metadata entry %j', async (metadata) => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          options: { gateway: { metadata } },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      const options = env.AI.run.mock.calls[0]![2] as { gateway: { metadata: unknown } };
      expect(options.gateway.metadata).toStrictEqual({ projectId: usageTags['proj_000000000042'] });
    });

    it('keeps gateway logging on and drops caller gateway control headers', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          options: {
            gateway: { collectLog: false, eventId: 'event-1' },
            extraHeaders: {
              'cf-aig-metadata': '{"projectId":"proj_000000000001"}',
              'CF-AIG-Custom-Cost': '{"total_cost":0}',
              'x-keep': 'yes',
            },
          },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        {},
        {
          signal: expect.any(AbortSignal),
          gateway: {
            id: 'void',
            eventId: 'event-1',
            metadata: { projectId: usageTags['proj_000000000042'] },
          },
          extraHeaders: { 'x-keep': 'yes' },
        },
      );
    });

    it('scopes a caller cache key to the project', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          options: { gateway: { cacheKey: 'k' } },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        {},
        {
          signal: expect.any(AbortSignal),
          gateway: {
            id: 'void',
            cacheKey: 'proj_000000000042:k',
            metadata: { projectId: usageTags['proj_000000000042'] },
          },
        },
      );
    });

    it('returns 400 when model is missing', async () => {
      const res = await worker.fetch(
        post('/ai/run', {
          inputs: {},
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        createEnv(),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'model required' });
    });

    it('returns streaming response when inputs.stream is true', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"response":"hi"}\n\n'));
          controller.close();
        },
      });
      const env = createEnv({ run: vi.fn(async () => stream) });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: { prompt: 'hi', stream: true },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');

      const text = await res.text();
      expect(text).toContain('{"response":"hi"}');
    });

    it('returns JSON response for non-streaming calls', async () => {
      const env = createEnv({ run: vi.fn(async () => ({ response: 'world' })) });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: { prompt: 'hi' },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ response: 'world' });
    });

    it('returns binary responses without forcing JSON', async () => {
      const env = createEnv({
        run: vi.fn(async () => new Blob(['png-bytes'], { type: 'image/png' })),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: '@cf/black-forest-labs/flux-1-schnell',
          inputs: { prompt: 'a red cube' },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(await res.text()).toBe('png-bytes');
    });

    it('uses response() from Workers AI result objects', async () => {
      const env = createEnv({
        run: vi.fn(async () => ({
          response: () => new Response('jpeg-bytes', { headers: { 'content-type': 'image/jpeg' } }),
        })),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: '@cf/image-model',
          inputs: { prompt: 'a blue cube' },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(await res.text()).toBe('jpeg-bytes');
    });

    it('injects gateway metadata even without user options', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000099',
          aiToken: aiTokens['proj_000000000099'],
        }),
        env,
      );

      expect(env.AI.run).toHaveBeenCalledWith(
        'm',
        {},
        {
          signal: expect.any(AbortSignal),
          gateway: { id: 'void', metadata: { projectId: usageTags['proj_000000000099'] } },
        },
      );
    });

    it('tags gateway metadata with the signed project value the usage query counts', async () => {
      const env = createEnv();
      await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      const options = env.AI.run.mock.calls[0]![2] as {
        gateway: { metadata: { projectId: string } };
      };
      const tag = options.gateway.metadata.projectId;
      expect(tag).toBe(await deriveAiUsageTag(env.JWT_SECRET, 'proj_000000000042'));
      expect(tag).toMatch(/^proj_000000000042\.[A-Za-z0-9_-]{22}$/);
      expect(tag).not.toBe(await deriveAiUsageTag('other-secret', 'proj_000000000042'));
    });
  });

  describe('AI: /ai/models', () => {
    it('calls AI.models and returns result', async () => {
      const models = [{ name: 'model-a' }, { name: 'model-b' }];
      const env = createEnv({ models: vi.fn(async () => models) });

      const res = await worker.fetch(
        post('/ai/models', {
          inputs: { search: 'llama' },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(models);
      expect(env.AI.models).toHaveBeenCalledWith({ search: 'llama' });
    });
  });

  describe('AI: /ai/toMarkdown', () => {
    it('calls AI.toMarkdown and returns result', async () => {
      const result = { markdown: '# Hello' };
      const env = createEnv({ toMarkdown: vi.fn(async () => result) });

      const res = await worker.fetch(
        post('/ai/toMarkdown', {
          inputs: { content: 'hello' },
          options: { format: 'md' },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(result);
      expect(env.AI.toMarkdown).toHaveBeenCalledWith(
        { content: 'hello' },
        {
          format: 'md',
          gateway: { id: 'void', metadata: { projectId: usageTags['proj_000000000000'] } },
        },
      );
    });

    it('converts through the installation gateway without caller gateway control', async () => {
      const env = { ...createEnv(), AI_GATEWAY_ID: 'void-team' };

      await worker.fetch(
        post('/ai/toMarkdown', {
          inputs: { content: 'hello' },
          options: {
            gateway: { id: 'other', collectLog: false, metadata: { projectId: 'x' } },
            extraHeaders: { 'cf-aig-custom-cost': '{"total_cost":0}', 'x-keep': 'yes' },
            conversionOptions: { image: { descriptionLanguage: 'en' } },
          },
          projectId: 'proj_000000000042',
          aiToken: aiTokens['proj_000000000042'],
        }),
        env,
      );

      expect(env.AI.toMarkdown).toHaveBeenCalledWith(
        { content: 'hello' },
        {
          gateway: { id: 'void-team', metadata: { projectId: usageTags['proj_000000000042'] } },
          extraHeaders: { 'x-keep': 'yes' },
          conversionOptions: { image: { descriptionLanguage: 'en' } },
        },
      );
    });
  });

  describe('AI: /ai/provider', () => {
    function mockProviderFetch(response: BodyInit, init?: ResponseInit) {
      const fetchMock = vi.fn(async () => new Response(response, init));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    function mockProviderGateway(provider = 'openai') {
      const getUrlMock = vi.fn(
        async (requestedProvider?: string) =>
          `https://gateway.test/v1/account/void/${requestedProvider ?? provider}/`,
      );
      const runMock = vi.fn();
      const gateway = vi.fn(() => ({ getUrl: getUrlMock, run: runMock }));
      return { gateway, getUrlMock, runMock };
    }

    it('forwards OpenAI provider-native JSON requests', async () => {
      const fetchMock = mockProviderFetch(JSON.stringify({ id: 'resp_1' }), {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway, getUrlMock, runMock } = mockProviderGateway();

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          method: 'POST',
          headers: { 'openai-beta': 'assistants=v2' },
          body: {
            type: 'json',
            value: {
              model: 'gpt-4o',
              messages: [{ role: 'user', content: 'Hello' }],
            },
          },
          providerKey: 'sk-test-key',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'resp_1' });
      expect(gateway).toHaveBeenCalledWith('void');
      expect(getUrlMock).toHaveBeenCalledWith('openai');
      expect(runMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gateway.test/v1/account/void/openai/chat/completions',
      );

      const init = fetchMock.mock.calls[0][1]!;
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-test-key');
      expect([...headers.keys()].filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('openai-beta')).toBe('assistants=v2');
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('uses the installation-specific gateway for provider requests', async () => {
      mockProviderFetch('{}', { headers: { 'content-type': 'application/json' } });
      const { gateway } = mockProviderGateway();
      const env = { ...createEnv({ gateway }), AI_GATEWAY_ID: 'void-team' };

      const response = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          providerKey: 'key',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(response.status).toBe(200);
      expect(gateway).toHaveBeenCalledWith('void-team');
    });

    it('uses Google AI Studio API-key header for provider-native requests', async () => {
      const fetchMock = mockProviderFetch(JSON.stringify({ candidates: [] }), {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway, getUrlMock } = mockProviderGateway('google-ai-studio');

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'google-ai-studio',
          path: '/v1/models/gemini-2.5-flash:generateContent',
          body: {
            type: 'json',
            value: { contents: [{ parts: [{ text: 'Hello' }] }] },
          },
          providerKey: 'google-key',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(getUrlMock).toHaveBeenCalledWith('google-ai-studio');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://gateway.test/v1/account/void/google-ai-studio/v1/models/gemini-2.5-flash:generateContent',
      );
      const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
      expect(headers.get('x-goog-api-key')).toBe('google-key');
      expect(headers.get('authorization')).toBeNull();
      expect([...headers.keys()].filter((name) => name.startsWith('cf-aig-'))).toEqual([]);
    });

    function gatewayHeaders(headers: Headers): Array<[string, string]> {
      return [...headers].filter(([name]) => name.startsWith('cf-aig-'));
    }

    it('drops caller gateway control headers on provider-native calls', async () => {
      const fetchMock = mockProviderFetch('{}', {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway } = mockProviderGateway();
      const env = createEnv({ gateway });

      const callerHeaders = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          headers: {
            'cf-aig-metadata': '{"projectId":"proj_000000000001"}',
            'CF-AIG-Collect-Log': 'false',
            'cf-aig-collect-log-payload': 'false',
            'cf-aig-custom-cost': '{"total_cost":0}',
            'cf-aig-authorization': 'Bearer platform-gateway-token',
            'cf-aig-byok-alias': 'platform-key',
            'cf-aig-future-control': 'on',
            'x-keep': 'yes',
          },
          providerKey: 'sk-test',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(callerHeaders.status).toBe(200);
      const forwarded = new Headers(fetchMock.mock.calls[0][1]!.headers);
      expect(gatewayHeaders(forwarded)).toStrictEqual([]);
      expect(forwarded.get('x-keep')).toBe('yes');
      expect(forwarded.get('authorization')).toBe('Bearer sk-test');

      const keyHeader = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          apiKeyHeader: 'cf-aig-collect-log',
          apiKeyPrefix: '',
          providerKey: 'false',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(keyHeader.status).toBe(200);
      expect(gatewayHeaders(new Headers(fetchMock.mock.calls[1][1]!.headers))).toStrictEqual([]);
    });

    it('forwards cache, timeout and retry gateway headers on provider-native calls', async () => {
      const fetchMock = mockProviderFetch('{}', {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway } = mockProviderGateway();
      const env = createEnv({ gateway });

      const callerHeaders = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          headers: {
            'cf-aig-cache-ttl': '3600',
            'CF-AIG-Skip-Cache': 'true',
            'cf-aig-request-timeout': '5000',
            'cf-aig-max-attempts': '3',
            'cf-aig-retry-delay': '1000',
            'cf-aig-backoff': 'exponential',
            'cf-aig-event-id': 'evt_1',
            'CF-AIG-Cache-Key': 'shared-key',
            'cf-aig-metadata': '{"projectId":"proj_000000000001"}',
          },
          providerKey: 'sk-test',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(callerHeaders.status).toBe(200);
      expect(
        Object.fromEntries(gatewayHeaders(new Headers(fetchMock.mock.calls[0][1]!.headers))),
      ).toStrictEqual({
        'cf-aig-cache-ttl': '3600',
        'cf-aig-skip-cache': 'true',
        'cf-aig-request-timeout': '5000',
        'cf-aig-max-attempts': '3',
        'cf-aig-retry-delay': '1000',
        'cf-aig-backoff': 'exponential',
        'cf-aig-event-id': 'evt_1',
        'cf-aig-cache-key': 'proj_000000000001:shared-key',
      });

      const keyHeader = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          apiKeyHeader: 'cf-aig-cache-key',
          apiKeyPrefix: '',
          providerKey: 'shared-key',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(keyHeader.status).toBe(200);
      expect(gatewayHeaders(new Headers(fetchMock.mock.calls[1][1]!.headers))).toStrictEqual([
        ['cf-aig-cache-key', 'proj_000000000001:shared-key'],
      ]);
    });

    it('reconstructs multipart form data bodies', async () => {
      const fetchMock = mockProviderFetch(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
      const { gateway } = mockProviderGateway();

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/images/edits',
          body: {
            type: 'form',
            entries: [
              { name: 'model', value: 'gpt-image-1.5' },
              { name: 'prompt', value: 'change the background' },
              {
                name: 'image',
                value: {
                  __voidFile: true,
                  data: btoa('png-bytes'),
                  name: 'source.png',
                  type: 'image/png',
                },
              },
            ],
          },
          providerKey: 'sk-test',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      const init = fetchMock.mock.calls[0][1]!;
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBeNull();

      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('model')).toBe('gpt-image-1.5');
      expect(form.get('prompt')).toBe('change the background');
      const image = form.get('image') as Blob;
      expect(image).toBeInstanceOf(Blob);
      expect(image.type).toBe('image/png');
      expect(await image.text()).toBe('png-bytes');
    });

    it('preserves non-JSON provider responses', async () => {
      const fetchMock = mockProviderFetch('image-bytes', {
        headers: { 'content-type': 'image/png' },
      });
      const { gateway } = mockProviderGateway('fal');

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'fal',
          path: '/v1/images',
          body: { type: 'json', value: { prompt: 'a small robot' } },
          providerKey: 'fal-key',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(await res.text()).toBe('image-bytes');
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('requires provider, path, and providerKey', async () => {
      const env = createEnv();

      const noProvider = await worker.fetch(
        post('/ai/provider', {
          path: '/chat/completions',
          providerKey: 'sk-test',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(noProvider.status).toBe(400);
      expect(await noProvider.json()).toEqual({ error: 'provider required' });

      const noPath = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          providerKey: 'sk-test',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(noPath.status).toBe(400);
      expect(await noPath.json()).toEqual({ error: 'path required' });

      const noKey = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );
      expect(noKey.status).toBe(400);
      expect(await noKey.json()).toEqual({ error: 'providerKey required' });
    });

    it('rejects unsafe provider paths', async () => {
      const env = createEnv();
      for (const path of [
        'https://api.openai.com/v1/chat/completions',
        '//api.openai.com/v1/chat/completions',
        '/../chat/completions',
        '/%2e%2e/chat/completions',
        '/v1\\chat\\completions',
        '/%E0%A4%A',
      ]) {
        const res = await worker.fetch(
          post('/ai/provider', {
            provider: 'openai',
            path,
            providerKey: 'sk-test',
            projectId: 'proj_000000000001',
            aiToken: aiTokens['proj_000000000001'],
          }),
          env,
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'path must be relative' });
      }
    });

    it('forwards provider error status and message', async () => {
      mockProviderFetch(
        JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
      const { gateway } = mockProviderGateway();

      const env = createEnv({ gateway });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          body: { type: 'json', value: { model: 'gpt-4o' } },
          providerKey: 'sk-bad-key',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain('Invalid API key');
    });

    it('respects usage limits for provider-native requests', async () => {
      const env = createEnv({}, { 'ai-block:proj_000000000001': '1' });
      const res = await worker.fetch(
        post('/ai/provider', {
          provider: 'openai',
          path: '/chat/completions',
          providerKey: 'sk-test',
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        code: 'usage_limit',
        resource: 'ai',
        reason: 'monthly_quota',
        message: 'AI usage limit exceeded',
      });
    });
  });

  describe('revalidate: /revalidate', () => {
    it('forwards revalidation to API via service binding', async () => {
      const apiFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 2 }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const env = createEnv({}, {}, { fetch: apiFetch });

      const res = await worker.fetch(
        post('/revalidate', {
          paths: ['/', '/blog'],
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 2 });

      expect(apiFetch).toHaveBeenCalledOnce();
      // Fetcher.fetch() receives (url: string, init: RequestInit)
      const [url, init] = apiFetch.mock.calls[0];
      expect(url).toBe('https://api/internal/revalidate/proj_000000000001');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('x-void-internal')).toBe(aiTokens['proj_000000000001']);
      expect(JSON.parse(init.body)).toEqual({ paths: ['/', '/blog'] });
    });

    it('forwards all:true revalidation', async () => {
      const apiFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ purged: 10 }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const env = createEnv({}, {}, { fetch: apiFetch });

      const res = await worker.fetch(
        post('/revalidate', {
          all: true,
          projectId: 'proj_000000000001',
          aiToken: aiTokens['proj_000000000001'],
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 10 });

      const [, init] = apiFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ all: true });
    });

    it('rejects unauthenticated revalidation requests', async () => {
      const res = await worker.fetch(post('/revalidate', { paths: ['/'] }), createEnv());

      expect(res.status).toBe(400);
    });
  });

  describe('error handling', () => {
    it('returns the AI binding error message when the binding throws', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw new Error('inference failed');
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'inference failed' });
    });

    it('returns 502 with stringified error when non-Error is thrown', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw 'string error';
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'string error' });
    });

    it('forwards response-shaped AI binding errors', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw {
            response: new Response(
              JSON.stringify({ errors: [{ message: 'Unified Billing off' }] }),
              {
                status: 402,
                headers: { 'content-type': 'application/json' },
              },
            ),
          };
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'google/gemini-2.5-flash',
          inputs: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(402);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toEqual({ errors: [{ message: 'Unified Billing off' }] });
    });

    it('uses status from AI binding errors when available', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          const error = new Error('Invalid model input') as Error & { status: number };
          error.status = 400;
          throw error;
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'google/gemini-2.5-flash',
          inputs: { messages: [{ role: 'user', content: 'Hello' }] },
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid model input' });
    });

    it('includes CORS headers on error responses', async () => {
      const env = createEnv({
        run: vi.fn(async () => {
          throw new Error('fail');
        }),
      });

      const res = await worker.fetch(
        post('/ai/run', {
          model: 'm',
          inputs: {},
          projectId: 'proj_000000000000',
          aiToken: aiTokens['proj_000000000000'],
        }),
        env,
      );

      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });
});
