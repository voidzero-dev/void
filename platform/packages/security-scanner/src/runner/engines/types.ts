// The contract every engine (A: Claude Agent SDK, B: Void loop, C: Codex SDK)
// implements. The runner owns the phases; an engine runs one fresh session.

import type { ScanReport } from '../report.ts';

export type SessionPhase = 'hunt' | 'verify';

/** A tool one session adds to the scan tools (M30: `copy_request` in verify sessions). */
export type SessionTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
};

export type SessionSpec = {
  phase: SessionPhase;
  /** 0 for the hunt, 1… for verify sessions. */
  index: number;
  system: string;
  prompt: string;
  maxTurns: number;
  /** Extra rule on a valid report (a verify session submits one record at most). */
  check?: (report: ScanReport) => string | null;
  /** Extra tools for this session; only engines with `sessionTools` get them. */
  tools?: ReadonlyArray<SessionTool>;
  signal?: AbortSignal;
};

/** Why the proxy or the engine stopped a session before `submit_findings` (spec §8.4). */
export type StopReason = 'turns' | 'session_calls' | 'scan_calls' | 'tokens' | 'budget';

export type SessionStats = {
  turns: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Reads that returned code: a read_file (Engine A: Read) of a file under /scan/input
   * with non-blank lines. A list, a search or a memory read does not count. A session
   * with none saw no code, so its report cannot clear any (phases.ts `readNothing`).
   */
  reads: number;
};

export type SessionOutcome = { stats: SessionStats } & (
  | { kind: 'submitted'; report: ScanReport; repaired: boolean }
  | { kind: 'refused'; category: string | null }
  | { kind: 'bad_output'; errorKind: string; message: string }
  | { kind: 'stopped'; reason: StopReason }
  | { kind: 'credits' }
  | { kind: 'infrastructure'; errorClass: string; detail: string }
  | { kind: 'aborted' }
);

export type EngineId = 'void_loop' | 'agent_sdk' | 'codex_sdk';

export interface Engine {
  readonly id: EngineId;
  /** Stored as `security_scans.engine_version`. */
  readonly version: string;
  /** M30: the engine offers `SessionSpec.tools` to the model (Engine B's own loop). */
  readonly sessionTools?: boolean;
  runSession(spec: SessionSpec): Promise<SessionOutcome>;
}

export function emptyStats(): SessionStats {
  return { turns: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, reads: 0 };
}
