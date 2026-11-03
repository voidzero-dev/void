import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { confirm, isCancel, outro, log, text } from '@voidzero-dev/vite-plus-prompts';
import { createJiti } from 'jiti';
import { basename, dirname, extname, join, relative, resolve } from 'pathslash';
import {
  readConfig,
  getDatabaseCasing,
  getDatabaseDialect,
  resolveBindingNames,
  type DatabaseCasing,
  type DatabaseDialect,
} from '../config.ts';
import type { DatabaseProviderAdapter, DatabaseProviderDialect } from '../database-provider.ts';
import { resolveLocalD1Target, type LocalD1Target } from '../local-d1.ts';
import {
  collectMigrations,
  readJournal,
  stripSqlExt,
  writeJournal,
} from '../migrations/collect.ts';
import type { MySqlClient } from '../migrations/runner-mysql.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import { detectFramework } from '../plugin-inference.ts';
import { readProjectPaths } from '../project-paths.ts';
import type { SeedFn } from '../runtime/seed.ts';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { loadLocalEnv } from '../shared/env.ts';
import { getProxyUrl, getToken } from './auth.ts';
import {
  ensurePlatformAccessToken,
  ensurePlatformProxyAccess,
  isCloudflareAccessChallenge,
} from './cf-access.ts';
import { PlatformApiError, PlatformClient } from './client.ts';
import type { DbArgs } from './db-args.ts';
import {
  assertPgExportableSchema,
  exportPgConstraints,
  exportPgSequences,
  quoteSqlIdentifier,
  quoteSqlString,
} from './db-export-sequences.ts';
import { formatTimestamp } from './gen.ts';
import { printSuccess, dim, formatCount, formatUrl, getErrorMessage, pc } from './output.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';
import { drizzleKitBin } from './yarn-pnp.ts';

const DEFAULT_SEED_FILES = [
  'db/seed.ts',
  'db/seed.mts',
  'db/seed.js',
  'db/seed.mjs',
  'db/seed.sql',
];
const MODULE_SEED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);

export function getLocalD1Target(root: string): LocalD1Target {
  const detected = detectFramework(root);
  const defaultPersistRoot =
    detected && (detected.class === 'b' || detected.class === 'c')
      ? join(root, '.wrangler', 'state')
      : join(root, '.void');
  return resolveLocalD1Target(root, {
    bindingName: configuredD1Binding(root),
    defaultPersistRoot,
    readPersistState: true,
  });
}

function configuredD1Binding(root: string): string {
  return resolveBindingNames(readConfig(root).inference?.bindings)?.d1 ?? 'DB';
}

function runDrizzleKit(root: string, args: Array<string>): void {
  execFileSync(process.execPath, [drizzleKitBin, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
}

/**
 * Run a drizzle-kit command against a real database URL. The config holding
 * the URL lives in a private temp directory outside the project and is
 * removed afterwards. Exits with code 1 when drizzle-kit fails; it has
 * already printed its own error.
 */
async function runDrizzleKitWithDatabaseUrl(
  root: string,
  url: string,
  dialect: DatabaseDialect,
  command: 'push' | 'studio',
): Promise<void> {
  const { withPrivateDrizzleConfig } = await import('../drizzle/config.ts');
  const succeeded = withPrivateDrizzleConfig(root, url, dialect, (configPath) => {
    try {
      runDrizzleKit(root, [command, '--config', configPath]);
      return true;
    } catch {
      return false;
    }
  });
  if (!succeeded) {
    process.exit(1);
  }
}

type SeedTarget = {
  displayPath: string;
  kind: 'module' | 'sql';
  path: string;
};

type PgClient = {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<{ rows: Array<T> }>;
};

function getLocalDatabaseUrl(root: string, dialect: 'postgresql' | 'mysql'): string {
  const url = loadLocalEnv(root).DATABASE_URL;
  if (!url) {
    throw new Error(
      `DATABASE_URL not found in .env. Add it to connect to your local ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} database.`,
    );
  }
  return url;
}

async function withPgClient<T>(root: string, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const url = getLocalDatabaseUrl(root, 'postgresql');
  const { Client } = await import('pg');
  const client: PgClient = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withMySqlClient<T>(
  root: string,
  fn: (client: MySqlClient) => Promise<T>,
  options: { textValues?: boolean } = {},
): Promise<T> {
  const { toMySqlClient } = await import('../migrations/runner-mysql.ts');
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({
    uri: getLocalDatabaseUrl(root, 'mysql'),
    multipleStatements: true,
    // Read dates, JSON and large integers as MySQL's own text, not as JavaScript values.
    ...(options.textValues
      ? { dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true }
      : {}),
  });
  try {
    return await fn(toMySqlClient(connection));
  } finally {
    await connection.end();
  }
}

function validatePendingMigrations(
  migrations: Array<{ name: string; sql: string }>,
  appliedNames: Set<string>,
): void {
  const pending = migrations.filter((migration) => !appliedNames.has(migration.name));
  if (pending.length === 0) {
    return;
  }
  validateMigrations(pending);
}

export async function runDbCommand(root: string, args: DbArgs): Promise<void> {
  // Keep raw SQL exports clean for piping into other tools.
  if (!(args.action === 'export' && !args.output)) {
    console.log();
  }

  const dialect = getDatabaseDialect(readConfig(root));

  if (args.action === 'push') {
    await runPush(root, dialect);
  } else if (args.action === 'generate') {
    await runGenerate(root, dialect);
  } else if (args.action === 'status') {
    await runStatus(root, dialect);
  } else if (args.action === 'reset') {
    await runReset(root, dialect, args.yes);
  } else if (args.action === 'seed') {
    await runSeed(root, args.file, dialect, args.yes);
  } else if (args.action === 'execute') {
    await runExecute(root, args.command, args.file, dialect, args.remote);
  } else if (args.action === 'migrate') {
    await runMigrate(root, dialect, args.remote);
  } else if (args.action === 'studio') {
    await runStudio(root, dialect, args.remote);
  } else if (args.action === 'set-url') {
    await runSetUrl(root, dialect);
  } else if (args.action === 'connect') {
    await runConnect(root, dialect, args);
  } else if (args.action === 'restore') {
    await runRestore(root, dialect, args);
  } else if (args.action === 'rename-migrations') {
    await runRenameMigrations(root, dialect);
  } else {
    await runExport(root, args, dialect);
  }
}

export function writeLocalDatabaseUrl(root: string, connectionString: string): void {
  const envPath = join(root, '.env');
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const lines = original ? original.replace(/\r\n/g, '\n').split('\n') : [];
  const assignment = `DATABASE_URL=${JSON.stringify(connectionString)}`;
  const index = lines.findIndex((line) => /^\s*(?:export\s+)?DATABASE_URL\s*=/.test(line));
  if (index === -1) {
    while (lines.at(-1) === '') {
      lines.pop();
    }
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(assignment);
  } else {
    lines[index] = assignment;
    for (let i = lines.length - 1; i > index; i--) {
      if (/^\s*(?:export\s+)?DATABASE_URL\s*=/.test(lines[i])) {
        lines.splice(i, 1);
      }
    }
  }
  while (lines.at(-1) === '') {
    lines.pop();
  }
  writeFileSync(envPath, `${lines.join('\n')}\n`);
}

function assertDatabaseProvider(value: unknown, source: string): DatabaseProviderAdapter {
  if (!value || typeof value !== 'object') {
    throw new Error(`Database provider '${source}' did not export an adapter object.`);
  }
  const adapter = value as Partial<DatabaseProviderAdapter>;
  if (
    typeof adapter.id !== 'string' ||
    typeof adapter.label !== 'string' ||
    !Array.isArray(adapter.dialects) ||
    typeof adapter.provision !== 'function'
  ) {
    throw new Error(`Database provider '${source}' does not implement DatabaseProviderAdapter.`);
  }
  return adapter as DatabaseProviderAdapter;
}

export async function loadDatabaseProvider(
  root: string,
  provider: string,
): Promise<DatabaseProviderAdapter> {
  if (provider === 'neon') {
    const { createNeonDatabaseProvider } = await import('../database-providers/neon.ts');
    return createNeonDatabaseProvider();
  }

  const requireFromProject = createRequire(join(root, 'package.json'));
  let resolved: string;
  try {
    resolved =
      provider.startsWith('.') || provider.startsWith('/')
        ? resolve(root, provider)
        : requireFromProject.resolve(provider);
  } catch {
    throw new Error(
      `Could not resolve database provider adapter '${provider}' from this project. Install it first or pass a file path.`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  return assertDatabaseProvider(mod.default ?? mod.databaseProvider, provider);
}

async function runConnect(
  root: string,
  dialect: DatabaseDialect,
  args: {
    url?: string;
    provider?: string;
    name?: string;
    region?: string;
    localOnly?: boolean;
  },
): Promise<void> {
  if (dialect === 'sqlite') {
    log.error(
      'db: `void db connect` requires an external database. Set "database" to "pg" or "mysql" in void.config.ts first.',
    );
    process.exit(1);
  }

  let connectionString = args.url;
  if (args.provider) {
    const adapter = await loadDatabaseProvider(root, args.provider);
    if (!adapter.dialects.includes(dialect as DatabaseProviderDialect)) {
      throw new Error(`${adapter.label} does not support the configured ${dialect} dialect.`);
    }
    log.info(`Provisioning ${adapter.label} database...`);
    const result = await adapter.provision({
      name: args.name ?? basename(root),
      dialect,
      region: args.region,
    });
    connectionString = result.connectionString;
    log.step(`Provisioned ${adapter.label} database.`);
    if (result.dashboardUrl) {
      log.info(`Dashboard: ${formatUrl(result.dashboardUrl)}`);
    }
  }

  if (!connectionString) {
    const answer = await text({
      message: `Enter your ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} connection string:`,
      placeholder:
        dialect === 'mysql'
          ? 'mysql://user:pass@host:3306/database'
          : 'postgresql://user:pass@host:5432/database',
    });
    if (isCancel(answer)) {
      process.exit(0);
    }
    connectionString = answer as string;
  }

  const parsed = new URL(connectionString);
  const allowedProtocols = dialect === 'mysql' ? ['mysql:'] : ['postgres:', 'postgresql:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(
      `Connection string protocol '${parsed.protocol}' does not match the configured ${dialect} dialect.`,
    );
  }

  writeLocalDatabaseUrl(root, connectionString);
  log.step('Saved DATABASE_URL to .env.');

  if (!args.localOnly) {
    const token = getToken(root);
    const projectConfig = readProjectConfig(root);
    if (token && projectConfig) {
      const client = new PlatformClient(token, { root });
      await client.setDatabaseUrl(projectConfig.projectId, connectionString);
      log.step('Updated the linked Void project database URL.');
    } else {
      log.info('No authenticated Void project is linked, so only local configuration was updated.');
    }
  }

  printSuccess('Database connected.');
}

async function runPush(root: string, dialect: DatabaseDialect): Promise<void> {
  if (dialect !== 'sqlite') {
    const url = getLocalDatabaseUrl(root, dialect);
    await runDrizzleKitWithDatabaseUrl(root, url, dialect, 'push');
    printSuccess('Database schema pushed.');
    return;
  }

  const { writeDrizzleConfig } = await import('../drizzle/config.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);
  mkdirSync(dirname(dbPath), { recursive: true });
  const configPath = writeDrizzleConfig(root, dbPath);

  try {
    runDrizzleKit(root, ['push', '--config', configPath]);
  } catch {
    process.exit(1);
  }
  printSuccess('Database schema pushed.');
}

async function runGenerate(root: string, dialect: DatabaseDialect): Promise<void> {
  const { prepareProject } = await import('../codegen/prepare.ts');
  const { PLACEHOLDER_DB_URL, writeDrizzleConfig } = await import('../drizzle/config.ts');

  // Generate the auth schema, then include those tables in Drizzle Kit's schema input. This makes
  // Better Auth tables ordinary, reviewable migration SQL instead of a deploy-time
  // side effect. `prepareProject` removes a stale file when auth is no longer enabled.
  await prepareProject(root);
  const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
  const additionalSchemas = existsSync(authSchemaPath) ? [authSchemaPath] : undefined;

  const configPath = writeDrizzleConfig(root, PLACEHOLDER_DB_URL[dialect], dialect, {
    additionalSchemas,
  });

  try {
    if (dialect === 'sqlite') {
      const { generateValidatedSqliteMigrations } = await import('../drizzle/generate.ts');
      await generateValidatedSqliteMigrations(readProjectPaths(root).migrationsDir, () => {
        runDrizzleKit(root, ['generate', '--config', configPath]);
      });
    } else {
      runDrizzleKit(root, ['generate', '--config', configPath]);
    }
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exit(1);
  }
  printSuccess('Migration generation complete.');
}

async function runStatus(root: string, dialect: DatabaseDialect): Promise<void> {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const allMigrations = collectMigrations(migrationsDir);

  try {
    assertJournalCoherence(migrationsDir, allMigrations, paths.sourceRelative);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  if (allMigrations.length === 0) {
    log.info(`No migration files found in ${paths.sourceRelative('db/migrations')}/`);

    return;
  }

  // A local database that cannot be read has an unknown status, not "pending".
  let localApplied: Array<string> | undefined;
  let localError: unknown;
  if (dialect === 'postgresql') {
    try {
      const { readPgAppliedMigrations } = await import('../migrations/runner-pg.ts');
      localApplied = await withPgClient(root, readPgAppliedMigrations);
    } catch (error) {
      localError = error;
    }
  } else if (dialect === 'mysql') {
    try {
      const { readMySqlAppliedMigrations } = await import('../migrations/runner-mysql.ts');
      localApplied = await withMySqlClient(root, readMySqlAppliedMigrations);
    } catch (error) {
      localError = error;
    }
  } else {
    const { getAppliedMigrations } = await import('../migrations/runner.ts');
    const { databasePath: dbPath } = getLocalD1Target(root);
    localApplied = (await getAppliedMigrations(dbPath)).map((m) => m.name);
  }
  const localSet = localApplied ? new Set(localApplied) : null;

  let remoteApplied: Array<{ name: string; applied_at: string }> | null = null;
  const deploymentPlatform = readDeploymentPlatform(root);
  if (deploymentPlatform === 'cloudflare') {
    try {
      if (dialect !== 'sqlite') {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is not available.');
        }
        const names =
          dialect === 'postgresql'
            ? await (await import('../migrations/runner-pg.ts')).getPgAppliedMigrations(databaseUrl)
            : await (
                await import('../migrations/runner-mysql.ts')
              ).getMySqlAppliedMigrations(databaseUrl);
        remoteApplied = names.map((name) => ({ name, applied_at: '' }));
      } else {
        const { readCloudflareD1Migrations, resolveCloudflareD1Context } =
          await import('./cloudflare-operations.ts');
        const context = resolveCloudflareD1Context(root, configuredD1Binding(root));
        remoteApplied = (await readCloudflareD1Migrations(context)).map((name) => ({
          name,
          applied_at: '',
        }));
      }
    } catch {
      // Graceful degradation — local migration status remains useful offline.
    }
  } else {
    const token = getToken(root);
    const config = readProjectConfig(root);
    if (token && config) {
      try {
        const client = new PlatformClient(token, { root });
        const result = await client.getMigrationStatus(config.projectId, dialect);
        remoteApplied = result.applied;
      } catch {
        // graceful degradation — remote unavailable
      }
    }
  }

  const remoteSet = remoteApplied ? new Set(remoteApplied.map((m) => m.name)) : null;

  if (localSet === null) {
    const message = `Local migration status is unavailable: ${getErrorMessage(localError)}`;
    if (remoteSet === null) {
      log.error(message);
      process.exit(1);
    }
    log.warn(message);
  }

  const lines: Array<string> = [];
  for (const migration of allMigrations) {
    const localStatus =
      localSet === null
        ? dim('unknown')
        : localSet.has(migration.name)
          ? pc.green('applied')
          : pc.yellow('pending');

    let remotePart = '';
    if (remoteSet !== null) {
      const remoteStatus = remoteSet.has(migration.name)
        ? pc.green('applied')
        : pc.yellow('pending');
      remotePart = `  remote: ${remoteStatus}`;
    }

    lines.push(`  ${migration.name}  ${dim('local:')} ${localStatus}${remotePart}`);
  }

  log.info(lines.join('\n'));

  // Count files that are not applied; the database may record names that have no file here.
  const parts = [formatCount(allMigrations.length, 'migration')];
  if (localSet !== null) {
    const localPending = allMigrations.filter((m) => !localSet.has(m.name)).length;
    if (localPending > 0) {
      parts.push(`${localPending} pending locally`);
    }
  }
  if (remoteSet !== null) {
    const remotePending = allMigrations.filter((m) => !remoteSet.has(m.name)).length;
    if (remotePending > 0) {
      parts.push(`${remotePending} pending remotely`);
    }
  }
  outro(parts.join(', '));
}

// Hyperdrive reaches only public hosts, so a loopback or socket database is never the deployed one.
const LOCAL_DATABASE_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Objects that `void db reset` drops in `public` before it applies every migration again:
 * tables and views first, then standalone sequences, then enum, domain, range and composite
 * types. drizzle-kit creates them without `IF NOT EXISTS`, so any one that stays makes the
 * migration fail. Extension members stay, and so do sequences that a column owns: the table
 * drop removes them, and their names change when a table is renamed.
 */
const PG_RESET_OBJECTS = `SELECT kind, name FROM (
  SELECT CASE rel.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
           WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
         rel.relname AS name, CASE rel.relkind WHEN 'S' THEN 1 ELSE 0 END AS step
  FROM pg_class rel JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = 'public' AND rel.relkind IN ('r', 'p', 'v', 'm', 'S')
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_class'::regclass AND dep.objid = rel.oid
        AND (dep.deptype = 'e' OR (rel.relkind = 'S' AND dep.deptype IN ('a', 'i')))
    )
  UNION ALL
  SELECT 'TYPE', typ.typname, 2
  FROM pg_type typ JOIN pg_namespace ns ON ns.oid = typ.typnamespace
  WHERE ns.nspname = 'public'
    AND (typ.typtype IN ('e', 'd', 'r')
      OR (typ.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = typ.typrelid) = 'c'))
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_type'::regclass AND dep.objid = typ.oid
        AND dep.deptype = 'e'
    )
) objects ORDER BY step, name`;

/**
 * Objects in other schemas that `CASCADE` would also drop with the types ($1) and the views,
 * materialized views and sequences ($2) that reset drops in `public`: a column of that type or
 * its array type, a view, a function, a column default and so on, also through a type or
 * function in `public` that goes with them. Reset must not remove these, so it stops when there
 * are any. The TOAST table of a materialized view is part of it, so it does not count. The table
 * drops still remove what depends on a `public` table in another schema (a view, a foreign key,
 * an inheriting table); a view that also uses one of these objects is listed here too.
 */
const PG_RESET_OUTSIDE_DEPENDENTS = `WITH RECURSIVE dropped(classid, objid) AS (
  SELECT 'pg_type'::regclass::oid, typ.oid FROM pg_type typ
  WHERE typ.typnamespace = 'public'::regnamespace AND typ.typname = ANY($1::text[])
  UNION ALL
  SELECT 'pg_class'::regclass::oid, rel.oid FROM pg_class rel
  WHERE rel.relnamespace = 'public'::regnamespace AND rel.relname = ANY($2::text[])
  UNION
  SELECT dep.classid, dep.objid FROM dropped
  JOIN pg_depend dep ON dep.refclassid = dropped.classid AND dep.refobjid = dropped.objid
  WHERE dep.classid IN ('pg_type'::regclass, 'pg_proc'::regclass)
    AND (pg_identify_object(dep.classid, dep.objid, 0)).schema = 'public'
)
SELECT DISTINCT pg_describe_object(dep.classid, dep.objid, dep.objsubid) || ' uses '
  || pg_describe_object(dep.refclassid, dep.refobjid, 0) AS object
FROM dropped
JOIN pg_depend dep ON dep.refclassid = dropped.classid AND dep.refobjid = dropped.objid
WHERE NOT (dep.classid = 'pg_class'::regclass AND dep.deptype = 'i')
  AND COALESCE((pg_identify_object(dep.classid, dep.objid, dep.objsubid)).schema, (
  SELECT ns.nspname FROM pg_class rel JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE rel.oid = CASE dep.classid
    WHEN 'pg_attrdef'::regclass THEN (SELECT adrelid FROM pg_attrdef WHERE oid = dep.objid)
    WHEN 'pg_rewrite'::regclass THEN (SELECT ev_class FROM pg_rewrite WHERE oid = dep.objid)
    WHEN 'pg_trigger'::regclass THEN (SELECT tgrelid FROM pg_trigger WHERE oid = dep.objid)
    WHEN 'pg_policy'::regclass THEN (SELECT polrelid FROM pg_policy WHERE oid = dep.objid)
  END)) <> 'public'
ORDER BY object`;

/**
 * `.env` may hold the deployed database URL (`void db connect` writes it there), so ask before
 * dropping every table on any other host. Without a TTY, require `--yes`.
 */
async function confirmDropAllTables(
  host: string,
  target: string,
  yes: boolean | undefined,
): Promise<void> {
  if (yes || LOCAL_DATABASE_HOSTS.has(host) || host.startsWith('/')) {
    return;
  }
  if (!process.stdin.isTTY) {
    log.error(
      `db: Refusing to drop every table in ${target} without confirmation. Re-run with --yes.`,
    );
    process.exit(1);
  }
  const ok = await confirm({ message: `This drops every table in ${target}. Continue?` });
  if (isCancel(ok) || !ok) {
    log.info('Cancelled.');
    process.exit(0);
  }
}

async function confirmReset(
  root: string,
  dialect: DatabaseDialect,
  yes: boolean | undefined,
): Promise<void> {
  if (dialect === 'postgresql') {
    const { Client } = await import('pg');
    // `?host=` and PGHOST can replace the URL host, so check the host pg will connect to.
    const { host, port, database } = new Client({
      connectionString: getLocalDatabaseUrl(root, dialect),
    });
    await confirmDropAllTables(host, `database "${database}" on ${host}:${port}`, yes);
  } else if (dialect === 'mysql') {
    const { hostname, host, pathname } = new URL(getLocalDatabaseUrl(root, dialect));
    const target = `database "${decodeURIComponent(pathname.slice(1))}" on ${host}`;
    await confirmDropAllTables(hostname, target, yes);
  }
}

async function resetDatabase(
  root: string,
  dialect: DatabaseDialect,
  yes?: boolean,
): Promise<number> {
  // Coherence check must happen before any destructive work. Report a
  // malformed `_journal.json` like `runStatus`, `runMigrate`, and the deploy
  // path do, not as a raw stack trace.
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const migrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, migrations, paths.sourceRelative);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }
  await confirmReset(root, dialect, yes);

  if (dialect === 'postgresql') {
    const { applyPgMigrations } = await import('../migrations/runner-pg.ts');
    await withPgClient(root, async (client) => {
      const objects = await client.query<{ kind: string; name: string }>(PG_RESET_OBJECTS);
      const names = (kind: string) =>
        objects.rows.filter((row) => row.kind === kind).map((row) => row.name);
      const types = names('TYPE');
      const relations = [...names('VIEW'), ...names('MATERIALIZED VIEW'), ...names('SEQUENCE')];
      const outside =
        types.length > 0 || relations.length > 0
          ? await client.query<{ object: string }>(PG_RESET_OUTSIDE_DEPENDENTS, [types, relations])
          : { rows: [] };
      if (outside.rows.length > 0) {
        throw new Error(
          'db: Reset stopped before dropping anything. Dropping the views, sequences and types in the public schema would also remove these objects in other schemas:\n' +
            outside.rows.map((row) => `  - ${row.object}\n`).join('') +
            'Change or drop these objects, or move the views, sequences and types they use out of the public schema, then run the command again.',
        );
      }
      for (const { kind, name } of objects.rows) {
        // Qualify the name: search_path could find an object of that name in another schema.
        await client.query(`DROP ${kind} IF EXISTS public.${quoteSqlIdentifier(name)} CASCADE`);
      }
      await applyPgMigrations(client, migrations);
    });
    return migrations.length;
  }

  if (dialect === 'mysql') {
    const { applyPendingMySqlMigrations, withMySqlMigrationLock } =
      await import('../migrations/runner-mysql.ts');
    // The migration lock keeps deploys and other migration runs out from the first drop until
    // the files are applied again.
    await withMySqlClient(root, (client) =>
      withMySqlMigrationLock(client, async () => {
        // MySQL 8 returns an unaliased information_schema column as `TABLE_NAME`. A view stays
        // when its tables are dropped, and its migration would then fail, so drop views too.
        const tables = await client.query(
          "SELECT table_name AS table_name, table_type AS table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE', 'VIEW')",
        );
        await client.query('SET FOREIGN_KEY_CHECKS = 0');
        try {
          for (const row of tables) {
            // Deploys of any project on this database keep their lease rows in this table.
            if (row.table_name === '_void_migration_lock') {
              continue;
            }
            const kind = row.table_type === 'VIEW' ? 'VIEW' : 'TABLE';
            const table = String(row.table_name).replaceAll('`', '``');
            await client.query(`DROP ${kind} IF EXISTS \`${table}\``);
          }
        } finally {
          await client.query('SET FOREIGN_KEY_CHECKS = 1');
        }
        await applyPendingMySqlMigrations(client, migrations);
      }),
    );
    return migrations.length;
  }

  const { runMigrations } = await import('../migrations/runner.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);

  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });

  const applied = await runMigrations(migrationsDir, dbPath);
  return applied.length;
}

async function runReset(root: string, dialect: DatabaseDialect, yes?: boolean): Promise<void> {
  const count = await resetDatabase(root, dialect, yes);
  if (dialect === 'sqlite') {
    log.info(dim("Restart your dev server if it's running."));
  }
  printSuccess(`Database reset. Applied ${formatCount(count, 'migration')}.`);
}

async function runSeed(
  root: string,
  file: string | undefined,
  dialect: DatabaseDialect,
  yes?: boolean,
): Promise<void> {
  // Load the seed before the reset, so a wrong path or a broken module stops the command
  // before any data is dropped. Importing a module runs its code, so ask about the database first.
  const seed = resolveSeedTarget(root, file);
  const sql = seed.kind === 'sql' ? readFileSync(seed.path, 'utf-8') : undefined;
  await confirmReset(root, dialect, yes);
  const seedFn = sql === undefined ? await loadSeedFunction(seed.path) : undefined;

  // Reset first (drop + re-run migrations). The drop is confirmed above, so do not ask again.
  const migrationCount = await resetDatabase(root, dialect, true);
  log.step(`Reset database. Applied ${formatCount(migrationCount, 'migration')}.`);

  if (sql !== undefined) {
    if (dialect === 'postgresql') {
      await withPgClient(root, async (client) => {
        await client.query(sql);
      });
      printSuccess(`Seeded from ${seed.displayPath}.`);

      return;
    }

    if (dialect === 'mysql') {
      await withMySqlClient(root, async (client) => {
        await client.query(sql);
      });
      printSuccess(`Seeded from ${seed.displayPath}.`);

      return;
    }

    const { openSqliteDatabase } = await import('../migrations/runner.ts');
    const { databasePath: dbPath } = getLocalD1Target(root);
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  } else {
    await runSeedModule(root, seedFn!, dialect);
  }

  log.info(dim("Restart your dev server if it's running."));
  printSuccess(`Seeded from ${seed.displayPath}.`);
}

/**
 * Fail-closed check for read-only SQL (SELECT or plain EXPLAIN), which skips the remote
 * confirmation prompt. Comments are stripped first so they cannot hide `ANALYZE`.
 * Multiple statements and `WITH` (a CTE can write) are rejected, and so is `EXPLAIN ANALYZE`
 * in either form, because PostgreSQL executes the analyzed statement.
 */
function isSafeStatement(sql: string): boolean {
  const decommented = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const stripped = decommented.replace(/;\s*$/, '');
  if (stripped.includes(';')) {
    return false;
  }
  if (/^\s*SELECT\b/i.test(stripped)) {
    return true;
  }
  if (/^\s*EXPLAIN\b/i.test(stripped)) {
    if (/^\s*EXPLAIN\s+ANALYZE\b/i.test(stripped)) {
      return false;
    }
    const parenMatch = stripped.match(/^\s*EXPLAIN\s*\(([^)]*)\)/i);
    if (parenMatch && /\bANALYZE\b/i.test(parenMatch[1])) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Fetch a project's remote PostgreSQL connection string from the platform.
 * Exits with a friendly message when the URL has never been stored (404);
 * other errors propagate so the caller's top-level handler can report them.
 */
async function fetchRemoteDatabaseUrl(client: PlatformClient, projectId: string): Promise<string> {
  try {
    const result = await client.getDatabaseUrl(projectId);
    return result.url;
  } catch (err) {
    if (err instanceof PlatformApiError && err.status === 404) {
      log.error(
        "This project's database URL isn't stored on the platform yet. Run `void db set-url` once to populate it, then retry.",
      );
      process.exit(1);
    }
    throw err;
  }
}

async function executeExternalRemoteSql(
  dialect: Exclude<DatabaseDialect, 'sqlite'>,
  dbUrl: string,
  sql: string,
): Promise<void> {
  if (dialect === 'postgresql') {
    const { Client } = await import('pg');
    const pgClient: PgClient = new Client({ connectionString: dbUrl });
    await pgClient.connect();
    try {
      const result = await pgClient.query(sql);
      if (result.rows && result.rows.length > 0) {
        printTable(result.rows);
      }
    } finally {
      await pgClient.end();
    }
    return;
  }
  const { createConnection } = await import('mysql2/promise');
  const mySqlClient = await createConnection({ uri: dbUrl, multipleStatements: true });
  try {
    const [rows] = await mySqlClient.query(sql);
    if (Array.isArray(rows) && rows.length > 0) {
      printTable(rows as Array<Record<string, unknown>>);
    }
  } finally {
    await mySqlClient.end();
  }
}

/**
 * Prompt the user to confirm a destructive remote query when running in a TTY.
 * Returns true if execution should proceed, false if it was cancelled.
 */
async function confirmDestructiveRemote(sql: string): Promise<boolean> {
  if (isSafeStatement(sql)) {
    return true;
  }
  if (!process.stdin.isTTY) {
    return true;
  }
  const ok = await confirm({
    message: 'This will run against your deployed database. Continue?',
  });
  if (isCancel(ok) || !ok) {
    return false;
  }
  return true;
}

async function runExecute(
  root: string,
  command: string | undefined,
  file: string | undefined,
  dialect: DatabaseDialect,
  remote?: boolean,
): Promise<void> {
  if (remote) {
    const directCloudflare = readDeploymentPlatform(root) === 'cloudflare';
    const sql = file ? readFileSync(resolve(root, file), 'utf-8') : command!;

    if (directCloudflare) {
      const shouldProceed = await confirmDestructiveRemote(sql);
      if (!shouldProceed) {
        log.info('Cancelled.');
        process.exit(0);
      }
      if (dialect === 'sqlite') {
        const { executeCloudflareD1Sql, resolveCloudflareD1Context } =
          await import('./cloudflare-operations.ts');
        const rows = await executeCloudflareD1Sql(
          resolveCloudflareD1Context(root, configuredD1Binding(root)),
          sql,
        );
        if (rows.length > 0) {
          printTable(rows);
        }
      } else {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          log.error(
            'DATABASE_URL is required in the shell for a direct Cloudflare remote database command.',
          );
          process.exit(1);
        }
        await executeExternalRemoteSql(dialect, dbUrl, sql);
      }
      printSuccess('SQL executed successfully.');
      return;
    }

    const token = getToken(root);
    if (!token) {
      log.error('Not logged in. Run `void account login` first.');
      process.exit(1);
    }

    const projectConfig = readProjectConfig(root);
    if (!projectConfig) {
      log.error('No project linked. Run `void deploy` first or link a project.');
      process.exit(1);
    }

    const shouldProceed = await confirmDestructiveRemote(sql);
    if (!shouldProceed) {
      log.info('Cancelled.');
      process.exit(0);
    }

    if (dialect !== 'sqlite') {
      // External database: fetch the connection string from the platform, then connect directly.
      const client = new PlatformClient(token, { root });
      const dbUrl = await fetchRemoteDatabaseUrl(client, projectConfig.projectId);

      await executeExternalRemoteSql(dialect, dbUrl, sql);
      printSuccess('SQL executed successfully.');
      return;
    }

    // D1 remote: route through the platform proxy.
    const platformClient = new PlatformClient(token, { root });
    const configuredBinding = configuredD1Binding(root);
    let binding = configuredBinding;
    try {
      const d1Bindings = (await platformClient.getResources(projectConfig.projectId))
        .filter((r) => r.type === 'd1')
        .map((r) => r.binding_name);
      // The configured binding wins. A renamed binding leaves its old resource
      // behind, so only a single D1 resource is a safe fallback.
      if (!d1Bindings.includes(configuredBinding) && d1Bindings.length === 1) {
        binding = d1Bindings[0]!;
      }
    } catch {
      // Keep the configured binding name (or 'DB' by default) if resource discovery fails.
    }

    const proxyUrl = getProxyUrl(root);
    ensurePlatformProxyAccess(platformClient.apiUrl, proxyUrl);
    const capturedAccessHeaders = cfAccessHeaders(process.env, proxyUrl);
    const requestProxy = () => {
      const currentAccessHeaders = cfAccessHeaders(process.env, proxyUrl);
      const accessHeaders =
        Object.keys(currentAccessHeaders).length > 0 ? currentAccessHeaders : capturedAccessHeaders;
      return {
        accessHeaders,
        response: fetch(`${proxyUrl}/d1/query`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...accessHeaders,
          },
          body: JSON.stringify({
            projectId: projectConfig.projectId,
            binding,
            sql,
            params: [],
            method: 'all',
          }),
          redirect: 'manual',
        }),
      };
    };
    const first = requestProxy();
    let res = await first.response;
    if (isCloudflareAccessChallenge(res) && !first.accessHeaders['CF-Access-Client-Id']) {
      await res.body?.cancel();
      ensurePlatformAccessToken(proxyUrl, true, false, first.accessHeaders['cf-access-token']);
      // A verified perimeter challenge occurs before D1 executes. Retry once
      // at the original proxy URL; never follow or authenticate to Location.
      res = await requestProxy().response;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      log.error(`db: Proxy request failed with ${res.status}: '${text}'.`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
      success?: boolean;
    };
    const rows = data.results ?? [];
    if (rows.length > 0) {
      printTable(rows);
    }
    printSuccess('SQL executed successfully.');
    return;
  }

  if (dialect === 'postgresql') {
    const sql = file ? readFileSync(resolve(root, file), 'utf-8') : command!;
    await withPgClient(root, async (client) => {
      const result = await client.query(sql);
      if (result.rows && result.rows.length > 0) {
        printTable(result.rows);
      }
    });
    printSuccess('SQL executed successfully.');
    return;
  }

  if (dialect === 'mysql') {
    const sql = file ? readFileSync(resolve(root, file), 'utf-8') : command!;
    await withMySqlClient(root, async (client) => {
      const rows = await client.query(sql);
      if (rows.length > 0) {
        printTable(rows);
      }
    });
    printSuccess('SQL executed successfully.');
    return;
  }

  const { openSqliteDatabase } = await import('../migrations/runner.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);

  if (!existsSync(dbPath)) {
    log.error('No local database found. Start the dev server first.');
    process.exit(1);
  }

  const sql = file ? readFileSync(resolve(root, file), 'utf-8') : command!;

  const db = await openSqliteDatabase(dbPath);
  try {
    const trimmed = sql.trimStart();
    if (/^SELECT\b/i.test(trimmed)) {
      const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        log.info('No rows returned.');
      } else {
        printTable(rows);
      }
    } else {
      db.exec(sql);
    }
  } finally {
    db.close();
  }
  printSuccess('SQL executed successfully.');
}

function printTable(rows: Array<Record<string, unknown>>): void {
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) => {
    let max = col.length;
    for (const row of rows) {
      const len = String(row[col] ?? 'NULL').length;
      if (len > max) {
        max = len;
      }
    }
    return max;
  });

  const header = cols.map((col, columnIndex) => col.padEnd(widths[columnIndex])).join('  ');
  const separator = widths.map((width) => '─'.repeat(width)).join('──');
  const lines = [header, separator];
  for (const row of rows) {
    lines.push(
      cols
        .map((col, columnIndex) => String(row[col] ?? 'NULL').padEnd(widths[columnIndex]))
        .join('  '),
    );
  }
  console.log(lines.join('\n'));
}

async function runMigrate(root: string, dialect: DatabaseDialect, remote?: boolean): Promise<void> {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const rawMigrations = collectMigrations(migrationsDir);

  try {
    assertJournalCoherence(migrationsDir, rawMigrations, paths.sourceRelative);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  if (remote) {
    const deploymentPlatform = readDeploymentPlatform(root);
    if (dialect !== 'sqlite') {
      if (deploymentPlatform !== 'cloudflare') {
        log.error(
          `db: \`void db migrate --remote\` is only supported for D1 projects. ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} remote migrations run during \`void deploy\` through the project Hyperdrive binding.`,
        );
        process.exit(1);
      }

      if (rawMigrations.length === 0) {
        log.info(`No migration files found in ${paths.sourceRelative('db/migrations')}/`);

        return;
      }
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        log.error(
          'DATABASE_URL is required in the shell for a direct Cloudflare remote database command.',
        );
        process.exit(1);
      }

      try {
        let appliedNames: Array<string>;
        let applyMigrations: () => Promise<Array<string>>;
        if (dialect === 'postgresql') {
          const { getPgAppliedMigrations, runPgMigrations } =
            await import('../migrations/runner-pg.ts');
          appliedNames = await getPgAppliedMigrations(databaseUrl);
          applyMigrations = () => runPgMigrations(migrationsDir, databaseUrl);
        } else {
          const { getMySqlAppliedMigrations, runMySqlMigrations } =
            await import('../migrations/runner-mysql.ts');
          appliedNames = await getMySqlAppliedMigrations(databaseUrl);
          applyMigrations = () => runMySqlMigrations(migrationsDir, databaseUrl);
        }
        const appliedSet = new Set(appliedNames);
        const pending = rawMigrations.filter((migration) => !appliedSet.has(migration.name));
        if (pending.length === 0) {
          log.info('Remote database is up to date.');

          return;
        }
        validateMigrations(pending);
        const applied = await applyMigrations();
        for (const migration of applied) {
          log.step(migration);
        }
        printSuccess(`Applied ${formatCount(applied.length, 'migration')} to remote database.`);

        return;
      } catch (error) {
        log.error(`db: Remote ${dialect} migrations failed — ${getErrorMessage(error)}`);
        process.exit(1);
      }
    }

    if (deploymentPlatform === 'cloudflare') {
      if (rawMigrations.length === 0) {
        log.info(`No migration files found in ${paths.sourceRelative('db/migrations')}/`);

        return;
      }
      const {
        applyCloudflareD1Migrations,
        readCloudflareD1Migrations,
        resolveCloudflareD1Context,
      } = await import('./cloudflare-operations.ts');
      const binding = configuredD1Binding(root);
      const context = resolveCloudflareD1Context(root, binding);
      const remoteBefore = new Set(await readCloudflareD1Migrations(context));
      const pending = rawMigrations.filter((migration) => !remoteBefore.has(migration.name));
      if (pending.length === 0) {
        log.info('Remote database is up to date.');

        return;
      }
      try {
        validateMigrations(pending);
      } catch (error) {
        log.error(getErrorMessage(error));
        process.exit(1);
      }
      // Without `migrations_dir`, Cloudflare applies `./migrations`, which the check below
      // would not read.
      if (!context.migrationsDir) {
        const dir = paths.sourceRelative('db/migrations');
        log.error(
          `db: D1 binding ${binding} has no "migrations_dir", so Cloudflare would apply ./migrations instead of ${dir}/. Add "migrations_dir": "./${dir}" to that D1 binding in your Cloudflare config, then run the command again.`,
        );
        process.exit(1);
      }
      const { checkWranglerMigrationApplySet, parseRootWranglerConfig } =
        await import('./deploy.ts');
      const applySet = await checkWranglerMigrationApplySet(
        context.operation.configPath,
        parseRootWranglerConfig(context.operation.configPath),
        binding,
        context.migrationsDir,
        rawMigrations,
        paths.sourceRelative('db/migrations'),
      );
      if (!applySet.ok) {
        log.error(applySet.reason);
        process.exit(1);
      }
      await applyCloudflareD1Migrations(context);
      const remoteAfter = new Set(await readCloudflareD1Migrations(context));
      const unapplied = rawMigrations.filter((migration) => !remoteAfter.has(migration.name));
      if (unapplied.length > 0) {
        log.error(
          `db: Remote D1 still has unapplied migrations: ${unapplied.map((migration) => migration.name).join(', ')}.`,
        );
        process.exit(1);
      }
      for (const migration of pending) {
        log.step(migration.name);
      }
      printSuccess(`Applied ${formatCount(pending.length, 'migration')} to remote database.`);

      return;
    }

    const token = getToken(root);
    if (!token) {
      log.error('Not logged in. Run `void account login` first.');
      process.exit(1);
    }

    const config = readProjectConfig(root);
    if (!config) {
      log.error('No project linked. Run `void deploy` first or link a project.');
      process.exit(1);
    }

    if (rawMigrations.length === 0) {
      log.info(`No migration files found in ${paths.sourceRelative('db/migrations')}/`);

      return;
    }

    const client = new PlatformClient(token, { root });

    // Fetch remote applied set so we only validate and send pending migrations.
    // This is required — if we can't determine what's already applied, we must
    // abort rather than risk validating (and rejecting) already-applied migrations.
    let remoteApplied: Set<string>;
    try {
      const status = await client.getMigrationStatus(config.projectId, dialect);
      remoteApplied = new Set(status.applied.map((m) => m.name));
    } catch (err) {
      log.error(
        `db: Failed to fetch remote migration status: '${err instanceof Error ? err.message : String(err)}'.`,
      );
      process.exit(1);
    }

    const pendingMigrations = rawMigrations.filter((m) => !remoteApplied.has(m.name));
    if (pendingMigrations.length === 0) {
      log.info('Remote database is up to date.');

      return;
    }

    try {
      validateMigrations(pendingMigrations);
    } catch (err: unknown) {
      log.error(getErrorMessage(err));
      process.exit(1);
    }

    const result = await client.applyRemoteMigrations(config.projectId, pendingMigrations);

    if (!result.ok) {
      log.error(
        result.error
          ? `db: Remote migration failed: '${result.error}'.`
          : 'db: Remote migration failed.',
      );
      process.exit(1);
    }

    if (result.applied.length === 0) {
      log.info('Remote database is up to date.');
    } else {
      for (const name of result.applied) {
        log.step(name);
      }
    }
    if (result.applied.length > 0) {
      printSuccess(
        `Applied ${formatCount(result.applied.length, 'migration')} to remote database.`,
      );
    }

    return;
  }

  if (dialect === 'postgresql') {
    const { applyPgMigrations, readPgAppliedMigrations } =
      await import('../migrations/runner-pg.ts');
    const applied = await withPgClient(root, async (client) => {
      const appliedNames = await readPgAppliedMigrations(client).catch(() => []);
      try {
        validatePendingMigrations(rawMigrations, new Set(appliedNames));
      } catch (err: unknown) {
        log.error(getErrorMessage(err));
        process.exit(1);
      }

      return applyPgMigrations(client, rawMigrations);
    });

    if (applied.length === 0) {
      log.info('All migrations are up to date.');
    } else {
      for (const name of applied) {
        log.step(name);
      }
      printSuccess(`Applied ${formatCount(applied.length, 'migration')}.`);
    }

    return;
  }

  if (dialect === 'mysql') {
    const { applyMySqlMigrations, readMySqlAppliedMigrations } =
      await import('../migrations/runner-mysql.ts');
    const applied = await withMySqlClient(root, async (client) => {
      const appliedNames = await readMySqlAppliedMigrations(client).catch(() => []);
      try {
        validatePendingMigrations(rawMigrations, new Set(appliedNames));
      } catch (err: unknown) {
        log.error(getErrorMessage(err));
        process.exit(1);
      }

      return applyMySqlMigrations(client, rawMigrations);
    });

    if (applied.length === 0) {
      log.info('All migrations are up to date.');
    } else {
      for (const name of applied) {
        log.step(name);
      }
      printSuccess(`Applied ${formatCount(applied.length, 'migration')}.`);
    }

    return;
  }

  const { getAppliedMigrations, runMigrations } = await import('../migrations/runner.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);

  try {
    const existingRows = await getAppliedMigrations(dbPath);
    validatePendingMigrations(rawMigrations, new Set(existingRows.map((row) => row.name)));
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  const applied = await runMigrations(migrationsDir, dbPath, paths.sourceRelative);
  if (applied.length === 0) {
    log.info('All migrations are up to date.');
  } else {
    for (const name of applied) {
      log.step(name);
    }
    log.info(dim("Restart your dev server if it's running."));
    printSuccess(`Applied ${formatCount(applied.length, 'migration')}.`);
  }
}

async function runRestore(
  root: string,
  dialect: DatabaseDialect,
  { target, platform: explicitPlatform, yes }: Extract<DbArgs, { action: 'restore' }>,
): Promise<void> {
  // `.void` is not checked in, so a fresh checkout or CI shows a direct deploy only through its
  // Cloudflare config. A one-off `deploy --platform cloudflare` keeps the saved platform, so its
  // restore command passes the platform explicitly.
  const platform = readDeploymentPlatform(root);
  const directCloudflare =
    explicitPlatform === 'cloudflare' ||
    platform === 'cloudflare' ||
    (platform === null && !readProjectConfig(root) && (await hasDeployedCloudflareDatabase(root)));
  if (dialect !== 'sqlite') {
    log.error('db: `void db restore` restores D1 databases only.');
    process.exit(1);
  }
  if (!directCloudflare) {
    log.error(
      'db: `void db restore` restores the D1 database of a direct Cloudflare deploy. ' +
        'After a one-off `void deploy --platform cloudflare`, run it with `--platform cloudflare`.',
    );
    process.exit(1);
  }
  const { readCloudflareD1Migrations, resolveCloudflareD1Context, restoreCloudflareD1Database } =
    await import('./cloudflare-operations.ts');
  const binding = configuredD1Binding(root);
  const context = resolveCloudflareD1Context(root, binding);
  const database = `D1 database ${context.migrateToken} (${binding})`;
  const point = 'bookmark' in target ? `bookmark ${target.bookmark}` : target.timestamp;
  if (!yes) {
    if (!process.stdin.isTTY) {
      log.error(`db: Refusing to restore ${database} without confirmation. Re-run with --yes.`);
      process.exit(1);
    }
    const ok = await confirm({
      message: `This restores ${database} to ${point} and discards every write made after it. Continue?`,
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      log.info('Cancelled.');
      process.exit(0);
    }
  }

  let previousBookmark: string | undefined;
  try {
    previousBookmark = await restoreCloudflareD1Database(context, target);
  } catch (error) {
    log.error(
      `db: Could not restore ${database} to ${point}: ${getErrorMessage(error)}\n` +
        'Restore points expire after 7 days on Workers Free and 30 days on Workers Paid. ' +
        'To undo an older migration, write a new migration that reverses it.',
    );
    process.exit(1);
  }
  // `--platform cloudflare` always reaches this database; the bare commands follow the saved
  // platform.
  const platformFlag = platform === 'cloudflare' ? '' : ' --platform cloudflare';
  if (previousBookmark) {
    log.info(
      `To undo this restore, run \`void db restore${platformFlag} --bookmark=${previousBookmark}\`.`,
    );
  }
  // A restore also rewinds the migration table, so the next deploy applies those files again.
  const paths = readProjectPaths(root);
  try {
    const applied = new Set(await readCloudflareD1Migrations(context));
    const unapplied = collectMigrations(paths.migrationsDir).filter(
      (migration) => !applied.has(migration.name),
    );
    if (unapplied.length > 0) {
      log.warn(
        `The remote database does not have these migrations applied: ${unapplied.map((migration) => migration.name).join(', ')}. ` +
          `The next \`void deploy${platformFlag}\` applies them. Fix or remove a migration that caused the problem before you deploy.`,
      );
    }
  } catch (error) {
    log.warn(
      `Could not read the applied migrations after the restore: ${getErrorMessage(error)}. ` +
        (platformFlag
          ? `The next \`void deploy${platformFlag}\` applies any migration the restore rewound.`
          : 'Run `void db status` to check them.'),
    );
  }
  printSuccess(`Restored ${database} to ${point}.`);
}

async function runStudio(root: string, dialect: DatabaseDialect, remote?: boolean): Promise<void> {
  if (remote) {
    if (dialect === 'sqlite') {
      log.error(
        'Remote Studio supports PostgreSQL and MySQL databases. For D1, use `void db execute --remote` to query the deployed database.',
      );
      process.exit(1);
    }

    // External database: use the direct deploy credential or fetch the managed URL.
    let dbUrl: string;
    if (readDeploymentPlatform(root) === 'cloudflare') {
      dbUrl = process.env.DATABASE_URL ?? '';
      if (!dbUrl) {
        log.error('DATABASE_URL is required in the shell for direct Cloudflare remote Studio.');
        process.exit(1);
      }
    } else {
      const token = getToken(root);
      if (!token) {
        log.error('Not logged in. Run `void account login` first.');
        process.exit(1);
      }
      const projectConfig = readProjectConfig(root);
      if (!projectConfig) {
        log.error('No project linked. Run `void deploy` first or link a project.');
        process.exit(1);
      }
      const client = new PlatformClient(token, { root });
      dbUrl = await fetchRemoteDatabaseUrl(client, projectConfig.projectId);
    }

    log.info('Opening Drizzle Studio (remote)...');
    await runDrizzleKitWithDatabaseUrl(root, dbUrl, dialect, 'studio');
    return;
  }

  if (dialect !== 'sqlite') {
    const url = getLocalDatabaseUrl(root, dialect);

    log.info('Opening Drizzle Studio...');
    await runDrizzleKitWithDatabaseUrl(root, url, dialect, 'studio');
    return;
  }

  const { writeDrizzleConfig } = await import('../drizzle/config.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);

  if (!existsSync(dbPath)) {
    log.error('No local database found. Start the dev server first.');
    process.exit(1);
  }

  const configPath = writeDrizzleConfig(root, dbPath);

  log.info('Opening Drizzle Studio...');
  try {
    runDrizzleKit(root, ['studio', '--config', configPath]);
  } catch {
    process.exit(1);
  }
}

/** A direct Cloudflare deploy records its D1 or Hyperdrive id in the checked-in Cloudflare config. */
async function hasDeployedCloudflareDatabase(root: string): Promise<boolean> {
  const { readRootWranglerConfig } = await import('./wrangler.ts');
  const { isRealD1Id, isRealHyperdriveId } = await import('./provision.ts');
  const config = readRootWranglerConfig(root)?.config;
  const entries = (key: string): Array<Record<string, unknown>> => {
    const value = config?.[key];
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
        )
      : [];
  };
  return (
    entries('d1_databases').some((entry) => isRealD1Id(entry.database_id)) ||
    entries('hyperdrive').some((entry) => isRealHyperdriveId(entry.id))
  );
}

async function runRenameMigrations(root: string, dialect: DatabaseDialect): Promise<void> {
  const paths = readProjectPaths(root);
  const migrationsDir = paths.migrationsDir;
  const dir = paths.sourceRelative('db/migrations');
  if (!existsSync(migrationsDir)) {
    log.info('No migrations directory found.');

    return;
  }

  // Refuse drift or a partial drizzle-kit state before changing anything, local or remote.
  const currentMigrations = collectMigrations(migrationsDir);
  try {
    assertJournalCoherence(migrationsDir, currentMigrations, paths.sourceRelative);
  } catch (err: unknown) {
    log.error(getErrorMessage(err));
    process.exit(1);
  }

  // The bundled `migrations.js` imports each `.sql` file by name, so renaming would break it.
  if (existsSync(join(migrationsDir, 'migrations.js'))) {
    log.error(
      `This project uses Drizzle's bundled migration format (${dir}/migrations.js).\n` +
        '`void db rename-migrations` cannot rename migrations in bundled mode because\n' +
        '`migrations.js` contains static imports of the SQL files by filename.\n\n' +
        `Delete ${dir}/migrations.js and re-run \`void db generate\` to migrate away\n` +
        'from bundled mode, then retry `void db rename-migrations`.',
    );
    process.exit(1);
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort();

  const oldStyleFiles = files.filter((f) => /^\d{1,4}_/.test(f));
  if (oldStyleFiles.length === 0) {
    log.info('No migrations with numeric prefixes found. Nothing to rename.');

    return;
  }

  // Void cannot rename the records in a direct Cloudflare database, and `void deploy` decides
  // what is pending by file name, so a renamed applied migration would run again. `.void` is not
  // checked in, so a fresh checkout shows a direct deploy only through its Cloudflare config.
  const platform = readDeploymentPlatform(root);
  const config = readProjectConfig(root);
  if (
    platform === 'cloudflare' ||
    (!config && platform !== 'void' && (await hasDeployedCloudflareDatabase(root)))
  ) {
    log.error(
      '`void db rename-migrations` does not support direct Cloudflare deploys.\n' +
        'Void cannot rename the migration records in your deployed database, so the next deploy would run the renamed migrations again.\n' +
        'Keep the current file names. New migrations use timestamps and run after them.',
    );
    process.exit(1);
  }
  // A hosted project renames its deployed records only through its link.
  if (platform === 'void' && !config) {
    log.error(
      'This project deploys to Void but is not linked, so Void cannot rename the migration records in its deployed database.\n' +
        'Run `void project link`, then run `void db rename-migrations` again.',
    );
    process.exit(1);
  }

  // Renamed files sort just before the earliest existing timestamped migration.
  const timestampFiles = files.filter((f) => /^\d{14}_/.test(f));

  let baseTime: Date;
  if (timestampFiles.length > 0) {
    const earliest = timestampFiles[0].slice(0, 14);
    const year = +earliest.slice(0, 4);
    const monthIndex = +earliest.slice(4, 6) - 1;
    const day = +earliest.slice(6, 8);
    const hour = +earliest.slice(8, 10);
    const minute = +earliest.slice(10, 12);
    const second = +earliest.slice(12, 14);
    baseTime = new Date(
      Date.UTC(year, monthIndex, day, hour, minute, second - oldStyleFiles.length),
    );
  } else {
    baseTime = new Date(Date.now() - oldStyleFiles.length * 1000);
  }

  const renames: Array<{ from: string; to: string }> = [];
  for (let fileIndex = 0; fileIndex < oldStyleFiles.length; fileIndex++) {
    const oldName = oldStyleFiles[fileIndex];
    const description = oldName.replace(/^\d+_/, '');
    const ts = new Date(baseTime.getTime() + fileIndex * 1000);
    const newName = `${formatTimestamp(ts)}_${description}`;
    renames.push({ from: oldName, to: newName });
  }

  const metaDir = join(migrationsDir, 'meta');
  const journalPath = join(metaDir, '_journal.json');
  const originalJournalBytes: Buffer | null = existsSync(journalPath)
    ? readFileSync(journalPath)
    : null;
  const journal = readJournal(migrationsDir, paths.sourceRelative);
  // Drizzle-kit finds a snapshot by the part of the journal tag before the first underscore.
  const snapshotPrefix = (tag: string): string => tag.split('_')[0];
  const snapshotPathFor = (tag: string): string =>
    join(metaDir, `${snapshotPrefix(tag)}_snapshot.json`);

  // Without its snapshot, drizzle-kit cannot find a renamed entry. Check before the remote
  // rename, so a failure leaves nothing to undo.
  if (journal && journal.entries.length > 0) {
    const missingSnapshots: Array<string> = [];
    for (const { from } of renames) {
      const fromTag = stripSqlExt(from);
      const snapshotFrom = snapshotPathFor(fromTag);
      if (!existsSync(snapshotFrom)) {
        missingSnapshots.push(`meta/${snapshotPrefix(fromTag)}_snapshot.json`);
      }
    }
    if (missingSnapshots.length > 0) {
      log.error(
        'db: Cannot rename migrations because one or more Drizzle snapshot files are missing:',
      );
      for (const p of missingSnapshots) {
        log.error(`  - ${dir}/${p}`);
      }
      log.error(
        '\nRestore the missing snapshot(s) from version control, or reset the migration directory with `void db generate`, then retry.',
      );
      process.exit(1);
    }
  }

  // Update remote tracking first. If this fails, nothing local has changed yet.
  const token = getToken(root);
  let remoteRenamed = false;
  if (config && !token) {
    log.error(
      'Project is linked but you are not logged in.\n' +
        'Run `void account login` first so remote migration records can be updated.',
    );
    process.exit(1);
  }
  if (token && config) {
    try {
      const client = new PlatformClient(token, { root });
      await client.renameMigrations(config.projectId, renames);
      remoteRenamed = true;
      log.info('Remote migration records updated.');
    } catch (err) {
      log.error(
        'db: Failed to update remote migration records. No local changes were made.\n' +
          'Fix the connection and run `void db rename-migrations` again.',
      );
      log.error(String(err));
      process.exit(1);
    }
  }

  let journalRewritten = false;
  const renamed: Array<{ from: string; to: string }> = [];
  const renamedSnapshots: Array<{ from: string; to: string }> = [];

  // Best-effort undo of every completed step, then exit.
  const rollback = async (message: string, err: unknown): Promise<never> => {
    for (const { from, to } of renamedSnapshots) {
      try {
        renameSync(to, from);
      } catch (error) {
        log.warn(
          `db: Could not reverse snapshot rename for '${from}'. ` +
            'The meta/ directory may be in a partial state.',
        );
        log.warn(String(error));
      }
    }
    for (const { from, to } of renamed) {
      try {
        renameSync(join(migrationsDir, to), join(migrationsDir, from));
      } catch {
        // Keep reverting the remaining files.
      }
    }
    if (journalRewritten && originalJournalBytes !== null) {
      try {
        writeFileSync(journalPath, originalJournalBytes);
      } catch (error) {
        log.warn(
          `Could not restore ${dir}/meta/_journal.json after rollback. ` +
            'The journal may be in a partial state.\n' +
            'Regenerate it with `void db generate`, or restore it from version control.',
        );
        log.warn(String(error));
      }
    }
    if (remoteRenamed && token && config) {
      try {
        const client = new PlatformClient(token, { root });
        const reversed = renames.map(({ from, to }) => ({ from: to, to: from }));
        await client.renameMigrations(config.projectId, reversed);
      } catch {
        log.warn('db: Could not reverse remote rename. Run `void deploy` to sync remote records.');
      }
    }
    log.error(message);
    log.error(String(err));
    process.exit(1);
  };

  try {
    for (const { from, to } of renames) {
      renameSync(join(migrationsDir, from), join(migrationsDir, to));
      renamed.push({ from, to });
      log.step(`${from} → ${to}`);

      const snapshotFrom = snapshotPathFor(stripSqlExt(from));
      const snapshotTo = snapshotPathFor(stripSqlExt(to));
      if (existsSync(snapshotFrom)) {
        renameSync(snapshotFrom, snapshotTo);
        renamedSnapshots.push({ from: snapshotFrom, to: snapshotTo });
      }
    }
  } catch (err) {
    await rollback('db: Failed to rename migration files. All changes have been reverted.', err);
  }

  // Rewrite journal tags before the tracking tables, so a tracking failure also restores it.
  if (journal) {
    try {
      const current = readJournal(migrationsDir, paths.sourceRelative);
      if (!current) {
        throw new Error(
          `db: ${dir}/meta/_journal.json disappeared mid-run. File renames will be reverted.`,
        );
      }
      const renameMap = new Map<string, string>();
      for (const { from, to } of renames) {
        renameMap.set(stripSqlExt(from), stripSqlExt(to));
      }
      const updatedEntries = current.entries.map((entry) => {
        const next = renameMap.get(entry.tag);
        return next ? { ...entry, tag: next } : entry;
      });
      // Set before writing, so a partial write is still restored.
      journalRewritten = true;
      writeJournal(migrationsDir, {
        version: current.version,
        dialect: current.dialect,
        entries: updatedEntries,
      });
    } catch (err) {
      await rollback(
        `db: Failed to update ${dir}/meta/_journal.json. File renames have been reverted.`,
        err,
      );
    }
  }

  if (dialect === 'postgresql') {
    try {
      await withPgClient(root, async (client) => {
        const tableCheck = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = '_void_migrations' LIMIT 1`,
        );
        if (tableCheck.rows.length === 0) {
          return;
        }
        await client.query('BEGIN');
        try {
          for (const { from, to } of renames) {
            await client.query('UPDATE _void_migrations SET name = $1 WHERE name = $2', [to, from]);
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
    } catch (err) {
      await rollback(
        'db: Failed to update PostgreSQL tracking table. File renames have been reverted.\n' +
          'Fix the database connection and run `void db rename-migrations` again.',
        err,
      );
    }
  } else if (dialect === 'mysql') {
    try {
      await withMySqlClient(root, async (client) => {
        const rows = await client.query<Array<{ table_name: string }>>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '_void_migrations' LIMIT 1",
        );
        if (rows.length === 0) {
          return;
        }
        await client.query('START TRANSACTION');
        try {
          for (const { from, to } of renames) {
            await client.query('UPDATE `_void_migrations` SET `name` = ? WHERE `name` = ?', [
              to,
              from,
            ]);
          }
          await client.query('COMMIT');
        } catch (err) {
          // A lost connection also rolls back on the server, so report the first error.
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    } catch (err) {
      await rollback(
        'db: Failed to update MySQL tracking table. File renames have been reverted.\n' +
          'Fix the database connection and run `void db rename-migrations` again.',
        err,
      );
    }
  } else {
    const { openSqliteDatabase } = await import('../migrations/runner.ts');
    const { databasePath: dbPath } = getLocalD1Target(root);
    if (existsSync(dbPath)) {
      try {
        const db = await openSqliteDatabase(dbPath);
        try {
          const hasNew = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='_void_migrations'",
            )
            .get();
          const hasLegacy = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
            .get();
          const tableName = hasNew ? '_void_migrations' : hasLegacy ? '_migrations' : null;
          if (tableName) {
            const updateStmt = db.prepare(`UPDATE ${tableName} SET name = ? WHERE name = ?`);
            const applyRenames = db.transaction(() => {
              for (const { from, to } of renames) {
                updateStmt.run(to, from);
              }
            });
            applyRenames();
          }
        } finally {
          db.close();
        }
      } catch (err) {
        await rollback(
          'db: Failed to update SQLite tracking table. File renames have been reverted.\n' +
            'Fix the database issue and run `void db rename-migrations` again.',
          err,
        );
      }
    }
  }

  printSuccess(`Renamed ${formatCount(renames.length, 'migration')} to timestamp format.`);
}

// Void and Cloudflare bookkeeping tables. A full export skips them; app tables starting with `_` stay.
const INTERNAL_TABLES = new Set([
  '_void_migrations',
  '_void_migration_attempts',
  '_void_migration_lock',
  '_void_migration_fences',
  '__drizzle_migrations',
]);

function isInternalTable(name: string, dialect: DatabaseDialect): boolean {
  if (INTERNAL_TABLES.has(name)) {
    return true;
  }
  return (
    dialect === 'sqlite' &&
    (name === '_migrations' || name.startsWith('_cf_') || name.startsWith('sqlite_'))
  );
}

function formatMySqlExportValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
  }
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

function formatSqliteExportValue(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}'`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runExport(
  root: string,
  args: { output?: string; noData?: boolean; noSchema?: boolean; table?: string },
  dialect: DatabaseDialect,
): Promise<void> {
  const errOut = { output: process.stderr };
  if (dialect === 'postgresql') {
    const parts: Array<string> = [];
    await withPgClient(root, async (client) => {
      let tables: Array<string>;
      if (args.table) {
        const check = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
          [args.table],
        );
        if (check.rows.length === 0) {
          log.error(`db: Table '${args.table}' not found.`, errOut);
          process.exit(1);
        }
        tables = [args.table];
      } else {
        const result = await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        );
        tables = result.rows
          .map((row) => String(row.tablename))
          .filter((name) => !isInternalTable(name, dialect));
      }

      if (!args.noSchema) {
        await assertPgExportableSchema(client, tables, !args.table);
      }
      const sequences = await exportPgSequences(client, tables, args);
      parts.push(...sequences.before);
      for (const table of tables) {
        const cols = await client.query(
          `SELECT a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            pg_get_expr(def.adbin, def.adrelid) AS column_default,
            a.attidentity AS identity,
            a.attgenerated AS generated
          FROM pg_attribute a
          JOIN pg_class tbl ON tbl.oid = a.attrelid
          JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
          LEFT JOIN pg_attrdef def ON def.adrelid = tbl.oid AND def.adnum = a.attnum
          WHERE ns.nspname = 'public' AND tbl.relname = $1
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
          [table],
        );
        const dataColumns = cols.rows.filter((column) => !column.generated);
        const names = dataColumns.map((column) => quoteSqlIdentifier(String(column.column_name)));
        const tableName = `"public".${quoteSqlIdentifier(table)}`;
        if (!args.noSchema) {
          const colDefs = cols.rows.map((column) => {
            let def = `  ${quoteSqlIdentifier(String(column.column_name))} ${String(column.data_type)}`;
            if (column.generated) {
              def += ` GENERATED ALWAYS AS (${String(column.column_default)}) STORED`;
            } else if (column.identity) {
              def += ` GENERATED ${column.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
            } else if (column.column_default) {
              def += ` DEFAULT ${String(column.column_default)}`;
            }
            if (column.not_null) {
              def += ' NOT NULL';
            }
            return def;
          });
          parts.push(`CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`);
        }

        if (!args.noData) {
          // Ask PostgreSQL for its lossless text values. Driver Date conversion
          // loses timestamp microseconds and introduces the client's time zone;
          // JSON/large numeric values must not pass through JavaScript coercion.
          const rows = await client.query(
            `SELECT ${names.map((name) => `${name}::text AS ${name}`).join(', ')} FROM ${tableName}`,
          );
          const overriding = cols.rows.some((column) => column.identity === 'a')
            ? ' OVERRIDING SYSTEM VALUE'
            : '';
          for (const row of rows.rows) {
            const cols = Object.keys(row);
            const vals = cols.map((column) => {
              const value = row[column];
              if (value === null) {
                return 'NULL';
              }
              if (typeof value === 'number') {
                return String(value);
              }
              return `'${String(value).replace(/'/g, "''")}'`;
            });
            parts.push(
              `INSERT INTO ${tableName} (${cols.map(quoteSqlIdentifier).join(', ')})${overriding} VALUES (${vals.join(', ')});`,
            );
          }
        }
        parts.push('');
      }
      parts.push(...sequences.after);
      if (!args.noSchema) {
        parts.push(...(await exportPgConstraints(client, tables)));
      }
    });

    const output = parts.join('\n');
    if (args.output) {
      writeFileSync(resolve(root, args.output), output);
      printSuccess(`Exported to ${args.output}`);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  if (dialect === 'mysql') {
    const parts: Array<string> = [];
    const exportTables = async (client: MySqlClient) => {
      let tables: Array<string>;
      if (args.table) {
        const rows = await client.query<Array<{ table_name: string }>>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          [args.table],
        );
        if (rows.length === 0) {
          log.error(`db: Table '${args.table}' not found.`, errOut);
          process.exit(1);
        }
        tables = [args.table];
      } else {
        // MySQL 8 returns an unaliased information_schema column as `TABLE_NAME`.
        const rows = await client.query<Array<{ table_name: string }>>(
          "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
        );
        tables = rows
          .map((row) => String(row.table_name))
          .filter((name) => !isInternalTable(name, dialect));
      }

      // Tables come out in name order with inline foreign keys, so a child
      // table can precede its parent; restore with the checks off. TIMESTAMP
      // text follows the session time zone, so read and restore it in UTC.
      await client.query("SET time_zone = '+00:00'");
      parts.push('SET FOREIGN_KEY_CHECKS = 0;', "SET time_zone = '+00:00';");
      for (const table of tables) {
        const escapedTable = table.replaceAll('`', '``');
        if (!args.noSchema) {
          const rows = await client.query<Array<Record<string, unknown>>>(
            `SHOW CREATE TABLE \`${escapedTable}\``,
          );
          const createSql = rows[0]?.['Create Table'];
          if (createSql) {
            parts.push(`${String(createSql)};`);
          }
        }

        if (!args.noData) {
          const rows = await client.query(`SELECT * FROM \`${escapedTable}\``);
          for (const row of rows) {
            const columns = Object.keys(row);
            const values = columns.map((column) => formatMySqlExportValue(row[column]));
            const names = columns.map((column) => `\`${column.replaceAll('`', '``')}\``);
            parts.push(
              `INSERT INTO \`${escapedTable}\` (${names.join(', ')}) VALUES (${values.join(', ')});`,
            );
          }
        }
        parts.push('');
      }
      parts.push('SET FOREIGN_KEY_CHECKS = 1;', '');
    };
    await withMySqlClient(root, exportTables, { textValues: true });

    const output = parts.join('\n');
    if (args.output) {
      writeFileSync(resolve(root, args.output), output);
      printSuccess(`Exported to ${args.output}`);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  const { openSqliteDatabase } = await import('../migrations/runner.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);

  if (!existsSync(dbPath)) {
    log.error('No local database found. Start the dev server first.', errOut);
    process.exit(1);
  }

  const db = await openSqliteDatabase(dbPath, { readonly: true });
  try {
    let tables: Array<string>;
    if (args.table) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(args.table);
      if (!exists) {
        log.error(`db: Table '${args.table}' not found.`, errOut);
        process.exit(1);
      }
      tables = [args.table];
    } else {
      tables = db
        .prepare<{ name: unknown }>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => String(row.name))
        .filter((name) => !isInternalTable(name, dialect));
    }

    const parts: Array<string> = [];

    for (const table of tables) {
      if (!args.noSchema) {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) as { sql: string };
        parts.push(row.sql + ';');
      }

      if (!args.noData) {
        const insertableColumns = new Set(
          db
            .prepare<{ name: string; hidden: number }>(
              `PRAGMA table_xinfo(${quoteSqlIdentifier(table)})`,
            )
            .all()
            .filter((column) => column.hidden === 0)
            .map((column) => column.name),
        );
        const rows = db.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)}`).all() as Array<
          Record<string, unknown>
        >;
        for (const row of rows) {
          const cols = Object.keys(row).filter((column) => insertableColumns.has(column));
          const vals = cols.map((column) => formatSqliteExportValue(row[column]));
          parts.push(
            `INSERT INTO ${quoteSqlIdentifier(table)} (${cols.map(quoteSqlIdentifier).join(', ')}) VALUES (${vals.join(', ')});`,
          );
        }
      }

      parts.push('');
    }

    // SQLite creates sqlite_sequence itself when an AUTOINCREMENT table is
    // restored. Preserve its high-water marks after all table data, including
    // deleted IDs, without attempting to CREATE this reserved system table.
    if (
      !args.noData &&
      db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").get()
    ) {
      const sequences = db
        .prepare<{ name: string; seq: number }>('SELECT name, seq FROM sqlite_sequence')
        .all();
      for (const sequence of sequences) {
        if (tables.includes(sequence.name)) {
          const name = quoteSqlString(sequence.name);
          parts.push(`DELETE FROM sqlite_sequence WHERE name = ${name};`);
          parts.push(`INSERT INTO sqlite_sequence (name, seq) VALUES (${name}, ${sequence.seq});`);
        }
      }
    }

    if (!args.noSchema) {
      const schemaObjects = db
        .prepare<{ type: string; name: string; tbl_name: string; sql: string }>(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY rowid",
        )
        .all();
      for (const type of ['index', 'view', 'trigger']) {
        for (const object of schemaObjects) {
          if (object.type !== type) {
            continue;
          }
          if (type === 'view') {
            if (args.table || isInternalTable(object.name, dialect)) {
              continue;
            }
          } else if (!tables.includes(object.tbl_name)) {
            continue;
          }
          parts.push(object.sql.trim().replace(/;?$/, ';'));
        }
      }
    }

    const output = parts.join('\n');

    if (args.output) {
      writeFileSync(resolve(root, args.output), output);
      printSuccess(`Exported to ${args.output}`);
    } else {
      // Print raw SQL to stdout for piping — no clack formatting
      process.stdout.write(output);
    }
  } finally {
    db.close();
  }
}

async function runSetUrl(root: string, dialect: DatabaseDialect): Promise<void> {
  if (dialect === 'sqlite') {
    log.error(
      'db: This command is only for PostgreSQL and MySQL projects. Set "database" to "pg" or "mysql" in void.config.ts.',
    );
    process.exit(1);
  }

  const token = getToken(root);
  if (!token) {
    log.error('No auth token found. Run `void account login` first.');
    process.exit(1);
  }

  const projectConfig = readProjectConfig(root);
  if (!projectConfig) {
    log.error('No project linked. Run `void deploy` first or link a project.');
    process.exit(1);
  }

  const connectionString = await text({
    message: `Enter your ${dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'} connection string:`,
    placeholder:
      dialect === 'mysql'
        ? 'mysql://user:pass@host:3306/dbname'
        : 'postgresql://user:pass@host:5432/dbname',
    validate(value = '') {
      if (dialect === 'mysql') {
        if (!value.startsWith('mysql://')) {
          return 'Connection string must start with "mysql://"';
        }
      } else if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
        return 'Connection string must start with "postgres://" or "postgresql://"';
      }
    },
  });

  if (isCancel(connectionString)) {
    process.exit(0);
  }

  const client = new PlatformClient(token, { root });
  await client.setDatabaseUrl(projectConfig.projectId, connectionString as string);

  printSuccess('Database URL updated.');
}

function resolveSeedTarget(root: string, file: string | undefined): SeedTarget {
  if (file) {
    return toSeedTarget(root, resolve(root, file), file);
  }

  const paths = readProjectPaths(root);
  const defaults = DEFAULT_SEED_FILES.map((candidate) => paths.sourceRelative(candidate)).filter(
    (candidate) => existsSync(join(root, candidate)),
  );
  if (defaults.length === 0) {
    log.error(
      `db: No seed file found. Create one of: ${DEFAULT_SEED_FILES.map((candidate) => paths.sourceRelative(candidate)).join(', ')} or pass --file <path>.`,
    );
    process.exit(1);
  }

  if (defaults.length > 1) {
    log.error(
      `db: Multiple default seed files found: ${defaults.join(', ')}. Use --file <path> to choose one.`,
    );
    process.exit(1);
  }

  const [seedPath] = defaults;
  return toSeedTarget(root, join(root, seedPath), seedPath);
}

function toSeedTarget(root: string, seedPath: string, displayPath?: string): SeedTarget {
  if (!existsSync(seedPath)) {
    log.error(`db: Seed file '${seedPath}' not found.`);
    process.exit(1);
  }

  const ext = extname(seedPath);
  const normalizedDisplay = (displayPath ?? relative(root, seedPath)).replaceAll('\\', '/');
  if (ext === '.sql') {
    return { path: seedPath, displayPath: normalizedDisplay, kind: 'sql' };
  }
  if (MODULE_SEED_EXTENSIONS.has(ext)) {
    return { path: seedPath, displayPath: normalizedDisplay, kind: 'module' };
  }

  log.error(`db: Unsupported seed file '${normalizedDisplay}'. Use .sql, .ts, .mts, .js, or .mjs.`);
  process.exit(1);
}

async function runSeedModule(
  root: string,
  seed: SeedFn<Record<string, unknown>>,
  dialect: DatabaseDialect,
): Promise<void> {
  const schema = await loadSeedSchema(root);
  const casing = getDatabaseCasing(readConfig(root));

  if (dialect === 'postgresql') {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    await withPgClient(root, async (client) => {
      const options = getDrizzleSchemaOptions(schema, casing);
      const drizzleClient = client as never;
      const db = options ? drizzle(drizzleClient, options) : drizzle(drizzleClient);
      await seed({ dialect, db, schema });
    });
    return;
  }

  if (dialect === 'mysql') {
    const { drizzle } = await import('drizzle-orm/mysql2');
    const { createConnection } = await import('mysql2/promise');
    const connection = await createConnection(getLocalDatabaseUrl(root, 'mysql'));
    try {
      const options = getDrizzleSchemaOptions(schema, casing);
      const db = options
        ? drizzle(connection, { ...options, mode: 'default' })
        : drizzle(connection);
      await seed({ dialect, db, schema });
    } finally {
      await connection.end();
    }
    return;
  }

  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { openSqliteDatabase } = await import('../migrations/runner.ts');
  const { databasePath: dbPath } = getLocalD1Target(root);
  const sqlite = await openSqliteDatabase(dbPath);
  try {
    const options = getDrizzleSchemaOptions(schema, casing);
    const db = options ? drizzle(sqlite as never, options) : drizzle(sqlite as never);
    await seed({ dialect, db, schema });
  } finally {
    sqlite.close();
  }
}

async function loadSeedFunction(seedPath: string): Promise<SeedFn<Record<string, unknown>>> {
  const mod = await importLocalModule(seedPath);
  const seed =
    typeof mod.default === 'function'
      ? mod.default
      : typeof mod.seed === 'function'
        ? mod.seed
        : undefined;
  if (!seed) {
    throw new Error(
      `db: Seed module '${seedPath}' must export a default function or a named "seed" function.`,
    );
  }
  return seed as SeedFn<Record<string, unknown>>;
}

async function loadSeedSchema(root: string): Promise<Record<string, unknown>> {
  const { discoverSchema } = await import('../drizzle/discover.ts');
  const paths = readProjectPaths(root);
  const location = discoverSchema(root, paths);
  if (!location) {
    return {};
  }

  if (location.type === 'file') {
    const mod = await importLocalModule(location.path);
    return Object.fromEntries(
      Object.entries(mod).filter(([name]) => name !== 'default' && name !== '__esModule'),
    );
  }

  const files = collectSchemaModuleFiles(location.path);
  const parts = await Promise.all(files.map((file) => importLocalModule(file)));
  return Object.assign(
    {},
    ...parts.map((mod) =>
      Object.fromEntries(Object.entries(mod).filter(([name]) => name !== 'default')),
    ),
  );
}

function collectSchemaModuleFiles(dir: string): Array<string> {
  const files: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSchemaModuleFiles(fullPath));
      continue;
    }
    if (
      MODULE_SEED_EXTENSIONS.has(extname(entry.name)) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.d.mts')
    ) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function importLocalModule(modulePath: string): Promise<Record<string, unknown>> {
  // Native import() cannot resolve the extensionless re-exports that `void gen model` writes.
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    interopDefault: false,
  });
  return jiti.import<Record<string, unknown>>(modulePath);
}

/** The schema and casing that `void/db` gives drizzle, or undefined when neither is set. */
function getDrizzleSchemaOptions(
  schema: Record<string, unknown>,
  casing: DatabaseCasing | undefined,
): { schema?: Record<string, unknown>; casing?: DatabaseCasing } | undefined {
  const options = {
    ...(Object.keys(schema).length > 0 ? { schema } : {}),
    ...(casing ? { casing } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}
