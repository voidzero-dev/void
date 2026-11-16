import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

vi.mock('../../src/plans.ts', async () => {
  const { getPlanLimits } = await import('../../src/tiers.ts');
  return { resolvePlanLimits: vi.fn(async (_db: unknown, plan: string) => getPlanLimits(plan)) };
});

// Mock db.ts so we can assert suspendUser / unsuspendUserIfReason calls without
// touching Postgres. createDb returns a sentinel — the suspend helpers don't
// inspect it because they're also mocked.
const dbCalls = {
  suspend: [] as Array<{ id: string; reason: string }>,
  unsuspendIfReason: [] as Array<{ id: string; reason: string }>,
};
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({
    __mock: 'db',
    transaction: async (fn: (tx: { execute: () => Promise<void> }) => Promise<unknown>) =>
      fn({ execute: async () => {} }),
  }),
  suspendUser: vi.fn(async (_db: unknown, id: string, reason: string) => {
    dbCalls.suspend.push({ id, reason });
  }),
  unsuspendUserIfReason: vi.fn(async (_db: unknown, id: string, reason: string) => {
    dbCalls.unsuspendIfReason.push({ id, reason });
  }),
  // The DO module also re-exports nothing else from db.ts at module scope,
  // so a minimal mock is sufficient.
  getUser: vi.fn(async (_db: unknown, id: string) => ({ id, plan: 'pro' })),
  getProject: vi.fn(async (_db: unknown, id: string) => ({ id, user_id: 'u1', slug: id })),
  getProjectsByIds: vi.fn(async (_db: unknown, ids: ReadonlyArray<string>) =>
    ids.map((id) => ({ id, user_id: 'u1', slug: id })),
  ),
  getProjectOwnershipPeriodsByProjectIds: vi.fn(async () => []),
  // routing.ts (imported transitively via setProjectsRoutingSuspension) reads a
  // project's active domains here. Default to none so request-suspension tests
  // that don't seed domains keep their slug-only behaviour.
  getDomainsByProjectIds: vi.fn(async () => new Map()),
}));

vi.mock('../../src/zero-trust/routing.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/zero-trust/routing.ts')>()),
  // These counter tests use public projects and a DB sentinel; the integration
  // routing tests cover authoritative protection reads under the project lock.
  resolveProjectZeroTrustRoutingForPublication: vi.fn(async () => null),
}));

import {
  getProject,
  getProjectOwnershipPeriodsByProjectIds,
  getProjectsByIds,
  getUser,
  suspendUser,
} from '../../src/db.ts';
import { resolvePlanLimits } from '../../src/plans.ts';
import { queryProjectAiUsage } from '../../src/routes/usage.ts';
import { getPlanLimits } from '../../src/tiers.ts';

beforeEach(() => {
  vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'pro' } as never);
  vi.mocked(resolvePlanLimits).mockImplementation(async (_db, plan) => getPlanLimits(plan));
});
import { SANDBOX_USAGE_RETENTION_MS } from '../../src/usage-auth.ts';
import {
  evaluateRequestLimit,
  evaluateAiLimit,
  evaluateSandboxRuntimeLimit,
  UsageCounter,
  type CounterState,
  type UsageEvent,
} from '../../src/usage-counter.ts';

vi.mock('../../src/routes/usage.ts', () => ({
  queryProjectAiUsage: vi.fn(async () => ({ neurons: 0 })),
}));

function makeState(overrides: Partial<CounterState> = {}): CounterState {
  return {
    ownerUserId: 'u1',
    totalRequests: 0,
    totalNeurons: 0,
    totalSandboxSeconds: 0,
    plan: 'free',
    billingPeriodStart: '2026-01-01T00:00:00Z',
    requestsSuspended: false,
    aiSuspended: false,
    sandboxRuntimeSuspended: false,
    projectSlugs: {},
    projectOwnershipStarts: {},
    projectNeurons: {},
    historicalNeurons: 0,
    historicalAiWindows: {},
    ...overrides,
  };
}

describe('evaluateRequestLimit', () => {
  it('returns false when within free plan limit (3M)', () => {
    const state = makeState({ totalRequests: 1_000_000, plan: 'free' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);
  });

  it('returns true when exceeding free plan limit', () => {
    const state = makeState({ totalRequests: 2_999_999, plan: 'free' });
    expect(evaluateRequestLimit(state, 2)).toBe(true);
  });

  it('returns true when exactly at free plan limit', () => {
    const state = makeState({ totalRequests: 2_999_990, plan: 'free' });
    expect(evaluateRequestLimit(state, 10)).toBe(true);
  });

  it('returns false for unlimited plans (sponsored)', () => {
    const state = makeState({ totalRequests: 999_999_999, plan: 'sponsored' });
    expect(evaluateRequestLimit(state, 1_000_000)).toBe(false);
  });

  it('returns false for unlimited plans (custom)', () => {
    const state = makeState({ totalRequests: 999_999_999, plan: 'custom' });
    expect(evaluateRequestLimit(state, 1_000_000)).toBe(false);
  });

  it('works for solo plan (10M limit)', () => {
    const state = makeState({ totalRequests: 5_000_000, plan: 'solo' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);

    const atLimit = makeState({ totalRequests: 9_999_999, plan: 'solo' });
    expect(evaluateRequestLimit(atLimit, 2)).toBe(true);
  });

  it('works for pro plan (100M limit)', () => {
    const state = makeState({ totalRequests: 50_000_000, plan: 'pro' });
    expect(evaluateRequestLimit(state, 100)).toBe(false);

    const atLimit = makeState({ totalRequests: 99_999_999, plan: 'pro' });
    expect(evaluateRequestLimit(atLimit, 2)).toBe(true);
  });
});

describe('evaluateAiLimit', () => {
  it('returns true when free plan exceeds 100K neurons', () => {
    const state = makeState({ totalNeurons: 100_001, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when free plan is exactly at 100K neurons', () => {
    const state = makeState({ totalNeurons: 100_000, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when solo plan exceeds 300K neurons', () => {
    const state = makeState({ totalNeurons: 300_001, plan: 'solo' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns true when pro plan exceeds 500K neurons', () => {
    const state = makeState({ totalNeurons: 500_001, plan: 'pro' });
    expect(evaluateAiLimit(state)).toBe(true);
  });

  it('returns false for unlimited plans (sponsored)', () => {
    const state = makeState({ totalNeurons: 999_999_999, plan: 'sponsored' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false for unlimited plans (custom)', () => {
    const state = makeState({ totalNeurons: 999_999_999, plan: 'custom' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within free plan limits', () => {
    const state = makeState({ totalNeurons: 50_000, plan: 'free' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within solo plan limits', () => {
    const state = makeState({ totalNeurons: 200_000, plan: 'solo' });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns false when within pro plan limits', () => {
    const state = makeState({ totalNeurons: 400_000, plan: 'pro' });
    expect(evaluateAiLimit(state)).toBe(false);
  });
});

describe('evaluateSandboxRuntimeLimit', () => {
  it('returns false when within solo plan limit (under 30h)', () => {
    expect(
      evaluateSandboxRuntimeLimit(makeState({ totalSandboxSeconds: 100, plan: 'solo' }), 50),
    ).toBe(false);
  });

  it('returns true when solo plan would exceed limit', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 30 * 3600 - 10, plan: 'solo' }),
        20,
      ),
    ).toBe(true);
  });

  it('returns true when solo plan is exactly at limit', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 30 * 3600 - 10, plan: 'solo' }),
        10,
      ),
    ).toBe(true);
  });

  it('returns false for unlimited plans (sponsored) regardless of usage', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 999_999_999, plan: 'sponsored' }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it('returns false for unlimited plans (custom) regardless of usage', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 999_999_999, plan: 'custom' }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it('works for pro plan (200h limit)', () => {
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 100 * 3600, plan: 'pro' }),
        50 * 3600,
      ),
    ).toBe(false);
    expect(
      evaluateSandboxRuntimeLimit(
        makeState({ totalSandboxSeconds: 200 * 3600 - 1, plan: 'pro' }),
        1,
      ),
    ).toBe(true);
  });

  it('rejects any non-trivial sandbox use on the free tier (effectively disabled)', () => {
    // free.sandboxRuntimeSecondsPerMonth is 1, so anything >= 1 total seconds
    // is rejected by isWithinLimit.
    expect(
      evaluateSandboxRuntimeLimit(makeState({ totalSandboxSeconds: 0, plan: 'free' }), 1),
    ).toBe(true);
  });
});

// --- UsageCounter DO integration tests ---

type KVCall = ['put' | 'delete', string, ...Array<unknown>];

function makeFakeKV() {
  const store = new Map<string, string>();
  const calls: Array<KVCall> = [];
  return {
    store,
    calls,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      calls.push(['put', key, value]);
      store.set(key, value);
    },
    delete: async (key: string) => {
      calls.push(['delete', key]);
      store.delete(key);
    },
  };
}

function makeFakeStorage() {
  const data = new Map<string, unknown>();
  let pending: Map<string, unknown> | null = null;
  let rejectCommit = false;
  let alarm: number | null = null;
  let pendingAlarm: number | null = null;
  type ListOptions = { prefix: string; startAfter?: string; limit: number };
  type Transaction = {
    get: <T>(key: string) => Promise<T | undefined>;
    put: (key: string, value: unknown) => Promise<void>;
    delete: (key: string | Array<string>) => Promise<void>;
    list: <T>(options: ListOptions) => Promise<Map<string, T>>;
  };
  const storage = {
    data,
    failNextCommit: () => {
      rejectCommit = true;
    },
    get: async <T>(key: string): Promise<T | undefined> => {
      const value = (pending ?? data).get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    put: async (key: string, value: unknown) => {
      (pending ?? data).set(key, structuredClone(value));
    },
    delete: async (keys: string | Array<string>) => {
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        (pending ?? data).delete(key);
      }
    },
    list: vi.fn(async <T>(options: ListOptions): Promise<Map<string, T>> => {
      const page = Array.from(pending ?? data)
        .filter(
          ([key]) =>
            key.startsWith(options.prefix) && (!options.startAfter || key > options.startAfter),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit);
      return new Map(page.map(([key, value]) => [key, structuredClone(value) as T]));
    }),
    transaction: async <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      pending = new Map(data);
      pendingAlarm = alarm;
      try {
        const result = await callback({
          ...storage,
          list: <U>(options: ListOptions) => storage.list(options) as Promise<Map<string, U>>,
        });
        if (rejectCommit) {
          rejectCommit = false;
          throw new Error('transaction commit failed');
        }
        data.clear();
        for (const [key, value] of pending) {
          data.set(key, value);
        }
        alarm = pendingAlarm;
        return result;
      } finally {
        pending = null;
      }
    },
    getAlarm: async () => (pending ? pendingAlarm : alarm),
    setAlarm: async (ts: number) => {
      if (pending) {
        pendingAlarm = ts;
      } else {
        alarm = ts;
      }
    },
    deleteAlarm: async () => {
      if (pending) {
        pendingAlarm = null;
      } else {
        alarm = null;
      }
    },
  };
  return storage;
}

function storedWatermarks(storage: ReturnType<typeof makeFakeStorage>): Map<string, number> {
  return new Map(
    Array.from(storage.data)
      .filter(([key]) => key.startsWith('sandbox-usage:watermark:'))
      .map(([key, through]) => [key, through as number]),
  );
}

const JWT_SECRET = 'usage-counter-secret';

function makeCounter(initialState: Partial<CounterState> = {}) {
  const kv = makeFakeKV();
  const storage = makeFakeStorage();
  // Seed initial state if requested
  if (Object.keys(initialState).length > 0) {
    storage.data.set('state', makeState(initialState));
  }
  const env = {
    ROUTING: kv,
    HYPERDRIVE: { connectionString: 'postgres://mock' },
    JWT_SECRET,
  };
  const ctx = { storage };

  // Construct directly — we don't call super() because the mocked DurableObject
  // is a noop base class.
  const counter = new UsageCounter(ctx as never, env as never);
  // Vitest mock doesn't run super(); manually assign ctx/env which the real
  // DO base class would normally set.
  (counter as unknown as { ctx: unknown; env: unknown }).ctx = ctx;
  (counter as unknown as { ctx: unknown; env: unknown }).env = env;
  return { counter, kv, storage, env };
}

function recordRequest(events: Array<UsageEvent>, userId: string, plan?: string): Request {
  return new Request('https://do/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events, userId, plan }),
  });
}

function rolloverRequest(billingPeriodStart: string, plan: string, userId?: string): Request {
  return new Request('https://do/rollover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billingPeriodStart, plan, userId }),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sandboxInterval(from: number, through: number, requests = 0): UsageEvent {
  return {
    projectId: 'p1',
    userId: 'u1',
    slug: 's1',
    requests,
    responseBytes: 0,
    sandboxInstanceId: 'lease-1',
    sandboxMeteredFrom: from,
    sandboxMeteredThrough: through,
  };
}

describe('UsageCounter.handleRecord — sandbox', () => {
  const intervalStart = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  beforeEach(() => {
    dbCalls.suspend.length = 0;
    dbCalls.unsuspendIfReason.length = 0;
  });

  it('counts the first completed interval using the account period rather than counter creation time', async () => {
    const { counter, storage } = makeCounter();
    const from = Date.now() - 60_000;
    const billingPeriodStart = new Date(from - 60_000).toISOString();
    const response = await counter.fetch(
      new Request('https://do/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'u1',
          plan: 'pro',
          billingPeriodStart,
          events: [sandboxInterval(from, from + 30_000)],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalSandboxSeconds: 30 });
    expect(storage.data.get('state')).toMatchObject({
      billingPeriodStart,
      billingPeriodInitialized: true,
    });
  });

  it('accumulates totalSandboxSeconds from a sandbox-only event', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: intervalStart,
        sandboxMeteredThrough: intervalStart + 42_000,
      },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'pro'));
    expect(res.status).toBe(200);
    const body = await res.json<{
      totalSandboxSeconds: number;
      sandboxRuntimeSuspended: boolean;
    }>();
    expect(body.totalSandboxSeconds).toBe(42);
    expect(body.sandboxRuntimeSuspended).toBe(false);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(42);
  });

  it('updates both totals on a mixed batch (requests + sandbox)', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 5, responseBytes: 100 },
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: intervalStart,
        sandboxMeteredThrough: intervalStart + 30_000,
      },
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: intervalStart + 30_000,
        sandboxMeteredThrough: intervalStart + 40_000,
      },
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 2, responseBytes: 0 },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'pro'));
    const body = await res.json<{
      totalRequests: number;
      totalSandboxSeconds: number;
    }>();
    expect(body.totalRequests).toBe(7);
    expect(body.totalSandboxSeconds).toBe(40);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalRequests).toBe(7);
    expect(persisted.totalSandboxSeconds).toBe(40);
  });

  it('treats events without sandboxRuntimeSeconds as 0', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 3, responseBytes: 100 },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'pro'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(0);
  });

  it('triggers sandbox suspension when crossing the plan limit', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'solo' } as never);
    // solo: sandboxRuntimeSecondsPerMonth = 30 * 3600 = 108_000
    const { counter, kv, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600 - 10,
    });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: intervalStart,
        sandboxMeteredThrough: intervalStart + 20_000,
      },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'solo'));
    const body = await res.json<{ sandboxRuntimeSuspended: boolean }>();
    expect(body.sandboxRuntimeSuspended).toBe(true);

    // KV: sandbox-block:u1 was written with '1'
    expect(kv.store.get('sandbox-block:u1')).toBe('1');
    expect(kv.calls).toContainEqual(['put', 'sandbox-block:u1', '1']);

    expect(dbCalls.suspend).toContainEqual({ id: 'u1', reason: 'sandbox_runtime_exceeded' });

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.sandboxRuntimeSuspended).toBe(true);
  });

  it('is idempotent: second over-limit batch does not re-write KV or re-call suspendUser', async () => {
    const { counter, kv } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600 - 10,
    });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: intervalStart,
        sandboxMeteredThrough: intervalStart + 20_000,
      },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'solo'));
    const callsAfterFirst = kv.calls.length;
    const suspendCountAfterFirst = dbCalls.suspend.length;

    // Second over-limit batch
    await counter.fetch(recordRequest(events, 'u1', 'solo'));
    expect(kv.calls.length).toBe(callsAfterFirst); // no new KV writes
    expect(dbCalls.suspend.length).toBe(suspendCountAfterFirst); // no new DB call
  });

  it('does not suspend or write KV when below the limit', async () => {
    const { counter, kv } = makeCounter({ plan: 'pro' });
    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: intervalStart,
        sandboxMeteredThrough: intervalStart + 60_000,
      },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'pro'));
    expect(kv.calls.filter(([op, key]) => op === 'put' && key === 'sandbox-block:u1')).toEqual([]);
    expect(dbCalls.suspend).toEqual([]);
  });

  it('is retry-safe when the sandbox-block KV write fails (latch not set until the block is written)', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'solo' } as never);
    // The sandbox latch is flipped only AFTER the block KV put + DB
    // suspend succeed. getState() caches and returns the same object on a queue
    // retry; flipping first then throwing on the put would make the retry skip the
    // (now-true) branch and persist `sandboxRuntimeSuspended: true` with NO
    // sandbox-block key written — and there is no `/init` restamp for sandbox, so
    // the over-budget account would serve sandbox traffic unblocked (fail-open).
    const { counter, kv, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 31 * 3600, // already over solo's 30h
    });

    let failNextPut = true;
    const realPut = kv.put;
    kv.put = async (key: string, value: string) => {
      if (key.startsWith('sandbox-block:') && failNextPut) {
        failNextPut = false;
        throw new Error('transient KV put failure');
      }
      return realPut(key, value);
    };

    const event: UsageEvent = {
      projectId: 'p1',
      userId: 'u1',
      slug: 's1',
      requests: 0,
      responseBytes: 0,
    };
    // First attempt fails mid-suspend; the latch must NOT persist as suspended.
    await expect(counter.fetch(recordRequest([event], 'u1', 'solo'))).rejects.toThrow(
      'transient KV put failure',
    );

    // Retry (put now works) re-enters the sandbox-suspend branch and writes the block.
    const res = await counter.fetch(recordRequest([event], 'u1', 'solo'));
    expect(res.status).toBe(200);

    expect(kv.store.get('sandbox-block:u1')).toBe('1');
    expect((storage.data.get('state') as CounterState).sandboxRuntimeSuspended).toBe(true);
  });

  it('bills only the unrecorded suffix of overlapping lease intervals', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const interval = (from: number, through: number): UsageEvent => ({
      projectId: 'p1',
      userId: 'u1',
      slug: 's1',
      requests: 0,
      responseBytes: 0,
      sandboxInstanceId: 'lease-1',
      sandboxMeteredFrom: from,
      sandboxMeteredThrough: through,
    });

    await counter.fetch(recordRequest([interval(intervalStart, intervalStart + 30_000)], 'u1'));
    // Same persisted start with a later end models queue publish succeeding
    // before the lease counter's state write fails and gets retried.
    await counter.fetch(recordRequest([interval(intervalStart, intervalStart + 45_000)], 'u1'));
    await counter.fetch(recordRequest([interval(intervalStart, intervalStart + 30_000)], 'u1'));

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(45);
    expect(Array.from(storedWatermarks(storage).values())).toEqual([intervalStart + 45_000]);
  });

  it('retains lease watermarks across rollover so delayed prior-period envelopes add nothing', async () => {
    const boundary = Math.floor(Date.now() / 1000) * 1000;
    const boundaryIso = new Date(boundary).toISOString();
    const { counter, storage } = makeCounter({
      plan: 'pro',
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    const interval = (from: number, through: number): UsageEvent => ({
      projectId: 'p1',
      userId: 'u1',
      slug: 's1',
      requests: 0,
      responseBytes: 0,
      sandboxInstanceId: 'lease-rollover',
      sandboxMeteredFrom: from,
      sandboxMeteredThrough: through,
    });

    const old = interval(boundary - 30_000, boundary);
    await counter.fetch(recordRequest([old], 'u1'));
    await counter.fetch(rolloverRequest(boundaryIso, 'pro', 'u1'));
    await counter.fetch(recordRequest([old], 'u1'));
    await counter.fetch(recordRequest([interval(boundary, boundary + 20_000)], 'u1'));

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(20);
  });
});

describe('UsageCounter.handleRollover — sandbox', () => {
  beforeEach(() => {
    dbCalls.suspend.length = 0;
    dbCalls.unsuspendIfReason.length = 0;
  });

  it('resets totalSandboxSeconds, clears flag, deletes KV, and calls unsuspendUserIfReason', async () => {
    const { counter, kv, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600,
      sandboxRuntimeSuspended: true,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    // Seed the KV key as if it had been written by the previous period's suspension
    kv.store.set('sandbox-block:u1', '1');

    const res = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'solo', 'u1'));
    const body = await res.json<{ rolled: boolean }>();
    expect(body.rolled).toBe(true);

    // KV deleted
    expect(kv.store.has('sandbox-block:u1')).toBe(false);
    expect(kv.calls).toContainEqual(['delete', 'sandbox-block:u1']);

    // DB unsuspension called
    expect(dbCalls.unsuspendIfReason).toContainEqual({
      id: 'u1',
      reason: 'sandbox_runtime_exceeded',
    });

    // State reset
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(0);
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('deletes the projectId-keyed ai-block KV keys on rollover when AI was suspended', async () => {
    const { counter, kv } = makeCounter({
      plan: 'free',
      aiSuspended: true,
      projectSlugs: { p1: 's1', p2: 's2' },
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    kv.store.set('ai-block:p1', '1');
    kv.store.set('ai-block:p2', '1');

    await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'free', 'u1'));

    // Without this, the alarm never clears them (it needs aiSuspended still true,
    // and returns early for unlimited-AI plans), so the proxy keeps 429ing AI.
    expect(kv.store.has('ai-block:p1')).toBe(false);
    expect(kv.store.has('ai-block:p2')).toBe(false);
  });

  it('is retry-safe when an ai-block delete fails mid-rollover (no short-circuit, no stranded keys)', async () => {
    // The rollover runs all external cleanup BEFORE mutating the cached
    // state. getState() caches and returns the same object on a retry, and the
    // rollover guard keys on billingPeriodStart — so mutating it before a throwing
    // delete would make the retry short-circuit as `rolled: false` and strand the
    // remaining ai-block keys.
    const { counter, kv, storage } = makeCounter({
      plan: 'free',
      aiSuspended: true,
      projectSlugs: { p1: 's1', p2: 's2' },
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    kv.store.set('ai-block:p1', '1');
    kv.store.set('ai-block:p2', '1');

    let failNextDelete = true;
    const realDelete = kv.delete;
    kv.delete = async (key: string) => {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error('transient KV delete failure');
      }
      return realDelete(key);
    };

    // First attempt fails mid-cleanup; billingPeriodStart must NOT be persisted.
    await expect(
      counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'free', 'u1')),
    ).rejects.toThrow('transient KV delete failure');
    expect((storage.data.get('state') as CounterState).billingPeriodStart).toBe(
      '2026-01-01T00:00:00Z',
    );

    // Retry re-enters the rollover (guard still sees the old period) and finishes.
    const res = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'free', 'u1'));
    const body = await res.json<{ rolled: boolean }>();
    expect(body.rolled).toBe(true);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.billingPeriodStart).toBe('2026-02-01T00:00:00Z');
    expect(persisted.aiSuspended).toBe(false);
    expect(kv.store.has('ai-block:p1')).toBe(false);
    expect(kv.store.has('ai-block:p2')).toBe(false);
  });

  it('skips sandbox cleanup when not previously suspended', async () => {
    const { counter, kv } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 500,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    const res = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'solo', 'u1'));
    expect(res.status).toBe(200);

    // No KV delete and no DB unsuspend
    expect(
      kv.calls.find(([op, key]) => op === 'delete' && key === 'sandbox-block:u1'),
    ).toBeUndefined();
    expect(dbCalls.unsuspendIfReason).toEqual([]);
  });

  it('no-op when billingPeriodStart unchanged', async () => {
    const { counter, kv } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600,
      sandboxRuntimeSuspended: true,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    kv.store.set('sandbox-block:u1', '1');

    const res = await counter.fetch(rolloverRequest('2026-01-01T00:00:00Z', 'solo', 'u1'));
    const body = await res.json<{ rolled: boolean }>();
    expect(body.rolled).toBe(false);
    expect(kv.store.has('sandbox-block:u1')).toBe(true); // untouched
    expect(dbCalls.unsuspendIfReason).toEqual([]);
  });
});

describe('UsageCounter.handleReevaluateSandbox', () => {
  beforeEach(() => {
    dbCalls.suspend.length = 0;
    dbCalls.unsuspendIfReason.length = 0;
  });

  function reevaluateRequest(plan: string): Request {
    return new Request('https://do/reevaluate-sandbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
  }

  it('clears aiSuspended and deletes ai-block keys (capped→unlimited-AI upgrade the alarm never reaches)', async () => {
    const { counter, kv, storage } = makeCounter({
      plan: 'free',
      aiSuspended: true,
      projectSlugs: { p1: 's1' },
    });
    kv.store.set('ai-block:p1', '1');

    await counter.fetch(reevaluateRequest('sponsored'));

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.aiSuspended).toBe(false);
    expect(kv.store.has('ai-block:p1')).toBe(false);
  });

  it('is retry-safe when an ai-block delete fails mid-cleanup (latch stays set until all keys gone)', async () => {
    // The cleanup deletes the ai-block keys BEFORE flipping the cached
    // `aiSuspended` latch. getState() caches and returns the same object on the
    // retry, so flipping first then throwing mid-delete would make the retry skip
    // the (now-false) branch and persist `aiSuspended: false` with keys stranded.
    const { counter, kv, storage } = makeCounter({
      plan: 'free',
      aiSuspended: true,
      projectSlugs: { p1: 's1', p2: 's2' },
    });
    kv.store.set('ai-block:p1', '1');
    kv.store.set('ai-block:p2', '1');

    // First delete throws (transient KV failure), then deletes work normally.
    let failNextDelete = true;
    const realDelete = kv.delete;
    kv.delete = async (key: string) => {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error('transient KV delete failure');
      }
      return realDelete(key);
    };

    // First attempt fails mid-cleanup; the latch must NOT be persisted false.
    await expect(counter.fetch(reevaluateRequest('sponsored'))).rejects.toThrow(
      'transient KV delete failure',
    );

    // Retry (deletes now succeed) re-enters the branch and finishes the cleanup.
    const res = await counter.fetch(reevaluateRequest('sponsored'));
    expect(res.status).toBe(200);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.aiSuspended).toBe(false);
    expect(kv.store.has('ai-block:p1')).toBe(false);
    expect(kv.store.has('ai-block:p2')).toBe(false);
  });

  it('also clears the requestsSuspended latch (plan change optimistically lifts BOTH usage latches)', async () => {
    // A capped user request-suspended last period, upgraded via the admin plan
    // change. The latch must drop too, or the next `/init` re-stamps the routes.
    const { counter, storage } = makeCounter({
      plan: 'solo',
      requestsSuspended: true,
      sandboxRuntimeSuspended: true,
    });

    await counter.fetch(reevaluateRequest('pro'));

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.requestsSuspended).toBe(false);
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('clears sandboxRuntimeSuspended and updates plan when upgrade lifts the limit', async () => {
    // Was suspended on solo (30h). Upgrade to pro (200h). totalSandboxSeconds is below pro's limit.
    const { counter, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 30 * 3600,
      sandboxRuntimeSuspended: true,
    });

    const res = await counter.fetch(reevaluateRequest('pro'));
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.plan).toBe('pro');
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('clears the flag for unlimited plans (sponsored) regardless of total', async () => {
    const { counter, storage } = makeCounter({
      plan: 'solo',
      totalSandboxSeconds: 1_000_000,
      sandboxRuntimeSuspended: true,
    });

    await counter.fetch(reevaluateRequest('sponsored'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.plan).toBe('sponsored');
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
  });

  it('still clears the in-memory flag when usage exceeds the new plan (next handleRecord re-suspends)', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'solo' } as never);
    // On pro (200h), suspended. Downgrade to solo (30h) while usage is between the two.
    // The DO clears the flag optimistically; the next handleRecord re-evaluates and re-suspends
    // (writing KV + DB).
    const { counter, storage, kv } = makeCounter({
      plan: 'pro',
      totalSandboxSeconds: 100 * 3600,
      sandboxRuntimeSuspended: true,
    });

    await counter.fetch(reevaluateRequest('solo'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.plan).toBe('solo');
    expect(persisted.sandboxRuntimeSuspended).toBe(false);

    // Now simulate the next batch — even a zero-second event triggers re-evaluation
    // because totalSandboxSeconds (100h) > solo limit (30h).
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 0, responseBytes: 0 },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'solo'));
    const reSuspended = storage.data.get('state') as CounterState;
    expect(reSuspended.sandboxRuntimeSuspended).toBe(true);
    expect(kv.store.get('sandbox-block:u1')).toBe('1');
    expect(dbCalls.suspend).toContainEqual({ id: 'u1', reason: 'sandbox_runtime_exceeded' });
  });
});

describe('UsageCounter.handleClearSuspension', () => {
  it('clears the request + sandbox suspension latches, leaving AI and counters intact', async () => {
    const { counter, storage } = makeCounter({
      plan: 'pro',
      totalRequests: 999,
      requestsSuspended: true,
      sandboxRuntimeSuspended: true,
      aiSuspended: true,
    });

    const res = await counter.fetch(new Request('https://do/clear-suspension', { method: 'POST' }));
    expect(res.status).toBe(200);

    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.requestsSuspended).toBe(false);
    expect(persisted.sandboxRuntimeSuspended).toBe(false);
    // AI self-heals via the alarm when usage drops; the admin unsuspend does not touch it.
    expect(persisted.aiSuspended).toBe(true);
    // Counters are untouched — this is a latch reset, not a billing rollover.
    expect(persisted.totalRequests).toBe(999);
  });
});

describe('UsageCounter.handleRecord — request suspension fans out to custom domains', () => {
  beforeEach(async () => {
    const db = await import('../../src/db.ts');
    vi.mocked(db.getDomainsByProjectIds).mockReset();
    vi.mocked(db.getDomainsByProjectIds).mockResolvedValue(new Map());
  });

  it('stamps suspended on the slug AND active domain routes when crossing the request cap', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'free' } as never);
    // free.requestsPerMonth = 3_000_000
    const { counter, kv } = makeCounter({ plan: 'free', totalRequests: 3_000_000 });
    // Seed the routes a deploy publisher would have written for this project.
    kv.store.set('s1', JSON.stringify({ workerName: 'w', projectId: 'p1' }));
    kv.store.set('domain:custom.com', JSON.stringify({ workerName: 'w', projectId: 'p1' }));

    const db = await import('../../src/db.ts');
    vi.mocked(db.getDomainsByProjectIds).mockResolvedValue(
      new Map([['p1', [{ project_id: 'p1', hostname: 'custom.com', status: 'active' }]]]) as never,
    );

    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 0 },
    ];
    const res = await counter.fetch(recordRequest(events, 'u1', 'free'));
    const body = await res.json<{ suspended: boolean }>();
    expect(body.suspended).toBe(true);

    expect(JSON.parse(kv.store.get('s1')!).suspended).toBe('requests_exceeded');
    expect(JSON.parse(kv.store.get('domain:custom.com')!).suspended).toBe('requests_exceeded');
  });

  it('restamps a request suspension overwritten between its edge and account writes', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'free' } as never);
    const { counter, kv } = makeCounter({ plan: 'free', totalRequests: 3_000_000 });
    const route = { workerName: 'w', projectId: 'p1', userId: 'u1' };
    kv.store.set('s1', JSON.stringify(route));
    const realPut = kv.put;
    let suspensionWrites = 0;
    kv.put = async (key, value) => {
      await realPut(key, value);
      if (key === 's1' && JSON.parse(value).suspended === 'requests_exceeded') {
        suspensionWrites += 1;
        if (suspensionWrites === 1) {
          // A transfer republish read the old user row and landed after the
          // edge-first stamp but before suspendUser settled.
          kv.store.set('s1', JSON.stringify(route));
        }
      }
    };

    await counter.fetch(
      recordRequest(
        [{ projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 0 }],
        'u1',
        'free',
      ),
    );

    expect(suspensionWrites).toBe(2);
    expect(JSON.parse(kv.store.get('s1')!).suspended).toBe('requests_exceeded');
  });

  it('does NOT downgrade an existing admin suspension on the route when crossing the request cap', async () => {
    const { counter, kv } = makeCounter({ plan: 'free', totalRequests: 3_000_000 });
    // An admin already suspended this user — the route carries `admin_suspended`.
    kv.store.set(
      's1',
      JSON.stringify({ workerName: 'w', projectId: 'p1', suspended: 'admin_suspended' }),
    );

    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 0 },
    ];
    await counter.fetch(recordRequest(events, 'u1', 'free'));

    // The admin reason outranks the usage reason — the usage suspend must not
    // overwrite it, or the next admin unsuspend would silently un-block.
    expect(JSON.parse(kv.store.get('s1')!).suspended).toBe('admin_suspended');
  });

  it('does not suspend a project transferred after the counter ownership precheck', async () => {
    vi.mocked(getProjectsByIds)
      .mockResolvedValueOnce([{ id: 'p1', user_id: 'u1', slug: 's1' } as never])
      .mockResolvedValueOnce([{ id: 'p1', user_id: 'new-owner', slug: 's1' } as never]);
    vi.mocked(getProject).mockResolvedValueOnce({
      id: 'p1',
      user_id: 'new-owner',
      slug: 's1',
    } as never);
    const { counter, kv } = makeCounter({ plan: 'free', totalRequests: 3_000_000 });
    kv.store.set('s1', JSON.stringify({ workerName: 'w', projectId: 'p1', userId: 'new-owner' }));

    await counter.fetch(
      recordRequest(
        [{ projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 0 }],
        'u1',
        'free',
      ),
    );

    expect(JSON.parse(kv.store.get('s1')!)).toEqual({
      workerName: 'w',
      projectId: 'p1',
      userId: 'new-owner',
    });
  });
});

describe('UsageCounter.handleRollover — request latch in response', () => {
  it('returns the post-rollover request latch (false) so the scheduler can reconcile KV', async () => {
    const { counter } = makeCounter({
      plan: 'solo',
      totalRequests: 999_999_999,
      requestsSuspended: true,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    const res = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'solo', 'u1'));
    const body = await res.json<{ rolled: boolean; requestsSuspended: boolean }>();
    expect(body.rolled).toBe(true);
    expect(body.requestsSuspended).toBe(false);
  });

  it('returns the current request latch on a no-op (unchanged period) so a stale marker still reconciles', async () => {
    const { counter } = makeCounter({
      plan: 'solo',
      requestsSuspended: false,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
    const res = await counter.fetch(rolloverRequest('2026-01-01T00:00:00Z', 'solo', 'u1'));
    const body = await res.json<{ rolled: boolean; requestsSuspended: boolean }>();
    expect(body.rolled).toBe(false);
    expect(body.requestsSuspended).toBe(false);
  });
});

describe('UsageCounter ownership changes', () => {
  beforeEach(() => {
    dbCalls.unsuspendIfReason.length = 0;
    vi.mocked(queryProjectAiUsage).mockReset().mockResolvedValue({ neurons: 0 });
    vi.mocked(getProjectOwnershipPeriodsByProjectIds).mockReset().mockResolvedValue([]);
    vi.mocked(getProject)
      .mockReset()
      .mockImplementation(async (_db, id) => ({ id, user_id: 'u1', slug: id }) as never);
    vi.mocked(getProjectsByIds)
      .mockReset()
      .mockImplementation(async (_db, ids) =>
        ids.map((id) => ({ id, user_id: 'u1', slug: id }) as never),
      );
    vi.mocked(getUser)
      .mockReset()
      .mockImplementation(
        async (_db, id) =>
          ({
            id,
            plan: 'pro',
          }) as never,
      );
  });

  it('bills a delayed former-owner event without reattaching the project', async () => {
    const { counter, storage } = makeCounter({ plan: 'solo' });
    await counter.fetch(
      recordRequest(
        [
          {
            projectId: 'transferred',
            userId: 'former-owner',
            slug: 'app',
            requests: 1,
            responseBytes: 10,
            currentOwner: false,
          },
        ],
        'former-owner',
      ),
    );

    expect(storage.data.get('state')).toMatchObject({
      totalRequests: 1,
      projectSlugs: {},
    });
  });

  it('does not reattach from a stale current-owner queue snapshot after transfer', async () => {
    vi.mocked(getProjectsByIds).mockResolvedValueOnce([
      { id: 'transferred', user_id: 'new-owner', slug: 'app' } as never,
    ]);
    const { counter, storage } = makeCounter({
      ownerUserId: 'former-owner',
      plan: 'solo',
    });

    await counter.fetch(
      recordRequest(
        [
          {
            projectId: 'transferred',
            userId: 'former-owner',
            slug: 'app',
            requests: 1,
            responseBytes: 10,
            currentOwner: true,
            ownershipStartedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        'former-owner',
      ),
    );

    expect(storage.data.get('state')).toMatchObject({
      totalRequests: 1,
      projectSlugs: {},
      projectOwnershipStarts: {},
    });
  });

  it('preserves retained ownership boundaries from a legacy init payload', async () => {
    const retainedStart = '2026-02-01T00:00:00.000Z';
    const { counter, storage } = makeCounter({
      ownerUserId: 'u1',
      projectSlugs: { retained: 'retained-app', removed: 'removed-app' },
      projectOwnershipStarts: {
        retained: retainedStart,
        removed: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await counter.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({
          plan: 'solo',
          billingPeriodStart: '2026-01-01T00:00:00.000Z',
          projectSlugs: { retained: 'retained-app' },
          userId: 'u1',
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(storage.data.get('state')).toMatchObject({
      projectSlugs: { retained: 'retained-app' },
      projectOwnershipStarts: { retained: retainedStart },
    });
  });

  it('detaches and attaches a project without erasing already billed AI usage', async () => {
    const { counter, storage, kv } = makeCounter({
      plan: 'solo',
      projectSlugs: { transferred: 'app' },
      projectNeurons: { transferred: 42 },
    });
    const detached = await counter.fetch(
      new Request('https://do/detach-project', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'transferred' }),
      }),
    );
    expect(detached.ok).toBe(true);
    expect(storage.data.get('state')).toMatchObject({
      projectSlugs: {},
      projectNeurons: {},
      historicalNeurons: 42,
    });

    const startedAt = '2026-06-01T00:00:00.000Z';
    const attached = await counter.fetch(
      new Request('https://do/attach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'next',
          slug: 'next-app',
          billingPeriodStart: '2026-01-01T00:00:00Z',
          ownershipStartedAt: startedAt,
          // Simulate the transfer caller's pre-plan-change snapshot. The DO
          // must use PostgreSQL's current `pro` plan from the getUser mock.
          plan: 'free',
        }),
      }),
    );
    expect(attached.ok).toBe(true);
    expect(storage.data.get('state')).toMatchObject({
      plan: 'pro',
      projectSlugs: { next: 'next-app' },
      projectOwnershipStarts: { next: startedAt },
      historicalNeurons: 42,
    });
    expect(kv.calls).toContainEqual(['delete', 'ai-block:next']);
    expect(await storage.getAlarm()).toEqual(expect.any(Number));
  });

  it('advances a stale recipient period before attaching a transferred project', async () => {
    const billingPeriodStart = '2026-02-01T00:00:00.000Z';
    const ownershipStartedAt = '2026-02-02T00:00:00.000Z';
    const { counter, kv, storage } = makeCounter({
      ownerUserId: 'u1',
      plan: 'solo',
      billingPeriodStart: '2026-01-01T00:00:00.000Z',
      billingPeriodInitialized: true,
      totalRequests: 10_000_000,
      totalNeurons: 100_001,
      totalSandboxSeconds: 30 * 3_600,
      requestsSuspended: true,
      aiSuspended: true,
      sandboxRuntimeSuspended: true,
      projectSlugs: { retained: 'retained-app' },
      projectOwnershipStarts: { retained: '2026-01-01T00:00:00.000Z' },
      projectNeurons: { retained: 100_001 },
      historicalNeurons: 17,
    });
    kv.store.set(
      'retained-app',
      JSON.stringify({
        workerName: 'retained-worker',
        projectId: 'retained',
        userId: 'u1',
        suspended: 'requests_exceeded',
      }),
    );
    kv.store.set(
      'next-app',
      JSON.stringify({ workerName: 'next-worker', projectId: 'next', userId: 'u1' }),
    );
    kv.store.set('ai-block:retained', '1');
    kv.store.set('ai-block:next', '1');
    kv.store.set('sandbox-block:u1', '1');

    const response = await counter.fetch(
      new Request('https://do/attach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'next',
          slug: 'next-app',
          billingPeriodStart,
          ownershipStartedAt,
          userId: 'u1',
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(dbCalls.unsuspendIfReason).toEqual(
      expect.arrayContaining([
        { id: 'u1', reason: 'requests_exceeded' },
        { id: 'u1', reason: 'sandbox_runtime_exceeded' },
      ]),
    );
    expect(JSON.parse(kv.store.get('retained-app')!)).not.toHaveProperty('suspended');
    expect(JSON.parse(kv.store.get('next-app')!)).not.toHaveProperty('suspended');
    expect(kv.store.has('ai-block:retained')).toBe(false);
    expect(kv.store.has('ai-block:next')).toBe(false);
    expect(kv.store.has('sandbox-block:u1')).toBe(false);
    expect(storage.data.get('state')).toMatchObject({
      billingPeriodStart,
      plan: 'pro',
      totalRequests: 0,
      totalNeurons: 0,
      totalSandboxSeconds: 0,
      requestsSuspended: false,
      aiSuspended: false,
      sandboxRuntimeSuspended: false,
      projectSlugs: { retained: 'retained-app', next: 'next-app' },
      projectOwnershipStarts: {
        retained: '2026-01-01T00:00:00.000Z',
        next: ownershipStartedAt,
      },
      projectNeurons: {},
      historicalNeurons: 0,
    });
    expect(await storage.getAlarm()).toEqual(expect.any(Number));
  });

  it('does not attach a project after deletion has started', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({
      id: 'deleting',
      user_id: 'u1',
      slug: 'app',
      status: 'deleting',
    } as never);
    const { counter, storage } = makeCounter();

    const response = await counter.fetch(
      new Request('https://do/attach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'deleting',
          slug: 'app',
          ownershipStartedAt: '2026-01-01T00:00:00.000Z',
          userId: 'u1',
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(storage.data.get('state')).toBeUndefined();
  });

  it('rejects a stale attach before advancing the former owner billing period', async () => {
    vi.mocked(getProject).mockResolvedValueOnce({
      id: 'transferred',
      user_id: 'new-owner',
      slug: 'app',
      status: 'active',
    } as never);
    const { counter, kv, storage } = makeCounter({
      ownerUserId: 'former-owner',
      plan: 'solo',
      billingPeriodStart: '2026-01-01T00:00:00.000Z',
      billingPeriodInitialized: true,
      totalRequests: 10,
      aiSuspended: true,
      projectSlugs: { retained: 'retained-app' },
    });
    kv.store.set('ai-block:retained', '1');

    const response = await counter.fetch(
      new Request('https://do/attach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'transferred',
          slug: 'app',
          billingPeriodStart: '2026-02-01T00:00:00.000Z',
          ownershipStartedAt: '2026-02-02T00:00:00.000Z',
          userId: 'former-owner',
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(kv.store.get('ai-block:retained')).toBe('1');
    expect(storage.data.get('state')).toMatchObject({
      billingPeriodStart: '2026-01-01T00:00:00.000Z',
      totalRequests: 10,
      aiSuspended: true,
      projectSlugs: { retained: 'retained-app' },
    });
    expect(dbCalls.unsuspendIfReason).toEqual([]);
  });

  it('reconciles the complete pre-transfer AI window and resamples it idempotently', async () => {
    const ownershipStartedAt = '2026-02-01T00:00:00.000Z';
    const ownershipEndedAt = '2026-03-01T00:00:00.000Z';
    const extendedOwnershipEndedAt = '2026-03-02T00:00:00.000Z';
    vi.mocked(queryProjectAiUsage)
      .mockResolvedValueOnce({ neurons: 57 })
      .mockResolvedValueOnce({ neurons: 61 })
      .mockResolvedValueOnce({ neurons: 63 });
    const { counter, storage } = makeCounter({
      ownerUserId: 'former-owner',
      plan: 'solo',
      billingPeriodStart: '2026-01-01T00:00:00.000Z',
      totalNeurons: 42,
      projectSlugs: { transferred: 'app' },
      projectOwnershipStarts: { transferred: ownershipStartedAt },
      projectNeurons: { transferred: 42 },
    });
    const detachRequest = (endedAt = ownershipEndedAt) =>
      new Request('https://do/detach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'transferred',
          userId: 'former-owner',
          ownershipStartedAt,
          ownershipEndedAt: endedAt,
        }),
      });

    expect((await counter.fetch(detachRequest())).ok).toBe(true);
    expect(queryProjectAiUsage).not.toHaveBeenCalled();
    expect(storage.data.get('state')).toMatchObject({ totalNeurons: 42, projectSlugs: {} });
    await counter.alarm();
    expect(queryProjectAiUsage).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'transferred',
      new Date(ownershipStartedAt),
      new Date(ownershipEndedAt),
      true,
    );
    expect(storage.data.get('state')).toMatchObject({
      totalNeurons: 57,
      projectSlugs: {},
      projectNeurons: {},
      historicalNeurons: 0,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, ownershipEndedAt])]: {
          projectId: 'transferred',
          ownershipStartedAt,
          ownershipEndedAt,
          neurons: 57,
        },
      },
    });

    expect((await counter.fetch(detachRequest(extendedOwnershipEndedAt))).ok).toBe(true);
    await counter.alarm();
    expect(queryProjectAiUsage).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'transferred',
      new Date(ownershipStartedAt),
      new Date(extendedOwnershipEndedAt),
      true,
    );
    expect(storage.data.get('state')).toMatchObject({
      totalNeurons: 61,
      historicalNeurons: 0,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, extendedOwnershipEndedAt])]: {
          neurons: 61,
        },
      },
    });

    expect((await counter.fetch(detachRequest())).ok).toBe(true);
    await counter.alarm();
    expect(queryProjectAiUsage).toHaveBeenLastCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'transferred',
      new Date(ownershipStartedAt),
      new Date(extendedOwnershipEndedAt),
      true,
    );
    expect(storage.data.get('state')).toMatchObject({
      totalNeurons: 63,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, extendedOwnershipEndedAt])]: {
          neurons: 63,
        },
      },
    });
    expect(
      Object.keys((storage.data.get('state') as CounterState).historicalAiWindows),
    ).toHaveLength(1);
  });

  it('initializes a fresh counter from the former owner billing window before detaching', async () => {
    const billingPeriodStart = '2026-01-15T00:00:00.000Z';
    const ownershipStartedAt = '2026-02-01T00:00:00.000Z';
    const ownershipEndedAt = '2026-03-01T00:00:00.000Z';
    vi.mocked(getUser).mockResolvedValue({ id: 'former-owner', plan: 'custom' } as never);
    vi.mocked(queryProjectAiUsage).mockResolvedValueOnce({ neurons: 57 });
    const { counter, storage } = makeCounter();

    const response = await counter.fetch(
      new Request('https://do/detach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'transferred',
          userId: 'former-owner',
          billingPeriodStart,
          ownershipStartedAt,
          ownershipEndedAt,
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(queryProjectAiUsage).not.toHaveBeenCalled();
    await counter.alarm();
    expect(queryProjectAiUsage).toHaveBeenCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'transferred',
      new Date(ownershipStartedAt),
      new Date(ownershipEndedAt),
      true,
    );
    expect(storage.data.get('state')).toMatchObject({
      billingPeriodStart,
      billingPeriodInitialized: true,
      plan: 'custom',
      totalNeurons: 57,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, ownershipEndedAt])]: {
          neurons: 57,
        },
      },
    });
  });

  it('advances an initialized counter before retaining a current-period transfer window', async () => {
    const billingPeriodStart = '2026-02-01T00:00:00.000Z';
    const ownershipStartedAt = '2026-01-15T00:00:00.000Z';
    const ownershipEndedAt = '2026-03-01T00:00:00.000Z';
    vi.mocked(queryProjectAiUsage).mockResolvedValueOnce({ neurons: 57 });
    vi.mocked(getProjectsByIds).mockResolvedValueOnce([
      { id: 'transferred', user_id: 'new-owner', slug: 'app' } as never,
      { id: 'retained', user_id: 'u1', slug: 'retained-app' } as never,
    ]);
    const { counter, kv, storage } = makeCounter({
      ownerUserId: 'u1',
      plan: 'solo',
      billingPeriodStart: '2026-01-01T00:00:00.000Z',
      billingPeriodInitialized: true,
      totalRequests: 10_000_000,
      requestsSuspended: true,
      totalNeurons: 42,
      historicalNeurons: 11,
      projectSlugs: { transferred: 'app', retained: 'retained-app' },
      projectOwnershipStarts: {
        transferred: ownershipStartedAt,
        retained: '2026-01-20T00:00:00.000Z',
      },
      projectNeurons: { transferred: 31 },
    });
    kv.store.set(
      'retained-app',
      JSON.stringify({
        workerName: 'retained-worker',
        projectId: 'retained',
        userId: 'u1',
        suspended: 'requests_exceeded',
      }),
    );

    const response = await counter.fetch(
      new Request('https://do/detach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'transferred',
          userId: 'u1',
          billingPeriodStart,
          ownershipStartedAt,
          ownershipEndedAt,
        }),
      }),
    );

    expect(response.ok).toBe(true);
    expect(queryProjectAiUsage).not.toHaveBeenCalled();
    await counter.alarm();
    expect(dbCalls.unsuspendIfReason).toContainEqual({
      id: 'u1',
      reason: 'requests_exceeded',
    });
    expect(JSON.parse(kv.store.get('retained-app')!)).not.toHaveProperty('suspended');
    expect(queryProjectAiUsage).toHaveBeenCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'transferred',
      new Date(billingPeriodStart),
      new Date(ownershipEndedAt),
      true,
    );
    expect(storage.data.get('state')).toMatchObject({
      billingPeriodStart,
      totalRequests: 0,
      requestsSuspended: false,
      totalNeurons: 57,
      historicalNeurons: 0,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, ownershipEndedAt])]: {
          neurons: 57,
        },
      },
    });

    const rollover = await counter.fetch(rolloverRequest(billingPeriodStart, 'solo', 'u1'));
    expect(await rollover.json()).toMatchObject({ rolled: false });
    expect(storage.data.get('state')).toMatchObject({
      totalNeurons: 57,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, ownershipEndedAt])]: {
          neurons: 57,
        },
      },
    });
  });

  it('persists a detached window and retries reconciliation without losing its last sample', async () => {
    vi.mocked(queryProjectAiUsage).mockRejectedValue(new Error('analytics unavailable'));
    const { counter, storage, env } = makeCounter({
      ownerUserId: 'former-owner',
      plan: 'solo',
      totalNeurons: 42,
      projectSlugs: { transferred: 'app' },
      projectOwnershipStarts: { transferred: '2026-02-01T00:00:00.000Z' },
      projectNeurons: { transferred: 42 },
    });
    const response = await counter.fetch(
      new Request('https://do/detach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'transferred',
          userId: 'former-owner',
          ownershipStartedAt: '2026-02-01T00:00:00.000Z',
          ownershipEndedAt: '2026-03-01T00:00:00.000Z',
        }),
      }),
    );
    expect(response.ok).toBe(true);
    expect(queryProjectAiUsage).not.toHaveBeenCalled();
    const saved = structuredClone(storage.data.get('state'));
    expect(saved).toMatchObject({ totalNeurons: 42, projectSlugs: {}, projectNeurons: {} });
    expect(Object.values((saved as CounterState).historicalAiWindows)).toEqual([
      {
        projectId: 'transferred',
        ownershipStartedAt: '2026-02-01T00:00:00.000Z',
        ownershipEndedAt: '2026-03-01T00:00:00.000Z',
        neurons: 42,
      },
    ]);
    expect(await storage.getAlarm()).toEqual(expect.any(Number));
    const restarted = new UsageCounter({ storage } as never, env as never);
    Object.assign(restarted, { ctx: { storage }, env });
    // Exhaust the native retry count: the durable schedule must still survive.
    for (let attempt = 0; attempt < 7; attempt++) {
      await storage.setAlarm(0);
      await expect(restarted.alarm()).rejects.toThrow('analytics unavailable');
      expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
      expect(storage.data.get('state')).toEqual(saved);
    }
    vi.mocked(queryProjectAiUsage).mockResolvedValue({ neurons: 57 });
    await restarted.alarm();
    expect(storage.data.get('state')).toMatchObject({ totalNeurons: 57, projectSlugs: {} });
  });

  it('commits the detached window and reconciliation alarm together before acknowledging', async () => {
    const { counter, storage } = makeCounter({
      totalNeurons: 42,
      projectNeurons: { transferred: 42 },
      projectSlugs: { transferred: 'app' },
      projectOwnershipStarts: { transferred: '2026-02-01T00:00:00.000Z' },
    });
    const before = structuredClone(storage.data.get('state'));
    const request = () =>
      new Request('https://do/detach-project', {
        method: 'POST',
        body: JSON.stringify({
          projectId: 'transferred',
          ownershipEndedAt: '2026-03-01T00:00:00.000Z',
        }),
      });
    storage.failNextCommit();
    await expect(counter.fetch(request())).rejects.toThrow('transaction commit failed');
    expect(storage.data.get('state')).toEqual(before);
    expect(await storage.getAlarm()).toBeNull();
    expect((await counter.fetch(request())).ok).toBe(true);
    expect(storage.data.get('state')).toMatchObject({ totalNeurons: 42, projectSlugs: {} });
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(queryProjectAiUsage).not.toHaveBeenCalled();
  });

  it('queries AI only from the current ownership boundary', async () => {
    const ownershipStartedAt = '2026-02-01T00:00:00.000Z';
    const { counter } = makeCounter({
      plan: 'solo',
      billingPeriodStart: '2026-01-01T00:00:00.000Z',
      projectSlugs: { p1: 'app' },
      projectOwnershipStarts: { p1: ownershipStartedAt },
    });

    await counter.alarm();

    expect(queryProjectAiUsage).toHaveBeenCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'p1',
      new Date(ownershipStartedAt),
    );
  });

  describe('detached window lifecycle', () => {
    const billingPeriodStart = '2026-01-01T00:00:00.000Z';
    const ownershipEndedAt = '2026-01-20T00:00:00.000Z';
    const windowKey = JSON.stringify(['deleted', billingPeriodStart, ownershipEndedAt]);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-01-22T12:00:00.000Z');
      vi.mocked(getUser).mockImplementation(
        async (_db, id) =>
          ({
            id,
            plan: 'solo',
            billing_cycle_start: billingPeriodStart,
          }) as never,
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function detachedState(overrides: Partial<CounterState> = {}): Partial<CounterState> {
      return {
        ownerUserId: 'u1',
        plan: 'solo',
        billingPeriodStart,
        totalRequests: 100,
        totalNeurons: 42,
        historicalAiWindows: {
          [windowKey]: {
            projectId: 'deleted',
            ownershipStartedAt: billingPeriodStart,
            ownershipEndedAt,
            neurons: 42,
          },
        },
        ...overrides,
      };
    }

    it.each(['solo', 'sponsored'] as const)(
      'ends %s historical reconciliation at rollover after the final project is deleted',
      async (plan) => {
        vi.mocked(getUser).mockResolvedValue({
          id: 'u1',
          plan,
          billing_cycle_start: billingPeriodStart,
        } as never);
        const { counter, storage } = makeCounter(detachedState({ plan }));
        const setAlarm = vi.spyOn(storage, 'setAlarm');
        vi.setSystemTime('2026-02-02T12:00:00.000Z');

        await counter.alarm();

        expect(queryProjectAiUsage).not.toHaveBeenCalled();
        expect(storage.data.get('state')).toMatchObject({
          billingPeriodStart: '2026-02-01T00:00:00.000Z',
          totalRequests: 0,
          totalNeurons: 0,
          historicalAiWindows: {},
          projectSlugs: {},
        });
        expect(setAlarm).not.toHaveBeenCalled();
        expect(await storage.getAlarm()).toBeNull();
      },
    );

    it('stops reconciliation when the account has been deleted', async () => {
      vi.mocked(getUser).mockResolvedValue(null);
      const { counter, storage } = makeCounter(detachedState());
      await storage.setAlarm(Date.now() + 60_000);
      const before = structuredClone(storage.data.get('state'));
      const setAlarm = vi.spyOn(storage, 'setAlarm');

      await counter.alarm();

      expect(queryProjectAiUsage).not.toHaveBeenCalled();
      expect(storage.data.get('state')).toEqual(before);
      expect(setAlarm).not.toHaveBeenCalled();
      expect(await storage.getAlarm()).toBeNull();
    });

    it('reconciles unlimited account history without querying or blocking active projects', async () => {
      vi.mocked(getUser).mockResolvedValue({
        id: 'u1',
        plan: 'sponsored',
        billing_cycle_start: billingPeriodStart,
      } as never);
      vi.mocked(queryProjectAiUsage).mockResolvedValue({ neurons: 57 });
      const { counter, storage, kv } = makeCounter(
        detachedState({
          projectSlugs: { active: 'active-app' },
          projectOwnershipStarts: { active: billingPeriodStart },
          projectNeurons: { active: 100 },
          totalNeurons: 142,
        }),
      );

      await counter.alarm();

      expect(queryProjectAiUsage).toHaveBeenCalledExactlyOnceWith(
        undefined,
        undefined,
        'void',
        JWT_SECRET,
        'deleted',
        new Date(billingPeriodStart),
        new Date(ownershipEndedAt),
        true,
      );
      expect(storage.data.get('state')).toMatchObject({
        plan: 'sponsored',
        totalNeurons: 157,
        projectNeurons: { active: 100 },
        aiSuspended: false,
        historicalAiWindows: { [windowKey]: { neurons: 57 } },
      });
      expect(kv.calls).toEqual([]);
      expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    });

    it('preserves an earlier alarm when detaching a project', async () => {
      const { counter, storage } = makeCounter({
        ownerUserId: 'u1',
        plan: 'solo',
        billingPeriodStart,
        totalNeurons: 42,
        projectSlugs: { deleted: 'app' },
        projectNeurons: { deleted: 42 },
        projectOwnershipStarts: { deleted: billingPeriodStart },
      });
      const earlierAlarm = Date.now() + 60_000;
      await storage.setAlarm(earlierAlarm);
      const setAlarm = vi.spyOn(storage, 'setAlarm');

      const response = await counter.fetch(
        new Request('https://do/detach-project', {
          method: 'POST',
          body: JSON.stringify({ projectId: 'deleted', ownershipEndedAt }),
        }),
      );

      expect(response.ok).toBe(true);
      expect(queryProjectAiUsage).not.toHaveBeenCalled();
      expect(await storage.getAlarm()).toBe(earlierAlarm);
      expect(setAlarm).not.toHaveBeenCalled();
      expect(storage.data.get('state')).toMatchObject({
        historicalAiWindows: { [windowKey]: { neurons: 42 } },
      });
    });

    it('clears active project suspensions while rolling over detached history', async () => {
      const { counter, storage, kv } = makeCounter(
        detachedState({
          requestsSuspended: true,
          aiSuspended: true,
          sandboxRuntimeSuspended: true,
          projectSlugs: { retained: 'retained-app' },
          projectOwnershipStarts: { retained: billingPeriodStart },
        }),
      );
      kv.store.set(
        'retained-app',
        JSON.stringify({
          workerName: 'retained-worker',
          projectId: 'retained',
          userId: 'u1',
          suspended: 'requests_exceeded',
        }),
      );
      kv.store.set('ai-block:retained', '1');
      kv.store.set('sandbox-block:u1', '1');
      vi.mocked(queryProjectAiUsage).mockResolvedValue({ neurons: 7 });
      vi.setSystemTime('2026-02-02T12:00:00.000Z');

      await counter.alarm();

      expect(queryProjectAiUsage).toHaveBeenCalledExactlyOnceWith(
        undefined,
        undefined,
        'void',
        JWT_SECRET,
        'retained',
        new Date('2026-02-01T00:00:00.000Z'),
      );
      expect(storage.data.get('state')).toMatchObject({
        billingPeriodStart: '2026-02-01T00:00:00.000Z',
        totalRequests: 0,
        totalNeurons: 7,
        historicalAiWindows: {},
        requestsSuspended: false,
        aiSuspended: false,
        sandboxRuntimeSuspended: false,
      });
      expect(JSON.parse(kv.store.get('retained-app')!)).not.toHaveProperty('suspended');
      expect(kv.store.has('ai-block:retained')).toBe(false);
      expect(kv.store.has('sandbox-block:u1')).toBe(false);
      expect(dbCalls.unsuspendIfReason).toEqual(
        expect.arrayContaining([
          { id: 'u1', reason: 'requests_exceeded' },
          { id: 'u1', reason: 'sandbox_runtime_exceeded' },
        ]),
      );
    });
  });

  it('reconciles a stale transferred project through its ownership cutoff before dropping it', async () => {
    const ownershipStartedAt = '2026-01-01T00:00:00.000Z';
    const ownershipEndedAt = '2026-02-01T00:00:00.000Z';
    vi.mocked(getProjectsByIds).mockResolvedValueOnce([
      { id: 'transferred', user_id: 'new-owner', slug: 'app' } as never,
    ]);
    vi.mocked(getProjectOwnershipPeriodsByProjectIds).mockResolvedValueOnce([
      {
        project_id: 'transferred',
        owner_user_id: 'former-owner',
        starts_at: ownershipStartedAt,
        ends_at: ownershipEndedAt,
      } as never,
    ]);
    vi.mocked(queryProjectAiUsage).mockResolvedValueOnce({ neurons: 57 });
    const { counter, storage, kv } = makeCounter({
      ownerUserId: 'former-owner',
      plan: 'solo',
      aiSuspended: true,
      projectSlugs: { transferred: 'app' },
      projectOwnershipStarts: { transferred: ownershipStartedAt },
      projectNeurons: { transferred: 42 },
    });
    kv.store.set('ai-block:transferred', '1');

    await counter.alarm();

    expect(queryProjectAiUsage).toHaveBeenCalledWith(
      undefined,
      undefined,
      'void',
      JWT_SECRET,
      'transferred',
      new Date(ownershipStartedAt),
      new Date(ownershipEndedAt),
      true,
    );
    expect(kv.store.has('ai-block:transferred')).toBe(true);
    expect(storage.data.get('state')).toMatchObject({
      totalNeurons: 57,
      projectSlugs: {},
      projectNeurons: {},
      historicalNeurons: 0,
      historicalAiWindows: {
        [JSON.stringify(['transferred', ownershipStartedAt, ownershipEndedAt])]: {
          neurons: 57,
        },
      },
    });
  });
});

describe('UsageCounter operation ordering and persistence', () => {
  beforeEach(() => {
    vi.mocked(queryProjectAiUsage).mockReset().mockResolvedValue({ neurons: 0 });
  });

  it('preserves distinct records and initialization while a suspension write is pending', async () => {
    vi.mocked(getUser)
      .mockResolvedValue({ id: 'u1', plan: 'pro' } as never)
      .mockResolvedValueOnce({ id: 'u1', plan: 'free' } as never);
    const from = Date.now() - 60_000;
    const { counter, kv, storage } = makeCounter({ plan: 'free' });
    const writing = deferred();
    const resume = deferred();
    const realPut = kv.put;
    kv.put = async (key, value) => {
      writing.resolve();
      await resume.promise;
      await realPut(key, value);
    };
    const first = counter.fetch(recordRequest([sandboxInterval(from, from + 2_000, 3)], 'u1'));
    await writing.promise;
    const initialize = counter.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({
          plan: 'pro',
          billingPeriodStart: '2026-01-01T00:00:00Z',
          projectSlugs: { p2: 's2' },
        }),
      }),
    );
    const second = counter.fetch(recordRequest([sandboxInterval(from, from + 3_000, 5)], 'u1'));
    resume.resolve();
    await Promise.all([first, initialize, second]);
    expect(storage.data.get('state')).toMatchObject({
      totalRequests: 8,
      totalSandboxSeconds: 3,
      plan: 'pro',
      projectSlugs: { p1: 's1', p2: 's2' },
    });
  });

  it('finishes an AI query before rollover and the next period record', async () => {
    const querying = deferred();
    const resume = deferred();
    vi.mocked(queryProjectAiUsage).mockImplementationOnce(async () => {
      querying.resolve();
      await resume.promise;
      return { neurons: 100_001 };
    });
    const boundary = Date.now() - 60_000;
    const { counter, storage, kv } = makeCounter({
      totalRequests: 10,
      plan: 'free',
      projectSlugs: { p1: 's1' },
    });
    const alarm = counter.alarm();
    await querying.promise;
    const rollover = counter.fetch(rolloverRequest(new Date(boundary).toISOString(), 'pro', 'u1'));
    const record = counter.fetch(
      recordRequest([sandboxInterval(boundary, boundary + 20_000, 4)], 'u1'),
    );
    resume.resolve();
    await Promise.all([alarm, rollover, record]);
    expect(storage.data.get('state')).toMatchObject({
      totalRequests: 4,
      totalNeurons: 0,
      totalSandboxSeconds: 20,
      plan: 'pro',
      billingPeriodStart: new Date(boundary).toISOString(),
      aiSuspended: false,
    });
    expect(kv.store.has('ai-block:p1')).toBe(false);
  });

  it('holds the operation queue until sibling writes settle after an external failure', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'free' } as never);
    const suspending = deferred();
    const resume = deferred();
    vi.mocked(suspendUser).mockImplementationOnce(async () => {
      suspending.resolve();
      await resume.promise;
    });
    const { counter, kv } = makeCounter({ plan: 'free' });
    kv.put = async () => {
      throw new Error('KV unavailable');
    };
    const from = Date.now() - 60_000;
    const record = counter.fetch(recordRequest([sandboxInterval(from, from + 2_000)], 'u1'));
    const failed = expect(record).rejects.toThrow('KV unavailable');
    await suspending.promise;
    let stateRead = false;
    const read = counter.fetch(new Request('https://do/state')).then(() => {
      stateRead = true;
    });
    // Let a prematurely rejected Promise.all and its queued read settle.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(stateRead).toBe(false);
    resume.resolve();
    await failed;
    await read;
    expect(stateRead).toBe(true);
  });

  it('retries a record after storage failure without duplicating requests or losing sandbox usage', async () => {
    const from = Date.now() - 60_000;
    const { counter, storage } = makeCounter({ plan: 'pro' });
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    const event = sandboxInterval(from, from + 10_000, 7);
    await expect(counter.fetch(recordRequest([event], 'u1'))).rejects.toThrow(
      'storage unavailable',
    );
    const unsaved = await counter.fetch(new Request('https://do/state'));
    expect(await unsaved.json()).toMatchObject({ totalRequests: 0, totalSandboxSeconds: 0 });
    await counter.fetch(recordRequest([event], 'u1'));
    expect(storage.data.get('state')).toMatchObject({ totalRequests: 7, totalSandboxSeconds: 10 });
  });

  it('retries rollover after storage failure without short-circuiting on the unsaved period', async () => {
    const { counter, storage, kv } = makeCounter({
      totalRequests: 20,
      plan: 'free',
      aiSuspended: true,
      projectSlugs: { p1: 's1' },
    });
    kv.store.set('ai-block:p1', '1');
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'pro', 'u1')),
    ).rejects.toThrow('storage unavailable');
    const unsaved = await counter.fetch(new Request('https://do/state'));
    expect(await unsaved.json()).toMatchObject({
      totalRequests: 20,
      billingPeriodStart: '2026-01-01T00:00:00Z',
      aiSuspended: true,
    });
    const retried = await counter.fetch(rolloverRequest('2026-02-01T00:00:00Z', 'pro', 'u1'));
    expect(await retried.json()).toMatchObject({ rolled: true });
    expect(storage.data.get('state')).toMatchObject({ totalRequests: 0, aiSuspended: false });
  });

  it('does not retain an unsaved init merge or plan change in the isolate cache', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'free' } as never);
    const { counter, storage } = makeCounter({ plan: 'free', projectSlugs: { p1: 's1' } });
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      counter.fetch(
        new Request('https://do/init', {
          method: 'POST',
          body: JSON.stringify({
            plan: 'pro',
            billingPeriodStart: '2026-02-01T00:00:00Z',
            projectSlugs: { p2: 's2' },
          }),
        }),
      ),
    ).rejects.toThrow('storage unavailable');
    await counter.fetch(recordRequest([], 'u1'));
    expect(storage.data.get('state')).toMatchObject({
      plan: 'free',
      billingPeriodStart: '2026-01-01T00:00:00Z',
      projectSlugs: { p1: 's1' },
    });
    expect((storage.data.get('state') as CounterState).projectSlugs).not.toHaveProperty('p2');
  });

  it('retries AI enforcement after a failed KV write instead of retaining its unsaved latch', async () => {
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'free' } as never);
    const { counter, kv, storage } = makeCounter({ plan: 'free', projectSlugs: { p1: 's1' } });
    vi.mocked(queryProjectAiUsage).mockResolvedValue({ neurons: 100_001 });
    vi.spyOn(kv, 'put').mockRejectedValueOnce(new Error('KV unavailable'));
    await expect(counter.alarm()).rejects.toThrow('KV unavailable');
    const unsaved = await counter.fetch(new Request('https://do/state'));
    expect(await unsaved.json()).toMatchObject({ totalNeurons: 0, aiSuspended: false });
    await counter.alarm();
    expect(kv.store.get('ai-block:p1')).toBe('1');
    expect(storage.data.get('state')).toMatchObject({ totalNeurons: 100_001, aiSuspended: true });
  });

  it('bills cumulative intervals arriving newest first only once', async () => {
    const from = Date.now() - 60_000;
    const { counter, storage } = makeCounter({ plan: 'pro' });
    await counter.fetch(recordRequest([sandboxInterval(from, from + 45_000)], 'u1'));
    await counter.fetch(recordRequest([sandboxInterval(from, from + 30_000)], 'u1'));
    await counter.fetch(recordRequest([sandboxInterval(from, from + 60_000)], 'u1'));
    expect((storage.data.get('state') as CounterState).totalSandboxSeconds).toBe(60);
  });

  it('counts both lease generations delivered out of order without billing their idle gap', async () => {
    const from = Date.now() - 120_000;
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const first = sandboxInterval(from, from + 10_000);
    const next = sandboxInterval(from + 60_000, from + 80_000);
    await counter.fetch(recordRequest([next, first], 'u1'));
    await counter.fetch(recordRequest([first, next], 'u1'));
    const persisted = storage.data.get('state') as CounterState;
    expect(persisted.totalSandboxSeconds).toBe(30);
    expect(Array.from(storedWatermarks(storage).values()).sort()).toEqual([
      from + 10_000,
      from + 80_000,
    ]);
  });
});

describe('UsageCounter durable sandbox receipts', () => {
  const now = 1_800_000_000_000;
  const prefix = 'sandbox-usage:watermark:';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rolls back counters and advanced receipts together when transaction commit fails', async () => {
    const from = now - 60_000;
    const { counter, storage } = makeCounter({ plan: 'pro' });
    await counter.fetch(recordRequest([sandboxInterval(from, from + 10_000, 2)], 'u1'));
    const committedReceipts = storedWatermarks(storage);
    storage.failNextCommit();
    await expect(
      counter.fetch(recordRequest([sandboxInterval(from, from + 20_000, 5)], 'u1')),
    ).rejects.toThrow('transaction commit failed');

    expect(storedWatermarks(storage)).toEqual(committedReceipts);
    const response = await counter.fetch(new Request('https://do/state'));
    expect(await response.json()).toMatchObject({ totalRequests: 2, totalSandboxSeconds: 10 });
    await counter.fetch(recordRequest([sandboxInterval(from, from + 20_000, 5)], 'u1'));
    expect(storage.data.get('state')).toMatchObject({ totalRequests: 7, totalSandboxSeconds: 20 });
    expect(Array.from(storedWatermarks(storage).values())).toEqual([from + 20_000]);
  });

  it('does not leave an advanced receipt behind if the counter write fails inside the transaction', async () => {
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const realPut = storage.put;
    vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'state') {
        throw new Error('counter write failed');
      }
      await realPut(key, value);
    });
    const event = sandboxInterval(now - 60_000, now - 30_000);
    await expect(counter.fetch(recordRequest([event], 'u1'))).rejects.toThrow(
      'counter write failed',
    );
    expect(storedWatermarks(storage).size).toBe(0);
    vi.mocked(storage.put).mockImplementation(realPut);
    await counter.fetch(recordRequest([event], 'u1'));
    expect((storage.data.get('state') as CounterState).totalSandboxSeconds).toBe(30);
  });

  it('retains more than 10,000 fresh generations without expanding the counter state or rebilling', async () => {
    const from = now - 60_000;
    const { counter, storage } = makeCounter({ plan: 'pro' });
    const event = sandboxInterval(from, from + 10_000);
    await counter.fetch(recordRequest([event], 'u1'));
    const originalKey = Array.from(storedWatermarks(storage).keys())[0]!;
    // Seed the same durable record shape at scale; avoid 10,000 simulated
    // network requests merely to establish the old eviction threshold.
    for (let i = 0; i < 10_000; i++) {
      storage.data.set(`${prefix}${i.toString(16).padStart(64, '0')}`, now);
    }
    const listsBefore = storage.list.mock.calls.length;
    await counter.fetch(
      recordRequest([sandboxInterval(from + 30_000, from + 40_000), event], 'u1'),
    );
    expect(storedWatermarks(storage).size).toBe(10_002);
    expect(storage.data.get(originalKey)).toBe(from + 10_000);
    expect((storage.data.get('state') as CounterState).totalSandboxSeconds).toBe(20);
    expect(JSON.stringify(storage.data.get('state')).length).toBeLessThan(1000);
    expect(Array.from(storedWatermarks(storage).keys()).every((key) => key.length < 128)).toBe(
      true,
    );
    expect(storage.list.mock.calls.length - listsBefore).toBe(1);
    expect(storage.list.mock.calls.at(-1)?.[0].limit).toBe(64);
  });

  it('bounds each prune scan and continues from its saved cursor after a cold load', async () => {
    const first = makeCounter({ plan: 'sponsored' });
    const expired = now - SANDBOX_USAGE_RETENTION_MS - 1;
    const retained = `${prefix}${'f'.repeat(64)}`;
    for (let i = 0; i < 130; i++) {
      first.storage.data.set(`${prefix}${i.toString(16).padStart(64, '0')}`, expired);
    }
    first.storage.data.set(retained, now);
    first.storage.failNextCommit();
    await expect(first.counter.alarm()).rejects.toThrow('transaction commit failed');
    expect(storedWatermarks(first.storage).size).toBe(131);
    expect(first.storage.data.has('sandbox-usage:prune-cursor')).toBe(false);
    first.storage.list.mockClear();
    await first.counter.alarm();
    expect(storedWatermarks(first.storage).size).toBe(67);
    expect(first.storage.list.mock.calls).toHaveLength(1);
    expect(first.storage.list.mock.calls[0]?.[0]).toMatchObject({ limit: 64 });

    const next = makeCounter();
    for (const [key, value] of first.storage.data) {
      next.storage.data.set(key, structuredClone(value));
    }
    await next.counter.alarm();
    expect(storedWatermarks(next.storage).size).toBe(3);
    expect(next.storage.list.mock.calls[0]?.[0].startAfter).toBe(
      `${prefix}${(63).toString(16).padStart(64, '0')}`,
    );
    await next.counter.alarm();
    expect(storedWatermarks(next.storage)).toEqual(new Map([[retained, now]]));
    expect(next.storage.data.has('sandbox-usage:prune-cursor')).toBe(false);
    expect(await next.storage.getAlarm()).toBe(now + 15 * 60_000);
  });

  it('prunes only expired receipts and never reapplies their old cumulative prefix', async () => {
    const from = now - SANDBOX_USAGE_RETENTION_MS - 60_000;
    const { counter, storage } = makeCounter({
      plan: 'sponsored',
      billingPeriodStart: new Date(from - 60_000).toISOString(),
    });
    // Bill a generation while its initial interval is still inside retention.
    vi.setSystemTime(from + 30_000);
    const old = sandboxInterval(from, from + 20_000);
    await counter.fetch(recordRequest([old], 'u1'));
    expect((storage.data.get('state') as CounterState).totalSandboxSeconds).toBe(20);

    vi.setSystemTime(now);
    await counter.alarm();
    expect(storedWatermarks(storage).size).toBe(0);
    await counter.fetch(recordRequest([old], 'u1'));
    expect((storage.data.get('state') as CounterState).totalSandboxSeconds).toBe(20);
    // A fresh cumulative frame can span an expired prefix after a delivery
    // outage; only its retained suffix is eligible after that receipt is gone.
    await counter.fetch(recordRequest([sandboxInterval(from, now)], 'u1'));
    expect((storage.data.get('state') as CounterState).totalSandboxSeconds).toBe(
      20 + SANDBOX_USAGE_RETENTION_MS / 1000,
    );
  });
});

describe('UsageCounter dynamic plan reconciliation', () => {
  it('keeps current-period totals when stale initialization and rollover snapshots arrive', async () => {
    const period = '2026-02-01T00:00:00.000Z';
    const { counter, storage } = makeCounter({
      billingPeriodStart: period,
      billingPeriodInitialized: true,
      totalRequests: 9,
      totalSandboxSeconds: 7,
    });
    await counter.fetch(
      new Request('https://do/init', {
        method: 'POST',
        body: JSON.stringify({
          userId: 'u1',
          plan: 'pro',
          billingPeriodStart: '2026-01-01T00:00:00Z',
          projectSlugs: {},
        }),
      }),
    );
    for (const timestamp of ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z']) {
      expect(
        await (await counter.fetch(rolloverRequest(timestamp, 'pro', 'u1'))).json(),
      ).toMatchObject({ rolled: false });
    }
    expect(storage.data.get('state')).toMatchObject({
      billingPeriodStart: period,
      totalRequests: 9,
      totalSandboxSeconds: 7,
    });
  });

  function reevaluate(userId = 'u1') {
    return new Request('https://do/reevaluate-limits', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  it('enforces a dynamic plan against retained usage without changing its billing ledger', async () => {
    const { counter, storage, kv } = makeCounter({
      totalRequests: 15,
      totalNeurons: 6,
      totalSandboxSeconds: 10,
      projectSlugs: { p1: 's1' },
      historicalNeurons: 2,
    });
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'studio' } as never);
    vi.mocked(resolvePlanLimits).mockResolvedValue({
      ...getPlanLimits('pro'),
      requestsPerMonth: 10,
      aiNeuronsPerMonth: 5,
      sandboxRuntimeSecondsPerMonth: 8,
    });
    const response = await counter.fetch(reevaluate());
    expect(await response.json()).toMatchObject({
      requestsSuspended: true,
      sandboxRuntimeSuspended: true,
      aiSuspended: true,
    });
    expect(storage.data.get('state')).toMatchObject({
      plan: 'studio',
      totalRequests: 15,
      totalNeurons: 6,
      totalSandboxSeconds: 10,
      billingPeriodStart: '2026-01-01T00:00:00Z',
      historicalNeurons: 2,
    });
    expect(kv.store.get('sandbox-block:u1')).toBe('1');
    expect(kv.store.get('ai-block:p1')).toBe('1');
  });

  it('clears lifted quota blocks while preserving administrator suspension and totals', async () => {
    const { counter, storage, kv } = makeCounter({
      plan: 'studio',
      totalRequests: 15,
      totalNeurons: 6,
      totalSandboxSeconds: 10,
      requestsSuspended: true,
      aiSuspended: true,
      sandboxRuntimeSuspended: true,
      projectSlugs: { p1: 's1' },
    });
    kv.store.set(
      's1',
      JSON.stringify({ projectId: 'p1', userId: 'u1', suspended: 'admin_suspended' }),
    );
    kv.store.set('ai-block:p1', '1');
    kv.store.set('sandbox-block:u1', '1');
    vi.mocked(getUser).mockResolvedValue({
      id: 'u1',
      plan: 'studio',
      suspended_reason: 'admin_suspended',
    } as never);
    vi.mocked(resolvePlanLimits).mockResolvedValue(getPlanLimits('custom'));
    const response = await counter.fetch(reevaluate());
    expect(await response.json()).toMatchObject({
      requestsSuspended: false,
      sandboxRuntimeSuspended: false,
      aiSuspended: false,
    });
    expect(JSON.parse(kv.store.get('s1')!).suspended).toBe('admin_suspended');
    expect(kv.store.has('ai-block:p1')).toBe(false);
    expect(kv.store.has('sandbox-block:u1')).toBe(false);
    expect(storage.data.get('state')).toMatchObject({
      totalRequests: 15,
      totalNeurons: 6,
      totalSandboxSeconds: 10,
    });
  });

  it('keeps recorded usage across capped, unlimited, and capped transitions', async () => {
    const { counter, storage } = makeCounter({ totalRequests: 15, totalSandboxSeconds: 10 });
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'studio' } as never);
    const capped = { ...getPlanLimits('custom'), requestsPerMonth: 10 };
    vi.mocked(resolvePlanLimits).mockResolvedValue(capped);
    expect(await (await counter.fetch(reevaluate())).json()).toMatchObject({
      requestsSuspended: true,
    });
    vi.mocked(resolvePlanLimits).mockResolvedValue(getPlanLimits('custom'));
    expect(await (await counter.fetch(reevaluate())).json()).toMatchObject({
      requestsSuspended: false,
    });
    await counter.fetch(
      recordRequest(
        [{ projectId: 'p1', userId: 'u1', slug: 's1', requests: 4, responseBytes: 0 }],
        'u1',
        'studio',
      ),
    );
    vi.mocked(resolvePlanLimits).mockResolvedValue(capped);
    expect(await (await counter.fetch(reevaluate())).json()).toMatchObject({
      requestsSuspended: true,
    });
    expect(storage.data.get('state')).toMatchObject({
      totalRequests: 19,
      totalSandboxSeconds: 10,
      billingPeriodStart: '2026-01-01T00:00:00Z',
    });
  });

  it('uses authoritative assignment rather than a delayed usage envelope plan', async () => {
    const { counter, storage } = makeCounter({ plan: 'custom' });
    vi.mocked(getUser).mockResolvedValue({ id: 'u1', plan: 'studio' } as never);
    vi.mocked(resolvePlanLimits).mockResolvedValue({
      ...getPlanLimits('custom'),
      requestsPerMonth: 2,
    });
    const response = await counter.fetch(
      recordRequest(
        [
          {
            projectId: 'p1',
            userId: 'u1',
            slug: 's1',
            requests: 3,
            responseBytes: 0,
          },
        ],
        'u1',
        'custom',
      ),
    );
    expect(await response.json()).toMatchObject({ totalRequests: 3, suspended: true });
    expect(storage.data.get('state')).toMatchObject({ plan: 'studio', totalRequests: 3 });
    expect(resolvePlanLimits).toHaveBeenLastCalledWith(expect.anything(), 'studio');
  });
});
