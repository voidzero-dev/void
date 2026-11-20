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

/** Scan status for a session that ended without a usable report. */
export function outcomeStatus(outcome: Exclude<OutcomeBody, { kind: 'submitted' }>): StatusFields {
  switch (outcome.kind) {
    case 'refused':
      return {
        status: 'refused',
        reason: null,
        errorClass: null,
        refusalCategory: outcome.category,
      };
    case 'bad_output':
      return {
        status: 'failed',
        reason: 'bad_output',
        errorClass: outcome.errorKind,
        refusalCategory: null,
      };
    case 'stopped':
      return {
        status: 'incomplete',
        reason: STOP_REASONS[outcome.reason],
        errorClass: null,
        refusalCategory: null,
      };
    case 'credits':
      return { status: 'failed', reason: 'credits', errorClass: null, refusalCategory: null };
    case 'infrastructure':
      return {
        status: 'failed',
        reason: 'infrastructure',
        errorClass: outcome.errorClass,
        refusalCategory: null,
      };
    case 'aborted':
      return { status: 'timed_out', reason: 'wall_clock', errorClass: null, refusalCategory: null };
  }
}

// ---------------------------------------------------------------------------
// Model proxy stops. The proxy (M7) answers a refused call with a non-2xx status
// and `x-void-scan-stop: <reason>`; every engine reaches the model through it.
// ---------------------------------------------------------------------------

export const PROXY_STOP_HEADER = 'x-void-scan-stop';
export const PROXY_STOP_REASONS = [
  'session_calls',
  'scan_calls',
  'tokens',
  'budget',
  'credits',
] as const;
export type ProxyStopReason = (typeof PROXY_STOP_REASONS)[number];

export function readProxyStopReason(value: string | null | undefined): ProxyStopReason | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return (PROXY_STOP_REASONS as ReadonlyArray<string>).includes(trimmed)
    ? (trimmed as ProxyStopReason)
    : null;
}

/** A proxy stop, or `null` when the failure is not one (the caller treats it as infrastructure). */
export function classifyProxyStop(
  httpStatus: number,
  reason: ProxyStopReason | null,
): Extract<OutcomeBody, { kind: 'stopped' | 'credits' }> | null {
  if (reason === 'credits' || (reason === null && httpStatus === 402)) {
    return { kind: 'credits' };
  }
  if (reason !== null) {
    return { kind: 'stopped', reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine A (Claude Agent SDK) and Engine C (Codex SDK) signals. M13 feeds these
// from the SDK result message and the Codex event stream; spikes S2/S3 record the
// exact wording. Kept here so all three engines share one mapping.
// ---------------------------------------------------------------------------

/** The parts of an Agent SDK `result` message the mapping needs. */
export type ClaudeResultSignal = {
  subtype: string;
  stopReason?: string | null;
  stopCategory?: string | null;
  structuredOutput?: unknown;
  /** The result's `is_error`: Claude Code reports an API failure as `subtype: "success"` with this set (S2). */
  isError?: boolean;
  /** The result's `result` text, for example `API Error: 402 …`. */
  resultText?: string | null;
  proxyStop?: { httpStatus: number; reason: ProxyStopReason | null } | null;
};

export function classifyClaudeResult(signal: ClaudeResultSignal): OutcomeBody {
  if (signal.proxyStop) {
    const stop = classifyProxyStop(signal.proxyStop.httpStatus, signal.proxyStop.reason);
    if (stop) {
      return stop;
    }
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

/** The HTTP status in an `API Error: 402 …` text, or `null`. */
export function apiErrorStatus(text: string | null): number | null {
  if (text === null) {
    return null;
  }
  const marker = 'API Error: ';
  const at = text.indexOf(marker);
  if (at === -1) {
    return null;
  }
  const digits = text.slice(at + marker.length, at + marker.length + 3);
  const status = Number(digits);
  return digits.length === 3 && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

function apiErrorOutcome(text: string | null): OutcomeBody {
  const status = apiErrorStatus(text);
  if (status === 402) {
    return { kind: 'credits' };
  }
  return {
    kind: 'infrastructure',
    errorClass: status === null ? 'agent_sdk_error' : `model_http_${status}`,
    detail: status === null ? 'agent SDK reported an error' : `model call answered ${status}`,
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
  proxyStop: { httpStatus: number; reason: ProxyStopReason | null } | null;
};

const CODEX_POLICY_CODES = ['cyber_policy', 'trusted_access_for_cyber'];

/**
 * The failure text with spaces and dashes read as `_`: Codex prints its own
 * `CyberPolicy` error as `cyber policy: <message>`, not as the API code (spike S9).
 */
function policyText(value: string): string {
  let out = '';
  for (const char of value.toLowerCase()) {
    out += char === ' ' || char === '-' ? '_' : char;
  }
  return out;
}

export function classifyCodexRun(signal: CodexRunSignal): OutcomeBody {
  if (signal.proxyStop) {
    const stop = classifyProxyStop(signal.proxyStop.httpStatus, signal.proxyStop.reason);
    if (stop) {
      return stop;
    }
  }
  const failureText = policyText(`${signal.failure?.code ?? ''} ${signal.failure?.message ?? ''}`);
  const policyCode = CODEX_POLICY_CODES.find((code) => failureText.includes(code));
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
    return {
      kind: 'infrastructure',
      errorClass: 'codex_turn_failed',
      detail: 'codex turn failed',
    };
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
