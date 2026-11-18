import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vite-plus/test';
import { aiLoggingKey } from '../../src/ai-logging-policy.ts';
import { FAST_CRON, scheduled } from '../../src/index.ts';
import { transferOperatorProjectOwner } from '../../src/operator/tenant-service.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  proxyTokenRotationTarget,
  requestProxyTokenRotation,
} from '../../src/proxy-token-rotation.ts';
import {
  builds,
  domains,
  projectAiLogging,
  projectCleanupJobs,
  projects,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import {
  deleteOldSecurityPublicRequests,
  deleteOldSecurityScanRows,
  SECURITY_CLOSED_REQUESTS_KEPT,
  SECURITY_RAW_SWEEP_CURSOR_KEY,
  securityRawOutputPrefix,
  sweepSecurityRawOutputs,
} from '../../src/security/maintenance.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  type TestEnv,
} from './helpers.ts';

const zeroTrust = vi.hoisted(() => ({ progressed: false }));
vi.mock('../../src/zero-trust/installation.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/zero-trust/installation.ts')>();
  return {
    ...original,
    resumePlatformZeroTrustOperation: (
      ...args: Parameters<typeof original.resumePlatformZeroTrustOperation>
    ) =>
      zeroTrust.progressed
        ? Promise.resolve(true)
        : original.resumePlatformZeroTrustOperation(...args),
  };
});

let env: TestEnv;

const mockController = {} as ScheduledController;
const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeBindings(e: TestEnv) {
  return {
    HYPERDRIVE: e.HYPERDRIVE as unknown as Hyperdrive,
    ISR_CACHE: e.ISR_CACHE,
    ROUTING: e.ROUTING,
    STATIC_ASSETS: e.STATIC_ASSETS,
    STATIC_ASSETS_R2: e.STATIC_ASSETS_R2,
    DISPATCH: e.DISPATCH,
    CF_API_TOKEN: e.CF_API_TOKEN,
    CF_ACCOUNT_ID: e.CF_ACCOUNT_ID,
    CF_ZONE_ID: e.CF_ZONE_ID,
    JWT_SECRET: e.JWT_SECRET,
    EMAIL_SIGNING_SECRET: e.EMAIL_SIGNING_SECRET,
    PROJECT_SECRET_KEYS_JSON: e.PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION: e.PROJECT_SECRET_ACTIVE_KEY_VERSION,
    R2_ACCESS_KEY_ID: e.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: e.R2_SECRET_ACCESS_KEY,
    R2_STATIC_ASSETS_BUCKET: e.R2_STATIC_ASSETS_BUCKET,
    GITHUB_CLIENT_ID: e.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: e.GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET,
    USAGE_COUNTER: e.USAGE_COUNTER,
    CRON_SCHEDULER: e.CRON_SCHEDULER,
    ERROR_ALERT_MONITOR: e.ERROR_ALERT_MONITOR,
    SANDBOX_CONCURRENCY_COUNTER: e.SANDBOX_CONCURRENCY_COUNTER,
    SECURITY_SCAN_SCHEDULER: e.SECURITY_SCAN_SCHEDULER,
    BUILD_SCHEDULER: e.BUILD_SCHEDULER,
    BUILD_MANAGER: e.BUILD_MANAGER,
    BUILD_MANAGER_LARGE: e.BUILD_MANAGER_LARGE,
    CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} } as unknown as Queue<
      import('../../src/cron-fires-queue.ts').CronFireMessage
    >,
  };
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // clearTables does not touch the builds table; delete any rows this suite
  // seeded first so the FK to projects/users doesn't block clearTables.
  await env.db.delete(builds);
  await clearTables(env.db);
  zeroTrust.progressed = false;
});

describe('scheduled()', () => {
  it('completes without error on empty database', async () => {
    await expect(scheduled(mockController, makeBindings(env), mockCtx)).resolves.toBeUndefined();
  });

  it('does not touch optional module bindings in a core self-hosted installation', async () => {
    const bindings = makeBindings(env) as Record<string, unknown>;
    bindings.PLATFORM_CAPABILITIES = JSON.stringify({
      ai: true,
      customDomains: false,
      email: false,
      githubActions: false,
      githubOAuth: true,
      googleOAuth: false,
      managedBuilds: false,
      sandbox: false,
    });
    delete bindings.BUILD_SCHEDULER;
    delete bindings.BUILD_MANAGER;
    delete bindings.BUILD_MANAGER_LARGE;
    await expect(
      scheduled(mockController, bindings as unknown as Parameters<typeof scheduled>[1], mockCtx),
    ).resolves.toBeUndefined();
  });

  it.each([null, 'enabled'])(
    'blocks scheduled work during a Sandbox drain without consulting a %s KV marker',
    async (marker) => {
      const get = vi.fn(async () => marker);
      const bindings = {
        ...makeBindings(env),
        PLATFORM_INSTALLATION_ID: 'installation-id',
        PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
        ROUTING: { get },
      } as unknown as ReturnType<typeof makeBindings>;
      Object.defineProperty(bindings, 'HYPERDRIVE', {
        get() {
          throw new Error('Sandbox drain must return before creating a database connection.');
        },
      });

      await expect(scheduled(mockController, bindings, mockCtx)).resolves.toBeUndefined();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('rolls over unlimited plan counters before replacing their project set', async () => {
    const { id } = await createTestUser(env.db, 'sponsor', 'github', undefined, 'sponsored');
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: 'test' }));
    const paths: Array<string> = [];
    const usageCounter = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          paths.push(new URL(request.url).pathname);
          return new URL(request.url).pathname === '/rollover'
            ? Response.json({ rolled: true, requestsSuspended: false })
            : Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    await scheduled(mockController, { ...makeBindings(env), USAGE_COUNTER: usageCounter }, mockCtx);

    expect(paths).toEqual(['/rollover', '/init']);
    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.userId).toBe(id);
  });

  it('skips users with no projects', async () => {
    await createTestUser(env.db, 'noprojects', 'github', undefined, 'free');
    await expect(scheduled(mockController, makeBindings(env), mockCtx)).resolves.toBeUndefined();
  });

  it('backfills userId into routing entries', async () => {
    const { id } = await createTestUser(env.db, 'backfill', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    // Old routing entry without userId
    await env.ROUTING.put(proj.slug, JSON.stringify({ worker: 'test', projectId: proj.id }));

    await scheduled(mockController, makeBindings(env), mockCtx);

    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.userId).toBe(id);
  });

  it('does not overwrite existing userId in routing entries', async () => {
    const { id } = await createTestUser(env.db, 'existing', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    // Routing entry already has userId
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ worker: 'test', projectId: proj.id, userId: 'existing-user-id' }),
    );

    await scheduled(mockController, makeBindings(env), mockCtx);

    const routing = JSON.parse((await env.ROUTING.get(proj.slug))!);
    expect(routing.userId).toBe('existing-user-id');
  });

  it('processes multiple batches of users', async () => {
    for (let i = 0; i < 55; i++) {
      const { id } = await createTestUser(env.db, `batchuser${i}`, 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);
      await env.ROUTING.put(proj.slug, JSON.stringify({ worker: 'test', projectId: proj.id }));
    }

    await expect(scheduled(mockController, makeBindings(env), mockCtx)).resolves.toBeUndefined();
  });

  // The hourly scheduled fallback best-effort re-pokes BUILD_SCHEDULER whenever
  // queued container builds remain, in case the webhook's inline poke was lost.
  // It must key that decision off hasQueuedContainerBuilds (ANY queued container
  // build) — NOT getQueuedBuilds, which excludes builds whose project already has
  // an active build and therefore returns [] for a fully-blocked queue.
  describe('build scheduler re-poke', () => {
    function pokeSpyBindings(e: TestEnv): {
      bindings: ReturnType<typeof makeBindings>;
      pokes: Array<string>;
    } {
      const pokes: Array<string> = [];
      const spyScheduler = {
        idFromName: (name: string) => ({ toString: () => name }),
        get: (_id: unknown) => ({
          // index.ts calls `scheduler.fetch(urlString, { method: 'POST' })`,
          // so normalize the (input, init) overload into a Request before
          // inspecting it — a DO stub.fetch accepts the same shape as fetch().
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = input instanceof Request ? input : new Request(input, init);
            const url = new URL(req.url);
            if (req.method === 'POST' && url.pathname === '/poke') {
              pokes.push(url.toString());
            }
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DurableObjectNamespace;
      return { bindings: { ...makeBindings(e), BUILD_SCHEDULER: spyScheduler }, pokes };
    }

    it('re-pokes when a startable queued container build exists', async () => {
      const { id } = await createTestUser(env.db, 'queued-startable', 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);
      await env.db.insert(builds).values({
        id: 'bld_startable',
        project_id: proj.id,
        user_id: id,
        executor: 'container',
        status: 'queued',
      });

      const { bindings, pokes } = pokeSpyBindings(env);
      try {
        await scheduled(mockController, bindings, mockCtx);
        expect(pokes.length).toBe(1);
      } finally {
        await env.db.delete(builds);
      }
    });

    it('re-pokes when the queue is fully blocked (no startable rows but queued work remains)', async () => {
      // The project already has an ACTIVE build, so getQueuedBuilds excludes the
      // project entirely and returns [] — but a queued container build still
      // exists, so hasQueuedContainerBuilds is true and the fallback must poke.
      const { id } = await createTestUser(env.db, 'queued-blocked', 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);
      await env.db.insert(builds).values([
        {
          id: 'bld_active',
          project_id: proj.id,
          user_id: id,
          executor: 'container',
          status: 'building',
        },
        {
          id: 'bld_blocked',
          project_id: proj.id,
          user_id: id,
          executor: 'container',
          status: 'queued',
        },
      ]);

      const { bindings, pokes } = pokeSpyBindings(env);
      try {
        await scheduled(mockController, bindings, mockCtx);
        expect(pokes.length).toBe(1);
      } finally {
        await env.db.delete(builds);
      }
    });

    it('does not re-poke when no queued container builds remain', async () => {
      const { id } = await createTestUser(env.db, 'no-queued', 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);
      await env.db.insert(builds).values({
        id: 'bld_done',
        project_id: proj.id,
        user_id: id,
        executor: 'container',
        status: 'complete',
      });

      const { bindings, pokes } = pokeSpyBindings(env);
      try {
        await scheduled(mockController, bindings, mockCtx);
        expect(pokes.length).toBe(0);
      } finally {
        await env.db.delete(builds);
      }
    });
  });

  it('preserves an Actions build within the admitted timeout margin and reaps abandoned builds', async () => {
    const user = await createTestUser(env.db, 'long-builder');
    const project = await createTestProject(env.db, user.id);
    await env.db.insert(builds).values([
      {
        id: 'actions-grace',
        project_id: project.id,
        user_id: user.id,
        executor: 'github_actions',
        status: 'building',
        created_at: sql`now() - interval '65 minutes'`,
      },
      {
        id: 'actions-abandoned',
        project_id: project.id,
        user_id: user.id,
        executor: 'github_actions',
        status: 'building',
        created_at: sql`now() - interval '80 minutes'`,
      },
    ]);
    await scheduled(mockController, makeBindings(env), mockCtx);
    const rows = new Map(
      (await env.db.select().from(builds)).map((build) => [build.id, build.status]),
    );
    expect(rows.get('actions-grace')).toBe('building');
    expect(rows.get('actions-abandoned')).toBe('failed');
  });

  // The container reaper's DB terminalize frees the slot + revokes the token,
  // but the `started_at > maxAge` predicate does not prove the container is gone
  // (the DO may have been evicted / its alarm lost). The scheduled handler must
  // therefore best-effort issue a BuildManager cancelBuild for each reaped id so
  // a still-alive orphan is actually stopped.
  describe('stale container reaper', () => {
    function cancelSpyBindings(e: TestEnv): {
      bindings: ReturnType<typeof makeBindings>;
      // Separate recorders per size so a routing assertion can prove the reaper
      // forwarded each build's instance_type and addressed the right class.
      baseCancels: Array<{ id: string; reason: string }>;
      largeCancels: Array<{ id: string; reason: string }>;
    } {
      const baseCancels: Array<{ id: string; reason: string }> = [];
      const largeCancels: Array<{ id: string; reason: string }> = [];
      // cancelContainerBuildDos resolves the DO by `idFromName(build.id)`, so
      // round-trip the build id through the stub name to assert it later.
      const makeSpy = (sink: Array<{ id: string; reason: string }>) =>
        ({
          idFromName: (name: string) => ({ toString: () => name }),
          get: (idObj: { toString: () => string }) => ({
            cancelBuild: async (reason: string) => {
              sink.push({ id: idObj.toString(), reason });
            },
          }),
        }) as unknown as DurableObjectNamespace;
      return {
        bindings: {
          ...makeBindings(e),
          BUILD_MANAGER: makeSpy(baseCancels),
          BUILD_MANAGER_LARGE: makeSpy(largeCancels),
        },
        baseCancels,
        largeCancels,
      };
    }

    it('triggers a BuildManager cancel for each stale active container build on the correctly-sized namespace', async () => {
      const { id } = await createTestUser(env.db, 'stale-container', 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);

      // Over-age active PAID (standard-4) container build (> 75 min cutoff). Its
      // cancel must land on BUILD_MANAGER_LARGE, NOT the base namespace.
      await env.db.insert(builds).values({
        id: 'bld_stale_paid',
        project_id: proj.id,
        user_id: id,
        executor: 'container',
        status: 'building',
        instance_type: 'standard-4',
        started_at: sql`now() - interval '90 minute'`,
      });
      // Over-age active FREE (null instance_type legacy) container build — its
      // cancel must land on the base BUILD_MANAGER.
      await env.db.insert(builds).values({
        id: 'bld_stale_free',
        project_id: proj.id,
        user_id: id,
        executor: 'container',
        status: 'building',
        instance_type: null,
        started_at: sql`now() - interval '90 minute'`,
      });
      // Fresh active container build — must NOT be cancelled.
      await env.db.insert(builds).values({
        id: 'bld_fresh',
        project_id: proj.id,
        user_id: id,
        executor: 'container',
        status: 'building',
        started_at: sql`now() - interval '5 minute'`,
      });

      const { bindings, baseCancels, largeCancels } = cancelSpyBindings(env);
      try {
        await scheduled(mockController, bindings, mockCtx);

        // Both stale rows were terminalized (slot freed + token revoked)...
        const paid = await env.db.select().from(builds).where(eq(builds.id, 'bld_stale_paid'));
        expect(paid[0]?.status).toBe('failed');
        // ...AND each got a stop attempt on its OWN size namespace: the paid
        // build on LARGE, the free/null build on the base manager. The reaper
        // forwarded instance_type so the cancel can't miss a live container.
        expect(largeCancels).toEqual([{ id: 'bld_stale_paid', reason: 'stale build reaper' }]);
        expect(baseCancels).toEqual([{ id: 'bld_stale_free', reason: 'stale build reaper' }]);
      } finally {
        await env.db.delete(builds);
      }
    });

    it('makes no cancel attempt when no stale container builds exist', async () => {
      const { id } = await createTestUser(env.db, 'no-stale', 'github', undefined, 'free');
      const proj = await createTestProject(env.db, id);
      await env.db.insert(builds).values({
        id: 'bld_recent',
        project_id: proj.id,
        user_id: id,
        executor: 'container',
        status: 'building',
        started_at: sql`now() - interval '5 minute'`,
      });

      const { bindings, baseCancels, largeCancels } = cancelSpyBindings(env);
      try {
        await scheduled(mockController, bindings, mockCtx);
        expect(baseCancels).toEqual([]);
        expect(largeCancels).toEqual([]);
      } finally {
        await env.db.delete(builds);
      }
    });
  });

  it('isolates errors — one user failure does not block others', async () => {
    const { id: id1 } = await createTestUser(env.db, 'user1', 'github', undefined, 'free');
    const proj1 = await createTestProject(env.db, id1);
    await env.ROUTING.put(proj1.slug, JSON.stringify({ worker: 'test', projectId: proj1.id }));

    const { id: id2 } = await createTestUser(env.db, 'user2', 'github', undefined, 'free');
    const proj2 = await createTestProject(env.db, id2);
    await env.ROUTING.put(proj2.slug, JSON.stringify({ worker: 'test', projectId: proj2.id }));

    // Use a USAGE_COUNTER that fails for the first user but works for the second
    let callCount = 0;
    const failingMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          callCount++;
          // Fail on first rollover call (first user), succeed on rest
          if (callCount === 1) {
            throw new Error('DO failure');
          }
          const url = new URL(req.url);
          if (url.pathname === '/rollover') {
            return Response.json({ rolled: false });
          }
          if (url.pathname === '/init') {
            return Response.json({ ok: true });
          }
          return Response.json({});
        },
      }),
    } as unknown as DurableObjectNamespace;

    const bindings = { ...makeBindings(env), USAGE_COUNTER: failingMock };

    // Should not throw despite first user failing
    await expect(scheduled(mockController, bindings, mockCtx)).resolves.toBeUndefined();

    // Second user should still have userId backfilled
    const routing2 = JSON.parse((await env.ROUTING.get(proj2.slug))!);
    expect(routing2.userId).toBe(id2);
  });

  // A DO mock that always reports `requestsSuspended: <latch>` on /rollover,
  // optionally also reporting a one-time rollover. Mirrors the real DO, which
  // returns the request latch on every response so the scheduler can
  // reconcile KV against it each pass.
  function makeRequestLatchMock(opts: {
    requestsSuspended: boolean;
    rolled?: boolean;
  }): DurableObjectNamespace {
    return {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/rollover') {
            return Response.json({
              rolled: opts.rolled ?? false,
              unsuspendRequests: opts.rolled ?? false,
              unsuspendAi: false,
              requestsSuspended: opts.requestsSuspended,
            });
          }
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
  }

  it('clears suspended on slug AND active domain routes when the DO reports a request rollover', async () => {
    const { id } = await createTestUser(env.db, 'rolluser', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    await env.db.insert(domains).values({
      id: 'dom_roll_active',
      project_id: proj.id,
      hostname: 'roll-custom.example.com',
      cf_hostname_id: 'cf_roll',
      status: 'active',
    });

    // Routes left `suspended` by the previous period's request cap.
    const suspendedJson = JSON.stringify({
      projectId: proj.id,
      userId: id,
      suspended: 'requests_exceeded',
    });
    await env.ROUTING.put(proj.slug, suspendedJson);
    await env.ROUTING.put('domain:roll-custom.example.com', suspendedJson);

    // DO reports the billing period rolled and the request latch is now clear.
    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: true, requestsSuspended: false }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBeUndefined();
    expect(
      JSON.parse((await env.ROUTING.get('domain:roll-custom.example.com'))!).suspended,
    ).toBeUndefined();
  });

  it('self-heals a stale requests_exceeded marker even on a pass that did NOT roll over', async () => {
    // Models a prior rollover whose KV clear partially failed: the DO latch is
    // already false (period rolled last run) but a route still carries the
    // stale marker. A later, non-rolling pass must reconcile it — proving the
    // cleanup is retryable, not one-shot.
    const { id } = await createTestUser(env.db, 'staleuser', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ projectId: proj.id, userId: id, suspended: 'requests_exceeded' }),
    );

    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: false, requestsSuspended: false }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBeUndefined();
  });

  it('preserves an admin suspension when the request latch is clear (reason-scoped reconcile)', async () => {
    const { id } = await createTestUser(env.db, 'adminuser', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    // Admin-suspended route — the request-cap reconcile must never lift this.
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ projectId: proj.id, userId: id, suspended: 'admin_suspended' }),
    );

    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: false, requestsSuspended: false }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBe('admin_suspended');
  });

  it('does NOT clear a route while the request latch is still set (user genuinely over cap)', async () => {
    const { id } = await createTestUser(env.db, 'overcap', 'github', undefined, 'free');
    const proj = await createTestProject(env.db, id);
    await env.ROUTING.put(
      proj.slug,
      JSON.stringify({ projectId: proj.id, userId: id, suspended: 'requests_exceeded' }),
    );

    await scheduled(
      mockController,
      {
        ...makeBindings(env),
        USAGE_COUNTER: makeRequestLatchMock({ rolled: false, requestsSuspended: true }),
      },
      mockCtx,
    );

    expect(JSON.parse((await env.ROUTING.get(proj.slug))!).suspended).toBe('requests_exceeded');
  });

  it('does not clear a transferred project from the former owner rollover snapshot', async () => {
    const formerOwner = await createTestUser(
      env.db,
      'rollover-former',
      'github',
      undefined,
      'free',
    );
    const newOwner = await createTestUser(env.db, 'rollover-current', 'github', undefined, 'free');
    const project = await createTestProject(env.db, formerOwner.id, 'rollover-transferred');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        projectId: project.id,
        userId: newOwner.id,
        suspended: 'requests_exceeded',
      }),
    );
    let transferred = false;
    const usageCounter = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: async (request: Request) => {
          if (
            id.toString() === formerOwner.id &&
            new URL(request.url).pathname === '/rollover' &&
            !transferred
          ) {
            transferred = true;
            await env.db
              .update(projects)
              .set({ user_id: newOwner.id })
              .where(eq(projects.id, project.id));
          }
          return new URL(request.url).pathname === '/rollover'
            ? Response.json({ rolled: false, requestsSuspended: false })
            : Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    await scheduled(mockController, { ...makeBindings(env), USAGE_COUNTER: usageCounter }, mockCtx);

    expect(transferred).toBe(true);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      userId: newOwner.id,
      suspended: 'requests_exceeded',
    });
  });

  it('reconciles an empty project set after the last project transfers away', async () => {
    const formerOwner = await createTestUser(env.db, 'empty-former-owner');
    const newOwner = await createTestUser(env.db, 'empty-current-owner');
    const operator = await createTestUser(env.db, 'empty-transfer-operator');
    const project = await createTestProject(env.db, formerOwner.id, 'empty-transferred');
    await transferOperatorProjectOwner(
      {
        env,
        get: (key: string) => (key === 'db' ? env.db : operator),
      } as never,
      project.id,
      newOwner.id,
    );

    const initBodies = new Map<string, Record<string, unknown>>();
    const usageCounter = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === '/init') {
            initBodies.set(id.toString(), await request.json<Record<string, unknown>>());
            return Response.json({ ok: true });
          }
          return Response.json({ rolled: false, requestsSuspended: false });
        },
      }),
    } as unknown as DurableObjectNamespace;

    await scheduled(mockController, { ...makeBindings(env), USAGE_COUNTER: usageCounter }, mockCtx);

    expect(initBodies.get(formerOwner.id)).toMatchObject({
      userId: formerOwner.id,
      projectSlugs: {},
      projectOwnershipStarts: {},
    });
    expect(initBodies.get(newOwner.id)).toMatchObject({
      userId: newOwner.id,
      projectSlugs: { [project.id]: project.slug },
    });
  });
});

describe('scheduled() proxy token rotations', () => {
  const fastController = { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController;

  async function dueRotation(): Promise<string> {
    const { id } = await createTestUser(env.db, 'rotation-owner');
    const project = await createTestProject(env.db, id);
    await requestProxyTokenRotation(env.db, project.id, 'operator', 'operator');
    return project.id;
  }

  async function rotationState(projectId: string) {
    const [project] = await env.db
      .select({ gen: projects.proxy_token_gen })
      .from(projects)
      .where(eq(projects.id, projectId));
    const [job] = await env.db
      .select({ payload: projectCleanupJobs.payload })
      .from(projectCleanupJobs)
      .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
    return { gen: project!.gen, phase: job?.payload.phase };
  }

  it.each([
    ['fast', fastController],
    ['hourly', mockController],
  ])('advances a due rotation on the %s cron', async (_tier, controller) => {
    const projectId = await dueRotation();
    await scheduled(controller, makeBindings(env), mockCtx);
    // A project without Workers runs START through REVOKE, then waits for the
    // raised floor to reach every reader.
    expect(await rotationState(projectId)).toEqual({ gen: 1, phase: 'settle' });
  });

  it('leaves rotations to the next tick when a Zero Trust batch used this one', async () => {
    const projectId = await dueRotation();
    zeroTrust.progressed = true;
    await scheduled(fastController, makeBindings(env), mockCtx);
    expect(await rotationState(projectId)).toEqual({ gen: 0, phase: 'requested' });
  });

  it.each([
    ['during installer staging', { PLATFORM_TRAFFIC_STATE: 'staging' }],
    ['under the development auth bypass', { DEV_AUTH_BYPASS: 'true' }],
  ])('does not rotate %s', async (_case, overrides) => {
    const projectId = await dueRotation();
    await scheduled(mockController, { ...makeBindings(env), ...overrides }, mockCtx);
    expect(await rotationState(projectId)).toEqual({ gen: 0, phase: 'requested' });
  });
});

describe('scheduled() AI logging sweep', () => {
  const fastController = { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController;

  /** A core self-hosted install: no optional module may gate the sweep. */
  function coreBindings() {
    return {
      ...makeBindings(env),
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: false,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      }),
    } as unknown as Parameters<typeof scheduled>[1];
  }

  it('repairs a missing AI logging key on the hourly cron, not the fast one', async () => {
    const { id } = await createTestUser(env.db, 'ai-sweep-owner');
    const project = await createTestProject(env.db, id);
    await env.db.insert(projectAiLogging).values({ project_id: project.id, mode: 'off' });
    const key = aiLoggingKey(project.id);
    await env.ROUTING.delete(key);

    await scheduled(fastController, coreBindings(), mockCtx);
    expect(await env.ROUTING.get(key)).toBeNull();

    await scheduled(mockController, coreBindings(), mockCtx);
    expect(await env.ROUTING.getWithMetadata(key)).toMatchObject({
      value: 'off',
      metadata: { mode: 'off' },
    });
  });
});

describe('scheduled() security audit maintenance', () => {
  const fastController = { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  let pokes: number;
  let forgotten: Array<[string, number]>;

  function securityBindings(on: boolean) {
    const scheduler = {
      fetch: async (input: string | Request) => {
        if (new URL(typeof input === 'string' ? input : input.url).pathname === '/poke') {
          pokes++;
        }
        return Response.json({ ok: true });
      },
      forgetModelCalls: async (scanId: string, attempt: number) => {
        forgotten.push([scanId, attempt]);
        return 0;
      },
    };
    return {
      ...makeBindings(env),
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: false,
        email: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
        securityAudits: on,
      }),
      SECURITY_SCAN_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => scheduler,
      },
    } as unknown as Parameters<typeof scheduled>[1];
  }

  async function savePolicy(mode: 'disabled' | 'all') {
    await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
      ...defaultSecurityPolicy(),
      mode,
      revision: 1,
      // Fresh: the daily probe is not due.
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: false },
      },
    });
  }

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  async function seed() {
    const { id } = await createTestUser(env.db, `security-cron-${crypto.randomUUID()}`);
    const [p1, p2, p3, p4] = [
      await createTestProject(env.db, id),
      await createTestProject(env.db, id),
      await createTestProject(env.db, id),
      await createTestProject(env.db, id),
    ];
    await env.db.insert(securityScans).values([
      {
        id: 'ss_lease',
        project_id: p1!.id,
        deployment_id: 'dpl_1',
        status: 'running',
        trigger: 'deploy',
        attempt: 1,
        lease_until: ago(60_000),
      },
      {
        id: 'ss_backlog',
        project_id: p2!.id,
        deployment_id: 'dpl_2',
        status: 'queued',
        trigger: 'deploy',
        first_queued_at: ago(25 * HOUR),
      },
      {
        id: 'ss_pending',
        project_id: p3!.id,
        deployment_id: 'dpl_3',
        status: 'pending_input',
        trigger: 'deploy',
        first_queued_at: ago(HOUR),
        created_at: ago(HOUR),
      },
      {
        id: 'ss_old',
        project_id: p4!.id,
        deployment_id: 'dpl_4',
        status: 'failed',
        trigger: 'deploy',
        finished_at: ago(31 * DAY),
      },
    ]);
    const raw = securityRawOutputPrefix(p4!.id, 'ss_old');
    await env.STATIC_ASSETS_R2.put(`${raw}findings.json`, '[]');
    return { raw };
  }

  async function statuses() {
    const rows = await env.db
      .select({ id: securityScans.id, status: securityScans.status })
      .from(securityScans)
      .orderBy(securityScans.id);
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
  }

  const untouched = {
    ss_backlog: 'queued',
    ss_lease: 'running',
    ss_old: 'failed',
    ss_pending: 'pending_input',
  };

  beforeEach(async () => {
    pokes = 0;
    forgotten = [];
    await env.ROUTING.delete(SECURITY_RAW_SWEEP_CURSOR_KEY);
  });

  it('runs the hourly jobs only with the capability on', async () => {
    await savePolicy('all');
    const { raw } = await seed();

    await scheduled(mockController, securityBindings(false), mockCtx);
    expect(await statuses()).toEqual(untouched);
    expect(await env.STATIC_ASSETS_R2.get(`${raw}findings.json`)).not.toBeNull();

    await scheduled(mockController, securityBindings(true), mockCtx);
    expect(await statuses()).toEqual({
      ss_backlog: 'skipped',
      ss_lease: 'timed_out',
      ss_old: 'failed',
      ss_pending: 'queued',
    });
    expect(forgotten).toEqual([['ss_lease', 1]]);
    expect(pokes).toBe(1);
    expect(await env.STATIC_ASSETS_R2.get(`${raw}findings.json`)).toBeNull();
    expect(await env.ROUTING.get(SECURITY_RAW_SWEEP_CURSOR_KEY)).toContain('ss_old');
  });

  it('leaves security rows alone on the fast tier', async () => {
    await savePolicy('all');
    const { raw } = await seed();
    await scheduled(fastController, securityBindings(true), mockCtx);
    expect(await statuses()).toEqual(untouched);
    expect(pokes).toBe(0);
    expect(await env.STATIC_ASSETS_R2.get(`${raw}findings.json`)).not.toBeNull();
  });

  it('with the policy Off still reaps and sweeps, but re-pokes nothing', async () => {
    await savePolicy('disabled');
    const { raw } = await seed();
    await scheduled(mockController, securityBindings(true), mockCtx);
    expect(await statuses()).toEqual({ ...untouched, ss_lease: 'timed_out' });
    expect(pokes).toBe(0);
    expect(await env.STATIC_ASSETS_R2.get(`${raw}findings.json`)).toBeNull();
  });

  it('keeps the newest scan rows, the current base and open gate scans; trims closed requests', async () => {
    const { id } = await createTestUser(env.db, `security-retention-${crypto.randomUUID()}`);
    const project = await createTestProject(env.db, id);
    const old = ago(200 * DAY);
    await env.db.insert(securityScans).values(
      [
        // The current base: the latest succeeded scan, kept however old.
        { id: 'ss_base', status: 'succeeded' as const, finished_at: old, created_at: old },
        { id: 'ss_gate_old', status: 'failed' as const, finished_at: old, created_at: old },
        { id: 'ss_aged', status: 'failed' as const, finished_at: old, created_at: old },
        { id: 'ss_young', status: 'failed' as const, finished_at: ago(DAY), created_at: ago(DAY) },
      ].map((row) => ({
        ...row,
        project_id: project.id,
        deployment_id: 'dpl',
        trigger: 'deploy' as const,
      })),
    );
    await env.db.insert(securityPublicRequests).values({
      id: 'spr_open',
      project_id: project.id,
      state: 'held_no_result',
      requested_via: 'project',
      target_deployment_id: 'dpl',
      gate_scan_id: 'ss_gate_old',
    });
    // Nothing is deleted before the raw output sweep has passed the rows.
    expect(await deleteOldSecurityScanRows(env.db, env.ROUTING, Date.now())).toBe(0);
    await sweepSecurityRawOutputs(env.db, env.STATIC_ASSETS_R2, env.ROUTING, Date.now());
    expect(await deleteOldSecurityScanRows(env.db, env.ROUTING, Date.now())).toBe(1);
    expect(Object.keys(await statuses()).sort()).toEqual(['ss_base', 'ss_gate_old', 'ss_young']);

    const closed = Array.from({ length: SECURITY_CLOSED_REQUESTS_KEPT + 2 }, (_, index) => ({
      id: `spr_closed_${String(index).padStart(3, '0')}`,
      project_id: project.id,
      state: 'canceled' as const,
      cancel_cause: 'protect' as const,
      requested_via: 'project' as const,
      target_deployment_id: 'dpl',
      closed_at: ago(DAY),
      created_at: new Date(Date.now() - (index + 1) * HOUR).toISOString(),
    }));
    await env.db.insert(securityPublicRequests).values(closed);
    // The oldest closed request is named by a bypass row and stays.
    await env.db.insert(securityScanBypasses).values({
      id: 'sb_kept',
      project_id: project.id,
      request_id: closed.at(-1)!.id,
      deployment_id: 'dpl',
      actor_kind: 'user',
      actor_user_id: id,
      reason: 'launch',
      request_state: 'held_no_result',
    });
    expect(await deleteOldSecurityPublicRequests(env.db)).toBe(1);
    const left = await env.db
      .select({ id: securityPublicRequests.id })
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.project_id, project.id));
    expect(left.map((row) => row.id)).not.toContain(closed.at(-2)!.id);
    expect(left.map((row) => row.id)).toContain(closed.at(-1)!.id);
    expect(left).toHaveLength(SECURITY_CLOSED_REQUESTS_KEPT + 2);
  });
});
