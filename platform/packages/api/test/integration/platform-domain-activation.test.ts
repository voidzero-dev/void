import { PLATFORM_APPLICATION_KEY, PLATFORM_DISABLED_KEY } from '@void/platform';
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
import app, { FAST_CRON, scheduled } from '../../src/index.ts';
import { projects as projectTable } from '../../src/schema.ts';
import {
  readZeroTrustConfigurationStrict,
  zeroTrustConfigurationStatus,
} from '../../src/zero-trust/configuration.ts';
import {
  activatePlatformApplication,
  configurePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import {
  initializeNewProjectZeroTrust,
  setProjectZeroTrustProtection,
} from '../../src/zero-trust/project.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import { zeroTrustStatus } from '../../src/zero-trust/status.ts';
import {
  clearTables,
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
  await env.ROUTING.delete(PLATFORM_APPLICATION_KEY);
  await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const installationId = 'team-123456abcdef';
const original = {
  baseDomain: 'test.workers.dev',
  zoneName: '',
  dedicatedZone: false,
  workersDev: { subdomain: 'test', installationId },
};
const target = {
  ...original,
  baseDomain: 'apps.example.com',
  zoneName: 'example.com',
  zoneId: 'a'.repeat(32),
};
function bindings() {
  return {
    ...env,
    PLATFORM_APPLICATION: JSON.stringify(original),
    PLATFORM_INSTALLATION_ID: installationId,
    PLATFORM_HEALTH_PROBE_TOKEN: 'test-probe',
  } as unknown as ApiEnv['Bindings'];
}
function request(token?: string, application: unknown = target) {
  return new Request('https://api.test.workers.dev/internal/platform/domain-activate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Void-Platform-Probe': token } : {}),
    },
    body: JSON.stringify({ application }),
  });
}

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const requests: Array<Record<string, unknown>> = [];
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
      return Response.json({ success: true, result: { id: 'idp-1', name: 'SSO' } });
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
      const body = JSON.parse(String(init.body));
      const id = `app-${nextId++}`;
      const result = { ...body, id, aud: `aud-${id}` };
      requests.push(result);
      applications.set(id, result);
      return Response.json({ success: true, result });
    }
    if (path === 'apps') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const perPage = Number(url.searchParams.get('per_page') ?? 100);
      return Response.json({
        success: true,
        result: [...applications.values()].slice((page - 1) * perPage, page * perPage),
      });
    }
    const id = path.match(/^apps\/([^/]+)$/)?.[1];
    if (id && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      const result = { ...body, id, aud: applications.get(id)?.aud ?? `aud-${id}` };
      requests.push(result);
      applications.set(id, result);
      return Response.json({ success: true, result });
    }
    if (id && init?.method === 'DELETE') {
      applications.delete(id);
      return Response.json({ success: true, result: { id } });
    }
    if (id) {
      return Response.json({ success: true, result: applications.get(id) });
    }
    throw new Error(`Unexpected Cloudflare request: ${url.pathname}`);
  });
  return { applications, requests, fetcher };
}

describe('installer domain activation', () => {
  it('requires the installer credential and permits a disabled installation', async () => {
    const cloudflare = vi.fn();
    vi.stubGlobal('fetch', cloudflare);
    expect((await app.fetch(request(), bindings())).status).toBe(404);
    expect((await app.fetch(request('wrong'), bindings())).status).toBe(404);
    expect(await env.ROUTING.get(PLATFORM_APPLICATION_KEY)).toBeNull();
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    const response = await app.fetch(request('test-probe'), bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ready: true, installationId });
    expect(JSON.parse((await env.ROUTING.get(PLATFORM_APPLICATION_KEY))!)).toEqual(target);
    expect(cloudflare).not.toHaveBeenCalled();
  });

  it('rejects malformed targets, changed ingress identity and replacement domains', async () => {
    expect(
      (await app.fetch(request('test-probe', { ...target, zoneId: 'bad' }), bindings())).status,
    ).toBe(400);
    expect(
      (
        await app.fetch(
          request('test-probe', {
            ...target,
            workersDev: { ...target.workersDev, subdomain: 'other' },
          }),
          bindings(),
        )
      ).status,
    ).toBe(409);
    expect(await activatePlatformApplication(bindings(), env.db, target)).toEqual({ ready: true });
    expect(
      (
        await app.fetch(
          request('test-probe', { ...target, baseDomain: 'other.example.com' }),
          bindings(),
        )
      ).status,
    ).toBe(409);
    expect(JSON.parse((await env.ROUTING.get(PLATFORM_APPLICATION_KEY))!)).toEqual(target);
  });

  // Exercises several persisted reconciliation batches across more than 100 projects.
  it('resumes a bounded cutover with its saved target and preserves public and protected projects', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const owner = await createTestUser(env.db, 'domain-owner');
    const projects = Array.from({ length: 103 }, (_, index) => ({
      id: `proj_domain${index}`,
      slug: `domain-public-${index}`,
    }));
    await env.db
      .insert(projectTable)
      .values(projects.map((project) => ({ ...project, user_id: owner.id })));
    await Promise.all(
      projects.map((project) =>
        env.ROUTING.put(
          project.slug,
          JSON.stringify({ workerName: 'original-worker', projectId: project.id }),
        ),
      ),
    );
    await configurePlatformZeroTrust(bindings(), env.db, {
      apiToken: 'management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: false,
      existingProjects: 'public',
    });
    for (
      let index = 0;
      index < 8 && (await readZeroTrustConfigurationStrict(env.db))?.operation;
      index++
    ) {
      await reconcilePlatformZeroTrust(bindings(), env.db);
    }
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      lastError: null,
      enabled: true,
    });
    const protectedProject = projects[0]!;
    await setProjectZeroTrustProtection(bindings(), env.db, protectedProject.id, true);
    const ready = await activatePlatformApplication(bindings(), env.db, target);
    expect(ready).toEqual({ ready: false });
    expect(await env.ROUTING.get(PLATFORM_APPLICATION_KEY)).toBeNull();
    expect((await readZeroTrustConfigurationStrict(env.db))?.operation?.applicationTarget).toEqual(
      target,
    );
    await expect(
      setProjectZeroTrustProtection(bindings(), env.db, protectedProject.id, false),
    ).rejects.toThrow('not ready');
    const added = await createTestProject(env.db, owner.id, 'domain-new-public');
    await initializeNewProjectZeroTrust(bindings(), env.db, added.id);
    const newBypass = [...cloudflare.applications.values()].find((application) =>
      JSON.stringify(application).includes('domain-new-public.apps.example.com'),
    );
    expect(newBypass).toBeDefined();
    for (
      let index = 0;
      index < 8 && (await readZeroTrustConfigurationStrict(env.db))?.operation;
      index++
    ) {
      await scheduled(
        { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
        bindings(),
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
    }
    expect(zeroTrustConfigurationStatus((await readZeroTrustConfigurationStrict(env.db))!)).toBe(
      'ready',
    );
    expect(JSON.parse((await env.ROUTING.get(PLATFORM_APPLICATION_KEY))!)).toEqual(target);
    const route = JSON.parse((await env.ROUTING.get(protectedProject.slug))!);
    expect(route.workerName).toBe('original-worker');
    expect(route.zeroTrust.audiences).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostname: '*.apps.example.com' })]),
    );
    for (const project of projects.slice(1)) {
      expect(
        [...cloudflare.applications.values()].some((application) =>
          JSON.stringify(application).includes(`${project.slug}.apps.example.com`),
        ),
      ).toBe(true);
      expect(JSON.parse((await env.ROUTING.get(project.slug))!).zeroTrust).toBeUndefined();
    }
    // Even a request holding old Worker vars must keep the completed target.
    await reconcilePlatformZeroTrust(bindings(), env.db);
    for (
      let index = 0;
      index < 8 && (await readZeroTrustConfigurationStrict(env.db))?.operation;
      index++
    ) {
      await reconcilePlatformZeroTrust(bindings(), env.db);
    }
    const wildcard = (await readZeroTrustConfigurationStrict(env.db))?.wildcardApplication;
    expect(wildcard?.destinations).toContain('*.apps.example.com');
    expect(wildcard?.destinations).toContain(
      'void-123456abcdef-*.' + original.workersDev.subdomain + '.workers.dev',
    );
    expect(await zeroTrustStatus(bindings(), env.db, { check: true })).toMatchObject({
      live: { present: true, drifted: false },
    });
    const requestsBeforeRetry = cloudflare.fetcher.mock.calls.length;
    expect(
      await activatePlatformApplication(bindings(), env.db, {
        ...target,
        workersDev: { installationId, subdomain: original.workersDev.subdomain },
      }),
    ).toEqual({ ready: true });
    expect(cloudflare.fetcher.mock.calls.length).toBe(requestsBeforeRetry);
  }, 30_000);

  it('keeps the domain unpublished while a project the cutover skipped lacks the new hostnames', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const owner = await createTestUser(env.db, 'domain-skip-owner');
    const healthy = await createTestProject(env.db, owner.id, 'domain-skip-healthy');
    const stuck = await createTestProject(env.db, owner.id, 'domain-skip-stuck');
    for (const project of [healthy, stuck]) {
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({ workerName: `${project.slug}-worker`, projectId: project.id }),
      );
    }
    await configurePlatformZeroTrust(bindings(), env.db, {
      apiToken: 'management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'protected',
    });
    // A cached read still returns another project's route, a project-specific
    // failure that the operation skips instead of failing as a whole.
    const stuckRoute = await env.ROUTING.get(stuck.slug);
    await env.ROUTING.put(
      stuck.slug,
      JSON.stringify({ workerName: 'other-worker', projectId: 'proj_other' }),
    );

    expect(await activatePlatformApplication(bindings(), env.db, target)).toEqual({
      ready: false,
    });
    expect(await env.ROUTING.get(PLATFORM_APPLICATION_KEY)).toBeNull();
    const saved = await readZeroTrustConfigurationStrict(env.db);
    expect(saved).toMatchObject({
      lastError: expect.stringContaining(stuck.id),
      operation: { applicationTarget: target, owner: null },
    });
    expect(zeroTrustConfigurationStatus(saved!)).toBe('error');
    expect(await getProjectZeroTrustState(env.db, stuck.id)).toMatchObject({
      status: 'error',
      reconciled_operation: null,
    });
    expect(JSON.parse((await env.ROUTING.get(healthy.slug))!).zeroTrust.audiences).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostname: '*.apps.example.com' })]),
    );

    // The two-minute tier leaves the failed run alone.
    await scheduled(
      { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
      bindings(),
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(await env.ROUTING.get(PLATFORM_APPLICATION_KEY)).toBeNull();

    await env.ROUTING.put(stuck.slug, stuckRoute!);
    expect(await activatePlatformApplication(bindings(), env.db, target)).toEqual({ ready: true });
    expect(JSON.parse((await env.ROUTING.get(PLATFORM_APPLICATION_KEY))!)).toEqual(target);
    expect(await getProjectZeroTrustState(env.db, stuck.id)).toMatchObject({
      status: 'ready',
      effective_protected: true,
    });
    expect(JSON.parse((await env.ROUTING.get(stuck.slug))!).zeroTrust.audiences).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostname: '*.apps.example.com' })]),
    );
  });

  it('keeps the domain unpublished on provider failure and reconciles protected projects created before retry', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const owner = await createTestUser(env.db, 'domain-protected-owner');
    const project = await createTestProject(env.db, owner.id, 'domain-protected');
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'preserved-worker', projectId: project.id }),
    );
    const input = {
      apiToken: 'management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'protected' as const,
    };
    await configurePlatformZeroTrust(bindings(), env.db, input);
    const previousRoute = await env.ROUTING.get(project.slug);
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT' && String(init.body).includes('apps.example.com')) {
        return Response.json({ success: false, errors: [{ message: 'denied' }] }, { status: 403 });
      }
      return cloudflare.fetcher(url, init);
    });
    await expect(activatePlatformApplication(bindings(), env.db, target)).rejects.toThrow();
    expect(await env.ROUTING.get(PLATFORM_APPLICATION_KEY)).toBeNull();
    expect(await env.ROUTING.get(project.slug)).toBe(previousRoute);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      lastError: expect.any(String),
      operation: { applicationTarget: target, owner: null },
    });
    const added = await createTestProject(env.db, owner.id, 'domain-new-protected');
    expect(await initializeNewProjectZeroTrust(bindings(), env.db, added.id)).toMatchObject({
      desired_protected: true,
      effective_protected: false,
      status: 'reconciling',
    });
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const { existingProjects: _existingProjects, ...replacement } = input;
    await expect(
      configurePlatformZeroTrust(bindings(), env.db, { ...replacement, protectNewProjects: false }),
    ).rejects.toThrow('saved Zero Trust operation');
    expect(await activatePlatformApplication(bindings(), env.db, target)).toEqual({ ready: true });
    expect(await getProjectZeroTrustState(env.db, added.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    expect(JSON.parse((await env.ROUTING.get(PLATFORM_APPLICATION_KEY))!)).toEqual(target);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).zeroTrust.audiences).toEqual(
      expect.arrayContaining([expect.objectContaining({ hostname: '*.apps.example.com' })]),
    );
  });
});
