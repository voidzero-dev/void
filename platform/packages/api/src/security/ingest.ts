/**
 * Result ingest (design doc 0095, M12; spec §8.4, §9, §11.4). The controller hands
 * `status.json` and `findings.json` to `SecurityScanControl.result()`; both are
 * written by the container and are untrusted.
 *
 *   status.json ─► parse ─► failed (infrastructure), first attempt ─► requeue (one retry)
 *        │
 *   findings.json ─► the runner's own validator again (shape, limits, paths)
 *        │
 *   one transaction, project row locked, scan row fenced (attempt, running, lease):
 *     succeeded  ─► all records + server leads, 50 + 50 cap on new keys, rejected kept
 *                   apart, not_seen hint, fix_checked_scan_id (not when capped), ledger
 *                   summary (base moves; a diff scan merges the base's ledger)
 *     incomplete ─► validated confirmed records only
 *     other      ─► no finding
 *     scan row ends, reserve back
 *   after commit: promote the backlog (succeeded), raw output to R2, forget the call
 *   ledger, poke the scheduler.
 *
 * The findings email row (M15) is written in the same transaction when `news` is not empty.
 * The public gate re-check (M16) takes `news` / `reopened` from the result.
 */
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import {
  FINDINGS_SCHEMA_VERSION,
  REPORT_LIMITS,
  type FindingRecord,
  type ScanReport,
} from '../../../security-scanner/src/runner/report.ts';
import {
  relativePathProblem,
  validateFindingsValue,
} from '../../../security-scanner/src/runner/validate-findings.ts';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { deployments, projects } from '../schema.ts';
import type { ScanResultReport } from '../security-scanner-controller-runtime.ts';
import { releaseSecurityScanReserveIn } from './budget.ts';
import { pokeSecurityScanScheduler, securityScanProjectPrefix } from './enqueue.ts';
import { queueSecurityFallbackScans } from './fallback.ts';
import { checkScanFence, judgeScanFence } from './fence.ts';
import {
  cutUtf8,
  decideSeenFinding,
  isNewRecord,
  notSeenNow,
  recordFromReport,
  SECURITY_FINDINGS_CAPPED_NOTE,
  SECURITY_MAX_REJECTED_PER_SCAN,
  SECURITY_REJECTED_KEPT_PER_PROJECT,
  SECURITY_REJECTED_REASON_MAX_BYTES,
  securityFingerprintKey,
  selectStoredRecords,
  uniqueStoredRecords,
  type SecurityFindingPatch,
  type SecurityIngestRecord,
  type SecurityIngestScan,
  type SecurityScanScope,
  type SecurityStoredFinding,
} from './findings.ts';
import { parseSecurityBacklog } from './input/backlog.ts';
import type { SecurityServerLead } from './input/phrase-check.ts';
import { securityRawOutputPrefix } from './maintenance.ts';
import { enqueueSecurityNotification } from './notifications.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import { requeueSecurityScan, SECURITY_SCAN_MAX_ATTEMPTS } from './queue.ts';
import {
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityMemoryRejected,
  securityScans,
  type SecurityFindingEventAction,
} from './schema.ts';

// ---------------------------------------------------------------------------
// status.json
// ---------------------------------------------------------------------------

export type SecurityRunnerStatus = 'succeeded' | 'incomplete' | 'failed' | 'refused' | 'timed_out';

/** The reasons each status may carry; any other pair is bad output. */
const STATUS_REASONS: Readonly<Record<SecurityRunnerStatus, ReadonlyArray<string | null>>> = {
  succeeded: [null],
  incomplete: ['budget', 'turn_cap', 'call_cap', 'token_cap', 'run_incomplete'],
  failed: ['bad_output', 'infrastructure', 'credits'],
  refused: [null],
  timed_out: ['wall_clock', 'hard_cap'],
};

export type SecurityParsedStatus = Readonly<{
  status: SecurityRunnerStatus;
  reason: string | null;
  errorClass: string | null;
  refusalCategory: string | null;
  engineVersion: string | null;
}>;

const BAD_STATUS = (errorClass: string): SecurityParsedStatus => ({
  status: 'failed',
  reason: 'bad_output',
  errorClass,
  refusalCategory: null,
  engineVersion: null,
});

/** A short printable label (`[A-Za-z0-9._:/ @-]`, ≤ 80), else `null`. */
export function securityLabel(value: unknown, max = 80): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return null;
  }
  for (const char of value) {
    const ok =
      (char >= 'a' && char <= 'z') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= '0' && char <= '9') ||
      '._:/ @-+'.includes(char);
    if (!ok) {
      return null;
    }
  }
  return value;
}

/**
 * Reads `status.json` (runner) or a status the controller set. A status that names
 * another scan or attempt, an unknown status or a reason that does not go with it is
 * `failed (bad_output)`.
 */
export function parseRunnerStatus(
  value: unknown,
  scanId: string,
  attempt: number,
): SecurityParsedStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return BAD_STATUS('status_unreadable');
  }
  const object = value as Record<string, unknown>;
  const status = object.status;
  if (typeof status !== 'string' || !Object.hasOwn(STATUS_REASONS, status)) {
    return BAD_STATUS('status_unreadable');
  }
  // The runner writes them; the controller's own statuses have none.
  if (
    (object.scan_id !== undefined && object.scan_id !== null && object.scan_id !== scanId) ||
    (object.attempt !== undefined && object.attempt !== null && object.attempt !== attempt)
  ) {
    return BAD_STATUS('status_mismatch');
  }
  const typed = status as SecurityRunnerStatus;
  const reason = object.reason === undefined ? null : object.reason;
  if (reason !== null && typeof reason !== 'string') {
    return BAD_STATUS('status_unreadable');
  }
  if (!STATUS_REASONS[typed].includes(reason)) {
    return BAD_STATUS('status_unreadable');
  }
  return {
    status: typed,
    reason,
    errorClass: securityLabel(object.error_class),
    refusalCategory: typed === 'refused' ? securityLabel(object.refusal_category) : null,
    engineVersion: securityLabel(object.engine_version, 120),
  };
}

// ---------------------------------------------------------------------------
// findings.json
// ---------------------------------------------------------------------------

export type SecurityParsedFindings =
  | Readonly<{ ok: true; report: ScanReport }>
  | Readonly<{ ok: false; kind: string }>;

/**
 * The same check the runner gave the model's report (`validate-findings.ts`): shape,
 * field limits, verdict rules and paths under `/scan/input`. One copy of the rules on
 * both sides, no schema library in the Worker.
 */
export function parseFindingsReport(text: string | null): SecurityParsedFindings {
  if (text === null) {
    return { ok: false, kind: 'findings_missing' };
  }
  if (new TextEncoder().encode(text).length > REPORT_LIMITS.maxBytes) {
    return { ok: false, kind: 'too_large' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'not_json' };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { schema_version?: unknown }).schema_version !== FINDINGS_SCHEMA_VERSION
  ) {
    return { ok: false, kind: 'schema_version' };
  }
  const result = validateFindingsValue(value);
  return result.ok ? { ok: true, report: result.report } : { ok: false, kind: result.kind };
}

// ---------------------------------------------------------------------------
// Outcome (spec §8.4, §11.4)
// ---------------------------------------------------------------------------

export type SecurityScanOutcome = Readonly<{
  status: SecurityRunnerStatus;
  reason: string | null;
  errorClass: string | null;
  failureCause: 'installation' | 'project' | null;
  refusalCategory: string | null;
  /** Which records are stored: all (`succeeded`), validated confirmed only, or none. */
  store: 'all' | 'confirmed' | 'none';
  report: ScanReport | null;
}>;

/** What the parsed status and report mean for the row and the findings. */
export function securityScanOutcome(
  status: SecurityParsedStatus,
  findings: SecurityParsedFindings,
): SecurityScanOutcome {
  const base = {
    reason: status.reason,
    errorClass: status.errorClass,
    refusalCategory: status.refusalCategory,
    report: null,
  };
  switch (status.status) {
    case 'succeeded':
      if (!findings.ok) {
        return {
          ...base,
          status: 'failed',
          reason: 'bad_output',
          errorClass: findings.kind,
          failureCause: 'project',
          store: 'none',
        };
      }
      if (findings.report.run_status === 'incomplete') {
        return {
          ...base,
          status: 'incomplete',
          reason: 'run_incomplete',
          failureCause: 'project',
          store: 'confirmed',
          report: findings.report,
        };
      }
      return {
        ...base,
        status: 'succeeded',
        failureCause: null,
        store: 'all',
        report: findings.report,
      };
    case 'incomplete':
      return {
        ...base,
        status: 'incomplete',
        failureCause: 'project',
        store: findings.ok ? 'confirmed' : 'none',
        report: findings.ok ? findings.report : null,
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        failureCause:
          status.reason === 'infrastructure' || status.reason === 'credits'
            ? 'installation'
            : 'project',
        store: 'none',
      };
    case 'refused':
    case 'timed_out':
      return { ...base, status: status.status, failureCause: 'project', store: 'none' };
  }
}

/** A container or controller failure gets one more attempt (spec §6.2). */
export function shouldRetrySecurityScan(status: SecurityParsedStatus, attempt: number): boolean {
  return (
    status.status === 'failed' &&
    status.reason === 'infrastructure' &&
    attempt < SECURITY_SCAN_MAX_ATTEMPTS
  );
}

// ---------------------------------------------------------------------------
// Per-scan files written at input time (`input/prepare.ts`)
// ---------------------------------------------------------------------------

export type SecurityScanScopeFile = SecurityScanScope &
  Readonly<{
    /** Input path → content hash, for `sink_content_hash`. */
    hashes: ReadonlyMap<string, string>;
  }>;

export function serializeSecurityScanScope(
  input: Readonly<{
    full: boolean;
    paths: ReadonlyArray<string>;
    hashes: ReadonlyMap<string, string>;
  }>,
): string {
  return JSON.stringify({
    version: 1,
    full: input.full,
    paths: input.paths,
    hashes: Object.fromEntries(input.hashes),
  });
}

function stringList(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function parseSecurityScanScope(
  text: string | null,
  backlog: ReadonlyArray<string>,
): SecurityScanScopeFile | null {
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.version !== 1 || typeof value.full !== 'boolean') {
      return null;
    }
    const hashes = new Map<string, string>();
    if (typeof value.hashes === 'object' && value.hashes !== null) {
      for (const [path, hash] of Object.entries(value.hashes as Record<string, unknown>)) {
        if (typeof hash === 'string') {
          hashes.set(path, hash);
        }
      }
    }
    return {
      full: value.full,
      paths: new Set(stringList(value.paths)),
      unread: new Set(backlog),
      hashes,
    };
  } catch {
    return null;
  }
}

function parseServerLeads(text: string | null): Array<SecurityServerLead> {
  if (text === null) {
    return [];
  }
  try {
    const value = JSON.parse(text) as { version?: unknown; leads?: unknown };
    if (value.version !== 1 || !Array.isArray(value.leads)) {
      return [];
    }
    return value.leads.filter(
      (lead): lead is SecurityServerLead =>
        typeof lead === 'object' &&
        lead !== null &&
        (lead as SecurityServerLead).kind === 'reviewer_text' &&
        typeof (lead as SecurityServerLead).file === 'string' &&
        relativePathProblem((lead as SecurityServerLead).file) === null &&
        Array.isArray((lead as SecurityServerLead).hits),
    );
  } catch {
    return [];
  }
}

/** A server lead (text aimed at AI reviewers, spec §10.3) as a stored record. */
export function recordFromServerLead(
  projectId: string,
  lead: SecurityServerLead,
  hashes: ReadonlyMap<string, string>,
): SecurityIngestRecord {
  const hits = lead.hits.slice(0, 20).map((hit) => ({
    phrase: String(hit.phrase).slice(0, 40),
    line: Number.isSafeInteger(hit.line) ? hit.line : null,
  }));
  const fingerprint = `server:${lead.kind}`;
  const firstLine = hits.find((hit) => hit.line !== null)?.line ?? null;
  return {
    key: securityFingerprintKey(projectId, fingerprint, lead.file, 'server'),
    fingerprint,
    verdict: 'needs_validation',
    severity: null,
    confidence: null,
    title: `Text aimed at AI reviewers in ${lead.file}`.slice(0, REPORT_LIMITS.title),
    category: 'ai-reviewer-text',
    cwe: null,
    file: lead.file,
    lineStart: firstLine,
    lineEnd: firstLine,
    sinkPath: lead.file,
    sinkHash: hashes.get(lead.file) ?? null,
    outsideDiff: false,
    detail: { hits },
    source: 'server',
  };
}

/** The server-built coverage ledger summary (spec §10.1 item 6): paths + status only. */
export const SECURITY_LEDGER_MAX_BYTES = 6 * 1024;

type LedgerStatus = 'finding' | 'scanned' | 'backlog';
type LedgerFile = { path: string; status: LedgerStatus };
const LEDGER_STATUSES: ReadonlyArray<LedgerStatus> = ['finding', 'scanned', 'backlog'];

/** The files of a stored ledger summary; empty when it is missing or not ours. */
export function parseSecurityLedgerSummary(
  value: unknown,
): Readonly<{ files: Array<LedgerFile>; omitted: number }> {
  const empty = { files: [], omitted: 0 };
  if (typeof value !== 'object' || value === null) {
    return empty;
  }
  const ledger = value as { version?: unknown; files?: unknown; omitted?: unknown };
  if (ledger.version !== 1 || !Array.isArray(ledger.files)) {
    return empty;
  }
  const files: Array<LedgerFile> = [];
  for (const item of ledger.files as Array<unknown>) {
    const file = item as Partial<LedgerFile> | null;
    if (
      typeof file === 'object' &&
      file !== null &&
      typeof file.path === 'string' &&
      LEDGER_STATUSES.includes(file.status as LedgerStatus)
    ) {
      files.push({ path: file.path, status: file.status as LedgerStatus });
    }
  }
  const omitted =
    typeof ledger.omitted === 'number' && Number.isSafeInteger(ledger.omitted) && ledger.omitted > 0
      ? ledger.omitted
      : 0;
  return { files, omitted };
}

/**
 * This scan's ledger. A diff scan looked at part of the code, so the base scan's
 * ledger (`base`) carries over for the files it did not touch: this scan's status wins
 * for a path, and a base `backlog` entry is dropped (this scan's backlog is the whole
 * backlog). A full scan passes no base. Findings first, then scanned, then backlog;
 * this scan before the base; whatever does not fit 6 KB is counted in `omitted`.
 */
export function buildSecurityLedgerSummary(
  input: Readonly<{
    scanId: string;
    findingPaths: ReadonlyArray<string>;
    scanned: ReadonlyArray<string>;
    backlog: ReadonlyArray<string>;
    base?: unknown;
  }>,
): Record<string, unknown> {
  const current: Array<LedgerFile> = [];
  const seen = new Set<string>();
  const add = (path: string, status: LedgerStatus) => {
    if (!seen.has(path)) {
      seen.add(path);
      current.push({ path, status });
    }
  };
  input.findingPaths.forEach((path) => add(path, 'finding'));
  input.scanned.forEach((path) => add(path, 'scanned'));
  input.backlog.forEach((path) => add(path, 'backlog'));
  const base = parseSecurityLedgerSummary(input.base ?? null);
  const carried: Array<LedgerFile> = [];
  for (const file of base.files) {
    if (file.status !== 'backlog' && !seen.has(file.path)) {
      seen.add(file.path);
      carried.push(file);
    }
  }
  const files = LEDGER_STATUSES.flatMap((status) =>
    [...current, ...carried].filter((file) => file.status === status),
  );
  const kept: typeof files = [];
  // Room for the wrapper; jsonb::text adds a space after each `:` and `,`.
  let bytes = 120;
  for (const file of files) {
    const size = new TextEncoder().encode(JSON.stringify(file)).length + 6;
    if (bytes + size > SECURITY_LEDGER_MAX_BYTES) {
      break;
    }
    bytes += size;
    kept.push(file);
  }
  return {
    version: 1,
    scan_id: input.scanId,
    files: kept,
    omitted: files.length - kept.length + base.omitted,
  };
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type SecurityIngestEnv = Pick<
  ApiEnv['Bindings'],
  'STATIC_ASSETS_R2' | 'SECURITY_SCAN_SCHEDULER'
>;

export type SecurityIngestResult =
  /** The attempt is fenced off (late, reaped, canceled, another attempt). */
  | Readonly<{ ok: false }>
  /** Back to `queued` for its one retry. */
  | Readonly<{ ok: true; kind: 'retried' }>
  | Readonly<{
      ok: true;
      kind: 'stored';
      status: SecurityRunnerStatus;
      /** Finding ids that count as new for the findings email (spec §9.4). */
      news: ReadonlyArray<string>;
      reopened: ReadonlyArray<string>;
      capped: boolean;
    }>;

export type SecurityIngestOptions = Readonly<{
  now?: number;
  /**
   * Server-side path with no model call: the input builder had no file to send (an
   * empty focus). The scan succeeds with no finding and the base moves. `noChanges`:
   * the diff was empty (edge #14, `status_reason` `no_changes`); otherwise the changed
   * files were all cut to the backlog, which this scan keeps waiting (partial).
   */
  noModelRun?: Readonly<{ noChanges: boolean }>;
}>;

async function readR2Text(r2: R2Bucket, key: string): Promise<string | null> {
  const object = await r2.get(key);
  return object ? object.text() : null;
}

type ScanRow = Readonly<{
  projectId: string;
  deploymentId: string | null;
  trigger: (typeof securityScans.$inferSelect)['trigger'];
  status: string;
  attempt: number;
  leaseUntil: string | null;
  startedAt: string | null;
  modelCalls: number;
  backlogFiles: number;
  coverageNotes: ReadonlyArray<string>;
  baseScanId: string | null;
}>;

/**
 * Takes one attempt's result. `ok: false` only when the attempt is fenced off; a bad
 * result is a `failed (bad_output)` scan, which is still taken.
 */
export async function ingestSecurityScanResult(
  env: SecurityIngestEnv,
  db: Db,
  scanId: string,
  attempt: number,
  report: ScanResultReport,
  options: SecurityIngestOptions = {},
): Promise<SecurityIngestResult> {
  const now = options.now ?? Date.now();
  const noModelRun = options.noModelRun ?? null;
  const status: SecurityParsedStatus = noModelRun
    ? {
        status: 'succeeded',
        reason: null,
        errorClass: null,
        refusalCategory: null,
        engineVersion: null,
      }
    : parseRunnerStatus(report.status, scanId, attempt);

  if (shouldRetrySecurityScan(status, attempt)) {
    if (!(await fenceOk(db, scanId, attempt, now))) {
      return { ok: false };
    }
    if (!(await requeueSecurityScan(db, scanId, attempt))) {
      return { ok: false };
    }
    console.warn('[security-scan] scan attempt failed; retrying once', {
      scanId,
      attempt,
      errorClass: status.errorClass,
    });
    await afterAttempt(env, scanId, attempt);
    return { ok: true, kind: 'retried' };
  }

  const outcome = noModelRun
    ? securityScanOutcome(status, {
        ok: true,
        report: { run_status: 'complete', findings: [], notes: '' },
      })
    : securityScanOutcome(status, parseFindingsReport(report.findings));

  // Files the input builder left for this scan (read before the transaction).
  const [head] = await db
    .select({ projectId: securityScans.project_id })
    .from(securityScans)
    .where(eq(securityScans.id, scanId))
    .limit(1);
  if (!head) {
    return { ok: false };
  }
  const r2 = env.STATIC_ASSETS_R2;
  const scanPrefix = securityRawOutputPrefix(head.projectId, scanId);
  let backlogText: string | null = null;
  let scope: SecurityScanScopeFile | null = null;
  let leads: Array<SecurityServerLead> = [];
  if (outcome.store !== 'none') {
    backlogText = await readR2Text(r2, `${scanPrefix}backlog.json`);
    scope = parseSecurityScanScope(
      await readR2Text(r2, `${scanPrefix}scope.json`),
      parseSecurityBacklog(backlogText),
    );
    if (outcome.store === 'all') {
      leads = parseServerLeads(await readR2Text(r2, `${scanPrefix}server-leads.json`));
    }
  }

  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${head.projectId} FOR UPDATE`);
    const [row] = await tx
      .select({
        projectId: securityScans.project_id,
        deploymentId: securityScans.deployment_id,
        trigger: securityScans.trigger,
        status: securityScans.status,
        attempt: securityScans.attempt,
        leaseUntil: securityScans.lease_until,
        startedAt: securityScans.started_at,
        modelCalls: securityScans.model_calls,
        backlogFiles: securityScans.backlog_files,
        coverageNotes: securityScans.coverage_notes,
        baseScanId: securityScans.base_scan_id,
      })
      .from(securityScans)
      .where(eq(securityScans.id, scanId))
      .for('update')
      .limit(1);
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, head.projectId))
      .limit(1);
    const fence = judgeScanFence(
      row && project ? { ...row, projectStatus: project.status } : undefined,
      attempt,
      now,
    );
    if (!row || !fence.ok) {
      return null;
    }
    return storeOutcome(tx, scanId, row, outcome, status, scope, leads, noModelRun);
  });
  if (stored === null) {
    return { ok: false };
  }

  if (outcome.status === 'succeeded' && backlogText !== null) {
    // The project's backlog becomes what this scan left (spec §7.4). Only now: a
    // failed scan must lose no file. A lost write (or a scan file that is gone) leaves
    // the older, longer backlog.
    const text = backlogText;
    await bestEffort('backlog promote', scanId, async () => {
      await r2.put(`${securityScanProjectPrefix(head.projectId)}backlog.json`, text);
    });
  }
  if (noModelRun === null) {
    await bestEffort('raw output', scanId, async () => {
      await r2.put(`${scanPrefix}status.json`, JSON.stringify(report.status ?? null));
      if (report.findings !== null) {
        await r2.put(`${scanPrefix}findings.json`, report.findings);
      }
    });
  }
  if (
    outcome.status === 'refused' ||
    outcome.status === 'timed_out' ||
    (outcome.status === 'failed' && outcome.reason === 'bad_output')
  ) {
    // Opt-in (M26): one more scan on the `@cf` default, queued before the poke below
    // and before the public gate judges this result, so a held request waits for it.
    await bestEffort('fallback', scanId, async () => {
      const policy = await readSecurityPolicyLenient(db);
      await queueSecurityFallbackScans(env, db, policy, {
        now: Date.now(),
        projectId: head.projectId,
      });
    });
  }
  await afterAttempt(env, scanId, attempt);
  if (stored.news.length > 0) {
    // The alarm sends the findings email; a lost poke is covered by the hourly re-poke.
    await pokeSecurityScanScheduler(env);
  }
  return {
    ok: true,
    kind: 'stored',
    status: outcome.status,
    news: stored.news,
    reopened: stored.reopened,
    capped: stored.capped,
  };
}

async function fenceOk(db: DbOrTx, scanId: string, attempt: number, now: number) {
  return (await checkScanFence(db, scanId, attempt, now)).ok;
}

async function bestEffort(what: string, scanId: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.warn(`[security-scan] ${what} failed`, {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The attempt ended: the call ledger forgets it and the next scan may start. */
async function afterAttempt(env: SecurityIngestEnv, scanId: string, attempt: number) {
  await bestEffort('ledger forget', scanId, async () => {
    const scheduler = env.SECURITY_SCAN_SCHEDULER.get(
      env.SECURITY_SCAN_SCHEDULER.idFromName('global'),
    );
    await scheduler.forgetModelCalls(scanId, attempt);
  });
  await pokeSecurityScanScheduler(env);
}

type StoreResult = Readonly<{
  news: Array<string>;
  reopened: Array<string>;
  capped: boolean;
}>;

async function storeOutcome(
  tx: DbOrTx,
  scanId: string,
  row: ScanRow,
  outcome: SecurityScanOutcome,
  status: SecurityParsedStatus,
  scope: SecurityScanScopeFile | null,
  leads: ReadonlyArray<SecurityServerLead>,
  noModelRun: Readonly<{ noChanges: boolean }> | null,
): Promise<StoreResult> {
  const projectId = row.projectId;
  const result: StoreResult = { news: [], reopened: [], capped: false };
  const hashes = scope?.hashes ?? new Map<string, string>();
  let capped = false;
  let reportedIds = new Set<string>();
  let findingPaths: Array<string> = [];
  const succeeded = outcome.status === 'succeeded';

  if (outcome.store !== 'none' && outcome.report !== null) {
    const records: Array<SecurityIngestRecord> = [];
    for (const lead of outcome.store === 'all' ? leads : []) {
      records.push(recordFromServerLead(projectId, lead, hashes));
    }
    const rejected: Array<FindingRecord> = [];
    for (const record of outcome.report.findings) {
      const stored = recordFromReport(projectId, record, hashes);
      if (stored) {
        records.push(stored);
      } else if (record.verdict === 'rejected') {
        rejected.push(record);
      }
    }
    const confirmedOnly = outcome.store === 'confirmed';
    // Lock every reported key's row first: the cap limits new rows only, so a capped
    // scan still re-sees (and reopens) every finding it reported.
    const existing = await lockFindings(
      tx,
      projectId,
      uniqueStoredRecords(records, { confirmedOnly }).map((record) => record.key),
    );
    const selected = selectStoredRecords(records, {
      confirmedOnly,
      existingKeys: new Set(existing.map((finding) => finding.fingerprint_key)),
    });
    capped = selected.capped;
    const admittedAt = await deploymentAdmittedAt(tx, row.deploymentId);
    const scan: SecurityIngestScan = {
      id: scanId,
      trigger: row.trigger,
      deploymentAdmittedAt: admittedAt,
      startedAt: row.startedAt,
    };
    const written = await upsertFindings(
      tx,
      projectId,
      row.deploymentId,
      scan,
      selected.records,
      existing,
    );
    result.news.push(...written.news);
    result.reopened.push(...written.reopened);
    reportedIds = written.ids;
    findingPaths = selected.records.map((record) => record.file);
    if (succeeded) {
      // Debugging only, never fed to a later scan (spec §10.1).
      await storeRejected(tx, projectId, scanId, rejected);
    }
  }

  if (succeeded && noModelRun === null && scope !== null) {
    await markNotSeen(tx, projectId, scanId, scope, reportedIds);
  }
  if (succeeded && noModelRun === null && !capped && row.backlogFiles === 0 && row.modelCalls > 0) {
    // A capped scan reported more than it stored: it proves no fix.
    await markFixesChecked(tx, projectId, scanId, row.deploymentId, reportedIds);
  }
  // A diff scan (or one with no model run) carries the base's ledger over.
  const baseLedger =
    succeeded && scope?.full !== true && row.baseScanId !== null
      ? await scanLedgerSummary(tx, row.baseScanId)
      : null;

  const notes = [...row.coverageNotes];
  if (capped && !notes.includes(SECURITY_FINDINGS_CAPPED_NOTE)) {
    notes.push(SECURITY_FINDINGS_CAPPED_NOTE);
  }
  const backlog = scope ? [...scope.unread] : [];
  await tx
    .update(securityScans)
    .set({
      status: outcome.status,
      status_reason: noModelRun?.noChanges ? 'no_changes' : outcome.reason,
      error_class: outcome.errorClass,
      failure_cause: outcome.failureCause,
      refusal_category: outcome.refusalCategory,
      engine_version: status.engineVersion ?? sql`${securityScans.engine_version}`,
      coverage_notes: notes,
      ledger_summary: succeeded
        ? buildSecurityLedgerSummary({
            scanId,
            findingPaths,
            scanned: scope ? [...scope.paths] : [],
            backlog,
            base: baseLedger,
          })
        : sql`${securityScans.ledger_summary}`,
      finished_at: sql`now()`,
    })
    .where(eq(securityScans.id, scanId));
  await releaseSecurityScanReserveIn(tx, scanId);
  if (result.news.length > 0) {
    // One findings email per scan; the outbox row commits with the findings (M15).
    await enqueueSecurityNotification(tx, { kind: 'findings', projectId, scanId });
  }
  return { ...result, capped };
}

async function scanLedgerSummary(tx: DbOrTx, scanId: string): Promise<unknown> {
  const [row] = await tx
    .select({ ledger: securityScans.ledger_summary })
    .from(securityScans)
    .where(eq(securityScans.id, scanId))
    .limit(1);
  return row?.ledger ?? null;
}

/** The head deployment's admission time as an ISO instant (the column has no zone). */
async function deploymentAdmittedAt(
  tx: DbOrTx,
  deploymentId: string | null,
): Promise<string | null> {
  if (deploymentId === null) {
    return null;
  }
  const [row] = await tx
    .select({
      at: sql<string>`to_char(${deployments.created_at} AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  return row?.at ?? null;
}

type Written = Readonly<{
  ids: Set<string>;
  news: Array<string>;
  reopened: Array<string>;
}>;

async function upsertFindings(
  tx: DbOrTx,
  projectId: string,
  deploymentId: string | null,
  scan: SecurityIngestScan,
  records: ReadonlyArray<SecurityIngestRecord>,
  existing: ReadonlyArray<typeof securityFindings.$inferSelect>,
): Promise<Written> {
  const written: Written = { ids: new Set(), news: [], reopened: [] };
  if (records.length === 0) {
    return written;
  }
  const byKey = new Map(existing.map((finding) => [finding.fingerprint_key, finding]));
  const seenSince = await seenSinceResolve(
    tx,
    existing.filter((finding) => finding.state === 'resolved').map((finding) => finding.id),
  );

  const events: Array<typeof securityFindingEvents.$inferInsert> = [];
  const fresh = records.filter((record) => !byKey.has(record.key));
  for (const record of records) {
    const finding = byKey.get(record.key);
    if (!finding) {
      continue;
    }
    written.ids.add(finding.id);
    const stored: SecurityStoredFinding = {
      id: finding.id,
      number: finding.number,
      verdict: finding.verdict,
      severity: finding.severity,
      state: finding.state,
      resolution: finding.resolution,
      resolvedAt: finding.resolved_at,
      resolvedSinkHash: finding.resolved_sink_hash,
      resolvedSeverity: finding.resolved_severity,
      notSeenInLatest: finding.not_seen_in_latest,
      seenSinceResolve: seenSince.has(finding.id),
    };
    const decision = decideSeenFinding(stored, record, scan);
    await tx
      .update(securityFindings)
      .set(patchColumns(decision.patch, decision.events.some(changesRevision)))
      .where(eq(securityFindings.id, finding.id));
    for (const action of decision.events) {
      events.push(scannerEvent(finding.id, projectId, scan.id, action));
    }
    if (decision.news) {
      written.news.push(finding.id);
    }
    if (decision.reopened) {
      written.reopened.push(finding.id);
    }
  }

  if (fresh.length > 0) {
    const first = await takeFindingNumbers(tx, projectId, fresh.length);
    const duplicates = await resolvedByFileAndCategory(tx, projectId);
    const rows = fresh.map((record, index) => {
      const id = generateId('sf');
      written.ids.add(id);
      if (isNewRecord(record)) {
        written.news.push(id);
      }
      events.push(scannerEvent(id, projectId, scan.id, 'created'));
      return {
        id,
        project_id: projectId,
        number: first + index,
        fingerprint_key: record.key,
        model_fingerprint: record.fingerprint,
        verdict: record.verdict,
        severity: record.severity,
        confidence: record.confidence,
        title: record.title,
        category: record.category,
        cwe: record.cwe,
        file: record.file,
        line_start: record.lineStart,
        line_end: record.lineEnd,
        detail: record.detail,
        sink_path: record.sinkPath,
        sink_content_hash: record.sinkHash,
        outside_diff: record.outsideDiff,
        source: record.source,
        possible_duplicate_of: duplicates.get(`${record.file}\u0000${record.category}`) ?? null,
        first_scan_id: scan.id,
        last_seen_scan_id: scan.id,
        first_deployment_id: deploymentId,
      } satisfies typeof securityFindings.$inferInsert;
    });
    await tx.insert(securityFindings).values(rows);
  }
  if (events.length > 0) {
    await tx.insert(securityFindingEvents).values(events);
  }
  return written;
}

/**
 * Locks the project's findings with these keys. In id order: every transaction that
 * locks several finding rows (bulk resolve too) takes them in the same order, so two
 * of them never deadlock.
 */
async function lockFindings(
  tx: DbOrTx,
  projectId: string,
  keys: ReadonlyArray<string>,
): Promise<Array<typeof securityFindings.$inferSelect>> {
  if (keys.length === 0) {
    return [];
  }
  return tx
    .select()
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, projectId),
        inArray(securityFindings.fingerprint_key, [...keys]),
      ),
    )
    .orderBy(securityFindings.id)
    .for('update');
}

/**
 * The finding's `revision` (the resolve / reopen check, spec §9.2) moves when its state,
 * verdict or severity does; a re-see or the not-seen hint never makes a resolve in flight
 * answer 409.
 */
function changesRevision(action: SecurityFindingEventAction): boolean {
  return action === 'reopened' || action === 'promoted' || action === 'severity_changed';
}

function patchColumns(
  patch: SecurityFindingPatch,
  changed: boolean,
): Partial<typeof securityFindings.$inferInsert> & Record<string, unknown> {
  const set: Record<string, unknown> = {
    last_seen_scan_id: patch.lastSeenScanId,
    sink_content_hash: patch.sinkContentHash,
    not_seen_in_latest: false,
    updated_at: sql`now()`,
  };
  if (patch.verdict !== undefined) {
    set.verdict = patch.verdict;
  }
  if (patch.severity !== undefined) {
    set.severity = patch.severity;
  }
  if (patch.details !== undefined) {
    const record = patch.details;
    Object.assign(set, {
      severity: patch.severity ?? record.severity,
      confidence: record.confidence,
      title: record.title,
      category: record.category,
      cwe: record.cwe,
      file: record.file,
      line_start: record.lineStart,
      line_end: record.lineEnd,
      detail: record.detail,
      sink_path: record.sinkPath,
      outside_diff: record.outsideDiff,
    });
  }
  if (patch.reopen) {
    Object.assign(set, {
      state: 'open',
      resolution: null,
      resolved_by_user_id: null,
      resolved_at: null,
      resolved_sink_hash: null,
      resolved_severity: null,
      fix_checked_scan_id: null,
      reopen_count: sql`${securityFindings.reopen_count} + 1`,
    });
  }
  if (changed) {
    set.revision = sql`${securityFindings.revision} + 1`;
  }
  return set;
}

function scannerEvent(
  findingId: string,
  projectId: string,
  scanId: string,
  action: SecurityFindingEventAction,
): typeof securityFindingEvents.$inferInsert {
  return {
    id: generateId('sfe'),
    finding_id: findingId,
    project_id: projectId,
    scan_id: scanId,
    actor_kind: 'scanner',
    action,
  };
}

/** Resolved findings that already had their one `seen_again` since the last resolve. */
async function seenSinceResolve(tx: DbOrTx, ids: ReadonlyArray<string>): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await tx
    .select({ id: securityFindingEvents.finding_id })
    .from(securityFindingEvents)
    .innerJoin(securityFindings, eq(securityFindings.id, securityFindingEvents.finding_id))
    .where(
      and(
        inArray(securityFindingEvents.finding_id, [...ids]),
        inArray(securityFindingEvents.action, ['seen_again', 'seen_again_stale']),
        sql`${securityFindingEvents.created_at} >= ${securityFindings.resolved_at}`,
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** Takes `count` F-numbers under the project lock; returns the first. */
async function takeFindingNumbers(tx: DbOrTx, projectId: string, count: number): Promise<number> {
  const [row] = await tx
    .insert(projectSecuritySettings)
    .values({ project_id: projectId, next_finding_number: 1 + count })
    .onConflictDoUpdate({
      target: projectSecuritySettings.project_id,
      set: {
        next_finding_number: sql`${projectSecuritySettings.next_finding_number} + ${count}`,
      },
    })
    .returning({ next: projectSecuritySettings.next_finding_number });
  return row!.next - count;
}

/** `file \0 category` → the newest resolved finding with them (possible duplicate, §9.4). */
async function resolvedByFileAndCategory(
  tx: DbOrTx,
  projectId: string,
): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      id: securityFindings.id,
      file: securityFindings.file,
      category: securityFindings.category,
    })
    .from(securityFindings)
    .where(and(eq(securityFindings.project_id, projectId), eq(securityFindings.state, 'resolved')))
    .orderBy(desc(securityFindings.resolved_at));
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.file === null) {
      continue;
    }
    const key = `${row.file}\u0000${row.category}`;
    if (!out.has(key)) {
      out.set(key, row.id);
    }
  }
  return out;
}

async function storeRejected(
  tx: DbOrTx,
  projectId: string,
  scanId: string,
  rejected: ReadonlyArray<FindingRecord>,
): Promise<void> {
  const byKey = new Map<string, string>();
  for (const record of rejected) {
    if (byKey.size >= SECURITY_MAX_REJECTED_PER_SCAN) {
      break;
    }
    const key = securityFingerprintKey(
      projectId,
      record.fingerprint,
      record.sink_path ?? record.file,
    );
    byKey.set(key, cutUtf8(record.reason, SECURITY_REJECTED_REASON_MAX_BYTES));
  }
  if (byKey.size === 0) {
    return;
  }
  await tx
    .insert(securityMemoryRejected)
    .values(
      [...byKey].map(([key, reason]) => ({
        project_id: projectId,
        fingerprint_key: key,
        reason,
        scan_id: scanId,
      })),
    )
    .onConflictDoUpdate({
      target: [securityMemoryRejected.project_id, securityMemoryRejected.fingerprint_key],
      set: {
        reason: sql`excluded.reason`,
        scan_id: sql`excluded.scan_id`,
        created_at: sql`now()`,
      },
    });
  // Newest 200 per project.
  await tx.execute(sql`
    DELETE FROM security_memory_rejected
    WHERE project_id = ${projectId}
      AND fingerprint_key NOT IN (
        SELECT fingerprint_key FROM security_memory_rejected
        WHERE project_id = ${projectId}
        ORDER BY created_at DESC, fingerprint_key
        LIMIT ${SECURITY_REJECTED_KEPT_PER_PROJECT}
      )`);
}

/** Open findings this succeeded scan looked at but did not report: the hint (§9.1). */
async function markNotSeen(
  tx: DbOrTx,
  projectId: string,
  scanId: string,
  scope: SecurityScanScope,
  reported: ReadonlySet<string>,
): Promise<void> {
  const open = await tx
    .select({
      id: securityFindings.id,
      file: securityFindings.file,
      sinkPath: securityFindings.sink_path,
    })
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, projectId),
        eq(securityFindings.state, 'open'),
        eq(securityFindings.not_seen_in_latest, false),
        reported.size > 0 ? notInArray(securityFindings.id, [...reported]) : undefined,
      ),
    );
  const ids = open.filter((finding) => notSeenNow(finding, scope)).map((finding) => finding.id);
  if (ids.length === 0) {
    return;
  }
  await tx
    .update(securityFindings)
    .set({ not_seen_in_latest: true, updated_at: sql`now()` })
    .where(inArray(securityFindings.id, ids));
  await tx
    .insert(securityFindingEvents)
    .values(ids.map((id) => scannerEvent(id, projectId, scanId, 'not_seen')));
}

/**
 * `fix_checked_scan_id` (spec §14): the first succeeded, uncapped scan with no backlog
 * and with model calls, of a deployment admitted after the latest `fixed` resolve, that
 * does not report the finding again. A reported one was reopened above; `reported`
 * keeps it out all the same.
 */
async function markFixesChecked(
  tx: DbOrTx,
  projectId: string,
  scanId: string,
  deploymentId: string | null,
  reported: ReadonlySet<string>,
): Promise<void> {
  if (deploymentId === null) {
    return;
  }
  await tx
    .update(securityFindings)
    .set({ fix_checked_scan_id: scanId, updated_at: sql`now()` })
    .where(
      and(
        eq(securityFindings.project_id, projectId),
        eq(securityFindings.state, 'resolved'),
        eq(securityFindings.resolution, 'fixed'),
        isNull(securityFindings.fix_checked_scan_id),
        reported.size > 0 ? notInArray(securityFindings.id, [...reported]) : undefined,
        lt(
          securityFindings.resolved_at,
          sql`(SELECT ${deployments.created_at} AT TIME ZONE current_setting('TimeZone') FROM ${deployments} WHERE ${deployments.id} = ${deploymentId})`,
        ),
      ),
    );
}
