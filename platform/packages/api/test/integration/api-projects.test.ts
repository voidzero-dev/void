import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vite-plus/test';
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import {
  signDeployToken,
  signProjectCredentialToken,
  verifyDeployToken,
  verifyPrerenderToken,
} from '../../src/auth/deploy-token.ts';
import { revokeConnectionSessions } from '../../src/auth/sessions.ts';
import {
  createDeployment,
  updateDeploymentStatus,
  markDeploymentRetained,
  setActiveDeployment,
  setAppliedMigrations,
} from '../../src/db.ts';
import * as db from '../../src/db.ts';
import app from '../../src/index.ts';
import * as projectAccess from '../../src/project-access.ts';
import {
  proxyTokenRotationStuckWarning,
  proxyTokenRotationTarget,
} from '../../src/proxy-token-rotation.ts';
import { deriveProxyInternalAuth, deriveProxyToken } from '../../src/proxy-token.ts';
import { users } from '../../src/schema.ts';
import {
  deployments,
  domains,
  emailDestinations,
  projects,
  projectMembers,
  resources,
  projectDatabaseCredentials,
  projectDeployCredentials,
  platformLoginConnections,
  platformSettings,
  projectCleanupJobs,
} from '../../src/schema.ts';
import {
  createTestBuild,
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  cfSuccess,
  cfError,
  type TestEnv,
} from './helpers.ts';
import { setTestDb } from './setup.ts';

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

describe('GET /projects', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: expect.stringMatching(/sign in to this platform/i),
    });
  });

  it('returns 401 when user has been deleted', async () => {
    const user = await createTestUser(env.db);
    await env.db.delete(users).where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'user not found',
      message: expect.stringMatching(/sign in with an active account/i),
    });
  });

  it('returns 403 when user is admin-suspended', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'account suspended',
      message: expect.stringMatching(/contact a platform administrator/i),
    });
  });

  it('allows usage-suspended user to list projects', async () => {
    const user = await createTestUser(env.db);
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('returns empty array when no projects', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns only the authenticated user's projects", async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    await createTestProject(env.db, alice.id, 'alice-app');
    await createTestProject(env.db, bob.id, 'bob-app');
    mockCfApi();

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${alice.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const projects = (await res.json()) as Array<{ slug: string }>;
    expect(projects).toHaveLength(1);
    expect(projects[0].slug).toBe('alice-app');
  });

  it('omits shared projects whose owner is manually suspended but keeps usage-suspended projects', async () => {
    const owner = await createTestUser(env.db, 'list-suspended-owner');
    const collaborator = await createTestUser(env.db, 'list-suspended-collaborator');
    const project = await createTestProject(env.db, owner.id, 'list-suspended-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, owner.id));

    const list = () =>
      app.fetch(
        new Request('http://localhost/projects', {
          headers: { Authorization: `Bearer ${collaborator.jwt}` },
        }),
        env,
      );
    const suspended = await list();
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toEqual([]);

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, owner.id));
    mockCfApi();
    const usageSuspended = await list();
    expect(usageSuspended.status).toBe(200);
    expect((await usageSuspended.json()) as Array<{ id: string }>).toMatchObject([
      { id: project.id },
    ]);
  });

  it('returns deployment, traffic, and health summaries sorted by attention', async () => {
    const user = await createTestUser(env.db, 'overview-user');
    const alpha = await createTestProject(env.db, user.id, 'alpha');
    const beta = await createTestProject(env.db, user.id, 'beta');
    const alphaDeploy = await createTestDeployment(env.db, alpha.id, 'live', 'main');
    const betaDeploy = await createTestDeployment(env.db, beta.id, 'failed', 'preview');
    await env.db.insert(domains).values({
      id: 'dom_alpha',
      project_id: alpha.id,
      hostname: 'alpha.example.com',
      cf_hostname_id: 'cf-alpha',
      status: 'active',
    });

    const bucketNow = Math.floor(Date.now() / 1000 / 15) * 15;
    const lastSeen = new Date().toISOString();
    mockCfApi({
      analyticsQuery: (_url, init) => {
        expect(init?.body).toContain('FROM void_requests');
        expect(init?.body).toContain('WHERE blob1 IN');
        return Response.json({
          data: [
            {
              project_id: alpha.id,
              bucket: bucketNow - 15,
              last_seen: lastSeen,
              requests: 4,
              responses_4xx: 1,
              responses_5xx: 0,
            },
            {
              project_id: beta.id,
              bucket: bucketNow,
              last_seen: lastSeen,
              requests: 9,
              responses_4xx: 0,
              responses_5xx: 2,
            },
          ],
        });
      },
    });

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    const projects = (await res.json()) as Array<{
      slug: string;
      custom_domain: string | null;
      latest_deployment: { id: string; status: string; source: string | null } | null;
      traffic: { requests5m: number; lastSeenAt: string | null; sparkline5m: Array<number> };
      health: { responses4xx15m: number; responses5xx15m: number; errorRate5xx15m: number };
    }>;

    expect(projects.map((p) => p.slug)).toEqual(['beta', 'alpha']);
    expect(projects[0].latest_deployment).toMatchObject({
      id: betaDeploy.id,
      status: 'failed',
      source: 'preview',
    });
    expect(projects[0].traffic.requests5m).toBe(9);
    expect(projects[0].traffic.lastSeenAt).toBe(lastSeen);
    expect(projects[0].traffic.sparkline5m).toHaveLength(20);
    expect(projects[0].health.responses5xx15m).toBe(2);
    expect(projects[0].health.errorRate5xx15m).toBeCloseTo(2 / 9);
    expect(projects[1].latest_deployment?.id).toBe(alphaDeploy.id);
    expect(projects[1].custom_domain).toBe('alpha.example.com');
    expect(projects[1].health.responses4xx15m).toBe(1);
  });
});

describe('GET /projects/resolve', () => {
  const resolve = (slug: string, token?: string) =>
    app.fetch(
      new Request(`http://localhost/projects/resolve?slug=${encodeURIComponent(slug)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }),
      env,
    );

  it('requires authentication and a valid slug', async () => {
    expect((await resolve('my-app')).status).toBe(401);
    const user = await createTestUser(env.db, 'resolve-validation');
    for (const path of ['/projects/resolve', '/projects/resolve?slug=Bad%20Slug']) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(response.status).toBe(400);
    }
  });

  it('returns the same project details as the ID lookup for owners and collaborators', async () => {
    const owner = await createTestUser(env.db, 'resolve-owner');
    const collaborator = await createTestUser(env.db, 'resolve-collaborator');
    const project = await createTestProject(env.db, owner.id, 'resolve-shared');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    const externalFetch = vi.fn(() => {
      throw new Error('project resolution must not query external analytics');
    });
    vi.stubGlobal('fetch', externalFetch);

    for (const user of [owner, collaborator]) {
      const resolved = await resolve(project.slug, user.jwt);
      const byId = await app.fetch(
        new Request(`http://localhost/projects/${project.id}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toEqual({ project: await byId.json() });
    }
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it('returns null for missing, inaccessible, and manually suspended projects', async () => {
    const owner = await createTestUser(env.db, 'resolve-private-owner');
    const other = await createTestUser(env.db, 'resolve-private-other');
    const project = await createTestProject(env.db, owner.id, 'resolve-private');
    expect(await (await resolve('resolve-missing', other.jwt)).json()).toEqual({ project: null });
    expect(await (await resolve(project.slug, other.jwt)).json()).toEqual({ project: null });

    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: other.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, owner.id));
    expect(await (await resolve(project.slug, other.jwt)).json()).toEqual({ project: null });
  });

  it('limits deploy credentials to their assigned project', async () => {
    const owner = await createTestUser(env.db, 'resolve-deploy-owner');
    const assigned = await createTestProject(env.db, owner.id, 'resolve-assigned');
    const sibling = await createTestProject(env.db, owner.id, 'resolve-sibling');
    const build = await createTestBuild(env.db, {
      projectId: assigned.id,
      userId: owner.id,
      status: 'building',
    });
    const token = await signDeployToken(
      { projectId: assigned.id, userId: owner.id, login: owner.login, buildId: build.id },
      env.JWT_SECRET,
    );

    const allowed = await resolve(assigned.slug, token);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ project: { id: assigned.id } });
    const denied = await resolve(sibling.slug, token);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ project: null });
    expect(await (await resolve('resolve-absent', token)).json()).toEqual({ project: null });
  });
});

describe('GET /projects/choices', () => {
  it('returns accessible project details without querying traffic', async () => {
    const owner = await createTestUser(env.db, 'choices-owner');
    const collaborator = await createTestUser(env.db, 'choices-collaborator');
    const privateOwner = await createTestUser(env.db, 'choices-private-owner');
    const owned = await createTestProject(env.db, owner.id, 'choices-owned');
    const shared = await createTestProject(env.db, collaborator.id, 'choices-shared');
    await createTestProject(env.db, privateOwner.id, 'choices-private');
    await env.db.insert(projectMembers).values({
      project_id: shared.id,
      user_id: owner.id,
      role: 'reader',
      added_by_user_id: collaborator.id,
    });
    const externalFetch = vi.fn(() => {
      throw new Error('project choices must not query external analytics');
    });
    vi.stubGlobal('fetch', externalFetch);

    const response = await app.fetch(
      new Request('http://localhost/projects/choices', {
        headers: { Authorization: `Bearer ${owner.jwt}` },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const choices = (await response.json()) as Array<{ id: string; role: string }>;
    expect(choices).toHaveLength(2);
    expect(choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shared.id, role: 'reader' }),
        expect.objectContaining({ id: owned.id, role: 'owner' }),
      ]),
    );
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it('requires a full account credential', async () => {
    const owner = await createTestUser(env.db, 'choices-token-owner');
    const project = await createTestProject(env.db, owner.id, 'choices-token-project');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      status: 'building',
    });
    const token = await signDeployToken(
      { projectId: project.id, userId: owner.id, login: owner.login, buildId: build.id },
      env.JWT_SECRET,
    );
    expect((await app.fetch(new Request('http://localhost/projects/choices'), env)).status).toBe(
      401,
    );
    const scoped = await app.fetch(
      new Request('http://localhost/projects/choices', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(scoped.status).toBe(403);
  });
});

describe('getLatestDeploymentsByProjectIds', () => {
  it('returns one most recent deployment per project', async () => {
    const user = await createTestUser(env.db, 'latest-deployment-owner');
    const first = await createTestProject(env.db, user.id, 'latest-first');
    const second = await createTestProject(env.db, user.id, 'latest-second');
    const empty = await createTestProject(env.db, user.id, 'latest-empty');
    const old = await createTestDeployment(env.db, first.id, 'live');
    const newest = await createTestDeployment(env.db, first.id, 'failed');
    const other = await createTestDeployment(env.db, second.id, 'pending');
    await env.db
      .update(deployments)
      .set({ created_at: '2026-01-01T00:00:00.000Z' })
      .where(eq(deployments.id, old.id));
    await env.db
      .update(deployments)
      .set({ created_at: '2026-01-03T00:00:00.000Z' })
      .where(eq(deployments.id, newest.id));
    await env.db
      .update(deployments)
      .set({ created_at: '2026-01-02T00:00:00.000Z' })
      .where(eq(deployments.id, other.id));

    const latest = await db.getLatestDeploymentsByProjectIds(env.db, [
      first.id,
      second.id,
      empty.id,
    ]);
    expect(latest.size).toBe(2);
    expect(latest.get(first.id)).toMatchObject({ id: newest.id, status: 'failed' });
    expect(latest.get(second.id)).toMatchObject({ id: other.id, status: 'pending' });
    expect(latest.has(empty.id)).toBe(false);
  });
});

describe('GET /projects/:id', () => {
  it('allows a deploy credential to read only its assigned project', async () => {
    const owner = await createTestUser(env.db, 'get-deploy-owner');
    const assigned = await createTestProject(env.db, owner.id, 'get-deploy-assigned');
    const sibling = await createTestProject(env.db, owner.id, 'get-deploy-sibling');
    const build = await createTestBuild(env.db, {
      projectId: assigned.id,
      userId: owner.id,
      status: 'building',
    });
    const token = await signDeployToken(
      { projectId: assigned.id, userId: owner.id, login: owner.login, buildId: build.id },
      env.JWT_SECRET,
    );
    const read = (id: string) =>
      app.fetch(
        new Request(`http://localhost/projects/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
      );

    const allowed = await read(assigned.id);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ id: assigned.id });
    const denied = await read(sibling.id);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns project for the owner', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'my-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(project.id);
    expect(body.slug).toBe('my-app');
  });

  it('rejects a collaborator when the owner is manually suspended', async () => {
    const owner = await createTestUser(env.db, 'get-suspended-owner');
    const collaborator = await createTestUser(env.db, 'get-suspended-collaborator');
    const project = await createTestProject(env.db, owner.id, 'get-suspended-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'reader',
      added_by_user_id: owner.id,
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, owner.id));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${collaborator.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'project owner suspended',
      message: expect.any(String),
    });
  });

  it('returns 403 when user does not own the project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe('project CI credential ownership', () => {
  function credentialRequest(
    projectId: string,
    jwt: string,
    method: 'GET' | 'POST' | 'DELETE',
    suffix = '',
    body?: Record<string, unknown>,
  ): Request {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (body) {
      init.body = JSON.stringify(body);
    }
    return new Request(`http://localhost/projects/${projectId}/tokens${suffix}`, init);
  }

  it('returns 403 to project members and 404 only for missing projects', async () => {
    const owner = await createTestUser(env.db, 'credential-owner');
    const admin = await createTestUser(env.db, 'credential-admin');
    const project = await createTestProject(env.db, owner.id, 'credential-owner-only');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await env.db.insert(projectDeployCredentials).values({
      id: 'credential-owner-only-row',
      project_id: project.id,
      issued_by: owner.id,
      name: 'Owner CI',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const operations = [
      { method: 'GET' as const },
      { method: 'POST' as const, body: { name: 'Admin CI' } },
      {
        method: 'POST' as const,
        suffix: '/credential-owner-only-row/renew',
        body: { expiresInDays: 30 },
      },
      { method: 'DELETE' as const, suffix: '/credential-owner-only-row' },
    ];

    for (const operation of operations) {
      const memberResponse = await app.fetch(
        credentialRequest(
          project.id,
          admin.jwt,
          operation.method,
          operation.suffix,
          operation.body,
        ),
        env,
      );
      expect(memberResponse.status).toBe(403);
      expect(await memberResponse.json()).toEqual({
        error: 'forbidden',
        message: expect.any(String),
      });

      const missingResponse = await app.fetch(
        credentialRequest(
          'proj_missing',
          admin.jwt,
          operation.method,
          operation.suffix,
          operation.body,
        ),
        env,
      );
      expect(missingResponse.status).toBe(404);
      expect(await missingResponse.json()).toEqual({
        error: 'project not found',
        message: expect.any(String),
      });
    }
  });

  it('does not mint or renew a credential after project teardown begins', async () => {
    const owner = await createTestUser(env.db, 'deleting-credential-owner');
    const project = await createTestProject(env.db, owner.id, 'deleting-credential-project');
    await env.db.insert(projectDeployCredentials).values({
      id: 'deleting-credential-row',
      project_id: project.id,
      issued_by: owner.id,
      name: 'Existing CI',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const createResponse = await app.fetch(
      credentialRequest(project.id, owner.jwt, 'POST', '', { name: 'Too late' }),
      env,
    );
    const renewResponse = await app.fetch(
      credentialRequest(project.id, owner.jwt, 'POST', '/deleting-credential-row/renew', {
        expiresInDays: 30,
      }),
      env,
    );

    expect(createResponse.status).toBe(409);
    expect(renewResponse.status).toBe(409);
    expect(
      await env.db
        .select()
        .from(projectDeployCredentials)
        .where(eq(projectDeployCredentials.project_id, project.id)),
    ).toMatchObject([{ id: 'deleting-credential-row', revoked_at: null }]);
  });

  it('returns ISO-8601 timestamps from create, list, and renew', async () => {
    const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const owner = await createTestUser(env.db, 'credential-iso-owner');
    const project = await createTestProject(env.db, owner.id, 'credential-iso-project');

    const created = await app.fetch(
      credentialRequest(project.id, owner.jwt, 'POST', '', { name: 'ISO CI', expiresInDays: 30 }),
      env,
    );
    expect(created.status).toBe(201);
    const credential = await created.json<{ id: string; createdAt: string; expiresAt: string }>();
    expect(credential.createdAt).toMatch(isoTimestamp);
    expect(credential.expiresAt).toMatch(isoTimestamp);

    const renewed = await app.fetch(
      credentialRequest(project.id, owner.jwt, 'POST', `/${credential.id}/renew`, {
        expiresInDays: 30,
      }),
      env,
    );
    expect(renewed.status).toBe(200);
    const replacement = await renewed.json<{ createdAt: string; expiresAt: string }>();
    expect(replacement.createdAt).toMatch(isoTimestamp);
    expect(replacement.expiresAt).toMatch(isoTimestamp);

    const listed = await app.fetch(credentialRequest(project.id, owner.jwt, 'GET'), env);
    expect(listed.status).toBe(200);
    const rows =
      await listed.json<
        Array<{ id: string; createdAt: string; expiresAt: string; revokedAt: string | null }>
      >();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.createdAt).toMatch(isoTimestamp);
      expect(row.expiresAt).toMatch(isoTimestamp);
      if (row.id === credential.id) {
        expect(row.revokedAt).toMatch(isoTimestamp);
      } else {
        expect(row.revokedAt).toBeNull();
      }
    }
  });
});

describe('POST /projects/:id/prerender-token', () => {
  async function proxyRequest(
    token: string,
    projectId: string,
    options: { dropLegacyInternalHeader?: boolean } = {},
  ) {
    const proxyModuleUrl = new URL('../../../proxy/src/index.ts', import.meta.url).href;
    const proxyWorker = (
      (await import(/* @vite-ignore */ proxyModuleUrl)) as {
        default: { fetch(request: Request, env: unknown): Promise<Response> };
      }
    ).default;
    const apiBinding = {
      fetch(input: string | Request, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init);
        if (options.dropLegacyInternalHeader) {
          request.headers.delete('x-void-internal');
        }
        return app.fetch(request, env);
      },
    };
    return proxyWorker.fetch(
      new Request('https://proxy.example.com/ai/run', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectId, model: 'test-model', inputs: {} }),
      }),
      {
        ...env,
        API: apiBinding,
        AI: {
          run: vi.fn(async () => ({ response: 'ok' })),
          models: vi.fn(async () => []),
          toMarkdown: vi.fn(async () => ({ markdown: '' })),
          gateway: vi.fn(),
        },
      } as never,
    );
  }

  async function issueCiPrerenderToken(
    user: Awaited<ReturnType<typeof createTestUser>>,
    project: Awaited<ReturnType<typeof createTestProject>>,
    name: string,
  ) {
    const issued = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, expiresInDays: 30 }),
      }),
      env,
    );
    expect(issued.status).toBe(201);
    const credential = await issued.json<{ id: string; token: string }>();
    const derived = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential.token}` },
      }),
      env,
    );
    expect(derived.status).toBe(200);
    const { token } = await derived.json<{ token: string }>();
    const payload = await verifyPrerenderToken(token, env.JWT_SECRET);
    expect(payload).toMatchObject({
      aud: 'prerender',
      sub: user.id,
      project: project.id,
      credential: credential.id,
    });
    expect(payload?.sid).toBeUndefined();
    expect((await proxyRequest(token, project.id)).status).toBe(200);
    return { ...credential, derivedToken: token };
  }

  it('mints a bounded proxy-only token long enough for a manual prerender', async () => {
    const user = await createTestUser(env.db, 'prerender-owner');
    const project = await createTestProject(env.db, user.id, 'prerender-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const payload = await verifyPrerenderToken(token, env.JWT_SECRET);
    expect(payload).toMatchObject({
      aud: 'prerender',
      sub: user.id,
      project: project.id,
    });
    expect(payload!.exp - payload!.iat).toBe(65 * 60);
  });

  it('checks prerender authority with the proxy credential alone', async () => {
    const user = await createTestUser(env.db, 'prerender-proxy-auth');
    const project = await createTestProject(env.db, user.id, 'prerender-proxy-auth-app');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const { token } = await res.json<{ token: string }>();
    const proxied = await proxyRequest(token, project.id, { dropLegacyInternalHeader: true });
    expect(proxied.status).toBe(200);
  });

  it('revokes a collaborator manual prerender token when the member is removed', async () => {
    const owner = await createTestUser(env.db, 'prerender-removal-owner');
    const collaborator = await createTestUser(env.db, 'prerender-removal-collaborator');
    const project = await createTestProject(env.db, owner.id, 'prerender-removal-app');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    const minted = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${collaborator.jwt}` },
      }),
      env,
    );
    expect(minted.status).toBe(200);
    const { token } = await minted.json<{ token: string }>();
    expect((await proxyRequest(token, project.id)).status).toBe(200);

    const removed = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/members/${collaborator.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${owner.jwt}` },
      }),
      env,
    );
    expect(removed.status).toBe(204);
    expect((await proxyRequest(token, project.id)).status).toBe(403);
  });

  it('allows the project-scoped deploy token to mint it', async () => {
    const user = await createTestUser(env.db, 'prerender-ci');
    const project = await createTestProject(env.db, user.id, 'prerender-ci-app');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'building',
    });
    const deployToken = await signDeployToken(
      { projectId: project.id, userId: user.id, login: user.login, buildId: build.id },
      env.JWT_SECRET,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deployToken}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('binds a derived token to its active build and revokes it with that build', async () => {
    const user = await createTestUser(env.db, 'prerender-bound-ci');
    const project = await createTestProject(env.db, user.id, 'prerender-bound-ci-app');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'building',
    });
    const deployToken = await signDeployToken(
      {
        projectId: project.id,
        userId: user.id,
        login: user.login,
        buildId: build.id,
      },
      env.JWT_SECRET,
    );

    const mint = () =>
      app.fetch(
        new Request(`http://localhost/projects/${project.id}/prerender-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${deployToken}` },
        }),
        env,
      );
    const minted = await mint();
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    expect(await verifyPrerenderToken(token, env.JWT_SECRET)).toMatchObject({
      aud: 'prerender',
      project: project.id,
      build: build.id,
    });
    const payload = await verifyPrerenderToken(token, env.JWT_SECRET);
    const parent = await verifyDeployToken(deployToken, env.JWT_SECRET);
    expect(payload!.exp).toBeLessThanOrEqual(parent!.exp);
    expect(payload!.exp).toBeGreaterThanOrEqual(parent!.exp - 1);

    const internalAuth = await deriveProxyInternalAuth(
      env.JWT_SECRET,
      'verify-prerender-build',
      project.id,
    );
    const verifyBuild = () =>
      app.fetch(
        new Request(`http://localhost/internal/verify-prerender-build/${project.id}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-void-proxy-internal': internalAuth,
          },
          body: JSON.stringify({ userId: user.id, buildId: build.id }),
        }),
        env,
      );
    expect((await verifyBuild()).status).toBe(200);
    expect((await proxyRequest(token, project.id)).status).toBe(200);

    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));
    expect((await proxyRequest(token, project.id)).status).toBe(403);
    await env.db.update(users).set({ suspended_reason: null }).where(eq(users.id, user.id));
    expect((await proxyRequest(token, project.id)).status).toBe(200);

    await db.markBuildTerminalIfActive(env.db, build.id, 'cancelled');
    expect((await verifyBuild()).status).toBe(403);
    expect((await mint()).status).toBe(403);
  });

  it('revokes CI-derived proxy access on parent revoke, renewal, expiry, and owner suspension', async () => {
    const user = await createTestUser(env.db, 'prerender-durable-ci');
    const project = await createTestProject(env.db, user.id, 'prerender-durable-ci-app');

    const revoked = await issueCiPrerenderToken(user, project, 'revoke-parent');
    const revoke = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/tokens/${revoked.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(revoke.status).toBe(200);
    expect((await proxyRequest(revoked.derivedToken, project.id)).status).toBe(403);

    const renewed = await issueCiPrerenderToken(user, project, 'renew-parent');
    const renew = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/tokens/${renewed.id}/renew`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: 30 }),
      }),
      env,
    );
    expect(renew.status).toBe(200);
    expect((await proxyRequest(renewed.derivedToken, project.id)).status).toBe(403);

    const expired = await issueCiPrerenderToken(user, project, 'expire-parent');
    await env.db
      .update(projectDeployCredentials)
      .set({ expires_at: new Date(0).toISOString() })
      .where(eq(projectDeployCredentials.id, expired.id));
    expect((await proxyRequest(expired.derivedToken, project.id)).status).toBe(403);

    const suspended = await issueCiPrerenderToken(user, project, 'suspend-owner');
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));
    expect((await proxyRequest(suspended.derivedToken, project.id)).status).toBe(403);
  });

  it('revokes durable deploy and derived prerender credentials after ownership transfer', async () => {
    const formerOwner = await createTestUser(env.db, 'prerender-transfer-former-owner');
    const newOwner = await createTestUser(env.db, 'prerender-transfer-new-owner');
    const project = await createTestProject(
      env.db,
      formerOwner.id,
      'prerender-transfer-credential-app',
    );
    const credential = await issueCiPrerenderToken(formerOwner, project, 'transfer-parent');

    await env.db.transaction(async (tx) => {
      await tx.update(projects).set({ user_id: newOwner.id }).where(eq(projects.id, project.id));
      await tx.insert(projectMembers).values({
        project_id: project.id,
        user_id: formerOwner.id,
        role: 'admin',
        added_by_user_id: newOwner.id,
      });
    });

    const parent = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${credential.token}` },
      }),
      env,
    );
    expect(parent.status).toBe(401);
    expect((await proxyRequest(credential.derivedToken, project.id)).status).toBe(403);
  });

  it('retains validated credential provenance when the parent JWT expires before minting', async () => {
    const startedAt = new Date('2026-09-18T00:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
    try {
      const user = await createTestUser(env.db, 'prerender-expiry-boundary');
      const project = await createTestProject(env.db, user.id, 'prerender-expiry-boundary-app');
      const credentialId = crypto.randomUUID();
      const expiresAt = new Date(startedAt + 2_000);
      await env.db.insert(projectDeployCredentials).values({
        id: credentialId,
        project_id: project.id,
        issued_by: user.id,
        name: 'expiry-boundary',
        expires_at: expiresAt.toISOString(),
      });
      const parentToken = await signProjectCredentialToken(
        {
          credentialId,
          projectId: project.id,
          userId: user.id,
          login: user.login,
          expiresAt,
        },
        env.JWT_SECRET,
      );

      const requireCapability = projectAccess.requireProjectCapability;
      vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
        // authMiddleware has already verified the real JWT and credential row;
        // the route capability check crosses the JWT expiry boundary.
        vi.setSystemTime(startedAt + 2_000);
        return requireCapability(...args);
      });
      const response = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/prerender-token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${parentToken}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await verifyDeployToken(parentToken, env.JWT_SECRET)).toBeNull();
      const { token } = await response.json<{ token: string }>();
      const payload = await verifyPrerenderToken(token, env.JWT_SECRET);
      expect(payload).toMatchObject({
        aud: 'prerender',
        project: project.id,
        sub: user.id,
        credential: credentialId,
      });
      expect(payload?.sid).toBeUndefined();
      // The parent record expired at the same boundary as its JWT, so the
      // credential-bound derived token is immediately rejected authoritatively.
      expect((await proxyRequest(token, project.id)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps durable deploy and derived prerender credentials independent of provider disablement', async () => {
    const user = await createTestUser(env.db, 'prerender-provider-independent');
    const project = await createTestProject(env.db, user.id, 'prerender-provider-independent-app');
    const credential = await issueCiPrerenderToken(user, project, 'provider-independent');

    await importLegacyAuthentication(env.db, env);
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'github'));
    await revokeConnectionSessions(env.db, 'github');

    expect((await proxyRequest(credential.derivedToken, project.id)).status).toBe(200);
    mockCfApi();
    const parentStillValid = await app.fetch(
      new Request('http://localhost/projects', {
        headers: { Authorization: `Bearer ${credential.token}` },
      }),
      env,
    );
    expect(parentStillValid.status).toBe(200);
  });

  it('preserves the owner-suspension error from the locked capability recheck', async () => {
    const owner = await createTestUser(env.db, 'prerender-suspended-owner');
    const collaborator = await createTestUser(env.db, 'prerender-suspended-collaborator');
    const project = await createTestProject(env.db, owner.id, 'prerender-suspended-app');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: collaborator.id,
      status: 'building',
    });
    const deployToken = await signDeployToken(
      {
        projectId: project.id,
        userId: collaborator.id,
        login: collaborator.login,
        buildId: build.id,
      },
      env.JWT_SECRET,
    );

    const requireCapability = projectAccess.requireProjectCapability;
    let suspended = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const access = await requireCapability(...args);
      if (!suspended && args[3] === 'deploy') {
        suspended = true;
        await env.db
          .update(users)
          .set({ suspended_reason: 'platform policy violation' })
          .where(eq(users.id, owner.id));
      }
      return access;
    });

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deployToken}` },
      }),
      env,
    );

    expect(suspended).toBe(true);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'project owner suspended',
      message: expect.any(String),
    });
  });

  it("does not mint a token for another user's project", async () => {
    const owner = await createTestUser(env.db, 'prerender-owner-two');
    const attacker = await createTestUser(env.db, 'prerender-attacker');
    const project = await createTestProject(env.db, owner.id, 'private-prerender');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/prerender-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${attacker.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('PUT /projects/:id/database-url', () => {
  it.each([
    { method: 'POST', suffix: 'database' },
    { method: 'PUT', suffix: 'database-url' },
  ] as const)(
    'rechecks configure capability under the lock for $method /$suffix',
    async ({ method, suffix }) => {
      const owner = await createTestUser(env.db, `db-race-owner-${method.toLowerCase()}`);
      const collaborator = await createTestUser(
        env.db,
        `db-race-collaborator-${method.toLowerCase()}`,
      );
      const project = await createTestProject(
        env.db,
        owner.id,
        `db-access-race-${method.toLowerCase()}`,
      );
      await env.db.insert(projectMembers).values({
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      });
      const cf = mockCfApi();

      // Return the route's first access snapshot, then commit the downgrade.
      // The handler must re-resolve the collaborator under the project lock
      // before either creating or updating a live Hyperdrive.
      const requireCapability = projectAccess.requireProjectCapability;
      let downgraded = false;
      vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
        const result = await requireCapability(...args);
        if (!downgraded && args[3] === 'configure') {
          downgraded = true;
          await env.db
            .update(projectMembers)
            .set({ role: 'reader' })
            .where(eq(projectMembers.user_id, collaborator.id));
        }
        return result;
      });

      const requestUrl = `http://localhost/projects/${project.id}/${suffix}`;
      const requestOptions = {
        headers: {
          Authorization: `Bearer ${collaborator.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      };
      const request =
        method === 'POST'
          ? new Request(requestUrl, { method: 'POST', ...requestOptions })
          : new Request(requestUrl, { method: 'PUT', ...requestOptions });
      const res = await app.fetch(request, env);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
      expect(downgraded).toBe(true);
      expect(cf).not.toHaveBeenCalled();
      expect(
        await env.db.select().from(resources).where(eq(resources.project_id, project.id)),
      ).toEqual([]);
      expect(
        await env.db
          .select()
          .from(projectDatabaseCredentials)
          .where(eq(projectDatabaseCredentials.project_id, project.id)),
      ).toEqual([]);
    },
  );

  it('provisions Hyperdrive with a Cloudflare-safe name', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-post');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        const body = JSON.parse(init?.body as string) as { name: string };
        expect(body.name).toBe(hyperdriveName);
        expect(body.name).toMatch(/^[a-z0-9-]+$/);
        return cfSuccess({ id: 'hd-post-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-post-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('creates Hyperdrive from a provider Postgres URL when no resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          caching: { disabled: true },
          origin: {
            database: 'appdb',
            host: 'db.example.com',
            password: 'p@ss',
            port: 25060,
            scheme: 'postgresql',
            user: 'void_user',
          },
        });
        return cfSuccess({ id: 'hd-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString:
            'postgresql://void_user:p%40ss@db.example.com:25060/appdb?sslmode=verify-full&sslrootcert=/home/dev/prod-ca-2021.crt',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('creates Hyperdrive from a MySQL URL when no resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'mysql-app');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();

    mockCfApi({
      createHyperdrive: (_url, init) => {
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          caching: { disabled: true },
          origin: {
            database: 'appdb',
            host: 'mysql.example.com',
            password: 'p@ss',
            port: 3306,
            scheme: 'mysql',
            user: 'void_user',
          },
        });
        return cfSuccess({ id: 'hd-mysql-created', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'mysql://void_user:p%40ss@mysql.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows).toMatchObject([
      { type: 'hyperdrive', cf_id: 'hd-mysql-created', binding_name: 'HYPERDRIVE' },
    ]);
  });

  it('rejects unsupported database connection schemes', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'invalid-db-scheme');
    const cf = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: 'sqlite://user:pass@db.example.com/appdb' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Connection string must start with "postgres://", "postgresql://", or "mysql://".',
    });
    expect(cf).not.toHaveBeenCalled();
  });

  it('updates the existing Hyperdrive config when the resource exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-update');
    const hyperdriveName = `${project.id}-hyperdrive`.replaceAll('_', '-').toLowerCase();
    await env.db.insert(resources).values({
      id: 'res_hd_existing',
      project_id: project.id,
      type: 'hyperdrive',
      cf_id: 'hd-existing',
      binding_name: 'HYPERDRIVE',
    });

    mockCfApi({
      updateHyperdrive: (url, init) => {
        expect(url).toContain('/hyperdrive/configs/hd-existing');
        expect(JSON.parse(init?.body as string)).toEqual({
          name: hyperdriveName,
          caching: { disabled: true },
          origin: {
            database: 'appdb',
            host: 'db.example.com',
            password: 'pass',
            port: 5432,
            scheme: 'postgres',
            user: 'void_user',
          },
        });
        return cfSuccess({ id: 'hd-existing', name: hyperdriveName });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgres://void_user:pass@db.example.com/appdb?sslmode=verify-full',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('surfaces Cloudflare Hyperdrive errors as JSON instead of a generic 500', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-error');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'Failed to provision Hyperdrive',
      detail: 'origin database is unreachable',
    });
  });
});

describe('GET /projects/:id/database-url', () => {
  it('returns 404 with structured error when no URL has been stored', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'database_url_not_stored',
      message: expect.stringContaining('void db set-url'),
    });
  });

  it('returns 403 when accessed by a different user', async () => {
    const owner = await createTestUser(env.db);
    const other = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'pg-app-get-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('does not expose the plaintext URL to a project member', async () => {
    const owner = await createTestUser(env.db, 'database-url-owner');
    const collaborator = await createTestUser(env.db, 'database-url-collaborator');
    const project = await createTestProject(env.db, owner.id, 'database-url-member-read');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: collaborator.id,
      role: 'collaborator',
      added_by_user_id: owner.id,
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${collaborator.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: expect.any(String) });
  });

  it('round-trips the connection string via POST /:id/database', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-rt-post');
    const connectionString = 'postgresql://void_user:pass@db.example.com/appdb';

    mockCfApi();

    const postRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString }),
      }),
      env,
    );
    expect(postRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: connectionString });
  });

  it('returns 409 from POST /:id/database once teardown has begun', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-deleting');
    // Teardown flips status to 'deleting' under a row lock before tearing down
    // CF resources; provisioning a Hyperdrive after that would orphan it.
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const cf = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Project is being deleted' });
    // Bailed before touching Cloudflare — no Hyperdrive create attempted.
    expect(cf).not.toHaveBeenCalled();
  });

  it('rolls back the created Hyperdrive when persisting its resource row fails (POST /database)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-rollback-post');
    const cf = mockCfApi();
    // Force the resources-row INSERT to fail AFTER CF created the Hyperdrive
    // (models a concurrent teardown deleting the project → FK violation). The
    // route must delete the just-created CF Hyperdrive so it doesn't orphan.
    vi.spyOn(db, 'createResource').mockRejectedValueOnce(new Error('insert failed'));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );
    expect(res.status).toBe(500);

    // The Hyperdrive CF object we created was rolled back (DELETE to its config).
    const hdDeletes = cf.mock.calls.filter(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === 'DELETE' &&
        /\/hyperdrive\/configs\/[^/]+$/.test(String(url)),
    );
    expect(hdDeletes.length).toBeGreaterThan(0);
  });

  it('round-trips the connection string via PUT /:id/database-url', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-rt-put');
    const connectionString = 'postgres://void_user:secret@db.example.com/mydb';

    mockCfApi();

    const putRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString }),
      }),
      env,
    );
    expect(putRes.status).toBe(200);

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: connectionString });
  });

  it('returns 409 from PUT /:id/database-url once teardown has begun', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-put-deleting');
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const cf = mockCfApi();

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgres://void_user:secret@db.example.com/mydb',
        }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Project is being deleted' });
    expect(cf).not.toHaveBeenCalled();
  });

  it('last PUT wins — GET returns the most recently written URL', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-app-get-overwrite');
    const first = 'postgresql://void_user:first@db.example.com/appdb';
    const second = 'postgresql://void_user:second@db2.example.com/appdb2';

    mockCfApi();

    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: first }),
      }),
      env,
    );
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: second }),
      }),
      env,
    );

    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: second });
  });
});

describe('database URL persistence ordering — CF failure must not overwrite stored URL', () => {
  it('POST /:id/database does not write credentials when createHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-post-cf-fail');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // No credential row should have been written
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(404);
    expect(await getRes.json()).toMatchObject({ error: 'database_url_not_stored' });
  });

  it('POST /:id/database leaves pre-existing credentials unchanged when createHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-post-cf-fail-keep');
    const originalUrl = 'postgresql://void_user:original@db.example.com/appdb';

    // Seed a successful first set via the happy path
    mockCfApi();
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: originalUrl }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);

    // A re-run updates through PUT; a CF rejection there must leave the
    // original credential intact.
    mockCfApi({
      updateHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    // The first POST created the hyperdrive resource, so PUT takes the update path.
    const rows = await env.db.select().from(resources).where(eq(resources.project_id, project.id));
    expect(rows.find((r) => r.type === 'hyperdrive')).toBeDefined();

    const putRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:new@db2.example.com/otherdb',
        }),
      }),
      env,
    );
    expect(putRes.status).toBe(502);

    // The stored URL must still be the original
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: originalUrl });
  });

  it('PUT /:id/database-url does not write credentials when createHyperdrive rejects (no existing resource)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-put-cf-fail-create');

    mockCfApi({
      createHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:pass@db.example.com/appdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // No credential row should have been written
    const rows = await env.db
      .select()
      .from(projectDatabaseCredentials)
      .where(eq(projectDatabaseCredentials.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('PUT /:id/database-url does not overwrite credentials when updateHyperdrive rejects', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'pg-put-cf-fail-update');
    const originalUrl = 'postgresql://void_user:original@db.example.com/appdb';

    // Seed an existing hyperdrive resource and a stored credential via the happy path
    mockCfApi();
    const firstRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ connectionString: originalUrl }),
      }),
      env,
    );
    expect(firstRes.status).toBe(200);

    // Now attempt an update with CF rejecting the new URL
    mockCfApi({
      updateHyperdrive: () => cfError('origin database is unreachable', 400),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectionString: 'postgresql://void_user:new@db2.example.com/otherdb',
        }),
      }),
      env,
    );

    // CF rejected — the request should fail
    expect(res.status).toBe(502);

    // The stored URL must still be the original (not overwritten with the rejected URL)
    const getRes = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/database-url`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({ url: originalUrl });
  });
});

describe('POST /projects', () => {
  it('creates project with valid slug', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'my-app' }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      slug: string;
      user_id: string;
    };
    expect(body.slug).toBe('my-app');
    expect(body.user_id).toBe(user.id);
  });

  it('returns initialization failures in the standard warnings collection', async () => {
    const user = await createTestUser(env.db);
    await env.db.insert(platformSettings).values({
      key: 'zeroTrust.configuration',
      value: { version: 999 },
    });

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'warning-app' }),
      }),
      env,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      slug: 'warning-app',
      warnings: [
        'Project created, but its Zero Trust protection is not set up yet, so deploys will wait. Void retries within an hour. To retry now, a project owner or admin can run `void project zero-trust reconcile`; if that reports the platform is not ready, ask a platform administrator.',
      ],
    });
    expect(body).not.toHaveProperty('warning');
  });

  it('rejects missing slug', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug format', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'UPPER-CASE' }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'slug must be lowercase alphanumeric with dashes',
    });
  });

  // `<slug>@<mail domain>` is the project's mailbox, and a certificate
  // authority may prove control of that domain by mailing `hostmaster@`.
  it('rejects CA domain-validation mailbox slugs', async () => {
    const user = await createTestUser(env.db);

    for (const slug of ['administrator', 'hostmaster', 'webmaster']) {
      const res = await app.fetch(
        new Request('http://localhost/projects', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ slug }),
        }),
        env,
      );
      expect(res.status, slug).toBe(400);
      expect(await res.json()).toEqual({ error: 'this name is reserved' });
    }
  });

  // The slug is the prefix of the project's email local-part
  // (`<slug>+noreply@<domain>`), which RFC 5321 caps at 64 octets. The runtime
  // refuses to build a default sender from a slug over 56, so a longer slug
  // must never be allocated.
  it('accepts a 56-character slug', async () => {
    const user = await createTestUser(env.db);
    const slug = `len-${'a'.repeat(52)}`;
    expect(slug).toHaveLength(56);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe(slug);
  });

  it('rejects a 57-character slug', async () => {
    const user = await createTestUser(env.db);
    const slug = `len-${'a'.repeat(53)}`;
    expect(slug).toHaveLength(57);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'slug must be at most 56 characters' });
    // Refused before allocation: nothing was inserted.
    expect(await env.db.select().from(projects).where(eq(projects.slug, slug))).toEqual([]);
  });

  it('rejects short slug for free tier users', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'abc' }),
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'the selected plan does not permit short slugs (5 characters or fewer)',
    });
  });

  it('allows short slug for paid tier users', async () => {
    const user = await createTestUser(env.db, 'paiduser', 'github', undefined, 'solo');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'abc' }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe('abc');
  });

  it('rejects duplicate slug', async () => {
    const user = await createTestUser(env.db);
    await createTestProject(env.db, user.id, 'taken-slug');

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'taken-slug' }),
      }),
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slug already taken' });
  });

  // A slug is also a mailbox on the shared mail domain, so it may not take
  // the name another project uses as its email alias.
  it("rejects a slug equal to another project's email alias", async () => {
    const user = await createTestUser(env.db);
    const other = await createTestProject(env.db, user.id, 'alias-holder');
    await env.db
      .update(projects)
      .set({ email_alias: 'taken-alias' })
      .where(eq(projects.id, other.id));

    const res = await app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ slug: 'taken-alias' }),
      }),
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slug already taken' });
    expect(await env.db.select().from(projects).where(eq(projects.slug, 'taken-alias'))).toEqual(
      [],
    );
  });
});

describe('GET /projects/:id/deployments', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_test1/deployments'),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);

    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nonexistent/deployments', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when not the project owner', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-project');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns empty array when no deployments', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<unknown>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toEqual([]);
    expect(body.activeDeploymentId).toBeNull();
  });

  it('returns deployments with source and git metadata fields', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const d1 = await createDeployment(env.db, project.id, null, 'manual', 'abc1234', {
      cliVersion: '0.8.3',
      commitUrl: 'https://github.com/voidzero-dev/void/commit/abc1234',
      gitRef: 'main',
      repositoryUrl: 'https://github.com/voidzero-dev/void',
    });
    await updateDeploymentStatus(env.db, d1.id, 'live');
    const d2 = await createDeployment(env.db, project.id, null, 'ci');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deployments`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: Array<{
        cli_version: string | null;
        commit: string | null;
        commit_url: string | null;
        git_ref: string | null;
        id: string;
        repository_url: string | null;
        source: string | null;
        status: string;
      }>;
      activeDeploymentId: string | null;
    };
    expect(body.deployments).toHaveLength(2);

    const byId = Object.fromEntries(body.deployments.map((d) => [d.id, d]));
    expect(byId[d1.id].source).toBe('manual');
    expect(byId[d1.id].cli_version).toBe('0.8.3');
    expect(byId[d1.id].commit).toBe('abc1234');
    expect(byId[d1.id].repository_url).toBe('https://github.com/voidzero-dev/void');
    expect(byId[d1.id].commit_url).toBe('https://github.com/voidzero-dev/void/commit/abc1234');
    expect(byId[d1.id].git_ref).toBe('main');
    expect(byId[d1.id].status).toBe('live');
    expect(byId[d2.id].source).toBe('ci');
    expect(byId[d2.id].cli_version).toBeNull();
    expect(byId[d2.id].commit_url).toBeNull();
    expect(byId[d2.id].status).toBe('pending');
  });

  it('hides manifest environment values from readers but not deploy-capable members', async () => {
    const owner = await createTestUser(env.db, 'manifest-owner');
    const reader = await createTestUser(env.db, 'manifest-reader');
    const collaborator = await createTestUser(env.db, 'manifest-collaborator');
    const project = await createTestProject(env.db, owner.id, 'manifest-project');
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
    ]);
    await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 1, vars: { TOKEN: 'plaintext' }, ssr: true }),
    );

    const listAs = async (jwt: string) => {
      const response = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deployments`, {
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deployments: Array<{ manifest: string }> };
      return JSON.parse(body.deployments[0]!.manifest) as Record<string, unknown>;
    };

    expect(await listAs(reader.jwt)).toEqual({ version: 1, ssr: true });
    expect(await listAs(collaborator.jwt)).toEqual({
      version: 1,
      vars: { TOKEN: 'plaintext' },
      ssr: true,
    });
  });

  it('warns only owners and admins about a stuck credential rotation', async () => {
    const owner = await createTestUser(env.db, 'stuck-owner');
    const project = await createTestProject(env.db, owner.id, 'stuck-project');
    const members: Record<'reader' | 'collaborator' | 'admin', string> = {
      reader: '',
      collaborator: '',
      admin: '',
    };
    for (const role of ['reader', 'collaborator', 'admin'] as const) {
      const user = await createTestUser(env.db, `stuck-${role}`);
      await env.db.insert(projectMembers).values({
        project_id: project.id,
        user_id: user.id,
        role,
        added_by_user_id: owner.id,
      });
      members[role] = user.jwt;
    }
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      status: 'building',
    });
    const deployToken = await signDeployToken(
      { projectId: project.id, userId: owner.id, login: owner.login, buildId: build.id },
      env.JWT_SECRET,
    );
    await createDeployment(env.db, project.id, JSON.stringify({ version: 3, bindings: {} }));

    const listAs = async (jwt: string) => {
      const response = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/deployments`, {
          headers: { Authorization: `Bearer ${jwt}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('cf boom');
      expect(text).not.toContain('user-x-dep');
      expect(text).not.toContain('mock-proxy-token');
      return JSON.parse(text) as { deployments: Array<unknown>; warnings?: Array<string> };
    };

    expect(await listAs(owner.jwt)).not.toHaveProperty('warnings');

    await env.db.insert(projectCleanupJobs).values({
      target: proxyTokenRotationTarget(project.id),
      project_id: project.id,
      kind: 'proxy-token-rotation',
      payload: { phase: 'patch', reason: 'member-removed' },
      attempts: 3,
      last_error: 'cf boom user-x-dep',
    });
    expect(await listAs(owner.jwt)).not.toHaveProperty('warnings');

    await env.db
      .update(projectCleanupJobs)
      .set({ attempts: 4 })
      .where(eq(projectCleanupJobs.target, proxyTokenRotationTarget(project.id)));
    for (const jwt of [owner.jwt, members.admin]) {
      const body = await listAs(jwt);
      expect(body.warnings).toEqual([proxyTokenRotationStuckWarning(project.id)]);
      expect(body.deployments).toHaveLength(1);
    }
    for (const jwt of [members.reader, members.collaborator, deployToken]) {
      expect(await listAs(jwt)).not.toHaveProperty('warnings');
    }
  });
});

describe('POST /projects/:id/rollback', () => {
  it('rolls back to a retained deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-app');

    // Create two deployments, both retained and live
    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      deploymentId: string;
      migrationDiff: Array<string>;
    };
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe(d1.id);
    expect(body.migrationDiff).toEqual([]);

    // Verify KV routing updated
    const routing = (await env.ROUTING.get(project.slug, 'json')) as { workerName: string };
    expect(routing.workerName).toBe(`user-rollback-app-${d1.id}`);
  });

  it('clamps a stored manifest limits.cpuMs to the current plan ceiling (never rejects)', async () => {
    const user = await createTestUser(env.db, 'rollback-plan-owner', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'clamp-rollback-app');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {}, limits: { cpuMs: 60_000 } }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const requireCapability = projectAccess.requireProjectCapability;
    let downgraded = false;
    vi.spyOn(projectAccess, 'requireProjectCapability').mockImplementation(async (...args) => {
      const result = await requireCapability(...args);
      if (!downgraded && args[3] === 'deploy') {
        downgraded = true;
        await env.db.update(users).set({ plan: 'free' }).where(eq(users.id, user.id));
      }
      return result;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(downgraded).toBe(true);

    const routing = (await env.ROUTING.get(project.slug, 'json')) as {
      limits: { cpuMs: number; subRequests: number };
    };
    expect(routing.limits).toEqual({ cpuMs: 10, subRequests: 50 });
  });

  it('restores the target deployment type and Worker asset metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-assets-app');
    const target = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 3,
        type: 'framework',
        framework: 'react-router',
        bindings: {},
        assetConfig: { not_found_handling: 'none' },
      }),
    );
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify({ 'assets/app.js': { hash: 'abc', size: 3 } }) })
      .where(eq(deployments.id, target.id));
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);

    const current = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, current.id, 'live');
    await markDeploymentRetained(env.db, current.id, true);
    await env.db.update(projects).set({ type: 'void' }).where(eq(projects.id, project.id));
    await setActiveDeployment(env.db, project.id, current.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await db.getProject(env.db, project.id))?.type).toBe('framework');
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      type: 'framework',
      assetManifestId: target.id,
      assetConfig: { not_found_handling: 'none' },
    });
  });

  it('keeps legacy static targets static when their manifest predates type', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-legacy-static');
    const legacyStaticManifest = JSON.stringify({
      version: 3,
      bindings: {},
      assetConfig: { not_found_handling: '404-page' },
    });
    const target = await createDeployment(env.db, project.id, legacyStaticManifest);
    await env.db
      .update(deployments)
      .set({ asset_hashes: JSON.stringify({ '/index.html': { hash: 'legacy', size: 6 } }) })
      .where(eq(deployments.id, target.id));
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);
    const current = await createDeployment(env.db, project.id, legacyStaticManifest);
    await updateDeploymentStatus(env.db, current.id, 'live');
    await markDeploymentRetained(env.db, current.id, true);
    await env.db.update(projects).set({ type: 'static' }).where(eq(projects.id, project.id));
    await setActiveDeployment(env.db, project.id, current.id);

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await db.getProject(env.db, project.id))?.type).toBe('static');
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      staticDeploymentId: target.id,
      type: 'static',
    });
  });

  it('keeps legacy Worker targets as Workers after a static deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-legacy-worker');
    // The original v1 Worker manifest had no type, workerMain, or
    // bundle_stored discriminator. In contrast, v1 static manifests carried
    // `static`, so an otherwise ambiguous historical manifest is a Worker.
    const target = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 1, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);

    const current = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 1, bindings: {}, static: 'spa' }),
    );
    await updateDeploymentStatus(env.db, current.id, 'live');
    await markDeploymentRetained(env.db, current.id, true);
    await env.db.update(projects).set({ type: 'spa' }).where(eq(projects.id, project.id));
    await setActiveDeployment(env.db, project.id, current.id);

    const response = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect((await db.getProject(env.db, project.id))?.type).toBe('void');
    expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
      type: 'void',
      workerName: `user-${project.slug}-${target.id}`,
    });
  });

  it('returns 400 for non-retained deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'evicted-app');

    const d1 = await createDeployment(env.db, project.id, null);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    // retained defaults to false

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'deployment not retained (worker script evicted)' });
  });

  it('rejects rollback while a deployment is in progress', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-busy-app');
    const target = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);
    const current = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, current.id, 'live');
    await markDeploymentRetained(env.db, current.id, true);
    await setActiveDeployment(env.db, project.id, current.id);
    const pending = await createDeployment(env.db, project.id, null);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `deploy in progress: ${pending.id}` });
    expect((await db.getProject(env.db, project.id))?.active_deployment_id).toBe(current.id);
    expect(await env.ROUTING.get(project.slug)).toBeNull();
  });

  it('returns 404 for deployment from another project', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const projectA = await createTestProject(env.db, alice.id, 'alice-roll');
    const projectB = await createTestProject(env.db, bob.id, 'bob-roll');

    const d1 = await createDeployment(env.db, projectB.id, null);
    await markDeploymentRetained(env.db, d1.id, true);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${projectA.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${alice.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'deployment not found' });
  });

  it('returns migrationDiff when rolling back past migrations', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'migrate-roll');

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);
    await setAppliedMigrations(env.db, d1.id, ['001_init.sql']);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setAppliedMigrations(env.db, d2.id, [
      '001_init.sql',
      '002_add_email.sql',
      '003_add_roles.sql',
    ]);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        // Rolling back to d1 drops 002/003 from the target's known
        // migrations while D1 still has them — destructive rollback. The
        // caller must echo the exact set of migrations that make up the
        // server-computed diff (currentActive minus target) as
        // `allowDestructive`; a mismatch is rejected with 400.
        body: JSON.stringify({
          deploymentId: d1.id,
          allowDestructive: ['002_add_email.sql', '003_add_roles.sql'],
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { migrationDiff: Array<string> };
    expect(body.migrationDiff).toEqual(['002_add_email.sql', '003_add_roles.sql']);
  });

  it('updates custom domain KV entries on rollback', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'domain-roll');

    // Insert an active domain
    await env.db.insert(domains).values({
      id: 'dom_rollback',
      project_id: project.id,
      hostname: 'rollback.example.com',
      cf_hostname_id: 'ch-rollback',
      status: 'active',
    });

    const d1 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, bindings: {} }),
    );
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    // Verify domain KV routing updated
    const domainRouting = (await env.ROUTING.get('domain:rollback.example.com', 'json')) as {
      workerName: string;
    };
    expect(domainRouting.workerName).toBe(`user-domain-roll-${d1.id}`);
  });

  it('compensates external routing writes when rollback fails mid-cutover', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-compensate-app');
    await env.db.insert(domains).values({
      id: 'dom_rollback_compensate',
      project_id: project.id,
      hostname: 'compensate.example.com',
      cf_hostname_id: 'ch-rollback-compensate',
      status: 'active',
    });
    const target = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'static', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);
    const current = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, current.id, 'live');
    await markDeploymentRetained(env.db, current.id, true);
    await env.db.update(projects).set({ type: 'void' }).where(eq(projects.id, project.id));
    await setActiveDeployment(env.db, project.id, current.id);

    const previousSlugRouting = JSON.stringify({
      workerName: 'current-worker',
      version: current.id,
    });
    const previousDomainRouting = JSON.stringify({
      workerName: 'current-worker',
      version: current.id,
    });
    await env.ROUTING.put(project.slug, previousSlugRouting);
    await env.ROUTING.put('domain:compensate.example.com', previousDomainRouting);
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let injected = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key === 'domain:compensate.example.com' && !injected) {
        injected = true;
        throw new Error('injected domain write failure');
      }
      return originalPut(key, value, options);
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    expect((await db.getProject(env.db, project.id))?.active_deployment_id).toBe(current.id);
    expect((await db.getProject(env.db, project.id))?.type).toBe('void');
    expect(await env.ROUTING.get(project.slug)).toBe(previousSlugRouting);
    expect(await env.ROUTING.get('domain:compensate.example.com')).toBe(previousDomainRouting);
  });

  it('uses the lease witness to compensate a failed same-target rollback commit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-same-target-witness');
    const target = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({ version: 3, type: 'void', bindings: {} }),
    );
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);
    await setActiveDeployment(env.db, project.id, target.id);
    const previousRouting = JSON.stringify({ workerName: 'previous-route', version: target.id });
    await env.ROUTING.put(project.slug, previousRouting);

    const realDb = env.db;
    const realTransaction = realDb.transaction.bind(realDb);
    let transactionCount = 0;
    let injected = false;
    const wrappedDb = new Proxy(realDb, {
      get(targetDb, property, receiver) {
        if (property === 'transaction') {
          return (async (callback: Parameters<typeof realTransaction>[0]) => {
            transactionCount++;
            return realTransaction(async (tx) => {
              const result = await callback(tx);
              if (transactionCount === 2 && !injected) {
                injected = true;
                throw new Error('injected pre-commit rollback');
              }
              return result;
            });
          }) as typeof realDb.transaction;
        }
        return Reflect.get(targetDb, property, receiver);
      },
    }) as db.Db;
    setTestDb(wrappedDb);

    try {
      const response = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${user.jwt}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deploymentId: target.id }),
        }),
        env,
      );
      expect(response.status).toBe(500);
      expect(injected).toBe(true);
      expect((await db.getProject(realDb, project.id))?.active_deployment_id).toBe(target.id);
      expect(await env.ROUTING.get(project.slug)).toBe(previousRouting);
      expect((await db.getActiveDeployment(realDb, project.id))?.source).not.toBe('rollback-lease');
    } finally {
      setTestDb(realDb);
    }
  });

  it('restores exact queue consumer settings when rollback fails mid-cutover', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'rollback-queue-compensate');
    const queueId = '25832cb0ce3d4f60b1e538911a4629f4';
    await env.db.insert(resources).values({
      id: 'res_queue_compensate',
      project_id: project.id,
      type: 'queue',
      cf_id: queueId,
      binding_name: 'emails',
    });

    const target = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 4,
        type: 'void',
        bindings: {},
        queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS', maxBatchSize: 20 }],
      }),
    );
    await updateDeploymentStatus(env.db, target.id, 'live');
    await markDeploymentRetained(env.db, target.id, true);
    const current = await createDeployment(
      env.db,
      project.id,
      JSON.stringify({
        version: 4,
        type: 'void',
        bindings: {},
        queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS', maxBatchSize: 5 }],
      }),
    );
    await updateDeploymentStatus(env.db, current.id, 'live');
    await markDeploymentRetained(env.db, current.id, true);
    await setActiveDeployment(env.db, project.id, current.id);

    const oldConsumer = {
      consumer_id: 'consumer-1',
      script: 'void-dispatch',
      type: 'worker',
      settings: { batch_size: 5, max_retries: 2 },
    };
    const newConsumer = { ...oldConsumer, settings: { batch_size: 20 } };
    let listCalls = 0;
    const updateBodies: Array<unknown> = [];
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'queue-proxy-token' }]),
      addQueueConsumer: () => cfError('queue already has a consumer', 409),
      listQueueConsumers: () => {
        listCalls++;
        return cfSuccess([listCalls < 3 ? oldConsumer : newConsumer]);
      },
      updateQueueConsumer: (_url, init) => {
        updateBodies.push(JSON.parse(String(init?.body)));
        return cfSuccess({ consumer_id: 'consumer-1' });
      },
    });

    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;
    const originalPut = env.ROUTING.put.bind(env.ROUTING);
    let injected = false;
    vi.spyOn(env.ROUTING, 'put').mockImplementation(async (key, value, options) => {
      if (key === queueRoutingKey && !injected) {
        injected = true;
        throw new Error('injected queue routing failure');
      }
      return originalPut(key, value, options);
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: target.id }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    expect((await db.getProject(env.db, project.id))?.active_deployment_id).toBe(current.id);
    expect(updateBodies).toHaveLength(2);
    expect(updateBodies[0]).toMatchObject({ settings: { batch_size: 20 } });
    expect(updateBodies[1]).toEqual({
      script_name: 'void-dispatch',
      type: 'worker',
      settings: { batch_size: 5, max_retries: 2 },
    });
  });

  it('rollback resolves the proxy token once for both cron and queues (no duplicate CF fetch)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-and-queue-roll');
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;

    await env.db.insert(resources).values({
      id: 'res_mixed_roll',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Simulate a transient CF failure on the SECOND bindings call. Rollback
    // reads the proxy token once and reuses it for cron and queue sync, so it
    // succeeds on one healthy call; a second read could fail after cron sync
    // committed DO state and leave cron partial.
    let bindingsCalls = 0;
    mockCfApi({
      listWorkerBindings: () => {
        bindingsCalls++;
        if (bindingsCalls === 1) {
          return cfSuccess([
            { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-d1-token' },
          ]);
        }
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10013, message: 'rate limited' }],
          }),
          { status: 429 },
        );
      },
    });

    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Exactly one CF bindings fetch for the rollback.
    expect(bindingsCalls).toBe(1);

    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    const payload = JSON.parse(sync!.body!) as { proxyToken: string };
    expect(payload.proxyToken).toBe('baked-d1-token');

    const queueRouting = (await env.ROUTING.get(queueRoutingKey, 'json')) as {
      proxyToken: string;
    };
    expect(queueRouting.proxyToken).toBe('baked-d1-token');
  });

  it('rollback cron sync uses the baked __VOID_PROXY_TOKEN from the target worker', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'cron-roll');

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Return the exact token baked into d1's worker, so we can assert
    // rollback uses THIS value rather than re-deriving from JWT_SECRET.
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-into-d1-cron' }]),
    });

    const doCalls: Array<{ url: string; body: string | null }> = [];
    const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
    vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
      const stub = originalGet(id);
      return {
        ...stub,
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          doCalls.push({ url: url.pathname, body: req.body ? await req.text() : null });
          return new Response('{}', { status: 200 });
        },
      } as unknown as DurableObjectStub;
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const sync = doCalls.find((c) => c.url === '/sync');
    expect(sync).toBeDefined();
    const payload = JSON.parse(sync!.body!) as { proxyToken: string; workerName: string };
    expect(payload.workerName).toBe(`user-cron-roll-${d1.id}`);
    expect(payload.proxyToken).toBe('baked-into-d1-cron');
  });

  it('updates queue KV entries on rollback using deterministic queue names', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'queue-roll');
    const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;

    await env.db.insert(resources).values({
      id: 'res_queue_roll',
      project_id: project.id,
      type: 'queue',
      cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
      binding_name: 'emails',
    });

    const manifest = JSON.stringify({
      version: 3,
      bindings: {},
      queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    });

    const d1 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d1.id, 'live');
    await markDeploymentRetained(env.db, d1.id, true);

    const d2 = await createDeployment(env.db, project.id, manifest);
    await updateDeploymentStatus(env.db, d2.id, 'live');
    await markDeploymentRetained(env.db, d2.id, true);
    await setActiveDeployment(env.db, project.id, d2.id);

    // Worker bindings stored at deploy time include the exact
    // __VOID_PROXY_TOKEN that d1 expects — rollback must read THIS value
    // from CF rather than re-derive from the current JWT_SECRET, which
    // would 401 the worker if the secret has rotated since d1 was
    // deployed.
    mockCfApi({
      listWorkerBindings: () =>
        cfSuccess([
          { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'token-baked-into-d1' },
        ]),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/rollback`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deploymentId: d1.id }),
      }),
      env,
    );
    expect(res.status).toBe(200);

    const queueRouting = (await env.ROUTING.get(queueRoutingKey, 'json')) as {
      workerName: string;
      projectId: string;
      queueName: string;
      proxyToken: string;
    };
    expect(queueRouting).toEqual({
      workerName: `user-queue-roll-${d1.id}`,
      projectId: project.id,
      queueName: 'emails',
      // The EXACT value from d1's worker bindings — not a freshly
      // hmacSignState(projectId, currentSecret) value.
      proxyToken: 'token-baked-into-d1',
    });
  });

  it.each([
    { issued: 1, held: 0 },
    { issued: 1, held: 1 },
    { issued: 0, held: 0 },
  ])(
    'rollback to a Worker on generation $held while generation $issued is issued writes only its token',
    async ({ issued, held }) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, 'roll-token-gen');
      await env.db
        .update(projects)
        .set({ proxy_token_gen: issued })
        .where(eq(projects.id, project.id));
      const queueRoutingKey = `queue:${project.id.replaceAll('_', '-')}-emails`;
      await env.db.insert(resources).values({
        id: 'res_roll_token_gen',
        project_id: project.id,
        type: 'queue',
        cf_id: '25832cb0ce3d4f60b1e538911a4629f4',
        binding_name: 'emails',
      });
      const manifest = JSON.stringify({
        version: 3,
        bindings: {},
        schedules: [{ cron: '*/5 * * * *', filePath: 'crons/tick.ts' }],
        queues: [{ name: 'emails', bindingName: 'QUEUE_EMAILS' }],
      });
      const d1 = await createDeployment(env.db, project.id, manifest);
      await updateDeploymentStatus(env.db, d1.id, 'live');
      await markDeploymentRetained(env.db, d1.id, true);
      const d2 = await createDeployment(env.db, project.id, manifest);
      await updateDeploymentStatus(env.db, d2.id, 'live');
      await markDeploymentRetained(env.db, d2.id, true);
      await setActiveDeployment(env.db, project.id, d2.id);

      const heldToken = await deriveProxyToken(env.JWT_SECRET, project.id, held);
      mockCfApi({
        listWorkerBindings: () =>
          cfSuccess([{ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: heldToken }]),
      });
      const syncBodies: Array<string> = [];
      const originalGet = env.CRON_SCHEDULER.get.bind(env.CRON_SCHEDULER);
      vi.spyOn(env.CRON_SCHEDULER, 'get').mockImplementation((id) => {
        const stub = originalGet(id);
        return {
          ...stub,
          fetch: async (req: Request) => {
            if (new URL(req.url).pathname === '/sync') {
              syncBodies.push(await req.text());
            }
            return new Response('{}', { status: 200 });
          },
        } as unknown as DurableObjectStub;
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/rollback`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deploymentId: d1.id }),
        }),
        env,
      );
      expect(res.status).toBe(200);

      expect(await env.ROUTING.get(queueRoutingKey, 'json')).toEqual({
        workerName: `user-roll-token-gen-${d1.id}`,
        projectId: project.id,
        queueName: 'emails',
        proxyToken: heldToken,
      });
      expect(syncBodies).toHaveLength(1);
      const sync = JSON.parse(syncBodies[0]!) as Record<string, unknown>;
      // Exactly one token: the one the Worker holds.
      expect(Object.keys(sync).filter((key) => key.startsWith('proxyToken'))).toEqual([
        'proxyToken',
      ]);
      expect(sync.proxyToken).toBe(heldToken);
    },
  );
});

describe('GET /projects/:id/logs', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/fake-id/logs'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/projects/nonexistent/logs', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for another user's project", async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob');
    const project = await createTestProject(env.db, alice.id, 'alice-logs');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${bob.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns log data from analytics engine', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'my-app');

    const mockData = {
      data: [
        {
          outcome: 'ok',
          logData: JSON.stringify([{ level: 'log', message: ['hello'], timestamp: 1000 }]),
          exceptionData: '[]',
          url: 'https://my-app.void.app/api/test',
          method: 'GET',
          statusCode: '200',
          ts: Date.now() - 5000,
        },
      ],
    };

    mockCfApi({
      analyticsQuery: (_url, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        expect(body).toContain('user-my-app');
        // The dispatch Worker's tail consumer and the user Worker's own consumer
        // each deliver a dispatched request, so identical rows are collapsed.
        expect(body).toContain('GROUP BY blob1, blob2, blob3, blob4, blob5, blob6, blob7, double1');
        expect(body).toContain('min(timestamp) as ingestedAt');
        expect(body).toContain('ORDER BY ingestedAt DESC');
        return Response.json(mockData);
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ outcome: string; url: string }> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      outcome: 'ok',
      url: 'https://my-app.void.app/api/test',
      method: 'GET',
      status: '200',
    });
  });

  it('returns analytics error details when the log query fails', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'broken-logs');

    mockCfApi({
      analyticsQuery: () => new Response('SQL compilation failed', { status: 400 }),
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; status: number; detail: string };
    expect(json).toMatchObject({
      error: 'log query failed',
      status: 400,
      detail: 'SQL compilation failed',
    });
  });

  it('rejects invalid since parameter', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'bad-since');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?since=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  // Log rows are keyed by `user-<slug>`, and a deleted project's slug can be
  // claimed again, so rows older than this project belong to an earlier owner.
  it('does not return rows from before the project was created', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'reused-slug');
    const createdAtMs = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000 + 250;
    const createdAt = new Date(createdAtMs).toISOString().replace('T', ' ').slice(0, 23);
    await env.db.update(projects).set({ created_at: createdAt }).where(eq(projects.id, project.id));

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?since=7d`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`timestamp >= toDateTime('${createdAt.slice(0, 19)}')`);
    // An earlier owner's invocation can start before creation and be written after it.
    expect(capturedBody).toContain(`AND double1 >= ${createdAtMs}`);
  });

  it('uses the since bound when the project is older than it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'old-project');
    const createdAt = new Date(Date.now() - 30 * 24 * 60 * 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    await env.db.update(projects).set({ created_at: createdAt }).where(eq(projects.id, project.id));

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const before = Date.now();
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?since=1h`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    const after = Date.now();
    expect(res.status).toBe(200);
    const bound = /timestamp >= toDateTime\('([^']+)'\)/.exec(capturedBody)?.[1];
    expect(bound).toBeDefined();
    const boundMs = Date.parse(`${bound!.replace(' ', 'T')}Z`);
    expect(boundMs).toBeGreaterThanOrEqual(Math.floor((before - 60 * 60_000) / 1000) * 1000);
    expect(boundMs).toBeLessThanOrEqual(after - 60 * 60_000);
  });

  it('appends an error-level WHERE clause when level=error', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-error');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=error`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    // Also catches responses with a 5xx status (blob6) even when the worker
    // neither threw nor logged at error level.
    expect(capturedBody).toContain(
      `AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%' OR blob6 LIKE '5%')`,
    );
  });

  it('appends a warn-level WHERE clause when level=warn', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-warn');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=warn`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob2 LIKE '%"level":"warn"%'`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it.each(['info', 'log', 'debug'] as const)(
    'appends a %s-level WHERE clause when level=%s',
    async (lvl) => {
      const user = await createTestUser(env.db);
      const project = await createTestProject(env.db, user.id, `lvl-${lvl}`);

      let capturedBody = '';
      mockCfApi({
        analyticsQuery: (_url, init) => {
          capturedBody = typeof init?.body === 'string' ? init.body : '';
          return Response.json({ data: [] });
        },
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/logs?level=${lvl}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(capturedBody).toContain(`AND blob2 LIKE '%"level":"${lvl}"%'`);
      expect(capturedBody).not.toContain(`blob1 != 'ok'`);
    },
  );

  it('omits the level WHERE clause when level=all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-all');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=all`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).not.toContain(`"level":`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it('omits the level WHERE clause when level is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-missing');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).not.toContain(`"level":`);
    expect(capturedBody).not.toContain(`blob1 != 'ok'`);
  });

  it('rejects unknown level values with a 400 and never queries AE', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-bad');

    let aeCalls = 0;
    mockCfApi({
      analyticsQuery: () => {
        aeCalls++;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?level=foo`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid level parameter/);
    expect(json.error).toMatch(/error, warn, info, log, debug/);
    expect(aeCalls).toBe(0);
  });

  it('combines level=error with deploymentId so both clauses are ANDed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'lvl-combo');
    const deploymentId = 'dpl_abc123';

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/projects/${project.id}/logs?level=error&deploymentId=${deploymentId}`,
        {
          headers: { Authorization: `Bearer ${user.jwt}` },
        },
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob7 = '${deploymentId}'`);
    expect(capturedBody).toContain(
      `AND (blob1 != 'ok' OR blob3 != '[]' OR blob2 LIKE '%"level":"error"%' OR blob6 LIKE '5%')`,
    );
  });
});

describe('GET /projects/:id/requests', () => {
  it('returns 401 without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/projects/fake-id/requests'), env);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown project', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/projects/proj_nope/requests', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-owner', async () => {
    const owner = await createTestUser(env.db);
    const other = await createTestUser(env.db);
    const project = await createTestProject(env.db, owner.id, 'req-owned');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests`, {
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns request rows from analytics engine, keyed by project id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-app');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({
          data: [
            {
              type: 'ssr',
              method: 'GET',
              status: '503',
              durationMs: 1200,
              bytes: 0,
              timestamp: '2026-07-16 16:52:00',
            },
          ],
        });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );

    expect(res.status).toBe(200);
    // Keyed on blob1 to match the established requests-dataset convention used
    // by the billing/top-traffic queries in routes/usage.ts (meta/lessons.md).
    expect(capturedBody).toContain(`WHERE blob1 = '${project.id}'`);
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      type: 'ssr',
      method: 'GET',
      status: '503',
      durationMs: 1200,
    });
  });

  it('filters by status class (5xx) via a LIKE clause', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-5xx');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?status=5xx`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob4 LIKE '5%'`);
  });

  it('filters by an exact status code via equality', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-500');

    let capturedBody = '';
    mockCfApi({
      analyticsQuery: (_url, init) => {
        capturedBody = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?status=500`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capturedBody).toContain(`AND blob4 = '500'`);
  });

  it('rejects an invalid status filter with 400 and never queries analytics', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-badstatus');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?status=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });

  it('rejects an invalid since parameter', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-badsince');
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?since=abc`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects exact status codes outside the 100-599 HTTP range', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-range');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    for (const bad of ['000', '600', '999']) {
      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/requests?status=${bad}`, {
          headers: { Authorization: `Bearer ${user.jwt}` },
        }),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(queried).toBe(false);
  });

  it('rejects a non-positive limit with 400 instead of a misleading 502', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'req-badlimit');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/requests?limit=-1`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });
});

describe('GET /projects/:id/logs limit validation', () => {
  it('rejects a non-positive limit with 400 instead of a misleading 502', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'logs-badlimit');

    let queried = false;
    mockCfApi({
      analyticsQuery: () => {
        queried = true;
        return Response.json({ data: [] });
      },
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/logs?limit=-1`, {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(queried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Owner auto-add on project create.
//
// The project owner's own address is registered with CF Email Routing so mail
// to themselves works from the first deploy. Entirely best-effort — every
// failure is logged and swallowed — which is exactly why it needs a test: a
// regression here is silent.
// ---------------------------------------------------------------------------
describe('POST /projects — owner email destination auto-add', () => {
  // The gate the route checks. Without a platform mail domain there is no
  // sender to allow-list a recipient for, so the auto-add stays inert.
  const emailEnv = () => ({
    ...env,
    EMAIL_GATEWAY_ORIGIN: 'https://void-email-gateway-staging.voidzer0.workers.dev',
    EMAIL_SENDER_DOMAIN: 'mail.voidcloud.dev',
  });

  // `respond` may be async so a test can commit a competing write (project
  // teardown's cascade) while the route is awaiting Cloudflare. The stub is
  // already called from an async fetch shim, and the shared `mockCfApi`
  // handlers for these same endpoints are typed the same way.
  function stubEmailRouting(
    respond: (method: string, url: string) => Response | Promise<Response>,
  ): Array<{ method: string; url: string }> {
    const calls: Array<{ method: string; url: string }> = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/email/routing/addresses')) {
        const method = init?.method ?? 'GET';
        calls.push({ method, url });
        return respond(method, url);
      }
      return inner(input, init);
    });
    return calls;
  }

  // `createTestUser` stores `email: null`, which the route treats as
  // "nothing to register". Give the owner a real address.
  async function withEmail(userId: string, email: string): Promise<string> {
    await env.db.update(users).set({ email }).where(eq(users.id, userId));
    return email;
  }

  async function createProjectAs(user: { jwt: string }, slug: string, bindings: TestEnv) {
    return app.fetch(
      new Request('http://localhost/projects', {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      }),
      bindings,
    );
  }

  it('registers the owner address and stores a pending row', async () => {
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'Owner@Example.com');
    mockCfApi();
    stubEmailRouting(() =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        // CF returns the row immediately; `verified` stays null until the
        // owner clicks the link it just mailed them.
        result: { tag: 'cf-tag-new', email: ownerEmail, verified: null },
      }),
    );

    const res = await createProjectAs(user, 'auto-add-app', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as {
      id: string;
      owner_email_destination?: { address: string; verified?: unknown };
    };
    // The response names the address being registered so the CLI can explain
    // the verification email that may follow. It carries no outcome: the add
    // runs after the response, so `verified` cannot be known here.
    expect(project.owner_email_destination).toEqual({ address: ownerEmail.toLowerCase() });

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(row).toMatchObject({
      // Stored lowercased regardless of how the user cased it.
      address: ownerEmail.toLowerCase(),
      cf_destination_id: 'cf-tag-new',
      status: 'pending',
      verification_source: 'cf',
    });
    // Nothing was inherited, so no consent to attribute.
    expect(row.verified_by_user_id).toBeNull();
  });

  it('reuses the tag and verified status when CF already has the address', async () => {
    // Second-or-later project for the same owner. Without the already-exists
    // recovery this project would start with an empty allowlist.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'repeat-owner@example.com');
    mockCfApi();
    stubEmailRouting((method) => {
      if (method === 'POST') {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10037, message: 'destination address already exists' }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ tag: 'cf-tag-existing', email: ownerEmail, verified: '2026-01-01T00:00:00Z' }],
      });
    });

    const res = await createProjectAs(user, 'auto-add-second', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as {
      id: string;
      owner_email_destination?: { address: string };
    };
    // Same notice as the fresh-address case: the response is built before
    // the add runs, so it cannot (and must not claim to) know CF adopted a
    // verified address.
    expect(project.owner_email_destination).toEqual({ address: ownerEmail });

    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(row).toMatchObject({
      cf_destination_id: 'cf-tag-existing',
      status: 'verified',
      verification_source: 'cf',
      // Owner-relaxed reuse: record whose prior consent this inherited.
      verified_by_user_id: user.id,
    });
    expect(row.verified_at).toContain('2026-01-01');
  });

  it('still creates the project when CF Email Routing is down', async () => {
    const user = await createTestUser(env.db);
    await withEmail(user.id, 'owner@example.com');
    mockCfApi();
    stubEmailRouting(() =>
      Response.json(
        { success: false, errors: [{ code: 1000, message: 'boom' }], messages: [], result: null },
        { status: 500 },
      ),
    );

    const res = await createProjectAs(user, 'auto-add-cf-down', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(rows).toHaveLength(0);
  });

  it('rolls the CF address back when teardown cascades the project mid-add', async () => {
    // The auto-add runs off the response path, so project teardown can commit
    // its cascade between `createProject` and the destination INSERT. The
    // INSERT then violates the foreign key, and nothing retries it — without a
    // rollback the account-level CF address stays allocated against the shared
    // 200-address cap with no row left to reclaim it from.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'cascade-owner@example.com');
    mockCfApi();
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        // Teardown lands while CF is registering the address.
        await env.db.delete(projects).where(eq(projects.slug, 'auto-add-cascaded'));
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { tag: 'cf-tag-cascaded', email: ownerEmail, verified: null },
      });
    });

    // Best-effort and post-response: the create still succeeds.
    const res = await createProjectAs(user, 'auto-add-cascaded', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(rows).toHaveLength(0);

    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain('/email/routing/addresses/cf-tag-cascaded');
  });

  it('leaves the CF address alone when a sibling project still references it', async () => {
    // Same cascade, but the address came back through the already-exists
    // recovery and a live sibling project's row still points at the tag. CF
    // destinations are account-level, so deleting it would silently revoke the
    // sibling's recipient: the reference count decides, not the failure.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'shared-owner@example.com');
    const sibling = await createTestProject(env.db, user.id, 'auto-add-sibling');
    await env.db.insert(emailDestinations).values({
      id: 'edst_sibling_shared',
      project_id: sibling.id,
      address: ownerEmail,
      cf_destination_id: 'cf-tag-shared',
      status: 'verified',
      verified_at: '2026-01-01T00:00:00Z',
      verification_source: 'cf',
    });
    mockCfApi();
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10037, message: 'destination address already exists' }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      // Teardown lands while we are recovering the existing tag.
      await env.db.delete(projects).where(eq(projects.slug, 'auto-add-shared'));
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ tag: 'cf-tag-shared', email: ownerEmail, verified: '2026-01-01T00:00:00Z' }],
      });
    });

    const res = await createProjectAs(user, 'auto-add-shared', emailEnv());
    expect(res.status).toBe(201);

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    const [survivor] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, sibling.id));
    expect(survivor).toMatchObject({
      cf_destination_id: 'cf-tag-shared',
      status: 'verified',
    });
  });

  // A manual `POST /projects/:id/email/destinations` for the owner's own
  // address can race the post-response auto-add. Its row wins the
  // `ON CONFLICT DO NOTHING` insert, so the helper reads the winner back
  // instead — and `{ row: null }` is what it reports when that winner was
  // deleted between the two statements.
  //
  // Interleaves at the driver: `env.db.$client` is the object drizzle issues
  // every statement through (PGlite here, `pg.Pool` under
  // VOID_TEST_DATABASE_URL), so a hook on its `query` can run the competing
  // delete after the helper's INSERT and before its SELECT with the real
  // helper untouched. The SQL shape is drizzle's: PGlite takes the text
  // directly, node-postgres wraps it in `{ text }`.
  //
  // An owner-audited INSERT runs inside a transaction (`tryCreateEmailDestination`
  // locks the owner's row first), and a transaction's statements never pass
  // through the top-level `query`: PGlite hands drizzle its own transaction
  // object, node-postgres a checked-out pool client. Watch those too — but
  // only to see the INSERT. The delete still fires at the read-back, which
  // the helper issues at top level after the transaction has committed; on
  // PGlite it could not run any earlier, since the transaction holds the
  // single session until then.
  function deleteRowBeforeReadBack(rowId: string): void {
    const client = env.db.$client as unknown as {
      query: (...args: Array<unknown>) => Promise<unknown>;
      transaction?: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      connect?: (
        ...args: Array<unknown>
      ) => Promise<{ query: (...args: Array<unknown>) => Promise<unknown> }>;
    };
    const textOf = (head: unknown): string =>
      typeof head === 'string' ? head : ((head as { text?: string })?.text ?? '');
    let sawInsert = false;
    const observe = (sql: string): void => {
      if (/^insert into "email_destinations"/i.test(sql)) {
        sawInsert = true;
      }
    };
    const original = client.query.bind(client);
    vi.spyOn(client, 'query').mockImplementation(async (...args: Array<unknown>) => {
      const sql = textOf(args[0]);
      observe(sql);
      if (sawInsert && /^select .* from "email_destinations"/i.test(sql)) {
        sawInsert = false;
        await env.db.delete(emailDestinations).where(eq(emailDestinations.id, rowId));
      }
      return original(...args);
    });
    if (typeof client.transaction === 'function') {
      // PGlite: the callback's transaction object is created per call.
      const originalTransaction = client.transaction.bind(client);
      vi.spyOn(client, 'transaction').mockImplementation((cb) =>
        originalTransaction((tx) =>
          cb(
            new Proxy(tx as object, {
              get(target, key, receiver) {
                const value = Reflect.get(target, key, receiver);
                if (key !== 'query' || typeof value !== 'function') {
                  return value;
                }
                return (...args: Array<unknown>) => {
                  observe(textOf(args[0]));
                  return value.apply(target, args);
                };
              },
            }),
          ),
        ),
      );
    }
    if (typeof client.connect === 'function') {
      // node-postgres: drizzle checks a client out of the pool per transaction
      // with the promise form. The pool's own `query` also goes through
      // `connect`, callback-style, for every top-level statement — leave
      // those calls untouched (the `query` spy above already sees them).
      const originalConnect = client.connect.bind(client);
      vi.spyOn(client, 'connect').mockImplementation((...args: Array<unknown>) => {
        if (args.length > 0) {
          return originalConnect(...args);
        }
        return originalConnect().then((pooled) => {
          const pooledQuery = pooled.query.bind(pooled);
          pooled.query = (...queryArgs: Array<unknown>) => {
            observe(textOf(queryArgs[0]));
            return pooledQuery(...queryArgs);
          };
          return pooled;
        });
      });
    }
  }

  it('rolls the CF address back when the winning manual row vanishes before read-back', async () => {
    // The manual add adopted the tag the auto-add had just allocated (CF said
    // "already exists", recovery listed it), so its row references the same
    // tag. Then that row is deleted without the tag being released — the
    // teardown cascade window, or a DELETE whose upstream call failed. The
    // helper reports `{ row: null }`; ignoring it exits "successfully" with a
    // live tag nothing references.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'raced-owner@example.com');
    mockCfApi();
    const helper = vi.spyOn(db, 'tryCreateEmailDestination');
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        // The manual add lands while CF is registering the address.
        const [project] = await env.db
          .select()
          .from(projects)
          .where(eq(projects.slug, 'auto-add-raced'));
        await env.db.insert(emailDestinations).values({
          id: 'edst_manual_raced',
          project_id: project!.id,
          address: ownerEmail,
          cf_destination_id: 'cf-tag-raced',
          status: 'pending',
          verification_source: 'cf',
        });
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { tag: 'cf-tag-raced', email: ownerEmail, verified: null },
      });
    });
    deleteRowBeforeReadBack('edst_manual_raced');

    const res = await createProjectAs(user, 'auto-add-raced', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    // The interleaving was the documented one, not a foreign-key failure.
    expect(helper).toHaveBeenCalledTimes(1);
    await expect(helper.mock.results[0]!.value).resolves.toEqual({ row: null, inserted: false });

    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(rows).toHaveLength(0);

    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toContain('/email/routing/addresses/cf-tag-raced');
  });

  it('leaves a vanished-row tag alone when a sibling project still references it', async () => {
    // The vanished-row failure must go through the same `refs === 0` guard as
    // every other rollback: the tag is account-level, and a sibling project's
    // live row is a reason to keep it regardless of what happened to ours.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'raced-shared-owner@example.com');
    const sibling = await createTestProject(env.db, user.id, 'auto-add-raced-sibling');
    await env.db.insert(emailDestinations).values({
      id: 'edst_raced_sibling',
      project_id: sibling.id,
      address: ownerEmail,
      cf_destination_id: 'cf-tag-raced-shared',
      status: 'verified',
      verified_at: '2026-01-01T00:00:00Z',
      verification_source: 'cf',
    });
    mockCfApi();
    const helper = vi.spyOn(db, 'tryCreateEmailDestination');
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10037, message: 'destination address already exists' }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      // The manual add lands while we are recovering the existing tag.
      const [project] = await env.db
        .select()
        .from(projects)
        .where(eq(projects.slug, 'auto-add-raced-shared'));
      await env.db.insert(emailDestinations).values({
        id: 'edst_manual_raced_shared',
        project_id: project!.id,
        address: ownerEmail,
        cf_destination_id: 'cf-tag-raced-shared',
        status: 'verified',
        verified_at: '2026-01-01T00:00:00Z',
        verification_source: 'cf',
      });
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [
          { tag: 'cf-tag-raced-shared', email: ownerEmail, verified: '2026-01-01T00:00:00Z' },
        ],
      });
    });
    deleteRowBeforeReadBack('edst_manual_raced_shared');

    const res = await createProjectAs(user, 'auto-add-raced-shared', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    expect(helper).toHaveBeenCalledTimes(1);
    await expect(helper.mock.results[0]!.value).resolves.toEqual({ row: null, inserted: false });
    expect(
      await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.project_id, project.id)),
    ).toHaveLength(0);

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    const [survivor] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, sibling.id));
    expect(survivor).toMatchObject({
      cf_destination_id: 'cf-tag-raced-shared',
      status: 'verified',
    });
  });

  it('keeps the manual row and the tag when a manual add for the address won', async () => {
    // Same race, but the winning row is still there when the helper reads it
    // back: that is a success, not a failure. The manual row must survive
    // untouched and the tag it references must not be revoked.
    const user = await createTestUser(env.db);
    const ownerEmail = await withEmail(user.id, 'won-owner@example.com');
    mockCfApi();
    const helper = vi.spyOn(db, 'tryCreateEmailDestination');
    const calls = stubEmailRouting(async (method) => {
      if (method === 'POST') {
        const [project] = await env.db
          .select()
          .from(projects)
          .where(eq(projects.slug, 'auto-add-won'));
        await env.db.insert(emailDestinations).values({
          id: 'edst_manual_won',
          project_id: project!.id,
          address: ownerEmail,
          cf_destination_id: 'cf-tag-won',
          status: 'pending',
          verification_source: 'cf',
        });
      }
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { tag: 'cf-tag-won', email: ownerEmail, verified: null },
      });
    });

    const res = await createProjectAs(user, 'auto-add-won', emailEnv());
    expect(res.status).toBe(201);
    const project = (await res.json()) as { id: string };

    expect(helper).toHaveBeenCalledTimes(1);
    await expect(helper.mock.results[0]!.value).resolves.toMatchObject({
      row: { id: 'edst_manual_won' },
      inserted: false,
    });
    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'edst_manual_won', cf_destination_id: 'cf-tag-won' });
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('makes no CF call when the environment has no platform mail domain', async () => {
    const user = await createTestUser(env.db);
    await withEmail(user.id, 'owner@example.com');
    mockCfApi();
    const calls = stubEmailRouting(() => Response.json({ success: true, errors: [], result: {} }));

    // `env` as-is — EMAIL_SENDER_DOMAIN unset.
    const res = await createProjectAs(user, 'auto-add-no-domain', env);
    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
    // No add scheduled, so the response must not announce one.
    expect(await res.json()).not.toHaveProperty('owner_email_destination');
  });

  it('skips synthetic GitHub noreply addresses, which are not deliverable', async () => {
    const user = await createTestUser(env.db);
    await withEmail(user.id, 'octocat@users.noreply.github.com');
    mockCfApi();
    const calls = stubEmailRouting(() => Response.json({ success: true, errors: [], result: {} }));

    const res = await createProjectAs(user, 'auto-add-synthetic', emailEnv());
    expect(res.status).toBe(201);
    expect(calls).toEqual([]);
    expect(await res.json()).not.toHaveProperty('owner_email_destination');
  });
});
