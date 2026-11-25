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
import { beginDeploymentCutover, deleteProjectCascade, getProject, getUser } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { setProjectsRoutingSuspension } from '../../src/routing.ts';
import { domains, deployments } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockKvRead,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

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
function configurationInput(protectedProject: boolean) {
  return {
    apiToken: 'test-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: protectedProject,
    existingProjects: protectedProject ? ('protected' as const) : ('public' as const),
  };
}

async function operatorRequest(token: string, path: string, body: Record<string, unknown>) {
  const response = await app.fetch(
    new Request('http://localhost/operator/v1' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    bindings(),
  );
  expect(response.status, await response.text()).toBe(200);
}

function staleRouteRead(keys: Array<string>, raw: string) {
  return mockKvRead(env.ROUTING, (key) => (keys.includes(key) ? raw : undefined));
}

function providerError(message: string, status: number): Response {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}
function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
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
    if (path === 'identity_providers/idp-1' || path === 'identity_providers/idp-2') {
      return Response.json({ success: true, result: { id: path.split('/').at(-1) } });
    }
    if (path === 'policies/policy-1' || path === 'policies/policy-2') {
      return Response.json({
        success: true,
        result: {
          id: path.split('/').at(-1),
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
      const id = match[1];
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
        return Response.json({ success: true, result: { id } });
      }
      return Response.json({ success: true, result: previous });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}
describe('Zero Trust authoritative route metadata', () => {
  it.each(
    (['worker', 'static'] as const).flatMap((type) =>
      [
        { mutation: 'suspend', protectedAfter: true, customCpuMs: undefined },
        { mutation: 'restore', protectedAfter: false, customCpuMs: undefined },
        { mutation: 'owner', protectedAfter: true, customCpuMs: undefined },
        { mutation: 'owner', protectedAfter: false, customCpuMs: 30 },
        { mutation: 'upgrade', protectedAfter: true, customCpuMs: 30 },
        { mutation: 'downgrade', protectedAfter: false, customCpuMs: 30 },
        { mutation: 'unlimited plan', protectedAfter: true, customCpuMs: undefined },
      ].map((testCase) => ({ ...testCase, type })),
    ),
  )(
    'preserves completed $mutation on $type routes with protection=$protectedAfter and custom CPU=$customCpuMs',
    async ({ mutation, protectedAfter, customCpuMs, type }) => {
      const admin = await createTestUser(
        env.db,
        'metadata-admin',
        'github',
        undefined,
        'free',
        'admin',
      );
      const token = await createOperatorToken(env.db, admin);
      const owner = await createTestUser(
        env.db,
        'metadata-owner',
        'github',
        undefined,
        mutation === 'downgrade' ? 'pro' : 'free',
      );
      const target = await createTestUser(env.db, 'metadata-target', 'github', undefined, 'pro');
      const project = await createTestProject(env.db, owner.id, 'metadata-project');
      const deployment = await createTestDeployment(env.db, project.id, 'live');
      const manifest = {
        version: 3,
        type: type === 'worker' ? 'void' : 'static',
        bindings: {},
        ...(customCpuMs ? { limits: { cpuMs: customCpuMs } } : {}),
      };
      await env.db
        .update(deployments)
        .set({ manifest: JSON.stringify(manifest) })
        .where(eq(deployments.id, deployment.id));
      const initialLimits =
        mutation === 'downgrade'
          ? { cpuMs: customCpuMs ?? 50, subRequests: 1000 }
          : { cpuMs: 10, subRequests: 50 };
      const initial = JSON.stringify({
        ...(type === 'worker'
          ? { workerName: 'user-' + project.slug + '-' + deployment.id, limits: initialLimits }
          : { staticDeploymentId: deployment.id, assetConfig: { not_found_handling: '404-page' } }),
        projectId: project.id,
        userId: owner.id,
        version: deployment.id,
        type: type === 'worker' ? 'void' : 'static',
        customMetadata: { preserve: true },
      });
      const domainKey = 'domain:metadata.example.com';
      await env.db.insert(domains).values({
        id: 'dom_metadata',
        project_id: project.id,
        hostname: 'metadata.example.com',
        cf_hostname_id: 'cf-metadata',
        status: 'active',
      });
      await env.ROUTING.put(project.slug, initial);
      await env.ROUTING.put(domainKey, initial);
      vi.stubGlobal('fetch', accessApi().fetcher);
      await configurePlatformZeroTrust(bindings(), env.db, configurationInput(!protectedAfter));
      if (mutation === 'restore') {
        await operatorRequest(token, '/users/' + owner.id + '/suspend', {
          reason: 'operator_review',
        });
      }
      if (mutation === 'owner') {
        await operatorRequest(token, '/users/' + target.id + '/suspend', {
          reason: 'target_owner_review',
        });
      }
      const stale = (await env.ROUTING.get(project.slug))!;
      if (mutation === 'suspend') {
        await operatorRequest(token, '/users/' + owner.id + '/suspend', {
          reason: 'operator_review',
        });
      } else if (mutation === 'restore') {
        await operatorRequest(token, '/users/' + owner.id + '/restore', {});
      } else if (mutation === 'owner') {
        await operatorRequest(token, '/projects/' + project.id + '/owner', { userId: target.id });
      } else {
        await operatorRequest(token, '/users/' + owner.id + '/plan', {
          plan: mutation === 'upgrade' ? 'pro' : mutation === 'downgrade' ? 'free' : 'custom',
        });
      }
      const currentOwnerId = mutation === 'owner' ? target.id : owner.id;
      const expectedSuspension =
        mutation === 'suspend'
          ? 'operator_review'
          : mutation === 'owner'
            ? 'target_owner_review'
            : undefined;
      const expectedLimits =
        type === 'static' || mutation === 'unlimited plan'
          ? undefined
          : mutation === 'owner' || mutation === 'upgrade'
            ? { cpuMs: customCpuMs ?? 50, subRequests: 1000 }
            : { cpuMs: 10, subRequests: 50 };
      expect((await getProject(env.db, project.id))!.user_id).toBe(currentOwnerId);
      expect((await getUser(env.db, currentOwnerId))!.suspended_reason).toBe(
        expectedSuspension ?? null,
      );
      const completed = JSON.parse((await env.ROUTING.get(project.slug))!);
      expect({
        userId: completed.userId,
        limits: completed.limits,
        suspended: completed.suspended,
      }).toEqual({ userId: currentOwnerId, limits: expectedLimits, suspended: expectedSuspension });
      const read = staleRouteRead([project.slug, domainKey], stale);
      try {
        await setProjectZeroTrustProtection(bindings(), env.db, project.id, protectedAfter);
      } finally {
        read.mockRestore();
      }
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        effective_protected: protectedAfter,
        status: 'ready',
        desired_protected: protectedAfter,
      });
      for (const key of [project.slug, domainKey]) {
        const actual = JSON.parse((await env.ROUTING.get(key))!);
        expect({
          userId: actual.userId,
          limits: actual.limits,
          suspended: actual.suspended,
        }).toEqual({
          userId: currentOwnerId,
          limits: expectedLimits,
          suspended: expectedSuspension,
        });
        expect(actual).toMatchObject({
          projectId: project.id,
          version: deployment.id,
          ...(type === 'worker'
            ? { workerName: 'user-' + project.slug + '-' + deployment.id }
            : { staticDeploymentId: deployment.id }),
          customMetadata: { preserve: true },
        });
        if (protectedAfter) {
          expect(actual.zeroTrust.audiences.length).toBeGreaterThan(0);
        } else {
          expect(actual.zeroTrust).toBeUndefined();
        }
      }
    },
  );

  it('uses the cutover deployment manifest when refreshing Worker limits', async () => {
    const owner = await createTestUser(env.db, 'cutover-limits-owner', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, owner.id, 'cutover-limits-project');
    const source = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ version: 3, bindings: {}, limits: { cpuMs: 10 } }) })
      .where(eq(deployments.id, source.id));
    const domainKey = 'domain:cutover-limits.example.com';
    await env.db.insert(domains).values({
      id: 'dom_cutover_limits',
      project_id: project.id,
      hostname: 'cutover-limits.example.com',
      cf_hostname_id: 'cf-cutover-limits',
      status: 'active',
    });
    const route = (id: string) =>
      JSON.stringify({
        workerName: 'user-' + project.slug + '-' + id,
        projectId: project.id,
        userId: owner.id,
        version: id,
        limits: { cpuMs: 10, subRequests: 1000 },
      });
    await env.ROUTING.put(project.slug, route(source.id));
    await env.ROUTING.put(domainKey, route(source.id));
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, configurationInput(false));
    const candidate = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .update(deployments)
      .set({ manifest: JSON.stringify({ version: 3, bindings: {}, limits: { cpuMs: 35 } }) })
      .where(eq(deployments.id, candidate.id));
    expect(await beginDeploymentCutover(env.db, candidate.id)).toBe(true);
    await env.ROUTING.put(project.slug, route(candidate.id));
    await env.ROUTING.put(domainKey, route(candidate.id));
    await setProjectZeroTrustProtection(bindings(), env.db, project.id, true);
    expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(source.id);
    for (const key of [project.slug, domainKey]) {
      const published = JSON.parse((await env.ROUTING.get(key))!);
      expect(published).toMatchObject({
        version: candidate.id,
        limits: { cpuMs: 35, subRequests: 1000 },
      });
      expect(published.zeroTrust.audiences.length).toBeGreaterThan(0);
    }
  });

  it.each([true, false])(
    'never republishes a deleted project after slug reuse with protection=%s',
    async (protectedProject) => {
      const owner = await createTestUser(env.db, 'reuse-owner');
      const previous = await createTestProject(env.db, owner.id, 'reused-project');
      const deployment = await createTestDeployment(env.db, previous.id, 'live');
      const stale = JSON.stringify({
        workerName: 'user-' + previous.slug + '-' + deployment.id,
        projectId: previous.id,
        userId: owner.id,
        version: deployment.id,
      });
      await env.ROUTING.put(previous.slug, stale);
      await env.ROUTING.delete(previous.slug);
      await deleteProjectCascade(env.db, previous.id);
      const current = await createTestProject(env.db, owner.id, previous.slug);
      vi.stubGlobal('fetch', accessApi().fetcher);
      const put = vi.spyOn(env.ROUTING, 'put');
      const remove = vi.spyOn(env.ROUTING, 'delete');
      const read = staleRouteRead([current.slug], stale);
      try {
        // The stale read fails only this project; the installation operation finishes.
        await expect(
          configurePlatformZeroTrust(bindings(), env.db, configurationInput(protectedProject)),
        ).resolves.toMatchObject({ status: 'ready', operation: null });
      } finally {
        read.mockRestore();
      }
      expect(await getProjectZeroTrustState(env.db, current.id)).toMatchObject({
        status: 'error',
        last_error: expect.stringContaining('Live routing'),
      });
      expect(put.mock.calls.some(([key]) => key === current.slug)).toBe(false);
      expect(remove.mock.calls.some(([key]) => key === current.slug)).toBe(false);
      expect(await env.ROUTING.get(current.slug)).toBeNull();
      expect((await getProject(env.db, current.id))!.active_deployment_id).toBeNull();
      await reconcilePendingProjectZeroTrust(bindings(), env.db);
      expect(await env.ROUTING.get(current.slug)).toBeNull();
      expect(await getProjectZeroTrustState(env.db, current.id)).toMatchObject({
        status: 'ready',
        desired_protected: protectedProject,
      });
    },
  );
  it.each(['plan', 'suspend', 'unsuspend'] as const)(
    'never rewrites a moved hostname cached for its previous protected project on %s',
    async (mutation) => {
      const previousOwner = await createTestUser(env.db, 'moved-previous-owner');
      const previous = await createTestProject(env.db, previousOwner.id, 'moved-previous');
      const previousDeployment = await createTestDeployment(env.db, previous.id, 'live');
      const owner = await createTestUser(env.db, 'moved-current-owner');
      const current = await createTestProject(env.db, owner.id, 'moved-current');
      const token = await createOperatorToken(
        env.db,
        await createTestUser(env.db, 'moved-admin', 'github', undefined, 'free', 'admin'),
      );
      vi.stubGlobal('fetch', accessApi().fetcher);
      await configurePlatformZeroTrust(bindings(), env.db, configurationInput(false));
      // The previous project released the hostname and the current public
      // project registered it; KV may still serve the previous project's route.
      const domainKey = 'domain:moved.example.com';
      await env.db.insert(domains).values({
        id: 'dom_moved',
        project_id: current.id,
        hostname: 'moved.example.com',
        cf_hostname_id: 'cf-moved',
        status: 'pending',
      });
      const stale = JSON.stringify({
        workerName: 'user-' + previous.slug + '-' + previousDeployment.id,
        projectId: previous.id,
        userId: previousOwner.id,
        version: previousDeployment.id,
        ...(mutation === 'unsuspend' ? { suspended: 'operator_review' } : {}),
        zeroTrust: {
          teamDomain: 'company.cloudflareaccess.com',
          audiences: [{ hostname: 'moved.example.com', audience: 'aud-previous' }],
        },
      });
      const put = vi.spyOn(env.ROUTING, 'put');
      const read = staleRouteRead([domainKey], stale);
      try {
        if (mutation === 'plan') {
          const response = await app.fetch(
            new Request('http://localhost/operator/v1/users/' + owner.id + '/plan', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ plan: 'pro' }),
            }),
            bindings(),
          );
          expect(response.status).toBe(500);
          expect(await response.json()).toMatchObject({ error: 'partial_failure' });
        } else {
          await expect(
            setProjectsRoutingSuspension(
              env.ROUTING,
              env.db,
              [{ ...current, user_id: owner.id }],
              mutation === 'suspend'
                ? { op: 'suspend', reason: 'operator_review', force: true }
                : { op: 'unsuspend', matchReason: null },
            ),
          ).rejects.toThrow('belongs to another project');
        }
      } finally {
        read.mockRestore();
      }
      expect(put.mock.calls.some(([key]) => key === domainKey)).toBe(false);
      expect(await env.ROUTING.get(domainKey)).toBeNull();
    },
  );

  it('suspends every owned route before reporting a moved hostname cached for another project', async () => {
    const previousOwner = await createTestUser(env.db, 'fanout-previous-owner');
    const previous = await createTestProject(env.db, previousOwner.id, 'fanout-previous');
    const owner = await createTestUser(env.db, 'fanout-owner');
    const first = await createTestProject(env.db, owner.id, 'fanout-first');
    const second = await createTestProject(env.db, owner.id, 'fanout-second');
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, configurationInput(false));
    await env.db.insert(domains).values({
      id: 'dom_fanout',
      project_id: first.id,
      hostname: 'fanout.example.com',
      cf_hostname_id: 'cf-fanout',
      status: 'pending',
    });
    for (const project of [first, second]) {
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          workerName: 'user-' + project.slug,
          projectId: project.id,
          userId: owner.id,
        }),
      );
    }
    const domainKey = 'domain:fanout.example.com';
    const read = staleRouteRead(
      [domainKey],
      JSON.stringify({ workerName: 'user-' + previous.slug, projectId: previous.id }),
    );
    try {
      await expect(
        setProjectsRoutingSuspension(
          env.ROUTING,
          env.db,
          [first, second].map((project) => ({ ...project, user_id: owner.id })),
          { op: 'suspend', reason: 'operator_review', force: true },
        ),
      ).rejects.toThrow('belongs to another project');
    } finally {
      read.mockRestore();
    }
    for (const project of [first, second]) {
      expect(JSON.parse((await env.ROUTING.get(project.slug)) ?? '{}')).toMatchObject({
        projectId: project.id,
        suspended: 'operator_review',
      });
    }
    expect(await env.ROUTING.get(domainKey)).toBeNull();
  });
});
