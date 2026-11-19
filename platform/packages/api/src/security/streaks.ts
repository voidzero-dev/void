/**
 * Failure streaks (design doc 0095 M26, spec §11.4, §12): the reads behind the streak
 * emails `alerts.ts` queues each hour. Split by cause, like the panel flags:
 *
 *   project cause: 3+ ended scans in a row did not succeed     ─► streak_project
 *     (refused, bad output, timed out, incomplete, input missing; failure_cause = project)
 *     owner + project admins + installation admins, once per streak
 *   installation cause: > 20% of the last 24 h's scans failed  ─► streak_installation
 *     for a platform reason (credits, infrastructure, backlog)   installation admins,
 *     at least 3 of them                                         at most once per UTC day
 *
 * A streak is keyed by the newest scan before it that was not a project-cause failure,
 * so it is one email however long it grows; a success starts a new one. A skipped scan
 * (a backlog skip too) neither counts nor breaks a streak, as in the panel flag. The key
 * can still move (a streak longer than the window, a deleted scan), so a project with a
 * `streak_project` row newer than its last good scan gets no second one. Only a streak
 * whose newest failure ended in the last 48 hours is emailed, so turning this on does
 * not mail old news.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';

/** Ended project-cause failures in a row that make a streak (the panel flag uses the same). */
export const SECURITY_STREAK_MIN_FAILURES = 3;
/** Ended scans per project the streak query looks at. */
export const SECURITY_STREAK_WINDOW = 50;
/** A streak whose newest failure is older than this is not emailed. */
export const SECURITY_STREAK_FRESH_MS = 48 * 60 * 60_000;
/** Installation-cause failures needed in 24 h, and the share of ended scans they must pass. */
export const SECURITY_INSTALLATION_FAILURE_MIN = 3;
export const SECURITY_INSTALLATION_FAILURE_RATE = 0.2;

/** Statuses that end a scan with a result: the project streak reads only these. */
const PROJECT_ENDED_SQL = sql.raw(
  `(status IN ('succeeded', 'incomplete', 'failed', 'refused', 'timed_out'))`,
);
/** For the installation flag a backlog skip counts too; superseded, canceled and other skips do not. */
const ENDED_SQL = sql.raw(
  `(status IN ('succeeded', 'incomplete', 'failed', 'refused', 'timed_out') OR (status = 'skipped' AND status_reason = 'backlog'))`,
);
const PROJECT_FAILURE_SQL = sql.raw(
  `(status IN ('incomplete', 'failed', 'refused', 'timed_out') AND failure_cause = 'project')`,
);
const INSTALLATION_FAILURE_SQL = sql.raw(
  `(failure_cause = 'installation' OR (status = 'skipped' AND status_reason = 'backlog'))`,
);

export type SecurityProjectStreak = Readonly<{
  projectId: string;
  failures: number;
  /** The newest scan before the streak that was not a project-cause failure, or `null`. */
  sinceScanId: string | null;
  /** Newest first. */
  scanIds: ReadonlyArray<string>;
}>;

function rows<T>(result: { rows: ReadonlyArray<unknown> }): Array<T> {
  return result.rows as Array<T>;
}

/**
 * Project streaks now: projects whose newest ended scans are 3+ project-cause failures.
 * With `projectId`, only that project (the delivery re-reads its streak).
 */
export async function listSecurityProjectStreaks(
  db: DbOrTx,
  options: Readonly<{ now: number; projectId?: string; freshOnly?: boolean }>,
): Promise<Array<SecurityProjectStreak>> {
  const project =
    options.projectId === undefined ? sql`` : sql`AND project_id = ${options.projectId}`;
  const freshSince = new Date(options.now - SECURITY_STREAK_FRESH_MS).toISOString();
  const fresh =
    options.freshOnly === false ? sql`` : sql`AND max(finished_at) > ${freshSince}::timestamptz`;
  const result = await db.execute(sql`
    WITH recent AS (
      SELECT id, project_id, finished_at, ${PROJECT_FAILURE_SQL} AS bad,
             row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rn
      FROM security_scans
      WHERE ${PROJECT_ENDED_SQL} ${project}
    ),
    windowed AS (SELECT * FROM recent WHERE rn <= ${SECURITY_STREAK_WINDOW}),
    breaks AS (
      SELECT DISTINCT ON (project_id) project_id, id AS since_id, rn AS since_rn
      FROM windowed WHERE NOT bad
      ORDER BY project_id, rn ASC
    )
    SELECT w.project_id,
           count(*)::int AS failures,
           b.since_id,
           array_agg(w.id ORDER BY w.rn ASC) AS scan_ids
    FROM windowed w
    LEFT JOIN breaks b ON b.project_id = w.project_id
    WHERE w.bad AND (b.since_rn IS NULL OR w.rn < b.since_rn)
    GROUP BY w.project_id, b.since_id
    HAVING count(*) >= ${SECURITY_STREAK_MIN_FAILURES} ${fresh}
    ORDER BY w.project_id
    LIMIT 200`);
  return rows<{
    project_id: string;
    failures: number;
    since_id: string | null;
    scan_ids: Array<string>;
  }>(result).map((row) => ({
    projectId: row.project_id,
    failures: Number(row.failures),
    sinceScanId: row.since_id,
    scanIds: row.scan_ids,
  }));
}

/**
 * Whether this project already has a streak email for the streak going on now: a
 * `streak_project` row created after its last ended scan that was not a project-cause
 * failure finished. Read before queueing, so a key that moved does not send a second
 * email: a streak past the window loses its `since` scan, and retention can delete it.
 */
export async function securityProjectStreakAlreadyQueued(
  db: DbOrTx,
  projectId: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM security_notifications n
    WHERE n.project_id = ${projectId} AND n.kind = 'streak_project'
      AND n.created_at > COALESCE(
        (SELECT max(COALESCE(finished_at, created_at)) FROM security_scans
          WHERE project_id = ${projectId} AND ${PROJECT_ENDED_SQL} AND NOT ${PROJECT_FAILURE_SQL}),
        '-infinity'::timestamptz)
    LIMIT 1`);
  return result.rows.length > 0;
}

export type SecurityInstallationFailures = Readonly<{
  /** Scans that ended in the last 24 h. */
  ended: number;
  /** Of those, failures with an installation cause. */
  failed: number;
  byReason: Readonly<Record<string, number>>;
}>;

/** Installation-cause failures among the scans that ended in the 24 h before `now`. */
export async function readSecurityInstallationFailures(
  db: DbOrTx,
  now: number,
): Promise<SecurityInstallationFailures> {
  const since = new Date(now - 24 * 60 * 60_000).toISOString();
  const until = new Date(now).toISOString();
  const result = await db.execute(sql`
    SELECT CASE WHEN ${INSTALLATION_FAILURE_SQL}
                THEN COALESCE(status_reason, status) END AS reason,
           count(*)::int AS total
    FROM security_scans
    WHERE ${ENDED_SQL}
      AND finished_at > ${since}::timestamptz AND finished_at <= ${until}::timestamptz
    GROUP BY 1`);
  let ended = 0;
  let failed = 0;
  const byReason: Record<string, number> = {};
  for (const row of rows<{ reason: string | null; total: number }>(result)) {
    const total = Number(row.total);
    ended += total;
    if (row.reason !== null) {
      failed += total;
      byReason[row.reason] = (byReason[row.reason] ?? 0) + total;
    }
  }
  return { ended, failed, byReason };
}

/** The installation-wide flag: enough platform failures, and more than 20% of ended scans. */
export function securityInstallationFailing(failures: SecurityInstallationFailures): boolean {
  return (
    failures.failed >= SECURITY_INSTALLATION_FAILURE_MIN &&
    failures.failed > failures.ended * SECURITY_INSTALLATION_FAILURE_RATE
  );
}

/** `2026-11-20`: the UTC day of `now`, the installation streak's dedupe key. */
export function securityUtcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
