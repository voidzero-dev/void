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

  it('ignores nested migrations managed by external tools', () => {
    const applicationRoot = root();
    source(
      applicationRoot,
      'db/migrations/20261127010000_init/migration.sql',
      'CREATE TABLE events (id TEXT);',
    );

    const analysis = analyzeApplicationSync(applicationRoot, { config: {} });

    expect(analysis.needsDatabase).toBe(false);
    expect(analysis.migrations).toEqual([]);
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
