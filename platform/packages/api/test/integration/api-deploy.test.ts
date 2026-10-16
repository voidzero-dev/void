import { SHARED_CACHE_POLICY_VERSION } from '@void/isr/core';
import { createDefaultPlanCatalog } from '@void/platform/plans';
import { desc, eq, sql } from 'drizzle-orm';
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
import { computeAssetHash } from '../../src/assets.ts';
import {
  beginDeploymentCutover,
  cancelDeployment,
  failStaleDeployments,
  getDeployment,
  getProject,
  removeProjectMember,
  updateDeploymentStatus,
  updateUserPlan,
  type Db,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { writePlanCatalog } from '../../src/plans.ts';
import * as projectAccess from '../../src/project-access.ts';
import * as projectIngress from '../../src/project-ingress.ts';
import { deriveProxyToken } from '../../src/proxy-token.ts';
import { validateManifestShape } from '../../src/routes/deploy.ts';
import {
  builds,
  deployments,
  resources,
  domains,
  projects,
  projectMigrations,
  projectMembers,
  projectZeroTrust,
  projectSecrets,
  platformSettings,
  projectCleanupJobs,
  users,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createOperatorToken,
  createTestProject,
  createTestDeployment,
  createTestProjectSecret,
  mockCfApi,
  cfSuccess,
  cfError,
  readAllEvents,
  CF_ACCOUNT_ID,
  JWT_SECRET,
  type MockCfApiHandle,
  type TestEnv,
} from './helpers.ts';
import { setTestDb } from './setup.ts';

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

const SQLITE_MIGRATIONS = {
  dialect: 'sqlite',
  pending: 1,
  protocolVersion: 2,
  classifierVersion: 1,
  migrationListHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  stability: 'stable',
};

function sqliteMigrationCapabilities(): Response {
  return Response.json({
    ...SQLITE_MIGRATIONS,
    destructiveValidation: 'passed',
    endpoints: {
      app: '/__void/migrate/app',
      reconcile: '/__void/migrate/app/attempt/:attemptId',
    },
  });
}

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // builds reference projects via FK and clearTables() does not touch them, so
  // clear builds first (mirrors deploy-token-scope.test.ts).
  await env.db.delete(builds);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function injectLostGoLiveCommitAcknowledgement(projectId: string): {
  wasInjected: () => boolean;
  restore: () => void;
} {
  const realDb = env.db;
  const realTransaction = realDb.transaction.bind(realDb);
  let injected = false;
  const wrappedDb = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (async (fn: any) => {
          const result = await realTransaction(fn);
          if (!injected) {
            const [project] = await realDb
              .select({ activeDeploymentId: projects.active_deployment_id })
              .from(projects)
              .where(eq(projects.id, projectId))
              .limit(1);
            const active = project?.activeDeploymentId
              ? await getDeployment(realDb, project.activeDeploymentId)
              : null;
            if (active?.status === 'live') {
              injected = true;
              throw new Error('database connection lost after COMMIT');
            }
          }
          return result;
        }) as unknown as typeof realDb.transaction;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  setTestDb(wrappedDb);
  return {
    wasInjected: () => injected,
    restore: () => setTestDb(realDb),
  };
}

/**
 * Build a JSON-mode (direct-to-R2) deploy request body that mirrors the
 * shape the production CLI sends. Pre-uploads each asset's bytes into
 * `env.STATIC_ASSETS_R2` under the `assets/${projectId}/${blake3}` key so the
 * JSON-mode handler's parallel R2.head verification finds them.
 */
async function buildDeployRequest(
  env: TestEnv,
  projectId: string,
  jwt: string,
  opts?: {
    manifest?: Record<string, unknown>;
    workers?: Record<string, string>;
    assets?: Record<string, string | Uint8Array>;
    /** Carried through for tests that pass an explicit assetManifest body field. */
    assetManifest?: Record<string, { hash: string; size: number }>;
    /** When 'true', appended to the JSON body. */
    preflight?: 'true' | null;
    /** Skip the default `index.js` worker module. */
    omitDefaultWorker?: boolean;
  },
): Promise<Request> {
  const baseManifest = opts?.manifest ?? { version: 3, bindings: {} };
  // JSON-mode requires assetManifestVersion: 2.
  const manifest: Record<string, unknown> = {
    assetManifestVersion: 2,
    ...baseManifest,
  };

  // Decide whether worker files are appropriate for this manifest type.
  const manifestType = (manifest as { type?: unknown }).type;
  const isStaticManifest = manifestType === 'spa' || manifestType === 'static';

  // Default worker file for non-static manifests so callers can use the
  // simple `buildDeployRequest()` shape.
  const workers =
    opts?.workers ??
    (isStaticManifest || opts?.omitDefaultWorker
      ? {}
      : { 'index.js': "export default { fetch() { return new Response('ok'); } }" });

  const workerFiles: Record<string, string> | undefined =
    Object.keys(workers).length > 0
      ? Object.fromEntries(
          Object.entries(workers).map(([name, content]) => [
            name,
            bytesToBase64(new TextEncoder().encode(content)),
          ]),
        )
      : undefined;

  // Build the asset manifest in v2 shape, pre-uploading each asset to R2.
  const assetManifest: Record<string, { blake3: string; md5: string; size: number }> = {};
  if (opts?.assets) {
    for (const [path, content] of Object.entries(opts.assets)) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const blake3 = computeAssetHash(bytes.buffer as ArrayBuffer, '/' + path);
      // md5 is required by the v2 wire shape but never re-checked when bytes
      // are pre-uploaded out-of-band (R2.head only checks size). Stub with
      // a deterministic 32-hex value so manifest validation accepts it.
      const md5 = blake3;
      assetManifest['/' + path] = { blake3, md5, size: bytes.length };
      // Pre-upload to R2 under the content-addressed key the handler checks.
      await env.STATIC_ASSETS_R2.put(
        `assets/${projectId}/${blake3}`,
        bytes as unknown as ArrayBuffer,
      );
    }
  }

  // Allow callers to provide an explicit assetManifest (for dedupe/preflight
  // tests). When provided, override the auto-generated entries — but pre-upload
  // happens above based on `opts.assets`, so callers passing both must keep
  // them aligned.
  const declaredAssetManifest: Record<string, { blake3: string; md5: string; size: number }> = {};
  if (opts?.assetManifest) {
    for (const [path, entry] of Object.entries(opts.assetManifest)) {
      declaredAssetManifest[path] = {
        blake3: entry.hash,
        md5: entry.hash,
        size: entry.size,
      };
    }
  }

  const finalAssetManifest =
    Object.keys(declaredAssetManifest).length > 0 ? declaredAssetManifest : assetManifest;

  const body: Record<string, unknown> = {
    manifest,
    assetManifest: finalAssetManifest,
    source: null,
    commit: null,
    repositoryUrl: null,
    commitUrl: null,
    gitRef: null,
    preflight: opts?.preflight ?? null,
  };
  if (workerFiles) {
    body.workerFiles = workerFiles;
  }

  return new Request(`http://localhost/projects/${projectId}/deploy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function parseDeployStream(text: string): Array<unknown> {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

type DeployEvent = { event: string } & Record<string, unknown>;
type DoneEvent = DeployEvent & {
  deployment: string;
  url?: string;
  urls?: Array<string>;
  assets?: number;
  workers?: number;
  migrations?: number;
};
type ErrorEvent = DeployEvent & { message?: string; step?: string };
type MigrationStartEvent = DeployEvent & { pending: number };
type MigrationEvent = DeployEvent & { name: string };

function isDeployEvent(value: unknown): value is DeployEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    typeof (value as { event?: unknown }).event === 'string'
  );
}

function requireEvent<T extends DeployEvent>(events: Array<unknown>, name: string): T {
  const event = events.find(
    (candidate): candidate is T => isDeployEvent(candidate) && candidate.event === name,
  );
  expect(event).toBeDefined();
  return event!;
}

function mockSetTimeout() {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: TimerHandler,
    ...args: Array<unknown>
  ) => nativeSetTimeout(fn, 0, ...args)) as typeof setTimeout);
}

/**
 * Builds an ExecutionContext that captures every `waitUntil` promise into
 * `pending` so tests can `await Promise.all(pending)` after `app.fetch`.
 * Real Workers awaits these on response close; Hono passes the ctx through
 * to handlers but does not await it. Without this, deferred work (e.g. the
 * post-routing cron sync in deploy.ts step 5c) never runs in tests.
 */
function createWaitUntilTrackingCtx(): {
  ctx: ExecutionContext;
  pending: Array<Promise<unknown>>;
} {
  const pending: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

describe('POST /projects/:id/deploy', () => {
  it('restores committed code while retaining a completed operator plan update after cutover fails', async () => {
    const user = await createTestUser(env.db);
    const admin = await createTestUser(
      env.db,
      'policy-admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    const token = await createOperatorToken(env.db, admin);
    const project = await createTestProject(env.db, user.id, 'compensate-current-policy');
    mockCfApi();
    const initial = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        workers: { 'index.js': 'export default {fetch(){return new Response("first")}}' },
      }),
      env,
    );
    expect(parseDeployStream(await initial.text()).at(-1)).toMatchObject({ event: 'done' });
    const source = (await getProject(env.db, project.id))!.active_deployment_id;
    const sourceRouting = (await env.ROUTING.get(project.slug, 'json')) as { workerName: string };
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let changed = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key.startsWith('cutover-ready:') && !changed) {
        changed = true;
        const applied = await app.fetch(
          new Request('http://localhost/operator/v1/config/plans/free/set', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expectedRevision: 0,
              limits: {
                cpuMsPerRequest: 77,
                maxCpuMsPerRequest: 100,
                subRequestsPerInvocation: 70,
              },
            }),
          }),
          env,
        );
        expect(applied.status).toBe(200);
        expect(await applied.json()).toMatchObject({
          ok: true,
          reconciliation: { complete: true },
        });
        throw new Error('injected failure after completed policy update');
      }
      return originalPut(key, value, options);
    });
    const replacement = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        workers: { 'index.js': 'export default {fetch(){return new Response("second")}}' },
      }),
      env,
    );
    expect(parseDeployStream(await replacement.text()).at(-1)).toMatchObject({
      event: 'error',
      message: 'injected failure after completed policy update',
    });
    expect(changed).toBe(true);
    expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(source);
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      workerName: sourceRouting.workerName,
      version: source,
      limits: { cpuMs: 77, subRequests: 70 },
    });
  });

  it.each([
    { backend: 'worker', changePlan: false },
    { backend: 'worker', changePlan: true },
    { backend: 'static', changePlan: true },
  ] as const)(
    'publishes current plan policy after a completed update during $backend preparation (assignment: $changePlan)',
    async ({ backend, changePlan }) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(
        env.db,
        user.id,
        `late-policy-${backend}-${changePlan}`,
      );
      await env.db.insert(domains).values({
        id: 'late-policy-domain',
        project_id: project.id,
        hostname: 'late-policy.example.com',
        cf_hostname_id: 'late-policy-cf-hostname',
        status: 'active',
      });
      mockCfApi();
      let updated = false;
      const scheduler = {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname === '/snapshot' && !updated) {
              const catalog = createDefaultPlanCatalog();
              const source = catalog.plans.find((plan) => plan.id === 'free')!;
              const changed = {
                ...source,
                id: changePlan ? 'team' : 'free',
                name: changePlan ? 'Team' : 'free',
                limits: {
                  ...source.limits,
                  cpuMsPerRequest: 77,
                  maxCpuMsPerRequest: 100,
                  subRequestsPerInvocation: 70,
                },
              };
              await writePlanCatalog(env.db, {
                ...catalog,
                revision: 1,
                plans: changePlan
                  ? [...catalog.plans, changed]
                  : catalog.plans.map((plan) => (plan.id === 'free' ? changed : plan)),
              });
              if (changePlan) {
                await updateUserPlan(env.db, user.id, 'team');
              }
              // The completed update is already published before this deployment takes its cutover fence.
              await env.ROUTING.put(
                project.slug,
                JSON.stringify({
                  workerName: 'previous-worker',
                  projectId: project.id,
                  userId: user.id,
                  limits: { cpuMs: 77, subRequests: 70 },
                }),
              );
              updated = true;
              return Response.json({ state: null });
            }
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DurableObjectNamespace;
      const request =
        backend === 'static'
          ? await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' })
          : await buildDeployRequest(env, project.id, user.jwt);
      const response = await app.fetch(request, { ...env, CRON_SCHEDULER: scheduler });
      expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'done' });
      expect(updated).toBe(true);
      const routing = await env.ROUTING.get(project.slug, 'json');
      expect(routing).toMatchObject({
        userId: user.id,
        ...(backend === 'worker'
          ? { limits: { cpuMs: 77, subRequests: 70 } }
          : { staticDeploymentId: expect.any(String) }),
      });
      expect(await env.ROUTING.get('domain:late-policy.example.com', 'json')).toEqual(routing);
      expect(await env.ROUTING.get(`project:${project.id}`)).toBeNull();
    },
  );

  it('does not require migration metadata when no SQL will run', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-migrations');
    mockCfApi();
    const originalDispatch = env.DISPATCH;
    const dispatch = vi.fn();
    env.DISPATCH = { get: dispatch } as unknown as DispatchNamespace;
    try {
      const response = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          manifest: {
            version: 3,
            bindings: {},
            migrations: { dialect: 'sqlite', pending: 0, files: [] },
          },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'done' });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it.each([
    ['old protocol', { dialect: 'sqlite', pending: 1 }],
    ['missing classifier', { ...SQLITE_MIGRATIONS, classifierVersion: undefined }],
    ['unsupported classifier', { ...SQLITE_MIGRATIONS, classifierVersion: 2 }],
    ['missing list hash', { ...SQLITE_MIGRATIONS, migrationListHash: undefined }],
    ['invalid list hash', { ...SQLITE_MIGRATIONS, migrationListHash: 'sha256:invalid' }],
    ['missing stability', { ...SQLITE_MIGRATIONS, stability: undefined }],
  ])(
    'rejects new SQLite builds with %s before mutations and preserves old deployments',
    async (_label, migrations) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migration-upgrade');
      const retained = await createTestDeployment(env.db, project.id);
      const active = await createTestDeployment(env.db, project.id);
      const oldManifest = JSON.stringify({
        version: 3,
        bindings: { d1: ['DB'] },
        migrations: { dialect: 'sqlite', pending: 1 },
      });
      await env.db
        .update(deployments)
        .set({ manifest: oldManifest, retained: true })
        .where(eq(deployments.project_id, project.id));
      const routing = JSON.stringify({
        deploymentId: active.id,
        version: active.id,
        projectId: project.id,
      });
      await env.ROUTING.put(project.slug, routing);
      const originalRows = await env.db
        .select()
        .from(deployments)
        .where(eq(deployments.project_id, project.id))
        .orderBy(deployments.id);
      const provider = mockCfApi();
      const ingress = vi.spyOn(projectIngress, 'ensureProjectIngress');
      const originalDispatch = env.DISPATCH;
      const dispatch = vi.fn();
      env.DISPATCH = { get: dispatch } as unknown as DispatchNamespace;
      try {
        const response = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            manifest: { version: 3, bindings: { d1: ['DB'] }, migrations },
          }),
          env,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          event: 'error',
          message:
            'SQLite migrations require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.',
        });
        expect(provider).not.toHaveBeenCalled();
        expect(ingress).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          await env.db
            .select()
            .from(deployments)
            .where(eq(deployments.project_id, project.id))
            .orderBy(deployments.id),
        ).toEqual(originalRows);
        expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(active.id);
        expect(await env.ROUTING.get(project.slug)).toBe(routing);
        expect(originalRows.map((row) => row.id)).toEqual(
          expect.arrayContaining([active.id, retained.id]),
        );
        expect(
          await env.db.select().from(resources).where(eq(resources.project_id, project.id)),
        ).toEqual([]);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    },
  );

  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: { version: 3, bindings: {} }, assetManifest: {} }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, 'proj_nonexistent', user.jwt), env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'project not found', message: expect.any(String) });
  });

  it('returns 403 when user does not own project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');
    mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, project.id, bob.jwt), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
  });

  it('denies readers and bills collaborator deploys to the project owner', async () => {
    const owner = await createTestUser(env.db, 'team-owner');
    const reader = await createTestUser(env.db, 'team-reader');
    const collaborator = await createTestUser(
      env.db,
      'team-collaborator',
      'github',
      undefined,
      'custom',
    );
    const project = await createTestProject(env.db, owner.id, 'team-deploy');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
    ]);
    mockCfApi();

    const readerResponse = await app.fetch(
      await buildDeployRequest(env, project.id, reader.jwt),
      env,
    );
    expect(readerResponse.status).toBe(403);

    const collaboratorResponse = await app.fetch(
      await buildDeployRequest(env, project.id, collaborator.jwt),
      env,
    );
    expect(collaboratorResponse.status).toBe(200);
    const done = requireEvent<DoneEvent>(await readAllEvents(collaboratorResponse), 'done');
    const deployment = await getDeployment(env.db, done.deployment);
    expect(deployment).toMatchObject({
      billing_user_id: owner.id,
      initiated_by_user_id: collaborator.id,
      status: 'live',
    });
    const routing = (await env.ROUTING.get(project.slug, 'json')) as { userId: string };
    expect(routing.userId).toBe(owner.id);
  });

  it("preserves the owner's request suspension on a collaborator's first deploy", async () => {
    const owner = await createTestUser(env.db, 'suspended-team-owner');
    const collaborator = await createTestUser(env.db, 'suspended-team-collaborator');
    const project = await createTestProject(env.db, owner.id, 'suspended-team-deploy');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, owner.id));
    expect(await env.ROUTING.get(project.slug)).toBeNull();
    mockCfApi();

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, collaborator.jwt),
      env,
    );

    expect(response.status).toBe(200);
    requireEvent<DoneEvent>(await readAllEvents(response), 'done');
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      projectId: project.id,
      userId: owner.id,
      suspended: 'requests_exceeded',
    });
  });

  it("uses the owner's plan rather than a collaborator's plan", async () => {
    const owner = await createTestUser(env.db, 'limited-owner');
    const collaborator = await createTestUser(
      env.db,
      'unlimited-collaborator',
      'github',
      undefined,
      'custom',
    );
    const project = await createTestProject(env.db, owner.id, 'owner-plan-deploy');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    mockCfApi();

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, collaborator.jwt, {
        manifest: { version: 3, bindings: {}, limits: { cpuMs: 60_000 } },
      }),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: 'limits.cpuMs 60000 exceeds your plan maximum of 10',
    });
  });

  it('revokes a collaborator before final publication even with an already-started deploy', async () => {
    const owner = await createTestUser(env.db, 'final-owner');
    const collaborator = await createTestUser(env.db, 'final-collaborator');
    const project = await createTestProject(env.db, owner.id, 'final-revocation');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    mockCfApi();

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let revoked = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      await originalPut(key, value, options);
      if (!revoked && key.startsWith('cutover-ready:')) {
        revoked = true;
        await removeProjectMember(env.db, {
          projectId: project.id,
          subjectUserId: collaborator.id,
          actorUserId: owner.id,
        });
      }
    });

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, collaborator.jwt),
      env,
    );
    expect(response.status).toBe(200);
    const events = await readAllEvents(response);
    expect(events.some((event) => isDeployEvent(event) && event.event === 'done')).toBe(false);
    expect(requireEvent<ErrorEvent>(events, 'error').message).toMatch(
      /collaborator.*project admin or owner/i,
    );
    expect(revoked).toBe(true);
    const [deployment] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment?.status).not.toBe('live');
  });

  it('succeeds with minimal deploy (no bindings, no assets)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'minimal-app');
    mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.url).toBe('https://minimal-app.void.app');

    // Verify deployment is marked live in DB
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, done.deployment));
    expect(dpl?.status).toBe('live');
  });

  it('updates KV routing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'routed-app');
    mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get('routed-app', 'json');
    expect(routing).toEqual({
      workerName: expect.stringMatching(/^user-routed-app-dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'void',
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it.each([
    { backend: 'worker' as const, slug: 'zero-trust-cutover-worker' },
    { backend: 'static' as const, slug: 'zero-trust-cutover-static' },
  ])(
    'publishes the Zero Trust state committed before the $backend cutover lock',
    async ({ backend, slug }) => {
      const user = await createTestUser(env.db, `owner-${backend}`);
      const project = await createTestProject(env.db, user.id, slug);
      mockCfApi();

      const configuration = (audience: string, revision: number) => ({
        version: 1,
        revision,
        enabled: true,
        protectNewProjects: true,
        accountId: env.CF_ACCOUNT_ID,
        teamDomain: 'https://company.cloudflareaccess.com',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        credential: { ciphertext: 'unused', iv: 'unused', keyVersion: 'v1' },
        wildcardApplicationName: 'void-test-projects',
        wildcardApplication: {
          id: 'access-wildcard',
          name: 'void-test-projects',
          audience,
          destinations: ['*.void.app'],
        },
        lastError: null,
        updatedAt: new Date().toISOString(),
      });
      await env.db.insert(platformSettings).values({
        key: 'zeroTrust.configuration',
        value: configuration('stale-audience', 1),
      });
      // Deploy admission requires settled protection; the audience then
      // changes while the deploy runs, before its cutover lock.
      await env.db.insert(projectZeroTrust).values({
        project_id: project.id,
        desired_protected: true,
        effective_protected: true,
        status: 'ready',
      });

      let protectionCommitted = false;
      const cronScheduler = {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (request: Request) => {
            if (new URL(request.url).pathname === '/snapshot' && !protectionCommitted) {
              await env.db
                .update(platformSettings)
                .set({ value: configuration('access-audience', 2) })
                .where(eq(platformSettings.key, 'zeroTrust.configuration'));
              protectionCommitted = true;
              return Response.json({ state: null });
            }
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DurableObjectNamespace;
      const testEnv = { ...env, CRON_SCHEDULER: cronScheduler };
      const request =
        backend === 'static'
          ? await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' })
          : await buildDeployRequest(env, project.id, user.jwt);

      const response = await app.fetch(request, testEnv);
      expect(response.status).toBe(200);
      expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'done' });
      expect(protectionCommitted).toBe(true);
      expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
        zeroTrust: {
          teamDomain: 'https://company.cloudflareaccess.com',
          audiences: [{ hostname: '*.void.app', audience: 'access-audience' }],
        },
      });
    },
  );

  it.each([
    { notFoundHandling: 'single-page-application', framework: undefined, type: 'void' },
    { notFoundHandling: '404-page', framework: undefined, type: 'void' },
    { notFoundHandling: 'single-page-application', framework: 'nuxt', type: 'framework' },
  ])(
    'rolls back a retained $type Worker with $notFoundHandling assets without storing R2 bundles',
    async ({ notFoundHandling, framework, type }) => {
      const user = await createTestUser(env.db, 'retained-worker', 'github', undefined, 'solo');
      const project = await createTestProject(env.db, user.id, 'retained-worker');
      const cf = mockCfApi();
      const put = vi.spyOn(env.STATIC_ASSETS_R2, 'put');

      // Omitted type and workerMain are accepted on the wire. Persist the
      // Worker identity so asset fallback settings cannot make rollback static.
      const first = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          manifest: {
            version: 3,
            bindings: {},
            ...(framework ? { framework } : {}),
            assetConfig: { not_found_handling: notFoundHandling },
          },
        }),
        env,
      );
      expect(first.status).toBe(200);
      const original = requireEvent<DoneEvent>(await readAllEvents(first), 'done');
      const row = await getDeployment(env.db, original.deployment);
      expect(row?.bundle_stored).toBe(false);
      expect(JSON.parse(row!.manifest!)).toMatchObject({ type });

      const second = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          workers: { 'index.js': "export default { fetch() { return new Response('v2'); } }" },
        }),
        env,
      );
      expect(second.status).toBe(200);
      const latest = requireEvent<DoneEvent>(await readAllEvents(second), 'done');
      expect(latest.deployment).not.toBe(original.deployment);
      const workerName = `user-${project.slug}-${original.deployment}`;
      expect(cf.state.hostScripts.has(workerName)).toBe(true);
      const workerUploads = () =>
        cf.state.recordedCalls.filter(
          (call) => call.method === 'PUT' && call.url.includes('/scripts/'),
        ).length;
      const uploadsBeforeRollback = workerUploads();

      const rollback = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deploymentId: original.deployment }),
        }),
        env,
      );
      expect(rollback.status).toBe(200);
      expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({ workerName, type });
      expect((await getProject(env.db, project.id))?.type).toBe(type);
      expect(workerUploads()).toBe(uploadsBeforeRollback);
      expect(put.mock.calls.some(([key]) => key.startsWith('worker-bundles/'))).toBe(false);
      expect(
        (await env.STATIC_ASSETS_R2.list({ prefix: `worker-bundles/${project.id}/` })).objects,
      ).toEqual([]);
    },
  );

  it('stores ssr flag in KV routing when manifest enables ssr', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ssr-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {}, ssr: true },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get('ssr-app', 'json');
    expect(routing).toEqual({
      workerName: expect.stringMatching(/^user-ssr-app-dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'void',
      ssr: true,
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });
  });

  it('sends worker upload to correct CF API endpoint', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    await res.text();

    // Find the worker upload call
    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();
    const uploadUrl =
      typeof uploadCall![0] === 'string' ? uploadCall![0] : uploadCall![0].toString();
    expect(uploadUrl).toContain(
      `/accounts/${CF_ACCOUNT_ID}/workers/dispatch/namespaces/void-users/scripts/user-worker-app-dpl_`,
    );
  });

  it('syncs cron schedules to CronScheduler DO on deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-app');
    mockCfApi();

    // Track DO fetch calls
    const cronDoFetches: Array<{ url: string; body: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = await req.text();
          cronDoFetches.push({ url: req.url, body });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };
    // Cron sync runs in waitUntil — capture and await it before assertions.
    const { ctx, pending } = createWaitUntilTrackingCtx();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          schedules: [{ name: 'sync', cron: '0 * * * *' }],
        },
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(pending);

    // Verify DO received /sync with correct payload
    const syncCall = cronDoFetches.find((f) => f.url.includes('/sync'));
    expect(syncCall).toBeDefined();
    const payload = JSON.parse(syncCall!.body);
    expect(payload.workerName).toMatch(/^user-cron-app-dpl_/);
    expect(payload.schedules).toEqual([{ name: 'sync', cron: '0 * * * *' }]);
    expect(payload.proxyToken).toEqual(expect.any(String));
    expect(payload.proxyToken.length).toBeGreaterThan(0);
  });

  it('fails cutover and restores routing and cron state when cron sync is unavailable', async () => {
    mockSetTimeout();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-sync-failure');
    mockCfApi();
    const previousRouting = JSON.stringify({
      workerName: 'user-cron-sync-failure-dpl_live',
      projectId: project.id,
      version: 'dpl_live',
      hasCrons: true,
    });
    await env.ROUTING.put(project.slug, previousRouting);
    await env.db.insert(domains).values({
      id: 'dom_compensation_failure',
      project_id: project.id,
      hostname: 'undo-failure.example.com',
      cf_hostname_id: 'ch-compensation-failure',
      status: 'active',
    });
    const previousCronState = {
      workerName: 'user-cron-sync-failure-dpl_live',
      schedules: [{ name: 'old', cron: '0 * * * *' }],
      proxyToken: 'old-token',
    };
    const syncedStates: Array<typeof previousCronState> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === '/snapshot') {
            return Response.json({ state: previousCronState });
          }
          const state = (await request.json()) as typeof previousCronState;
          syncedStates.push(state);
          if (state.workerName !== previousCronState.workerName) {
            return new Response('unavailable', { status: 503 });
          }
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    const domainKey = 'domain:undo-failure.example.com';
    let domainRestoreFailed = false;
    vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      if (key === domainKey && !domainRestoreFailed) {
        domainRestoreFailed = true;
        throw new Error('injected first compensation failure');
      }
      return originalDelete(key);
    });

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          schedules: [{ name: 'new', cron: '*/5 * * * *' }],
        },
      }),
      { ...env, CRON_SCHEDULER: cronSchedulerMock },
    );
    const events = await readAllEvents(res);

    expect(events.some((event) => (event as DeployEvent).event === 'done')).toBe(false);
    expect(events.some((event) => (event as DeployEvent).event === 'error')).toBe(true);
    expect(domainRestoreFailed).toBe(true);
    // The failed custom-domain undo is first in reverse order. The slug
    // restoration must still run instead of being skipped after that error.
    expect(await env.ROUTING.get(project.slug)).toBe(previousRouting);
    expect(syncedStates.at(-1)).toEqual(previousCronState);
  });

  it('clears cron schedules when previous deploy had crons', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-cron-app');
    mockCfApi();

    // Simulate previous deploy having crons by setting hasCrons in routing entry
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: `user-${project.slug}`, hasCrons: true }),
    );

    const cronDoFetches: Array<{ url: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronDoFetches.push({ url: req.url });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {} },
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify DO received /clear
    const clearCall = cronDoFetches.find((f) => f.url.includes('/clear'));
    expect(clearCall).toBeDefined();
  });

  it('static deploy clears CronScheduler DO when previous PG manifest had schedules even if KV hasCrons is missing', async () => {
    // KV's `hasCrons` flag is only written when true, so KV entries from
    // older code paths or pre-`hasCrons` deploys have it missing. Gating the
    // static-only deploy's /clear on it would leave the cron DO firing
    // against a script we just deleted. PG's previous live manifest is the
    // authoritative source, as on the rollback path in `routes/projects.ts`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-from-cron');
    mockCfApi();

    // Pre-seed a live deployment whose PG manifest carries cron schedules…
    const liveDeployId = 'dpl_live_cronsched';
    const liveManifest = {
      version: 3,
      bindings: {},
      schedules: [{ name: 'job', cron: '0 * * * *' }],
    };
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(liveManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // …but the KV routing entry pre-dates the `hasCrons` flag, so it's
    // missing.
    await env.ROUTING.put(project.slug, JSON.stringify({ workerName: `user-${project.slug}` }));

    const cronDoFetches: Array<{ url: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronDoFetches.push({ url: req.url });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };

    // Static deploy: no worker files, manifest.type='spa' to take the
    // static branch.
    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'spa',
        assets: { 'index.html': '<html>static</html>' },
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    const clearCall = cronDoFetches.find((f) => f.url.includes('/clear'));
    expect(clearCall).toBeDefined();
  });

  it('pre-routing failure does not disable previous deployment crons', async () => {
    // Cron sync runs AFTER the routing switch. A failure before cutover (ISR
    // clear, prerender, …) must NOT touch the cron DO, or the failure-cleanup
    // `/clear` would wipe the still-live previous deployment's crons even
    // though routing never moved.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-pre-fail');
    mockCfApi();

    // Pre-seed a live deployment with cron schedules — the previous live
    // deploy whose CronScheduler DO state must remain intact.
    const liveDeployId = 'dpl_live_pre_fail';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify({
        version: 3,
        bindings: {},
        schedules: [{ name: 'old', cron: '0 * * * *' }],
      }),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    const cronDoFetches: Array<{ url: string; body: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = await req.text().catch(() => '');
          cronDoFetches.push({ url: req.url, body });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    // Force a pre-routing failure. `clearIsrCache` (step 3) is the first
    // step after cancellation checks that is NOT wrapped in a try/catch —
    // an `ISR_CACHE.list` throw bubbles straight to the outer catch.
    const failingIsrCache = {
      list: async () => {
        throw new Error('ISR list failed');
      },
      put: async () => {},
      delete: async () => {},
      get: async () => null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace;

    const testEnv = {
      ...env,
      CRON_SCHEDULER: cronSchedulerMock,
      ISR_CACHE: failingIsrCache,
    };

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          // The new deploy also declares schedules — we want to be sure
          // we didn't /sync to the new (failing) worker either.
          schedules: [{ name: 'new', cron: '*/5 * * * *' }],
        },
      }),
      testEnv,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Deploy must be marked failed (pre-routing throw → catch's
    // !routingSwitched branch).
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id))
      .orderBy(desc(deployments.created_at))
      .limit(1);
    expect(dpl?.status).toBe('failed');

    // The cron DO MUST NOT have been touched — neither /sync nor /clear.
    // The previous deployment's cron state is still in the DO untouched.
    expect(cronDoFetches).toEqual([]);
  });

  it('clears CronScheduler DO unconditionally when no crons present (KV hasCrons gate is unreliable)', async () => {
    // The previous-deploy KV `hasCrons` flag is unreliable as a gate — it's
    // only written when true, so older entries or paths that didn't
    // propagate it have it missing. `/clear` is idempotent (deleteAll +
    // deleteAlarm, both no-ops on empty DOs) so we call it unconditionally
    // for no-cron deploys; this matches the static-only deploy and the
    // project-deletion path.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'plain-app');
    mockCfApi();

    const cronDoFetches: Array<{ url: string }> = [];
    const cronSchedulerMock = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          cronDoFetches.push({ url: req.url });
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;

    const testEnv = { ...env, CRON_SCHEDULER: cronSchedulerMock };
    // Cron clear runs in waitUntil — capture and await it before assertions.
    const { ctx, pending } = createWaitUntilTrackingCtx();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {} },
      }),
      testEnv,
      ctx,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(pending);

    // /clear was called even though there's no prior live deploy with crons.
    const clearCall = cronDoFetches.find((f) => f.url.includes('/clear'));
    expect(clearCall).toBeDefined();
    // No /sync — there are no schedules to register.
    expect(cronDoFetches.find((f) => f.url.includes('/sync'))).toBeUndefined();
  });

  it('provisions D1 when manifest requires it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'd1-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: { d1: ['DB'] } },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify resource row was created in DB
    const [resource] = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe('d1-test-uuid');
    expect(resource!.binding_name).toBe('DB');
  });

  it('skips provisioning when resource already exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'existing-d1');
    const fetchMock = mockCfApi();

    // Pre-insert a resource
    await env.db.insert(resources).values({
      id: 'res_existing',
      project_id: project.id,
      type: 'd1',
      cf_id: 'existing-d1-uuid',
      binding_name: 'DB',
    });

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: { d1: ['DB'] } },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify no D1 creation call was made
    const createD1Call = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/d1/database') &&
        !url.includes('/query') &&
        (call[1] as RequestInit)?.method === 'POST'
      );
    });
    expect(createD1Call).toBeUndefined();
  });

  it('runs migrations via worker after upload (v3 flow)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'migrate-app');

    mockCfApi({
      createD1: () => cfSuccess({ uuid: 'd1-migrate-uuid', name: 'test-db' }),
    });

    // Mock the DISPATCH namespace so the deploy route can call the worker's
    // readiness probe and migration endpoint
    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/__void/migrate/capabilities') {
            return sqliteMigrationCapabilities();
          }
          if (url.pathname === '/__void/ready') {
            return Response.json({ ready: true });
          }
          return Response.json({
            ok: true,
            protocolVersion: 2,
            confirmedApplied: ['001_create_table.sql'],
            migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 5 }],
          });
        },
      }),
    } as unknown as DispatchNamespace;

    try {
      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          manifest: {
            version: 3,
            bindings: { d1: ['DB'] },
            migrations: SQLITE_MIGRATIONS,
          },
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);

      expect(requireEvent<DeployEvent>(events, 'worker_readiness')).toBeDefined();

      const migrationStart = requireEvent<MigrationStartEvent>(events, 'migration_start');
      expect(migrationStart.pending).toBe(1);

      const migration = requireEvent<MigrationEvent>(events, 'migration');
      expect(migration.name).toBe('001_create_table.sql');

      const done = requireEvent<DoneEvent>(events, 'done');
      expect(done.migrations).toBe(1);
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  it('updates KV routing for active custom domains on deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-deploy');
    mockCfApi();

    // Insert an active domain
    await env.db.insert(domains).values({
      id: 'dom_deploy',
      project_id: project.id,
      hostname: 'deploy.example.com',
      cf_hostname_id: 'ch-deploy',
      status: 'active',
    });

    // Insert a pending domain (should NOT get KV routing)
    await env.db.insert(domains).values({
      id: 'dom_pending',
      project_id: project.id,
      hostname: 'pending.example.com',
      cf_hostname_id: 'ch-pending',
      status: 'pending',
    });

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.url).toBe('https://deploy.example.com');
    expect(done.urls).toContain('https://deploy.example.com');
    expect(done.urls).toContain('https://domain-deploy.void.app');

    // Verify domain KV routing was written
    const domainRouting = await env.ROUTING.get('domain:deploy.example.com', 'json');
    expect(domainRouting).toEqual({
      workerName: expect.stringMatching(/^user-domain-deploy-dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'void',
      version: expect.stringMatching(/^dpl_/),
      limits: { cpuMs: 10, subRequests: 50 },
    });

    // Verify pending domain was NOT written
    const pendingRouting = await env.ROUTING.get('domain:pending.example.com');
    expect(pendingRouting).toBeNull();
  });

  it('returns 429 when deploy count exceeds plan limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'limit-app');
    mockCfApi();

    // Insert 100 deployments created today (free tier limit)
    for (let i = 0; i < 100; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_limit_${i}`,
        project_id: project.id,
        status: 'live',
        manifest: '{}',
        created_at: sql`now()`,
      });
    }

    await env.db
      .update(projects)
      .set({ active_deployment_id: 'dpl_limit_99' })
      .where(eq(projects.id, project.id));

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const errorEvent = requireEvent<ErrorEvent>(events, 'error');
    expect(errorEvent.message).toBe('deploy limit exceeded');
  });

  it('allows deploy when under plan limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'under-limit-app');
    mockCfApi();

    // Insert 99 deployments (under free tier limit of 100)
    for (let i = 0; i < 99; i++) {
      await env.db.insert(deployments).values({
        id: `dpl_under_${i}`,
        project_id: project.id,
        status: 'live',
        manifest: '{}',
        created_at: sql`now()`,
      });
    }

    await env.db
      .update(projects)
      .set({ active_deployment_id: 'dpl_under_98' })
      .where(eq(projects.id, project.id));

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    // Drain the NDJSON stream so the deploy IIFE (which holds deployments-table
    // writes) finishes before the next beforeEach runs clearTables.
    await readAllEvents(res);
  });

  it('includes limits in KV routing entry matching user plan', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'limits-kv-app');
    mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    await res.text();

    const routing = (await env.ROUTING.get('limits-kv-app', 'json')) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 10, subRequests: 50 });
  });

  it('omits limits for custom plan (all unlimited)', async () => {
    const user = await createTestUser(env.db, 'customuser', 'github', undefined, 'custom');
    const project = await createTestProject(env.db, user.id, 'custom-plan-app');
    mockCfApi();

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    await res.text();

    const routing = (await env.ROUTING.get('custom-plan-app', 'json')) as Record<string, unknown>;
    expect(routing.limits).toBeUndefined();
  });

  it('rejects a manifest limits.cpuMs above the plan ceiling with both numbers', async () => {
    const user = await createTestUser(env.db, 'prolimituser', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'over-ceiling-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {}, limits: { cpuMs: 60_000 } },
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { event: string; message: string };
    expect(body.event).toBe('error');
    expect(body.message).toBe('limits.cpuMs 60000 exceeds your plan maximum of 30000');

    // Rejected before the claim transaction — no deployment row was created.
    const rows = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(rows).toEqual([]);
  });

  it.each([
    [
      { 'index.js': 'export default {};', metadata: '{}' },
      {},
      'workerFiles entry "metadata" is reserved',
    ],
    [
      { 'index.js': 'export default {};', '../x.js': 'x' },
      {},
      'workerFiles entry "../x.js" must not contain empty, "." or ".." path segments',
    ],
    [
      { 'index.js': 'export default {};' },
      { workerMain: 'entry.mjs' },
      'workerFiles must include the main module "entry.mjs"',
    ],
  ])(
    'rejects invalid worker module sets before admitting the deploy (%#)',
    async (workers, manifest, message) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'bad-module-name');
      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          manifest: { version: 3, bindings: {}, type: 'void', ...manifest },
          workers,
        }),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ event: 'error', message });
      const rows = await env.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(rows).toEqual([]);
    },
  );

  it('accepts a manifest limits.cpuMs under the plan ceiling and routes with it', async () => {
    const user = await createTestUser(env.db, 'prolimituser2', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'under-ceiling-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {}, limits: { cpuMs: 500 } },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    requireEvent<DoneEvent>(events, 'done');

    const routing = (await env.ROUTING.get('under-ceiling-app', 'json')) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 500, subRequests: 1000 });
  });

  it('accepts a manifest limits.cpuMs exactly at the plan ceiling', async () => {
    const user = await createTestUser(env.db, 'prolimituser3', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'at-ceiling-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {}, limits: { cpuMs: 30_000 } },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    requireEvent<DoneEvent>(events, 'done');

    const routing = (await env.ROUTING.get('at-ceiling-app', 'json')) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 30_000, subRequests: 1000 });
  });

  it('passes an unbounded limits.cpuMs through for the custom plan (no ceiling)', async () => {
    const user = await createTestUser(env.db, 'customlimituser', 'github', undefined, 'custom');
    const project = await createTestProject(env.db, user.id, 'custom-ceiling-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {}, limits: { cpuMs: 300_000 } },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await readAllEvents(res);

    const routing = (await env.ROUTING.get('custom-ceiling-app', 'json')) as {
      limits: { cpuMs: number };
    };
    // subRequests stays absent (custom plan value is 0 = unlimited).
    expect(routing.limits).toEqual({ cpuMs: 300_000 });
  });

  it('includes manifest vars as plain_text bindings in worker upload', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'vars-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          vars: { API_URL: 'https://api.example.com', NODE_ENV: 'production' },
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; text?: string }>;
    };

    const plainTextBindings = (metadata.bindings ?? []).filter((b) => b.type === 'plain_text');
    expect(plainTextBindings).toEqual(
      expect.arrayContaining([
        { type: 'plain_text', name: 'API_URL', text: 'https://api.example.com' },
        { type: 'plain_text', name: 'NODE_ENV', text: 'production' },
      ]),
    );
  });

  it('injects worker secrets as secret_text bindings and auto-creates BETTER_AUTH_SECRET', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'auth-secret-app');
    await createTestProjectSecret(env.db, env, project.id, 'OPENAI_API_KEY', 'openai-secret');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, auth: true, bindings: {} },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const setSecretCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && url.includes('/secrets');
    });
    expect(setSecretCall).toBeUndefined();

    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return (
        url.includes('/workers/dispatch/') &&
        (call[1] as RequestInit)?.method === 'PUT' &&
        !url.includes('/secrets')
      );
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; text?: string }>;
    };

    const secretBindings = (metadata.bindings ?? []).filter((b) => b.type === 'secret_text');
    expect(secretBindings).toEqual(
      expect.arrayContaining([
        { type: 'secret_text', name: 'OPENAI_API_KEY', text: 'openai-secret' },
        {
          type: 'secret_text',
          name: 'BETTER_AUTH_SECRET',
          text: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]),
    );

    const [storedSecret] = await env.db
      .select({ name: projectSecrets.name, managed_reason: projectSecrets.managed_reason })
      .from(projectSecrets)
      .where(
        sql`${projectSecrets.project_id} = ${project.id} and ${projectSecrets.name} = 'BETTER_AUTH_SECRET'`,
      );
    expect(storedSecret).toEqual({
      name: 'BETTER_AUTH_SECRET',
      managed_reason: 'auth-default',
    });
  });

  it('rejects BETTER_AUTH_SECRET in manifest vars', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'auth-secret-var-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          auth: true,
          bindings: {},
          vars: { BETTER_AUTH_SECRET: 'plaintext-secret' },
        },
      }),
      env,
    );
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    const error = requireEvent<ErrorEvent>(events, 'error');
    expect(error.message).toContain(
      'BETTER_AUTH_SECRET must be configured via project secrets, not manifest.vars',
    );
  });

  it('provisions queue and adds consumer on deploy with queues manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify queue resource was created in DB with queue_id (UUID), not queue_name
    const [resource] = await env.db
      .select({ cf_id: resources.cf_id, binding_name: resources.binding_name })
      .from(resources)
      .where(eq(resources.project_id, project.id));
    expect(resource).toBeDefined();
    expect(resource!.cf_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(resource!.binding_name).toBe('emails');

    // Verify addQueueConsumer was called with queue_id (UUID), not queue_name
    const consumerCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/queues/') && url.includes('/consumers');
    });
    expect(consumerCall).toBeDefined();
    const consumerUrl =
      typeof consumerCall![0] === 'string' ? consumerCall![0] : String(consumerCall![0]);
    expect(consumerUrl).toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('includes queue producer binding in worker upload metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-binding-app');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();

    const workerFormData = (uploadCall![1] as RequestInit).body as FormData;
    const metadataBlob = workerFormData.get('metadata');
    expect(metadataBlob).toBeInstanceOf(Blob);
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; queue_name?: string; queue_id?: string }>;
    };

    // queue_name is the deterministic name (for CF producer binding), queue_id is the UUID
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const queueBindings = (metadata.bindings ?? []).filter((b) => b.type === 'queue');
    expect(queueBindings).toEqual([
      {
        type: 'queue',
        name: 'QUEUE_EMAILS',
        queue_name: expectedQueueName,
        queue_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      },
    ]);
  });

  it('writes queue routing entry to KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-kv-app');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Verify queue routing KV entry (key uses deterministic queue name).
    // proxyToken must be present so void-dispatch can authenticate the relay
    // against the user worker's framework-generated /__void/queue endpoint.
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const queueRouting = (await env.ROUTING.get(`queue:${expectedQueueName}`, 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
      proxyToken: string;
    } | null;
    expect(queueRouting).toEqual({
      workerName: expect.stringMatching(/^user-queue-kv-app-dpl_/),
      projectId: project.id,
      queueName: 'emails',
      proxyToken: await deriveProxyToken(JWT_SECRET, project.id, 1),
    });
  });

  it('issues generation 1 on the first deploy of a new project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-kv-floor-app');
    const fetchMock = mockCfApi();
    const kvPut = vi.spyOn(env.ROUTING, 'put');

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const expected = await deriveProxyToken(JWT_SECRET, project.id, 1);
    const uploadCall = fetchMock.mock.calls.find((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : String(call[0]);
      return url.includes('/workers/dispatch/') && (call[1] as RequestInit)?.method === 'PUT';
    });
    expect(uploadCall).toBeDefined();
    const metadataBlob = ((uploadCall![1] as RequestInit).body as FormData).get('metadata');
    const metadata = JSON.parse(await (metadataBlob as Blob).text()) as {
      bindings?: Array<{ type: string; name: string; text?: string }>;
    };
    expect(metadata.bindings).toContainEqual({
      type: 'plain_text',
      name: '__VOID_PROXY_TOKEN',
      text: expected,
    });

    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const queueRouting = (await env.ROUTING.get(`queue:${expectedQueueName}`, 'json')) as {
      proxyToken: string;
    } | null;
    expect(queueRouting?.proxyToken).toBe(expected);

    const [row] = await env.db
      .select({ gen: projects.proxy_token_gen })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row!.gen).toBe(1);
    // The deployment records the generation its Worker was uploaded with.
    expect(
      await env.db
        .select({ gen: deployments.proxy_token_gen })
        .from(deployments)
        .where(eq(deployments.project_id, project.id)),
    ).toEqual([{ gen: 1 }]);
    expect(kvPut.mock.calls.map(([key]) => key)).not.toContainEqual(
      expect.stringMatching(/^proxy-token:/),
    );
    expect(
      await env.db
        .select()
        .from(projectCleanupJobs)
        .where(eq(projectCleanupJobs.kind, 'proxy-token-rotation')),
    ).toEqual([]);
  });

  it('moves a project on the legacy token to generation 1 without a rotation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-redeploy-app');
    mockCfApi();
    const deploy = async () => {
      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
      expect(res.status).toBe(200);
      await res.text();
    };
    await deploy();
    // A project whose Workers predate token generations.
    await env.db.update(projects).set({ proxy_token_gen: 0 }).where(eq(projects.id, project.id));

    await deploy();

    const [row] = await env.db
      .select({ gen: projects.proxy_token_gen })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row!.gen).toBe(1);
    expect(
      await env.db
        .select()
        .from(projectCleanupJobs)
        .where(eq(projectCleanupJobs.kind, 'proxy-token-rotation')),
    ).toEqual([]);
  });

  it('removes queue routing entries omitted by the next deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-route-removal');
    mockCfApi();

    const first = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    await first.text();

    const routingKey = `queue:${project.id.toLowerCase().replaceAll('_', '-')}-emails`;
    expect(await env.ROUTING.get(routingKey)).not.toBeNull();

    const second = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, bindings: {} },
      }),
      env,
    );
    const events = await readAllEvents(second);

    expect(events.some((event) => (event as DeployEvent).event === 'done')).toBe(true);
    expect(await env.ROUTING.get(routingKey)).toBeNull();
  });

  it('restores exact queue routing after a later routing switch fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-route-restore');
    mockCfApi();
    const manifest = {
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    };

    const first = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, { manifest }),
      env,
    );
    await first.text();

    const routingKey = `queue:${project.id.toLowerCase().replaceAll('_', '-')}-emails`;
    const previousQueueRouting = await env.ROUTING.get(routingKey);
    expect(previousQueueRouting).not.toBeNull();

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let failedSlugWrite = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key === project.slug && !failedSlugWrite) {
        failedSlugWrite = true;
        throw new Error('injected routing switch failure');
      }
      return originalPut(key, value, options);
    });

    const second = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, { manifest }),
      env,
    );
    const events = await readAllEvents(second);

    expect(events.some((event) => (event as DeployEvent).event === 'done')).toBe(false);
    expect(await env.ROUTING.get(routingKey)).toBe(previousQueueRouting);
  });

  it('does not overwrite live queue KV when a conflicting deploy fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-conflict-noclobber');
    const expectedQueueName = `${project.id}-emails`.toLowerCase().replaceAll('_', '-');
    const routingKey = `queue:${expectedQueueName}`;

    // Seed: a previously-successful deploy already owns this route.
    await env.ROUTING.put(
      routingKey,
      JSON.stringify({
        workerName: 'user-queue-conflict-noclobber-dpl_live',
        projectId: project.id,
        queueName: 'emails',
        proxyToken: 'live-token',
      }),
    );

    mockCfApi({
      addQueueConsumer: () =>
        Response.json(
          { success: false, errors: [{ code: 100, message: 'queue already has a consumer' }] },
          { status: 400 },
        ),
      listQueueConsumers: () =>
        cfSuccess([{ consumer_id: 'c_other', script: 'other-dispatch', settings: {} }]),
    });

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(events.some((e: unknown) => (e as { event: string }).event === 'error')).toBe(true);

    // The live queue route must still point at the previously-live worker —
    // the failed deploy must not overwrite it with a pointer to a new
    // worker that is about to be torn down.
    const routing = (await env.ROUTING.get(routingKey, 'json')) as {
      workerName: string;
      proxyToken: string;
    };
    expect(routing.workerName).toBe('user-queue-conflict-noclobber-dpl_live');
    expect(routing.proxyToken).toBe('live-token');
  });

  it('emits queue_consumer_conflict and fails the deploy when a different script owns the consumer', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-conflict-app');
    mockCfApi({
      addQueueConsumer: () =>
        Response.json(
          { success: false, errors: [{ code: 100, message: 'queue already has a consumer' }] },
          { status: 400 },
        ),
      listQueueConsumers: () =>
        cfSuccess([{ consumer_id: 'c_other', script: 'other-dispatch', settings: {} }]),
    });

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);

    const events = await readAllEvents(res);
    const conflict = events.find(
      (e: unknown) => (e as { event: string }).event === 'queue_consumer_conflict',
    ) as { event: string; queue: string; ownerScript: string } | undefined;
    expect(conflict).toBeDefined();
    expect(conflict!.queue).toBe('emails');
    expect(conflict!.ownerScript).toBe('other-dispatch');
    // Conflict is fatal: CI/automation clients must see a non-success
    // signal instead of a `done` event, otherwise a partially broken
    // deploy is indistinguishable from a healthy one.
    expect(events.some((e: unknown) => (e as { event: string }).event === 'done')).toBe(false);
    const errorEvent = events.find((e: unknown) => (e as { event: string }).event === 'error') as
      | { event: string; message: string }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toMatch(/queue.*emails.*other-dispatch/i);
  });

  it('streams events in pipeline order', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-test');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        assets: { 'index.html': '<h1>hi</h1>' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const eventNames = events.filter(isDeployEvent).map((event) => event.event);

    expect(eventNames[0]).toBe('start');
    expect(eventNames[eventNames.length - 1]).toBe('done');
    expect(eventNames).toContain('worker_upload');
    expect(eventNames).toContain('worker_upload_done');
  });

  it('reports the deployed asset count without the internal cache-buster', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'asset-count-test');
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        assets: {
          'index.html': '<h1>hi</h1>',
          'assets/app.js': "console.log('hi')",
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    expect(requireEvent(events, 'asset_upload')).toMatchObject({ total: 2 });
    expect(requireEvent<DoneEvent>(events, 'done').assets).toBe(2);
  });

  it('retries plain-text asset upload response and succeeds on next attempt', async () => {
    mockSetTimeout();
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'asset-text-test');
    let uploadCalls = 0;
    mockCfApi({
      assetUpload: () => {
        uploadCalls++;
        if (uploadCalls <= 1) {
          return new Response('Assets have already been uploaded.');
        }
        return cfSuccess({ jwt: 'test-completion-jwt' });
      },
    });

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        assets: { 'index.html': '<h1>hi</h1>' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('Assets have already been uploaded');
    const events = parseDeployStream(raw);
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });

  describe('retry-path behavior', () => {
    beforeEach(() => {
      mockSetTimeout();
    });

    it(
      'sanitizes error after retries exhausted on persistent plain-text session response',
      { timeout: 15_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'asset-text-error-test');
        mockCfApi({
          assetUploadSession: () => new Response('Assets have already been uploaded.'),
        });

        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            assets: { 'index.html': '<h1>hi</h1>' },
          }),
          env,
        );

        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('Assets have already been uploaded');
        const events = parseDeployStream(raw);
        expect(events.at(-1)).toMatchObject({
          event: 'error',
          step: 'asset_upload',
          message: 'asset upload session returned invalid response after retries',
        });
      },
    );

    it(
      'cleans up worker script when deploy fails before routing is switched',
      { timeout: 15_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'cleanup-pre-routing-test');
        // Worker upload always returns the plain-text bug → exhausts retries → fails before routing
        const fetchMock = mockCfApi({
          uploadWorker: () => new Response('Assets have already been uploaded.'),
        });

        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            assets: { 'index.html': '<h1>hi</h1>' },
          }),
          env,
        );
        // Consume the stream to drive the deploy handler to completion (including the catch block)
        await res.text();

        // The outer catch should have called deleteDispatchScript (DELETE to workers/dispatch/...scripts/)
        const deleteCalls = fetchMock.mock.calls.filter((args: Array<unknown>) => {
          const url = typeof args[0] === 'string' ? args[0] : '';
          const init = args[1] as RequestInit | undefined;
          return (
            url.includes('/workers/dispatch/') &&
            url.includes('/scripts/') &&
            init?.method === 'DELETE'
          );
        });
        expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
        // At least one delete should target the new worker name
        const targetedNewWorker = deleteCalls.some((args: Array<unknown>) => {
          const url = args[0] as string;
          return url.includes(`user-${project.slug}-`);
        });
        expect(targetedNewWorker).toBe(true);
      },
    );

    it('retries worker upload when CF returns plain-text asset response', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-text-test');
      let uploadCalls = 0;
      mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          if (uploadCalls <= 2) {
            return new Response('Assets have already been uploaded.');
          }
          return new Response('ok', { status: 200 });
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(3);
    });

    it(
      'sanitizes error after worker upload retries exhausted on persistent plain-text response',
      { timeout: 15_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'worker-upload-text-error-test');
        const cf = mockCfApi({
          uploadWorker: () => new Response('Assets have already been uploaded.'),
        });

        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            assets: { 'index.html': '<h1>hi</h1>' },
          }),
          env,
        );

        expect(res.status).toBe(200);
        const raw = await res.text();
        expect(raw).not.toContain('Assets have already been uploaded');
        const events = parseDeployStream(raw);
        expect(events.at(-1)).toMatchObject({
          event: 'error',
          step: 'worker_upload',
          message: 'worker upload returned an unexpected Cloudflare response',
        });
        // A plain-text reply never checks for a saved script.
        expect(dispatchScriptReads(cf)).toBe(0);
      },
    );

    it('retries worker upload after a Cloudflare 5xx', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-5xx-retry');
      let uploadCalls = 0;
      mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return uploadCalls === 1
            ? new Response('service unavailable', { status: 503 })
            : cfSuccess({});
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(2);
    });

    const dispatchScriptReads = (cf: MockCfApiHandle) =>
      cf.mock.calls.filter((args: Array<unknown>) => {
        const init = args[1] as RequestInit | undefined;
        return (
          (init?.method ?? 'GET') === 'GET' &&
          /\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/.test(String(args[0]))
        );
      }).length;

    // Collects the deploy log records written for a saved upload.
    const captureSavedUploadLogs = () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      return () =>
        warn.mock.calls.flatMap(([line]) => {
          try {
            const record = JSON.parse(String(line)) as Record<string, unknown>;
            return record.msg === 'saved_despite_failure' ? [record] : [];
          } catch {
            return [];
          }
        });
    };

    it('marks deployment failed when worker upload fails', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'fail-app');
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return new Response('internal error', { status: 500 });
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
      expect(res.status).toBe(200);
      const events = await readAllEvents(res);
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.message).toContain('worker upload failed: internal error');
      expect(error.step).toBe('worker_upload');
      expect(uploadCalls).toBe(4);
      expect(dispatchScriptReads(cf)).toBe(1);

      // Verify deployment is marked failed with error message
      const [dpl] = await env.db
        .select({ status: deployments.status, error_message: deployments.error_message })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(dpl?.status).toBe('failed');
      expect(dpl?.error_message).toContain('worker upload failed:');
    });

    it('retries worker upload after a transport error', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-transport-retry');
      const worker = "export default { fetch() { return new Response('retried'); } }";
      const received: Array<string> = [];
      mockCfApi({
        uploadWorker: async (_url, init) => {
          received.push(await ((init!.body as FormData).get('index.js') as Blob).text());
          if (received.length === 1) {
            throw new TypeError('fetch failed');
          }
          return cfSuccess({});
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, { workers: { 'index.js': worker } }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      // The second attempt sent the whole module again.
      expect(received).toEqual([worker, worker]);
    });

    it('fails with the transport error after the last attempt', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-transport-fail');
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          throw new TypeError('fetch failed');
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({
        event: 'error',
        step: 'worker_upload',
        message: 'fetch failed',
      });
      expect(uploadCalls).toBe(4);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    // The headers arrive, then the connection drops while the body is read.
    const brokenBodyResponse = (status: number) =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
        { status },
      );

    it('retries worker upload when the response body fails after a 5xx', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-5xx-body-retry');
      let uploadCalls = 0;
      mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return uploadCalls === 1 ? brokenBodyResponse(503) : cfSuccess({});
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(2);
    });

    it('retries worker upload when a 2xx response body fails', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-2xx-body-retry');
      let uploadCalls = 0;
      mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return uploadCalls === 1 ? brokenBodyResponse(200) : cfSuccess({});
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(2);
    });

    it.each([400, 429])('does not retry a worker upload rejected with %i', async (status) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `worker-upload-rejected-${status}`);
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return new Response('rejected', {
            status,
            headers: status === 429 ? { 'Retry-After': '1' } : {},
          });
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('worker upload failed:');
      expect(uploadCalls).toBe(1);
      expect(dispatchScriptReads(cf)).toBe(0);
    });

    it.each([400, 429])(
      'does not retry a worker upload rejected with %i when its body drops',
      async (status) => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(
          env.db,
          user.id,
          `worker-upload-rejected-body-${status}`,
        );
        let uploadCalls = 0;
        const cf = mockCfApi({
          uploadWorker: () => {
            uploadCalls++;
            return brokenBodyResponse(status);
          },
        });

        const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        const error = requireEvent<ErrorEvent>(events, 'error');
        expect(error.step).toBe('worker_upload');
        expect(error.message).toContain(`worker upload failed (HTTP ${status})`);
        expect(uploadCalls).toBe(1);
        expect(dispatchScriptReads(cf)).toBe(0);
      },
    );

    const timeoutError = () =>
      new DOMException('The operation was aborted due to timeout', 'TimeoutError');

    it('retries a worker upload attempt that times out', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-timeout-retry');
      const signals: Array<AbortSignal | null | undefined> = [];
      mockCfApi({
        uploadWorker: (_url, init) => {
          signals.push(init?.signal);
          if (signals.length === 1) {
            throw timeoutError();
          }
          return cfSuccess({});
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(signals).toHaveLength(2);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[1]).toBeInstanceOf(AbortSignal);
      // Each attempt has its own timer.
      expect(signals[1]).not.toBe(signals[0]);
    });

    it('reports a timeout after the last worker upload attempt', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-timeout-fail');
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          throw timeoutError();
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('did not finish within 120 seconds');
      expect(uploadCalls).toBe(4);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    // Cloudflare stores the script, but the platform never sees its answer.
    async function saveScript(
      cf: MockCfApiHandle,
      url: string,
      init: RequestInit | undefined,
      migrationTag?: string,
    ): Promise<string | undefined> {
      const metadata = JSON.parse(await ((init!.body as FormData).get('metadata') as Blob).text());
      return cf.seedHostScript({
        scriptName: url.slice(url.lastIndexOf('/') + 1),
        migrationTag: migrationTag ?? metadata.migrations?.new_tag,
        bindings: metadata.bindings,
        metadata,
      }).migration_tag;
    }

    const tokenConsumed = () => cfError('Completion token has already been consumed', 400, 100312);
    const tagMoved = () =>
      cfError("Actor migration tag precondition failed, got tag ''", 412, 10079);

    const websocketManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [
          {
            pattern: '/ws/chat/:room',
            filePath: 'routes/ws/chat/[room].ws.ts',
            className: 'WsChatRoomWs',
            bindingName: 'CHAT_ROOM',
            mode: 'room',
            hasAuthGate: false,
          },
        ],
        classes: ['WsChatRoomWs'],
        migrations: [{ tag: 'ws-v1', newClasses: ['WsChatRoomWs'] }],
      },
    };

    it('treats an upload saved before a 5xx as done', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-saved-5xx');
      const savedLogs = captureSavedUploadLogs();
      let uploadCalls = 0;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            await saveScript(cf, url, init);
            return new Response('service unavailable', { status: 503 });
          }
          return tokenConsumed();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(2);
      expect(dispatchScriptReads(cf)).toBe(1);
      const logs = savedLogs();
      expect(logs).toEqual([
        expect.objectContaining({
          attempt: 1,
          maxAttempts: 4,
          latencyMs: expect.any(Number),
          status: 400,
          cfCode: 100312,
          bodyPreview: expect.stringContaining('100312'),
        }),
      ]);
      // `code` names the failure kind; Cloudflare's number has its own field.
      expect(logs[0]).not.toHaveProperty('code');
    });

    it('treats a saved migration tag as done', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-saved-tag');
      let uploadCalls = 0;
      let savedTag: string | undefined;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            savedTag = await saveScript(cf, url, init);
            throw new TypeError('fetch failed');
          }
          return tagMoved();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, { manifest: websocketManifest }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(savedTag).toBe('ws-v1');
      expect(uploadCalls).toBe(2);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    it('treats an upload saved before a plain-text reply as done', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-saved-text');
      let uploadCalls = 0;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            await saveScript(cf, url, init);
            return new Response('Assets have already been uploaded.');
          }
          return tokenConsumed();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(2);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    it('treats an upload saved before the last attempt times out as done', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-saved-timeout');
      const savedLogs = captureSavedUploadLogs();
      let uploadCalls = 0;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            await saveScript(cf, url, init);
            throw new TypeError('fetch failed');
          }
          throw timeoutError();
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(4);
      expect(dispatchScriptReads(cf)).toBe(1);
      expect(savedLogs()).toEqual([
        expect.objectContaining({
          attempt: 3,
          maxAttempts: 4,
          latencyMs: expect.any(Number),
          code: 'timeout',
          err: expect.stringContaining('timeout'),
        }),
      ]);
    });

    it('reports the timeout when the saved migration tag differs', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-timeout-other-tag');
      let uploadCalls = 0;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            await saveScript(cf, url, init, 'ws-v0');
          }
          throw timeoutError();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, { manifest: websocketManifest }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('did not finish within 120 seconds');
      expect(uploadCalls).toBe(4);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    it('treats an upload saved before a 5xx on the last attempt as done', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-saved-last-5xx');
      const savedLogs = captureSavedUploadLogs();
      let uploadCalls = 0;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            await saveScript(cf, url, init);
          }
          return new Response('service unavailable', { status: 503 });
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(uploadCalls).toBe(4);
      expect(dispatchScriptReads(cf)).toBe(1);
      expect(savedLogs()).toEqual([
        expect.objectContaining({
          attempt: 3,
          maxAttempts: 4,
          latencyMs: expect.any(Number),
          status: 503,
          bodyPreview: 'service unavailable',
        }),
      ]);
    });

    it('does not check for a saved upload after an unrelated rejection', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-other-rejection');
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return uploadCalls === 1
            ? new Response('service unavailable', { status: 503 })
            : cfError('Uncaught SyntaxError', 400, 10021);
        },
      });

      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('worker upload failed:');
      expect(error.message).toContain('10021');
      expect(uploadCalls).toBe(2);
      expect(dispatchScriptReads(cf)).toBe(0);
    });

    it('fails when the saved migration tag differs', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-other-tag');
      let uploadCalls = 0;
      const cf: MockCfApiHandle = mockCfApi({
        uploadWorker: async (url, init) => {
          uploadCalls++;
          if (uploadCalls === 1) {
            await saveScript(cf, url, init, 'ws-v0');
            return new Response('service unavailable', { status: 503 });
          }
          return tagMoved();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, { manifest: websocketManifest }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('worker upload failed:');
      expect(error.message).toContain('10079');
      expect(uploadCalls).toBe(2);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    it('fails when the script was not saved', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-not-saved');
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return uploadCalls === 1
            ? new Response('service unavailable', { status: 503 })
            : tokenConsumed();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('worker upload failed:');
      expect(error.message).toContain('100312');
      expect(uploadCalls).toBe(2);
      expect(dispatchScriptReads(cf)).toBe(1);
    });

    it('does not check for a saved upload without an earlier unclear failure', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'worker-upload-first-rejected');
      let uploadCalls = 0;
      const cf = mockCfApi({
        uploadWorker: () => {
          uploadCalls++;
          return tokenConsumed();
        },
      });

      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          assets: { 'index.html': '<h1>hi</h1>' },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      const error = requireEvent<ErrorEvent>(events, 'error');
      expect(error.step).toBe('worker_upload');
      expect(error.message).toContain('100312');
      expect(uploadCalls).toBe(1);
      expect(dispatchScriptReads(cf)).toBe(0);
    });

    it('polls readiness probe before dispatching migrations', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-dispatch-retry-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-retry-uuid', name: 'test-db' }),
      });

      let readyCalls = 0;
      let migrateCalls = 0;
      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/migrate/capabilities') {
              return sqliteMigrationCapabilities();
            }
            if (url.pathname === '/__void/ready') {
              readyCalls++;
              if (readyCalls <= 3) {
                return new Response('Assets have already been uploaded.');
              }
              return Response.json({ ready: true });
            }
            // /__void/migrate/app
            migrateCalls++;
            return Response.json({
              ok: true,
              migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 3 }],
            });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: SQLITE_MIGRATIONS,
            },
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        expect(events.at(-1)).toMatchObject({ event: 'done' });
        // Readiness probe polled 4 times (3 failures + 1 success)
        expect(readyCalls).toBe(4);
        // Migration dispatched once (worker already confirmed live)
        expect(migrateCalls).toBe(1);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it('rechecks collaborator access under the project lock before dispatching migrations', async () => {
      const owner = await createTestUser(env.db, 'migration-race-owner');
      const collaborator = await createTestUser(env.db, 'migration-race-collaborator');
      const project = await createTestProject(env.db, owner.id, 'migration-access-race');
      await env.db.insert(projectMembers).values({
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      });
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-access-race', name: 'test-db' }),
      });

      let migrateCalls = 0;
      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/migrate/capabilities') {
              return sqliteMigrationCapabilities();
            }
            if (url.pathname === '/__void/ready') {
              await env.db
                .update(projectMembers)
                .set({ role: 'reader' })
                .where(eq(projectMembers.user_id, collaborator.id));
              return Response.json({ ready: true });
            }
            migrateCalls++;
            return Response.json({
              ok: true,
              migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 1 }],
            });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const response = await app.fetch(
          await buildDeployRequest(env, project.id, collaborator.jwt, {
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: SQLITE_MIGRATIONS,
            },
          }),
          env,
        );
        expect(response.status).toBe(200);
        const events = parseDeployStream(await response.text());
        expect(events.at(-1)).toMatchObject({
          event: 'error',
          step: 'migration',
          message: expect.stringMatching(/collaborator.*project admin or owner/i),
        });
        expect(migrateCalls).toBe(0);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it('returns a clear migration error when the worker response has no migration names', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-invalid-shape-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-invalid-shape-uuid', name: 'test-db' }),
      });

      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/migrate/capabilities') {
              return sqliteMigrationCapabilities();
            }
            if (url.pathname === '/__void/ready') {
              return Response.json({ ready: true });
            }
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: SQLITE_MIGRATIONS,
            },
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        expect(events.at(-1)).toMatchObject({
          event: 'error',
          step: 'migration',
          message:
            'migration failed: migration endpoint returned invalid response: missing migrations array ({"ok":true})',
        });
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it.each(['stable', 'legacy'])(
      'uses protocol v2 app and auth migration endpoints after capability negotiation (%s SQL)',
      async (stability) => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'migrate-v2-test');
        mockCfApi({
          createD1: () => cfSuccess({ uuid: 'd1-v2-uuid', name: 'test-db' }),
        });

        const calls: Array<string> = [];
        const originalDispatch = env.DISPATCH;
        env.DISPATCH = {
          get: () => ({
            fetch: async (req: Request) => {
              const url = new URL(req.url);
              calls.push(`${req.method} ${url.pathname}`);
              if (url.pathname === '/__void/ready') {
                return Response.json({ ready: true });
              }
              if (url.pathname === '/__void/migrate/capabilities') {
                return Response.json({
                  protocolVersion: 2,
                  endpoints: {
                    app: '/__void/migrate/app',
                    auth: '/__void/migrate/auth',
                    reconcile: '/__void/migrate/app/attempt/:attemptId',
                  },
                  dialect: 'sqlite',
                  classifierVersion: 1,
                  migrationListHash:
                    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                  destructiveValidation: 'passed',
                });
              }
              if (url.pathname === '/__void/migrate/app') {
                return Response.json({
                  ok: true,
                  protocolVersion: 2,
                  attemptId: 'attempt_test',
                  confirmedApplied: ['001_create_table.sql'],
                  confirmedSkipped: [],
                  stability,
                  migrations: [
                    {
                      name: '001_create_table.sql',
                      applied: true,
                      status: 'applied',
                      stability,
                      durationMs: 2,
                    },
                  ],
                });
              }
              if (url.pathname === '/__void/migrate/auth') {
                return Response.json({ ok: true, protocolVersion: 2 });
              }
              return new Response('unexpected', { status: 500 });
            },
          }),
        } as unknown as DispatchNamespace;

        try {
          const res = await app.fetch(
            await buildDeployRequest(env, project.id, user.jwt, {
              manifest: {
                version: 3,
                auth: true,
                bindings: { d1: ['DB'] },
                migrations: {
                  dialect: 'sqlite',
                  pending: 1,
                  protocolVersion: 2,
                  classifierVersion: 1,
                  migrationListHash:
                    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                  stability,
                },
              },
            }),
            env,
          );
          expect(res.status).toBe(200);
          const events = parseDeployStream(await res.text());
          expect(events.at(-1)).toMatchObject({ event: 'done' });
          expect(calls).toContain('GET /__void/migrate/capabilities');
          expect(calls).toContain('POST /__void/migrate/app');
          expect(calls).toContain('POST /__void/migrate/auth');
          expect(calls).not.toContain('POST /__void/migrate');
        } finally {
          env.DISPATCH = originalDispatch;
        }
      },
    );

    it('persists confirmed app migrations before a protocol v2 auth failure', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-v2-auth-failure');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-v2-auth-failure', name: 'test-db' }),
      });

      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/ready') {
              return Response.json({ ready: true });
            }
            if (url.pathname === '/__void/migrate/capabilities') {
              return Response.json({
                protocolVersion: 2,
                endpoints: {
                  app: '/__void/migrate/app',
                  auth: '/__void/migrate/auth',
                  reconcile: '/__void/migrate/app/attempt/:attemptId',
                },
                dialect: 'sqlite',
                classifierVersion: 1,
                migrationListHash:
                  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                destructiveValidation: 'passed',
              });
            }
            if (url.pathname === '/__void/migrate/app') {
              return Response.json({
                ok: true,
                protocolVersion: 2,
                attemptId: 'attempt_auth_failure',
                confirmedApplied: ['001_create_table.sql'],
                confirmedSkipped: [],
                stability: 'stable',
                migrations: [
                  {
                    name: '001_create_table.sql',
                    applied: true,
                    status: 'applied',
                    stability: 'stable',
                    durationMs: 2,
                  },
                ],
              });
            }
            if (url.pathname === '/__void/migrate/auth') {
              return Response.json({ ok: false, error: 'auth schema rejected' }, { status: 500 });
            }
            return new Response('unexpected', { status: 500 });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const response = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            manifest: {
              version: 3,
              auth: true,
              bindings: { d1: ['DB'] },
              migrations: {
                dialect: 'sqlite',
                pending: 1,
                protocolVersion: 2,
                classifierVersion: 1,
                migrationListHash:
                  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
                stability: 'stable',
              },
            },
          }),
          env,
        );
        expect(response.status).toBe(200);
        expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({
          event: 'error',
          step: 'migration',
          message: 'auth migration failed: auth schema rejected',
        });

        const migrationRows = await env.db
          .select({ name: projectMigrations.name })
          .from(projectMigrations)
          .where(eq(projectMigrations.project_id, project.id));
        expect(migrationRows).toEqual([{ name: '001_create_table.sql' }]);

        const [failedDeployment] = await env.db
          .select({
            appliedMigrations: deployments.applied_migrations,
            status: deployments.status,
          })
          .from(deployments)
          .where(eq(deployments.project_id, project.id))
          .orderBy(desc(deployments.created_at))
          .limit(1);
        expect(failedDeployment?.status).toBe('failed');
        expect(JSON.parse(failedDeployment!.appliedMigrations!)).toEqual(['001_create_table.sql']);
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it.each(['postgresql', 'mysql'])(
      'runs current %s migrations without a SQLite plan',
      async (dialect) => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'migrate-external-' + dialect);
        mockCfApi();
        const calls: Array<string> = [];
        const originalDispatch = env.DISPATCH;
        env.DISPATCH = {
          get: () => ({
            fetch: async (request: Request) => {
              const url = new URL(request.url);
              calls.push(request.method + ' ' + url.pathname);
              if (url.pathname === '/__void/ready') {
                return Response.json({ ready: true });
              }
              if (url.pathname === '/__void/migrate') {
                return Response.json({
                  ok: true,
                  migrations: [{ name: '001_create_table.sql', applied: true, durationMs: 2 }],
                });
              }
              return new Response('unexpected', { status: 500 });
            },
          }),
        } as unknown as DispatchNamespace;
        try {
          const response = await app.fetch(
            await buildDeployRequest(env, project.id, user.jwt, {
              manifest: { version: 3, bindings: {}, migrations: { dialect, pending: 1 } },
            }),
            env,
          );
          expect(response.status).toBe(200);
          expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({
            event: 'done',
            migrations: 1,
          });
          expect(calls).toEqual(['GET /__void/ready', 'POST /__void/migrate']);
          const rows = await env.db
            .select({ name: projectMigrations.name })
            .from(projectMigrations)
            .where(eq(projectMigrations.project_id, project.id));
          expect(rows).toEqual([{ name: '001_create_table.sql' }]);
        } finally {
          env.DISPATCH = originalDispatch;
        }
      },
    );

    it('capability negotiation surfaces the classifierVersion skew reason', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-v2-skew-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-v2-skew-uuid', name: 'test-db' }),
      });

      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/ready') {
              return Response.json({ ready: true });
            }
            if (url.pathname === '/__void/migrate/capabilities') {
              // worker build reports a different classifierVersion than the manifest (2 vs 1)
              return Response.json({
                protocolVersion: 2,
                endpoints: {
                  app: '/__void/migrate/app',
                  auth: '/__void/migrate/auth',
                  reconcile: '/__void/migrate/app/attempt/:attemptId',
                },
                dialect: 'sqlite',
                classifierVersion: 2,
                migrationListHash:
                  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                destructiveValidation: 'passed',
              });
            }
            return new Response('unexpected', { status: 500 });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: {
                dialect: 'sqlite',
                pending: 1,
                protocolVersion: 2,
                classifierVersion: 1,
                migrationListHash:
                  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                stability: 'stable',
              },
            },
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        const last = events.at(-1) as { event: string; message: string };
        expect(last.event).toBe('error');
        expect(last.message).toContain('classifierVersion');
        expect(last.message).toContain('worker=2');
        expect(last.message).toContain('manifest=1');
        expect(last.message).not.toBe('migration protocol v2 capability negotiation failed');
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it('capability negotiation surfaces the worker error body when the probe fails', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'migrate-v2-probe-fail-test');
      mockCfApi({
        createD1: () => cfSuccess({ uuid: 'd1-v2-probe-fail-uuid', name: 'test-db' }),
      });

      const originalDispatch = env.DISPATCH;
      env.DISPATCH = {
        get: () => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === '/__void/ready') {
              return Response.json({ ready: true });
            }
            if (url.pathname === '/__void/migrate/capabilities') {
              // worker rejects the probe with a rich error body and a non-2xx status
              return Response.json(
                {
                  ok: false,
                  error: 'migration protocol v2 execution plans are missing',
                  migrations: [],
                },
                { status: 500 },
              );
            }
            return new Response('unexpected', { status: 500 });
          },
        }),
      } as unknown as DispatchNamespace;

      try {
        const res = await app.fetch(
          await buildDeployRequest(env, project.id, user.jwt, {
            manifest: {
              version: 3,
              bindings: { d1: ['DB'] },
              migrations: {
                dialect: 'sqlite',
                pending: 1,
                protocolVersion: 2,
                classifierVersion: 1,
                migrationListHash:
                  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
                stability: 'stable',
              },
            },
          }),
          env,
        );
        expect(res.status).toBe(200);
        const events = parseDeployStream(await res.text());
        const last = events.at(-1) as { event: string; message: string };
        expect(last.event).toBe('error');
        expect(last.message).toContain('execution plans are missing');
        expect(last.message).toContain('500');
      } finally {
        env.DISPATCH = originalDispatch;
      }
    });

    it.each([
      [404, 'Not Found'],
      [200, '<!DOCTYPE html><html><body>app</body></html>'],
    ])(
      'requires the current readiness response instead of accepting HTTP %s app output',
      async (status, body) => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'migrate-ready-contract');
        mockCfApi({ createD1: () => cfSuccess({ uuid: 'd1-ready-contract', name: 'test-db' }) });
        let migrateCalls = 0;
        const originalDispatch = env.DISPATCH;
        env.DISPATCH = {
          get: () => ({
            fetch: async (request: Request) => {
              if (new URL(request.url).pathname === '/__void/ready') {
                return new Response(body, { status });
              }
              migrateCalls++;
              return new Response('unexpected', { status: 500 });
            },
          }),
        } as unknown as DispatchNamespace;
        try {
          const response = await app.fetch(
            await buildDeployRequest(env, project.id, user.jwt, {
              manifest: { version: 3, bindings: { d1: ['DB'] }, migrations: SQLITE_MIGRATIONS },
            }),
            env,
          );
          expect(response.status).toBe(200);
          expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({
            event: 'error',
            step: 'migration',
            message: expect.stringContaining('worker readiness probe failed'),
          });
          expect(migrateCalls).toBe(0);
        } finally {
          env.DISPATCH = originalDispatch;
        }
      },
    );

    it(
      'fails at readiness probe when worker never becomes reachable',
      { timeout: 30_000 },
      async () => {
        const user = await createTestUser(env.db);
        const project = await createTestProject(env.db, user.id, 'migrate-dispatch-exhaust-test');
        mockCfApi({
          createD1: () => cfSuccess({ uuid: 'd1-exhaust-uuid', name: 'test-db' }),
        });

        let migrateCalls = 0;
        const originalDispatch = env.DISPATCH;
        env.DISPATCH = {
          get: () => ({
            fetch: async (req: Request) => {
              const url = new URL(req.url);
              if (url.pathname === '/__void/ready') {
                return new Response('Assets have already been uploaded.');
              }
              migrateCalls++;
              return Response.json({ ok: true, migrations: [] });
            },
          }),
        } as unknown as DispatchNamespace;

        try {
          const res = await app.fetch(
            await buildDeployRequest(env, project.id, user.jwt, {
              manifest: {
                version: 3,
                bindings: { d1: ['DB'] },
                migrations: SQLITE_MIGRATIONS,
              },
            }),
            env,
          );
          expect(res.status).toBe(200);
          const raw = await res.text();
          expect(raw).not.toContain('Assets have already been uploaded');
          const events = parseDeployStream(raw);
          expect(
            events.some((event) => isDeployEvent(event) && event.event === 'worker_readiness'),
          ).toBe(true);
          expect(
            events.some((event) => isDeployEvent(event) && event.event === 'migration_start'),
          ).toBe(false);
          expect(events.at(-1)).toMatchObject({
            event: 'error',
            step: 'migration',
            message:
              'worker readiness probe failed: new worker not reachable after retries (last readiness response was a Cloudflare asset propagation stub)',
          });
          // Migration dispatch should never be attempted
          expect(migrateCalls).toBe(0);
        } finally {
          env.DISPATCH = originalDispatch;
        }
      },
    );
  });

  it('does not delete new worker when deploy succeeds (routing switched)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'no-cleanup-success-test');
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        assets: { 'index.html': '<h1>hi</h1>' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events.at(-1)).toMatchObject({ event: 'done' });

    // Check DELETEs to dispatch scripts — the newly deployed versioned worker
    // (user-{slug}-{deploymentId}) must NOT be deleted
    const deleteCalls = fetchMock.mock.calls.filter((args: Array<unknown>) => {
      const url = typeof args[0] === 'string' ? args[0] : '';
      const init = args[1] as RequestInit | undefined;
      return (
        url.includes('/workers/dispatch/') && url.includes('/scripts/') && init?.method === 'DELETE'
      );
    });
    for (const args of deleteCalls) {
      const url = args[0] as string;
      // Retention may delete older versioned Workers. The new deployment's
      // Worker must not be deleted.
      // New deployment IDs start with "dpl_test" from createTestDeployment,
      // but deploy route creates its own ID. Just verify no delete targets a
      // versioned worker for this project (no previous deploys exist).
      if (url.includes(`user-${project.slug}-`)) {
        // This would be a versioned worker delete — shouldn't happen for a
        // project with no previous deployments
        expect(url).toBe('should not delete versioned worker');
      }
    }
  });
});

describe('Deploy deduplication (skip identical deploys)', () => {
  // assetManifestVersion: 2 mirrors what `buildDeployRequest` injects so the
  // stored live-deploy manifest matches the incoming request manifest byte-
  // for-byte (the dedupe-skip path compares the persisted JSON strings).
  const manifest = { assetManifestVersion: 2, version: 3, bindings: {} };
  const assetContent = '<h1>hi</h1>';
  let assetManifest: Record<string, { hash: string; size: number; store: 'r2'; scope: 'project' }>;

  beforeEach(async () => {
    const buffer = await new Blob([assetContent]).arrayBuffer();
    assetManifest = {
      '/index.html': {
        hash: computeAssetHash(buffer, '/index.html'),
        size: buffer.byteLength,
        store: 'r2',
        scope: 'project',
      },
    };
  });

  it('skips static-only deploy when manifest and assets are identical to live deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-app');

    // Insert a live deployment with known manifest and asset_hashes
    const liveDeployId = 'dpl_live_dedupe';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(manifest),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Deploy with the same manifest and assetManifest
    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest,
        workers: {},
        assets: { 'index.html': assetContent },
        assetManifest,
        preflight: 'true',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events).toHaveLength(2); // start + done only
    expect(events[0]).toMatchObject({ event: 'start', deploymentId: liveDeployId });
    expect(events[1]).toMatchObject({ event: 'done', deployment: liveDeployId });
  });

  it('dedupes streamed-static deploys when stored asset manifest order differs from the request', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-order-app');

    const streamedManifest = {
      assetManifestVersion: 2,
      version: 3,
      type: 'spa',
      bindings: {},
      assetConfig: { not_found_handling: 'single-page-application' as const },
    };
    const indexBody = '<h1>index</h1>';
    const appBody = 'console.log("app");';
    const indexHash = computeAssetHash(new TextEncoder().encode(indexBody).buffer, '/index.html');
    const appHash = computeAssetHash(new TextEncoder().encode(appBody).buffer, '/assets/app.js');

    // Simulate a previously stored merged manifest whose insertion order no
    // longer matches the raw JSON string the client sends on retry.
    const liveAssetManifest = {
      '/assets/app.js': { hash: appHash, size: appBody.length, store: 'r2', scope: 'project' },
      '/index.html': { hash: indexHash, size: indexBody.length, store: 'r2', scope: 'project' },
    };
    const liveDeployId = 'dpl_live_dedupe_order';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(streamedManifest),
      asset_hashes: JSON.stringify(liveAssetManifest),
      retained: true,
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${indexHash}`, indexBody);
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${appHash}`, appBody);

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: streamedManifest,
        workers: {},
        assets: {
          'index.html': indexBody,
          'assets/app.js': appBody,
        },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'start', deploymentId: liveDeployId });
    expect(events[1]).toMatchObject({ event: 'done', deployment: liveDeployId });

    const dpls = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpls).toHaveLength(1);
    expect(dpls[0]?.id).toBe(liveDeployId);
  });

  it('skips static-only deploy even when secrets changed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-secret-app');

    // Insert a live deployment created in the past
    const liveDeployId = 'dpl_live_secret';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(manifest),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now() - interval '1 hour'`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Add a secret AFTER the deployment — identical static assets should still skip
    await createTestProjectSecret(env.db, env, project.id, 'API_KEY', 'secret-value');

    // Deploy with the same manifest — should still be skipped
    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest,
        workers: {},
        assets: { 'index.html': assetContent },
        assetManifest,
        preflight: 'true',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events).toHaveLength(2); // start + done only
    expect(events[0]).toMatchObject({ event: 'start', deploymentId: liveDeployId });
    expect(events[1]).toMatchObject({ event: 'done', deployment: liveDeployId });
  });

  it('does not skip worker deploys when manifest and assets are identical', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-worker-app');
    mockCfApi();

    const liveDeployId = 'dpl_live_worker';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify(manifest),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest,
        workers: { 'index.js': "export default { fetch() { return new Response('new'); } }" },
        assets: { 'index.html': assetContent },
        assetManifest,
        preflight: 'true',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events.length).toBeGreaterThan(2);
    expect(events[0]).toMatchObject({ event: 'start' });
    expect(events[0]).not.toMatchObject({ deploymentId: liveDeployId });
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });

  it('proceeds with deploy when manifest differs from live deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'dedupe-manifest-app');
    mockCfApi();

    // Insert a live deployment with a different manifest
    const liveDeployId = 'dpl_live_diff';
    await env.db.insert(deployments).values({
      id: liveDeployId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify({ version: 3, bindings: { d1: ['DB'] } }),
      asset_hashes: JSON.stringify(assetManifest),
      created_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: liveDeployId })
      .where(eq(projects.id, project.id));

    // Deploy with a different manifest (no d1 binding)
    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest,
        assets: { 'index.html': assetContent },
        assetManifest,
        preflight: 'true',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = parseDeployStream(await res.text());
    expect(events.length).toBeGreaterThan(2);
    expect(events.at(-1)).toMatchObject({ event: 'done' });
  });
});

describe('Deploy serialization (concurrent deploy guard)', () => {
  it('returns 409 while a deploy is in progress', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'concurrent-app');
    mockCfApi();

    // Insert an active (non-terminal) deployment
    await env.db.insert(deployments).values({
      id: 'dpl_active',
      project_id: project.id,
      status: 'uploading',
      created_at: sql`now()`,
    });

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; deployment: string };
    expect(body.error).toBe('deploy in progress');
    expect(body.deployment).toBe('dpl_active');
  });

  it('fences a stale deployment before allowing a replacement deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-app');
    mockCfApi();

    // Insert a stale active deployment whose handler may still be running.
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await env.db.insert(deployments).values({
      id: 'dpl_stale',
      project_id: project.id,
      status: 'uploading',
      created_at: staleTime,
      updated_at: staleTime,
    });

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'deploy cancellation requested',
      deployment: 'dpl_stale',
    });

    // The first request only fences the old handler; it does not admit a
    // concurrent pipeline that could still mutate routing or triggers.
    const [stale] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_stale'));
    expect(stale?.status).toBe('canceling');
    expect(stale?.error_message).toBe('timed out');

    const retry = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(retry.status).toBe(409);

    // Once the old handler acknowledges cancellation, a retry may claim and
    // complete the deployment normally.
    await updateDeploymentStatus(env.db, 'dpl_stale', 'canceled', 'timed out', { force: true });
    const replacement = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(replacement.status).toBe(200);
    expect(parseDeployStream(await replacement.text()).at(-1)).toMatchObject({ event: 'done' });
  });

  it('keeps a canceling deployment active until the deploy handler observes cancellation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cancel-active-app');

    await env.db.insert(deployments).values({
      id: 'dpl_cancel_active',
      project_id: project.id,
      status: 'uploading',
      created_at: sql`now()`,
    });

    const cancelRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments/dpl_cancel_active/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toMatchObject({
      ok: true,
      deploymentId: 'dpl_cancel_active',
      status: 'canceling',
    });

    const [canceling] = await env.db
      .select({ status: deployments.status, error_message: deployments.error_message })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_cancel_active'));
    expect(canceling).toEqual({ status: 'canceling', error_message: 'canceled by user' });

    mockCfApi();
    const deployRes = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(deployRes.status).toBe(409);
    expect(await deployRes.json()).toEqual({
      error: 'deploy in progress',
      deployment: 'dpl_cancel_active',
    });

    await updateDeploymentStatus(env.db, 'dpl_cancel_active', 'migrating');
    const [stillCanceling] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_cancel_active'));
    expect(stillCanceling?.status).toBe('canceling');
  });

  it('rechecks deploy access under the project lock before cancelling', async () => {
    const owner = await createTestUser(env.db, 'cancel-race-owner');
    const collaborator = await createTestUser(env.db, 'cancel-race-collaborator');
    const project = await createTestProject(env.db, owner.id, 'cancel-access-race');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    await env.db.insert(deployments).values({
      id: 'dpl_cancel_access_race',
      project_id: project.id,
      status: 'uploading',
      created_at: sql`now()`,
    });

    const requireCapability = projectAccess.requireProjectCapability;
    let downgraded = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const result = await requireCapability(...args);
      if (!downgraded && args[3] === 'deploy') {
        downgraded = true;
        await env.db
          .update(projectMembers)
          .set({ role: 'reader' })
          .where(eq(projectMembers.user_id, collaborator.id));
      }
      return result;
    });

    const response = await app.fetch(
      new Request(
        `http://localhost/projects/${project.id}/deployments/dpl_cancel_access_race/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${collaborator.jwt}` },
        },
      ),
      env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
    expect(downgraded).toBe(true);
    expect(await getDeployment(env.db, 'dpl_cancel_access_race')).toMatchObject({
      status: 'uploading',
      error_message: null,
    });
  });

  it('does not cancel a terminal deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cancel-live-app');
    await env.db.insert(deployments).values({
      id: 'dpl_cancel_live',
      project_id: project.id,
      status: 'live',
      created_at: sql`now()`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments/dpl_cancel_live/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'deployment already completed',
      status: 'live',
    });
  });

  it('allows deploy when previous deployment is terminal (live)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'terminal-app');
    mockCfApi();

    // Insert a completed deployment
    await env.db.insert(deployments).values({
      id: 'dpl_done',
      project_id: project.id,
      status: 'live',
      created_at: sql`now()`,
    });

    await env.db
      .update(projects)
      .set({ active_deployment_id: 'dpl_done' })
      .where(eq(projects.id, project.id));

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    // Drain the NDJSON stream so the deploy IIFE (which holds deployments-table
    // writes) finishes before the next beforeEach runs clearTables.
    await readAllEvents(res);
  });

  it('persists WfP fallback placement before the deployment goes live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wfp-final-asset-fence');
    const content = '<html>worker fallback must survive</html>';
    const bytes = new TextEncoder().encode(content);
    const hash = computeAssetHash(bytes.buffer as ArrayBuffer, '/index.html');
    mockCfApi();

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        assets: { 'index.html': content },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'done' });
    const activeId = (await getProject(env.db, project.id))?.active_deployment_id;
    expect(activeId).toBeTruthy();
    const active = await getDeployment(env.db, activeId!);
    expect(JSON.parse(active!.asset_hashes!)).toMatchObject({
      '/index.html': { hash, store: 'r2' },
    });
  });
});

/** Build a JSON-mode static (SPA or 404-page) deploy request with no worker. */
async function buildStaticDeployRequest(
  env: TestEnv,
  projectId: string,
  jwt: string,
  opts: {
    type: 'spa' | 'static';
    assets?: Record<string, string | Uint8Array>;
  },
): Promise<Request> {
  const assetConfig =
    opts.type === 'spa'
      ? { not_found_handling: 'single-page-application' }
      : { not_found_handling: '404-page' };
  const manifest: Record<string, unknown> = {
    version: 3,
    type: opts.type,
    bindings: {},
    assetConfig,
  };
  return await buildDeployRequest(env, projectId, jwt, {
    manifest,
    assets: opts.assets,
    omitDefaultWorker: true,
  });
}

describe('POST /projects/:id/deploy (static)', () => {
  it('succeeds with static SPA deploy (passthrough worker)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'spa-site');
    mockCfApi();

    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'spa',
        assets: {
          'index.html': '<html>SPA</html>',
          'assets/app-abc123.js': "console.log('spa')",
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');
    expect(done.deployment).toMatch(/^dpl_/);
    expect(done.url).toBe('https://spa-site.void.app');
    expect(done.assets).toBe(2);
    expect(done.workers).toBe(0);
  });

  it('writes KV routing with staticDeploymentId for static SPA', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'kv-spa');
    mockCfApi();

    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'spa' }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const routing = await env.ROUTING.get('kv-spa', 'json');
    expect(routing).toEqual({
      staticDeploymentId: expect.stringMatching(/^dpl_/),
      projectId: project.id,
      userId: user.id,
      type: 'spa',
      assetConfig: { not_found_handling: 'single-page-application' },
      version: expect.stringMatching(/^dpl_/),
    });
  });

  it('updates project type column on static deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mode-update');
    mockCfApi();

    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [row] = await env.db
      .select({ type: projects.type })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(row?.type).toBe('static');
  });

  it('publishes freshly uploaded unchanged assets when converting legacy WfP to static', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-wfp-to-static');
    const source = await createTestDeployment(env.db, project.id, 'live');
    const content = '<html>same asset, new backend</html>';
    const bytes = new TextEncoder().encode(content);
    const hash = computeAssetHash(bytes.buffer as ArrayBuffer, '/index.html');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, bindings: {} }),
        asset_hashes: JSON.stringify({ '/index.html': { hash, size: bytes.length } }),
      })
      .where(eq(deployments.id, source.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: source.id, type: 'void' })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        workerName: `user-${project.slug}-${source.id}`,
        projectId: project.id,
        userId: user.id,
        version: source.id,
      }),
    );
    // Legacy WfP deployments predate serving-manifest mirroring.
    expect(await env.ROUTING.get(`manifest:${source.id}`)).toBeNull();

    const preflight = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hasWorker: false,
          assetManifest: { '/index.html': { hash, size: bytes.length } },
        }),
      }),
      env,
    );
    expect(await preflight.json()).toEqual({
      needed: ['/index.html'],
      total: 1,
      skipped: 0,
    });

    mockCfApi();
    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          type: 'static',
          bindings: {},
          assetConfig: { not_found_handling: '404-page' },
        },
        assets: { 'index.html': content },
        omitDefaultWorker: true,
        preflight: 'true',
      }),
      env,
    );
    expect(response.status).toBe(200);
    const events = parseDeployStream(await response.text());
    expect(events.at(-1)).toMatchObject({ event: 'done' });
    const done = events.at(-1) as { deployment: string };
    expect(await env.ROUTING.get(`manifest:${done.deployment}`, 'json')).toEqual({
      '/index.html': `!${hash}`,
    });
  });

  it('rejects WfP to static conversion when an unchanged asset was not re-uploaded', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wfp-to-static-missing-upload');
    const source = await createTestDeployment(env.db, project.id, 'live');
    const hash = '8'.repeat(32);
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, type: 'void', bindings: {} }),
        asset_hashes: JSON.stringify({ '/index.html': { hash, size: 100 } }),
      })
      .where(eq(deployments.id, source.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: source.id, type: 'void' })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        workerName: `user-${project.slug}-${source.id}`,
        projectId: project.id,
        userId: user.id,
        version: source.id,
      }),
    );

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          type: 'static',
          bindings: {},
          assetConfig: { not_found_handling: '404-page' },
        },
        omitDefaultWorker: true,
        assetManifest: { '/index.html': { hash, size: 100 } },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({
      event: 'error',
      message: expect.stringContaining('declared asset hash not found in R2'),
    });
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(source.id);
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      workerName: `user-${project.slug}-${source.id}`,
    });
  });

  it('persists static R2 placement before the deployment goes live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-final-asset-fence');
    const content = '<html>must survive until commit</html>';
    const bytes = new TextEncoder().encode(content);
    const hash = computeAssetHash(bytes.buffer as ArrayBuffer, '/index.html');
    mockCfApi();

    const response = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'static',
        assets: { 'index.html': content },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'done' });
    const activeId = (await getProject(env.db, project.id))?.active_deployment_id;
    expect(activeId).toBeTruthy();
    const active = await getDeployment(env.db, activeId!);
    expect(JSON.parse(active!.asset_hashes!)).toEqual({
      '/index.html': { hash, size: bytes.length, store: 'r2', scope: 'project' },
    });
  });

  it('keeps an aged asset claimed by a deployment that becomes in-flight during GC', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-inflight-asset-fence');
    const protectedDeployment = await createTestDeployment(env.db, project.id, 'failed');
    const protectedHash = '9'.repeat(32);
    const protectedKey = `assets/${project.id}/${protectedHash}`;
    await env.db
      .update(deployments)
      .set({
        asset_hashes: JSON.stringify({
          '/pending.js': { hash: protectedHash, size: 100, store: 'r2' },
        }),
      })
      .where(eq(deployments.id, protectedDeployment.id));
    await env.STATIC_ASSETS_R2.put(protectedKey, new TextEncoder().encode('pending asset'));

    const oldUpload = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const originalList = env.STATIC_ASSETS_R2.list.bind(env.STATIC_ASSETS_R2);
    const originalHead = env.STATIC_ASSETS_R2.head.bind(env.STATIC_ASSETS_R2);
    let transactionDepth = 0;
    const listSpy = vi.spyOn(env.STATIC_ASSETS_R2, 'list').mockImplementation(async (options) => {
      expect(transactionDepth).toBe(0);
      const result = await originalList(options);
      for (const object of result.objects) {
        if (object.key === protectedKey) {
          Object.defineProperty(object, 'uploaded', { configurable: true, value: oldUpload });
        }
      }
      return result;
    });
    const headSpy = vi.spyOn(env.STATIC_ASSETS_R2, 'head').mockImplementation(async (key) => {
      const object = await originalHead(key);
      if (object && key === protectedKey) {
        Object.defineProperty(object, 'uploaded', { configurable: true, value: oldUpload });
      }
      return object;
    });

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    const wrappedDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (async (callback: Parameters<typeof realTransaction>[0]) =>
            realTransaction(async (tx) => {
              transactionDepth++;
              try {
                return await callback(tx);
              } finally {
                transactionDepth--;
              }
            })) as typeof realDb.transaction;
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    mockCfApi();
    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    let insertedPending = false;
    vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      await originalDelete(key);
      if (!insertedPending && key.startsWith('cutover-ready:')) {
        insertedPending = true;
        await realDb
          .update(deployments)
          .set({ status: 'pending' })
          .where(eq(deployments.id, protectedDeployment.id));
      }
    });

    try {
      const response = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' }),
        env,
      );
      expect(response.status).toBe(200);
      expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'done' });
      expect(insertedPending).toBe(true);
      expect(await env.STATIC_ASSETS_R2.head(protectedKey)).not.toBeNull();
    } finally {
      setTestDb(realDb);
      listSpy.mockRestore();
      headSpy.mockRestore();
    }
  });

  it('preserves retained Worker scripts for rollback after a static deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-retains-worker');
    const workerDeploymentId = 'dpl_retained_worker';
    await env.db.insert(deployments).values({
      id: workerDeploymentId,
      project_id: project.id,
      status: 'live',
      manifest: JSON.stringify({ version: 4, type: 'void', bindings: {} }),
      retained: true,
      deployed_at: sql`now()`,
    });
    await env.db
      .update(projects)
      .set({ active_deployment_id: workerDeploymentId, type: 'void' })
      .where(eq(projects.id, project.id));
    const fetchMock = mockCfApi();

    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(parseDeployStream(await res.text()).at(-1)).toMatchObject({ event: 'done' });

    const retainedWorkerUrl = `/scripts/user-${project.slug}-${workerDeploymentId}`;
    const retainedWorkerDeletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : '';
      const init = call[1] as RequestInit | undefined;
      return url.includes(retainedWorkerUrl) && init?.method === 'DELETE';
    });
    expect(retainedWorkerDeletes).toHaveLength(0);
    expect((await getDeployment(env.db, workerDeploymentId))?.retained).toBe(true);
  });

  it('does not evict a retained Worker that a concurrent rollback made active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-retention-rollback-race');
    const rollbackAssetBody = new TextEncoder().encode('live rollback asset');
    const rollbackAssetHash = computeAssetHash(
      rollbackAssetBody.buffer as ArrayBuffer,
      '/rollback.txt',
    );
    const retainedRows = Array.from({ length: 100 }, (_, index) => {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      return {
        id: `dpl_static_retained_${index.toString().padStart(3, '0')}`,
        project_id: project.id,
        status: 'live' as const,
        manifest: JSON.stringify({ version: 4, type: 'void', bindings: {} }),
        asset_hashes:
          index === 0
            ? JSON.stringify({
                '/rollback.txt': { hash: rollbackAssetHash, size: rollbackAssetBody.length },
              })
            : null,
        retained: true,
        created_at: timestamp,
        updated_at: timestamp,
        deployed_at: timestamp,
      };
    });
    const rollbackTarget = retainedRows[0];
    await env.db.insert(deployments).values(retainedRows);
    await env.STATIC_ASSETS_R2.put(
      `assets/${project.id}/${rollbackAssetHash}`,
      rollbackAssetBody as unknown as ArrayBuffer,
    );
    await env.db
      .update(projects)
      .set({ active_deployment_id: rollbackTarget.id, type: 'void' })
      .where(eq(projects.id, project.id));

    // Model rollback after cutover commits, before the retention inventory.
    const fetchMock = mockCfApi();
    const originalDelete = env.ROUTING.delete.bind(env.ROUTING);
    let rolledBack = false;
    vi.spyOn(env.ROUTING, 'delete').mockImplementation(async (key) => {
      await originalDelete(key);
      if (!rolledBack && key.startsWith('cutover-ready:')) {
        rolledBack = true;
        await env.db
          .update(projects)
          .set({ active_deployment_id: rollbackTarget.id, type: 'void' })
          .where(eq(projects.id, project.id));
      }
    });

    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(parseDeployStream(await res.text()).at(-1)).toMatchObject({ event: 'done' });

    expect(rolledBack).toBe(true);
    const targetWorkerUrl = `/scripts/user-${project.slug}-${rollbackTarget.id}`;
    const targetDeletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
      const url = typeof call[0] === 'string' ? call[0] : '';
      const init = call[1] as RequestInit | undefined;
      return url.includes(targetWorkerUrl) && init?.method === 'DELETE';
    });
    expect(targetDeletes).toHaveLength(0);
    expect((await getDeployment(env.db, rollbackTarget.id))?.retained).toBe(true);
    const retainedAsset = await env.STATIC_ASSETS_R2.get(
      `assets/${project.id}/${rollbackAssetHash}`,
    );
    expect(retainedAsset).not.toBeNull();
    expect(new Uint8Array(await retainedAsset!.arrayBuffer())).toEqual(rollbackAssetBody);
  });
});

describe('ambiguous go-live commit outcomes', () => {
  it('never resurrects a terminal deployment into protected cutover', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cutover-cas-terminal');
    const deployment = await createTestDeployment(env.db, project.id, 'failed');

    expect(await beginDeploymentCutover(env.db, deployment.id)).toBe(false);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('failed');
  });

  it('replays a stale protected intent before accepting a fresh deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-cutover-replay');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ retained: true, manifest: JSON.stringify({ version: 3, type: 'void', bindings: {} }) })
      .where(eq(deployments.id, source.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: source.id, type: 'void' })
      .where(eq(projects.id, project.id));
    const abandoned = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({
          version: 3,
          type: 'static',
          bindings: {},
          assetConfig: { not_found_handling: '404-page' },
        }),
        updated_at: '2020-01-01T00:00:00.000Z',
      })
      .where(eq(deployments.id, abandoned.id));
    await env.ROUTING.put(
      `cutover-intent:${abandoned.id}`,
      JSON.stringify({ projectId: project.id, ownerId: 'dead-owner', buildId: null }),
    );
    // Model a crash after only the slug route changed: there is no ready
    // marker, so recovery must replay the abandoned manifest rather than
    // promoting it blindly or wedging the project forever.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ projectId: project.id, deploymentId: abandoned.id }),
    );

    const response = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'spa',
        assets: { 'index.html': 'fresh deployment' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const events = parseDeployStream(await response.text());
    expect(events.at(-1)).toMatchObject({ event: 'done' });
    expect(await getDeployment(env.db, abandoned.id)).toMatchObject({
      status: 'live',
      retained: true,
    });
    const done = events.at(-1) as { deployment: string };
    expect(done.deployment).not.toBe(abandoned.id);
  });

  it('restores the committed deployment when stale cutover replay fails mid-surface', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-cutover-replay-failure');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, source.id));
    const abandoned = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
        updated_at: '2020-01-01T00:00:00.000Z',
      })
      .where(eq(deployments.id, abandoned.id));
    await env.ROUTING.put(
      `cutover-intent:${abandoned.id}`,
      JSON.stringify({ projectId: project.id, ownerId: 'dead-owner', buildId: null }),
    );
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ projectId: project.id, deploymentId: source.id }),
    );
    mockCfApi();

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let injected = false;
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key === project.slug && !injected) {
        injected = true;
        throw new Error('injected stale replay surface failure');
      }
      return originalPut(key, value, options);
    });
    try {
      const response = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, {
          type: 'static',
          assets: { 'index.html': 'fresh after recovered replay' },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const events = parseDeployStream(await response.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(injected).toBe(true);
      expect(await getDeployment(env.db, abandoned.id)).toMatchObject({ status: 'failed' });
      const done = events.at(-1) as { deployment: string };
      expect(await env.ROUTING.get(project.slug)).toContain(done.deployment);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('keeps failed stale-cutover compensation retryable without the 90-minute wait', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-cutover-compensation-retry');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, source.id));
    const abandoned = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
        updated_at: '2020-01-01T00:00:00.000Z',
      })
      .where(eq(deployments.id, abandoned.id));
    await env.ROUTING.put(
      `cutover-intent:${abandoned.id}`,
      JSON.stringify({ projectId: project.id, ownerId: 'dead-owner', buildId: null }),
    );
    mockCfApi();

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let failuresRemaining = 2;
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key === project.slug && failuresRemaining > 0) {
        failuresRemaining--;
        throw new Error('injected replay and compensation failure');
      }
      return originalPut(key, value, options);
    });
    const request = () =>
      buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'static',
        assets: { 'index.html': 'fresh after compensation retry' },
      });
    const first = await app.fetch(await request(), env);
    expect(first.status).toBe(503);
    expect(await getDeployment(env.db, abandoned.id)).toMatchObject({ status: 'compensating' });
    expect(failuresRemaining).toBe(0);

    putSpy.mockRestore();
    const second = await app.fetch(await request(), env);
    expect(second.status).toBe(200);
    expect(parseDeployStream(await second.text()).at(-1)).toMatchObject({ event: 'done' });
    expect(await getDeployment(env.db, abandoned.id)).toMatchObject({ status: 'failed' });
  });

  it('blocks a missing active pointer before protected recovery changes the fence', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-cutover-compensation');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        // Legacy Worker rows predate both manifest.type and bundle_stored.
        manifest: JSON.stringify({ version: 3, bindings: {} }),
      })
      .where(eq(deployments.id, source.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        workerName: `user-${project.slug}-${source.id}`,
        projectId: project.id,
        userId: user.id,
        version: source.id,
      }),
    );

    // Legacy projects can have a valid live route while their nullable active
    // pointer is still unset. Model an interrupted compensation on top of that
    // state, then make the fresh deploy fail after precheck so the recovered
    // pointer and route remain directly observable.
    const abandoned = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'compensating',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
        updated_at: '2020-01-01T00:00:00.000Z',
      })
      .where(eq(deployments.id, abandoned.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: null, type: 'void' })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      `cutover-intent:${abandoned.id}`,
      JSON.stringify({ projectId: project.id, ownerId: 'dead-owner', buildId: null }),
    );

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          type: 'static',
          bindings: {},
          assetConfig: { not_found_handling: '404-page' },
        },
        omitDefaultWorker: true,
        assetManifest: {
          '/missing.html': { hash: 'a'.repeat(32), size: 123 },
        },
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'project_requires_normalization' });
    expect(await getDeployment(env.db, abandoned.id)).toMatchObject({ status: 'compensating' });
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
    expect(JSON.parse((await env.ROUTING.get(`cutover-intent:${abandoned.id}`))!)).toMatchObject({
      ownerId: 'dead-owner',
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      workerName: `user-${project.slug}-${source.id}`,
      projectId: project.id,
      version: source.id,
    });
  });

  it('does not recover a v2 cutover with missing placement metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ready-cutover-missing-assets');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, source.id));
    const abandoned = await createTestDeployment(env.db, project.id, 'pending');
    const missingHash = 'b'.repeat(32);
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({
          version: 3,
          type: 'static',
          assetManifestVersion: 2,
          bindings: {},
        }),
        asset_hashes: JSON.stringify({
          '/missing.html': { hash: missingHash, size: 123 },
        }),
      })
      .where(eq(deployments.id, abandoned.id));
    const marker = JSON.stringify({
      projectId: project.id,
      ownerId: 'interrupted-owner',
      buildId: null,
    });
    await env.ROUTING.put(`cutover-intent:${abandoned.id}`, marker);
    await env.ROUTING.put(`cutover-ready:${abandoned.id}`, marker);
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: abandoned.id,
        projectId: project.id,
        userId: user.id,
      }),
    );
    mockCfApi();

    // Fail the fresh request after recovery so the committed source restored
    // by compensation remains observable.
    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, type: 'static', bindings: {} },
        omitDefaultWorker: true,
        assetManifest: {
          '/fresh-missing.html': { hash: 'c'.repeat(32), size: 456 },
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'error' });
    expect(await getDeployment(env.db, abandoned.id)).toMatchObject({ status: 'failed' });
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(source.id);
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      staticDeploymentId: source.id,
      projectId: project.id,
      userId: user.id,
    });
  });

  it('reconstructs legacy KV/R2 and persisted direct placement when KV propagation lags', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ready-cutover-lagging-manifest');
    const protectedDeployment = await createTestDeployment(env.db, project.id, 'pending');
    const smallLegacyHash = '1'.repeat(32);
    const largeLegacyHash = '2'.repeat(32);
    const directR2Hash = '3'.repeat(32);
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
        asset_hashes: JSON.stringify({
          '/legacy-small.js': { hash: smallLegacyHash, size: 100 },
          '/legacy-large.wasm': { hash: largeLegacyHash, size: 2 * 1024 * 1024 },
          '/direct-small.js': { hash: directR2Hash, size: 100, store: 'r2' },
        }),
      })
      .where(eq(deployments.id, protectedDeployment.id));
    const marker = JSON.stringify({
      projectId: project.id,
      ownerId: 'interrupted-owner',
      buildId: null,
    });
    await env.ROUTING.put(`cutover-intent:${protectedDeployment.id}`, marker);
    await env.ROUTING.put(`cutover-ready:${protectedDeployment.id}`, marker);
    expect(await env.ROUTING.get(`manifest:${protectedDeployment.id}`)).toBeNull();

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: { version: 3, type: 'static', bindings: {} },
        omitDefaultWorker: true,
        assetManifest: {
          '/fresh-missing.html': { hash: 'd'.repeat(32), size: 456 },
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'error' });
    expect(await getDeployment(env.db, protectedDeployment.id)).toMatchObject({
      status: 'live',
      retained: true,
    });
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(
      protectedDeployment.id,
    );
    expect(await env.ROUTING.get(`manifest:${protectedDeployment.id}`, 'json')).toEqual({
      '/legacy-small.js': smallLegacyHash,
      '/legacy-large.wasm': `!${largeLegacyHash}`,
      '/direct-small.js': `!${directR2Hash}`,
    });
  });

  it('protects and rolls forward a cutover when the final transaction does not commit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-cutover-reconcile');
    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let rejectedFinalCommit = false;
    const wrappedDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (async (fn: any) =>
            realTransaction(async (tx) => {
              const result = await fn(tx);
              const [lockedProject] = await tx
                .select({ activeDeploymentId: projects.active_deployment_id })
                .from(projects)
                .where(eq(projects.id, project.id));
              if (!rejectedFinalCommit && lockedProject?.activeDeploymentId) {
                rejectedFinalCommit = true;
                throw new Error('injected final commit rejection');
              }
              return result;
            })) as unknown as typeof realDb.transaction;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    setTestDb(wrappedDb);

    let cutoverDeploymentId: string;
    try {
      const first = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, {
          type: 'static',
          assets: { 'index.html': 'protected cutover' },
        }),
        env,
      );
      expect(first.status).toBe(200);
      expect(parseDeployStream(await first.text()).at(-1)).toMatchObject({ event: 'error' });
      expect(rejectedFinalCommit).toBe(true);

      const [cutover] = await realDb
        .select()
        .from(deployments)
        .where(eq(deployments.status, 'cutover'));
      expect(cutover).toBeDefined();
      cutoverDeploymentId = cutover!.id;
      expect(await env.ROUTING.get(project.slug)).toContain(cutoverDeploymentId);
    } finally {
      setTestDb(realDb);
    }

    // Neither background timeouts nor explicit cancellation may terminalize
    // a deployment whose external cutover is already authoritative.
    await realDb
      .update(deployments)
      .set({ updated_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(deployments.id, cutoverDeploymentId!));
    await failStaleDeployments(realDb);
    expect((await getDeployment(realDb, cutoverDeploymentId!))?.status).toBe('cutover');
    expect(await cancelDeployment(realDb, cutoverDeploymentId!)).toBeNull();

    // The next deploy claims the project only after atomically rolling the
    // protected cutover forward in PostgreSQL.
    const second = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'static',
        assets: { 'index.html': 'next deployment' },
      }),
      env,
    );
    expect(second.status).toBe(200);
    expect(parseDeployStream(await second.text()).at(-1)).toMatchObject({ event: 'done' });
    expect(await getDeployment(realDb, cutoverDeploymentId!)).toMatchObject({
      status: 'live',
      retained: true,
    });
  });

  it('preserves a committed static route when the COMMIT acknowledgement is lost', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'static-lost-commit-ack');
    const fault = injectLostGoLiveCommitAcknowledgement(project.id);

    try {
      const res = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, {
          type: 'static',
          assets: { 'index.html': 'committed static asset' },
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(fault.wasInjected()).toBe(true);

      const done = events.at(-1) as { deployment: string };
      const routing = await env.ROUTING.get(project.slug);
      expect(routing).toContain(done.deployment);
      expect(await env.ROUTING.get(`manifest:${done.deployment}`)).not.toBeNull();
      expect((await getDeployment(env.db, done.deployment))?.status).toBe('live');
    } finally {
      fault.restore();
    }
  });

  it('preserves a committed Worker when the COMMIT acknowledgement is lost', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'worker-lost-commit-ack');
    const fetchMock = mockCfApi();
    const fault = injectLostGoLiveCommitAcknowledgement(project.id);

    try {
      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
      expect(res.status).toBe(200);
      const events = parseDeployStream(await res.text());
      expect(events.at(-1)).toMatchObject({ event: 'done' });
      expect(fault.wasInjected()).toBe(true);

      const done = events.at(-1) as { deployment: string };
      const routing = await env.ROUTING.get(project.slug);
      expect(routing).toContain(done.deployment);
      const workerDeletes = fetchMock.mock.calls.filter((call: Array<unknown>) => {
        const url = typeof call[0] === 'string' ? call[0] : '';
        const init = call[1] as RequestInit | undefined;
        return url.includes(`user-${project.slug}-${done.deployment}`) && init?.method === 'DELETE';
      });
      expect(workerDeletes).toHaveLength(0);
      expect((await getDeployment(env.db, done.deployment))?.status).toBe('live');
    } finally {
      fault.restore();
    }
  });
});

describe('failed deploy compensation provenance', () => {
  it('restores prior routing when a KV write lands but its acknowledgement is lost', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'routing-lost-ack');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, source.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: source.id, type: 'static' })
      .where(eq(projects.id, project.id));
    const sourceRouting = JSON.stringify({
      staticDeploymentId: source.id,
      projectId: project.id,
      userId: user.id,
    });
    await env.ROUTING.put(project.slug, sourceRouting);
    mockCfApi();

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let acknowledgementLost = false;
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      await originalPut(key, value, options);
      if (key === project.slug && !acknowledgementLost) {
        acknowledgementLost = true;
        throw new Error('injected lost KV acknowledgement');
      }
    });

    try {
      const response = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, {
          type: 'static',
          assets: { 'index.html': 'doomed replacement' },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'error' });
      expect(acknowledgementLost).toBe(true);
      expect(await env.ROUTING.get(project.slug)).toBe(sourceRouting);
      expect((await getProject(env.db, project.id))?.active_deployment_id).toBe(source.id);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('does not restore stale routing over a newer project cutover', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'compensation-provenance');
    const source = await createTestDeployment(env.db, project.id, 'live');
    const newer = await createTestDeployment(env.db, project.id, 'live');
    await env.db.update(deployments).set({ retained: true }).where(eq(deployments.id, newer.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: source.id })
      .where(eq(projects.id, project.id));

    const sourceRouting = JSON.stringify({ deploymentId: source.id, type: 'static' });
    const newerRouting = JSON.stringify({ deploymentId: newer.id, type: 'static' });
    await env.ROUTING.put(project.slug, sourceRouting);
    mockCfApi();

    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let overtakePromise: Promise<unknown> | undefined;
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      const result = await originalPut(key, value as never, options as never);
      if (key === project.slug && !overtakePromise) {
        // Queue a newer cutover behind the failed deploy's project lock.
        // Once the lock releases, it becomes authoritative before the catch
        // path takes the compensation lock.
        overtakePromise = env.db
          .update(projects)
          .set({ active_deployment_id: newer.id })
          .where(eq(projects.id, project.id))
          .then(() => originalPut(project.slug, newerRouting));
        throw new Error('injected routing cutover failure');
      }
      return result;
    }) as typeof env.ROUTING.put);

    try {
      const res = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' }),
        env,
      );
      expect(res.status).toBe(200);
      expect(parseDeployStream(await res.text()).at(-1)).toMatchObject({ event: 'error' });
      await overtakePromise;
      expect(await env.ROUTING.get(project.slug)).toBe(newerRouting);
      const [updatedProject] = await env.db
        .select({ activeDeploymentId: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(updatedProject?.activeDeploymentId).toBe(newer.id);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('reconciles a domain activated after the cutover snapshot to the committed deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'compensation-new-domain');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, source.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: source.id, type: 'static' })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ projectId: project.id, deploymentId: source.id }),
    );
    mockCfApi();

    const hostname = 'late-activation.example.com';
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let activated = false;
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation((async (
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) => {
      if (key.startsWith('cutover-ready:') && !activated) {
        activated = true;
        // Model tryActivateDomain acquiring the project lock after the routing
        // switch fence released: it copies the new (doomed) slug route into a
        // domain that was absent from the deploy's earlier snapshot.
        await env.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
          await tx.insert(domains).values({
            id: 'dom_late_compensation',
            project_id: project.id,
            hostname,
            cf_hostname_id: 'ch-late-compensation',
            status: 'active',
          });
          const doomedRoute = await env.ROUTING.get(project.slug);
          expect(doomedRoute).not.toBeNull();
          await originalPut(`domain:${hostname}`, doomedRoute!);
        });
        throw new Error('injected failure after late domain activation');
      }
      return originalPut(key, value as never, options as never);
    }) as typeof env.ROUTING.put);

    try {
      const response = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, { type: 'static' }),
        env,
      );
      expect(response.status).toBe(200);
      expect(parseDeployStream(await response.text()).at(-1)).toMatchObject({ event: 'error' });
      expect(activated).toBe(true);
      expect(await env.ROUTING.get(`domain:${hostname}`)).toContain(source.id);
      expect((await getDeployment(env.db, source.id))?.status).toBe('live');
    } finally {
      putSpy.mockRestore();
    }
  });
});

// The deploy handler constructs a TransformStream and returns
// `new Response(readable, ...)` BEFORE parsing / asset uploads begin, so CF
// edge / intermediaries see the 200 + NDJSON content-type within milliseconds
// instead of blocking for 30–60s of sequential KV/R2 puts and dropping the
// connection.
describe('POST /projects/:id/deploy (streaming response headers / heartbeat)', () => {
  it('returns application/x-ndjson and streams events incrementally (start first, done last)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stream-headers-flush');
    mockCfApi();

    // Build a deploy with a decent number of asset parts so parse + streamed
    // KV puts take non-trivial time — long enough to block the response
    // headers if they were not flushed first. Each asset hashes to a unique key via
    // path-prefixed BLAKE3, so 40 parts means 40 KV puts.
    const assets: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      assets[`assets/file-${i}.js`] = `/* file ${i} */ export const x = ${i};`;
    }
    assets['index.html'] = '<html><body>streamed</body></html>';

    const res = await app.fetch(
      await buildStaticDeployRequest(env, project.id, user.jwt, {
        type: 'spa',
        assets,
      }),
      env,
    );

    // Structural guard: the deploy route always answers with NDJSON,
    // including 4xx-like validation failures.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.body).not.toBeNull();

    // Read the stream incrementally. If the parse/upload work were moved
    // back into the handler body (before `new Response(readable)`), the
    // ordering of NDJSON lines would be unchanged, but this reader-based
    // approach mirrors what the CLI does and is the correct client-side
    // contract for a streaming deploy response.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ event: string } & Record<string, unknown>> = [];
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          events.push(JSON.parse(line));
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      events.push(JSON.parse(buffer));
    }

    // Filter out heartbeats — timing-dependent in CI, not what this test guards.
    const nonHeartbeat = events.filter((e) => e.event !== 'heartbeat');

    // The very first non-heartbeat event consumed from the incremental
    // reader must be `start`. This proves the IIFE began emitting before
    // the stream closed — i.e. events were produced progressively, not
    // accumulated after a fully-synchronous parse.
    expect(nonHeartbeat[0]?.event).toBe('start');

    // The stream must contain the expected downstream events in order.
    const order = nonHeartbeat.map((e) => e.event);
    expect(order).toContain('asset_upload');
    expect(order).toContain('asset_upload_done');
    expect(order[order.length - 1]).toBe('done');

    // Sanity: the deploy actually succeeded with the right asset count.
    const doneEvent = nonHeartbeat.find((e) => e.event === 'done') as {
      event: 'done';
      deployment: string;
      assets: number;
      workers: number;
    };
    expect(doneEvent.deployment).toMatch(/^dpl_/);
    expect(doneEvent.assets).toBe(41);
    expect(doneEvent.workers).toBe(0);
  });
});

describe('Deploy with prerendering', () => {
  it('prerenders pages and writes ISR cache entries to KV', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-app');

    // Mock DISPATCH.get() to return a fetchable worker
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        () =>
          new Response('<html>Prerendered</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: 3600,
          prerender: ['/', '/about'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [deployment] = await env.db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // Verify ISR cache entries were written to KV (packed binary format)
    const { value: homeValue, metadata: homeMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/__index__`, 'arrayBuffer');
    expect(homeValue).not.toBeNull();
    // Unpack: [4-byte header len][headers JSON][body]
    const homeView = new DataView(homeValue!);
    const homeHeaderLen = homeView.getUint32(0, true);
    const homeBody = new TextDecoder().decode(new Uint8Array(homeValue!, 4 + homeHeaderLen));
    expect(homeBody).toBe('<html>Prerendered</html>');
    expect(homeMeta?.s).toBe(200);
    expect(homeMeta?.t).toBe(3600);

    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/about`,
      'arrayBuffer',
    );
    expect(aboutValue).not.toBeNull();

    // Verify deployment is live
    expect(deployment?.status).toBe('live');
  });

  it('does not prewarm non-HTML output from a framework prerender path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'framework-prerender-json');
    env.DISPATCH = {
      get: vi
        .fn()
        .mockReturnValue({ fetch: vi.fn().mockResolvedValue(Response.json({ data: true })) }),
    } as unknown as DispatchNamespace;
    mockCfApi();

    const response = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          type: 'framework',
          framework: 'sveltekit',
          revalidate: 60,
          prerender: ['/data'],
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    await response.text();

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    const { value } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/data`,
      'arrayBuffer',
    );
    expect(value).toBeNull();
  });

  it('preserves other deployments v2 ISR namespaces on redeploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'v2-isr-isolation');

    await env.ISR_CACHE.put(`${project.id}/isr/v2/previous/about`, 'previous-v2');

    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        () =>
          new Response('<html>Prerendered</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: 3600,
          prerender: ['/about'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // A new deploy clears only its own deployment-scoped namespace; other
    // deployments' v2 entries remain intact.
    expect(await env.ISR_CACHE.get(`${project.id}/isr/v2/previous/about`)).toBe('previous-v2');
    expect(
      await env.ISR_CACHE.get(
        `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/about`,
      ),
    ).not.toBeNull();
  });

  it('skips prerender paths with TTL <= 0', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-skip');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>Prerendered</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: { '/about': 3600, '/private': 0, '*': 0 },
          prerender: ['/about', '/private'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Only /about should have been fetched (TTL > 0)
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // /about should have ISR entry
    const { value: aboutValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/about`,
      'arrayBuffer',
    );
    expect(aboutValue).not.toBeNull();

    // /private should NOT have ISR entry
    const { value: privateValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/private`,
      'arrayBuffer',
    );
    expect(privateValue).toBeNull();
  });

  it('skips prerender paths whose render opts out of shared caching', async () => {
    // Parity with dispatch's live-miss/background write gate: a render that opts
    // out at request time — `x-revalidate: 0` or `Cache-Control: private/no-store/
    // no-cache` — must NOT be warmed, even though its path carries a positive
    // MANIFEST TTL. Otherwise an anonymous request would be served the opted-out
    // body as an ISR HIT: dispatch serves warmed entries without re-checking, and
    // `serializePrerenderHeaders` strips `Cache-Control`, so the opt-out is only
    // visible at write time. A normal 200 render is still warmed.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-optout');

    const dispatchFetch = vi.fn().mockImplementation((req: Request) => {
      const { pathname } = new URL(req.url);
      if (pathname === '/optout-header') {
        return new Response('<html>x-revalidate opt-out</html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'x-revalidate': '0' },
        });
      }
      if (pathname === '/optout-cc') {
        return new Response('<html>private</html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'cache-control': 'private' },
        });
      }
      if (pathname === '/optout-cookie') {
        return new Response('<html>session</html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'set-cookie': 'sid=secret; Path=/' },
        });
      }
      return new Response('<html>warm</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: 3600, // positive TTL for every path — the render decides opt-out
          prerender: ['/warm', '/optout-header', '/optout-cc', '/optout-cookie'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // All three cleared the manifest-TTL gate, so all three were fetched.
    expect(dispatchFetch).toHaveBeenCalledTimes(4);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();
    const base = `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app`;

    // The normal 200 render is warmed.
    const { value: warmValue, metadata: warmMetadata } = await env.ISR_CACHE.getWithMetadata<{
      p: number;
    }>(`${base}/warm`, 'arrayBuffer');
    expect(warmValue).not.toBeNull();
    expect(warmMetadata?.p).toBe(SHARED_CACHE_POLICY_VERSION);

    // Neither opt-out render is warmed.
    const { value: headerOptOut } = await env.ISR_CACHE.getWithMetadata(
      `${base}/optout-header`,
      'arrayBuffer',
    );
    expect(headerOptOut).toBeNull();
    const { value: ccOptOut } = await env.ISR_CACHE.getWithMetadata(
      `${base}/optout-cc`,
      'arrayBuffer',
    );
    expect(ccOptOut).toBeNull();
    const { value: cookieOptOut } = await env.ISR_CACHE.getWithMetadata(
      `${base}/optout-cookie`,
      'arrayBuffer',
    );
    expect(cookieOptOut).toBeNull();
  });

  it('resolves an inherit-eligible page against pathRevalidate per-path (object config)', async () => {
    // An OBJECT `routing.revalidate` bakes NO per-page TTL — the page ships
    // inherit-eligible (`{ pattern }`, no revalidate) plus the RAW config as
    // `manifest.pathRevalidate`. Prewarm's resolvePageTtl must resolve the config
    // against the ACTUAL path: `/blog/private` → 0 (per-path opt-out, NOT warmed),
    // `/blog/other` → 3600 (warmed). This is the per-path fidelity build-time
    // baking cannot give — the whole point of shipping pathRevalidate.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prewarm-pathrevalidate');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>post</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          // Inherit-eligible page (no baked TTL) + the raw per-path object config.
          pages: [{ pattern: '/blog/:slug' }],
          pathRevalidate: { '/blog/private': 0, '/blog/*': 3600 },
          prerender: ['/blog/other', '/blog/private'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Only `/blog/other` (resolves 3600) is fetched + warmed; `/blog/private`
    // (resolves 0 via the per-path opt-out) is skipped before any fetch.
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();
    const base = `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app`;

    const { value: otherValue } = await env.ISR_CACHE.getWithMetadata(
      `${base}/blog/other`,
      'arrayBuffer',
    );
    expect(otherValue).not.toBeNull();
    const { value: privateValue } = await env.ISR_CACHE.getWithMetadata(
      `${base}/blog/private`,
      'arrayBuffer',
    );
    expect(privateValue).toBeNull();
  });

  it('warms prerender paths matched by a hyphenated whole-segment revalidate key', async () => {
    // Write-side parity for the segment-anchored matcher: a route param key with
    // a `-` (`pages/blog/[post-id].vue` → `/blog/:post-id`) must resolve a
    // positive TTL so prerender warming runs (a `[A-Za-z0-9_]+` param class
    // would fail to anchor `:post-id` and silently skip warming). It must
    // still anchor to ONE segment (`/blog/a/b` must NOT match).
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-hyphen');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>Prerendered</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: { '/blog/:post-id': 3600 },
          prerender: ['/blog/hello', '/blog/a/b'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Only /blog/hello matches `/blog/:post-id` (single segment). /blog/a/b
    // crosses a slash, so its TTL resolves to 0 and it is skipped.
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // /blog/hello should have an ISR entry.
    const { value: helloValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/blog/hello`,
      'arrayBuffer',
    );
    expect(helloValue).not.toBeNull();

    // /blog/a/b must NOT have an ISR entry (single-segment anchor).
    const { value: nestedValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/blog/a/b`,
      'arrayBuffer',
    );
    expect(nestedValue).toBeNull();
  });

  it('warms nested prerender paths matched by a named catch-all revalidate key', async () => {
    // Write-side parity for the segment-anchored matcher's NAMED CATCH-ALL rule:
    // a named catch-all page (`pages/docs/[...path].vue`) serializes to the
    // revalidate key `/docs/:path{.+}`. NESTED paths under it (`/docs/guide/setup`)
    // must resolve a positive TTL so prerender warming runs (a plain `:[^/]+`
    // param class would swallow `path{.+}` whole, compile to `^/docs/[^/]+$`,
    // and silently skip warming nested paths).
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-catchall');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>Prerendered</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: { '/docs/:path{.+}': 3600 },
          prerender: ['/docs/intro', '/docs/guide/setup'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Both the single-segment path and the NESTED path match `/docs/:path{.+}`
    // (a cross-slash catch-all), so both resolve TTL 3600 and are warmed.
    expect(dispatchFetch).toHaveBeenCalledTimes(2);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    // /docs/intro should have an ISR entry that dispatch can actually READ.
    // A warmed entry with the wrong metadata shape (e.g. `context` instead of
    // `c`) exists as bytes but is a permanent cold miss — dispatch's
    // `readIsrCache` returns null without `c`/`t`. Assert the readable shape,
    // not just presence.
    const { value: introValue, metadata: introMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/docs/intro`, 'arrayBuffer');
    expect(introValue).not.toBeNull();
    expect(introMeta).toMatchObject({ s: 200, t: 3600 });
    expect(typeof introMeta?.c).toBe('number');
    expect(introMeta!.c).toBeGreaterThan(0);

    // The NESTED path /docs/guide/setup must ALSO have a readable ISR entry.
    const { value: nestedCatchAllValue, metadata: nestedMeta } =
      await env.ISR_CACHE.getWithMetadata<{ s: number; c: number; t: number }>(
        `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/docs/guide/setup`,
        'arrayBuffer',
      );
    expect(nestedCatchAllValue).not.toBeNull();
    expect(nestedMeta).toMatchObject({ s: 200, t: 3600 });
    expect(typeof nestedMeta?.c).toBe('number');
  });

  it('does not block deploy when prerender fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-fail');

    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error('Worker crashed')),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: 3600,
          prerender: ['/'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Deployment should still be live despite prerender failure
    const [dpl] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(dpl?.status).toBe('live');
  });

  it('keeps the protected cutover status during post-queue prerendering', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prerender-status');

    let statusDuringPrerender: string | undefined;
    const dispatchGet = vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(async () => {
        // Check deployment status during prerender
        const [dpl] = await env.db
          .select({ status: deployments.status })
          .from(deployments)
          .where(eq(deployments.project_id, project.id));
        statusDuringPrerender = dpl?.status;
        return new Response('<html>ok</html>', { status: 200 });
      }),
    });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          revalidate: 3600,
          prerender: ['/'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(statusDuringPrerender).toBe('cutover');
  });

  it('prewarms a pages-only manifest (ISR TTLs live only in manifest.pages, no flat revalidate)', async () => {
    // Route-awareness parity: a manifest whose ISR config lives ONLY in the
    // ordered `pages` table (no flat `manifest.revalidate` map) must still
    // prewarm; the gate must not require `manifest.revalidate`.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prewarm-pages-only');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>Prerendered</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          // NO flat `revalidate` — the TTL lives only in the pages table.
          pages: [{ pattern: '/p', revalidate: 60 }],
          prerender: ['/p'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // The page-route TTL (60) drove a real prewarm fetch + ISR write.
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    const { value: pValue, metadata: pMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/p`, 'arrayBuffer');
    expect(pValue).not.toBeNull();
    expect(pMeta).toMatchObject({ s: 200, t: 60 });
    expect(typeof pMeta?.c).toBe('number');
  });

  it('does not prewarm a specific non-ISR page shadowed under a flat catch-all (first-match)', async () => {
    // First-match parity: `/specific` (a page with NO per-page TTL) must WIN
    // over the later catch-all `/:path{.+}` (revalidate 3600) — mirroring
    // dispatch's `resolvePageTtl`. A flat `manifest.revalidate` lookup would
    // never see the pages table, so `/specific` would fall through to the
    // catch-all and be warmed with TTL 3600 — a misleading cache entry for a
    // page the framework renders dynamically.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'prewarm-shadow');

    const dispatchFetch = vi.fn().mockImplementation(
      () =>
        new Response('<html>Prerendered</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const dispatchGet = vi.fn().mockReturnValue({ fetch: dispatchFetch });
    env.DISPATCH = { get: dispatchGet } as unknown as DispatchNamespace;

    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          // A flat catch-all in `revalidate` PLUS an ordered pages table where
          // `/specific` first-matches with no TTL (opts out of ISR).
          revalidate: { '/:path{.+}': 3600 },
          pages: [{ pattern: '/specific' }, { pattern: '/:path{.+}', revalidate: 3600 }],
          prerender: ['/specific', '/other'],
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    // Only `/other` (catch-all winner, TTL 3600) is warmed. `/specific`
    // first-matches the literal page with no TTL → resolves to 0 → skipped.
    expect(dispatchFetch).toHaveBeenCalledTimes(1);

    const [deployment] = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.project_id, project.id));
    expect(deployment).toBeDefined();

    const { value: specificValue } = await env.ISR_CACHE.getWithMetadata(
      `${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/specific`,
      'arrayBuffer',
    );
    expect(specificValue).toBeNull();

    const { value: otherValue, metadata: otherMeta } = await env.ISR_CACHE.getWithMetadata<{
      s: number;
      c: number;
      t: number;
    }>(`${project.id}/isr/v3/${deployment!.id}/${project.slug}.void.app/other`, 'arrayBuffer');
    expect(otherValue).not.toBeNull();
    expect(otherMeta).toMatchObject({ s: 200, t: 3600 });
  });
});

describe('asset_hashes storage', () => {
  it('stores asset_hashes in deployment record after successful deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    mockCfApi();

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        assets: { 'index.html': '<html>hello</html>' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const data = requireEvent<DoneEvent>(events, 'done');

    const [row] = await env.db
      .select({ asset_hashes: deployments.asset_hashes })
      .from(deployments)
      .where(eq(deployments.id, data.deployment));

    expect(row?.asset_hashes).toBeTruthy();
    const hashes = JSON.parse(row!.asset_hashes!);
    expect(hashes['/index.html']).toBeDefined();
    expect(hashes['/index.html'].hash).toHaveLength(32);
    expect(hashes['/index.html'].size).toBeGreaterThan(0);
  });

  it('persists asset_hashes on a failed deployment when the failure is past asset upload', async () => {
    // A first-ever deploy fails at migrations AFTER assets were accepted by
    // CF. asset_hashes is persisted as soon as CF accepts the bytes, so the
    // deployment row left behind is a valid corroboration baseline for
    // retries; without it the session-dedupe guard would lock the project
    // out permanently.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'first-deploy-migrate-fail');
    mockCfApi({ createD1: () => cfSuccess({ uuid: 'd1-recovery-uuid', name: 'fail-db' }) });
    mockSetTimeout();

    const originalDispatch = env.DISPATCH;
    env.DISPATCH = {
      get: () => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === '/__void/migrate/capabilities') {
            return sqliteMigrationCapabilities();
          }
          if (url.pathname === '/__void/ready') {
            return Response.json({ ready: true });
          }
          return Response.json({
            ok: false,
            error: 'migration 001_create_table.sql failed',
            migrations: [
              {
                name: '001_create_table.sql',
                applied: false,
                durationMs: 2,
                error: 'D1_ERROR: near "broken": syntax error',
              },
            ],
          });
        },
      }),
    } as unknown as DispatchNamespace;

    try {
      const res = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          manifest: {
            version: 3,
            bindings: { d1: ['DB'] },
            migrations: SQLITE_MIGRATIONS,
          },
          assets: { 'index.html': '<h1>recappi</h1>' },
        }),
        env,
      );
      expect(res.status).toBe(200);
      const events = (await readAllEvents(res)) as Array<{ event: string; message?: string }>;
      expect(events.find((e) => e.event === 'error')?.message).toContain(
        'D1_ERROR: near "broken": syntax error',
      );

      const [dpl] = await env.db
        .select({
          status: deployments.status,
          asset_hashes: deployments.asset_hashes,
          error_message: deployments.error_message,
          retained: deployments.retained,
        })
        .from(deployments)
        .where(eq(deployments.project_id, project.id));
      expect(dpl?.status).toBe('failed');
      expect(dpl?.error_message).toContain('D1_ERROR: near "broken": syntax error');
      // Retention claim happens after migrations succeed, so retained stays
      // false — but asset_hashes MUST survive so the next deploy can
      // corroborate against it.
      expect(dpl?.retained).toBe(false);
      expect(dpl?.asset_hashes).toBeTruthy();
      const persisted = JSON.parse(dpl!.asset_hashes!);
      expect(persisted['/index.html']).toBeDefined();
    } finally {
      env.DISPATCH = originalDispatch;
    }
  });

  // Contract: in JSON-mode, the CLI always sends the FULL assetManifest
  // (new uploads + preflight-skipped carry-forwards); the server does not
  // fill in paths from the prior live manifest. Every path the CLI declared must end up in the persisted asset_hashes,
  // regardless of whether each entry was a new upload or a preflight skip.
  it('JSON-mode deploy with preflight=true preserves preflight-skipped paths in saved manifest', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'preflight-fullmanifest');
    mockCfApi();

    const carriedBytes = new TextEncoder().encode('<h1>carried</h1>');
    const carriedHash = computeAssetHash(carriedBytes.buffer as ArrayBuffer, '/index.html');
    const newBytes = new TextEncoder().encode('body { color: blue }');
    const newHash = computeAssetHash(newBytes.buffer as ArrayBuffer, '/style.css');

    // Pre-upload BOTH paths to R2 — the carry-forward (preflight-skipped)
    // path's bytes are already present from a hypothetical earlier deploy,
    // and the new path's bytes were just uploaded direct-to-R2 by the CLI.
    await env.STATIC_ASSETS_R2.put(
      `assets/${project.id}/${carriedHash}`,
      carriedBytes as unknown as ArrayBuffer,
    );
    await env.STATIC_ASSETS_R2.put(
      `assets/${project.id}/${newHash}`,
      newBytes as unknown as ArrayBuffer,
    );

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          type: 'spa',
          bindings: {},
          assetConfig: { not_found_handling: 'single-page-application' },
        },
        // Provide an explicit assetManifest with BOTH paths — mirroring
        // what the JSON-mode CLI sends after preflight when one path was
        // skipped (already in R2) and one was newly uploaded.
        assetManifest: {
          '/index.html': { hash: carriedHash, size: carriedBytes.byteLength },
          '/style.css': { hash: newHash, size: newBytes.byteLength },
        },
        preflight: 'true',
      }),
      env,
    );

    expect(res.status).toBe(200);
    const events = await readAllEvents(res);
    const done = requireEvent<DoneEvent>(events, 'done');

    const [row] = await env.db
      .select({ asset_hashes: deployments.asset_hashes })
      .from(deployments)
      .where(eq(deployments.id, done.deployment));

    expect(row?.asset_hashes).toBeTruthy();
    const persisted = JSON.parse(row!.asset_hashes!);
    expect(persisted['/index.html']).toBeDefined();
    expect(persisted['/index.html'].hash).toBe(carriedHash);
    expect(persisted['/style.css']).toBeDefined();
    expect(persisted['/style.css'].hash).toBe(newHash);
  });
});

describe('POST /projects/:id/deploy/preflight', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_fake/deploy/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetManifest: {} }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns all assets as needed on first deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetManifest: {
            '/index.html': { hash: 'a'.repeat(32), size: 100 },
            '/app.js': { hash: 'b'.repeat(32), size: 200 },
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
    expect(data.needed.sort()).toEqual(['/app.js', '/index.html']);
    expect(data.total).toBe(2);
    expect(data.skipped).toBe(0);
  });

  it('skips unchanged assets from previous deploy', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Create a previous deployment with known asset hashes
    const prevManifest = {
      '/index.html': { hash: 'a'.repeat(32), size: 100 },
      '/app.js': { hash: 'b'.repeat(32), size: 200 },
      '/style.css': { hash: 'c'.repeat(32), size: 300 },
    };
    const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(prevManifest) })
      .where(eq(deployments.id, prevDeploy.id));
    // Simulate a live static KV/R2 deployment: the preflight handler
    // reads the routing entry under `project.slug` and treats presence of
    // `staticDeploymentId` as the static-backend signal.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: prevDeploy.id,
        projectId: project.id,
        userId: user.id,
      }),
    );
    const servingManifest: Record<string, string> = {};
    for (const [path, entry] of Object.entries(prevManifest)) {
      servingManifest[path] = entry.hash;
    }
    await env.ROUTING.put(`manifest:${prevDeploy.id}`, JSON.stringify(servingManifest));

    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${'a'.repeat(32)}`, new Uint8Array(100));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          assetManifest: {
            '/index.html': { hash: 'a'.repeat(32), size: 100 }, // unchanged
            '/app.js': { hash: 'f'.repeat(32), size: 250 }, // changed
            '/new.js': { hash: 'd'.repeat(32), size: 400 }, // new
            // style.css removed
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
    expect(data.needed.sort()).toEqual(['/app.js', '/new.js']);
    expect(data.total).toBe(3);
    expect(data.skipped).toBe(1);
  });

  it('deduplicates against the active deployment after rollback, not newer history', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'preflight-after-rollback');
    const active = await createTestDeployment(env.db, project.id, 'live');
    const activeManifest = {
      '/index.html': { hash: 'a'.repeat(32), size: 100 },
    };
    await env.db
      .update(deployments)
      .set({
        retained: true,
        asset_hashes: JSON.stringify(activeManifest),
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, active.id));

    const newerHistory = await createTestDeployment(env.db, project.id, 'live');
    const newerManifest = {
      '/index.html': { hash: 'b'.repeat(32), size: 100 },
    };
    await env.db
      .update(deployments)
      .set({
        retained: true,
        asset_hashes: JSON.stringify(newerManifest),
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, newerHistory.id));
    // Model rollback to the older deployment while the newer deployment
    // remains a retained live history row.
    await env.db
      .update(projects)
      .set({ active_deployment_id: active.id, type: 'static' })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: active.id,
        projectId: project.id,
        userId: user.id,
      }),
    );

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assetManifest: newerManifest }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      needed: ['/index.html'],
      total: 1,
      skipped: 0,
    });
  });

  it('requires explicit pointer normalization before preflight deduplication', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'legacy-preflight-rollback');
    const rollbackTarget = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        retained: true,
        asset_hashes: JSON.stringify({
          '/index.html': { hash: 'a'.repeat(32), size: 100 },
        }),
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, rollbackTarget.id));

    const newerHistory = await createTestDeployment(env.db, project.id, 'live');
    const newerManifest = {
      '/index.html': { hash: 'b'.repeat(32), size: 100 },
    };
    await env.db
      .update(deployments)
      .set({
        retained: true,
        asset_hashes: JSON.stringify(newerManifest),
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, newerHistory.id));
    await env.db
      .update(projects)
      .set({ active_deployment_id: null, type: 'static' })
      .where(eq(projects.id, project.id));

    // The route records a legacy rollback to the older deployment while the
    // project pointer is still null. History ordering alone would choose the
    // newer manifest and incorrectly skip this upload.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        staticDeploymentId: rollbackTarget.id,
        projectId: project.id,
        userId: user.id,
      }),
    );

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assetManifest: newerManifest }),
      }),
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'project_requires_normalization' });
    expect((await getProject(env.db, project.id))?.active_deployment_id).toBeNull();
  });

  it.each([undefined, 'installation-one'])(
    'attributes platform app uploads for installation %s',
    async (installationId) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'attributed-proj');
      const capturedHeaders: Array<Headers> = [];
      mockCfApi({
        uploadWorker: async (_url: string, init?: RequestInit) => {
          capturedHeaders.push(new Headers(init?.headers));
          return new Response('ok', { status: 200 });
        },
      });
      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), {
        ...env,
        PLATFORM_VERSION: '0.27.0',
        PLATFORM_ENV: 'production',
        PLATFORM_INSTALLATION_ID: installationId,
      });
      await res.text();
      expect((await getProject(env.db, project.id))?.active_deployment_id).not.toBeNull();
      expect(capturedHeaders).toHaveLength(1);
      expect(capturedHeaders[0]?.get('User-Agent')).toBe(
        `void-platform/0.27.0 void-installation/${installationId ?? 'hosted-production'}`,
      );
      expect(capturedHeaders[0]?.get('Authorization')).toBe(`Bearer ${env.CF_API_TOKEN}`);
    },
  );

  it('includes observability metadata in worker upload', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'obs-proj');

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get('metadata') as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response('ok', { status: 200 });
      },
    });

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    await res.text();
    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.observability).toEqual({
      enabled: true,
      logs: { invocation_logs: true, head_sampling_rate: 1 },
    });
  });

  it('includes explicit tail_consumers metadata in worker upload', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'tail-proj');

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get('metadata') as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response('ok', { status: 200 });
      },
    });

    const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
    expect(res.status).toBe(200);
    await res.text();
    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.tail_consumers).toEqual([{ service: 'void-tail' }]);
  });

  it('uses TAIL_SERVICE_NAME env override in worker upload tail_consumers', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'tail-proj-staging');

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get('metadata') as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response('ok', { status: 200 });
      },
    });

    const originalTailServiceName = env.TAIL_SERVICE_NAME;
    env.TAIL_SERVICE_NAME = 'void-tail-staging';
    try {
      const res = await app.fetch(await buildDeployRequest(env, project.id, user.jwt), env);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      env.TAIL_SERVICE_NAME = originalTailServiceName;
    }
    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.tail_consumers).toEqual([{ service: 'void-tail-staging' }]);
  });

  it('serializes new websocket durable objects as SQLite class migrations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'ws-migrations-proj');

    let capturedMetadata: Record<string, unknown> | undefined;
    mockCfApi({
      uploadWorker: async (_url: string, init?: RequestInit) => {
        const body = init?.body as FormData;
        const metadataBlob = body.get('metadata') as Blob;
        capturedMetadata = JSON.parse(await metadataBlob.text());
        return new Response('ok', { status: 200 });
      },
    });

    const res = await app.fetch(
      await buildDeployRequest(env, project.id, user.jwt, {
        manifest: {
          version: 3,
          bindings: {},
          websocket: {
            routes: [
              {
                pattern: '/ws/chat/:room',
                filePath: 'routes/ws/chat/[room].ws.ts',
                className: 'WsChatRoomWs',
                bindingName: 'CHAT_ROOM',
                mode: 'room',
                hasAuthGate: false,
              },
            ],
            classes: ['WsChatRoomWs', 'WsPresenceWs'],
            migrations: [
              { tag: 'ws-v1', newClasses: ['WsChatRoomWs'] },
              { tag: 'ws-v2', newClasses: ['WsPresenceWs'] },
            ],
          },
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();

    expect(capturedMetadata).toBeDefined();
    expect(capturedMetadata!.bindings).toEqual(
      expect.arrayContaining([
        {
          type: 'durable_object_namespace',
          name: 'CHAT_ROOM',
          class_name: 'WsChatRoomWs',
        },
        {
          type: 'durable_object_namespace',
          name: 'WsPresenceWs',
          class_name: 'WsPresenceWs',
        },
      ]),
    );
    expect(capturedMetadata).not.toHaveProperty('durable_objects');
    expect(capturedMetadata!.migrations).toEqual({
      new_tag: 'ws-v1',
      steps: [{ new_sqlite_classes: ['WsChatRoomWs', 'WsPresenceWs'] }],
    });
  });

  describe('static → WfP project type transition', () => {
    it('requires scoped R2 uploads when a historical static deployment gains a Worker', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id);

      // Create a previous STATIC deployment with known asset hashes
      const prevManifest = {
        '/index.html': { hash: 'a'.repeat(32), size: 100 },
        '/app.js': { hash: 'b'.repeat(32), size: 200 },
        '/style.css': { hash: 'c'.repeat(32), size: 300 },
      };
      const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
      await env.db
        .update(deployments)
        .set({ asset_hashes: JSON.stringify(prevManifest) })
        .where(eq(deployments.id, prevDeploy.id));
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          staticDeploymentId: prevDeploy.id,
          projectId: project.id,
          userId: user.id,
        }),
      );

      // Static deploys store a serving manifest in ROUTING KV
      const servingManifest: Record<string, string> = {};
      for (const [path, entry] of Object.entries(prevManifest)) {
        servingManifest[path] = entry.hash;
      }
      await env.ROUTING.put(`manifest:${prevDeploy.id}`, JSON.stringify(servingManifest));

      // Historical serving metadata alone cannot prove scoped R2 availability.
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assetManifest: {
              '/index.html': { hash: 'a'.repeat(32), size: 100 }, // unchanged
              '/app.js': { hash: 'b'.repeat(32), size: 200 }, // unchanged
              '/style.css': { hash: 'c'.repeat(32), size: 300 }, // unchanged
            },
            hasWorker: true,
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
      // Every asset is absent from the scoped R2 store.
      expect(data.needed.sort()).toEqual(['/app.js', '/index.html', '/style.css']);
      expect(data.total).toBe(3);
      expect(data.skipped).toBe(0);
    });

    it('still deduplicates when previous deploy was static and current is also static', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id);

      // Create a previous STATIC deployment
      const prevManifest = {
        '/index.html': { hash: 'a'.repeat(32), size: 100 },
        '/app.js': { hash: 'b'.repeat(32), size: 200 },
      };
      const prevDeploy = await createTestDeployment(env.db, project.id, 'live');
      await env.db
        .update(deployments)
        .set({ asset_hashes: JSON.stringify(prevManifest) })
        .where(eq(deployments.id, prevDeploy.id));
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          staticDeploymentId: prevDeploy.id,
          projectId: project.id,
          userId: user.id,
        }),
      );
      const servingManifest: Record<string, string> = {};
      for (const [path, entry] of Object.entries(prevManifest)) {
        servingManifest[path] = entry.hash;
      }
      await env.ROUTING.put(`manifest:${prevDeploy.id}`, JSON.stringify(servingManifest));

      // Preflight WITHOUT hasWorker (staying as static deploy)
      await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${'a'.repeat(32)}`, new Uint8Array(100));

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assetManifest: {
              '/index.html': { hash: 'a'.repeat(32), size: 100 }, // unchanged
              '/app.js': { hash: 'f'.repeat(32), size: 250 }, // changed
            },
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const data = (await res.json()) as { needed: Array<string>; total: number; skipped: number };
      // static→static should still dedup
      expect(data.needed.sort()).toEqual(['/app.js']);
      expect(data.total).toBe(2);
      expect(data.skipped).toBe(1);
    });

    it('reuses scoped R2 assets when converting a current static deployment to WfP', async () => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'static-to-void');

      // 1. Do an initial static deploy
      mockCfApi();
      const staticRes = await app.fetch(
        await buildStaticDeployRequest(env, project.id, user.jwt, {
          type: 'spa',
          assets: { 'index.html': '<h1>hello</h1>', 'app.js': 'console.log(1)' },
        }),
        env,
      );
      expect(staticRes.status).toBe(200);
      const staticEvents = await readAllEvents(staticRes);
      const staticDone = staticEvents.find(
        (event): event is DoneEvent => isDeployEvent(event) && event.event === 'done',
      );
      expect(staticDone).toBeDefined();

      // Both deployment modes use the same scoped R2 bytes.
      const indexBytes = new TextEncoder().encode('<h1>hello</h1>');
      const appBytes = new TextEncoder().encode('console.log(1)');
      const preflightRes = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deploy/preflight`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            assetManifest: {
              '/index.html': {
                hash: computeAssetHash(indexBytes.buffer, '/index.html'),
                size: indexBytes.length,
              },
              '/app.js': {
                hash: computeAssetHash(appBytes.buffer, '/app.js'),
                size: appBytes.length,
              },
            },
            hasWorker: true,
          }),
        }),
        env,
      );
      expect(preflightRes.status).toBe(200);
      const pfData = (await preflightRes.json()) as {
        needed: Array<string>;
        total: number;
        skipped: number;
      };
      expect(pfData.skipped).toBe(2);
      expect(pfData.needed).toEqual([]);

      // Worker finalization hydrates the existing scoped R2 copy for Cloudflare.
      mockCfApi();
      const deployRes = await app.fetch(
        await buildDeployRequest(env, project.id, user.jwt, {
          assets: { 'index.html': '<h1>hello</h1>', 'app.js': 'console.log(1)' },
        }),
        env,
      );
      expect(deployRes.status).toBe(200);
      const events = await readAllEvents(deployRes);
      const done = events.find(
        (event): event is DoneEvent => isDeployEvent(event) && event.event === 'done',
      );
      expect(done).toBeDefined();
      // Should not have errored with AssetHashMissError
      const error = events.find(
        (event): event is ErrorEvent => isDeployEvent(event) && event.event === 'error',
      );
      expect(error).toBeUndefined();
    });
  });
});

describe('validateManifestShape — migrations', () => {
  const base = { version: 3, bindings: {} };

  it('accepts MySQL migrations', () => {
    expect(
      validateManifestShape({
        ...base,
        migrations: { dialect: 'mysql', pending: 1 },
      }),
    ).toBeNull();
  });

  it('rejects unsupported migration dialects', () => {
    expect(
      validateManifestShape({
        ...base,
        migrations: { dialect: 'oracle', pending: 1 },
      }),
    ).toMatch(/sqlite, postgresql, mysql/);
  });
});

describe('validateManifestShape — pages', () => {
  const base = { version: 3, bindings: {} };
  it('accepts a valid pages array', () => {
    expect(
      validateManifestShape({
        ...base,
        pages: [{ pattern: '/a' }, { pattern: '/b/:x', revalidate: 60 }],
      }),
    ).toBeNull();
  });
  it('accepts absence of pages', () => {
    expect(validateManifestShape(base)).toBeNull();
  });
  it('rejects non-array pages', () => {
    expect(validateManifestShape({ ...base, pages: {} })).toMatch(/pages must be an array/);
  });
  it('rejects an entry with a non-string pattern', () => {
    expect(validateManifestShape({ ...base, pages: [{ pattern: 5 }] })).toMatch(
      /pattern must be a string/,
    );
  });
  it('rejects an entry with a non-number revalidate', () => {
    expect(validateManifestShape({ ...base, pages: [{ pattern: '/a', revalidate: 'x' }] })).toMatch(
      /revalidate must be a number/,
    );
  });
  it('accepts an explicit revalidate:0 opt-out marker on a pages entry', () => {
    expect(
      validateManifestShape({ ...base, pages: [{ pattern: '/a', revalidate: 0 }] }),
    ).toBeNull();
  });
});

describe('validateManifestShape — pathRevalidate', () => {
  const base = { version: 3, bindings: {} };
  it('accepts a valid pathRevalidate object', () => {
    expect(
      validateManifestShape({ ...base, pathRevalidate: { '/blog/private': 0, '/blog/*': 3600 } }),
    ).toBeNull();
  });
  it('accepts absence of pathRevalidate', () => {
    expect(validateManifestShape(base)).toBeNull();
  });
  it('rejects a non-object pathRevalidate', () => {
    expect(validateManifestShape({ ...base, pathRevalidate: [] })).toMatch(
      /pathRevalidate must be an object/,
    );
    expect(validateManifestShape({ ...base, pathRevalidate: 60 })).toMatch(
      /pathRevalidate must be an object/,
    );
  });
  it('rejects a non-number pathRevalidate value', () => {
    expect(validateManifestShape({ ...base, pathRevalidate: { '/a': 'x' } })).toMatch(
      /pathRevalidate\.\/a must be a number/,
    );
  });
});

describe('validateManifestShape — limits', () => {
  const base = { version: 3, bindings: {} };
  it('accepts a valid limits object', () => {
    expect(validateManifestShape({ ...base, limits: { cpuMs: 500 } })).toBeNull();
  });
  it('accepts an empty limits object and absence of limits', () => {
    expect(validateManifestShape({ ...base, limits: {} })).toBeNull();
    expect(validateManifestShape(base)).toBeNull();
  });
  it('rejects a non-object limits', () => {
    expect(validateManifestShape({ ...base, limits: 500 })).toMatch(/limits must be an object/);
    expect(validateManifestShape({ ...base, limits: [] })).toMatch(/limits must be an object/);
    expect(validateManifestShape({ ...base, limits: null })).toMatch(/limits must be an object/);
  });
  it('rejects a zero, negative, non-integer, or non-number cpuMs', () => {
    for (const cpuMs of [0, -5, 1.5, Number.NaN, Infinity, 2 ** 53, '10', true]) {
      expect(validateManifestShape({ ...base, limits: { cpuMs } })).toMatch(
        /limits\.cpuMs must be a positive integer/,
      );
    }
  });
});
