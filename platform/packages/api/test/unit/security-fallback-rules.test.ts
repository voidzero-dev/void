import { defaultSecurityPolicy } from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { describe, expect, it } from 'vite-plus/test';
import { securityScanWantsFallback } from '../../src/security/fallback.ts';
import { resolveSecurityScanModel, securityCfDefaultModel } from '../../src/security/models.ts';

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
  it('re-scans only a refused, bad-output or timed-out third-party scan', () => {
    const base = { trigger: 'deploy', modelUsed: OPUS, statusReason: null, status: 'refused' };
    const wants = (patch: Partial<Parameters<typeof securityScanWantsFallback>[0]>) =>
      securityScanWantsFallback({ ...base, ...patch });
    expect(wants({})).toBe(true);
    expect(wants({ status: 'timed_out' })).toBe(true);
    expect(wants({ status: 'failed', statusReason: 'bad_output' })).toBe(true);
    expect(wants({ status: 'succeeded' })).toBe(false);
    expect(wants({ status: 'failed', statusReason: 'infrastructure' })).toBe(false);
    expect(wants({ modelUsed: CF })).toBe(false);
    expect(wants({ trigger: 'fallback' })).toBe(false);
  });
});

describe('the @cf default a fallback runs on', () => {
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
