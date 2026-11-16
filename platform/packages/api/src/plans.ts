import {
  createDefaultPlanCatalog,
  parsePlatformPlanCatalog,
  type BuiltinPlanId,
  type PlanLimits,
  type PlatformPlanCatalog,
  type PlatformPlanDefinition,
} from '@void/platform/plans';
import { count, sql } from 'drizzle-orm';
import type { DbOrTx } from './db.ts';
import { OperatorError } from './operator/common.ts';
import { getPlatformSetting, setPlatformSetting } from './platform-settings.ts';
import { users } from './schema.ts';

export async function readPlanCatalogWithAccounts(
  db: DbOrTx,
  initialDefaultPlanId: BuiltinPlanId = 'free',
) {
  const [catalog, accounts] = await Promise.all([
    readPlanCatalog(db, initialDefaultPlanId),
    db.select({ planId: users.plan, count: count() }).from(users).groupBy(users.plan),
  ]);
  return { catalog, accounts };
}

export const PLAN_CATALOG_SETTING = 'plans:catalog';

/**
 * Serialize catalog changes and account assignments, including the first write.
 * `shared` lets readers that must not race a plan change (a new project reading its
 * plan's AI logging default) run together while still waiting for a writer.
 */
export async function lockPlanCatalog(
  tx: DbOrTx,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<void> {
  await tx.execute(
    mode === 'shared'
      ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('void:platform:plans', 0))`
      : sql`SELECT pg_advisory_xact_lock(hashtextextended('void:platform:plans', 0))`,
  );
}

export async function readPlanCatalog(
  db: DbOrTx,
  initialDefaultPlanId: BuiltinPlanId = 'free',
): Promise<PlatformPlanCatalog> {
  return parseSavedPlanCatalog(
    await getPlatformSetting(db, PLAN_CATALOG_SETTING),
    initialDefaultPlanId,
  );
}

/** The plan the catalog defaults to before an operator saves one. */
export function initialPlanDefaultFor(env: {
  PLATFORM_INSTALLATION_ID?: string | undefined;
}): BuiltinPlanId {
  return env.PLATFORM_INSTALLATION_ID ? 'custom' : 'free';
}

/** Parses a saved `plans:catalog` value; `null` (never saved) is the built-in catalog. */
export function parseSavedPlanCatalog(
  saved: unknown,
  initialDefaultPlanId: BuiltinPlanId = 'free',
): PlatformPlanCatalog {
  if (saved === null || saved === undefined) {
    return createDefaultPlanCatalog(initialDefaultPlanId);
  }
  try {
    return parsePlatformPlanCatalog(saved);
  } catch (error) {
    console.error('[plans] invalid saved catalog', error);
    throw new OperatorError(
      500,
      'The saved plan catalog is invalid. Restore its last valid configuration.',
      'invalid_saved_plan_catalog',
    );
  }
}

export async function writePlanCatalog(db: DbOrTx, catalog: PlatformPlanCatalog): Promise<void> {
  await setPlatformSetting(db, PLAN_CATALOG_SETTING, parsePlatformPlanCatalog(catalog));
}

/** Preserve the legacy free limits for accounts with an unknown historic plan ID. */
export function planFromCatalog(catalog: PlatformPlanCatalog, id: string): PlatformPlanDefinition {
  const plan = catalog.plans.find((plan) => plan.id === id);
  if (plan) {
    return plan;
  }
  const fallback = createDefaultPlanCatalog().plans.find((plan) => plan.id === 'free')!;
  // Legacy installations allowed short slugs for every ID except literal free.
  // Preserve that behavior while retaining the historic free quota fallback.
  return { ...fallback, allowShortSlugs: id !== 'free' };
}

export async function resolvePlan(db: DbOrTx, id: string): Promise<PlatformPlanDefinition> {
  return planFromCatalog(await readPlanCatalog(db), id);
}

export async function resolvePlanLimits(db: DbOrTx, id: string): Promise<PlanLimits> {
  return (await resolvePlan(db, id)).limits;
}

export async function getDefaultPlan(
  db: DbOrTx,
  initialDefaultPlanId: BuiltinPlanId = 'free',
): Promise<PlatformPlanDefinition> {
  const catalog = await readPlanCatalog(db, initialDefaultPlanId);
  return catalog.plans.find((plan) => plan.id === catalog.defaultPlanId)!;
}

export async function requireAssignablePlan(
  db: DbOrTx,
  id: string,
): Promise<PlatformPlanDefinition> {
  const catalog = await readPlanCatalog(db);
  const plan = catalog.plans.find((plan) => plan.id === id);
  if (!plan) {
    throw new OperatorError(400, 'Unknown plan.', 'invalid_plan');
  }
  if (plan.archived) {
    throw new OperatorError(
      409,
      'This plan is archived. Restore it before assigning new accounts.',
      'plan_archived',
    );
  }
  return plan;
}
