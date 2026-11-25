import { describe, expect, test } from 'vite-plus/test';
import { SecurityScannerError } from '../../src/provisioning/security-scanner.ts';
import type { SelfTestResult } from '../../src/security-scanner-controller-runtime.ts';
import {
  judgeSelfTest,
  SECURITY_PROBE_COPY,
  securityProvisionMessage,
} from '../../src/security/probe.ts';

/** What a passing controller self-test reports for `probeId`. */
const PASSING_REPORT = (probeId: string) => ({
  selfTest: 1,
  uid: 999,
  node: 'v24.0.0',
  model: { ok: true, status: 200, probe: probeId, ms: 3 },
  egress: {
    httpExample: { blocked: true, ms: 2, status: 403 },
    httpsExample: { blocked: true, ms: 1, error: 'ECONNRESET' },
    httpsBareIp: { blocked: true, ms: 1, error: 'ECONNRESET' },
    httpUnknownHost: { blocked: true, ms: 2, status: 403 },
  },
  envSuspicious: [],
});

describe('securityProvisionMessage', () => {
  test('gives the plan and token copy only to plan and token problems', () => {
    for (const kind of ['containers_unavailable', 'application', 'upload'] as const) {
      expect(securityProvisionMessage(new SecurityScannerError(kind, 'x'))).toBe(
        SECURITY_PROBE_COPY.container,
      );
    }
    expect(securityProvisionMessage(new Error('network'))).toBe(SECURITY_PROBE_COPY.container);
    for (const kind of ['ownership', 'outdated', 'missing', 'gate'] as const) {
      const message = `the ${kind} problem`;
      expect(securityProvisionMessage(new SecurityScannerError(kind, message))).toBe(message);
    }
  });
});

describe('judgeSelfTest', () => {
  const passing = (probeId: string): SelfTestResult => ({
    started: true,
    coldStartMs: 1,
    report: PASSING_REPORT(probeId),
  });

  test('passes a non-root self-test that saw this probe id and no internet', () => {
    expect(judgeSelfTest(passing('pr_1'), 'pr_1')).toEqual({
      container: { ok: true },
      egress: { ok: true },
    });
  });

  test('fails egress for another probe id, a token-like env name or no targets', () => {
    expect(judgeSelfTest(passing('pr_other'), 'pr_1').egress.ok).toBe(false);
    const report = PASSING_REPORT('pr_1');
    expect(
      judgeSelfTest(
        { ...passing('pr_1'), report: { ...report, envSuspicious: ['CF_API_TOKEN'] } },
        'pr_1',
      ).egress,
    ).toEqual({ ok: false, detail: 'credential-like env names: CF_API_TOKEN' });
    expect(
      judgeSelfTest({ ...passing('pr_1'), report: { ...report, egress: {} } }, 'pr_1').egress.ok,
    ).toBe(false);
  });
});
