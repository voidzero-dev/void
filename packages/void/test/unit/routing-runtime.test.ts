import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { describe, expect, it, vi } from 'vite-plus/test';
import { routeUrl } from 'void/routes';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { defer } from '../../src/pages/defer.ts';
import { ValidationError } from '../../src/pages/protocol.ts';
import { decodePageData, serializePageData } from '../../src/pages/serialize.ts';
import { _validateEnvOnce, defineEnv, env } from '../../src/runtime/env-public.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { defineHandler, defineMiddleware, type CloudContext } from '../../src/runtime/handler.ts';
import { createClientAssetTags, createManifestLoader } from '../../src/runtime/routing-assets.ts';
import { createErrorRenderer } from '../../src/runtime/routing-errors.ts';
import {
  createAssetNotFound,
  createPageGetHandler,
  createPageMutationHandler,
  createPagesFallback,
  createNamedActionMarker,
  createSsrFallback,
  markRouteHandler,
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
  type RoutingHeaderRule,
  type RoutingRuntime,
} from '../../src/runtime/routing.ts';
import { markStaticAsset } from '../../src/runtime/static-asset-marker.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

const context = { waitUntil() {}, passThroughOnException() {}, props: {} };
const wrap = <T>(_env: RuntimeEnvironment, callback: () => T): T => callback();

declare module 'void/routes' {
  interface RoutePathMap {
    '/typed-rewrite/:id': 'id';
  }
}

describe('typed HTTP execution', () => {
  it.each([undefined, 301, 303, 307, 308] as const)(
    'redirects typed destinations with status %s',
    async (status) => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      const destination = routeUrl('/typed-rewrite/:id', {
        params: { id: 'a/b' },
        query: { tab: 'activity' },
        hash: 'details',
      });
      app.get(
        '/redirect',
        createHttpRouteHandler(
          async () => ({
            GET: defineHandler((c) => c.redirect(destination, status)),
          }),
          'GET',
        ),
      );
      const response = await app.fetch(new Request('https://app.test/redirect'));
      expect(response.status).toBe(status ?? 302);
      expect(response.headers.get('Location')).toBe('/typed-rewrite/a%2Fb?tab=activity#details');
    },
  );

  it('rewrites typed destinations with encoded params and a query string', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    app.get('/old', (c) =>
      c.rewrite({
        pathname: '/typed-rewrite/:id',
        params: { id: 'a/b' },
        query: { tab: 'activity' },
      }),
    );
    app.get('/typed-rewrite/:id', (c) =>
      c.json({
        id: c.req.param('id'),
        tab: c.req.query('tab'),
        original: c.originalUrl()?.pathname,
      }),
    );
    const response = await app.fetch(new Request('https://app.test/old'));
    expect(await response.json()).toEqual({ id: 'a/b', tab: 'activity', original: '/old' });
  });

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
  describe('code redirects and routing.redirects', () => {
    function redirectApp(setup: (app: Hono, runtime: RoutingRuntime) => void): Hono {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      setup(app, runtime);
      return app;
    }

    it.each([
      ['/sign-in?redirectTo=/notes', '/notes', '/notes'],
      ['/notes?x=1', '/sign-in?redirectTo=%2Fnotes', '/sign-in?redirectTo=%2Fnotes'],
      ['/notes?x=1&y=2', '/notes#saved', '/notes#saved'],
      ['/old?x=1&y=2', 'https://example.com/next?ok=1', 'https://example.com/next?ok=1'],
      ['/old?x=1&y=2', '//partner.example.com/landing', '//partner.example.com/landing'],
    ])('c.redirect from %s to %s sends %s', async (requestPath, destination, location) => {
      const app = redirectApp((app) => {
        app.get('/*', (c) => c.redirect(destination));
      });
      const response = await app.fetch(new Request('https://app.test' + requestPath));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(location);
    });

    it('does not carry redirectTo out of a page loader', async () => {
      const app = redirectApp((app) => {
        app.get(
          '/sign-in',
          createPageGetHandler({
            componentId: 'sign-in',
            render: async () => '<html></html>',
            assets: async () => ({ css: '', body: '', preloads: '' }),
            headConfig: undefined,
            renderOptions: { renderMode: 'server' },
            load: async () => ({ loader: (c: CloudContext) => c.redirect('/notes') }),
          }),
        );
      });
      const response = await app.fetch(new Request('https://app.test/sign-in?redirectTo=/notes'));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/notes');
    });

    it('does not carry a single action query into c.redirect()', async () => {
      const app = redirectApp((app) => {
        app.post(
          '/single',
          createPageMutationHandler({
            componentId: 'page',
            render: async () => '<html></html>',
            assets: async () => ({ css: '', body: '', preloads: '' }),
            headConfig: undefined,
            renderOptions: { renderMode: 'server' },
            load: async () => ({ action: (c: CloudContext) => c.redirect('/done') }),
          }),
        );
      });
      const response = await app.fetch(
        new Request('https://app.test/single?page=2', { method: 'POST' }),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/done');
    });

    it('does not leak a request token through middleware', async () => {
      const app = redirectApp((app) => {
        app.use('/any', async (c) => c.redirect('/banned'));
        app.get('/any', (c) => c.text('ok'));
      });
      const response = await app.fetch(new Request('https://app.test/any?token=abc'));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/banned');
    });

    it('does not append the request query to a routeUrl redirect', async () => {
      const destination = routeUrl('/typed-rewrite/:id', {
        params: { id: 'a/b' },
        query: { tab: 'activity' },
        hash: 'details',
      });
      const app = redirectApp((app) => {
        app.get('/redirect', (c) => c.redirect(destination));
      });
      const response = await app.fetch(new Request('https://app.test/redirect?extra=1'));
      expect(response.headers.get('location')).toBe('/typed-rewrite/a%2Fb?tab=activity#details');
    });

    it.each([
      ['/old?redirectTo=/notes', '/new', '/new?redirectTo=/notes'],
      ['/old?token=abc&keep=1', '/new?ref=1', '/new?ref=1&token=abc&keep=1'],
      ['/old?token=abc', '/new?', '/new'],
      ['/old?utm=x', '/new#faq', '/new?utm=x#faq'],
    ])('a routing redirect from %s to %s sends %s', async (requestPath, destination, location) => {
      const app = redirectApp((app, runtime) => {
        app.use(runtime.routingMiddleware([{ source: '/old', destination, status: 302 }]));
      });
      const response = await app.fetch(new Request('https://app.test' + requestPath));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(location);
    });
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
  it.each([true, false])('disables generated image caching only in dev=%s', async (dev) => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, dev });
    app.use(runtime.headerMiddleware([]));
    app.get(
      '/image',
      () =>
        new Response('image', {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' },
        }),
    );
    const response = await app.request('/image');
    expect(response.headers.get('cache-control')).toBe(
      dev ? 'no-store' : 'public, max-age=31536000',
    );
  });

  it('does not let header rules re-enable generated image caching in dev', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, dev: true });
    app.use(
      runtime.headerMiddleware([
        { pattern: '/*', headers: [['Cache-Control', 'public, max-age=60']] },
      ]),
    );
    app.get('/image', () => new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    expect((await app.request('/image')).headers.get('cache-control')).toBe('no-store');
  });

  it('preserves static image and non-image cache policies in dev', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true, dev: true });
    app.use(runtime.headerMiddleware([]));
    const policy = 'public, max-age=31536000, immutable';
    app.get('/static.png', (c) =>
      markStaticAsset(
        c,
        new Response('image', {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': policy },
        }),
      ),
    );
    app.get(
      '/text',
      () =>
        new Response('text', {
          headers: { 'Content-Type': 'text/plain', 'Cache-Control': policy },
        }),
    );
    expect((await app.request('/static.png')).headers.get('cache-control')).toBe(policy);
    expect((await app.request('/text')).headers.get('cache-control')).toBe(policy);
  });

  it.each([200, 404])(
    'overrides an existing response header with the last matching rule on %s',
    async (status) => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(
        runtime.headerMiddleware([
          { pattern: '/assets/*', headers: [['Cache-Control', 'no-cache']] },
          {
            pattern: '/assets/*',
            headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
          },
        ]),
      );
      app.get(
        '/assets/app.css',
        () =>
          new Response('body{}', {
            status,
            headers: {
              'Content-Type': 'text/css',
              'Cache-Control': 'public, max-age=0, must-revalidate',
            },
          }),
      );
      const response = await app.request('https://app.test/assets/app.css');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toBe('text/css');
      expect(await response.text()).toBe('body{}');
    },
  );
  it('updates immutable response headers and preserves unrelated cookies and metadata', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(
      runtime.headerMiddleware([
        {
          pattern: '/assets/*',
          headers: [
            ['Location', '/new'],
            ['X-Robots-Tag', 'noindex'],
          ],
        },
      ]),
    );
    app.get('/assets/redirect', () => Response.redirect('https://old.test/', 302));
    app.get('/assets/cookies', () => {
      const headers = new Headers({ 'Content-Type': 'text/css' });
      headers.append('Set-Cookie', 'one=1; Path=/');
      headers.append('Set-Cookie', 'two=2; Path=/');
      return new Response('body{}', { status: 202, statusText: 'Queued', headers });
    });
    app.get(
      '/other',
      () => new Response('other', { headers: { 'Cache-Control': 'private, no-store' } }),
    );
    const redirect = await app.request('https://app.test/assets/redirect');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/new');
    const response = await app.request('https://app.test/assets/cookies');
    expect(response.status).toBe(202);
    expect(response.statusText).toBe('Queued');
    expect(response.headers.get('content-type')).toBe('text/css');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.getSetCookie()).toEqual(['one=1; Path=/', 'two=2; Path=/']);
    expect(await response.text()).toBe('body{}');
    const other = await app.request('https://app.test/other');
    expect(other.headers.get('cache-control')).toBe('private, no-store');
    expect(other.headers.has('x-robots-tag')).toBe(false);
  });
  it('adds a Set-Cookie rule next to the response cookies', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(
      runtime.headerMiddleware([{ pattern: '/*', headers: [['Set-Cookie', 'consent=1; Path=/']] }]),
    );
    app.get('/sign-in', (c) => {
      c.header('Set-Cookie', 'session=abc; Path=/; HttpOnly', { append: true });
      return c.text('ok');
    });
    const response = await app.request('https://app.test/sign-in');
    expect(response.headers.getSetCookie()).toEqual([
      'session=abc; Path=/; HttpOnly',
      'consent=1; Path=/',
    ]);
  });
  it('uses the last matching Set-Cookie rule value', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware(
        ['theme=light; Path=/', 'theme=dark; Path=/', 'theme=light; Path=/'].map(
          (cookie): RoutingHeaderRule => ({ pattern: '/*', headers: [['Set-Cookie', cookie]] }),
        ),
      ),
    );
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('new'));
    for (const path of ['/new', '/old']) {
      const response = await app.request(`https://app.test${path}`);
      expect(response.headers.getSetCookie()).toEqual(['theme=light; Path=/']);
    }
  });
  it('ends with the source rule cookie after a rewrite', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([
        { pattern: '/new', headers: [['Set-Cookie', 'theme=dark; Path=/']] },
        { pattern: '/old', headers: [['Set-Cookie', 'theme=light; Path=/']] },
      ]),
    );
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('new', 200, { 'set-cookie': 'theme=light; Path=/' }));
    const response = await app.request('https://app.test/old');
    expect(response.headers.getSetCookie().at(-1)).toBe('theme=light; Path=/');
  });
  it('adds a Set-Cookie rule once when a rewrite source and destination both match', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([{ pattern: '/*', headers: [['Set-Cookie', 'consent=1; Path=/']] }]),
    );
    app.get('/old', (c) => (c as RoutingContext).rewrite('/new'));
    app.get('/new', (c) => c.text('new'));
    const response = await app.request('https://app.test/old');
    expect(response.headers.getSetCookie()).toEqual(['consent=1; Path=/']);
  });
  it('does not give a fallback page the rules of the missing path', async () => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    app.use(
      runtime.headerMiddleware([
        {
          pattern: '/assets/*',
          headers: [['Cache-Control', 'public, max-age=31536000, immutable']],
        },
      ]),
    );
    app.get(
      '/index.html',
      (c) => new Response('<html></html>', { headers: { 'Cache-Control': 'no-cache' } }),
    );
    app.notFound(
      async (c) =>
        (await runtime.applyFallback(c, [
          { source: '/*', destination: '/index.html', status: 200 },
        ])) ?? c.text('missing', 404),
    );
    const response = await app.fetch(new Request('https://app.test/assets/old-chunk.js'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-cache');
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
    // Only the destination's rules apply, as in edge routing and platform dispatch.
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
  it('renders a build-only 404 only for the trusted prerender environment', async () => {
    const staticNotFound = vi.fn(
      async () =>
        new Response('<h1>Missing</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } }),
    );
    const validateEnv = vi.fn(async () => {});
    const fetch = worker({ staticNotFound, validateEnv });
    const request = new Request('http://localhost/__void/static-not-found', {
      headers: { 'x-void-internal': '1' },
    });
    await fetch(request, {}, context);
    expect(staticNotFound).not.toHaveBeenCalled();
    expect(validateEnv).toHaveBeenCalledTimes(1);
    const response = await fetch(request, { __VOID_PRERENDER: '1' }, context);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('<h1>Missing</h1>');
    expect(staticNotFound).toHaveBeenCalledTimes(1);
    expect(validateEnv).toHaveBeenCalledTimes(1);
  });
  // An async Standard Schema validator, like zod's async refine.
  const upper = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: async (value: unknown) => ({ value: String(value).toUpperCase() }),
    },
  };
  // The entry validates before it opens the request scope that the app's reads run in.
  it('serves an env.ts value with an async validator to app requests', async () => {
    defineEnv({ TOKEN: upper });
    try {
      const app = new Hono();
      app.get('/token', (c) => c.json({ token: env.TOKEN }));
      const fetch = worker({ app, validateEnv: _validateEnvOnce, withRuntimeEnv });
      for (const rawEnv of [{ TOKEN: 'sk_test' }, { TOKEN: 'sk_test' }]) {
        const response = await fetch(new Request('https://app.test/token'), rawEnv, context);
        expect(await response.json()).toEqual({ token: 'SK_TEST' });
      }
    } finally {
      defineEnv({});
    }
  });
  // Remote dev mode replaces the env with a copy before it opens the request scope.
  it('serves an env.ts value with an async validator to remote dev requests', async () => {
    defineEnv({ TOKEN: upper });
    try {
      const app = new Hono();
      app.get('/token', (c) => c.json({ token: env.TOKEN }));
      const fetch = worker({
        app,
        validateEnv: _validateEnvOnce,
        withRuntimeEnv,
        remoteEnv: (original) => ({ ...original }),
      });
      const response = await fetch(
        new Request('https://app.test/token'),
        { TOKEN: 'sk_test', __VOID_REMOTE: '1' },
        context,
      );
      expect(await response.json()).toEqual({ token: 'SK_TEST' });
    } finally {
      defineEnv({});
    }
  });
  // Cloudflare can keep an isolate running when only its bindings change, so a request that
  // holds the old values can overlap one that holds the new values.
  it('serves each of two overlapping requests the async value of its own env', async () => {
    defineEnv({ TOKEN: upper });
    try {
      // Both requests validate before either reads.
      let waiting = 0;
      let release = () => {};
      const bothValidated = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = new Hono();
      app.get('/token', async (c) => {
        if (++waiting === 2) {
          release();
        }
        await bothValidated;
        return c.json({ token: env.TOKEN });
      });
      const fetch = worker({ app, validateEnv: _validateEnvOnce, withRuntimeEnv });
      const responses = await Promise.all(
        ['a', 'b'].map((value) =>
          fetch(new Request('https://app.test/token'), { TOKEN: value }, context),
        ),
      );
      expect(
        await Promise.all(
          responses.map(async (response) => [response.status, await response.text()]),
        ),
      ).toEqual([
        [200, '{"token":"A"}'],
        [200, '{"token":"B"}'],
      ]);
    } finally {
      defineEnv({});
    }
  });
  it('returns a getPrerenderPaths() error to the prerender runner', async () => {
    const fetch = worker({
      collectPrerenderPaths: async () => {
        throw new TypeError('pages/a.server.ts getPrerenderPaths()[0]: bad');
      },
    });
    const response = await fetch(
      new Request('https://app.test/__void/prerender-paths', { method: 'POST' }),
      { __VOID_PRERENDER: '1' },
      context,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'pages/a.server.ts getPrerenderPaths()[0]: bad',
    });
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
  ])('drops only the named action key when c.redirect() carries %s', async (path, location) => {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    const redirectTo = (location: string) => (c: CloudContext) => c.redirect(location);
    app.post(
      '/named',
      createPageMutationHandler({
        ...pageOptions,
        load: async () => ({ actions: { delete: redirectTo('/named') } }),
        namedActions: true,
      }),
    );
    const response = await app.fetch(new Request('https://app.test' + path, { method: 'POST' }));
    expect(response.headers.get('location')).toBe(location);
  });
  describe('the named action key around the action', () => {
    function createNamedActionApp(pagePattern = '/named') {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(createNamedActionMarker(matchedRoutes));
      app.use(async (c, next) => (c.req.header('x-anon') ? c.redirect('/login') : next()));
      app.post(
        '/api/x',
        createHttpRouteHandler(
          async () => ({ POST: (c: CloudContext) => c.redirect('/done') }),
          'POST',
        ),
      );
      app.on(
        ['POST', 'PUT'],
        pagePattern,
        createPageMutationHandler({
          ...pageOptions,
          load: async () => ({
            actions: {
              delete: (c: CloudContext) => c.redirect('/named'),
              update: (c: CloudContext) => c.redirect('/named', 303),
              move: (c: CloudContext) => c.redirect('/named-v2', 307),
              moveTab: (c: CloudContext) => c.redirect('/named-v2?tab=details', 307),
              moveHash: (c: CloudContext) => c.redirect('/named-v2?tab=details#top', 307),
              moveReset: (c: CloudContext) => c.redirect('/named-v2?', 307),
              replace: (c: CloudContext) => c.redirect('/named-v2?tab=details', 302),
              moveKey: (c: CloudContext) => c.redirect('/named-v2?tab=1&moveKey=x', 307),
              moveSame: (c: CloudContext) => c.redirect('/named-v2?moveSame', 307),
              toArchive: (c: CloudContext) => c.redirect('/named?archive', 307),
              toArchiveHere: (c: CloudContext) => c.redirect('/named?', 307),
              go: (c: CloudContext) => c.rewrite('/api/x'),
              goWithQuery: (c: CloudContext) => c.rewrite('/api/x?q=1'),
              save: () => undefined,
            },
          }),
          namedActions: true,
        }),
      );
      return app;
    }

    it.each([
      ['POST', '/named?delete&page=2', 'middleware', '/login?page=2'],
      ['POST', '/named?move&page=2', 'a 307 redirect', '/named-v2?move&page=2'],
      ['POST', '/named?moveTab&page=2', 'a 307 redirect', '/named-v2?moveTab&tab=details&page=2'],
      [
        'POST',
        '/named?moveTab&moveTab=secondary&page=2',
        'a 307 redirect',
        '/named-v2?moveTab&tab=details&moveTab=secondary&page=2',
      ],
      ['PUT', '/named?replace&page=2', 'a 302 redirect', '/named-v2?replace&tab=details&page=2'],
      [
        'PUT',
        '/named?&replace=1&page=2',
        'a 302 redirect',
        '/named-v2?replace=1&tab=details&page=2',
      ],
      ['POST', '/named?replace&page=2', 'a 302 redirect', '/named-v2?tab=details&page=2'],
      [
        'POST',
        '/named?moveHash&page=2',
        'a 307 redirect',
        '/named-v2?moveHash&tab=details&page=2#top',
      ],
      ['POST', '/named?moveReset&page=2', 'a 307 redirect', '/named-v2?moveReset'],
      ['POST', '/named?moveKey&page=2', 'a 307 redirect', '/named-v2?moveKey=x&tab=1&page=2'],
      ['POST', '/named?moveSame', 'a 307 redirect', '/named-v2?moveSame'],
      ['PUT', '/named?toArchive&page=2', 'a 307 redirect', '/named?archive=&page=2'],
      ['PUT', '/named?toArchiveHere&page=2', 'a 307 redirect', '/named?toArchiveHere'],
      ['PUT', '/named?delete&page=2', 'a 302 redirect', '/named?delete&page=2'],
      ['PUT', '/named?update&page=2', 'a 303 redirect', '/named?page=2'],
      ['POST', '/named?go&page=2', 'a rewrite', '/done?page=2'],
      ['POST', '/named?goWithQuery&page=2', 'a rewrite with its own query', '/done'],
    ])('%s %s through %s redirects to %s', async (method, path, through, location) => {
      const response = await createNamedActionApp().fetch(
        new Request('https://app.test' + path, {
          method,
          headers: through === 'middleware' ? { 'x-anon': '1' } : {},
        }),
      );
      expect(response.headers.get('location')).toBe(location);
    });

    it.each([
      ['/named?delete&page=2', 'page=2', 'a redirect', '/named'],
      ['/named?update&tab=a&page=2&q=x', 'page=2&q=x', 'a 303 redirect', '/named?tab=a'],
      ['/named?move&page=2', 'page=2', 'a 307 redirect', '/named-v2?move'],
      ['/named?moveTab&page=2', 'page=2', 'a 307 redirect', '/named-v2?moveTab&tab=details'],
      ['/named?delete&page=2', 'page=2', 'middleware', '/login'],
      ['/named?go&page=2', 'page=2', 'a rewrite', '/done'],
      ['/named?delete&page=2', 'page=3', 'a redirect', '/named?page=2'],
    ])(
      'POST %s that preserves %s through %s redirects to %s',
      async (path, preserved, through, location) => {
        const response = await createNamedActionApp().fetch(
          new Request('https://app.test' + path, {
            method: path.includes('update') ? 'PUT' : 'POST',
            headers: {
              'X-VoidPages-Preserved-Query': preserved,
              ...(through === 'middleware' ? { 'x-anon': '1' } : {}),
            },
          }),
        );
        expect(response.headers.get('location')).toBe(location);
      },
    );

    it('keeps the preserved query in the page URL when the action renders the page again', async () => {
      const response = await createNamedActionApp().fetch(
        new Request('https://app.test/named?save&page=2', {
          method: 'POST',
          headers: {
            'x-voidpages': 'true',
            'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
            'X-VoidPages-Preserved-Query': 'page=2',
          },
        }),
      );
      expect((decodePageData(await response.json()) as { url: string }).url).toBe('/named?page=2');
    });

    it('marks the request for a one-argument middleware that answers first', async () => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(createNamedActionMarker(matchedRoutes));
      app.use('/named', async (c) => c.redirect('/maintenance'));
      app.post('/named', createPageMutationHandler({ ...pageOptions, namedActions: true }));
      const response = await app.fetch(
        new Request('https://app.test/named?delete&page=2', { method: 'POST' }),
      );
      expect(response.headers.get('location')).toBe('/maintenance?page=2');
    });

    it('does not mark preserved page parameters as an action before a middleware redirect', async () => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(createNamedActionMarker(matchedRoutes));
      app.use('/named', async (c) => c.redirect('/login?tab=profile', 307));
      app.post('/named', createPageMutationHandler({ ...pageOptions, namedActions: true }));

      const response = await app.fetch(
        new Request('https://app.test/named?delete=confirm&page=2', {
          method: 'POST',
          headers: { 'X-VoidPages-Preserved-Query': 'delete=confirm&page=2' },
        }),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('/login?tab=profile');
    });

    it.each([
      ['middleware', '/named', 'default'],
      ['middleware', '/named?delete=confirm', 'delete'],
      ['rule', '/named', 'default'],
      ['rule', '/named?delete=confirm', 'delete'],
    ])(
      'a %s rewrite to %s selects %s with a preserved page query',
      async (kind, destination, action) => {
        const app = new Hono();
        const runtime = createRoutingRuntime(app, { nodeTarget: true });
        app.use(runtime.contextMiddleware);
        app.use(createNamedActionMarker(matchedRoutes));
        if (kind === 'middleware') {
          app.use('/source', (c) => (c as RoutingContext).rewrite(destination));
        } else {
          app.use(
            runtime.routingMiddleware([
              { source: '/source', destination, status: 200, force: true },
            ]),
          );
        }
        app.post(
          '/named',
          createPageMutationHandler({
            ...pageOptions,
            namedActions: true,
            load: async () => ({
              actions: {
                default: () => new Response('default'),
                delete: () => new Response('delete'),
              },
            }),
          }),
        );

        const response = await app.fetch(
          new Request('https://app.test/source?delete=confirm', {
            method: 'POST',
            headers: { 'X-VoidPages-Preserved-Query': 'delete=confirm' },
          }),
        );

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(action);
      },
    );

    it('sends the given location when another route answers a catch-all page pattern', async () => {
      const response = await createNamedActionApp('/*').fetch(
        new Request('https://app.test/api/x?return=/a&page=2', { method: 'POST' }),
      );
      expect(response.headers.get('location')).toBe('/done');
    });

    it('sends the given location when a tagged Void route answers before a catch-all page', async () => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(createNamedActionMarker(matchedRoutes));
      app.use(async (c, next) => (c.req.header('x-anon') ? c.redirect('/login') : next()));
      app.all(
        '/api/auth/*',
        markRouteHandler(async () => new Response('auth')),
      );
      app.post('/*', createPageMutationHandler({ ...pageOptions, namedActions: true }));
      const response = await app.fetch(
        new Request('https://app.test/api/auth/callback?code=1&state=2', {
          method: 'POST',
          headers: { 'x-anon': '1' },
        }),
      );
      expect(response.headers.get('location')).toBe('/login');
    });

    it('leaves the key out of the page URL when the action renders the page again', async () => {
      const response = await createNamedActionApp().fetch(
        new Request('https://app.test/named?save&page=2', {
          method: 'POST',
          headers: { 'x-voidpages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
        }),
      );
      expect((decodePageData(await response.json()) as { url: string }).url).toBe('/named?page=2');
    });
  });
  it.each([
    ['middleware', 'GET', '/app/account?tab=1', '/maintenance', '/app/account?tab=1'],
    ['rule', 'GET', '/app/account?tab=1', '/maintenance', '/app/account?tab=1'],
    ['middleware', 'GET', '/app/caf%C3%A9', '/maintenance', '/app/café'],
    ['middleware', 'GET', '/app/account?tab=1', '/maintenance?mode=read', '/app/account?tab=1'],
    ['middleware', 'POST', '/app/account?save&tab=1', '/maintenance', '/app/account?tab=1'],
    ['rule', 'POST', '/app/account?save&tab=1', '/maintenance', '/app/account?tab=1'],
    // The destination's query selects the action; the original query has no key.
    ['middleware', 'POST', '/app/account?tab=1', '/maintenance?save&tab=1', '/app/account?tab=1'],
    ['rule', 'POST', '/app/account?tab=1', '/maintenance?save&tab=1', '/app/account?tab=1'],
  ])(
    'reports the requested URL after a %s rewrite of %s %s to %s',
    async (kind, method, path, destination, url) => {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.contextMiddleware);
      app.use(createNamedActionMarker(matchedRoutes));
      if (kind === 'middleware') {
        app.use('/app/*', (c) => (c as RoutingContext).rewrite(destination));
      } else {
        app.use(
          runtime.routingMiddleware([{ source: '/app/*', destination, status: 200, force: true }]),
        );
      }
      app.get('/maintenance', createPageGetHandler(pageOptions));
      app.post(
        '/maintenance',
        createPageMutationHandler({
          ...pageOptions,
          load: async () => ({ actions: { save: () => undefined } }),
          namedActions: true,
        }),
      );
      const response = await app.fetch(
        new Request('https://app.test' + path, {
          method,
          headers: { 'x-voidpages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
        }),
      );
      expect((decodePageData(await response.json()) as { url: string }).url).toBe(url);
    },
  );
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
      new Request('https://app.test/page', {
        headers: { 'x-voidpages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      }),
    );
    expect((decodePageData(await response.json()) as { props: unknown }).props).toEqual({
      title: 'loaded',
    });
  });
  it('redirects extensionless Pages requests to trailing slashes without changing APIs or files', async () => {
    const app = new Hono();
    const routing = createRoutingRuntime(app, { nodeTarget: true });
    app.notFound(
      createPagesFallback({
        routing,
        errors: createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }),
        trailingSlash: true,
      }),
    );
    app.get('/posts/', (c) => c.text('posts'));
    const response = await app.request('https://app.test/posts?sort=new');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://app.test/posts/?sort=new');
    expect((await app.request('https://app.test/posts/')).status).toBe(200);
    for (const path of ['/api/missing', '/file.css', '/unknown/']) {
      const missing = await app.request('https://app.test' + path);
      expect(missing.status).toBe(404);
      expect(missing.headers.has('location')).toBe(false);
    }
  });
  it.each([
    [{ Accept: 'text/html' }, true],
    [{}, true],
    [{ Accept: 'application/json' }, false],
    [{ Accept: '*/*', 'Sec-Fetch-Dest': 'image' }, false],
    [{ Accept: 'application/json', 'X-VoidPages': 'true' }, true],
  ] as const)(
    'uses the app not-found component only for page requests: %j',
    async (headers, page) => {
      const app = new Hono();
      const routing = createRoutingRuntime(app, { nodeTarget: true });
      app.notFound(
        createPagesFallback({
          routing,
          errors: createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }),
          pageNotFound: async (c) => c.html('<h1>App not found</h1>', 404),
        }),
      );
      const response = await app.request('https://app.test/missing', { headers });
      expect(response.status).toBe(404);
      expect((await response.text()).includes('App not found')).toBe(page);
    },
  );
  it('serves static files before canonicalizing dynamic trailing-slash Pages URLs', async () => {
    const app = new Hono();
    const routing = createRoutingRuntime(app, { nodeTarget: true });
    app.notFound(
      createPagesFallback({
        routing,
        errors: createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }),
        trailingSlash: true,
        pagePatterns: [/^\/(.+)\/$/],
      }),
    );
    const files = new Map([
      ['/assets/app.js', 'text/javascript'],
      ['/favicon.ico', 'image/x-icon'],
      ['/terms.html', 'text/html'],
      ['/terms', 'text/html'],
      ['/LICENSE', 'text/plain'],
      ['/about', 'text/html'],
      ['/about/', 'text/html'],
    ]);
    const env = {
      ASSETS: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === '/terms/') {
            return Response.redirect('https://app.test/terms', 307);
          }
          const type = files.get(path);
          return type
            ? new Response('file', { headers: { 'Content-Type': type } })
            : new Response('missing', { status: 404 });
        },
      },
    };
    for (const path of ['/assets/app.js', '/favicon.ico', '/terms.html', '/terms', '/LICENSE']) {
      const response = await app.fetch(new Request('https://app.test' + path), env);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe('file');
    }
    for (const path of ['/about', '/users/alice.smith']) {
      const response = await app.fetch(new Request('https://app.test' + path + '?q=1'), env);
      expect(response.status, path).toBe(301);
      expect(response.headers.get('location')).toBe('https://app.test' + path + '/?q=1');
    }
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
  it.each([
    [404, 'Not Found'],
    [500, 'Internal Server Error'],
  ] as const)(
    'serves an HTML %s page when custom assets are unavailable',
    async (status, title) => {
      const app = new Hono();
      const errors = createErrorRenderer({ projectRoot: '/project', homeDir: '/home' });
      app.get('/page', (c) => errors.serveCustomPage(c, status, title));
      const response = await app.fetch(new Request('https://app.test/page'), {
        ASSETS: {
          fetch: async () => {
            throw new Error('assets unavailable');
          },
        },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain(String(status));
    },
  );
  it.each([404, 500] as const)('serves a custom %s page unchanged', async (status) => {
    const app = new Hono();
    const errors = createErrorRenderer({ projectRoot: '/project', homeDir: '/home' });
    app.get('/page', (c) => errors.serveCustomPage(c, status, 'Custom error'));
    const body = '<html><body>Custom error page</body></html>';
    const fetch = async (request: Request) =>
      new URL(request.url).pathname === `/${status}.html`
        ? new Response(body)
        : new Response('Not Found', { status: 404 });
    const response = await app.fetch(new Request('https://app.test/page'), { ASSETS: { fetch } });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
  });
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
  it.each(['default', 'custom'] as const)(
    'preserves replacement tokens in the %s error page overlay and captured CSS',
    async (page) => {
      const errors = createErrorRenderer({ dev: true, projectRoot: '/project', homeDir: '/home' });
      const message = "replacement tokens: $& $$ $` $'";
      const escapedMessage = "replacement tokens: $&amp; $$ $` $'";
      const css = '<style data-error-css>body::before { content: "$& $$ $`"; }</style>';
      const error = Object.assign(new Error(message, { cause: new Error(message) }), {
        __voidPageAssetTags: { css },
      });
      error.stack = `Error: ${message}`;
      const app = new Hono();
      app.get('/error', (c) => errors.serveCustomPage(c, 500, 'Internal Server Error', error));
      const response = await app.fetch(new Request('https://app.test/error'), {
        ASSETS: {
          fetch: async () =>
            page === 'custom'
              ? new Response('<!doctype html><html><head></head><body>Custom error</body></html>')
              : new Response('Not Found', { status: 404 }),
        },
      });
      const html = await response.text();
      expect(response.status).toBe(500);
      expect(html).toContain(css);
      expect(html).toContain(`<p class="__void-error-message">${escapedMessage}</p>`);
      expect(html).toContain(`<pre>Error: ${escapedMessage}</pre>`);
      expect(html.match(/<!doctype html>/g)).toHaveLength(1);
      expect(html.match(/data-void-error-overlay role=/g)).toHaveLength(1);
    },
  );
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

  it('shares one manifest fetch between concurrent cold loads', async () => {
    const binding = vi.fn(async () => Response.json({ page: { file: 'page.js' } }));
    const loader = createManifestLoader();
    const env = { ASSETS: { fetch: binding } };
    const request = new Request('https://app.test/page');
    const manifests = await Promise.all(Array.from({ length: 8 }, () => loader(request, env)));
    expect(binding).toHaveBeenCalledTimes(1);
    expect(new Set(manifests).size).toBe(1);
    expect(manifests[0]).toEqual({ page: { file: 'page.js' } });
    expect(await loader(request, env)).toBe(manifests[0]);
    expect(binding).toHaveBeenCalledTimes(1);
  });

  it('retries the manifest after a missing response or a rejected fetch', async () => {
    const manifest = { page: { file: 'page.js' } };
    const binding = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockRejectedValueOnce(new Error('assets unavailable'))
      .mockImplementation(async () => Response.json(manifest));
    const loader = createManifestLoader();
    const env = { ASSETS: { fetch: binding } };
    const request = new Request('https://app.test/page');
    expect(await loader(request, env)).toBeNull();
    expect(binding).toHaveBeenCalledTimes(1);
    const rejected = [loader(request, env), loader(request, env)];
    await expect(rejected[0]).rejects.toThrow('assets unavailable');
    await expect(rejected[1]).rejects.toThrow('assets unavailable');
    expect(binding).toHaveBeenCalledTimes(2);
    expect(await loader(request, env)).toEqual(manifest);
    expect(binding).toHaveBeenCalledTimes(3);
    await loader(request, env);
    expect(binding).toHaveBeenCalledTimes(3);
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

describe('static asset marker', () => {
  const policy = 'public, max-age=0, must-revalidate';
  const env = {
    ASSETS: {
      fetch: async (request: Request) =>
        ['/favicon.ico', '/assets/client-abcdefgh.js'].includes(new URL(request.url).pathname)
          ? new Response('file', { headers: { 'cache-control': policy } })
          : new Response('missing', { status: 404 }),
    },
  };

  function markerApp(
    fallback: (
      routing: ReturnType<typeof createRoutingRuntime>,
    ) => (c: Context) => Promise<Response>,
    nodeTarget = false,
  ) {
    const app = new Hono();
    const routing = createRoutingRuntime(app, { nodeTarget });
    const seen: Array<unknown> = [];
    app.use(routing.contextMiddleware);
    app.use(async (c, next) => {
      await next();
      seen.push((c as Context).get('__voidStaticAsset'));
    });
    app.get('/new', (c) => c.text('fallback rule'));
    app.notFound(fallback(routing));
    return { app, seen };
  }
  const fallbackRules = [{ source: '/old', destination: '/new', status: 200 }];
  const errors = createErrorRenderer({ projectRoot: '/project', homeDir: '/home' });

  it.each([
    [
      'Pages',
      (routing: ReturnType<typeof createRoutingRuntime>) =>
        createPagesFallback({ routing, errors, fallbackRules }),
      ['/missing', '/missing.css', '/old', '/missing/'],
    ],
    [
      'SSR',
      (routing: ReturnType<typeof createRoutingRuntime>) =>
        createSsrFallback({
          routing,
          fallbackRules,
          load: async () => ({ render: async () => new Response('rendered') }),
          assets: async () => ({ css: '', body: '', preloads: '' }),
        }),
      ['/document', '/missing.css', '/old.css'],
    ],
    [
      'asset-only',
      (routing: ReturnType<typeof createRoutingRuntime>) =>
        createAssetNotFound({ routing, fallbackRules }),
      ['/missing', '/old'],
    ],
  ])('marks only ASSETS hits from the %s fallback', async (_label, fallback, unmarked) => {
    const { app, seen } = markerApp(fallback);
    for (const path of ['/favicon.ico', '/assets/client-abcdefgh.js']) {
      const response = await app.fetch(new Request('https://app.test' + path), env);
      expect(response.status).toBe(200);
      expect(seen.pop()).toMatchObject({ policy: response.headers.get('cache-control') });
    }
    for (const path of unmarked) {
      await app.fetch(new Request('https://app.test' + path), env);
      expect(seen.pop(), path).toBeUndefined();
    }
  });

  it('does not mark responses without an ASSETS binding', async () => {
    const { app, seen } = markerApp((routing) => createPagesFallback({ routing, errors }));
    await app.fetch(new Request('https://app.test/favicon.ico'));
    expect(seen.pop()).toBeUndefined();
  });
});

describe('native HTTPS policy', () => {
  it('redirects HTTP before ISR and the app, keeping path, query and method', async () => {
    const handle = vi.fn(async () => new Response('cache'));
    const app = { fetch: vi.fn(async () => new Response('app')) };
    const fetch = worker({ alwaysUseHttps: true, app, isr: { deploymentId: 'd', handle } });
    const response = await fetch(
      new Request('http://oxc.rs/docs?q=1', { method: 'POST' }),
      { ISR_CACHE: {} },
      context,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://oxc.rs/docs?q=1');
    expect(handle).not.toHaveBeenCalled();
    expect(app.fetch).not.toHaveBeenCalled();
    const upgrade = await fetch(
      new Request('http://oxc.rs/chat', { headers: { upgrade: 'websocket' } }),
      {},
      context,
    );
    expect(upgrade.status).toBe(308);
  });

  it.each([
    { name: 'HTTPS', url: 'https://oxc.rs/docs', alwaysUseHttps: true },
    { name: 'the option off', url: 'http://oxc.rs/docs', alwaysUseHttps: false },
    { name: 'the option unset', url: 'http://oxc.rs/docs', alwaysUseHttps: undefined },
    {
      name: 'the prerender runner on localhost',
      url: 'http://localhost/docs',
      alwaysUseHttps: true,
    },
  ])('serves the cached page for $name', async ({ url, alwaysUseHttps }) => {
    const handle = vi.fn(async () => new Response('cache'));
    const fetch = worker({ alwaysUseHttps, isr: { deploymentId: 'd', handle } });
    const response = await fetch(new Request(url), { ISR_CACHE: {} }, context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('cache');
  });

  it('answers Void endpoints for tools and the platform over HTTP', async () => {
    const fetch = worker({
      alwaysUseHttps: true,
      emailReceipt: async () => new Response('receipt', { status: 202 }),
      internalRoute: async (request) =>
        new URL(request.url).pathname === '/__void/migrate' ? new Response('migrated') : null,
    });
    const ready = await fetch(new Request('http://oxc.rs/__void/ready'), {}, context);
    expect(await ready.json()).toEqual({ ready: true });
    const receipt = await fetch(
      new Request('http://oxc.rs/__void/email/receipt/v1', { method: 'POST' }),
      {},
      context,
    );
    expect(receipt.status).toBe(202);
    const migrate = await fetch(
      new Request('http://oxc.rs/__void/migrate', { method: 'POST' }),
      {},
      context,
    );
    expect(await migrate.text()).toBe('migrated');
    const discovery = await fetch(
      new Request('http://oxc.rs/__void/prerender-paths', { method: 'POST' }),
      { __VOID_PRERENDER: '1' },
      context,
    );
    expect(await discovery.json()).toEqual({ paths: ['/page'] });
  });
});

describe('page loaders and actions composed with defineHandler middleware', () => {
  const pageOptions = {
    componentId: 'page',
    render: async (page: { props: unknown; errors: unknown }) =>
      '<html>' + JSON.stringify({ props: page.props, errors: page.errors }) + '</html>',
    assets: async () => ({ css: '', body: '', preloads: '' }),
    headConfig: undefined,
    renderOptions: { renderMode: 'server' as const },
  };
  const schema = (message?: string): StandardSchemaV1 => ({
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) =>
        message ? { issues: [{ message, path: ['title'] }] } : { value },
    },
  });
  const passThrough = defineMiddleware(async (_c, next) => {
    await next();
  });
  type PageJson = { props: Record<string, unknown>; errors: unknown; shared: unknown };

  function createPageApp(mod: Record<string, unknown>, appMiddleware?: MiddlewareHandler) {
    const app = new Hono();
    const runtime = createRoutingRuntime(app, { nodeTarget: true });
    app.use(runtime.contextMiddleware);
    if (appMiddleware) {
      app.use(appMiddleware);
    }
    const load = async () => mod;
    app.get('/db', createPageGetHandler({ ...pageOptions, load }));
    app.post('/db', createPageMutationHandler({ ...pageOptions, load, namedActions: true }));
    return app;
  }
  const get = (
    app: Hono,
    headers: Record<string, string> = {
      'X-VoidPages': 'true',
      'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
    },
  ) => app.fetch(new Request('https://app.test/db', { headers }));
  const post = (app: Hono, body: unknown, pages = true) =>
    app.fetch(
      new Request('https://app.test/db?create', {
        method: 'POST',
        headers: {
          ...(pages && { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }),
          Origin: 'https://app.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );

  it('renders the page from a loader with middleware', async () => {
    const app = createPageApp({ loader: defineHandler(passThrough, () => ({ notes: ['a'] })) });
    const json = await get(app);
    expect(json.status).toBe(200);
    expect((decodePageData(await json.json()) as PageJson).props).toEqual({ notes: ['a'] });
    const html = await get(app, {});
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('{"notes":["a"]}');
  });

  it('re-renders the page after an action with middleware, or shows its field errors', async () => {
    const action = (message?: string) =>
      defineHandler(
        passThrough,
        defineHandler.withValidator({ body: schema(message) })(async () => {}),
      );
    const loader = defineHandler(passThrough, () => ({ notes: ['fresh'] }));
    const valid = await post(createPageApp({ loader, actions: { create: action() } }), {
      title: 'a',
    });
    expect(valid.status).toBe(200);
    expect(decodePageData(await valid.json())).toMatchObject({
      props: { notes: ['fresh'] },
      errors: null,
    });
    const invalid = await post(createPageApp({ loader, actions: { create: action('Required') } }), {
      title: '',
    });
    expect(invalid.status).toBe(200);
    expect(decodePageData(await invalid.json())).toMatchObject({
      props: { notes: ['fresh'] },
      errors: { title: 'Required' },
    });
    // A form posted without JavaScript gets the rendered page too.
    const form = await post(
      createPageApp({ loader, actions: { create: action('Required') } }),
      {},
      false,
    );
    expect(form.headers.get('Content-Type')).toContain('text/html');
    expect(await form.text()).toContain('"errors":{"title":"Required"}');
  });

  it('streams deferred props through loader middleware', async () => {
    const after = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set('X-After', '1');
    });
    const app = createPageApp({
      loader: defineHandler(after, () => ({ a: 1, slow: defer(async () => 2) })),
    });
    const json = await get(app);
    expect(json.headers.get('X-After')).toBe('1');
    expect(await json.text()).toContain(serializePageData({ __deferred: 'slow', data: 2 }));
    const html = await get(app, {});
    expect(html.headers.get('X-After')).toBe('1');
    expect(await html.text()).toContain('__resolveDeferred');
  });

  it('lets etag() middleware tag each rendered page form', async () => {
    const app = createPageApp({ loader: defineHandler(etag(), () => ({ v: 'stable' })) });
    const json = (await get(app)).headers.get('ETag')!;
    const html = (await get(app, {})).headers.get('ETag')!;
    expect(json).not.toBe(html);
    expect(
      (
        await get(app, {
          'X-VoidPages': 'true',
          'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
          'If-None-Match': json,
        })
      ).status,
    ).toBe(304);
    expect((await get(app, { 'If-None-Match': html })).status).toBe(304);
  });

  it('runs middleware around the rendered page response', async () => {
    const shared = defineMiddleware(async (c, next) => {
      c.header('X-Before', '1');
      c.set('shared', { user: 'u1' });
      await next();
      c.res.headers.set('X-After', '1');
    });
    const app = createPageApp({
      loader: defineHandler(shared, () => ({ ok: true })),
      actions: { create: defineHandler(shared, async () => {}) },
    });
    for (const response of [await get(app), await post(app, {})]) {
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Before')).toBe('1');
      expect(response.headers.get('X-After')).toBe('1');
      expect((decodePageData(await response.json()) as PageJson).shared).toEqual({ user: 'u1' });
    }
  });

  it('lets a loader or action update shared data set by app middleware', async () => {
    // Like middleware/01.shared.ts: app middleware runs before the page handler.
    const count = (n: number) => ({ count: n });
    const appShared: MiddlewareHandler = async (c, next) => {
      c.set('shared', count(2));
      await next();
    };
    const sharedOf = async (response: Response) =>
      (decodePageData(await response.json()) as PageJson).shared;
    const setCount = (n: number) => (c: CloudContext) => {
      c.set('shared', { ...(c.get('shared') as object), ...count(n) });
    };
    const assignCount = (n: number) => (c: CloudContext) => {
      Object.assign(c.get('shared') as object, count(n));
    };
    const loader = () => ({});

    // The loader runs last, so its update is what the page gets.
    for (const update of [setCount(77), assignCount(77)]) {
      const app = createPageApp(
        {
          loader: defineHandler(passThrough, (c) => (update(c), {})),
          actions: { create: defineHandler(async () => {}) },
        },
        appShared,
      );
      expect(await sharedOf(await get(app))).toEqual(count(77));
      expect(await sharedOf(await post(app, {}))).toEqual(count(77));
    }

    // The action's update reaches the page and the loader that runs after it.
    for (const update of [setCount(99), assignCount(99)]) {
      let loaderSaw: unknown;
      const app = createPageApp(
        {
          loader: (c: CloudContext) => ((loaderSaw = c.get('shared')), {}),
          actions: { create: defineHandler(passThrough, async (c) => update(c)) },
        },
        appShared,
      );
      expect(await sharedOf(await post(app, {}))).toEqual(count(99));
      expect(loaderSaw).toEqual(count(99));
    }

    // Middleware ran before the action, so an action that leaves shared alone keeps its value.
    const untouched = createPageApp(
      { loader, actions: { create: defineHandler(async () => {}) } },
      appShared,
    );
    expect(await sharedOf(await post(untouched, {}))).toEqual(count(2));
  });

  it('keeps edits outer middleware makes after an inner middleware answers', async () => {
    const outer = defineMiddleware(async (c, next) => {
      await next();
      c.res = new Response('outer:' + (await c.res.text()), c.res);
    });
    const deny = defineMiddleware(async () => new Response('denied', { status: 401 }));
    const app = createPageApp({
      loader: defineHandler(outer, deny, () => ({})),
      actions: { create: defineHandler(passThrough, async () => {}) },
    });
    for (const response of [await get(app), await post(app, {})]) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('outer:denied');
    }
  });

  it('turns a ValidationError from action middleware into field errors, once', async () => {
    const check = defineMiddleware(async () => {
      throw new ValidationError({ title: 'Taken' });
    });
    const loader = vi.fn(() => ({ ok: true }));
    const errors = await post(
      createPageApp({ loader, actions: { create: defineHandler(check, async () => {}) } }),
      {},
    );
    expect(errors.status).toBe(200);
    expect(decodePageData(await errors.json())).toMatchObject({ errors: { title: 'Taken' } });

    // A ValidationError from the loader while re-rendering is not the action's.
    const failing = vi.fn(() => {
      throw new ValidationError({ title: 'loader' });
    });
    const app = createPageApp({
      loader: failing,
      actions: { create: defineHandler(passThrough, async () => {}) },
    });
    app.onError(() => new Response('failed', { status: 500 }));
    expect((await post(app, {})).status).toBe(500);
    expect(failing).toHaveBeenCalledTimes(1);

    // Once the action's response exists, a later ValidationError is an error.
    const late = defineMiddleware(async (_c, next) => {
      await next();
      throw new ValidationError({ title: 'late' });
    });
    const lateApp = createPageApp({
      loader,
      actions: { create: defineHandler(late, async () => {}) },
    });
    lateApp.onError(() => new Response('failed', { status: 500 }));
    expect((await post(lateApp, {})).status).toBe(500);
  });
});
