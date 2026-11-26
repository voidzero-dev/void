import { defaultSecurityPolicy } from '@void/platform/security-policy';
import type { SecurityEntitlement, SecurityPolicy } from '@void/platform/security-policy';

/** A probe pass one hour before the unit tests' clock (2026-11-18T12:00Z). */
export function passingEntitlement(
  overrides: Partial<SecurityEntitlement> = {},
): SecurityEntitlement {
  return {
    checkedAt: '2026-11-18T11:00:00.000Z',
    ok: true,
    missing: [],
    hosts: { openai: true, anthropic: true },
    ...overrides,
  };
}

/** Security audits on for every project, with a passing probe. */
export function onPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    ...defaultSecurityPolicy(),
    mode: 'all',
    entitlement: passingEntitlement(),
    ...overrides,
  };
}
