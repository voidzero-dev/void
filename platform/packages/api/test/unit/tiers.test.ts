import { describe, it, expect, vi } from 'vite-plus/test';
import {
  PLAN_LIMITS,
  STATIC_RETENTION_LIMIT,
  getPlanLimits,
  isWithinLimit,
  getCurrentBillingPeriodStart,
} from '../../src/tiers.ts';
import type { PlanId } from '../../src/tiers.ts';

describe('PLAN_LIMITS', () => {
  it('defines all five tiers', () => {
    const tiers: Array<PlanId> = ['free', 'solo', 'pro', 'sponsored', 'custom'];
    for (const tier of tiers) {
      expect(PLAN_LIMITS[tier]).toBeDefined();
    }
  });

  it('free tier has expected limits', () => {
    const free = PLAN_LIMITS.free;
    expect(free.requestsPerMonth).toBe(3_000_000);
    expect(free.cpuMsPerRequest).toBe(10);
    expect(free.subRequestsPerInvocation).toBe(50);
    expect(free.deploysPerDay).toBe(100);
    expect(free.d1StorageBytes).toBe(1024 * 1024 * 1024);
    expect(free.r2StorageBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(free.kvStorageBytes).toBe(1024 * 1024 * 1024);
  });

  it('custom tier has all limits set to 0 (unlimited)', () => {
    const custom = PLAN_LIMITS.custom;
    for (const value of Object.values(custom)) {
      expect(value).toBe(0);
    }
  });

  it('sponsored tier has unlimited requests, deploys, and storage', () => {
    const sponsored = PLAN_LIMITS.sponsored;
    expect(sponsored.requestsPerMonth).toBe(0);
    expect(sponsored.deploysPerDay).toBe(0);
    expect(sponsored.d1StorageBytes).toBe(0);
    expect(sponsored.r2StorageBytes).toBe(0);
    expect(sponsored.kvStorageBytes).toBe(0);
  });

  it('paid tiers have higher limits than free', () => {
    expect(PLAN_LIMITS.solo.requestsPerMonth).toBeGreaterThan(PLAN_LIMITS.free.requestsPerMonth);
    expect(PLAN_LIMITS.pro.requestsPerMonth).toBeGreaterThan(PLAN_LIMITS.solo.requestsPerMonth);
    expect(PLAN_LIMITS.solo.cpuMsPerRequest).toBeGreaterThan(PLAN_LIMITS.free.cpuMsPerRequest);
    expect(PLAN_LIMITS.pro.deploysPerDay).toBeGreaterThan(PLAN_LIMITS.solo.deploysPerDay);
  });

  it('solo tier sandbox runtime is 30 hours', () => {
    expect(PLAN_LIMITS.solo.sandboxRuntimeSecondsPerMonth).toBe(30 * 3600);
  });

  it('solo tier sandbox concurrency is 2', () => {
    expect(PLAN_LIMITS.solo.sandboxMaxConcurrentInstances).toBe(2);
  });

  it('pro tier sandbox runtime is 200 hours', () => {
    expect(PLAN_LIMITS.pro.sandboxRuntimeSecondsPerMonth).toBe(200 * 3600);
  });

  it('pro tier sandbox concurrency is 10', () => {
    expect(PLAN_LIMITS.pro.sandboxMaxConcurrentInstances).toBe(10);
  });

  it('sponsored tier sandbox limits are unlimited (0)', () => {
    expect(PLAN_LIMITS.sponsored.sandboxRuntimeSecondsPerMonth).toBe(0);
    expect(PLAN_LIMITS.sponsored.sandboxMaxConcurrentInstances).toBe(0);
  });

  it('free tier sandbox is effectively disabled (non-zero finite limit)', () => {
    // 0 would mean "unlimited" by the shared isWithinLimit convention, so
    // we use a tiny finite limit to ensure any real sandbox use is rejected.
    expect(PLAN_LIMITS.free.sandboxRuntimeSecondsPerMonth).toBeGreaterThan(0);
    expect(PLAN_LIMITS.free.sandboxRuntimeSecondsPerMonth).toBeLessThan(
      PLAN_LIMITS.solo.sandboxRuntimeSecondsPerMonth,
    );
  });

  it('defines build concurrency limits per tier', () => {
    expect(PLAN_LIMITS.free.concurrentBuilds).toBe(1);
    expect(PLAN_LIMITS.solo.concurrentBuilds).toBe(2);
    expect(PLAN_LIMITS.pro.concurrentBuilds).toBe(3);
    expect(PLAN_LIMITS.sponsored.concurrentBuilds).toBe(6);
    // 0 = unlimited by the shared isWithinLimit convention.
    expect(PLAN_LIMITS.custom.concurrentBuilds).toBe(0);
  });

  it('defines the manifest cpuMs ceiling per tier', () => {
    expect(PLAN_LIMITS.free.maxCpuMsPerRequest).toBe(10);
    expect(PLAN_LIMITS.solo.maxCpuMsPerRequest).toBe(30_000);
    expect(PLAN_LIMITS.pro.maxCpuMsPerRequest).toBe(30_000);
    expect(PLAN_LIMITS.sponsored.maxCpuMsPerRequest).toBe(30_000);
    // 0 = no ceiling by the shared PlanLimits convention.
    expect(PLAN_LIMITS.custom.maxCpuMsPerRequest).toBe(0);
  });

  it('defines build timeout minutes per tier', () => {
    expect(PLAN_LIMITS.free.buildTimeoutMinutes).toBe(10);
    expect(PLAN_LIMITS.solo.buildTimeoutMinutes).toBe(15);
    expect(PLAN_LIMITS.pro.buildTimeoutMinutes).toBe(15);
    expect(PLAN_LIMITS.sponsored.buildTimeoutMinutes).toBe(20);
    // 0 = unlimited by the shared isWithinLimit convention.
    expect(PLAN_LIMITS.custom.buildTimeoutMinutes).toBe(0);
  });
});

describe('getPlanLimits', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'uses free limits for inherited name %s',
    (plan) => {
      expect(getPlanLimits(plan)).toBe(PLAN_LIMITS.free);
    },
  );

  it('returns correct limits for known plans', () => {
    expect(getPlanLimits('free')).toBe(PLAN_LIMITS.free);
    expect(getPlanLimits('solo')).toBe(PLAN_LIMITS.solo);
    expect(getPlanLimits('pro')).toBe(PLAN_LIMITS.pro);
    expect(getPlanLimits('sponsored')).toBe(PLAN_LIMITS.sponsored);
    expect(getPlanLimits('custom')).toBe(PLAN_LIMITS.custom);
  });

  it('returns free tier limits for unknown plans', () => {
    expect(getPlanLimits('unknown')).toBe(PLAN_LIMITS.free);
    expect(getPlanLimits('')).toBe(PLAN_LIMITS.free);
  });
});

describe('isWithinLimit', () => {
  it('returns true when limit is 0 (unlimited)', () => {
    expect(isWithinLimit(0, 999_999_999)).toBe(true);
  });

  it('returns true when current is below limit', () => {
    expect(isWithinLimit(100, 50)).toBe(true);
  });

  it('returns false when current meets or exceeds limit', () => {
    expect(isWithinLimit(100, 100)).toBe(false);
    expect(isWithinLimit(100, 200)).toBe(false);
  });

  it('returns true when current is 0', () => {
    expect(isWithinLimit(100, 0)).toBe(true);
  });
});

describe('getCurrentBillingPeriodStart', () => {
  it('returns current month when today is past the anniversary day', () => {
    // Signup on the 5th, today is the 18th → period starts on the 5th of this month
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T12:00:00Z'));

    const result = getCurrentBillingPeriodStart('2025-10-05T14:30:00Z');
    expect(result).toEqual(new Date('2026-02-05T00:00:00Z'));

    vi.useRealTimers();
  });

  it('returns previous month when today is before the anniversary day', () => {
    // Signup on the 25th, today is the 10th → period starts on the 25th of last month
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));

    const result = getCurrentBillingPeriodStart('2025-11-25T08:00:00Z');
    expect(result).toEqual(new Date('2026-02-25T00:00:00Z'));

    vi.useRealTimers();
  });

  it('clamps to last day of month for short months (31st → Feb 28)', () => {
    // Signup on Jan 31, today is Feb 18 → Feb only has 28 days → period starts Feb 28
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-02-18T12:00:00Z'));

    const result = getCurrentBillingPeriodStart('2026-01-31T10:00:00Z');
    // Feb 2027 has 28 days, today (18th) < 28th → falls back to Jan 31
    expect(result).toEqual(new Date('2027-01-31T00:00:00Z'));

    vi.useRealTimers();
  });

  it('clamps to last day of month (31st → Apr 30)', () => {
    // Signup on the 31st, today is May 5 → April has 30 days → period starts Apr 30
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));

    const result = getCurrentBillingPeriodStart('2025-12-31T10:00:00Z');
    expect(result).toEqual(new Date('2026-04-30T00:00:00Z'));

    vi.useRealTimers();
  });

  it('handles first billing period (signup was this month)', () => {
    // Signup on Feb 3, today is Feb 18 → period starts on Feb 3
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-18T12:00:00Z'));

    const result = getCurrentBillingPeriodStart('2026-02-03T09:00:00Z');
    expect(result).toEqual(new Date('2026-02-03T00:00:00Z'));

    vi.useRealTimers();
  });

  it("returns today's date when anniversary is today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-15T18:00:00Z'));

    const result = getCurrentBillingPeriodStart('2025-06-15T10:00:00Z');
    expect(result).toEqual(new Date('2026-02-15T00:00:00Z'));

    vi.useRealTimers();
  });

  it('falls back to current date for null input', () => {
    const before = Date.now();
    const result = getCurrentBillingPeriodStart(null);
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('falls back to current date for empty string', () => {
    const before = Date.now();
    const result = getCurrentBillingPeriodStart('');
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('falls back to current date for invalid date string', () => {
    const before = Date.now();
    const result = getCurrentBillingPeriodStart('not-a-date');
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('STATIC_RETENTION_LIMIT', () => {
  it('is 100 for all tiers', () => {
    expect(STATIC_RETENTION_LIMIT).toBe(100);
  });
});
