import { describe, expect, it } from 'vite-plus/test';
import {
  defaultSecurityPolicy,
  isSecurityEntitlementFresh,
  parseSecurityPolicy,
  readSecurityPolicy,
  SECURITY_ENTITLEMENT_MAX_AGE_MS,
  SECURITY_LIMIT_RANGES,
} from '../../src/security-policy.ts';
import type { SecurityPolicy } from '../../src/security-policy.ts';

const CHECKED_AT = '2026-11-18T03:00:00.000Z';
const CF_DEFAULT = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

// oxlint-disable-next-line quality/no-unknown-returns -- The test feeds the parser untrusted stored JSON.
function stored(overrides: Partial<Record<keyof SecurityPolicy, unknown>> = {}): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise the JSON representation read by the parser, which drops undefined keys.
  return JSON.parse(JSON.stringify({ ...defaultSecurityPolicy(), ...overrides }));
}

describe('security policy', () => {
  it('starts Off, with no gate, no budgets on and the @cf default', () => {
    const policy = defaultSecurityPolicy();
    expect(policy).toMatchObject({
      mode: 'disabled',
      defaultModel: CF_DEFAULT,
      thirdPartyNotice: null,
      publicGate: false,
      budgets: { platformCapOn: false, projectCapsOn: false },
    });
    expect(parseSecurityPolicy(stored())).toEqual(policy);
  });

  it('repairs a row another release wrote, which the write path refuses', () => {
    const retired = stored({
      mode: 'public',
      defaultModel: 'openai/gpt-5-retired',
      blockedModels: ['openai/gpt-5-retired', '@cf/zai-org/glm-5.3'],
    });
    expect(() => parseSecurityPolicy(retired)).toThrow('defaultModel must be one of');
    expect(readSecurityPolicy(retired)).toMatchObject({
      mode: 'public',
      defaultModel: CF_DEFAULT,
      blockedModels: ['@cf/zai-org/glm-5.3'],
    });
    // I8: a third-party default needs the accepted provider notice.
    const noNotice = stored({ defaultModel: 'openai/gpt-6.1-terra' });
    expect(() => parseSecurityPolicy(noNotice)).toThrow('needs the accepted provider notice');
    expect(readSecurityPolicy(noNotice).defaultModel).toBe(CF_DEFAULT);
    const tooMany = stored({ limits: { ...defaultSecurityPolicy().limits, concurrency: 50 } });
    expect(() => parseSecurityPolicy(tooMany)).toThrow();
    expect(readSecurityPolicy(tooMany).limits.concurrency).toBe(
      SECURITY_LIMIT_RANGES.concurrency.max,
    );
  });

  it('counts only a passing probe, for 24 hours', () => {
    const now = Date.parse(CHECKED_AT);
    const entitlement = {
      checkedAt: CHECKED_AT,
      ok: true,
      missing: [],
      hosts: { openai: true, anthropic: false },
    };
    expect(isSecurityEntitlementFresh(entitlement, now)).toBe(true);
    expect(isSecurityEntitlementFresh(entitlement, now + SECURITY_ENTITLEMENT_MAX_AGE_MS)).toBe(
      false,
    );
    expect(isSecurityEntitlementFresh({ ...entitlement, ok: false }, now)).toBe(false);
    expect(isSecurityEntitlementFresh(null, now)).toBe(false);
  });
});
