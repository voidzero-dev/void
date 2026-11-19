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
  parseSecuritySweepDays,
  parseSecurityWebhookUrl,
  parseSecurityUsd,
  readSecurityPolicy,
  SECURITY_ENTITLEMENT_MAX_AGE_MS,
  SECURITY_ERRORS,
  SECURITY_LIMIT_KEYS,
  SECURITY_LIMIT_RANGES,
  SECURITY_MODE_LABELS,
  SECURITY_MODES,
  SECURITY_POLICY_SETTINGS_KEY,
  SECURITY_SWEEP_DAYS_RANGE,
  type SecurityPolicy,
  formatPlanSecurityCap,
  parsePlanSecurityCapInput,
  planSecurityCap,
  readPlanSecurityCaps,
  withPlanSecurityCap,
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
      sweeps: { on: false, everyDays: 30 },
      fallbackToCf: false,
      digest: false,
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
      sweeps: { on: true, everyDays: 7 },
      fallbackToCf: true,
      digest: true,
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

describe('scheduled sweeps setting (M25)', () => {
  it('reads a row saved before sweeps existed as off', () => {
    const { sweeps: _sweeps, ...old } = stored() as Record<string, unknown>;
    expect(parseSecurityPolicy(old).sweeps).toEqual({ on: false, everyDays: 30 });
    expect(readSecurityPolicy(old).sweeps).toEqual({ on: false, everyDays: 30 });
  });

  it('checks the range strictly on write and repairs on read', () => {
    expect(SECURITY_SWEEP_DAYS_RANGE).toEqual({ min: 7, max: 90, default: 30 });
    expect(parseSecuritySweepDays(7)).toBe(7);
    expect(parseSecuritySweepDays(90)).toBe(90);
    for (const days of [6, 91, 1.5, '30']) {
      expect(() => parseSecuritySweepDays(days)).toThrow('from 7 to 90');
    }
    for (const sweeps of [{ on: true, everyDays: 6 }, { on: 'yes', everyDays: 30 }, 'on']) {
      expect(() => parseSecurityPolicy(stored({ sweeps }))).toThrow('sweeps');
    }
    expect(readSecurityPolicy(stored({ sweeps: { on: true, everyDays: 400 } })).sweeps).toEqual({
      on: true,
      everyDays: 90,
    });
    // Bad data never starts paid scans.
    expect(readSecurityPolicy(stored({ sweeps: { on: 'yes' } })).sweeps.on).toBe(false);
    expect(readSecurityPolicy(stored({ sweeps: null })).sweeps.on).toBe(false);
  });
});

describe('fallback and digest settings (M26)', () => {
  it('reads a row saved before M26 as off', () => {
    const { fallbackToCf: _f, digest: _d, ...old } = stored() as Record<string, unknown>;
    for (const read of [parseSecurityPolicy, readSecurityPolicy]) {
      expect(read(old)).toMatchObject({ fallbackToCf: false, digest: false });
    }
  });

  it('refuses a non-boolean on write and reads it as off', () => {
    for (const field of ['fallbackToCf', 'digest'] as const) {
      expect(() => parseSecurityPolicy(stored({ [field]: 'yes' }))).toThrow(field);
      expect(readSecurityPolicy(stored({ [field]: 'yes' }))[field]).toBe(false);
      expect(readSecurityPolicy(stored({ [field]: null }))[field]).toBe(false);
    }
  });
});

describe('security webhook URL (M26)', () => {
  it('takes an https URL and normalizes it', () => {
    expect(parseSecurityWebhookUrl('https://hooks.example.com/void?x=1')).toBe(
      'https://hooks.example.com/void?x=1',
    );
    expect(parseSecurityWebhookUrl('HTTPS://Hooks.Example.com')).toBe('https://hooks.example.com/');
  });

  it('refuses http, credentials, fragments, junk and very long URLs', () => {
    for (const value of [
      'http://hooks.example.com/',
      'https://user:pass@hooks.example.com/',
      'https://hooks.example.com/#x',
      'not a url',
      '',
      null,
      `https://example.com/${'a'.repeat(2048)}`,
    ]) {
      expect(() => parseSecurityWebhookUrl(value)).toThrow('webhook URL');
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

describe('per-plan scan caps (M27)', () => {
  it('reads a stored row leniently: bad entries inherit, a JSON null is no cap', () => {
    expect(readPlanSecurityCaps(null)).toEqual({ caps: {}, dropped: 0 });
    expect(readPlanSecurityCaps([5000])).toEqual({ caps: {}, dropped: 1 });
    expect(
      readPlanSecurityCaps({
        pro: 5000,
        team: null,
        free: 0,
        bad: -1,
        half: 12.5,
        Upper: 10,
        huge: 100_000_001,
        text: '5',
      }),
    ).toEqual({ caps: { pro: 5000, team: null, free: 0 }, dropped: 5 });
    const caps = { pro: 5000, team: null };
    expect(planSecurityCap(caps, 'pro')).toBe(5000);
    expect(planSecurityCap(caps, 'team')).toBe('none');
    expect(planSecurityCap(caps, 'free')).toBe('inherit');
    expect(planSecurityCap(caps, 'constructor')).toBe('inherit');
  });

  it('parses a change and writes a new row without touching other plans', () => {
    expect(parsePlanSecurityCapInput(undefined)).toBeUndefined();
    expect(parsePlanSecurityCapInput(12.5)).toBe(1250);
    expect(parsePlanSecurityCapInput(0)).toBe(0);
    expect(parsePlanSecurityCapInput('none')).toBe('none');
    expect(parsePlanSecurityCapInput('inherit')).toBe('inherit');
    for (const bad of [12.345, -1, 1_000_001, '50', null, true]) {
      expect(() => parsePlanSecurityCapInput(bad)).toThrow();
    }
    const caps = { pro: 5000, team: null };
    expect(withPlanSecurityCap(caps, 'pro', 'inherit')).toEqual({ team: null });
    expect(withPlanSecurityCap(caps, 'free', 'none')).toEqual({
      pro: 5000,
      team: null,
      free: null,
    });
    expect(withPlanSecurityCap(caps, 'team', 700)).toEqual({ pro: 5000, team: 700 });
    expect(caps).toEqual({ pro: 5000, team: null });
  });

  it('formats a cap for the CLI and the admin panel', () => {
    expect(formatPlanSecurityCap(123_456)).toBe('$1,234.56 / month');
    expect(formatPlanSecurityCap(0)).toBe('$0.00 / month');
    expect(formatPlanSecurityCap('none')).toBe('no cap');
    expect(formatPlanSecurityCap('inherit')).toBe('policy default');
  });
});
