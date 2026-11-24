import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock db.ts (createDb is called inside processUsageEventBatch).
const getUserMock = vi.fn();
const getProjectsByIdsMock = vi.fn();
const getProjectOwnershipPeriodsByProjectIdsMock = vi.fn();
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  getUser: async (...args: Array<unknown>) => {
    const user = await getUserMock(...args);
    return user ? { created_at: '2020-01-01T00:00:00.000Z', ...user } : user;
  },
  getProjectsByIds: (...args: Array<unknown>) => getProjectsByIdsMock(...args),
  getProjectOwnershipPeriodsByProjectIds: (...args: Array<unknown>) =>
    getProjectOwnershipPeriodsByProjectIdsMock(...args),
  getProjectUsageOwnershipSnapshot: async (...args: Array<unknown>) => ({
    projects: await getProjectsByIdsMock(...args),
    ownershipPeriods: await getProjectOwnershipPeriodsByProjectIdsMock(...args),
  }),
  suspendUser: vi.fn(),
  unsuspendUserIfReason: vi.fn(),
}));

import {
  signUsageEvent,
  SANDBOX_USAGE_RETENTION_MS,
  USAGE_SIGNING_KEY_KV_KEY,
} from '../../src/usage-auth.ts';
import type { UsageEventSource } from '../../src/usage-auth.ts';
import type { UsageEvent } from '../../src/usage-counter.ts';
import { groupEventsByUser, processUsageEventBatch } from '../../src/usage-queue.ts';

const SIGNING_KEY = 'unit-test-usage-signing-key';

describe('groupEventsByUser', () => {
  it('groups events by userId', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u2', slug: 's2', requests: 1, responseBytes: 200 },
      { projectId: 'p3', userId: 'u1', slug: 's3', requests: 1, responseBytes: 300 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get('u1')).toHaveLength(2);
    expect(grouped.get('u2')).toHaveLength(1);
  });

  it('returns empty map for empty events', () => {
    const grouped = groupEventsByUser([]);
    expect(grouped.size).toBe(0);
  });

  it('handles single user with multiple events', () => {
    const events: Array<UsageEvent> = [
      { projectId: 'p1', userId: 'u1', slug: 's1', requests: 1, responseBytes: 100 },
      { projectId: 'p2', userId: 'u1', slug: 's2', requests: 1, responseBytes: 200 },
    ];

    const grouped = groupEventsByUser(events);
    expect(grouped.size).toBe(1);
    expect(grouped.get('u1')).toHaveLength(2);
  });
});

type FakeStubFetch = (req: Request) => Promise<Response>;

function fetchCalls(mock: ReturnType<typeof vi.fn>): Array<[Request, ...Array<unknown>]> {
  return (mock as unknown as { mock: { calls: Array<[Request, ...Array<unknown>]> } }).mock.calls;
}

function makeBatch(events: ReadonlyArray<unknown>, timestamps?: ReadonlyArray<number>) {
  // Cloudflare stamps every queue message with its enqueue time.
  const messages = events.map((event, i) => ({
    body: event,
    timestamp: new Date(timestamps?.[i] ?? Date.now()),
  }));
  const calls = { retryAll: 0, ackAll: 0 };
  return {
    queue: 'void-usage-events',
    messages,
    retryAll: () => {
      calls.retryAll++;
    },
    ackAll: () => {
      calls.ackAll++;
    },
    calls,
  };
}

async function makeSignedBatch(
  events: ReadonlyArray<UsageEvent>,
  timestamps?: ReadonlyArray<number>,
  source: UsageEventSource = 'dispatch',
) {
  const envelopes = await Promise.all(
    events.map((event, index) => signUsageEvent(SIGNING_KEY, source, `event-${index}`, event)),
  );
  return makeBatch(envelopes, timestamps);
}

function makeEnv(stubFetch: FakeStubFetch, errorStub?: FakeStubFetch) {
  const errorStubFetch: FakeStubFetch =
    errorStub ?? (async () => new Response(null, { status: 200 }));
  return {
    HYPERDRIVE: { connectionString: 'postgres://mock' },
    JWT_SECRET: 'jwt-secret',
    ROUTING: {
      get: vi.fn(async (key: string) => (key === USAGE_SIGNING_KEY_KV_KEY ? SIGNING_KEY : null)),
      put: vi.fn(async () => {}),
    },
    USAGE_COUNTER: {
      idFromName: (name: string) => ({ __id: name }),
      get: (_id: unknown) => ({ fetch: stubFetch }),
    },
    ERROR_ALERT_MONITOR: {
      idFromName: (name: string) => ({ __id: name }),
      get: (_id: unknown) => ({ fetch: errorStubFetch }),
    },
  };
}

describe('processUsageEventBatch — sandbox events', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getProjectsByIdsMock.mockReset();
    getProjectOwnershipPeriodsByProjectIdsMock.mockReset();
    getProjectsByIdsMock.mockImplementation(async (_db, ids: ReadonlyArray<string>) =>
      ids.map((id) => ({
        id,
        user_id: 'u1',
        slug: `slug-${id}`,
        created_at: '2020-01-01T00:00:00.000Z',
      })),
    );
    getProjectOwnershipPeriodsByProjectIdsMock.mockResolvedValue([]);
  });

  it('preserves sandbox and request accounting when monthly requests are unlimited', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'custom' });
    const through = Date.now();
    const batch = await makeSignedBatch(
      [
        {
          projectId: 'p1',
          userId: 'u1',
          slug: 's1',
          requests: 0,
          responseBytes: 0,
          sandboxInstanceId: 'sb-1',
          sandboxMeteredFrom: through - 30_000,
          sandboxMeteredThrough: through,
        },
      ],
      undefined,
      'sandbox-counter',
    );
    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);
    expect(stubFetch).toHaveBeenCalledTimes(1);
    expect(await fetchCalls(stubFetch)[0][0].json()).toMatchObject({
      userId: 'u1',
      plan: 'custom',
      events: [{ sandboxMeteredThrough: through }],
    });
    expect(batch.calls.ackAll).toBe(1);
  });

  it('forwards a sandbox event with userId to the DO', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });
    const through = Date.now();
    const from = through - 30_000;

    const events: Array<UsageEvent> = [
      {
        projectId: 'p1',
        userId: 'u1',
        slug: 's1',
        requests: 0,
        responseBytes: 0,
        sandboxInstanceId: 'sb-1',
        sandboxMeteredFrom: from,
        sandboxMeteredThrough: through,
      },
    ];
    const batch = await makeSignedBatch(events, undefined, 'sandbox-counter');
    const env = makeEnv(stubFetch);

    await processUsageEventBatch(batch as never, env as never);

    expect(stubFetch).toHaveBeenCalledTimes(1);
    const callReq = fetchCalls(stubFetch)[0][0];
    const payload = await callReq.json<{
      events: Array<UsageEvent>;
      userId: string;
    }>();
    expect(payload.userId).toBe('u1');
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      sandboxMeteredFrom: from,
      sandboxMeteredThrough: through,
      userId: 'u1',
      slug: 'slug-p1',
    });
    expect(batch.calls.ackAll).toBe(1);
  });
});

describe('processUsageEventBatch — trusted provenance', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getProjectsByIdsMock.mockReset();
    getProjectOwnershipPeriodsByProjectIdsMock.mockReset();
    getProjectOwnershipPeriodsByProjectIdsMock.mockResolvedValue([]);
  });

  it('ignores expired signed sandbox intervals before their replay receipts can be pruned', async () => {
    const through = Date.now() - SANDBOX_USAGE_RETENTION_MS - 1;
    const envelope = await signUsageEvent(SIGNING_KEY, 'sandbox-counter', 'expired-interval', {
      projectId: 'p1',
      requests: 0,
      responseBytes: 0,
      sandboxInstanceId: 'instance',
      sandboxMeteredFrom: through - 1000,
      sandboxMeteredThrough: through,
    });
    const batch = makeBatch([envelope]);
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);
    expect(getProjectsByIdsMock).not.toHaveBeenCalled();
    expect(stubFetch).not.toHaveBeenCalled();
    expect(batch.calls.ackAll).toBe(1);
    expect(batch.calls.retryAll).toBe(0);
  });

  it('acknowledges forged, negative, and foreign raw legacy events without effects', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const bodies: Array<unknown> = [
      { projectId: 'victim', userId: 'victim-user', slug: 'victim', requests: 1, responseBytes: 0 },
      {
        projectId: 'attacker',
        userId: 'attacker',
        slug: 'attacker',
        requests: -10,
        responseBytes: -1,
      },
      {
        version: 1,
        source: 'dispatch',
        eventId: 'forged',
        event: { projectId: 'victim', requests: 1, responseBytes: 0 },
        signature: 'not-a-valid-signature',
      },
    ];
    const batch = makeBatch(bodies);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);

    expect(getProjectsByIdsMock).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
    expect(stubFetch).not.toHaveBeenCalled();
    expect(batch.calls.retryAll).toBe(0);
    expect(batch.calls.ackAll).toBe(1);
  });

  it('accepts signed request usage but replaces producer identity with database ownership', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getProjectsByIdsMock.mockResolvedValue([
      { id: 'p1', user_id: 'owner', slug: 'canonical-slug' },
    ]);
    getUserMock.mockResolvedValue({ id: 'owner', plan: 'solo' });
    const event: UsageEvent = {
      projectId: 'p1',
      userId: 'forged-hint',
      slug: 'forged-hint',
      requests: 1,
      responseBytes: 12,
    };
    const batch = await makeSignedBatch([event]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);

    expect(getUserMock).toHaveBeenCalledWith(expect.anything(), 'owner');
    const payload = await fetchCalls(stubFetch)[0][0].json<{ events: Array<UsageEvent> }>();
    expect(payload.events[0]).toMatchObject({ userId: 'owner', slug: 'canonical-slug' });
    expect(batch.calls.ackAll).toBe(1);
  });

  it('bills delayed events to the owner at the queue timestamp', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getProjectsByIdsMock.mockResolvedValue([
      {
        id: 'p1',
        user_id: 'new-owner',
        slug: 'canonical-slug',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    getProjectOwnershipPeriodsByProjectIdsMock.mockResolvedValue([
      {
        id: 'period-old',
        project_id: 'p1',
        owner_user_id: 'old-owner',
        starts_at: '2026-01-01T00:00:00.000Z',
        ends_at: '2026-06-01T00:00:00.000Z',
        changed_by_user_id: null,
      },
      {
        id: 'period-new',
        project_id: 'p1',
        owner_user_id: 'new-owner',
        starts_at: '2026-06-01T00:00:00.000Z',
        ends_at: null,
        changed_by_user_id: 'admin',
      },
    ]);
    getUserMock.mockImplementation(async (_db, userId) => ({ id: userId, plan: 'solo' }));
    const event = {
      projectId: 'p1',
      requests: 1,
      responseBytes: 12,
    } as UsageEvent;
    const batch = await makeSignedBatch(
      [event, event],
      [Date.parse('2026-05-31T23:59:59.000Z'), Date.parse('2026-06-01T00:00:00.000Z')],
    );

    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);

    expect(getUserMock).toHaveBeenCalledWith(expect.anything(), 'old-owner');
    expect(getUserMock).toHaveBeenCalledWith(expect.anything(), 'new-owner');
    const payloads = await Promise.all(
      fetchCalls(stubFetch).map((call) => call[0].json<Promise<{ events: Array<UsageEvent> }>>()),
    );
    expect(payloads.flatMap((payload) => payload.events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'old-owner',
          currentOwner: false,
          ownershipStartedAt: '2026-01-01T00:00:00.000Z',
        }),
        expect.objectContaining({
          userId: 'new-owner',
          currentOwner: true,
          ownershipStartedAt: '2026-06-01T00:00:00.000Z',
        }),
      ]),
    );
    expect(batch.calls.ackAll).toBe(1);
  });

  it('bills queued usage without reattaching a project being deleted', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getProjectsByIdsMock.mockResolvedValue([
      {
        id: 'p1',
        user_id: 'owner',
        slug: 'canonical-slug',
        status: 'deleting',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    getProjectOwnershipPeriodsByProjectIdsMock.mockResolvedValue([
      {
        id: 'period',
        project_id: 'p1',
        owner_user_id: 'owner',
        starts_at: '2026-01-01T00:00:00.000Z',
        ends_at: null,
        changed_by_user_id: null,
      },
    ]);
    getUserMock.mockResolvedValue({ id: 'owner', plan: 'solo' });
    const batch = await makeSignedBatch([
      { projectId: 'p1', requests: 1, responseBytes: 12 } as UsageEvent,
    ]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);

    const payload = await fetchCalls(stubFetch)[0][0].json<{
      events: Array<UsageEvent>;
    }>();
    expect(payload.events[0]).toMatchObject({ userId: 'owner', currentOwner: false });
    expect(batch.calls.ackAll).toBe(1);
  });

  it('rejects a correctly signed event with invalid quantities', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const invalid = {
      projectId: 'p1',
      requests: 1,
      responseBytes: -1,
    } as unknown as UsageEvent;
    const batch = await makeSignedBatch([invalid]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch) as never);

    expect(getProjectsByIdsMock).not.toHaveBeenCalled();
    expect(stubFetch).not.toHaveBeenCalled();
    expect(batch.calls.ackAll).toBe(1);
  });
});

describe('processUsageEventBatch — 5xx alert window', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getProjectsByIdsMock.mockReset();
    getProjectOwnershipPeriodsByProjectIdsMock.mockReset();
    getProjectOwnershipPeriodsByProjectIdsMock.mockResolvedValue([]);
    getProjectsByIdsMock.mockImplementation(async (_db, ids: ReadonlyArray<string>) =>
      ids.map((id) => ({
        id,
        user_id: 'u1',
        slug: id,
        created_at: '2020-01-01T00:00:00.000Z',
      })),
    );
  });

  function error5xx(projectId: string): UsageEvent {
    return {
      projectId,
      userId: 'u1',
      slug: projectId,
      requests: 1,
      responseBytes: 0,
      status: 503,
    };
  }

  it('carries the edge enqueue times through to the ErrorAlertMonitor', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    // A burst metered at the edge over ten minutes. Whenever this consumer
    // drains the batch, the window must report the edge times — stamping the
    // drain time is what makes the emailed `--range` miss the rows.
    const t0 = Date.parse('2026-07-23T10:00:00Z');
    const t1 = Date.parse('2026-07-23T10:05:00Z');
    const t2 = Date.parse('2026-07-23T10:10:00Z');
    // Deliberately out of order: queues do not guarantee ordering.
    const batch = await makeSignedBatch(
      [error5xx('p1'), error5xx('p1'), error5xx('p1')],
      [t1, t0, t2],
    );

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    expect(errorStubFetch).toHaveBeenCalledTimes(1);
    const body = await fetchCalls(errorStubFetch)[0][0].json<{
      count: number;
      firstAt: number;
      lastAt: number;
    }>();
    expect(body.count).toBe(3);
    expect(body.firstAt).toBe(t0);
    expect(body.lastAt).toBe(t2);
  });

  it('keeps per-project windows separate', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const early = Date.parse('2026-07-23T10:00:00Z');
    const late = Date.parse('2026-07-23T10:30:00Z');
    const batch = await makeSignedBatch([error5xx('p1'), error5xx('p2')], [early, late]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    const bodies = await Promise.all(
      fetchCalls(errorStubFetch).map((call) =>
        call[0].json<Promise<{ projectId: string; firstAt: number; lastAt: number }>>(),
      ),
    );
    const p1 = bodies.find((b) => b.projectId === 'p1');
    const p2 = bodies.find((b) => b.projectId === 'p2');
    expect(p1).toMatchObject({ firstAt: early, lastAt: early });
    expect(p2).toMatchObject({ firstAt: late, lastAt: late });
  });

  it('bills platform static-asset failures without sending user error alerts', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const platformFailures: Array<UsageEvent> = [
      { ...error5xx('docs'), failureKind: 'platform-static-asset-timeout' },
      { ...error5xx('docs'), failureKind: 'platform-static-asset-error' },
      { ...error5xx('docs'), failureKind: 'platform-static-asset-missing' },
    ];
    const batch = await makeSignedBatch(platformFailures);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    expect(stubFetch).toHaveBeenCalledOnce();
    const counterBody = await fetchCalls(stubFetch)[0][0].json<{
      events: Array<UsageEvent>;
    }>();
    expect(counterBody.events).toEqual(
      platformFailures.map((event) => ({
        ...event,
        currentOwner: true,
        ownershipStartedAt: '2020-01-01T00:00:00.000Z',
      })),
    );
    expect(errorStubFetch).not.toHaveBeenCalled();
    expect(batch.calls.ackAll).toBe(1);
  });

  it('still alerts for application 5xx events mixed with a platform timeout', async () => {
    const stubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const errorStubFetch = vi.fn(async () => new Response(null, { status: 200 }));
    getUserMock.mockResolvedValue({ id: 'u1', plan: 'solo' });

    const platformTimeout: UsageEvent = {
      ...error5xx('docs'),
      failureKind: 'platform-static-asset-timeout',
    };
    const appFailure = error5xx('repl');
    const batch = await makeSignedBatch([platformTimeout, appFailure]);

    await processUsageEventBatch(batch as never, makeEnv(stubFetch, errorStubFetch) as never);

    expect(errorStubFetch).toHaveBeenCalledOnce();
    const alertBody = await fetchCalls(errorStubFetch)[0][0].json<{
      projectId: string;
      count: number;
    }>();
    expect(alertBody).toMatchObject({ projectId: 'repl', count: 1 });
    expect(batch.calls.ackAll).toBe(1);
  });
});
