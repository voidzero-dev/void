/**
 * The I/O side of the scan input (design doc 0095, M10). `SecurityScanControl.input()`
 * calls `prepareSecurityScanInput` once the container is up:
 *
 *   fence (running, this attempt)
 *   head modules ─ snapshot in R2 (`input_r2_key`)
 *                ├ staged deploy input (`input_prefix`) ─► copy to the snapshot, release the hold
 *                ├ stored Worker bundle (`bundle_stored`, recovered inline deploys) ─► copy
 *                └ none ─► failed (input_missing), edge #12
 *   base = last succeeded scan ─► its snapshot hashes ─► tier
 *   assets, backlog, secrets, findings ─► build ─► row update ─► tar stream
 *
 * Memory: modules are read one at a time (hashed, copied, turned into text, a map
 * into its sources) and their bytes counted as read, so more than 50 MB ends
 * `input_missing` whatever size was recorded. Assets: 400 files and 16 MB at most.
 * The tar is encoded entry by entry as the controller reads it.
 *
 * Snapshot layout, `security-scans/{project}/{deployment}/`:
 *   modules/{i}, modules.json (`{version, modules: [{name, type, size, key, sha256}]}`)
 *   sources.json (source path → sha256) and assets.json (asset path → hash), written
 *   by the first scan that reads the snapshot, so it can be the next scan's base.
 * Per scan, next to its raw output (`security-scans/{project}/scans/{scan}/`):
 *   backlog.json (the backlog it leaves) and server-leads.json, for ingest (M12).
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db.ts';
import { getProjectSecrets } from '../../db/secrets.ts';
import { parseManifest } from '../../deploy/serving-assets.ts';
import type { ApiEnv } from '../../env.ts';
import { decryptProjectSecret } from '../../project-secrets.ts';
import { loadStoredWorkerModules } from '../../provisioning/durable-objects.ts';
import { deploymentOperations, deployments } from '../../schema.ts';
import { WorkerModuleIntegrityError } from '../../worker-upload.ts';
import {
  pokeSecurityScanScheduler,
  SECURITY_SCAN_COPY_MAX_BYTES,
  securityScanInputPrefix,
  securityScanProjectPrefix,
} from '../enqueue.ts';
import { securityRawOutputPrefix } from '../maintenance.ts';
import { endSecurityScanAttempt } from '../queue.ts';
import {
  securityFindingEvents,
  securityFindings,
  securityScans,
  type SecurityScanTrigger,
} from '../schema.ts';
import { parseSecurityBacklog, serializeSecurityBacklog } from './backlog.ts';
import {
  buildSecurityScanInput,
  utf8Length,
  type SecurityBuiltInput,
  type SecurityInputAsset,
} from './build.ts';
import type { SecurityMemoryEvent, SecurityMemoryFinding } from './memory.ts';
import type { SecuritySecret } from './redact.ts';
import {
  assetInputPath,
  changedTextAssets,
  securityModuleFile,
  sha256Hex,
  type SecurityAssetEntry,
  type SecurityModuleFile,
} from './t2.ts';
import { assertTarEntries, tarStream } from './tar.ts';
import { chooseSecurityTier } from './tier.ts';

export type SecurityInputEnv = Pick<
  ApiEnv['Bindings'],
  | 'STATIC_ASSETS_R2'
  | 'STATIC_ASSETS'
  | 'SECURITY_SCAN_SCHEDULER'
  | 'PROJECT_SECRET_KEYS_JSON'
  | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
>;

/** Text assets read per scan, at most (the focus holds 400 files) … */
const MAX_ASSETS_READ = 400;
/** … and their bytes, so assets and modules together fit the API isolate. */
const MAX_ASSET_BYTES_READ = 16 * 1024 * 1024;

/** The deployment's input is gone or too large: the scan ends `failed (input_missing)`. */
export class SecurityInputMissing extends Error {}

type SnapshotModule = Readonly<{
  name: string;
  type: string;
  size: number;
  key: string;
  sha256?: string;
}>;

type ScanContext = Readonly<{
  id: string;
  projectId: string;
  deploymentId: string;
  trigger: SecurityScanTrigger;
  attempt: number;
  engine: NonNullable<typeof securityScans.$inferSelect.engine>;
  model: string;
  inputPrefix: string | null;
  inputR2Key: string | null;
  commit: string | null;
  manifest: string | null;
  assetHashes: string | null;
  bundleStored: boolean;
}>;

const decoder = new TextDecoder();

function modulesKey(prefix: string): string {
  return `${prefix}modules.json`;
}

async function readText(r2: R2Bucket, key: string): Promise<string | null> {
  const object = await r2.get(key);
  return object ? object.text() : null;
}

function parseHashMap(text: string | null): Map<string, string> | null {
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as { version?: unknown; hashes?: unknown };
    if (value.version !== 1 || typeof value.hashes !== 'object' || value.hashes === null) {
      return null;
    }
    const out = new Map<string, string>();
    for (const [key, hash] of Object.entries(value.hashes as Record<string, unknown>)) {
      if (typeof hash === 'string') {
        out.set(key, hash);
      }
    }
    return out;
  } catch {
    return null;
  }
}

function serializeHashMap(map: ReadonlyMap<string, string>): string {
  return JSON.stringify({ version: 1, hashes: Object.fromEntries(map) });
}

function parseSnapshotModules(text: string | null): Array<SnapshotModule> | null {
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as { version?: unknown; modules?: unknown };
    if (value.version !== 1 || !Array.isArray(value.modules)) {
      return null;
    }
    const out: Array<SnapshotModule> = [];
    for (const entry of value.modules as Array<Record<string, unknown>>) {
      const { name, type, size, key, sha256 } = entry;
      if (
        typeof name !== 'string' ||
        typeof type !== 'string' ||
        typeof size !== 'number' ||
        typeof key !== 'string'
      ) {
        return null;
      }
      out.push({ name, type, size, key, ...(typeof sha256 === 'string' ? { sha256 } : {}) });
    }
    return out;
  } catch {
    return null;
  }
}

async function loadContext(db: Db, scanId: string, attempt: number): Promise<ScanContext | null> {
  const [row] = await db
    .select({
      id: securityScans.id,
      projectId: securityScans.project_id,
      deploymentId: securityScans.deployment_id,
      trigger: securityScans.trigger,
      attempt: securityScans.attempt,
      status: securityScans.status,
      engine: securityScans.engine,
      model: securityScans.model_used,
      inputPrefix: securityScans.input_prefix,
      inputR2Key: securityScans.input_r2_key,
      commit: deployments.commit,
      manifest: deployments.manifest,
      assetHashes: deployments.asset_hashes,
      bundleStored: deployments.bundle_stored,
    })
    .from(securityScans)
    .leftJoin(deployments, eq(deployments.id, securityScans.deployment_id))
    .where(eq(securityScans.id, scanId))
    .limit(1);
  if (
    !row ||
    row.status !== 'running' ||
    row.attempt !== attempt ||
    row.deploymentId === null ||
    row.engine === null ||
    row.model === null
  ) {
    return null;
  }
  return {
    ...row,
    deploymentId: row.deploymentId,
    engine: row.engine,
    model: row.model,
    commit: row.commit ?? null,
    manifest: row.manifest ?? null,
    assetHashes: row.assetHashes ?? null,
    bundleStored: row.bundleStored ?? false,
  };
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A head module as the snapshot lists it; its bytes are not kept once read. */
type HeadModule = SnapshotModule & { sha256: string };

type HeadInput = Readonly<{
  modules: Array<HeadModule>;
  /** The text the builder reads, one entry per module (maps already parsed). */
  files: Array<SecurityModuleFile>;
}>;

/** Where one module's bytes come from, with the size recorded for it when known. */
type ModuleSource = Readonly<{
  name: string;
  type: string;
  size: number | null;
  sha256?: string;
  /** Its key in the scan snapshot, when it is read from there (nothing to copy). */
  key?: string;
  read(charge: (bytes: number) => void): Promise<Uint8Array>;
}>;

const TOO_LARGE = 'the Worker modules are larger than the scan input limit';

/**
 * Counts module bytes as they are read, so a missing or wrong recorded size cannot
 * get past the limit; past it the input counts as missing.
 */
function moduleBudget(): (bytes: number) => void {
  let total = 0;
  return (bytes) => {
    total += bytes;
    if (total > SECURITY_SCAN_COPY_MAX_BYTES) {
      throw new SecurityInputMissing(TOO_LARGE);
    }
  };
}

/** Reads one R2 object, charged by its stored size before the body is read. */
async function readR2Module(
  r2: R2Bucket,
  key: string,
  name: string,
  charge: (bytes: number) => void,
): Promise<Uint8Array> {
  const object = await r2.get(key);
  if (!object) {
    throw new SecurityInputMissing(`module ${name} is missing`);
  }
  try {
    charge(object.size);
  } catch (error) {
    await object.body.cancel();
    throw error;
  }
  const bytes = await readBytes(object.body);
  charge(bytes.length - object.size);
  return bytes;
}

function isBinaryModule(name: string, type: string): boolean {
  return name.endsWith('.wasm') || type.includes('wasm') || type === 'application/octet-stream';
}

/**
 * Reads the modules one at a time: each is hashed, copied to the snapshot when
 * `copyTo` is set, and turned into text (a map into its sources) before the next
 * is read. Only the text is kept, never the whole bundle's bytes.
 */
async function readModules(
  r2: R2Bucket,
  sources: ReadonlyArray<ModuleSource>,
  copyTo: string | null,
): Promise<HeadInput> {
  let declared = 0;
  for (const source of sources) {
    declared += source.size ?? 0;
  }
  if (declared > SECURITY_SCAN_COPY_MAX_BYTES) {
    throw new SecurityInputMissing(TOO_LARGE);
  }
  const charge = moduleBudget();
  const modules: Array<HeadModule> = [];
  const files: Array<SecurityModuleFile> = [];
  for (const [index, source] of sources.entries()) {
    const bytes = await source.read(charge);
    const sha256 = source.sha256 ?? sha256Hex(bytes);
    const key = copyTo === null ? source.key! : `${copyTo}modules/${index}`;
    if (copyTo !== null) {
      await r2.put(key, bytes);
    }
    modules.push({ name: source.name, type: source.type, size: bytes.length, key, sha256 });
    const text = isBinaryModule(source.name, source.type) ? '' : decoder.decode(bytes);
    files.push(securityModuleFile(source.name, sha256, text));
  }
  if (copyTo !== null) {
    // `modules.json` last: a snapshot without it is incomplete.
    await r2.put(modulesKey(copyTo), serializeModules(modules));
  }
  return { modules, files };
}

function serializeModules(modules: ReadonlyArray<SnapshotModule>): string {
  return JSON.stringify({
    version: 1,
    modules: modules.map(({ name, type, size, key, sha256 }) => ({
      name,
      type,
      size,
      key,
      sha256,
    })),
  });
}

/**
 * The head deployment's modules. Staged input and a stored bundle are copied to the
 * scan snapshot here and the hold is released with a fenced write; `null` when that
 * write misses (the attempt is no longer the running one).
 */
async function loadHeadModules(
  env: SecurityInputEnv,
  db: Db,
  scan: ScanContext,
): Promise<HeadInput | null> {
  const r2 = env.STATIC_ASSETS_R2;
  if (scan.inputR2Key !== null) {
    const entries = parseSnapshotModules(await readText(r2, modulesKey(scan.inputR2Key)));
    if (entries === null) {
      throw new SecurityInputMissing('the scan input snapshot is incomplete');
    }
    return readModules(
      r2,
      entries.map((entry) => ({
        ...entry,
        read: (charge) => readR2Module(r2, entry.key, entry.name, charge),
      })),
      null,
    );
  }
  const prefix = securityScanInputPrefix(scan.projectId, scan.deploymentId);
  let sources: Array<ModuleSource>;
  if (scan.inputPrefix !== null) {
    const [operation] = await db
      .select({ payload: deploymentOperations.payload })
      .from(deploymentOperations)
      .where(
        and(
          eq(deploymentOperations.project_id, scan.projectId),
          eq(deploymentOperations.input_prefix, scan.inputPrefix),
          eq(deploymentOperations.inputs_deleted, false),
        ),
      )
      .limit(1);
    const staged = operation?.payload.modules ?? [];
    if (staged.length === 0) {
      throw new SecurityInputMissing('the staged deploy input is gone');
    }
    sources = staged.map((module) => ({
      name: module.name,
      type: module.type,
      size: module.size ?? null,
      sha256: module.digest,
      read: (charge) => readR2Module(r2, module.key, module.name, charge),
    }));
  } else if (scan.bundleStored) {
    // A recovered inline deploy (M8): its modules left with the request that died.
    let stored;
    try {
      stored = await loadStoredWorkerModules(env, scan.projectId, scan.deploymentId);
    } catch (error) {
      throw new SecurityInputMissing(
        `the stored Worker bundle cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    sources = stored.map((module) => ({
      name: module.name,
      type: module.type,
      size: module.size,
      ...(module.sha256 === undefined ? {} : { sha256: module.sha256 }),
      async read(charge) {
        charge(module.size);
        let bytes: Uint8Array;
        try {
          bytes = await readBytes(await module.open());
        } catch (error) {
          if (error instanceof WorkerModuleIntegrityError) {
            throw new SecurityInputMissing(`stored module ${module.name}: ${error.message}`);
          }
          throw error;
        }
        charge(bytes.length - module.size);
        return bytes;
      },
    }));
  } else {
    throw new SecurityInputMissing('the deployment has no stored Worker input');
  }
  const copied = await readModules(r2, sources, prefix);
  const released = await db
    .update(securityScans)
    .set({ input_r2_key: prefix, input_prefix: null })
    .where(
      and(
        eq(securityScans.id, scan.id),
        eq(securityScans.status, 'running'),
        eq(securityScans.attempt, scan.attempt),
      ),
    )
    .returning({ id: securityScans.id });
  if (released.length === 0) {
    return null;
  }
  return copied;
}

type BaseScan = Readonly<{
  id: string;
  deploymentId: string;
  finishedAt: string | null;
  ledgerSummary: unknown;
}>;

async function loadBase(db: Db, scan: ScanContext): Promise<BaseScan | null> {
  const [row] = await db
    .select({
      id: securityScans.id,
      deploymentId: securityScans.deployment_id,
      finishedAt: securityScans.finished_at,
      ledgerSummary: securityScans.ledger_summary,
    })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, scan.projectId),
        eq(securityScans.status, 'succeeded'),
        isNotNull(securityScans.deployment_id),
      ),
    )
    .orderBy(desc(securityScans.finished_at), desc(securityScans.created_at))
    .limit(1);
  if (!row || row.deploymentId === null) {
    return null;
  }
  return { ...row, deploymentId: row.deploymentId };
}

type BaseSnapshot = Readonly<{
  modules: Map<string, string>;
  sources: Map<string, string> | null;
  assets: Map<string, string> | null;
}>;

/** The base snapshot's hashes, or `null` when it is gone. */
async function loadBaseSnapshot(r2: R2Bucket, prefix: string): Promise<BaseSnapshot | null> {
  const entries = parseSnapshotModules(await readText(r2, modulesKey(prefix)));
  if (entries === null) {
    return null;
  }
  const modules = new Map<string, string>();
  for (const entry of entries) {
    if (entry.sha256 !== undefined) {
      modules.set(entry.name, entry.sha256);
      continue;
    }
    const object = await r2.get(entry.key);
    if (!object) {
      return null;
    }
    modules.set(entry.name, sha256Hex(await readBytes(object.body)));
  }
  return {
    modules,
    sources: parseHashMap(await readText(r2, `${prefix}sources.json`)),
    assets: parseHashMap(await readText(r2, `${prefix}assets.json`)),
  };
}

function parseAssetHashes(text: string | null): Array<SecurityAssetEntry> {
  if (text === null) {
    return [];
  }
  try {
    const value = JSON.parse(text) as Record<string, { hash?: unknown; size?: unknown }>;
    const out: Array<SecurityAssetEntry> = [];
    for (const [path, entry] of Object.entries(value)) {
      if (typeof entry?.hash === 'string' && typeof entry.size === 'number') {
        out.push({ path, hash: entry.hash, size: entry.size });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readAsset(
  env: SecurityInputEnv,
  projectId: string,
  hash: string,
): Promise<string | null> {
  const key = `assets/${projectId}/${hash}`;
  const object = await env.STATIC_ASSETS_R2.get(key);
  if (object) {
    return decoder.decode(await readBytes(object.body));
  }
  const stored = await env.STATIC_ASSETS.get(key, 'arrayBuffer');
  return stored ? decoder.decode(stored) : null;
}

async function loadSecrets(
  env: SecurityInputEnv,
  db: Db,
  projectId: string,
): Promise<Array<SecuritySecret>> {
  const rows = await getProjectSecrets(db, projectId);
  const out: Array<SecuritySecret> = [];
  for (const row of rows) {
    // A secret that cannot be read cannot be redacted: the input is not built.
    out.push({ name: row.name, value: await decryptProjectSecret(env, projectId, row) });
  }
  return out;
}

async function loadMemory(
  db: Db,
  projectId: string,
): Promise<{ findings: Array<SecurityMemoryFinding>; events: Array<SecurityMemoryEvent> }> {
  const findings = await db
    .select()
    .from(securityFindings)
    .where(eq(securityFindings.project_id, projectId));
  const events = await db
    .select({
      findingId: securityFindingEvents.finding_id,
      action: securityFindingEvents.action,
      actorKind: securityFindingEvents.actor_kind,
      actorRole: securityFindingEvents.actor_role,
      resolution: securityFindingEvents.resolution,
      comment: securityFindingEvents.comment,
      scanId: securityFindingEvents.scan_id,
      createdAt: securityFindingEvents.created_at,
    })
    .from(securityFindingEvents)
    .where(eq(securityFindingEvents.project_id, projectId));
  return {
    findings: findings.map((row) => ({
      id: row.id,
      number: row.number,
      fingerprintKey: row.fingerprint_key,
      verdict: row.verdict,
      severity: row.severity_override ?? row.severity,
      title: row.title,
      category: row.category,
      cwe: row.cwe,
      file: row.file,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      sinkPath: row.sink_path,
      detail: row.detail,
      source: row.source,
      state: row.state,
      resolution: row.resolution,
      resolvedAt: row.resolved_at,
      resolvedSinkHash: row.resolved_sink_hash,
      notSeenInLatest: row.not_seen_in_latest,
      reopenCount: row.reopen_count,
      createdAt: row.created_at,
    })),
    events,
  };
}

/**
 * The text assets this scan reads: backlog ones first (they may be unchanged since),
 * then changed ones, at most 400 files and 16 MB. The rest, and any that storage no
 * longer has, are `unread`: the builder puts them in the backlog.
 */
async function loadAssets(
  env: SecurityInputEnv,
  projectId: string,
  head: ReadonlyArray<SecurityAssetEntry>,
  base: ReadonlyMap<string, string> | null,
  backlog: ReadonlyArray<string>,
): Promise<{ assets: Array<SecurityInputAsset>; unread: Array<string> }> {
  const waiting = new Set(backlog);
  const wanted = new Map<string, SecurityAssetEntry>();
  for (const asset of changedTextAssets(head, null)) {
    const path = assetInputPath(asset.path);
    if (path !== null && waiting.has(path)) {
      wanted.set(asset.path, asset);
    }
  }
  for (const asset of changedTextAssets(head, base)) {
    wanted.set(asset.path, asset);
  }
  const assets: Array<SecurityInputAsset> = [];
  const unread: Array<string> = [];
  let bytes = 0;
  for (const asset of wanted.values()) {
    if (assets.length >= MAX_ASSETS_READ || bytes + asset.size > MAX_ASSET_BYTES_READ) {
      unread.push(asset.path);
      continue;
    }
    const text = await readAsset(env, projectId, asset.hash);
    if (text === null) {
      unread.push(asset.path);
      continue;
    }
    bytes += utf8Length(text);
    assets.push({ path: asset.path, text });
  }
  return { assets, unread };
}

export type SecurityPreparedInput = Readonly<{
  built: SecurityBuiltInput;
  baseScanId: string | null;
  baseDeploymentId: string | null;
}>;

/**
 * Builds and records the input of one running attempt. `null` when the attempt is not
 * the running one, or the input is missing (the row then ends `failed (input_missing)`).
 * Other errors throw: the controller reports `input_unavailable` and ingest decides.
 */
export async function prepareSecurityScanInputFiles(
  env: SecurityInputEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<SecurityPreparedInput | null> {
  const scan = await loadContext(db, scanId, attempt);
  if (!scan) {
    return null;
  }
  const r2 = env.STATIC_ASSETS_R2;
  let head: HeadInput | null;
  try {
    head = await loadHeadModules(env, db, scan);
  } catch (error) {
    if (!(error instanceof SecurityInputMissing)) {
      throw error;
    }
    console.warn('[security-scan] scan input missing', { scanId, reason: error.message });
    const ended = await endSecurityScanAttempt(db, scanId, attempt, {
      status: 'failed',
      reason: 'input_missing',
      errorClass: 'input_missing',
      failureCause: 'project',
    });
    if (ended) {
      await pokeSecurityScanScheduler(env);
    }
    return null;
  }
  if (head === null) {
    return null;
  }

  const base = await loadBase(db, scan);
  const baseSnapshot =
    base === null
      ? null
      : await loadBaseSnapshot(r2, securityScanInputPrefix(scan.projectId, base.deploymentId));
  const tier = chooseSecurityTier({
    trigger: scan.trigger,
    baseDeploymentId: base?.deploymentId ?? null,
    baseSnapshot: baseSnapshot !== null,
  });
  const diffBase = tier.tier === 'full' ? null : baseSnapshot;

  const projectPrefix = securityScanProjectPrefix(scan.projectId);
  const backlog = parseSecurityBacklog(await readText(r2, `${projectPrefix}backlog.json`));
  const headAssets = parseAssetHashes(scan.assetHashes);
  const { assets, unread: unreadAssets } = await loadAssets(
    env,
    scan.projectId,
    headAssets,
    diffBase?.assets ?? null,
    backlog,
  );
  const memory = await loadMemory(db, scan.projectId);
  const lastSucceededAt = base?.finishedAt ?? null;
  const recheckFiles = memory.findings
    .filter(
      (finding) =>
        finding.state === 'resolved' &&
        finding.resolution === 'fixed' &&
        finding.file !== null &&
        (lastSucceededAt === null ||
          (finding.resolvedAt !== null &&
            Date.parse(finding.resolvedAt) > Date.parse(lastSucceededAt))),
    )
    .map((finding) => finding.file!);

  const built = buildSecurityScanInput({
    scan: {
      id: scan.id,
      attempt: scan.attempt,
      engine: scan.engine,
      model: scan.model,
      trigger: scan.trigger,
      commit: scan.commit,
    },
    tier,
    head: { modules: head.files, main: parseManifest(scan.manifest)?.workerMain ?? null },
    base: diffBase,
    assets,
    unreadAssets,
    backlog,
    recheckFiles,
    secrets: await loadSecrets(env, db, scan.projectId),
    // No lockfile reaches the platform yet (spike S7): third-party code stays, ranked last.
    lockfile: null,
    memory: {
      findings: memory.findings,
      events: memory.events,
      lastSucceededAt,
      ledgerSummary: base?.ledgerSummary ?? null,
    },
  });
  // A bad path throws here, before anything is recorded, never halfway through the stream.
  assertTarEntries(built.entries);

  // The head snapshot as a future base, and what ingest needs from this scan.
  const headPrefix = securityScanInputPrefix(scan.projectId, scan.deploymentId);
  // With every sha256 filled in (an inline copy made after the commit has none).
  await r2.put(modulesKey(headPrefix), serializeModules(head.modules));
  await r2.put(`${headPrefix}sources.json`, serializeHashMap(built.sourceIndex));
  await r2.put(
    `${headPrefix}assets.json`,
    // Assets this scan did not read stay out, so the next scan sees them as changed.
    serializeHashMap(
      new Map(
        headAssets
          .filter((asset) => !built.unscannedAssets.has(asset.path))
          .map((asset) => [asset.path, asset.hash]),
      ),
    ),
  );
  const scanPrefix = securityRawOutputPrefix(scan.projectId, scan.id);
  await r2.put(`${scanPrefix}backlog.json`, serializeSecurityBacklog(built.backlog));
  await r2.put(
    `${scanPrefix}server-leads.json`,
    JSON.stringify({ version: 1, leads: built.serverLeads }),
  );

  const recorded = await db
    .update(securityScans)
    .set({
      tier: built.tier,
      coverage: built.coverage,
      coverage_notes: [...built.notes],
      backlog_files: built.backlog.length,
      dropped_files: built.droppedFiles,
      dropped_bytes: built.droppedBytes,
      files_scanned: built.filesScanned,
      input_bytes: built.inputBytes,
      base_scan_id: base?.id ?? null,
      base_deployment_id: base?.deploymentId ?? null,
    })
    .where(
      and(
        eq(securityScans.id, scan.id),
        eq(securityScans.status, 'running'),
        eq(securityScans.attempt, scan.attempt),
      ),
    )
    .returning({ id: securityScans.id });
  if (recorded.length === 0) {
    return null;
  }
  return {
    built,
    baseScanId: base?.id ?? null,
    baseDeploymentId: base?.deploymentId ?? null,
  };
}

/** `SecurityScanControl.input()`: the tar stream, or `null` (see above). */
export async function prepareSecurityScanInput(
  env: SecurityInputEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<ReadableStream<Uint8Array> | null> {
  const prepared = await prepareSecurityScanInputFiles(env, db, scanId, attempt);
  return prepared === null ? null : tarStream(prepared.built.entries);
}
