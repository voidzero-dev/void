/**
 * The installation security audit policy (spec §5.3), shared by the platform API and the
 * CLI. The API checks a new policy with the strict `parseSecurityPolicy` and reads the
 * stored row with the lenient `readSecurityPolicy`.
 */
import {
  DEFAULT_SECURITY_MODEL,
  isSecurityModelId,
  isSecurityModelPriced,
  isThirdPartySecurityModel,
  SECURITY_MODEL_IDS,
} from './security-models.ts';
import type { SecurityModelId } from './security-models.ts';
import { isPrintableText, isRecord, record } from './validate.ts';

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

export type SecurityLimitRange = Readonly<{ min: number; max: number; default: number }>;

/**
 * Allowed whole-number range and default of every limit. Concurrency and timeout come
 * from the spec. The token and call ranges are ours: at their top, the most expensive
 * priced model reserves $12 per scan.
 */
export const SECURITY_LIMIT_RANGES = {
  /** Running scans per installation. */
  concurrency: { min: 1, max: 10, default: 2 },
  /** Wall clock per scan, the only timeout setting. */
  timeoutMinutes: { min: 5, max: 60, default: 20 },
  maxInputTokens: { min: 50_000, max: 2_000_000, default: 1_200_000 },
  maxOutputTokens: { min: 5000, max: 200_000, default: 120_000 },
  modelCallsPerScan: { min: 10, max: 200, default: 80 },
} as const;

export type SecurityLimitKey = keyof typeof SECURITY_LIMIT_RANGES;
export type SecurityPolicyLimits = Readonly<Record<SecurityLimitKey, number>>;

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

/** Scheduled full sweeps (spec §20 Phase 2). Off by default: they cost money. */
export type SecuritySweeps = Readonly<{ on: boolean; everyDays: number }>;

const SECURITY_SWEEP_DAYS_RANGE: SecurityLimitRange = { min: 7, max: 90, default: 30 };

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
  /** Spec §8.5: re-scan once on the `@cf` default after a third-party scan fails. */
  fallbackToCf: boolean;
  /** Spec §20: a weekly summary email to installation admins. */
  digest: boolean;
  revision: number;
}>;

/** A fresh probe is needed to leave `disabled` or to turn the public gate on. */
export const SECURITY_ENTITLEMENT_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

/**
 * Error codes (the `error` field) the API returns for security audits, with their HTTP
 * status. The CLI matches on these strings.
 */
export const SECURITY_ERRORS = {
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
} as const;

export type SecurityErrorName = keyof typeof SECURITY_ERRORS;
export type SecurityError = (typeof SECURITY_ERRORS)[SecurityErrorName];

export function defaultSecurityBudgets(): SecurityPolicyBudgets {
  return {
    platformCapOn: false,
    platformMonthlyUsd: 1000,
    projectCapsOn: false,
    projectDefaultMonthlyUsd: 100,
  };
}

function wholeInRange(value: unknown, range: SecurityLimitRange, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < range.min ||
    value > range.max
  ) {
    throw new Error(`${label} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value;
}

/** `sweeps.everyDays`: a whole number of days in `SECURITY_SWEEP_DAYS_RANGE`. */
export function parseSecuritySweepDays(value: unknown): number {
  return wholeInRange(value, SECURITY_SWEEP_DAYS_RANGE, 'sweeps.everyDays');
}

/**
 * The sweep setting; a row saved before sweeps existed reads as Off. The lenient reader
 * clamps the days and reads anything else as Off, so bad data never starts paid scans.
 */
function parseSweeps(value: unknown, strict: boolean): SecuritySweeps {
  const off = { on: false, everyDays: SECURITY_SWEEP_DAYS_RANGE.default };
  if (value === undefined) {
    return off;
  }
  if (strict) {
    const input = record(value, 'sweeps');
    return {
      on: parseBoolean(input.on, 'sweeps.on'),
      everyDays: parseSecuritySweepDays(input.everyDays),
    };
  }
  const input: Record<string, unknown> = isRecord(value) ? value : {};
  const days = input.everyDays;
  if (typeof input.on !== 'boolean' || typeof days !== 'number' || !Number.isSafeInteger(days)) {
    return off;
  }
  const range = SECURITY_SWEEP_DAYS_RANGE;
  return { on: input.on, everyDays: Math.min(range.max, Math.max(range.min, days)) };
}

/**
 * An on/off setting added after the first release; a missing one reads as Off. The
 * lenient reader reads a bad value as Off, so bad data never starts paid scans or mail.
 */
function parseAddedFlag(value: unknown, label: string, strict: boolean): boolean {
  if (value === undefined || (!strict && typeof value !== 'boolean')) {
    return false;
  }
  return parseBoolean(value, label);
}

/**
 * The security webhook URL (spec §20): `https` only, no user name or password (the body
 * is signed instead), at most 2048 characters. Returns the normalized URL.
 */
export function parseSecurityWebhookUrl(value: unknown): string {
  const max = 2048;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`The webhook URL must be an https URL of at most ${max} characters.`);
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
    limits: limitsFrom({}, false),
    budgets: defaultSecurityBudgets(),
    entitlement: null,
    publicGate: false,
    sweeps: parseSweeps(undefined, true),
    fallbackToCf: false,
    digest: false,
    revision: 0,
  };
}

export function isSecurityMode(value: unknown): value is SecurityMode {
  return SECURITY_MODES.some((mode) => mode === value);
}

function parseModelId(value: unknown, label: string): SecurityModelId {
  if (!isSecurityModelId(value)) {
    throw new Error(`${label} must be one of: ${SECURITY_MODEL_IDS.join(', ')}.`);
  }
  return value;
}

/**
 * Every limit, each in range. The lenient reader clamps a limit into today's range and
 * gives a limit the row lacks its default.
 */
function limitsFrom(value: unknown, strict: boolean): SecurityPolicyLimits {
  const input = record(value, 'Security limits');
  const read = (key: SecurityLimitKey): number => {
    const range = SECURITY_LIMIT_RANGES[key];
    const limit = input[key];
    if (strict) {
      return wholeInRange(limit, range, key);
    }
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

/** A change to some limits. Unknown keys are refused so a typo is not silently ignored. */
export function parseSecurityLimitsPatch(value: unknown): Partial<SecurityPolicyLimits> {
  const input = record(value, 'Security limits');
  const patch: Partial<Record<SecurityLimitKey, number>> = {};
  for (const [key, limit] of Object.entries(input)) {
    const known = SECURITY_LIMIT_KEYS.find((candidate) => candidate === key);
    if (!known) {
      throw new Error(`Unknown security limit: ${key}.`);
    }
    patch[known] = wholeInRange(limit, SECURITY_LIMIT_RANGES[known], known);
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

function parseBudgets(value: unknown): SecurityPolicyBudgets {
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
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`);
  }
  return String(value);
}

function parseNotice(value: unknown): SecurityThirdPartyNotice | null {
  if (value === null) {
    return null;
  }
  const input = record(value, 'thirdPartyNotice');
  if (!isPrintableText(input.acceptedByUserId, 200)) {
    throw new Error('thirdPartyNotice.acceptedByUserId must be a user ID.');
  }
  const acceptedAt = parseIsoTimestamp(input.acceptedAt, 'thirdPartyNotice.acceptedAt');
  const version = input.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('thirdPartyNotice.version must be a positive whole number.');
  }
  return { acceptedByUserId: input.acceptedByUserId, acceptedAt, version };
}

function parseEntitlement(value: unknown): SecurityEntitlement | null {
  if (value === null) {
    return null;
  }
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

/** Each id once. The lenient reader drops ids a later release added. */
function blockedModelsFrom(value: unknown, strict: boolean): ReadonlyArray<SecurityModelId> {
  if (!Array.isArray(value)) {
    throw new Error('blockedModels must be a list of model IDs.');
  }
  const blocked: Array<SecurityModelId> = [];
  for (const entry of value) {
    if (strict) {
      const id = parseModelId(entry, 'Each blocked model');
      if (blocked.includes(id)) {
        throw new Error(`Blocked model listed twice: ${id}.`);
      }
      blocked.push(id);
    } else if (isSecurityModelId(entry) && !blocked.includes(entry)) {
      blocked.push(entry);
    }
  }
  return blocked;
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
 * priced model (spec §8.2, edge case 23). `SECURITY_MODEL_IDS` lists `@cf` models first,
 * so a third-party model is only reached when every `@cf` model is blocked.
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

/** The rules that tie policy fields together; the API checks runtime conditions itself. */
function assertConsistent(policy: SecurityPolicy): SecurityPolicy {
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
  return policy;
}

function policyFrom(value: unknown, strict: boolean): SecurityPolicy {
  const input = record(value, 'Security policy');
  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Security policy revision must be a nonnegative whole number.');
  }
  if (!isSecurityMode(input.mode)) {
    throw new Error('Security audit mode must be disabled, public or all.');
  }
  const asked = strict ? parseModelId(input.defaultModel, 'defaultModel') : null;
  const blockedModels = blockedModelsFrom(input.blockedModels, strict);
  const thirdPartyNotice = parseNotice(input.thirdPartyNotice);
  return assertConsistent({
    mode: input.mode,
    defaultModel: asked ?? readDefaultModel(input.defaultModel, blockedModels, thirdPartyNotice),
    blockedModels,
    thirdPartyNotice,
    limits: limitsFrom(input.limits, strict),
    budgets: parseBudgets(input.budgets),
    entitlement: parseEntitlement(input.entitlement),
    publicGate: parseBoolean(input.publicGate, 'publicGate'),
    sweeps: parseSweeps(input.sweeps, strict),
    fallbackToCf: parseAddedFlag(input.fallbackToCf, 'fallbackToCf', strict),
    digest: parseAddedFlag(input.digest, 'digest', strict),
    revision,
  });
}

/**
 * Strict check of a policy about to be written: every known field present and valid,
 * and the fields agree. Unknown fields are ignored.
 */
export function parseSecurityPolicy(value: unknown): SecurityPolicy {
  return policyFrom(value, true);
}

/**
 * Reader of the stored policy row. Data another release could have written still reads:
 * unknown blocked models are dropped, a default this release cannot run falls back,
 * limits are clamped. Anything else the strict parser refuses throws here too.
 */
export function readSecurityPolicy(value: unknown): SecurityPolicy {
  return policyFrom(value, false);
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

/**
 * `platform_settings` key of the per-plan monthly scan caps (M27). Kept out of
 * `plans:catalog`: an older API rebuilds the catalog from known keys on every write, so
 * a cap stored there would be lost after a rollback (same as `plans:ai-logging`).
 */
export const PLAN_SECURITY_CAPS_SETTING = 'plans:security-caps';

/** Plan ID -> monthly cap in whole cents, or `null` = no cap for that plan. Missing = policy default. */
export interface PlanSecurityCaps {
  readonly [planId: string]: number | null;
}

/** A read caps row and how many entries it left out. */
export interface PlanSecurityCapsRead {
  readonly caps: PlanSecurityCaps;
  readonly dropped: number;
}

/**
 * One plan's cap: whole cents, `none` (no cap from the plan, even with project caps
 * on) or `inherit` (the policy's default project cap applies while project caps are on).
 */
export type SecurityPlanCap = number | 'none' | 'inherit';

function isPlanSecurityCapCents(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SECURITY_MAX_MONTHLY_USD * 100
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
  if (key.length === 0 || key.length > 64 || key[0] < 'a' || key[0] > 'z') {
    return false;
  }
  return Array.from(key).every(
    (char) => (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-',
  );
}

/**
 * Reads a stored caps row. Lenient: an entry that is not a plan ID with whole cents or
 * `null` is left out (that plan inherits) and counted in `dropped`, so one bad entry
 * never stops plan edits or scans. A row that is not an object reads as empty.
 */
export function readPlanSecurityCaps(value: unknown): PlanSecurityCapsRead {
  if (value === null || value === undefined) {
    return { caps: {}, dropped: 0 };
  }
  if (!isRecord(value)) {
    return { caps: {}, dropped: 1 };
  }
  const caps: Record<string, number | null> = {};
  let dropped = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (isPlanKey(key) && (entry === null || isPlanSecurityCapCents(entry))) {
      caps[key] = entry;
    } else {
      dropped++;
    }
  }
  return { caps, dropped };
}

/** The cap of one plan in a caps row. */
export function planSecurityCap(caps: PlanSecurityCaps, planId: string): SecurityPlanCap {
  if (!Object.hasOwn(caps, planId)) {
    return 'inherit';
  }
  return caps[planId] ?? 'none';
}

/**
 * Reads a plan change's `securityCap` field: a USD amount (whole cents), `none` or
 * `inherit`. `undefined` keeps the plan's current cap. An amount comes back in cents.
 */
export function parsePlanSecurityCapInput(value: unknown): SecurityPlanCap | undefined {
  if (value === undefined || value === 'none' || value === 'inherit') {
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
  const cents = String(cap % 100).padStart(2, '0');
  return `$${Math.floor(cap / 100).toLocaleString('en-US')}.${cents} / month`;
}

/** `text` as a whole number written with 1 to `maxDigits` ASCII digits, else `null`. */
export function parseSecurityDigits(text: string, maxDigits: number): number | null {
  if (text.length === 0 || text.length > maxDigits) {
    return null;
  }
  return Array.from(text).every((char) => char >= '0' && char <= '9') ? Number(text) : null;
}

/** A finding label as the page prints it (`F-12`): its number, else `null`. */
export function parseSecurityFindingLabel(text: string): number | null {
  return text.startsWith('F-') ? parseSecurityDigits(text.slice(2), 9) : null;
}

/**
 * A finding trace of `{ file, line, note }` steps as `file:line  note` lines, as the CLI
 * and the project page print it; `null` for another shape. Callers clean the text.
 */
export function securityTraceLines(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const lines: Array<string> = [];
  for (const step of value) {
    if (!isRecord(step) || typeof step.file !== 'string' || typeof step.note !== 'string') {
      return null;
    }
    lines.push(`${step.file}${typeof step.line === 'number' ? `:${step.line}` : ''}  ${step.note}`);
  }
  return lines;
}

/**
 * A dollar amount typed in a budget form, such as `50`, `12.50` or `$12.50`. Empty text
 * is `null` (no cap of its own); text that is not an amount is `undefined`.
 */
export function parseSecurityUsdText(text: string): number | null | undefined {
  let amount = text.trim();
  if (amount === '') {
    return null;
  }
  if (amount.startsWith('$')) {
    amount = amount.slice(1);
  }
  const [whole = '', fraction, ...extra] = amount.split('.');
  if (
    extra.length > 0 ||
    parseSecurityDigits(whole, 7) === null ||
    (fraction !== undefined && parseSecurityDigits(fraction, 2) === null)
  ) {
    return undefined;
  }
  return Number(amount);
}
