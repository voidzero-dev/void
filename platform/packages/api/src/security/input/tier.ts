/**
 * Input tier, chosen at scan start (spec §7.1; first match wins):
 *
 *   rescan (operator or project) ────────────────────────────► T3 full   (edge #43)
 *   sweep (scheduled, M25) ──────────────────────────────────► T3 full, `standard` profile
 *   local check of a working tree (M32) ─────────────────────► T3 full, never a base
 *   fallback (M26) of a rescan or a sweep ───────────────────► T3 full, as the failed scan
 *   no succeeded scan yet ───────────────────────────────────► T3 full (first scan)
 *   base snapshot gone ──────────────────────────────────────► T3 full (no usable base)
 *   T1 source diff possible (hosted `managedBuilds`, M11) ───► T1
 *   else ────────────────────────────────────────────────────► T2 built-output diff
 *
 * The label the page, CLI and admin show is built from the stored row.
 */
import type { SecurityScanTier, SecurityScanTrigger } from '../schema.ts';

/** Why a full scan; `gate_recheck`: a gate scan with nothing changed to re-check (edge #85). */
export type SecurityFullReason =
  | 'first_scan'
  | 'no_usable_base'
  | 'rescan'
  | 'sweep'
  | 'gate_recheck'
  | 'local';

export type SecurityFallbackFullReason = Extract<SecurityFullReason, 'rescan' | 'sweep'>;

/** The full reason a fallback carries over, from its coverage notes; `null`: the base rule. */
export function securityFallbackFullReason(
  notes: ReadonlyArray<string>,
): SecurityFallbackFullReason | null {
  return (['rescan', 'sweep'] as const).find((reason) => notes.includes(reason)) ?? null;
}

export type SecurityTierChoice = Readonly<{
  tier: SecurityScanTier;
  fullReason: SecurityFullReason | null;
}>;

export function chooseSecurityTier(
  input: Readonly<{
    trigger: SecurityScanTrigger;
    baseDeploymentId: string | null;
    baseSnapshot: boolean;
    sourceDiff?: boolean;
    /** A fallback (M26) of a rescan or sweep is the full scan the failed one was. */
    fallbackOf?: SecurityFallbackFullReason | null;
  }>,
): SecurityTierChoice {
  if (input.trigger === 'rescan' || input.trigger === 'sweep' || input.trigger === 'local') {
    return { tier: 'full', fullReason: input.trigger };
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
  return { tier: input.sourceDiff === true ? 'source_diff' : 'built_diff', fullReason: null };
}

/** Prefix of the coverage note for a wanted runtime copy that was not made. */
export const SECURITY_RUNTIME_COPY_NOT_MADE_NOTE = 'runtime-copy-not-made';

/** Coverage notes that name why a full scan ran; `securityCoverageLabel` reads them. */
export const SECURITY_FULL_REASON_NOTES = {
  first_scan: 'first-scan',
  no_usable_base: 'no-usable-base',
  rescan: 'rescan',
  sweep: 'sweep',
  gate_recheck: 'gate-recheck',
  local: 'local-check',
} as const satisfies Record<SecurityFullReason, string>;

export type SecurityCoverageRow = Readonly<{
  tier: SecurityScanTier | null;
  coverage: 'complete' | 'partial' | null;
  coverageNotes: ReadonlyArray<string>;
  filesScanned: number;
  backlogFiles: number;
}>;

const FULL_REASON_LABELS = [
  [SECURITY_FULL_REASON_NOTES.first_scan, 'first scan'],
  [SECURITY_FULL_REASON_NOTES.rescan, 'rescan'],
  [SECURITY_FULL_REASON_NOTES.sweep, 'sweep'],
  [SECURITY_FULL_REASON_NOTES.gate_recheck, 're-check'],
  [SECURITY_FULL_REASON_NOTES.local, 'local check'],
] as const;

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

/** `built-output diff · 12 files`, `full scan (first scan) · partial (backlog 4,600 files)`. */
export function securityCoverageLabel(row: SecurityCoverageRow): string | null {
  if (row.tier === null) {
    return null;
  }
  let label: string;
  if (row.tier === 'full') {
    const reason = FULL_REASON_LABELS.find(([note]) => row.coverageNotes.includes(note));
    label = `full scan (${reason?.[1] ?? 'no usable base'})`;
  } else {
    const name = row.tier === 'source_diff' ? 'source diff' : 'built-output diff';
    label = `${name} · ${plural(row.filesScanned, 'file')}`;
  }
  if (row.backlogFiles > 0) {
    label += ` · partial (backlog ${plural(row.backlogFiles, 'file')})`;
  } else if (row.coverage === 'partial') {
    label += ' · partial';
  }
  if (row.coverageNotes.some((note) => note.startsWith(SECURITY_RUNTIME_COPY_NOT_MADE_NOTE))) {
    label += ' · static only (runtime copy not made)';
  }
  return label;
}
