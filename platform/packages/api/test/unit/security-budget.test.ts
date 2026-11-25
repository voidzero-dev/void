import { defaultSecurityBudgets } from '@void/platform/security-policy';
import type { SecurityPolicyBudgets } from '@void/platform/security-policy';
import { describe, expect, it } from 'vite-plus/test';
import {
  assertSecurityProjectCapAllowed,
  formatSecurityUsd,
  securityBudgetResetLabel,
  securityBudgetThresholds,
  securityEffectiveProjectCapCents,
  securityNextSpendMonth,
  securityPlatformCapCents,
  securityProjectCeiling,
  securityProjectCeilingCents,
  securityScanReserveNano,
  securitySpendCaps,
  securitySpendMonth,
} from '../../src/security/budget.ts';
import {
  admitModelCall,
  forgetModelCalls,
  readModelCallFailure,
  recordModelCallFailure,
  refillRateBucket,
  SECURITY_CF_CALLS_PER_MINUTE,
  SECURITY_SESSION_CALL_LIMIT,
} from '../../src/security/call-ledger.ts';
import { SecurityApiError } from '../../src/security/errors.ts';
import { memoryDurableStorage } from '../helpers/memory-storage.ts';

function budgets(overrides: Partial<SecurityPolicyBudgets> = {}): SecurityPolicyBudgets {
  return { ...defaultSecurityBudgets(), ...overrides };
}

const none = { monthlyCapCents: null, capCeilingCents: null, planCap: 'inherit' } as const;
const ACME = { id: 'proj_acme', slug: 'acme-web' } as const;

describe('who sets what (spec §16.2)', () => {
  // ceiling(p) = admin limit, else the default amount while project caps are on, else none;
  // effective(p) = the lower of the ceiling and the project's own cap.
  it.each([
    ['caps off, nothing set', budgets(), none, null, null],
    ['caps off, own self-limit', budgets(), { ...none, monthlyCapCents: 4000 }, null, 4000],
    ['caps on, default only', budgets({ projectCapsOn: true }), none, 10_000, 10_000],
    [
      'caps on, own cap lower',
      budgets({ projectCapsOn: true }),
      { ...none, monthlyCapCents: 4000 },
      10_000,
      4000,
    ],
    [
      'caps on, admin limit above the default',
      budgets({ projectCapsOn: true }),
      { ...none, capCeilingCents: 15_000 },
      15_000,
      15_000,
    ],
    [
      'caps off, admin limit, own cap higher',
      budgets(),
      { ...none, monthlyCapCents: 20_000, capCeilingCents: 15_000 },
      15_000,
      15_000,
    ],
    [
      'caps on, $0 own cap = no scans',
      budgets({ projectCapsOn: true }),
      { ...none, monthlyCapCents: 0 },
      10_000,
      0,
    ],
  ])('%s', (_label, policy, settings, ceiling, effective) => {
    expect(securityProjectCeilingCents(settings, policy)).toBe(ceiling);
    expect(securityEffectiveProjectCapCents(settings, policy)).toBe(effective);
  });

  // M27: ceiling order is the project limit, then the plan cap, then the policy default.
  it.each([
    ['plan cap with project caps off', budgets(), { ...none, planCap: 5000 }, 5000, 'plan', 5000],
    [
      'plan cap below the default',
      budgets({ projectCapsOn: true }),
      { ...none, planCap: 5000 },
      5000,
      'plan',
      5000,
    ],
    [
      'plan cap above the default',
      budgets({ projectCapsOn: true }),
      { ...none, planCap: 50_000 },
      50_000,
      'plan',
      50_000,
    ],
    [
      'plan with no cap overrides the default',
      budgets({ projectCapsOn: true }),
      { ...none, planCap: 'none' as const },
      null,
      null,
      null,
    ],
    [
      'plan with no cap still takes the own cap',
      budgets({ projectCapsOn: true }),
      { ...none, planCap: 'none' as const, monthlyCapCents: 700 },
      null,
      null,
      700,
    ],
    [
      'project limit wins over the plan cap',
      budgets({ projectCapsOn: true }),
      { ...none, planCap: 5000, capCeilingCents: 20_000 },
      20_000,
      'project',
      20_000,
    ],
    [
      'own cap lower than the plan cap',
      budgets(),
      { ...none, planCap: 5000, monthlyCapCents: 1000 },
      5000,
      'plan',
      1000,
    ],
    [
      'a $0 plan cap = no scans',
      budgets(),
      { ...none, planCap: 0, monthlyCapCents: 1000 },
      0,
      'plan',
      0,
    ],
    [
      'inherit falls back to the default',
      budgets({ projectCapsOn: true }),
      none,
      10_000,
      'default',
      10_000,
    ],
  ])('%s', (_label, policy, settings, ceiling, source, effective) => {
    expect(securityProjectCeiling(settings, policy)).toEqual(
      ceiling === null ? null : { cents: ceiling, source },
    );
    expect(securityProjectCeilingCents(settings, policy)).toBe(ceiling);
    expect(securityEffectiveProjectCapCents(settings, policy)).toBe(effective);
    expect(securitySpendCaps(settings, policy).projectNano).toBe(
      effective === null ? null : effective * 10_000_000,
    );
  });

  it('turns the platform cap on and off and gives both caps in nano-dollars', () => {
    expect(securityPlatformCapCents(budgets())).toBeNull();
    expect(
      securityPlatformCapCents(budgets({ platformCapOn: true, platformMonthlyUsd: 1000 })),
    ).toBe(100_000);
    expect(
      securitySpendCaps(
        { ...none, monthlyCapCents: 4000 },
        budgets({ platformCapOn: true, platformMonthlyUsd: 1000.5 }),
      ),
    ).toEqual({ projectNano: 40_000_000_000, platformNano: 1_000_500_000_000 });
  });

  it('refuses a project cap above the ceiling with the operator command (edge #49)', () => {
    const ceiling = { cents: 10_000, source: 'default' } as const;
    expect(() => assertSecurityProjectCapAllowed(10_000, ceiling, ACME)).not.toThrow();
    expect(() => assertSecurityProjectCapAllowed(15_000, null, ACME)).not.toThrow();
    expect(() => assertSecurityProjectCapAllowed(null, ceiling, ACME)).not.toThrow();
    let error: unknown;
    try {
      assertSecurityProjectCapAllowed(15_000, ceiling, ACME);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecurityApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'security budget above platform limit',
      message:
        'The platform limits each project to $100.00 / month. Ask your platform admin to raise it for acme-web: void platform security budget --project proj_acme --usd 150',
      details: { ceilingUsd: 100 },
    });
  });

  it('says "this project" for a limit set on this project alone', () => {
    expect(() =>
      assertSecurityProjectCapAllowed(2500, { cents: 1000, source: 'project' }, ACME),
    ).toThrow(
      'The platform limits this project to $10.00 / month. Ask your platform admin to raise it for acme-web: void platform security budget --project proj_acme --usd 25',
    );
  });

  it('names the plan when the ceiling comes from the plan cap (M27)', () => {
    expect(() =>
      assertSecurityProjectCapAllowed(15_000, { cents: 5000, source: 'plan' }, ACME),
    ).toThrow(
      "This project's plan limits it to $50.00 / month. Ask your platform admin to raise it for acme-web: void platform security budget --project proj_acme --usd 150",
    );
  });

  it('formats USD amounts for copy', () => {
    expect(formatSecurityUsd(0)).toBe('$0.00');
    expect(formatSecurityUsd(801_400_000_000)).toBe('$801.40');
    expect(formatSecurityUsd(100_000_000_000_000)).toBe('$100,000.00');
  });
});

describe('month math (UTC calendar month)', () => {
  it('counts in the UTC month, not the local one, across midnight on the 1st (edge #52)', () => {
    expect(securitySpendMonth(Date.parse('2026-11-30T23:59:59.999Z'))).toBe('2026-11-01');
    expect(securitySpendMonth(Date.parse('2026-12-01T00:00:00.000Z'))).toBe('2026-12-01');
    expect(securitySpendMonth(Date.parse('2026-12-01T01:00:00.000+05:00'))).toBe('2026-11-01');
  });

  it('names the next reset', () => {
    expect(securityNextSpendMonth('2026-11-01')).toBe('2026-12-01');
    expect(securityNextSpendMonth('2026-12-01')).toBe('2027-01-01');
    expect(securityBudgetResetLabel(Date.parse('2026-11-18T12:00:00Z'))).toBe('Dec 1');
    expect(securityBudgetResetLabel(Date.parse('2026-12-31T23:00:00Z'))).toBe('Jan 1');
  });
});

describe('alerts and reserves', () => {
  it('reports 80% and 100% of a cap', () => {
    const cap = 100_000_000_000; // $100
    expect(securityBudgetThresholds(79_990_000_000, cap)).toEqual([]);
    expect(securityBudgetThresholds(80_000_000_000, cap)).toEqual([80]);
    expect(securityBudgetThresholds(100_000_000_000, cap)).toEqual([80, 100]);
    expect(securityBudgetThresholds(5, null)).toEqual([]);
    expect(securityBudgetThresholds(5, 0)).toEqual([]);
  });

  it('reserves the worst case of one scan at list price (spec §16.1)', () => {
    const limits = { maxInputTokens: 600_000, maxOutputTokens: 60_000 };
    expect(securityScanReserveNano('@cf/zai-org/glm-5.3', limits)).toBe(1_104_000_000);
    expect(securityScanReserveNano('anthropic/claude-opus-5.5', limits)).toBe(3_600_000_000);
    expect(securityScanReserveNano('anthropic/claude-sonnet-5.5', limits)).toBeNull();
  });
});

function memoryStorage() {
  const { storage, map } = memoryDurableStorage();
  return Object.assign(storage, { data: map });
}

describe('model call ledger (scheduler DO storage)', () => {
  const base = { scanId: 'ss_1', attempt: 1, rateModel: null, now: 0 } as const;

  it('counts calls per session and stops the 41st', async () => {
    const storage = memoryStorage();
    for (let index = 1; index <= SECURITY_SESSION_CALL_LIMIT; index++) {
      await expect(admitModelCall(storage, { ...base, session: 2 })).resolves.toEqual({
        ok: true,
        sessionCalls: index,
      });
    }
    await expect(admitModelCall(storage, { ...base, session: 2 })).resolves.toEqual({
      ok: false,
      reason: 'session_calls',
    });
    // Another session, another attempt and no session are counted apart.
    await expect(admitModelCall(storage, { ...base, session: 3 })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      admitModelCall(storage, { ...base, attempt: 2, session: 2 }),
    ).resolves.toMatchObject({ ok: true, sessionCalls: 1 });
    await expect(admitModelCall(storage, { ...base, session: null })).resolves.toEqual({
      ok: true,
      sessionCalls: null,
    });
  });

  it('allows 10 @cf calls a minute per model and says how long to wait', async () => {
    const storage = memoryStorage();
    const cf = { ...base, session: 1, rateModel: '@cf/zai-org/glm-5.3' };
    for (let index = 0; index < SECURITY_CF_CALLS_PER_MINUTE; index++) {
      await expect(admitModelCall(storage, cf)).resolves.toMatchObject({ ok: true });
    }
    await expect(admitModelCall(storage, cf)).resolves.toEqual({
      ok: false,
      reason: 'rate',
      waitMs: 6000,
    });
    // A refused rate token does not count the session call.
    expect(storage.data.get('call:ss_1:1:session:1')).toBe(10);
    await expect(
      admitModelCall(storage, { ...cf, rateModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(admitModelCall(storage, { ...cf, now: 6000 })).resolves.toMatchObject({
      ok: true,
    });
    expect(refillRateBucket({ tokens: 0, at: 0 }, 600_000)).toEqual({ tokens: 10, at: 600_000 });
  });

  it('keeps the last failure per attempt and forgets an ended attempt', async () => {
    const storage = memoryStorage();
    await admitModelCall(storage, { ...base, session: 0 });
    await recordModelCallFailure(storage, 'ss_1', 1, { reason: 'budget', httpStatus: 429, at: 5 });
    await recordModelCallFailure(storage, 'ss_2', 1, { reason: 'credits', httpStatus: 402, at: 6 });
    await expect(readModelCallFailure(storage, 'ss_1', 1)).resolves.toEqual({
      reason: 'budget',
      httpStatus: 429,
      at: 5,
    });
    await expect(readModelCallFailure(storage, 'ss_1', 2)).resolves.toBeNull();
    await expect(forgetModelCalls(storage, 'ss_1', 1)).resolves.toBe(2);
    await expect(readModelCallFailure(storage, 'ss_1', 1)).resolves.toBeNull();
    await expect(readModelCallFailure(storage, 'ss_2', 1)).resolves.toMatchObject({
      reason: 'credits',
    });
  });
});
