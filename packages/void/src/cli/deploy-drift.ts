import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative } from 'pathslash';
import type { DatabaseDialect } from '../config.ts';
import { PLACEHOLDER_DB_URL, writeDrizzleConfig } from '../drizzle/config.ts';
import { discoverSchema } from '../drizzle/discover.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { listDrizzleArtifacts } from '../migrations/validate.ts';
import { readProjectPaths } from '../project-paths.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { log } from './deploy-helpers.ts';
import { getErrorMessage } from './output.ts';
import { drizzleKitBin } from './yarn-pnp.ts';

const deployDriftCheckDir = join('.void', 'deploy-drift-check');

/** Top-level entries never copied into the isolated drift-check project. */
const DRIFT_PROJECT_SKIPPED_ENTRIES = new Set([
  '.git',
  '.void',
  'node_modules',
  'dist',
  'build',
  '.wrangler',
  '.turbo',
  '.next',
  '.svelte-kit',
  '.output',
]);

export function assertDeploySchemaDriftFree(root: string, dialect: DatabaseDialect): void {
  try {
    if (!hasDeploySchemaDrift(root, dialect)) {
      return;
    }
  } catch (error: unknown) {
    log.error(getErrorMessage(error));
    process.exit(1);
  }

  log.error(getDeploySchemaDriftMessage(root));
  process.exit(1);
}

export function hasDeploySchemaDrift(root: string, dialect: DatabaseDialect): boolean {
  const authSchemaPath = join(root, '.void', 'better-auth-schema.ts');
  if (!discoverSchema(root, readProjectPaths(root)) && !existsSync(authSchemaPath)) {
    return false;
  }

  const driftRoot = mkDeployDriftCheckRoot(root);
  const driftProjectRoot = join(driftRoot, 'project');

  createDeployDriftProject(root, driftProjectRoot);

  try {
    const migrationsDir = readProjectPaths(driftProjectRoot).migrationsDir;
    const before = snapshotDir(migrationsDir);
    const driftAuthSchemaPath = join(driftProjectRoot, '.void', 'better-auth-schema.ts');
    const driftConfigPath = writeDrizzleConfig(
      driftProjectRoot,
      PLACEHOLDER_DB_URL[dialect],
      dialect,
      {
        additionalSchemas: existsSync(driftAuthSchemaPath) ? [driftAuthSchemaPath] : undefined,
      },
    );

    const output = runDrizzleKitGenerate(driftProjectRoot, driftConfigPath);
    const after = snapshotDir(migrationsDir);
    const snapshotsEqual = migrationSnapshotsEqual(before, after);

    if (snapshotsEqual && !output.includes('No schema changes, nothing to migrate')) {
      throw new Error(output || 'drizzle-kit generate finished without reporting schema status.');
    }

    return !snapshotsEqual;
  } catch (error) {
    throw new Error(formatDeploySchemaDriftCheckError(error), { cause: error });
  } finally {
    rmSync(driftRoot, { recursive: true, force: true });
    cleanupDeployDriftCheckRoot(root);
  }
}

function runDrizzleKitGenerate(root: string, configPath: string): string {
  const result = spawnSync(process.execPath, [drizzleKitBin, 'generate', '--config', configPath], {
    cwd: root,
    encoding: 'utf8',
    // drizzle-kit runs project code, so it gets no credentials.
    env: buildEnv(),
  });
  const stderr = (result.stderr ?? '').trim();
  const stdout = (result.stdout ?? '').trim();
  const output = [stderr, stdout].filter(Boolean).join('\n').trim();

  if (result.error) {
    throw result.error;
  }
  if (stderr) {
    throw new Error(output);
  }
  if (result.status !== 0) {
    throw new Error(output || `drizzle-kit generate exited with code ${result.status}.`);
  }

  return output;
}

export function getDeploySchemaDriftMessage(root: string): string {
  const migrationsDir = readProjectPaths(root).migrationsDir;
  // Hand-written SQL with no Drizzle journal or snapshot: Drizzle diffs the schema
  // against nothing, so `void db generate` would emit a migration that recreates
  // tables the existing SQL already creates (and fails the fresh-database replay).
  if (
    collectMigrations(migrationsDir).length > 0 &&
    !existsSync(join(migrationsDir, 'meta', '_journal.json')) &&
    listDrizzleArtifacts(migrationsDir).length === 0
  ) {
    const dir = `${relative(root, migrationsDir)}/`;
    return [
      `Missing Drizzle metadata in ${dir}.`,
      'See https://void.cloud/guide/database#hand-written-migrations',
    ].join('\n');
  }

  return [
    `Schema drift detected between your Drizzle schema and ${relative(root, migrationsDir)}/.`,
    'Run `void db generate`, review the generated migration, commit it yourself, then rerun `void deploy`.',
  ].join('\n');
}

function formatDeploySchemaDriftCheckError(error: unknown): string {
  const detail = getErrorMessage(error);
  return [
    'Failed to check Drizzle schema drift during deploy.',
    'Run `void db generate` locally, fix any reported issues, review the generated migration, commit it yourself, then rerun `void deploy`.',
    ...(detail ? [detail] : []),
  ].join('\n\n');
}

function createDeployDriftProject(root: string, driftProjectRoot: string): void {
  mkdirSync(driftProjectRoot, { recursive: true });

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (DRIFT_PROJECT_SKIPPED_ENTRIES.has(entry.name)) {
      continue;
    }

    const source = join(root, entry.name);
    const target = join(driftProjectRoot, entry.name);

    cpSync(source, target, { recursive: true });
  }

  // The build-generated Better Auth schema participates in `void db generate`, so
  // it must also participate in the isolated drift check. The generated tsconfig
  // maps `@auth-schema`, and the app's tsconfig may extend it, so schema imports
  // resolve only with it present. Copy only these known generated inputs; the rest
  // of `.void` stays excluded.
  for (const file of ['better-auth-schema.ts', 'tsconfig.json']) {
    const source = join(root, '.void', file);
    if (existsSync(source)) {
      const target = join(driftProjectRoot, '.void', file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
  }
}

function mkDeployDriftCheckRoot(root: string): string {
  const driftCheckDir = join(root, deployDriftCheckDir);
  rmSync(driftCheckDir, { recursive: true, force: true });
  mkdirSync(driftCheckDir, { recursive: true });
  return mkdtempSync(join(driftCheckDir, 'check-'));
}

function cleanupDeployDriftCheckRoot(root: string): void {
  const driftCheckDir = join(root, deployDriftCheckDir);
  try {
    if (existsSync(driftCheckDir) && readdirSync(driftCheckDir).length === 0) {
      rmSync(driftCheckDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup only. The deploy drift check must not mask
    // the original Drizzle Kit error with a cleanup failure.
  }
}

function snapshotDir(root: string): Record<string, string> {
  if (!existsSync(root)) {
    return {};
  }

  const snapshot: Record<string, string> = {};
  collectSnapshotFiles(root, root, snapshot);
  return snapshot;
}

function collectSnapshotFiles(
  current: string,
  root: string,
  snapshot: Record<string, string>,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectSnapshotFiles(fullPath, root, snapshot);
      continue;
    }
    snapshot[relative(root, fullPath)] = readFileSync(fullPath, 'utf8');
  }
}

function migrationSnapshotsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([leftPath, leftContent], index) => {
    const [rightPath, rightContent] = rightEntries[index] ?? [];
    return leftPath === rightPath && leftContent === rightContent;
  });
}
