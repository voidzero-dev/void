import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLocalD1Target } from '../../src/cli/db.ts';
import { voidPlugin } from '../../src/index.ts';
import { resolveLocalD1Target, writeLocalD1PersistState } from '../../src/local-d1.ts';
import { getApplicationTables } from '../../src/migrations/runner.ts';

const roots: Array<string> = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-local-d1-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  return root;
}

function writeMigration(root: string): void {
  const migrationsDir = join(root, 'db', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(
    join(migrationsDir, '0001_users.sql'),
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
  );
}

function hookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

async function runGeneratedMigrationPlugin(plugins: ReturnType<typeof voidPlugin>): Promise<void> {
  const plugin = plugins.find(({ name }) => name === 'void:migrations');
  expect(plugin).toBeTruthy();
  const configureServer = hookHandler(plugin?.configureServer);
  await (configureServer as (server: unknown) => Promise<void>).call({}, { environments: {} });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('local D1 identity', () => {
  it('keeps the unconfigured Void default on local/.void', () => {
    const root = createRoot();

    expect(resolveLocalD1Target(root)).toMatchObject({
      bindingName: 'DB',
      databaseId: 'local',
      persistRoot: toSlash(join(root, '.void')),
    });
  });

  it('selects the configured binding exactly and gives its preview ID precedence', () => {
    const root = createRoot();
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [
          { binding: 'DB', database_id: 'wrong-database' },
          {
            binding: 'APP_DATABASE',
            database_id: 'production-database',
            preview_database_id: 'preview-database',
          },
        ],
      }),
    );

    expect(resolveLocalD1Target(root, { bindingName: 'APP_DATABASE' })).toMatchObject({
      bindingName: 'APP_DATABASE',
      databaseId: 'preview-database',
    });
  });

  it('fails instead of choosing among duplicate configured bindings', () => {
    const root = createRoot();
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [
          { binding: 'DB', database_id: 'first' },
          { binding: 'DB', database_id: 'second' },
        ],
      }),
    );

    expect(() => resolveLocalD1Target(root)).toThrow('binding "DB" is declared 2 times');
  });

  it('rereads the configured ID while retaining the plugin persistence directory', () => {
    const root = createRoot();
    const customPersistRoot = join(root, 'custom-state');
    const configPath = join(root, 'wrangler.jsonc');
    writeLocalD1PersistState(root, customPersistRoot);
    writeFileSync(
      configPath,
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: 'old-id' }] }),
    );
    const oldTarget = getLocalD1Target(root);

    writeFileSync(
      configPath,
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_id: 'new-id' }] }),
    );
    const newTarget = getLocalD1Target(root);

    expect(newTarget.persistRoot).toBe(customPersistRoot);
    expect(newTarget.databaseId).toBe('new-id');
    expect(newTarget.databasePath).not.toBe(oldTarget.databasePath);
  });

  it('runs generated migrations and CLI reads against the configured local database', async () => {
    const root = createRoot();
    writeMigration(root);
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ inference: { bindings: { db: 'APP_DATABASE' } } }),
    );
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        compatibility_date: '2026-02-24',
        name: 'local-d1-regression',
        d1_databases: [
          { binding: 'OTHER_DATABASE', database_name: 'other', database_id: 'other-id' },
          {
            binding: 'APP_DATABASE',
            database_name: 'app',
            database_id: 'real-app-id',
            preview_database_id: 'preview-app-id',
          },
        ],
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runGeneratedMigrationPlugin(voidPlugin());

    const cliTarget = getLocalD1Target(root);
    expect(cliTarget).toMatchObject({
      bindingName: 'APP_DATABASE',
      databaseId: 'preview-app-id',
      persistRoot: toSlash(join(root, '.void')),
    });
    expect(existsSync(cliTarget.databasePath)).toBe(true);
    expect(await getApplicationTables(cliTarget.databasePath)).toContain('users');

    // Read the migrated database through the local runtime's D1 binding.
    const proxy = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: { APP_DATABASE: 'preview-app-id' },
        resourcePersistencePath: join(cliTarget.persistRoot, 'v3'),
      }),
    );
    try {
      const binding = (await proxy.getBindings()).APP_DATABASE as D1Database;
      await binding.prepare('INSERT INTO users (name) VALUES (?)').bind('Ada').run();
      expect(await binding.prepare('SELECT name FROM users').first('name')).toBe('Ada');
    } finally {
      await proxy.dispose();
    }
    const { openSqliteDatabase } = await import('../../src/migrations/runner.ts');
    const db = await openSqliteDatabase(cliTarget.databasePath);
    try {
      expect(db.prepare('SELECT name FROM users').get()).toEqual({ name: 'Ada' });
    } finally {
      db.close();
    }
  }, 30_000);

  it('creates the local auth schema in the configured database', async () => {
    const root = createRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ auth: { providers: ['google'] } }));
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        compatibility_date: '2026-02-24',
        d1_databases: [{ binding: 'DB', database_id: 'auth-database-id' }],
      }),
    );
    mkdirSync(dirname(resolveLocalD1Target(root).databasePath), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runGeneratedMigrationPlugin(voidPlugin());

    const cliTarget = getLocalD1Target(root);
    expect(cliTarget.databaseId).toBe('auth-database-id');
    expect(await getApplicationTables(cliTarget.databasePath)).toEqual(
      expect.arrayContaining(['user', 'session', 'account', 'verification']),
    );
  });

  it('shares a canonical custom persistence path and rejects stale plugin state', async () => {
    const root = createRoot();
    const customPersistRoot = join(root, 'state', 'miniflare');
    const viteConfigPath = join(root, 'vite.config.ts');
    writeFileSync(viteConfigPath, 'export default {}');
    writeMigration(root);
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        compatibility_date: '2026-02-24',
        d1_databases: [{ binding: 'DB', database_id: 'configured-id' }],
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await runGeneratedMigrationPlugin(voidPlugin({ persistTo: 'state/miniflare' }));

    const cliTarget = getLocalD1Target(root);
    expect(cliTarget.persistRoot).toBe(toSlash(customPersistRoot));
    expect(existsSync(cliTarget.databasePath)).toBe(true);
    expect(await getApplicationTables(cliTarget.databasePath)).toContain('users');

    writeFileSync(viteConfigPath, 'export default { changed: true }');
    expect(() => getLocalD1Target(root)).toThrow('persistence configuration changed');
    expect(() => getLocalD1Target(root)).toThrow('Start the dev server to refresh it');

    // A fresh plugin evaluation replaces stale state with the current setting.
    writeLocalD1PersistState(root, customPersistRoot);
    expect(getLocalD1Target(root).persistRoot).toBe(customPersistRoot);
  });
});
