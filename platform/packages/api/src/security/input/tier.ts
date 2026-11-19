/**
 * Input tier, chosen at scan start (spec §7.1; first match wins):
 *
 *   rescan (operator or project) ────────────────────────────► T3 full   (edge #43)
 *   sweep (scheduled, M25) ──────────────────────────────────► T3 full, `standard` profile
 *   fallback (M26) of a rescan or a sweep ───────────────────► T3 full, as the failed scan
 *   no succeeded scan yet ───────────────────────────────────► T3 full (first scan)
 *   base snapshot gone ──────────────────────────────────────► T3 full (no usable base)
 *   T1 source diff possible (hosted `managedBuilds`, M11) ───► T1
 *   else ────────────────────────────────────────────────────► T2 built-output diff
 *
 * The label the page, CLI and admin show is built from the stored row.
 */
import type { SecurityScanTier, SecurityScanTrigger } from '../schema.ts';

/**
 * Why a full scan: no base at all, a base that cannot be diffed against, an operator
 * rescan, or a gate scan with nothing changed and no file to re-check (edge #85).
 */
export type SecurityFullReason =
  | 'first_scan'
  | 'no_usable_base'
  | 'rescan'
  | 'sweep'
  | 'gate_recheck';

/** The full reasons a fallback scan carries over from the scan it re-runs. */
export type SecurityFallbackFullReason = Extract<SecurityFullReason, 'rescan' | 'sweep'>;

/**
 * The full reason a fallback carries, from the coverage notes set when it was queued
 * (`queueSecurityFallbackScans`); `null` for a fallback that follows the base rule.
 */
export function securityFallbackFullReason(
  notes: ReadonlyArray<string>,
): SecurityFallbackFullReason | null {
  if (notes.includes(SECURITY_FULL_REASON_NOTES.rescan)) {
    return 'rescan';
  }
  if (notes.includes(SECURITY_FULL_REASON_NOTES.sweep)) {
    return 'sweep';
  }
  return null;
}

export type SecurityTierChoice = Readonly<{
  tier: SecurityScanTier;
  fullReason: SecurityFullReason | null;
}>;

export function chooseSecurityTier(
  input: Readonly<{
    trigger: SecurityScanTrigger;
    /** The last succeeded scan's deployment, if any. */
    baseDeploymentId: string | null;
    /** Its snapshot is still in R2. */
    baseSnapshot: boolean;
    /** T1 checks passed (M11); always false on a self-hosted install. */
    sourceDiff?: boolean;
    /**
     * A fallback (M26) of a rescan or a sweep: the full scan the failed one was. Without
     * it the base rule could diff the deployment against itself and scan nothing.
     */
    fallbackOf?: SecurityFallbackFullReason | null;
  }>,
): SecurityTierChoice {
  if (input.trigger === 'rescan') {
    return { tier: 'full', fullReason: 'rescan' };
  }
  if (input.trigger === 'sweep') {
    return { tier: 'full', fullReason: 'sweep' };
  }
  if (input.trigger === 'fallback' && input.fallbackOf) {
    return { tier: 'full', fullReason: input.fallbackOf };
  }
  if (input.baseDeploymentId === null) {
    return { tier: 'full', fullReason: 'first_scan' };
  }
  if (!input.baseSnapshot) {
    return { tier: 'full', fullReason: 'no_usable_base' };
  }
  if (input.sourceDiff === true) {
    return { tier: 'source_diff', fullReason: null };
  }
  return { tier: 'built_diff', fullReason: null };
}

/** Coverage notes that name why a full scan ran; `securityCoverageLabel` reads them. */
export const SECURITY_FULL_REASON_NOTES = {
  first_scan: 'first-scan',
  no_usable_base: 'no-usable-base',
  rescan: 'rescan',
  sweep: 'sweep',
  gate_recheck: 'gate-recheck',
} as const satisfies Record<SecurityFullReason, string>;

export type SecurityCoverageRow = Readonly<{
  tier: SecurityScanTier | null;
  coverage: 'complete' | 'partial' | null;
  coverageNotes: ReadonlyArray<string>;
  filesScanned: number;
  backlogFiles: number;
}>;

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * `built-output diff · 12 files`, `full scan (first scan)`, with
 * `· partial (backlog 4,600 files)` when files wait in the backlog.
 */
export function securityCoverageLabel(row: SecurityCoverageRow): string | null {
  if (row.tier === null) {
    return null;
  }
  let label: string;
  if (row.tier === 'full') {
    const notes = row.coverageNotes;
    const reason = notes.includes(SECURITY_FULL_REASON_NOTES.first_scan)
      ? 'first scan'
      : notes.includes(SECURITY_FULL_REASON_NOTES.rescan)
        ? 'rescan'
        : notes.includes(SECURITY_FULL_REASON_NOTES.sweep)
          ? 'sweep'
          : notes.includes(SECURITY_FULL_REASON_NOTES.gate_recheck)
            ? 're-check'
            : 'no usable base';
    label = `full scan (${reason})`;
  } else {
    const name = row.tier === 'source_diff' ? 'source diff' : 'built-output diff';
    label = `${name} · ${plural(row.filesScanned, 'file')}`;
  }
  if (row.backlogFiles > 0) {
    label += ` · partial (backlog ${plural(row.backlogFiles, 'file')})`;
  } else if (row.coverage === 'partial') {
    label += ' · partial';
  }
  return label;
}
