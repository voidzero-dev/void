import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build, type Manifest } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import { renderGeneratedAssetHeaders, withAssetBypassRule } from '../../src/asset-worker-bypass.ts';
import { routingPlugin } from '../../src/plugin-routing.ts';

const runtimeSource = (file: string) => join(import.meta.dirname, '../../src/runtime', file);
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
    writeFileSync(
      join(assets, '_headers'),
      renderGeneratedAssetHeaders([
        'static/client-abcdefgh.js',
        'static/nested/chunk-abcdefgh.js',
      ])!,
    );
    const runWorkerFirst = withAssetBypassRule(['/**'], 'static')!;
    expect(runWorkerFirst).toEqual(['/**', '!/static/*']);
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

  it('keeps the default policy for unlisted files and does not cache misses', async () => {
    const unlisted = await bypass!.dispatchFetch('https://app.test/static/client.js');
    expect(unlisted.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(unlisted.headers.has('x-void-worker')).toBe(false);
    await unlisted.arrayBuffer();
    const missing = await bypass!.dispatchFetch('https://app.test/static/gone-abcdefgh.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control') ?? '').not.toContain('immutable');
    expect(missing.headers.has('x-void-worker')).toBe(false);
    await missing.arrayBuffer();
  });

  it('still sends other paths to the Worker', async () => {
    for (const path of ['/', '/api/x', '/static']) {
      const response = await bypass!.dispatchFetch(`https://app.test${path}`);
      expect(response.headers.get('x-void-worker')).toBe('1');
      await response.arrayBuffer();
    }
  });
});
