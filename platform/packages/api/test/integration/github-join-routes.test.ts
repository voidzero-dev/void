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
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as dbModule from '../../src/db.ts';
import {
  getGitHubInstallationsByUser,
  recordInstallationRevocations,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { githubRoutes } from '../../src/routes/github.ts';
import { githubInstallationMembers } from '../../src/schema.ts';
import { JWT_SECRET, clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

// Self-contained app mirroring how index.ts mounts githubRoutes: auth is applied
// per-route inside githubRoutes (join-url + join/complete are authed; the public
// join-callback is not), so the only outer middleware is the db setter.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes);

// The App's user-to-server OAuth credentials. Present only when the App is
// configured for "Request user authorization (OAuth)" — the join flow is inert
// (503) without them.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

// A valid 43-char RFC 7636 code_verifier and a second, mismatched one.
const CODE_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars
const WRONG_VERIFIER = 'ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789._~-abcd'; // 44 chars, well-formed
// The GitHub account id carried by the default `mintJoinCode` / `runJoinCallback`.
// The revocation tombstone is keyed by THIS id, not the joiner's Void
// user id, so the join-flow revocation tests record the tombstone against it.
const JOIN_ACCOUNT_ID = '5551234';

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

function authedPost(jwt: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Stub global fetch for the App user-OAuth reads the join callback performs via
// `listAuthorizedInstallationIds`:
//   - POST login/oauth/access_token -> user token (unless `acceptCode === false`)
//   - GET  /user/installations       -> the installations the caller can manage
//   - GET  /user                     -> the caller's numeric github account id
function mockUserJoin(opts: {
  installationIds: Array<string>;
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
      // The installations list must be matched BEFORE the `/user` id read, since
      // `/user/installations` also ends the account read's `/user` substring.
      if (url.includes('/user/installations')) {
        return Response.json({
          installations: opts.installationIds.map((id) => ({ id: Number(id) })),
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

// Mint a signed join `state` exactly the way GET /join-url does — used to drive
// the callback directly and to forge expired/altered states.
async function mintJoinState(payload: {
  redirect: string;
  purpose?: string;
  codeChallenge: string;
  exp: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      redirect: payload.redirect,
      purpose: payload.purpose ?? 'join',
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: 'S256',
      exp: payload.exp,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Forge a signed `join_code` the same `${btoa(json)}.${hmac(JWT_SECRET)}` way the
// public join callback mints it — used to drive /join/complete with a controllable
// `iat` (the moment GitHub access was proven) so the revocation-tombstone gate can
// be exercised without racing the DB clock.
async function mintJoinCode(payload: {
  installationIds: Array<string>;
  githubAccountId?: string;
  codeChallenge: string;
  iat: number;
  exp?: number;
}): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      purpose: 'join',
      installationIds: payload.installationIds,
      githubAccountId: payload.githubAccountId ?? '5551234',
      codeChallenge: payload.codeChallenge,
      codeChallengeMethod: 'S256',
      iat: payload.iat,
      exp: payload.exp ?? Date.now() + 5 * 60 * 1000,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Extract the JS-redirect target URL from the 200 HTML body the callback returns.
// The callback uses 200 + `location.replace("<target>")` (not a 302) because
// `wrangler dev` mangles `Location: http://localhost:*` headers. The target
// carries the signed `join_code`.
function extractRedirectTarget(body: string): string | null {
  const match = /location\.replace\("([^"]+)"\)/.exec(body);
  return match ? match[1] : null;
}

// Drive the callback for a freshly-minted valid state + a stubbed exchange, and
// return the `join_code` it redirected to localhost with (parsed out of the 200
// HTML body's `location.replace(...)` target, not a Location header).
async function runJoinCallback(opts: {
  redirect: string;
  codeChallenge: string;
  installationIds: Array<string>;
  accountId: string;
}): Promise<{ res: Response; body: string; joinCode: string | null; target: string | null }> {
  mockUserJoin({ installationIds: opts.installationIds, accountId: opts.accountId });
  const state = await mintJoinState({
    redirect: opts.redirect,
    codeChallenge: opts.codeChallenge,
    exp: Date.now() + 10 * 60 * 1000,
  });
  const res = await app.fetch(
    new Request(
      `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
    ),
    { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
  );
  const body = await res.text();
  const target = extractRedirectTarget(body);
  const joinCode = target ? new URL(target).searchParams.get('join_code') : null;
  return { res, body, joinCode, target };
}

// Seed an installation Void tracks, with no owner. `accountType` defaults to
// 'Organization' (the only account type org-share admits) — pass 'User' to seed
// an unlinked personal install for the Organization-only guard regressions.
async function seedInstall(opts: {
  installationId: string;
  accountId?: string;
  accountType?: 'User' | 'Organization';
}): Promise<void> {
  await upsertGitHubInstallation(env.db, {
    installationId: opts.installationId,
    userId: null,
    accountLogin: `acct-${opts.installationId}`,
    accountId: opts.accountId ?? `500${opts.installationId}`,
    accountType: opts.accountType ?? 'Organization',
    repositories: [{ full_name: `acct-${opts.installationId}/app`, id: 1 }],
  });
}

// Decode the eligible installation-id list out of a signed join_code (the same
// `${btoa(json)}.${hmac}` form the callback mints). Used to assert the eligibility
// gate excluded a personal (account_type='User') install.
function decodeJoinCodeInstallationIds(joinCode: string): Array<string> {
  const encoded = joinCode.slice(0, joinCode.lastIndexOf('.'));
  const payload = JSON.parse(atob(encoded)) as { installationIds?: Array<string> };
  return payload.installationIds ?? [];
}

async function countMemberRows(db: Db, installationId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: githubInstallationMembers.id })
    .from(githubInstallationMembers)
    .where(
      and(
        eq(githubInstallationMembers.installation_id, installationId),
        eq(githubInstallationMembers.user_id, userId),
      ),
    );
  return rows.length;
}

async function countAllMemberRows(db: Db): Promise<number> {
  const rows = await db
    .select({ id: githubInstallationMembers.id })
    .from(githubInstallationMembers);
  return rows.length;
}

describe('GET /github/join-url', () => {
  it('returns a signed join url with purpose:join, the challenge, future exp, and no userId', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'http://localhost:9999/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    const { url } = await res.json<{ url: string }>();
    expect(url.startsWith('https://github.com/login/oauth/authorize?')).toBe(true);
    expect(url).toContain(`client_id=${GITHUB_APP_USER_OAUTH_ENV.GITHUB_APP_CLIENT_ID}`);

    const state = decodeStateFromAuthorizeUrl(url);
    expect(state.purpose).toBe('join');
    expect(state.codeChallenge).toBe(challenge);
    expect(state.codeChallengeMethod).toBe('S256');
    expect(state.redirect).toBe(redirect);
    expect(typeof state.exp).toBe('number');
    expect((state.exp as number) > Date.now()).toBe(true);
    // The crux: state carries NO Void user id (the bind is deferred to complete).
    expect('userId' in state).toBe(false);
  });

  it('rejects a non-localhost redirect', async () => {
    const user = await createTestUser(env.db);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const redirect = 'https://evil.example.com/callback';

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
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
        `http://localhost/github/join-url?redirect=${encodeURIComponent(redirect)}&code_challenge=${challenge}`,
        authedGet(user.jwt),
      ),
      env,
    );

    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe('github_oauth_not_configured');
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join-url?redirect=http://localhost:1/cb&code_challenge=x',
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /github/join-callback', () => {
  it('redirects to localhost with a join_code and binds NOTHING', async () => {
    await seedInstall({ installationId: '700' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);

    const { res, body, joinCode, target } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });

    // 200 + JS `location.replace`, NOT a 302.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('location')).toBeNull();
    expect(target).not.toBeNull();
    expect(target!.startsWith('http://localhost:9999/callback')).toBe(true);
    expect(joinCode).not.toBeNull();
    expect(body).toContain('location.replace(');

    // The callback binds nothing — no membership rows exist yet.
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  // The join_code `iat` must be sampled (getDbNowMs) BEFORE the GitHub
  // access proof, so it is a conservative lower bound. A removal landing in the
  // proof→mint gap (dominated by GitHub access-propagation lag) then has
  // revoked_at >= iat and is rejected at /join/complete. This asserts the
  // ordering deterministically (no timing race): a spied getDbNowMs records its
  // call, the proof's first network hit records its own, and getDbNowMs must come
  // first; the spied value is what the artifact carries.
  it('stamps the join_code iat via getDbNowMs BEFORE the GitHub proof', async () => {
    await seedInstall({ installationId: '700' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);

    const callOrder: Array<string> = [];
    const SENTINEL_IAT = 1_700_000_000_000;
    const iatSpy = vi.spyOn(dbModule, 'getDbNowMs').mockImplementation(async () => {
      callOrder.push('iat');
      return SENTINEL_IAT;
    });
    // Custom fetch stub that records the FIRST proof network call (the OAuth token
    // exchange) so its position relative to getDbNowMs is observable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('login/oauth/access_token')) {
          callOrder.push('proof');
          return Response.json({ access_token: 'user-to-server-token' });
        }
        if (url.includes('/user/installations')) {
          return Response.json({ installations: [{ id: 700 }] });
        }
        if (url.endsWith('/user')) {
          return Response.json({ id: Number(JOIN_ACCOUNT_ID) });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    const body = await res.text();
    const joinCode = new URL(extractRedirectTarget(body)!).searchParams.get('join_code')!;

    // getDbNowMs ran exactly once, and BEFORE the proof's first network call.
    expect(iatSpy).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['iat', 'proof']);
    // The pre-proof sentinel is exactly the iat carried into the minted artifact.
    const decoded = JSON.parse(atob(joinCode.slice(0, joinCode.lastIndexOf('.')))) as {
      iat: number;
    };
    expect(decoded.iat).toBe(SENTINEL_IAT);
  });

  it('sends a matching redirect_uri on the token exchange', async () => {
    await seedInstall({ installationId: '700' });
    const { tokenExchangeBody } = mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });
    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);
    // redirect_uri is derived from the join-callback request origin (NOT
    // state.redirect, the CLI's localhost). join-url and join-callback derive the
    // same value, so GitHub's redirect_uri-match requirement is satisfied.
    expect(tokenExchangeBody.current?.redirect_uri).toBe('http://localhost/github/join-callback');
  });

  it('rejects a forged/altered state (bad signature)', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
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
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(tampered)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects an expired state', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() - 1000, // already expired
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
  });

  it('rejects a link-purpose state (cross-flow replay)', async () => {
    mockUserJoin({ installationIds: ['700'], accountId: '5551234' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    // A validly-signed state whose purpose is 'link' must not drive the join
    // callback — the purpose discriminator blocks cross-flow replay.
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      purpose: 'link',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(state)}`,
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
        purpose: 'join',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 60_000,
      }),
    );
    // `*` is outside the base64 alphabet → atob() throws inside hmacVerifyState.
    const malformed = `${encoded}.*`;
    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=valid-code&state=${encodeURIComponent(malformed)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });

  it('bounces github_oauth_failed to the CLI localhost when the exchange yields no installations', async () => {
    // acceptCode:false → the token exchange fails → the accessible set is empty →
    // nothing to join, so the error bounces to the CLI's localhost.
    mockUserJoin({ installationIds: ['700'], accountId: '5551234', acceptCode: false });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?code=bad-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const target = extractRedirectTarget(await res.text());
    expect(target).not.toBeNull();
    const parsed = new URL(target!);
    expect(parsed.origin).toBe('http://localhost:9999');
    expect(parsed.searchParams.get('error')).toBe('github_oauth_failed');
    expect(parsed.searchParams.get('join_code')).toBeNull();
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('bounces the GitHub denial (no code, error param) to the CLI localhost', async () => {
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const state = await mintJoinState({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      exp: Date.now() + 10 * 60 * 1000,
    });

    const res = await app.fetch(
      new Request(
        `http://localhost/github/join-callback?state=${encodeURIComponent(state)}&error=access_denied`,
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
    expect(parsed.searchParams.get('join_code')).toBeNull();
  });

  // Org-share is Organization-only (guard a). A personal (account_type='User')
  // install the caller merely collaborates on must NOT become a join target — it
  // has no member_removed revocation path. The minted join_code's eligible list
  // must exclude the personal install and keep only the Organization one.
  it('excludes a personal (account_type=User) install from the join_code eligibility', async () => {
    // 700: Organization → eligible. 701: personal (User) → excluded.
    await seedInstall({ installationId: '700', accountType: 'Organization' });
    await seedInstall({ installationId: '701', accountType: 'User' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700', '701'],
      accountId: '5551234',
    });
    expect(joinCode).not.toBeNull();

    const eligibleIds = decodeJoinCodeInstallationIds(joinCode!);
    expect(eligibleIds).toEqual(['700']);
    expect(eligibleIds).not.toContain('701');
  });
});

describe('POST /github/join/complete', () => {
  it('upserts a membership keyed on the completing token-holder and returns joined', async () => {
    // The joiner is a google-only account with no github identity.
    const other = await createTestUser(env.db, 'other', 'github', '900000700');
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    expect(joinCode).not.toBeNull();

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
    // Never bound to any other user.
    expect(await countMemberRows(env.db, '700', other.id)).toBe(0);
  });

  // A join_code minted in a callback is completed by an arbitrary authed user; the membership binds to the COMPLETING bearer token,
  // NEVER to anyone named in the state/join_code.
  it('binds the membership to the completing token-holder, not the flow initiator', async () => {
    const attacker = await createTestUser(env.db, 'attacker', 'google', 'google-attacker');
    const completer = await createTestUser(env.db, 'completer', 'google', 'google-completer');
    await seedInstall({ installationId: '700' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    expect(joinCode).not.toBeNull();

    // `completer` (the machine the join_code landed on) redeems it. The bind MUST
    // go to `completer`, never `attacker`.
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(completer.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', completer.id)).toBe(1);
    expect(await countMemberRows(env.db, '700', attacker.id)).toBe(0);
  });

  it('is idempotent — a re-run refreshes the single (install,user) row', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);

    const first = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    const firstComplete = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: first.joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(firstComplete.status).toBe(200);
    expect(await firstComplete.json()).toEqual({ status: 'joined', count: 1 });

    // A second, independent join_code for the same install.
    const second = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    const secondComplete = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: second.joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(secondComplete.status).toBe(200);
    expect(await secondComplete.json()).toEqual({ status: 'joined', count: 1 });

    // Still exactly one row for (install, user).
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
    expect(await countAllMemberRows(env.db)).toBe(1);
  });

  it('rejects a PKCE mismatch with invalid_verifier and binds nothing', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: WRONG_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_verifier');
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('rejects an expired join_code', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    // Mint an already-expired join_code directly with the same signer scheme.
    const encoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: ['700'],
        githubAccountId: '5551234',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() - 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const expiredJoinCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: expiredJoinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(await countAllMemberRows(env.db)).toBe(0);
  });

  it('excludes installs outside the caller accessible set and installs Void does not track', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    // 700: accessible AND Void-known → eligible.
    // 800: Void-known but NOT in the accessible set → excluded.
    // 999: accessible but NOT Void-known → excluded.
    await seedInstall({ installationId: '700' });
    await seedInstall({ installationId: '800' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700', '999'],
      accountId: '5551234',
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
    expect(await countMemberRows(env.db, '800', joiner.id)).toBe(0);
    expect(await countMemberRows(env.db, '999', joiner.id)).toBe(0);
    expect(await countAllMemberRows(env.db)).toBe(1);
  });

  // The person who installed the App on an organization has no special standing:
  // once the membership recorded by the install callback lapses, they rejoin like
  // any other member and the installation becomes visible again.
  it('lets the organization installer rejoin after their membership expires', async () => {
    const installer = await createTestUser(env.db, 'installer', 'github', '900000704');
    await seedInstall({ installationId: '700' });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '700',
      userId: installer.id,
      githubAccountId: '900000704',
      ttlSeconds: -60,
    });
    expect(await getGitHubInstallationsByUser(env.db, installer.id)).toHaveLength(0);

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '900000704',
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(installer.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', installer.id)).toBe(1);
    const installs = await getGitHubInstallationsByUser(env.db, installer.id);
    expect(installs.map((i) => i.installation_id)).toEqual(['700']);
  });

  it('rejects a malformed body', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: 42 }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/github/join/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_code: 'x', code_verifier: 'y' }),
      }),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(401);
  });

  // A successful join makes the install visible via the
  // owner-OR-member by-user lookup.
  it('makes the joined install visible via getGitHubInstallationsByUser', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    // Before joining, the joiner sees nothing.
    expect(await getGitHubInstallationsByUser(env.db, joiner.id)).toHaveLength(0);

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const { joinCode } = await runJoinCallback({
      redirect: 'http://localhost:9999/callback',
      codeChallenge: challenge,
      installationIds: ['700'],
      accountId: '5551234',
    });
    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(res.status).toBe(200);

    const installs = await getGitHubInstallationsByUser(env.db, joiner.id);
    expect(installs.map((i) => i.installation_id)).toContain('700');
  });

  // Monotonic revocation: a join_code minted BEFORE a recorded
  // revocation (iat <= revoked_at) is a stale artifact from a removed member — it
  // must NOT resurrect the membership. The install is silently skipped (not
  // counted).
  it('skips an install whose join_code predates a recorded revocation (stale replay)', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    // The member was removed AFTER minting the join_code: record the tombstone
    // now (revoked_at = now()), and forge a join_code stamped a minute in the past.
    await recordInstallationRevocations(env.db, ['700'], JOIN_ACCOUNT_ID);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const staleJoinCode = await mintJoinCode({
      installationIds: ['700'],
      codeChallenge: challenge,
      iat: Date.now() - 60_000,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: staleJoinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    // Skipped, not counted — no membership resurrected.
    expect(await res.json()).toEqual({ status: 'joined', count: 0 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
  });

  // The tombstone is a HIGH-WATER MARK, not a permanent ban: a legit re-join AFTER
  // re-add mints a FRESH join_code (iat > revoked_at) which must be honored.
  it('restores membership when the join_code post-dates the revocation (legit re-join)', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    // Revoke first, then the member is re-added and re-joins: the fresh join_code
    // is stamped in the future relative to the tombstone.
    await recordInstallationRevocations(env.db, ['700'], JOIN_ACCOUNT_ID);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const freshJoinCode = await mintJoinCode({
      installationIds: ['700'],
      codeChallenge: challenge,
      iat: Date.now() + 60_000,
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: freshJoinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(1);
  });

  // A join_code without `iat` cannot be compared with revocation tombstones, so
  // it is rejected outright. Mint inline so the property is truly ABSENT from the
  // signed payload (mintJoinCode would inject one).
  it('rejects a join_code without iat', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: ['700'],
        githubAccountId: '5551234',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const joinCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid join_code' });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
  });

  // A membership must record the GitHub account that proved access.
  it.each([null, ''])('rejects a join_code with GitHub account id %j', async (githubAccountId) => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });

    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const encoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: ['700'],
        githubAccountId,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const joinCode = `${encoded}.${signature}`;

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid join_code' });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
  });

  // The tombstone-read + upsert loop runs inside a transaction
  // that locks the target install rows install-first. That serializes a concurrent
  // member_removed (not deterministically reproducible under PGlite's serialized
  // txns — hence no flaky race test), but the tombstone-skip RESULT must be
  // unchanged. Over a multi-install join_code, the revoked install is skipped and
  // the fresh one created in a SINGLE atomic commit, and `count` excludes the skip.
  it('under the tx-wrap, a multi-install join skips the revoked install and creates the fresh one', async () => {
    const joiner = await createTestUser(env.db, 'joiner', 'google', 'google-joiner');
    await seedInstall({ installationId: '700' });
    await seedInstall({ installationId: '701' });

    // 700 was revoked AFTER the join_code was minted (stale → skip); 701 has no
    // tombstone (fresh → create). One join_code covers both installs.
    await recordInstallationRevocations(env.db, ['700'], JOIN_ACCOUNT_ID);
    const challenge = await createCodeChallenge(CODE_VERIFIER);
    const joinCode = await mintJoinCode({
      installationIds: ['700', '701'],
      codeChallenge: challenge,
      iat: Date.now() - 60_000, // predates the 700 tombstone
    });

    const res = await app.fetch(
      new Request(
        'http://localhost/github/join/complete',
        authedPost(joiner.jwt, { join_code: joinCode, code_verifier: CODE_VERIFIER }),
      ),
      { ...env, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(200);
    // Only 701 honored — 700 is a stale replay, skipped and not counted.
    expect(await res.json()).toEqual({ status: 'joined', count: 1 });
    expect(await countMemberRows(env.db, '700', joiner.id)).toBe(0);
    expect(await countMemberRows(env.db, '701', joiner.id)).toBe(1);
  });
});
