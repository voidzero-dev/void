import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { int, mysqlTable } from 'drizzle-orm/mysql-core';
import { pgTable, serial } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getHookHandler } from '../helpers/vite-hooks.ts';

vi.mock('../../src/log', () => ({
  voidLog: vi.fn(),
  voidWarn: vi.fn(),
  voidError: vi.fn(),
}));

import { voidWarn } from '../../src/log.ts';
import { getMiniflareDatabasePath, openSqliteDatabase } from '../../src/migrations/runner.ts';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { startFakeMySqlServer } from '../helpers/fake-mysql-server.ts';

const roots: Array<string> = [];
const fakeStateKeys: Array<string> = [];
const warnMock = vi.mocked(voidWarn);

function createProjectRoot(options?: { schema?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-drizzle-'));
  if (options?.schema !== false) {
    mkdirSync(join(root, 'db'), { recursive: true });
    writeFileSync(join(root, 'db', 'schema.ts'), 'export {};\n');
  }
  roots.push(root);
  return root;
}

type FakePoolRecord = {
  dialect: 'postgresql' | 'mysql';
  options: Record<string, unknown>;
  drizzleConfig?: Record<string, unknown>;
};

type FakeDatabaseState = {
  nextId: number;
  pools: Array<FakePoolRecord>;
  // drizzle configs of the databases built on a client that void/db passes in.
  instances: Array<Record<string, unknown>>;
  clients: Array<unknown>;
};

type ExecutableDbModule = {
  db: {
    instanceId: number;
    query(expectedOwner: string): Promise<number>;
    transaction<T>(callback: (tx: { instanceId: number }) => T | Promise<T>): Promise<T>;
  };
  createDb(connectionString: string): ExecutableDbModule['db'];
  withEnv<T>(env: Record<string, unknown>, callback: () => T): T;
};

async function loadExecutableDbModule(
  dialect: 'postgresql' | 'mysql' | 'sqlite',
): Promise<{ module: ExecutableDbModule; state: FakeDatabaseState }> {
  const root = createProjectRoot({ schema: dialect !== 'sqlite' });
  const plugin = drizzlePlugin(root, false, dialect, { forceVirtualDb: true });
  const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
  let code = load.call({}, '\0virtual:void-db');
  const stateKey = `__void_db_scope_${dialect}_${crypto.randomUUID().replaceAll('-', '')}`;
  const state: FakeDatabaseState = { nextId: 0, pools: [], instances: [], clients: [] };
  (globalThis as Record<string, unknown>)[stateKey] = state;
  fakeStateKeys.push(stateKey);

  const fakeDriverPath = join(root, 'fake-driver.mjs');
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
  const stateExpression = `globalThis[${JSON.stringify(stateKey)}]`;
  const createDatabaseSource = `
function createPool(dialect, options) {
  const state = ${stateExpression};
  const id = ++state.nextId;
  const connectionOwner = dialect === "postgresql" ? options.connectionString : options.uri;
  let owner = connectionOwner;
  try { owner = getTestRuntimeBinding("REQUEST_ID") ?? connectionOwner; } catch {}
  const pool = {
    id,
    options,
    async query(expectedOwner) {
      if (owner !== expectedOwner) throw new Error("database pool crossed request ownership");
      return id;
    },
    promise: () => pool,
    // void/db listens to a MySQL pool to close idle connections.
    on() {},
  };
  return pool;
}

// Like drizzle, the database runs every query on its client; instanceId names the pool that
// serves the current call.
function createDatabase(client) {
  const database = {
    get instanceId() {
      return client.id;
    },
    query: (expectedOwner) => client.query(expectedOwner),
    async transaction(callback) {
      return callback(database);
    },
    $client: client,
  };
  return database;
}
`;

  if (dialect === 'sqlite') {
    writeFileSync(
      fakeDriverPath,
      `const state = ${stateExpression};
export function drizzle(client) {
  state.clients.push(client);
  return { instanceId: ++state.nextId };
}
`,
    );
    code = code.replace(
      /^import \{ drizzle \} from .*;$/m,
      'import { drizzle } from "./fake-driver.mjs";',
    );
  } else if (dialect === 'postgresql') {
    writeFileSync(
      fakeDriverPath,
      `import { getRuntimeBinding as getTestRuntimeBinding } from ${JSON.stringify(envUrl)};
const state = ${stateExpression};
${createDatabaseSource}
export function drizzle(config) {
  if (typeof config === "string") return createDatabase(createPool("postgresql", { connectionString: config }));
  const { connection, client, ...drizzleConfig } = config;
  if (client) {
    state.instances.push(drizzleConfig);
    return createDatabase(client);
  }
  if (typeof connection !== "object" || connection === null) {
    throw new Error("void/db must let drizzle build the pg pool from a connection object");
  }
  state.pools.push({ dialect: "postgresql", options: connection, drizzleConfig });
  return createDatabase(createPool("postgresql", connection));
}
`,
    );
    code = code.replace(
      /^import \{ drizzle \} from .*;$/m,
      `import { drizzle } from "./fake-driver.mjs";`,
    );
  } else {
    writeFileSync(
      fakeDriverPath,
      `import { getRuntimeBinding as getTestRuntimeBinding } from ${JSON.stringify(envUrl)};
const state = ${stateExpression};
${createDatabaseSource}
export function drizzle(config) {
  const { connection, client, ...drizzleConfig } = config;
  if (client) {
    state.instances.push(drizzleConfig);
    // Like drizzle, query through the promise API of a callback pool.
    return createDatabase(typeof client.promise === "function" ? client.promise() : client);
  }
  if (typeof connection !== "object" || connection === null) {
    throw new Error("void/db must let drizzle build the mysql2 pool from a connection object");
  }
  state.pools.push({ dialect: "mysql", options: connection, drizzleConfig });
  return createDatabase(createPool("mysql", connection));
}
`,
    );
    code = code.replace(
      /^import \{ drizzle \} from .*;$/m,
      `import { drizzle } from "./fake-driver.mjs";`,
    );
  }

  code = code.replace(
    /^import \{ ((?:getRuntimeBinding|getRuntimeRequestResource|requireRuntimeBinding)[^}]*) \} from .*;$/m,
    (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
  );
  writeFileSync(join(root, 'virtual-db.mjs'), code);
  writeFileSync(
    join(root, 'harness.mjs'),
    `import { db, createDb } from "./virtual-db.mjs";
import { withRuntimeEnv } from ${JSON.stringify(envUrl)};
export { db, createDb };
export const withEnv = (env, callback) => withRuntimeEnv(env, callback);
`,
  );

  const module = (await import(
    `${pathToFileURL(join(root, 'harness.mjs')).href}?test=${crypto.randomUUID()}`
  )) as ExecutableDbModule;
  return { module, state };
}

type DriverQuery = { toSQL(): { sql: string } };

/** Load void/db with drizzle's own driver and record each pool it builds. */
async function loadDriverDbModule(dialect: 'postgresql' | 'mysql'): Promise<{
  db: { select(): { from(table: unknown): DriverQuery } };
  clients: Array<{ end(): unknown }>;
}> {
  const root = createProjectRoot({ schema: false });
  const plugin = drizzlePlugin(root, false, dialect, { forceVirtualDb: true });
  const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
  const clientsKey = `__void_db_clients_${dialect}_${crypto.randomUUID().replaceAll('-', '')}`;
  const clients: Array<{ end(): unknown }> = [];
  (globalThis as Record<string, unknown>)[clientsKey] = clients;
  fakeStateKeys.push(clientsKey);
  const code = load
    .call({}, '\0virtual:void-db')
    .replace(
      /^import \{ drizzle \} from (.*);$/m,
      (_match, driver: string) => `import { drizzle as createDrizzle } from ${driver};
function drizzle(config) {
  const database = createDrizzle(config);
  if (config.connection) globalThis[${JSON.stringify(clientsKey)}].push(database.$client);
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
  )) as { db: Awaited<ReturnType<typeof loadDriverDbModule>>['db'] };
  return { db: module.db, clients };
}

type MySqlDb = {
  $client: { config: unknown; end(callback: () => void): void };
  execute(query: unknown): Promise<unknown>;
};

/** Load the MySQL void/db module with drizzle's own driver and mysql2. */
async function loadMySqlDbModule(): Promise<{
  db: MySqlDb;
  createDb(connectionString: string): MySqlDb;
  sql(strings: TemplateStringsArray): unknown;
}> {
  const root = createProjectRoot();
  const plugin = drizzlePlugin(root, false, 'mysql', { forceVirtualDb: true });
  const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
  const code = load
    .call({}, '\0virtual:void-db')
    .replace(
      /^import \{ (getRuntimeBinding, getRuntimeRequestResource) \} from .*;$/m,
      (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
    );
  writeFileSync(join(root, 'virtual-db.mjs'), code);
  return import(`${pathToFileURL(join(root, 'virtual-db.mjs')).href}?test=${crypto.randomUUID()}`);
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const key of fakeStateKeys.splice(0, fakeStateKeys.length)) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

beforeEach(() => {
  warnMock.mockReset();
});

describe('drizzlePlugin db typing generation', () => {
  it('uses one nearby D1 session per request, including custom bindings', async () => {
    const { module, state } = await loadExecutableDbModule('sqlite');
    const sessions: Array<{ constraint: string; owner: string }> = [];
    const binding = {
      withSession(constraint: string) {
        const session = { constraint, owner: 'default' };
        sessions.push(session);
        return session;
      },
    };

    const first = module.withEnv({ DB: binding }, () => [
      module.db.instanceId,
      module.db.instanceId,
    ]);
    const second = module.withEnv({ DB: binding }, () => module.db.instanceId);
    expect(first[0]).toBe(first[1]);
    expect(second).not.toBe(first[0]);
    expect(sessions).toEqual([
      { constraint: 'first-unconstrained', owner: 'default' },
      { constraint: 'first-unconstrained', owner: 'default' },
    ]);
    expect(state.clients).toEqual(sessions);

    const other = {
      withSession(constraint: string) {
        const session = { constraint, owner: 'other' };
        sessions.push(session);
        return session;
      },
    };
    module.createDb(other as unknown as string);
    expect(state.clients[2]).toEqual({ constraint: 'first-unconstrained', owner: 'other' });
  });

  it('uses a primary D1 session when a framework handler has no Void request scope', async () => {
    const { module, state } = await loadExecutableDbModule('sqlite');
    const previousEnv = (globalThis as Record<string, unknown>).__env__;
    (globalThis as Record<string, unknown>).__env__ = {
      DB: {
        withSession(constraint: string) {
          return { constraint };
        },
      },
    };
    try {
      expect(module.db.instanceId).not.toBe(module.db.instanceId);
      expect(state.clients).toEqual([
        { constraint: 'first-primary' },
        { constraint: 'first-primary' },
      ]);
    } finally {
      if (previousEnv === undefined) {
        delete (globalThis as Record<string, unknown>).__env__;
      } else {
        (globalThis as Record<string, unknown>).__env__ = previousEnv;
      }
    }
  });

  it.each(['postgresql', 'mysql'] as const)(
    'builds a %s client for each use when a framework handler has no Void request scope',
    async (dialect) => {
      const { module, state } = await loadExecutableDbModule(dialect);
      const previousEnv = (globalThis as Record<string, unknown>).__env__;
      (globalThis as Record<string, unknown>).__env__ = {
        HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
      };
      try {
        const first = module.db.instanceId;
        const second = module.db.instanceId;
        expect(second).not.toBe(first);
        expect(state.pools).toHaveLength(2);
        for (const pool of state.pools) {
          expect(pool.options).toMatchObject(
            dialect === 'postgresql'
              ? { connectionString: 'postgresql://hyperdrive', max: 1, idleTimeoutMillis: 1000 }
              : { uri: 'mysql://hyperdrive', connectionLimit: 1, disableEval: true },
          );
          // mysql2 would start a timer when it builds a pool with these.
          expect(pool.options).not.toHaveProperty('maxIdle');
          expect(pool.options).not.toHaveProperty('idleTimeout');
        }
      } finally {
        if (previousEnv === undefined) {
          delete (globalThis as Record<string, unknown>).__env__;
        } else {
          (globalThis as Record<string, unknown>).__env__ = previousEnv;
        }
      }
    },
  );

  it.each(['postgresql', 'mysql'] as const)(
    'builds no %s client for a query until it runs',
    async (dialect) => {
      const { db, clients } = await loadDriverDbModule(dialect);
      const users =
        dialect === 'postgresql'
          ? pgTable('users', { id: serial('id') })
          : mysqlTable('users', { id: int('id') });

      // A module-level query is built in global scope: no env exists there, and workerd
      // rejects the timer a mysql2 pool may start.
      const query = db.select().from(users);

      expect(query.toSQL().sql).toMatch(/^select .id. from .users.$/);
      expect(clients).toEqual([]);
    },
  );

  it.each([
    ['postgresql', 'PostgreSQL'],
    ['mysql', 'MySQL'],
  ] as const)('reports a missing %s connection string in a request', async (dialect, name) => {
    const { db, clients } = await loadDriverDbModule(dialect);
    const users =
      dialect === 'postgresql'
        ? pgTable('users', { id: serial('id') })
        : mysqlTable('users', { id: int('id') });

    // drizzle reports an error from a running query as "Failed query: ...".
    await expect(withRuntimeEnv({}, async () => await db.select().from(users))).rejects.toThrow(
      `db: ${name} is not configured.`,
    );
    expect(clients).toEqual([]);
  });

  it('keeps sqlite projects on the D1 internal db entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'sqlite');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { DrizzleD1Database } from "void/_db";');
    expect(dts).not.toContain('void/_db-pg');
  });

  it('keeps postgres-only types off the shared db runtime entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'postgresql');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain('export type { NodePgDatabase } from "void/_db-pg";');
    expect(dts).toContain(
      `export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max } from "void/_db";`,
    );
  });

  it('generates MySQL database types from the dedicated runtime entry', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'mysql');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('import type { MySql2Database } from "void/_db-mysql";');
    expect(dts).toContain('export type { MySql2Database } from "void/_db-mysql";');
  });

  it.each(['postgresql', 'mysql'] as const)(
    'keeps %s Hyperdrive clients inside one runtime invocation',
    async (dialect) => {
      const { module, state } = await loadExecutableDbModule(dialect);
      const sharedEnv = {
        HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
        REQUEST_ID: 'request-one',
      };

      const sameRequest = await module.withEnv(sharedEnv, async () => {
        const first = await module.db.query('request-one');
        const second = await module.db.query('request-one');
        const transaction = await module.db.transaction(async (tx) => ({
          proxy: module.db.instanceId,
          transaction: tx.instanceId,
        }));
        return { first, second, transaction };
      });

      expect(sameRequest.first).toBe(sameRequest.second);
      expect(sameRequest.transaction).toEqual({
        proxy: sameRequest.first,
        transaction: sameRequest.first,
      });

      sharedEnv.REQUEST_ID = 'request-two';
      const nextRequest = await module.withEnv(sharedEnv, () => module.db.query('request-two'));
      expect(nextRequest).not.toBe(sameRequest.first);

      const localOwner = `${dialect}://local`;
      await expect(
        module.withEnv({ DATABASE_URL: localOwner, REQUEST_ID: 'local' }, () =>
          module.db.query('local'),
        ),
      ).resolves.toBeTypeOf('number');

      const explicitOwner = `${dialect}://explicit`;
      await expect(module.createDb(explicitOwner).query(explicitOwner)).resolves.toBeTypeOf(
        'number',
      );

      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
      const firstOverlap = module.withEnv(
        {
          HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
          REQUEST_ID: 'overlap-one',
        },
        async () => {
          const before = await module.db.query('overlap-one');
          await firstGate;
          const after = await module.db.query('overlap-one');
          return { before, after };
        },
      );
      const secondOverlap = module.withEnv(
        {
          HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
          REQUEST_ID: 'overlap-two',
        },
        async () => {
          const before = await module.db.query('overlap-two');
          await secondGate;
          const after = await module.db.query('overlap-two');
          return { before, after };
        },
      );
      releaseSecond();
      releaseFirst();
      const [overlapOne, overlapTwo] = await Promise.all([firstOverlap, secondOverlap]);
      expect(overlapOne.before).toBe(overlapOne.after);
      expect(overlapTwo.before).toBe(overlapTwo.after);
      expect(overlapOne.before).not.toBe(overlapTwo.before);

      let background!: Promise<number>;
      const responseInstance = await module.withEnv(
        {
          HYPERDRIVE: { connectionString: `${dialect}://hyperdrive` },
          REQUEST_ID: 'background',
        },
        async () => {
          const instance = module.db.instanceId;
          background = new Promise((resolve, reject) => {
            setTimeout(() => module.db.query('background').then(resolve, reject), 0);
          });
          return instance;
        },
      );
      expect(await background).toBe(responseInstance);

      // MySQL createDb() builds its own pool through drizzle; the other pools are per request.
      const requestPools = state.pools.filter((pool) => pool.options.uri !== explicitOwner);
      expect(requestPools).toHaveLength(6);
      for (const pool of requestPools) {
        expect(pool.drizzleConfig).toEqual({});
        if (dialect === 'postgresql') {
          expect(pool.options).toMatchObject({ max: 1, idleTimeoutMillis: 1000 });
        } else {
          expect(pool.options).toMatchObject({ connectionLimit: 1, disableEval: true });
          expect(pool.options).not.toHaveProperty('maxIdle');
          expect(pool.options).not.toHaveProperty('idleTimeout');
        }
      }
      // Every request shares one drizzle database, which carries the schema.
      expect(state.instances).toEqual([
        dialect === 'postgresql'
          ? { schema: expect.anything() }
          : { schema: expect.anything(), mode: 'default' },
      ]);
      if (dialect === 'mysql') {
        expect(state.pools).toHaveLength(7);
        const explicitPool = state.pools.find((pool) => pool.options.uri === explicitOwner);
        expect(explicitPool?.options).toEqual({ uri: explicitOwner, disableEval: true });
        expect(explicitPool?.drizzleConfig).toEqual({ schema: expect.anything(), mode: 'default' });
        for (const pool of state.pools) {
          expect(pool.options).toMatchObject({ disableEval: true });
        }
      }
    },
  );

  it.each([
    ['mysql', 'mysql2'],
    ['postgresql', 'pg'],
  ] as const)('leaves the %s driver import to drizzle', (dialect, driver) => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, dialect);
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;

    const code = load.call({}, '\0virtual:void-db');
    const specifiers = Array.from(
      code.matchAll(/\b(?:from|import)\s*\(?\s*("[^"]+")/g),
      (match) => JSON.parse(match[1]!) as string,
    );

    // The worker optimizer serves drizzle's bare driver import from a prebundle. A bare import
    // here resolves from the app root, and an import by file path reaches workerd as CommonJS.
    const driverPath = new RegExp(`(^|[\\\\/])${driver}([\\\\/]|$)`);
    expect(
      specifiers.filter(
        (specifier) => driverPath.test(specifier) && !specifier.includes('drizzle-orm'),
      ),
    ).toEqual([]);
  });

  it.each([true, false])(
    'gives drizzle a mysql2 pool with eval disabled (schema: %s)',
    async (hasSchema) => {
      const root = createProjectRoot({ schema: hasSchema });
      const plugin = drizzlePlugin(root, false, 'mysql', { forceVirtualDb: true });
      const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
      const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
      const code = load
        .call({}, '\0virtual:void-db')
        .replace(
          /^import \{ (getRuntimeBinding, getRuntimeRequestResource) \} from .*;$/m,
          (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
        );
      writeFileSync(join(root, 'virtual-db.mjs'), code);
      writeFileSync(
        join(root, 'harness.mjs'),
        `import { db, createDb } from "./virtual-db.mjs";
import { withRuntimeEnv } from ${JSON.stringify(envUrl)};
export { createDb };
export const requestPoolConfig = (env) =>
  withRuntimeEnv(env, () => {
    const pool = db.$client;
    const config = pool.config;
    pool.end();
    return config;
  });
`,
      );
      type MySqlPoolConfig = { connectionConfig: { disableEval: boolean } };
      const harness = (await import(
        `${pathToFileURL(join(root, 'harness.mjs')).href}?test=${crypto.randomUUID()}`
      )) as {
        createDb(url: string): { $client: { config: MySqlPoolConfig; end(): void } };
        requestPoolConfig(env: Record<string, unknown>): MySqlPoolConfig;
      };

      const explicit = harness.createDb('mysql://void@127.0.0.1:9/app').$client;
      try {
        expect(explicit.config.connectionConfig.disableEval).toBe(true);
      } finally {
        explicit.end();
      }
      const request = harness.requestPoolConfig({ DATABASE_URL: 'mysql://void@127.0.0.1:9/app' });
      expect(request.connectionConfig.disableEval).toBe(true);
    },
  );

  it('closes idle MySQL connections without a timer when it builds a pool', async () => {
    const server = await startFakeMySqlServer([{ one: 1 }]);
    const url = `mysql://void@127.0.0.1:${server.port}/app`;
    const { db, createDb, sql } = await loadMySqlDbModule();
    const previousEnv = (globalThis as Record<string, unknown>).__env__;
    /** Run queries, then expect their connection to close once idle for `idleTimeout`. */
    const expectClosedWhenIdle = async (queries: () => Promise<unknown>, idleTimeout: number) => {
      await queries();
      expect(server.openConnections()).toBe(1);
      // The pool releases a connection before the query resolves.
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(idleTimeout - 1);
      expect(server.openConnections()).toBe(1);
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(server.openConnections()).toBe(0));
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // workerd rejects a timer started outside a request, and a pool can be built there.
      await withRuntimeEnv({ DATABASE_URL: url }, async () => {
        void db.$client;
        expect(vi.getTimerCount()).toBe(0);
        await expectClosedWhenIdle(async () => {
          await db.execute(sql`select 1`);
          await db.execute(sql`select 1`);
        }, 1000);
      });

      // A framework entry that Void does not wrap runs outside its request scope, where each
      // use builds a pool.
      (globalThis as Record<string, unknown>).__env__ = { DATABASE_URL: url };
      void db.$client.config;
      expect(vi.getTimerCount()).toBe(0);
      await expectClosedWhenIdle(() => db.execute(sql`select 1`), 1000);

      const own = createDb(url);
      try {
        expect(vi.getTimerCount()).toBe(0);
        await expectClosedWhenIdle(() => own.execute(sql`select 1`), 60_000);
        // The pool connects again for the next query.
        await own.execute(sql`select 1`);
        expect(server.openConnections()).toBe(1);
      } finally {
        await new Promise<void>((resolve) => own.$client.end(() => resolve()));
      }
    } finally {
      vi.useRealTimers();
      if (previousEnv === undefined) {
        delete (globalThis as Record<string, unknown>).__env__;
      } else {
        (globalThis as Record<string, unknown>).__env__ = previousEnv;
      }
      await server.close();
    }
  });

  it.each([true, false])(
    'gives drizzle a pg pool with the request options (schema: %s)',
    async (hasSchema) => {
      const root = createProjectRoot({ schema: hasSchema });
      const plugin = drizzlePlugin(root, false, 'postgresql', { forceVirtualDb: true });
      const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
      const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
      const code = load
        .call({}, '\0virtual:void-db')
        .replace(
          /^import \{ (getRuntimeBinding, getRuntimeRequestResource) \} from .*;$/m,
          (_match, imports: string) => `import { ${imports} } from ${JSON.stringify(envUrl)};`,
        );
      writeFileSync(join(root, 'virtual-db.mjs'), code);
      writeFileSync(
        join(root, 'harness.mjs'),
        `import { db } from "./virtual-db.mjs";
import { withRuntimeEnv } from ${JSON.stringify(envUrl)};
export const requestPoolOptions = (env) =>
  withRuntimeEnv(env, async () => {
    const pool = db.$client;
    const options = pool.options;
    await pool.end();
    return options;
  });
`,
      );
      const harness = (await import(
        `${pathToFileURL(join(root, 'harness.mjs')).href}?test=${crypto.randomUUID()}`
      )) as {
        requestPoolOptions(env: Record<string, unknown>): Promise<Record<string, unknown>>;
      };

      const url = 'postgres://void@127.0.0.1:9/app';
      await expect(harness.requestPoolOptions({ DATABASE_URL: url })).resolves.toMatchObject({
        connectionString: url,
        max: 1,
        idleTimeoutMillis: 1000,
      });
    },
  );

  it('serves schema imports of void/db from an operator-only virtual module', () => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'sqlite');
    const schemaPath = join(root, 'db', 'schema.ts');
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', schemaPath, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db-schema');

    const code = load.call({}, '\0virtual:void-db-schema');
    expect(code).toContain('export const db = {};');
    expect(code).toContain(
      'export { sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max }',
    );
    expect(code).not.toContain('requireRuntimeBinding');
  });

  it.each(['sqlite', 'postgresql', 'mysql'] as const)(
    'exports the %s SQL helpers before void/db imports the schema',
    (dialect) => {
      // A table file that db/schema.ts re-exports from outside db/ imports this module while
      // it loads the schema. Vite SSR runs imports in source order (#472).
      const root = createProjectRoot();
      const plugin = drizzlePlugin(root, false, dialect);
      const load = getHookHandler(plugin.load) as (this: object, id: string) => string;

      const code = load.call({}, '\0virtual:void-db').trim();

      expect(code.startsWith('export { sql, eq, ')).toBe(true);
      expect(code).toContain('import * as schema');
    },
  );

  it('treats files in db/schema/ beside db/schema.ts as schema files', () => {
    // `void gen model` writes db/schema/<name>.ts and re-exports it from db/schema.ts.
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'sqlite');
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const resolve = (importer: string) =>
      resolveId.call({ environment: { name: 'ssr' } }, 'void/db', importer, { isEntry: false });

    expect(resolve(join(root, 'db', 'schema', 'todos.ts'))).toBe('\0virtual:void-db-schema');
    expect(resolve(join(root, 'db', 'schema-helpers.ts'))).toBe('\0virtual:void-db');
    expect(resolve(join(root, 'routes', 'api', 'todos', 'index.ts'))).toBe('\0virtual:void-db');
  });

  it('can virtualize void/db without a user schema when forced', () => {
    const root = createProjectRoot({ schema: false });
    const plugin = drizzlePlugin(root, false, 'postgresql', { forceVirtualDb: true });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', undefined, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db');

    const dts = readFileSync(join(root, '.void', 'db.d.ts'), 'utf8');
    expect(dts).toContain('NodePgDatabase<Record<string, never>>');
    expect(dts).not.toContain('@schema');

    const tsconfig = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.paths['void/db']).toEqual(['./db.d.ts']);
    expect(tsconfig.compilerOptions.paths['@schema']).toBeUndefined();

    const code = load.call({}, '\0virtual:void-db');
    expect(code).toContain('import { drizzle } from "');
    expect(code).not.toMatch(/\bschema\b/);
  });

  // The package's own void/db is a D1 client, which never fits these dialects.
  it.each(['postgresql', 'mysql'] as const)('serves the %s void/db without a schema', (dialect) => {
    const root = createProjectRoot({ schema: false });
    const plugin = drizzlePlugin(root, false, dialect);
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;

    expect(
      resolveId.call({ environment: { name: 'ssr' } }, 'void/db', undefined, { isEntry: false }),
    ).toBe('\0virtual:void-db');
    expect(readFileSync(join(root, '.void', 'db.d.ts'), 'utf8')).toContain('Record<string, never>');
  });

  // Nitro bundles a Nuxt or Analog server build's output with the server routes, and serves
  // them all one void/db: the app's through `void/nitro`, or the package's, which names it.
  it('leaves a PostgreSQL or MySQL void/db to Nitro in a Nitro framework build', () => {
    const root = createProjectRoot();
    const schemaPath = join(root, 'db', 'schema.ts');
    const resolveIn = (
      dialect: 'sqlite' | 'postgresql' | 'mysql',
      mode: 'build' | 'dev',
      importer?: string,
    ) => {
      const plugin = drizzlePlugin(root, false, dialect, { nitroBundlesServer: true });
      const resolveId = getHookHandler(plugin.resolveId) as (
        this: { environment: { name: string; mode: string } },
        source: string,
        importer: string | undefined,
        options: { isEntry: boolean },
      ) => unknown;
      return resolveId.call({ environment: { name: 'ssr', mode } }, 'void/db', importer, {
        isEntry: false,
      });
    };

    const page = join(root, 'src', 'app', 'pages', 'users.server.ts');
    expect(resolveIn('postgresql', 'build', page)).toEqual({ id: 'void/db', external: true });
    expect(resolveIn('mysql', 'build', page)).toEqual({ id: 'void/db', external: true });
    expect(resolveIn('postgresql', 'dev', page)).toBe('\0virtual:void-db');
    expect(resolveIn('sqlite', 'build', page)).toBe('\0virtual:void-db');
    // The schema's own import of void/db still gets its SQL helpers.
    expect(resolveIn('postgresql', 'build', schemaPath)).toBe('\0virtual:void-db-schema');
  });

  it('uses a custom D1 binding name in the sqlite virtual module', () => {
    const root = createProjectRoot({ schema: false });
    const plugin = drizzlePlugin(root, false, 'sqlite', {
      d1BindingName: 'myapp_db',
      forceVirtualDb: true,
    });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;
    const load = getHookHandler(plugin.load) as (this: object, id: string) => string;
    const resolved = resolveId.call({ environment: { name: 'ssr' } }, 'void/db', undefined, {
      isEntry: false,
    });

    expect(resolved).toBe('\0virtual:void-db');

    const code = load.call({}, '\0virtual:void-db');
    expect(code).toContain('requireRuntimeBinding("myapp_db")');
    expect(code).not.toContain('requireRuntimeBinding("DB")');
  });

  it('can keep void/db off tsconfig paths for metaframeworks that materialize aliases', () => {
    const root = createProjectRoot();

    drizzlePlugin(root, false, 'sqlite', { redirectDbTypePaths: false });

    const tsconfig = JSON.parse(readFileSync(join(root, '.void', 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.paths['void/db']).toBeUndefined();
    expect(tsconfig.compilerOptions.paths['@schema']).toEqual(['../db/schema.ts']);
  });

  it('warns when a sqlite schema has neither migrations nor a pushed local database', async () => {
    const root = createProjectRoot();
    const plugin = drizzlePlugin(root, false, 'sqlite');
    const configureServer = getHookHandler(plugin.configureServer) as (
      server: unknown,
    ) => Promise<void>;

    await configureServer({ watcher: { on: vi.fn() } });

    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('Schema found but no migrations in db/migrations/.'),
    );
  });

  it('does not warn after void db push has created local sqlite tables', async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, 'local-state');
    const dbPath = getMiniflareDatabasePath(persistRoot, 'local');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    } finally {
      db.close();
    }

    const plugin = drizzlePlugin(root, false, 'sqlite', { localD1PersistRoot: persistRoot });
    const configureServer = getHookHandler(plugin.configureServer) as (
      server: unknown,
    ) => Promise<void>;

    await configureServer({ watcher: { on: vi.fn() } });

    expect(warnMock).not.toHaveBeenCalled();
  });

  it('checks schema state using the configured local D1 database ID', async () => {
    const root = createProjectRoot();
    const persistRoot = join(root, 'local-state');
    const databaseId = 'configured-preview-id';
    const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    } finally {
      db.close();
    }

    const plugin = drizzlePlugin(root, false, 'sqlite', {
      localD1DatabaseId: databaseId,
      localD1PersistRoot: persistRoot,
    });
    const configureServer = getHookHandler(plugin.configureServer) as (
      server: unknown,
    ) => Promise<void>;

    await configureServer({ watcher: { on: vi.fn() } });

    expect(warnMock).not.toHaveBeenCalled();
  });
});
