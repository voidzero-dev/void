import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vite-plus/test';
import worker from '../../src/index.ts';
import { clearProxyTokenStateCache } from '../../src/proxy-token.ts';

const JWT_SECRET = 'test-secret-key';

// --- HMAC helper ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

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

// --- Mock factories ---

function createMockApi(resources: Record<string, string> = {}) {
  return {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.includes('/internal/resolve-worker/')) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const projectId = path.split('/').pop()!;
      const body = JSON.parse(init?.body as string);
      const key = `${projectId}:${body.type}:${body.binding}`;
      const cfId = resources[key];
      if (cfId) {
        return Response.json({ cf_id: cfId });
      }
      return Response.json({ error: `unknown binding "${body.binding}"` }, { status: 404 });
    }),
  };
}

function createMockDispatch() {
  return {
    get: vi.fn(() => {
      throw new Error('worker not found');
    }),
  };
}

function createEnv(apiResources: Record<string, string> = {}) {
  return {
    AI: { run: vi.fn(), models: vi.fn(), toMarkdown: vi.fn() },
    JWT_SECRET,
    ROUTING: { get: vi.fn(async () => null), put: vi.fn(), delete: vi.fn() },
    API: createMockApi(apiResources),
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-token',
    DISPATCH: createMockDispatch(),
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://proxy${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function asFetchMock(mock: unknown): typeof fetch {
  return mock as typeof fetch;
}

// --- Tests ---

describe('KV proxy endpoints', () => {
  let token: string;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    token = await signAiToken('proj_000000000001', JWT_SECRET);
  });

  beforeEach(clearProxyTokenStateCache);

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('POST /kv/get', () => {
    it('returns text value', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => new Response('hello world')));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'greeting',
          type: 'text',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBe('hello world');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/kv-ns-123/values/greeting',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
    });

    it('returns JSON value', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ count: 42 })));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'data',
          type: 'json',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ count: 42 });
    });

    it('returns null for missing key (404)', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => new Response('Not Found', { status: 404 })));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'missing',
          type: 'text',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });

    it('URL-encodes the key', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => new Response('val')));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      await worker.fetch(
        post('/kv/get', {
          binding: 'CACHE',
          key: 'user:1:profile',
          type: 'text',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/values/user%3A1%3Aprofile'),
        expect.any(Object),
      );
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/kv/get', {
          binding: 'MISSING',
          key: 'k',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(404);
    });

    it('returns 400 when key is missing', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/kv/get', { binding: 'CACHE', projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  describe('POST /kv/put', () => {
    it('writes value to CF KV API', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/put', {
          binding: 'CACHE',
          key: 'greeting',
          value: 'hello',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/kv-ns-123/values/greeting',
        expect.objectContaining({ method: 'PUT', body: 'hello' }),
      );
    });

    it('includes expiration query params', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      await worker.fetch(
        post('/kv/put', {
          binding: 'CACHE',
          key: 'temp',
          value: 'x',
          expiration_ttl: 300,
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('?expiration_ttl=300'),
        expect.any(Object),
      );
    });

    it('serializes non-string values as JSON', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      await worker.fetch(
        post('/kv/put', {
          binding: 'CACHE',
          key: 'data',
          value: { count: 1 },
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ body: '{"count":1}' }),
      );
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/kv/put', {
          binding: 'MISSING',
          key: 'k',
          value: 'v',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('POST /kv/delete', () => {
    it('deletes key via CF KV API', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/delete', {
          binding: 'CACHE',
          key: 'greeting',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/storage/kv/namespaces/kv-ns-123/values/greeting',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('returns 400 when key is missing', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/kv/delete', { binding: 'CACHE', projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  describe('POST /kv/list', () => {
    it('lists keys via CF KV API', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(async () =>
          Response.json({
            success: true,
            result: [{ name: 'key1' }, { name: 'key2' }],
            result_info: {},
          }),
        ),
      );

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/list', {
          binding: 'CACHE',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { keys: Array<{ name: string }>; list_complete: boolean };
      expect(data.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
      expect(data.list_complete).toBe(true);
    });

    it('passes prefix, limit, and cursor params', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(async () =>
          Response.json({ success: true, result: [], result_info: { cursor: 'next-cursor' } }),
        ),
      );

      const env = createEnv({ 'proj_000000000001:kv:CACHE': 'kv-ns-123' });
      const res = await worker.fetch(
        post('/kv/list', {
          binding: 'CACHE',
          prefix: 'user:',
          limit: 10,
          cursor: 'prev-cursor',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { list_complete: boolean; cursor: string };
      expect(data.list_complete).toBe(false);
      expect(data.cursor).toBe('next-cursor');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/prefix=user%3A.*limit=10.*cursor=prev-cursor/),
        expect.any(Object),
      );
    });

    it('returns 400 when binding is missing', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/kv/list', { projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/kv/list', {
          binding: 'MISSING',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(404);
    });
  });
});
