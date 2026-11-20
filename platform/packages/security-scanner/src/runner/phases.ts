// Two profiles, the same for every engine (spec §8.1):
//   deploy_diff  one hunt session, then one fresh verify session per candidate
//                (at most `maxVerify`).
//   standard     scheduled sweeps (M25): one hunt session per focus area over the
//                whole app, candidates merged by fingerprint, then the same verify step.
// "confirmed (static)" needs both the hunt trace and a separate verify session.
// M30: with a runtime copy, each verify session can also send test requests to it;
// a confirmation that names a request the copy answered is "confirmed (runtime)".

import type { Engine, SessionOutcome, SessionSpec } from './engines/types.ts';
import { huntPrompt, STANDARD_HUNT_FOCUS, systemPrompt, verifyPrompt } from './prompts.ts';
import { REPORT_LIMITS, SEVERITIES, type FindingRecord, type ScanReport } from './report.ts';
import {
  type CopyClient,
  type CopyRequestRecord,
  withoutRuntimeFields,
  withVerdictSource,
} from './runtime/copy.ts';
import { outcomeStatus, type StatusFields, type StatusFile } from './status.ts';
import type { ScanTask } from './task.ts';

export type PhasesResult = StatusFields & {
  findings: Array<FindingRecord>;
  sessions: StatusFile['sessions'];
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
};

export type PhasesOptions = {
  engine: Engine;
  task: ScanTask;
  hasMemory: boolean;
  /** M30: the scan's runtime copy, used when the task asks for it and the engine can. */
  copy?: CopyClient;
  signal?: AbortSignal;
};

const NOT_CONFIRMED_REASON = 'The verify session did not report this candidate again.';

type HuntResult =
  | { kind: 'done'; report: ScanReport; failed: boolean }
  | { kind: 'ended'; fields: StatusFields };

export async function runPhases(options: PhasesOptions): Promise<PhasesResult> {
  const { engine, task, signal } = options;
  const system = systemPrompt();
  const result: PhasesResult = {
    status: 'succeeded',
    reason: null,
    errorClass: null,
    refusalCategory: null,
    findings: [],
    sessions: [],
    modelCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };

  const run = async (
    spec: Omit<SessionSpec, 'system' | 'maxTurns' | 'signal'>,
    maxTurns = task.maxTurns,
  ) => {
    const outcome = await engine.runSession({ ...spec, system, maxTurns, signal });
    record(result, spec, outcome);
    return outcome;
  };

  const hunt =
    task.profile === 'standard'
      ? await standardHunt(task, options.hasMemory, run)
      : await deployDiffHunt(task, options.hasMemory, run);
  if (hunt.kind === 'ended') {
    return { ...result, ...hunt.fields };
  }

  // Only the runner sets runtime fields; a hunt record never carries them.
  const { candidates, rejected } = splitCandidates({
    ...hunt.report,
    findings: hunt.report.findings.map(withoutRuntimeFields),
  });
  const toVerify = candidates.slice(0, task.maxVerify);
  // Candidates past the verify cap had no second session, so they stay leads.
  const unverified = candidates.slice(task.maxVerify).map(asLead);
  const verified: Array<FindingRecord> = [];
  let verifyFailed = false;
  // Session indexes stay unique: verify sessions follow the hunt sessions.
  const firstVerifyIndex = result.sessions.length;
  const copy =
    toVerify.length > 0 &&
    task.runtimeCopy &&
    engine.sessionTools === true &&
    options.copy !== undefined &&
    (await options.copy.waitReady())
      ? options.copy
      : null;

  for (const [position, candidate] of toVerify.entries()) {
    const session = copy?.sessionTool() ?? null;
    const outcome = await run({
      phase: 'verify',
      index: firstVerifyIndex + position,
      prompt: verifyPrompt(candidate, { runtime: session !== null }),
      check: oneRecordAtMost,
      ...(session ? { tools: [session.tool] } : {}),
    });
    if (outcome.kind === 'bad_output') {
      // One unreadable check must not cost the findings already confirmed. The candidate
      // stays a lead, the other candidates still get their session, and the scan ends
      // incomplete so the public gate does not read it as a full pass (S4 follow-up).
      verifyFailed = true;
      verified.push(asLead(candidate));
      continue;
    }
    if (outcome.kind !== 'submitted') {
      const fields = outcomeStatus(outcome);
      // Only an `incomplete` scan keeps findings, and then only verified confirmed ones.
      const kept = fields.status === 'incomplete' ? confirmedOnly(verified) : [];
      return { ...result, ...fields, findings: kept };
    }
    verified.push(sourced(verifiedRecord(candidate, outcome.report), session?.requests ?? null));
  }

  const all = [...verified, ...unverified, ...rejected];
  const findings = ordered(all);
  // The `standard` hunts together can find more than one report holds; the file must
  // pass the same limits, so a list that does not fit keeps only what verify confirmed.
  if (
    hunt.report.run_status === 'incomplete' ||
    hunt.failed ||
    verifyFailed ||
    !fitsReport(findings)
  ) {
    return {
      ...result,
      status: 'incomplete',
      reason: 'run_incomplete',
      findings: confirmedOnly(all),
    };
  }
  return { ...result, findings };
}

/** Room left for the findings file's other fields (`schema_version`, `run_status`, `notes`). */
const REPORT_FRAME_BYTES = 1024;

/** Whether `findings` fit one findings file (`validate-findings.ts` limits). */
export function fitsReport(findings: ReadonlyArray<FindingRecord>): boolean {
  return (
    findings.length <= REPORT_LIMITS.maxRecords &&
    Buffer.byteLength(JSON.stringify(findings), 'utf8') <=
      REPORT_LIMITS.maxBytes - REPORT_FRAME_BYTES
  );
}

/**
 * The focus hunts' records, one per fingerprint. Every hunt reads the same memory and
 * keeps its fingerprints, so one issue can come back from several areas with different
 * verdicts; the strongest is kept (confirmed, then lead, then rejected; then severity),
 * so a rejection by one area never hides a confirmation by another.
 */
export function mergeHuntFindings(findings: ReadonlyArray<FindingRecord>): Array<FindingRecord> {
  const byFingerprint = new Map<string, FindingRecord>();
  for (const finding of findings) {
    const kept = byFingerprint.get(finding.fingerprint);
    if (kept === undefined || compareStrength(finding, kept) < 0) {
      byFingerprint.set(finding.fingerprint, finding);
    }
  }
  return [...byFingerprint.values()];
}

type RunSession = (
  spec: Omit<SessionSpec, 'system' | 'maxTurns' | 'signal'>,
  maxTurns?: number,
) => Promise<SessionOutcome>;

async function deployDiffHunt(
  task: ScanTask,
  hasMemory: boolean,
  run: RunSession,
): Promise<HuntResult> {
  const hunt = await run({ phase: 'hunt', index: 0, prompt: huntPrompt(task, hasMemory) });
  if (hunt.kind !== 'submitted') {
    return { kind: 'ended', fields: outcomeStatus(hunt) };
  }
  return { kind: 'done', report: hunt.report, failed: false };
}

/**
 * Hunt turns per focus session in the `standard` profile: half the session limit, so
 * the hunts together stay near one deploy-diff hunt and leave calls for verify.
 */
export function standardHuntTurns(task: ScanTask): number {
  return Math.max(1, Math.ceil(task.maxTurns / 2));
}

/**
 * One hunt session per focus area. An unreadable report costs that area only (the scan
 * ends incomplete); any other stop ends the scan as in the deploy-diff hunt.
 */
async function standardHunt(
  task: ScanTask,
  hasMemory: boolean,
  run: RunSession,
): Promise<HuntResult> {
  const findings: Array<FindingRecord> = [];
  let incomplete = false;
  let failed = false;
  let firstFailure: Extract<SessionOutcome, { kind: 'bad_output' }> | null = null;
  let submitted = 0;
  for (const [index, focus] of STANDARD_HUNT_FOCUS.entries()) {
    const hunt = await run(
      { phase: 'hunt', index, prompt: huntPrompt(task, hasMemory, focus) },
      standardHuntTurns(task),
    );
    if (hunt.kind === 'bad_output') {
      failed = true;
      firstFailure ??= hunt;
      continue;
    }
    if (hunt.kind !== 'submitted') {
      return { kind: 'ended', fields: outcomeStatus(hunt) };
    }
    submitted++;
    findings.push(...hunt.report.findings);
    incomplete ||= hunt.report.run_status === 'incomplete';
  }
  if (submitted === 0 && firstFailure !== null) {
    return { kind: 'ended', fields: outcomeStatus(firstFailure) };
  }
  return {
    kind: 'done',
    report: {
      run_status: incomplete ? 'incomplete' : 'complete',
      findings: mergeHuntFindings(findings),
      notes: '',
    },
    failed,
  };
}

function record(
  result: PhasesResult,
  spec: Pick<SessionSpec, 'phase' | 'index'>,
  outcome: SessionOutcome,
): void {
  result.sessions.push({
    phase: spec.phase,
    index: spec.index,
    outcome: outcome.kind,
    turns: outcome.stats.turns,
    model_calls: outcome.stats.modelCalls,
  });
  result.modelCalls += outcome.stats.modelCalls;
  result.tokensIn += outcome.stats.inputTokens;
  result.tokensOut += outcome.stats.outputTokens;
}

/** Hunt candidates to verify (confirmed first, by severity), and the hunt's own rejections. */
export function splitCandidates(report: ScanReport): {
  candidates: Array<FindingRecord>;
  rejected: Array<FindingRecord>;
} {
  const seen = new Set<string>();
  const candidates: Array<FindingRecord> = [];
  const rejected: Array<FindingRecord> = [];
  for (const finding of report.findings) {
    if (seen.has(finding.fingerprint)) {
      continue;
    }
    seen.add(finding.fingerprint);
    (finding.verdict === 'rejected' ? rejected : candidates).push(finding);
  }
  candidates.sort((a, b) => rank(a) - rank(b));
  return { candidates, rejected };
}

function rank(finding: FindingRecord): number {
  if (finding.verdict !== 'confirmed' || finding.severity === null) {
    return SEVERITIES.length;
  }
  return SEVERITIES.indexOf(finding.severity);
}

function oneRecordAtMost(report: ScanReport): string | null {
  return report.findings.length <= 1
    ? null
    : 'a verify session submits exactly one record, for the candidate it was given';
}

/** The verify session's call on one candidate. The hunt's fingerprint is kept so keys stay stable. */
export function verifiedRecord(candidate: FindingRecord, report: ScanReport): FindingRecord {
  const answer = report.findings[0];
  if (answer === undefined) {
    return {
      ...candidate,
      verdict: 'rejected',
      severity: null,
      reason: NOT_CONFIRMED_REASON,
    };
  }
  return { ...answer, fingerprint: candidate.fingerprint };
}

/** The verify record with the runtime claim checked (a session with no copy: none). */
function sourced(
  record: FindingRecord,
  requests: ReadonlyArray<CopyRequestRecord> | null,
): FindingRecord {
  return requests === null ? withoutRuntimeFields(record) : withVerdictSource(record, requests);
}

function asLead(finding: FindingRecord): FindingRecord {
  return { ...finding, verdict: 'needs_validation', severity: null };
}

function confirmedOnly(findings: ReadonlyArray<FindingRecord>): Array<FindingRecord> {
  return ordered(findings.filter((finding) => finding.verdict === 'confirmed'));
}

const VERDICT_ORDER = { confirmed: 0, needs_validation: 1, rejected: 2 } as const;

function compareStrength(a: FindingRecord, b: FindingRecord): number {
  return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || rank(a) - rank(b);
}

function ordered(findings: ReadonlyArray<FindingRecord>): Array<FindingRecord> {
  return [...findings].sort(compareStrength);
}
