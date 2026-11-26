/**
 * Per-plan monthly scan caps (Phase 2, M27), stored apart from the plan catalog in
 * `platform_settings['plans:security-caps']` as `{ <planId>: cents | null }`. Every reader
 * looks the cap up when it needs it, so a plan change applies to the next scan start.
 */
import { parsePlatformPlanId } from '@void/platform/plans';
import {
  PLAN_SECURITY_CAPS_SETTING,
  parsePlanSecurityCapInput,
  planSecurityCap,
  readPlanSecurityCaps,
  readStoredPlanSecurityCap,
  withPlanSecurityCap,
} from '@void/platform/security-policy';
import type { PlanSecurityCaps, SecurityPlanCap } from '@void/platform/security-policy';
import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { platformSettings, projects, users } from '../schema.ts';

export { PLAN_SECURITY_CAPS_SETTING };

function readCaps(value: unknown): PlanSecurityCaps {
  const { caps, dropped } = readPlanSecurityCaps(value);
  if (dropped > 0) {
    console.error('[security] plan caps: ignored invalid entries', { dropped });
  }
  return caps;
}

/** The saved per-plan caps; a missing row means every plan inherits. */
export async function readSecurityPlanCaps(db: DbOrTx): Promise<PlanSecurityCaps> {
  return readCaps(await getPlatformSetting(db, PLAN_SECURITY_CAPS_SETTING));
}

/**
 * The saved caps through a no-op write, for a caller that holds the plan lock and
 * decides what to write from them: Hyperdrive may answer a plain read from its cache.
 */
export async function freshSecurityPlanCaps(tx: DbOrTx): Promise<PlanSecurityCaps> {
  const result = await tx.execute<{ value: unknown }>(
    sql`UPDATE ${platformSettings} SET "key" = "key"
      WHERE "key" = ${PLAN_SECURITY_CAPS_SETTING}
      RETURNING "value"`,
  );
  return readCaps(result.rows[0]?.value ?? null);
}

export async function writeSecurityPlanCaps(db: DbOrTx, caps: PlanSecurityCaps): Promise<void> {
  await setPlatformSetting(db, PLAN_SECURITY_CAPS_SETTING, caps);
}

/**
 * The cap of the plan of `ownerUserId`: JSON text `[cents]` or `[null]`, or SQL `NULL`
 * when the plan has no entry. Read it with `readSecurityPlanCapCell`.
 */
export function securityPlanCapSql(ownerUserId: AnyPgColumn | SQL): SQL<string | null> {
  return sql<string | null>`(SELECT CASE WHEN cap_row."value" -> cap_owner."plan" IS NOT NULL
      THEN jsonb_build_array(cap_row."value" -> cap_owner."plan")::text END
    FROM ${users} cap_owner CROSS JOIN ${platformSettings} cap_row
    WHERE cap_owner."id" = ${ownerUserId} AND cap_row."key" = ${PLAN_SECURITY_CAPS_SETTING})`;
}

/** Reads a `securityPlanCapSql` cell. A bad entry reads as `inherit`, as in `readPlanSecurityCaps`. */
export function readSecurityPlanCapCell(cell: string | null | undefined): SecurityPlanCap {
  if (cell === null || cell === undefined) {
    return 'inherit';
  }
  let cap: SecurityPlanCap | undefined;
  try {
    const parsed: unknown = JSON.parse(cell);
    cap = Array.isArray(parsed) ? readStoredPlanSecurityCap(parsed[0]) : undefined;
  } catch {
    cap = undefined;
  }
  if (cap === undefined) {
    console.error('[security] plan caps: ignored an invalid entry');
    return 'inherit';
  }
  return cap;
}

/** `securityPlanCapSql` for a project's owner (a `FOR UPDATE` select skips Hyperdrive's cache). */
export function securityProjectPlanCapSql(projectId: AnyPgColumn): SQL<string | null> {
  return securityPlanCapSql(
    sql`(SELECT cap_project."user_id" FROM ${projects} cap_project WHERE cap_project."id" = ${projectId})`,
  );
}

/** The cap of the plan of a project's owner; `inherit` for a project that is gone. */
export async function readSecurityPlanCap(db: DbOrTx, projectId: string): Promise<SecurityPlanCap> {
  const [row] = await db
    .select({ planCap: securityPlanCapSql(projects.user_id) })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return readSecurityPlanCapCell(row?.planCap);
}

/** The cap a plan change sets, checked; `undefined` keeps the current one. */
export function planSecurityCapInput(body: Record<string, unknown>): SecurityPlanCap | undefined {
  return parsePlanSecurityCapInput(body.securityCap);
}

/**
 * Per-plan caps after a catalog change, like `proposePlanAiLogging`: `add` copies the
 * source plan's cap unless given, `set` changes it, `remove` drops the entry.
 */
export function proposePlanSecurityCaps(
  caps: PlanSecurityCaps,
  action: string,
  id: string | undefined,
  body: Record<string, unknown>,
  removedPlanId: string | undefined,
): PlanSecurityCaps {
  const input = planSecurityCapInput(body);
  if (input !== undefined && action !== 'add' && action !== 'set') {
    throw new Error('securityCap can be set only when adding or editing a plan.');
  }
  if (action === 'add') {
    const copied = () => planSecurityCap(caps, parsePlatformPlanId(body.copyFrom));
    return withPlanSecurityCap(caps, parsePlatformPlanId(body.id), input ?? copied());
  }
  if (action === 'set' && id && input !== undefined) {
    return withPlanSecurityCap(caps, id, input);
  }
  if (removedPlanId) {
    return withPlanSecurityCap(caps, removedPlanId, 'inherit');
  }
  return caps;
}
