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
import app from '../../src/index.ts';
import { decryptPlatformCredential } from '../../src/project-secrets.ts';
import { domains, projectZeroTrust } from '../../src/schema.ts';
import {
  ZERO_TRUST_CREDENTIAL_ID,
  readZeroTrustConfigurationStrict,
} from '../../src/zero-trust/configuration.ts';
import type {
  ZeroTrustConfigureInput,
  ZeroTrustOperation,
} from '../../src/zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
} from '../../src/zero-trust/installation.ts';
import { reconcilePendingProjectZeroTrust } from '../../src/zero-trust/maintenance.ts';
import {
  initializeNewProjectZeroTrust,
  reconcileProjectZeroTrustDomains,
  setProjectZeroTrustProtection,
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

/** A token replacement for an operation that does not choose existing-project protection. */
function replacementInput(
  input: ZeroTrustConfigureInput,
  overrides: Partial<ZeroTrustConfigureInput> = {},
): ZeroTrustConfigureInput {
  const { existingProjects: _existingProjects, ...rest } = input;
  return { ...rest, apiToken: 'replacement-token', ...overrides };
}

function providerError(message: string, status: number): Response {
  return Response.json({ success: false, errors: [{ message }] }, { status });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
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

describe('Zero Trust recovery', () => {
  it.each([false, true])(
    'preserves public batch state when POST /projects resumes with protectNewProjects=%s',
    async (protectNewProjects) => {
      const owner = await createTestUser(env.db, 'project-create-race-owner');
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      const platform = bindings();
      const slug = 'project-create-race';
      const originalTransaction = env.db.transaction.bind(env.db);
      let interleaved = false;
      let seeded: Awaited<ReturnType<typeof getProjectZeroTrustState>> = null;
      const transactionSpy = vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
        const result = await originalTransaction(...args);
        if (
          !interleaved &&
          result &&
          typeof result === 'object' &&
          'slug' in result &&
          result.slug === slug &&
          'id' in result
        ) {
          // The route's project insert is committed, but its initialization
          // step has not begun. A complete administrator batch runs here.
          interleaved = true;
          await configurePlatformZeroTrust(
            platform,
            env.db,
            configurationInput({
              existingProjects: 'public',
              protectNewProjects,
            }),
          );
          seeded = await getProjectZeroTrustState(env.db, String(result.id));
          expect(seeded).toMatchObject({
            desired_protected: false,
            effective_protected: false,
            status: 'ready',
          });
          expect(seeded?.bypass_application_id).toBeTruthy();
          expect(seeded?.bypass_application_name).toBeTruthy();
          cloudflare.fetcher.mockClear();
        }
        return result;
      });
      let response: Response;
      try {
        response = await app.fetch(
          new Request('http://localhost/projects', {
            method: 'POST',
            headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug }),
          }),
          platform,
        );
      } finally {
        transactionSpy.mockRestore();
      }
      expect(response.status).toBe(201);
      expect(interleaved).toBe(true);
      const body = await response.json<{ id: string; warnings?: Array<string> }>();
      expect(body.warnings).toBeUndefined();
      expect(await getProjectZeroTrustState(env.db, body.id)).toEqual(seeded);
      expect(cloudflare.fetcher).not.toHaveBeenCalled();
      await expect(resolveProjectZeroTrustRouting(env.db, body.id)).resolves.toBeNull();
      expect(cloudflare.applications.size).toBe(3);

      await expect(disablePlatformZeroTrust(platform, env.db)).resolves.toMatchObject({
        enabled: false,
        operation: null,
      });
      expect(cloudflare.applications.size).toBe(0);
      expect(await getProjectZeroTrustState(env.db, body.id)).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        bypass_application_id: null,
        bypass_application_name: null,
      });
    },
  );

  it.each(['error', 'reconciling'] as const)(
    'leaves an existing %s creation checkpoint for explicit reconciliation',
    async (state) => {
      const owner = await createTestUser(env.db, 'interrupted-initializer-owner');
      const project = await createTestProject(env.db, owner.id, 'interrupted-initializer');
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      const platform = bindings();
      await configurePlatformZeroTrust(
        platform,
        env.db,
        configurationInput({
          existingProjects: 'public',
          protectNewProjects: true,
        }),
      );
      const completed = (await getProjectZeroTrustState(env.db, project.id))!;
      // Preserve the name intent for an app created before its ID checkpoint
      // was durable. Initializing again must not replace that recovery handle.
      await env.db
        .update(projectZeroTrust)
        .set({
          status: state,
          bypass_application_id: null,
          last_error: state === 'error' ? 'Interrupted after provider creation' : null,
        })
        .where(eq(projectZeroTrust.project_id, project.id));
      const interrupted = await getProjectZeroTrustState(env.db, project.id);
      cloudflare.fetcher.mockClear();

      await expect(initializeNewProjectZeroTrust(platform, env.db, project.id)).resolves.toEqual(
        interrupted,
      );
      expect(await getProjectZeroTrustState(env.db, project.id)).toEqual(interrupted);
      expect(cloudflare.fetcher).not.toHaveBeenCalled();
      await expect(resolveProjectZeroTrustRouting(env.db, project.id)).rejects.toThrow(
        'public exception is still reconciling',
      );

      await reconcilePendingProjectZeroTrust(platform, env.db);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        status: 'ready',
        desired_protected: false,
        effective_protected: false,
        bypass_application_id: completed.bypass_application_id,
        bypass_application_name: completed.bypass_application_name,
        last_error: null,
      });
      await expect(resolveProjectZeroTrustRouting(env.db, project.id)).resolves.toBeNull();
      expect(cloudflare.applications.size).toBe(3);
      await disablePlatformZeroTrust(platform, env.db);
      expect(cloudflare.applications.size).toBe(0);
    },
  );

  it('cleans up a bypass created by another request between projects in the pending batch', async () => {
    const owner = await createTestUser(env.db, 'batch-owner');
    const first = await createTestProject(env.db, owner.id, 'batch-first');
    const second = await createTestProject(env.db, owner.id, 'batch-second');
    const cloudflare = accessApi();
    let failDeletes = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (failDeletes && init?.method === 'DELETE') {
        return providerError('temporary deletion failure', 500);
      }
      return cloudflare.fetcher(input, init);
    });
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    await env.db.insert(domains).values({
      id: 'domain-batch',
      project_id: first.id,
      hostname: 'batch.example.net',
      cf_hostname_id: 'cf-batch',
      status: 'active',
    });
    await env.ROUTING.put(
      'domain:batch.example.net',
      JSON.stringify({ worker: 'live-worker', projectId: first.id }),
    );
    await env.db
      .update(projectZeroTrust)
      .set({ status: 'error' })
      .where(eq(projectZeroTrust.project_id, first.id));
    await env.db
      .update(projectZeroTrust)
      .set({ status: 'error' })
      .where(eq(projectZeroTrust.project_id, second.id));
    const originalTransaction = env.db.transaction.bind(env.db);
    let transactions = 0;
    let bypassId: string | null = null;
    // Interleave after the first project's checkpoint and provider reconciliation
    // have committed, before the same batch client begins the second project.
    const transactionSpy = vi.spyOn(env.db, 'transaction').mockImplementation(async (...args) => {
      const result = await originalTransaction(...args);
      transactions += 1;
      if (transactions === 2) {
        await setProjectZeroTrustProtection(platform, env.db, second.id, false);
        bypassId = (await getProjectZeroTrustState(env.db, second.id))!.bypass_application_id;
        failDeletes = true;
        await expect(
          setProjectZeroTrustProtection(platform, env.db, second.id, true),
        ).rejects.toThrow('temporary deletion failure');
        failDeletes = false;
        expect(await getProjectZeroTrustState(env.db, second.id)).toMatchObject({
          status: 'error',
          bypass_application_id: bypassId,
        });
      }
      return result;
    });
    try {
      await reconcilePendingProjectZeroTrust(platform, env.db);
    } finally {
      transactionSpy.mockRestore();
    }
    expect(bypassId).toBeTruthy();
    expect(await getProjectZeroTrustState(env.db, second.id)).toMatchObject({
      status: 'ready',
      desired_protected: true,
      bypass_application_id: null,
      bypass_application_name: null,
    });
    expect(cloudflare.applications.has(bypassId!)).toBe(false);
  });

  it('adopts its own wildcard replacement after the recreate response is lost', async () => {
    const owner = await createTestUser(env.db, 'replacement-owner');
    const project = await createTestProject(env.db, owner.id, 'replacement-project');
    const cloudflare = accessApi();
    let loseWildcardCreate = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await cloudflare.fetcher(input, init);
      if (
        loseWildcardCreate &&
        init?.method === 'POST' &&
        JSON.parse(String(init.body)).domain === '*.apps.example.com'
      ) {
        loseWildcardCreate = false;
        // The provider committed the replacement, but Void never received its ID.
        return providerError('Gateway timeout', 504);
      }
      return response;
    });
    const platform = bindings();
    await configurePlatformZeroTrust(platform, env.db, configurationInput());
    const configured = (await readZeroTrustConfigurationStrict(env.db))!;
    const original = configured.wildcardApplication!;
    cloudflare.applications.delete(original.id);

    loseWildcardCreate = true;
    await expect(reconcilePlatformZeroTrust(platform, env.db)).rejects.toThrow('Gateway timeout');
    const replacement = [...cloudflare.applications.values()].find(
      (application) => application.name === configured.wildcardApplicationName,
    )!;
    expect(replacement.id).not.toBe(original.id);
    expect((await readZeroTrustConfigurationStrict(env.db))!.wildcardApplication?.id).not.toBe(
      replacement.id,
    );

    await reconcilePlatformZeroTrust(platform, env.db);
    expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
      enabled: true,
      operation: null,
      wildcardApplication: { id: replacement.id, audience: replacement.aud },
    });
    expect(
      [...cloudflare.applications.values()].filter(
        (application) => application.name === configured.wildcardApplicationName,
      ),
    ).toHaveLength(1);
    expect((await resolveProjectZeroTrustRouting(env.db, project.id))!.audiences).toContainEqual({
      hostname: '*.apps.example.com',
      audience: replacement.aud,
    });

    await expect(disablePlatformZeroTrust(platform, env.db)).resolves.toMatchObject({
      enabled: false,
    });
    expect(cloudflare.applications.size).toBe(0);
  });

  it('replaces a revoked token and recovers a provider application from the saved creation checkpoint', async () => {
    const owner = await createTestUser(env.db, 'credential-owner');
    const project = await createTestProject(env.db, owner.id, 'credential-project');
    const cloudflare = accessApi();
    let oldTokenRevoked = false;
    let resumedOperation: ZeroTrustOperation | null = null;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('Authorization');
      if (oldTokenRevoked && token === 'Bearer old-token') {
        return providerError('Authentication error', 403);
      }
      const response = await cloudflare.fetcher(input, init);
      if (
        token === 'Bearer old-token' &&
        init?.method === 'POST' &&
        JSON.parse(String(init.body)).domain === '*.apps.example.com'
      ) {
        oldTokenRevoked = true;
        // The provider committed the app, but Void never received its ID.
        return providerError('Authentication error', 403);
      }
      return response;
    });
    const platform = bindings();
    const input = configurationInput({ existingProjects: 'public' });
    await expect(configurePlatformZeroTrust(platform, env.db, input)).rejects.toThrow(
      'Authentication error',
    );
    const failed = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(failed).toMatchObject({
      lastError: expect.any(String),
      wildcardApplication: null,
      operation: { kind: 'configure', phase: 'wildcard', owner: null },
    });
    const originalBypass = (await getProjectZeroTrustState(env.db, project.id))!
      .bypass_application_id;
    const originalWildcard = [...cloudflare.applications.values()].find(
      (app) => app.name === failed.wildcardApplicationName,
    )!;
    expect(originalBypass).toBeTruthy();
    expect(originalWildcard).toBeDefined();
    await expect(reconcilePlatformZeroTrust(platform, env.db)).rejects.toThrow(
      'Authentication error',
    );

    const originalTransaction = env.db.transaction.bind(env.db);
    const transactionSpy = vi
      .spyOn(env.db, 'transaction')
      .mockImplementationOnce(async (...args) => {
        const result = await originalTransaction(...args);
        // The replacement claim has committed, and no provider mutation holds a
        // transaction yet. Observe that checkpoint before reconciliation resumes.
        resumedOperation = (await readZeroTrustConfigurationStrict(env.db))!.operation;
        return result;
      });
    try {
      await configurePlatformZeroTrust(platform, env.db, {
        ...input,
        apiToken: 'replacement-token',
      });
    } finally {
      transactionSpy.mockRestore();
    }

    const recovered = (await readZeroTrustConfigurationStrict(env.db))!;
    expect(resumedOperation).toMatchObject({
      kind: 'configure',
      phase: 'wildcard',
      startedAt: failed.operation!.startedAt,
      existingProjects: 'public',
    });
    expect(recovered).toMatchObject({
      enabled: true,
      lastError: null,
      operation: null,
      wildcardApplication: { id: originalWildcard.id, name: failed.wildcardApplicationName },
    });
    expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
      desired_protected: false,
      status: 'ready',
      bypass_application_id: originalBypass,
    });
    expect(cloudflare.applications.size).toBe(3);
    expect(
      await decryptPlatformCredential(
        platform,
        'installation-test',
        ZERO_TRUST_CREDENTIAL_ID,
        recovered.credential,
      ),
    ).toBe('replacement-token');
  });

  it.each([
    {
      label: 'identity providers',
      change: { identityProviderIds: ['idp-2'] },
      message: 'same identity providers, policies, and project selections',
    },
    {
      label: 'policies',
      change: { policyIds: ['policy-2'] },
      message: 'same identity providers, policies, and project selections',
    },
    {
      label: 'new-project protection',
      change: { protectNewProjects: false },
      message: 'same identity providers, policies, and project selections',
    },
    {
      label: 'existing-project selection',
      change: { existingProjects: 'public' as const },
      message: 'keeps existing projects protected',
    },
  ])(
    'rejects changed $label when replacing a pending operation token',
    async ({ change, message }) => {
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (
          new Headers(init?.headers).get('Authorization') === 'Bearer old-token' &&
          init?.method === 'POST'
        ) {
          return providerError('Authentication error', 403);
        }
        return cloudflare.fetcher(input, init);
      });
      const platform = bindings();
      const input = configurationInput();
      await expect(configurePlatformZeroTrust(platform, env.db, input)).rejects.toThrow(
        'Authentication error',
      );
      const checkpoint = await readZeroTrustConfigurationStrict(env.db);

      await expect(
        configurePlatformZeroTrust(platform, env.db, {
          ...input,
          ...change,
          apiToken: 'replacement-token',
        }),
      ).rejects.toThrow(message);
      expect(await readZeroTrustConfigurationStrict(env.db)).toEqual(checkpoint);
      expect(cloudflare.applications.size).toBe(0);
    },
  );

  it('rejects token replacement and disable while another reconcile request holds an active lease', async () => {
    const cloudflare = accessApi();
    const reachedValidation = deferred();
    const releaseValidation = deferred();
    let pauseValidation = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (
        pauseValidation &&
        new Headers(init?.headers).get('Authorization') === 'Bearer old-token' &&
        new URL(input.toString()).pathname.endsWith('/organizations')
      ) {
        reachedValidation.resolve();
        await releaseValidation.promise;
      }
      return cloudflare.fetcher(input, init);
    });
    const platform = bindings();
    const input = configurationInput();
    await configurePlatformZeroTrust(platform, env.db, input);
    // Reconciliation commits its lease before selection validation, so another
    // request can inspect and reject that lease without waiting on a DB lock.
    pauseValidation = true;
    const reconciling = reconcilePlatformZeroTrust(platform, env.db);
    try {
      await reachedValidation.promise;
      const checkpoint = await readZeroTrustConfigurationStrict(env.db);
      expect(checkpoint?.operation?.owner).toBeTruthy();
      await expect(
        configurePlatformZeroTrust(platform, env.db, replacementInput(input)),
      ).rejects.toThrow('Another Zero Trust operation is already running');
      await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
        'Another Zero Trust operation is already running',
      );
      expect(await readZeroTrustConfigurationStrict(env.db)).toEqual(checkpoint);
    } finally {
      releaseValidation.resolve();
      await reconciling;
    }
  });

  it.each([null, 'identity_providers/idp-1', 'policies/policy-1'])(
    'resumes a failed disable with a replacement token when the missing selection is %s',
    async (missingSelection) => {
      const owner = await createTestUser(env.db, 'disable-token-owner');
      const project = await createTestProject(env.db, owner.id, 'disable-token-project');
      const cloudflare = accessApi();
      let oldTokenRevoked = false;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (
          oldTokenRevoked &&
          new Headers(init?.headers).get('Authorization') === 'Bearer old-token'
        ) {
          return providerError('Authentication error', 403);
        }
        if (
          oldTokenRevoked &&
          missingSelection &&
          new URL(input.toString()).pathname.endsWith(`/${missingSelection}`)
        ) {
          return providerError('Selected resource was deleted', 404);
        }
        return cloudflare.fetcher(input, init);
      });
      const platform = bindings();
      const input = configurationInput({ existingProjects: 'public' });
      await configurePlatformZeroTrust(platform, env.db, input);
      const bypassId = (await getProjectZeroTrustState(env.db, project.id))!.bypass_application_id;
      oldTokenRevoked = true;
      await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
        'Authentication error',
      );
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        lastError: expect.any(String),
        operation: { kind: 'disable', phase: 'wildcard-delete', owner: null },
      });
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        bypass_application_id: bypassId,
      });
      cloudflare.fetcher.mockClear();

      await configurePlatformZeroTrust(platform, env.db, replacementInput(input));

      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: false,
        lastError: null,
        operation: null,
        wildcardApplication: null,
      });
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        bypass_application_id: null,
      });
      expect(cloudflare.applications.size).toBe(0);
      expect(
        cloudflare.fetcher.mock.calls.some(
          ([, init]) => init?.method === 'POST' || init?.method === 'PUT',
        ),
      ).toBe(false);
    },
  );

  it.each([
    {
      kind: 'configure',
      missing: 'identity_providers/idp-1',
      replacement: { identityProviderIds: ['idp-2'] },
    },
    { kind: 'configure', missing: 'policies/policy-1', replacement: { policyIds: ['policy-2'] } },
    {
      kind: 'reconcile',
      missing: 'identity_providers/idp-1',
      replacement: { identityProviderIds: ['idp-2'] },
    },
    { kind: 'reconcile', missing: 'policies/policy-1', replacement: { policyIds: ['policy-2'] } },
  ])(
    'can disable a failed $kind after $missing is deleted and configure valid replacements',
    async ({ kind, missing, replacement }) => {
      const owner = await createTestUser(env.db, 'deleted-selection-owner');
      const project = await createTestProject(env.db, owner.id, 'deleted-selection-project');
      const cloudflare = accessApi();
      let removed = false;
      let failCreate = kind === 'configure';
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (removed && new URL(input.toString()).pathname.endsWith(`/${missing}`)) {
          return providerError('Selected resource was deleted', 404);
        }
        if (
          failCreate &&
          init?.method === 'POST' &&
          JSON.parse(String(init.body)).domain === '*.apps.example.com'
        ) {
          return providerError('Temporary provider failure', 500);
        }
        return cloudflare.fetcher(input, init);
      });
      const platform = bindings();
      const input = configurationInput({ existingProjects: 'public' });
      if (kind === 'configure') {
        await expect(configurePlatformZeroTrust(platform, env.db, input)).rejects.toThrow(
          'Temporary provider failure',
        );
        failCreate = false;
      } else {
        await configurePlatformZeroTrust(platform, env.db, input);
      }
      const bypassId = (await getProjectZeroTrustState(env.db, project.id))!.bypass_application_id;
      expect(bypassId).toBeTruthy();
      expect(cloudflare.applications.has(bypassId!)).toBe(true);
      removed = true;
      await expect(reconcilePlatformZeroTrust(platform, env.db)).rejects.toThrow(
        'Selected resource was deleted',
      );
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        lastError: expect.any(String),
        operation: { kind, owner: null },
      });
      const replacement_ = replacementInput(input, replacement);
      await expect(configurePlatformZeroTrust(platform, env.db, replacement_)).rejects.toThrow(
        'same identity providers, policies, and project selections',
      );

      await disablePlatformZeroTrust(platform, env.db);

      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: false,
        lastError: null,
        operation: null,
        wildcardApplication: null,
      });
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        bypass_application_id: null,
        bypass_application_name: null,
      });
      expect(cloudflare.applications.size).toBe(0);
      // Enabling again chooses protection for existing projects.
      await configurePlatformZeroTrust(platform, env.db, {
        ...replacement_,
        existingProjects: 'public',
      });
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: true,
        lastError: null,
        operation: null,
        identityProviderIds: replacement_.identityProviderIds,
        policyIds: replacement_.policyIds,
      });
      expect(cloudflare.applications.size).toBe(3);
    },
  );

  it('does not enable unvalidated selections when disable completes during credential validation', async () => {
    const cloudflare = accessApi();
    const reachedValidation = deferred();
    const releaseValidation = deferred();
    let failDeletes = false;
    let selectionDeleted = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const token = new Headers(init?.headers).get('Authorization');
      if (token === 'Bearer replacement-token' && url.pathname.endsWith('/organizations')) {
        reachedValidation.resolve();
        await releaseValidation.promise;
      }
      if (selectionDeleted && url.pathname.endsWith('/policies/policy-1')) {
        return providerError('Selected resource was deleted', 404);
      }
      if (failDeletes && init?.method === 'DELETE') {
        return providerError('Temporary deletion failure', 500);
      }
      return cloudflare.fetcher(input, init);
    });
    const platform = bindings();
    const input = configurationInput();
    await configurePlatformZeroTrust(platform, env.db, input);
    failDeletes = true;
    await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
      'Temporary deletion failure',
    );
    selectionDeleted = true;
    const replacing = configurePlatformZeroTrust(platform, env.db, replacementInput(input));
    const rejectedReplacement = expect(replacing).rejects.toThrow(
      'saved Zero Trust operation changed',
    );
    try {
      await reachedValidation.promise;
      failDeletes = false;
      await disablePlatformZeroTrust(platform, env.db);
      expect(cloudflare.applications.size).toBe(0);
      const disabled = await readZeroTrustConfigurationStrict(env.db);
      expect(disabled).toMatchObject({ enabled: false, lastError: null, operation: null });
      cloudflare.fetcher.mockClear();
      releaseValidation.resolve();
      await rejectedReplacement;
      expect(await readZeroTrustConfigurationStrict(env.db)).toEqual(disabled);
      expect(
        cloudflare.fetcher.mock.calls.some(
          ([, init]) => init?.method === 'POST' || init?.method === 'PUT',
        ),
      ).toBe(false);
    } finally {
      releaseValidation.resolve();
      await replacing.catch(() => undefined);
    }
  });

  it.each(['domain reconciliation', 'new project', 'saved bypass checkpoint'] as const)(
    'drains %s after wildcard deletion fails before completing disable',
    async (lateChange) => {
      const owner = await createTestUser(env.db, 'late-disable-owner');
      const project = await createTestProject(env.db, owner.id, 'late-disable-project');
      const cloudflare = accessApi();
      let failWildcardDelete = false;
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const id = new URL(input.toString()).pathname.split('/').at(-1)!;
        if (
          failWildcardDelete &&
          init?.method === 'DELETE' &&
          cloudflare.applications.get(id)?.domain === '*.apps.example.com'
        ) {
          return providerError('Temporary wildcard deletion failure', 503);
        }
        return cloudflare.fetcher(input, init);
      });
      const platform = bindings();
      await configurePlatformZeroTrust(platform, env.db, configurationInput());
      const { wildcardApplication: wildcard, healthApplication: health } =
        (await readZeroTrustConfigurationStrict(env.db))!;
      failWildcardDelete = true;
      await expect(disablePlatformZeroTrust(platform, env.db)).rejects.toThrow(
        'Temporary wildcard deletion failure',
      );
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: true,
        lastError: expect.any(String),
        operation: { kind: 'disable', phase: 'wildcard-delete', owner: null },
      });
      const cleanedProject = await getProjectZeroTrustState(env.db, project.id);
      expect(cleanedProject).toMatchObject({
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        bypass_application_id: null,
      });
      cloudflare.fetcher.mockClear();
      let lateProjectId: string | null = null;

      if (lateChange === 'domain reconciliation') {
        await env.db.insert(domains).values({
          id: 'late-disable-domain',
          project_id: project.id,
          hostname: 'late-disable.example.net',
          cf_hostname_id: 'cf-late-disable-domain',
          status: 'pending',
        });
        await expect(
          reconcileProjectZeroTrustDomains(platform, env.db, project.id),
        ).resolves.toEqual(cleanedProject);
        expect(await getProjectZeroTrustState(env.db, project.id)).toEqual(cleanedProject);
        expect(cloudflare.fetcher).not.toHaveBeenCalled();
      } else if (lateChange === 'new project') {
        const lateProject = await createTestProject(env.db, owner.id, 'created-during-disable');
        lateProjectId = lateProject.id;
        await expect(
          initializeNewProjectZeroTrust(platform, env.db, lateProject.id),
        ).resolves.toBeNull();
        expect(await getProjectZeroTrustState(env.db, lateProject.id)).toBeNull();
        expect(cloudflare.fetcher).not.toHaveBeenCalled();
      } else {
        // A prior API version could create and checkpoint a public exception
        // while wildcard teardown was failed. Preserve this reachable upgrade
        // state to prove finalization revisits outstanding cleanup handles.
        const bypassName = 'void-late-disable-public-checkpoint';
        cloudflare.applications.set('late-bypass', {
          id: 'late-bypass',
          name: bypassName,
          aud: 'late-bypass-audience',
          type: 'self_hosted',
          domain: `${project.slug}.apps.example.com`,
          policies: [{ decision: 'bypass', include: [{ everyone: {} }] }],
        });
        await env.db
          .update(projectZeroTrust)
          .set({
            bypass_application_id: 'late-bypass',
            bypass_application_name: bypassName,
          })
          .where(eq(projectZeroTrust.project_id, project.id));
      }

      failWildcardDelete = false;
      await reconcilePlatformZeroTrust(platform, env.db);

      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: false,
        lastError: null,
        wildcardApplication: null,
        operation: null,
      });
      for (const projectId of [project.id, ...(lateProjectId ? [lateProjectId] : [])]) {
        expect(await getProjectZeroTrustState(env.db, projectId)).toMatchObject({
          desired_protected: false,
          effective_protected: false,
          status: 'ready',
          bypass_application_id: null,
          bypass_application_name: null,
          protected_application_id: null,
        });
      }
      expect(cloudflare.applications.size).toBe(0);
      const deletedIds = cloudflare.fetcher.mock.calls
        .filter(([, init]) => init?.method === 'DELETE')
        .map(([input]) => new URL(input.toString()).pathname.split('/').at(-1));
      expect(deletedIds).toEqual(
        lateChange === 'saved bypass checkpoint'
          ? [wildcard!.id, health!.id, 'late-bypass']
          : [wildcard!.id, health!.id],
      );
      expect(
        cloudflare.fetcher.mock.calls.some(
          ([, init]) => init?.method === 'POST' || init?.method === 'PUT',
        ),
      ).toBe(false);
    },
  );

  it.each(['reconcile', 'disable'] as const)(
    'clears 601 public custom-domain routes across bounded %s calls',
    async (operation) => {
      const owner = await createTestUser(env.db, 'many-domains-owner');
      const project = await createTestProject(env.db, owner.id, `many-domains-${operation}`);
      const cloudflare = accessApi();
      vi.stubGlobal('fetch', cloudflare.fetcher);
      const platform = bindings();
      await configurePlatformZeroTrust(
        platform,
        env.db,
        configurationInput({ protectNewProjects: false, existingProjects: 'public' }),
      );
      const hostnames = Array.from(
        { length: 601 },
        (_, index) => `public-${String(index).padStart(3, '0')}.example.net`,
      );
      await env.db.insert(domains).values(
        hostnames.map((hostname, index) => ({
          id: `public-domain-${index}`,
          project_id: project.id,
          hostname,
          cf_hostname_id: `cf-public-domain-${index}`,
          status: 'active' as const,
        })),
      );
      const routingKeys = [project.slug, ...hostnames.map((hostname) => `domain:${hostname}`)];
      const staleProtection = {
        teamDomain: 'https://company.cloudflareaccess.com',
        audiences: [{ hostname: '*.apps.example.com', audience: 'stale-audience' }],
      };
      for (const key of routingKeys) {
        await env.ROUTING.put(
          key,
          JSON.stringify({
            worker: project.id,
            customProperty: 'keep',
            zeroTrust: staleProtection,
          }),
        );
      }
      const originalRow = await getProjectZeroTrustState(env.db, project.id);
      await expect(
        setProjectZeroTrustProtection(platform, env.db, project.id, true),
      ).rejects.toThrow('at most 100 custom domains');
      expect(await getProjectZeroTrustState(env.db, project.id)).toEqual(originalRow);
      expect(cloudflare.applications.size).toBe(3);

      const routingPut = vi.spyOn(env.ROUTING, 'put');
      const rewrittenKeys = new Set<string>();
      let remaining = routingKeys.length;
      let calls = 0;
      for (; calls < 5 && remaining > 0; calls++) {
        routingPut.mockClear();
        if (calls === 0 && operation === 'disable') {
          await disablePlatformZeroTrust(platform, env.db);
        } else {
          await reconcilePlatformZeroTrust(platform, env.db);
        }
        expect(
          routingPut.mock.calls.length,
          `cleanup call ${calls + 1}: ${remaining} routes remain`,
        ).toBeGreaterThan(0);
        expect(routingPut.mock.calls.length).toBeLessThanOrEqual(300);
        for (const [key] of routingPut.mock.calls) {
          expect(rewrittenKeys.has(key)).toBe(false);
          rewrittenKeys.add(key);
        }
        const entries = await Promise.all(
          routingKeys.map(
            async (key) => JSON.parse((await env.ROUTING.get(key))!) as Record<string, unknown>,
          ),
        );
        const nextRemaining = entries.filter((entry) => Object.hasOwn(entry, 'zeroTrust')).length;
        expect(nextRemaining).toBeLessThan(remaining);
        remaining = nextRemaining;
        for (const entry of entries) {
          expect(entry).toMatchObject({ worker: project.id, customProperty: 'keep' });
        }
        if (remaining > 0) {
          expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
            enabled: true,
            operation: { kind: operation, owner: null },
          });
          expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
            status: 'reconciling',
            bypass_application_id: originalRow!.bypass_application_id,
          });
          expect(cloudflare.applications.has(originalRow!.bypass_application_id!)).toBe(true);
        }
      }
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(remaining).toBe(0);
      expect(rewrittenKeys.size).toBe(routingKeys.length);
      expect(await getProjectZeroTrustState(env.db, project.id)).toMatchObject({
        status: 'ready',
        desired_protected: false,
        effective_protected: false,
        routing_cursor: null,
      });
      expect(await readZeroTrustConfigurationStrict(env.db)).toMatchObject({
        enabled: operation !== 'disable',
        lastError: null,
        operation: null,
      });
      expect(cloudflare.applications.size).toBe(operation === 'disable' ? 0 : 3);
    },
  );
});
