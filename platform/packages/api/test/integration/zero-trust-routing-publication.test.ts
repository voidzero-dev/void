import type { ProjectZeroTrustRouting } from '@void/edge';
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
import { ProjectAccessVerifier } from '../../../dispatch/src/access.ts';
import { deleteProjectCascade, getDomain, getProject } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { tryActivateDomain } from '../../src/provisioning/activate-domain.ts';
import { domains, platformSettings, projectZeroTrust } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
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

function configurationInput() {
  return {
    apiToken: 'test-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
    existingProjects: 'protected' as const,
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

describe('authoritative Zero Trust routing publication', () => {
  it.each([true, false])(
    'activates a domain using database protection=%s despite an older slug route',
    async (protectedProject) => {
      await env.ROUTING.delete('domain:stale-route.example.net');
      const owner = await createTestUser(env.db, 'stale-route-owner');
      const project = await createTestProject(env.db, owner.id, 'stale-route-project');
      const cloudflare = accessApi();
      const platform = bindings();
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(input.toString()).pathname.endsWith('/custom_hostnames/cf-stale-route')) {
          return Response.json({
            success: true,
            result: {
              id: 'cf-stale-route',
              hostname: 'stale-route.example.net',
              status: 'active',
              ssl: { status: 'active', method: 'http', type: 'dv' },
            },
          });
        }
        return cloudflare.fetcher(input, init);
      });
      const metadata = {
        worker: 'live-worker',
        projectId: project.id,
        userId: owner.id,
        customMetadata: { preserve: true },
      };
      const publicRoute = JSON.stringify(metadata);
      await env.ROUTING.put(project.slug, publicRoute);
      await env.db.insert(domains).values({
        id: 'domain-stale-route',
        project_id: project.id,
        hostname: 'stale-route.example.net',
        cf_hostname_id: 'cf-stale-route',
        status: 'pending',
      });
      await configurePlatformZeroTrust(platform, env.db, configurationInput());
      const protectedRoute = (await env.ROUTING.get(project.slug))!;
      expect(JSON.parse(protectedRoute).zeroTrust).toBeTruthy();
      if (!protectedProject) {
        await setProjectZeroTrustProtection(platform, env.db, project.id, false);
      }
      const expectedProtection = await resolveProjectZeroTrustRouting(env.db, project.id);
      const staleRoute = protectedProject ? publicRoute : protectedRoute;
      let staleReads = 0;
      const getSpy = mockKvRead(env.ROUTING, (key) => {
        if (key === project.slug) {
          staleReads += 1;
          // Writes cannot invalidate an older edge read, even under a DB lock.
          return staleRoute;
        }
      });
      try {
        const activated = await tryActivateDomain(
          platform,
          env.db,
          (await getDomain(env.db, 'domain-stale-route'))!,
          (await getProject(env.db, project.id))!,
        );
        expect(activated.activated).toBe(true);
      } finally {
        getSpy.mockRestore();
      }
      expect(staleReads).toBeGreaterThanOrEqual(2);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        desired_protected: protectedProject,
        effective_protected: protectedProject,
        status: 'ready',
      });
      await reconcilePendingProjectZeroTrust(platform, env.db);
      expect((await getDomain(env.db, 'domain-stale-route'))!.status).toBe('active');
      const published = JSON.parse((await env.ROUTING.get('domain:stale-route.example.net'))!);
      expect(published).toEqual({
        ...metadata,
        ...(expectedProtection ? { zeroTrust: expectedProtection } : {}),
      });
      if (protectedProject) {
        expect(published.zeroTrust.audiences).toContainEqual({
          hostname: 'stale-route.example.net',
          audience: (await getProjectZeroTrustState(env.db, project.id))!
            .protected_application_audience,
        });
      } else {
        expect(Object.hasOwn(published, 'zeroTrust')).toBe(false);
      }
    },
  );

  it.each(['reconciling', 'error'] as const)(
    'publishes a deny-all marker for unresolved %s protection without weakening the deployment gate',
    async (state) => {
      const owner = await createTestUser(env.db, 'pending-publication-owner');
      const project = await createTestProject(env.db, owner.id, 'pending-publication-project');
      vi.stubGlobal('fetch', accessApi().fetcher);
      await configurePlatformZeroTrust(bindings(), env.db, configurationInput());
      await env.db
        .update(projectZeroTrust)
        .set({ status: state, effective_protected: false })
        .where(eq(projectZeroTrust.project_id, project.id));

      await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
        'still reconciling',
      );
      const protection = await resolveProjectZeroTrustRoutingForPublication(env.db, project.id);
      expect(protection).toEqual({ teamDomain: '', audiences: [] });
      const rewritten = JSON.parse(
        withProjectZeroTrustRouting(
          JSON.stringify({ worker: 'live-worker', suspended: true }),
          protection,
          project.id,
        ),
      );
      expect(rewritten).toEqual({ worker: 'live-worker', suspended: true, zeroTrust: protection });
      const fetcher = vi.fn<typeof fetch>();
      const verifier = new ProjectAccessVerifier(fetcher);
      await expect(
        verifier.verify(
          'pending-publication-project.apps.example.com',
          'untrusted.assertion.value',
          rewritten.zeroTrust as ProjectZeroTrustRouting,
        ),
      ).resolves.toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('keeps a domain pending while its reused slug still serves the deleted project route', async () => {
    const hostname = 'reused-slug.example.net';
    await env.ROUTING.delete('domain:' + hostname);
    const previousOwner = await createTestUser(env.db, 'reused-slug-previous-owner');
    const previous = await createTestProject(env.db, previousOwner.id, 'reused-slug-project');
    await deleteProjectCascade(env.db, previous.id);
    const owner = await createTestUser(env.db, 'reused-slug-owner');
    const project = await createTestProject(env.db, owner.id, previous.slug);
    const cloudflare = accessApi();
    const platform = bindings();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(input.toString()).pathname.endsWith('/custom_hostnames/cf-reused-slug')) {
        return Response.json({
          success: true,
          result: {
            id: 'cf-reused-slug',
            hostname,
            status: 'active',
            ssl: { status: 'active', method: 'http', type: 'dv' },
          },
        });
      }
      return cloudflare.fetcher(input, init);
    });
    await configurePlatformZeroTrust(platform, env.db, {
      ...configurationInput(),
      protectNewProjects: false,
      existingProjects: 'public',
    });
    await env.db.insert(domains).values({
      id: 'domain-reused-slug',
      project_id: project.id,
      hostname,
      cf_hostname_id: 'cf-reused-slug',
      status: 'pending',
    });
    const previousRoute = JSON.stringify({
      workerName: 'user-' + previous.slug + '-dpl_previous',
      projectId: previous.id,
      userId: previousOwner.id,
      version: 'dpl_previous',
      zeroTrust: {
        teamDomain: 'company.cloudflareaccess.com',
        audiences: [{ hostname: previous.slug + '.apps.example.com', audience: 'aud-previous' }],
      },
    });
    // Each KV read is independent: domain reconciliation can see the missing
    // slug route while the activation copy still sees the deleted project's.
    let slugReads = 0;
    mockKvRead(env.ROUTING, (key) =>
      key === project.slug && ++slugReads > 1 ? previousRoute : undefined,
    );
    const put = vi.spyOn(env.ROUTING, 'put');
    const activated = await tryActivateDomain(
      platform,
      env.db,
      (await getDomain(env.db, 'domain-reused-slug'))!,
      (await getProject(env.db, project.id))!,
    );
    expect(slugReads).toBe(2);
    expect(activated.activated).toBe(false);
    expect(put.mock.calls.some(([key]) => key === 'domain:' + hostname)).toBe(false);
    expect((await getDomain(env.db, 'domain-reused-slug'))!.status).toBe('pending');
  });

  it('publishes a deny-all marker for malformed saved configuration', async () => {
    const owner = await createTestUser(env.db, 'invalid-publication-owner');
    const project = await createTestProject(env.db, owner.id, 'invalid-publication-project');
    await env.db
      .insert(platformSettings)
      .values({ key: 'zeroTrust.configuration', value: { version: 999 } });
    await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
      'unsupported Zero Trust configuration version',
    );
    await expect(resolveProjectZeroTrustRoutingForPublication(env.db, project.id)).resolves.toEqual(
      { teamDomain: '', audiences: [] },
    );
  });

  it('propagates database failures instead of converting them to a publishable route', async () => {
    const failure = new Error('database connection unavailable');
    const executeSpy = vi.spyOn(env.db, 'execute').mockRejectedValueOnce(failure);
    await expect(
      resolveProjectZeroTrustRoutingForPublication(env.db, 'unreadable-project'),
    ).rejects.toBe(failure);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});
