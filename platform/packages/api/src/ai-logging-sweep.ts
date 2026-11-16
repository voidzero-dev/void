import type { BuiltinPlanId, PlatformPlanCatalog } from '@void/platform/plans';
import { and, eq, inArray, isNotNull, notInArray, or, type SQL } from 'drizzle-orm';
import {
  PLAN_AI_LOGGING_PAGE_SIZE,
  readPlanAiLoggingSettings,
  runPlanAiLoggingPublishPage,
} from './ai-logging-plans.ts';
import {
  AI_LOGGING_ORPHAN_GRACE_MS,
  aiLoggingKey,
  isPublishedAiLoggingMode,
  parseAiLoggingKeyMetadata,
  planAiLogging,
  resolveAiLogging,
  type AiLoggingKeyMetadata,
  type PlanAiLoggingSettings,
  type PublishedAiLoggingMode,
} from './ai-logging-policy.ts';
import { publishProjectAiLogging } from './ai-logging.ts';
import type { Db, DbOrTx } from './db.ts';
import { readPlanCatalog } from './plans.ts';
import { projectAiLogging, projects, users } from './schema.ts';

/**
 * KV operations one hourly sweep may use: list pages, repairs and one plan publish
 * page. A Worker invocation may make 1000 KV operations, and the other hourly jobs
 * (cleanup, email, token rotation) share them, so the sweep keeps under half.
 * What does not fit waits for the next run.
 */
export const AI_LOGGING_SWEEP_KV_BUDGET = 400;

/** KV operations one plan publish page can use: a removal writes a marker and deletes. */
const PLAN_PAGE_KV_COST = PLAN_AI_LOGGING_PAGE_SIZE * 2;

const KEY_PREFIX = aiLoggingKey('');

/** Every published key with its metadata (`null` when missing or malformed). */
async function listPublished(
  routing: KVNamespace,
): Promise<Readonly<{ published: Map<string, AiLoggingKeyMetadata | null>; pages: number }>> {
  const published = new Map<string, AiLoggingKeyMetadata | null>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    pages++;
    const page = await routing.list<unknown>({ prefix: KEY_PREFIX, cursor });
    for (const key of page.keys) {
      published.set(key.name.slice(KEY_PREFIX.length), parseAiLoggingKeyMetadata(key.metadata));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { published, pages };
}

/**
 * Active projects whose effective mode is not inherit. A plain (possibly cached)
 * read is fine: it only picks candidates, and each repair re-reads under the lock.
 */
async function expectedModes(
  db: DbOrTx,
  settings: PlanAiLoggingSettings,
  catalog: PlatformPlanCatalog,
): Promise<Map<string, PublishedAiLoggingMode>> {
  const catalogIds = catalog.plans.map((plan) => plan.id);
  const modePlans = Object.keys(settings.modes).filter((id) => catalogIds.includes(id));
  const conditions: Array<SQL> = [isNotNull(projectAiLogging.mode)];
  if (modePlans.length) {
    conditions.push(inArray(users.plan, modePlans));
  }
  if (planAiLogging(settings, catalog, catalog.defaultPlanId).planMode) {
    conditions.push(notInArray(users.plan, catalogIds));
  }
  const rows = await db
    .select({ id: projects.id, plan: users.plan, mode: projectAiLogging.mode })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .leftJoin(projectAiLogging, eq(projectAiLogging.project_id, projects.id))
    .where(and(eq(projects.status, 'active'), or(...conditions)));
  const expected = new Map<string, PublishedAiLoggingMode>();
  for (const row of rows) {
    const override = isPublishedAiLoggingMode(row.mode) ? row.mode : null;
    const { mode } = resolveAiLogging(
      override,
      planAiLogging(settings, catalog, row.plan).planMode,
    );
    if (mode !== 'inherit') {
      expected.set(row.id, mode);
    }
  }
  return expected;
}

/**
 * IDs one status read binds. Postgres allows at most 65,535 parameters in a
 * statement, and a plan default set back to inherit can leave far more orphan keys.
 */
export const AI_LOGGING_SWEEP_STATUS_PAGE = 1000;

async function projectStatuses(
  db: DbOrTx,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const status = new Map<string, string>();
  for (let start = 0; start < projectIds.length; start += AI_LOGGING_SWEEP_STATUS_PAGE) {
    const rows = await db
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(inArray(projects.id, projectIds.slice(start, start + AI_LOGGING_SWEEP_STATUS_PAGE)));
    for (const row of rows) {
      status.set(row.id, row.status);
    }
  }
  return status;
}

export type AiLoggingSweepResult = Readonly<{
  listed: number;
  expected: number;
  mismatched: number;
  repaired: number;
}>;

/**
 * Hourly drift repair. Finds keys whose listed metadata does not match the
 * effective mode, expected keys that are missing, and keys for projects that are
 * gone or now inherit. Repairs them through the publish helper (which always
 * writes), then runs one page of an unfinished plan publish, all within
 * `AI_LOGGING_SWEEP_KV_BUDGET` KV operations. `repairLimit` caps the repair writes
 * further (tests).
 *
 * Skipping keys whose listed metadata already matches is safe only here: a stale
 * listing can hide only a write from the last minute, and that write came from the
 * helper under the project lock, so it already holds the newest inputs.
 */
export async function sweepAiLogging(
  db: Db,
  routing: KVNamespace,
  initialPlanDefault: BuiltinPlanId,
  options: Readonly<{ now?: number; repairLimit?: number }> = {},
): Promise<AiLoggingSweepResult> {
  const now = options.now ?? Date.now();
  const { published, pages } = await listPublished(routing);
  const [settings, catalog] = await Promise.all([
    readPlanAiLoggingSettings(db),
    readPlanCatalog(db, initialPlanDefault),
  ]);
  // Keep room for the plan publish page when one is running. A cached read can only
  // delay that page to the next run; `plans sync` runs it too.
  const planPage = settings.publish !== null && !settings.publish.complete;
  const available = Math.max(
    0,
    AI_LOGGING_SWEEP_KV_BUDGET - pages - (planPage ? PLAN_PAGE_KV_COST : 0),
  );
  const repairLimit = Math.min(options.repairLimit ?? available, available);
  const expected = await expectedModes(db, settings, catalog);

  const repairs: Array<string> = [];
  for (const [projectId, mode] of expected) {
    if (published.get(projectId)?.mode !== mode) {
      repairs.push(projectId);
    }
  }
  const orphans = [...published.keys()].filter((projectId) => !expected.has(projectId));
  const status = await projectStatuses(db, orphans);
  const gone: Array<string> = [];
  for (const projectId of orphans) {
    const projectStatus = status.get(projectId);
    if (projectStatus === 'active') {
      // Now inherit, or the candidate read was stale: the helper decides under the lock.
      repairs.push(projectId);
    } else if (projectStatus === undefined) {
      // A create writes its key before it commits; leave young keys alone.
      const metadata = published.get(projectId);
      if (!metadata || now - metadata.at >= AI_LOGGING_ORPHAN_GRACE_MS) {
        gone.push(projectId);
      }
    }
    // A project being deleted keeps its key until its row is gone; teardown removes
    // it then.
  }
  const mismatched = repairs.length + gone.length;

  let repaired = 0;
  let budget = repairLimit;
  for (const projectId of repairs.sort()) {
    // A project not in `expected` now inherits, so its repair removes the key.
    const cost = expected.has(projectId) ? 1 : 2;
    if (cost > budget) {
      break;
    }
    budget -= cost;
    try {
      await db.transaction((tx) =>
        publishProjectAiLogging(tx, routing, projectId, { trigger: 'sweep', initialPlanDefault }),
      );
      repaired++;
    } catch (error) {
      console.error('[ai-logging] sweep repair failed', {
        projectId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  for (const projectId of gone.sort().slice(0, budget)) {
    try {
      await routing.delete(aiLoggingKey(projectId));
      repaired++;
    } catch (error) {
      console.error('[ai-logging] sweep orphan delete failed', {
        projectId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  if (planPage) {
    await runPlanAiLoggingPublishPage(db, routing, initialPlanDefault, 'sweep').catch(
      (error: unknown) =>
        console.error('[ai-logging] sweep plan publish page failed', {
          error: error instanceof Error ? error.name : 'unknown',
        }),
    );
  }

  const result = { listed: published.size, expected: expected.size, mismatched, repaired };
  console.info('[ai-logging] sweep', result);
  return result;
}
