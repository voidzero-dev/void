import { describe, expect, it } from 'vite-plus/test';
import { hasPrerenderSources } from '../../src/cli/deploy-helpers.ts';
import { compileRouteTable } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

// `collectPrerenderPaths` boots the built worker in Miniflare without remote
// production secrets. The generated handler validates `env.ts` at boot, so an
// unnecessary boot could fail even when there is nothing to prerender.
//
// The skip is only safe if it is result-identical, which is what the second
// describe block below pins against the real code generator.
describe('hasPrerenderSources', () => {
  it('is false when there is no pages dir, no SSR entry and no routing.prerender', () => {
    expect(
      hasPrerenderSources({
        hasPages: false,
        hasSsrEntry: false,
        explicitPrerenderPaths: undefined,
      }),
    ).toBe(false);
  });

  it('is true when pages/ exists', () => {
    expect(
      hasPrerenderSources({
        hasPages: true,
        hasSsrEntry: false,
        explicitPrerenderPaths: undefined,
      }),
    ).toBe(true);
  });

  // Custom SSR mode (`src/main.ssr.ts`) exports a top-level `getPrerenderPaths()`
  // and has NO pages/ directory. Keying the skip on pages alone would silently
  // stop prerendering for every one of these apps.
  it('is true for a custom SSR entry with no pages/', () => {
    expect(
      hasPrerenderSources({
        hasPages: false,
        hasSsrEntry: true,
        explicitPrerenderPaths: undefined,
      }),
    ).toBe(true);
  });

  // `routing.prerender` is compiled into the collector as explicit paths and is
  // likewise independent of pages/.
  it('is true for routing.prerender with no pages/ and no SSR entry', () => {
    expect(
      hasPrerenderSources({
        hasPages: false,
        hasSsrEntry: false,
        explicitPrerenderPaths: ['/', '/about'],
      }),
    ).toBe(true);
  });

  it('treats an empty routing.prerender array as no source', () => {
    expect(
      hasPrerenderSources({
        hasPages: false,
        hasSsrEntry: false,
        explicitPrerenderPaths: [],
      }),
    ).toBe(false);
  });
});

// Equivalence proof: the three inputs above are exactly the sources
// `compilePrerenderCollector` emits a `paths.push(...)` for. With none of them,
// the generated collector body has no push at all and can only return `[]`, so
// not booting it returns the same answer the boot would have.
describe('__voidCollectPrerenderPaths — sources that can push a path', () => {
  const testOptions = {
    honoPath: '/resolved/hono/index.mjs',
    honoRoutePath: '/resolved/hono/route.mjs',

    runtimeEnvPath: '/resolved/void/runtime/env.mjs',
    projectRoot: '/project',
    homeDir: '/Users/test',
    webSocketRuntimePath: '/resolved/void/runtime/ws-server.mjs',
    reactRefresh: false,
    auth: null,
  };

  const pagesOptions = {
    pagesDir: '/pages',
    pagesDirRelative: 'pages',

    clientEntryId: 'virtual:void-pages-client',
  };

  const emptyScan: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };

  /** An API-only app: routes, but nothing that can ever be prerendered. */
  const apiOnlyScan: ScanResult = {
    ...emptyScan,
    routes: [
      {
        pattern: '/api/newsletter',
        methods: ['POST'],
        params: [],
        catchAll: false,
        env: null,
        filePath: 'api/newsletter.ts',
      },
    ],
  };

  const prerenderablePage = {
    componentId: 'pages/about.vue',
    componentPath: '/pages/about.vue',
    serverPath: null,
    pattern: '/about',
    params: [],
    catchAll: false,
    methods: [],
    ssrMode: 'auto' as const,
    prerenderMode: 'auto' as const,
    renderMode: 'server' as const,
    shouldPrerender: true,
  };

  function collectorBody(code: string): string {
    const marker = 'export async function __voidCollectPrerenderPaths';
    const start = code.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = code.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return code.slice(start, end);
  }

  function compile(
    scan: ScanResult,
    ssr: { serverEntryPath: string; clientEntryRelativePath: string } | null,
    explicitPrerenderPaths?: Array<string>,
    withPages = false,
  ): string {
    return compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      ssr,
      { ...testOptions, explicitPrerenderPaths },
      withPages ? pagesOptions : null,
    );
  }

  it('emits no push at all with no pages, no SSR entry and no explicit paths', () => {
    expect(collectorBody(compile(apiOnlyScan, null))).not.toContain('paths.push(');
  });

  it('emits a push for a prerenderable page', () => {
    const body = collectorBody(
      compile(
        { ...emptyScan, pages: { pages: [prerenderablePage], layouts: [], namedLayouts: [] } },
        null,
        undefined,
        true,
      ),
    );
    expect(body).toContain('paths.push("/about")');
  });

  it('emits a push for the custom SSR entry getPrerenderPaths()', () => {
    const body = collectorBody(
      compile(apiOnlyScan, {
        serverEntryPath: '/project/src/main.ssr.ts',
        clientEntryRelativePath: 'src/main.client.ts',
      }),
    );
    expect(body).toContain('mod.getPrerenderPaths');
    expect(body).toContain('paths.push(path)');
  });

  it('emits a push for each routing.prerender path', () => {
    const body = collectorBody(compile(apiOnlyScan, null, ['/', '/pricing']));
    expect(body).toContain('paths.push("/")');
    expect(body).toContain('paths.push("/pricing")');
  });

  // Routes and middleware are NOT prerender sources — an app can be full of them
  // and still have nothing to collect.
  it('routes and middleware alone still emit no push', () => {
    const body = collectorBody(
      compile({ ...apiOnlyScan, middleware: [{ order: 1, filePath: '01.logger.ts' }] }, null),
    );
    expect(body).not.toContain('paths.push(');
  });
});
