import { eq, sql } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import * as db from '../../src/db.ts';
import app, { FAST_CRON, scheduled } from '../../src/index.ts';
import * as projectAccess from '../../src/project-access.ts';
import { reconcileProjectCleanupJobs } from '../../src/provisioning/cleanup.ts';
import {
  CLOSED_PROXY_TOKEN_STATE,
  deriveProxyToken,
  readProxyTokenState,
  verifyProxyToken,
} from '../../src/proxy-token.ts';
import {
  resources,
  projects,
  deployments,
  builds,
  emailDestinationCleanups,
  emailDestinations,
  users,
  projectMembers,
  projectOwnershipPeriods,
} from '../../src/schema.ts';
import * as zeroTrustService from '../../src/zero-trust/project.ts';
import {
  createTestBuild,
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  mockCfApi,
  cfError,
  cfSuccess,
  createMockExecutionContext,
  recordingBuildManager,
  skipOrphanSweepDelay,
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
  skipOrphanSweepDelay();
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function addResource(
  projectId: string,
  type: 'd1' | 'kv' | 'r2' | 'queue',
  cfId: string,
  bindingName: string,
): Promise<void> {
  await env.db.insert(resources).values({
    id: `res_${type}_${cfId}`,
    project_id: projectId,
    type,
    cf_id: cfId,
    binding_name: bindingName,
  });
}

describe('DELETE /projects/:id', () => {
  it('rechecks delete capability under the lock after ownership transfers', async () => {
    const formerOwner = await createTestUser(env.db, 'former-delete-owner');
    const newOwner = await createTestUser(env.db, 'new-delete-owner');
    const project = await createTestProject(env.db, formerOwner.id, 'transferred-delete');
    const cf = mockCfApi();

    // Drive the transfer after the route's fast authorization snapshot but
    // before teardown takes the project lock. The stale snapshot still says
    // owner; the locked recheck must observe the former owner's new admin role.
    const requireCapability = projectAccess.requireProjectCapability;
    let transferred = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const result = await requireCapability(...args);
      if (!transferred && args[3] === 'delete') {
        transferred = true;
        await env.db
          .update(projects)
          .set({ user_id: newOwner.id })
          .where(eq(projects.id, project.id));
        await env.db.insert(projectMembers).values({
          project_id: project.id,
          user_id: formerOwner.id,
          role: 'admin',
          added_by_user_id: newOwner.id,
        });
      }
      return result;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${formerOwner.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/Ask (a project admin or owner|the owner)/),
    });
    expect(transferred).toBe(true);
    expect(cf).not.toHaveBeenCalled();
    expect(await db.getProject(env.db, project.id)).toMatchObject({
      user_id: newOwner.id,
      status: 'active',
    });
  });

  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake', {
        method: 'DELETE',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'project not found',
      message: expect.stringMatching(/check the project ID/i),
    });
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');
    mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'forbidden',
      message: expect.stringMatching(/Ask (a project admin or owner|the owner)/),
    });
  });

  it('returns 409 while a rollback lease protects external compensation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-leased-delete');
    await env.db.insert(deployments).values({
      id: 'dpl_rollback_lease',
      project_id: project.id,
      status: 'pending',
      source: 'rollback-lease',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'project operation in progress' });
    expect(await db.getProject(env.db, project.id)).not.toBeNull();
  });

  it('deletes a project while retaining its final usage window', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'empty-app');
    const [ownership] = await env.db
      .select()
      .from(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    await env.ROUTING.put(`ai-block:${project.id}`, '1');
    mockCfApi();
    const usageCalls: Array<{ ownerId: string; path: string; body: unknown }> = [];
    const usageCounter = {
      idFromName: (name: string) => name,
      get: (ownerId: string) => ({
        fetch: async (request: Request) => {
          usageCalls.push({
            ownerId,
            path: new URL(request.url).pathname,
            body: await request.json(),
          });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      { ...env, USAGE_COUNTER: usageCounter },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; slug: string };
    expect(body).toEqual({ ok: true, id: project.id, slug: 'empty-app' });

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.ROUTING.get(`ai-block:${project.id}`)).toBeNull();
    expect(usageCalls).toEqual([
      {
        ownerId: user.id,
        path: '/detach-project',
        body: {
          projectId: project.id,
          userId: user.id,
          billingPeriodStart: expect.any(String),
          ownershipStartedAt: ownership!.starts_at,
          ownershipEndedAt: expect.any(String),
        },
      },
    ]);
    const detachBody = usageCalls[0]!.body as { ownershipEndedAt: string };
    expect(Date.parse(detachBody.ownershipEndedAt)).toBeGreaterThanOrEqual(
      Date.parse(ownership!.starts_at),
    );
  });

  it('advances the retained usage cutoff when a failed teardown is retried', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'retry-usage-cutoff');
    await env.db.insert(resources).values({
      id: 'res_retry_container',
      project_id: project.id,
      type: 'container',
      cf_id: 'container-retry',
      binding_name: 'SANDBOX',
    });
    let containerDeleteAttempts = 0;
    mockCfApi({
      deleteContainerApp: () => {
        containerDeleteAttempts += 1;
        return containerDeleteAttempts === 1
          ? cfError('temporary container API failure', 500)
          : cfError('not found', 404);
      },
    });
    const usageCalls: Array<{ body: { ownershipEndedAt: string } }> = [];
    const usageCounter = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          usageCalls.push({ body: await request.json() });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const request = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        { ...env, USAGE_COUNTER: usageCounter },
      );

    expect((await request()).status).toBe(500);
    expect(await db.getProject(env.db, project.id)).toMatchObject({ status: 'deleting' });
    expect(usageCalls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await request()).status).toBe(200);
    expect(usageCalls).toHaveLength(2);
    expect(Date.parse(usageCalls[1]!.body.ownershipEndedAt)).toBeGreaterThan(
      Date.parse(usageCalls[0]!.body.ownershipEndedAt),
    );
  });

  it('deletes project with resources, assets, and routing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'full-app');
    mockCfApi();
    const isrKey = `isr-cache/${project.id}/isr/v3/dpl_test1/full-app.void.app/page`;
    const otherIsrKey = 'isr-cache/other-project/isr/v3/other/other.void.app/page';
    await env.STATIC_ASSETS_R2.put(isrKey, 'cached page');
    await env.STATIC_ASSETS_R2.put(otherIsrKey, 'unrelated cache');

    await addResource(project.id, 'd1', 'd1-uuid-123', 'DB');
    await addResource(project.id, 'kv', 'kv-id-456', 'KV');
    await addResource(project.id, 'r2', 'r2-bucket-789', 'STORAGE');

    await env.db.insert(deployments).values({
      id: 'dpl_test1',
      project_id: project.id,
      status: 'live',
    });

    await env.ROUTING.put(
      'full-app',
      JSON.stringify({ workerName: 'user-full-app', projectId: project.id }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string; slug: string };
    expect(body).toEqual({ ok: true, id: project.id, slug: 'full-app' });

    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();

    const dbResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(dbResources).toHaveLength(0);

    const dbDeployments = await env.db
      .select()
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dbDeployments).toHaveLength(0);

    const routing = await env.ROUTING.get('full-app');
    expect(routing).toBeNull();
    expect(await env.STATIC_ASSETS_R2.get(isrKey)).toBeNull();
    expect(await env.STATIC_ASSETS_R2.get(otherIsrKey)).not.toBeNull();
  });

  it('terminalizes in-flight builds and tears down their container DOs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'building-app');
    mockCfApi();

    // Two in-flight builds: a container build (has a live DO) and a
    // github_actions build (no DO — token revoked purely by terminalizing the
    // row). Both must be gone after delete, and the container DO torn down.
    const containerBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // The container build's DO got a cancelBuild RPC; github_actions has no DO.
    expect(cancelledIds).toContain(containerBuild.id);
    expect(cancelledIds).not.toContain(actionsBuild.id);

    // Both build rows are gone — their deploy tokens are dead (the auth guard
    // rejects any token whose bound build row is missing / not ACTIVE).
    const remaining = await env.db.select().from(builds).where(eq(builds.project_id, project.id));
    expect(remaining).toHaveLength(0);
  });

  it('deletes the CF object for a resource that raced the teardown snapshot', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'race-orphan-app');
    // A real D1 resource row exists at cascade time.
    await addResource(project.id, 'd1', 'd1-raced-uuid', 'DB');

    const cf = mockCfApi();
    // Simulate the orphan-on-concurrent-create race: teardown's one-time resource
    // snapshot MISSES this row (modelled here as a row inserted after the snapshot
    // read). With getProjectResources returning [], cleanupBestEffortResources
    // cleans nothing — so the ONLY path that can delete the CF D1 object is the
    // post-cascade race-window sweep (deleteProjectCascade RETURNs the row →
    // cleanupRaceWindowResourceOrphans).
    vi.spyOn(db, 'getProjectResources').mockResolvedValue([]);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // The race-window sweep deleted the CF D1 object behind the missed row.
    const d1Deletes = cf.mock.calls.filter(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === 'DELETE' &&
        String(url).includes('/d1/database/d1-raced-uuid'),
    );
    expect(d1Deletes.length).toBeGreaterThan(0);

    // And the row is gone.
    const remaining = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(remaining).toHaveLength(0);
  });

  it('retries a failed race-window resource deletion after the cascade', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'race-retry-app');
    await addResource(project.id, 'd1', 'd1-race-retry', 'DB');
    vi.spyOn(db, 'getProjectResources').mockResolvedValue([]);
    let deletionAttempts = 0;
    mockCfApi({
      deleteD1: () =>
        ++deletionAttempts === 1 ? cfError('temporary race-window failure', 500) : cfSuccess(null),
    });

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await db.getProject(env.db, project.id)).toBeNull();
    expect(deletionAttempts).toBe(1);
    const pending = await env.db.execute<{ target: string }>(sql`
      SELECT target FROM project_cleanup_jobs WHERE target = ${`cf-resource:${project.id}:d1:d1-race-retry`}
    `);
    expect(pending.rows).toEqual([{ target: `cf-resource:${project.id}:d1:d1-race-retry` }]);

    await scheduled(
      { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
      env as unknown as Parameters<typeof scheduled>[1],
      createMockExecutionContext(),
    );
    expect(deletionAttempts).toBe(2);
    const finished = await env.db.execute<{ target: string }>(sql`
      SELECT target FROM project_cleanup_jobs WHERE target = ${`cf-resource:${project.id}:d1:d1-race-retry`}
    `);
    expect(finished.rows).toEqual([]);
  });

  it('leaves cleanup jobs of an unknown kind unclaimed while running known jobs', async () => {
    await env.db.execute(sql`
      INSERT INTO project_cleanup_jobs (target, project_id, kind, payload, next_attempt_at)
      VALUES ('unknown:1', 'proj_unknown', 'something-else', '{}'::jsonb, now() - interval '1 minute')
    `);
    await env.ROUTING.put('cleanup-filter-test', 'x');
    await env.db.execute(sql`
      INSERT INTO project_cleanup_jobs (target, project_id, kind, payload, next_attempt_at)
      VALUES (
        'routing-key:proj_unknown:cleanup-filter-test',
        'proj_unknown',
        'routing-key',
        '{"key":"cleanup-filter-test"}'::jsonb,
        now() - interval '1 minute'
      )
    `);

    await reconcileProjectCleanupJobs(env.db, env as unknown as Parameters<typeof scheduled>[1]);

    expect(await env.ROUTING.get('cleanup-filter-test')).toBeNull();
    const remaining = await env.db.execute<{
      target: string;
      attempts: number;
      last_error: string | null;
    }>(sql`SELECT target, attempts, last_error FROM project_cleanup_jobs ORDER BY target`);
    expect(remaining.rows).toEqual([{ target: 'unknown:1', attempts: 0, last_error: null }]);
  });

  it('treats an already-deleted CF resource as successfully cleaned up', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'warn-app');
    mockCfApi({
      deleteD1: () => cfError('database not found', 404),
    });

    await addResource(project.id, 'd1', 'd1-gone', 'DB');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: Array<string> };
    expect(body.ok).toBe(true);
    expect(body.warnings).toBeUndefined();

    // Retrying a partially completed teardown must not get stuck on a 404.
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
  });

  it('retains a durable retry for failed CF cleanup after the project is deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'retry-remote-cleanup');
    await addResource(project.id, 'd1', 'd1-retry-cleanup', 'DB');
    let deletionAttempts = 0;
    mockCfApi({
      deleteD1: () =>
        ++deletionAttempts === 1 ? cfError('temporary D1 failure', 500) : cfSuccess(null),
    });

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await db.getProject(env.db, project.id)).toBeNull();

    const pending = await env.db.execute<{ kind: string; target: string }>(sql`
      SELECT kind, target FROM project_cleanup_jobs
      WHERE target = ${`cf-resource:${project.id}:d1:d1-retry-cleanup`}
    `);
    expect(pending.rows).toEqual([
      { kind: 'cf-resource', target: `cf-resource:${project.id}:d1:d1-retry-cleanup` },
    ]);

    await scheduled(
      { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
      env as unknown as Parameters<typeof scheduled>[1],
      createMockExecutionContext(),
    );
    expect(deletionAttempts).toBe(2);
    const finished = await env.db.execute<{ target: string }>(sql`
      SELECT target FROM project_cleanup_jobs
      WHERE target = ${`cf-resource:${project.id}:d1:d1-retry-cleanup`}
    `);
    expect(finished.rows).toEqual([]);
  });

  it('keeps a reusable slug reserved when its route cannot be removed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reusable-route');
    await env.ROUTING.put(project.slug, JSON.stringify({ projectId: project.id }));
    mockCfApi();
    const deleteRoute = env.ROUTING.delete.bind(env.ROUTING);
    const routeDelete = vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      if (key === project.slug) {
        throw new Error('temporary KV failure');
      }
      return deleteRoute(key);
    });
    const request = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );

    expect((await request()).status).toBe(500);
    expect(await db.getProject(env.db, project.id)).toMatchObject({ status: 'deleting' });
    const pending = await env.db.execute<{ target: string }>(sql`
      SELECT target FROM project_cleanup_jobs
      WHERE target = ${`routing-key:${project.id}:${project.slug}`}
    `);
    expect(pending.rows).toEqual([]);

    routeDelete.mockRestore();
    expect((await request()).status).toBe(200);
    expect(await db.getProject(env.db, project.id)).toBeNull();
    const replacement = await createTestProject(env.db, user.id, project.slug);
    await env.ROUTING.put(project.slug, JSON.stringify({ projectId: replacement.id }));
    await scheduled(
      { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
      env as unknown as Parameters<typeof scheduled>[1],
      createMockExecutionContext(),
    );
    expect(await env.ROUTING.get(project.slug)).toBe(JSON.stringify({ projectId: replacement.id }));
  });

  it('closes the proxy token floor and retries a failed write from the cleanup queue', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'proxy-token-floor');
    const floorKey = `proxy-token:${project.id}`;
    await env.ROUTING.put(floorKey, JSON.stringify({ gen: 2 }));
    mockCfApi();
    const putRoute = env.ROUTING.put.bind(env.ROUTING);
    const routePut = vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value) => {
      if (key === floorKey) {
        throw new Error('temporary KV failure');
      }
      return putRoute(key, value);
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await db.getProject(env.db, project.id)).toBeNull();
    expect(await env.ROUTING.get(floorKey, 'json')).toEqual({ gen: 2 });
    const pending = await env.db.execute<{ kind: string; payload: unknown }>(sql`
      SELECT kind, payload FROM project_cleanup_jobs
      WHERE target = ${`routing-put:${project.id}:${floorKey}`}
    `);
    expect(pending.rows).toEqual([
      { kind: 'routing-put', payload: { key: floorKey, value: CLOSED_PROXY_TOKEN_STATE } },
    ]);

    routePut.mockRestore();
    await scheduled(
      { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
      env as unknown as Parameters<typeof scheduled>[1],
      createMockExecutionContext(),
    );
    expect(await env.ROUTING.get(floorKey)).toBe(CLOSED_PROXY_TOKEN_STATE);
    const finished = await env.db.execute(sql`
      SELECT target FROM project_cleanup_jobs
      WHERE target = ${`routing-put:${project.id}:${floorKey}`}
    `);
    expect(finished.rows).toEqual([]);
  });

  it.each([
    ['a never-rotated project', null, [0, 1]],
    ['a rotated project', 2, [1, 2, 3]],
  ])('rejects every proxy token of %s once it is deleted', async (_label, floor, gens) => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, `token-after-delete-${floor ?? 0}`);
    if (floor !== null) {
      await env.ROUTING.put(`proxy-token:${project.id}`, JSON.stringify({ gen: floor }));
    }
    mockCfApi();
    const accepted = async (gen: number) =>
      verifyProxyToken({
        jwtSecret: env.JWT_SECRET,
        projectId: project.id,
        token: await deriveProxyToken(env.JWT_SECRET, project.id, gen),
        readState: () => readProxyTokenState(env.ROUTING, project.id),
      });
    expect(await accepted(gens.at(-1)!)).toBe(true);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const gen of gens) {
      expect(await accepted(gen)).toBe(false);
    }
  });

  it('deletes Zero Trust applications only after retryable cleanup succeeds', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'zero-trust-teardown');
    await env.ROUTING.put(project.slug, JSON.stringify({ projectId: project.id }));
    mockCfApi();
    const cleanupZeroTrust = vi
      .spyOn(zeroTrustService, 'cleanupProjectZeroTrust')
      .mockResolvedValue(undefined);
    const cascade = vi.spyOn(db, 'deleteProjectCascade');
    const deleteRoute = env.ROUTING.delete.bind(env.ROUTING);
    const routeDelete = vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      if (key === project.slug) {
        throw new Error('temporary KV failure');
      }
      return deleteRoute(key);
    });
    const request = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );

    // The retried project keeps routing, so it must keep its Access bypass.
    expect((await request()).status).toBe(500);
    expect(cleanupZeroTrust).not.toHaveBeenCalled();

    routeDelete.mockRestore();
    expect((await request()).status).toBe(200);
    expect(cleanupZeroTrust).toHaveBeenCalledTimes(1);
    expect(cleanupZeroTrust).toHaveBeenCalledWith(expect.anything(), expect.anything(), project.id);
    expect(cascade).toHaveBeenCalledTimes(1);
    expect(cleanupZeroTrust.mock.invocationCallOrder[0]).toBeLessThan(
      cascade.mock.invocationCallOrder[0]!,
    );
  });

  it('does not warn when worker 404s (static project)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-app');
    // Set type to spa (static project — no worker deployed)
    await env.db.update(projects).set({ type: 'spa' }).where(eq(projects.id, project.id));
    mockCfApi({
      deleteWorker: () => new Response('not found', { status: 404 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; warnings?: Array<string> };
    expect(body).toEqual({ ok: true, id: project.id, slug: 'static-app' });
    expect(body.warnings).toBeUndefined();
  });

  it('deletes queue resources and routing KV entries', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-app');
    const fetchMock = mockCfApi();
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-demo-queue`;

    await addResource(project.id, 'queue', '25832cb0ce3d4f60b1e538911a4629f4', 'demo-queue');
    await env.db.insert(deployments).values([
      {
        id: 'dpl_active',
        project_id: project.id,
        status: 'live',
      },
      {
        id: 'dpl_failed',
        project_id: project.id,
        status: 'failed',
      },
    ]);
    await env.db
      .update(projects)
      .set({ active_deployment_id: 'dpl_active' })
      .where(eq(projects.id, project.id));

    // Add queue routing KV entry (as deploy would)
    await env.ROUTING.put(
      queueRoutingKey,
      JSON.stringify({
        workerName: 'user-queue-app-dpl_active',
        projectId: project.id,
        queueName: 'demo-queue',
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    const queueDeleteIndex = fetchMock.mock.calls.findIndex((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/queues/25832cb0ce3d4f60b1e538911a4629f4') &&
        (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(queueDeleteIndex).toBeGreaterThanOrEqual(0);

    const workerDeleteCalls = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'DELETE';
    });
    const deletedWorkers = workerDeleteCalls.map((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.split('/scripts/')[1];
    });
    expect(deletedWorkers).toEqual(
      expect.arrayContaining([
        'user-queue-app',
        'user-queue-app-dpl_active',
        'user-queue-app-dpl_failed',
      ]),
    );

    for (const workerName of ['user-queue-app-dpl_active', 'user-queue-app-dpl_failed']) {
      const workerDeleteIndex = fetchMock.mock.calls.findIndex((call: Array<unknown>) => {
        const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
        return (
          url.includes(`/scripts/${workerName}`) && (call[1] as RequestInit)?.method === 'DELETE'
        );
      });
      expect(workerDeleteIndex).toBeGreaterThanOrEqual(0);
      expect(workerDeleteIndex).toBeLessThan(queueDeleteIndex);
    }

    const routing = await env.ROUTING.get(queueRoutingKey);
    expect(routing).toBeNull();

    const dbResources = await env.db
      .select()
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(dbResources).toHaveLength(0);
  });

  it('deletes the legacy worker name for older projects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-del');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    const deleteWorkerCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/workers/dispatch/') &&
        url.includes('user-worker-del') &&
        (call[1] as RequestInit)?.method === 'DELETE'
      );
    });
    expect(deleteWorkerCall).toBeDefined();
  });

  // Bytes uploaded via direct-to-R2 presigned PUTs that never finalized into a
  // live deploy (e.g. upload-urls / teardown TOCTOU race, abandoned upload) live durably under
  // `assets/{projectId}/{blake3}` keys. Retention cleanup only walks hashes
  // referenced by retained manifests, so without a teardown sweep these would
  // leak permanently. Project teardown must clear the entire prefix.
  it('sweeps R2 assets/{projectId}/* on teardown', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'asset-sweep');
    mockCfApi();

    const ownKeys = [
      `assets/${project.id}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      `assets/${project.id}/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      `assets/${project.id}/cccccccccccccccccccccccccccccccc`,
    ];
    for (const key of ownKeys) {
      await env.STATIC_ASSETS_R2.put(key, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
    }
    // Sibling project's bytes must NOT be touched.
    const otherKey = 'assets/proj_otherproject/dddddddddddddddddddddddddddddddd';
    await env.STATIC_ASSETS_R2.put(otherKey, new Uint8Array([4, 5, 6]).buffer as ArrayBuffer);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    for (const key of ownKeys) {
      expect(await env.STATIC_ASSETS_R2.head(key)).toBeNull();
    }
    expect(await env.STATIC_ASSETS_R2.head(otherKey)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CF Email Routing destination cleanup.
//
// Destinations are ACCOUNT-level on Cloudflare: one address added for project
// A is a valid `send_email` recipient for every worker in the account. The
// `email_destinations` rows are the only thing that maps them back to
// projects, and `deleteProjectCascade` deletes those rows — so the cleanup
// MUST run before the cascade. If it runs after (or not at all) the
// destination leaks onto the account forever with nothing left to compute the
// reference count from. These tests fail if the call is dropped or reordered.
// ---------------------------------------------------------------------------

/**
 * Wrap the fetch stub `mockCfApi()` installed so `/email/routing/addresses`
 * calls are recorded and answered here. Kept local rather than pushed into
 * `mockCfApi` — the only thing under test is which destinations teardown
 * decides to delete.
 */
function captureEmailRoutingCalls(): Array<{ method: string; url: string }> {
  const calls: Array<{ method: string; url: string }> = [];
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/email/routing/addresses')) {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const tag = url.split('/').pop()?.split('?')[0] ?? 'unknown';
      return Response.json({ success: true, errors: [], messages: [], result: { tag } });
    }
    return inner(input, init);
  });
  return calls;
}

async function addEmailDestination(
  projectId: string,
  address: string,
  cfDestinationId: string,
): Promise<void> {
  await env.db.insert(emailDestinations).values({
    id: `edst_${projectId}_${cfDestinationId}`,
    project_id: projectId,
    address,
    status: 'verified',
    cf_destination_id: cfDestinationId,
  });
}

describe('DELETE /projects/:id — CF email destination cleanup', () => {
  it('DELETEs a destination this project is the only referent of', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-solo');
    mockCfApi();
    const emailCalls = captureEmailRoutingCalls();

    await addEmailDestination(project.id, 'owner@example.com', 'cf-tag-solo');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);

    // The account-level address is gone from Cloudflare. A cleanup that ran AFTER `deleteProjectCascade` would see no rows and
    // make no call here.
    expect(emailCalls).toEqual([
      {
        method: 'DELETE',
        url: expect.stringContaining('/email/routing/addresses/cf-tag-solo') as unknown as string,
      },
    ]);
  });

  it('leaves a destination another project still references on the account', async () => {
    const user = await createTestUser(env.db);
    const doomed = await createTestProject(env.db, user.id, 'mail-shared-a');
    const survivor = await createTestProject(env.db, user.id, 'mail-shared-b');
    mockCfApi();
    const emailCalls = captureEmailRoutingCalls();

    // Same CF tag on both projects — deleting it would silently break the
    // surviving project's ability to mail that recipient.
    await addEmailDestination(doomed.id, 'shared@example.com', 'cf-tag-shared');
    await addEmailDestination(survivor.id, 'shared@example.com', 'cf-tag-shared');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${doomed.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(emailCalls).toEqual([]);

    // The survivor keeps its row.
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, survivor.id));
    expect(rows).toHaveLength(1);
  });

  it('deletes the project while retaining failed provider cleanup for scheduled retry', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-cf-down');
    mockCfApi();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/email/routing/addresses')) {
        return Response.json(
          { success: false, errors: [{ code: 1000, message: 'boom' }], messages: [], result: null },
          { status: 500 },
        );
      }
      return inner(input, init);
    });

    await addEmailDestination(project.id, 'owner@example.com', 'cf-tag-down');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const [dbProject] = await env.db.select().from(projects).where(eq(projects.id, project.id));
    expect(dbProject).toBeUndefined();
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({ cf_destination_id: 'cf-tag-down', status: 'pending', attempts: 1 }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// A destination created while project teardown commits must be discarded.
// ---------------------------------------------------------------------------

describe('POST /projects/:id/email/destinations — losing the teardown race', () => {
  function addDestinationRequest(projectId: string, jwt: string, address: string): Request {
    return new Request(`http://localhost/projects/${projectId}/email/destinations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
  }

  function cfDeleteCalls(fetchMock: ReturnType<typeof mockCfApi>): Array<string> {
    return (fetchMock.mock.calls as Array<Array<unknown>>)
      .filter((call) => {
        const init = call[1] as RequestInit | undefined;
        const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
        return init?.method === 'DELETE' && url.includes('/email/routing/addresses');
      })
      .map((call) => (typeof call[0] === 'string' ? call[0] : String(call[0])));
  }

  it('retires a provider tag when teardown marks the locked project deleting', async () => {
    const user = await createTestUser(env.db);
    await env.db.update(users).set({ email: 'owner@example.com' }).where(eq(users.id, user.id));
    const project = await createTestProject(env.db, user.id, 'mail-race-deleting');
    const fetchMock = mockCfApi({
      addEmailDestination: async (_url: string, init?: RequestInit) => {
        await env.db
          .update(projects)
          .set({ status: 'deleting' })
          .where(eq(projects.id, project.id));
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        return cfSuccess({
          tag: 'cf-tag-project-deleting',
          email: body.email,
          verified: '2026-04-27T00:00:00Z',
          created: '2026-04-27T00:00:00Z',
          modified: '2026-04-27T00:00:00Z',
        });
      },
    });

    const res = await app.fetch(
      addDestinationRequest(project.id, user.jwt, 'owner@example.com'),
      env,
    );

    expect(res.status).toBe(409);
    expect(await env.db.select().from(emailDestinations)).toHaveLength(0);
    expect(cfDeleteCalls(fetchMock)).toEqual([
      expect.stringContaining(
        '/email/routing/addresses/cf-tag-project-deleting',
      ) as unknown as string,
    ]);
    expect(await env.db.select().from(emailDestinationCleanups)).toEqual([
      expect.objectContaining({
        cf_destination_id: 'cf-tag-project-deleting',
        status: 'completed',
      }),
    ]);
  });

  it('deletes the CF destination it created and returns the not-inserted status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mail-race');

    const fetchMock = mockCfApi({
      // Teardown commits its cascade while we are out at CF. The project row
      // — and, by ON DELETE CASCADE, every email_destinations row — is gone
      // before the INSERT below runs, so the FK has nothing to point at.
      addEmailDestination: async (_url: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        await db.deleteProjectCascade(env.db, project.id);
        return cfSuccess({
          tag: 'cf-tag-race',
          email: body.email,
          verified: null,
          created: '2026-04-27T00:00:00Z',
          modified: '2026-04-27T00:00:00Z',
        });
      },
    });

    const res = await app.fetch(
      addDestinationRequest(project.id, user.jwt, 'racer@example.com'),
      env,
    );

    // The INSERT raised `23503`. Uncaught it reaches the app's `onError` as a
    // generic 500 — this is the same "not inserted" answer the sibling-DELETE
    // race already gives, not a new code.
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'destination concurrently modified, try again' });

    // And the account-level address is handed back rather than burning a slot
    // of the shared 200-destination cap forever.
    expect(cfDeleteCalls(fetchMock)).toEqual([
      expect.stringContaining('/email/routing/addresses/cf-tag-race') as unknown as string,
    ]);
  });

  it('leaves a CF destination a surviving project still references', async () => {
    // Same race, but the tag came from the already-exists recovery and a live
    // sibling project points at it. The count must be ZERO to delete — our own
    // row does not exist, so `<= 1` would revoke the sibling's recipient.
    const user = await createTestUser(env.db);
    const doomed = await createTestProject(env.db, user.id, 'mail-race-shared');
    const survivor = await createTestProject(env.db, user.id, 'mail-race-survivor');
    await addEmailDestination(survivor.id, 'shared@example.com', 'cf-tag-shared');

    const fetchMock = mockCfApi({
      addEmailDestination: () => cfError('address already exists'),
      listEmailDestinations: async () => {
        await db.deleteProjectCascade(env.db, doomed.id);
        return cfSuccess([
          {
            tag: 'cf-tag-shared',
            email: 'shared@example.com',
            verified: '2026-04-26T00:00:00Z',
            created: '2026-04-25T00:00:00Z',
            modified: '2026-04-26T00:00:00Z',
          },
        ]);
      },
    });

    const res = await app.fetch(
      addDestinationRequest(doomed.id, user.jwt, 'shared@example.com'),
      env,
    );

    expect(res.status).toBe(409);
    expect(cfDeleteCalls(fetchMock)).toEqual([]);

    // The survivor keeps both its row and its recipient.
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, survivor.id));
    expect(rows).toHaveLength(1);
  });
});
