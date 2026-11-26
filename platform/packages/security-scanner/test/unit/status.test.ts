import { describe, expect, test } from 'vite-plus/test';
import { classifyCodexRun, outcomeStatus } from '../../src/runner/status.ts';
import type { CodexRunSignal } from '../../src/runner/status.ts';

describe('refusal and failure mapping (spec §8.4)', () => {
  test.each([
    [
      { kind: 'refused', category: 'cyber' },
      { status: 'refused', refusalCategory: 'cyber' },
    ],
    [{ kind: 'credits' }, { status: 'failed', reason: 'credits' }],
    [
      { kind: 'stopped', reason: 'budget' },
      { status: 'incomplete', reason: 'budget' },
    ],
    [{ kind: 'aborted' }, { status: 'timed_out', reason: 'wall_clock' }],
  ] as const)('outcome %j', (outcome, expected) => {
    expect(outcomeStatus(outcome)).toMatchObject(expected);
  });

  const base: CodexRunSignal = {
    submitted: null,
    failure: null,
    finalMessage: null,
    exitCode: 0,
    proxyStop: null,
  };

  test('Engine C: the cyber policy text in any spelling is a refusal (spike S9 C1)', () => {
    for (const message of [
      'cyber policy: This request has been flagged for potentially high-risk cybersecurity activity.',
      'cyber\npolicy: flagged',
      'CyberPolicy { message: "flagged" }',
      'Cyber_Policy',
    ]) {
      expect(classifyCodexRun({ ...base, failure: { message }, exitCode: 1 }), message).toEqual({
        kind: 'refused',
        category: 'cyber_policy',
      });
    }
    expect(
      classifyCodexRun({ ...base, failure: { message: 'Trusted-Access-For-Cyber required' } }),
    ).toEqual({ kind: 'refused', category: 'trusted_access_for_cyber' });
    for (const message of ['cyber security scan failed', 'policy on cyber attacks']) {
      expect(classifyCodexRun({ ...base, failure: { message } }).kind).toBe('infrastructure');
    }
  });

  test('Engine C: no report and a plain final message is a refusal; 402 comes from the proxy', () => {
    expect(classifyCodexRun({ ...base, finalMessage: "I can't help with that." })).toEqual({
      kind: 'refused',
      category: null,
    });
    expect(
      classifyCodexRun({
        ...base,
        failure: { message: 'stream disconnected' },
        exitCode: 1,
        proxyStop: { httpStatus: 402, reason: null },
      }),
    ).toEqual({ kind: 'credits' });
  });
});
