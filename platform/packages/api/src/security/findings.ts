/**
 * Finding rules applied at ingest (spec §9). Pure: the ingest transaction reads the rows,
 * these decide, and it writes what they return. A scan never closes a finding (§9.2).
 *
 *   no row ──────► created (F-n)
 *   open row ────► last seen; lead → confirmed = promoted; severity only rises
 *   resolved row ─ stale scan ► seen_again_stale │ reopen rule ► reopened │ else seen_again
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
export const SECURITY_REJECTED_KEPT_PER_PROJECT = 200;
export const SECURITY_FINDINGS_CAPPED_NOTE = 'findings-capped';
export const SECURITY_DETAIL_MAX_BYTES = 32 * 1024;
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

/** The dedupe key. The source leads, so a model fingerprint never names a server lead's key. */
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
  sinkHash: string | null;
  outsideDiff: boolean;
  detail: Readonly<Record<string, unknown>>;
  source: 'scanner' | 'server';
  verdictSource?: 'static' | 'runtime';
  /** M31: the key does not name the file, so a re-seen row takes this record's location. */
  moves?: true;
}>;

interface SecurityDetail {
  [key: string]: unknown;
}

/** Trims the longest text fields until the detail fits its column (32 KB). */
export function boundedDetail(detail: Readonly<Record<string, unknown>>): Readonly<SecurityDetail> {
  const out: SecurityDetail = { ...detail };
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

/** One record per key (highest verdict and severity); `confirmedOnly` for an incomplete scan. */
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

/** The per-scan cap (§9.2) on new keys only; keys the project has are always kept. */
type StoredRecordSelection = Readonly<{
  records: ReadonlyArray<SecurityIngestRecord>;
  capped: boolean;
}>;

export function selectStoredRecords(
  records: ReadonlyArray<SecurityIngestRecord>,
  options: Readonly<{ confirmedOnly: boolean; existingKeys?: ReadonlySet<string> }>,
): StoredRecordSelection {
  const unique = uniqueStoredRecords(records, options);
  const existingKeys = options.existingKeys ?? new Set<string>();
  const known = unique.filter((record) => existingKeys.has(record.key));
  const fresh = unique.filter((record) => !existingKeys.has(record.key));
  // Stable sorts: confirmed by severity, leads with server leads first.
  const confirmed = fresh
    .filter((record) => record.verdict === 'confirmed')
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  const leads = fresh
    .filter((record) => record.verdict === 'needs_validation')
    .sort((left, right) => Number(right.source === 'server') - Number(left.source === 'server'));
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
  deploymentAdmittedAt: string | null;
  startedAt: string | null;
}>;

/** Stale-scan rule (§9.3): reopen only when admitted (rescan: started) after the resolve. */
export function isStaleForResolve(scan: SecurityIngestScan, resolvedAt: string | null): boolean {
  if (resolvedAt === null) {
    return false;
  }
  const at = scan.trigger === 'rescan' ? scan.startedAt : scan.deploymentAdmittedAt;
  return at === null || !(Date.parse(at) > Date.parse(resolvedAt));
}

/** Reopen rule (§9.3): `fixed` always; else a known sink change or a higher severity. */
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
  seenSinceResolve: boolean;
  verdictSource?: 'static' | 'runtime';
  /** M35: the severity a human set; a scan never changes it. */
  severityOverride?: SecuritySeverity | null;
}>;

/** Columns the ingest writes on an existing finding. */
export type SecurityFindingPatch = {
  lastSeenScanId: string;
  sinkContentHash: string | null;
  notSeenInLatest: false;
  verdict?: 'confirmed';
  severity?: SecuritySeverity;
  details?: SecurityIngestRecord;
  verdictSource?: 'runtime';
  runtimeProof?: Readonly<Record<string, unknown>>;
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
    patch.verdictSource = 'runtime';
    const proof = record.detail.runtime_proof;
    if (patch.details === undefined && proof && typeof proof === 'object') {
      // A stored finding keeps its own detail and gets only the proof.
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
    patch.severity = record.severity;
    severity = record.severity;
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
    news = urgentNow;
  } else if (stored.state === 'open') {
    if (patch.verdict === 'confirmed') {
      news = shown !== 'informational';
    } else if (patch.severity !== undefined && verdict === 'confirmed' && human === null) {
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
  full: boolean;
  paths: ReadonlySet<string>;
  unread: ReadonlySet<string>;
}>;

/** "Not seen in latest scan" (§9.1): the scan looked at the finding's file and did not report it. */
export function notSeenNow(
  finding: Readonly<{ file: string | null; sinkPath: string | null }>,
  scope: SecurityScanScope,
): boolean {
  return [finding.file, finding.sinkPath].some(
    (path) => !!path && scope.paths.has(path) && !scope.unread.has(path),
  );
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
