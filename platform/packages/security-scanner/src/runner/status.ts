// Status mapping (spec §8.4). Each engine turns its own signals into a neutral
// `SessionOutcome`; `outcomeStatus` turns a session that did not submit into the
// scan status the runner writes to `/scan/out/status.json`.

import type { EngineId, SessionOutcome, StopReason } from './engines/types.ts';
import type { ScanReport } from './report.ts';
import { describeValidationError, validateFindingsValue } from './validate-findings.ts';

export type RunnerScanStatus = 'succeeded' | 'incomplete' | 'failed' | 'refused' | 'timed_out';

/** `security_scans.status_reason` for the statuses the runner can end in. */
export type RunnerStatusReason =
  | 'bad_output'
  | 'infrastructure'
  | 'credits'
  | 'budget'
  | 'turn_cap'
  | 'call_cap'
  | 'token_cap'
  | 'run_incomplete'
  | 'wall_clock';

export type StatusFields = {
  status: RunnerScanStatus;
  reason: RunnerStatusReason | null;
  errorClass: string | null;
  refusalCategory: string | null;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An outcome before the engine adds its session counters. */
export type OutcomeBody = DistributiveOmit<SessionOutcome, 'stats'>;

const STOP_REASONS: Readonly<Record<StopReason, RunnerStatusReason>> = {
  turns: 'turn_cap',
  session_calls: 'turn_cap',
  scan_calls: 'call_cap',
  tokens: 'token_cap',
  budget: 'budget',
};

function fields(
  status: RunnerScanStatus,
  reason: RunnerStatusReason | null,
  errorClass: string | null = null,
  refusalCategory: string | null = null,
): StatusFields {
  return { status, reason, errorClass, refusalCategory };
}

/** Scan status for a session that ended without a usable report. */
export function outcomeStatus(outcome: Exclude<OutcomeBody, { kind: 'submitted' }>): StatusFields {
  switch (outcome.kind) {
    case 'refused':
      return fields('refused', null, null, outcome.category);
    case 'bad_output':
      return fields('failed', 'bad_output', outcome.errorKind);
    case 'stopped':
      return fields('incomplete', STOP_REASONS[outcome.reason]);
    case 'credits':
      return fields('failed', 'credits');
    case 'infrastructure':
      return fields('failed', 'infrastructure', outcome.errorClass);
    case 'aborted':
      return fields('timed_out', 'wall_clock');
  }
}

// Model proxy stops. The proxy (M7) answers a refused call with a non-2xx status and
// `x-void-scan-stop: <reason>`; every engine reaches the model through it.

export const PROXY_STOP_HEADER = 'x-void-scan-stop';
const PROXY_STOP_REASONS = ['session_calls', 'scan_calls', 'tokens', 'budget', 'credits'] as const;
export type ProxyStopReason = (typeof PROXY_STOP_REASONS)[number];
export type ProxyStop = { httpStatus: number; reason: ProxyStopReason | null };

export function readProxyStopReason(value: string | null | undefined): ProxyStopReason | null {
  const trimmed = value?.trim();
  return PROXY_STOP_REASONS.find((reason) => reason === trimmed) ?? null;
}

/** A proxy stop, or `null` when the failure is not one (the caller treats it as infrastructure). */
export function classifyProxyStop(
  httpStatus: number,
  reason: ProxyStopReason | null,
): Extract<OutcomeBody, { kind: 'stopped' | 'credits' }> | null {
  if (reason === 'credits' || (reason === null && httpStatus === 402)) {
    return { kind: 'credits' };
  }
  return reason === null ? null : { kind: 'stopped', reason };
}

// Engine A (Claude Agent SDK) and Engine C (Codex SDK) signals; spikes S2/S3 record the
// exact wording.

/** The parts of an Agent SDK `result` message the mapping needs. */
export type ClaudeResultSignal = {
  subtype: string;
  stopReason?: string | null;
  stopCategory?: string | null;
  structuredOutput?: unknown;
  /** Claude Code reports an API failure as `subtype: "success"` with `is_error` set (S2). */
  isError?: boolean;
  /** The result's `result` text, for example `API Error: 402 …`. */
  resultText?: string | null;
  proxyStop?: ProxyStop | null;
};

export function classifyClaudeResult(signal: ClaudeResultSignal): OutcomeBody {
  const stop =
    signal.proxyStop && classifyProxyStop(signal.proxyStop.httpStatus, signal.proxyStop.reason);
  if (stop) {
    return stop;
  }
  if (signal.stopReason === 'refusal') {
    return { kind: 'refused', category: signal.stopCategory ?? null };
  }
  switch (signal.subtype) {
    case 'success':
      if (signal.isError === true && signal.structuredOutput === undefined) {
        return apiErrorOutcome(signal.resultText ?? null);
      }
      return reportOutcome(signal.structuredOutput);
    case 'error_max_turns':
      return { kind: 'stopped', reason: 'turns' };
    case 'error_max_structured_output_retries':
      return {
        kind: 'bad_output',
        errorKind: 'structured_output_retries',
        message: 'structured output retries used up',
      };
    default:
      return {
        kind: 'infrastructure',
        errorClass: 'agent_sdk_error',
        detail: `agent SDK ended with ${safeLabel(signal.subtype)}`,
      };
  }
}

/** The outcome of an `API Error: 402 …` text: credits, a model HTTP error, or an SDK error. */
function apiErrorOutcome(text: string | null): OutcomeBody {
  const marker = 'API Error: ';
  const at = text?.indexOf(marker) ?? -1;
  const digits = text?.slice(at + marker.length, at + marker.length + 3) ?? '';
  const status = Number(digits);
  if (
    at === -1 ||
    digits.length !== 3 ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    return {
      kind: 'infrastructure',
      errorClass: 'agent_sdk_error',
      detail: 'agent SDK reported an error',
    };
  }
  if (status === 402) {
    return { kind: 'credits' };
  }
  return {
    kind: 'infrastructure',
    errorClass: `model_http_${status}`,
    detail: `model call answered ${status}`,
  };
}

/** What a finished `codex exec` run left behind. */
export type CodexRunSignal = {
  /** The report `submit_findings` accepted, if any. */
  submitted: ScanReport | null;
  /** The last report `submit_findings` refused, when none was accepted. */
  rejected?: { kind: string; message: string } | null;
  /** The `turn.failed` / `error` event, if any. */
  failure: { code?: string | null; message?: string | null } | null;
  finalMessage: string | null;
  exitCode: number | null;
  /** Codex sees a proxy stop only as a failed call, so the runner asks the proxy why. */
  proxyStop: ProxyStop | null;
};

const CODEX_POLICY_CODES = ['cyber_policy', 'trusted_access_for_cyber'];

/**
 * Lower-case letters and digits only, so `cyber_policy`, Codex's `cyber policy: …`
 * (spike S9), a line break between the words and `CyberPolicy { … }` read the same.
 */
function policyText(value: string): string {
  let out = '';
  for (const char of value.toLowerCase()) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      out += char;
    }
  }
  return out;
}

export function classifyCodexRun(signal: CodexRunSignal): OutcomeBody {
  const stop =
    signal.proxyStop && classifyProxyStop(signal.proxyStop.httpStatus, signal.proxyStop.reason);
  if (stop) {
    return stop;
  }
  const failureText = policyText(`${signal.failure?.code ?? ''} ${signal.failure?.message ?? ''}`);
  const policyCode = CODEX_POLICY_CODES.find((code) => failureText.includes(policyText(code)));
  if (policyCode) {
    return { kind: 'refused', category: policyCode };
  }
  if (signal.submitted) {
    return { kind: 'submitted', report: signal.submitted, repaired: false };
  }
  if (signal.rejected) {
    return {
      kind: 'bad_output',
      errorKind: signal.rejected.kind,
      message: signal.rejected.message,
    };
  }
  if (signal.failure) {
    return { kind: 'infrastructure', errorClass: 'codex_turn_failed', detail: 'codex turn failed' };
  }
  if (signal.exitCode !== null && signal.exitCode !== 0) {
    return {
      kind: 'infrastructure',
      errorClass: 'codex_exit',
      detail: `codex exited with ${signal.exitCode}`,
    };
  }
  const final = (signal.finalMessage ?? '').trim();
  if (final.startsWith('{')) {
    // Held to --output-schema; a JSON final message that fails our check is bad output.
    let parsed: unknown;
    try {
      parsed = JSON.parse(final);
    } catch {
      return { kind: 'bad_output', errorKind: 'not_json', message: 'final message is not JSON' };
    }
    return reportOutcome(parsed);
  }
  // No submit_findings and an empty or plain-text final message: Codex drops refusal parts.
  return { kind: 'refused', category: null };
}

function reportOutcome(value: unknown): OutcomeBody {
  const result = validateFindingsValue(value);
  if (!result.ok) {
    return { kind: 'bad_output', errorKind: result.kind, message: describeValidationError(result) };
  }
  return { kind: 'submitted', report: result.report, repaired: false };
}

/** Keeps engine-provided labels short and printable before they reach status.json. */
export function safeLabel(value: string): string {
  let out = '';
  for (const char of value.slice(0, 80)) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '?' : char;
  }
  return out;
}

export type StatusFile = {
  schema_version: 1;
  // `null` only when task.json could not be read.
  scan_id: string | null;
  attempt: number | null;
  engine: EngineId | null;
  engine_version: string;
  model: string | null;
  status: RunnerScanStatus;
  reason: RunnerStatusReason | null;
  error_class: string | null;
  refusal_category: string | null;
  /** Runner-written text only, never model output. */
  message: string | null;
  sessions: Array<{
    phase: 'hunt' | 'verify';
    index: number;
    outcome: SessionOutcome['kind'];
    turns: number;
    model_calls: number;
  }>;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  findings: { confirmed: number; needs_validation: number; rejected: number };
  started_at: string;
  finished_at: string;
};
