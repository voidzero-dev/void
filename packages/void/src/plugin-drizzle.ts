import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative } from 'pathslash';
import { normalizePath, type Plugin } from 'vite';
import { DRIZZLE_OPERATORS, generateDbDts } from './codegen/db-types.ts';
import { ensureProjectTsconfig } from './codegen/project-tsconfig.ts';
import {
  getDatabaseCasing,
  getDatabaseDialect,
  readConfig,
  resolveBindingNames,
  type DatabaseCasing,
  type VoidConfig,
} from './config.ts';
import { discoverSchema } from './drizzle/discover.ts';
import { voidWarn } from './log.ts';
import { readProjectPaths, resolveProjectPaths, type ProjectPaths } from './project-paths.ts';

// Resolve drizzle-orm paths from void's own deps so they work in any project
// (including metaframeworks where drizzle-orm isn't a direct dependency).
const drizzleD1Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/d1'));
const drizzleOrmResolved = fileURLToPath(import.meta.resolve('drizzle-orm'));
const envModuleResolved = fileURLToPath(import.meta.resolve('#self/_env'));
const drizzleNodePgResolved = fileURLToPath(import.meta.resolve('drizzle-orm/node-postgres'));
const drizzleMysql2Resolved = fileURLToPath(import.meta.resolve('drizzle-orm/mysql2'));

const VIRTUAL_DB_ID = '\0virtual:void-db';
const VIRTUAL_SCHEMA_DB_ID = '\0virtual:void-db-schema';

// Workers tie a connection to the request that opened it. void/db's PostgreSQL and MySQL
// templates share one drizzle instance whose client looks up the current request's pool on
// every call, so a query built or prepared in one request runs on the pool of the request that
// executes it. `has` and `getPrototypeOf` answer drizzle's pool checks before a transaction.
// Every pool has the same shape, so those answers are kept: outside a request scope, where each
// lookup builds a pool, a check would otherwise build one that never runs a query.
const REQUEST_POOL_PROXY = `
function requestPool(resolve, own = {}) {
  const has = new Map();
  let prototype;
  return new Proxy({}, {
    get(_, prop) {
      if (Object.hasOwn(own, prop)) return own[prop];
      const pool = resolve();
      const value = Reflect.get(pool, prop);
      return typeof value === "function" ? value.bind(pool) : value;
    },
    has(_, prop) {
      if (Object.hasOwn(own, prop)) return true;
      if (!has.has(prop)) has.set(prop, Reflect.has(resolve(), prop));
      return has.get(prop);
    },
    getPrototypeOf: () => (prototype ??= Object.getPrototypeOf(resolve())),
  });
}
`;
type VoidDbModuleOptions = {
  d1BindingName?: string;
  forceVirtualDb?: boolean;
  /** Drizzle's `casing` from `database.casing`. Unset passes none to drizzle. */
  casing?: DatabaseCasing;
};
type DrizzlePluginOptions = VoidDbModuleOptions & {
  localD1DatabaseId?: string;
  localD1PersistRoot?: string;
  redirectDbTypePaths?: boolean;
  /** Nitro bundles the server build's output (Nuxt and Analog). */
  nitroBundlesServer?: boolean;
};

/**
 * The app's `void/db` module for its dialect, schema and D1 binding. Resolving and loading
 * have no side effects, so the Vite plugin and `voidDbBundlerPlugin` share them.
 */
function createVoidDbModule(
  root: string,
  dialect: 'sqlite' | 'postgresql' | 'mysql',
  options: VoidDbModuleOptions,
  paths: ProjectPaths = readProjectPaths(root),
) {
  const schema = discoverSchema(root, paths);
  // The package's own `void/db` is a D1 client, so PostgreSQL and MySQL always need this one.
  // It cannot apply `database.casing` either, which also names the columns of tables that an
  // app keeps outside its schema.
  const hasDbRuntime =
    schema != null ||
    options.forceVirtualDb === true ||
    options.casing !== undefined ||
    dialect !== 'sqlite';
  const d1BindingName = options.d1BindingName ?? 'DB';

  return {
    schema,
    hasDbRuntime,

    resolveId(id: string, importer: string | undefined): string | undefined {
      if (id === 'void/db') {
        if (!hasDbRuntime) {
          return;
        } // Fall through to the real module (stub)
        // Don't redirect schema files to avoid circular dependency
        // (virtual:void-db imports the schema, which imports void/db).
        // Schema files only need SQL helpers, not the runtime DB instance.
        if (schema && importer) {
          // Normalize separators for Windows — Vite uses forward slashes,
          // but schema.path from Node's path.join uses backslashes on Windows.
          const normalizedImporter = normalizePath(importer);
          const normalizedSchemaPath = normalizePath(schema.path);
          if (schema.type === 'file' && normalizedImporter === normalizedSchemaPath) {
            return VIRTUAL_SCHEMA_DB_ID;
          }
          if (schema.type === 'directory' && normalizedImporter.startsWith(normalizedSchemaPath)) {
            return VIRTUAL_SCHEMA_DB_ID;
          }
        }
        return VIRTUAL_DB_ID;
      }

      // Resolve @schema alias explicitly via resolveId so it works in
      // meta-framework SSR environments (Astro's workerd runner, etc.)
      // where Vite's config-level resolve.alias may not be applied.
      if (schema && (id === '@schema' || id.startsWith('@schema/'))) {
        if (id === '@schema') {
          return schema.path;
        }
        return join(schema.path, id.slice('@schema/'.length));
      }
    },

    load: {
      // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
      filter: { id: /^\0virtual:void-db(?:-schema)?$/ },
      handler(id: string): string {
        if (id === VIRTUAL_SCHEMA_DB_ID) {
          return `
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};
export const db = {};
export function createDb() {
  throw new Error("db: createDb() is unavailable when importing void/db from a schema file.");
}
`;
        }

        // void/db virtual module
        const schemaImport = schema
          ? `import * as schema from ${JSON.stringify(schema.path)};`
          : '';
        const casingOption = options.casing ? `casing: ${JSON.stringify(options.casing)}` : '';
        const drizzleOptions = [schema ? 'schema' : '', casingOption].filter(Boolean);
        const drizzleConfig = drizzleOptions.length > 0 ? `, { ${drizzleOptions.join(', ')} }` : '';
        // The same options as keys after the client in drizzle's single-object form.
        const drizzleOptionKeys = drizzleOptions.map((option) => `, ${option}`).join('');

        if (dialect === 'mysql') {
          // drizzle builds the pool from `connection`, so its bare mysql2 import is the only one
          // and the worker prebundle serves it. Its config check rejects `mode` without `schema`.
          const mysqlDrizzleConfig =
            (schema ? ', schema, mode: "default"' : '') + (casingOption ? `, ${casingOption}` : '');
          return `
import { drizzle } from ${JSON.stringify(drizzleMysql2Resolved)};
import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

const _requestResourceKey = {};

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("db: MySQL is not configured. Add DATABASE_URL to .env for local dev, or configure Hyperdrive for production.");
}

// mysql2 closes idle connections only from a timer that it starts when it builds a pool with
// maxIdle below connectionLimit, and that timer runs until the pool ends: workerd rejects it in
// global scope, and nothing ends Void's pools. Time each connection from its release instead,
// which runs in the request that ran the query.
function closeIdleConnections(pool, idleTimeout) {
  const timers = new WeakMap();
  pool.on("release", (connection) => {
    const timer = setTimeout(() => connection.destroy(), idleTimeout);
    // A Node script that ends its pool exits without waiting for this timer.
    timer.unref?.();
    timers.set(connection, timer);
  });
  pool.on("acquire", (connection) => clearTimeout(timers.get(connection)));
  return pool;
}

function createPools() {
  const pool = closeIdleConnections(
    drizzle({
      connection: {
        uri: getConnectionString(),
        connectionLimit: 1,
        // Workers forbid eval, which mysql2 uses to build its row parsers.
        disableEval: true,
      },
    }).$client,
    1000,
  );
  return { pool, promisePool: pool.promise() };
}

function getPools() {
  // Framework entries that Void does not own run outside its request scope:
  // they get a client for each use, never one shared across requests.
  return getRuntimeRequestResource(_requestResourceKey, createPools, createPools);
}
${REQUEST_POOL_PROXY}
const promiseClient = requestPool(() => getPools().promisePool);
// drizzle asks for the promise API while it builds the database, which can run in global
// scope. No request exists there to own a pool, so answer without one.
const client = requestPool(() => getPools().pool, { promise: () => promiseClient });

let instance;

export const db = new Proxy({}, {
  get(_, prop) {
    // drizzle reports a query's errors as "Failed query", so build the request's pool here:
    // a missing connection string then throws its own message. Outside a request, build none.
    getRuntimeRequestResource(_requestResourceKey, createPools, () => undefined);
    instance ??= drizzle({ client${mysqlDrizzleConfig} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function createDb(connectionString) {
  const db = drizzle({ connection: { uri: connectionString, disableEval: true }${mysqlDrizzleConfig} });
  // 60 seconds is mysql2's own idleTimeout default.
  closeIdleConnections(db.$client, 60000);
  return db;
}
`;
        }

        if (dialect === 'postgresql') {
          // Like MySQL: drizzle builds the pool, so its bare pg import is the only one.
          return `
import { drizzle } from ${JSON.stringify(drizzleNodePgResolved)};
import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

const _requestResourceKey = {};

function getConnectionString() {
  const url = getRuntimeBinding("DATABASE_URL");
  if (url) return url;
  const hd = getRuntimeBinding("HYPERDRIVE");
  if (hd?.connectionString) return hd.connectionString;
  throw new Error("db: PostgreSQL is not configured. Add DATABASE_URL to .env for local dev, or configure Hyperdrive for production.");
}

function createPool() {
  return drizzle({
    connection: {
      connectionString: getConnectionString(),
      max: 1,
      idleTimeoutMillis: 1000,
    },
  }).$client;
}

function getPool() {
  // Framework entries that Void does not own run outside its request scope:
  // they get a client for each use, never one shared across requests.
  return getRuntimeRequestResource(_requestResourceKey, createPool, createPool);
}
${REQUEST_POOL_PROXY}
let instance;

export const db = new Proxy({}, {
  get(_, prop) {
    // drizzle reports a query's errors as "Failed query", so build the request's pool here:
    // a missing connection string then throws its own message. Outside a request, build none.
    getRuntimeRequestResource(_requestResourceKey, createPool, () => undefined);
    instance ??= drizzle({ client: requestPool(getPool)${drizzleOptionKeys} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function createDb(connectionString) {
  return drizzle(connectionString${drizzleConfig});
}
`;
        }

        // SQLite (default)
        return `
import { drizzle } from ${JSON.stringify(drizzleD1Resolved)};
import { getRuntimeRequestResource, requireRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
${schemaImport}
export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(drizzleOrmResolved)};

const _requestResourceKey = {};

export const db = new Proxy({}, {
  get(_, prop) {
    const instance = getRuntimeRequestResource(
      _requestResourceKey,
      () => createDb(requireRuntimeBinding(${JSON.stringify(d1BindingName)})),
      () => createPrimaryDb(requireRuntimeBinding(${JSON.stringify(d1BindingName)}))
    );
    return Reflect.get(instance, prop);
  },
});

export function createDb(d1) {
  return drizzle(d1.withSession("first-unconstrained")${drizzleConfig});
}

function createPrimaryDb(d1) {
  return drizzle(d1.withSession("first-primary")${drizzleConfig});
}
`;
      },
    },
  };
}

/**
 * Vite plugin for Drizzle integration.
 *
 * - Intercepts `void/db` imports in SSR/worker environments and serves
 *   a virtual module that creates a Drizzle DB instance, using the user's
 *   schema when present.
 * - Generates `.void/db.d.ts` with proper Drizzle types.
 * - Sets up `@schema` Vite alias for convenient imports when a schema exists.
 * - Updates `.void/tsconfig.json` with TypeScript paths.
 */
export function drizzlePlugin(
  root: string,
  hasRouteTypes: boolean,
  dialect: 'sqlite' | 'postgresql' | 'mysql' = 'sqlite',
  options: DrizzlePluginOptions = {},
): Plugin {
  const outDir = join(root, '.void');
  const paths = readProjectPaths(root);
  const dbModule = createVoidDbModule(root, dialect, options, paths);
  const { schema, hasDbRuntime } = dbModule;

  // Always write tsconfig (for routes.d.ts, queues.d.ts, etc.)
  ensureProjectTsconfig(root, hasRouteTypes, hasDbRuntime, schema != null, {
    redirectDbModule: options.redirectDbTypePaths,
    paths,
  });

  // Generate db.d.ts when void/db is available, even without a user schema.
  if (hasDbRuntime) {
    generateDbDts(outDir, schema ?? null, dialect);
  }

  return {
    name: 'void:drizzle',
    enforce: 'pre',

    config() {
      if (!schema) {
        return;
      }

      return {
        resolve: {
          alias: {
            '@schema': schema.path,
          },
        },
      };
    },

    resolveId: {
      filter: { id: /^(void\/db|@schema)/ },
      handler(id, importer) {
        // Only intercept void/db in server/worker environments (not client)
        if (id === 'void/db' && this.environment?.name === 'client') {
          return;
        }
        const resolved = dbModule.resolveId(id, importer);
        // Nitro bundles this output with the server routes. Leave a PostgreSQL or MySQL app's
        // `void/db` to it, so the app has one client and one driver copy: the one `void/nitro`
        // serves, or without the module the package's own, which says to add it.
        if (
          resolved === VIRTUAL_DB_ID &&
          dialect !== 'sqlite' &&
          options.nitroBundlesServer &&
          this.environment?.mode === 'build'
        ) {
          return { id, external: true };
        }
        return resolved;
      },
    },

    load: dbModule.load,

    async configureServer() {
      if (!schema) {
        return;
      }

      // Check for schema drift on startup
      const migrationsDir = paths.migrationsDir;
      const hasMigrations =
        existsSync(migrationsDir) && readdirSync(migrationsDir).some((f) => f.endsWith('.sql'));

      if (!hasMigrations) {
        if (dialect === 'sqlite') {
          const { getApplicationTables, getMiniflareDatabasePath } =
            await import('./migrations/runner.ts');
          const dbPath = getMiniflareDatabasePath(
            options.localD1PersistRoot ?? join(root, '.void'),
            options.localD1DatabaseId ?? 'local',
          );
          const tables = await getApplicationTables(dbPath).catch(() => []);
          if (tables.length > 0) {
            return;
          }
        }

        voidWarn(
          `Schema found but no migrations in ${paths.sourceRelative('db/migrations')}/.\n` +
            '         `void db push` syncs the schema to your local DB without creating migration files.\n' +
            '         Run `void db generate` to create migration files for dev startup and deploy.',
        );
      }
    },
  };
}

/**
 * `void/db` and `@schema` for bundles that do not run Void's Vite plugins: Nitro's (Nuxt and
 * Analog server routes, through `void/nitro`) and the cron and queue handler bundle that deploys
 * build. Without it they load the package's static `void/db`, a D1 client without the app's
 * schema. It reads the dialect, schema and D1 binding from the project, as the Vite plugin does.
 * Its hooks are plain Rollup hooks; Vite also needs `enforce` to run them before its resolver.
 *
 * For a bundle that runs in workerd, `sqlDriver` builds a copy of the PostgreSQL or MySQL driver
 * from its entry file, and the plugin serves that module for `pg` or `mysql2` (for
 * `mysql2/promise`, the promise API from the same build). Each import gets the copy that the
 * bundler resolves for it: the generated client's drizzle-orm gets the one it depends on, and an
 * app's own import gets the app's version.
 */
export function voidDbBundlerPlugin(
  root: string,
  options: {
    config?: VoidConfig;
    sqlDriver?: (dialect: 'postgresql' | 'mysql', entry: string) => Promise<string>;
  } = {},
): Plugin {
  const config = options.config ?? readConfig(root);
  const dialect = getDatabaseDialect(config);
  const d1BindingName = resolveBindingNames(config.inference?.bindings)?.d1;
  const dbModule = createVoidDbModule(
    root,
    dialect,
    // The package's own `void/db` reads D1 from the `DB` binding.
    {
      d1BindingName,
      forceVirtualDb: d1BindingName !== undefined,
      casing: getDatabaseCasing(config),
    },
    resolveProjectPaths(root, config),
  );
  const driverPackage =
    dialect === 'postgresql' ? 'pg' : dialect === 'mysql' ? 'mysql2' : undefined;
  const drivers = new Map<string, Promise<string>>();
  const driverDirs: Array<string> = [];
  return {
    name: 'void:db',
    enforce: 'pre',
    async resolveId(id, importer, resolveOptions) {
      const promiseApi = driverPackage === 'mysql2' && MYSQL2_PROMISE.test(id);
      if ((id === driverPackage || promiseApi) && options.sqlDriver && dialect !== 'sqlite') {
        // Resolve it as a `require` would. For an import, Rollup's CommonJS plugin loads a CommonJS
        // driver to wrap it: that hides the file, and its build of the driver can fail on optional
        // native modules.
        const custom = resolveOptions?.custom;
        const resolved = await this.resolve(id, importer, {
          ...resolveOptions,
          skipSelf: true,
          custom: { ...custom, 'node-resolve': { ...custom?.['node-resolve'], isRequire: true } },
        });
        const entry =
          resolved && !resolved.external
            ? resolvePackageEntry(driverPackage, resolved.id)
            : undefined;
        if (entry === undefined) {
          return resolved;
        }
        let driver = drivers.get(entry);
        if (!driver) {
          assertWorkerDriver(driverPackage, entry, root, importer);
          driver = options.sqlDriver(dialect, entry).then((path) => {
            driverDirs.push(`${normalizePath(dirname(path))}/`);
            return path;
          });
          drivers.set(entry, driver);
        }
        // The promise API sits next to the driver, named the way `sqlDriver` names the driver.
        return promiseApi ? (await driver).replace(/mysql2\.mjs$/, 'promise.mjs') : driver;
      }
      // The driver needs workerd's own Node modules: Nitro replaces them with stubs when its
      // `cloudflare.nodeCompat` option is off.
      if (
        id.startsWith('node:') &&
        importer &&
        driverDirs.some((dir) => normalizePath(importer).startsWith(dir))
      ) {
        return { id, external: true };
      }
      const resolved = dbModule.resolveId(id, importer);
      if (resolved !== undefined && id !== 'void/db') {
        // `@schema` can name a schema folder or a file without its extension. Only Vite's
        // config alias hands those to a resolver, so apply the bundler's own rules here.
        return this.resolve(resolved, importer, { skipSelf: true });
      }
      return resolved ?? null;
    },
    load(id) {
      if (id !== VIRTUAL_DB_ID && id !== VIRTUAL_SCHEMA_DB_ID) {
        return null;
      }
      return dbModule.load.handler(id);
    },
  };
}

/** mysql2's promise API, which `bundleWorkerSqlDriver` builds next to the driver. */
const MYSQL2_PROMISE = /^mysql2\/promise(?:\.js)?$/;

/**
 * The first driver versions that run in Workers: pg 8.11 brings pg-cloudflare, its socket there,
 * and mysql2 3.13 the `disableEval` option, without which it compiles its parsers with
 * `new Function`, which workerd forbids.
 */
const WORKER_DRIVER_MINIMUM: Record<'pg' | 'mysql2', [major: number, minor: number]> = {
  pg: [8, 11],
  mysql2: [3, 13],
};

/** Throw when the driver whose entry file is `entry` is older than Workers need. */
function assertWorkerDriver(
  name: 'pg' | 'mysql2',
  entry: string,
  root: string,
  importer: string | undefined,
): void {
  let version: string | undefined;
  try {
    const packageJson = createRequire(entry).resolve(`${name}/package.json`);
    ({ version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string });
  } catch {
    return;
  }
  const match = /^(\d+)\.(\d+)\./.exec(version ?? '');
  const [major, minor] = WORKER_DRIVER_MINIMUM[name];
  if (
    !match ||
    Number(match[1]) > major ||
    (Number(match[1]) === major && Number(match[2]) >= minor)
  ) {
    return;
  }
  const source = importer ? ` Imported by ${relative(root, importer)}.` : '';
  throw new Error(
    `${name} ${version} cannot run in Cloudflare Workers, which need ${name} ${major}.${minor} or later. Upgrade ${name}.${source}`,
  );
}

/**
 * The CommonJS entry of package `name`, from `file` inside one of its copies (which a bundler may
 * have resolved to an ES module entry), or undefined if `file` is not on disk.
 */
function resolvePackageEntry(name: string, file: string): string | undefined {
  if (!isAbsolute(file)) {
    return undefined;
  }
  try {
    return createRequire(file).resolve(name);
  } catch {
    return undefined;
  }
}
