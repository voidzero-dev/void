import { SECURITY_PROVIDER_NOTICE_VERSION } from '@void/platform/security-models';
import type { SecurityModelId } from '@void/platform/security-models';
import { defaultSecurityPolicy } from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { describe, expect, it } from 'vite-plus/test';
import { SecurityApiError } from '../../src/security/errors.ts';
import {
  interpretStoredSecurityPolicy,
  proposeSecurityPolicyChange,
} from '../../src/security/policy.ts';
import type { StoredSecurityPolicy } from '../../src/security/policy.ts';
import { passingEntitlement as probe } from '../helpers/security-policy.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const context = { userId: 'usr_admin', now: NOW };

function stored(overrides: Partial<SecurityPolicy> = {}) {
  return {
    policy: { ...defaultSecurityPolicy(), entitlement: probe(), revision: 2, ...overrides },
    saved: true,
    unreadable: null,
  } satisfies StoredSecurityPolicy;
}

function refused(run: () => unknown): SecurityApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof SecurityApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a SecurityApiError');
}

it('reads bad stored data as disabled, keeping the revision for the next write', () => {
  expect(interpretStoredSecurityPolicy({ mode: 'all', revision: 9 })).toMatchObject({
    policy: { mode: 'disabled', revision: 9 },
    unreadable: expect.any(String),
  });
});

describe('proposeSecurityPolicyChange', () => {
  it('turns the policy on only with a probe pass less than 24 hours old', () => {
    expect(proposeSecurityPolicyChange(stored(), { mode: 'all' }, context).next.mode).toBe('all');
    for (const entitlement of [
      null,
      probe({ checkedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }),
      probe({ ok: false, missing: ['egress'] }),
    ]) {
      expect(
        refused(() =>
          proposeSecurityPolicyChange(stored({ entitlement }), { mode: 'all' }, context),
        ),
      ).toMatchObject({ status: 409, code: 'security entitlement missing' });
    }
  });

  it('turns the public gate on only with the policy on and Zero Trust enabled, and off with it', () => {
    const gateOn = (policy: Partial<SecurityPolicy>, zeroTrust?: 'enabled' | 'off') =>
      proposeSecurityPolicyChange(stored(policy), { publicGate: true }, { ...context, zeroTrust });
    expect(gateOn({ mode: 'all' }, 'enabled').next.publicGate).toBe(true);
    expect(refused(() => gateOn({ mode: 'disabled' }, 'enabled')).code).toBe(
      'security public gate needs policy',
    );
    expect(refused(() => gateOn({ mode: 'all' }, 'off')).code).toBe(
      'security public gate needs zero trust',
    );
    expect(refused(() => gateOn({ mode: 'all' })).code).toBe(
      'security public gate needs zero trust',
    );
    const off = proposeSecurityPolicyChange(
      stored({ mode: 'all', publicGate: true }),
      { mode: 'disabled' },
      context,
    );
    expect(off.next.publicGate).toBe(false);
  });

  // I8: no code goes to a third party before its host check passed and its notice was accepted.
  it('needs a passed host check and the current notice for a third-party default', () => {
    const defaultModel: SecurityModelId = 'openai/gpt-6.1-terra';
    const accept = SECURITY_PROVIDER_NOTICE_VERSION;
    const noHost = stored({ entitlement: probe({ hosts: { openai: false, anthropic: true } }) });
    expect(
      refused(() =>
        proposeSecurityPolicyChange(
          noHost,
          { defaultModel, acceptProviderNoticeVersion: accept },
          context,
        ),
      ).code,
    ).toBe('security model not allowed');
    expect(
      refused(() => proposeSecurityPolicyChange(stored(), { defaultModel }, context)).code,
    ).toBe('provider notice not accepted');
    const stale = { defaultModel, acceptProviderNoticeVersion: accept + 1 };
    expect(refused(() => proposeSecurityPolicyChange(stored(), stale, context)).code).toBe(
      'provider notice not accepted',
    );
    const accepted = proposeSecurityPolicyChange(
      stored(),
      { defaultModel, acceptProviderNoticeVersion: accept },
      context,
    );
    expect(accepted.next.thirdPartyNotice?.version).toBe(accept);
  });
});
