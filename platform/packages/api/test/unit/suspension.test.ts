import { describe, it, expect } from 'vite-plus/test';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
  routingSuspensionReason,
} from '../../src/suspension.ts';
import { evaluateRequestLimit, evaluateAiLimit } from '../../src/usage-counter.ts';
import type { CounterState } from '../../src/usage-counter.ts';

describe('isAdminSuspended', () => {
  it('distinguishes usage limits from administrator suspensions', () => {
    expect(isAdminSuspended(null)).toBe(false);
    expect(isAdminSuspended(REASON_REQUESTS_EXCEEDED)).toBe(false);
    expect(isAdminSuspended(REASON_SANDBOX_RUNTIME_EXCEEDED)).toBe(false);
    expect(isAdminSuspended('admin_suspended')).toBe(true);
    expect(isAdminSuspended('abuse')).toBe(true);
  });
});

describe('routingSuspensionReason', () => {
  it('blocks app traffic only for request limits and administrator suspensions', () => {
    expect(routingSuspensionReason(null)).toBeNull();
    expect(routingSuspensionReason(REASON_REQUESTS_EXCEEDED)).toBe(REASON_REQUESTS_EXCEEDED);
    expect(routingSuspensionReason(REASON_SANDBOX_RUNTIME_EXCEEDED)).toBeNull();
    expect(routingSuspensionReason('admin_suspended')).toBe('admin_suspended');
  });
});

describe('evaluateRequestLimit (real implementation)', () => {
  function makeState(overrides: Partial<CounterState> = {}): CounterState {
    return {
      ownerUserId: 'u1',
      totalRequests: 0,
      totalNeurons: 0,
      totalSandboxSeconds: 0,
      plan: 'free',
      billingPeriodStart: new Date().toISOString(),
      requestsSuspended: false,
      aiSuspended: false,
      sandboxRuntimeSuspended: false,
      projectSlugs: {},
      projectOwnershipStarts: {},
      projectNeurons: {},
      historicalNeurons: 0,
      historicalAiWindows: {},
      ...overrides,
    };
  }

  it('returns false when under the limit', () => {
    const state = makeState({ totalRequests: 50_000 });
    expect(evaluateRequestLimit(state, 1)).toBe(false);
  });

  it('returns true when exceeding the limit', () => {
    // free plan has 3_000_000 requests/month
    const state = makeState({ totalRequests: 3_000_000 });
    expect(evaluateRequestLimit(state, 1)).toBe(true);
  });

  it('accounts for incoming requests in the check', () => {
    // limit is strictly less-than: 2_999_999 + 1 = 3_000_000 which equals limit → exceeds
    const state = makeState({ totalRequests: 2_999_998 });
    expect(evaluateRequestLimit(state, 1)).toBe(false); // 2_999_999 < 3_000_000
    expect(evaluateRequestLimit(state, 2)).toBe(true); // 3_000_000 >= 3_000_000
  });
});

describe('evaluateAiLimit (real implementation)', () => {
  function makeState(overrides: Partial<CounterState> = {}): CounterState {
    return {
      ownerUserId: 'u1',
      totalRequests: 0,
      totalNeurons: 0,
      totalSandboxSeconds: 0,
      plan: 'free',
      billingPeriodStart: new Date().toISOString(),
      requestsSuspended: false,
      aiSuspended: false,
      sandboxRuntimeSuspended: false,
      projectSlugs: {},
      projectOwnershipStarts: {},
      projectNeurons: {},
      historicalNeurons: 0,
      historicalAiWindows: {},
      ...overrides,
    };
  }

  it('returns false when under the AI limit', () => {
    const state = makeState({ totalNeurons: 1000 });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns true when exceeding the AI limit', () => {
    // free plan has 100_000 neurons/month
    const state = makeState({ totalNeurons: 100_001 });
    expect(evaluateAiLimit(state)).toBe(true);
  });
});
