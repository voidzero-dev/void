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
 *   assets, backlog, secrets, findings
 *   a diff tier on a hosted install with GitHub ─► T1 source diff (`t1-github.ts`), else T2
 *   build ─► row update ─► tar stream
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
 *   backlog.json (the backlog it leaves), server-leads.json and scope.json (what it
 *   looked at, with each input file's hash), for ingest (`../ingest.ts`).
 *
 * An empty diff (edge #14) never reaches the container: the scan is stored as
 * `succeeded` with no model call and `input()` answers `null`.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { SCAN_INPUT_LIMITS } from '../../../../security-scanner/src/runner/limits.ts';
import type { Db } from '../../db.ts';
import { parseManifest } from '../../deploy/serving-assets.ts';
import type { ApiEnv } from '../../env.ts';
import { loadStoredWorkerModules } from '../../provisioning/durable-objects.ts';
import { deploymentOperations, deployments } from '../../schema.ts';
import { WorkerModuleIntegrityError } from '../../worker-upload.ts';
import {
  pokeSecurityScanScheduler,
  SECURITY_SCAN_COPY_MAX_BYTES,
  securityScanInputPrefix,
  securityScanProjectPrefix,
} from '../enqueue.ts';
import { ingestSecurityScanResult, serializeSecurityScanScope } from '../ingest.ts';
import { securityRawOutputPrefix } from '../maintenance.ts';
import { endSecurityScanAttempt } from '../queue.ts';
import { securityRuntimeCopyWanted } from '../runtime-copy-plan.ts';
import { securityScans, type SecurityScanTrigger } from '../schema.ts';
import { parseSecurityBacklog, serializeSecurityBacklog } from './backlog.ts';
import {
  buildSecurityScanInput,
  SECURITY_CLIENT_ASSETS_NOTE,
  SECURITY_INPUT_MAX_BYTES,
  securityDeployConfigText,
  utf8Length,
  type SecurityBuiltInput,
  type SecurityClientSource,
  type SecurityInputAsset,
  type SecuritySourceDiffInput,
} from './build.ts';
import { looksBinary, securityInputFilter } from './filters.ts';
import { prepareLocalCheckInputFiles } from './local.ts';
import { SECURITY_MEMORY_HISTORY_MAX_FILES } from './memory.ts';
import { loadSecurityMemory, loadSecuritySecrets } from './project-data.ts';
import { createSecurityRedactor, type SecuritySecret, type SecuritySecretHit } from './redact.ts';
import { loadSecuritySourceDiff, type SecuritySourceDiffEnv } from './t1-github.ts';
import {
  assetInputPath,
  bundleSources,
  changedTextAssets,
  oversizedTextAssets,
  readSourceMap,
  SECURITY_CLIENT_PREFIX,
  type SecurityBundleSources,
  type SecurityMapSource,
  securityModuleFile,
  sha256Hex,
  sourceMapFor,
  type SecurityAssetEntry,
  type SecurityModuleFile,
} from './t2.ts';
import { assertTarEntries, tarStream } from './tar.ts';
import { parseSecurityPackageClaims, type SecurityLockfileIndex } from './third-party.ts';
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

/** Text assets read per scan, at most (the focus holds 400 files) … */
const MAX_ASSETS_READ = 400;
/** … and their bytes, so assets and modules together fit the API isolate. */
const MAX_ASSET_BYTES_READ = 16 * 1024 * 1024;
/** Client asset pass (M31): source maps read per scan, at most, … */
const MAX_CLIENT_MAPS_READ = 100;
/** … one map's size (a bigger one is not read) … */
const MAX_CLIENT_MAP_BYTES = 8 * 1024 * 1024;
/** … and all maps' bytes. Only their `sourcesContent` is kept, within what is left of the input limit. */
const MAX_CLIENT_MAP_BYTES_READ = 24 * 1024 * 1024;
/**
 * M31: text assets too big to read are searched for stored secret values, one at a
 * time (only the hits are kept): at most this many files, …
 */
const MAX_SEARCHED_ASSETS = 50;
/** … this size each … */
const MAX_SEARCHED_ASSET_BYTES = 8 * 1024 * 1024;
/** … and these bytes in all. */
const MAX_SEARCHED_ASSET_BYTES_TOTAL = 64 * 1024 * 1024;

/** The deployment's input is gone or too large: the scan ends `failed (input_missing)`. */
export class SecurityInputMissing extends Error {}

export type SnapshotModule = Readonly<{
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
  /** The open public request a gate scan (or a fallback of one) runs for. */
  publicRequestId: string | null;
  /** Set when queued for a fallback that re-runs a full scan (`securityFallbackFullReason`). */
  coverageNotes: ReadonlyArray<string>;
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

export function modulesKey(prefix: string): string {
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

export function parseSnapshotModules(text: string | null): Array<SnapshotModule> | null {
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

/** `local` for a running local check (M32): it has no deployment and its own input. */
async function loadContext(
  db: Db,
  scanId: string,
  attempt: number,
): Promise<ScanContext | 'local' | null> {
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
    return 'local';
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

/** Where a deployment's package claims (`securityPackages`) are kept with its snapshot. */
function packagesKey(prefix: string): string {
  return `${prefix}packages.json`;
}

/**
 * The lockfile claims of the deploy (spec §7.4): what the CLI read from the project's
 * lockfile for the packages its bundle names. Read from the staged deploy body the first
 * time and kept next to the head snapshot, so a retry (and nothing else) reads it back.
 * `null` (keep third-party code, ranked last) for an older CLI or a recovered inline
 * deploy, which send none.
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

/**
 * The client asset pass (M31): the sources of the deployed client bundles, from their
 * source maps (the `sourceMappingURL` comment of a bundle this scan read, an inline map,
 * or `<bundle>.map` deployed next to it, which also covers a bundle too big to read).
 * A map shared by bundles is read once. Maps over the limits,
 * or gone from storage, are counted in `unread`.
 */
async function loadClientSources(
  env: SecurityInputEnv,
  projectId: string,
  head: ReadonlyArray<SecurityAssetEntry>,
  assets: ReadonlyArray<SecurityInputAsset>,
  /** Bytes the read set has left after modules and assets: sources past it are never sent. */
  budget: number,
): Promise<{ sources: Array<SecurityClientSource>; unread: number }> {
  const bare = (path: string) => (path.startsWith('/') ? path.slice(1) : path);
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
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
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
      const entry = maps.get(ref.name)!;
      if (
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
 * M31: changed text assets over the read limit (every one for a full scan), searched
 * for stored secret values one at a time; only the hits are kept. Ones past the limits,
 * or gone from storage, are `unsearched`: left out of the head's asset index, so the
 * next scan searches them again.
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
  for (const asset of oversizedTextAssets(head, base)) {
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

  // T1 when GitHub can show the change (hosted only); otherwise T2 stays, with a note.
  const manifest = parseManifest(scan.manifest);
  const main = manifest?.workerMain ?? null;
  let sourceDiff: SecuritySourceDiffInput | null = null;
  const notes: Array<string> = [];
  // The bundle's sources, read once: by T1 only when it can start, else by the build.
  const bundle: { value?: SecurityBundleSources } = {};
  if (tier.tier === 'built_diff' && base !== null && diffBase !== null) {
    let assetBytes = 0;
    for (const asset of assets) {
      assetBytes += utf8Length(asset.text);
    }
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
    let used = 0;
    for (const file of sources.files) {
      used += utf8Length(file.text);
    }
    for (const asset of assets) {
      used += utf8Length(asset.text);
    }
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
    // T1: the repo lockfile; else the deploy's claims from the project lockfile. With
    // neither, third-party code stays, ranked last (`third-party-unverified`).
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
  await r2.put(modulesKey(headPrefix), serializeModules(head.modules));
  await r2.put(`${headPrefix}sources.json`, serializeHashMap(built.sourceIndex));
  await r2.put(
    `${headPrefix}assets.json`,
    // Assets this scan did not read (or, too big to read, did not search) stay out,
    // so the next scan sees them as changed.
    serializeHashMap(
      new Map(
        headAssets
          .filter(
            (asset) => !built.unscannedAssets.has(asset.path) && !large.unsearched.has(asset.path),
          )
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
  await r2.put(`${scanPrefix}scope.json`, scanScope(built));

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

const INPUT_ENTRY_PREFIX = 'input/';

/**
 * What ingest needs to know about the files: the paths the scan looked at (a diff
 * scan's focus, or every input file of a full scan) and each input file's content
 * hash (a source's unredacted hash, else the hash of the text sent), for the sink.
 */
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
 * `SecurityScanControl.input()`: the tar stream, or `null` (see above). A diff scan with
 * no file to send is stored here as `succeeded` with no model call, the base moves, and
 * `null` stops the container: `no changes` for an empty diff (edge #14), else a partial
 * scan whose changed files all wait in the backlog.
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
