import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createServer } from 'pglite-server';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { generateVoidAuthDrizzleSchema } from '../../src/auth/drizzle.ts';
import { prepareProject } from '../../src/codegen/prepare.ts';
import type { DatabaseCasing } from '../../src/config.ts';
import { drizzlePlugin, voidDbBundlerPlugin } from '../../src/plugin-drizzle.ts';
import { envContext } from '../../src/runtime/env-raw.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { startFakeMySqlServer } from '../helpers/fake-mysql-server.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

type Dialect = 'sqlite' | 'postgresql' | 'mysql';
type Query = PromiseLike<Array<Record<string, unknown>>>;
type Db = {
  select(): { from(table: unknown): Query };
  insert(table: unknown): { values(row: Record<string, unknown>): PromiseLike<unknown> };
  $client: { end(): Promise<void> };
};
type DbModule = { db: Db; createDb(client: unknown): Db };

const roots: Array<string> = [];
// The generated module imports the built runtime env; tests share the source one.
const builtEnv = JSON.stringify(fileURLToPath(import.meta.resolve('#self/_env')));
const sourceEnv = JSON.stringify(new URL('../../src/runtime/env.ts', import.meta.url).href);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SCHEMAS: Record<Dialect, (core: string) => string> = {
  sqlite: (core) => `import { integer, sqliteTable, text } from ${core};
export const users = sqliteTable('users', {
  id: integer().primaryKey(),
  firstName: text().notNull(),
  createdAt: integer().notNull(),
});
`,
  postgresql: (core) => `import { integer, pgTable, text } from ${core};
export const users = pgTable('users', {
  id: integer().primaryKey(),
  firstName: text().notNull(),
  createdAt: integer().notNull(),
});
`,
  mysql: (core) => `import { int, mysqlTable, varchar } from ${core};
export const users = mysqlTable('users', {
  id: int().primaryKey(),
  firstName: varchar({ length: 255 }).notNull(),
  createdAt: int().notNull(),
});
`,
};

const CORES: Record<Dialect, string> = {
  sqlite: 'drizzle-orm/sqlite-core',
  postgresql: 'drizzle-orm/pg-core',
  mysql: 'drizzle-orm/mysql-core',
};

/** A project whose schema declares its columns without names, for drizzle's casing to name. */
function createRoot(dialect: Dialect): string {
  const root = mkdtempSync(join(tmpdir(), 'void-db-casing-'));
  roots.push(root);
  mkdirSync(join(root, 'db'));
  writeFileSync(
    join(root, 'db', 'schema.ts'),
    SCHEMAS[dialect](JSON.stringify(import.meta.resolve(CORES[dialect]))),
  );
  return root;
}

function loadSource(root: string, dialect: Dialect, casing?: DatabaseCasing): string {
  const plugin = drizzlePlugin(root, false, dialect, casing ? { casing } : {});
  const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
  return load.call({}, '\0virtual:void-db');
}

/** Load the app's generated `void/db` with drizzle's real drivers. */
async function loadDb(root: string, dialect: Dialect, casing?: DatabaseCasing) {
  const code = loadSource(root, dialect, casing);
  expect(code).toContain(builtEnv);
  writeFileSync(join(root, 'virtual-db.mjs'), code.replace(builtEnv, sourceEnv));
  const module = (await import(
    `${pathToFileURL(join(root, 'virtual-db.mjs')).href}?test=${crypto.randomUUID()}`
  )) as DbModule;
  const { users } = (await import(pathToFileURL(join(root, 'db', 'schema.ts')).href)) as {
    users: unknown;
  };
  return { ...module, users };
}

const ADA = { id: 1, firstName: 'Ada', createdAt: 1815 };

describe('void/db with database.casing', () => {
  it('queries snake_case columns on D1', async () => {
    const root = createRoot('sqlite');
    const { db, createDb, users } = await loadDb(root, 'sqlite', 'snake_case');
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: ['DB'],
      }),
    );
    try {
      const binding = (await miniflare.getBindings()).DB as D1Database;
      await binding
        .prepare(
          'CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, created_at INTEGER NOT NULL)',
        )
        .run();

      const rows = await withRuntimeEnv({ DB: binding }, async () => {
        await db.insert(users).values(ADA);
        return db.select().from(users);
      });

      expect(rows).toEqual([ADA]);
      // Outside a request, such as in a cron job or at startup, `db` reads from the primary.
      expect(await envContext.run({ DB: binding }, () => db.select().from(users))).toEqual([ADA]);
      expect(await createDb(binding).select().from(users)).toEqual([ADA]);
      expect(
        (await binding.prepare('SELECT first_name, created_at FROM users').all()).results,
      ).toEqual([{ first_name: 'Ada', created_at: 1815 }]);
    } finally {
      await miniflare.dispose();
    }
  }, 30_000);

  it('queries snake_case columns on PostgreSQL', async () => {
    const root = createRoot('postgresql');
    const { db, createDb, users } = await loadDb(root, 'postgresql', 'snake_case');
    const pglite = new PGlite();
    await pglite.waitReady;
    await pglite.exec(
      'CREATE TABLE users (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, created_at INTEGER NOT NULL);',
    );
    const server = createServer(pglite);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `postgresql://postgres@127.0.0.1:${(server.address() as AddressInfo).port}/postgres`;
    try {
      const rows = await withRuntimeEnv({ DATABASE_URL: url }, async () => {
        try {
          await db.insert(users).values(ADA);
          return await db.select().from(users);
        } finally {
          await db.$client.end();
        }
      });
      expect(rows).toEqual([ADA]);

      const direct = createDb(url);
      try {
        expect(await direct.select().from(users)).toEqual([ADA]);
      } finally {
        await direct.$client.end();
      }
      const stored = await pglite.query('SELECT first_name, created_at FROM users');
      expect(stored.rows).toEqual([{ first_name: 'Ada', created_at: 1815 }]);
    } finally {
      server.close();
      await once(server, 'close');
      await pglite.close();
    }
  }, 30_000);

  it('queries snake_case columns on MySQL', async () => {
    const root = createRoot('mysql');
    const { db, createDb, users } = await loadDb(root, 'mysql', 'snake_case');
    const queries: Array<string> = [];
    const mysql = await startFakeMySqlServer((sql) => {
      queries.push(sql);
      return [{ id: 1, first_name: 'Ada', created_at: 1815 }];
    });
    const url = `mysql://void@127.0.0.1:${mysql.port}/app`;
    try {
      const rows = await withRuntimeEnv(
        { DATABASE_URL: url },
        async () => await db.select().from(users),
      );
      expect(rows).toEqual([ADA]);
      expect(await createDb(url).select().from(users)).toEqual([ADA]);
      expect(queries).toEqual([
        'select `id`, `first_name`, `created_at` from `users`',
        'select `id`, `first_name`, `created_at` from `users`',
      ]);
    } finally {
      await mysql.close();
    }
  });

  // Better Auth's adapter queries through the app's `db`, so its tables get the same casing.
  it('keeps the column names that the Better Auth tables declare', async () => {
    const root = createRoot('sqlite');
    const { createDb, users } = await loadDb(root, 'sqlite', 'snake_case');
    writeFileSync(
      join(root, 'db', 'auth.ts'),
      generateVoidAuthDrizzleSchema({ dialect: 'sqlite', providers: ['email'] }).replace(
        '"void/schema-d1"',
        JSON.stringify(import.meta.resolve(CORES.sqlite)),
      ),
    );
    const { userTable } = (await import(pathToFileURL(join(root, 'db', 'auth.ts')).href)) as {
      userTable: unknown;
    };
    const db = createDb({ withSession: () => ({}) });
    const sql = (table: unknown) =>
      (db.select().from(table) as unknown as { toSQL(): { sql: string } }).toSQL().sql;

    expect(sql(users)).toBe('select "id", "first_name", "created_at" from "users"');
    expect(sql(userTable)).toContain('"emailVerified", "image", "createdAt", "updatedAt"');
  });

  it.each(['sqlite', 'postgresql', 'mysql'] as const)(
    'passes no casing to the %s client without database.casing',
    (dialect) => {
      const code = loadSource(createRoot(dialect), dialect);
      expect(code).not.toContain('casing:');
      expect(loadSource(createRoot(dialect), dialect, 'camelCase')).toContain(
        'casing: "camelCase"',
      );
    },
  );

  it('reads the casing from the config in bundles outside the Vite plugins', () => {
    const root = createRoot('postgresql');
    const plugin = voidDbBundlerPlugin(root, {
      config: { database: { dialect: 'pg', casing: 'snake_case' } },
    });
    const load = plugin.load as (id: string) => string;
    const code = load('\0virtual:void-db');
    expect(code).toContain('drizzle-orm/node-postgres');
    expect(code).toContain(
      'drizzle({ client: requestPool(getPool), schema, casing: "snake_case" })',
    );
    expect(code).toContain('drizzle(connectionString, { schema, casing: "snake_case" })');
  });

  it('serves its own void/db for casing without a schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-casing-'));
    roots.push(root);
    const plugin = voidDbBundlerPlugin(root, { config: { database: { casing: 'snake_case' } } });
    const resolveId = plugin.resolveId as (id: string, importer?: string) => Promise<unknown>;
    return expect(resolveId.call({}, 'void/db')).resolves.toBe('\0virtual:void-db');
  });

  it('keeps db.d.ts in void prepare for casing without a schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-db-casing-'));
    roots.push(root);
    writeFileSync(join(root, 'void.json'), JSON.stringify({ database: { casing: 'snake_case' } }));
    drizzlePlugin(root, false, 'sqlite', { casing: 'snake_case' });
    expect(existsSync(join(root, '.void', 'db.d.ts'))).toBe(true);

    const { removed } = await prepareProject(root);

    expect(removed).not.toContain('.void/db.d.ts');
    expect(existsSync(join(root, '.void', 'db.d.ts'))).toBe(true);
  });
});
