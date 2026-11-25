import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'pglite-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';
import { withRuntimeEnv } from '../../src/runtime/env/runtime.ts';
import { startFakeMySqlServer } from '../helpers/fake-mysql-server.ts';
import type { FakeMySqlServer } from '../helpers/fake-mysql-server.ts';
import { loadVirtualModule } from '../helpers/vite-hooks.ts';

const USERS = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Linus' },
];

type Dialect = 'postgresql' | 'mysql';
type Pool = { end(callback?: () => void): unknown };
type Query = PromiseLike<unknown>;
type Db = {
  select(): { from(table: unknown): Query & { prepare(name?: string): { execute(): Query } } };
  query: { users: { findMany(): Query } };
  transaction<T>(callback: (tx: Db) => Promise<T>): Promise<T>;
};

const roots: Array<string> = [];
const stateKeys: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const key of stateKeys.splice(0)) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

/**
 * Load void/db with drizzle's own driver. Each request ends the pools built during it, as
 * workerd does when a request finishes: nothing may reuse a request's connection afterwards.
 */
async function loadDb(dialect: Dialect, url: string) {
  const root = mkdtempSync(join(tmpdir(), 'void-db-request-'));
  roots.push(root);
  const core = dialect === 'postgresql' ? 'pg-core' : 'mysql-core';
  const coreUrl = import.meta.resolve(`drizzle-orm/${core}`);
  mkdirSync(join(root, 'db'));
  writeFileSync(
    join(root, 'db', 'schema.ts'),
    dialect === 'postgresql'
      ? `import { integer, pgTable, text } from ${JSON.stringify(coreUrl)};
export const users = pgTable('users', { id: integer('id').primaryKey(), name: text('name').notNull() });
`
      : `import { int, mysqlTable, varchar } from ${JSON.stringify(coreUrl)};
export const users = mysqlTable('users', { id: int('id').primaryKey(), name: varchar('name', { length: 255 }).notNull() });
`,
  );

  const plugin = drizzlePlugin(root, false, dialect);
  const envUrl = new URL('../../src/runtime/env/runtime.ts', import.meta.url).href;
  const stateKey = `__void_db_request_pools_${crypto.randomUUID().replaceAll('-', '')}`;
  const state = { pools: [] as Array<Pool>, checkouts: 0 };
  (globalThis as Record<string, unknown>)[stateKey] = state;
  stateKeys.push(stateKey);
  // Both drivers check a connection out of the pool for each query and each transaction.
  const checkout = dialect === 'postgresql' ? 'connect' : 'getConnection';
  const code = loadVirtualModule(plugin.load, '\0virtual:void-db')
    .replace(
      /^import \{ drizzle \} from (.*);$/m,
      (_match, driver: string) => `import { drizzle as createDrizzle } from ${driver};
function drizzle(config) {
  const database = createDrizzle(config);
  const state = globalThis[${JSON.stringify(stateKey)}];
  const pool = database.$client;
  if (config.connection) {
    state.pools.push(pool);
    const checkout = pool.${checkout};
    pool.${checkout} = (...args) => {
      state.checkouts++;
      return checkout.apply(pool, args);
    };
  }
  return database;
}`,
    )
    .replace(
      /^import \{ (getRuntimeBinding, getRuntimeRequestResource) \} from .*;$/m,
      (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
    );
  writeFileSync(join(root, 'virtual-db.mjs'), code);
  const module = (await import(
    `${pathToFileURL(join(root, 'virtual-db.mjs')).href}?test=${crypto.randomUUID()}`
  )) as { db: Db };
  const { users } = (await import(pathToFileURL(join(root, 'db', 'schema.ts')).href)) as {
    users: unknown;
  };

  async function endPools(first = 0): Promise<void> {
    await Promise.all(
      state.pools.slice(first).map((pool) =>
        dialect === 'postgresql'
          ? pool.end()
          : new Promise<void>((resolve) => {
              pool.end(() => resolve());
            }),
      ),
    );
  }

  async function request<T>(callback: () => Promise<T>): Promise<T> {
    const first = state.pools.length;
    try {
      return await withRuntimeEnv({ DATABASE_URL: url }, callback);
    } finally {
      await endPools(first);
    }
  }

  return { db: module.db, users, state, request, endPools };
}

describe.each(['postgresql', 'mysql'] as const)('void/db %s across requests', (dialect) => {
  let url: string;
  let pglite: PGlite | undefined;
  let pgServer: ReturnType<typeof createServer> | undefined;
  let mysqlServer: FakeMySqlServer | undefined;

  beforeAll(
    async () => {
      if (dialect === 'postgresql') {
        pglite = new PGlite();
        // Cold WASM startup can exceed 10s on Windows CI. Pay that cost in this hook,
        // with its own budget; query and test deadlines stay unchanged.
        await pglite.waitReady;
        await pglite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
        await pglite.exec("INSERT INTO users VALUES (1, 'Ada'), (2, 'Linus');");
        pgServer = createServer(pglite);
        pgServer.listen(0, '127.0.0.1');
        await once(pgServer, 'listening');
        url = `postgresql://postgres@127.0.0.1:${(pgServer.address() as AddressInfo).port}/postgres`;
      } else {
        mysqlServer = await startFakeMySqlServer(USERS);
        url = `mysql://void@127.0.0.1:${mysqlServer.port}/app`;
      }
    },
    process.platform === 'win32' ? 30_000 : undefined,
  );

  afterAll(async () => {
    if (pgServer) {
      pgServer.close();
      await once(pgServer, 'close');
    }
    await pglite?.close();
    await mysqlServer?.close();
  });

  it('runs a query built or prepared in one request on the pool of a later request', async () => {
    const { db, users, state, request } = await loadDb(dialect, url);

    // Module-level queries: built once, run by every request.
    const { built, prepared, relational } = await request(async () => {
      const built = db.select().from(users);
      const prepared = db.select().from(users).prepare('void_users');
      const relational = db.query.users.findMany();
      expect(await built).toEqual(USERS);
      return { built, prepared, relational };
    });
    const later = await request(async () => ({
      built: await built,
      prepared: await prepared.execute(),
      relational: await relational,
    }));

    expect(later).toEqual({ built: USERS, prepared: USERS, relational: USERS });
    expect(state.pools).toHaveLength(2);
  });

  it('runs a transaction on one connection of the request pool', async () => {
    const { db, users, state, request } = await loadDb(dialect, url);

    const rows = await request(() => db.transaction(async (tx) => tx.select().from(users)));

    expect(rows).toEqual(USERS);
    // One checkout holds the connection for the whole transaction; drizzle only does that for
    // a pool, so a stand-in client must still look like one.
    expect(state.checkouts).toBe(1);
  });

  it('builds one pool for a transaction outside a request scope', async () => {
    const { db, users, state, endPools } = await loadDb(dialect, url);
    // A framework entry that Void does not wrap runs without its request scope.
    const previousEnv = (globalThis as Record<string, unknown>).__env__;
    (globalThis as Record<string, unknown>).__env__ = { DATABASE_URL: url };
    try {
      await db.transaction(async (tx) => tx.select().from(users));
      const before = state.pools.length;

      const rows = await db.transaction(async (tx) => tx.select().from(users));

      expect(rows).toEqual(USERS);
      // Each use builds a pool here, so drizzle's pool checks must not build more.
      expect(state.pools.length - before).toBe(1);
    } finally {
      if (previousEnv === undefined) {
        delete (globalThis as Record<string, unknown>).__env__;
      } else {
        (globalThis as Record<string, unknown>).__env__ = previousEnv;
      }
      await endPools();
    }
  });
});
