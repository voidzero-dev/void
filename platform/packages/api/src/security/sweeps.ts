/**
 * Batch scans of live deployments (design doc 0095, M25):
 *
 *   operator backfill ──► previewSecurityBackfill (cost)  ──► queueSecurityBackfill
 *                         live deployments never scanned        trigger=backfill, base rule
 *   hourly job ─────────► queueSecuritySweeps (policy.sweeps.on)
 *                         no full scan in everyDays             trigger=sweep, full, `standard`
 *
 * Every scan is queued through `queueSecurityRescan`, so it passes the same checks as
 * a rescan (scope, owner, live deployment, nothing waiting, stored code) under the
 * project lock. Monthly caps apply when each scan starts, as for any scan.
 */
import type { SecurityPolicy } from '@void/platform/security-policy';
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { NANO_USD_PER_USD, securityScanReserveNano } from './budget.ts';
import { queueSecurityRescan } from './operator.ts';
import type { SecurityManualTrigger } from './operator.ts';
import { installationZeroTrustProtects, readSecurityPolicyLenient } from './policy.ts';
import { securityProjectModelView } from './project-view.ts';
import { countSecurityScanCandidates, listSecurityScanCandidates } from './scan-candidates.ts';
import type { SecurityCandidate, SecurityCandidateQuery } from './scan-candidates.ts';
import { securityScans } from './schema.ts';

/** Projects one backfill call queues, at most; run it again for the rest. */
export const SECURITY_BACKFILL_MAX = 50;
/** Sweeps one hourly run queues, at most. */
export const SECURITY_SWEEP_BATCH_MAX = 10;
/** Project slugs a backfill preview names. */
const PREVIEW_SLUGS = 20;
/**
 * Extra candidates read past the batch size, so a project refused at queue time (its
 * R2 snapshot is gone, it changed meanwhile) does not take a slot from the next one.
 */
const REFUSAL_SLACK = 10;

type Env = Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>;

/** The most each candidate's next scan can cost, summed; `null` when a model has no price. */
function worstCaseUsd(policy: SecurityPolicy, candidates: ReadonlyArray<SecurityCandidate>) {
  let total = 0;
  for (const candidate of candidates) {
    const model = securityProjectModelView(policy, {
      model: candidate.model,
      noticeVersion: candidate.noticeVersion,
    });
    const reserve = model.id === null ? 0 : securityScanReserveNano(model.id, policy.limits);
    if (reserve === null) {
      return null;
    }
    total += reserve;
  }
  return total / NANO_USD_PER_USD;
}

async function backfillQuery(db: Db, policy: SecurityPolicy, now: number) {
  if (policy.mode === 'disabled') {
    throw new OperatorError(
      409,
      'Security audits are off, so there is nothing to backfill. Set a scan mode first: void platform security policy public',
      'security_not_in_scope',
    );
  }
  return {
    kind: 'backfill',
    mode: policy.mode,
    protects: await installationZeroTrustProtects(db),
    now,
  } satisfies SecurityCandidateQuery;
}

/**
 * What a backfill would queue: one scan of each in-scope project whose live deployment
 * has no succeeded scan and whose code is stored, at most `SECURITY_BACKFILL_MAX` per
 * call. Reads only.
 */
export async function previewSecurityBackfill(db: Db, now = Date.now()) {
  const policy = await readSecurityPolicyLenient(db);
  const query = await backfillQuery(db, policy, now);
  const [total, candidates, noStoredCode] = await Promise.all([
    countSecurityScanCandidates(db, query),
    listSecurityScanCandidates(db, query, SECURITY_BACKFILL_MAX),
    countSecurityScanCandidates(db, query, 'missing'),
  ]);
  return {
    projects: total,
    willQueue: candidates.length,
    remaining: Math.max(0, total - candidates.length),
    /** Never-scanned live deployments whose code is no longer stored: deploy them again. */
    noStoredCode,
    slugs: candidates.slice(0, PREVIEW_SLUGS).map((candidate) => candidate.slug),
    worstCaseUsd: worstCaseUsd(policy, candidates),
    budgetsOn: policy.budgets.platformCapOn || policy.budgets.projectCapsOn,
  };
}

export type SecurityBatchResult = Readonly<{
  queued: Array<Readonly<{ project: string; scanId: string }>>;
  /** Candidates a per-project check refused, by error code. */
  skipped: Record<string, number>;
}>;

/** Queues candidates in order until `want` are queued; a refusal does not use a slot. */
async function queueEach(
  env: Env,
  db: Db,
  candidates: ReadonlyArray<SecurityCandidate>,
  trigger: SecurityManualTrigger,
  want: number,
): Promise<SecurityBatchResult> {
  const queued: Array<{ project: string; scanId: string }> = [];
  const skipped: Record<string, number> = {};
  for (const candidate of candidates) {
    if (queued.length >= want) {
      break;
    }
    try {
      const { scanId } = await queueSecurityRescan(env, db, candidate.projectId, { trigger });
      queued.push({ project: candidate.slug, scanId });
    } catch (error) {
      if (!(error instanceof OperatorError)) {
        throw error;
      }
      skipped[error.code] = (skipped[error.code] ?? 0) + 1;
    }
  }
  return { queued, skipped };
}

/** Queues the backfill the preview showed (re-read now: a project may have changed). */
export async function queueSecurityBackfill(env: Env, db: Db, now = Date.now()) {
  const policy = await readSecurityPolicyLenient(db);
  const query = await backfillQuery(db, policy, now);
  const candidates = await listSecurityScanCandidates(
    db,
    query,
    SECURITY_BACKFILL_MAX + REFUSAL_SLACK,
  );
  const result = await queueEach(env, db, candidates, 'backfill', SECURITY_BACKFILL_MAX);
  const [remaining, noStoredCode] = await Promise.all([
    countSecurityScanCandidates(db, query),
    countSecurityScanCandidates(db, query, 'missing'),
  ]);
  return { ...result, remaining, noStoredCode };
}

/**
 * Hourly: queue sweeps that are due, a few at a time so deploy scans keep moving. The
 * batch is what the queue can start soon (two per concurrent slot) minus what already
 * waits, at most `SECURITY_SWEEP_BATCH_MAX`. Returns how many it queued.
 */
export async function queueSecuritySweeps(
  env: Env,
  db: Db,
  policy: SecurityPolicy,
  now: number,
): Promise<number> {
  if (policy.mode === 'disabled' || !policy.sweeps.on) {
    return 0;
  }
  const [waiting] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(securityScans)
    .where(inArray(securityScans.status, ['pending_input', 'queued']));
  const room = Math.min(
    SECURITY_SWEEP_BATCH_MAX,
    policy.limits.concurrency * 2 - (waiting?.total ?? 0),
  );
  if (room <= 0) {
    return 0;
  }
  const candidates = await listSecurityScanCandidates(
    db,
    {
      kind: 'sweep',
      mode: policy.mode,
      protects: await installationZeroTrustProtects(db),
      everyDays: policy.sweeps.everyDays,
      now,
    },
    room + REFUSAL_SLACK,
  );
  const result = await queueEach(env, db, candidates, 'sweep', room);
  return result.queued.length;
}
