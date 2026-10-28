import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { parseTree, type Node } from 'jsonc-parser';
import { join } from 'pathslash';
import {
  ignoreMaterializedCloudflareConfig,
  seedCloudflareConfig,
  stashCloudflareDeployPointer,
  VOID_LOCK_FILE,
} from '../cloudflare-config.ts';
import { loadTypedVoidConfigFile, TYPED_CONFIG_FILE } from '../config-loader.ts';
import { GENERATED_MARKERS, renderVoidConfig } from '../config-write.ts';
import { validateConfig, type VoidConfig } from '../config.ts';
import {
  applyFrameworkConfigMigration,
  discoverFrameworkWranglerFiles,
  planFrameworkConfigMigration,
} from './framework-config-migrate.ts';
import { parseJsoncObject } from './generated-wrangler-config.ts';
import { printSuccess } from './output.ts';
import { LATEST_KNOWN_COMPAT_DATE } from './wrangler.ts';

const LEGACY_FILE = 'void.json';

function parseWranglerJsonc(path: string, raw: string): Record<string, unknown> {
  const parsed = parseJsoncObject(raw);
  if (!parsed) {
    throw new Error(`migrate: Invalid JSON/JSONC in ${path}. Fix it before migrating.`);
  }
  function assertUnique(node: Node | undefined): void {
    if (!node) {
      return;
    }
    if (node.type === 'object') {
      const seen = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value as string;
        if (seen.has(key)) {
          throw new Error(
            `migrate: Duplicate key ${JSON.stringify(key)} in ${path}. Resolve it before migrating.`,
          );
        }
        seen.add(key);
        assertUnique(property.children?.[1]);
      }
    } else {
      for (const child of node.children ?? []) {
        assertUnique(child);
      }
    }
  }
  assertUnique(parseTree(raw.replace(/^\uFEFF/, '')));
  return parsed;
}

function backup(root: string, name: string, content: string): void {
  const dir = join(root, '.void', 'config-migration');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (!existsSync(path)) {
    writeFileSync(path, content, { flag: 'wx' });
  }
}

function isOrphanedCompatibilityConfig(
  root: string,
  legacy: Record<string, unknown>,
  typed: Record<string, unknown>,
): boolean {
  if (
    !isDeepStrictEqual(legacy, {
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    })
  ) {
    return false;
  }
  const backupPath = join(root, '.void', 'config-migration', LEGACY_FILE);
  if (!existsSync(backupPath)) {
    return false;
  }
  try {
    const original = JSON.parse(readFileSync(backupPath, 'utf8')) as Record<string, unknown>;
    delete original.$schema;
    return isDeepStrictEqual(original, typed);
  } catch {
    return false;
  }
}

/** Move Void and Cloudflare JSON/JSONC settings into a typed, checked-in project config. */
export function migrateLegacyVoidConfig(root: string): boolean {
  const legacyPath = join(root, LEGACY_FILE);
  const wranglerFiles = [
    ...new Set([
      ...['wrangler.jsonc', 'wrangler.json'].filter((name) => existsSync(join(root, name))),
      ...discoverFrameworkWranglerFiles(root),
    ]),
  ];
  if (wranglerFiles.length > 1) {
    throw new Error(
      `migrate: Multiple root Wrangler JSON files exist (${wranglerFiles.join(', ')}). Keep one before migrating.`,
    );
  }
  if (existsSync(join(root, 'wrangler.toml'))) {
    throw new Error('migrate: Wrangler TOML is not supported. Convert it to JSON/JSONC first.');
  }
  const wranglerName = wranglerFiles[0];
  const typedPath = join(root, TYPED_CONFIG_FILE);
  if (!existsSync(legacyPath) && !wranglerName) {
    if (existsSync(typedPath)) {
      stashCloudflareDeployPointer(root);
    }
    return false;
  }
  const frameworkPatches = planFrameworkConfigMigration(root, wranglerName);

  const raw = existsSync(legacyPath) ? readFileSync(legacyPath, 'utf8') : undefined;
  let legacy: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      legacy = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`migrate: Invalid JSON in ${LEGACY_FILE}. Fix it before migrating.`);
    }
    validateConfig(legacy);
  }
  const withoutSchema = { ...legacy };
  delete withoutSchema.$schema;

  const wranglerRaw = wranglerName ? readFileSync(join(root, wranglerName), 'utf8') : undefined;
  const cloudflare =
    wranglerName && wranglerRaw !== undefined
      ? parseWranglerJsonc(wranglerName, wranglerRaw)
      : undefined;

  const hadTyped = existsSync(typedPath);
  let current: Record<string, unknown> | undefined;
  if (hadTyped) {
    const existing = readFileSync(typedPath, 'utf8');
    if (!GENERATED_MARKERS.some((marker) => existing.startsWith(marker))) {
      throw new Error(
        `migrate: ${TYPED_CONFIG_FILE} already exists. Move the legacy settings into it before deleting the old files.`,
      );
    }
    current = validateConfig(loadTypedVoidConfigFile(typedPath), TYPED_CONFIG_FILE) as Record<
      string,
      unknown
    >;
    const currentVoid = { ...current };
    delete currentVoid.cloudflare;
    if (
      raw !== undefined &&
      !isDeepStrictEqual(currentVoid, withoutSchema) &&
      !isOrphanedCompatibilityConfig(root, withoutSchema, currentVoid)
    ) {
      throw new Error(
        `migrate: ${LEGACY_FILE} and ${TYPED_CONFIG_FILE} differ. Resolve their settings before retrying.`,
      );
    }
    if (
      cloudflare &&
      current.cloudflare !== undefined &&
      !isDeepStrictEqual(current.cloudflare, cloudflare)
    ) {
      throw new Error(
        `migrate: Cloudflare settings in ${TYPED_CONFIG_FILE} differ from ${wranglerName}. Resolve them before retrying.`,
      );
    }
  }
  const next = { ...(current ?? withoutSchema) };
  if (cloudflare) {
    next.cloudflare = cloudflare;
  }

  const needsTypedWrite = !hadTyped || !isDeepStrictEqual(current, next);
  const temporaryPath = join(root, `.void.config.${randomUUID()}.ts`);
  if (needsTypedWrite) {
    writeFileSync(temporaryPath, renderVoidConfig(next as VoidConfig), { flag: 'wx' });
  }
  try {
    if (needsTypedWrite) {
      const loaded = loadTypedVoidConfigFile(temporaryPath);
      validateConfig(loaded, TYPED_CONFIG_FILE);
      if (!isDeepStrictEqual(loaded, next)) {
        throw new Error('migrate: The typed config did not reproduce the original settings.');
      }
    }

    if (raw !== undefined) {
      backup(root, LEGACY_FILE, raw);
    }
    if (wranglerName && wranglerRaw !== undefined) {
      backup(root, wranglerName, wranglerRaw);
    }
    if (cloudflare && wranglerRaw !== undefined) {
      seedCloudflareConfig(root, cloudflare, wranglerRaw);
    }
    if (needsTypedWrite) {
      renameSync(temporaryPath, typedPath);
    }
    applyFrameworkConfigMigration(root, frameworkPatches);
    if (raw !== undefined) {
      unlinkSync(legacyPath);
    }
    if (wranglerName) {
      unlinkSync(join(root, wranglerName));
    }
    ignoreMaterializedCloudflareConfig(root);
    stashCloudflareDeployPointer(root);
    return true;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function runMigrateCommand(root: string): Promise<void> {
  console.log();
  if (migrateLegacyVoidConfig(root)) {
    log.step(
      `Migrated project settings to ${TYPED_CONFIG_FILE}. Commit it and ${VOID_LOCK_FILE} when present.`,
    );
    printSuccess('Configuration migration complete.');
  } else {
    log.info('No legacy project configuration found.');
  }
}
