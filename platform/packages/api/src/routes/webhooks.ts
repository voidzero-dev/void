import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ACTIVE_BUILD_STATUSES,
  deleteGitHubConnection,
  deleteGitHubInstallationMembers,
  deleteGitHubInstallationMembersByGithubAccount,
  getBuild,
  getBuildByProjectRunIdAndAttempt,
  getDeploymentByProjectAndCommit,
  getGitHubConnectionsByRepo,
  getGitHubInstallation,
  getGitHubInstallationsByAccount,
  getUserByOAuthAccount,
  markBuildTerminalIfActive,
  markGitHubInstallationStatus,
  recordInstallationRevocations,
  setGitHubInstallationRepositories,
  supersedeAndCreateContainerBuild,
  suspendGitHubInstallation,
  terminateBuildsForProject,
  unsuspendGitHubInstallation,
  updateGitHubConnectionRepoNamesByRepoId,
  upsertGitHubInstallation,
} from '../db.ts';
import type { Db } from '../db.ts';
import type { TerminatedBuild } from '../db/builds.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import {
  VOID_BUILD_CHECK_RUN_NAME,
  completeCheckRun,
  preservedCheckRunConclusion,
  type CheckRunConclusion,
} from '../github/check-run.ts';
import { listInstallationRepositories } from '../github/installation-repos.ts';
import {
  getBranchExistence,
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from '../github/installation-token.ts';
import {
  GitHubWebhookRequestError,
  readBoundedGitHubWebhookBody,
  readGitHubWebhookHeaders,
} from '../github/webhook-ingress-auth.ts';
import { verifyGithubWebhookSignature } from '../github/webhook-verify.ts';
import { githubConnections, githubInstallations } from '../schema.ts';
import type { GitHubInstallationRepository } from '../schema.ts';
import {
  handleSecurityCheckRerequest,
  VOID_SECURITY_AUDIT_CHECK_RUN_NAME,
} from '../security/github-check.ts';
import type { Build } from '../types.ts';

const app = new Hono<ApiEnv>();

// A push to a deleted branch carries an all-zero `after` SHA — there's nothing
// to build, so we skip it.
const ZERO_SHA = '0000000000000000000000000000000000000000';

type PushPayload = {
  ref?: string;
  after?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
};

type InstallationPayload = {
  action?: string;
  installation?: {
    id?: number | string;
    account?: {
      login?: string;
      id?: number | string;
      type?: string;
    };
    // GitHub reports the install's `repository_selection` (`all` | `selected`)
    // on the installation object.
    repository_selection?: string;
  };
  repositories?: ReadonlyArray<{ full_name?: string; id?: number }>;
};

type OrganizationPayload = {
  action?: string;
  organization?: { id?: number | string };
  membership?: { user?: { id?: number | string } };
};

type InstallationRepositoriesPayload = {
  action?: string;
  installation?: { id?: number | string };
  repositories_added?: ReadonlyArray<{ full_name?: string; id?: number }>;
  repositories_removed?: ReadonlyArray<{ full_name?: string; id?: number }>;
  // The post-change accessible set is not delivered directly; we maintain it
  // by reading the installation's current selection and applying the delta.
  repository_selection?: string;
};

// `check_run:rerequested` — GitHub's per-check "Re-run" button. `check_suite`
// carries the branch; `external_id` is the build id we stamped at create time
// (`createCheckRun` requires it, so every run we publish carries one) and it is
// what makes a per-check rerun hit ONE project. A repo can back several projects
// on the SAME branch — `project_id` is unique on `github_connections`, the repo
// and branch are not — so each publishes its own "Void Build" run on the same
// commit. Resolving by repo + branch alone would rebuild every one of them from a
// click on a single check, and could enqueue a container build from a click on
// another project's `github_actions` check. The id NARROWS the fan-out; it never
// widens it or authorizes anything, and the branch-head freshness gate below
// still decides whether the rebuild may happen at all.
type CheckRunPayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
  check_run?: {
    id?: number | string;
    name?: string;
    head_sha?: string;
    external_id?: string | null;
    // The run's EXISTING conclusion. A refused rerun echoes it back rather than
    // writing one of its own.
    conclusion?: string | null;
    check_suite?: { head_branch?: string | null };
  };
  // The GitHub user who clicked Re-run. Read only for the security check (M28).
  sender?: { id?: number | string };
};

// `check_suite:rerequested` — GitHub's "Re-run all checks" button.
type CheckSuitePayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
  check_suite?: { head_sha?: string; head_branch?: string | null };
};

type WorkflowRunPayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string; id?: number | string };
  workflow_run?: {
    id?: number | string;
    run_attempt: number | string;
    conclusion?: string | null;
    head_sha?: string;
  };
};

// GitHub's `workflow_run.conclusion` → a GitHub Checks conclusion. The
// "Void Build" check reports GitHub's RUN outcome (not our internal build
// status), so it is driven straight from this payload field. GitHub Checks
// accepts success | failure | cancelled | timed_out (among others); we map the
// non-success outcomes we care about faithfully and collapse everything else
// (action_required, neutral, skipped, stale, startup_failure, null) to
// 'failure'.
function mapWorkflowRunConclusion(conclusion: string | null | undefined): CheckRunConclusion {
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'timed_out';
    default:
      return 'failure';
  }
}

function normalizeRepositories(
  repos: ReadonlyArray<{ full_name?: string; id?: number }> | undefined,
): ReadonlyArray<GitHubInstallationRepository> {
  if (!repos) {
    return [];
  }
  return repos
    .filter((r): r is { full_name: string; id: number } => {
      return typeof r.full_name === 'string' && typeof r.id === 'number';
    })
    .map((r) => ({ full_name: r.full_name, id: r.id }));
}

// Map GitHub's `repository_selection` to the stored enum. Only the literal
// `'all'` grants every repo; anything else (including a missing field) is the
// safe `'selected'` default so an unknown/garbled value never loosens access.
function normalizeRepositorySelection(value: string | undefined): 'all' | 'selected' {
  return value === 'all' ? 'all' : 'selected';
}

/**
 * Poke the scheduler DO so it wakes immediately rather than waiting for its
 * next alarm. Best-effort: a failed poke is recovered on the next scheduled
 * wake. DO→DO fetch is permitted here (the no-`.fetch` rule only forbids
 * dispatching to user workers).
 */
async function pokeBuildScheduler(env: ApiEnv['Bindings']): Promise<void> {
  try {
    const scheduler = env.BUILD_SCHEDULER.get(env.BUILD_SCHEDULER.idFromName('global'));
    await scheduler.fetch('https://scheduler/poke', { method: 'POST' });
  } catch (err) {
    console.error('[webhooks] failed to poke build scheduler:', err);
  }
}

/**
 * Re-run a build for an already-pushed commit, driven by GitHub's "Re-run" /
 * "Re-run all checks" buttons (`check_run:rerequested` / `check_suite:rerequested`).
 *
 * Deliberately reuses the PUSH pipeline rather than inventing a second way to
 * enqueue: same connection resolution, same renamed-repo self-heal, same
 * fail-closed branch-head freshness gate, same `supersedeAndCreateContainerBuild`.
 * A re-run must not become a back door that deploys a commit a push could not.
 *
 * AUTHORIZATION is the same shape as `push`: the payload is HMAC-verified and
 * bound to an installation we know, and GitHub only offers the button to users
 * with write access on the repo. We add nothing on top, and `sender` is ignored.
 *
 * That is NOT strictly weaker than push, and the difference is deliberate rather
 * than overlooked. Branch protection can restrict pushes to `main` to named
 * users, teams, or apps while everyone else keeps repo write — so the set of
 * people who can click Re-run is a SUPERSET of the set who can push the branch.
 * The freshness gate bounds what that buys them: the only commit they can build
 * is the branch head, which our push pipeline already built and deployed. The one
 * real capability is re-deploying the current head, which matters when a rollback
 * is active — a rerun can roll forward onto the branch head again. We accept it,
 * because the alternative is mapping GitHub actors to per-project deploy rights,
 * and a connection carries exactly one Void user; gating on `sender` would break
 * ordinary team use to close a hole bounded by "redeploy what is already HEAD".
 *
 * FRESHNESS is what makes it safe. The head SHA must still be the connected
 * branch's head (`identical`), so re-running an old check cannot roll production
 * back to an abandoned commit. Re-running a check on a superseded commit is
 * therefore an intentional no-op.
 *
 * A `check_suite` refusal reports NOTHING, deliberately. The Checks API cannot
 * conclude a suite at all — GitHub derives that from the runs — and the suite
 * payload carries no run ids.
 *
 * Run ids must not be derived from our own build rows: the row is not
 * authoritative for the `github_actions` executor, whose check is completed
 * straight from `workflow_run.conclusion` independent of the status CAS, so a
 * `cancelled` row can carry a published `success` and rewriting it from the row
 * would turn a passing required check into a blocking one.
 *
 * A bounded read DOES exist (`GET /repos/{o}/{r}/check-suites/{id}/check-runs`
 * with `check_name` + `per_page`), so cost is not the objection. The objection is
 * that the premise is unverified: it is not established that GitHub leaves our
 * runs needing resolution at all — a suite rerequest resets the SUITE's own state,
 * and a run that kept its conclusion is not pending. Re-PATCHing a run with the
 * conclusion it already has, hoping the suite recomputes, is a guess about GitHub
 * internals. Verify it against a real suite rerequest on staging before building
 * on it.
 *
 * DEDUP falls out of the shared helper: a `failed` build for the commit is never
 * reused, so the failing case this exists for always enqueues fresh work. A
 * commit whose build already succeeded AND is live reuses that build and enqueues
 * nothing — the check is green and there is nothing to redo.
 *
 * `github_actions` connections cannot be re-run from here: their build is driven
 * by the workflow, and nothing in the Checks API can start one. They report an
 * explicit ignore rather than silently doing nothing.
 */
async function rerunBuildForCommit(
  context: Context<ApiEnv>,
  db: Db,
  args: {
    installationId: number | string | undefined;
    repoFullName: string | undefined;
    repoId: number | string | undefined;
    headSha: string | undefined;
    event: string;
    // Present only for `check_run`: the run the user actually clicked. `buildId`
    // narrows the rebuild to that run's project; `checkRunId` lets an accepted
    // request that enqueues nothing say so ON the check instead of leaving the
    // button looking broken.
    checkRun?: { id: string | null; buildId: string | null; conclusion: unknown };
  },
) {
  const { installationId, repoFullName, repoId, headSha, event, checkRun } = args;

  // GitHub flips the suite back to `queued` the moment the button is clicked. If
  // we then enqueue nothing and say nothing, the user sees a Re-run that does
  // nothing. Every no-op path reports through `completeRerun` below.
  //
  // What a REFUSAL writes: the conclusion the run already had. Never a passing
  // conclusion we did not earn — GitHub counts `neutral`/`skipped` as passing for
  // a required status check, so writing one for a build that never ran would let
  // anyone with rerun rights clear branch protection.
  const refusedConclusion = preservedCheckRunConclusion(checkRun?.conclusion);
  const completeRerun = async (conclusion: CheckRunConclusion, title: string, summary: string) => {
    // Called with `refusedConclusion` for a refusal, or 'success' only for a build
    // that authoritatively completed and is live.
    if (!checkRun?.id || installationId === undefined || installationId === null || !repoFullName) {
      return;
    }
    // OFF the response path. `completeCheckRun` mints a token and retries
    // internally, none of it against a clock, while GitHub drops a webhook delivery
    // we have not answered in 10 seconds — and does NOT redeliver a failure
    // automatically, so a lost delivery has to be replayed by hand. Racing a
    // deadline here would not bound the handler anyway: the DB work, the
    // compare call and the supersede transaction all run before this point.
    //
    // `waitUntil` is the shape the `workflow_run` completion already uses: the
    // call STARTS synchronously (so it cannot be skipped) and the Worker stays
    // alive for it after the 2xx.
    const runId = checkRun.id;
    const reported = completeCheckRun(context.env, String(installationId), repoFullName, runId, {
      conclusion,
      title,
      summary,
    })
      .then((patched) => {
        if (!patched) {
          // `completeCheckRun` RESOLVES false on a non-2xx; it does not throw.
          console.warn(`[webhooks] rerun report for check run ${runId} was rejected by GitHub`);
        }
      })
      .catch((err: unknown) => {
        console.error('[webhooks] failed to report rerun no-op:', err);
      });
    try {
      context.executionCtx.waitUntil(reported);
    } catch {
      // No execution context (a bare `app.request` in a test, say). The call is
      // already in flight; a missing lifetime extension must not 500 a webhook.
      void reported;
    }
  };

  if (
    installationId === undefined ||
    installationId === null ||
    !repoFullName ||
    repoId === undefined ||
    repoId === null ||
    typeof headSha !== 'string' ||
    headSha === ''
  ) {
    return context.json({ ok: true, ignored: `missing ${event} routing fields` });
  }

  const repoIdStr = String(repoId);
  const connections = await getGitHubConnectionsByRepo(db, String(installationId), repoIdStr);

  // Same self-heal as the push path: a connection matched by immutable id may
  // carry a stale name, and the container build uses that name as its tarball
  // source.
  if (connections.some((c) => c.repo_full_name !== repoFullName)) {
    await updateGitHubConnectionRepoNamesByRepoId(
      db,
      String(installationId),
      repoIdStr,
      repoFullName,
    );
  }

  // `head_branch` is NOT a filter. GitHub keeps one suite per app per commit even
  // when that commit is the head of SEVERAL branches, so the suite reports one of
  // them — and filtering on it would drop the connection for a project tracking
  // the other branch at the same SHA. The per-branch freshness gate below is what
  // decides, and it is exact: a connection whose branch head is not this commit
  // fails `identical` and is skipped anyway.
  // A per-check rerun targets the ONE project whose build published that check,
  // which `external_id` names exactly. Several projects can share a repo AND a
  // branch, so nothing about the branch can substitute for it.
  let candidates = connections;
  if (checkRun) {
    // FAIL CLOSED. Falling back to the branch set here would reopen the very
    // fan-out this narrowing exists to close, and the case is reachable: deleting
    // a project cascades away its build rows while GitHub keeps the check runs for
    // months, so an old check could enqueue builds for sibling projects owned by
    // OTHER users. A per-check rerun that cannot name its own build does nothing.
    const originating = checkRun.buildId ? await getBuild(db, checkRun.buildId) : null;
    if (!originating) {
      await completeRerun(
        refusedConclusion,
        'Nothing to rebuild',
        'The build behind this check no longer exists. Push a new commit to build again.',
      );
      return context.json({ ok: true, ignored: 'originating build not found' });
    }
    candidates = connections.filter((c) => c.project_id === originating.project_id);
  }
  if (candidates.length === 0) {
    await completeRerun(
      refusedConclusion,
      'Nothing to rebuild',
      'This repository is no longer connected to a Void project on this branch.',
    );
    return context.json({ ok: true, ignored: 'no matching connection' });
  }

  // One compare per DISTINCT branch — candidates share repo + installation, so a
  // repo backing prod and staging costs two calls, not one per project.
  //
  // Run them CONCURRENTLY. The push path affords one compare on the response
  // path; only a `check_suite` fan-out can have more than one, and awaiting them
  // in series multiplies that latency by the branch count against GitHub's 10s
  // delivery deadline — a deadline GitHub enforces by dropping the delivery, with
  // no automatic redelivery, so the click is simply lost. The compares are
  // independent (distinct keys, no read-modify-write on `freshness`) and
  // `getBranchHeadComparisonStatus` resolves rather than throws on every failure
  // path, so `Promise.all` cannot turn one bad branch into a 500. Latency
  // tracks the SLOWEST branch instead of their sum, which is the push path's cost
  // regardless of how many projects share the repo.
  //
  // Warm the installation token first. `getInstallationToken` memoizes per
  // installation, but concurrent compares on a cold cache would stampede N mints;
  // one awaited call ahead of the fan-out lets them share a single mint. Failure
  // is ignored on purpose — each compare mints and retries on its own, and this
  // call exists only to populate the cache.
  const distinctBranches = [...new Set(candidates.map((c) => c.branch))];
  if (distinctBranches.length > 1) {
    try {
      await getInstallationToken(context.env, String(installationId));
    } catch {
      // Ignored: the per-branch compares own the real retry/backoff for this.
    }
  }
  const freshness = new Map<string, boolean>();
  await Promise.all(
    distinctBranches.map(async (branch) => {
      const status = await getBranchHeadComparisonStatus(
        context.env,
        String(installationId),
        repoFullName,
        headSha,
        branch,
      );
      if (status !== 'identical') {
        console.warn(
          `[webhooks] skipping ${event} rerun for ${repoFullName}@${branch} ${headSha}: branch-head comparison ${status ?? 'unavailable'}`,
        );
      }
      freshness.set(branch, status === 'identical');
    }),
  );

  const buildIds: Array<string> = [];
  const cancelledContainerBuilds: Array<TerminatedBuild> = [];
  // A build that was REUSED and is already terminal: `supersedeAndCreateContainerBuild`
  // returns the existing `complete` row (non-null), so it LOOKS like an enqueue,
  // but nothing will ever run and nothing will ever update the check again.
  // Separate it from real work.
  const alreadyLive: Array<string> = [];
  let sawActions = false;
  for (const connection of candidates) {
    if (!freshness.get(connection.branch)) {
      continue;
    }
    if (connection.build_executor !== 'container') {
      sawActions = true;
      continue;
    }
    const { build, reused, cancelled } = await supersedeAndCreateContainerBuild(db, {
      projectId: connection.project_id,
      branch: connection.branch,
      commitSha: headSha,
      connectionId: connection.id,
      installationId: connection.installation_id,
      repositoryId: connection.repository_id,
    });
    cancelledContainerBuilds.push(...cancelled);
    if (!build) {
      continue;
    }
    // ONLY `complete` counts as already-live. The reuse branch also returns
    // `queued` rows, and `ACTIVE_BUILD_STATUSES` deliberately excludes `queued`
    // (it counts slot holders), so testing against it would report an UNRUN build
    // as deployed and skip the very poke it is waiting for. Every non-complete
    // reuse — queued, starting, building, deploying — is real work: it needs the
    // scheduler, and its DO still owns the same check-run id.
    if (reused && build.status === 'complete') {
      alreadyLive.push(build.id);
    } else {
      buildIds.push(build.id);
    }
  }

  // The supersede tx already committed (revoking tokens), so this best-effort DO
  // teardown runs outside any row lock — same ordering as the push path.
  await cancelContainerBuildDos(context.env, cancelledContainerBuilds, 'superseded by rerun');

  if (buildIds.length === 0) {
    if (sawActions) {
      // Nothing in the Checks API can start a workflow run, so this button cannot
      // do the job for an Actions-backed project. Say that rather than sit there.
      await completeRerun(
        refusedConclusion,
        'Re-run this from GitHub Actions',
        'This project builds on GitHub Actions. Re-run the workflow from the Actions tab.',
      );
      return context.json({ ok: true, ignored: 'github_actions rerun must be run from Actions' });
    }
    if (alreadyLive.length > 0) {
      // Truthful, and deliberately NOT `neutral`: this commit really did build and
      // really is live, so the run being replaced was green. Downgrading an
      // accurate success is a worse answer than restating it.
      await completeRerun(
        'success',
        'Already built and live',
        'This commit is already built and deployed. There is nothing to rebuild.',
      );
      return context.json({ ok: true, enqueued: 0, reused: alreadyLive });
    }
    if (candidates.some((c) => !freshness.get(c.branch))) {
      await completeRerun(
        refusedConclusion,
        'Commit is no longer the branch head',
        'A rerun deploys only the current head of the connected branch. Push or re-run on the newest commit.',
      );
    } else {
      // Everything left is a `skipped` reason from the supersede tx: project
      // deleting, owner suspended, connection reconfigured/replaced, or
      // installation revoked.
      await completeRerun(
        refusedConclusion,
        'Nothing to rebuild',
        'This project is not currently accepting builds for this branch.',
      );
    }
    return context.json({ ok: true, enqueued: 0 });
  }

  await pokeBuildScheduler(context.env);

  return context.json({ ok: true, buildIds });
}

/** Process a webhook whose caller has already verified its raw GitHub HMAC. */
export async function handleVerifiedGitHubWebhook(
  context: Context<ApiEnv>,
  raw: Uint8Array,
  event: string,
): Promise<Response> {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return context.json({ error: 'invalid payload' }, 400);
  }

  const db = context.get('db');

  switch (event) {
    case 'push': {
      const push = payload as PushPayload;
      const installationId = push.installation?.id;
      const repoFullName = push.repository?.full_name;
      // The immutable repo id keys connection resolution so a rename/name-reuse
      // can't deploy to the wrong project.
      const repoId = push.repository?.id;
      const ref = push.ref;
      const after = push.after;

      // Missing routing fields — accept and ignore (malformed/partial event).
      if (
        installationId === undefined ||
        installationId === null ||
        !repoFullName ||
        repoId === undefined ||
        repoId === null ||
        typeof ref !== 'string' ||
        !ref.startsWith('refs/heads/') ||
        typeof after !== 'string'
      ) {
        return context.json({ ok: true, ignored: 'unhandled push' });
      }
      const repoIdStr = String(repoId);

      // Branch delete — no source to build, but an in-flight build for the
      // now-deleted branch still holds a live deploy token: the middleware
      // guard revokes a token only once its bound build is no longer active, so
      // a queued/running build for this branch could keep publishing the deleted
      // branch's SHA until its ≤65min token TTL / the hourly reaper terminalizes
      // it. Terminalize those builds atomically — under a FOR UPDATE lock on the
      // connection rows so an in-flight OIDC exchange (which re-reads + locks the
      // same rows before inserting its build) is serialized. The DO cancel runs
      // AFTER commit. (The repoId-based stale-name self-heal below is NOT needed
      // here — a delete carries no source to build.)
      if (after === ZERO_SHA) {
        const deletedBranch = ref.slice('refs/heads/'.length);
        // Monotonic fence captured BEFORE the absence check: only builds that
        // already existed when we began confirming the branch is gone are eligible
        // for cancellation. A build enqueued during the check-to-cancel window (a
        // branch recreated + pushed in that gap) is created AFTER this instant and
        // is spared — closing the residual TOCTOU the absence check alone leaves.
        //
        // The fence is read from the DATABASE clock (`select now()`), NOT the
        // Worker clock: `builds.created_at` is stamped by Postgres `now()`, so a
        // Worker-clock fence would compare two independent clocks — under skew it
        // could clobber a recreate-race build or spare an orphan. Sourcing both
        // sides from the one Postgres clock makes the fence correct by construction.
        // `now()::text` carries the session-TZ offset and round-trips losslessly
        // through the `::timestamptz` comparison in terminateBuildsForProject.
        const fenceResult = (await db.execute(sql`select now()::text as now`)) as {
          rows: ReadonlyArray<{ now: string }>;
        };
        const deleteFenceTs = fenceResult.rows[0]?.now;
        if (deleteFenceTs === undefined) {
          // now() always returns a row; treat an empty result as a transient DB
          // fault and fail closed (skip cancellation rather than cancel unfenced).
          // The orphaned build's exposure stays bounded by the deploy-token TTL +
          // hourly reaper, so a missed cancel here is safe.
          return context.json({ ok: true, ignored: 'branch delete' });
        }

        // Staleness guard (mirrors the push path's freshness gate): GitHub does
        // NOT guarantee webhook ordering, so a delete can arrive AFTER the branch
        // was recreated and a NEW valid build enqueued — cancelling on the bare
        // event would clobber that valid build (revoke its token + tear down its
        // DO). Re-verify current git state and cancel ONLY when the branch is
        // confirmed absent. 'present' = recreated (a newer push owns the build);
        // 'unknown' = unconfirmed (transient failure / no-access) — both fail
        // closed and no-op here, because the original in-flight build's exposure
        // is already bounded by the ≤65min deploy-token TTL + the hourly reaper.
        // This check is a network round-trip, so it runs OUTSIDE/BEFORE the
        // db.transaction below — we must never hold a FOR UPDATE lock across it.
        //
        // BOUNDED LIMITATION (rename + name-reuse): this proof keys on the
        // payload's `repoFullName`, while the cancellation below keys on the
        // immutable `repository_id`. They name the
        // SAME repo at event time, but a delete delayed across a rename whose
        // freed name is then REUSED by a different repo can make this check
        // resolve to the wrong repo (or 404 → 'absent') while cancellation still
        // targets the id-matched build. Worst case: a recreated branch's OWN
        // build is wrongly cancelled (token revoked, DO torn down) — same
        // installation only, no cross-tenant reach, recoverable by the next
        // push. Closing it needs an identity-verified existence check (resolve
        // the current name for `repository_id`; treat id-mismatch / not-found as
        // 'unknown', not 'absent') — not worth the extra GitHub round-trip for a
        // window that requires rename + name-reuse + delayed-delete + recreate to
        // even occur, and whose residual exposure is already bounded by the
        // ≤65min deploy-token TTL + the hourly reaper.
        const existence = await getBranchExistence(
          context.env,
          String(installationId),
          repoFullName,
          deletedBranch,
        );
        if (existence !== 'absent') {
          return context.json({ ok: true, ignored: 'branch delete' });
        }

        const cancelled = await db.transaction(async (tx) => {
          const conns = await tx
            .select({
              project_id: githubConnections.project_id,
              repository_id: githubConnections.repository_id,
              branch: githubConnections.branch,
            })
            .from(githubConnections)
            .where(eq(githubConnections.installation_id, String(installationId)))
            .for('update');
          const acc: Array<TerminatedBuild> = [];
          for (const conn of conns) {
            // Match on the immutable repository id, like the build path.
            if (conn.repository_id !== repoIdStr || conn.branch !== deletedBranch) {
              continue;
            }
            acc.push(
              ...(await terminateBuildsForProject(tx, conn.project_id, {
                branch: deletedBranch,
                reason: 'branch deleted',
                createdBefore: deleteFenceTs,
              })),
            );
          }
          return acc;
        });
        await cancelContainerBuildDos(context.env, cancelled, 'branch deleted');
        return context.json({ ok: true, ignored: 'branch delete' });
      }

      const branch = ref.slice('refs/heads/'.length);
      const connections = await getGitHubConnectionsByRepo(db, String(installationId), repoIdStr);

      // Self-heal a renamed repo: connections matched by immutable id may carry a
      // stale repo_full_name, which the container build would use as the tarball
      // source. Correct them so the build fetches the right source.
      if (connections.some((c) => c.repo_full_name !== repoFullName)) {
        await updateGitHubConnectionRepoNamesByRepoId(
          db,
          String(installationId),
          repoIdStr,
          repoFullName,
        );
      }

      // A repo may back multiple projects (e.g. staging + prod on different
      // branches); build every connection whose branch matches this push.
      const matching = connections.filter((c) => c.branch === branch);
      if (matching.length === 0) {
        return context.json({ ok: true, ignored: 'no matching connection' });
      }

      // Fail-closed freshness gate: only build a push we can confirm IS the
      // current branch head ('identical'). 'ahead' = stale (an older push
      // delivered out-of-order after a newer one), 'behind' = the branch head no
      // longer contains `after` (the branch was moved BACKWARD off it via
      // force-push/rollback, so `after` is an abandoned commit), 'diverged' =
      // off-branch (force-pushed away), null = compare API unreachable. In every
      // non-'identical' case, do NOT supersede the existing queued build — leave
      // the last known-good work intact rather than risk cancelling newer work and
      // deploying a stale/abandoned commit. The newer push's own webhook builds the
      // true head. Checked once per push — all matching connections share repo+
      // branch+installation.
      const headComparison = await getBranchHeadComparisonStatus(
        context.env,
        String(installationId),
        repoFullName,
        after,
        branch,
      );
      if (headComparison !== 'identical') {
        console.warn(
          `[webhooks] skipping push for ${repoFullName}@${branch} ${after}: branch-head comparison ${headComparison ?? 'unavailable'}`,
        );
        return context.json({ ok: true, ignored: 'push is not the current branch head' });
      }

      const buildIds: Array<string> = [];
      const cancelledContainerBuilds: Array<TerminatedBuild> = [];
      for (const connection of matching) {
        if (connection.build_executor !== 'container') {
          // github_actions: the workflow self-runs on push and the OIDC endpoint
          // creates the build row. But if a newer push's workflow never reaches
          // OIDC (skipped/cancelled/failed), an older in-flight build for a
          // now-superseded commit would still hold a live deploy token and could
          // publish. This code runs AFTER the `headComparison === 'identical'`
          // freshness gate, so `after` is provably the current branch head:
          // terminalize active actions builds for this branch whose commit is NOT
          // the new head (excluding `after` spares a build that already exchanged
          // OIDC for the new commit; the `branch` filter spares other branches).
          // No DO cancel: actions builds have no container DO — terminalizing the
          // row is what revokes their token. The residual window — a push landing
          // after an exchange's compare pre-check but BEFORE its row insert (this
          // cleanup no-ops on a row that doesn't exist yet) — is closed by the
          // OIDC path's post-create freshness re-check.
          await terminateBuildsForProject(db, connection.project_id, {
            branch,
            executor: 'github_actions',
            exceptCommitSha: after,
            reason: 'superseded by newer push',
          });
          continue;
        }
        // Supersede older queued AND active builds for this branch and enqueue the
        // new commit atomically, under a per-project lock, so concurrent webhook
        // deliveries can't interleave supersede+create (which would let an older
        // push cancel a newer queued build then enqueue the older commit).
        // Redelivery is deduped: an in-flight build for this exact commit is
        // reused; a `complete` build is reused only when its commit is already
        // live. Otherwise — e.g. a force-push rollback to a previously built
        // commit while the project is live on a newer one — a fresh build is
        // enqueued to re-deploy it. The supersede also terminalizes older ACTIVE
        // builds (revoking their deploy token + freeing their slot); their DOs are
        // torn down after the tx commits, below.
        const { build, cancelled } = await supersedeAndCreateContainerBuild(db, {
          projectId: connection.project_id,
          branch,
          commitSha: after,
          connectionId: connection.id,
          installationId: connection.installation_id,
          repositoryId: connection.repository_id,
        });
        cancelledContainerBuilds.push(...cancelled);
        // `build` is null on any skip: a concurrent PATCH /projects/:id/github
        // changed the connection, the project is being torn down, its owner is
        // suspended, or installation authority was revoked. Either way no row is
        // enqueued and there's no id to push; the early-out + DO teardown below
        // tolerate the empty case.
        if (build) {
          buildIds.push(build.id);
        }
      }

      // The supersede tx already committed inside the helper (revoking tokens),
      // so this best-effort DO teardown runs outside any row lock.
      await cancelContainerBuildDos(
        context.env,
        cancelledContainerBuilds,
        'superseded by newer push',
      );

      if (buildIds.length === 0) {
        // No container build was enqueued. When only github_actions connections
        // matched, they self-run on push (their workflow calls the OIDC endpoint
        // to create the build row), so 'github_actions' is the right label. But
        // when container connections matched and were all superseded/deduped/
        // skipped, don't mislabel that no-op as a github_actions run.
        return matching.some((c) => c.build_executor === 'container')
          ? context.json({ ok: true, enqueued: 0 })
          : context.json({ ok: true, executor: 'github_actions' });
      }

      await pokeBuildScheduler(context.env);

      return context.json({ ok: true, buildIds });
    }

    case 'installation': {
      const data = payload as InstallationPayload;
      const installationId = data.installation?.id;
      if (installationId === undefined || installationId === null) {
        return context.json({ ok: true, ignored: 'missing installation id' });
      }
      const action = data.action;

      if (action === 'created') {
        const account = data.installation?.account;
        const accountType = account?.type === 'Organization' ? 'Organization' : 'User';
        await upsertGitHubInstallation(db, {
          installationId: String(installationId),
          // Organization installs never have an owner. A personal install's
          // owner is linked by the install callback or a later sign-in.
          userId: null,
          accountLogin: account?.login ?? '',
          accountId: account?.id === undefined ? '' : String(account.id),
          accountType,
          repositories: normalizeRepositories(data.repositories),
          repositorySelection: normalizeRepositorySelection(
            data.installation?.repository_selection,
          ),
        });
        return context.json({ ok: true });
      }

      // App removal/suspension orphans every connection under this installation:
      // an in-flight build keeps a live deploy token (the middleware guard
      // revokes a token only once its bound build is no longer active), so
      // terminalize ALL the installation's in-flight builds atomically with the
      // status flip — under a FOR UPDATE lock on the install row (taken first)
      // and then the connection rows, so an in-flight OIDC exchange (which
      // re-reads + locks the same connection rows before inserting its build) is
      // serialized. The DO cancel runs AFTER commit.
      if (action === 'deleted' || action === 'suspend') {
        const reason = action === 'deleted' ? 'github app uninstalled' : 'github app suspended';
        const cancelled = await db.transaction(async (tx) => {
          // Lock the install row FIRST, then the connection rows — the global
          // install-first order (member_removed + the connect gate also lock the
          // install row first) so a concurrent organization/member_removed and
          // this uninstall/suspend for the same install can't deadlock (AB-BA).
          // The connection-row FOR UPDATE below still serializes the in-flight
          // OIDC exchange (which locks the same rows before inserting its build);
          // the DO cancel runs AFTER commit.
          await tx
            .select({ id: githubInstallations.id })
            .from(githubInstallations)
            .where(eq(githubInstallations.installation_id, String(installationId)))
            .for('update');
          const connections = await tx
            .select({ project_id: githubConnections.project_id })
            .from(githubConnections)
            .where(eq(githubConnections.installation_id, String(installationId)))
            .for('update');
          // `deleted` is the terminalizing write and applies unconditionally;
          // `suspend` is guarded so a stale suspend can't walk a `deleted` row
          // back to `suspended` (which would re-arm the unsuspend guard).
          if (action === 'deleted') {
            await markGitHubInstallationStatus(tx, String(installationId), 'deleted');
          } else {
            await suspendGitHubInstallation(tx, String(installationId));
          }
          const acc: Array<TerminatedBuild> = [];
          for (const conn of connections) {
            acc.push(...(await terminateBuildsForProject(tx, conn.project_id, { reason })));
          }
          return acc;
        });
        await cancelContainerBuildDos(context.env, cancelled, reason);
        return context.json({ ok: true });
      }
      if (action === 'unsuspend') {
        // Guarded suspended->active only: a stale/redelivered unsuspend arriving
        // after a later installation.deleted must not revive the terminal row.
        await unsuspendGitHubInstallation(db, String(installationId));
        return context.json({ ok: true });
      }

      return context.json({ ok: true, ignored: `installation:${action ?? 'unknown'}` });
    }

    case 'installation_repositories': {
      const data = payload as InstallationRepositoriesPayload;
      const installationId = data.installation?.id;
      if (installationId === undefined || installationId === null) {
        return context.json({ ok: true, ignored: 'missing installation id' });
      }

      const added = normalizeRepositories(data.repositories_added);
      const removed = normalizeRepositories(data.repositories_removed);
      const existing = await getGitHubInstallation(db, String(installationId));
      const eventSelection = normalizeRepositorySelection(data.repository_selection);

      // Compute the post-change accessible repo set + selection. Normally we
      // apply the event's added/removed delta to the cached set. BUT an
      // `all`→`selected` narrowing CANNOT be reconstructed from the delta: the
      // cache is intentionally empty for `all` installs (listInstallationRepositories
      // stores [] — every coverage check short-circuits on selection='all'), and
      // GitHub's delta on that transition is undocumented, so diffing it against
      // the empty cache would drop the repos the user KEPT and silently break
      // their builds (a kept repo would stop matching getGitHubConnectionsByRepo /
      // installationCoversRepo once selection flips to 'selected'). Fetch the
      // authoritative post-change set instead. This is a network round-trip, so
      // it runs BEFORE the FOR UPDATE tx below (mirror the push path's
      // getBranchExistence — never hold a row lock across a GitHub call). Trust
      // the refetched selection too, so a redelivered/stale event that no longer
      // reflects 'selected' self-corrects.
      //
      // The repo set is then computed from the LOCKED, freshly-read cached set
      // inside the tx (computeNext), NOT from the `existing` snapshot above: concurrent
      // installation_repositories deliveries must serialize their read-modify-
      // write, else two near-simultaneous adds from [A] persist only one of
      // [A,B]/[A,C] and the lost repo's pushes/OIDC stop resolving.
      let refetched: Awaited<ReturnType<typeof listInstallationRepositories>> | null = null;
      if (existing?.repository_selection === 'all' && eventSelection === 'selected') {
        const token = await getInstallationToken(context.env, String(installationId));
        refetched = await listInstallationRepositories(token);
      }
      const selection: 'all' | 'selected' = refetched
        ? refetched.repositorySelection
        : eventSelection;
      // Decide the selection to PERSIST from the selection re-read UNDER the lock,
      // not the pre-tx `existing` snapshot. A stale/redelivered `selected` event can
      // arrive AFTER the user widened the install to `all`: its pre-tx snapshot
      // still said `selected`, so the `all`→`selected` refetch gate above never
      // fired (`refetched === null`). Persisting its `selected` would walk the
      // locked `all` row back to `selected` — dropping coverage for every repo
      // outside this event's set and (on the removal path) revoking in-flight builds
      // for repos `all` still covers. When the lock shows `all` and we never
      // confirmed a live narrow, keep `all`.
      const isStaleSelectedDowngrade = (lockedSelection: string | null | undefined): boolean =>
        refetched === null && lockedSelection === 'all' && selection === 'selected';
      const removedIds = new Set(removed.map((r) => r.id));
      const computeNext = (
        current: ReadonlyArray<GitHubInstallationRepository>,
      ): ReadonlyArray<GitHubInstallationRepository> => {
        // A narrowing replaces the set with the authoritative refetch; otherwise
        // apply the event's added/removed delta to the locked current set.
        if (refetched) {
          return refetched.repositories;
        }
        const byId = new Map<number, GitHubInstallationRepository>();
        for (const repo of current) {
          if (!removedIds.has(repo.id)) {
            byId.set(repo.id, repo);
          }
        }
        for (const repo of added) {
          byId.set(repo.id, repo);
        }
        return [...byId.values()];
      };

      // Nothing to revoke when (a) no repos were removed, or (b) the
      // authoritative selection is now `all`. `all` grants every repo, so even a
      // stale `all`→`selected` redelivery whose `repositories_removed` lists repos
      // has NOT actually dropped coverage for any of them (every coverage check
      // short-circuits on selection='all'). Running the revocation loop on that
      // stale delta would wrongly cancel in-flight builds + revoke valid deploy
      // tokens for still-covered repos. Just sync the cached set/selection.
      if (removed.length === 0 || selection === 'all') {
        // Sync the cached set under a FOR UPDATE lock on the install row so the
        // write is based on the latest committed repositories (no lost update).
        await db.transaction(async (tx) => {
          const [locked] = await tx
            .select({
              repositories: githubInstallations.repositories,
              repository_selection: githubInstallations.repository_selection,
            })
            .from(githubInstallations)
            .where(eq(githubInstallations.installation_id, String(installationId)))
            .for('update')
            .limit(1);
          await setGitHubInstallationRepositories(
            tx,
            String(installationId),
            computeNext(locked?.repositories ?? []),
            isStaleSelectedDowngrade(locked?.repository_selection) ? 'all' : selection,
          );
        });
        return context.json({ ok: true });
      }

      // Repos removed from the App orphan any connection still pointing at one of
      // them: an in-flight build keeps a live deploy token (the middleware
      // guard revokes a token only once its bound build is no longer active), so
      // terminalize those connections' in-flight builds atomically with the
      // repo-set write — under a FOR UPDATE lock on the connection rows so an
      // in-flight OIDC exchange (which re-reads + locks the same rows before
      // inserting its build) is serialized. The DO cancel runs AFTER commit.
      const reason = 'repository removed from github app';
      // `repo_full_name` is mutable (a repo can be renamed under the same
      // installation), so a rename-then-remove leaves the connection holding the
      // OLD name while the payload carries the current name + the IMMUTABLE id.
      // Match on the immutable repository_id (mirroring
      // getGitHubConnectionsByRepo). Distinct from the numeric `removedIds` above —
      // this set holds the stringified ids that the text `repository_id` column
      // is compared against.
      const removedRepositoryIds = new Set(removed.map((r) => String(r.id)));
      const cancelled = await db.transaction(async (tx) => {
        // Lock + re-read the install row FIRST, then the connection rows —
        // matching member_removed, the connect gate, and the deleted/suspend
        // branch, so a concurrent suspend/delete or
        // organization/member_removed for the same install can't deadlock
        // (AB-BA). The install-row lock also serializes the repositories write
        // below against concurrent installation_repositories deliveries (no lost
        // update); the connection-row FOR UPDATE that follows still serializes an
        // in-flight OIDC exchange (which locks the same rows before inserting its
        // build).
        const [locked] = await tx
          .select({
            repositories: githubInstallations.repositories,
            repository_selection: githubInstallations.repository_selection,
          })
          .from(githubInstallations)
          .where(eq(githubInstallations.installation_id, String(installationId)))
          .for('update')
          .limit(1);
        const connections = await tx
          .select({
            project_id: githubConnections.project_id,
            repository_id: githubConnections.repository_id,
          })
          .from(githubConnections)
          .where(eq(githubConnections.installation_id, String(installationId)))
          .for('update');
        // Use the LOCKED selection: a stale `selected` delivery that missed a
        // concurrent widen to `all` must NOT downgrade the row OR revoke builds —
        // `all` still covers every "removed" repo, so revocation would be wrong.
        const staleDowngrade = isStaleSelectedDowngrade(locked?.repository_selection);
        await setGitHubInstallationRepositories(
          tx,
          String(installationId),
          computeNext(locked?.repositories ?? []),
          staleDowngrade ? 'all' : selection,
        );
        if (staleDowngrade) {
          return [];
        }
        const acc: Array<TerminatedBuild> = [];
        for (const conn of connections) {
          if (!removedRepositoryIds.has(conn.repository_id)) {
            continue;
          }
          acc.push(...(await terminateBuildsForProject(tx, conn.project_id, { reason })));
        }
        return acc;
      });
      await cancelContainerBuildDos(context.env, cancelled, reason);
      return context.json({ ok: true });
    }

    case 'check_run': {
      const data = payload as CheckRunPayload;
      if (data.action !== 'rerequested') {
        return context.json({ ok: true, ignored: `check_run:${data.action ?? 'unknown'}` });
      }
      if (data.check_run?.name === VOID_SECURITY_AUDIT_CHECK_RUN_NAME) {
        // Informational (design doc 0095 M28): a project rescan for a sender who could
        // ask for one, else a no-op. Never a build or a deploy.
        return context.json(
          await handleSecurityCheckRerequest(context.env, db, {
            installationId: data.installation?.id,
            repositoryId: data.repository?.id,
            externalId: data.check_run?.external_id,
            senderId: data.sender?.id,
          }),
        );
      }
      // GitHub only delivers `rerequested` for runs OUR App created, but the App
      // may publish more check names later; match ours explicitly so a future run
      // can't accidentally trigger a deploy.
      if (data.check_run?.name !== VOID_BUILD_CHECK_RUN_NAME) {
        return context.json({ ok: true, ignored: 'check_run is not the Void build' });
      }
      const runId = data.check_run?.id;
      return await rerunBuildForCommit(context, db, {
        installationId: data.installation?.id,
        repoFullName: data.repository?.full_name,
        repoId: data.repository?.id,
        headSha: data.check_run?.head_sha,
        event: 'check_run',
        checkRun: {
          id: runId === undefined || runId === null ? null : String(runId),
          buildId: data.check_run?.external_id ?? null,
          conclusion: data.check_run?.conclusion ?? null,
        },
      });
    }

    case 'check_suite': {
      const data = payload as CheckSuitePayload;
      // "Re-run all checks". `requested`/`completed` are noise here: a suite is
      // requested on every push, which the `push` handler already builds — acting
      // on it too would double-enqueue every commit.
      if (data.action !== 'rerequested') {
        return context.json({ ok: true, ignored: `check_suite:${data.action ?? 'unknown'}` });
      }
      return await rerunBuildForCommit(context, db, {
        installationId: data.installation?.id,
        repoFullName: data.repository?.full_name,
        repoId: data.repository?.id,
        headSha: data.check_suite?.head_sha,
        event: 'check_suite',
      });
    }

    case 'workflow_run': {
      const data = payload as WorkflowRunPayload;
      if (data.action !== 'completed') {
        return context.json({ ok: true, ignored: `workflow_run:${data.action ?? 'unknown'}` });
      }
      const runId = data.workflow_run?.id;
      if (runId === undefined || runId === null) {
        return context.json({ ok: true, ignored: 'missing workflow_run id' });
      }
      // GitHub always sends run_attempt; a payload without it is malformed.
      const runAttempt: unknown = data.workflow_run?.run_attempt;
      if (typeof runAttempt !== 'number' && typeof runAttempt !== 'string') {
        return context.json({ ok: true, ignored: 'missing workflow_run run_attempt' });
      }

      // A GitHub `run_id` is unique only WITHIN a repository, so the build must
      // be resolved by the payload's repository (mapped to a connected project)
      // first — matching by `run_id` alone could finalize a different project's
      // build that happens to share the numeric id. Require the payload to map
      // to a known connection before touching any build.
      const installationId = data.installation?.id;
      const repoFullName = data.repository?.full_name;
      const repoId = data.repository?.id;
      if (
        installationId === undefined ||
        installationId === null ||
        !repoFullName ||
        repoId === undefined ||
        repoId === null
      ) {
        return context.json({ ok: true, ignored: 'missing workflow_run routing fields' });
      }
      const connections = await getGitHubConnectionsByRepo(
        db,
        String(installationId),
        String(repoId),
      );
      if (connections.length === 0) {
        return context.json({ ok: true, ignored: 'no matching connection' });
      }
      // run_id is unique only within a repo; find the connected project whose
      // build carries this run id (a repo may back multiple projects). A RERUN
      // reuses the same run_id with an incremented run_attempt, so resolution is
      // scoped to the attempt: a redelivered/late completion for attempt 1 must
      // NOT resolve to attempt 2's active build.
      const runAttemptStr = String(runAttempt);
      // A single repo can back multiple github_actions projects (matrix /
      // multiple --project jobs sharing one run_id+attempt with distinct
      // project_ids). GitHub fires workflow_run:completed ONCE, so collect EVERY
      // matching build across the connections rather than stopping at the first;
      // otherwise the other projects' builds stay ACTIVE until the 60m reaper
      // (pinning slots, extending token validity, mislabeling a success).
      const candidates: Array<Build> = [];
      for (const connection of connections) {
        const candidate = await getBuildByProjectRunIdAndAttempt(
          db,
          connection.project_id,
          String(runId),
          runAttemptStr,
        );
        if (candidate) {
          candidates.push(candidate);
        }
      }
      if (candidates.length === 0) {
        return context.json({ ok: true, ignored: 'no matching build' });
      }

      const succeeded = data.workflow_run?.conclusion === 'success';
      // The "Void Build" check reports GitHub's RUN outcome, so its conclusion is
      // derived from the webhook payload — NOT from our internal build status.
      const checkConclusion = mapWorkflowRunConclusion(data.workflow_run?.conclusion);
      const headSha = data.workflow_run?.head_sha;

      const buildIds: Array<string> = [];
      for (const candidate of candidates) {
        const candidateHeadSha = headSha ?? candidate.commit_sha;

        // Complete the "Void Build" GitHub Check Run from GitHub's workflow_run
        // conclusion, INDEPENDENT of our internal build-status CAS below.
        // github_actions builds have no BuildManager DO, so completion happens
        // HERE (the container executor completes inside its DO). The check mirrors
        // GitHub's run outcome, so it must be finalized even when our build row was
        // already driven terminal OUT-OF-BAND — push-supersede, OIDC latest-wins,
        // connection disconnect, branch/executor change, App uninstall/suspend,
        // repo removal, project teardown, or the stale-build reaper. None of those
        // paths touch the check, yet GitHub still fires workflow_run:completed
        // (including for a run it cancelled via `concurrency`); driving completion
        // off the CAS would leave the check stranded `in_progress`. Placed
        // BEFORE the active-status skip below so an already-terminal candidate is
        // still completed. Idempotent — re-PATCHing a completed run just re-sets
        // the same conclusion, so a redelivery is harmless. Guarded on
        // `check_run_id` (no-op when none was created — a create failure, or a
        // build predating the column). Deferred via `waitUntil` and wrapped
        // defensively so a slow/failing/throwing Checks call never perturbs the
        // webhook 2xx (`completeCheckRun` is already best-effort).
        if (candidate.check_run_id) {
          const short = (candidateHeadSha ?? '').slice(0, 7);
          const branchLabel = candidate.branch ?? '';
          const checkRunId = candidate.check_run_id;
          const detailsUrl = candidate.logs_url ?? undefined;
          const title =
            checkConclusion === 'success'
              ? 'Void deploy succeeded'
              : checkConclusion === 'cancelled'
                ? 'Void deploy cancelled'
                : 'Void deploy failed';
          const summary =
            checkConclusion === 'success'
              ? `Deployed \`${branchLabel}\` @ ${short} via GitHub Actions`
              : checkConclusion === 'cancelled'
                ? `GitHub Actions run for \`${branchLabel}\` @ ${short} was cancelled`
                : `GitHub Actions deploy failed for \`${branchLabel}\` @ ${short}`;
          context.executionCtx.waitUntil(
            (async () => {
              try {
                await completeCheckRun(
                  context.env,
                  String(installationId),
                  repoFullName,
                  checkRunId,
                  {
                    conclusion: checkConclusion,
                    title,
                    summary,
                    detailsUrl,
                  },
                );
              } catch (err) {
                console.warn('[webhooks] workflow_run: best-effort completeCheckRun failed', err);
              }
            })(),
          );
        }

        // DB side (CAS-guarded): only finalize a build that is still ACTIVE. If a
        // candidate is already terminal (a redelivered/duplicate completion, or an
        // out-of-band terminalizer won the race), leave the row untouched so a
        // stale delivery can't clobber the recorded outcome. Combined with the
        // attempt match above, a redelivered attempt-1 completion neither resolves
        // to attempt-2's build NOR re-finalizes attempt-1's terminal row. (The
        // check was already completed above — it tracks GitHub's run, not our row.)
        if (!ACTIVE_BUILD_STATUSES.includes(candidate.status)) {
          continue;
        }

        // Resolve each candidate's deployment independently (different project_id
        // → different deployment for the same head SHA). Best-effort: a transient
        // Hyperdrive/Postgres failure on this READ must NOT skip the terminal write
        // below — otherwise the Actions build stays ACTIVE, keeps honoring its
        // deploy token, and pins the user's concurrency slot until the hourly
        // reaper. On lookup failure, finalize WITHOUT the deployment link (mirrors
        // BuildManager.onStop's best-effort lookup on the container path).
        let deploymentId: string | null = null;
        if (succeeded && candidateHeadSha) {
          try {
            const deployment = await getDeploymentByProjectAndCommit(
              db,
              candidate.project_id,
              candidateHeadSha,
            );
            deploymentId = deployment?.id ?? null;
          } catch (err) {
            console.error(
              '[webhooks] workflow_run: deployment lookup failed; finalizing without link',
              err,
            );
          }
        }

        // CAS the finalization: the ACTIVE guard above and this write are NOT
        // atomic, so a concurrent terminalizer (App removal/suspension, repo
        // removal, push-supersede, disconnect, OIDC-supersede) can flip the row
        // to `cancelled` in between. `markBuildTerminalIfActive` only writes when
        // the row is still ACTIVE, so it never clobbers that cancellation — and
        // `deploymentId` (gated inside the CAS opts) is never linked to a
        // cancelled build. Collect only the ids the CAS actually changed.
        const changed = await markBuildTerminalIfActive(
          db,
          candidate.id,
          succeeded ? 'complete' : 'failed',
          { completedAt: new Date().toISOString(), deploymentId },
        );
        if (changed) {
          buildIds.push(candidate.id);
        }
      }

      if (buildIds.length === 0) {
        return context.json({ ok: true, ignored: 'build already terminal' });
      }
      // One completion can finalize builds for several projects (mirrors the
      // push handler), so return every finalized build id.
      return context.json({ ok: true, buildIds });
    }

    case 'organization': {
      const data = payload as OrganizationPayload;
      // Only membership removal severs access. Everything else (member_added,
      // renamed, etc.) is accepted-and-ignored — a re-added member re-JOINs via
      // the authorize round-trip when they want back in.
      if (data.action !== 'member_removed') {
        return context.json({ ok: true, ignored: `organization:${data.action ?? 'unknown'}` });
      }
      const orgId = data.organization?.id;
      const removedGithubUserId = data.membership?.user?.id;
      if (orgId == null || removedGithubUserId == null) {
        return context.json({ ok: true, ignored: 'organization: missing ids' });
      }

      // Every installation under THIS org, scoped by account_id + 'Organization'.
      // Resolved FIRST because the membership-by-proof-id query below is scoped to
      // these installs.
      //
      // This early-return records NO tombstone when the org has no persisted
      // install row yet (a removal racing ahead of installation.created / the
      // install callback). That gap is bounded by the same accepted live-proof
      // residual: a fresh ORG owner-adopt requires a live `authorizeInstallViaUserToken`
      // proof that FAILS once GitHub propagates the removal (the personal-install
      // `account.id === stateGitHubAccountId` fallback cannot fire — account.id is
      // the ORG's id, never the initiator's). So no account-level tombstone is added
      // (it would only reject inside the window the live proof already governs).
      const orgInstalls = await getGitHubInstallationsByAccount(db, String(orgId), 'Organization');
      if (orgInstalls.length === 0) {
        return context.json({ ok: true, ignored: 'organization: no org installs' });
      }
      const orgInstallIds = orgInstalls.map((i) => i.installation_id);

      // Sever + tombstone atomically. FOR UPDATE on the affected users' connection
      // rows serializes an in-flight OIDC exchange for the same rows (mirror
      // installation/uninstall). terminate = revoke in-flight build tokens
      // (build-row status is the token authority); delete = remove the future
      // auto-deploy trigger. The membership cache is cleared regardless of
      // connection count. The revocation tombstone is stamped ONCE,
      // keyed by the removed GitHub account id (durable, known from the payload
      // regardless of Void state) — user resolution drives only the sever. DO
      // cancel is AWAITED after commit. Idempotent in the steady state: a plain
      // redelivery finds the connections already gone and harmlessly re-advances
      // the tombstone high-water mark. NOT idempotent across a re-add interleaving
      // (X removed -> re-added -> legitimately re-joins + reconnects -> a STALE
      // redelivery of the OLD member_removed lands): the redelivery re-runs the
      // sever against CURRENT state and cuts the fresh connection, and its
      // clock_timestamp() tombstone over-advances past the fresh artifact's iat.
      // This is a bounded, FAIL-SAFE (over-revoke, never under-revoke),
      // self-recovering (X simply re-joins) best-effort residual — matching the
      // container/OIDC best-effort boundaries. It is deliberately NOT closed with a
      // live GET /orgs/:org/memberships/:user recheck gating the sever: that would
      // trade this safe over-revocation for an UNSAFE under-revocation whenever
      // GitHub's membership API lags a genuine removal (we return 2xx, so no
      // redelivery would ever re-sever). Always-sever is the security-correct
      // default. (Reachability: GitHub only auto-retries a FAILED delivery, or an
      // admin manually redelivers.)
      //
      // Connections are OAUTH-backed, so the affected user for SEVERING is
      // exactly `getUserByOAuthAccount('github', X)` — the sole driver of
      // connection-severing. Browser-proof-X
      // LISTING memberships (whose `github_account_id` is decoupled from the
      // bearer's oauth id) never back a connection, so X's removal only DELETES
      // them. That resolution is deliberately NOT done out here: it runs INSIDE the
      // tx, AFTER the install-row lock + tombstone write, so a redemption that
      // committed while we waited for the lock is visible and severed. The
      // pre-tx step above resolves only the org install set (needed for the lock
      // scope).
      const reason = 'org membership removed';
      const cancelled = await db.transaction(async (tx) => {
        // Lock each org install row FIRST, in a deterministic (sorted) order to
        // avoid deadlock. This is the SAME row the connect gate locks, so a
        // concurrent member connect and this revocation are serialized — closing
        // the phantom-INSERT race. The lock is taken before the
        // connection scan so a connect that commits first is seen and severed.
        for (const installId of [...orgInstallIds].sort()) {
          await tx
            .select({ id: githubInstallations.id })
            .from(githubInstallations)
            .where(eq(githubInstallations.installation_id, installId))
            .for('update');
        }
        // Stamp the durable revocation tombstone FIRST and UNCONDITIONALLY, keyed
        // by the removed GitHub account id X — the durable identity the
        // stateless join_code/connect_grant artifacts carry, always known from the
        // payload even when there is NO Void user to sever (the pre-mint hole).
        // The membership hard-delete below is a TTL cache and cannot make
        // revocation MONOTONIC on its own. `revoked_at = clock_timestamp()` per
        // install so a later replay of a pre-removal artifact (iat <= revoked_at)
        // is rejected; the upsert advances the high-water mark on redelivery,
        // while a legit re-join after re-add mints a fresh artifact
        // (iat > revoked_at) honored.
        // Written under the install-row lock (serialized against a concurrent
        // join/complete) EVEN when the affected-user set is empty.
        await recordInstallationRevocations(tx, orgInstallIds, String(removedGithubUserId));
        // Resolve the affected Void user for connection/owner severing UNDER the
        // lock (post-tombstone) so a redemption that committed while we
        // waited for the install-row lock is now visible and severed. Either
        // member_removed locks first (the tombstone above then blocks the
        // redemption) or the redemption commits first (this post-lock re-read sees
        // its freshly-inserted connection and severs it).
        //
        // Connections record the owner/admin whose OAuth proof authorized them,
        // so the removed user's connections are exactly those they authorized.
        const removedUser = await getUserByOAuthAccount(tx, 'github', String(removedGithubUserId));
        const acc: Array<TerminatedBuild> = [];
        if (removedUser) {
          const conns = await tx
            .select({ project_id: githubConnections.project_id })
            .from(githubConnections)
            .where(
              and(
                inArray(githubConnections.installation_id, orgInstallIds),
                eq(githubConnections.authorized_by_user_id, removedUser.id),
              ),
            )
            .for('update');
          for (const conn of conns) {
            acc.push(...(await terminateBuildsForProject(tx, conn.project_id, { reason })));
            await deleteGitHubConnection(tx, conn.project_id);
          }
          // Clear the removed user's membership cache across every org install
          // (guarded on the user id, so a different bearer is never clobbered).
          await deleteGitHubInstallationMembers(tx, orgInstallIds, removedUser.id);
        }
        // Void the BROWSER-PROOF-X LISTING memberships across every org install,
        // keyed by the GitHub id X (NOT a Void user id) so any bearer's X-keyed
        // row is removed. A membership's `github_account_id` is the browser proof
        // captured at JOIN, DECOUPLED from the bearer's oauth identity, so it never
        // backs a connection (proven oauth-backed above). This therefore deletes
        // exactly the stale X listing entries and touches NO connection and NO
        // Z-keyed membership. The durable
        // tombstone is written once above (keyed by X), so a pre-mint replay is
        // caught even for a user that does not exist yet at removal time.
        await deleteGitHubInstallationMembersByGithubAccount(
          tx,
          orgInstallIds,
          String(removedGithubUserId),
        );
        return acc;
      });
      await cancelContainerBuildDos(context.env, cancelled, reason);
      return context.json({ ok: true });
    }

    default:
      return context.json({ ok: true, ignored: event });
  }
}

// POST /webhooks/github — direct GitHub App webhook receiver for installations
// whose API origin is not behind Access. The raw GitHub HMAC is the
// authentication. Access-protected installations use the standalone ingress,
// which calls a separate fixed internal operation after adding its own proof.
app.post('/github', async (context) => {
  const secret = context.env.GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret === '') {
    return context.json({ error: 'github app not configured' }, 503);
  }

  let raw: Uint8Array;
  let event: string;
  let signature: string;
  try {
    ({ event, signature } = readGitHubWebhookHeaders(context.req.raw.headers, {
      requireDelivery: false,
    }));
    raw = await readBoundedGitHubWebhookBody(context.req.raw);
  } catch (error) {
    if (error instanceof GitHubWebhookRequestError) {
      if (error.code === 'invalid_signature_header') {
        return context.json({ error: 'invalid signature' }, 401);
      }
      return context.json({ error: error.code }, error.status);
    }
    throw error;
  }

  if (!(await verifyGithubWebhookSignature(raw, signature, secret))) {
    return context.json({ error: 'invalid signature' }, 401);
  }
  return handleVerifiedGitHubWebhook(context, raw, event);
});

export const webhookRoutes = app;
