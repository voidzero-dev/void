/**
 * The pure public gate judge (spec §5.5): the facts of one open request ─► its state.
 * `public-gate.ts` reads the facts and applies the verdict.
 *
 *   nothing live, nothing moving (target '') ─► pass: a first deploy that never went live
 *   deployment moving ─────────────────────────► waiting_scan (re-check at cutover)
 *   Zero Trust row not ready ──────────────────► waiting_scan (re-check later)
 *   urgent finding open ───────────────────────► held_findings   (never a bypass)
 *   scan waiting or running ───────────────────► waiting_scan
 *   no scan of the live deployment             ► queue one (input kept) | needs_deploy
 *   scan ended, not succeeded                  ► held_no_result: ask again queues one more
 *                                                 (input gone or input_missing: needs_deploy);
 *                                                 unproven `fixed` claims listed as blockers
 *   succeeded + unproven `fixed` claim ────────► needs_deploy
 *   succeeded + backlog ───────────────────────► waiting_scan, queue the next gate scan
 *                                                 (input gone: needs_deploy)
 *   succeeded + findings capped ───────────────► held_no_result (input gone: needs_deploy)
 *   succeeded + project files unread ──────────► held_no_result, never queued again
 *                                                 (input gone: needs_deploy)
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
  capped: boolean;
  unreadFiles: boolean;
}>;

export type GateJudgeInput = Readonly<{
  targetDeploymentId: string;
  activeDeploymentId: string | null;
  deploymentMoving: boolean;
  zeroTrustReady: boolean;
  /** The newest target scan, not superseded nor skipped by protection or project policy. */
  scan: GateScanFacts | null;
  hasInput: boolean;
  urgent: ReadonlyArray<string>;
  /** `fixed` critical/high claims no clean scan of the live code has checked, as `F-n`. */
  unproven: ReadonlyArray<string>;
}>;

export type GateVerdict =
  // `scanId` is null when nothing is live or on its way: there is no code to judge.
  | Readonly<{ kind: 'pass'; scanId: string | null }>
  | Readonly<{
      kind: 'hold';
      state: GateHeldState;
      reason: string;
      blockers: ReadonlyArray<string>;
      queue: boolean;
      scanId: string | null;
    }>;

const WAITING_SCAN_STATUSES = new Set<SecurityScanStatus>(['pending_input', 'queued', 'running']);

/** `held_reason` of a scan that left project files unread: a rescan reads no more. */
export const SECURITY_GATE_UNREAD_FILES = 'unread_files';

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
  if (
    input.activeDeploymentId === null &&
    input.targetDeploymentId === '' &&
    !input.deploymentMoving
  ) {
    // A first deploy that never went live: nothing is exposed.
    return { kind: 'pass', scanId: null };
  }
  if (input.deploymentMoving || input.activeDeploymentId !== input.targetDeploymentId) {
    return hold('waiting_scan', 'deployment_moving', scan);
  }
  if (!input.zeroTrustReady) {
    return hold('waiting_scan', 'zero_trust_not_ready', scan);
  }
  if (input.urgent.length > 0) {
    return hold('held_findings', 'urgent_findings', scan, {
      blockers: [...new Set([...input.urgent, ...input.unproven])],
    });
  }
  if (scan !== null && WAITING_SCAN_STATUSES.has(scan.status)) {
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
    // Unproven `fixed` claims still block (spec §4, gate blocker): listed with the hold.
    const blockers = { blockers: input.unproven };
    if (scan.status === 'failed' && scan.statusReason === 'input_missing') {
      return hold('needs_deploy', 'input_missing', scan, blockers);
    }
    // Asking again cannot scan code that is gone: only a deploy moves it on (edge #54).
    return input.hasInput
      ? hold('held_no_result', gateNoResultReason(scan), scan, blockers)
      : hold('needs_deploy', 'no_input', scan, blockers);
  }
  if (input.unproven.length > 0) {
    return hold('needs_deploy', 'unproven_fix', scan, { blockers: input.unproven });
  }
  const gap =
    scan.backlogFiles > 0
      ? 'backlog'
      : scan.capped
        ? 'findings_capped'
        : scan.unreadFiles
          ? SECURITY_GATE_UNREAD_FILES
          : null;
  if (gap === null) {
    return { kind: 'pass', scanId: scan.id };
  }
  // With the input gone nothing more can be scanned: only a deploy moves it on.
  if (!input.hasInput) {
    return hold('needs_deploy', 'no_input', scan);
  }
  return gap === 'backlog'
    ? hold('waiting_scan', gap, scan, { queue: true })
    : hold('held_no_result', gap, scan);
}

/** What a bypass skips, for the confirm text (§5.5); `null` when it cannot be bypassed. */
export function bypassSkips(
  state: SecurityPublicRequestState,
  reason: string | null,
  unproven: ReadonlyArray<string>,
): string | null {
  switch (state) {
    case 'waiting_scan':
      return 'the scan has not finished yet';
    case 'held_no_result': {
      const scan =
        reason === SECURITY_GATE_UNREAD_FILES
          ? 'the scan could not read some project files'
          : reason && reason !== 'findings_capped'
            ? `the scan did not finish (${reason.split('_').join(' ')})`
            : 'the scan did not finish';
      return unproven.length > 0
        ? `${scan}; the fix of ${unproven.join(', ')} is not checked by a scan yet`
        : scan;
    }
    case 'needs_deploy':
      return unproven.length > 0
        ? `the fix of ${unproven.join(', ')} is not checked by a scan yet`
        : 'the live deployment cannot be scanned until a deploy';
    default:
      return null;
  }
}
