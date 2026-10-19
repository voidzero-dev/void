import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'pathslash';
import { getDatabaseCasing, readConfig } from '../config.ts';
import { resolveProjectPaths } from '../project-paths.ts';
import { discoverSchema, schemaSpecifier } from './discover.ts';

type DrizzleDialect = 'sqlite' | 'postgresql' | 'mysql';

/** drizzle-kit `generate` needs a URL but never connects. */
export const PLACEHOLDER_DB_URL: Record<DrizzleDialect, string> = {
  sqlite: ':memory:',
  postgresql: 'postgresql://dummy',
  mysql: 'mysql://dummy',
};

/**
 * Write a temporary drizzle-kit config, by default to `.void/drizzle.config.json`.
 * Schema and migration paths are relative to the project root: drizzle-kit
 * resolves them against its working directory, and `void db` always runs it
 * with `cwd` set to the project root, so the config file itself may live
 * anywhere (see `outDir`). It carries `database.casing` from the project's
 * config, which `void/db` also passes to drizzle.
 *
 * @param options.outDir Directory for the config file. When set, the file is
 *   written readable by the owner only.
 * @returns Absolute path to the written config file.
 */
export function writeDrizzleConfig(
  root: string,
  dbPath: string,
  dialect: DrizzleDialect = 'sqlite',
  options?: { additionalSchemas?: Array<string>; outDir?: string },
): string {
  const projectConfig = readConfig(root);
  const paths = resolveProjectPaths(root, projectConfig);
  const casing = getDatabaseCasing(projectConfig);
  const schema = discoverSchema(root, paths);
  const schemaPaths = [
    ...(schema ? [schemaSpecifier(schema, root)] : []),
    ...(options?.additionalSchemas ?? []).map((path) => `./${relative(root, path)}`),
  ];
  if (schemaPaths.length === 0) {
    throw new Error(
      `db: No Drizzle schema found. Create ${paths.sourceRelative('db/schema.ts')} or run \`void gen model <name>\`.`,
    );
  }

  const outDir = options?.outDir ?? join(root, '.void');
  mkdirSync(outDir, { recursive: true });

  const config = {
    dialect,
    ...(casing ? { casing } : {}),
    schema: schemaPaths.length === 1 ? schemaPaths[0] : schemaPaths,
    out: `./${relative(root, paths.migrationsDir)}`,
    migrations: { prefix: 'timestamp' },
    dbCredentials: { url: dbPath },
  };

  const configPath = join(outDir, 'drizzle.config.json');
  writeFileSync(
    configPath,
    JSON.stringify(config, null, 2) + '\n',
    options?.outDir ? { mode: 0o600 } : undefined,
  );
  return configPath;
}

/**
 * Run `run` with a drizzle-kit config that holds a real database URL, kept
 * out of the project directory (the dev server can serve files under it).
 * The config lives in a private temp directory that is removed afterwards.
 *
 * Older CLI versions wrote such URLs to `.void/drizzle.config.json`; a
 * file left there with one is removed first.
 *
 * A no-op SIGINT listener stays installed while `run` executes: Drizzle
 * Studio is stopped with Ctrl-C, and without a listener Node would exit on
 * the signal before `finally` removes the directory.
 */
export function withPrivateDrizzleConfig<T>(
  root: string,
  dbUrl: string,
  dialect: DrizzleDialect,
  run: (configPath: string) => T,
): T {
  removeProjectDrizzleConfigWithUrl(root);
  const dir = mkdtempSync(join(tmpdir(), 'void-drizzle-'));
  const noop = () => {};
  process.on('SIGINT', noop);
  try {
    const configPath = writeDrizzleConfig(root, dbUrl, dialect, { outDir: dir });
    return run(configPath);
  } finally {
    process.off('SIGINT', noop);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The CLI now writes only local SQLite paths or placeholder URLs to
 * `.void/drizzle.config.json`, so any other URL there is a real one.
 */
function removeProjectDrizzleConfigWithUrl(root: string): void {
  const configPath = join(root, '.void', 'drizzle.config.json');
  let url: unknown;
  try {
    url = JSON.parse(readFileSync(configPath, 'utf-8'))?.dbCredentials?.url;
  } catch {
    return;
  }
  if (
    typeof url === 'string' &&
    url.includes('://') &&
    !Object.values(PLACEHOLDER_DB_URL).includes(url)
  ) {
    rmSync(configPath, { force: true });
  }
}
