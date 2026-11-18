import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@void/deploy-core';
import { parseRootWranglerConfig } from './config.ts';
import { isCleanCommandExit, isWorkerNotFound, type CloudflareCommandRunner } from './execute.ts';
import type { CloudflareOperation } from './operations.ts';
import {
  isVoidSecretDraftHeader,
  isVoidSecretOnlyDraft,
  isWranglerSecretOnlyDraft,
} from './secret-draft.ts';

export type ExistingCloudflareWorker = {
  versionId: string;
  bindings: Array<Record<string, unknown>>;
  runtime: Record<string, unknown>;
  script: Record<string, unknown>;
};

/** Exact identities of new KV bindings explicitly approved before the build. */
export type ApprovedCloudflareKvBinding = Readonly<{ binding: string; id: string }>;

type ExistingCloudflareWorkerOptions = {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  versionId?: string;
};

type CloudflareWorkerInspection = {
  snapshot: ExistingCloudflareWorker;
  isSecretOnlyDraft: boolean;
};

/** A failed remote read, distinct from an invalid or changing Worker configuration. */
export class CloudflareWorkerInspectionError extends Error {
  override name = 'CloudflareWorkerInspectionError';
}

export type CloudflareWorkerMigrationTagOptions = {
  runWrangler: CloudflareCommandRunner;
  accountId: string;
  apiBaseUrl: string;
  workerName: string;
};

/** Read the deployed version, not the most recently uploaded candidate. */
export async function readExistingCloudflareWorker(
  options: ExistingCloudflareWorkerOptions,
): Promise<ExistingCloudflareWorker> {
  const worker = await readCloudflareWorker(options, false);
  if (!worker) {
    throw new Error(`Cloudflare Worker "${options.workerName}" does not have an active version.`);
  }
  return worker.snapshot;
}

async function readCloudflareWorker(
  options: ExistingCloudflareWorkerOptions,
  allowMissing: boolean,
  proveSecretDraft = false,
): Promise<CloudflareWorkerInspection | null> {
  const target = { configPath: options.configPath, workerName: options.workerName };
  const read = async (
    operation: CloudflareOperation,
    missingIsNull = false,
  ): Promise<Record<string, unknown> | null> => {
    const result = await options.runWrangler(operation, { capture: true });
    if (!isCleanCommandExit(result)) {
      if (missingIsNull && isWorkerNotFound(result)) {
        return null;
      }
      throw new CloudflareWorkerInspectionError(
        `Could not verify existing Cloudflare Worker "${options.workerName}". Check the account, Worker name, and Cloudflare permissions before retrying.`,
      );
    }
    if (isRecord(result.data)) {
      return result.data;
    }
    throw new Error('Cloudflare returned an invalid existing Worker response.');
  };
  const deployment = options.versionId
    ? { versions: [{ version_id: options.versionId, percentage: 100 }] }
    : await read({ type: 'deployments.status', ...target }, allowMissing);
  if (deployment === null) {
    return null;
  }
  const versions = deployment.versions;
  if (allowMissing && Array.isArray(versions) && versions.length === 0) {
    return null;
  }
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    !isRecord(versions[0]) ||
    versions[0].percentage !== 100 ||
    typeof versions[0].version_id !== 'string'
  ) {
    throw new Error(
      'The existing Worker must have one deployed version receiving all traffic. Finish any gradual rollout before linking.',
    );
  }
  const versionId = versions[0].version_id;
  const version = await read({ type: 'versions.view', versionId, ...target });
  if (version === null) {
    throw new Error('Cloudflare did not return the existing Worker configuration.');
  }
  const resources = version.resources;
  if (
    version.id !== versionId ||
    !isRecord(resources) ||
    !Array.isArray(resources.bindings) ||
    !resources.bindings.every(isRecord) ||
    !isRecord(resources.script_runtime) ||
    !isRecord(resources.script)
  ) {
    throw new Error('Cloudflare did not return the existing Worker configuration.');
  }
  let isSecretOnlyDraft = isWranglerSecretOnlyDraft(version);
  if (
    proveSecretDraft &&
    !isSecretOnlyDraft &&
    ((isRecord(version.annotations) &&
      Object.keys(version.annotations).length === 1 &&
      version.annotations['workers/triggered_by'] === 'secret') ||
      isVoidSecretDraftHeader(version))
  ) {
    const source = await read({ type: 'versions.view', versionId, includeSource: true, ...target });
    if (source?.id === versionId) {
      isSecretOnlyDraft = isVoidSecretOnlyDraft(source);
    }
  }
  const after = options.versionId
    ? deployment
    : await read({ type: 'deployments.status', ...target });
  if (after === null || !isDeepStrictEqual(deployment.versions, after.versions)) {
    throw new Error(
      'Cloudflare production changed while linking. Retry from the current deployment.',
    );
  }
  return {
    snapshot: {
      versionId,
      bindings: resources.bindings,
      runtime: resources.script_runtime,
      script: resources.script,
    },
    isSecretOnlyDraft,
  };
}

/** Parse legacy version-detail shapes; this is not authoritative Worker migration state. */
export function readCloudflareVersionMigrationTag(version: unknown): string | null {
  if (!isRecord(version)) {
    return null;
  }
  const resources = isRecord(version.resources) ? version.resources : undefined;
  const candidates = [
    resources && isRecord(resources.script_runtime) ? resources.script_runtime.migration_tag : null,
    resources && isRecord(resources.script) ? resources.script.migration_tag : null,
    isRecord(version.script) ? version.script.migration_tag : null,
    version.migration_tag,
  ];
  const tag = candidates.find((candidate) => typeof candidate === 'string');
  return typeof tag === 'string' && tag.length > 0 ? tag : null;
}

/** Read the authoritative migration tag from Worker script metadata. */
export async function readCloudflareWorkerMigrationTag(
  options: CloudflareWorkerMigrationTagOptions,
): Promise<string | null> {
  const auth = await readCloudflareApiAuthentication(options.runWrangler);
  const endpoint = `${options.apiBaseUrl.replace(/\/+$/, '')}/accounts/${encodeURIComponent(options.accountId)}/workers/scripts`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(
      `Could not verify Durable Object migration state for Cloudflare Worker "${options.workerName}".`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Cloudflare returned an invalid Durable Object migration response for Worker "${options.workerName}".`,
    );
  }
  if (!response.ok || !isRecord(body) || body.success !== true || !Array.isArray(body.result)) {
    throw new Error(
      `Could not verify Durable Object migration state for Cloudflare Worker "${options.workerName}".`,
    );
  }
  const worker = body.result.find(
    (candidate) => isRecord(candidate) && candidate.id === options.workerName,
  );
  if (!isRecord(worker)) {
    throw new Error(
      `Cloudflare did not return migration state for Worker "${options.workerName}".`,
    );
  }
  if (worker.migration_tag === undefined || worker.migration_tag === null) {
    return null;
  }
  if (typeof worker.migration_tag !== 'string' || worker.migration_tag.length === 0) {
    throw new Error(
      `Cloudflare returned an invalid Durable Object migration response for Worker "${options.workerName}".`,
    );
  }
  return worker.migration_tag;
}

async function readCloudflareApiAuthentication(
  runWrangler: CloudflareCommandRunner,
): Promise<Record<string, string>> {
  const result = await runWrangler({ type: 'auth.token' }, { capture: true });
  if (!isCleanCommandExit(result)) {
    throw new Error('Could not read the authenticated Cloudflare session.');
  }
  const value = result.data;
  if (!isRecord(value)) {
    throw new Error('Cloudflare returned an invalid authentication response.');
  }
  if (
    (value.type === 'oauth' || value.type === 'api_token') &&
    typeof value.token === 'string' &&
    value.token.length > 0
  ) {
    return { Authorization: `Bearer ${value.token}` };
  }
  if (
    value.type === 'api_key' &&
    typeof value.key === 'string' &&
    value.key.length > 0 &&
    typeof value.email === 'string' &&
    value.email.length > 0
  ) {
    return { 'X-Auth-Key': value.key, 'X-Auth-Email': value.email };
  }
  throw new Error('Cloudflare returned an invalid authentication response.');
}

/**
 * The Versions upload endpoint cannot safely apply a new Durable Object class migration to an
 * existing Worker in the native beta. Reject that pending lifecycle change before the caller
 * mutates a database or Worker secret; ordinary uploads whose migration tag is already active
 * continue normally.
 */
export async function assertCloudflareDurableObjectLifecycleSupported(options: {
  runWrangler: CloudflareCommandRunner;
  configPath: string;
  workerName: string;
  accountId: string;
  apiBaseUrl: string;
  readMigrationTag?: (options: CloudflareWorkerMigrationTagOptions) => Promise<string | null>;
  allowPendingAtomicMigration?: boolean;
}): Promise<void> {
  const migrations = parseDurableObjectMigrations(
    parseRootWranglerConfig(options.configPath).migrations,
  );
  if (!migrations.some((migration) => migration.changesClasses)) {
    return;
  }
  const existing = await readCloudflareWorker(options, true, true);
  if (!existing) {
    return;
  }
  const readMigrationTag = options.readMigrationTag ?? readCloudflareWorkerMigrationTag;
  const migrationOptions = {
    runWrangler: options.runWrangler,
    accountId: options.accountId,
    apiBaseUrl: options.apiBaseUrl,
    workerName: options.workerName,
  };
  const activeTag = await readMigrationTag(migrationOptions);
  const after = await readCloudflareWorker(options, false, true);
  const afterTag = await readMigrationTag(migrationOptions);
  if (
    !after ||
    after.snapshot.versionId !== existing.snapshot.versionId ||
    afterTag !== activeTag
  ) {
    throw new Error(
      'Cloudflare production or Durable Object migration state changed during verification. Retry from the current deployment.',
    );
  }
  // A retry after first-secret provisioning still needs its initial class migration. Use the
  // same complete-version check as activation, and require no prior class migration history.
  if (activeTag === null && existing.isSecretOnlyDraft && after.isSecretOnlyDraft) {
    return;
  }
  if (
    activeTag === null &&
    declarativeClassesMatch(migrations, existing.snapshot.runtime.exports)
  ) {
    return;
  }
  const activeIndex =
    activeTag === null ? -1 : migrations.findIndex((migration) => migration.tag === activeTag);
  const pending = migrations.slice(activeIndex + 1).filter((migration) => migration.changesClasses);
  if (pending.length === 0) {
    return;
  }
  if (options.allowPendingAtomicMigration === true) {
    return;
  }
  throw new Error(
    [
      'deploy: this Durable Object class migration needs an atomic Cloudflare deployment.',
      `Pending migration tag${pending.length === 1 ? '' : 's'}: ${pending.map((migration) => migration.tag).join(', ')}.`,
      'Review the migration, then run `void deploy --platform cloudflare --atomic`. The Worker will receive traffic before readiness is checked.',
      'No database migration or Worker secret was changed.',
    ].join('\n'),
  );
}

function parseDurableObjectMigrations(
  value: unknown,
): Array<{ tag: string; changesClasses: boolean; step: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('deploy: generated Cloudflare config has a malformed migrations field.');
  }
  return value.map((migration) => {
    if (!isRecord(migration) || typeof migration.tag !== 'string') {
      throw new Error('deploy: generated Cloudflare config has a malformed class migration.');
    }
    const fields = [
      migration.new_classes,
      migration.new_sqlite_classes,
      migration.renamed_classes,
      migration.deleted_classes,
    ];
    for (const field of fields) {
      if (field !== undefined && !Array.isArray(field)) {
        throw new Error('deploy: generated Cloudflare config has a malformed class migration.');
      }
    }
    return {
      tag: migration.tag,
      changesClasses: fields.some((field) => Array.isArray(field) && field.length > 0),
      step: migration,
    };
  });
}

/** Cloudflare's declarative exports replace the legacy migration tag after an atomic publish. */
function declarativeClassesMatch(
  migrations: Array<{ step: Record<string, unknown> }>,
  actualValue: unknown,
): boolean {
  if (!isRecord(actualValue)) {
    return false;
  }
  const desired = new Map<string, 'sqlite' | 'legacy-kv' | 'deleted'>();
  for (const { step } of migrations) {
    for (const [field, storage] of [
      ['new_classes', 'legacy-kv'],
      ['new_sqlite_classes', 'sqlite'],
    ] as const) {
      for (const name of (step[field] ?? []) as Array<string>) {
        if (typeof name !== 'string') {
          return false;
        }
        desired.set(name, storage);
      }
    }
    for (const item of (step.renamed_classes ?? []) as Array<unknown>) {
      if (!isRecord(item) || typeof item.from !== 'string' || typeof item.to !== 'string') {
        return false;
      }
      const storage = desired.get(item.from);
      if (storage !== 'sqlite' && storage !== 'legacy-kv') {
        return false;
      }
      desired.set(item.from, 'deleted');
      desired.set(item.to, storage);
    }
    for (const name of (step.deleted_classes ?? []) as Array<string>) {
      if (typeof name !== 'string') {
        return false;
      }
      desired.set(name, 'deleted');
    }
  }
  if (desired.size === 0) {
    return false;
  }
  return [...desired].every(([name, storage]) => {
    const current = actualValue[name];
    if (storage === 'deleted') {
      return current === undefined || (isRecord(current) && current.state === 'deleted');
    }
    return isRecord(current) && current.type === 'durable-object' && current.storage === storage;
  });
}

export function assertCloudflareBindingsPreserved(
  before: ExistingCloudflareWorker,
  after: ExistingCloudflareWorker,
  approvedKv: ReadonlyArray<ApprovedCloudflareKvBinding> = [],
  options: { staticAssetsBinding?: string } = {},
): void {
  // Only the static adapter may introduce its fetch wrapper around an assets-only
  // deployment. All existing bindings (including colliding names) remain protected.
  const staticAssetsBinding = isAssetsOnlyWorker(before) ? options.staticAssetsBinding : undefined;
  const addsAssetsBinding =
    staticAssetsBinding !== undefined &&
    !before.bindings.some((binding) => binding.name === staticAssetsBinding);
  const additions = newApprovedKvBindings(before, approvedKv);
  for (const addition of additions) {
    const matches = after.bindings.filter((binding) => binding.name === addition.binding);
    if (
      matches.length !== 1 ||
      matches[0]!.type !== 'kv_namespace' ||
      matches[0]!.namespace_id !== addition.id
    ) {
      throw new Error(
        `The uploaded version did not use the approved KV namespace for ${addition.binding}. It has not been activated.`,
      );
    }
  }
  const preservedBindings = after.bindings.filter(
    (binding) => !additions.some((addition) => addition.binding === binding.name),
  );
  const sorted = (bindings: ExistingCloudflareWorker['bindings']) =>
    [...bindings].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const expectedBindings = addsAssetsBinding
    ? [...before.bindings, { type: 'assets', name: staticAssetsBinding }]
    : before.bindings;
  if (
    (staticAssetsBinding !== undefined &&
      !after.bindings.some(
        (binding) => binding.type === 'assets' && binding.name === staticAssetsBinding,
      )) ||
    !isDeepStrictEqual(sorted(expectedBindings), sorted(preservedBindings))
  ) {
    throw new Error(
      'The uploaded version did not preserve the existing Worker bindings and variables. It has not been activated.',
    );
  }
  const handlers = (worker: ExistingCloudflareWorker): Array<string> | null => {
    const value = existingWorkerHandlers(worker);
    return Array.isArray(value) &&
      value.every((handler): handler is string => typeof handler === 'string')
      ? [...new Set(value)].sort()
      : null;
  };
  const expectedHandlers = staticAssetsBinding !== undefined ? ['fetch'] : handlers(before);
  if (!isDeepStrictEqual(expectedHandlers, handlers(after))) {
    throw new Error(
      'The uploaded version did not preserve the existing Worker event handlers. It has not been activated.',
    );
  }
}

function isAssetsOnlyWorker(worker: ExistingCloudflareWorker): boolean {
  const handlers = worker.script.handlers;
  return (
    isRecord(worker.runtime.assets) &&
    (handlers === null || (Array.isArray(handlers) && handlers.length === 0))
  );
}

function existingWorkerHandlers(worker: ExistingCloudflareWorker): unknown {
  // Cloudflare represents the absence of a script on assets-only Workers as null.
  // Missing or malformed handler metadata on other Workers must still fail closed.
  return isAssetsOnlyWorker(worker) ? [] : worker.script.handlers;
}

/** Preserve the existing Worker, allowing only explicitly approved KV additions. */
export function assertExistingCloudflareConfig(
  existing: ExistingCloudflareWorker,
  config: Record<string, unknown>,
  built = false,
  approvedKv: ReadonlyArray<ApprovedCloudflareKvBinding> = [],
): void {
  const additions = newApprovedKvBindings(existing, approvedKv);
  if (additions.length > 0) {
    const entries = config.kv_namespaces;
    for (const addition of additions) {
      const matches = Array.isArray(entries)
        ? entries.filter((entry) => isRecord(entry) && entry.binding === addition.binding)
        : [];
      if (
        (built || matches.length > 0) &&
        (matches.length !== 1 || matches[0]!.id !== addition.id)
      ) {
        throw new Error(
          `Binding ${addition.binding} must reference its approved KV namespace when linking.`,
        );
      }
    }
    if (Array.isArray(entries)) {
      config = {
        ...config,
        kv_namespaces: entries.filter(
          (entry) =>
            !isRecord(entry) || !additions.some((addition) => addition.binding === entry.binding),
        ),
      };
    }
  }
  const handlers = existingWorkerHandlers(existing);
  if (
    !Array.isArray(handlers) ||
    handlers.some((handler) => handler !== 'fetch' && handler !== 'scheduled')
  ) {
    throw new Error(
      'Linking an existing Worker currently supports fetch and scheduled handlers only. Queue and Durable Object handlers need a separate migration.',
    );
  }
  for (const field of [
    'durable_objects',
    'migrations',
    'exports',
    'containers',
    'workflows',
    'queues',
    'triggers',
  ]) {
    const value = config[field];
    if (hasContent(value)) {
      throw new Error(
        `The existing Worker handoff cannot change ${field}. Keep this deployment limited to the existing site.`,
      );
    }
  }
  if (
    isRecord(existing.runtime.exports) &&
    Object.values(existing.runtime.exports).some(
      (value) => isRecord(value) && value.type !== 'worker',
    )
  ) {
    throw new Error(
      'The existing Worker exports stateful classes. Migrate those classes separately before linking.',
    );
  }
  for (const field of ['compatibility_date', 'compatibility_flags', 'limits']) {
    const expected = existing.runtime[field] ?? (field === 'compatibility_flags' ? [] : undefined);
    const actual = config[field] ?? (field === 'compatibility_flags' ? [] : undefined);
    const equal =
      field === 'compatibility_flags'
        ? stringSetEqual(actual, expected)
        : isDeepStrictEqual(actual, expected);
    if ((built || config[field] !== undefined) && !equal) {
      throw new Error(
        `Keep the existing Worker's ${field} when linking. Update it in a later deployment.`,
      );
    }
  }
  const vars = isRecord(config.vars) ? config.vars : {};
  const metadataBindings = existing.bindings.filter(
    (binding) => binding.type === 'version_metadata',
  );
  const metadata = isRecord(config.version_metadata) ? config.version_metadata : undefined;
  if (
    metadataBindings.length > 1 ||
    (metadataBindings.length === 1 && metadata?.binding !== metadataBindings[0]!.name) ||
    (metadataBindings.length === 0 && config.version_metadata !== undefined)
  ) {
    throw new Error(
      'Keep the existing Worker version_metadata binding when linking; linking cannot add or replace it.',
    );
  }
  const remote = new Map(existing.bindings.map((binding) => [binding.name, binding]));
  for (const [name, value] of Object.entries(vars)) {
    const binding = remote.get(name);
    const expected =
      binding?.type === 'plain_text'
        ? binding.text
        : binding?.type === 'json'
          ? binding.json
          : undefined;
    if (
      !binding ||
      !['plain_text', 'json'].includes(String(binding.type)) ||
      !isDeepStrictEqual(value, expected)
    ) {
      throw new Error(
        `Variable ${name} differs from the existing Worker. Preserve production variables and secrets when linking.`,
      );
    }
  }
  const supported: Record<string, [string, string, string]> = {
    d1: ['d1_databases', 'database_id', 'id'],
    kv_namespace: ['kv_namespaces', 'id', 'namespace_id'],
    r2_bucket: ['r2_buckets', 'bucket_name', 'bucket_name'],
    service: ['services', 'service', 'service'],
    hyperdrive: ['hyperdrive', 'id', 'id'],
  };
  const found = new Set<string>();
  for (const binding of existing.bindings) {
    if (typeof binding.name !== 'string') {
      throw new Error('Cloudflare returned a binding without a name.');
    }
    if (['plain_text', 'json', 'secret_text', 'secret_key'].includes(String(binding.type))) {
      continue;
    }
    if (binding.type === 'version_metadata') {
      continue;
    }
    if (binding.type === 'assets') {
      if (built && (!isRecord(config.assets) || config.assets.binding !== binding.name)) {
        throw new Error(`Keep the existing assets binding ${binding.name} when linking.`);
      }
      continue;
    }
    const mapping = supported[String(binding.type)];
    if (!mapping) {
      throw new Error(
        `The existing binding ${binding.name} (${String(binding.type)}) is not yet supported when linking.`,
      );
    }
    const [field, localId, remoteId] = mapping;
    const entries = config[field];
    const matches = Array.isArray(entries)
      ? entries.filter((entry) => isRecord(entry) && entry.binding === binding.name)
      : [];
    const entry = matches[0];
    if (
      matches.length !== 1 ||
      !isRecord(entry) ||
      typeof binding[remoteId] !== 'string' ||
      entry[localId] !== binding[remoteId] ||
      (binding.type === 'service' &&
        ((entry.environment ?? 'production') !== (binding.environment ?? 'production') ||
          entry.entrypoint !== binding.entrypoint)) ||
      (binding.type === 'r2_bucket' &&
        (entry.jurisdiction ?? 'default') !== (binding.jurisdiction ?? 'default'))
    ) {
      throw new Error(
        `Binding ${binding.name} must reference the existing Cloudflare resource when linking.`,
      );
    }
    found.add(binding.name);
  }
  for (const [field] of Object.values(supported)) {
    const entries = config[field];
    if (
      Array.isArray(entries) &&
      entries.some((entry) => !isRecord(entry) || !found.has(String(entry.binding)))
    ) {
      throw new Error(
        `Linking cannot add or replace ${field}. Use the existing resource bindings.`,
      );
    }
  }
}

function newApprovedKvBindings(
  existing: ExistingCloudflareWorker,
  approved: ReadonlyArray<ApprovedCloudflareKvBinding>,
): Array<ApprovedCloudflareKvBinding> {
  const additions: Array<ApprovedCloudflareKvBinding> = [];
  const names = new Set<string>();
  for (const binding of approved) {
    if (!binding.binding || names.has(binding.binding) || !/^[a-f0-9]{32}$/i.test(binding.id)) {
      throw new Error('Invalid approved KV binding identity.');
    }
    names.add(binding.binding);
    const previous = existing.bindings.filter((entry) => entry.name === binding.binding);
    if (previous.length > 0) {
      if (
        previous.length !== 1 ||
        previous[0]!.type !== 'kv_namespace' ||
        previous[0]!.namespace_id !== binding.id
      ) {
        throw new Error(
          `The approved KV binding ${binding.binding} cannot replace an existing binding.`,
        );
      }
    } else {
      if (
        existing.bindings.some(
          (entry) => entry.type === 'kv_namespace' && entry.namespace_id === binding.id,
        ) ||
        additions.some((entry) => entry.id === binding.id)
      ) {
        throw new Error(
          `The approved KV binding ${binding.binding} must use a separate namespace from existing bindings.`,
        );
      }
      additions.push(binding);
    }
  }
  return additions;
}

function stringSetEqual(left: unknown, right: unknown): boolean {
  if (
    !Array.isArray(left) ||
    !left.every((value): value is string => typeof value === 'string') ||
    !Array.isArray(right) ||
    !right.every((value): value is string => typeof value === 'string')
  ) {
    return false;
  }
  return isDeepStrictEqual([...new Set(left)].sort(), [...new Set(right)].sort());
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.values(value).some(hasContent);
  }
  return true;
}
