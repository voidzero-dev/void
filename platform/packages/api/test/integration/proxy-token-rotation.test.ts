import { eq, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import {
  createDeployment,
  deleteUser,
  markDeploymentRetained,
  setActiveDeployment,
  updateDeploymentStatus,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../../src/naming.ts';
import { reconcileProjectCleanupJobs } from '../../src/provisioning/cleanup.ts';
import { durableObjectWorkerName } from '../../src/provisioning/durable-objects.ts';
import {
  advanceProxyTokenRotation,
  issueProjectProxyToken,
  listProxyTokenInventory,
  PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS,
  PROXY_TOKEN_ROTATION_WAIT_MS,
  proxyTokenRotationStuckWarning,
  proxyTokenRotationTarget,
  proxyTokenRotationWarnings,
  reconcileProxyTokenRotations,
  requestBulkProxyTokenRotations,
  requestProxyTokenRotation,
  requestRotationIfReplacingUntrustedCode,
  type ProjectRotationOutcome,
  type ProxyTokenRotationEnv,
  type ProxyTokenRotationReason,
} from '../../src/proxy-token-rotation.ts';
import {
  deriveProxyInternalAuth,
  deriveProxyToken,
  PROXY_INTERNAL_AUTH_HEADER,
  proxyTokenStateKey,
  type ProxyInternalRoute,
} from '../../src/proxy-token.ts';
import {
  deployments,
  projectCleanupJobs,
  projectMembers,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
import {
  captureQueries,
  capturedQueryCount,
  cfError,
  cfSuccess,
  clearTables,
  createCronSchedulerMock,
  createTestDeployment,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  MemoryKVNamespace,
  mockCfApi,
  readAllEvents,
  setupEnv,
  teardownEnv,
  type CfApiMocks,
  type MockCfApiHandle,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

const MANIFEST = {
  version: 3,
  bindings: {},
  schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
  queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
};

/** Ordered log of Cloudflare calls (`GET <script>` / `PATCH <script>`) and KV puts. */
let events: Array<string>;
let routing: MemoryKVNamespace;
let cron: ReturnType<typeof createCronSchedulerMock>;
let testEnv: TestEnv & ProxyTokenRotationEnv;
/** Per-test interception points. */
let hooks: {
  fetch?: (method: string, script: string) => Response | Promise<Response | undefined> | undefined;
  kvPut?: (key: string) => void | Promise<void>;
};
let patches: Array<{ script: string; bindings: Array<Record<string, string>> }>;

beforeEach(async () => {
  await clearTables(env.db);
  events = [];
  patches = [];
  hooks = {};
  routing = new MemoryKVNamespace();
  const put = routing.put.bind(routing);
  routing.put = async (key, value, options) => {
    events.push(`kv ${key}`);
    await hooks.kvPut?.(key);
    return put(key, value, options);
  };
  cron = createCronSchedulerMock();
  testEnv = {
    ...env,
    ROUTING: routing as unknown as KVNamespace,
    CRON_SCHEDULER: cron.namespace,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const scriptNameOf = (url: string): string =>
  decodeURIComponent(/\/scripts\/([^/?#]+)/.exec(url)?.[1] ?? '');

/**
 * Stateful Cloudflare mock: script bindings come from the seeded scripts (a
 * missing script is a 404) and settings PATCHes apply `inherit`. Every call to
 * a dispatch script is logged in `events`.
 */
function cfApi(overrides: Partial<CfApiMocks> = {}): MockCfApiHandle {
  const handle: MockCfApiHandle = mockCfApi({
    listWorkerBindings: (url) => {
      const script = handle.state.hostScripts.get(scriptNameOf(url));
      return script
        ? cfSuccess(script.bindings)
        : cfError('workers.api.error.script_not_found', 404, 10_007);
    },
    ...overrides,
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (url.includes('/workers/dispatch/') && /\/(bindings|settings)$/.test(url)) {
      const script = scriptNameOf(url);
      events.push(`${method} ${script}`);
      if (method === 'PATCH' && init?.body instanceof FormData) {
        const part = init.body.get('settings') as Blob;
        const body = JSON.parse(await part.text()) as {
          bindings: Array<Record<string, string>>;
        };
        patches.push({ script, bindings: body.bindings });
      }
      const hooked = await hooks.fetch?.(method, script);
      if (hooked) {
        return hooked;
      }
    }
    return (handle as unknown as typeof fetch)(input, init);
  });
  return handle;
}

function workerBindings(token: string): Array<Record<string, unknown>> {
  return [
    { type: 'd1', name: 'DB', id: 'd1-database-id' },
    { type: 'service', name: '__VOID_PROXY', service: 'void-proxy' },
    { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: token },
    { type: 'secret_text', name: 'API_KEY' },
  ];
}

const tok = (projectId: string, gen: number) => deriveProxyToken(JWT_SECRET, projectId, gen);

type Fixture = {
  projectId: string;
  slug: string;
  ownerId: string;
  ownerJwt: string;
  active: string;
  retained: Array<string>;
  worker: (deploymentId: string) => string;
  queueKey: string;
  legacy: string;
};

async function addDeployment(
  projectId: string,
  options: Readonly<{
    manifest?: object | null;
    retained?: boolean;
    active?: boolean;
    proxyTokenGen?: number;
  }> = {},
): Promise<string> {
  const deployment = await createDeployment(
    env.db,
    projectId,
    JSON.stringify(options.manifest === undefined ? MANIFEST : (options.manifest ?? {})),
  );
  // Rows created in the same clock tick would be walked in id order; keep
  // creation order instead so tests can name the Nth Worker.
  await env.db.execute(sql`UPDATE deployments SET created_at = (
      SELECT max(created_at) + interval '1 millisecond' FROM deployments
      WHERE project_id = ${projectId}
    ) WHERE id = ${deployment.id}`);
  await updateDeploymentStatus(env.db, deployment.id, 'live');
  if (options.proxyTokenGen !== undefined) {
    await env.db
      .update(deployments)
      .set({ proxy_token_gen: options.proxyTokenGen })
      .where(eq(deployments.id, deployment.id));
  }
  if (options.retained ?? true) {
    await markDeploymentRetained(env.db, deployment.id, true);
  }
  if (options.active) {
    await setActiveDeployment(env.db, projectId, deployment.id);
  }
  return deployment.id;
}

/**
 * A project with `retained` retained Workers, optionally a retained static
 * row with no script, and an active Worker (created last) with a queue and a
 * cron schedule. Every script holds the legacy token.
 */
async function setupProject(
  cf: MockCfApiHandle,
  options: Readonly<{
    retained?: number;
    staticRetained?: boolean;
    manifest?: object | null;
    type?: 'void' | 'static';
    activeScript?: boolean;
  }> = {},
): Promise<Fixture> {
  const owner = await createTestUser(env.db);
  const { id: projectId, slug } = await createTestProject(env.db, owner.id);
  if (options.type) {
    await env.db.update(projects).set({ type: options.type }).where(eq(projects.id, projectId));
  }
  const legacy = await tok(projectId, 0);
  const worker = (deploymentId: string) => getProjectDeploymentWorkerName(slug, deploymentId);
  const retained: Array<string> = [];
  for (let index = 0; index < (options.retained ?? 2); index++) {
    const id = await addDeployment(projectId, { manifest: options.manifest });
    cf.seedHostScript({ scriptName: worker(id), bindings: workerBindings(legacy) });
    retained.push(id);
  }
  if (options.staticRetained) {
    retained.push(await addDeployment(projectId, { manifest: { version: 3, type: 'static' } }));
  }
  const active = await addDeployment(projectId, { manifest: options.manifest, active: true });
  if (options.activeScript ?? true) {
    cf.seedHostScript({ scriptName: worker(active), bindings: workerBindings(legacy) });
  }
  const queueKey = `queue:${getProjectQueueName(projectId, 'emails')}`;
  await routing.put(
    queueKey,
    JSON.stringify({
      workerName: worker(active),
      projectId,
      queueName: 'emails',
      proxyToken: legacy,
    }),
  );
  cron.states.set(projectId, {
    workerName: worker(active),
    schedules: [{ name: 'crons/tick.ts', cron: '*/5 * * * *' }],
    proxyToken: legacy,
  });
  events.length = 0;
  return {
    projectId,
    slug,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    active,
    retained,
    worker,
    queueKey,
    legacy,
  };
}

const freshBudget = () => ({ cfCallsRemaining: 1000, deadline: Date.now() + 60_000 });

function advance(
  projectId: string,
  options: Readonly<{
    waitMs?: number;
    budget?: { cfCallsRemaining: number; deadline: number };
  }> = {},
): Promise<ProjectRotationOutcome> {
  return advanceProxyTokenRotation(env.db, testEnv, projectId, options.budget ?? freshBudget(), {
    waitMs: options.waitMs ?? 0,
  });
}

function request(
  projectId: string,
  mode: 'member' | 'operator' = 'operator',
  reason: ProxyTokenRotationReason = mode === 'member' ? 'member-removed' : 'operator',
): Promise<void> {
  return requestProxyTokenRotation(env.db, projectId, reason, mode);
}

async function job(projectId: string) {
  const [row] = await env.db
    .select()
    .from(projectCleanupJobs)
    .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
  return row;
}

async function issued(projectId: string): Promise<number> {
  const [row] = await env.db
    .select({ gen: projects.proxy_token_gen })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row!.gen;
}

/** Generation recorded on the deployment row for the token its Worker holds. */
async function held(deploymentId: string): Promise<number> {
  const [row] = await env.db
    .select({ gen: deployments.proxy_token_gen })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  return row!.gen;
}

/** The generation the proxy would send: what resolve-worker reports. */
async function resolvedGen(projectId: string): Promise<unknown> {
  const response = await app.fetch(
    new Request(`http://localhost/internal/resolve-worker/${projectId}`, {
      method: 'POST',
      headers: {
        [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(
          JWT_SECRET,
          'resolve-worker',
          projectId,
        ),
      },
    }),
    testEnv,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { proxyTokenGen?: unknown }).proxyTokenGen;
}

/** Stops a run right after START, before the first Cloudflare call. */
const noCfCalls = () => ({ cfCallsRemaining: 0, deadline: Date.now() + 60_000 });

async function floor(projectId: string): Promise<unknown> {
  return routing.get(proxyTokenStateKey(projectId), 'json');
}

/** Moves the stored waits back by `seconds` and makes the job due. */
async function shiftBack(projectId: string, seconds = 3600): Promise<void> {
  const shifted = (field: string) => sql`CASE WHEN payload->>${field} IS NOT NULL
    THEN jsonb_build_object(${field}::text, to_char(((payload->>${field})::timestamptz
      - ${seconds}::integer * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    ELSE '{}'::jsonb END`;
  await env.db.execute(sql`UPDATE project_cleanup_jobs
    SET next_attempt_at = now(),
      payload = payload || ${shifted('waitUntil')} || ${shifted('lastPatchAt')}
    WHERE target = ${proxyTokenRotationTarget(projectId)}`);
}

async function dueNow(projectId: string): Promise<boolean> {
  const [row] = (
    await env.db.execute<{ due: boolean }>(
      sql`SELECT next_attempt_at <= now() AS due FROM project_cleanup_jobs
        WHERE target = ${proxyTokenRotationTarget(projectId)}`,
    )
  ).rows;
  return row!.due;
}

async function kick(projectId: string): Promise<void> {
  await env.db
    .update(projectCleanupJobs)
    .set({ next_attempt_at: sql`now()` })
    .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
}

/** One more step past the current wait, with real waits. */
async function step(projectId: string): Promise<ProjectRotationOutcome> {
  await shiftBack(projectId);
  return advance(projectId, { waitMs: 60_000 });
}

function scriptToken(cf: MockCfApiHandle, script: string): unknown {
  return cf.state.hostScripts.get(script)?.bindings.find((b) => b.name === '__VOID_PROXY_TOKEN')
    ?.text;
}

const patchedScripts = () =>
  events.filter((event) => event.startsWith('PATCH ')).map((event) => event.slice(6));

let deployCount = 0;

/** A Worker deploy through the API; returns the deployment id from the `done` event. */
async function deploy(projectId: string, jwt: string): Promise<string> {
  const code = `export default { fetch() { return new Response('${++deployCount}'); } }`;
  const response = await app.fetch(
    new Request(`http://localhost/projects/${projectId}/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
        assetManifest: {},
        workerFiles: { 'index.js': btoa(code) },
      }),
    }),
    testEnv,
  );
  expect(response.status).toBe(200);
  const events = (await readAllEvents(response)) as Array<{
    event: string;
    deployment?: string;
    message?: string;
  }>;
  const done = events.find((event) => event.event === 'done');
  expect(done, JSON.stringify(events.at(-1))).toBeDefined();
  return done!.deployment!;
}

describe('proxy token rotation', () => {
  it('patches native Durable Object credentials within the provider budget before revoking old tokens', async () => {
    const cf = cfApi();
    const bindings = Array.from({ length: 8 }, (_, index) => ({
      bindingName: `OBJECT_${index}`,
      className: `Object${index}`,
      storage: 'sqlite',
    }));
    const fx = await setupProject(cf, {
      retained: 0,
      manifest: { ...MANIFEST, version: 4, durableObjects: { bindings } },
    });
    const names: Array<string> = [];
    for (const binding of bindings) {
      const worker = await durableObjectWorkerName(fx.projectId, binding.className);
      names.push(worker);
      const namespaceId = `namespace-${binding.className}`;
      await env.db.insert(resources).values({
        id: `res_native_${binding.className}`,
        project_id: fx.projectId,
        type: 'durable-object',
        cf_id: worker,
        binding_name: binding.className,
        metadata: { dispatchNamespace: 'void-users', namespaceId, proxyTokenGen: 0 },
      });
      cf.seedHostScript({
        scriptName: worker,
        bindings: [
          ...workerBindings(fx.legacy),
          {
            type: 'durable_object_namespace',
            name: binding.bindingName,
            class_name: binding.className,
            namespace_id: namespaceId,
          },
          {
            type: 'plain_text',
            name: '__VOID_DURABLE_OWNER',
            text: JSON.stringify({
              protocol: 1,
              projectId: fx.projectId,
              dispatchNamespace: 'void-users',
              className: binding.className,
            }),
          },
          { type: 'plain_text', name: '__VOID_DURABLE_DEPLOYMENT', text: fx.active },
        ],
      });
    }
    await request(fx.projectId);
    let result: ProjectRotationOutcome | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await advance(fx.projectId, {
        budget: { cfCallsRemaining: 6, deadline: Date.now() + 60_000 },
      });
      if (result.status === 'done' || result.status === 'failed') {
        break;
      }
      expect(await floor(fx.projectId)).toBeNull();
      const appToken = scriptToken(cf, fx.worker(fx.active));
      expect(await routing.get(fx.queueKey, 'json')).toMatchObject({ proxyToken: appToken });
      expect(cron.states.get(fx.projectId)?.proxyToken).toBe(appToken);
      expect(appToken).toBe(await tok(fx.projectId, await held(fx.active)));
    }
    expect(result).toEqual({ status: 'done', gen: 1 });
    const token = await tok(fx.projectId, 1);
    for (const worker of names) {
      expect(scriptToken(cf, worker)).toBe(token);
    }
    const floorAt = events.indexOf(`kv ${proxyTokenStateKey(fx.projectId)}`);
    for (const worker of names) {
      expect(floorAt).toBeGreaterThan(events.indexOf(`PATCH ${worker}`));
    }
  });

  it('moves every Worker to the next generation before raising the floor', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { staticRetained: true });
    const token = await tok(fx.projectId, 1);
    const before = new Map(
      [...cf.state.hostScripts].map(([name, script]) => [name, structuredClone(script.bindings)]),
    );

    await request(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });

    expect(await issued(fx.projectId)).toBe(1);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    const floorAt = events.indexOf(`kv ${proxyTokenStateKey(fx.projectId)}`);
    const lastPatchAt = events.map((event) => event.startsWith('PATCH ')).lastIndexOf(true);
    expect(floorAt).toBeGreaterThan(lastPatchAt);

    const workers = [...fx.retained.slice(0, 2), fx.active].map(fx.worker);
    expect(patchedScripts()).toEqual(workers);
    // The static row has no script: one GET, no PATCH.
    expect(events).toContain(`GET ${fx.worker(fx.retained[2]!)}`);
    for (const patch of patches) {
      expect(patch.bindings).toEqual([
        { type: 'inherit', name: 'DB' },
        { type: 'inherit', name: '__VOID_PROXY' },
        { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: token },
        { type: 'inherit', name: 'API_KEY' },
      ]);
    }
    for (const worker of workers) {
      const stored = cf.state.hostScripts.get(worker)!.bindings;
      expect(stored.map((binding) => [binding.name, binding.type])).toEqual(
        before.get(worker)!.map((binding) => [binding.name, binding.type]),
      );
      expect(scriptToken(cf, worker)).toBe(token);
    }

    expect(cron.states.get(fx.projectId)).toEqual({
      workerName: fx.worker(fx.active),
      schedules: [{ name: 'crons/tick.ts', cron: '*/5 * * * *' }],
      proxyToken: token,
    });
    expect(await routing.get(fx.queueKey, 'json')).toEqual({
      workerName: fx.worker(fx.active),
      projectId: fx.projectId,
      queueName: 'emails',
      proxyToken: token,
    });
    expect(await job(fx.projectId)).toBeUndefined();
    for (const id of [...fx.retained, fx.active]) {
      expect(await held(id)).toBe(1);
    }
  });

  it('keeps the proxy metadata routes on the proxy credential through a rotation', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db.insert(resources).values({
      id: 'res_rotation_db',
      project_id: fx.projectId,
      type: 'd1',
      cf_id: 'd1-database-id',
      binding_name: 'DB',
    });
    const routes: Array<[ProxyInternalRoute, unknown]> = [
      ['resolve-worker', {}],
      ['resolve-resource', { type: 'd1', binding: 'DB' }],
      ['verify-prerender-build', { userId: fx.ownerId }],
    ];
    const statuses = async (
      headers: (route: ProxyInternalRoute) => Promise<Record<string, string>>,
    ) =>
      Promise.all(
        routes.map(async ([route, body]) => {
          const response = await app.fetch(
            new Request(`http://localhost/internal/${route}/${fx.projectId}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(await headers(route)) },
              body: JSON.stringify(body),
            }),
            testEnv,
          );
          return response.status;
        }),
      );
    const legacy = async () => ({
      'x-void-internal': await hmacSignState(fx.projectId, JWT_SECRET),
    });
    const tenant = (gen: number) => async () => ({
      'x-void-internal': await tok(fx.projectId, gen),
    });
    const proxy = async (route: ProxyInternalRoute) => ({
      [PROXY_INTERNAL_AUTH_HEADER]: await deriveProxyInternalAuth(JWT_SECRET, route, fx.projectId),
    });

    expect(await statuses(proxy)).toEqual([200, 200, 200]);

    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    // A member loses access after START: one more generation follows.
    await request(fx.projectId, 'member');
    expect((await job(fx.projectId))!.payload.again).toBe('1');
    await step(fx.projectId);
    expect((await job(fx.projectId))!.payload.phase).toBe('settle');
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });

    expect(await statuses(legacy)).toEqual([401, 401, 401]);
    expect(await statuses(proxy)).toEqual([200, 200, 200]);

    for (let index = 0; index < 4 && (await job(fx.projectId)); index++) {
      await step(fx.projectId);
    }
    expect(await job(fx.projectId)).toBeUndefined();
    expect(await issued(fx.projectId)).toBe(2);
    expect(await statuses(tenant(1))).toEqual([401, 401, 401]);
    expect(await statuses(tenant(2))).toEqual([401, 401, 401]);
    expect(await statuses(proxy)).toEqual([200, 200, 200]);
  });

  it('points the queue entry and cron scheduler at the new token only after its PATCH', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const token = await tok(fx.projectId, 1);
    const copies = async () => ({
      queue: (await routing.get(fx.queueKey, 'json')) as Record<string, unknown>,
      cron: cron.states.get(fx.projectId) as Record<string, unknown>,
    });
    const tokens = (proxyToken: string) => ({
      queue: {
        workerName: fx.worker(fx.active),
        projectId: fx.projectId,
        queueName: 'emails',
        proxyToken,
      },
      cron: {
        workerName: fx.worker(fx.active),
        schedules: [{ name: 'crons/tick.ts', cron: '*/5 * * * *' }],
        proxyToken,
      },
    });
    let beforeActivePatch: Awaited<ReturnType<typeof copies>> | undefined;
    hooks.fetch = async (method, script) => {
      if (method === 'PATCH' && script === fx.worker(fx.active)) {
        beforeActivePatch = structuredClone(await copies());
      }
      return undefined;
    };

    await request(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
      reason: 'waiting',
    });
    expect(beforeActivePatch).toEqual(tokens(fx.legacy));
    expect(scriptToken(cf, fx.worker(fx.active))).toBe(token);
    expect(await copies()).toEqual(tokens(token));
    expect(events.indexOf(`kv ${fx.queueKey}`)).toBeGreaterThan(
      events.indexOf(`PATCH ${fx.worker(fx.active)}`),
    );
    expect(await floor(fx.projectId)).toBeNull();

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    expect(await copies()).toEqual(tokens(token));
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
  });

  it('honors waits even when the job is kicked', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    const first = await advance(fx.projectId, { waitMs: 60_000 });
    expect(first).toMatchObject({ status: 'pending', phase: 'revoke', reason: 'waiting' });
    expect(first.status === 'pending' && first.retryAfterSeconds).toBeGreaterThan(50);
    expect(patchedScripts()).toHaveLength(3);

    await kick(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      reason: 'waiting',
    });
    expect(await floor(fx.projectId)).toBeNull();

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('records a PATCH that a failed copy write rolled back in the next step', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const token = await tok(fx.projectId, 1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.kvPut = (key) => {
      if (key === fx.queueKey) {
        throw new Error('queue routing write failed');
      }
    };
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({
      status: 'failed',
      phase: 'patch',
      workerName: fx.worker(fx.active),
    });
    expect(await issued(fx.projectId)).toBe(1);
    expect(scriptToken(cf, fx.worker(fx.active))).toBe(token);
    // The row stays behind the Worker, never ahead of it.
    expect(await held(fx.active)).toBe(0);
    expect(await resolvedGen(fx.projectId)).toBe(0);
    for (const id of fx.retained) {
      expect(await held(id)).toBe(1);
    }
    expect(await routing.get(fx.queueKey, 'json')).toMatchObject({ proxyToken: fx.legacy });

    // Senders still name tok(0), which the Worker now rejects, so the retry is
    // due on the next run instead of after the usual failure delay.
    hooks.kvPut = undefined;
    events.length = 0;
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
      reason: 'waiting',
    });
    // No second PATCH: the Worker already holds the token.
    expect(patchedScripts()).toEqual([]);
    expect(await held(fx.active)).toBe(1);
    expect(await resolvedGen(fx.projectId)).toBe(1);
    expect(await routing.get(fx.queueKey, 'json')).toEqual({
      workerName: fx.worker(fx.active),
      projectId: fx.projectId,
      queueName: 'emails',
      proxyToken: token,
    });
    expect(cron.states.get(fx.projectId)).toMatchObject({ proxyToken: token });
    // The PATCH from the failed attempt still drains before the floor rises.
    expect((await job(fx.projectId))!.payload.lastPatchAt).toBeDefined();

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('retries on every run, once per run, while copy writes keep failing after the PATCH', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.kvPut = (key) => {
      if (key === fx.queueKey) {
        throw new Error('queue routing write failed');
      }
    };
    await request(fx.projectId);
    // Each scheduled run tries the job once, even though it is due again at once.
    const run = () =>
      reconcileProxyTokenRotations(env.db, testEnv, { maxCfCalls: 100, maxMs: 25_000, waitMs: 0 });
    expect(await run()).toMatchObject({ done: 0, pending: 0, failed: 1 });
    expect((await job(fx.projectId))!.attempts).toBe(1);
    expect(await run()).toMatchObject({ done: 0, pending: 0, failed: 1 });

    expect((await job(fx.projectId))!.attempts).toBe(2);
    expect(await dueNow(fx.projectId)).toBe(true);
  });

  it('retries on the next run when a retained Worker took a PATCH whose response was lost', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const token = await tok(fx.projectId, 1);
    const retained = fx.worker(fx.retained[0]!);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A rollback to this deployment before the retry would make it active.
    hooks.fetch = (method, script) => {
      if (method !== 'PATCH' || script !== retained) {
        return undefined;
      }
      cf.state.hostScripts
        .get(script)!
        .bindings.find((b) => b.name === '__VOID_PROXY_TOKEN')!.text = token;
      return cfError('internal error', 500);
    };
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({
      status: 'failed',
      phase: 'patch',
      workerName: retained,
    });
    expect(scriptToken(cf, retained)).toBe(token);
    expect(await held(fx.retained[0]!)).toBe(0);
    expect(await dueNow(fx.projectId)).toBe(true);
  });

  it('writes the generation of a Worker only after Cloudflare confirms its PATCH', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 1 });
    const patchAt: Array<number> = [];
    hooks.fetch = (method) => {
      if (method === 'PATCH') {
        patchAt.push(capturedQueryCount(env.db));
      }
      return undefined;
    };
    await request(fx.projectId);
    const { result, queries } = await captureQueries(env.db, () =>
      advance(fx.projectId, { waitMs: 60_000 }),
    );
    expect(result).toMatchObject({ status: 'pending', phase: 'revoke' });
    const genWrites = queries.flatMap((query, index) =>
      /^update "deployments" set "proxy_token_gen"/i.test(query) ? [index] : [],
    );
    expect(patchAt).toHaveLength(2);
    expect(genWrites).toHaveLength(2);
    for (const [index, at] of patchAt.entries()) {
      expect(genWrites[index]).toBeGreaterThanOrEqual(at);
    }
    expect(await held(fx.retained[0]!)).toBe(1);
    expect(await held(fx.active)).toBe(1);
  });

  it('makes no outside call when START does not commit', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const cronCalls = cron.calls.length;
    await env.db.execute(sql`CREATE FUNCTION fail_rotation_start() RETURNS trigger AS $$
      BEGIN
        IF NEW.payload->>'phase' = 'patch' THEN RAISE EXCEPTION 'injected start failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await env.db
      .execute(sql`CREATE TRIGGER fail_rotation_start BEFORE UPDATE ON project_cleanup_jobs
      FOR EACH ROW EXECUTE FUNCTION fail_rotation_start()`);
    try {
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'requested' });
    } finally {
      await env.db.execute(sql`DROP TRIGGER fail_rotation_start ON project_cleanup_jobs`);
      await env.db.execute(sql`DROP FUNCTION fail_rotation_start()`);
    }
    expect(await issued(fx.projectId)).toBe(0);
    expect(events).toEqual([]);
    expect(cf.mock.calls).toHaveLength(0);
    expect(cron.calls.length).toBe(cronCalls);
    expect((await job(fx.projectId))!.attempts).toBe(1);
  });

  it('starts the wait after the floor write, not at the start of the step', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    let putDoneAt = 0;
    hooks.kvPut = async (key) => {
      if (key === proxyTokenStateKey(fx.projectId)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        putDoneAt = Date.now();
      }
    };
    const run = async () => {
      await shiftBack(fx.projectId);
      return advance(fx.projectId, { waitMs: PROXY_TOKEN_ROTATION_WAIT_MS });
    };
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: PROXY_TOKEN_ROTATION_WAIT_MS });
    await run();
    const payload = (await job(fx.projectId))!.payload;
    expect(payload.phase).toBe('settle');
    expect(putDoneAt).toBeGreaterThan(0);
    expect(Date.parse(payload.waitUntil!)).toBeGreaterThanOrEqual(
      putDoneAt + PROXY_TOKEN_ROTATION_WAIT_MS,
    );
  });

  it('does not restart the wait for a deploy that already holds the new token', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    expect((await job(fx.projectId))!.payload.phase).toBe('revoke');

    // A deploy admitted after START bakes tok(1) and becomes active.
    const deployed = await addDeployment(fx.projectId, { active: true, proxyTokenGen: 1 });
    cf.seedHostScript({
      scriptName: fx.worker(deployed),
      bindings: workerBindings(await tok(fx.projectId, 1)),
    });
    events.length = 0;
    // The original wait has passed; the walk must not start a new one.
    await shiftBack(fx.projectId, 61);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'settle',
    });
    expect(events).toContain(`GET ${fx.worker(deployed)}`);
    expect(patchedScripts()).toEqual([]);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('still drains a Worker whose PATCH applied in an attempt that failed', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 0 });
    const token = await tok(fx.projectId, 1);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Cloudflare applies the PATCH, but the response is lost.
    hooks.fetch = (method, script) => {
      if (method !== 'PATCH') {
        return undefined;
      }
      const binding = cf.state.hostScripts
        .get(script)!
        .bindings.find((b) => b.name === '__VOID_PROXY_TOKEN')!;
      binding.text = token;
      return cfError('internal error', 500);
    };
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
    expect(scriptToken(cf, fx.worker(fx.active))).toBe(token);

    hooks.fetch = undefined;
    await kick(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
      reason: 'waiting',
    });
    expect((await job(fx.projectId))!.payload.lastPatchAt).toBeDefined();
    expect(await floor(fx.projectId)).toBeNull();
    expect(patchedScripts()).toEqual([fx.worker(fx.active)]);

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('patches a Worker created after the walk passed before raising the floor', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const token = await tok(fx.projectId, 1);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    expect((await job(fx.projectId))!.payload.phase).toBe('revoke');

    // The active Worker already holds the new token; only the later row does not.
    const later = await addDeployment(fx.projectId);
    cf.seedHostScript({ scriptName: fx.worker(later), bindings: workerBindings(fx.legacy) });
    events.length = 0;
    expect(await step(fx.projectId)).toMatchObject({ status: 'pending', phase: 'revoke' });
    expect(patchedScripts()).toEqual([fx.worker(later)]);
    expect(scriptToken(cf, fx.worker(later))).toBe(token);
    expect(await floor(fx.projectId)).toBeNull();

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    expect(events.indexOf(`kv ${proxyTokenStateKey(fx.projectId)}`)).toBeGreaterThan(
      events.indexOf(`PATCH ${fx.worker(later)}`),
    );
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
  });

  it('never raises the floor while a Worker is unpatched', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let patchCount = 0;
    hooks.fetch = (method) =>
      method === 'PATCH' && ++patchCount === 2 ? cfError('internal error', 500) : undefined;

    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({
      status: 'failed',
      phase: 'patch',
      workerName: fx.worker(fx.retained[1]!),
    });
    const failed = (await job(fx.projectId))!;
    expect(failed.attempts).toBe(1);
    expect(failed.last_error).toContain('internal error');
    expect(await floor(fx.projectId)).toBeNull();
    const token = await tok(fx.projectId, 1);
    // The active Worker is not patched yet: its copies keep the token it holds.
    expect(await routing.get(fx.queueKey, 'json')).toEqual({
      workerName: fx.worker(fx.active),
      projectId: fx.projectId,
      queueName: 'emails',
      proxyToken: fx.legacy,
    });
    expect(cron.states.get(fx.projectId)).toMatchObject({ proxyToken: fx.legacy });
    expect(await held(fx.retained[0]!)).toBe(1);
    expect(await held(fx.retained[1]!)).toBe(0);

    const log = errors.mock.calls
      .map((call) => call.join(' '))
      .find((line) => line.includes('FAILED'));
    expect(log).toContain(`[proxy-token-rotation] FAILED ${fx.projectId} phase=patch attempts=1`);
    expect(log).not.toContain(fx.legacy);
    expect(log).not.toContain(token);

    hooks.fetch = undefined;
    events.length = 0;
    await kick(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(patchedScripts()).toEqual([fx.worker(fx.retained[1]!), fx.worker(fx.active)]);
    expect((await job(fx.projectId)) ?? null).toBeNull();
  });

  it('lets a second runner continue from the phase the first one left', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    expect(
      await advance(fx.projectId, {
        budget: { cfCallsRemaining: 0, deadline: Date.now() + 60_000 },
      }),
    ).toMatchObject({ status: 'pending', phase: 'patch', reason: 'budget' });
    expect(await issued(fx.projectId)).toBe(1);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(await issued(fx.projectId)).toBe(1);
  });

  it('patches a retained Worker a rollback made active during the rotation', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db.insert(resources).values({
      id: 'res_rotation_queue',
      project_id: fx.projectId,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });
    const token = await tok(fx.projectId, 1);
    await request(fx.projectId);
    expect(await advance(fx.projectId, { budget: noCfCalls() })).toMatchObject({
      status: 'pending',
      phase: 'patch',
    });
    expect(await issued(fx.projectId)).toBe(1);

    const target = fx.retained[0]!;
    const response = await app.fetch(
      new Request(`http://localhost/projects/${fx.projectId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fx.ownerJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId: target }),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    // Generation 1 is issued, but the target still holds the legacy token.
    expect(await resolvedGen(fx.projectId)).toBe(0);
    expect(await routing.get(fx.queueKey, 'json')).toEqual({
      workerName: fx.worker(target),
      projectId: fx.projectId,
      queueName: 'emails',
      proxyToken: fx.legacy,
    });

    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
    });
    expect(scriptToken(cf, fx.worker(target))).toBe(token);
    expect(await resolvedGen(fx.projectId)).toBe(1);
    expect(await routing.get(fx.queueKey, 'json')).toEqual({
      workerName: fx.worker(target),
      projectId: fx.projectId,
      queueName: 'emails',
      proxyToken: token,
    });
    await step(fx.projectId);
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('walks the Workers again when the active Worker still has the old token at REVOKE', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const active = fx.worker(fx.active);
    let activeGets = 0;
    hooks.fetch = (method, script) => {
      if (method === 'GET' && script === active && ++activeGets === 2) {
        return cfSuccess(workerBindings(fx.legacy));
      }
      return undefined;
    };
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    // PATCH, REVOKE (old token reported), re-walk GET, REVOKE again.
    expect(activeGets).toBe(4);
    expect(events.filter((event) => event === `GET ${fx.worker(fx.retained[0]!)}`)).toHaveLength(2);
  });

  it('walks the Workers again while a row does not record the new generation', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    expect((await job(fx.projectId))!.payload.phase).toBe('revoke');
    await env.db
      .update(deployments)
      .set({ proxy_token_gen: 0 })
      .where(eq(deployments.id, fx.retained[1]!));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    events.length = 0;

    await shiftBack(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
    });
    expect(await floor(fx.projectId)).toBeNull();
    expect(events.filter((event) => event.startsWith('GET '))).toEqual(
      [...fx.retained, fx.active].map((id) => `GET ${fx.worker(id)}`),
    );
    expect(patchedScripts()).toEqual([]);
    expect(await held(fx.retained[1]!)).toBe(1);

    await step(fx.projectId);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('waits while a deployment is in flight', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await createDeployment(env.db, fx.projectId, JSON.stringify(MANIFEST));
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({
      status: 'pending',
      phase: 'requested',
      reason: 'busy',
      retryAfterSeconds: 120,
    });
    expect(events).toEqual([]);
    expect(cf.mock.calls).toHaveLength(0);
    expect(await issued(fx.projectId)).toBe(0);
    expect((await job(fx.projectId))!.attempts).toBe(0);
  });

  it('fails until a project with an unrecorded active deployment is normalized', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, fx.projectId));
    await request(fx.projectId);
    const outcome = await advance(fx.projectId);
    expect(outcome).toMatchObject({ status: 'failed', phase: 'requested' });
    expect(outcome.status === 'failed' && outcome.error).toContain(
      'void platform project normalize',
    );
    expect(await issued(fx.projectId)).toBe(0);
  });

  describe('Workers that cannot or need not be patched', () => {
    it('skips a retained Worker without a proxy token binding', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      cf.state.hostScripts.get(fx.worker(fx.retained[0]!))!.bindings = [
        { type: 'd1', name: 'DB', id: 'd1-database-id' },
      ];
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await request(fx.projectId);
      await advance(fx.projectId, { waitMs: 60_000 });
      expect((await job(fx.projectId))!.payload.phase).toBe('revoke');
      const [project] = await env.db.select().from(projects).where(eq(projects.id, fx.projectId));
      expect(
        (await listProxyTokenInventory(env.db, project!)).map((row) => row.workerName),
      ).toEqual([fx.retained[1]!, fx.active].map(fx.worker));

      expect(await step(fx.projectId)).toMatchObject({ status: 'pending', phase: 'settle' });
      expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
      expect(patchedScripts()).toEqual([fx.worker(fx.retained[1]!), fx.worker(fx.active)]);
      expect(log).toHaveBeenCalledWith(
        `[proxy-token-rotation] skipped ${fx.projectId} worker=${fx.worker(fx.retained[0]!)} has no __VOID_PROXY_TOKEN binding; redeploy the project to give it one`,
      );
      // Its row still names the token it holds; the floor rises past it.
      expect(await held(fx.retained[0]!)).toBe(0);
      expect(await held(fx.retained[1]!)).toBe(1);
      expect(await held(fx.active)).toBe(1);
      expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    });

    it('leaves the row and copies of an active Worker without a proxy token binding', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      cf.state.hostScripts.get(fx.worker(fx.active))!.bindings = [
        { type: 'd1', name: 'DB', id: 'd1-database-id' },
      ];
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });

      expect(patchedScripts()).toEqual(fx.retained.map(fx.worker));
      // One GET in the walk and one at REVOKE: no re-walk for its row.
      expect(events.filter((event) => event === `GET ${fx.worker(fx.active)}`)).toHaveLength(2);
      expect(await held(fx.active)).toBe(0);
      expect(await resolvedGen(fx.projectId)).toBe(0);
      expect((await routing.get(fx.queueKey, 'json')) as Record<string, unknown>).toMatchObject({
        proxyToken: fx.legacy,
      });
      expect(cron.states.get(fx.projectId)).toMatchObject({ proxyToken: fx.legacy });
      for (const id of fx.retained) {
        expect(await held(id)).toBe(1);
      }
      expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    });

    it('fails when the active Worker of a Worker project has no script', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf, { activeScript: false });
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({
        status: 'failed',
        phase: 'patch',
        workerName: fx.worker(fx.active),
      });
      expect(await floor(fx.projectId)).toBeNull();
    });

    it('fails on a proxy token binding that is not plain text', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      cf.state.hostScripts.get(fx.worker(fx.retained[0]!))!.bindings = [
        { type: 'secret_text', name: '__VOID_PROXY_TOKEN' },
      ];
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
      expect(patchedScripts()).toEqual([]);
    });

    it('fails without a re-walk when the active script disappears before REVOKE', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf);
      await request(fx.projectId);
      await advance(fx.projectId, { waitMs: 60_000 });
      cf.state.hostScripts.delete(fx.worker(fx.active));
      events.length = 0;
      expect(await step(fx.projectId)).toMatchObject({
        status: 'failed',
        phase: 'revoke',
        workerName: fx.worker(fx.active),
      });
      expect(events).toEqual([`GET ${fx.worker(fx.active)}`]);
      expect((await job(fx.projectId))!.attempts).toBe(1);
      expect((await job(fx.projectId))!.payload.phase).toBe('revoke');
      expect(await floor(fx.projectId)).toBeNull();
    });

    it('finishes a static project whose deployments have no script', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf, {
        type: 'static',
        retained: 0,
        activeScript: false,
        manifest: { version: 3, type: 'static' },
      });
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
      expect(events.filter((event) => event.startsWith('GET '))).toEqual([
        `GET ${fx.worker(fx.active)}`,
        `GET ${fx.worker(fx.active)}`,
      ]);
      expect(await floor(fx.projectId)).toEqual({ gen: 1 });
    });

    it('patches Worker rows whose manifest looks static', async () => {
      const cf = cfApi();
      const fx = await setupProject(cf, { retained: 1, manifest: null });
      await request(fx.projectId);
      expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
      expect(patchedScripts()).toEqual([fx.worker(fx.retained[0]!), fx.worker(fx.active)]);
      expect(events.filter((event) => event === `GET ${fx.worker(fx.active)}`)).toHaveLength(2);
    });
  });

  it('patches again when a PATCH did not take', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 0 });
    let first = true;
    hooks.fetch = (method, script) => {
      if (method === 'PATCH' && first) {
        first = false;
        return cfSuccess({ bindings: cf.state.hostScripts.get(script)!.bindings });
      }
      return undefined;
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(fx.projectId);
    expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
    await kick(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(patchedScripts()).toEqual([fx.worker(fx.active), fx.worker(fx.active)]);
  });

  it('stops the tick on a rate limit without counting a failure', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    const other = await setupProject(cf);
    hooks.fetch = (method) =>
      method === 'PATCH'
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })
        : undefined;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(fx.projectId);
    await request(other.projectId);

    expect(await reconcileProxyTokenRotations(env.db, testEnv, { waitMs: 0 })).toEqual({
      done: 0,
      pending: 1,
      failed: 0,
      retryAfterSeconds: 120,
    });
    expect(log).toHaveBeenCalledWith(
      `[proxy-token-rotation] RATE-LIMITED ${fx.projectId} phase=patch retryAfter=120s`,
    );
    const limited = (await job(fx.projectId))!;
    expect(limited.attempts).toBe(0);
    expect(limited.payload.cursor).toBe('');
    const [due] = await env.db
      .execute<{ inWindow: boolean }>(
        sql`SELECT next_attempt_at BETWEEN now() + interval '100 seconds' AND now() + interval '140 seconds' AS "inWindow"
        FROM project_cleanup_jobs WHERE target = ${proxyTokenRotationTarget(fx.projectId)}`,
      )
      .then((result) => result.rows);
    expect(due!.inWindow).toBe(true);
    // The step's transaction rolled back: the project row is free.
    await env.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${fx.projectId} FOR UPDATE NOWAIT`);
    });
    expect((await job(other.projectId))!.payload.phase).toBe('requested');
  });

  it('cuts a run at the Cloudflare call budget without counting a failure', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 12 });
    await request(fx.projectId);
    let runs = 0;
    for (; runs < 10 && (await job(fx.projectId)); runs++) {
      const before = patchedScripts().length;
      const summary = await reconcileProxyTokenRotations(env.db, testEnv, {
        maxCfCalls: 7,
        waitMs: 0,
      });
      expect(patchedScripts().length - before).toBeLessThanOrEqual(3);
      const row = await job(fx.projectId);
      if (!row) {
        expect(summary).toMatchObject({ done: 1, pending: 0 });
        break;
      }
      expect(summary).toMatchObject({ done: 0, pending: 1, failed: 0 });
      expect(row.attempts).toBe(0);
      expect(await floor(fx.projectId)).toBeNull();
      const [due] = (
        await env.db.execute<{ due: boolean }>(
          sql`SELECT next_attempt_at <= now() AS due FROM project_cleanup_jobs
            WHERE target = ${proxyTokenRotationTarget(fx.projectId)}`,
        )
      ).rows;
      expect(due!.due).toBe(true);
    }
    expect(patchedScripts()).toHaveLength(13);
    expect(await floor(fx.projectId)).toEqual({ gen: 1 });
  });

  it('runs one more generation for a request after START, not before', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId, 'member');
    await request(fx.projectId, 'member');
    expect((await job(fx.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'member-removed',
    });

    await advance(fx.projectId, { waitMs: 60_000 });
    await request(fx.projectId, 'member', 'member-role-changed');
    expect((await job(fx.projectId))!.payload.again).toBe('1');
    await shiftBack(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 2 });
    const token = await tok(fx.projectId, 2);
    for (const id of [...fx.retained, fx.active]) {
      expect(scriptToken(cf, fx.worker(id))).toBe(token);
    }
    expect(await floor(fx.projectId)).toEqual({ gen: 2 });
  });

  it('drops the job when the project is being deleted', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await request(fx.projectId);
    await advance(fx.projectId, { waitMs: 60_000 });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, fx.projectId));
    events.length = 0;
    expect(await step(fx.projectId)).toEqual({ status: 'done', gen: 1 });
    expect(await job(fx.projectId)).toBeUndefined();
    expect(events).toEqual([]);
    expect(await floor(fx.projectId)).toBeNull();
  });

  it('raises the floor of a project without deployments', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    await request(project.id);
    expect(await advance(project.id)).toEqual({ status: 'done', gen: 1 });
    expect(await floor(project.id)).toEqual({ gen: 1 });
  });

  it('queues every project in a bulk request and flags jobs past START', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const started = await createTestProject(env.db, owner.id);
    const idle = await createTestProject(env.db, owner.id);
    const deleting = await createTestProject(env.db, owner.id);
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, deleting.id));
    await request(started.id);
    await advance(started.id, { waitMs: 60_000 });

    expect(await requestBulkProxyTokenRotations(env.db)).toBe(2);
    expect((await job(started.id))!.payload.again).toBe('1');
    expect((await job(idle.id))!.payload).toEqual({
      phase: 'requested',
      reason: 'operator-bulk',
    });
    expect(await job(deleting.id)).toBeUndefined();

    expect(await requestBulkProxyTokenRotations(env.db)).toBe(1);
    expect((await job(idle.id))!.payload.again).toBeUndefined();
  });

  it('is never claimed by the generic cleanup runner', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    await request(project.id);
    await reconcileProjectCleanupJobs(env.db, testEnv as never);
    expect(await job(project.id)).toMatchObject({
      attempts: 0,
      payload: { phase: 'requested', reason: 'operator' },
    });
  });

  it('locks the project row before each step that calls Cloudflare', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    let queriesBeforeFirstCall: number | undefined;
    hooks.fetch = () => {
      queriesBeforeFirstCall ??= capturedQueryCount(env.db);
      return undefined;
    };
    await request(fx.projectId);
    const { result, queries } = await captureQueries(env.db, () => advance(fx.projectId));
    expect(result).toEqual({ status: 'done', gen: 1 });
    const projectLock = (query: string) => /from "projects".* for update/i.test(query);
    expect(queries.slice(0, queriesBeforeFirstCall).some(projectLock)).toBe(true);
    // START, one per Worker, walk end, REVOKE.
    expect(queries.filter(projectLock).length).toBeGreaterThanOrEqual(2 + 4);
  });

  it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
    'keeps a secret written during a PATCH step (lost secret race)',
    async () => {
      const cf = cfApi({
        setWorkerSecret: async (url, init) => {
          const body = JSON.parse(String(init?.body)) as { name: string };
          events.push(`secret ${body.name}`);
          cf.state.hostScripts.get(scriptNameOf(url))!.bindings.push({
            type: 'secret_text',
            name: body.name,
          });
          return cfSuccess({});
        },
      });
      const fx = await setupProject(cf, { retained: 0 });
      await request(fx.projectId);
      await advance(fx.projectId, { waitMs: 60_000 });
      await shiftBack(fx.projectId);
      let secretWrite: Promise<Response> | undefined;
      // Give the secret write time to land inside the step; the project lock
      // must hold it until the step finishes.
      hooks.fetch = async (method, script) => {
        if (method === 'GET' && script === fx.worker(fx.active) && !secretWrite) {
          secretWrite = Promise.resolve(
            app.fetch(
              new Request(`http://localhost/projects/${fx.projectId}/secrets/RACE_SECRET`, {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${fx.ownerJwt}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ value: 'race-value' }),
              }),
              testEnv,
            ),
          );
          await Promise.race([secretWrite, new Promise((resolve) => setTimeout(resolve, 500))]);
        }
        return undefined;
      };
      const [first, second] = await Promise.all([
        advance(fx.projectId, { waitMs: 0 }),
        advance(fx.projectId, { waitMs: 0 }),
      ]);
      expect((await secretWrite!).status).toBe(200);
      expect([first.status, second.status]).toContain('done');
      for (let index = 0; index < 5 && (await job(fx.projectId)); index++) {
        await kick(fx.projectId);
        await advance(fx.projectId);
      }
      expect(await issued(fx.projectId)).toBe(1);
      const patchAt = events.indexOf(`PATCH ${fx.worker(fx.active)}`);
      expect(patchAt).toBeGreaterThan(-1);
      expect(events.indexOf('secret RACE_SECRET')).toBeGreaterThan(patchAt);
      const stored = cf.state.hostScripts.get(fx.worker(fx.active))!.bindings;
      expect(stored.map((binding) => binding.name)).toContain('RACE_SECRET');
      expect(scriptToken(cf, fx.worker(fx.active))).toBe(await tok(fx.projectId, 1));
    },
  );
});

describe('issuing the proxy token for a deploy', () => {
  const issue = (projectId: string) => issueProjectProxyToken(env.db, JWT_SECRET, projectId);

  it('moves a project without Workers to generation 1 without a rotation', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);

    expect(await issue(project.id)).toEqual({ gen: 1, token: await tok(project.id, 1) });
    expect(await issued(project.id)).toBe(1);
    expect(await job(project.id)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('leaves older Workers on the legacy token until a rotation', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf);
    await env.db.update(users).set({ plan: 'pro' }).where(eq(users.id, fx.ownerId));

    const deployed = await deploy(fx.projectId, fx.ownerJwt);
    expect(await issued(fx.projectId)).toBe(1);
    expect(scriptToken(cf, fx.worker(deployed))).toBe(await tok(fx.projectId, 1));
    expect(await held(deployed)).toBe(1);
    for (const id of [...fx.retained, fx.active]) {
      expect(await held(id)).toBe(0);
    }
    for (const id of [...fx.retained, fx.active]) {
      expect(scriptToken(cf, fx.worker(id))).toBe(fx.legacy);
    }
    expect(await job(fx.projectId)).toBeUndefined();
    expect(await floor(fx.projectId)).toBeNull();
    expect(patchedScripts()).toEqual([]);

    await request(fx.projectId);
    await shiftBack(fx.projectId);
    expect(await advance(fx.projectId)).toEqual({ status: 'done', gen: 2 });
    const token = await tok(fx.projectId, 2);
    for (const id of [...fx.retained, fx.active, deployed]) {
      expect(scriptToken(cf, fx.worker(id))).toBe(token);
    }
    expect(await floor(fx.projectId)).toEqual({ gen: 2 });
  });

  it('issues the current generation of a project past generation 0', async () => {
    cfApi();
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    await addDeployment(project.id, { active: true });
    await env.db.update(projects).set({ proxy_token_gen: 3 }).where(eq(projects.id, project.id));

    expect(await issue(project.id)).toEqual({ gen: 3, token: await tok(project.id, 3) });
    expect(await issued(project.id)).toBe(3);
    expect(await job(project.id)).toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('rotation after code from a user who lost deploy access is replaced', () => {
  type Team = Readonly<{
    projectId: string;
    owner: Awaited<ReturnType<typeof createTestUser>>;
    collaborator: Awaited<ReturnType<typeof createTestUser>>;
    worker: (deploymentId: string) => string;
  }>;

  async function setupTeam(): Promise<Team> {
    const owner = await createTestUser(env.db);
    const collaborator = await createTestUser(env.db);
    // Keep earlier Workers for rollback and for the walk.
    await env.db.update(users).set({ plan: 'pro' }).where(eq(users.id, owner.id));
    const { id: projectId, slug } = await createTestProject(env.db, owner.id);
    await env.db.insert(projectMembers).values({
      project_id: projectId,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    return {
      projectId,
      owner,
      collaborator,
      worker: (deploymentId) => getProjectDeploymentWorkerName(slug, deploymentId),
    };
  }

  async function rollback(projectId: string, jwt: string, deploymentId: string): Promise<void> {
    const response = await app.fetch(
      new Request(`http://localhost/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId }),
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
  }

  async function removeCollaborator(team: Team): Promise<void> {
    const response = await app.fetch(
      new Request(`http://localhost/projects/${team.projectId}/members/${team.collaborator.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${team.owner.jwt}` },
      }),
      testEnv,
    );
    expect(response.status).toBe(204);
  }

  /** Runs the job past every wait until it is gone. */
  async function finish(projectId: string): Promise<ProjectRotationOutcome> {
    await shiftBack(projectId);
    const outcome = await advance(projectId);
    expect(await job(projectId)).toBeUndefined();
    return outcome;
  }

  async function expectWorkersOn(
    cf: MockCfApiHandle,
    team: Team,
    deploymentIds: ReadonlyArray<string>,
    gen: number,
  ): Promise<void> {
    const token = await tok(team.projectId, gen);
    for (const id of deploymentIds) {
      expect(scriptToken(cf, team.worker(id))).toBe(token);
    }
  }

  it("rotates again when the owner replaces a removed collaborator's code", async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    expect((await job(team.projectId))!.payload.reason).toBe('member-removed');
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });

    const trusted = await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'untrusted-deploy-replaced',
    });
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 3 });
    expect(await issued(team.projectId)).toBe(3);
    await expectWorkersOn(cf, team, [trusted], 3);
    // The retained copy of the removed collaborator's code keeps the token the
    // floor now rejects.
    await expectWorkersOn(cf, team, [untrusted], 2);
    expect(await floor(team.projectId)).toEqual({ gen: 3 });

    // The code being replaced now is the owner's: nothing more to rotate.
    await deploy(team.projectId, team.owner.jwt);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it('never gives a new token to retained code whose author can no longer deploy', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    const trusted = await deploy(team.projectId, team.owner.jwt);
    await removeCollaborator(team);
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });
    await expectWorkersOn(cf, team, [trusted], 2);
    await expectWorkersOn(cf, team, [untrusted], 1);

    // Rolling back to it does not bring its token back.
    await rollback(team.projectId, team.owner.jwt, untrusted);
    expect(await job(team.projectId)).toBeUndefined();
    await expectWorkersOn(cf, team, [untrusted], 1);
    expect(await floor(team.projectId)).toEqual({ gen: 2 });
    await request(team.projectId);
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 3 });
    await expectWorkersOn(cf, team, [untrusted], 3);
    // Active again, it gets the token; replacing it rotates once more.
    await rollback(team.projectId, team.owner.jwt, trusted);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 4 });
    await expectWorkersOn(cf, team, [untrusted], 3);
    await expectWorkersOn(cf, team, [trusted], 4);
  });

  it('moves past the generation the first deploy issued when a member is removed', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const deployed = await deploy(team.projectId, team.owner.jwt);
    expect(await issued(team.projectId)).toBe(1);
    expect(await job(team.projectId)).toBeUndefined();

    await removeCollaborator(team);
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });
    await expectWorkersOn(cf, team, [deployed], 2);
  });

  it('runs one more generation when the replacement lands after START', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    await advance(team.projectId, { budget: noCfCalls() });
    expect((await job(team.projectId))!.payload.phase).toBe('patch');

    const trusted = await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.again).toBe('1');
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 3 });
    await expectWorkersOn(cf, team, [trusted], 3);
    // Already retained when the walk reached it, so it never got generation 2.
    await expectWorkersOn(cf, team, [untrusted], 1);
  });

  it('needs no extra generation when the replacement lands before START', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);

    const trusted = await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'member-removed',
    });
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });
    await expectWorkersOn(cf, team, [trusted], 2);
    await expectWorkersOn(cf, team, [untrusted], 1);
  });

  it('rotates when the next deploy finishes an interrupted cutover over the code', async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });

    // The owner's deploy stopped after the cutover became ready.
    const interrupted = await createTestDeployment(env.db, team.projectId, 'pending');
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({ version: 3, type: 'static', bindings: {} }),
      })
      .where(eq(deployments.id, interrupted.id));
    const marker = JSON.stringify({
      projectId: team.projectId,
      ownerId: 'interrupted-owner',
      buildId: null,
    });
    await routing.put(`cutover-intent:${interrupted.id}`, marker);
    await routing.put(`cutover-ready:${interrupted.id}`, marker);

    await deploy(team.projectId, team.owner.jwt);
    const [recovered] = await env.db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, interrupted.id));
    expect(recovered!.status).toBe('live');
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'untrusted-deploy-replaced',
    });
  });

  it('rotates on a rollback away from the code, not on a rollback to it', async () => {
    cfApi();
    const team = await setupTeam();
    const trusted = await deploy(team.projectId, team.owner.jwt);
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    await finish(team.projectId);

    await rollback(team.projectId, team.owner.jwt, trusted);
    expect((await job(team.projectId))!.payload).toEqual({
      phase: 'requested',
      reason: 'untrusted-deploy-replaced',
    });
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 3 });

    await rollback(team.projectId, team.owner.jwt, untrusted);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it("rotates when the code's author was changed to reader", async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    const changed = await app.fetch(
      new Request(`http://localhost/projects/${team.projectId}/members/${team.collaborator.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${team.owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader' }),
      }),
      testEnv,
    );
    expect(changed.status).toBe(200);
    await finish(team.projectId);

    await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  it("rotates when the code's author account was deleted", async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    await deleteUser(env.db, team.collaborator.id);
    expect((await job(team.projectId))!.payload.reason).toBe('user-deleted');
    await finish(team.projectId);

    await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  // Deployments made before project teams have no recorded author. Only the
  // owner could deploy then, and the billing user is that owner.
  async function unattributed(deploymentId: string, ownerThen: string): Promise<void> {
    await env.db
      .update(deployments)
      .set({ initiated_by_user_id: null, billing_user_id: ownerThen })
      .where(eq(deployments.id, deploymentId));
  }

  it('does not rotate for code without an author from an owner who can still deploy', async () => {
    cfApi();
    const team = await setupTeam();
    const old = await deploy(team.projectId, team.owner.jwt);
    await unattributed(old, team.owner.id);
    await removeCollaborator(team);
    await finish(team.projectId);

    await deploy(team.projectId, team.owner.jwt);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it('treats code without an author as deployed by the owner of that time', async () => {
    const cf = cfApi();
    const team = await setupTeam();
    // The collaborator owned the project before transferring it.
    const retained = await deploy(team.projectId, team.collaborator.jwt);
    const old = await deploy(team.projectId, team.collaborator.jwt);
    await unattributed(retained, team.collaborator.id);
    await unattributed(old, team.collaborator.id);
    await removeCollaborator(team);
    expect(await finish(team.projectId)).toEqual({ status: 'done', gen: 2 });
    await expectWorkersOn(cf, team, [old], 2);
    await expectWorkersOn(cf, team, [retained], 1);

    await deploy(team.projectId, team.owner.jwt);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  it('does not treat a suspended owner as lost deploy access', async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, team.owner.id));
    const next = await createDeployment(env.db, team.projectId, JSON.stringify(MANIFEST));

    const requested = await env.db.transaction((tx) =>
      requestRotationIfReplacingUntrustedCode(tx, team.projectId, next.id),
    );
    expect(requested).toBe(false);
    expect(await job(team.projectId)).toBeUndefined();
  });

  it("rotates when the code's author is suspended by an admin", async () => {
    cfApi();
    const team = await setupTeam();
    await deploy(team.projectId, team.collaborator.jwt);
    const replace = async () => {
      const next = await createDeployment(env.db, team.projectId, JSON.stringify(MANIFEST));
      return env.db.transaction((tx) =>
        requestRotationIfReplacingUntrustedCode(tx, team.projectId, next.id),
      );
    };

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, team.collaborator.id));
    expect(await replace()).toBe(false);
    expect(await job(team.projectId)).toBeUndefined();

    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, team.collaborator.id));
    expect(await replace()).toBe(true);
    expect((await job(team.projectId))!.payload.reason).toBe('untrusted-deploy-replaced');
  });

  it('does not rotate when a failed deploy leaves the code in place', async () => {
    cfApi();
    const team = await setupTeam();
    const untrusted = await deploy(team.projectId, team.collaborator.jwt);
    await removeCollaborator(team);
    await finish(team.projectId);

    hooks.kvPut = (key) => {
      if (key.startsWith('cutover-ready:')) {
        throw new Error('injected post-routing failure');
      }
    };
    const response = await app.fetch(
      new Request(`http://localhost/projects/${team.projectId}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${team.owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: { version: 3, assetManifestVersion: 2, bindings: {} },
          assetManifest: {},
          workerFiles: {
            'index.js': btoa("export default { fetch() { return new Response('x'); } }"),
          },
        }),
      }),
      testEnv,
    );
    const events = (await readAllEvents(response)) as Array<{ event: string }>;
    expect(events.at(-1)).toMatchObject({ event: 'error' });
    const [project] = await env.db
      .select({ active: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, team.projectId));
    expect(project!.active).toBe(untrusted);
    expect(await job(team.projectId)).toBeUndefined();
  });
});

describe('owner warning for a stuck rotation', () => {
  async function setAttempts(projectId: string, attempts: number): Promise<void> {
    await env.db
      .update(projectCleanupJobs)
      .set({ attempts })
      .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(projectId)));
  }

  const warnings = (
    projectId: string,
    role: 'reader' | 'collaborator' | 'admin' | 'owner' = 'owner',
    deployScoped = false,
  ) => proxyTokenRotationWarnings(env.db, projectId, role, deployScoped);

  it('warns owners and admins once a rotation has failed four times in a row', async () => {
    const owner = await createTestUser(env.db);
    const { id: projectId } = await createTestProject(env.db, owner.id);
    expect(await warnings(projectId)).toEqual([]);

    await request(projectId);
    await setAttempts(projectId, PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS - 1);
    expect(await warnings(projectId)).toEqual([]);

    await setAttempts(projectId, PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS);
    expect(await warnings(projectId)).toEqual([proxyTokenRotationStuckWarning(projectId)]);
    expect(await warnings(projectId, 'admin')).toEqual([proxyTokenRotationStuckWarning(projectId)]);
    expect(proxyTokenRotationStuckWarning(projectId)).toContain(projectId);
  });

  it('never warns readers, collaborators or deploy tokens', async () => {
    const owner = await createTestUser(env.db);
    const { id: projectId } = await createTestProject(env.db, owner.id);
    await request(projectId);
    await setAttempts(projectId, 10);
    expect(await warnings(projectId, 'reader')).toEqual([]);
    expect(await warnings(projectId, 'collaborator')).toEqual([]);
    expect(await warnings(projectId, 'owner', true)).toEqual([]);
  });

  it('shows while steps keep failing and clears after a good step', async () => {
    const cf = cfApi();
    const fx = await setupProject(cf, { retained: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.fetch = (method) => (method === 'PATCH' ? cfError('internal error', 500) : undefined);

    await request(fx.projectId);
    for (let run = 1; run <= PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS; run++) {
      expect(await warnings(fx.projectId)).toEqual([]);
      await kick(fx.projectId);
      expect(await advance(fx.projectId)).toMatchObject({ status: 'failed', phase: 'patch' });
    }
    expect((await job(fx.projectId))!.attempts).toBe(PROXY_TOKEN_ROTATION_STUCK_ATTEMPTS);
    expect(await warnings(fx.projectId)).toEqual([proxyTokenRotationStuckWarning(fx.projectId)]);

    hooks.fetch = undefined;
    await kick(fx.projectId);
    expect(await advance(fx.projectId, { waitMs: 60_000 })).toMatchObject({
      status: 'pending',
      phase: 'revoke',
      reason: 'waiting',
    });
    expect((await job(fx.projectId))!.attempts).toBe(0);
    expect(await warnings(fx.projectId)).toEqual([]);
  });
});
