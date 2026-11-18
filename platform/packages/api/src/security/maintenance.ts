/**
 * Hourly security audit jobs (spec §6.1, §6.2, §14, §15.3), run from the hourly cron
 * branch only, with the `securityAudits` capability on. Each job is isolated: one
 * failure is logged and the others still run.
 *
 *   always (capability on)          policy not Off
 *   ─ reaper: running past lease    ─ re-poke: stale pending_input → queued, poke
 *     → timed_out                   ─ 24 h wait → skipped:backlog
 *   ─ ended rows still holding a reserve → released
 *   ─ raw output sweep (30 d)       ─ daily probe (entitlement older than 24 h)
 *   ─ scan row retention
 *   ─ closed request retention
 *
 * The reaper and the sweeps also run while the policy is Off: Off cancels waiting
 * scans but a running one still needs its lease enforced, and stored data still ages.
 */
import {
  SECURITY_ENTITLEMENT_MAX_AGE_MS,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { and, asc, lt, sql } from 'drizzle-orm';
import { paginatedR2Delete } from '../assets.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { pokeSecurityScanScheduler } from './enqueue.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import { probeAndRecord } from './probe.ts';
import {
  hasQueuedSecurityScans,
  queueStalePendingSecurityScans,
  reapExpiredSecurityScans,
  releaseStrandedSecurityScanReserves,
  skipBackloggedSecurityScans,
} from './queue.ts';
import { securityScanControllerClient, type SecurityScanController } from './scheduler.ts';
import { securityScans } from './schema.ts';

/** Raw scan output (`findings.json`, ledger) is kept this long (D28). */
export const SECURITY_RAW_OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Scans whose raw output one hourly run deletes, at most. */
export const SECURITY_RAW_SWEEP_LIMIT = 50;
/** ROUTING key of the raw output sweep cursor. */
export const SECURITY_RAW_SWEEP_CURSOR_KEY = 'security-audits:raw-output-sweep';
/** Scan rows: the newest 200 per project, or 180 days (spec §14). */
export const SECURITY_SCAN_ROWS_KEPT = 200;
export const SECURITY_SCAN_ROW_MAX_AGE_MS = 180 * 24 * 60 * 60_000;
/** Closed public requests kept per project (spec §14). */
export const SECURITY_CLOSED_REQUESTS_KEPT = 50;
/** Rows one retention statement deletes, at most. */
export const SECURITY_RETENTION_DELETE_LIMIT = 500;

/** R2 prefix of one scan's raw output. */
export function securityRawOutputPrefix(projectId: string, scanId: string): string {
  return `security-scans/${projectId}/scans/${scanId}/`;
}

/** Daily probe (spec §5.2): the policy is on and the stored result is 24 h old or missing. */
export function securityProbeDue(policy: SecurityPolicy, now: number): boolean {
  if (policy.mode === 'disabled') {
    return false;
  }
  const checkedAt = policy.entitlement ? Date.parse(policy.entitlement.checkedAt) : Number.NaN;
  return !Number.isFinite(checkedAt) || now - checkedAt >= SECURITY_ENTITLEMENT_MAX_AGE_MS;
}

export type SecurityMaintenanceDeps = Readonly<{
  controller: SecurityScanController;
  forget(scanId: string, attempt: number): Promise<unknown>;
  poke(): Promise<void>;
  probe(): Promise<unknown>;
}>;

export type SecurityMaintenanceReport = Readonly<{
  reaped: number;
  reservesReleased: number;
  repoked: number;
  backlogged: number;
  rawSwept: number;
  scanRowsDeleted: number;
  requestsDeleted: number;
  probed: boolean;
}>;

function realDeps(env: ApiEnv['Bindings'], db: Db): SecurityMaintenanceDeps {
  const scheduler = () =>
    env.SECURITY_SCAN_SCHEDULER.get(env.SECURITY_SCAN_SCHEDULER.idFromName('global'));
  return {
    controller: securityScanControllerClient(env),
    forget: (scanId, attempt) => scheduler().forgetModelCalls(scanId, attempt),
    poke: () => pokeSecurityScanScheduler(env),
    probe: () => probeAndRecord(env, db),
  };
}

async function step<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(`[security-maintenance] ${name} failed`, error);
    return fallback;
  }
}

export async function runSecurityMaintenance(
  env: ApiEnv['Bindings'],
  db: Db,
  now: number,
  deps: SecurityMaintenanceDeps = realDeps(env, db),
): Promise<SecurityMaintenanceReport | null> {
  if (!getPlatformCapabilities(env).securityAudits) {
    return null;
  }
  const policy = await readSecurityPolicyLenient(db);
  const reaped = await step('reaper', 0, async () => {
    const scans = await reapExpiredSecurityScans(db, now);
    for (const scan of scans) {
      // The container's own hard cap stops it too; this is sooner and frees the ledger.
      await deps.controller.cancel(scan.scanId, scan.attempt).catch(() => {});
      await deps.forget(scan.scanId, scan.attempt).catch(() => {});
    }
    return scans.length;
  });
  const reservesReleased = await step('stranded reserves', 0, () =>
    releaseStrandedSecurityScanReserves(db),
  );
  let repoked = 0;
  let backlogged = 0;
  let probed = false;
  if (policy.mode !== 'disabled') {
    repoked = await step('re-poke', 0, () => queueStalePendingSecurityScans(db, now));
    backlogged = await step('backlog', 0, () => skipBackloggedSecurityScans(db, now));
    await step('poke', undefined, async () => {
      if (await hasQueuedSecurityScans(db)) {
        await deps.poke();
      }
    });
    if (securityProbeDue(policy, now)) {
      probed = await step('daily probe', false, async () => {
        await deps.probe();
        return true;
      });
    }
  }
  const rawSwept = await step('raw output sweep', 0, () =>
    sweepSecurityRawOutputs(db, env.STATIC_ASSETS_R2, env.ROUTING, now),
  );
  const scanRowsDeleted = await step('scan retention', 0, () =>
    deleteOldSecurityScanRows(db, env.ROUTING, now),
  );
  const requestsDeleted = await step('request retention', 0, () =>
    deleteOldSecurityPublicRequests(db),
  );
  return {
    reaped,
    reservesReleased,
    repoked,
    backlogged,
    rawSwept,
    scanRowsDeleted,
    requestsDeleted,
    probed,
  };
}

type SweepCursor = Readonly<{ finishedAt: string; id: string }>;

async function readSweepCursor(routing: KVNamespace): Promise<SweepCursor | null> {
  const raw = await routing.get(SECURITY_RAW_SWEEP_CURSOR_KEY);
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<SweepCursor>;
    return typeof value.finishedAt === 'string' && typeof value.id === 'string'
      ? { finishedAt: value.finishedAt, id: value.id }
      : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the raw output of scans that finished more than 30 days ago, at most 50
 * scans a run, walking `(finished_at, id)` from a cursor kept in ROUTING.
 */
export async function sweepSecurityRawOutputs(
  db: Db,
  r2: R2Bucket,
  routing: KVNamespace,
  now: number,
): Promise<number> {
  const cursor = await readSweepCursor(routing);
  const due = lt(
    securityScans.finished_at,
    new Date(now - SECURITY_RAW_OUTPUT_RETENTION_MS).toISOString(),
  );
  const rows = await db
    .select({
      id: securityScans.id,
      projectId: securityScans.project_id,
      finishedAt: securityScans.finished_at,
    })
    .from(securityScans)
    .where(
      cursor
        ? and(
            due,
            sql`(${securityScans.finished_at}, ${securityScans.id}) > (${cursor.finishedAt}::timestamptz, ${cursor.id})`,
          )
        : due,
    )
    .orderBy(asc(securityScans.finished_at), asc(securityScans.id))
    .limit(SECURITY_RAW_SWEEP_LIMIT);
  for (const row of rows) {
    await paginatedR2Delete(r2, securityRawOutputPrefix(row.projectId, row.id));
  }
  const last = rows.at(-1);
  if (last?.finishedAt) {
    await routing.put(
      SECURITY_RAW_SWEEP_CURSOR_KEY,
      JSON.stringify({ finishedAt: last.finishedAt, id: last.id }),
    );
  }
  return rows.length;
}

/**
 * Scan rows (spec §14): a row goes once it is outside its project's newest 200 or
 * older than 180 days, at most 500 a run. Never a waiting or running scan, a
 * project's current base (its latest succeeded scan) or an open request's gate scan.
 * Only rows the raw output sweep has passed, so a deleted row never leaves its raw
 * output behind.
 */
export async function deleteOldSecurityScanRows(
  db: Db,
  routing: KVNamespace,
  now: number,
): Promise<number> {
  const cursor = await readSweepCursor(routing);
  if (!cursor) {
    return 0;
  }
  const maxAge = new Date(now - SECURITY_SCAN_ROW_MAX_AGE_MS).toISOString();
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM security_scans WHERE id IN (
      SELECT ranked.id FROM (
        SELECT id, finished_at, status,
          row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rank
        FROM security_scans
      ) ranked
      WHERE ranked.status NOT IN ('pending_input', 'queued', 'running')
        AND ranked.finished_at IS NOT NULL
        AND (ranked.finished_at, ranked.id) <= (${cursor.finishedAt}::timestamptz, ${cursor.id})
        AND (ranked.rank > ${SECURITY_SCAN_ROWS_KEPT} OR ranked.finished_at < ${maxAge}::timestamptz)
        AND ranked.id NOT IN (
          SELECT DISTINCT ON (project_id) id FROM security_scans
          WHERE status = 'succeeded'
          ORDER BY project_id, finished_at DESC NULLS LAST, id DESC
        )
        AND NOT EXISTS (
          SELECT 1 FROM security_public_requests r
          WHERE r.gate_scan_id = ranked.id
            AND r.state IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy')
        )
      LIMIT ${SECURITY_RETENTION_DELETE_LIMIT}
    )
    RETURNING id
  `);
  return deleted.rows.length;
}

/** Closed public requests: the newest 50 per project, never one a bypass row names. */
export async function deleteOldSecurityPublicRequests(db: Db): Promise<number> {
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM security_public_requests WHERE id IN (
      SELECT ranked.id FROM (
        SELECT id,
          row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rank
        FROM security_public_requests
        WHERE state IN ('passed', 'bypassed', 'canceled')
      ) ranked
      WHERE ranked.rank > ${SECURITY_CLOSED_REQUESTS_KEPT}
        AND NOT EXISTS (SELECT 1 FROM security_scan_bypasses b WHERE b.request_id = ranked.id)
      LIMIT ${SECURITY_RETENTION_DELETE_LIMIT}
    )
    RETURNING id
  `);
  return deleted.rows.length;
}
