import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { readConfig } from '../../src/config.ts';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const source = (file: string) => join(repository, 'packages/void/src/runtime', file);
let directory: string;
let runtime: Miniflare | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('typed routing in generated Workers', () => {
  it.each([false, true])(
    'preserves middleware, rewrites, fallbacks and real page protocol in dev=%s',
    async (dev) => {
      directory = mkdtempSync(join(tmpdir(), 'void-typed-routing-'));
      const routes = join(directory, 'routes');
      const middleware = join(directory, 'middleware');
      const pages = join(directory, 'pages');
      const output = join(directory, 'output');
      const assets = join(directory, 'client');
      for (const path of [routes, middleware, pages, assets]) {
        mkdirSync(path);
      }
      mkdirSync(join(assets, 'static'));
      writeFileSync(join(assets, 'static/client-abcdefgh.js'), 'export const value = 1;');
      mkdirSync(join(assets, '.vite'));
      writeFileSync(
        join(assets, '.vite/manifest.json'),
        JSON.stringify({
          client: {
            file: 'static/client-abcdefgh.js',
            immutableFiles: ['static/client-abcdefgh.js'],
          },
        }),
      );
      writeFileSync(
        join(routes, 'hello.ts'),
        `export function GET(c) { return { path: c.req.path, original: c.originalUrl()?.pathname, rewritten: c.isRewritten(), public: c.env.PUBLIC, hidden: c.env.__VOID_PROXY_TOKEN }; }\n`,
      );
      writeFileSync(
        join(routes, 'move.ts'),
        `export function GET(c) { return c.rewrite('/hello'); }\n`,
      );
      writeFileSync(
        join(middleware, '01.headers.ts'),
        `export default async (c, next) => { await next(); c.header('x-user-middleware', 'ran'); };\n`,
      );
      writeFileSync(
        join(pages, 'index.server.ts'),
        `export function loader() { return { title: 'real page loader' }; }\nexport const actions = { save: () => new Response('saved') };\n`,
      );
      const { scan } = await analyzeApplication(directory, { config: readConfig(directory) });
      scan.pages.pages = [
        {
          pattern: '/',
          params: [],
          catchAll: false,
          componentPath: 'index.tsx',
          componentId: 'index',
          serverPath: 'index.server.ts',
          methods: ['loader', 'actions'],
          ssrMode: 'server',
          prerenderMode: 'disabled',
          renderMode: 'server',
          shouldPrerender: false,
        },
        {
          pattern: '/client-only',
          params: [],
          catchAll: false,
          componentPath: 'client-only.tsx',
          componentId: 'client-only',
          serverPath: null,
          methods: [],
          ssrMode: 'client',
          prerenderMode: 'disabled',
          renderMode: 'client',
          shouldPrerender: false,
        },
      ];
      const routeTable = join(directory, 'generated-routes.ts');
      const entry = join(directory, 'generated-worker.ts');
      writeFileSync(
        routeTable,
        compileRouteTable(
          scan,
          routes,
          middleware,
          join(directory, 'crons'),
          join(directory, 'queues'),
          null,
          {
            honoPath: fileURLToPath(import.meta.resolve('hono')),
            honoRoutePath: fileURLToPath(import.meta.resolve('hono/route')),
            runtimeEnvPath: source('env.ts'),
            projectRoot: directory,
            homeDir: tmpdir(),
            reactRefresh: false,
            auth: null,
            dev,
            assetsDir: 'static',
            redirectRules: [
              { source: '/rewrite', destination: '/hello', status: 200, force: true },
            ],
            fallbackRules: [{ source: '/missing', destination: '/hello', status: 200 }],
            headerRules: [{ pattern: '/*', headers: [['x-edge-rule', 'ran']] }],
          },
          {
            pagesDir: pages,
            pagesDirRelative: 'pages',
            clientEntryId: 'virtual:fixture-client',
          },
        ),
      );
      writeFileSync(entry, compileWorkerEntry({ runtimeEnvPath: source('env.ts') }));
      const preambleScript = dev
        ? '<script type="module">window.__fixturePreamble = true</script>'
        : '';
      const undefinedImports: Array<string> = [];
      await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'typed-routing-fixture',
            enforce: 'pre',
            resolveId(id) {
              if (id.endsWith('/dist/runtime/routing.mjs')) {
                return source('routing.ts');
              }
              if (id === 'virtual:void-routes') {
                return routeTable;
              }
              if (id === 'virtual:void-pages-renderer' || id === 'virtual:void-pages-dev-assets') {
                return '\0' + id;
              }
              return null;
            },
            load(id) {
              if (id === '\0virtual:void-pages-renderer') {
                return `export async function renderPage(page) { return '<html><body>' + page.props.title + '</body></html>'; }
renderPage.preambleScript = ${JSON.stringify(preambleScript)};`;
              }
              if (id === '\0virtual:void-pages-dev-assets') {
                return 'export async function getVoidPagesDevCss() { return []; }';
              }
              return null;
            },
          },
        ],
        ssr: { noExternal: true },
        build: {
          outDir: output,
          emptyOutDir: true,
          ssr: entry,
          target: 'esnext',
          rollupOptions: {
            onwarn(warning, defaultHandler) {
              if (warning.code === 'IMPORT_IS_UNDEFINED') {
                undefinedImports.push(warning.message);
              }
              defaultHandler(warning);
            },
            external: [/^cloudflare:/, /^node:/],
            output: { entryFileNames: 'worker.mjs', codeSplitting: false },
          },
        },
      });
      expect(undefinedImports).toEqual([]);
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat'],
          modules: true,
          modulesRoot: output,
          scriptPath: join(output, 'worker.mjs'),
          bindings: { PUBLIC: 'public', __VOID_PROXY_TOKEN: 'secret' },
          assets: {
            directory: assets,
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
            assetConfig: { not_found_handling: 'none' },
          },
        }),
      );
      const hello = await runtime.dispatchFetch('https://app.test/hello');
      expect(await hello.json()).toEqual({ path: '/hello', rewritten: false, public: 'public' });
      expect(hello.headers.get('x-user-middleware')).toBe('ran');
      expect(hello.headers.get('x-edge-rule')).toBe('ran');
      const asset = await runtime.dispatchFetch('https://app.test/static/client-abcdefgh.js');
      expect(asset.headers.get('x-user-middleware')).toBe('ran');
      expect(asset.headers.get('x-edge-rule')).toBe('ran');
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      await expect(asset.text()).resolves.toBe('export const value = 1;');
      for (const [path, trace] of [
        ['/rewrite', 'rewrite[/rewrite]'],
        ['/move', 'c.rewrite'],
        ['/missing', 'fallback[/missing]'],
      ] as const) {
        const response = await runtime.dispatchFetch('https://app.test' + path);
        expect(await response.json()).toEqual({
          path: '/hello',
          original: path,
          rewritten: true,
          public: 'public',
        });
        if (dev) {
          expect(response.headers.get('X-Void-Routing')).toContain(trace);
        } else {
          expect(response.headers.has('X-Void-Routing')).toBe(false);
        }
      }
      const page = await runtime.dispatchFetch('https://app.test/');
      expect(await page.text()).toContain('real page loader');
      const clientOnlyPage = await runtime.dispatchFetch('https://app.test/client-only');
      const clientOnlyHtml = await clientOnlyPage.text();
      expect(clientOnlyPage.status).toBe(200);
      expect(clientOnlyHtml).toContain('data-void-ssr="false"');
      expect(clientOnlyHtml.includes('window.__fixturePreamble = true')).toBe(dev);
      const protocol = await runtime.dispatchFetch('https://app.test/', {
        headers: { 'x-voidpages': 'true' },
      });
      expect(((await protocol.json()) as { props: unknown }).props).toEqual({
        title: 'real page loader',
      });
      expect(
        await (await runtime.dispatchFetch('https://app.test/?save', { method: 'POST' })).text(),
      ).toBe('saved');
      const missing = await runtime.dispatchFetch('https://app.test/unknown');
      expect(missing.status).toBe(404);
      expect(missing.headers.get('X-Void-No-Match')).toBe('1');
      expect(await (await runtime.dispatchFetch('https://app.test/__void/ready')).json()).toEqual({
        ready: true,
      });
      // Path discovery answers only the build-time prerender runner, so the
      // deployed Worker treats it as an ordinary request, even with the proxy
      // token. This fixture has no binding handler, so the pages fallback answers.
      for (const headers of [{}, { 'x-void-internal': 'secret' }]) {
        const discovery = await runtime.dispatchFetch('https://app.test/__void/prerender-paths', {
          method: 'POST',
          headers,
        });
        expect(discovery.status).toBe(404);
        expect(await discovery.text()).not.toContain('"paths"');
      }
    },
  );
});
