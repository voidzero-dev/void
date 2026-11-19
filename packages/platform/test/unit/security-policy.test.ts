import { describe, expect, it } from 'vite-plus/test';
import {
  defaultSecurityPolicy,
  isSecurityEntitlementFresh,
  isSecurityErrorCode,
  parseSecurityBudgets,
  parseSecurityLimits,
  parseSecurityLimitsPatch,
  parseSecurityMode,
  parseSecurityPolicy,
  parseSecurityUsd,
  readSecurityPolicy,
  SECURITY_ENTITLEMENT_MAX_AGE_MS,
  SECURITY_ERRORS,
  SECURITY_LIMIT_KEYS,
  SECURITY_LIMIT_RANGES,
  SECURITY_MODE_LABELS,
  SECURITY_MODES,
  SECURITY_POLICY_SETTINGS_KEY,
  type SecurityPolicy,
} from '../../src/security-policy.ts';

const CHECKED_AT = '2026-11-18T03:00:00.000Z';

function stored(overrides: Partial<Record<keyof SecurityPolicy, unknown>> = {}): unknown {
  return JSON.parse(JSON.stringify({ ...defaultSecurityPolicy(), ...overrides }));
}

const passingEntitlement = {
  checkedAt: CHECKED_AT,
  ok: true,
  missing: [],
  hosts: { openai: true, anthropic: false },
};

/** Strict refusals the stored-row reader repairs instead (another release wrote them). */
const READER_FALLS_BACK = new Set([
  'unknown model',
  'blocked default',
  'duplicate block',
  'unpriced default',
  'third-party default with no notice',
  'missing limit',
]);

describe('security policy defaults', () => {
  it('starts Off with the spec defaults', () => {
    expect(SECURITY_POLICY_SETTINGS_KEY).toBe('securityAudits.policy');
    expect(defaultSecurityPolicy()).toEqual({
      mode: 'disabled',
      defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      blockedModels: [],
      thirdPartyNotice: null,
      limits: {
        concurrency: 2,
        timeoutMinutes: 20,
        maxInputTokens: 1_200_000,
        maxOutputTokens: 120_000,
        modelCallsPerScan: 80,
      },
      budgets: {
        platformCapOn: false,
        platformMonthlyUsd: 1000,
        projectCapsOn: false,
        projectDefaultMonthlyUsd: 100,
      },
      entitlement: null,
      publicGate: false,
      revision: 0,
    });
  });

  it('keeps every default inside its range', () => {
    expect(SECURITY_LIMIT_KEYS).toEqual(Object.keys(SECURITY_LIMIT_RANGES));
    for (const key of SECURITY_LIMIT_KEYS) {
      const range = SECURITY_LIMIT_RANGES[key];
      expect(range.min).toBeLessThanOrEqual(range.default);
      expect(range.default).toBeLessThanOrEqual(range.max);
      expect(defaultSecurityPolicy().limits[key]).toBe(range.default);
    }
    expect(SECURITY_LIMIT_RANGES.concurrency).toMatchObject({ min: 1, max: 10 });
    expect(SECURITY_LIMIT_RANGES.timeoutMinutes).toMatchObject({ min: 5, max: 60 });
  });

  it('reads back its own default', () => {
    expect(parseSecurityPolicy(stored())).toEqual(defaultSecurityPolicy());
  });

  it('labels the three modes', () => {
    expect(SECURITY_MODES).toEqual(['disabled', 'public', 'all']);
    expect(SECURITY_MODE_LABELS).toEqual({
      disabled: 'Off',
      public: 'Public projects only',
      all: 'All projects',
    });
    expect(parseSecurityMode('all')).toBe('all');
    for (const value of ['off', 'Public', '', null, 1]) {
      expect(() => parseSecurityMode(value)).toThrow('disabled, public or all');
    }
  });
});

describe('security policy strict parser', () => {
  it('round-trips a full policy', () => {
    const policy = stored({
      mode: 'all',
      defaultModel: 'anthropic/claude-opus-5.5',
      blockedModels: ['openai/gpt-6.1-sol'],
      thirdPartyNotice: { acceptedByUserId: 'usr_1', acceptedAt: CHECKED_AT, version: 1 },
      limits: {
        concurrency: 10,
        timeoutMinutes: 5,
        maxInputTokens: 2_000_000,
        maxOutputTokens: 5_000,
        modelCallsPerScan: 10,
      },
      budgets: {
        platformCapOn: true,
        platformMonthlyUsd: 1500.5,
        projectCapsOn: true,
        projectDefaultMonthlyUsd: 0,
      },
      entitlement: passingEntitlement,
      publicGate: true,
      revision: 7,
    });
    expect(parseSecurityPolicy(policy)).toEqual(policy);
  });

  it('ignores unknown fields', () => {
    const policy = parseSecurityPolicy({ ...(stored() as object), laterField: 1 });
    expect(policy).toEqual(defaultSecurityPolicy());
    expect(Object.hasOwn(policy, 'laterField')).toBe(false);
  });

  it.each([
    ['not an object', null, 'must be an object'],
    ['missing revision', { ...(stored() as object), revision: undefined }, 'revision'],
    ['negative revision', stored({ revision: -1 }), 'revision'],
    ['unknown mode', stored({ mode: 'on' }), 'disabled, public or all'],
    ['unknown model', stored({ defaultModel: 'openai/gpt-4' }), 'defaultModel must be one of'],
    [
      'blocked default',
      stored({ blockedModels: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'] }),
      'is blocked',
    ],
    [
      'duplicate block',
      stored({ blockedModels: ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol'] }),
      'listed twice',
    ],
    ['block not a list', stored({ blockedModels: 'openai/gpt-6.1-sol' }), 'list of model IDs'],
    [
      'unpriced default',
      stored({
        defaultModel: 'anthropic/claude-sonnet-5.5',
        thirdPartyNotice: { acceptedByUserId: 'usr_1', acceptedAt: CHECKED_AT, version: 1 },
      }),
      'has no price',
    ],
    [
      'third-party default with no notice',
      stored({ defaultModel: 'openai/gpt-6.1-terra' }),
      'needs the accepted provider notice',
    ],
    ['gate while Off', stored({ publicGate: true }), 'public or all'],
    ['gate not boolean', stored({ publicGate: 'true' }), 'publicGate'],
    [
      'missing limit',
      stored({ limits: { ...defaultSecurityPolicy().limits, modelCallsPerScan: undefined } }),
      'modelCallsPerScan',
    ],
    [
      'bad notice time',
      stored({ thirdPartyNotice: { acceptedByUserId: 'u', acceptedAt: 'yesterday', version: 1 } }),
      'acceptedAt',
    ],
    [
      'bad notice version',
      stored({ thirdPartyNotice: { acceptedByUserId: 'u', acceptedAt: CHECKED_AT, version: 0 } }),
      'version',
    ],
    [
      'notice without user',
      stored({ thirdPartyNotice: { acceptedByUserId: '', acceptedAt: CHECKED_AT, version: 1 } }),
      'acceptedByUserId',
    ],
    [
      'entitlement ok with missing checks',
      stored({ entitlement: { ...passingEntitlement, missing: ['egress'] } }),
      'ok must be true exactly',
    ],
    [
      'entitlement with more than 20 check names',
      stored({
        entitlement: {
          ...passingEntitlement,
          ok: false,
          missing: Array.from({ length: 21 }, (_, index) => `check-${index}`),
        },
      }),
      'at most 20 check names',
    ],
    [
      'entitlement with a check name that is not text',
      stored({ entitlement: { ...passingEntitlement, ok: false, missing: [7] } }),
      'at most 20 check names',
    ],
    [
      'entitlement with an empty check name',
      stored({ entitlement: { ...passingEntitlement, ok: false, missing: [''] } }),
      'at most 20 check names',
    ],
    [
      'entitlement with a control character in a check name',
      stored({ entitlement: { ...passingEntitlement, ok: false, missing: ['egress\n'] } }),
      'at most 20 check names',
    ],
    [
      'entitlement not ok with no missing check',
      stored({ entitlement: { ...passingEntitlement, ok: false, missing: [] } }),
      'ok must be true exactly',
    ],
    [
      'entitlement without hosts',
      stored({ entitlement: { ...passingEntitlement, hosts: { openai: true } } }),
      'hosts.anthropic',
    ],
    [
      'entitlement with a non-ISO time',
      stored({ entitlement: { ...passingEntitlement, checkedAt: '2026-11-18' } }),
      'checkedAt',
    ],
  ])('refuses %s', (name, value, message) => {
    expect(() => parseSecurityPolicy(value)).toThrow(message);
    if (READER_FALLS_BACK.has(name)) {
      expect(() => readSecurityPolicy(value)).not.toThrow();
    } else {
      expect(() => readSecurityPolicy(value)).toThrow(message);
    }
  });

  it('reads check names from a later probe', () => {
    const policy = parseSecurityPolicy(
      stored({
        entitlement: { ...passingEntitlement, ok: false, missing: ['scanner', 'future-check'] },
      }),
    );
    expect(policy.entitlement?.missing).toEqual(['scanner', 'future-check']);
  });
});

describe('stored security policy written by another release', () => {
  const notice = { acceptedByUserId: 'u', acceptedAt: CHECKED_AT, version: 1 };

  it('reads a valid row the same as the strict parser', () => {
    const value = stored({
      mode: 'all',
      defaultModel: 'openai/gpt-6.1-sol',
      blockedModels: ['@cf/zai-org/glm-5.3'],
      thirdPartyNotice: notice,
      entitlement: passingEntitlement,
      publicGate: true,
      revision: 4,
    });
    expect(readSecurityPolicy(value)).toEqual(parseSecurityPolicy(value));
  });

  it('drops a retired blocked model and replaces a retired default', () => {
    const value = stored({
      mode: 'public',
      defaultModel: 'openai/gpt-5-retired',
      blockedModels: ['openai/gpt-5-retired', '@cf/zai-org/glm-5.3', '@cf/zai-org/glm-5.3'],
    });
    expect(() => parseSecurityPolicy(value)).toThrow('defaultModel must be one of');
    const policy = readSecurityPolicy(value);
    expect(policy.blockedModels).toEqual(['@cf/zai-org/glm-5.3']);
    expect(policy.defaultModel).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(policy.mode).toBe('public');
  });

  it('replaces an unpriced default (a later release priced it)', () => {
    const value = stored({ defaultModel: 'anthropic/claude-sonnet-5.5', thirdPartyNotice: notice });
    expect(() => parseSecurityPolicy(value)).toThrow('has no price yet');
    expect(readSecurityPolicy(value).defaultModel).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
  });

  it('replaces a blocked default, and a third-party default without the notice', () => {
    const blocked = stored({ blockedModels: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'] });
    expect(() => parseSecurityPolicy(blocked)).toThrow('is blocked');
    expect(readSecurityPolicy(blocked).defaultModel).toBe('@cf/zai-org/glm-5.3');
    const noNotice = stored({ defaultModel: 'openai/gpt-6.1-terra' });
    expect(() => parseSecurityPolicy(noNotice)).toThrow('needs the accepted provider notice');
    expect(readSecurityPolicy(noNotice).defaultModel).toBe(
      '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    );
  });

  it('falls back to a third-party model only when every @cf model is blocked', () => {
    const allCfBlocked = ['@cf/zai-org/glm-5.3', '@cf/deepseek-ai/deepseek-v4.1-flash-1017'];
    expect(
      readSecurityPolicy(
        stored({
          defaultModel: 'openai/gpt-5-retired',
          blockedModels: allCfBlocked,
          thirdPartyNotice: notice,
        }),
      ).defaultModel,
    ).toBe('openai/gpt-6.1-terra');
    expect(() =>
      readSecurityPolicy(
        stored({ defaultModel: 'openai/gpt-5-retired', blockedModels: allCfBlocked }),
      ),
    ).toThrow('No model can run');
  });

  it('clamps limits into range and fills a missing one with its default', () => {
    const { maxInputTokens: _dropped, ...rest } = SECURITY_LIMIT_RANGES;
    const limits = {
      ...Object.fromEntries(Object.keys(rest).map((key) => [key, 1])),
      concurrency: 50,
      timeoutMinutes: 120,
    };
    const value = stored({ limits });
    expect(() => parseSecurityPolicy(value)).toThrow();
    expect(readSecurityPolicy(value).limits).toEqual({
      concurrency: SECURITY_LIMIT_RANGES.concurrency.max,
      timeoutMinutes: SECURITY_LIMIT_RANGES.timeoutMinutes.max,
      maxInputTokens: SECURITY_LIMIT_RANGES.maxInputTokens.default,
      maxOutputTokens: SECURITY_LIMIT_RANGES.maxOutputTokens.min,
      modelCallsPerScan: SECURITY_LIMIT_RANGES.modelCallsPerScan.min,
    });
  });

  it('still refuses a limit that is not a whole number', () => {
    for (const bad of [2.5, '2', null]) {
      expect(() =>
        readSecurityPolicy(
          stored({ limits: { ...defaultSecurityPolicy().limits, concurrency: bad } }),
        ),
      ).toThrow('concurrency must be a whole number');
    }
  });

  it('refuses the same values on the write path', () => {
    for (const overrides of [
      { blockedModels: ['openai/gpt-5-retired'] },
      { defaultModel: 'openai/gpt-5-retired' },
      { limits: { ...defaultSecurityPolicy().limits, concurrency: 50 } },
    ]) {
      const value = stored(overrides);
      expect(() => parseSecurityPolicy(value)).toThrow();
      expect(() => readSecurityPolicy(value)).not.toThrow();
    }
  });
});

describe('security limits and budgets', () => {
  it('accepts each range edge and refuses one past it', () => {
    for (const key of SECURITY_LIMIT_KEYS) {
      const { min, max } = SECURITY_LIMIT_RANGES[key];
      expect(parseSecurityLimitsPatch({ [key]: min })).toEqual({ [key]: min });
      expect(parseSecurityLimitsPatch({ [key]: max })).toEqual({ [key]: max });
      for (const bad of [min - 1, max + 1, min + 0.5, String(min), null]) {
        expect(() => parseSecurityLimitsPatch({ [key]: bad })).toThrow(
          `${key} must be a whole number from ${min} to ${max}.`,
        );
      }
    }
  });

  it('refuses unknown limit keys and partial full limits', () => {
    expect(() => parseSecurityLimitsPatch({ timeout: 10 })).toThrow('Unknown security limit');
    expect(parseSecurityLimitsPatch({})).toEqual({});
    expect(() => parseSecurityLimits({ concurrency: 2 })).toThrow('timeoutMinutes');
  });

  it('takes USD amounts in whole cents up to the maximum', () => {
    for (const amount of [0, 0.01, 0.29, 40, 1500.5, 1_000_000]) {
      expect(parseSecurityUsd(amount, 'cap')).toBe(amount);
    }
    for (const amount of [-0.01, 0.001, 1_000_000.01, Number.NaN, Infinity, '100', null]) {
      expect(() => parseSecurityUsd(amount, 'cap')).toThrow('cap must be a USD amount');
    }
  });

  it('needs every budget field', () => {
    expect(() =>
      parseSecurityBudgets({ platformCapOn: true, platformMonthlyUsd: 10, projectCapsOn: false }),
    ).toThrow('projectDefaultMonthlyUsd');
    expect(() =>
      parseSecurityBudgets({
        platformCapOn: 'yes',
        platformMonthlyUsd: 10,
        projectCapsOn: false,
        projectDefaultMonthlyUsd: 1,
      }),
    ).toThrow('platformCapOn must be true or false');
  });
});

describe('security entitlement freshness', () => {
  const now = Date.parse(CHECKED_AT);

  it('counts a passing probe for 24 hours', () => {
    const entitlement = parseSecurityPolicy(
      stored({ entitlement: passingEntitlement }),
    ).entitlement;
    expect(isSecurityEntitlementFresh(entitlement, now)).toBe(true);
    expect(isSecurityEntitlementFresh(entitlement, now + SECURITY_ENTITLEMENT_MAX_AGE_MS - 1)).toBe(
      true,
    );
    expect(isSecurityEntitlementFresh(entitlement, now + SECURITY_ENTITLEMENT_MAX_AGE_MS)).toBe(
      false,
    );
    // A probe time in the future (clock skew or bad data) is not fresh.
    expect(isSecurityEntitlementFresh(entitlement, now - 1)).toBe(false);
  });

  it('never counts a failed or missing probe', () => {
    expect(isSecurityEntitlementFresh(null, now)).toBe(false);
    expect(
      isSecurityEntitlementFresh({ ...passingEntitlement, ok: false, missing: ['egress'] }, now),
    ).toBe(false);
  });
});

describe('security error codes', () => {
  it('lists the spec §13.5 codes with their status', () => {
    expect(Object.values(SECURITY_ERRORS).map((entry) => `${entry.status} ${entry.code}`)).toEqual([
      '422 security model not allowed',
      '422 provider notice not accepted',
      '409 security entitlement missing',
      '409 finding changed',
      '422 security budget above platform limit',
      '409 security public gate needs zero trust',
      '409 security public gate needs policy',
      '409 security public gate on',
      '409 no public request',
      '409 public request closed',
      '409 security public request has urgent findings',
      '422 scan bypass reason required',
      '503 security policy unreadable',
    ]);
  });

  it('does not reuse the removed deploy gate names', () => {
    expect(isSecurityErrorCode('security policy unreadable')).toBe(true);
    expect(isSecurityErrorCode('security findings unresolved')).toBe(false);
    expect(isSecurityErrorCode('security bypass invalid')).toBe(false);
    expect(isSecurityErrorCode('platform capability unavailable')).toBe(false);
  });
});
