import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build, type Manifest } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  renderCloudflareStaticEntry,
  stageCloudflareStaticAssets,
} from '../../../deploy-cloudflare/src/index.ts';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import {
  GENERATED_ASSET_HEADERS_MARKER,
  resolveAssetWorkerBypass,
  type AssetWorkerBypassFacts,
} from '../../src/asset-worker-bypass.ts';
import {
  planStaticEdgeRouting,
  type StaticEdgeRouting,
} from '../../src/cli/deploy-cloudflare-static.ts';
import type { RoutingConfig } from '../../src/config.ts';
import { routingPlugin } from '../../src/plugin-routing.ts';

const runtimeSource = (file: string) => join(import.meta.dirname, '../../src/runtime', file);

/** Facts of a build that qualifies for the asset Worker bypass. */
function bypassFacts(overrides: Partial<AssetWorkerBypassFacts>): AssetWorkerBypassFacts {
  return {
    runWorkerFirst: ['/**'],
    notFoundHandling: 'none',
    base: '/',
    hasMiddleware: false,
    authEnabled: false,
    liveEnabled: false,
    alwaysUseHttps: false,
    headerRuleCount: 0,
    redirectRuleCount: 0,
    fallbackRuleCount: 0,
    publicEdgeFiles: false,
    patterns: ['/'],
    assetsDir: 'assets',
    immutableFiles: [],
    ...overrides,
  };
}
let directory: string;
let runtime: Miniflare | undefined;
let clientAsset: string;
let cssAsset: string;
let privateAsset: string;
let customAsset: string;
let uncachedAsset: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'void-native-asset-policy-'));
  const assets = join(directory, 'client');
  const output = join(directory, 'output');
  const clientRoot = join(directory, 'app');
  const routingOptions = {
    getApplicationAnalysis: (environment: 'dev' | 'prod') =>
      analyzeApplicationSync(clientRoot, { config: {}, environment }),
    isAuthEnabled: () => false,
  };
  mkdirSync(clientRoot);
  writeFileSync(join(clientRoot, 'package.json'), '{"type":"module"}');
  writeFileSync(join(clientRoot, 'client.js'), 'import "./client.css"; window.value = 1;');
  writeFileSync(join(clientRoot, 'client.css'), 'body { color: red; }');
  for (const file of ['private', 'custom', 'uncached', 'app-settings']) {
    writeFileSync(join(clientRoot, `${file}.js`), `window.${file.replace('-', '_')} = 1;`);
  }
  mkdirSync(join(clientRoot, 'public'));
  writeFileSync(
    join(clientRoot, 'public/_headers'),
    '/static/uncached-*\n  Cache-Control: public, max-age=0, must-revalidate\n',
  );
  await build({
    root: clientRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      routingPlugin(clientRoot, routingOptions),
      {
        name: 'explicit-stable-css',
        buildStart() {
          this.emitFile({
            type: 'asset',
            name: 'app.css',
            originalFileName: 'app.css',
            fileName: 'static/app-settings.css',
            source: '.settings { color: blue; }',
          });
        },
      },
    ],
    build: {
      outDir: assets,
      emptyOutDir: true,
      assetsDir: 'static',
      rollupOptions: {
        input: Object.fromEntries(
          ['client', 'private', 'custom', 'uncached', 'app-settings'].map((name) => [
            name,
            join(clientRoot, `${name}.js`),
          ]),
        ),
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'app-settings' ? 'static/app-settings.js' : 'static/[name]-[hash].js',
          assetFileNames: 'static/[name]-[hash].[ext]',
        },
      },
    },
  });
  const manifest = JSON.parse(readFileSync(join(assets, '.vite/manifest.json'), 'utf8'));
  clientAsset = manifest['client.js'].file;
  cssAsset = manifest['client.js'].css[0];
  privateAsset = manifest['private.js'].file;
  customAsset = manifest['custom.js'].file;
  uncachedAsset = manifest['uncached.js'].file;
  expect(manifest['uncached.js']).not.toHaveProperty('immutableFiles');
  expect(manifest['client.js'].immutableFiles).toEqual([clientAsset]);
  expect(manifest['app.css'].file).toBe('static/app-settings.css');
  expect(manifest['app.css']).not.toHaveProperty('immutableFiles');
  expect(manifest['app-settings.js'].file).toBe('static/app-settings.js');
  expect(manifest['app-settings.js']).not.toHaveProperty('immutableFiles');
  const stableOutput = join(directory, 'stable-client');
  await build({
    root: clientRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [routingPlugin(clientRoot, routingOptions)],
    build: {
      outDir: stableOutput,
      assetsDir: 'static',
      rollupOptions: {
        input: join(clientRoot, 'client.js'),
        output: {
          entryFileNames: 'static/[name]-settings.js',
          assetFileNames: 'static/[name]-settings.[ext]',
        },
      },
    },
  });
  const stableManifest = JSON.parse(
    readFileSync(join(stableOutput, '.vite/manifest.json'), 'utf8'),
  ) as Manifest;
  // A single-input build can use a synthetic manifest key. Verify the emitted
  // entry and its stable filenames rather than assuming its source-path key.
  const stableEntries = Object.values(stableManifest).filter((entry) => entry.isEntry);
  expect(stableEntries).toHaveLength(1);
  const [stableEntry] = stableEntries;
  expect(stableEntry).toMatchObject({
    file: 'static/client-settings.js',
    css: ['static/client-settings.css'],
  });
  expect(stableEntry).not.toHaveProperty('immutableFiles');
  for (const file of [stableEntry.file, ...stableEntry.css!]) {
    writeFileSync(join(assets, file), readFileSync(join(stableOutput, file)));
  }
  writeFileSync(
    join(assets, '.vite/manifest.json'),
    JSON.stringify({ ...manifest, stable: stableEntry }),
  );
  mkdirSync(join(assets, 'static'), { recursive: true });
  for (const file of ['app-settings.json', 'client.js', 'page-abcdefgh.html']) {
    writeFileSync(
      join(assets, 'static', file),
      file.endsWith('.html') ? '<html>asset</html>' : 'export const value = 1;',
    );
  }
  writeFileSync(
    join(assets, '_headers'),
    `/${privateAsset}\n  Cache-Control: private, no-store\n/${customAsset}\n  Cache-Control: public, max-age=120\n/${uncachedAsset}\n  Cache-Control: public, max-age=0, must-revalidate\n`,
  );
  const entry = join(directory, 'worker.ts');
  writeFileSync(
    entry,
    `
    import { Hono } from ${JSON.stringify(fileURLToPath(import.meta.resolve('hono')))};
    import { createPagesFallback, createSsrFallback, createAssetNotFound } from ${JSON.stringify(runtimeSource('routing-pages.ts'))};
    import { applyAssetCachePolicy, createAssetFallback } from ${JSON.stringify(runtimeSource('routing-worker.ts'))};
    import { createRoutingRuntime } from ${JSON.stringify(runtimeSource('routing.ts'))};
    import { createErrorRenderer } from ${JSON.stringify(runtimeSource('routing-errors.ts'))};
    const apps = {};
    for (const mode of ['pages', 'ssr', 'static']) {
      const app = new Hono();
      const routing = createRoutingRuntime(app, {});
      app.use(routing.contextMiddleware);
      app.notFound(mode === 'pages'
        ? createPagesFallback({ routing, assetsDir: 'static', errors: createErrorRenderer({ projectRoot: '/fixture', homeDir: '/home' }) })
        : mode === 'ssr'
          ? createSsrFallback({ routing, assetsDir: 'static', load: async () => ({ render: () => new Response('document') }), assets: async () => ({ css: '', body: '', preloads: '' }) })
          : createAssetNotFound({ routing, assetsDir: 'static' }));
      apps[mode] = app;
    }
    const outer = createAssetFallback({ assetsDir: 'static' });
    export default { async fetch(request, env, context) {
      const url = new URL(request.url);
      if (url.pathname === '/cache-proof') {
        const key = new Request('https://cache.test/static/client-abcdefgh.js');
        await caches.default.put(key, new Response(new Uint8Array([1, 2, 3]), { headers: { 'cache-control': 'public, max-age=600' } }));
        const original = await caches.default.match(key);
        let immutable = false;
        try { original.headers.set('x-immutable-probe', '1'); } catch { immutable = true; }
        const result = applyAssetCachePolicy(key, original, 'static');
        return Response.json({ immutable, originalContentType: original.headers.get('content-type'), resultContentType: result.headers.get('content-type'), originalPolicy: original.headers.get('cache-control'), resultPolicy: result.headers.get('cache-control'), body: [...new Uint8Array(await result.arrayBuffer())] });
      }
      const mode = url.searchParams.get('mode') ?? 'pages';
      return mode === 'outer'
        ? outer(request, env, new Response('not found', { status: 404 }))
        : apps[mode].fetch(request, env, context);
    }};
  `,
  );
  await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: {
      outDir: output,
      emptyOutDir: true,
      ssr: entry,
      target: 'esnext',
      rollupOptions: {
        external: [/^cloudflare:/, /^node:/],
        output: { entryFileNames: 'worker.mjs', codeSplitting: false },
      },
    },
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: '2026-07-01',
      compatibilityFlags: ['nodejs_compat'],
      modules: true,
      modulesRoot: output,
      scriptPath: join(output, 'worker.mjs'),
      assets: {
        directory: assets,
        binding: 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: {
          html_handling: 'none',
          not_found_handling: 'none',
        },
      },
    }),
  );
});

afterAll(async () => {
  await runtime?.dispose();
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native asset cache policy in real Workers', () => {
  it.each(['pages', 'ssr', 'static', 'outer'])(
    'normalizes successful native ASSETS responses in %s',
    async (mode) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await runtime!.dispatchFetch(
          `https://app.test/${clientAsset}?mode=${mode}`,
        );
        expect(response.status, response.status === 200 ? undefined : await response.text()).toBe(
          200,
        );
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('content-type')).toContain('javascript');
        expect(await response.text()).toContain('value');
      }
      const css = await runtime!.dispatchFetch(`https://app.test/${cssAsset}?mode=${mode}`);
      expect(css.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(await css.text()).toContain('color');
    },
  );

  it.each(['pages', 'ssr', 'static', 'outer'])(
    'preserves authored privacy, unhashed/HTML defaults and missing files in %s',
    async (mode) => {
      for (const [file, policy] of [
        [privateAsset, 'private, no-store'],
        [customAsset, 'public, max-age=120'],
        [uncachedAsset, 'public, max-age=0, must-revalidate'],
        ['static/app-settings.json', 'public, max-age=0, must-revalidate'],
        ['static/app-settings.js', 'public, max-age=0, must-revalidate'],
        ['static/app-settings.css', 'public, max-age=0, must-revalidate'],
        ['static/client-settings.js', 'public, max-age=0, must-revalidate'],
        ['static/client-settings.css', 'public, max-age=0, must-revalidate'],
        ['static/client.js', 'public, max-age=0, must-revalidate'],
        ['static/page-abcdefgh.html', 'public, max-age=0, must-revalidate'],
      ]) {
        const response = await runtime!.dispatchFetch(`https://app.test/${file}?mode=${mode}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe(policy);
      }
      const missing = await runtime!.dispatchFetch(
        `https://app.test/static/missing-abcdefgh.js?mode=${mode}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
    },
  );

  it('wraps an immutable Cache API response without mutating its headers or consuming its body', async () => {
    const response = await runtime!.dispatchFetch('https://app.test/cache-proof');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      immutable: true,
      originalContentType: null,
      resultContentType: 'text/javascript; charset=utf-8',
      originalPolicy: 'public, max-age=600',
      resultPolicy: 'public, max-age=600',
      body: [1, 2, 3],
    });
  });
});

describe('native asset Worker bypass in real Workers', () => {
  let bypassDirectory: string;
  let bypass: Miniflare | undefined;

  beforeAll(async () => {
    bypassDirectory = mkdtempSync(join(tmpdir(), 'void-native-asset-bypass-'));
    const assets = join(bypassDirectory, 'client');
    mkdirSync(join(assets, 'static', 'nested'), { recursive: true });
    for (const file of ['client-abcdefgh.js', 'client.js', 'nested/chunk-abcdefgh.js']) {
      writeFileSync(join(assets, 'static', file), 'export const value = 1;');
    }
    const plan = resolveAssetWorkerBypass(
      bypassFacts({
        assetsDir: 'static',
        immutableFiles: ['static/client-abcdefgh.js', 'static/nested/chunk-abcdefgh.js'],
      }),
    )!;
    writeFileSync(join(assets, '_headers'), plan.headers!);
    const runWorkerFirst = plan.runWorkerFirst;
    expect(runWorkerFirst).toEqual([
      '/**',
      '!/static/client-abcdefgh.js',
      '!/static/nested/chunk-abcdefgh.js',
    ]);
    bypass = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        modules: true,
        script: `export default { async fetch(request, env) {
          const asset = await env.ASSETS.fetch(request);
          const response = new Response(asset.body, asset);
          response.headers.set('x-void-worker', '1');
          return response;
        } };`,
        assets: {
          directory: assets,
          binding: 'ASSETS',
          run_worker_first: runWorkerFirst,
          routerConfig: { has_user_worker: true },
          assetConfig: { html_handling: 'none', not_found_handling: 'none' },
        },
      }),
    );
  });

  afterAll(async () => {
    await bypass?.dispose();
    if (bypassDirectory) {
      rmSync(bypassDirectory, { recursive: true, force: true });
    }
  });

  it('serves listed chunks immutable without starting the Worker, even with cookies', async () => {
    for (const path of ['/static/client-abcdefgh.js', '/static/nested/chunk-abcdefgh.js']) {
      const response = await bypass!.dispatchFetch(`https://app.test${path}`, {
        headers: { cookie: '__Secure-better-auth.session_token=abc; _ga=1' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('etag')).toBeTruthy();
      expect(response.headers.has('x-void-worker')).toBe(false);
      await response.arrayBuffer();
    }
  });

  it('sends unlisted files and misses in the assets folder to the Worker', async () => {
    const unlisted = await bypass!.dispatchFetch('https://app.test/static/client.js');
    expect(unlisted.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(unlisted.headers.get('x-void-worker')).toBe('1');
    await unlisted.arrayBuffer();
    for (const path of ['/static/gone-abcdefgh.js', '/static/42', '/static/']) {
      const missing = await bypass!.dispatchFetch(`https://app.test${path}`);
      expect(missing.status, path).toBe(404);
      expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
      expect(missing.headers.get('x-void-worker'), path).toBe('1');
      await missing.arrayBuffer();
    }
  });

  it('still sends other paths to the Worker', async () => {
    for (const path of ['/', '/api/x', '/static']) {
      const response = await bypass!.dispatchFetch(`https://app.test${path}`);
      expect(response.headers.get('x-void-worker')).toBe('1');
      await response.arrayBuffer();
    }
  });
});

describe('native static edge Worker routing in real Workers', () => {
  const immutable = 'public, max-age=31536000, immutable';
  let staticDirectory: string;
  let site: Miniflare | undefined;
  let spa: Miniflare | undefined;
  let https: Miniflare | undefined;

  type StaticDeploy = { routing: StaticEdgeRouting; assets: string; output: string };

  /** Stage and bundle a static deploy as `runCloudflareStaticDeploy` does, marking Worker responses. */
  async function deployStaticSite(name: string, routing?: RoutingConfig): Promise<StaticDeploy> {
    const root = join(staticDirectory, name);
    const outputDir = join(root, 'dist');
    mkdirSync(join(outputDir, 'assets'), { recursive: true });
    writeFileSync(join(outputDir, 'index.html'), '<h1>Home</h1>');
    writeFileSync(join(outputDir, 'about.html'), '<h1>About</h1>');
    writeFileSync(join(outputDir, '404.html'), '<h1>Not found</h1>');
    writeFileSync(join(outputDir, 'assets/app-abcdefgh.js'), 'export const value = 1;');
    writeFileSync(join(outputDir, 'assets/plain.js'), 'export const value = 2;');
    writeFileSync(
      join(outputDir, '_headers'),
      `${GENERATED_ASSET_HEADERS_MARKER}\n/assets/app-abcdefgh.js\n  Cache-Control: ${immutable}\n`,
    );
    const edgeRouting = planStaticEdgeRouting({
      outputDir,
      appType: 'static',
      routing,
      htmlHandling: undefined,
    });
    const assets = join(root, 'assets');
    stageCloudflareStaticAssets({
      sourceDirectory: outputDir,
      destinationDirectory: assets,
      headers: edgeRouting.assetHeaders,
    });
    writeFileSync(
      join(root, 'static-edge.mjs'),
      renderCloudflareStaticEntry({
        runtimeImport: join(import.meta.dirname, '../../../edge/src/index.ts'),
        ...edgeRouting.entry,
        versionMetadataBinding: 'VERSION',
      }),
    );
    writeFileSync(
      join(root, 'worker.mjs'),
      `import edge from './static-edge.mjs';
      export default { async fetch(request, env, context) {
        const response = await edge.fetch(request, env, context);
        const marked = new Response(response.body, response);
        marked.headers.set('x-void-worker', '1');
        return marked;
      } };`,
    );
    const output = join(root, 'output');
    await build({
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: true },
      build: {
        outDir: output,
        emptyOutDir: true,
        ssr: join(root, 'worker.mjs'),
        target: 'esnext',
        rollupOptions: { output: { entryFileNames: 'worker.mjs', codeSplitting: false } },
      },
    });
    return { routing: edgeRouting, assets, output };
  }

  function startStaticSite(
    deploy: StaticDeploy,
    notFoundHandling: '404-page' | 'single-page-application',
  ): Miniflare {
    return new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        modules: true,
        modulesRoot: deploy.output,
        scriptPath: join(deploy.output, 'worker.mjs'),
        bindings: { VERSION: { id: 'version-1' } },
        assets: {
          directory: deploy.assets,
          binding: 'ASSETS',
          run_worker_first: deploy.routing.assetConfig.run_worker_first,
          routerConfig: { has_user_worker: true },
          assetConfig: {
            html_handling: 'auto-trailing-slash',
            not_found_handling: notFoundHandling,
          },
        },
      }),
    );
  }

  async function expectReadiness(runtime: Miniflare): Promise<void> {
    for (const headers of [{}, { 'sec-fetch-mode': 'navigate' }]) {
      const ready = await runtime.dispatchFetch('https://site.test/__void/ready', { headers });
      expect(ready.status).toBe(200);
      expect(ready.headers.get('x-void-worker')).toBe('1');
      expect(ready.headers.get('cache-control')).toBe('no-store');
      await expect(ready.json()).resolves.toEqual({ ready: true, versionId: 'version-1' });
    }
  }

  beforeAll(async () => {
    staticDirectory = mkdtempSync(join(tmpdir(), 'void-native-static-edge-'));
    const [plain, redirected] = await Promise.all([
      deployStaticSite('site'),
      deployStaticSite('https', { alwaysUseHttps: true }),
    ]);
    site = startStaticSite(plain, '404-page');
    // A SPA deploy only changes the asset layer's not-found handling.
    spa = startStaticSite(plain, 'single-page-application');
    https = startStaticSite(redirected, '404-page');
  });

  afterAll(async () => {
    await Promise.all([site?.dispose(), spa?.dispose(), https?.dispose()]);
    if (staticDirectory) {
      rmSync(staticDirectory, { recursive: true, force: true });
    }
  });

  it('serves pages, files and the 404 page without the Worker', async () => {
    for (const [path, body] of [
      ['/', '<h1>Home</h1>'],
      ['/about', '<h1>About</h1>'],
    ]) {
      const page = await site!.dispatchFetch(`https://site.test${path}`);
      expect(page.status, path).toBe(200);
      expect(page.headers.has('x-void-worker'), path).toBe(false);
      expect(await page.text()).toBe(body);
    }
    for (const [path, policy] of [
      ['/assets/app-abcdefgh.js', immutable],
      ['/assets/plain.js', 'public, max-age=0, must-revalidate'],
    ]) {
      const file = await site!.dispatchFetch(`https://site.test${path}`);
      expect(file.headers.get('cache-control'), path).toBe(policy);
      expect(file.headers.has('x-void-worker'), path).toBe(false);
      await file.arrayBuffer();
    }
    const missing = await site!.dispatchFetch('https://site.test/missing');
    expect(missing.status).toBe(404);
    expect(missing.headers.has('x-void-worker')).toBe(false);
    expect(await missing.text()).toBe('<h1>Not found</h1>');
    const post = await site!.dispatchFetch('https://site.test/', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.has('x-void-worker')).toBe(false);
    await post.arrayBuffer();
    await expectReadiness(site!);
  });

  it('serves SPA deep links from the shell without the Worker', async () => {
    for (const headers of [{}, { 'sec-fetch-mode': 'navigate' }]) {
      const link = await spa!.dispatchFetch('https://site.test/deep/link', { headers });
      expect(link.status).toBe(200);
      expect(link.headers.has('x-void-worker')).toBe(false);
      expect(await link.text()).toBe('<h1>Home</h1>');
    }
    await expectReadiness(spa!);
  });

  it('keeps the Worker in front of every request when a rule needs it', async () => {
    const redirect = await https!.dispatchFetch('http://site.test/about', { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('https://site.test/about');
    expect(redirect.headers.get('x-void-worker')).toBe('1');
    for (const path of ['/', '/assets/plain.js']) {
      const response = await https!.dispatchFetch(`https://site.test${path}`);
      expect(response.headers.get('x-void-worker'), path).toBe('1');
      await response.arrayBuffer();
    }
    const chunk = await https!.dispatchFetch('https://site.test/assets/app-abcdefgh.js');
    expect(chunk.headers.get('cache-control')).toBe(immutable);
    expect(chunk.headers.get('x-void-worker')).toBe('1');
    await chunk.arrayBuffer();
    await expectReadiness(https!);
  });
});

describe('native output: "static" pages in real Workers', () => {
  let hybridDirectory: string;
  let hybrid: Miniflare | undefined;

  beforeAll(async () => {
    hybridDirectory = mkdtempSync(join(tmpdir(), 'void-native-static-pages-'));
    const assets = join(hybridDirectory, 'client');
    mkdirSync(join(assets, 'assets'), { recursive: true });
    mkdirSync(join(assets, '_void', 'pages'), { recursive: true });
    // `output: "static"` prerenders every page, including the ones with a loader.
    for (const page of ['index', 'about', 'products', 'contact']) {
      writeFileSync(join(assets, `${page}.html`), `<h1>${page} file</h1>`);
    }
    writeFileSync(join(assets, '_void/pages/about.json'), '{"component":"about"}');
    writeFileSync(join(assets, 'vue.svg'), '<svg></svg>');
    // The `/proxy/*` route also answers `/proxy`, so this file must not.
    writeFileSync(join(assets, 'proxy.html'), '<h1>proxy file</h1>');
    writeFileSync(join(assets, 'assets/app-abcdefgh.js'), 'export const value = 1;');
    const plan = resolveAssetWorkerBypass(
      bypassFacts({
        patterns: ['/', '/about', '/products', '/contact', '/items/:id', '/api/hello', '/proxy/*'],
        immutableFiles: ['assets/app-abcdefgh.js'],
        serverPatterns: ['/products', '/contact', '/items/:id', '/api/hello', '/proxy/*'],
      }),
    )!;
    writeFileSync(join(assets, '_headers'), plan.headers!);
    hybrid = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        modules: true,
        script: `export default { async fetch(request, env) {
          const url = new URL(request.url);
          const response = url.pathname === '/__void/ready'
            ? Response.json({ ready: true })
            : request.method !== 'GET'
              ? new Response('action ran')
              : url.pathname === '/products'
                ? new Response('<h1>products live</h1>')
                : await env.ASSETS.fetch(request);
          const marked = new Response(response.body, response);
          marked.headers.set('x-void-worker', '1');
          return marked;
        } };`,
        assets: {
          directory: assets,
          binding: 'ASSETS',
          run_worker_first: plan.runWorkerFirst,
          routerConfig: { has_user_worker: true },
          assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'none' },
        },
      }),
    );
  });

  afterAll(async () => {
    await hybrid?.dispose();
    if (hybridDirectory) {
      rmSync(hybridDirectory, { recursive: true, force: true });
    }
  });

  it('serves pages without server code, public files, page data and chunks without the Worker', async () => {
    for (const [path, body] of [
      ['/', '<h1>index file</h1>'],
      ['/about', '<h1>about file</h1>'],
      ['/vue.svg', '<svg></svg>'],
      ['/_void/pages/about.json', '{"component":"about"}'],
    ]) {
      const response = await hybrid!.dispatchFetch(`https://app.test${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.has('x-void-worker'), path).toBe(false);
      expect(await response.text(), path).toBe(body);
    }
    const chunk = await hybrid!.dispatchFetch('https://app.test/assets/app-abcdefgh.js');
    expect(chunk.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(chunk.headers.has('x-void-worker')).toBe(false);
    await chunk.arrayBuffer();
  });

  it('sends pages with server code, routes, misses and /__void to the Worker', async () => {
    const products = await hybrid!.dispatchFetch('https://app.test/products');
    expect(products.headers.get('x-void-worker')).toBe('1');
    expect(await products.text()).toBe('<h1>products live</h1>');
    const action = await hybrid!.dispatchFetch('https://app.test/contact', { method: 'POST' });
    expect(action.headers.get('x-void-worker')).toBe('1');
    expect(await action.text()).toBe('action ran');
    for (const path of [
      '/items/42',
      '/api/hello',
      '/proxy',
      '/proxy/a/b',
      '/missing',
      '/__void/ready',
    ]) {
      const response = await hybrid!.dispatchFetch(`https://app.test${path}`);
      expect(response.headers.get('x-void-worker'), path).toBe('1');
      await response.arrayBuffer();
    }
  });

  it('answers a POST to a page without server code from the asset layer', async () => {
    const response = await hybrid!.dispatchFetch('https://app.test/about', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.has('x-void-worker')).toBe(false);
    await response.arrayBuffer();
  });
});
