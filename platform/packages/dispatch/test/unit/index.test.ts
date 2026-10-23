import { isrEdgeCacheUrl } from '@void/isr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app, { rebuildRequest } from '../../src/index.ts';
import {
  SHARED_CACHE_POLICY_HEADER,
  SHARED_CACHE_POLICY_VERSION,
  isrCacheKey,
  markSharedCachePolicy,
  unpackIsrValue,
} from '../../src/isr.ts';
import { PLATFORM_DISABLED_KEY } from '../../src/platform-lifecycle.ts';

// Mock caches.default (CF edge cache) with a Map-backed store.
// Uses full URL as key — callers (isrEdgeCacheKey, hashed asset code) already normalize.
const edgeCacheStore = new Map<string, Response>();

vi.stubGlobal('caches', {
  default: {
    match: async (req: Request) => {
      const res = edgeCacheStore.get(req.url);
      return res ? res.clone() : undefined;
    },
    put: async (req: Request, res: Response) => {
      edgeCacheStore.set(req.url, res.clone());
    },
    delete: async (req: Request) => {
      return edgeCacheStore.delete(req.url);
    },
  },
});

beforeEach(() => {
  edgeCacheStore.clear();
});

type RoutingEntry = {
  workerName: string;
  projectId: string;
  userId?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  version?: string;
  limits?: Record<string, number>;
  suspended?: string;
  hashedAssetsPrefix?: string;
  staticDeploymentId?: string;
  assetManifestId?: string;
  assetConfig?: {
    not_found_handling?: 'none' | 'single-page-application' | '404-page';
    html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
    run_worker_first?: boolean | Array<string>;
  };
  headerRules?: Array<{ pattern: string; headers: Array<[string, string]> }>;
  redirectRules?: Array<{ source: string; destination: string; status: number; host?: string }>;
  fallbackRules?: Array<{ source: string; destination: string; status: number; host?: string }>;
  queryAllowlist?: Record<string, Array<string>>;
  zeroTrust?: {
    teamDomain: string;
    audiences: Array<{ hostname: string; audience: string }>;
  };
};

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

// `Headers.getSetCookie()` exists on the Workers runtime but is missing from
// `@cloudflare/workers-types` — reach it through a narrow cast (mirrors the
// `readSetCookies` helper in src/index.ts).
function getSetCookies(headers: Headers): Array<string> {
  return (headers as Headers & { getSetCookie(): Array<string> }).getSetCookie();
}

function currentSharedCacheResponse(response: Response): Response {
  markSharedCachePolicy(response.headers);
  return response;
}

type MockIsrEntry = {
  body: string;
  status?: number;
  createdAt: number;
  ttl: number;
  headers?: Record<string, string>;
};

function packMockEntry(entry: MockIsrEntry): {
  value: ArrayBuffer;
  metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
} {
  const headers = entry.headers ?? {};
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const bodyBytes = new TextEncoder().encode(entry.body);
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + bodyBytes.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(bodyBytes);
  return {
    value: buffer,
    metadata: {
      s: entry.status ?? 200,
      c: entry.createdAt,
      t: entry.ttl,
      p: SHARED_CACHE_POLICY_VERSION,
    },
  };
}

function createEnv(options: {
  routing: RoutingEntry;
  assets?: Record<string, MockIsrEntry>;
  assetManifest?: Record<string, string>;
  workerResponse?: Response;
  workerFetchImpl?: () => Promise<Response>;
}): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  dispatchGet: ReturnType<typeof vi.fn>;
  kvStore: Map<
    string,
    {
      value: ArrayBuffer;
      metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
    }
  >;
  analyticsWrites: Array<unknown>;
  logWrites: Array<unknown>;
} {
  const workerFetch = vi.fn(
    async () => options.workerFetchImpl?.() ?? options.workerResponse ?? new Response('worker'),
  );
  const kvStore = new Map<
    string,
    {
      value: ArrayBuffer;
      metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
    }
  >();
  const analyticsWrites: Array<unknown> = [];
  const logWrites: Array<unknown> = [];

  // Seed initial ISR cache entries
  if (options.assets) {
    for (const [key, entry] of Object.entries(options.assets)) {
      kvStore.set(key, packMockEntry(entry));
    }
  }

  const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

  const env = {
    ROUTING: {
      get: async (key: string) =>
        key.startsWith('manifest:')
          ? JSON.stringify(options.assetManifest ?? {})
          : JSON.stringify(options.routing),
    },
    DISPATCH: {
      get: dispatchGet,
    },
    STATIC_ASSETS_R2: {
      get: async (key: string) => {
        const entry = kvStore.get(key.slice('isr-cache/'.length));
        if (!entry) {
          return null;
        }
        return {
          arrayBuffer: async () => entry.value,
          customMetadata: { isr: JSON.stringify(entry.metadata) },
        };
      },
      put: async (key: string, value: ArrayBuffer, opts: { customMetadata: { isr: string } }) => {
        kvStore.set(key.slice('isr-cache/'.length), {
          value,
          metadata: JSON.parse(opts.customMetadata.isr),
        });
      },
      delete: async (key: string) => {
        kvStore.delete(key.slice('isr-cache/'.length));
      },
      list: async (opts: { prefix: string; limit?: number }) => {
        const all = [...kvStore.keys()]
          .map((key) => `isr-cache/${key}`)
          .filter((key) => key.startsWith(opts.prefix))
          .sort();
        const limit = opts.limit ?? 1000;
        const slice = all.slice(0, limit);
        return {
          objects: slice.map((key) => ({ key })),
          truncated: slice.length !== all.length,
          cursor: '',
        };
      },
    },
    ISR_CACHE: { delete: async () => {} },
    ANALYTICS: {
      writeDataPoint: (data: unknown) => analyticsWrites.push(data),
    },
    LOGS: {
      writeDataPoint: (data: unknown) => logWrites.push(data),
    },
  } as unknown as Env;

  return { env, workerFetch, dispatchGet, kvStore, analyticsWrites, logWrites };
}

describe('dispatch fetch handler', () => {
  it('fails closed before dispatch when a protected route has no Access assertion', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        zeroTrust: {
          teamDomain: 'https://company.cloudflareaccess.com',
          audiences: [{ hostname: '*.void.app', audience: 'project-audience' }],
        },
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/private'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('forwards /api requests to user worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('api'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello', { method: 'GET' }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('api');
  });

  it('meters websocket upgrade requests as websocket while forwarding them', async () => {
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('switching', { status: 200 }),
    });

    const request = new Request('https://my-app.void.app/chat/general', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const response = await app.fetch(request, env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetch.mock.calls[0]?.[0].headers.get('upgrade')).toBe('websocket');
    expect((analyticsWrites[0] as { blobs: Array<string> }).blobs[1]).toBe('websocket');
    expect(response.headers.get('X-Hosted-By')).toBe('void.cloud');
  });

  it('dispatches SSR requests to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true },
      workerResponse: new Response('<html>ssr</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('<html>ssr</html>');
  });

  it('dispatches non-SSR requests to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('ok');
  });

  it('handles POST request with already-consumed body without throwing', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    // Simulate a request whose body was consumed by upstream edge processing
    const request = new Request('https://my-app.void.app/xmlrpc.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: 'payload',
    });
    await request.text(); // consume the body
    expect(request.bodyUsed).toBe(true);

    const response = await app.fetch(request, env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    // The forwarded request should have no body and no stale body-size headers
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.bodyUsed).toBe(false);
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(forwarded.headers.has('transfer-encoding')).toBe(false);
    expect(await response.text()).toBe('ok');
  });
});

/**
 * `request.cf` (country, colo, botManagement, tlsClientAuth, …) is populated
 * by the CF edge and is what user workers read for geolocation, bot scoring,
 * and mTLS info. Plain `new Request(url, { method, headers, body })` drops it
 * — we have to thread it through `cf:` in init when we rebuild.
 *
 * Node's `Request` doesn't accept `cf` in init, so we can't observe it on the
 * resulting Request directly. Instead we wrap `globalThis.Request` and assert
 * the constructor receives `cf` in its init bag.
 */
describe('rebuildRequest preserves request.cf', () => {
  let RequestCalls: Array<{ url: unknown; init: RequestInit | undefined }>;
  const OriginalRequest = globalThis.Request;

  beforeEach(() => {
    RequestCalls = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Request = class extends OriginalRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        // Strip `cf` before delegating — Node would otherwise reject it. We
        // record the original init for assertion.
        RequestCalls.push({ url: input, init });
        const cleaned = init ? { ...init } : undefined;
        if (cleaned && 'cf' in cleaned) {
          delete (cleaned as { cf?: unknown }).cf;
        }
        super(input, cleaned);
      }
    };
  });

  afterEach(() => {
    globalThis.Request = OriginalRequest;
  });

  function withCf<T extends Request>(req: T, cf: unknown): T {
    Object.defineProperty(req, 'cf', { value: cf, configurable: true, enumerable: true });
    return req;
  }

  it('forwards cf when rebuilding a GET (no body)', () => {
    const cf = { country: 'US', colo: 'SFO', botManagement: { score: 99 } };
    const src = withCf(new OriginalRequest('https://my-app.void.app/old'), cf);

    const out = rebuildRequest(src, 'https://my-app.void.app/new', () => {});

    expect(out).toBeInstanceOf(OriginalRequest);
    // The last constructor invocation is the rebuilt request.
    const last = RequestCalls.at(-1)!;
    expect(last.url).toBe('https://my-app.void.app/new');
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });

  it('forwards cf when rebuilding a POST with streaming body', () => {
    const cf = { country: 'DE' };
    const src = withCf(
      new OriginalRequest('https://my-app.void.app/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'payload',
      }),
      cf,
    );

    rebuildRequest(src, 'https://my-app.void.app/y', () => {});

    const last = RequestCalls.at(-1)!;
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });

  it('forwards cf when the body is already consumed (drop-body branch)', async () => {
    const cf = { country: 'JP' };
    const src = withCf(
      new OriginalRequest('https://my-app.void.app/x', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'payload',
      }),
      cf,
    );
    await src.text();
    expect(src.bodyUsed).toBe(true);

    rebuildRequest(src, 'https://my-app.void.app/y', () => {});

    const last = RequestCalls.at(-1)!;
    expect((last.init as { cf?: unknown } | undefined)?.cf).toBe(cf);
  });
});

describe('custom domain routing', () => {
  it('routes custom domain via domain: KV key', async () => {
    const workerFetch = vi.fn(async () => new Response('custom-domain-api'));
    const routing: RoutingEntry = { workerName: 'user-app', projectId: 'proj_1' };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key === 'domain:app.example.com') {
            return JSON.stringify(routing);
          }
          return null;
        },
      },
      DISPATCH: {
        get: () => ({ fetch: workerFetch }),
      },
      ISR_CACHE: {
        getWithMetadata: async () => ({ value: null, metadata: null }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request('https://app.example.com/api/hello'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('custom-domain-api');
  });

  it('returns 404 for unknown hostname', async () => {
    const env = {
      ROUTING: {
        get: async () => null,
      },
      DISPATCH: {
        get: () => ({ fetch: vi.fn() }),
      },
      ISR_CACHE: {
        getWithMetadata: async () => ({ value: null, metadata: null }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(new Request('https://unknown.example.com/'), env, createCtx());

    expect(response.status).toBe(404);
  });
});

describe('ISR (stale-while-revalidate)', () => {
  it('does not resurrect a purged 600-second page from stale legacy KV', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 600 },
      workerResponse: new Response('<html>fresh after purge</html>'),
    });
    const staleRead = vi.fn(async () =>
      packMockEntry({
        body: '<html>deleted but still visible in KV</html>',
        createdAt: Date.now(),
        ttl: 600,
      }),
    );
    Object.assign(env.ISR_CACHE, { getWithMetadata: staleRead });
    const response = await app.fetch(new Request('https://my-app.void.app/page'), env, createCtx());
    expect(await response.text()).toBe('<html>fresh after purge</html>');
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(staleRead).not.toHaveBeenCalled();
  });

  it('keeps framework data requests separate from a cached document at the same URL', async () => {
    let renders = 0;
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        type: 'framework',
        ssr: true,
        revalidate: 60,
      },
      workerFetchImpl: async () =>
        ++renders === 2
          ? Response.json({ data: true })
          : new Response('<html>document</html>', { headers: { 'Content-Type': 'text/html' } }),
    });
    const documentCtx = createCtx();
    const document = await app.fetch(
      new Request('https://my-app.void.app/dashboard', { headers: { Accept: 'text/html' } }),
      env,
      documentCtx,
    );
    expect(await document.text()).toBe('<html>document</html>');
    await Promise.all(
      (documentCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );

    const data = await app.fetch(
      new Request('https://my-app.void.app/dashboard', { headers: { Accept: 'application/json' } }),
      env,
      createCtx(),
    );
    expect(await data.json()).toEqual({ data: true });
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a framework JSON response to a document request', async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        type: 'framework',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: Response.json({ data: true }),
    });
    const ctx = createCtx();
    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', { headers: { Accept: 'text/html' } }),
      env,
      ctx,
    );
    expect(await response.json()).toEqual({ data: true });
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(false);
  });

  it('evicts stale framework HTML when revalidation returns JSON', async () => {
    const key = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        type: 'framework',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        [key]: {
          body: '<html>stale</html>',
          headers: { 'Content-Type': 'text/html' },
          createdAt: Date.now() - 120_000,
          ttl: 60,
        },
      },
      workerResponse: Response.json({ data: true }),
    });
    const ctx = createCtx();
    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', { headers: { Accept: 'text/html' } }),
      env,
      ctx,
    );
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has(key)).toBe(false);
  });

  it('caches worker response in KV on first ISR request', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>rendered</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>rendered</html>');

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(true);
  });

  it('does NOT cache a specific non-ISR page shadowed by a catch-all (route-aware)', async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        // catch-all has a TTL; the specific page opts out (present, no revalidate)
        revalidate: { '/docs/*': 3600 },
        pages: [
          { pattern: '/docs/setup/install' },
          { pattern: '/docs/:path{.+}', revalidate: 3600 },
        ],
      },
      workerResponse: new Response('<html>specific</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });
    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/docs/setup/install'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    // no ISR entry written for the shadowed specific page
    expect([...kvStore.keys()].some((k) => k.includes('/docs/setup/install'))).toBe(false);
  });

  it('honors a page opt-out over the same path in the flat managed policy', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        version: 'v1',
        revalidate: { '/private': 60 },
        pages: [{ pattern: '/private', revalidate: 0 }],
        pathRevalidate: { '/private': 60 },
      },
      workerResponse: new Response('<html>private</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const first = await app.fetch(new Request('https://my-app.void.app/private'), env, createCtx());
    const second = await app.fetch(
      new Request('https://my-app.void.app/private'),
      env,
      createCtx(),
    );

    expect(first.headers.get('x-isr-cache')).toBeNull();
    expect(second.headers.get('x-isr-cache')).toBeNull();
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect([...kvStore.keys()].some((key) => key.includes('/private'))).toBe(false);
  });

  it("DOES cache the catch-all's own nested path", async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: { '/docs/*': 3600 },
        pages: [
          { pattern: '/docs/setup/install' },
          { pattern: '/docs/:path{.+}', revalidate: 3600 },
        ],
      },
      workerResponse: new Response('<html>catch-all</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });
    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/docs/a/b'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect([...kvStore.keys()].some((k) => k.includes('/docs/a/b'))).toBe(true);
  });

  it('does NOT ISR-cache /api/* even under a root catch-all page with a TTL', async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        pages: [{ pattern: '/:path{.+}', revalidate: 3600 }], // root catch-all
      },
      workerResponse: new Response('{"ok":true}', {
        headers: { 'Content-Type': 'application/json' },
      }),
    });
    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/api/thing'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect([...kvStore.keys()].some((k) => k.includes('/api/thing'))).toBe(false);
  });

  it('does NOT ISR-cache an extension path under a root catch-all', async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        pages: [{ pattern: '/:path{.+}', revalidate: 3600 }],
      },
      workerResponse: new Response('data', {
        headers: { 'Content-Type': 'text/plain' },
      }),
    });
    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/robots.txt'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect([...kvStore.keys()].some((k) => k.includes('robots.txt'))).toBe(false);
  });

  it('ISR-caches an EXPLICITLY-configured extension page (not a 1-year static edge entry)', async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        version: 'v1',
        pages: [{ pattern: '/feed.xml', revalidate: 60 }],
      },
      workerResponse: new Response('<rss>feed</rss>', {
        headers: { 'Content-Type': 'application/xml' },
      }),
    });
    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/feed.xml'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Genuine ISR miss render — NOT the static 1-year edge cache path.
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    // ISR KV entry written for the explicit extension page.
    expect([...kvStore.keys()].some((k) => k.includes('feed.xml'))).toBe(true);
    // Never stored under the `?_v=<version>` static edge key (s-maxage=31536000).
    expect([...edgeCacheStore.keys()].some((k) => k.includes('?_v='))).toBe(false);
    // Edge copy is the ISR edge key (deployment-scoped, TTL-bounded), not static.
    expect([...edgeCacheStore.keys()].some((k) => k.includes('__void_isr='))).toBe(true);
  });

  it('ISR-caches a dotted dynamic param VALUE under a single-segment page route', async () => {
    // Finding 2 [medium]: `/blog/:slug` compiles to `^/blog/[^/]+$`, so a param
    // VALUE that happens to carry a dot (`/blog/release.v2`) matches the page and
    // is genuine ISR page content — NOT a static asset. It must enter the ISR
    // ladder (miss render + KV entry), not be diverted to the 1-year static edge.
    // Previously the "pattern must LITERALLY declare the extension" gate wrongly
    // denied it; eligibility now keys on "matches a non-broad-catch-all page".
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        version: 'v1',
        pages: [{ pattern: '/blog/:slug', revalidate: 60 }],
      },
      workerResponse: new Response('<html>post</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    // Request 1: MISS → render + cache in KV (not the static 1-year edge entry).
    const ctx1 = createCtx();
    const first = await app.fetch(
      new Request('https://my-app.void.app/blog/release.v2'),
      env,
      ctx1,
    );
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(first.headers.get('x-isr-cache')).toBe('MISS');
    expect([...kvStore.keys()].some((k) => k.includes('/blog/release.v2'))).toBe(true);
    // Never diverted to the `?_v=<version>` 1-year static edge key.
    expect([...edgeCacheStore.keys()].some((k) => k.includes('?_v='))).toBe(false);

    // Request 2 within TTL: served from the ISR KV entry (HIT), worker not re-invoked.
    edgeCacheStore.clear();
    const ctx2 = createCtx();
    const second = await app.fetch(
      new Request('https://my-app.void.app/blog/release.v2'),
      env,
      ctx2,
    );
    expect(second.headers.get('x-isr-cache')).toBe('HIT');
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await second.text()).toBe('<html>post</html>');
  });

  it('resolves an inherit-eligible page against routing.pathRevalidate per-path (object config)', async () => {
    // An object `routing.revalidate` ships as pages=[{ pattern: '/blog/:slug' }]
    // (inherit-eligible, NO baked TTL) plus the RAW config in `pathRevalidate`.
    // Dispatch resolves it per-path: `/blog/other` → 3600 (ISR), `/blog/private`
    // → 0 (per-path opt-out, rendered live, never cached). This proves the
    // pathRevalidate field is threaded through the ISR ladder end-to-end — the
    // per-path fidelity that build-time baking (one TTL per page) cannot give.
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        version: 'v1',
        pages: [{ pattern: '/blog/:slug' }],
        pathRevalidate: { '/blog/private': 0, '/blog/*': 3600 },
      },
      workerResponse: new Response('<html>post</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    // `/blog/other` → per-path 3600 → ISR MISS render + KV write.
    const ctx1 = createCtx();
    const other = await app.fetch(new Request('https://my-app.void.app/blog/other'), env, ctx1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(other.headers.get('x-isr-cache')).toBe('MISS');
    expect([...kvStore.keys()].some((k) => k.includes('/blog/other'))).toBe(true);

    // `/blog/private` → per-path 0 opt-out → rendered live, NOT ISR-cached.
    const ctx2 = createCtx();
    const priv = await app.fetch(new Request('https://my-app.void.app/blog/private'), env, ctx2);
    await Promise.all((ctx2.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(priv.headers.get('x-isr-cache')).toBeNull();
    expect([...kvStore.keys()].some((k) => k.includes('/blog/private'))).toBe(false);
  });

  it('serves a configured extension page from the ISR KV entry on a second request (TTL honored)', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        version: 'v1',
        pages: [{ pattern: '/feed.xml', revalidate: 60 }],
      },
      workerResponse: new Response('<rss>feed</rss>', {
        headers: { 'Content-Type': 'application/xml' },
      }),
    });

    // Request 1: MISS → render + cache in KV.
    const ctx1 = createCtx();
    const first = await app.fetch(new Request('https://my-app.void.app/feed.xml'), env, ctx1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(first.headers.get('x-isr-cache')).toBe('MISS');
    expect(workerFetch).toHaveBeenCalledOnce();
    expect([...kvStore.keys()].some((k) => k.includes('feed.xml'))).toBe(true);

    // Drop the per-colo edge cache so request 2 exercises the L2 KV/TTL path
    // (simulates edge eviction / a different colo) rather than the ephemeral edge.
    edgeCacheStore.clear();

    // Request 2 (within the 60s TTL): served from the ISR KV entry, worker NOT re-invoked.
    const ctx2 = createCtx();
    const second = await app.fetch(new Request('https://my-app.void.app/feed.xml'), env, ctx2);
    expect(second.headers.get('x-isr-cache')).toBe('HIT');
    expect(workerFetch).toHaveBeenCalledOnce(); // still once — no re-render
    expect(await second.text()).toBe('<rss>feed</rss>');
  });

  it('serves from ISR cache on second request (no worker call)', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>cached</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(await response.text()).toBe('<html>cached</html>');
  });

  it('renders an ISR page when the platform KV read fails', async () => {
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      workerResponse: new Response('<html>live</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });
    vi.spyOn(env.STATIC_ASSETS_R2, 'get').mockRejectedValueOnce(new Error('R2 unavailable'));

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(await response.text()).toBe('<html>live</html>');
  });

  it('bypasses ISR cache when Cookie header is present', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>cached</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>personalized</html>'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', {
        headers: { Cookie: 'session=abc' },
      }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('x-isr-cache')).toBeNull();
    expect(await response.text()).toBe('<html>personalized</html>');
  });

  // Range bypass + full-200-only cache gate (parity with the framework ISR fix).
  // A Range GET on an ISR path must render LIVE so the origin emits a correct
  // `206 Partial Content`; it must never read the shared (host,path) entry (a full
  // body for a partial request) nor write it (a truncated 206 a later full request
  // would then be served). The write gate is also tightened from `.ok` (200–299,
  // INCLUDING 206) to `status === 200` as defense-in-depth.
  describe('Range bypass + full-200-only cache gate', () => {
    it('bypasses ISR for a Range request: renders live, never reads or overwrites the cache', async () => {
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
        },
        // A full-body entry is already cached; a Range request must NOT read it.
        assets: {
          'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
            body: '<html>cached-full</html>',
            createdAt: Date.now(),
            ttl: 60,
            headers: { 'Content-Type': 'text/html' },
          },
        },
        // The origin renders a partial response for the requested byte range.
        workerResponse: new Response('partial-bytes', {
          status: 206,
          headers: { 'Content-Type': 'text/html', 'Content-Range': 'bytes 0-12/100' },
        }),
      });

      const ctx = createCtx();
      const response = await app.fetch(
        new Request('https://my-app.void.app/dashboard', {
          headers: { Range: 'bytes=0-12' },
        }),
        env,
        ctx,
      );

      // Live render: the worker was invoked and the 206 flows through untouched
      // (not served the cached full body, not stamped as an ISR hit).
      expect(workerFetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(206);
      expect(response.headers.get('x-isr-cache')).toBeNull();
      expect(await response.text()).toBe('partial-bytes');

      // No ISR write ran, and the seeded full-body entry is untouched — the 206
      // never poisoned the shared slot.
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      const seeded = kvStore.get('proj_1/isr/v3/legacy/my-app.void.app/dashboard');
      expect(seeded).toBeDefined();
      const unpacked = unpackIsrValue(seeded!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>cached-full</html>');
    });

    it('does not write a 206 worker response to the ISR cache (only a full 200 is cached)', async () => {
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
        },
        // No Range header on the request, yet the worker returns 206 — the write
        // gate (status === 200, not `.ok`) must still refuse to persist it.
        workerResponse: new Response('<html>partial</html>', {
          status: 206,
          headers: { 'Content-Type': 'text/html', 'Content-Range': 'bytes 0-9/100' },
        }),
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

      expect(workerFetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('<html>partial</html>');

      // A 206 partial body must never enter the shared full-response cache.
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(false);
    });

    it('still caches a full 200 worker response (the tightened gate does not block 200)', async () => {
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
        },
        workerResponse: new Response('<html>full-200</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

      expect(workerFetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(200);
      expect(response.headers.get('x-isr-cache')).toBe('MISS');
      expect(await response.text()).toBe('<html>full-200</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      const cached = kvStore.get('proj_1/isr/v3/legacy/my-app.void.app/dashboard');
      expect(cached).toBeDefined();
      expect(cached!.metadata.s).toBe(200);
      const unpacked = unpackIsrValue(cached!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>full-200</html>');
    });
  });

  it('does not cache when x-revalidate: 0 opt-out', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>no-cache</html>', {
        headers: { 'x-revalidate': '0' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await response.text()).toBe('<html>no-cache</html>');
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(false);
  });

  it('SSR without revalidate works unchanged', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
      },
      workerResponse: new Response('<html>ssr</html>'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('x-isr-cache')).toBeNull();
    expect(await response.text()).toBe('<html>ssr</html>');
  });

  it('sets ISR-managed headers on cache-miss response', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>rendered</html>', {
        headers: {
          'Content-Type': 'text/html',
          // Worker's raw Cache-Control is overridden by ISR-managed headers.
          // (A non-opt-out value: an opt-out like `no-store` would correctly
          // prevent ISR caching — see the `ISR respects response Cache-Control
          // opt-out` suite — so this must stay cacheable to exercise the override.)
          'Cache-Control': 'public, max-age=30',
        },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    const edgeCached = edgeCacheStore.get('https://my-app.void.app/dashboard?__void_isr=legacy');
    expect(edgeCached?.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, max-age=0, must-revalidate',
    );
  });

  it('keeps each anonymous Set-Cookie render private across callers', async () => {
    let render = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerFetchImpl: async () => {
        render++;
        return new Response(`<html>user-${render}</html>`, {
          headers: [
            ['Content-Type', 'text/html'],
            ['set-cookie', `sid=user-${render}; Path=/; HttpOnly`],
            ['set-cookie', `csrf=tok-${render}; Path=/`],
          ],
        });
      },
    });

    const firstCtx = createCtx();
    const first = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, firstCtx);
    expect(await first.text()).toBe('<html>user-1</html>');
    expect(first.headers.get('x-isr-cache')).toBeNull();
    expect(getSetCookies(first.headers)).toEqual([
      'sid=user-1; Path=/; HttpOnly',
      'csrf=tok-1; Path=/',
    ]);
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const secondCtx = createCtx();
    const second = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      secondCtx,
    );
    expect(await second.text()).toBe('<html>user-2</html>');
    expect(getSetCookies(second.headers)).toEqual([
      'sid=user-2; Path=/; HttpOnly',
      'csrf=tok-2; Path=/',
    ]);
    await Promise.all(
      (secondCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );

    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(false);
    expect(edgeCacheStore.has('https://my-app.void.app/dashboard?__void_isr=legacy')).toBe(false);
    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });

  it('deletes KV entry when background revalidation gets x-revalidate: 0', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>opt-out</html>', {
        headers: { 'x-revalidate': '0' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
    // KV entry should be deleted after x-revalidate: 0
    expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(false);
  });

  it('revalidates stale entry in background and returns stale content', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000, // 2 minutes ago, TTL is 60s
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Should return stale content immediately
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    // Revalidation and any allowed stale re-warm share one ordered task, so a
    // privacy eviction cannot race a separate stale cache put.
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Wait for background write
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('serves from edge cache on repeat ISR request (no KV read)', async () => {
    // Pre-populate edge cache
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void_isr=legacy',
      currentSharedCacheResponse(
        new Response('<html>edge</html>', {
          headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
        }),
      ),
    );

    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toBe('<html>edge</html>');
  });

  it('ignores ISR entries from other deployment namespaces', async () => {
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard',
      new Response('<html>old-unversioned-edge</html>', {
        headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
      }),
    );
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void_isr=dpl_old',
      new Response('<html>old-versioned-edge</html>', {
        headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
      }),
    );

    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        version: 'dpl_new',
      },
      assets: {
        'proj_1/isr/dashboard': {
          body: '<html>old-unversioned-kv</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
        'proj_1/isr/v2/dpl_old/dashboard': {
          body: '<html>old-versioned-kv</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(await response.text()).toBe('<html>fresh</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(kvStore.has('proj_1/isr/v3/dpl_new/my-app.void.app/dashboard')).toBe(true);
    expect(edgeCacheStore.has('https://my-app.void.app/dashboard?__void_isr=dpl_new')).toBe(true);
  });

  it('populates edge cache after KV hit', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>r2-cached</html>',
          createdAt: Date.now(),
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toBe('<html>r2-cached</html>');

    // Wait for edge cache population
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    const edgeCached = edgeCacheStore.get('https://my-app.void.app/dashboard?__void_isr=legacy');
    expect(edgeCached).toBeDefined();
    expect(edgeCached!.headers.get('Cache-Control')).toContain('s-maxage=');
  });

  // User code can branch on `c.isRewritten()` / `c.originalUrl()`, so the ISR
  // cache must not conflate a direct hit to `/en/docs` with a request that
  // was rewritten from `/docs`. Both cache layers (edge URL + KV key) key
  // on the original-URL value so the two variants live in distinct slots.
  it('isolates ISR edge cache between direct and rewritten requests to the same path', async () => {
    // First request: direct hit to /en/docs. Seed only the direct-hit edge
    // cache entry for /en/docs; the rewritten request should miss it.
    edgeCacheStore.set(
      'https://my-app.void.app/en/docs?__void_isr=legacy',
      currentSharedCacheResponse(
        new Response('<html>direct</html>', {
          headers: { 'x-isr-cache': 'HIT', 'Content-Type': 'text/html' },
        }),
      ),
    );

    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('<html>rewritten-render</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const direct = await app.fetch(
      new Request('https://my-app.void.app/en/docs'),
      env,
      createCtx(),
    );
    expect(direct.headers.get('x-isr-cache')).toBe('HIT');
    expect(await direct.text()).toBe('<html>direct</html>');

    const rewritten = await app.fetch(
      new Request('https://my-app.void.app/docs'),
      env,
      createCtx(),
    );
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(rewritten.headers.get('x-isr-cache')).toBe('MISS');
    expect(await rewritten.text()).toBe('<html>rewritten-render</html>');
  });

  // The variant key is derived from the original request URL on a rewrite.
  // Without query normalization, varying any param fans out KV slots and
  // forces re-renders. The default behavior (no allowlist) drops every
  // param so the cache slot is shared across all incoming queries.
  it('collapses all query strings into one ISR variant slot when no queryAllowlist is configured', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/*', destination: '/en/:splat', status: 200 }],
      },
      workerResponse: new Response('<html>x</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    for (const query of ['', '?cb=0', '?cb=1', '?cb=2']) {
      const ctx = createCtx();
      await app.fetch(new Request(`https://my-app.void.app/docs${query}`), env, ctx);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    }

    // The clean request renders + writes; later requests hit the same KV
    // slot regardless of `?cb=` value, so the worker is invoked exactly once.
    expect(workerFetch).toHaveBeenCalledTimes(1);
    const variantKeys = [...kvStore.keys()].filter((k) => k.includes('#rw='));
    expect(variantKeys).toHaveLength(1);
  });

  it('keeps allowlisted query params in the variant key (distinct slots per value)', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/*', destination: '/en/:splat', status: 200 }],
        queryAllowlist: { '/search': ['q'] },
      },
      workerResponse: new Response('<html>x</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const send = async (url: string) => {
      const ctx = createCtx();
      await app.fetch(new Request(url), env, ctx);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    };

    await send('https://my-app.void.app/search?q=void');
    await send('https://my-app.void.app/search?q=void&cb=1'); // cb dropped → same slot
    await send('https://my-app.void.app/search?q=void&cb=2'); // different cb → same slot
    await send('https://my-app.void.app/search?q=cloud'); // different q → new slot

    // Four requests, two distinct cache slots, two worker invocations.
    expect(workerFetch).toHaveBeenCalledTimes(2);
    const variantKeys = [...kvStore.keys()].filter((k) => k.includes('#rw='));
    expect(variantKeys).toHaveLength(2);
  });

  describe('query params outside the allowlist', () => {
    const settle = async (ctx: ExecutionContext) => {
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    };
    // The page reflects `msg`, which no allowlist names.
    const renderMsg = async (request: Request) =>
      new Response(`<html>${new URL(request.url).searchParams.get('msg') ?? 'clean'}</html>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    const rewriteRules = [{ source: '/old', destination: '/blog/post', status: 200 }];

    it.each([
      { label: 'a direct request', rewrite: false },
      { label: 'a redirect-rule rewrite', rewrite: true },
    ])('does not store a cold render for $label', async ({ rewrite }) => {
      const source = rewrite ? '/old' : '/blog/post';
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          ...(rewrite ? { redirectRules: rewriteRules } : {}),
        },
      });
      workerFetch.mockImplementation(renderMsg);

      const poisonedCtx = createCtx();
      const poisoned = await app.fetch(
        new Request(`https://my-app.void.app${source}?msg=evil`),
        env,
        poisonedCtx,
      );
      await settle(poisonedCtx);
      // Rendered live from the full URL for this visitor, but never shared.
      expect(await poisoned.text()).toBe('<html>evil</html>');
      expect(kvStore.size).toBe(0);
      expect(edgeCacheStore.size).toBe(0);

      const cleanCtx = createCtx();
      const clean = await app.fetch(new Request(`https://my-app.void.app${source}`), env, cleanCtx);
      await settle(cleanCtx);
      expect(clean.headers.get('x-isr-cache')).toBe('MISS');
      expect(await clean.text()).toBe('<html>clean</html>');
      expect([...kvStore.keys()]).toEqual([
        isrCacheKey(
          'proj_1',
          'legacy',
          'my-app.void.app',
          '/blog/post',
          rewrite ? 'https://my-app.void.app/old' : undefined,
        ),
      ]);

      // Once warm, the same unlisted param gets the shared page.
      const later = await app.fetch(
        new Request(`https://my-app.void.app${source}?msg=evil`),
        env,
        createCtx(),
      );
      expect(later.headers.get('x-isr-cache')).toBe('HIT');
      expect(await later.text()).toBe('<html>clean</html>');
      expect(workerFetch).toHaveBeenCalledTimes(2);
    });

    it.each([
      { label: 'a direct request', rewrite: false, query: '' },
      { label: 'a redirect-rule rewrite', rewrite: true, query: '' },
      { label: 'a direct request with an allowlisted param', rewrite: false, query: 'q=a' },
      { label: 'a redirect-rule rewrite with an allowlisted param', rewrite: true, query: 'q=a' },
    ])('refreshes a stale entry from the cache key URL for $label', async ({ rewrite, query }) => {
      const source = rewrite ? '/old' : '/blog/post';
      const search = query ? `?${query}` : '';
      const originalUrl =
        rewrite || query ? `https://my-app.void.app${source}${search}` : undefined;
      const key = isrCacheKey('proj_1', 'legacy', 'my-app.void.app', '/blog/post', originalUrl);
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          queryAllowlist: { '/blog/post': ['q'], '/old': ['q'] },
          ...(rewrite ? { redirectRules: rewriteRules } : {}),
        },
        assets: {
          [key]: {
            body: '<html>stale</html>',
            createdAt: Date.now() - 120_000,
            ttl: 60,
            headers: { 'Content-Type': 'text/html' },
          },
        },
      });
      workerFetch.mockImplementation(renderMsg);

      const ctx = createCtx();
      const response = await app.fetch(
        new Request(`https://my-app.void.app${source}?${query ? `${query}&` : ''}msg=evil`, {
          headers: { 'X-Test-Marker': 'keep' },
        }),
        env,
        ctx,
      );
      expect(response.headers.get('x-isr-cache')).toBe('STALE');
      expect(await response.text()).toBe('<html>stale</html>');
      await settle(ctx);

      expect(workerFetch).toHaveBeenCalledOnce();
      const refresh = workerFetch.mock.calls[0]![0] as Request;
      expect(refresh.url).toBe(`https://my-app.void.app/blog/post${search}`);
      expect(refresh.headers.get('X-Test-Marker')).toBe('keep');
      expect(refresh.headers.get('X-Void-Original-URL')).toBe(
        rewrite ? `https://my-app.void.app/old${search}` : null,
      );
      const unpacked = unpackIsrValue(kvStore.get(key)!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>clean</html>');
    });
  });

  describe('allowlisted query params on direct requests', () => {
    const send = async (env: Env, path: string) => {
      const ctx = createCtx();
      const response = await app.fetch(new Request(`https://my-app.void.app${path}`), env, ctx);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      return response;
    };
    // The page reflects `q`.
    const renderQuery = async (request: Request) =>
      new Response(`<html>${new URL(request.url).searchParams.get('q') ?? 'none'}</html>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    const bareKey = isrCacheKey('proj_1', 'legacy', 'my-app.void.app', '/search');

    it('stores each allowlisted value under its own key', async () => {
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          queryAllowlist: { '/search': ['q'] },
        },
      });
      workerFetch.mockImplementation(renderQuery);

      expect(await (await send(env, '/search?q=a')).text()).toBe('<html>a</html>');
      const b = await send(env, '/search?q=b');
      expect(b.headers.get('x-isr-cache')).toBe('MISS');
      expect(await b.text()).toBe('<html>b</html>');
      const again = await send(env, '/search?q=a');
      expect(again.headers.get('x-isr-cache')).toBe('HIT');
      expect(await again.text()).toBe('<html>a</html>');
      expect(workerFetch).toHaveBeenCalledTimes(2);
      expect([...kvStore.keys()].filter((k) => k.includes('#rw='))).toHaveLength(2);
      expect(kvStore.has(bareKey)).toBe(false);

      // A request without allowlisted params keeps the bare key.
      const plain = await send(env, '/search');
      expect(plain.headers.get('x-isr-cache')).toBe('MISS');
      expect(await plain.text()).toBe('<html>none</html>');
      expect(kvStore.has(bareKey)).toBe(true);
    });

    it('shares the bare key across query values without an allowlist', async () => {
      const { env, workerFetch, kvStore } = createEnv({
        routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      });
      workerFetch.mockImplementation(renderQuery);

      expect((await send(env, '/search')).headers.get('x-isr-cache')).toBe('MISS');
      for (const path of ['/search?q=a', '/search?q=b']) {
        const response = await send(env, path);
        expect(response.headers.get('x-isr-cache')).toBe('HIT');
        expect(await response.text()).toBe('<html>none</html>');
      }
      expect(workerFetch).toHaveBeenCalledOnce();
      expect([...kvStore.keys()]).toEqual([bareKey]);
    });

    it('keys allowlisted params when fallback rules cover other paths', async () => {
      const { env, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          queryAllowlist: { '/search': ['q'] },
          fallbackRules: [{ source: '/app/*', destination: '/index.html', status: 200 }],
        },
        workerResponse: new Response('<html>a</html>', {
          headers: { 'Content-Type': 'text/html' },
        }),
      });

      await send(env, '/search?q=a');
      expect([...kvStore.keys()]).toEqual([
        isrCacheKey(
          'proj_1',
          'legacy',
          'my-app.void.app',
          '/search',
          'https://my-app.void.app/search?q=a',
        ),
      ]);
    });
  });

  it('isolates ISR KV keys between direct and rewritten requests to the same path', async () => {
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('<html>rendered</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const directCtx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/en/docs'), env, directCtx);
    await Promise.all(
      (directCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );

    const rewriteCtx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/docs'), env, rewriteCtx);
    await Promise.all(
      (rewriteCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );

    // Worker invoked once per request — neither saw a cached entry written by
    // the other, because the KV keys carry a rewrite-variant suffix.
    expect(workerFetch).toHaveBeenCalledTimes(2);

    const keys = [...kvStore.keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('proj_1/isr/v3/legacy/my-app.void.app/en/docs');
    expect(keys[1]!.startsWith('proj_1/isr/v3/legacy/my-app.void.app/en/docs#rw=')).toBe(true);
  });

  // Fallback-write ISR hole: on an ISR miss a fallback rule can rewrite a page
  // 404 into a 200 from `/api/*`. An `/api` body is per-request dynamic, so it
  // must be served live but NEVER cached under the original page URL. The
  // miss-write and background-revalidation sites now gate on `!isApiPath(...)`
  // of the POST-fallback pathname. Only the WINNING EXACT declared literal ISR
  // page (rendered as HTML) may enter the shared page key — a dotted HTML target
  // (a SPA `/index.html` shell, a `/account.html` endpoint) is served live but
  // NOT ISR-cached, because path shape cannot distinguish a static shell from a
  // dynamic per-user endpoint (see `isFallbackTargetCacheable`).
  describe('fallback rewrite never poisons the ISR cache', () => {
    it('does NOT ISR-cache a page 404 that a fallback rewrites to /api/*', async () => {
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          // Catch-all fallback rewrites any unmatched page to an API route.
          fallbackRules: [{ source: '/*', destination: '/api/data', status: 200 }],
        },
        // Call 1 (original /dashboard) 404s; call 2 (fallback /api/data) returns
        // the API body. Two worker calls per request (original + fallback).
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"secret":"api-only"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

      // The API fallback body is served LIVE to the client on the miss...
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"secret":"api-only"}');
      expect(response.headers.get('x-isr-cache')).toBeNull();

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

      // ...but is never written into the ISR cache under the page URL.
      expect(kvStore.has('proj_1/isr/v3/legacy/my-app.void.app/dashboard')).toBe(false);
      expect([...kvStore.keys()]).toHaveLength(0);

      // A repeat request re-renders live (worker hit again) — no cached API body
      // was left to serve.
      const callsBefore = workerFetch.mock.calls.length;
      const ctx2 = createCtx();
      const repeat = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx2);
      expect(repeat.headers.get('x-isr-cache')).not.toBe('HIT');
      expect(await repeat.text()).toBe('{"secret":"api-only"}');
      expect(workerFetch.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('does NOT ISR-cache a page 404 rewritten to a SPA /index.html shell (served live)', async () => {
      // Shell fallbacks are served live, not ISR-cached: a dotted HTML target
      // (`/index.html`) is INDISTINGUISHABLE here from a dynamic per-user endpoint,
      // so path shape is NOT trusted as a "static shell" signal. The shell is still
      // SERVED (200 + body); its cache home is the static-asset path, not the shared
      // page key. See `isFallbackTargetCacheable`.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>spa shell</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // The shell is served LIVE to the client on the miss...
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>spa shell</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      // ...but is never written into the ISR cache under the page URL (any variant).
      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);

      // A repeat request re-renders live (worker hit again) — no cached shell to serve.
      const callsBefore = workerFetch.mock.calls.length;
      const ctx2 = createCtx();
      const repeat = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx2);
      expect(repeat.headers.get('x-isr-cache')).not.toBe('HIT');
      expect(await repeat.text()).toBe('<html>spa shell</html>');
      expect(workerFetch.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('does NOT ISR-cache a fallback to a DOTTED DYNAMIC endpoint returning JSON (no Cache-Control)', async () => {
      // Cross-user leak: a dotted path is NOT proof of a static shell. A fallback
      // `/* → /session.json` turns a page 404 into a per-user 200 with NO
      // Cache-Control. `/session.json` has an extension but its RENDER is JSON — a
      // DYNAMIC endpoint, not a page shell — so it must not be shared-cached under
      // `/dashboard`. The `isHtmlResponse` conjunct closes it.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          fallbackRules: [{ source: '/*', destination: '/session.json', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"user":"per-caller-session"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // The per-user JSON body is served LIVE to the client on the miss...
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"user":"per-caller-session"}');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // ...but is NEVER written into the ISR cache under any /dashboard key.
      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);
    });

    it('does NOT ISR-cache a dotted HTML fallback target (dynamic per-user /account.html)', async () => {
      // Cross-user leak: a dot + `text/html` are BOTH controlled by a dynamic
      // handler — no static-asset provenance. A fallback `/* → /account.html`
      // returning caller-specific HTML with NO Cache-Control must NOT enter the shared
      // page key. `pages` does NOT declare `/account.html` as a literal ISR page, so it
      // is served live but never shared-cached. See `isFallbackTargetCacheable`.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          fallbackRules: [{ source: '/*', destination: '/account.html', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>account of caller-A</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // The per-user HTML body is served LIVE to the client on the miss...
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>account of caller-A</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // ...but is NEVER written into the ISR cache under any /dashboard key.
      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);
    });

    it('background revalidation does NOT overwrite or evict a page entry when the re-render falls back to a dotted HTML /account.html target', async () => {
      // Background path: a stale-serve triggers a background
      // re-render that 404s and falls back to `/account.html` (200 text/html, no
      // Cache-Control, per-user body). A dotted HTML target is not positively
      // identifiable as page content, so the re-render must NOT overwrite the good
      // `/dashboard` entry — nor evict it.
      let n = 0;
      // A fallback rule matches the path, so the ISR read/write key carries the
      // rewrite-variant suffix. Seed the stale entry under that exact variant key.
      const variantSeedKey = isrCacheKey(
        'proj_1',
        'legacy',
        'my-app.void.app',
        '/dashboard',
        'https://my-app.void.app/dashboard',
      );
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          fallbackRules: [{ source: '/*', destination: '/account.html', status: 200 }],
        },
        assets: {
          [variantSeedKey]: {
            body: '<html>stale-page</html>',
            createdAt: Date.now() - 120 * 1000, // 2 min ago, TTL 60s → stale
            ttl: 60,
            headers: { 'Content-Type': 'text/html' },
          },
        },
        // Background re-render: worker 404s, fallback rewrites to /account.html (200).
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>account of caller-A</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // Stale page body served immediately from the seeded entry.
      expect(response.headers.get('x-isr-cache')).toBe('STALE');
      expect(await response.text()).toBe('<html>stale-page</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // The /account.html body must NOT overwrite the page entry, and the entry must
      // NOT be evicted — the seeded good body remains in place under the same key.
      const cached = kvStore.get(variantSeedKey);
      expect(cached).toBeDefined();
      const unpacked = unpackIsrValue(cached!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale-page</html>');
    });

    it('does NOT ISR-cache a fallback to an UNDECLARED extensionless page', async () => {
      // Security tightening (C9): a fallback whose target is extensionless AND not a
      // declared `pages` entry is INDISTINGUISHABLE from a per-user dynamic endpoint
      // (e.g. `/graphql`), so it must NOT enter the shared page cache — positive
      // identification (the WINNING EXACT declared literal ISR page, rendered as HTML)
      // is required, never the mere absence of an opt-out header. (Previously this WAS
      // cached; the change closes a cross-user data-exposure hole.) A DECLARED
      // literal-page fallback still caches — see the `/catch` positive case below.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          // Fallback to an UNDECLARED extensionless target (not /api, no extension,
          // no matching `pages` entry) — not positively identifiable as page content.
          fallbackRules: [{ source: '/*', destination: '/index', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>fallback page</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // The fallback body is served LIVE to the client on the miss...
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>fallback page</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      // ...but is never written into the ISR cache under the page URL (any variant).
      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);

      // A repeat request re-renders live (worker hit again) — no cached body left.
      const callsBefore = workerFetch.mock.calls.length;
      const ctx2 = createCtx();
      const repeat = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx2);
      expect(repeat.headers.get('x-isr-cache')).not.toBe('HIT');
      expect(await repeat.text()).toBe('<html>fallback page</html>');
      expect(workerFetch.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('background revalidation does NOT overwrite a page entry when the re-render falls back to /api', async () => {
      let n = 0;
      // A fallback rule matches the path, so both the ISR read key and the
      // background-revalidation write key carry the rewrite-variant suffix. Seed
      // the stale entry under that exact variant key (no query → the variant URL
      // is the request URL itself) so the read HITs it and revalidation runs.
      const variantSeedKey = isrCacheKey(
        'proj_1',
        'legacy',
        'my-app.void.app',
        '/dashboard',
        'https://my-app.void.app/dashboard',
      );
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          fallbackRules: [{ source: '/*', destination: '/api/data', status: 200 }],
        },
        // A stale page entry is served; background revalidation re-renders.
        assets: {
          [variantSeedKey]: {
            body: '<html>stale-page</html>',
            createdAt: Date.now() - 120 * 1000, // 2 min ago, TTL 60s → stale
            ttl: 60,
            headers: { 'Content-Type': 'text/html' },
          },
        },
        // Background re-render: worker 404s, fallback rewrites to /api/data (200).
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"secret":"api-only"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // Stale page body served immediately from the seeded entry.
      expect(response.headers.get('x-isr-cache')).toBe('STALE');
      expect(await response.text()).toBe('<html>stale-page</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // The API fallback body must NOT overwrite the page's ISR entry — the stale
      // page body is left in place (ttl !== 0, so it is not deleted either).
      const cached = kvStore.get(variantSeedKey);
      expect(cached).toBeDefined();
      const unpacked = unpackIsrValue(cached!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale-page</html>');
    });

    it('does NOT ISR-cache a fallback rewrite to an undeclared dynamic /graphql target (no Cache-Control)', async () => {
      // Cross-user leak: a user fallback `/* → /graphql` turns a page
      // 404 into a 200 with NO Cache-Control. `/graphql` is not `/api`, has no
      // extension, and matches no declared `pages` entry — positively-unidentifiable
      // as page content — so it must NOT be shared-cached under the `/dashboard` key
      // (its body may be cookie-derived / tenant-private). The `isApiPath` and
      // `hasCacheOptOut` gates cannot see this; the positive-ID gate closes it.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          // Per-pattern `pages` that does NOT include /graphql; /dashboard IS a
          // declared page so the request enters the ISR ladder (keying under it).
          pages: [{ pattern: '/dashboard', revalidate: 60 }],
          fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"data":"per-user"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // The dynamic body is served LIVE to the client on the miss...
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"data":"per-user"}');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // ...but is NEVER written into the ISR cache under any /dashboard key.
      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);
    });

    it('background revalidation does NOT overwrite or evict a page entry when the re-render falls back to an undeclared /graphql target', async () => {
      // C9: a stale-serve triggers a background re-render that 404s and falls back to
      // `/graphql` (200, no Cache-Control). `/graphql` is not positively identifiable
      // as page content, so the re-render must NOT overwrite the good `/dashboard`
      // entry — nor evict it (a fallback firing means the origin 404'd, often
      // transiently; the last-known-good page must survive).
      let n = 0;
      // A fallback rule matches the path, so the ISR read/write key carries the
      // rewrite-variant suffix. Seed the stale entry under that exact variant key.
      const variantSeedKey = isrCacheKey(
        'proj_1',
        'legacy',
        'my-app.void.app',
        '/dashboard',
        'https://my-app.void.app/dashboard',
      );
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
        },
        assets: {
          [variantSeedKey]: {
            body: '<html>stale-page</html>',
            createdAt: Date.now() - 120 * 1000, // 2 min ago, TTL 60s → stale
            ttl: 60,
            headers: { 'Content-Type': 'text/html' },
          },
        },
        // Background re-render: worker 404s, fallback rewrites to /graphql (200).
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"data":"per-user"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      // Stale page body served immediately from the seeded entry.
      expect(response.headers.get('x-isr-cache')).toBe('STALE');
      expect(await response.text()).toBe('<html>stale-page</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // The /graphql body must NOT overwrite the page entry, and the entry must NOT
      // be evicted — the seeded good body remains in place under the same key.
      const cached = kvStore.get(variantSeedKey);
      expect(cached).toBeDefined();
      const unpacked = unpackIsrValue(cached!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale-page</html>');
    });

    it('DOES ISR-cache a page 404 that falls back to a DECLARED page route', async () => {
      // Positive control for the C9 gate: when the fallback TARGET matches a declared
      // `pages` entry (`/catch`), it IS positively identifiable as cacheable page
      // content, so the render is cached under the ORIGINAL `/dashboard` page key —
      // the framework "rewrite an unmatched request to a real page" feature keeps
      // working. (`/dashboard` enters the ISR ladder via the flat `revalidate`, so
      // the write keys under it; `/catch` is the positively-identified target.)
      let n = 0;
      const { env, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          revalidate: 60,
          pages: [{ pattern: '/catch', revalidate: 60 }],
          fallbackRules: [{ source: '/*', destination: '/catch', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>catch page</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>catch page</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      // The declared-page fallback IS cached under the ORIGINAL /dashboard page URL
      // (a fallback rule matches, so the key carries a `#rw=` variant suffix).
      const pageKey = [...kvStore.keys()].find((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(pageKey).toBeDefined();
      const unpacked = unpackIsrValue(kvStore.get(pageKey!)!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>catch page</html>');
    });

    it('does NOT ISR-cache a fallback to /graphql when a CATCH-ALL page vouches for it (JSON)', async () => {
      // A catch-all page `/:path{.+}` first-matches ANY path, so
      // `resolvePageTtl(pages, undefined, '/graphql') > 0` would let the catch-all
      // vouch for an arbitrary fallback target and cache a per-user body under
      // `/dashboard` (cross-user leak). A catch-all match is NOT an exact literal-page
      // match, so it must not vouch. (JSON is also blocked by the HTML gate — see the HTML
      // variant below for the case only the LITERAL-match requirement catches.)
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          // Root catch-all page: `/dashboard` enters the ISR ladder (keys under it),
          // and — pre-fix — it also "vouched" for the `/graphql` fallback target.
          pages: [{ pattern: '/:path{.+}', revalidate: 60 }],
          fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"data":"per-user"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"data":"per-user"}');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);
    });

    it('does NOT ISR-cache a fallback to /graphql when a CATCH-ALL page vouches for it (HTML)', async () => {
      // The case the HTML gate ALONE would miss: the SAME catch-all
      // page + `/* → /graphql`, but `/graphql` renders `text/html`. The response
      // passes `isHtmlResponse`, so ONLY the exact-literal-page requirement keeps it
      // out — a catch-all page (`/:path{.+}`) is not literal, so it never positively
      // identifies `/graphql` as a specific declared page. A dynamic HTML endpoint
      // with no Cache-Control must NOT be shared-cached under `/dashboard`.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          pages: [{ pattern: '/:path{.+}', revalidate: 60 }],
          fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>per-user graphql</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>per-user graphql</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);
    });

    it('does NOT ISR-cache a fallback to /graphql when a catch-all is FIRST-MATCH ahead of a later literal /graphql page (HTML)', async () => {
      // Route-precedence leak: `pages` is declared catch-all FIRST, literal
      // `/graphql` SECOND (ingest validates shape, not ordering). The framework's
      // matchRoute renders `/graphql` via its FIRST-match winner — the catch-all —
      // i.e. dynamically. Scanning the whole table would match the LATER literal
      // `/graphql` and shared-cache a per-user HTML 200 under `/dashboard`.
      // Honoring first-match precedence, the catch-all is the winning route → NOT
      // literal → the render must NOT be cached.
      let n = 0;
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          // Catch-all FIRST, literal /graphql SECOND — the precedence the fix addresses.
          pages: [
            { pattern: '/:path{.+}', revalidate: 60 },
            { pattern: '/graphql', revalidate: 60 },
          ],
          fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('<html>per-user graphql</html>', {
                status: 200,
                headers: { 'Content-Type': 'text/html' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>per-user graphql</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      const written = [...kvStore.keys()].filter((k) =>
        k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
      );
      expect(written).toHaveLength(0);
    });

    it('background revalidation does NOT overwrite or evict a page entry when a CATCH-ALL page vouches for the /graphql fallback target', async () => {
      // Background path: a stale-serve triggers a re-render that 404s and falls back
      // to `/graphql` (200 JSON, no Cache-Control) under a root catch-all page. The
      // exact-literal-page requirement keeps the per-user body from overwriting the
      // good `/dashboard` entry — the seeded good body must survive, un-evicted.
      let n = 0;
      const variantSeedKey = isrCacheKey(
        'proj_1',
        'legacy',
        'my-app.void.app',
        '/dashboard',
        'https://my-app.void.app/dashboard',
      );
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'user-app',
          projectId: 'proj_1',
          ssr: true,
          pages: [{ pattern: '/:path{.+}', revalidate: 60 }],
          fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
        },
        assets: {
          [variantSeedKey]: {
            body: '<html>stale-page</html>',
            createdAt: Date.now() - 120 * 1000, // 2 min ago, TTL 60s → stale
            ttl: 60,
            headers: { 'Content-Type': 'text/html' },
          },
        },
        workerFetchImpl: async () => {
          n++;
          return n % 2 === 1
            ? new Response('missing', { status: 404 })
            : new Response('{"data":"per-user"}', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
        },
      });

      const ctx = createCtx();
      const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
      expect(response.headers.get('x-isr-cache')).toBe('STALE');
      expect(await response.text()).toBe('<html>stale-page</html>');

      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(workerFetch).toHaveBeenCalled();

      // The /graphql body must NOT overwrite the page entry, and the entry must NOT
      // be evicted — the seeded good body remains in place under the same key.
      const cached = kvStore.get(variantSeedKey);
      expect(cached).toBeDefined();
      const unpacked = unpackIsrValue(cached!.value);
      expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale-page</html>');
    });
  });
});

// ISR must never cache a response that declares itself uncacheable via
// Cache-Control (private/no-store/no-cache). Every ISR write site gates on
// `!hasCacheOptOut(<response>)`. This is defense-in-depth beyond the `/api`
// path guard: a fallback whose target is a non-`/api`, non-extension DYNAMIC
// endpoint (e.g. `/graphql`) declares its own uncacheability via Cache-Control,
// and the write must respect that even though the path gate cannot see it.
describe('ISR respects response Cache-Control opt-out', () => {
  // Normal write-back site (post-fallback SSR path, requestType === 'ssr').
  // Reached when the ORIGINAL path bypasses the ISR ladder (here: `/api/*`, so
  // not ladder-eligible and not a static candidate), the worker 404s, and a
  // fallback rule rewrites to a clean SSR page returning 200. That render is
  // requestType 'ssr' with a positive config TTL, so it hits the normal
  // write-back gate — NOT the ISR-ladder miss-write.
  it('normal write-back does NOT cache a fallback-rewritten SSR 200 that sets Cache-Control: no-store', async () => {
    let n = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        // Original `/api/*` request bypasses the ISR ladder; on the worker 404
        // it rewrites to a clean SSR page path.
        fallbackRules: [{ source: '/api/*', destination: '/dashboard', status: 200 }],
      },
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>rendered</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/api/miss'), env, ctx);
    // The page is served live to the client...
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>rendered</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalled();

    // ...but a `no-store` response must never be written into the ISR cache
    // under the page URL. No ISR entry for `/dashboard` (any variant suffix).
    const written = [...kvStore.keys()].filter((k) =>
      k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
    );
    expect(written).toHaveLength(0);
  });

  // Site 3 now mirrors the miss-write's positive-ID policy: a fallback render is
  // shared-cached under the TARGET key ONLY when the target is a positively
  // identified declared literal ISR page rendering HTML. `/dashboard` reached via
  // `/api/* → /dashboard` is NOT a declared page here (routing has a flat
  // `revalidate`, no `pages` entry that literally matches `/dashboard`), so under
  // the fallback positive-ID gate it is NO LONGER cached — even though the 200
  // carries no Cache-Control opt-out. (This write was already ORPHANED before the
  // gate: it keyed under `/dashboard#rw=hash(/api/miss)`, and no later request
  // recomputes that pair — `/api/miss` never enters the ISR read ladder, and a
  // direct `/dashboard` request reads the suffix-less direct key. The gate removes
  // the wasted write and makes all three ISR write sites consistent.)
  it('normal write-back does NOT cache a fallback-rewritten SSR 200 to an UNDECLARED target, even without a Cache-Control opt-out', async () => {
    let n = 0;
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        fallbackRules: [{ source: '/api/*', destination: '/dashboard', status: 200 }],
      },
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>rendered</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/api/miss'), env, ctx);
    // Served LIVE to the client...
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>rendered</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    // ...but NEVER written into the ISR cache under any `/dashboard` key — the
    // fallback target is not a positively identified declared literal page.
    const written = [...kvStore.keys()].filter((k) =>
      k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
    );
    expect(written).toHaveLength(0);
  });

  // Normal write-back site: the ORIGINAL `/api/*`
  // request bypasses the ISR ladder, 404s, and a fallback rewrites to an
  // extensionless DYNAMIC target (`/graphql`) that returns a 200 HTML body with NO
  // Cache-Control. `isApiPath` does not catch `/graphql`; the opt-out guard does
  // not fire (no Cache-Control); `isHtmlResponse` passes. ONLY the fallback
  // positive-ID gate (`!fallbackResult.applied || isFallbackTargetCacheable(...)`)
  // stops this per-request body from being written under the fallback TARGET key.
  it('normal write-back does NOT ISR-cache a fallback to an undeclared dynamic /graphql target (HTML 200, no Cache-Control)', async () => {
    let n = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        // `/graphql` is not `/api`, has no extension, and is NOT a declared page.
        fallbackRules: [{ source: '/api/*', destination: '/graphql', status: 200 }],
      },
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>dynamic-per-request</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/api/miss'), env, ctx);
    // The dynamic body is served LIVE to the client...
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>dynamic-per-request</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalled();

    // ...but is NEVER written into the ISR cache under any `/graphql` key.
    const written = [...kvStore.keys()].filter((k) =>
      k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/graphql'),
    );
    expect(written).toHaveLength(0);
  });

  // Positive control: the SAME normal write-back path to a DECLARED literal page
  // (`pages: [{ pattern: '/catch', revalidate: 60 }]`, `/api/* → /catch`, HTML
  // 200). The positive-ID gate ADMITS a positively identified declared literal
  // page — proving site 3 still caches legitimate fallback-rewritten pages, exactly
  // like the miss-write and background-revalidation sites.
  it('normal write-back DOES cache a fallback-rewritten SSR 200 to a DECLARED literal page', async () => {
    let n = 0;
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        pages: [{ pattern: '/catch', revalidate: 60 }],
        fallbackRules: [{ source: '/api/*', destination: '/catch', status: 200 }],
      },
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>rendered</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/api/miss'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>rendered</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    const pageKey = [...kvStore.keys()].find((k) =>
      k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/catch'),
    );
    expect(pageKey).toBeDefined();
    const unpacked = unpackIsrValue(kvStore.get(pageKey!)!.value);
    expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>rendered</html>');
  });

  // Miss-write site (ISR ladder): an ISR-eligible page 404s and a fallback
  // rewrites to a non-`/api`, non-extension DYNAMIC target (`/graphql`) that
  // returns 200 with `Cache-Control: private`. The `isApiPath` guard does NOT
  // catch `/graphql`; the Cache-Control opt-out guard does.
  it('miss-write does NOT cache a fallback rewrite to a dynamic /graphql target that sets Cache-Control: private', async () => {
    let n = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        // Fallback to a dynamic endpoint that is neither `/api` nor an extension.
        fallbackRules: [{ source: '/*', destination: '/graphql', status: 200 }],
      },
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('{"data":"per-request"}', {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    // The dynamic body is served LIVE to the client on the miss...
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"data":"per-request"}');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalled();

    // ...but a `private` response must never enter the ISR cache under the page
    // URL, even though `/graphql` passes the `isApiPath` guard.
    const written = [...kvStore.keys()].filter((k) =>
      k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
    );
    expect(written).toHaveLength(0);
  });

  // Cache-Control directive names are case-insensitive (RFC 9111 §5.2). A
  // MIXED-CASE opt-out (`No-Store`, `PRIVATE`) must be honored exactly like its
  // lowercase form — a case-sensitive matcher would silently cache it.
  it('miss-write does NOT cache an SSR 200 whose opt-out is mixed-case (Cache-Control: No-Store)', async () => {
    const { env, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
      },
      workerResponse: new Response('<html>rendered</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'No-Store' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.status).toBe(200);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    const written = [...kvStore.keys()].filter((k) =>
      k.startsWith('proj_1/isr/v3/legacy/my-app.void.app/dashboard'),
    );
    expect(written).toHaveLength(0);
  });

  // Background-revalidation EVICTION: a stale shared entry is served while a
  // background re-render runs. If that fresh render is a 200 that now declares a
  // Cache-Control opt-out (the page became user-specific / withdrew its public
  // representation), the write is correctly skipped — but the EXISTING stale
  // copy must ALSO be evicted, or anonymous requests keep being served the old
  // public HTML of a now-private page (a staleness / data-exposure risk). Uses a
  // MIXED-CASE `No-Store` to also exercise the case-insensitive opt-out match.
  // The HTML edge entry is auto-populated by the stale serve itself (so it cannot
  // be pre-seeded without short-circuiting the L1 edge hit and skipping
  // revalidation); the JSON edge entry is seeded explicitly. All three go away.
  it('background revalidation evicts the stale entry when the fresh 200 declares a Cache-Control opt-out', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const htmlEdgeKey = 'https://my-app.void.app/dashboard?__void_isr=legacy';
    const jsonEdgeKey = 'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy';

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale-public</html>',
          createdAt: Date.now() - 120 * 1000, // 2 min ago, TTL 60s → stale
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      // Background re-render: 200 that has become uncacheable (page went private).
      // No `x-revalidate` header, so ttl resolves to the default 60 (> 0) — proving
      // eviction is driven by the opt-out, not by a `ttl === 0` opt-out.
      workerFetchImpl: async () =>
        new Response('<html>now-private</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'No-Store' },
        }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Stale public copy is served immediately; background revalidation is queued.
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale-public</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Every cached representation of the now-private page is gone: R2/KV, the
    // HTML edge entry (populated by the stale serve, then evicted), JSON edge.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(0);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(false);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(false);

    // A subsequent request no longer serves a cached HIT/STALE — it re-renders live.
    const ctx2 = createCtx();
    const live = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx2);
    expect(live.headers.get('x-isr-cache')).not.toBe('HIT');
    expect(live.headers.get('x-isr-cache')).not.toBe('STALE');
    expect(await live.text()).toBe('<html>now-private</html>');
  });

  it('background revalidation evicts HTML, JSON, and KV when a public page starts a session', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const htmlEdgeKey = 'https://my-app.void.app/dashboard?__void_isr=legacy';
    const jsonEdgeKey = 'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy';
    edgeCacheStore.set(
      jsonEdgeKey,
      currentSharedCacheResponse(
        new Response('{"component":"Dashboard","props":{},"url":"/dashboard"}'),
      ),
    );

    const { env, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale-public</html>',
          createdAt: Date.now() - 120_000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>session-user</html>', {
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': 'sid=new-session; Path=/; HttpOnly',
        },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(kvStore.has(kvKey)).toBe(false);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(false);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(false);
  });

  // Positive control: eviction is SPECIFIC to the opt-out. A stale entry whose
  // background re-render returns a CACHEABLE 200 (no Cache-Control opt-out) is
  // REFRESHED in place — the entry stays present, now carrying the fresh body.
  // Contrast with the eviction above: background revalidation itself does not
  // delete; only the opt-out does.
  it('background revalidation refreshes (does NOT evict) a stale entry when the fresh 200 is cacheable', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Entry is REFRESHED in place — still present, now with the fresh body.
    const packed = kvStore.get(kvKey);
    expect(packed).toBeDefined();
    const unpacked = unpackIsrValue(packed!.value);
    expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>fresh</html>');
  });

  // Eviction requires an AUTHORITATIVE opt-out render (200, not an `/api/*`
  // fallback). A TRANSIENT non-200 background re-render that happens to carry
  // `x-revalidate: 0` must NOT be treated as an opt-out — evicting on it would
  // turn a blip (a 500 from a flaky origin) into a user-visible outage, defeating
  // stale-while-revalidate. The last known-good entry must survive so a
  // subsequent request keeps serving it.
  it('background revalidation does NOT evict when the fresh re-render is a transient 500 (even with x-revalidate: 0)', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const htmlEdgeKey = 'https://my-app.void.app/dashboard?__void_isr=legacy';
    const jsonEdgeKey = 'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy';

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000, // 2 min ago, TTL 60s → stale
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      // Transient failure: a 500 that still carries `x-revalidate: 0`. The write
      // gate skips it (non-200), and eviction MUST also skip it (not authoritative).
      workerFetchImpl: async () =>
        new Response('origin exploded', {
          status: 500,
          headers: { 'x-revalidate': '0' },
        }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Stale copy is served immediately; background revalidation is queued.
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // All three cached representations REMAIN: R2/KV, HTML edge (populated by the
    // stale serve), JSON edge (seeded). The transient 500 evicted nothing.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(1);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(true);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(true);

    // A subsequent request still serves the cached (STALE) representation — no
    // outage, exactly the stale-while-revalidate resilience this guards.
    const ctx2 = createCtx();
    const again = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx2);
    expect(again.headers.get('x-isr-cache')).toBe('STALE');
    expect(await again.text()).toBe('<html>stale</html>');
  });

  // A background re-render that 404s and falls back to an `/api/*` route
  // returning 200 (with `x-revalidate: 0`) is NOT an authoritative page render —
  // the effective post-fallback path is `/api/*`, whose body is per-request
  // dynamic. Eviction must mirror the write gate (which refuses to cache an
  // `/api/*` fallback under the page URL): keep the last known-good page entry.
  it('background revalidation does NOT evict when a 404 falls back to /api/* (200, x-revalidate: 0)', async () => {
    // A `fallbackRules` rule that can handle `/dashboard` makes the ISR read
    // (and edge) keys carry the rewrite-variant suffix, since a later fallback
    // dispatch would expose that variant. Seed under the SAME variant keys the
    // read path computes (variant = the query-stripped original URL) using the
    // shared key builders — hardcoding the `#rw=` hash would be brittle.
    const variant = 'https://my-app.void.app/dashboard';
    const kvKey = isrCacheKey('proj_1', 'legacy', 'my-app.void.app', '/dashboard', variant);
    const htmlEdgeKey = isrEdgeCacheUrl('my-app.void.app', '/dashboard', 'legacy', 'html', variant);
    const jsonEdgeKey = isrEdgeCacheUrl('my-app.void.app', '/dashboard', 'legacy', 'json', variant);

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    let n = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        // The page 404s in the background; a fallback rewrites to an `/api/*` route.
        fallbackRules: [{ source: '/*', destination: '/api/data', status: 200 }],
      },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000, // stale
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerFetchImpl: async () => {
        n++;
        // 1st: page render 404s. 2nd: fallback `/api/data` returns a dynamic 200
        // that opts out via `x-revalidate: 0`.
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('{"api":"per-request"}', {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'x-revalidate': '0' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    // Worker called twice: original page (404) + fallback `/api/data` (200).
    expect(workerFetch).toHaveBeenCalledTimes(2);

    // The `/api/*` fallback is not an authoritative page render — all three page
    // representations REMAIN (parity with the miss-write /api guard).
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(1);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(true);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(true);
  });

  // Positive control for the unified `ttl === 0` arm: a stale entry whose
  // background re-render is an AUTHORITATIVE page render (200, not `/api/*`) that
  // opts out via `x-revalidate: 0` DOES evict all three representations. (The
  // existing bg tests at "deletes KV entry…" and "opt-out (ttl=0) deletes JSON
  // edge cache too" cover the KV and JSON edges individually; this asserts all
  // three go away together, symmetric with the Cache-Control eviction control.)
  it('background revalidation evicts all three representations on an authoritative 200 + x-revalidate: 0', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const htmlEdgeKey = 'https://my-app.void.app/dashboard?__void_isr=legacy';
    const jsonEdgeKey = 'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy';

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale-public</html>',
          createdAt: Date.now() - 120 * 1000, // stale
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      // Authoritative page render (200, not /api) that permanently opts out.
      workerFetchImpl: async () =>
        new Response('<html>opt-out</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'x-revalidate': '0' },
        }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Every cached representation is gone: R2/KV, HTML edge, JSON edge.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(0);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(false);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(false);
  });

  // The grace is measured from STALE-onset (`createdAt + ttl`), NOT
  // from creation. A long-TTL entry (TTL > the grace) that has only JUST become stale
  // must NOT be evicted by its first failed revalidation — otherwise a single transient
  // origin failure right after expiry wipes the last-known-good copy, defeating
  // stale-while-revalidate for exactly the entry the grace is meant to protect. With a
  // creation-based grace `Date.now() - createdAt` is already > 24h at stale-onset for
  // such an entry, so it would evict immediately; the stale-onset basis keeps it.
  it('background revalidation does NOT evict a long-TTL entry that just became stale when the re-render is a transient 500', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const htmlEdgeKey = 'https://my-app.void.app/dashboard?__void_isr=legacy';
    const jsonEdgeKey = 'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy';

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    // TTL of 25h (> the 24h grace); created (ttl + 60s) ago so it became STALE only
    // ~60s ago. Creation is ~25h in the past — a creation-based grace would evict.
    const ttl = 25 * 60 * 60;
    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: ttl },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          createdAt: Date.now() - (ttl + 60) * 1000,
          ttl,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      // Transient origin failure on the background re-render.
      workerFetchImpl: async () =>
        new Response('origin exploded', {
          status: 500,
          headers: { 'x-revalidate': '0' },
        }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Stale copy is served immediately; background revalidation is queued.
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Only ~60s STALE — well within the grace measured from stale-onset. All three
    // cached representations REMAIN: R2/KV, HTML edge (populated by the stale serve),
    // JSON edge (seeded). The transient failure evicted nothing.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(1);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(true);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(true);
    const packed = kvStore.get(kvKey);
    const unpacked = unpackIsrValue(packed!.value);
    expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale</html>');
  });

  // Convergence: a permanently-removed page whose origin now 404s and falls
  // back to a non-declared shell can NEITHER refresh (the write gate refuses to cache
  // the shell) NOR authoritatively opt-out-evict (a fallback fired, so that branch is
  // gated off). Without a bound it would serve its last cached body forever (ISR KV
  // puts set no expirationTtl). Once the entry has been STALE (since `createdAt + ttl`)
  // past the bounded grace (24h) — far beyond any transient deploy-race 404 — a
  // background re-render evicts it so the removal finally converges.
  it('background revalidation evicts an entry stale past the grace when the re-render can neither refresh nor opt-out-evict', async () => {
    // A fallback rule matches `/dashboard`, so the ISR read/write + edge keys carry
    // the rewrite-variant suffix. Build them with the shared key builders (variant =
    // the query-stripped original URL) rather than hardcoding the hash.
    const variant = 'https://my-app.void.app/dashboard';
    const kvKey = isrCacheKey('proj_1', 'legacy', 'my-app.void.app', '/dashboard', variant);
    const htmlEdgeKey = isrEdgeCacheUrl('my-app.void.app', '/dashboard', 'legacy', 'html', variant);
    const jsonEdgeKey = isrEdgeCacheUrl('my-app.void.app', '/dashboard', 'legacy', 'json', variant);

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    let n = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        // The page 404s in the background; a fallback rewrites to a non-declared,
        // dotted HTML shell (`/account.html`) — served live, never ISR-cached.
        fallbackRules: [{ source: '/*', destination: '/account.html', status: 200 }],
      },
      assets: {
        [kvKey]: {
          body: '<html>stale-removed</html>',
          // STALE-onset (`createdAt + ttl`) is 25h ago — past the 24h grace measured
          // from stale-onset, so eviction fires.
          createdAt: Date.now() - (60 + 25 * 60 * 60) * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      // 1st: page render 404s. 2nd: fallback `/account.html` returns 200 (non-cacheable).
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>account of caller-A</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    // Stale body served immediately from the seeded entry.
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale-removed</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalled();

    // Past the grace with no way to refresh → all three representations evicted.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(0);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(false);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(false);
  });

  // Grace-eviction requires POSITIVE removal evidence — the ORIGIN page's OWN
  // pre-fallback render returned 404/410 (gone). A TRANSIENT origin failure (5xx / 429 /
  // timeout) is a DEGRADED DEPENDENCY, not a removal, and is exactly what stale-while-
  // revalidate protects: even PAST the grace it must PRESERVE the stale entry. Wiping the
  // last-known-good copy on a 500 would turn a transient dependency outage into a hard
  // cache loss (and during a prolonged outage the first request for every old stale entry
  // would progressively delete the fallback cache). Contrast with the origin-404 eviction
  // test above: same beyond-grace age — the 404 converges, the 500 preserves.
  it('background revalidation does NOT evict an entry stale past the grace when the re-render is a transient 500', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const htmlEdgeKey = 'https://my-app.void.app/dashboard?__void_isr=legacy';
    const jsonEdgeKey = 'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy';

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    const ttl = 60;
    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: ttl },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          // STALE-onset (`createdAt + ttl`) is 25h ago — PAST the 24h grace. Age alone
          // would evict; the origin-status gate keeps it because the failure is transient.
          createdAt: Date.now() - (ttl + 25 * 60 * 60) * 1000,
          ttl,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      // Transient origin failure — a degraded dependency, NOT a removal. The `x-revalidate: 0`
      // proves even that header on a non-200 does not force eviction.
      workerFetchImpl: async () =>
        new Response('origin exploded', {
          status: 500,
          headers: { 'x-revalidate': '0' },
        }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Stale copy is served immediately; background revalidation is queued.
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Past the grace, but the origin returned 500 (not 404/410) → the stale entry is
    // PRESERVED. All three representations remain: R2/KV, HTML edge (populated by the
    // stale serve), JSON edge (seeded). The transient failure evicted nothing.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(1);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(true);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(true);
    const packed = kvStore.get(kvKey);
    const unpacked = unpackIsrValue(packed!.value);
    expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale</html>');
  });

  // 429 variant: a rate-limited origin is likewise a transient degraded dependency,
  // not a removal — beyond the grace it must still preserve the stale entry.
  it('background revalidation does NOT evict an entry stale past the grace when the re-render is a transient 429', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          // STALE-onset 25h ago — past the grace.
          createdAt: Date.now() - (60 + 25 * 60 * 60) * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerFetchImpl: async () => new Response('too many requests', { status: 429 }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Past the grace but a transient 429 (not 404/410) → entry preserved.
    const packed = kvStore.get(kvKey);
    expect(packed).toBeDefined();
    expect(new TextDecoder().decode(unpackIsrValue(packed!.value)!.body)).toBe(
      '<html>stale</html>',
    );
  });

  // Bounded: WITHIN the grace, the same unrefreshable re-render must NOT evict — a
  // transient origin 404 (a deploy race) keeps serving stale (stale-while-revalidate
  // resilience). Identical to the eviction test above but the entry is freshly stale.
  it('background revalidation does NOT evict an unrefreshable entry that is still within the grace', async () => {
    const variant = 'https://my-app.void.app/dashboard';
    const kvKey = isrCacheKey('proj_1', 'legacy', 'my-app.void.app', '/dashboard', variant);
    const htmlEdgeKey = isrEdgeCacheUrl('my-app.void.app', '/dashboard', 'legacy', 'html', variant);
    const jsonEdgeKey = isrEdgeCacheUrl('my-app.void.app', '/dashboard', 'legacy', 'json', variant);

    edgeCacheStore.set(
      jsonEdgeKey,
      new Response('{"component":"Dashboard","props":{"count":42},"url":"/dashboard"}', {
        headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
      }),
    );

    let n = 0;
    const { env, workerFetch, kvStore } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        fallbackRules: [{ source: '/*', destination: '/account.html', status: 200 }],
      },
      assets: {
        [kvKey]: {
          body: '<html>stale-transient</html>',
          // 2 min ago — stale (TTL 60s) but well within the 24h grace.
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerFetchImpl: async () => {
        n++;
        return n % 2 === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>account of caller-A</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
      },
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(await response.text()).toBe('<html>stale-transient</html>');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalled();

    // Within the grace → nothing evicted; all three representations remain.
    expect([...kvStore.keys()].filter((k) => k.startsWith(kvKey))).toHaveLength(1);
    expect(edgeCacheStore.has(htmlEdgeKey)).toBe(true);
    expect(edgeCacheStore.has(jsonEdgeKey)).toBe(true);
    const packed = kvStore.get(kvKey);
    const unpacked = unpackIsrValue(packed!.value);
    expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>stale-transient</html>');
  });

  // The grace branch is the LAST else-if: a healthy re-render hits the write branch
  // FIRST and refreshes in place — age never matters. An entry stale past the grace
  // whose re-render is a normal cacheable 200 is REFRESHED, NOT evicted.
  it('background revalidation refreshes (does NOT evict) a healthy entry even when it is stale past the grace', async () => {
    const kvKey = 'proj_1/isr/v3/legacy/my-app.void.app/dashboard';
    const { env, workerFetch, kvStore } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1', ssr: true, revalidate: 60 },
      assets: {
        [kvKey]: {
          body: '<html>stale</html>',
          // STALE-onset (`createdAt + ttl`) is 25h ago — past the grace, yet a
          // cacheable refresh must still win (write branch fires before the grace).
          createdAt: Date.now() - (60 + 25 * 60 * 60) * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // Entry is REFRESHED in place — still present, now with the fresh body (the write
    // branch fired before the grace branch could evict).
    const packed = kvStore.get(kvKey);
    expect(packed).toBeDefined();
    const unpacked = unpackIsrValue(packed!.value);
    expect(new TextDecoder().decode(unpacked!.body)).toBe('<html>fresh</html>');
  });
});

describe('ISR JSON edge cache (pages protocol)', () => {
  const isrRouting: RoutingEntry = {
    workerName: 'user-app',
    projectId: 'proj_1',
    ssr: true,
    revalidate: 60,
  };

  const pageData = JSON.stringify({
    component: 'Dashboard',
    props: { count: 42 },
    url: '/dashboard',
  });

  const pageHtml = (payload = pageData) =>
    `<html><body><script id="__VOID_PAGE_DATA__" type="application/json">${payload}</script><div id="app">rendered</div></body></html>`;

  it('pages request serves from JSON edge cache when populated', async () => {
    // Pre-populate JSON edge cache
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
      currentSharedCacheResponse(
        new Response(pageData, {
          headers: { 'content-type': 'application/json', 'x-isr-cache': 'HIT' },
        }),
      ),
    );

    const { env, workerFetch } = createEnv({ routing: isrRouting });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', {
        headers: { 'X-VoidPages': 'true' },
      }),
      env,
      createCtx(),
    );

    expect(workerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.json()).toEqual(JSON.parse(pageData));
  });

  it('pages request falls through to worker on JSON cache miss', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageData, {
        headers: { 'content-type': 'application/json' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/dashboard', {
        headers: { 'X-VoidPages': 'true' },
      }),
      env,
      createCtx(),
    );

    // Falls through to general dispatch — worker returns JSON for pages requests
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(pageData);
  });

  it('HTML cache miss populates both HTML and JSON edge caches', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('MISS');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    // Internal transport header should not leak to the client response
    expect(response.headers.has('x-void-page-data')).toBe(false);
    expect(await response.text()).toBe(pageHtml());

    // Wait for background writes
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // HTML edge cache populated
    const htmlCached = edgeCacheStore.get('https://my-app.void.app/dashboard?__void_isr=legacy');
    expect(htmlCached).toBeDefined();
    expect(htmlCached!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=60, max-age=0, must-revalidate',
    );
    // JSON edge cache populated
    const jsonCached = edgeCacheStore.get(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
    );
    expect(jsonCached).toBeDefined();
    expect(jsonCached!.headers.get('X-VoidPages')).toBe('true');
    expect(jsonCached!.headers.get('Vary')).toBe('X-VoidPages');
    const navigation = await app.fetch(
      new Request('https://my-app.void.app/dashboard', { headers: { 'X-VoidPages': 'true' } }),
      env,
      createCtx(),
    );
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(navigation.headers.get('X-VoidPages')).toBe('true');
    expect(navigation.headers.get('Vary')).toBe('X-VoidPages');
    expect(await navigation.json()).toEqual(JSON.parse(pageData));
  });

  it('serves the edge copies written on a miss as HIT for HTML and pages requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const first = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);
    expect(first.headers.get('x-isr-cache')).toBe('MISS');
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // No edge cache reset: both follow-up requests are served from the edge copy.
    const html = await app.fetch(
      new Request('https://my-app.void.app/dashboard'),
      env,
      createCtx(),
    );
    expect(html.headers.get('x-isr-cache')).toBe('HIT');
    expect(await html.text()).toBe(pageHtml());

    const json = await app.fetch(
      new Request('https://my-app.void.app/dashboard', { headers: { 'X-VoidPages': 'true' } }),
      env,
      createCtx(),
    );
    expect(json.headers.get('x-isr-cache')).toBe('HIT');
    expect(await json.json()).toEqual(JSON.parse(pageData));
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('background revalidation populates JSON edge cache', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Stale content returned immediately
    expect(response.headers.get('x-isr-cache')).toBe('STALE');

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // JSON edge cache populated from revalidation
    const jsonCached = edgeCacheStore.get(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
    );
    expect(jsonCached).toBeDefined();
    expect(jsonCached!.headers.get('X-VoidPages')).toBe('true');
    expect(jsonCached!.headers.get('Vary')).toBe('X-VoidPages');
    expect(await jsonCached!.text()).toBe(pageData);
    expect(jsonCached!.headers.get('x-isr-cache')).toBe('HIT');
  });

  it('background revalidation strips X-VoidPages from request', async () => {
    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>fresh</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    // Initial request has X-VoidPages but ISR serves from KV (HTML path)
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Verify the revalidation request does NOT have X-VoidPages
    const revalRequest = workerFetch.mock.calls[0][0] as Request;
    expect(revalRequest.headers.has('X-VoidPages')).toBe(false);
  });

  it('opt-out (ttl=0) deletes JSON edge cache too', async () => {
    // Pre-populate JSON edge cache
    edgeCacheStore.set(
      'https://my-app.void.app/dashboard?__void=json&__void_isr=legacy',
      new Response(pageData, {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { env, workerFetch } = createEnv({
      routing: isrRouting,
      assets: {
        'proj_1/isr/v3/legacy/my-app.void.app/dashboard': {
          body: '<html>stale</html>',
          createdAt: Date.now() - 120 * 1000,
          ttl: 60,
          headers: { 'Content-Type': 'text/html' },
        },
      },
      workerResponse: new Response('<html>opt-out</html>', {
        headers: { 'x-revalidate': '0' },
      }),
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    // Wait for background revalidation
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    expect(workerFetch).toHaveBeenCalledOnce();

    // JSON edge cache should be deleted
    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });

  it('write-behind populates JSON edge cache from embedded page data', async () => {
    // Non-ISR path (no revalidate config matching this path's ISR block) but
    // still has revalidate in routing — this tests the write-behind code path
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: { '/dashboard': 60 },
      },
      workerResponse: new Response(pageHtml(), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    // Request to /other — ISR TTL is 0 (no match), falls through to general dispatch
    // But /dashboard request would hit ISR... let's use a path that falls through ISR
    // but still triggers write-behind
    const ctx = createCtx();
    const response = await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    expect(workerFetch).toHaveBeenCalledOnce();
    // Internal transport header should not leak to the client response
    expect(response.headers.has('x-void-page-data')).toBe(false);
  });

  it('HTML response without embedded page data does not populate JSON cache', async () => {
    const { env } = createEnv({
      routing: isrRouting,
      workerResponse: new Response('<html>no-page-data</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // HTML cache is populated, but no JSON cache
    expect(edgeCacheStore.has('https://my-app.void.app/dashboard?__void_isr=legacy')).toBe(true);
    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });

  it('HTML response with deferred page data does not populate JSON cache', async () => {
    const deferredPageData =
      '{"component":"Dashboard","props":{"count":42},"url":"/dashboard","deferred":["stats"],"deferredKeys":{"stats":"stats"}}';
    const { env } = createEnv({
      routing: isrRouting,
      workerResponse: new Response(pageHtml(deferredPageData), {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, ctx);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(
      edgeCacheStore.has('https://my-app.void.app/dashboard?__void=json&__void_isr=legacy'),
    ).toBe(false);
  });
});

describe('suspension check', () => {
  it('returns 429 when project is suspended', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        suspended: 'requests_exceeded',
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'requests',
      reason: 'monthly_quota',
    });
  });
});

describe('custom limits', () => {
  it('passes limits to DISPATCH.get for API routes', async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        limits: { cpuMs: 10, subRequests: 50 },
      },
      workerResponse: new Response('api'),
    });

    await app.fetch(new Request('https://my-app.void.app/api/hello'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      'user-app',
      {},
      { limits: { cpuMs: 10, subRequests: 50 } },
    );
  });

  it('does not pass limits when routing has no limits', async () => {
    const { env, dispatchGet } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: new Response('api'),
    });

    await app.fetch(new Request('https://my-app.void.app/api/hello'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith('user-app');
  });

  it('returns 429 when worker exceeds CPU limit', async () => {
    const workerFetch = vi.fn(async () => {
      throw new Error('Worker exceeded CPU time limit');
    });
    const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));

    const env = {
      ROUTING: {
        get: async () =>
          JSON.stringify({
            workerName: 'user-app',
            projectId: 'proj_1',
            limits: { cpuMs: 10 },
          }),
      },
      DISPATCH: { get: dispatchGet },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'execution',
      reason: 'cpu',
    });
  });

  it('passes limits to DISPATCH.get for SSR routes', async () => {
    const { env, dispatchGet } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        limits: { cpuMs: 30, subRequests: 50 },
      },
      workerResponse: new Response('<html>ssr</html>'),
    });

    await app.fetch(new Request('https://my-app.void.app/dashboard'), env, createCtx());

    expect(dispatchGet).toHaveBeenCalledWith(
      'user-app',
      {},
      { limits: { cpuMs: 30, subRequests: 50 } },
    );
  });
});

describe('hashed asset caching', () => {
  it('serves hashed asset from edge cache on hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const url = 'https://test.void.app/assets/main-abc123.js';

    // First request — cache miss, hits worker
    const res1 = await app.fetch(new Request(url), env, ctx);
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    // Wait for background cache.put
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, worker NOT invoked
    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request(url), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // still 1
  });

  it('does not serve one project cached asset to the next project on the same host', async () => {
    const url = 'https://test.void.app/assets/main-abc123.js';
    const previous = createEnv({
      routing: { workerName: 'old-worker', projectId: 'proj-old', hashedAssetsPrefix: 'assets' },
      workerResponse: new Response('evil'),
    });
    const previousCtx = createCtx();
    expect(await (await app.fetch(new Request(url), previous.env, previousCtx)).text()).toBe(
      'evil',
    );
    await Promise.all(
      (previousCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    );
    expect(edgeCacheStore.size).toBe(1);

    const next = createEnv({
      routing: { workerName: 'new-worker', projectId: 'proj-new', hashedAssetsPrefix: 'assets' },
      workerResponse: new Response('fresh'),
    });
    const res = await app.fetch(new Request(url), next.env, createCtx());
    expect(await res.text()).toBe('fresh');
    expect(next.workerFetch).toHaveBeenCalledOnce();
  });

  it('replaces an unmarked legacy hashed body instead of serving it', async () => {
    edgeCacheStore.set(
      'https://test.void.app/assets/stale.js?_p=proj-1',
      new Response('user-alice', {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      }),
    );

    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('fresh') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/stale.js'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fresh');
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const replacement = edgeCacheStore.get('https://test.void.app/assets/stale.js?_p=proj-1');
    expect(replacement?.headers.get(SHARED_CACHE_POLICY_HEADER)).toBe(
      String(SHARED_CACHE_POLICY_VERSION),
    );
    expect(await replacement?.clone().text()).toBe('fresh');
  });

  it('does not cache non-hashed asset paths without version', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('page') });
    const ctx = createCtx();

    // Request for a non-hashed path
    const res = await app.fetch(new Request('https://test.void.app/about'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Second request — should still hit worker (no caching)
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/about'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('skips cache for non-GET requests to hashed paths', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/assets/main.js', { method: 'POST' }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    // Should not write to cache
    expect(edgeCacheStore.size).toBe(0);
  });

  it('does not cache non-ok worker responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('not found', { status: 404 }),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/missing.js'), env, ctx);
    expect(res.status).toBe(404);
    expect(edgeCacheStore.size).toBe(0);
  });

  it('skips caching when hashedAssetsPrefix is not set', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      // no hashedAssetsPrefix
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/assets/main.js'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Second request — still hits worker (no caching)
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/assets/main.js'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('works with custom prefix like _nuxt', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: '_nuxt',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('nuxt-asset') });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/_nuxt/entry.abc123.js'),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('keys cache on post-rewrite hashed URL when a redirect rule rewrites into the hashed prefix', async () => {
    // Hashed assets are cached `immutable` for a year. The cache key must
    // track the post-rewrite (hash-bearing) URL, not the source URL — a
    // future deploy that maps /logo to a different hash would otherwise
    // keep serving the stale entry under /logo.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      redirectRules: [{ source: '/logo', destination: '/assets/logo-abc123.png', status: 200 }],
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/logo'), env, ctx);
    expect(res.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(edgeCacheStore.has('https://test.void.app/assets/logo-abc123.png?_p=proj-1')).toBe(true);
    expect(edgeCacheStore.has('https://test.void.app/logo?_p=proj-1')).toBe(false);
  });

  it('normalizes query strings for cache key', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    // First request with query string — cache miss, hits worker
    const res1 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js?v=1'),
      env,
      ctx,
    );
    expect(res1.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request with different query string — should still be a cache hit
    const ctx2 = createCtx();
    const res2 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js?v=2'),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // still 1 — cache hit
  });

  it('does not share a hashed-path response that sets a cookie', async () => {
    let render = 0;
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        hashedAssetsPrefix: 'assets',
      },
      workerFetchImpl: async () => {
        render++;
        return new Response(`user-${render}`, {
          headers: { 'Set-Cookie': `sid=user-${render}; Path=/; HttpOnly` },
        });
      },
    });
    const url = 'https://test.void.app/assets/session-abc.json';

    const firstCtx = createCtx();
    const first = await app.fetch(new Request(url), env, firstCtx);
    expect(await first.text()).toBe('user-1');
    expect(first.headers.get('Set-Cookie')).toContain('sid=user-1');
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const second = await app.fetch(new Request(url), env, createCtx());
    expect(await second.text()).toBe('user-2');
    expect(second.headers.get('Set-Cookie')).toContain('sid=user-2');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(edgeCacheStore.has(`${url}?_p=proj-1`)).toBe(false);
  });

  it('keeps credentialed hashed-path responses private without response opt-out headers', async () => {
    let render = 0;
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        hashedAssetsPrefix: 'assets',
      },
      workerFetchImpl: async () => new Response(`user-${++render}`),
    });
    const url = 'https://test.void.app/assets/session-abc.json';

    const firstCtx = createCtx();
    const first = await app.fetch(
      new Request(url, { headers: { Cookie: 'session=alice' } }),
      env,
      firstCtx,
    );
    expect(await first.text()).toBe('user-1');
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const secondCtx = createCtx();
    const second = await app.fetch(
      new Request(url, { headers: { Cookie: 'session=bob' } }),
      env,
      secondCtx,
    );
    expect(await second.text()).toBe('user-2');
    expect(workerFetch.mock.calls[0]?.[0].headers.get('Cookie')).toBe('session=alice');
    expect(workerFetch.mock.calls[1]?.[0].headers.get('Cookie')).toBe('session=bob');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(edgeCacheStore.has(`${url}?_p=proj-1`)).toBe(false);
  });

  it.each([
    ['Authorization', 'Bearer alice'],
    ['Accept', 'text/event-stream'],
  ])('bypasses hashed cache for %s requests', async (header, value) => {
    const url = 'https://test.void.app/assets/session-abc.json';
    const currentEntry = currentSharedCacheResponse(
      new Response('cached-user', {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
      }),
    );
    edgeCacheStore.set(`${url}?_p=proj-1`, currentEntry);
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        hashedAssetsPrefix: 'assets',
      },
      workerResponse: new Response('live-user'),
    });

    const response = await app.fetch(
      new Request(url, { headers: { [header]: value } }),
      env,
      createCtx(),
    );

    expect(await response.text()).toBe('live-user');
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(await edgeCacheStore.get(`${url}?_p=proj-1`)?.clone().text()).toBe('cached-user');
  });

  it('returns 429 when worker exceeds CPU limit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    // Override worker.fetch to throw CPU limit error
    const dispatchGet = env.DISPATCH.get as ReturnType<typeof vi.fn>;
    dispatchGet.mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Worker exceeded CPU time limit')),
    });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/main-abc.js'), env, ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'execution',
      reason: 'cpu',
    });
  });
});

describe('header rules', () => {
  it('applies header rules to worker responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      headerRules: [
        { pattern: '/*', headers: [['X-Frame-Options', 'DENY']] },
        {
          pattern: '/assets/*',
          headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/app.js'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('applies header rules to hashed assets on cache miss and cache hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [{ pattern: '/*', headers: [['X-Custom', 'from-rules']] }],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();

    // First request — cache miss, goes through the hashed asset path
    const res1 = await app.fetch(new Request('https://test.void.app/assets/main-abc.js'), env, ctx);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('X-Custom')).toBe('from-rules');
    // Rules are applied per-serve, not baked into the immutable cache entry, so
    // the immutable Cache-Control survives alongside the custom header.
    expect(res1.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, header rules still apply on the way out
    const ctx2 = createCtx();
    const res2 = await app.fetch(
      new Request('https://test.void.app/assets/main-abc.js'),
      env,
      ctx2,
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-Custom')).toBe('from-rules');
    expect(res2.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('applies COOP/COEP/CORP to a hashed worker asset across a cache hit (cross-origin isolation)', async () => {
    // A cross-origin-isolated app (SharedArrayBuffer / wasm threads) must serve its
    // hashed worker + wasm assets with COEP, or a module worker spawned from the
    // require-corp document is blocked. Browsers fetch those assets over GET, served
    // from the immutable hashed-asset cache — so the rules must reach that path.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/assets/*',
          headers: [
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
            ['Cross-Origin-Resource-Policy', 'same-origin'],
          ],
        },
      ],
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('worker-bytes'),
    });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/worker-D2vJiay4.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(miss.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1); // served from edge cache, not re-fetched
    expect(hit.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(hit.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  });

  it('keeps platform immutable Cache-Control on hashed assets when a rule overrides it', async () => {
    // A broad `/* -> Cache-Control: no-store` rule must NOT disable immutable
    // caching for content-addressed URLs. On the hashed-asset path tenant rules
    // are additive only — the platform-managed Cache-Control is restored after
    // the rules run, while other (non-managed) headers still apply.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/*',
          headers: [
            ['Cache-Control', 'no-store'],
            ['X-Custom', 'from-rules'],
          ],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    // Cache miss — rule tries to clobber Cache-Control, platform value wins.
    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(miss.headers.get('X-Custom')).toBe('from-rules'); // additive header survives

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Cache hit — same protection on the way out of the edge cache.
    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(hit.headers.get('X-Custom')).toBe('from-rules');
  });

  it('does not let a rule forge Content-Length on hashed assets (metering integrity)', async () => {
    // meter() bills from Content-Length and clients frame the body by it; a rule
    // must not be able to set it to 0 on a hashed asset and skew usage accounting
    // or truncate the response. The real asset length is restored after rules.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [{ pattern: '/*', headers: [['Content-Length', '0']] }],
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('asset-body', { headers: { 'Content-Length': '10' } }),
    });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const res = await app.fetch(new Request(url), env, ctx);
    expect(res.status).toBe(200);
    // The forged 0 is discarded; the real asset length is preserved and the body
    // is served intact.
    expect(res.headers.get('Content-Length')).not.toBe('0');
    expect(await res.text()).toBe('asset-body');
  });

  it('keeps platform representation headers on hashed assets when a rule overrides them', async () => {
    // A tenant rule must not rewrite how a content-addressed asset is represented:
    // a forged Content-Encoding makes the browser mis-decode the bytes and a wrong
    // Content-Type breaks ES-module / WebAssembly loading. These are restored after
    // rules run, while additive headers (COEP) still apply.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/*',
          headers: [
            ['Content-Type', 'text/plain'],
            ['Content-Encoding', 'gzip'],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
          ],
        },
      ],
    };
    const { env } = createEnv({
      routing,
      // Origin serves real, uncompressed JS — no Content-Encoding.
      workerResponse: new Response('asset-body', {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      }),
    });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    // Platform/origin representation preserved...
    expect(miss.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(miss.headers.get('Content-Encoding')).toBeNull(); // no false `gzip` claim
    // ...while the additive isolation header still applies.
    expect(miss.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Cache hit — same protection on the way out of the edge cache.
    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(hit.headers.get('Content-Encoding')).toBeNull();
    expect(hit.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  it('strips the Clear-Site-Data cookies directive on hashed assets (cross-tenant cookie boundary)', async () => {
    // On the shared *.void.app domain a Clear-Site-Data: "cookies" response would
    // wipe cookies for the whole registrable domain, across tenants. The cookies
    // directive is stripped at the header-rule layer, so it must never reach a
    // served hashed asset — on miss or hit — while additive headers (COEP) still apply.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      hashedAssetsPrefix: 'assets',
      headerRules: [
        {
          pattern: '/assets/*',
          headers: [
            ['Clear-Site-Data', '"cookies"'],
            ['Cross-Origin-Embedder-Policy', 'require-corp'],
          ],
        },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('asset-body') });
    const ctx = createCtx();
    const url = 'https://test.void.app/assets/main-abc.js';

    const miss = await app.fetch(new Request(url), env, ctx);
    expect(miss.status).toBe(200);
    expect(miss.headers.get('Clear-Site-Data')).toBeNull();
    expect(miss.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    const hit = await app.fetch(new Request(url), env, ctx2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Clear-Site-Data')).toBeNull();
    expect(hit.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });

  it('last-match-wins for overlapping patterns', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      headerRules: [
        { pattern: '/*', headers: [['Cache-Control', 'no-cache']] },
        { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
      ],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/assets/app.js'), env, ctx);
    expect(res.headers.get('Cache-Control')).toBe('immutable');
  });
});

describe('queue relay', () => {
  type MockMessage = {
    id: string;
    timestamp: Date;
    body: unknown;
    attempts: number;
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };

  function createMockBatch(
    queue: string,
    messages: Array<{ id: string; body: unknown; attempts?: number }>,
  ) {
    const msgs: Array<MockMessage> = messages.map((m) => ({
      id: m.id,
      timestamp: new Date('2026-01-15T12:00:00Z'),
      body: m.body,
      attempts: m.attempts ?? 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    return {
      queue,
      messages: msgs,
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch & {
      ackAll: ReturnType<typeof vi.fn>;
      retryAll: ReturnType<typeof vi.fn>;
      messages: Array<MockMessage>;
    };
  }

  function createQueueEnv(options: {
    routingRaw?: string | null;
    workerResponse?: Response;
    workerFetchImpl?: () => Promise<Response>;
    installationId?: string;
    trafficState?: string;
    lifecycleValue?: string | null;
    lifecycleError?: Error;
    suspendedProjects?: Array<string>;
    markerError?: Error;
  }) {
    const workerFetch = vi.fn(
      async (_req: Request) =>
        options.workerFetchImpl?.() ?? options.workerResponse ?? new Response('ok'),
    );
    const routingGet = vi.fn(async (key: string) => {
      if (key === PLATFORM_DISABLED_KEY) {
        if (options.lifecycleError) {
          throw options.lifecycleError;
        }
        return options.lifecycleValue ?? null;
      }
      if (key.startsWith('project-suspended:')) {
        if (options.markerError) {
          throw options.markerError;
        }
        const projectId = key.slice('project-suspended:'.length);
        return options.suspendedProjects?.includes(projectId) ? 'operator_review' : null;
      }
      return options.routingRaw ?? null;
    });
    const dispatchGet = vi.fn(() => ({ fetch: workerFetch }));
    return {
      env: {
        ROUTING: { get: routingGet },
        DISPATCH: { get: dispatchGet },
        ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
        ANALYTICS: { writeDataPoint: () => {} },
        ...(options.installationId ? { PLATFORM_INSTALLATION_ID: options.installationId } : {}),
        ...(options.trafficState ? { PLATFORM_TRAFFIC_STATE: options.trafficState } : {}),
      } as unknown as Env,
      dispatchGet,
      routingGet,
      workerFetch,
    };
  }

  it('retries without routing to an app while a self-hosted platform is disabled', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, dispatchGet, routingGet } = createQueueEnv({
      routingRaw: routing,
      installationId: 'installation-id',
      lifecycleValue: 'disabled',
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await app.queue(batch, env);

      expect(routingGet).toHaveBeenCalledOnce();
      expect(routingGet).toHaveBeenCalledWith(PLATFORM_DISABLED_KEY);
      expect(dispatchGet).not.toHaveBeenCalled();
      expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(batch.ackAll).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['staging', 'sandbox-drain'])(
    'retries %s batches without reading unavailable routing KV',
    async (trafficState) => {
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env, dispatchGet, routingGet } = createQueueEnv({
        installationId: 'installation-id',
        trafficState,
      });
      routingGet.mockRejectedValue(new Error('routing unavailable'));
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await app.queue(batch, env);

        expect(routingGet).not.toHaveBeenCalled();
        expect(dispatchGet).not.toHaveBeenCalled();
        expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
      } finally {
        warning.mockRestore();
      }
    },
  );

  it('relays batches after the self-hosted traffic gate is enabled', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, routingGet, workerFetch } = createQueueEnv({
      routingRaw: routing,
      installationId: 'installation-id',
      lifecycleValue: null,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(routingGet).toHaveBeenNthCalledWith(1, PLATFORM_DISABLED_KEY);
    expect(routingGet).toHaveBeenNthCalledWith(2, 'queue:test-queue', { cacheTtl: 60 });
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('keeps hosted queue relay free of self-hosted lifecycle reads', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, routingGet, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(routingGet).toHaveBeenCalledOnce();
    expect(routingGet).toHaveBeenCalledWith('queue:test-queue', { cacheTtl: 60 });
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('fails closed when the self-hosted traffic gate cannot be read', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, dispatchGet, routingGet } = createQueueEnv({
      routingRaw: routing,
      installationId: 'installation-id',
      lifecycleError: new Error('routing unavailable'),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.queue(batch, env);

      expect(routingGet).toHaveBeenCalledOnce();
      expect(routingGet).toHaveBeenCalledWith(PLATFORM_DISABLED_KEY);
      expect(dispatchGet).not.toHaveBeenCalled();
      expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('traffic gate read failed'));
    } finally {
      error.mockRestore();
    }
  });

  it('retries all when routing entry is missing', async () => {
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({ routingRaw: null });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it("holds a suspended project's batch without invoking its worker", async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'p1',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, dispatchGet } = createQueueEnv({
      routingRaw: routing,
      suspendedProjects: ['p1'],
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await app.queue(batch, env);
    } finally {
      warning.mockRestore();
    }

    expect(dispatchGet).not.toHaveBeenCalled();
    expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it('relays batches of projects without a suspension marker', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'p2',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, routingGet, workerFetch } = createQueueEnv({
      routingRaw: routing,
      suspendedProjects: ['p1'],
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(routingGet).toHaveBeenCalledWith('project-suspended:p2', { cacheTtl: 60 });
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('relays when the suspension marker cannot be read', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'p3',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      markerError: new Error('routing unavailable'),
      workerResponse: Response.json({ ok: true }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.queue(batch, env);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('suspension check failed'),
        expect.any(Error),
      );
    } finally {
      error.mockRestore();
    }

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('acks all on legacy protocol (ok: true, no decisions)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(batch.ackAll).toHaveBeenCalledOnce();
    expect(batch.retryAll).not.toHaveBeenCalled();
  });

  it('retries all on legacy protocol (ok: false)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: false }),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
    expect(batch.ackAll).not.toHaveBeenCalled();
  });

  it('applies per-message decisions correctly', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [
      { id: 'm1', body: 'ack-me' },
      { id: 'm2', body: 'retry-me' },
      { id: 'm3', body: 'no-decision' },
    ]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: true,
        decisions: {
          m1: { action: 'ack' },
          m2: { action: 'retry' },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.messages[1].retry).toHaveBeenCalledWith(undefined);
    expect(batch.messages[2].ack).not.toHaveBeenCalled();
    expect(batch.messages[2].retry).not.toHaveBeenCalled();
  });

  it('passes delaySeconds through on retry decisions', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'retry-me' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: true,
        decisions: {
          m1: { action: 'retry', delaySeconds: 30 },
        },
      }),
    });

    await app.queue(batch, env);

    expect(batch.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('retries all undecided messages when handler fails (ok: false)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [
      { id: 'm1', body: 'acked' },
      { id: 'm2', body: 'undecided' },
    ]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({
        ok: false,
        decisions: {
          m1: { action: 'ack' },
        },
      }),
    });

    await app.queue(batch, env);

    // Individual ack decision applied
    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    // retryAll called for undecided messages (CF preserves individual decisions)
    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('retries all on network error', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerFetchImpl: () => Promise.reject(new Error('network error')),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('retries all on non-ok HTTP response', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: new Response('Internal Server Error', { status: 500 }),
    });

    await app.queue(batch, env);

    expect(batch.retryAll).toHaveBeenCalledOnce();
  });

  it('acks all on non-JSON 2xx response (legacy framework)', async () => {
    const routing = JSON.stringify({ workerName: 'user-app', queueName: 'emails' });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env } = createQueueEnv({
      routingRaw: routing,
      workerResponse: new Response('OK', { status: 200 }),
    });

    await app.queue(batch, env);

    expect(batch.ackAll).toHaveBeenCalledOnce();
  });

  it('forwards x-void-internal header to user worker when proxyToken is in routing entry', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
      proxyToken: 'super-secret-token',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    expect(workerFetch).toHaveBeenCalledOnce();
    const req = workerFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('x-void-internal')).toBe('super-secret-token');
  });

  it('omits x-void-internal header when proxyToken is missing (backward-compat)', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: routing,
      workerResponse: Response.json({ ok: true }),
    });

    await app.queue(batch, env);

    const req = workerFetch.mock.calls[0][0] as Request;
    expect(req.headers.get('x-void-internal')).toBeNull();
  });

  it('logs a structured error when the user worker returns non-2xx', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({
        routingRaw: routing,
        workerResponse: new Response('unauthorized', { status: 401 }),
      });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/queue.*emails/i);
      expect(logged).toMatch(/user-app/);
      expect(logged).toMatch(/401/);
      expect(logged).toMatch(/unauthorized/);
      expect(batch.retryAll).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs a structured error when the relay fetch throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({
        routingRaw: routing,
        workerFetchImpl: () => Promise.reject(new Error('connection reset')),
      });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/emails/);
      expect(logged).toMatch(/user-app/);
      expect(logged).toMatch(/connection reset/);
      expect(batch.retryAll).toHaveBeenCalledOnce();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('logs a structured error when the routing entry is missing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const batch = createMockBatch('orphan-queue', [{ id: 'm1', body: 'hello' }]);
      const { env } = createQueueEnv({ routingRaw: null });

      await app.queue(batch, env);

      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/orphan-queue/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it.each([401, 403])(
    'relays once and retries the batch later when the Worker rejects the token with %i',
    async (status) => {
      const routing = JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      });
      const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
      const { env, workerFetch } = createQueueEnv({ routingRaw: routing });
      workerFetch.mockImplementation(async () =>
        Response.json({ error: 'unauthorized' }, { status }),
      );
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await app.queue(batch, env);
      } finally {
        errSpy.mockRestore();
      }

      expect(workerFetch).toHaveBeenCalledOnce();
      expect(batch.retryAll).toHaveBeenCalledOnce();
      expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(batch.ackAll).not.toHaveBeenCalled();
    },
  );

  it('retries other relay failures without a delay', async () => {
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const { env, workerFetch } = createQueueEnv({
      routingRaw: JSON.stringify({
        workerName: 'user-app',
        projectId: 'proj-1',
        queueName: 'emails',
        proxyToken: 'tok',
      }),
      workerResponse: new Response('boom', { status: 500 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await app.queue(batch, env);
    } finally {
      errSpy.mockRestore();
    }

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(batch.retryAll).toHaveBeenCalledWith();
  });

  it('forwards x-void-internal on legacy /__queue fallback too', async () => {
    const routing = JSON.stringify({
      workerName: 'user-app',
      projectId: 'proj-1',
      queueName: 'emails',
      proxyToken: 'legacy-token',
    });
    const batch = createMockBatch('test-queue', [{ id: 'm1', body: 'hello' }]);
    const calls: Array<{ path: string; header: string | null }> = [];
    const workerFetch = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      calls.push({ path: url.pathname, header: req.headers.get('x-void-internal') });
      if (url.pathname === '/__void/queue') {
        return new Response('not found', { status: 404 });
      }
      return Response.json({ ok: true });
    });
    const env = {
      ROUTING: {
        get: async (key: string) => (key.startsWith('project-suspended:') ? null : routing),
      },
      DISPATCH: { get: () => ({ fetch: workerFetch }) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    await app.queue(batch, env);

    expect(calls).toEqual([
      { path: '/__void/queue', header: 'legacy-token' },
      { path: '/__queue', header: 'legacy-token' },
    ]);
  });
});

describe('redirect rules', () => {
  it('applies redirect rules before invoking worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
    });

    const response = await app.fetch(new Request('https://test.void.app/old'), env, createCtx());

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/new');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('does not redirect non-matching paths', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/other'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('redirects with :splat substitution', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/blog/*', destination: '/posts/:splat', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/hello-world'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/posts/hello-world');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('redirects with named :slug captures', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/blog/:slug', destination: '/articles/:slug', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/hello'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/articles/hello');
  });

  it('preserves the request query string in the Location header', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/old?utm_source=email&id=42'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/new?utm_source=email&id=42');
  });

  it('destination query takes precedence over request query on conflict', async () => {
    const { env } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new?ref=internal', status: 302 }],
      },
    });

    const response = await app.fetch(
      new Request('https://test.void.app/old?ref=external&utm=x'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/new?ref=internal&utm=x');
  });
});

describe('rewrite rules', () => {
  it('rewrites path and forwards to worker', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('rewritten content'),
    });

    const response = await app.fetch(new Request('https://test.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten content');
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs');
  });

  it('rewrites with :splat substitution', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs/getting-started'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs/getting-started');
  });

  it('rewrites with named :author/:slug captures', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          { source: '/blog/:author/:slug', destination: '/posts/:author/:slug', status: 200 },
        ],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/blog/jane/first-post'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/posts/jane/first-post');
  });

  it('sets X-Void-Original-URL header on rewritten requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe('https://test.void.app/docs');
  });

  it('preserves query string on rewritten requests', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs?lang=en'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    const forwardedUrl = new URL(forwarded.url);
    expect(forwardedUrl.pathname).toBe('/en/docs');
    expect(forwardedUrl.search).toBe('?lang=en');
  });

  it('does not rewrite non-matching paths', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://test.void.app/other'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/other');
    expect(forwarded.headers.has('X-Void-Original-URL')).toBe(false);
  });

  // Host-scoped redirects: dispatch passes `url.hostname` into
  // `applyRoutingRules`. Confirm the wiring through the full handler so a
  // future refactor that loses the hostname argument is caught here. The
  // fixture's ROUTING binding returns the same routing entry for every
  // hostname, so the only thing distinguishing the two requests below is
  // `url.hostname`.
  it('host-scoped redirect fires when request host matches rule.host', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          {
            source: '/*',
            destination: 'https://foo.com/:splat',
            status: 301,
            host: 'www.foo.com',
          },
        ],
      },
    });

    const response = await app.fetch(new Request('https://www.foo.com/about'), env, createCtx());

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://foo.com/about');
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it('host-scoped redirect skipped when request host differs from rule.host', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          {
            source: '/*',
            destination: 'https://foo.com/:splat',
            status: 301,
            host: 'www.foo.com',
          },
        ],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(new Request('https://foo.com/about'), env, createCtx());

    expect(response.status).toBe(200);
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('rewrite wins over redirect when it is the first match', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [
          { source: '/page', destination: '/en/page', status: 200 },
          { source: '/page', destination: '/other', status: 302 },
        ],
      },
      workerResponse: new Response('rewritten'),
    });

    const response = await app.fetch(new Request('https://test.void.app/page'), env, createCtx());

    expect(response.status).toBe(200);
    expect(response.headers.has('Location')).toBe(false);
    expect(workerFetch).toHaveBeenCalledOnce();

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/page');
  });

  // ISR miss must render against the rewritten URL, otherwise content for /docs
  // gets cached under the /en/docs key.
  it('dispatches ISR miss to worker with rewritten URL', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('<html>rewritten</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(new Request('https://my-app.void.app/docs'), env, createCtx());

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs');
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe('https://my-app.void.app/docs');
  });

  // Dispatch owns X-Void-Original-URL. A client-supplied value on a request
  // with no matching rewrite must not leak through to the user worker —
  // otherwise a non-Void worker that trusts the header could be spoofed.
  it('strips client-supplied X-Void-Original-URL when no rewrite fires', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/plain', {
        headers: { 'X-Void-Original-URL': 'https://evil/attacker' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.has('X-Void-Original-URL')).toBe(false);
  });

  // On a rewrite, dispatch must overwrite any client value with the true
  // original URL, not concatenate or pass the spoofed value through.
  it('overrides client-supplied X-Void-Original-URL with the true original URL on rewrite', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/docs', destination: '/en/docs', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://test.void.app/docs', {
        headers: { 'X-Void-Original-URL': 'https://evil/attacker' },
      }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe('https://test.void.app/docs');
  });

  // Pin the full original URL (including query) on the X-Void-Original-URL
  // header after a 200-status redirectRule rewrite — not just its presence.
  it('sets X-Void-Original-URL to the full original URL (with query) on redirectRules rewrite', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/old', destination: '/new', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const originalUrl = 'https://test.void.app/old?ref=email';
    const response = await app.fetch(new Request(originalUrl), env, createCtx());

    expect(response.status).toBe(200);
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/new');
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe(originalUrl);
  });

  // When the inbound body is already consumed (e.g. middleware upstream of
  // dispatch drained it), the rewrite-request builder must: avoid throwing
  // in the Request ctor; forward no body; strip content-length and
  // transfer-encoding so the downstream worker doesn't see stale framing;
  // and still set X-Void-Original-URL on the rewritten URL.
  it('forwards a body-less rewrite request with X-Void-Original-URL when POST body is consumed', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'test-worker',
        projectId: 'proj-1',
        redirectRules: [{ source: '/submit', destination: '/en/submit', status: 200 }],
      },
      workerResponse: new Response('ok'),
    });

    const originalUrl = 'https://test.void.app/submit';
    const inbound = new Request(originalUrl, { method: 'POST', body: 'payload' });
    await inbound.text(); // disturb the stream — bodyUsed becomes true
    expect(inbound.bodyUsed).toBe(true);

    const response = await app.fetch(inbound, env, createCtx());
    expect(response.status).toBe(200);

    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(forwarded.method).toBe('POST');
    expect(forwarded.body).toBeNull();
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(forwarded.headers.has('transfer-encoding')).toBe(false);
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe(originalUrl);
    expect(new URL(forwarded.url).pathname).toBe('/en/submit');
  });

  // The `createEnv` helper returns the same routing entry for any KV key, which
  // hides the `slug ?? domain:${hostname}` branch in dispatch. This test builds
  // ROUTING manually so the rewrite path is exercised against a custom-domain
  // routing entry (the `domain:` KV key path) rather than a slug lookup.
  it('applies rewrite rules on a custom-domain request (domain: KV key path)', async () => {
    const workerFetch = vi.fn(async (_req: Request) => new Response('rewritten'));
    const routingLookups: Array<string> = [];
    const routing: RoutingEntry = {
      workerName: 'user-app',
      projectId: 'proj_custom',
      redirectRules: [{ source: '/docs/*', destination: '/en/docs/:splat', status: 200 }],
    };

    const env = {
      ROUTING: {
        get: async (key: string) => {
          routingLookups.push(key);
          if (key === 'domain:app.example.com') {
            return JSON.stringify(routing);
          }
          return null;
        },
      },
      DISPATCH: { get: () => ({ fetch: workerFetch }) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;

    const originalUrl = 'https://app.example.com/docs/intro';
    const response = await app.fetch(new Request(originalUrl), env, createCtx());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('rewritten');

    // Routing entry was looked up under the `domain:` key, not a slug.
    expect(routingLookups).toContain('domain:app.example.com');
    expect(routingLookups.every((k) => !k.startsWith('app'))).toBe(true);

    // Rewrite applied correctly; original URL handed off to the worker.
    expect(workerFetch).toHaveBeenCalledOnce();
    const forwarded = workerFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe('/en/docs/intro');
    expect(forwarded.headers.get('X-Void-Original-URL')).toBe(originalUrl);
  });
});

describe('static asset caching', () => {
  it('never shares a dotted declared page between authenticated sessions', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      pages: [{ pattern: '/members/:name', revalidate: 60 }],
    };
    const { env, workerFetch, kvStore } = createEnv({
      routing,
      workerFetchImpl: async () => {
        const session = workerFetch.mock.calls.at(-1)?.[0].headers.get('cookie');
        return new Response(`<html>${session}</html>`, {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    });

    const firstCtx = createCtx();
    const first = await app.fetch(
      new Request('https://test.void.app/members/alice.smith', {
        headers: { Cookie: 'session=alice' },
      }),
      env,
      firstCtx,
    );
    await Promise.all(
      (firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
    );

    const secondCtx = createCtx();
    const second = await app.fetch(
      new Request('https://test.void.app/members/alice.smith', {
        headers: { Cookie: 'session=bob' },
      }),
      env,
      secondCtx,
    );
    await Promise.all(
      (secondCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
    );

    expect(await first.text()).toBe('<html>session=alice</html>');
    expect(await second.text()).toBe('<html>session=bob</html>');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect([...edgeCacheStore.keys()].some((key) => key.includes('?_v='))).toBe(false);
    expect([...kvStore.keys()].some((key) => key.includes('/members/alice.smith'))).toBe(false);
  });

  it('ignores a pre-existing dotted static-cache entry for an authorized request', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      pages: [{ pattern: '/members/:name', revalidate: 60 }],
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('<html>bob</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });
    edgeCacheStore.set(
      'https://test.void.app/members/alice.smith?_v=deploy-1',
      new Response('<html>alice</html>', {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'public, s-maxage=31536000',
        },
      }),
    );

    const response = await app.fetch(
      new Request('https://test.void.app/members/alice.smith', {
        headers: { Authorization: 'Bearer bob' },
      }),
      env,
      createCtx(),
    );

    expect(await response.text()).toBe('<html>bob</html>');
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('does not treat a validator-bearing revalidate-0 dotted page as a static asset', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      pages: [{ pattern: '/members/:name', revalidate: 0 }],
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerFetchImpl: async () => {
        const request = workerFetch.mock.calls.at(-1)?.[0];
        return new Response(`<html>${new URL(request.url).searchParams.get('viewer')}</html>`, {
          headers: { 'Content-Type': 'text/html', ETag: '"member-page"' },
        });
      },
    });

    const firstCtx = createCtx();
    expect(
      await (
        await app.fetch(
          new Request('https://test.void.app/members/alice.smith?viewer=alice'),
          env,
          firstCtx,
        )
      ).text(),
    ).toBe('<html>alice</html>');
    await Promise.all(
      (firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
    );

    expect(
      await (
        await app.fetch(
          new Request('https://test.void.app/members/alice.smith?viewer=bob'),
          env,
          createCtx(),
        )
      ).text(),
    ).toBe('<html>bob</html>');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect([...edgeCacheStore.keys()].some((key) => key.includes('?_v='))).toBe(false);
  });

  it('caches static asset on first request, serves from cache on second', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    // First request — cache miss, hits worker
    const res1 = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe('favicon');
    expect(workerFetch).toHaveBeenCalledTimes(1);

    // Wait for background cache.put
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Second request — cache hit, worker NOT invoked
    const ctx2 = createCtx();
    const res2 = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx2);
    expect(res2.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps Set-Cookie responses out of the deploy-versioned static cache', async () => {
    let render = 0;
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'test-worker', projectId: 'proj-1', version: 'deploy-1' },
      workerFetchImpl: async () => {
        render++;
        return new Response(`user-${render}`, {
          headers: { 'Set-Cookie': `sid=user-${render}; Path=/; HttpOnly` },
        });
      },
    });

    const firstCtx = createCtx();
    const first = await app.fetch(new Request('https://test.void.app/profile.json'), env, firstCtx);
    expect(await first.text()).toBe('user-1');
    expect(first.headers.get('Set-Cookie')).toContain('sid=user-1');
    await Promise.all((firstCtx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const second = await app.fetch(
      new Request('https://test.void.app/profile.json'),
      env,
      createCtx(),
    );
    expect(await second.text()).toBe('user-2');
    expect(second.headers.get('Set-Cookie')).toContain('sid=user-2');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(edgeCacheStore.has('https://test.void.app/profile.json?_v=deploy-1')).toBe(false);
  });

  it('replaces an unmarked legacy static body instead of serving it', async () => {
    const cacheKey = 'https://test.void.app/profile.json?_v=deploy-1';
    edgeCacheStore.set(
      cacheKey,
      new Response('user-alice', {
        headers: {
          'Cache-Control': 'public, s-maxage=31536000',
        },
      }),
    );
    const { env, workerFetch } = createEnv({
      routing: { workerName: 'test-worker', projectId: 'proj-1', version: 'deploy-1' },
      workerResponse: new Response('user-bob'),
    });
    const ctx = createCtx();

    const response = await app.fetch(new Request('https://test.void.app/profile.json'), env, ctx);
    expect(await response.text()).toBe('user-bob');
    expect(workerFetch).toHaveBeenCalledOnce();
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const replacement = edgeCacheStore.get(cacheKey);
    expect(replacement).toBeDefined();
    expect(replacement!.headers.get(SHARED_CACHE_POLICY_HEADER)).toBe(
      String(SHARED_CACHE_POLICY_VERSION),
    );
    expect(await replacement!.clone().text()).toBe('user-bob');

    const cachedResponse = await app.fetch(
      new Request('https://test.void.app/profile.json'),
      env,
      createCtx(),
    );
    expect(await cachedResponse.text()).toBe('user-bob');
    expect(cachedResponse.headers.get(SHARED_CACHE_POLICY_HEADER)).toBeNull();
    expect(workerFetch).toHaveBeenCalledOnce();
  });

  it('client response omits s-maxage on static cache miss', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('client response omits s-maxage on static cache hit', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('static edge cache entry retains s-maxage for TTL', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({ routing, workerResponse: new Response('favicon') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/favicon.ico?_v=deploy-1');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('does not write a 206 (Range) worker response to the static edge cache', async () => {
    // A Range GET on a dotted SSR path bails out of the ISR ladder (Range excluded)
    // and falls through to the static-candidate write. The origin emits a `206
    // Partial Content`; the write gate (`status === 200`, not `.ok` which is
    // 200–299) must refuse it — a partial body persisted under the shared
    // `<path>?_v=<version>` key would later be served whole to a full request.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('partial-bytes', {
        status: 206,
        headers: { 'Content-Type': 'application/xml', 'Content-Range': 'bytes 0-11/100' },
      }),
    });
    const ctx = createCtx();

    const res = await app.fetch(
      new Request('https://test.void.app/feed.xml', { headers: { Range: 'bytes=0-11' } }),
      env,
      ctx,
    );
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // The 206 flows through to the client untouched — live render, not cached.
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('partial-bytes');
    // Never persisted under the 1-year `?_v=<version>` static edge key.
    expect(edgeCacheStore.get('https://test.void.app/feed.xml?_v=deploy-1')).toBeUndefined();
    expect([...edgeCacheStore.keys()].some((k) => k.includes('?_v='))).toBe(false);
  });

  it('still writes a manifest-backed 200 asset response to the static edge cache', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      assetManifestId: 'deploy-1',
    };
    const { env } = createEnv({
      routing,
      assetManifest: { '/feed.xml': 'feed-hash' },
      workerResponse: new Response('<rss>feed</rss>', {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      }),
    });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/feed.xml'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/feed.xml?_v=deploy-1');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('invalidates cache on version change', async () => {
    const routing1: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env: env1, workerFetch: wf1 } = createEnv({
      routing: routing1,
      workerResponse: new Response('v1'),
    });
    const ctx1 = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env1, ctx1);
    expect(wf1).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // New deploy with different version
    const routing2: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-2',
    };
    const { env: env2, workerFetch: wf2 } = createEnv({
      routing: routing2,
      workerResponse: new Response('v2'),
    });
    const ctx2 = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env2, ctx2);
    expect(res.status).toBe(200);
    expect(wf2).toHaveBeenCalledTimes(1); // cache miss — different version
  });

  it('does not cache /api/ routes', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('api') });

    await app.fetch(new Request('https://test.void.app/api/data'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/api/data'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2); // no caching
  });

  it('does not cache SSR paths without extension', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ssr page') });

    await app.fetch(new Request('https://test.void.app/about'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/about'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2); // no caching for SSR routes
  });

  it('caches manifest-backed non-hashed asset paths in SSR projects', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      ssr: true,
      assetManifestId: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      assetManifest: { '/favicon.ico': 'favicon-hash' },
      workerResponse: new Response('icon'),
    });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1); // cache hit
  });

  it('does not cache when version is absent', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      // no version
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });

    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/favicon.ico'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache non-OK responses', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env } = createEnv({
      routing,
      workerResponse: new Response('not found', { status: 404 }),
    });

    await app.fetch(new Request('https://test.void.app/missing.png'), env, createCtx());
    expect(edgeCacheStore.size).toBe(0);
  });

  it.each(['Accept-Language', '*', 'X-VoidPages, Origin'])(
    'does not share ISR responses with unsupported Vary: %s',
    async (vary) => {
      let renderedLanguage = 'en';
      const { env, workerFetch, kvStore } = createEnv({
        routing: {
          workerName: 'test-worker',
          projectId: 'proj-1',
          ssr: true,
          revalidate: 60,
          version: 'deploy-1',
        },
        workerFetchImpl: async () =>
          new Response(renderedLanguage, {
            headers: { 'Content-Type': 'text/html', Vary: vary },
          }),
      });
      for (const language of ['en', 'ja']) {
        renderedLanguage = language;
        const ctx = createCtx();
        const response = await app.fetch(
          new Request('https://test.void.app/', { headers: { 'Accept-Language': language } }),
          env,
          ctx,
        );
        expect(await response.text()).toBe(language);
        await Promise.all(
          (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]),
        );
        expect([...kvStore.keys()].filter((key) => key.includes('/isr/'))).toEqual([]);
        expect(edgeCacheStore.size).toBe(0);
      }
      expect(workerFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('does not cache when worker sets Cache-Control: private', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('dynamic', {
        headers: { 'Cache-Control': 'private, max-age=0' },
      }),
    });

    await app.fetch(new Request('https://test.void.app/avatar.jpg'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/avatar.jpg'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2); // not cached
  });

  it('does not cache when worker sets Cache-Control: no-store', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({
      routing,
      workerResponse: new Response('dynamic', {
        headers: { 'Cache-Control': 'no-store' },
      }),
    });

    await app.fetch(new Request('https://test.void.app/data.json'), env, createCtx());
    await app.fetch(new Request('https://test.void.app/data.json'), env, createCtx());
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('normalizes query strings (same path, different query → same cache key)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });
    const ctx = createCtx();

    await app.fetch(new Request('https://test.void.app/logo.png?width=100'), env, ctx);
    expect(workerFetch).toHaveBeenCalledTimes(1);

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Different query string — should still be cache hit (query normalized to ?_v=deploy-1)
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?width=200'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('keys per-variant when the path has a queryAllowlist (dynamic extensioned route)', async () => {
    // A worker-rendered image whose body depends on the query (e.g. a badge).
    // With an allowlist, distinct allowlisted values must NOT collapse into one
    // static-edge slot — otherwise the first render is served for every query.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      queryAllowlist: { '/badge.png': ['theme'] },
    };
    // A fresh Response per worker call — this route renders more than once, so a
    // single shared Response body would be consumed by the first cache write.
    const { env, workerFetch } = createEnv({
      routing,
      workerFetchImpl: () => Promise.resolve(new Response('img')),
    });

    const ctx1 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=light'), env, ctx1);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Different allowlisted value → distinct key → the worker renders again.
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=dark'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(2);
    await Promise.all((ctx2.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // The first variant is still cached (not clobbered) — re-request light → HIT.
    const ctx3 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=light'), env, ctx3);
    expect(workerFetch).toHaveBeenCalledTimes(2);

    // Two distinct edge entries, each carrying its allowlisted param + `_v`.
    const keys = [...edgeCacheStore.keys()];
    expect(keys.some((k) => k.includes('theme=light') && k.includes('_v=deploy-1'))).toBe(true);
    expect(keys.some((k) => k.includes('theme=dark') && k.includes('_v=deploy-1'))).toBe(true);
  });

  it('drops non-allowlisted params from the key (still collapses on those)', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      queryAllowlist: { '/badge.png': ['theme'] },
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });

    const ctx1 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=light&utm=a'), env, ctx1);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Same allowlisted value, different NON-allowlisted param → same key → HIT.
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/badge.png?theme=light&utm=b'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a wildcard allowlist entry so static candidates cannot fan out', async () => {
    // A broad `*` allowlist stays ISR-only (bounded there by the variant cap). The
    // uncapped static-candidate cache must NOT honor it — otherwise a cache-buster
    // `?theme=<random>` would fan out true static assets. Only an exact path opts in.
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      queryAllowlist: { '*': ['theme'] },
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('img') });

    const ctx1 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?theme=light'), env, ctx1);
    expect(workerFetch).toHaveBeenCalledTimes(1);
    await Promise.all((ctx1.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Different value under the `*` allowlist → still one collapsed slot → HIT.
    const ctx2 = createCtx();
    await app.fetch(new Request('https://test.void.app/logo.png?theme=dark'), env, ctx2);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('skips cache for non-GET requests', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
    };
    const { env, workerFetch } = createEnv({ routing, workerResponse: new Response('ok') });

    await app.fetch(
      new Request('https://test.void.app/form.html', { method: 'POST' }),
      env,
      createCtx(),
    );
    await app.fetch(
      new Request('https://test.void.app/form.html', { method: 'POST' }),
      env,
      createCtx(),
    );
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('applies header rules to cached static assets', async () => {
    const routing: RoutingEntry = {
      workerName: 'test-worker',
      projectId: 'proj-1',
      version: 'deploy-1',
      headerRules: [{ pattern: '/*', headers: [['X-Custom', 'from-rules']] }],
    };
    const { env } = createEnv({ routing, workerResponse: new Response('ok') });
    const ctx = createCtx();

    const res = await app.fetch(new Request('https://test.void.app/favicon.ico'), env, ctx);
    expect(res.headers.get('X-Custom')).toBe('from-rules');
  });
});

describe('static deployment caching (KV/R2)', () => {
  function createStaticDeployEnv(options: {
    routing: RoutingEntry;
    manifest: Record<string, string>;
    assets: Record<string, { body: string; contentType?: string }>;
    r2Get?: (key: string) => Promise<R2ObjectBody | null>;
  }): {
    env: Env;
    usageSend: ReturnType<typeof vi.fn>;
  } {
    const usageSend = vi.fn(async () => {});
    const env = {
      ROUTING: {
        get: async (key: string) => {
          if (key.startsWith('manifest:')) {
            return JSON.stringify(options.manifest);
          }
          return JSON.stringify(options.routing);
        },
      },
      DISPATCH: { get: vi.fn(() => ({ fetch: vi.fn() })) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      STATIC_ASSETS: {
        getWithMetadata: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.assets[hash];
          if (!asset) {
            return { value: null, metadata: null };
          }
          return {
            value: new TextEncoder().encode(asset.body).buffer,
            metadata: { ct: asset.contentType ?? 'text/html' },
          };
        },
      },
      STATIC_ASSETS_R2: { get: options.r2Get ?? (async () => null) },
      ANALYTICS: { writeDataPoint: () => {} },
      USAGE_QUEUE: { send: usageSend },
    } as unknown as Env;

    return { env, usageSend };
  }

  it('client response omits s-maxage for static deployment', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
      },
      manifest: { '/index.html': 'hash1' },
      assets: { hash1: { body: '<html>hello</html>', contentType: 'text/html' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/'), env, createCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
  });

  it('edge cache entry retains s-maxage for static deployment', async () => {
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
      },
      manifest: { '/index.html': 'hash1' },
      assets: { hash1: { body: '<html>hello</html>', contentType: 'text/html' } },
    });

    const ctx = createCtx();
    await app.fetch(new Request('https://test.void.app/'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    const cacheEntry = edgeCacheStore.get('https://test.void.app/?_v=deploy-abc');
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.headers.get('Cache-Control')).toBe(
      'public, s-maxage=31536000, max-age=0, must-revalidate',
    );
  });

  it('hedges a stalled R2 read and serves the retry within the original deadline', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let resolveSlow!: (value: R2ObjectBody) => void;
      const slow = new Promise<R2ObjectBody>((resolve) => {
        resolveSlow = resolve;
      });
      const winnerBytes = new TextEncoder().encode('<html>hedged</html>');
      const winner = {
        body: new Response(winnerBytes).body!,
        size: winnerBytes.byteLength,
        httpEtag: '"winner"',
        httpMetadata: { contentType: 'text/html' },
      } as unknown as R2ObjectBody;
      const cancelLoser = vi.fn();
      const loser = {
        body: new ReadableStream({ cancel: cancelLoser }),
        size: 1,
        httpEtag: '"loser"',
        httpMetadata: { contentType: 'text/html' },
      } as unknown as R2ObjectBody;
      const r2Get = vi
        .fn<(key: string) => Promise<R2ObjectBody | null>>()
        .mockReturnValueOnce(slow)
        .mockResolvedValueOnce(winner);
      const { env } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();
      const responsePromise = app.fetch(new Request('https://test.void.app/'), env, ctx);

      await vi.advanceTimersByTimeAsync(0);
      expect(r2Get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get('ETag')).toBe('"winner"');
      expect(await response.text()).toBe('<html>hedged</html>');
      expect(r2Get).toHaveBeenCalledTimes(2);
      expect(r2Get).toHaveBeenNthCalledWith(2, 'assets/proj-1/hash1');
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

      resolveSlow(loser);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelLoser).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('attributes an exhausted R2 timeout to the platform without extending 10s', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r2Get = vi.fn(() => new Promise<R2ObjectBody | null>(() => {}));
      const { env, usageSend } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          userId: 'user-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();
      const responsePromise = app.fetch(new Request('https://test.void.app/'), env, ctx);

      await vi.advanceTimersByTimeAsync(0);
      expect(r2Get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(r2Get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(9000);

      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Void-Timeout')).toBe('static-asset');
      expect(response.headers.get('Retry-After')).toBe('5');
      expect(r2Get).toHaveBeenCalledTimes(2);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(usageSend).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            status: 503,
            failureKind: 'platform-static-asset-timeout',
          }),
        }),
      );
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('meters exhausted R2 binding errors as a platform 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r2Get = vi.fn(async () => {
        throw new Error('R2 service unavailable');
      });
      const { env, usageSend } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          userId: 'user-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();

      const response = await app.fetch(new Request('https://test.void.app/'), env, ctx);

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Void-Storage-Error')).toBe('static-asset-read');
      expect(r2Get).toHaveBeenCalledTimes(2);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(usageSend).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            status: 503,
            failureKind: 'platform-static-asset-error',
          }),
        }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('treats a missing manifest-referenced R2 object as a platform 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r2Get = vi.fn(async () => null);
      const { env, usageSend } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          userId: 'user-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
        },
        manifest: { '/index.html': '!hash1' },
        assets: {},
        r2Get,
      });
      const ctx = createCtx();

      const response = await app.fetch(new Request('https://test.void.app/'), env, ctx);

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Void-Storage-Error')).toBe('static-asset-missing');
      expect(r2Get).toHaveBeenNthCalledWith(1, 'assets/proj-1/hash1');
      expect(r2Get).toHaveBeenNthCalledWith(2, 'assets/hash1');
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      expect(usageSend).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            status: 503,
            failureKind: 'platform-static-asset-missing',
          }),
        }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it.each([undefined, '_next/static'])(
    'serves encoded Next.js chunks before HTML fallback with hashedAssetsPrefix=%s',
    async (hashedAssetsPrefix) => {
      const path = '/_next/static/chunks/pages/package/[...slug]-abc123.js';
      const body = 'self.webpackChunk_N_E = [];';
      const { env } = createStaticDeployEnv({
        routing: {
          workerName: '',
          projectId: 'proj-1',
          staticDeploymentId: 'deploy-abc',
          version: 'deploy-abc',
          hashedAssetsPrefix,
          fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
        },
        manifest: { [path]: 'hash_chunk', '/index.html': 'hash_index' },
        assets: {
          hash_chunk: { body, contentType: 'text/javascript; charset=utf-8' },
          hash_index: { body: '<!DOCTYPE html><title>Fallback</title>', contentType: 'text/html' },
        },
      });

      for (const pathname of [path, path.replace('[', '%5B').replace(']', '%5D')]) {
        // Check both the initial storage response and the cached response.
        for (let attempt = 0; attempt < 2; attempt++) {
          const ctx = createCtx();
          const response = await app.fetch(
            new Request(`https://test.void.app${pathname}`),
            env,
            ctx,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
          expect(await response.text()).toBe(body);
          await Promise.all(
            (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
          );
        }
      }
    },
  );

  it('serves a hashed asset whose filename contains a space (%20-encoded request)', async () => {
    // Regression: the oxc.rs hero `.riv` 404'd. The manifest key is the decoded
    // on-disk path (literal space), but the browser requests it `%20`-encoded and
    // `url.pathname` never decodes. Routing carries `hashedAssetsPrefix`, so the
    // request hits the hashed-asset fast path — which must decode before the
    // manifest lookup.
    const { env } = createStaticDeployEnv({
      routing: {
        workerName: '',
        projectId: 'proj-1',
        staticDeploymentId: 'deploy-abc',
        version: 'deploy-abc',
        hashedAssetsPrefix: 'assets',
      },
      manifest: { '/assets/640_x_630_oxc masthead_.B7dLtkJB.riv': 'hash_riv' },
      assets: { hash_riv: { body: 'RIVE-BYTES', contentType: 'application/octet-stream' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/assets/640_x_630_oxc%20masthead_.B7dLtkJB.riv'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('RIVE-BYTES');
  });
});

describe('static asset content-type normalization', () => {
  // Assets uploaded before the CLI's MIME table knew an extension carry a
  // stored `application/octet-stream` content type (R2 httpMetadata / KV `ct`
  // metadata). Dispatch must treat that stored default as "unknown" and
  // re-derive from the path so already-deployed files serve correctly.
  function createContentTypeEnv(options: {
    manifest: Record<string, string>;
    kvAssets?: Record<string, { body: string; ct: string }>;
    r2Assets?: Record<string, { body: string; contentType: string }>;
  }): Env {
    return {
      ROUTING: {
        get: async (key: string) =>
          key.startsWith('manifest:')
            ? JSON.stringify(options.manifest)
            : JSON.stringify({
                workerName: '',
                projectId: 'proj-1',
                staticDeploymentId: 'deploy-abc',
                version: 'deploy-abc',
              }),
      },
      DISPATCH: { get: vi.fn(() => ({ fetch: vi.fn() })) },
      ISR_CACHE: { getWithMetadata: async () => ({ value: null, metadata: null }) },
      STATIC_ASSETS: {
        getWithMetadata: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.kvAssets?.[hash];
          if (!asset) {
            return { value: null, metadata: null };
          }
          return {
            value: new TextEncoder().encode(asset.body).buffer,
            metadata: { ct: asset.ct },
          };
        },
      },
      STATIC_ASSETS_R2: {
        get: async (key: string) => {
          const hash = key.replace(/^assets\/[^/]+\//, '');
          const asset = options.r2Assets?.[hash];
          if (!asset) {
            return null;
          }
          return {
            body: asset.body,
            size: asset.body.length,
            httpEtag: '"ad7a5ae51c0bc3bbd2d6c7cbdc238c3e"',
            httpMetadata: { contentType: asset.contentType },
          };
        },
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;
  }

  it('re-derives content type for .md stored in R2 as application/octet-stream', async () => {
    const env = createContentTypeEnv({
      manifest: { '/guide/page.md': '!hash_md' },
      r2Assets: { hash_md: { body: '# hello', contentType: 'application/octet-stream' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/guide/page.md'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('re-derives content type for .md stored in KV as application/octet-stream', async () => {
    const env = createContentTypeEnv({
      manifest: { '/guide/page.md': 'hash_md' },
      kvAssets: { hash_md: { body: '# hello', ct: 'application/octet-stream' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/guide/page.md'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('honors an explicit stored content type that is not octet-stream', async () => {
    const env = createContentTypeEnv({
      manifest: { '/guide/page.md': 'hash_md' },
      kvAssets: { hash_md: { body: '# hello', ct: 'text/plain; charset=utf-8' } },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/guide/page.md'),
      env,
      createCtx(),
    );
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('keeps application/octet-stream when the extension is also unknown', async () => {
    const env = createContentTypeEnv({
      manifest: { '/file.xyz': 'hash_xyz' },
      kvAssets: { hash_xyz: { body: 'data', ct: 'application/octet-stream' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/file.xyz'), env, createCtx());
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  it('omits the Content-Type header for the application/null sentinel', async () => {
    const env = createContentTypeEnv({
      manifest: { '/data.bin': 'hash_bin' },
      kvAssets: { hash_bin: { body: 'data', ct: 'application/null' } },
    });

    const res = await app.fetch(new Request('https://test.void.app/data.bin'), env, createCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBeNull();
  });
});

describe('foreground worker duration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ['API mutation', '/api/email', 'POST', undefined],
    ['SSR page', '/slow', 'GET', undefined],
    ['ISR cache miss', '/slow', 'GET', 60],
  ] as const)('waits for a slow %s to finish by default', async (_, path, method, revalidate) => {
    const completed = vi.fn();
    const { env, logWrites, analyticsWrites } = createEnv({
      routing: {
        workerName: 'user-app-dpl_1',
        projectId: 'proj_1',
        type: 'void',
        ssr: true,
        revalidate,
      },
      workerFetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        completed();
        return new Response('completed', { headers: { 'Content-Type': 'text/html' } });
      },
    });
    const responsePromise = app.fetch(
      new Request(`https://my-app.void.app${path}`, { method }),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(11_000);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('completed');
    expect(completed).toHaveBeenCalledOnce();
    expect(logWrites).toHaveLength(0);
    expect(analyticsWrites).toHaveLength(1);
  });

  it.each([undefined, 60])(
    'waits for a slow worker fallback with ISR TTL %s',
    async (revalidate) => {
      let calls = 0;
      const { env, workerFetch, logWrites } = createEnv({
        routing: {
          workerName: 'user-app-dpl_1',
          projectId: 'proj_1',
          type: 'void',
          ssr: true,
          revalidate,
          fallbackRules: [{ source: '/missing', destination: '/slow', status: 200 }],
        },
        workerFetchImpl: async () => {
          if (++calls === 1) {
            return new Response('missing', { status: 404, headers: { 'X-Void-No-Match': '1' } });
          }
          await new Promise((resolve) => setTimeout(resolve, 11_000));
          return new Response('fallback', { headers: { 'Content-Type': 'text/html' } });
        },
      });
      const responsePromise = app.fetch(
        new Request('https://my-app.void.app/missing'),
        env,
        createCtx(),
      );
      await vi.advanceTimersByTimeAsync(11_000);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('fallback');
      expect(workerFetch).toHaveBeenCalledTimes(2);
      expect(logWrites).toHaveLength(0);
    },
  );

  it('keeps a separate bounded storage budget after a slow worker returns an asset stub', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stubBody = 'Assets have not yet been deployed to this script.\n';
      const { env, logWrites } = createEnv({
        routing: {
          workerName: 'user-app-dpl_1',
          projectId: 'proj_1',
          type: 'void',
          ssr: true,
          assetManifestId: 'deploy-1',
          assetConfig: { run_worker_first: true },
        },
        assetManifest: { '/bundle.js': '!bundle' },
        workerFetchImpl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 11_000));
          return new Response(stubBody, {
            headers: {
              'Content-Type': 'text/plain;charset=UTF-8',
              'Content-Length': String(stubBody.length),
            },
          });
        },
      });
      const get = vi.fn(() => new Promise<R2ObjectBody | null>(() => {}));
      Object.assign(env, { STATIC_ASSETS_R2: { get } });
      let settled = false;
      const responsePromise = app
        .fetch(
          new Request('https://my-app.void.app/bundle.js', { headers: { Cookie: 'a=1' } }),
          env,
          createCtx(),
        )
        .then((response) => {
          settled = true;
          return response;
        });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const response = await responsePromise;
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Void-Timeout')).toBe('static-asset');
      expect(get).toHaveBeenCalledTimes(2);
      expect(logWrites).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });
});

describe('worker timeout explains itself in the project log stream', () => {
  // A worker cut at the dispatch budget returns nothing, so it logs nothing and
  // `void project logs` was empty for the one failure users most need
  // explained. Dispatch now writes the explanation itself, keyed the way the
  // tail worker keys its rows so the existing read path finds it.
  function createHangingEnv(workerName: string) {
    const { env, logWrites, analyticsWrites } = createEnv({
      routing: { workerName, projectId: 'proj_1', type: 'void', ssr: true },
      // Never settles — `withTimeout` wins the race.
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });
    return {
      env: { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      logWrites,
      analyticsWrites,
    };
  }

  it('returns 503 and writes one log row attributed to the project', async () => {
    const { env, logWrites } = createHangingEnv('user-my-app-dpl_abc123');

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/slow', { method: 'POST' }),
      env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('X-Void-Timeout')).toBe('dispatch');

    expect(logWrites).toHaveLength(1);
    const dp = logWrites[0] as { indexes: Array<string>; blobs: Array<string> };
    expect(dp.indexes).toEqual(['user-my-app']);
    expect(dp.blobs[6]).toBe('dpl_abc123');
    expect(dp.blobs[5]).toBe('503');
    expect(dp.blobs[4]).toBe('POST');

    const logs = JSON.parse(dp.blobs[1]) as Array<{ level: string; message: Array<string> }>;
    expect(logs[0].level).toBe('error');
    expect(logs[0].message.join(' ')).toContain('POST /api/slow');
    // The budget reported must be the one actually enforced, not the default.
    expect(logs[0].message.join(' ')).toContain('20 ms');
  });

  it('still meters the request exactly once', async () => {
    const { env, analyticsWrites, logWrites } = createHangingEnv('user-my-app-dpl_abc123');

    await app.fetch(new Request('https://my-app.void.app/api/slow'), env, createCtx());

    // One `void_requests` row, unchanged, plus the new `void_logs` row.
    expect(analyticsWrites).toHaveLength(1);
    expect(logWrites).toHaveLength(1);
    const dp = analyticsWrites[0] as { blobs: Array<string> };
    expect(dp.blobs[3]).toBe('503');
  });

  it('writes no log row for a project whose routing carries no worker name', async () => {
    const { env, logWrites } = createHangingEnv('');

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/slow'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(logWrites).toHaveLength(0);
  });

  it('does not write a log row when the worker answers in time', async () => {
    const { env, logWrites } = createEnv({
      routing: { workerName: 'user-my-app-dpl_abc123', projectId: 'proj_1' },
      workerResponse: new Response('ok'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/api/fast'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(logWrites).toHaveLength(0);
  });
});

it.each(['requests', 'execution'] as const)(
  'serves a custom %s page from assets independently of application execution',
  async (resource) => {
    const filename = resource === 'requests' ? '/usage-limit.html' : '/execution-limit.html';
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'deploy_1',
        ...(resource === 'requests' ? { suspended: 'requests_exceeded' } : {}),
      },
      assetManifest: { [filename]: '!custom-page' },
      workerFetchImpl: async () => {
        throw new Error('Worker exceeded CPU limit');
      },
    });
    const get = vi.fn(async () => ({
      body: new Blob(['<h1>We will be back</h1>']).stream(),
      httpMetadata: { contentType: 'text/html' },
      httpEtag: '"page"',
    }));
    Object.assign(env, { STATIC_ASSETS_R2: { get } });
    const res = await app.fetch(
      new Request('https://my-app.void.app/', { headers: { accept: 'text/html' } }),
      env,
      createCtx(),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('We will be back');
    expect(get).toHaveBeenCalledWith('assets/proj_1/custom-page');
    expect(workerFetch).toHaveBeenCalledTimes(resource === 'requests' ? 0 : 1);
  },
);

function meteredRequestType(analyticsWrites: Array<unknown>): string | undefined {
  expect(analyticsWrites).toHaveLength(1);
  return (analyticsWrites[0] as { blobs: Array<string> }).blobs[1];
}

describe('request type metering for SSR routes with a file extension', () => {
  // An SSR worker answers both the app's routes and the deploy's static files.
  // A route such as `routes/sponsors.svg.ts` has a file extension, so its label
  // comes from the asset manifest or from how the worker answered, never from
  // the path alone. Void SSR deploys run the worker first for every path.
  const routing: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'void',
    ssr: true,
    version: 'deploy-1',
    assetManifestId: 'deploy-1',
    assetConfig: { not_found_handling: 'none', run_worker_first: ['/**'] },
  };
  const routingWithoutManifest: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'void',
    ssr: true,
    version: 'deploy-1',
  };
  const assetManifest = { '/robots.txt': 'robots-hash' };

  function svgResponse(): Response {
    return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
  }

  it.each(['/sponsors.svg', '/support-matrix.png?theme=dark'])(
    'labels the route at %s as ssr when the asset manifest does not list it',
    async (path) => {
      const { env, workerFetch, analyticsWrites } = createEnv({
        routing,
        assetManifest,
        workerResponse: svgResponse(),
      });

      const response = await app.fetch(
        new Request(`https://my-app.void.app${path}`),
        env,
        createCtx(),
      );

      expect(response.status).toBe(200);
      expect(workerFetch).toHaveBeenCalledOnce();
      expect(meteredRequestType(analyticsWrites)).toBe('ssr');
    },
  );

  // A plain GET goes through the static cache. The other requests skip it, so
  // the worker's answer is labeled without the manifest's.
  it.each<[string, RequestInit]>([
    ['a plain GET', {}],
    ['a GET with a cookie', { headers: { Cookie: 'a=1' } }],
    ['a HEAD request', { method: 'HEAD' }],
    ['a Range request', { headers: { Range: 'bytes=0-3' } }],
  ])('keeps a file listed in the asset manifest as static for %s', async (_, init) => {
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('User-agent: *', { headers: { 'Content-Type': 'text/plain' } }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/robots.txt', init),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it.each([
    ['is missing', async () => null],
    [
      'cannot be read',
      async () => {
        throw new Error('KV unavailable');
      },
    ],
  ])('keeps a successful response static when the asset manifest %s', async (_, readManifest) => {
    const created = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('User-agent: *', { headers: { 'Content-Type': 'text/plain' } }),
    });
    const readRouting = created.env.ROUTING.get.bind(created.env.ROUTING);
    const env = {
      ...created.env,
      ROUTING: {
        get: (key: string) => (key.startsWith('manifest:') ? readManifest() : readRouting(key)),
      },
    } as unknown as Env;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await app.fetch(
        new Request('https://my-app.void.app/robots.txt'),
        env,
        createCtx(),
      );

      expect(response.status).toBe(200);
      expect(created.workerFetch).toHaveBeenCalledOnce();
      expect(meteredRequestType(created.analyticsWrites)).toBe('static');
    } finally {
      error.mockRestore();
    }
  });

  it('keeps a successful response static when the deploy has no asset manifest', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: routingWithoutManifest,
      workerResponse: svgResponse(),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  // A deploy that uploaded no static files has no asset layer, so the worker
  // answered the path.
  it('labels a route server error as ssr when the deploy has no asset manifest', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: routingWithoutManifest,
      workerResponse: new Response('boom', { status: 500 }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(500);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('labels a route that runs past the dispatch budget as ssr when the deploy has no asset manifest', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: routingWithoutManifest,
      // Never settles, so the dispatch budget runs out first.
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg'),
      { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it.each<[string, RequestInit]>([
    ['a HEAD request', { method: 'HEAD' }],
    ['a GET with a cookie', { headers: { Cookie: 'a=1' } }],
  ])('labels a route server error from %s as ssr without reading the manifest', async (_, init) => {
    const { env, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('boom', { status: 500 }),
    });
    const routingGet = vi.spyOn(env.ROUTING, 'get');

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg', init),
      env,
      createCtx(),
    );

    expect(response.status).toBe(500);
    expect(routingGet.mock.calls.some(([key]) => String(key).startsWith('manifest:'))).toBe(false);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it.each([
    ['an asset manifest that does not list the path', routing],
    ['no asset manifest', routingWithoutManifest],
  ])('keeps a platform asset failure static on a deploy with %s', async (_, deployRouting) => {
    const stubBody = 'Assets have not yet been deployed to this script.\n';
    const { env, analyticsWrites } = createEnv({
      routing: deployRouting,
      assetManifest,
      workerResponse: new Response(stubBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Content-Length': String(stubBody.length),
        },
      }),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await app.fetch(
        new Request('https://my-app.void.app/sponsors.svg'),
        env,
        createCtx(),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('X-Void-Storage-Error')).toBe('static-asset-missing');
      expect(meteredRequestType(analyticsWrites)).toBe('static');
      expect((analyticsWrites[0] as { blobs: Array<string> }).blobs[5]).toBe(
        'platform-static-asset-missing',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('labels a route that runs past the dispatch budget as ssr', async () => {
    const { env, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      // Never settles, so the dispatch budget runs out first.
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/sponsors.svg', { headers: { Cookie: 'a=1' } }),
      { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('keeps a route with a file extension out of the ISR cache', async () => {
    const { env, kvStore, analyticsWrites } = createEnv({
      routing: { ...routing, revalidate: 60 },
      assetManifest,
      workerResponse: svgResponse(),
    });
    const ctx = createCtx();

    const response = await app.fetch(new Request('https://my-app.void.app/sponsors.svg'), env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
    expect([...kvStore.keys()].some((key) => key.includes('/sponsors.svg'))).toBe(false);
    expect(edgeCacheStore.size).toBe(0);
  });
});

describe('request type metering when Cloudflare serves assets before the worker', () => {
  // Unless `run_worker_first` covers every path, Cloudflare's asset layer
  // serves listed files without running the worker. An unlisted path reaches
  // the worker only with `not_found_handling: 'none'`; a SPA deploy gets the
  // shell from the asset layer instead.
  const assetFirstRouting: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'framework',
    ssr: true,
    version: 'deploy-1',
    assetManifestId: 'deploy-1',
    assetConfig: { not_found_handling: 'none' },
  };
  const spaWithApiRouting: RoutingEntry = {
    workerName: 'user-app-dpl_1',
    projectId: 'proj_1',
    type: 'void',
    ssr: true,
    version: 'deploy-1',
    assetManifestId: 'deploy-1',
    assetConfig: {
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*', '/__void', '/__void/*'],
    },
  };
  const assetManifest = { '/index.html': 'shell-hash', '/robots.txt': 'robots-hash' };
  const deploys = [
    ['an asset-first deploy', assetFirstRouting],
    ['a SPA deploy with API routes', spaWithApiRouting],
  ] as const;

  it('labels an unlisted path as ssr when the worker answers it', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: assetFirstRouting,
      assetManifest,
      workerResponse: new Response('png', { headers: { 'Content-Type': 'image/png' } }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/og.png'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('labels an unlisted path that runs past the dispatch budget as ssr', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: assetFirstRouting,
      assetManifest,
      // Never settles, so the dispatch budget runs out first.
      workerFetchImpl: () => new Promise<Response>(() => {}),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/og.png'),
      { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  // Cloudflare's default `html_handling` also serves or redirects a path from
  // an HTML file the manifest lists under another name.
  it.each([
    ['/docs/v1.2', '/docs/v1.2.html', 200],
    ['/docs/v1.2', '/docs/v1.2/index.html', 307],
    ['/about.html', '/about/index.html', 307],
    ['/about/index.html', '/about.html', 307],
    ['/docs/release%20v1.2', '/docs/release v1.2.html', 200],
  ])('keeps %s static when the asset layer answers it from %s', async (path, file, status) => {
    const { env, analyticsWrites } = createEnv({
      routing: assetFirstRouting,
      assetManifest: { ...assetManifest, [file]: 'page-hash' },
      workerResponse:
        status === 200
          ? new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } })
          : new Response(null, { status, headers: { Location: '/' } }),
    });

    const response = await app.fetch(
      new Request(`https://my-app.void.app${path}`),
      env,
      createCtx(),
    );

    expect(response.status).toBe(status);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it('labels an unlisted path as ssr when html_handling is none', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: {
        ...assetFirstRouting,
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
      },
      assetManifest: { ...assetManifest, '/docs/v1.2.html': 'page-hash' },
      workerResponse: new Response('<html>route</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/docs/v1.2'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('ssr');
  });

  it('keeps the SPA shell served for an unlisted path static', async () => {
    const { env, analyticsWrites } = createEnv({
      routing: spaWithApiRouting,
      assetManifest,
      workerResponse: new Response('<html>shell</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/old-page.html'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it.each(deploys)('keeps a server error for a listed file static on %s', async (_, routing) => {
    const { env, analyticsWrites } = createEnv({
      routing,
      assetManifest,
      workerResponse: new Response('unavailable', { status: 503 }),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/robots.txt'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(503);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });

  it.each(deploys)(
    'keeps a listed file that runs past the dispatch budget static on %s',
    async (_, routing) => {
      const { env, analyticsWrites } = createEnv({
        routing,
        assetManifest,
        // Never settles, so the dispatch budget runs out first.
        workerFetchImpl: () => new Promise<Response>(() => {}),
      });

      const response = await app.fetch(
        new Request('https://my-app.void.app/robots.txt'),
        { ...env, DISPATCH_TIMEOUT_MS: '20' } as Env,
        createCtx(),
      );

      expect(response.status).toBe(503);
      expect(meteredRequestType(analyticsWrites)).toBe('static');
    },
  );
});

describe('request type metering after a fallback rewrite', () => {
  // The asset manifest answer belongs to the path that was looked up. After a
  // fallback rewrites `/missing.png` to the shell, it says nothing about the
  // shell, so the response keeps the default label.
  it('does not apply the manifest answer for the original path to the rewrite target', async () => {
    let calls = 0;
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing: {
        workerName: 'user-app-dpl_1',
        projectId: 'proj_1',
        type: 'framework',
        ssr: true,
        version: 'deploy-1',
        assetManifestId: 'deploy-1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      assetManifest: { '/index.html': 'shell-hash' },
      workerFetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response('missing', { status: 404 })
          : new Response('<html>shell</html>', { headers: { 'Content-Type': 'text/html' } });
      },
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/missing.png'),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(meteredRequestType(analyticsWrites)).toBe('static');
  });
});
