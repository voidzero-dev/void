import { compilePattern as sharedCompilePattern, matchPatternCaptures } from '@void/edge';
/* oxlint-disable typescript-eslint/no-explicit-any -- these tests wire the void context augmentations by hand (`c.rewrite`, `c.originalUrl`, `c.isRewritten`) to exercise generated code paths directly; `as any` is the least noisy way to assign/read those members without re-declaring the full Hono context shape per test. */
import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { resolveImageConfig } from '../../src/image-config.ts';
import {
  compileRouteTable,
  compileWorkerEntry,
  compileNodeApp,
  compileNodeServer,
  type CompileOptions,
} from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';
import { VoidAssetRewriteError } from '../../src/runtime/handler.ts';
import {
  createRoutingRuntime,
  createHttpRouteHandler,
  createModuleLoader,
  createErrorRenderer,
  createPagesFallback,
  createPageGetHandler,
  createPageMutationHandler,
  createAssetFallback,
  createClientAssetTags,
  createManifestLoader,
  createSsrFallback,
  createAssetNotFound,
  type RoutingRuntime,
} from '../../src/runtime/routing.ts';

const testOptions = {
  honoPath: '/resolved/hono/index.mjs',

  runtimeEnvPath: '/resolved/void/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  webSocketRuntimePath: '/resolved/void/runtime/ws-server.mjs',
  reactRefresh: true,
  auth: null,
};

const emptyScan: ScanResult = {
  routes: [],
  middleware: [],
  jobs: [],
  queues: [],
  pages: { pages: [], layouts: [], namedLayouts: [] },
};

function compile(options: Partial<CompileOptions> = {}, scan: ScanResult = emptyScan): string {
  return compileRouteTable(scan, '/routes', '/middleware', '/crons', '/queues', null, {
    ...testOptions,
    ...options,
  });
}

describe('compileRouteTable', () => {
  it('matches every expression of a multi-cron job', () => {
    const code = compile(
      {},
      {
        ...emptyScan,
        jobs: [{ filePath: 'multi.ts', name: 'multi', crons: ['0 * * * *', '30 * * * *'] }],
      },
    );

    expect(code).toContain('const job0Crons = ["0 * * * *","30 * * * *"]');
    expect(code).toContain('job0Crons.includes(controller.cron)');
    expect(code).toContain('import("/crons/multi.ts")');
  });

  it('handles empty scan result', () => {
    const code = compile();

    expect(code).toContain('const app = new Hono()');
    expect(code).toContain('export async function scheduled() {}');
    expect(code).toContain('export default app');
  });

  it('does not import runtime env helpers for node targets', () => {
    const code = compile({ nodeTarget: true });

    expect(code).not.toContain('getRuntimeEnv');
    expect(code).not.toContain(`import { withRuntimeEnv }`);
    expect(code).toContain('const withRuntimeEnv = (_env, fn) => fn();');
  });

  it('adds SSR fallback handler when ssr entry is provided', () => {
    const code = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      {
        serverEntryPath: '/src/main.ssr.ts',
        clientEntryRelativePath: 'src/main.client.tsx',
      },
      testOptions,
    );

    expect(code).toContain('app.notFound(__createSsrFallback(');
    expect(code).toContain('load: () => import("/src/main.ssr.ts")');
    expect(code).toContain('"entryId":"src/main.client.tsx"');
    expect(code).toContain('"reactRefresh":true');
  });

  it('omits /__void/queue route when no queues defined', () => {
    expect(compile()).not.toContain('/__void/queue');
  });

  it('exports __VOID_BUILD_KEY as a unique UUID for build-time auth', () => {
    const scan: ScanResult = {
      ...emptyScan,
      jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
    };

    const code1 = compile({}, scan);
    const code2 = compile({}, scan);

    expect(code1).toContain('export const __VOID_BUILD_KEY =');
    const match1 = code1.match(/__VOID_BUILD_KEY = "([^"]+)"/);
    const match2 = code2.match(/__VOID_BUILD_KEY = "([^"]+)"/);
    expect(match1).toBeTruthy();
    expect(match2).toBeTruthy();
    expect(match1![1]).not.toBe(match2![1]);
  });

  it('generates websocket durable object exports and proxy routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/chat/:room',
          methods: ['GET'],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ts',
        },
      ],
      websockets: [
        {
          pattern: '/chat/:room',
          methods: [],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: 'room',
          hasAuthGate: true,
        },
      ],
      middleware: [{ order: 1, filePath: '01.auth.ts' }],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const code = compile({}, scan);

    expect(code).toContain('import websocket0 from "/routes/chat/[room].ws.ts"');
    expect(code).toContain('createWebSocketDurableObject');
    expect(code).toContain('export const ChatRoomWs = __createWebSocketDurableObject');
    expect(code).toContain('const __voidWebSocketRoutes = [{"pattern":"/chat/:room"');
    expect(code).toContain('app.all("/chat/:room"');
    expect(code).toContain(
      'if (c.req.raw.headers.get("upgrade")?.toLowerCase() !== "websocket") return next()',
    );
    expect(code).toContain('__forwardWebSocketRequest');
    expect(code.indexOf('app.use(middleware0)')).toBeLessThan(
      code.indexOf('app.all("/chat/:room"'),
    );
    const fallback = 'app.all("/chat/:room", (c) => __forwardWebSocketRequest';
    expect(code.indexOf('app.get("/chat/:room"')).toBeGreaterThan(
      code.indexOf('app.all("/chat/:room"'),
    );
    expect(code.indexOf(fallback)).toBeGreaterThan(code.indexOf('app.get("/chat/:room"'));

    scan.pages.pages = [
      {
        pattern: '/chat/:room',
        params: ['room'],
        catchAll: false,
        componentPath: 'chat/[room].vue',
        componentId: 'chat/[room]',
        serverPath: null,
        methods: [],
        ssrMode: 'server',
        prerenderMode: 'disabled',
        renderMode: 'server',
        shouldPrerender: false,
      },
    ];
    const withPages = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      { pagesDir: '/pages', pagesDirRelative: 'pages', clientEntryId: 'virtual:void-pages-client' },
    );
    expect(withPages.indexOf(fallback)).toBeGreaterThan(
      withPages.indexOf('app.get("/chat/:room", __createPageGetHandler'),
    );
    expect(withPages.indexOf(fallback)).toBeLessThan(
      withPages.indexOf('app.notFound(__createPagesFallback'),
    );
  });

  it('exports tombstones for removed websocket Durable Object classes', () => {
    const code = compile({ webSocketTombstones: ['RemovedChatWs'] });

    expect(code).toContain('createWebSocketTombstoneDurableObject');
    expect(code).toContain(
      'export const RemovedChatWs = __createWebSocketTombstoneDurableObject("RemovedChatWs")',
    );
    expect(compileWorkerEntry({ webSocketClasses: ['RemovedChatWs'] })).toContain(
      'export { RemovedChatWs };',
    );
  });

  it('generates the shared live durable object export when live is enabled', () => {
    const code = compile({
      hasLive: true,
      liveRuntimePath: '/resolved/void/runtime/live-server.mjs',
    });

    expect(code).toContain('createLiveDurableObject');
    expect(code).toContain(
      'export const VoidLiveStreamDurableObject = __createLiveDurableObject();',
    );
  });
});

/** Evaluate a compiled route table with its imports supplied and return its Hono app. */
function evalCompiledApp(code: string): Hono {
  // Drop imports, the node-target `withRuntimeEnv` const and `export` keywords so
  // the module body runs inside `new Function`; a noop `withRuntimeEnv` replaces both forms.
  const stripped = code
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, '')
    .replace(/^const\s+withRuntimeEnv\s+=.*$/gm, '')
    .replace(/^export\s+default\s+app;?\s*$/gm, '')
    .replace(/^export\s+(const|async\s+function|function)\s+/gm, '$1 ')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

  const factory = new Function(
    'Hono',
    'AsyncLocalStorage',
    '__createRoutingRuntime',
    '__createHttpRouteHandler',
    '__createModuleLoader',
    '__createErrorRenderer',
    '__createPagesFallback',
    '__createPageGetHandler',
    '__createPageMutationHandler',
    '__createClientAssetTags',
    '__createManifestLoader',
    '__createSsrFallback',
    '__createAssetNotFound',
    ['const withRuntimeEnv = (_e, fn) => fn();', stripped, 'return app;'].join('\n'),
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vitest runs in node; node:async_hooks is built-in.
  const { AsyncLocalStorage } = require('node:async_hooks');
  return factory(
    Hono,
    AsyncLocalStorage,
    createRoutingRuntime,
    createHttpRouteHandler,
    createModuleLoader,
    createErrorRenderer,
    createPagesFallback,
    createPageGetHandler,
    createPageMutationHandler,
    createClientAssetTags,
    createManifestLoader,
    createSsrFallback,
    createAssetNotFound,
  ) as Hono;
}

const runtimeByApp = new WeakMap<Hono, RoutingRuntime>();
function installVoidWrappers(app: Hono): void {
  const runtime = createRoutingRuntime(app, { nodeTarget: true, managedDispatch: true });
  runtimeByApp.set(app, runtime);
  app.use(runtime.contextMiddleware);
}

describe('c.redirect runtime wrapper', () => {
  it.each([
    ['/new', '/new?x=1&y=2'],
    // A protocol-relative location is cross-origin, so the request query must not leak to it.
    ['//partner.example.com/landing', '//partner.example.com/landing'],
  ])('redirects to %s with Location %s', async (destination, location) => {
    const app = new Hono();
    installVoidWrappers(app);
    app.get('/old', (c) => c.redirect(destination, 302));

    const res = await app.fetch(new Request('http://localhost/old?x=1&y=2'));

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(location);
  });
});

function installRoutingRulesMiddleware(
  app: Hono,
  rules: Array<{ source: string; destination: string; status: number; force?: boolean }>,
): void {
  const runtime = runtimeByApp.get(app) ?? createRoutingRuntime(app, { nodeTarget: true });
  app.use('*', runtime.routingMiddleware(rules));
}

/** Calls `c.rewrite(destination)` from a handler and returns what it threw. */
async function rewriteError(destination: string): Promise<unknown> {
  const app = new Hono();
  installVoidWrappers(app);

  let caught: unknown;
  app.get('/from', (c) => {
    try {
      (c as any).rewrite(destination);
    } catch (err) {
      caught = err;
    }
    return c.text('handled', 200);
  });

  const res = await app.fetch(new Request('http://localhost/from'));
  expect(res.status).toBe(200);
  return caught;
}

describe('c.rewrite runtime wrapper', () => {
  it('re-dispatches to the rewritten path and exposes c.originalUrl / c.isRewritten', async () => {
    const app = new Hono();
    installVoidWrappers(app);

    app.get('/external', (c) => (c as any).rewrite('/internal'));
    app.get('/internal', (c) => {
      return new Response('internal-body', {
        headers: {
          'X-Handler': 'internal',
          'X-Original-Url': (c as any).originalUrl()?.href ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    const res = await app.fetch(new Request('http://localhost/external?keep=1'));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('internal-body');
    expect(res.headers.get('X-Handler')).toBe('internal');
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/external?keep=1');
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('c.isRewritten() is true when dispatch sets X-Void-Original-URL (platform edge rewrite)', async () => {
    const app = new Hono();
    installVoidWrappers(app);

    app.get('/en/docs', (c) => {
      return new Response('docs-body', {
        headers: {
          'X-Original-Url': (c as any).originalUrl()?.href ?? '',
          'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0',
        },
      });
    });

    const dispatchForwarded = new Request('http://localhost/en/docs', {
      headers: { 'X-Void-Original-URL': 'http://localhost/docs' },
    });
    const res = await app.fetch(dispatchForwarded);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('docs-body');
    expect(res.headers.get('X-Original-Url')).toBe('http://localhost/docs');
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('single-hop loop guard: re-dispatched request skips the static rule table', async () => {
    const app = new Hono();
    let ruleMatches = 0;

    installVoidWrappers(app);
    app.use('*', async (c, next) => {
      if (!(c as any).isRewritten()) {
        ruleMatches++;
      }
      await next();
    });
    installRoutingRulesMiddleware(app, [
      { source: '/a', destination: '/a', status: 200, force: true },
    ]);

    app.get('/a', (c) => {
      return new Response('handler-a', {
        headers: { 'X-Is-Rewritten': (c as any).isRewritten() ? '1' : '0' },
      });
    });

    const res = await app.fetch(new Request('http://localhost/a'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('handler-a');
    expect(ruleMatches).toBe(1);
    expect(res.headers.get('X-Is-Rewritten')).toBe('1');
  });

  it('rewrite vs fallback interaction: force-rewrite (always) wins over fallback (post-asset)', async () => {
    const { splitRedirectRulesByForce } = await import('../../src/cli/headers.ts');
    const allRules = [
      {
        source: '/docs/*',
        destination: '/fallback.html',
        status: 200,
        force: false,
        origin: 'void.json#routing.fallbacks',
      },
      {
        source: '/docs/*',
        destination: '/rewrite-target',
        status: 200,
        force: true,
        origin: 'void.json#routing.rewrites',
      },
    ];
    const { always: preAsset, fallbacks: postAsset } = splitRedirectRulesByForce(allRules);

    const app = new Hono();
    installVoidWrappers(app);
    installRoutingRulesMiddleware(app, preAsset);

    let fallbackFired = false;
    app.notFound(async (c) => {
      fallbackFired = true;
      return (
        (await runtimeByApp.get(app)!.applyFallback(c, postAsset)) ?? new Response('fallback-hit')
      );
    });

    app.get('/rewrite-target', (c) => c.text('rewrite-target', 200));

    const res = await app.fetch(new Request('http://localhost/docs/intro'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('rewrite-target');
    expect(fallbackFired).toBe(false);
  });

  it('middleware runs twice on c.rewrite, with c.isRewritten() flipping false → true', async () => {
    const app = new Hono();
    installVoidWrappers(app);

    let invocations = 0;
    const observed: Array<boolean> = [];
    app.use('*', async (c, next) => {
      invocations++;
      observed.push((c as any).isRewritten());
      await next();
    });

    app.get('/from', (c) => (c as any).rewrite('/to'));
    app.get('/to', (c) => c.text('to-handler', 200));

    const res = await app.fetch(new Request('http://localhost/from'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('to-handler');
    expect(invocations).toBe(2);
    expect(observed).toEqual([false, true]);
  });

  it('middleware runs twice when a post-asset fallback rewrite re-dispatches', async () => {
    const app = new Hono();
    installVoidWrappers(app);

    let invocations = 0;
    const observedReqUrls: Array<string> = [];
    const observedOriginalUrls: Array<URL | null> = [];
    app.use('*', async (c, next) => {
      invocations++;
      observedReqUrls.push(c.req.url);
      observedOriginalUrls.push((c as any).originalUrl());
      await next();
    });

    const fallbackRules = [{ source: '/missing/*', destination: '/spa-shell', status: 200 }];
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ?? c.text('not-found', 404),
    );

    app.get('/spa-shell', (c) => c.text('shell-body', 200));

    const res = await app.fetch(new Request('http://localhost/missing/deep'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('shell-body');

    expect(invocations).toBe(2);
    expect(observedReqUrls[0]).toBe('http://localhost/missing/deep');
    expect(observedOriginalUrls[0]).toBeNull();
    expect(observedReqUrls[1]).toBe('http://localhost/spa-shell');
    expect(observedOriginalUrls[1]?.href).toBe('http://localhost/missing/deep');
  });

  it('c.rewrite() target reaches fallbackRules when no route matches', async () => {
    const app = new Hono();
    installVoidWrappers(app);

    app.use('*', async (c, next) => {
      if (new URL(c.req.url).pathname === '/trigger') {
        return (c as any).rewrite('/missing');
      }
      await next();
    });

    const fallbackRules = [{ source: '/missing', destination: '/index', status: 200 }];
    app.notFound(
      async (c) =>
        (await runtimeByApp.get(app)!.applyFallback(c, fallbackRules)) ?? c.text('not-found', 404),
    );

    app.get('/index', (c) => c.text('index-body', 200));

    const res = await app.fetch(new Request('http://localhost/trigger'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('index-body');
  });

  // Setting `URL.pathname` to a value with `?` or `#` would percent-encode it,
  // so the destination is split: the query is kept and the fragment dropped.
  it.each([
    ['/page?x=1', '', '/page', '?x=1'],
    ['/page', '?x=1&y=2', '/page', '?x=1&y=2'],
    ['/page?b=2', '?a=1', '/page', '?b=2'],
    ['/foo#frag', '', '/foo', ''],
    ['/foo?x=1#frag', '', '/foo', '?x=1'],
    ['/foo#frag?x=1', '', '/foo', ''],
  ])(
    'c.rewrite(%j) from a request with query %j lands on %s with search %j',
    async (destination, incomingQuery, pathname, search) => {
      const app = new Hono();
      installVoidWrappers(app);

      app.get('/from', (c) => (c as any).rewrite(destination));
      app.get(pathname, (c) => {
        const u = new URL(c.req.url);
        return new Response('ok', {
          headers: {
            'X-Req-Path': u.pathname,
            'X-Req-Search': u.search,
            'X-Req-Hash': u.hash,
          },
        });
      });

      const res = await app.fetch(new Request(`http://localhost/from${incomingQuery}`));
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Req-Path')).toBe(pathname);
      expect(res.headers.get('X-Req-Search')).toBe(search);
      expect(res.headers.get('X-Req-Hash')).toBe('');
    },
  );

  it.each([
    ['external URL', 'http://evil.com'],
    ['protocol-relative', '//evil.com/path'],
  ])('c.rewrite rejects %s destinations with a clear error', async (_label, destination) => {
    const caught = await rewriteError(destination);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('path-absolute');
    expect((caught as Error).message).toContain('protocol-relative');
    expect((caught as Error).message).toContain('use fetch()');
  });

  it.each(['/hero.png', '/hero.PNG', '/api/users.json', '/hero.png?v=2'])(
    'c.rewrite to static asset path %s throws VoidAssetRewriteError',
    async (destination) => {
      const caught = await rewriteError(destination);

      expect(caught).toBeInstanceOf(VoidAssetRewriteError);
      expect((caught as Error).name).toBe('VoidAssetRewriteError');
      expect((caught as Error).message).toContain(destination);
      expect((caught as Error).message).toContain('routing.rewrites');
      expect((caught as Error).message).toContain(
        'https://void.dev/guide/edge/rewrites#runtime-rewrites-cannot-reach-static-assets',
      );
    },
  );

  // `.html` may be a real route, so it is not treated as a static asset.
  it.each(['/about.html', '/users/123'])(
    'c.rewrite to %s re-dispatches without throwing',
    async (destination) => {
      const app = new Hono();
      installVoidWrappers(app);
      app.get('/from', (c) => (c as any).rewrite(destination));
      app.get(destination, (c) => c.text('target', 200));

      const res = await app.fetch(new Request('http://localhost/from'));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('target');
    },
  );
});

describe('default-target dev parity', () => {
  const redirectRules = [
    {
      source: '/old',
      destination: '/new',
      status: 301,
      origin: 'void.json#routing.redirects',
    },
    {
      source: '/rewrite',
      destination: '/new',
      status: 200,
      force: true,
      origin: 'void.json#routing.rewrites',
    },
  ];
  const headerRules = [{ pattern: '/*', headers: [['x-test', '1']] as Array<[string, string]> }];
  const fallbackRules = [
    {
      source: '/docs/*',
      destination: '/docs.html',
      status: 200,
      force: false,
      origin: 'void.json#routing.fallbacks',
    },
  ];

  const compileWithRules = (options: Partial<CompileOptions>) =>
    compile({ redirectRules, headerRules, fallbackRules, ...options });

  it('applies header rules to immutable responses in local dev', async () => {
    const code = compileWithRules({ nodeTarget: false, dev: true });
    const app = evalCompiledApp(code);

    app.get('/redirect', () => Response.redirect('https://example.com/next', 302));

    const stubCtx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };
    const res = await app.fetch(
      new Request('http://localhost/redirect'),
      {},
      stubCtx as unknown as ExecutionContext,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/next');
    expect(res.headers.get('x-test')).toBe('1');
  });

  it('runs native Cloudflare prod rewrites, headers, and post-asset fallbacks', async () => {
    const code = compileWithRules({ nodeTarget: false, dev: false, managedDispatch: false });
    const app = evalCompiledApp(code);
    app.get('/new', (c: any) =>
      c.text(c.originalUrl()?.pathname === '/rewrite' ? 'rewritten' : 'new'),
    );
    app.get('/docs.html', (c) => c.text('fallback'));

    const env = {
      ASSETS: { fetch: async () => new Response('missing', { status: 404 }) },
    };
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;

    const rewrite = await app.fetch(new Request('http://localhost/rewrite'), env, ctx);
    expect(await rewrite.text()).toBe('rewritten');
    expect(rewrite.headers.get('x-test')).toBe('1');

    const fallback = await app.fetch(new Request('http://localhost/docs/guide'), env, ctx);
    expect(await fallback.text()).toBe('fallback');
    expect(fallback.headers.get('x-test')).toBe('1');
  });

  it('applies native Cloudflare prod headers to assets without fallback rules', async () => {
    const code = compile({ nodeTarget: false, dev: false, managedDispatch: false, headerRules });
    const app = evalCompiledApp(code);
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request('http://localhost/logo.svg'),
      { ASSETS: { fetch: async () => new Response('asset') } },
      ctx,
    );

    expect(await res.text()).toBe('asset');
    expect(res.headers.get('x-test')).toBe('1');
    expect(code).not.toContain('const __fallbackRules =');
  });

  it('omits redirect + header + fallback middleware from managed bundles', () => {
    const code = compileWithRules({ nodeTarget: false, dev: false, managedDispatch: true });
    expect(code).not.toContain('const __routingRules =');
    expect(code).not.toContain('const __headerRules =');
    expect(code).not.toContain('const __fallbackRules =');
  });

  // Only managed dispatch strips client-supplied X-Void-Original-URL on ingress;
  // every other target must not let clients spoof rewrite metadata.
  it('reads inbound X-Void-Original-URL only behind managed dispatch', async () => {
    type Permutation = {
      readonly label: string;
      readonly opts: { nodeTarget: boolean; dev: boolean; managedDispatch?: boolean };
      readonly trustsHeader: boolean;
    };
    const permutations: Array<Permutation> = [
      {
        label: 'managedCfProd',
        opts: { nodeTarget: false, dev: false, managedDispatch: true },
        trustsHeader: true,
      },
      { label: 'nativeCfProd', opts: { nodeTarget: false, dev: false }, trustsHeader: false },
      {
        label: 'cfDev',
        opts: { nodeTarget: false, dev: true, managedDispatch: true },
        trustsHeader: false,
      },
      {
        label: 'nodeProd',
        opts: { nodeTarget: true, dev: false, managedDispatch: true },
        trustsHeader: false,
      },
      { label: 'nodeDev', opts: { nodeTarget: true, dev: true }, trustsHeader: false },
    ];

    for (const { label, opts, trustsHeader } of permutations) {
      const code = compileWithRules(opts);
      const app = evalCompiledApp(code);

      // Registered after eval so the compiled context middleware runs first.
      app.get('/probe', (c: any) => {
        const orig = c.originalUrl();
        return new Response('probe', {
          headers: {
            'X-Original-Url': orig?.href ?? '',
            'X-Is-Rewritten': c.isRewritten() ? '1' : '0',
          },
        });
      });

      // Non-node targets read c.executionCtx, which Hono throws on without a ctx.
      const stubCtx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      };
      const res = await app.fetch(
        new Request('http://localhost/probe', {
          headers: { 'X-Void-Original-URL': 'http://localhost/spoof' },
        }),
        {},
        stubCtx as unknown as ExecutionContext,
      );

      expect(res.status, `${label}: probe should return 200`).toBe(200);
      if (trustsHeader) {
        expect(res.headers.get('X-Original-Url'), `${label}: should trust header`).toBe(
          'http://localhost/spoof',
        );
        expect(res.headers.get('X-Is-Rewritten'), `${label}: should report rewritten`).toBe('1');
      } else {
        expect(res.headers.get('X-Original-Url'), `${label}: must NOT trust header`).toBe('');
        expect(res.headers.get('X-Is-Rewritten'), `${label}: must NOT report rewritten`).toBe('0');
      }
    }
  });

  it('wraps SSR notFound with assets-first-then-fallback on default target dev', () => {
    const ssrOptions = {
      serverEntryPath: '/project/src/main.ssr.ts',
      clientEntryRelativePath: 'src/main.client.ts',
    };
    const code = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      ssrOptions,
      {
        ...testOptions,
        nodeTarget: false,
        dev: true,
        fallbackRules,
      },
    );
    expect(code).toContain('app.notFound(__createSsrFallback(');
    expect(code).toContain('nodeTarget: false');
    expect(code).toContain('"source":"/docs/*"');
  });

  it('leaves SSR notFound unchanged on node target (plain fetchFromAssets return)', () => {
    const ssrOptions = {
      serverEntryPath: '/project/src/main.ssr.ts',
      clientEntryRelativePath: 'src/main.client.ts',
    };
    const code = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      ssrOptions,
      {
        ...testOptions,
        nodeTarget: true,
        dev: true,
        fallbackRules,
      },
    );
    expect(code).toContain('app.notFound(__createSsrFallback(');
    expect(code).toContain('nodeTarget: true');
    expect(code).toContain('"source":"/docs/*"');
  });
});

describe('compileWorkerEntry', () => {
  it('passes the version metadata binding name to the worker fetch', () => {
    expect(compileWorkerEntry({ versionMetadataBinding: 'AUTHORED_VERSION' })).toContain(
      'versionMetadataBinding: "AUTHORED_VERSION"',
    );
  });

  it('re-exports typed Durable Object modules as worker classes', () => {
    const code = compileWorkerEntry({
      durableObjects: [
        {
          bindingName: 'COUNTER',
          className: 'CounterDurableObject',
          filePath: '/app/durable-objects/counter.ts',
        },
      ],
    });

    expect(code).toContain('import __voidDurableObject0 from "/app/durable-objects/counter.ts";');
    expect(code).toContain('__voidDurableObject0.__bind("COUNTER");');
    expect(code).toContain('export const CounterDurableObject = __voidDurableObject0.class;');
  });

  it('re-exports the live Durable Object class when enabled', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: true,
    });

    expect(code).toContain('VoidLiveStreamDurableObject');
    expect(code).toContain('export { VoidLiveStreamDurableObject };');
    expect(code).toContain('__setLiveBindingName("VOID_LIVE");');
  });

  it('re-exports the configured live Durable Object class', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: {
        bindingName: 'VOID_LIVE_abcd1234',
        className: 'VoidLiveStreamDurableObject_abcd1234',
      },
    });

    expect(code).toContain(
      'export { VoidLiveStreamDurableObject as VoidLiveStreamDurableObject_abcd1234 };',
    );
    expect(code).toContain('__setLiveBindingName("VOID_LIVE_abcd1234");');
  });

  it('turns on live dev error messages only in the dev entry', () => {
    const options = {
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      live: true,
    };

    const devCode = compileWorkerEntry({ ...options, dev: true });
    expect(devCode).toContain('import { __setLiveBindingName, __setLiveDev } from "void/live";');
    expect(devCode).toContain('__setLiveDev(true);');

    const prodCode = compileWorkerEntry(options);
    expect(prodCode).toContain('__setLiveBindingName("VOID_LIVE");');
    expect(prodCode).not.toContain('__setLiveDev');
    expect(compileWorkerEntry({ ...options, dev: false })).not.toContain('__setLiveDev');
    expect(compileWorkerEntry({ ...options, live: false, dev: true })).not.toContain(
      '__setLiveDev',
    );
  });

  it('re-exports the VoidPlatformSandbox Durable Object class when enabled', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: true,
    });

    // VoidPlatformSandbox carries the metering/gate hooks, so user subclasses inherit them.
    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "void/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export { __VoidSandbox as SandboxV1 };');
    expect(code).toContain('__setSandboxBindingName("SANDBOX");');
  });

  it('exports the configured Sandbox Durable Object subclass via VoidPlatformSandbox', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: {
        bindingName: 'CODE',
        className: 'CodeSandbox',
        runtimePath: 'void/sandbox',
      },
    });

    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "void/sandbox"',
    );
    expect(code).not.toContain('from "@cloudflare/sandbox"');
    expect(code).toContain('export class CodeSandbox extends __VoidSandbox {}');
    expect(code).toContain('__setSandboxBindingName("CODE");');
  });

  it('uses the resolved sandbox runtime path when one is provided', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: {
        runtimePath: '/abs/path/to/sandbox.mjs',
      },
    });

    expect(code).toContain(
      'import { VoidPlatformSandbox as __VoidSandbox, __setSandboxBindingName } from "/abs/path/to/sandbox.mjs"',
    );
  });

  it('omits the sandbox import and export when sandbox is disabled', () => {
    const code = compileWorkerEntry();

    expect(code).not.toContain('__VoidSandbox');
    expect(code).not.toContain('VoidPlatformSandbox');
    expect(code).not.toContain('__setSandboxBindingName');
    expect(code).not.toContain('from "@cloudflare/sandbox"');
  });

  it('generates queue() export in worker entry when hasQueues=true', () => {
    const code = compileWorkerEntry({ hasQueues: true });

    expect(code).toContain('async function __voidQueue(batch, env, ctx)');
    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('serveWithAssets');
    expect(code).toContain('async queue(batch) { return __voidQueue(batch, this.env, this.ctx); }');
    expect(code).toContain('__processQueue');
    expect(code).toContain('batch.queue');
    expect(code).toContain('m.timestamp.toISOString()');
    expect(code).toContain('withRuntimeEnv(env, () => __processQueue(payload, userEnv))');
  });

  it('omits queue() export when hasQueues=false', () => {
    const code = compileWorkerEntry({ hasQueues: false });

    expect(code).not.toContain('queue');
  });

  it('sets missing asset MIME types while preserving binding headers', async () => {
    const serveWithAssets = createAssetFallback();

    for (const [path, expected] of [
      ['/assets/app.js', 'text/javascript; charset=utf-8'],
      ['/assets/app.css', 'text/css; charset=utf-8'],
      ['/assets/logo.webp', 'image/webp'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/assets/unknown.xyz', null],
    ] as const) {
      const response = await serveWithAssets(
        new Request(`https://app.test${path}`),
        { ASSETS: { fetch: async () => new Response(new Uint8Array([1])) } },
        new Response('not found', { status: 404 }),
      );
      expect(response.headers.get('Content-Type')).toBe(expected);
    }

    const originalType = 'application/javascript';
    const response = await serveWithAssets(
      new Request('https://app.test/assets/app.js'),
      {
        ASSETS: {
          fetch: async () =>
            new Response(new Uint8Array([1]), { headers: { 'Content-Type': originalType } }),
        },
      },
      new Response('not found', { status: 404 }),
    );
    expect(response.headers.get('Content-Type')).toBe(originalType);
  });

  it('serveWithAssets does not include the SPA shell fallback by default', () => {
    const code = compileWorkerEntry();

    // Pages and SSR apps generate intentional HTML 404 responses. The outer
    // asset fallthrough must not rewrite those to the SPA shell.
    expect(code).not.toContain('"/index.html"');
    expect(code).not.toContain('accept.includes("text/html")');
  });

  it('serveWithAssets keeps the worker response for not_found_handling: none', () => {
    const code = compileWorkerEntry({
      hasQueues: false,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      sandbox: false,
      serveSpaFallback: false,
      notFound: 'none',
    });

    expect(code).toBe(compileWorkerEntry());
  });

  it('passes filtered env (userEnv) not raw env to scheduled handler', () => {
    const code = compileWorkerEntry();

    expect(code).toContain('async function handleScheduled(controller, env, ctx)');
    expect(code).toContain('const userEnv = __filterInternalBindings(env)');
    expect(code).toContain('scheduled(controller, userEnv, ctx)');
    expect(code).not.toMatch(/scheduled\(controller,\s*env,\s*ctx\)/);
  });

  it('omits boot-time env validation when no envSchemaModule is provided', () => {
    const code = compileWorkerEntry();
    expect(code).not.toContain('_validateEnvOnce');
  });

  it('passes custom binding names to remote env proxying', () => {
    const code = compileWorkerEntry({
      hasQueues: true,
      remote: {
        bindingNames: { d1: 'myapp_db', kv: 'myapp_kv', r2: 'myapp_storage' },
        remotePath: '/resolved/remote.mjs',
      },
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: '/resolved/env.mjs',
    });

    expect(code).toContain(
      'createRemoteEnv(env, {"d1":"myapp_db","kv":"myapp_kv","r2":"myapp_storage"})',
    );
  });
});

describe('compileNodeApp', () => {
  it('generates node app with serveStatic and default export', () => {
    const code = compileNodeApp('node', '/resolved/hono/index.mjs');
    expect(code).toContain('import { serveStatic } from "@hono/node-server/serve-static"');
    expect(code).toContain('import { Hono } from "/resolved/hono/index.mjs"');
    expect(code).toContain('export default app');
    expect(code).toContain(
      'import innerApp, { __voidCollectPrerenderPaths } from "virtual:void-routes"',
    );
    expect(code).toContain('app.post("/__void/prerender-paths"');
    // Only the prerender runner passes the marker as the Hono env.
    expect(code).toContain('if (c.env?.__VOID_PRERENDER !== "1") return c.notFound();');
    expect(code).not.toContain('__VOID_PROXY_TOKEN');
    expect(code).not.toContain('x-void-internal');
  });

  it('generates bun app with hono/bun serveStatic', () => {
    const code = compileNodeApp('bun', '/resolved/hono/index.mjs');
    expect(code).toContain('import { serveStatic } from "hono/bun"');
    expect(code).toContain('export default app');
    expect(code).not.toContain('@hono/node-server');
  });

  it('generates deno app with hono/deno serveStatic', () => {
    const code = compileNodeApp('deno', '/resolved/hono/index.mjs');
    expect(code).toContain('import { serveStatic } from "hono/deno"');
    expect(code).toContain('export default app');
    expect(code).not.toContain('@hono/node-server');
  });

  it('omits boot-time env validation when no envSchemaModule is provided', () => {
    const code = compileNodeApp('node', '/resolved/hono/index.mjs');
    expect(code).not.toContain('_validateEnvOnce');
  });

  it('splices boot-time env validation when envSchemaModule is provided (node)', () => {
    const code = compileNodeApp('node', '/resolved/hono/index.mjs', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    expect(code).toContain('import "/abs/path/to/env.ts"');
    expect(code).toContain('import { _validateEnvOnce } from "/resolved/env-public.mjs"');
    // Only path discovery can run without remote production secrets.
    // Node/Bun read the application request environment from process.env.
    expect(code).toContain('app.use("*", async (c, next)');
    expect(code).toContain('await _validateEnvOnce(process.env)');
    expect(code).toContain(
      'if (!(c.req.method === "POST" && c.req.path === "/__void/prerender-paths" && c.env?.__VOID_PRERENDER === "1")) await _validateEnvOnce(process.env)',
    );
  });

  it('uses Deno.env.toObject() as the env source on the deno target', () => {
    const code = compileNodeApp('deno', '/resolved/hono/index.mjs', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    expect(code).toContain('await _validateEnvOnce(Deno.env.toObject())');
    expect(code).not.toContain('process.env');
  });

  it('splices boot-time env validation on the bun target', () => {
    const code = compileNodeApp('bun', '/resolved/hono/index.mjs', {
      importPath: '/abs/path/to/env.ts',
      helperPath: '/resolved/env-public.mjs',
    });
    expect(code).toContain('await _validateEnvOnce(process.env)');
  });
});

describe('compileNodeServer', () => {
  it('generates node server with @hono/node-server', () => {
    const code = compileNodeServer('node');
    expect(code).toContain('import { serve } from "@hono/node-server"');
    expect(code).toContain('import app from "./app.js"');
    expect(code).toContain('app.fetch');
    expect(code).toContain('process.env.PORT');
  });

  it('generates bun server with Bun.serve', () => {
    const code = compileNodeServer('bun');
    expect(code).toContain('Bun.serve');
    expect(code).toContain('import app from "./app.js"');
    expect(code).not.toContain('@hono/node-server');
  });

  it('generates deno server with Deno.serve', () => {
    const code = compileNodeServer('deno');
    expect(code).toContain('Deno.serve');
    expect(code).toContain('import app from "./app.js"');
    expect(code).not.toContain('@hono/node-server');
  });
});

describe('shared pattern compiler in generated routes', () => {
  const compilePattern = (source: string) => {
    const { paramNames } = sharedCompilePattern(source);
    return { names: [...paramNames] };
  };

  it(':name and bare "*" do not clash even when both appear', () => {
    const { names } = compilePattern('/u/:id*/files/*');
    expect(names).toEqual(['id', 'splat']);
    expect(matchPatternCaptures('/u/:id*/files/*', '/u/42/extra/files/a/b')).toEqual({
      id: '42/extra',
      splat: 'a/b',
    });
  });

  it('__compilePattern itself still throws on duplicate capture group names', () => {
    // Config validation rejects these; the runtime skips such rules per request.
    expect(() => compilePattern('/:id/:id')).toThrow(/duplicate capture group name/i);
    expect(() => compilePattern('/:splat/*')).toThrow(/duplicate capture group name/i);
    expect(() => compilePattern('/:rest*/:rest*')).toThrow(/duplicate capture group name/i);
  });

  it('production routing middleware skips invalid rules and still applies valid ones', async () => {
    const codeWithRules = compile({
      dev: true,
      redirectRules: [
        {
          source: '/:id/:id',
          destination: '/x',
          status: 200,
          force: true,
          origin: 'test',
        },
        {
          source: '/old',
          destination: '/new',
          status: 200,
          force: true,
          origin: 'test',
        },
      ],
    });
    const app = evalCompiledApp(codeWithRules);
    app.get('/new', (c) => c.text('new route'));
    const response = await app.fetch(
      new Request('https://app.test/old'),
      {},
      { waitUntil() {}, passThroughOnException() {}, props: {} },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('new route');
  });

  it('header matching skips malformed patterns and warns once per app', async () => {
    const warnings: Array<string> = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      const app = new Hono();
      const runtime = createRoutingRuntime(app, { nodeTarget: true });
      app.use(runtime.headerMiddleware([{ pattern: '/:id/:id', headers: [['x-bad', '1']] }]));
      app.get('*', (c) => c.text('ok'));
      for (let i = 0; i < 2; i++) {
        const response = await app.fetch(new Request('https://app.test/a/b'));
        expect(response.status).toBe(200);
        expect(response.headers.has('x-bad')).toBe(false);
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('failed to compile route pattern');
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('compileWorkerEntry — ISR wiring', () => {
  // revalidate() in cron and queue handlers needs the deployment id; they have no request host.
  it('stamps the deployment id at the top of the scheduled + queue handlers when isr is set', () => {
    const code = compileWorkerEntry({
      hasQueues: true,
      assetsDir: 'assets',
      webSocketClasses: [],
      runtimeEnvPath: 'void/_env',
      serveSpaFallback: false,
      isr: { runtimePath: 'void/isr' },
    });

    expect(code).toContain(
      'async function handleScheduled(controller, env, ctx) {\n' +
        '  env.__VOID_ISR_DEPLOYMENT_ID ??= __VOID_ISR_DEPLOYMENT_ID;\n' +
        '  const userEnv = __filterInternalBindings(env);',
    );
    expect(code).toContain(
      'async function __voidQueue(batch, env, ctx) {\n' +
        '  env.__VOID_ISR_DEPLOYMENT_ID ??= __VOID_ISR_DEPLOYMENT_ID;\n' +
        '  const userEnv = __filterInternalBindings(env);',
    );
    expect(code).not.toContain('env.__VOID_ISR_HOST ??= new URL(controller');
  });

  it('does NOT stamp the deployment id in scheduled/queue handlers when isr is absent', () => {
    const code = compileWorkerEntry({ hasQueues: true });
    expect(code).not.toContain('__VOID_ISR_DEPLOYMENT_ID ??=');
    expect(code).toContain(
      'async function handleScheduled(controller, env, ctx) {\n' +
        '  const userEnv = __filterInternalBindings(env);',
    );
    expect(code).toContain(
      'async function __voidQueue(batch, env, ctx) {\n  const userEnv = __filterInternalBindings(env);',
    );
  });
});

describe('compileRouteTable — baked ISR consts', () => {
  it('emits __VOID_ISR_DEPLOYMENT_ID as a compile-time string literal (never crypto.randomUUID())', () => {
    const code = compile();
    expect(code).toMatch(/export const __VOID_ISR_DEPLOYMENT_ID = "[0-9a-f-]{36}";/);
    expect(code).not.toContain('__VOID_ISR_DEPLOYMENT_ID = crypto.randomUUID()');
  });

  it('bakes a fresh deployment id per compilation (one shared id per deploy)', () => {
    const a = compile();
    const b = compile();
    const idA = a.match(/__VOID_ISR_DEPLOYMENT_ID = "([^"]+)"/)![1];
    const idB = b.match(/__VOID_ISR_DEPLOYMENT_ID = "([^"]+)"/)![1];
    expect(idA).not.toBe(idB);
  });

  it('emits the merged revalidate config verbatim (undefined | number | path map)', () => {
    const none = compile();
    expect(none).toContain('export const __VOID_ISR_REVALIDATE = undefined;');

    const num = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
      60,
    );
    expect(num).toContain('export const __VOID_ISR_REVALIDATE = 60;');

    const map = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
      { '/blog/*': 30 },
    );
    expect(map).toContain('export const __VOID_ISR_REVALIDATE = {"/blog/*":30};');
  });

  it('bakes the ordered page policy and raw path config for native ISR', () => {
    const code = compileRouteTable(
      emptyScan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      null,
      { '/private': 60 },
      [{ pattern: '/private', revalidate: 0 }],
      { '/private': 60 },
    );

    expect(code).toContain(
      'export const __VOID_ISR_PAGES = [{"pattern":"/private","revalidate":0}];',
    );
    expect(code).toContain('export const __VOID_ISR_PATH_REVALIDATE = {"/private":60};');
  });
});

describe('typed runtime metadata wiring', () => {
  it('imports Worker-safe execution and emits route export selection and cache policy', () => {
    const scan: ScanResult = {
      ...emptyScan,
      routes: [
        {
          pattern: '/hello',
          filePath: 'hello.ts',
          params: [],
          catchAll: false,
          env: null,
          methods: ['GET', 'POST'],
        },
      ],
    };
    const dev = compile({ dev: true }, scan);
    expect(dev).toContain('createRoutingRuntime as __createRoutingRuntime');
    expect(dev).toContain(
      'const _load_hello_ts = __createModuleLoader(() => import("/routes/hello.ts"), false)',
    );
    expect(dev).toContain('app.get("/hello", __createHttpRouteHandler(_load_hello_ts, "GET"))');
    expect(dev).toContain('app.post("/hello", __createHttpRouteHandler(_load_hello_ts, "POST"))');
    expect(dev).not.toContain('function __voidAnnotateRouting');
    expect(dev).not.toContain('c.rewrite =');
  });
  it('keeps authored rule origins in dev and omits them in production and managed dispatch', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301, origin: 'config' }];
    const dev = compile({ dev: true, redirectRules: rules, fallbackRules: rules });
    expect(dev).toContain('"origin":"config"');
    expect(dev).toContain('__routingRuntime.routingMiddleware(__routingRules)');
    expect(dev).toContain('__createAssetNotFound');
    const production = compile({ dev: false, redirectRules: rules, fallbackRules: rules });
    expect(production).not.toContain('"origin":"config"');
    const managed = compile({ managedDispatch: true, redirectRules: rules, fallbackRules: rules });
    expect(managed).not.toContain('const __routingRules');
    expect(managed).not.toContain('app.notFound');
  });
  it('wires fetch validation, opaque internal routes and optional ISR through runtime callbacks', () => {
    const code = compileWorkerEntry({
      envSchemaModule: { importPath: '/env.ts', helperPath: '/env-helpers.ts' },
      isr: { runtimePath: 'void/isr', queryAllowlist: { '/search': ['q'] } },
    });
    expect(code).toContain('const __voidFetch = __createWorkerFetch({');
    expect(code).toContain('validateEnv: _validateEnvOnce');
    expect(code).toContain('internalRoute: __voidHandleInternalRoute');
    expect(code).toContain('deploymentId: __VOID_ISR_DEPLOYMENT_ID');
    expect(code).toContain('queryAllowlist: {"/search":["q"]}');
    expect(code).toContain(
      'const serveWithAssets = __createAssetFallback({"assetsDir":"assets","serveSpaFallback":false,"notFound":"none"})',
    );
    expect(code).not.toContain('function __handleInternal');
    expect(code).not.toContain('async function serveWithAssets');
  });
});

describe('compileRouteTable — image optimizer mount', () => {
  const images = { config: resolveImageConfig(undefined, { root: '/project', dev: false }) };
  const sqliteAuth = {
    authRuntimePath: '/resolved/void/runtime/better-auth.mjs',
    authConfigPath: null,
    authDatabasePath: '/project/.void/better-auth-db.ts',
    authSchemaPath: '/project/.void/better-auth-schema.ts',
    dialect: 'sqlite' as const,
    providers: null,
  };
  const scan: ScanResult = {
    ...emptyScan,
    routes: [
      {
        pattern: '/api/hello',
        filePath: 'api/hello.ts',
        params: [],
        catchAll: false,
        env: null,
        methods: ['GET'],
      },
      {
        pattern: '/:path{.+}',
        filePath: '[...path].ts',
        params: ['path'],
        catchAll: true,
        env: null,
        methods: ['GET'],
      },
    ],
    websockets: [
      {
        pattern: '/chat',
        methods: [],
        params: [],
        catchAll: false,
        env: null,
        filePath: 'chat.ws.ts',
        className: 'ChatWs',
        bindingName: 'ChatWs',
        mode: 'room',
        hasAuthGate: false,
      },
    ],
    middleware: [{ order: 1, filePath: '01.gate.ts' }],
    pages: {
      pages: [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.tsx',
          componentId: 'index',
          serverPath: null,
          methods: [],
          ssrMode: 'server',
          prerenderMode: 'disabled',
          renderMode: 'server',
          shouldPrerender: false,
        },
      ],
      layouts: [],
      namedLayouts: [],
    },
  };
  const pages = {
    pagesDir: '/pages',
    pagesDirRelative: 'pages',
    clientEntryId: 'virtual:void-pages-client',
  };
  const compileWithImages = (options: Partial<CompileOptions> = {}): string =>
    compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      {
        ...testOptions,
        assetsDir: 'assets',
        auth: sqliteAuth,
        images,
        ...options,
      },
      pages,
    );

  it('mounts the handler after middleware and before WebSocket hooks, auth, routes and pages', () => {
    const code = compileWithImages();
    const mount = code.indexOf('app.all("/_void/image", __createImageHandler(');

    expect(code).toContain('createImageHandler as __createImageHandler } from');
    expect(mount).toBeGreaterThan(code.indexOf('runVoidAuthMiddleware(c, next'));
    expect(mount).toBeGreaterThan(code.indexOf('app.use(middleware0);'));
    for (const later of [
      'app.all("/chat", async (c, next) => {',
      'app.all("/api/auth", async (c) => {',
      'app.get("/api/hello", __createHttpRouteHandler(',
      'app.get("/:path{.+}", __createHttpRouteHandler(',
      'app.get("/", __createPageGetHandler(',
    ]) {
      expect(code.indexOf(later), later).toBeGreaterThan(mount);
    }
  });

  it('passes the resolved config, assets dir, the route table deployment id and the app', () => {
    const code = compileWithImages();
    // The app is passed so local sources run through middleware.
    const options = JSON.parse(
      /app\.all\("\/_void\/image", __createImageHandler\((.*), app\)\);/.exec(code)![1]!,
    ) as { config: unknown; deploymentId: string; assetsDir: string };
    const deploymentId = /export const __VOID_ISR_DEPLOYMENT_ID = "([^"]+)";/.exec(code)![1];

    expect(options.config).toEqual(images.config);
    expect(options.assetsDir).toBe('assets');
    expect(options.deploymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.deploymentId).toBe(deploymentId);
  });

  it('skips the Void auth session lookup for the mounted path only', () => {
    expect(compileWithImages()).toContain('dev: false, skipPaths: ["/_void/image"] };');
    expect(compileWithImages({ images: undefined })).toContain(
      'userConfig: undefined, dev: false };',
    );
  });

  it('mounts a custom images.path', () => {
    const config = resolveImageConfig({ path: '/media/optimize' }, { root: '/project', dev: true });
    const code = compileWithImages({ images: { config } });
    expect(code).toContain('app.all("/media/optimize", __createImageHandler(');
    expect(code).toContain('skipPaths: ["/media/optimize"]');
  });

  it.each([
    ['no images option', { images: undefined }],
    ['a node target', { nodeTarget: true }],
    [
      'unoptimized images',
      {
        images: {
          config: resolveImageConfig({ unoptimized: true }, { root: '/project', dev: false }),
        },
      },
    ],
    [
      'a custom loader',
      {
        images: {
          config: resolveImageConfig(
            { loader: 'imgix', path: 'https://cdn.example.com/' },
            { root: '/project', dev: false },
          ),
        },
      },
    ],
  ] as const)('mounts nothing for %s', (_name, options) => {
    const code = compileWithImages(options as Partial<CompileOptions>);
    expect(code).not.toContain('__createImageHandler');
    expect(code).not.toContain('skipPaths');
  });

  it('keeps the output of apps without images unchanged apart from per-compile ids', () => {
    const normalize = (code: string) =>
      code.replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"<uuid>"');
    const withoutImages = normalize(compileWithImages({ images: undefined }));
    const withImages = normalize(compileWithImages());
    // The mount is one line followed by a blank line.
    const mountLine = /\napp\.all\("\/_void\/image", .*\);\n\n/.exec(withImages)![0];

    expect(
      withImages
        .replace(', createImageHandler as __createImageHandler', '')
        .replace(', skipPaths: ["/_void/image"]', '')
        .replace(mountLine, '\n'),
    ).toBe(withoutImages);
  });
});

describe('compileWorkerEntry — ISR image bypass', () => {
  it('passes bypass paths to the ISR wrapper only when given', () => {
    const withImages = compileWorkerEntry({
      isr: { runtimePath: 'void/isr', bypassPaths: ['/_void/image'] },
    });
    expect(withImages).toContain(
      'isr: { deploymentId: __VOID_ISR_DEPLOYMENT_ID, bypassPaths: ["/_void/image"], handle: (request, env, ctx, render) => handleIsr(',
    );
    expect(compileWorkerEntry({ isr: { runtimePath: 'void/isr' } })).toContain(
      'isr: { deploymentId: __VOID_ISR_DEPLOYMENT_ID, handle: (request, env, ctx, render) => handleIsr(',
    );
  });
});
