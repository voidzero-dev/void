import { isSecurityModelId } from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { DurableObject } from 'cloudflare:workers';
import { getPlatformCapabilities } from '../capabilities.ts';
import { createDb } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { securityScannerNames, securityScannerTarget } from '../provisioning/security-scanner.ts';
import type { StartResult, StartScanRequest } from '../security-scanner-controller-runtime.ts';
import { errorMessage } from '../zero-trust/errors.ts';
import { reserveSecurityScanBudget, securityScanReserveNano, securitySpendCaps } from './budget.ts';
import type { SecurityReserveResult } from './budget.ts';
import {
  admitModelCall,
  backOffModelRate,
  forgetModelCalls,
  modelRateWaitMs,
  readModelCallFailure,
  recordModelCallFailure,
  SECURITY_CF_CALLS_PER_MINUTE,
} from './call-ledger.ts';
import type {
  AdmitModelCall,
  AdmitModelCallResult,
  CallLedgerStorage,
  ModelCallFailure,
} from './call-ledger.ts';
import { securityBestEffort as bestEffort, securityScheduler } from './enqueue.ts';
import { resolveSecurityScanModel } from './models.ts';
import type { SecurityScanModel } from './models.ts';
import { enqueueSecurityCapRefused, runSecurityNotifications } from './notifications.ts';
import { securityWorkPaused } from './paused.ts';
import { readSecurityPolicyLenient, securitySpendMonth } from './policy.ts';
import { recheckPublicRequestForScan } from './public-gate-flow.ts';
import {
  cancelSecurityScanRows,
  claimSecurityScan,
  endQueuedSecurityScan,
  endSecurityScanAttempt,
  isSecurityScanRunning,
  readSecurityScanQueue,
  requeueSecurityScan,
  SECURITY_SCAN_MAX_ATTEMPTS,
} from './queue.ts';
import type {
  SecurityCanceledScan,
  SecurityClaimOutcome,
  SecurityScanCandidate,
  SecurityScanEnd,
  SecurityScanQueueView,
} from './queue.ts';

/** A poke arms the alarm this far ahead, like `BuildScheduler`. */
const POKE_DELAY_MS = 50;
/** While queued work remains the alarm runs again this far ahead. */
const RESCAN_MS = 30_000;
/** While the platform is disabled or staged, the alarm looks again this often. */
const PAUSED_RECHECK_MS = 10 * 60_000;
/** A scan whose start failed waits this long before its one retry. */
const RETRY_BACKOFF_MS = 60_000;
/** Running scans per `@cf` model: the rate over the 10 calls a minute one Engine B scan makes (spec §6.2). */
const CF_RUNNING_PER_MODEL = Math.max(1, Math.floor(SECURITY_CF_CALLS_PER_MINUTE / 10));
const CONTROL_TIMEOUT_MS = 30_000;
const OWNERS_KEY = 'queue:owners';
const RETRY_PREFIX = 'queue:retry:';
/** Owners remembered for round-robin; the least recently served are dropped first. */
const MAX_OWNERS = 1000;

/** The DO storage the queue uses: the call ledger's keys plus its own and the alarm. */
export type SchedulerStorage = CallLedgerStorage &
  Pick<DurableObjectStorage, 'getAlarm' | 'setAlarm'>;

/** The scanner controller, reached through the gate script in the dispatch namespace. */
export type SecurityScanController = Readonly<{
  start(request: StartScanRequest): Promise<StartResult>;
  cancel(scanId: string, attempt: number): Promise<void>;
}>;

/** The Postgres side of one scheduler pass; tests replace it. */
type SecurityScanQueueStore = Readonly<{
  read(): Promise<SecurityScanQueueView>;
  claim(input: Parameters<typeof claimSecurityScan>[1]): Promise<SecurityClaimOutcome>;
  reserve(input: Parameters<typeof reserveSecurityScanBudget>[1]): Promise<SecurityReserveResult>;
  end(scanId: string, attempt: number, end: SecurityScanEnd): Promise<boolean>;
  endQueued(scanId: string, attempt: number, end: SecurityScanEnd): Promise<boolean>;
  requeue(scanId: string, attempt: number): Promise<boolean>;
  /** Is `attempt` still the running one (no cancel or reaper since the claim)? */
  isRunning(scanId: string, attempt: number): Promise<boolean>;
}>;

export type SecurityScanQueueDeps = Readonly<{
  now(): number;
  storage: SchedulerStorage;
  readPolicy(): Promise<SecurityPolicy>;
  store: SecurityScanQueueStore;
  controller: SecurityScanController;
  /** A scan was skipped because a cap is used up: queue its 100% email. Best effort. */
  onBudgetRefused?(
    input: Readonly<{ projectId: string; cap: 'project' | 'platform' }>,
  ): Promise<void>;
}>;

export function securityScanQueueStore(db: Db): SecurityScanQueueStore {
  return {
    read: () => readSecurityScanQueue(db),
    claim: (input) => claimSecurityScan(db, input),
    reserve: (input) => reserveSecurityScanBudget(db, input),
    end: (scanId, attempt, end) => endSecurityScanAttempt(db, scanId, attempt, end),
    endQueued: (scanId, attempt, end) => endQueuedSecurityScan(db, scanId, attempt, end),
    requeue: (scanId, attempt) => requeueSecurityScan(db, scanId, attempt),
    isRunning: (scanId, attempt) => isSecurityScanRunning(db, scanId, attempt),
  };
}

/** After a scan the scheduler itself ended, the public gate judges the project again. */
function endNotifyingStore(
  store: SecurityScanQueueStore,
  onEnded: (scanId: string) => Promise<void>,
): SecurityScanQueueStore {
  const after = async (scanId: string, ended: boolean): Promise<boolean> => {
    if (ended) {
      await bestEffort('public gate re-check', scanId, () => onEnded(scanId));
    }
    return ended;
  };
  return {
    ...store,
    end: async (scanId, attempt, end) => after(scanId, await store.end(scanId, attempt, end)),
    endQueued: async (scanId, attempt, end) =>
      after(scanId, await store.endQueued(scanId, attempt, end)),
  };
}

async function gate(env: ApiEnv['Bindings']): Promise<Fetcher> {
  const names = await securityScannerNames(securityScannerTarget(env).installationKey);
  return env.DISPATCH.get(names.gate);
}

export function securityScanControllerClient(env: ApiEnv['Bindings']): SecurityScanController {
  const post = async (path: string, body: unknown) =>
    (await gate(env)).fetch(`https://security-scanner.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
  return {
    async start(request) {
      const response = await post('/v1/scans/start', request);
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, reason: `http_${response.status}` };
      }
      const result = await response.json<StartResult>();
      return result.ok === true ? { ok: true } : { ok: false, reason: String(result.reason) };
    },
    async cancel(scanId, attempt) {
      const response = await post('/v1/scans/cancel', { scanId, attempt });
      await response.body?.cancel();
    },
  };
}

/**
 * Round-robin by owner (spec §6.2): owners served longest ago first, one scan per owner
 * per round, oldest first, so one owner cannot push the others into `skipped:backlog`.
 */
function orderSecurityScansByOwner<T extends Pick<SecurityScanCandidate, 'ownerId'>>(
  candidates: ReadonlyArray<T>,
  servedAt: Readonly<Record<string, number>>,
): Array<T> {
  const groups = new Map<string, Array<T>>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.ownerId);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.ownerId, [candidate]);
    }
  }
  // Map order is first-seen order, which is oldest scan first.
  const owners = [...groups.keys()].sort(
    (a, b) => (servedAt[a] ?? -Infinity) - (servedAt[b] ?? -Infinity),
  );
  const ordered: Array<T> = [];
  for (let round = 0; ordered.length < candidates.length; round++) {
    for (const owner of owners) {
      const next = groups.get(owner)?.[round];
      if (next) {
        ordered.push(next);
      }
    }
  }
  return ordered;
}

function isWorkersAi(model: string | null): model is string {
  return model !== null && model.startsWith('@cf/');
}

async function readRetries(storage: SchedulerStorage): Promise<Map<string, number>> {
  const retries = new Map<string, number>();
  for (const [key, at] of await storage.list<number>({ prefix: RETRY_PREFIX })) {
    retries.set(key.slice(RETRY_PREFIX.length), at);
  }
  return retries;
}

function pruneOwners(servedAt: Record<string, number>): Record<string, number> {
  const entries = Object.entries(servedAt);
  if (entries.length <= MAX_OWNERS) {
    return servedAt;
  }
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_OWNERS));
}

async function startSafely(
  controller: SecurityScanController,
  request: StartScanRequest,
): Promise<StartResult> {
  try {
    return await controller.start(request);
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

function infrastructureEnd(errorClass: string): SecurityScanEnd {
  return { status: 'failed', reason: 'infrastructure', errorClass, failureCause: 'installation' };
}

/**
 * Arms the alarm at `at` unless an earlier one is set (a `/poke` during the pass is kept).
 * An alarm at or before `passStart` is the one running now, so it is replaced.
 */
async function armSecurityScheduler(
  storage: Pick<SchedulerStorage, 'getAlarm' | 'setAlarm'>,
  at: number,
  passStart: number,
): Promise<void> {
  const current = await storage.getAlarm();
  if (current !== null && current > passStart && current <= at) {
    return;
  }
  await storage.setAlarm(at);
}

/**
 * One scheduler pass: start queued scans while the installation has slots.
 *
 *   for each candidate, round-robin by owner:
 *     retry back-off ─► wait        `@cf` model busy or backing off (429) ─► wait
 *     claim (attempt + 1, lease) ─► reserve budget (else skipped:budget)
 *     ─► controller start ─► running; a failed start retries once, then failed (infrastructure)
 *
 * One running scan per project. The first failed start ends the pass and the next waits
 * for the retry back-off, so a controller outage costs one scan its retry, not the queue.
 */
export async function runSecurityScanQueue(
  deps: SecurityScanQueueDeps,
): Promise<Readonly<{ started: ReadonlyArray<string>; nextAlarm: number | null }>> {
  const now = deps.now();
  const policy = await deps.readPolicy();
  if (policy.mode === 'disabled') {
    return { started: [], nextAlarm: null };
  }
  const view = await deps.store.read();
  const servedAt = { ...(await deps.storage.get<Record<string, number>>(OWNERS_KEY)) };
  const retries = await readRetries(deps.storage);
  const busyProjects = new Set(view.running.map((scan) => scan.projectId));
  const cfRunning = new Map<string, number>();
  for (const scan of view.running) {
    if (isWorkersAi(scan.modelUsed)) {
      cfRunning.set(scan.modelUsed, (cfRunning.get(scan.modelUsed) ?? 0) + 1);
    }
  }
  let slots = policy.limits.concurrency - view.running.length;
  let settled = 0;
  let wakeAt = Infinity;
  let startFailed = false;
  const started: Array<string> = [];

  for (const candidate of orderSecurityScansByOwner(view.candidates, servedAt)) {
    if (slots <= 0 || startFailed) {
      break;
    }
    if (busyProjects.has(candidate.projectId)) {
      continue;
    }
    const retryAt = retries.get(candidate.scanId);
    if (retryAt !== undefined && retryAt > now) {
      wakeAt = Math.min(wakeAt, retryAt);
      continue;
    }
    const model = resolveSecurityScanModel(policy, candidate);
    let outcome: SecurityClaimOutcome;
    try {
      if (!model) {
        if (
          await deps.store.endQueued(
            candidate.scanId,
            candidate.attempt,
            infrastructureEnd('no_model'),
          )
        ) {
          settled++;
        }
        continue;
      }
      if (isWorkersAi(model.used)) {
        if ((cfRunning.get(model.used) ?? 0) >= CF_RUNNING_PER_MODEL) {
          continue;
        }
        const wait = await modelRateWaitMs(deps.storage, model.used, now);
        if (wait > 0) {
          // Workers AI answered 429 lately: no new scan on this model until it recovers.
          wakeAt = Math.min(wakeAt, now + wait);
          continue;
        }
      }
      outcome = await deps.store.claim({
        scanId: candidate.scanId,
        attempt: candidate.attempt,
        model,
        limits: policy.limits,
        now,
      });
    } catch (error) {
      // Nothing claimed: the row stays queued for the next pass.
      console.error('[security-scan] scheduler candidate failed', {
        scanId: candidate.scanId,
        error: errorMessage(error),
      });
      continue;
    }
    if (outcome.kind === 'ended') {
      settled++;
      continue;
    }
    if (outcome.kind !== 'claimed') {
      continue;
    }
    const result = await startClaimed(deps, policy, candidate, model, outcome, now);
    if (result === 'started') {
      slots--;
      busyProjects.add(candidate.projectId);
      if (isWorkersAi(model.used)) {
        cfRunning.set(model.used, (cfRunning.get(model.used) ?? 0) + 1);
      }
      servedAt[candidate.ownerId] = now;
      started.push(candidate.scanId);
      settled++;
    } else if (result === 'retry' || result === 'start_failed') {
      startFailed = true;
      if (result === 'start_failed') {
        settled++;
      }
    } else if (result !== 'gone') {
      settled++;
    }
  }

  await deps.storage.put(OWNERS_KEY, pruneOwners(servedAt));
  for (const [scanId, at] of retries) {
    if (at <= now && !view.candidates.some((candidate) => candidate.scanId === scanId)) {
      await deps.storage.delete(`${RETRY_PREFIX}${scanId}`);
    }
  }
  const remaining = view.queued - settled;
  let nextAlarm: number | null = remaining > 0 ? now + RESCAN_MS : null;
  if (Number.isFinite(wakeAt)) {
    nextAlarm = nextAlarm === null ? wakeAt : Math.min(nextAlarm, wakeAt);
  }
  if (startFailed) {
    // The controller just failed: nothing starts before the retry is due.
    nextAlarm = now + RETRY_BACKOFF_MS;
  }
  if (nextAlarm !== null) {
    await armSecurityScheduler(deps.storage, nextAlarm, now);
  }
  return { started, nextAlarm };
}

type StartOutcome =
  | 'started'
  /** Start failed; back in `queued` for its one retry. */
  | 'retry'
  /** Start failed on the last attempt: `failed (infrastructure, start_failed)`. */
  | 'start_failed'
  /** Ended without a start (`skipped:budget`, or an error after the claim). */
  | 'ended'
  /** Canceled or reaped since the claim: someone else ended it. */
  | 'gone';

/**
 * Reserve, then start. Any error after the claim ends the attempt, so a claimed row is
 * never left `running` with no container until its lease runs out.
 */
async function startClaimed(
  deps: SecurityScanQueueDeps,
  policy: SecurityPolicy,
  candidate: SecurityScanCandidate,
  model: SecurityScanModel,
  claim: Extract<SecurityClaimOutcome, { kind: 'claimed' }>,
  now: number,
): Promise<StartOutcome> {
  const { scanId } = candidate;
  const attempt = claim.attempt;
  let startedOk = false;
  try {
    await deps.storage.delete(`${RETRY_PREFIX}${scanId}`);
    // The model is priced (the resolver only picks priced models), so this is set.
    const reserveNano = securityScanReserveNano(model.used, policy.limits) ?? 0;
    const reserve = await deps.store.reserve({
      scanId,
      attempt,
      projectId: candidate.projectId,
      reserveNano,
      caps: securitySpendCaps(candidate, policy.budgets),
      now,
    });
    if (!reserve.ok) {
      if ('gone' in reserve) {
        // A cancel landed after the claim: nothing reserved, nothing to start.
        return 'gone';
      }
      // A cap with money left still refuses a scan whose worst case does not fit in it
      // (`*_reserve`): that cap is not used up, so no 100% email (spec §16.3).
      const usedUp = reserve.spentNano >= reserve.capNano;
      await deps.store.end(scanId, attempt, {
        status: 'skipped',
        reason: 'budget',
        errorClass: `${reserve.cap}_${usedUp ? 'cap' : 'reserve'}`,
      });
      if (usedUp) {
        await bestEffort('cap alert', scanId, async () =>
          deps.onBudgetRefused?.({ projectId: candidate.projectId, cap: reserve.cap }),
        );
      }
      return 'ended';
    }
    const result = await startSafely(deps.controller, {
      scanId,
      attempt,
      engine: model.engine,
      wallClockMs: claim.times.wallClockMs,
      hardCapMs: claim.times.hardCapMs,
    });
    if (result.ok) {
      startedOk = true;
      if (!(await deps.store.isRunning(scanId, attempt))) {
        // Canceled or reaped while the start was in flight: stop the new container.
        await stopAttempt(deps, scanId, attempt);
        return 'gone';
      }
      return 'started';
    }
    console.warn('[security-scan] controller start failed', {
      scanId,
      attempt,
      reason: result.reason,
    });
    // The start may have landed anyway: this attempt is fenced off from here on.
    await stopAttempt(deps, scanId, attempt);
    if (attempt < SECURITY_SCAN_MAX_ATTEMPTS && (await deps.store.requeue(scanId, attempt))) {
      await deps.storage.put(`${RETRY_PREFIX}${scanId}`, now + RETRY_BACKOFF_MS);
      return 'retry';
    }
    await deps.store.end(scanId, attempt, infrastructureEnd('start_failed'));
    return 'start_failed';
  } catch (error) {
    console.error('[security-scan] scheduler start failed', {
      scanId,
      attempt,
      error: errorMessage(error),
    });
    if (startedOk) {
      // The container runs; its result or the reaper ends the attempt.
      return 'started';
    }
    await stopAttempt(deps, scanId, attempt);
    // Best effort: if this write fails too, the reaper ends the row at its lease.
    await deps.store
      .end(scanId, attempt, infrastructureEnd('scheduler_error'))
      .catch((endError: unknown) =>
        console.error('[security-scan] could not end the attempt', {
          scanId,
          attempt,
          error: errorMessage(endError),
        }),
      );
    return 'ended';
  }
}

/** Best effort: controller cancel and ledger forget for one attempt. */
async function stopAttempt(
  deps: SecurityScanQueueDeps,
  scanId: string,
  attempt: number,
): Promise<void> {
  await bestEffort('controller cancel', scanId, () => deps.controller.cancel(scanId, attempt));
  await bestEffort('ledger forget', scanId, () => forgetModelCalls(deps.storage, scanId, attempt));
}

type SecurityScanCancelDeps = Readonly<{
  db: Db;
  controller: SecurityScanController;
  forget(scanId: string, attempt: number): Promise<number>;
}>;

/**
 * Cancels scans: the rows first, so later calls of a running attempt are fenced off,
 * then best effort the controller stop and ledger forget (the hard cap backs them up).
 */
async function cancelSecurityScans(
  deps: SecurityScanCancelDeps,
  filter: Parameters<typeof cancelSecurityScanRows>[1],
  reason: string,
): Promise<ReadonlyArray<SecurityCanceledScan>> {
  const canceled = await cancelSecurityScanRows(deps.db, filter, reason);
  for (const scan of canceled) {
    if (scan.runningAttempt === null) {
      continue;
    }
    const attempt = scan.runningAttempt;
    await bestEffort('controller cancel', scan.scanId, () =>
      deps.controller.cancel(scan.scanId, attempt),
    );
    await bestEffort('ledger forget', scan.scanId, () => deps.forget(scan.scanId, attempt));
  }
  return canceled;
}

/** `teardownProject`: cancel the project's scans before the rows cascade (edge #26). */
export async function cancelProjectSecurityScans(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<SecurityCanceledScan>> {
  return cancelSecurityScans(
    {
      db,
      controller: securityScanControllerClient(env),
      forget: (scanId, attempt) => securityScheduler(env).forgetModelCalls(scanId, attempt),
    },
    { projectId },
    'project_deleted',
  );
}

/**
 * Singleton DO that runs the scan queue and keeps the model proxy's per-attempt call
 * state (`call-ledger.ts`). It ships on every install, so the capability can be turned
 * on or off with no DO migration; with it off the alarm does nothing.
 */
export class SecurityScanScheduler extends DurableObject<ApiEnv['Bindings']> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/poke') {
      await this.ctx.storage.setAlarm(Date.now() + POKE_DELAY_MS);
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!getPlatformCapabilities(this.env).securityAudits) {
      return;
    }
    const passStart = Date.now();
    // A disabled or staged platform starts no scan. Queued work waits until it is enabled.
    if (await securityWorkPaused(this.env)) {
      await armSecurityScheduler(this.ctx.storage, passStart + PAUSED_RECHECK_MS, passStart);
      return;
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      await runSecurityScanQueue({
        now: () => passStart,
        storage: this.ctx.storage,
        readPolicy: () => readSecurityPolicyLenient(db),
        store: endNotifyingStore(securityScanQueueStore(db), (scanId) =>
          recheckPublicRequestForScan(this.env, db, scanId),
        ),
        controller: securityScanControllerClient(this.env),
        onBudgetRefused: async ({ projectId, cap }) => {
          await enqueueSecurityCapRefused(db, {
            projectId,
            month: securitySpendMonth(passStart),
            cap,
          });
        },
      });
    } catch (error) {
      console.error('[security-scan] scheduler pass failed', error);
      await armSecurityScheduler(this.ctx.storage, Date.now() + RESCAN_MS, passStart);
    }
    await this.sendNotifications(db, passStart);
  }

  /** Drains the security email outbox (`notifications.ts`) and arms the alarm for what is left. */
  private async sendNotifications(db: Db, passStart: number): Promise<void> {
    try {
      const run = await runSecurityNotifications(db, this.env);
      if (run.nextAt !== null) {
        await armSecurityScheduler(
          this.ctx.storage,
          Math.max(run.nextAt, Date.now() + POKE_DELAY_MS),
          passStart,
        );
      }
    } catch (error) {
      console.error('[security-notify] outbox pass failed', error);
      await armSecurityScheduler(this.ctx.storage, Date.now() + RESCAN_MS, passStart);
    }
  }

  /** Operator cancel: stop the named scans now. */
  async cancelScans(scanIds: ReadonlyArray<string>, reason: string): Promise<number> {
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const canceled = await cancelSecurityScans(
      {
        db,
        controller: securityScanControllerClient(this.env),
        forget: (scanId, attempt) => forgetModelCalls(this.ctx.storage, scanId, attempt),
      },
      { scanIds },
      reason,
    );
    return canceled.length;
  }

  /** Model proxy: count the call for its session and take a `@cf` rate token. */
  async admitModelCall(input: AdmitModelCall): Promise<AdmitModelCallResult> {
    return admitModelCall(this.ctx.storage, input);
  }

  /** Model proxy: Workers AI answered 429 for `model`. */
  async backOffModelRate(model: string, now: number): Promise<number> {
    if (!isWorkersAi(model) || !isSecurityModelId(model)) {
      return 0;
    }
    return backOffModelRate(this.ctx.storage, model, now);
  }

  async recordModelCallFailure(
    scanId: string,
    attempt: number,
    failure: ModelCallFailure,
  ): Promise<void> {
    await recordModelCallFailure(this.ctx.storage, scanId, attempt, failure);
  }

  async modelCallFailure(scanId: string, attempt: number): Promise<ModelCallFailure | null> {
    return readModelCallFailure(this.ctx.storage, scanId, attempt);
  }

  /** Called when an attempt ends (result ingest, reaper, cancel), so nothing is kept for it. */
  async forgetModelCalls(scanId: string, attempt: number): Promise<number> {
    return forgetModelCalls(this.ctx.storage, scanId, attempt);
  }
}
