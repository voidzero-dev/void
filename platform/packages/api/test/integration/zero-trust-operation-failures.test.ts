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
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as db from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { FAST_MAINTENANCE_KEY } from '../../src/fast-maintenance.ts';
import app, { FAST_CRON, scheduled } from '../../src/index.ts';
import { domains, platformSettings, projectZeroTrust } from '../../src/schema.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as zeroTrustConfiguration from '../../src/zero-trust/configuration.ts';
import { readZeroTrustConfigurationStrict } from '../../src/zero-trust/configuration.ts';
import type { ZeroTrustConfigureInput } from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as zeroTrustLock from '../../src/zero-trust/lock.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as zeroTrustProject from '../../src/zero-trust/project.ts';
import {
  reconcileProjectZeroTrust,
  reconcileProjectZeroTrustDomains,
  setProjectZeroTrustProtection,
} from '../../src/zero-trust/project.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
} from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createMockExecutionContext,
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

function bindings(overrides: Record<string, unknown> = {}): ApiEnv['Bindings'] {
  return {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
    ...overrides,
  } as unknown as ApiEnv['Bindings'];
}

function configurationInput(
  overrides: Partial<ZeroTrustConfigureInput> = {},
): ZeroTrustConfigureInput {
  return {
    apiToken: 'access-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: false,
    existingProjects: 'public',
    ...overrides,
  };
}

function providerError(message: string, status: number): Response {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  let revoked = false;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (!url.pathname.includes('/access/')) {
      return providerError('unexpected Cloudflare request', 500);
    }
    if (revoked) {
      return providerError('Access token was revoked', 401);
    }
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
    throw new Error(`unexpected Access request: ${url}`);
  });
  const accessCalls = () =>
    fetcher.mock.calls.filter(([input]) => String(input).includes('/access/')).length;
  return {
    applications,
    fetcher,
    accessCalls,
    revoke(value: boolean) {
      revoked = value;
    },
  };
}

/** Save a running operation owned by another request, as its runner would. */
async function startForeignOperation(): Promise<void> {
  const saved = (await readZeroTrustConfigurationStrict(env.db))!;
  await env.db
    .update(platformSettings)
    .set({
      value: {
        ...saved,
        revision: saved.revision + 1,
        operation: {
          id: 'foreign-operation',
          kind: 'reconcile',
          phase: 'projects',
          owner: 'foreign-runner',
          leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          startedAt: new Date().toISOString(),
          existingProjects: null,
        },
      },
    })
    .where(eq(platformSettings.key, 'zeroTrust.configuration'));
}

/** Advance the saved revision after the next unlocked read, as an operation heartbeat does. */
function heartbeatAfterFirstRead(): void {
  const read = zeroTrustConfiguration.readZeroTrustConfigurationStrict;
  let bumped = false;
  vi.spyOn(zeroTrustConfiguration, 'readZeroTrustConfigurationStrict').mockImplementation(
    async (...args) => {
      const result = await read(...args);
      if (!bumped && result) {
        bumped = true;
        await env.db
          .update(platformSettings)
          .set({ value: { ...result, revision: result.revision + 1 } })
          .where(eq(platformSettings.key, 'zeroTrust.configuration'));
      }
      return result;
    },
  );
}

describe('Zero Trust operation failures', () => {
  it('leaves a failed operation to the hourly tier without starving fast maintenance', async () => {
    const owner = await createTestUser(env.db, 'fast-tier-owner');
    await createTestProject(env.db, owner.id, 'fast-tier-project');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    const saved = (await readZeroTrustConfigurationStrict(env.db))!;
    await env.db
      .update(platformSettings)
      .set({
        value: {
          ...saved,
          revision: saved.revision + 1,
          operation: {
            id: 'resumable-operation',
            kind: 'reconcile',
            phase: 'seed',
            owner: null,
            leaseExpiresAt: null,
            startedAt: new Date().toISOString(),
            existingProjects: null,
          },
        },
      })
      .where(eq(platformSettings.key, 'zeroTrust.configuration'));
    cloudflare.revoke(true);
    await env.ROUTING.put(FAST_MAINTENANCE_KEY, 'armed');
    const pendingDomains = vi.spyOn(db, 'getPendingDomainsNewerThan');
    const fast = () =>
      scheduled(
        { cron: FAST_CRON, scheduledTime: Date.now() } as ScheduledController,
        platform,
        createMockExecutionContext(),
      );

    await fast();
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      lastError: expect.stringContaining('Access token was revoked'),
      operation: { id: 'resumable-operation', owner: null },
    });
    expect(pendingDomains).toHaveBeenCalledTimes(1);
    const failedCalls = cloudflare.accessCalls();
    expect(failedCalls).toBeGreaterThan(0);

    await fast();
    expect(cloudflare.accessCalls()).toBe(failedCalls);
    expect(pendingDomains).toHaveBeenCalledTimes(2);

    cloudflare.revoke(false);
    await scheduled(
      { cron: '0 * * * *', scheduledTime: Date.now() } as ScheduledController,
      platform,
      createMockExecutionContext(),
    );
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      lastError: null,
      operation: null,
    });
  });

  it('finishes configuration around a project over the protected domain cap', async () => {
    const owner = await createTestUser(env.db, 'domain-cap-owner');
    const large = await createTestProject(env.db, owner.id, 'domain-cap-large');
    const small = await createTestProject(env.db, owner.id, 'domain-cap-small');
    await env.db.insert(domains).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `domain-cap-${index}`,
        project_id: large.id,
        hostname: `cap-${index}.example.net`,
        cf_hostname_id: `cf-domain-cap-${index}`,
        status: 'pending' as const,
      })),
    );
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();

    await expect(
      configurePlatformZeroTrust(
        platform,
        env.db,
        configurationInput({ existingProjects: 'protected', protectNewProjects: true }),
      ),
    ).resolves.toMatchObject({ enabled: true, status: 'ready', operation: null });

    expect(await getProjectZeroTrustState(env.db, small.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    expect(await getProjectZeroTrustState(env.db, large.id)).toMatchObject({
      desired_protected: true,
      effective_protected: false,
      status: 'error',
      last_error: expect.stringContaining('at most 100 custom domains'),
    });
    // The skipped project wants protection, so every route writer denies it.
    await expect(resolveProjectZeroTrustRouting(env.db, large.id)).rejects.toThrow(
      'still reconciling',
    );
    await expect(resolveProjectZeroTrustRoutingForPublication(env.db, large.id)).resolves.toEqual({
      teamDomain: '',
      audiences: [],
    });
  });

  it('does not skip a failed project for an operation a newer one replaced', async () => {
    const owner = await createTestUser(env.db, 'replaced-skip-owner');
    const large = await createTestProject(env.db, owner.id, 'replaced-skip-large');
    await env.db.insert(domains).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `replaced-skip-${index}`,
        project_id: large.id,
        hostname: `replaced-skip-${index}.example.net`,
        cf_hostname_id: `cf-replaced-skip-${index}`,
        status: 'pending' as const,
      })),
    );
    vi.stubGlobal('fetch', accessApi().fetcher);
    const platform = bindings();
    const reconcile = zeroTrustProject.reconcileProjectZeroTrust;
    const lock = zeroTrustLock.withProjectZeroTrustLock;
    let stepFailed = false;
    let replaced = false;
    vi.spyOn(zeroTrustProject, 'reconcileProjectZeroTrust').mockImplementation(async (...args) => {
      try {
        return await reconcile(...args);
      } catch (error) {
        stepFailed ||= args[2] === large.id;
        throw error;
      }
    });
    // Between the failed step and the skip, this operation's lease expires. A
    // newer operation claims the installation and reconciles the project.
    vi.spyOn(zeroTrustLock, 'withProjectZeroTrustLock').mockImplementation(async (...args) => {
      if (stepFailed && !replaced && args[1] === large.id) {
        replaced = true;
        await env.db
          .delete(domains)
          .where(sql`${domains.project_id} = ${large.id} AND ${domains.id} <> 'replaced-skip-0'`);
        const saved = (await readZeroTrustConfigurationStrict(env.db))!;
        const newer = {
          ...saved,
          revision: saved.revision + 1,
          operation: {
            ...saved.operation!,
            id: 'newer-operation',
            kind: 'reconcile' as const,
            phase: 'projects' as const,
            owner: 'newer-runner',
            existingProjects: null,
            leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          },
        };
        await env.db
          .update(platformSettings)
          .set({ value: newer })
          .where(eq(platformSettings.key, 'zeroTrust.configuration'));
        await reconcile(platform, env.db, large.id, {
          configuration: newer,
          routingBudget: { remaining: 300 },
        });
      }
      return lock(...args);
    });

    await expect(
      configurePlatformZeroTrust(
        platform,
        env.db,
        configurationInput({ existingProjects: 'protected', protectNewProjects: true }),
      ),
    ).rejects.toThrow('at most 100 custom domains');

    expect(replaced).toBe(true);
    expect(await getProjectZeroTrustState(env.db, large.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
      reconciled_operation: 'newer-operation',
      last_error: null,
    });
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      operation: { id: 'newer-operation', owner: 'newer-runner' },
    });
  });

  it('moves a scheduled retry that fails at the checkpoint behind other pending projects', async () => {
    const owner = await createTestUser(env.db, 'retry-order-owner');
    const large = await createTestProject(env.db, owner.id, 'retry-order-large');
    const small = await createTestProject(env.db, owner.id, 'retry-order-small');
    await env.db.insert(domains).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `retry-order-${index}`,
        project_id: large.id,
        hostname: `retry-order-${index}.example.net`,
        cf_hostname_id: `cf-retry-order-${index}`,
        status: 'pending' as const,
      })),
    );
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(
      platform,
      env.db,
      configurationInput({ existingProjects: 'protected', protectNewProjects: true }),
    );
    await env.db
      .update(projectZeroTrust)
      .set({ updated_at: sql`now() - interval '1 hour'` })
      .where(eq(projectZeroTrust.project_id, large.id));
    await env.db
      .update(projectZeroTrust)
      .set({
        status: 'error',
        last_error: 'Earlier failure',
        updated_at: sql`now() - interval '30 minutes'`,
      })
      .where(eq(projectZeroTrust.project_id, small.id));

    await reconcilePendingProjectZeroTrust(platform, env.db, 1);
    expect(await getProjectZeroTrustState(env.db, small.id)).toMatchObject({ status: 'error' });
    expect(await getProjectZeroTrustState(env.db, large.id)).toMatchObject({
      status: 'error',
      last_error: expect.stringContaining('at most 100 custom domains'),
    });

    await reconcilePendingProjectZeroTrust(platform, env.db, 1);
    expect(await getProjectZeroTrustState(env.db, small.id)).toMatchObject({
      status: 'ready',
      desired_protected: true,
      last_error: null,
    });
  });

  it('initializes a project missing its Zero Trust row before retrying older failures', async () => {
    const owner = await createTestUser(env.db, 'missing-first-owner');
    const failing = await createTestProject(env.db, owner.id, 'missing-first-failing');
    await env.db.insert(domains).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `missing-first-${index}`,
        project_id: failing.id,
        hostname: `missing-first-${index}.example.net`,
        cf_hostname_id: `cf-missing-first-${index}`,
        status: 'pending' as const,
      })),
    );
    vi.stubGlobal('fetch', accessApi().fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(
      platform,
      env.db,
      configurationInput({ existingProjects: 'protected', protectNewProjects: true }),
    );
    // Its initialization failed after the project was created.
    const missing = await createTestProject(env.db, owner.id, 'missing-first-new');
    await expect(resolveProjectZeroTrustRouting(env.db, missing.id)).rejects.toThrow(
      'still being initialized',
    );

    // The failing project keeps failing, so every run records a newer attempt.
    for (let run = 0; run < 2; run += 1) {
      await reconcilePendingProjectZeroTrust(platform, env.db, 1);
    }

    expect(await getProjectZeroTrustState(env.db, missing.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    expect(await getProjectZeroTrustState(env.db, failing.id)).toMatchObject({
      status: 'error',
      last_error: expect.stringContaining('at most 100 custom domains'),
    });
  });

  it('moves a project missing its Zero Trust row behind other pending projects when it fails', async () => {
    const owner = await createTestUser(env.db, 'missing-retry-owner');
    const pending = await createTestProject(env.db, owner.id, 'missing-retry-pending');
    vi.stubGlobal('fetch', accessApi().fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(
      platform,
      env.db,
      configurationInput({ existingProjects: 'protected', protectNewProjects: true }),
    );
    await env.db
      .update(projectZeroTrust)
      .set({ status: 'error', last_error: 'Earlier failure', effective_protected: false })
      .where(eq(projectZeroTrust.project_id, pending.id));
    const missing = await createTestProject(env.db, owner.id, 'missing-retry-large');
    await env.db.insert(domains).values(
      Array.from({ length: 101 }, (_, index) => ({
        id: `missing-retry-${index}`,
        project_id: missing.id,
        hostname: `missing-retry-${index}.example.net`,
        cf_hostname_id: `cf-missing-retry-${index}`,
        status: 'pending' as const,
      })),
    );

    await reconcilePendingProjectZeroTrust(platform, env.db, 1);
    expect(await getProjectZeroTrustState(env.db, missing.id)).toMatchObject({
      desired_protected: true,
      effective_protected: false,
      status: 'error',
      last_error: expect.stringContaining('at most 100 custom domains'),
    });
    // The recorded failure still blocks its deploys.
    await expect(resolveProjectZeroTrustRouting(env.db, missing.id)).rejects.toThrow(
      'still reconciling',
    );
    expect(await getProjectZeroTrustState(env.db, pending.id)).toMatchObject({ status: 'error' });

    await reconcilePendingProjectZeroTrust(platform, env.db, 1);
    expect(await getProjectZeroTrustState(env.db, pending.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
      last_error: null,
    });
  });

  it('checks the routing budget after the checkpoint and keeps the bypass until routes publish', async () => {
    const owner = await createTestUser(env.db, 'budget-owner');
    const project = await createTestProject(env.db, owner.id, 'budget-project');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    const publicRow = (await getProjectZeroTrustState(env.db, project.id))!;
    expect(publicRow).toMatchObject({ status: 'ready', desired_protected: false });
    await env.db
      .update(projectZeroTrust)
      .set({ desired_protected: true, status: 'reconciling' })
      .where(eq(projectZeroTrust.project_id, project.id));
    const configuration = (await readZeroTrustConfigurationStrict(env.db))!;

    const routingBudget = { remaining: 5 };
    const partial = await reconcileProjectZeroTrust(platform, env.db, project.id, {
      configuration,
      routingBudget,
    });
    expect(routingBudget).toEqual({ remaining: 5, exhausted: true });
    expect(partial).toMatchObject({
      desired_protected: true,
      effective_protected: false,
      status: 'reconciling',
      bypass_application_id: publicRow.bypass_application_id,
    });
    expect(cloudflare.applications.has(publicRow.bypass_application_id!)).toBe(true);

    await expect(
      reconcileProjectZeroTrust(platform, env.db, project.id, {
        configuration,
        routingBudget: { remaining: 300 },
      }),
    ).resolves.toMatchObject({
      effective_protected: true,
      status: 'ready',
      desired_protected: true,
      bypass_application_id: null,
    });
    expect(cloudflare.applications.has(publicRow.bypass_application_id!)).toBe(false);
  });

  it('creates a project during a running operation without a spurious warning', async () => {
    const owner = await createTestUser(env.db, 'running-create-owner');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    await startForeignOperation();
    heartbeatAfterFirstRead();

    const response = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'running-create' }),
      }),
      platform,
    );

    expect(response.status).toBe(201);
    const body = await response.json<{ id: string; warnings?: Array<string> }>();
    expect(body.warnings).toBeUndefined();
    const row = await getProjectZeroTrustState(env.db, body.id);
    expect(row).toMatchObject({
      desired_protected: false,
      effective_protected: false,
      status: 'reconciling',
      bypass_application_id: expect.any(String),
    });
    expect(cloudflare.applications.has(row!.bypass_application_id!)).toBe(true);
  });

  it('reconciles domain protection during a running operation', async () => {
    const owner = await createTestUser(env.db, 'running-domain-owner');
    const project = await createTestProject(env.db, owner.id, 'running-domain');
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    await setProjectZeroTrustProtection(platform, env.db, project.id, true);
    await env.db.insert(domains).values({
      id: 'running-domain',
      project_id: project.id,
      hostname: 'running.example.net',
      cf_hostname_id: 'cf-running-domain',
      status: 'pending',
    });
    await startForeignOperation();
    heartbeatAfterFirstRead();

    const row = await reconcileProjectZeroTrustDomains(platform, env.db, project.id);

    expect(row).toMatchObject({
      status: 'ready',
      desired_protected: true,
      protected_application_id: expect.any(String),
    });
    expect(cloudflare.applications.get(row!.protected_application_id!)).toMatchObject({
      domain: 'running.example.net',
    });
  });

  it.each([
    [
      'a dedicated zone',
      { SITE_DOMAIN: 'example.com', AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback' },
      'api.example.com',
    ],
    [
      'the workers.dev ingress',
      {
        SITE_DOMAIN: 'test.workers.dev',
        PLATFORM_APPLICATION: JSON.stringify({
          baseDomain: 'test.workers.dev',
          zoneName: '',
          dedicatedZone: false,
          workersDev: { installationId: 'team-123456abcdef', subdomain: 'test' },
        }),
        PROXY_URL: 'https://void-123456abcdef-proxy.test.workers.dev',
      },
      'void-123456abcdef-proxy.test.workers.dev',
    ],
  ] as const)(
    'rejects a wildcard that would cover the control plane on %s',
    async (_name, overrides, hostname) => {
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);

      await expect(
        configurePlatformZeroTrust(bindings(overrides), env.db, configurationInput()),
      ).rejects.toThrow(`control plane (${hostname})`);
      expect(await readZeroTrustConfigurationStrict(env.db)).toBeNull();
      expect(cloudflare.fetcher).not.toHaveBeenCalled();
    },
  );

  it('accepts a replacement credential for a disable after the control plane moved under the wildcard', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, configurationInput());
    cloudflare.revoke(true);
    await expect(disablePlatformZeroTrust(bindings(), env.db)).rejects.toThrow(
      'Access token was revoked',
    );
    cloudflare.revoke(false);
    const moved = bindings({ AUTH_REDIRECT_URI: 'https://api.apps.example.com/auth/callback' });

    // A disable does not choose protection for existing projects.
    const { existingProjects: _existingProjects, ...replacement } = configurationInput();
    await configurePlatformZeroTrust(moved, env.db, {
      ...replacement,
      apiToken: 'replacement-token',
    });

    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      lastError: null,
      operation: null,
      wildcardApplication: null,
    });
    await expect(configurePlatformZeroTrust(moved, env.db, configurationInput())).rejects.toThrow(
      'control plane (api.apps.example.com)',
    );
  });

  it('accepts a control plane outside the project application domain', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);

    await expect(
      configurePlatformZeroTrust(
        bindings({ AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback' }),
        env.db,
        configurationInput(),
        { requestUrl: 'https://api.example.com/operator/v1/zero-trust/configure' },
      ),
    ).resolves.toMatchObject({ enabled: true, status: 'ready' });
  });
});
