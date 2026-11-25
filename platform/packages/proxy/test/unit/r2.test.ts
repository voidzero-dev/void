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

describe('R2 proxy endpoints', () => {
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

  describe('POST /r2/get', () => {
    it('streams object body from CF R2 API', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(
          async () =>
            new Response('file-content', {
              headers: {
                'content-type': 'image/png',
                'content-length': '12',
                etag: '"abc123"',
              },
            }),
        ),
      );

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/get', {
          binding: 'STORAGE',
          key: 'avatar.png',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('etag')).toBe('"abc123"');
      expect(await res.text()).toBe('file-content');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/my-bucket/objects/avatar.png',
        expect.objectContaining({
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
    });

    it('returns null for missing object (404)', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => new Response('Not Found', { status: 404 })));

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/get', {
          binding: 'STORAGE',
          key: 'missing.txt',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/r2/get', {
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
        post('/r2/get', { binding: 'STORAGE', projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  describe('POST /r2/put', () => {
    it('does not replay a conditional write through REST when an old worker returns 404', async () => {
      const env = createEnv();
      env.API.fetch = vi.fn(async () =>
        Response.json({ workerName: 'old-worker', deploymentId: 'old' }),
      );
      const dispatchFetch = vi.fn(async () => new Response('Not Found', { status: 404 }));
      env.DISPATCH.get = vi.fn(() => ({ fetch: dispatchFetch })) as never;
      const fetchMock = vi.fn();
      globalThis.fetch = asFetchMock(fetchMock);
      const response = await worker.fetch(
        post('/r2/put-conditional', {
          projectId: 'proj_000000000001',
          aiToken: token,
          binding: 'STORAGE',
          key: 'key',
          value: 'new',
          onlyIf: { etagMatches: 'old' },
        }),
        env,
      );
      expect(response.status).toBe(501);
      expect(dispatchFetch).toHaveBeenCalledWith(
        'https://worker/__void/r2/put-conditional',
        expect.anything(),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects conditional writes without a compatible deployed worker before REST fallback', async () => {
      const fetchMock = vi.fn(async () => Response.json({ success: true }));
      globalThis.fetch = asFetchMock(fetchMock);
      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'bucket' });
      const res = await worker.fetch(
        post('/r2/put-conditional', {
          projectId: 'proj_000000000001',
          aiToken: token,
          binding: 'STORAGE',
          key: 'key',
          value: 'new',
          onlyIf: { etagMatches: 'old' },
        }),
        env,
      );
      expect(res.status).toBe(501);
      expect(await res.text()).toContain('conditional');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('writes base64-encoded data via CF R2 API', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const base64 = btoa('hello world');
      const res = await worker.fetch(
        post('/r2/put', {
          binding: 'STORAGE',
          key: 'test.txt',
          base64,
          contentType: 'text/plain',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/r2/buckets/my-bucket/objects/test.txt'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('writes text value when no base64', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/put', {
          binding: 'STORAGE',
          key: 'hello.txt',
          value: 'hello',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/r2/put', {
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

  describe('POST /r2/delete', () => {
    it('deletes single key', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/delete', {
          binding: 'STORAGE',
          key: 'old.txt',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/r2/buckets/my-bucket/objects/old.txt'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('deletes multiple keys', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => Response.json({ success: true })));

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/delete', {
          binding: 'STORAGE',
          keys: ['a.txt', 'b.txt'],
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns 400 when no key or keys provided', async () => {
      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/delete', {
          binding: 'STORAGE',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  describe('POST /r2/list', () => {
    it('lists objects via CF R2 API', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(async () =>
          Response.json({
            success: true,
            result: [
              { key: 'file1.txt', size: 100, last_modified: '2026-01-01T00:00:00Z' },
              { key: 'file2.txt', size: 200, last_modified: '2026-01-02T00:00:00Z' },
            ],
            result_info: {},
          }),
        ),
      );

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/list', {
          binding: 'STORAGE',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json<{
        objects: Array<{ key: string; size: number }>;
        truncated: boolean;
      }>();
      expect(data.objects).toHaveLength(2);
      expect(data.objects[0].key).toBe('file1.txt');
      expect(data.truncated).toBe(false);
    });

    it('returns cursor when truncated', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(async () =>
          Response.json({
            success: true,
            result: [{ key: 'a.txt', size: 1, last_modified: '2026-01-01T00:00:00Z' }],
            result_info: { cursor: 'next-page' },
          }),
        ),
      );

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/list', {
          binding: 'STORAGE',
          prefix: 'uploads/',
          limit: 1,
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json<{ truncated: boolean; cursor: string }>();
      expect(data.truncated).toBe(true);
      expect(data.cursor).toBe('next-page');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/prefix=uploads%2F.*per_page=1/),
        expect.any(Object),
      );
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/r2/list', {
          binding: 'MISSING',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(404);
    });
  });

  describe('POST /r2/head', () => {
    it('returns object metadata', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(
          async () =>
            new Response(null, {
              status: 200,
              headers: {
                'content-type': 'image/png',
                'content-length': '12345',
                etag: '"abc"',
                'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT',
              },
            }),
        ),
      );

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/head', {
          binding: 'STORAGE',
          key: 'avatar.png',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json<{
        key: string;
        size: number;
        etag: string;
        contentType: string;
      }>();
      expect(data.key).toBe('avatar.png');
      expect(data.size).toBe(12_345);
      expect(data.etag).toBe('"abc"');
      expect(data.contentType).toBe('image/png');
    });

    it('returns null for missing object', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => new Response(null, { status: 404 })));

      const env = createEnv({ 'proj_000000000001:r2:STORAGE': 'my-bucket' });
      const res = await worker.fetch(
        post('/r2/head', {
          binding: 'STORAGE',
          key: 'missing.txt',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });

    it('returns 400 when key is missing', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/r2/head', { binding: 'STORAGE', projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
    });
  });
});
