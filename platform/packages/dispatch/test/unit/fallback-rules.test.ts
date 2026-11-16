import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import { SHARED_CACHE_POLICY_VERSION } from '../../src/isr.ts';
import type { AssetConfig } from '../../src/static.ts';

// Mock caches.default (same pattern as index.test.ts).
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
    delete: async (req: Request) => edgeCacheStore.delete(req.url),
  },
});
beforeEach(() => edgeCacheStore.clear());

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

type StaticRoutingEntry = {
  staticDeploymentId: string;
  projectId: string;
  userId?: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  assetConfig?: AssetConfig;
  version?: string;
  redirectRules?: Array<{ source: string; destination: string; status: number }>;
  fallbackRules?: Array<{ source: string; destination: string; status: number }>;
};

type WorkerRoutingEntry = {
  workerName: string;
  projectId: string;
  type?: 'void' | 'spa' | 'static' | 'framework';
  ssr?: boolean;
  revalidate?: number | Record<string, number>;
  version?: string;
  redirectRules?: Array<{ source: string; destination: string; status: number }>;
  fallbackRules?: Array<{ source: string; destination: string; status: number }>;
  queryAllowlist?: Record<string, Array<string>>;
};

/**
 * Build an Env for static-deployment tests. Assets are identified by their path;
 * the KV store keys off `assets/{projectId}/{path}` → an ArrayBuffer of the body.
 */
function createStaticEnv(opts: {
  routing: StaticRoutingEntry;
  manifest: Record<string, string>;
  assetBodies: Record<string, string>; // pathname → body
}): { env: Env } {
  const { routing, manifest, assetBodies } = opts;

  // Seed the KV asset store using the exact key format dispatch expects:
  // `assets/{projectId}/{hash}` for scoped, or `assets/{hash}` as legacy fallback.
  const assetStore = new Map<string, ArrayBuffer>();
  for (const [path, hash] of Object.entries(manifest)) {
    const body = assetBodies[path];
    if (body === undefined) {
      continue;
    }
    const buf = new TextEncoder().encode(body).buffer as ArrayBuffer;
    assetStore.set(`assets/${routing.projectId}/${hash}`, buf);
  }

  const env = {
    ROUTING: {
      get: async (key: string) => {
        if (key.startsWith('manifest:')) {
          return JSON.stringify(manifest);
        }
        return JSON.stringify(routing);
      },
    },
    DISPATCH: {
      get: () => ({ fetch: vi.fn() }),
    },
    STATIC_ASSETS: {
      getWithMetadata: async (key: string) => {
        const value = assetStore.get(key);
        if (!value) {
          return { value: null, metadata: null };
        }
        return { value, metadata: null };
      },
    },
    STATIC_ASSETS_R2: {
      get: async () => null,
    },
    ISR_CACHE: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
    },
    ANALYTICS: { writeDataPoint: () => {} },
  } as unknown as Env;

  return { env };
}

describe('SPA app — no user fallbacks (zero-overhead common case)', () => {
  it('serves /index.html on asset miss via assetConfig, fallbackRules not needed', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'single-page-application', html_handling: 'none' },
      },
      manifest: { '/index.html': 'h_index', '/assets/app.js': 'h_js' },
      assetBodies: { '/index.html': '<html>spa</html>', '/assets/app.js': 'console.log(1)' },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/app/settings'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>spa</html>');
  });

  it('serves the real asset when it exists (no SPA fallback)', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'single-page-application', html_handling: 'none' },
      },
      manifest: { '/index.html': 'h_index', '/assets/app.js': 'h_js' },
      assetBodies: { '/index.html': '<html>spa</html>', '/assets/app.js': 'console.log(1)' },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/assets/app.js'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
  });
});

describe('SPA app — user fallbacks with not_found_handling: none', () => {
  // Shape emitted by the CLI when the user defines `routing.fallbacks` on an SPA:
  // user rules come first, synthetic catch-all `/*` → `/index.html` is APPENDED.
  // Under dispatch's first-match-wins semantics the more-specific user rule wins
  // when it matches, and the synthetic rule catches everything else.
  const makeEnv = () =>
    createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
        fallbackRules: [
          { source: '/docs/*', destination: '/docs.html', status: 200 },
          { source: '/*', destination: '/index.html', status: 200 },
        ],
      },
      manifest: {
        '/index.html': 'h_index',
        '/docs.html': 'h_docs',
        '/existing-asset.png': 'h_png',
      },
      assetBodies: {
        '/index.html': '<html>app-shell</html>',
        '/docs.html': '<html>docs</html>',
        '/existing-asset.png': 'png-body',
      },
    });

  it('serves /docs.html when /docs/foo has no asset (user rule matches first, wins)', async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request('https://test.void.app/docs/foo'), env, createCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>docs</html>');
  });

  it('serves /index.html via synthetic catch-all for non-asset /app/settings (only synthetic matches)', async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request('https://test.void.app/app/settings'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>app-shell</html>');
  });

  it('serves existing asset directly; fallbackRules not evaluated', async () => {
    const { env } = makeEnv();
    const res = await app.fetch(
      new Request('https://test.void.app/existing-asset.png'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png-body');
  });
});

describe('static app — fallbackRules only, no SPA setting', () => {
  it.each([
    ['/proxy/missing', 200, '<html>proxied</html>'],
    ['/other/missing', 404, '<html>not found</html>'],
    ['/proxy/existing.html', 200, '<html>existing</html>'],
  ] as const)('applies fallbacks before a custom 404 page for %s', async (path, status, body) => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: '404-page', html_handling: 'none' },
        fallbackRules: [{ source: '/proxy/*', destination: '/proxied.html', status: 200 }],
      },
      manifest: {
        '/proxied.html': 'h_proxied',
        '/404.html': 'h_404',
        '/proxy/existing.html': 'h_existing',
      },
      assetBodies: {
        '/proxied.html': '<html>proxied</html>',
        '/404.html': '<html>not found</html>',
        '/proxy/existing.html': '<html>existing</html>',
      },
    });

    const res = await app.fetch(new Request(`https://test.void.app${path}`), env, createCtx());
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(body);
  });

  it('fires fallbackRules on asset miss', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
        fallbackRules: [{ source: '/proxy/*', destination: '/proxied.html', status: 200 }],
      },
      manifest: { '/proxied.html': 'h_proxied' },
      assetBodies: { '/proxied.html': '<html>proxied</html>' },
    });

    const res = await app.fetch(new Request('https://test.void.app/proxy/foo'), env, createCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>proxied</html>');
  });

  it('returns 404 when fallbackRules do not match', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
        fallbackRules: [{ source: '/proxy/*', destination: '/proxied.html', status: 200 }],
      },
      manifest: { '/proxied.html': 'h_proxied' },
      assetBodies: { '/proxied.html': '<html>proxied</html>' },
    });

    const res = await app.fetch(new Request('https://test.void.app/other/path'), env, createCtx());
    expect(res.status).toBe(404);
  });
});

describe('redirectRules entries (pre-asset phase)', () => {
  it('fires as a rewrite that wins over an existing asset', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
        // Status-200 entries in redirectRules come from `routing.rewrites` in
        // void.json or `200!` in _redirects. Pre-asset phase is implicit in the
        // list identity — dispatch does not inspect any flag on the rule.
        redirectRules: [{ source: '/legacy/*', destination: '/new.html', status: 200 }],
      },
      manifest: { '/new.html': 'h_new', '/legacy/asset.txt': 'h_legacy' },
      assetBodies: { '/new.html': '<html>new</html>', '/legacy/asset.txt': 'legacy-body' },
    });

    // Even though /legacy/asset.txt is a real asset, the pre-asset rewrite wins.
    const res = await app.fetch(
      new Request('https://test.void.app/legacy/asset.txt'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>new</html>');
  });

  it('fires as a redirect with status 3xx', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { html_handling: 'none' },
        redirectRules: [{ source: '/old', destination: '/new', status: 301 }],
      },
      manifest: {},
      assetBodies: {},
    });

    const res = await app.fetch(new Request('https://test.void.app/old'), env, createCtx());
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/new');
  });
});

describe('edge cache keying under fallback rewrites', () => {
  // Regression: when `version` is absent, `staticCacheKey` is undefined and the
  // fallback branch builds its own edge cache key. That key must use the path
  // the client requested, not the rewritten target — otherwise future requests
  // to the original path miss the cache entry.
  it('keys fallback-rewrite edge cache on the original (pre-rewrite) pathname', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
        fallbackRules: [{ source: '/proxy/*', destination: '/proxied.html', status: 200 }],
      },
      manifest: { '/proxied.html': 'h_proxied' },
      assetBodies: { '/proxied.html': '<html>proxied</html>' },
    });

    const ctx = createCtx();
    const res = await app.fetch(new Request('https://test.void.app/proxy/foo'), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>proxied</html>');

    // Flush background cache.put
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    // Cache must be keyed under the ORIGINAL path, not the rewrite target.
    expect(edgeCacheStore.has('https://test.void.app/proxy/foo?_v=dep_1')).toBe(true);
    expect(edgeCacheStore.has('https://test.void.app/proxied.html?_v=dep_1')).toBe(false);
  });
});

describe('_redirects 200 entries emitted into fallbackRules', () => {
  // Framework CLI now emits `_redirects` status-200 entries into fallbackRules (post-asset)
  // rather than redirectRules (pre-asset). Confirm they fire only on asset miss.
  it('does not intercept when an asset exists', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { html_handling: 'none' },
        fallbackRules: [{ source: '/api/*', destination: '/api.html', status: 200 }],
      },
      manifest: { '/api/real.json': 'h_real', '/api.html': 'h_api' },
      assetBodies: { '/api/real.json': '{"real":true}', '/api.html': '<html>api</html>' },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/api/real.json'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"real":true}');
  });

  it('fires on asset miss', async () => {
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { html_handling: 'none' },
        fallbackRules: [{ source: '/api/*', destination: '/api.html', status: 200 }],
      },
      manifest: { '/api/real.json': 'h_real', '/api.html': 'h_api' },
      assetBodies: { '/api/real.json': '{"real":true}', '/api.html': '<html>api</html>' },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/api/missing.json'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>api</html>');
  });
});

describe('fallbackRules rewrite — static-only path', () => {
  it('serves the rewrite target from static assets without invoking a worker', async () => {
    const workerFetch = vi.fn();
    const { env } = createStaticEnv({
      routing: {
        staticDeploymentId: 'dep_1',
        projectId: 'proj_1',
        assetConfig: { not_found_handling: 'none', html_handling: 'none' },
        fallbackRules: [{ source: '/docs/*', destination: '/docs.html', status: 200 }],
      },
      manifest: { '/docs.html': 'h_docs' },
      assetBodies: { '/docs.html': '<html>docs</html>' },
    });
    (env as unknown as { DISPATCH: { get: () => { fetch: typeof workerFetch } } }).DISPATCH = {
      get: () => ({ fetch: workerFetch }),
    };

    const res = await app.fetch(new Request('https://test.void.app/docs/intro'), env, createCtx());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>docs</html>');
    expect(workerFetch).not.toHaveBeenCalled();
  });
});

/**
 * Build an Env where dispatch routes to a user worker (no `staticDeploymentId`).
 * The worker handler is provided by the caller — typical use is to 404 most
 * paths and 200 the SPA shell, mirroring SvelteKit/Nuxt/Astro framework
 * projects authored with `routing.fallbacks`.
 */
function createWorkerEnv(opts: {
  routing: WorkerRoutingEntry;
  workerHandler: (req: Request) => Response | Promise<Response>;
}): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  kvStore: Map<
    string,
    {
      value: ArrayBuffer;
      metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
    }
  >;
} {
  const workerFetch = vi.fn(async (req: Request) => opts.workerHandler(req));
  const kvStore = new Map<
    string,
    {
      value: ArrayBuffer;
      metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
    }
  >();
  const env = {
    ROUTING: {
      get: async () => JSON.stringify(opts.routing),
    },
    DISPATCH: {
      get: () => ({ fetch: workerFetch }),
    },
    ISR_CACHE: {
      getWithMetadata: async (key: string) => {
        const entry = kvStore.get(key);
        if (!entry) {
          return { value: null, metadata: null };
        }
        return { value: entry.value, metadata: entry.metadata };
      },
      put: async (
        key: string,
        value: ArrayBuffer,
        opts?: {
          metadata?: {
            s: number;
            c: number;
            t: number;
            p: typeof SHARED_CACHE_POLICY_VERSION;
          };
        },
      ) => {
        kvStore.set(key, {
          value,
          metadata: opts?.metadata ?? {
            s: 200,
            c: Date.now(),
            t: 60,
            p: SHARED_CACHE_POLICY_VERSION,
          },
        });
      },
      list: async (opts: { prefix: string; limit?: number }) => {
        const keys = [...kvStore.keys()]
          .filter((key) => key.startsWith(opts.prefix))
          .slice(0, opts.limit ?? 1000)
          .map((name) => ({ name }));
        return { keys, list_complete: true, cursor: '' };
      },
    },
    ANALYTICS: { writeDataPoint: () => {} },
  } as unknown as Env;
  return { env, workerFetch, kvStore };
}

/**
 * `routing.fallbackRules` are evaluated post-asset for static deployments.
 * For WfP/framework projects (SvelteKit/Nuxt/Astro), the user worker IS the
 * router — its 404 is the equivalent of a static-asset miss. Without this
 * branch, framework users author `routing: { fallbacks: { "/*": "/index.html" } }`,
 * see it work in `vite dev`, and watch it silently 404 in production.
 */
describe('fallbackRules rewrite — WfP/framework branch', () => {
  it('re-dispatches to the rewrite target when the worker 404s', async () => {
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'spa-worker',
        projectId: 'proj_1',
        type: 'framework',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      workerHandler: (req) => {
        if (new URL(req.url).pathname === '/index.html') {
          return new Response('<html>spa</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/app/settings'),
      env,
      createCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>spa</html>');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(new URL((workerFetch.mock.calls[0]![0] as Request).url).pathname).toBe('/app/settings');
    expect(new URL((workerFetch.mock.calls[1]![0] as Request).url).pathname).toBe('/index.html');
  });

  it('does not re-dispatch Void app handler 404s without the generated no-match marker', async () => {
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'void-worker',
        projectId: 'proj_1',
        type: 'void',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      workerHandler: () => new Response('intentional missing', { status: 404 }),
    });

    const res = await app.fetch(
      new Request('https://test.void.app/api/missing-resource'),
      env,
      createCtx(),
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('intentional missing');
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(res.headers.get('X-Void-No-Match')).toBeNull();
  });

  it('re-dispatches Void app generated no-match 404s', async () => {
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'void-worker',
        projectId: 'proj_1',
        type: 'void',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      workerHandler: (req) => {
        if (new URL(req.url).pathname === '/index.html') {
          return new Response('<html>spa</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('not found', {
          status: 404,
          headers: { 'X-Void-No-Match': '1' },
        });
      },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/app/settings'),
      env,
      createCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>spa</html>');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(res.headers.get('X-Void-No-Match')).toBeNull();
  });

  it('preserves the request body across worker fallback re-dispatch on POST', async () => {
    // Regression: the first `worker.fetch(dispatchReq)` consumes the body
    // stream. Without cloning, the fallback re-dispatch would receive an
    // empty body — silent payload loss for any user fallback rule that
    // covers a POST endpoint (e.g. `"/api/*": "/api/handler"` BFF pattern).
    // The fix clones `dispatchReq` before the first fetch so the fallback
    // path has a replayable copy.
    const seenBodies: Array<string> = [];
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'void-worker',
        projectId: 'proj_1',
        type: 'void',
        fallbackRules: [{ source: '/api/missing', destination: '/api/handler', status: 200 }],
      },
      workerHandler: async (req) => {
        const body = await req.text();
        seenBodies.push(body);
        const path = new URL(req.url).pathname;
        if (path === '/api/handler') {
          return new Response(`handler-saw:${body}`, { status: 200 });
        }
        return new Response('not found', {
          status: 404,
          headers: { 'X-Void-No-Match': '1' },
        });
      },
    });

    const res = await app.fetch(
      new Request('https://test.void.app/api/missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: 1 }),
      }),
      env,
      createCtx(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('handler-saw:{"x":1}');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    // Both worker invocations saw the same body.
    expect(seenBodies).toEqual(['{"x":1}', '{"x":1}']);
  });

  it('does not re-dispatch when the worker returns a non-404 status', async () => {
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'spa-worker',
        projectId: 'proj_1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      workerHandler: () => new Response('boom', { status: 500 }),
    });

    const res = await app.fetch(new Request('https://test.void.app/api/x'), env, createCtx());
    expect(res.status).toBe(500);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the original 404 when no fallback rule matches', async () => {
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'spa-worker',
        projectId: 'proj_1',
        fallbackRules: [{ source: '/docs/*', destination: '/docs.html', status: 200 }],
      },
      workerHandler: () => new Response('not found', { status: 404 }),
    });

    const res = await app.fetch(new Request('https://test.void.app/api/missing'), env, createCtx());
    expect(res.status).toBe(404);
    expect(workerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not loop: a fallback rewrite that itself 404s returns the second response', async () => {
    // Single-pass — rewrite target's 404 is returned as-is, not re-fallback'd.
    const { env, workerFetch } = createWorkerEnv({
      routing: {
        workerName: 'spa-worker',
        projectId: 'proj_1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      workerHandler: () => new Response('still 404', { status: 404 }),
    });

    const res = await app.fetch(new Request('https://test.void.app/app/x'), env, createCtx());
    expect(res.status).toBe(404);
    expect(workerFetch).toHaveBeenCalledTimes(2);
  });

  it('applies fallbackRules before returning an ISR miss response', async () => {
    const { env, workerFetch, kvStore } = createWorkerEnv({
      routing: {
        workerName: 'spa-worker',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        version: 'dep_1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      workerHandler: (req) => {
        if (new URL(req.url).pathname === '/index.html') {
          return new Response('<html>spa</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const ctx = createCtx();
    const res = await app.fetch(new Request('https://test.void.app/app/settings'), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>spa</html>');
    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(new URL((workerFetch.mock.calls[0]![0] as Request).url).pathname).toBe('/app/settings');
    expect(new URL((workerFetch.mock.calls[1]![0] as Request).url).pathname).toBe('/index.html');

    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
    // Shell fallbacks are served live, not ISR-cached: a dotted HTML target
    // (`/index.html`) is indistinguishable here from a dynamic per-user endpoint,
    // so NO ISR entry — base key or `#rw=` variant — is written (see
    // `isFallbackTargetCacheable`). The shell is still SERVED (200 + body above).
    expect(
      [...kvStore.keys()].some((key) =>
        key.startsWith('proj_1/isr/v3/dep_1/test.void.app/app/settings'),
      ),
    ).toBe(false);

    edgeCacheStore.clear();
    // The shell is re-rendered live on every request — never a cache HIT.
    const second = await app.fetch(
      new Request('https://test.void.app/app/settings'),
      env,
      createCtx(),
    );

    expect(second.status).toBe(200);
    expect(second.headers.get('x-isr-cache')).not.toBe('HIT');
    expect(await second.text()).toBe('<html>spa</html>');
    expect(workerFetch).toHaveBeenCalledTimes(4);
  });

  it('serves the correct per-query shell live for fallback renders (no ISR variants cached)', async () => {
    const { env, workerFetch, kvStore } = createWorkerEnv({
      routing: {
        workerName: 'spa-worker',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        version: 'dep_1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
        queryAllowlist: { '/app/*': ['q'] },
      },
      workerHandler: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/index.html') {
          const original = req.headers.get('X-Void-Original-URL');
          const q = original ? new URL(original).searchParams.get('q') : null;
          return new Response(`<html>${q ?? ''}</html>`, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const send = async (url: string) => {
      const ctx = createCtx();
      const res = await app.fetch(new Request(url), env, ctx);
      await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));
      return res;
    };

    expect(await (await send('https://test.void.app/app/settings?q=a&cb=1')).text()).toBe(
      '<html>a</html>',
    );
    expect(await (await send('https://test.void.app/app/settings?q=b&cb=1')).text()).toBe(
      '<html>b</html>',
    );
    expect(await (await send('https://test.void.app/app/settings?q=a&cb=2')).text()).toBe(
      '<html>a</html>',
    );

    // Shell fallbacks are served live, not ISR-cached (see
    // `isFallbackTargetCacheable`): each send re-renders — no cache HIT saves a
    // fetch (3 sends × 2 fetches = 6) — and NO ISR variant keys are written. The
    // per-query bodies above still prove the allowlisted `q` reaches the render.
    expect(workerFetch).toHaveBeenCalledTimes(6);
    expect(
      [...kvStore.keys()].some((key) =>
        key.startsWith('proj_1/isr/v3/dep_1/test.void.app/app/settings'),
      ),
    ).toBe(false);
  });
});
