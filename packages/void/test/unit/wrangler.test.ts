import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJsoncRaw, type ParseError } from 'jsonc-parser';
import { toSlash } from 'pathslash';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  acknowledgeWranglerManagedQueueRemovals,
  bindingEntriesForField,
  bindingNamesForField,
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  LATEST_KNOWN_COMPAT_DATE,
  readExistingLiveBindingConfig,
  readProvisionedBindingEntry,
  readRootWranglerConfig,
  readWranglerCompat,
  readWranglerManagedQueueCleanupCandidates,
  readWranglerWebSocketTombstones,
  resolveLiveBindingConfig,
  syncWranglerBindings,
  syncWranglerDurableObjects,
  syncWranglerWebSockets,
  type ProvisionedWranglerPatch,
  writeProvisionedWranglerConfig,
} from '../../src/cli/wrangler.ts';
import { readConfig, type VoidConfig } from '../../src/config.ts';
import type { InferredBindings } from '../../src/inference/walk.ts';

const tmpDir = join(import.meta.dirname, '.tmp-wrangler-test');

function setup(filename: string, content: string) {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, filename), content);
}

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Count jsonc-parser parse errors — used to assert CR-only edits stay valid. */
function parseErrors(text: string): number {
  const errs: Array<ParseError> = [];
  parseJsoncRaw(text, errs, { allowTrailingComma: true });
  return errs.length;
}

function readRaw(filename: string): string {
  return readFileSync(join(tmpDir, filename), 'utf-8');
}

function parseRaw(filename: string): Record<string, unknown> {
  return parseJsoncRaw(readRaw(filename)) as Record<string, unknown>;
}

function appendProducer() {
  return writeProvisionedWranglerConfig(tmpDir, {
    queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
  });
}

describe('readWranglerCompat', () => {
  it('resolves the latest known-good compatibility date without writing void.json', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
  });

  it('reads from wrangler.json', () => {
    setup(
      'wrangler.json',
      JSON.stringify({
        name: 'test',
        compatibility_date: '2026-02-24',
        compatibility_flags: ['nodejs_compat'],
      }),
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
    });
  });

  it('reads from wrangler.jsonc with comments', () => {
    setup(
      'wrangler.jsonc',
      `{
  // This is a comment
  "name": "test",
  "compatibility_date": "2026-02-24",
  /* Multi-line
     comment */
  "compatibility_flags": [
    "nodejs_compat",
    "nodejs_als"
  ]
}`,
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat', 'nodejs_als'],
    });
  });

  it('reads from wrangler.jsonc with trailing commas', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "test",
  "compatibility_date": "2026-02-24",
  "compatibility_flags": [
    "nodejs_compat",
  ],
  "assets": {
    "directory": "dist/client",
  },
}`,
    );
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
    });
  });

  it('prefers wrangler.jsonc over wrangler.json', () => {
    setup('wrangler.jsonc', '{ "compatibility_date": "2026-01-01" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "compatibility_date": "2025-01-01" }');
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: '2026-01-01',
    });
  });

  it('uses the default when fields are missing from wrangler config', () => {
    setup('wrangler.json', '{ "name": "test" }');
    expect(readWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
  });

  it('handles strings containing // without stripping them', () => {
    setup(
      'wrangler.jsonc',
      `{
  // real comment
  "compatibility_date": "2026-02-24",
  "name": "my-app"
}`,
    );
    const result = readWranglerCompat(tmpDir);
    expect(result.compatibilityDate).toBe('2026-02-24');
  });

  it('void.json date used when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const config: VoidConfig = { worker: { compatibility_date: '2026-03-15' } };
    expect(readWranglerCompat(tmpDir, config)).toEqual({
      compatibilityDate: '2026-03-15',
    });
  });

  it.each(['not-a-date', '2026-02'])('throws on date %s in wrangler config', (date) => {
    setup('wrangler.json', JSON.stringify({ compatibility_date: date }));
    expect(() => readWranglerCompat(tmpDir)).toThrow('YYYY-MM-DD format');
  });

  it('falls back to build output wrangler.json when no project config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        compatibility_date: '2026-03-29',
        compatibility_flags: ['nodejs_als'],
      }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-03-29',
      compatibilityFlags: ['nodejs_als'],
    });
  });

  it('project wrangler.json takes priority over build output', () => {
    setup(
      'wrangler.json',
      JSON.stringify({
        compatibility_date: '2026-04-01',
        compatibility_flags: ['nodejs_compat'],
      }),
    );
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({
        compatibility_date: '2026-03-29',
        compatibility_flags: ['nodejs_als'],
      }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-04-01',
      compatibilityFlags: ['nodejs_compat'],
    });
  });

  it('void.json takes priority over both project and build output', () => {
    setup(
      'wrangler.json',
      JSON.stringify({ compatibility_date: '2026-01-01', compatibility_flags: ['flag_a'] }),
    );
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({ compatibility_date: '2026-02-01', compatibility_flags: ['flag_b'] }),
    );
    const config: VoidConfig = {
      worker: { compatibility_date: '2026-06-01', compatibility_flags: ['flag_c'] },
    };
    expect(readWranglerCompat(tmpDir, config, buildDir)).toEqual({
      compatibilityDate: '2026-06-01',
      compatibilityFlags: ['flag_c'],
    });
  });

  it('build output date used when project has no date but build output does', () => {
    setup('wrangler.json', '{ "name": "test" }');
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({ compatibility_date: '2026-03-29' }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-03-29',
    });
  });

  it('build output flags used when project has no flags but build output does', () => {
    setup('wrangler.json', '{ "compatibility_date": "2026-04-01" }');
    const buildDir = join(tmpDir, 'dist', 'ssr');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, 'wrangler.json'),
      JSON.stringify({ compatibility_flags: ['nodejs_als'] }),
    );
    expect(readWranglerCompat(tmpDir, undefined, buildDir)).toEqual({
      compatibilityDate: '2026-04-01',
      compatibilityFlags: ['nodejs_als'],
    });
  });

  it('uses the default when the build output fallback is missing too', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(readWranglerCompat(tmpDir, undefined, join(tmpDir, 'nonexistent'))).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
  });
});

describe('ensureWranglerCompat', () => {
  it('pins the latest known-good compatibility date in a new void.config.ts', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerCompat(tmpDir, readConfig(tmpDir))).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
    expect(existsSync(join(tmpDir, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(tmpDir, 'void.lock.json'))).toBe(false);
    expect(readRaw('void.config.ts')).toBe(
      "// Generated by void init.\nimport { defineConfig } from 'void/config';\n\n" +
        `export default defineConfig({\n  "worker": {\n    "compatibility_date": "${LATEST_KNOWN_COMPAT_DATE}"\n  }\n});\n`,
    );
    expect(readConfig(tmpDir)).toEqual({
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    });
    // The generated Cloudflare config that void.config.ts implies stays out of Git.
    expect(readRaw('.gitignore')).toBe('.void-wrangler.jsonc\n');
    // The date is now read from void.config.ts, so nothing is written again.
    const written = readRaw('void.config.ts');
    expect(ensureWranglerCompat(tmpDir)).toEqual({ compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    expect(readRaw('void.config.ts')).toBe(written);
  });

  it('adds the generated Cloudflare config to an existing .gitignore once', () => {
    setup('.gitignore', 'node_modules');
    ensureWranglerCompat(tmpDir);
    expect(readRaw('.gitignore')).toBe('node_modules\n.void-wrangler.jsonc\n');

    rmSync(join(tmpDir, 'void.config.ts'));
    writeFileSync(join(tmpDir, '.gitignore'), '/.void-wrangler.jsonc\r\n');
    ensureWranglerCompat(tmpDir);
    expect(readRaw('.gitignore')).toBe('/.void-wrangler.jsonc\r\n');
  });

  it('keeps a wrangler.toml project on void.json so the toml stays in use', () => {
    setup('wrangler.toml', 'name = "app"\n');
    expect(ensureWranglerCompat(tmpDir)).toEqual({ compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    expect(existsSync(join(tmpDir, 'void.config.ts'))).toBe(false);
    expect(existsSync(join(tmpDir, 'wrangler.jsonc'))).toBe(false);
    expect(existsSync(join(tmpDir, '.void-wrangler.jsonc'))).toBe(false);
    expect(JSON.parse(readRaw('void.json'))).toEqual({
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    });
    // The next run reads the date from void.json and still adds no void.config.ts.
    expect(ensureWranglerCompat(tmpDir)).toEqual({ compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    expect(existsSync(join(tmpDir, 'void.config.ts'))).toBe(false);
  });

  it('pins the date in a new root wrangler.jsonc when asked to keep the root Wrangler file', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerCompat(tmpDir, undefined, undefined, { rootWrangler: true })).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(existsSync(join(tmpDir, 'void.config.ts'))).toBe(false);
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
    expect(existsSync(join(tmpDir, '.gitignore'))).toBe(false);
    expect(parseRaw('wrangler.jsonc')).toEqual({ compatibility_date: LATEST_KNOWN_COMPAT_DATE });
  });

  it('writes only the date to void.config.ts, not the passed config', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    ensureWranglerCompat(tmpDir, { database: 'pg', routing: { isr: true } } as VoidConfig);
    expect(readConfig(tmpDir)).toEqual({
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    });
  });

  it('pins the date in an existing root Wrangler config instead of adding void.config.ts', () => {
    setup('wrangler.jsonc', '{\n  // app name\n  "name": "app"\n}\n');
    expect(ensureWranglerCompat(tmpDir)).toEqual({ compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    expect(existsSync(join(tmpDir, 'void.config.ts'))).toBe(false);
    expect(existsSync(join(tmpDir, 'void.json'))).toBe(false);
    expect(readRaw('wrangler.jsonc')).toContain('// app name');
    expect(parseRaw('wrangler.jsonc')).toEqual({
      name: 'app',
      compatibility_date: LATEST_KNOWN_COMPAT_DATE,
    });
    expect(() => readConfig(tmpDir)).not.toThrow();
  });

  it('preserves existing void.json fields when pinning compatibility_date', () => {
    setup(
      'void.json',
      JSON.stringify({
        $schema: './node_modules/void/schema.json',
        database: 'pg',
        worker: { compatibility_flags: ['nodejs_compat'] },
      }),
    );
    expect(ensureWranglerCompat(tmpDir)).toEqual({
      compatibilityDate: LATEST_KNOWN_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
    });
    expect(JSON.parse(readFileSync(join(tmpDir, 'void.json'), 'utf-8'))).toEqual({
      $schema: './node_modules/void/schema.json',
      database: 'pg',
      worker: {
        compatibility_flags: ['nodejs_compat'],
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
      },
    });
    expect(existsSync(join(tmpDir, 'void.config.ts'))).toBe(false);
  });
});

describe('ensureWranglerCompatibilityDate', () => {
  it('creates wrangler.jsonc with compatibility_date when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerCompatibilityDate(tmpDir, '2026-02-24')).toBe(true);
    const created = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(created.compatibility_date).toBe('2026-02-24');
  });

  it('updates existing wrangler config compatibility_date', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    expect(ensureWranglerCompatibilityDate(tmpDir, '2026-02-24')).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.compatibility_date).toBe('2026-02-24');
  });

  it('returns false when compatibility_date already matches', () => {
    setup('wrangler.jsonc', '{ "compatibility_date": "2026-02-24" }');
    expect(ensureWranglerCompatibilityDate(tmpDir, '2026-02-24')).toBe(false);
  });
});

const noBindings: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
};

describe('ensureWranglerNodejsAlsFlag', () => {
  it('creates wrangler.jsonc when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(ensureWranglerNodejsAlsFlag(tmpDir)).toBe(true);
    const created = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(created.compatibility_flags).toEqual(['nodejs_als']);
  });

  it('adds nodejs_als compatibility flag when missing', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = ensureWranglerNodejsAlsFlag(tmpDir);
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.compatibility_flags).toEqual(['nodejs_als']);
  });

  it('does not duplicate existing nodejs_als compatibility flag', () => {
    setup('wrangler.jsonc', '{ "name": "test", "compatibility_flags": ["nodejs_als"] }');
    const result = ensureWranglerNodejsAlsFlag(tmpDir);
    expect(result).toBe(false);
  });
});

describe('syncWranglerBindings', () => {
  it('creates wrangler.jsonc when no wrangler config exists', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    expect(syncWranglerBindings(tmpDir, noBindings)).toBe(true);
    const created = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(created).toEqual({});
  });

  it('adds D1 binding when needsD1 is true', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsD1: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.d1_databases).toEqual([
      { binding: 'DB', database_name: 'default', database_id: 'local' },
    ]);
  });

  it('adds KV and R2 bindings', () => {
    setup('wrangler.json', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsKV: true, needsR2: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.json'), 'utf-8'));
    expect(parsed.kv_namespaces).toEqual([{ binding: 'KV', id: 'local' }]);
    expect(parsed.r2_buckets).toEqual([{ binding: 'STORAGE', bucket_name: 'default' }]);
  });

  it('uses custom binding names', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    syncWranglerBindings(
      tmpDir,
      { ...noBindings, needsD1: true, needsKV: true },
      { bindingNames: { d1: 'MY_DB', kv: 'MY_KV' } },
    );
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.d1_databases[0].binding).toBe('MY_DB');
    expect(parsed.kv_namespaces[0].binding).toBe('MY_KV');
  });

  it('does not duplicate existing bindings', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'test',
        compatibility_flags: ['nodejs_als'],
        d1_databases: [{ binding: 'DB', database_name: 'prod', database_id: 'real-id' }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsD1: true });
    expect(result).toBe(false);
  });

  it('preserves a legacy WebSocket class and appends new classes as SQLite', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [{ name: 'LEGACY', class_name: 'LegacyRoom' }],
        },
        migrations: [{ tag: 'void-ws-v1', new_classes: ['LegacyRoom'] }],
      }),
    );
    const route = (className: string, bindingName: string) => ({
      pattern: `/${bindingName}`,
      methods: ['GET'],
      params: [],
      catchAll: false,
      env: null,
      filePath: `${bindingName}.ws.ts`,
      className,
      bindingName,
      mode: 'room' as const,
      hasAuthGate: false,
    });

    syncWranglerWebSockets(tmpDir, [route('LegacyRoom', 'LEGACY'), route('ChatRoom', 'CHAT')]);

    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_classes: ['LegacyRoom'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['ChatRoom'] },
    ]);
  });

  it('retains stale generated WebSocket bindings and reports tombstone exports', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [
            { name: 'OLD_CHAT', class_name: 'OldChatWs' },
            { name: 'CART', class_name: 'ShoppingCartDurableObject' },
          ],
        },
        migrations: [
          { tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] },
          { tag: 'durable-shopping-cart-v1', new_sqlite_classes: ['ShoppingCartDurableObject'] },
        ],
      }),
    );

    expect(syncWranglerWebSockets(tmpDir, [])).toBe(false);

    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'OLD_CHAT', class_name: 'OldChatWs' },
      { name: 'CART', class_name: 'ShoppingCartDurableObject' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] },
      { tag: 'durable-shopping-cart-v1', new_sqlite_classes: ['ShoppingCartDurableObject'] },
    ]);
    expect(readWranglerWebSocketTombstones(tmpDir, [])).toEqual(['OldChatWs']);
  });

  it('keeps a renamed WebSocket binding, appends the new one and reports the old class as a tombstone', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: { bindings: [{ name: 'OLD_CHAT', class_name: 'OldChatWs' }] },
        migrations: [{ tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] }],
      }),
    );

    syncWranglerWebSockets(tmpDir, [
      {
        pattern: '/chat',
        methods: ['GET'],
        params: [],
        catchAll: false,
        env: null,
        filePath: 'chat.ws.ts',
        className: 'ChatWs',
        bindingName: 'CHAT',
        mode: 'room',
        hasAuthGate: false,
      },
    ]);

    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'OLD_CHAT', class_name: 'OldChatWs' },
      { name: 'CHAT', class_name: 'ChatWs' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['OldChatWs'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['ChatWs'] },
    ]);
    expect(
      readWranglerWebSocketTombstones(tmpDir, [
        {
          pattern: '/chat',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'chat.ws.ts',
          className: 'ChatWs',
          bindingName: 'CHAT',
          mode: 'room',
          hasAuthGate: false,
        },
      ]),
    ).toEqual(['OldChatWs']);
  });

  it('appends typed Durable Object migrations when new files sort earlier', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const zeta = {
      filePath: join(tmpDir, 'durable-objects', 'zeta.ts'),
      bindingName: 'ZETA',
      className: 'ZetaDurableObject',
      migrationTag: 'void-durable-zeta-v1',
    };
    const alpha = {
      filePath: join(tmpDir, 'durable-objects', 'alpha.ts'),
      bindingName: 'ALPHA',
      className: 'AlphaDurableObject',
      migrationTag: 'void-durable-alpha-v1',
    };

    expect(syncWranglerDurableObjects(tmpDir, [zeta])).toBe(true);
    expect(syncWranglerDurableObjects(tmpDir, [alpha, zeta])).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));

    expect(parsed.migrations).toEqual([
      { tag: 'void-durable-zeta-v1', new_sqlite_classes: ['ZetaDurableObject'] },
      { tag: 'void-durable-alpha-v1', new_sqlite_classes: ['AlphaDurableObject'] },
    ]);
  });

  it('keeps existing keys of a BOM-prefixed config when adding Durable Objects', () => {
    setup(
      'wrangler.jsonc',
      '﻿' +
        `{
  // app
  "name": "existing",
  "main": "src/index.ts",
  "routes": [{ "pattern": "example.com", "custom_domain": true }]
}`,
    );
    expect(readRootWranglerConfig(tmpDir)?.config.name).toBe('existing');

    const counter = {
      filePath: join(tmpDir, 'durable-objects', 'counter.ts'),
      bindingName: 'COUNTER',
      className: 'CounterDurableObject',
      migrationTag: 'void-durable-counter-v1',
    };
    expect(syncWranglerDurableObjects(tmpDir, [counter])).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));

    expect(parsed).toMatchObject({
      name: 'existing',
      main: 'src/index.ts',
      routes: [{ pattern: 'example.com', custom_domain: true }],
      durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'CounterDurableObject' }] },
      migrations: [
        { tag: 'void-durable-counter-v1', new_sqlite_classes: ['CounterDurableObject'] },
      ],
    });
  });

  it('adds live durable object and SQLite migration metadata', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'VOID_LIVE', class_name: 'VoidLiveStreamDurableObject' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'live-v1', new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
    ]);
  });

  it('does not duplicate live durable object bindings or migrations', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [{ name: 'VOID_LIVE', class_name: 'VoidLiveStreamDurableObject' }],
        },
        migrations: [{ tag: 'live-v1', new_sqlite_classes: ['VoidLiveStreamDurableObject'] }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true });
    expect(result).toBe(false);
    expect(readExistingLiveBindingConfig(tmpDir)).toEqual({
      bindingName: 'VOID_LIVE',
      className: 'VoidLiveStreamDurableObject',
    });
  });

  it('adds a non-conflicting live migration when live-v1 exists for another class', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        migrations: [{ tag: 'live-v1', new_sqlite_classes: ['OtherDurableObject'] }],
      }),
    );
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true });
    expect(result).toBe(true);
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.migrations).toEqual([
      { tag: 'live-v1', new_sqlite_classes: ['OtherDurableObject'] },
      { tag: 'live-v1-2', new_sqlite_classes: ['VoidLiveStreamDurableObject'] },
    ]);
  });

  it('uses deterministic live names when defaults collide', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [{ name: 'VOID_LIVE', class_name: 'UserLiveDurableObject' }],
        },
      }),
    );
    const live = resolveLiveBindingConfig(tmpDir);
    const result = syncWranglerBindings(tmpDir, { ...noBindings, needsLive: true }, { live });
    expect(result).toBe(true);
    expect(live.bindingName).toMatch(/^VOID_LIVE_[0-9a-f]{8}$/);
    expect(live.className).toBe('VoidLiveStreamDurableObject');
    const parsed = JSON.parse(readFileSync(join(tmpDir, 'wrangler.jsonc'), 'utf-8'));
    expect(parsed.durable_objects.bindings).toEqual([
      { name: 'VOID_LIVE', class_name: 'UserLiveDurableObject' },
      { name: live.bindingName, class_name: live.className },
    ]);
    expect(parsed.migrations).toEqual([{ tag: 'live-v1', new_sqlite_classes: [live.className] }]);
  });

  it('does not treat arbitrary live-like prefixes as generated live names', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        durable_objects: {
          bindings: [
            {
              name: 'VOID_LIVE_custom',
              class_name: 'VoidLiveStreamDurableObject_custom',
            },
          ],
        },
      }),
    );

    expect(resolveLiveBindingConfig(tmpDir)).toEqual({
      bindingName: 'VOID_LIVE',
      className: 'VoidLiveStreamDurableObject',
    });
    expect(readExistingLiveBindingConfig(tmpDir)).toBeUndefined();
  });

  it('returns false when no bindings are needed', () => {
    setup('wrangler.jsonc', '{ "name": "test" }');
    expect(syncWranglerBindings(tmpDir, noBindings)).toBe(false);
  });
});

describe('writeProvisionedWranglerConfig', () => {
  const commentedFixture = `{
  // Void manages this file — comments below must survive provisioning.
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": "src/index.ts",
  /* App databases (real ids written by \`wrangler d1 create --update-config\`). */
  "d1_databases": [
    { "binding": "DB", "database_name": "app-db", "database_id": "abc-123" },
    { "binding": "ANALYTICS", "database_name": "an-db", "database_id": "def-456" }
  ]
}`;

  it('preserves comments and appends stable WebSocket migration history', () => {
    setup(
      'wrangler.jsonc',
      `{
  // Keep the worker identity comment.
  "name": "chat-app",
  "vars": {
    // Keep unrelated bindings untouched.
    "FEATURE": "on"
  }
}`,
    );
    const route = (className: string) => ({
      bindingName: className.toUpperCase(),
      className,
      filePath: `${className}.ws.ts`,
    });

    const first = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [route('ChatWs')],
    });
    expect(first.modified).toBe(true);
    const afterFirst = readRaw('wrangler.jsonc');
    expect(afterFirst).toContain('// Keep the worker identity comment.');
    expect(afterFirst).toContain('// Keep unrelated bindings untouched.');

    const unchanged = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [route('ChatWs')],
    });
    expect(unchanged.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);

    const second = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [route('ChatWs'), route('NotificationsWs')],
    });
    expect(second.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.vars).toEqual({ FEATURE: 'on' });
    expect((parsed.durable_objects as { bindings: unknown }).bindings).toEqual([
      { name: 'CHATWS', class_name: 'ChatWs' },
      { name: 'NOTIFICATIONSWS', class_name: 'NotificationsWs' },
    ]);
    expect(parsed.migrations).toEqual([
      { tag: 'void-ws-v1', new_sqlite_classes: ['ChatWs'] },
      { tag: 'void-ws-v1-2', new_sqlite_classes: ['NotificationsWs'] },
    ]);
    expect(readRaw('wrangler.jsonc')).toContain('// Keep unrelated bindings untouched.');
  });

  it('keeps an existing legacy WebSocket namespace authoritative', () => {
    const config = `{
  "durable_objects": {
    "bindings": [{ "name": "CHAT", "class_name": "ChatWs" }]
  },
  // This class is already deployed with legacy KV storage.
  "migrations": [{ "tag": "void-ws-v1", "new_classes": ["ChatWs"] }]
}`;
    setup('wrangler.jsonc', config);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      webSockets: [{ bindingName: 'CHAT', className: 'ChatWs', filePath: 'chat.ws.ts' }],
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(config);
  });

  it('fills account_id, name, compatibility_date and migrations_dir, keeping comments, and is idempotent', () => {
    setup('wrangler.jsonc', commentedFixture);
    const patch = {
      accountId: 'acc-999',
      name: 'my-app',
      compatibilityDate: '2026-02-24',
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    };
    const result = writeProvisionedWranglerConfig(tmpDir, patch);

    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.jsonc')));

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain('/* App databases');
    expect((raw.match(/"account_id"/g) ?? []).length).toBe(1);
    expect((raw.match(/"migrations_dir"/g) ?? []).length).toBe(1);

    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.account_id).toBe('acc-999');
    expect(parsed.name).toBe('my-app');
    expect(parsed.compatibility_date).toBe('2026-02-24');
    const d1 = parsed.d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(2);
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });
    expect(d1[1].migrations_dir).toBeUndefined();

    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('overwrites account_id but only sets name/compatibility_date when absent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // user-owned fields
  "name": "user-chosen-name",
  "account_id": "stale-account",
  "compatibility_date": "2025-01-01"
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'fresh-account',
      name: 'should-not-clobber',
      compatibilityDate: '2026-02-24',
    });

    expect(result.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.account_id).toBe('fresh-account');
    expect(parsed.name).toBe('user-chosen-name');
    expect(parsed.compatibility_date).toBe('2025-01-01');
    expect(readRaw('wrangler.jsonc')).toContain('// user-owned fields');
  });

  it('adds compatibility flags without removing existing flags or comments', () => {
    setup(
      'wrangler.jsonc',
      `{
  "compatibility_flags": [
    "nodejs_compat" // user-selected runtime mode
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      compatibilityFlags: ['nodejs_als', 'nodejs_compat'],
    });

    expect(result.modified).toBe(true);
    expect(parseRaw('wrangler.jsonc').compatibility_flags).toEqual(['nodejs_compat', 'nodejs_als']);
    expect(readRaw('wrangler.jsonc')).toContain('// user-selected runtime mode');
  });

  it('creates compatibility_flags idempotently when the field is absent', () => {
    setup('wrangler.jsonc', '{\n  "name": "my-worker"\n}');

    const first = writeProvisionedWranglerConfig(tmpDir, {
      compatibilityFlags: ['nodejs_als'],
    });
    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      compatibilityFlags: ['nodejs_als'],
    });

    expect(first.modified).toBe(true);
    expect(second.modified).toBe(false);
    expect(parseRaw('wrangler.jsonc').compatibility_flags).toEqual(['nodejs_als']);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('adds migrations_dir to the D1 entry matched by binding, leaving others untouched', () => {
    setup('wrangler.jsonc', commentedFixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'ANALYTICS', dir: 'db/analytics-migrations' },
    });

    expect(result.d1MigrationsDirSkipped).toBe(false);
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0].migrations_dir).toBeUndefined();
    expect(d1[1]).toMatchObject({
      binding: 'ANALYTICS',
      migrations_dir: 'db/analytics-migrations',
    });
  });

  it('signals when no D1 entry matches the requested binding and leaves the file untouched', () => {
    setup('wrangler.jsonc', commentedFixture);
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'MISSING', dir: 'db/migrations' },
    });

    expect(result.d1MigrationsDirSkipped).toBe(true);
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('operates on wrangler.json when wrangler.jsonc is absent', () => {
    setup('wrangler.json', '{ "name": "json-app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-1' });
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.json')));
    expect(parseRaw('wrangler.json').account_id).toBe('acc-1');
  });

  it('prefers wrangler.jsonc over wrangler.json', () => {
    setup('wrangler.jsonc', '{ "name": "jsonc-app" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "name": "json-app" }');
    const result = writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-2' });
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.jsonc')));
    expect(parseRaw('wrangler.jsonc').account_id).toBe('acc-2');
    expect(parseRaw('wrangler.json').account_id).toBeUndefined();
  });

  it('creates wrangler.jsonc when no config exists and a patch is provided', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'acc-new',
      name: 'brand-new',
    });
    expect(result.configPath).toBe(toSlash(join(tmpDir, 'wrangler.jsonc')));
    expect(result.modified).toBe(true);
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.account_id).toBe('acc-new');
    expect(parsed.name).toBe('brand-new');
  });

  it('preserves the fixture indentation style (tabs) for inserted content', () => {
    setup('wrangler.jsonc', '{\n\t"name": "tabbed"\n}');
    writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-tab' });
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('\t"account_id": "acc-tab"');
    expect(parseRaw('wrangler.jsonc').account_id).toBe('acc-tab');
  });

  it('reads the fields of a config with a leading UTF-8 BOM and keeps the BOM and comments', () => {
    const bomFixture =
      '﻿' +
      `{
  // BOM-prefixed config — must NOT be treated as empty.
  "name": "user-name",
  "compatibility_date": "2025-06-01",
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "abc" }
  ]
}`;
    setup('wrangler.jsonc', bomFixture);
    const result = writeProvisionedWranglerConfig(tmpDir, {
      accountId: 'acc-bom',
      name: 'should-not-clobber',
      compatibilityDate: '2026-02-24',
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });

    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('// BOM-prefixed config');

    const parsed = parseJsoncRaw(raw.replace(/^﻿/, '')) as Record<string, unknown>;
    expect(parsed.name).toBe('user-name');
    expect(parsed.compatibility_date).toBe('2025-06-01');
    expect(parsed.account_id).toBe('acc-bom');
    const d1 = parsed.d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });
  });

  it('fails closed on a malformed config — throws without writing', () => {
    const malformed = '{ "name": "x" "d1_databases": [] }'; // missing comma
    setup('wrangler.jsonc', malformed);
    expect(() => writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-x', name: 'y' })).toThrow(
      /not valid JSON/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(malformed);
  });

  it('fails closed on a queue consumer with a duplicated property — throws without writing', () => {
    // Wrangler reads the last duplicate member, but jsonc-parser's modify() edits the first.
    const dup = `{
  "queues": {
    "consumers": [
      {
        "queue": "jobs",
        "max_batch_size": 10,
        "max_batch_size": 20
      }
    ]
  }
}`;
    setup('wrangler.jsonc', dup);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { consumers: [{ queue: 'jobs', max_batch_size: 25 }] },
      }),
    ).toThrow(/duplicate key "max_batch_size"/);
    expect(readRaw('wrangler.jsonc')).toBe(dup);
  });

  it('never infers queue ownership from a conventional QUEUE_* binding name', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "binding": "QUEUE_OLD", "queue": "old" },
      { "binding": "CUSTOM", "queue": "custom" }
    ],
    "consumers": [
      { "queue": "old", "max_batch_size": 5 },
      { "queue": "custom", "max_batch_size": 10 }
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [], consumers: [], reconcileVoidOwned: true },
    });

    expect(result.modified).toBe(false);
    expect(parseRaw('wrangler.jsonc').queues).toEqual({
      producers: [
        { binding: 'QUEUE_OLD', queue: 'old' },
        { binding: 'CUSTOM', queue: 'custom' },
      ],
      consumers: [
        { queue: 'old', max_batch_size: 5 },
        { queue: 'custom', max_batch_size: 10 },
      ],
    });
  });

  it('prunes only queue entries that Void explicitly recorded as managed', () => {
    setup('wrangler.jsonc', '{}');
    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_OLD', queue: 'old' }],
        consumers: [{ queue: 'old', max_batch_size: 5 }],
        reconcileVoidOwned: true,
      },
    });
    expect(readRaw('wrangler.jsonc')).toContain('// void:managed-queues:v1:');

    writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [], consumers: [], reconcileVoidOwned: true },
    });

    expect(parseRaw('wrangler.jsonc').queues).toEqual({ producers: [], consumers: [] });
    const configPath = join(tmpDir, 'wrangler.jsonc');
    expect(readRaw('wrangler.jsonc')).toContain('// void:managed-queues:v1:');
    expect(readWranglerManagedQueueCleanupCandidates(configPath)).toEqual(['old']);

    acknowledgeWranglerManagedQueueRemovals(configPath, ['old']);
    expect(readWranglerManagedQueueCleanupCandidates(configPath)).toEqual([]);
    expect(readRaw('wrangler.jsonc')).not.toContain('// void:managed-queues:v1:');
  });

  it('reconciles a renamed framework queue without retaining the old binding', () => {
    setup('wrangler.jsonc', '{}');
    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_OLD', queue: 'old' }],
        consumers: [{ queue: 'old' }],
        reconcileVoidOwned: true,
      },
    });

    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_NEW', queue: 'new' }],
        consumers: [{ queue: 'new' }],
        reconcileVoidOwned: true,
      },
    });

    expect(parseRaw('wrangler.jsonc').queues).toEqual({
      producers: [{ binding: 'QUEUE_NEW', queue: 'new' }],
      consumers: [{ queue: 'new' }],
    });
    expect(readWranglerManagedQueueCleanupCandidates(join(tmpDir, 'wrangler.jsonc'))).toEqual([
      'new',
      'old',
    ]);
  });

  it('moves a framework queue Void wrote earlier to its new Cloudflare name', () => {
    setup('wrangler.jsonc', '{}');
    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_JOBS', queue: 'jobs' }],
        consumers: [{ queue: 'jobs' }],
        reconcileVoidOwned: true,
      },
    });

    writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [{ binding: 'QUEUE_JOBS', queue: 'app-jobs' }],
        consumers: [{ queue: 'app-jobs' }],
        reconcileVoidOwned: true,
      },
    });

    expect(parseRaw('wrangler.jsonc').queues).toEqual({
      producers: [{ binding: 'QUEUE_JOBS', queue: 'app-jobs' }],
      consumers: [{ queue: 'app-jobs' }],
    });
    // The old consumer is detached on the next activation.
    expect(readWranglerManagedQueueCleanupCandidates(join(tmpDir, 'wrangler.jsonc'))).toEqual([
      'app-jobs',
      'jobs',
    ]);
  });

  it('still refuses to move a producer binding the user wrote', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({ queues: { producers: [{ binding: 'QUEUE_JOBS', queue: 'jobs' }] } }),
    );
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: {
          producers: [{ binding: 'QUEUE_JOBS', queue: 'app-jobs' }],
          consumers: [{ queue: 'app-jobs' }],
          reconcileVoidOwned: true,
        },
      }),
    ).toThrow('is already bound to queue "jobs"');
    expect(parseRaw('wrangler.jsonc').queues).toEqual({
      producers: [{ binding: 'QUEUE_JOBS', queue: 'jobs' }],
    });
  });

  it('cancels a pending consumer removal when the queue is reintroduced before deploy', () => {
    setup('wrangler.jsonc', '{}');
    const queues = {
      producers: [{ binding: 'QUEUE_JOBS', queue: 'jobs' }],
      consumers: [{ queue: 'jobs' }],
      reconcileVoidOwned: true,
    };
    writeProvisionedWranglerConfig(tmpDir, { queues });
    writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [], consumers: [], reconcileVoidOwned: true },
    });
    writeProvisionedWranglerConfig(tmpDir, { queues });

    expect(readWranglerManagedQueueCleanupCandidates(join(tmpDir, 'wrangler.jsonc'))).toEqual([
      'jobs',
    ]);
  });

  it('fails closed on a top-level duplicated key (account_id twice) — throws without writing', () => {
    const dup = `{
  "account_id": "aaa",
  "account_id": "bbb"
}`;
    setup('wrangler.jsonc', dup);
    expect(() => writeProvisionedWranglerConfig(tmpDir, { accountId: 'ccc' })).toThrow(
      /duplicate key "account_id"/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(dup);
  });

  it('upserts a queue producer and consumer into a config without queues, keeping comments, and is idempotent', () => {
    setup('wrangler.jsonc', commentedFixture);
    const patch = {
      queues: {
        producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
        consumers: [{ queue: 'jobs', max_batch_size: 10 }],
      },
    };

    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const afterFirst = readRaw('wrangler.jsonc');
    expect(afterFirst).toContain('// Void manages this file');
    expect((afterFirst.match(/"binding": "QUEUE_JOBS"/g) ?? []).length).toBe(1);

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toEqual([{ queue: 'jobs', binding: 'QUEUE_JOBS' }]);
    expect(q.consumers).toEqual([{ queue: 'jobs', max_batch_size: 10 }]);

    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('appends a new queue producer/consumer without duplicating existing ones, leaving them untouched', () => {
    setup(
      'wrangler.jsonc',
      `{
  // existing queue
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }],
    "consumers": [{ "queue": "jobs" }]
  }
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: {
        producers: [
          { queue: 'jobs', binding: 'QUEUE_JOBS' },
          { queue: 'emails', binding: 'QUEUE_EMAILS' },
        ],
        consumers: [{ queue: 'emails', max_retries: 3 }],
      },
    });

    expect(result.modified).toBe(true);
    expect(readRaw('wrangler.jsonc')).toContain('// existing queue');

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toHaveLength(2);
    expect(q.producers.map((p) => p.binding).sort()).toEqual(['QUEUE_EMAILS', 'QUEUE_JOBS']);
    expect(q.consumers).toHaveLength(2);
    expect(q.consumers.map((c) => c.queue).sort()).toEqual(['emails', 'jobs']);
  });

  it('patches a matching queue entry field by field, keeping user fields and comments, and is idempotent', () => {
    // Replacing the whole entry would drop user-tuned fields such as
    // delivery_delay and dead_letter_queue, and their comments.
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — comments below must survive queue upserts.
  "queues": {
    "producers": [
      // job producer — delivery_delay is user-tuned and must NOT be lost
      { "queue": "jobs", "binding": "QUEUE_JOBS", "delivery_delay": 60 }
    ],
    "consumers": [
      {
        "queue": "jobs",
        "max_batch_size": 10,
        "dead_letter_queue": "jobs-dlq", // route failures here — must survive
        "max_concurrency": 3
      }
    ]
  }
}`,
    );

    const patch = {
      queues: {
        producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }],
        consumers: [{ queue: 'jobs', max_batch_size: 25, max_retries: 5 }],
      },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain('// job producer — delivery_delay is user-tuned');
    expect(raw).toContain('// route failures here — must survive');

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toHaveLength(1);
    expect(q.producers[0]).toEqual({ queue: 'jobs', binding: 'QUEUE_JOBS', delivery_delay: 60 });
    expect(q.consumers).toHaveLength(1);
    expect(q.consumers[0]).toEqual({
      queue: 'jobs',
      max_batch_size: 25,
      max_retries: 5,
      dead_letter_queue: 'jobs-dlq',
      max_concurrency: 3,
    });

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('matches producers by binding, so QUEUE_JOBS beside a user producer on the same queue is a no-op', () => {
    // Wrangler allows several producers per queue but rejects duplicate binding names.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "CUSTOM" },
      { "queue": "jobs", "binding": "QUEUE_JOBS" }
    ]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    });

    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'CUSTOM' },
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
    expect((before.match(/"QUEUE_JOBS"/g) ?? []).length).toBe(1);
  });

  it('appends QUEUE_JOBS beside a user producer on the same queue without changing it', () => {
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — comments must survive queue upserts.
  "queues": {
    "producers": [
      // user's own producer — must be left untouched
      { "queue": "jobs", "binding": "CUSTOM", "delivery_delay": 60 }
    ]
  }
}`,
    );

    const patch = {
      queues: { producers: [{ queue: 'jobs', binding: 'QUEUE_JOBS' }] },
    };

    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// Void manages this file');
    expect(raw).toContain("// user's own producer — must be left untouched");

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toHaveLength(2);
    expect(q.producers[0]).toEqual({ queue: 'jobs', binding: 'CUSTOM', delivery_delay: 60 });
    expect(q.producers[1]).toEqual({ queue: 'jobs', binding: 'QUEUE_JOBS' });

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('fails closed when the producer binding is already bound to a different queue — throws without writing', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [{ "queue": "other", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/already bound to queue "other"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  // Wrangler requires every binding name to be unique across the whole Worker.
  it.each([
    {
      owner: 'a D1 binding',
      config: {
        d1_databases: [{ binding: 'QUEUE_JOBS', database_name: 'app', database_id: 'id' }],
      },
      error: /"QUEUE_JOBS" is already used by a D1 Database binding/,
    },
    {
      owner: 'a var',
      config: { vars: { QUEUE_JOBS: 'some-value' } },
      error: /"QUEUE_JOBS" is already used by an? Environment Variable binding/,
    },
    {
      owner: 'a secrets.required name',
      config: { secrets: { required: ['QUEUE_JOBS'] } },
      error: /"QUEUE_JOBS" is already used by a Secret binding/,
    },
    {
      owner: 'a send_email name',
      config: { send_email: [{ name: 'QUEUE_JOBS', destination_address: 'ops@example.com' }] },
      error: /"QUEUE_JOBS" is already used by a Send Email binding/,
    },
  ])(
    'fails closed when the producer binding collides with $owner — throws without writing',
    ({ config, error }) => {
      setup('wrangler.jsonc', JSON.stringify(config, null, 2));
      const before = readRaw('wrangler.jsonc');
      expect(appendProducer).toThrow(error);
      expect(readRaw('wrangler.jsonc')).toBe(before);
    },
  );

  it('does not treat the worker name, a D1 database_name or a consumer queue as binding names', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "QUEUE_JOBS",
  "d1_databases": [{ "binding": "DB", "database_name": "QUEUE_JOBS", "database_id": "id" }],
  "queues": {
    "consumers": [{ "queue": "QUEUE_JOBS", "max_batch_size": 10 }]
  }
}`,
    );

    expect(appendProducer().modified).toBe(true);
    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.producers).toEqual([{ queue: 'jobs', binding: 'QUEUE_JOBS' }]);
    expect(q.consumers).toEqual([{ queue: 'QUEUE_JOBS', max_batch_size: 10 }]);
  });

  it('fails closed on an array-shaped queues field when adopting a D1 binding — throws without writing', () => {
    // Wrangler requires `queues` to be an object; reading the array would hide the DB producer.
    setup(
      'wrangler.jsonc',
      `{
  "queues": [{ "binding": "DB", "queue": "jobs" }],
  "d1_databases": []
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'db-id' },
      }),
    ).toThrow(/"queues" must be an object/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on an array-shaped secrets field when adding a producer — throws without writing', () => {
    setup(
      'wrangler.jsonc',
      `{
  "secrets": ["QUEUE_JOBS"]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"secrets" must be an object/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on an array-shaped queues field when adding a producer — throws without writing', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": [{ "binding": "DB", "queue": "jobs" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"queues" must be an object/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on an explicit different migrations_dir — names both paths, throws without writing', () => {
    // Rewriting a user's migrations_dir would strand their migration files.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": "drizzle",
      "migrations_pattern": "drizzle/*/migration.sql"
    }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');

    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(
      /already sets "migrations_dir": "drizzle".*"\.\/db\/migrations".*Refusing to overwrite an explicit different migrations directory/s,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('keeps an equivalent migrations_dir spelling as written', () => {
    for (const existing of ['db/migrations', './db/migrations', 'db/migrations/']) {
      setup(
        'wrangler.jsonc',
        `{
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "id", "migrations_dir": ${JSON.stringify(existing)} }
  ]
}`,
      );
      const before = readRaw('wrangler.jsonc');
      const result = writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      });
      expect(result.modified).toBe(false);
      expect(result.d1MigrationsDirSkipped).toBe(false);
      expect(readRaw('wrangler.jsonc')).toBe(before);
    }
  });

  it('keeps an absolute migrations_dir that names the same folder', () => {
    const existing = join(tmpDir, 'db', 'migrations');
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "app", "database_id": "id", "migrations_dir": ${JSON.stringify(existing)} }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('refuses to fill migrations_dir when migrations_pattern is outside it — throws without writing', () => {
    // Wrangler requires migrations_pattern to start with `<migrations_dir>/`.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_pattern": "drizzle/*/migration.sql"
    }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(/"migrations_pattern": "drizzle\/\*\/migration\.sql", which is not under/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('rejects a non-string migrations_pattern with or without migrations_dir — throws without writing', () => {
    const badPatterns: Array<[label: string, json: string]> = [
      ['object', '{ "glob": "*.sql" }'],
      ['array', '["*.sql"]'],
      ['number', '42'],
      ['null', 'null'],
    ];
    for (const [label, json] of badPatterns) {
      setup(
        'wrangler.jsonc',
        `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_pattern": ${json}
    }
  ]
}`,
      );
      let before = readRaw('wrangler.jsonc');
      expect(
        () =>
          writeProvisionedWranglerConfig(tmpDir, {
            d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
          }),
        `pattern kind: ${label} (fill branch)`,
      ).toThrow(/non-string "migrations_pattern"/);
      expect(readRaw('wrangler.jsonc'), `pattern kind: ${label} (fill branch)`).toBe(before);

      setup(
        'wrangler.jsonc',
        `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": "./db/migrations",
      "migrations_pattern": ${json}
    }
  ]
}`,
      );
      before = readRaw('wrangler.jsonc');
      expect(
        () =>
          writeProvisionedWranglerConfig(tmpDir, {
            d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
          }),
        `pattern kind: ${label} (keep-equivalent branch)`,
      ).toThrow(/non-string "migrations_pattern"/);
      expect(readRaw('wrangler.jsonc'), `pattern kind: ${label} (keep-equivalent branch)`).toBe(
        before,
      );
    }
  });

  it('keeps a trailing comment on its property when inserting migrations_dir', () => {
    // A plain modify() reflows the region and moves the comment onto the new member.
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "prod-id" // production database
    }
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('"database_id": "prod-id", // production database');
    expect(raw).not.toMatch(/migrations_dir[^\n]*production database/);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('keeps a trailing comment on its entry when appending a queue producer', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "QUEUE_JOBS" } // jobs producer
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('}, // jobs producer');
    expect(raw.indexOf('// jobs producer')).toBeGreaterThan(raw.indexOf('QUEUE_JOBS'));
    expect(raw.indexOf('// jobs producer')).toBeLessThan(raw.indexOf('QUEUE_EMAILS'));
    expect(raw).not.toMatch(/QUEUE_EMAILS[\s\S]*jobs producer/);

    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('keeps a trailing comment after a separator comma on its property when inserting migrations_dir', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "prod-id", // production database
    }
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('"database_id": "prod-id", // production database');
    expect(raw).not.toMatch(/migrations_dir[^\n]*production database/);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('keeps a single-line block comment after a separator comma when inserting migrations_dir', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "prod-id", /* production database */
    }
  ]
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('"database_id": "prod-id", /* production database */');
    expect(raw).not.toMatch(/migrations_dir[^\n]*production database/);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('keeps the consumers trailing comment when creating a missing queues.producers section', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "consumers": [
      { "queue": "jobs", "max_batch_size": 10 }
    ] // jobs consumer
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('], // jobs consumer');
    expect(raw.indexOf('// jobs consumer')).toBeGreaterThan(raw.indexOf('"consumers"'));
    expect(raw.indexOf('// jobs consumer')).toBeLessThan(raw.indexOf('"producers"'));
    expect(raw).not.toMatch(/"producers"[\s\S]*jobs consumer/);

    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.consumers).toEqual([{ queue: 'jobs', max_batch_size: 10 }]);
    expect(q.producers).toEqual([{ queue: 'emails', binding: 'QUEUE_EMAILS' }]);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('keeps a single-line block comment on consumers when creating a missing queues.producers section', () => {
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "consumers": [
      { "queue": "jobs", "max_batch_size": 10 }
    ] /* jobs consumer */
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('], /* jobs consumer */');
    expect(raw.indexOf('/* jobs consumer */')).toBeLessThan(raw.indexOf('"producers"'));
    expect(raw).not.toMatch(/"producers"[\s\S]*jobs consumer/);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('keeps the text of a multi-line trailing block comment when appending a producer', () => {
    // A multi-line block comment cannot move onto one line, so modify() may attach it
    // to the appended entry. Only its text is guaranteed to survive.
    setup(
      'wrangler.jsonc',
      `{
  "queues": {
    "producers": [
      { "queue": "jobs", "binding": "QUEUE_JOBS" } /* jobs
         producer spanning lines */
    ]
  }
}`,
    );

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('producer spanning lines');
    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  const CR = '\r';

  it('CR-only line endings: inserting migrations_dir stays valid, keeps the trailing comment, byte-identical on re-run', () => {
    // A comment scan that stops only at `\n` would swallow the CR and the closing brace.
    const fixture =
      `{${CR}` +
      `  "d1_databases": [${CR}` +
      `    {${CR}` +
      `      "binding": "DB",${CR}` +
      `      "database_id": "prod-id" // entrypoint${CR}` +
      `    }${CR}` +
      `  ]${CR}` +
      `}`;
    setup('wrangler.jsonc', fixture);

    const result = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(result.modified).toBe(true);
    expect(result.d1MigrationsDirSkipped).toBe(false);

    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// entrypoint');
    expect(raw).not.toMatch(/migrations_dir[^\r\n]*entrypoint/);
    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1[0]).toMatchObject({ binding: 'DB', migrations_dir: 'db/migrations' });

    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, {
      d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('CR-only line endings: appending a queue producer stays valid, keeps the trailing comment, byte-identical on re-run', () => {
    const fixture =
      `{${CR}` +
      `  "queues": {${CR}` +
      `    "producers": [${CR}` +
      `      { "queue": "jobs", "binding": "QUEUE_JOBS" } // jobs producer${CR}` +
      `    ]${CR}` +
      `  }${CR}` +
      `}`;
    setup('wrangler.jsonc', fixture);

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// jobs producer');
    expect(raw).not.toMatch(/QUEUE_EMAILS[\s\S]*jobs producer/);
    const q = parseRaw('wrangler.jsonc').queues as { producers: Array<Record<string, unknown>> };
    expect(q.producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
      { queue: 'emails', binding: 'QUEUE_EMAILS' },
    ]);

    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('CR-only line endings: creating a missing queues.producers section stays valid, keeps the consumers trailing comment', () => {
    const fixture =
      `{${CR}` +
      `  "queues": {${CR}` +
      `    "consumers": [${CR}` +
      `      { "queue": "jobs", "max_batch_size": 10 }${CR}` +
      `    ] // jobs consumer${CR}` +
      `  }${CR}` +
      `}`;
    setup('wrangler.jsonc', fixture);

    const result = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(result.modified).toBe(true);

    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// jobs consumer');
    expect(raw).not.toMatch(/"producers"[\s\S]*jobs consumer/);
    const q = parseRaw('wrangler.jsonc').queues as {
      producers: Array<Record<string, unknown>>;
      consumers: Array<Record<string, unknown>>;
    };
    expect(q.consumers).toEqual([{ queue: 'jobs', max_batch_size: 10 }]);
    expect(q.producers).toEqual([{ queue: 'emails', binding: 'QUEUE_EMAILS' }]);

    const afterFirst = raw;
    const second = writeProvisionedWranglerConfig(tmpDir, {
      queues: { producers: [{ queue: 'emails', binding: 'QUEUE_EMAILS' }] },
    });
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('fails closed on a binding declared by two producers in either order', () => {
    const forward =
      `{\n` +
      `  "queues": {\n` +
      `    "producers": [\n` +
      `      { "queue": "jobs", "binding": "QUEUE_JOBS" },\n` +
      `      { "queue": "other", "binding": "QUEUE_JOBS" }\n` +
      `    ]\n` +
      `  }\n` +
      `}`;
    setup('wrangler.jsonc', forward);
    expect(appendProducer).toThrow(/declared 2 times/);
    expect(readRaw('wrangler.jsonc')).toBe(forward);

    const reversed =
      `{\n` +
      `  "queues": {\n` +
      `    "producers": [\n` +
      `      { "queue": "other", "binding": "QUEUE_JOBS" },\n` +
      `      { "queue": "jobs", "binding": "QUEUE_JOBS" }\n` +
      `    ]\n` +
      `  }\n` +
      `}`;
    setup('wrangler.jsonc', reversed);
    expect(appendProducer).toThrow(/declared 2 times/);
    expect(readRaw('wrangler.jsonc')).toBe(reversed);
  });

  it('producer upsert is a no-op when the sole matching binding already maps to the same queue', () => {
    const fixture =
      `{\n` +
      `  "queues": {\n` +
      `    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]\n` +
      `  }\n` +
      `}`;
    setup('wrangler.jsonc', fixture);
    expect(appendProducer().modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  it('fails closed when a composite account_id value drops an inner comment — throws without writing', () => {
    // modify() replaces a composite value whole, dropping comments inside it, and still
    // reports success. The final comment check refuses that write.
    const fixture = `{
  "account_id": { "x": 1 /* keep this note */ },
  "name": "app"
}`;
    setup('wrangler.jsonc', fixture);
    expect(() => writeProvisionedWranglerConfig(tmpDir, { accountId: 'acc-999' })).toThrow(
      /"account_id" has an object\/array value; expected a string/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  it('fails closed on a composite (non-string) migrations_dir on the matched D1 entry — throws without writing', () => {
    const fixture = `{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app",
      "database_id": "id",
      "migrations_dir": { "dir": "old" /* keep this note */ }
    }
  ]
}`;
    setup('wrangler.jsonc', fixture);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: 'db/migrations' },
      }),
    ).toThrow(/non-string "migrations_dir" value; expected a string/);
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  it('fails closed when a composite consumer option (max_batch_size) drops an inner comment — throws without writing', () => {
    const fixture = `{
  "queues": {
    "consumers": [
      { "queue": "jobs", "max_batch_size": { "n": 1 /* keep this note */ } }
    ]
  }
}`;
    setup('wrangler.jsonc', fixture);
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        queues: { consumers: [{ queue: 'jobs', max_batch_size: 25 }] },
      }),
    ).toThrow(/"max_batch_size" has an object\/array value; expected a string/);
    expect(readRaw('wrangler.jsonc')).toBe(fixture);
  });

  const adoptCases: Array<{
    field: string;
    placeholder: string;
    patch: ProvisionedWranglerPatch;
    adopted: Record<string, unknown>;
  }> = [
    {
      field: 'd1_databases',
      placeholder: '{ "binding": "DB", "database_name": "default", "database_id": "local" }',
      patch: { d1: { binding: 'DB', databaseName: 'myapp-db', databaseId: 'real-uuid-123' } },
      adopted: { binding: 'DB', database_name: 'myapp-db', database_id: 'real-uuid-123' },
    },
    {
      field: 'kv_namespaces',
      placeholder: '{ "binding": "ISR_CACHE", "id": "local" }',
      patch: { kv: { binding: 'ISR_CACHE', id: 'realkvid456' } },
      adopted: { binding: 'ISR_CACHE', id: 'realkvid456' },
    },
    {
      field: 'r2_buckets',
      placeholder: '{ "binding": "STORAGE", "bucket_name": "default" }',
      patch: { r2: { binding: 'STORAGE', bucketName: 'myapp-uploads' } },
      adopted: { binding: 'STORAGE', bucket_name: 'myapp-uploads' },
    },
    {
      field: 'hyperdrive',
      placeholder: '{ "binding": "HYPERDRIVE", "id": "local" }',
      patch: { hyperdrive: { binding: 'HYPERDRIVE', id: 'realhyperid789' } },
      adopted: { binding: 'HYPERDRIVE', id: 'realhyperid789' },
    },
  ];

  it.each(adoptCases)(
    'adopt into $field overwrites a placeholder in place, keeps comments, and is idempotent',
    ({ field, placeholder, patch, adopted }) => {
      setup(
        'wrangler.jsonc',
        `{
  // comment must survive
  "${field}": [
    ${placeholder}
  ]
}`,
      );
      expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
      const afterFirst = readRaw('wrangler.jsonc');
      expect(afterFirst).toContain('// comment must survive');
      expect(parseRaw('wrangler.jsonc')[field]).toEqual([adopted]);

      expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
      expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
    },
  );

  it.each(adoptCases)(
    'adopt into $field creates the entry when the binding is absent',
    ({ field, patch, adopted }) => {
      setup('wrangler.jsonc', '{ "name": "app" }');
      expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
      expect(parseRaw('wrangler.jsonc')[field]).toEqual([adopted]);
    },
  );

  it('d1 adopt composes with d1MigrationsDir on the same binding', () => {
    // Adopt runs first, so migrations_dir lands on the D1 entry adopt just created.
    setup('wrangler.jsonc', '{ "name": "app" }');
    const patch = {
      d1: { binding: 'DB', databaseName: 'myapp-db', databaseId: 'real-uuid-123' },
      d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
    };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    expect(first.d1MigrationsDirSkipped).toBe(false);

    const d1 = parseRaw('wrangler.jsonc').d1_databases as Array<Record<string, unknown>>;
    expect(d1).toHaveLength(1);
    expect(d1[0]).toMatchObject({
      binding: 'DB',
      database_name: 'myapp-db',
      database_id: 'real-uuid-123',
      migrations_dir: './db/migrations',
    });

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('adopt fails closed when the binding is already used by a different resource type — no write', () => {
    setup('wrangler.jsonc', '{ "kv_namespaces": [{ "binding": "DB", "id": "abc" }] }');
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/cannot adopt "DB" into "d1_databases".*already used by a KV Namespace binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when the binding collides with a var name — no write', () => {
    setup('wrangler.jsonc', '{ "vars": { "STORAGE": "x" } }');
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        r2: { binding: 'STORAGE', bucketName: 'uploads' },
      }),
    ).toThrow(
      /cannot adopt "STORAGE" into "r2_buckets".*already used by an? Environment Variable/s,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when the target array already declares the binding twice (ambiguous) — no write', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "a", "database_id": "id-a" },
    { "binding": "DB", "database_name": "b", "database_id": "id-b" }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/binding "DB" is declared 2 times in "d1_databases"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt appends when the binding collides with nothing, and is idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "id" }],
  "kv_namespaces": [{ "binding": "KV", "id": "abc" }]
}`,
    );
    const patch = { r2: { binding: 'STORAGE', bucketName: 'uploads' } };
    const first = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(first.modified).toBe(true);
    const r2 = parseRaw('wrangler.jsonc').r2_buckets as Array<Record<string, unknown>>;
    expect(r2).toEqual([{ binding: 'STORAGE', bucket_name: 'uploads' }]);

    const afterFirst = readRaw('wrangler.jsonc');
    const second = writeProvisionedWranglerConfig(tmpDir, patch);
    expect(second.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(afterFirst);
  });

  it('honors an explicit configPath option over discovery', () => {
    // With both files present, discovery would pick wrangler.jsonc.
    setup('wrangler.jsonc', '{ "name": "jsonc" }');
    writeFileSync(join(tmpDir, 'wrangler.json'), '{ "name": "json" }');
    const jsonPath = join(tmpDir, 'wrangler.json');
    const result = writeProvisionedWranglerConfig(
      tmpDir,
      { accountId: 'acc-pinned' },
      { configPath: jsonPath },
    );
    expect(result.configPath).toBe(jsonPath);
    expect(parseRaw('wrangler.json').account_id).toBe('acc-pinned');
    expect(parseRaw('wrangler.jsonc').account_id).toBeUndefined();
  });

  it('adopt fails closed when the binding collides with an existing queue producer binding — no write', () => {
    // The base collector leaves out producers, so the adopt guard adds them back.
    setup(
      'wrangler.jsonc',
      `{
  "queues": { "producers": [{ "queue": "jobs", "binding": "DB" }] }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/cannot adopt "DB" into "d1_databases".*already used by a Queue binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when two adopts in one patch use the same binding — no write', () => {
    setup('wrangler.jsonc', '{ "name": "app" }');
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DUP', databaseName: 'app', databaseId: 'real-uuid' },
        kv: { binding: 'DUP', id: 'real-kv-id' },
      }),
    ).toThrow(/cannot adopt "DUP" into "kv_namespaces".*already used by a D1 Database binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed on an existing target entry whose binding also collides with another type — no write', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "local" }],
  "kv_namespaces": [{ "binding": "DB", "id": "abc" }]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/cannot adopt "DB" into "d1_databases".*already used by a KV Namespace binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed when another field has a malformed member beside a real binding — no write', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({ kv_namespaces: [null, { binding: 'DB', id: 'kv-id' }] }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "binding"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('producer append fails closed on a binding field with a malformed member — no write', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({ d1_databases: [null, { binding: 'DB', database_id: 'id' }] }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "binding"\)/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on a singleton with a non-string binding — no write', () => {
    setup('wrangler.jsonc', JSON.stringify({ ai: { binding: 123 } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"ai" has a malformed "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('fails closed on a malformed secrets.required member — no write', () => {
    setup('wrangler.jsonc', JSON.stringify({ secrets: { required: ['API_KEY', null] } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"secrets\.required" contains a malformed entry at index 1/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed on a malformed queues.producers member — no write', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({ queues: { producers: [null, { queue: 'q', binding: 'QUEUE_X' }] } }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1: { binding: 'DB', databaseName: 'app', databaseId: 'real-uuid' },
      }),
    ).toThrow(/"queues\.producers" contains a malformed entry at index 0/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('adopt fails closed on a malformed member in its target array — no write', () => {
    // The owner collector skips the target field, so the adopt path checks it separately.
    setup(
      'wrangler.jsonc',
      JSON.stringify({ kv_namespaces: [null, { binding: 'KV', id: 'kv-id' }] }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        kv: { binding: 'KV', id: 'real-id' },
      }),
    ).toThrow(/malformed entry at index 0 \(missing a non-empty string "binding"\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('migrations_dir fails closed when the D1 binding is declared more than once', () => {
    setup(
      'wrangler.jsonc',
      `{
  "d1_databases": [
    { "binding": "DB", "database_name": "a", "database_id": "id-a" },
    { "binding": "DB", "database_name": "b", "database_id": "id-b" }
  ]
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, {
        d1MigrationsDir: { binding: 'DB', dir: './db/migrations' },
      }),
    ).toThrow(/binding "DB" is declared 2 times in "d1_databases"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('producer upsert fails closed when the existing queues.producers list has a null member', () => {
    setup('wrangler.jsonc', JSON.stringify({ queues: { producers: [null] } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"queues\.producers" contains a malformed entry at index 0/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('collector fails closed on a wrong-shaped binding-list field (durable_objects as array)', () => {
    setup('wrangler.jsonc', JSON.stringify({ durable_objects: [{ name: 'DO', class_name: 'C' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"durable_objects" must be an object with a "bindings" array/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('collector fails closed on a wrong-shaped name-keyed field (send_email as object)', () => {
    setup('wrangler.jsonc', JSON.stringify({ send_email: { EMAIL: {} } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"send_email" must be an array of binding entries/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('accepts valid stream/media/websearch singletons and a metadata-only unsafe', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        stream: { binding: 'STREAM' },
        media: { binding: 'MEDIA' },
        websearch: { binding: 'SEARCH' },
        unsafe: { metadata: { foo: 'bar' } },
      }),
    );
    expect(appendProducer().modified).toBe(true);
    const producers = (parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers;
    expect(producers).toEqual([{ queue: 'jobs', binding: 'QUEUE_JOBS' }]);
  });
});

describe('writeProvisionedWranglerConfig — email: sendEmail / addresses / vars', () => {
  // Comments and trailing commas at every level, like a hand-edited file.
  const emailFixture = `{
  // Void manages this file — every comment below must survive.
  "name": "acme-support", // worker name
  "vars": {
    "APP_ENV": "production", // user var
  },
  /* Email Sending binding, hand-declared with a destination restriction. */
  "send_email": [
    { "name": "SEND_EMAIL", "destination_address": "ops@acme.com" }, // restricted
  ],
  "addresses": [
    "support@mail.acme.com", // routed here
  ],
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`;

  it('sendEmail: creates the send_email array with exactly one { name } entry when absent, keeping comments', () => {
    setup(
      'wrangler.jsonc',
      `{
  // header
  "name": "acme-support", // worker name
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// header');
    expect(raw).toContain('// worker name');
    expect(parseRaw('wrangler.jsonc').send_email).toEqual([{ name: 'SEND_EMAIL' }]);
  });

  it('sendEmail: never duplicates a matching entry and leaves its user-owned fields alone (byte-identical)', () => {
    setup('wrangler.jsonc', emailFixture);
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
    expect(parseRaw('wrangler.jsonc').send_email).toEqual([
      { name: 'SEND_EMAIL', destination_address: 'ops@acme.com' },
    ]);
  });

  it('sendEmail: appends beside a differently-named entry without touching it, and is idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  "send_email": [
    { "name": "NOTIFY", "destination_address": "ops@acme.com" }, // theirs
  ],
}`,
    );
    const patch = { sendEmail: { name: 'SEND_EMAIL' } };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// theirs');
    expect(parseRaw('wrangler.jsonc').send_email).toEqual([
      { name: 'NOTIFY', destination_address: 'ops@acme.com' },
      { name: 'SEND_EMAIL' },
    ]);
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('sendEmail: fails closed when the name is already held by another binding type — no write', () => {
    setup('wrangler.jsonc', `{ "kv_namespaces": [{ "binding": "SEND_EMAIL", "id": "abc" }] }`);
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } }),
    ).toThrow(
      /cannot adopt "SEND_EMAIL" into "send_email".*already used by a KV Namespace binding/s,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('sendEmail: fails closed when send_email already declares the name twice — no write', () => {
    setup(
      'wrangler.jsonc',
      `{ "send_email": [{ "name": "SEND_EMAIL" }, { "name": "SEND_EMAIL" }] }`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { sendEmail: { name: 'SEND_EMAIL' } }),
    ).toThrow(/binding "SEND_EMAIL" is declared 2 times in "send_email"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('addresses: sets the whole array (creating it), keeping every comment and trailing commas', () => {
    setup(
      'wrangler.jsonc',
      `{
  // header
  "name": "acme-support", // worker name
  "vars": {
    "APP_ENV": "production", // user var
  },
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      addresses: ['support@mail.acme.com', '*@acme.com'],
    });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// header');
    expect(raw).toContain('// worker name');
    expect(raw).toContain('// user var');
    const parsed = parseRaw('wrangler.jsonc');
    expect(parsed.addresses).toEqual(['support@mail.acme.com', '*@acme.com']);
    expect(parsed.vars).toEqual({ APP_ENV: 'production' });
  });

  it('addresses: replaces an existing array outright (Void owns it) and is byte-identical on re-run', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support", // worker name
  "addresses": ["old@mail.acme.com", "gone@mail.acme.com"],
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`,
    );
    const patch = { addresses: ['support@mail.acme.com'] };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// worker name');
    expect(raw).toContain('// cache');
    expect(parseRaw('wrangler.jsonc').addresses).toEqual(['support@mail.acme.com']);
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('addresses: an equal array is a no-op even when it carries comments inside', () => {
    setup('wrangler.jsonc', emailFixture);
    const before = readRaw('wrangler.jsonc');
    const result = writeProvisionedWranglerConfig(tmpDir, {
      addresses: ['support@mail.acme.com'],
    });
    expect(result.modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('addresses: a different array cannot be written over comments nested inside the old one — throws without writing', () => {
    // Void owns the array, but the writer never drops a comment.
    setup('wrangler.jsonc', emailFixture);
    const before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { addresses: ['sales@mail.acme.com'] }),
    ).toThrow(/would drop a comment \(\/\/ routed here\)/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('addresses: null deletes the key, keeps the previous sibling’s trailing comment and the blank line is gone', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support", // worker name
  "addresses": ["support@mail.acme.com"],
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toBe(`{
  "name": "acme-support", // worker name
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`);
    expect(parseRaw('wrangler.jsonc')).not.toHaveProperty('addresses');
    // Deleting an absent key is a no-op.
    expect(writeProvisionedWranglerConfig(tmpDir, { addresses: null }).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('addresses: null on the last member of a strict .json file removes the preceding comma (no trailing comma left)', () => {
    setup(
      'wrangler.json',
      `{
  "name": "acme-support",
  "addresses": ["support@mail.acme.com"]
}`,
    );
    writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    const raw = readRaw('wrangler.json');
    expect(raw).toBe(`{
  "name": "acme-support"
}`);
    expect(JSON.parse(raw)).toEqual({ name: 'acme-support' });
  });

  it('addresses: null keeps the removed member’s own trailing comment and a full-line comment above it', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support",
  // inbound mail
  "addresses": ["support@mail.acme.com"], // managed by void
  "vars": { "A": "1" },
}`,
    );
    writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// inbound mail');
    expect(raw).toContain('// managed by void');
    expect(parseRaw('wrangler.jsonc')).toEqual({ name: 'acme-support', vars: { A: '1' } });
  });

  it('addresses: null with CR-only line endings stays valid and keeps the trailing comment', () => {
    const crOnly = `{\r  "name": "acme-support", // worker name\r  "addresses": ["support@mail.acme.com"],\r  "vars": { "A": "1" },\r}`;
    setup('wrangler.jsonc', crOnly);
    writeProvisionedWranglerConfig(tmpDir, { addresses: null });
    const raw = readRaw('wrangler.jsonc');
    expect(parseErrors(raw)).toBe(0);
    expect(raw).toContain('// worker name');
    expect(raw).not.toContain('\n');
    expect(parseRaw('wrangler.jsonc')).toEqual({ name: 'acme-support', vars: { A: '1' } });
  });

  it('vars: creates the vars object when absent, keeping the trailing comment on the last member', () => {
    setup(
      'wrangler.jsonc',
      `{
  "name": "acme-support", // worker name
}`,
    );
    const result = writeProvisionedWranglerConfig(tmpDir, {
      vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' },
    });
    expect(result.modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('"name": "acme-support", // worker name');
    expect(parseRaw('wrangler.jsonc').vars).toEqual({ __VOID_EMAIL_FROM: 'support@mail.acme.com' });
  });

  it('vars: upserts only the named keys — a changed value is overwritten, siblings and their comments stay, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  "vars": {
    "APP_ENV": "production", // user var
    "__VOID_EMAIL_FROM": "old@mail.acme.com",
  },
}`,
    );
    const patch = { vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' } };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    expect(raw).toContain('// user var');
    expect(parseRaw('wrangler.jsonc').vars).toEqual({
      APP_ENV: 'production',
      __VOID_EMAIL_FROM: 'support@mail.acme.com',
    });
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);
  });

  it('vars: fails closed when the key is already another binding’s name, or when vars is not an object — no write', () => {
    setup(
      'wrangler.jsonc',
      `{ "kv_namespaces": [{ "binding": "__VOID_EMAIL_FROM", "id": "abc" }] }`,
    );
    let before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { vars: { __VOID_EMAIL_FROM: 'x@y' } }),
    ).toThrow(/cannot write var "__VOID_EMAIL_FROM".*already used by a KV Namespace binding/s);
    expect(readRaw('wrangler.jsonc')).toBe(before);

    setup('wrangler.jsonc', `{ "vars": ["not", "an", "object"] }`);
    before = readRaw('wrangler.jsonc');
    expect(() =>
      writeProvisionedWranglerConfig(tmpDir, { vars: { __VOID_EMAIL_FROM: 'x@y' } }),
    ).toThrow(/"vars" must be an object mapping names to values/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('the full email patch composes: send_email + addresses + vars in one write, every comment survives, idempotent', () => {
    setup(
      'wrangler.jsonc',
      `{
  // Void manages this file — every comment below must survive.
  "name": "acme-support", // worker name
  "vars": {
    "APP_ENV": "production", // user var
  },
  "kv_namespaces": [
    { "binding": "KV", "id": "abc" }, // cache
  ],
}`,
    );
    const patch = {
      sendEmail: { name: 'SEND_EMAIL' },
      addresses: ['support@mail.acme.com'],
      vars: { __VOID_EMAIL_FROM: 'support@mail.acme.com' },
    };
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(true);
    const raw = readRaw('wrangler.jsonc');
    for (const comment of [
      '// Void manages this file',
      '// worker name',
      '// user var',
      '// cache',
    ]) {
      expect(raw).toContain(comment);
    }
    expect(parseRaw('wrangler.jsonc')).toEqual({
      name: 'acme-support',
      vars: { APP_ENV: 'production', __VOID_EMAIL_FROM: 'support@mail.acme.com' },
      kv_namespaces: [{ binding: 'KV', id: 'abc' }],
      send_email: [{ name: 'SEND_EMAIL' }],
      addresses: ['support@mail.acme.com'],
    });
    expect(writeProvisionedWranglerConfig(tmpDir, patch).modified).toBe(false);
    expect(readRaw('wrangler.jsonc')).toBe(raw);

    // A later preflight finding routing off withdraws `addresses` only.
    expect(writeProvisionedWranglerConfig(tmpDir, { addresses: null }).modified).toBe(true);
    const withdrawn = readRaw('wrangler.jsonc');
    for (const comment of [
      '// Void manages this file',
      '// worker name',
      '// user var',
      '// cache',
    ]) {
      expect(withdrawn).toContain(comment);
    }
    expect(parseRaw('wrangler.jsonc')).toEqual({
      name: 'acme-support',
      vars: { APP_ENV: 'production', __VOID_EMAIL_FROM: 'support@mail.acme.com' },
      kv_namespaces: [{ binding: 'KV', id: 'abc' }],
      send_email: [{ name: 'SEND_EMAIL' }],
    });
  });
});

describe('writeProvisionedWranglerConfig — producer collisions on the idempotent path', () => {
  it.each([
    {
      owner: 'a D1 binding',
      field:
        '"d1_databases": [{ "binding": "QUEUE_JOBS", "database_name": "app", "database_id": "id" }]',
      error: /"QUEUE_JOBS" is already used by a D1 Database binding/,
    },
    {
      owner: 'a var',
      field: '"vars": { "QUEUE_JOBS": "some-value" }',
      error: /"QUEUE_JOBS" is already used by an? Environment Variable binding/,
    },
  ])(
    'fails closed when an existing same-queue producer binding collides with $owner',
    ({ field, error }) => {
      setup(
        'wrangler.jsonc',
        `{
  ${field},
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
      );
      const before = readRaw('wrangler.jsonc');
      expect(appendProducer).toThrow(error);
      expect(readRaw('wrangler.jsonc')).toBe(before);
    },
  );

  it('fails closed when another binding field has a malformed member', () => {
    setup(
      'wrangler.jsonc',
      `{
  "kv_namespaces": [null, { "binding": "KV", "id": "abc" }],
  "queues": {
    "producers": [{ "queue": "jobs", "binding": "QUEUE_JOBS" }]
  }
}`,
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "binding"\)/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });
});

describe('worker-wide binding collector — field shapes', () => {
  it('key-map: reads vars keys, not a value that looks like a binding list', () => {
    setup('wrangler.jsonc', JSON.stringify({ vars: { bindings: [{ name: 'QUEUE_JOBS' }] } }));
    const result = appendProducer();
    expect(result.modified).toBe(true);
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });

  it('key-map: a var named "binding" contributes its key, not its value', () => {
    setup('wrangler.jsonc', JSON.stringify({ vars: { binding: 'QUEUE_JOBS' } }));
    const result = appendProducer();
    expect(result.modified).toBe(true);
  });

  it('key-map: a var named QUEUE_JOBS fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ vars: { QUEUE_JOBS: { bindings: [] } } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /"QUEUE_JOBS" is already used by an? Environment Variable binding/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('key-map: a wrong-shaped `vars` (array, not object) fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ vars: [{ QUEUE_JOBS: 'x' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"vars" must be an object mapping names to values/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: a required singleton (ai) without a binding fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ ai: {} }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"ai" requires a "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: a required singleton (browser) with only other keys fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ browser: { remote: true } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"browser" requires a "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('singleton: a wrong-shaped required singleton (ai as array) fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ ai: [{ binding: 'AI' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"ai" must be an object with a "binding"/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list: durable_objects without its required `bindings` array fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ durable_objects: {} }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"durable_objects" requires a "bindings" array/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list: logfwdr without its required `bindings` array fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ logfwdr: { schema: 'x' } }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(/"logfwdr" requires a "bindings" array/);
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('binding-list: a durable_objects member without a `name` fails closed', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({ durable_objects: { bindings: [{ class_name: 'C' }] } }),
    );
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "name"\)/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });

  it('accepts a valid config that uses every field shape', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        vars: { API_URL: 'https://x', bindings: [{ name: 'DECOY' }] },
        wasm_modules: { WASM_MOD: './m.wasm' },
        d1_databases: [{ binding: 'DB', database_name: 'app', database_id: 'id' }],
        kv_namespaces: [{ binding: 'KV', id: 'abc' }],
        ai: { binding: 'AI' },
        version_metadata: { binding: 'VERSION' },
        assets: { directory: './public' },
        durable_objects: { bindings: [{ name: 'DO', class_name: 'C' }] },
        unsafe: { metadata: { note: 'x' } },
        send_email: [{ name: 'EMAIL' }],
        ratelimits: [{ name: 'LIMIT', namespace_id: '1001', simple: { limit: 100, period: 60 } }],
        secrets: { required: ['SECRET_KEY'] },
      }),
    );
    const result = appendProducer();
    expect(result.modified).toBe(true);
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });
});

describe('name-keyed collector — send_email/ratelimits identity is `.name` only', () => {
  it('a send_email entry’s optional `.binding` is not a binding name', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        send_email: [
          { name: 'EMAIL_A', binding: 'QUEUE_JOBS', destination_address: 'ops@example.com' },
          { name: 'EMAIL_B' },
        ],
      }),
    );
    const result = appendProducer();
    expect(result.modified).toBe(true);
    expect((parseRaw('wrangler.jsonc').queues as Record<string, unknown>).producers).toEqual([
      { queue: 'jobs', binding: 'QUEUE_JOBS' },
    ]);
  });

  it('a ratelimits entry’s optional `.binding` is not a binding name', () => {
    setup(
      'wrangler.jsonc',
      JSON.stringify({
        ratelimits: [
          {
            name: 'LIMIT_A',
            binding: 'QUEUE_JOBS',
            namespace_id: '1',
            simple: { limit: 100, period: 60 },
          },
        ],
      }),
    );
    const result = appendProducer();
    expect(result.modified).toBe(true);
  });

  it('a name-keyed member without `.name` fails closed', () => {
    setup('wrangler.jsonc', JSON.stringify({ send_email: [{ binding: 'ONLY_BINDING' }] }));
    const before = readRaw('wrangler.jsonc');
    expect(appendProducer).toThrow(
      /malformed entry at index 0 \(missing a non-empty string "name"\)/,
    );
    expect(readRaw('wrangler.jsonc')).toBe(before);
  });
});

describe('readProvisionedBindingEntry (strict canonical binding reader)', () => {
  const P = '/tmp/wrangler.jsonc';

  it('returns the single matching entry when the binding is unique across the worker', () => {
    const config = {
      d1_databases: [
        { binding: 'DB', database_id: 'id-a', database_name: 'app-db' },
        { binding: 'OTHER', database_id: 'id-b' },
      ],
      kv_namespaces: [{ binding: 'CACHE', id: 'kv-1' }],
    };
    expect(readProvisionedBindingEntry(config, 'd1_databases', 'DB', P)).toEqual({
      binding: 'DB',
      database_id: 'id-a',
      database_name: 'app-db',
    });
  });

  it('returns undefined when the binding is absent', () => {
    expect(
      readProvisionedBindingEntry({ d1_databases: [] }, 'd1_databases', 'DB', P),
    ).toBeUndefined();
    expect(readProvisionedBindingEntry({}, 'd1_databases', 'DB', P)).toBeUndefined();
  });

  it('fails closed on a duplicate binding in the target field', () => {
    const config = {
      kv_namespaces: [
        { binding: 'CACHE', id: 'a' },
        { binding: 'CACHE', id: 'b' },
      ],
    };
    expect(() => readProvisionedBindingEntry(config, 'kv_namespaces', 'CACHE', P)).toThrow(
      /binding "CACHE" is declared 2 times in "kv_namespaces"/,
    );
  });

  it('fails closed when another binding field uses the same name', () => {
    const config = {
      d1_databases: [{ binding: 'DB', database_id: 'id-a' }],
      vars: { DB: 'oops' },
    };
    expect(() => readProvisionedBindingEntry(config, 'd1_databases', 'DB', P)).toThrow(
      /binding "DB" in "d1_databases" is also used by a Environment Variable binding/,
    );
  });

  it('fails closed when a queue producer uses the same name', () => {
    const config = {
      r2_buckets: [{ binding: 'STORAGE', bucket_name: 'b' }],
      queues: { producers: [{ binding: 'STORAGE', queue: 'jobs' }] },
    };
    expect(() => readProvisionedBindingEntry(config, 'r2_buckets', 'STORAGE', P)).toThrow(
      /binding "STORAGE" in "r2_buckets" is also used by a Queue binding/,
    );
  });

  it('fails closed on a malformed target field (wrong outer shape)', () => {
    expect(() =>
      readProvisionedBindingEntry({ d1_databases: { binding: 'DB' } }, 'd1_databases', 'DB', P),
    ).toThrow(/must be an array of binding entries/);
  });
});

describe('bindingEntriesForField', () => {
  it('carries each binding’s full config entry object', () => {
    const entries = bindingEntriesForField('services', [
      { binding: 'MY_SVC', service: 'my-other-worker' },
    ]);
    expect(entries).toEqual([
      { name: 'MY_SVC', entry: { binding: 'MY_SVC', service: 'my-other-worker' } },
    ]);
  });

  it('reads the singleton value itself as the entry, and empty or whole-object fields as no entries', () => {
    expect(bindingEntriesForField('browser', { binding: 'BROWSER' })).toEqual([
      { name: 'BROWSER', entry: { binding: 'BROWSER' } },
    ]);
    expect(bindingEntriesForField('services', [])).toEqual([]);
    expect(bindingEntriesForField('logfwdr', { bindings: [] })).toEqual([]);
    // `addresses` is a string array, not bindings; the deploy check compares it whole.
    const addresses = ['support@mail.acme.com', '*@acme.com'];
    expect(bindingEntriesForField('addresses', addresses)).toEqual([]);
    expect(bindingNamesForField('addresses', addresses)).toEqual([]);
    expect(bindingNamesForField('addresses', undefined)).toEqual([]);
  });
});
