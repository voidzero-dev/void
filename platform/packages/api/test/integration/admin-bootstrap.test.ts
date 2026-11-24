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
import { verifyJwt } from '../../src/auth/jwt.ts';
import { app } from '../../src/index.ts';
import { oauthAccounts, projects, users } from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let github: { id: number; login: string; email: string | null; verified: boolean };

beforeAll(async () => {
  env = await setupEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  env.PLATFORM_INSTALLATION_ID = 'self-hosted-installation';
  env.PLATFORM_BOOTSTRAP_GITHUB_ID = '4242';
  github = { id: 4242, login: 'owner', email: 'owner@example.com', verified: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'synthetic-github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json(github);
      }
      if (url === 'https://api.github.com/user/emails') {
        return Response.json(
          github.email ? [{ email: github.email, primary: true, verified: github.verified }] : [],
        );
      }
      if (
        url === 'https://api.cloudflare.com/client/v4/accounts/test-account-id/analytics_engine/sql'
      ) {
        return Response.json({ data: [] });
      }
      throw new Error(`Unexpected test request: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await teardownEnv();
});

async function startLogin(): Promise<Request> {
  const start = await app.fetch(new Request('https://platform.example/admin/login/github'), env);
  expect(start.status).toBe(302);
  const authorization = new URL(start.headers.get('Location')!);
  const state = authorization.searchParams.get('state')!;
  const cookie = start.headers.get('Set-Cookie')!.split(';', 1)[0]!;
  return new Request(
    `https://platform.example/auth/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    {
      headers: { Cookie: cookie },
      redirect: 'manual',
    },
  );
}

async function login(): Promise<Response> {
  return app.fetch(await startLogin(), env);
}

describe('first administrator dashboard login', () => {
  it('creates the configured owner and OAuth identity without a CLI login or app', async () => {
    const response = await login();
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/');
    const [owner] = await env.db.select().from(users);
    expect(owner).toMatchObject({
      provider: 'github',
      provider_id: '4242',
      login: 'owner',
      email: 'owner@example.com',
      role: 'admin',
      plan: 'custom',
    });
    expect(await env.db.select().from(oauthAccounts)).toEqual([
      expect.objectContaining({ user_id: owner!.id, provider: 'github', provider_id: '4242' }),
    ]);
    expect(await env.db.select().from(projects)).toHaveLength(0);
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('admin_token='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const token = cookie.split(';', 1)[0]!.slice('admin_token='.length);
    expect(await verifyJwt(token, env.JWT_SECRET, 'admin')).toMatchObject({
      sub: owner!.id,
      aud: 'admin',
    });
    expect(await verifyJwt(token, env.JWT_SECRET, 'api')).toBeNull();
    const dashboard = await app.fetch(
      new Request('https://platform.example/admin/', {
        headers: { Cookie: cookie.split(';', 1)[0]! },
      }),
      env,
    );
    expect(dashboard.status).toBe(200);
  });

  it.each([null, 'unverified@example.com'])(
    'does not require or trust an unverified email (%s)',
    async (email) => {
      github.email = email;
      github.verified = false;
      github.login = 'renamed-owner';
      expect((await login()).status).toBe(302);
      expect(await env.db.select().from(users)).toEqual([
        expect.objectContaining({
          provider_id: '4242',
          login: 'renamed-owner',
          email: null,
          role: 'admin',
        }),
      ]);
    },
  );

  it.each(['wrong-identity', 'missing-owner', 'hosted-cloud'])(
    'rejects an unconfigured first administrator (%s)',
    async (scenario) => {
      if (scenario === 'wrong-identity') {
        github.id = 9999;
      }
      if (scenario === 'missing-owner') {
        env.PLATFORM_BOOTSTRAP_GITHUB_ID = undefined;
      }
      if (scenario === 'hosted-cloud') {
        env.PLATFORM_INSTALLATION_ID = undefined;
      }
      // Even public signup must not allow an arbitrary visitor to claim the admin UI.
      await env.ROUTING.put('signup:enabled', 'false');
      const response = await login();
      expect(response.status).toBe(403);
      expect(response.headers.get('Set-Cookie')).not.toContain('admin_token=');
      const html = await response.text();
      expect(html).toContain('Sign in with an administrator account for this platform.');
      expect(html).toContain('href="/admin/logout"');
      expect(await env.db.select().from(users)).toHaveLength(0);
      expect(await env.db.select().from(oauthAccounts)).toHaveLength(0);
    },
  );

  it.each(['another-user', 'owner'])(
    'does not grant admin when a regular %s already exists',
    async (existing) => {
      await createTestUser(env.db, existing, 'github', existing === 'owner' ? '4242' : '9999');
      const response = await login();
      expect(response.status).toBe(403);
      expect(response.headers.get('Set-Cookie')).not.toContain('admin_token=');
      expect(await env.db.select().from(users)).toEqual([
        expect.objectContaining({ role: 'user' }),
      ]);
      expect(await env.db.select().from(oauthAccounts)).toHaveLength(1);
    },
  );

  it('does not replace a linked administrator identity on a matching email', async () => {
    const owner = await createTestUser(env.db, 'owner', 'github', '5000', 'custom', 'admin');
    await env.db.update(users).set({ email: 'owner@example.com' }).where(eq(users.id, owner.id));
    github = { id: 9999, login: 'other', email: 'owner@example.com', verified: true };

    const response = await login();

    expect(response.status).toBe(403);
    expect(response.headers.get('Set-Cookie')).not.toContain('admin_token=');
    const [row] = await env.db.select().from(users).where(eq(users.id, owner.id));
    expect(row?.provider_id).toBe('5000');
    expect(
      await env.db.select().from(oauthAccounts).where(eq(oauthAccounts.provider_id, '9999')),
    ).toHaveLength(0);
  });

  it('links the first login of an administrator seeded by email', async () => {
    const seeded = await createTestUser(env.db, 'owner', 'github', 'seeded', 'custom', 'admin');
    await env.db.delete(oauthAccounts).where(eq(oauthAccounts.user_id, seeded.id));
    await env.db.update(users).set({ email: 'owner@example.com' }).where(eq(users.id, seeded.id));
    github = { id: 9998, login: 'owner', email: 'owner@example.com', verified: true };

    const response = await login();

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/');
    expect(response.headers.get('Set-Cookie')).toContain('admin_token=');
    const [row] = await env.db.select().from(users).where(eq(users.id, seeded.id));
    expect(row?.provider_id).toBe('9998');
    expect(await env.db.select().from(oauthAccounts)).toEqual([
      expect.objectContaining({ user_id: seeded.id, provider: 'github', provider_id: '9998' }),
    ]);
  });

  it('allows repeated and concurrent owner logins without duplicate users', async () => {
    const requests = [await startLogin(), await startLogin()];
    const responses = await Promise.all(requests.map((request) => app.fetch(request, env)));
    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    expect((await login()).status).toBe(302);
    expect(await env.db.select().from(users)).toEqual([expect.objectContaining({ role: 'admin' })]);
    expect(await env.db.select().from(oauthAccounts)).toHaveLength(1);
  });

  it('gives suspended administrators accurate recovery guidance without signing them in', async () => {
    const admin = await createTestUser(
      env.db,
      'suspended-owner',
      'github',
      '4242',
      'free',
      'admin',
    );
    await env.db
      .update(users)
      .set({ suspended_reason: 'private review details' })
      .where(eq(users.id, admin.id));
    const response = await login();
    expect(response.status).toBe(403);
    expect(response.headers.get('Set-Cookie')).not.toContain('admin_token=');
    const html = await response.text();
    expect(html).toContain('Administrator access suspended');
    expect(html).toContain('Contact another platform administrator to restore access.');
    expect(html).toContain('href="/admin/logout"');
    expect(html).not.toContain('private review details');
  });

  it('requires the initiating browser cookie before creating the owner', async () => {
    const request = await startLogin();
    request.headers.delete('Cookie');
    const response = await app.fetch(request, env);
    expect(response.status).toBe(400);
    expect(await env.db.select().from(users)).toHaveLength(0);
  });

  it('rejects a replayed OAuth callback without creating another account', async () => {
    const request = await startLogin();
    expect((await app.fetch(request, env)).status).toBe(302);
    expect((await app.fetch(request, env)).status).toBe(400);
    expect(await env.db.select().from(users)).toHaveLength(1);
    expect(await env.db.select().from(oauthAccounts)).toHaveLength(1);
  });
});
