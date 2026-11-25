import { describe, expect, it } from 'vite-plus/test';
import { securityFingerprintKey } from '../../src/security/findings.ts';
import {
  parseFindingsReport,
  parseRunnerStatus,
  recordFromServerLead,
  securityScanOutcome,
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
    // A status written for another scan or attempt is never read as clean.
    expect(
      securityScanOutcome(parseRunnerStatus(status({ attempt: 2 }), SCAN, 1), ok),
    ).toMatchObject({ status: 'failed', reason: 'bad_output', store: 'none' });
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

it('turns a secret found in the output into a confirmed server finding with no value (M31)', () => {
  const value = 'sk_live_value_never_stored';
  const lead = (file: string, client: boolean) =>
    recordFromServerLead(
      'proj_aaaaaaaaaaaa',
      { kind: 'secret_in_output', file, secret: 'STRIPE_KEY', forms: ['raw'], line: 3, client },
      new Map([[file, 'h2']]),
      { isPublic: true },
    );
  const client = lead('_assets/app.js', true);
  expect(client).toMatchObject({
    verdict: 'confirmed',
    severity: 'high',
    source: 'server',
    // Not the file hash: a new bundle must not undo an accepted-risk resolve.
    sinkHash: null,
    fingerprint: 'server:secret_in_output:STRIPE_KEY',
  });
  expect(JSON.stringify(client)).not.toContain(value);
  // One key per secret and side, never the model key for the same fingerprint.
  const server = lead('src/pay.ts', false);
  expect(server.severity).toBe('medium');
  expect(server.key).not.toBe(client.key);
  expect(server.key).not.toBe(
    securityFingerprintKey('proj_aaaaaaaaaaaa', server.fingerprint, 'worker'),
  );
});
