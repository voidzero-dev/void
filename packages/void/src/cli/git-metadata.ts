import { execFileSync } from 'node:child_process';

export type GitDeployMetadata = {
  commit: string | null;
  commitUrl: string | null;
  gitRef: string | null;
  repositoryUrl: string | null;
};

function git(root: string, args: Array<string>, env?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
  } catch {
    return null;
  }
}

function stripGitSuffix(pathname: string): string {
  return pathname.endsWith('.git') ? pathname.slice(0, -4) : pathname;
}

export function normalizeGitRemoteUrl(remote: string | null): string | null {
  if (!remote) {
    return null;
  }

  const trimmed = remote.trim();
  if (!trimmed) {
    return null;
  }

  const scpLike = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes('://')) {
    const host = scpLike[1]?.toLowerCase();
    const path = stripGitSuffix(scpLike[2] ?? '').replace(/^\/+/, '');
    return host && path ? `https://${host}/${path}` : null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:') {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const path = stripGitSuffix(url.pathname).replace(/^\/+/, '');
    return host && path ? `https://${host}/${path}` : null;
  } catch {
    return null;
  }
}

export function buildCommitUrl(repositoryUrl: string | null, commit: string | null): string | null {
  if (!repositoryUrl || !commit) {
    return null;
  }

  try {
    const url = new URL(repositoryUrl);
    if (url.hostname === 'github.com') {
      return `${repositoryUrl}/commit/${commit}`;
    }
    if (url.hostname === 'gitlab.com') {
      return `${repositoryUrl}/-/commit/${commit}`;
    }
    if (url.hostname === 'bitbucket.org') {
      return `${repositoryUrl}/commits/${commit}`;
    }
  } catch {
    return null;
  }

  return null;
}

function getGitRefFromEnv(env: NodeJS.ProcessEnv): string | null {
  if (env.GITHUB_HEAD_REF) {
    return env.GITHUB_HEAD_REF;
  }
  if (env.GITHUB_REF_NAME) {
    return env.GITHUB_REF_NAME;
  }
  if (env.GITHUB_REF) {
    return env.GITHUB_REF.replace(/^refs\/(?:heads|tags|pull)\//, '');
  }
  return null;
}

function getGitHubRepositoryUrl(env: NodeJS.ProcessEnv): string | null {
  if (!env.GITHUB_REPOSITORY) {
    return null;
  }
  const serverUrl = env.GITHUB_SERVER_URL ?? 'https://github.com';
  return normalizeGitRemoteUrl(`${serverUrl}/${env.GITHUB_REPOSITORY}`);
}

export function collectGitDeployMetadata(
  root: string,
  commit: string | null,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Env handed to the `git` CHILDREN. Separate from `env` (which is only READ,
   * for the `GITHUB_*` CI vars) because the two are not interchangeable: a
   * caller may pass a synthetic `env` to describe CI, and that must not become
   * the child's whole environment.
   *
   * `void deploy` passes its scrubbed `buildEnv()` here. `git remote get-url` /
   * `git rev-parse` can invoke repo-configured hooks and credential helpers, so
   * the CF Access service-token pair must stay out of them — exactly what
   * `getGitCommit` does for its own git children right beside this call.
   * Defaults to `process.env`.
   */
  childEnv: NodeJS.ProcessEnv = process.env,
): GitDeployMetadata {
  const repositoryUrl =
    getGitHubRepositoryUrl(env) ??
    normalizeGitRemoteUrl(git(root, ['remote', 'get-url', 'origin'], childEnv));
  const gitRef =
    getGitRefFromEnv(env) ?? git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], childEnv);

  return {
    commit,
    commitUrl: buildCommitUrl(repositoryUrl, commit),
    gitRef: gitRef && gitRef !== 'HEAD' ? gitRef : null,
    repositoryUrl,
  };
}
