import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  getAppliedMigrations,
  openSqliteDatabase,
  runMigrations,
  toBetterSqlite3Error,
} from '../../src/migrations/runner.ts';

const roots: Array<string> = [];

function createDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-runner-sqlite-'));
  roots.push(root);
  return root;
}

function writeMigration(dir: string, name: string, sql: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql, 'utf8');
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('toBetterSqlite3Error', () => {
  it('suggests vp rebuild for Vite+ projects when the native binding is missing', () => {
    const root = createDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { 'vite-plus': '^0.1.0' } }),
      'utf8',
    );

    const error = toBetterSqlite3Error(
      new Error('Could not locate the bindings file. Tried:'),
      root,
    );

    expect(error.message).toContain('run `vp rebuild`');
    expect(error.message).toContain('vp exec void <command>');
    expect(error.message).not.toContain('run `pnpm rebuild better-sqlite3`');
  });

  it('suggests vp rebuild for Vite+ projects when the native binding has a Node ABI mismatch', () => {
    const root = createDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { 'vite-plus': '^0.1.0' } }),
      'utf8',
    );

    const error = toBetterSqlite3Error(
      new Error(
        'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 137.',
      ),
      root,
    );

    expect(error.message).toContain('run `vp rebuild`');
  });

  it('keeps pnpm rebuild guidance for plain Vite projects', () => {
    const root = createDir();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '^7.0.0' } }),
      'utf8',
    );

    const error = toBetterSqlite3Error(
      new Error('Could not locate the bindings file. Tried:'),
      root,
    );

    expect(error.message).toContain('run `pnpm rebuild better-sqlite3`');
    expect(error.message).not.toContain('run `vp rebuild`');
  });
});

describe('runMigrations (local SQLite)', () => {
  it('applies a single-statement migration and writes the tracking row', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_init.sql']);

    const tracked = await getAppliedMigrations(dbPath);
    expect(tracked.map((t) => t.name)).toEqual(['001_init.sql']);
  });

  it('is idempotent on re-run (pending filter removes already-applied)', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    await runMigrations(migDir, dbPath);
    const second = await runMigrations(migDir, dbPath);
    expect(second).toEqual([]);
  });

  it('fails before replaying migrations when a pushed schema has no tracking rows', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');

    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    } finally {
      db.close();
    }

    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow(
      'Local database already has application tables but no Void migration history.',
    );
  });

  it('fails before replaying migrations when applied rows refer to missing files', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');

    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE _void_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO _void_migrations (name) VALUES ('001_old_init.sql');
      `);
    } finally {
      db.close();
    }

    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');

    const error = await runMigrations(migDir, dbPath, (path) => `src/${path}`).catch(
      (caught: unknown) => caught,
    );
    const message = (error as Error).message;
    expect(message).toContain(
      'Local database migration history does not match src/db/migrations/.',
    );
    // Renaming files back is the fix; rename-migrations cannot help once the files are renamed.
    expect(message).toContain('restore their old names');
    expect(message).not.toContain('rename-migrations');
  });

  it('applies multi-statement migrations in order', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_multi.sql',
      'CREATE TABLE users (id TEXT PRIMARY KEY);\nCREATE TABLE posts (id TEXT PRIMARY KEY);',
    );

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_multi.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = rows.map((r) => r.name);
      expect(names).toContain('users');
      expect(names).toContain('posts');
    } finally {
      db.close();
    }
  });

  it('rolls back the whole migration when a later statement fails', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_bad.sql',
      'CREATE TABLE temp_t (id TEXT PRIMARY KEY);\nINVALID SQL HERE;',
    );

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow();

    // The partial table should NOT exist — the transaction rolled back.
    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const tempExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_t'")
        .get();
      expect(tempExists).toBeUndefined();

      // No tracking row
      const trackedTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_void_migrations'")
        .get();
      if (trackedTable) {
        const rows = db.prepare('SELECT name FROM _void_migrations').all();
        expect(rows).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it('rolls back only the failing migration and keeps prior successes', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_ok.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY)');
    writeMigration(migDir, '002_bad.sql', 'CREATE TABLE b (id TEXT); NOT SQL AT ALL;');

    await expect(runMigrations(migDir, dbPath)).rejects.toThrow();

    // 001 should have committed; 002 should have rolled back.
    const tracked = await getAppliedMigrations(dbPath);
    expect(tracked.map((t) => t.name)).toEqual(['001_ok.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const aExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a'")
        .get();
      const bExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'")
        .get();
      expect(aExists).toBeDefined();
      expect(bExists).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('names the failed file and keeps the SQLite error as the cause', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(migDir, '001_ok.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY)');
    writeMigration(migDir, '002_bad.sql', 'INSERT INTO nope VALUES (1);');

    const error = await runMigrations(migDir, dbPath).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe('migration 002_bad.sql failed: no such table: nope');
    expect((error as Error).cause).toMatchObject({ code: 'SQLITE_ERROR' });
  });

  it('upgrades a legacy _migrations table into _void_migrations on first run', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');

    // Pre-seed a legacy tracking table with one row, no `_void_migrations` table.
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(`CREATE TABLE _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )`);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        '001_init.sql',
        '2023-01-01T00:00:00Z',
      );
    } finally {
      db.close();
    }

    // Provide both 001 (should be detected as already applied via upgrade) and 002.
    writeMigration(migDir, '001_init.sql', 'CREATE TABLE users (id TEXT PRIMARY KEY)');
    writeMigration(migDir, '002_posts.sql', 'CREATE TABLE posts (id TEXT PRIMARY KEY)');

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['002_posts.sql']);

    const db2 = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      // _migrations was dropped
      const legacy = db2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .get();
      expect(legacy).toBeUndefined();
      // _void_migrations has the expected rows
      const rows = db2.prepare('SELECT name FROM _void_migrations ORDER BY name').all() as Array<{
        name: string;
      }>;
      expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_posts.sql']);
    } finally {
      db2.close();
    }
  });

  it('getAppliedMigrations returns [] when the db file does not exist', async () => {
    const root = createDir();
    const dbPath = join(root, 'never-created.sqlite');
    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([]);
  });

  it('getAppliedMigrations returns [] when neither tracking table exists', async () => {
    const root = createDir();
    const dbPath = join(root, 'empty.sqlite');
    const db = await openSqliteDatabase(dbPath);
    db.close();

    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([]);
  });

  it('getAppliedMigrations returns applied migrations sorted by name', async () => {
    const root = createDir();
    const dbPath = join(root, 'migrations.sqlite');
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(`
        CREATE TABLE _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO _void_migrations (name, applied_at) VALUES ('002_second.sql', '2025-01-02T00:00:00Z');
        INSERT INTO _void_migrations (name, applied_at) VALUES ('001_first.sql', '2025-01-01T00:00:00Z');
      `);
    } finally {
      db.close();
    }

    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([
      { name: '001_first.sql', applied_at: '2025-01-01T00:00:00Z' },
      { name: '002_second.sql', applied_at: '2025-01-02T00:00:00Z' },
    ]);
  });

  it('getAppliedMigrations reads from legacy _migrations if _void_migrations is absent', async () => {
    const root = createDir();
    const dbPath = join(root, 'legacy-only.sqlite');
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(
        "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
      );
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        '001_legacy.sql',
        '2023-02-02T00:00:00Z',
      );
    } finally {
      db.close();
    }

    const rows = await getAppliedMigrations(dbPath);
    expect(rows).toEqual([{ name: '001_legacy.sql', applied_at: '2023-02-02T00:00:00Z' }]);
  });

  it('returns [] when no migrations are present on disk', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    mkdirSync(migDir, { recursive: true });
    const dbPath = join(root, 'test.sqlite');
    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual([]);
  });

  it('writes the tracking row AFTER the migration SQL, not before (mutation-sensitive ordering)', async () => {
    // The migration counts its own tracking row: 0 means the row is written after the SQL.
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_peek.sql',
      [
        'CREATE TABLE peek (saw INTEGER);',
        "INSERT INTO peek (saw) SELECT COUNT(*) FROM _void_migrations WHERE name = '001_peek.sql';",
      ].join('\n'),
    );

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_peek.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT saw FROM peek').all() as Array<{ saw: number }>;
      expect(rows).toEqual([{ saw: 0 }]);
    } finally {
      db.close();
    }
  });

  it('handles semicolons inside string literals as a single statement', async () => {
    const root = createDir();
    const migDir = join(root, 'migrations');
    const dbPath = join(root, 'test.sqlite');
    writeMigration(
      migDir,
      '001_literal.sql',
      `CREATE TABLE t (msg TEXT DEFAULT 'a;b');\nINSERT INTO t DEFAULT VALUES;`,
    );

    const applied = await runMigrations(migDir, dbPath);
    expect(applied).toEqual(['001_literal.sql']);

    const db = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT msg FROM t').all() as Array<{ msg: string }>;
      expect(rows).toEqual([{ msg: 'a;b' }]);
      const tracked = db.prepare('SELECT name FROM _void_migrations').all();
      expect(tracked).toEqual([{ name: '001_literal.sql' }]);
    } finally {
      db.close();
    }
  });
});
