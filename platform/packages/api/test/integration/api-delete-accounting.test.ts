import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vite-plus/test';
import app from '../../src/index.ts';
import { deriveAiUsageTag } from '../../src/proxy-token.ts';
import { projects, projectOwnershipPeriods, users } from '../../src/schema.ts';
import { getCurrentBillingPeriodStart } from '../../src/tiers.ts';
import { UsageCounter, type CounterState } from '../../src/usage-counter.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  skipOrphanSweepDelay,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  // PostgreSQL ownership timestamps are stored without a zone; Workers interpret them in UTC.
  vi.stubEnv('TZ', 'UTC');
  skipOrphanSweepDelay();
  await clearTables(env.db);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function makeStorage() {
  let data = new Map<string, unknown>();
  let alarm: number | null = null;
  let pending: { data: Map<string, unknown>; alarm: number | null } | null = null;
  type Transaction = Pick<
    DurableObjectTransaction,
    'get' | 'put' | 'delete' | 'list' | 'getAlarm' | 'setAlarm'
  >;
  const storage = {
    get: async <T>(key: string): Promise<T | undefined> =>
      structuredClone((pending?.data ?? data).get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      (pending?.data ?? data).set(key, structuredClone(value));
    },
    delete: async (keys: string | Array<string>) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        (pending?.data ?? data).delete(key);
      }
    },
    list: async ({ prefix, startAfter, limit }: DurableObjectListOptions) =>
      new Map(
        Array.from(pending?.data ?? data)
          .filter(
            ([key]) => (!prefix || key.startsWith(prefix)) && (!startAfter || key > startAfter),
          )
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, limit),
      ),
    getAlarm: async () => (pending ? pending.alarm : alarm),
    setAlarm: async (time: number) => {
      if (pending) {
        pending.alarm = time;
      } else {
        alarm = time;
      }
    },
    transaction: async <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      pending = { data: structuredClone(data), alarm };
      try {
        const result = await callback(storage as unknown as Transaction);
        data = pending.data;
        alarm = pending.alarm;
        return result;
      } finally {
        pending = null;
      }
    },
  };
  return storage;
}

it.each(['fresh', 'initialized'] as const)(
  'deletes through the real %s counter during an analytics outage and reconciles after restart',
  async (counterMode) => {
    const owner = await createTestUser(env.db, `delete-accounting-${counterMode}`);
    const cycleStart = new Date(Date.now() - 86400000).toISOString();
    const billingPeriodStart = getCurrentBillingPeriodStart(cycleStart).toISOString();
    const ownershipStartedAt = new Date(Date.now() - 3600000).toISOString();
    await env.db
      .update(users)
      .set({ billing_cycle_start: cycleStart })
      .where(eq(users.id, owner.id));
    const project = await createTestProject(env.db, owner.id, `delete-accounting-${counterMode}`);
    await env.db
      .update(projects)
      .set({ created_at: ownershipStartedAt })
      .where(eq(projects.id, project.id));
    await env.db
      .update(projectOwnershipPeriods)
      .set({ starts_at: ownershipStartedAt })
      .where(eq(projectOwnershipPeriods.project_id, project.id));

    const storage = makeStorage();
    const initialNeurons = counterMode === 'initialized' ? 17 : 0;
    if (counterMode === 'initialized') {
      await storage.put('state', {
        ownerUserId: owner.id,
        totalRequests: 0,
        totalNeurons: initialNeurons,
        totalSandboxSeconds: 0,
        plan: 'free',
        billingPeriodStart,
        billingPeriodInitialized: true,
        requestsSuspended: false,
        aiSuspended: false,
        sandboxRuntimeSuspended: false,
        projectSlugs: { [project.id]: project.slug },
        projectOwnershipStarts: { [project.id]: ownershipStartedAt },
        projectNeurons: { [project.id]: initialNeurons },
        historicalNeurons: 0,
        historicalAiWindows: {},
      } satisfies CounterState);
    }
    const makeCounter = () => {
      const ctx = { storage };
      const counter = new UsageCounter(ctx as never, env as never);
      // The integration fixture replaces only the Workers base class and storage.
      Object.assign(counter, { ctx, env });
      return counter;
    };
    const counter = makeCounter();
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => counter.fetch(request) }),
    } as unknown as DurableObjectNamespace;
    mockCfApi();
    const provider = globalThis.fetch;
    let unavailable = true;
    const queries: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === 'https://api.cloudflare.com/client/v4/graphql') {
          queries.push(JSON.parse(String(init?.body)).query);
          return Response.json({
            data: {
              viewer: {
                accounts: unavailable
                  ? []
                  : [
                      {
                        aiGatewayRequests: [{ sum: { cost: 0.00033 } }],
                      },
                    ],
              },
            },
          });
        }
        return provider(input, init);
      }),
    );

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${owner.jwt}` },
      }),
      { ...env, USAGE_COUNTER: namespace },
    );
    expect(response.status).toBe(200);
    expect(queries).toEqual([]);
    expect(await env.db.select().from(projects).where(eq(projects.id, project.id))).toEqual([]);
    expect(
      await env.db
        .select()
        .from(projectOwnershipPeriods)
        .where(eq(projectOwnershipPeriods.project_id, project.id)),
    ).toEqual([]);

    const saved = (await storage.get<CounterState>('state'))!;
    const [window] = Object.values(saved.historicalAiWindows);
    expect(saved).toMatchObject({
      ownerUserId: owner.id,
      billingPeriodStart,
      projectSlugs: {},
      projectNeurons: {},
      totalNeurons: initialNeurons,
    });
    expect(Object.keys(saved.historicalAiWindows)).toHaveLength(1);
    expect(window).toMatchObject({
      projectId: project.id,
      ownershipStartedAt,
      neurons: initialNeurons,
    });
    expect(Date.parse(window!.ownershipEndedAt)).toBeGreaterThan(Date.parse(ownershipStartedAt));
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());

    const restarted = makeCounter();
    await expect(restarted.alarm()).rejects.toThrow('AI usage query returned no account data');
    expect(await storage.get('state')).toEqual(saved);
    expect(await storage.getAlarm()).toBeGreaterThan(Date.now());
    unavailable = false;
    await restarted.alarm();
    expect(queries).toHaveLength(2);
    const usageTag = await deriveAiUsageTag(env.JWT_SECRET, project.id);
    for (const query of queries) {
      expect(query).toContain(
        `metadataRaw: ${JSON.stringify(JSON.stringify({ projectId: usageTag }))}`,
      );
      expect(query).toContain(`datetime_geq: "${ownershipStartedAt}"`);
      expect(query).toContain(`datetime_lt: "${window!.ownershipEndedAt}"`);
    }
    const recovered = (await storage.get<CounterState>('state'))!;
    expect(recovered).toMatchObject({ totalNeurons: 30, projectSlugs: {}, projectNeurons: {} });
    expect(Object.values(recovered.historicalAiWindows)).toEqual([{ ...window, neurons: 30 }]);
  },
);
