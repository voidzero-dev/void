/**
 * The weekly digest (design doc 0095 M26, spec §20): one email to installation admins
 * after each UTC week (Monday to Sunday) with counts only, queued by the hourly job
 * while the policy's `digest` is on. A week with no scan, no new finding and nothing
 * urgent sends nothing.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import { listSecurityProjectStreaks, rows } from './streaks.ts';

const DAY_MS = 24 * 60 * 60_000;

type SecurityDigestWeek = ReturnType<typeof securityDigestWeek>;

/** The last full UTC week before `now`; `week`, its Monday, is the dedupe key. */
export function securityDigestWeek(now: number) {
  const day = new Date(now);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  // getUTCDay: Sunday 0 … Saturday 6; days since this week's Monday.
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  const toMs = midnight - sinceMonday * DAY_MS;
  const fromMs = toMs - 7 * DAY_MS;
  return { week: new Date(fromMs).toISOString().slice(0, 10), fromMs, toMs };
}

function int(value: unknown): number {
  return Number(value ?? 0);
}

/** Counts of the week; the open urgent counts are of now. */
export async function readSecurityDigestCounts(db: DbOrTx, week: SecurityDigestWeek, now: number) {
  const from = new Date(week.fromMs).toISOString();
  const to = new Date(week.toMs).toISOString();
  const [scans] = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE status IN ('succeeded', 'incomplete', 'failed', 'refused', 'timed_out')
                                 OR (status = 'skipped' AND status_reason IN ('backlog', 'budget'))) AS ended,
             count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
             count(*) FILTER (WHERE status IN ('incomplete', 'failed', 'refused', 'timed_out')
                                AND failure_cause = 'project') AS project_failures,
             count(*) FILTER (WHERE failure_cause = 'installation'
                                 OR (status = 'skipped' AND status_reason = 'backlog')) AS installation_failures,
             count(*) FILTER (WHERE status = 'skipped' AND status_reason = 'budget') AS budget_skips
      FROM security_scans
      WHERE finished_at >= ${from}::timestamptz AND finished_at < ${to}::timestamptz`),
  );
  const [findings] = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE verdict = 'confirmed' AND COALESCE(severity_override, severity) = 'critical') AS critical,
             count(*) FILTER (WHERE verdict = 'confirmed' AND COALESCE(severity_override, severity) = 'high') AS high,
             count(*) FILTER (WHERE verdict = 'confirmed' AND COALESCE(severity_override, severity) = 'medium') AS medium,
             count(*) FILTER (WHERE verdict = 'confirmed' AND COALESCE(severity_override, severity) = 'low') AS low,
             count(*) FILTER (WHERE verdict = 'needs_validation') AS leads
      FROM security_findings
      WHERE created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz`),
  );
  const [state] = rows<Record<string, unknown>>(
    await db.execute(sql`
      SELECT
        (SELECT count(*) FROM security_findings
          WHERE state = 'resolved' AND resolved_at >= ${from}::timestamptz AND resolved_at < ${to}::timestamptz) AS resolved,
        (SELECT count(*) FROM security_findings
          WHERE verdict = 'confirmed' AND state = 'open'
            AND COALESCE(severity_override, severity) IN ('critical', 'high')) AS urgent,
        (SELECT count(DISTINCT project_id) FROM security_findings
          WHERE verdict = 'confirmed' AND state = 'open'
            AND COALESCE(severity_override, severity) IN ('critical', 'high')) AS urgent_projects,
        (SELECT count(*) FROM security_public_requests
          WHERE state IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy')) AS open_requests,
        (SELECT count(*) FROM security_scan_bypasses
          WHERE created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz) AS bypasses`),
  );
  const streaks = await listSecurityProjectStreaks(db, { now, freshOnly: false });
  return {
    week: week.week,
    scans: {
      ended: int(scans?.ended),
      succeeded: int(scans?.succeeded),
      projectFailures: int(scans?.project_failures),
      installationFailures: int(scans?.installation_failures),
      budgetSkips: int(scans?.budget_skips),
    },
    newFindings: {
      critical: int(findings?.critical),
      high: int(findings?.high),
      medium: int(findings?.medium),
      low: int(findings?.low),
      leads: int(findings?.leads),
    },
    resolvedFindings: int(state?.resolved),
    openUrgentFindings: int(state?.urgent),
    projectsWithUrgentFindings: int(state?.urgent_projects),
    projectsWithFailureStreaks: streaks.length,
    openPublicRequests: int(state?.open_requests),
    bypasses: int(state?.bypasses),
  };
}

/** Nothing ran, nothing new, nothing urgent: no digest. */
export function securityDigestIsEmpty(
  counts: Awaited<ReturnType<typeof readSecurityDigestCounts>>,
): boolean {
  const found = counts.newFindings;
  return (
    counts.scans.ended === 0 &&
    found.critical + found.high + found.medium + found.low + found.leads === 0 &&
    counts.resolvedFindings === 0 &&
    counts.openUrgentFindings === 0 &&
    counts.openPublicRequests === 0 &&
    counts.bypasses === 0
  );
}
