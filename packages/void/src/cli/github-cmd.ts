import { randomBytes } from 'node:crypto';
import { cancel, confirm, isCancel, log, select, text } from '@voidzero-dev/vite-plus-prompts';
import {
  awaitBrowserCallback,
  createCodeChallenge,
  createCodeVerifier,
  openBrowser,
  getToken,
} from './auth.ts';
import { PlatformApiError, PlatformClient, parsePlatformErrorBody } from './client.ts';
import type { GithubConnection, GithubInstallation } from './client.ts';
import { collectGitDeployMetadata } from './git-metadata.ts';
import type { GithubArgs } from './github-args.ts';
import { printSuccess, formatUrl, pc } from './output.ts';
import { platformErrorMessage } from './platform-errors.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, resolveProjectBySlug } from './resolve-project.ts';

/**
 * The workflow file `void init --github` scaffolds and the platform default for
 * a connection's OIDC deploy pin. Kept in sync with the server default
 * (`github_connections.workflow_path`) and the `init.ts` scaffolder.
 */
export const DEFAULT_WORKFLOW_PATH = '.github/workflows/void-deploy.yml';

/**
 * Client-side mirror of the server's `isValidWorkflowPath` (packages/api
 * routes/github.ts). Used to reject a bad path at the interactive prompt before
 * an API round-trip. The server re-validates, so this is DX only, not security.
 */
export function isValidWorkflowPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.startsWith('.github/workflows/') &&
    (path.endsWith('.yml') || path.endsWith('.yaml')) &&
    !path.includes('..')
  );
}

/**
 * Map a PlatformApiError status + error code string to a friendly user message.
 * Returns null for unrecognised cases (caller should re-throw).
 */
export function describeConnectError(status: number, errorCode: string | undefined): string | null {
  const code = errorCode ?? '';
  if (status === 409) {
    if (code.includes('already connected')) {
      return 'This project is already connected to a GitHub repository.';
    }
    if (code.includes('not active')) {
      return 'Installation is not active. Re-install the GitHub App and try again.';
    }
  }
  if (status === 400 && code.includes('not accessible')) {
    return 'Repository not accessible by this installation. Check the App has access to it.';
  }
  if (status === 404) {
    return 'Project or installation not found.';
  }
  return null;
}

/**
 * Like {@link describeConnectError}, but maps a 404 "connection not found" to a
 * "connect first" message.
 */
export function describeUpdateError(status: number, errorCode: string | undefined): string | null {
  const code = errorCode ?? '';
  if (status === 404 && code.includes('connection not found')) {
    return 'This project is not connected to a GitHub repository. Run `void github connect` first.';
  }
  return describeConnectError(status, code);
}

function describeGithubClientError(
  error: PlatformApiError,
  describe: typeof describeConnectError,
): string | null {
  const body = parsePlatformErrorBody(error.body);
  // The client knows whether this was a project read, settings change, or an
  // account-level GitHub operation. A 403 alone does not identify the cause.
  if (platformErrorMessage(body) || error.status === 403) {
    return error.message;
  }
  return describe(error.status, error.code);
}

/**
 * Extract `owner/repo` from a `https://github.com/owner/repo(.git)?` URL.
 * Returns null for non-GitHub URLs or null input.
 */
export function parseGithubRepoFullName(repositoryUrl: string | null): string | null {
  if (!repositoryUrl) {
    return null;
  }
  try {
    const url = new URL(repositoryUrl);
    if (url.hostname !== 'github.com') {
      return null;
    }
    // pathname is like /owner/repo or /owner/repo.git
    const parts = url.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

/**
 * Format a list of GitHub App installations into a human-readable string.
 * One block per installation:
 *   account_login (account_type) — selection, N repos, status
 *   [repo list for 'selected' installs]
 */
export function formatInstallations(installations: Array<GithubInstallation>): string {
  return installations
    .map((inst) => {
      const header = `${inst.account_login} (${inst.account_type}) [id: ${inst.installation_id}] — ${inst.repository_selection}, ${inst.repositories.length} repos, ${inst.status}`;
      if (inst.repository_selection === 'selected' && inst.repositories.length > 0) {
        const repos = inst.repositories.map((r) => `  • ${r.full_name}`).join('\n');
        return `${header}\n${repos}`;
      }
      return header;
    })
    .join('\n\n');
}

const row = (label: string, value: string): string => `  ${label.padEnd(16)}${value}`;

/**
 * Render a GitHub connection for `void github status`. Container builds never
 * read the workflow file, so it is marked unused for them.
 */
export function formatConnection(connection: GithubConnection): string {
  const workflow =
    connection.build_executor === 'github_actions'
      ? connection.workflow_path
      : `${connection.workflow_path} (unused for container builds)`;
  const rows = [
    row('Repository', connection.repo_full_name),
    row('Branch', connection.branch),
    row('Build executor', connection.build_executor),
    row('Deploy workflow', workflow),
  ];
  return rows.join('\n');
}

export async function runGithubCommand(root: string, args: GithubArgs): Promise<void> {
  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }
  const client = new PlatformClient(token, { root });

  switch (args.subcommand) {
    case 'install':
      return runInstall(client);
    case 'installations':
      return runInstallations(client);
    case 'connect':
      return runConnect(root, client, args);
    case 'update':
      return runGithubUpdate(root, client, args);
    case 'status':
      return runStatus(root, client, args);
    case 'disconnect':
      return runGithubDisconnect(root, client, args);
    case 'link':
      return runGithubLink(client);
    case 'join':
      return runGithubJoin(client);
  }
}

/**
 * `void github install`. Without a linked GitHub identity the server returns a
 * 403 `github_identity_required`; link inline and retry once rather than send the
 * user to `void account login`, which risks creating a second account.
 */
export async function runInstall(
  client: PlatformClient,
  linkIdentity: (client: PlatformClient) => Promise<void> = runGithubLink,
): Promise<void> {
  let url: string;
  try {
    ({ url } = await client.getGithubInstallUrl());
  } catch (err) {
    if (
      err instanceof PlatformApiError &&
      err.status === 403 &&
      err.code === 'github_identity_required'
    ) {
      log.message('Your Void account needs a linked GitHub identity. Starting the GitHub link…');
      await linkIdentity(client);
      try {
        ({ url } = await client.getGithubInstallUrl());
      } catch (retryErr) {
        // Only the SAME identity-required 403 means linking didn't take — show
        // the actionable link/install guidance. Any other failure (401, 426,
        // 500, a different 403) is the real error and must surface normally.
        if (
          retryErr instanceof PlatformApiError &&
          retryErr.status === 403 &&
          retryErr.code === 'github_identity_required'
        ) {
          log.error(
            'Could not start the GitHub App install after linking. Try `void github link`, then `void github install` again.',
          );
          process.exit(1);
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  log.message(`Open this URL to install the Void GitHub App:\n${pc.blue(formatUrl(url))}`);
  openBrowser(url);
  log.message('After installing, run `void github connect` to link a repository to your project.');
}

/**
 * Link the logged-in Void account to a GitHub identity. Returns on success so
 * `github install` can continue after linking.
 */
export async function runGithubLink(client: PlatformClient): Promise<void> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  // completeGithubLink runs INSIDE the request handler (via finalize), so the
  // browser only shows the success page after the link actually succeeds; a 409
  // conflict rejects out of awaitBrowserCallback and is mapped below.
  let status: 'linked' | 'already_linked';
  try {
    ({ status } = await awaitBrowserCallback<{ status: 'linked' | 'already_linked' }>({
      successTitle: 'GitHub account linked',
      state,
      buildAuthUrl: async (callback) => {
        callback.searchParams.set('state', state);
        const { url } = await client.getGithubLinkUrl(callback.href, challenge);
        return url;
      },
      describeError: (p) => (p.get('error') ? 'GitHub authorization failed.' : null),
      onUrl: (url) =>
        log.message(`Open this URL to link your GitHub account:\n${pc.blue(formatUrl(url))}`),
      finalize: async (params) => {
        const linkCode = params.get('link_code');
        if (!linkCode) {
          throw new Error('github: link callback did not return a link code.');
        }
        return client.completeGithubLink(linkCode, verifier);
      },
    }));
  } catch (err) {
    if (err instanceof PlatformApiError && err.code === 'github_already_linked') {
      log.error('Your Void account is already linked to a different GitHub account.');
      process.exit(1);
    }
    if (
      err instanceof PlatformApiError &&
      (err.status === 409 || err.code === 'github_identity_conflict')
    ) {
      log.error('This GitHub account is already linked to another Void account.');
      process.exit(1);
    }
    throw err;
  }

  if (status === 'already_linked') {
    log.info('GitHub account already linked.');
  } else {
    printSuccess('GitHub account linked.');
  }
}

/**
 * Join the caller to their organization's shared GitHub App installations and
 * return how many were joined. Errors are left to the caller.
 */
export async function performGithubJoin(client: PlatformClient): Promise<number> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  // completeGithubJoin runs INSIDE the request handler (via finalize), so the
  // browser only shows the success page after the join actually succeeds.
  const { count } = await awaitBrowserCallback<{ status: 'joined'; count: number }>({
    successTitle: 'GitHub installations joined',
    state,
    buildAuthUrl: async (callback) => {
      callback.searchParams.set('state', state);
      const { url } = await client.getGithubJoinUrl(callback.href, challenge);
      return url;
    },
    describeError: (p) => (p.get('error') ? 'GitHub authorization failed.' : null),
    onUrl: (url) =>
      log.message(
        `Open this URL to join your organization's shared GitHub App installations:\n${pc.blue(formatUrl(url))}`,
      ),
    finalize: async (params) => {
      const joinCode = params.get('join_code');
      if (!joinCode) {
        throw new Error('github: join callback did not return a join code.');
      }
      return client.completeGithubJoin(joinCode, verifier);
    },
  });
  return count;
}

export async function runGithubJoin(client: PlatformClient): Promise<void> {
  let count: number;
  try {
    count = await performGithubJoin(client);
  } catch (err) {
    // Fail closed: org-installation sharing OAuth is not configured on this
    // instance. The membership flow has no already-joined conflict to map.
    if (
      err instanceof PlatformApiError &&
      err.status === 503 &&
      err.code === 'github_oauth_not_configured'
    ) {
      log.error('Organization installation sharing is not enabled on this Void instance.');
      process.exit(1);
    }
    throw err;
  }

  if (count === 0) {
    log.info('No new installations to join.');
  } else {
    log.message('Run `void github installations` to see them, then `void github connect`.');
    printSuccess(`Joined ${count} installation${count === 1 ? '' : 's'}.`);
  }
}

async function runInstallations(client: PlatformClient): Promise<void> {
  const installations = await client.listGithubInstallations();
  if (installations.length === 0) {
    log.info('No GitHub App installations. Run `void github install` first.');
    return;
  }
  log.message(formatInstallations(installations));
}

/**
 * Per-repo authorization for an org member who cannot yet prove repo access.
 * The grant arrives in the callback URL; the caller sends it with the verifier.
 */
async function runGithubConnectAuthorize(
  client: PlatformClient,
  installationId: string,
  repoFullName: string,
): Promise<{ connectGrant: string; codeVerifier: string }> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  const { connectGrant } = await awaitBrowserCallback<{ connectGrant: string }>({
    successTitle: 'GitHub connection authorized',
    state,
    buildAuthUrl: async (callback) => {
      callback.searchParams.set('state', state);
      const { url } = await client.getGithubConnectAuthorizeUrl(
        callback.href,
        challenge,
        installationId,
        repoFullName,
      );
      return url;
    },
    describeError: (p) => {
      const e = p.get('error');
      if (e === 'repo_not_accessible') {
        return `You don't have access to ${repoFullName} under this installation on GitHub.`;
      }
      return e ? 'GitHub authorization failed.' : null;
    },
    onUrl: (url) =>
      log.message(
        `Open this URL to authorize access to ${repoFullName}:\n${pc.blue(formatUrl(url))}`,
      ),
    finalize: async (params) => {
      const grant = params.get('connect_grant');
      if (!grant) {
        throw new Error('github: connect authorization did not return a grant.');
      }
      return { connectGrant: grant };
    },
  });

  return { connectGrant, codeVerifier: verifier };
}

/**
 * Free-text repository prompt used when the installation's repository list is
 * not enumerable client-side: `repository_selection === 'all'`, or a shared
 * org installation whose list the server redacts for non-owner members. The
 * server re-verifies actual access on connect, so this is DX, not security.
 */
async function promptRepoFullName(root: string): Promise<string> {
  const gitDefault = parseGithubRepoFullName(collectGitDeployMetadata(root, null).repositoryUrl);
  const input = await text({
    message: 'Repository (owner/repo):',
    placeholder: gitDefault ?? 'owner/repo',
    defaultValue: gitDefault ?? undefined,
    validate: (value) =>
      /^[^/\s]+\/[^/\s]+$/.test((value || gitDefault || '').trim())
        ? undefined
        : 'Enter the repository as owner/repo.',
  });
  if (isCancel(input)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  return (input as string).trim();
}

/**
 * `--project` / `VOID_PROJECT`, then the linked project, then (TTY only) a
 * picker. Exits with a `<command>:`-prefixed error when none resolves.
 */
async function resolveGithubProjectId(
  root: string,
  client: PlatformClient,
  projectName: string,
  command: string,
  isTTY: boolean,
): Promise<string> {
  const requestedSlug = getRequestedProjectSlug({ projectSlug: projectName || undefined });
  if (requestedSlug) {
    const projects = await client.listProjects();
    const resolved = resolveProjectBySlug(projects, requestedSlug);
    if (!resolved) {
      log.error(`${command}: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    return resolved.projectId;
  }
  const linked = readProjectConfig(root);
  if (linked) {
    return linked.projectId;
  }
  if (!isTTY) {
    log.error(
      `${command}: No project specified. Pass a project name or --project <name>, set VOID_PROJECT, or link one with \`void project link\`.`,
    );
    process.exit(1);
  }
  const projects = await client.listProjects();
  if (projects.length === 0) {
    log.error('No projects found. Create one first with `void deploy`.');
    process.exit(1);
  }
  const picked = await select({
    message: 'Select a project:',
    options: projects.map((p) => ({ value: p.id, label: p.slug })),
  });
  if (isCancel(picked)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  return picked as string;
}

export async function runConnect(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'connect' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  const projectId = await resolveGithubProjectId(root, client, args.projectName, 'connect', isTTY);

  const listActiveInstallations = async () =>
    (await client.listGithubInstallations()).filter((i) => i.status === 'active');

  // Auto-join fallback: an org member whose org already installed the App has
  // no membership row until a join round-trip records one, so their list is
  // empty (or missing the shared installation) even though the App is
  // installed. Run the join flow once instead of telling them to re-install.
  // Browser round-trips are TTY-only, mirroring every other prompt here. A 503
  // (sharing not configured) falls through to the install-first error.
  let autoJoinAttempted = false;
  const attemptAutoJoin = async (): Promise<number> => {
    autoJoinAttempted = true;
    try {
      return await performGithubJoin(client);
    } catch (err) {
      if (
        err instanceof PlatformApiError &&
        err.status === 503 &&
        err.code === 'github_oauth_not_configured'
      ) {
        return 0;
      }
      throw err;
    }
  };

  let installations = await listActiveInstallations();

  if (installations.length === 0 && isTTY) {
    log.info(
      'No GitHub App installation is linked to your account yet — checking whether your organization already installed the Void GitHub App…',
    );
    if ((await attemptAutoJoin()) > 0) {
      installations = await listActiveInstallations();
    }
  }

  if (installations.length === 0) {
    log.error(
      isTTY
        ? 'No GitHub App installation found for your account or your organizations. Run `void github install` first.'
        : 'No active GitHub App installation. Run `void github install` first, or `void github join` if your organization already installed the Void GitHub App.',
    );
    process.exit(1);
  }

  let installation: GithubInstallation;

  if (args.installationId) {
    let found = installations.find((i) => i.installation_id === args.installationId);
    if (!found && isTTY && !autoJoinAttempted) {
      log.info(
        `Installation '${args.installationId}' is not linked to your account yet — checking whether your organization shares it…`,
      );
      if ((await attemptAutoJoin()) > 0) {
        installations = await listActiveInstallations();
        found = installations.find((i) => i.installation_id === args.installationId);
      }
    }
    if (!found) {
      log.error(`connect: No active installation found with id '${args.installationId}'.`);
      process.exit(1);
    }
    installation = found;
  } else if (installations.length === 1) {
    installation = installations[0]!;
  } else if (!isTTY) {
    log.error('connect: Multiple installations found. Pass --installation <id>.');
    process.exit(1);
  } else {
    const picked = await select({
      message: 'Select a GitHub App installation:',
      options: installations.map((i) => ({
        value: i.installation_id,
        label: `${i.account_login} (${i.account_type}) [id: ${i.installation_id}]`,
      })),
    });
    if (isCancel(picked)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    installation = installations.find((i) => i.installation_id === picked)!;
  }

  let repoFullName: string;

  if (args.repo) {
    repoFullName = args.repo;
  } else if (installation.repository_selection === 'selected') {
    if (installation.repositories.length === 0) {
      // The server redacts `repositories` to [] for every organization
      // installation. A personal installation can also genuinely have zero
      // grants. Either way the list is not enumerable here — take free text and
      // let the server's per-repository access check decide.
      if (!isTTY) {
        log.error(
          'connect: --repo <owner/repo> is required — this installation does not expose a repository list to your account.',
        );
        process.exit(1);
      }
      repoFullName = await promptRepoFullName(root);
    } else if (installation.repositories.length === 1) {
      repoFullName = installation.repositories[0]!.full_name;
    } else if (!isTTY) {
      log.error('connect: Multiple repositories available. Pass --repo <owner/repo>.');
      process.exit(1);
    } else {
      const picked = await select({
        message: 'Select a repository:',
        options: installation.repositories.map((r) => ({ value: r.full_name, label: r.full_name })),
      });
      if (isCancel(picked)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      repoFullName = picked as string;
    }
  } else {
    // 'all' — repos aren't enumerable. Do NOT infer the repo from git in CI:
    // GITHUB_REPOSITORY / origin can point at a fork or the wrong checkout and
    // would silently bind the project to the wrong repo. Require --repo, the
    // same way --branch is required in non-interactive mode.
    if (!isTTY) {
      log.error(
        'connect: --repo <owner/repo> is required in non-interactive mode for an all-repositories installation.',
      );
      process.exit(1);
    }
    repoFullName = await promptRepoFullName(root);
  }

  const branchDefault = args.branch ?? collectGitDeployMetadata(root, null).gitRef ?? 'main';

  let branch: string;
  if (args.branch) {
    branch = args.branch;
  } else if (!isTTY) {
    log.error('connect: --branch is required in non-interactive mode. Pass --branch <name>.');
    process.exit(1);
  } else {
    const input = await text({
      message: 'Branch to deploy from:',
      placeholder: branchDefault,
      defaultValue: branchDefault,
    });
    if (isCancel(input)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    branch = (input as string).trim() || branchDefault;
  }

  let executor: 'container' | 'github_actions';
  if (args.executor !== undefined) {
    executor = args.executor;
  } else if (!isTTY) {
    executor = 'container';
  } else {
    const picked = await select({
      message: 'Build executor:',
      options: [
        { value: 'container', label: 'Cloudflare Container', hint: 'build on Void (default)' },
        { value: 'github_actions', label: 'GitHub Actions', hint: "build in your repo's runner" },
      ],
      initialValue: 'container',
    });
    if (isCancel(picked)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    executor = picked as 'container' | 'github_actions';
  }

  // Container builds never read the workflow file. A prompted value equal to the
  // default stays unset, so the server applies its own default.
  let workflowPath = args.workflowPath;
  if (executor === 'github_actions' && args.workflowPath === undefined && isTTY) {
    const input = await text({
      message: 'Deploy workflow file:',
      placeholder: DEFAULT_WORKFLOW_PATH,
      defaultValue: DEFAULT_WORKFLOW_PATH,
      validate(value) {
        const v = (value ?? '').trim();
        if (v.length === 0 || isValidWorkflowPath(v)) {
          return;
        }
        return 'Must be under .github/workflows/, end in .yml/.yaml, and not contain "..".';
      },
    });
    if (isCancel(input)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    const chosen = (input as string).trim() || DEFAULT_WORKFLOW_PATH;
    if (chosen !== DEFAULT_WORKFLOW_PATH) {
      workflowPath = chosen;
    }
  }

  const attemptConnect = (extra?: { connectGrant: string; codeVerifier: string }) =>
    client.connectGithub(projectId, {
      installationId: installation.installation_id,
      repoFullName,
      branch,
      buildExecutor: executor,
      workflowPath,
      ...extra,
    });

  try {
    await attemptConnect();
  } catch (err) {
    if (!(err instanceof PlatformApiError)) {
      throw err;
    }
    if (err.status === 403 && err.code === 'connect_authorization_required') {
      if (!isTTY) {
        // Authorization waits for a browser callback, so fail now instead of
        // hanging until it times out.
        log.error(
          'connect: this installation requires per-repo authorization, which needs an interactive browser sign-in. Run `void github connect` locally to authorize, then retry.',
        );
        process.exit(1);
      }
      // Prove per-repo access, then retry the connect once with the grant.
      const grant = await runGithubConnectAuthorize(
        client,
        installation.installation_id,
        repoFullName,
      );
      try {
        await attemptConnect({
          connectGrant: grant.connectGrant,
          codeVerifier: grant.codeVerifier,
        });
      } catch (retryErr) {
        if (
          retryErr instanceof PlatformApiError &&
          retryErr.status === 403 &&
          retryErr.code === 'invalid connect grant'
        ) {
          // The grant expired or the browser identity differs from the linked
          // one; the generic 403 message would wrongly blame project access.
          log.error(
            'connect: GitHub authorization failed or expired. Run `void github connect` again.',
          );
          process.exit(1);
        }
        throw retryErr;
      }
    } else {
      const message = describeGithubClientError(err, describeConnectError);
      if (message !== null) {
        log.error(`connect: ${message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  printSuccess(`Connected ${repoFullName} (${branch}) → project. Push to ${branch} to deploy.`);
}

export async function runGithubUpdate(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'update' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  // Check before any API call so this usage error never depends on API state.
  if (
    !isTTY &&
    args.branch === undefined &&
    args.executor === undefined &&
    args.workflowPath === undefined
  ) {
    log.error(
      'update: Nothing to update. Pass --branch <name>, --executor <container|github_actions>, and/or --workflow <.github/workflows/...>.',
    );
    process.exit(1);
  }

  const projectId = await resolveGithubProjectId(root, client, args.projectName, 'update', isTTY);

  let current: GithubConnection;
  try {
    current = await client.getGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const message = describeGithubClientError(err, describeUpdateError);
      if (message !== null) {
        log.error(`update: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  let branch: string;
  let executor: 'container' | 'github_actions';
  let workflowPath = args.workflowPath ?? current.workflow_path;

  if (isTTY) {
    if (args.branch !== undefined) {
      branch = args.branch;
    } else {
      const input = await text({
        message: 'Branch to deploy from:',
        placeholder: current.branch,
        initialValue: current.branch,
      });
      if (isCancel(input)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      branch = (input as string).trim() || current.branch;
    }

    if (args.executor !== undefined) {
      executor = args.executor;
    } else {
      const picked = await select({
        message: 'Build executor:',
        options: [
          { value: 'container', label: 'container' },
          { value: 'github_actions', label: 'github_actions' },
        ],
        initialValue: current.build_executor,
      });
      if (isCancel(picked)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      executor = picked as 'container' | 'github_actions';
    }

    // Container builds never read the workflow file, so there is nothing to ask.
    if (executor === 'github_actions' && args.workflowPath === undefined) {
      const input = await text({
        message: 'Deploy workflow file:',
        placeholder: current.workflow_path,
        initialValue: current.workflow_path,
        validate(value) {
          const v = (value ?? '').trim();
          if (v.length === 0 || isValidWorkflowPath(v)) {
            return;
          }
          return 'Must be under .github/workflows/, end in .yml/.yaml, and not contain "..".';
        },
      });
      if (isCancel(input)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      workflowPath = (input as string).trim() || current.workflow_path;
    }
  } else {
    branch = args.branch ?? current.branch;
    executor = args.executor ?? current.build_executor;
  }

  const patch: {
    branch?: string;
    buildExecutor?: 'container' | 'github_actions';
    workflowPath?: string;
  } = {};
  if (branch !== current.branch) {
    patch.branch = branch;
  }
  if (executor !== current.build_executor) {
    patch.buildExecutor = executor;
  }
  if (workflowPath !== current.workflow_path) {
    patch.workflowPath = workflowPath;
  }

  if (
    patch.branch === undefined &&
    patch.buildExecutor === undefined &&
    patch.workflowPath === undefined
  ) {
    log.info(
      `No changes. ${current.repo_full_name} already deploys from ${current.branch} via ${current.build_executor}.`,
    );
    return;
  }

  let updated: GithubConnection;
  try {
    updated = await client.updateGithubConnection(projectId, patch);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const message = describeGithubClientError(err, describeUpdateError);
      if (message !== null) {
        log.error(`update: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  printSuccess(
    `Updated ${updated.repo_full_name} → branch ${updated.branch}, executor ${updated.build_executor}, workflow ${updated.workflow_path}.`,
  );
}

/** `void github status [project]`: print the project's GitHub connection. */
export async function runStatus(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'status' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  const projectId = await resolveGithubProjectId(root, client, args.projectName, 'status', isTTY);

  let connection: GithubConnection;
  try {
    connection = await client.getGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const message = describeGithubClientError(err, describeUpdateError);
      if (message !== null) {
        log.error(`status: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  log.message(formatConnection(connection));
}

/**
 * `void github disconnect [project]`. The server cancels in-flight builds before
 * it removes the connection, so a TTY run confirms first.
 */
export async function runGithubDisconnect(
  root: string,
  client: PlatformClient,
  args: Extract<GithubArgs, { subcommand: 'disconnect' }>,
): Promise<void> {
  const isTTY = process.stdin.isTTY === true;

  const projectId = await resolveGithubProjectId(
    root,
    client,
    args.projectName,
    'disconnect',
    isTTY,
  );

  let connection: GithubConnection;
  try {
    connection = await client.getGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      // No connection is already the goal state.
      if (err.status === 404 && err.code?.includes('connection not found')) {
        log.info('This project is not connected to a GitHub repository. Nothing to disconnect.');
        return;
      }
      const message = describeGithubClientError(err, describeConnectError);
      if (message !== null) {
        log.error(`disconnect: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  if (!args.yes) {
    if (!isTTY) {
      log.error(
        'disconnect: Refusing to disconnect without confirmation in a non-interactive shell. Re-run with --yes.',
      );
      process.exit(1);
    }
    const ok = await confirm({
      message: `Disconnect ${connection.repo_full_name} from this project? This cancels any in-flight builds.`,
      initialValue: false,
    });
    if (isCancel(ok)) {
      cancel('Cancelled.');
      process.exit(0);
    }
    if (!ok) {
      log.info('Disconnect cancelled.');
      return;
    }
  }

  try {
    await client.deleteGithubConnection(projectId);
  } catch (err) {
    if (err instanceof PlatformApiError) {
      const message = describeGithubClientError(err, describeConnectError);
      if (message !== null) {
        log.error(`disconnect: ${message}`);
        process.exit(1);
      }
    }
    throw err;
  }

  printSuccess(`Disconnected ${connection.repo_full_name}.`);
}
