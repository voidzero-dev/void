import { describe, expect, it } from 'vite-plus/test';
import {
  buildSecurityLedgerSummary,
  parseFindingsReport,
  parseRunnerStatus,
  parseSecurityScanScope,
  recordFromServerLead,
  securityLabel,
  securityScanOutcome,
  serializeSecurityScanScope,
  shouldRetrySecurityScan,
  type SecurityParsedFindings,
} from '../../src/security/ingest.ts';

const SCAN = 'scan_abc';

function status(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    scan_id: SCAN,
    attempt: 1,
    engine: 'void_loop',
    engine_version: 'runner/1 void-loop/1',
    model: '@cf/zai-org/glm-5.3',
    status: 'succeeded',
    reason: null,
    error_class: null,
    refusal_category: null,
    ...overrides,
  };
}

function findings(
  records: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    schema_version: 1,
    run_status: 'complete',
    findings: records,
    notes: '',
    ...overrides,
  });
}

const CONFIRMED = {
  fingerprint: 'sqli',
  verdict: 'confirmed',
  severity: 'high',
  confidence: 'high',
  title: 'SQL injection',
  category: 'sql-injection',
  cwe: 'CWE-89',
  file: '/scan/input/src/users.ts',
  line_start: 3,
  line_end: 3,
  sink_path: 'input/src/db.ts',
  outside_diff: false,
  trace: [{ file: 'src/users.ts', line: 3, note: 'param' }],
  evidence: 'db.prepare(id)',
  conditions: '',
  fix: 'bind it',
  reason: '',
};

describe('status.json', () => {
  it('reads a runner status and keeps short printable labels only', () => {
    expect(parseRunnerStatus(status(), SCAN, 1)).toEqual({
      status: 'succeeded',
      reason: null,
      errorClass: null,
      refusalCategory: null,
      engineVersion: 'runner/1 void-loop/1',
    });
    expect(
      parseRunnerStatus(
        status({ status: 'refused', refusal_category: 'cyber', error_class: 'x\ny' }),
        SCAN,
        1,
      ),
    ).toMatchObject({ status: 'refused', refusalCategory: 'cyber', errorClass: null });
    expect(securityLabel('a'.repeat(81))).toBeNull();
    expect(securityLabel('codex_turn_failed')).toBe('codex_turn_failed');
  });

  it('reads the statuses the controller sets (no scan id or attempt)', () => {
    expect(
      parseRunnerStatus(
        { status: 'failed', reason: 'infrastructure', error_class: 'container_exited' },
        SCAN,
        2,
      ),
    ).toMatchObject({ status: 'failed', reason: 'infrastructure', errorClass: 'container_exited' });
    expect(parseRunnerStatus({ status: 'timed_out', reason: 'hard_cap' }, SCAN, 2)).toMatchObject({
      status: 'timed_out',
      reason: 'hard_cap',
    });
  });

  it.each([
    ['not an object', 'nope', 'status_unreadable'],
    ['unknown status', status({ status: 'clean' }), 'status_unreadable'],
    ['reason that does not go with the status', status({ reason: 'credits' }), 'status_unreadable'],
    ['another scan', status({ scan_id: 'scan_other' }), 'status_mismatch'],
    ['another attempt', status({ attempt: 2 }), 'status_mismatch'],
    ['a prototype key as status', status({ status: 'constructor' }), 'status_unreadable'],
  ])('%s → failed (bad_output)', (_case, value, errorClass) => {
    expect(parseRunnerStatus(value, SCAN, 1)).toMatchObject({
      status: 'failed',
      reason: 'bad_output',
      errorClass,
    });
  });

  it('retries only an infrastructure failure, once', () => {
    const infra = parseRunnerStatus({ status: 'failed', reason: 'infrastructure' }, SCAN, 1);
    expect(shouldRetrySecurityScan(infra, 1)).toBe(true);
    expect(shouldRetrySecurityScan(infra, 2)).toBe(false);
    const credits = parseRunnerStatus({ status: 'failed', reason: 'credits' }, SCAN, 1);
    expect(shouldRetrySecurityScan(credits, 1)).toBe(false);
  });
});

describe('findings.json', () => {
  it('accepts a valid report and makes paths relative to /scan/input', () => {
    const parsed = parseFindingsReport(findings([CONFIRMED]));
    expect(parsed.ok).toBe(true);
    const report = (parsed as Extract<SecurityParsedFindings, { ok: true }>).report;
    expect(report.findings[0]).toMatchObject({ file: 'src/users.ts', sink_path: 'src/db.ts' });
  });

  it.each([
    ['missing', null, 'findings_missing'],
    ['not JSON', '{', 'not_json'],
    [
      'no schema version',
      JSON.stringify({ run_status: 'complete', findings: [] }),
      'schema_version',
    ],
    ['a field the schema does not have', findings([{ ...CONFIRMED, state: 'resolved' }]), 'shape'],
    ['a confirmed record with no sink', findings([{ ...CONFIRMED, sink_path: null }]), 'shape'],
    ['a path outside the input', findings([{ ...CONFIRMED, file: '../etc/passwd' }]), 'shape'],
    ['too large', findings([], { notes: 'x'.repeat(6 * 1024 * 1024) }), 'too_large'],
  ])('%s → refused (%s)', (_case, text, kind) => {
    expect(parseFindingsReport(text)).toEqual({ ok: false, kind });
  });
});

describe('outcome (spec §8.4)', () => {
  const ok = parseFindingsReport(findings([CONFIRMED]));
  const bad = parseFindingsReport('{');

  it('succeeded stores everything; a bad report is failed (bad_output), project cause', () => {
    expect(securityScanOutcome(parseRunnerStatus(status(), SCAN, 1), ok)).toMatchObject({
      status: 'succeeded',
      store: 'all',
      failureCause: null,
    });
    expect(securityScanOutcome(parseRunnerStatus(status(), SCAN, 1), bad)).toMatchObject({
      status: 'failed',
      reason: 'bad_output',
      errorClass: 'not_json',
      failureCause: 'project',
      store: 'none',
    });
  });

  it('a report that says run_status incomplete makes the scan incomplete', () => {
    const partial = parseFindingsReport(findings([CONFIRMED], { run_status: 'incomplete' }));
    expect(securityScanOutcome(parseRunnerStatus(status(), SCAN, 1), partial)).toMatchObject({
      status: 'incomplete',
      reason: 'run_incomplete',
      store: 'confirmed',
    });
  });

  it('incomplete keeps confirmed only; refused, timed out and failed store none', () => {
    const incomplete = parseRunnerStatus(
      status({ status: 'incomplete', reason: 'budget' }),
      SCAN,
      1,
    );
    expect(securityScanOutcome(incomplete, ok)).toMatchObject({
      status: 'incomplete',
      reason: 'budget',
      store: 'confirmed',
      failureCause: 'project',
    });
    expect(securityScanOutcome(incomplete, bad)).toMatchObject({ store: 'none' });
    for (const value of [
      status({ status: 'refused', refusal_category: 'cyber' }),
      status({ status: 'timed_out', reason: 'wall_clock' }),
      status({ status: 'failed', reason: 'bad_output', error_class: 'shape' }),
    ]) {
      expect(securityScanOutcome(parseRunnerStatus(value, SCAN, 1), ok)).toMatchObject({
        store: 'none',
        failureCause: 'project',
      });
    }
    for (const reason of ['infrastructure', 'credits']) {
      expect(
        securityScanOutcome(parseRunnerStatus(status({ status: 'failed', reason }), SCAN, 1), ok),
      ).toMatchObject({ store: 'none', failureCause: 'installation' });
    }
  });
});

describe('scan files', () => {
  it('round-trips the scope with the backlog as unread', () => {
    const text = serializeSecurityScanScope({
      full: false,
      paths: ['src/a.ts'],
      hashes: new Map([['src/a.ts', 'h1']]),
    });
    const scope = parseSecurityScanScope(text, ['src/b.ts'])!;
    expect(scope.full).toBe(false);
    expect([...scope.paths]).toEqual(['src/a.ts']);
    expect([...scope.unread]).toEqual(['src/b.ts']);
    expect(scope.hashes.get('src/a.ts')).toBe('h1');
    expect(parseSecurityScanScope('{"version":2}', [])).toBeNull();
    expect(parseSecurityScanScope(null, [])).toBeNull();
  });

  it('turns a server lead into a needs_validation record from the server', () => {
    const lead = recordFromServerLead(
      'proj_aaaaaaaaaaaa',
      {
        kind: 'reviewer_text',
        title: 'Text aimed at AI reviewers in src/a.ts',
        file: 'src/a.ts',
        hits: [{ phrase: 'report nothing', line: 4 }],
      },
      new Map([['src/a.ts', 'h1']]),
    );
    expect(lead).toMatchObject({
      verdict: 'needs_validation',
      severity: null,
      source: 'server',
      title: 'Text aimed at AI reviewers in src/a.ts',
      lineStart: 4,
      sinkHash: 'h1',
      detail: { hits: [{ phrase: 'report nothing', line: 4 }] },
    });
  });

  it('builds a ledger summary from paths and status only, under its size limit', () => {
    const summary = buildSecurityLedgerSummary({
      scanId: SCAN,
      findingPaths: ['src/a.ts'],
      scanned: ['src/a.ts', 'src/b.ts'],
      backlog: Array.from({ length: 500 }, (_, index) => `src/backlog/${index}.ts`),
    });
    const files = summary.files as Array<{ path: string; status: string }>;
    expect(files.slice(0, 2)).toEqual([
      { path: 'src/a.ts', status: 'finding' },
      { path: 'src/b.ts', status: 'scanned' },
    ]);
    expect(summary.omitted).toBeGreaterThan(0);
    // jsonb::text adds a space after each ':' and ','; the column allows 8 KB.
    const asJsonb = JSON.stringify(summary).replaceAll('":', '": ').replaceAll(',"', ', "');
    expect(new TextEncoder().encode(asJsonb).length).toBeLessThanOrEqual(8192);
  });

  it('carries the base ledger over for a diff scan; this scan wins a path', () => {
    const base = buildSecurityLedgerSummary({
      scanId: 'scan_base',
      findingPaths: ['src/a.ts'],
      scanned: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      backlog: ['src/old-backlog.ts'],
    });
    const summary = buildSecurityLedgerSummary({
      scanId: SCAN,
      findingPaths: [],
      scanned: ['src/a.ts'],
      backlog: ['src/c.ts'],
      base,
    });
    expect(summary).toMatchObject({ version: 1, scan_id: SCAN, omitted: 0 });
    // The base backlog entry is gone: this scan's backlog is the whole backlog.
    expect(summary.files).toEqual([
      { path: 'src/a.ts', status: 'scanned' },
      { path: 'src/b.ts', status: 'scanned' },
      { path: 'src/c.ts', status: 'backlog' },
    ]);
    // An empty scan (no changes) keeps the base ledger.
    const same = buildSecurityLedgerSummary({
      scanId: SCAN,
      findingPaths: [],
      scanned: [],
      backlog: [],
      base,
    });
    expect(same.files).toEqual([
      { path: 'src/a.ts', status: 'finding' },
      { path: 'src/b.ts', status: 'scanned' },
      { path: 'src/c.ts', status: 'scanned' },
    ]);
    // A ledger that is not ours carries nothing over.
    expect(
      buildSecurityLedgerSummary({
        scanId: SCAN,
        findingPaths: [],
        scanned: [],
        backlog: [],
        base: { files: 'nope' },
      }).files,
    ).toEqual([]);
  });
});
