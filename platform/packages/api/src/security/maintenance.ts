/**
 * Hourly security audit jobs (spec §6.1, §6.2, §14, §15.3), with the `securityAudits`
 * capability on. Each job is isolated: a failure is logged and the others still run.
 *
 *   always                                  policy not Off
 *   ─ reaper, stranded reserves             ─ re-poke stale pending_input, 24 h backlog skip
 *   ─ runtime copies (M30), gateway cost    ─ exposure catch-up, scheduled sweeps, fallback
 *   ─ notification poke                     ─ streak emails, weekly digest, daily probe
 *   ─ raw output sweep (30 d), local checks (M32), scan + request retention
 */
import { SECURITY_ENTITLEMENT_MAX_AGE_MS } from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, asc, lt, sql } from 'drizzle-orm';
import { paginatedR2Delete } from '../assets.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { deriveSecurityScanTag } from '../proxy-token.ts';
import { queueSecurityDigest, queueSecurityStreakNotifications } from './alerts.ts';
import { pokeSecurityScanScheduler, securityScheduler } from './enqueue.ts';
import { queueExposureCatchUpScans } from './exposure.ts';
import { queueSecurityFallbackScans } from './fallback.ts';
import { fillSecurityGatewayCosts, queryAiGatewayTagCost } from './gateway-cost.ts';
import { sweepSecurityLocalChecks } from './local-check.ts';
import { hasPendingSecurityNotifications } from './notifications.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import { probeAndRecord } from './probe.ts';
import {
  hasQueuedSecurityScans,
  queueStalePendingSecurityScans,
  reapExpiredSecurityScans,
  releaseStrandedSecurityScanReserves,
  skipBackloggedSecurityScans,
} from './queue.ts';
import { reapSecurityRuntimeCopies } from './runtime-copy.ts';
import { securityScanControllerClient } from './scheduler.ts';
import type { SecurityScanController } from './scheduler.ts';
import { securityScans } from './schema.ts';
import { queueSecuritySweeps } from './sweeps.ts';

const DAY_MS = 24 * 60 * 60_000;
/** Raw scan output is kept 30 days (D28), swept 50 scans a run from a ROUTING cursor. */
const RAW_OUTPUT_RETENTION_MS = 30 * DAY_MS;
const RAW_SWEEP_LIMIT = 50;
const RAW_SWEEP_CURSOR_KEY = 'security-audits:raw-output-sweep';
/** Spec §14: newest 200 scan rows per project or 180 days; 50 closed requests. */
const SCAN_ROWS_KEPT = 200;
const SCAN_ROW_MAX_AGE_MS = 180 * DAY_MS;
const CLOSED_REQUESTS_KEPT = 50;
const RETENTION_DELETE_LIMIT = 500;

/** R2 prefix of one scan's raw output. */
export function securityRawOutputPrefix(projectId: string, scanId: string): string {
  return `security-scans/${projectId}/scans/${scanId}/`;
}

/** Daily probe (spec §5.2): the policy is on and the stored result is 24 h old or missing. */
function securityProbeDue(policy: SecurityPolicy, now: number): boolean {
  if (policy.mode === 'disabled') {
    return false;
  }
  const checkedAt = policy.entitlement ? Date.parse(policy.entitlement.checkedAt) : Number.NaN;
  return !Number.isFinite(checkedAt) || now - checkedAt >= SECURITY_ENTITLEMENT_MAX_AGE_MS;
}

export type SecurityMaintenanceDeps = Readonly<{
  controller: SecurityScanController;
  forget(scanId: string, attempt: number): Promise<number>;
  poke(): Promise<void>;
  probe(): Promise<void>;
  reapCopies(): Promise<number>;
  gatewayCosts(now: number): Promise<number>;
}>;

type SecurityMaintenanceReport = Readonly<{
  reaped: number;
  reservesReleased: number;
  copiesReaped: number;
  gatewayCosts: number;
  repoked: number;
  backlogged: number;
  sweepsQueued: number;
  fallbacksQueued: number;
  alertsQueued: number;
  rawSwept: number;
  localTreesDeleted: number;
  scanRowsDeleted: number;
  requestsDeleted: number;
  probed: boolean;
}>;

function realDeps(env: ApiEnv['Bindings'], db: Db): SecurityMaintenanceDeps {
  return {
    controller: securityScanControllerClient(env),
    forget: (scanId, attempt) => securityScheduler(env).forgetModelCalls(scanId, attempt),
    poke: () => pokeSecurityScanScheduler(env),
    probe: async () => {
      await probeAndRecord(env, db);
    },
    reapCopies: () => reapSecurityRuntimeCopies(env, db),
    gatewayCosts: async (now) => {
      if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
        return 0;
      }
      const gateway = {
        accountId: env.CF_ACCOUNT_ID,
        apiToken: env.CF_API_TOKEN,
        gatewayId: env.AI_GATEWAY_ID ?? 'void',
      };
      return fillSecurityGatewayCosts(
        db,
        {
          query: (tag, since, until) => queryAiGatewayTagCost(gateway, tag, since, until),
          scanTag: (scanId) => deriveSecurityScanTag(env.JWT_SECRET, scanId),
        },
        now,
      );
    },
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
  // After the reaper, so a copy of a scan it just ended goes in the same run.
  const copiesReaped = await step('runtime copies', 0, () => deps.reapCopies());
  // Ended scans keep their cost row while the policy is Off too (Scans screen, spec §16).
  const gatewayCosts = await step('gateway cost', 0, () => deps.gatewayCosts(now));
  // Email rows wait for the alarm whatever the policy says: a lost poke is retried here.
  const notificationPoke = () =>
    step('notification poke', undefined, async () => {
      if (await hasPendingSecurityNotifications(db)) {
        await deps.poke();
      }
    });
  await notificationPoke();
  let repoked = 0;
  let backlogged = 0;
  let sweepsQueued = 0;
  let fallbacksQueued = 0;
  let alertsQueued = 0;
  let probed = false;
  if (policy.mode !== 'disabled') {
    repoked = await step('re-poke', 0, () => queueStalePendingSecurityScans(db, now));
    backlogged = await step('backlog', 0, () => skipBackloggedSecurityScans(db, now));
    if (policy.mode === 'public') {
      await step('exposure catch-up', 0, () => queueExposureCatchUpScans(env, db));
    }
    sweepsQueued = await step('scheduled sweeps', 0, () =>
      queueSecuritySweeps(env, db, policy, now),
    );
    fallbacksQueued = await step('fallback backstop', 0, async () => {
      return (await queueSecurityFallbackScans(env, db, policy, { now })).length;
    });
    alertsQueued = await step('streak emails', 0, () => queueSecurityStreakNotifications(db, now));
    alertsQueued += await step('weekly digest', 0, () => queueSecurityDigest(db, policy, now));
    await step('poke', undefined, async () => {
      if (await hasQueuedSecurityScans(db)) {
        await deps.poke();
      }
    });
    if (alertsQueued > 0) {
      await notificationPoke();
    }
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
  const localTreesDeleted = await step('local checks', 0, () =>
    sweepSecurityLocalChecks(db, env.STATIC_ASSETS_R2, now),
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
    copiesReaped,
    gatewayCosts,
    repoked,
    backlogged,
    sweepsQueued,
    fallbacksQueued,
    alertsQueued,
    rawSwept,
    localTreesDeleted,
    scanRowsDeleted,
    requestsDeleted,
    probed,
  };
}

type SweepCursor = Readonly<{ finishedAt: string; id: string }>;

async function readSweepCursor(routing: KVNamespace): Promise<SweepCursor | null> {
  try {
    const value = JSON.parse(
      (await routing.get(RAW_SWEEP_CURSOR_KEY)) ?? 'null',
    ) as Partial<SweepCursor> | null;
    return typeof value?.finishedAt === 'string' && typeof value.id === 'string'
      ? { finishedAt: value.finishedAt, id: value.id }
      : null;
  } catch {
    return null;
  }
}

async function sweepSecurityRawOutputs(
  db: Db,
  r2: R2Bucket,
  routing: KVNamespace,
  now: number,
): Promise<number> {
  const cursor = await readSweepCursor(routing);
  const due = lt(securityScans.finished_at, new Date(now - RAW_OUTPUT_RETENTION_MS).toISOString());
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
    .limit(RAW_SWEEP_LIMIT);
  for (const row of rows) {
    await paginatedR2Delete(r2, securityRawOutputPrefix(row.projectId, row.id));
  }
  const last = rows.at(-1);
  if (last?.finishedAt) {
    await routing.put(
      RAW_SWEEP_CURSOR_KEY,
      JSON.stringify({ finishedAt: last.finishedAt, id: last.id }),
    );
  }
  return rows.length;
}

/**
 * Scan rows past retention, never a live scan, a project's base or an open request's gate
 * scan; only rows the raw sweep has passed, so none leaves raw output behind.
 */
async function deleteOldSecurityScanRows(
  db: Db,
  routing: KVNamespace,
  now: number,
): Promise<number> {
  const cursor = await readSweepCursor(routing);
  if (!cursor) {
    return 0;
  }
  const maxAge = new Date(now - SCAN_ROW_MAX_AGE_MS).toISOString();
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM security_scans WHERE id IN (
      SELECT ranked.id FROM (
        SELECT id, finished_at, status,
          -- Local checks (M32) are ranked apart: they never push deployment scans out.
          row_number() OVER (
            PARTITION BY project_id, (trigger = 'local') ORDER BY created_at DESC, id DESC
          ) AS rank
        FROM security_scans
      ) ranked
      WHERE ranked.status NOT IN ('pending_input', 'queued', 'running')
        AND ranked.finished_at IS NOT NULL
        AND (ranked.finished_at, ranked.id) <= (${cursor.finishedAt}::timestamptz, ${cursor.id})
        AND (ranked.rank > ${SCAN_ROWS_KEPT} OR ranked.finished_at < ${maxAge}::timestamptz)
        AND ranked.id NOT IN (
          SELECT DISTINCT ON (project_id) id FROM security_scans
          WHERE status = 'succeeded' AND deployment_id IS NOT NULL
          ORDER BY project_id, finished_at DESC NULLS LAST, id DESC
        )
        AND NOT EXISTS (
          SELECT 1 FROM security_public_requests r
          WHERE r.gate_scan_id = ranked.id
            AND r.state IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy')
        )
      LIMIT ${RETENTION_DELETE_LIMIT}
    )
    RETURNING id
  `);
  return deleted.rows.length;
}

/** Closed public requests: the newest 50 per project, never one a bypass row names. */
async function deleteOldSecurityPublicRequests(db: Db): Promise<number> {
  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM security_public_requests WHERE id IN (
      SELECT ranked.id FROM (
        SELECT id,
          row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rank
        FROM security_public_requests
        WHERE state IN ('passed', 'bypassed', 'canceled')
      ) ranked
      WHERE ranked.rank > ${CLOSED_REQUESTS_KEPT}
        AND NOT EXISTS (SELECT 1 FROM security_scan_bypasses b WHERE b.request_id = ranked.id)
      LIMIT ${RETENTION_DELETE_LIMIT}
    )
    RETURNING id
  `);
  return deleted.rows.length;
}
