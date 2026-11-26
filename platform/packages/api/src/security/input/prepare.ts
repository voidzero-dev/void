/**
 * The I/O side of the scan input (M10), for `SecurityScanControl.input()`:
 *
 *   fence ─► head modules: snapshot (`input_r2_key`), else copy the staged input or the
 *            stored bundle to it, else failed (input_missing, edge #12)
 *   base = last succeeded scan ─► tier ─► assets, backlog, secrets, findings
 *   diff on a hosted install with GitHub ─► T1 (`t1-github.ts`), else T2 ─► build ─► tar
 *
 * Modules are read one at a time and their bytes counted (over 50 MB is input_missing).
 * Snapshot `security-scans/{project}/{deployment}/`: modules/{i}, modules.json,
 * sources.json, assets.json, never-sent.json (the next scan's base). Per scan
 * (`…/scans/{scan}/`): backlog.json, server-leads.json, scope.json, for ingest.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { SCAN_INPUT_LIMITS } from '../../../../security-scanner/src/runner/limits.ts';
import type { Db } from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { loadStoredWorkerModules } from '../../provisioning/durable-objects.ts';
import { deploymentOperations, deployments } from '../../schema.ts';
import { WorkerModuleIntegrityError } from '../../worker-upload.ts';
import { errorMessage } from '../../zero-trust/errors.ts';
import {
  pokeSecurityScanScheduler,
  SECURITY_SCAN_COPY_MAX_BYTES,
  securityScanInputPrefix,
  securityScanProjectPrefix,
} from '../enqueue.ts';
import {
  ingestSecurityScanResult,
  parseVersionOne,
  serializeSecurityScanScope,
} from '../ingest.ts';
import { securityRawOutputPrefix } from '../maintenance.ts';
import { readSecurityManifest } from '../manifest.ts';
import { endSecurityScanAttempt, securityScanAt } from '../queue.ts';
import { securityRuntimeCopyWanted } from '../runtime-copy-plan.ts';
import { securityScans } from '../schema.ts';
import { parseSecurityBacklog, serializeSecurityBacklog } from './backlog.ts';
import {
  buildSecurityScanInput,
  SECURITY_CLIENT_ASSETS_NOTE,
  SECURITY_INPUT_MAX_BYTES,
  securityDeployConfigText,
  utf8Length,
} from './build.ts';
import type {
  SecurityBuiltInput,
  SecurityClientSource,
  SecurityInputAsset,
  SecurityNeverSent,
  SecurityNeverSentKind,
  SecuritySourceDiffInput,
} from './build.ts';
import { looksBinary, securityInputFilter } from './filters.ts';
import { prepareLocalCheckInputFiles } from './local.ts';
import { SECURITY_MEMORY_HISTORY_MAX_FILES } from './memory.ts';
import { loadSecurityMemory, loadSecuritySecrets } from './project-data.ts';
import { createSecurityRedactor } from './redact.ts';
import type { SecuritySecret, SecuritySecretHit } from './redact.ts';
import { loadSecuritySourceDiff } from './t1-github.ts';
import type { SecuritySourceDiffEnv } from './t1-github.ts';
import {
  assetInputPath,
  bundleSources,
  changedTextAssets,
  compareText,
  readSourceMap,
  SECURITY_CLIENT_PREFIX,
  securityModuleFile,
  sha256Hex,
  sourceMapFor,
} from './t2.ts';
import type {
  SecurityBundleSources,
  SecurityMapSource,
  SecurityAssetEntry,
  SecurityModuleFile,
} from './t2.ts';
import { assertTarEntries, tarStream } from './tar.ts';
import { parseSecurityPackageClaims } from './third-party.ts';
import type { SecurityLockfileIndex } from './third-party.ts';
import { chooseSecurityTier, securityFallbackFullReason } from './tier.ts';

export type SecurityInputEnv = Pick<
  ApiEnv['Bindings'],
  | 'STATIC_ASSETS_R2'
  | 'STATIC_ASSETS'
  | 'SECURITY_SCAN_SCHEDULER'
  | 'PROJECT_SECRET_KEYS_JSON'
  | 'PROJECT_SECRET_ACTIVE_KEY_VERSION'
> &
  SecuritySourceDiffEnv;

const MB = 1024 * 1024;
// Text assets read per scan: files and bytes, so assets and modules fit the API isolate.
const MAX_ASSETS_READ = 400;
const MAX_ASSET_BYTES_READ = 16 * MB;
// Client asset pass (M31): source maps read, one map's size, all maps' bytes.
const MAX_CLIENT_MAPS_READ = 100;
const MAX_CLIENT_MAP_BYTES = 8 * MB;
const MAX_CLIENT_MAP_BYTES_READ = 24 * MB;
// M31: assets too big to read, searched for secret values: files, size each, bytes in all.
const MAX_SEARCHED_ASSETS = 50;
const MAX_SEARCHED_ASSET_BYTES = 8 * MB;
const MAX_SEARCHED_ASSET_BYTES_TOTAL = 64 * MB;

/** The deployment's input is gone or too large: the scan ends `failed (input_missing)`. */
class SecurityInputMissing extends Error {}

type SnapshotModule = Readonly<{
  name: string;
  type: string;
  size: number;
  key: string;
  sha256?: string;
}>;

type ScanContext = Exclude<Awaited<ReturnType<typeof loadContext>>, 'local' | null>;

const decoder = new TextDecoder();

export function modulesKey(prefix: string): string {
  return `${prefix}modules.json`;
}

async function readText(r2: R2Bucket, key: string): Promise<string | null> {
  const object = await r2.get(key);
  return object ? object.text() : null;
}

export function versionOneJson(field: string, value: unknown): string {
  return JSON.stringify({ version: 1, [field]: value });
}

function entriesOf(value: unknown): Array<[string, unknown]> | null {
  return typeof value === 'object' && value !== null ? Object.entries(value) : null;
}

function parseHashMap(text: string | null): Map<string, string> | null {
  const entries = entriesOf(parseVersionOne(text)?.hashes);
  return entries === null
    ? null
    : new Map(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

const NEVER_SENT_KINDS: ReadonlyArray<SecurityNeverSentKind> = ['oversize', 'binary', 'bad_path'];

/** `never-sent.json`, or `null` when it is missing (an older scan) or unreadable. */
function parseNeverSent(text: string | null): SecurityNeverSent | null {
  const entries = entriesOf(parseVersionOne(text)?.files);
  if (entries === null) {
    return null;
  }
  const out = new Map<string, { sha256: string; kind: SecurityNeverSentKind }>();
  for (const [path, entry] of entries) {
    const { sha256, kind } = (entry ?? {}) as { sha256?: unknown; kind?: unknown };
    const known = NEVER_SENT_KINDS.find((item) => item === kind);
    if (typeof sha256 === 'string' && known !== undefined) {
      out.set(path, { sha256, kind: known });
    }
  }
  return out;
}

export function parseSnapshotModules(text: string | null): Array<SnapshotModule> | null {
  const modules = parseVersionOne(text)?.modules;
  if (!Array.isArray(modules)) {
    return null;
  }
  const out: Array<SnapshotModule> = [];
  for (const entry of modules) {
    const { name, type, size, key, sha256 } = (entry ?? {}) as Record<string, unknown>;
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
}

function textBytes(files: ReadonlyArray<{ text: string }>): number {
  return files.reduce((sum, file) => sum + utf8Length(file.text), 0);
}

/** Ends the attempt `failed (input_missing)` and pokes the scheduler; always `null`. */
export async function endSecurityInputMissing(
  env: SecurityInputEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<null> {
  const end = { status: 'failed', reason: 'input_missing', errorClass: 'input_missing' } as const;
  if (await endSecurityScanAttempt(db, scanId, attempt, { ...end, failureCause: 'project' })) {
    await pokeSecurityScanScheduler(env);
  }
  return null;
}

/** Records the built input on the attempt's row; `false` when it is no longer running. */
export async function recordSecurityBuiltInput(
  db: Db,
  scanId: string,
  attempt: number,
  built: SecurityBuiltInput,
  extra: Partial<typeof securityScans.$inferInsert>,
): Promise<boolean> {
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
      ...extra,
    })
    .where(securityScanAt(scanId, attempt))
    .returning({ id: securityScans.id });
  return recorded.length > 0;
}

/** `local` for a running local check (M32): it has no deployment and its own input. */
async function loadContext(db: Db, scanId: string, attempt: number) {
  const [row] = await db
    .select({
      id: securityScans.id,
      projectId: securityScans.project_id,
      deploymentId: securityScans.deployment_id,
      trigger: securityScans.trigger,
      publicRequestId: securityScans.public_request_id,
      coverageNotes: securityScans.coverage_notes,
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
  if (row?.trigger === 'local' && row.status === 'running' && row.attempt === attempt) {
    return 'local' as const;
  }
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

/** Counts module bytes as they are read, so a wrong recorded size cannot pass the limit. */
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
  const bytes = await readBytes(object.body as ReadableStream<Uint8Array>);
  charge(bytes.length - object.size);
  return bytes;
}

function isBinaryModule(name: string, type: string): boolean {
  return name.endsWith('.wasm') || type.includes('wasm') || type === 'application/octet-stream';
}

/** Reads the modules one at a time (hashed, copied to `copyTo`, kept only as text). */
async function readModules(
  r2: R2Bucket,
  sources: ReadonlyArray<ModuleSource>,
  copyTo: string | null,
): Promise<HeadInput> {
  if (sources.reduce((sum, source) => sum + (source.size ?? 0), 0) > SECURITY_SCAN_COPY_MAX_BYTES) {
    throw new SecurityInputMissing(TOO_LARGE);
  }
  const charge = moduleBudget();
  const modules: Array<HeadModule> = [];
  const files: Array<SecurityModuleFile> = [];
  for (const [index, source] of sources.entries()) {
    const bytes = await source.read(charge);
    const sha256 = source.sha256 ?? sha256Hex(bytes);
    const key = copyTo === null ? source.key : `${copyTo}modules/${index}`;
    if (key === undefined) {
      throw new Error(`The scan snapshot has no key for module ${source.name}.`);
    }
    if (copyTo !== null) {
      await r2.put(key, bytes);
    }
    modules.push({ name: source.name, type: source.type, size: bytes.length, key, sha256 });
    const text = isBinaryModule(source.name, source.type) ? '' : decoder.decode(bytes);
    files.push(securityModuleFile(source.name, sha256, text));
  }
  if (copyTo !== null) {
    // `modules.json` last: a snapshot without it is incomplete.
    await r2.put(modulesKey(copyTo), versionOneJson('modules', modules));
  }
  return { modules, files };
}

/**
 * The head deployment's modules. Staged input or a stored bundle is copied to the snapshot
 * and the hold released with a fenced write; `null` when that write misses.
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
        `the stored Worker bundle cannot be read: ${errorMessage(error)}`,
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
    .where(securityScanAt(scan.id, scan.attempt))
    .returning({ id: securityScans.id });
  return released.length === 0 ? null : copied;
}

/** Where a deployment's package claims (`securityPackages`) are kept with its snapshot. */
function packagesKey(prefix: string): string {
  return `${prefix}packages.json`;
}

/**
 * The deploy's lockfile claims (spec §7.4), from the staged deploy body the first time,
 * then kept with the snapshot for a retry. `null` when the CLI sent none.
 */
async function loadPackageClaims(
  db: Db,
  r2: R2Bucket,
  scan: ScanContext,
): Promise<SecurityLockfileIndex | null> {
  const prefix = securityScanInputPrefix(scan.projectId, scan.deploymentId);
  if (scan.inputR2Key !== null) {
    const text = await readText(r2, packagesKey(scan.inputR2Key));
    if (text === null) {
      return null;
    }
    try {
      return parseSecurityPackageClaims(JSON.parse(text));
    } catch {
      return null;
    }
  }
  if (scan.inputPrefix === null) {
    return null;
  }
  const [operation] = await db
    .select({ payload: deploymentOperations.payload })
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.project_id, scan.projectId),
        eq(deploymentOperations.input_prefix, scan.inputPrefix),
      ),
    )
    .limit(1);
  const claims = operation?.payload.body?.securityPackages;
  const index = parseSecurityPackageClaims(claims);
  if (index !== null) {
    await r2.put(packagesKey(prefix), JSON.stringify(claims));
  }
  return index;
}

/** The bundle sources, filled by whichever step reads them first. */
type BundleSourcesOnce = { value?: SecurityBundleSources };

async function loadBase(db: Db, scan: ScanContext) {
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

/** The base snapshot's hashes, or `null` when it is gone. */
async function loadBaseSnapshot(r2: R2Bucket, prefix: string) {
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
    modules.set(entry.name, sha256Hex(await readBytes(object.body as ReadableStream<Uint8Array>)));
  }
  return {
    modules,
    sources: parseHashMap(await readText(r2, `${prefix}sources.json`)),
    assets: parseHashMap(await readText(r2, `${prefix}assets.json`)),
    neverSent: parseNeverSent(await readText(r2, `${prefix}never-sent.json`)),
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
    return decoder.decode(await readBytes(object.body as ReadableStream<Uint8Array>));
  }
  const stored = await env.STATIC_ASSETS.get(key, 'arrayBuffer');
  return stored ? decoder.decode(stored) : null;
}

/** The text assets this scan reads, backlog ones first; the rest are `unread` (backlog). */
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

const bare = (path: string) => (path.startsWith('/') ? path.slice(1) : path);

/**
 * The client asset pass (M31): client bundle sources from their source maps, each map read
 * once. Maps over the limits, or gone from storage, are counted in `unread`.
 */
async function loadClientSources(
  env: SecurityInputEnv,
  projectId: string,
  head: ReadonlyArray<SecurityAssetEntry>,
  assets: ReadonlyArray<SecurityInputAsset>,
  /** Bytes the read set has left after modules and assets: sources past it are never sent. */
  budget: number,
): Promise<{ sources: Array<SecurityClientSource>; unread: number }> {
  const maps = new Map<string, SecurityAssetEntry>();
  for (const entry of head) {
    if (entry.path.endsWith('.map')) {
      maps.set(bare(entry.path), entry);
    }
  }
  const done = new Set<string>();
  const sources: Array<SecurityClientSource> = [];
  let unread = 0;
  let read = 0;
  let bytes = 0;
  let kept = 0;
  const texts = new Map(assets.map((asset) => [asset.path, asset.text]));
  const bundles = head
    .filter(
      (entry) =>
        (entry.path.endsWith('.js') || entry.path.endsWith('.mjs')) &&
        !entry.path.startsWith('/.void-deploy/'),
    )
    .sort((left, right) => compareText(left.path, right.path));
  for (const asset of bundles) {
    const name = bare(asset.path);
    const ref = sourceMapFor({ name, text: texts.get(asset.path) ?? '' }, maps);
    if (ref === null || done.has(ref.name)) {
      continue;
    }
    done.add(ref.name);
    if (kept >= budget) {
      // Nothing more fits the read set: the rest of the maps are not read.
      unread++;
      continue;
    }
    let found: Array<SecurityMapSource> | null;
    if (ref.inline !== null) {
      found = readSourceMap(ref.name, ref.inline);
    } else {
      // `sourceMapFor` names a separate map only when `maps` holds it.
      const entry = maps.get(ref.name);
      if (
        !entry ||
        read >= MAX_CLIENT_MAPS_READ ||
        entry.size > MAX_CLIENT_MAP_BYTES ||
        bytes + entry.size > MAX_CLIENT_MAP_BYTES_READ
      ) {
        unread++;
        continue;
      }
      const text = await readAsset(env, projectId, entry.hash);
      if (text === null) {
        unread++;
        continue;
      }
      read++;
      bytes += entry.size;
      found = readSourceMap(ref.name, text);
    }
    for (const source of found ?? []) {
      // What the builder drops anyway (secret-like, skipped, binary) is not kept.
      if (
        securityInputFilter(`${SECURITY_CLIENT_PREFIX}${source.path}`) !== null ||
        looksBinary(source.text)
      ) {
        continue;
      }
      const size = utf8Length(source.text);
      if (kept + size > budget) {
        continue;
      }
      kept += size;
      sources.push({ asset: asset.path, path: source.path, text: source.text });
    }
  }
  return { sources, unread };
}

/**
 * M31: changed text assets over the read limit, searched for stored secret values; only
 * hits are kept. `unsearched` ones stay out of the asset index, so the next scan retries.
 */
async function searchLargeAssets(
  env: SecurityInputEnv,
  projectId: string,
  head: ReadonlyArray<SecurityAssetEntry>,
  base: ReadonlyMap<string, string> | null,
  secrets: ReadonlyArray<SecuritySecret>,
): Promise<{
  searched: Array<{ path: string; hits: Array<SecuritySecretHit> }>;
  unsearched: Set<string>;
}> {
  const searched: Array<{ path: string; hits: Array<SecuritySecretHit> }> = [];
  const unsearched = new Set<string>();
  if (secrets.length === 0) {
    return { searched, unsearched };
  }
  const redactor = createSecurityRedactor(secrets);
  let files = 0;
  let bytes = 0;
  for (const asset of changedTextAssets(head, base, true)) {
    if (
      files >= MAX_SEARCHED_ASSETS ||
      asset.size > MAX_SEARCHED_ASSET_BYTES ||
      bytes + asset.size > MAX_SEARCHED_ASSET_BYTES_TOTAL
    ) {
      unsearched.add(asset.path);
      continue;
    }
    const text = await readAsset(env, projectId, asset.hash);
    if (text === null) {
      unsearched.add(asset.path);
      continue;
    }
    files++;
    bytes += asset.size;
    const hits = redactor.hitsIn(text);
    if (hits.length > 0) {
      searched.push({ path: asset.path, hits });
    }
  }
  return { searched, unsearched };
}

export type SecurityPreparedInput = Readonly<{
  built: SecurityBuiltInput;
  baseScanId: string | null;
  baseDeploymentId: string | null;
}>;

/**
 * Builds and records the input of one running attempt; `null` when it is not the running
 * one or the input is missing. Other errors throw (`input_unavailable`).
 */
export async function prepareSecurityScanInputFiles(
  env: SecurityInputEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<SecurityPreparedInput | null> {
  const scan = await loadContext(db, scanId, attempt);
  if (scan === 'local') {
    // M32: a working tree the CLI uploaded, not a deployment.
    return prepareLocalCheckInputFiles(env, db, scanId, attempt);
  }
  if (!scan) {
    return null;
  }
  const r2 = env.STATIC_ASSETS_R2;
  // Before the head copy, which drops the staged input from the scan row.
  const packageClaims = await loadPackageClaims(db, r2, scan);
  let head: HeadInput | null;
  try {
    head = await loadHeadModules(env, db, scan);
  } catch (error) {
    if (!(error instanceof SecurityInputMissing)) {
      throw error;
    }
    console.warn('[security-scan] scan input missing', { scanId, reason: error.message });
    return endSecurityInputMissing(env, db, scanId, attempt);
  }
  if (head === null) {
    return null;
  }

  const base = await loadBase(db, scan);
  const baseSnapshot =
    base === null
      ? null
      : await loadBaseSnapshot(r2, securityScanInputPrefix(scan.projectId, base.deploymentId));
  const fallbackOf =
    scan.trigger === 'fallback' ? securityFallbackFullReason(scan.coverageNotes) : null;
  let tier = chooseSecurityTier({
    trigger: scan.trigger,
    baseDeploymentId: base?.deploymentId ?? null,
    baseSnapshot: baseSnapshot !== null,
    fallbackOf,
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
  const memory = await loadSecurityMemory(db, scan.projectId);
  const lastSucceededAt = base?.finishedAt ?? null;
  const recheckFiles = memory.findings.flatMap((finding) =>
    finding.state === 'resolved' &&
    finding.resolution === 'fixed' &&
    finding.file !== null &&
    (lastSucceededAt === null ||
      (finding.resolvedAt !== null && Date.parse(finding.resolvedAt) > Date.parse(lastSucceededAt)))
      ? [finding.file]
      : [],
  );

  // T1 when GitHub can show the change (hosted only); otherwise T2 stays, with a note.
  const manifest = readSecurityManifest(scan.manifest);
  const main = manifest?.workerMain ?? null;
  let sourceDiff: SecuritySourceDiffInput | null = null;
  const notes: Array<string> = [];
  // The bundle's sources, read once: by T1 only when it can start, else by the build.
  const bundle: BundleSourcesOnce = {};
  if (tier.tier === 'built_diff' && base !== null && diffBase !== null) {
    const assetBytes = textBytes(assets);
    const memoryFiles = 2 + Math.min(memory.findings.length, SECURITY_MEMORY_HISTORY_MAX_FILES);
    const result = await loadSecuritySourceDiff(env, db, {
      scanId: scan.id,
      attempt: scan.attempt,
      projectId: scan.projectId,
      deploymentId: scan.deploymentId,
      baseDeploymentId: base.deploymentId,
      headCommit: scan.commit,
      bundle: () => (bundle.value ??= bundleSources(head.files, main)),
      headModules: new Map(head.modules.map((module) => [module.name, module.sha256])),
      baseModules: diffBase.modules,
      baseSources: diffBase.sources,
      budget: {
        bytes: Math.max(0, SECURITY_INPUT_MAX_BYTES - assetBytes),
        files: Math.max(0, SCAN_INPUT_LIMITS.maxFiles - memoryFiles - assets.length),
      },
    });
    if (result.ok) {
      sourceDiff = result.diff;
      tier = chooseSecurityTier({
        trigger: scan.trigger,
        baseDeploymentId: base.deploymentId,
        baseSnapshot: true,
        sourceDiff: true,
      });
    } else if (result.note !== null) {
      notes.push(result.note);
    }
  }

  const secrets = await loadSecuritySecrets(env, db, scan.projectId);
  // M31: text assets too big to read are still searched for the stored secret values.
  const large = await searchLargeAssets(
    env,
    scan.projectId,
    headAssets,
    diffBase?.assets ?? null,
    secrets,
  );
  // M31: a rescan that asked for the client asset pass (a full scan: every text asset).
  const clientAssets =
    scan.coverageNotes.includes(SECURITY_CLIENT_ASSETS_NOTE) && tier.tier === 'full';
  let client: Awaited<ReturnType<typeof loadClientSources>> | null = null;
  if (clientAssets) {
    // Only what the read set can still take after the bundle's sources and the assets.
    const sources = (bundle.value ??= bundleSources(head.files, main));
    const used = textBytes(sources.files) + textBytes(assets);
    client = await loadClientSources(
      env,
      scan.projectId,
      headAssets,
      assets,
      Math.max(0, SECURITY_INPUT_MAX_BYTES - used),
    );
  }
  const deployConfigText = securityDeployConfigText(manifest);
  const built = buildSecurityScanInput({
    scan: {
      id: scan.id,
      attempt: scan.attempt,
      engine: scan.engine,
      model: scan.model,
      trigger: scan.trigger,
      forPublicRequest: scan.publicRequestId !== null,
      commit: scan.commit,
      // M30: the controller asks for a runtime copy; verify sessions may use it.
      runtimeCopy: securityRuntimeCopyWanted(manifest, scan.engine),
    },
    tier,
    sourceDiff,
    notes,
    head: { modules: head.files, main },
    deployConfig:
      deployConfigText === null
        ? null
        : { text: deployConfigText, sha256: sha256Hex(deployConfigText) },
    bundle: bundle.value ?? null,
    base: diffBase,
    assets,
    unreadAssets,
    clientAssets,
    clientSources: client?.sources ?? [],
    clientMapsUnread: client?.unread ?? 0,
    searchedAssets: large.searched,
    unsearchedAssets: large.unsearched.size,
    backlog,
    recheckFiles,
    secrets,
    // T1: the repo lockfile, else the deploy's claims; with neither, third-party code ranks last.
    lockfile: sourceDiff?.lockfile ?? packageClaims,
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
  await r2.put(modulesKey(headPrefix), versionOneJson('modules', head.modules));
  await r2.put(
    `${headPrefix}sources.json`,
    versionOneJson('hashes', Object.fromEntries(built.sourceIndex)),
  );
  await r2.put(
    `${headPrefix}never-sent.json`,
    versionOneJson('files', Object.fromEntries(built.neverSent)),
  );
  // Assets not read (or, too big, not searched) stay out, so the next scan sees them as changed.
  const indexed = headAssets.filter(
    (asset) => !built.unscannedAssets.has(asset.path) && !large.unsearched.has(asset.path),
  );
  const assetIndex = Object.fromEntries(indexed.map((asset) => [asset.path, asset.hash]));
  await r2.put(`${headPrefix}assets.json`, versionOneJson('hashes', assetIndex));
  const scanPrefix = securityRawOutputPrefix(scan.projectId, scan.id);
  await r2.put(`${scanPrefix}backlog.json`, serializeSecurityBacklog(built.backlog));
  await r2.put(`${scanPrefix}server-leads.json`, versionOneJson('leads', built.serverLeads));
  await r2.put(`${scanPrefix}scope.json`, scanScope(built));

  const baseScanId = base?.id ?? null;
  const baseDeploymentId = base?.deploymentId ?? null;
  const extra = { base_scan_id: baseScanId, base_deployment_id: baseDeploymentId };
  if (!(await recordSecurityBuiltInput(db, scan.id, scan.attempt, built, extra))) {
    return null;
  }
  return { built, baseScanId, baseDeploymentId };
}

const INPUT_ENTRY_PREFIX = 'input/';

/** The paths the scan looked at and each input file's hash (unredacted for a source). */
function scanScope(built: SecurityBuiltInput): string {
  const hashes = new Map<string, string>();
  for (const entry of built.entries) {
    if (!entry.path.startsWith(INPUT_ENTRY_PREFIX)) {
      continue;
    }
    const path = entry.path.slice(INPUT_ENTRY_PREFIX.length);
    hashes.set(path, built.sourceIndex.get(path) ?? sha256Hex(entry.data));
  }
  const full = built.tier === 'full';
  return serializeSecurityScanScope({
    full,
    paths: full ? [...hashes.keys()] : [...built.focus],
    hashes,
  });
}

/**
 * `SecurityScanControl.input()`: the tar stream, or `null`. A scan with no file to send is
 * stored here as `succeeded` with no model call (edge #14) and `null` stops the container.
 */
export async function prepareSecurityScanInput(
  env: SecurityInputEnv,
  db: Db,
  scanId: string,
  attempt: number,
): Promise<ReadableStream<Uint8Array> | null> {
  const prepared = await prepareSecurityScanInputFiles(env, db, scanId, attempt);
  if (prepared === null) {
    return null;
  }
  if (prepared.built.emptyFocus) {
    await ingestSecurityScanResult(
      env,
      db,
      scanId,
      attempt,
      { status: null, findings: null },
      { noModelRun: { noChanges: prepared.built.noChanges } },
    );
    return null;
  }
  return tarStream(prepared.built.entries);
}
