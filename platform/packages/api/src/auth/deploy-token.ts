import { signJwt } from './jwt.ts';

/**
 * Fallback TTL for deploy tokens when a caller does not size one explicitly —
 * 15 minutes, short enough that a leaked token has a tiny blast radius. BOTH
 * remote build executors (CF Containers AND GitHub Actions OIDC) override this
 * to cover their plan build timeout via `deployTokenTtlSecondsForBuildMinutes`
 * (see `signDeployToken` `ttlSeconds`), since the token is minted *before* a
 * multi-minute install + build + upload. This default applies only to callers
 * that omit `ttlSeconds`.
 */
const DEPLOY_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * A prerender token is handed to the built application while it runs under
 * Miniflare. Keep its lifetime short: it can access only the binding proxy for
 * one project and exists solely to let getPrerenderPaths/loaders read remote
 * D1, KV, R2, and AI during a managed deploy.
 */
const PRERENDER_TOKEN_TTL_SECONDS = 5 * 60;

export const PROJECT_CREDENTIAL_MAX_DAYS = 90;

/** Hard ceiling on a deploy token's lifetime — even an "unlimited" (0) build
 * timeout can't mint an unbounded-life token. */
export const DEPLOY_TOKEN_HARD_MAX_MINUTES = 60;
/** Margin so the token outlives the build's own timeout. */
export const DEPLOY_TOKEN_MARGIN_SECONDS = 5 * 60;

/** TTL (seconds) for a deploy token that must cover a full build whose wall-clock
 * limit is `timeoutMinutes` (0 = unlimited → capped at the hard max), plus margin. */
export function deployTokenTtlSecondsForBuildMinutes(timeoutMinutes: number): number {
  const buildMinutes = timeoutMinutes > 0 ? timeoutMinutes : Infinity;
  const cappedMinutes = Math.min(buildMinutes, DEPLOY_TOKEN_HARD_MAX_MINUTES);
  return cappedMinutes * 60 + DEPLOY_TOKEN_MARGIN_SECONDS;
}

/**
 * Mints a short-lived, project-scoped deploy token (HS256, `aud:'deploy'`).
 *
 * The token authenticates as the project owner (`sub: userId`) but is pinned
 * to a single project via the `project` claim, so the deploy endpoint guard
 * rejects any attempt to deploy a different project with it. Used by remote
 * builds (CF Containers and GitHub Actions) running the real `void deploy` CLI.
 *
 * The token also carries a `build` claim binding it to that specific build's
 * row. The deploy endpoint rejects the token once the build is no longer
 * active (e.g. superseded/cancelled by a newer push or run), so a stale runner
 * can't deploy an older commit after being superseded. The auth middleware
 * rejects any deploy token that has neither a `build` nor a `credential`
 * claim.
 *
 * `ttlSeconds` sizes the token's lifetime; see `DEPLOY_TOKEN_TTL_SECONDS`.
 */
export async function signDeployToken(
  {
    projectId,
    userId,
    login,
    buildId,
  }: { projectId: string; userId: string; login: string; buildId: string },
  secret: string,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  return signJwt(
    {
      sub: userId,
      login,
      aud: 'deploy',
      project: projectId,
      build: buildId,
    },
    secret,
    { ttlSeconds: opts?.ttlSeconds ?? DEPLOY_TOKEN_TTL_SECONDS },
  );
}

/** Mint the bearer value for a durable, independently revocable CI credential. */
export async function signProjectCredentialToken(
  input: {
    credentialId: string;
    projectId: string;
    userId: string;
    login: string;
    expiresAt: Date;
  },
  secret: string,
): Promise<string> {
  const ttlSeconds = Math.floor((input.expiresAt.getTime() - Date.now()) / 1000);
  if (ttlSeconds <= 0 || ttlSeconds > PROJECT_CREDENTIAL_MAX_DAYS * 24 * 60 * 60) {
    throw new Error('Project credential expiry is outside the supported range.');
  }
  return signJwt(
    {
      sub: input.userId,
      login: input.login,
      aud: 'deploy',
      project: input.projectId,
      credential: input.credentialId,
    },
    secret,
    { ttlSeconds },
  );
}

/** Mint a short-lived token accepted only by the remote-binding proxy. */
export async function signPrerenderToken(
  {
    projectId,
    userId,
    login,
    buildId,
    credentialId,
  }: {
    projectId: string;
    userId: string;
    login: string;
    buildId?: string;
    credentialId?: string;
  },
  secret: string,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  return signJwt(
    {
      sub: userId,
      login,
      aud: 'prerender',
      project: projectId,
      ...(buildId !== undefined ? { build: buildId } : {}),
      ...(credentialId !== undefined ? { credential: credentialId } : {}),
    },
    secret,
    { ttlSeconds: opts?.ttlSeconds ?? PRERENDER_TOKEN_TTL_SECONDS },
  );
}
