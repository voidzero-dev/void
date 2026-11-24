import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { verifyJwt } from '../../src/auth/jwt.ts';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv, clearTables, createTestUser } from './helpers.ts';
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
});

/**
 * Extract the JS-redirect target URL from the HTML body returned by `/auth/dev-login`.
 * The endpoint returns a 200 HTML page with `location.replace("<target>")` because
 * `wrangler dev` mangles `Location: http://localhost:*` headers (see route comment).
 */
function extractRedirectTarget(body: string): string {
  const match = /location\.replace\("([^"]+)"\)/.exec(body);
  if (!match) {
    throw new Error(`no location.replace() in body: ${body.slice(0, 200)}`);
  }
  return match[1]!;
}

describe('GET /auth/dev-login', () => {
  it('returns 200 HTML that JS-navigates with a token query param when DEV_AUTH_BYPASS is enabled', async () => {
    const user = await createTestUser(env.db, 'devuser');

    const res = await app.fetch(
      new Request('http://localhost/auth/dev-login?redirect=http://localhost:5173/auth/callback'),
      { ...env, DEV_AUTH_BYPASS: 'true' },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    const target = extractRedirectTarget(body);
    const url = new URL(target);
    expect(url.origin).toBe('http://localhost:5173');
    expect(url.pathname).toBe('/auth/callback');

    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();

    const payload = await verifyJwt(token!, env.JWT_SECRET, 'api');
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(user.id);
  });

  it('returns 404 when DEV_AUTH_BYPASS is not set', async () => {
    await createTestUser(env.db, 'devuser');

    const res = await app.fetch(
      new Request('http://localhost/auth/dev-login?redirect=http://localhost:5173/auth/callback'),
      { ...env },
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('not found');
  });

  it('returns 404 when DEV_AUTH_BYPASS is set but PLATFORM_ENV is production', async () => {
    await createTestUser(env.db, 'devuser');

    const res = await app.fetch(
      new Request('http://localhost/auth/dev-login?redirect=http://localhost:5173/auth/callback'),
      { ...env, DEV_AUTH_BYPASS: 'true', PLATFORM_ENV: 'production' },
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('not found');
  });

  it('returns 404 when DEV_AUTH_BYPASS is set to a non-"true" string', async () => {
    await createTestUser(env.db, 'devuser');

    for (const value of ['false', '0', 'no', '1', 'TRUE']) {
      const res = await app.fetch(
        new Request('http://localhost/auth/dev-login?redirect=http://localhost:5173/auth/callback'),
        { ...env, DEV_AUTH_BYPASS: value },
      );
      expect(res.status, `DEV_AUTH_BYPASS=${value}`).toBe(404);
      expect(res.headers.get('content-type'), `DEV_AUTH_BYPASS=${value}`).toContain(
        'application/json',
      );
    }
  });

  it('returns 400 when redirect param is missing', async () => {
    const res = await app.fetch(new Request('http://localhost/auth/dev-login'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('redirect parameter is required');
  });

  it('returns 400 when redirect is not localhost', async () => {
    for (const redirect of [
      'https://evil.example.com/',
      'https://dash.void.cloud/auth/callback',
      'https://dash.staging.void.cloud/auth/callback',
    ]) {
      const res = await app.fetch(
        new Request(`http://localhost/auth/dev-login?redirect=${encodeURIComponent(redirect)}`),
        { ...env, DEV_AUTH_BYPASS: 'true', DASHBOARD_URL: 'https://dash.staging.void.cloud' },
      );
      expect(res.status, redirect).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error, redirect).toBe('redirect must be a localhost URL');
    }
  });

  it('returns 400 when redirect is not a parseable URL', async () => {
    const res = await app.fetch(new Request('http://localhost/auth/dev-login?redirect=not-a-url'), {
      ...env,
      DEV_AUTH_BYPASS: 'true',
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('redirect must be a localhost URL');
  });

  it('returns 404 when no seeded user exists', async () => {
    const res = await app.fetch(
      new Request('http://localhost/auth/dev-login?redirect=http://localhost:5173/auth/callback'),
      { ...env, DEV_AUTH_BYPASS: 'true' },
    );

    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('no seeded user — run pnpm -C packages/api setup');
  });

  it('preserves existing query params on the redirect', async () => {
    await createTestUser(env.db, 'devuser');

    const res = await app.fetch(
      new Request(
        'http://localhost/auth/dev-login?redirect=http%3A%2F%2Flocalhost%3A5173%2Fauth%2Fcallback%3Flogin_nonce%3Dabc123',
      ),
      { ...env, DEV_AUTH_BYPASS: 'true' },
    );

    expect(res.status).toBe(200);

    const target = extractRedirectTarget(await res.text());
    const url = new URL(target);
    expect(url.searchParams.get('login_nonce')).toBe('abc123');
    expect(url.searchParams.get('token')).toBeTruthy();
  });
});

describe('GET /auth/login redirect isolation', () => {
  it('rejects the hosted dashboard for self-hosted APIs without a configured dashboard', async () => {
    const redirect = encodeURIComponent('https://dash.void.cloud/auth/callback');
    const res = await app.fetch(new Request(`http://localhost/auth/login?redirect=${redirect}`), {
      ...env,
      PLATFORM_INSTALLATION_ID: 'example-a1b2c3d4',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'redirect must be a localhost or dashboard URL',
    });
  });

  it('preserves the hosted dashboard default for Void Cloud', async () => {
    const redirect = encodeURIComponent('https://dash.void.cloud/auth/callback');
    const res = await app.fetch(
      new Request(`http://localhost/auth/login?redirect=${redirect}&provider=github`),
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('https://github.com/login/oauth/authorize');
  });
});
