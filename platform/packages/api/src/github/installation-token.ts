import type { ApiEnv } from '../env.ts';
import { createAppJwt, type GithubAppEnv } from './app-jwt.ts';

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_API_VERSION = '2026-03-10';

type AccessTokenResponse = Readonly<{
  token: string;
  expires_at: string;
}>;

type CachedToken = {
  token: string;
  // Epoch ms after which the cached token should be considered stale.
  expiresAtMs: number;
};

// Refresh installation tokens ~5 minutes before GitHub expires them so an
// in-flight build never races the expiry.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// Cache installation tokens per installation id for the life of the isolate.
const tokenCache = new Map<string, CachedToken>();

/**
 * Optional scoping for a minted installation token. When provided, the token is
 * narrowed to the given repositories and/or permissions instead of the default
 * installation-wide grant. Used by the container build path so a token a
 * malicious dependency `postinstall` could steal can only reach the ONE repo
 * being built (`{ contents: 'read' }`), not every repo the install covers.
 */
type InstallationTokenScope = Readonly<{
  // Immutable numeric GitHub repository ids (as text). Sent to GitHub as
  // `repository_ids` (numeric) so the token is limited to exactly these repos.
  repositoryIds?: ReadonlyArray<string>;
  // Permission narrowing, e.g. `{ contents: 'read' }`. A token can only ever be
  // a SUBSET of the App's installed permissions, so this never widens access.
  permissions?: Record<string, string>;
}>;

/**
 * Mint (or return a cached) installation access token for a GitHub App
 * installation. The token authenticates API calls (and tarball downloads)
 * scoped to the installation's repositories.
 *
 * With no `opts`, mints (and caches) an INSTALLATION-WIDE token. With `opts`,
 * mints a repo/permission SCOPED token. Scoped tokens are NEVER cached (and
 * never served from the bare installation-id cache): the cache is keyed by installation id only, so caching
 * a scoped token there — or returning the wide cached token for a scoped
 * request — would leak the wrong scope to a different repo's build. Container
 * builds are infrequent, so minting fresh each time is the simpler correct
 * option than a composite cache key.
 */
export async function getInstallationToken(
  env: GithubAppEnv,
  installationId: string,
  opts?: InstallationTokenScope,
): Promise<string> {
  // Only the unscoped (installation-wide) token may be served from / written to
  // the installation-id-keyed cache. A scoped request always mints fresh.
  if (!opts) {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > Date.now()) {
      return cached.token;
    }
  }

  const appJwt = await createAppJwt(env);
  const body =
    opts && (opts.repositoryIds || opts.permissions)
      ? JSON.stringify({
          ...(opts.repositoryIds ? { repository_ids: opts.repositoryIds.map(Number) } : {}),
          ...(opts.permissions ? { permissions: opts.permissions } : {}),
        })
      : undefined;
  const res = await fetch(
    `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'User-Agent': 'void-api',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    },
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `Failed to mint installation token (${installationId}): ${res.status} ${errBody.trim() || '<empty>'}`,
    );
  }

  const data = (await res.json()) as AccessTokenResponse;
  // Cache only the installation-wide token — see the doc comment above.
  if (!opts) {
    tokenCache.set(installationId, {
      token: data.token,
      expiresAtMs: Date.parse(data.expires_at),
    });
  }

  return data.token;
}

/**
 * Tarball download URL for a repo at a specific commit. Fetched with the
 * installation token as a `Bearer`. GitHub responds with a redirect to a
 * short-lived codeload URL, which fetch follows automatically.
 */
export function generateSourceTarballUrl(repoFullName: string, sha: string): string {
  return `${GITHUB_API_BASE}/repos/${repoFullName}/tarball/${sha}`;
}

/**
 * GitHub lists at most this many changed files for a whole comparison (the first
 * page only). A list this long may be cut, so callers treat it as truncated.
 */
export const GITHUB_COMPARE_MAX_FILES = 300;

export type CommitComparisonFile = Readonly<{
  filename: string;
  /** `added`, `modified`, `removed`, `renamed`, `copied`, `changed` or `unchanged`. */
  status: string;
  previousFilename: string | null;
  /** The unified diff, when GitHub includes one (not for binary or very large files). */
  patch: string | null;
}>;

export type CommitComparison = Readonly<{
  /** `ahead`, `behind`, `identical` or `diverged`: `head` relative to `base`. */
  status: string;
  aheadBy: number;
  behindBy: number;
  files: ReadonlyArray<CommitComparisonFile>;
  /** The file list may be incomplete: GitHub left it out, or it hit the 300-file cap. */
  truncated: boolean;
}>;

type CommitComparisonResponse = Readonly<{
  status?: unknown;
  ahead_by?: unknown;
  behind_by?: unknown;
  files?: unknown;
}>;

function readComparisonFiles(value: unknown): Array<CommitComparisonFile> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const files: Array<CommitComparisonFile> = [];
  for (const entry of value as Array<Record<string, unknown> | null>) {
    if (typeof entry?.filename !== 'string' || typeof entry.status !== 'string') {
      return null;
    }
    files.push({
      filename: entry.filename,
      status: entry.status,
      previousFilename:
        typeof entry.previous_filename === 'string' ? entry.previous_filename : null,
      patch: typeof entry.patch === 'string' ? entry.patch : null,
    });
  }
  return files;
}

/**
 * `GET /repos/{repo}/compare/{base}...{head}` with a token the caller minted. The
 * changed files come on the first page only, so one page of one commit is asked for.
 * Returns `null` when the comparison cannot be read: a 404 (a commit GitHub no
 * longer has), another 4xx, or a 5xx / network error twice in a row.
 */
export async function compareCommits(
  token: string,
  repoFullName: string,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<CommitComparison | null> {
  const url = `${GITHUB_API_BASE}/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1&page=1`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'void-api',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) {
        return null;
      }
      continue;
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    let data: CommitComparisonResponse;
    try {
      data = (await res.json()) as CommitComparisonResponse;
    } catch {
      return null;
    }
    if (typeof data.status !== 'string') {
      return null;
    }
    const files = readComparisonFiles(data.files);
    return {
      status: data.status,
      aheadBy: typeof data.ahead_by === 'number' ? data.ahead_by : 0,
      behindBy: typeof data.behind_by === 'number' ? data.behind_by : 0,
      files: files ?? [],
      truncated: files === null || files.length >= GITHUB_COMPARE_MAX_FILES,
    };
  }
  return null;
}

type CompareResponse = Readonly<{ status?: string }>;

const COMPARE_RETRY_ATTEMPTS = 2;
const COMPARE_RETRY_DELAY_MS = 250;

function errInfo(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

// area:'github' distinguishes from the deploy-pipeline logger (area:'deploy').
function logCompareFailure(
  reason: 'token-mint-failed' | 'network-error' | 'http-4xx' | 'http-5xx' | 'exhausted',
  fields: Record<string, unknown>,
): void {
  try {
    console.warn(
      JSON.stringify({
        ts: Date.now(),
        lvl: 'warn',
        area: 'github',
        phase: 'branch-head-compare',
        msg: `branch-head compare failed: ${reason}`,
        ...fields,
      }),
    );
  } catch {
    console.warn(`branch-head compare failed: ${reason}`);
  }
}

/**
 * Compare a commit against a branch head via the GitHub compare API, using an
 * installation token. Returns the comparison `status` of the BRANCH HEAD
 * relative to `baseSha` ('ahead' | 'behind' | 'identical' | 'diverged'), or null
 * when freshness cannot be confirmed (transient failure after retries, or a
 * definitive 4xx such as 404). Callers fail closed on null.
 *
 * Callers proceed ONLY on 'identical' (the branch head IS `baseSha`). Every other
 * status means `baseSha` is not the current head and must not deploy:
 *   - 'ahead'    = the branch head is ahead of `baseSha`, i.e. `baseSha` is stale.
 *   - 'behind'   = the branch head is behind `baseSha`, i.e. the branch head no
 *                  longer contains `baseSha` (a backward ref move / rollback /
 *                  force-push moved the branch off it), so `baseSha` is an
 *                  abandoned commit and must be REJECTED.
 *   - 'diverged' = `baseSha` is off the branch's history (force-pushed away).
 *
 * The webhook push path is fire-and-forget — GitHub does NOT auto-redeliver — so
 * a transient null would silently drop a deploy. Retry ONLY transient failures
 * (thrown fetch error or 5xx) up to 2 extra attempts with a short fixed delay; a
 * 404/other 4xx is definitive and returns null immediately. Shared with the OIDC
 * path (which maps null → 503), which benefits from the same retry.
 */
export async function getBranchHeadComparisonStatus(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
  baseSha: string,
  branch: string,
): Promise<string | null> {
  for (let attempt = 0; attempt <= COMPARE_RETRY_ATTEMPTS; attempt++) {
    let token: string;
    try {
      token = await getInstallationToken(env, installationId);
    } catch (err) {
      // Minting the installation token failed (e.g. broken App key, GitHub
      // 401/5xx on the access-token POST). Treat as transient — log the cause
      // (this would otherwise be a silent unhandled rejection), then retry.
      logCompareFailure('token-mint-failed', {
        installationId,
        repoFullName,
        baseSha,
        branch,
        attempt,
        err: errInfo(err),
      });
      if (attempt < COMPARE_RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, COMPARE_RETRY_DELAY_MS));
      }
      continue;
    }
    try {
      const res = await fetch(
        `${GITHUB_API_BASE}/repos/${repoFullName}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(branch)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'void-api',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
        },
      );
      if (res.ok) {
        const data = (await res.json()) as CompareResponse;
        return data.status ?? null;
      }
      // A 5xx is transient (GitHub-side hiccup) and worth retrying; a 404 or
      // other 4xx is definitive (no such repo/ref, App lacks access) — return
      // null without burning retries.
      if (res.status < 500) {
        const body = (await res.text().catch(() => '<unreadable>')).slice(0, 500);
        logCompareFailure('http-4xx', {
          installationId,
          repoFullName,
          baseSha,
          branch,
          attempt,
          status: res.status,
          statusText: res.statusText,
          body,
        });
        return null;
      }
      const body = (await res.text().catch(() => '<unreadable>')).slice(0, 500);
      logCompareFailure('http-5xx', {
        installationId,
        repoFullName,
        baseSha,
        branch,
        attempt,
        status: res.status,
        body,
      });
    } catch (err) {
      // Network/transport failure — transient, fall through to retry.
      logCompareFailure('network-error', {
        installationId,
        repoFullName,
        baseSha,
        branch,
        attempt,
        err: errInfo(err),
      });
    }
    if (attempt < COMPARE_RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, COMPARE_RETRY_DELAY_MS));
    }
  }
  logCompareFailure('exhausted', {
    installationId,
    repoFullName,
    baseSha,
    branch,
    attempts: COMPARE_RETRY_ATTEMPTS + 1,
  });
  return null;
}

/**
 * Live check (installation token) of whether `branch` currently EXISTS on the
 * repo, via the git refs API. Used by the branch-delete webhook path to
 * re-verify current git state before cancelling an in-flight build: GitHub does
 * NOT guarantee webhook ordering, so a stale/out-of-order delete could arrive
 * AFTER the branch was recreated and a new valid build enqueued. Mirroring the
 * push path's freshness gate, the caller cancels ONLY on a confirmed 'absent';
 * 'present' (recreated) and 'unknown' (unconfirmed) both fail closed — the ≤65min deploy-token TTL + hourly reaper
 * still bound the original exposure.
 *
 * Returns:
 *   - 'present' — the branch ref exists (HTTP 200).
 *   - 'absent'  — the branch ref does not exist (HTTP 404).
 *   - 'unknown' — freshness cannot be confirmed: a definitive non-404 4xx (e.g.
 *                 403 no-access) returns immediately without burning retries; a
 *                 5xx is retried (transient GitHub hiccup); exhausted retries or
 *                 a network/transport error also map to 'unknown'.
 *
 * The git refs endpoint is `…/git/ref/heads/{branch}`. A branch name may contain
 * slashes (`feature/foo`), which are PATH separators in this endpoint, so each
 * segment is `encodeURIComponent`'d individually while the `/` separators are
 * preserved — the whole branch is NOT `encodeURIComponent`'d (that would escape
 * the separators and 404 a real nested branch).
 */
export async function getBranchExistence(
  env: ApiEnv['Bindings'],
  installationId: string,
  repoFullName: string,
  branch: string,
): Promise<'present' | 'absent' | 'unknown'> {
  const encodedRef = branch.split('/').map(encodeURIComponent).join('/');
  for (let attempt = 0; attempt <= COMPARE_RETRY_ATTEMPTS; attempt++) {
    try {
      const token = await getInstallationToken(env, installationId);
      const res = await fetch(
        `${GITHUB_API_BASE}/repos/${repoFullName}/git/ref/heads/${encodedRef}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'void-api',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
          },
        },
      );
      if (res.status === 200) {
        return 'present';
      }
      if (res.status === 404) {
        return 'absent';
      }
      // Any other status < 500 (e.g. 403 no-access) is definitive but
      // inconclusive — return 'unknown' without burning retries. A 5xx is a
      // transient GitHub hiccup worth retrying.
      if (res.status < 500) {
        return 'unknown';
      }
    } catch {
      // Network/transport failure — transient, fall through to retry.
    }
    if (attempt < COMPARE_RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, COMPARE_RETRY_DELAY_MS));
    }
  }
  return 'unknown';
}

type RepoInstallationResponse = Readonly<{
  id: number | string;
  account: Readonly<{ id: number | string }>;
}>;

/**
 * Live check (App JWT) that the GitHub App currently covers `repoFullName`.
 * Returns the covering installation's id + account id, or null when the App is
 * not installed on the repo (404) — the authoritative, un-cached revocation
 * signal the webhook cache can miss.
 */
export async function getRepoInstallation(
  env: ApiEnv['Bindings'],
  repoFullName: string,
): Promise<{ installationId: string; accountId: string } | null> {
  const appJwt = await createAppJwt(env);
  const res = await fetch(`${GITHUB_API_BASE}/repos/${repoFullName}/installation`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt}`,
      'User-Agent': 'void-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });

  // 404 is the App-not-installed signal; treat any non-ok response as
  // "uncovered" so the OIDC exchange fails closed.
  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as RepoInstallationResponse;
  return { installationId: String(data.id), accountId: String(data.account.id) };
}

type InstallationAccountResponse = Readonly<{
  account?: Readonly<{ id?: number | string; login?: string; type?: string }>;
}>;

/**
 * Authoritatively resolve an installation's owning account via the App JWT
 * (`GET /app/installations/:id`). Used by the install callback when the
 * installation has no repositories yet, so the owning account can't be derived
 * from a repo owner. Returns the REAL `{ accountId, login, type }`, or null on
 * any non-ok or malformed response so the caller fails closed rather than
 * persisting/checking a fabricated id.
 */
export async function getInstallationAccount(
  env: ApiEnv['Bindings'],
  installationId: string,
): Promise<{ accountId: string; login: string; type: 'User' | 'Organization' } | null> {
  const appJwt = await createAppJwt(env);
  const res = await fetch(
    `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt}`,
        'User-Agent': 'void-api',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    },
  );

  if (!res.ok) {
    return null;
  }

  const data = (await res.json()) as InstallationAccountResponse;
  const account = data.account;
  if (!account || (typeof account.id !== 'number' && typeof account.id !== 'string')) {
    return null;
  }
  if (typeof account.login !== 'string' || account.login === '') {
    return null;
  }
  return {
    accountId: String(account.id),
    login: account.login,
    type: account.type === 'Organization' ? 'Organization' : 'User',
  };
}
