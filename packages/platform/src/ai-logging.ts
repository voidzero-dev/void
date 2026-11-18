/**
 * AI Gateway logging policy shared by the platform API, proxy and installer.
 *
 * The API saves a project override (and plan defaults) in Postgres and publishes the
 * effective mode to ROUTING KV under `aiLoggingKey(projectId)`. The proxy reads only
 * that key. A missing key means `inherit`: the gateway's own `collect_logs` setting.
 */

/** Every mode an operator can choose. `inherit` clears an override. */
export const AI_LOGGING_MODES = ['inherit', 'off', 'metadata', 'full'] as const;
export type AiLoggingMode = (typeof AI_LOGGING_MODES)[number];

/** Modes that are saved and published. `inherit` is never stored: no row, no key. */
export const PUBLISHED_AI_LOGGING_MODES = ['off', 'metadata', 'full'] as const;
export type PublishedAiLoggingMode = (typeof PUBLISHED_AI_LOGGING_MODES)[number];

/** Where an effective mode comes from. `gateway` means nothing is set (inherit). */
export type AiLoggingSource = 'project' | 'plan' | 'gateway';

/**
 * How a change between two effective modes moves logging. Only
 * `off < metadata < full` has a known order: `inherit` follows the gateway setting,
 * which the platform never reads, so any change to or from it is `unknown`.
 */
export type AiLoggingPublishOrder = 'same' | 'tighten' | 'loosen' | 'unknown';

const AI_LOGGING_KEY_PREFIX = 'ai-logging:';

export function isAiLoggingMode(value: unknown): value is AiLoggingMode {
  return AI_LOGGING_MODES.some((mode) => mode === value);
}

export function isPublishedAiLoggingMode(value: unknown): value is PublishedAiLoggingMode {
  return PUBLISHED_AI_LOGGING_MODES.some((mode) => mode === value);
}

/** ROUTING KV key that holds a project's published AI logging mode. */
export function aiLoggingKey(projectId: string): string {
  return `${AI_LOGGING_KEY_PREFIX}${projectId}`;
}

/**
 * Reads a published KV value: a missing key is `inherit`, a stored mode is that mode.
 * Anything else, including a literal `inherit` or a mode from a newer platform,
 * returns `undefined` so callers fail closed instead of logging more than intended.
 */
export function parsePublishedAiLogging(value: string | null): AiLoggingMode | undefined {
  if (value === null) {
    return 'inherit';
  }
  return isPublishedAiLoggingMode(value) ? value : undefined;
}

/** Effective mode: the project override, else the plan default, else inherit. */
export function resolveAiLogging(
  projectMode: AiLoggingMode | null | undefined,
  planMode: AiLoggingMode | null | undefined,
): Readonly<{ mode: AiLoggingMode; source: AiLoggingSource }> {
  if (projectMode && projectMode !== 'inherit') {
    return { mode: projectMode, source: 'project' };
  }
  if (planMode && planMode !== 'inherit') {
    return { mode: planMode, source: 'plan' };
  }
  return { mode: 'inherit', source: 'gateway' };
}

const LOGGING_RANK: Readonly<Record<PublishedAiLoggingMode, number>> = {
  off: 0,
  metadata: 1,
  full: 2,
};

/** Compares two effective modes (not saved project fields) to order a publish. */
export function publishOrder(
  previousEffective: AiLoggingMode,
  nextEffective: AiLoggingMode,
): AiLoggingPublishOrder {
  if (previousEffective === nextEffective) {
    return 'same';
  }
  if (previousEffective === 'inherit' || nextEffective === 'inherit') {
    return 'unknown';
  }
  return LOGGING_RANK[nextEffective] < LOGGING_RANK[previousEffective] ? 'tighten' : 'loosen';
}

/**
 * How long after a KV write new requests are expected to follow it. KV may take up to
 * 60 s (plus the proxy's 30 s `cacheTtl`) to reach other locations. A target, not a
 * guarantee.
 */
export const AI_LOGGING_SETTLE_MS = 120_000;

/** Edge cache time of the proxy's key read: KV's minimum, the same as the project token floor. */
export const AI_LOGGING_CACHE_TTL_SECONDS = 30;

const AI_LOGGING_CLEARED_KEY_PREFIX = 'ai-logging-cleared:';

/**
 * ROUTING KV marker written just before `aiLoggingKey(projectId)` is removed for a
 * project that now inherits. A removed key leaves no publish time behind, so readback
 * reads this marker to report `pending` while other locations may still serve the old
 * value. Only the API reads it (never the proxy), and it expires after the settle time.
 * Its prefix does not start with the published key prefix, so key listings skip it.
 */
export function aiLoggingClearedKey(projectId: string): string {
  return `${AI_LOGGING_CLEARED_KEY_PREFIX}${projectId}`;
}

/** KV expiry of the cleared marker, in seconds (KV's minimum is 60). */
export const AI_LOGGING_CLEARED_TTL_SECONDS: number = AI_LOGGING_SETTLE_MS / 1000;

/** The KV value and options of a cleared marker written at `at` (ms). */
export function aiLoggingClearedMarker(at: number): Readonly<{
  value: string;
  metadata: Readonly<{ at: number }>;
  expirationTtl: number;
}> {
  return { value: 'inherit', metadata: { at }, expirationTtl: AI_LOGGING_CLEARED_TTL_SECONDS };
}

/** Reads a cleared marker's time; anything missing or malformed is `null`. */
export function parseAiLoggingClearedAt(metadata: unknown): number | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const { at } = metadata as Record<string, unknown>;
  return typeof at === 'number' && Number.isSafeInteger(at) ? at : null;
}

/** ROUTING KV metadata written with every published key. `at` is the publish time in ms. */
export type AiLoggingKeyMetadata = Readonly<{ mode: PublishedAiLoggingMode; at: number }>;

/** Reads the metadata of a published key; anything malformed is `null` (treated as drift). */
export function parseAiLoggingKeyMetadata(value: unknown): AiLoggingKeyMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { mode, at } = value as Record<string, unknown>;
  if (!isPublishedAiLoggingMode(mode) || typeof at !== 'number' || !Number.isSafeInteger(at)) {
    return null;
  }
  return { mode, at };
}

/** `platform_settings` key that holds plan defaults, kept apart from `plans:catalog`. */
export const PLAN_AI_LOGGING_SETTING = 'plans:ai-logging';

/**
 * A key for a project with no row may belong to a project whose create transaction
 * has written KV but not committed yet. Cleanup leaves keys this young alone.
 */
export const AI_LOGGING_ORPHAN_GRACE_MS: number = 10 * 60_000;

/**
 * A plan-default fan-out that is still running (or stopped on an error).
 * `revision` is the plan catalog revision that started it, so a page that began
 * before a newer plan change cannot move the newer run's cursor.
 */
export type PlanAiLoggingPublish = Readonly<{
  revision: number;
  planIds: ReadonlyArray<string>;
  includeUnknown: boolean;
  cursor: string | null;
  complete: boolean;
  error?: string;
}>;

export type PlanAiLoggingSettings = Readonly<{
  /** Plan ID -> default mode. A missing plan inherits. */
  modes: Readonly<Record<string, PublishedAiLoggingMode>>;
  publish: PlanAiLoggingPublish | null;
}>;

function settingsRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parsePlanAiLoggingPublish(value: unknown): PlanAiLoggingPublish | null {
  if (value === null || value === undefined) {
    return null;
  }
  const input = settingsRecord(value, 'AI logging publish');
  const { revision, planIds, includeUnknown, cursor, complete, error } = input;
  if (
    !Number.isSafeInteger(revision) ||
    !Array.isArray(planIds) ||
    !planIds.every((id) => typeof id === 'string') ||
    typeof includeUnknown !== 'boolean' ||
    (cursor !== null && typeof cursor !== 'string') ||
    typeof complete !== 'boolean' ||
    (error !== undefined && typeof error !== 'string')
  ) {
    throw new Error('Invalid AI logging publish progress.');
  }
  return {
    revision: revision as number,
    planIds: planIds as Array<string>,
    includeUnknown,
    cursor,
    complete,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Reads the saved plan defaults. A missing row means every plan inherits. A mode the
 * platform does not know is refused (so a bad value never loosens logging);
 * `inherit` entries are dropped. Entries for plans not in the catalog stay in the
 * object but are never looked up (see `planAiLogging`).
 */
export function parsePlanAiLoggingSettings(value: unknown): PlanAiLoggingSettings {
  if (value === null || value === undefined) {
    return { modes: {}, publish: null };
  }
  const input = settingsRecord(value, 'Plan AI logging settings');
  const saved = settingsRecord(input.modes ?? {}, 'Plan AI logging modes');
  const modes: Record<string, PublishedAiLoggingMode> = {};
  for (const [planId, mode] of Object.entries(saved)) {
    if (!isAiLoggingMode(mode)) {
      throw new Error(`Invalid AI logging mode for plan ${planId}.`);
    }
    if (mode !== 'inherit') {
      modes[planId] = mode;
    }
  }
  return { modes, publish: parsePlanAiLoggingPublish(input.publish) };
}

/** The parts of a plan catalog the logging resolver needs. */
export type AiLoggingPlanCatalog = Readonly<{
  defaultPlanId: string;
  plans: ReadonlyArray<Readonly<{ id: string }>>;
}>;

export type PlanAiLogging = Readonly<{
  planId: string;
  /** False when the account's plan ID is not in the catalog. */
  planKnown: boolean;
  /** The catalog default plan, whose logging an unknown plan ID follows. */
  defaultPlanId: string;
  planMode: PublishedAiLoggingMode | null;
}>;

/**
 * The plan default for an account. A plan ID that is not in the catalog takes the
 * default plan's logging (unlike limits, which fall back to the built-in free plan),
 * so an operator who sets `off` on every plan gets `off` for every account.
 */
export function planAiLogging(
  settings: PlanAiLoggingSettings,
  catalog: AiLoggingPlanCatalog,
  planId: string,
): PlanAiLogging {
  const planKnown = catalog.plans.some((plan) => plan.id === planId);
  const lookup = planKnown ? planId : catalog.defaultPlanId;
  const planMode = Object.hasOwn(settings.modes, lookup) ? settings.modes[lookup]! : null;
  return { planId, planKnown, defaultPlanId: catalog.defaultPlanId, planMode };
}

/** Whether a running plan publish still has to reach accounts on this plan. */
export function planPublishPending(
  publish: PlanAiLoggingPublish | null,
  plan: Pick<PlanAiLogging, 'planId' | 'planKnown'>,
): boolean {
  if (!publish || publish.complete) {
    return false;
  }
  return plan.planKnown ? publish.planIds.includes(plan.planId) : publish.includeUnknown;
}

/**
 * Reads a plan's `aiLogging` field from a plan change. `undefined` keeps the current
 * value and `inherit` clears it.
 */
export function parsePlanAiLoggingInput(value: unknown): AiLoggingMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isAiLoggingMode(value)) {
    throw new Error(`aiLogging must be one of ${AI_LOGGING_MODES.join(', ')}.`);
  }
  return value;
}
