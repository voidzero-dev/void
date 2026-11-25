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
import { domains, platformSettings } from '../../src/schema.ts';
import {
  readZeroTrustConfigurationStrict,
  zeroTrustConfigurationStatus,
} from '../../src/zero-trust/configuration.ts';
import type { ZeroTrustConfigureInput } from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import {
  reconcileProjectZeroTrustDomains,
  initializeNewProjectZeroTrust,
} from '../../src/zero-trust/project.ts';
import { resolveProjectZeroTrustRouting } from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
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

function configurationInput(
  overrides: Partial<ZeroTrustConfigureInput> = {},
): ZeroTrustConfigureInput {
  return {
    apiToken: 'old-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
    existingProjects: 'protected',
    ...overrides,
  };
}

function providerError(message: string, status: number): Response {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

describe('Zero Trust operation completion', () => {
  it('does not let an expired configure seed mutate a project after disable completes', async () => {
    const owner = await createTestUser(env.db, 'generation-seed-owner');
    const project = await createTestProject(env.db, owner.id, 'generation-seed-project');
    const cloudflare = accessApi();
    const platform = bindings();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ worker: 'worker', projectId: project.id }),
    );
    const originalTransaction = env.db.transaction.bind(env.db);
    let transactions = 0;
    const transactionSpy = vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
      transactions++;
      if (transactions === 2) {
        const saved = (await readZeroTrustConfigurationStrict(env.db))!;
        await env.db
          .update(platformSettings)
          .set({
            value: {
              ...saved,
              operation: { ...saved.operation, leaseExpiresAt: new Date(0).toISOString() },
            },
          })
          .where(eq(platformSettings.key, 'zeroTrust.configuration'));
        await disablePlatformZeroTrust(platform, env.db);
        expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
          desired_protected: false,
          status: 'ready',
        });
      }
      return originalTransaction(...args);
    });
    try {
      await expect(
        configurePlatformZeroTrust(platform, env.db, configurationInput()),
      ).rejects.toThrow('replaced');
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: false,
      lastError: null,
    });
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: false,
      status: 'ready',
    });
    expect(await resolveProjectZeroTrustRouting(env.db, project.id)).toBeNull();
  });

  it('reconciles routes touched during wildcard audience replacement', async () => {
    const owner = await createTestUser(env.db, 'review-owner');
    const project = await createTestProject(env.db, owner.id, 'review-project');
    const cloudflare = accessApi();
    const platform = bindings();
    let interleave = false;
    let operationId: string | undefined;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (interleave && new URL(input.toString()).pathname.endsWith('/access/organizations')) {
        interleave = false;
        operationId = (await readZeroTrustConfigurationStrict(env.db))!.operation!.id;
        await reconcileProjectZeroTrustDomains(platform, env.db, project.id);
        expect(
          (await getProjectZeroTrustState(env.db, project.id))!.reconciled_operation,
        ).toBeNull();
      }
      return cloudflare.fetcher(input, init);
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ worker: 'worker', projectId: project.id }),
    );
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    const oldConfiguration = (await readZeroTrustConfigurationStrict(env.db))!;
    cloudflare.applications.delete(oldConfiguration.wildcardApplication!.id);
    await env.db.insert(domains).values({
      id: 'review-domain',
      project_id: project.id,
      hostname: 'review.example.net',
      cf_hostname_id: 'cf-review',
      status: 'pending',
    });
    interleave = true;
    await reconcilePlatformZeroTrust(platform, env.db);
    const updated = (await readZeroTrustConfigurationStrict(env.db))!;
    const routing = JSON.parse((await env.ROUTING.get(project.slug))!) as {
      zeroTrust: { audiences: Array<{ hostname: string; audience: string }> };
    };
    expect(zeroTrustConfigurationStatus(updated)).toBe('ready');
    expect(updated.wildcardApplication!.audience).not.toBe(
      oldConfiguration.wildcardApplication!.audience,
    );
    expect(operationId).toBeTruthy();
    expect((await getProjectZeroTrustState(env.db, project.id))!.reconciled_operation).toBe(
      operationId,
    );
    expect(
      routing.zeroTrust.audiences.find(
        (entry: { hostname: string }) => entry.hostname === '*.apps.example.com',
      )!.audience,
    ).toBe(updated.wildcardApplication!.audience);
  });

  it('keeps a protected project created during wildcard replacement pending until the project pass', async () => {
    const owner = await createTestUser(env.db, 'generation-new-owner');
    const cloudflare = accessApi();
    const platform = bindings();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    const old = (await readZeroTrustConfigurationStrict(env.db))!;
    cloudflare.applications.delete(old.wildcardApplication!.id);
    let newProjectId = '';
    let operationId: string | undefined;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!newProjectId && new URL(input.toString()).pathname.endsWith('/access/organizations')) {
        const project = await createTestProject(env.db, owner.id, 'generation-new-project');
        newProjectId = project.id;
        operationId = (await readZeroTrustConfigurationStrict(env.db))!.operation!.id;
        expect(await initializeNewProjectZeroTrust(platform, env.db, project.id)).toMatchObject({
          status: 'reconciling',
          effective_protected: false,
          reconciled_operation: null,
        });
        await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
          'still reconciling',
        );
      }
      return cloudflare.fetcher(input, init);
    });
    await reconcilePlatformZeroTrust(platform, env.db);
    const updated = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(await getProjectZeroTrustState(env.db, newProjectId)).toMatchObject({
      status: 'ready',
      desired_protected: true,
      effective_protected: true,
      reconciled_operation: operationId,
    });
    expect((await resolveProjectZeroTrustRouting(env.db, newProjectId))?.audiences).toContainEqual({
      hostname: '*.apps.example.com',
      audience: updated.wildcardApplication!.audience,
    });
  });

  it('does not let an expired disable mutate the state of a subsequently protected project', async () => {
    const owner = await createTestUser(env.db, 'generation-lease-owner');
    const project = await createTestProject(env.db, owner.id, 'generation-lease-project');
    const cloudflare = accessApi();
    const platform = bindings();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ worker: 'worker', projectId: project.id }),
    );
    await env.db.insert(domains).values({
      id: 'generation-lease-domain',
      project_id: project.id,
      hostname: 'lease.example.net',
      cf_hostname_id: 'cf-lease',
      status: 'active',
    });
    await env.ROUTING.put(
      'domain:lease.example.net',
      JSON.stringify({ worker: 'worker', projectId: project.id }),
    );
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    const originalTransaction = env.db.transaction.bind(env.db);
    let transactions = 0;
    let freshApplicationId: string | null = null;
    const transactionSpy = vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
      transactions++;
      if (transactions === 2) {
        const old = (await readZeroTrustConfigurationStrict(env.db))!;
        await env.db
          .update(platformSettings)
          .set({
            value: {
              ...old,
              operation: { ...old.operation, leaseExpiresAt: new Date(0).toISOString() },
            },
          })
          .where(eq(platformSettings.key, 'zeroTrust.configuration'));
        await disablePlatformZeroTrust(platform, env.db);
        await configurePlatformZeroTrust(platform, env.db, configurationInput());
        freshApplicationId = (await getProjectZeroTrustState(env.db, project.id))!
          .protected_application_id;
        expect(freshApplicationId).toBeTruthy();
      }
      return originalTransaction(...args);
    });
    try {
      await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
        'operation was replaced',
      );
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: true,
      lastError: null,
    });
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
      protected_application_id: freshApplicationId,
    });
    expect(cloudflare.applications.has(freshApplicationId!)).toBe(true);
    expect(
      JSON.parse((await env.ROUTING.get('domain:lease.example.net'))!).zeroTrust,
    ).toBeDefined();
  });

  it.each(['PUT', 'DELETE'] as const)(
    'holds the configuration claim through wildcard %s and its checkpoint',
    async (method) => {
      const cloudflare = accessApi();
      const platform = bindings();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      await configurePlatformZeroTrust(platform, env.db, configurationInput());
      const applicationId = (await readZeroTrustConfigurationStrict(env.db))!.wildcardApplication!
        .id;
      const entered = deferred();
      const release = deferred();
      let transactionDepth = 0;
      const originalTransaction = env.db.transaction.bind(env.db);
      const transactionSpy = vi
        .spyOn(env.db, 'transaction')
        .mockImplementation(async (callback, options) => {
          return originalTransaction(async (tx) => {
            transactionDepth++;
            try {
              return await callback(tx);
            } finally {
              transactionDepth--;
            }
          }, options);
        });
      let paused = false;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (
          !paused &&
          init?.method === method &&
          new URL(input.toString()).pathname.endsWith(`/access/apps/${applicationId}`)
        ) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return cloudflare.fetcher(input, init);
      });
      const oldOperation =
        method === 'PUT'
          ? reconcilePlatformZeroTrust(platform, env.db)
          : disablePlatformZeroTrust(platform, env.db);
      await entered.promise;
      // The pending operation does not choose existing-project protection.
      const { existingProjects: _existingProjects, ...nextInput } = configurationInput({
        identityProviderIds: ['idp-2'],
        policyIds: ['policy-2'],
      });
      // Simulate a slow provider call outliving the lease without writing through
      // the transaction whose claim lock this test expects to remain held.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
      let contenderSettled = false;
      const contender = configurePlatformZeroTrust(platform, env.db, nextInput)
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        )
        .then((result) => {
          contenderSettled = true;
          return result;
        });
      try {
        // This assertion also fails deterministically when provider I/O happens
        // outside the configuration transaction, before the scheduling check.
        expect(transactionDepth).toBe(1);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(contenderSettled).toBe(false);
      } finally {
        release.resolve();
      }
      await oldOperation;
      const result = await contender;
      transactionSpy.mockRestore();
      if (result.error) {
        // After a completed disable, configuring enables again and needs the
        // existing-project choice that the pending operation did not allow.
        expect(String(result.error)).toMatch(
          /already running|operation.*changed|operation.*pending|choice for existing projects/,
        );
        await configurePlatformZeroTrust(
          platform,
          env.db,
          method === 'DELETE' ? { ...nextInput, existingProjects: 'protected' } : nextInput,
        );
      }
      const current = (await readZeroTrustConfigurationStrict(env.db))!;
      expect(current).toMatchObject({
        enabled: true,
        lastError: null,
        identityProviderIds: ['idp-2'],
        policyIds: ['policy-2'],
      });
      expect(cloudflare.applications.get(current.wildcardApplication!.id)).toMatchObject({
        allowed_idps: ['idp-2'],
        policies: [{ id: 'policy-2' }],
      });
      if (method === 'DELETE') {
        expect(current.wildcardApplication!.id).not.toBe(applicationId);
        expect(cloudflare.applications.has(applicationId)).toBe(false);
      }
    },
  );
});
