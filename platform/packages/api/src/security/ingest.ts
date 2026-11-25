/**
 * Result ingest (spec §8.4, §9, §11.4). `status.json` and `findings.json` come from the
 * container and are untrusted. One transaction, project row locked, scan row fenced:
 * succeeded stores all records and server leads (50 + 50 cap on new keys), incomplete
 * only validated confirmed ones, others none. After commit: promote the backlog, raw
 * output to R2, forget the call ledger, poke the scheduler.
 */
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import {
  FINDINGS_SCHEMA_VERSION,
  REPORT_LIMITS,
} from '../../../security-scanner/src/runner/report.ts';
import type { FindingRecord, ScanReport } from '../../../security-scanner/src/runner/report.ts';
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
import {
  pokeSecurityScanScheduler,
  securityBestEffort as bestEffort,
  securityScanProjectPrefix,
  securityScheduler,
} from './enqueue.ts';
import { queueSecurityFallbackScans } from './fallback.ts';
import { checkScanFence, judgeScanFence } from './fence.ts';
import {
  cutUtf8,
  decideSeenFinding,
  isNewRecord,
  notSeenNow,
  recordFromReport,
  SECURITY_DETAIL_MAX_BYTES,
  SECURITY_FINDINGS_CAPPED_NOTE,
  SECURITY_MAX_REJECTED_PER_SCAN,
  SECURITY_REJECTED_KEPT_PER_PROJECT,
  SECURITY_REJECTED_REASON_MAX_BYTES,
  securityFingerprintKey,
  selectStoredRecords,
  severityRank,
  uniqueStoredRecords,
} from './findings.ts';
import type {
  SecurityFindingPatch,
  SecurityIngestRecord,
  SecurityIngestScan,
  SecurityScanScope,
  SecurityStoredFinding,
} from './findings.ts';
import { parseSecurityBacklog } from './input/backlog.ts';
import type { SecurityServerLead } from './input/phrase-check.ts';
import { SECURITY_SECRET_FORMS } from './input/redact.ts';
import type { SecuritySecretForm } from './input/redact.ts';
import { compareText } from './input/t2.ts';
import {
  deleteSecurityLocalTree,
  SECURITY_LOCAL_RESULT_MAX_FINDINGS,
  securityLocalResultKey,
} from './local-check.ts';
import type { SecurityLocalCheckFinding, SecurityLocalCheckResult } from './local-check.ts';
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
} from './schema.ts';
import type { SecurityFindingEventAction } from './schema.ts';

// --- status.json ---

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

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A non-empty string of at most `max` letters, digits and `extra` characters. */
function inCharset(value: unknown, max: number, extra: string): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((char) => ALNUM.includes(char) || extra.includes(char))
  );
}

function securityLabel(value: unknown, max = 80): string | null {
  return inCharset(value, max, '._:/ @-+') ? value : null;
}

/** Reads `status.json`; another scan or attempt, or a wrong status/reason pair, is bad output. */
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
  if (!STATUS_REASONS[typed].includes(reason as string | null)) {
    return BAD_STATUS('status_unreadable');
  }
  const label = reason as string | null;
  return {
    status: typed,
    reason: label,
    errorClass: securityLabel(object.error_class),
    refusalCategory: typed === 'refused' ? securityLabel(object.refusal_category) : null,
    engineVersion: securityLabel(object.engine_version, 120),
  };
}

// --- findings.json ---

export type SecurityParsedFindings =
  | Readonly<{ ok: true; report: ScanReport }>
  | Readonly<{ ok: false; kind: string }>;

/** The runner's own check of the model's report (`validate-findings.ts`), run again. */
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

// --- Outcome (spec §8.4, §11.4) ---

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
    failureCause: 'project' as const,
    store: 'none' as const,
    report: null,
  };
  const report = findings.ok ? findings.report : null;
  switch (status.status) {
    case 'succeeded':
      if (!findings.ok) {
        return { ...base, status: 'failed', reason: 'bad_output', errorClass: findings.kind };
      }
      return findings.report.run_status === 'incomplete'
        ? { ...base, status: 'incomplete', reason: 'run_incomplete', store: 'confirmed', report }
        : { ...base, status: 'succeeded', failureCause: null, store: 'all', report };
    case 'incomplete':
      return { ...base, status: 'incomplete', store: report ? 'confirmed' : 'none', report };
    case 'failed': {
      const installation = status.reason === 'infrastructure' || status.reason === 'credits';
      return { ...base, status: 'failed', failureCause: installation ? 'installation' : 'project' };
    }
    case 'refused':
    case 'timed_out':
      return { ...base, status: status.status };
  }
}

// --- Per-scan files written at input time (`input/prepare.ts`) ---

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
  const { full, paths, hashes } = input;
  return JSON.stringify({ version: 1, full, paths, hashes: Object.fromEntries(hashes) });
}

/** A `{ version: 1, ... }` object, else `null`. */
function versionOne(value: unknown): Record<string, unknown> | null {
  const object =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  return object?.version === 1 ? object : null;
}

export function parseVersionOne(text: string | null): Record<string, unknown> | null {
  try {
    return text === null ? null : versionOne(JSON.parse(text));
  } catch {
    return null;
  }
}

function positive(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

function parseSecurityScanScope(
  text: string | null,
  backlog: ReadonlyArray<string>,
): SecurityScanScopeFile | null {
  const value = parseVersionOne(text);
  if (value === null || typeof value.full !== 'boolean') {
    return null;
  }
  const hashes = new Map<string, string>();
  const stored = typeof value.hashes === 'object' && value.hashes !== null ? value.hashes : {};
  for (const [path, hash] of Object.entries(stored)) {
    if (typeof hash === 'string') {
      hashes.set(path, hash);
    }
  }
  const paths = Array.isArray(value.paths) ? value.paths : [];
  return {
    full: value.full,
    paths: new Set(paths.filter((item): item is string => typeof item === 'string')),
    unread: new Set(backlog),
    hashes,
  };
}

function parseServerLead(value: unknown): SecurityServerLead | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const lead = value as Record<string, unknown>;
  if (typeof lead.file !== 'string' || relativePathProblem(lead.file) !== null) {
    return null;
  }
  if (lead.kind === 'reviewer_text' && Array.isArray(lead.hits)) {
    return lead as SecurityServerLead;
  }
  if (lead.kind === 'secret_in_output' && inCharset(lead.secret, 256, '_')) {
    const forms = Array.isArray(lead.forms)
      ? SECURITY_SECRET_FORMS.filter((form) => (lead.forms as Array<unknown>).includes(form))
      : [];
    const alsoIn = Array.isArray(lead.alsoIn)
      ? lead.alsoIn
          .filter(
            (path): path is string =>
              typeof path === 'string' && relativePathProblem(path) === null,
          )
          .slice(0, 10)
      : [];
    const files = Math.max(1, positive(lead.files));
    return {
      kind: 'secret_in_output',
      file: lead.file,
      secret: lead.secret,
      forms,
      line: positive(lead.line),
      client: lead.client === true,
      ...(files > 1 ? { alsoIn, files: Math.max(files, 1 + alsoIn.length) } : {}),
    };
  }
  return null;
}

function parseServerLeads(text: string | null): Array<SecurityServerLead> {
  const leads = parseVersionOne(text)?.leads;
  return Array.isArray(leads) ? leads.flatMap((lead: unknown) => parseServerLead(lead) ?? []) : [];
}

/**
 * A server lead as a stored record: reviewer-aimed text (§10.3) is a lead; a stored secret
 * value in the output (M31) is a confirmed finding keyed by the secret and the side, not
 * the hashed file name. No value is ever stored. `isPublic` only changes the wording.
 */
export function recordFromServerLead(
  projectId: string,
  lead: SecurityServerLead,
  hashes: ReadonlyMap<string, string>,
  options: Readonly<{ isPublic?: boolean | null; local?: boolean }> = {},
): SecurityIngestRecord {
  if (lead.kind === 'secret_in_output') {
    return recordFromSecretLead(projectId, lead, options.isPublic ?? null, options.local === true);
  }
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

/** The category of a server-made secret finding (M31). */
export const SECURITY_SECRET_IN_OUTPUT_CATEGORY = 'secret-in-output';

const SECRET_FORM_WORDS: Readonly<Record<SecuritySecretForm, string>> = {
  raw: 'as is',
  json: 'JSON-escaped',
  base64: 'base64',
  url: 'URL-encoded',
};

function recordFromSecretLead(
  projectId: string,
  lead: Extract<SecurityServerLead, { kind: 'secret_in_output' }>,
  isPublic: boolean | null,
  /** A local check (M32): the code is a working tree, not deployed yet. */
  local = false,
): SecurityIngestRecord {
  const fingerprint = `server:secret_in_output:${lead.secret}`;
  const line = lead.line > 0 ? lead.line : null;
  const forms = lead.forms.map((form) => SECRET_FORM_WORDS[form]);
  const where = `${lead.file}${line === null ? '' : `, line ${line}`}`;
  const alsoIn = lead.alsoIn ?? [];
  const files = lead.files ?? 1;
  const more =
    files > 1
      ? ` It is in ${files - 1} more ${files === 2 ? 'file' : 'files'}${alsoIn.length > 0 ? `, such as ${alsoIn.join(', ')}` : ''}.`
      : '';
  const title = local
    ? `Secret ${lead.secret} is written into your code (not deployed yet): ${lead.file}`
    : lead.client
      ? isPublic === true
        ? `Secret ${lead.secret} is in a public file: ${lead.file}`
        : `Secret ${lead.secret} is in a static asset: ${lead.file}`
      : `Secret ${lead.secret} is written into the deployed code: ${lead.file}`;
  const of = local
    ? 'of your code (not deployed yet)'
    : `of the deployed ${lead.client ? 'static assets' : 'Worker'}`;
  const fix = lead.client
    ? `${isPublic === true ? 'Anyone can download this file' : 'Static assets are public once the project is public'}, so treat ${lead.secret} as leaked: rotate it, and keep it on the server (read it from env in a server route). Stop the build from writing it into client code.`
    : `Read ${lead.secret} from env at run time instead of writing its value into the code or the build. If the code was shared, rotate it.`;
  const side = lead.client ? 'client' : 'worker';
  return {
    key: securityFingerprintKey(projectId, fingerprint, side, 'server'),
    fingerprint,
    verdict: 'confirmed',
    severity: lead.client ? 'high' : 'medium',
    confidence: 'high',
    title: title.slice(0, REPORT_LIMITS.title),
    category: SECURITY_SECRET_IN_OUTPUT_CATEGORY,
    cwe: lead.client ? 'CWE-200' : 'CWE-798',
    file: lead.file,
    lineStart: line,
    lineEnd: line,
    sinkPath: lead.file,
    // A bundle's hash changes every build; the finding is about the value.
    sinkHash: null,
    outsideDiff: false,
    detail: {
      secret: lead.secret,
      forms: [...lead.forms],
      client: lead.client,
      ...(files > 1 ? { files, also_in: [...alsoIn] } : {}),
      evidence: `The stored value of project secret ${lead.secret} (${forms.join(', ') || 'as is'}) is in ${where} ${of}.${more} The platform found it before the scan; the value is not stored with this finding.`,
      fix,
    },
    source: 'server',
    moves: true,
  };
}

// --- Local check result (M32) ---

/**
 * What a local check found, for the CLI (`local-result.{attempt}.json`): the records a
 * deployment scan would store, confirmed first, by severity. Never a project finding.
 */
export function securityLocalCheckResult(
  projectId: string,
  outcome: SecurityScanOutcome,
  leads: ReadonlyArray<SecurityServerLead>,
): SecurityLocalCheckResult {
  if (outcome.store === 'none' || outcome.report === null) {
    return { version: 1, findings: [], total: 0, capped: false };
  }
  const hashes = new Map<string, string>();
  const records = [
    ...leads.map((lead) => recordFromServerLead(projectId, lead, hashes, { local: true })),
    ...outcome.report.findings.flatMap(
      (record) => recordFromReport(projectId, record, hashes) ?? [],
    ),
  ];
  const unique = uniqueStoredRecords(records, { confirmedOnly: outcome.store === 'confirmed' });
  unique.sort(
    (a, b) =>
      Number(b.verdict === 'confirmed') - Number(a.verdict === 'confirmed') ||
      severityRank(b.severity) - severityRank(a.severity) ||
      compareText(a.file, b.file) ||
      (a.lineStart ?? 0) - (b.lineStart ?? 0),
  );
  const findings = unique
    .slice(0, SECURITY_LOCAL_RESULT_MAX_FINDINGS)
    .map((record): SecurityLocalCheckFinding => ({
      verdict: record.verdict,
      severity: record.severity,
      confidence: record.confidence,
      title: record.title,
      category: record.category,
      cwe: record.cwe,
      file: record.file,
      lineStart: record.lineStart,
      lineEnd: record.lineEnd,
      source: record.source,
      verdictSource: record.verdictSource ?? 'static',
      detail: record.detail,
    }));
  return { version: 1, findings, total: unique.length, capped: unique.length > findings.length };
}

/** The server-built coverage ledger summary (spec §10.1 item 6): paths + status only. */
export const SECURITY_LEDGER_MAX_BYTES = 6 * 1024;

type LedgerStatus = 'finding' | 'scanned' | 'backlog';
type LedgerFile = { path: string; status: LedgerStatus };
const LEDGER_STATUSES: ReadonlyArray<LedgerStatus> = ['finding', 'scanned', 'backlog'];

type LedgerFiles = Readonly<{ files: Array<LedgerFile>; omitted: number }>;

/** The files of a stored ledger summary; empty when it is missing or not ours. */
function parseSecurityLedgerSummary(value: unknown): LedgerFiles {
  const ledger = versionOne(value);
  if (!ledger || !Array.isArray(ledger.files)) {
    return { files: [], omitted: 0 };
  }
  const files = ledger.files.flatMap((item: unknown) => {
    const file = item as Partial<LedgerFile> | null;
    return typeof file?.path === 'string' && LEDGER_STATUSES.includes(file.status as LedgerStatus)
      ? [{ path: file.path, status: file.status as LedgerStatus }]
      : [];
  });
  return { files, omitted: positive(ledger.omitted) };
}

/** The stored `coverage_ledger` JSON. */
type SecurityLedgerSummary = {
  version: 1;
  scan_id: string;
  files: Array<LedgerFile>;
  omitted: number;
};

/**
 * This scan's ledger. A diff scan carries the base ledger over for files it did not touch
 * (base `backlog` entries dropped). Findings, scanned, backlog; what does not fit 6 KB is
 * counted in `omitted`.
 */
export function buildSecurityLedgerSummary(
  input: Readonly<{
    scanId: string;
    findingPaths: ReadonlyArray<string>;
    scanned: ReadonlyArray<string>;
    backlog: ReadonlyArray<string>;
    base?: unknown;
  }>,
): SecurityLedgerSummary {
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

// --- Ingest ---

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
  /** No model call (an empty focus): succeeds with no finding. `noChanges`: empty diff (edge #14). */
  noModelRun?: Readonly<{ noChanges: boolean }>;
}>;

async function readR2Text(r2: R2Bucket, key: string): Promise<string | null> {
  const object = await r2.get(key);
  return object ? object.text() : null;
}

type ScanRow = typeof securityScans.$inferSelect;

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

  // A container or controller failure gets one more attempt (spec §6.2).
  if (
    status.status === 'failed' &&
    status.reason === 'infrastructure' &&
    attempt < SECURITY_SCAN_MAX_ATTEMPTS
  ) {
    if (
      !(await checkScanFence(db, scanId, attempt, now)).ok ||
      !(await requeueSecurityScan(db, scanId, attempt))
    ) {
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
    .select({ projectId: securityScans.project_id, trigger: securityScans.trigger })
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
    leads = parseServerLeads(await readR2Text(r2, `${scanPrefix}server-leads.json`));
  }
  if (head.trigger === 'local') {
    // Written before the row ends, so an ended check has one; not best effort (retried).
    await r2.put(
      securityLocalResultKey(head.projectId, scanId, attempt),
      JSON.stringify(securityLocalCheckResult(head.projectId, outcome, leads)),
    );
  }

  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${head.projectId} FOR UPDATE`);
    const [row] = await tx
      .select()
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
      row && project
        ? { ...row, leaseUntil: row.lease_until, projectStatus: project.status }
        : undefined,
      attempt,
      now,
    );
    if (!row || !fence.ok) {
      return null;
    }
    if (row.trigger === 'local') {
      return storeLocalOutcome(tx, scanId, outcome, status);
    }
    return storeOutcome(tx, scanId, row, outcome, status, scope, leads, noModelRun);
  });
  if (stored === null) {
    return { ok: false };
  }

  if (stored.local) {
    // The check is over: its uploaded tree goes (the hourly sweep retries).
    await bestEffort('local tree delete', scanId, () =>
      deleteSecurityLocalTree(db, r2, head.projectId, scanId),
    );
  }
  if (!stored.local && outcome.status === 'succeeded' && backlogText !== null) {
    // Only a succeeded scan moves the backlog (spec §7.4); a lost write keeps the longer one.
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
    !stored.local &&
    (outcome.status === 'refused' ||
      outcome.status === 'timed_out' ||
      (outcome.status === 'failed' && outcome.reason === 'bad_output'))
  ) {
    // Opt-in (M26): queued before the poke and the public gate re-check, so a held request waits.
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

/** The attempt ended: the call ledger forgets it and the next scan may start. */
async function afterAttempt(env: SecurityIngestEnv, scanId: string, attempt: number) {
  await bestEffort('ledger forget', scanId, () =>
    securityScheduler(env).forgetModelCalls(scanId, attempt),
  );
  await pokeSecurityScanScheduler(env);
}

type StoreResult = Readonly<{
  news: Array<string>;
  reopened: Array<string>;
  capped: boolean;
  /** A local check (M32): its result was written before the transaction. */
  local?: true;
}>;

function endColumns(outcome: SecurityScanOutcome, status: SecurityParsedStatus) {
  return {
    status: outcome.status,
    status_reason: outcome.reason,
    error_class: outcome.errorClass,
    failure_cause: outcome.failureCause,
    refusal_category: outcome.refusalCategory,
    engine_version: status.engineVersion ?? sql`${securityScans.engine_version}`,
    finished_at: sql`now()`,
  };
}

/** A local check (I12, R13): the row ends, but no finding, event, ledger, email or base moves. */
async function storeLocalOutcome(
  tx: DbOrTx,
  scanId: string,
  outcome: SecurityScanOutcome,
  status: SecurityParsedStatus,
): Promise<StoreResult> {
  await tx
    .update(securityScans)
    .set(endColumns(outcome, status))
    .where(eq(securityScans.id, scanId));
  await releaseSecurityScanReserveIn(tx, scanId);
  return { news: [], reopened: [], capped: false, local: true };
}

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
  const projectId = row.project_id;
  const result: StoreResult = { news: [], reopened: [], capped: false };
  const hashes = scope?.hashes ?? new Map<string, string>();
  let capped = false;
  let reportedIds = new Set<string>();
  let findingPaths: Array<string> = [];
  const succeeded = outcome.status === 'succeeded';

  if (outcome.store !== 'none' && outcome.report !== null) {
    const records = leads.map((lead) =>
      recordFromServerLead(projectId, lead, hashes, { isPublic: row.public_at_enqueue }),
    );
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
    // Lock every reported key first: the cap limits new rows only.
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
    const scan: SecurityIngestScan = {
      id: scanId,
      trigger: row.trigger,
      deploymentAdmittedAt: await deploymentAdmittedAt(tx, row.deployment_id),
      startedAt: row.started_at,
    };
    const written = await upsertFindings(
      tx,
      projectId,
      row.deployment_id,
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
  if (
    succeeded &&
    noModelRun === null &&
    !capped &&
    row.backlog_files === 0 &&
    row.model_calls > 0
  ) {
    // A capped scan reported more than it stored: it proves no fix.
    await markFixesChecked(tx, projectId, scanId, row.deployment_id, reportedIds);
  }
  // A diff scan (or one with no model run) carries the base's ledger over.
  const [baseRow] =
    succeeded && scope?.full !== true && row.base_scan_id !== null
      ? await tx
          .select({ ledger: securityScans.ledger_summary })
          .from(securityScans)
          .where(eq(securityScans.id, row.base_scan_id))
          .limit(1)
      : [];
  const baseLedger = baseRow?.ledger ?? null;

  const notes = [...row.coverage_notes];
  if (capped && !notes.includes(SECURITY_FINDINGS_CAPPED_NOTE)) {
    notes.push(SECURITY_FINDINGS_CAPPED_NOTE);
  }
  const backlog = scope ? [...scope.unread] : [];
  await tx
    .update(securityScans)
    .set({
      ...endColumns(outcome, status),
      status_reason: noModelRun?.noChanges ? 'no_changes' : outcome.reason,
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
    })
    .where(eq(securityScans.id, scanId));
  await releaseSecurityScanReserveIn(tx, scanId);
  // One findings email per scan, committed with the findings; none once the policy is Off.
  if (result.news.length > 0 && (await readSecurityPolicyLenient(tx)).mode !== 'disabled') {
    await enqueueSecurityNotification(tx, { kind: 'findings', projectId, scanId });
  }
  return { ...result, capped };
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
    existing.flatMap((finding) => (finding.state === 'resolved' ? [finding.id] : [])),
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
      verdictSource: finding.verdict_source,
      severityOverride: finding.severity_override,
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
        verdict_source: record.verdictSource ?? 'static',
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

/** Locks the project's findings with these keys, in id order (as bulk resolve does) so none deadlock. */
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

/** `revision` (spec §9.2) moves with state, verdict or severity, never with a re-see. */
function changesRevision(action: SecurityFindingEventAction): boolean {
  return action === 'reopened' || action === 'promoted' || action === 'severity_changed';
}

interface SecurityFindingColumns {
  [column: string]: unknown;
}

function patchColumns(
  patch: SecurityFindingPatch,
  changed: boolean,
): Partial<typeof securityFindings.$inferInsert> & SecurityFindingColumns {
  const set: SecurityFindingColumns = {
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
  if (patch.verdictSource !== undefined) {
    set.verdict_source = patch.verdictSource;
  }
  if (patch.runtimeProof !== undefined && patch.details === undefined) {
    // The proof joins the stored detail; a detail already at its 32 KB limit stays as is.
    const merged = sql`jsonb_set(${securityFindings.detail}, '{runtime_proof}', ${JSON.stringify(patch.runtimeProof)}::jsonb, true)`;
    set.detail = sql`CASE WHEN octet_length((${merged})::text) <= ${SECURITY_DETAIL_MAX_BYTES} THEN ${merged} ELSE ${securityFindings.detail} END`;
  }
  const place = patch.details ?? patch.location;
  if (place !== undefined) {
    Object.assign(set, {
      title: place.title,
      file: place.file,
      line_start: place.lineStart,
      line_end: place.lineEnd,
      detail: place.detail,
      sink_path: place.sinkPath,
    });
  }
  if (patch.details !== undefined) {
    const record = patch.details;
    Object.assign(set, {
      severity: patch.severity ?? record.severity,
      confidence: record.confidence,
      category: record.category,
      cwe: record.cwe,
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
  return row.next - count;
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
 * `fix_checked_scan_id` (spec §14): the first full-coverage scan of a deployment admitted
 * after the `fixed` resolve that does not report the finding again.
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
