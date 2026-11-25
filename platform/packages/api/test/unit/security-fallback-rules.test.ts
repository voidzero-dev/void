import { defaultSecurityPolicy } from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { describe, expect, it } from 'vite-plus/test';
import { securityScanWantsFallback } from '../../src/security/fallback.ts';
import { resolveSecurityScanModel, securityCfDefaultModel } from '../../src/security/models.ts';
import {
  parseSecurityPolicyChangeRequest,
  proposeSecurityPolicyChange,
  securityPolicyPreviewLines,
} from '../../src/security/policy.ts';

const CF = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const CF_2 = '@cf/zai-org/glm-5.3';
const OPUS = 'anthropic/claude-opus-5.5';

function policyWith(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    ...defaultSecurityPolicy(),
    mode: 'all',
    fallbackToCf: true,
    thirdPartyNotice: {
      acceptedByUserId: 'usr_admin',
      acceptedAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    },
    revision: 1,
    ...overrides,
  };
}

describe('which scans get a fallback (spec §8.5)', () => {
  const base = { trigger: 'deploy', modelUsed: OPUS, statusReason: null };

  it('re-scans a refused, bad-output or timed-out third-party scan', () => {
    expect(securityScanWantsFallback({ ...base, status: 'refused' })).toBe(true);
    expect(securityScanWantsFallback({ ...base, status: 'timed_out' })).toBe(true);
    expect(
      securityScanWantsFallback({ ...base, status: 'failed', statusReason: 'bad_output' }),
    ).toBe(true);
    expect(securityScanWantsFallback({ ...base, status: 'refused', trigger: 'gate' })).toBe(true);
  });

  it('never for other outcomes, a @cf scan, a fallback or a local check', () => {
    for (const status of ['succeeded', 'incomplete', 'skipped', 'canceled']) {
      expect(securityScanWantsFallback({ ...base, status })).toBe(false);
    }
    expect(
      securityScanWantsFallback({ ...base, status: 'failed', statusReason: 'infrastructure' }),
    ).toBe(false);
    expect(securityScanWantsFallback({ ...base, status: 'refused', modelUsed: CF })).toBe(false);
    expect(securityScanWantsFallback({ ...base, status: 'refused', modelUsed: null })).toBe(false);
    expect(securityScanWantsFallback({ ...base, status: 'refused', trigger: 'fallback' })).toBe(
      false,
    );
    expect(securityScanWantsFallback({ ...base, status: 'refused', trigger: 'local' })).toBe(false);
  });
});

describe('the @cf default a fallback runs on', () => {
  it('is the policy default when it is @cf, else the first usable @cf model', () => {
    expect(securityCfDefaultModel(policyWith({ defaultModel: CF_2 }))).toBe(CF_2);
    expect(securityCfDefaultModel(policyWith({ defaultModel: OPUS }))).toBe(CF);
    expect(securityCfDefaultModel(policyWith({ defaultModel: OPUS, blockedModels: [CF] }))).toBe(
      CF_2,
    );
  });

  it('is none when every @cf model is blocked: never a third-party model', () => {
    const policy = policyWith({ defaultModel: OPUS, blockedModels: [CF, CF_2] });
    expect(securityCfDefaultModel(policy)).toBeNull();
    expect(
      resolveSecurityScanModel(policy, { model: OPUS, noticeVersion: 1, trigger: 'fallback' }),
    ).toBeNull();
  });

  it('overrides the project model only for a fallback scan', () => {
    const policy = policyWith({
      defaultModel: OPUS,
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: true, anthropic: true },
      },
    });
    const project = { model: OPUS, noticeVersion: 1 };
    expect(resolveSecurityScanModel(policy, { ...project, trigger: 'deploy' })?.used).toBe(OPUS);
    expect(resolveSecurityScanModel(policy, { ...project, trigger: 'fallback' })).toEqual({
      requested: CF,
      used: CF,
      engine: 'void_loop',
    });
  });
});

describe('the policy change (operator preview)', () => {
  it('turns the fallback on and off with a preview line', () => {
    const current = policyWith({ fallbackToCf: false, defaultModel: CF });
    const stored = { policy: current, saved: true, unreadable: null };
    const on = proposeSecurityPolicyChange(
      stored,
      parseSecurityPolicyChangeRequest({ fallbackToCf: true }),
      { userId: 'usr_admin', now: Date.now() },
    );
    expect(on.changes.fallbackToCf).toBe(true);
    expect(on.next.fallbackToCf).toBe(true);
    const lines = securityPolicyPreviewLines(current, on.next, on.changes, {
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
    });
    expect(lines[0]).toContain(`Turn on: re-scan once on the @cf default (${CF})`);
    expect(() =>
      proposeSecurityPolicyChange(
        { policy: on.next, saved: true, unreadable: null },
        parseSecurityPolicyChangeRequest({ fallbackToCf: true }),
        { userId: 'usr_admin', now: Date.now() },
      ),
    ).toThrow('Nothing to change');
    expect(() => parseSecurityPolicyChangeRequest({ fallbackToCf: 'yes' })).toThrow(
      'fallbackToCf must be true or false',
    );
  });
});
