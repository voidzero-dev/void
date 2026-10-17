import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createServer as createPgServer } from 'pglite-server';
import { parseSync } from 'vite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  cleanupWrapper,
  needsWrapper,
  generateWrapper,
  selectBundledEntryFilename,
} from '../../src/cli/wrapper.ts';
import type { WrapperFeatures } from '../../src/cli/wrapper.ts';
import { startFakeMySqlServer } from '../helpers/fake-mysql-server.ts';

const base: WrapperFeatures = {
  crons: [],
  queues: [],
};

describe('repeated wrapper generation', () => {
  const roots: Array<string> = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the served framework version through its authored metadata binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-version-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      'export default { fetch() { throw new Error("app reached"); } };',
    );
    await generateWrapper(root, 'index.mjs', root, {
      ...base,
      readiness: true,
      versionMetadataBinding: 'AUTHORED_VERSION',
    });
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    const response = await worker.fetch(
      new Request('https://app.example/__void/ready', {
        headers: { 'Cloudflare-Workers-Version-Overrides': 'app="new-version"' },
      }),
      { AUTHORED_VERSION: { id: 'old-version', tag: 'private-tag' } },
      {},
    );
    expect(await response.json()).toEqual({ ready: true, versionId: 'old-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(
      await (await worker.fetch(new Request('https://app.example/__void/ready'), {}, {})).json(),
    ).toEqual({ ready: true });
  });

  it('preserves the real application across repeated skip-build preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-repeat-wrapper-'));
    roots.push(root);
    const original = 'export default { fetch() { return new Response("application"); } };';
    writeFileSync(join(root, 'index.mjs'), original);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(original);
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    expect(await (await worker.fetch(new Request('https://app/'), {}, {})).text()).toBe(
      'application',
    );
    expect((await worker.fetch(new Request('https://app/__void/ready'), {}, {})).status).toBe(200);
  });

  it('keeps the named exports of the wrapped entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-exports-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      'export class Counter {}\nexport default { fetch() { return new Response("app"); } };',
    );
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    const wrapped = await import(pathToFileURL(join(root, 'index.mjs')).href);
    // Cloudflare rejects an upload whose Durable Object class is not exported.
    expect(Object.keys(wrapped).sort()).toEqual(['Counter', 'default']);
    expect(wrapped.Counter.name).toBe('Counter');
  });

  it("keeps the entry's own default handlers", async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-handlers-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      'export default { fetch() { return new Response("app"); }, scheduled() { return "cron"; }, email() { return "mail"; } };',
    );
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    expect(worker.scheduled()).toBe('cron');
    expect(worker.email()).toBe('mail');
    expect((await worker.fetch(new Request('https://app/__void/ready'), {}, {})).status).toBe(200);
  });

  it('fails readiness when the wrapped entry has no fetch handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-no-fetch-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      'export default function handler() { return new Response("bare"); }',
    );
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
    const response = await worker.fetch(new Request('https://app/__void/ready'), {}, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      error: 'worker entry has no fetch handler',
    });
  });

  it('serves cached framework HTML while leaving client data requests live', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-framework-isr-'));
    roots.push(root);
    writeFileSync(
      join(root, 'index.mjs'),
      `export default {
      fetch(request, env) {
        env.renders++;
        return request.headers.get('accept') === 'application/json'
          ? Response.json({ live: env.renders })
          : new Response('<html>page</html>', { headers: { 'content-type': 'text/html' } });
      }
    };`,
    );
    const kvStore = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
    const edgeStore = new Map<string, Response>();
    const env = {
      renders: 0,
      ISR_CACHE: {
        getWithMetadata: async (key: string) => kvStore.get(key) ?? { value: null, metadata: null },
        put: async (key: string, value: ArrayBuffer, options?: { metadata?: unknown }) => {
          kvStore.set(key, { value, metadata: options?.metadata ?? null });
        },
        delete: async (key: string) => {
          kvStore.delete(key);
        },
        list: async () => ({ keys: [], list_complete: true, cursor: '' }),
      },
    };
    vi.stubGlobal('caches', {
      default: {
        match: async (key: string) => edgeStore.get(key)?.clone(),
        put: async (key: string, response: Response) => {
          edgeStore.set(key, response);
        },
        delete: async (key: string) => edgeStore.delete(key),
      },
    });
    try {
      await generateWrapper(root, 'index.mjs', root, { ...base, isr: { revalidate: 60 } });
      const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
      const tasks: Array<Promise<unknown>> = [];
      const ctx = {
        waitUntil: (task: Promise<unknown>) => {
          tasks.push(task);
        },
      };
      const document = new Request('https://app.test/news', { headers: { accept: 'text/html' } });

      const first = await worker.fetch(document, env, ctx);
      expect(first.headers.get('x-isr-cache')).toBe('MISS');
      await Promise.all(tasks);
      const second = await worker.fetch(document, env, ctx);
      expect(second.headers.get('x-isr-cache')).toBe('HIT');
      expect(env.renders).toBe(1);

      const data = await worker.fetch(
        new Request('https://app.test/news', { headers: { accept: 'application/json' } }),
        env,
        ctx,
      );
      expect(await data.json()).toEqual({ live: 2 });
      expect(env.renders).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the entry intact when compiling handlers fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-failed-wrapper-'));
    roots.push(root);
    const original = 'export default { fetch() { return new Response("application"); } };';
    writeFileSync(join(root, 'index.mjs'), original);
    await expect(
      generateWrapper(root, 'index.mjs', root, {
        ...base,
        crons: [{ name: 'missing', filePath: 'missing.ts', crons: ['* * * * *'] }],
      }),
    ).rejects.toThrow();
    expect(readFileSync(join(root, 'index.mjs'), 'utf8')).toBe(original);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(original);
  });

  it('recognizes legacy wrappers and refreshes the original after a new build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-legacy-wrapper-'));
    roots.push(root);
    const original = 'export default { fetch() { return new Response("first"); } };';
    writeFileSync(join(root, 'index.mjs'), original);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    const legacy = readFileSync(join(root, 'index.mjs'), 'utf8').replace(
      /^\/\/ Generated[^\n]*\n/,
      '',
    );
    writeFileSync(join(root, 'index.mjs'), legacy);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(original);
    const rebuilt = original.replace('first', 'second');
    writeFileSync(join(root, 'index.mjs'), rebuilt);
    await generateWrapper(root, 'index.mjs', root, { ...base, readiness: true });
    expect(readFileSync(join(root, '__original.mjs'), 'utf8')).toBe(rebuilt);
  });

  it('requires a rebuild if an older repeated deploy already destroyed the original', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-corrupt-wrapper-'));
    roots.push(root);
    const wrapper =
      'import original from "./__original.mjs";\nexport default { fetch: original.fetch };';
    writeFileSync(join(root, 'index.mjs'), wrapper);
    writeFileSync(join(root, '__original.mjs'), wrapper);
    await expect(
      generateWrapper(root, 'index.mjs', root, { ...base, readiness: true }),
    ).rejects.toThrow('Rebuild');
  });
});

describe('needsWrapper', () => {
  it('returns false when no features are set', () => {
    expect(needsWrapper(base)).toBe(false);
  });

  it('returns true when crons are present', () => {
    expect(
      needsWrapper({
        ...base,
        crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
      }),
    ).toBe(true);
  });

  it('returns true when queues are present', () => {
    expect(
      needsWrapper({
        ...base,
        queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'EMAILS' }],
      }),
    ).toBe(true);
  });

  it('returns true when hasMigrations is set', () => {
    expect(needsWrapper({ ...base, hasMigrations: true })).toBe(true);
  });

  it('returns true when deployment readiness is required', () => {
    expect(needsWrapper({ ...base, readiness: true })).toBe(true);
  });

  it('returns false when hasMigrations is false', () => {
    expect(needsWrapper({ ...base, hasMigrations: false })).toBe(false);
  });
});

describe('selectBundledEntryFilename', () => {
  it('selects the exact bundled entry when index-prefixed chunks sort first', () => {
    expect(selectBundledEntryFilename(['index-server-Bo4VDtw5.js', 'index.js'])).toBe('index.js');
  });

  it('throws a helpful error when no exact bundled entry exists', () => {
    expect(() => selectBundledEntryFilename(['index-server-Bo4VDtw5.js'])).toThrow(
      'deploy: Bundled worker entry not found',
    );
  });
});

describe('cleanupWrapper', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the linked project config needed by remote commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-cleanup-'));
    roots.push(root);

    const voidDir = join(root, '.void');
    const projectFile = join(voidDir, 'project.json');
    const temporaryDirectories = ['handlers', 'migration-handler', 'isr', 'bundle'];
    for (const directory of temporaryDirectories) {
      mkdirSync(join(voidDir, directory), { recursive: true });
      writeFileSync(join(voidDir, directory, 'generated.js'), 'export default {};');
    }
    writeFileSync(projectFile, JSON.stringify({ projectId: 'proj_123', slug: 'speakers' }));
    writeFileSync(join(voidDir, 'dev-trigger-token'), 'stable-token');

    cleanupWrapper(root);

    expect(existsSync(projectFile)).toBe(true);
    expect(readFileSync(join(voidDir, 'dev-trigger-token'), 'utf-8')).toBe('stable-token');
    for (const directory of temporaryDirectories) {
      expect(existsSync(join(voidDir, directory))).toBe(false);
    }
  });
});

describe('generated wrapper queue dispatch', () => {
  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function createRelayWorker() {
    const root = mkdtempSync(join(tmpdir(), 'void-queue-relay-'));
    roots.push(root);
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(root, 'index.mjs'),
      'export default { fetch() { return Response.json({ app: true }); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      `export default function(batch, env) {
      env.calls.push(batch.messages[0].timestamp.getTime());
      batch.messages[0].ack();
      if (env.fail) throw new Error('after first message');
      batch.messages[0].retry();
      batch.messages[1].retry({ delaySeconds: 9 });
      batch.ackAll();
    }`,
    );
    await generateWrapper(root, 'index.mjs', root, {
      ...base,
      queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' }],
    });
    return (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
  }

  const relayRequest = (token?: string) =>
    new Request('https://worker/__void/queue', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-void-internal': token } : {}),
      },
      body: JSON.stringify({
        queue: 'emails',
        messages: ['one', 'two'].map((id) => ({
          id,
          timestamp: '2026-01-01T00:00:00Z',
          body: {},
          attempts: 1,
        })),
      }),
    });

  it('delivers managed HTTP batches and returns first-wins acknowledgment decisions', async () => {
    const worker = await createRelayWorker();
    const env = { __VOID_PROXY_TOKEN: 'token', calls: [] as Array<number> };
    const response = await worker.fetch(relayRequest('token'), env, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      decisions: {
        one: { action: 'ack' },
        two: { action: 'retry', delaySeconds: 9 },
      },
    });
    expect(env.calls).toEqual([Date.parse('2026-01-01T00:00:00Z')]);
    const failed = await worker.fetch(relayRequest('token'), { ...env, fail: true }, {});
    expect(await failed.json()).toEqual({ ok: false, decisions: { one: { action: 'ack' } } });
    expect((await worker.fetch(new Request('https://worker/__void/ready'), env, {})).status).toBe(
      200,
    );
  });

  it('requires a configured token before invoking a managed queue consumer', async () => {
    const worker = await createRelayWorker();
    const calls: Array<number> = [];
    for (const [request, env] of [
      [relayRequest(), { __VOID_PROXY_TOKEN: 'token', calls }],
      [relayRequest('wrong'), { __VOID_PROXY_TOKEN: 'token', calls }],
      [relayRequest('token'), { calls }],
    ] as const) {
      expect((await worker.fetch(request, env, {})).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it('uses exact or unique longest suffix matches and rejects unknown queues', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-queues-'));
    const workerDir = join(root, 'server');
    roots.push(root);
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      'export default async function(_batch, env) { env.calls.push("emails"); }',
    );
    writeFileSync(
      join(root, 'queues/order-emails.ts'),
      'export default async function(_batch, env) { env.calls.push("order-emails"); }',
    );

    await generateWrapper(workerDir, 'index.mjs', root, {
      ...base,
      queues: [
        { name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' },
        {
          name: 'order-emails',
          filePath: 'order-emails.ts',
          bindingName: 'CUSTOM_ORDER_EMAILS',
        },
      ],
    });

    const wrapper = (await import(
      `${pathToFileURL(join(workerDir, 'index.mjs')).href}?test=${crypto.randomUUID()}`
    )) as {
      default: {
        queue(
          batch: MessageBatch,
          env: { calls: Array<string> },
          ctx: ExecutionContext,
        ): Promise<void>;
      };
    };
    const makeBatch = (queue: string, retryAll = vi.fn()) =>
      ({
        queue,
        messages: [],
        ackAll: vi.fn(),
        retryAll,
      }) as unknown as MessageBatch;

    for (const [queue, expected] of [
      ['emails', 'emails'],
      ['project-emails', 'emails'],
      ['order-emails', 'order-emails'],
      ['project-order-emails', 'order-emails'],
    ]) {
      const env = { calls: [] as Array<string> };
      await wrapper.default.queue(makeBatch(queue), env, {} as ExecutionContext);
      expect(env.calls).toEqual([expected]);
    }

    const retryAll = vi.fn();
    const env = { calls: [] as Array<string> };
    await expect(
      wrapper.default.queue(makeBatch('project-unknown', retryAll), env, {} as ExecutionContext),
    ).rejects.toThrow('No unambiguous queue handler matches "project-unknown"');
    expect(retryAll).toHaveBeenCalledOnce();
    expect(env.calls).toEqual([]);
  });

  it('passes native queue messages, dates, and acknowledgment methods through unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-native-queue-'));
    roots.push(root);
    const workerDir = join(root, 'server');
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("app"); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      `export default async function(batch, env) {
      env.received = batch;
      env.timestamp = batch.messages[0].timestamp.getTime();
      batch.messages[0].ack();
      batch.messages[1].retry({ delaySeconds: 12 });
      batch.ackAll();
      batch.retryAll({ delaySeconds: 30 });
    }`,
    );
    await generateWrapper(workerDir, 'index.mjs', root, {
      ...base,
      queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' }],
    });
    const wrapper = (await import(pathToFileURL(join(workerDir, 'index.mjs')).href)).default;
    const timestamp = new Date('2026-01-01T00:00:00Z');
    const batch = {
      queue: 'emails',
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      messages: [
        { id: '1', body: {}, attempts: 1, timestamp, ack: vi.fn(), retry: vi.fn() },
        { id: '2', body: {}, attempts: 1, timestamp, ack: vi.fn(), retry: vi.fn() },
      ],
    };
    const env: { received?: unknown; timestamp?: number } = {};
    await wrapper.queue(batch, env, {});
    expect(env.received).toBe(batch);
    expect(env.timestamp).toBe(timestamp.getTime());
    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 12 });
    expect(batch.ackAll).toHaveBeenCalledOnce();
    expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 });
  });
});

// These tests bundle Workers and start workerd. Windows CI runners stall on disk and process start,
// so one test can take 20 seconds there. Keep the longer budget local to these tests.
const migrationTestTimeout = process.platform === 'win32' ? 60_000 : undefined;
describe('generateWrapper with migrations', { timeout: migrationTestTimeout }, () => {
  const roots: Array<string> = [];
  // Each new PGlite runs initdb, which can take seconds on CI. Run it once in this hook, with its
  // own budget; each PostgreSQL test loads a fresh database from the initialized data directory.
  let pgDataDir: Blob;
  beforeAll(
    async () => {
      const pglite = new PGlite();
      await pglite.waitReady;
      pgDataDir = await pglite.dumpDataDir('none');
      await pglite.close();
    },
    process.platform === 'win32' ? 30_000 : undefined,
  );
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createMigrationFixture(migration?: { name: string; sql: string }): {
    workerDir: string;
    projectRoot: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'void-wrapper-migrations-'));
    roots.push(root);
    const workerDir = join(root, 'server');
    const projectRoot = join(root, 'project');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'index.mjs'),
      'export default { fetch() { return new Response("ok"); } };',
    );
    mkdirSync(join(projectRoot, 'db', 'migrations'), { recursive: true });
    if (migration) {
      writeFileSync(join(projectRoot, 'db', 'migrations', migration.name), migration.sql);
    }
    return { workerDir, projectRoot };
  }

  it('embeds SQLite migrations, a self-contained handler and the readiness probe', async () => {
    const { workerDir, projectRoot } = createMigrationFixture({
      name: '001_create_users.sql',
      sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);',
    });

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'sqlite',
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).toContain('__migrations');
    expect(wrapper).toContain('001_create_users.sql');
    expect(wrapper).toContain('CREATE TABLE users');

    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).not.toMatch(/from\s+["']\.\.\//);
    expect(handler).not.toContain('../migrations/canonical-json');
    expect(handler).not.toContain('../canonical-json-');
    expect(handler).toContain('function canonicalJson');

    expect(wrapper).toMatch(/Response\.json\(\s*\{\s*ready:\s*true\s*\}\s*\)/);
    const readyIdx = wrapper.indexOf('/__void/ready');
    const originalIdx = wrapper.indexOf('original.fetch');
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(originalIdx).toBeGreaterThan(readyIdx);
  });

  it('uses PG migration handler when dialect is postgresql', async () => {
    const { workerDir, projectRoot } = createMigrationFixture({
      name: '001_test.sql',
      sql: 'CREATE TABLE test (id SERIAL PRIMARY KEY);',
    });

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'postgresql',
    });

    const handler = readFileSync(join(workerDir, '__void_migration_handler.mjs'), 'utf-8');
    expect(handler).not.toContain('import("pg")');
    expect(
      readdirSync(workerDir).some((file) => file.startsWith('__void_migration_handler-')),
    ).toBe(true);
    const bundled = readdirSync(workerDir)
      .map((file) => readFileSync(join(workerDir, file), 'utf-8'))
      .join('\n');
    expect(bundled).not.toContain('PGPASSFILE');
    expect(bundled).not.toContain('createReadStream');
    expect(bundled).not.toContain('__require("pgpass")');
    expect(bundled).not.toContain('createRequire(import.meta.url)');
    expect(bundled).not.toContain('createRequire("file:///__void_migration_handler.mjs")');
    expect(bundled).not.toContain('node:module');
    expect(bundled).not.toContain('empty module that is served up when outside of a workerd');
    expect(bundled).toContain('CloudflareSocket');
    expect(bundled).toContain('cloudflare:sockets');
    expect(bundled).toContain('node:events');
    expect(bundled).toContain('node:util/types');
    expect(bundled).toContain('"util/types": __voidNodeUtilTypes');
    expect(bundled).toContain('__voidNodeRequireModules');
    expect(bundled).toContain('__voidPgpassNoop');
  });

  /** Start the wrapped Worker in workerd, send one internal request and return its JSON body. */
  async function fetchWrappedWorker(
    workerDir: string,
    request: { path: string; body?: unknown },
    options: {
      bindings?: Record<string, unknown>;
      d1Databases?: Array<string>;
      compatibilityDate?: string;
    } = {},
  ): Promise<unknown> {
    // Upload every module, as the platform does; the wrapper imports the handler statically.
    const modules = readdirSync(workerDir)
      .filter((file) => file.endsWith('.mjs'))
      .sort((a, b) => Number(b === 'index.mjs') - Number(a === 'index.mjs'))
      .map((file) => ({ type: 'ESModule' as const, path: join(workerDir, file) }));
    let miniflare: Miniflare | undefined;
    try {
      miniflare = new Miniflare(
        convertV4MiniflareOptions({
          modulesRoot: workerDir,
          modules,
          compatibilityDate: options.compatibilityDate ?? '2026-02-24',
          compatibilityFlags: ['nodejs_compat'],
          bindings: { __VOID_PROXY_TOKEN: 'proxy-token', ...options.bindings },
          d1Databases: options.d1Databases,
        }),
      );
      const response = await miniflare.dispatchFetch(`http://localhost${request.path}`, {
        method: 'POST',
        headers: { 'x-void-internal': 'proxy-token', 'content-type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      return await response.json();
    } finally {
      await miniflare?.dispose();
    }
  }

  /** Run the wrapped MySQL Worker in workerd and return its `/__void/migrate` response body. */
  async function migrateMySqlInWorkerd(workerDir: string): Promise<unknown> {
    // The applied-migrations SELECT returns a row, so mysql2 also parses a result set.
    // No CLI run holds the named lock, so the deploy's lease is enough.
    const mysql = await startFakeMySqlServer((sql) =>
      sql.includes('IS_USED_LOCK') ? [{ holder: null }] : [{ name: '000_applied_elsewhere.sql' }],
    );
    try {
      return await fetchWrappedWorker(
        workerDir,
        { path: '/__void/migrate' },
        {
          bindings: {
            HYPERDRIVE: { connectionString: `mysql://void@127.0.0.1:${mysql.port}/app` },
          },
        },
      );
    } finally {
      await mysql.close();
    }
  }

  /**
   * npm, Yarn and Bun hoist dependencies into the app's node_modules, where the build finds them.
   * Copy each package there (copies, not symlinks, so this also runs on Windows).
   */
  function hoistIntoApp(projectRoot: string, packages: Record<string, string>): void {
    for (const [name, source] of Object.entries(packages)) {
      cpSync(realpathSync(source), join(projectRoot, 'node_modules', name), {
        recursive: true,
        filter: (path) => !path.endsWith(`${sep}node_modules`),
      });
    }
  }

  /** The dependencies of `packageName`, as they sit next to its installed copy. */
  function dependencyDirs(packageName: string): Record<string, string> {
    const packageJson = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
    const { dependencies } = JSON.parse(readFileSync(packageJson, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const installDir = dirname(dirname(realpathSync(packageJson)));
    return Object.fromEntries(
      Object.keys(dependencies).map((name) => [name, join(installDir, name)]),
    );
  }

  /** workerd loads only relative, `node:` and `cloudflare:` imports, and the shims serve built-ins. */
  function expectSelfContainedHandler(workerDir: string, optionalRequires: Array<string> = []) {
    for (const file of readdirSync(workerDir).filter((name) =>
      name.startsWith('__void_migration_handler'),
    )) {
      const code = readFileSync(join(workerDir, file), 'utf8');
      const { module } = parseSync(file, code);
      const imports = [
        ...module.staticImports.map((entry) => entry.moduleRequest.value),
        ...module.staticExports.flatMap((entry) =>
          entry.entries.flatMap((item) => (item.moduleRequest ? [item.moduleRequest.value] : [])),
        ),
      ];
      expect(imports.filter((id) => !/^(node:|cloudflare:|\.\/)/.test(id))).toEqual([]);
      const required = Array.from(
        code.matchAll(/\b__require\(\s*["']([^"']+)["']\s*\)/g),
        (match) => match[1]!,
      );
      expect(required.filter((id) => !isBuiltin(id) && !optionalRequires.includes(id))).toEqual([]);
    }
  }

  it('runs MySQL migrations from the wrapped Worker in workerd', async () => {
    const { workerDir, projectRoot } = createMigrationFixture({
      name: '001_test.sql',
      sql: 'CREATE TABLE test (id INT);',
    });
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'mysql',
    });

    expect(await migrateMySqlInWorkerd(workerDir)).toEqual({
      ok: true,
      migrations: [{ name: '001_test.sql', applied: true, durationMs: expect.any(Number) }],
    });
  });

  // npm, Yarn and Bun hoist mysql2's dependencies into the app's node_modules. The build finds
  // them there, so anything it does not bundle stays a require that workerd cannot load.
  it('bundles the mysql2 dependencies that sit in the app node_modules', async () => {
    const { workerDir, projectRoot } = createMigrationFixture({
      name: '001_test.sql',
      sql: 'CREATE TABLE test (id INT);',
    });
    hoistIntoApp(projectRoot, dependencyDirs('mysql2'));
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'mysql',
    });

    expect(await migrateMySqlInWorkerd(workerDir)).toEqual({
      ok: true,
      migrations: [{ name: '001_test.sql', applied: true, durationMs: expect.any(Number) }],
    });
    // mysql2 requires its optional `cardinal` inside try/catch.
    expectSelfContainedHandler(workerDir, ['cardinal']);
  });

  it('bundles the pg dependencies that sit in the app node_modules', async () => {
    const { workerDir, projectRoot } = createMigrationFixture({
      name: '001_test.sql',
      sql: 'CREATE TABLE test (id SERIAL PRIMARY KEY);',
    });
    hoistIntoApp(projectRoot, dependencyDirs('pg'));
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'postgresql',
    });

    const pglite = new PGlite({ loadDataDir: pgDataDir });
    // pglite-server does not wait for PGlite: a query that arrives during startup spins forever.
    await pglite.waitReady;
    const server = createPgServer(pglite);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      expect(
        await fetchWrappedWorker(
          workerDir,
          { path: '/__void/migrate' },
          {
            bindings: {
              HYPERDRIVE: { connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres` },
            },
          },
        ),
      ).toEqual({
        ok: true,
        migrations: [{ name: '001_test.sql', applied: true, durationMs: expect.any(Number) }],
      });
    } finally {
      server.close();
      await pglite.close();
    }
    expectSelfContainedHandler(workerDir);
  });

  it('bundles @void/deploy-core when it sits in the app node_modules', async () => {
    const { workerDir, projectRoot } = createMigrationFixture({
      name: '001_users.sql',
      sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);',
    });
    hoistIntoApp(projectRoot, {
      '@void/deploy-core': join(import.meta.dirname, '..', '..', '..', 'deploy-core'),
    });
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      hasMigrations: true,
      migrationDialect: 'sqlite',
    });

    expect(
      await fetchWrappedWorker(
        workerDir,
        { path: '/__void/migrate/app', body: { attemptId: 'attempt-1', deploymentId: 'dep-1' } },
        { d1Databases: ['DB'] },
      ),
    ).toMatchObject({ ok: true, confirmedApplied: ['001_users.sql'] });
    expectSelfContainedHandler(workerDir);
  });

  /**
   * An app whose cron, and with `queue` a queue consumer, reads its users through `void/db`.
   * The job throws unless each select and relational query, which needs the app's schema, returns
   * `users`. The last two run in parallel.
   */
  async function wrapUsersCron(
    database: 'pg' | 'mysql',
    users: Array<{ id: number; name: string }>,
    options: { schemaImport: string; schemaFolder?: boolean; queue?: boolean },
  ): Promise<string> {
    const { workerDir, projectRoot } = createMigrationFixture();
    writeFileSync(join(projectRoot, 'void.json'), JSON.stringify({ database }));
    const [table, id] = database === 'pg' ? ['pgTable', 'serial'] : ['mysqlTable', 'int'];
    const schema = `import { ${table}, ${id}, text } from 'void/schema-${database}';
export const users = ${table}('users', { id: ${id}('id').primaryKey(), name: text('name').notNull() });
`;
    // A schema folder's files are also importable one by one, as `@schema/<file>`.
    let fileImport = '';
    if (options.schemaFolder) {
      mkdirSync(join(projectRoot, 'db', 'schema'));
      writeFileSync(join(projectRoot, 'db', 'schema', 'users.ts'), schema);
      writeFileSync(join(projectRoot, 'db', 'schema', 'index.ts'), "export * from './users';\n");
      fileImport = `import { users as usersFile } from '@schema/users';
if (usersFile !== users) throw new Error('@schema/users is another module');
`;
    } else {
      writeFileSync(join(projectRoot, 'db', 'schema.ts'), schema);
    }
    const job = `import { users } from ${JSON.stringify(options.schemaImport)};
import { db } from 'void/db';
${fileImport}
export default async function () {
  const found = JSON.stringify([
    await db.select().from(users),
    ...(await Promise.all([db.select().from(users), db.query.users.findMany()])),
  ]);
  if (found !== ${JSON.stringify(JSON.stringify([users, users, users]))}) throw new Error(found);
}
`;
    mkdirSync(join(projectRoot, 'crons'));
    writeFileSync(join(projectRoot, 'crons', 'users.ts'), job);
    if (options.queue) {
      mkdirSync(join(projectRoot, 'queues'));
      writeFileSync(join(projectRoot, 'queues', 'users.ts'), job);
    }
    // The schema imports Void's SQL helpers by package name, as an app does.
    mkdirSync(join(projectRoot, 'node_modules'));
    symlinkSync(
      join(import.meta.dirname, '..', '..'),
      join(projectRoot, 'node_modules', 'void'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      crons: [{ name: 'users', filePath: 'users.ts', crons: ['0 * * * *'] }],
      ...(options.queue && {
        queues: [{ name: 'users', filePath: 'users.ts', bindingName: 'QUEUE_USERS' }],
      }),
    });
    return workerDir;
  }

  const runCron = (workerDir: string, connectionString: string, compatibilityDate?: string) =>
    fetchWrappedWorker(
      workerDir,
      { path: '/__void/scheduled', body: { cron: '0 * * * *', scheduledTime: Date.now() } },
      { bindings: { HYPERDRIVE: { connectionString } }, compatibilityDate },
    );

  /** Deliver one message to the wrapped `users` queue consumer through the relay endpoint. */
  const runQueue = (workerDir: string, connectionString: string) =>
    fetchWrappedWorker(
      workerDir,
      {
        path: '/__void/queue',
        body: {
          queue: 'users',
          messages: [{ id: 'one', timestamp: new Date().toISOString(), body: {}, attempts: 1 }],
        },
      },
      { bindings: { HYPERDRIVE: { connectionString } } },
    );

  /** Serve PGlite with one user to `run`, which can read how many connections the server took. */
  async function withPgUsers<T>(
    run: (connectionString: string, connections: () => number) => Promise<T>,
  ): Promise<T> {
    const pglite = new PGlite({ loadDataDir: pgDataDir });
    await pglite.waitReady;
    await pglite.exec(
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO users (name) VALUES ('alice');",
    );
    const server = createPgServer(pglite);
    let connections = 0;
    server.on('connection', () => connections++);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      return await run(`postgresql://postgres@127.0.0.1:${port}/postgres`, () => connections);
    } finally {
      server.close();
      await pglite.close();
    }
  }

  /** Run the wrapped PostgreSQL cron in workerd against PGlite with one user. */
  const runPgUsersCron = (workerDir: string, compatibilityDate?: string) =>
    withPgUsers((connectionString) => runCron(workerDir, connectionString, compatibilityDate));

  it('gives a PostgreSQL cron the app database and schema in workerd', async () => {
    const workerDir = await wrapUsersCron('pg', [{ id: 1, name: 'alice' }], {
      schemaImport: '@schema',
    });
    expect(await runPgUsersCron(workerDir)).toEqual({ ok: true });
  });

  // workerd provides node:fs only from compatibility date 2025-09-15, and apps keep older dates.
  it('starts a PostgreSQL cron Worker at a compatibility date without node:fs', async () => {
    const workerDir = await wrapUsersCron('pg', [{ id: 1, name: 'alice' }], {
      schemaImport: '@schema',
    });
    expect(await runPgUsersCron(workerDir, '2024-09-23')).toEqual({ ok: true });
  });

  it('gives a cron a schema folder through @schema', async () => {
    const workerDir = await wrapUsersCron('pg', [{ id: 1, name: 'alice' }], {
      schemaImport: '@schema',
      schemaFolder: true,
    });
    expect(await runPgUsersCron(workerDir)).toEqual({ ok: true });
  });

  it('gives a MySQL cron the app database and schema in workerd', async () => {
    const users = [{ id: 1, name: 'alice' }];
    // A relative import: the cron must get the app's database even without @schema.
    const workerDir = await wrapUsersCron('mysql', users, { schemaImport: '../db/schema.ts' });

    const mysql = await startFakeMySqlServer(users);
    try {
      expect(await runCron(workerDir, `mysql://void@127.0.0.1:${mysql.port}/app`)).toEqual({
        ok: true,
      });
    } finally {
      await mysql.close();
    }
  });

  // As in a Void app, each event runs in one request scope, so void/db opens one connection for
  // all of its queries, parallel ones included, instead of a pool for each query.
  it('runs a PostgreSQL cron event and queue batch on one connection each', async () => {
    const workerDir = await wrapUsersCron('pg', [{ id: 1, name: 'alice' }], {
      schemaImport: '@schema',
      queue: true,
    });
    await withPgUsers(async (connectionString, connections) => {
      expect(await runCron(workerDir, connectionString)).toEqual({ ok: true });
      expect(connections()).toBe(1);
      expect(await runQueue(workerDir, connectionString)).toEqual({ ok: true });
      expect(connections()).toBe(2);
    });
  });

  it('runs a MySQL cron event and queue batch on one connection each', async () => {
    const users = [{ id: 1, name: 'alice' }];
    const workerDir = await wrapUsersCron('mysql', users, { schemaImport: '@schema', queue: true });

    const mysql = await startFakeMySqlServer(users);
    try {
      const connectionString = `mysql://void@127.0.0.1:${mysql.port}/app`;
      expect(await runCron(workerDir, connectionString)).toEqual({ ok: true });
      expect(mysql.acceptedConnections()).toBe(1);
      expect(await runQueue(workerDir, connectionString)).toEqual({ ok: true });
      expect(mysql.acceptedConnections()).toBe(2);
    } finally {
      await mysql.close();
    }
  });

  // In a request scope, void/db reads D1 through a replica-capable session instead of the primary.
  it('keeps D1 cron and queue jobs outside the request scope', async () => {
    const { workerDir, projectRoot } = createMigrationFixture();
    writeFileSync(join(projectRoot, 'db', 'schema.ts'), 'export {};\n');
    mkdirSync(join(projectRoot, 'crons'));
    writeFileSync(join(projectRoot, 'crons', 'daily.ts'), 'export default async () => {};');
    mkdirSync(join(projectRoot, 'queues'));
    writeFileSync(join(projectRoot, 'queues', 'emails.ts'), 'export default async () => {};');

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
      queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' }],
    });

    const handlers = readFileSync(join(projectRoot, '.void', 'handlers', 'handlers.ts'), 'utf8');
    expect(handlers).toContain('export async function handleScheduled(controller, env, ctx) {');
    expect(handlers).toContain('export async function handleQueue(batch, env, ctx) {');
    expect(handlers).not.toContain('withRuntimeEnv');
  });

  it('does not generate migration handler when hasMigrations is false', async () => {
    const { workerDir, projectRoot } = createMigrationFixture();
    mkdirSync(join(projectRoot, 'crons'), { recursive: true });
    writeFileSync(join(projectRoot, 'crons', 'daily.ts'), 'export default async () => {};');

    await generateWrapper(workerDir, 'index.mjs', projectRoot, {
      ...base,
      crons: [{ name: 'daily', filePath: 'daily.ts', crons: ['0 0 * * *'] }],
    });

    const wrapper = readFileSync(join(workerDir, 'index.mjs'), 'utf-8');
    expect(wrapper).not.toContain('/__void/migrate');
    expect(wrapper).toContain('/__void/scheduled');
  });
});
