import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createClientAssetTags, createManifestLoader } from '../../src/runtime/routing-assets.ts';
import { createErrorRenderer } from '../../src/runtime/routing-errors.ts';
import {
  createPageGetHandler,
  createPageMutationHandler,
  createPagesFallback,
  createSsrFallback,
  markNamedActionRequest,
} from '../../src/runtime/routing-pages.ts';
import {
  applyAssetCachePolicy,
  createAssetCachePolicy,
  createAssetFallback,
  createWorkerFetch,
  filterInternalBindings,
  type RuntimeEnvironment,
} from '../../src/runtime/routing-worker.ts';
import {
  createHttpRouteHandler,
  createModuleLoader,
  createRoutingRuntime,
  type RoutingContext,
} from '../../src/runtime/routing.ts';

const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
const wrap = <T>(_env: RuntimeEnvironment, callback: () => T): T => callback();

describe('typed HTTP execution', () => {
  it('caches successful production loads, retries rejected loads and refreshes dev loads', async () => {
    let count = 0;
    const load = createModuleLoader(async () => {
      if (++count === 1) {
        throw new Error('load failed');
      }
      return { count };
    });
    await expect(load()).rejects.toThrow('load failed');
    expect(await load()).toEqual({ count: 2 });
    expect(await load()).toEqual({ count: 2 });
    const devLoad = createModuleLoader(async () => ++count, false);
    expect(await devLoad()).toBe(3);
    expect(await devLoad()).toBe(4);
  });
  it('invokes the selected lazy export and converts its real return value', async () => {
    const app = new Hono();
    app.get(
      '/route',
      createHttpRouteHandler(async () => ({ GET: (c) => ({ url: c.req.path }) }), 'GET'),
    );
    app.post(
      '/route',
      createHttpRouteHandler(async () => ({ POST: () => undefined }), 'POST'),
    );
    expect(await (await app.fetch(new Request('https://app.test/route'))).json()).toEqual({
      url: '/route',
    });
    expect(
      (await app.fetch(new Request('https://app.test/route', { method: 'POST' }))).status,
    ).toBe(204);
  });
  it('isolates request context for overlapping asynchronous requests', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.requestMiddleware);
    app.get('/:id', async (c) => {
      await Promise.resolve();
      return c.text(runtime.requestContext.getStore()!.request.url);
    });
    const responses = await Promise.all(
      ['/one', '/two'].map((path) => app.fetch(new Request('https://app.test' + path))),
    );
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      'https://app.test/one',
      'https://app.test/two',
    ]);
    expect(runtime.requestContext.getStore()).toBeUndefined();
  });
  it('applies the first matching host rule, capture substitution, query merge and dev traces', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, dev: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.routingMiddleware([
        { source: '/old/:id', destination: '/wrong', status: 301, host: 'other.test' },
        { source: '/old/:id', destination: '/new/:id?set=1', status: 301, origin: 'config' },
        { source: '/old/:id', destination: '/last', status: 302 },
      ]),
    );
    const response = await app.fetch(new Request('https://app.test/old/42?set=override&keep=1'));
    expect(response.headers.get('location')).toBe('/new/42?set=1&keep=1');
    expect(response.headers.get('X-Void-Routing')).toBe(
      'redirect[/old/:id] -> /new/42?set=1 301 (config)',
    );
  });
  it('keeps catch-all redirects on the same site when the capture starts with a slash', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    app.use(runtime.routingMiddleware([{ source: '/en/*', destination: '/:splat', status: 301 }]));
    const response = await app.fetch(new Request('https://app.test/en//evil.com'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/evil.com');
  });
  it.each([true, false])('gates dynamic rewrite tracing on dev=%s', async (dev) => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, dev });
    app.use(runtime.contextMiddleware);
    app.use(runtime.routingMiddleware([]));
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('rewritten'));
    const response = await app.fetch(new Request('https://app.test/old'));
    expect(await response.text()).toBe('rewritten');
    expect(response.headers.get('X-Void-Routing')).toBe(
      dev ? 'c.rewrite -> /new (middleware)' : null,
    );
  });
  it('merges header rules in order after recursive fallback and stops fallback cycles', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, dev: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([
        { pattern: '/*', headers: [['x-rule', 'one']] },
        { pattern: '/a', headers: [['x-rule', 'two']] },
      ]),
    );
    app.notFound(
      async (c) =>
        (await runtime.applyFallback(c, [
          { source: '/a', destination: '/b', status: 200 },
          { source: '/b', destination: '/a', status: 200 },
        ])) ?? runtime.markNoMatch(c.req.raw, new Response('missing', { status: 404 })),
    );
    const response = await app.fetch(new Request('https://app.test/a'));
    expect(response.status).toBe(404);
    expect(response.headers.get('x-rule')).toBe('one');
    expect(response.headers.get('X-Void-Routing')).toBe('fallback[/a] -> /b (unknown)');
    expect(response.headers.get('X-Void-No-Match')).toBe('1');
  });
});

function worker(overrides: Partial<Parameters<typeof createWorkerFetch>[0]> = {}) {
  const app = new Hono<{ Bindings: RuntimeEnvironment }>();
  app.get('/app', (c) =>
    c.json({ public: c.env.PUBLIC, hidden: c.env.__VOID_PROXY_TOKEN, keys: Object.keys(c.env) }),
  );
  return createWorkerFetch({
    app,
    assets: createAssetFallback(),
    withRawEnv: wrap,
    withRuntimeEnv: wrap,
    filterBindings: (env) => filterInternalBindings(env, ['__VOID_']),
    internalRoute: async () => null,
    collectPrerenderPaths: async () => ['/page'],
    ...overrides,
  });
}
describe('typed Worker fetch execution', () => {
  it('proves the actual named metadata version and never echoes requested override or private metadata', async () => {
    const fetch = worker({ versionMetadataBinding: '__VOID_VERSION_METADATA' });
    const request = new Request('https://app.test/__void/ready', {
      headers: { 'Cloudflare-Workers-Version-Overrides': 'app="candidate-version"' },
    });
    const response = await fetch(
      request,
      {
        __VOID_VERSION_METADATA: {
          id: 'served-version',
          tag: 'private-tag',
          timestamp: 'private-time',
        },
      },
      context,
    );
    expect(await response.json()).toEqual({ ready: true, versionId: 'served-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const missing = await fetch(request, {}, context);
    expect(await missing.json()).toEqual({ ready: true });
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });
  it('validates readiness and app requests and answers discovery only for the prerender runner', async () => {
    const validateEnv = vi.fn(async () => {});
    const collectPrerenderPaths = vi.fn(async () => ['/page']);
    const fetch = worker({ validateEnv, collectPrerenderPaths });
    const env = { PUBLIC: 'yes', __VOID_PROXY_TOKEN: 'secret' };
    expect(
      await (await fetch(new Request('https://app.test/__void/ready'), env, context)).json(),
    ).toEqual({ ready: true });
    expect(await (await fetch(new Request('https://app.test/app'), env, context)).json()).toEqual({
      public: 'yes',
      keys: ['PUBLIC'],
    });
    expect(validateEnv).toHaveBeenCalledTimes(2);
    const url = 'https://app.test/__void/prerender-paths';
    for (const headers of [{}, { 'x-void-internal': 'secret' }] as Array<Record<string, string>>) {
      const response = await fetch(new Request(url, { method: 'POST', headers }), env, context);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('/page');
    }
    expect(collectPrerenderPaths).not.toHaveBeenCalled();
    expect(validateEnv).toHaveBeenCalledTimes(4);
    const runner = await fetch(
      new Request(url, { method: 'POST' }),
      { PUBLIC: 'yes', __VOID_PRERENDER: '1' },
      context,
    );
    expect(await runner.json()).toEqual({ paths: ['/page'] });
    expect(validateEnv).toHaveBeenCalledTimes(4);
  });
  it('resolves remote env after validating original bindings and enters scopes before internal routes', async () => {
    const original = { __VOID_REMOTE: '1' };
    const resolved = { PUBLIC: 'remote' };
    const calls: Array<string> = [];
    const fetch = worker({
      validateEnv: async (env) => {
        expect(env).toBe(original);
        calls.push('validate');
      },
      remoteEnv: () => {
        calls.push('remote');
        return resolved;
      },
      withRawEnv: (env, callback) => {
        expect(env).toBe(resolved);
        calls.push('raw');
        return callback();
      },
      withRuntimeEnv: (env, callback) => {
        expect(env).toBe(resolved);
        calls.push('runtime');
        return callback();
      },
      internalRoute: async () => {
        calls.push('internal');
        return new Response('internal');
      },
    });
    expect(
      await (await fetch(new Request('https://app.test/internal'), original, context)).text(),
    ).toBe('internal');
    expect(calls).toEqual(['validate', 'remote', 'raw', 'runtime', 'internal']);
  });
  it('routes email receipts through the scoped callback before app middleware and preserves its response', async () => {
    const emailReceipt = vi.fn(async () => new Response('receipt', { status: 202 }));
    const internalRoute = vi.fn(async () => null);
    const response = await worker({ emailReceipt, internalRoute })(
      new Request('https://app.test/__void/email/receipt/v1', { method: 'POST' }),
      {},
      context,
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('receipt');
    expect(emailReceipt).toHaveBeenCalledTimes(1);
    expect(internalRoute).not.toHaveBeenCalled();
  });
  it('stamps ISR deployment once, refreshes host and bypasses the cache for WebSocket upgrades', async () => {
    const handle = vi.fn(async () => new Response('cache'));
    const env: RuntimeEnvironment = { ISR_CACHE: {}, PUBLIC: 'yes' };
    const fetch = worker({ isr: { deploymentId: 'deploy-one', handle } });
    expect(await (await fetch(new Request('https://one.test/app'), env, context)).text()).toBe(
      'cache',
    );
    expect(env.__VOID_ISR_HOST).toBe('one.test');
    env.__VOID_ISR_DEPLOYMENT_ID = 'existing';
    await fetch(
      new Request('https://two.test/app', { headers: { upgrade: 'websocket' } }),
      env,
      context,
    );
    expect(env.__VOID_ISR_HOST).toBe('two.test');
    expect(env.__VOID_ISR_DEPLOYMENT_ID).toBe('existing');
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it('hides capabilities through property lookup, membership, enumeration and descriptors only when selected', () => {
    const env = { __VOID_TOKEN: 'private', VOID_NORMAL: 'public', ISR_CACHE: 'user-cache' };
    const publicEnv = filterInternalBindings(env, ['__VOID_']);
    expect(publicEnv.ISR_CACHE).toBe('user-cache');
    const hidden = filterInternalBindings(env, ['__VOID_'], ['ISR_CACHE']);
    expect(hidden.__VOID_TOKEN).toBeUndefined();
    expect('ISR_CACHE' in hidden).toBe(false);
    expect(Object.keys(hidden)).toEqual(['VOID_NORMAL']);
    expect(Object.getOwnPropertyDescriptor(hidden, '__VOID_TOKEN')).toBeUndefined();
  });
});

describe('typed asset fallthrough', () => {
  it.each([['private, max-age=60'], ['no-store'], ['no-cache'], ['public, max-age=120']])(
    'preserves the authored %s policy for hashed assets',
    (policy) => {
      const source = new Response('asset', { headers: { 'cache-control': policy } });
      const response = applyAssetCachePolicy(
        new Request('https://app.test/assets/client-abcdefgh.js'),
        source,
        'assets',
        true,
      );
      expect(response.headers.get('cache-control')).toBe(policy);
      expect(source.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    },
  );
  it.each([
    ['/assets/app-settings.json', 'application/json'],
    ['/assets/client.js', 'text/javascript'],
    ['/assets/page-abcdefgh.html', 'text/html'],
    ['/assets/client-abcdefgh.js', 'text/html'],
    ['/public/client-abcdefgh.js', 'text/javascript'],
  ])('does not make %s (%s) immutable', (path, contentType) => {
    const source = new Response('asset', {
      headers: {
        'cache-control': 'public, max-age=0, must-revalidate',
        'content-type': contentType,
      },
    });
    expect(
      applyAssetCachePolicy(new Request('https://app.test' + path), source).headers.get(
        'cache-control',
      ),
    ).toBe('public, max-age=0, must-revalidate');
  });
  it('recognizes the configured directory, hash, query and HEAD without overriding cookies', () => {
    const request = new Request('https://app.test/static/chunks/client-EmOhWjz4.js?cache=1', {
      method: 'HEAD',
    });
    const source = new Response(null, {
      headers: { 'cache-control': 'must-revalidate, PUBLIC, max-age=0' },
    });
    expect(
      applyAssetCachePolicy(request, source, '/static/', true).headers.get('cache-control'),
    ).toBe('public, max-age=31536000, immutable');
    expect(source.headers.get('cache-control')).toBe('must-revalidate, PUBLIC, max-age=0');
    const cookie = new Response('asset', { headers: { 'set-cookie': 'local=value; Path=/' } });
    expect(
      applyAssetCachePolicy(request, cookie, 'static', true).headers.get('cache-control'),
    ).toBe('no-store');
  });
  it.each([null, { client: { file: 'assets/client-abcdefgh.js' } }])(
    'uses conservative cache policy without build provenance: %j',
    async (manifest) => {
      const load = vi.fn(async () => manifest);
      const policy = createAssetCachePolicy('assets', load);
      const response = await policy(
        new Request('https://app.test/assets/client-abcdefgh.js'),
        {},
        new Response('asset', {
          headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
        }),
      );
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      await policy(
        new Request('https://app.test/assets/app-settings.json'),
        {},
        new Response('asset'),
      );
      expect(load).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps assets available when optional manifest lookup fails', async () => {
    const policy = createAssetCachePolicy('assets', async () => {
      throw new Error('unavailable');
    });
    const response = await policy(
      new Request('https://app.test/assets/app-settings.json'),
      {},
      new Response('asset'),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.text()).resolves.toBe('asset');
  });
  it('preserves non-success, redirects and mutation responses', () => {
    for (const source of [
      new Response('missing', { status: 404 }),
      Response.redirect('https://app.test/new', 302),
    ]) {
      expect(
        applyAssetCachePolicy(new Request('https://app.test/assets/client-abcdefgh.js'), source),
      ).toBe(source);
    }
    const source = new Response('post');
    expect(
      applyAssetCachePolicy(
        new Request('https://app.test/assets/client-abcdefgh.js', { method: 'POST' }),
        source,
      ),
    ).toBe(source);
  });
  it('uses fresh requests, skips mutations and preserves intentional responses', async () => {
    const binding = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      return path === '/.vite/manifest.json'
        ? Response.json({
            client: {
              file: 'assets/file-abcdefgh.js',
              immutableFiles: ['assets/file-abcdefgh.js'],
            },
          })
        : new Response(path);
    });
    const serve = createAssetFallback();
    const post = new Request('https://app.test/mutate', { method: 'POST', body: 'body' });
    await post.text();
    const intentional = new Response('missing', { status: 404 });
    expect(await serve(post, { ASSETS: { fetch: binding } }, intentional)).toBe(intentional);
    const success = new Response('application');
    expect(
      await serve(new Request('https://app.test/page'), { ASSETS: { fetch: binding } }, success),
    ).toBe(success);
    expect(binding).not.toHaveBeenCalled();
    const request = new Request('https://app.test/assets/file-abcdefgh.js');
    const asset = await serve(request, { ASSETS: { fetch: binding } }, intentional);
    expect(binding.mock.calls[0][0]).not.toBe(request);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const plain = await serve(
      new Request('https://app.test/file.js'),
      { ASSETS: { fetch: binding } },
      intentional,
    );
    expect(plain.headers.get('cache-control')).toBe('no-store');
  });
});

describe('typed Pages and SSR execution', () => {
  const pageOptions = {
    componentId: 'page',
    render: async () => '<html>rendered</html>',
    assets: async () => ({ css: '', body: '', preloads: '' }),
    headConfig: undefined,
    renderOptions: { renderMode: 'server' as const },
  };
  it('selects default/named actions and preserves single actions and unknown-action responses', async () => {
    const app = new Hono();
    const load = async () => ({
      actions: { default: () => new Response('default'), save: () => new Response('save') },
    });
    app.post('/named', createPageMutationHandler({ ...pageOptions, load, namedActions: true }));
    app.post(
      '/single',
      createPageMutationHandler({
        ...pageOptions,
        load: async () => ({ action: () => new Response('single') }),
      }),
    );
    for (const [path, text, status] of [
      ['/named', 'default', 200],
      ['/named?save', 'save', 200],
      ['/named?missing', 'Unknown action: missing', 404],
      ['/named?constructor', 'Unknown action: constructor', 404],
      ['/named?__proto__', 'Unknown action: __proto__', 404],
      ['/named?valueOf', 'Unknown action: valueOf', 404],
      ['/named?toString', 'Unknown action: toString', 404],
      ['/single', 'single', 200],
    ] as const) {
      const response = await app.fetch(new Request('https://app.test' + path, { method: 'POST' }));
      expect(await response.text()).toBe(text);
      expect(response.status).toBe(status);
    }
  });
  it.each([
    ['/named?delete', '/named'],
    ['/named?delete&page=2', '/named?page=2'],
    ['/named?delete=1&page=2', '/named?page=2'],
    ['/named?&delete&page=2', '/named?page=2'],
    ['/named?delete&delete=x&page=2', '/named?delete=x&page=2'],
    ['/named?delete&q=a%20b&flag', '/named?q=a%20b&flag'],
    ['/single?page=2', '/done?page=2'],
  ])('drops only the named action key when c.redirect() carries %s', async (path, location) => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    const redirectTo = (location: string) => (c: Context) => c.redirect(location);
    app.post(
      '/named',
      createPageMutationHandler({
        ...pageOptions,
        load: async () => ({ actions: { delete: redirectTo('/named') } }),
        namedActions: true,
      }),
    );
    app.post(
      '/single',
      createPageMutationHandler({
        ...pageOptions,
        load: async () => ({ action: redirectTo('/done') }),
      }),
    );
    const response = await app.fetch(new Request('https://app.test' + path, { method: 'POST' }));
    expect(response.headers.get('location')).toBe(location);
  });
  describe('the named action key around the action', () => {
    function createNamedActionApp() {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.on(['POST'], '/named', markNamedActionRequest);
      app.use(async (c, next) => (c.req.header('x-anon') ? c.redirect('/login') : next()));
      app.post('/api/x', (c) => c.redirect('/done'));
      app.post(
        '/named',
        createPageMutationHandler({
          ...pageOptions,
          load: async () => ({
            actions: {
              delete: (c: Context) => c.redirect('/named'),
              move: (c: Context) => c.redirect('/named-v2', 307),
              go: (c: Context) => c.rewrite('/api/x'),
              goWithQuery: (c: Context) => c.rewrite('/api/x?q=1'),
              save: () => undefined,
            },
          }),
          namedActions: true,
        }),
      );
      return app;
    }

    it.each([
      ['/named?delete&page=2', 'middleware', '/login?page=2'],
      ['/named?move&page=2', 'a 307 redirect', '/named-v2?move&page=2'],
      ['/named?go&page=2', 'a rewrite', '/done?page=2'],
      ['/named?goWithQuery&page=2', 'a rewrite with its own query', '/done?q=1'],
    ])('POST %s through %s redirects to %s', async (path, through, location) => {
      const response = await createNamedActionApp().fetch(
        new Request('https://app.test' + path, {
          method: 'POST',
          headers: through === 'middleware' ? { 'x-anon': '1' } : {},
        }),
      );
      expect(response.headers.get('location')).toBe(location);
    });

    it.each([
      [301, ['page']],
      [308, ['delete', 'page']],
    ] as const)('a %i redirect rule carries the query keys %j', async (status, keys) => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.on(['POST'], '/named', markNamedActionRequest);
      app.use(runtime.routingMiddleware([{ source: '/named', destination: '/library', status }]));
      const response = await app.fetch(
        new Request('https://app.test/named?delete&page=2', { method: 'POST' }),
      );
      const location = new URL(response.headers.get('location')!, 'https://app.test');
      expect(location.pathname).toBe('/library');
      expect([...location.searchParams.keys()]).toEqual(keys);
    });

    it('leaves the key out of the page URL when the action renders the page again', async () => {
      const response = await createNamedActionApp().fetch(
        new Request('https://app.test/named?save&page=2', {
          method: 'POST',
          headers: { 'x-voidpages': 'true' },
        }),
      );
      expect(((await response.json()) as { url: string }).url).toBe('/named?page=2');
    });
  });
  it('executes the real page loader and protocol', async () => {
    const app = new Hono();
    app.get(
      '/page',
      createPageGetHandler({
        ...pageOptions,
        load: async () => ({ loader: () => ({ title: 'loaded' }) }),
      }),
    );
    const response = await app.fetch(
      new Request('https://app.test/page', { headers: { 'x-voidpages': 'true' } }),
    );
    expect(((await response.json()) as { props: unknown }).props).toEqual({ title: 'loaded' });
  });
  it('tries Pages assets before fallbacks and distinguishes files, API requests and unknown documents', async () => {
    const app = new Hono();
    const routing = createRoutingRuntime(app, { nodeTarget: true });
    app.use(routing.contextMiddleware);
    app.notFound(
      createPagesFallback({
        routing,
        errors: createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }),
        fallbackRules: [{ source: '/old', destination: '/new', status: 200 }],
      }),
    );
    app.get('/new', (c) => c.text('fallback'));
    const env = {
      ASSETS: {
        fetch: async (request: Request) =>
          new URL(request.url).pathname === '/old'
            ? new Response('asset')
            : new Response('missing', { status: 404 }),
      },
    };
    expect(await (await app.fetch(new Request('https://app.test/old'), env)).text()).toBe('asset');
    const doc = await app.fetch(new Request('https://app.test/missing'), env);
    expect(doc.headers.get('X-Void-No-Match')).toBe('1');
    const file = await app.fetch(new Request('https://app.test/file.css'), env);
    expect(file.headers.has('X-Void-No-Match')).toBe(false);
    const api = await app.fetch(new Request('https://app.test/api/missing'), env);
    expect(await api.text()).toBe('Not Found');
    expect(api.headers.has('X-Void-No-Match')).toBe(false);
  });
  it('renders SSR documents, fetches files and applies Node fallback before rendering', async () => {
    const app = new Hono();
    const routing = createRoutingRuntime(app, { nodeTarget: true });
    app.use(routing.contextMiddleware);
    app.get('/new', (c) => c.text('fallback'));
    app.notFound(
      createSsrFallback({
        routing,
        nodeTarget: true,
        fallbackRules: [{ source: '/old', destination: '/new', status: 200 }],
        load: async () => ({ render: async () => new Response('rendered') }),
        assets: async () => ({ css: '', body: '', preloads: '' }),
      }),
    );
    expect(await (await app.fetch(new Request('https://app.test/old'))).text()).toBe('fallback');
    expect(await (await app.fetch(new Request('https://app.test/document'))).text()).toBe(
      'rendered',
    );
    expect((await app.fetch(new Request('https://app.test/file.css'))).status).toBe(404);
  });
});

describe('typed error rendering', () => {
  it('escapes exceptions, renders causes and editor links in development and suppresses details in production', async () => {
    const error = new Error('<script>private</script>', { cause: new Error('nested failure') });
    error.stack = 'Error: private\n    at render (/project/pages/index.ts:12:3)';
    const request = new Request('https://app.test/page');
    const dev = createErrorRenderer({ dev: true, projectRoot: '/project', homeDir: '/home' });
    const html = await dev.createResponse(request, 500, 'Internal Server Error', error).text();
    expect(html).toContain('&lt;script&gt;private&lt;/script&gt;');
    expect(html).toContain('nested failure');
    expect(html).toContain('./pages/index.ts:12:3');
    expect(html).toContain('vscode://file//project/pages/index.ts:12:3');
    expect(html).toContain('data-void-error-toggle');
    const production = await createErrorRenderer({ projectRoot: '/project', homeDir: '/home' })
      .createResponse(request, 500, 'Internal Server Error', error)
      .text();
    expect(production).not.toContain('private');
    expect(production).not.toContain('nested failure');
  });
  it('keeps API/file errors plain and HEAD bodies empty', async () => {
    const errors = createErrorRenderer({ dev: true, projectRoot: '/project', homeDir: '/home' });
    for (const path of ['/api/error', '/file.css']) {
      expect(
        await errors
          .createResponse(
            new Request('https://app.test' + path),
            500,
            'Internal Server Error',
            new Error('private'),
          )
          .text(),
      ).toBe('Internal Server Error');
    }
    expect(
      await errors
        .createResponse(new Request('https://app.test/page', { method: 'HEAD' }), 404, 'Not Found')
        .text(),
    ).toBe('');
  });
  it('preserves HTTP exceptions and adds captured page CSS and dev overlay to custom 500 pages', async () => {
    const app = new Hono();
    const errors = createErrorRenderer({ dev: true, projectRoot: '/project', homeDir: '/home' });
    app.onError(errors.onError);
    app.get('/unauthorized', () => {
      throw new HTTPException(401, { message: 'Unauthorized' });
    });
    app.get('/error', () => {
      throw Object.assign(new Error('render failure'), {
        __voidPageAssetTags: { css: '<link rel="stylesheet" href="/page.css">' },
      });
    });
    expect((await app.fetch(new Request('https://app.test/unauthorized'))).status).toBe(401);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app.fetch(new Request('https://app.test/error'), {
        ASSETS: {
          fetch: async () => new Response('<html><head></head><body>Custom error</body></html>'),
        },
      });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain('Custom error');
      expect(body).toContain('/page.css');
      expect(body).toContain('render failure');
    } finally {
      log.mockRestore();
    }
  });
});

describe('typed client asset tags', () => {
  it('shares manifest cache and preserves route CSS cascade, imported preloads and island markdown entries', async () => {
    const manifest = {
      page: { file: 'page.js', imports: ['shared'], css: ['base.css'] },
      shared: { file: 'shared.js', css: ['shared.css'] },
      layout: { css: ['layout.css'] },
      component: { css: ['component.css'] },
      islands: { file: 'islands.js', imports: ['shared'] },
      md: { file: 'md.js', css: ['markdown.css'] },
    };
    const binding = vi.fn(async () => Response.json(manifest));
    const loader = createManifestLoader();
    const env = { ASSETS: { fetch: binding } };
    const request = new Request('https://app.test/page');
    const pages = createClientAssetTags(
      {
        entryId: 'page',
        entryUrl: '/page',
        kind: 'pages',
        pageCssKeys: { example: ['layout', 'component'] },
      },
      loader,
    );
    const tags = await pages(request, env, 'example');
    expect(tags.css).toBe(
      ['base.css', 'shared.css', 'layout.css', 'component.css']
        .map((file) => `<link rel="stylesheet" href="/${file}">`)
        .join('\n'),
    );
    expect(tags.preloads).toBe('<link rel="modulepreload" href="/shared.js">');
    const islands = createClientAssetTags(
      {
        entryId: 'islands',
        entryUrl: '/islands',
        kind: 'islands',
        extraEntryId: 'md',
        extraEntryUrl: '/md',
      },
      loader,
    );
    const islandTags = await islands(request, env);
    expect(islandTags.body).toBe(
      '<script type="module" src="/islands.js"></script>\n<script type="module" src="/md.js"></script>',
    );
    expect(islandTags.css).toContain('/markdown.css');
    expect(islandTags.preloads).not.toContain('/md.js');
    expect(binding).toHaveBeenCalledTimes(1);
  });
  it('loads development CSS with active roots and omits client tags when production has no manifest', async () => {
    const devCss = vi.fn(
      async (
        _request: Request,
        _env: RuntimeEnvironment,
        _options: {
          kind: 'pages' | 'islands';
          componentId: string;
          rootPhases: Array<Array<string>>;
        },
      ) => [{ url: '/page.css', css: 'body{}' }],
    );
    const options = {
      entryId: 'page',
      entryUrl: '/page',
      kind: 'pages' as const,
      devRootPhases: { example: [['/entry'], ['/layout'], ['/page']] },
    };
    const dev = await createClientAssetTags({ ...options, dev: true, devCss })(
      new Request('https://app.test/page'),
      {},
      'example',
    );
    expect(dev.body).toContain('/page');
    expect(dev.preloads).toContain('/@vite/client');
    expect(devCss.mock.calls[0][2].rootPhases).toEqual([['/entry'], ['/layout'], ['/page']]);
    expect(dev.devCss).toHaveLength(1);
    expect(await createClientAssetTags(options)(new Request('https://app.test/page'), {})).toEqual({
      css: '',
      preloads: '',
      body: '',
    });
  });
});
