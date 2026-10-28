import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  appendSqliteClassMigration,
  isRecord,
  type DurableObjectMigrationStep,
} from '@void/deploy-core';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  SyntaxKind,
  type FormattingOptions,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { basename, dirname, join, normalize, resolve } from 'pathslash';
import {
  ignoreMaterializedCloudflareConfig,
  materializeCloudflareConfig,
  MATERIALIZED_CLOUDFLARE_FILE,
  persistCloudflareConfig,
} from '../cloudflare-config.ts';
import { TYPED_CONFIG_FILE } from '../config-loader.ts';
import { writeVoidProjectConfig } from '../config-write.ts';
import { readConfig, type VoidConfig } from '../config.ts';
import type { DurableObjectModule } from '../durable/scan.ts';
import type { InferredBindings } from '../inference/walk.ts';
import type { WebSocketRouteDefinition } from '../router/websocket.ts';

const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** UTF-8 byte-order mark. Node's utf-8 read preserves a leading one. */
const UTF8_BOM = '﻿';
const NODEJS_ALS_FLAG = 'nodejs_als';
const NODEJS_COMPAT_FLAG = 'nodejs_compat';
const VOID_CONFIG_FILE = 'void.json';

function projectWranglerPaths(root: string): Array<string> {
  if (existsSync(join(root, TYPED_CONFIG_FILE))) {
    return [materializeCloudflareConfig(root)];
  }
  return ['wrangler.jsonc', 'wrangler.json'].map((name) => join(root, name));
}

/** Record a change to the generated Cloudflare config in `void.lock.json`. */
export function persistMaterializedWranglerConfig(configPath: string): void {
  if (basename(configPath) === MATERIALIZED_CLOUDFLARE_FILE) {
    persistCloudflareConfig(dirname(configPath));
  }
}

function writeProjectWranglerFile(configPath: string, text: string): void {
  writeFileSync(configPath, text);
  persistMaterializedWranglerConfig(configPath);
}

/**
 * Read the first existing project Wrangler config. A missing or unparseable one is
 * replaced by the generated config, starting from an empty object.
 */
function readOrCreateProjectWranglerConfig(root: string): {
  configPath: string;
  parsed: Record<string, unknown>;
  created: boolean;
} {
  const configPath = projectWranglerPaths(root).find((path) => existsSync(path));
  if (configPath) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = parseJsonc(readFileSync(configPath, 'utf-8'));
    } catch {
      // Can't read, replace with the generated config below.
    }
    if (parsed) {
      return { configPath, parsed, created: false };
    }
  }
  return { configPath: materializeCloudflareConfig(root), parsed: {}, created: true };
}

function durableObjectBindingsOf(
  config: Record<string, unknown>,
): Array<{ name: string; class_name: string }> {
  return (
    (
      config.durable_objects as
        | { bindings?: Array<{ name: string; class_name: string }> }
        | undefined
    )?.bindings ?? []
  );
}

const MANAGED_QUEUES_MARKER = /^\s*\/\/ void:managed-queues:v1:([A-Za-z0-9_-]+)\s*$/m;
const PUBLISHED_TRAFFIC_MARKER = /^\s*\/\/ void:published-traffic:v1:([A-Za-z0-9_-]+)\s*$/m;
export const DEFAULT_LIVE_BINDING = 'VOID_LIVE';
export const DEFAULT_LIVE_CLASS = 'VoidLiveStreamDurableObject';
export const LIVE_MIGRATION_TAG = 'live-v1';

export type WranglerCustomDomain = {
  pattern: string;
  customDomain: true;
};

export type WranglerCustomDomainUpdate = {
  configPath: string;
  domains: Array<WranglerCustomDomain>;
  modified: boolean;
};

export type WranglerPublishedTrafficSnapshot = {
  workers_dev: boolean;
  preview_urls: boolean;
  routes: Array<unknown>;
};

export type RootWranglerConfig = {
  configPath: string;
  config: Record<string, unknown>;
};

/** Read the root Wrangler config with the same JSONC parser used by binding sync. */
export function readRootWranglerConfig(root: string): RootWranglerConfig | undefined {
  for (const configPath of projectWranglerPaths(root)) {
    if (!existsSync(configPath)) {
      continue;
    }
    const parsed = parseJsonc(readFileSync(configPath, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError(`Failed to parse ${configPath}: expected a JSON object.`);
    }
    return { configPath, config: parsed };
  }
  return undefined;
}

/** Read the last traffic attachment state Void successfully published remotely. */
export function readWranglerPublishedTrafficSnapshot(
  configPath: string,
): WranglerPublishedTrafficSnapshot | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  const encoded = PUBLISHED_TRAFFIC_MARKER.exec(readFileSync(configPath, 'utf-8'))?.[1];
  if (!encoded) {
    return undefined;
  }
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(value) ||
      typeof value.workers_dev !== 'boolean' ||
      typeof value.preview_urls !== 'boolean' ||
      !Array.isArray(value.routes)
    ) {
      return undefined;
    }
    return {
      workers_dev: value.workers_dev,
      preview_urls: value.preview_urls,
      routes: value.routes,
    };
  } catch {
    return undefined;
  }
}

/** Persist traffic attachment provenance without adding unsupported Wrangler fields. */
export function writeWranglerPublishedTrafficSnapshot(
  configPath: string,
  snapshot: WranglerPublishedTrafficSnapshot,
  options?: { create?: boolean },
): void {
  if (!existsSync(configPath)) {
    return;
  }
  const raw = readFileSync(configPath, 'utf-8');
  const encoded = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url');
  const marker = `// void:published-traffic:v1:${encoded}`;
  const existing = PUBLISHED_TRAFFIC_MARKER.exec(raw);
  if (!existing && options?.create === false) {
    return;
  }
  const next = existing
    ? raw.slice(0, existing.index) + marker + raw.slice(existing.index + existing[0].length)
    : `${marker}${raw.includes('\r\n') ? '\r\n' : '\n'}${raw}`;
  if (next !== raw) {
    writeProjectWranglerFile(configPath, next);
  }
}

export type LiveBindingConfig = {
  bindingName: string;
  className: string;
};

type DurableObjectMigration = DurableObjectMigrationStep & {
  tag?: string;
};

/** Latest compatibility date the Void test suite is pinned against. */
export const LATEST_KNOWN_COMPAT_DATE = '2026-02-24';

/** Subset of wrangler config fields we extract. */
export type WranglerCompat = {
  compatibilityDate: string;
  compatibilityFlags?: Array<string>;
};

type WranglerCompatFields = {
  voidDate: string | undefined;
  voidFlags: Array<string> | undefined;
  wranglerDate: string | undefined;
  wranglerFlags: Array<string> | undefined;
  buildDate: string | undefined;
  buildFlags: Array<string> | undefined;
};

export function normalizeWranglerCompatibilityFlags(
  flags: Array<string> | undefined,
  options?: { needsNodejsCompat?: boolean },
): Array<string> | undefined {
  const existingFlags = flags ?? [];
  if (options?.needsNodejsCompat && !existingFlags.includes(NODEJS_COMPAT_FLAG)) {
    return [...existingFlags.filter((flag) => flag !== NODEJS_ALS_FLAG), NODEJS_COMPAT_FLAG];
  }
  if (
    existingFlags.length === 0 ||
    (!existingFlags.includes(NODEJS_ALS_FLAG) && !existingFlags.includes(NODEJS_COMPAT_FLAG))
  ) {
    return [...existingFlags, NODEJS_ALS_FLAG];
  }
  return flags;
}

export function hasDurableObjectSqliteMigration(
  migrations: Array<DurableObjectMigration>,
  className: string,
): boolean {
  return migrations.some((migration) => migration.new_sqlite_classes?.includes(className));
}

export function nextDurableObjectMigrationTag(
  migrations: Array<DurableObjectMigration>,
  baseTag: string,
): string {
  const existingTags = new Set(migrations.map((migration) => migration.tag).filter(Boolean));
  if (!existingTags.has(baseTag)) {
    return baseTag;
  }
  let index = 2;
  while (existingTags.has(`${baseTag}-${index}`)) {
    index++;
  }
  return `${baseTag}-${index}`;
}

export function resolveLiveBindingConfig(
  root: string,
  options?: {
    existingBindings?: Array<{ name: string; class_name: string }>;
    reservedBindings?: Array<string | undefined>;
    reservedClasses?: Array<string | undefined>;
  },
): LiveBindingConfig {
  const durableObjectBindings = [
    ...readWranglerDurableObjectBindings(root),
    ...(options?.existingBindings ?? []),
  ];

  const generated = findGeneratedLiveBinding(durableObjectBindings);
  if (generated) {
    return { bindingName: generated.name, className: generated.class_name };
  }

  const usedBindings = new Set<string>([
    ...durableObjectBindings.map((binding) => binding.name),
    ...(options?.reservedBindings ?? []).filter((name): name is string => typeof name === 'string'),
  ]);
  const usedClasses = new Set<string>([
    ...durableObjectBindings.map((binding) => binding.class_name),
    ...(options?.reservedClasses ?? []).filter((name): name is string => typeof name === 'string'),
  ]);

  return {
    bindingName: resolveGeneratedName(DEFAULT_LIVE_BINDING, usedBindings, 'binding'),
    className: resolveGeneratedName(DEFAULT_LIVE_CLASS, usedClasses, 'class'),
  };
}

export function readExistingLiveBindingConfig(root: string): LiveBindingConfig | undefined {
  const generated = findGeneratedLiveBinding(readWranglerDurableObjectBindings(root));
  return generated ? { bindingName: generated.name, className: generated.class_name } : undefined;
}

function readWranglerDurableObjectBindings(
  root: string,
): Array<{ name: string; class_name: string }> {
  for (const path of projectWranglerPaths(root)) {
    try {
      const parsed = parseJsonc(readFileSync(path, 'utf-8'));
      const bindings = (
        parsed.durable_objects as
          | { bindings?: Array<{ name?: unknown; class_name?: unknown }> }
          | undefined
      )?.bindings;
      if (!Array.isArray(bindings)) {
        return [];
      }
      return bindings.filter(
        (binding): binding is { name: string; class_name: string } =>
          typeof binding.name === 'string' && typeof binding.class_name === 'string',
      );
    } catch {
      // Try the next wrangler config filename.
    }
  }
  return [];
}

function isGeneratedLiveName(name: string, base: string): boolean {
  return name === base || name.match(generatedLiveNamePattern(base)) !== null;
}

function generatedLiveNamePattern(base: string): RegExp {
  return new RegExp(`^${escapeRegExp(base)}_[0-9a-f]{8}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findGeneratedLiveBinding(
  bindings: Array<{ name: string; class_name: string }>,
): { name: string; class_name: string } | undefined {
  return bindings.find(
    (binding) =>
      isGeneratedLiveName(binding.name, DEFAULT_LIVE_BINDING) &&
      isGeneratedLiveName(binding.class_name, DEFAULT_LIVE_CLASS),
  );
}

function resolveGeneratedName(base: string, used: Set<string>, kind: string): string {
  if (!used.has(base)) {
    return base;
  }

  for (let attempt = 0; ; attempt++) {
    const suffix = createHash('sha256')
      .update(`void/live:${kind}:${base}:${attempt}`)
      .digest('hex')
      .slice(0, 8);
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Read compatibility settings with priority: Void config > project Wrangler config >
 * `<buildOutputDir>/wrangler.json` > latest known-good date. Read-only; use
 * `ensureWranglerCompat()` to pin the default date.
 */
export function readWranglerCompat(
  root: string,
  config?: VoidConfig,
  buildOutputDir?: string,
): WranglerCompat {
  return resolveWranglerCompat(readWranglerCompatFields(root, config, buildOutputDir));
}

/**
 * Like `readWranglerCompat()`, but pins the default date when no source sets one.
 * With `rootWrangler`, a project with no config gets the date in a root wrangler.jsonc
 * instead of a new void.config.ts, so a framework adapter that reads the root file by
 * default still finds it.
 */
export function ensureWranglerCompat(
  root: string,
  config?: VoidConfig,
  buildOutputDir?: string,
  options?: { rootWrangler?: boolean },
): WranglerCompat {
  const fields = readWranglerCompatFields(root, config, buildOutputDir);
  const hasExplicitDate = fields.voidDate ?? fields.wranglerDate ?? fields.buildDate;
  const defaultDate = hasExplicitDate
    ? undefined
    : ensureVoidCompatibilityDate(root, options?.rootWrangler === true);
  return resolveWranglerCompat(fields, defaultDate ? { defaultDate } : undefined);
}

function readWranglerCompatFields(
  root: string,
  config?: VoidConfig,
  buildOutputDir?: string,
): WranglerCompatFields {
  const voidConfig = config ?? readVoidConfigIfExists(root);

  let raw: string | undefined;
  for (const path of projectWranglerPaths(root)) {
    try {
      raw = readFileSync(path, 'utf-8');
      break;
    } catch {
      // try next
    }
  }

  let wranglerDate: string | undefined;
  let wranglerFlags: Array<string> | undefined;
  if (raw) {
    const parsed = parseJsonc(raw);
    if (typeof parsed.compatibility_date === 'string') {
      validateCompatDate(parsed.compatibility_date, 'wrangler config');
      wranglerDate = parsed.compatibility_date;
    }
    if (
      Array.isArray(parsed.compatibility_flags) &&
      parsed.compatibility_flags.every((f: unknown) => typeof f === 'string')
    ) {
      wranglerFlags = parsed.compatibility_flags;
    }
  }

  // Fallback: the build output config written by @cloudflare/vite-plugin.
  let buildDate: string | undefined;
  let buildFlags: Array<string> | undefined;
  if (buildOutputDir) {
    try {
      const buildRaw = readFileSync(join(buildOutputDir, 'wrangler.json'), 'utf-8');
      const buildParsed = JSON.parse(buildRaw);
      if (typeof buildParsed.compatibility_date === 'string') {
        validateCompatDate(buildParsed.compatibility_date, 'build output wrangler.json');
        buildDate = buildParsed.compatibility_date;
      }
      if (
        Array.isArray(buildParsed.compatibility_flags) &&
        buildParsed.compatibility_flags.every((f: unknown) => typeof f === 'string')
      ) {
        buildFlags = buildParsed.compatibility_flags;
      }
    } catch {
      // no build output wrangler.json
    }
  }

  return {
    voidDate: voidConfig?.worker?.compatibility_date,
    voidFlags: voidConfig?.worker?.compatibility_flags,
    wranglerDate,
    wranglerFlags,
    buildDate,
    buildFlags,
  };
}

function resolveWranglerCompat(
  fields: WranglerCompatFields,
  options?: { defaultDate?: string },
): WranglerCompat {
  const compatibilityDate =
    fields.voidDate ??
    fields.wranglerDate ??
    fields.buildDate ??
    options?.defaultDate ??
    LATEST_KNOWN_COMPAT_DATE;

  const result: WranglerCompat = {
    compatibilityDate,
  };

  const flags = fields.voidFlags ?? fields.wranglerFlags ?? fields.buildFlags;
  if (flags && flags.length > 0) {
    result.compatibilityFlags = flags;
  }

  return result;
}

function validateCompatDate(value: string, source: string): void {
  if (!COMPAT_DATE_RE.test(value)) {
    throw new Error(
      `config: "compatibility_date" in ${source} must use YYYY-MM-DD format, got '${value}'.`,
    );
  }
}

function readVoidConfigIfExists(root: string): VoidConfig | undefined {
  return existsSync(join(root, VOID_CONFIG_FILE)) || existsSync(join(root, TYPED_CONFIG_FILE))
    ? readConfig(root)
    : undefined;
}

function ensureVoidCompatibilityDate(root: string, rootWrangler: boolean): string {
  if (existsSync(join(root, TYPED_CONFIG_FILE))) {
    writeProvisionedWranglerConfig(root, { compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    return LATEST_KNOWN_COMPAT_DATE;
  }
  const filePath = join(root, VOID_CONFIG_FILE);
  if (!existsSync(filePath)) {
    if (existsSync(join(root, 'wrangler.toml'))) {
      // void.config.ts would point the Cloudflare plugin away from wrangler.toml and drop
      // its bindings, so keep the date in void.json.
      const pinned: VoidConfig = { worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE } };
      writeFileSync(filePath, `${JSON.stringify(pinned, null, 2)}\n`);
    } else if (rootWrangler || projectWranglerPaths(root).some((path) => existsSync(path))) {
      // A root Wrangler config cannot sit next to void.config.ts, so pin the date in it.
      writeProvisionedWranglerConfig(root, { compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    } else {
      // New projects get the date in void.config.ts, as `void init` writes it.
      writeVoidProjectConfig(root, { worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE } });
      ignoreMaterializedCloudflareConfig(root);
    }
    return LATEST_KNOWN_COMPAT_DATE;
  }

  let nextConfig: VoidConfig;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`config: ${VOID_CONFIG_FILE} must be a JSON object.`);
    }
    nextConfig = parsed as VoidConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`config: Invalid JSON in ${VOID_CONFIG_FILE}.`);
    }
    throw error;
  }

  nextConfig.worker = {
    ...(nextConfig.worker ?? {}),
    compatibility_date: LATEST_KNOWN_COMPAT_DATE,
  };
  writeFileSync(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return LATEST_KNOWN_COMPAT_DATE;
}

/**
 * Add missing inferred bindings to the project Wrangler config for local dev; existing
 * bindings are kept. Returns true if the file was written.
 */
export function syncWranglerBindings(
  root: string,
  bindings: InferredBindings,
  options?: {
    bindingNames?: { d1?: string; kv?: string; r2?: string; ai?: string };
    directCloudflareAi?: { gateway?: string };
    websockets?: Array<WebSocketRouteDefinition>;
    live?: boolean | LiveBindingConfig;
  },
): boolean {
  const { configPath, parsed, created } = readOrCreateProjectWranglerConfig(root);
  let modified = false;

  const d1Name = options?.bindingNames?.d1 ?? 'DB';
  if (bindings.needsD1) {
    const existing = (parsed.d1_databases as Array<{ binding: string }> | undefined) ?? [];
    if (!existing.some((b) => b.binding === d1Name)) {
      parsed.d1_databases = [
        ...existing,
        { binding: d1Name, database_name: 'default', database_id: 'local' },
      ];
      modified = true;
    }
  }

  const kvName = options?.bindingNames?.kv ?? 'KV';
  if (bindings.needsKV) {
    const existing = (parsed.kv_namespaces as Array<{ binding: string }> | undefined) ?? [];
    if (!existing.some((b) => b.binding === kvName)) {
      parsed.kv_namespaces = [...existing, { binding: kvName, id: 'local' }];
      modified = true;
    }
  }

  const r2Name = options?.bindingNames?.r2 ?? 'STORAGE';
  if (bindings.needsR2) {
    const existing = (parsed.r2_buckets as Array<{ binding: string }> | undefined) ?? [];
    if (!existing.some((b) => b.binding === r2Name)) {
      parsed.r2_buckets = [...existing, { binding: r2Name, bucket_name: 'default' }];
      modified = true;
    }
  }

  // Workers AI has no local simulator, so direct Cloudflare development binds it remotely.
  // Managed projects keep using Void's proxy and gain no billable binding.
  if (bindings.needsAI && options?.directCloudflareAi) {
    const existing = parsed.ai as Record<string, unknown> | undefined;
    const binding =
      typeof existing?.binding === 'string' ? existing.binding : (options.bindingNames?.ai ?? 'AI');
    const nextAi = { ...(existing ?? {}), binding, remote: true };
    if (JSON.stringify(existing) !== JSON.stringify(nextAi)) {
      parsed.ai = nextAi;
      modified = true;
    }
    if (binding !== 'AI' || options.directCloudflareAi.gateway) {
      const vars = (parsed.vars as Record<string, unknown> | undefined) ?? {};
      const nextVars = {
        ...vars,
        ...(binding !== 'AI' ? { __VOID_AI_BINDING: binding } : {}),
        ...(options.directCloudflareAi.gateway
          ? { __VOID_AI_GATEWAY: options.directCloudflareAi.gateway }
          : {}),
      };
      if (JSON.stringify(vars) !== JSON.stringify(nextVars)) {
        parsed.vars = nextVars;
        modified = true;
      }
    }
  }

  if (options?.websockets) {
    // Never remove a binding or emit `deleted_classes` for a removed route: that can break
    // the next upload or destroy the class's SQLite storage. The compiler exports a tombstone.
    const existing = durableObjectBindingsOf(parsed);
    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<DurableObjectMigration>)
      : [];
    for (const route of options.websockets) {
      const conflict = existing.find(
        (binding) => binding.name === route.bindingName && binding.class_name !== route.className,
      );
      if (conflict) {
        throw new Error(
          `websocket: binding '${route.bindingName}' is already configured for class '${conflict.class_name}', but '${route.filePath}' requires '${route.className}'.`,
        );
      }
    }
    const additions = options.websockets
      .filter((route) => !existing.some((binding) => binding.name === route.bindingName))
      .map((route) => ({ name: route.bindingName, class_name: route.className }));
    const nextBindings = [...existing, ...additions];
    if (
      nextBindings.length !== existing.length ||
      nextBindings.some(
        (binding, index) =>
          binding.name !== existing[index]?.name ||
          binding.class_name !== existing[index]?.class_name,
      )
    ) {
      parsed.durable_objects = {
        ...((parsed.durable_objects as Record<string, unknown> | undefined) ?? {}),
        bindings: nextBindings,
      };
      modified = true;
    }

    const planned = appendSqliteClassMigration(
      migrations,
      options.websockets.map((route) => route.className),
      'void-ws-v1',
      existing.map((binding) => binding.class_name),
    );
    if (planned.added) {
      parsed.migrations = planned.migrations;
      modified = true;
    }
  }

  if (bindings.needsLive || options?.live) {
    const existingDurableObjectBindings = durableObjectBindingsOf(parsed);
    const liveConfig =
      typeof options?.live === 'object'
        ? options.live
        : resolveLiveBindingConfig(root, {
            existingBindings: existingDurableObjectBindings,
            reservedBindings: options?.websockets?.map((route) => route.bindingName),
            reservedClasses: options?.websockets?.map((route) => route.className),
          });
    if (!existingDurableObjectBindings.some((binding) => binding.name === liveConfig.bindingName)) {
      parsed.durable_objects = {
        bindings: [
          ...existingDurableObjectBindings,
          {
            name: liveConfig.bindingName,
            class_name: liveConfig.className,
          },
        ],
      };
      modified = true;
    }

    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<DurableObjectMigration>)
      : [];
    const hasMigration = hasDurableObjectSqliteMigration(migrations, liveConfig.className);
    if (!hasMigration) {
      parsed.migrations = [
        ...migrations,
        {
          tag: nextDurableObjectMigrationTag(migrations, LIVE_MIGRATION_TAG),
          new_sqlite_classes: [liveConfig.className],
        },
      ];
      modified = true;
    }
  }

  if (created || modified) {
    writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
  }

  return created || modified;
}

/** Persist convention-derived Durable Object bindings and append-only migration history. */
export function syncWranglerDurableObjects(
  root: string,
  durableObjects: Array<DurableObjectModule>,
): boolean {
  if (durableObjects.length === 0) {
    return false;
  }
  const { configPath, parsed, created } = readOrCreateProjectWranglerConfig(root);
  let modified = false;

  const existingBindings = durableObjectBindingsOf(parsed);
  for (const module of durableObjects) {
    const conflict = existingBindings.find(
      (binding) => binding.name === module.bindingName && binding.class_name !== module.className,
    );
    if (conflict) {
      throw new Error(
        `durable: binding '${module.bindingName}' is already configured for class '${conflict.class_name}', but durable-objects/ requires '${module.className}'.`,
      );
    }
  }
  const additions = durableObjects
    .filter((module) => !existingBindings.some((binding) => binding.name === module.bindingName))
    .map((module) => ({ name: module.bindingName, class_name: module.className }));
  if (additions.length > 0) {
    parsed.durable_objects = { bindings: [...existingBindings, ...additions] };
    modified = true;
  }

  const migrations = Array.isArray(parsed.migrations)
    ? (parsed.migrations as Array<DurableObjectMigration>)
    : [];
  for (const module of durableObjects) {
    const tagConflict = migrations.find(
      (migration) =>
        migration.tag === module.migrationTag &&
        !migration.new_sqlite_classes?.includes(module.className),
    );
    if (tagConflict) {
      throw new Error(
        `durable: migration tag '${module.migrationTag}' is already used by another Durable Object migration.`,
      );
    }
    if (!hasDurableObjectSqliteMigration(migrations, module.className)) {
      migrations.push({
        tag: module.migrationTag,
        new_sqlite_classes: [module.className],
      });
      modified = true;
    }
  }
  if (modified) {
    parsed.migrations = migrations;
  }

  if (created || modified) {
    writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
  }
  return created || modified;
}

/** Persist WebSocket Durable Object bindings and SQLite migration history. */
export function syncWranglerWebSockets(
  root: string,
  websockets: Array<WebSocketRouteDefinition>,
): boolean {
  if (websockets.length === 0 && !projectWranglerPaths(root).some((path) => existsSync(path))) {
    return false;
  }
  return writeProvisionedWranglerConfig(root, { webSockets: websockets }).modified;
}

/**
 * Registered WebSocket classes without a source route. They stay exported while their
 * bindings remain; only classes created by Void's WebSocket migration tag count.
 */
export function readWranglerWebSocketTombstones(
  root: string,
  websockets: Array<WebSocketRouteDefinition>,
): Array<string> {
  const configPath = projectWranglerPaths(root).find((path) => existsSync(path));
  if (!configPath) {
    return [];
  }
  const parsed = parseJsonc(readFileSync(configPath, 'utf-8'));
  const migrations = Array.isArray(parsed.migrations)
    ? (parsed.migrations as Array<DurableObjectMigration>)
    : [];
  const historicalClasses = new Set(
    migrations.flatMap((migration) =>
      /^void-ws-v1(?:-\d+)?$/.test(migration.tag ?? '')
        ? [...(migration.new_classes ?? []), ...(migration.new_sqlite_classes ?? [])]
        : [],
    ),
  );
  const currentClasses = new Set(websockets.map((route) => route.className));
  const bindings = (
    parsed.durable_objects as { bindings?: Array<{ class_name?: unknown }> } | undefined
  )?.bindings;
  return [
    ...new Set(
      (Array.isArray(bindings) ? bindings : []).flatMap((binding) =>
        typeof binding.class_name === 'string' &&
        historicalClasses.has(binding.class_name) &&
        !currentClasses.has(binding.class_name)
          ? [binding.class_name]
          : [],
      ),
    ),
  ].sort();
}

/** Write the resolved compatibility date for frameworks that read the Wrangler config. */
export function ensureWranglerCompatibilityDate(root: string, compatibilityDate: string): boolean {
  const { configPath, parsed } = readOrCreateProjectWranglerConfig(root);
  if (parsed.compatibility_date === compatibilityDate) {
    return false;
  }

  parsed.compatibility_date = compatibilityDate;
  writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
  return true;
}

/** Add the `nodejs_als` compatibility flag. Returns true if the file was written. */
export function ensureWranglerNodejsAlsFlag(root: string): boolean {
  const { configPath, parsed } = readOrCreateProjectWranglerConfig(root);
  const compatibilityFlags = Array.isArray(parsed.compatibility_flags)
    ? (parsed.compatibility_flags as Array<unknown>)
    : [];
  if (compatibilityFlags.includes(NODEJS_ALS_FLAG)) {
    return false;
  }

  parsed.compatibility_flags = [...compatibilityFlags, NODEJS_ALS_FLAG];
  writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
  return true;
}

/** A Wrangler `queues.producers[]` entry. */
export type WranglerQueueProducer = {
  queue: string;
  binding: string;
};

/** A Wrangler `queues.consumers[]` entry, as Void's queue scanner emits it. */
export type WranglerQueueConsumer = {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  retry_delay?: number;
};

/**
 * Root Wrangler config fields that Cloudflare's create commands do not write.
 *
 * Pass `queues` for framework self-host builds only. A native Void build already emits
 * scanner queues, and the Cloudflare plugin concatenates arrays, so they would duplicate.
 */
export type ProvisionedWranglerPatch = {
  /** Cloudflare account id → top-level `account_id` (always overwritten). */
  accountId?: string;
  /** Worker name → top-level `name` (only written when absent). */
  name?: string;
  /** Compatibility date → top-level `compatibility_date` (only written when absent). */
  compatibilityDate?: string;
  /** Compatibility flags to add without removing existing flags. */
  compatibilityFlags?: Array<string>;
  /** Fills `migrations_dir` on the existing `d1_databases[]` entry with this binding. */
  d1MigrationsDir?: { binding: string; dir: string };
  /**
   * Adopt an existing resource: upsert its id/name into the entry keyed by `binding`,
   * creating the entry when absent. Create commands cannot write the id of a resource
   * that already exists.
   */
  d1?: { binding: string; databaseName: string; databaseId: string };
  kv?: { binding: string; id: string };
  r2?: { binding: string; bucketName: string };
  hyperdrive?: { binding: string; id: string };
  /** Persist WebSocket bindings and append-only Durable Object migration history. */
  webSockets?: Array<Pick<WebSocketRouteDefinition, 'bindingName' | 'className' | 'filePath'>>;
  /**
   * Producers are keyed by `binding` (several producers may target one queue); consumers
   * by `queue` (one consumer per queue). Framework self-host only; see above.
   */
  queues?: {
    producers?: Array<WranglerQueueProducer>;
    consumers?: Array<WranglerQueueConsumer>;
    /** Remove only stale entries carrying explicit Void-managed provenance. */
    reconcileVoidOwned?: boolean;
  };
  /** Upserts `{ name }` into `send_email[]`; an existing entry's destinations are user-owned. */
  sendEmail?: { name: string };
  /**
   * Email Routing `addresses`, owned by Void as a whole array. `null` deletes the key:
   * an empty array would delete every routing rule.
   */
  addresses?: Array<string> | null;
  /** `vars` to upsert by key; other keys are left as they are. */
  vars?: Record<string, string>;
};

type ManagedQueueProvenance = {
  producerBindings: Array<string>;
  consumerQueues: Array<string>;
  /** Void-owned consumers removed locally but not yet confirmed removed remotely. */
  pendingConsumerRemovals: Array<string>;
};

function readManagedQueueProvenance(text: string): ManagedQueueProvenance {
  const none: ManagedQueueProvenance = {
    producerBindings: [],
    consumerQueues: [],
    pendingConsumerRemovals: [],
  };
  const encoded = MANAGED_QUEUES_MARKER.exec(text)?.[1];
  if (!encoded) {
    return none;
  }
  const strings = (value: unknown): Array<string> =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed)) {
      return none;
    }
    return {
      producerBindings: strings(parsed.producerBindings),
      consumerQueues: strings(parsed.consumerQueues),
      pendingConsumerRemovals: strings(parsed.pendingConsumerRemovals),
    };
  } catch {
    // A malformed marker proves no ownership. Fail safe by retaining every entry.
    return none;
  }
}

function writeManagedQueueProvenance(text: string, provenance: ManagedQueueProvenance): string {
  const normalized: ManagedQueueProvenance = {
    producerBindings: [...new Set(provenance.producerBindings)].sort(),
    consumerQueues: [...new Set(provenance.consumerQueues)].sort(),
    pendingConsumerRemovals: [...new Set(provenance.pendingConsumerRemovals)].sort(),
  };
  const existing = MANAGED_QUEUES_MARKER.exec(text);
  if (
    normalized.producerBindings.length === 0 &&
    normalized.consumerQueues.length === 0 &&
    normalized.pendingConsumerRemovals.length === 0
  ) {
    if (!existing) {
      return text;
    }
    const start = existing.index;
    const end = start + existing[0].length;
    const trailingNewline = text.slice(end).match(/^(\r?\n)/)?.[1] ?? '';
    return text.slice(0, start) + text.slice(end + trailingNewline.length);
  }
  const encoded = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  const marker = `// void:managed-queues:v1:${encoded}`;
  if (existing) {
    return text.slice(0, existing.index) + marker + text.slice(existing.index + existing[0].length);
  }
  return `${marker}${text.includes('\r\n') ? '\r\n' : '\n'}${text}`;
}

/**
 * Void-owned consumer queues that may need remote cleanup: current managed consumers (the
 * caller subtracts desired ones) and pending removals, which survive failed deploys.
 */
export function readWranglerManagedQueueCleanupCandidates(configPath: string): Array<string> {
  if (!existsSync(configPath)) {
    return [];
  }
  const raw = readFileSync(configPath, 'utf-8');
  const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const provenance = readManagedQueueProvenance(text);
  return [...new Set([...provenance.consumerQueues, ...provenance.pendingConsumerRemovals])].sort();
}

/** Clear only cleanup tombstones confirmed by a successful trigger reconciliation. */
export function acknowledgeWranglerManagedQueueRemovals(
  configPath: string,
  removedQueues: ReadonlyArray<string>,
): void {
  if (!existsSync(configPath) || removedQueues.length === 0) {
    return;
  }
  const raw = readFileSync(configPath, 'utf-8');
  const hasBom = raw.startsWith(UTF8_BOM);
  const text = hasBom ? raw.slice(UTF8_BOM.length) : raw;
  const provenance = readManagedQueueProvenance(text);
  const removed = new Set(removedQueues);
  const updated = writeManagedQueueProvenance(text, {
    ...provenance,
    pendingConsumerRemovals: provenance.pendingConsumerRemovals.filter(
      (queue) => !removed.has(queue),
    ),
  });
  const finalText = hasBom ? `${UTF8_BOM}${updated}` : updated;
  if (finalText !== raw) {
    writeProjectWranglerFile(configPath, finalText);
  }
}

export type WriteProvisionedWranglerResult = {
  /** Absolute path of the config file that was operated on. */
  configPath: string;
  /** True when the file content changed (or a new file was created). */
  modified: boolean;
  /** True when `d1MigrationsDir` named a binding with no `d1_databases[]` entry yet. */
  d1MigrationsDirSkipped: boolean;
};

/**
 * Apply a {@link ProvisionedWranglerPatch} to the root Wrangler config. Edits keep comments
 * and unrelated content, and a second run produces the same bytes.
 */
export function writeProvisionedWranglerConfig(
  root: string,
  patch: ProvisionedWranglerPatch,
  options?: { configPath?: string },
): WriteProvisionedWranglerResult {
  const configPath = options?.configPath ?? discoverWranglerConfigPath(root);

  // Wrangler strips a leading BOM before parsing. Strip it for editing and restore it on write.
  const rawContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
  const hasBom = rawContent.startsWith(UTF8_BOM);
  const original = hasBom ? rawContent.slice(UTF8_BOM.length) : rawContent;

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(original);
  } catch (error) {
    // Never treat an unparseable config as `{}`: the only-if-absent upserts would clobber it.
    throw new Error(
      `deploy: cannot update "${configPath}" — it is not valid JSON/JSONC. ` +
        `Fix the file and retry. (${(error as Error).message})`,
    );
  }

  // With a duplicate key, `parse()` reads the last member (as Wrangler does) but `modify()`
  // edits the first, so an upsert would silently not apply.
  assertNoDuplicateMembers(original, configPath);

  const formattingOptions = detectFormattingOptions(original);
  let text = original;
  // Paths overwritten with a scalar. If one held an object/array, `modify()` dropped its
  // nested comments; the final comment gate uses these paths to name the field.
  const scalarSetPaths: Array<Array<string | number>> = [];
  const set = (path: Array<string | number>, value: unknown): void => {
    scalarSetPaths.push(path);
    text = applyMemberEdit(text, path, value, { formattingOptions });
  };

  // Always overwrite account_id so a re-resolve can correct a stale value.
  if (patch.accountId !== undefined) {
    set(['account_id'], patch.accountId);
  }

  if (patch.name !== undefined && parsed.name === undefined) {
    set(['name'], patch.name);
  }
  if (patch.compatibilityDate !== undefined && parsed.compatibility_date === undefined) {
    set(['compatibility_date'], patch.compatibilityDate);
  }
  if (patch.compatibilityFlags !== undefined) {
    const existingFlags = parsed.compatibility_flags;
    if (
      existingFlags !== undefined &&
      (!Array.isArray(existingFlags) ||
        !existingFlags.every((flag): flag is string => typeof flag === 'string'))
    ) {
      throw new Error(
        `deploy: cannot update "${configPath}" — "compatibility_flags" must be an array of strings.`,
      );
    }
    const flags = existingFlags ?? [];
    for (const flag of patch.compatibilityFlags) {
      if (!flags.includes(flag)) {
        text = applyMemberEdit(text, ['compatibility_flags', flags.length], flag, {
          formattingOptions,
          isArrayInsertion: true,
        });
        flags.push(flag);
      }
    }
  }

  // Binding name -> owner label for the producer guard, built from the current text on first use.
  let workerBindingOwners: Map<string, string> | undefined;

  if (patch.webSockets && patch.webSockets.length > 0) {
    const requested = new Map<string, (typeof patch.webSockets)[number]>();
    for (const route of patch.webSockets) {
      const existing = requested.get(route.bindingName);
      if (existing && existing.className !== route.className) {
        throw new Error(
          `websocket: binding '${route.bindingName}' resolves to both '${existing.className}' and '${route.className}'. Rename one of the route files.`,
        );
      }
      requested.set(route.bindingName, route);
    }

    const initialConfig = parseJsonc(text);
    const initialBindings = bindingEntriesForField(
      'durable_objects',
      initialConfig.durable_objects,
    );
    const knownExistingClasses = initialBindings.map(({ entry }, index) => {
      if (typeof entry.class_name !== 'string' || entry.class_name.length === 0) {
        throw new Error(
          `deploy: cannot update "${configPath}" — "durable_objects.bindings" entry at index ${index} is missing a non-empty string "class_name".`,
        );
      }
      return entry.class_name;
    });

    for (const route of requested.values()) {
      const currentConfig = parseJsonc(text);
      const durableObjectBindings = bindingEntriesForField(
        'durable_objects',
        currentConfig.durable_objects,
      );
      const matches = durableObjectBindings.filter(({ name }) => name === route.bindingName);
      if (matches.length > 1) {
        throw new Error(
          `deploy: cannot update "${configPath}" — Durable Object binding '${route.bindingName}' is declared more than once.`,
        );
      }
      if (matches.length === 1) {
        const entry = matches[0].entry;
        if (
          entry.class_name !== route.className ||
          entry.script_name !== undefined ||
          entry.environment !== undefined
        ) {
          throw new Error(
            `websocket: binding '${route.bindingName}' is already configured for another class, script, or environment, but '${route.filePath}' requires the local class '${route.className}'.`,
          );
        }
        continue;
      }

      const owners = collectWorkerBindingNames(
        configWithoutField(currentConfig, 'durable_objects'),
      );
      addQueueProducerOwners(owners, currentConfig);
      const owner = owners.get(route.bindingName);
      if (owner) {
        throw new Error(
          `deploy: cannot update "${configPath}" — WebSocket binding '${route.bindingName}' is already used by a ${owner} binding.`,
        );
      }
      text = applyMemberEdit(
        text,
        ['durable_objects', 'bindings', durableObjectBindings.length],
        { name: route.bindingName, class_name: route.className },
        { formattingOptions, isArrayInsertion: true },
      );
    }

    const currentConfig = parseJsonc(text);
    const rawMigrations = currentConfig.migrations;
    const migrations = validateDurableObjectMigrations(rawMigrations, configPath);
    const planned = appendSqliteClassMigration(
      migrations,
      [...requested.values()].map((route) => route.className),
      'void-ws-v1',
      knownExistingClasses,
    );
    if (planned.added) {
      text = applyMemberEdit(
        text,
        ['migrations', migrations.length],
        planned.migrations[planned.migrations.length - 1],
        { formattingOptions, isArrayInsertion: true },
      );
    }
  }

  // Upsert the supplied properties into the entry keyed by `identityKey`, or append one.
  // Runs before migrations_dir so a D1 entry created here is matched there.
  const upsertAdoptedBinding = (
    field: string,
    binding: string,
    properties: Record<string, string>,
    identityKey: 'binding' | 'name' = 'binding',
  ): void => {
    // Re-parse so an adopt earlier in this call is seen.
    const currentConfig = parseJsonc(text);
    const rawList = currentConfig[field];
    // The owner collector below excludes this field, so validate its shape here.
    bindingNamesForField(field, rawList);
    const currentList = Array.isArray(rawList) ? [...rawList] : [];
    const matches: Array<{ index: number; entry: Record<string, unknown> }> = [];
    for (let i = 0; i < currentList.length; i++) {
      const entry = currentList[i];
      if (isRecord(entry) && entry[identityKey] === binding) {
        matches.push({ index: i, entry });
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `deploy: cannot update "${configPath}" — binding ${JSON.stringify(binding)} is declared ` +
          `${matches.length} times in "${field}". Void cannot choose which entry to update, and ` +
          `wrangler rejects duplicate binding names. Remove the duplicate and retry.`,
      );
    }
    // A name shared with another binding type is undeployable, whether this entry is new or not.
    const owners = collectWorkerBindingNames(configWithoutField(currentConfig, field));
    addQueueProducerOwners(owners, currentConfig);
    const owner = owners.get(binding);
    if (owner !== undefined) {
      throw new Error(
        `deploy: cannot update "${configPath}" — cannot adopt ${JSON.stringify(binding)} into ` +
          `"${field}" because that binding name is already used by a ${owner} binding. Wrangler ` +
          `requires every binding name to be unique across the whole worker, so this would make ` +
          `the config undeployable. Rename the conflicting binding and retry.`,
      );
    }
    if (matches.length === 1) {
      const { index, entry: existing } = matches[0];
      for (const [key, value] of Object.entries(properties)) {
        if (!isDeepStrictEqual(existing[key], value)) {
          set([field, index, key], value);
        }
      }
    } else {
      text = applyMemberEdit(
        text,
        [field, currentList.length],
        { [identityKey]: binding, ...properties },
        {
          formattingOptions,
          isArrayInsertion: true,
        },
      );
    }
  };
  if (patch.d1) {
    upsertAdoptedBinding('d1_databases', patch.d1.binding, {
      database_name: patch.d1.databaseName,
      database_id: patch.d1.databaseId,
    });
  }
  if (patch.kv) {
    upsertAdoptedBinding('kv_namespaces', patch.kv.binding, { id: patch.kv.id });
  }
  if (patch.r2) {
    upsertAdoptedBinding('r2_buckets', patch.r2.binding, { bucket_name: patch.r2.bucketName });
  }
  if (patch.hyperdrive) {
    upsertAdoptedBinding('hyperdrive', patch.hyperdrive.binding, { id: patch.hyperdrive.id });
  }
  if (patch.sendEmail) {
    upsertAdoptedBinding('send_email', patch.sendEmail.name, {}, 'name');
  }

  let d1MigrationsDirSkipped = false;
  if (patch.d1MigrationsDir) {
    const currentD1 = parseJsonc(text).d1_databases;
    const d1Entries = Array.isArray(currentD1)
      ? (currentD1 as Array<{
          binding?: unknown;
          migrations_dir?: unknown;
          migrations_pattern?: unknown;
        }>)
      : [];
    const matchIndices: Array<number> = [];
    d1Entries.forEach((entry, i) => {
      if (entry.binding === patch.d1MigrationsDir!.binding) {
        matchIndices.push(i);
      }
    });
    if (matchIndices.length > 1) {
      throw new Error(
        `deploy: cannot update "${configPath}" — binding ` +
          `${JSON.stringify(patch.d1MigrationsDir.binding)} is declared ${matchIndices.length} times ` +
          `in "d1_databases". A binding name must be unique across the worker (wrangler rejects the ` +
          `config otherwise), so migrations_dir cannot be attached unambiguously. Remove the ` +
          `duplicate D1 entry and retry.`,
      );
    }
    const index = matchIndices.length === 1 ? matchIndices[0] : -1;
    if (index >= 0) {
      const existingPattern = d1Entries[index].migrations_pattern;
      if (existingPattern !== undefined && typeof existingPattern !== 'string') {
        throw new Error(
          `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
            `${JSON.stringify(patch.d1MigrationsDir.binding)} has a non-string ` +
            `"migrations_pattern" value; expected a string. Wrangler rejects such a config, so ` +
            `filling "migrations_dir" beside it would commit an invalid file. Fix the config ` +
            `and retry.`,
        );
      }
      // Once set, `migrations_dir` is user-owned: rewriting it would strand their migrations.
      const existingDir = d1Entries[index].migrations_dir;
      if (existingDir !== undefined && typeof existingDir !== 'string') {
        throw new Error(
          `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
            `${JSON.stringify(patch.d1MigrationsDir.binding)} has a non-string ` +
            `"migrations_dir" value; expected a string. Fix the config and retry.`,
        );
      }
      if (typeof existingDir === 'string') {
        if (!sameMigrationsDir(configPath, existingDir, patch.d1MigrationsDir.dir)) {
          throw new Error(
            `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
              `${JSON.stringify(patch.d1MigrationsDir.binding)} already sets "migrations_dir": ` +
              `${JSON.stringify(existingDir)}, but Void keeps this database's migrations in ` +
              `${JSON.stringify(patch.d1MigrationsDir.dir)}. Refusing to overwrite an explicit ` +
              `different migrations directory. Either remove "migrations_dir" from the entry (or ` +
              `set it to ${JSON.stringify(patch.d1MigrationsDir.dir)}) to let Void manage it, or ` +
              `move the migrations and keep your directory, then retry.`,
          );
        }
        // An equivalent spelling (`./db/migrations`, a trailing slash, an absolute path) is
        // kept as written.
      } else {
        if (
          existingPattern !== undefined &&
          !migrationsPatternMatchesDir(existingPattern, patch.d1MigrationsDir.dir)
        ) {
          throw new Error(
            `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
              `${JSON.stringify(patch.d1MigrationsDir.binding)} has "migrations_pattern": ` +
              `${JSON.stringify(existingPattern)}, which is not under the requested ` +
              `"migrations_dir": ${JSON.stringify(patch.d1MigrationsDir.dir)}. Wrangler requires the ` +
              `pattern to start with the migrations dir, so this change would break ` +
              `\`wrangler d1 migrations\`. Align "migrations_pattern" with the dir (or remove it) and retry.`,
          );
        }
        set(['d1_databases', index, 'migrations_dir'], patch.d1MigrationsDir.dir);
      }
    } else {
      d1MigrationsDirSkipped = true;
    }
  }

  const reconcileManagedQueues = patch.queues?.reconcileVoidOwned === true;
  const managedQueueProvenance = readManagedQueueProvenance(text);
  const managedProducerBindings = new Set(managedQueueProvenance.producerBindings);
  const managedConsumerQueues = new Set(managedQueueProvenance.consumerQueues);
  const pendingConsumerRemovals = new Set(managedQueueProvenance.pendingConsumerRemovals);
  const upsertQueueEntries = (
    section: 'producers' | 'consumers',
    entries: Array<Record<string, unknown>> | undefined,
  ): void => {
    if (!entries || entries.length === 0) {
      return;
    }
    // Re-parse so earlier edits are seen; appends are tracked locally to keep indices valid.
    const currentQueues = assertObjectContainer(parseJsonc(text).queues, 'queues');
    const currentList =
      section === 'producers'
        ? assertValidQueueProducers(currentQueues?.producers)
        : Array.isArray(currentQueues?.consumers)
          ? [...(currentQueues.consumers as Array<Record<string, unknown>>)]
          : [];
    for (const entry of entries) {
      // A producer binding maps to exactly one queue, so every producer with the binding is
      // checked: none appends, one must name the same queue, more than one fails closed.
      let index: number;
      if (section === 'producers') {
        const matches: Array<number> = [];
        for (let i = 0; i < currentList.length; i++) {
          const existing = currentList[i];
          if (existing.binding === entry.binding) {
            matches.push(i);
          }
        }
        if (matches.length > 1) {
          throw new Error(
            `deploy: cannot update "${configPath}" — queue producer binding ` +
              `${JSON.stringify(entry.binding)} is declared ${matches.length} times across ` +
              `producers. A producer binding must map to exactly one queue, so wrangler rejects ` +
              `this config. Remove the duplicate producers and retry.`,
          );
        }
        // A producer Void wrote earlier may move to the queue's new name; the update below
        // rewrites its `queue` in place.
        const voidOwned =
          reconcileManagedQueues && managedProducerBindings.has(String(entry.binding));
        if (matches.length === 1) {
          const existing = currentList[matches[0]];
          if (existing.queue !== entry.queue && !voidOwned) {
            throw new Error(
              `deploy: cannot update "${configPath}" — queue producer binding ` +
                `${JSON.stringify(entry.binding)} is already bound to queue ` +
                `${JSON.stringify(existing.queue)}, but queue ${JSON.stringify(entry.queue)} also ` +
                `requests it. A producer binding must map to exactly one queue. Rename or remove ` +
                `the conflicting producer and retry.`,
            );
          }
        }
        index = matches.length === 1 ? matches[0] : -1;
        // Check matched producers too: a cross-type collision is undeployable either way.
        workerBindingOwners ??= collectWorkerBindingNames(parseJsonc(text));
        const bindingName = String(entry.binding);
        const owner = workerBindingOwners.get(bindingName);
        if (owner !== undefined) {
          throw new Error(
            `deploy: cannot update "${configPath}" — queue producer binding ` +
              `${JSON.stringify(bindingName)} is already used by a ${owner} binding. Wrangler ` +
              `requires every binding name to be unique across the whole worker, so this producer ` +
              `would make the config undeployable. Rename the conflicting binding (or the queue) ` +
              `and retry.`,
          );
        }
      } else {
        index = currentList.findIndex(
          (existing) => isRecord(existing) && existing.queue === entry.queue,
        );
      }

      if (index >= 0) {
        // Set only the supplied properties: replacing the element would drop comments and
        // user-tuned fields such as `dead_letter_queue`.
        const existing = currentList[index];
        for (const [key, value] of Object.entries(entry)) {
          if (value === undefined) {
            continue;
          }
          if (!isDeepStrictEqual(existing[key], value)) {
            set(['queues', section, index, key], value);
          }
        }
        currentList[index] = { ...existing, ...entry };
      } else {
        text = applyMemberEdit(text, ['queues', section, currentList.length], entry, {
          formattingOptions,
          isArrayInsertion: true,
        });
        currentList.push(entry);
        if (reconcileManagedQueues) {
          if (section === 'producers' && typeof entry.binding === 'string') {
            managedProducerBindings.add(entry.binding);
          } else if (section === 'consumers' && typeof entry.queue === 'string') {
            managedConsumerQueues.add(entry.queue);
          }
        }
      }
    }
  };
  if (patch.queues) {
    if (patch.queues.reconcileVoidOwned) {
      const queues = assertObjectContainer(parseJsonc(text).queues, 'queues');
      assertValidQueueProducers(queues?.producers);
      const producers = Array.isArray(queues?.producers)
        ? (queues.producers as Array<Record<string, unknown>>)
        : [];
      const desiredBindings = new Set(
        (patch.queues.producers ?? []).map((producer) => producer.binding),
      );
      const staleProducerIndexes: Array<number> = [];
      for (let index = 0; index < producers.length; index++) {
        const producer = producers[index];
        if (
          typeof producer.binding === 'string' &&
          managedProducerBindings.has(producer.binding) &&
          !desiredBindings.has(producer.binding)
        ) {
          staleProducerIndexes.push(index);
          managedProducerBindings.delete(producer.binding);
        }
      }
      for (const index of staleProducerIndexes.reverse()) {
        set(['queues', 'producers', index], undefined);
      }

      const consumers = Array.isArray(queues?.consumers)
        ? (queues.consumers as Array<Record<string, unknown>>)
        : [];
      const desiredConsumerQueues = new Set(
        (patch.queues.consumers ?? []).map((consumer) => consumer.queue),
      );
      const staleConsumerIndexes = consumers.flatMap((consumer, index) => {
        if (
          typeof consumer.queue === 'string' &&
          managedConsumerQueues.has(consumer.queue) &&
          !desiredConsumerQueues.has(consumer.queue)
        ) {
          managedConsumerQueues.delete(consumer.queue);
          pendingConsumerRemovals.add(consumer.queue);
          return [index];
        }
        return [];
      });
      for (const index of staleConsumerIndexes.reverse()) {
        set(['queues', 'consumers', index], undefined);
      }
    }
    upsertQueueEntries('producers', patch.queues.producers);
    upsertQueueEntries('consumers', patch.queues.consumers);
    for (const consumer of patch.queues.consumers ?? []) {
      pendingConsumerRemovals.delete(consumer.queue);
    }
  }

  // A var name is also a binding name, so it must not collide with another binding type.
  if (patch.vars) {
    const currentConfig = parseJsonc(text);
    bindingNamesForField('vars', currentConfig.vars);
    const currentVars = isRecord(currentConfig.vars) ? currentConfig.vars : {};
    const owners = collectWorkerBindingNames(configWithoutField(currentConfig, 'vars'));
    addQueueProducerOwners(owners, currentConfig);
    for (const [key, value] of Object.entries(patch.vars)) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `deploy: cannot update "${configPath}" — cannot write var ${JSON.stringify(key)} because ` +
            `that binding name is already used by a ${owner} binding. Wrangler requires every ` +
            `binding name to be unique across the whole worker, so this would make the config ` +
            `undeployable. Rename the conflicting binding and retry.`,
        );
      }
      if (!isDeepStrictEqual(currentVars[key], value)) {
        set(['vars', key], value);
      }
    }
  }

  // `addresses` skips `set()`: it is composite by design, so the final gate's "expected a
  // string" diagnosis would be wrong. A dropped nested comment still fails that gate.
  if (patch.addresses !== undefined) {
    const currentAddresses = parseJsonc(text).addresses;
    if (patch.addresses === null) {
      text = removeMember(text, ['addresses'], { formattingOptions });
    } else if (!isDeepStrictEqual(currentAddresses, patch.addresses)) {
      text = applyMemberEdit(text, ['addresses'], patch.addresses, { formattingOptions });
    }
  }

  // Every comment's text must survive (relocation only moves it). Refuse to write otherwise.
  const droppedComment = findDroppedComment(
    extractCommentTokens(original),
    extractCommentTokens(text),
  );
  if (droppedComment !== undefined) {
    const originalRoot = parseTree(original, undefined, { allowTrailingComma: true });
    const compositeField = originalRoot
      ? scalarSetPaths.find((path) => {
          const node = findNodeAtLocation(originalRoot, path);
          return node?.type === 'object' || node?.type === 'array';
        })
      : undefined;
    if (compositeField) {
      const field = String(compositeField[compositeField.length - 1]);
      throw new Error(
        `deploy: cannot update "${configPath}" — "${field}" has an object/array value; ` +
          `expected a string. Fix the config and retry.`,
      );
    }
    throw new Error(
      `deploy: cannot update "${configPath}" — this edit would drop a comment ` +
        `(${droppedComment}); the writer refuses to corrupt the file — simplify the ` +
        `surrounding structure and retry.`,
    );
  }

  if (reconcileManagedQueues) {
    const finalQueues = assertObjectContainer(parseJsonc(text).queues, 'queues');
    const finalProducerBindings = new Set(
      (Array.isArray(finalQueues?.producers) ? finalQueues.producers : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.binding === 'string' ? [entry.binding] : [],
      ),
    );
    const finalConsumerQueues = new Set(
      (Array.isArray(finalQueues?.consumers) ? finalQueues.consumers : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.queue === 'string' ? [entry.queue] : [],
      ),
    );
    text = writeManagedQueueProvenance(text, {
      producerBindings: [...managedProducerBindings].filter((binding) =>
        finalProducerBindings.has(binding),
      ),
      consumerQueues: [...managedConsumerQueues].filter((queue) => finalConsumerQueues.has(queue)),
      pendingConsumerRemovals: [...pendingConsumerRemovals],
    });
  }

  const finalText = hasBom ? `${UTF8_BOM}${text}` : text;
  const modified = finalText !== rawContent;
  if (modified) {
    writeProjectWranglerFile(configPath, finalText);
  }
  return { configPath, modified, d1MigrationsDirSkipped };
}

/** Read the custom-domain routes owned by the root Wrangler config. */
export function readWranglerCustomDomains(root: string): WranglerCustomDomainUpdate {
  const configPath = discoverWranglerConfigPath(root);
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
  const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const parsed = parseJsonc(text);
  assertNoDuplicateMembers(text, configPath);
  return {
    configPath,
    domains: parseCustomDomains(parsed.routes, configPath),
    modified: false,
  };
}

/**
 * Add or remove one Wrangler `custom_domain` route without rewriting unrelated
 * configuration. The returned domain list is the post-edit source of truth used
 * by `void domain list|status` on direct Cloudflare projects.
 */
export function updateWranglerCustomDomain(
  root: string,
  hostname: string,
  action: 'add' | 'delete',
): WranglerCustomDomainUpdate {
  const configPath = discoverWranglerConfigPath(root);
  if (!existsSync(configPath)) {
    throw new Error(
      `domain: No Wrangler config found at "${configPath}". Run \`void init\` first.`,
    );
  }
  const raw = readFileSync(configPath, 'utf-8');
  const hasBom = raw.startsWith(UTF8_BOM);
  const original = hasBom ? raw.slice(UTF8_BOM.length) : raw;
  const parsed = parseJsonc(original);
  assertNoDuplicateMembers(original, configPath);
  if (parsed.route !== undefined) {
    throw new Error(
      `domain: "${configPath}" uses the singular "route" field. Convert it to a "routes" array before managing custom domains so the existing route cannot be shadowed.`,
    );
  }
  const routes = parsed.routes;
  if (routes !== undefined && !Array.isArray(routes)) {
    throw new Error(`domain: "routes" in "${configPath}" must be an array.`);
  }
  const routeArray = (routes ?? []) as Array<unknown>;
  const matches: Array<number> = [];
  for (let index = 0; index < routeArray.length; index++) {
    const route = routeArray[index];
    if (typeof route === 'string') {
      if (route === hostname) {
        throw new Error(
          `domain: ${JSON.stringify(hostname)} already exists as a non-custom route in "${configPath}". Remove or convert that route first.`,
        );
      }
      continue;
    }
    if (typeof route !== 'object' || route === null || Array.isArray(route)) {
      throw new Error(`domain: "routes[${index}]" in "${configPath}" is malformed.`);
    }
    const entry = route as Record<string, unknown>;
    if (entry.pattern !== hostname) {
      continue;
    }
    if (entry.custom_domain !== true) {
      throw new Error(
        `domain: ${JSON.stringify(hostname)} already exists as a non-custom route in "${configPath}". Remove or convert that route first.`,
      );
    }
    matches.push(index);
  }
  if (matches.length > 1) {
    throw new Error(
      `domain: ${JSON.stringify(hostname)} is declared more than once in "${configPath}". Remove the duplicate before continuing.`,
    );
  }

  let text = original;
  const formattingOptions = detectFormattingOptions(original);
  if (action === 'add' && matches.length === 0) {
    text = applyMemberEdit(
      text,
      ['routes', routeArray.length],
      { pattern: hostname, custom_domain: true },
      { formattingOptions, isArrayInsertion: true },
    );
    const dropped = findDroppedComment(extractCommentTokens(original), extractCommentTokens(text));
    if (dropped !== undefined) {
      throw new Error(
        `domain: cannot update "${configPath}" because the edit would drop a comment (${dropped}).`,
      );
    }
  } else if (action === 'delete' && matches.length === 1) {
    text = applyEdits(text, modify(text, ['routes', matches[0]], undefined, { formattingOptions }));
  }

  const finalText = hasBom ? `${UTF8_BOM}${text}` : text;
  const modified = finalText !== raw;
  if (modified) {
    writeProjectWranglerFile(configPath, finalText);
  }
  return {
    configPath,
    domains: parseCustomDomains(parseJsonc(text).routes, configPath),
    modified,
  };
}

function discoverWranglerConfigPath(root: string): string {
  for (const path of projectWranglerPaths(root)) {
    if (existsSync(path)) {
      return path;
    }
  }
  return materializeCloudflareConfig(root);
}

function parseCustomDomains(value: unknown, configPath: string): Array<WranglerCustomDomain> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`domain: "routes" in "${configPath}" must be an array.`);
  }
  const domains: Array<WranglerCustomDomain> = [];
  for (let index = 0; index < value.length; index++) {
    const route = value[index];
    if (typeof route === 'string') {
      continue;
    }
    if (typeof route !== 'object' || route === null || Array.isArray(route)) {
      throw new Error(`domain: "routes[${index}]" in "${configPath}" is malformed.`);
    }
    const entry = route as Record<string, unknown>;
    if (entry.custom_domain !== true) {
      continue;
    }
    if (typeof entry.pattern !== 'string' || entry.pattern.length === 0) {
      throw new Error(
        `domain: custom domain route "routes[${index}]" in "${configPath}" needs a non-empty pattern.`,
      );
    }
    domains.push({ pattern: entry.pattern, customDomain: true });
  }
  return domains;
}

/** Every line and block comment in JSONC source, verbatim, in order. */
function extractCommentTokens(text: string): Array<string> {
  const scanner = createScanner(text, false);
  const tokens: Array<string> = [];
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EOF) {
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      tokens.push(text.slice(offset, offset + scanner.getTokenLength()));
    }
    kind = scanner.scan();
  }
  return tokens;
}

/** The first comment in `before` missing from `after`, counting repeats, if any. */
function findDroppedComment(before: Array<string>, after: Array<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const token of after) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const token of before) {
    const remaining = counts.get(token) ?? 0;
    if (remaining <= 0) {
      return token;
    }
    counts.set(token, remaining - 1);
  }
  return undefined;
}

/** Match inserted content to the file's indentation; two spaces by default. */
function detectFormattingOptions(text: string): FormattingOptions {
  const match = text.match(/^([ \t]+)\S/m);
  if (match) {
    const indent = match[1];
    if (indent.startsWith('\t')) {
      return { tabSize: 1, insertSpaces: false };
    }
    return { tabSize: indent.length, insertSpaces: true };
  }
  return { tabSize: 2, insertSpaces: true };
}

function parseJsonc(text: string): Record<string, unknown> {
  const errors: Array<ParseError> = [];
  const source = text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
  const result = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SyntaxError('Failed to parse JSONC');
  }
  return result;
}

/**
 * `modify()` + `applyEdits()` that keeps a trailing inline comment on the sibling it
 * documented. When a member is appended, `modify()` moves that comment after the new
 * member, so edit a copy without it and splice it back after the sibling's comma.
 */
function applyMemberEdit(
  text: string,
  path: Array<string | number>,
  value: unknown,
  options: { formattingOptions: FormattingOptions; isArrayInsertion?: boolean },
): string {
  const plain = (): string => applyEdits(text, modify(text, path, value, options));

  const root = parseTree(text, undefined, { allowTrailingComma: true });
  if (!root) {
    return plain();
  }

  // Only an append can separate a sibling from its trailing comment.
  if (!options.isArrayInsertion && findNodeAtLocation(root, path) !== undefined) {
    return plain();
  }

  // A missing container is created inside the deepest existing ancestor, which then
  // receives the new member.
  let receivingPath = path.slice(0, -1);
  let container = findNodeAtLocation(root, receivingPath);
  while (!container && receivingPath.length > 0) {
    receivingPath = receivingPath.slice(0, -1);
    container = findNodeAtLocation(root, receivingPath);
  }
  const members = container?.children;
  if (!container || !members || members.length === 0) {
    return plain();
  }

  // jsonc-parser appends both new object properties and new array elements after
  // the container's current last member, so that member is the preceding sibling.
  const last = members[members.length - 1];
  const trailing = readTrailingComment(text, last.offset + last.length);
  if (!trailing) {
    return plain();
  }

  // Strip the comment (and the comma before it), edit, then re-attach it after the new comma.
  const stripped = text.slice(0, last.offset + last.length) + text.slice(trailing.end);
  const rewritten = applyEdits(stripped, modify(stripped, path, value, options));

  const newRoot = parseTree(rewritten, undefined, { allowTrailingComma: true });
  const newContainer = newRoot ? findNodeAtLocation(newRoot, receivingPath) : undefined;
  const newMembers = newContainer?.children;
  if (!newRoot || !newContainer || !newMembers || newMembers.length < 2) {
    // We just appended, so this should not happen; fall back rather than corrupt.
    return plain();
  }
  // The appended member is last; its predecessor is the sibling we relocate onto.
  const sibling = newMembers[newMembers.length - 2];
  const commaPos = rewritten.indexOf(',', sibling.offset + sibling.length);
  if (commaPos === -1) {
    return plain();
  }
  const relocated = `${rewritten.slice(0, commaPos + 1)} ${trailing.text}${rewritten.slice(commaPos + 1)}`;

  // Relocation may only move a comment. If the result does not parse or its data differs
  // from the plain edit, use the plain edit.
  const plainResult = plain();
  let relocatedParsed: Record<string, unknown>;
  try {
    relocatedParsed = parseJsonc(relocated);
  } catch {
    return plainResult;
  }
  if (!isDeepStrictEqual(relocatedParsed, parseJsonc(plainResult))) {
    return plainResult;
  }
  return relocated;
}

/**
 * Remove the object member at `path`, keeping every comment. `modify(…, undefined)` also
 * deletes the comments between the previous member and this one, so splice out the
 * property, one separating comma (the following one, else the preceding one, so strict
 * JSON gains no trailing comma) and its blank line. Falls back to `modify()` when the
 * result's data differs.
 */
function removeMember(
  text: string,
  path: Array<string | number>,
  options: { formattingOptions: FormattingOptions },
): string {
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  const valueNode = root ? findNodeAtLocation(root, path) : undefined;
  const property = valueNode?.parent;
  if (!root || !valueNode || !property || property.type !== 'property') {
    return valueNode ? applyEdits(text, modify(text, path, undefined, options)) : text;
  }
  const start = property.offset;
  const end = property.offset + property.length;

  const scanner = createScanner(text, false);
  const tokens: Array<{ kind: SyntaxKind; offset: number; length: number }> = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    tokens.push({ kind, offset: scanner.getTokenOffset(), length: scanner.getTokenLength() });
  }
  const isTrivia = (kind: SyntaxKind): boolean =>
    kind === SyntaxKind.Trivia ||
    kind === SyntaxKind.LineBreakTrivia ||
    kind === SyntaxKind.LineCommentTrivia ||
    kind === SyntaxKind.BlockCommentTrivia;
  const following = tokens.find((token) => token.offset >= end && !isTrivia(token.kind));
  const preceding = [...tokens]
    .reverse()
    .find((token) => token.offset + token.length <= start && !isTrivia(token.kind));
  const comma =
    following?.kind === SyntaxKind.CommaToken
      ? following
      : preceding?.kind === SyntaxKind.CommaToken
        ? preceding
        : undefined;

  // Splice the higher range first so the lower offsets stay valid.
  const ranges = [{ offset: start, length: end - start }];
  if (comma) {
    ranges.push({ offset: comma.offset, length: comma.length });
  }
  ranges.sort((a, b) => b.offset - a.offset);
  let spliced = text;
  for (const range of ranges) {
    spliced = spliced.slice(0, range.offset) + spliced.slice(range.offset + range.length);
  }

  // Drop the member's line when only whitespace is left (LF, CRLF or CR endings).
  // `cursor` is the member's start in the spliced text.
  const cursor = comma && comma.offset < start ? start - comma.length : start;
  let lineStart = cursor;
  while (lineStart > 0 && spliced[lineStart - 1] !== '\n' && spliced[lineStart - 1] !== '\r') {
    lineStart--;
  }
  let lineEnd = cursor;
  while (lineEnd < spliced.length && spliced[lineEnd] !== '\n' && spliced[lineEnd] !== '\r') {
    lineEnd++;
  }
  if (spliced.slice(lineStart, lineEnd).trim() === '') {
    const terminator = spliced.startsWith('\r\n', lineEnd) ? 2 : lineEnd < spliced.length ? 1 : 0;
    spliced = spliced.slice(0, lineStart) + spliced.slice(lineEnd + terminator);
  }

  const plainResult = applyEdits(text, modify(text, path, undefined, options));
  let splicedParsed: Record<string, unknown>;
  try {
    splicedParsed = parseJsonc(spliced);
  } catch {
    return plainResult;
  }
  if (!isDeepStrictEqual(splicedParsed, parseJsonc(plainResult))) {
    return plainResult;
  }
  return spliced;
}

/**
 * The `//` or single-line block comment on the same line after `offset` (just past the
 * last member's value), allowing one comma before it.
 */
function readTrailingComment(
  text: string,
  offset: number,
): { text: string; end: number } | undefined {
  let i = offset;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }
  if (text[i] === ',') {
    i++;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
      i++;
    }
  }
  if (text[i] === '/' && text[i + 1] === '/') {
    // End at CR or LF, so a CR-only file cannot swallow the closing brace.
    let end = i;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end++;
    }
    return { text: text.slice(i, end), end };
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    if (close === -1) {
      return undefined;
    }
    const end = close + 2;
    // Only a single-line block comment can be relocated.
    const slice = text.slice(i, end);
    if (slice.includes('\n') || slice.includes('\r')) {
      return undefined;
    }
    return { text: slice, end };
  }
  return undefined;
}

/** Throw if any object in the config, at any depth, declares the same key twice. */
export function assertNoDuplicateMembers(text: string, configPath: string): void {
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  if (!root) {
    return;
  }
  const walk = (node: Node): void => {
    if (node.type === 'object' && node.children) {
      const seen = new Set<string>();
      for (const property of node.children) {
        const keyNode = property.children?.[0];
        const key = keyNode?.value;
        if (typeof key !== 'string') {
          continue;
        }
        if (seen.has(key)) {
          const { line, column } = offsetToLineColumn(text, keyNode!.offset);
          throw new Error(
            `deploy: cannot update "${configPath}" — duplicate key ${JSON.stringify(key)} ` +
              `at line ${line}, column ${column}. Wrangler reads the last of two duplicate ` +
              `members, but this writer edits the first, so the update would silently not ` +
              `apply. Remove the duplicate and retry.`,
          );
        }
        seen.add(key);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
}

/** 1-based line and column of an offset. */
function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function validateDurableObjectMigrations(
  value: unknown,
  configPath: string,
): Array<DurableObjectMigration> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `deploy: cannot update "${configPath}" — "migrations" must be an array of Durable Object migration steps.`,
    );
  }
  const tags = new Set<string>();
  for (const [index, migration] of value.entries()) {
    if (!isRecord(migration) || typeof migration.tag !== 'string' || migration.tag.length === 0) {
      throw new Error(
        `deploy: cannot update "${configPath}" — migration at index ${index} must be an object with a non-empty string "tag".`,
      );
    }
    if (tags.has(migration.tag)) {
      throw new Error(
        `deploy: cannot update "${configPath}" — migration tag '${migration.tag}' is declared more than once.`,
      );
    }
    tags.add(migration.tag);
    for (const field of ['new_classes', 'new_sqlite_classes', 'deleted_classes'] as const) {
      const classes = migration[field];
      if (
        classes !== undefined &&
        (!Array.isArray(classes) || classes.some((className) => typeof className !== 'string'))
      ) {
        throw new Error(
          `deploy: cannot update "${configPath}" — "migrations[${index}].${field}" must be an array of class names.`,
        );
      }
    }
    const renamed = migration.renamed_classes;
    if (
      renamed !== undefined &&
      (!Array.isArray(renamed) ||
        renamed.some(
          (entry) =>
            !isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string',
        ))
    ) {
      throw new Error(
        `deploy: cannot update "${configPath}" — "migrations[${index}].renamed_classes" has an invalid entry.`,
      );
    }
    const transferred = migration.transferred_classes;
    if (
      transferred !== undefined &&
      (!Array.isArray(transferred) ||
        transferred.some(
          (entry) =>
            !isRecord(entry) ||
            typeof entry.from !== 'string' ||
            typeof entry.from_script !== 'string' ||
            typeof entry.to !== 'string',
        ))
    ) {
      throw new Error(
        `deploy: cannot update "${configPath}" — "migrations[${index}].transferred_classes" has an invalid entry.`,
      );
    }
  }
  return value as Array<DurableObjectMigration>;
}

/**
 * Wrangler's `friendlyBindingNames`: the fields `validateBindingsHaveUniqueNames` reads, with
 * their labels. `queues` is left out because the producer upsert matches its own entries;
 * including it would make a producer collide with itself.
 */
export const FRIENDLY_BINDING_NAMES: Record<string, string> = {
  data_blobs: 'Data Blob',
  durable_objects: 'Durable Object',
  kv_namespaces: 'KV Namespace',
  send_email: 'Send Email',
  d1_databases: 'D1 Database',
  vectorize: 'Vectorize Index',
  ai_search_namespaces: 'AI Search Namespace',
  ai_search: 'AI Search Instance',
  websearch: 'Web Search',
  agent_memory: 'Agent Memory',
  hyperdrive: 'Hyperdrive Config',
  r2_buckets: 'R2 Bucket',
  logfwdr: 'logfwdr',
  services: 'Worker',
  analytics_engine_datasets: 'Analytics Engine Dataset',
  text_blobs: 'Text Blob',
  browser: 'Browser Run',
  ai: 'AI',
  images: 'Images',
  stream: 'Stream',
  media: 'Media',
  version_metadata: 'Worker Version Metadata',
  unsafe: 'Unsafe Metadata',
  vars: 'Environment Variable',
  wasm_modules: 'Wasm Module',
  dispatch_namespaces: 'Dispatch Namespace',
  mtls_certificates: 'mTLS Certificate',
  workflows: 'Workflow',
  pipelines: 'Pipeline',
  secrets_store_secrets: 'Secrets Store Secret',
  artifacts: 'Artifacts',
  ratelimits: 'Rate Limit',
  assets: 'Assets',
  unsafe_hello_world: 'Hello World',
  flagship: 'Flagship',
  worker_loaders: 'Worker Loader',
  vpc_services: 'VPC Service',
  vpc_networks: 'VPC Network',
};

/** Every binding name in the config, mapped to its owner's label (first one wins). */
function collectWorkerBindingNames(config: Record<string, unknown>): Map<string, string> {
  const owners = new Map<string, string>();
  const claim = (name: string, friendly: string): void => {
    if (!owners.has(name)) {
      owners.set(name, friendly);
    }
  };
  for (const [field, friendly] of Object.entries(FRIENDLY_BINDING_NAMES)) {
    for (const name of bindingNamesForField(field, config[field])) {
      claim(name, friendly);
    }
  }
  // Wrangler also counts `secrets.required` as binding names, under "Secret".
  const secrets = assertObjectContainer(config.secrets, 'secrets');
  if (secrets && secrets.required !== undefined) {
    if (!Array.isArray(secrets.required)) {
      throw new Error(
        `deploy: cannot verify binding-name uniqueness — "secrets.required" must be an array of ` +
          `secret names. Fix the wrangler config and retry.`,
      );
    }
    secrets.required.forEach((name, index) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw bindingSetError(
          `"secrets.required" contains a malformed entry at index ${index} (expected a non-empty string)`,
          'dropped entry',
        );
      }
      claim(name, 'Secret');
    });
  }
  return owners;
}

/** A shallow copy of `config` without `field`. */
function configWithoutField(
  config: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const { [field]: _omit, ...rest } = config;
  return rest;
}

/** Add queue producer bindings (label "Queue"), which the base collector leaves out. */
function addQueueProducerOwners(
  owners: Map<string, string>,
  config: Record<string, unknown>,
): void {
  const queues = assertObjectContainer(config.queues, 'queues');
  if (!queues || queues.producers === undefined) {
    return;
  }
  for (const producer of assertValidQueueProducers(queues.producers)) {
    const binding = producer.binding as string;
    if (!owners.has(binding)) {
      owners.set(binding, 'Queue');
    }
  }
}

/**
 * Validate `queues.producers`: every member needs a non-empty string `binding`. A skipped
 * member could hide a binding collision, so a malformed one throws.
 */
function assertValidQueueProducers(producers: unknown): Array<Record<string, unknown>> {
  if (producers === undefined) {
    return [];
  }
  if (!Array.isArray(producers)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "queues.producers" must be an array. Fix ` +
        `the wrangler config and retry.`,
    );
  }
  return producers.map((producer, index) => {
    if (
      !isRecord(producer) ||
      typeof producer.binding !== 'string' ||
      producer.binding.length === 0
    ) {
      throw bindingSetError(
        `"queues.producers" contains a malformed entry at index ${index} (missing a non-empty string "binding")`,
        'dropped producer',
      );
    }
    return producer;
  });
}

/** An object-valued container field (`queues`, `secrets`); any other present value throws. */
function assertObjectContainer(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw bindingSetError(`"${field}" must be an object`, 'wrong-shaped container');
  }
  return value;
}

/**
 * The label of another binding type that already uses `name`, or undefined when only
 * `field` (or nothing) does. Lets a caller refuse a write before its side effects.
 */
export function findBindingNameOwner(
  config: Record<string, unknown>,
  field: string,
  name: string,
): string | undefined {
  bindingNamesForField(field, config[field]);
  const owners = collectWorkerBindingNames(configWithoutField(config, field));
  addQueueProducerOwners(owners, config);
  return owners.get(name);
}

/**
 * The one entry in `field` (`d1_databases`, `kv_namespaces`, …) with this binding, or
 * undefined. Throws on a malformed field, a duplicate entry, or a name another binding
 * type also uses.
 */
export function readProvisionedBindingEntry(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  configPath: string,
): Record<string, unknown> | undefined {
  bindingNamesForField(field, config[field]);
  const rawList = config[field];
  const list = Array.isArray(rawList) ? rawList : [];
  const matches = list.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.binding === binding,
  );
  if (matches.length > 1) {
    throw new Error(
      `provision: cannot read "${configPath}" — binding ${JSON.stringify(binding)} is declared ` +
        `${matches.length} times in "${field}". Cannot pick one to reuse/verify, and wrangler rejects ` +
        `duplicate binding names. Remove the duplicate and retry.`,
    );
  }
  const owners = collectWorkerBindingNames(configWithoutField(config, field));
  addQueueProducerOwners(owners, config);
  const owner = owners.get(binding);
  if (owner !== undefined) {
    throw new Error(
      `provision: cannot read "${configPath}" — binding ${JSON.stringify(binding)} in "${field}" is ` +
        `also used by a ${owner} binding. Wrangler requires every binding name to be unique across ` +
        `the whole worker, so this config is undeployable. Rename the conflicting binding and retry.`,
    );
  }
  return matches[0];
}

/**
 * Where a field keeps its binding names, per Wrangler's config schema:
 * - key-map (`vars`, …): the object's keys.
 * - name-keyed-array (`send_email`, `ratelimits`): `[{ name }]`.
 * - namespace-array (the default): `[{ binding }]`.
 * - singleton (`ai`, `browser`, …): `{ binding }`.
 * - binding-list (`durable_objects`, `logfwdr`, `unsafe`): `{ bindings: [{ name }] }`.
 * - whole-object (`addresses`): not a binding; the deploy check compares the whole value.
 */
type BindingFieldShape =
  | { kind: 'key-map' }
  | { kind: 'name-keyed-array' }
  | { kind: 'namespace-array' }
  | { kind: 'singleton'; bindingRequired: boolean }
  | { kind: 'binding-list'; bindingsRequired: boolean }
  | { kind: 'whole-object' };

/** Fields that are not a `namespace-array`. */
const BINDING_FIELD_SHAPES: Record<string, BindingFieldShape> = {
  vars: { kind: 'key-map' },
  wasm_modules: { kind: 'key-map' },
  text_blobs: { kind: 'key-map' },
  data_blobs: { kind: 'key-map' },
  send_email: { kind: 'name-keyed-array' },
  ratelimits: { kind: 'name-keyed-array' },
  addresses: { kind: 'whole-object' },
  ai: { kind: 'singleton', bindingRequired: true },
  browser: { kind: 'singleton', bindingRequired: true },
  images: { kind: 'singleton', bindingRequired: true },
  stream: { kind: 'singleton', bindingRequired: true },
  media: { kind: 'singleton', bindingRequired: true },
  websearch: { kind: 'singleton', bindingRequired: true },
  version_metadata: { kind: 'singleton', bindingRequired: true },
  // An assets directory without a binding is valid.
  assets: { kind: 'singleton', bindingRequired: false },
  durable_objects: { kind: 'binding-list', bindingsRequired: true },
  logfwdr: { kind: 'binding-list', bindingsRequired: true },
  // `unsafe` may carry only `metadata`.
  unsafe: { kind: 'binding-list', bindingsRequired: false },
};

/**
 * Binding names in one config field, read by the field's known shape. Throws on a wrong
 * shape or a missing required name, which Wrangler would drop silently.
 */
export function bindingNamesForField(field: string, value: unknown): Array<string> {
  if (BINDING_FIELD_SHAPES[field]?.kind === 'key-map') {
    return keyMapBindingNames(field, value);
  }
  return bindingEntriesForField(field, value).map((entry) => entry.name);
}

/**
 * Like {@link bindingNamesForField}, but pairs each name with its config entry so a caller
 * can also compare what the binding points at.
 */
export function bindingEntriesForField(
  field: string,
  value: unknown,
): Array<{ name: string; entry: Record<string, unknown> }> {
  const shape: BindingFieldShape = BINDING_FIELD_SHAPES[field] ?? { kind: 'namespace-array' };
  switch (shape.kind) {
    case 'key-map':
      return keyMapBindingEntries(field);
    case 'name-keyed-array':
      return nameKeyedBindingEntries(field, value);
    case 'namespace-array':
      return namespaceArrayBindingEntries(field, value);
    case 'singleton':
      return singletonBindingEntry(field, value, shape.bindingRequired);
    case 'binding-list':
      return bindingListEntries(field, value, shape.bindingsRequired);
    case 'whole-object':
      return [];
  }
}

/** Key-map fields have no entry objects; callers never route them here. */
function keyMapBindingEntries(field: string): never {
  throw bindingSetError(
    `"${field}" must be an object mapping names to values`,
    'wrong-shaped field',
  );
}

function namespaceArrayBindingEntries(
  field: string,
  value: unknown,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw bindingSetError(`"${field}" must be an array of binding entries`, 'wrong-shaped field');
  }
  return strictBindingEntries(value, 'binding', field);
}

/**
 * `send_email` and `ratelimits` are keyed by `.name` only. A `.binding` on such an entry is
 * not an identity Wrangler uses, so reading it would invent a collision.
 */
function nameKeyedBindingEntries(
  field: string,
  value: unknown,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw bindingSetError(`"${field}" must be an array of binding entries`, 'wrong-shaped field');
  }
  return strictBindingEntries(value, 'name', field);
}

function bindingListEntries(
  field: string,
  value: unknown,
  bindingsRequired: boolean,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw bindingSetError(
      `"${field}" must be an object with a "bindings" array`,
      'wrong-shaped field',
    );
  }
  if (value.bindings === undefined) {
    if (bindingsRequired) {
      throw bindingSetError(`"${field}" requires a "bindings" array`, 'wrong-shaped field');
    }
    return [];
  }
  if (!Array.isArray(value.bindings)) {
    throw bindingSetError(`"${field}.bindings" must be an array`, 'wrong-shaped field');
  }
  return strictBindingEntries(value.bindings, 'name', `${field}.bindings`);
}

function singletonBindingEntry(
  field: string,
  value: unknown,
  bindingRequired: boolean,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw bindingSetError(`"${field}" must be an object with a "binding"`, 'wrong-shaped field');
  }
  if (typeof value.binding === 'string' && value.binding.length > 0) {
    return [{ name: value.binding, entry: value }];
  }
  if (value.binding !== undefined) {
    throw bindingSetError(
      `"${field}" has a malformed "binding" (expected a non-empty string)`,
      'dropped binding',
    );
  }
  if (bindingRequired) {
    throw bindingSetError(
      `"${field}" requires a "binding" (a non-empty string)`,
      'dropped binding',
    );
  }
  return [];
}

/** The keys of a key-map field are its binding names; the values are never read. */
function keyMapBindingNames(field: string, value: unknown): Array<string> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw bindingSetError(
      `"${field}" must be an object mapping names to values`,
      'wrong-shaped field',
    );
  }
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * Read `keyField` from every member, paired with the member. A malformed member throws:
 * dropping it could hide an existing binding from the uniqueness check.
 */
function strictBindingEntries(
  members: Array<unknown>,
  keyField: 'binding' | 'name',
  field: string,
): Array<{ name: string; entry: Record<string, unknown> }> {
  return members.map((member, index) => {
    if (
      !isRecord(member) ||
      typeof member[keyField] !== 'string' ||
      (member[keyField] as string).length === 0
    ) {
      throw bindingSetError(
        `"${field}" contains a malformed entry at index ${index} (missing a non-empty string "${keyField}")`,
        'dropped entry',
      );
    }
    return { name: member[keyField] as string, entry: member };
  });
}

/** A binding field that cannot be read completely; a missed name could hide a collision. */
function bindingSetError(problem: string, hidden: string): Error {
  return new Error(
    `deploy: cannot verify binding-name uniqueness — ${problem}. Refusing to proceed on a ` +
      `partially-readable binding set (a ${hidden} could hide a real collision). Fix the ` +
      `wrangler config and retry.`,
  );
}

/**
 * Whether two `migrations_dir` values name the same folder. Wrangler resolves the value
 * against the config file's directory and accepts either slash.
 */
export function sameMigrationsDir(configPath: string, a: string, b: string): boolean {
  const base = dirname(configPath);
  return resolve(base, a.replaceAll('\\', '/')) === resolve(base, b.replaceAll('\\', '/'));
}

/** Wrangler's rule: the normalized pattern starts with `<dir>/`, unless the dir is ".". */
function migrationsPatternMatchesDir(pattern: string, dir: string): boolean {
  const normalizedDir = normalizeMigrationsPath(dir);
  if (normalizedDir === '.') {
    return true;
  }
  return normalizeMigrationsPath(pattern).startsWith(`${normalizedDir}/`);
}

/** Wrangler's `normalizeRelativePath`: forward slashes, normalized, no trailing slash. */
function normalizeMigrationsPath(p: string): string {
  const normalized = normalize(p.replace(/\\/g, '/'));
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
