/**
 * The models a security audit scan can run on, shared by the platform API (scheduler,
 * model proxy, budget, picker) and the CLI. This is the only list: a platform release
 * updates it when models or prices change.
 *
 * Prices are list prices in USD per million tokens. The spend meter and the scan
 * reserve use them; a model without a price cannot be picked until one is filled in.
 */

/** How the scanner runs a model (spec §8.1). Stored on `security_scans.engine`. */
export type SecurityEngine = 'void_loop' | 'agent_sdk' | 'codex_sdk';

/** Who runs the model. `workers-ai` is Cloudflare; the others are reached through AI Gateway. */
export type SecurityModelHost = 'workers-ai' | 'openai' | 'anthropic';

/** Hosts checked one by one by probe check 5 and named in the provider notice. */
export type SecurityThirdPartyHost = 'openai' | 'anthropic';

export type SecurityRefusalRisk = 'low' | 'medium' | 'medium-high';

export const SECURITY_MODEL_IDS = [
  '@cf/zai-org/glm-5.3',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  'openai/gpt-6.1-terra',
  'openai/gpt-6.1-sol',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
] as const;

export type SecurityModelId = (typeof SECURITY_MODEL_IDS)[number];

/** The installation default when the policy names none. */
export const DEFAULT_SECURITY_MODEL: SecurityModelId = '@cf/zai-org/glm-5.3';

export type SecurityModelPrice = Readonly<{
  /** USD per million input tokens. */
  inputUsdPerMillion: number;
  /** USD per million output tokens. */
  outputUsdPerMillion: number;
}>;

export type SecurityModel = Readonly<{
  id: SecurityModelId;
  host: SecurityModelHost;
  engine: SecurityEngine;
  /** Zero data retention listed in the AI Gateway catalog. */
  zeroDataRetention: boolean;
  refusalRisk: SecurityRefusalRisk;
  /** `null` until the list price is known; the model cannot be picked without it. */
  price: SecurityModelPrice | null;
}>;

/** In `SECURITY_MODEL_IDS` order, so the first `@cf/*` entry is the fallback model. */
export const SECURITY_MODELS: ReadonlyArray<SecurityModel> = [
  {
    id: '@cf/zai-org/glm-5.3',
    host: 'workers-ai',
    engine: 'void_loop',
    zeroDataRetention: true,
    refusalRisk: 'low',
    price: { inputUsdPerMillion: 1.4, outputUsdPerMillion: 4.4 },
  },
  {
    id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    host: 'workers-ai',
    engine: 'void_loop',
    zeroDataRetention: true,
    refusalRisk: 'low',
    price: { inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
  },
  {
    id: 'openai/gpt-6.1-terra',
    host: 'openai',
    engine: 'codex_sdk',
    zeroDataRetention: true,
    refusalRisk: 'medium-high',
    // Short-context price.
    price: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
  },
  {
    id: 'openai/gpt-6.1-sol',
    host: 'openai',
    engine: 'codex_sdk',
    zeroDataRetention: true,
    refusalRisk: 'medium-high',
    // Short-context price.
    price: { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    host: 'anthropic',
    engine: 'agent_sdk',
    // The catalog shows no ZDR badge, so it is treated as not ZDR.
    zeroDataRetention: false,
    refusalRisk: 'medium',
    // The list price is not known yet (design doc 0095, R6). Until it is, the model
    // is listed but cannot be picked.
    price: null,
  },
  {
    id: 'anthropic/claude-opus-5.5',
    host: 'anthropic',
    engine: 'agent_sdk',
    zeroDataRetention: true,
    refusalRisk: 'medium',
    price: { inputUsdPerMillion: 4, outputUsdPerMillion: 20 },
  },
];

/** Display names used in the provider notice and in copy. */
export const SECURITY_PROVIDER_NAMES: Readonly<Record<SecurityModelHost, string>> = {
  'workers-ai': 'Cloudflare',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * Version of the provider notice text below. Bump it when the text changes: a stored
 * acceptance with an older version no longer counts, so admins and projects are asked again.
 */
export const SECURITY_PROVIDER_NOTICE_VERSION = 1;

/** Token counts a scan reserve is computed from when no limits are given (spec §16.1). */
export const SECURITY_RESERVE_INPUT_TOKENS = 1_200_000;
export const SECURITY_RESERVE_OUTPUT_TOKENS = 120_000;

export function isSecurityModelId(value: unknown): value is SecurityModelId {
  return SECURITY_MODEL_IDS.some((id) => id === value);
}

export function getSecurityModel(id: SecurityModelId): SecurityModel {
  const model = SECURITY_MODELS.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`Unknown security model: ${id}.`);
  }
  return model;
}

/** Third-party host of a model, or `null` for Cloudflare-hosted models. */
export function securityModelThirdPartyHost(id: SecurityModelId): SecurityThirdPartyHost | null {
  const host = getSecurityModel(id).host;
  return host === 'workers-ai' ? null : host;
}

export function isThirdPartySecurityModel(id: SecurityModelId): boolean {
  return securityModelThirdPartyHost(id) !== null;
}

/**
 * A model is listed but not pickable while its price is unknown: the spend meter and
 * the caps need a price for every model that can run.
 */
export function isSecurityModelPriced(id: SecurityModelId): boolean {
  return getSecurityModel(id).price !== null;
}

/**
 * Up to three badges for the picker (spec §8.2); the refusal badge only when refusal
 * risk is not low.
 */
export function securityModelBadges(id: SecurityModelId): ReadonlyArray<string> {
  const model = getSecurityModel(id);
  const badges = [
    model.host === 'workers-ai' ? 'Cloudflare-hosted' : 'Third-party',
    model.zeroDataRetention ? 'Zero data retention' : 'No ZDR listed',
  ];
  if (model.refusalRisk !== 'low') {
    badges.push('May refuse security reviews');
  }
  return badges;
}

// Prices are kept as whole nano-dollars per token (USD per million × 1000), so costs
// add up in integers and a sum of many calls does not drift.
function nanoUsdPerToken(usdPerMillion: number): number {
  return Math.round(usdPerMillion * 1000);
}

function assertTokenCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
}

/**
 * Cost of `inputTokens` and `outputTokens` at the model's list price, in whole
 * nano-dollars. `null` when the model has no price.
 */
export function securityModelCostNanoUsd(
  id: SecurityModelId,
  inputTokens: number,
  outputTokens: number,
): number | null {
  assertTokenCount(inputTokens, 'inputTokens');
  assertTokenCount(outputTokens, 'outputTokens');
  const price = getSecurityModel(id).price;
  if (!price) {
    return null;
  }
  return (
    inputTokens * nanoUsdPerToken(price.inputUsdPerMillion) +
    outputTokens * nanoUsdPerToken(price.outputUsdPerMillion)
  );
}

/** The same cost in USD. `null` when the model has no price. */
export function securityModelCostUsd(
  id: SecurityModelId,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const nano = securityModelCostNanoUsd(id, inputTokens, outputTokens);
  return nano === null ? null : nano / 1_000_000_000;
}

/**
 * Worst-case cost of one scan, reserved against the caps when the scan starts:
 * `maxInputTokens × input price + maxOutputTokens × output price` (spec §16.1).
 * Defaults to the default policy limits. `null` when the model has no price.
 */
export function securityScanReserveUsd(
  id: SecurityModelId,
  limits: Readonly<{ maxInputTokens: number; maxOutputTokens: number }> = {
    maxInputTokens: SECURITY_RESERVE_INPUT_TOKENS,
    maxOutputTokens: SECURITY_RESERVE_OUTPUT_TOKENS,
  },
): number | null {
  return securityModelCostUsd(id, limits.maxInputTokens, limits.maxOutputTokens);
}

/**
 * The provider notice (spec §8.3), shown before a third-party model is used. The same
 * text goes to the admin panel, the CLI and the project page. Changing it needs a
 * `SECURITY_PROVIDER_NOTICE_VERSION` bump.
 */
export function securityProviderNotice(host: SecurityThirdPartyHost): ReadonlyArray<string> {
  const provider = SECURITY_PROVIDER_NAMES[host];
  return [
    `This model is run by ${provider}, not by Cloudflare.`,
    `Scans with this model send this project's changed code, the files it uses from this project, past findings and comments to ${provider} through Cloudflare AI Gateway. ${provider}'s own usage policy and safety filters apply.`,
    `${provider} may refuse to review code that looks security-related, even when the review is harmless. A refused scan shows as Refused, never as passed, and records no findings. The next deploy's scan covers the same changes.`,
    `${provider} may keep request data for a limited time, for example for abuse checks. Cloudflare-hosted models (@cf/…) do not keep or train on your code.`,
    'Scans run only on code this project deploys. Pick this model only if you own the code or may have it reviewed.',
    'Policies: anthropic.com/legal/aup · openai.com/policies/usage-policies · developers.cloudflare.com/workers-ai/platform/data-usage',
  ];
}

/** One-line form for deploy output, `status` and the findings email. */
export function securityProviderNoticeShort(id: SecurityModelId): string | null {
  const host = securityModelThirdPartyHost(id);
  if (!host) {
    return null;
  }
  return `Model ${id} is run by ${SECURITY_PROVIDER_NAMES[host]}. Its usage policy applies and it may refuse.`;
}
