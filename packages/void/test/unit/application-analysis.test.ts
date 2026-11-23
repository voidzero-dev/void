import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplicationSync } from '../../src/application-analysis.ts';
import type { VoidConfig } from '../../src/config.ts';

const roots: Array<string> = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'void-analysis-'));
  roots.push(value);
  return value;
}

function source(root: string, path: string, code: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, code);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('shared application analysis', () => {
  it('requires no resources or paid features for an empty application', () => {
    const applicationRoot = root();
    const analysis = analyzeApplicationSync(applicationRoot, { config: {}, environment: 'prod' });
    expect(analysis).toMatchObject({
      root: applicationRoot,
      environment: 'prod',
      framework: undefined,
      dialect: 'sqlite',
      authEnabled: false,
      authConfigPath: null,
      needsDatabase: false,
      migrations: [],
      jobs: [],
      queues: [],
      websockets: [],
      allWebsockets: [],
      durableObjects: [],
      routes: [],
      middleware: [],
      email: { addresses: [] },
      bindings: {
        needsD1: false,
        needsKV: false,
        needsR2: false,
        needsAuth: false,
        needsQueues: false,
        needsAI: false,
        needsSandbox: false,
        needsLive: false,
        needsEmail: false,
        needsImages: false,
        usesImageOptimizer: false,
      },
    });
    expect(Object.values(analysis.reasons).every((reasons) => reasons.length === 0)).toBe(true);
  });

  it('resolves sourceDir inventories and auth dependencies while retaining custom binding names', () => {
    const applicationRoot = root();
    source(
      applicationRoot,
      'appsrc/routes/index.ts',
      'export const GET = (c) => c.env.KV.get("key");',
    );
    source(
      applicationRoot,
      'appsrc/auth.ts',
      'import { defineAuth } from "void/auth"; export default defineAuth({});',
    );
    source(applicationRoot, 'appsrc/db/migrations/002.sql', 'CREATE TABLE second (id TEXT);');
    source(applicationRoot, 'appsrc/db/migrations/001.sql', 'CREATE TABLE first (id TEXT);');
    source(applicationRoot, 'appsrc/db/migrations/seed.sql', 'INSERT INTO first VALUES ("seed");');
    source(
      applicationRoot,
      'appsrc/crons/cleanup.ts',
      'export const cron = "0 * * * *"; export default () => {};',
    );
    source(
      applicationRoot,
      'appsrc/queues/events.ts',
      'export const maxBatchSize = 7; export default () => {};',
    );
    source(applicationRoot, 'appsrc/middleware/01.auth.ts', 'export default (_c, next) => next();');
    source(applicationRoot, 'appsrc/email/_default.ts', 'export default () => {};');
    source(applicationRoot, 'durable-objects/counter.ts', 'export default {};');
    const config: VoidConfig = {
      sourceDir: 'appsrc',
      inference: { bindings: { db: false, kv: 'CACHE', email: false } },
    };

    const analysis = analyzeApplicationSync(applicationRoot, { config });
    expect(analysis.config).toBe(config);
    expect(analysis.paths.sourceRoot).toBe(join(applicationRoot, 'appsrc').replaceAll('\\', '/'));
    expect(analysis.bindingNames).toEqual({ kv: 'CACHE' });
    expect(analysis.bindings).toMatchObject({
      needsD1: false,
      needsAuth: true,
      needsKV: true,
      needsEmail: false,
    });
    expect(analysis.authConfigPath).toBe(
      join(applicationRoot, 'appsrc/auth.ts').replaceAll('\\', '/'),
    );
    expect(analysis.needsDatabase).toBe(true);
    expect(analysis.migrations.map((migration) => migration.name)).toEqual(['001.sql', '002.sql']);
    expect(analysis.jobs).toMatchObject([{ name: 'cleanup', crons: ['0 * * * *'] }]);
    expect(analysis.queues).toMatchObject([
      { name: 'events', bindingName: 'QUEUE_EVENTS', maxBatchSize: 7 },
    ]);
    expect(analysis.middleware).toEqual([{ order: 1, filePath: '01.auth.ts' }]);
    expect(analysis.email.defaultHandler).toBe('_default.ts');
    expect(analysis.durableObjects).toMatchObject([
      { bindingName: 'COUNTER', className: 'CounterDurableObject' },
    ]);
    expect(analysis.reasons.database).toEqual([
      'auth requires a D1 database',
      'checked-in migrations need a D1 database',
    ]);
  });

  it('includes migration-only database requirements without inventing source inference', () => {
    const applicationRoot = root();
    source(applicationRoot, 'db/migrations/001.sql', 'CREATE TABLE events (id TEXT);');
    const analysis = analyzeApplicationSync(applicationRoot, { config: { database: 'pg' } });
    expect(analysis.dialect).toBe('postgresql');
    expect(analysis.bindings.needsD1).toBe(false);
    expect(analysis.needsDatabase).toBe(true);
    expect(analysis.reasons.database).toEqual(['checked-in migrations need a Hyperdrive database']);
    expect(analyzeApplicationSync(root(), { config: { database: 'mysql' } }).needsDatabase).toBe(
      false,
    );
  });

  it('filters source bindings and routes by environment while keeping stable WebSocket reservations', () => {
    const applicationRoot = root();
    source(
      applicationRoot,
      'routes/debug.dev.ts',
      'import { storage } from "void/storage"; export const GET = () => storage.list();',
    );
    source(
      applicationRoot,
      'routes/index.prod.ts',
      'import { kv } from "void/kv"; export const GET = () => kv.get("key");',
    );
    source(
      applicationRoot,
      'routes/chat.dev.ws.ts',
      'import { defineWebSocket } from "void/ws"; export default defineWebSocket({});',
    );
    source(
      applicationRoot,
      'routes/chat.prod.ws.ts',
      'import { defineWebSocket } from "void/ws"; export default defineWebSocket({});',
    );
    const prod = analyzeApplicationSync(applicationRoot, { config: {}, environment: 'prod' });
    const dev = analyzeApplicationSync(applicationRoot, { config: {}, environment: 'dev' });
    expect(prod.bindings).toMatchObject({ needsR2: false, needsKV: true });
    expect(dev.bindings).toMatchObject({ needsR2: true, needsKV: false });
    expect(prod.routes.map((route) => route.filePath)).toEqual(['index.prod.ts']);
    expect(dev.routes.map((route) => route.filePath)).toEqual(['debug.dev.ts']);
    expect(prod.websockets.map((route) => route.filePath)).toEqual(['chat.prod.ws.ts']);
    expect(dev.websockets.map((route) => route.filePath)).toEqual(['chat.dev.ws.ts']);
    expect(prod.allWebsockets).toEqual(dev.allWebsockets);
    expect(prod.allWebsockets).toHaveLength(2);
    expect(prod.websockets[0]?.className).toBe(dev.websockets[0]?.className);
  });

  it('uses framework directories by default and honors custom directories without losing src helpers', () => {
    const applicationRoot = root();
    source(applicationRoot, 'package.json', JSON.stringify({ dependencies: { astro: '*' } }));
    source(applicationRoot, 'server/storage.ts', 'import { storage } from "void/storage";');
    source(applicationRoot, 'features/cache.ts', 'import { kv } from "void/kv";');
    source(applicationRoot, 'src/ai.ts', 'import { ai } from "void/ai";');
    const detected = analyzeApplicationSync(applicationRoot, { config: {} });
    expect(detected.framework).toEqual({ name: 'astro', class: 'c' });
    expect(detected.bindings).toMatchObject({ needsR2: true, needsKV: false, needsAI: true });
    const custom = analyzeApplicationSync(applicationRoot, {
      config: { inference: { scanDirs: ['features'] } },
    });
    expect(custom.bindings).toMatchObject({ needsR2: false, needsKV: true, needsAI: true });
  });

  it('keeps auth, Live and configured Sandbox when overriding an unrelated binding', () => {
    const applicationRoot = root();
    source(
      applicationRoot,
      'src/features.ts',
      'import { auth } from "void/client"; import { defineLiveStream } from "void/live";',
    );
    const analysis = analyzeApplicationSync(applicationRoot, {
      config: { sandbox: true, inference: { bindings: { kv: false } } },
    });
    expect(analysis.bindings).toMatchObject({
      needsKV: false,
      needsAuth: true,
      needsLive: true,
      needsSandbox: true,
    });
    expect(analysis.authEnabled).toBe(true);
    expect(analysis.needsDatabase).toBe(true);
  });

  it('explains explicitly enabled resources without inventing source usage', () => {
    const analysis = analyzeApplicationSync(root(), {
      config: {
        inference: {
          bindings: { db: 'CUSTOM_DB', kv: true, storage: true, ai: true, email: true },
        },
      },
    });
    expect(analysis.bindingNames).toEqual({ d1: 'CUSTOM_DB' });
    expect(analysis.bindings).toMatchObject({ needsAI: true, needsEmail: true });
    expect(analysis.reasons).toMatchObject({
      database: ['inference.bindings.db enables a D1 database'],
      kv: ['inference.bindings.kv enables KV'],
      r2: ['inference.bindings.storage enables R2'],
    });
  });
});

describe('image optimizer analysis', () => {
  function imageApp(): string {
    const applicationRoot = root();
    source(
      applicationRoot,
      'pages/index.tsx',
      'import { Image } from "@void/react"; export default () => <Image src="/a.png" alt="" />;',
    );
    return applicationRoot;
  }

  it('requires the Images binding when a Void app renders Image with the default loader', () => {
    const analysis = analyzeApplicationSync(imageApp(), { config: {}, environment: 'prod' });
    expect(analysis.bindings).toMatchObject({ needsImages: true, usesImageOptimizer: true });
    expect(analysis.bindingNames).toBeUndefined();
  });

  it('requires the Images binding for next/image aliased to @void/react/image', () => {
    const applicationRoot = root();
    source(
      applicationRoot,
      'pages/index.tsx',
      'import Image from "next/image"; export default () => <Image src="/a.png" alt="" />;',
    );
    const analysis = analyzeApplicationSync(applicationRoot, { config: {}, environment: 'prod' });
    expect(analysis.bindings).toMatchObject({ needsImages: true, usesImageOptimizer: true });
  });

  it.each<[string, VoidConfig]>([
    ['unoptimized', { images: { unoptimized: true } }],
    ['a custom loader', { images: { loader: 'custom' } }],
    ['a loaderFile', { images: { loaderFile: './image-loader.ts' } }],
    ['the cloudflare loader', { images: { loader: 'cloudflare' } }],
    ['an image CDN loader', { images: { loader: 'imgix', path: 'https://example.imgix.net/' } }],
    ['a bare-origin path', { images: { path: 'https://images.example.com' } }],
    ['a Node target', { target: 'node' }],
    ['static output', { output: 'static' }],
  ])('does not require the Images binding with %s', (_name, config) => {
    const analysis = analyzeApplicationSync(imageApp(), { config, environment: 'prod' });
    expect(analysis.bindings).toMatchObject({ needsImages: false, usesImageOptimizer: true });
  });

  it('requires the Images binding behind a CDN path, which the app serves at its pathname', () => {
    const analysis = analyzeApplicationSync(imageApp(), {
      config: { images: { path: 'https://images.example.com/_void/image' } },
      environment: 'prod',
    });
    expect(analysis.bindings).toMatchObject({ needsImages: true, usesImageOptimizer: true });
  });

  it('keeps an env.IMAGES read when the optimizer is off', () => {
    const applicationRoot = imageApp();
    source(
      applicationRoot,
      'routes/api/thumb.ts',
      'export const GET = (c) => c.env.IMAGES.info(c.req.raw.body);',
    );
    const analysis = analyzeApplicationSync(applicationRoot, {
      config: { images: { unoptimized: true } },
    });
    expect(analysis.bindings.needsImages).toBe(true);
  });

  it('does not infer the Images binding from Image usage in framework apps', () => {
    const applicationRoot = root();
    source(applicationRoot, 'package.json', JSON.stringify({ dependencies: { astro: '*' } }));
    source(applicationRoot, 'src/components/Hero.tsx', 'import { Image } from "@void/react";');
    const analysis = analyzeApplicationSync(applicationRoot, { config: {} });
    expect(analysis.bindings).toMatchObject({ needsImages: false, usesImageOptimizer: true });
  });

  it('applies inference.bindings.images overrides and custom names', () => {
    const disabled = analyzeApplicationSync(imageApp(), {
      config: { inference: { bindings: { images: false } } },
    });
    expect(disabled.bindings.needsImages).toBe(false);

    const named = analyzeApplicationSync(root(), {
      config: { images: { unoptimized: true }, inference: { bindings: { images: 'PHOTOS' } } },
    });
    expect(named.bindings.needsImages).toBe(true);
    expect(named.bindingNames).toEqual({ images: 'PHOTOS' });
  });
});

describe('vinext image optimizer analysis', () => {
  function vinextApp(viteConfig: string, appRouter = false): string {
    const applicationRoot = root();
    source(applicationRoot, 'package.json', JSON.stringify({ dependencies: { vinext: '1.1.0' } }));
    source(applicationRoot, 'vite.config.ts', viteConfig);
    if (appRouter) {
      source(applicationRoot, 'app/page.tsx', 'export default () => null;');
    }
    return applicationRoot;
  }

  const optimizerConfig = (options = '') => `
    import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
    import vinext from "vinext";
    import { voidPlugin } from "void";
    export default { plugins: [voidPlugin(), vinext({ images: { optimizer: imagesOptimizer(${options}) } })] };
  `;

  it.each([false, true])(
    'requires the default Images binding for the Cloudflare optimizer (App Router: %s)',
    (appRouter) => {
      const analysis = analyzeApplicationSync(vinextApp(optimizerConfig(), appRouter), {
        config: {},
      });
      expect(analysis.framework?.name).toBe(appRouter ? 'vinext-app' : 'vinext-pages');
      expect(analysis.bindings.needsImages).toBe(true);
      expect(analysis.bindingNames).toBeUndefined();
    },
  );

  it('uses the binding name the optimizer reads', () => {
    const analysis = analyzeApplicationSync(vinextApp(optimizerConfig('{ binding: "PHOTOS" }')), {
      config: {},
    });
    expect(analysis.bindings.needsImages).toBe(true);
    expect(analysis.bindingNames).toEqual({ images: 'PHOTOS' });
  });

  it('lets inference.bindings.images override the detected optimizer', () => {
    const applicationRoot = vinextApp(optimizerConfig('{ binding: "PHOTOS" }'));
    const disabled = analyzeApplicationSync(applicationRoot, {
      config: { inference: { bindings: { images: false } } },
    });
    expect(disabled.bindings.needsImages).toBe(false);
    const named = analyzeApplicationSync(applicationRoot, {
      config: { inference: { bindings: { images: 'MEDIA' } } },
    });
    expect(named.bindings.needsImages).toBe(true);
    expect(named.bindingNames).toEqual({ images: 'MEDIA' });
  });

  it('does not require the Images binding without the Cloudflare optimizer', () => {
    const analysis = analyzeApplicationSync(
      vinextApp(
        'import vinext from "vinext"; import { voidPlugin } from "void"; export default { plugins: [voidPlugin(), vinext()] };',
      ),
      { config: {} },
    );
    expect(analysis.bindings.needsImages).toBe(false);
  });

  it.each([false, true])(
    'leaves next/image to vinext without the Cloudflare optimizer (App Router: %s)',
    (appRouter) => {
      const applicationRoot = vinextApp(
        'import vinext from "vinext"; import { voidPlugin } from "void"; export default { plugins: [voidPlugin(), vinext()] };',
        appRouter,
      );
      source(
        applicationRoot,
        appRouter ? 'app/hero.tsx' : 'pages/index.tsx',
        'import Image from "next/image"; export default () => <Image src="/a.png" alt="" />;',
      );
      const analysis = analyzeApplicationSync(applicationRoot, { config: {} });
      expect(analysis.framework?.name).toBe(appRouter ? 'vinext-app' : 'vinext-pages');
      expect(analysis.bindings.needsImages).toBe(false);
      expect(analysis.bindingNames).toBeUndefined();
    },
  );

  it('ignores the optimizer import outside vinext apps', () => {
    const applicationRoot = root();
    source(applicationRoot, 'vite.config.ts', optimizerConfig());
    const analysis = analyzeApplicationSync(applicationRoot, { config: {} });
    expect(analysis.framework).toBeUndefined();
    expect(analysis.bindings.needsImages).toBe(false);
  });
});
