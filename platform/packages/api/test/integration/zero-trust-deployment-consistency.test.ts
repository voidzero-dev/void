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
import { beginDeploymentCutover, getDomain, getProject } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { tryActivateDomain } from '../../src/provisioning/activate-domain.ts';
import { domains } from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import {
  reconcileProjectZeroTrust,
  setProjectZeroTrustProtection,
} from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
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
        return Response.json({ success: true, result: { id } });
      }
      return Response.json({ success: true, result: previous });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

const domainKey = 'domain:deployment-consistency.example.com';
type RouteType = 'static' | 'worker';

async function fixture(type: RouteType, initiallyProtected: boolean) {
  const owner = await createTestUser(env.db, 'route-consistency-owner');
  const project = await createTestProject(env.db, owner.id, 'route-consistency');
  const source = await createTestDeployment(env.db, project.id, 'live');
  const cloudflare = accessApi();
  vi.stubGlobal('fetch', cloudflare.fetcher);
  await env.db.insert(domains).values({
    id: 'dom_consistency',
    project_id: project.id,
    hostname: 'deployment-consistency.example.com',
    cf_hostname_id: 'cf-consistency',
    status: 'active',
  });
  function route(deploymentId: string, protection?: unknown) {
    return JSON.stringify({
      projectId: project.id,
      userId: owner.id,
      version: deploymentId,
      ...(type === 'static'
        ? {
            type: 'static',
            staticDeploymentId: deploymentId,
            assetConfig: { not_found_handling: '404-page' },
          }
        : { type: 'void', workerName: 'user-' + project.slug + '-' + deploymentId }),
      customMetadata: { preserve: true },
      ...(protection ? { zeroTrust: protection } : {}),
    });
  }
  await env.ROUTING.put(project.slug, route(source.id));
  await env.ROUTING.put(domainKey, route(source.id));
  await configurePlatformZeroTrust(bindings(), env.db, {
    apiToken: 'test-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: initiallyProtected,
    existingProjects: initiallyProtected ? 'protected' : 'public',
  });
  const sourceRaw = (await env.ROUTING.get(project.slug))!;
  return {
    project,
    source,
    cloudflare,
    route,
    sourceRaw,
    protection: JSON.parse(sourceRaw).zeroTrust,
  };
}

function staleRead(key: string, raw: string) {
  const originalGet = env.ROUTING.get.bind(env.ROUTING);
  return vi
    .spyOn(env.ROUTING, 'get')
    .mockImplementation((async (candidate: string | Array<string>, ...args: Array<unknown>) =>
      candidate === key
        ? raw
        : Reflect.apply(originalGet, env.ROUTING, [candidate, ...args])) as typeof env.ROUTING.get);
}

async function assertRoutes(projectSlug: string, expectedId: string, protectedProject: boolean) {
  for (const key of [projectSlug, domainKey]) {
    const route = JSON.parse((await env.ROUTING.get(key))!);
    expect(route.version).toBe(expectedId);
    expect(route.customMetadata).toEqual({ preserve: true });
    if (route.staticDeploymentId) {
      expect(route.staticDeploymentId).toBe(expectedId);
    }
    if (route.workerName) {
      expect(route.workerName).toBe('user-' + projectSlug + '-' + expectedId);
    }
    if (protectedProject) {
      expect(route.zeroTrust.audiences.length).toBeGreaterThan(0);
    } else {
      expect(route.zeroTrust).toBeUndefined();
    }
  }
}

describe('Zero Trust deployment route consistency', () => {
  it.each(['static', 'worker'] as const)(
    'accepts a verifiable $type backend when a legacy route omits version',
    async (type) => {
      const { project, route } = await fixture(type, false);
      const committed = await createTestDeployment(env.db, project.id, 'live');
      const entry = JSON.parse(route(committed.id));
      delete entry.version;
      const raw = JSON.stringify(entry);
      await env.ROUTING.put(project.slug, raw);
      await env.ROUTING.put(domainKey, raw);
      await setProjectZeroTrustProtection(bindings(), env.db, project.id, true);
      for (const key of [project.slug, domainKey]) {
        const published = JSON.parse((await env.ROUTING.get(key))!);
        expect(published).toMatchObject(entry);
        expect(published.version).toBeUndefined();
        expect(published.zeroTrust.audiences.length).toBeGreaterThan(0);
      }
    },
  );

  it.each([
    { identity: 'unknown worker', type: 'worker' as const },
    { identity: 'conflicting worker', type: 'worker' as const },
    { identity: 'conflicting static deployment', type: 'static' as const },
  ])(
    'rejects a stale route with $identity identity despite committed B',
    async ({ identity, type }) => {
      const { project, sourceRaw, route } = await fixture(type, false);
      const committed = await createTestDeployment(env.db, project.id, 'live');
      const committedRaw = route(committed.id);
      await env.ROUTING.put(project.slug, committedRaw);
      await env.ROUTING.put(domainKey, committedRaw);
      const staleEntry = JSON.parse(sourceRaw);
      if (identity === 'unknown worker') {
        delete staleEntry.version;
        staleEntry.workerName = 'legacy-worker-without-deployment-id';
      } else {
        // A matching version alone cannot authorize publication of another backend.
        staleEntry.version = committed.id;
      }
      const stale = staleRead(project.slug, JSON.stringify(staleEntry));
      try {
        await expect(
          setProjectZeroTrustProtection(bindings(), env.db, project.id, true),
        ).rejects.toThrow(/routing|deployment/i);
      } finally {
        stale.mockRestore();
      }
      expect(await env.ROUTING.get(project.slug)).toBe(committedRaw);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({ status: 'error' });
      await reconcileProjectZeroTrust(bindings(), env.db, project.id);
      await assertRoutes(project.slug, committed.id, true);
    },
  );

  it.each(
    (['static', 'worker'] as const).flatMap((type) =>
      [true, false].flatMap((protectedAfter) =>
        (['slug', 'domain'] as const).map((surface) => ({ type, protectedAfter, surface })),
      ),
    ),
  )(
    'retains committed $type deployment B when $surface reads A while setting protection=$protectedAfter',
    async ({ type, protectedAfter, surface }) => {
      const { project, sourceRaw, route, protection } = await fixture(type, !protectedAfter);
      const committed = await createTestDeployment(env.db, project.id, 'live');
      const committedRaw = route(committed.id, protection);
      await env.ROUTING.put(project.slug, committedRaw);
      await env.ROUTING.put(domainKey, committedRaw);
      const key = surface === 'slug' ? project.slug : domainKey;
      const stale = staleRead(key, sourceRaw);
      try {
        await expect(
          setProjectZeroTrustProtection(bindings(), env.db, project.id, protectedAfter),
        ).rejects.toThrow(/routing|deployment/i);
      } finally {
        stale.mockRestore();
      }
      expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(committed.id);
      expect(await env.ROUTING.get(key)).toBe(committedRaw);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        desired_protected: protectedAfter,
        status: 'error',
      });
      await reconcileProjectZeroTrust(bindings(), env.db, project.id);
      await assertRoutes(project.slug, committed.id, protectedAfter);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        effective_protected: protectedAfter,
        status: 'ready',
        desired_protected: protectedAfter,
      });
    },
  );

  it.each(
    (['static', 'worker'] as const).flatMap((type) =>
      [true, false].map((staleSource) => ({ type, staleSource })),
    ),
  )(
    'uses in-flight $type cutover B with stale source read=$staleSource',
    async ({ type, staleSource }) => {
      const { project, source, sourceRaw, route } = await fixture(type, false);
      const candidate = await createTestDeployment(env.db, project.id, 'pending');
      expect(await beginDeploymentCutover(env.db, candidate.id)).toBe(true);
      const candidateRaw = route(candidate.id);
      await env.ROUTING.put(project.slug, candidateRaw);
      await env.ROUTING.put(domainKey, candidateRaw);
      const stale = staleSource ? staleRead(project.slug, sourceRaw) : null;
      try {
        if (staleSource) {
          await expect(
            setProjectZeroTrustProtection(bindings(), env.db, project.id, true),
          ).rejects.toThrow(/routing|deployment/i);
        } else {
          await setProjectZeroTrustProtection(bindings(), env.db, project.id, true);
        }
      } finally {
        stale?.mockRestore();
      }
      expect((await getProject(env.db, project.id))!.active_deployment_id).toBe(source.id);
      if (staleSource) {
        expect(await env.ROUTING.get(project.slug)).toBe(candidateRaw);
        expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
          status: 'error',
          desired_protected: true,
        });
        await reconcileProjectZeroTrust(bindings(), env.db, project.id);
      }
      await assertRoutes(project.slug, candidate.id, true);
    },
  );

  it.each(['static', 'worker'] as const)(
    'heals a pending domain with $type source A residue from the verified B slug',
    async (type) => {
      const { project, sourceRaw, route, protection, cloudflare } = await fixture(type, true);
      const committed = await createTestDeployment(env.db, project.id, 'live');
      await env.ROUTING.put(project.slug, route(committed.id, protection));
      await env.ROUTING.put(domainKey, sourceRaw);
      await env.db
        .update(domains)
        .set({ status: 'pending' })
        .where(eq(domains.id, 'dom_consistency'));
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(input.toString()).pathname.endsWith('/custom_hostnames/cf-consistency')) {
          return Response.json({
            success: true,
            result: {
              id: 'cf-consistency',
              hostname: 'deployment-consistency.example.com',
              status: 'active',
              ssl: { status: 'active', method: 'http', type: 'dv' },
            },
          });
        }
        return cloudflare.fetcher(input, init);
      });
      const put = vi.spyOn(env.ROUTING, 'put');
      const result = await tryActivateDomain(
        bindings(),
        env.db,
        (await getDomain(env.db, 'dom_consistency'))!,
        (await getProject(env.db, project.id))!,
      );
      expect(result.activated).toBe(true);
      expect((await getDomain(env.db, 'dom_consistency'))!.status).toBe('active');
      const domainWrites = put.mock.calls.filter(([key]) => key === domainKey);
      expect(domainWrites.length).toBeGreaterThan(0);
      for (const [, value] of domainWrites) {
        expect(JSON.parse(String(value)).version).toBe(committed.id);
      }
      await assertRoutes(project.slug, committed.id, true);
    },
  );
});
