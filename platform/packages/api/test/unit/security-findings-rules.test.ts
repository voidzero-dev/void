import { describe, expect, it } from 'vite-plus/test';
import type { FindingRecord } from '../../../security-scanner/src/runner/report.ts';
import {
  decideSeenFinding,
  isStaleForResolve,
  recordFromReport,
  securityFingerprintKey,
  shouldReopen,
} from '../../src/security/findings.ts';
import type { SecurityIngestScan, SecurityStoredFinding } from '../../src/security/findings.ts';

const PROJECT = 'proj_aaaaaaaaaaaa';
const RESOLVED_AT = '2026-11-18T14:05:00.000Z';

function report(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    fingerprint: 'sqli-users',
    verdict: 'confirmed',
    severity: 'high',
    confidence: 'high',
    title: 'SQL injection in /users',
    category: 'sql-injection',
    cwe: 'CWE-89',
    file: 'src/routes/users.ts',
    line_start: 10,
    line_end: 12,
    sink_path: 'src/db.ts',
    outside_diff: false,
    trace: [{ file: 'src/routes/users.ts', line: 10, note: 'query param' }],
    evidence: 'db.prepare(`... ${id}`)',
    conditions: '',
    fix: 'bind the value',
    reason: '',
    ...overrides,
  };
}

function record(overrides: Partial<FindingRecord> = {}, sinkHash = 'hash-1') {
  return recordFromReport(PROJECT, report(overrides), new Map([['src/db.ts', sinkHash]]))!;
}

function stored(overrides: Partial<SecurityStoredFinding> = {}): SecurityStoredFinding {
  return {
    id: 'sf_1',
    number: 12,
    verdict: 'confirmed',
    severity: 'high',
    state: 'open',
    resolution: null,
    resolvedAt: null,
    resolvedSinkHash: null,
    resolvedSeverity: null,
    notSeenInLatest: false,
    seenSinceResolve: false,
    ...overrides,
  };
}

function resolved(
  resolution: 'fixed' | 'false_positive' | 'accepted_risk',
  overrides: Partial<SecurityStoredFinding> = {},
) {
  return stored({
    state: 'resolved',
    resolution,
    resolvedAt: RESOLVED_AT,
    resolvedSinkHash: 'hash-1',
    resolvedSeverity: 'high',
    ...overrides,
  });
}

/** A deploy scan of a deployment admitted at `admittedAt`. */
function scan(admittedAt: string | null = '2026-11-18T15:00:00.000Z'): SecurityIngestScan {
  return {
    id: 'scan_2',
    trigger: 'deploy',
    deploymentAdmittedAt: admittedAt,
    startedAt: '2026-11-18T15:01:00.000Z',
  };
}

it('stores no model rejection and never gives a model record a server lead key', () => {
  const rejected = report({ verdict: 'rejected', severity: null, reason: 'verified safe' });
  expect(recordFromReport(PROJECT, rejected, new Map())).toBeNull();
  const forged = record({ fingerprint: 'server:reviewer_text' });
  expect(forged.key).not.toBe(
    securityFingerprintKey(PROJECT, 'server:reviewer_text', 'src/db.ts', 'server'),
  );
});

describe('reopen rules (spec §9.3)', () => {
  const base = {
    resolvedSeverity: 'high' as const,
    resolvedSinkHash: 'hash-1',
    severity: 'high' as const,
    sinkHash: 'hash-1',
  };

  it.each([
    ['fixed', 'same sink, same severity', base, true],
    ['false_positive', 'same sink, same severity', base, false],
    ['accepted_risk', 'sink file changed', { ...base, sinkHash: 'hash-2' }, true],
    ['accepted_risk', 'severity higher', { ...base, severity: 'critical' as const }, true],
  ] as const)('%s, %s → reopen %s', (resolution, _case, input, expected) => {
    expect(shouldReopen({ resolution, ...input })).toBe(expected);
  });

  it('treats a scan of a deployment admitted before the resolve as stale', () => {
    expect(isStaleForResolve(scan('2026-11-18T14:00:00.000Z'), RESOLVED_AT)).toBe(true);
    expect(isStaleForResolve(scan(null), RESOLVED_AT)).toBe(true);
    expect(isStaleForResolve(scan('2026-11-18T14:06:00.000Z'), RESOLVED_AT)).toBe(false);
  });
});

// I5: a scan adds, confirms or reopens; only a human closes, and a human severity never moves.
describe('a key the project already has', () => {
  it('never closes or demotes: an open finding seen again only moves last seen', () => {
    const seen = decideSeenFinding(stored({ notSeenInLatest: true }), record(), scan());
    expect(seen.events).toEqual([]);
    expect(seen.patch).toEqual({
      lastSeenScanId: 'scan_2',
      sinkContentHash: 'hash-1',
      notSeenInLatest: false,
    });
    const asLead = record({ verdict: 'needs_validation', severity: null, trace: [] });
    expect(decideSeenFinding(stored(), asLead, scan()).patch.verdict).toBeUndefined();
    const lower = decideSeenFinding(stored({ severity: 'critical' }), record(), scan());
    expect(lower.patch.severity).toBeUndefined();
  });

  it('promotes a lead and reopens a fixed finding, but a stale scan never reopens', () => {
    const lead = stored({ verdict: 'needs_validation', severity: null });
    const promoted = decideSeenFinding(lead, record(), scan());
    expect(promoted.events).toEqual(['promoted']);
    expect(promoted.news).toBe(true);

    const reopened = decideSeenFinding(resolved('fixed'), record(), scan());
    expect(reopened.patch.reopen).toBe(true);
    expect(reopened.news).toBe(true);

    const stale = decideSeenFinding(resolved('fixed'), record(), scan('2026-11-18T14:00:00.000Z'));
    expect(stale.events).toEqual(['seen_again_stale']);
    expect(stale.patch.reopen).toBeUndefined();

    const falsePositive = decideSeenFinding(resolved('false_positive'), record(), scan());
    expect(falsePositive.events).toEqual(['seen_again']);
    expect(falsePositive.reopened).toBe(false);
  });

  it('keeps a human severity: no event, and the reopen rule compares the human value', () => {
    const higher = decideSeenFinding(
      stored({ severity: 'high', severityOverride: 'medium' }),
      record({ severity: 'critical' }),
      scan(),
    );
    expect(higher.patch.severity).toBe('critical');
    expect(higher.patch).not.toHaveProperty('severityOverride');
    expect(higher.events).toEqual([]);
    expect(higher.news).toBe(false);

    const accepted = decideSeenFinding(
      resolved('accepted_risk', { severityOverride: 'medium', resolvedSeverity: 'medium' }),
      record({ severity: 'critical' }),
      scan(),
    );
    expect(accepted.reopened).toBe(false);
  });
});
