import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// DurableObject base class isn't available in unit tests — mock it like the
// other DO suites (cron-scheduler, usage-counter).
vi.mock('../../src/plans.ts', async () => {
  const { createDefaultPlanCatalog } = await import('@void/platform/plans');
  return {
    readPlanCatalog: vi.fn(async () => createDefaultPlanCatalog()),
    planFromCatalog: (catalog: ReturnType<typeof createDefaultPlanCatalog>, id: string) =>
      catalog.plans.find((plan) => plan.id === id) ??
      catalog.plans.find((plan) => plan.id === 'free')!,
  };
});

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Mock db.ts so the scheduler's queue/claim/concurrency logic runs against
// controllable fakes instead of Postgres. `tiers.ts` is left real — its pure
// functions encode the per-plan concurrency the scheduler must enforce.
type FakeBuild = {
  id: string;
  project_id: string;
  user_id: string;
  commit_sha: string | null;
  branch: string | null;
  // Which backend the row was queued for. The config-match guard compares
  // this against the connection's `build_executor`. Defaults to 'container' (the
  // only executor the scheduler drains).
  executor?: 'container' | 'github_actions';
  // Container size of record persisted on the row at enqueue. START prefers this
  // over a plan recompute; null models a legacy row queued before
  // enqueue-persistence (START recomputes from the owner's plan).
  instance_type?: string | null;
  // Optional wall-clock age used by the fake getQueuedBuilds to model the real
  // helper's age-fair ordering. Larger = older. Defaults to insertion order.
  age?: number;
};

const db = {
  // `queued` models EVERY queued container build (what hasQueuedContainerBuilds
  // sees). `startable` models only the builds whose project is idle (what the
  // real getQueuedBuilds returns). When `startable` is null the two track
  // together (the common case); set it to [] to simulate a fully BLOCKED queue
  // — queued rows exist but none are startable.
  queued: [] as Array<FakeBuild>,
  startable: null as Array<FakeBuild> | null,
  users: new Map<string, { plan: string; login: string; suspended_reason?: string | null }>(),
  activeByUser: new Map<string, number>(),
  connections: new Map<
    string,
    {
      id?: string;
      repo_full_name: string;
      installation_id: string;
      branch: string;
      build_executor?: 'container' | 'github_actions';
    } | null
  >(),
  projects: new Map<string, { slug: string } | null>(),
  unauthorizedConnectionIds: new Set<string>(),
  // ids that should fail the atomic claim (simulate a lost race)
  unclaimable: new Set<string>(),
  claimPlanByBuild: new Map<string, string>(),
  // ids a concurrent terminalizer (push-supersede / branch-executor change /
  // disconnect / install removal) already drove terminal while startBuild was in
  // flight. The guarded `requeueBuildIfStarting` CAS no-ops on these, so they are
  // NOT requeued (the terminal status is preserved).
  terminalized: new Set<string>(),
  failed: [] as Array<{ id: string; error: string }>,
  // records every build driven to `cancelled` (e.g. the config-match guard:
  // a queued build whose branch/executor no longer matches the connection).
  cancelled: [] as Array<{ id: string; error: string }>,
  // records every build returned to `queued` via the guarded requeue CAS (the
  // capacity-shed retry path) so the suite can assert a fleet-full build is
  // requeued, not failed — and is NOT requeued when concurrently terminalized.
  requeued: [] as Array<string>,
  // records every claimBuildForStartWithinLimit call so the suite can assert the
  // scheduler now goes through the single atomic cap+claim primitive.
  claimArgs: [] as Array<{
    buildId: string;
    userId: string;
    projectId: string;
  }>,
};

// The scheduler now enforces the per-user cap AND claims queued->starting in a
// SINGLE primitive (`claimBuildForStartWithinLimit`) that holds a per-user
// FOR UPDATE lock — the same lock the OIDC path takes — instead of a separate
// countUserActiveBuilds + claimBuildForStart pair. This fake models the cap and
// queued->starting race outcomes exercised by the scheduler unit tests.
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  // Models the real helper: excludes builds owned by `excludeUserIds`, then
  // returns the rest oldest-first (age-fair) up to `limit`. When `db.startable`
  // is set it stands in for the per-idle-project filtering the real query does;
  // the exclude + age-order is still applied on top so the suite can assert the
  // scheduler passes capped owners through.
  getQueuedBuilds: vi.fn(
    async (_db: unknown, limit: number, excludeUserIds: ReadonlyArray<string> = []) => {
      const exclude = new Set(excludeUserIds);
      return (db.startable ?? db.queued)
        .filter((b) => !exclude.has(b.user_id))
        .slice()
        .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))
        .slice(0, limit);
    },
  ),
  // For each user owning a queued build, report their plan + active count so the
  // scheduler can compute who is at their cap and exclude them from the scan.
  getUsersWithQueuedContainerBuilds: vi.fn(async (_db: unknown) => {
    const ownerIds = new Set(db.queued.map((b) => b.user_id));
    return Array.from(ownerIds).map((userId) => ({
      userId,
      plan: db.users.get(userId)?.plan ?? 'free',
      suspendedReason: db.users.get(userId)?.suspended_reason ?? null,
      activeBuilds: db.activeByUser.get(userId) ?? 0,
    }));
  }),
  cancelQueuedContainerBuildsForUsers: vi.fn(
    async (_db: unknown, userIds: ReadonlyArray<string>) => {
      const suspended = new Set(userIds);
      const cancelled = db.queued.filter((build) => suspended.has(build.user_id));
      for (const build of cancelled) {
        db.cancelled.push({ id: build.id, error: 'project owner suspended' });
      }
      db.queued = db.queued.filter((build) => !suspended.has(build.user_id));
      if (db.startable) {
        db.startable = db.startable.filter((build) => !suspended.has(build.user_id));
      }
      return cancelled.length;
    },
  ),
  hasQueuedContainerBuilds: vi.fn(async (_db: unknown) => db.queued.length > 0),
  getUsersByIds: vi.fn(async (_db: unknown, ids: ReadonlyArray<string>) => {
    return ids.flatMap((id) => {
      const u = db.users.get(id);
      return u
        ? [{ id, plan: u.plan, login: u.login, suspended_reason: u.suspended_reason ?? null }]
        : [];
    });
  }),
  claimBuildForStartWithinLimit: vi.fn(
    async (
      _db: unknown,
      args: {
        buildId: string;
        userId: string;
        projectId: string;
      },
    ) => {
      db.claimArgs.push(args);
      const active = db.activeByUser.get(args.userId) ?? 0;
      const plan =
        db.claimPlanByBuild.get(args.buildId) ?? db.users.get(args.userId)?.plan ?? 'free';
      const limit =
        plan === 'custom'
          ? 0
          : plan === 'sponsored'
            ? 6
            : plan === 'pro'
              ? 3
              : plan === 'solo'
                ? 2
                : 1;
      if (limit > 0 && active >= limit) {
        return null;
      }
      if (db.unclaimable.has(args.buildId)) {
        return null;
      }
      const build = db.queued.find((candidate) => candidate.id === args.buildId)!;
      return {
        instanceType:
          build.instance_type ?? (plan === 'free' || plan === 'solo' ? 'standard-3' : 'standard-4'),
        ownerPlan: plan,
        timeoutMinutes:
          plan === 'custom' ? 0 : plan === 'sponsored' ? 20 : plan === 'free' ? 10 : 15,
      };
    },
  ),
  getGitHubConnection: vi.fn(async (_db: unknown, projectId: string) => {
    return db.connections.get(projectId) ?? null;
  }),
  hasGitHubConnectionAuthority: vi.fn(
    async (_db: unknown, connectionId: string) => !db.unauthorizedConnectionIds.has(connectionId),
  ),
  getProject: vi.fn(async (_db: unknown, id: string) => db.projects.get(id) ?? null),
  updateBuildStatus: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: { error?: string }) => {
      if (status === 'failed') {
        db.failed.push({ id, error: opts?.error ?? '' });
      }
      if (status === 'cancelled') {
        db.cancelled.push({ id, error: opts?.error ?? '' });
      }
    },
  ),
  // CAS terminal-if-active: apply the terminal status ONLY if the row is still
  // active. Models the real `UPDATE ... WHERE status IN (active)` guard — a row a
  // concurrent terminalizer already drove terminal (modelled by `db.terminalized`)
  // is a no-op (records nothing, returns false), so the RPC-fail catch can't
  // clobber a committed 'cancelled' to 'failed'. The scheduler uses this for the
  // transport-level startBuild-RPC failure path.
  markBuildTerminalIfActive: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: { error?: string }) => {
      if (db.terminalized.has(id)) {
        return false;
      }
      if (status === 'failed') {
        db.failed.push({ id, error: opts?.error ?? '' });
      }
      if (status === 'cancelled') {
        db.cancelled.push({ id, error: opts?.error ?? '' });
      }
      return true;
    },
  ),
  // Guarded CAS `starting -> queued`: the capacity-shed retry goes through this
  // instead of an unconditional updateBuildStatus('queued'). Models the real
  // `UPDATE ... WHERE status='starting'` guard — if a concurrent terminalizer
  // already drove the row terminal (modelled by `db.terminalized`), this no-ops
  // and returns false (the terminal status is preserved), so the build is NOT
  // requeued / resurrected.
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (db.terminalized.has(id)) {
      return false;
    }
    db.requeued.push(id);
    return true;
  }),
}));

import { BuildScheduler } from '../../src/build-scheduler.ts';
import {
  claimBuildForStartWithinLimit,
  getGitHubConnection,
  getQueuedBuilds,
  getUsersByIds,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';

function makeStubCtx() {
  let alarmTime: number | null = null;
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: vi.fn(async (k: string) => store.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      getAlarm: vi.fn(async () => alarmTime),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
  };
}

// Two distinct DO namespaces — base (free `standard-3`) and large (paid
// `standard-4`) — each with its own idFromName/get/startBuild spies so a test can
// assert WHICH namespace the scheduler routed a build's container start to.
//
// Single-arg form `makeEnv(startBuild)`: BOTH namespaces invoke the SAME
// `startBuild`, so assertions on `startBuild` hold regardless of which namespace
// handled the build.
//
// Per-namespace form `makeEnv({ base, large })`: each fleet gets its OWN
// startBuild spy, so a test can make ONE fleet throw the container-capacity error
// while the other still starts — proving capacity shedding is per-namespace, not
// a global break.
function makeEnv(
  arg:
    | ReturnType<typeof vi.fn>
    | { base: ReturnType<typeof vi.fn>; large: ReturnType<typeof vi.fn> },
) {
  const baseStart = typeof arg === 'function' ? arg : arg.base;
  const largeStart = typeof arg === 'function' ? arg : arg.large;
  function makeNamespace(startBuild: ReturnType<typeof vi.fn>) {
    const stub = { startBuild };
    const idFromName = vi.fn((name: string) => ({ name }));
    const get = vi.fn(() => stub);
    return { idFromName, get };
  }
  const BUILD_MANAGER = makeNamespace(baseStart);
  const BUILD_MANAGER_LARGE = makeNamespace(largeStart);
  return {
    HYPERDRIVE: { connectionString: 'postgres://fake' },
    BUILD_MANAGER,
    BUILD_MANAGER_LARGE,
  } as unknown as ApiEnv['Bindings'] & {
    BUILD_MANAGER: typeof BUILD_MANAGER;
    BUILD_MANAGER_LARGE: typeof BUILD_MANAGER_LARGE;
  };
}

function makeScheduler(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildScheduler(ctx as unknown as DurableObjectState, env);
}

function resetDb() {
  db.queued = [];
  db.startable = null;
  db.users = new Map();
  db.activeByUser = new Map();
  db.connections = new Map();
  db.projects = new Map();
  db.unauthorizedConnectionIds = new Set();
  db.unclaimable = new Set();
  db.claimPlanByBuild = new Map();
  db.terminalized = new Set();
  db.failed = [];
  db.cancelled = [];
  db.requeued = [];
  db.claimArgs = [];
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe('BuildScheduler.fetch', () => {
  it('POST /poke arms a near-immediate alarm', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    const res = await s.fetch(new Request('https://scheduler/poke', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    // ~50ms ahead of the current clock.
    expect(armed).toBeGreaterThanOrEqual(now);
    expect(armed).toBeLessThanOrEqual(now + 1000);
  });

  it('GET /status returns the next alarm', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const res = await s.fetch(new Request('https://scheduler/status'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ nextAlarm: null });
  });

  it('unknown path 404s', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    const res = await s.fetch(new Request('https://scheduler/nope'));
    expect(res.status).toBe(404);
  });
});

describe('BuildScheduler.alarm', () => {
  function enqueue(b: Partial<FakeBuild> & { id: string; user_id: string; project_id: string }) {
    const build: FakeBuild = {
      commit_sha: 'sha1',
      branch: 'main',
      ...b,
    };
    if (build.instance_type === undefined) {
      const plan = db.users.get(build.user_id)?.plan ?? 'free';
      build.instance_type = plan === 'free' || plan === 'solo' ? 'standard-3' : 'standard-4';
    }
    db.queued.push(build);
    if (!db.projects.has(build.project_id)) {
      db.projects.set(build.project_id, { slug: `slug-${build.project_id}` });
    }
    if (!db.connections.has(build.project_id)) {
      db.connections.set(build.project_id, {
        id: `connection-${build.project_id}`,
        repo_full_name: 'owner/repo',
        installation_id: 'inst1',
        branch: 'main',
      });
    }
  }

  it('does not reschedule when the queue is empty', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv(vi.fn());
    const s = makeScheduler(ctx, env);
    await s.alarm();
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('cancels a connection without current authority before claiming the build', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.unauthorizedConnectionIds.add('connection-p1');
    const startBuild = vi.fn(async () => {});
    const s = makeScheduler(makeStubCtx(), makeEnv(startBuild));

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([
      {
        id: 'b1',
        error: 'github repository authorization is no longer valid; reconnect the repository',
      },
    ]);
  });

  it('cancels a queued build owned by a manually suspended user before claiming it', async () => {
    db.users.set('u1', {
      plan: 'free',
      login: 'octocat',
      suspended_reason: 'platform policy violation',
    });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.activeByUser.set('u1', 1);
    db.startable = [];
    const startBuild = vi.fn(async () => {});
    const s = makeScheduler(makeStubCtx(), makeEnv(startBuild));

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'project owner suspended' }]);
  });

  it('re-arms the alarm when the queue is fully blocked (nothing startable but queued work remains)', async () => {
    // getQueuedBuilds returns [] (every queued build's project already has an
    // active build, so none are startable) but hasQueuedContainerBuilds is true.
    // The alarm must NOT lapse — it has to keep its heartbeat so the blocked
    // build is picked up when its project frees, rather than relying on a
    // completion poke that can be lost.
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.startable = []; // nothing startable, but db.queued still has b1
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // No build started, but the alarm re-armed ~2s ahead.
    expect(startBuild).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 2000 - 500);
  });

  it('claims a startable build and invokes startBuild on the manager stub', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as {
      buildId: string;
      projectSlug: string;
      login: string;
      repoFullName: string;
      installationId: string;
      instanceType: string;
      timeoutMinutes: number;
    };
    expect(cfg.buildId).toBe('b1');
    expect(cfg.projectSlug).toBe('slug-p1');
    expect(cfg.login).toBe('octocat');
    expect(cfg.repoFullName).toBe('owner/repo');
    expect(cfg.installationId).toBe('inst1');
    expect(cfg.instanceType).toBe('standard-3');
    expect(cfg.timeoutMinutes).toBe(10);
    expect(
      (env as unknown as { BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> } }).BUILD_MANAGER
        .idFromName,
    ).toHaveBeenCalledWith('b1');
    expect(claimBuildForStartWithinLimit).toHaveBeenCalledOnce();
    expect(db.claimArgs).toEqual([{ buildId: 'b1', userId: 'u1', projectId: 'p1' }]);
  });

  it('enforces per-user tier concurrency (free plan = 1)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.activeByUser.set('u1', 1); // already at the free-plan cap of 1
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(getQueuedBuilds).toHaveBeenCalledWith(expect.anything(), expect.any(Number), ['u1']);
    expect(db.claimArgs).toEqual([]);
    expect(startBuild).not.toHaveBeenCalled();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  it('starts only when claimBuildForStartWithinLimit returns a build', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u1', project_id: 'p2' });
    db.unclaimable.add('b2');
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.claimArgs).toEqual([
      { buildId: 'b1', userId: 'u1', projectId: 'p1' },
      { buildId: 'b2', userId: 'u1', projectId: 'p2' },
    ]);
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b1');
    expect(db.failed.some((f) => f.id === 'b2')).toBe(false);
    expect(getUsersByIds).toHaveBeenCalledOnce();
    expect(getUsersByIds).toHaveBeenCalledWith(expect.anything(), ['u1']);
  });

  it('allows pro plan to start up to 3 concurrent builds', async () => {
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    db.activeByUser.set('u1', 2); // pro cap is 3, so one more is allowed
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as { instanceType: string };
    expect(cfg.instanceType).toBe('standard-4');
  });

  it('routes a PAID-plan build to the BUILD_MANAGER_LARGE namespace (not BUILD_MANAGER)', async () => {
    // A paid plan (pro) with no persisted instance_type recomputes standard-4 and
    // must start its container on the LARGE DO class — never the base class.
    db.users.set('u1', { plan: 'pro', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    // The container start went through the LARGE namespace, keyed by build id.
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER_LARGE.get).toHaveBeenCalledOnce();
    // The base namespace was NOT used for this build.
    expect(env.BUILD_MANAGER.idFromName).not.toHaveBeenCalled();
    expect(env.BUILD_MANAGER.get).not.toHaveBeenCalled();
  });

  it('routes a FREE-plan build to the BUILD_MANAGER namespace (not BUILD_MANAGER_LARGE)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    expect(env.BUILD_MANAGER.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER.get).toHaveBeenCalledOnce();
    expect(env.BUILD_MANAGER_LARGE.idFromName).not.toHaveBeenCalled();
    expect(env.BUILD_MANAGER_LARGE.get).not.toHaveBeenCalled();
  });

  it('routes by the PERSISTED instance_type (standard-4) even when the owner plan would recompute smaller', async () => {
    // Persisted value is the single source of truth: a row stamped standard-4 at
    // enqueue routes LARGE even if the owner's plan has since dropped to free
    // (which would recompute standard-3). A plan change can't relocate an
    // in-flight build's container size.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', instance_type: 'standard-4' });
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as { instanceType: string };
    expect(cfg.instanceType).toBe('standard-4');
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER.idFromName).not.toHaveBeenCalled();
  });

  it('uses the locked owner plan for a legacy row when the earlier plan snapshot is stale', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', instance_type: null });
    db.claimPlanByBuild.set('b1', 'pro');
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild) as unknown as {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env as unknown as ApiEnv['Bindings']);

    await s.alarm();

    expect(startBuild).toHaveBeenCalledOnce();
    const cfg = startBuild.mock.calls[0][0] as {
      instanceType: string;
      timeoutMinutes: number;
    };
    expect(cfg.instanceType).toBe('standard-4');
    expect(cfg.timeoutMinutes).toBe(15);
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b1');
    expect(env.BUILD_MANAGER.idFromName).not.toHaveBeenCalled();
  });

  it('fails a build with a missing user and continues', async () => {
    // no user registered for u-missing
    enqueue({ id: 'b1', user_id: 'u-missing', project_id: 'p1' });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.failed.some((f) => f.id === 'b1' && /user/.test(f.error))).toBe(true);
  });

  it('fails a build whose project has no github connection', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    db.connections.set('p1', null); // connection deleted between webhook and scan
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.failed.some((f) => f.id === 'b1' && /connection/.test(f.error))).toBe(true);
  });

  it('leaves a build queued (never claimed or failed) when a pre-claim lookup throws transiently', async () => {
    // getGitHubConnection / getProject run BEFORE the atomic
    // claim, so a transient DB/Hyperdrive throw must NOT claim the build. A claim
    // would flip it queued->starting (active) with no BuildManager yet created to
    // own the wall-clock timeout, and the stale reaper only covers github_actions
    // builds — so a container build would be stuck `starting` forever, blocking
    // its project and consuming the owner's slot. With the lookups first, the
    // throw aborts this tick with the build still `queued`; CF retries the alarm
    // and the next scan picks it up.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    vi.mocked(getGitHubConnection).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await expect(s.alarm()).rejects.toThrow('hyperdrive timeout');

    // Claim never reached -> the build is still `queued`, not stuck `starting`.
    expect(db.claimArgs).toHaveLength(0);
    expect(startBuild).not.toHaveBeenCalled();
    // A transient error must not terminalize the build (it is retried next tick).
    expect(db.failed).toHaveLength(0);
  });

  it('excludes a capped owner from the scan so an under-cap owner is not starved', async () => {
    // The per-user cap is enforced only at claim time, so if a
    // CAPPED owner held the rows the scan would surface first (lowest project_id
    // / oldest), every tick would inspect-then-skip those rows and never reach an
    // under-cap owner's later, claimable build. The scheduler must instead exclude
    // capped owners up front (computed in TS from the plan-derived cap) so the
    // scan window is spent only on startable work.
    //
    // u1 (free, cap 1) is AT cap and owns the OLDEST/lowest-project_id queued
    // build (b1, p1). u2 (free, cap 1) is under cap and owns a newer, later
    // project's build (b2, p2). Without the exclude, b1 would be scanned first and
    // b2 never reached this tick.
    db.users.set('u1', { plan: 'free', login: 'capped' });
    db.users.set('u2', { plan: 'free', login: 'eligible' });
    db.activeByUser.set('u1', 1); // u1 at the free-plan cap of 1
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', age: 2 }); // oldest, capped owner
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2', age: 1 }); // newer, eligible owner
    const startBuild = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // The capped owner (u1) was excluded from the scan up front.
    expect(getQueuedBuilds).toHaveBeenCalledOnce();
    const [, , excludeUserIds] = vi.mocked(getQueuedBuilds).mock.calls[0];
    expect(excludeUserIds).toEqual(['u1']);

    // Only the eligible owner's build was claimed + started; the capped owner's
    // build was never even inspected (no claim attempt for b1).
    expect(db.claimArgs).toEqual([{ buildId: 'b2', userId: 'u2', projectId: 'p2' }]);
    expect(startBuild).toHaveBeenCalledOnce();
    expect((startBuild.mock.calls[0][0] as { buildId: string }).buildId).toBe('b2');
  });

  it('requeues a build (not failed) and backs off when startBuild throws the container-capacity error', async () => {
    // The global BuildManager fleet is at its max_instances cap, so
    // `@cloudflare/containers` throws its capacity error out of start(), which
    // BuildManager re-throws untouched. The scheduler must classify this as
    // transient platform pressure: return the row to `queued` (so a later alarm
    // retries it once an instance frees) rather than marking it permanently
    // failed. The requeue goes through the guarded `requeueBuildIfStarting` CAS
    // (starting -> queued only); the row is still `starting` here, so it requeues.
    // The heartbeat keeps the alarm armed while queued work remains — but at a
    // longer JITTERED backoff (>= CAPACITY_BACKOFF_BASE_MS = 20s) instead of the
    // normal 2s cadence, so we don't burn the GitHub compare + token mint
    // every 2s while the fleet is full. A completion poke re-arms sooner.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // Requeued via the guarded CAS, NOT failed.
    expect(db.requeued).toEqual(['b1']);
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
    // The build is still queued, so the alarm re-armed — but with the capacity
    // backoff (>= now + 20s), not the normal 2s cadence.
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('per-namespace shedding: a FREE fleet capacity error does NOT stall a later PAID build on LARGE', async () => {
    // Two independent container fleets. A FREE build hitting capacity on the base
    // BUILD_MANAGER must NOT break the scan and stall a queued PAID build that
    // targets the (non-saturated) BUILD_MANAGER_LARGE. The free build is requeued
    // and its fleet marked saturated; the scan CONTINUES and the paid build still
    // starts on LARGE.
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    db.users.set('up', { plan: 'pro', login: 'prouser' });
    // b-free is oldest (scanned first) and routes to base; b-paid is newer and
    // routes to LARGE. Distinct owners + projects so both are independently
    // startable.
    enqueue({ id: 'b-free', user_id: 'uf', project_id: 'pf', age: 2 });
    enqueue({ id: 'b-paid', user_id: 'up', project_id: 'pp', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const large = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large }) as unknown as ApiEnv['Bindings'] & {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> };
      BUILD_MANAGER_LARGE: { idFromName: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // The free build was attempted on base (and threw capacity); the paid build
    // still started on LARGE — no global break.
    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-free');
    expect(large).toHaveBeenCalledOnce();
    expect((large.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-paid');
    expect(env.BUILD_MANAGER_LARGE.idFromName).toHaveBeenCalledWith('b-paid');
    // The shed free build was requeued (guarded CAS), nothing failed/dropped.
    expect(db.requeued).toEqual(['b-free']);
    expect(db.failed).toEqual([]);
    // A fleet was saturated this tick → capacity backoff (>= now + 20s).
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('per-namespace shedding: a PAID fleet capacity error does NOT stall a later FREE build on base', async () => {
    // The symmetric case: LARGE is full, base is not. A paid build hitting
    // capacity on LARGE must not break the scan and stall a queued free build that
    // targets the base BUILD_MANAGER.
    db.users.set('up', { plan: 'pro', login: 'prouser' });
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    enqueue({ id: 'b-paid', user_id: 'up', project_id: 'pp', age: 2 }); // oldest → LARGE
    enqueue({ id: 'b-free', user_id: 'uf', project_id: 'pf', age: 1 }); // newer → base
    const base = vi.fn(async (_cfg: unknown) => {});
    const large = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large }) as unknown as ApiEnv['Bindings'] & {
      BUILD_MANAGER: { idFromName: ReturnType<typeof vi.fn> };
    };
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // The paid build threw capacity on LARGE; the free build still started on base.
    expect(large).toHaveBeenCalledOnce();
    expect((large.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-paid');
    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-free');
    expect(env.BUILD_MANAGER.idFromName).toHaveBeenCalledWith('b-free');
    // The shed paid build was requeued; nothing failed/dropped.
    expect(db.requeued).toEqual(['b-paid']);
    expect(db.failed).toEqual([]);
    // A fleet saturated → capacity backoff.
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('skips a same-fleet build after that fleet saturated this tick (no second startBuild on the full fleet)', async () => {
    // Once a fleet is marked saturated this tick, a LATER build targeting the SAME
    // fleet is skipped up front — it is NOT claimed and startBuild is NOT attempted
    // (which would burn another GitHub compare + token mint against the full fleet).
    // Only the first build (which actually hit capacity) is claimed + requeued.
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    // Both route to base; distinct projects so both would be startable absent
    // capacity. b1 oldest (hits capacity), b2 newer (same fleet → skipped).
    enqueue({ id: 'b1', user_id: 'uf', project_id: 'p1', age: 2 });
    enqueue({ id: 'b2', user_id: 'uf', project_id: 'p2', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const large = vi.fn(async (_cfg: unknown) => {});
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large });
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // startBuild was attempted exactly once (b1); b2 was skipped before any claim.
    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b1');
    // Only b1 was claimed; b2 (same saturated fleet) was never claimed or started.
    expect(db.claimArgs).toEqual([{ buildId: 'b1', userId: 'uf', projectId: 'p1' }]);
    // Only b1 (the claimed row) was requeued; b2 stays queued; nothing dropped.
    expect(db.requeued).toEqual(['b1']);
    expect(db.failed).toEqual([]);
    // Capacity backoff applied because the base fleet saturated this tick.
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('does NOT requeue a concurrently-cancelled build on the capacity path (guarded CAS no-ops)', async () => {
    // The capacity-shed retry must not use an unconditional
    // updateBuildStatus('queued'). If a concurrent terminalizer
    // (terminateBuildsForProject from push-supersede / branch-executor change /
    // disconnect / install removal) flipped the claimed `starting` row to
    // `cancelled` while startBuild was in flight, an unconditional write would
    // resurrect it (cancelled -> queued) and a superseded commit could later
    // deploy. The guarded `requeueBuildIfStarting` CAS (starting -> queued only)
    // no-ops on the now-terminal row, preserving the cancelled status.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      // The concurrent cancel lands while startBuild is in flight, then the fleet
      // is full so start() throws the capacity error the scheduler must shed.
      db.terminalized.add('b1');
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // The guarded CAS no-opped: the build is NOT requeued (terminal preserved)
    // and was not marked failed either.
    expect(db.requeued).toEqual([]);
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
  });

  it('fails a build (not requeued) when startBuild throws a deterministic error', async () => {
    // A non-capacity throw (e.g. a transport-level RPC failure, or any error that
    // is NOT the fleet-full capacity error) is NOT transient platform pressure —
    // it must still be marked failed so the slot frees, exactly as before. Only
    // the capacity error is requeued.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      throw new Error('boom');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(db.failed.some((f) => f.id === 'b1' && /boom/.test(f.error))).toBe(true);
    expect(db.requeued).toEqual([]);
  });

  // the RPC-fail catch finalizes via the CAS `markBuildTerminalIfActive`, NOT
  // an unconditional updateBuildStatus('failed'). If a concurrent cancel
  // (terminateBuildsForProject commits 'cancelled', then cancelBuild RPC) drove
  // the claimed `starting` row terminal while startBuild was in flight, an
  // unconditional write would clobber that 'cancelled' to 'failed'. The CAS must
  // no-op on the already-terminal row (nothing failed/cancelled recorded by the
  // scheduler), and the alarm still re-arms while queued work remains.
  it('does NOT clobber a concurrently-cancelled build when the startBuild RPC throws a deterministic error', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    const startBuild = vi.fn(async () => {
      // The concurrent cancel lands (commits 'cancelled' out-of-band) while
      // startBuild is in flight, then the RPC fails with a deterministic (non-
      // capacity) transport error the scheduler would otherwise mark failed.
      db.terminalized.add('b1');
      throw new Error('rpc transport failed');
    });
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    // The CAS no-opped against the already-terminal row: NOT failed (would have
    // clobbered the cancel) and NOT requeued (this is not the capacity path).
    expect(db.failed.some((f) => f.id === 'b1')).toBe(false);
    expect(db.requeued).toEqual([]);
  });

  // The RPC-fail catch's terminal write is itself a Hyperdrive/Postgres call. If
  // it THROWS (transient outage), the error must not escape `alarm()` — that
  // would abort the rest of the scan AND skip the tail reschedule, so the global
  // scheduler goes quiet while queued work remains and the failed row holds its
  // slot until an unrelated poke or the stale reaper. The write is best-effort:
  // swallow + log, keep draining, keep the heartbeat armed.
  it('keeps scanning and re-arms the alarm when the RPC-fail terminal write throws (slot-safe)', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.users.set('u2', { plan: 'free', login: 'hubot' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2' });
    const startBuild = vi.fn(async (cfg: { buildId: string }) => {
      if (cfg.buildId === 'b1') {
        throw new Error('rpc transport failed');
      }
    });
    // The catch's markBuildTerminalIfActive hits a transient DB outage.
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    // (a) alarm() resolves — the write error does not escape.
    await expect(s.alarm()).resolves.toBeUndefined();

    // (b) the scan continued past b1: b2 was still claimed and started.
    expect(startBuild).toHaveBeenCalledTimes(2);
    expect(startBuild.mock.calls[1][0].buildId).toBe('b2');

    // (c) the tail heartbeat re-armed (queued work remains in the mock queue),
    // so b1 — still `starting` in the DB — is reaped on a later tick instead of
    // the scheduler going dark.
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
  });

  // The capacity-shed requeue write (requeueBuildIfStarting) is itself a
  // Hyperdrive/Postgres call. If it THROWS (transient outage), the error must not
  // escape `alarm()` — that would (a) skip marking the fleet saturated, so later
  // same-fleet builds would NOT be skipped, and (b) skip the tail re-arm/backoff,
  // so the scheduler goes quiet while the row stays `starting` until the stale
  // reaper. The fleet must be marked saturated BEFORE the (best-effort) requeue:
  // swallow + log, keep the fleet saturated, keep draining the OTHER fleet, keep
  // the backoff armed. Mirrors the generic-error branch's terminal-write guard.
  it('keeps the fleet saturated and re-arms the backoff when the capacity requeue write throws (slot-safe)', async () => {
    db.users.set('uf', { plan: 'free', login: 'freeuser' });
    db.users.set('up', { plan: 'pro', login: 'prouser' });
    // b-free (oldest → base) hits capacity; b-free2 (same owner-distinct project →
    // base) targets the SAME fleet and must be skipped once base is saturated;
    // b-paid (newer → LARGE) targets the OTHER fleet and must still start.
    enqueue({ id: 'b-free', user_id: 'uf', project_id: 'pf', age: 3 });
    enqueue({ id: 'b-free2', user_id: 'uf', project_id: 'pf2', age: 2 });
    enqueue({ id: 'b-paid', user_id: 'up', project_id: 'pp', age: 1 });
    const base = vi.fn(async (_cfg: unknown) => {
      throw new Error('there is no container instance that can be provided to this durable object');
    });
    const large = vi.fn(async (_cfg: unknown) => {});
    // The capacity branch's requeueBuildIfStarting hits a transient DB outage on
    // the first (and only) capacity-shed build.
    vi.mocked(requeueBuildIfStarting).mockRejectedValueOnce(new Error('hyperdrive timeout'));
    const ctx = makeStubCtx();
    const env = makeEnv({ base, large });
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    // (a) alarm() resolves — the requeue write error does not escape.
    await expect(s.alarm()).resolves.toBeUndefined();

    // (b) the base fleet was still treated as saturated despite the throw: the
    // same-fleet b-free2 was skipped up front (never claimed, never started), so
    // base.startBuild ran exactly once (b-free, which hit capacity).
    expect(base).toHaveBeenCalledOnce();
    expect((base.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-free');
    expect(db.claimArgs.some((a) => a.buildId === 'b-free2')).toBe(false);

    // (c) the OTHER fleet still drained: the paid build started on LARGE.
    expect(large).toHaveBeenCalledOnce();
    expect((large.mock.calls[0][0] as { buildId: string }).buildId).toBe('b-paid');

    // (d) the throw was swallowed, so the row was never recorded as requeued and
    // nothing was failed/dropped (it stays `starting` for the stale reaper).
    expect(db.requeued).toEqual([]);
    expect(db.failed).toEqual([]);

    // (e) the tail reschedule still ran with the capacity backoff (a fleet
    // saturated this tick → >= now + 20s), so the scheduler does not go dark.
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 20_000);
  });

  it('cancels a queued build whose branch no longer matches the connection (DiD)', async () => {
    // Defense-in-depth: a build was queued for `main`, but the connection has
    // since been retargeted to `develop` (or the enqueue serialization missed a
    // race). The scheduler must refuse to START the stale-config build — it marks
    // it `cancelled` ('github connection config changed') and never calls
    // startBuild. A config change is not a build failure, so it is NOT failed, and
    // the JIT branch-head check in BuildManager would not catch this (it is
    // branch-HEAD-only).
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: 'main' });
    // Connection retargeted to a different branch after the build was queued.
    db.connections.set('p1', {
      repo_full_name: 'owner/repo',
      installation_id: 'inst1',
      branch: 'develop',
    });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    // Never claimed (the guard short-circuits before the atomic claim).
    expect(db.claimArgs).toEqual([]);
    // Cancelled with the config-change reason, NOT failed.
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('cancels a queued build without a branch instead of starting it', async () => {
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: null });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('cancels a queued build whose executor no longer matches the connection (DiD)', async () => {
    // The connection was switched to the github_actions executor after this
    // container build was queued. The container scheduler must not run a build the
    // connection no longer routes to it — same config-match guard, executor half.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1', branch: 'main', executor: 'container' });
    db.connections.set('p1', {
      repo_full_name: 'owner/repo',
      installation_id: 'inst1',
      branch: 'main', // branch matches; only the executor differs
      build_executor: 'github_actions',
    });
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);

    await s.alarm();

    expect(startBuild).not.toHaveBeenCalled();
    expect(db.claimArgs).toEqual([]);
    expect(db.cancelled).toEqual([{ id: 'b1', error: 'github connection config changed' }]);
    expect(db.failed).toEqual([]);
  });

  it('reschedules a +2s alarm while the queue still has work', async () => {
    // b1 (u1) is startable; b2 (u2) is left queued because u2 is at their
    // concurrency cap. The end-of-scan `getQueuedBuilds(1)` therefore still
    // sees work, so the alarm must re-arm ~2s ahead.
    db.users.set('u1', { plan: 'free', login: 'octocat' });
    db.users.set('u2', { plan: 'free', login: 'hubot' });
    db.activeByUser.set('u2', 1); // u2 maxed
    enqueue({ id: 'b1', user_id: 'u1', project_id: 'p1' });
    enqueue({ id: 'b2', user_id: 'u2', project_id: 'p2' });
    // b2 stays queued (capped) so the final getQueuedBuilds(1) is non-empty.
    const startBuild = vi.fn(async () => {});
    const ctx = makeStubCtx();
    const env = makeEnv(startBuild);
    const s = makeScheduler(ctx, env);
    const now = Date.now();

    await s.alarm();

    // b1 started, b2 left queued → reschedule.
    expect(startBuild).toHaveBeenCalledOnce();
    expect(ctx.storage.setAlarm).toHaveBeenCalledOnce();
    const armed = ctx.storage.setAlarm.mock.calls[0][0];
    expect(armed).toBeGreaterThanOrEqual(now + 2000 - 500);
  });
});
