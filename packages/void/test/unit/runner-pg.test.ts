import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  applyPgMigrations,
  readPgAppliedMigrations,
  type PgClient,
} from '../../src/migrations/runner-pg.ts';

let pglite: PGlite;
let client: PgClient;

beforeAll(
  async () => {
    pglite = new PGlite();
    // Cold WASM startup can exceed 10s on Windows CI. Pay that cost once here,
    // not in the first schema-reset hook; query and test deadlines stay unchanged.
    await pglite.waitReady;
    client = pglite;
  },
  process.platform === 'win32' ? 30_000 : undefined,
);

beforeEach(async () => {
  await pglite.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
});

afterAll(async () => {
  await pglite.close();
});

describe('applyPgMigrations', () => {
  it('adopts an existing Drizzle database using the documented procedure without replaying SQL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-drizzle-adoption-'));
    const old = [
      {
        name: '0000_create_users.sql',
        sql: "CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);\n--> statement-breakpoint\nINSERT INTO users (name) VALUES ('alice');",
      },
      { name: '0001_add_email.sql', sql: 'ALTER TABLE users ADD COLUMN email TEXT;' },
    ];
    try {
      mkdirSync(join(root, 'meta'));
      for (const migration of old) {
        writeFileSync(join(root, migration.name), migration.sql);
      }
      writeFileSync(
        join(root, 'meta/_journal.json'),
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: old.map((migration, idx) => ({
            idx,
            version: '7',
            when: 1_700_000_000_000 + idx,
            tag: migration.name.replace('.sql', ''),
            breakpoints: false,
          })),
        }),
      );
      await migrate(drizzle(pglite), { migrationsFolder: root });
      expect(await readPgAppliedMigrations(client)).toEqual([]);
      const guide = readFileSync(
        join(import.meta.dirname, '../../../../docs/guide/database.md'),
        'utf8',
      );
      const sql = guide.match(/```sql \[adopt-void.sql\]\n([\s\S]*?)```/)?.[1];
      expect(sql, 'the guide must provide the adoption SQL').toBeDefined();
      await pglite.exec(sql!);
      await pglite.exec(sql!);
      expect((await readPgAppliedMigrations(client)).sort()).toEqual(old.map(({ name }) => name));
      const next = {
        name: '0002_add_active.sql',
        sql: 'ALTER TABLE users ADD COLUMN active BOOLEAN DEFAULT true;',
      };
      expect(await applyPgMigrations(client, [...old, next])).toEqual([next.name]);
      expect((await pglite.query('SELECT name, active FROM users')).rows).toEqual([
        { name: 'alice', active: true },
      ]);
      expect((await pglite.query('SELECT * FROM drizzle.__drizzle_migrations')).rows).toHaveLength(
        2,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty array for empty migrations list', async () => {
    const result = await applyPgMigrations(client, []);
    expect(result).toEqual([]);
  });

  it('skips already-applied migrations (idempotent re-run)', async () => {
    const migrations = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
    ];

    const first = await applyPgMigrations(client, migrations);
    expect(first).toEqual(['001_create_users.sql']);

    const second = await applyPgMigrations(client, migrations);
    expect(second).toEqual([]);

    const tracking = await pglite.query('SELECT name FROM _void_migrations');
    expect(tracking.rows).toHaveLength(1);
  });

  it('applies multiple migrations in order', async () => {
    const migrations = [
      {
        name: '001_create_users.sql',
        sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)',
      },
      { name: '002_add_email.sql', sql: 'ALTER TABLE users ADD COLUMN email TEXT' },
      {
        name: '003_create_posts.sql',
        sql: 'CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id))',
      },
    ];

    const applied = await applyPgMigrations(client, migrations);
    expect(applied).toEqual(['001_create_users.sql', '002_add_email.sql', '003_create_posts.sql']);

    const userCols = await pglite.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position",
    );
    expect(userCols.rows.map((r) => r.column_name)).toEqual(['id', 'name', 'email']);

    const postCheck = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'posts'",
    );
    expect(postCheck.rows).toHaveLength(1);
  });

  it('applies only pending migrations when some are already applied', async () => {
    const first = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
    ];
    await applyPgMigrations(client, first);

    const all = [
      ...first,
      { name: '002_add_email.sql', sql: 'ALTER TABLE users ADD COLUMN email TEXT' },
    ];
    const applied = await applyPgMigrations(client, all);
    expect(applied).toEqual(['002_add_email.sql']);

    const tracking = await pglite.query<{ name: string }>(
      'SELECT name FROM _void_migrations ORDER BY name',
    );
    expect(tracking.rows.map((r) => r.name)).toEqual(['001_create_users.sql', '002_add_email.sql']);
  });

  it('rolls back failed migration and does not record it', async () => {
    const migrations = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
      { name: '002_bad.sql', sql: 'INVALID SQL THAT WILL FAIL' },
    ];

    await expect(applyPgMigrations(client, migrations)).rejects.toThrow(/INVALID/i);

    // First migration committed before the failure
    const tracking = await pglite.query<{ name: string }>('SELECT name FROM _void_migrations');
    expect(tracking.rows).toHaveLength(1);
    expect(tracking.rows[0].name).toBe('001_create_users.sql');

    // users table exists, no residue from bad migration
    const tables = await pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name != '_void_migrations'",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['users']);
  });

  it('rolls back partial state from a multi-statement failed migration', async () => {
    const migrations = [
      {
        name: '001_bad_multi.sql',
        sql: 'CREATE TABLE temp_table (id SERIAL PRIMARY KEY); INVALID SQL HERE',
      },
    ];

    await expect(applyPgMigrations(client, migrations)).rejects.toThrow(/INVALID/i);

    // temp_table should NOT exist — transaction rolled back
    const tables = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'temp_table'",
    );
    expect(tables.rows).toHaveLength(0);

    // No tracking entry
    const tracking = await pglite.query('SELECT name FROM _void_migrations');
    expect(tracking.rows).toHaveLength(0);
  });

  it('names the failed file and keeps the database error as the cause', async () => {
    const migrations = [
      { name: '001_create_users.sql', sql: 'CREATE TABLE users (id SERIAL PRIMARY KEY)' },
      { name: '002_bad.sql', sql: 'INVALID SQL THAT WILL FAIL' },
    ];

    const error = await applyPgMigrations(client, migrations).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      'migration 002_bad.sql failed: syntax error at or near "INVALID"',
    );
    expect((error as Error).cause).toMatchObject({ code: '42601' });
  });

  it('names the failed file when the rollback fails too', async () => {
    const failing: PgClient = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string) {
        if (text === 'SELECT 1 FROM missing') {
          throw new Error('connection lost');
        }
        if (text === 'ROLLBACK') {
          throw new Error('Client was closed and is not queryable');
        }
        return { rows: [] as Array<T> };
      },
    };

    await expect(
      applyPgMigrations(failing, [{ name: '001_x.sql', sql: 'SELECT 1 FROM missing' }]),
    ).rejects.toThrow('migration 001_x.sql failed: connection lost');
  });
});

describe('readPgAppliedMigrations', () => {
  it('reads status without creating the tracking table', async () => {
    await expect(readPgAppliedMigrations(client)).resolves.toEqual([]);
    const tracking = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = '_void_migrations'",
    );
    expect(tracking.rows).toEqual([]);
  });

  it('fails closed on errors other than a missing tracking table', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: '42501' });
    const failing: PgClient = {
      query: async () => {
        throw permissionError;
      },
    };
    await expect(readPgAppliedMigrations(failing)).rejects.toBe(permissionError);
  });
});
