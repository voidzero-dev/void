import { eq, isNull } from 'drizzle-orm';
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
import { FAST_MAINTENANCE_KEY } from '../../src/fast-maintenance.ts';
import { FAST_CRON, scheduled } from '../../src/index.ts';
import {
  domains,
  platformSettings,
  projects as projectTable,
  projectZeroTrust,
} from '../../src/schema.ts';
import {
  readZeroTrustConfigurationStrict,
  type ZeroTrustConfigureInput,
} from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import {
  cleanupProjectZeroTrust,
  initializeNewProjectZeroTrust,
  setProjectZeroTrustProtection,
} from '../../src/zero-trust/project.ts';
import { resolveProjectZeroTrustRouting } from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import { zeroTrustStatus } from '../../src/zero-trust/status.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
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
  await clearTables(env.db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function platformBindings(): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
  } as unknown as ApiEnv['Bindings'];
}

const PROTECTED_CONFIGURATION: ZeroTrustConfigureInput = {
  apiToken: 'access-management-token',
  identityProviderIds: ['idp-1'],
  policyIds: ['policy-1'],
  protectNewProjects: true,
  existingProjects: 'protected',
};

function accessApi(options?: {
  beforeCreateApplication?: (application: Record<string, unknown>) => Promise<void> | void;
}) {
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
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1', name: 'Company SSO' } });
    }
    if (path === 'policies/policy-1' || path === 'policies/policy-2') {
      const id = path.split('/').at(-1)!;
      return Response.json({
        success: true,
        result: {
          id,
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        },
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      await options?.beforeCreateApplication?.(body);
      if ([...applications.values()].some((app) => app.domain === body.domain)) {
        return Response.json(
          { success: false, errors: [{ message: 'access.api.error.application_already_exists' }] },
          { status: 409 },
        );
      }
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
    const policyMatch = path.match(/^apps\/([^/]+)\/policies$/);
    if (policyMatch) {
      return Response.json({
        success: true,
        result: applications.get(policyMatch[1]!)?.policies ?? [],
      });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const previous = applications.get(match[1]!);
      const application = { ...body, id: match[1], aud: previous?.aud ?? `aud-${match[1]}` };
      applications.set(match[1]!, application);
      return Response.json({ success: true, result: application });
    }
    if (match && init?.method === 'DELETE') {
      applications.delete(match[1]!);
      return Response.json({ success: true, result: { id: match[1] } });
    }
    if (match) {
      const application = applications.get(match[1]!);
      return application
        ? Response.json({ success: true, result: application })
        : Response.json(
            { success: false, errors: [{ message: 'application not found' }] },
            { status: 404 },
          );
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

describe('project Zero Trust reconciliation', () => {
  it('resumes using the installer health exception, protects existing and new projects, and preserves it on disable', async () => {
    let failWildcard = true;
    const cloudflare = accessApi({
      beforeCreateApplication: (app) => {
        if (failWildcard && app.domain === '*.apps.example.com') {
          throw new Error('interrupted wildcard creation');
        }
      },
    });
    const existing = {
      id: 'installer-health',
      name: 'void-installation-health-dispatch-nonce',
      aud: 'installer-audience',
      type: 'self_hosted',
      domain: 'void-platform-health.apps.example.com/health',
      destinations: [{ type: 'public', uri: 'void-platform-health.apps.example.com/health' }],
      session_duration: '24h',
      policies: [{ decision: 'bypass', include: [{ everyone: {} }], require: [], exclude: [] }],
    };
    cloudflare.applications.set(existing.id, existing);
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    const owner = await createTestUser(env.db, 'installer-health-owner');
    const project = await createTestProject(env.db, owner.id, 'existing-protected-app');
    await expect(
      configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION),
    ).rejects.toThrow('interrupted wildcard creation');
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      operation: { phase: 'wildcard' },
      healthApplication: null,
    });

    failWildcard = false;
    await reconcilePlatformZeroTrust(bindings, env.db);
    const configured = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(configured.operation).toBeNull();
    expect(configured.healthApplication).toMatchObject({ id: existing.id, name: existing.name });
    expect(configured.healthApplicationName).not.toBe(existing.name);
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    const newProject = await createTestProject(env.db, owner.id, 'new-protected-app');
    await initializeNewProjectZeroTrust(bindings, env.db, newProject.id);
    expect(await getProjectZeroTrustState(env.db, newProject.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    await expect(zeroTrustStatus(bindings, env.db, { check: true })).resolves.toMatchObject({
      live: { present: true, drifted: false },
    });

    await reconcilePlatformZeroTrust(bindings, env.db);
    await disablePlatformZeroTrust(bindings, env.db);
    expect(cloudflare.applications.get(existing.id)).toEqual(existing);
    expect(
      cloudflare.fetcher.mock.calls.some(
        ([input, init]) => init?.method && input.toString().includes(`/apps/${existing.id}`),
      ),
    ).toBe(false);
    expect(cloudflare.applications.size).toBe(1);
  });

  it('fails closed when saved routing configuration is malformed', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-malformed-owner');
    const project = await createTestProject(env.db, owner.id, 'zero-trust-malformed-app');
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    await env.db.insert(platformSettings).values({
      key: 'zeroTrust.configuration',
      value: { version: 999 },
    });

    await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
      'unsupported Zero Trust configuration version',
    );
  });

  it('rejects an existing-project selection on a resumed reconcile operation', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);
    const configuration = (await readZeroTrustConfigurationStrict(env.db))!;
    await env.db
      .update(platformSettings)
      .set({
        value: {
          ...configuration,
          operation: {
            id: 'reconcile-operation',
            kind: 'reconcile',
            phase: 'seed',
            owner: null,
            leaseExpiresAt: null,
            startedAt: new Date().toISOString(),
            existingProjects: 'protected',
          },
        },
      })
      .where(eq(platformSettings.key, 'zeroTrust.configuration'));

    await expect(readZeroTrustConfigurationStrict(env.db)).rejects.toThrow(
      'Zero Trust existing-project selection is inconsistent',
    );
  });

  it('blocks routing while enabled project protection state is missing or incomplete', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-routing-guard-owner');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);

    const missing = await createTestProject(env.db, owner.id, 'zero-trust-missing-state');
    await expect(resolveProjectZeroTrustRouting(env.db, missing.id)).rejects.toThrow(
      'still being initialized',
    );

    const incomplete = await createTestProject(env.db, owner.id, 'zero-trust-incomplete-state');
    await env.db.insert(projectZeroTrust).values({
      project_id: incomplete.id,
      desired_protected: true,
      effective_protected: false,
      status: 'reconciling',
    });
    await expect(resolveProjectZeroTrustRouting(env.db, incomplete.id)).rejects.toThrow(
      'still reconciling',
    );
  });

  it('keeps protected routing until the project disable batch processes it', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-disable-routing-owner');
    const project = await createTestProject(env.db, owner.id, 'zero-trust-disable-routing');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);
    const configuration = (await readZeroTrustConfigurationStrict(env.db))!;
    await env.db
      .update(platformSettings)
      .set({
        value: {
          ...configuration,
          operation: {
            id: 'disable-operation',
            kind: 'disable',
            phase: 'projects',
            owner: null,
            leaseExpiresAt: null,
            startedAt: new Date().toISOString(),
            existingProjects: null,
          },
        },
      })
      .where(eq(platformSettings.key, 'zeroTrust.configuration'));

    await expect(resolveProjectZeroTrustRouting(env.db, project.id)).resolves.toMatchObject({
      teamDomain: 'https://company.cloudflareaccess.com',
      audiences: [
        {
          hostname: '*.apps.example.com',
          audience: expect.stringMatching(/^aud-app-/),
        },
      ],
    });
  });

  it('reports wildcard drift when the platform application domain changes', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);

    await expect(
      zeroTrustStatus({ ...bindings, SITE_DOMAIN: 'new.example.com' }, env.db, { check: true }),
    ).resolves.toMatchObject({ checked: true, live: { present: true, drifted: true } });
    cloudflare.fetcher.mockClear();
    // Reads use saved state unless an operator asks for the live check.
    await expect(
      zeroTrustStatus({ ...bindings, SITE_DOMAIN: 'new.example.com' }, env.db),
    ).resolves.toMatchObject({ enabled: true, status: 'ready', checked: false, live: null });
    expect(cloudflare.fetcher).not.toHaveBeenCalled();
  });

  it('keeps the platform health hostname outside the wildcard for its whole lifetime', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    const applicationWrites = () =>
      cloudflare.fetcher.mock.calls
        .filter(([, init]) => init?.method === 'POST' || init?.method === 'DELETE')
        .map(([input, init]) => ({
          method: init!.method,
          domain: init?.body
            ? (JSON.parse(String(init.body)) as { domain: string }).domain
            : new URL(input.toString()).pathname.split('/').at(-1),
        }));

    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);

    const configured = (await readZeroTrustConfigurationStrict(env.db))!;
    const health = configured.healthApplication!;
    expect(health).toMatchObject({
      name: configured.healthApplicationName,
      destinations: ['void-platform-health.apps.example.com/health'],
    });
    expect(health.name).toMatch(/-platform-health$/);
    // Only the probe path is exempt; the rest of the hostname stays under the wildcard.
    expect(cloudflare.applications.get(health.id)).toMatchObject({
      domain: 'void-platform-health.apps.example.com/health',
      destinations: [{ type: 'public', uri: 'void-platform-health.apps.example.com/health' }],
      policies: [{ decision: 'bypass', include: [{ everyone: {} }] }],
    });
    // The exception exists before the wildcard covers its hostname.
    expect(applicationWrites()).toEqual([
      { method: 'POST', domain: 'void-platform-health.apps.example.com/health' },
      { method: 'POST', domain: '*.apps.example.com' },
    ]);
    await expect(zeroTrustStatus(bindings, env.db, { check: true })).resolves.toMatchObject({
      live: { present: true, drifted: false },
    });

    cloudflare.applications.delete(health.id);
    await expect(zeroTrustStatus(bindings, env.db, { check: true })).resolves.toMatchObject({
      live: { present: false, drifted: true },
    });
    await reconcilePlatformZeroTrust(bindings, env.db);
    const restored = (await readZeroTrustConfigurationStrict(env.db))!.healthApplication!;
    expect(restored.name).toBe(health.name);
    expect(cloudflare.applications.get(restored.id)).toMatchObject({
      domain: 'void-platform-health.apps.example.com/health',
    });

    cloudflare.fetcher.mockClear();
    await disablePlatformZeroTrust(bindings, env.db);
    const { wildcardApplication } = configured;
    // The exception outlives the wildcard.
    expect(applicationWrites()).toEqual([
      { method: 'DELETE', domain: wildcardApplication!.id },
      { method: 'DELETE', domain: restored.id },
    ]);
    expect(cloudflare.applications.size).toBe(0);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      healthApplication: null,
      healthApplicationName: health.name,
    });
  });

  it('adds the health exception to a configuration saved before it existed', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);
    const {
      healthApplication,
      healthApplicationName: _name,
      ...legacy
    } = (await readZeroTrustConfigurationStrict(env.db))!;
    cloudflare.applications.delete(healthApplication!.id);
    await env.db
      .update(platformSettings)
      .set({ value: legacy })
      .where(eq(platformSettings.key, 'zeroTrust.configuration'));
    await expect(readZeroTrustConfigurationStrict(env.db)).resolves.toMatchObject({
      healthApplicationName: null,
      healthApplication: null,
    });

    await reconcilePlatformZeroTrust(bindings, env.db);

    const repaired = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(repaired.healthApplicationName).toMatch(/-platform-health$/);
    expect(repaired.healthApplication).toMatchObject({
      name: repaired.healthApplicationName,
      destinations: ['void-platform-health.apps.example.com/health'],
    });
    expect(cloudflare.applications.has(repaired.healthApplication!.id)).toBe(true);
  });

  it('narrows a health exception that covers the whole hostname', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);
    const configured = (await readZeroTrustConfigurationStrict(env.db))!;
    const health = configured.healthApplication!;
    // An exception saved for the whole hostname would leave every project path
    // on it outside Access.
    const hostOnly = 'void-platform-health.apps.example.com';
    cloudflare.applications.set(health.id, {
      ...cloudflare.applications.get(health.id),
      domain: hostOnly,
      destinations: [{ type: 'public', uri: hostOnly }],
    });
    await env.db
      .update(platformSettings)
      .set({ value: { ...configured, healthApplication: { ...health, destinations: [hostOnly] } } })
      .where(eq(platformSettings.key, 'zeroTrust.configuration'));

    await expect(zeroTrustStatus(bindings, env.db, { check: true })).resolves.toMatchObject({
      live: { present: true, drifted: true },
    });

    cloudflare.fetcher.mockClear();
    await reconcilePlatformZeroTrust(bindings, env.db);
    // Updated in place, so the application keeps its id and audience.
    expect(
      cloudflare.fetcher.mock.calls.some(
        ([input, init]) =>
          init?.method === 'PUT' && input.toString().endsWith(`/apps/${health.id}`),
      ),
    ).toBe(true);
    expect(cloudflare.applications.get(health.id)).toMatchObject({
      domain: 'void-platform-health.apps.example.com/health',
      destinations: [{ type: 'public', uri: 'void-platform-health.apps.example.com/health' }],
    });
    expect((await readZeroTrustConfigurationStrict(env.db))!.healthApplication).toEqual({
      ...health,
      destinations: ['void-platform-health.apps.example.com/health'],
    });
    await expect(zeroTrustStatus(bindings, env.db, { check: true })).resolves.toMatchObject({
      live: { present: true, drifted: false },
    });
  });

  it('creates no health exception for a workers.dev-only installation', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = {
      ...env,
      SITE_DOMAIN: 'test-account.workers.dev',
      PLATFORM_INSTALLATION_ID: 'example-123456abcdef',
      PLATFORM_APPLICATION: JSON.stringify({
        baseDomain: 'test-account.workers.dev',
        zoneName: '',
        dedicatedZone: false,
        workersDev: { subdomain: 'test-account', installationId: 'example-123456abcdef' },
      }),
    } as unknown as ApiEnv['Bindings'];
    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);
    expect((await readZeroTrustConfigurationStrict(env.db))!.healthApplication).toBeNull();
    expect([...cloudflare.applications.values()].map((application) => application.domain)).toEqual([
      'void-123456abcdef-*.test-account.workers.dev',
    ]);
  });

  // Exercises several persisted reconciliation batches across more than 100 projects.
  it('bounds installation work and resumes it on the fast maintenance tier', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-bounded-owner');
    await env.db.insert(projectTable).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `proj_bounded${index}`,
        user_id: owner.id,
        slug: `zero-trust-bounded-${index}`,
      })),
    );
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();

    const initial = await configurePlatformZeroTrust(bindings, env.db, {
      apiToken: 'access-management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'public',
    });
    expect(initial).toMatchObject({
      status: 'configuring',
      operation: { kind: 'configure', phase: 'seed' },
    });
    const [unseeded] = await env.db
      .select({ id: projectTable.id })
      .from(projectTable)
      .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projectTable.id))
      .where(isNull(projectZeroTrust.project_id))
      .limit(1);
    expect(unseeded).toBeDefined();
    await expect(
      initializeNewProjectZeroTrust(bindings, env.db, unseeded!.id),
    ).resolves.toMatchObject({ desired_protected: false, status: 'reconciling' });

    // Configuration is saved by an operator request, which arms the fast tier.
    await env.ROUTING.put(FAST_MAINTENANCE_KEY, 'armed');
    const controller = {
      cron: FAST_CRON,
      scheduledTime: Date.now(),
    } as ScheduledController;
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    await scheduled(controller, bindings, context);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      lastError: null,
      operation: { kind: 'configure', phase: 'public-bypasses' },
    });

    // Public projects finish in the public-bypass phase, so the projects
    // phase has nothing left to repeat and the operation completes.
    await scheduled(controller, bindings, context);
    const completed = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(completed).toMatchObject({ lastError: null, operation: null });
    const bypassWrites = new Map<string, number>();
    for (const [input, init] of cloudflare.fetcher.mock.calls) {
      if ((init?.method === 'POST' || init?.method === 'PUT') && String(input).includes('/apps')) {
        const name = String(JSON.parse(String(init.body)).name);
        if (name.includes('-public-')) {
          bypassWrites.set(name, (bypassWrites.get(name) ?? 0) + 1);
        }
      }
    }
    expect(bypassWrites.size).toBe(101);
    // Only the project initialized during the operation is written twice:
    // once at creation and once by the operation batch.
    expect([...bypassWrites.values()].filter((count) => count > 1)).toHaveLength(1);
    expect(
      await env.db
        .select({ id: projectZeroTrust.project_id })
        .from(projectZeroTrust)
        .where(isNull(projectZeroTrust.reconciled_operation)),
    ).toEqual([]);
  }, 10_000);

  it('creates public exceptions before the wildcard app and preserves owner opt-outs on reconfigure', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-owner');
    const protectedProject = await createTestProject(env.db, owner.id, 'protected-app');
    const publicProject = await createTestProject(env.db, owner.id, 'public-app');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();

    await configurePlatformZeroTrust(bindings, env.db, {
      apiToken: 'access-management-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      existingProjects: 'public',
    });

    expect(await getProjectZeroTrustState(env.db, protectedProject.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
    });
    expect(await getProjectZeroTrustState(env.db, publicProject.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
    });
    expect(
      [...cloudflare.applications.values()].filter((application) =>
        String(application.name).includes('-public-'),
      ),
    ).toHaveLength(2);
    expect(
      [...cloudflare.applications.values()].some((application) =>
        String(application.domain).startsWith('*.'),
      ),
    ).toBe(true);
    expect(
      [...cloudflare.applications.values()].find((application) =>
        String(application.domain).startsWith('*.'),
      )?.name,
    ).toMatch(/^void-installation-test-[a-f0-9]{16}-[a-f0-9]{32}-project-zero-trust$/);

    await setProjectZeroTrustProtection(bindings, env.db, protectedProject.id, true);
    expect(await getProjectZeroTrustState(env.db, protectedProject.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });

    await configurePlatformZeroTrust(bindings, env.db, {
      apiToken: 'replacement-access-token',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-2'],
      protectNewProjects: false,
    });

    expect(await getProjectZeroTrustState(env.db, protectedProject.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    expect(await getProjectZeroTrustState(env.db, publicProject.id)).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
    });
    expect(
      [...cloudflare.applications.values()].find((application) =>
        String(application.domain).startsWith('*.'),
      )?.policies,
    ).toEqual([{ id: 'policy-2', precedence: 1 }]);
  });

  it('serializes a newer protected intent behind an in-flight public transition', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-race-owner');
    const project = await createTestProject(env.db, owner.id, 'zero-trust-race-app');
    await env.db.insert(domains).values({
      id: 'domain-zero-trust-race',
      project_id: project.id,
      hostname: 'race.example.com',
      cf_hostname_id: 'cf-domain-zero-trust-race',
      status: 'active',
    });
    await env.ROUTING.put(project.slug, JSON.stringify({ worker: 'test' }));
    await env.ROUTING.put('domain:race.example.com', JSON.stringify({ worker: 'test' }));

    let releaseBypassCreation = () => {};
    const bypassCreationReleased = new Promise<void>((resolve) => {
      releaseBypassCreation = resolve;
    });
    let reportBypassCreation = () => {};
    const bypassCreationStarted = new Promise<void>((resolve) => {
      reportBypassCreation = resolve;
    });
    const cloudflare = accessApi({
      beforeCreateApplication: async (application) => {
        if (String(application.name).includes('-public-')) {
          reportBypassCreation();
          await bypassCreationReleased;
        }
      },
    });
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const bindings = platformBindings();

    await configurePlatformZeroTrust(bindings, env.db, PROTECTED_CONFIGURATION);

    const publicTransition = setProjectZeroTrustProtection(bindings, env.db, project.id, false);
    await bypassCreationStarted;

    const protectedTransition = setProjectZeroTrustProtection(bindings, env.db, project.id, true);
    releaseBypassCreation();

    await expect(publicTransition).resolves.toMatchObject({
      row: { status: 'ready', desired_protected: false },
    });
    await expect(protectedTransition).resolves.toMatchObject({
      row: { status: 'ready', desired_protected: true },
    });
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
      bypass_application_id: null,
      bypass_application_name: null,
    });
    expect(
      [...cloudflare.applications.values()].some((application) =>
        String(application.name).includes('-public-'),
      ),
    ).toBe(false);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      zeroTrust: {
        teamDomain: 'https://company.cloudflareaccess.com',
        audiences: [
          {
            hostname: '*.apps.example.com',
            audience: expect.stringMatching(/^aud-app-/),
          },
          {
            hostname: 'race.example.com',
            audience: expect.stringMatching(/^aud-app-/),
          },
        ],
      },
    });
    expect(JSON.parse((await env.ROUTING.get('domain:race.example.com'))!)).toMatchObject({
      zeroTrust: {
        audiences: expect.arrayContaining([
          {
            hostname: 'race.example.com',
            audience: expect.stringMatching(/^aud-app-/),
          },
        ]),
      },
    });
  });

  it('preserves cleanup handles when the management configuration is unavailable', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-cleanup-owner');
    const project = await createTestProject(env.db, owner.id, 'zero-trust-cleanup-app');
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: false,
      effective_protected: false,
      status: 'reconciling',
      bypass_application_id: 'app-cleanup',
      bypass_application_name: 'void-installation-public-cleanup',
    });

    await expect(
      cleanupProjectZeroTrust(env as unknown as ApiEnv['Bindings'], env.db, project.id),
    ).rejects.toThrow('managed Access applications cannot be safely deleted');
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      bypass_application_id: 'app-cleanup',
    });
  });
});
