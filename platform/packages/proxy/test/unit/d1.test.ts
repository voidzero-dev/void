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
      // resolve-worker endpoint (no body)
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

// DISPATCH mock that always throws (simulates no deployed worker — forces REST API fallback)
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

// --- CF D1 API mock response ---

function cfD1Response(results: Array<unknown>, meta?: Record<string, unknown>) {
  return Response.json({
    success: true,
    result: [{ results, success: true, meta: meta ?? { duration: 0.001 } }],
  });
}

function asFetchMock(mock: unknown): typeof fetch {
  return mock as typeof fetch;
}

// --- Tests ---

describe('D1 proxy endpoints', () => {
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

  describe('POST /d1/query', () => {
    it("forwards query to CF D1 API and returns 'all' results", async () => {
      const rows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      globalThis.fetch = asFetchMock(vi.fn(async () => cfD1Response(rows)));

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT * FROM users',
          params: [],
          method: 'all',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: Array<unknown>; success: boolean };
      expect(data.results).toEqual(rows);
      expect(data.success).toBe(true);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/d1-uuid-abc/query',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT * FROM users', params: [] }),
        }),
      );
    });

    it('returns first row for method=first', async () => {
      const rows = [{ id: 1, name: 'Alice' }];
      globalThis.fetch = asFetchMock(vi.fn(async () => cfD1Response(rows)));

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT * FROM users WHERE id = ?',
          params: [1],
          method: 'first',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 1, name: 'Alice' });
    });

    it('returns null for method=first with no results', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => cfD1Response([])));

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT * FROM users WHERE id = ?',
          params: [999],
          method: 'first',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });

    it('returns raw format for method=raw', async () => {
      const rows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
      globalThis.fetch = asFetchMock(vi.fn(async () => cfD1Response(rows)));

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT * FROM users',
          method: 'raw',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { columns: Array<string>; results: Array<Array<unknown>> };
      expect(data.columns).toEqual(['id', 'name']);
      expect(data.results).toEqual([
        [1, 'Alice'],
        [2, 'Bob'],
      ]);
    });

    it('returns success+meta for method=run', async () => {
      const meta = { duration: 0.002, changes: 1 };
      globalThis.fetch = asFetchMock(vi.fn(async () => cfD1Response([], meta)));

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'UPDATE users SET name = ? WHERE id = ?',
          params: ['Charlie', 1],
          method: 'run',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; meta: Record<string, unknown> };
      expect(data.success).toBe(true);
      expect(data.meta).toEqual(meta);
    });

    it('returns 404 for unknown binding', async () => {
      const env = createEnv({}); // no resources
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'MISSING',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown binding "MISSING"' });
    });

    it('returns 400 when binding or sql is missing', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/d1/query', { method: 'all', projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'binding and sql required' });
    });

    it('returns 502 when CF API fails', async () => {
      globalThis.fetch = asFetchMock(
        vi.fn(async () => new Response('Internal Server Error', { status: 500 })),
      );

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/query', {
          binding: 'DB',
          sql: 'SELECT 1',
          method: 'all',
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(502);
    });
  });

  describe('POST /d1/batch', () => {
    it('fails before writing when the active deployment has no native batch handler', async () => {
      globalThis.fetch = asFetchMock(vi.fn(async () => cfD1Response([{ count: 1 }])));

      const env = createEnv({ 'proj_000000000001:d1:DB': 'd1-uuid-abc' });
      const res = await worker.fetch(
        post('/d1/batch', {
          binding: 'DB',
          statements: [
            { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Alice'] },
            { sql: 'INSERT INTO users (name) VALUES (?)', params: ['Bob'] },
          ],
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: 'atomic D1 batch unavailable for active deployment',
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('returns 400 when statements is missing', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/d1/batch', { binding: 'DB', projectId: 'proj_000000000001', aiToken: token }),
        env,
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'binding and statements required' });
    });

    it('does not use resource REST fallback for an unknown native binding', async () => {
      const env = createEnv({});
      const res = await worker.fetch(
        post('/d1/batch', {
          binding: 'MISSING',
          statements: [{ sql: 'SELECT 1' }],
          projectId: 'proj_000000000001',
          aiToken: token,
        }),
        env,
      );

      expect(res.status).toBe(503);
    });
  });
});
