import { DurableObject } from 'cloudflare:workers';
import {
  createDb,
  getUser,
  getProjectOwnershipPeriodsByProjectIds,
  getProjectsByIds,
  suspendUser,
  unsuspendUserIfReason,
} from './db.ts';
import type { Db } from './db.ts';
import type { ApiEnv } from './env.ts';
import { resolvePlanLimits } from './plans.ts';
import { queryProjectAiUsage } from './routes/usage.ts';
import {
  sandboxBlockKey,
  setProjectAiBlock,
  setProjectsRoutingSuspension,
  verifyActiveProjectOwner,
} from './routing.ts';
import { REASON_REQUESTS_EXCEEDED, REASON_SANDBOX_RUNTIME_EXCEEDED } from './suspension.ts';
import { getCurrentBillingPeriodStart, getPlanLimits, isWithinLimit } from './tiers.ts';
import type { PlanLimits } from './tiers.ts';
import { SANDBOX_USAGE_RETENTION_MS } from './usage-auth.ts';

// --- Exported types ---

export type CounterState = {
  /** Account represented by this counter, learned from trusted API requests. */
  ownerUserId: string | null;
  totalRequests: number;
  totalNeurons: number;
  totalSandboxSeconds: number;
  plan: string;
  billingPeriodStart: string; // ISO date
  billingPeriodInitialized?: boolean;
  requestsSuspended: boolean;
  aiSuspended: boolean;
  sandboxRuntimeSuspended: boolean;
  projectSlugs: Record<string, string>; // projectId → slug
  /** Start of the current ownership period for each actively owned project. */
  projectOwnershipStarts: Record<string, string>;
  /** Latest per-project AI readings for actively owned projects. */
  projectNeurons: Record<string, number>;
  /** AI usage retained from projects transferred away during this billing period. */
  historicalNeurons: number;
  /** Closed ownership windows that remain re-queryable while Analytics ingestion settles. */
  historicalAiWindows: Record<
    string,
    {
      projectId: string;
      ownershipStartedAt: string;
      ownershipEndedAt: string;
      neurons: number;
    }
  >;
};

/** Cadence of the AI usage reconciliation alarm. */
const AI_ALARM_INTERVAL_MS = 15 * 60 * 1000;

const SANDBOX_WATERMARK_PREFIX = 'sandbox-usage:watermark:';
const SANDBOX_PRUNE_CURSOR_KEY = 'sandbox-usage:prune-cursor';
const SANDBOX_PRUNE_BATCH_SIZE = 64;

async function sandboxWatermarkKey(leaseId: string, from: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([leaseId, from])),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${SANDBOX_WATERMARK_PREFIX}${hash}`;
}

export type UsageEvent = Readonly<{
  projectId: string;
  userId: string;
  slug: string;
  requests: number;
  responseBytes: number;
  status?: number;
  failureKind?:
    | 'platform-static-asset-timeout'
    | 'platform-static-asset-error'
    | 'platform-static-asset-missing';
  sandboxRuntimeSeconds?: number;
  sandboxInstanceId?: string;
  /** Cumulative server-owned lease generation; from stays fixed across heartbeats. */
  sandboxMeteredFrom?: number;
  sandboxMeteredThrough?: number;
  /** Set by the API consumer after resolving the event's ownership period. */
  currentOwner?: boolean;
  /** Current ownership-period boundary, when `currentOwner` is true. */
  ownershipStartedAt?: string;
}>;

// --- Pure functions (exported for unit testing) ---

/** Returns true if adding incomingRequests would exceed the plan's requestsPerMonth limit. */
export function evaluateRequestLimit(
  state: CounterState,
  incomingRequests: number,
  limits: PlanLimits = getPlanLimits(state.plan),
): boolean {
  return !isWithinLimit(limits.requestsPerMonth, state.totalRequests + incomingRequests);
}

/** Returns true if totalNeurons exceeds the plan's aiNeuronsPerMonth limit. Works for ALL plans. */
export function evaluateAiLimit(
  state: CounterState,
  limits: PlanLimits = getPlanLimits(state.plan),
): boolean {
  return !isWithinLimit(limits.aiNeuronsPerMonth, state.totalNeurons);
}

/** Returns true if adding incomingSeconds would exceed the plan's sandboxRuntimeSecondsPerMonth limit. */
export function evaluateSandboxRuntimeLimit(
  state: CounterState,
  incomingSeconds: number,
  limits: PlanLimits = getPlanLimits(state.plan),
): boolean {
  return !isWithinLimit(
    limits.sandboxRuntimeSecondsPerMonth,
    state.totalSandboxSeconds + incomingSeconds,
  );
}

// --- Default state ---

function defaultState(): CounterState {
  return {
    ownerUserId: null,
    totalRequests: 0,
    totalNeurons: 0,
    totalSandboxSeconds: 0,
    plan: 'free',
    billingPeriodStart: new Date().toISOString(),
    billingPeriodInitialized: false,
    requestsSuspended: false,
    aiSuspended: false,
    sandboxRuntimeSuspended: false,
    projectSlugs: {},
    projectOwnershipStarts: {},
    projectNeurons: {},
    historicalNeurons: 0,
    historicalAiWindows: {},
  };
}

async function settleWrites(writes: Array<Promise<unknown>>): Promise<void> {
  // A rejected write must not release the operation queue while a sibling
  // write can still land and undo the next operation's suspension decision.
  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

// --- UsageCounter Durable Object ---

export class UsageCounter extends DurableObject<ApiEnv['Bindings']> {
  private state: CounterState | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // External suspension writes and AI queries open the DO input gate. Keep
    // each request/alarm in order through its durable save, including retries.
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async getState(): Promise<CounterState> {
    if (!this.state) {
      const stored = await this.ctx.storage.get<CounterState>('state');
      // Backfill defaults so DOs with pre-sandbox state load cleanly.
      this.state = stored
        ? {
            ...defaultState(),
            ...stored,
            billingPeriodInitialized: stored.billingPeriodInitialized ?? true,
          }
        : defaultState();
    }
    // Every operation edits its own copy. Neither a failed external write nor
    // a failed storage put may silently commit totals/latches to the cache.
    return {
      ...this.state,
      projectSlugs: { ...this.state.projectSlugs },
      projectOwnershipStarts: { ...this.state.projectOwnershipStarts },
      projectNeurons: { ...this.state.projectNeurons },
      historicalAiWindows: structuredClone(this.state.historicalAiWindows),
    };
  }

  private async saveState(
    state: CounterState,
    options: {
      watermarks?: ReadonlyMap<string, number>;
      scheduleAiAlarm?: boolean;
    } = {},
  ): Promise<boolean> {
    const cutoff = Date.now() - SANDBOX_USAGE_RETENTION_MS;
    const hasWatermarks = await this.ctx.storage.transaction(async (transaction) => {
      // Receipts live in separate bounded-size records. Never evict a fresh
      // generation to make room: its next cumulative frame would rebill it.
      for (const [key, through] of options.watermarks ?? []) {
        await transaction.put(key, through);
      }

      // Advance a durable cursor through at most one page per operation.
      // Hash ordering is unrelated to age, so wrap after the last page and
      // eventually revisit every receipt without ever scanning the full set.
      const cursor = await transaction.get<string>(SANDBOX_PRUNE_CURSOR_KEY);
      const page = await transaction.list<number>({
        prefix: SANDBOX_WATERMARK_PREFIX,
        ...(cursor ? { startAfter: cursor } : {}),
        limit: SANDBOX_PRUNE_BATCH_SIZE,
      });
      const expired = Array.from(page, ([key, through]) => (through < cutoff ? key : null)).filter(
        (key) => key !== null,
      );
      if (expired.length > 0) {
        await transaction.delete(expired);
      }
      const lastKey =
        page.size === SANDBOX_PRUNE_BATCH_SIZE ? Array.from(page.keys()).at(-1) : undefined;
      if (lastKey !== undefined) {
        await transaction.put(SANDBOX_PRUNE_CURSOR_KEY, lastKey);
      } else {
        await transaction.delete(SANDBOX_PRUNE_CURSOR_KEY);
      }

      // Counters, receipts, and pruning progress commit together. Publishing
      // the isolate cache afterwards also keeps a rejected commit retryable.
      await transaction.put('state', state);
      if (options.scheduleAiAlarm) {
        const nextAlarm = Date.now() + AI_ALARM_INTERVAL_MS;
        const alarm = await transaction.getAlarm();
        if (alarm === null || alarm > nextAlarm) {
          await transaction.setAlarm(nextAlarm);
        }
      }
      return page.size > expired.length || page.size === SANDBOX_PRUNE_BATCH_SIZE || !!cursor;
    });
    this.state = state;
    return hasWatermarks;
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/record') {
      return this.handleRecord(request);
    }
    if (request.method === 'POST' && path === '/rollover') {
      return this.handleRollover(request);
    }
    if (request.method === 'POST' && path === '/init') {
      return this.handleInit(request);
    }
    if (request.method === 'POST' && path === '/attach-project') {
      return this.handleAttachProject(request);
    }
    if (request.method === 'POST' && path === '/detach-project') {
      return this.handleDetachProject(request);
    }
    if (request.method === 'POST' && path === '/reevaluate-limits') {
      return this.handleReevaluateLimits(request);
    }
    if (request.method === 'POST' && path === '/reevaluate-sandbox') {
      return this.handleReevaluateSandbox(request);
    }
    if (request.method === 'POST' && path === '/clear-suspension') {
      return this.handleClearSuspension();
    }
    if (request.method === 'GET' && path === '/state') {
      return this.handleGetState();
    }

    return new Response('not found', { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = await request.json<{
      events: ReadonlyArray<UsageEvent>;
      plan?: string;
      userId: string;
      billingPeriodStart?: string;
    }>();
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }
    // A new counter can first see an interval after that interval has ended.
    // Its construction time is not the account's billing-period boundary.
    if (!state.billingPeriodInitialized && body.billingPeriodStart) {
      if (!Number.isFinite(Date.parse(body.billingPeriodStart))) {
        return Response.json({ error: 'invalid billing period' }, { status: 400 });
      }
      state.billingPeriodStart = body.billingPeriodStart;
      state.billingPeriodInitialized = true;
    }

    const incomingRequests = body.events.reduce((sum, e) => sum + e.requests, 0);
    state.totalRequests += incomingRequests;

    // The API-owned producer sends cumulative intervals with a stable start
    // per lease generation. A high watermark handles retries and out-of-order
    // delivery, while a new generation excludes idle time between leases.
    const periodStart = state.billingPeriodInitialized ? Date.parse(state.billingPeriodStart) : 0;
    const watermarkCutoff = Date.now() - SANDBOX_USAGE_RETENTION_MS;
    const watermarks = new Map<string, number>();
    let incomingSandboxSeconds = 0;
    for (const event of body.events) {
      const leaseId = event.sandboxInstanceId;
      const from = event.sandboxMeteredFrom;
      const through = event.sandboxMeteredThrough;
      if (
        !leaseId ||
        typeof from !== 'number' ||
        typeof through !== 'number' ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(through) ||
        through <= from ||
        through < watermarkCutoff
      ) {
        continue;
      }
      const key = await sandboxWatermarkKey(leaseId, from);
      const previous = watermarks.get(key) ?? (await this.ctx.storage.get<number>(key)) ?? from;
      const billFrom = Math.max(
        previous,
        from,
        Number.isFinite(periodStart) ? periodStart : from,
        // Receipts older than retention may already be pruned. A cumulative
        // frame must not revive their billed prefix after a long delivery gap.
        watermarkCutoff,
      );
      if (through > billFrom) {
        incomingSandboxSeconds += (through - billFrom) / 1000;
      }
      watermarks.set(key, Math.max(previous, through));
    }
    state.totalSandboxSeconds += incomingSandboxSeconds;

    // Only the current owner may keep a project in the active enforcement set.
    // Recheck the queue consumer's snapshot here so a transfer that completed
    // before this serialized operation cannot be undone by a delayed record.
    let db: ReturnType<typeof createDb> | undefined;
    const getDb = (): ReturnType<typeof createDb> => {
      db ??= createDb(this.env.HYPERDRIVE.connectionString);
      return db;
    };
    const attachmentCandidates = [
      ...new Set(
        body.events
          .filter(
            (event) =>
              event.currentOwner !== false && !Object.hasOwn(state.projectSlugs, event.projectId),
          )
          .map((event) => event.projectId),
      ),
    ];
    const approvedAttachments =
      attachmentCandidates.length > 0
        ? await this.ownedProjectIds(getDb(), attachmentCandidates, body.userId)
        : new Set<string>();
    for (const event of body.events) {
      if (
        event.currentOwner !== false &&
        (Object.hasOwn(state.projectSlugs, event.projectId) ||
          approvedAttachments.has(event.projectId))
      ) {
        state.projectSlugs[event.projectId] = event.slug;
        if (event.ownershipStartedAt) {
          state.projectOwnershipStarts[event.projectId] = event.ownershipStartedAt;
        }
      }
    }

    // The queue envelope may have waited behind a plan change. Resolve current
    // ownership and limits from PostgreSQL, independently of the producer hint.
    const owner = await getUser(getDb(), body.userId);
    state.plan = owner?.plan ?? state.plan;
    const limits = await resolvePlanLimits(getDb(), state.plan);

    // Commit each suspension latch only after every enforcement write succeeds.
    const exceedsLimit = evaluateRequestLimit(state, 0, limits); // already added above
    if (exceedsLimit && !state.requestsSuspended) {
      await settleWrites([
        this.suspendProjects(getDb(), state.projectSlugs, body.userId, REASON_REQUESTS_EXCEEDED),
        suspendUser(getDb(), body.userId, REASON_REQUESTS_EXCEEDED),
      ]);
      // The first route stamp and account-row update intentionally run
      // together. An ownership-transfer republish can land between them after
      // reading the old account row, so reconcile once more after both settle.
      await this.suspendProjects(
        getDb(),
        state.projectSlugs,
        body.userId,
        REASON_REQUESTS_EXCEEDED,
      );
      state.requestsSuspended = true;
    }

    const exceedsSandbox = evaluateSandboxRuntimeLimit(state, 0, limits); // already added above
    if (exceedsSandbox && !state.sandboxRuntimeSuspended) {
      await settleWrites([
        this.env.ROUTING.put(sandboxBlockKey(body.userId), '1'),
        suspendUser(getDb(), body.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
      state.sandboxRuntimeSuspended = true;
    }

    await this.ensureAiAlarm();

    await this.saveState(state, { watermarks });

    return Response.json({
      totalRequests: state.totalRequests,
      suspended: state.requestsSuspended,
      totalSandboxSeconds: state.totalSandboxSeconds,
      sandboxRuntimeSuspended: state.sandboxRuntimeSuspended,
    });
  }

  private async handleRollover(request: Request): Promise<Response> {
    const body = await request.json<{
      billingPeriodStart: string;
      plan: string;
      userId: string;
    }>();
    const incomingPeriodStart = Date.parse(body.billingPeriodStart);
    if (!Number.isFinite(incomingPeriodStart)) {
      return Response.json({ error: 'invalid billing period' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }

    // A delayed scheduler snapshot must not rewind an already advanced ledger.
    if (
      state.billingPeriodInitialized &&
      incomingPeriodStart <= Date.parse(state.billingPeriodStart)
    ) {
      return Response.json({
        rolled: false,
        unsuspendRequests: false,
        unsuspendAi: false,
        // The authoritative request-suspension latch, returned on EVERY response
        // (not just rollovers) so the scheduler can reconcile the KV `suspended`
        // marker against it each pass — see processUserRollover in index.ts.
        requestsSuspended: state.requestsSuspended,
        projectSlugs: state.projectSlugs,
      });
    }

    const previousSuspensions = await this.advanceBillingPeriod(state, body, false);

    await this.saveState(state);

    return Response.json({
      rolled: true,
      unsuspendRequests: previousSuspensions.requests,
      unsuspendAi: previousSuspensions.ai,
      // Post-rollover latch (false after a request rollover). Returned every
      // response so the scheduler reconciles KV against it each pass — see
      // processUserRollover in index.ts.
      requestsSuspended: state.requestsSuspended,
      projectSlugs: state.projectSlugs,
    });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json<{
      plan: string;
      billingPeriodStart: string;
      projectSlugs: Record<string, string>;
      projectOwnershipStarts?: Record<string, string>;
      userId?: string;
    }>();
    const incomingPeriodStart = Date.parse(body.billingPeriodStart);
    if (!Number.isFinite(incomingPeriodStart)) {
      return Response.json({ error: 'invalid billing period' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }

    // PostgreSQL owns the current project set. Replace instead of merge so an
    // ownership transfer cannot leave the old owner's DO able to restamp the
    // transferred project's routing or AI block.
    const previousProjectIds = new Set(Object.keys(state.projectSlugs));
    const removedProjectIds = [...previousProjectIds].filter(
      (projectId) => !(projectId in body.projectSlugs),
    );
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    await this.syncBillingPeriod(state, body.billingPeriodStart, body.plan);
    await this.retainTransferredProjectWindows(db, state, removedProjectIds);
    state.projectSlugs = { ...body.projectSlugs };
    state.projectOwnershipStarts = Object.fromEntries(
      Object.keys(body.projectSlugs).flatMap((projectId) => {
        const startsAt =
          body.projectOwnershipStarts?.[projectId] ?? state.projectOwnershipStarts[projectId];
        return startsAt ? [[projectId, startsAt]] : [];
      }),
    );
    state.plan = body.plan;

    // Re-suspend any newly added project slugs if user is currently suspended
    if (state.requestsSuspended) {
      await this.suspendProjects(
        db,
        state.projectSlugs,
        state.ownerUserId,
        REASON_REQUESTS_EXCEEDED,
      );
    }
    if (state.ownerUserId) {
      for (const projectId of Object.keys(state.projectSlugs)) {
        await setProjectAiBlock(
          this.env.ROUTING,
          db,
          projectId,
          state.ownerUserId,
          state.aiSuspended,
        );
      }
    }

    await this.saveState(state);
    if (Object.keys(state.historicalAiWindows).length > 0) {
      await this.ensureAiAlarm();
    }
    return Response.json({ ok: true });
  }

  private async handleAttachProject(request: Request): Promise<Response> {
    const body = await request.json<{
      projectId: string;
      slug: string;
      ownershipStartedAt: string;
      billingPeriodStart?: string;
      userId?: string;
    }>();
    if (
      !body.projectId ||
      !body.slug ||
      !body.ownershipStartedAt ||
      !Number.isFinite(Date.parse(body.ownershipStartedAt)) ||
      (body.billingPeriodStart !== undefined &&
        !Number.isFinite(Date.parse(body.billingPeriodStart)))
    ) {
      return Response.json({ error: 'invalid project attachment' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    if (
      !state.ownerUserId ||
      !(await verifyActiveProjectOwner(db, body.projectId, state.ownerUserId))
    ) {
      return Response.json({ error: 'project owner changed' }, { status: 409 });
    }
    const owner = state.ownerUserId ? await getUser(db, state.ownerUserId) : null;
    if (!owner) {
      return Response.json({ error: 'project owner changed' }, { status: 409 });
    }
    // Ownership transfer requests may have waited behind a concurrent plan
    // change. PostgreSQL is authoritative; never restore the caller's stale
    // pre-transfer snapshot into this counter.
    state.plan = owner.plan;
    if (body.billingPeriodStart !== undefined) {
      await this.syncBillingPeriod(state, body.billingPeriodStart, owner.plan);
    }
    if (
      !(await setProjectAiBlock(
        this.env.ROUTING,
        db,
        body.projectId,
        state.ownerUserId,
        state.aiSuspended,
      ))
    ) {
      return Response.json({ error: 'project owner changed' }, { status: 409 });
    }
    state.projectSlugs[body.projectId] = body.slug;
    state.projectOwnershipStarts[body.projectId] = body.ownershipStartedAt;
    if (state.requestsSuspended) {
      await this.suspendProjects(
        db,
        { [body.projectId]: body.slug },
        state.ownerUserId,
        REASON_REQUESTS_EXCEEDED,
      );
    }
    await this.saveState(state);
    await this.ensureAiAlarm();
    return Response.json({ ok: true });
  }

  private async handleDetachProject(request: Request): Promise<Response> {
    const body = await request.json<{
      projectId: string;
      userId?: string;
      billingPeriodStart?: string;
      ownershipStartedAt?: string;
      ownershipEndedAt?: string;
    }>();
    if (!body.projectId) {
      return Response.json({ error: 'projectId is required' }, { status: 400 });
    }
    if (
      (body.billingPeriodStart && !Number.isFinite(Date.parse(body.billingPeriodStart))) ||
      (body.ownershipStartedAt && !Number.isFinite(Date.parse(body.ownershipStartedAt))) ||
      (body.ownershipEndedAt && !Number.isFinite(Date.parse(body.ownershipEndedAt)))
    ) {
      return Response.json({ error: 'invalid ownership window' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const owner = state.ownerUserId ? await getUser(db, state.ownerUserId) : null;
    if (owner) {
      state.plan = owner.plan;
    }
    if (body.billingPeriodStart) {
      await this.syncBillingPeriod(state, body.billingPeriodStart, state.plan);
    }
    if (body.ownershipEndedAt) {
      this.retainHistoricalAiWindow(
        state,
        body.projectId,
        body.ownershipStartedAt ?? state.projectOwnershipStarts[body.projectId],
        body.ownershipEndedAt,
      );
    } else {
      this.retainHistoricalAiSample(state, body.projectId);
    }
    this.recomputeTotalNeurons(state);
    // Teardown may remove the SQL ownership history once this returns. Retain
    // both the cutoff and its next reconciliation in one durable transaction;
    // provider analytics availability must not hold deletion or transfer open.
    await this.saveState(state, {
      scheduleAiAlarm: Object.keys(state.historicalAiWindows).length > 0,
    });
    return Response.json({ ok: true });
  }

  /** Reconcile changed plan limits without resetting the billing ledger. */
  private async handleReevaluateLimits(request: Request): Promise<Response> {
    const body = await request.json<{ userId?: string }>();
    const state = await this.getState();
    const userId = body.userId ?? state.ownerUserId;
    if (!userId || (state.ownerUserId && state.ownerUserId !== userId)) {
      return Response.json({ error: 'counter owner does not match' }, { status: 409 });
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const owner = await getUser(db, userId);
    if (!owner) {
      return Response.json({ error: 'user not found' }, { status: 404 });
    }
    state.ownerUserId = userId;
    state.plan = owner.plan;
    const limits = await resolvePlanLimits(db, owner.plan);
    const requestsSuspended = evaluateRequestLimit(state, 0, limits);
    const sandboxRuntimeSuspended = evaluateSandboxRuntimeLimit(state, 0, limits);
    const aiSuspended = evaluateAiLimit(state, limits);
    const ownedProjects = await this.ownedProjects(db, state.projectSlugs, userId);

    await settleWrites([
      (async () => {
        if (requestsSuspended || sandboxRuntimeSuspended) {
          await suspendUser(
            db,
            userId,
            requestsSuspended ? REASON_REQUESTS_EXCEEDED : REASON_SANDBOX_RUNTIME_EXCEEDED,
          );
        } else {
          await unsuspendUserIfReason(db, userId, REASON_REQUESTS_EXCEEDED);
          await unsuspendUserIfReason(db, userId, REASON_SANDBOX_RUNTIME_EXCEEDED);
        }
      })(),
      setProjectsRoutingSuspension(
        this.env.ROUTING,
        db,
        ownedProjects,
        requestsSuspended
          ? { op: 'suspend', reason: REASON_REQUESTS_EXCEEDED, force: false }
          : { op: 'unsuspend', matchReason: REASON_REQUESTS_EXCEEDED },
      ),
      sandboxRuntimeSuspended
        ? this.env.ROUTING.put(sandboxBlockKey(userId), '1')
        : this.env.ROUTING.delete(sandboxBlockKey(userId)),
      ...ownedProjects.map((project) =>
        setProjectAiBlock(this.env.ROUTING, db, project.id, userId, aiSuspended),
      ),
    ]);
    state.requestsSuspended = requestsSuspended;
    state.sandboxRuntimeSuspended = sandboxRuntimeSuspended;
    state.aiSuspended = aiSuspended;
    await this.saveState(state);
    await this.ensureAiAlarm();
    return Response.json({ ok: true, requestsSuspended, sandboxRuntimeSuspended, aiSuspended });
  }

  /**
   * Admin plan changes: optimistically clear ALL in-memory usage latches so the
   * next handleRecord (and the AI alarm) re-evaluates against the new plan.
   * Drops request + sandbox + AI — a plan change can lift any cap, and leaving
   * `requestsSuspended` set would make the next `/init` re-stamp the routes the
   * plan-change route just cleared. AI normally self-heals via the alarm, but
   * the alarm returns early for unlimited-AI plans, so a capped→unlimited-AI
   * upgrade needs the ai-block keys cleared here (projectId-keyed, owned by the
   * DO). The plan-change route deletes the userId-keyed sandbox-block.
   */
  private async handleReevaluateSandbox(request: Request): Promise<Response> {
    const body = await request.json<{ plan: string }>();
    const state = await this.getState();
    state.plan = body.plan;
    state.requestsSuspended = false;
    state.sandboxRuntimeSuspended = false;
    if (state.aiSuspended) {
      // Keep the durable latch set until every idempotent delete succeeds.
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      if (state.ownerUserId) {
        for (const projectId of Object.keys(state.projectSlugs)) {
          await setProjectAiBlock(this.env.ROUTING, db, projectId, state.ownerUserId, false);
        }
      }
      state.aiSuspended = false;
    }
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  /**
   * Admin unsuspend: drop the request + sandbox suspension latches. The admin
   * route clears the corresponding KV routes concurrently with this call and the
   * DB reason only after this succeeds; resetting the latches here stops the next
   * billing-reconcile `/init` from re-stamping the routes (the `requestsSuspended`
   * branch) and lets the next `/record` re-evaluate against current usage. AI
   * self-heals via the alarm, so `aiSuspended` is intentionally left untouched.
   * This is a latch reset only — no counters change (unlike a billing rollover).
   * Shares the operation queue so an in-flight record cannot restore the latch.
   */
  private async handleClearSuspension(): Promise<Response> {
    const state = await this.getState();
    state.requestsSuspended = false;
    state.sandboxRuntimeSuspended = false;
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    return Response.json(state);
  }

  // --- AI alarm handler ---

  async alarm(): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.handleAlarm();
      } catch (error) {
        // Native alarm retries are bounded. Preserve a future wakeup through
        // longer provider outages without replacing persisted usage with zero.
        await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
        throw error;
      }
    });
  }

  private async handleAlarm(): Promise<void> {
    const state = await this.getState();

    // Older persisted states do not identify their account. Wait for the next
    // trusted record/rollover/init instead of risking a cross-owner KV write.
    if (!state.ownerUserId) {
      await this.saveState(state);
      await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
      return;
    }

    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const ownedProjectIds = await this.ownedProjectIds(
      db,
      Object.keys(state.projectSlugs),
      state.ownerUserId,
    );
    const transferredProjectIds = Object.keys(state.projectSlugs).filter(
      (projectId) => !ownedProjectIds.has(projectId),
    );
    await this.retainTransferredProjectWindows(db, state, transferredProjectIds);
    if (Object.keys(state.historicalAiWindows).length > 0) {
      // Deleting the last project also deletes its ownership history, so the
      // scheduler can no longer discover this counter for billing rollover.
      const owner = await getUser(db, state.ownerUserId);
      if (!owner) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      state.plan = owner.plan;
      if (owner.billing_cycle_start) {
        const billingPeriodStart = getCurrentBillingPeriodStart(owner.billing_cycle_start);
        if (billingPeriodStart.getTime() > Date.parse(state.billingPeriodStart)) {
          await this.advanceBillingPeriod(
            state,
            {
              billingPeriodStart: billingPeriodStart.toISOString(),
              plan: owner.plan,
              userId: owner.id,
            },
            true,
          );
        }
      }
    }
    const currentOwner = await getUser(db, state.ownerUserId);
    if (currentOwner) {
      state.plan = currentOwner.plan;
    }
    const limits = await resolvePlanLimits(db, state.plan);
    const projectIds = [...ownedProjectIds];
    // Closed windows still need reconciliation on unlimited plans: detachment
    // preserves their samples without depending on provider availability.
    // Otherwise inactive accounts only wake while receipt pruning has work.
    if (
      Object.keys(state.historicalAiWindows).length === 0 &&
      (limits.aiNeuronsPerMonth === 0 || projectIds.length === 0)
    ) {
      if (await this.saveState(state)) {
        await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
      }
      return;
    }

    // Re-query closed ownership windows because Analytics ingestion can lag the
    // transfer transaction. Exact half-open cutoffs prevent either owner from
    // being charged for the other side of the transfer boundary.
    await this.refreshHistoricalAiWindows(state);

    // Query AI Gateway for each currently owned project's neuron usage.
    const billingSince = new Date(state.billingPeriodStart);
    for (const projectId of limits.aiNeuronsPerMonth === 0 ? [] : projectIds) {
      const ownershipStartedAt = state.projectOwnershipStarts[projectId];
      const ownershipSince = ownershipStartedAt ? new Date(ownershipStartedAt) : billingSince;
      const since =
        Number.isFinite(ownershipSince.getTime()) && ownershipSince > billingSince
          ? ownershipSince
          : billingSince;
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
        this.env.AI_GATEWAY_ID ?? 'void',
        this.env.JWT_SECRET,
        projectId,
        since,
      );
      state.projectNeurons[projectId] = result.neurons;
    }

    this.recomputeTotalNeurons(state);

    const exceedsAi = evaluateAiLimit(state, limits);
    if (exceedsAi && !state.aiSuspended) {
      state.aiSuspended = true;
      for (const projectId of projectIds) {
        await setProjectAiBlock(this.env.ROUTING, db, projectId, state.ownerUserId, true);
      }
    } else if (!exceedsAi && state.aiSuspended) {
      state.aiSuspended = false;
      for (const projectId of projectIds) {
        await setProjectAiBlock(this.env.ROUTING, db, projectId, state.ownerUserId, false);
      }
    }

    await this.saveState(state);

    await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
  }

  // --- Private helpers ---

  private async ensureAiAlarm(): Promise<void> {
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
    }
  }

  private retainHistoricalAiSample(state: CounterState, projectId: string): void {
    const billed = state.projectNeurons[projectId];
    if (typeof billed === 'number' && Number.isFinite(billed)) {
      state.historicalNeurons += billed;
    }
    delete state.projectNeurons[projectId];
    delete state.projectOwnershipStarts[projectId];
    delete state.projectSlugs[projectId];
  }

  private retainHistoricalAiWindow(
    state: CounterState,
    projectId: string,
    ownershipStartedAt: string | undefined,
    ownershipEndedAt: string,
  ): string | null {
    const billingStartedAt = new Date(state.billingPeriodStart);
    const startedAt = new Date(ownershipStartedAt ?? state.billingPeriodStart);
    const endedAt = new Date(ownershipEndedAt);
    if (
      !Number.isFinite(billingStartedAt.getTime()) ||
      !Number.isFinite(startedAt.getTime()) ||
      !Number.isFinite(endedAt.getTime()) ||
      endedAt <= startedAt
    ) {
      this.retainHistoricalAiSample(state, projectId);
      return null;
    }
    const normalizedStart = startedAt.toISOString();
    const matchingWindows = Object.entries(state.historicalAiWindows).filter(
      ([, window]) =>
        window.projectId === projectId &&
        Date.parse(window.ownershipStartedAt) === startedAt.getTime(),
    );
    const effectiveEnd = Math.max(
      endedAt.getTime(),
      ...matchingWindows
        .map(([, window]) => Date.parse(window.ownershipEndedAt))
        .filter(Number.isFinite),
    );
    const normalizedEnd = new Date(effectiveEnd).toISOString();
    const key = JSON.stringify([projectId, normalizedStart, normalizedEnd]);
    const existing = state.historicalAiWindows[key] ?? matchingWindows[0]?.[1];
    const sampled = state.projectNeurons[projectId];
    for (const [matchingKey] of matchingWindows) {
      delete state.historicalAiWindows[matchingKey];
    }
    state.historicalAiWindows[key] = {
      projectId,
      ownershipStartedAt: normalizedStart,
      ownershipEndedAt: normalizedEnd,
      neurons:
        existing?.neurons ??
        (typeof sampled === 'number' && Number.isFinite(sampled) ? sampled : 0),
    };
    delete state.projectNeurons[projectId];
    delete state.projectOwnershipStarts[projectId];
    delete state.projectSlugs[projectId];
    return key;
  }

  private async retainTransferredProjectWindows(
    db: Db,
    state: CounterState,
    projectIds: ReadonlyArray<string>,
  ): Promise<void> {
    if (projectIds.length === 0) {
      return;
    }
    const periods = await getProjectOwnershipPeriodsByProjectIds(db, projectIds);
    for (const projectId of projectIds) {
      const expectedStart = state.projectOwnershipStarts[projectId];
      const candidates = periods
        .filter(
          (period): period is (typeof periods)[number] & { ends_at: string } =>
            period.project_id === projectId &&
            period.owner_user_id === state.ownerUserId &&
            period.ends_at !== null,
        )
        .sort((left, right) => Date.parse(right.ends_at) - Date.parse(left.ends_at));
      const period =
        candidates.find(
          (candidate) =>
            expectedStart && Date.parse(candidate.starts_at) === Date.parse(expectedStart),
        ) ?? candidates[0];
      if (period?.ends_at) {
        this.retainHistoricalAiWindow(state, projectId, period.starts_at, period.ends_at);
      } else {
        // Project deletion removes ownership history with the project. Retain
        // the last sampled amount when no closed transfer window survives.
        this.retainHistoricalAiSample(state, projectId);
      }
    }
  }

  private async refreshHistoricalAiWindows(state: CounterState): Promise<void> {
    const billingSince = new Date(state.billingPeriodStart);
    for (const key of Object.keys(state.historicalAiWindows)) {
      const window = state.historicalAiWindows[key];
      if (!window) {
        continue;
      }
      const ownershipSince = new Date(window.ownershipStartedAt);
      const until = new Date(window.ownershipEndedAt);
      const since = ownershipSince > billingSince ? ownershipSince : billingSince;
      if (until <= since) {
        window.neurons = 0;
        continue;
      }
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
        this.env.AI_GATEWAY_ID ?? 'void',
        this.env.JWT_SECRET,
        window.projectId,
        since,
        until,
        true,
      );
      window.neurons = result.neurons;
    }
  }

  private recomputeTotalNeurons(state: CounterState): void {
    const current = Object.values(state.projectNeurons).reduce(
      (total, neurons) => total + neurons,
      0,
    );
    const historicalWindows = Object.values(state.historicalAiWindows).reduce(
      (total, window) => total + window.neurons,
      0,
    );
    state.totalNeurons = state.historicalNeurons + historicalWindows + current;
  }

  /**
   * Adopt the caller's billing period on an uninitialized counter, or advance the
   * ledger when the period moved forward. Plan reconciliation can precede the
   * hourly rollover; never label old totals as new usage.
   */
  private async syncBillingPeriod(
    state: CounterState,
    billingPeriodStart: string,
    plan: string,
  ): Promise<void> {
    const incomingPeriodStart = Date.parse(billingPeriodStart);
    const currentPeriodStart = Date.parse(state.billingPeriodStart);
    if (!state.billingPeriodInitialized) {
      state.billingPeriodStart = billingPeriodStart;
      state.billingPeriodInitialized = true;
    } else if (!Number.isFinite(currentPeriodStart) || incomingPeriodStart > currentPeriodStart) {
      await this.advanceBillingPeriod(
        state,
        { billingPeriodStart, plan, userId: state.ownerUserId ?? '' },
        true,
      );
    }
  }

  private async advanceBillingPeriod(
    state: CounterState,
    next: { billingPeriodStart: string; plan: string; userId: string },
    reconcileRequestSuspension: boolean,
  ): Promise<Readonly<{ requests: boolean; ai: boolean }>> {
    const requests = state.requestsSuspended;
    const ai = state.aiSuspended;
    const sandbox = state.sandboxRuntimeSuspended;
    const db = createDb(this.env.HYPERDRIVE.connectionString);

    // Finish idempotent external cleanup before committing the new period.
    // A failure leaves the cached and persisted period unchanged for retry.
    if (ai) {
      const ownerUserId = next.userId || state.ownerUserId;
      if (ownerUserId) {
        for (const projectId of Object.keys(state.projectSlugs)) {
          await setProjectAiBlock(this.env.ROUTING, db, projectId, ownerUserId, false);
        }
      }
    }
    if (sandbox) {
      await settleWrites([
        this.env.ROUTING.delete(sandboxBlockKey(next.userId)),
        unsuspendUserIfReason(db, next.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
    }
    if (requests && reconcileRequestSuspension) {
      const ownerUserId = next.userId || state.ownerUserId;
      if (!ownerUserId) {
        throw new Error('cannot reconcile request suspension without an owner');
      }
      const ownedProjects = await this.ownedProjects(db, state.projectSlugs, ownerUserId);
      await settleWrites([
        unsuspendUserIfReason(db, ownerUserId, REASON_REQUESTS_EXCEEDED),
        setProjectsRoutingSuspension(this.env.ROUTING, db, ownedProjects, {
          op: 'unsuspend',
          matchReason: REASON_REQUESTS_EXCEEDED,
        }),
      ]);
    }

    state.totalRequests = 0;
    state.totalNeurons = 0;
    state.totalSandboxSeconds = 0;
    state.historicalNeurons = 0;
    state.historicalAiWindows = {};
    state.projectNeurons = {};
    state.plan = next.plan;
    state.billingPeriodStart = next.billingPeriodStart;
    state.billingPeriodInitialized = true;
    state.requestsSuspended = false;
    state.aiSuspended = false;
    state.sandboxRuntimeSuspended = false;

    return { requests, ai };
  }

  private async suspendProjects(
    db: Db,
    projectSlugs: Record<string, string>,
    expectedOwnerUserId: string | null,
    reason: string,
  ): Promise<void> {
    if (!expectedOwnerUserId) {
      return;
    }
    // Stamp `suspended` on each project's slug route AND its active custom-domain
    // routes — dispatch enforces suspension from all of them, so a slug-only
    // stamp would leave over-limit projects serving on their custom domains.
    //
    // `force: false`: a usage suspension must never overwrite an admin
    // suspension already on the route. If an admin suspended the user first, the
    // route carries `admin_suspended` and this leaves it intact (the admin
    // reason already blocks dispatch; downgrading it to `requests_exceeded`
    // would let the next admin unsuspend silently un-block an admin action).
    const projects = await this.ownedProjects(db, projectSlugs, expectedOwnerUserId);
    await setProjectsRoutingSuspension(this.env.ROUTING, db, projects, {
      op: 'suspend',
      reason,
      force: false,
    });
  }

  /** Routing targets for the tracked projects `ownerUserId` still owns. */
  private async ownedProjects(
    db: Db,
    projectSlugs: Record<string, string>,
    ownerUserId: string,
  ): Promise<Array<{ id: string; slug: string; user_id: string }>> {
    const ownedIds = await this.ownedProjectIds(db, Object.keys(projectSlugs), ownerUserId);
    return Object.entries(projectSlugs).flatMap(([id, slug]) =>
      ownedIds.has(id) ? [{ id, slug, user_id: ownerUserId }] : [],
    );
  }

  /** Prevent a stale former-owner counter from mutating transferred projects. */
  private async ownedProjectIds(
    db: Db,
    projectIds: ReadonlyArray<string>,
    expectedOwnerUserId: string | null,
  ): Promise<Set<string>> {
    if (!expectedOwnerUserId || projectIds.length === 0) {
      return new Set();
    }
    const projects = await getProjectsByIds(db, projectIds);
    return new Set(
      projects
        .filter(
          (project) => project.user_id === expectedOwnerUserId && project.status !== 'deleting',
        )
        .map((project) => project.id),
    );
  }
}
