import { expect, it } from 'vite-plus/test';
import {
  securityModelCostNanoUsd,
  securityModelCostUsd,
  securityScanReserveUsd,
} from '../../src/security-models.ts';

// I7: a scan reserves its worst case at list price; calls add up in whole nano-dollars.
it('reserves the worst case of a scan and prices calls without drift', () => {
  expect(securityScanReserveUsd('@cf/zai-org/glm-5.3')).toBe(2.208);
  expect(securityScanReserveUsd('anthropic/claude-sonnet-5.5')).toBeNull();
  const limits = { maxInputTokens: 100_000, maxOutputTokens: 10_000 };
  expect(securityScanReserveUsd('anthropic/claude-opus-5.5', limits)).toBe(0.6);
  let total = 0;
  for (let call = 0; call < 1000; call += 1) {
    total += securityModelCostNanoUsd('@cf/zai-org/glm-5.3', 1234, 56)!;
  }
  expect(total).toBe(1000 * (1234 * 1400 + 56 * 4400));
  // Cached input at the cached rate; a model with no cached price pays the plain price.
  expect(securityModelCostNanoUsd('@cf/zai-org/glm-5.3', 100, 0, 60)).toBe(40 * 1400 + 60 * 260);
  expect(securityModelCostNanoUsd('openai/gpt-6.1-sol', 100, 0, 60)).toBe(100 * 2000);
  expect(securityModelCostUsd('anthropic/claude-sonnet-5.5', 10, 10)).toBeNull();
  expect(() => securityModelCostNanoUsd('@cf/zai-org/glm-5.3', -1, 0)).toThrow('inputTokens');
});
