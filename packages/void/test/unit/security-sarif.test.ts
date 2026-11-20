import { describe, expect, it } from 'vite-plus/test';
import { SARIF_SCHEMA_URI, securityFindingsSarif } from '../../src/cli/security-sarif.ts';

type SarifResult = {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: unknown;
  partialFingerprints: Record<string, string>;
  suppressions?: unknown;
  properties: Record<string, unknown>;
};

type Log = {
  $schema: string;
  version: string;
  runs: Array<{
    tool: { driver: { name: string; version?: string; rules: Array<Record<string, unknown>> } };
    results: Array<SarifResult>;
  }>;
};

const sarif = (findings: Parameters<typeof securityFindingsSarif>[0], version = '1.10.0') =>
  securityFindingsSarif(findings, { version }) as unknown as Log;

describe('securityFindingsSarif (M31)', () => {
  it('writes a SARIF 2.1.0 log with one run and the CLI version', () => {
    const log = sarif([]);
    expect(log.$schema).toBe(SARIF_SCHEMA_URI);
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]!.tool.driver).toMatchObject({
      name: 'Void Security Audit',
      version: '1.10.0',
      rules: [],
    });
    expect(log.runs[0]!.results).toEqual([]);
    const noVersion = securityFindingsSarif([], { version: null }) as unknown as Log;
    expect(noVersion.runs[0]!.tool.driver.version).toBeUndefined();
  });

  it('maps severity to level, file and lines to a location, and keys a result by finding id', () => {
    const log = sarif([
      {
        id: 'F-12',
        verdict: 'confirmed',
        severity: 'critical',
        state: 'open',
        urgent: true,
        title: 'SQL injection in /api/users',
        category: 'sql-injection',
        cwe: 'CWE-89',
        file: 'src/routes/users.ts',
        line: 41,
        lineEnd: 44,
        verdictSource: 'runtime',
      },
      {
        id: 'F-13',
        verdict: 'confirmed',
        severity: 'medium',
        state: 'open',
        title: 'Open redirect',
        category: 'open-redirect',
        file: 'src/a b.ts',
        line: 0,
      },
      {
        id: 'F-14',
        verdict: 'needs_validation',
        severity: null,
        state: 'open',
        title: 'Possible SSRF',
        category: 'ssrf',
        file: null,
      },
    ]);
    const [critical, medium, lead] = log.runs[0]!.results;
    expect(critical).toEqual({
      ruleId: 'sql-injection',
      level: 'error',
      message: { text: 'F-12: SQL injection in /api/users' },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'src/routes/users.ts', uriBaseId: '%SRCROOT%' },
            region: { startLine: 41, endLine: 44 },
          },
        },
      ],
      partialFingerprints: { 'voidFinding/v1': 'F-12' },
      properties: {
        id: 'F-12',
        severity: 'critical',
        verdict: 'confirmed (runtime)',
        state: 'open',
        urgent: true,
        cwe: 'CWE-89',
      },
    });
    // No line: a file location only. Path segments are URI-encoded.
    expect(medium!.level).toBe('warning');
    expect(medium!.locations).toEqual([
      { physicalLocation: { artifactLocation: { uri: 'src/a%20b.ts', uriBaseId: '%SRCROOT%' } } },
    ]);
    expect(lead).toMatchObject({ level: 'note', properties: { verdict: 'lead' } });
    expect(lead!.locations).toBeUndefined();
  });

  it('marks a resolved finding as suppressed with its reason', () => {
    const [result] = sarif([
      {
        id: 'F-3',
        verdict: 'confirmed',
        severity: 'high',
        state: 'resolved',
        resolution: 'accepted_risk',
        title: 'Weak hash',
        category: 'crypto',
      },
    ]).runs[0]!.results;
    expect(result!.suppressions).toEqual([
      { kind: 'external', status: 'accepted', justification: 'accepted risk' },
    ]);
  });

  it('gives a reader finding a generic rule and message, with no details', () => {
    const [result] = sarif([{ id: 'F-7', verdict: 'confirmed', severity: 'high', state: 'open' }])
      .runs[0]!.results;
    expect(result).toMatchObject({
      ruleId: 'finding',
      level: 'error',
      message: { text: 'F-7: high finding. Ask a project collaborator for the details.' },
    });
  });

  it('lists each category once with its highest security-severity and CWEs', () => {
    const log = sarif([
      {
        id: 'F-1',
        verdict: 'confirmed',
        severity: 'medium',
        state: 'open',
        title: 'a',
        category: 'secret-in-output',
        cwe: 'CWE-798',
      },
      {
        id: 'F-2',
        verdict: 'confirmed',
        severity: 'high',
        state: 'open',
        title: 'b',
        category: 'secret-in-output',
        cwe: 'CWE-200',
      },
      {
        id: 'F-3',
        verdict: 'needs_validation',
        severity: null,
        state: 'open',
        title: 'c',
        category: 'ai-reviewer-text',
      },
    ]);
    expect(log.runs[0]!.tool.driver.rules).toEqual([
      {
        id: 'secret-in-output',
        shortDescription: { text: 'secret in output' },
        properties: { tags: ['security', 'CWE-798', 'CWE-200'], 'security-severity': '8.0' },
      },
      {
        id: 'ai-reviewer-text',
        shortDescription: { text: 'ai reviewer text' },
        properties: { tags: ['security'] },
      },
    ]);
  });

  it('keys findings of several projects apart, and strips control characters', () => {
    const log = sarif([
      {
        id: 'F-1',
        project: 'acme-web',
        verdict: 'confirmed',
        severity: 'low',
        state: 'open',
        title: 'x\u001b[31m\ny',
      },
      {
        id: 'F-1',
        project: 'acme-api',
        verdict: 'confirmed',
        severity: 'low',
        state: 'open',
        title: 'z',
      },
    ]);
    const [web, api] = log.runs[0]!.results;
    expect(web!.partialFingerprints).toEqual({ 'voidFinding/v1': 'acme-web/F-1' });
    expect(api!.partialFingerprints).toEqual({ 'voidFinding/v1': 'acme-api/F-1' });
    expect(web!.properties.project).toBe('acme-web');
    expect(web!.message.text).toBe('F-1: x y');
  });
});
