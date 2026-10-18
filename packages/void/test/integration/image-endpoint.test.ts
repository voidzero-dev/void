import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Miniflare,
  convertV4MiniflareOptions,
  type Response as MiniflareResponse,
} from 'miniflare';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  hasHashedAssetFileNames,
  stampClientAssetCachePolicy,
} from '../../src/client-asset-manifest.ts';
import { resolveImageConfig } from '../../src/image-config.ts';
import type { ClientManifest } from '../../src/runtime/routing-assets.ts';

const runtimeSource = (file: string) => join(import.meta.dirname, '../../src/runtime', file);
const fixtures = join(import.meta.dirname, '../fixtures/images');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(fixtures, name)));

let directory: string;
let runtime: Miniflare | undefined;
let upstream: Server;
let upstreamOrigin: string;
let heroFile: string;

/** Width from a PNG's IHDR chunk. */
const pngWidth = (bytes: Uint8Array): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(16);
const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

async function image(
  query: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ response: MiniflareResponse; bytes: Uint8Array }> {
  const response = await runtime!.dispatchFetch(`https://app.test/_void/image?${query}`, {
    headers,
    method,
  });
  return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
}

const SAFARI = 'image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5';
const CHROME = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'void-image-endpoint-'));
  const clientRoot = join(directory, 'app');
  const assets = join(directory, 'client');
  const output = join(directory, 'output');
  mkdirSync(clientRoot);
  writeFileSync(join(clientRoot, 'package.json'), '{"type":"module"}');
  copyFileSync(join(fixtures, 'test.png'), join(clientRoot, 'hero.png'));
  writeFileSync(join(clientRoot, 'main.js'), 'import hero from "./hero.png"; window.hero = hero;');
  // A real client build proves the manifest key and file the stamping relies on.
  await build({
    root: clientRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stamp-image-cache-policy',
        generateBundle: {
          order: 'post',
          handler(_options, bundle: Rolldown.OutputBundle) {
            stampClientAssetCachePolicy(bundle, '.vite/manifest.json', [], {
              imageSources: ['hero.png'],
              hashedAssetFileNames: hasHashedAssetFileNames(
                this.environment.config.build.rollupOptions.output,
              ),
            });
          },
        },
      },
    ],
    build: {
      outDir: assets,
      emptyOutDir: true,
      manifest: true,
      assetsInlineLimit: 0,
      rollupOptions: { input: join(clientRoot, 'main.js') },
    },
  });
  const manifest = JSON.parse(
    readFileSync(join(assets, '.vite/manifest.json'), 'utf8'),
  ) as ClientManifest;
  heroFile = manifest['hero.png'].file!;
  expect(heroFile).toMatch(/^assets\/hero-[\w-]+\.png$/);
  expect(manifest['hero.png'].immutableFiles).toEqual([heroFile]);
  for (const file of ['test.png', 'test.jpg', 'test.webp', 'test.gif', 'animated.gif']) {
    copyFileSync(join(fixtures, file), join(assets, file));
  }
  writeFileSync(join(assets, 'index.html'), '<!doctype html><html><body>spa</body></html>');

  upstream = createServer((request, response) => {
    if (request.url === '/redirect.png') {
      response.writeHead(302, { location: '/remote.png' });
      response.end();
      return;
    }
    if (request.url === '/remote.png') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        // Above the default minimumCacheTTL (14400), so the response must use it.
        'cache-control': 'public, max-age=86400',
      });
      response.end(readFileSync(join(fixtures, 'test.png')));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const images = {
    formats: ['image/avif', 'image/webp'] as Array<'image/avif' | 'image/webp'>,
    remotePatterns: [{ protocol: 'http' as const, hostname: '127.0.0.1' }],
    dangerouslyAllowLocalIP: true,
  };
  const production = resolveImageConfig(images, { root: directory, dev: false });
  const development = resolveImageConfig(images, { root: directory, dev: true });
  const entry = join(directory, 'worker.ts');
  writeFileSync(
    entry,
    `
    import { Hono } from ${JSON.stringify(fileURLToPath(import.meta.resolve('hono')))};
    import { createImageHandler } from ${JSON.stringify(runtimeSource('routing.ts'))};
    import { withRuntimeEnv } from ${JSON.stringify(runtimeSource('env.ts'))};
    const app = new Hono();
    app.get('/_void/image', createImageHandler({ config: ${JSON.stringify(production)}, deploymentId: 'deployment-1' }));
    const dev = new Hono();
    dev.get('/_void/image', createImageHandler({ config: ${JSON.stringify(development)}, deploymentId: 'deployment-1' }));
    export default { fetch(request, env, ctx) {
      const target = request.headers.get('x-dev') ? dev : app;
      return withRuntimeEnv(env, () => target.fetch(request, env, ctx));
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
      images: { binding: 'IMAGES' },
      assets: {
        directory: assets,
        binding: 'ASSETS',
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
        assetConfig: { html_handling: 'none', not_found_handling: 'single-page-application' },
      },
    }),
  );
});

afterAll(async () => {
  await runtime?.dispose();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('/_void/image with a local Images binding', () => {
  it('resizes a PNG and never enlarges it', async () => {
    const resized = await image('url=/test.png&w=64&q=75', { accept: SAFARI });
    expect(resized.response.status).toBe(200);
    expect(resized.response.headers.get('content-type')).toBe('image/png');
    expect(pngWidth(resized.bytes)).toBe(64);
    expect(resized.response.headers.get('content-length')).toBe(String(resized.bytes.byteLength));
    expect(resized.response.headers.get('cache-control')).toBe(
      'public, max-age=14400, must-revalidate',
    );
    expect(resized.response.headers.get('vary')).toBe('Accept');
    expect(resized.response.headers.get('x-content-type-options')).toBe('nosniff');
    const larger = await image('url=/test.png&w=128&q=75', { accept: SAFARI });
    expect(pngWidth(larger.bytes)).toBe(100);
  });

  it.each<[string, string, string, string]>([
    ['/test.png', 'image/webp,*/*', 'image/webp', 'WEBP'],
    ['/test.png', CHROME, 'image/avif', 'ftypavif'],
    ['/test.jpg', SAFARI, 'image/jpeg', '\xff\xd8\xff'],
    ['/test.webp', SAFARI, 'image/jpeg', '\xff\xd8\xff'],
  ])('converts %s for Accept %s to %s', async (url, accept, type, magic) => {
    const { response, bytes } = await image(`url=${url}&w=64&q=75`, { accept });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    const header = ascii(bytes, 0, 12);
    expect(header).toContain(magic);
  });

  it('negotiates WebP instead of AVIF above 1200 pixels', async () => {
    const { response } = await image('url=/test.png&w=1920&q=75', { accept: CHROME });
    expect(response.headers.get('content-type')).toBe('image/webp');
  });

  it('serves animated and GIF sources unchanged', async () => {
    for (const file of ['animated.gif', 'test.gif']) {
      const { response, bytes } = await image(`url=/${file}&w=64&q=75`, { accept: SAFARI });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/gif');
      expect(bytes).toEqual(fixture(file));
    }
  });

  it('marks fingerprinted imports immutable and caches through caches.default', async () => {
    const query = `url=${encodeURIComponent('/' + heroFile)}&w=64&q=75`;
    const first = await image(query, { accept: SAFARI });
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('cache-control')).toBe(
      'public, max-age=315360000, immutable',
    );
    expect(pngWidth(first.bytes)).toBe(64);
    let second: Awaited<ReturnType<typeof image>> | undefined;
    // The cache write finishes after the response, through waitUntil.
    for (let attempt = 0; attempt < 20; attempt++) {
      second = await image(query, { accept: SAFARI });
      if (second.response.headers.get('x-void-image-cache') === 'HIT') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(second!.response.headers.get('x-void-image-cache')).toBe('HIT');
    expect(second!.bytes).toEqual(first.bytes);
    expect(second!.response.headers.get('etag')).toBe(first.response.headers.get('etag'));
    const plain = await image('url=/test.png&w=48&q=75', { accept: SAFARI });
    expect(plain.response.headers.get('cache-control')).toBe(
      'public, max-age=14400, must-revalidate',
    );
  });

  it('answers 304 for a matching ETag and HEAD without a body', async () => {
    const { response } = await image('url=/test.png&w=32&q=75', { accept: SAFARI });
    const etag = response.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]+"$/);
    // A browser revalidation. Without its own Cache-Control, undici adds `no-cache`, which never matches.
    const cached = await image('url=/test.png&w=32&q=75', {
      accept: SAFARI,
      'cache-control': 'max-age=0',
      'if-none-match': etag,
    });
    expect(cached.response.status).toBe(304);
    expect(cached.bytes.byteLength).toBe(0);
    expect(cached.response.headers.get('content-type')).toBeNull();
    const head = await image('url=/test.png&w=32&q=75', { accept: SAFARI }, 'HEAD');
    expect(head.response.status).toBe(200);
    expect(head.bytes.byteLength).toBe(0);
    expect(head.response.headers.get('content-type')).toBe('image/png');
  });

  it('rejects invalid parameters, SPA fallbacks and missing files', async () => {
    const invalid = await image('url=/test.png&w=1000&q=75');
    expect(invalid.response.status).toBe(400);
    expect(new TextDecoder().decode(invalid.bytes)).toBe(
      '"w" parameter (width) of 1000 is not allowed',
    );
    const page = await image('url=/missing.png&w=64&q=75');
    expect(page.response.status).toBe(400);
    expect(new TextDecoder().decode(page.bytes)).toBe(
      "The requested resource isn't a valid image.",
    );
  });

  it('fetches remote sources with manual redirects and the upstream max-age', async () => {
    for (const path of ['/remote.png', '/redirect.png']) {
      const { response, bytes } = await image(
        `url=${encodeURIComponent(upstreamOrigin + path)}&w=64&q=75`,
        { accept: SAFARI },
      );
      expect(response.status, new TextDecoder().decode(bytes)).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('public, max-age=86400, must-revalidate');
      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="${path.slice(1)}"`,
      );
      expect(pngWidth(bytes)).toBe(64);
    }
    const missing = await image(
      `url=${encodeURIComponent(upstreamOrigin + '/nope.png')}&w=64&q=75`,
    );
    expect(missing.response.status).toBe(404);
  });

  it('skips the cache and sends max-age=0 in development', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { response } = await image('url=/test.png&w=96&q=75', { accept: SAFARI, 'x-dev': '1' });
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(response.headers.get('x-void-image-cache')).toBe('MISS');
    }
  });
});
