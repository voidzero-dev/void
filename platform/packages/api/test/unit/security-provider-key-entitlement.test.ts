import type { SecurityEntitlement } from '@void/platform/security-policy';
import { expect, test } from 'vite-plus/test';
import { entitlementForSavedKeys } from '../../src/security/provider-keys.ts';

const PASSED: SecurityEntitlement = {
  checkedAt: '2026-11-18T11:00:00.000Z',
  ok: true,
  missing: [],
  hosts: { openai: true, anthropic: true },
};

test('entitlementForSavedKeys: the probe result for an unchanged key, else the stored value', () => {
  expect(
    entitlementForSavedKeys(
      PASSED,
      { openai: null, anthropic: 'pk_old' },
      { openai: 'pk_new', anthropic: 'pk_old' },
      { openai: true, anthropic: false },
    ).hosts,
  ).toEqual({ openai: true, anthropic: true });
  expect(
    entitlementForSavedKeys(
      { ...PASSED, hosts: { openai: false, anthropic: true } },
      { openai: 'pk_a', anthropic: 'pk_old' },
      { openai: 'pk_a', anthropic: null },
      null,
    ).hosts,
  ).toEqual({ openai: false, anthropic: false });
});
