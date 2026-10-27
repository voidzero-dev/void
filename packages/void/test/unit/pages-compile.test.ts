import { parseSync } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import type { PageDefinition, PageScanResult } from '../../src/pages/types.ts';
import { compileRouteTable, type PagesCompileOptions } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const testOptions = {
  honoPath: '/resolved/hono/index.mjs',
  honoRoutePath: '/resolved/hono/route.mjs',

  runtimeEnvPath: '/resolved/void/runtime/env.mjs',
  projectRoot: '/project',
  homeDir: '/Users/test',
  reactRefresh: false,
  dev: true,
  auth: null,
};

const pagesOptions: PagesCompileOptions = {
  pagesDir: '/project/pages',
  pagesDirRelative: 'pages',

  clientEntryId: 'virtual:void-pages-client',
};

function makeScan(pages: PageScanResult): ScanResult {
  return { routes: [], middleware: [], jobs: [], queues: [], pages };
}

describe('Pages metadata wiring', () => {
  const page: PageDefinition = {
    pattern: '/',
    params: [],
    catchAll: false,
    componentPath: 'index.vue',
    componentId: 'index',
    serverPath: 'index.server.ts',
    methods: ['loader', 'actions'],
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
  };
  const compile = (options = testOptions) =>
    compileRouteTable(
      makeScan({ pages: [page], layouts: [], namedLayouts: [] }),
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      options,
      pagesOptions,
    );
  it('emits lazy imports and renderer/action metadata with typed execution calls', () => {
    const code = compile();
    expect(code).toContain('import { renderPage } from "virtual:void-pages-renderer"');
    expect(code).toContain(
      'const _pload_index = __createModuleLoader(() => import("/project/pages/index.server.ts"))',
    );
    expect(code).toContain('app.get("/", __createPageGetHandler(');
    expect(code).toContain('"renderMode":"server"');
    expect(code).toContain('namedActions: true');
    expect(code).not.toContain('handlePageMutation(handler');
  });
  it.each([
    [['loader', 'actions'], true],
    [['loader', 'action'], false],
  ] as const)(
    'marks named action requests between routing rules and user middleware for %j',
    (methods, marked) => {
      const code = compileRouteTable(
        {
          ...makeScan({
            pages: [{ ...page, methods: [...methods] }],
            layouts: [],
            namedLayouts: [],
          }),
          middleware: [{ order: 1, filePath: '01.auth.ts' }],
        },
        '/routes',
        '/middleware',
        '/crons',
        '/queues',
        null,
        { ...testOptions, redirectRules: [{ source: '/old', destination: '/', status: 301 }] },
        pagesOptions,
      );
      const marker = code.indexOf('app.use(__createNamedActionMarker(__matchedRoutes));');
      expect(marker !== -1).toBe(marked);
      expect(
        code.includes(
          'import { matchedRoutes as __matchedRoutes } from "/resolved/hono/route.mjs";',
        ),
      ).toBe(marked);
      if (marked) {
        expect(marker).toBeGreaterThan(code.indexOf('__routingRuntime.routingMiddleware('));
        expect(marker).toBeLessThan(code.indexOf('app.use(middleware0);'));
      }
    },
  );
  it('marks page render options as dev only in dev builds', () => {
    expect(compile()).toContain('renderOptions: {"renderMode":"server","dev":true} }');
    const prod = compile({ ...testOptions, dev: false });
    expect(prod).toContain('renderOptions: {"renderMode":"server"} }');
    expect(prod).not.toContain('"renderMode":"server","dev"');
  });
  it('passes dev CSS metadata and a shared manifest loader to the runtime', () => {
    const code = compile();
    expect(code).toContain('getVoidPagesDevCss');
    expect(code).toContain('devCss: getVoidPagesDevCss');
    expect(code).toContain('"pageCssKeys":{"index":["pages/index.vue"]}');
    expect(code).toContain('"devRootPhases"');
    expect(code).toContain('}, __loadPagesManifest)');
    expect(code).not.toContain('function collectRouteCss');
  });
  it('passes dev/error display metadata without embedding renderer functions', () => {
    const code = compile();
    expect(code).toContain(
      '__createErrorRenderer({"dev":true,"projectRoot":"/project","homeDir":"/Users/test"})',
    );
    expect(code).toContain('app.onError(__errorRenderer.onError)');
    expect(code).toContain('app.notFound(__createPagesFallback(');
    expect(code).not.toContain('function __voidRenderDevErrorOverlay');
  });
  it('keeps layout CSS roots in cascade order and includes island markdown metadata', () => {
    const scan = makeScan({
      pages: [{ ...page, island: true, renderMode: 'island' }],
      layouts: [{ directory: '', filePath: 'layout.vue', island: true }],
      namedLayouts: [],
    });
    const code = compileRouteTable(
      scan,
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      { ...pagesOptions, islandClientEntryId: 'virtual:islands', mdClientEntryId: 'virtual:md' },
    );
    expect(code).toContain('"pageCssKeys":{"index":["pages/layout.vue","pages/index.vue"]}');
    expect(code).toContain('"extraEntryId":"virtual:md"');
    expect(code).toContain('assets: getIslandsAssetTags');
  });
  it('gives non-ASCII page names of the same length their own loaders and head functions', () => {
    const mdPage = (name: string): PageDefinition => ({
      ...page,
      pattern: `/blog/${name}`,
      componentPath: `blog/${name}.md`,
      componentId: `blog/${name}`,
      serverPath: null,
      methods: [],
      metadata: { title: name },
    });
    const serverPage = (name: string, prerender: boolean): PageDefinition => ({
      ...page,
      pattern: `/shop/:id/${name}`,
      params: ['id'],
      componentPath: `shop/[id]/${name}.vue`,
      componentId: `shop/[id]/${name}`,
      serverPath: `shop/[id]/${name}.server.ts`,
      methods: ['loader'],
      shouldPrerender: prerender,
      hasGetPrerenderPaths: prerender,
    });
    const code = compileRouteTable(
      makeScan({
        pages: [mdPage('你好'), mdPage('世界'), serverPage('书', false), serverPage('画', true)],
        layouts: [],
        namedLayouts: [],
      }),
      '/routes',
      '/middleware',
      '/crons',
      '/queues',
      null,
      testOptions,
      pagesOptions,
    );
    const parsed = parseSync('routes.js', code, { sourceType: 'module', showSemanticErrors: true });
    expect(parsed.errors.map((error) => error.message)).toEqual([]);
    expect(code).toContain('const __mdHead_blog___ = () => ({"title":"你好"});');
    expect(code).toContain('const __mdHead_blog____2 = () => ({"title":"世界"});');
    expect(code).toContain(
      'const _pload_shop__id____2 = __createModuleLoader(() => import("/project/pages/shop/[id]/画.server.ts"));',
    );
    expect(code).toContain(
      'app.get("/shop/:id/画", __createPageGetHandler({ load: _pload_shop__id____2, ',
    );
    // Only the second page is prerendered; the collector must still use its loader's name.
    expect(code).toContain('const mod = await _pload_shop__id____2();');
    expect(code).not.toContain('await _pload_shop__id___()');
  });
});
