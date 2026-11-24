import { Hono } from 'hono';
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
import { hmacSignState } from '../../src/auth/hmac.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import type { Db } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { githubRoutes } from '../../src/routes/github.ts';
import { githubInstallationMembers } from '../../src/schema.ts';
import { JWT_SECRET, clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

// Self-contained app mirroring how index.ts mounts githubRoutes: auth is applied
// per-route inside githubRoutes (connect-authorize-url is authed; the public
// connect-authorize-callback is not), so the only outer middleware is the db
// setter.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes);

// The App's user-to-server OAuth credentials. Present only when the App is
// configured for "Request user authorization (OAuth)" — the connect-authorize
// flow is inert (503) without them.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

// The callback URL both routes derive from the request origin. connect-authorize-url
// sends it as redirect_uri on authorize; connect-authorize-callback MUST send the
// byte-identical value on the token exchange.
const CONNECT_CALLBACK_URL = 'http://localhost/github/connect-authorize-callback';

// A valid 43-char RFC 7636 code_verifier.
const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars

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

function authedGet(jwt: string): RequestInit {
  return { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } };
}

// Stub global fetch for the App user-OAuth reads the connect-authorize callback
// performs via `verifyUserRepoAccess`:
//   - POST login/oauth/access_token                        -> user token (unless acceptCode === false)
//   - GET  /user/installations/:id/repositories (paginated) -> the repos the caller can reach
//   - GET  /user                                           -> the caller's numeric github account id
function mockUserConnect(opts: {
  repositories: Array<{ full_name: string; id: number }>;
  accountId: string;
  acceptCode?: boolean;
}): { tokenExchangeBody: { current: Record<string, unknown> | null } } {
  const tokenExchangeBody = { current: null as Record<string, unknown> | null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login/oauth/access_token')) {
        if (typeof init?.body === 'string') {
          tokenExchangeBody.current = JSON.parse(init.body) as Record<string, unknown>;
        }
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      // The repositories read must be matched BEFORE the `/user` id read, since
      // `/user/installations/:id/repositories` also contains the `/user` substring.
      if (url.includes('/repositories')) {
        return Response.json({
          total_count: opts.repositories.length,
          repositories: opts.repositories,
        });
      }
      if (url.endsWith('/user')) {
        return Response.json({ id: Number(opts.accountId) });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { tokenExchangeBody };
}

// Decode the signed `state` out of a github.com/login/oauth/authorize URL.
function decodeStateFromAuthorizeUrl(url: string): Record<string, unknown> {
  const parsed = new URL(url);
  const state = parsed.searchParams.get('state');
  if (!state) {
    throw new Error('authorize url carries no state');
  }
  const encoded = state.slice(0, state.lastIndexOf('.'));
  return JSON.parse(atob(encoded)) as Record<string, unknown>;
}

// Decode a signed HMAC payload (state or grant) back to its JSON object.
function decodeSignedPayload(token: string): Record<string, unknown> {
  const encoded = token.slice(0, token.lastIndexOf('.'));
  return JSON.parse(atob(encoded)) as Record<string, unknown>;
}

// Mint a signed connect `state` exactly the way GET /connect-authorize-url does —
// used to drive the callback directly and to forge expired/altered/wrong-purpose
// states.
async function mintConnectState(payload: {
  redirect: string;
  purpose?: string;
  installationId?: string;
  repoFullName?: string;
  codeChallenge: string;
  exp: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      redirect: payload.redirect,
      purpose: payload.purpose ?? 'connect',
      installationId: payload.installationId ?? '700',
      repoFullName: payload.repoFullName ?? 'acct/app',
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: 'S256',
      exp: payload.exp,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Extract the JS-redirect target URL from the 200 HTML body the callback returns.
// The callback uses 200 + `location.replace("<target>")` (not a 302) because
// `wrangler dev` mangles `Location: http://localhost:*` headers.
function extractRedirectTarget(body: string): string | null {
  const match = /location\.replace\("([^"]+)"\)/.exec(body);
  return match ? match[1]! : null;
}

// Drive the callback for a freshly-minted valid state + a stubbed exchange, and
// return the `connect_grant` it redirected to localhost with.
async function runConnectCallback(opts: {
  redirect: string;
  codeChallenge: string;
  installationId: string;
  repoFullName: string;
  repositories: Array<{ full_name: string; id: number }>;
  accountId: string;
  acceptCode?: boolean;
}): Promise<{ res: Response; body: string; grant: string | null; target: string | null }> {
  mockUserConnect({
    repositories: opts.repositories,
    accountId: opts.accountId,
    acceptCode: opts.acceptCode,
  });
  const state = await mintConnectState({
    redirect: opts.redirect,
    installationId: opts.installationId,
    repoFullName: opts.repoFullName,
    codeChallenge: opts.codeChallenge,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const res = await app.fetch(
    new Request(
      `http://localhost/github/connect-authorize-callback?code=valid-code&state=${encodeURIComponent(state)}`,
    ),
    { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
  );
  const body = await res.text();
  const target = extractRedirectTarget(body);
  const grant = target ? new URL(target).searchParams.get('connect_grant') : null;
  return { res, body, grant, target };
}

async function countAllMemberRows(db: Db): Promise<number> {
  const rows = await db
    .select({ id: githubInstallationMembers.id })
    .from(githubInstallationMembers);
  return rows.length;
}

describe('GET /github/connect-authorize-url', () => {
  it('returns a signed connect url with purpose:connect, the named repo, future exp, and no userId', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&installationId=700&repoFullName=${encodeURIComponent('acct/app')}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain(`client_id=${GITHUB_APP_USER_OAUTH_ENV.GITHUB_APP_CLIENT_ID}`);

    // The authorize redirect_uri MUST be the same callback URL the exchange uses.
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(CONNECT_CALLBACK_URL);

    const state = decodeStateFromAuthorizeUrl(url);
    expect(state.purpose).toBe('connect');
    expect(state.installationId).toBe('700');
    expect(state.repoFullName).toBe('acct/app');
    expect(state.codeChallenge).toBe(challenge);
    expect(state.codeChallengeMethod).toBe('S256');
    expect(state.redirect).toBe(redirect);
    expect(typeof state.exp).toBe('number');
    expect((state.exp as number) > Date.now()).toBe(true);
    // The crux: state carries NO Void user id (the bind is deferred to redemption).
    expect('userId' in state).toBe(false);
  });

  it('rejects a non-localhost redirect', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'https://evil.example.com/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&installationId=700&repoFullName=${encodeURIComponent('acct/app')}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects a missing installationId', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&repoFullName=${encodeURIComponent('acct/app')}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('installationId is required');
  });

  it('rejects a missing repoFullName', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&installationId=700&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('repoFullName is required');
  });

  it('rejects a missing code_challenge', async () => {
    const user = await createTestUser(env.db);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&installationId=700&repoFullName=${encodeURIComponent('acct/app')}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('code_challenge is required');
  });

  it('rejects a non-S256 code_challenge_method', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&installationId=700&repoFullName=${encodeURIComponent('acct/app')}&code_challenge=${challenge}&code_challenge_method=plain`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('fails closed (503, github_oauth_not_configured) when App user OAuth is unset', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    // No GITHUB_APP_CLIENT_ID/SECRET on env.
    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-url?redirect=${encodeURIComponent(redirect)}&installationId=700&repoFullName=${encodeURIComponent('acct/app')}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      env,
    );

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('github_oauth_not_configured');
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request(
        'http://localhost/github/connect-authorize-url?redirect=http://localhost:1/cb&installationId=700&repoFullName=acct/app&code_challenge=x',
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /github/connect-authorize-callback', () => {
  it('mints a connect_grant when the caller can reach the repo, and binds NOTHING', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);

    const { res, body, grant, target } = await runConnectCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationId: '700',
      repoFullName: 'acct/app',
      repositories: [{ full_name: 'acct/app', id: 4242 }],
      accountId: '5551234',
    });

    // 200 + JS `location.replace`, NOT a 302.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
    expect(target).not.toBeNull();
    expect(target!.startsWith('http://localhost:9999/callback')).toBe(true);
    expect(grant).not.toBeNull();
    expect(body).toContain('location.replace(');

    const decoded = decodeSignedPayload(grant!);
    expect(decoded.purpose).toBe('connect');
    expect(decoded.installationId).toBe('700');
    expect(decoded.repoFullName).toBe('acct/app');
    expect(decoded.repositoryId).toBe(4242);
    expect(decoded.githubAccountId).toBe('5551234');
    expect(decoded.codeChallenge).toBe(challenge);
    expect(decoded.codeChallengeMethod).toBe('S256');
    expect(typeof decoded.exp).toBe('number');
    expect((decoded.exp as number) > Date.now()).toBe(true);

    // The callback has no bearer identity, so it writes NO membership row.
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('sends a matching redirect_uri on the token exchange', async () => {
    const { tokenExchangeBody } = mockUserConnect({
      repositories: [{ full_name: 'acct/app', id: 4242 }],
      accountId: '5551234',
    });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintConnectState({
      redirect: 'http://localhost:9999/callback',
      installationId: '700',
      repoFullName: 'acct/app',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);
    // redirect_uri is derived from the connect-authorize-callback request origin,
    // byte-identical to the one connect-authorize-url sent on authorize.
    expect(tokenExchangeBody.current?.redirect_uri).toBe(CONNECT_CALLBACK_URL);
  });

  it('bounces repo_not_accessible when the caller cannot reach the repo', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);

    const { res, grant, target } = await runConnectCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationId: '700',
      repoFullName: 'acct/app',
      // The caller's token reaches a DIFFERENT repo — not acct/app.
      repositories: [{ full_name: 'acct/other', id: 9 }],
      accountId: '5551234',
    });

    expect(res.status).toBe(200);
    expect(grant).toBeNull();
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('repo_not_accessible');
    expect(parsed.searchParams.get('connect_grant')).toBeNull();
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('bounces repo_not_accessible when the installation exposes no repositories', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);

    const { res, grant, target } = await runConnectCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationId: '700',
      repoFullName: 'acct/app',
      repositories: [],
      accountId: '5551234',
    });

    expect(res.status).toBe(200);
    expect(grant).toBeNull();
    const parsed = new URL(target!);
    expect(parsed.searchParams.get('error')).toBe('repo_not_accessible');
    expect(parsed.searchParams.get('connect_grant')).toBeNull();
  });

  it('bounces repo_not_accessible when the token exchange fails', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);

    // acceptCode:false → verifyUserRepoAccess returns { null, null } → refuse.
    const { res, grant, target } = await runConnectCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationId: '700',
      repoFullName: 'acct/app',
      repositories: [{ full_name: 'acct/app', id: 4242 }],
      accountId: '5551234',
      acceptCode: false,
    });

    expect(res.status).toBe(200);
    expect(grant).toBeNull();
    const parsed = new URL(target!);
    expect(parsed.searchParams.get('error')).toBe('repo_not_accessible');
    expect(parsed.searchParams.get('connect_grant')).toBeNull();
  });

  it('bounces the GitHub denial (no code, error param) to the CLI localhost', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintConnectState({
      redirect: 'http://localhost:9999/callback',
      installationId: '700',
      repoFullName: 'acct/app',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-callback?state=${encodeURIComponent(state)}&error=access_denied`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const target = extractRedirectTarget(await res.text());
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('access_denied');
    expect(parsed.searchParams.get('connect_grant')).toBeNull();
  });

  it('rejects a forged/altered state (bad signature)', async () => {
    mockUserConnect({ repositories: [{ full_name: 'acct/app', id: 4242 }], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintConnectState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    // Flip the FIRST char of the signature (a full 6 significant bits, so the
    // decoded HMAC bytes always change — no flaky no-op tamper).
    const dot = state.lastIndexOf('.');
    const sig = state.slice(dot + 1);
    const first = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${state.slice(0, dot + 1)}${first}${sig.slice(1)}`;

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-callback?code=valid-code&state=${encodeURIComponent(tampered)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects an expired state', async () => {
    mockUserConnect({ repositories: [{ full_name: 'acct/app', id: 4242 }], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintConnectState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() - 1000, // already expired
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 (not 500) for a malformed, non-base64url state signature', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        redirect: 'http://localhost:9999/callback',
        purpose: 'connect',
        installationId: '700',
        repoFullName: 'acct/app',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 60_000,
      }),
    );
    // `*` is outside the base64 alphabet → atob() throws inside hmacVerifyState.
    const malformed = `${encoded}.*`;
    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-callback?code=valid-code&state=${encodeURIComponent(malformed)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });

  it('rejects a join-purpose state (cross-flow replay)', async () => {
    mockUserConnect({ repositories: [{ full_name: 'acct/app', id: 4242 }], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    // A validly-signed state whose purpose is 'join' must not drive the connect
    // callback — the purpose discriminator blocks cross-flow replay.
    const state = await mintConnectState({
      redirect: 'http://localhost:9999/callback',
      purpose: 'join',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/connect-authorize-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });
});
