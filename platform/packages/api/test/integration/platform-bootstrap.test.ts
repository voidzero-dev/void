import {
  platformAuthenticationRecoveryMessage,
  type PlatformAuthenticationRecovery,
} from '@void/platform';
import { eq, sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { chromium } from 'playwright';
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
import {
  commitAuthenticationRecovery,
  recoverAuthenticationCredential,
} from '../../../../../packages/void/src/cli/platform-auth-recovery-core.ts';
import { authenticationSetupRequestHash } from '../../../../../packages/void/src/cli/platform-install-auth.ts';
import { readPlatformAdministratorSetupConnection } from '../../../../../packages/void/src/cli/platform-installer-database.ts';
import { AUTH_SETUP_PROOF_PREFIX, initializeAuthentication } from '../../src/auth/bootstrap.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { signJwt } from '../../src/auth/jwt.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import { hashLoginProof, randomLoginProof } from '../../src/auth/proofs.ts';
import { app } from '../../src/index.ts';
import {
  platformAuthBootstrap,
  platformAuthAttempts,
  platformAuthSettings,
  platformLoginConnections,
  platformLoginRevisions,
  platformLoginTests,
  platformLoginIdentities,
  platformHumanSessions,
  operatorSessions,
  operatorEvents,
  users,
} from '../../src/schema.ts';
import {
  clearTables,
  createTestBuild,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

const origin = 'https://api.example.com';
const issuer = 'https://identity.bootstrap-example.com';
const installationId = 'installation-bootstrap';
let env: TestEnv;
let code: string;
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
let authorization: URL;
beforeAll(async () => {
  env = await setupEnv();
  await env.db.execute(
    sql`CREATE TABLE IF NOT EXISTS __void_platform_installation (singleton boolean PRIMARY KEY, installation_id text NOT NULL)`,
  );
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'bootstrap-key', use: 'sig' };
});
afterAll(async () => {
  await env.db.execute(sql`DROP TABLE IF EXISTS __void_platform_installation`);
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.db.execute(
    sql`INSERT INTO __void_platform_installation (singleton, installation_id) VALUES (true, ${installationId})`,
  );
  code = randomLoginProof();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['ES256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        });
      }
      if (url === `${issuer}/token`) {
        const body = options?.body as URLSearchParams;
        expect(body.get('client_secret')).toBe('oidc-bootstrap-secret');
        expect(await createCodeChallenge(body.get('code_verifier')!)).toBe(
          authorization.searchParams.get('code_challenge'),
        );
        const idToken = await new SignJWT({
          nonce: authorization.searchParams.get('nonce'),
          email: 'administrator@example.com',
          email_verified: true,
        })
          .setIssuer(issuer)
          .setAudience('client')
          .setSubject('administrator-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .setProtectedHeader({ alg: 'ES256', kid: 'bootstrap-key' })
          .sign(privateKey);
        return Response.json({
          token_type: 'Bearer',
          access_token: 'temporary-provider-token',
          id_token: idToken,
        });
      }
      if (url === `${issuer}/keys`) {
        return Response.json({ keys: [jwk] });
      }
      throw new Error('Unexpected request, including any GitHub dependency');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
function bindings() {
  return {
    ...env,
    PLATFORM_INSTALLATION_ID: installationId,
    PLATFORM_AUTH_SETUP_TOKEN: 'setup-authority-fixture',
    PLATFORM_HEALTH_PROBE_TOKEN: 'health-probe-fixture',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  };
}
async function input(extra: Record<string, unknown> = {}) {
  return {
    connections: [
      {
        configuration: {
          id: 'company',
          kind: 'oidc',
          label: 'Company SSO',
          issuer,
          clientId: 'client',
        },
        clientSecret: 'oidc-bootstrap-secret',
      },
    ],
    administratorConnectionId: 'company',
    bootstrapCredentialHash: await hashLoginProof(code),
    admission: { mode: 'restricted' },
    protection: null,
    ...extra,
  };
}
async function initialize(
  extra: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
  key = 'setup-authority-fixture',
) {
  const body = JSON.stringify(await input(extra));
  const signature = await hmacSignState(
    `${AUTH_SETUP_PROOF_PREFIX}\n${installationId}\n${body}`,
    key,
  );
  return app.fetch(
    new Request(`${origin}/internal/platform/auth-initialize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Void-Auth-Setup': signature,
      },
      body,
    }),
    { ...bindings(), ...overrides },
  );
}
function form(path: string, values: Record<string, string>, cookie = '', requestOrigin = origin) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: requestOrigin,
        Cookie: cookie,
      },
      body: new URLSearchParams(values),
    }),
    bindings(),
  );
}
async function authenticateSetup() {
  const start = await form('/auth/bootstrap', { code });
  expect(start.status).toBe(302);
  authorization = new URL(start.headers.get('Location')!);
  const cookie = start.headers.get('Set-Cookie')!.split(';')[0]!;
  return app.fetch(
    new Request(
      `${origin}/auth/callback?code=provider-code&state=${authorization.searchParams.get('state')}`,
      { headers: { Cookie: cookie } },
    ),
    bindings(),
  );
}
function recoveryDatabase() {
  return {
    query: async <T extends Record<string, unknown>>(
      query: string,
      values: ReadonlyArray<unknown> = [],
    ) => {
      const fragments = query
        .split(/(\$\d+)/)
        .map((part) =>
          /^\$\d+$/.test(part) ? sql`${values[Number(part.slice(1)) - 1]}` : sql.raw(part),
        );
      return (await env.db.execute(sql.join(fragments, sql.raw('')))) as {
        rows: ReadonlyArray<T>;
      };
    },
  };
}

describe('provider-independent first administrator setup', () => {
  it('recovers an existing administrator with original secrets and a fresh browser identity without creating a session or reopening signup', async () => {
    await initialize();
    const administrator = await createTestUser(
      env.db,
      'admin',
      'github',
      undefined,
      'custom',
      'admin',
    );
    const revision = (await env.db.select().from(platformLoginRevisions))[0]!;
    expect(
      recoverAuthenticationCredential(
        env.PROJECT_SECRET_KEYS_JSON,
        installationId,
        'company',
        1,
        revision.secret,
      ),
    ).toBe('oidc-bootstrap-secret');
    expect(() =>
      recoverAuthenticationCredential(
        env.PROJECT_SECRET_KEYS_JSON,
        'other-installation',
        'company',
        1,
        revision.secret,
      ),
    ).toThrow('original platform encryption');
    const proof = randomLoginProof();
    const unsigned = {
      installationId,
      administratorUserId: administrator.id,
      connectionId: 'company',
      revision: 1,
      generation: 1,
      testId: `test.${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const recovery: PlatformAuthenticationRecovery = {
      ...unsigned,
      signature: await hmacSignState(
        platformAuthenticationRecoveryMessage(unsigned),
        env.JWT_SECRET,
      ),
    };
    await env.db.insert(platformAuthAttempts).values({
      id: recovery.testId,
      connection_id: 'company',
      revision: 1,
      generation: 1,
      purpose: 'test',
      browser_hash: await hashLoginProof(proof),
      context: {
        phase: 'launch',
        actor: { userId: administrator.id, sessionId: '', audience: 'api' },
        recovery,
      },
      expires_at: recovery.expiresAt,
    });
    const start = await app.fetch(
      new Request(`${origin}/auth/test?id=${recovery.testId}&proof=${proof}`),
      bindings(),
    );
    expect(start.status).toBe(302);
    authorization = new URL(start.headers.get('Location')!);
    const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const callback = await app.fetch(
      new Request(
        `${origin}/auth/callback?code=provider-code&state=${authorization.searchParams.get('state')}`,
        { headers: { Cookie: cookie } },
      ),
      bindings(),
    );
    expect(callback.status).toBe(200);
    expect(callback.headers.getSetCookie().some((value) => value.startsWith('admin_token='))).toBe(
      false,
    );
    expect((await env.db.select().from(platformLoginConnections))[0]?.enabled).toBe(false);
    const database = recoveryDatabase();
    await expect(
      commitAuthenticationRecovery(database, {
        recovery,
        identity: { issuer, subject: 'wrong-subject' },
      }),
    ).rejects.toThrow('fresh successful');
    expect(await env.db.select().from(platformLoginTests)).toHaveLength(1);
    const otherUser = await createTestUser(env.db, 'other-user');
    await env.db.insert(platformLoginIdentities).values({
      id: 'occupied-identity',
      user_id: otherUser.id,
      connection_id: 'company',
      issuer,
      subject: 'administrator-subject',
    });
    await expect(
      commitAuthenticationRecovery(database, {
        recovery,
        identity: { issuer, subject: 'administrator-subject' },
      }),
    ).rejects.toThrow('cannot take it over');
    expect(await env.db.select().from(platformLoginTests)).toHaveLength(1);
    await env.db
      .delete(platformLoginIdentities)
      .where(eq(platformLoginIdentities.id, 'occupied-identity'));
    await env.db.insert(platformHumanSessions).values(
      [administrator, otherUser].map((user) => ({
        id: `session-${user.id}`,
        user_id: user.id,
        connection_id: 'company',
        generation: 1,
        audience: 'api' as const,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })),
    );
    await env.db.insert(operatorSessions).values({
      id: 'derived-operator',
      user_id: administrator.id,
      human_session_id: `session-${administrator.id}`,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    await env.db.insert(operatorSessions).values({
      id: 'unrelated-legacy-operator',
      user_id: otherUser.id,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    // Imported legacy installations permit sessionless JWTs until the first
    // managed authentication mutation activates authoritative session records.
    await env.db.update(platformAuthSettings).set({ sessions_required: false });
    const legacyApiToken = await signJwt(
      { sub: administrator.id, login: administrator.login, aud: 'api' },
      env.JWT_SECRET,
    );
    const legacyAdminToken = await signJwt(
      { sub: administrator.id, login: administrator.login, aud: 'admin' },
      env.JWT_SECRET,
    );
    const project = await createTestProject(env.db, administrator.id, 'recovery-scoped-token');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: administrator.id,
      status: 'building',
    });
    const scopedDeployToken = await signJwt(
      {
        sub: administrator.id,
        login: administrator.login,
        aud: 'deploy',
        project: project.id,
        build: build.id,
      },
      env.JWT_SECRET,
    );
    expect(
      (
        await app.fetch(
          new Request(`${origin}/me`, {
            headers: { Authorization: `Bearer ${legacyApiToken}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(200);
    const elevation = await app.fetch(
      new Request(`${origin}/operator/v1/session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${legacyApiToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      bindings(),
    );
    expect(elevation.status).toBe(200);
    const legacyOperatorToken = (await elevation.json<{ token: string }>()).token;
    expect(
      (
        await app.fetch(
          new Request(`${origin}/admin/config/auth`, {
            headers: { Cookie: `admin_token=${legacyAdminToken}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(200);
    await commitAuthenticationRecovery(database, {
      recovery,
      identity: { issuer, subject: 'administrator-subject' },
    });
    expect((await env.db.select().from(platformLoginIdentities))[0]).toMatchObject({
      user_id: administrator.id,
      subject: 'administrator-subject',
    });
    expect((await env.db.select().from(platformLoginConnections))[0]).toMatchObject({
      enabled: true,
      active_revision: 1,
      generation: 2,
    });
    expect((await env.db.select().from(platformAuthSettings))[0]?.admission).toEqual({
      mode: 'restricted',
    });
    expect((await env.db.select().from(platformAuthSettings))[0]?.sessions_required).toBe(true);
    expect(await env.db.select().from(users)).toHaveLength(2);
    expect(
      (await env.db.select().from(platformHumanSessions)).every(
        (session) => session.revoked_at !== null,
      ),
    ).toBe(true);
    expect(await env.db.select().from(operatorSessions)).toHaveLength(0);
    expect(
      (
        await app.fetch(
          new Request(`${origin}/me`, {
            headers: { Authorization: `Bearer ${legacyApiToken}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`${origin}/operator/v1/session`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${legacyApiToken}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
          }),
          bindings(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`${origin}/operator/v1/config/auth`, {
            headers: { Authorization: `Bearer ${legacyOperatorToken}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(401);
    const legacyAdminResponse = await app.fetch(
      new Request(`${origin}/admin/config/auth`, {
        headers: { Cookie: `admin_token=${legacyAdminToken}` },
      }),
      bindings(),
    );
    expect(legacyAdminResponse.status).toBe(302);
    expect(legacyAdminResponse.headers.get('Location')).toBe('/admin/login');
    expect(
      (
        await app.fetch(
          new Request(`${origin}/projects`, {
            headers: { Authorization: `Bearer ${scopedDeployToken}` },
          }),
          bindings(),
        )
      ).status,
    ).toBe(200);
    expect(
      (await env.db.select().from(operatorEvents)).some(
        (row) => row.action === 'auth.recovery.confirm',
      ),
    ).toBe(true);
    await expect(
      commitAuthenticationRecovery(database, {
        recovery,
        identity: { issuer, subject: 'administrator-subject' },
      }),
    ).rejects.toThrow('configuration changed');
  });

  it('rejects recovery that would make a company-trusted Google revision unrestricted', async () => {
    const restrictedGoogle = {
      id: 'google',
      kind: 'google' as const,
      label: 'Google Workspace',
      clientId: 'google-client',
      issuer: 'https://accounts.google.com',
      allowedDomains: ['example.com'],
      requiredGroups: [],
    };
    expect(
      (
        await initialize({
          connections: [{ configuration: restrictedGoogle, clientSecret: 'google-secret' }],
          administratorConnectionId: 'google',
          admission: { mode: 'company', connections: ['google'], access: false },
        })
      ).status,
    ).toBe(200);
    const administrator = await createTestUser(
      env.db,
      'workspace-admin',
      'google',
      'workspace-subject',
      'custom',
      'admin',
    );
    const [firstRevision] = await env.db.select().from(platformLoginRevisions);
    await env.db.insert(platformLoginRevisions).values({
      connection_id: 'google',
      revision: 2,
      configuration: { ...restrictedGoogle, allowedDomains: [] },
      secret: firstRevision.secret,
    });
    await env.db
      .update(platformLoginConnections)
      .set({ revision: 2 })
      .where(eq(platformLoginConnections.id, 'google'));
    const recovery: PlatformAuthenticationRecovery = {
      installationId,
      administratorUserId: administrator.id,
      connectionId: 'google',
      revision: 2,
      generation: 1,
      testId: 'test.google-recovery',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      signature: 'verified-by-the-browser-recovery-flow',
    };
    await env.db.insert(platformLoginTests).values({
      id: recovery.testId,
      user_id: administrator.id,
      connection_id: 'google',
      revision: 2,
      issuer: 'https://accounts.google.com',
      subject: 'workspace-subject',
      login: 'workspace-admin',
      expires_at: recovery.expiresAt,
    });

    await expect(
      commitAuthenticationRecovery(recoveryDatabase(), {
        recovery,
        identity: { issuer: 'https://accounts.google.com', subject: 'workspace-subject' },
      }),
    ).rejects.toThrow('Unrestricted social login');
    expect((await env.db.select().from(platformLoginConnections))[0]).toMatchObject({
      enabled: false,
      active_revision: null,
      revision: 2,
      generation: 1,
    });
    expect((await env.db.select().from(platformAuthSettings))[0]).toMatchObject({
      admission: { mode: 'company', connections: ['google'], access: false },
      sessions_required: true,
    });
    expect(await env.db.select().from(platformLoginTests)).toHaveLength(1);
  });

  it.each(['wrong-signature', 'wrong-installation', 'expired', 'ordinary-user', 'suspended-admin'])(
    'rejects %s recovery test capabilities',
    async (condition) => {
      await initialize();
      const administrator = await createTestUser(
        env.db,
        'admin',
        'github',
        undefined,
        'custom',
        condition === 'ordinary-user' ? 'user' : 'admin',
      );
      if (condition === 'suspended-admin') {
        await env.db
          .update(users)
          .set({ suspended_reason: 'admin' })
          .where(eq(users.id, administrator.id));
      }
      const proof = randomLoginProof();
      const unsigned = {
        installationId:
          condition === 'wrong-installation' ? 'another-installation' : installationId,
        administratorUserId: administrator.id,
        connectionId: 'company',
        revision: 1,
        generation: 1,
        testId: `test.${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + (condition === 'expired' ? -1 : 600_000)).toISOString(),
      };
      const recovery = {
        ...unsigned,
        signature: await hmacSignState(
          platformAuthenticationRecoveryMessage(unsigned),
          condition === 'wrong-signature' ? 'other-key' : env.JWT_SECRET,
        ),
      };
      await env.db.insert(platformAuthAttempts).values({
        id: recovery.testId,
        connection_id: 'company',
        revision: 1,
        generation: 1,
        purpose: 'test',
        browser_hash: await hashLoginProof(proof),
        context: {
          phase: 'launch',
          actor: { userId: administrator.id, sessionId: '', audience: 'api' },
          recovery,
        },
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      const result = await app.fetch(
        new Request(`${origin}/auth/test?id=${recovery.testId}&proof=${proof}`),
        bindings(),
      );
      expect(result.status).toBe(400);
      expect(await env.db.select().from(platformLoginTests)).toHaveLength(0);
    },
  );
  it('does not accept health-probe authority or unverified database caching', async () => {
    expect((await initialize({}, {}, 'health-probe-fixture')).status).toBe(403);
    expect(await env.db.select().from(platformAuthSettings)).toHaveLength(0);
    expect((await initialize({}, { PLATFORM_AUTH_DATABASE_UNCACHED: undefined })).status).toBe(503);
    expect(await env.db.select().from(platformAuthSettings)).toHaveLength(0);
    expect((await initialize({}, { PLATFORM_TRAFFIC_STATE: 'staging' })).status).toBe(200);
  });

  it('requires the database claim to match the installing platform', async () => {
    await env.db.execute(
      sql`UPDATE __void_platform_installation SET installation_id = 'another-installation'`,
    );
    expect((await initialize()).status).toBe(403);
    expect(await env.db.select().from(users)).toHaveLength(0);
  });

  it(
    'accepts native browser submissions for setup and administrator confirmation without exposing callback details',
    async () => {
      expect((await initialize()).status).toBe(200);
      const browser = await chromium.launch();
      const submissions: Array<{
        path: string;
        origin: string | undefined;
        referrer: string | undefined;
        status: number;
      }> = [];
      let suppressSetupOrigin = false;
      try {
        const page = await browser.newPage();
        // Fulfill every browser request locally, retaining real browser form,
        // cookie, referrer-policy, and Origin behavior without external traffic.
        await page.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin === issuer && url.pathname === '/authorize') {
            authorization = url;
            await route.fulfill({
              contentType: 'text/html',
              body: '<h1>Local identity provider</h1>',
            });
            return;
          }
          if (url.origin !== origin) {
            await route.abort();
            return;
          }
          const headers = await request.allHeaders();
          const response = await app.fetch(
            new Request(request.url(), {
              method: request.method(),
              headers,
              ...(request.method() === 'POST' ? { body: request.postData() ?? '' } : {}),
            }),
            bindings(),
          );
          if (request.method() === 'POST') {
            submissions.push({
              path: url.pathname,
              origin: headers.origin,
              referrer: headers.referer,
              status: response.status,
            });
          }
          // Playwright does not route subsequent requests in a redirect chain.
          // Keep the real API response evidence, then serve a local handoff page
          // so the browser never resolves an external provider or fixture origin.
          if (request.method() === 'POST' && response.status === 302) {
            if (url.pathname === '/auth/bootstrap') {
              authorization = new URL(response.headers.get('Location')!);
            } else {
              expect(response.headers.get('Location')).toBe('/admin/');
            }
            const responseHeaders = Object.fromEntries(response.headers);
            delete responseHeaders.location;
            await route.fulfill({
              status: 200,
              headers: responseHeaders,
              body:
                url.pathname === '/auth/bootstrap'
                  ? '<h1>Local provider handoff</h1>'
                  : '<h1>Administrator ready</h1>',
            });
            return;
          }
          const responseHeaders = Object.fromEntries(response.headers);
          if (suppressSetupOrigin && url.pathname === '/setup') {
            responseHeaders['referrer-policy'] = 'no-referrer';
          }
          await route.fulfill({
            status: response.status,
            headers: responseHeaders,
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        // A no-referrer setup page makes the browser send `Origin: null`, which the
        // real Origin guard rejects.
        suppressSetupOrigin = true;
        await page.goto(`${origin}/setup`);
        await page.getByLabel('Setup code').fill(code);
        await Promise.all([
          page.waitForURL(`${origin}/auth/bootstrap`),
          page.getByRole('button', { name: 'Continue with Company SSO' }).click(),
        ]);
        expect(submissions).toEqual([
          { path: '/auth/bootstrap', origin: 'null', referrer: undefined, status: 403 },
        ]);
        expect(await env.db.select().from(platformAuthAttempts)).toHaveLength(0);
        submissions.length = 0;
        suppressSetupOrigin = false;
        await page.goto(`${origin}/setup`);
        await page.getByRole('button', { name: 'Continue with Company SSO' }).click();
        expect(submissions).toEqual([]);
        expect(await page.locator('input[name="code"]:invalid').count()).toBe(1);
        await page.getByLabel('Setup code').fill(code);
        await Promise.all([
          page.waitForURL(`${origin}/auth/bootstrap`),
          page.getByRole('button', { name: 'Continue with Company SSO' }).click(),
        ]);
        expect(submissions).toEqual([
          { path: '/auth/bootstrap', origin, referrer: `${origin}/`, status: 302 },
        ]);
        await page.getByRole('heading', { name: 'Local provider handoff' }).waitFor();
        await page.goto(authorization.href);
        await page.goto(
          `${origin}/auth/callback?code=provider-code&state=${authorization.searchParams.get('state')}`,
        );
        await page.getByRole('heading', { name: 'Confirm the first administrator' }).waitFor();
        expect(await env.db.select().from(users)).toHaveLength(0);
        await Promise.all([
          page.waitForURL(`${origin}/auth/bootstrap/confirm`),
          page
            .getByRole('button', { name: 'Make this account the platform administrator' })
            .click(),
        ]);
        expect(submissions).toEqual([
          { path: '/auth/bootstrap', origin, referrer: `${origin}/`, status: 302 },
          { path: '/auth/bootstrap/confirm', origin, referrer: `${origin}/`, status: 302 },
        ]);
        await page.getByRole('heading', { name: 'Administrator ready' }).waitFor();
        const accounts = await env.db.select().from(users);
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({ role: 'admin', provider_id: 'administrator-subject' });
      } finally {
        await browser.close();
      }
    },
    // Launching Chromium alone can take longer than the default under a full parallel run.
    30_000,
  );

  it('bootstraps an OIDC-only installation only after the owner reviews and confirms the identity', async () => {
    expect((await initialize()).status).toBe(200);
    expect((await initialize()).status).toBe(200);
    const discovery = await (
      await app.fetch(new Request(`${origin}/.well-known/void-platform`), bindings())
    ).json();
    expect(discovery).toMatchObject({
      schemaVersion: 3,
      authenticationProviders: [],
      authentication: { setupPending: true },
    });
    expect(await env.db.select().from(users)).toHaveLength(0);
    const rows = await env.db.select().from(platformLoginRevisions);
    expect(JSON.stringify(rows)).not.toContain('oidc-bootstrap-secret');
    expect(JSON.stringify(await env.db.select().from(platformAuthBootstrap))).not.toContain(code);
    expect(
      (await app.fetch(new Request(`${origin}/admin/login`), bindings())).headers.get('Location'),
    ).toBe('/setup');
    const setupPage = await app.fetch(new Request(`${origin}/setup`), {
      ...bindings(),
      PLATFORM_DISPLAY_NAME: '<Example Platform>',
    });
    expect(await setupPage.text()).toContain(
      '<title>Set up administrator · &lt;Example Platform&gt; · Void</title>',
    );
    expect((await form('/auth/bootstrap', { code: randomLoginProof() })).status).toBe(403);
    expect(
      (await form('/auth/bootstrap', { code }, '', 'https://attacker.example.com')).status,
    ).toBe(403);
    const callback = await authenticateSetup();
    expect(callback.status).toBe(200);
    const callbackHtml = await callback.text();
    expect(callbackHtml).toContain('administrator@example.com');
    expect(callbackHtml).toContain('<title>Confirm platform administrator · Void Platform</title>');
    expect(await env.db.select().from(users)).toHaveLength(0);
    const proofCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('void_bootstrap_confirm='))!
      .split(';')[0]!;
    expect(
      (
        await form(
          '/auth/bootstrap/confirm',
          { confirm: 'yes' },
          proofCookie,
          'https://attacker.example.com',
        )
      ).status,
    ).toBe(403);
    const confirmations = await Promise.all([
      form('/auth/bootstrap/confirm', { confirm: 'yes' }, proofCookie),
      form('/auth/bootstrap/confirm', { confirm: 'yes' }, proofCookie),
    ]);
    expect(confirmations.map((response) => response.status).sort()).toEqual([302, 403]);
    const usersAfter = await env.db.select().from(users);
    expect(usersAfter).toHaveLength(1);
    expect(usersAfter[0]).toMatchObject({
      role: 'admin',
      provider: 'oidc:company',
      provider_id: 'administrator-subject',
      plan: 'custom',
    });
    expect((await env.db.select().from(platformLoginConnections))[0]).toMatchObject({
      enabled: true,
      active_revision: 1,
    });
    const adminCookie = confirmations
      .find((response) => response.status === 302)!
      .headers.getSetCookie()
      .find((cookie) => cookie.startsWith('admin_token='))!
      .split(';')[0]!;
    expect(
      (
        await app.fetch(
          new Request(`${origin}/admin/config/auth`, { headers: { Cookie: adminCookie } }),
          bindings(),
        )
      ).status,
    ).toBe(200);
    expect((await form('/auth/bootstrap/confirm', { confirm: 'yes' }, proofCookie)).status).toBe(
      403,
    );
    expect(
      (
        await initialize({
          bootstrapCredentialHash: await hashLoginProof(randomLoginProof()),
          resetPending: true,
        })
      ).status,
    ).toBe(409);
    expect(await (await initialize()).json()).toMatchObject({ setupPending: false });
  });

  it('shows the code, callback URL, and repair command when first administrator sign-in fails', async () => {
    expect((await initialize()).status).toBe(200);
    const start = await form('/auth/bootstrap', { code });
    expect(start.status).toBe(302);
    authorization = new URL(start.headers.get('Location')!);
    const cookie = start.headers.get('Set-Cookie')!.split(';')[0]!;
    const provider = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, options?: RequestInit) =>
      input.toString() === `${issuer}/token`
        ? Response.json({ error: 'invalid_client' }, { status: 401 })
        : provider(input, options),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const page = await app.fetch(
      new Request(
        `${origin}/auth/callback?code=provider-code&state=${authorization.searchParams.get('state')}`,
        { headers: { Cookie: cookie, Accept: 'text/html' } },
      ),
      bindings(),
    );
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain('The provider refused the token request.');
    expect(html).toContain('Error code: oidc_token_failed');
    expect(html).toContain(`Callback URL: ${origin}/auth/callback`);
    expect(html).toContain(`void platform repair ${installationId}</code>`);
    expect(html).toContain('href="/setup"');
    expect(errors).toHaveBeenCalledWith('[auth] login failed', {
      code: 'oidc_token_failed',
      purpose: 'bootstrap',
      connectionId: 'company',
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('oidc-bootstrap-secret');
    errors.mockRestore();
  });

  it('reads pending administrator setup for the installing CLI', async () => {
    const connection = (
      env.db as unknown as {
        $client: Parameters<typeof readPlatformAdministratorSetupConnection>[0];
      }
    ).$client;
    expect(await readPlatformAdministratorSetupConnection(connection)).toEqual({
      pending: false,
      usersExist: false,
      requestHash: null,
    });
    await initialize();
    // The CLI computes the same hash the platform records for these settings.
    expect(await readPlatformAdministratorSetupConnection(connection)).toEqual({
      pending: true,
      usersExist: false,
      requestHash: authenticationSetupRequestHash(JSON.stringify(await input())),
    });
    await env.db
      .update(platformAuthBootstrap)
      .set({ consumed_at: new Date().toISOString() })
      .where(eq(platformAuthBootstrap.singleton, true));
    await createTestUser(env.db, 'first-user');
    expect(await readPlatformAdministratorSetupConnection(connection)).toMatchObject({
      pending: false,
      usersExist: true,
    });
  });

  it('allows an explicit installer-authorized reset only before an administrator exists', async () => {
    await initialize();
    await env.db
      .update(platformAuthBootstrap)
      .set({ expires_at: new Date(0).toISOString() })
      .where(eq(platformAuthBootstrap.singleton, true));
    expect((await form('/auth/bootstrap', { code })).status).toBe(403);
    expect((await app.fetch(new Request(`${origin}/setup`), bindings())).status).toBe(410);
    const oldCode = code;
    code = randomLoginProof();
    expect((await initialize()).status).toBe(409);
    expect((await initialize({ resetPending: true })).status).toBe(200);
    expect((await form('/auth/bootstrap', { code: oldCode })).status).toBe(403);
    expect((await form('/auth/bootstrap', { code })).status).toBe(302);
  });

  it('governs a completed setup replay by current protection, not the stale proposal', async () => {
    const staleProtection = {
      teamDomain: 'https://company.cloudflareaccess.com',
      applications: [
        { origin, audience: 'api-audience' },
        { origin: 'https://proxy.example.com', audience: 'proxy-audience' },
      ],
    };
    expect(
      (
        await initialize(
          { protection: staleProtection },
          { PROXY_URL: 'https://proxy.example.com' },
        )
      ).status,
    ).toBe(403);

    const setup = await input({ protection: staleProtection });
    await initializeAuthentication(
      env.db,
      {
        ...bindings(),
        PROXY_URL: 'https://proxy.example.com',
      } as unknown as Parameters<typeof initializeAuthentication>[1],
      setup,
      origin,
    );
    await env.db
      .update(platformAuthBootstrap)
      .set({ consumed_at: new Date().toISOString() })
      .where(eq(platformAuthBootstrap.singleton, true));
    await env.db
      .update(platformAuthSettings)
      .set({ protection: null })
      .where(eq(platformAuthSettings.singleton, true));

    const replay = await initialize(
      { protection: staleProtection },
      { PROXY_URL: 'https://proxy.example.com' },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ setupPending: false });
  });
});
