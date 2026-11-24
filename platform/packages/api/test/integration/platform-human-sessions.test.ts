import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { signJwt, verifyJwt } from '../../src/auth/jwt.ts';
import {
  createHumanSession,
  revokeConnectionSessions,
  validateHumanSession,
} from '../../src/auth/sessions.ts';
import { app } from '../../src/index.ts';
import {
  platformAuthSettings,
  platformHumanSessions,
  platformLoginConnections,
} from '../../src/schema.ts';
import {
  clearTables,
  createTestBuild,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let admin: Awaited<ReturnType<typeof createTestUser>>;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  admin = await createTestUser(env.db, 'admin', 'github', '123', 'custom', 'admin');
  await importLegacyAuthentication(env.db, env);
});

function mint(
  audience: 'api' | 'admin' = 'api',
  companyIdentity?: { issuer: string; subject: string },
) {
  return createHumanSession(env.db, env.JWT_SECRET, {
    userId: admin.id,
    connectionId: 'github',
    revision: 1,
    generation: 1,
    audience,
    companyIdentity,
  });
}

function request(path: string, token: string, body?: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

describe('platform human session revocation', () => {
  it('keeps legacy login working until the coordinated migration requires session records', async () => {
    expect((await request('/me', admin.jwt)).status).toBe(200);
    await env.db.update(platformAuthSettings).set({ sessions_required: true });
    expect((await request('/me', admin.jwt)).status).toBe(401);
    expect((await request('/me', (await mint()).token)).status).toBe(200);
  });

  it('revokes API, browser-admin, and derived operator sessions together', async () => {
    const api = await mint();
    const browser = await mint('admin');
    const elevation = await request('/operator/v1/session', api.token, {});
    expect(elevation.status).toBe(200);
    const operator = await elevation.json<{ token: string }>();
    expect((await request('/operator/v1/session', operator.token)).status).toBe(200);
    await env.db.transaction(async (tx) => {
      await tx
        .update(platformLoginConnections)
        .set({ enabled: false })
        .where(eq(platformLoginConnections.id, 'github'));
      await revokeConnectionSessions(tx, 'github');
    });
    expect((await request('/me', api.token)).status).toBe(401);
    expect((await request('/operator/v1/session', operator.token)).status).toBe(401);
    expect((await request('/operator/v1/session', api.token, {})).status).toBe(401);
    const browserResponse = await app.fetch(
      new Request('http://localhost/admin/', {
        headers: { Cookie: `admin_token=${browser.token}` },
      }),
      env,
    );
    expect(browserResponse.status).toBe(302);
    expect(browserResponse.headers.get('Location')).toBe('/admin/login');
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: true })
      .where(eq(platformLoginConnections.id, 'github'));
    expect((await request('/me', api.token)).status).toBe(401);
    await expect(mint()).rejects.toMatchObject({ code: 'login_changed' });
  });

  it('does not revoke scoped deployment tokens or confuse them with human sessions', async () => {
    mockCfApi();
    await env.db.update(platformAuthSettings).set({ sessions_required: true });
    const project = await createTestProject(env.db, admin.id, 'project');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: admin.id,
      status: 'building',
    });
    const deploy = await signJwt(
      { sub: admin.id, login: admin.login, aud: 'deploy', project: project.id, build: build.id },
      env.JWT_SECRET,
    );
    await revokeConnectionSessions(env.db, 'github');
    expect((await request('/projects', deploy)).status).toBe(200);
    expect((await request('/me', deploy)).status).toBe(403);
    expect((await request('/operator/v1/session', deploy, {})).status).toBe(401);
  });

  it('checks session revocation in the proxy ownership authority', async () => {
    const session = await mint();
    const project = await createTestProject(env.db, admin.id, 'proxy-project');
    const proxyOrigin = 'http://localhost';
    const internalToken = await hmacSignState(
      `void-proxy-owner-v2\n${project.id}\n${proxyOrigin}`,
      env.JWT_SECRET,
    );
    const proxyCheck = (jwt?: string) =>
      app.fetch(
        new Request(`http://localhost/internal/verify-owner/${project.id}`, {
          method: 'POST',
          headers: { 'X-Void-Internal': internalToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: admin.id, jwt, proxyOrigin }),
        }),
        env,
      );
    expect((await proxyCheck(session.token)).status).toBe(200);
    await revokeConnectionSessions(env.db, 'github');
    expect((await proxyCheck(session.token)).status).toBe(403);
    await env.db.update(platformAuthSettings).set({ sessions_required: true });
    expect((await proxyCheck()).status).toBe(403);
  });

  it('rejects a different employee presenting another employee’s otherwise valid Void session', async () => {
    await env.db.update(platformAuthSettings).set({
      protection: {
        teamDomain: 'https://company.cloudflareaccess.com',
        applications: [{ origin: 'https://api.example.com', audience: 'app' }],
      },
    });
    const identity = { issuer: 'https://company.cloudflareaccess.com', subject: 'employee-1' };
    await expect(mint()).rejects.toMatchObject({ code: 'company_identity_required' });
    const session = await mint('api', identity);
    const payload = (await verifyJwt(session.token, env.JWT_SECRET, 'api'))!;
    expect(await validateHumanSession(env.db, payload, identity)).toBe(true);
    expect(
      await validateHumanSession(env.db, payload, { ...identity, subject: 'employee-2' }),
    ).toBe(false);
    expect(await validateHumanSession(env.db, payload)).toBe(false);
    expect(await validateHumanSession(env.db, { sub: admin.id, aud: 'api' }, identity)).toBe(false);
  });

  it('rejects expired records, different users, and crossed token audiences', async () => {
    const session = await mint();
    const payload = (await verifyJwt(session.token, env.JWT_SECRET))!;
    expect(await validateHumanSession(env.db, { ...payload, sub: 'different' })).toBe(false);
    expect(await validateHumanSession(env.db, { ...payload, aud: 'admin' })).toBe(false);
    await env.db
      .update(platformHumanSessions)
      .set({ expires_at: new Date(0).toISOString() })
      .where(eq(platformHumanSessions.id, session.session.id));
    expect(await validateHumanSession(env.db, payload)).toBe(false);
  });
});
