import { PLATFORM_APPLICATION_KEY, PLATFORM_SANDBOX_DRAIN_KEY } from '@void/platform';
import { asc, eq, sql } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import { getDeployment } from '../../src/db.ts';
import { app } from '../../src/index.ts';
import { getProjectDeploymentWorkerName } from '../../src/naming.ts';
import { loadSandboxDeploymentPageProjection } from '../../src/operator/sandbox-operations.ts';
import {
  advanceProxyTokenRotation,
  reconcileProxyTokenRotations,
  requestProxyTokenRotation,
  type ProxyTokenRotationEnv,
} from '../../src/proxy-token-rotation.ts';
import { deriveProxyToken } from '../../src/proxy-token.ts';
import { databaseTimestampMs } from '../../src/routes/deploy.ts';
import { readSandboxDrainCheckpoint } from '../../src/sandbox-drain.ts';
import {
  deployments,
  operatorEvents,
  platformEvents,
  projectCleanupJobs,
  projects,
  resources,
  sandboxDrainCheckpoints,
} from '../../src/schema.ts';
import { BUILD_INSTANCE_LARGE } from '../../src/tiers.ts';
import {
  cfError,
  cfSuccess,
  createTestBuild,
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  JWT_SECRET,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type MockCfApiHandle,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let token: string;
let ownerId: string;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await env.db.delete(platformEvents);
  await clearTables(env.db);
  await env.db.delete(sandboxDrainCheckpoints);
  await env.ROUTING.delete(PLATFORM_SANDBOX_DRAIN_KEY);
  delete env.PLATFORM_INSTALLATION_ID;
  delete env.PLATFORM_CAPABILITIES;
  const user = await createTestUser(env.db, 'operator', 'github', undefined, 'free', 'admin');
  ownerId = user.id;
  token = await createOperatorToken(env.db, user);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function req(path: string, body?: Record<string, unknown>, extraEnv?: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { ...env, ...extraEnv },
  );
}
async function applyDrainUntilComplete(extraEnv?: Record<string, unknown>) {
  const responses: Array<Response> = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await req('/system/sandbox-drain', {}, extraEnv);
    responses.push(response);
    const body = (await response.clone().json()) as { complete?: boolean };
    if (body.complete) {
      return responses;
    }
  }
  throw new Error('Sandbox drain did not complete within ten bounded pages.');
}
function namespace(payload: unknown, status = 200) {
  const fetch = vi.fn(async (_input: unknown) => Response.json(payload, { status }));
  return {
    fetch,
    ns: {
      idFromName: (id: string) => id,
      get: () => ({ fetch }),
    } as unknown as DurableObjectNamespace,
  };
}

async function createLegacySandboxDeployment(
  projectId: string,
  status: 'pending' | 'live',
  source?: string,
) {
  return createTestDeployment(env.db, projectId, status, source, undefined, {
    admissionProtocol: 2,
  });
}

test('database admission rejects protocol zero after the v2 barrier is armed', async () => {
  const project = await createTestProject(env.db, ownerId, 'admission-barrier');
  await env.db.insert(sandboxDrainCheckpoints).values({
    admission_protocol: 2,
    singleton: true,
    generation: 'admission-v2',
    state: 'complete',
    phase: 'resources',
    cursor: { pass: '2' },
    completed_at: new Date().toISOString(),
  });

  await expect(
    env.db.execute(sql`
      INSERT INTO deployments (id, project_id)
      VALUES ('dpl_legacy_admission', ${project.id})
    `),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining(
        'deployment admission protocol 0 is below required protocol 2',
      ),
    },
  });

  await env.db.insert(deployments).values({ id: 'dpl_v2_admission', project_id: project.id });
  const [admitted] = await env.db
    .select({ admissionProtocol: deployments.admission_protocol })
    .from(deployments)
    .where(eq(deployments.id, 'dpl_v2_admission'));
  expect(admitted?.admissionProtocol).toBe(3);
});

test.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
  'updating an existing v2 barrier waits for a legacy admission transaction',
  async () => {
    const project = await createTestProject(env.db, ownerId, 'admission-lock');
    await env.db.insert(sandboxDrainCheckpoints).values({
      admission_protocol: 0,
      singleton: true,
      generation: 'admission-v0',
      state: 'draining',
      phase: 'deployments',
      cursor: { pass: '1' },
    });
    let releaseLegacy!: () => void;
    const legacyMayCommit = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    let legacyAdmitted!: () => void;
    const legacyInserted = new Promise<void>((resolve) => {
      legacyAdmitted = resolve;
    });
    const legacyTransaction = env.db.transaction(async (tx) => {
      await tx.insert(deployments).values({
        admission_protocol: 0,
        id: 'dpl_legacy_inflight',
        project_id: project.id,
      });
      legacyAdmitted();
      await legacyMayCommit;
    });
    await legacyInserted;

    let barrierArmed = false;
    const armBarrier = env.db
      .update(sandboxDrainCheckpoints)
      .set({ admission_protocol: 2 })
      .where(eq(sandboxDrainCheckpoints.singleton, true))
      .then(() => {
        barrierArmed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(barrierArmed).toBe(false);

    releaseLegacy();
    await legacyTransaction;
    await armBarrier;
    expect(barrierArmed).toBe(true);
    const admitted = await env.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.id, 'dpl_legacy_inflight'));
    expect(admitted).toEqual([{ id: 'dpl_legacy_inflight' }]);
  },
);

test.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL))(
  'arming v2 with no checkpoint waits for legacy admission before inventory',
  async () => {
    const project = await createTestProject(env.db, ownerId, 'admission-table-lock');
    let releaseLegacy!: () => void;
    const legacyMayCommit = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    let legacyAdmitted!: () => void;
    const legacyInserted = new Promise<void>((resolve) => {
      legacyAdmitted = resolve;
    });
    const legacyTransaction = env.db.transaction(async (tx) => {
      await tx.insert(deployments).values({
        admission_protocol: 0,
        id: 'dpl_legacy_before_checkpoint',
        project_id: project.id,
      });
      legacyAdmitted();
      await legacyMayCommit;
    });
    await legacyInserted;

    let inventoryRead = false;
    const armBarrier = env.db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE deployments IN SHARE MODE`);
      await tx.insert(sandboxDrainCheckpoints).values({
        admission_protocol: 2,
        singleton: true,
        generation: 'admission-v2-after-lock',
        state: 'draining',
        phase: 'deployments',
        cursor: { pass: '1' },
      });
      const [inventory] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.id, 'dpl_legacy_before_checkpoint'));
      inventoryRead = true;
      return inventory;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inventoryRead).toBe(false);

    releaseLegacy();
    await legacyTransaction;
    await expect(armBarrier).resolves.toEqual({ id: 'dpl_legacy_before_checkpoint' });
    expect(inventoryRead).toBe(true);
  },
);
function cloudflareWorkerStub(failScript?: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const script = /\/scripts\/([^/]+)/.exec(url)?.[1];
    if (init?.method === 'POST') {
      if (script === failScript) {
        return Response.json(
          { success: false, errors: [{ message: 'Permission denied' }] },
          { status: 403 },
        );
      }
      return Response.json({
        success: true,
        result: { id: 'new-deployment', versions: JSON.parse(String(init.body)).versions },
      });
    }
    if (url.endsWith('/versions')) {
      return Response.json({
        success: true,
        result: { items: [{ id: 'previous' }, { id: 'current' }] },
      });
    }
    if (url.endsWith('/deployments')) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            { id: 'current-deploy', versions: [{ version_id: 'current', percentage: 100 }] },
            { id: 'previous-deploy', versions: [{ version_id: 'previous', percentage: 100 }] },
          ],
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
}

describe('operator deployment operations', () => {
  test('parses PostgreSQL timestamps with a short UTC offset', () => {
    expect(databaseTimestampMs('2026-09-16 10:00:00+00')).toBe(
      Date.parse('2026-09-16T10:00:00+00:00'),
    );
  });
  test('filters and paginates deployment rows with matching totals', async () => {
    const project = await createTestProject(env.db, ownerId, 'alpha');
    await createTestDeployment(env.db, project.id, 'pending');
    await createTestDeployment(env.db, project.id, 'live');
    const response = await req('/deployments?project=alpha&status=pending&limit=1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deployments: Array<{ project_id: string; status: string }>;
    };
    expect(body).toMatchObject({ page: 1, limit: 1, total: 1 });
    expect(body.deployments[0]).toMatchObject({ project_id: project.id, status: 'pending' });
    expect((await req('/deployments?status=unknown')).status).toBe(400);
    expect((await req('/deployments?limit=-1')).status).toBe(400);
  });
  test('previews cancellation without writes then requests two-phase cancellation', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    const preview = await req(`/deployments/${deployment.id}/cancel`, { dryRun: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ dryRun: true, target: deployment.id });
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('pending');
    expect((await req(`/deployments/${deployment.id}/cancel`, {})).status).toBe(200);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('canceling');
  });
  test.each(['live', 'cutover', 'compensating'] as const)(
    'rejects preview and cancellation of %s deployment',
    async (status) => {
      const project = await createTestProject(env.db, ownerId);
      const deployment = await createTestDeployment(env.db, project.id, 'pending');
      await env.db.update(deployments).set({ status }).where(eq(deployments.id, deployment.id));
      expect((await req(`/deployments/${deployment.id}/cancel`, { dryRun: true })).status).toBe(
        409,
      );
      expect((await req(`/deployments/${deployment.id}/cancel`, {})).status).toBe(409);
      expect((await getDeployment(env.db, deployment.id))?.status).toBe(status);
    },
  );
  test('log pages keep equal-timestamp rows and continue the same fixed window', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const row = {
      ts: Date.now() - 1000,
      ingestedAt: new Date(Date.now() - 500).toISOString(),
      outcome: 'ok',
      logData: '[]',
      exceptionData: '[]',
      url: '/a',
      method: 'GET',
      statusCode: '200',
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ data: [row, { ...row, url: '/b' }, { ...row, url: '/c' }] }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ ...row, url: '/c' }] }));
    const first = await req(`/deployments/${deployment.id}/logs?limit=2`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: Array<unknown>;
      nextCursor: string;
      watermark: string;
    };
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await req(
      `/deployments/${deployment.id}/logs?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    );
    const last = (await second.json()) as { data: Array<unknown> };
    expect(last).toMatchObject({ nextCursor: null, watermark: page.watermark });
    expect(last.data).toHaveLength(1);
    expect(fetch.mock.calls[0][1]?.body).toContain(
      'GROUP BY blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, double1',
    );
    expect(fetch.mock.calls[0][1]?.body).toContain('ORDER BY ts ASC, ingestedAt ASC');
    expect(fetch.mock.calls[0][1]?.body).toMatch(/double1 >= \d+ AND double1 < \d+/);
    expect(fetch.mock.calls[1][1]?.body).toContain('OFFSET 2');
    expect((await req(`/deployments/${deployment.id}/logs?cursor=garbage`)).status).toBe(400);
    expect((await req(`/deployments/${deployment.id}/logs?limit=-1`)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('log pages carry runtimeLogs only when runtime logs are minimal', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const row = {
      ts: Date.now() - 1000,
      ingestedAt: new Date(Date.now() - 500).toISOString(),
      outcome: 'ok',
      logData: '[{"level":"log","timestamp":1,"message":[]}]',
      exceptionData: '[]',
      url: '',
      method: 'GET',
      statusCode: '200',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [row] }));
    const full = (await (await req(`/deployments/${deployment.id}/logs`)).json()) as Record<
      string,
      unknown
    >;
    expect(full).not.toHaveProperty('runtimeLogs');
    const minimal = await req(`/deployments/${deployment.id}/logs`, undefined, {
      PLATFORM_RUNTIME_LOGS: 'minimal',
    });
    expect(minimal.status).toBe(200);
    expect(await minimal.json()).toMatchObject({
      runtimeLogs: 'minimal',
      data: [{ url: '', logs: [{ level: 'log', timestamp: 1, message: [] }] }],
    });
  });
  test('follow windows use ingestion time with bounded overlap after the initial history', async () => {
    const project = await createTestProject(env.db, ownerId);
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    vi.spyOn(Date, 'now').mockReturnValue(600_000);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        data: [
          {
            ts: 120_000,
            ingestedAt: '1970-01-01 00:09:00',
            outcome: 'ok',
            logData: '[]',
            exceptionData: '[]',
            url: '/completed-late',
            method: 'GET',
            statusCode: '200',
          },
        ],
      }),
    );

    const response = await req(`/deployments/${deployment.id}/logs?after=480000`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [
        {
          timestamp: 120_000,
          ingestedAt: 540_000,
          url: '/completed-late',
        },
      ],
      watermark: '600000',
    });
    const query = String(fetch.mock.calls[0][1]?.body);
    expect(query).toContain(
      "timestamp >= toDateTime('1970-01-01 00:03:00') AND timestamp < toDateTime('1970-01-01 00:10:00')",
    );
    expect(query).toContain(
      'GROUP BY blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, double1',
    );
    expect(query).toContain('ORDER BY ingestedAt ASC, ts ASC');
    expect(query).not.toContain('double1 >= 480000');
    expect((await req(`/deployments/${deployment.id}/logs?after=garbage`)).status).toBe(400);
    expect((await req(`/deployments/${deployment.id}/logs?after=600001`)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('operator build operations', () => {
  test('preserves log cursor, DO terminal status, and the recorded build size', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
      instanceType: BUILD_INSTANCE_LARGE,
    });
    const base = namespace({ lines: [], lastSeq: 0 });
    const large = namespace({
      lines: [{ seq: 11, line: 'finished' }],
      lastSeq: 11,
      terminal: true,
      status: 'failed',
      logsComplete: true,
    });
    const response = await req(`/builds/${build.id}/logs?since=10`, undefined, {
      BUILD_MANAGER: base.ns,
      BUILD_MANAGER_LARGE: large.ns,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lastSeq: 11,
      terminal: true,
      status: 'failed',
      logsComplete: true,
    });
    expect(large.fetch).toHaveBeenCalledWith('http://manager/logs?since=10');
    expect(base.fetch).not.toHaveBeenCalled();
    expect((await req(`/builds/${build.id}/logs?since=-1`)).status).toBe(400);
  });
  test('bounded build pages advance only past returned lines and retain buffered terminal logs', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
    });
    const logs = namespace({
      lines: [
        { seq: 4, line: 'a' },
        { seq: 5, line: 'b' },
        { seq: 6, line: 'c' },
      ],
      lastSeq: 6,
      terminal: true,
      status: 'complete',
      logsComplete: false,
    });
    const response = await req(`/builds/${build.id}/logs?since=3&limit=2`, undefined, {
      BUILD_MANAGER: logs.ns,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lines: [{ seq: 4 }, { seq: 5 }],
      lastSeq: 5,
      hasMore: true,
      terminal: true,
      logsComplete: false,
    });
    expect((await req(`/builds/${build.id}/logs?limit=501`)).status).toBe(400);
    expect(logs.fetch).toHaveBeenCalledTimes(1);
  });
  test('disabled managed builds fail before resolving or calling a DO', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
    });
    const logs = namespace({});
    const capabilities = Object.fromEntries(
      [
        'ai',
        'customDomains',
        'email',
        'githubActions',
        'githubOAuth',
        'googleOAuth',
        'managedBuilds',
        'sandbox',
      ].map((name) => [name, false]),
    );
    const response = await req(`/builds/${build.id}/logs`, undefined, {
      PLATFORM_CAPABILITIES: JSON.stringify(capabilities),
      BUILD_MANAGER: logs.ns,
    });
    expect(response.status).toBe(501);
    expect(logs.fetch).not.toHaveBeenCalled();
  });
  test('returns external build URLs without accessing container services', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'github_actions',
      logsUrl: 'https://github.com/example/actions/runs/1',
    });
    const ns = namespace({});
    const response = await req(`/builds/${build.id}/logs?since=7`, undefined, {
      BUILD_MANAGER: ns.ns,
      BUILD_MANAGER_LARGE: ns.ns,
    });
    expect(await response.json()).toMatchObject({
      lastSeq: 7,
      lines: [],
      external: 'https://github.com/example/actions/runs/1',
    });
    expect(ns.fetch).not.toHaveBeenCalled();
  });
  test('does not mask a failed log service as success', async () => {
    const project = await createTestProject(env.db, ownerId);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: ownerId,
      executor: 'container',
    });
    const ns = namespace({ error: 'Unavailable' }, 503);
    expect(
      (await req(`/builds/${build.id}/logs`, undefined, { BUILD_MANAGER: ns.ns })).status,
    ).toBe(502);
  });
});

describe('operator installation-aware system and worker operations', () => {
  test('probes the installed proxy privately when Access redirects its public URL', async () => {
    const publicFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        String(input).startsWith('https://my-proxy.example')
          ? Response.redirect('https://company.cloudflareaccess.com/login', 302)
          : Response.json({ ok: true }),
      );
    const privateFetch = vi.fn(async () => Response.json({ ok: true }));
    const response = await req('/system/health', undefined, {
      PLATFORM_INSTALLATION_ID: 'installation',
      PROXY_URL: 'https://my-proxy.example',
      SITE_DOMAIN: 'apps.example',
      PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
      PLATFORM_PROXY: { fetch: privateFetch },
    });
    expect(await response.json()).toMatchObject({ allOk: true });
    expect(privateFetch).toHaveBeenCalledExactlyOnceWith(
      'https://my-proxy.example/health',
      expect.objectContaining({
        headers: { 'X-Void-Platform-Probe': 'probe' },
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(publicFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://void-platform-health.apps.example/health',
    ]);
  });

  test.each([302, 503])(
    'reports a private proxy HTTP %s without falling back to the public URL',
    async (status) => {
      const publicFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ ok: true }));
      const response = await req('/system/health', undefined, {
        PLATFORM_INSTALLATION_ID: 'installation',
        PROXY_URL: 'https://my-proxy.example',
        SITE_DOMAIN: 'apps.example',
        PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
        PLATFORM_PROXY: { fetch: vi.fn(async () => new Response(null, { status })) },
      });
      expect(await response.json()).toMatchObject({
        allOk: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'proxy',
            ok: false,
            error: `HTTP ${status}${status === 302 ? ' (redirect)' : ''}`,
          }),
        ]),
      });
      expect(publicFetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://void-platform-health.apps.example/health',
      ]);
    },
  );

  test('does not expose private proxy errors or fall back to an unauthenticated request', async () => {
    const publicFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ ok: true }));
    const response = await req('/system/health', undefined, {
      PLATFORM_INSTALLATION_ID: 'installation',
      PROXY_URL: 'https://my-proxy.example',
      SITE_DOMAIN: 'apps.example',
      PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
      PLATFORM_PROXY: {
        fetch: vi.fn(async () => {
          throw new Error('private-binding-secret');
        }),
      },
    });
    const body = await response.json();
    expect(body).toMatchObject({
      allOk: false,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'proxy',
          ok: false,
          error: 'Could not reach the service.',
        }),
      ]),
    });
    expect(JSON.stringify(body)).not.toContain('private-binding-secret');
    expect(publicFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://void-platform-health.apps.example/health',
    ]);
  });

  test('health uses configured installed proxy and authenticated dispatch probe, without a dashboard', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    const response = await req('/system/health', undefined, {
      PLATFORM_INSTALLATION_ID: 'installation',
      PROXY_URL: 'https://my-proxy.example',
      SITE_DOMAIN: 'apps.example',
      PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allOk: true });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      'https://my-proxy.example/health',
      'https://void-platform-health.apps.example/health',
    ]);
    expect(fetch.mock.calls[1][1]?.headers).toEqual({ 'X-Void-Platform-Probe': 'probe' });
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ 'X-Void-Platform-Probe': 'probe' });
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  const workersDevApplication = {
    baseDomain: 'test-account.workers.dev',
    zoneName: '',
    dedicatedZone: false,
    workersDev: { subdomain: 'test-account', installationId: 'example-123456abcdef' },
  };
  const workersDevEnv = {
    PLATFORM_INSTALLATION_ID: 'example-123456abcdef',
    PLATFORM_APPLICATION: JSON.stringify(workersDevApplication),
    PROXY_URL: 'https://custom-proxy.example',
    DISPATCH_WORKER_NAME: 'recorded-dispatch-worker',
    PLATFORM_HEALTH_PROBE_TOKEN: 'probe',
  };

  test('workers.dev health probes the recorded dispatch Worker independently of the API hostname', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ ok: true }));
    const response = await req('/system/health', undefined, workersDevEnv);
    expect(await response.json()).toMatchObject({ allOk: true });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      'https://custom-proxy.example/health',
      'https://recorded-dispatch-worker.test-account.workers.dev/health',
    ]);
  });

  test('health switches to the active application domain after adding one to workers.dev', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ ok: true }));
    await env.ROUTING.put(
      PLATFORM_APPLICATION_KEY,
      JSON.stringify({
        ...workersDevApplication,
        baseDomain: 'apps.example.com',
        zoneName: 'example.com',
        zoneId: 'zone',
      }),
    );
    try {
      expect(await (await req('/system/health', undefined, workersDevEnv)).json()).toMatchObject({
        allOk: true,
      });
      expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
        'https://custom-proxy.example/health',
        'https://void-platform-health.apps.example.com/health',
      ]);
    } finally {
      await env.ROUTING.delete(PLATFORM_APPLICATION_KEY);
    }
  });

  test.each([undefined, 'untrusted.example/path'])(
    'does not guess a workers.dev endpoint without a valid Worker name (%s)',
    async (name) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ ok: true }));
      const result = await (
        await req('/system/health', undefined, { ...workersDevEnv, DISPATCH_WORKER_NAME: name })
      ).json();
      expect(result).toMatchObject({
        allOk: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'dispatch',
            ok: false,
            error: 'Dispatch health endpoint is not configured for this installation.',
          }),
        ]),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  test('preserves legacy platform health endpoints and headers', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ ok: true }));
    const result = await (
      await req('/system/health', undefined, {
        SITE_DOMAIN: 'staging.void.app',
        PROXY_URL: 'https://proxy.staging.void.cloud',
        DASHBOARD_URL: 'https://dash.staging.void.cloud',
        PLATFORM_HEALTH_PROBE_TOKEN: 'must-not-send',
        PLATFORM_PROXY: {
          fetch: vi.fn(async () => {
            throw new Error('legacy should use public health');
          }),
        },
      })
    ).json();
    expect(result).toMatchObject({ allOk: true });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      'https://proxy.staging.void.cloud/health',
      'https://dash.staging.void.cloud/login',
      'https://test.staging.void.app/health',
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.headers)).toEqual([
      undefined,
      undefined,
      { 'X-Health-Check': 'void-admin' },
    ]);
  });

  test('does not send the dispatch probe to another installation identity', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ ok: true }));
    const result = await (
      await req('/system/health', undefined, {
        ...workersDevEnv,
        PLATFORM_INSTALLATION_ID: 'other-123456abcdef',
      })
    ).json();
    expect(result).toMatchObject({
      allOk: false,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'dispatch',
          ok: false,
          error: 'Dispatch health endpoint is not configured for this installation.',
        }),
      ]),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('does not expose database credentials in health failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true }));
    vi.spyOn(env.db, 'execute').mockRejectedValueOnce(
      new Error('Connection failed: postgresql://user:private-password@example.com/db'),
    );
    const result = await (await req('/system/health', undefined, workersDevEnv)).json();
    expect(result).toMatchObject({
      allOk: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'db', ok: false, error: 'Database query failed.' }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('private-password');
  });

  test.each([403, 503, 302])(
    'reports HTTP %s without exposing the upstream response body',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response('sensitive upstream response', { status }),
      );
      const result = await (await req('/system/health', undefined, workersDevEnv)).json();
      expect(result).toMatchObject({
        allOk: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'proxy',
            ok: false,
            error: status === 302 ? 'HTTP 302 (redirect)' : `HTTP ${status}`,
          }),
          expect.objectContaining({
            name: 'dispatch',
            ok: false,
            error: status === 302 ? 'HTTP 302 (redirect)' : `HTTP ${status}`,
          }),
        ]),
      });
      expect(JSON.stringify(result)).not.toContain('sensitive upstream response');
    },
  );

  test.each(['TimeoutError', 'TypeError'])('reports a safe diagnostic for %s', async (name) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('private-credential'), { name }),
    );
    const result = await (await req('/system/health', undefined, workersDevEnv)).json();
    expect(result).toMatchObject({
      allOk: false,
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'proxy',
          error:
            name === 'TimeoutError'
              ? 'Health check timed out after 5 seconds.'
              : 'Could not reach the service.',
        }),
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });
  test('every worker route rejects installed platforms before external calls', async () => {
    const fetch = cloudflareWorkerStub();
    const installation = { PLATFORM_INSTALLATION_ID: 'installation' };
    for (const path of ['/workers', '/workers/api', '/workers/events', '/workers/events/batch']) {
      expect((await req(path, undefined, installation)).status).toBe(501);
    }
    expect(
      (await req('/workers/api/rollback', { versionId: 'previous', dryRun: true }, installation))
        .status,
    ).toBe(501);
    expect((await req('/workers/rollback-all', { dryRun: true }, installation)).status).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('worker reads preserve available data and report Cloudflare failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/scripts/void-api/deployments')) {
        return Response.json(
          { success: false, errors: [{ message: 'Permission denied' }] },
          { status: 403 },
        );
      }
      if (url.endsWith('/versions')) {
        return Response.json({ success: true, result: { items: [{ id: 'current' }] } });
      }
      if (url.endsWith('/deployments')) {
        return Response.json({
          success: true,
          result: {
            deployments: [
              { id: 'current-deploy', versions: [{ version_id: 'current', percentage: 100 }] },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const detail = await req('/workers/api');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      ok: false,
      partial: true,
      versions: [{ id: 'current' }],
      error: 'Cloudflare API error: Permission denied',
    });

    const list = await req('/workers');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      ok: false,
      partial: true,
      workers: expect.arrayContaining([
        expect.objectContaining({
          worker: expect.objectContaining({ name: 'api' }),
          error: 'Cloudflare API error: Permission denied',
        }),
        expect.objectContaining({
          worker: expect.objectContaining({ name: 'dashboard' }),
          deployment: expect.objectContaining({ id: 'current-deploy' }),
        }),
      ]),
    });

    const preview = await req('/workers/rollback-all', { dryRun: true });
    expect(preview.status).toBe(502);
    expect(await preview.json()).toMatchObject({ error: 'worker_read_failed' });
  });
  test('worker previews validate versions without POST calls or audit-event mutations', async () => {
    const fetch = cloudflareWorkerStub();
    expect(
      (await req('/workers/api/rollback', { versionId: 'unknown', dryRun: true })).status,
    ).toBe(404);
    const response = await req('/workers/rollback-all', { dryRun: true, environment: 'staging' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      versions: {
        proxy: 'previous',
        tail: 'previous',
        api: 'previous',
        dashboard: 'previous',
        dispatch: 'previous',
        'email-gateway': 'previous',
      },
    });
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    expect(await env.db.select().from(platformEvents)).toEqual([]);
    expect((await req('/workers/rollback-all', {})).status).toBe(400);
  });
  test('bulk rollback pins reviewed targets, stops after failure, and persists partial outcomes', async () => {
    const fetch = cloudflareWorkerStub('void-api-staging');
    const versions = {
      dispatch: 'previous',
      'email-gateway': 'previous',
      dashboard: 'previous',
      api: 'previous',
      tail: 'previous',
      proxy: 'previous',
    };
    const response = await req('/workers/rollback-all', { environment: 'staging', versions });
    expect(response.status).toBe(207);
    const result = (await response.json()) as {
      events: Array<{ worker_name: string; status: string }>;
    };
    expect(result).toMatchObject({ ok: false, partial: true, environment: 'staging' });
    // Rollback runs in reverse deploy order, so the email gateway, which the
    // API's confirmation page posts back through, rolls back after the API.
    // Its dispatch service entrypoint also stays intact if API rollback fails.
    expect(result.events.map((event) => [event.worker_name, event.status])).toEqual([
      ['dashboard', 'success'],
      ['api', 'failed'],
      ['dispatch', 'skipped'],
      ['tail', 'skipped'],
      ['email-gateway', 'skipped'],
      ['proxy', 'skipped'],
    ]);
    const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toContain('void-dashboard-staging');
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({
      versions: [{ version_id: 'previous', percentage: 100 }],
    });
    const persisted = await env.db.select().from(platformEvents);
    expect(persisted.filter((event) => event.status === 'skipped')).toHaveLength(4);
  });
  test('queue backfill preview reads all targets without writing or returning tokens', async () => {
    await env.ROUTING.put(
      'queue:operator-test',
      JSON.stringify({ workerName: 'user-test', projectId: 'test' }),
    );
    const put = vi.spyOn(env.ROUTING, 'put');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        success: true,
        result: [{ name: '__VOID_PROXY_TOKEN', type: 'plain_text', text: 'private-token' }],
      }),
    );
    const response = await req('/system/backfill-queue-tokens', { dryRun: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ dryRun: true, wouldUpdate: 1, updated: 0 });
    expect(JSON.stringify(body)).not.toContain('private-token');
    expect(put).not.toHaveBeenCalled();
    await env.ROUTING.delete('queue:operator-test');
  });
  test('previews, cancels, resumes, and audits an orphan Sandbox application drain', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-drain');
    const deployment = await createLegacySandboxDeployment(project.id, 'pending');
    const applicationName = `${project.id}-${deployment.id}-void-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');
    const namespaceId = 'ns-sandbox-drain';
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 3,
          bindings: {},
          sandbox: {
            bindingName: 'SANDBOX',
            className: 'Sandbox',
            containerName: 'void-sandbox',
            image: 'registry.cloudflare.com/sandbox:1.0.0',
          },
        }),
      })
      .where(eq(deployments.id, deployment.id));
    const cf = mockCfApi();
    cf.seedHostScript({
      scriptName: `user-${project.slug}-${deployment.id}`,
      classes: { Sandbox: namespaceId },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          namespace_id: namespaceId,
        },
      ],
    });
    const application = cf.seedContainerApp({ name: applicationName, namespaceId });

    const plan = await req(
      '/system/sandbox-drain',
      { dryRun: true },
      { PLATFORM_TRAFFIC_STATE: 'sandbox-drain' },
    );
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({
      dryRun: true,
      applications: [],
      blockers: [expect.objectContaining({ kind: 'active_deployment' })],
    });
    expect(await env.ROUTING.get(PLATFORM_SANDBOX_DRAIN_KEY)).toBeNull();
    expect(cf.state.containerApps.has(application.id)).toBe(true);

    const firstApply = await req(
      '/system/sandbox-drain',
      {},
      { PLATFORM_TRAFFIC_STATE: 'sandbox-drain' },
    );
    expect(firstApply.status).toBe(207);
    expect(await firstApply.json()).toMatchObject({
      ok: false,
      partial: true,
      complete: false,
      cancelRequested: [deployment.id],
      deletedApplications: [],
    });
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('canceling');
    expect(cf.state.containerApps.has(application.id)).toBe(true);

    // Simulate an abandoned request after the operator requested cancellation.
    // The operator flow itself must own the terminal transition; the test does
    // not update the deployment to `canceled` directly.
    await env.db
      .update(deployments)
      .set({ updated_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(deployments.id, deployment.id));
    const resumedPages = await applyDrainUntilComplete({
      PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
    });
    const resumed = resumedPages.at(-1)!;
    const resumedPageBodies = await Promise.all(
      resumedPages.map(
        async (response) =>
          (await response.clone().json()) as { deletedApplications?: Array<string> },
      ),
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      ok: true,
      complete: true,
      applications: [],
      blockers: [],
    });
    expect(resumedPageBodies.flatMap((body) => body.deletedApplications ?? [])).toContain(
      application.id,
    );
    expect(cf.state.containerApps.has(application.id)).toBe(false);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('canceled');
    expect(await readSandboxDrainCheckpoint(env.db)).toMatchObject({
      state: 'complete',
    });
    expect(await env.ROUTING.get(PLATFORM_SANDBOX_DRAIN_KEY)).toBeNull();
    // Each audit row is inserted, then updated with its outcome, so its physical
    // position does not follow request order.
    const events = await env.db
      .select()
      .from(operatorEvents)
      .orderBy(asc(operatorEvents.created_at), asc(operatorEvents.id));
    expect(events).toHaveLength(1 + resumedPages.length);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        action: 'system/sandbox-drain',
        target: JSON.stringify({ applications: 'managed-sandbox-containers' }),
        status: 'success',
        http_status: 200,
      }),
    );
    expect(events.slice(0, -1).every((event) => event.status === 'failed')).toBe(true);
  });
  test('settles an abandoned manifest-less deployment through the operator drain', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-manifestless');
    const deployment = await createLegacySandboxDeployment(project.id, 'pending');
    await env.db
      .update(deployments)
      .set({ manifest: null })
      .where(eq(deployments.id, deployment.id));
    const cf = mockCfApi();

    const firstApply = await req(
      '/system/sandbox-drain',
      {},
      { PLATFORM_TRAFFIC_STATE: 'sandbox-drain' },
    );
    expect(firstApply.status).toBe(207);
    expect(await firstApply.json()).toMatchObject({
      cancelRequested: [deployment.id],
      blockers: [expect.objectContaining({ kind: 'active_deployment' })],
    });
    await env.db
      .update(deployments)
      .set({ updated_at: '2020-01-01T00:00:00.000+00:00' })
      .where(eq(deployments.id, deployment.id));

    const responses = await applyDrainUntilComplete({
      PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
    });
    expect(responses.at(-1)?.status).toBe(200);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('canceled');
    expect(cf).not.toHaveBeenCalled();
  });
  test('adopts and compensates an abandoned rollback lease through the operator drain', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-rollback-lease');
    const current = await createLegacySandboxDeployment(project.id, 'live');
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ version: 4, type: 'static' }) })
      .where(eq(deployments.id, current.id));
    const lease = await createLegacySandboxDeployment(project.id, 'pending', 'rollback-lease');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 1,
          targetDeploymentId: current.id,
          state: 'retryable',
          ownerId: 'abandoned-rollback-owner',
        }),
      })
      .where(eq(deployments.id, lease.id));
    await env.ROUTING.put(project.slug, JSON.stringify({ version: 'possibly-divergent' }));

    const responses = await applyDrainUntilComplete({
      PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
    });
    expect(responses.at(-1)?.status).toBe(200);
    expect(await getDeployment(env.db, lease.id)).toBeNull();
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      staticDeploymentId: current.id,
    });
  });
  test('waits for a fresh cutover, then fences and compensates it before deletion', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-cutover-recovery');
    const current = await createLegacySandboxDeployment(project.id, 'live');
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ version: 4, type: 'static' }) })
      .where(eq(deployments.id, current.id));
    const deployment = await createLegacySandboxDeployment(project.id, 'pending');
    const applicationName = `${project.id}-${deployment.id}-void-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');
    const namespaceId = 'ns-sandbox-cutover';
    await env.db
      .update(deployments)
      .set({
        status: 'cutover',
        manifest: JSON.stringify({
          version: 4,
          type: 'void',
          bindings: {},
          sandbox: {
            bindingName: 'SANDBOX',
            className: 'Sandbox',
            containerName: 'void-sandbox',
            image: 'registry.cloudflare.com/sandbox:1.0.0',
          },
        }),
      })
      .where(eq(deployments.id, deployment.id));
    const oldIntent = JSON.stringify({
      projectId: project.id,
      ownerId: 'still-running-owner',
      buildId: null,
    });
    await env.ROUTING.put(`cutover-intent:${deployment.id}`, oldIntent);
    await env.ROUTING.put(project.slug, JSON.stringify({ version: deployment.id }));
    const cf = mockCfApi();
    cf.seedHostScript({
      scriptName: `user-${project.slug}-${deployment.id}`,
      classes: { Sandbox: namespaceId },
      bindings: [
        {
          type: 'durable_object_namespace',
          name: 'SANDBOX',
          class_name: 'Sandbox',
          namespace_id: namespaceId,
        },
      ],
    });
    const application = cf.seedContainerApp({ name: applicationName, namespaceId });

    const fresh = await req(
      '/system/sandbox-drain',
      {},
      { PLATFORM_TRAFFIC_STATE: 'sandbox-drain' },
    );
    expect(fresh.status).toBe(207);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('cutover');
    expect(await env.ROUTING.get(`cutover-intent:${deployment.id}`)).toBe(oldIntent);
    expect(cf.state.containerApps.has(application.id)).toBe(true);

    await env.db
      .update(deployments)
      .set({ updated_at: '2020-01-01 00:00:00+00' })
      .where(eq(deployments.id, deployment.id));
    const responses = await applyDrainUntilComplete({
      PLATFORM_TRAFFIC_STATE: 'sandbox-drain',
    });
    expect(responses.at(-1)?.status).toBe(200);
    expect((await getDeployment(env.db, deployment.id))?.status).toBe('failed');
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      staticDeploymentId: current.id,
    });
    expect(cf.state.containerApps.has(application.id)).toBe(false);
  });
  test('completes an empty drain without probing the Container API', async () => {
    const cf = mockCfApi();
    const responses = await applyDrainUntilComplete();
    const response = responses.at(-1)!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: true,
      applications: [],
      blockers: [],
    });
    expect(cf).not.toHaveBeenCalled();
  });
  test('projects a bounded Sandbox identity from a large deployment manifest', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-large-manifest');
    const deployment = await createLegacySandboxDeployment(project.id, 'live');
    const unrelatedPayload = `manifest-payload-${'x'.repeat(4 * 1024 * 1024)}`;
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 3,
          bindings: {},
          vars: { LARGE_UNUSED_VALUE: unrelatedPayload },
          sandbox: {
            bindingName: 'SANDBOX',
            className: 'Sandbox',
            containerName: 'void-sandbox',
            image: 'registry.cloudflare.com/sandbox:1.0.0',
          },
        }),
      })
      .where(eq(deployments.id, deployment.id));

    const rows = await loadSandboxDeploymentPageProjection(env.db, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deploymentId: deployment.id,
      bindingName: 'SANDBOX',
      className: 'Sandbox',
      containerName: 'void-sandbox',
      identityOversized: false,
    });
    expect(Object.keys(rows[0]!)).toEqual([
      'deploymentId',
      'projectId',
      'projectSlug',
      'active',
      'rollbackLease',
      'manifestPresent',
      'sandboxType',
      'bindingNameType',
      'bindingName',
      'classNameType',
      'className',
      'containerNameType',
      'containerName',
      'identityOversized',
      'createdAt',
    ]);
    const returnedProjection = JSON.stringify(rows);
    expect(returnedProjection.length).toBeLessThan(2_000);
    expect(returnedProjection).not.toContain('manifest-payload-');
  });
  test('blocks oversized Sandbox identity metadata before any Container API call', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-oversized-identity');
    const deployment = await createLegacySandboxDeployment(project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 3,
          bindings: {},
          sandbox: {
            bindingName: 'S'.repeat(513),
            className: 'Sandbox',
            containerName: 'void-sandbox',
            image: 'registry.cloudflare.com/sandbox:1.0.0',
          },
        }),
      })
      .where(eq(deployments.id, deployment.id));
    const cf = mockCfApi();

    const response = await req('/system/sandbox-drain', {});
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      complete: false,
      blockers: [
        expect.objectContaining({
          kind: 'invalid_manifest',
          deploymentId: deployment.id,
          message: expect.stringContaining('exceeds 512 characters'),
        }),
      ],
    });
    expect(cf).not.toHaveBeenCalled();
  });
  test('refuses to delete an uncorroborated container resource', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-unverified');
    const cf = mockCfApi();
    const application = cf.seedContainerApp({
      name: 'unrelated-account-application',
      namespaceId: 'ns-unrelated',
    });
    await env.db.insert(resources).values({
      id: 'res_unverified_sandbox',
      project_id: project.id,
      type: 'container',
      cf_id: application.id,
      binding_name: 'SANDBOX',
    });

    await req('/system/sandbox-drain', {});
    const response = await req('/system/sandbox-drain', {});
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      complete: false,
      deletedApplications: [],
      blockers: [
        expect.objectContaining({
          kind: 'unverified_container',
          resourceId: 'res_unverified_sandbox',
          projectId: project.id,
          bindingName: 'SANDBOX',
          applicationId: application.id,
          applicationName: application.name,
          resolution: expect.stringContaining('only after proving ownership'),
        }),
      ],
    });
    expect(cf.state.containerApps.has(application.id)).toBe(true);
    expect(await env.db.select().from(resources)).toHaveLength(1);
  });
  test('does not delete a same-name application after its managed script is missing', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-missing-script');
    const deployment = await createLegacySandboxDeployment(project.id, 'live');
    await env.db
      .update(deployments)
      .set({
        manifest: JSON.stringify({
          version: 3,
          bindings: {},
          sandbox: {
            bindingName: 'SANDBOX',
            className: 'Sandbox',
            containerName: 'void-sandbox',
            image: 'registry.cloudflare.com/sandbox:1.0.0',
          },
        }),
      })
      .where(eq(deployments.id, deployment.id));
    const applicationName = `${project.id}-${deployment.id}-void-sandbox`
      .toLowerCase()
      .replaceAll('_', '-');
    const cf = mockCfApi({
      listWorkerBindings: () =>
        Response.json(
          { success: false, errors: [{ message: 'script not found' }] },
          { status: 404 },
        ),
    });
    const replacement = cf.seedContainerApp({
      name: applicationName,
      namespaceId: 'native-or-replacement-namespace',
    });

    const response = await req('/system/sandbox-drain', {});
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      complete: false,
      blockers: [
        expect.objectContaining({
          kind: 'unverified_container',
          applicationId: replacement.id,
          deploymentId: deployment.id,
        }),
      ],
    });
    expect(cf.state.containerApps.has(replacement.id)).toBe(true);
  });
  test('advances a durable cursor through more than one deployment page', async () => {
    const project = await createTestProject(env.db, ownerId, 'sandbox-many-deployments');
    for (let index = 0; index < 17; index++) {
      await createLegacySandboxDeployment(project.id, 'live');
    }
    const cf = mockCfApi();

    const plan = await req('/system/sandbox-drain', { dryRun: true });
    const planBody = (await plan.json()) as { nextCursor: string; processed: number };
    expect(planBody.processed).toBe(16);
    expect(typeof planBody.nextCursor).toBe('string');
    const nextPlan = await req('/system/sandbox-drain', {
      dryRun: true,
      cursor: planBody.nextCursor,
    });
    expect(await nextPlan.json()).toMatchObject({ processed: 1, phase: 'deployments' });
    expect(await env.db.select().from(sandboxDrainCheckpoints)).toEqual([]);

    const first = await req('/system/sandbox-drain', {});
    expect(first.status).toBe(207);
    const firstBody = (await first.json()) as {
      truncated: boolean;
      processed: number;
      checkpoint: { cursor: { id: string } };
    };
    expect(firstBody).toMatchObject({ truncated: true, processed: 16, complete: false });

    const second = await req('/system/sandbox-drain', {});
    expect(second.status).toBe(207);
    const secondBody = (await second.json()) as {
      processed: number;
      checkpoint: { cursor: { id?: string }; phase: string };
    };
    expect(secondBody).toMatchObject({ processed: 1, complete: false });
    expect(secondBody.checkpoint.phase).toBe('resources');
    expect(secondBody.checkpoint.cursor.id).toBeUndefined();
    expect(cf).not.toHaveBeenCalled();
  });
});

describe('proxy token rotation', () => {
  const rotationTarget = (projectId: string) => `proxy-token-rotation:${projectId}`;
  const tok = (projectId: string, gen: number) => deriveProxyToken(JWT_SECRET, projectId, gen);

  /** Cloudflare mock whose script bindings come from seeded scripts; a missing script is a 404. */
  function cloudflare() {
    const cf: MockCfApiHandle = mockCfApi({
      listWorkerBindings: (url) => {
        const name = decodeURIComponent(/\/scripts\/([^/?#]+)/.exec(url)?.[1] ?? '');
        const script = cf.state.hostScripts.get(name);
        return script
          ? cfSuccess(script.bindings)
          : cfError('workers.api.error.script_not_found', 404, 10007);
      },
    });
    return cf;
  }
  const patchCount = (cf: MockCfApiHandle) =>
    cf.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
      .length;

  /** A project, optionally with an active Worker (plus a retained one) holding tok(gen). */
  async function rotationProject(
    cf: MockCfApiHandle,
    slug: string,
    options: Readonly<{ gen?: number; workers?: boolean }> = {},
  ) {
    const project = await createTestProject(env.db, ownerId, slug);
    const gen = options.gen ?? 0;
    await env.db.update(projects).set({ proxy_token_gen: gen }).where(eq(projects.id, project.id));
    const workers: Array<string> = [];
    if (options.workers) {
      const retained = await createTestDeployment(env.db, project.id, 'live');
      const active = await createTestDeployment(env.db, project.id, 'live');
      await env.db
        .update(deployments)
        .set({ retained: true })
        .where(eq(deployments.id, retained.id));
      for (const id of [retained.id, active.id]) {
        const scriptName = getProjectDeploymentWorkerName(slug, id);
        cf.seedHostScript({
          scriptName,
          bindings: [
            { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: await tok(project.id, gen) },
            { type: 'secret_text', name: 'API_KEY' },
          ],
        });
        workers.push(scriptName);
      }
    }
    return { ...project, workers };
  }

  async function rotationJob(projectId: string) {
    const [row] = await env.db
      .select()
      .from(projectCleanupJobs)
      .where(eq(projectCleanupJobs.target, rotationTarget(projectId)));
    return row;
  }

  async function issued(projectId: string) {
    const [row] = await env.db
      .select({ gen: projects.proxy_token_gen })
      .from(projects)
      .where(eq(projects.id, projectId));
    return row!.gen;
  }

  const scriptToken = (cf: MockCfApiHandle, script: string) =>
    cf.state.hostScripts.get(script)?.bindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;

  /** Moves every rotation wait an hour back and makes the jobs due. */
  async function endWaits() {
    const shifted = (field: string) => sql`CASE WHEN payload->>${field} IS NOT NULL
      THEN jsonb_build_object(${field}::text, to_char(((payload->>${field})::timestamptz
        - interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ELSE '{}'::jsonb END`;
    await env.db.execute(sql`UPDATE project_cleanup_jobs
      SET next_attempt_at = now(),
        payload = payload || ${shifted('waitUntil')} || ${shifted('lastPatchAt')}
      WHERE kind = 'proxy-token-rotation'`);
  }

  /** One scheduled rotation run past the current waits. */
  async function runRotations() {
    await endWaits();
    await reconcileProxyTokenRotations(env.db, env as unknown as ProxyTokenRotationEnv);
  }

  /** Scheduled rotation runs until no job is left. */
  async function finishRotations() {
    for (let run = 0; run < 6; run++) {
      await runRotations();
      const plan = await req('/system/rotate-proxy-tokens', { dryRun: true });
      const body = (await plan.json()) as { summary: { pending: number; failed: number } };
      if (body.summary.pending + body.summary.failed === 0) {
        return;
      }
    }
    throw new Error('Rotation did not complete within six runs.');
  }

  test('previews every project without writing anything or returning a token', async () => {
    const cf = cloudflare();
    const withWorkers = await rotationProject(cf, 'rotate-plan-workers', { workers: true });
    const empty = await rotationProject(cf, 'rotate-plan-empty');
    const rotated = await rotationProject(cf, 'rotate-plan-rotated', { gen: 1 });

    const progress = await req('/system/rotate-proxy-tokens', { dryRun: true });
    expect(progress.status).toBe(200);
    const text = await progress.text();
    expect(JSON.parse(text)).toEqual({
      summary: { pending: 0, failed: 0 },
      projects: [],
      dryRun: true,
      action: 'system.rotate-proxy-tokens',
      target: { projects: 'all' },
    });
    const all = await req('/system/rotate-proxy-tokens', { dryRun: true, all: true });
    expect(await all.json()).toMatchObject({
      summary: { wouldQueue: 3, pending: 0, failed: 0 },
      target: { projects: 'all' },
    });

    const project = await req('/system/rotate-proxy-tokens', {
      dryRun: true,
      project: withWorkers.id,
    });
    expect(project.status).toBe(200);
    const projectText = await project.text();
    expect(JSON.parse(projectText)).toEqual({
      projectId: withWorkers.id,
      slug: 'rotate-plan-workers',
      gen: 0,
      job: null,
      workers: withWorkers.workers,
      dryRun: true,
      action: 'system.rotate-proxy-tokens',
      target: { projects: withWorkers.id },
    });

    for (const body of [text, projectText]) {
      expect(body).not.toContain('mock-proxy-token');
      for (const id of [withWorkers.id, empty.id, rotated.id]) {
        expect(body).not.toContain(await tok(id, 0));
        expect(body).not.toContain(await tok(id, 1));
      }
    }
    expect(await env.db.select().from(projectCleanupJobs)).toEqual([]);
    expect((await env.ROUTING.list({ prefix: 'proxy-token:' })).keys).toEqual([]);
    expect(patchCount(cf)).toBe(0);
    expect(await env.db.select().from(operatorEvents)).toEqual([]);
  });

  test('rotates every project with --all in bounded runs', async () => {
    const cf = cloudflare();
    const withWorkers = await rotationProject(cf, 'rotate-bulk-workers', { workers: true });
    const empty = await rotationProject(cf, 'rotate-bulk-empty');
    const rotated = await rotationProject(cf, 'rotate-bulk-rotated', { gen: 1 });

    const first = await req('/system/rotate-proxy-tokens', { all: true });
    expect(first.status).toBe(207);
    expect(await first.json()).toMatchObject({
      ok: true,
      complete: false,
      queued: 3,
      pending: 3,
      failed: 0,
      failures: [],
    });

    await finishRotations();
    for (const project of [withWorkers, empty]) {
      expect(await issued(project.id)).toBe(1);
      expect(await env.ROUTING.get(`proxy-token:${project.id}`, 'json')).toEqual({ gen: 1 });
    }
    for (const worker of withWorkers.workers) {
      expect(scriptToken(cf, worker)).toBe(await tok(withWorkers.id, 1));
    }
    expect(await issued(rotated.id)).toBe(2);
    expect(await env.ROUTING.get(`proxy-token:${rotated.id}`, 'json')).toEqual({ gen: 2 });
    expect(await env.db.select().from(projectCleanupJobs)).toEqual([]);
  });

  test('shows a project rotation in progress', async () => {
    const cf = cloudflare();
    const project = await rotationProject(cf, 'rotate-progress', { workers: true });

    const apply = await req('/system/rotate-proxy-tokens', { project: project.id });
    expect(apply.status).toBe(207);
    expect(await apply.json()).toMatchObject({
      ok: true,
      complete: false,
      queued: 1,
      pending: 1,
      failed: 0,
    });

    const plan = await req('/system/rotate-proxy-tokens', { dryRun: true, project: project.id });
    const body = (await plan.json()) as { job: { waitUntil: string } };
    expect(body).toMatchObject({
      projectId: project.id,
      gen: 1,
      job: {
        phase: 'revoke',
        reason: 'operator',
        again: false,
        attempts: 0,
        lastError: null,
      },
      workers: project.workers,
      dryRun: true,
      action: 'system.rotate-proxy-tokens',
      target: { projects: project.id },
    });
    // Every Worker is patched; the floor waits for their old versions to drain.
    expect(Date.parse(body.job.waitUntil)).toBeGreaterThan(Date.now());
    expect(patchCount(cf)).toBe(2);
    expect(await env.ROUTING.get(`proxy-token:${project.id}`)).toBeNull();

    const progress = await req('/system/rotate-proxy-tokens', { dryRun: true });
    expect(await progress.json()).toMatchObject({
      summary: { pending: 1, failed: 0 },
      projects: [{ projectId: project.id, slug: 'rotate-progress', phase: 'revoke' }],
    });
  });

  test.each(['patch', 'revoke', 'settle'])(
    'rotates once more when --project lands on a job in %s',
    async (phase) => {
      const cf = cloudflare();
      const project = await rotationProject(cf, `rotate-again-${phase}`, { workers: true });
      if (phase === 'patch') {
        // Stop right after START, before the first Worker is patched.
        await requestProxyTokenRotation(env.db, project.id, 'operator', 'operator');
        await advanceProxyTokenRotation(
          env.db,
          env as unknown as ProxyTokenRotationEnv,
          project.id,
          { cfCallsRemaining: 0, deadline: Date.now() + 60_000 },
        );
      } else {
        await req('/system/rotate-proxy-tokens', { project: project.id });
      }
      while ((await rotationJob(project.id))!.payload.phase !== phase) {
        await runRotations();
      }

      await req('/system/rotate-proxy-tokens', { project: project.id });
      expect((await rotationJob(project.id))!.payload.again).toBe('1');

      await finishRotations();
      expect(await issued(project.id)).toBe(2);
      for (const worker of project.workers) {
        expect(scriptToken(cf, worker)).toBe(await tok(project.id, 2));
      }
    },
  );

  test('does not add a generation for a job that has not started', async () => {
    const cf = cloudflare();
    const project = await rotationProject(cf, 'rotate-requested', { workers: true });
    await env.db.insert(projectCleanupJobs).values({
      target: rotationTarget(project.id),
      project_id: project.id,
      kind: 'proxy-token-rotation',
      payload: { phase: 'requested', reason: 'member-removed' },
      next_attempt_at: sql`now() + interval '1 hour'`,
    });

    await req('/system/rotate-proxy-tokens', { project: project.id });
    const job = await rotationJob(project.id);
    expect(job!.payload).toMatchObject({ phase: 'revoke', reason: 'member-removed' });
    expect(job!.payload.again).toBeUndefined();

    await finishRotations();
    expect(await issued(project.id)).toBe(1);
  });

  test('flags a running rotation with --all', async () => {
    const cf = cloudflare();
    const project = await rotationProject(cf, 'rotate-flag', { workers: true });
    await req('/system/rotate-proxy-tokens', { project: project.id });
    expect((await rotationJob(project.id))!.payload.again).toBeUndefined();

    const all = await req('/system/rotate-proxy-tokens', { all: true });
    expect(await all.json()).toMatchObject({ queued: 1 });
    expect((await rotationJob(project.id))!.payload.again).toBe('1');
  });

  test('reports a rotation that keeps failing', async () => {
    const cf = cloudflare();
    const project = await rotationProject(cf, 'rotate-failing', { workers: true });
    cf.state.hostScripts.delete(project.workers[1]!);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failed = await req('/system/rotate-proxy-tokens', { project: project.id });
    expect(failed.status).toBe(207);
    expect(await failed.json()).toMatchObject({
      ok: false,
      complete: false,
      pending: 0,
      failed: 1,
      failures: [
        {
          projectId: project.id,
          slug: 'rotate-failing',
          phase: 'patch',
          error: expect.stringContaining('not found'),
        },
      ],
    });
    const plan = await req('/system/rotate-proxy-tokens', { dryRun: true, project: project.id });
    expect(await plan.json()).toMatchObject({
      job: { phase: 'patch', attempts: 1, lastError: expect.stringContaining('not found') },
    });
    expect(await env.ROUTING.get(`proxy-token:${project.id}`)).toBeNull();
  });

  test('rejects invalid scopes and platforms without Cloudflare access', async () => {
    const cf = cloudflare();
    for (const body of [
      { project: 'not-a-project' },
      { project: 42 },
      { all: 'yes' },
      { project: 'proj_000000000000', all: true },
    ]) {
      for (const dryRun of [true, false]) {
        const response = await req('/system/rotate-proxy-tokens', { ...body, dryRun });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'invalid_argument' });
      }
    }
    for (const body of [{}, { all: false }]) {
      const response = await req('/system/rotate-proxy-tokens', body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'invalid_argument',
        message: 'Supply --project <id> or --all.',
      });
    }
    const unknown = await req('/system/rotate-proxy-tokens', {
      project: 'proj_zzzzzzzzzzzz',
      dryRun: true,
    });
    expect(unknown.status).toBe(404);

    await rotationProject(cf, 'rotate-unavailable');
    for (const extraEnv of [{ DEV_AUTH_BYPASS: 'true' }, { CF_API_TOKEN: '' }]) {
      const preview = await req(
        '/system/rotate-proxy-tokens',
        { all: true, dryRun: true },
        extraEnv,
      );
      expect(preview.status).toBe(200);
      const response = await req('/system/rotate-proxy-tokens', { all: true }, extraEnv);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'rotation_unavailable' });
    }
    expect(await env.db.select().from(projectCleanupJobs)).toEqual([]);
    expect(cf).not.toHaveBeenCalled();
  });
});
