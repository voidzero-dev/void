/**
 * The runtime copy's Cloudflare side (M30, spec §8.6). `SecurityScanControl.copy`: fence ─►
 * plan ─► snapshot modules ─► empty D1 / KV / R2 (D1 gets the live schema, no rows) ─►
 * upload `void-sec-copy-<h>-<scan>-a<n>` with guard + entry modules ─► cost on the meter.
 * The result path deletes it; the hourly reaper deletes any copy whose attempt is over.
 * Names carry installation, scan and attempt, so leftovers are found from Cloudflare's own
 * lists. The live app is never touched beyond one `sqlite_master` read.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { getProjectResources } from '../db/resources.ts';
import { getProjectSecrets } from '../db/secrets.ts';
import type { ApiEnv } from '../env.ts';
import { decryptProjectSecret } from '../project-secrets.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import { securityScannerNames, securityScannerTarget } from '../provisioning/security-scanner.ts';
import type { SecurityScannerTarget } from '../provisioning/security-scanner.ts';
import { deployments, projects } from '../schema.ts';
import { errorMessage } from '../zero-trust/errors.ts';
import { chargeSecurityScanCopy } from './budget.ts';
import { checkScanFence } from './fence.ts';
import { modulesKey, parseSnapshotModules } from './input/prepare.ts';
import { createSecurityRedactor } from './input/redact.ts';
import type { SecuritySecret } from './input/redact.ts';
import { SECURITY_RUNTIME_COPY_NOT_MADE_NOTE } from './input/tier.ts';
import { readSecurityManifest } from './manifest.ts';
import { securityScanAt } from './queue.ts';
import { runtimeCopyScriptName, runtimeCopyStoreOwner } from './runtime-copy-names.ts';
import {
  planSecurityRuntimeCopy,
  SECURITY_COPY_FAKE_PREFIX,
  SECURITY_COPY_PLATFORM_FAKES,
  securityRuntimeCopyMetadata,
} from './runtime-copy-plan.ts';
import type { SecurityCopyPlan } from './runtime-copy-plan.ts';
import {
  COPY_ENTRY_MODULE_NAME,
  COPY_GUARD_MODULE,
  COPY_GUARD_MODULE_NAME,
  copyEntryModule,
} from './runtime-copy-sources.ts';
import { securityScans } from './schema.ts';

/** The copy holds the deployed modules in memory for the upload: at most this many bytes. */
const SECURITY_COPY_MAX_MODULE_BYTES = 32 * 1024 * 1024;
/** Schema statements replayed into one copy D1, at most. */
const SECURITY_COPY_MAX_SCHEMA_STATEMENTS = 500;

/** List prices behind the copy's charge (2026-11): a script hour, D1 row writes, R2 class A. */
const SECURITY_COPY_PRICES_NANO = {
  scriptHour: Math.round((0.02 / 730) * 1e9),
  d1RowWritten: 1000,
  r2ClassA: 4500,
  kvWrite: 5000,
} as const;

async function securityCopyTarget(target: SecurityScannerTarget): Promise<SecurityCopyTarget> {
  const names = await securityScannerNames(target.installationKey);
  return {
    accountId: target.accountId,
    apiToken: target.apiToken,
    namespace: names.copyNamespace,
    sandbox: names.copySandbox,
    prefix: names.copyPrefix,
  };
}

type SecurityCopyModule = Readonly<{ name: string; type: string; bytes: Uint8Array }>;

type SecurityCopyInput = Readonly<{
  plan: SecurityCopyPlan;
  modules: ReadonlyArray<SecurityCopyModule>;
  /** Copy D1 binding → the live D1 uuid whose schema it gets. */
  liveD1: ReadonlyMap<string, string>;
  projectId: string;
  projectSlug: string;
  /** Random bytes for the fake values (tests pass a fixed source). */
  random?: (bytes: number) => Uint8Array;
  /** Whether a text holds a stored secret value (§7.3); the live schema is checked with it. */
  holdsSecret?: (text: string) => boolean;
}>;

/** A copy that must not be made (not a failure): the scan runs static-only. */
export class SecurityCopySkipped extends Error {
  constructor(readonly reason: string) {
    super(`runtime copy skipped: ${reason}`);
  }
}

type SecurityCopyCreated = Readonly<{
  script: string;
  /** Statements replayed per copy D1 binding. */
  schema: Readonly<Record<string, number>>;
  costNano: number;
  ms: number;
}>;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fakeValue(name: string, random: (bytes: number) => Uint8Array): string {
  return `${SECURITY_COPY_FAKE_PREFIX}${name.toLowerCase()}-${hex(random(12))}`;
}

function defaultRandom(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

type SchemaRow = { type?: unknown; name?: unknown; sql?: unknown };

/** The schema of a live D1, as CREATE statements in an order that replays. No rows. */
const SCHEMA_QUERY =
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, rowid";

/** Shadow tables a virtual table's CREATE makes itself (FTS5, FTS3/4, R*Tree). */
const SHADOW_SUFFIXES =
  '_data _idx _content _docsize _config _segments _segdir _stat _node _rowid _parent'.split(' ');

/** `sqlite_master` rows as statements, without virtual tables' own shadow tables. */
function securityCopySchemaStatements(rows: ReadonlyArray<SchemaRow>): Array<string> {
  const shadows = new Set<string>();
  for (const row of rows) {
    if (
      row.type === 'table' &&
      typeof row.sql === 'string' &&
      row.sql.trimStart().toUpperCase().startsWith('CREATE VIRTUAL TABLE') &&
      typeof row.name === 'string'
    ) {
      for (const suffix of SHADOW_SUFFIXES) {
        shadows.add(`${row.name}${suffix}`);
      }
    }
  }
  const statements = rows.flatMap((row) =>
    typeof row.sql === 'string' &&
    typeof row.name === 'string' &&
    !(row.type === 'table' && shadows.has(row.name))
      ? [row.sql]
      : [],
  );
  return statements.slice(0, SECURITY_COPY_MAX_SCHEMA_STATEMENTS);
}

async function d1Query(
  target: SecurityCopyTarget,
  databaseId: string,
  sql: string,
): Promise<Array<{ results?: Array<SchemaRow>; meta?: { rows_written?: number } }>> {
  return cfFetch(
    `${CF_API_BASE}/${target.accountId}/d1/database/${databaseId}/query`,
    target.apiToken,
    { method: 'POST', body: JSON.stringify({ sql }) },
  );
}

async function createStore(
  target: SecurityCopyTarget,
  kind: 'd1' | 'kv' | 'r2',
  name: string,
): Promise<CreatedStore> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  if (kind === 'd1') {
    const db = await cfFetch<{ uuid: string }>(`${base}/d1/database`, target.apiToken, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return { kind, name, id: db.uuid };
  }
  if (kind === 'kv') {
    const ns = await cfFetch<{ id: string }>(`${base}/storage/kv/namespaces`, target.apiToken, {
      method: 'POST',
      body: JSON.stringify({ title: name }),
    });
    return { kind, name, id: ns.id };
  }
  await cfFetch(`${base}/r2/buckets`, target.apiToken, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return { kind, name, id: name };
}

/** Creates one copy; on a failure what it made is deleted again (best effort) and it throws. */
export async function createSecurityRuntimeCopy(
  target: SecurityCopyTarget,
  input: SecurityCopyInput,
): Promise<SecurityCopyCreated> {
  const started = Date.now();
  const { plan } = input;
  const random = input.random ?? defaultRandom;
  const created: Array<CreatedStore> = [];
  let uploaded = false;
  try {
    // 1. Empty stores, in parallel; each is recorded as soon as it exists.
    await settleAll(plan.stores, async (store) => {
      created.push(await createStore(target, store.kind, store.name));
    });
    const ids = new Map(created.map((store) => [store.name, store.id]));

    // 2. D1: the live schema, no rows.
    let costNano = SECURITY_COPY_PRICES_NANO.scriptHour;
    const schema: Record<string, number> = {};
    for (const store of plan.stores) {
      if (store.kind === 'r2') {
        costNano += SECURITY_COPY_PRICES_NANO.r2ClassA;
        continue;
      }
      if (store.kind !== 'd1') {
        continue;
      }
      const live = input.liveD1.get(store.binding);
      schema[store.binding] = 0;
      if (live === undefined) {
        continue;
      }
      const [read] = await d1Query(target, live, SCHEMA_QUERY);
      const statements = securityCopySchemaStatements(read?.results ?? []);
      const { holdsSecret } = input;
      if (holdsSecret && statements.some((statement) => holdsSecret(statement))) {
        throw new SecurityCopySkipped('secret_in_schema');
      }
      schema[store.binding] = statements.length;
      if (statements.length === 0) {
        continue;
      }
      const storeId = ids.get(store.name);
      if (storeId === undefined) {
        throw new Error(`The D1 copy ${store.name} was not created.`);
      }
      const written = await d1Query(target, storeId, `${statements.join(';\n')};`);
      for (const entry of written ?? []) {
        costNano += (entry.meta?.rows_written ?? 0) * SECURITY_COPY_PRICES_NANO.d1RowWritten;
      }
    }

    // 3. The copy script: guard + entry + the deployed modules, bindings rewired.
    const fakes = new Map<string, string>();
    for (const name of [...plan.fakes, ...SECURITY_COPY_PLATFORM_FAKES]) {
      fakes.set(name, fakeValue(name, random));
    }
    const metadata = securityRuntimeCopyMetadata(
      plan,
      { sandbox: target.sandbox },
      { ids, fakes, projectId: input.projectId, projectSlug: input.projectSlug },
    );
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    const js = { type: 'application/javascript+module' };
    const entry = copyEntryModule(plan.mainModule);
    form.append(COPY_ENTRY_MODULE_NAME, new File([entry], COPY_ENTRY_MODULE_NAME, js));
    form.append(COPY_GUARD_MODULE_NAME, new File([COPY_GUARD_MODULE], COPY_GUARD_MODULE_NAME, js));
    for (const module of input.modules) {
      form.append(
        module.name,
        new File([module.bytes as BlobPart], module.name, { type: module.type }),
      );
    }
    uploaded = true;
    const response = await fetch(securityCopyScriptUrl(target, plan.script), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${target.apiToken}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(
        `runtime copy upload failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }
    return { script: plan.script, schema, costNano, ms: Date.now() - started };
  } catch (error) {
    await rollback(target, plan.script, uploaded, created);
    throw error;
  }
}

async function rollback(
  target: SecurityCopyTarget,
  script: string,
  uploaded: boolean,
  created: ReadonlyArray<CreatedStore>,
): Promise<void> {
  try {
    if (uploaded) {
      await deleteCopyScript(target, script);
    }
    await Promise.allSettled(created.map((store) => deleteStore(target, store)));
  } catch (error) {
    console.error('[security-copy] rollback left resources for the reaper', {
      script,
      error: errorMessage(error),
    });
  }
}

// --- Listing and deleting copies by name (the result path, the reaper, uninstall) ---

export type SecurityCopyTarget = Readonly<{
  accountId: string;
  apiToken: string;
  /** Dispatch namespace of this installation's copies. */
  namespace: string;
  sandbox: string;
  /** Every copy resource name of this installation starts with it. */
  prefix: string;
}>;

function securityCopyScriptUrl(target: SecurityCopyTarget, script: string): string {
  return `${CF_API_BASE}/${target.accountId}/workers/dispatch/namespaces/${target.namespace}/scripts/${script}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** `run`, with a Cloudflare 404 answered as `missing`. */
async function unless404<T, Missing>(
  run: () => Promise<T>,
  missing: Missing,
): Promise<T | Missing> {
  try {
    return await run();
  } catch (error) {
    if (isNotFound(error)) {
      return missing;
    }
    throw error;
  }
}

/** Runs every task, then throws the first failure. */
async function settleAll<T, R>(items: ReadonlyArray<T>, run: (item: T) => Promise<R>) {
  const results = await Promise.allSettled(items.map(run));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
}

type CreatedStore = { kind: 'd1' | 'kv' | 'r2'; name: string; id: string };

async function deleteStore(target: SecurityCopyTarget, store: CreatedStore): Promise<void> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  const url =
    store.kind === 'd1'
      ? `${base}/d1/database/${store.id}`
      : store.kind === 'kv'
        ? `${base}/storage/kv/namespaces/${store.id}`
        : `${base}/r2/buckets/${store.name}`;
  await unless404(() => cfFetch(url, target.apiToken, { method: 'DELETE' }), null);
}

async function deleteCopyScript(target: SecurityCopyTarget, script: string): Promise<void> {
  const url = `${securityCopyScriptUrl(target, script)}?force=true`;
  await unless404(() => cfFetch(url, target.apiToken, { method: 'DELETE' }), null);
}

type SecurityCopyResources = Readonly<{
  scripts: ReadonlyArray<string>;
  stores: ReadonlyArray<CreatedStore>;
}>;

const PAGE = 100;

/** Every resource whose name starts with `namePart` (the prefix, or one copy's script). */
async function listSecurityRuntimeCopyResources(
  target: SecurityCopyTarget,
  namePart: string,
): Promise<SecurityCopyResources> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  // No copy namespace (none yet, or uninstall removed it): stores may still be left.
  const scripts = await unless404(
    () =>
      cfFetch<Array<{ id?: unknown }>>(
        `${base}/workers/dispatch/namespaces/${target.namespace}/scripts`,
        target.apiToken,
      ),
    [],
  );
  const mine = (name: unknown): name is string =>
    typeof name === 'string' && name.startsWith(namePart);
  const stores: Array<CreatedStore> = [];
  const pages = async <Row>(url: string, take: (row: Row) => void) => {
    for (let page = 1; page <= 50; page++) {
      const rows = await cfFetch<Array<Row>>(
        `${url}per_page=${PAGE}&page=${page}`,
        target.apiToken,
      );
      rows.forEach(take);
      if (rows.length < PAGE) {
        break;
      }
    }
  };
  await pages<{ uuid?: unknown; name?: unknown }>(
    `${base}/d1/database?name=${encodeURIComponent(namePart)}&`,
    (row) => {
      if (mine(row.name) && typeof row.uuid === 'string') {
        stores.push({ kind: 'd1', name: row.name, id: row.uuid });
      }
    },
  );
  await pages<{ id?: unknown; title?: unknown }>(`${base}/storage/kv/namespaces?`, (row) => {
    if (mine(row.title) && typeof row.id === 'string') {
      stores.push({ kind: 'kv', name: row.title, id: row.id });
    }
  });
  const buckets = await cfFetch<{ buckets?: Array<{ name?: unknown }> }>(
    `${base}/r2/buckets?name_contains=${encodeURIComponent(namePart)}&per_page=1000`,
    target.apiToken,
  );
  for (const bucket of buckets?.buckets ?? []) {
    if (mine(bucket.name)) {
      stores.push({ kind: 'r2', name: bucket.name, id: bucket.name });
    }
  }
  return { scripts: scripts.map((script) => script.id).filter(mine), stores };
}

/**
 * Deletes every copy resource whose script is not in `keep`, scripts first, then stores;
 * returns the copies deleted. A `keep` function is called after the listing, so a scan
 * that starts meanwhile is still kept.
 */
async function sweepSecurityRuntimeCopies(
  target: SecurityCopyTarget,
  keep: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
  namePart: string = target.prefix,
): Promise<number> {
  const found = await listSecurityRuntimeCopyResources(target, namePart);
  const kept = typeof keep === 'function' ? await keep() : keep;
  return deleteListedCopies(target, found, kept);
}

async function deleteListedCopies(
  target: SecurityCopyTarget,
  found: SecurityCopyResources,
  keep: ReadonlySet<string>,
): Promise<number> {
  const scripts = found.scripts.filter((script) => !keep.has(script));
  for (const script of scripts) {
    await deleteCopyScript(target, script);
  }
  const stores = found.stores.filter((store) => !keep.has(runtimeCopyStoreOwner(store.name)));
  await settleAll(stores, (store) => deleteStore(target, store));
  return new Set([...scripts, ...stores.map((store) => runtimeCopyStoreOwner(store.name))]).size;
}

type ScriptBinding = {
  type?: unknown;
  id?: unknown;
  namespace_id?: unknown;
  bucket_name?: unknown;
};

/**
 * One copy, without listing the account: the script's bindings name its stores. No script:
 * no copy was uploaded (stores a crash left before the upload are the reaper's).
 */
async function deleteSecurityRuntimeCopy(target: SecurityCopyTarget, script: string) {
  const settings = await unless404(
    () =>
      cfFetch<{ bindings?: Array<ScriptBinding> }>(
        `${securityCopyScriptUrl(target, script)}/settings`,
        target.apiToken,
      ),
    'missing' as const,
  );
  if (settings === 'missing') {
    return;
  }
  const bindings = settings?.bindings ?? [];
  const own = `${script}-`;
  const stores: Array<CreatedStore> = [];
  for (const binding of bindings) {
    if (binding.type === 'd1' && typeof binding.id === 'string') {
      stores.push({ kind: 'd1', name: own, id: binding.id });
    } else if (binding.type === 'kv_namespace' && typeof binding.namespace_id === 'string') {
      stores.push({ kind: 'kv', name: own, id: binding.namespace_id });
    } else if (
      binding.type === 'r2_bucket' &&
      typeof binding.bucket_name === 'string' &&
      binding.bucket_name.startsWith(own)
    ) {
      stores.push({ kind: 'r2', name: binding.bucket_name, id: binding.bucket_name });
    }
  }
  await deleteCopyScript(target, script);
  await settleAll(stores, async (store) => {
    // A D1 or KV binding names only an id: its name must prove it is this copy's.
    if (store.kind === 'r2' || (await storeNamedFor(target, store, own))) {
      await deleteStore(target, store);
    }
  });
}

async function storeNamedFor(
  target: SecurityCopyTarget,
  store: CreatedStore,
  own: string,
): Promise<boolean> {
  const base = `${CF_API_BASE}/${target.accountId}`;
  const d1 = store.kind === 'd1';
  const url = d1 ? `${base}/d1/database/${store.id}` : `${base}/storage/kv/namespaces/${store.id}`;
  const found = await unless404(
    () => cfFetch<{ name?: unknown; title?: unknown }>(url, target.apiToken),
    null,
  );
  const name = d1 ? found?.name : found?.title;
  return typeof name === 'string' && name.startsWith(own);
}

// --- Database side: which scan, which deployment, the meter ---

export type SecurityCopyOutcome =
  | Readonly<{ ok: true; script: string; ms: number }>
  | Readonly<{ ok: false; reason: string }>;

type CopyEnv = Pick<
  ApiEnv['Bindings'],
  | 'CF_ACCOUNT_ID'
  | 'CF_API_TOKEN'
  | 'SANDBOX_CONTROL_SERVICE'
  | 'DISPATCH_NAMESPACE'
  | 'PLATFORM_INSTALLATION_ID'
  | 'STATIC_ASSETS_R2'
  | 'PROJECT_SECRET_KEYS_JSON'
  | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
>;

const moduleText = new TextDecoder('utf-8', { fatal: false });

/**
 * The model input's redaction (§7.3) as a yes/no: the copy runs the raw bundle, so one whose
 * code, vars or schema hold a stored secret value is not made.
 */
function secretCheck(secrets: ReadonlyArray<SecuritySecret>): (text: string) => boolean {
  const redactor = createSecurityRedactor(secrets);
  return (text) => redactor.redact(text) !== text;
}

async function readModules(
  r2: R2Bucket,
  prefix: string,
): Promise<Array<SecurityCopyModule> | null> {
  const listed = await r2.get(modulesKey(prefix));
  const entries = parseSnapshotModules(listed ? await listed.text() : null);
  if (!entries) {
    return null;
  }
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > SECURITY_COPY_MAX_MODULE_BYTES) {
    return null;
  }
  const modules: Array<SecurityCopyModule> = [];
  for (const entry of entries) {
    const object = await r2.get(entry.key);
    if (!object) {
      return null;
    }
    modules.push({
      name: entry.name,
      type: entry.type,
      bytes: new Uint8Array(await object.arrayBuffer()),
    });
  }
  return modules;
}

/** Makes the copy for one running attempt; never throws (no copy: the scan runs static-only). */
export async function prepareSecurityRuntimeCopy(
  env: CopyEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<SecurityCopyOutcome> {
  if (!(await checkScanFence(db, scanId, attempt)).ok) {
    return { ok: false, reason: 'fence' };
  }
  const [row] = await db
    .select({
      projectId: securityScans.project_id,
      engine: securityScans.engine,
      inputR2Key: securityScans.input_r2_key,
      manifest: deployments.manifest,
      slug: projects.slug,
    })
    .from(securityScans)
    .innerJoin(projects, eq(projects.id, securityScans.project_id))
    .leftJoin(deployments, eq(deployments.id, securityScans.deployment_id))
    .where(and(eq(securityScans.id, scanId), eq(securityScans.attempt, attempt)))
    .limit(1);
  if (!row || row.engine === null) {
    return { ok: false, reason: 'fence' };
  }
  const target = await securityCopyTarget(securityScannerTarget(env));
  const secretRows = await getProjectSecrets(db, row.projectId);
  const plan = planSecurityRuntimeCopy(readSecurityManifest(row.manifest), {
    engine: row.engine,
    script: runtimeCopyScriptName(target.prefix, scanId, attempt),
    secretNames: secretRows.map((secret) => secret.name),
  });
  if (plan.kind === 'skip') {
    return { ok: false, reason: plan.reason };
  }
  if (!row.inputR2Key) {
    return { ok: false, reason: 'input_missing' };
  }
  const modules = await readModules(env.STATIC_ASSETS_R2, row.inputR2Key);
  if (!modules) {
    return { ok: false, reason: 'input_missing' };
  }
  let holdsSecret: (text: string) => boolean;
  try {
    const secrets: Array<SecuritySecret> = [];
    for (const secret of secretRows) {
      secrets.push({
        name: secret.name,
        value: await decryptProjectSecret(env, row.projectId, secret),
      });
    }
    holdsSecret = secretCheck(secrets);
  } catch {
    // A secret that cannot be read cannot be checked for: no copy.
    return { ok: false, reason: 'secret_unreadable' };
  }
  if (
    modules.some((module) => holdsSecret(moduleText.decode(module.bytes))) ||
    plan.vars.some((variable) => holdsSecret(variable.value))
  ) {
    return { ok: false, reason: 'secret_in_bundle' };
  }
  const liveD1 = new Map<string, string>();
  for (const resource of await getProjectResources(db, row.projectId)) {
    if (resource.type === 'd1') {
      liveD1.set(resource.binding_name, resource.cf_id);
    }
  }
  try {
    const created = await createSecurityRuntimeCopy(target, {
      plan,
      modules,
      liveD1,
      projectId: row.projectId,
      projectSlug: row.slug,
      holdsSecret,
    });
    let charged: boolean;
    try {
      charged = await chargeSecurityScanCopy(db, {
        scanId,
        attempt,
        projectId: row.projectId,
        nano: created.costNano,
      });
    } catch (error) {
      await dropCopy(target, created.script, scanId, attempt);
      throw error;
    }
    if (!charged) {
      // The attempt ended meanwhile: its result path may have deleted already, so drop it now.
      await dropCopy(target, created.script, scanId, attempt);
      return { ok: false, reason: 'fence' };
    }
    console.log('[security-copy] copy ready', {
      scanId,
      attempt,
      ms: created.ms,
      stores: plan.stores.length,
      dropped: plan.dropped,
    });
    return { ok: true, script: created.script, ms: created.ms };
  } catch (error) {
    if (error instanceof SecurityCopySkipped) {
      return { ok: false, reason: error.reason };
    }
    console.error('[security-copy] copy failed', { scanId, attempt, error: errorMessage(error) });
    return { ok: false, reason: 'create_failed' };
  }
}

async function dropCopy(
  target: SecurityCopyTarget,
  script: string,
  scanId: string,
  attempt: number,
): Promise<void> {
  try {
    await deleteSecurityRuntimeCopy(target, script);
  } catch (error) {
    const failure = { scanId, attempt, error: errorMessage(error) };
    console.error('[security-copy] copy delete failed; the reaper retries', failure);
  }
}

/** Not a failure: the attempt is over (`fence`), or no copy by design (plan skips). */
const COPY_NOT_WANTED: ReadonlySet<string> = new Set(['fence', 'no_manifest', 'static', 'engine']);

/** The coverage note for a copy that was wanted and not made: the scan ran static-only. */
function securityRuntimeCopyNote(outcome: SecurityCopyOutcome): string | null {
  if (outcome.ok || COPY_NOT_WANTED.has(outcome.reason)) {
    return null;
  }
  return `${SECURITY_RUNTIME_COPY_NOT_MADE_NOTE} (${outcome.reason})`;
}

/** Adds the copy's coverage note to the running attempt once (the scan ran static-only). */
export async function noteSecurityRuntimeCopyOutcome(
  db: Db,
  scanId: string,
  attempt: number,
  outcome: SecurityCopyOutcome,
): Promise<void> {
  const note = securityRuntimeCopyNote(outcome);
  if (note === null) {
    return;
  }
  await db
    .update(securityScans)
    .set({ coverage_notes: sql`array_append(${securityScans.coverage_notes}, ${note})` })
    .where(
      and(
        securityScanAt(scanId, attempt),
        sql`NOT (${note} = ANY(${securityScans.coverage_notes}))`,
      ),
    );
}

/** After the result is stored: this attempt's copy goes (the reaper retries a failure). */
export async function deleteSecurityRuntimeCopyForScan(
  env: CopyEnv,
  scanId: string,
  attempt: number,
): Promise<void> {
  const target = await securityCopyTarget(securityScannerTarget(env));
  await deleteSecurityRuntimeCopy(target, runtimeCopyScriptName(target.prefix, scanId, attempt));
}

/**
 * Hourly: every copy whose attempt is not running. Running scans are read after the listing
 * (a copy is made only after its fence passed), so a listed copy not running is finished.
 */
export async function reapSecurityRuntimeCopies(env: CopyEnv, db: Db): Promise<number> {
  const target = await securityCopyTarget(securityScannerTarget(env));
  return sweepSecurityRuntimeCopies(target, async () => {
    const running = await db
      .select({ id: securityScans.id, attempt: securityScans.attempt })
      .from(securityScans)
      .where(eq(securityScans.status, 'running'));
    return new Set(
      running.map((scan) => runtimeCopyScriptName(target.prefix, scan.id, scan.attempt)),
    );
  });
}
