import { describe, expect, test } from 'vite-plus/test';
import {
  apiErrorStatus,
  classifyClaudeResult,
  classifyCodexRun,
  classifyProxyStop,
  outcomeStatus,
  readProxyStopReason,
  safeLabel,
} from '../../src/runner/status.ts';
import type { CodexRunSignal } from '../../src/runner/status.ts';
import { confirmed, report } from '../helpers/findings.ts';

describe('outcomeStatus (spec §8.4)', () => {
  test.each([
    [
      { kind: 'refused', category: 'cyber' },
      { status: 'refused', reason: null, refusalCategory: 'cyber' },
    ],
    [
      { kind: 'bad_output', errorKind: 'shape', message: 'x' },
      { status: 'failed', reason: 'bad_output', errorClass: 'shape' },
    ],
    [
      { kind: 'stopped', reason: 'turns' },
      { status: 'incomplete', reason: 'turn_cap' },
    ],
    [
      { kind: 'stopped', reason: 'session_calls' },
      { status: 'incomplete', reason: 'turn_cap' },
    ],
    [
      { kind: 'stopped', reason: 'scan_calls' },
      { status: 'incomplete', reason: 'call_cap' },
    ],
    [
      { kind: 'stopped', reason: 'tokens' },
      { status: 'incomplete', reason: 'token_cap' },
    ],
    [
      { kind: 'stopped', reason: 'budget' },
      { status: 'incomplete', reason: 'budget' },
    ],
    [{ kind: 'credits' }, { status: 'failed', reason: 'credits' }],
    [
      { kind: 'infrastructure', errorClass: 'model_http_500', detail: 'x' },
      { status: 'failed', reason: 'infrastructure', errorClass: 'model_http_500' },
    ],
    [{ kind: 'aborted' }, { status: 'timed_out', reason: 'wall_clock' }],
  ] as const)('%j', (outcome, expected) => {
    expect(outcomeStatus(outcome)).toMatchObject(expected);
  });
});

describe('proxy stops', () => {
  test('reads only known stop reasons', () => {
    expect(readProxyStopReason(' budget ')).toBe('budget');
    expect(readProxyStopReason('tokens')).toBe('tokens');
    expect(readProxyStopReason('please-continue')).toBeNull();
    expect(readProxyStopReason(null)).toBeNull();
  });

  test('maps a stop header, a bare 402 and other failures', () => {
    expect(classifyProxyStop(429, 'scan_calls')).toEqual({ kind: 'stopped', reason: 'scan_calls' });
    expect(classifyProxyStop(402, null)).toEqual({ kind: 'credits' });
    expect(classifyProxyStop(429, 'credits')).toEqual({ kind: 'credits' });
    expect(classifyProxyStop(500, null)).toBeNull();
  });
});

describe('Engine A (Claude Agent SDK) result mapping', () => {
  test('a valid structured output is submitted', () => {
    const outcome = classifyClaudeResult({
      subtype: 'success',
      structuredOutput: report([confirmed()]),
    });
    expect(outcome.kind).toBe('submitted');
  });

  test('a refusal keeps its category, even on success', () => {
    expect(
      classifyClaudeResult({ subtype: 'success', stopReason: 'refusal', stopCategory: 'cyber' }),
    ).toEqual({ kind: 'refused', category: 'cyber' });
  });

  test('turn cap, structured output retries and other errors', () => {
    expect(classifyClaudeResult({ subtype: 'error_max_turns' })).toEqual({
      kind: 'stopped',
      reason: 'turns',
    });
    expect(classifyClaudeResult({ subtype: 'error_max_structured_output_retries' })).toMatchObject({
      kind: 'bad_output',
    });
    expect(
      classifyClaudeResult({ subtype: 'success', structuredOutput: { bad: 1 } }),
    ).toMatchObject({
      kind: 'bad_output',
      errorKind: 'shape',
    });
    expect(classifyClaudeResult({ subtype: 'error_during_execution' })).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'agent_sdk_error',
    });
  });

  test('an API failure reported as success with is_error is read from its text (spike S2)', () => {
    const failure = (resultText: string) =>
      classifyClaudeResult({ subtype: 'success', isError: true, resultText });
    expect(failure('API Error: 402 Insufficient unified billing credits')).toEqual({
      kind: 'credits',
    });
    expect(failure('API Error: 401 nope')).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'model_http_401',
    });
    expect(failure('something else')).toMatchObject({ errorClass: 'agent_sdk_error' });
    // A report that came with the flag still counts.
    expect(
      classifyClaudeResult({
        subtype: 'success',
        isError: true,
        structuredOutput: report([confirmed()]),
      }).kind,
    ).toBe('submitted');
    expect(apiErrorStatus('API Error: 4')).toBeNull();
    expect(apiErrorStatus(null)).toBeNull();
    expect(apiErrorStatus('x API Error: 529 overloaded')).toBe(529);
  });

  test('a proxy stop wins over the SDK error', () => {
    expect(
      classifyClaudeResult({
        subtype: 'error_during_execution',
        proxyStop: { httpStatus: 429, reason: 'budget' },
      }),
    ).toEqual({ kind: 'stopped', reason: 'budget' });
  });
});

describe('Engine C (Codex SDK) run mapping', () => {
  const base: CodexRunSignal = {
    submitted: null,
    failure: null,
    finalMessage: null,
    exitCode: 0,
    proxyStop: null,
  };

  test('a report the MCP tool refused is bad output, not an outage', () => {
    expect(
      classifyCodexRun({
        ...base,
        rejected: { kind: 'shape', message: '$.findings[0].fix: is required' },
        failure: { message: 'turn failed' },
      }),
    ).toMatchObject({ kind: 'bad_output', errorKind: 'shape' });
  });

  test('a proxy stop is read from the proxy, not from Codex error text', () => {
    expect(
      classifyCodexRun({
        ...base,
        failure: { message: 'stream disconnected' },
        exitCode: 1,
        proxyStop: { httpStatus: 402, reason: null },
      }),
    ).toEqual({ kind: 'credits' });
  });

  test('cyber policy errors are refusals with their code', () => {
    expect(
      classifyCodexRun({
        ...base,
        failure: { code: 'cyber_policy', message: 'blocked' },
        exitCode: 1,
      }),
    ).toEqual({ kind: 'refused', category: 'cyber_policy' });
    expect(
      classifyCodexRun({ ...base, failure: { message: 'needs trusted_access_for_cyber' } }),
    ).toEqual({ kind: 'refused', category: 'trusted_access_for_cyber' });
  });

  test('Codex prints its own cyber policy error with a space (spike S9 C1)', () => {
    expect(
      classifyCodexRun({
        ...base,
        failure: {
          message:
            'cyber policy: This request has been flagged for potentially high-risk cybersecurity activity.',
        },
        exitCode: 1,
      }),
    ).toEqual({ kind: 'refused', category: 'cyber_policy' });
    expect(
      classifyCodexRun({ ...base, failure: { message: 'Trusted-Access-For-Cyber required' } }),
    ).toEqual({ kind: 'refused', category: 'trusted_access_for_cyber' });
    expect(
      classifyCodexRun({ ...base, failure: { message: 'cyber security scan failed' } }).kind,
    ).toBe('infrastructure');
  });

  test('the cyber policy text reads the same with any spacing or in its Debug form', () => {
    for (const message of [
      'cyber  policy: flagged',
      'cyber\npolicy: flagged',
      'CyberPolicy { message: "flagged" }',
      'Cyber_Policy',
    ]) {
      expect(classifyCodexRun({ ...base, failure: { message } }), message).toEqual({
        kind: 'refused',
        category: 'cyber_policy',
      });
    }
    expect(
      classifyCodexRun({ ...base, failure: { message: 'TrustedAccessForCyber required' } }),
    ).toEqual({ kind: 'refused', category: 'trusted_access_for_cyber' });
    expect(
      classifyCodexRun({ ...base, failure: { message: 'policy on cyber attacks' } }).kind,
    ).toBe('infrastructure');
  });

  test('a submitted report wins over a plain final message', () => {
    const validated = classifyClaudeResult({ subtype: 'success', structuredOutput: report([]) });
    if (validated.kind !== 'submitted') {
      throw new Error('fixture');
    }
    expect(
      classifyCodexRun({ ...base, submitted: validated.report, finalMessage: 'Done.' }).kind,
    ).toBe('submitted');
  });

  test('no submit with an empty or plain-text final message is a refusal', () => {
    expect(classifyCodexRun({ ...base, finalMessage: '' })).toEqual({
      kind: 'refused',
      category: null,
    });
    expect(classifyCodexRun({ ...base, finalMessage: "I can't help with that." }).kind).toBe(
      'refused',
    );
  });

  test('a JSON final message is held to the report check', () => {
    expect(classifyCodexRun({ ...base, finalMessage: '{"run_status":"x"}' })).toMatchObject({
      kind: 'bad_output',
    });
    expect(classifyCodexRun({ ...base, finalMessage: '{"run' })).toMatchObject({
      kind: 'bad_output',
      errorKind: 'not_json',
    });
    expect(classifyCodexRun({ ...base, finalMessage: JSON.stringify(report([])) }).kind).toBe(
      'submitted',
    );
  });

  test('a non-policy failure or a non-zero exit is infrastructure', () => {
    expect(classifyCodexRun({ ...base, failure: { message: 'boom' } })).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'codex_turn_failed',
    });
    expect(classifyCodexRun({ ...base, exitCode: 2 })).toMatchObject({
      kind: 'infrastructure',
      errorClass: 'codex_exit',
    });
  });
});

describe('safeLabel', () => {
  test('cuts and replaces control characters', () => {
    expect(safeLabel('a\u0007b')).toBe('a?b');
    expect(safeLabel('x'.repeat(100))).toHaveLength(80);
  });
});
