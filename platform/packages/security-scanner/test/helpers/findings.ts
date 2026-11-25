import type { FindingRecord } from '../../src/runner/report.ts';
import { validateFindingsValue } from '../../src/runner/validate-findings.ts';

/** A raw confirmed record as a model would submit it. */
export function confirmed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: 'sqli:listUsers:orderBy',
    verdict: 'confirmed',
    severity: 'high',
    confidence: 'high',
    title: 'SQL injection in the user list',
    category: 'sql-injection',
    cwe: 'CWE-89',
    file: 'src/users.ts',
    line_start: 10,
    line_end: 12,
    sink_path: 'src/db.ts',
    trace: [{ file: 'src/users.ts', line: 10, note: 'orderBy concatenated into SQL' }],
    evidence: 'db.prepare(`SELECT * FROM users ORDER BY ${orderBy}`)',
    fix: 'Allow-list the column names.',
    ...overrides,
  };
}

/** A raw lead (needs_validation) record. */
export function lead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: 'ssrf:proxy',
    verdict: 'needs_validation',
    title: 'Possible SSRF',
    category: 'ssrf',
    file: 'src/proxy.ts',
    sink_path: 'src/proxy.ts',
    ...overrides,
  };
}

/** A raw rejected record. */
export function rejected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fingerprint: 'xss:render',
    verdict: 'rejected',
    title: 'Escaped output',
    category: 'xss',
    file: 'src/render.ts',
    reason: 'The template escapes the value.',
    ...overrides,
  };
}

export function report(findings: Array<unknown>) {
  return { run_status: 'complete', findings };
}

/** The validated form of a raw record. */
export function record(raw: Record<string, unknown>): FindingRecord {
  const result = validateFindingsValue(report([raw]));
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.report.findings[0];
}
