import type { BuiltinPlanId } from '@void/platform/plans';
import { eq, sql, type SQL } from 'drizzle-orm';
import {
  AI_LOGGING_CACHE_TTL_SECONDS,
  AI_LOGGING_SETTLE_MS,
  aiLoggingClearedKey,
  aiLoggingClearedMarker,
  aiLoggingKey,
  isPublishedAiLoggingMode,
  parseAiLoggingClearedAt,
  parseAiLoggingKeyMetadata,
  parsePlanAiLoggingSettings,
  parsePublishedAiLogging,
  PLAN_AI_LOGGING_SETTING,
  planAiLogging,
  planPublishPending,
  publishOrder,
  resolveAiLogging,
  type AiLoggingMode,
  type AiLoggingSource,
  type PlanAiLogging,
  type PlanAiLoggingPublish,
  type PlanAiLoggingSettings,
} from './ai-logging-policy.ts';
import type { Db, DbOrTx, Tx } from './db.ts';
import { OperatorError } from './operator/common.ts';
import { lockPlanCatalog, PLAN_CATALOG_SETTING, parseSavedPlanCatalog } from './plans.ts';
import { projectAiLogging } from './schema.ts';

/** Matches the settle time proxy token rotation already relies on. */
export { AI_LOGGING_SETTLE_MS };

/** Waits between KV writes after a 429 (one write per key per second). */
const KV_RATE_LIMIT_RETRY_MS = [1000, 2000, 4000] as const;

export type AiLoggingTrigger =
  | 'operator'
  | 'project_create'
  | 'preview_create'
  | 'plan_publish'
  | 'user_plan'
  | 'transfer'
  | 'sweep';

export type AiLoggingResolution = PlanAiLogging &
  Readonly<{
    /** The saved project value; `inherit` when there is no override row. */
    mode: AiLoggingMode;
    effective: AiLoggingMode;
    source: AiLoggingSource;
  }>;

type AiLoggingInputRow = {
  plan: string;
  mode: string | null;
  catalog: unknown;
  settings: unknown;
  /** Progress of an unfinished account plan change publish, or null. */
  userPublish: unknown;
};

type ResolvedInputs = AiLoggingResolution &
  Readonly<{ publish: PlanAiLoggingPublish | null; userPublishPending: boolean }>;

/**
 * `platform_settings` key of an unfinished account plan change publish (see
 * `runUserAiLoggingPublishPage`). Its row exists only while pages remain.
 */
const USER_PUBLISH_PREFIX = 'ai-logging:user-publish:';

export function userAiLoggingPublishKey(userId: string): string {
  return `${USER_PUBLISH_PREFIX}${userId}`;
}

/** Parses saved plan defaults; a bad value stops the caller instead of loosening logging. */
export function savedPlanAiLogging(value: unknown): PlanAiLoggingSettings {
  try {
    return parsePlanAiLoggingSettings(value);
  } catch (error) {
    console.error('[ai-logging] invalid saved plan defaults', error);
    throw new OperatorError(
      500,
      // Plan commands read this value first, so they cannot repair it. The likely cause
      // is a downgrade after a newer release saved a mode this one does not know.
      'The saved plan AI logging defaults are not valid for this platform version. If a newer platform release saved them, upgrade to that release again.',
      'invalid_saved_plan_ai_logging',
    );
  }
}

function resolveInputs(row: AiLoggingInputRow, initialPlanDefault: BuiltinPlanId): ResolvedInputs {
  if (row.mode !== null && !isPublishedAiLoggingMode(row.mode)) {
    throw new Error('Invalid saved AI logging policy.');
  }
  const catalog = parseSavedPlanCatalog(row.catalog, initialPlanDefault);
  const settings = savedPlanAiLogging(row.settings);
  const plan = planAiLogging(settings, catalog, row.plan);
  const resolved = resolveAiLogging(row.mode, plan.planMode);
  return {
    ...plan,
    mode: row.mode ?? 'inherit',
    effective: resolved.mode,
    source: resolved.source,
    publish: settings.publish,
    userPublishPending: row.userPublish !== null && row.userPublish !== undefined,
  };
}

/**
 * Takes the project row lock on its own. It must run before the inputs are read:
 * under READ COMMITTED, a statement that waits for a row lock re-checks only the
 * locked row afterwards and keeps the joined rows from the snapshot it took before
 * the wait. Reading the inputs in a later statement gives them a fresh snapshot
 * that already holds every change made by whoever had the lock before.
 * The no-op `SET id = id` fires no project trigger (they are `UPDATE OF
 * slug/email_alias`).
 */
export function lockAiLoggingProjectStatement(projectId: string): SQL {
  return sql`UPDATE "projects" SET "id" = "id" WHERE "id" = ${projectId} RETURNING "status"`;
}

/**
 * Reads every publish input in one write statement, after the lock is held.
 * Hyperdrive never caches a write, so this cannot see a stale plan, catalog or
 * override (Rule 1). The row is already locked by this transaction, so this never
 * waits and its snapshot is taken after the lock was granted.
 */
export function lockedAiLoggingInputsStatement(projectId: string): SQL {
  return sql`UPDATE "projects" AS p SET "id" = p."id"
    FROM "users" AS u
    LEFT JOIN "project_ai_logging" AS o ON o."project_id" = ${projectId}
    LEFT JOIN "platform_settings" AS c ON c."key" = ${PLAN_CATALOG_SETTING}
    LEFT JOIN "platform_settings" AS l ON l."key" = ${PLAN_AI_LOGGING_SETTING}
    LEFT JOIN "platform_settings" AS a ON a."key" = ${USER_PUBLISH_PREFIX} || u."id"
    WHERE p."id" = ${projectId} AND u."id" = p."user_id"
    RETURNING p."status", u."plan", o."mode", c."value" AS "catalog", l."value" AS "settings",
      a."value" AS "userPublish"`;
}

async function lockAiLoggingInputs(tx: Tx, projectId: string, initialPlanDefault: BuiltinPlanId) {
  const locked = await tx.execute<{ status: string }>(lockAiLoggingProjectStatement(projectId));
  if (!locked.rows[0]) {
    return null;
  }
  const result = await tx.execute<AiLoggingInputRow & { status: string }>(
    lockedAiLoggingInputsStatement(projectId),
  );
  const row = result.rows[0];
  return row ? { status: row.status, ...resolveInputs(row, initialPlanDefault) } : null;
}

/** A KV write for the AI logging key failed after any 429 retries. */
export class AiLoggingPublishError extends Error {
  readonly step: 'kv_put' | 'kv_delete';
  readonly status: number | undefined;

  constructor(step: 'kv_put' | 'kv_delete', cause: unknown) {
    super('The AI logging setting could not be published.', { cause });
    this.name = 'AiLoggingPublishError';
    this.step = step;
    this.status = isKvRateLimited(cause) ? 429 : undefined;
  }
}

function isKvRateLimited(error: unknown): boolean {
  return error instanceof Error && error.message.includes('429');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one KV write, retrying a 429 while the caller still holds the project lock. */
async function withKvRetry(
  step: AiLoggingPublishError['step'],
  write: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      return;
    } catch (error) {
      const delay = KV_RATE_LIMIT_RETRY_MS[attempt];
      if (!isKvRateLimited(error) || delay === undefined) {
        throw new AiLoggingPublishError(step, error);
      }
      await sleep(delay);
    }
  }
}

/**
 * Writes the key and returns the publish time. Removing the key (inherit) first
 * writes the short-lived cleared marker, so readback can report `pending` while other
 * locations may still serve the old value; if the marker fails, nothing has changed.
 */
async function writeAiLoggingKey(
  routing: KVNamespace,
  projectId: string,
  mode: AiLoggingMode,
): Promise<number> {
  const key = aiLoggingKey(projectId);
  const at = Date.now();
  if (mode === 'inherit') {
    const marker = aiLoggingClearedMarker(at);
    await withKvRetry('kv_put', () =>
      routing.put(aiLoggingClearedKey(projectId), marker.value, {
        metadata: marker.metadata,
        expirationTtl: marker.expirationTtl,
      }),
    );
    await withKvRetry('kv_delete', () => routing.delete(key));
    return at;
  }
  let written = at;
  await withKvRetry('kv_put', () => {
    written = Date.now();
    return routing.put(key, mode, { metadata: { mode, at: written } });
  });
  return written;
}

export type AiLoggingPublished = AiLoggingResolution &
  Readonly<{
    /** When the key was written (ms), or null when nothing needed writing. */
    at: number | null;
    expectedBy: string | null;
  }>;

function expectedBy(at: number): string {
  return new Date(at + AI_LOGGING_SETTLE_MS).toISOString();
}

function withoutPublish({
  publish: _publish,
  userPublishPending: _userPublishPending,
  ...resolution
}: ResolvedInputs): AiLoggingResolution {
  return resolution;
}

/**
 * The only API writer of `ai-logging:<projectId>`. Must run inside a transaction:
 * it locks the project row, reads the inputs under that lock and writes the value it
 * read before the lock is released, so a later publisher always writes last.
 * Returns null when the project is gone or being deleted (cleanup removes the key).
 *
 * `creating` is for the transaction that inserts the project; it skips the write when
 * the effective mode is inherit. That transaction must start with
 * `lockNewProjectAiLoggingInputs`.
 */
export async function publishProjectAiLogging(
  tx: Tx,
  routing: KVNamespace,
  projectId: string,
  options: Readonly<{
    trigger: AiLoggingTrigger;
    initialPlanDefault: BuiltinPlanId;
    previous?: AiLoggingMode;
    creating?: boolean;
  }>,
): Promise<AiLoggingPublished | null> {
  const inputs = await lockAiLoggingInputs(tx, projectId, options.initialPlanDefault);
  if (!inputs || inputs.status === 'deleting') {
    return null;
  }
  const resolution = withoutPublish(inputs);
  if (options.creating && resolution.effective === 'inherit') {
    return { ...resolution, at: null, expectedBy: null };
  }
  let at: number;
  try {
    at = await writeAiLoggingKey(routing, projectId, resolution.effective);
  } catch (error) {
    if (error instanceof AiLoggingPublishError) {
      console.error('[ai-logging] publish failed', {
        projectId,
        step: error.step,
        status: error.status,
        trigger: options.trigger,
      });
    }
    throw error;
  }
  console.info('[ai-logging] published', {
    projectId,
    mode: resolution.effective,
    source: resolution.source,
    previous: options.previous,
    trigger: options.trigger,
  });
  return { ...resolution, at, expectedBy: expectedBy(at) };
}

/**
 * First statement of a transaction that creates a project and publishes its AI
 * logging default. A user plan change or plan default edit cannot see the
 * uncommitted project, so it must not commit while the create reads the plan: the
 * shared plan lock makes it wait for the create to commit (and then publish the new
 * project), or makes the create read its result. Taken before any row lock, in the
 * same order as plan changes (plan lock, then `users` rows), so it cannot deadlock.
 */
export async function lockNewProjectAiLoggingInputs(tx: Tx): Promise<void> {
  await lockPlanCatalog(tx, 'shared');
}

export async function writeProjectAiLogging(db: DbOrTx, projectId: string, mode: AiLoggingMode) {
  if (mode === 'inherit') {
    await db.delete(projectAiLogging).where(eq(projectAiLogging.project_id, projectId));
  } else {
    await db
      .insert(projectAiLogging)
      .values({ project_id: projectId, mode })
      .onConflictDoUpdate({ target: projectAiLogging.project_id, set: { mode } });
  }
}

type AiLoggingChangeOptions = Readonly<{ initialPlanDefault: BuiltinPlanId; dryRun: boolean }>;

export type ProjectAiLoggingChange = AiLoggingResolution &
  Readonly<{ previous: AiLoggingMode; expectedBy: string | null }>;

export type ProjectAiLoggingPreview = AiLoggingResolution &
  Readonly<{ dryRun: true; action: 'project.ai-logging'; target: string; previous: AiLoggingMode }>;

/**
 * First step of an operator change (tx1): lock, save the override, and publish in
 * the same transaction when the change tightens logging (or keeps it the same, which
 * re-publishes and repairs drift). A KV failure there rolls the save back. Other
 * changes return `publishAfterCommit` for `publishAfterAiLoggingSave` (tx2).
 */
export async function saveProjectAiLogging(
  db: Db,
  routing: KVNamespace,
  projectId: string,
  mode: AiLoggingMode,
  options: AiLoggingChangeOptions,
): Promise<
  | Readonly<{ preview: ProjectAiLoggingPreview }>
  | Readonly<{ change: ProjectAiLoggingChange; publishAfterCommit: boolean }>
> {
  return db.transaction(async (tx) => {
    const before = await lockAiLoggingInputs(tx, projectId, options.initialPlanDefault);
    if (!before) {
      throw new OperatorError(404, 'Project not found.');
    }
    if (before.status !== 'active') {
      throw new OperatorError(409, 'Project is being deleted.');
    }
    const previous = before.effective;
    const next = resolveAiLogging(mode, before.planMode);
    const resolution: AiLoggingResolution = {
      ...withoutPublish(before),
      mode,
      effective: next.mode,
      source: next.source,
    };
    if (options.dryRun) {
      return {
        preview: {
          dryRun: true,
          action: 'project.ai-logging',
          target: projectId,
          ...resolution,
          previous,
        },
      };
    }
    await writeProjectAiLogging(tx, projectId, mode);
    const order = publishOrder(previous, next.mode);
    if (order === 'loosen' || order === 'unknown') {
      return { change: { ...resolution, previous, expectedBy: null }, publishAfterCommit: true };
    }
    let published: AiLoggingPublished | null;
    try {
      published = await publishProjectAiLogging(tx, routing, projectId, {
        trigger: 'operator',
        initialPlanDefault: options.initialPlanDefault,
        previous,
      });
    } catch (error) {
      if (error instanceof AiLoggingPublishError) {
        // Only this change rolls back. A setting saved earlier (after
        // ai_logging_publish_pending) stays saved, and the hourly sweep publishes it,
        // so name what is saved instead of saying nothing changed.
        throw new OperatorError(
          503,
          `The AI logging setting could not be published, so this change was not saved. The saved project setting is still "${before.mode}"; if it is not published yet, the hourly repair publishes it. Retry the command.`,
          'ai_logging_publish_failed',
        );
      }
      throw error;
    }
    return {
      change: { ...resolution, previous, expectedBy: published?.expectedBy ?? null },
      publishAfterCommit: false,
    };
  });
}

/**
 * Second step (tx2) for a loosening change or one involving `inherit`: lock the row
 * again and publish what it holds now. A newer change committed in between wins
 * because this re-reads under the lock instead of writing the value from tx1.
 */
export async function publishAfterAiLoggingSave(
  db: Db,
  routing: KVNamespace,
  projectId: string,
  options: Readonly<{ initialPlanDefault: BuiltinPlanId; previous: AiLoggingMode }>,
): Promise<AiLoggingPublished | null> {
  try {
    return await db.transaction((tx) =>
      publishProjectAiLogging(tx, routing, projectId, { trigger: 'operator', ...options }),
    );
  } catch (error) {
    if (error instanceof AiLoggingPublishError) {
      throw new OperatorError(
        503,
        'The AI logging setting was saved but is not published yet, so the project keeps its previous behaviour until it is. Retry the command; otherwise the hourly repair publishes it.',
        'ai_logging_publish_pending',
      );
    }
    throw error;
  }
}

/** `POST /operator/v1/projects/:id/ai-logging`: save, then publish in the safe order. */
export async function setProjectAiLogging(
  db: Db,
  routing: KVNamespace,
  projectId: string,
  mode: AiLoggingMode,
  options: AiLoggingChangeOptions,
): Promise<ProjectAiLoggingChange | ProjectAiLoggingPreview> {
  const saved = await saveProjectAiLogging(db, routing, projectId, mode, options);
  if ('preview' in saved) {
    return saved.preview;
  }
  if (!saved.publishAfterCommit) {
    return saved.change;
  }
  const published = await publishAfterAiLoggingSave(db, routing, projectId, {
    initialPlanDefault: options.initialPlanDefault,
    previous: saved.change.previous,
  });
  return { ...saved.change, expectedBy: published?.expectedBy ?? null };
}

export type AiLoggingState = 'applied' | 'pending' | 'pending_plan_publish' | 'drift' | 'unknown';

/**
 * Compares the published key with the effective mode. `pending` means the right value
 * is published but may not have reached every location yet; `unknown` means the key
 * could not be read. `clearedAt` is the time of the cleared marker a removed key
 * leaves behind (`null` or left out when there is none).
 */
export function aiLoggingState(
  input: Readonly<{
    effective: AiLoggingMode;
    source: AiLoggingSource;
    planPublishPending: boolean;
    published: Readonly<{ value: string | null; metadata: unknown }> | null;
    clearedAt?: number | null;
    now: number;
  }>,
): Readonly<{
  published: AiLoggingMode | null;
  publishedAt: number | null;
  state: AiLoggingState;
}> {
  if (!input.published) {
    return { published: null, publishedAt: null, state: 'unknown' };
  }
  const published = parsePublishedAiLogging(input.published.value) ?? null;
  const metadata =
    input.published.value === null ? null : parseAiLoggingKeyMetadata(input.published.metadata);
  const matches =
    published === input.effective &&
    (published === 'inherit' || (metadata !== null && metadata.mode === published));
  if (!matches) {
    const planDriven = input.source !== 'project' && input.planPublishPending;
    return {
      published,
      publishedAt: metadata?.at ?? null,
      state: planDriven ? 'pending_plan_publish' : 'drift',
    };
  }
  if (metadata && input.now < metadata.at + AI_LOGGING_SETTLE_MS) {
    return { published, publishedAt: metadata.at, state: 'pending' };
  }
  const clearedAt = published === 'inherit' ? (input.clearedAt ?? null) : null;
  if (clearedAt !== null && input.now < clearedAt + AI_LOGGING_SETTLE_MS) {
    return { published, publishedAt: clearedAt, state: 'pending' };
  }
  return { published, publishedAt: metadata?.at ?? null, state: 'applied' };
}

export type ProjectAiLoggingStatus = AiLoggingResolution &
  Readonly<{
    published: AiLoggingMode | null;
    publishedAt: string | null;
    state: AiLoggingState;
  }>;

/**
 * Operator readback. It compares the saved inputs with the published key, so both
 * must be current: a key read without `cacheTtl` shows the API's own writes at once,
 * but Hyperdrive can answer a plain read from a copy up to a minute old, and an old
 * row next to a new key reads as a false `drift`. So the inputs are read through
 * the same write statements a publish uses, and the keys are read while this
 * transaction holds the project lock, so no publish can land between the two reads.
 * Display only: it never writes a key.
 */
export async function readProjectAiLoggingStatus(
  db: DbOrTx,
  routing: KVNamespace,
  projectId: string,
  initialPlanDefault: BuiltinPlanId,
): Promise<ProjectAiLoggingStatus | null> {
  return db.transaction(async (tx) => {
    const inputs = await lockAiLoggingInputs(tx, projectId, initialPlanDefault);
    if (!inputs) {
      return null;
    }
    let published: { value: string | null; metadata: unknown } | null;
    let clearedAt: number | null = null;
    try {
      published = await routing.getWithMetadata(aiLoggingKey(projectId));
      if (published.value === null) {
        const cleared = await routing.getWithMetadata(aiLoggingClearedKey(projectId));
        clearedAt = cleared.value === null ? null : parseAiLoggingClearedAt(cleared.metadata);
      }
    } catch (error) {
      console.error('[ai-logging] readback unavailable', {
        projectId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      published = null;
    }
    const state = aiLoggingState({
      effective: inputs.effective,
      source: inputs.source,
      // An unfinished account plan change publish is a plan publish for this project.
      planPublishPending: planPublishPending(inputs.publish, inputs) || inputs.userPublishPending,
      published,
      clearedAt,
      now: Date.now(),
    });
    const { status: _status, ...resolved } = inputs;
    return {
      ...withoutPublish(resolved),
      published: state.published,
      publishedAt: state.publishedAt === null ? null : new Date(state.publishedAt).toISOString(),
      state: state.state,
    };
  });
}

/**
 * What the platform publishes for a project, read the same way the proxy reads it.
 * Serves the kept `GET /internal/ai-logging/:id` route for 1.8.x proxies.
 * `undefined` means the key holds a value this platform does not know.
 */
export async function readPublishedAiLogging(
  routing: KVNamespace,
  projectId: string,
): Promise<AiLoggingMode | undefined> {
  return parsePublishedAiLogging(
    await routing.get(aiLoggingKey(projectId), {
      cacheTtl: AI_LOGGING_CACHE_TTL_SECONDS,
    }),
  );
}
