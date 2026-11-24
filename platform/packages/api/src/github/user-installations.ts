import type { ApiEnv } from '../env.ts';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';

/**
 * True only when the GitHub App's user-to-server OAuth credentials are present. These
 * are the App's client ID and secret, distinct from its JWT signing key and the
 * standalone OAuth login credentials.
 * When false, the callback cannot exchange an install `code` and must fall back
 * to the personal account-id match.
 */
export function isAppUserOAuthConfigured(env: ApiEnv['Bindings']): boolean {
  const e = env;
  return (
    typeof e.GITHUB_APP_CLIENT_ID === 'string' &&
    e.GITHUB_APP_CLIENT_ID !== '' &&
    typeof e.GITHUB_APP_CLIENT_SECRET === 'string' &&
    e.GITHUB_APP_CLIENT_SECRET !== ''
  );
}

/**
 * Exchange an install-time OAuth `code` for a short-lived USER-to-server token
 * using the GitHub App's own `client_id`/`client_secret`. Returns `null` when
 * GitHub reports an error (bad/expired code) so the caller can fall back.
 *
 * The token is used transiently to authorize the install and is never
 * persisted — discard it after `listUserInstallationIds`.
 */
async function exchangeInstallCodeForUserToken(
  env: ApiEnv['Bindings'],
  code: string,
  redirectUri?: string,
): Promise<string | null> {
  const e = env;
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'void-api',
    },
    body: JSON.stringify({
      client_id: e.GITHUB_APP_CLIENT_ID,
      client_secret: e.GITHUB_APP_CLIENT_SECRET,
      code,
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  });

  if (!res.ok) {
    return null;
  }

  const data = await res.json<{ access_token?: string; error?: string }>();
  if (data.error || typeof data.access_token !== 'string' || data.access_token === '') {
    return null;
  }
  return data.access_token;
}

// Shape of `GET /user/installations` we care about.
type UserInstallationsResponse = Readonly<{
  installations?: ReadonlyArray<{ id?: number }>;
}>;

// Shape of `GET /user` we care about — the authenticated user's numeric id.
type AuthenticatedUserResponse = Readonly<{ id?: number }>;

/**
 * Fetch the numeric GitHub account id of the holder of `userToken` via
 * `GET /user`. Returns `null` when the request fails or the response carries no
 * numeric `id`. This binds the OAuth code-holder's identity to the signed
 * state's `githubAccountId`, closing the confused-deputy gap where the
 * code-holder need not be the install initiator.
 */
async function fetchUserAccountId(userToken: string): Promise<string | null> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${userToken}`,
      'User-Agent': 'void-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = await res.json<AuthenticatedUserResponse>();
  return typeof data.id === 'number' ? String(data.id) : null;
}

/**
 * Exchange a GitHub App user-OAuth `code` for the code-holder's numeric GitHub
 * account id — pure identity, NO installation involved (RFC 0074 link flow).
 *
 * Wraps {@link exchangeInstallCodeForUserToken} → {@link fetchUserAccountId}:
 * the install `code` is traded for a transient user-to-server token, then
 * `GET /user` yields the holder's numeric id. The token is used only for that
 * one read and never persisted. Returns `null` on ANY failure (App not
 * configured, bad/expired code, `GET /user` error) so the caller fails closed.
 *
 * This is distinct from {@link authorizeInstallViaUserToken}, which requires an
 * `installationId`; linking proves identity only and has no installation.
 *
 * When `redirectUri` is provided it is forwarded on the token-exchange POST. It
 * MUST be byte-identical to the `redirect_uri` sent on the authorize redirect —
 * GitHub OAuth requires the exchange `redirect_uri` to match the authorize one
 * when present (the link flow sends it; the install flow sends none).
 */
export async function exchangeCodeForUserAccountId(
  env: ApiEnv['Bindings'],
  code: string,
  redirectUri?: string,
): Promise<string | null> {
  if (!isAppUserOAuthConfigured(env)) {
    return null;
  }
  const userToken = await exchangeInstallCodeForUserToken(env, code, redirectUri);
  if (!userToken) {
    return null;
  }
  return fetchUserAccountId(userToken);
}

/**
 * List the installation ids the holder of `userToken` can manage. This includes
 * installations on the user's PERSONAL account AND on every organization where
 * the user has installed (or can administer) the App — which is exactly what
 * authorizes an org install whose account id differs from the user's personal
 * id.
 *
 * Paginates `GET /user/installations` (100 per page) so users with many
 * accessible installations don't get a truncated list.
 */
async function listUserInstallationIds(userToken: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${GITHUB_API_BASE}/user/installations?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${userToken}`,
        'User-Agent': 'void-api',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(
        `Failed to list user installations: ${res.status} ${body.trim() || '<empty>'}`,
      );
    }
    const data = await res.json<UserInstallationsResponse>();
    const installations = data.installations ?? [];
    for (const installation of installations) {
      if (typeof installation.id === 'number') {
        ids.add(String(installation.id));
      }
    }
    // GitHub returns up to `per_page` per page; a short page is the last one.
    if (installations.length < 100) {
      break;
    }
  }
  return ids;
}

/**
 * Authorize an install via the GitHub-recommended "user authorization on
 * install" path. Exchanges the install-time `code` for a transient user token,
 * confirms `installationId` is among the user's accessible installations, and
 * reports the code-holder's own numeric GitHub account id so the caller can
 * bind the OAuth identity to the signed install state.
 *
 * Returns:
 *   - `{ authorized: true, callerAccountId }` — the user demonstrably controls
 *               this installation (personal OR org) and `callerAccountId` is the
 *               code-holder's numeric GitHub id (or `null` if `GET /user`
 *               failed to yield one). The caller MUST still compare
 *               `callerAccountId` against the signed state's account id before
 *               linking — accessing an installation does not prove the
 *               code-holder is the install initiator.
 *   - `{ authorized: false, callerAccountId: null }` — the code was
 *               missing/invalid, the App is not configured for
 *               user-auth-on-install, or the installation is not in the user's
 *               accessible list (a foreign installation_id). Caller must reject
 *               (the personal account-id fallback is only used when the App is
 *               not configured for user-auth-on-install).
 *
 * NOTE: full organization support requires enabling "Request user authorization
 * (OAuth) during installation" on the GitHub App (an ops/config item) AND
 * setting the App's `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`. Without
 * that, GitHub never sends a `code` and this returns `{ authorized: false }`.
 *
 * When `redirectUri` is provided it is forwarded on the token-exchange POST and
 * MUST be byte-identical to the `redirect_uri` sent on the authorize redirect.
 * The install `/callback` sends none; the JOIN and
 * connect-authorize callbacks send one, so they must thread it through here.
 */
export async function authorizeInstallViaUserToken(
  env: ApiEnv['Bindings'],
  code: string,
  installationId: string,
  redirectUri?: string,
): Promise<{ authorized: boolean; callerAccountId: string | null }> {
  if (!isAppUserOAuthConfigured(env)) {
    return { authorized: false, callerAccountId: null };
  }
  const userToken = await exchangeInstallCodeForUserToken(env, code, redirectUri);
  if (!userToken) {
    return { authorized: false, callerAccountId: null };
  }
  const callerAccountId = await fetchUserAccountId(userToken);
  const ids = await listUserInstallationIds(userToken);
  return { authorized: ids.has(installationId), callerAccountId };
}

/**
 * Discover the installation ids the holder of the OAuth `code` can manage,
 * together with their numeric GitHub account id. Consumed by the JOIN flow,
 * which unions the caller's accessible installations against the ones
 * Void already tracks to decide which connections the caller may join.
 *
 * Fails closed:
 *   - App not configured for user-auth-on-install → `{ installationIds: empty,
 *     callerAccountId: null }` with NO network call.
 *   - Token exchange error (bad/expired code) → same empty result.
 *
 * The user token is transient — it is used only for the two reads below and is
 * never persisted. When `redirectUri` is provided it is forwarded on the
 * token-exchange POST (must be byte-identical to the authorize `redirect_uri`).
 */
export async function listAuthorizedInstallationIds(
  env: ApiEnv['Bindings'],
  code: string,
  redirectUri?: string,
): Promise<{ installationIds: Set<string>; callerAccountId: string | null }> {
  if (!isAppUserOAuthConfigured(env)) {
    return { installationIds: new Set<string>(), callerAccountId: null };
  }
  const userToken = await exchangeInstallCodeForUserToken(env, code, redirectUri);
  if (!userToken) {
    return { installationIds: new Set<string>(), callerAccountId: null };
  }
  return {
    installationIds: await listUserInstallationIds(userToken),
    callerAccountId: await fetchUserAccountId(userToken),
  };
}

// Shape of `GET /user/installations/:id/repositories` we care about.
type InstallationRepositoriesResponse = Readonly<{
  repositories?: ReadonlyArray<{ id?: number; full_name?: string }>;
}>;

/**
 * Verify — per repo — that the holder of the OAuth `code` can actually see
 * `repoFullName` through installation `installationId`, using ONLY the caller's
 * user token. Consumed by the connect-authorize flow as the per-repo
 * trust boundary that closes the confused-deputy hole: possessing a shared org
 * installation id is not enough; the caller must independently prove they can
 * reach the specific repo.
 *
 * Fails closed:
 *   - App not configured for user-auth-on-install → `{ repositoryId: null,
 *     callerAccountId: null }` with NO network call.
 *   - Token exchange error (bad/expired code) → same null result.
 *
 * Otherwise paginates `GET /user/installations/:id/repositories` with the user
 * token. When a repository whose `full_name` matches `repoFullName` is found,
 * `repositoryId` is that repo's numeric id. A `repositoryId` of `null` after
 * exhausting the pages is the confused-deputy REJECT signal (the caller cannot
 * reach that repo through this installation). A non-ok response THROWS so the
 * caller never mistakes a transient GitHub failure for a definitive reject.
 *
 * When `redirectUri` is provided it is forwarded on the token-exchange POST
 * (must be byte-identical to the authorize `redirect_uri`). The token is
 * transient and never persisted.
 */
export async function verifyUserRepoAccess(
  env: ApiEnv['Bindings'],
  code: string,
  installationId: string,
  repoFullName: string,
  redirectUri?: string,
): Promise<{ repositoryId: number | null; callerAccountId: string | null }> {
  if (!isAppUserOAuthConfigured(env)) {
    return { repositoryId: null, callerAccountId: null };
  }
  const userToken = await exchangeInstallCodeForUserToken(env, code, redirectUri);
  if (!userToken) {
    return { repositoryId: null, callerAccountId: null };
  }

  let repositoryId: number | null = null;
  for (let page = 1; ; page += 1) {
    const res = await fetch(
      `${GITHUB_API_BASE}/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${userToken}`,
          'User-Agent': 'void-api',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(
        `Failed to list installation repositories: ${res.status} ${body.trim() || '<empty>'}`,
      );
    }
    const data = await res.json<InstallationRepositoriesResponse>();
    const repositories = data.repositories ?? [];
    for (const repo of repositories) {
      if (repo.full_name === repoFullName && typeof repo.id === 'number') {
        repositoryId = repo.id;
        break;
      }
    }
    // Stop once found, or on a short page (GitHub returns up to `per_page`).
    if (repositoryId !== null || repositories.length < 100) {
      break;
    }
  }

  return { repositoryId, callerAccountId: await fetchUserAccountId(userToken) };
}
