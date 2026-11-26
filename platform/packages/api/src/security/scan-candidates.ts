/**
 * Projects a batch scan may queue (design doc 0095, M25): a backfill when the live
 * deployment has no succeeded scan, a sweep when there was no sweep or full scan within
 * `everyDays`. Both need a project in scope with stored live code, an unsuspended owner
 * and nothing waiting; code that is gone is counted apart (`code: 'missing'`). Each scan is
 * checked again by `queueSecurityRescan`, so this list only narrows the work.
 */
import type { SecurityMode } from '@void/platform/security-policy';
import { and, asc, count, eq, isNull, notLike, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import { deployments, projects, projectZeroTrust, users } from '../schema.ts';
import { securityProjectInScopeSql } from './project-policy.ts';
import { projectSecuritySettings } from './schema.ts';

export type SecurityCandidateKind = 'backfill' | 'sweep';

export type SecurityCandidateQuery = Readonly<{
  kind: SecurityCandidateKind;
  mode: SecurityMode;
  /** Installation Zero Trust protects projects now (`installationZeroTrustProtects`). */
  protects: boolean;
  /** Sweeps only: days between two sweeps of one project. */
  everyDays?: number;
  now: number;
}>;

/** `stored`: the live code can be read for a scan (the default); `missing`: it cannot. */
export type SecurityCandidateCode = 'stored' | 'missing';

export type SecurityCandidate = Readonly<{
  projectId: string;
  slug: string;
  deploymentId: string;
  model: string | null;
  noticeVersion: number | null;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The SQL side of `findLiveInput`: the stored bundle, or a scan row with its snapshot key. */
const storedCode = sql`(${deployments.bundle_stored} OR EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${deployments.id} AND s.input_r2_key IS NOT NULL))`;

function conditions(
  query: SecurityCandidateQuery,
  code: SecurityCandidateCode = 'stored',
): SQL | undefined {
  const scope =
    query.mode === 'disabled' ? sql`false` : securityProjectInScopeSql(query.mode, query.protects);
  const idle = sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.status IN ('pending_input', 'queued', 'running'))`;
  let due: SQL;
  if (query.kind === 'backfill') {
    due = sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${projects.active_deployment_id} AND s.status = 'succeeded')`;
  } else {
    const since = new Date(query.now - (query.everyDays ?? 30) * DAY_MS).toISOString();
    // A failed sweep waits for the next window; one that never ran (superseded, policy Off) does not count.
    const sweptRow = sql`s.trigger = 'sweep' AND s.created_at > ${since}::timestamptz AND s.status <> 'superseded' AND NOT (s.status = 'canceled' AND s.status_reason IS NOT DISTINCT FROM 'policy_off')`;
    // A local check (M32) is a full scan of a working tree, not of the live deployment.
    const fullRow = sql`s.tier = 'full' AND s.status = 'succeeded' AND s.trigger <> 'local' AND s.finished_at > ${since}::timestamptz`;
    due = sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND ((${sweptRow}) OR (${fullRow})))`;
  }
  return and(
    eq(projects.status, 'active'),
    notLike(projects.slug, 'preview-%'),
    eq(deployments.status, 'live'),
    isNull(users.suspended_reason),
    scope,
    idle,
    due,
    code === 'stored' ? storedCode : sql`NOT ${storedCode}`,
  );
}

function from(db: DbOrTx) {
  return {
    select: db
      .select({
        projectId: projects.id,
        slug: projects.slug,
        deploymentId: deployments.id,
        model: projectSecuritySettings.model,
        noticeVersion: projectSecuritySettings.provider_notice_version,
      })
      .from(projects)
      .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
      .innerJoin(users, eq(users.id, projects.user_id))
      .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id))
      .leftJoin(projectSecuritySettings, eq(projectSecuritySettings.project_id, projects.id)),
    count: db
      .select({ total: count() })
      .from(projects)
      .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
      .innerJoin(users, eq(users.id, projects.user_id))
      .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id)),
  };
}

/** Up to `limit` candidates: sweeps longest-unswept first, a backfill oldest project first. */
export async function listSecurityScanCandidates(
  db: DbOrTx,
  query: SecurityCandidateQuery,
  limit: number,
): Promise<Array<SecurityCandidate>> {
  if (limit <= 0) {
    return [];
  }
  const lastSweep = sql`(SELECT max(s.created_at) FROM security_scans s WHERE s.project_id = ${projects.id} AND s.trigger = 'sweep')`;
  return await from(db)
    .select.where(conditions(query))
    .orderBy(
      ...(query.kind === 'sweep' ? [sql`${lastSweep} ASC NULLS FIRST`] : []),
      asc(projects.created_at),
      asc(projects.id),
    )
    .limit(limit);
}

/** How many projects are due; `code: 'missing'` counts the ones whose code is gone. */
export async function countSecurityScanCandidates(
  db: DbOrTx,
  query: SecurityCandidateQuery,
  code: SecurityCandidateCode = 'stored',
): Promise<number> {
  const [row] = await from(db).count.where(conditions(query, code));
  return row?.total ?? 0;
}
