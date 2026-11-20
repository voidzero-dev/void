import { describe, expect, it } from 'vite-plus/test';
import type { FindingRecord } from '../../../security-scanner/src/runner/report.ts';
import {
  boundedDetail,
  cutUtf8,
  decideSeenFinding,
  isNewRecord,
  isStaleForResolve,
  notSeenNow,
  recordFromReport,
  SECURITY_DETAIL_MAX_BYTES,
  SECURITY_MAX_CONFIRMED_PER_SCAN,
  SECURITY_MAX_LEADS_PER_SCAN,
  securityFingerprintKey,
  selectStoredRecords,
  shouldReopen,
  type SecurityIngestRecord,
  type SecurityIngestScan,
  type SecurityStoredFinding,
} from '../../src/security/findings.ts';

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

describe('fingerprint key', () => {
  it('is project + skill fingerprint + sink path; a lead with no sink uses its file', () => {
    const key = securityFingerprintKey(PROJECT, 'sqli-users', 'src/db.ts');
    expect(record().key).toBe(key);
    expect(key).not.toBe(securityFingerprintKey('proj_bbbbbbbbbbbb', 'sqli-users', 'src/db.ts'));
    expect(key).not.toBe(securityFingerprintKey(PROJECT, 'sqli-users', 'src/other.ts'));
    const lead = record({
      verdict: 'needs_validation',
      severity: null,
      sink_path: null,
      trace: [],
    });
    expect(lead.key).toBe(securityFingerprintKey(PROJECT, 'sqli-users', 'src/routes/users.ts'));
    expect(lead.sinkHash).toBeNull();
  });

  it('never gives a model record the key of a server lead', () => {
    const forged = record({ fingerprint: 'server:reviewer_text', sink_path: 'src/db.ts' });
    expect(forged.key).not.toBe(
      securityFingerprintKey(PROJECT, 'server:reviewer_text', 'src/db.ts', 'server'),
    );
  });

  it('keeps model rejections out of the stored records', () => {
    expect(
      recordFromReport(
        PROJECT,
        report({ verdict: 'rejected', severity: null, reason: 'verified safe' }),
        new Map(),
      ),
    ).toBeNull();
  });
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
    ['false_positive', 'sink file changed', { ...base, sinkHash: 'hash-2' }, true],
    ['false_positive', 'severity higher', { ...base, severity: 'critical' as const }, true],
    ['false_positive', 'severity lower', { ...base, severity: 'medium' as const }, false],
    ['accepted_risk', 'same sink, same severity', base, false],
    ['accepted_risk', 'sink file changed', { ...base, sinkHash: 'hash-2' }, true],
    ['accepted_risk', 'severity higher', { ...base, severity: 'critical' as const }, true],
    ['accepted_risk', 'sink hash not known now', { ...base, sinkHash: null }, false],
    ['accepted_risk', 'sink hash not known at resolve', { ...base, resolvedSinkHash: null }, false],
  ] as const)('%s, %s → reopen %s', (resolution, _case, input, expected) => {
    expect(shouldReopen({ resolution, ...input })).toBe(expected);
  });
});

describe('stale-scan rule (spec §9.3, edge #35)', () => {
  it('a scan of a deployment admitted before the resolve is stale', () => {
    expect(isStaleForResolve(scan('2026-11-18T14:00:00.000Z'), RESOLVED_AT)).toBe(true);
    expect(isStaleForResolve(scan(RESOLVED_AT), RESOLVED_AT)).toBe(true);
    expect(isStaleForResolve(scan('2026-11-18T14:06:00.000Z'), RESOLVED_AT)).toBe(false);
  });

  it('an operator rescan uses its start; a gate scan the deployment', () => {
    const old = '2026-11-18T14:00:00.000Z';
    const rescan = { ...scan(old), trigger: 'rescan' as const };
    expect(isStaleForResolve(rescan, RESOLVED_AT)).toBe(false);
    expect(isStaleForResolve({ ...rescan, startedAt: old }, RESOLVED_AT)).toBe(true);
    const gate = { ...scan(old), trigger: 'gate' as const };
    expect(isStaleForResolve(gate, RESOLVED_AT)).toBe(true);
  });

  it('an unknown admission time counts as stale', () => {
    expect(isStaleForResolve(scan(null), RESOLVED_AT)).toBe(true);
  });
});

describe('a key the project already has', () => {
  it('an open finding seen again only moves last seen: no event, not new (edge #20)', () => {
    const decision = decideSeenFinding(stored({ notSeenInLatest: true }), record(), scan());
    expect(decision.events).toEqual([]);
    expect(decision.news).toBe(false);
    expect(decision.patch).toEqual({
      lastSeenScanId: 'scan_2',
      sinkContentHash: 'hash-1',
      notSeenInLatest: false,
    });
  });

  it('a runtime proof marks the finding runtime and is never taken away (M30)', () => {
    const proof = { request: 'r2', method: 'GET' as const, path: '/users?id=1', status: 200 };
    const runtime = record({ verdict_source: 'runtime', runtime_proof: proof });
    expect(runtime.verdictSource).toBe('runtime');
    expect(runtime.detail).toMatchObject({ runtime_proof: proof });
    // A lead never carries the runtime source, whatever the record says.
    expect(
      record({ verdict: 'needs_validation', severity: null, verdict_source: 'runtime' })
        .verdictSource,
    ).toBeUndefined();
    // A finding stored as static keeps its detail and gets the proof with the source.
    const upgraded = decideSeenFinding(stored(), runtime, scan()).patch;
    expect(upgraded.verdictSource).toBe('runtime');
    expect(upgraded.runtimeProof).toEqual(proof);
    expect(upgraded.details).toBeUndefined();
    // A lead confirmed at runtime takes the whole record, proof included.
    const promoted = decideSeenFinding(
      stored({ verdict: 'needs_validation', severity: null }),
      runtime,
      scan(),
    ).patch;
    expect(promoted.verdictSource).toBe('runtime');
    expect(promoted.details?.detail).toMatchObject({ runtime_proof: proof });
    expect(promoted.runtimeProof).toBeUndefined();
    expect(
      decideSeenFinding(stored({ verdictSource: 'runtime' }), record(), scan()).patch.verdictSource,
    ).toBeUndefined();
  });

  it('promotes a lead the scan confirms; new unless informational', () => {
    const lead = stored({ verdict: 'needs_validation', severity: null });
    const decision = decideSeenFinding(lead, record(), scan());
    expect(decision.events).toEqual(['promoted']);
    expect(decision.patch).toMatchObject({ verdict: 'confirmed', severity: 'high' });
    expect(decision.news).toBe(true);
    const info = decideSeenFinding(lead, record({ severity: 'informational' }), scan());
    expect(info.news).toBe(false);
  });

  it('never demotes a confirmed finding a scan reports as a lead', () => {
    const decision = decideSeenFinding(
      stored(),
      record({ verdict: 'needs_validation', severity: null, trace: [] }),
      scan(),
    );
    expect(decision.patch.verdict).toBeUndefined();
    expect(decision.events).toEqual([]);
  });

  it('severity only rises; rising into high is new, rising within low is not', () => {
    const rose = decideSeenFinding(stored({ severity: 'medium' }), record(), scan());
    expect(rose.events).toEqual(['severity_changed']);
    expect(rose.news).toBe(true);
    const fell = decideSeenFinding(stored({ severity: 'critical' }), record(), scan());
    expect(fell.patch.severity).toBeUndefined();
    expect(fell.events).toEqual([]);
    const small = decideSeenFinding(
      stored({ severity: 'low' }),
      record({ severity: 'medium' }),
      scan(),
    );
    expect(small.events).toEqual(['severity_changed']);
    expect(small.news).toBe(false);
  });

  it('reopens a fixed finding a newer deployment still has; urgent → new', () => {
    const decision = decideSeenFinding(resolved('fixed'), record(), scan());
    expect(decision.patch.reopen).toBe(true);
    expect(decision.events).toEqual(['reopened']);
    expect(decision.reopened).toBe(true);
    expect(decision.news).toBe(true);
    const medium = decideSeenFinding(
      resolved('fixed', { severity: 'medium' }),
      record({ severity: 'medium' }),
      scan(),
    );
    expect(medium.reopened).toBe(true);
    expect(medium.news).toBe(false);
  });

  it('a stale scan records seen_again_stale once, never reopens (edge #35)', () => {
    const old = scan('2026-11-18T14:00:00.000Z');
    const first = decideSeenFinding(resolved('fixed'), record(), old);
    expect(first.events).toEqual(['seen_again_stale']);
    expect(first.patch.reopen).toBeUndefined();
    expect(first.news).toBe(false);
    const again = decideSeenFinding(resolved('fixed', { seenSinceResolve: true }), record(), old);
    expect(again.events).toEqual([]);
  });

  it('false_positive seen again unchanged: one seen_again per resolve, no reopen, not new', () => {
    const first = decideSeenFinding(resolved('false_positive'), record(), scan());
    expect(first.events).toEqual(['seen_again']);
    expect(first.reopened).toBe(false);
    expect(first.news).toBe(false);
    const again = decideSeenFinding(
      resolved('false_positive', { seenSinceResolve: true }),
      record(),
      scan(),
    );
    expect(again.events).toEqual([]);
    const changed = decideSeenFinding(resolved('false_positive'), record({}, 'hash-2'), scan());
    expect(changed.events).toEqual(['reopened']);
  });
});

describe('"new" (spec §9.4)', () => {
  it('a new key is new when confirmed and not informational; leads never', () => {
    expect(isNewRecord(record())).toBe(true);
    expect(isNewRecord(record({ severity: 'low' }))).toBe(true);
    expect(isNewRecord(record({ severity: 'informational' }))).toBe(false);
    expect(isNewRecord(record({ verdict: 'needs_validation', severity: null, trace: [] }))).toBe(
      false,
    );
  });
});

describe('per-scan cap (spec §9.2)', () => {
  function many(count: number, overrides: Partial<SecurityIngestRecord>) {
    return Array.from({ length: count }, (_, index) => ({
      ...record(),
      key: `${overrides.verdict ?? 'confirmed'}-${index}`,
      ...overrides,
    }));
  }

  it('keeps 50 confirmed (most severe first) and 50 leads (server leads first)', () => {
    const records = [
      ...many(60, { severity: 'low' }),
      { ...record(), key: 'critical-late', severity: 'critical' as const },
      ...many(55, { verdict: 'needs_validation', severity: null }),
      {
        ...record(),
        key: 'server-lead',
        verdict: 'needs_validation' as const,
        source: 'server' as const,
        severity: null,
      },
    ];
    const selected = selectStoredRecords(records, { confirmedOnly: false });
    expect(selected.capped).toBe(true);
    const confirmed = selected.records.filter((item) => item.verdict === 'confirmed');
    const leads = selected.records.filter((item) => item.verdict === 'needs_validation');
    expect(confirmed).toHaveLength(SECURITY_MAX_CONFIRMED_PER_SCAN);
    expect(confirmed[0]!.key).toBe('critical-late');
    expect(leads).toHaveLength(SECURITY_MAX_LEADS_PER_SCAN);
    expect(leads[0]!.key).toBe('server-lead');
  });

  it('an incomplete scan keeps validated confirmed records only', () => {
    const selected = selectStoredRecords(
      [...many(2, {}), ...many(2, { verdict: 'needs_validation', severity: null })],
      { confirmedOnly: true },
    );
    expect(selected.records.map((item) => item.verdict)).toEqual(['confirmed', 'confirmed']);
    expect(selected.capped).toBe(false);
  });

  it('one key reported twice counts once, the higher verdict and severity winning', () => {
    const lead = { ...record(), verdict: 'needs_validation' as const, severity: null };
    const selected = selectStoredRecords([lead, record(), { ...record(), severity: 'critical' }], {
      confirmedOnly: false,
    });
    expect(selected.records).toHaveLength(1);
    expect(selected.records[0]).toMatchObject({ verdict: 'confirmed', severity: 'critical' });
  });

  it('caps new keys only: a key the project has is always kept', () => {
    const records = many(60, { severity: 'high' });
    const known = { ...record(), key: 'known', severity: 'low' as const };
    const selected = selectStoredRecords([...records, known], {
      confirmedOnly: false,
      existingKeys: new Set(['known']),
    });
    expect(selected.capped).toBe(true);
    expect(selected.records).toHaveLength(SECURITY_MAX_CONFIRMED_PER_SCAN + 1);
    expect(selected.records.map((item) => item.key)).toContain('known');
  });
});

describe('not seen in latest scan (spec §9.1)', () => {
  const finding = { file: 'src/routes/users.ts', sinkPath: 'src/db.ts' };

  it('a diff scan marks only findings in files it looked at', () => {
    const scope = { full: false, paths: new Set(['src/db.ts']), unread: new Set<string>() };
    expect(notSeenNow(finding, scope)).toBe(true);
    expect(notSeenNow({ file: 'src/other.ts', sinkPath: null }, scope)).toBe(false);
  });

  it('a full scan marks only files in its input, never its backlog or filtered files', () => {
    const scope = {
      full: true,
      paths: new Set(['src/app.ts']),
      unread: new Set(['src/db.ts']),
    };
    expect(notSeenNow(finding, scope)).toBe(false);
    expect(notSeenNow({ file: 'src/app.ts', sinkPath: null }, scope)).toBe(true);
    // Filtered out of the input (secret-like, third-party) or gone: not looked at.
    expect(notSeenNow({ file: '.env', sinkPath: null }, scope)).toBe(false);
    expect(notSeenNow({ file: 'src/gone.ts', sinkPath: null }, scope)).toBe(false);
  });
});

describe('size limits', () => {
  it('cuts the detail to fit its 32 KB column', () => {
    const detail = boundedDetail({
      evidence: 'é'.repeat(20_000),
      fix: 'f'.repeat(4000),
      trace: [],
    });
    expect(new TextEncoder().encode(JSON.stringify(detail)).length).toBeLessThan(
      SECURITY_DETAIL_MAX_BYTES,
    );
    expect(detail.fix).toBe('f'.repeat(4000));
  });

  it('cuts text by UTF-8 bytes without splitting a character', () => {
    expect(cutUtf8('abc', 10)).toBe('abc');
    expect(cutUtf8('ééé', 5)).toBe('éé');
  });
});
