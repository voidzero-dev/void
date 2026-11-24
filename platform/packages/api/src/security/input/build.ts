/**
 * Builds one scan's input (design doc 0095, M10) from data already read: the
 * deployed Worker modules, the base snapshot's hashes, changed text assets, the
 * backlog, project secrets and past findings. Pure apart from hashing; the I/O
 * lives in `prepare.ts`.
 *
 *   modules ─► sources (source maps) ─► filters / third-party / path check ─► candidates
 *   candidates ─► read set (32 MB, the runner's 16 MB a file and 20,000 entries)
 *     └─► T2: changed by hash ─► focus (backlog first, 400 files / 2 MB) ─► rest → backlog
 *   changed (or backlog) files left out of the read set ─► backlog, never "seen"
 *   read set + memory ─► redaction ─► tar entries (`task.json`, `input/…`, `memory/…`)
 *   focus ─► phrase check ─► server leads
 *   read set + built modules + searched assets ─► stored secret values found (M31)
 *     ─► server leads (`secret_in_output`), one per secret and side (client / Worker)
 */
import type { SecurityEngine } from '@void/platform/security-models';
import { SCAN_INPUT_LIMITS } from '../../../../security-scanner/src/runner/limits.ts';
import type { DeployManifest } from '../../types.ts';
import type { SecurityScanTier, SecurityScanTrigger } from '../schema.ts';
import { SECURITY_BACKLOG_MAX_PATHS, selectSecurityFocus } from './backlog.ts';
import type { SecurityFocusCandidate } from './backlog.ts';
import { looksBinary, securityInputFilter } from './filters.ts';
import { buildSecurityMemory, SECURITY_MEMORY_HISTORY_MAX_FILES } from './memory.ts';
import type { SecurityMemoryInput } from './memory.ts';
import { reviewerTextLeads } from './phrase-check.ts';
import type { SecurityServerLead, SecuritySecretLead } from './phrase-check.ts';
import { createSecurityRedactor } from './redact.ts';
import type { SecuritySecret, SecuritySecretHit } from './redact.ts';
import {
  assetInputPath,
  bundleSources,
  SECURITY_BUILT_PREFIX,
  SECURITY_CLIENT_PREFIX,
  changedSources,
} from './t2.ts';
import type { SecurityBundleSources, SecurityModuleFile, SecuritySourceFile } from './t2.ts';
import { assertTarPath } from './tar.ts';
import type { TarEntry } from './tar.ts';
import { classifyThirdParty } from './third-party.ts';
import type { SecurityLockfileIndex } from './third-party.ts';
import { SECURITY_FULL_REASON_NOTES } from './tier.ts';
import type { SecurityTierChoice } from './tier.ts';

/** Text sent to the container in all, so a scan input fits the API isolate's memory. */
export const SECURITY_INPUT_MAX_BYTES = 32 * 1024 * 1024;
/** Where the deployment's vars and binding names go under `/scan/input`. */
export const SECURITY_DEPLOY_CONFIG_PATH = '_deploy/bindings.json';

/**
 * The manifest fields a review needs: plain-text `vars` (values included: they ship in
 * the Worker, and a stored secret value in one is redacted like any file) and the names
 * of the bindings, Durable Objects, queues and cron schedules. `null` with no manifest.
 */
export function securityDeployConfigText(manifest: DeployManifest | null): string | null {
  if (manifest === null) {
    return null;
  }
  const config = {
    vars: manifest.vars ?? {},
    bindings: manifest.bindings ?? {},
    ...(manifest.durableObjects ? { durableObjects: manifest.durableObjects.bindings } : {}),
    ...(manifest.queues?.length ? { queues: manifest.queues } : {}),
    ...(manifest.schedules?.length ? { schedules: manifest.schedules } : {}),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
/** Dropped code above this share of the bundle's source bytes makes the scan `partial`. */
export const SECURITY_DROPPED_PARTIAL_SHARE = 0.05;
/**
 * The coverage note of a rescan that asked for the client asset pass (M31): set when
 * it is queued, kept by the builder, so a fallback of that rescan asks for it too.
 */
export const SECURITY_CLIENT_ASSETS_NOTE = 'client-assets';

/** A source of a client bundle, from the source map of a deployed asset (M31). */
export type SecurityClientSource = Readonly<{
  /** The bundle's path as deployed. */
  asset: string;
  /** The source's path from the map, normalized; sent under `_client/`. */
  path: string;
  text: string;
}>;

/** Secret findings (secret and side) one scan sends to ingest, at most. */
export const SECURITY_MAX_SECRET_LEADS = 200;
/** Other files one secret finding lists besides its first. */
const MAX_SECRET_OTHER_FILES = 10;
/** Secret-like file names listed in the coverage notes, at most. */
const MAX_LISTED_SECRET_FILES = 20;

export type SecurityInputAsset = Readonly<{ path: string; text: string }>;

/** A T1 source diff's files (`t1-github.ts`), in place of the bundle's sources. */
export type SecuritySourceDiffInput = Readonly<{
  /** Readable files in priority order: repo files in scope, then bundle-only sources. */
  files: ReadonlyArray<SecuritySourceFile>;
  /** Input paths changed since the base: the comparison's and the built output's. */
  changed: ReadonlySet<string>;
  /** Files in scope left unread (the read limits); changed ones go to the backlog. */
  unread: ReadonlyArray<Readonly<{ path: string; bytes: number; sha256: string }>>;
  /** Secret-like files in scope, never read; listed in the coverage notes. */
  secret: ReadonlyArray<Readonly<{ path: string; bytes: number }>>;
  notes: ReadonlyArray<string>;
  /** The repo lockfile read with the files (`null`: none, too big or not understood). */
  lockfile?: SecurityLockfileIndex | null;
}>;

export type SecurityInputPlan = Readonly<{
  scan: Readonly<{
    id: string;
    attempt: number;
    engine: SecurityEngine;
    model: string;
    trigger: SecurityScanTrigger;
    /**
     * It runs for an open public request: a fallback of a gate scan (M26) then follows
     * the gate rules too. Only read with `trigger: fallback`.
     */
    forPublicRequest?: boolean;
    /** The deployment's claimed commit; `null` for a dirty tree, `--skip-build`, no git. */
    commit: string | null;
    /** M30: a runtime copy is made for this scan (task `runtime_copy`). */
    runtimeCopy?: boolean;
  }>;
  tier: SecurityTierChoice;
  /** The T1 files; required when `tier` is `source_diff`, ignored otherwise. */
  sourceDiff?: SecuritySourceDiffInput | null;
  /** Coverage notes from before the build (why T1 fell back to T2). */
  notes?: ReadonlyArray<string>;
  head: Readonly<{ modules: ReadonlyArray<SecurityModuleFile>; main: string | null }>;
  /**
   * The deployment's env from its manifest (`SECURITY_DEPLOY_CONFIG_PATH`): plain-text
   * vars and binding names. A secret written into `vars` is only here, never in code.
   */
  deployConfig?: Readonly<{ text: string; sha256: string }> | null;
  /** `bundleSources(head.modules, head.main)` when the caller already has it. */
  bundle?: SecurityBundleSources | null;
  /** The base snapshot's hashes; `null` for a full scan. */
  base: Readonly<{
    modules: ReadonlyMap<string, string>;
    sources: ReadonlyMap<string, string> | null;
  }> | null;
  /** Changed text assets (all text assets for a full scan), already read. */
  assets: ReadonlyArray<SecurityInputAsset>;
  /** Changed text assets that were not read (over the read limits, or gone from storage). */
  unreadAssets?: ReadonlyArray<string>;
  /** M31: run the client asset pass (a rescan asked for it): read `clientSources` too. */
  clientAssets?: boolean;
  /** The sources the maps of the read client bundles carry, in asset order. */
  clientSources?: ReadonlyArray<SecurityClientSource>;
  /** Client source maps that were not read (over the map limits, or gone from storage). */
  clientMapsUnread?: number;
  /**
   * M31: secrets found in text assets too big to read (searched only, never sent), by
   * deployed path. `unsearchedAssets` counts the big ones not searched (the limits).
   */
  searchedAssets?: ReadonlyArray<
    Readonly<{ path: string; hits: ReadonlyArray<SecuritySecretHit> }>
  >;
  unsearchedAssets?: number;
  backlog: ReadonlyArray<string>;
  /** Files of findings resolved `fixed` that a gate scan must re-check (edge #85). */
  recheckFiles: ReadonlyArray<string>;
  secrets: ReadonlyArray<SecuritySecret>;
  lockfile: SecurityLockfileIndex | null;
  memory: Omit<SecurityMemoryInput, 'diffPaths' | 'backlog'>;
}>;

/** The `task.json` the runner reads. */
interface SecurityScanTask {
  [field: string]: unknown;
}

export type SecurityBuiltInput = Readonly<{
  entries: ReadonlyArray<TarEntry>;
  task: Readonly<SecurityScanTask>;
  tier: SecurityScanTier;
  coverage: 'complete' | 'partial';
  notes: ReadonlyArray<string>;
  /** Paths under `/scan/input` sent as focus. */
  focus: ReadonlyArray<string>;
  /**
   * The backlog this scan leaves; the project's backlog once it succeeds (M12). It
   * holds every changed file this scan did not read, so none is counted as seen.
   */
  backlog: ReadonlyArray<string>;
  filesScanned: number;
  droppedFiles: number;
  droppedBytes: number;
  inputBytes: number;
  serverLeads: ReadonlyArray<SecurityServerLead>;
  /**
   * Source path → sha256 of its (unredacted) text: the next scan's base index.
   * Files this scan did not read are left out, so the next scan sees them as changed.
   */
  sourceIndex: ReadonlyMap<string, string>;
  /** Asset paths (as in `plan.assets` / `unreadAssets`) this scan did not read. */
  unscannedAssets: ReadonlySet<string>;
  /**
   * A diff scan with no file to send (empty focus): no model runs and ingest stores the
   * scan server-side. `noChanges` when the diff was empty too (edge #14).
   */
  emptyFocus: boolean;
  /** A diff scan with nothing changed (edge #14): `status_reason` `no_changes`. */
  noChanges: boolean;
}>;

/** UTF-8 byte count without encoding the text (a lone surrogate encodes as U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x8_00) {
      bytes += 2;
    } else if (code >= 0xd8_00 && code <= 0xdb_ff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc_00 && next <= 0xdf_ff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Whether `path` (under `/scan/input`) can be a tar entry and a `changed_files` path. */
function usableInputPath(path: string): boolean {
  if (path.length > SCAN_INPUT_LIMITS.maxTaskPathChars) {
    return false;
  }
  try {
    assertTarPath(`input/${path}`);
    return true;
  } catch {
    return false;
  }
}

type Candidate = SecuritySourceFile & {
  bytes: number;
  unverified: boolean;
  /** The asset's path as deployed; `null` for server code. */
  asset: string | null;
};

type ReadFile = Candidate & { sent: string; sentBytes: number };

type SecretLeadDraft = Omit<SecuritySecretLead, 'forms' | 'alsoIn' | 'files'> & {
  forms: Array<SecuritySecretHit['forms'][number]>;
  alsoIn: Array<string>;
  files: number;
};

export function buildSecurityScanInput(plan: SecurityInputPlan): SecurityBuiltInput {
  const notes: Array<string> = [...(plan.notes ?? [])];
  const sourceDiff = plan.tier.tier === 'source_diff' ? (plan.sourceDiff ?? null) : null;
  if (plan.tier.tier === 'source_diff' && sourceDiff === null) {
    throw new Error('a source diff scan needs its source files');
  }
  const bundle = plan.bundle ?? bundleSources(plan.head.modules, plan.head.main);
  const noSourceMaps = bundle.noSourceMaps;
  // The deploy config goes first: it is small, and a secret in `vars` is only there.
  const deployConfig: Array<SecuritySourceFile> = plan.deployConfig
    ? [
        {
          path: SECURITY_DEPLOY_CONFIG_PATH,
          text: plan.deployConfig.text,
          sha256: plan.deployConfig.sha256,
          module: '',
          map: null,
          built: false,
        },
      ]
    : [];
  const sources = [...deployConfig, ...(sourceDiff?.files ?? bundle.files)];
  const sourceIndex = new Map<string, string>();
  let totalSourceBytes = 0;
  let droppedFiles = 0;
  let droppedBytes = 0;
  let thirdPartyDropped = 0;
  let badPaths = 0;
  /** Files over the runner's per-file limit: they can never be sent (noted, not backlogged). */
  let oversized = 0;
  /** Code or text assets that are not UTF-8 text (a NUL byte or U+FFFD): never sent, noted. */
  let binary = 0;
  // Code left out for coverage reasons (registry packages, the input cap). Secret-like
  // files are dropped on purpose and do not make a scan partial.
  let lostBytes = 0;
  const secretFiles: Array<string> = [];
  const firstParty: Array<Candidate> = [];
  const unverified: Array<Candidate> = [];
  const dropBadPath = (bytes: number) => {
    badPaths++;
    droppedFiles++;
    droppedBytes += bytes;
    lostBytes += bytes;
  };
  const dropBinary = (bytes: number) => {
    binary++;
    droppedFiles++;
    droppedBytes += bytes;
    lostBytes += bytes;
  };
  const dropOversized = (file: Readonly<{ path: string; sha256: string; bytes: number }>) => {
    oversized++;
    droppedFiles++;
    droppedBytes += file.bytes;
    lostBytes += file.bytes;
    if (file.sha256 !== '') {
      // Seen as it is: the next diff scan does not take it as changed again.
      sourceIndex.set(file.path, file.sha256);
    }
  };

  for (const source of sources) {
    const bytes = utf8Length(source.text);
    totalSourceBytes += bytes;
    const filter = securityInputFilter(source.path);
    if (filter === 'secret') {
      secretFiles.push(source.path);
      droppedFiles++;
      droppedBytes += bytes;
      continue;
    }
    if (filter === 'skipped') {
      continue;
    }
    if (looksBinary(source.text)) {
      // Not text the scanner can read: counted, so the scan is not labeled complete.
      sourceIndex.set(source.path, source.sha256);
      dropBinary(bytes);
      continue;
    }
    const party = classifyThirdParty(source.path, plan.lockfile);
    if (party === 'registry') {
      sourceIndex.set(source.path, source.sha256);
      thirdPartyDropped++;
      lostBytes += bytes;
      droppedFiles++;
      droppedBytes += bytes;
      continue;
    }
    if (!usableInputPath(source.path)) {
      // It can never be sent: noted and counted as lost, not left in the backlog.
      sourceIndex.set(source.path, source.sha256);
      dropBadPath(bytes);
      continue;
    }
    const file = { ...source, bytes, unverified: party === 'unverified', asset: null };
    (file.unverified ? unverified : firstParty).push(file);
  }
  // T1: secret-like repo files were never read. Unread ones that changed (or wait in
  // the backlog) count as cut below; unchanged ones are read access only (§7.4), so
  // they are dropped without making a diff scan partial.
  const unreadSources: Array<Candidate> = [];
  const unreadUnchanged: Array<Candidate> = [];
  if (sourceDiff !== null) {
    const waiting = new Set(plan.backlog);
    notes.push(...sourceDiff.notes);
    for (const file of sourceDiff.secret) {
      totalSourceBytes += file.bytes;
      secretFiles.push(file.path);
      droppedFiles++;
      droppedBytes += file.bytes;
    }
    for (const file of sourceDiff.unread) {
      const due = sourceDiff.changed.has(file.path) || waiting.has(file.path);
      if (due) {
        totalSourceBytes += file.bytes;
      }
      if (due && file.bytes > SCAN_INPUT_LIMITS.maxFileBytes) {
        dropOversized(file);
        continue;
      }
      (due ? unreadSources : unreadUnchanged).push({
        path: file.path,
        text: '',
        sha256: file.sha256,
        module: '',
        map: null,
        built: false,
        bytes: file.bytes,
        unverified: false,
        asset: null,
      });
    }
  }

  // Text assets: client code, after server code.
  const assetFiles: Array<Candidate> = [];
  const unscannedAssets = new Set<string>();
  /** Input paths of changed assets that were not read, by deployed path. */
  const unreadAssetPaths = new Map<string, string>();
  const taken = new Set([...firstParty, ...unverified].map((file) => file.path));
  const assetPath = (path: string): string | null => {
    const inputPath = assetInputPath(path);
    if (inputPath === null || taken.has(inputPath) || securityInputFilter(inputPath) !== null) {
      return null;
    }
    if (!usableInputPath(inputPath)) {
      dropBadPath(0);
      return null;
    }
    taken.add(inputPath);
    return inputPath;
  };
  for (const asset of plan.assets) {
    const path = assetPath(asset.path);
    if (path === null) {
      continue;
    }
    if (looksBinary(asset.text)) {
      dropBinary(0);
      continue;
    }
    assetFiles.push({
      path,
      text: asset.text,
      sha256: '',
      module: '',
      map: null,
      built: false,
      bytes: utf8Length(asset.text),
      unverified: false,
      asset: asset.path,
    });
  }
  for (const asset of plan.unreadAssets ?? []) {
    const path = assetPath(asset);
    if (path !== null) {
      unreadAssetPaths.set(asset, path);
      unscannedAssets.add(asset);
    }
  }

  // Memory entries are counted before code is cut: task.json, the index, history files.
  const memoryEntries =
    2 + Math.min(plan.memory.findings.length, SECURITY_MEMORY_HISTORY_MAX_FILES);
  const maxInputFiles = SCAN_INPUT_LIMITS.maxFiles - memoryEntries;

  // The read set, in priority order, cut to what one isolate holds and the runner takes.
  const redactor = createSecurityRedactor(plan.secrets);
  const ordered = [...firstParty, ...assetFiles, ...unverified];
  const readSet: Array<ReadFile> = [];
  const cut: Array<Candidate> = [];
  // One lead per secret and side, at the first file it is in (read-set order, then
  // built modules, then big assets): a value inlined in many hashed chunks is one finding.
  const secretLeads = new Map<string, SecretLeadDraft>();
  let secretLeadsDropped = 0;
  const addSecretHits = (
    path: string,
    hits: ReadonlyArray<SecuritySecretHit>,
    client: boolean,
  ): void => {
    for (const hit of hits) {
      const key = `${client ? 'client' : 'worker'}\u0000${hit.name}`;
      const lead = secretLeads.get(key);
      if (lead === undefined) {
        if (secretLeads.size >= SECURITY_MAX_SECRET_LEADS) {
          secretLeadsDropped++;
          continue;
        }
        secretLeads.set(key, {
          kind: 'secret_in_output',
          file: path,
          secret: hit.name,
          forms: [...hit.forms],
          line: hit.line,
          client,
          alsoIn: [],
          files: 1,
        });
        continue;
      }
      if (lead.file === path || lead.alsoIn.includes(path)) {
        continue;
      }
      lead.files++;
      for (const form of hit.forms) {
        if (!lead.forms.includes(form)) {
          lead.forms.push(form);
        }
      }
      if (lead.alsoIn.length < MAX_SECRET_OTHER_FILES) {
        lead.alsoIn.push(path);
      }
    }
  };
  let readBytes = 0;
  /**
   * Adds the file to the read set when it fits: `read`. `full` when the read set has no
   * room left for it; `never` when it is over the runner's per-file limit, so no scan
   * can ever send it.
   */
  const read = (file: Candidate): 'read' | 'full' | 'never' => {
    if (file.bytes > SCAN_INPUT_LIMITS.maxFileBytes) {
      return 'never';
    }
    if (readSet.length >= maxInputFiles || readBytes + file.bytes > SECURITY_INPUT_MAX_BYTES) {
      return 'full';
    }
    // Redaction can make a text longer: the runner's per-file limit applies to what is sent.
    const sent = redactor.redact(file.text);
    const sentBytes = sent === file.text ? file.bytes : utf8Length(sent);
    if (sentBytes > SCAN_INPUT_LIMITS.maxFileBytes) {
      return 'never';
    }
    readBytes += sentBytes;
    readSet.push({ ...file, sent, sentBytes });
    if (sent !== file.text) {
      // The stored value is in the deployed output: a server finding, by name only.
      addSecretHits(file.path, redactor.hitsIn(file.text), file.asset !== null);
    }
    return 'read';
  };
  for (const file of ordered) {
    const result = read(file);
    if (result === 'never') {
      // Like a bad path: noted and counted as lost, never left in the backlog, so a
      // public request does not queue gate scans for it forever.
      dropOversized(file);
    } else if (result === 'full') {
      cut.push(file);
    }
  }
  if (plan.clientAssets) {
    // M31 client asset pass: the sources of client bundles, from their source maps, in
    // what is left of the read limits. Extra input: the bundles stay in the read set,
    // so a source that does not fit is only noted (no backlog, no partial label).
    notes.push(SECURITY_CLIENT_ASSETS_NOTE);
    const first: Array<Candidate> = [];
    const later: Array<Candidate> = [];
    for (const source of plan.clientSources ?? []) {
      const path = `${SECURITY_CLIENT_PREFIX}${source.path}`;
      if (
        taken.has(path) ||
        securityInputFilter(path) !== null ||
        looksBinary(source.text) ||
        !usableInputPath(path)
      ) {
        continue;
      }
      const party = classifyThirdParty(source.path, plan.lockfile);
      if (party === 'registry') {
        continue;
      }
      taken.add(path);
      (party === 'unverified' ? later : first).push({
        path,
        text: source.text,
        sha256: '',
        module: '',
        map: null,
        built: false,
        bytes: utf8Length(source.text),
        unverified: party === 'unverified',
        asset: source.asset,
      });
    }
    let clientRead = 0;
    let clientLeft = 0;
    for (const file of [...first, ...later]) {
      if (read(file) === 'read') {
        clientRead++;
      } else {
        clientLeft++;
      }
    }
    notes.push(`client-sources ${clientRead} files`);
    if (clientLeft > 0) {
      notes.push(`client-sources-left ${clientLeft} files`);
    }
    if ((plan.clientMapsUnread ?? 0) > 0) {
      notes.push(`client-maps-unread ${plan.clientMapsUnread} files`);
    }
  }
  // The read set holds a module's sources when it has a map, but a value the build
  // wrote in (`define`, `import.meta.env`) is only in the built code: search every
  // deployed module as built too. Never sent, so it costs no input.
  for (const module of plan.head.modules) {
    const path = `${SECURITY_BUILT_PREFIX}${module.name}`;
    if (
      module.name.endsWith('.map') ||
      module.text.length === 0 ||
      looksBinary(module.text) ||
      !usableInputPath(path)
    ) {
      continue;
    }
    addSecretHits(path, redactor.hitsIn(module.text), false);
  }
  // Text assets too big to read were searched by the caller (only the hits come here).
  for (const asset of plan.searchedAssets ?? []) {
    const path = assetInputPath(asset.path);
    if (path !== null && usableInputPath(path)) {
      addSecretHits(path, asset.hits, true);
    }
  }
  if ((plan.unsearchedAssets ?? 0) > 0) {
    notes.push(`secret-check-unread ${plan.unsearchedAssets} files`);
  }
  if (secretLeadsDropped > 0) {
    notes.push(`secret-leads-capped ${secretLeadsDropped}`);
  }
  cut.push(...unreadSources);
  for (const file of cut) {
    droppedFiles++;
    droppedBytes += file.bytes;
    lostBytes += file.bytes;
  }
  const available = new Map(readSet.map((file) => [file.path, file.sentBytes]));

  // Focus (diff tiers only). Whatever changed (or waited in the backlog) and is still
  // in the bundle but was not read goes back to the backlog: it was not scanned.
  let tier = plan.tier.tier;
  let fullReason = plan.tier.fullReason;
  let focus: ReadonlyArray<string> = [];
  let backlog: Array<string> = [];
  const unscanned: Array<string> = [];
  let emptyFocus = false;
  if (tier !== 'full' && plan.base) {
    const headModules = new Map(plan.head.modules.map((module) => [module.name, module.sha256]));
    const servers = ordered.filter((file) => file.asset === null);
    const changed = new Set(
      sourceDiff?.changed ??
        changedSources(servers, headModules, plan.base.modules, plan.base.sources).map(
          (file) => file.path,
        ),
    );
    // The deploy config has no module: it changed when its text did (vars only, too).
    for (const file of deployConfig) {
      if (plan.base.sources?.get(file.path) !== file.sha256) {
        changed.add(file.path);
      }
    }
    const gateScan =
      plan.scan.trigger === 'gate' ||
      (plan.scan.trigger === 'fallback' && plan.scan.forPublicRequest === true);
    const diff: Array<SecurityFocusCandidate> = [];
    if (gateScan) {
      // A gate scan (or its fallback) always re-checks the files of open `fixed` claims
      // (edge #85): a Void build changes a file on every deploy, so the diff is never
      // empty, and a scan that did not look at a claimed file must not prove it.
      for (const path of plan.recheckFiles) {
        const bytes = available.get(path);
        if (bytes !== undefined) {
          diff.push({ path, bytes });
        }
      }
    }
    for (const file of readSet) {
      if (file.asset !== null || changed.has(file.path)) {
        diff.push({ path: file.path, bytes: file.sentBytes });
      }
    }
    const usableBacklog = plan.backlog.filter(
      (path) => path.length <= SCAN_INPUT_LIMITS.maxTaskPathChars,
    );
    const selected = selectSecurityFocus({ backlog: usableBacklog, diff, available });
    focus = selected.focus;
    backlog = [...selected.backlog];
    const waiting = new Set(usableBacklog);
    for (const file of cut) {
      if (file.asset !== null || changed.has(file.path) || waiting.has(file.path)) {
        unscanned.push(file.path);
      }
    }
    for (const path of unreadAssetPaths.values()) {
      unscanned.push(path);
    }
    if (focus.length === 0 && unscanned.length === 0 && gateScan) {
      // A gate scan is never `no changes` (edge #85). No claimed file to re-check and
      // nothing changed: it reads the whole app.
      tier = 'full';
      fullReason = 'gate_recheck';
    }
    emptyFocus = tier !== 'full' && focus.length === 0;
  }
  for (const file of unreadUnchanged) {
    droppedFiles++;
    droppedBytes += file.bytes;
  }
  if (tier === 'full') {
    // A full scan reads everything it can, unchanged files too: as in T2, the rest is
    // capped and waits for the next scan.
    for (const file of unreadUnchanged) {
      totalSourceBytes += file.bytes;
      lostBytes += file.bytes;
      if (file.bytes > SCAN_INPUT_LIMITS.maxFileBytes) {
        // Counted as dropped above; never sent, so never backlogged.
        oversized++;
        sourceIndex.set(file.path, file.sha256);
      } else {
        cut.push(file);
      }
    }
  }
  const capped = cut.length;
  if (tier === 'full') {
    // A full scan reads everything it can; the rest waits for the next scan.
    unscanned.push(...cut.map((file) => file.path), ...unreadAssetPaths.values());
  }
  if (unscanned.length > 0) {
    const kept = new Set(backlog);
    for (const path of unscanned) {
      if (!kept.has(path)) {
        kept.add(path);
        backlog.push(path);
      }
    }
    backlog = backlog.slice(0, SECURITY_BACKLOG_MAX_PATHS);
  }
  const unscannedSet = new Set(unscanned);
  for (const file of [...readSet, ...cut, ...unreadUnchanged]) {
    if (file.asset !== null) {
      if (unscannedSet.has(file.path)) {
        unscannedAssets.add(file.asset);
      }
    } else if (!unscannedSet.has(file.path)) {
      sourceIndex.set(file.path, file.sha256);
    }
  }

  if (tier === 'full' && fullReason !== null) {
    notes.push(SECURITY_FULL_REASON_NOTES[fullReason]);
  }
  // Changed files cut to the backlog are changes: such a scan is partial, not "no changes".
  const noChanges = emptyFocus && unscanned.length === 0;
  if (noChanges) {
    notes.push('no-changes');
  }
  if (noSourceMaps > 0) {
    notes.push('no-source-maps');
  }
  // A local check (M32) sends a working tree, not a deployment: there is no claimed commit.
  if (plan.scan.commit === null && plan.scan.trigger !== 'local') {
    notes.push('no-commit');
  }
  if (unverified.length > 0) {
    notes.push(`third-party-unverified ${unverified.length} files`);
  }
  if (thirdPartyDropped > 0) {
    notes.push(`third-party-dropped ${thirdPartyDropped} files`);
  }
  for (const path of secretFiles.slice(0, MAX_LISTED_SECRET_FILES)) {
    notes.push(`dropped secret-like file ${path}`);
  }
  if (secretFiles.length > MAX_LISTED_SECRET_FILES) {
    notes.push(`dropped ${secretFiles.length - MAX_LISTED_SECRET_FILES} more secret-like files`);
  }
  if (badPaths > 0) {
    notes.push(`dropped-bad-path ${badPaths} files`);
  }
  if (oversized > 0) {
    notes.push(`dropped-oversize ${oversized} files`);
  }
  if (binary > 0) {
    notes.push(`dropped-binary ${binary} files`);
  }
  if (capped > 0) {
    notes.push(`input-capped ${capped} files`);
  }
  if (unreadAssetPaths.size > 0) {
    notes.push(`assets-unread ${unreadAssetPaths.size} files`);
  }

  // Memory, then redaction over every text the container gets.
  const memory = buildSecurityMemory({
    ...plan.memory,
    diffPaths: new Set(focus),
    backlog,
  });
  const entries: Array<TarEntry> = [];
  const focusSet = new Set(focus);
  const leadSources: Array<{ path: string; text: string }> = [];
  let inputBytes = 0;
  for (const file of readSet) {
    entries.push({ path: `input/${file.path}`, data: file.sent });
    inputBytes += file.sentBytes;
    // The phrase check reads the diff; a full scan's diff is the project's own code.
    if (tier === 'full' ? !file.unverified : focusSet.has(file.path)) {
      leadSources.push({ path: file.path, text: file.sent });
    }
  }
  const addText = (path: string, text: string) => {
    const data = redactor.redact(text);
    entries.push({ path, data });
    inputBytes += utf8Length(data);
  };
  if (memory.index !== null) {
    addText('memory/index.json', memory.index);
    for (const history of memory.history) {
      addText(`memory/${history.path}`, history.text);
    }
  }
  if (memory.indexTrimmed > 0) {
    notes.push(`memory-index-trimmed ${memory.indexTrimmed}`);
  }
  if (memory.historyTrimmed > 0) {
    notes.push('memory-trimmed');
  }
  if (redactor.hits() > 0) {
    notes.push(`redacted ${redactor.hits()} secret values`);
  }

  const dropShare = totalSourceBytes === 0 ? 0 : lostBytes / totalSourceBytes;
  const droppedPartial = dropShare > SECURITY_DROPPED_PARTIAL_SHARE;
  const partial =
    backlog.length > 0 ||
    droppedPartial ||
    capped > 0 ||
    badPaths > 0 ||
    oversized > 0 ||
    binary > 0 ||
    unscanned.length > 0;
  if (
    droppedPartial &&
    backlog.length === 0 &&
    capped === 0 &&
    badPaths === 0 &&
    oversized === 0 &&
    binary === 0
  ) {
    // Only registry code was dropped: this does not hold a public request (§7.4, #92).
    notes.push('partial-third-party-only');
  }

  const task: SecurityScanTask = {
    version: 1,
    scan_id: plan.scan.id,
    attempt: plan.scan.attempt,
    engine: plan.scan.engine,
    model: plan.scan.model,
    tier,
    changed_files: tier === 'full' ? [] : [...focus],
  };
  if (noChanges) {
    task.no_changes = true;
  }
  if (plan.scan.runtimeCopy) {
    // An older runner ignores it and stays static-only.
    task.runtime_copy = true;
  }
  if (plan.tier.fullReason === 'sweep') {
    // A scheduled sweep (or its fallback, M26) runs the deeper profile (M25). An older runner ignores the field
    // and runs its deploy-diff profile over the whole app.
    task.profile = 'standard';
  }
  const taskText = JSON.stringify(task);
  entries.unshift({ path: 'task.json', data: taskText });
  inputBytes += utf8Length(taskText);

  return {
    entries,
    task,
    tier,
    coverage: partial ? 'partial' : 'complete',
    notes,
    focus,
    backlog,
    filesScanned: tier === 'full' ? readSet.length : focus.length,
    droppedFiles,
    droppedBytes,
    inputBytes,
    serverLeads: [
      ...reviewerTextLeads(leadSources),
      ...[...secretLeads.values()].map(({ alsoIn, files, ...lead }): SecuritySecretLead =>
        files > 1 ? { ...lead, alsoIn, files } : lead,
      ),
    ],
    sourceIndex,
    unscannedAssets,
    emptyFocus,
    noChanges,
  };
}
