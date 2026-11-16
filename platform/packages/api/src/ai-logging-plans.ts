import type { BuiltinPlanId, PlatformPlanCatalog } from '@void/platform/plans';
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  PLAN_AI_LOGGING_SETTING,
  planAiLogging,
  type AiLoggingMode,
  type PlanAiLoggingPublish,
  type PlanAiLoggingSettings,
  type PublishedAiLoggingMode,
} from './ai-logging-policy.ts';
import {
  AI_LOGGING_SETTLE_MS,
  publishProjectAiLogging,
  savedPlanAiLogging,
  userAiLoggingPublishKey as userPublishKey,
  type AiLoggingTrigger,
} from './ai-logging.ts';
import type { Db, DbOrTx } from './db.ts';
import {
  lockPlanCatalog,
  parseSavedPlanCatalog,
  PLAN_CATALOG_SETTING,
  readPlanCatalog,
} from './plans.ts';
import { getPlatformSetting, setPlatformSetting } from './platform-settings.ts';
import { platformSettings, projectAiLogging, projects, users } from './schema.ts';

/**
 * Projects one plan publish page writes. Each write is one short transaction and
 * at most two KV operations (a removal also writes its cleared marker), well inside
 * the 1000 KV operations per invocation.
 */
export const PLAN_AI_LOGGING_PAGE_SIZE = 100;

/** Saved plan defaults. A missing row means every plan inherits. */
export async function readPlanAiLoggingSettings(db: DbOrTx): Promise<PlanAiLoggingSettings> {
  return savedPlanAiLogging(await getPlatformSetting(db, PLAN_AI_LOGGING_SETTING));
}

/**
 * Reads the plan catalog and plan defaults through a no-op write. Hyperdrive caches a
 * plain read for a minute or more, even inside a transaction, and every plans page
 * load runs the same read. Use this wherever the value decides what to write; callers
 * hold the plan lock (`lockPlanCatalog`), and the setting rows stay locked until the
 * transaction ends.
 */
export async function freshPlanAiLoggingInputs(
  tx: DbOrTx,
  initialPlanDefault: BuiltinPlanId,
): Promise<Readonly<{ settings: PlanAiLoggingSettings; catalog: PlatformPlanCatalog }>> {
  const result = await tx.execute<{ key: string; value: unknown }>(
    sql`UPDATE "platform_settings" SET "key" = "key"
      WHERE "key" IN (${PLAN_CATALOG_SETTING}, ${PLAN_AI_LOGGING_SETTING})
      RETURNING "key", "value"`,
  );
  const saved = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    settings: savedPlanAiLogging(saved.get(PLAN_AI_LOGGING_SETTING) ?? null),
    catalog: parseSavedPlanCatalog(saved.get(PLAN_CATALOG_SETTING) ?? null, initialPlanDefault),
  };
}

/** Saves plan defaults. Callers hold the plan lock (`lockPlanCatalog`). */
export async function writePlanAiLoggingSettings(
  db: DbOrTx,
  settings: PlanAiLoggingSettings,
): Promise<void> {
  await setPlatformSetting(db, PLAN_AI_LOGGING_SETTING, settings);
}

/** A plan ID no catalog can hold; it stands for "an account on an unknown plan". */
const UNKNOWN_PLAN = ' unknown';

function modeFor(
  modes: PlanAiLoggingSettings['modes'],
  catalog: PlatformPlanCatalog,
  planId: string,
): PublishedAiLoggingMode | null {
  return planAiLogging({ modes, publish: null }, catalog, planId).planMode;
}

/**
 * Which accounts a plan change moves to a different plan default. `movedFrom` is a
 * removed plan whose accounts now sit on `movedTo`.
 */
export function planAiLoggingChanges(
  input: Readonly<{
    before: PlatformPlanCatalog;
    after: PlatformPlanCatalog;
    modesBefore: PlanAiLoggingSettings['modes'];
    modesAfter: PlanAiLoggingSettings['modes'];
    moved?: Readonly<{ from: string; to: string }>;
  }>,
): Readonly<{ planIds: Array<string>; includeUnknown: boolean }> {
  const { before, after, modesBefore, modesAfter } = input;
  const planIds = after.plans
    .map((plan) => plan.id)
    .filter((id) => {
      const moved = input.moved?.to === id;
      const previous = modeFor(modesBefore, before, id);
      const next = modeFor(modesAfter, after, id);
      return (
        previous !== next || (moved && modeFor(modesBefore, before, input.moved!.from) !== next)
      );
    });
  return {
    planIds,
    includeUnknown:
      modeFor(modesBefore, before, UNKNOWN_PLAN) !== modeFor(modesAfter, after, UNKNOWN_PLAN),
  };
}

/**
 * Starts a publish for the given accounts, folding in any run that has not finished.
 * The merged run starts again from the first project, so every project it covers
 * gets the newest settings. An unfinished run follows its accounts through the
 * catalog change, even when their mode does not change and `change` lists no plan:
 * a removed plan's scope moves to its replacement (`catalog.moved`), and a run that
 * covered unknown plans also covers plans that are new to the catalog
 * (`catalog.added`), because those accounts are no longer on an unknown plan.
 */
export function startPlanAiLoggingPublish(
  current: PlanAiLoggingPublish | null,
  revision: number,
  change: Readonly<{ planIds: ReadonlyArray<string>; includeUnknown: boolean }>,
  catalog: Readonly<{
    moved?: Readonly<{ from: string; to: string }>;
    added?: ReadonlyArray<string>;
  }> = {},
): PlanAiLoggingPublish | null {
  const running = current && !current.complete ? current : null;
  if (!running && !change.planIds.length && !change.includeUnknown) {
    return current;
  }
  const { moved, added = [] } = catalog;
  const carried = (running?.planIds ?? []).map((id) => (id === moved?.from ? moved.to : id));
  if (running?.includeUnknown) {
    carried.push(...added);
  }
  return {
    revision,
    planIds: [...new Set([...carried, ...change.planIds])].sort(),
    includeUnknown: change.includeUnknown || (running?.includeUnknown ?? false),
    cursor: null,
    complete: false,
  };
}

function planIdsOf(catalog: PlatformPlanCatalog): Array<string> {
  return catalog.plans.map((plan) => plan.id);
}

/**
 * Active projects a plan publish has to write: owner on a listed plan (or on a plan
 * missing from the catalog when `includeUnknown`), and no project override.
 */
function publishCandidates(
  publish: Pick<PlanAiLoggingPublish, 'planIds' | 'includeUnknown'>,
  knownPlanIds: ReadonlyArray<string>,
  cursor: string | null,
): SQL | undefined {
  const plans: Array<SQL> = [];
  if (publish.planIds.length) {
    plans.push(inArray(users.plan, [...publish.planIds]));
  }
  if (publish.includeUnknown) {
    plans.push(notInArray(users.plan, [...knownPlanIds]));
  }
  if (!plans.length) {
    return undefined;
  }
  return and(
    eq(projects.status, 'active'),
    isNull(projectAiLogging.project_id),
    or(...plans),
    cursor ? gt(projects.id, cursor) : undefined,
  );
}

/**
 * Lists projects through a no-op write so Hyperdrive cannot answer it from its query
 * cache: a cached list taken before a plan change or a project create would leave
 * projects out of the publish.
 *
 * The subquery locks the rows itself, sorted by id (`ORDER BY` runs before
 * `FOR NO KEY UPDATE`), the same lock and order the installer projection uses. The outer
 * UPDATE's own lock order depends on the plan (a hashed `IN` follows heap order),
 * so without this two overlapping lockers could deadlock. Row locks are held until
 * the statement's transaction ends.
 */
async function freshProjectIds(db: DbOrTx, where: SQL, limit?: number): Promise<Array<string>> {
  const sorted = db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .leftJoin(projectAiLogging, eq(projectAiLogging.project_id, projects.id))
    .where(where)
    .orderBy(asc(projects.id));
  const selected = (limit === undefined ? sorted : sorted.limit(limit)).for('no key update', {
    of: projects,
  });
  const rows = await db
    .update(projects)
    .set({ id: sql`${projects.id}` })
    .where(inArray(projects.id, selected))
    .returning({ id: projects.id });
  // RETURNING has no order. IDs use one prefix and [0-9a-z], so code-unit order
  // matches the database order the cursor relies on.
  return rows.map((row) => row.id).sort();
}

async function candidateCount(db: DbOrTx, where: SQL): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .leftJoin(projectAiLogging, eq(projectAiLogging.project_id, projects.id))
    .where(where);
  return rows[0]?.total ?? 0;
}

export type PlanAiLoggingPublishProgress = Readonly<{
  complete: boolean;
  /** Projects written by this call. */
  processed: number;
  /** Projects still to write after this call. */
  remaining: number;
  /** When new requests are expected to follow the last write of this call. */
  expectedBy: string | null;
  error?: string;
}>;

const DONE: PlanAiLoggingPublishProgress = {
  complete: true,
  processed: 0,
  remaining: 0,
  expectedBy: null,
};

const PAGE_FAILED =
  'The AI logging setting could not be published to every project. Retry plans sync.';

/**
 * What a plan change would publish, for its dry run: the run it would start (merged
 * with any unfinished one) counted from the first project. Accounts on a removed
 * plan count as already on its replacement, as they will be once the change applies.
 */
export async function previewPlanAiLoggingPublish(
  db: DbOrTx,
  publish: PlanAiLoggingPublish | null,
  catalog: PlatformPlanCatalog,
  moved?: Readonly<{ from: string; to: string }>,
): Promise<PlanAiLoggingPublishProgress> {
  if (!publish || publish.complete) {
    return DONE;
  }
  const planIds =
    moved && publish.planIds.includes(moved.to)
      ? [...publish.planIds, moved.from]
      : publish.planIds;
  const known = planIdsOf(catalog);
  const where = publishCandidates(
    { planIds, includeUnknown: publish.includeUnknown },
    moved ? [...known, moved.from] : known,
    null,
  );
  return {
    complete: false,
    processed: 0,
    remaining: where ? await candidateCount(db, where) : 0,
    expectedBy: null,
  };
}

/** The saved publish run with the projects it still has to write. */
export async function readPlanAiLoggingProgress(
  db: DbOrTx,
  initialPlanDefault: BuiltinPlanId,
): Promise<PlanAiLoggingSettings & Readonly<{ remaining: number }>> {
  const settings = await readPlanAiLoggingSettings(db);
  const publish = settings.publish;
  if (!publish || publish.complete) {
    return { ...settings, remaining: 0 };
  }
  const catalog = await readPlanCatalog(db, initialPlanDefault);
  const where = publishCandidates(publish, planIdsOf(catalog), publish.cursor);
  return { ...settings, remaining: where ? await candidateCount(db, where) : 0 };
}

/**
 * Writes one page of a running plan publish and saves its cursor under the plan
 * lock. Each project goes through `publishProjectAiLogging`, so it locks the
 * project row and reads the newest inputs itself. A failure keeps the cursor at the
 * last written project and records the error; the next call retries from there.
 * Usage counters are not touched.
 */
export async function runPlanAiLoggingPublishPage(
  db: Db,
  routing: KVNamespace,
  initialPlanDefault: BuiltinPlanId,
  trigger: Extract<AiLoggingTrigger, 'plan_publish' | 'sweep'> = 'plan_publish',
): Promise<PlanAiLoggingPublishProgress> {
  const start = await db.transaction(async (tx) => {
    await lockPlanCatalog(tx);
    const { settings, catalog } = await freshPlanAiLoggingInputs(tx, initialPlanDefault);
    return settings.publish && !settings.publish.complete
      ? { publish: settings.publish, catalog }
      : null;
  });
  if (!start) {
    return DONE;
  }
  const { publish, catalog } = start;
  const where = publishCandidates(publish, planIdsOf(catalog), publish.cursor);
  const ids = where ? await freshProjectIds(db, where, PLAN_AI_LOGGING_PAGE_SIZE + 1) : [];
  let processed = 0;
  let lastId: string | null = null;
  let lastAt: number | null = null;
  let failed = false;
  for (const projectId of ids.slice(0, PLAN_AI_LOGGING_PAGE_SIZE)) {
    try {
      const published = await db.transaction((tx) =>
        publishProjectAiLogging(tx, routing, projectId, { trigger, initialPlanDefault }),
      );
      lastAt = published?.at ?? lastAt;
    } catch (error) {
      console.error('[ai-logging] plan publish page stopped', {
        projectId,
        trigger,
        error: error instanceof Error ? error.name : 'unknown',
      });
      failed = true;
      break;
    }
    processed++;
    lastId = projectId;
  }
  const finished = !failed && ids.length <= PLAN_AI_LOGGING_PAGE_SIZE;
  const saved = await db.transaction(async (tx) => {
    await lockPlanCatalog(tx);
    const { settings } = await freshPlanAiLoggingInputs(tx, initialPlanDefault);
    const current = settings.publish;
    // A newer plan change started its own run; it owns the cursor now.
    if (!current || current.complete || current.revision !== publish.revision) {
      return current;
    }
    // A concurrent call already went further; never move the cursor back.
    const cursor =
      lastId !== null && (current.cursor === null || current.cursor < lastId)
        ? lastId
        : current.cursor;
    const next: PlanAiLoggingPublish = {
      revision: current.revision,
      planIds: current.planIds,
      includeUnknown: current.includeUnknown,
      cursor,
      complete: finished && cursor === (lastId ?? publish.cursor),
      ...(failed ? { error: PAGE_FAILED } : {}),
    };
    await writePlanAiLoggingSettings(tx, { ...settings, publish: next });
    return next;
  });
  const expectedBy = lastAt === null ? null : new Date(lastAt + AI_LOGGING_SETTLE_MS).toISOString();
  if (!saved || saved.complete || saved.revision !== publish.revision) {
    return {
      complete: !saved || saved.complete,
      processed,
      remaining: 0,
      expectedBy,
      ...(failed ? { error: PAGE_FAILED } : {}),
    };
  }
  const rest = publishCandidates(saved, planIdsOf(catalog), saved.cursor);
  return {
    complete: false,
    processed,
    remaining: rest ? await candidateCount(db, rest) : 0,
    expectedBy,
    ...(failed ? { error: PAGE_FAILED } : {}),
  };
}

/**
 * Publishes the given projects one by one, each under its own row lock. Stops at the
 * first failure and throws it; projects before it are already published.
 */
export async function publishProjectsAiLogging(
  db: Db,
  routing: KVNamespace,
  projectIds: ReadonlyArray<string>,
  options: Readonly<{ trigger: AiLoggingTrigger; initialPlanDefault: BuiltinPlanId }>,
): Promise<void> {
  for (const projectId of projectIds) {
    await db.transaction((tx) => publishProjectAiLogging(tx, routing, projectId, options));
  }
}

function accountCandidates(userId: string, cursor: string | null): SQL {
  return and(
    eq(projects.user_id, userId),
    eq(projects.status, 'active'),
    isNull(projectAiLogging.project_id),
    cursor ? gt(projects.id, cursor) : undefined,
  )!;
}

/**
 * Projects an account plan change publishes: active, owned by the account and
 * without an override. Every one of them is published, even when both plans look
 * like inherit: the plan and settings could only be compared through reads that
 * Hyperdrive may cache, and a retry after a failed publish sees the new plan as
 * both "before" and "after", so a skip would leave the old plan's keys in place.
 * The list itself is read through a write, so a cached copy cannot leave a project
 * out.
 */
export async function accountAiLoggingCandidates(
  db: DbOrTx,
  userId: string,
  options: Readonly<{ cursor?: string | null; limit?: number }> = {},
): Promise<Array<string>> {
  return freshProjectIds(db, accountCandidates(userId, options.cursor ?? null), options.limit);
}

/**
 * Where an account plan change got to. One call publishes at most one page, the same
 * size as a plan publish page, so a large account stays inside the KV operations
 * allowed per invocation; running the same plan change again continues from
 * `cursor`. The row is removed once the last page is written. `run` names one run:
 * after B -> C -> B, a page still running from the first B change sees the same plan
 * but another run, so it cannot move the new run's cursor or remove its row.
 */
type UserAiLoggingPublish = Readonly<{ plan: string; run: string; cursor: string | null }>;

function parseUserPublish(value: unknown): UserAiLoggingPublish | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { plan, run, cursor } = value as Record<string, unknown>;
  if (
    typeof plan !== 'string' ||
    typeof run !== 'string' ||
    (cursor !== null && typeof cursor !== 'string')
  ) {
    return null;
  }
  return { plan, run, cursor };
}

/** Reads the saved progress through a no-op write, which also locks its row. */
async function freshUserPublish(tx: DbOrTx, userId: string): Promise<UserAiLoggingPublish | null> {
  const result = await tx.execute<{ value: unknown }>(
    sql`UPDATE "platform_settings" SET "key" = "key" WHERE "key" = ${userPublishKey(userId)}
      RETURNING "value"`,
  );
  return parseUserPublish(result.rows[0]?.value ?? null);
}

/**
 * Starts the AI logging publish for an account plan change, in the transaction that
 * saves the plan. Running the same plan change again continues an unfinished run;
 * any other change starts from the first project, because projects before the
 * cursor were published for a different plan.
 */
export async function startUserAiLoggingPublish(
  tx: DbOrTx,
  userId: string,
  previousPlan: string | null,
  plan: string,
): Promise<void> {
  const saved = await freshUserPublish(tx, userId);
  const resume = previousPlan === plan && saved?.plan === plan;
  await setPlatformSetting(tx, userPublishKey(userId), {
    plan,
    run: resume ? saved.run : crypto.randomUUID(),
    cursor: resume ? saved.cursor : null,
  } satisfies UserAiLoggingPublish);
}

export type UserAiLoggingPublishProgress = Omit<PlanAiLoggingPublishProgress, 'error'>;

/**
 * Publishes the next page of an account plan change. A failure saves the cursor at
 * the last written project and is thrown; the next call continues from there. Does
 * nothing when a newer plan change for the account took over.
 */
export async function runUserAiLoggingPublishPage(
  db: Db,
  routing: KVNamespace,
  userId: string,
  plan: string,
  options: Readonly<{ initialPlanDefault: BuiltinPlanId }>,
): Promise<UserAiLoggingPublishProgress> {
  const start = await db.transaction((tx) => freshUserPublish(tx, userId));
  if (!start || start.plan !== plan) {
    return DONE;
  }
  const ids = await accountAiLoggingCandidates(db, userId, {
    cursor: start.cursor,
    limit: PLAN_AI_LOGGING_PAGE_SIZE + 1,
  });
  let processed = 0;
  let lastId: string | null = null;
  let lastAt: number | null = null;
  let failure: unknown;
  for (const projectId of ids.slice(0, PLAN_AI_LOGGING_PAGE_SIZE)) {
    try {
      const published = await db.transaction((tx) =>
        publishProjectAiLogging(tx, routing, projectId, {
          trigger: 'user_plan',
          initialPlanDefault: options.initialPlanDefault,
        }),
      );
      lastAt = published?.at ?? lastAt;
    } catch (error) {
      failure = error;
      break;
    }
    processed++;
    lastId = projectId;
  }
  const finished = failure === undefined && ids.length <= PLAN_AI_LOGGING_PAGE_SIZE;
  const saved = await db.transaction(async (tx) => {
    const current = await freshUserPublish(tx, userId);
    // A newer plan change for this account started its own run, maybe for this
    // same plan again.
    if (!current || current.plan !== plan || current.run !== start.run) {
      return null;
    }
    // A concurrent call already went further; never move the cursor back.
    const cursor =
      lastId !== null && (current.cursor === null || current.cursor < lastId)
        ? lastId
        : current.cursor;
    if (finished && cursor === (lastId ?? start.cursor)) {
      await tx.delete(platformSettings).where(eq(platformSettings.key, userPublishKey(userId)));
      return null;
    }
    await setPlatformSetting(tx, userPublishKey(userId), {
      plan,
      run: start.run,
      cursor,
    } satisfies UserAiLoggingPublish);
    return { cursor };
  });
  if (failure !== undefined) {
    throw failure;
  }
  const expectedBy = lastAt === null ? null : new Date(lastAt + AI_LOGGING_SETTLE_MS).toISOString();
  if (!saved) {
    return { complete: true, processed, remaining: 0, expectedBy };
  }
  return {
    complete: false,
    processed,
    remaining: await candidateCount(db, accountCandidates(userId, saved.cursor)),
    expectedBy,
  };
}

/** A plan's saved default for display; `inherit` when it has none. */
export function planAiLoggingMode(settings: PlanAiLoggingSettings, planId: string): AiLoggingMode {
  return Object.hasOwn(settings.modes, planId) ? settings.modes[planId]! : 'inherit';
}
