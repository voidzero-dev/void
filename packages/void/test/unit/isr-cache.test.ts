import {
  deleteIsrCache,
  denormalizeIsrPath,
  handleFrameworkIsr,
  handleIsr,
  hostRegistryKey,
  htmlEdgeKey,
  isrKey,
  isrPrefix,
  isStale,
  jsonEdgeKey,
  listIsrHosts,
  markSharedCachePolicy,
  normalizeIsrPath,
  packIsrValue,
  readIsrCache,
  SHARED_CACHE_POLICY_VERSION,
  writeIsrCache,
  type IsrCacheEnv,
  type IsrCacheMetadata,
  type RenderFn,
} from '@void/isr/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';

// Collapsed self-host deployment id (baked as a compile-time literal on the real
// worker). Every key in this suite is scoped by the shared v3 protocol.
const DPL = '11111111-1111-4111-8111-111111111111';
const HOST = 'app.void.app';
// A fixed, realistic epoch so `Date.now()` (faked) is deterministic.
const BASE = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// In-memory KV mock (getWithMetadata/put/delete/list with cursor pagination).
// Real behavior: `store` is the authoritative backing map, so assertions read
// actual cache contents rather than merely "the mock was called".
// ---------------------------------------------------------------------------

type KvRecord = { value: ArrayBuffer; metadata: IsrCacheMetadata | null };

function createKvMock(opts: { throwOnGet?: boolean } = {}) {
  const store = new Map<string, KvRecord>();
  const getWithMetadata = vi.fn(async (key: string, _type: 'arrayBuffer') => {
    if (opts.throwOnGet) {
      throw new Error('KV unavailable');
    }
    const rec = store.get(key);
    return rec ? { value: rec.value, metadata: rec.metadata } : { value: null, metadata: null };
  });
  const put = vi.fn(
    async (key: string, value: ArrayBuffer, options?: { metadata?: IsrCacheMetadata }) => {
      store.set(key, { value, metadata: options?.metadata ?? null });
    },
  );
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const list = vi.fn(async (o: { prefix?: string; cursor?: string; limit?: number } = {}) => {
    const prefix = o.prefix ?? '';
    const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const limit = o.limit ?? 1000;
    const start = o.cursor ? Number.parseInt(o.cursor, 10) : 0;
    const slice = all.slice(start, start + limit);
    const complete = start + limit >= all.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? '' : String(start + limit),
    };
  });
  const kv = { getWithMetadata, put, delete: del, list } as unknown as KVNamespace;
  return { store, kv, getWithMetadata, put, delete: del, list };
}

function makeEnv(kv: KVNamespace): IsrCacheEnv {
  return { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL };
}

function packEntry(headers: Record<string, string>, body: string): ArrayBuffer {
  return packIsrValue(headers, new TextEncoder().encode(body).buffer as ArrayBuffer);
}

function seedEntry(
  store: Map<string, KvRecord>,
  path: string,
  {
    headers = { 'content-type': 'text/html' },
    body = '<html>cached</html>',
    status = 200,
    createdAt,
    ttl = 60,
    value,
  }: {
    headers?: Record<string, string>;
    body?: string;
    status?: number;
    createdAt: number;
    ttl?: number;
    value?: ArrayBuffer;
  },
): void {
  store.set(isrKey(DPL, HOST, path), {
    value: value ?? packEntry(headers, body),
    metadata: { s: status, c: createdAt, t: ttl, p: SHARED_CACHE_POLICY_VERSION },
  });
}

// ---------------------------------------------------------------------------
// Fake per-colo edge cache (caches.default): match/put/delete over string keys.
// ---------------------------------------------------------------------------

function createEdgeMock() {
  const store = new Map<string, Response>();
  const match = vi.fn(async (key: string | Request) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    const res = store.get(k);
    // Real Cache.match hands back a fresh Response each call.
    return res ? res.clone() : undefined;
  });
  const put = vi.fn(async (key: string | Request, response: Response) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    store.set(k, response);
  });
  const del = vi.fn(async (key: string | Request) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    return store.delete(k);
  });
  const cache = { match, put, delete: del } as unknown as Cache;
  return { store, cache, match, put, delete: del };
}

function createCtx() {
  const tasks: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    tasks,
    flush: async () => {
      await Promise.all(tasks);
    },
  };
}

function createRender(makeResponse: (req: Request) => Response) {
  const requests: Array<Request> = [];
  const spy = vi.fn(async (req: Request) => {
    requests.push(req);
    return makeResponse(req);
  });
  return { render: spy as unknown as RenderFn, spy, requests };
}

function currentSharedCacheResponse(response: Response): Response {
  markSharedCachePolicy(response.headers);
  return response;
}

// KV entries that cannot build a valid Response. `readIsrCache` must reject
// each one, so a cache hit never throws.
const corruptCases: Array<{ name: string; seed: () => KvRecord }> = [
  {
    name: 'entry admitted before Vary was checked',
    seed: () => ({
      value: packEntry({ vary: 'Accept-Language' }, 'English'),
      metadata: { s: 200, c: BASE, t: 60, p: 2 } as unknown as IsrCacheMetadata,
    }),
  },
  {
    name: 'legacy entry missing shared-cache policy version',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: 60 } as unknown as IsrCacheMetadata,
    }),
  },
  {
    name: 'status out of range (s: 999)',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 999, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'status out of range (s: 0)',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 0, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'invalid header name',
    seed: () => ({
      value: packEntry({ 'Invalid Header Name': 'x' }, 'x'),
      metadata: { s: 200, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'createdAt NaN',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: NaN, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'createdAt Infinity',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: Infinity, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'createdAt negative',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: -1, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'ttl NaN',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: NaN, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'ttl zero',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: 0, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'ttl negative',
    seed: () => ({
      value: packEntry({}, 'x'),
      metadata: { s: 200, c: BASE, t: -5, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
  {
    name: 'malformed packed value',
    seed: () => ({
      value: new ArrayBuffer(2),
      metadata: { s: 200, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION },
    }),
  },
];

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('normalizeIsrPath / denormalizeIsrPath', () => {
  it('maps root to __index__ and back', () => {
    expect(normalizeIsrPath('/')).toBe('__index__');
    expect(denormalizeIsrPath('__index__')).toBe('/');
  });

  it('strips leading and trailing slashes', () => {
    expect(normalizeIsrPath('/about')).toBe('about');
    expect(normalizeIsrPath('/about/')).toBe('about');
    expect(normalizeIsrPath('/blog/hello-world')).toBe('blog/hello-world');
  });

  it('round-trips non-root paths', () => {
    for (const p of ['/', '/about', '/blog/hello']) {
      expect(denormalizeIsrPath(normalizeIsrPath(p))).toBe(p);
    }
  });
});

describe('collapsed self-host cache keys', () => {
  it('uses the shared v3 protocol scoped by deployment id and host', () => {
    expect(isrKey(DPL, HOST, '/')).toBe(`${isrPrefix(DPL)}${HOST}/__index__`);
    expect(isrKey(DPL, HOST, '/blog/x')).toBe(`${isrPrefix(DPL)}${HOST}/blog/x`);
    expect(isrKey(DPL, HOST, '/about/')).toBe(`${isrPrefix(DPL)}${HOST}/about`);
  });

  it('host-scopes the KV key: different hosts never share a cache key', () => {
    expect(isrKey(DPL, 'foo.example', '/x')).not.toBe(isrKey(DPL, 'bar.example', '/x'));
    expect(isrKey(DPL, 'foo.example', '/x')).toBe(`${isrPrefix(DPL)}foo.example/x`);
  });

  it('builds the host-registry key (void-isr-hosts/<id>/<host>), distinct from the cache prefix', () => {
    expect(hostRegistryKey(DPL, HOST)).toBe(`void-isr-hosts/${DPL}/${HOST}`);
    // The registry prefix must NOT collide with the cache prefix, or an `{ all }`
    // list (the shared v3 deployment prefix) would enumerate registry keys as cache keys.
    expect(hostRegistryKey(DPL, HOST).startsWith(isrPrefix(DPL))).toBe(false);
  });

  it('builds HTML edge keys with the deployment id and a canonical pathname', () => {
    expect(htmlEdgeKey(HOST, '/about', DPL)).toBe(`https://${HOST}/about?__void_isr=${DPL}`);
    // Trailing slash canonicalized (matches normalizeIsrPath).
    expect(htmlEdgeKey(HOST, '/about/', DPL)).toBe(`https://${HOST}/about?__void_isr=${DPL}`);
    // Root keeps its slash.
    expect(htmlEdgeKey(HOST, '/', DPL)).toBe(`https://${HOST}/?__void_isr=${DPL}`);
  });

  it('builds JSON edge keys with the shared variant ordering', () => {
    expect(jsonEdgeKey(HOST, '/about', DPL)).toBe(
      `https://${HOST}/about?__void=json&__void_isr=${DPL}`,
    );
  });
});

// ===========================================================================
// KV cache: write / read round-trip, delete, and corrupt-entry fail-open
// ===========================================================================

describe('writeIsrCache / readIsrCache / deleteIsrCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a packed entry to KV and reads it back with status/headers/ttl/body', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    await writeIsrCache(
      env,
      HOST,
      '/blog/post',
      new Response('<html>fresh</html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': 'sid=secret', 'cache-control': 'no' },
      }),
      60,
    );

    expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(true);
    const meta = store.get(isrKey(DPL, HOST, '/blog/post'))!.metadata!;
    expect(meta).toEqual({ s: 200, c: BASE, t: 60, p: SHARED_CACHE_POLICY_VERSION });

    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe(200);
    expect(entry!.ttl).toBe(60);
    expect(entry!.createdAt).toBe(BASE);
    expect(entry!.headers['content-type']).toBe('text/html');
    // serializeHeaders strips cache-control/set-cookie before persisting.
    expect(entry!.headers['set-cookie']).toBeUndefined();
    expect(entry!.headers['cache-control']).toBeUndefined();
    expect(await new Response(entry!.body).text()).toBe('<html>fresh</html>');
  });

  it('returns null on a cache miss', async () => {
    const { kv } = createKvMock();
    expect(await readIsrCache(makeEnv(kv), HOST, '/nope')).toBeNull();
  });

  it('deleteIsrCache removes the entry', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/gone', { createdAt: BASE });
    expect(store.has(isrKey(DPL, HOST, '/gone'))).toBe(true);
    await deleteIsrCache(env, HOST, '/gone');
    expect(store.has(isrKey(DPL, HOST, '/gone'))).toBe(false);
  });

  it('fails open to null when getWithMetadata throws (never surfaces the error)', async () => {
    const { kv } = createKvMock({ throwOnGet: true });
    await expect(readIsrCache(makeEnv(kv), HOST, '/x')).resolves.toBeNull();
  });

  for (const c of corruptCases) {
    it(`readIsrCache returns null for a corrupt entry: ${c.name}`, async () => {
      const { store, kv } = createKvMock();
      store.set(isrKey(DPL, HOST, '/p'), c.seed());
      await expect(readIsrCache(makeEnv(kv), HOST, '/p')).resolves.toBeNull();
    });
  }
});

// ===========================================================================
// handleIsr — the cache ladder end to end
// ===========================================================================

describe('handleIsr', () => {
  let edge: ReturnType<typeof createEdgeMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    edge = createEdgeMock();
    vi.stubGlobal('caches', { default: edge.cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const OPTS = { revalidate: 60, deploymentId: DPL };

  function htmlRequest(path = '/blog/post', headers: Record<string, string> = {}) {
    return new Request(`https://${HOST}${path}`, { method: 'GET', headers });
  }

  it('caches framework documents but never serves their HTML to data requests', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(
      async () => new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const document = htmlRequest('/news', { Accept: 'text/html' });
    const first = createCtx();
    expect(
      (await handleFrameworkIsr(document, env, first.ctx, OPTS, render))?.headers.get(
        'x-isr-cache',
      ),
    ).toBe('MISS');
    await first.flush();
    expect(store.has(isrKey(DPL, HOST, '/news'))).toBe(true);
    expect(await readIsrCache(env, HOST, '/news')).not.toBeNull();
    expect(edge.store.has(htmlEdgeKey(HOST, '/news', DPL))).toBe(true);

    const second = createCtx();
    expect(
      (await handleFrameworkIsr(document, env, second.ctx, OPTS, render))?.headers.get(
        'x-isr-cache',
      ),
    ).toBe('HIT');
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      await handleFrameworkIsr(
        htmlRequest('/news', { Accept: 'application/json' }),
        env,
        second.ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
    expect(
      await handleFrameworkIsr(
        htmlRequest('/news', { Accept: 'text/html', 'Sec-Fetch-Dest': 'empty' }),
        env,
        second.ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
  });

  it('does not cache framework JSON returned from a document path', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(async () => Response.json({ data: 'private' }));
    const ctx = createCtx();
    const response = await handleFrameworkIsr(
      htmlRequest('/news', { Accept: 'text/html' }),
      env,
      ctx.ctx,
      OPTS,
      render,
    );
    await ctx.flush();
    expect(response?.headers.get('x-isr-cache')).toBeNull();
    expect(store.has(isrKey(DPL, HOST, '/news'))).toBe(false);
  });

  it('evicts stale framework HTML when the fresh render is no longer HTML', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/news', { createdAt: BASE - 120_000 });
    const render = vi.fn(async () => Response.json({ data: true }));
    const ctx = createCtx();
    const stale = await handleFrameworkIsr(
      htmlRequest('/news', { Accept: 'text/html' }),
      env,
      ctx.ctx,
      OPTS,
      render,
    );
    expect(stale?.headers.get('x-isr-cache')).toBe('STALE');
    await ctx.flush();
    expect(store.has(isrKey(DPL, HOST, '/news'))).toBe(false);
  });

  it('leaves an explicitly opted-out page to the live renderer despite a conflicting flat TTL', async () => {
    const { kv } = createKvMock();
    const render = vi.fn(async () => new Response('<html>private</html>'));

    const response = await handleIsr(
      htmlRequest('/private'),
      makeEnv(kv),
      createCtx().ctx,
      {
        revalidate: { '/private': 60 },
        pages: [{ pattern: '/private', revalidate: 0 }],
        pathRevalidate: { '/private': 60 },
        deploymentId: DPL,
      },
      render,
    );

    expect(response).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it('isolates only allowlisted query variants and ignores unrelated parameters', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(async (request: Request) => {
      const q = new URL(request.url).searchParams.get('q');
      return new Response(`<html>${q}</html>`, { headers: { 'content-type': 'text/html' } });
    });
    const options = {
      ...OPTS,
      revalidate: { '/search': 60 },
      queryAllowlist: { '/search': ['q'] },
    };

    const first = createCtx();
    await handleIsr(htmlRequest('/search?q=one'), env, first.ctx, options, render);
    await first.flush();
    const second = createCtx();
    const same = await handleIsr(
      htmlRequest('/search?utm=b&q=one'),
      env,
      second.ctx,
      options,
      render,
    );
    await second.flush();
    const third = createCtx();
    await handleIsr(htmlRequest('/search?q=two'), env, third.ctx, options, render);
    await third.flush();

    expect(same!.headers.get('x-isr-cache')).toBe('HIT');
    expect(await same!.text()).toBe('<html>one</html>');
    expect(render).toHaveBeenCalledTimes(2);
    expect(store.has(isrKey(DPL, HOST, '/search', `https://${HOST}/search?q=one`))).toBe(true);
    expect(store.has(isrKey(DPL, HOST, '/search', `https://${HOST}/search?q=two`))).toBe(true);
    expect(store.has(isrKey(DPL, HOST, '/search'))).toBe(false);
  });

  it('leaves a cold key empty when the request carries a query param outside the allowlist', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const render = vi.fn(async (request: Request) => {
      const msg = new URL(request.url).searchParams.get('msg') ?? 'clean';
      return new Response(`<html>${msg}</html>`, { headers: { 'content-type': 'text/html' } });
    });

    const poisoned = createCtx();
    const response = await handleIsr(
      htmlRequest('/blog/post?msg=evil'),
      env,
      poisoned.ctx,
      OPTS,
      render,
    );
    await poisoned.flush();
    expect(response).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL)))).toEqual([]);
    expect(edge.store.size).toBe(0);

    const clean = createCtx();
    const fresh = await handleIsr(htmlRequest('/blog/post'), env, clean.ctx, OPTS, render);
    await clean.flush();
    expect(fresh!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await fresh!.text()).toBe('<html>clean</html>');
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(await new Response(entry!.body).text()).toBe('<html>clean</html>');
    expect(
      await edge.store
        .get(htmlEdgeKey(HOST, '/blog/post', DPL))!
        .clone()
        .text(),
    ).toBe('<html>clean</html>');
  });

  it('refreshes a stale entry from the cache key URL when the trigger carries an unlisted param', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { body: '<html>stale</html>', createdAt: BASE, ttl: 60 });
    vi.setSystemTime(BASE + 200_000);
    const { render, requests } = createRender((request) => {
      const msg = new URL(request.url).searchParams.get('msg') ?? 'clean';
      return new Response(`<html>${msg}</html>`, { headers: { 'content-type': 'text/html' } });
    });
    const { ctx, flush } = createCtx();

    const res = await handleIsr(
      htmlRequest('/blog/post?msg=evil', { 'X-Test-Marker': 'keep' }),
      env,
      ctx,
      OPTS,
      render,
    );
    expect(res!.headers.get('x-isr-cache')).toBe('STALE');
    expect(await res!.text()).toBe('<html>stale</html>');
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://${HOST}/blog/post`);
    expect(requests[0]!.headers.get('X-Test-Marker')).toBe('keep');
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(isStale(entry!)).toBe(false);
    expect(await new Response(entry!.body).text()).toBe('<html>clean</html>');
  });

  it('MISS → renders live, returns MISS, and writes KV + HTML edge in the background', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy } = createRender(
      () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await res!.text()).toBe('<html>live</html>');
    expect(spy).toHaveBeenCalledTimes(1);

    await flush();
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).not.toBeNull();
    expect(await new Response(entry!.body).text()).toBe('<html>live</html>');
    // Without page data the JSON variant stays cold.
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(true);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    // The host-registry key (`void-isr-hosts/…`) is not a page-cache entry.
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(1);
  });

  it.each(['Accept-Language', 'Origin', '*', 'X-VoidPages, ACCEPT-language'])(
    'renders each request live when Vary is unsupported: %s',
    async (vary) => {
      const { store, kv } = createKvMock();
      const env = makeEnv(kv);
      const { render, spy } = createRender(
        (request) =>
          new Response(request.headers.get('Accept-Language'), {
            headers: {
              'Content-Type': 'text/html',
              Vary: vary,
              'x-void-page-data': '{"component":"Home","props":{}}',
            },
          }),
      );
      for (const language of ['en', 'ja']) {
        const { ctx, flush } = createCtx();
        const response = await handleIsr(
          htmlRequest('/blog/post', { 'Accept-Language': language }),
          env,
          ctx,
          OPTS,
          render,
        );
        expect(await response!.text()).toBe(language);
        await flush();
        expect(store.size).toBe(0);
        expect(edge.store.size).toBe(0);
      }
      expect(spy).toHaveBeenCalledTimes(2);
    },
  );

  it('does not share a MISS whose render sets Set-Cookie', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    // The live render emits TWO DISTINCT Set-Cookie headers (session + CSRF).
    // A `Headers` folds duplicates, so an array init is the only way to seed both.
    const { render, spy } = createRender(
      () =>
        new Response('<html>live</html>', {
          headers: [
            ['content-type', 'text/html'],
            ['set-cookie', 'sid=secret; Path=/; HttpOnly'],
            ['set-cookie', 'csrf=tok; Path=/'],
          ],
        }),
    );
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.headers.get('x-isr-cache')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    // The client receives the authoritative response and every cookie.
    expect(res!.headers.getSetCookie()).toEqual([
      'sid=secret; Path=/; HttpOnly',
      'csrf=tok; Path=/',
    ]);

    await flush();
    // A Set-Cookie response is private to this render, so neither HTML nor its
    // embedded Pages JSON may enter a shared cache.
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).toBeNull();
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL)))).toEqual([]);
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
  });

  it('KV HIT (fresh) → serves HIT from KV without a live render and warms the edge', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { body: '<html>kv</html>', createdAt: BASE, ttl: 60 });
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('HIT');
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await res!.text()).toBe('<html>kv</html>');
    expect(spy).not.toHaveBeenCalled();

    await flush();
    const warmed = edge.store.get(htmlEdgeKey(HOST, '/blog/post', DPL));
    expect(warmed).toBeDefined();
    expect(warmed!.headers.get('x-isr-cache')).toBe('HIT');
    expect(warmed!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, max-age=0, must-revalidate',
    );
  });

  it('KV HIT (stale) → serves STALE BEFORE revalidation runs, queues it via ctx.waitUntil (background, not inline), then re-puts KV', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    // Seed a stale entry: created at BASE, now BASE+200s (> ttl 60s).
    seedEntry(store, '/blog/post', { body: '<html>stale</html>', createdAt: BASE, ttl: 60 });
    vi.setSystemTime(BASE + 200_000);

    // The render blocks until `release()`, so `handleIsr` resolves only if the
    // revalidation runs in the background rather than inline.
    const requests: Array<Request> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.fn(async (req: Request) => {
      requests.push(req);
      await gate;
      return new Response('<html>revalidated</html>', {
        headers: { 'content-type': 'text/html' },
      });
    });
    const render = spy as unknown as RenderFn;
    const { ctx, tasks, flush } = createCtx();

    const res = await handleIsr(
      htmlRequest('/blog/post', { 'X-Test-Marker': 'keep' }),
      env,
      ctx,
      OPTS,
      render,
    );

    expect(res!.headers.get('x-isr-cache')).toBe('STALE');
    expect(await res!.text()).toBe('<html>stale</html>');
    // The revalidation is the one tracked background task. A stale edge warm
    // here would race a private/no-store revalidation that evicts the old page.
    expect(tasks.length).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const midEntry = await readIsrCache(env, HOST, '/blog/post');
    expect(midEntry!.createdAt).toBe(BASE);
    expect(isStale(midEntry!)).toBe(true);
    expect(await new Response(midEntry!.body).text()).toBe('<html>stale</html>');

    release();
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    const rerender = requests[0]!;
    expect(rerender.headers.get('X-Test-Marker')).toBe('keep');
    expect(rerender.method).toBe('GET');
    expect(rerender.url).toBe(`https://${HOST}/blog/post`);

    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry!.createdAt).toBe(BASE + 200_000);
    expect(isStale(entry!)).toBe(false);
    expect(await new Response(entry!.body).text()).toBe('<html>revalidated</html>');
  });

  it('HTML edge HIT → serves the edge variant without touching KV or rendering', async () => {
    const { kv, store, getWithMetadata } = createKvMock();
    const env = makeEnv(kv);
    edge.store.set(
      htmlEdgeKey(HOST, '/blog/post', DPL),
      currentSharedCacheResponse(
        new Response('<html>edge</html>', { headers: { 'x-isr-cache': 'HIT' } }),
      ),
    );
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(await res!.text()).toBe('<html>edge</html>');
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(spy).not.toHaveBeenCalled();
    expect(getWithMetadata).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('cold-misses an edge entry written before the current privacy policy', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    const key = htmlEdgeKey(HOST, '/blog/post', DPL);
    edge.store.set(key, new Response('<html>legacy-private-body</html>'));
    const { render, spy } = createRender(
      () => new Response('<html>current-public-body</html>', { status: 200 }),
    );
    const { ctx, flush } = createCtx();

    const response = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(await response!.text()).toBe('<html>current-public-body</html>');
    expect(response!.headers.get('x-isr-cache')).toBe('MISS');
    expect(spy).toHaveBeenCalledOnce();
    await flush();

    expect(await edge.store.get(key)!.text()).toBe('<html>current-public-body</html>');
  });

  it.each([undefined, '0', String(Number(PAGES_PROTOCOL_VERSION) + 1)])(
    'lets the backend negotiate serialization version %s even with a warm JSON cache',
    async (version) => {
      const { kv } = createKvMock();
      const key = jsonEdgeKey(HOST, '/blog/post', DPL);
      const cached = Response.json({ __void: 'devalue', data: [] });
      markSharedCachePolicy(cached.headers);
      edge.store.set(key, cached);
      const { render, spy } = createRender(
        () =>
          new Response('', {
            headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
          }),
      );
      const { ctx, flush } = createCtx();
      const response = await handleIsr(
        htmlRequest('/blog/post', {
          'X-VoidPages': 'true',
          ...(version && { 'X-VoidPages-Version': version }),
        }),
        makeEnv(kv),
        ctx,
        OPTS,
        render,
      );
      await flush();
      expect(spy).toHaveBeenCalledOnce();
      expect(response!.headers.has('X-VoidPages')).toBe(false);
      expect(await response!.text()).toBe('');
      expect(edge.store.has(key)).toBe(true);
    },
  );

  it('JSON (X-VoidPages) MISS → renders live JSON and never writes the edge or KV', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy, requests } = createRender(
      () =>
        new Response('{"component":"Blog"}', { headers: { 'content-type': 'application/json' } }),
    );
    const { ctx, tasks } = createCtx();

    const res = await handleIsr(
      htmlRequest('/blog/post', {
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      }),
      env,
      ctx,
      OPTS,
      render,
    );

    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('{"component":"Blog"}');
    expect(requests[0]!.headers.has('X-VoidPages')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(0);
    expect(edge.store.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it('cached JSON variant (warmed by an HTML render) carries X-VoidPages + Vary on a later navigation HIT', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    const { render } = createRender(
      () =>
        new Response('<html>live</html>', {
          headers: {
            'content-type': 'text/html',
            'x-void-page-data': '{"component":"Blog","props":{}}',
            Vary: 'X-VoidPages, X-VoidPages-Version',
          },
        }),
    );
    const { ctx, flush } = createCtx();

    await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    await flush();
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(true);

    const { render: render2, spy: spy2 } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx: ctx2 } = createCtx();
    const res = await handleIsr(
      htmlRequest('/blog/post', {
        'X-VoidPages': 'true',
        'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      }),
      env,
      ctx2,
      OPTS,
      render2,
    );

    expect(spy2).not.toHaveBeenCalled();
    // The client parses JSON only with this header; without it the page hard-reloads.
    expect(res!.headers.get('X-VoidPages')).toBe('true');
    expect(res!.headers.get('Vary')).toBe('X-VoidPages, X-VoidPages-Version');
    expect(res!.headers.get('content-type')).toBe('application/json');
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(res!.headers.get('x-isr-cache')).toBe('HIT');
    expect(await res!.text()).toBe('{"component":"Blog","props":{}}');
  });

  it.each([
    ['getWithMetadata throws', true],
    ['the KV entry is from an older cache policy', false],
  ])('fails open to a LIVE render (not a 500) when %s', async (_, throwOnGet) => {
    const { store, kv } = createKvMock({ throwOnGet });
    store.set(isrKey(DPL, HOST, '/blog/post'), corruptCases[0]!.seed());
    const env = makeEnv(kv);
    const { render, spy } = createRender(
      () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { ctx } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await res!.text()).toBe('<html>live</html>');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe.each([handleIsr, handleFrameworkIsr])('%s removal convergence', (handle) => {
    describe.each(['text/plain', 'text/event-stream'])('with %s', (contentType) => {
      it.each([
        [404, 60, 30 * 86_400, true],
        [410, 60, 30 * 86_400, true],
        [404, 60, 120, false],
        [410, 60, 86_460, false],
        [404, 25 * 3600, 25 * 3600 + 60, false],
        [503, 60, 30 * 86_400, false],
        [429, 60, 30 * 86_400, false],
      ])('handles status %i with TTL %i and age %i', async (status, ttl, age, evicted) => {
        const { store, kv } = createKvMock();
        const env = makeEnv(kv);
        seedEntry(store, '/blog/post', { createdAt: BASE, ttl });
        vi.setSystemTime(BASE + age * 1000);
        const jsonKey = jsonEdgeKey(HOST, '/blog/post', DPL);
        edge.store.set(jsonKey, new Response('{"cached":true}'));
        const render: RenderFn = async () =>
          new Response('removed or unavailable', {
            status,
            headers: {
              'content-type': contentType,
              ...(status >= 429 ? { 'cache-control': 'no-store', 'x-revalidate': '0' } : {}),
            },
          });
        const first = createCtx();
        const request = htmlRequest('/blog/post', { Accept: 'text/html' });
        const stale = await handle(request, env, first.ctx, OPTS, render);
        expect(stale!.headers.get('x-isr-cache')).toBe('STALE');
        await first.flush();
        expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(!evicted);
        expect(edge.store.has(jsonKey)).toBe(!evicted);
        if (evicted) {
          expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/blog/post', DPL));
          const second = createCtx();
          expect((await handle(request, env, second.ctx, OPTS, render))!.status).toBe(status);
          await second.flush();
        }
      });
    });
  });

  it.each([
    ['private', { 'Cache-Control': 'private' }],
    ['no-store', { 'Cache-Control': 'no-store' }],
    ['no-cache', { 'Cache-Control': 'no-cache' }],
    ['Set-Cookie', { 'Set-Cookie': 'sid=private; Path=/; HttpOnly' }],
    ['Vary', { Vary: 'Accept-Language' }],
    ['x-revalidate: 0', { 'x-revalidate': '0' }],
  ])(
    'authoritative %s background response evicts previously public HTML, JSON, and KV',
    async (_policy, headers) => {
      const { store, kv, delete: kvDelete } = createKvMock();
      const env = makeEnv(kv);
      seedEntry(store, '/blog/post', {
        body: '<html>public</html>',
        createdAt: BASE,
        ttl: 60,
      });
      vi.setSystemTime(BASE + 200_000);
      // Only the JSON variant is pre-warmed: an HTML edge hit would return
      // before the stale KV path runs.
      edge.store.set(jsonEdgeKey(HOST, '/blog/post', DPL), new Response('{"user":null}'));

      const { render, spy } = createRender(
        () =>
          new Response('<html>private</html>', {
            headers: {
              ...headers,
              'content-type': 'text/html',
              'x-void-page-data': '{"component":"Private","props":{"user":"alice"}}',
            },
          }),
      );
      const first = createCtx();

      const stale = await handleIsr(htmlRequest(), env, first.ctx, OPTS, render);
      expect(stale!.headers.get('x-isr-cache')).toBe('STALE');
      expect(await stale!.text()).toBe('<html>public</html>');
      await first.flush();

      expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(false);
      expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, HOST, '/blog/post'));
      expect(edge.store.has(htmlEdgeKey(HOST, '/blog/post', DPL))).toBe(false);
      expect(edge.store.has(jsonEdgeKey(HOST, '/blog/post', DPL))).toBe(false);

      // With all old variants gone, the next request renders the authoritative
      // private response and still does not repopulate shared storage.
      const second = createCtx();
      const live = await handleIsr(htmlRequest(), env, second.ctx, OPTS, render);
      expect(await live!.text()).toBe('<html>private</html>');
      expect(live!.headers.get('Cache-Control')).toBe(new Headers(headers).get('Cache-Control'));
      expect(live!.headers.get('x-isr-cache')).toBeNull();
      await second.flush();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(store.has(isrKey(DPL, HOST, '/blog/post'))).toBe(false);
      expect(edge.store.size).toBe(0);
    },
  );

  it('bypasses a signed-preview API under a global TTL, so no-store data cannot reach an unauthorized request', async () => {
    const { store, kv, getWithMetadata } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy } = createRender((request) => {
      const signed = request.headers.get('X-Preview-Signature') === 'valid';
      return signed
        ? new Response('{"draft":"secret"}', {
            headers: { 'Cache-Control': 'no-store', 'content-type': 'application/json' },
          })
        : new Response('{"error":"unauthorized"}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
    });
    const serve = async (request: Request): Promise<Response> => {
      const requestCtx = createCtx();
      const cached = await handleIsr(request, env, requestCtx.ctx, OPTS, render);
      const response = cached ?? (await render(request));
      await requestCtx.flush();
      return response;
    };

    const signed = await serve(
      htmlRequest('/api/signed-preview', { 'X-Preview-Signature': 'valid' }),
    );
    expect(await signed.text()).toBe('{"draft":"secret"}');
    expect(signed.headers.get('Cache-Control')).toBe('no-store');

    const unauthorized = await serve(htmlRequest('/api/signed-preview'));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe('{"error":"unauthorized"}');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(getWithMetadata).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(edge.store.size).toBe(0);
  });

  it('bypasses all shared ISR work for an assertion-only Access request', async () => {
    const { kv, getWithMetadata, put } = createKvMock();
    const { render, spy } = createRender(() => new Response('private profile'));
    const { ctx, tasks } = createCtx();

    expect(
      await handleIsr(
        htmlRequest('/blog/post', { 'Cf-Access-Jwt-Assertion': 'signed-access-assertion' }),
        makeEnv(kv),
        ctx,
        OPTS,
        render,
      ),
    ).toBeNull();

    expect(edge.match).not.toHaveBeenCalled();
    expect(getWithMetadata).not.toHaveBeenCalled();
    expect(edge.put).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it('renders a text/markdown negotiation live instead of replaying the cached HTML', async () => {
    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    const html = createRender(
      () => new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const fill = createCtx();
    const miss = await handleIsr(
      htmlRequest('/blog/post', { Accept: 'text/html' }),
      env,
      fill.ctx,
      OPTS,
      html.render,
    );
    expect(miss?.headers.get('x-isr-cache')).toBe('MISS');
    await fill.flush();
    expect(store.size).toBe(1);

    // A markdown client asks for the same path. The HTML entry cannot answer it,
    // and the live render must not replace that entry either.
    const markdown = createRender(
      () =>
        new Response('# page', {
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            'cache-control': 'no-store',
            vary: 'Accept',
          },
        }),
    );
    const live = createCtx();
    expect(
      await handleIsr(
        htmlRequest('/blog/post', { Accept: 'text/html, text/markdown' }),
        env,
        live.ctx,
        OPTS,
        markdown.render,
      ),
    ).toBeNull();
    expect(markdown.spy).not.toHaveBeenCalled();
    expect(live.tasks).toHaveLength(0);

    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(await new Response(entry!.body).text()).toBe('<html>page</html>');
  });

  it('returns null (caller renders live) for non-GET, credentialed, and non-ISR paths', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    const { render } = createRender(() => new Response('x'));
    const { ctx } = createCtx();

    expect(
      await handleIsr(
        new Request(`https://${HOST}/blog/post`, { method: 'POST' }),
        env,
        ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
    expect(
      await handleIsr(htmlRequest('/blog/post', { Cookie: 'sid=1' }), env, ctx, OPTS, render),
    ).toBeNull();
    expect(
      await handleIsr(
        htmlRequest('/blog/post', { Authorization: 'Bearer private' }),
        env,
        ctx,
        OPTS,
        render,
      ),
    ).toBeNull();
    expect(
      await handleIsr(
        htmlRequest('/blog/post'),
        env,
        ctx,
        { revalidate: { '/other': 60 }, deploymentId: DPL },
        render,
      ),
    ).toBeNull();
  });

  it('fails open (never throws) when the Cache API is absent — a MISS renders live', async () => {
    // Reading `caches.default` now throws.
    vi.stubGlobal('caches', undefined);

    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    const { render, spy } = createRender(
      () => new Response('<html>live</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('x-isr-cache')).toBe('MISS');
    expect(await res!.text()).toBe('<html>live</html>');
    expect(spy).toHaveBeenCalledTimes(1);

    await expect(flush()).resolves.toBeUndefined();
    const entry = await readIsrCache(env, HOST, '/blog/post');
    expect(entry).not.toBeNull();
    expect(await new Response(entry!.body).text()).toBe('<html>live</html>');
    expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(1);
  });

  it('serves the L2 KV HIT with no per-colo edge cache (KV ladder independent of caches.default)', async () => {
    vi.stubGlobal('caches', {
      get default(): Cache {
        throw new Error('Cache API degraded');
      },
    });

    const { kv, store } = createKvMock();
    const env = makeEnv(kv);
    seedEntry(store, '/blog/post', { body: '<html>kv</html>', createdAt: BASE, ttl: 60 });
    const { render, spy } = createRender(() => new Response('SHOULD-NOT-RENDER'));
    const { ctx, flush } = createCtx();

    const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);
    expect(res).not.toBeNull();
    expect(res!.headers.get('x-isr-cache')).toBe('HIT');
    expect(await res!.text()).toBe('<html>kv</html>');
    expect(spy).not.toHaveBeenCalled();
    await expect(flush()).resolves.toBeUndefined();
  });

  // A partial 206 body must never be read from or written to the shared
  // full-response entry.
  describe('Range bypass + full-200-only cache gate', () => {
    it('bypasses ISR for a Range request → null before any cache read, render, or write', async () => {
      const { store, kv, getWithMetadata, put } = createKvMock();
      const env = makeEnv(kv);
      const { render, spy } = createRender(
        () => new Response('SHOULD-NOT-RENDER', { status: 206 }),
      );
      const { ctx, tasks } = createCtx();

      const res = await handleIsr(
        htmlRequest('/blog/post', { Range: 'bytes=0-1023' }),
        env,
        ctx,
        OPTS,
        render,
      );

      expect(res).toBeNull();
      expect(edge.match).not.toHaveBeenCalled();
      expect(getWithMetadata).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
      expect(edge.put).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
      expect(store.size).toBe(0);
      expect(edge.store.size).toBe(0);
    });

    it('does NOT cache a forced 206 render (non-range) — only full 200 responses are written', async () => {
      const { store, kv, put } = createKvMock();
      const env = makeEnv(kv);
      const { render, spy } = createRender(
        () =>
          new Response('<html>partial</html>', {
            status: 206,
            headers: { 'content-type': 'text/html', 'content-range': 'bytes 0-9/100' },
          }),
      );
      const { ctx, tasks, flush } = createCtx();

      const res = await handleIsr(htmlRequest(), env, ctx, OPTS, render);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(206);
      expect(await res!.text()).toBe('<html>partial</html>');
      expect(spy).toHaveBeenCalledTimes(1);

      await flush();
      expect(tasks).toHaveLength(0);
      expect(put).not.toHaveBeenCalled();
      expect(edge.put).not.toHaveBeenCalled();
      expect([...store.keys()].filter((k) => k.startsWith(isrPrefix(DPL))).length).toBe(0);
      expect(edge.store.size).toBe(0);
      expect(await readIsrCache(env, HOST, '/blog/post')).toBeNull();
    });
  });
});

// ===========================================================================
// Host-scoped KV cache + host registry
// ===========================================================================

describe('host-scoped KV cache + host registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not bleed across hosts: write under one host, read under another → null', async () => {
    const { kv } = createKvMock();
    const env = makeEnv(kv);
    await writeIsrCache(
      env,
      'foo.example',
      '/x',
      new Response('<html>foo</html>', { headers: { 'content-type': 'text/html' } }),
      60,
    );
    expect(await readIsrCache(env, 'bar.example', '/x')).toBeNull();
    expect(await readIsrCache(env, 'foo.example', '/x')).not.toBeNull();
  });

  it('registers the host in the registry on write (void-isr-hosts/<id>/<host>)', async () => {
    const { store, kv } = createKvMock();
    const env = makeEnv(kv);
    // Unique host so the module-level in-isolate registration guard (shared across
    // this file's tests) does not skip the registry write here.
    const host = 'registry-write.example';
    await writeIsrCache(
      env,
      host,
      '/p',
      new Response('<html>x</html>', { headers: { 'content-type': 'text/html' } }),
      60,
    );
    expect(store.has(hostRegistryKey(DPL, host))).toBe(true);
  });

  it('retries host registration on a later write after a transient registry-put failure', async () => {
    // Unique host so the module-level in-isolate registration guard does not pre-skip it.
    const host = 'registry-retry.example';
    const store = new Map<string, KvRecord>();
    let registryPuts = 0;
    const put = vi.fn(
      async (key: string, value: ArrayBuffer, options?: { metadata?: IsrCacheMetadata }) => {
        if (key.startsWith('void-isr-hosts/')) {
          registryPuts++;
          if (registryPuts === 1) {
            throw new Error('transient registry failure');
          }
        }
        store.set(key, { value, metadata: options?.metadata ?? null });
      },
    );
    const list = vi.fn(async (o: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => k.startsWith(o.prefix ?? ''))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    }));
    const kv = { put, list, getWithMetadata: vi.fn(), delete: vi.fn() } as unknown as KVNamespace;
    const env = makeEnv(kv);
    const res = () => new Response('<html>x</html>', { headers: { 'content-type': 'text/html' } });

    await writeIsrCache(env, host, '/p', res(), 60);
    expect(store.has(hostRegistryKey(DPL, host))).toBe(false);

    await writeIsrCache(env, host, '/p', res(), 60);
    expect(registryPuts).toBe(2);
    expect(store.has(hostRegistryKey(DPL, host))).toBe(true);
    expect(await listIsrHosts(kv, DPL)).toContain(host);
  });

  it('listIsrHosts returns the registered hosts for a deployment, scoped by id', async () => {
    const { store, kv } = createKvMock();
    store.set(hostRegistryKey(DPL, 'a.example'), { value: new ArrayBuffer(0), metadata: null });
    store.set(hostRegistryKey(DPL, 'b.example'), { value: new ArrayBuffer(0), metadata: null });
    store.set(hostRegistryKey('other_dpl', 'c.example'), {
      value: new ArrayBuffer(0),
      metadata: null,
    });
    const hosts = await listIsrHosts(kv, DPL);
    expect([...hosts].sort()).toEqual(['a.example', 'b.example']);
  });

  it('listIsrHosts fails open to [] on a broken registry (never throws)', async () => {
    const brokenKv = {
      list: vi.fn(async () => {
        throw new Error('KV unavailable');
      }),
    } as unknown as KVNamespace;
    await expect(listIsrHosts(brokenKv, DPL)).resolves.toEqual([]);
  });
});
