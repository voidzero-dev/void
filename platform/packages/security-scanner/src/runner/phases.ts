// The deploy-diff profile, the same for every engine (spec §8.1): one hunt
// session, then one fresh verify session per candidate (at most `maxVerify`).
// "confirmed (static)" needs both the hunt trace and a separate verify session.

import type { Engine, SessionOutcome, SessionSpec } from './engines/types.ts';
import { huntPrompt, systemPrompt, verifyPrompt } from './prompts.ts';
import { SEVERITIES, type FindingRecord, type ScanReport } from './report.ts';
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
  signal?: AbortSignal;
};

const NOT_CONFIRMED_REASON = 'The verify session did not report this candidate again.';

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

  const run = async (spec: Omit<SessionSpec, 'system' | 'maxTurns' | 'signal'>) => {
    const outcome = await engine.runSession({
      ...spec,
      system,
      maxTurns: task.maxTurns,
      signal,
    });
    record(result, spec, outcome);
    return outcome;
  };

  const hunt = await run({ phase: 'hunt', index: 0, prompt: huntPrompt(task, options.hasMemory) });
  if (hunt.kind !== 'submitted') {
    return { ...result, ...outcomeStatus(hunt) };
  }

  const { candidates, rejected } = splitCandidates(hunt.report);
  const toVerify = candidates.slice(0, task.maxVerify);
  // Candidates past the verify cap had no second session, so they stay leads.
  const unverified = candidates.slice(task.maxVerify).map(asLead);
  const verified: Array<FindingRecord> = [];

  for (const [position, candidate] of toVerify.entries()) {
    const outcome = await run({
      phase: 'verify',
      index: position + 1,
      prompt: verifyPrompt(candidate),
      check: oneRecordAtMost,
    });
    if (outcome.kind !== 'submitted') {
      const fields = outcomeStatus(outcome);
      // Only an `incomplete` scan keeps findings, and then only verified confirmed ones.
      const kept = fields.status === 'incomplete' ? confirmedOnly(verified) : [];
      return { ...result, ...fields, findings: kept };
    }
    verified.push(verifiedRecord(candidate, outcome.report));
  }

  const all = [...verified, ...unverified, ...rejected];
  if (hunt.report.run_status === 'incomplete') {
    return {
      ...result,
      status: 'incomplete',
      reason: 'run_incomplete',
      findings: confirmedOnly(all),
    };
  }
  return { ...result, findings: ordered(all) };
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

function asLead(finding: FindingRecord): FindingRecord {
  return { ...finding, verdict: 'needs_validation', severity: null };
}

function confirmedOnly(findings: ReadonlyArray<FindingRecord>): Array<FindingRecord> {
  return ordered(findings.filter((finding) => finding.verdict === 'confirmed'));
}

const VERDICT_ORDER = { confirmed: 0, needs_validation: 1, rejected: 2 } as const;

function ordered(findings: ReadonlyArray<FindingRecord>): Array<FindingRecord> {
  return [...findings].sort(
    (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || rank(a) - rank(b),
  );
}
