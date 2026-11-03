import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readConfigEntryString as readD1EntryString } from '@void/deploy-cloudflare';
import { dirname, join, resolve } from 'pathslash';
import { analyzeApplicationSync, type ApplicationAnalysis } from '../application-analysis.ts';
import { type VoidConfig } from '../config.ts';
import {
  resolveSandboxConfig,
  sandboxContainerConfig,
  SANDBOX_MIGRATION_TAG,
  hasSandboxSqliteMigration,
} from '../sandbox/config.ts';
import { type BindingIdentitySnapshot } from './deploy-types.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';
import type { DesiredResourceSet, ProvisionDriftEntry } from './provision.ts';
import {
  readExistingLiveBindingConfig,
  resolveLiveBindingConfig,
  bindingEntriesForField,
  FRIENDLY_BINDING_NAMES,
  hasDurableObjectSqliteMigration,
  LIVE_MIGRATION_TAG,
  nextDurableObjectMigrationTag,
} from './wrangler.ts';

/** The id-bearing binding fields whose identity must survive the build unchanged. */
export const DEPLOY_BINDING_IDENTITY_FIELDS: Record<
  ProvisionDriftEntry['kind'],
  { field: string; idField: string }
> = {
  d1: { field: 'd1_databases', idField: 'database_id' },
  kv: { field: 'kv_namespaces', idField: 'id' },
  r2: { field: 'r2_buckets', idField: 'bucket_name' },
  hyperdrive: { field: 'hyperdrive', idField: 'id' },
};

/** Every id-bearing binding in the desired set, as `{ kind, binding }` pairs. */
export function desiredIdentityBindings(
  desired: DesiredResourceSet,
): Array<{ kind: ProvisionDriftEntry['kind']; binding: string }> {
  const out: Array<{ kind: ProvisionDriftEntry['kind']; binding: string }> = [];
  if (desired.d1) {
    out.push({ kind: 'd1', binding: desired.d1.binding });
  }
  for (const kv of desired.kvNamespaces) {
    out.push({ kind: 'kv', binding: kv.binding });
  }
  if (desired.r2) {
    out.push({ kind: 'r2', binding: desired.r2.binding });
  }
  if (desired.hyperdrive) {
    out.push({ kind: 'hyperdrive', binding: desired.hyperdrive.binding });
  }
  return out;
}

/** Snapshot key for one binding. Binding names contain no `:`, so keys never collide. */
export function bindingIdentityKey(field: string, binding: string): string {
  return `${field}:${binding}`;
}

/**
 * Every id-bearing binding declared in `config`, not only the desired ones, so the completeness
 * check can tell a user's own binding from one the build added. A missing or empty id is
 * `undefined`.
 */
export function collectConfigBindingIdentities(
  config: Record<string, unknown>,
): Array<{ field: string; binding: string; id: string | undefined }> {
  const out: Array<{ field: string; binding: string; id: string | undefined }> = [];
  for (const { field, idField } of Object.values(DEPLOY_BINDING_IDENTITY_FIELDS)) {
    const list = config[field];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const binding = readD1EntryString(entry, 'binding');
      if (binding === undefined) {
        continue;
      }
      out.push({ field, binding, id: readD1EntryString(entry, idField) });
    }
  }
  return out;
}

/**
 * Pin every declared D1/KV/R2/Hyperdrive id after provisioning and before the build. The build
 * runs project code that can edit config files, so the post-build checks compare against this
 * in-memory copy to catch a rewritten or added id. Bindings without an id are not pinned.
 */
export function snapshotBindingIdentities(
  config: Record<string, unknown>,
): BindingIdentitySnapshot {
  const snapshot: BindingIdentitySnapshot = new Map();
  for (const { field, binding, id } of collectConfigBindingIdentities(config)) {
    if (id !== undefined) {
      snapshot.set(bindingIdentityKey(field, binding), id);
    }
  }
  return snapshot;
}

/**
 * Binding fields that Void's own build emits (through `mergeWorkerBindings` in
 * plugin-worker-bindings.ts or the config normalizer), so they are not checked against the
 * pre-build root.
 */
export const DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS: ReadonlySet<string> = new Set<string>([
  // id-pinned by DEPLOY_BINDING_IDENTITY_FIELDS
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'hyperdrive',
  // emitted by Void
  'ai',
  'images',
  'durable_objects',
  'assets',
  'vars',
  // bundled content and self-metadata grant no external resource
  'data_blobs',
  'text_blobs',
  'wasm_modules',
  'version_metadata',
]);

/**
 * Every known binding field ({@link FRIENDLY_BINDING_NAMES}) that Void does not emit. An emitted
 * entry in one of these must come verbatim from the root config; any other entry (a `services`
 * binding, an `unsafe` binding, ...) was added by the build. New registry fields are checked
 * until they are excluded above.
 */
export const DEPLOY_PASSTHROUGH_ASSERT_FIELDS: ReadonlyArray<string> = Object.keys(
  FRIENDLY_BINDING_NAMES,
).filter((field) => !DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS.has(field));

/**
 * Fields the CF plugin passes through verbatim that the per-entry pin cannot cover, so each is
 * compared whole against the root value. Void's own build emits none of them.
 *   - `unsafe`: its `metadata` replaces the whole uploaded bindings list.
 *   - `tail_consumers` / `streaming_tail_consumers`: forward every log to another Worker.
 *   - `routes` / `route` / `workers_dev` / `preview_urls`: attach the Worker to traffic.
 *   - `addresses`: routes the account's inbound mail to the Worker.
 */
export const DEPLOY_WHOLE_OBJECT_PINNED_FIELDS: ReadonlyArray<string> = [
  'unsafe',
  'tail_consumers',
  'streaming_tail_consumers',
  'routes',
  'route',
  'workers_dev',
  'preview_urls',
  'addresses',
];

/**
 * Root values captured for {@link verifyGeneratedDeployConfig}: the whole-object fields plus
 * `durable_objects`, `ai`, `images` and `migrations`, which Void emits but a build could still
 * tamper with.
 */
const DEPLOY_RAW_SNAPSHOT_FIELDS: ReadonlyArray<string> = [
  ...DEPLOY_WHOLE_OBJECT_PINNED_FIELDS,
  'durable_objects',
  'ai',
  'images',
  'migrations',
];

/** Default Workers AI binding name that Void emits. */
export const DEFAULT_VOID_AI_BINDING = 'AI';

/** Default Cloudflare Images binding name that Void emits. */
export const DEFAULT_VOID_IMAGES_BINDING = 'IMAGES';

/** `durable_objects` sub-fields that bind another Worker's Durable Objects. Void never emits them. */
const DURABLE_OBJECT_EXTERNAL_FIELDS = ['script_name', 'environment'];

/** Migration keys that delete or move Durable Object classes. Void only emits creation keys. */
const DESTRUCTIVE_MIGRATION_KEYS = [
  'deleted_classes',
  'renamed_classes',
  'transferred_classes',
  'transferred_classes_from_script',
];

/**
 * Pin each pass-through binding entry (field → name → entry) before the build, so a user's own
 * entry survives while an added or retargeted one fails {@link verifyGeneratedDeployConfig}.
 */
export function snapshotPassthroughIdentities(
  config: Record<string, unknown>,
): Map<string, Map<string, Record<string, unknown>>> {
  const snapshot = new Map<string, Map<string, Record<string, unknown>>>();
  for (const field of DEPLOY_PASSTHROUGH_ASSERT_FIELDS) {
    if (config[field] === undefined) {
      continue;
    }
    const entries = new Map<string, Record<string, unknown>>();
    try {
      for (const { name, entry } of bindingEntriesForField(field, config[field])) {
        entries.set(name, entry);
      }
    } catch {
      // A malformed field records an EMPTY pin, so any emitted entry in it fails closed below.
      entries.clear();
    }
    snapshot.set(field, entries);
  }
  return snapshot;
}

/** Raw pre-build root value of each {@link DEPLOY_RAW_SNAPSHOT_FIELDS} field. */
export function snapshotPassthroughRawFields(
  config: Record<string, unknown>,
): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const field of DEPLOY_RAW_SNAPSHOT_FIELDS) {
    snapshot.set(field, config[field]);
  }
  return snapshot;
}

/**
 * The `containers` array Void's build emits: root containers verbatim and, when the app needs
 * Sandbox, Void's sandbox container in place of any root container with the same class (as
 * `mergeWorkerBindings` does). Deploy rejects an emitted array that differs.
 */
export function reconstructExpectedContainers(
  config: VoidConfig,
  root: string,
  rootConfig: Record<string, unknown>,
  needsSandbox: boolean,
): Array<Record<string, unknown>> {
  const rootContainers: Array<Record<string, unknown>> = Array.isArray(rootConfig.containers)
    ? (rootConfig.containers as Array<Record<string, unknown>>)
    : [];
  const expected: Array<Record<string, unknown>> = [...rootContainers];
  if (needsSandbox) {
    const sandbox = resolveSandboxConfig(config, root);
    const index = expected.findIndex(
      (container) => readD1EntryString(container, 'class_name') === sandbox.className,
    );
    if (index >= 0) {
      expected.splice(index, 1);
    }
    expected.push(sandboxContainerConfig(sandbox));
  }
  return expected;
}

/** Normalize only the named-image path fields Vite relocates into its output config. */
export function normalizeContainerImagePaths(container: unknown, base: string): unknown {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return container;
  }
  const value = container as Record<string, unknown>;
  if (!value.images || typeof value.images !== 'object' || Array.isArray(value.images)) {
    return container;
  }
  return {
    ...value,
    images: Object.fromEntries(
      Object.entries(value.images).map(([name, source]) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          return [name, source];
        }
        const image = { ...source } as Record<string, unknown>;
        for (const key of ['dockerfile', 'build_context']) {
          if (typeof image[key] === 'string') {
            image[key] = resolve(base, image[key]);
          }
        }
        return [name, image];
      }),
    ),
  };
}

/** Reconstruct the Durable Object state emitted after the pre-build root config is synced. */
export function reconstructExpectedDurableObjectState(
  config: VoidConfig,
  root: string,
  rootConfig: Record<string, unknown>,
  options: { needsSandbox: boolean; needsLive: boolean; analysis?: ApplicationAnalysis },
): {
  bindings: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
} {
  // classifyCloudflareDeployApp syncs WebSocket and authored Durable Object
  // modules into the root config before this snapshot. The build starts with
  // that same config, then may append its sandbox and live bindings.
  const bindings = bindingEntriesForField('durable_objects', rootConfig.durable_objects).map(
    ({ entry }) => entry,
  );
  const migrations: Array<Record<string, unknown>> = Array.isArray(rootConfig.migrations)
    ? [...(rootConfig.migrations as Array<Record<string, unknown>>)]
    : [];
  const sandbox = options.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  if (sandbox) {
    if (!bindings.some((binding) => binding.name === sandbox.binding)) {
      bindings.push({ name: sandbox.binding, class_name: sandbox.className });
    }
    if (!hasSandboxSqliteMigration(migrations, sandbox.className)) {
      migrations.push({
        tag: SANDBOX_MIGRATION_TAG,
        new_sqlite_classes: [sandbox.className],
      });
    }
  }

  const analysis = options.analysis ?? analyzeApplicationSync(root, { config });
  const websocketRoutes = analysis.allWebsockets;
  const durableObjects = analysis.durableObjects;
  const live = options.needsLive
    ? resolveLiveBindingConfig(root, {
        reservedBindings: [
          ...websocketRoutes.map((route) => route.bindingName),
          ...durableObjects.map((module) => module.bindingName),
        ],
        reservedClasses: [
          ...websocketRoutes.map((route) => route.className),
          ...durableObjects.map((module) => module.className),
          sandbox?.className,
        ],
      })
    : readExistingLiveBindingConfig(root);
  if (live) {
    if (!bindings.some((binding) => binding.name === live.bindingName)) {
      bindings.push({ name: live.bindingName, class_name: live.className });
    }
    if (!hasDurableObjectSqliteMigration(migrations, live.className)) {
      migrations.push({
        tag: nextDurableObjectMigrationTag(migrations, LIVE_MIGRATION_TAG),
        new_sqlite_classes: [live.className],
      });
    }
  }
  return { bindings, migrations };
}

/**
 * Content hash of the directory holding the Cloudflare operation-process entry that the
 * credentialed deploy runs (the last element of {@link resolveCloudflareOperationArgv}). Returns
 * `undefined` when it cannot be resolved or read, so the caller fails closed.
 */
export function hashWranglerUploader(
  root: string,
  resolveArgv: (root: string) => Array<string> = resolveCloudflareOperationArgv,
): string | undefined {
  let entry: string | undefined;
  try {
    const argv = resolveArgv(root);
    entry = argv[argv.length - 1];
  } catch {
    return undefined;
  }
  if (typeof entry !== 'string' || entry.length === 0 || !existsSync(entry)) {
    return undefined;
  }
  return hashDirectoryContents(dirname(entry));
}

/** Pin the cf uploader and prebuilt-artifact builders before project code runs. */
export function hashCfUploader(): string | undefined {
  try {
    const hash = createHash('sha256');
    for (const name of ['cf', '@cloudflare/config', '@cloudflare/build-output-utils', 'vite']) {
      let path = dirname(fileURLToPath(import.meta.resolve(name)));
      while (!existsSync(join(path, 'package.json'))) {
        const parent = dirname(path);
        if (parent === path) {
          return undefined;
        }
        path = parent;
      }
      const contents = hashDirectoryContents(path);
      if (!contents) {
        return undefined;
      }
      hash.update(name);
      hash.update('\0');
      hash.update(contents);
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * sha256 over every file under `dir` in name-sorted order, with relative paths folded in.
 * Returns `undefined` on any read error.
 */
function hashDirectoryContents(dir: string): string | undefined {
  try {
    const hash = createHash('sha256');
    const visiting = new Set<string>();
    const walk = (rel: string): void => {
      const real = realpathSync(join(dir, rel));
      if (visiting.has(real)) {
        throw new Error(`Cyclic symlink in uploader: ${rel}`);
      }
      visiting.add(real);
      try {
        const entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const entry of entries) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childPath = join(dir, childRel);
          if (entry.isDirectory()) {
            walk(childRel);
            continue;
          }
          hash.update(childRel);
          hash.update('\0');
          if (entry.isSymbolicLink()) {
            hash.update(readlinkSync(childPath));
            hash.update('\0');
            try {
              const target = statSync(childPath);
              if (target.isDirectory()) {
                walk(childRel);
              } else if (target.isFile()) {
                hash.update(readFileSync(childPath));
              } else {
                throw new Error(`Unsupported uploader symlink target: ${childRel}`);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              hash.update('missing');
            }
          } else {
            hash.update(readFileSync(childPath));
          }
          hash.update('\0');
        }
      } finally {
        visiting.delete(real);
      }
    };
    walk('');
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Fail when the uploader hash changed across the build or could not be computed: a build that
 * rewrote the uploader would otherwise run with the Cloudflare credentials.
 */
export function assertWranglerUploaderUnchanged(
  before: string | undefined,
  after: string | undefined,
): { ok: boolean; reason?: string } {
  if (before === undefined || after === undefined) {
    return {
      ok: false,
      reason: `could not resolve or hash the Cloudflare uploader to verify it across the build — refusing to run a deploy binary that cannot be verified.`,
    };
  }
  if (before !== after) {
    return {
      ok: false,
      reason: `the build modified the Cloudflare uploader (its bundle hash changed across the build) — refusing to run it with your Cloudflare credentials.`,
    };
  }
  return { ok: true };
}

/**
 * True when a field value grants nothing: absent, `null`, `[]`, `{}` or `{ bindings: [] }`. This
 * covers the config normalizer's default fills.
 */
export function isEmptyPassthroughValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return true;
    }
    if (keys.length === 1 && keys[0] === 'bindings') {
      const bindings = (value as Record<string, unknown>).bindings;
      return Array.isArray(bindings) && bindings.length === 0;
    }
  }
  return false;
}

/**
 * Reject an emitted `durable_objects` binding that targets another Worker unless the root declared
 * the same entry. Local bindings always pass; a malformed value fails.
 */
export function verifyNoInjectedExternalDurableObject(
  emitted: unknown,
  root: unknown,
): { ok: boolean; reason?: string } {
  let emittedEntries: Array<{ name: string; entry: Record<string, unknown> }>;
  try {
    emittedEntries = bindingEntriesForField('durable_objects', emitted);
  } catch {
    return {
      ok: false,
      reason: `generated config declares a malformed durable_objects binding — refusing to deploy a binding set that cannot be verified.`,
    };
  }
  const rootByName = new Map<string, Record<string, unknown>>();
  try {
    for (const { name, entry } of bindingEntriesForField('durable_objects', root)) {
      rootByName.set(name, entry);
    }
  } catch {
    // A malformed root records no pins, so any emitted EXTERNAL DO fails closed below.
    rootByName.clear();
  }
  for (const { name, entry } of emittedEntries) {
    if (!DURABLE_OBJECT_EXTERNAL_FIELDS.some((key) => entry[key] !== undefined)) {
      continue;
    }
    const rootEntry = rootByName.get(name);
    if (rootEntry === undefined || !isDeepStrictEqual(entry, rootEntry)) {
      return {
        ok: false,
        reason: `generated config declares a durable_objects binding ${JSON.stringify(name)} bound to another worker's script that was not present before the build — refusing to deploy an external Durable Object the build injected.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Reject an emitted migration with a {@link DESTRUCTIVE_MIGRATION_KEYS} key unless the root
 * declared the same entry. Creation-only migrations always pass.
 */
export function verifyNoInjectedDestructiveMigration(
  emitted: unknown,
  root: unknown,
): { ok: boolean; reason?: string } {
  if (!Array.isArray(emitted)) {
    return { ok: true };
  }
  const rootEntries = Array.isArray(root) ? root : [];
  for (const entry of emitted) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (!DESTRUCTIVE_MIGRATION_KEYS.some((key) => record[key] !== undefined)) {
      continue;
    }
    if (!rootEntries.some((rootEntry) => isDeepStrictEqual(record, rootEntry))) {
      const tag = typeof record.tag === 'string' ? ` ${JSON.stringify(record.tag)}` : '';
      return {
        ok: false,
        reason: `generated config declares a destructive Durable Object migration${tag} (deleting, renaming, or transferring classes) that was not present before the build — refusing to deploy a migration the build added that would delete or move Durable Object data.`,
      };
    }
  }
  return { ok: true };
}

/** Queue names bound in one group. A malformed `queues` value yields none. */
export function collectEmittedQueueGroupNames(
  value: unknown,
  group: 'producers' | 'consumers',
): Set<string> {
  const names = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return names;
  }
  const list = (value as Record<string, unknown>)[group];
  if (!Array.isArray(list)) {
    return names;
  }
  for (const entry of list) {
    const name = readD1EntryString(entry, 'queue');
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/** The CF Vite plugin's deploy-config redirect file. */
export function deployPointerPath(root: string): string {
  return join(root, '.wrangler', 'deploy', 'config.json');
}
