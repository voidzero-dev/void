/**
 * The installation security audit policy (spec §5.3), shared by the platform API and
 * the CLI: type, defaults, the strict parser, limit ranges and the error codes the API
 * returns and the CLI reads.
 *
 * The policy is one `platform_settings` row. The API reads the stored row with
 * `readSecurityPolicy` (its lenient reader turns a throw into `disabled`) and checks a
 * new policy with the strict `parseSecurityPolicy` before the revision CAS write.
 */
import {
  DEFAULT_SECURITY_MODEL,
  isSecurityModelId,
  isSecurityModelPriced,
  isThirdPartySecurityModel,
  SECURITY_MODEL_IDS,
  type SecurityModelId,
} from './security-models.ts';
import { isPrintableText, record } from './validate.ts';

/** `platform_settings` key that holds the policy. */
export const SECURITY_POLICY_SETTINGS_KEY = 'securityAudits.policy';

export const SECURITY_MODES = ['disabled', 'public', 'all'] as const;
export type SecurityMode = (typeof SECURITY_MODES)[number];

/** Names shown in the admin panel and CLI output. */
export const SECURITY_MODE_LABELS: Readonly<Record<SecurityMode, string>> = {
  disabled: 'Off',
  public: 'Public projects only',
  all: 'All projects',
};

export type SecurityPolicyLimits = Readonly<{
  /** Running scans per installation. */
  concurrency: number;
  /** Wall clock per scan, the only timeout setting. */
  timeoutMinutes: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  modelCallsPerScan: number;
}>;

export type SecurityLimitKey = keyof SecurityPolicyLimits;

export type SecurityLimitRange = Readonly<{ min: number; max: number; default: number }>;

/**
 * Allowed whole-number range and default of every limit. Concurrency and timeout come
 * from the spec. The token and call ranges are ours: at their top, the most expensive
 * priced model reserves $12 per scan.
 */
export const SECURITY_LIMIT_RANGES: Readonly<Record<SecurityLimitKey, SecurityLimitRange>> = {
  concurrency: { min: 1, max: 10, default: 2 },
  timeoutMinutes: { min: 5, max: 60, default: 20 },
  maxInputTokens: { min: 50_000, max: 2_000_000, default: 1_200_000 },
  maxOutputTokens: { min: 5_000, max: 200_000, default: 120_000 },
  modelCallsPerScan: { min: 10, max: 200, default: 80 },
};

export const SECURITY_LIMIT_KEYS: ReadonlyArray<SecurityLimitKey> = [
  'concurrency',
  'timeoutMinutes',
  'maxInputTokens',
  'maxOutputTokens',
  'modelCallsPerScan',
];

export type SecurityPolicyBudgets = Readonly<{
  platformCapOn: boolean;
  /** Whole-installation cap in USD per calendar month (UTC). */
  platformMonthlyUsd: number;
  /** Applies `projectDefaultMonthlyUsd` to every project. */
  projectCapsOn: boolean;
  projectDefaultMonthlyUsd: number;
}>;

/** Highest USD amount a cap may be set to. */
export const SECURITY_MAX_MONTHLY_USD = 1_000_000;

/**
 * Scheduled full sweeps (spec §20 Phase 2): every `everyDays` days the hourly job
 * scans the live deployment of each project in scope in full, with the deeper
 * `standard` profile. Off by default: sweeps cost money and nothing asks for them.
 */
export type SecuritySweeps = Readonly<{
  on: boolean;
  everyDays: number;
}>;

/** Allowed range of `sweeps.everyDays`. */
export const SECURITY_SWEEP_DAYS_RANGE: SecurityLimitRange = { min: 7, max: 90, default: 30 };

export type SecurityThirdPartyNotice = Readonly<{
  acceptedByUserId: string;
  /** ISO 8601 timestamp. */
  acceptedAt: string;
  version: number;
}>;

export type SecurityEntitlement = Readonly<{
  /** ISO 8601 timestamp of the last probe. */
  checkedAt: string;
  /** Checks 1–4 passed. */
  ok: boolean;
  /** Names of the failed required checks. */
  missing: ReadonlyArray<string>;
  /** Probe check 5, per third-party host. */
  hosts: Readonly<{ openai: boolean; anthropic: boolean }>;
  /** While failing: when the probe first failed in this run of failures. */
  failingSince?: string;
}>;

export type SecurityPolicy = Readonly<{
  mode: SecurityMode;
  defaultModel: SecurityModelId;
  blockedModels: ReadonlyArray<SecurityModelId>;
  thirdPartyNotice: SecurityThirdPartyNotice | null;
  limits: SecurityPolicyLimits;
  budgets: SecurityPolicyBudgets;
  entitlement: SecurityEntitlement | null;
  /** "Scan before a project goes public" (spec §5.5). */
  publicGate: boolean;
  sweeps: SecuritySweeps;
  /**
   * Phase 2 (spec §8.5): after a third-party scan is refused, gives bad output or times
   * out, scan the same deployment once more on the `@cf` default. Off by default; it
   * never goes from `@cf` to a third-party model.
   */
  fallbackToCf: boolean;
  /** Phase 2 (spec §20): a weekly summary email to installation admins. Off by default. */
  digest: boolean;
  revision: number;
}>;

/** A fresh probe is needed to leave `disabled` or to turn the public gate on. */
export const SECURITY_ENTITLEMENT_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

/**
 * Error codes (the `error` field) the API returns for security audits, with their HTTP
 * status. The CLI matches on these strings. Capability off reuses the existing
 * `platform capability unavailable` (501).
 */
export type SecurityErrorCode =
  | 'security model not allowed'
  | 'provider notice not accepted'
  | 'security entitlement missing'
  | 'finding changed'
  | 'security budget above platform limit'
  | 'security public gate needs zero trust'
  | 'security public gate needs policy'
  | 'security public gate on'
  | 'no public request'
  | 'public request closed'
  | 'security public request has urgent findings'
  | 'scan bypass reason required'
  | 'security policy unreadable';

export type SecurityErrorName =
  | 'modelNotAllowed'
  | 'providerNoticeNotAccepted'
  | 'entitlementMissing'
  | 'findingChanged'
  | 'budgetAbovePlatformLimit'
  | 'publicGateNeedsZeroTrust'
  | 'publicGateNeedsPolicy'
  | 'publicGateOn'
  | 'noPublicRequest'
  | 'publicRequestClosed'
  | 'publicRequestHasUrgentFindings'
  | 'scanBypassReasonRequired'
  | 'policyUnreadable';

export type SecurityError = Readonly<{ code: SecurityErrorCode; status: 409 | 422 | 503 }>;

export const SECURITY_ERRORS: Readonly<Record<SecurityErrorName, SecurityError>> = {
  modelNotAllowed: { code: 'security model not allowed', status: 422 },
  providerNoticeNotAccepted: { code: 'provider notice not accepted', status: 422 },
  entitlementMissing: { code: 'security entitlement missing', status: 409 },
  findingChanged: { code: 'finding changed', status: 409 },
  budgetAbovePlatformLimit: { code: 'security budget above platform limit', status: 422 },
  publicGateNeedsZeroTrust: { code: 'security public gate needs zero trust', status: 409 },
  publicGateNeedsPolicy: { code: 'security public gate needs policy', status: 409 },
  publicGateOn: { code: 'security public gate on', status: 409 },
  noPublicRequest: { code: 'no public request', status: 409 },
  publicRequestClosed: { code: 'public request closed', status: 409 },
  publicRequestHasUrgentFindings: {
    code: 'security public request has urgent findings',
    status: 409,
  },
  scanBypassReasonRequired: { code: 'scan bypass reason required', status: 422 },
  policyUnreadable: { code: 'security policy unreadable', status: 503 },
};

export function isSecurityErrorCode(value: unknown): value is SecurityErrorCode {
  return Object.values(SECURITY_ERRORS).some((entry) => entry.code === value);
}

export function defaultSecurityLimits(): SecurityPolicyLimits {
  return {
    concurrency: SECURITY_LIMIT_RANGES.concurrency.default,
    timeoutMinutes: SECURITY_LIMIT_RANGES.timeoutMinutes.default,
    maxInputTokens: SECURITY_LIMIT_RANGES.maxInputTokens.default,
    maxOutputTokens: SECURITY_LIMIT_RANGES.maxOutputTokens.default,
    modelCallsPerScan: SECURITY_LIMIT_RANGES.modelCallsPerScan.default,
  };
}

export function defaultSecurityBudgets(): SecurityPolicyBudgets {
  return {
    platformCapOn: false,
    platformMonthlyUsd: 1000,
    projectCapsOn: false,
    projectDefaultMonthlyUsd: 100,
  };
}

export function defaultSecuritySweeps(): SecuritySweeps {
  return { on: false, everyDays: SECURITY_SWEEP_DAYS_RANGE.default };
}

/** `sweeps.everyDays`: a whole number of days in `SECURITY_SWEEP_DAYS_RANGE`. */
export function parseSecuritySweepDays(value: unknown): number {
  const range = SECURITY_SWEEP_DAYS_RANGE;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new Error(`sweeps.everyDays must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value;
}

/**
 * The sweep setting. A row saved before sweeps existed has none: that reads as Off.
 * The strict parser checks the range. The lenient reader clamps the days into it and
 * reads anything else it cannot use as Off, so bad data never starts paid scans.
 */
function parseSweeps(value: unknown, strict: boolean): SecuritySweeps {
  if (value === undefined) {
    return defaultSecuritySweeps();
  }
  if (strict) {
    const input = record(value, 'sweeps');
    return {
      on: parseBoolean(input.on, 'sweeps.on'),
      everyDays: parseSecuritySweepDays(input.everyDays),
    };
  }
  const input =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const days = input.everyDays;
  if (typeof input.on !== 'boolean' || typeof days !== 'number' || !Number.isSafeInteger(days)) {
    return defaultSecuritySweeps();
  }
  const range = SECURITY_SWEEP_DAYS_RANGE;
  return { on: input.on, everyDays: Math.min(range.max, Math.max(range.min, days)) };
}

/**
 * An on/off setting added after the first release. A row saved before it existed reads
 * as Off. The strict parser refuses anything but a boolean; the lenient reader reads it
 * as Off, so bad data never starts paid scans or sends mail.
 */
function parseAddedFlag(value: unknown, label: string, strict: boolean): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (strict) {
    throw new Error(`${label} must be true or false.`);
  }
  return false;
}

/** Longest webhook URL the API stores. */
export const SECURITY_WEBHOOK_URL_MAX = 2048;

/**
 * The security webhook URL (spec §20): `https` only, no user name or password in it
 * (the body is signed instead), at most `SECURITY_WEBHOOK_URL_MAX` characters.
 * Returns the normalized URL.
 */
export function parseSecurityWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SECURITY_WEBHOOK_URL_MAX) {
    throw new Error(
      `The webhook URL must be an https URL of at most ${SECURITY_WEBHOOK_URL_MAX} characters.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The webhook URL must be an https URL.');
  }
  if (url.protocol !== 'https:' || url.hostname === '') {
    throw new Error('The webhook URL must be an https URL.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('The webhook URL must not hold a user name or password.');
  }
  if (url.hash !== '') {
    throw new Error('The webhook URL must not have a #fragment.');
  }
  return url.href;
}

/** The policy of an installation that never saved one: Off, nothing accepted or probed. */
export function defaultSecurityPolicy(): SecurityPolicy {
  return {
    mode: 'disabled',
    defaultModel: DEFAULT_SECURITY_MODEL,
    blockedModels: [],
    thirdPartyNotice: null,
    limits: defaultSecurityLimits(),
    budgets: defaultSecurityBudgets(),
    entitlement: null,
    publicGate: false,
    sweeps: defaultSecuritySweeps(),
    fallbackToCf: false,
    digest: false,
    revision: 0,
  };
}

export function isSecurityMode(value: unknown): value is SecurityMode {
  return SECURITY_MODES.some((mode) => mode === value);
}

export function parseSecurityMode(value: unknown): SecurityMode {
  if (!isSecurityMode(value)) {
    throw new Error('Security audit mode must be disabled, public or all.');
  }
  return value;
}

export function parseSecurityModelId(value: unknown, label = 'Model'): SecurityModelId {
  if (!isSecurityModelId(value)) {
    throw new Error(`${label} must be one of: ${SECURITY_MODEL_IDS.join(', ')}.`);
  }
  return value;
}

export function parseSecurityLimit(key: SecurityLimitKey, value: unknown): number {
  const range = SECURITY_LIMIT_RANGES[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new Error(`${key} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value;
}

/** A full limits object: every key present, each in range. */
export function parseSecurityLimits(value: unknown): SecurityPolicyLimits {
  const input = record(value, 'Security limits');
  return {
    concurrency: parseSecurityLimit('concurrency', input.concurrency),
    timeoutMinutes: parseSecurityLimit('timeoutMinutes', input.timeoutMinutes),
    maxInputTokens: parseSecurityLimit('maxInputTokens', input.maxInputTokens),
    maxOutputTokens: parseSecurityLimit('maxOutputTokens', input.maxOutputTokens),
    modelCallsPerScan: parseSecurityLimit('modelCallsPerScan', input.modelCallsPerScan),
  };
}

/** A change to some limits. Unknown keys are refused so a typo is not silently ignored. */
export function parseSecurityLimitsPatch(value: unknown): Partial<SecurityPolicyLimits> {
  const input = record(value, 'Security limits');
  const patch: Partial<Record<SecurityLimitKey, number>> = {};
  for (const [key, limit] of Object.entries(input)) {
    const known = SECURITY_LIMIT_KEYS.find((candidate) => candidate === key);
    if (!known) {
      throw new Error(`Unknown security limit: ${key}.`);
    }
    patch[known] = parseSecurityLimit(known, limit);
  }
  return patch;
}

/** A USD amount for a monthly cap: 0 to `SECURITY_MAX_MONTHLY_USD`, whole cents. */
export function parseSecurityUsd(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > SECURITY_MAX_MONTHLY_USD ||
    Math.round(value * 100) / 100 !== value
  ) {
    throw new Error(
      `${label} must be a USD amount from 0 to ${SECURITY_MAX_MONTHLY_USD} with at most two decimals.`,
    );
  }
  return value;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be true or false.`);
  }
  return value;
}

export function parseSecurityBudgets(value: unknown): SecurityPolicyBudgets {
  const input = record(value, 'Security budgets');
  return {
    platformCapOn: parseBoolean(input.platformCapOn, 'platformCapOn'),
    platformMonthlyUsd: parseSecurityUsd(input.platformMonthlyUsd, 'platformMonthlyUsd'),
    projectCapsOn: parseBoolean(input.projectCapsOn, 'projectCapsOn'),
    projectDefaultMonthlyUsd: parseSecurityUsd(
      input.projectDefaultMonthlyUsd,
      'projectDefaultMonthlyUsd',
    ),
  };
}

/** A timestamp written by `Date.prototype.toISOString`. */
function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be an ISO 8601 timestamp.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`);
  }
  return value;
}

function parseNoticeVersion(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return value;
}

export function parseSecurityThirdPartyNotice(value: unknown): SecurityThirdPartyNotice {
  const input = record(value, 'thirdPartyNotice');
  if (!isPrintableText(input.acceptedByUserId, 200)) {
    throw new Error('thirdPartyNotice.acceptedByUserId must be a user ID.');
  }
  return {
    acceptedByUserId: input.acceptedByUserId,
    acceptedAt: parseIsoTimestamp(input.acceptedAt, 'thirdPartyNotice.acceptedAt'),
    version: parseNoticeVersion(input.version, 'thirdPartyNotice.version'),
  };
}

export function parseSecurityEntitlement(value: unknown): SecurityEntitlement {
  const input = record(value, 'entitlement');
  // Check names stay open text so a probe from a later release still reads.
  if (
    !Array.isArray(input.missing) ||
    input.missing.length > 20 ||
    !input.missing.every((name) => isPrintableText(name, 64))
  ) {
    throw new Error('entitlement.missing must list at most 20 check names.');
  }
  const ok = parseBoolean(input.ok, 'entitlement.ok');
  if (ok !== (input.missing.length === 0)) {
    throw new Error('entitlement.ok must be true exactly when no check is missing.');
  }
  const hosts = record(input.hosts, 'entitlement.hosts');
  return {
    checkedAt: parseIsoTimestamp(input.checkedAt, 'entitlement.checkedAt'),
    ok,
    missing: input.missing.slice(),
    hosts: {
      openai: parseBoolean(hosts.openai, 'entitlement.hosts.openai'),
      anthropic: parseBoolean(hosts.anthropic, 'entitlement.hosts.anthropic'),
    },
    // Added later, so a row without it still reads; a passing probe has none.
    ...(!ok && input.failingSince !== undefined
      ? { failingSince: parseIsoTimestamp(input.failingSince, 'entitlement.failingSince') }
      : {}),
  };
}

export function parseSecurityBlockedModels(value: unknown): ReadonlyArray<SecurityModelId> {
  if (!Array.isArray(value)) {
    throw new Error('blockedModels must be a list of model IDs.');
  }
  const blocked: Array<SecurityModelId> = [];
  for (const entry of value) {
    const id = parseSecurityModelId(entry, 'Each blocked model');
    if (blocked.includes(id)) {
      throw new Error(`Blocked model listed twice: ${id}.`);
    }
    blocked.push(id);
  }
  return blocked;
}

/**
 * Checks the rules that tie policy fields together. Runtime conditions (a fresh probe,
 * Zero Trust state, a running operation) are checked by the API when it writes.
 */
export function assertSecurityPolicyConsistent(policy: SecurityPolicy): void {
  if (policy.blockedModels.includes(policy.defaultModel)) {
    throw new Error(`The default model ${policy.defaultModel} is blocked.`);
  }
  if (!isSecurityModelPriced(policy.defaultModel)) {
    throw new Error(`The default model ${policy.defaultModel} has no price yet.`);
  }
  if (isThirdPartySecurityModel(policy.defaultModel) && policy.thirdPartyNotice === null) {
    throw new Error(
      `The default model ${policy.defaultModel} is third-party and needs the accepted provider notice.`,
    );
  }
  if (policy.publicGate && policy.mode === 'disabled') {
    throw new Error('Scan before public needs the policy to be public or all.');
  }
}

function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Security policy revision must be a nonnegative whole number.');
  }
  return value;
}

/**
 * Strict check of a policy about to be written. Every known field must be present and
 * valid, and the fields must agree with each other. Unknown fields are ignored. Throws
 * on bad data. Read a stored row with `readSecurityPolicy` instead.
 */
export function parseSecurityPolicy(value: unknown): SecurityPolicy {
  const input = record(value, 'Security policy');
  const revision = parseRevision(input.revision);
  const policy: SecurityPolicy = {
    mode: parseSecurityMode(input.mode),
    defaultModel: parseSecurityModelId(input.defaultModel, 'defaultModel'),
    blockedModels: parseSecurityBlockedModels(input.blockedModels),
    thirdPartyNotice:
      input.thirdPartyNotice === null
        ? null
        : parseSecurityThirdPartyNotice(input.thirdPartyNotice),
    limits: parseSecurityLimits(input.limits),
    budgets: parseSecurityBudgets(input.budgets),
    entitlement: input.entitlement === null ? null : parseSecurityEntitlement(input.entitlement),
    publicGate: parseBoolean(input.publicGate, 'publicGate'),
    sweeps: parseSweeps(input.sweeps, true),
    fallbackToCf: parseAddedFlag(input.fallbackToCf, 'fallbackToCf', true),
    digest: parseAddedFlag(input.digest, 'digest', true),
    revision,
  };
  assertSecurityPolicyConsistent(policy);
  return policy;
}

/** Known ids only, each once. Ids a later release added are dropped. */
function readBlockedModels(value: unknown): ReadonlyArray<SecurityModelId> {
  if (!Array.isArray(value)) {
    throw new Error('blockedModels must be a list of model IDs.');
  }
  const blocked: Array<SecurityModelId> = [];
  for (const entry of value) {
    if (isSecurityModelId(entry) && !blocked.includes(entry)) {
      blocked.push(entry);
    }
  }
  return blocked;
}

/**
 * Each limit clamped into today's range. A limit this release has and the row lacks
 * takes its default.
 */
function readLimits(value: unknown): SecurityPolicyLimits {
  const input = record(value, 'Security limits');
  const read = (key: SecurityLimitKey): number => {
    const range = SECURITY_LIMIT_RANGES[key];
    const limit = input[key];
    if (limit === undefined) {
      return range.default;
    }
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit)) {
      throw new Error(`${key} must be a whole number.`);
    }
    return Math.min(range.max, Math.max(range.min, limit));
  };
  return {
    concurrency: read('concurrency'),
    timeoutMinutes: read('timeoutMinutes'),
    maxInputTokens: read('maxInputTokens'),
    maxOutputTokens: read('maxOutputTokens'),
    modelCallsPerScan: read('modelCallsPerScan'),
  };
}

function canBeDefaultModel(
  id: SecurityModelId,
  blocked: ReadonlyArray<SecurityModelId>,
  notice: SecurityThirdPartyNotice | null,
): boolean {
  return (
    !blocked.includes(id) &&
    isSecurityModelPriced(id) &&
    (notice !== null || !isThirdPartySecurityModel(id))
  );
}

/**
 * The stored default if this release can still run it, else the first non-blocked,
 * priced `@cf` model (spec §8.2, edge case 23). `SECURITY_MODEL_IDS` lists `@cf`
 * models first, so a third-party model is only reached when every `@cf` model is
 * blocked, and only with the notice accepted.
 */
function readDefaultModel(
  value: unknown,
  blocked: ReadonlyArray<SecurityModelId>,
  notice: SecurityThirdPartyNotice | null,
): SecurityModelId {
  if (isSecurityModelId(value) && canBeDefaultModel(value, blocked, notice)) {
    return value;
  }
  const fallback = SECURITY_MODEL_IDS.find((id) => canBeDefaultModel(id, blocked, notice));
  if (!fallback) {
    throw new Error('No model can run: every priced model is blocked.');
  }
  return fallback;
}

/**
 * Reader of the stored policy row. Data another release could have written still
 * reads: unknown blocked models are dropped, an unknown, unpriced or blocked default
 * falls back (`readDefaultModel`), limits are clamped into range. Anything else that
 * `parseSecurityPolicy` refuses throws here too; the API decides whether that reads
 * as `disabled` or fails closed.
 */
export function readSecurityPolicy(value: unknown): SecurityPolicy {
  const input = record(value, 'Security policy');
  const revision = parseRevision(input.revision);
  const thirdPartyNotice =
    input.thirdPartyNotice === null ? null : parseSecurityThirdPartyNotice(input.thirdPartyNotice);
  const blockedModels = readBlockedModels(input.blockedModels);
  const policy: SecurityPolicy = {
    mode: parseSecurityMode(input.mode),
    defaultModel: readDefaultModel(input.defaultModel, blockedModels, thirdPartyNotice),
    blockedModels,
    thirdPartyNotice,
    limits: readLimits(input.limits),
    budgets: parseSecurityBudgets(input.budgets),
    entitlement: input.entitlement === null ? null : parseSecurityEntitlement(input.entitlement),
    publicGate: parseBoolean(input.publicGate, 'publicGate'),
    sweeps: parseSweeps(input.sweeps, false),
    fallbackToCf: parseAddedFlag(input.fallbackToCf, 'fallbackToCf', false),
    digest: parseAddedFlag(input.digest, 'digest', false),
    revision,
  };
  assertSecurityPolicyConsistent(policy);
  return policy;
}

/** The last probe passed checks 1–4 less than 24 hours before `now` (ms). */
export function isSecurityEntitlementFresh(
  entitlement: SecurityEntitlement | null,
  now: number,
): boolean {
  if (!entitlement || !entitlement.ok) {
    return false;
  }
  const age = now - Date.parse(entitlement.checkedAt);
  return age >= 0 && age < SECURITY_ENTITLEMENT_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Per-plan scan caps (Phase 2, M27)
// ---------------------------------------------------------------------------

/**
 * `platform_settings` key of the per-plan monthly scan caps. Kept out of
 * `plans:catalog` (and `PlanLimits`): the saved-catalog parser needs the exact limit
 * keys, and an older API rebuilds the catalog from known keys on every write, so a cap
 * stored there would break deploys or be lost after a rollback (same as
 * `plans:ai-logging`).
 */
export const PLAN_SECURITY_CAPS_SETTING = 'plans:security-caps';

/** Plan ID -> monthly cap in whole cents, or `null` = no cap for that plan. Missing = policy default. */
export type PlanSecurityCaps = Readonly<Record<string, number | null>>;

/**
 * One plan's cap: whole cents, `none` (no cap from the plan, even with project caps
 * on) or `inherit` (the policy's default project cap applies while project caps are on).
 */
export type SecurityPlanCap = number | 'none' | 'inherit';

const PLAN_KEY_MAX = 64;
const MAX_PLAN_CAP_CENTS = SECURITY_MAX_MONTHLY_USD * 100;

function isPlanSecurityCapCents(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PLAN_CAP_CENTS
  );
}

/** One stored entry as a plan cap; `undefined` when it is neither whole cents nor `null`. */
export function readStoredPlanSecurityCap(entry: unknown): SecurityPlanCap | undefined {
  if (entry === null) {
    return 'none';
  }
  return isPlanSecurityCapCents(entry) ? entry : undefined;
}

/** A plan ID: a lowercase letter, then lowercase letters, digits or hyphens, at most 64. */
function isPlanKey(key: string): boolean {
  if (key.length === 0 || key.length > PLAN_KEY_MAX || key[0]! < 'a' || key[0]! > 'z') {
    return false;
  }
  for (const char of key) {
    const ok = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

/**
 * Reads a stored caps row. Lenient: an entry that is not a plan ID with whole cents or
 * `null` is left out (that plan inherits) and counted in `dropped`, so one bad entry
 * never stops plan edits or scans. A row that is not an object reads as empty.
 */
export function readPlanSecurityCaps(
  value: unknown,
): Readonly<{ caps: PlanSecurityCaps; dropped: number }> {
  if (value === null || value === undefined) {
    return { caps: {}, dropped: 0 };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { caps: {}, dropped: 1 };
  }
  const caps: Record<string, number | null> = {};
  let dropped = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isPlanKey(key) && (entry === null || isPlanSecurityCapCents(entry))) {
      caps[key] = entry;
    } else {
      dropped++;
    }
  }
  return { caps, dropped };
}

/** One stored entry (`undefined` when the plan has none) as a plan cap. */
export function securityPlanCapOf(entry: number | null | undefined): SecurityPlanCap {
  if (entry === undefined) {
    return 'inherit';
  }
  return entry === null ? 'none' : entry;
}

/** The cap of one plan in a caps row. */
export function planSecurityCap(caps: PlanSecurityCaps, planId: string): SecurityPlanCap {
  return securityPlanCapOf(Object.hasOwn(caps, planId) ? caps[planId] : undefined);
}

/**
 * Reads a plan change's `securityCap` field: a USD amount (0 to
 * `SECURITY_MAX_MONTHLY_USD`, whole cents), `none` or `inherit`. `undefined` keeps the
 * plan's current cap. An amount comes back in cents.
 */
export function parsePlanSecurityCapInput(value: unknown): SecurityPlanCap | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'none' || value === 'inherit') {
    return value;
  }
  if (typeof value === 'number') {
    return Math.round(parseSecurityUsd(value, 'securityCap') * 100);
  }
  throw new Error(
    `securityCap must be a USD amount from 0 to ${SECURITY_MAX_MONTHLY_USD}, "none" or "inherit".`,
  );
}

/** A caps row with one plan's cap changed; `inherit` leaves the plan out. */
export function withPlanSecurityCap(
  caps: PlanSecurityCaps,
  planId: string,
  cap: SecurityPlanCap,
): PlanSecurityCaps {
  const next: Record<string, number | null> = {};
  for (const [key, entry] of Object.entries(caps)) {
    if (key !== planId) {
      next[key] = entry;
    }
  }
  if (cap !== 'inherit') {
    next[planId] = cap === 'none' ? null : cap;
  }
  return next;
}

/** `$50.00 / month`, `no cap` or `policy default`, for the CLI and the admin panel. */
export function formatPlanSecurityCap(cap: SecurityPlanCap): string {
  if (cap === 'inherit') {
    return 'policy default';
  }
  if (cap === 'none') {
    return 'no cap';
  }
  const dollars = Math.floor(cap / 100);
  const cents = String(cap % 100).padStart(2, '0');
  return `$${dollars.toLocaleString('en-US')}.${cents} / month`;
}

// ---------------------------------------------------------------------------
// Form text (the project security page on the API host and the dashboard)
// ---------------------------------------------------------------------------

/** `text` as a whole number written with 1 to `maxDigits` ASCII digits, else `null`. */
export function parseSecurityDigits(text: string, maxDigits: number): number | null {
  if (text.length === 0 || text.length > maxDigits) {
    return null;
  }
  for (const char of text) {
    if (char < '0' || char > '9') {
      return null;
    }
  }
  return Number(text);
}

/** A finding label as the page prints it (`F-12`): its number, else `null`. */
export function parseSecurityFindingLabel(text: string): number | null {
  return text.startsWith('F-') ? parseSecurityDigits(text.slice(2), 9) : null;
}

/**
 * A finding trace of `{ file, line, note }` steps as `file:line  note` lines, the way the
 * CLI and the project page print it; `null` for a trace of another shape. The text is as
 * stored: callers escape or clean it for where it goes.
 */
export function securityTraceLines(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const lines: Array<string> = [];
  for (const step of value) {
    const { file, line, note } = (step ?? {}) as Record<string, unknown>;
    if (typeof file !== 'string' || typeof note !== 'string') {
      return null;
    }
    lines.push(`${file}${typeof line === 'number' ? `:${line}` : ''}  ${note}`);
  }
  return lines;
}

/**
 * A dollar amount typed in a budget form, such as `50`, `12.50` or `$12.50`. Empty text
 * is `null` (no cap of its own); text that is not an amount is `undefined`. The range is
 * checked by `parseSecurityUsd` on the server.
 */
export function parseSecurityUsdText(text: string): number | null | undefined {
  let amount = text.trim();
  if (amount === '') {
    return null;
  }
  if (amount.startsWith('$')) {
    amount = amount.slice(1);
  }
  const dot = amount.indexOf('.');
  const whole = dot === -1 ? amount : amount.slice(0, dot);
  if (parseSecurityDigits(whole, 7) === null) {
    return undefined;
  }
  if (dot !== -1 && parseSecurityDigits(amount.slice(dot + 1), 2) === null) {
    return undefined;
  }
  return Number(amount);
}
