import { expect, test } from 'vite-plus/test';
import type { SelfTestResult } from '../../src/security-scanner-controller-runtime.ts';
import { judgeSelfTest } from '../../src/security/probe.ts';

// I2: the self-test passes only when the container saw this probe, had no internet and no credential.
test('judgeSelfTest passes a container with no internet and fails one that leaks', () => {
  const blocked = { blocked: true, ms: 1, status: 403 };
  const report = {
    selfTest: 1,
    uid: 999,
    node: 'v24.0.0',
    model: { ok: true, status: 200, probe: 'pr_1', ms: 3 },
    egress: { httpExample: blocked, httpsExample: blocked, httpsBareIp: blocked },
    envSuspicious: [] as Array<string>,
  };
  const run = (patch: Record<string, unknown>): SelfTestResult => ({
    started: true,
    coldStartMs: 1,
    report: { ...report, ...patch },
  });
  expect(judgeSelfTest(run({}), 'pr_1')).toEqual({ container: { ok: true }, egress: { ok: true } });
  expect(judgeSelfTest(run({}), 'pr_other').egress.ok).toBe(false);
  expect(judgeSelfTest(run({ envSuspicious: ['CF_API_TOKEN'] }), 'pr_1').egress.ok).toBe(false);
  expect(judgeSelfTest(run({ egress: {} }), 'pr_1').egress.ok).toBe(false);
  const open = { ...report.egress, httpsExample: { blocked: false, ms: 1, status: 200 } };
  expect(judgeSelfTest(run({ egress: open }), 'pr_1').egress.ok).toBe(false);
});
