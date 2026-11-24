import { and, eq } from 'drizzle-orm';
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
import {
  createOAuthAccount,
  getGitHubInstallationsByUser,
  getUserByOAuthAccount,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { githubRoutes } from '../../src/routes/github.ts';
import { githubInstallations, oauthAccounts } from '../../src/schema.ts';
import { JWT_SECRET, clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

// Self-contained app mirroring how index.ts mounts githubRoutes: auth is applied
// per-route inside githubRoutes (link-url + link/complete are authed; the public
// link-callback is not), so the only outer middleware is the db setter.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes);

// The App's user-to-server OAuth credentials. Present only when the App is
// configured for "Request user authorization (OAuth)" — the link flow is inert
// (503) without them.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

// A valid 43-char RFC 7636 code_verifier and a second, mismatched one.
const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars
const WRONG_VERIFIER = 'ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789._~-abcd'; // 44 chars, well-formed

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // github_* tables aren't known to the shared clearTables helper; clear them
  // before it removes the users they reference.
  await env.db.delete(githubInstallations);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authedGet(jwt: string): RequestInit {
  return { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } };
}

function authedPost(jwt: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Stub global fetch for the App user-OAuth exchange used by the callback:
//   - POST login/oauth/access_token -> user token (unless `acceptCode === false`)
//   - GET /user -> the authorizing user's numeric account id (`providerId`)
function mockUserOAuth(opts: { providerId: string; acceptCode?: boolean }): {
  calls: { tokenExchange: boolean; user: boolean };
  tokenExchangeBody: { current: Record<string, unknown> | null };
} {
  const calls = { tokenExchange: false, user: false };
  const tokenExchangeBody = { current: null as Record<string, unknown> | null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('login/oauth/access_token')) {
        calls.tokenExchange = true;
        if (typeof init?.body === 'string') {
          tokenExchangeBody.current = JSON.parse(init.body) as Record<string, unknown>;
        }
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      if (url.endsWith('/user')) {
        calls.user = true;
        return Response.json({ id: Number(opts.providerId) });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { calls, tokenExchangeBody };
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

// Mint a signed `state` exactly the way GET /link-url does — used to drive the
// callback directly and to forge expired/altered states.
async function mintState(payload: {
  redirect: string;
  purpose?: string;
  codeChallenge: string;
  exp: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      redirect: payload.redirect,
      purpose: payload.purpose ?? 'link',
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
// `wrangler dev` mangles `Location: http://localhost:*` headers (see meta/lessons.md
// and src/html-redirect.ts). The target carries the signed `link_code`.
function extractRedirectTarget(body: string): string | null {
  const match = /location\.replace\("([^"]+)"\)/.exec(body);
  return match ? match[1] : null;
}

// Drive the callback for a freshly-minted valid state + a stubbed exchange, and
// return the `link_code` it redirected to localhost with (parsed out of the
// 200 HTML body's `location.replace(...)` target, not a Location header).
async function runCallback(opts: {
  redirect: string;
  codeChallenge: string;
  providerId: string;
}): Promise<{ res: Response; body: string; linkCode: string | null; target: string | null }> {
  mockUserOAuth({ providerId: opts.providerId });
  const state = await mintState({
    redirect: opts.redirect,
    codeChallenge: opts.codeChallenge,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const res = await app.fetch(
    new Request(
      `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(state)}`,
    ),
    { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
  );
  const body = await res.text();
  const target = extractRedirectTarget(body);
  const linkCode = target ? new URL(target).searchParams.get('link_code') : null;
  return { res, body, linkCode, target };
}

async function countOAuthRows(db: Db, providerId: string): Promise<number> {
  const rows = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, 'github'), eq(oauthAccounts.provider_id, providerId)));
  return rows.length;
}

describe('GET /github/link-url', () => {
  it('returns a signed link url with purpose:link, the challenge, future exp, and no userId', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    const { url } = await res.json<{ url: string }>();
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain(`client_id=${GITHUB_APP_USER_OAUTH_ENV.GITHUB_APP_CLIENT_ID}`);

    const state = decodeStateFromAuthorizeUrl(url);
    expect(state.purpose).toBe('link');
    expect(state.codeChallenge).toBe(challenge);
    expect(state.codeChallengeMethod).toBe('S256');
    expect(state.redirect).toBe(redirect);
    expect(typeof state.exp).toBe('number');
    expect((state.exp as number) > Date.now()).toBe(true);
    // The crux: state carries NO Void user id.
    expect('userId' in state).toBe(false);
  });

  it('rejects a non-localhost redirect', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'https://evil.example.com/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('fails closed (non-2xx, configured-error code) when App user OAuth is unset', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    // No GITHUB_APP_CLIENT_ID/SECRET on env.
    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      env,
    );

    expect(res.status).not.toBe(200);
    expect((await res.json<{ error: string }>()).error).toBe('github_oauth_not_configured');
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request(
        'http://localhost/github/link-url?redirect=http://localhost:1/cb&code_challenge=x',
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /github/link-callback', () => {
  it('redirects to localhost with a link_code and binds NOTHING', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000001';
    const { res, body, linkCode, target } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    // 200 + JS `location.replace`, NOT a 302 — `wrangler dev` mangles
    // `Location: http://localhost:*` headers (see meta/lessons.md). The
    // link_code-bearing localhost target is embedded in the HTML body.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
    expect(target).not.toBeNull();
    expect(target!.startsWith('http://localhost:9999/callback')).toBe(true);
    expect(linkCode).not.toBeNull();
    expect(body).toContain('location.replace(');

    // The callback must NOT have created any oauth_accounts row for this id.
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('rejects a forged/altered state (bad signature)', async () => {
    mockUserOAuth({ providerId: '900000002' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    // Flip the FIRST character of the signature. The signature is a 43-char
    // base64url encoding of 32 HMAC bytes; its LAST char carries only 2
    // significant bits, so flipping it decodes to the same bytes ~1/4 of the
    // time (the tamper becomes a no-op → 200, a flaky pass). The first char
    // carries a full 6 bits, so flipping it always changes the decoded bytes.
    const dot = state.lastIndexOf('.');
    const sig = state.slice(dot + 1);
    const first = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${state.slice(0, dot + 1)}${first}${sig.slice(1)}`;

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(tampered)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects an expired state', async () => {
    mockUserOAuth({ providerId: '900000003' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() - 1000, // already expired
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('bounces github_oauth_failed to the CLI localhost when the code exchange fails', async () => {
    mockUserOAuth({ providerId: '900000004', acceptCode: false });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=bad-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    // State + redirect are validated, so the error is bounced to the CLI's
    // localhost listener (200 + JS redirect) rather than JSON on the API host —
    // otherwise `void github link` hangs until its 5-min timeout.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const target = extractRedirectTarget(await res.text());
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('github_oauth_failed');
    expect(parsed.searchParams.get('link_code')).toBeNull();
  });

  it('bounces the GitHub denial (no code, error param) to the CLI localhost', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    // GitHub denial: no `code`, an `error` query param. State is valid, so the
    // denial is propagated to the CLI's localhost listener.
    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?state=${encodeURIComponent(state)}&error=access_denied`,
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
    expect(parsed.searchParams.get('link_code')).toBeNull();
  });

  it('sends a matching redirect_uri on the token exchange', async () => {
    const { tokenExchangeBody } = mockUserOAuth({ providerId: '900000040' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);
    // redirect_uri is derived from the link-callback request origin (NOT state.redirect,
    // which is the CLI's localhost). Both link-url and link-callback derive the same value.
    expect(tokenExchangeBody.current?.redirect_uri).toBe('http://localhost/github/link-callback');
  });

  it('returns 400 (not 500) for a malformed, non-base64url state signature', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        redirect: 'http://localhost:9999/callback',
        purpose: 'link',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 60_000,
      }),
    );
    // `*` is outside the base64 alphabet → atob() throws inside hmacVerifyState.
    // The route must fail closed with 400, not surface a 500.
    const malformed = `${encoded}.*`;
    const res = await app.fetch(
      new Request(
        `http://localhost/github/link-callback?code=valid-code&state=${encodeURIComponent(malformed)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /github/link/complete', () => {
  it('binds the identity to the authed caller and returns linked', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000010';
    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    expect(linkCode).not.toBeNull();

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('linked');

    const owner = await getUserByOAuthAccount(env.db, 'github', providerId);
    expect(owner?.id).toBe(userA.id);
    expect(await countOAuthRows(env.db, providerId)).toBe(1);
  });

  it('is idempotent for the same caller (already_linked, still one row)', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000011';

    const first = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    const firstComplete = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: first.linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );
    expect(firstComplete.status).toBe(200);
    expect((await firstComplete.json<{ status: string }>()).status).toBe('linked');

    // A second, independent link_code for the same provider id.
    const second = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    const secondComplete = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: second.linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );
    expect(secondComplete.status).toBe(200);
    expect((await secondComplete.json<{ status: string }>()).status).toBe('already_linked');
    expect(await countOAuthRows(env.db, providerId)).toBe(1);
  });

  it('rejects a PKCE mismatch with invalid_verifier and binds nothing', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000012';
    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: WRONG_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_verifier');
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('rejects an expired link_code', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000013';
    // Mint an already-expired link_code directly with the same signer scheme.
    const encoded = btoa(
      JSON.stringify({
        providerId,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() - 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const expiredLinkCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: expiredLinkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(400);
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  it('returns 409 when the provider id is already linked to another user', async () => {
    const userB = await createTestUser(env.db, 'bob', 'github', '900000014');
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    // B already owns this github provider id (seeded by createTestUser above).
    const providerId = '900000014';

    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('github_identity_conflict');
    // The row is still owned by B.
    const owner = await getUserByOAuthAccount(env.db, 'github', providerId);
    expect(owner?.id).toBe(userB.id);
  });

  // A link_code minted in a callback (for providerId P) is completed by a
  // DIFFERENT authed user than the one who would phish the flow. The bind follows
  // the COMPLETING bearer token, never a state/initiator notion — so an attacker
  // can only ever link their own id.
  it('binds the link_code to the COMPLETING token-holder, not the flow initiator', async () => {
    // Two distinct Void accounts, both logged in via a non-github provider so
    // neither has a github oauth row yet.
    const attacker = await createTestUser(env.db, 'attacker', 'google', 'google-attacker');
    const completer = await createTestUser(env.db, 'completer', 'google', 'google-completer');

    // The flow runs to a link_code (the victim's GitHub id P authorized in a
    // callback). There is NO user id anywhere in state/link_code.
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000015';
    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });
    expect(linkCode).not.toBeNull();

    // The `completer` (the bearer-token holder whose machine the link_code
    // landed on) redeems it. The bind MUST go to `completer`, never `attacker`.
    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(completer.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('linked');

    const owner = await getUserByOAuthAccount(env.db, 'github', providerId);
    expect(owner?.id).toBe(completer.id);
    expect(owner?.id).not.toBe(attacker.id);
    expect(await countOAuthRows(env.db, providerId)).toBe(1);
  });

  // The caller already has a DIFFERENT github identity. RFC 0074
  // allows one github identity per Void account, so this is github_already_linked
  // (a DISTINCT 409 code from the other-user github_identity_conflict).
  it('returns 409 github_already_linked when the caller already linked a different github id', async () => {
    // Alice signed in via google, then already linked github id 'A'.
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    await createOAuthAccount(env.db, userA.id, 'github', '900000020');

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000021'; // a DIFFERENT github id

    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('github_already_linked');
    // No second github row was created for Alice.
    expect(await countOAuthRows(env.db, providerId)).toBe(0);
  });

  // A successful link backfills the caller's pre-existing,
  // unowned installation (created before sign-in). A google user who links
  // should then see/connect that installation.
  it('backfills pre-existing unowned installations to the completing user on link', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const providerId = '900000030';

    // An installation created BEFORE Alice linked — user_id is null and
    // account_id is Alice's (about-to-be-linked) github account id.
    await upsertGitHubInstallation(env.db, {
      installationId: '500',
      userId: null,
      accountLogin: 'alice-gh',
      accountId: providerId,
      accountType: 'User',
      repositories: [{ full_name: 'alice-gh/app', id: 1 }],
    });

    const { linkCode } = await runCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      providerId,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/link/complete',
        authedPost(userA.jwt, { link_code: linkCode, code_verifier: CODE_VERIFIER }),
      ),
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('linked');

    // The installation is now owned by Alice...
    const [row] = await env.db
      .select({ userId: githubInstallations.user_id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installation_id, '500'));
    expect(row?.userId).toBe(userA.id);

    // ...and therefore visible via the by-user lookup.
    const installs = await getGitHubInstallationsByUser(env.db, userA.id);
    expect(installs.map((i) => i.installation_id)).toContain('500');
  });
});
