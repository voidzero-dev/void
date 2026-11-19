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
import { app } from '../../src/index.ts';
import {
  domains,
  platformSettings,
  projectZeroTrust,
  securityPublicRequests,
} from '../../src/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { initializeNewProjectZeroTrust } from '../../src/zero-trust/project.ts';
import { resolveProjectZeroTrustRoutingForPublication } from '../../src/zero-trust/routing.ts';
import { getProjectZeroTrustState } from '../../src/zero-trust/state.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';
import { askPublic, gateBindings, setupGate } from './security-gate-fixtures.ts';

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

const input = {
  apiToken: 'access-management-token',
  identityProviderIds: ['idp-1'],
  policyIds: ['policy-1'],
  protectNewProjects: true,
};

function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let nextApplication = 1;
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(request.toString());
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
      return Response.json({ success: true, result: [...applications.values()] });
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
        : Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
  return { applications, fetcher };
}

async function operator(
  path: string,
  init: RequestInit = {},
  platform: ApiEnv['Bindings'] = bindings(),
): Promise<Response> {
  const admin = await createTestUser(
    env.db,
    `surface-admin-${crypto.randomUUID()}`,
    'github',
    undefined,
    'free',
    'admin',
  );
  const token = await createOperatorToken(env.db, admin);
  return app.fetch(
    new Request('http://localhost/operator/v1' + path, {
      ...init,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    }),
    platform,
  );
}

async function corruptSavedConfiguration(): Promise<void> {
  await env.db
    .update(platformSettings)
    .set({ value: { version: 1, revision: 99 } })
    .where(eq(platformSettings.key, 'zeroTrust.configuration'));
}

describe('Zero Trust existing-project choice', () => {
  it('requires the choice only when enabling and rejects it once enabled', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);

    await expect(configurePlatformZeroTrust(bindings(), env.db, input)).rejects.toThrow(
      'Enabling Zero Trust needs a choice for existing projects',
    );
    expect(cloudflare.fetcher).not.toHaveBeenCalled();

    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });
    cloudflare.fetcher.mockClear();
    await expect(
      configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'protected' }),
    ).rejects.toThrow('Zero Trust is already enabled');
    expect(cloudflare.fetcher).not.toHaveBeenCalled();
    await expect(configurePlatformZeroTrust(bindings(), env.db, input)).resolves.toMatchObject({
      enabled: true,
      status: 'ready',
    });
  });

  it('rejects the same choices in a configure preview', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    const plan = (body: Record<string, unknown>) =>
      operator('/zero-trust/configure', {
        method: 'POST',
        body: JSON.stringify({ ...input, ...body, dryRun: true }),
      });

    const missing = await plan({});
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({
      message: expect.stringContaining('Enabling Zero Trust needs a choice for existing projects'),
    });
    expect((await plan({ existingProjects: 'public' })).status).toBe(200);

    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });
    const extra = await plan({ existingProjects: 'public' });
    expect(extra.status).toBe(409);
    expect(await extra.json()).toMatchObject({
      message: expect.stringContaining('Zero Trust is already enabled'),
    });
    expect((await plan({})).status).toBe(200);
  });

  it('stores the installation account without an account in the request', async () => {
    vi.stubGlobal('fetch', accessApi().fetcher);
    await expect(
      configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' }),
    ).resolves.toMatchObject({ accountId: env.CF_ACCOUNT_ID });
  });
});

describe('Zero Trust routing publication', () => {
  it('scopes the deny-all marker to protected rows when the saved configuration is invalid', async () => {
    const owner = await createTestUser(env.db, 'surface-publication-owner');
    const protectedProject = await createTestProject(env.db, owner.id, 'surface-protected');
    const publicProject = await createTestProject(env.db, owner.id, 'surface-public');
    const unknownProject = await createTestProject(env.db, owner.id, 'surface-unknown');
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });
    await env.db
      .update(projectZeroTrust)
      .set({ desired_protected: true, status: 'reconciling' })
      .where(eq(projectZeroTrust.project_id, protectedProject.id));
    await env.db.delete(projectZeroTrust).where(eq(projectZeroTrust.project_id, unknownProject.id));
    expect(
      (await getProjectZeroTrustState(env.db, publicProject.id))?.bypass_application_id,
    ).toBeTruthy();
    await corruptSavedConfiguration();

    const deny = { teamDomain: '', audiences: [] };
    await expect(
      resolveProjectZeroTrustRoutingForPublication(env.db, protectedProject.id),
    ).resolves.toEqual(deny);
    await expect(
      resolveProjectZeroTrustRoutingForPublication(env.db, protectedProject.id, {
        retryable: true,
      }),
    ).resolves.toEqual(deny);
    // A durable bypass keeps a public project reachable.
    await expect(
      resolveProjectZeroTrustRoutingForPublication(env.db, publicProject.id, { retryable: true }),
    ).resolves.toBeNull();
    // Unknown protection: a retryable writer waits, any other writer fails closed.
    await expect(
      resolveProjectZeroTrustRoutingForPublication(env.db, unknownProject.id, { retryable: true }),
    ).rejects.toThrow('saved Zero Trust configuration is invalid');
    await expect(
      resolveProjectZeroTrustRoutingForPublication(env.db, unknownProject.id),
    ).resolves.toEqual(deny);
  });
});

describe('Zero Trust request surfaces', () => {
  it('reports an invalid saved configuration as server state, not a bad request', async () => {
    const owner = await createTestUser(env.db, 'surface-invalid-owner');
    const project = await createTestProject(env.db, owner.id, 'surface-invalid');
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });
    await corruptSavedConfiguration();

    const reconcile = await operator('/zero-trust/reconcile', { method: 'POST', body: '{}' });
    expect(reconcile.status).toBe(500);
    expect(await reconcile.json()).toMatchObject({
      error: 'invalid_saved_zero_trust_configuration',
      message: expect.stringContaining('zeroTrust.configuration'),
    });

    const invalidInput = await operator('/zero-trust/configure', {
      method: 'POST',
      body: JSON.stringify({ ...input, existingProjects: 'everything' }),
    });
    expect(invalidInput.status).toBe(400);

    const update = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/zero-trust`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: true }),
      }),
      bindings(),
    );
    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({
      message: expect.stringContaining('Ask a platform administrator to repair it'),
    });
  });

  it('returns the user project shape plus explicit operator fields', async () => {
    const owner = await createTestUser(env.db, 'surface-shape-owner');
    const project = await createTestProject(env.db, owner.id, 'surface-shape');
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });
    const row = (await getProjectZeroTrustState(env.db, project.id))!;

    const response = await operator(`/zero-trust/projects/${project.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project: {
        project_id: project.id,
        desired_protected: false,
        effective_protected: false,
        state: 'public',
        last_error: null,
        updated_at: row.updated_at,
        bypass_application_id: row.bypass_application_id,
        bypass_application_name: row.bypass_application_name,
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
        routing_cursor: null,
        reconciled_operation: row.reconciled_operation,
        created_at: row.created_at,
      },
    });

    const updated = await operator(`/zero-trust/projects/${project.id}`, {
      method: 'POST',
      body: JSON.stringify({ protected: true }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      ok: true,
      project: { state: 'protected', bypass_application_id: null },
    });
  });

  it('checks Cloudflare from the status route only when asked', async () => {
    const cloudflare = accessApi();
    vi.stubGlobal('fetch', cloudflare.fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });
    cloudflare.fetcher.mockClear();

    const saved = await operator('/zero-trust');
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: 'ready', checked: false, live: null });
    expect(cloudflare.fetcher).not.toHaveBeenCalled();

    const checked = await operator('/zero-trust?check=true');
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({
      checked: true,
      live: { present: true, drifted: false },
    });
    expect(cloudflare.fetcher).toHaveBeenCalled();
  });
});

describe('Zero Trust domain activation', () => {
  it('keeps a custom domain pending until the project protection is known', async () => {
    const owner = await createTestUser(env.db, 'surface-domain-owner');
    const project = await createTestProject(env.db, owner.id, 'surface-domain');
    const cloudflare = accessApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: string | URL | Request, init?: RequestInit) =>
        new URL(request.toString()).pathname.includes('/custom_hostnames/')
          ? Response.json({
              success: true,
              result: {
                id: 'ch-surface-domain',
                hostname: 'surface-domain.example.com',
                status: 'active',
                ssl: { status: 'active', method: 'http', type: 'dv' },
              },
            })
          : cloudflare.fetcher(request, init),
      ),
    );
    await configurePlatformZeroTrust(bindings(), env.db, {
      ...input,
      protectNewProjects: false,
      existingProjects: 'public',
    });
    await env.db.delete(projectZeroTrust).where(eq(projectZeroTrust.project_id, project.id));
    await env.db.insert(domains).values({
      id: 'dom_surface_domain',
      project_id: project.id,
      hostname: 'surface-domain.example.com',
      cf_hostname_id: 'ch-surface-domain',
      status: 'pending',
    });
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'user-surface-domain', projectId: project.id }),
    );
    const domainStatus = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}/domains/dom_surface_domain`, {
          headers: { Authorization: `Bearer ${owner.jwt}` },
        }),
        bindings(),
      );

    const waiting = await domainStatus();
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toMatchObject({ status: 'pending', awaiting_deployment: false });
    expect(await env.ROUTING.get('domain:surface-domain.example.com')).toBeNull();

    await initializeNewProjectZeroTrust(bindings(), env.db, project.id);
    const activated = await domainStatus();
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({ status: 'active' });
    const published = JSON.parse((await env.ROUTING.get('domain:surface-domain.example.com'))!);
    expect(published).toMatchObject({ workerName: 'user-surface-domain', projectId: project.id });
    expect(published.zeroTrust).toBeUndefined();
  });
});

describe('Zero Trust surfaces with the public gate on', () => {
  it('answers the operator request 202 with the held request, and 200 once protected', async () => {
    const s = await setupGate(env);
    const platform = gateBindings(env);
    const path = `/zero-trust/projects/${s.project.id}`;

    const held = await operator(
      path,
      { method: 'POST', body: JSON.stringify({ protected: false }) },
      platform,
    );
    expect(held.status).toBe(202);
    expect(await held.json()).toMatchObject({
      ok: true,
      held: true,
      project: { desired_protected: true, state: 'protected' },
      publicRequest: { state: 'needs_deploy' },
    });

    const canceled = await operator(
      path,
      { method: 'POST', body: JSON.stringify({ protected: true }) },
      platform,
    );
    expect(canceled.status).toBe(200);
    const body = (await canceled.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, publicRequest: { state: 'canceled' } });
    expect(body.held).toBeUndefined();
  });

  it('previews the operator request as held without writing', async () => {
    const s = await setupGate(env);
    const platform = gateBindings(env);
    const path = `/zero-trust/projects/${s.project.id}`;

    const dryRun = await operator(
      path,
      { method: 'POST', body: JSON.stringify({ protected: false, dryRun: true }) },
      platform,
    );
    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({
      dryRun: true,
      action: 'zero-trust.project',
      target: s.project.id,
      publicGate: true,
      publicRequest: null,
      heldByGate: true,
      protected: false,
      previous: { desired_protected: true },
    });
    expect(await env.db.select().from(securityPublicRequests)).toHaveLength(0);

    await askPublic(s);
    const open = await operator(
      path,
      { method: 'POST', body: JSON.stringify({ protected: true, dryRun: true }) },
      platform,
    );
    expect(await open.json()).toMatchObject({
      publicGate: true,
      heldByGate: false,
      publicRequest: { state: 'needs_deploy' },
    });
  });

  it('previews a plain change without the gate', async () => {
    const owner = await createTestUser(env.db, 'surface-preview-owner');
    const project = await createTestProject(env.db, owner.id, 'surface-preview');
    vi.stubGlobal('fetch', accessApi().fetcher);
    await configurePlatformZeroTrust(bindings(), env.db, { ...input, existingProjects: 'public' });

    const response = await operator(`/zero-trust/projects/${project.id}`, {
      method: 'POST',
      body: JSON.stringify({ protected: true, dryRun: true }),
    });
    expect(await response.json()).toMatchObject({
      dryRun: true,
      publicGate: false,
      heldByGate: false,
      publicRequest: null,
    });
  });

  it('answers the project request 202 with the old-CLI-safe reconciling line', async () => {
    const s = await setupGate(env);
    const put = (protectedProject: boolean) =>
      app.fetch(
        new Request(`http://localhost/projects/${s.project.id}/zero-trust`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${s.user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protected: protectedProject }),
        }),
        gateBindings(env),
      );

    const held = await put(false);
    expect(held.status).toBe(202);
    expect(await held.json()).toMatchObject({
      ok: true,
      project: { state: 'reconciling', desired_protected: true, last_error: expect.any(String) },
      publicRequest: { state: 'needs_deploy' },
      message: expect.any(String),
    });
    const stored = await getProjectZeroTrustState(env.db, s.project.id);
    // The reconciling state and its line are for this reply only.
    expect(stored).toMatchObject({ desired_protected: true, last_error: null });

    expect((await put(true)).status).toBe(200);
  });
});
