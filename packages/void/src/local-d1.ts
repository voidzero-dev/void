import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'pathslash';
import { readRootWranglerConfig } from './cli/wrangler.ts';
import { getMiniflareDatabasePath } from './migrations/runner.ts';

const LOCAL_D1_STATE_FILE = 'local-d1.json';
const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];

type LocalD1PersistState = {
  version: 1;
  projectRoot: string;
  persistRoot: string;
  viteConfig?: { path: string; hash: string };
};

export type LocalD1Target = {
  bindingName: string;
  databaseId: string;
  persistRoot: string;
  databasePath: string;
};

function readConfiguredDatabaseId(root: string, bindingName: string): string | undefined {
  let rootConfig: ReturnType<typeof readRootWranglerConfig>;
  try {
    rootConfig = readRootWranglerConfig(root);
  } catch (error) {
    throw new Error(`db: cannot read malformed Wrangler configuration in ${root}.`, {
      cause: error,
    });
  }
  if (!rootConfig) {
    return undefined;
  }
  const { configPath, config } = rootConfig;
  const rawDatabases = config.d1_databases;
  if (rawDatabases === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawDatabases)) {
    throw new Error(`db: cannot read ${configPath}: "d1_databases" must be an array.`);
  }
  if (
    rawDatabases.some(
      (entry) =>
        entry === null ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).binding !== 'string' ||
        (entry as Record<string, unknown>).binding === '',
    )
  ) {
    throw new Error(
      `db: cannot read ${configPath}: every "d1_databases" entry needs a non-empty binding.`,
    );
  }

  const matches = (rawDatabases as Array<Record<string, unknown>>).filter(
    (entry) => entry.binding === bindingName,
  );
  if (matches.length > 1) {
    throw new Error(
      `db: cannot select local D1 database: binding ${JSON.stringify(bindingName)} is declared ` +
        `${matches.length} times in ${configPath}.`,
    );
  }
  const match = matches[0];
  if (!match) {
    return undefined;
  }

  // Wrangler and Miniflare use the preview ID for local development when one is present.
  for (const value of [match.preview_database_id, match.database_id, match.binding]) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function statePath(root: string): string {
  return join(root, '.void', LOCAL_D1_STATE_FILE);
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findViteConfig(root: string): string | undefined {
  return VITE_CONFIG_NAMES.map((name) => join(root, name)).find(existsSync);
}

/**
 * Record the persistence directory selected by voidPlugin({ persistTo }). The binding and
 * database ID are deliberately not cached: CLI commands always reread Wrangler configuration.
 */
export function writeLocalD1PersistState(root: string, persistTo: string | undefined): void {
  const path = statePath(root);
  if (persistTo === undefined) {
    rmSync(path, { force: true });
    return;
  }

  const projectRoot = resolve(root);
  const viteConfigPath = findViteConfig(projectRoot);
  const state: LocalD1PersistState = {
    version: 1,
    projectRoot,
    persistRoot: isAbsolute(persistTo) ? persistTo : resolve(projectRoot, persistTo),
    ...(viteConfigPath
      ? {
          viteConfig: {
            path: viteConfigPath,
            hash: hashFile(viteConfigPath),
          },
        }
      : {}),
  };
  mkdirSync(join(projectRoot, '.void'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function readLocalD1PersistState(root: string): LocalD1PersistState | undefined {
  const path = statePath(root);
  if (!existsSync(path)) {
    return undefined;
  }

  let state: LocalD1PersistState;
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as LocalD1PersistState;
  } catch {
    throw new Error(
      `db: local D1 state in ${path} is invalid. Start the dev server to refresh it.`,
    );
  }
  const projectRoot = resolve(root);
  if (
    state.version !== 1 ||
    state.projectRoot !== projectRoot ||
    typeof state.persistRoot !== 'string' ||
    state.persistRoot.length === 0
  ) {
    throw new Error(`db: local D1 state in ${path} is stale. Start the dev server to refresh it.`);
  }
  if (state.viteConfig) {
    const { path: configPath, hash } = state.viteConfig;
    if (!existsSync(configPath) || hashFile(configPath) !== hash) {
      throw new Error(
        `db: voidPlugin persistence configuration changed since the local D1 state was written. ` +
          'Start the dev server to refresh it before using `void db`.',
      );
    }
  }
  return state;
}

export function resolveLocalD1Target(
  root: string,
  options: {
    bindingName?: string;
    defaultPersistRoot?: string;
    persistRoot?: string;
    readPersistState?: boolean;
  } = {},
): LocalD1Target {
  const projectRoot = resolve(root);
  const bindingName = options.bindingName ?? 'DB';
  const state = options.readPersistState ? readLocalD1PersistState(projectRoot) : undefined;
  const selectedPersistRoot =
    options.persistRoot ??
    state?.persistRoot ??
    options.defaultPersistRoot ??
    join(projectRoot, '.void');
  const persistRoot = isAbsolute(selectedPersistRoot)
    ? selectedPersistRoot
    : resolve(projectRoot, selectedPersistRoot);
  const databaseId = readConfiguredDatabaseId(projectRoot, bindingName) ?? 'local';

  return {
    bindingName,
    databaseId,
    persistRoot,
    databasePath: getMiniflareDatabasePath(persistRoot, databaseId),
  };
}
