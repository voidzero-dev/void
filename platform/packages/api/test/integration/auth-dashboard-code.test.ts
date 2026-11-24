import { createHash } from 'node:crypto';
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
import { hmacSignState } from '../../src/auth/hmac.ts';
import app from '../../src/index.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createMockExecutionContext,
  seedOAuthNonce,
  JWT_SECRET,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
const executionCtx = createMockExecutionContext();

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  env.DASHBOARD_URL = 'https://dash.staging.void.cloud';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function codeChallengeFor(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function buildSignedState(
  redirect: string,
  options?: {
    cliState?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  },
): Promise<string> {
  const stateData = JSON.stringify({
    redirect,
    nonce: 'oauth-test-nonce',
    provider: 'github',
    ...options,
  });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, JWT_SECRET);
  return `${stateEncoded}.${signature}`;
}

function mockGitHubApi() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'test-gh-token' });
    }

    if (url === 'https://api.github.com/user') {
      return Response.json({ id: 12_345, login: 'dashboard-user', email: null });
    }

    if (url === 'https://api.github.com/user/emails') {
      return Response.json([
        { email: 'dashboard-user@example.com', primary: true, verified: true },
      ]);
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe('dashboard auth code exchange', () => {
  it('preserves CLI PKCE fields through the OAuth provider state', async () => {
    const redirect = 'http://localhost:9999/callback?state=cli-state';
    const loginRes = await app.fetch(
      new Request(
        `http://localhost/auth/login?redirect=${encodeURIComponent(
          redirect,
        )}&provider=github&code_challenge=cli-challenge&code_challenge_method=S256`,
      ),
      env,
      executionCtx,
    );

    expect(loginRes.status).toBe(302);
    const location = new URL(loginRes.headers.get('Location')!);
    expect(location.origin).toBe('https://github.com');

    const providerState = location.searchParams.get('state');
    expect(providerState).toBeTruthy();

    const stateEncoded = providerState!.slice(0, providerState!.lastIndexOf('.'));
    const stateData = JSON.parse(atob(stateEncoded)) as {
      redirect: string;
      cliState: string;
      codeChallenge: string;
      codeChallengeMethod: string;
    };

    expect(stateData).toMatchObject({
      redirect,
      cliState: 'cli-state',
      codeChallenge: 'cli-challenge',
      codeChallengeMethod: 'S256',
    });
  });

  it('redirects dashboards with a single-use auth code and preserves login_nonce', async () => {
    const redirect = 'https://dash.staging.void.cloud/auth/callback?login_nonce=dashboard-nonce';
    const state = await buildSignedState(redirect);
    await seedOAuthNonce(env.db, 'oauth-test-nonce');
    vi.stubGlobal('fetch', mockGitHubApi());

    const callbackRes = await app.fetch(
      new Request(`http://localhost/auth/callback?code=provider-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=oauth-test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(callbackRes.status).toBe(302);
    const location = new URL(callbackRes.headers.get('Location')!);
    expect(location.origin).toBe('https://dash.staging.void.cloud');
    expect(location.pathname).toBe('/auth/callback');
    expect(location.searchParams.get('login_nonce')).toBe('dashboard-nonce');
    expect(location.searchParams.has('token')).toBe(false);

    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const exchangeRes = await app.fetch(
      new Request('http://localhost/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
      executionCtx,
    );

    expect(exchangeRes.status).toBe(200);
    await expect(exchangeRes.json()).resolves.toMatchObject({ token: expect.any(String) });

    const replayRes = await app.fetch(
      new Request('http://localhost/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      env,
      executionCtx,
    );
    expect(replayRes.status).toBe(400);
  });

  it('redirects CLI logins with a single-use PKCE auth code', async () => {
    const codeVerifier = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const cliState = 'cli-state';
    const codeChallenge = codeChallengeFor(codeVerifier);
    const redirect = `http://localhost:9999/callback?state=${cliState}`;
    const state = await buildSignedState(redirect, {
      cliState,
      codeChallenge,
      codeChallengeMethod: 'S256',
    });
    await seedOAuthNonce(env.db, 'oauth-test-nonce');
    vi.stubGlobal('fetch', mockGitHubApi());

    const callbackRes = await app.fetch(
      new Request(`http://localhost/auth/callback?code=provider-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=oauth-test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(callbackRes.status).toBe(302);
    const location = new URL(callbackRes.headers.get('Location')!);
    expect(location.origin).toBe('http://localhost:9999');
    expect(location.pathname).toBe('/callback');
    expect(location.searchParams.get('state')).toBe(cliState);
    expect(location.searchParams.has('token')).toBe(false);

    const cliCode = location.searchParams.get('code');
    expect(cliCode).toBeTruthy();

    const dashboardExchangeRes = await app.fetch(
      new Request('http://localhost/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cliCode }),
      }),
      env,
      executionCtx,
    );
    expect(dashboardExchangeRes.status).toBe(400);

    const wrongStateRes = await app.fetch(
      new Request('http://localhost/auth/cli/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cliCode,
          state: 'wrong-state',
          code_verifier: codeVerifier,
        }),
      }),
      env,
      executionCtx,
    );
    expect(wrongStateRes.status).toBe(400);

    const wrongVerifierRes = await app.fetch(
      new Request('http://localhost/auth/cli/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cliCode,
          state: cliState,
          code_verifier: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGx',
        }),
      }),
      env,
      executionCtx,
    );
    expect(wrongVerifierRes.status).toBe(400);

    const exchangeRes = await app.fetch(
      new Request('http://localhost/auth/cli/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cliCode,
          state: cliState,
          code_verifier: codeVerifier,
        }),
      }),
      env,
      executionCtx,
    );

    expect(exchangeRes.status).toBe(200);
    await expect(exchangeRes.json()).resolves.toMatchObject({ token: expect.any(String) });

    const replayRes = await app.fetch(
      new Request('http://localhost/auth/cli/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cliCode,
          state: cliState,
          code_verifier: codeVerifier,
        }),
      }),
      env,
      executionCtx,
    );
    expect(replayRes.status).toBe(400);
  });
});

describe('browser callback error presentation', () => {
  it('keeps JSON errors for API callers and renders browser navigation with the same status', async () => {
    const url = 'https://api.staging.void.cloud/auth/callback';
    const api = await app.fetch(
      new Request(url, { headers: { Accept: 'application/json' } }),
      env,
      executionCtx,
    );
    const body = await api.json();
    const browser = await app.fetch(
      new Request(url, { headers: { Accept: 'text/html,application/xhtml+xml' } }),
      env,
      executionCtx,
    );
    expect(api.status).toBe(400);
    expect(body).toHaveProperty('error');
    expect(browser.status).toBe(api.status);
    expect(browser.headers.get('Content-Type')).toContain('text/html');
    expect(browser.headers.get('Cache-Control')).toBe('no-store');
    expect(browser.headers.get('Referrer-Policy')).toBe('no-referrer');
    const html = await browser.text();
    expect(html).toContain('Login failed');
    expect(html).toContain('href="https://dash.staging.void.cloud/login"');
  });
  it('does not send HTML to a caller that refuses it', async () => {
    const response = await app.fetch(
      new Request('https://api.staging.void.cloud/auth/callback', {
        headers: { Accept: 'text/html;q=0,application/json' },
      }),
      env,
      executionCtx,
    );
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });
});
