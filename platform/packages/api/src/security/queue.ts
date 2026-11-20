import type {
  SecurityMode,
  SecurityPlanCap,
  SecurityPolicyLimits,
} from '@void/platform/security-policy';
/**
 * The scan queue in PostgreSQL (spec §6.2): what the `SecurityScanScheduler` DO and
 * the hourly jobs read and write. Every write that ends or restarts an attempt is a
 * compare-and-set on `status` + `attempt`, the fencing token: a late write from an
 * older attempt, or one the reaper already ended, changes nothing (edge #33).
 *
 *   queued ──claim──► running ──end──► succeeded | failed | timed_out | skipped:budget …
 *     │                  └──requeue (one infra retry)──► queued
 *     └──claim refuses──► skipped:protected | skipped:backlog | canceled
 */
import { and, asc, eq, gt, inArray, lt, ne, notExists, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db, DbOrTx } from '../db.ts';
import { hasSqlState } from '../pg-errors.ts';
import { projects, projectZeroTrust, users } from '../schema.ts';
import { releaseSecurityScanReserve, releaseSecurityScanReserveIn } from './budget.ts';
import type { SecurityScanModel } from './models.ts';
import { readSecurityPlanCapCell, securityPlanCapSql } from './plan-caps.ts';
import { installationZeroTrustProtects, readSecurityPolicyLenient } from './policy.ts';
import { projectSecuritySettings, securityScans, type SecurityScanTrigger } from './schema.ts';

/** One start plus one retry after an infrastructure error (spec §6.2). */
export const SECURITY_SCAN_MAX_ATTEMPTS = 2;
/** The lease is the hard cap (2× the wall clock) plus this. */
export const SECURITY_SCAN_LEASE_GRACE_MS = 5 * 60_000;
/** A scan waiting longer than this from `first_queued_at` is `skipped:backlog`. */
export const SECURITY_SCAN_MAX_QUEUE_WAIT_MS = 24 * 60 * 60_000;
/** Queued scans one scheduler pass looks at, oldest first. */
export const SECURITY_SCAN_CANDIDATE_LIMIT = 200;
/** A `pending_input` row older than this lost its after-commit step. */
export const SECURITY_SCAN_PENDING_INPUT_REPOKE_MS = 10 * 60_000;

const WAITING_STATUSES = ['pending_input', 'queued'] as const;
const ACTIVE_STATUSES = [...WAITING_STATUSES, 'running'] as const;

export type SecurityScanTimes = Readonly<{
  wallClockMs: number;
  hardCapMs: number;
  leaseUntil: string;
}>;

/** Wall clock from the policy, hard cap 2× it, lease the hard cap + 5 min (spec §6.2, §6.3). */
export function securityScanTimes(
  limits: Pick<SecurityPolicyLimits, 'timeoutMinutes'>,
  now: number,
): SecurityScanTimes {
  const wallClockMs = limits.timeoutMinutes * 60_000;
  const hardCapMs = wallClockMs * 2;
  return {
    wallClockMs,
    hardCapMs,
    leaseUntil: new Date(now + hardCapMs + SECURITY_SCAN_LEASE_GRACE_MS).toISOString(),
  };
}

export type SecurityRunningScan = Readonly<{
  scanId: string;
  projectId: string;
  modelUsed: string | null;
}>;

export type SecurityScanCandidate = Readonly<{
  scanId: string;
  projectId: string;
  ownerId: string;
  trigger: SecurityScanTrigger;
  attempt: number;
  firstQueuedAt: string | null;
  reservedNano: number;
  model: string | null;
  noticeVersion: number | null;
  monthlyCapCents: number | null;
  capCeilingCents: number | null;
  /** The cap of the owner's plan (M27). */
  planCap: SecurityPlanCap;
}>;

export type SecurityScanQueueView = Readonly<{
  running: ReadonlyArray<SecurityRunningScan>;
  /** Queued scans of projects with no running scan, oldest first. */
  candidates: ReadonlyArray<SecurityScanCandidate>;
  /** Every queued scan, startable or not. */
  queued: number;
}>;

export async function readSecurityScanQueue(
  db: DbOrTx,
  limit = SECURITY_SCAN_CANDIDATE_LIMIT,
): Promise<SecurityScanQueueView> {
  const running = await db
    .select({
      scanId: securityScans.id,
      projectId: securityScans.project_id,
      modelUsed: securityScans.model_used,
    })
    .from(securityScans)
    .where(eq(securityScans.status, 'running'));
  const busy = alias(securityScans, 'busy');
  const rows = await db
    .select({
      scanId: securityScans.id,
      projectId: securityScans.project_id,
      ownerId: projects.user_id,
      trigger: securityScans.trigger,
      attempt: securityScans.attempt,
      firstQueuedAt: securityScans.first_queued_at,
      reservedNano: securityScans.reserved_nano_usd,
      model: projectSecuritySettings.model,
      noticeVersion: projectSecuritySettings.provider_notice_version,
      monthlyCapCents: projectSecuritySettings.monthly_cap_cents,
      capCeilingCents: projectSecuritySettings.cap_ceiling_cents,
      planCap: securityPlanCapSql(projects.user_id),
    })
    .from(securityScans)
    .innerJoin(projects, eq(projects.id, securityScans.project_id))
    .leftJoin(
      projectSecuritySettings,
      eq(projectSecuritySettings.project_id, securityScans.project_id),
    )
    .where(
      and(
        eq(securityScans.status, 'queued'),
        notExists(
          db
            .select({ id: busy.id })
            .from(busy)
            .where(and(eq(busy.project_id, securityScans.project_id), eq(busy.status, 'running'))),
        ),
      ),
    )
    .orderBy(
      sql`${securityScans.first_queued_at} ASC NULLS LAST`,
      asc(securityScans.created_at),
      asc(securityScans.id),
    )
    .limit(limit);
  const candidates = rows.map((row) => ({ ...row, planCap: readSecurityPlanCapCell(row.planCap) }));
  const [queued] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(securityScans)
    .where(eq(securityScans.status, 'queued'));
  return { running, candidates, queued: queued?.count ?? 0 };
}

export type SecurityClaimOutcome =
  | Readonly<{ kind: 'claimed'; attempt: number; times: SecurityScanTimes }>
  /** Ended at claim: `skipped:protected`, `skipped:backlog` or `canceled`. */
  | Readonly<{ kind: 'ended'; status: 'skipped' | 'canceled'; reason: string }>
  /** Another scan of the project is running; the row stays queued. */
  | Readonly<{ kind: 'busy' }>
  /** No longer queued at the attempt read (canceled, superseded, claimed). */
  | Readonly<{ kind: 'gone' }>;

/** Spec §4, fail-safe: protected only when every part says so, read fresh. */
async function projectIsProtected(tx: DbOrTx, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({
      status: projectZeroTrust.status,
      desired: projectZeroTrust.desired_protected,
      effective: projectZeroTrust.effective_protected,
    })
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, projectId))
    .limit(1);
  return (
    row?.status === 'ready' &&
    row.desired === true &&
    row.effective === true &&
    (await installationZeroTrustProtects(tx))
  );
}

/**
 * Moves one queued scan to `running` with a new attempt and lease, under the project
 * row lock. The checks the enqueue made are made again, since the row may have waited:
 * a project being deleted or a suspended owner cancels it, a wait past 24 h skips it
 * (`backlog`), and under `public` a non-gate scan of a project that is now protected is
 * `skipped:protected` (spec §5.4 All → Public). A gate scan still runs (§5.5).
 */
export async function claimSecurityScan(
  db: Db,
  input: Readonly<{
    scanId: string;
    /** The attempt the queue read; a different one means the row moved meanwhile. */
    attempt: number;
    model: SecurityScanModel;
    limits: Pick<SecurityPolicyLimits, 'timeoutMinutes'>;
    now: number;
  }>,
): Promise<SecurityClaimOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [scan] = await tx
        .select({ projectId: securityScans.project_id })
        .from(securityScans)
        .where(eq(securityScans.id, input.scanId))
        .limit(1);
      if (!scan) {
        return { kind: 'gone' } as const;
      }
      // Lock order as at enqueue: project row, then the policy lock (shared), so an
      // Off write waits for this claim instead of missing it.
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${scan.projectId} FOR UPDATE`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('void:platform:security-policy', 0))`,
      );
      const [row] = await tx
        .select({
          status: securityScans.status,
          attempt: securityScans.attempt,
          trigger: securityScans.trigger,
          publicRequestId: securityScans.public_request_id,
          firstQueuedAt: securityScans.first_queued_at,
          projectStatus: projects.status,
          suspended: users.suspended_reason,
        })
        .from(securityScans)
        .innerJoin(projects, eq(projects.id, securityScans.project_id))
        .innerJoin(users, eq(users.id, projects.user_id))
        .where(eq(securityScans.id, input.scanId))
        .limit(1);
      if (!row || row.status !== 'queued' || row.attempt !== input.attempt) {
        return { kind: 'gone' } as const;
      }
      const policy = await readSecurityPolicyLenient(tx);
      if (policy.mode === 'disabled') {
        return { kind: 'gone' } as const;
      }
      const end = await claimRefusal(tx, policy.mode, scan.projectId, row, input.now);
      if (end) {
        await tx
          .update(securityScans)
          .set({ status: end.status, status_reason: end.reason, finished_at: sql`now()` })
          .where(and(eq(securityScans.id, input.scanId), eq(securityScans.status, 'queued')));
        return end;
      }
      const times = securityScanTimes(input.limits, input.now);
      const [claimed] = await tx
        .update(securityScans)
        .set({
          status: 'running',
          attempt: sql`${securityScans.attempt} + 1`,
          lease_until: times.leaseUntil,
          model_requested: input.model.requested,
          model_used: input.model.used,
          engine: input.model.engine,
        })
        .where(
          and(
            eq(securityScans.id, input.scanId),
            eq(securityScans.status, 'queued'),
            eq(securityScans.attempt, input.attempt),
          ),
        )
        .returning({ attempt: securityScans.attempt });
      if (!claimed) {
        return { kind: 'gone' } as const;
      }
      return { kind: 'claimed', attempt: claimed.attempt, times } as const;
    });
  } catch (error) {
    // `security_scans_running_project`: one running scan per project.
    if (hasSqlState(error, '23505')) {
      return { kind: 'busy' };
    }
    throw error;
  }
}

async function claimRefusal(
  tx: DbOrTx,
  mode: SecurityMode,
  projectId: string,
  row: Readonly<{
    trigger: SecurityScanTrigger;
    publicRequestId: string | null;
    firstQueuedAt: string | null;
    projectStatus: string;
    suspended: string | null;
  }>,
  now: number,
): Promise<Extract<SecurityClaimOutcome, { kind: 'ended' }> | null> {
  if (row.projectStatus === 'deleting') {
    return { kind: 'ended', status: 'canceled', reason: 'project_deleted' };
  }
  if (row.suspended !== null) {
    return { kind: 'ended', status: 'canceled', reason: 'owner_suspended' };
  }
  if (
    row.firstQueuedAt !== null &&
    now - Date.parse(row.firstQueuedAt) > SECURITY_SCAN_MAX_QUEUE_WAIT_MS
  ) {
    return { kind: 'ended', status: 'skipped', reason: 'backlog' };
  }
  // A fallback of a gate scan (M26) runs for the same public request.
  const forRequest =
    row.trigger === 'gate' || (row.trigger === 'fallback' && row.publicRequestId !== null);
  if (mode === 'public' && !forRequest && (await projectIsProtected(tx, projectId))) {
    return { kind: 'ended', status: 'skipped', reason: 'protected' };
  }
  return null;
}

export type SecurityScanEnd = Readonly<{
  status: 'succeeded' | 'incomplete' | 'failed' | 'refused' | 'timed_out' | 'skipped' | 'canceled';
  reason: string | null;
  errorClass?: string | null;
  failureCause?: 'installation' | 'project' | null;
}>;

/**
 * Ends a running attempt and gives its budget reserve back, in one transaction. Fenced:
 * only the running row of exactly this attempt changes. `false` when it was not
 * (already ended, or a newer attempt runs).
 */
export async function endSecurityScanAttempt(
  db: Db,
  scanId: string,
  attempt: number,
  end: SecurityScanEnd,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await tx
      .update(securityScans)
      .set({
        status: end.status,
        status_reason: end.reason,
        error_class: end.errorClass ?? null,
        failure_cause: end.failureCause ?? null,
        finished_at: sql`now()`,
      })
      .where(
        and(
          eq(securityScans.id, scanId),
          eq(securityScans.status, 'running'),
          eq(securityScans.attempt, attempt),
        ),
      )
      .returning({ id: securityScans.id });
    if (ended.length === 0) {
      return false;
    }
    await releaseSecurityScanReserveIn(tx, scanId);
    return true;
  });
}

/** Ends a scan that never started (no model may run). Fenced like a claim. */
export async function endQueuedSecurityScan(
  db: DbOrTx,
  scanId: string,
  attempt: number,
  end: SecurityScanEnd,
): Promise<boolean> {
  const ended = await db
    .update(securityScans)
    .set({
      status: end.status,
      status_reason: end.reason,
      error_class: end.errorClass ?? null,
      failure_cause: end.failureCause ?? null,
      finished_at: sql`now()`,
    })
    .where(
      and(
        eq(securityScans.id, scanId),
        eq(securityScans.status, 'queued'),
        eq(securityScans.attempt, attempt),
      ),
    )
    .returning({ id: securityScans.id });
  return ended.length > 0;
}

/**
 * After a failed start: back to `queued` for one more attempt. In one transaction the
 * reserve is given back (from the month of `started_at`, so before that is cleared)
 * and the row moves; the next start takes a new reserve.
 */
export async function requeueSecurityScan(
  db: Db,
  scanId: string,
  attempt: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(securityScans)
      .set({ status: 'queued', lease_until: null, queued_at: sql`now()` })
      .where(
        and(
          eq(securityScans.id, scanId),
          eq(securityScans.status, 'running'),
          eq(securityScans.attempt, attempt),
        ),
      )
      .returning({ id: securityScans.id });
    if (moved.length === 0) {
      return false;
    }
    await releaseSecurityScanReserveIn(tx, scanId);
    await tx.update(securityScans).set({ started_at: null }).where(eq(securityScans.id, scanId));
    return true;
  });
}

/** After a start that worked: is the attempt still the running one? */
export async function isSecurityScanRunning(
  db: DbOrTx,
  scanId: string,
  attempt: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: securityScans.id })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.id, scanId),
        eq(securityScans.status, 'running'),
        eq(securityScans.attempt, attempt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export type SecurityCanceledScan = Readonly<{
  scanId: string;
  /** The attempt that was running, or `null` for a waiting scan. */
  runningAttempt: number | null;
}>;

/**
 * Cancels the waiting and running scans of a project (teardown, edge #26) or the
 * named scans (operator cancel) and gives back the running ones' reserves, in one
 * transaction. One `SELECT … FOR UPDATE` over every active status picks the rows: a
 * claim committing meanwhile is waited for and its row, now `running`, still matches,
 * so a scan claimed at the same moment is canceled too (with its new attempt).
 */
export async function cancelSecurityScanRows(
  db: Db,
  filter: Readonly<{ projectId: string } | { scanIds: ReadonlyArray<string> }>,
  reason: string,
): Promise<ReadonlyArray<SecurityCanceledScan>> {
  if ('scanIds' in filter && filter.scanIds.length === 0) {
    return [];
  }
  const target =
    'projectId' in filter
      ? eq(securityScans.project_id, filter.projectId)
      : inArray(securityScans.id, [...filter.scanIds]);
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({
        scanId: securityScans.id,
        status: securityScans.status,
        attempt: securityScans.attempt,
      })
      .from(securityScans)
      .where(and(target, inArray(securityScans.status, [...ACTIVE_STATUSES])))
      .orderBy(asc(securityScans.id))
      .for('update');
    if (locked.length === 0) {
      return [];
    }
    await tx
      .update(securityScans)
      .set({ status: 'canceled', status_reason: reason, finished_at: sql`now()` })
      .where(
        inArray(
          securityScans.id,
          locked.map((scan) => scan.scanId),
        ),
      );
    const canceled: Array<SecurityCanceledScan> = [];
    for (const scan of locked) {
      const running = scan.status === 'running';
      if (running) {
        await releaseSecurityScanReserveIn(tx, scan.scanId);
      }
      canceled.push({ scanId: scan.scanId, runningAttempt: running ? scan.attempt : null });
    }
    return canceled;
  });
}

/**
 * Hourly: gives back the reserve of any ended scan that still holds one. Every end
 * releases in the same transaction, so this finds only rows from before that, or a
 * write path that missed it; it keeps the platform month's cap from shrinking for good.
 */
export async function releaseStrandedSecurityScanReserves(db: Db, limit = 100): Promise<number> {
  const stranded = await db
    .select({ scanId: securityScans.id })
    .from(securityScans)
    .where(
      and(
        notInArray(securityScans.status, [...ACTIVE_STATUSES]),
        gt(securityScans.reserved_nano_usd, 0),
      ),
    )
    .limit(limit);
  let released = 0;
  for (const scan of stranded) {
    if ((await releaseSecurityScanReserve(db, scan.scanId)) > 0) {
      released++;
    }
  }
  return released;
}

/** Hourly reaper: a running scan past its lease is `timed_out` (spec §6.2). */
export async function reapExpiredSecurityScans(
  db: Db,
  now: number,
  limit = 100,
): Promise<ReadonlyArray<Readonly<{ scanId: string; attempt: number }>>> {
  const expired = await db
    .select({ scanId: securityScans.id, attempt: securityScans.attempt })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.status, 'running'),
        lt(securityScans.lease_until, new Date(now).toISOString()),
      ),
    )
    .orderBy(asc(securityScans.lease_until))
    .limit(limit);
  const reaped: Array<Readonly<{ scanId: string; attempt: number }>> = [];
  for (const scan of expired) {
    const ended = await endSecurityScanAttempt(db, scan.scanId, scan.attempt, {
      status: 'timed_out',
      reason: 'lease_expired',
      errorClass: 'lease_expired',
      failureCause: 'installation',
    });
    if (ended) {
      reaped.push(scan);
    }
  }
  return reaped;
}

/** A scan that waited 24 h from `first_queued_at` is `skipped:backlog` (spec §6.2). */
export async function skipBackloggedSecurityScans(db: DbOrTx, now: number): Promise<number> {
  const skipped = await db
    .update(securityScans)
    .set({ status: 'skipped', status_reason: 'backlog', finished_at: sql`now()` })
    .where(
      and(
        inArray(securityScans.status, [...WAITING_STATUSES]),
        lt(
          securityScans.first_queued_at,
          new Date(now - SECURITY_SCAN_MAX_QUEUE_WAIT_MS).toISOString(),
        ),
      ),
    )
    .returning({ id: securityScans.id });
  return skipped.length;
}

/**
 * Hourly re-poke: a `pending_input` row whose after-commit step was lost moves to
 * `queued`. Only rows already waiting; a deployment with no row is never picked. A
 * local check (M32) waits for its upload instead (`sweepSecurityLocalChecks`).
 */
export async function queueStalePendingSecurityScans(db: DbOrTx, now: number): Promise<number> {
  const moved = await db
    .update(securityScans)
    .set({ status: 'queued', queued_at: sql`now()` })
    .where(
      and(
        eq(securityScans.status, 'pending_input'),
        ne(securityScans.trigger, 'local'),
        lt(
          securityScans.created_at,
          new Date(now - SECURITY_SCAN_PENDING_INPUT_REPOKE_MS).toISOString(),
        ),
      ),
    )
    .returning({ id: securityScans.id });
  return moved.length;
}

export async function hasQueuedSecurityScans(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ id: securityScans.id })
    .from(securityScans)
    .where(eq(securityScans.status, 'queued'))
    .limit(1);
  return row !== undefined;
}
