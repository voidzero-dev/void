/**
 * Opt-in fallback to the `@cf` default (design doc 0095 M26, spec §8.5): when the newest
 * scan of the live deployment ran on a third-party model and was refused, gave bad output
 * or timed out in the last 24 h, one `trigger=fallback` scan covers the same work on
 * `securityCfDefaultModel`. Never a fallback of a fallback. Runs after ingest and hourly.
 */
import type { SecurityPolicy } from '@void/platform/security-policy';
import { sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { SECURITY_CLIENT_ASSETS_NOTE } from './input/build.ts';
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

type Candidate = Readonly<{
  project_id: string;
  id: string;
  trigger: string;
  coverage_notes: ReadonlyArray<string> | null;
  open_request_id: string | null;
}>;

/** Queues the fallback scans that are due; a refusal is logged and skipped. */
export async function queueSecurityFallbackScans(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: Db,
  policy: SecurityPolicy,
  options: Readonly<{ now: number; projectId?: string }>,
) {
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
  // The newest non-local scan, by the rule of `securityScanWantsFallback`.
  const result = await db.execute(sql`
    SELECT latest.project_id, latest.id, latest.trigger, latest.coverage_notes,
           (SELECT r.id FROM security_public_requests r
             WHERE r.project_id = latest.project_id
               AND r.state IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy')
             LIMIT 1) AS open_request_id
    FROM (
      SELECT DISTINCT ON (s.project_id)
             s.project_id, s.id, s.status, s.status_reason, s.trigger, s.model_used,
             s.finished_at, s.deployment_id, s.coverage_notes
      FROM security_scans s
      WHERE s.trigger <> 'local' ${project}
      ORDER BY s.project_id, s.created_at DESC, s.id DESC
    ) latest
    JOIN projects p ON p.id = latest.project_id AND p.active_deployment_id = latest.deployment_id
    WHERE latest.finished_at > ${since}::timestamptz
      AND (latest.status IN ('refused', 'timed_out')
           OR (latest.status = 'failed' AND latest.status_reason = 'bad_output'))
      AND latest.trigger <> 'fallback'
      AND latest.model_used IS NOT NULL AND latest.model_used NOT LIKE '@cf/%'
    ORDER BY latest.finished_at ASC
    LIMIT 50`);
  const rows = result.rows as Array<Candidate>;
  const queued: Array<{ projectId: string; fromScanId: string; scanId: string }> = [];
  for (const row of rows) {
    try {
      const { scanId } = await queueSecurityRescan(env, db, row.project_id, {
        trigger: 'fallback',
        by: 'operator',
        publicRequestId: row.open_request_id,
        fallbackOf: row.trigger === 'rescan' || row.trigger === 'sweep' ? row.trigger : null,
        // M31: a fallback of a rescan with the client asset pass runs it too.
        clientAssets: row.coverage_notes?.includes(SECURITY_CLIENT_ASSETS_NOTE) === true,
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
