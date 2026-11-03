import { eq } from 'drizzle-orm';
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
  importLegacyAuthentication,
  stageLoginConfiguration,
} from '../../src/auth/configuration.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import { createHumanSession } from '../../src/auth/sessions.ts';
import { app } from '../../src/index.ts';
import {
  githubInstallations,
  invitations,
  platformAuthAttempts,
  platformAuthSettings,
  platformHumanSessions,
  platformLoginConnections,
  platformLoginIdentities,
  operatorEvents,
  users,
} from '../../src/schema.ts';
import { putAllowlist } from '../../src/signup-allowlist.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
let authorization: URL;
let callbackCount: number;
let operatorToken: string;
let browserAdminCookie: string;
let oidcEmail: string | undefined;
let oidcEmailVerified: boolean | undefined;
let oidcGroups: Array<string> | undefined;
const origin = 'https://api.example.com';
const issuer = 'https://identity.login-example.com';
const verifier = 'a'.repeat(64);
beforeAll(async () => {
  env = await setupEnv();
  const keys = await generateKeyPair('ES256', { extractable: true });
  privateKey = keys.privateKey;
  jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'login-key', use: 'sig' };
});
afterAll(teardownEnv);
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await clearTables(env.db);
  await env.ROUTING.delete('signup:allowlist');
  await env.ROUTING.delete('signup:enabled');
  const admin = await createTestUser(
    env.db,
    'operator',
    'github',
    'operator-subject',
    'custom',
    'admin',
  );
  await importLegacyAuthentication(env.db, env);
  const human = await createHumanSession(env.db, env.JWT_SECRET, {
    userId: admin.id,
    connectionId: 'github',
    revision: 1,
    generation: 1,
    audience: 'api',
  });
  const elevation = await app.fetch(
    new Request(`${origin}/operator/v1/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${human.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
  );
  operatorToken = (await elevation.json<{ token: string }>()).token;
  const browserAdmin = await createHumanSession(env.db, env.JWT_SECRET, {
    userId: admin.id,
    connectionId: 'github',
    revision: 1,
    generation: 1,
    audience: 'admin',
  });
  browserAdminCookie = `admin_token=${browserAdmin.token}`;
  await stageLoginConfiguration(
    env.db,
    env,
    { id: 'company', kind: 'oidc', label: 'Company SSO', clientId: 'client', issuer },
    'client-secret',
    null,
  );
  await env.db
    .update(platformLoginConnections)
    .set({ enabled: true, active_revision: 1 })
    .where(eq(platformLoginConnections.id, 'company'));
  callbackCount = 0;
  oidcEmail = 'employee@example.com';
  oidcEmailVerified = true;
  oidcGroups = undefined;
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
        callbackCount++;
        const body = options?.body as URLSearchParams;
        expect(await createCodeChallenge(body.get('code_verifier')!)).toBe(
          authorization.searchParams.get('code_challenge'),
        );
        expect(body.get('redirect_uri')).toBe(`${origin}/auth/callback`);
        const idToken = await new SignJWT({
          nonce: authorization.searchParams.get('nonce'),
          ...(oidcEmail === undefined ? {} : { email: oidcEmail }),
          ...(oidcEmailVerified === undefined ? {} : { email_verified: oidcEmailVerified }),
          ...(oidcGroups === undefined ? {} : { groups: oidcGroups }),
        })
          .setIssuer(issuer)
          .setAudience('client')
          .setSubject('employee')
          .setIssuedAt()
          .setExpirationTime('5m')
          .setProtectedHeader({ alg: 'ES256', kid: 'login-key' })
          .sign(privateKey);
        return Response.json({
          token_type: 'Bearer',
          access_token: 'upstream-token',
          id_token: idToken,
        });
      }
      if (url === `${issuer}/keys`) {
        return Response.json({ keys: [jwk] });
      }
      throw new Error('Unexpected outbound request');
    }),
  );
});

async function start(provider = 'company') {
  const url = new URL('/auth/login', origin);
  url.searchParams.set('provider', provider);
  url.searchParams.set('redirect', 'http://localhost:3456/callback?state=cli-state');
  url.searchParams.set('code_challenge', await createCodeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  const response = await app.fetch(new Request(url), env);
  expect(response.status).toBe(302);
  authorization = new URL(response.headers.get('Location')!);
  return {
    state: authorization.searchParams.get('state')!,
    cookie: response.headers.get('Set-Cookie')!.split(';')[0]!,
  };
}
function callback(flow: { state: string; cookie: string }) {
  return app.fetch(
    new Request(`${origin}/auth/callback?code=provider-code&state=${flow.state}`, {
      headers: { Cookie: flow.cookie },
    }),
    env,
  );
}

function operator(path: string, body?: unknown) {
  return app.fetch(
    new Request(`${origin}/operator/v1/config/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

function mockGitHubLogin(input: {
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: string | URL | Request) => {
      const url = request.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-access-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({ id: input.id, login: input.login, email: input.email });
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json(
          input.email ? [{ email: input.email, primary: true, verified: input.emailVerified }] : [],
        );
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }),
  );
}

describe('configured platform login routes', () => {
  async function ordinarySession() {
    const user = await createTestUser(env.db, 'ordinary', 'github', 'ordinary-id');
    await env.db.insert(platformLoginIdentities).values({
      id: crypto.randomUUID(),
      user_id: user.id,
      connection_id: 'github',
      issuer: 'https://github.com',
      subject: 'ordinary-id',
    });
    const human = await createHumanSession(env.db, env.JWT_SECRET, {
      userId: user.id,
      connectionId: 'github',
      revision: 1,
      generation: 1,
      audience: 'api',
    });
    return { user, ...human };
  }
  async function launchLink(token: string, connectionId = 'company') {
    return app.fetch(
      new Request(origin + '/auth/link', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      }),
      env,
    );
  }
  it(
    'confirms a real native linking form while withholding OAuth callback details',
    async () => {
      const human = await ordinarySession();
      const browser = await chromium.launch();
      const submissions: Array<{
        origin: string | undefined;
        referrer: string | undefined;
        status: number;
      }> = [];
      let suppressOrigin = true;
      try {
        const context = await browser.newContext();
        await context.addCookies([
          {
            name: 'void_account_session',
            value: human.token,
            url: origin,
            secure: true,
            httpOnly: true,
          },
        ]);
        const page = await context.newPage();
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
            env,
          );
          if (request.method() === 'POST') {
            submissions.push({
              origin: headers.origin,
              referrer: headers.referer,
              status: response.status,
            });
          }
          const responseHeaders = Object.fromEntries(response.headers);
          if (response.status === 302) {
            authorization = new URL(response.headers.get('Location')!);
            delete responseHeaders.location;
            await route.fulfill({
              status: 200,
              headers: responseHeaders,
              body: '<h1>Local provider handoff</h1>',
            });
            return;
          }
          if (url.pathname === '/auth/callback') {
            expect(response.headers.get('Referrer-Policy')).toBe('strict-origin');
            if (suppressOrigin) {
              responseHeaders['referrer-policy'] = 'no-referrer';
            }
          }
          await route.fulfill({
            status: response.status,
            headers: responseHeaders,
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        async function confirmInBrowser() {
          const launch = await launchLink(human.token);
          expect(launch.status).toBe(200);
          await page.goto((await launch.json<{ url: string }>()).url);
          await page.goto(authorization.href);
          await page.goto(
            `${origin}/auth/callback?code=provider-code&state=${authorization.searchParams.get('state')}`,
          );
          await page.getByRole('heading', { name: 'Link this login method?' }).waitFor();
          await Promise.all([
            page.waitForURL(`${origin}/auth/link/confirm`),
            page.getByRole('button', { name: 'Link this identity' }).click(),
          ]);
        }
        await confirmInBrowser();
        expect(submissions).toEqual([{ origin: 'null', referrer: undefined, status: 400 }]);
        expect(
          await env.db
            .select()
            .from(platformLoginIdentities)
            .where(eq(platformLoginIdentities.connection_id, 'company')),
        ).toHaveLength(0);
        suppressOrigin = false;
        await confirmInBrowser();
        expect(submissions.at(-1)).toEqual({ origin, referrer: `${origin}/`, status: 200 });
        expect(
          await env.db
            .select()
            .from(platformLoginIdentities)
            .where(eq(platformLoginIdentities.connection_id, 'company')),
        ).toMatchObject([{ user_id: human.user.id, subject: 'employee' }]);
      } finally {
        await browser.close();
      }
    },
    // Launching Chromium alone can take longer than the default under a full parallel run.
    30_000,
  );
  it('links an ordinary account only after recent login, provider proof, and explicit browser confirmation', async () => {
    const human = await ordinarySession();
    const launch = await launchLink(human.token);
    expect(launch.status).toBe(200);
    const launchUrl = (await launch.json<{ url: string }>()).url;
    expect((await app.fetch(new Request(launchUrl), env)).status).toBe(401);
    const retry = await launchLink(human.token);
    const start = await app.fetch(
      new Request((await retry.json<{ url: string }>()).url, {
        headers: { Cookie: 'void_account_session=' + human.token },
      }),
      env,
    );
    authorization = new URL(start.headers.get('Location')!);
    const response = await callback({
      state: authorization.searchParams.get('state')!,
      cookie: start.headers.get('Set-Cookie')!.split(';')[0]!,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('employee@example.com');
    expect(
      await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company')),
    ).toHaveLength(0);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('void_link_confirm='))!
      .split(';')[0]!;
    const confirm = (originHeader: string) =>
      app.fetch(
        new Request(origin + '/auth/link/confirm', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: originHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'confirm=yes',
        }),
        env,
      );
    expect((await confirm('https://evil.example')).status).toBe(400);
    expect((await confirm(origin)).status).toBe(200);
    expect(
      await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company')),
    ).toMatchObject([{ user_id: human.user.id, subject: 'employee' }]);
    expect((await confirm(origin)).status).toBe(400);
  });
  it('rejects old or revoked sessions and never tests a disabled method for an ordinary user', async () => {
    const human = await ordinarySession();
    await env.db
      .update(platformHumanSessions)
      .set({ created_at: new Date(Date.now() - 660_000).toISOString() })
      .where(eq(platformHumanSessions.id, human.session.id));
    expect((await launchLink(human.token)).status).toBe(401);
    await env.db
      .update(platformHumanSessions)
      .set({ created_at: new Date().toISOString() })
      .where(eq(platformHumanSessions.id, human.session.id));
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'company'));
    expect((await launchLink(human.token)).status).toBe(404);
    await env.db
      .update(platformHumanSessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(platformHumanSessions.id, human.session.id));
    expect((await launchLink(human.token)).status).toBe(401);
  });
  it.each(['revoked', 'expired', 'disabled', 'claimed'] as const)(
    'rejects an ordinary link when authority changes before confirmation: %s',
    async (reason) => {
      const human = await ordinarySession();
      const launch = await launchLink(human.token);
      const start = await app.fetch(
        new Request((await launch.json<{ url: string }>()).url, {
          headers: { Cookie: 'void_account_session=' + human.token },
        }),
        env,
      );
      authorization = new URL(start.headers.get('Location')!);
      const response = await callback({
        state: authorization.searchParams.get('state')!,
        cookie: start.headers.get('Set-Cookie')!.split(';')[0]!,
      });
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith('void_link_confirm='))!
        .split(';')[0]!;
      let otherId: string | undefined;
      if (reason === 'revoked') {
        await env.db
          .update(platformHumanSessions)
          .set({ revoked_at: new Date().toISOString() })
          .where(eq(platformHumanSessions.id, human.session.id));
      }
      if (reason === 'expired') {
        await env.db
          .update(platformHumanSessions)
          .set({ created_at: new Date(Date.now() - 660_000).toISOString() })
          .where(eq(platformHumanSessions.id, human.session.id));
      }
      if (reason === 'disabled') {
        await env.db
          .update(platformLoginConnections)
          .set({ enabled: false })
          .where(eq(platformLoginConnections.id, 'company'));
      }
      if (reason === 'claimed') {
        const other = await createTestUser(env.db, 'other', 'google', 'other-id');
        otherId = other.id;
        await env.db.insert(platformLoginIdentities).values({
          id: crypto.randomUUID(),
          user_id: other.id,
          connection_id: 'company',
          issuer,
          subject: 'employee',
        });
      }
      const confirm = await app.fetch(
        new Request(origin + '/auth/link/confirm', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: origin,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'confirm=yes',
        }),
        env,
      );
      expect(confirm.status).toBe(reason === 'revoked' || reason === 'expired' ? 401 : 409);
      const identities = await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company'));
      expect(identities).toEqual(
        reason === 'claimed' ? [expect.objectContaining({ user_id: otherId })] : [],
      );
    },
  );
  it('returns a browser administrator to review their verified identity without silently linking it', async () => {
    const launch = await app.fetch(
      new Request(`${origin}/admin/config/auth/connections/company/test`, {
        method: 'POST',
        headers: { Cookie: browserAdminCookie, Origin: origin },
      }),
      env,
    );
    expect(launch.status).toBe(302);
    const start = await app.fetch(
      new Request(launch.headers.get('Location')!, { headers: { Cookie: browserAdminCookie } }),
      env,
    );
    authorization = new URL(start.headers.get('Location')!);
    const response = await callback({
      state: authorization.searchParams.get('state')!,
      cookie: `${browserAdminCookie}; ${start.headers.get('Set-Cookie')!.split(';')[0]}`,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('/admin/config/auth?test=');
    const page = await app.fetch(
      new Request(new URL(response.headers.get('Location')!, origin), {
        headers: { Cookie: browserAdminCookie },
      }),
      env,
    );
    expect(await page.text()).toContain('employee@example.com');
    expect(
      await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company')),
    ).toHaveLength(0);
  });
  it('accepts a pending invitation only after a successful managed login with verified email', async () => {
    await env.db.insert(invitations).values({
      id: 'managed-invitation',
      email: 'employee@example.com',
      invited_by: 'installation-administrator',
    });
    expect((await callback(await start())).status).toBe(302);
    expect((await env.db.select().from(invitations))[0]).toMatchObject({
      status: 'accepted',
      accepted_by: expect.any(String),
      accepted_at: expect.any(String),
    });
  });
  it.each([
    { label: 'missing', email: undefined, verified: true },
    { label: 'unverified', email: 'employee@example.com', verified: false },
  ])('does not accept an invitation for $label provider email', async ({ email, verified }) => {
    oidcEmail = email;
    oidcEmailVerified = verified;
    await env.db.update(platformAuthSettings).set({ admission: { mode: 'public' } });
    await env.db.insert(invitations).values({
      id: 'unverified-managed-invitation',
      email: 'employee@example.com',
      invited_by: 'installation-administrator',
    });
    expect((await callback(await start())).status).toBe(302);
    expect((await env.db.select().from(invitations))[0]).toMatchObject({
      status: 'pending',
      accepted_by: null,
      accepted_at: null,
    });
  });
  it('does not accept an invitation through an implicit verified-email account match', async () => {
    const existing = await createTestUser(env.db, 'existing-account', 'google', 'existing-subject');
    await env.db
      .update(users)
      .set({ email: 'employee@example.com' })
      .where(eq(users.id, existing.id));
    await env.db.insert(invitations).values({
      id: 'implicit-merge-invitation',
      email: 'employee@example.com',
      invited_by: 'installation-administrator',
    });
    expect((await callback(await start())).status).toBe(409);
    expect((await env.db.select().from(invitations))[0]).toMatchObject({
      status: 'pending',
      accepted_by: null,
      accepted_at: null,
    });
  });
  it('admits an ordinary OIDC user without email by exact connection and subject', async () => {
    oidcEmail = undefined;
    oidcEmailVerified = undefined;
    await env.db.update(platformAuthSettings).set({ admission: { mode: 'restricted' } });
    await putAllowlist(env.ROUTING, [
      { type: 'identity', connectionId: 'company', subject: 'employee' },
    ]);

    expect((await callback(await start())).status).toBe(302);
    const created = (await env.db.select().from(users)).find((user) => user.login === 'employee');
    expect(created).toMatchObject({ email: null, role: 'user', provider: 'oidc:company' });
  });
  it.each([
    {
      label: 'wrong connection',
      entry: { type: 'identity', connectionId: 'github', subject: 'employee' } as const,
    },
    {
      label: 'subject case change',
      entry: { type: 'identity', connectionId: 'company', subject: 'Employee' } as const,
    },
    {
      label: 'wrong subject',
      entry: { type: 'identity', connectionId: 'company', subject: 'employee-2' } as const,
    },
    {
      label: 'matching verified email only',
      entry: {
        type: 'identity',
        connectionId: 'company',
        subject: 'employee@example.com',
      } as const,
    },
  ])('denies restricted signup for $label', async ({ entry }) => {
    await env.db.update(platformAuthSettings).set({ admission: { mode: 'restricted' } });
    await putAllowlist(env.ROUTING, [entry]);

    expect((await callback(await start())).status).toBe(403);
    expect(await env.db.select().from(users)).toHaveLength(1);
  });
  it('does not let an identity grant bypass the connection group restriction', async () => {
    await stageLoginConfiguration(
      env.db,
      env,
      {
        id: 'company',
        kind: 'oidc',
        label: 'Company SSO',
        clientId: 'client',
        issuer,
        requiredGroups: ['engineering'],
      },
      'client-secret',
      1,
    );
    await env.db
      .update(platformLoginConnections)
      .set({ active_revision: 2 })
      .where(eq(platformLoginConnections.id, 'company'));
    await env.db.update(platformAuthSettings).set({ admission: { mode: 'restricted' } });
    await putAllowlist(env.ROUTING, [
      { type: 'identity', connectionId: 'company', subject: 'employee' },
    ]);
    oidcGroups = ['sales'];

    expect((await callback(await start())).status).toBe(400);
    expect(await env.db.select().from(users)).toHaveLength(1);

    const existing = await createTestUser(
      env.db,
      'existing-subject-user',
      'oidc:company',
      'employee',
    );
    await env.db.insert(platformLoginIdentities).values({
      id: crypto.randomUUID(),
      user_id: existing.id,
      connection_id: 'company',
      issuer,
      subject: 'employee',
    });
    expect((await callback(await start())).status).toBe(400);
  });
  it('backfills a GitHub App installation after successful managed GitHub login', async () => {
    const user = await createTestUser(env.db, 'github-user', 'github', '4242');
    await env.db.insert(platformLoginIdentities).values({
      id: crypto.randomUUID(),
      user_id: user.id,
      connection_id: 'github',
      issuer: 'https://github.com',
      subject: '4242',
    });
    await env.db.insert(githubInstallations).values({
      id: 'managed-login-installation',
      installation_id: '424200',
      user_id: null,
      account_login: 'github-user',
      account_id: '4242',
      account_type: 'User',
    });
    mockGitHubLogin({
      id: 4242,
      login: 'github-user',
      email: 'github-user@example.com',
      emailVerified: true,
    });
    expect((await callback(await start('github'))).status).toBe(302);
    expect((await env.db.select().from(githubInstallations))[0]?.user_id).toBe(user.id);
  });
  it('names the cause of a failed GitHub sign-in without logging provider details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: string | URL | Request) => {
        if (request.toString() === 'https://github.com/login/oauth/access_token') {
          return Response.json({
            error: 'incorrect_client_credentials',
            error_description: 'The client_id and/or client_secret passed are incorrect.',
          });
        }
        throw new Error(`Unexpected GitHub request: ${request.toString()}`);
      }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const flow = await start('github');
    const page = await app.fetch(
      new Request(`${origin}/auth/callback?code=provider-code&state=${flow.state}`, {
        headers: { Cookie: flow.cookie, Accept: 'text/html' },
      }),
      env,
    );
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain('GitHub rejected this platform’s client ID or client secret.');
    expect(html).toContain('Error code: github_incorrect_client_credentials');
    expect(html).toContain(`Callback URL: ${origin}/auth/callback`);
    expect(html).not.toContain('void platform repair');
    expect(errors).toHaveBeenCalledWith('[auth] login failed', {
      code: 'github_incorrect_client_credentials',
      purpose: 'login',
      connectionId: 'github',
    });
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain('test-github-client-secret');
    expect(logged).not.toContain('passed are incorrect');

    const cli = await callback(await start('github'));
    expect(cli.status).toBe(400);
    expect(await cli.json()).toMatchObject({
      error: 'login_failed',
      code: 'github_incorrect_client_credentials',
    });

    const denied = await start('github');
    const cancelled = await app.fetch(
      new Request(`${origin}/auth/callback?error=access_denied&state=${denied.state}`, {
        headers: { Cookie: denied.cookie },
      }),
      env,
    );
    expect(await cancelled.json()).toMatchObject({ code: 'login_denied' });
    errors.mockRestore();
  });
  it('backfills a GitHub App installation after explicit managed identity linking', async () => {
    const user = await createTestUser(env.db, 'oidc-user', 'oidc:company', 'oidc-user-subject');
    await env.db.insert(platformLoginIdentities).values({
      id: crypto.randomUUID(),
      user_id: user.id,
      connection_id: 'company',
      issuer,
      subject: 'oidc-user-subject',
    });
    const human = await createHumanSession(env.db, env.JWT_SECRET, {
      userId: user.id,
      connectionId: 'company',
      revision: 1,
      generation: 1,
      audience: 'api',
    });
    await env.db.insert(githubInstallations).values({
      id: 'managed-link-installation',
      installation_id: '515000',
      user_id: null,
      account_login: 'linked-github-user',
      account_id: '5150',
      account_type: 'User',
    });
    mockGitHubLogin({
      id: 5150,
      login: 'linked-github-user',
      email: 'linked@example.com',
      emailVerified: true,
    });
    const launch = await launchLink(human.token, 'github');
    expect(launch.status).toBe(200);
    const providerStart = await app.fetch(
      new Request((await launch.json<{ url: string }>()).url, {
        headers: { Cookie: `void_account_session=${human.token}` },
      }),
      env,
    );
    authorization = new URL(providerStart.headers.get('Location')!);
    const completed = await callback({
      state: authorization.searchParams.get('state')!,
      cookie: providerStart.headers.get('Set-Cookie')!.split(';')[0]!,
    });
    expect(completed.status).toBe(200);
    const confirmationCookie = completed.headers
      .getSetCookie()
      .find((value) => value.startsWith('void_link_confirm='))!
      .split(';')[0]!;
    const confirmed = await app.fetch(
      new Request(`${origin}/auth/link/confirm`, {
        method: 'POST',
        headers: {
          Cookie: confirmationCookie,
          Origin: origin,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'confirm=yes',
      }),
      env,
    );
    expect(confirmed.status).toBe(200);
    expect((await env.db.select().from(githubInstallations))[0]?.user_id).toBe(user.id);
  });
  it('publishes only enabled named methods without exposing provider configuration or credentials', async () => {
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'google'));
    const response = await app.fetch(new Request(`${origin}/.well-known/void-platform`), env);
    const discovery = await response.json();
    expect(discovery).toMatchObject({
      schemaVersion: 3,
      authenticationProviders: ['company', 'github'],
      authentication: {
        protectedByAccess: false,
        methods: [
          { id: 'company', kind: 'oidc', label: 'Company SSO' },
          { id: 'github', kind: 'github', label: 'GitHub' },
        ],
      },
    });
    expect(JSON.stringify(discovery)).not.toContain(issuer);
    expect(JSON.stringify(discovery)).not.toContain('client-secret');
    expect(JSON.stringify(discovery)).not.toContain('ciphertext');
  });
  it('completes OIDC browser authentication and a separate one-time PKCE CLI exchange', async () => {
    const flow = await start();
    const response = await callback(flow);
    expect(response.status).toBe(302);
    const redirected = new URL(response.headers.get('Location')!);
    expect(redirected.searchParams.has('token')).toBe(false);
    const exchange = () =>
      app.fetch(
        new Request(`${origin}/auth/cli/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: redirected.searchParams.get('code'),
            state: 'cli-state',
            code_verifier: verifier,
          }),
        }),
        env,
      );
    const tokenResponse = await exchange();
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json<{ token: string }>();
    const whoami = await app.fetch(
      new Request(`${origin}/me`, { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );
    expect(whoami.status).toBe(200);
    expect((await exchange()).status).toBe(400);
    expect((await callback(flow)).status).toBe(400);
    expect(callbackCount).toBe(1);
  });

  it('does not consume a legitimate flow when another browser sends its state', async () => {
    const flow = await start();
    expect((await callback({ ...flow, cookie: 'void_platform_auth=another-browser' })).status).toBe(
      400,
    );
    expect(await env.db.select().from(platformAuthAttempts)).toHaveLength(1);
    expect((await callback(flow)).status).toBe(302);
  });

  it('rejects a callback if its connection was disabled while the user authenticated', async () => {
    const flow = await start();
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'company'));
    expect((await callback(flow)).status).toBe(401);
    expect(callbackCount).toBe(0);
  });

  it('rejects redemption after a method is disabled, even if the login callback already completed', async () => {
    const response = await callback(await start());
    const redirected = new URL(response.headers.get('Location')!);
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'company'));
    const exchange = await app.fetch(
      new Request(`${origin}/auth/cli/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: redirected.searchParams.get('code'),
          state: 'cli-state',
          code_verifier: verifier,
        }),
      }),
      env,
    );
    expect(exchange.status).toBe(400);
  });

  it('shows dynamic admin login methods and never falls back to disabled methods', async () => {
    const response = await app.fetch(new Request(`${origin}/admin/login`), env);
    expect((await response.text()).replaceAll('<!-- -->', '')).toContain(
      'Sign in with Company SSO',
    );
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'github'));
    expect((await app.fetch(new Request(`${origin}/admin/login/github`), env)).status).toBe(404);
  });

  it('tests a pending configuration without signing in or merging accounts, then explicitly links and enables it', async () => {
    const configuration = {
      id: 'company',
      kind: 'oidc',
      label: 'Updated company SSO',
      clientId: 'client',
      issuer,
    };
    const preview = await operator('/connections/company/configure', {
      configuration,
      revision: 1,
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(
      (
        await env.db
          .select()
          .from(platformLoginConnections)
          .where(eq(platformLoginConnections.id, 'company'))
      )[0]?.revision,
    ).toBe(1);
    const updated = await operator('/connections/company/configure', {
      configuration,
      revision: 1,
    });
    expect(updated.status).toBe(200);
    const launchResponse = await operator('/connections/company/test', {});
    expect(launchResponse.status).toBe(200);
    const launch = await launchResponse.json<{ id: string; url: string }>();
    const browser = await app.fetch(new Request(launch.url), env);
    expect(browser.status).toBe(302);
    authorization = new URL(browser.headers.get('Location')!);
    const flow = {
      state: authorization.searchParams.get('state')!,
      cookie: browser.headers.get('Set-Cookie')!.split(';')[0]!,
    };
    const completed = await callback(flow);
    expect(completed.status).toBe(200);
    expect(completed.headers.get('Set-Cookie')).not.toContain('admin_token');
    expect(await env.db.select().from(users)).toHaveLength(1);
    expect(
      await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company')),
    ).toHaveLength(0);
    const proof = await (await operator(`/tests/${launch.id}`)).json();
    expect(proof).toMatchObject({ complete: true, revision: 2, subject: 'employee', issuer });
    expect(
      (
        await operator('/connections/company/link', {
          revision: 2,
          testId: launch.id,
          dryRun: true,
        })
      ).status,
    ).toBe(200);
    expect(
      await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company')),
    ).toHaveLength(0);
    expect(
      (await operator('/connections/company/link', { revision: 2, testId: launch.id })).status,
    ).toBe(200);
    expect(
      (await operator('/connections/company/enable', { revision: 2, testId: launch.id })).status,
    ).toBe(200);
    const listing = await (await operator('')).text();
    expect(listing).toContain('Updated company SSO');
    expect(listing).not.toContain('client-secret');
    expect(listing).not.toContain('ciphertext');
    const audits = JSON.stringify(await env.db.select().from(operatorEvents));
    expect(audits).toContain('company');
    expect(audits).not.toContain('client-secret');
    expect(audits).not.toContain(launch.url);
  });

  it('invalidates a launch when the initiating session is revoked and never launches it twice', async () => {
    const launch = await (await operator('/connections/company/test', {})).json<{ url: string }>();
    const first = await app.fetch(new Request(launch.url), env);
    expect(first.status).toBe(302);
    expect((await app.fetch(new Request(launch.url), env)).status).toBe(400);
    const next = await (await operator('/connections/company/test', {})).json<{ url: string }>();
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'github'));
    expect((await app.fetch(new Request(next.url), env)).status).toBe(400);
  });
});
