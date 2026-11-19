/**
 * Opt-in fallback to the `@cf` default (design doc 0095 M26, spec §8.5). With the policy's
 * `fallbackToCf` on, a scan on a third-party model that is refused, gives bad output or
 * times out is followed by one `trigger=fallback` scan of the same deployment:
 *
 *   scan on anthropic/… or openai/… ends refused | failed (bad_output) | timed_out
 *     └─ still the project's newest scan, its deployment still live, ended < 24 h ago
 *          └─► queueSecurityRescan(trigger: fallback) ─► runs on securityCfDefaultModel
 *
 * Never from `@cf` to a third-party model, and never a fallback of a fallback. The scan
 * covers what the failed one did: the base rule, or a full scan again after a rescan or
 * a sweep. A fallback of a gate scan keeps its request and the gate rules. Run right after
 * ingest and by the hourly job (a reaper `timed_out`, a lost call).
 */
import type { SecurityPolicy } from '@void/platform/security-policy';
import { sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { securityCfDefaultModel } from './models.ts';
import { queueSecurityRescan } from './operator.ts';

/** A failed scan older than this gets no fallback (the hourly backstop stops trying). */
export const SECURITY_FALLBACK_MAX_AGE_MS = 24 * 60 * 60_000;

export type SecurityFallbackFacts = Readonly<{
  status: string;
  statusReason: string | null;
  trigger: string;
  modelUsed: string | null;
}>;

/** Whether an ended scan calls for a fallback (the policy aside). */
export function securityScanWantsFallback(scan: SecurityFallbackFacts): boolean {
  if (scan.trigger === 'fallback' || scan.trigger === 'local') {
    return false;
  }
  if (scan.modelUsed === null || scan.modelUsed.startsWith('@cf/')) {
    return false;
  }
  return (
    scan.status === 'refused' ||
    scan.status === 'timed_out' ||
    (scan.status === 'failed' && scan.statusReason === 'bad_output')
  );
}

export type SecurityFallbackQueued = Readonly<{
  projectId: string;
  /** The failed scan. */
  fromScanId: string;
  scanId: string;
}>;

type Candidate = Readonly<{
  project_id: string;
  id: string;
  trigger: string;
  open_request_id: string | null;
}>;

/**
 * Queues the fallback scans that are due. With `projectId`, only that project (after an
 * ingest). Returns what was queued; a refusal (no stored code, a scan already waiting)
 * is logged and skipped.
 */
export async function queueSecurityFallbackScans(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: Db,
  policy: SecurityPolicy,
  options: Readonly<{ now: number; projectId?: string }>,
): Promise<Array<SecurityFallbackQueued>> {
  if (
    !policy.fallbackToCf ||
    policy.mode === 'disabled' ||
    securityCfDefaultModel(policy) === null
  ) {
    return [];
  }
  const since = new Date(options.now - SECURITY_FALLBACK_MAX_AGE_MS).toISOString();
  const project =
    options.projectId === undefined ? sql`` : sql`AND s.project_id = ${options.projectId}`;
  // The project's newest scan, if it is a third-party failure of the live deployment
  // (the same rule as `securityScanWantsFallback`).
  const result = await db.execute(sql`
    SELECT latest.project_id, latest.id, latest.trigger,
           (SELECT r.id FROM security_public_requests r
             WHERE r.project_id = latest.project_id
               AND r.state IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy')
             LIMIT 1) AS open_request_id
    FROM (
      SELECT DISTINCT ON (s.project_id)
             s.project_id, s.id, s.status, s.status_reason, s.trigger, s.model_used,
             s.finished_at, s.deployment_id
      FROM security_scans s
      WHERE TRUE ${project}
      ORDER BY s.project_id, s.created_at DESC, s.id DESC
    ) latest
    JOIN projects p ON p.id = latest.project_id AND p.active_deployment_id = latest.deployment_id
    WHERE latest.finished_at > ${since}::timestamptz
      AND (latest.status IN ('refused', 'timed_out')
           OR (latest.status = 'failed' AND latest.status_reason = 'bad_output'))
      AND latest.trigger NOT IN ('fallback', 'local')
      AND latest.model_used IS NOT NULL AND latest.model_used NOT LIKE '@cf/%'
    ORDER BY latest.finished_at ASC
    LIMIT 50`);
  const rows = result.rows as Array<Candidate>;
  const queued: Array<SecurityFallbackQueued> = [];
  for (const row of rows) {
    try {
      const { scanId } = await queueSecurityRescan(env, db, row.project_id, {
        trigger: 'fallback',
        by: 'operator',
        publicRequestId: row.open_request_id,
        fallbackOf: row.trigger === 'rescan' || row.trigger === 'sweep' ? row.trigger : null,
      });
      console.info('[security-scan] fallback scan queued on the @cf default', {
        projectId: row.project_id,
        fromScanId: row.id,
        scanId,
      });
      queued.push({ projectId: row.project_id, fromScanId: row.id, scanId });
    } catch (error) {
      if (!(error instanceof OperatorError)) {
        throw error;
      }
      console.warn('[security-scan] fallback scan not queued', {
        projectId: row.project_id,
        fromScanId: row.id,
        reason: error.code,
      });
    }
  }
  return queued;
}
