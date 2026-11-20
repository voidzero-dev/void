/**
 * The pure part of the public gate (spec §5.5): given the facts of one open public
 * request, what is its state? No database, no clock. `public-gate.ts` reads the facts
 * and applies the verdict.
 *
 *   deployment moving ─────────────────────────► waiting_scan (re-check at cutover)
 *   Zero Trust row not ready ──────────────────► waiting_scan (re-check later)
 *   urgent finding open ───────────────────────► held_findings   (never a bypass)
 *   scan waiting or running ───────────────────► waiting_scan
 *   no scan of the live deployment             ► queue one (input kept) | needs_deploy
 *   scan ended, not succeeded                  ► held_no_result (input_missing: needs_deploy)
 *   succeeded + unproven `fixed` claim ────────► needs_deploy
 *   succeeded + backlog ───────────────────────► waiting_scan, queue the next gate scan
 *                                                 (input gone: needs_deploy)
 *   succeeded + findings capped ───────────────► held_no_result
 *   succeeded, nothing above ──────────────────► pass
 */
import type { SecurityPublicRequestState, SecurityScanStatus } from './schema.ts';

export type GateHeldState = Extract<
  SecurityPublicRequestState,
  'waiting_scan' | 'held_findings' | 'held_no_result' | 'needs_deploy'
>;

/** What the judge needs to know about the newest usable scan of the live deployment. */
export type GateScanFacts = Readonly<{
  id: string;
  status: SecurityScanStatus;
  statusReason: string | null;
  failureCause: 'installation' | 'project' | null;
  backlogFiles: number;
  /** The scan stopped storing findings at the cap: more may be hidden. */
  capped: boolean;
}>;

export type GateJudgeInput = Readonly<{
  /** The deployment the request judges (follows cutover and rollback). */
  targetDeploymentId: string;
  activeDeploymentId: string | null;
  /** A deployment of the project is in `cutover` or `compensating`. */
  deploymentMoving: boolean;
  /** Installation Zero Trust enabled, not public-only, no operation; the project row `ready`. */
  zeroTrustReady: boolean;
  /**
   * The newest scan of the target deployment that is not `superseded` and not a
   * `skipped:protected` or `skipped:project_policy` row; `null` when there is none.
   */
  scan: GateScanFacts | null;
  /** The live deployment's input is kept, so a gate scan can be queued for it. */
  hasInput: boolean;
  /** Open urgent findings, as `F-n`. */
  urgent: ReadonlyArray<string>;
  /** `fixed` critical/high claims that no clean scan of the live code has checked, as `F-n`. */
  unproven: ReadonlyArray<string>;
}>;

export type GateVerdict =
  | Readonly<{ kind: 'pass'; scanId: string }>
  | Readonly<{
      kind: 'hold';
      state: GateHeldState;
      /** A short code, stored in `held_reason`. */
      reason: string;
      blockers: ReadonlyArray<string>;
      /** Queue a new gate scan of the target deployment now. */
      queue: boolean;
      scanId: string | null;
    }>;

const WAITING_SCAN_STATUSES: ReadonlyArray<SecurityScanStatus> = [
  'pending_input',
  'queued',
  'running',
];

function hold(
  state: GateHeldState,
  reason: string,
  scan: GateScanFacts | null,
  options: Readonly<{ blockers?: ReadonlyArray<string>; queue?: boolean }> = {},
): GateVerdict {
  return {
    kind: 'hold',
    state,
    reason,
    blockers: options.blockers ?? [],
    queue: options.queue ?? false,
    scanId: scan?.id ?? null,
  };
}

function unique(values: ReadonlyArray<string>): Array<string> {
  return [...new Set(values)];
}

/** The reason code of a scan that ended with no usable result. */
export function gateNoResultReason(scan: GateScanFacts): string {
  if (scan.status === 'skipped') {
    return `skipped_${scan.statusReason ?? 'unknown'}`;
  }
  if (scan.status === 'failed' && scan.failureCause !== null) {
    return `failed_${scan.failureCause}`;
  }
  return scan.status;
}

export function judgeGate(input: GateJudgeInput): GateVerdict {
  const { scan } = input;
  if (input.deploymentMoving || input.activeDeploymentId !== input.targetDeploymentId) {
    return hold('waiting_scan', 'deployment_moving', scan);
  }
  if (!input.zeroTrustReady) {
    return hold('waiting_scan', 'zero_trust_not_ready', scan);
  }
  if (input.urgent.length > 0) {
    return hold('held_findings', 'urgent_findings', scan, {
      blockers: unique([...input.urgent, ...input.unproven]),
    });
  }
  if (scan !== null && WAITING_SCAN_STATUSES.includes(scan.status)) {
    return hold('waiting_scan', 'scan_waiting', scan);
  }
  if (scan === null) {
    // A rescan of the same deployment proves no `fixed` claim, so it is not queued for one.
    if (input.unproven.length > 0) {
      return hold('needs_deploy', 'unproven_fix', null, { blockers: input.unproven });
    }
    return input.hasInput
      ? hold('waiting_scan', 'scan_queued', null, { queue: true })
      : hold('needs_deploy', 'no_input', null);
  }
  if (scan.status !== 'succeeded') {
    if (scan.status === 'failed' && scan.statusReason === 'input_missing') {
      return hold('needs_deploy', 'input_missing', scan);
    }
    return hold('held_no_result', gateNoResultReason(scan), scan);
  }
  if (input.unproven.length > 0) {
    return hold('needs_deploy', 'unproven_fix', scan, { blockers: input.unproven });
  }
  if (scan.backlogFiles > 0) {
    // With the input gone no next part can be scanned: only a deploy moves it on.
    return input.hasInput
      ? hold('waiting_scan', 'backlog', scan, { queue: true })
      : hold('needs_deploy', 'no_input', scan);
  }
  if (scan.capped) {
    return hold('held_no_result', 'findings_capped', scan);
  }
  return { kind: 'pass', scanId: scan.id };
}

/**
 * What a bypass skips, for the confirm text (spec §5.5). `null` when the state cannot
 * be bypassed.
 */
export function bypassSkips(
  state: SecurityPublicRequestState,
  reason: string | null,
  unproven: ReadonlyArray<string>,
): string | null {
  switch (state) {
    case 'waiting_scan':
      return 'the scan has not finished yet';
    case 'held_no_result':
      return reason && reason !== 'findings_capped'
        ? `the scan did not finish (${reason.split('_').join(' ')})`
        : 'the scan did not finish';
    case 'needs_deploy':
      return unproven.length > 0
        ? `the fix of ${unproven.join(', ')} is not checked by a scan yet`
        : 'the live deployment cannot be scanned until a deploy';
    default:
      return null;
  }
}
