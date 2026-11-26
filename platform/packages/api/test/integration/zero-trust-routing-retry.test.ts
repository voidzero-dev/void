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
import { setProjectsRoutingSuspension } from '../../src/routing.ts';
import { domains, platformSettings, projects, projectZeroTrust, users } from '../../src/schema.ts';
import {
  readZeroTrustConfigurationStrict,
  ZeroTrustConfigurationError,
} from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
} from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
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
function configurationInput(existingProjects: 'protected' | 'public' = 'protected') {
  return {
    apiToken: 'test-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
    existingProjects,
  };
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

describe('Zero Trust routing read retries', () => {
  it.each(['disabling', 'error', 'provider deletion error', 'legacy cursor'] as const)(
    'keeps completed routing public across metadata writes while platform disable is %s',
    async (status) => {
      const owner = await createTestUser(env.db, 'disable-cursor-owner');
      const publicProject = await createTestProject(env.db, owner.id, 'disable-first-public');
      const protectedProject = await createTestProject(env.db, owner.id, 'disable-last-protected');
      await env.db
        .update(projects)
        .set({ created_at: '2020-01-01 00:00:00' })
        .where(eq(projects.id, publicProject.id));
      await env.db
        .update(projects)
        .set({ created_at: '2020-01-02 00:00:00' })
        .where(eq(projects.id, protectedProject.id));
      const deployment = await createTestDeployment(env.db, protectedProject.id, 'live');
      const raw = JSON.stringify({
        projectId: protectedProject.id,
        userId: owner.id,
        workerName: `user-${protectedProject.slug}-${deployment.id}`,
        version: deployment.id,
      });
      await env.ROUTING.put(protectedProject.slug, raw);
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      const platform = bindings();
      await configurePlatformZeroTrust(platform, env.db, configurationInput());
      await setProjectZeroTrustProtection(platform, env.db, publicProject.id, false);
      // The first project consumes 299 shared routing slots, leaving just the
      // protected project's slug to be cleared before its domain page yields.
      await env.db.insert(domains).values(
        Array.from({ length: 298 }, (_, index) => ({
          id: `disable-pending-${index}`,
          project_id: publicProject.id,
          hostname: `disable-pending-${String(index).padStart(3, '0')}.example.net`,
          cf_hostname_id: `cf-disable-pending-${index}`,
          status: 'pending' as const,
        })),
      );
      const domainKey = 'domain:disable-protected.example.net';
      await env.db.insert(domains).values({
        id: 'disable-protected-domain',
        project_id: protectedProject.id,
        hostname: 'disable-protected.example.net',
        cf_hostname_id: 'cf-disable-protected',
        status: 'active',
      });
      await env.ROUTING.put(domainKey, raw);
      await setProjectZeroTrustProtection(platform, env.db, protectedProject.id, true);
      const protectedApplicationId = (await getProjectZeroTrustState(env.db, protectedProject.id))!
        .protected_application_id;
      expect(await disablePlatformZeroTrust(platform, env.db)).toMatchObject({
        enabled: true,
        status: 'disabling',
        operation: { kind: 'disable', phase: 'projects' },
      });
      expect(await getProjectZeroTrustState(env.db, protectedProject.id)).toMatchObject({
        desired_protected: false,
        effective_protected: true,
        status: 'reconciling',
        routing_cursor: '',
      });
      expect(JSON.parse((await env.ROUTING.get(protectedProject.slug))!).zeroTrust).toBeUndefined();
      expect(JSON.parse((await env.ROUTING.get(domainKey))!).zeroTrust).toBeDefined();

      if (status === 'error') {
        // An operation-wide failure, such as a revoked token, stops the
        // disable between routing pages and records it on the operation.
        const saved = (await readZeroTrustConfigurationStrict(env.db))!;
        await env.db
          .update(platformSettings)
          .set({
            value: {
              ...saved,
              revision: saved.revision + 1,
              lastError: 'injected operation failure',
              operation: { ...saved.operation!, owner: null, leaseExpiresAt: null },
            },
          })
          .where(eq(platformSettings.key, 'zeroTrust.configuration'));
      } else if (status === 'provider deletion error') {
        vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
          if (
            init?.method === 'DELETE' &&
            String(input).endsWith(`/apps/${protectedApplicationId}`)
          ) {
            return providerError('injected application deletion failure', 403);
          }
          return cloudflare.fetcher(input, init);
        });
        try {
          await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
            'injected application deletion failure',
          );
        } finally {
          vi.stubGlobal('fetch', cloudflare.fetcher);
        }
        // Routing finished before provider deletion failed. Retain the intent
        // and cleanup handle even though the completed cursor is now null.
        expect(await getProjectZeroTrustState(env.db, protectedProject.id)).toMatchObject({
          desired_protected: false,
          effective_protected: true,
          status: 'error',
          routing_cursor: null,
          protected_application_id: protectedApplicationId,
        });
      }
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        lastError:
          status === 'error' || status === 'provider deletion error' ? expect.any(String) : null,
        operation: { kind: 'disable' },
      });
      const initializing = await createTestProject(env.db, owner.id, 'disable-new-project');
      expect(await getProjectZeroTrustState(env.db, initializing.id)).toBeNull();
      await expect(resolveProjectZeroTrustRouting(env.db, protectedProject.id)).resolves.toBeNull();
      await expect(
        resolveProjectZeroTrustRoutingForPublication(env.db, protectedProject.id),
      ).resolves.toBeNull();
      await expect(resolveProjectZeroTrustRouting(env.db, initializing.id)).rejects.toThrow(
        'still being initialized',
      );
      await expect(
        resolveProjectZeroTrustRoutingForPublication(env.db, initializing.id),
      ).resolves.toEqual({ teamDomain: '', audiences: [] });

      if (status === 'legacy cursor') {
        // An older binary could persist progress without changing desired
        // intent. Its readers may then protect a previously cleared slug.
        await env.db
          .update(projectZeroTrust)
          .set({ desired_protected: true, routing_cursor: '' })
          .where(eq(projectZeroTrust.project_id, protectedProject.id));
        expect(await resolveProjectZeroTrustRouting(env.db, protectedProject.id)).not.toBeNull();
      }

      await env.db
        .update(users)
        .set({ suspended_reason: 'admin_suspended' })
        .where(eq(users.id, owner.id));
      const puts = vi.spyOn(env.ROUTING, 'put');
      await setProjectsRoutingSuspension(
        env.ROUTING,
        env.db,
        [{ ...protectedProject, user_id: owner.id }],
        { op: 'suspend', reason: 'admin_suspended', force: true },
      );
      expect(puts).toHaveBeenCalledTimes(2);
      puts.mockRestore();
      for (const key of [protectedProject.slug, domainKey]) {
        const protection = JSON.parse((await env.ROUTING.get(key))!).zeroTrust;
        if (status === 'legacy cursor') {
          expect(protection).toBeDefined();
        } else {
          expect(protection).toBeUndefined();
        }
      }
      const retryPuts = vi.spyOn(env.ROUTING, 'put');
      await reconcilePendingProjectZeroTrust(platform, env.db);
      expect(retryPuts.mock.calls.some(([key]) => key === protectedProject.slug)).toBe(
        status === 'legacy cursor' || status === 'provider deletion error',
      );
      retryPuts.mockRestore();
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: false,
        lastError: null,
        operation: null,
      });
      expect(cloudflare.applications.size).toBe(0);
      expect(await getProjectZeroTrustState(env.db, protectedProject.id)).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        routing_cursor: null,
      });
      for (const key of [protectedProject.slug, domainKey]) {
        const published = JSON.parse((await env.ROUTING.get(key))!);
        expect(published.zeroTrust).toBeUndefined();
        expect(published.version).toBe(deployment.id);
        expect(published.suspended).toBe('admin_suspended');
      }
    },
  );

  it.each(['operation id', 'required field'] as const)(
    'does not treat a disable marker with invalid %s as public intent',
    async (invalid) => {
      const owner = await createTestUser(env.db, 'invalid-disable-owner');
      const project = await createTestProject(env.db, owner.id, 'invalid-disable-project');
      vi.stubGlobal('fetch', accessApi().fetcher);
      await configurePlatformZeroTrust(bindings(), env.db, configurationInput());
      const configuration = (await readZeroTrustConfigurationStrict(env.db))!;
      await env.db
        .update(platformSettings)
        .set({
          value: {
            ...configuration,
            ...(invalid === 'required field' ? { teamDomain: null } : {}),
            operation: {
              ...(invalid === 'operation id' ? {} : { id: 'disable-operation' }),
              kind: 'disable',
              phase: 'projects',
              startedAt: new Date().toISOString(),
              owner: null,
              leaseExpiresAt: null,
              existingProjects: null,
            },
          },
        })
        .where(eq(platformSettings.key, 'zeroTrust.configuration'));
      await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toBeInstanceOf(
        ZeroTrustConfigurationError,
      );
      await expect(
        resolveProjectZeroTrustRoutingForPublication(env.db, project.id),
      ).resolves.toEqual({ teamDomain: '', audiences: [] });
    },
  );

  describe.each(['public', 'disable'] as const)('%s cleanup', (operation) => {
    it.each(['active deployment', 'legacy live deployment', 'active domain'] as const)(
      'retries a cached KV miss for an %s before completing',
      async (liveTarget) => {
        const owner = await createTestUser(env.db, 'negative-route-owner');
        const project = await createTestProject(env.db, owner.id, 'negative-route-project');
        const deployment = await createTestDeployment(env.db, project.id);
        await env.db
          .update(projects)
          .set({
            active_deployment_id: liveTarget === 'legacy live deployment' ? null : deployment.id,
          })
          .where(eq(projects.id, project.id));
        const route = JSON.stringify({
          workerName: `user-${project.slug}-${deployment.id}`,
          projectId: project.id,
          userId: owner.id,
          version: deployment.id,
          limits: { cpuMs: 10, subRequests: 50 },
        });
        await env.ROUTING.put(project.slug, route);
        let missingKey = project.slug;
        if (liveTarget === 'active domain') {
          missingKey = 'domain:negative-route.example.net';
          await env.db.insert(domains).values({
            id: 'negative-route-domain',
            project_id: project.id,
            hostname: 'negative-route.example.net',
            cf_hostname_id: 'cf-negative-route',
            status: 'active',
          });
          await env.ROUTING.put(missingKey, route);
        }
        const cloudflare = accessApi();
        vi.stubGlobal('fetch', cloudflare.fetcher);
        const platform = bindings();
        await configurePlatformZeroTrust(platform, env.db, configurationInput());
        const protectedRoute = (await env.ROUTING.get(missingKey))!;
        expect(JSON.parse(protectedRoute).zeroTrust).toBeTruthy();
        const getSpy = mockKvRead(env.ROUTING, (key) => (key === missingKey ? null : undefined));
        try {
          const cleanup =
            operation === 'public'
              ? setProjectZeroTrustProtection(platform, env.db, project.id, false)
              : disablePlatformZeroTrust(platform, env.db);
          if (operation === 'public') {
            await expect(cleanup).rejects.toThrow('Live routing');
          } else {
            // One project's stale read does not hold the installation disable.
            await expect(cleanup).resolves.toMatchObject({
              enabled: false,
              status: 'ready',
              operation: null,
            });
          }
          expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
            status: 'error',
            routing_cursor: null,
            last_error: expect.stringContaining('Live routing'),
          });
        } finally {
          getSpy.mockRestore();
        }
        expect(await env.ROUTING.get(missingKey)).toBe(protectedRoute);

        await reconcilePendingProjectZeroTrust(platform, env.db);

        expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
          desired_protected: false,
          effective_protected: false,
          status: 'ready',
          routing_cursor: null,
        });
        expect(JSON.parse((await env.ROUTING.get(missingKey))!)).toEqual(JSON.parse(route));
        if (operation === 'disable') {
          expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
            enabled: false,
            lastError: null,
            operation: null,
          });
          expect(cloudflare.applications.size).toBe(0);
        }
      },
    );
  });

  it('does not complete protection while a live slug is hidden by a cached miss', async () => {
    const owner = await createTestUser(env.db, 'negative-enable-owner');
    const project = await createTestProject(env.db, owner.id, 'negative-enable-project');
    const deployment = await createTestDeployment(env.db, project.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: deployment.id })
      .where(eq(projects.id, project.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({
        workerName: `user-${project.slug}-${deployment.id}`,
        projectId: project.id,
        version: deployment.id,
      }),
    );
    vi.stubGlobal('fetch', accessApi().fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput('public'));
    const getSpy = mockKvRead(env.ROUTING, (key) => (key === project.slug ? null : undefined));
    try {
      await expect(
        setProjectZeroTrustProtection(platform, env.db, project.id, true),
      ).rejects.toThrow('Live routing');
    } finally {
      getSpy.mockRestore();
    }
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: true,
      effective_protected: false,
      status: 'error',
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).zeroTrust).toBeUndefined();
    await reconcilePendingProjectZeroTrust(platform, env.db);
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).zeroTrust).toBeTruthy();
  });

  it('does not block undeployed projects or missing pending-domain routes', async () => {
    const owner = await createTestUser(env.db, 'undeployed-route-owner');
    const project = await createTestProject(env.db, owner.id, 'undeployed-route-project');
    await createTestDeployment(env.db, project.id, 'failed');
    await env.db.insert(domains).values({
      id: 'pending-route-domain',
      project_id: project.id,
      hostname: 'pending-route.example.net',
      cf_hostname_id: 'cf-pending-route',
      status: 'pending',
    });
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();

    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    await expect(
      setProjectZeroTrustProtection(platform, env.db, project.id, false),
    ).resolves.toMatchObject({ row: { status: 'ready', desired_protected: false } });
    await expect(disablePlatformZeroTrust(platform, env.db)).resolves.toMatchObject({
      enabled: false,
      status: 'ready',
      operation: null,
    });
    expect(cloudflare.applications.size).toBe(0);
    expect(await env.ROUTING.get(project.slug)).toBeNull();
    expect(await env.ROUTING.get('domain:pending-route.example.net')).toBeNull();
  });

  it.each(['reconciling', 'error'] as const)(
    'keeps completed public routing public when metadata changes during %s cleanup',
    async (state) => {
      const owner = await createTestUser(env.db, 'public-cursor-owner');
      const project = await createTestProject(env.db, owner.id, 'public-cursor-project');
      const deployment = await createTestDeployment(env.db, project.id);
      await env.db
        .update(users)
        .set({ suspended_reason: 'admin_suspended' })
        .where(eq(users.id, owner.id));
      const route = {
        workerName: `user-${project.slug}-${deployment.id}`,
        projectId: project.id,
        userId: owner.id,
        version: deployment.id,
        suspended: 'admin_suspended',
      };
      await env.ROUTING.put(project.slug, JSON.stringify(route));
      vi.stubGlobal('fetch', accessApi().fetcher);
      const platform = bindings();
      await configurePlatformZeroTrust(platform, env.db, configurationInput('public'));
      const domainRows = Array.from({ length: 305 }, (_, index) => ({
        id: `public-cursor-${index}`,
        project_id: project.id,
        hostname: `${String(index).padStart(4, '0')}.cursor.example.net`,
        cf_hostname_id: `cf-public-cursor-${index}`,
        status: 'active' as const,
      }));
      await env.db.insert(domains).values(domainRows);
      const keys = [project.slug, ...domainRows.map((domain) => `domain:${domain.hostname}`)];
      for (const key of keys) {
        await env.ROUTING.put(
          key,
          JSON.stringify({ ...route, zeroTrust: { teamDomain: '', audiences: [] } }),
        );
      }

      const puts = vi.spyOn(env.ROUTING, 'put');
      await setProjectZeroTrustProtection(platform, env.db, project.id, false);
      expect(puts).toHaveBeenCalledTimes(300);
      puts.mockRestore();
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        status: 'reconciling',
        routing_cursor: domainRows[298].hostname,
        bypass_application_id: expect.any(String),
      });
      if (state === 'error') {
        // A failed subsequent page retains the same durable bypass and cursor.
        const getSpy = mockKvRead(env.ROUTING, (key) =>
          key === `domain:${domainRows[299].hostname}` ? null : undefined,
        );
        await reconcilePendingProjectZeroTrust(platform, env.db);
        getSpy.mockRestore();
        expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({ status: state });
      }
      await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
        'public exception is still reconciling',
      );
      await expect(
        resolveProjectZeroTrustRoutingForPublication(env.db, project.id),
      ).resolves.toBeNull();

      await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, owner.id));
      const metadataPuts = vi.spyOn(env.ROUTING, 'put');
      await setProjectsRoutingSuspension(env.ROUTING, env.db, [{ ...project, user_id: owner.id }], {
        op: 'unsuspend',
        matchReason: null,
      });
      expect(metadataPuts).toHaveBeenCalledTimes(keys.length);
      metadataPuts.mockRestore();
      await reconcilePendingProjectZeroTrust(platform, env.db);

      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        routing_cursor: null,
      });
      for (const key of keys) {
        const published = JSON.parse((await env.ROUTING.get(key))!);
        expect(published.version).toBe(deployment.id);
        expect(published.zeroTrust).toBeUndefined();
        expect(published.suspended).toBeUndefined();
      }
    },
  );

  it('keeps public intent denied until its bypass handle is durable', async () => {
    const owner = await createTestUser(env.db, 'missing-bypass-owner');
    const project = await createTestProject(env.db, owner.id, 'missing-bypass-project');
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, configurationInput('public'));
    await env.db
      .update(projectZeroTrust)
      .set({ bypass_application_id: null, status: 'reconciling' })
      .where(eq(projectZeroTrust.project_id, project.id));

    expect(await resolveProjectZeroTrustRoutingForPublication(env.db, project.id)).toEqual({
      teamDomain: '',
      audiences: [],
    });
    await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
      'public exception is still reconciling',
    );
  });
});
