import { createRemoteJWKSet, jwtVerify } from 'jose';

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_JWKS_URL = `${OIDC_ISSUER}/.well-known/jwks`;

/**
 * Claims carried by a GitHub Actions OIDC token. GitHub mints these per
 * workflow run; we trust `repository`/`ref`/`sha`/`run_id` only after the
 * signature and issuer are verified against GitHub's JWKS.
 */
export type GithubOidcClaims = Readonly<{
  repository: string;
  repository_owner: string;
  // The owning account's immutable numeric id (as a string). GitHub mints it on
  // every Actions OIDC token (alongside `repository_owner`). The exchange binds
  // it to the installation's `account_id` so a repo transferred to a NEW owner
  // (same immutable `repository_id`, new owner) can't mint a deploy token for
  // the OLD owner's connected project.
  repository_owner_id: string;
  // The repository's immutable numeric id (as a string). GitHub mints it on
  // every Actions OIDC token; the exchange keys connection lookup on it so a
  // repo rename/name-reuse can't redirect a deploy to the wrong project.
  repository_id: string;
  ref: string;
  sha: string;
  run_id: string;
  // The workflow run's attempt number (as a string), incremented on each RERUN
  // of the same `run_id`. GitHub mints it on every Actions OIDC token. The
  // exchange persists it so the `workflow_run` completion handler can match a
  // redelivered completion to the correct attempt's build.
  run_attempt: string;
  workflow: string;
  // `workflow_ref` identifies the ENTRY workflow file for the run, in the form
  // `OWNER/REPO/.github/workflows/FILE@REF`. `job_workflow_ref` is the same for
  // the workflow file that actually defines the running job (it differs from
  // `workflow_ref` only when the job comes from a reusable workflow). The
  // exchange binds the deploy token to the scaffolded `void-deploy.yml` via
  // these so an arbitrary other workflow in the repo can't act as a deploy
  // oracle.
  workflow_ref: string;
  job_workflow_ref: string;
  // The workflow trigger event (e.g. `push`, `workflow_dispatch`,
  // `pull_request`, `pull_request_target`) — a standard GitHub Actions OIDC
  // claim minted on every token. The exchange allowlists it to trusted,
  // write-access-gated events so a PR-family trigger can't mint a deploy token.
  event_name: string;
  sub: string;
  [k: string]: unknown;
}>;

// Lazily created + module-cached so the remote JWKS is fetched at most once
// per isolate (jose also caches/rotates internally with a cooldown).
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(OIDC_JWKS_URL));
  }
  return jwks;
}

/**
 * Verify a GitHub Actions OIDC JWT against GitHub's remote JWKS and issuer.
 * Optionally enforces an expected `audience`. Returns the claims on success,
 * or null on any verification failure (bad signature, wrong issuer/audience,
 * expired, malformed).
 */
export async function verifyGithubOidcToken(
  token: string,
  opts?: { audience?: string },
): Promise<GithubOidcClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: OIDC_ISSUER,
      ...(opts?.audience ? { audience: opts.audience } : {}),
    });
    return payload as GithubOidcClaims;
  } catch {
    return null;
  }
}
