import { defaultSecurityBudgets } from '@void/platform/security-policy';
import type { SecurityPolicyBudgets } from '@void/platform/security-policy';
import { expect, it } from 'vite-plus/test';
import {
  securityEffectiveProjectCapCents,
  securityProjectCeiling,
  securityScanReserveNano,
  securitySpendCaps,
} from '../../src/security/budget.ts';
import {
  admitModelCall,
  SECURITY_CF_CALLS_PER_MINUTE,
  SECURITY_SESSION_CALL_LIMIT,
} from '../../src/security/call-ledger.ts';
import { memoryDurableStorage } from '../helpers/memory-storage.ts';

function budgets(overrides: Partial<SecurityPolicyBudgets> = {}): SecurityPolicyBudgets {
  return { ...defaultSecurityBudgets(), ...overrides };
}

const none = { monthlyCapCents: null, capCeilingCents: null, planCap: 'inherit' } as const;
const capsOn = budgets({ projectCapsOn: true });

// I7: the ceiling is the project limit, then the plan cap, then the default; the own cap only lowers it.
it.each([
  ['caps off, nothing set', budgets(), none, null, null],
  ['caps on, own cap lower', capsOn, { ...none, monthlyCapCents: 4000 }, 'default', 4000],
  ['plan cap with project caps off', budgets(), { ...none, planCap: 5000 }, 'plan', 5000],
  ['plan with no cap', capsOn, { ...none, planCap: 'none' as const }, null, null],
  [
    'project limit wins over the plan cap',
    capsOn,
    { ...none, planCap: 5000, capCeilingCents: 20_000 },
    'project',
    20_000,
  ],
  ['a $0 plan cap = no scans', budgets(), { ...none, planCap: 0 }, 'plan', 0],
])('caps: %s', (_label, policy, settings, source, effective) => {
  expect(securityProjectCeiling(settings, policy)?.source ?? null).toBe(source);
  expect(securityEffectiveProjectCapCents(settings, policy)).toBe(effective);
  expect(securitySpendCaps(settings, policy).projectNano).toBe(
    effective === null ? null : effective * 10_000_000,
  );
});

it('reserves the worst case of one scan at list price (spec §16.1)', () => {
  const limits = { maxInputTokens: 600_000, maxOutputTokens: 60_000 };
  expect(securityScanReserveNano('anthropic/claude-opus-5.5', limits)).toBe(3_600_000_000);
  expect(securityScanReserveNano('anthropic/claude-sonnet-5.5', limits)).toBeNull();
});

it('stops the 41st call of a session and rate-limits @cf calls per model', async () => {
  const { storage } = memoryDurableStorage();
  const base = { scanId: 'ss_1', attempt: 1, rateModel: null, now: 0, session: 2 } as const;
  for (let index = 1; index <= SECURITY_SESSION_CALL_LIMIT; index++) {
    await expect(admitModelCall(storage, base)).resolves.toEqual({ ok: true, sessionCalls: index });
  }
  await expect(admitModelCall(storage, base)).resolves.toEqual({
    ok: false,
    reason: 'session_calls',
  });
  await expect(admitModelCall(storage, { ...base, attempt: 2 })).resolves.toMatchObject({
    sessionCalls: 1,
  });

  const cf = { ...base, session: 1, rateModel: '@cf/zai-org/glm-5.3' };
  for (let index = 0; index < SECURITY_CF_CALLS_PER_MINUTE; index++) {
    await expect(admitModelCall(storage, cf)).resolves.toMatchObject({ ok: true });
  }
  await expect(admitModelCall(storage, cf)).resolves.toEqual({
    ok: false,
    reason: 'rate',
    waitMs: 6000,
  });
  await expect(admitModelCall(storage, { ...cf, now: 6000 })).resolves.toMatchObject({ ok: true });
});
