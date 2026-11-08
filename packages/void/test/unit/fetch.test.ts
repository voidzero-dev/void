import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import { fetch as typedFetch, FetchError } from '../../src/runtime/fetch.ts';

declare module 'void/routes' {
  interface RouteMap {
    '/api/users/[id]': RouteMap['/api/users/:id'];
    '/api/files/[...path]': RouteMap['/api/files/:path{.+}'];
    '/api/hello': {
      GET: { input: {}; output: { ok: boolean } };
    };
    '/api/users': {
      GET: { input: {}; output: Array<{ id: string; name: string }> };
      POST: { input: { body: { name: string } }; output: { created: boolean } };
    };
    '/api/users/:id': {
      GET: { input: { params: { id: string } }; output: { id: string; name: string } };
    };
    '/api/files/:path{.+}': {
      GET: { input: { params: { path: string } }; output: unknown };
    };
    '/api/items/:id': {
      GET: { input: {}; output: { id: string } };
      DELETE: { input: {}; output: undefined };
    };
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

describe('typed fetch client', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('makes a GET request by default', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ ok: true }));

    const result = await typedFetch('/api/hello');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/hello',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({ ok: true });
  });

  it.each(['/api/files/[...path]', '/api/files/:path{.+}'] as const)(
    'expands catch-all tokens in %s',
    async (path) => {
      vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}));
      await typedFetch(path, { params: { path: 'docs/start here' } });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/files/docs/start%20here',
        expect.anything(),
      );
    },
  );

  it('interpolates bracket parameters for typed requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ id: 'a/b', name: 'Alice' }));
    const result = await typedFetch('/api/users/[id]', { params: { id: 'a/b' } });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/users/a%2Fb', expect.anything());
    expect(result).toEqual({ id: 'a/b', name: 'Alice' });
  });

  it('builds query string', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse([]));

    await typedFetch('/api/users', { query: { page: '1', limit: '10' } });

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('page=1');
    expect(url).toContain('limit=10');
  });

  it('serializes body as JSON', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({ created: true }, 201));

    await typedFetch('/api/users', { method: 'POST', body: { name: 'Alice' } });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Alice' }));
    expect(new Headers(init.headers!).get('Content-Type')).toBe('application/json');
  });

  it('throws FetchError on non-OK response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    const err = await typedFetch('/api/hello', { retry: 0 }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).status).toBe(404);
  });

  it('returns undefined for 204 No Content', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const result = await typedFetch('/api/items/:id', { method: 'DELETE', params: { id: '1' } });
    expect(result).toBeUndefined();
  });
});
