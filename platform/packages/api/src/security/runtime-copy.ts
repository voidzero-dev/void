/**
 * The runtime copy's Cloudflare side (design doc 0095, M30; spec §8.6; spike S13).
 *
 *   SecurityScanControl.copy(scan, attempt)            (the controller asks, after the runner starts)
 *     fence ─► plan (manifest, secret names) ─► modules from the scan snapshot (R2)
 *     ─► empty D1 / KV / R2 in parallel ─► D1: the live database's schema, no rows
 *     ─► upload `void-sec-copy-<h>-<scan>-a<n>` into the copy namespace:
 *          guard + entry modules, the deployed modules unchanged, rewired bindings
 *     ─► cost on the scan meter
 *   SecurityScanControl.result ─► deleteSecurityRuntimeCopy (script, then its stores)
 *   hourly reaper ─► sweepSecurityRuntimeCopies: every copy resource of this
 *     installation whose scan attempt is not running any more
 *
 * Names carry the installation suffix, scan id and attempt, so the reaper finds every
 * leftover (a crash between two calls included) from Cloudflare's own lists, without a
 * database row. The live app, its data and its secrets are never touched: the D1 schema
 * read is the only call on a live resource and it reads `sqlite_master` only.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { getProjectResources } from '../db/resources.ts';
import { getProjectSecrets } from '../db/secrets.ts';
import type { ApiEnv } from '../env.ts';
import { decryptProjectSecret } from '../project-secrets.ts';
import { CF_API_BASE, cfFetch } from '../provisioning/cloudflare-api.ts';
import {
  securityScannerNames,
  securityScannerTarget,
  type SecurityScannerTarget,
} from '../provisioning/security-scanner.ts';
import { deployments, projects } from '../schema.ts';
import type { DeployManifest } from '../types.ts';
import { chargeSecurityScanCopy } from './budget.ts';
import { checkScanFence } from './fence.ts';
import { modulesKey, parseSnapshotModules } from './input/prepare.ts';
import { createSecurityRedactor, type SecuritySecret } from './input/redact.ts';
import { runtimeCopyScriptName } from './runtime-copy-names.ts';
import {
  planSecurityRuntimeCopy,
  SECURITY_COPY_FAKE_PREFIX,
  SECURITY_COPY_PLATFORM_FAKES,
  securityRuntimeCopyMetadata,
  type SecurityCopyPlan,
} from './runtime-copy-plan.ts';
import {
  COPY_ENTRY_MODULE_NAME,
  COPY_GUARD_MODULE,
  COPY_GUARD_MODULE_NAME,
  copyEntryModule,
} from './runtime-copy-sources.ts';
import {
  type CreatedStore,
  deleteCopyScript,
  deleteSecurityRuntimeCopy,
  deleteStore,
  securityCopyScriptUrl,
  type SecurityCopyTarget,
  sweepSecurityRuntimeCopies,
} from './runtime-copy-sweep.ts';
import { securityScans } from './schema.ts';

export type { SecurityCopyTarget } from './runtime-copy-sweep.ts';

/** The copy holds the deployed modules in memory for the upload: at most this many bytes. */
export const SECURITY_COPY_MAX_MODULE_BYTES = 32 * 1024 * 1024;
/** Schema statements replayed into one copy D1, at most. */
export const SECURITY_COPY_MAX_SCHEMA_STATEMENTS = 500;

/**
 * List prices behind the copy's charge (Workers for Platforms and storage, 2026-11):
 * one script for an hour, one D1 row write per schema statement, one R2 class A
 * operation per bucket. The $25 Workers for Platforms base is already paid by the
 * platform's dispatch namespace.
 */
export const SECURITY_COPY_PRICES_NANO = {
  scriptHour: Math.round((0.02 / 730) * 1e9),
  d1RowWritten: 1_000,
  r2ClassA: 4_500,
  kvWrite: 5_000,
} as const;

export async function securityCopyTarget(
  target: SecurityScannerTarget,
): Promise<SecurityCopyTarget> {
  const names = await securityScannerNames(target.installationKey);
  return {
    accountId: target.accountId,
    apiToken: target.apiToken,
    namespace: names.copyNamespace,
    sandbox: names.copySandbox,
    prefix: names.copyPrefix,
  };
}

export type SecurityCopyModule = Readonly<{ name: string; type: string; bytes: Uint8Array }>;

export type SecurityCopyInput = Readonly<{
  plan: SecurityCopyPlan;
  modules: ReadonlyArray<SecurityCopyModule>;
  /** Copy D1 binding → the live D1 uuid whose schema it gets. */
  liveD1: ReadonlyMap<string, string>;
  projectId: string;
  projectSlug: string;
  /** Random bytes for the fake values (tests pass a fixed source). */
  random?: (bytes: number) => Uint8Array;
  /**
   * Whether a text holds a stored secret value (spec §7.3). The schema read from the live
   * D1 is checked with it: the model can read the copy's schema back.
   */
  holdsSecret?: (text: string) => boolean;
}>;

/** A copy that must not be made (not a failure): the scan runs static-only. */
export class SecurityCopySkipped extends Error {
  constructor(readonly reason: string) {
    super(`runtime copy skipped: ${reason}`);
  }
}

export type SecurityCopyCreated = Readonly<{
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
const SHADOW_SUFFIXES = [
  '_data',
  '_idx',
  '_content',
  '_docsize',
  '_config',
  '_segments',
  '_segdir',
  '_stat',
  '_node',
  '_rowid',
  '_parent',
] as const;

/**
 * Turns `sqlite_master` rows into statements. A virtual table's own shadow tables
 * (`<name>_data`, …) are made by its CREATE and are left out; any other table, even one
 * named `<name>_meta`, is kept.
 */
export function securityCopySchemaStatements(rows: ReadonlyArray<SchemaRow>): Array<string> {
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
  const statements: Array<string> = [];
  for (const row of rows) {
    if (typeof row.sql !== 'string' || typeof row.name !== 'string') {
      continue;
    }
    if (row.type === 'table' && shadows.has(row.name)) {
      continue;
    }
    statements.push(row.sql);
  }
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
    {
      method: 'POST',
      body: JSON.stringify({ sql }),
    },
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

/**
 * Creates one copy. On any failure, what this call made is deleted again (best effort;
 * the reaper takes what is left) and the error is thrown.
 */
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
    const results = await Promise.allSettled(
      plan.stores.map(async (store) => {
        const made = await createStore(target, store.kind, store.name);
        created.push(made);
        return made;
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      throw (failed as PromiseRejectedResult).reason;
    }
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
      if (input.holdsSecret && statements.some((statement) => input.holdsSecret!(statement))) {
        throw new SecurityCopySkipped('secret_in_schema');
      }
      schema[store.binding] = statements.length;
      if (statements.length === 0) {
        continue;
      }
      const written = await d1Query(target, ids.get(store.name)!, `${statements.join(';\n')};`);
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
    form.append(
      COPY_ENTRY_MODULE_NAME,
      new File([copyEntryModule(plan.mainModule)], COPY_ENTRY_MODULE_NAME, {
        type: 'application/javascript+module',
      }),
    );
    form.append(
      COPY_GUARD_MODULE_NAME,
      new File([COPY_GUARD_MODULE], COPY_GUARD_MODULE_NAME, {
        type: 'application/javascript+module',
      }),
    );
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Database side: which scan, which deployment, the meter.

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
 * The redaction the model's input gets (spec §7.3), as a yes/no: the copy runs the raw
 * bundle and its answers reach the model, so a copy whose code, kept vars or schema hold
 * a stored secret value is not made. Fake values replace secrets in `env` only.
 */
function secretCheck(secrets: ReadonlyArray<SecuritySecret>): (text: string) => boolean {
  const redactor = createSecurityRedactor(secrets);
  return (text) => redactor.redact(text) !== text;
}

function parseManifest(raw: string | null): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
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
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
  }
  if (total > SECURITY_COPY_MAX_MODULE_BYTES) {
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

/**
 * Makes the copy for one running scan attempt (`SecurityScanControl.copy`). Never
 * throws: a copy that cannot be made leaves the scan static-only.
 */
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
  const plan = planSecurityRuntimeCopy(parseManifest(row.manifest ?? null), {
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
      // The attempt ended while the copy was made (cancel, lease): its result path may
      // have deleted already, so this copy goes now instead of waiting for the reaper.
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
    console.error('[security-copy] copy failed', {
      scanId,
      attempt,
      error: error instanceof Error ? error.message : String(error),
    });
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
    console.error('[security-copy] copy delete failed; the reaper retries', {
      scanId,
      attempt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
 * Hourly: every copy whose scan attempt is not running any more. The running scans are
 * read after Cloudflare is listed: a copy is made only once the fence saw its attempt
 * running, so a listed copy whose attempt is not running then is truly finished.
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
