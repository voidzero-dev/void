import {
  SECURITY_PROVIDER_NOTICE_VERSION,
  type SecurityModelId,
} from '@void/platform/security-models';
import {
  defaultSecurityPolicy,
  type SecurityEntitlement,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbOrTx } from '../../src/db.ts';
import { SecurityApiError, SecurityPolicyUnreadableError } from '../../src/security/errors.ts';
import {
  interpretStoredSecurityPolicy,
  parseSecurityPolicyChangeRequest,
  proposeSecurityPolicyChange,
  readSecurityPolicyLenient,
  readSecurityPolicyStrict,
  securityFallbackModel,
  securityPolicyPreviewLines,
  securitySpendMonth,
  type SecurityPolicyPreviewCounts,
  type StoredSecurityPolicy,
} from '../../src/security/policy.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');

function probe(overrides: Partial<SecurityEntitlement> = {}): SecurityEntitlement {
  return {
    checkedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    ok: true,
    missing: [],
    hosts: { openai: true, anthropic: true },
    ...overrides,
  };
}

function stored(overrides: Partial<SecurityPolicy> = {}, unreadable: string | null = null) {
  return {
    policy: { ...defaultSecurityPolicy(), entitlement: probe(), revision: 2, ...overrides },
    saved: true,
    unreadable,
  } satisfies StoredSecurityPolicy;
}

const context = { userId: 'usr_admin', now: NOW };

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

/** A db whose `platform_settings` read returns `value`. */
function settingsDb(value: unknown): DbOrTx {
  const rows = value === undefined ? [] : [{ value }];
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } as unknown as DbOrTx;
}

const COUNTS: SecurityPolicyPreviewCounts = {
  scannedProjects: 0,
  firstFullScan: 0,
  urgentProjects: 0,
  protectedProjects: 0,
  queuedScans: 0,
  runningScans: 0,
  noOwnModel: 0,
  noOwnModelAccepted: 0,
  pickedBlocked: {},
  pickedBlockedAccepted: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stored policy readers', () => {
  it('reads a missing row as the default policy', () => {
    expect(interpretStoredSecurityPolicy(null)).toEqual({
      policy: defaultSecurityPolicy(),
      saved: false,
      unreadable: null,
    });
  });

  it('reads bad data as disabled and keeps a readable revision for the next write', () => {
    expect(interpretStoredSecurityPolicy({ mode: 'all', revision: 9 })).toMatchObject({
      policy: { mode: 'disabled', revision: 9 },
      saved: true,
      unreadable: expect.any(String),
    });
    expect(interpretStoredSecurityPolicy('garbage')).toMatchObject({
      policy: { mode: 'disabled', revision: 0 },
      unreadable: expect.any(String),
    });
  });

  it('lenient reader logs bad data and answers disabled', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(readSecurityPolicyLenient(settingsDb({ mode: 'all' }))).resolves.toMatchObject({
      mode: 'disabled',
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('securityAudits.policy'));
  });

  it('strict reader throws a 503 on bad data and reads a missing row as the default', async () => {
    const failure = await readSecurityPolicyStrict(settingsDb({ mode: 'all' })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SecurityPolicyUnreadableError);
    expect(failure).toMatchObject({ status: 503, code: 'security policy unreadable' });
    await expect(readSecurityPolicyStrict(settingsDb(undefined))).resolves.toEqual(
      defaultSecurityPolicy(),
    );
  });

  it('keeps a readable policy', async () => {
    const policy = { ...defaultSecurityPolicy(), mode: 'public', revision: 4 };
    await expect(readSecurityPolicyStrict(settingsDb(policy))).resolves.toEqual(policy);
  });
});

describe('parseSecurityPolicyChangeRequest', () => {
  it('parses every field', () => {
    expect(
      parseSecurityPolicyChangeRequest({
        dryRun: true,
        expectedRevision: 2,
        mode: 'all',
        defaultModel: 'openai/gpt-6.1-terra',
        block: ['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol'],
        unblock: ['anthropic/claude-opus-5.5'],
        acceptProviderNoticeVersion: 1,
        limits: { concurrency: 3 },
        publicGate: false,
      }),
    ).toEqual({
      expectedRevision: 2,
      mode: 'all',
      defaultModel: 'openai/gpt-6.1-terra',
      block: ['openai/gpt-6.1-sol'],
      unblock: ['anthropic/claude-opus-5.5'],
      acceptProviderNoticeVersion: 1,
      limits: { concurrency: 3 },
      publicGate: false,
    });
  });

  it.each([
    ['an unknown field', { modes: 'all' }, 400],
    ['an unknown mode', { mode: 'sometimes' }, 400],
    ['a negative revision', { expectedRevision: -1 }, 400],
    ['a limit out of range', { limits: { concurrency: 11 } }, 400],
    ['an unknown limit', { limits: { retries: 1 } }, 400],
    ['blockedModels with block', { blockedModels: [], block: ['openai/gpt-6.1-sol'] }, 400],
    [
      'a model blocked and unblocked',
      { block: ['openai/gpt-6.1-sol'], unblock: ['openai/gpt-6.1-sol'] },
      400,
    ],
    ['a non-boolean gate', { publicGate: 'on' }, 400],
    ['an unknown model', { defaultModel: 'openai/gpt-4' }, 422],
    ['an unknown blocked model', { block: ['@cf/meta/llama'] }, 422],
  ])('refuses %s', (_label, body, status) => {
    expect(refused(() => parseSecurityPolicyChangeRequest(body))).toMatchObject({ status });
  });
});

describe('proposeSecurityPolicyChange', () => {
  it('turns the policy on only with a probe pass less than 24 hours old', () => {
    expect(proposeSecurityPolicyChange(stored(), { mode: 'all' }, context).next.mode).toBe('all');
    for (const entitlement of [
      null,
      probe({ checkedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() }),
      probe({ ok: false, missing: ['egress'] }),
      probe({ checkedAt: new Date(NOW + 60_000).toISOString() }),
    ]) {
      expect(
        refused(() =>
          proposeSecurityPolicyChange(stored({ entitlement }), { mode: 'public' }, context),
        ),
      ).toMatchObject({ status: 409, code: 'security entitlement missing' });
    }
  });

  it('moves between on modes and turns Off without a fresh probe', () => {
    const on = stored({ mode: 'all', entitlement: null });
    expect(proposeSecurityPolicyChange(on, { mode: 'public' }, context).changes.mode).toEqual({
      from: 'all',
      to: 'public',
    });
    expect(proposeSecurityPolicyChange(on, { mode: 'disabled' }, context).next.mode).toBe(
      'disabled',
    );
  });

  it('turns the public gate off with the policy', () => {
    const result = proposeSecurityPolicyChange(
      stored({ mode: 'all', publicGate: true }),
      { mode: 'disabled' },
      context,
    );
    expect(result.next.publicGate).toBe(false);
    expect(result.changes.publicGateOff).toBe(true);
  });

  it('turns the public gate off by itself', () => {
    const result = proposeSecurityPolicyChange(
      stored({ mode: 'all', publicGate: true }),
      { publicGate: false },
      context,
    );
    expect(result.next).toMatchObject({ mode: 'all', publicGate: false });
    expect(result.changes.publicGateOff).toBe(true);
    expect(result.changes.mode).toBeNull();
    expect(
      refused(() =>
        proposeSecurityPolicyChange(stored({ mode: 'all' }), { publicGate: false }, context),
      ),
    ).toMatchObject({ status: 400 });
  });

  it('refuses to turn the public gate on until it ships', () => {
    expect(
      refused(() =>
        proposeSecurityPolicyChange(stored({ mode: 'all' }), { publicGate: true }, context),
      ),
    ).toMatchObject({ status: 400 });
  });

  it('refuses a blocked or unpriced default and blocking the current default', () => {
    expect(
      refused(() =>
        proposeSecurityPolicyChange(
          stored(),
          { block: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'] },
          context,
        ),
      ),
    ).toMatchObject({ status: 422, code: 'security model not allowed' });
    expect(
      refused(() =>
        proposeSecurityPolicyChange(
          stored({ blockedModels: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'] }),
          { defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' },
          context,
        ),
      ),
    ).toMatchObject({ status: 422, code: 'security model not allowed' });
    expect(
      refused(() =>
        proposeSecurityPolicyChange(
          stored(),
          {
            defaultModel: 'anthropic/claude-sonnet-5.5',
            acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
          },
          context,
        ),
      ),
    ).toMatchObject({ status: 422, code: 'security model not allowed' });
  });

  it('unblocks and sets a default in one change', () => {
    const result = proposeSecurityPolicyChange(
      stored({ blockedModels: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'] }),
      {
        defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        unblock: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'],
      },
      context,
    );
    expect(result.next).toMatchObject({
      defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      blockedModels: [],
    });
    expect(result.changes.unblocked).toEqual(['@cf/deepseek-ai/deepseek-v4.1-flash-1017']);
  });

  it('needs a passed host check and the current notice for a third-party default', () => {
    const model: SecurityModelId = 'openai/gpt-6.1-terra';
    expect(
      refused(() =>
        proposeSecurityPolicyChange(
          stored({ entitlement: probe({ hosts: { openai: false, anthropic: true } }) }),
          { defaultModel: model, acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION },
          context,
        ),
      ),
    ).toMatchObject({ code: 'security model not allowed', details: { host: 'openai' } });
    expect(
      refused(() => proposeSecurityPolicyChange(stored(), { defaultModel: model }, context)),
    ).toMatchObject({ status: 422, code: 'provider notice not accepted' });
    // Accepting a notice version other than the current one does not count.
    expect(
      refused(() =>
        proposeSecurityPolicyChange(
          stored(),
          {
            defaultModel: model,
            acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION + 1,
          },
          context,
        ),
      ),
    ).toMatchObject({ code: 'provider notice not accepted' });
    const accepted = proposeSecurityPolicyChange(
      stored(),
      { defaultModel: model, acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION },
      context,
    );
    expect(accepted.next.thirdPartyNotice).toEqual({
      acceptedByUserId: 'usr_admin',
      acceptedAt: new Date(NOW).toISOString(),
      version: SECURITY_PROVIDER_NOTICE_VERSION,
    });
  });

  it('refuses a change that changes nothing, unless it replaces bad data', () => {
    expect(
      refused(() => proposeSecurityPolicyChange(stored(), { limits: { concurrency: 2 } }, context)),
    ).toMatchObject({ status: 400 });
    expect(
      proposeSecurityPolicyChange(stored({}, 'bad'), { limits: { concurrency: 2 } }, context)
        .changes.repaired,
    ).toBe(true);
  });

  it('replaces the blocked list in model-list order', () => {
    const result = proposeSecurityPolicyChange(
      stored({ blockedModels: ['openai/gpt-6.1-sol'] }),
      { blockedModels: ['anthropic/claude-opus-5.5', 'openai/gpt-6.1-terra'] },
      context,
    );
    expect(result.next.blockedModels).toEqual([
      'openai/gpt-6.1-terra',
      'anthropic/claude-opus-5.5',
    ]);
    expect(result.changes).toMatchObject({
      blocked: ['openai/gpt-6.1-terra', 'anthropic/claude-opus-5.5'],
      unblocked: ['openai/gpt-6.1-sol'],
    });
  });
});

describe('securityPolicyPreviewLines', () => {
  function lines(
    from: Partial<SecurityPolicy>,
    request: Parameters<typeof proposeSecurityPolicyChange>[1],
    counts: Partial<SecurityPolicyPreviewCounts>,
  ) {
    const current = stored(from);
    const { next, changes } = proposeSecurityPolicyChange(current, request, context);
    return securityPolicyPreviewLines(current.policy, next, changes, { ...COUNTS, ...counts });
  }

  it('prints the spec copy for Off → All projects', () => {
    expect(
      lines({}, { mode: 'all' }, { scannedProjects: 42, firstFullScan: 42, urgentProjects: 3 }),
    ).toEqual([
      'Change policy: Off → All projects',
      '  42 projects will be scanned at their next deploy.',
      '  The first scan of each project reviews the whole app (no earlier scan to compare to).',
      "  3 projects still have open urgent findings from before. They show in those projects' deploy output again.",
      '  Monthly scan budgets are off (no money limit). Set them with: void platform security budget',
    ]);
  });

  it('leaves the budget line out when a cap is on', () => {
    expect(
      lines(
        {
          budgets: {
            platformCapOn: true,
            platformMonthlyUsd: 1000,
            projectCapsOn: false,
            projectDefaultMonthlyUsd: 100,
          },
        },
        { mode: 'all' },
        { scannedProjects: 1, firstFullScan: 0 },
      ),
    ).toEqual([
      'Change policy: Off → All projects',
      '  1 project will be scanned at their next deploy.',
    ]);
  });

  it('describes moves between on modes', () => {
    expect(lines({ mode: 'all' }, { mode: 'public' }, { protectedProjects: 5 })).toEqual([
      'Change policy: All projects → Public projects only',
      '  5 protected projects are no longer scanned at deploy. Running scans finish.',
    ]);
    expect(
      lines({ mode: 'all', publicGate: true }, { mode: 'public' }, { protectedProjects: 1 }),
    ).toEqual([
      'Change policy: All projects → Public projects only',
      '  1 protected project is no longer scanned at deploy. Gate scans still run; running scans finish.',
    ]);
    expect(lines({ mode: 'public' }, { mode: 'all' }, { protectedProjects: 1 })).toEqual([
      'Change policy: Public projects only → All projects',
      '  1 protected project will also be scanned at their next deploy.',
    ]);
  });

  it('says the gate turns off with the policy', () => {
    expect(lines({ mode: 'all', publicGate: true }, { mode: 'disabled' }, {})).toEqual([
      'Change policy: All projects → Off',
      '  New deploys are not scanned.',
      '  Open findings stay listed and can still be read, commented on and resolved. Only the deploy-time notice stops.',
      '  "Scan before a project goes public" turns off too.',
    ]);
  });

  it('prints the spec copy for a third-party default nobody accepted yet', () => {
    expect(
      lines(
        {},
        {
          defaultModel: 'anthropic/claude-opus-5.5',
          acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
        },
        { noOwnModel: 9 },
      ),
    ).toEqual([
      `Provider notice accepted (version ${SECURITY_PROVIDER_NOTICE_VERSION}).`,
      'Change default model: @cf/deepseek-ai/deepseek-v4.1-flash-1017 → anthropic/claude-opus-5.5',
      '  9 projects have no model of their own. They stay on @cf/deepseek-ai/deepseek-v4.1-flash-1017 until a project owner or admin accepts the Anthropic notice.',
    ]);
  });

  it('says where projects on a newly blocked model go', () => {
    const block = { block: ['openai/gpt-6.1-terra'] as Array<SecurityModelId> };
    const accepted = {
      acceptedByUserId: 'usr_admin',
      acceptedAt: new Date(NOW).toISOString(),
      version: SECURITY_PROVIDER_NOTICE_VERSION,
    };
    expect(lines({}, block, { pickedBlocked: { 'openai/gpt-6.1-terra': 1 } })).toEqual([
      'Block openai/gpt-6.1-terra: 1 project picked it. It uses the default model (@cf/deepseek-ai/deepseek-v4.1-flash-1017) from its next scan.',
    ]);
    const thirdParty = {
      defaultModel: 'anthropic/claude-opus-5.5',
      thirdPartyNotice: accepted,
    } as const;
    expect(lines(thirdParty, block, { pickedBlocked: { 'openai/gpt-6.1-terra': 2 } })).toEqual([
      'Block openai/gpt-6.1-terra: 2 projects picked it. They stay on @cf/deepseek-ai/deepseek-v4.1-flash-1017 until a project owner or admin accepts the Anthropic notice.',
    ]);
    expect(
      lines(thirdParty, block, {
        pickedBlocked: { 'openai/gpt-6.1-terra': 3 },
        pickedBlockedAccepted: { 'openai/gpt-6.1-terra': 3 },
      }),
    ).toEqual([
      'Block openai/gpt-6.1-terra: 3 projects picked it. They use the default model (anthropic/claude-opus-5.5) from their next scan.',
    ]);
    expect(
      lines({ ...thirdParty, blockedModels: ['@cf/zai-org/glm-5.3'] }, block, {
        pickedBlocked: { 'openai/gpt-6.1-terra': 3 },
        pickedBlockedAccepted: { 'openai/gpt-6.1-terra': 1 },
      }),
    ).toEqual([
      `Block openai/gpt-6.1-terra: 3 projects picked it. 1 of them accepted the provider notice and use the default model (anthropic/claude-opus-5.5) from their next scan; the other 2 stay on ${securityFallbackModel(['@cf/zai-org/glm-5.3', 'openai/gpt-6.1-terra'])} until a project owner or admin accepts the Anthropic notice.`,
    ]);
  });

  it('lists blocked, unblocked models and limits', () => {
    expect(
      lines(
        { blockedModels: ['openai/gpt-6.1-sol'] },
        {
          block: ['openai/gpt-6.1-terra'],
          unblock: ['openai/gpt-6.1-sol'],
          limits: { concurrency: 4, timeoutMinutes: 30 },
        },
        { pickedBlocked: { 'openai/gpt-6.1-terra': 0 } },
      ),
    ).toEqual([
      'Block openai/gpt-6.1-terra: no project picked it.',
      'Unblock openai/gpt-6.1-sol: project owners and admins can pick it again.',
      'Limits: concurrency 2 → 4, timeoutMinutes 20 → 30',
    ]);
  });

  it('starts with the repair line for bad stored data', () => {
    const current = stored({}, 'bad');
    const { next, changes } = proposeSecurityPolicyChange(
      current,
      { limits: { concurrency: 3 } },
      context,
    );
    expect(securityPolicyPreviewLines(current.policy, next, changes, COUNTS)[0]).toBe(
      'The saved policy could not be read. Saving replaces it, starting from Off.',
    );
  });
});

describe('helpers', () => {
  it('falls back to the first non-blocked priced @cf model', () => {
    expect(securityFallbackModel([])).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(securityFallbackModel(['@cf/deepseek-ai/deepseek-v4.1-flash-1017'])).toBe(
      '@cf/zai-org/glm-5.3',
    );
    expect(
      securityFallbackModel(['@cf/zai-org/glm-5.3', '@cf/deepseek-ai/deepseek-v4.1-flash-1017']),
    ).toBeNull();
  });

  it('uses the first day of the UTC month', () => {
    expect(securitySpendMonth(Date.parse('2026-12-01T00:30:00+01:00'))).toBe('2026-11-01');
    expect(securitySpendMonth(Date.parse('2026-12-31T23:59:59Z'))).toBe('2026-12-01');
  });
});
