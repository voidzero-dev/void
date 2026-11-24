import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_SECURITY_MODEL,
  getSecurityModel,
  isSecurityModelId,
  isSecurityModelPriced,
  isThirdPartySecurityModel,
  SECURITY_MODEL_IDS,
  SECURITY_MODELS,
  SECURITY_PROVIDER_NOTICE_VERSION,
  securityModelBadges,
  securityModelCostNanoUsd,
  securityModelCostUsd,
  securityModelThirdPartyHost,
  securityProviderNotice,
  securityProviderNoticeShort,
  securityScanReserveUsd,
} from '../../src/security-models.ts';
import type { SecurityModelId } from '../../src/security-models.ts';

describe('security model list', () => {
  it('lists six models in fallback order, the default first', () => {
    expect(SECURITY_MODELS.map((model) => model.id)).toEqual([...SECURITY_MODEL_IDS]);
    expect(SECURITY_MODEL_IDS).toHaveLength(6);
    expect(DEFAULT_SECURITY_MODEL).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(SECURITY_MODEL_IDS[0]).toBe(DEFAULT_SECURITY_MODEL);
    expect(new Set(SECURITY_MODEL_IDS).size).toBe(SECURITY_MODEL_IDS.length);
  });

  it('uses the AI Gateway catalog spelling for ids', () => {
    interface ProviderPrefixes {
      readonly [provider: string]: string;
    }
    const prefixes: ProviderPrefixes = {
      'workers-ai': '@cf/',
      openai: 'openai/',
      anthropic: 'anthropic/',
    };
    for (const model of SECURITY_MODELS) {
      expect(model.id.startsWith(prefixes[model.host])).toBe(true);
      expect(model.id).toBe(model.id.toLowerCase());
      expect(model.id.includes(' ')).toBe(false);
    }
    // Versions keep their dots: `claude-opus-5.5`, not the API spelling `claude-opus-5-5`.
    expect(SECURITY_MODEL_IDS).toContain('anthropic/claude-opus-5.5');
    expect(SECURITY_MODEL_IDS).toContain('anthropic/claude-sonnet-5.5');
    expect(SECURITY_MODEL_IDS.some((id) => id.endsWith('-5-5'))).toBe(false);
  });

  it('maps each host to its engine', () => {
    for (const model of SECURITY_MODELS) {
      const expected =
        model.host === 'workers-ai'
          ? 'void_loop'
          : model.host === 'openai'
            ? 'codex_sdk'
            : 'agent_sdk';
      expect(model.engine).toBe(expected);
    }
    expect(securityModelThirdPartyHost('@cf/zai-org/glm-5.3')).toBeNull();
    expect(securityModelThirdPartyHost('openai/gpt-6.1-sol')).toBe('openai');
    expect(securityModelThirdPartyHost('anthropic/claude-opus-5.5')).toBe('anthropic');
    expect(isThirdPartySecurityModel('@cf/deepseek-ai/deepseek-v4.1-flash-1017')).toBe(false);
    expect(isThirdPartySecurityModel('openai/gpt-6.1-terra')).toBe(true);
  });

  it('recognizes only listed ids', () => {
    for (const id of SECURITY_MODEL_IDS) {
      expect(isSecurityModelId(id)).toBe(true);
    }
    for (const value of [
      'anthropic/claude-opus-5-5',
      'claude-opus-5.5',
      '@cf/zai-org/GLM-5.3',
      '',
      null,
      undefined,
      1,
    ]) {
      expect(isSecurityModelId(value)).toBe(false);
    }
    expect(() => getSecurityModel('nope' as SecurityModelId)).toThrow('Unknown security model');
  });
});

describe('security model prices', () => {
  it('has a price for every model except Sonnet, which cannot be picked yet', () => {
    for (const model of SECURITY_MODELS) {
      if (model.id === 'anthropic/claude-sonnet-5.5') {
        expect(model.price).toBeNull();
        expect(isSecurityModelPriced(model.id)).toBe(false);
        continue;
      }
      expect(model.price).not.toBeNull();
      expect(model.price!.inputUsdPerMillion).toBeGreaterThan(0);
      expect(model.price!.outputUsdPerMillion).toBeGreaterThan(0);
      expect(isSecurityModelPriced(model.id)).toBe(true);
    }
  });

  it('matches the spec §8.2 list prices', () => {
    const prices = Object.fromEntries(
      SECURITY_MODELS.map((model) => [
        model.id,
        model.price && [model.price.inputUsdPerMillion, model.price.outputUsdPerMillion],
      ]),
    );
    expect(prices).toEqual({
      '@cf/zai-org/glm-5.3': [1.4, 4.4],
      '@cf/deepseek-ai/deepseek-v4.1-flash-1017': [0.3, 1.2],
      'openai/gpt-6.1-terra': [1, 5],
      'openai/gpt-6.1-sol': [2, 10],
      'anthropic/claude-sonnet-5.5': null,
      'anthropic/claude-opus-5.5': [4, 20],
    });
  });

  it('reserves 1.2M input and 120k output tokens per scan (S4/S8 follow-up of spec §16.1)', () => {
    const reserves = Object.fromEntries(
      SECURITY_MODEL_IDS.map((id) => [id, securityScanReserveUsd(id)?.toFixed(2) ?? null]),
    );
    expect(reserves).toEqual({
      '@cf/deepseek-ai/deepseek-v4.1-flash-1017': '0.50',
      'openai/gpt-6.1-terra': '1.80',
      '@cf/zai-org/glm-5.3': '2.21',
      'openai/gpt-6.1-sol': '3.60',
      'anthropic/claude-opus-5.5': '7.20',
      'anthropic/claude-sonnet-5.5': null,
    });
    expect(securityScanReserveUsd('@cf/zai-org/glm-5.3')).toBe(2.208);
  });

  it('follows the policy token limits', () => {
    expect(
      securityScanReserveUsd('anthropic/claude-opus-5.5', {
        maxInputTokens: 100_000,
        maxOutputTokens: 10_000,
      }),
    ).toBe(0.6);
  });

  it('adds call costs in whole nano-dollars without drift', () => {
    expect(securityModelCostNanoUsd('@cf/deepseek-ai/deepseek-v4.1-flash-1017', 1, 1)).toBe(1500);
    let total = 0;
    for (let call = 0; call < 1000; call += 1) {
      total += securityModelCostNanoUsd('@cf/zai-org/glm-5.3', 1234, 56)!;
    }
    expect(total).toBe(1000 * (1234 * 1400 + 56 * 4400));
    expect(securityModelCostUsd('openai/gpt-6.1-sol', 1_000_000, 0)).toBe(2);
    expect(securityModelCostUsd('anthropic/claude-sonnet-5.5', 10, 10)).toBeNull();
    expect(securityModelCostUsd('openai/gpt-6.1-sol', 0, 0)).toBe(0);
  });

  it('prices cached input at the Workers AI cached rate, and the rest at list', () => {
    // 1.2M in (1.1M cached) + 15.6k out on deepseek: about what the gateway charges.
    expect(
      securityModelCostNanoUsd(
        '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        1_200_000,
        15_600,
        1_100_000,
      ),
    ).toBe(100_000 * 300 + 1_100_000 * 6 + 15_600 * 1200);
    expect(securityModelCostNanoUsd('@cf/zai-org/glm-5.3', 100, 0, 60)).toBe(40 * 1400 + 60 * 260);
    // No cached price listed: cached input costs the plain input price.
    expect(securityModelCostNanoUsd('openai/gpt-6.1-sol', 100, 0, 60)).toBe(100 * 2000);
    // The reserve stays at list price.
    expect(securityScanReserveUsd('@cf/deepseek-ai/deepseek-v4.1-flash-1017')).toBe(0.504);
  });

  it('refuses token counts that are not whole and nonnegative', () => {
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => securityModelCostNanoUsd('@cf/zai-org/glm-5.3', tokens, 0)).toThrow(
        'inputTokens',
      );
      expect(() => securityModelCostNanoUsd('@cf/zai-org/glm-5.3', 0, tokens)).toThrow(
        'outputTokens',
      );
    }
  });
});

describe('security model badges and notice', () => {
  it('shows host, data retention and refusal badges', () => {
    expect(securityModelBadges('@cf/zai-org/glm-5.3')).toEqual([
      'Cloudflare-hosted',
      'Zero data retention',
    ]);
    expect(securityModelBadges('anthropic/claude-sonnet-5.5')).toEqual([
      'Third-party',
      'No ZDR listed',
      'May refuse security reviews',
    ]);
    expect(securityModelBadges('openai/gpt-6.1-terra')).toEqual([
      'Third-party',
      'Zero data retention',
      'May refuse security reviews',
    ]);
  });

  it('names the provider in the notice and short line', () => {
    expect(SECURITY_PROVIDER_NOTICE_VERSION).toBe(1);
    const notice = securityProviderNotice('anthropic');
    expect(notice[0]).toBe('This model is run by Anthropic, not by Cloudflare.');
    expect(notice.join('\n')).not.toContain('OpenAI may');
    expect(securityProviderNotice('openai')[0]).toBe(
      'This model is run by OpenAI, not by Cloudflare.',
    );
    expect(securityProviderNoticeShort('anthropic/claude-opus-5.5')).toBe(
      'Model anthropic/claude-opus-5.5 is run by Anthropic. Its usage policy applies and it may refuse.',
    );
    expect(securityProviderNoticeShort('@cf/zai-org/glm-5.3')).toBeNull();
  });
});
