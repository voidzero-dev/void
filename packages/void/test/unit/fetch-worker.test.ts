import { AsyncLocalStorage } from 'node:async_hooks';
import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import { compileWorkerClient } from '../../src/router/compile.ts';
import { FetchError as RuntimeFetchError } from '../../src/runtime/fetch-error.ts';
import { createServerFetch } from '../../src/runtime/fetch-server.ts';

describe('compileWorkerClient', () => {
  it('wires the server runtime to the app and request context', () => {
    const code = compileWorkerClient('/resolved/auth-client.mjs');
    expect(code).toContain('import app, { requestContext } from "virtual:void-routes"');
    expect(code).toContain('import { env } from "cloudflare:workers"');
    expect(code).toContain('import { createServerFetch }');
    expect(code).toContain('export { FetchError }');
    expect(code).toContain('export const fetch = createServerFetch(');
  });

  it('re-exports auth helpers from resolved path', () => {
    const code = compileWorkerClient('/my/path/auth-client.mjs');
    expect(code).toContain('export { auth, createAuthClient } from "/my/path/auth-client.mjs"');
  });
});

// Evaluate the emitted module with only its import boundary substituted.
describe('worker fetch runtime behavior', () => {
  const requestContext = new AsyncLocalStorage<{
    request: Request;
    executionCtx: {
      waitUntil: (...args: Array<unknown>) => void;
      passThroughOnException: () => void;
    };
  }>();

  // Mock app.fetch — records calls and returns configurable responses
  let mockAppFetch: ReturnType<typeof vi.fn<(...args: Array<unknown>) => Promise<Response>>>;
  let mockEnv: Record<string, unknown>;

  let workerFetch: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  let FetchError: typeof RuntimeFetchError;

  beforeEach(() => {
    mockAppFetch = vi.fn();
    mockEnv = { DB: {} };
    ({ fetch: workerFetch, FetchError } = evaluateClient(
      compileWorkerClient,
      mockAppFetch,
      mockEnv,
      requestContext,
    ));
  });

  it('makes a GET request by default', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await workerFetch('/api/hello');

    expect(result).toEqual({ ok: true });
    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe('GET');
    expect(new URL(req.url).pathname).toBe('/api/hello');
  });

  it('builds query string', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/users', { query: { page: '1', limit: '10' } });

    const req = mockAppFetch.mock.calls[0][0] as Request;
    const url = new URL(req.url);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('serializes body as JSON', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ created: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/users', { method: 'POST', body: { name: 'Alice' } });

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toBe('application/json');
    expect(await req.json()).toEqual({ name: 'Alice' });
  });

  it('throws FetchError on non-OK response', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const err = await workerFetch('/api/hello').catch((e: Error) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as RuntimeFetchError).status).toBe(404);
    expect((err as RuntimeFetchError).statusText).toBe('Not Found');
    expect((err as RuntimeFetchError).data).toEqual({ error: 'not found' });
  });

  it('returns undefined for 204 No Content', async () => {
    mockAppFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await workerFetch('/api/items/:id', { method: 'DELETE', params: { id: '1' } });
    expect(result).toBeUndefined();
  });

  it('returns text for non-JSON responses', async () => {
    mockAppFetch.mockResolvedValue(
      new Response('Hello World', {
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await workerFetch('/api/hello');
    expect(result).toBe('Hello World');
  });

  it('forwards cookie from outer request via ALS', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outerRequest = new Request('http://example.com', {
      headers: { cookie: 'session=abc123' },
    });

    await requestContext.run(
      {
        request: outerRequest,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
      () => workerFetch('/api/hello'),
    );

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('cookie')).toBe('session=abc123');
  });

  it('forwards authorization from outer request via ALS', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outerRequest = new Request('http://example.com', {
      headers: { authorization: 'Bearer token123' },
    });

    await requestContext.run(
      {
        request: outerRequest,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
      () => workerFetch('/api/hello'),
    );

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer token123');
  });

  it('user headers override forwarded headers', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outerRequest = new Request('http://example.com', {
      headers: { cookie: 'outer=old', authorization: 'Bearer outer' },
    });

    await requestContext.run(
      {
        request: outerRequest,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
      },
      () =>
        workerFetch('/api/hello', {
          headers: { cookie: 'custom=value', authorization: 'Bearer custom' },
        }),
    );

    const req = mockAppFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('cookie')).toBe('custom=value');
    expect(req.headers.get('authorization')).toBe('Bearer custom');
  });

  it('passes real executionCtx from ALS', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const waitUntilFn = vi.fn();
    const ctx = { waitUntil: waitUntilFn, passThroughOnException() {} };
    const outerRequest = new Request('http://example.com');

    await requestContext.run({ request: outerRequest, executionCtx: ctx }, () =>
      workerFetch('/api/hello'),
    );

    const passedCtx = mockAppFetch.mock.calls[0][2];
    expect(passedCtx).toBe(ctx);
  });

  it('uses no-op executionCtx when ALS has no context', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/hello');

    const passedCtx = mockAppFetch.mock.calls[0][2] as {
      waitUntil: () => void;
      passThroughOnException: () => void;
    };
    expect(passedCtx.waitUntil).toBeTypeOf('function');
    expect(passedCtx.passThroughOnException).toBeTypeOf('function');
    // Should not throw
    passedCtx.waitUntil();
    passedCtx.passThroughOnException();
  });

  it('passes env from worker bindings', async () => {
    mockAppFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await workerFetch('/api/hello');

    const passedEnv = mockAppFetch.mock.calls[0][1];
    expect(passedEnv).toBe(mockEnv);
  });
});

function evaluateClient(
  compile: typeof compileWorkerClient,
  fetch: (...args: Array<unknown>) => Promise<Response>,
  env: Record<string, unknown>,
  requestContext: Pick<AsyncLocalStorage<unknown>, 'getStore'>,
): {
  fetch: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  FetchError: typeof RuntimeFetchError;
} {
  const code = compile('/auth.mjs')
    .replace(/^(import .*|export \{.*)\n/gm, '')
    .replaceAll('export ', '');
  return new Function(
    'app',
    'env',
    'requestContext',
    'createServerFetch',
    'FetchError',
    code + '\nreturn { fetch, FetchError };',
  )({ fetch }, env, requestContext, createServerFetch, RuntimeFetchError);
}

describe.each([false, true])('server fetch documented options (nodeTarget: %s)', (nodeTarget) => {
  let app: Hono;
  let requestContext: AsyncLocalStorage<{ request: Request }>;
  let dispatch: ReturnType<typeof vi.fn<(...args: Array<unknown>) => Promise<Response>>>;
  let client: ReturnType<typeof evaluateClient>;

  beforeEach(() => {
    app = new Hono();
    requestContext = new AsyncLocalStorage();
    dispatch = vi.fn(async (...args: Array<unknown>) => app.fetch(args[0] as Request));
    client = evaluateClient(
      (authClientPath) => compileWorkerClient(authClientPath, nodeTarget),
      dispatch,
      {},
      requestContext,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('prepends a relative baseURL to the route path', async () => {
    app.get('/api/hello', (c) => c.json({ path: c.req.path }));
    app.get('/prefix/api/hello', (c) => c.json({ path: c.req.path }));

    await expect(client.fetch('/api/hello', { baseURL: '/prefix' })).resolves.toEqual({
      path: '/prefix/api/hello',
    });
  });

  it('rejects an already-aborted signal without dispatching the handler', async () => {
    app.get('/api/hello', (c) => c.json({ ok: true }));

    await expect(client.fetch('/api/hello', { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects invalid route params through the returned promise', async () => {
    await expect(client.fetch('/api/users/:id', { params: { id: '..' } })).rejects.toThrow(
      'would change the request path',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])('times out a slow handler (caller signal: %s)', async (withSignal) => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    app.get('/api/slow', async (c) => {
      await pending;
      return c.json({ ok: true });
    });
    try {
      await expect(
        client.fetch('/api/slow', {
          timeout: 10,
          retry: 0,
          signal: withSignal ? new AbortController().signal : undefined,
        }),
      ).rejects.toMatchObject({
        name: 'FetchError',
        cause: { name: 'TimeoutError' },
      });
    } finally {
      finish();
    }
  });

  it('aborts an in-flight handler without retrying', async () => {
    const controller = new AbortController();
    app.get('/api/slow', async (c) => {
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return c.json({ ok: true });
    });

    const result = client.fetch('/api/slow', { signal: controller.signal, retry: 2 });
    controller.abort();

    await expect(result).rejects.toMatchObject({
      name: 'FetchError',
      cause: { name: 'AbortError' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
  });

  it.each([
    { retry: undefined, attempts: 2 },
    { retry: 2, attempts: 3 },
  ])(
    'makes $attempts GET attempts on a 503 response (retry: $retry)',
    async ({ retry, attempts }) => {
      let count = 0;
      app.get('/api/unavailable', (c) => c.json({ attempts: ++count }, 503));
      const result = client
        .fetch('/api/unavailable', retry === undefined ? undefined : { retry })
        .catch((error: RuntimeFetchError) => error);

      const error = (await result) as RuntimeFetchError;

      expect(dispatch).toHaveBeenCalledTimes(attempts);
      expect(error).toBeInstanceOf(client.FetchError);
      expect(error.status).toBe(503);
      expect(error.data).toEqual({ attempts });
    },
  );

  it('preserves the raw HTTP response on FetchError', async () => {
    const response = Response.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'x-request-id': 'request-477' } },
    );
    app.get('/api/unavailable', () => response);

    const error = (await client
      .fetch('/api/unavailable', { retry: 0 })
      .catch((error: RuntimeFetchError) => error)) as RuntimeFetchError;

    expect(error).toBeInstanceOf(client.FetchError);
    expect(error.status).toBe(503);
    expect(error.data).toEqual({ error: 'unavailable' });
    expect(error.response).toBe(response);
    expect(error.response?.headers.get('x-request-id')).toBe('request-477');
  });

  it('does not retry POST requests by default', async () => {
    app.post('/api/users', (c) => c.json({ error: 'unavailable' }, 503));

    await expect(
      client.fetch('/api/users', { method: 'POST', body: { name: 'Alice' } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves the JSON body when explicitly retrying a POST', async () => {
    const bodies: Array<unknown> = [];
    app.post('/api/users', async (c) => {
      bodies.push(await c.req.json());
      return c.json({ created: bodies.length === 2 }, bodies.length === 1 ? 503 : 201);
    });

    await expect(
      client.fetch('/api/users', {
        method: 'POST',
        body: { name: 'Alice' },
        retry: 1,
      }),
    ).resolves.toEqual({ created: true });
    expect(bodies).toEqual([{ name: 'Alice' }, { name: 'Alice' }]);
  });

  it('uses HTTP for external base URLs without forwarding ambient credentials', async () => {
    const networkFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ok: true }));
    const request = new Request('https://app.example/ssr', {
      headers: { cookie: 'session=secret', authorization: 'Bearer secret' },
    });

    await requestContext.run({ request }, () =>
      client.fetch('/api/hello', {
        baseURL: 'https://external.example/prefix',
        headers: { 'x-api-key': 'explicit' },
      }),
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(networkFetch).toHaveBeenCalledTimes(1);
    const external = networkFetch.mock.calls[0]![0] as Request;
    expect(external.url).toBe('https://external.example/prefix/api/hello');
    expect(external.headers.get('cookie')).toBeNull();
    expect(external.headers.get('authorization')).toBeNull();
    expect(external.headers.get('x-api-key')).toBe('explicit');
  });

  it('dispatches same-origin base URLs internally with the current credentials', async () => {
    app.get('/prefix/api/hello', (c) => c.json({ cookie: c.req.header('cookie') }));
    const request = new Request('https://app.example/ssr', {
      headers: { cookie: 'session=secret' },
    });

    await expect(
      requestContext.run({ request }, () =>
        client.fetch('/api/hello', {
          baseURL: 'https://app.example/prefix',
        }),
      ),
    ).resolves.toEqual({ cookie: 'session=secret' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

it.each([false, true])(
  'expands catch-all routes in generated clients (nodeTarget: %s)',
  async (nodeTarget) => {
    const fetch = vi.fn<(...args: Array<unknown>) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );
    const compile = (authClientPath: string) => compileWorkerClient(authClientPath, nodeTarget);
    const client = evaluateClient(compile, fetch, {}, new AsyncLocalStorage());
    await client.fetch('/files/:id2/:id/:path{.+}', {
      params: { id: 'one', id2: 'two', path: 'docs/start here' },
    });
    const req = fetch.mock.calls[0]![0] as Request;
    expect(new URL(req.url).pathname).toBe('/files/two/one/docs/start%20here');
  },
);
