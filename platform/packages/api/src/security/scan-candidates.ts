/**
 * Projects a batch scan may queue (design doc 0095, M25):
 *
 *   backfill  live deployment has no succeeded scan       (admin "scan active deployments now")
 *   sweep     no sweep and no succeeded full scan within everyDays   (hourly, policy `sweeps`)
 *
 * Both need a project in scope (active, not a preview, public under `public` mode), a
 * live deployment whose code is stored, an owner who is not suspended, and nothing
 * waiting or running. A project whose code is gone is left out (counted apart with
 * `code: 'missing'`): it would be refused every time and keep the head of the list. The
 * per-project checks run again when each scan is queued (`queueSecurityRescan`), so this
 * list only narrows the work; it never decides alone.
 */
import type { SecurityMode } from '@void/platform/security-policy';
import { and, asc, count, eq, isNull, notLike, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import { deployments, projects, projectZeroTrust, users } from '../schema.ts';
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

const protectedRow = sql`(${projectZeroTrust.status} = 'ready' AND ${projectZeroTrust.desired_protected} AND ${projectZeroTrust.effective_protected})`;

/**
 * The SQL side of `findLiveInput`: the stored Worker bundle, or a scan row of the
 * deployment that points at its snapshot. Every snapshot writer records its key on a
 * row (a copy no row claims is deleted), so only an R2 object lost under its row passes
 * here and is refused later, when `queueSecurityRescan` reads R2. The other way round,
 * a snapshot whose rows all aged out (retention: 200 rows or 180 days, never the newest
 * succeeded one) reads as missing until the project deploys again.
 */
const storedCode = sql`(${deployments.bundle_stored} OR EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${deployments.id} AND s.input_r2_key IS NOT NULL))`;

function conditions(
  query: SecurityCandidateQuery,
  code: SecurityCandidateCode = 'stored',
): SQL | undefined {
  const scope =
    query.mode === 'disabled'
      ? sql`false`
      : query.mode === 'public' && query.protects
        ? sql`NOT COALESCE(${protectedRow}, false)`
        : undefined;
  const idle = sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.status IN ('pending_input', 'queued', 'running'))`;
  let due: SQL;
  if (query.kind === 'backfill') {
    due = sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.deployment_id = ${projects.active_deployment_id} AND s.status = 'succeeded')`;
  } else {
    const since = new Date(query.now - (query.everyDays ?? 30) * DAY_MS).toISOString();
    // A sweep that started or was refused counts, whatever its end: a failed sweep waits
    // for the next window instead of being retried every hour. One that never got to
    // run does not: replaced by a deploy scan (`superseded`) or canceled by policy Off.
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

/**
 * Up to `limit` candidates. Sweeps go to the project swept longest ago first (never
 * swept first); a backfill goes oldest project first.
 */
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
