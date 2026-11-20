/**
 * Finding rules applied at ingest (spec §9). Pure: the ingest transaction reads the
 * rows, these functions decide, and the transaction writes what they return.
 *
 *   report record ─► fingerprint key (source + project + skill fingerprint + sink path)
 *        │
 *        ├─ no row ───────────────► created (F-n), possible duplicate hint
 *        ├─ open row ─────────────► last seen; lead → confirmed = promoted;
 *        │                          severity only rises (a scan never downgrades);
 *        │                          a human severity (M35) stays: the scan value is kept
 *        │                          under it, with no event and no "new"
 *        └─ resolved row ─ stale scan ─────────────► seen_again_stale (no reopen)
 *                        ├ reopen rule matches (§9.3) ► reopened
 *                        └ else ────────────────────► seen_again (once per resolve)
 *
 * A scan never closes a finding: only humans resolve (§9.2).
 */
import type { FindingRecord } from '../../../security-scanner/src/runner/report.ts';
import { sha256Hex } from './input/t2.ts';
import type {
  SecurityFindingEventAction,
  SecurityResolution,
  SecuritySeverity,
  SecurityScanTrigger,
} from './schema.ts';

/** Stored per scan at most (spec §9.2); the rest is dropped and the scan noted. */
export const SECURITY_MAX_CONFIRMED_PER_SCAN = 50;
export const SECURITY_MAX_LEADS_PER_SCAN = 50;
export const SECURITY_MAX_REJECTED_PER_SCAN = 50;
/** Model rejections kept per project (newest first), for debugging only. */
export const SECURITY_REJECTED_KEPT_PER_PROJECT = 200;
/** Coverage note of a scan that reported more than the per-scan cap. */
export const SECURITY_FINDINGS_CAPPED_NOTE = 'findings-capped';
/** `security_findings.detail` is at most this many bytes of JSON. */
export const SECURITY_DETAIL_MAX_BYTES = 32 * 1024;
/** `security_memory_rejected.reason` is at most this many bytes. */
export const SECURITY_REJECTED_REASON_MAX_BYTES = 1024;

const SEVERITY_RANK: Readonly<Record<SecuritySeverity, number>> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function severityRank(severity: SecuritySeverity | null): number {
  return severity === null ? -1 : SEVERITY_RANK[severity];
}

export function isUrgentSeverity(severity: SecuritySeverity | null): boolean {
  return severity === 'critical' || severity === 'high';
}

/**
 * The dedupe key. The project is part of it so a key never means the same thing in
 * two projects; a lead with no sink uses its file. The source leads the input, so a
 * model fingerprint (free text) can never name a server lead's key and take over its
 * row (spec §10.3: server leads are made whatever the model outputs).
 */
export function securityFingerprintKey(
  projectId: string,
  fingerprint: string,
  sinkPath: string,
  source: 'scanner' | 'server' = 'scanner',
): string {
  return sha256Hex(`${source}\u0000${projectId}\u0000${fingerprint}\u0000${sinkPath}`);
}

/** One record ready to store: from the model report or a server lead. */
export type SecurityIngestRecord = Readonly<{
  key: string;
  fingerprint: string;
  verdict: 'confirmed' | 'needs_validation';
  severity: SecuritySeverity | null;
  confidence: string | null;
  title: string;
  category: string;
  cwe: string | null;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  sinkPath: string;
  /** Content hash of the sink file in this scan's input; `null` when not known. */
  sinkHash: string | null;
  outsideDiff: boolean;
  detail: Readonly<Record<string, unknown>>;
  source: 'scanner' | 'server';
  /** M30: `runtime` when a request to the scan's copy proved it. Absent means static. */
  verdictSource?: 'static' | 'runtime';
  /**
   * M31: the key does not name the file (a server secret finding: client bundles have
   * hashed names), so a re-seen row takes this record's file, lines, title and detail.
   */
  moves?: true;
}>;

/** Trims the longest text fields until the detail fits its column (32 KB). */
export function boundedDetail(
  detail: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...detail };
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  // jsonb::text adds a space after each `:` and `,`; keep room for that.
  const limit = SECURITY_DETAIL_MAX_BYTES - 2048;
  for (let round = 0; round < 16 && size() > limit; round++) {
    let longest: string | null = null;
    for (const [key, value] of Object.entries(out)) {
      if (
        typeof value === 'string' &&
        (longest === null || value.length > (out[longest] as string).length)
      ) {
        longest = key;
      }
    }
    if (longest === null) {
      break;
    }
    const text = out[longest] as string;
    out[longest] = `${text.slice(0, Math.floor(text.length / 2))} [cut]`;
  }
  if (size() > limit && Array.isArray(out.trace)) {
    out.trace = (out.trace as Array<unknown>).slice(0, 5);
  }
  return out;
}

/** A model record as a stored record. `null` for `rejected` (stored apart, never fed). */
export function recordFromReport(
  projectId: string,
  record: FindingRecord,
  sinkHashes: ReadonlyMap<string, string>,
): SecurityIngestRecord | null {
  if (record.verdict === 'rejected') {
    return null;
  }
  const sinkPath = record.sink_path ?? record.file;
  return {
    key: securityFingerprintKey(projectId, record.fingerprint, sinkPath),
    fingerprint: record.fingerprint,
    verdict: record.verdict,
    severity: record.verdict === 'confirmed' ? record.severity : null,
    confidence: record.confidence,
    title: record.title,
    category: record.category,
    cwe: record.cwe,
    file: record.file,
    lineStart: record.line_start,
    lineEnd: record.line_end,
    sinkPath,
    sinkHash: sinkHashes.get(sinkPath) ?? null,
    outsideDiff: record.outside_diff,
    detail: boundedDetail({
      trace: record.trace,
      evidence: record.evidence,
      conditions: record.conditions,
      fix: record.fix,
      ...(record.runtime_proof ? { runtime_proof: record.runtime_proof } : {}),
    }),
    source: 'scanner',
    ...(record.verdict === 'confirmed' && record.verdict_source === 'runtime'
      ? { verdictSource: 'runtime' as const }
      : {}),
  };
}

/**
 * The records a scan may store, one per key (spec §8.4): a `succeeded` scan all of
 * them, an `incomplete` one validated `confirmed` records only. Duplicates of one key
 * in a report count once (the highest verdict and severity win).
 */
export function uniqueStoredRecords(
  records: ReadonlyArray<SecurityIngestRecord>,
  options: Readonly<{ confirmedOnly: boolean }>,
): Array<SecurityIngestRecord> {
  const byKey = new Map<string, SecurityIngestRecord>();
  for (const record of records) {
    if (options.confirmedOnly && record.verdict !== 'confirmed') {
      continue;
    }
    const seen = byKey.get(record.key);
    if (!seen || recordOutranks(record, seen)) {
      byKey.set(record.key, record);
    }
  }
  return [...byKey.values()];
}

/**
 * The per-scan cap (spec §9.2) on top of {@link uniqueStoredRecords}. It limits new
 * rows only: a key the project already has (`existingKeys`) adds no row and is always
 * kept, so a capped scan still re-sees, reopens and promotes every finding it
 * reported. New keys: at most 50 confirmed (most severe first) and 50 leads (server
 * leads first, so a flood of model leads cannot push them out); `capped` says some
 * were dropped.
 */
export function selectStoredRecords(
  records: ReadonlyArray<SecurityIngestRecord>,
  options: Readonly<{ confirmedOnly: boolean; existingKeys?: ReadonlySet<string> }>,
): Readonly<{ records: ReadonlyArray<SecurityIngestRecord>; capped: boolean }> {
  const unique = uniqueStoredRecords(records, options);
  const existingKeys = options.existingKeys ?? new Set<string>();
  const known = unique.filter((record) => existingKeys.has(record.key));
  const fresh = unique.filter((record) => !existingKeys.has(record.key));
  const confirmed = fresh
    .filter((record) => record.verdict === 'confirmed')
    .map((record, index) => ({ record, index }))
    .sort(
      (left, right) =>
        severityRank(right.record.severity) - severityRank(left.record.severity) ||
        left.index - right.index,
    )
    .map((entry) => entry.record);
  const leads = fresh
    .filter((record) => record.verdict === 'needs_validation')
    .map((record, index) => ({ record, index }))
    .sort(
      (left, right) =>
        Number(right.record.source === 'server') - Number(left.record.source === 'server') ||
        left.index - right.index,
    )
    .map((entry) => entry.record);
  const capped =
    confirmed.length > SECURITY_MAX_CONFIRMED_PER_SCAN ||
    leads.length > SECURITY_MAX_LEADS_PER_SCAN;
  return {
    records: [
      ...known,
      ...confirmed.slice(0, SECURITY_MAX_CONFIRMED_PER_SCAN),
      ...leads.slice(0, SECURITY_MAX_LEADS_PER_SCAN),
    ],
    capped,
  };
}

function recordOutranks(record: SecurityIngestRecord, seen: SecurityIngestRecord): boolean {
  if (record.verdict !== seen.verdict) {
    return record.verdict === 'confirmed';
  }
  return severityRank(record.severity) > severityRank(seen.severity);
}

/** What the rules need from the scan being ingested. */
export type SecurityIngestScan = Readonly<{
  id: string;
  trigger: SecurityScanTrigger;
  /** `created_at` of the head deployment (admission); `null` when the row is gone. */
  deploymentAdmittedAt: string | null;
  startedAt: string | null;
}>;

/**
 * Stale-scan rule (spec §9.3): a scan may reopen a resolved finding only when its head
 * deployment was admitted after `resolved_at`; an operator rescan only when it started
 * after it. Gate scans use the deployment rule. Unknown times count as stale, so old
 * code never reopens a fix that already shipped.
 */
export function isStaleForResolve(scan: SecurityIngestScan, resolvedAt: string | null): boolean {
  if (resolvedAt === null) {
    return false;
  }
  const at = scan.trigger === 'rescan' ? scan.startedAt : scan.deploymentAdmittedAt;
  if (at === null) {
    return true;
  }
  return !(Date.parse(at) > Date.parse(resolvedAt));
}

/**
 * Reopen rule for a non-stale scan that reports a resolved key (spec §9.3): `fixed`
 * always; `false_positive` / `accepted_risk` when the sink file changed or the
 * severity is higher than at resolve. A sink hash that is not known on either side
 * does not count as a change: only a human call suppresses, and an unknown is not
 * evidence against it.
 */
export function shouldReopen(
  input: Readonly<{
    resolution: SecurityResolution;
    resolvedSeverity: SecuritySeverity | null;
    resolvedSinkHash: string | null;
    severity: SecuritySeverity | null;
    sinkHash: string | null;
  }>,
): boolean {
  if (input.resolution === 'fixed') {
    return true;
  }
  const sinkChanged =
    input.resolvedSinkHash !== null &&
    input.sinkHash !== null &&
    input.resolvedSinkHash !== input.sinkHash;
  const severityRose =
    input.severity !== null && severityRank(input.severity) > severityRank(input.resolvedSeverity);
  return sinkChanged || severityRose;
}

/** The stored finding as the rules see it. */
export type SecurityStoredFinding = Readonly<{
  id: string;
  number: number;
  verdict: 'confirmed' | 'needs_validation';
  severity: SecuritySeverity | null;
  state: 'open' | 'resolved';
  resolution: SecurityResolution | null;
  resolvedAt: string | null;
  resolvedSinkHash: string | null;
  resolvedSeverity: SecuritySeverity | null;
  notSeenInLatest: boolean;
  /** A `seen_again` / `seen_again_stale` event exists since the last resolve. */
  seenSinceResolve: boolean;
  /** M30: how the stored confirmation was reached; absent means static. */
  verdictSource?: 'static' | 'runtime';
  /**
   * M35: the severity a human set (`severity_override`). It is the severity people see and
   * the rules use; a scan never changes it. Absent or `null`: the scan's value.
   */
  severityOverride?: SecuritySeverity | null;
}>;

/** Columns the ingest writes on an existing finding. */
export type SecurityFindingPatch = {
  lastSeenScanId: string;
  sinkContentHash: string | null;
  notSeenInLatest: false;
  verdict?: 'confirmed';
  severity?: SecuritySeverity;
  /** Lead → confirmed: the confirmed record's fields replace the lead's. */
  details?: SecurityIngestRecord;
  /** M30: a runtime confirmation of a finding stored as static (never the other way). */
  verdictSource?: 'runtime';
  /** M30: the request that proved it, merged into the stored `detail` with the source. */
  runtimeProof?: Readonly<Record<string, unknown>>;
  /** M31: where the finding is now (a record that `moves`). */
  location?: SecurityIngestRecord;
  reopen?: true;
};

export type SecurityFindingDecision = Readonly<{
  patch: SecurityFindingPatch;
  events: ReadonlyArray<SecurityFindingEventAction>;
  /** Counts as "new" for the findings email (spec §9.4). */
  news: boolean;
  reopened: boolean;
}>;

/** The decision for a key the project already has (spec §9.1–§9.4). */
export function decideSeenFinding(
  stored: SecurityStoredFinding,
  record: SecurityIngestRecord,
  scan: SecurityIngestScan,
): SecurityFindingDecision {
  const patch: SecurityFindingPatch = {
    lastSeenScanId: scan.id,
    sinkContentHash: record.sinkHash,
    notSeenInLatest: false,
  };
  const events: Array<SecurityFindingEventAction> = [];
  let news = false;
  let reopened = false;
  let verdict = stored.verdict;
  if (stored.verdict === 'needs_validation' && record.verdict === 'confirmed') {
    // A lead confirmed later becomes a finding (never the other way).
    patch.verdict = 'confirmed';
    patch.details = record;
    verdict = 'confirmed';
    events.push('promoted');
  } else if (record.moves) {
    patch.location = record;
  }
  if (
    record.verdict === 'confirmed' &&
    record.verdictSource === 'runtime' &&
    stored.verdictSource !== 'runtime'
  ) {
    // A runtime proof only adds to a finding: a later static scan never takes it away.
    patch.verdictSource = 'runtime';
    const proof = record.detail.runtime_proof;
    if (patch.details === undefined && proof && typeof proof === 'object') {
      // A lead promoted here takes the record's whole detail; a stored finding keeps its
      // own and gets only the proof, so the view never shows runtime without it.
      patch.runtimeProof = proof as Readonly<Record<string, unknown>>;
    }
  }
  const human = stored.severityOverride ?? null;
  let severity = stored.severity;
  if (
    record.verdict === 'confirmed' &&
    record.severity !== null &&
    severityRank(record.severity) > severityRank(stored.severity)
  ) {
    // Severity only rises: a scan cannot downgrade a stored finding (§10.3).
    patch.severity = record.severity;
    severity = record.severity;
    // Under a human severity the shown value does not move: no event, no revision.
    if (patch.verdict === undefined && human === null) {
      events.push('severity_changed');
    }
  }
  // What people see and the rules use: the human value wins (M35).
  const shown = human ?? severity;
  if (stored.state === 'resolved' && stored.resolution !== null) {
    if (isStaleForResolve(scan, stored.resolvedAt)) {
      if (!stored.seenSinceResolve) {
        events.push('seen_again_stale');
      }
    } else if (
      shouldReopen({
        resolution: stored.resolution,
        resolvedSeverity: stored.resolvedSeverity,
        resolvedSinkHash: stored.resolvedSinkHash,
        // "Severity rose" compares the human value when there is one (M35).
        severity: human ?? record.severity,
        sinkHash: record.sinkHash,
      })
    ) {
      patch.reopen = true;
      reopened = true;
      events.push('reopened');
    } else if (!stored.seenSinceResolve) {
      events.push('seen_again');
    }
  }
  const urgentNow = verdict === 'confirmed' && isUrgentSeverity(shown);
  if (reopened) {
    // A reopened finding is new (§9.4), but only for the confirmed crit/high email.
    news = urgentNow;
  } else if (stored.state === 'open') {
    if (patch.verdict === 'confirmed') {
      // First seen as confirmed in this project.
      news = shown !== 'informational';
    } else if (patch.severity !== undefined && verdict === 'confirmed' && human === null) {
      // Severity rose into high or critical.
      news = isUrgentSeverity(severity) && !isUrgentSeverity(stored.severity);
    }
  }
  return { patch, events, news, reopened };
}

/** A key first seen in this project: "new" when confirmed and not informational (§9.4). */
export function isNewRecord(record: SecurityIngestRecord): boolean {
  return record.verdict === 'confirmed' && record.severity !== 'informational';
}

export type SecurityScanScope = Readonly<{
  /** A full scan looked at every file it could read. */
  full: boolean;
  /** Diff tiers: the focus. Full: every file in the input. The files it looked at. */
  paths: ReadonlySet<string>;
  /** Files the scan left in the backlog (not read). */
  unread: ReadonlySet<string>;
}>;

/**
 * "Not seen in latest scan" (spec §9.1): set by a `succeeded` scan on an open finding it
 * did not report while it looked at the finding's file. A diff scan looks only at its
 * focus, so a finding in an unchanged file keeps its state; a full scan only at the
 * files in its input. A file the input filters left out (secret-like, third-party, a
 * bad path), one left in the backlog, or one gone from the deployment was not looked
 * at, so its findings keep their state.
 */
export function notSeenNow(
  finding: Readonly<{ file: string | null; sinkPath: string | null }>,
  scope: SecurityScanScope,
): boolean {
  const paths = [finding.file, finding.sinkPath].filter(
    (path): path is string => path !== null && path.length > 0,
  );
  return paths.some((path) => scope.paths.has(path) && !scope.unread.has(path));
}

/** Cuts text to at most `max` UTF-8 bytes without splitting a character. */
export function cutUtf8(text: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) {
    return text;
  }
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > max) {
      break;
    }
    out += char;
    bytes += size;
  }
  return out;
}
