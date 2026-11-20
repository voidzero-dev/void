import { eq } from 'drizzle-orm';
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
import type { ApiEnv } from '../../src/env.ts';
import { projects, projectZeroTrust } from '../../src/schema.ts';
import { changeSecurityPolicy } from '../../src/security/policy.ts';
import { recheckPublicRequest } from '../../src/security/public-gate-flow.ts';
import { readZeroTrustConfigurationStrict } from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import { resolveProjectZeroTrustRouting } from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';
import { askPublic, setupGate, succeededScan } from './security-gate-fixtures.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
  } as unknown as ApiEnv['Bindings'];
}

function providerError(message: string, status: number): Response {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  const deletedIds: Array<string> = [];
  let nextApplication = 1;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1' } });
    }
    if (path === 'policies/policy-1') {
      return Response.json({
        success: true,
        result: {
          id: 'policy-1',
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        },
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = `app-${nextApplication++}`;
      const application = { ...body, id, aud: `aud-${id}` };
      applications.set(id, application);
      return Response.json({ success: true, result: application });
    }
    if (path === 'apps') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '100');
      const start = (page - 1) * perPage;
      return Response.json({
        success: true,
        result: [...applications.values()].slice(start, start + perPage),
      });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match) {
      const id = match[1]!;
      const previous = applications.get(id);
      if (!previous) {
        return providerError('application not found', 404);
      }
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const application = { ...body, id, aud: previous.aud };
        applications.set(id, application);
        return Response.json({ success: true, result: application });
      }
      if (init?.method === 'DELETE') {
        applications.delete(id);
        deletedIds.push(id);
        return Response.json({ success: true, result: { id } });
      }
      return Response.json({ success: true, result: previous });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, deletedIds, fetcher };
}

async function configurePublicProjects(platform: ApiEnv['Bindings']): Promise<void> {
  await configurePlatformZeroTrust(platform, env.db, {
    apiToken: 'access-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
    existingProjects: 'public',
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await readZeroTrustConfigurationStrict(env.db))!.operation) {
      return;
    }
    await reconcilePlatformZeroTrust(platform, env.db);
  }
  throw new Error('Public project setup did not finish within its expected batches');
}

function expectPublicBypass(
  cloudflare: ReturnType<typeof accessApi>,
  bypassId: string,
  slug: string,
): void {
  expect(cloudflare.applications.get(bypassId)).toMatchObject({
    domain: `${slug}.apps.example.com`,
    policies: [{ decision: 'bypass', include: [{ everyone: {} }] }],
  });
}

describe('Zero Trust disable public bypass lifecycle', () => {
  it('preserves every public bypass across project batches until the wildcard is removed', async () => {
    const owner = await createTestUser(env.db, 'batched-public-owner');
    const publicProjects = Array.from({ length: 101 }, (_, index) => ({
      id: `public-batch-${index.toString().padStart(3, '0')}`,
      user_id: owner.id,
      slug: `public-batch-${index}`,
    }));
    await env.db.insert(projects).values(publicProjects);
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePublicProjects(platform);
    const { wildcardApplication: wildcard, healthApplication: health } =
      (await readZeroTrustConfigurationStrict(env.db))!;
    const originalRows = await env.db.select().from(projectZeroTrust);
    expect(originalRows).toHaveLength(101);
    // 101 public exceptions, the shared application, and the health exception.
    expect(cloudflare.applications.size).toBe(103);

    await disablePlatformZeroTrust(platform, env.db);

    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: true,
      operation: { kind: 'disable', phase: 'projects', owner: null },
    });
    expect(cloudflare.applications.has(wildcard!.id)).toBe(true);
    expect(cloudflare.deletedIds).toEqual([]);
    for (const project of publicProjects) {
      const row = originalRows.find((entry) => entry.project_id === project.id)!;
      expectPublicBypass(cloudflare, row.bypass_application_id!, project.slug);
    }

    await reconcilePlatformZeroTrust(platform, env.db);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      wildcardApplication: null,
      operation: { kind: 'disable', phase: 'bypass-delete', owner: null },
    });
    expect(cloudflare.applications.has(wildcard!.id)).toBe(false);
    expect(cloudflare.deletedIds.slice(0, 2)).toEqual([wildcard!.id, health!.id]);
    const remainingBypasses = (await env.db.select().from(projectZeroTrust)).filter(
      (row) => row.bypass_application_id !== null,
    );
    expect(remainingBypasses.length).toBeGreaterThan(0);
    expect(101 - remainingBypasses.length).toBeLessThanOrEqual(100);
    expect(cloudflare.applications.size).toBe(remainingBypasses.length);

    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await readZeroTrustConfigurationStrict(env.db))!.operation) {
        break;
      }
      await reconcilePlatformZeroTrust(platform, env.db);
    }

    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      lastError: null,
      operation: null,
    });
    expect(cloudflare.deletedIds[0]).toBe(wildcard!.id);
    expect(cloudflare.applications.size).toBe(0);
    for (const row of await env.db.select().from(projectZeroTrust)) {
      expect(row).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        bypass_application_id: null,
        bypass_application_name: null,
      });
    }
    // 101 projects take about 1.5s alone but more than 10s while the full
    // suite shares the machine with other test runs.
  }, 30_000);

  it('keeps the public exception usable when wildcard deletion fails', async () => {
    const owner = await createTestUser(env.db, 'wildcard-failure-owner');
    const project = await createTestProject(env.db, owner.id, 'wildcard-failure-public');
    const cloudflare = accessApi();
    let failedWildcardId: string | null = null;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (
        init?.method === 'DELETE' &&
        new URL(input.toString()).pathname.endsWith(`/apps/${failedWildcardId}`)
      ) {
        return providerError('Wildcard deletion unavailable', 503);
      }
      return cloudflare.fetcher(input, init);
    });
    const platform = bindings();
    await configurePublicProjects(platform);
    const { wildcardApplication: wildcard, healthApplication: health } =
      (await readZeroTrustConfigurationStrict(env.db))!;
    const bypass = (await getProjectZeroTrustState(env.db, project.id))!;
    failedWildcardId = wildcard!.id;

    await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
      'Wildcard deletion unavailable',
    );

    expect(cloudflare.applications.has(wildcard!.id)).toBe(true);
    expectPublicBypass(cloudflare, bypass.bypass_application_id!, project.slug);
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      bypass_application_id: bypass.bypass_application_id,
      bypass_application_name: bypass.bypass_application_name,
    });
    await expect(resolveProjectZeroTrustRouting(env.db, project.id)).resolves.toBeNull();
    expect(cloudflare.deletedIds).toEqual([]);

    failedWildcardId = null;
    await reconcilePlatformZeroTrust(platform, env.db);
    expect(cloudflare.deletedIds).toEqual([wildcard!.id, health!.id, bypass.bypass_application_id]);
    expect(cloudflare.applications.size).toBe(0);
  });

  it('finishes disable around a failing project and keeps it denied until scheduled cleanup', async () => {
    const owner = await createTestUser(env.db, 'mixed-disable-owner');
    const [publicProject, failingProject, unvisitedProject] = [
      { id: 'mixed-public', slug: 'mixed-public', created_at: '2020-01-01 00:00:00' },
      { id: 'mixed-failing', slug: 'mixed-failing', created_at: '2020-01-02 00:00:00' },
      { id: 'mixed-unvisited', slug: 'mixed-unvisited', created_at: '2020-01-03 00:00:00' },
    ] as const;
    await env.db.insert(projects).values(
      [publicProject, failingProject, unvisitedProject].map((project) => ({
        ...project,
        user_id: owner.id,
      })),
    );
    for (const project of [failingProject, unvisitedProject]) {
      const deployment = await createTestDeployment(env.db, project.id, 'live');
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          projectId: project.id,
          workerName: `user-${project.slug}-${deployment.id}`,
          version: deployment.id,
        }),
      );
    }
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePublicProjects(platform);
    for (const project of [failingProject, unvisitedProject]) {
      await setProjectZeroTrustProtection(platform, env.db, project.id, true);
    }
    const { wildcardApplication: wildcard, healthApplication: health } =
      (await readZeroTrustConfigurationStrict(env.db))!;
    const bypass = (await getProjectZeroTrustState(env.db, publicProject.id))!;
    const originalUnvisitedRoute = await env.ROUTING.get(unvisitedProject.slug);
    expect(JSON.parse(originalUnvisitedRoute!).zeroTrust).toBeDefined();
    cloudflare.deletedIds.length = 0;
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    const putSpy = vi.spyOn(env.ROUTING, 'put').mockImplementation(async (...args) => {
      if (args[0] === failingProject.slug) {
        throw new Error('Later protected project routing failed');
      }
      return originalPut(...args);
    });
    const failingRoute = await env.ROUTING.get(failingProject.slug);
    try {
      // One project's failure does not hold the installation disable.
      await expect(disablePlatformZeroTrust(platform, env.db)).resolves.toMatchObject({
        enabled: false,
        status: 'ready',
        operation: null,
      });
    } finally {
      putSpy.mockRestore();
    }

    expect(cloudflare.deletedIds).toEqual([wildcard!.id, health!.id, bypass.bypass_application_id]);
    expect(cloudflare.applications.size).toBe(0);
    await expect(resolveProjectZeroTrustRouting(env.db, publicProject.id)).resolves.toBeNull();
    expect(await getProjectZeroTrustState(env.db, unvisitedProject.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
    });
    expect(JSON.parse((await env.ROUTING.get(unvisitedProject.slug))!).zeroTrust).toBeUndefined();
    // The skipped project keeps its protected route: without an Access
    // assertion dispatch denies it rather than serving it publicly.
    expect(await getProjectZeroTrustState(env.db, failingProject.id)).toMatchObject({
      desired_protected: false,
      status: 'error',
      last_error: 'Later protected project routing failed',
    });
    expect(await env.ROUTING.get(failingProject.slug)).toBe(failingRoute);
    expect(JSON.parse(failingRoute!).zeroTrust).toBeDefined();

    await reconcilePendingProjectZeroTrust(platform, env.db);
    expect(await getProjectZeroTrustState(env.db, failingProject.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
      last_error: null,
    });
    expect(JSON.parse((await env.ROUTING.get(failingProject.slug))!).zeroTrust).toBeUndefined();
  });

  it.each(['reconcile', 'replacement credential'] as const)(
    'retains a failed bypass cleanup handle and resumes with %s without deleting the wildcard again',
    async (recovery) => {
      const owner = await createTestUser(env.db, 'bypass-failure-owner');
      const project = await createTestProject(env.db, owner.id, 'bypass-failure-public');
      const cloudflare = accessApi();
      let failedBypassId: string | null = null;
      let oldTokenRevoked = false;
      const deleteAttempts: Array<string> = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (
          oldTokenRevoked &&
          new Headers(init?.headers).get('Authorization') === 'Bearer access-token'
        ) {
          return providerError('Old token revoked', 403);
        }
        if (init?.method === 'DELETE') {
          const id = new URL(input.toString()).pathname.split('/').at(-1)!;
          deleteAttempts.push(id);
          if (id === failedBypassId) {
            return providerError('Bypass deletion unavailable', 503);
          }
        }
        return cloudflare.fetcher(input, init);
      });
      const platform = bindings();
      await configurePublicProjects(platform);
      const { wildcardApplication: wildcard, healthApplication: health } =
        (await readZeroTrustConfigurationStrict(env.db))!;
      const bypass = (await getProjectZeroTrustState(env.db, project.id))!;
      failedBypassId = bypass.bypass_application_id;

      await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
        'Bypass deletion unavailable',
      );

      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: false,
        lastError: expect.any(String),
        wildcardApplication: null,
        operation: { kind: 'disable', phase: 'bypass-delete', owner: null },
      });
      expect(cloudflare.applications.has(wildcard!.id)).toBe(false);
      expectPublicBypass(cloudflare, bypass.bypass_application_id!, project.slug);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        bypass_application_id: bypass.bypass_application_id,
        bypass_application_name: bypass.bypass_application_name,
      });
      await expect(resolveProjectZeroTrustRouting(env.db, project.id)).resolves.toBeNull();

      failedBypassId = null;
      if (recovery === 'replacement credential') {
        oldTokenRevoked = true;
        await configurePlatformZeroTrust(platform, env.db, {
          apiToken: 'replacement-token',
          identityProviderIds: ['idp-1'],
          policyIds: ['policy-1'],
          protectNewProjects: true,
        });
      } else {
        await reconcilePlatformZeroTrust(platform, env.db);
      }
      expect(deleteAttempts).toEqual([
        wildcard!.id,
        health!.id,
        bypass.bypass_application_id,
        bypass.bypass_application_id,
      ]);
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: false,
        lastError: null,
        operation: null,
      });
      expect(cloudflare.applications.size).toBe(0);
    },
  );

  it('recovers a name-only bypass after provider deletion succeeds but its database checkpoint rolls back', async () => {
    const owner = await createTestUser(env.db, 'bypass-checkpoint-owner');
    const project = await createTestProject(env.db, owner.id, 'bypass-checkpoint-public');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePublicProjects(platform);
    const { wildcardApplication: wildcard, healthApplication: health } =
      (await readZeroTrustConfigurationStrict(env.db))!;
    const bypass = (await getProjectZeroTrustState(env.db, project.id))!;
    await env.db
      .update(projectZeroTrust)
      .set({ bypass_application_id: null })
      .where(eq(projectZeroTrust.project_id, project.id));

    const originalTransaction = env.db.transaction.bind(env.db);
    let failCheckpoint = true;
    const transactionSpy = vi
      .spyOn(env.db, 'transaction')
      .mockImplementation(async (callback, options) =>
        originalTransaction(async (tx) => {
          const result = await callback(tx);
          if (failCheckpoint && cloudflare.deletedIds.includes(bypass.bypass_application_id!)) {
            failCheckpoint = false;
            throw new Error('Bypass checkpoint transaction failed');
          }
          return result;
        }, options),
      );
    try {
      // The project is skipped; the installation disable still completes.
      await expect(disablePlatformZeroTrust(platform, env.db)).resolves.toMatchObject({
        enabled: false,
        status: 'ready',
        wildcardApplication: null,
        operation: null,
      });
    } finally {
      transactionSpy.mockRestore();
    }

    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      bypass_application_id: null,
      bypass_application_name: bypass.bypass_application_name,
      status: 'error',
    });
    expect(cloudflare.applications.size).toBe(0);

    await reconcilePendingProjectZeroTrust(platform, env.db);

    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      bypass_application_id: null,
      bypass_application_name: null,
      status: 'ready',
      desired_protected: false,
    });
    expect(cloudflare.deletedIds).toEqual([wildcard!.id, health!.id, bypass.bypass_application_id]);
  });
});

describe('Zero Trust disable with the public gate', () => {
  async function finishDisable(platform: ApiEnv['Bindings']) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await readZeroTrustConfigurationStrict(env.db))!.operation) {
        return;
      }
      await reconcilePlatformZeroTrust(platform, env.db);
    }
    throw new Error('Disable did not finish within its expected batches');
  }

  it('removes the bypass of a project the gate made public when Zero Trust is disabled', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    await succeededScan(s);
    expect((await recheckPublicRequest(s.platform, env.db, s.project.id))?.state).toBe('passed');
    const row = (await getProjectZeroTrustState(env.db, s.project.id))!;
    expect(row).toMatchObject({ desired_protected: false, effective_protected: false });
    expect(s.cloudflare.applications.has(row.bypass_application_id!)).toBe(true);
    await changeSecurityPolicy(
      env.db,
      { publicGate: false, expectedRevision: 1 },
      { userId: s.user.id, preview: false },
    );

    await disablePlatformZeroTrust(s.platform, env.db);
    await finishDisable(s.platform);

    expect(s.cloudflare.applications.size).toBe(0);
    expect(await getProjectZeroTrustState(env.db, s.project.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      bypass_application_id: null,
    });
  });

  it('keeps a project with an open request protected until the disable opens everything', async () => {
    const s = await setupGate(env);
    const asked = await askPublic(s);
    expect(asked.held).toBe(true);
    // The disable is refused while the gate is on, and changes nothing.
    await expect(disablePlatformZeroTrust(s.platform, env.db)).rejects.toMatchObject({
      code: 'security public gate on',
    });
    expect(await getProjectZeroTrustState(env.db, s.project.id)).toMatchObject({
      desired_protected: true,
    });
    const off = await changeSecurityPolicy(
      env.db,
      { publicGate: false, expectedRevision: 1 },
      { userId: s.user.id, preview: false },
    );
    expect(off).toMatchObject({ ok: true, canceledRequests: 1 });
    // Canceling the request does not open the project.
    expect(await getProjectZeroTrustState(env.db, s.project.id)).toMatchObject({
      desired_protected: true,
    });

    await disablePlatformZeroTrust(s.platform, env.db);
    await finishDisable(s.platform);

    expect(await getProjectZeroTrustState(env.db, s.project.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
    });
    expect(s.cloudflare.applications.size).toBe(0);
  });
});
