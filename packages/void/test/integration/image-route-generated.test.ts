import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { resolveImageConfig } from '../../src/image-config.ts';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const runtimeSource = (file: string) => join(import.meta.dirname, '../../src/runtime', file);
const fixtures = join(import.meta.dirname, '../fixtures/images');

let directory: string;
let runtime: Miniflare | undefined;

const CHROME = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'void-image-route-'));
  const routes = join(directory, 'routes');
  const middleware = join(directory, 'middleware');
  const assets = join(directory, 'client');
  const output = join(directory, 'output');
  for (const path of [routes, middleware, assets, join(assets, 'members')]) {
    mkdirSync(path);
  }
  copyFileSync(join(fixtures, 'test.png'), join(assets, 'hero.png'));
  copyFileSync(join(fixtures, 'test.png'), join(assets, 'members', 'premium.png'));
  // The catch-all leaves .png paths to the static assets: a source the app
  // answers itself is what the endpoint optimizes.
  writeFileSync(
    join(routes, '[...path].ts'),
    `export function GET(c) { return c.req.path.endsWith('.png') ? c.notFound() : new Response('catch-all ' + c.req.path); }\nexport function POST() { return new Response('catch-all post'); }\n`,
  );
  writeFileSync(
    join(middleware, '01.headers.ts'),
    `export default async (c, next) => { await next(); c.header('x-user-middleware', 'ran'); };\n`,
  );
  writeFileSync(
    join(middleware, '02.members.ts'),
    `export default async (c, next) => { if (c.req.path.startsWith('/members/') && c.req.header('cookie') !== 'session=ok') return c.text('Unauthorized', 401); await next(); };\n`,
  );
  const scan: ScanResult = {
    routes: [
      {
        pattern: '/:path{.+}',
        filePath: '[...path].ts',
        params: ['path'],
        catchAll: true,
        env: null,
        methods: ['GET', 'POST'],
      },
    ],
    middleware: [
      { order: 1, filePath: '01.headers.ts' },
      { order: 2, filePath: '02.members.ts' },
    ],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };
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
        runtimeEnvPath: runtimeSource('env.ts'),
        projectRoot: directory,
        homeDir: tmpdir(),
        reactRefresh: false,
        auth: null,
        assetsDir: 'assets',
        images: { config: resolveImageConfig(undefined, { root: directory, dev: false }) },
      },
    ),
  );
  writeFileSync(entry, compileWorkerEntry({ runtimeEnvPath: runtimeSource('env.ts') }));
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'image-route-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('/dist/runtime/routing.mjs')) {
            return runtimeSource('routing.ts');
          }
          if (id === 'virtual:void-routes') {
            return routeTable;
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
        assetConfig: { not_found_handling: 'none' },
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  rmSync(directory, { recursive: true, force: true });
});

describe('image optimizer in a generated Worker', () => {
  it('serves /_void/image after user middleware and ahead of a catch-all route', async () => {
    const response = await runtime!.dispatchFetch(
      'https://app.test/_void/image?url=%2Fhero.png&w=64&q=75',
      { headers: { accept: CHROME } },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WEBP');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(response.headers.get('x-user-middleware')).toBe('ran');
  });

  it('applies middleware that guards the source path', async () => {
    const direct = await runtime!.dispatchFetch('https://app.test/members/premium.png');
    expect(direct.status).toBe(401);
    await direct.arrayBuffer();
    const member = await runtime!.dispatchFetch('https://app.test/members/premium.png', {
      headers: { cookie: 'session=ok' },
    });
    expect(member.status).toBe(200);
    await member.arrayBuffer();
    // The source request carries no cookies, as in Next.js, so even a member
    // cannot optimize a guarded file.
    for (const cookie of [undefined, 'session=ok']) {
      const response = await runtime!.dispatchFetch(
        'https://app.test/_void/image?url=%2Fmembers%2Fpremium.png&w=3840&q=75',
        { headers: { accept: CHROME, ...(cookie ? { cookie } : {}) } },
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(
        '"url" parameter is valid but internal response is invalid',
      );
    }
  });

  it('answers other methods itself instead of the catch-all route', async () => {
    const response = await runtime!.dispatchFetch(
      'https://app.test/_void/image?url=%2Fhero.png&w=64&q=75',
      { method: 'POST' },
    );
    expect(response.status).toBe(405);
    expect(await response.text()).not.toContain('catch-all');
  });

  it('leaves other paths to the app routes', async () => {
    const response = await runtime!.dispatchFetch('https://app.test/_void/other');
    expect(await response.text()).toBe('catch-all /_void/other');
  });
});
