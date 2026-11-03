import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { verifyPrerenderToken } from '../../src/auth/deploy-token.ts';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import app from '../../src/index.ts';
import * as projectAccess from '../../src/project-access.ts';
import { deriveAiUsageTag } from '../../src/proxy-token.ts';
import {
  deployments,
  domains,
  platformSettings,
  projectAccessEvents,
  projectDeployCredentials,
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  projects,
  projectSecrets,
  projectZeroTrust,
  resources,
  users,
} from '../../src/schema.ts';
import {
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authed(path: string, jwt: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function projectState() {
  return Promise.all([
    env.db.select().from(projects),
    env.db.select().from(projectMembers),
    env.db.select().from(projectInvitations),
    env.db.select().from(projectAccessEvents),
    env.db.select().from(projectDeployCredentials),
    env.db.select().from(deployments),
    env.db.select().from(projectSecrets),
    env.db.select().from(domains),
    env.db.select().from(resources),
  ]);
}

async function seedZeroTrustConfiguration(
  status: 'configuring' | 'error' | 'disabling' | 'ready',
  operationKind: 'reconcile' | 'disable' | null,
): Promise<void> {
  await env.db.insert(platformSettings).values({
    key: 'zeroTrust.configuration',
    value: {
      version: 1,
      revision: 1,
      enabled: true,
      protectNewProjects: false,
      accountId: env.CF_ACCOUNT_ID,
      teamDomain: 'https://company.cloudflareaccess.com',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      credential: { ciphertext: 'unused', iv: 'unused', keyVersion: 'v1' },
      wildcardApplicationName: 'void-test-projects',
      wildcardApplication: {
        id: 'access-wildcard',
        name: 'void-test-projects',
        audience: 'access-audience',
        destinations: ['*.void.app'],
      },
      operation: operationKind
        ? {
            id: 'saved-operation',
            kind: operationKind,
            phase: 'projects',
            owner: null,
            leaseExpiresAt: null,
            startedAt: new Date().toISOString(),
            existingProjects: null,
          }
        : null,
      lastError: status === 'error' ? 'Access token was revoked' : null,
      updatedAt: new Date().toISOString(),
    },
  });
}

describe('project route membership capabilities', () => {
  it.each([
    ['POST', '/deploy', 'Deploying requires the collaborator, admin, or owner role'],
    ['POST', '/deploy/preflight', 'Deploying requires the collaborator, admin, or owner role'],
    ['POST', '/deploy/upload-urls', 'Deploying requires the collaborator, admin, or owner role'],
    ['POST', '/prerender-token', 'Deploying requires the collaborator, admin, or owner role'],
    ['POST', '/rollback', 'Deploying requires the collaborator, admin, or owner role'],
    [
      'POST',
      '/deployments/missing/cancel',
      'Deploying requires the collaborator, admin, or owner role',
    ],
    [
      'PUT',
      '/secrets/TEST_SECRET',
      'Changing project configuration requires the collaborator, admin, or owner role',
    ],
    [
      'DELETE',
      '/secrets/TEST_SECRET',
      'Changing project configuration requires the collaborator, admin, or owner role',
    ],
    [
      'POST',
      '/migrations/apply',
      'Changing project configuration requires the collaborator, admin, or owner role',
    ],
    [
      'PUT',
      '/database-url',
      'Changing project configuration requires the collaborator, admin, or owner role',
    ],
    ['POST', '/domains', 'Changing project settings requires the admin or owner role'],
    [
      'POST',
      '/invitations',
      'Managing project members and invitations requires the admin or owner role',
    ],
    [
      'PATCH',
      '/members/missing',
      'Managing project members and invitations requires the admin or owner role',
    ],
    [
      'DELETE',
      '/members/missing',
      'Managing project members and invitations requires the admin or owner role',
    ],
    ['DELETE', '', 'Only the project owner can delete this project'],
  ])('explains reader denial for %s %s without side effects', async (method, suffix, guidance) => {
    const owner = await createTestUser(env.db, 'private-owner');
    const reader = await createTestUser(env.db, 'reader');
    const project = await createTestProject(env.db, owner.id, 'private-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: reader.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    const before = await projectState();
    const provider = vi.fn(() => {
      throw new Error('Denied request must not contact a provider');
    });
    vi.stubGlobal('fetch', provider);
    const routingWrite = vi.spyOn(env.ROUTING, 'put');
    const response = await app.fetch(
      authed(
        `/projects/${project.id}${suffix}`,
        reader.jwt,
        method,
        method === 'DELETE'
          ? undefined
          : {
              value: 'must-not-be-written',
              role: 'admin',
              email: 'nobody@example.com',
            },
      ),
      env,
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body).toEqual({ error: 'forbidden', message: expect.stringContaining(guidance) });
    expect(body.message).toMatch(/Ask (a project admin or owner|the owner)/);
    for (const privateValue of [owner.id, owner.login, project.id, project.slug]) {
      expect(JSON.stringify(body)).not.toContain(privateValue);
    }
    expect(await projectState()).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
    expect(routingWrite).not.toHaveBeenCalled();
  });

  it.each(['reader', 'collaborator', 'admin', 'nonmember'] as const)(
    'explains owner-only token access to a %s without changing credentials',
    async (role) => {
      const owner = await createTestUser(env.db, 'private-owner');
      const actor = await createTestUser(env.db, 'actor');
      const project = await createTestProject(env.db, owner.id, 'private-project');
      if (role !== 'nonmember') {
        await env.db.insert(projectMembers).values({
          project_id: project.id,
          user_id: actor.id,
          role,
          added_by_user_id: owner.id,
        });
      }
      await env.db.insert(projectDeployCredentials).values({
        id: 'existing-credential',
        project_id: project.id,
        issued_by: owner.id,
        name: 'private-token-name',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const before = await projectState();
      for (const [method, suffix] of [
        ['GET', '/tokens'],
        ['POST', '/tokens'],
        ['POST', '/tokens/existing-credential/renew'],
        ['DELETE', '/tokens/existing-credential'],
      ]) {
        const response = await app.fetch(
          authed(`/projects/${project.id}${suffix}`, actor.jwt, method),
          env,
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: 'forbidden',
          message:
            'Only the project owner can manage deploy tokens. Ask the owner to create or manage a token.',
        });
        expect(await projectState()).toEqual(before);
      }
    },
  );

  it('does not guess a nonmember role or expose private details in read denials', async () => {
    const owner = await createTestUser(env.db, 'private-owner');
    const stranger = await createTestUser(env.db, 'stranger');
    const project = await createTestProject(env.db, owner.id, 'private-project');
    const before = await projectState();
    const denied = await app.fetch(authed(`/projects/${project.id}`, stranger.jwt), env);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'forbidden',
      message:
        'You need project access to view this project. Ask a project admin or owner to invite you.',
    });
    const missing = await app.fetch(authed('/projects/missing', stranger.jwt), env);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'project not found',
      message:
        'This project could not be found. Check the project ID or refresh your project list.',
    });
    expect(await projectState()).toEqual(before);
  });

  it('explains owner suspension to a member without exposing the suspension reason', async () => {
    const owner = await createTestUser(env.db, 'private-owner');
    const reader = await createTestUser(env.db, 'reader');
    const project = await createTestProject(env.db, owner.id, 'private-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: reader.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'private policy violation details' })
      .where(eq(users.id, owner.id));
    const before = await projectState();
    const response = await app.fetch(authed(`/projects/${project.id}`, reader.jwt), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message:
        "This project's owner account is suspended. Ask the owner to contact the platform administrator to restore access.",
    });
    expect(await projectState()).toEqual(before);
  });

  it('lets readers inspect Zero Trust while reserving overrides for project admins and owners', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-owner');
    const reader = await createTestUser(env.db, 'zero-trust-reader');
    const collaborator = await createTestUser(env.db, 'zero-trust-collaborator');
    const admin = await createTestUser(env.db, 'zero-trust-admin');
    const project = await createTestProject(env.db, owner.id, 'zero-trust-roles');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
      protected_application_id: 'access-app-internal',
      protected_application_name: 'void-internal-name',
      protected_application_audience: 'internal-audience',
    });

    const status = await app.fetch(authed(`/projects/${project.id}/zero-trust`, reader.jwt), env);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      available: false,
      platformStatus: 'not_configured',
      protectNewProjects: false,
      project: {
        project_id: project.id,
        desired_protected: true,
        effective_protected: true,
        state: 'protected',
        last_error: null,
        updated_at: expect.any(String),
      },
    });

    const collaboratorUpdate = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/zero-trust`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${collaborator.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ protected: true }),
      }),
      env,
    );
    expect(collaboratorUpdate.status).toBe(403);

    const adminUpdate = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/zero-trust`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${admin.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ protected: true }),
      }),
      env,
    );
    expect(adminUpdate.status).toBe(409);
    expect(await adminUpdate.json()).toEqual({
      error: 'Project Zero Trust is not ready on this platform.',
      message: expect.stringContaining('void project zero-trust status'),
    });
  });

  it.each([
    ['configuring', 'reconcile', false],
    ['error', 'reconcile', false],
    ['disabling', 'disable', false],
    ['ready', null, true],
  ] as const)(
    'reports Zero Trust as available only when admins can change it (%s)',
    async (status, operationKind, available) => {
      const owner = await createTestUser(env.db, `zero-trust-available-${status}`);
      const project = await createTestProject(env.db, owner.id, `zero-trust-available-${status}`);
      await seedZeroTrustConfiguration(status, operationKind);

      const response = await app.fetch(
        authed(`/projects/${project.id}/zero-trust`, owner.jwt),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available, platformStatus: status });
    },
  );

  it.each([
    ['PUT', '/zero-trust', { protected: true }],
    ['POST', '/zero-trust/reconcile', undefined],
  ] as const)(
    'rechecks settings capability under the project lock for %s %s',
    async (method, suffix, body) => {
      const owner = await createTestUser(env.db, `zero-trust-race-owner-${method}`);
      const admin = await createTestUser(env.db, `zero-trust-race-admin-${method}`);
      const project = await createTestProject(env.db, owner.id, `zero-trust-race-${method}`);
      await env.db.insert(projectMembers).values({
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      });
      await seedZeroTrustConfiguration('ready', null);
      await env.db.insert(projectZeroTrust).values({
        project_id: project.id,
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        bypass_application_id: 'access-bypass',
        bypass_application_name: 'void-test-public',
      });
      const route = JSON.stringify({ projectId: project.id, userId: owner.id });
      await env.ROUTING.put(project.slug, route);
      const before = await env.db.select().from(projectZeroTrust);
      const fetch = vi.fn(async () => Response.json({ success: false }, { status: 500 }));
      vi.stubGlobal('fetch', fetch);

      // Return the route's access snapshot, then commit the demotion. The
      // service must re-resolve the admin under the project lock.
      const requireCapability = projectAccess.requireProjectCapability;
      let demoted = false;
      vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
        const result = await requireCapability(...args);
        if (!demoted && args[3] === 'settings') {
          demoted = true;
          await env.db
            .update(projectMembers)
            .set({ role: 'reader' })
            .where(eq(projectMembers.user_id, admin.id));
        }
        return result;
      });

      const response = await app.fetch(
        authed(`/projects/${project.id}${suffix}`, admin.jwt, method, body),
        env,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'forbidden',
        message: expect.stringContaining(
          'Changing project settings requires the admin or owner role',
        ),
      });
      expect(demoted).toBe(true);
      expect(await env.db.select().from(projectZeroTrust)).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.ROUTING.get(project.slug)).toBe(route);
    },
  );

  it('reports malformed saved Zero Trust configuration without exposing a server error', async () => {
    const owner = await createTestUser(env.db, 'zero-trust-invalid-owner');
    const project = await createTestProject(env.db, owner.id, 'zero-trust-invalid');
    await env.db.insert(platformSettings).values({
      key: 'zeroTrust.configuration',
      value: {
        version: 1,
        revision: 1,
        enabled: false,
        protectNewProjects: true,
        accountId: env.CF_ACCOUNT_ID,
        teamDomain: 'not a URL',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        credential: { ciphertext: 'saved', iv: 'saved', keyVersion: 'v1' },
        wildcardApplicationName: 'void-test-projects',
        wildcardApplication: null,
        operation: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    });

    const response = await app.fetch(authed(`/projects/${project.id}/zero-trust`, owner.jwt), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: false,
      platformStatus: 'invalid_configuration',
    });
  });

  it('lists shared projects with role and owner and grants readers view routes', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const reader = await createTestUser(env.db, 'reader');
    const project = await createTestProject(env.db, owner.id, 'shared-reader-app');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: reader.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    mockCfApi();

    const listResponse = await app.fetch(authed('/projects', reader.jwt), env);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject([
      {
        id: project.id,
        slug: project.slug,
        role: 'reader',
        owner: { id: owner.id, login: 'owner' },
      },
    ]);

    const detail = await app.fetch(authed(`/projects/${project.id}`, reader.jwt), env);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: project.id,
      role: 'reader',
      owner: { id: owner.id },
    });

    const resources = await app.fetch(authed(`/projects/${project.id}/resources`, reader.jwt), env);
    expect(resources.status).toBe(200);
    expect(await resources.json()).toEqual([]);

    const secrets = await app.fetch(authed(`/projects/${project.id}/secrets`, reader.jwt), env);
    expect(secrets.status).toBe(403);
    const deletion = await app.fetch(authed(`/projects/${project.id}`, reader.jwt, 'DELETE'), env);
    expect(deletion.status).toBe(403);
  });

  it('allows collaborators to use deploy prerequisites under the owner account', async () => {
    const owner = await createTestUser(env.db, 'paid-owner', 'github', undefined, 'pro');
    const collaborator = await createTestUser(env.db, 'collaborator');
    const project = await createTestProject(env.db, owner.id, 'shared-deploy-app');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    const secrets = await app.fetch(
      authed(`/projects/${project.id}/secrets`, collaborator.jwt),
      env,
    );
    expect(secrets.status).toBe(200);

    const tokenResponse = await app.fetch(
      authed(`/projects/${project.id}/prerender-token`, collaborator.jwt, 'POST'),
      env,
    );
    expect(tokenResponse.status).toBe(200);
    const { token } = (await tokenResponse.json()) as { token: string };
    const payload = await verifyPrerenderToken(token, JWT_SECRET);
    expect(payload).toMatchObject({
      sub: collaborator.id,
      login: collaborator.login,
      project: project.id,
      aud: 'prerender',
    });
  });
});

describe('managed build platform capability', () => {
  function withoutManagedBuilds(): TestEnv {
    return {
      ...env,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ...getPlatformCapabilities(env),
        managedBuilds: false,
      }),
    };
  }

  it('serves project usage when managed builds are disabled', async () => {
    const owner = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/analytics_engine/sql')) {
          return Response.json({ data: [{ requests: 12, bandwidth_bytes: 34 }] });
        }
        if (url.includes('/graphql')) {
          return Response.json({
            data: {
              viewer: {
                accounts: [{ aiGatewayRequests: [{ sum: { cost: 0.000022 } }] }],
              },
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const response = await app.fetch(
      authed(`/projects/${project.id}/usage`, owner.jwt),
      withoutManagedBuilds(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectId: project.id,
      requests: 12,
      bandwidthBytes: 34,
      aiNeurons: 2,
    });
  });

  it.each(['GET', 'POST', 'PATCH', 'DELETE'])(
    'keeps %s project GitHub connections unavailable when managed builds are disabled',
    async (method) => {
      const owner = await createTestUser(env.db);
      const project = await createTestProject(env.db, owner.id);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await app.fetch(
        authed(`/projects/${project.id}/github`, owner.jwt, method, {}),
        withoutManagedBuilds(),
      );
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ capability: 'managedBuilds' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('ownership-period account usage', () => {
  it('reports unavailable usage rather than zero when analytics fails', async () => {
    const owner = await createTestUser(env.db, 'usage-owner');
    const project = await createTestProject(env.db, owner.id, 'usage-app');
    await env.db
      .update(users)
      .set({ billing_cycle_start: new Date(Date.now() - 86_400_000).toISOString() })
      .where(eq(users.id, owner.id));
    await env.db
      .delete(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    await env.db.insert(projectOwnershipPeriods).values({
      id: 'pown_usage',
      project_id: project.id,
      owner_user_id: owner.id,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 503 })),
    );

    const response = await app.fetch(authed('/usage', owner.jwt), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'usage unavailable' });
  });

  it('queries only the former owner interval that overlaps the billing window', async () => {
    const formerOwner = await createTestUser(env.db, 'former-owner');
    const currentOwner = await createTestUser(env.db, 'current-owner');
    const project = await createTestProject(env.db, currentOwner.id, 'transferred-app');
    const now = Date.now();
    const billingStart = new Date(now - 10 * 24 * 60 * 60 * 1_000);
    const ownedFrom = new Date(now - 8 * 24 * 60 * 60 * 1_000);
    const transferredAt = new Date(now - 2 * 24 * 60 * 60 * 1_000);
    await env.db
      .update(users)
      .set({ billing_cycle_start: billingStart.toISOString() })
      .where(eq(users.id, formerOwner.id));
    await env.db
      .delete(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    await env.db.insert(projectOwnershipPeriods).values([
      {
        id: 'pown_former',
        project_id: project.id,
        owner_user_id: formerOwner.id,
        starts_at: ownedFrom.toISOString(),
        ends_at: transferredAt.toISOString(),
      },
      {
        id: 'pown_current',
        project_id: project.id,
        owner_user_id: currentOwner.id,
        starts_at: transferredAt.toISOString(),
      },
    ]);

    const analyticsQueries: Array<string> = [];
    const graphqlQueries: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/analytics_engine/sql')) {
          analyticsQueries.push(String(init?.body));
          return Response.json({
            data: [{ blob1: project.id, requests: 12, bandwidth_bytes: 34 }],
          });
        }
        if (url.includes('/graphql')) {
          const body = JSON.parse(String(init?.body)) as { query: string };
          graphqlQueries.push(body.query);
          return Response.json({
            data: {
              viewer: {
                accounts: [{ aiGatewayRequests: [{ sum: { cost: 0.000022 } }] }],
              },
            },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const response = await app.fetch(authed('/usage', formerOwner.jwt), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requests: 12,
      bandwidthBytes: 34,
      aiNeurons: 2,
      projects: [{ projectId: project.id, slug: project.slug, aiNeurons: 2 }],
    });
    expect(analyticsQueries).toHaveLength(1);
    expect(analyticsQueries[0]).toContain(ownedFrom.toISOString().replace('T', ' ').slice(0, 19));
    expect(analyticsQueries[0]).toContain(
      transferredAt.toISOString().replace('T', ' ').slice(0, 19),
    );
    expect(graphqlQueries).toHaveLength(1);
    expect(graphqlQueries[0]).toContain(
      `metadataRaw: ${JSON.stringify(
        JSON.stringify({ projectId: await deriveAiUsageTag(JWT_SECRET, project.id) }),
      )}`,
    );
    expect(graphqlQueries[0]).toContain(`datetime_geq: "${ownedFrom.toISOString()}"`);
    expect(graphqlQueries[0]).toContain(`datetime_lt: "${transferredAt.toISOString()}"`);
  });
});
