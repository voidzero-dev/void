import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { hmacSignState, hmacVerifyState } from '../auth/hmac.ts';
import {
  CLI_CODE_CHALLENGE_METHOD,
  createCodeChallenge,
  isValidCodeVerifier,
} from '../auth/pkce.ts';
import { isLocalhostRedirect } from '../auth/redirects.ts';
import { capabilityMiddleware } from '../capabilities.ts';
import { DEFAULT_DASHBOARD_URL, MEMBERSHIP_TTL_SECONDS } from '../constants.ts';
import type { Db } from '../db.ts';
import {
  createGitHubConnection,
  deleteGitHubConnection,
  getGitHubAccountIdForUser,
  getGitHubConnection,
  getDbNowMs,
  getGitHubInstallation,
  getGitHubInstallationsByUser,
  getInstallationRevocationAt,
  getInstallationRevocationsForAccount,
  GitHubIdentityAlreadyLinkedError,
  GitHubIdentityConflictError,
  hasActiveInstallationMembership,
  linkGitHubIdentity,
  linkGitHubInstallationToUser,
  terminateBuildsForProject,
  updateGitHubConnection,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../db.ts';
import type { TerminatedBuild } from '../db/builds.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import { listInstallationRepositories } from '../github/installation-repos.ts';
import { getInstallationAccount, getInstallationToken } from '../github/installation-token.ts';
import {
  authorizeInstallViaUserToken,
  exchangeCodeForUserAccountId,
  isAppUserOAuthConfigured,
  listAuthorizedInstallationIds,
  verifyUserRepoAccess,
} from '../github/user-installations.ts';
import { localhostRedirectResponse } from '../html-redirect.ts';
import { authMiddleware } from '../middleware/auth.ts';
import { githubConnections, githubInstallations, oauthAccounts, projects } from '../schema.ts';
import type { Build, GitHubConnection, GitHubInstallation } from '../types.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

function publicGitHubConnection(connection: GitHubConnection) {
  const { authorized_by_user_id: authorizationProvenance, ...result } = connection;
  void authorizationProvenance;
  return result;
}

// RFC 0074 link flow. The signed `state` carried through the GitHub
// App user-authorization redirect lives 10 minutes (the human takes the
// browser detour). The `link_code` minted by the public callback and handed
// back to the initiator's localhost lives 5 minutes (a tight machine-to-machine
// turnaround), mirroring the CLI auth-code TTL in `routes/auth.ts`.
const LINK_STATE_TTL_MS = 10 * 60 * 1000;
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * The signed `state` minted by `GET /github/link-url` and verified by the public
 * `GET /github/link-callback`. Deliberately carries NO Void user id: the bind is
 * deferred to the authenticated `POST /github/link/complete`, keyed on the
 * bearer-token holder (RFC 0074 §"Threat L1"). `purpose` discriminates this
 * state from the install-flow state so the two can never be cross-replayed.
 */
type LinkState = {
  redirect: string;
  purpose: 'link';
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `link_code` minted by the public callback and
 * redirected to the initiator's localhost. It binds the GitHub identity proven
 * in the callback (`providerId`) to the PKCE challenge the initiator chose, so
 * only the holder of the matching `code_verifier` can complete the link. Still
 * NO Void user id — the completing bearer token is the only thing that decides
 * which account the identity binds to.
 */
type LinkCode = {
  providerId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The signed `state` for the JOIN flow (org-shared installs), minted by
 * `GET /github/join-url` and verified by the public `GET /github/join-callback`.
 * Structurally mirrors `LinkState` but with `purpose: 'join'` so the two states
 * can never be cross-replayed. Carries NO Void user id — the membership bind is
 * deferred to the authenticated `POST /github/join/complete`, keyed on the
 * bearer-token holder (RFC 0074 §"Threat L1").
 */
type JoinState = {
  redirect: string;
  purpose: 'join';
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `join_code` minted by the public join callback and
 * redirected to the initiator's localhost. It carries the NUMERIC installation
 * ids the caller was proven (via `GET /user/installations`) to access AND that
 * Void already tracks, plus the caller's GitHub account id and the PKCE
 * challenge. Still NO Void user id — the completing bearer token is the only
 * thing that decides which account the memberships bind to. Inert without the
 * matching `code_verifier` (PKCE), which never appears in any URL.
 */
type JoinCode = {
  purpose: 'join';
  installationIds: Array<string>;
  githubAccountId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  // The moment GitHub access was PROVEN (the public callback ran). Compared
  // against the per-install revocation tombstone at /join/complete: a join_code
  // minted at or before a revocation is a stale replay from a removed member and
  // is skipped (monotonic revocation). A code without it is invalid.
  iat: number;
  exp: number;
};

/**
 * The signed `state` for the CONNECT-AUTHORIZE flow (org-shared installs), minted
 * by `GET /github/connect-authorize-url` and verified by the public
 * `GET /github/connect-authorize-callback`. Structurally mirrors `JoinState` but
 * with `purpose: 'connect'` (so it can never be cross-replayed against link/join)
 * and additionally names the specific `installationId` + `repoFullName` the CLI
 * already knows — the callback re-proves the caller can PERSONALLY reach that repo
 * under their own token. Carries NO Void user id — the connection bind is deferred
 * to the authenticated connect redemption, keyed on the bearer-token
 * holder (RFC 0074 §"Threat L1").
 */
type ConnectState = {
  redirect: string;
  purpose: 'connect';
  installationId: string;
  repoFullName: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  exp: number;
};

/**
 * The stateless, HMAC-signed `connect_grant` minted by the public
 * connect-authorize callback and redirected to the initiator's localhost. It
 * carries the resolved numeric `repositoryId` (proven LIVE via
 * `verifyUserRepoAccess` under the CONNECTING user's own token) and that user's
 * numeric GitHub account id — both NON-null (the callback refuses to mint a grant
 * when either is null, so a grant always binds to a real identity). Still NO Void
 * user id — the redeeming bearer token is the only thing that decides which
 * project the connection binds to. Inert without the matching `code_verifier`
 * (PKCE), which never appears in any URL.
 */
type ConnectGrant = {
  purpose: 'connect';
  installationId: string;
  repoFullName: string;
  repositoryId: number;
  githubAccountId: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  // The moment per-repo GitHub access was PROVEN (the connect-authorize callback
  // ran). Compared against the install's revocation tombstone inside the connect
  // gate's go-live transaction: a grant minted at or before a revocation is a
  // stale replay from a removed member and is rejected (monotonic revocation).
  // A grant without it is invalid.
  iat: number;
  exp: number;
};

/**
 * Mirror the EXACT `${btoa(JSON.stringify(payload))}.${signature}` scheme the
 * install-url + `/callback` already use (signed with `JWT_SECRET`).
 */
async function signLinkPayload(
  payload: LinkState | LinkCode | JoinState | JoinCode | ConnectState | ConnectGrant,
  secret: string,
): Promise<string> {
  const encoded = btoa(JSON.stringify(payload));
  const signature = await hmacSignState(encoded, secret);
  return `${encoded}.${signature}`;
}

/**
 * Verify a signed link payload (state or code): split on the LAST `.`, check the
 * HMAC, then `JSON.parse(atob(...))`. Returns `null` on any failure (malformed,
 * bad signature, unparseable) so callers fail closed with a single 400.
 */
async function verifyLinkPayload<T>(token: string, secret: string): Promise<T | null> {
  const dotIndex = token.lastIndexOf('.');
  if (dotIndex === -1) {
    return null;
  }
  const encoded = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);
  const valid = await hmacVerifyState(encoded, signature, secret);
  if (!valid) {
    return null;
  }
  try {
    return JSON.parse(atob(encoded)) as T;
  } catch {
    return null;
  }
}

type AppUserOAuthFlow = 'link' | 'join' | 'connect-authorize';

const APP_USER_OAUTH_NOT_CONFIGURED = {
  error: 'github_oauth_not_configured',
  message: 'GitHub App user OAuth is not configured',
} as const;

// The GitHub App user-OAuth callback URL for a flow in THIS environment, derived
// from the request origin (no new env var). The begin route sends it as
// redirect_uri on authorize; the callback MUST send the byte-identical value on
// the token exchange (GitHub OAuth requires redirect_uri to match when present on
// authorize).
function appUserOAuthCallbackUrl(context: Context<ApiEnv>, flow: AppUserOAuthFlow): string {
  return new URL(`/github/${flow}-callback`, new URL(context.req.url).origin).toString();
}

// The App user-authorization URL the CLI opens. GitHub Apps don't take an OAuth
// `scope` param — the App's permissions govern, and `GET /user` works with any
// user token.
function appUserAuthorizeUrl(
  context: Context<ApiEnv>,
  flow: AppUserOAuthFlow,
  signedState: string,
): string {
  return (
    `https://github.com/login/oauth/authorize?client_id=${context.env.GITHUB_APP_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(appUserOAuthCallbackUrl(context, flow))}` +
    `&state=${encodeURIComponent(signedState)}`
  );
}

/** Read a begin route's `redirect` query, which must be a localhost URL. */
function readLocalhostRedirectQuery(context: Context<ApiEnv>): string | Response {
  const redirect = context.req.query('redirect');
  if (!redirect) {
    return context.json({ error: 'redirect parameter is required' }, 400);
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }
  if (!isLocalhostRedirect(redirectUrl)) {
    return context.json({ error: 'redirect must be a localhost URL' }, 400);
  }
  return redirect;
}

/** Read a begin route's PKCE `code_challenge` query. */
function readCodeChallengeQuery(context: Context<ApiEnv>): string | Response {
  const codeChallenge = context.req.query('code_challenge');
  const codeChallengeMethod = context.req.query('code_challenge_method');
  if (!codeChallenge) {
    return context.json({ error: 'code_challenge is required' }, 400);
  }
  // Method is optional, but if present it MUST be S256 (the only method we
  // verify against at redemption) — mirror the CLI-login PKCE guard.
  if (codeChallengeMethod !== undefined && codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD) {
    return context.json({ error: 'code_challenge_method must be S256' }, 400);
  }
  return codeChallenge;
}

/**
 * Verify a public callback's signed `state` for `purpose`. Trust is established
 * only by that state; there is no session. The redirect is re-validated at use
 * time — it is the only place the minted code is sent, so it must still be a
 * localhost URL even though the begin route already checked it (defense in depth
 * against a forged-but-valid state).
 *
 * A GitHub denial / missing `code` is bounced to the CLI's localhost listener
 * instead of JSON on the API host, which never reaches the listener and would
 * leave the CLI hanging until timeout.
 */
async function verifyCallbackState<T extends LinkState | JoinState | ConnectState>(
  context: Context<ApiEnv>,
  purpose: T['purpose'],
  hasValidFields: (state: T) => boolean = () => true,
): Promise<{ state: T; redirectUrl: URL; code: string } | Response> {
  const code = context.req.query('code');
  const stateParam = context.req.query('state');
  if (!stateParam) {
    return context.json({ error: 'missing state' }, 400);
  }
  const state = await verifyLinkPayload<T>(stateParam, context.env.JWT_SECRET);
  if (
    !state ||
    state.purpose !== purpose ||
    typeof state.exp !== 'number' ||
    Date.now() >= state.exp ||
    typeof state.redirect !== 'string' ||
    typeof state.codeChallenge !== 'string' ||
    !hasValidFields(state)
  ) {
    return context.json({ error: 'invalid state' }, 400);
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(state.redirect);
  } catch {
    return context.json({ error: 'invalid state' }, 400);
  }
  if (!isLocalhostRedirect(redirectUrl)) {
    return context.json({ error: 'invalid state' }, 400);
  }
  if (!code) {
    redirectUrl.searchParams.set('error', context.req.query('error') || 'github_oauth_failed');
    return localhostRedirectResponse(redirectUrl.toString());
  }
  return { state, redirectUrl, code };
}

/**
 * True only when all GitHub App credentials are configured. Env vars are
 * strings (Cloudflare passes everything as strings), so we exact-string check
 * presence. The install/callback routes return 503 when this is false so the
 * feature is inert in environments without the App wired up.
 */
function isGitHubAppConfigured(env: ApiEnv['Bindings']): boolean {
  return (
    typeof env.GITHUB_APP_ID === 'string' &&
    env.GITHUB_APP_ID !== '' &&
    typeof env.GITHUB_APP_PRIVATE_KEY === 'string' &&
    env.GITHUB_APP_PRIVATE_KEY !== ''
  );
}

/**
 * Resolve a repo's immutable numeric id LIVE via `GET /repos/:full_name`,
 * authenticated with the installation token. Used by the connect route for
 * `all`-repos installs, where the cached `repositories` array is irrelevant (it
 * doesn't enumerate every covered repo). Returns `null` on any non-ok response
 * (e.g. 404 for a repo the installation can't see) so the caller fails closed.
 */
async function resolveRepositoryId(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
): Promise<number | null> {
  const token = await getInstallationToken(env, installationId);
  const res = await fetch(`${GITHUB_API_BASE}/repos/${repoFullName}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'void-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { id?: number };
  return typeof data.id === 'number' ? data.id : null;
}

/**
 * The caller's numeric GitHub account id (their `github` OAuth `provider_id`),
 * or `null` when the user has no linked GitHub identity (e.g. signed in via
 * Google only). This is the same value matched against
 * `github_installations.account_id` by `linkGitHubInstallationToUser`, so it is
 * the GitHub-side proof that the caller controls an installation's account.
 */
async function getCallerGitHubAccountId(db: Db, userId: string): Promise<string | null> {
  // Deterministic: pick the earliest-linked github identity. Without an
  // explicit ordering the row chosen by `limit(1)` is arbitrary, so a stray
  // second github row (RFC 0074 enforces one per account, but defends in depth)
  // would sign a nondeterministic account id into install `state`.
  const [row] = await db
    .select({ providerId: oauthAccounts.provider_id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')))
    .orderBy(asc(oauthAccounts.created_at))
    .limit(1);
  return row?.providerId ?? null;
}

/**
 * Derive the installation's account (login/id/type) from a repo owner — every
 * repo in an installation shares the owning account. Returns null when no repo
 * owner is available (e.g. an install with no repositories selected yet); the
 * caller then resolves the account authoritatively via the App JWT
 * (`getInstallationAccount`) rather than fabricating a placeholder id.
 */
function deriveAccountFromRepositories(
  owner: { login?: string; id?: number; type?: string } | undefined,
): { login: string; id: string; type: GitHubInstallation['account_type'] } | null {
  if (owner && typeof owner.login === 'string' && typeof owner.id === 'number') {
    return {
      login: owner.login,
      id: String(owner.id),
      type: owner.type === 'Organization' ? 'Organization' : 'User',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// /github — connect/install flow. Mounted OUTSIDE the global /projects auth, so
// each route applies (or omits) `authMiddleware` explicitly. The OAuth-style
// callback is public and authenticated via the signed HMAC state instead.
// ---------------------------------------------------------------------------
export const githubRoutes = new Hono<ApiEnv>()
  .use('*', capabilityMiddleware('managedBuilds'))

  // Begin a GitHub App install — return the install URL the dashboard opens.
  // State binds the caller's user id, their GitHub account id, and a nonce so
  // the public callback can resolve the user AND verify (against GitHub) that
  // they own the installation, without a session.
  .get('/install-url', authMiddleware, async (context) => {
    const slug = context.env.GITHUB_APP_SLUG;
    if (typeof slug !== 'string' || slug === '') {
      return context.json({ error: 'GitHub App is not configured' }, 503);
    }

    const user = context.get('user');

    // Bind the caller's GitHub account id into the (signed) state. The public
    // callback uses it to prove — against GitHub — that the caller actually
    // owns the installation they are claiming. A user without a linked GitHub
    // identity cannot establish that proof, so they cannot connect.
    const githubAccountId = await getCallerGitHubAccountId(context.get('db'), user.id);
    if (githubAccountId === null) {
      return context.json({ error: 'github_identity_required' }, 403);
    }

    const stateData = JSON.stringify({
      userId: user.id,
      githubAccountId,
      nonce: crypto.randomUUID(),
    });
    const stateEncoded = btoa(stateData);
    const signature = await hmacSignState(stateEncoded, context.env.JWT_SECRET);
    const state = `${stateEncoded}.${signature}`;

    const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
    return context.json({ url });
  })

  // List the caller's linked installations.
  .get('/installations', authMiddleware, async (context) => {
    const user = context.get('user');
    const installations = await getGitHubInstallationsByUser(context.get('db'), user.id);
    // Organization installation visibility proves only that the caller can see
    // the installation, not every repository it covers. Never expose its cached
    // repository list; each repo is disclosed only after the caller proves access
    // with their own OAuth token in the connect-authorize flow. Personal-account
    // owners control the account itself and retain the complete list.
    return context.json(
      installations.map((inst) =>
        inst.account_type === 'User' && inst.user_id === user.id
          ? inst
          : { ...inst, repositories: [] },
      ),
    );
  })

  // -------------------------------------------------------------------------
  // RFC 0074 — authenticated GitHub-identity link flow (deferred bind).
  //
  // A GitHub user authorizing in their browser must end up linked to the Void
  // account that ran the CLI (the bearer-token holder), NOT to a user id baked
  // into the OAuth state. Binding in the public callback to a state-embedded
  // user id would be an account-linking CSRF: an attacker mints a link URL,
  // phishes a victim into authorizing, and the victim's GitHub binds to the
  // attacker. We defeat that by deferring the bind — the public callback only
  // mints a PKCE-bound `link_code` and redirects it to the initiator's
  // localhost; the bind happens in the authenticated `POST /link/complete`
  // keyed on the token-holder. An attacker can only ever link their own
  // identity.
  // -------------------------------------------------------------------------

  // Begin the link flow — return the GitHub App user-authorization URL the CLI
  // opens in the user's browser. The signed state carries the localhost
  // redirect + PKCE challenge and an expiry, but NO Void user id.
  .get('/link-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }

    const redirect = readLocalhostRedirectQuery(context);
    if (redirect instanceof Response) {
      return redirect;
    }
    const codeChallenge = readCodeChallengeQuery(context);
    if (codeChallenge instanceof Response) {
      return codeChallenge;
    }

    const state: LinkState = {
      redirect,
      purpose: 'link',
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    return context.json({ url: appUserAuthorizeUrl(context, 'link', signedState) });
  })

  // Public link callback. GitHub redirects the browser here after the user
  // authorizes. Trust is established via the signed state minted at /link-url;
  // there is no session. This route NEVER binds an identity — it only proves
  // which GitHub account authorized and hands a PKCE-bound `link_code` back to
  // the initiator's localhost.
  .get('/link-callback', async (context) => {
    const verified = await verifyCallbackState<LinkState>(context, 'link');
    if (verified instanceof Response) {
      return verified;
    }
    const { state, redirectUrl, code } = verified;

    // Exchange the App user-OAuth code for the authorizing user's numeric GitHub
    // account id. Pure identity — NO installation. Null on any failure.
    const providerId = await exchangeCodeForUserAccountId(
      context.env,
      code,
      appUserOAuthCallbackUrl(context, 'link'),
    );
    if (providerId === null) {
      // Exchange/identity failure: bounce to the CLI's localhost so the failure
      // surfaces instead of hanging.
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Mint a stateless, PKCE-bound link_code and redirect it to the initiator's
    // localhost. The bind itself is deferred to the authenticated /complete.
    const linkCode: LinkCode = {
      providerId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedLinkCode = await signLinkPayload(linkCode, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('link_code', signedLinkCode);
    // 200 + JS redirect, not 302 — the redirect target is always localhost
    // (validated above via isLocalhostRedirect) and `wrangler dev` mangles
    // `Location: http://localhost:*` headers (see html-redirect.ts / meta/lessons.md),
    // which would otherwise drop the link_code and stall local `void github link`.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  // Complete the link — the ONLY place an identity is bound. Authenticated:
  // the bind is keyed on the bearer-token holder (`context.get('user').id`),
  // never on anything carried in the link flow. Requires a valid PKCE verifier
  // matching the link_code's challenge, so only the initiator (who minted the
  // challenge) can redeem the code.
  .post('/link/complete', authMiddleware, async (context) => {
    const body = await context.req
      .json<{ link_code?: unknown; code_verifier?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.link_code !== 'string' || typeof body.code_verifier !== 'string') {
      return context.json({ error: 'link_code and code_verifier are required' }, 400);
    }

    const linkCode = await verifyLinkPayload<LinkCode>(body.link_code, context.env.JWT_SECRET);
    if (!linkCode || typeof linkCode.providerId !== 'string') {
      return context.json({ error: 'invalid link_code' }, 400);
    }
    if (typeof linkCode.exp !== 'number' || Date.now() >= linkCode.exp) {
      return context.json({ error: 'invalid link_code' }, 400);
    }

    // PKCE: the verifier must be well-formed AND its S256 challenge must equal
    // the one bound into the link_code. The method must be S256.
    if (
      linkCode.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
      !isValidCodeVerifier(body.code_verifier) ||
      (await createCodeChallenge(body.code_verifier)) !== linkCode.codeChallenge
    ) {
      return context.json({ error: 'invalid_verifier' }, 400);
    }

    const user = context.get('user');
    try {
      const result = await linkGitHubIdentity(context.get('db'), user.id, linkCode.providerId);

      // Backfill GitHub App installations created before this user linked their
      // github identity — same best-effort claim the login callback runs
      // (auth.ts). `providerId` is matched against `github_installations.account_id`.
      // Best-effort: a backfill failure must NEVER fail the link.
      try {
        await linkGitHubInstallationToUser(context.get('db'), linkCode.providerId, user.id);
      } catch (err) {
        console.error(`[github-link] Failed to backfill installations for ${user.id}:`, err);
      }

      return context.json({ status: result });
    } catch (error) {
      if (error instanceof GitHubIdentityAlreadyLinkedError) {
        return context.json({ error: 'github_already_linked' }, 409);
      }
      if (error instanceof GitHubIdentityConflictError) {
        return context.json({ error: 'github_identity_conflict' }, 409);
      }
      throw error;
    }
  })

  // -------------------------------------------------------------------------
  // Org-shared installs — JOIN flow (deferred bind, cloned from the RFC 0074
  // link flow above). Lets a Void user who is an org co-member gain access to
  // the installations they can already manage on GitHub, WITHOUT re-owning them
  // and WITHOUT a stored GitHub token. Discovery DX: the caller names nothing —
  // the callback lists every installation their user token can reach, keeps the
  // subset Void already tracks, and the authenticated /join/complete records a
  // TTL-cached membership per install, keyed on the bearer-token holder (Threat
  // L1). Access is re-verified per-repo at connect time; this only caches the
  // org co-membership fact.
  // -------------------------------------------------------------------------

  // Begin the JOIN flow — return the GitHub App user-authorization URL the CLI
  // opens in the member's browser. The signed state carries the localhost
  // redirect + PKCE challenge and an expiry, but NO Void user id.
  .get('/join-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }

    const redirect = readLocalhostRedirectQuery(context);
    if (redirect instanceof Response) {
      return redirect;
    }
    const codeChallenge = readCodeChallengeQuery(context);
    if (codeChallenge instanceof Response) {
      return codeChallenge;
    }

    const state: JoinState = {
      redirect,
      purpose: 'join',
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    return context.json({ url: appUserAuthorizeUrl(context, 'join', signedState) });
  })

  // Public join callback. GitHub redirects the browser here after the member
  // authorizes. Trust is the signed state minted at /join-url; there is no
  // session. This route NEVER binds a membership — it lists the installations
  // the caller can access, intersects them with the ones Void tracks, and hands
  // a PKCE-bound `join_code` back to the initiator's localhost.
  .get('/join-callback', async (context) => {
    const verified = await verifyCallbackState<JoinState>(context, 'join');
    if (verified instanceof Response) {
      return verified;
    }
    const { state, redirectUrl, code } = verified;

    const db = context.get('db');
    // Stamp the proof-of-access moment BEFORE the GitHub proof so `iat` is a
    // CONSERVATIVE lower bound: any org removal recorded at/after this proof has
    // revoked_at >= iat, so the artifact is rejected even if GitHub's access
    // propagation lag briefly let the proof still succeed. DB-clock, to
    // match the DB-clock revocation tombstone.
    const proofIatMs = await getDbNowMs(db);

    // Discover — via the caller's transient user token — every installation they
    // can manage (`GET /user/installations`) plus their GitHub account id. The
    // token is used only for this read and never persisted. An empty set means
    // the exchange failed OR the caller manages no installations: nothing to
    // join, so bounce to the CLI's localhost.
    const { installationIds, callerAccountId } = await listAuthorizedInstallationIds(
      context.env,
      code,
      appUserOAuthCallbackUrl(context, 'join'),
    );
    if (installationIds.size === 0) {
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }
    if (callerAccountId === null) {
      // GET /user/installations succeeded but GET /user did not — we cannot attribute
      // a membership to a durable GitHub account id. Fail closed (a null-account
      // membership is unattributable, so member_removed's proof-id sever can never
      // match it). Symmetric with the connect-authorize null-callerAccountId refusal.
      // The caller can retry once GitHub's /user read recovers.
      redirectUrl.searchParams.set('error', 'github_oauth_failed');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Intersect the accessible installations with the ones Void actually tracks
    // AND that are Organization accounts. A membership row keys on a numeric
    // installation id (FK-less), so we must only ever mint join codes for installs
    // we know — probe getGitHubInstallation per id and keep the ones that exist. An
    // id the caller cannot reach is never in `installationIds`, so it can never
    // become eligible.
    const eligible: Array<string> = [];
    for (const installationId of installationIds) {
      const install = await getGitHubInstallation(db, installationId);
      // Org-shared sharing is Organization-only: personal (account_type='User')
      // installs have no member_removed revocation path, so they must never become
      // join targets. A user only ever OWNS their personal install (they connect it
      // directly, no JOIN).
      if (install !== null && install.account_type === 'Organization') {
        eligible.push(installationId);
      }
    }

    // Mint a stateless, PKCE-bound join_code carrying the eligible NUMERIC
    // installation ids + the caller's github account id, and redirect it to the
    // initiator's localhost. The membership bind is deferred to /join/complete.
    const joinCode: JoinCode = {
      purpose: 'join',
      installationIds: eligible,
      githubAccountId: callerAccountId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      // Stamp the proof-of-access moment so /join/complete can compare it to the
      // revocation tombstone (monotonic revocation). Sampled PRE-proof
      // (above) as a conservative lower bound. `iat` is DB-clock (compared to the
      // DB-clock `revoked_at` tombstone — one clock domain); `exp` is Worker-clock
      // (compared to Worker `Date.now()` at redemption).
      iat: proofIatMs,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedJoinCode = await signLinkPayload(joinCode, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('join_code', signedJoinCode);
    // 200 + JS redirect, not 302 — the target is always localhost (validated
    // above) and `wrangler dev` mangles `Location: http://localhost:*` headers.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  // Complete the JOIN — the ONLY place a membership is bound. Authenticated: the
  // bind is keyed on the bearer-token holder (`context.get('user').id`), NEVER on
  // anything carried in the join flow (Threat L1). Requires a valid PKCE verifier
  // matching the join_code's challenge, so only the initiator (who minted the
  // challenge) can redeem the code.
  .post('/join/complete', authMiddleware, async (context) => {
    // Fail closed: JOIN is an org-share flow gated on App user OAuth. Reject a
    // pre-minted join_code redemption too when the config was removed, so the
    // config is a true kill switch — the begin route (/join-url) already 503s.
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }
    const body = await context.req
      .json<{ join_code?: unknown; code_verifier?: unknown }>()
      .catch(() => null);
    if (!body || typeof body.join_code !== 'string' || typeof body.code_verifier !== 'string') {
      return context.json({ error: 'join_code and code_verifier are required' }, 400);
    }

    const joinCode = await verifyLinkPayload<JoinCode>(body.join_code, context.env.JWT_SECRET);
    if (
      !joinCode ||
      joinCode.purpose !== 'join' ||
      !Array.isArray(joinCode.installationIds) ||
      typeof joinCode.githubAccountId !== 'string' ||
      joinCode.githubAccountId === ''
    ) {
      return context.json({ error: 'invalid join_code' }, 400);
    }
    if (
      typeof joinCode.exp !== 'number' ||
      Date.now() >= joinCode.exp ||
      typeof joinCode.iat !== 'number'
    ) {
      return context.json({ error: 'invalid join_code' }, 400);
    }

    // PKCE: the verifier must be well-formed AND its S256 challenge must equal
    // the one bound into the join_code. The method must be S256.
    if (
      joinCode.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
      !isValidCodeVerifier(body.code_verifier) ||
      (await createCodeChallenge(body.code_verifier)) !== joinCode.codeChallenge
    ) {
      return context.json({ error: 'invalid_verifier' }, 400);
    }

    const db = context.get('db');
    const user = context.get('user');
    const count = await db.transaction(async (tx) => {
      // Lock the target install rows FIRST (sorted, install-first — the global
      // order shared by member_removed + the connect gate) so a concurrent
      // member_removed is serialized: its delete + tombstone is committed and
      // visible before we read the tombstones and upsert, so we never resurrect a
      // membership it just revoked. Install-only locking (no connections) →
      // it cannot deadlock with member_removed / teardown / the connect gate.
      for (const installationId of [...joinCode.installationIds].sort()) {
        await tx
          .select({ id: githubInstallations.id })
          .from(githubInstallations)
          .where(eq(githubInstallations.installation_id, installationId))
          .for('update');
      }
      // Monotonic revocation: batch-load the per-install
      // revocation tombstones for the join_code's GITHUB ACCOUNT id (X) — the
      // durable identity carried in the artifact, which `member_removed` always
      // tombstones from the webhook payload even when no Void user existed yet.
      // A join_code minted AT OR BEFORE a revocation (iat <= revoked_at) is a
      // stale artifact a removed member is replaying — its installs are skipped
      // below so membership is never resurrected. Under the install-row lock
      // above this is race-safe, not merely best-effort; the connect route's
      // in-tx recheck remains the deploy gate.
      const revocations = await getInstallationRevocationsForAccount(
        tx,
        joinCode.installationIds,
        joinCode.githubAccountId,
      );
      let c = 0;
      for (const installationId of joinCode.installationIds) {
        // Re-check the install still exists (fail-soft skip if it was removed
        // between callback and complete — a membership row keys on this numeric id).
        const install = await getGitHubInstallation(tx, installationId);
        if (install === null) {
          continue;
        }
        // The signed join_code lists only Organization installs (the callback's
        // eligibility gate), and GitHub never converts an organization back into a
        // personal account, so every install here is an organization install with
        // no owner. The installer joins like any other member.
        //
        // Skip installs whose join_code predates a revocation (stale replay). A
        // legit re-join AFTER re-add mints a fresh join_code with iat > revoked_at,
        // which is NOT skipped (the tombstone is a high-water mark, not a ban).
        const revokedAtMs = revocations.get(installationId);
        if (revokedAtMs !== undefined && revokedAtMs >= joinCode.iat) {
          continue;
        }
        // Threat L1: keyed on the AUTHENTICATED bearer-token holder, never on the
        // github account id carried in the join_code (that is stored only as the
        // membership's verified-against metadata).
        await upsertGitHubInstallationMember(tx, {
          installationId,
          userId: user.id,
          githubAccountId: joinCode.githubAccountId,
          ttlSeconds: MEMBERSHIP_TTL_SECONDS,
        });
        c += 1;
      }
      return c;
    });

    return context.json({ status: 'joined', count });
  })

  // -------------------------------------------------------------------------
  // Org-shared installs — CONNECT-AUTHORIZE flow (deferred bind, cloned from the
  // JOIN flow above). Before a non-owner org member connects a project to a repo
  // in a shared installation, they must prove — under their OWN GitHub token —
  // that they can personally reach that specific repo through that installation.
  // Possessing a shared installation id is not enough (per-repo confused-deputy
  // close, RFC 0074 §"Threat L1"). This mints a PKCE-bound `connect_grant`; the
  // grant is REDEEMED at the authenticated connect route.
  // -------------------------------------------------------------------------

  // Begin the CONNECT-AUTHORIZE flow — return the GitHub App user-authorization
  // URL the CLI opens in the member's browser. The signed state names the exact
  // installationId + repoFullName the CLI already knows, plus the localhost
  // redirect + PKCE challenge and an expiry, but NO Void user id.
  .get('/connect-authorize-url', authMiddleware, async (context) => {
    if (!isAppUserOAuthConfigured(context.env)) {
      return context.json(APP_USER_OAUTH_NOT_CONFIGURED, 503);
    }

    const redirect = readLocalhostRedirectQuery(context);
    if (redirect instanceof Response) {
      return redirect;
    }
    const installationId = context.req.query('installationId');
    const repoFullName = context.req.query('repoFullName');
    if (!installationId) {
      return context.json({ error: 'installationId is required' }, 400);
    }
    if (!repoFullName) {
      return context.json({ error: 'repoFullName is required' }, 400);
    }
    const codeChallenge = readCodeChallengeQuery(context);
    if (codeChallenge instanceof Response) {
      return codeChallenge;
    }

    // NO ownership/membership pre-check here — this route only kicks off the
    // per-repo authorize round-trip. The real gate is the per-repo verify in the
    // callback plus the membership/ownership checks at redemption.
    const state: ConnectState = {
      redirect,
      purpose: 'connect',
      installationId,
      repoFullName,
      codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      exp: Date.now() + LINK_STATE_TTL_MS,
    };
    const signedState = await signLinkPayload(state, context.env.JWT_SECRET);

    return context.json({ url: appUserAuthorizeUrl(context, 'connect-authorize', signedState) });
  })

  // Public connect-authorize callback. GitHub redirects the browser here after
  // the member authorizes. Trust is the signed state minted at
  // /connect-authorize-url; there is no session. This route NEVER binds anything
  // (it has no bearer identity) — it re-proves per-repo access under the caller's
  // own token and, on success, hands a PKCE-bound `connect_grant` back to the
  // initiator's localhost for the authenticated redemption to consume.
  .get('/connect-authorize-callback', async (context) => {
    const verified = await verifyCallbackState<ConnectState>(
      context,
      'connect',
      (state) => typeof state.installationId === 'string' && typeof state.repoFullName === 'string',
    );
    if (verified instanceof Response) {
      return verified;
    }
    const { state, redirectUrl, code } = verified;

    // Stamp the proof-of-access moment BEFORE the GitHub proof so `iat` is a
    // CONSERVATIVE lower bound: any org removal recorded at/after this proof has
    // revoked_at >= iat, so the grant is rejected even if GitHub's access
    // propagation lag briefly let the proof still succeed. DB-clock, to
    // match the DB-clock revocation tombstone.
    const proofIatMs = await getDbNowMs(context.get('db'));

    // Per-repo trust boundary: verify — under the CONNECTING user's own transient
    // token — that they can personally reach this repo through this installation.
    // The redirect_uri MUST be byte-identical to the one /connect-authorize-url
    // sent on authorize (GitHub rejects a mismatched exchange redirect_uri).
    const { repositoryId, callerAccountId } = await verifyUserRepoAccess(
      context.env,
      code,
      state.installationId,
      state.repoFullName,
      appUserOAuthCallbackUrl(context, 'connect-authorize'),
    );

    // CONFUSED-DEPUTY CLOSE: a null repositoryId means the caller cannot reach
    // this repo through the install; a null callerAccountId means the exchange
    // failed / yielded no identity. Either way we cannot safely bind — mint NO
    // grant and bounce the refusal to the CLI's localhost.
    if (repositoryId === null || callerAccountId === null) {
      redirectUrl.searchParams.set('error', 'repo_not_accessible');
      return localhostRedirectResponse(redirectUrl.toString());
    }

    // Mint a stateless, PKCE-bound connect_grant carrying the resolved numeric
    // repositoryId + the connecting user's github account id, and redirect it to
    // the initiator's localhost. This PUBLIC callback has NO bearer identity, so
    // it writes NO membership row — the connection bind is deferred to the
    // authenticated redemption, keyed on the bearer-token holder.
    const grant: ConnectGrant = {
      purpose: 'connect',
      installationId: state.installationId,
      repoFullName: state.repoFullName,
      repositoryId,
      githubAccountId: callerAccountId,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: CLI_CODE_CHALLENGE_METHOD,
      // Stamp the proof-of-access moment so the connect gate can compare it to the
      // revocation tombstone (monotonic revocation). Sampled PRE-proof
      // (above) as a conservative lower bound. `iat` is DB-clock (compared to the
      // DB-clock `revoked_at` tombstone — one clock domain); `exp` is Worker-clock
      // (compared to Worker `Date.now()` at redemption).
      iat: proofIatMs,
      exp: Date.now() + LINK_CODE_TTL_MS,
    };
    const signedGrant = await signLinkPayload(grant, context.env.JWT_SECRET);

    redirectUrl.searchParams.set('connect_grant', signedGrant);
    // 200 + JS redirect, not 302 — the target is always localhost (validated
    // above) and `wrangler dev` mangles `Location: http://localhost:*` headers.
    return localhostRedirectResponse(redirectUrl.toString());
  })

  // Public install callback. GitHub redirects the browser here after the user
  // completes (or cancels) an install. Trust is established via the signed
  // state minted by `/install-url`; there is no session cookie.
  .get('/callback', async (context) => {
    if (!isGitHubAppConfigured(context.env)) {
      return context.json({ error: 'GitHub App is not configured' }, 503);
    }

    const installationId = context.req.query('installation_id');
    const state = context.req.query('state');
    // Present only when the App has "Request user authorization (OAuth) during
    // installation" enabled. Used to authorize org installs (see below).
    const code = context.req.query('code');

    if (!state) {
      return context.json({ error: 'missing state' }, 400);
    }

    // Verify the state HMAC (same scheme as auth.ts).
    const dotIndex = state.lastIndexOf('.');
    if (dotIndex === -1) {
      return context.json({ error: 'invalid state' }, 400);
    }
    const stateEncoded = state.slice(0, dotIndex);
    const signature = state.slice(dotIndex + 1);
    const valid = await hmacVerifyState(stateEncoded, signature, context.env.JWT_SECRET);
    if (!valid) {
      return context.json({ error: 'invalid state signature' }, 400);
    }

    let userId: string;
    let stateGitHubAccountId: string;
    try {
      const parsed = JSON.parse(atob(stateEncoded)) as {
        userId?: unknown;
        githubAccountId?: unknown;
      };
      if (typeof parsed.userId !== 'string' || parsed.userId === '') {
        return context.json({ error: 'invalid state' }, 400);
      }
      // A state without `githubAccountId` cannot prove ownership; reject it
      // rather than binding unverifiably.
      if (typeof parsed.githubAccountId !== 'string' || parsed.githubAccountId === '') {
        return context.json({ error: 'invalid state' }, 400);
      }
      userId = parsed.userId;
      stateGitHubAccountId = parsed.githubAccountId;
    } catch {
      return context.json({ error: 'invalid state' }, 400);
    }

    // `setup_action` is `'install'` on a fresh install, `'update'` when the
    // user edits repo selection. Either way `installation_id` must be present;
    // its absence means the user cancelled.
    if (!installationId) {
      return context.json({ error: 'missing installation_id' }, 400);
    }

    // Mint an installation token and read the installation's repositories. The
    // installation token does NOT authorize `GET /app/installations/:id` (that
    // needs the App JWT), so account metadata is derived from a repo owner —
    // every repo in an installation shares the owning account.
    const token = await getInstallationToken(context.env, installationId);
    const { repositories, owner, repositorySelection } = await listInstallationRepositories(token);
    // Fast path: derive the owning account from a repo owner (every repo in an
    // installation shares it). When the installation has NO repositories yet,
    // there is no owner to derive from — resolve the account AUTHORITATIVELY via
    // the App JWT (`GET /app/installations/:id`) instead of fabricating an id. A
    // failed lookup fails closed (502): persisting/checking a fabricated id would
    // wrongly reject a valid empty install and store a garbage account_id that
    // later breaks the sign-in backfill and the OIDC owner-guard.
    let account = deriveAccountFromRepositories(owner);
    if (account === null) {
      const resolved = await getInstallationAccount(context.env, installationId);
      if (resolved === null) {
        return context.json({ error: 'unable to resolve installation account' }, 502);
      }
      account = { login: resolved.login, id: resolved.accountId, type: resolved.type };
    }

    // Installation visibility check. Two paths, in order:
    //
    // 1. User-authorization-on-install (preferred; supports BOTH personal and
    //    org installs). When the App has "Request user authorization (OAuth)
    //    during installation" enabled, GitHub appends a `code` to this
    //    callback. We exchange it for a transient USER-to-server token and
    //    confirm `installation_id` is in the user's visible installations
    //    (`GET /user/installations`). For an organization this proves only that
    //    the caller may join the installation; repository authority is proven
    //    later with the caller's token. The token is transient and discarded.
    //
    // 2. Personal account-id match (fallback; personal installs only). When no
    //    `code` is present (App not configured for user-auth-on-install), the
    //    installation's GitHub account must equal the personal GitHub id bound
    //    into the signed state at /install-url. Org installs without a code
    //    still 403 here — the safe default. Enabling org support is an
    //    ops/config item: turn on user-auth-on-install on the GitHub App and
    //    set GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET.
    //
    // Either way, a valid state alone never grants repository authority.
    //
    // Stamp the proof-of-access moment BEFORE the USER-access proof
    // (`authorizeInstallViaUserToken`) so `proofIatMs` is a CONSERVATIVE lower
    // bound for the revocation-tombstone gates below (mirrors the connect gate).
    // The `getInstallationToken` / `listInstallationRepositories`
    // calls above prove the install EXISTS, not the USER's access — the user
    // proof is `authorizeInstallViaUserToken`, so that is the access-proof
    // moment for revocation. DB-clock (matches the DB-clock `revoked_at`
    // tombstone written by `member_removed`).
    //
    // Accepted residual (concurrent variant is closed below): the LIVE
    // user-token proof is the PRIMARY boundary. A removed org member who
    // re-authorizes fully WITHIN GitHub's access-propagation lag mints a proof
    // whose `iat` is AFTER `revoked_at`, so a tombstone check cannot reject it
    // (iat cannot tell a lag-re-auth from a legitimate re-add — both mint
    // iat > revoked_at). That durable variant is lag-bounded and self-corrects
    // once GitHub propagates the removal (the proof then fails), matching the
    // container/OIDC best-effort boundaries. The install-row lock + tombstone
    // gates below close ONLY the CONCURRENT interleaving (this proof succeeds,
    // THEN `member_removed` commits its clear+tombstone, THEN this grant
    // commits) — there the tombstone's `revoked_at >= proofIatMs`, so it is
    // rejected. Do NOT add a tombstone check to the owner CONNECT path (it would
    // break legitimately re-added owners), and do NOT try to close the durable
    // variant with iat.
    const proofIatMs = await getDbNowMs(context.get('db'));
    const authResult =
      typeof code === 'string' && code !== ''
        ? await authorizeInstallViaUserToken(context.env, code, installationId)
        : { authorized: false, callerAccountId: null };

    if (authResult.authorized) {
      // Token path: the person who completed the OAuth code must BE the user who
      // initiated the install (whose GitHub account id is in the signed state).
      // This still allows org installs — the state encodes the INITIATOR's
      // account id, not the org's, and the user-token path already proved they
      // can access the org installation.
      if (
        authResult.callerAccountId === null ||
        authResult.callerAccountId !== stateGitHubAccountId
      ) {
        return context.json({ error: 'installation does not belong to the caller' }, 403);
      }
    } else if (account.id !== stateGitHubAccountId) {
      // Fallback path (no usable code / app-user OAuth not configured): require
      // the installation's own account to match the caller's stored GitHub
      // account id.
      return context.json({ error: 'installation does not belong to the caller' }, 403);
    }

    // Visibility + tombstone gates under an INSTALL-row lock. member_removed and
    // the connect gate lock the SAME install row install-first, so a concurrent
    // revocation and this callback are serialized: whichever commits second sees
    // the other's effect. This closes the CONCURRENT interleaving (this
    // proof succeeds, then member_removed clears+tombstones, then this grant
    // commits) before an organization membership is recorded. Install-only
    // locking (no connections) → install-first → cannot deadlock with
    // member_removed / teardown / the connect gate. The durable variant remains
    // a live-proof-bounded residual (see above).
    const result = await context.get('db').transaction(async (tx) => {
      // Lock the install row FIRST. A fresh installation id locks nothing and
      // proceeds to the personal-owner insert or organization-member insert.
      await tx
        .select({ id: githubInstallations.id })
        .from(githubInstallations)
        .where(eq(githubInstallations.installation_id, installationId))
        .for('update');

      const existing = await getGitHubInstallation(tx, installationId);
      // Organization installs have no owner, and installation visibility never
      // confers repository authority. Record every org participant, including
      // the person who completed a fresh installation, as a TTL membership. The
      // project connect gate consequently requires a fresh per-repo OAuth grant
      // for every organization path.
      if (account.type === 'Organization') {
        if (!authResult.authorized || authResult.callerAccountId === null) {
          return { kind: 'conflict' as const };
        }
        const revokedAtMs = await getInstallationRevocationAt(
          tx,
          installationId,
          authResult.callerAccountId,
        );
        if (revokedAtMs !== null && revokedAtMs >= proofIatMs) {
          return { kind: 'revoked' as const };
        }
        await upsertGitHubInstallation(tx, {
          installationId,
          userId: null,
          accountLogin: account.login,
          accountId: account.id,
          accountType: account.type,
          repositories,
          repositorySelection,
          refreshMembership: true,
        });
        await upsertGitHubInstallationMember(tx, {
          installationId,
          userId,
          githubAccountId: authResult.callerAccountId,
          ttlSeconds: MEMBERSHIP_TTL_SECONDS,
        });
        return { kind: 'member' as const };
      }

      // Personal installations are not shareable. A different linked user is
      // an account collision; the matching personal GitHub identity may adopt a
      // fresh/null row or refresh its own existing row.
      if (existing && existing.user_id !== null && existing.user_id !== userId) {
        return { kind: 'conflict' as const };
      }

      // Personal owner (re-)adopt. Key the concurrency tombstone check on the
      // owner's proven GitHub id. Organization installs returned above, so this
      // branch cannot turn organization visibility into ownership.
      const ownerRevokedAtMs = await getInstallationRevocationAt(
        tx,
        installationId,
        stateGitHubAccountId,
      );
      if (ownerRevokedAtMs !== null && ownerRevokedAtMs >= proofIatMs) {
        return { kind: 'revoked' as const };
      }
      await upsertGitHubInstallation(tx, {
        installationId,
        userId,
        accountLogin: account.login,
        accountId: account.id,
        accountType: account.type,
        repositories,
        // Record GitHub's `repository_selection` so an `all`-repos install is
        // recognized without waiting for a webhook to flip it. The webhook
        // `installation` handler keeps it in sync afterward.
        repositorySelection,
        // We just refetched the LIVE membership via `listInstallationRepositories`,
        // so on reconnect / `setup_action=update` (existing row = conflict path)
        // this data is authoritative and must roll the cache forward. Without
        // this, newly-added repos or a widen-to-`all` stay rejected by the
        // connect/push/OIDC resolvers until the next webhook arrives.
        refreshMembership: true,
      });
      return { kind: 'owner' as const };
    });

    if (result.kind === 'conflict') {
      return context.json({ error: 'installation already linked to another user' }, 403);
    }
    if (result.kind === 'revoked') {
      return context.json({ error: 'installation access revoked' }, 403);
    }
    // Redirect to the dashboard connections page (personal owner and organization
    // member flows share the same target). Prod DASHBOARD_URL is https, so the
    // wrangler localhost-redirect mangling (see lessons.md) does not apply here.
    const dashboardUrl = context.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
    return context.redirect(`${dashboardUrl}/settings/connections`);
  });

// The OIDC exchange (`routes/auth-oidc.ts`) binds a deploy token to the
// workflow file at the connection's `workflow_path`. GitHub only runs workflows
// under `.github/workflows/`, so a path outside it (or one with `..`) can never
// match a real OIDC `workflow_ref` — reject it here at the settings-authorized
// setter for a clear error, rather than a silently-never-authorized deploy.
function isValidWorkflowPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith('.github/workflows/') &&
    (path.endsWith('.yml') || path.endsWith('.yaml')) &&
    !path.includes('..')
  );
}

// ---------------------------------------------------------------------------
// /projects — per-project connection CRUD. Mounted UNDER the global
// `app.use('/projects/*', authMiddleware)`, so auth is already applied; each
// route checks the required live project capability.
// ---------------------------------------------------------------------------
export const githubProjectRoutes = new Hono<ApiEnv>()
  // Other routers share /projects, so this gate must only cover GitHub connections.
  .use('/:id/github', capabilityMiddleware('managedBuilds'))

  // Connect a project to a repo within one of the caller's installations.
  .post('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    const body = await context.req.json<{
      installationId?: unknown;
      repoFullName?: unknown;
      branch?: unknown;
      buildExecutor?: unknown;
      workflowPath?: unknown;
      connectGrant?: unknown;
      codeVerifier?: unknown;
    }>();

    if (typeof body.installationId !== 'string' || body.installationId === '') {
      return context.json({ error: 'installationId is required' }, 400);
    }
    if (typeof body.repoFullName !== 'string' || body.repoFullName === '') {
      return context.json({ error: 'repoFullName is required' }, 400);
    }
    if (
      body.buildExecutor !== undefined &&
      body.buildExecutor !== 'container' &&
      body.buildExecutor !== 'github_actions'
    ) {
      return context.json({ error: 'invalid buildExecutor' }, 400);
    }
    if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch === '')) {
      return context.json({ error: 'invalid branch' }, 400);
    }
    if (
      body.workflowPath !== undefined &&
      (typeof body.workflowPath !== 'string' || !isValidWorkflowPath(body.workflowPath))
    ) {
      return context.json({ error: 'invalid workflowPath' }, 400);
    }

    const installation = await getGitHubInstallation(context.get('db'), body.installationId);
    if (!installation) {
      return context.json({ error: 'installation not found' }, 404);
    }
    const caller = context.get('user').id;
    const isOwner = installation.account_type === 'User' && installation.user_id === caller;

    // A personal-account owner passes through directly. Every organization
    // participant must be an ACTIVE MEMBER of the shared install; if not, we
    // return the SAME opaque 404 the owner-miss returns — never reveal the
    // install exists to a non-member (privacy). Membership is TTL-honored.
    if (!isOwner) {
      // These two 404 gates run BEFORE the OAuth kill-switch 503 below so that a
      // non-member is indistinguishable from a nonexistent install even when App
      // user OAuth is unconfigured (reaching a 503 rather than a 404 would leak
      // that the install exists, since the missing-install 404 above already
      // filtered nonexistent ids).
      const isMember = await hasActiveInstallationMembership(
        context.get('db'),
        body.installationId,
        caller,
      );
      if (!isMember) {
        return context.json({ error: 'installation not found' }, 404);
      }
      // Org-share connect is Organization-only. Memberships are only ever written for
      // organization installs; this gate keeps a personal install unreachable through
      // membership even if one existed, with the SAME opaque 404 (never reveal the
      // install exists / its type to a non-member). GitHub never converts an
      // organization back into a personal account, so the pre-lock row is
      // authoritative (no locked re-read).
      if (installation.account_type !== 'Organization') {
        return context.json({ error: 'installation not found' }, 404);
      }
      // Fail closed: the organization connect path depends on App user OAuth (the membership +
      // connect_grant were minted via it). Reject a pre-minted connect_grant redemption when
      // the config was removed. This runs LAST — only a caller ALREADY proven to be an
      // active member of an Organization install reaches it, so the 503 does not
      // distinguish an existing install from a nonexistent one. Personal-account owners
      // connect directly and skip this block.
      if (!isAppUserOAuthConfigured(context.env)) {
        return context.json(
          {
            error: 'github_oauth_not_configured',
            message: 'GitHub App user OAuth is not configured',
          },
          503,
        );
      }
    }

    // Reachable only by a personal owner or an authorized organization member.
    // A suspended/deleted install can still carry cached repos, but every build
    // resolver requires status='active', so connecting it would produce a
    // connection that never builds.
    if (installation.status !== 'active') {
      return context.json({ error: 'installation is not active' }, 409);
    }

    // Resolve the repo's immutable numeric id. `repo_full_name` is mutable
    // (rename/delete/name-reuse), so webhook + OIDC routing keys on this id
    // instead. Resolution DIVERGES by path:
    //
    //   PERSONAL OWNER → resolve with the INSTALLATION token. Keyed off
    //     `repository_selection`:
    //       - `all`: the install covers every repo in the account (including
    //         ones created after install), so the cached `repositories` array
    //         doesn't enumerate them. Resolve the id LIVE via
    //         `GET /repos/:full_name`; a non-ok response fails closed with 400.
    //       - `selected`: the cached set is authoritative — look up by name.
    //         Still 400s when absent.
    //   ORGANIZATION PARTICIPANT → installation visibility is not repository
    //     authority, so trusting the installation token here would be a
    //     confused-deputy. Instead we require a per-repo
    //     `connect_grant` minted by /github/connect-authorize-callback,
    //     which carries a `repositoryId` the member PROVED under their OWN token.
    //     We trust that id and SKIP the installation-token resolution entirely.
    // The organization grant's proof-of-access moment, captured here so the
    // go-live transaction below can compare it to the install's revocation
    // tombstone under the row lock. `undefined` on the owner path (no grant).
    let memberGrantIat: number | undefined;
    // The member grant's GITHUB ACCOUNT id (X) — the tombstone key. The
    // revocation tombstone is keyed on this durable identity, not the Void user
    // id, so a pre-removal grant replay is caught even after the member re-links.
    // `undefined` on the owner path (no grant → the tombstone check is skipped).
    let memberGrantAccountId: string | undefined;
    let repositoryId: number;
    if (isOwner) {
      if (installation.repository_selection === 'all') {
        const resolvedId = await resolveRepositoryId(
          context.env,
          body.installationId,
          body.repoFullName,
        );
        if (resolvedId === null) {
          return context.json({ error: 'repository not accessible by installation' }, 400);
        }
        repositoryId = resolvedId;
      } else {
        const matchedRepo = installation.repositories.find(
          (repo) => repo.full_name === body.repoFullName,
        );
        if (!matchedRepo) {
          return context.json({ error: 'repository not accessible by installation' }, 400);
        }
        repositoryId = matchedRepo.id;
      }
    } else {
      // Member path — require + verify the grant. A member with no grant is told
      // (via the FROZEN stable code the CLI catches) to run the authorize
      // round-trip; every other verification failure is a hard 'invalid connect
      // grant' the CLI does NOT loop on.
      if (typeof body.connectGrant !== 'string' || typeof body.codeVerifier !== 'string') {
        return context.json({ error: 'connect_authorization_required' }, 403);
      }
      const grant = await verifyLinkPayload<ConnectGrant>(
        body.connectGrant,
        context.env.JWT_SECRET,
      );
      if (
        !grant ||
        grant.purpose !== 'connect' ||
        typeof grant.exp !== 'number' ||
        Date.now() >= grant.exp ||
        typeof grant.iat !== 'number' ||
        grant.installationId !== body.installationId ||
        grant.repoFullName !== body.repoFullName
      ) {
        return context.json({ error: 'invalid connect grant' }, 403);
      }
      // PKCE: the presented verifier must hash (S256) to the challenge the grant
      // was minted with — proves the redeemer is the one who initiated authorize.
      if (
        grant.codeChallengeMethod !== CLI_CODE_CHALLENGE_METHOD ||
        !isValidCodeVerifier(body.codeVerifier) ||
        (await createCodeChallenge(body.codeVerifier)) !== grant.codeChallenge
      ) {
        return context.json({ error: 'invalid connect grant' }, 403);
      }
      // Threat L1: the GitHub identity that PROVED per-repo access
      // (grant.githubAccountId) must equal the redeeming bearer's OWN linked
      // GitHub id. Closes "A initiates, B authorizes in the browser, A redeems
      // B's proof" — A's linked id != B's grant id.
      const callerGithubId = await getGitHubAccountIdForUser(context.get('db'), caller);
      if (callerGithubId === null || callerGithubId !== grant.githubAccountId) {
        return context.json({ error: 'invalid connect grant' }, 403);
      }
      // Trust the id the connecting user proved with their OWN token; the
      // installation-token resolution is SKIPPED — this is the confused-deputy
      // close, so we do NOT double-check it against the install token.
      repositoryId = grant.repositoryId;
      memberGrantIat = grant.iat;
      // The tombstone is keyed by the GitHub account id (X) the grant carries —
      // the durable identity `member_removed` always tombstones. By Threat-L1
      // above this equals the caller's OWN linked id.
      memberGrantAccountId = grant.githubAccountId;
    }

    // Capture the validated body fields as consts: TS control-flow narrowing on
    // `body.<field>` (validated at the top of this handler) is NOT preserved into
    // the transaction closure below, so referencing `body.*` there re-widens to
    // `unknown`.
    const installationId = body.installationId;
    const repoFullName = body.repoFullName;
    const branch = body.branch;
    const buildExecutor = body.buildExecutor;
    const workflowPath = body.workflowPath;

    // Go-live under the installation-row lock. member_removed AND the
    // teardown handlers (installation.deleted/suspend → status inactive;
    // installation_repositories removed → drop repo from the cached set) all lock
    // the SAME install row install-first, so this connect and any concurrent
    // revocation/teardown are serialized: whichever commits second observes the
    // other's effect. This closes the in-flight races where a member_removed OR a
    // status/coverage teardown lands between the pre-lock membership/grant/status/
    // coverage checks above and the connection INSERT. To observe those effects
    // the locked SELECT re-reads status + repository_selection + repositories, and
    // the post-lock re-checks below re-apply the status gate (both paths) and the
    // owner repo-coverage gate on the LOCKED row. The re-reads rely on READ
    // COMMITTED (the pg/Hyperdrive default): the lock blocks until the other tx
    // commits, then a fresh statement snapshot sees its delete/tombstone/status/
    // coverage change.
    const result = await context.get('db').transaction(async (tx) => {
      const [lockedInstall] = await tx
        .select({
          user_id: githubInstallations.user_id,
          account_type: githubInstallations.account_type,
          status: githubInstallations.status,
          repository_selection: githubInstallations.repository_selection,
          repositories: githubInstallations.repositories,
        })
        .from(githubInstallations)
        .where(eq(githubInstallations.installation_id, installationId))
        .for('update')
        .limit(1);
      // The install row can vanish between the pre-lock read and here (a concurrent
      // installation.deleted) — treat a missing row as not-found (opaque 404).
      if (!lockedInstall) {
        return { ok: false as const, status: 404 as const, error: 'installation not found' };
      }
      // Serialize project-role changes with connection creation. The install row
      // remains first (the established GitHub lifecycle lock order), followed by
      // the project and then connection rows. A demoted/removed admin therefore
      // cannot pass the preflight settings check and create a connection after
      // losing access.
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      if (lockedAccess.project.status === 'deleting') {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      // Re-derive ownership from the LOCKED row, not the stale pre-tx snapshot. If
      // the personal owner pointer changed while we waited on the lock, the
      // pre-tx owner path is stale: we already resolved repositoryId via the
      // installation token and carry NO grant, so we must NOT fall through to the
      // member insert (that would be a confused-deputy on the install token). Reject;
      // a fresh request re-derives the caller's real (now non-owner) status and
      // requires a connect_grant.
      const lockedIsOwner =
        lockedInstall.account_type === 'User' && lockedInstall.user_id === caller;
      if (isOwner && !lockedIsOwner) {
        return { ok: false as const, status: 404 as const, error: 'installation not found' };
      }
      // Re-verify the NON-OWNER gates AFTER acquiring the lock. A revocation that
      // committed between the pre-check and here is now visible and wins. The
      // OWNER path skips this recheck (owners are never revoked via membership),
      // but still locks + checks existing + inserts — one code path, harmless lock.
      if (!lockedIsOwner) {
        if (!(await hasActiveInstallationMembership(tx, installationId, caller))) {
          return { ok: false as const, status: 404 as const, error: 'installation not found' };
        }
        // Key the tombstone check on the grant's GitHub account id (X),
        // the durable identity `member_removed` always tombstones. A non-owner
        // path always carries a grant (the member branch above set
        // memberGrantAccountId after Threat-L1); a missing one is fail-closed to
        // the same opaque 403 (the `isOwner && !lockedIsOwner` guard already
        // rejected the owner-turned-non-owner case above, so this is only ever a
        // defensive belt).
        if (memberGrantAccountId === undefined || memberGrantIat === undefined) {
          return { ok: false as const, status: 403 as const, error: 'invalid connect grant' };
        }
        const revokedAtMs = await getInstallationRevocationAt(
          tx,
          installationId,
          memberGrantAccountId,
        );
        if (revokedAtMs !== null && revokedAtMs >= memberGrantIat) {
          return { ok: false as const, status: 403 as const, error: 'invalid connect grant' };
        }
      }
      // A concurrent installation.deleted/suspend that won the lock first marks the
      // row inactive; reject rather than create an orphan connection the teardown
      // already passed (the pre-lock status gate above, re-applied on the locked
      // row). Applies to owner AND member paths — status is
      // authoritative and has no cache lag.
      if (lockedInstall.status !== 'active') {
        return { ok: false as const, status: 409 as const, error: 'installation is not active' };
      }
      // OWNER path only: the owner resolved repositoryId from the install's cached
      // `repositories` (pre-lock, the `selected` branch above) — re-check that
      // cache under the lock so a concurrent installation_repositories-removed that
      // de-scoped the repo is observed and rejected. `all` installs cover every
      // repo (cache stored empty), so their cache is not consulted. The MEMBER path
      // is deliberately NOT cache-checked: it trusts grant.repositoryId (a repo the
      // member LIVE-proved under their OWN token at connect-authorize), and the
      // cached set can LAG a live repo addition — a cache check here would
      // false-reject a legitimate member grant for a not-yet-cached repo.
      if (
        lockedIsOwner &&
        lockedInstall.repository_selection === 'selected' &&
        !lockedInstall.repositories.some((repo) => repo.full_name === repoFullName)
      ) {
        return {
          ok: false as const,
          status: 400 as const,
          error: 'repository not accessible by installation',
        };
      }
      const existing = await getGitHubConnection(tx, projectId);
      if (existing) {
        return { ok: false as const, status: 409 as const, error: 'project already connected' };
      }
      const connection = await createGitHubConnection(tx, {
        projectId,
        installationId,
        repoFullName,
        repositoryId: String(repositoryId),
        authorizedByUserId: caller,
        branch,
        buildExecutor,
        workflowPath,
      });
      return { ok: true as const, connection };
    });
    if (result instanceof Response) {
      return result;
    }
    if (!result.ok) {
      return context.json({ error: result.error }, result.status);
    }
    return context.json(publicGitHubConnection(result.connection));
  })

  // Read the project's connection.
  .get('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }

    const connection = await getGitHubConnection(context.get('db'), projectId);
    if (!connection) {
      return context.json({ error: 'connection not found' }, 404);
    }

    return context.json(publicGitHubConnection(connection));
  })

  // Update branch / build executor.
  .patch('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    const connection = await getGitHubConnection(context.get('db'), projectId);
    if (!connection) {
      return context.json({ error: 'connection not found' }, 404);
    }

    const body = await context.req.json<{
      branch?: unknown;
      buildExecutor?: unknown;
      workflowPath?: unknown;
    }>();
    if (body.branch !== undefined && (typeof body.branch !== 'string' || body.branch === '')) {
      return context.json({ error: 'invalid branch' }, 400);
    }
    if (
      body.buildExecutor !== undefined &&
      body.buildExecutor !== 'container' &&
      body.buildExecutor !== 'github_actions'
    ) {
      return context.json({ error: 'invalid buildExecutor' }, 400);
    }
    if (
      body.workflowPath !== undefined &&
      (typeof body.workflowPath !== 'string' || !isValidWorkflowPath(body.workflowPath))
    ) {
      return context.json({ error: 'invalid workflowPath' }, 400);
    }
    const newBranch: string | undefined = body.branch;
    const newExecutor = body.buildExecutor as Build['executor'] | undefined;
    const newWorkflowPath: string | undefined = body.workflowPath;

    // A branch or executor change orphans any in-flight build for the OLD config:
    // its deploy token must be revoked so a build started for the prior
    // branch/executor can't keep publishing after the config moves. Terminalize
    // those builds under the same connection-row lock as the update so an
    // in-flight OIDC exchange (which re-reads + locks the row) is serialized.
    // Only a REAL change invalidates builds — a no-op PATCH (value unchanged, or
    // field omitted) terminalizes nothing.
    const result = await context.get('db').transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      if (lockedAccess.project.status === 'deleting') {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      await tx
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .for('update');

      // Re-read the connection UNDER the lock: the pre-tx `connection` snapshot
      // can be stale if a concurrent PATCH or disconnect/reconnect committed
      // between that read and this lock. The locked row is authoritative — both
      // change-detection AND the terminate branch/executor are derived from it,
      // so we never terminalize builds for a stale branch/executor.
      const current = await getGitHubConnection(tx, projectId);
      if (!current) {
        // The connection was deleted in the race; respond 404 outside the tx.
        return { cancelled: [], updated: null, gone: true };
      }

      const terminated: Array<TerminatedBuild> = [];
      if (newBranch !== undefined && newBranch !== current.branch) {
        terminated.push(
          ...(await terminateBuildsForProject(tx, projectId, {
            branch: current.branch,
            reason: 'branch changed',
          })),
        );
      }
      if (newExecutor !== undefined && newExecutor !== current.build_executor) {
        terminated.push(
          ...(await terminateBuildsForProject(tx, projectId, {
            executor: current.build_executor,
            reason: 'executor changed',
          })),
        );
      }
      // A workflow_path change is a trust-boundary change: the OIDC gate only
      // mints a deploy token for the pinned workflow, so re-pinning must revoke
      // any in-flight github_actions build authorized under the OLD pin (its
      // token stays valid while the build is active). Builds don't record the
      // workflow that authorized them, so terminalize ALL in-flight
      // github_actions builds — every active one predates this new pin. Container
      // builds don't use the workflow gate, so they're untouched. The locked
      // re-read in createGithubActionsBuildWithinLimit closes the concurrent race.
      if (newWorkflowPath !== undefined && newWorkflowPath !== current.workflow_path) {
        terminated.push(
          ...(await terminateBuildsForProject(tx, projectId, {
            executor: 'github_actions',
            reason: 'workflow path changed',
          })),
        );
      }

      await updateGitHubConnection(tx, projectId, {
        branch: newBranch,
        buildExecutor: newExecutor,
        workflowPath: newWorkflowPath,
      });
      const next = await getGitHubConnection(tx, projectId);
      return { cancelled: terminated, updated: next, gone: false };
    });

    if (result instanceof Response) {
      return result;
    }
    const { cancelled, updated, gone } = result;

    if (gone || !updated) {
      return context.json({ error: 'connection not found' }, 404);
    }

    // AFTER the tx commits (never while holding the connection lock), best-effort
    // stop the container DOs for any cancelled container builds.
    await cancelContainerBuildDos(context.env, cancelled, 'project disconnected');

    return context.json(publicGitHubConnection(updated));
  })

  // Disconnect the project.
  .delete('/:id/github', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'settings');
    if (access instanceof Response) {
      return access;
    }

    // Terminalize ALL in-flight builds (queued + active, both executors) for
    // this project BEFORE dropping the connection, then drop it — in one tx
    // under a connection-row lock. Terminalizing revokes each build's deploy
    // token (the middleware guard rejects a token whose bound build is no
    // longer active), so an active container build that already minted a
    // VOID_TOKEN can't keep publishing from a now-disconnected repo. GitHub
    // Actions builds also stop pinning a concurrency slot (their workflow_run
    // completion webhook resolves the CURRENT connection — once it's gone the
    // completion is ignored and the build would otherwise stay active forever).
    const result = await context.get('db').transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
        .limit(1);
      const lockedAccess = await requireProjectRouteCapability(context, projectId, 'settings', tx);
      if (lockedAccess instanceof Response) {
        return lockedAccess;
      }
      if (lockedAccess.project.status === 'deleting') {
        return context.json({ error: 'project is being deleted' }, 409);
      }
      // Lock the connection row(s) so an in-flight OIDC exchange (which re-reads +
      // FOR UPDATE-locks the same row before inserting its build) is serialized:
      // whichever commits first wins, and a build created just before this commit
      // is caught by the terminate step below.
      await tx
        .select({ id: githubConnections.id })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .for('update');
      const terminated = await terminateBuildsForProject(tx, projectId, {
        reason: 'project disconnected',
      });
      await deleteGitHubConnection(tx, projectId);
      return terminated;
    });

    if (result instanceof Response) {
      return result;
    }
    const cancelled = result;

    // AFTER the tx commits (never while holding the connection lock), best-effort
    // stop the container DOs for any cancelled container builds.
    await cancelContainerBuildDos(context.env, cancelled, 'project disconnected');

    return context.json({ ok: true });
  });
