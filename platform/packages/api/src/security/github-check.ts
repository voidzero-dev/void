/**
 * The `Void Security Audit` GitHub check (design doc 0095 M28, spec §11.3). Hosted
 * only: GitHub needs the `managedBuilds` capability.
 *
 *   scan ingest (control.ts, after commit)
 *     └► reportSecurityScanToGitHub
 *          deployment built by a platform build (container / GitHub Actions)?
 *          connection still covered by an active installation?
 *          ├► check run on the build's commit: created, then completed `neutral`
 *          │    title + summary: urgent counts and the landing link only
 *          └► open PRs whose head is that commit: one comment per project, edited
 *               in place (counts only; new only while something is urgent)
 *
 *   check_run:rerequested for this name (webhooks.ts)
 *     └► handleSecurityCheckRerequest
 *          sender's GitHub account → Void user with `settings` on the project
 *          the check's deployment is still live ─► project rescan, else no-op
 *
 * Everything here is best-effort: it never fails, delays or changes a deploy, a
 * build or a scan (D45). The conclusion is always `neutral`: "no findings" is not
 * "safe", and an informational check must never pass or fail branch protection on
 * its own.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import { installationCoversRepo } from '../db/github-authority.ts';
import { getUserByOAuthAccount } from '../db/users.ts';
import type { ApiEnv } from '../env.ts';
import { completeCheckRun, createCheckRun } from '../github/check-run.ts';
import {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  getInstallationToken,
} from '../github/installation-token.ts';
import { OperatorError } from '../operator/common.ts';
import { getPlatformApiUrl } from '../platform-identity.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  requireProjectCapability,
} from '../project-access.ts';
import {
  builds,
  deploymentOperations,
  deployments,
  githubConnections,
  projects,
} from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import { pokeSecurityScanScheduler } from './enqueue.ts';
import { queueSecurityRescan } from './operator.ts';
import { effectiveSeverity } from './project-view.ts';
import { securityFindings, securityScans } from './schema.ts';
import type { SecurityScanStatus } from './schema.ts';

/** The check name, and what a `check_run:rerequested` delivery matches on. */
export const VOID_SECURITY_AUDIT_CHECK_RUN_NAME = 'Void Security Audit';

/** Ended scans that report. Skipped, superseded and canceled scans ran nothing. */
const REPORTED_STATUSES: ReadonlySet<SecurityScanStatus> = new Set<SecurityScanStatus>([
  'succeeded',
  'incomplete',
  'failed',
  'refused',
  'timed_out',
]);

/** At most this many open pull requests get a comment for one commit. */
export const SECURITY_PR_COMMENT_MAX_PULLS = 5;
/** Pages of 100 comments searched for our earlier comment on one pull request. */
const COMMENT_SEARCH_PAGES = 3;
const GITHUB_TIMEOUT_MS = 10_000;

export type SecurityUrgentCounts = Readonly<{ critical: number; high: number }>;

export type SecurityGitHubCheckCopyInput = Readonly<{
  slug: string;
  counts: SecurityUrgentCounts;
  status: SecurityScanStatus;
  statusReason: string | null;
  /** The sign-in-free landing page, or `null` when the API URL is not known. */
  landingUrl: string | null;
}>;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function severityParts(counts: SecurityUrgentCounts): string {
  const parts: Array<string> = [];
  if (counts.critical > 0) {
    parts.push(`${counts.critical} critical`);
  }
  if (counts.high > 0) {
    parts.push(`${counts.high} high`);
  }
  return parts.join(', ');
}

/** `failed` reasons about the project's own code or input; the rest are the platform's. */
const PROJECT_FAILURE_REASONS: ReadonlySet<string> = new Set(['bad_output', 'input_missing']);

/**
 * Why a scan did not finish, or `''` when no public reason is given, or `null` when it
 * did finish. `refused`, `timed out`, or a project-cause `failed` reason (`bad output`,
 * `input missing`). A platform-side reason (`credits`, `infrastructure`) is not about
 * the user's code and check runs on a public repository are public, so it is left out.
 */
function unfinishedWhy(status: SecurityScanStatus, reason: string | null): string | null {
  if (status === 'refused' || status === 'timed_out') {
    return status.split('_').join(' ');
  }
  if (status === 'failed') {
    return reason !== null && PROJECT_FAILURE_REASONS.has(reason)
      ? reason.split('_').join(' ')
      : '';
  }
  return null;
}

/** The urgent-findings sentence: counts only, never a title, file or line. */
function urgentSentence(slug: string, counts: SecurityUrgentCounts): string {
  const urgent = counts.critical + counts.high;
  if (urgent === 0) {
    return `No urgent security findings are open in ${slug}.`;
  }
  return `${urgent} urgent security ${plural(urgent, 'finding is', 'findings are')} open in ${slug} (${severityParts(counts)}).`;
}

/**
 * The check run's title and summary (spec §11.3). Counts and the landing link only:
 * check runs on a public repository are public.
 */
type SecurityGitHubCheckText = Readonly<{ title: string; summary: string }>;

export function securityGitHubCheckCopy(
  input: SecurityGitHubCheckCopyInput,
): SecurityGitHubCheckText {
  const urgent = input.counts.critical + input.counts.high;
  const why = unfinishedWhy(input.status, input.statusReason);
  const because = why ? ` (${why})` : '';
  const title =
    why !== null
      ? `Security scan did not finish${because}`
      : urgent === 0
        ? 'No urgent security findings'
        : `${urgent} urgent security ${plural(urgent, 'finding', 'findings')} (${severityParts(input.counts)})`;
  const lines: Array<string> = [];
  if (why !== null) {
    lines.push(`The security scan of this commit did not finish${because}.`);
  } else if (input.status === 'incomplete') {
    lines.push('The security scan of this commit did not cover everything (incomplete).');
  }
  lines.push(
    `${urgentSentence(input.slug, input.counts)} Deploys are not affected. Review: void project security open --project ${input.slug}`,
  );
  if (input.landingUrl !== null) {
    lines.push(input.landingUrl);
  }
  return { title, summary: lines.join('\n\n') };
}

/** The hidden line that finds our comment again: one comment per project and PR. */
export function securityPullRequestCommentMarker(projectId: string): string {
  return `<!-- void-security-audit:${projectId} -->`;
}

/** The PR comment: counts and the landing link only, like the check run. */
export function securityPullRequestComment(
  input: Readonly<{
    projectId: string;
    slug: string;
    counts: SecurityUrgentCounts;
    landingUrl: string | null;
  }>,
): string {
  const lines = [
    securityPullRequestCommentMarker(input.projectId),
    `**Void security audit**: ${urgentSentence(input.slug, input.counts)} Deploys are not affected.`,
    `Review: \`void project security open --project ${input.slug}\``,
  ];
  if (input.landingUrl !== null) {
    lines.push(input.landingUrl);
  }
  return lines.join('\n\n');
}

function isFullCommitSha(value: string | null): value is string {
  if (value === null || value.length !== 40) {
    return false;
  }
  for (const char of value) {
    const isHex = (char >= '0' && char <= '9') || (char >= 'a' && char <= 'f');
    if (!isHex && !(char >= 'A' && char <= 'F')) {
      return false;
    }
  }
  return true;
}

function landingUrl(env: ApiEnv['Bindings'], slug: string): string | null {
  try {
    return new URL(`/security/projects/${encodeURIComponent(slug)}`, getPlatformApiUrl(env)).href;
  } catch {
    return null;
  }
}

/** Open, confirmed, critical/high findings of the project, by severity. */
export async function readSecurityUrgentCounts(
  db: Db,
  projectId: string,
): Promise<SecurityUrgentCounts> {
  const rows = await db
    .select({ severity: effectiveSeverity, total: count() })
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, projectId),
        eq(securityFindings.state, 'open'),
        eq(securityFindings.verdict, 'confirmed'),
        sql`${effectiveSeverity} IN ('critical', 'high')`,
      ),
    )
    .groupBy(effectiveSeverity);
  const counts = { critical: 0, high: 0 };
  for (const row of rows) {
    if (row.severity === 'critical' || row.severity === 'high') {
      counts[row.severity] += row.total;
    }
  }
  return counts;
}

type CheckTarget = Readonly<{
  installationId: string;
  repoFullName: string;
  repositoryId: string;
  headSha: string;
}>;

/**
 * Where the check goes: the commit a platform build built, in the project's connected
 * repository. A deploy with no platform build (a CLI deploy from a laptop) only claims
 * its commit, so it gets no check: GitHub may not know the commit, and the code that
 * went live may not be it.
 */
async function securityCheckTarget(
  db: Db,
  projectId: string,
  deploymentId: string,
): Promise<CheckTarget | null> {
  const [deployment] = await db
    .select({ commit: deployments.commit })
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId)))
    .limit(1);
  if (!deployment) {
    return null;
  }
  const [operation] = await db
    .select({ buildId: deploymentOperations.build_id })
    .from(deploymentOperations)
    .where(eq(deploymentOperations.id, deploymentId))
    .limit(1);
  const [build] = await db
    .select({ id: builds.id, projectId: builds.project_id, commitSha: builds.commit_sha })
    .from(builds)
    .where(
      operation?.buildId
        ? eq(builds.id, operation.buildId)
        : eq(builds.deployment_id, deploymentId),
    )
    .limit(1);
  if (!build || build.projectId !== projectId || !isFullCommitSha(build.commitSha)) {
    return null;
  }
  if (deployment.commit !== null && deployment.commit !== build.commitSha) {
    // The deploy claimed another commit than the build built (or its OIDC `sha`).
    return null;
  }
  const [connection] = await db
    .select({
      id: githubConnections.id,
      installationId: githubConnections.installation_id,
      repoFullName: githubConnections.repo_full_name,
      repositoryId: githubConnections.repository_id,
    })
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.project_id, projectId),
        // `builds` keeps no repository. A reconnect replaces the connection row, so a
        // build older than it may come from another repository (a fork or mirror can
        // hold the same commit): send nothing rather than report on the wrong repo.
        sql`${githubConnections.created_at} <= (SELECT ${builds.created_at} FROM ${builds} WHERE ${builds.id} = ${build.id})`,
      ),
    )
    .limit(1);
  if (
    !connection ||
    !(await installationCoversRepo(
      db,
      connection.id,
      projectId,
      connection.installationId,
      connection.repositoryId,
    ))
  ) {
    return null;
  }
  return {
    installationId: connection.installationId,
    repoFullName: connection.repoFullName,
    repositoryId: connection.repositoryId,
    headSha: build.commitSha,
  };
}

export type SecurityGitHubReport =
  | Readonly<{ reported: false; reason: string }>
  | Readonly<{ reported: true; checkRunId: string | null; comments: number }>;

/**
 * Reports an ended scan on GitHub. Never throws; `reported: false` says why nothing
 * was sent. Called once per stored result (the attempt fence makes ingest happen once).
 */
export async function reportSecurityScanToGitHub(
  env: ApiEnv['Bindings'],
  db: Db,
  scanId: string,
): Promise<SecurityGitHubReport> {
  try {
    const capabilities = getPlatformCapabilities(env);
    if (!capabilities.managedBuilds || !capabilities.securityAudits) {
      return { reported: false, reason: 'not hosted' };
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
      return { reported: false, reason: 'no GitHub App' };
    }
    const [scan] = await db
      .select({
        projectId: securityScans.project_id,
        deploymentId: securityScans.deployment_id,
        status: securityScans.status,
        statusReason: securityScans.status_reason,
        slug: projects.slug,
      })
      .from(securityScans)
      .innerJoin(projects, eq(projects.id, securityScans.project_id))
      .where(eq(securityScans.id, scanId))
      .limit(1);
    if (!scan || scan.deploymentId === null) {
      return { reported: false, reason: 'no deployment' };
    }
    if (!REPORTED_STATUSES.has(scan.status)) {
      return { reported: false, reason: 'not ended' };
    }
    const target = await securityCheckTarget(db, scan.projectId, scan.deploymentId);
    if (target === null) {
      return { reported: false, reason: 'no GitHub build' };
    }
    const counts = await readSecurityUrgentCounts(db, scan.projectId);
    const link = landingUrl(env, scan.slug);
    const copy = securityGitHubCheckCopy({
      slug: scan.slug,
      counts,
      status: scan.status,
      statusReason: scan.statusReason,
      landingUrl: link,
    });
    const checkRunId = await createCheckRun(env, target.installationId, target.repoFullName, {
      name: VOID_SECURITY_AUDIT_CHECK_RUN_NAME,
      headSha: target.headSha,
      // What `check_run:rerequested` reads back to find the project.
      externalId: scanId,
      ...(link ? { detailsUrl: link } : {}),
      title: copy.title,
      summary: copy.summary,
    });
    if (checkRunId !== null) {
      await completeCheckRun(env, target.installationId, target.repoFullName, checkRunId, {
        conclusion: 'neutral',
        ...(link ? { detailsUrl: link } : {}),
        title: copy.title,
        summary: copy.summary,
      });
    }
    const comments = await updatePullRequestComments(env, target, {
      projectId: scan.projectId,
      body: securityPullRequestComment({
        projectId: scan.projectId,
        slug: scan.slug,
        counts,
        landingUrl: link,
      }),
      urgent: counts.critical + counts.high > 0,
    });
    return { reported: true, checkRunId, comments };
  } catch (error) {
    console.warn('[security-scan] GitHub check failed', {
      scanId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { reported: false, reason: 'error' };
  }
}

async function github(
  token: string,
  path: string,
  init: Readonly<{ method?: string; body?: unknown }> = {},
): Promise<Response> {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'void-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

type PullSummary = Readonly<{
  number?: unknown;
  state?: unknown;
  head?: Readonly<{ sha?: unknown }> | null;
}>;
type CommentSummary = Readonly<{
  id?: unknown;
  body?: unknown;
  user?: Readonly<{ type?: unknown; login?: unknown }> | null;
  performed_via_github_app?: Readonly<{ id?: unknown; client_id?: unknown }> | null;
}>;

/**
 * A comment our App wrote. The marker alone is not enough: it shows in our comment on
 * a public repository, so another App or a workflow bot can copy it, and editing that
 * comment would be refused.
 */
function isOurAppComment(env: ApiEnv['Bindings'], comment: CommentSummary): boolean {
  const app = comment.performed_via_github_app;
  // `GITHUB_APP_ID` is the App's numeric id or (as a JWT issuer) its client id.
  if (
    app &&
    env.GITHUB_APP_ID &&
    ((typeof app.id === 'number' && String(app.id) === env.GITHUB_APP_ID) ||
      app.client_id === env.GITHUB_APP_ID)
  ) {
    return true;
  }
  return (
    comment.user?.type === 'Bot' &&
    Boolean(env.GITHUB_APP_SLUG) &&
    comment.user.login === `${env.GITHUB_APP_SLUG}[bot]`
  );
}

/** Our earlier comment: its id, `'none'` when the whole list was read, else `'unknown'`. */
type CommentLookup = number | 'none' | 'unknown';

async function findOurComment(
  env: ApiEnv['Bindings'],
  token: string,
  repo: string,
  pull: number,
  marker: string,
): Promise<CommentLookup> {
  for (let page = 1; page <= COMMENT_SEARCH_PAGES; page++) {
    const res = await github(
      token,
      `/repos/${repo}/issues/${pull}/comments?per_page=100&page=${page}`,
    );
    if (!res.ok) {
      await res.body?.cancel();
      return 'unknown';
    }
    const comments = await res.json<unknown>();
    if (!Array.isArray(comments)) {
      return 'unknown';
    }
    for (const comment of comments as ReadonlyArray<CommentSummary>) {
      if (
        typeof comment.id === 'number' &&
        typeof comment.body === 'string' &&
        comment.body.startsWith(marker) &&
        isOurAppComment(env, comment)
      ) {
        return comment.id;
      }
    }
    if (comments.length < 100) {
      return 'none';
    }
  }
  // A longer list than we read: our comment may be further on.
  return 'unknown';
}

/**
 * The PR comment (counts only). One per project and PR, edited in place; a new one is
 * posted only while something is urgent, so a clean scan never adds noise. Needs the
 * App's `Pull requests: write` permission: without it the scoped token cannot be
 * minted and nothing is sent. Returns how many comments were written.
 */
async function updatePullRequestComments(
  env: ApiEnv['Bindings'],
  target: CheckTarget,
  comment: Readonly<{ projectId: string; body: string; urgent: boolean }>,
): Promise<number> {
  let token: string;
  try {
    token = await getInstallationToken(env, target.installationId, {
      repositoryIds: [target.repositoryId],
      permissions: { pull_requests: 'write' },
    });
  } catch {
    // The installation has not granted `pull_requests: write`.
    return 0;
  }
  const res = await github(
    token,
    `/repos/${target.repoFullName}/commits/${target.headSha}/pulls?per_page=30`,
  );
  if (!res.ok) {
    await res.body?.cancel();
    return 0;
  }
  const pulls = await res.json<unknown>();
  if (!Array.isArray(pulls)) {
    return 0;
  }
  const open = (pulls as ReadonlyArray<PullSummary>)
    .filter(
      (pull): pull is PullSummary & { number: number } =>
        typeof pull.number === 'number' &&
        pull.state === 'open' &&
        pull.head?.sha === target.headSha,
    )
    .slice(0, SECURITY_PR_COMMENT_MAX_PULLS);
  const marker = securityPullRequestCommentMarker(comment.projectId);
  let written = 0;
  for (const pull of open) {
    try {
      const existing = await findOurComment(env, token, target.repoFullName, pull.number, marker);
      if (existing === 'unknown') {
        // Posting now could add a second comment: skip this PR until a later scan.
        console.warn('[security-scan] GitHub PR comments could not be read', {
          repo: target.repoFullName,
          pull: pull.number,
        });
        continue;
      }
      if (existing === 'none' && !comment.urgent) {
        continue;
      }
      const sent =
        existing === 'none'
          ? await github(token, `/repos/${target.repoFullName}/issues/${pull.number}/comments`, {
              method: 'POST',
              body: { body: comment.body },
            })
          : await github(token, `/repos/${target.repoFullName}/issues/comments/${existing}`, {
              method: 'PATCH',
              body: { body: comment.body },
            });
      await sent.body?.cancel();
      if (sent.ok) {
        written++;
      }
    } catch (error) {
      console.warn('[security-scan] GitHub PR comment failed', {
        repo: target.repoFullName,
        pull: pull.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return written;
}

export type SecurityCheckRerequest = Readonly<{
  installationId: unknown;
  repositoryId: unknown;
  /** The check run's `external_id`: the scan it reported. */
  externalId: unknown;
  /** The GitHub user who clicked Re-run. */
  senderId: unknown;
}>;

export type SecurityCheckRerequestResult =
  | Readonly<{ ok: true; queued: string }>
  | Readonly<{ ok: true; ignored: string }>;

function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return typeof value === 'string' && value !== '' && value.length <= 64 ? value : null;
}

const ignored = (reason: string): SecurityCheckRerequestResult => ({ ok: true, ignored: reason });

/**
 * GitHub's Re-run button on a `Void Security Audit` check: a project rescan of the live
 * deployment, only when the clicker could ask for one in Void (a linked GitHub sign-in
 * with `settings` on the project) and the check is about the live deployment.
 * Everything else is a no-op that writes nothing to GitHub. Rescan rules (policy
 * scope, one scan at a time, stored code, monthly caps at start) are the project
 * rescan's.
 */
export async function handleSecurityCheckRerequest(
  env: ApiEnv['Bindings'],
  db: Db,
  request: SecurityCheckRerequest,
): Promise<SecurityCheckRerequestResult> {
  if (!getPlatformCapabilities(env).securityAudits) {
    return ignored('security audits are off');
  }
  const installationId = idText(request.installationId);
  const repositoryId = idText(request.repositoryId);
  const scanId = idText(request.externalId);
  const senderId = idText(request.senderId);
  if (!installationId || !repositoryId || !scanId || !senderId) {
    return ignored('missing security check fields');
  }
  const [scan] = await db
    .select({
      projectId: securityScans.project_id,
      deploymentId: securityScans.deployment_id,
      live: projects.active_deployment_id,
    })
    .from(securityScans)
    .innerJoin(projects, eq(projects.id, securityScans.project_id))
    .where(eq(securityScans.id, scanId))
    .limit(1);
  if (!scan) {
    return ignored('scan not found');
  }
  const [connection] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.project_id, scan.projectId),
        eq(githubConnections.installation_id, installationId),
        eq(githubConnections.repository_id, repositoryId),
      ),
    )
    .limit(1);
  if (
    !connection ||
    !(await installationCoversRepo(db, connection.id, scan.projectId, installationId, repositoryId))
  ) {
    return ignored('repository is not connected to the project');
  }
  const user = await getUserByOAuthAccount(db, 'github', senderId);
  if (!user || isAdminSuspended(user.suspended_reason)) {
    return ignored('sender cannot rescan');
  }
  try {
    await requireProjectCapability(db, scan.projectId, user.id, 'settings');
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return ignored('sender cannot rescan');
    }
    throw error;
  }
  if (scan.deploymentId === null || scan.deploymentId !== scan.live) {
    return ignored('check is not about the live deployment');
  }
  try {
    const { scanId: queued } = await queueSecurityRescan(env, db, scan.projectId, {
      by: 'project',
    });
    await pokeSecurityScanScheduler(env);
    return { ok: true, queued };
  } catch (error) {
    if (error instanceof OperatorError) {
      return ignored(error.code);
    }
    throw error;
  }
}
