import {
  and,
  count,
  desc,
  asc,
  eq,
  ne,
  inArray,
  notInArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ACTIVE_BUILD_STATUSES } from '../build-status.ts';
import { generateId } from '../id.ts';
import { resolvePlan } from '../plans.ts';
import { users, projects, deployments, builds, githubConnections } from '../schema.ts';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
} from '../suspension.ts';
import type { PlanId } from '../tiers.ts';
import type { Build } from '../types.ts';
import type { Db } from './client.ts';
import { installationCoversRepoInTx } from './github-authority.ts';

// ---------------------------------------------------------------------------
// builds
// ---------------------------------------------------------------------------

export async function getBuild(db: Db, id: string): Promise<Build | null> {
  const [row] = await db.select().from(builds).where(eq(builds.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectBuilds(
  db: Db,
  projectId: string,
  limit = 20,
): Promise<ReadonlyArray<Build>> {
  return db
    .select()
    .from(builds)
    .where(eq(builds.project_id, projectId))
    .orderBy(desc(builds.created_at))
    .limit(limit);
}

export async function updateBuildStatus(
  db: Db,
  id: string,
  status: Build['status'],
  opts?: {
    error?: string | null;
    exitCode?: number | null;
    instanceType?: string | null;
    startedAt?: string;
    completedAt?: string;
    deploymentId?: string | null;
  },
): Promise<void> {
  await db
    .update(builds)
    .set({
      status,
      error: opts?.error === undefined ? sql`${builds.error}` : opts.error,
      exit_code: opts?.exitCode === undefined ? sql`${builds.exit_code}` : opts.exitCode,
      instance_type:
        opts?.instanceType === undefined ? sql`${builds.instance_type}` : opts.instanceType,
      started_at: opts?.startedAt === undefined ? sql`${builds.started_at}` : opts.startedAt,
      completed_at:
        opts?.completedAt === undefined ? sql`${builds.completed_at}` : opts.completedAt,
      deployment_id:
        opts?.deploymentId === undefined ? sql`${builds.deployment_id}` : opts.deploymentId,
    })
    .where(eq(builds.id, id));
}

/**
 * Set status='building' ONLY if the row is still 'starting'. Returns true if it
 * updated. Prevents a delayed onStart from resurrecting a row that a fast-exit
 * onStop already drove terminal.
 *
 * `instanceType` is the container's resolved size. The scheduler persists it in
 * the same claim tx (`queued -> starting`), so this is an idempotent safety-net
 * re-write — folded into the same guarded CAS so it can never resurrect a terminal
 * row (matches `updateBuildStatus`'s "keep current unless provided" merge: omit →
 * keep, value/null → write).
 */
export async function markBuildBuildingIfStarting(
  db: Db,
  id: string,
  opts?: { instanceType?: string | null },
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({
      status: 'building',
      instance_type:
        opts?.instanceType === undefined ? sql`${builds.instance_type}` : opts.instanceType,
    })
    .where(and(eq(builds.id, id), eq(builds.status, 'starting')));
  return updatedRowCount(result) > 0;
}

/**
 * Return a build to 'queued' ONLY if it is still 'starting'. Returns true if it
 * updated. Used by the scheduler's capacity-shed retry AND the BuildManager
 * freshness-recheck retry: if a concurrent terminalizer (push-supersede,
 * branch/executor change, disconnect, install removal) already drove the claimed
 * row terminal, this no-ops and the terminal status is preserved — so a
 * superseded commit can't be resurrected and redeployed. Leaving `started_at`
 * stamped is harmless: the next claim re-stamps it.
 */
export async function requeueBuildIfStarting(db: Db, id: string): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({ status: 'queued' })
    .where(and(eq(builds.id, id), eq(builds.status, 'starting')));
  return updatedRowCount(result) > 0;
}

/**
 * Apply a TERMINAL status ONLY if the row is currently active
 * (starting/building/deploying). Returns true if it updated. Prevents a
 * duplicate/late lifecycle event from clobbering an earlier terminal outcome.
 */
export async function markBuildTerminalIfActive(
  db: Db,
  id: string,
  status: 'complete' | 'failed' | 'cancelled',
  opts?: {
    error?: string | null;
    exitCode?: number | null;
    completedAt?: string;
    deploymentId?: string | null;
  },
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({
      status,
      error: opts?.error === undefined ? sql`${builds.error}` : opts.error,
      exit_code: opts?.exitCode === undefined ? sql`${builds.exit_code}` : opts.exitCode,
      completed_at:
        opts?.completedAt === undefined ? sql`${builds.completed_at}` : opts.completedAt,
      deployment_id:
        opts?.deploymentId === undefined ? sql`${builds.deployment_id}` : opts.deploymentId,
    })
    .where(and(eq(builds.id, id), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
  return updatedRowCount(result) > 0;
}

/**
 * Persist the GitHub Check Run id created for this build — FIRST-WRITER-WINS,
 * immutable once set (CAS on `check_run_id IS NULL`). The container path's DO is
 * the sole writer, but the github_actions path's writer is the OIDC exchange
 * route, where two TRULY CONCURRENT exchanges for the same (project, run,
 * attempt) can both observe a null id during the create+persist window. The CAS
 * makes a persisted id immutable, so the second (racing) write no-ops rather than
 * clobbering the first — the DB keeps ONE stable, completion-tracked id. It does
 * NOT prevent the pathological second GitHub POST itself (a bounded, cosmetic
 * residual documented in `routes/auth-oidc.ts`).
 */
export async function setBuildCheckRunId(db: Db, id: string, checkRunId: string): Promise<void> {
  await db
    .update(builds)
    .set({ check_run_id: checkRunId })
    .where(and(eq(builds.id, id), isNull(builds.check_run_id)));
}

/**
 * Apply a non-terminal PROGRESS status ('building'|'deploying') ONLY while the
 * row is still active. Returns true if it updated. Prevents a forged/late agent
 * progress report from resurrecting a row a concurrent terminalizer (push-supersede,
 * disconnect, branch/executor change, app removal) already drove `cancelled` — which
 * would re-enable the bound deploy token (the deploy-token guard treats any ACTIVE
 * status as valid).
 */
export async function markBuildProgressIfActive(
  db: Db,
  id: string,
  status: 'building' | 'deploying',
): Promise<boolean> {
  const result = await db
    .update(builds)
    .set({ status })
    .where(and(eq(builds.id, id), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
  return updatedRowCount(result) > 0;
}

/**
 * Number of rows an UPDATE/DELETE touched, normalized across drivers: pg
 * (Hyperdrive, production) reports `rowCount`; PGlite (integration tests)
 * reports `affectedRows`. A guarded CAS must read whichever the active driver
 * provides — without this, a successful CAS reads as `undefined`/0 under PGlite
 * and the caller wrongly treats it as a no-op.
 */
function updatedRowCount(result: { rowCount?: number | null; affectedRows?: number }): number {
  return result.rowCount ?? result.affectedRows ?? 0;
}

/**
 * The oldest queued container build for each project that has NO active build
 * (at most one row per project per tick). Only `container` builds are scheduled
 * by the platform — `github_actions` builds run on GitHub's runners and never
 * sit in this queue.
 *
 * Rows the claim step (`claimBuildForStartWithinLimit`) would only reject are
 * filtered out so they cannot fill the scan window and starve startable builds:
 * projects that already have an active build (per-project serialization), and
 * owners in `excludeUserIds`, whom the scheduler computed to be at their
 * plan-derived concurrency cap (the cap is not a DB column, so it is not
 * enforced in SQL here).
 *
 * Ordering is age-fair: the per-project picks are re-sorted by `created_at asc`
 * before `limit`, so a low-`project_id` project cannot monopolize the window.
 *
 * NOTE: this can return `[]` while queued builds still exist (all their
 * projects are active, or all their owners are capped). The scheduler's
 * reschedule recheck must therefore key its heartbeat off
 * `hasQueuedContainerBuilds` (any queued row), not off this function, so a
 * blocked-but-present queue keeps an alarm armed until a project frees or an
 * owner drops below their cap.
 */
export async function getQueuedBuilds(
  db: Db,
  limit = 50,
  excludeUserIds: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<Build>> {
  // Inner: each idle project's OLDEST queued container build. DISTINCT ON
  // requires its column (`project_id`) to lead the ORDER BY, so age fairness
  // can't be expressed here — it is applied by the outer query below.
  const oldestPerProject = db
    .selectDistinctOn([builds.project_id])
    .from(builds)
    .where(
      and(
        eq(builds.status, 'queued'),
        eq(builds.executor, 'container'),
        sql`not exists (
          select 1 from ${builds} as active_builds
          where active_builds.project_id = ${builds.project_id}
            and active_builds.status in ('starting', 'building', 'deploying')
        )`,
        // Omit the clause entirely when empty: `NOT IN ()` is invalid SQL.
        excludeUserIds.length > 0 ? notInArray(builds.user_id, [...excludeUserIds]) : undefined,
      ),
    )
    .orderBy(builds.project_id, asc(builds.created_at))
    .as('oldest_per_project');

  // Outer: re-sort the per-project candidates oldest-first and limit, so the
  // scan surfaces the globally oldest-waiting startable builds rather than the
  // lowest project_ids.
  return db.select().from(oldestPerProject).orderBy(asc(oldestPerProject.created_at)).limit(limit);
}

/**
 * For each user that owns at least one QUEUED container build, returns their
 * plan, suspension reason, and count of builds in `ACTIVE_BUILD_STATUSES`
 * (`starting`/`building`/`deploying`). The scheduler uses this to decide which
 * owners are AT their plan's concurrency cap (cap is plan-derived in
 * the effective plan catalog, NOT a user DB column) and pass those ids to `getQueuedBuilds` as
 * `excludeUserIds`, so a capped tenant's rows never starve the scan window.
 *
 * Only `container` builds gate scheduling, so the queued-work filter is scoped
 * to that executor. The active-build count is NOT executor-scoped: an active
 * `github_actions` build also occupies a concurrency slot (mirroring
 * `claimBuildForStartWithinLimit`'s per-user count), so it must count toward the
 * cap.
 */
export async function getUsersWithQueuedContainerBuilds(db: Db): Promise<
  ReadonlyArray<{
    userId: string;
    plan: string;
    suspendedReason: string | null;
    activeBuilds: number;
  }>
> {
  const activeBuilds = alias(builds, 'active_builds');
  const rows = await db
    .select({
      userId: users.id,
      plan: users.plan,
      suspendedReason: users.suspended_reason,
      // Count only active rows through idx_builds_user_status. Joining the
      // entire builds table here would touch every historical build belonging
      // to each queued owner on every scheduler tick.
      activeBuilds: sql<number>`(
        select count(*) from ${builds} as active_builds
        where ${activeBuilds.user_id} = ${users.id}
          and ${inArray(activeBuilds.status, ACTIVE_BUILD_STATUSES)}
      )`,
    })
    .from(users)
    .innerJoin(
      // Restrict to users who own at least one queued container build — the
      // only work this scan can ever start.
      sql`(
        select distinct ${builds.user_id} as user_id from ${builds}
        where ${builds.status} = 'queued' and ${builds.executor} = 'container'
      ) as queued_owners`,
      sql`queued_owners.user_id = ${users.id}`,
    );
  return rows.map((r) => ({
    userId: r.userId,
    plan: r.plan,
    suspendedReason: r.suspendedReason,
    activeBuilds: Number(r.activeBuilds),
  }));
}

/** Cancel queued container work only for users who are still manually suspended. */
export async function cancelQueuedContainerBuildsForUsers(
  db: Db,
  userIds: ReadonlyArray<string>,
): Promise<number> {
  if (userIds.length === 0) {
    return 0;
  }
  const suspendedOwners = db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, [...userIds]),
        isNotNull(users.suspended_reason),
        notInArray(users.suspended_reason, [
          REASON_REQUESTS_EXCEEDED,
          REASON_SANDBOX_RUNTIME_EXCEEDED,
        ]),
      ),
    );
  const cancelled = await db
    .update(builds)
    .set({
      status: 'cancelled',
      error: 'project owner suspended',
      completed_at: sql`now()`,
    })
    .where(
      and(
        inArray(builds.user_id, suspendedOwners),
        eq(builds.executor, 'container'),
        eq(builds.status, 'queued'),
      ),
    )
    .returning({ id: builds.id });
  return cancelled.length;
}

/**
 * Whether ANY queued container build exists (regardless of whether its project
 * is currently active). The build scheduler uses this for its reschedule
 * recheck: `getQueuedBuilds` can return `[]` while queued builds are merely
 * blocked behind active projects, so keying the heartbeat off this guarantees
 * the alarm stays armed until a project frees and the build becomes startable.
 */
export async function hasQueuedContainerBuilds(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.status, 'queued'), eq(builds.executor, 'container')))
    .limit(1);
  return row !== undefined;
}

/**
 * Serialize webhook enqueue with project and connection changes. The last
 * processed push wins; an active identical commit is reused, while a completed
 * commit is reused only when it is still live so force-push rollbacks rebuild.
 * Connection configuration and repository authority are rechecked under lock.
 */
export async function supersedeAndCreateContainerBuild(
  db: Db,
  args: {
    projectId: string;
    branch: string;
    commitSha: string;
    connectionId: string;
    installationId: string;
    repositoryId: string;
  },
): Promise<{
  build: Build | null;
  reused: boolean;
  cancelled: ReadonlyArray<TerminatedBuild>;
  skipped?:
    | 'config-changed'
    | 'install-revoked'
    | 'connection-replaced'
    | 'project-deleting'
    | 'owner-suspended';
}> {
  return db.transaction(async (tx) => {
    // Serialize all push processing for this project (project<->branch is 1:1 via
    // the unique github_connections.project_id; the project row always exists),
    // and re-read its status under the lock. teardownProject's lockAndMarkDeleting
    // takes the SAME projects FOR UPDATE then flips status='deleting' before the
    // later cascade deletes the connection; a push landing in that window would
    // otherwise enqueue a container build for a project being torn down — burning
    // a scarce build slot (the scheduler + JIT recheck don't reject deleting
    // projects; only the cascade's terminate eventually cancels it). Mirror the
    // GitHub Actions path (createGithubActionsBuildWithinLimit) and skip instead.
    // Lock order stays projects-first, matching the other build paths, so this
    // cannot deadlock (40P01) against them.
    const [proj] = await tx
      .select({ status: projects.status, user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .for('update')
      .limit(1);
    if (!proj || proj.status === 'deleting') {
      return { build: null, reused: false, cancelled: [], skipped: 'project-deleting' };
    }
    const [ownerState] = await tx
      .select({ plan: users.plan, suspendedReason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, proj.user_id))
      .for('update')
      .limit(1);
    if (ownerState && isAdminSuspended(ownerState.suspendedReason)) {
      return { build: null, reused: false, cancelled: [], skipped: 'owner-suspended' };
    }
    // Resolve the size of record from the same owner row whose lock serializes
    // admission. A plan change that lands while webhook processing is doing its
    // network checks must take effect before this enqueue commits.
    const instanceType = ownerState
      ? (await resolvePlan(tx, ownerState.plan)).buildInstanceType
      : null;

    // Serialize against PATCH /projects/:id/github: lock + re-read the single
    // connection (project_id is UNIQUE). If a concurrent config change committed
    // first, the row's branch/executor no longer matches this push — skip rather
    // than enqueue an orphan build for a now-disabled branch/executor that neither
    // the scheduler nor the JIT freshness gate would catch. The PATCH holds the
    // same lock and its terminate step handles old-build cleanup, so we return
    // `cancelled: []` here.
    const [conn] = await tx
      .select({
        id: githubConnections.id,
        branch: githubConnections.branch,
        executor: githubConnections.build_executor,
      })
      .from(githubConnections)
      .where(eq(githubConnections.project_id, args.projectId))
      .for('update')
      .limit(1);
    if (!conn || conn.branch !== args.branch || conn.executor !== 'container') {
      return { build: null, reused: false, cancelled: [], skipped: 'config-changed' };
    }

    // Assert the locked connection is the SAME row the caller resolved. project_id
    // is UNIQUE, so a disconnect+reconnect to a DIFFERENT repo (same branch/executor)
    // DELETEs the old row and CREATEs a new one with a fresh id between resolution and
    // this tx. The branch/executor guard above and the install check below both pass
    // for such a swap (the install check keys on the PASSED installationId), so the
    // id-match is the only guard that catches a cross-repo swap — without it the old
    // repo's push would enqueue a build + mint a deploy token for a project now bound
    // to a different repo. The reconnect/disconnect already terminalized old builds
    // under its own lock, so `cancelled: []` is correct.
    if (conn.id !== args.connectionId) {
      return { build: null, reused: false, cancelled: [], skipped: 'connection-replaced' };
    }

    // Re-check installation status + repo membership under the connection lock.
    // The push resolver checked the install at resolve time, but a revocation
    // (App suspend/uninstall, repo removal) can commit AFTER that check and BEFORE
    // this tx — within the installation-token cache window — and would otherwise
    // enqueue a build + mint a deploy token for a now-revoked install. The
    // revocation webhooks lock these same connection rows FIRST, so this plain
    // read (under READ COMMITTED) sees their committed status. Fails closed.
    if (
      !(await installationCoversRepoInTx(
        tx,
        args.connectionId,
        args.projectId,
        args.installationId,
        args.repositoryId,
      ))
    ) {
      return { build: null, reused: false, cancelled: [], skipped: 'install-revoked' };
    }

    // Supersede older queued AND active (starting/building/deploying) container
    // builds for this branch whose commit is NOT the new head — FIRST, before the
    // dedup/reuse lookup, so it runs even when this push reuses an already-`complete`
    // build. This closes the rollback gap: a force-push BACK to a previously-deployed
    // SHA reuses the old `complete` build, but a newer in-flight build for the
    // now-off-branch commit must still be cancelled — otherwise it keeps a live
    // deploy token (the final guard only checks active+project, not freshness) and
    // would publish the stale newer commit. `exceptCommitSha` spares this push's own
    // commit (so a same-commit redelivery never self-cancels and returns
    // `cancelled: []` when nothing else conflicts); the `branch` filter spares other
    // branches.
    const cancelled = await terminateBuildsForProject(tx, args.projectId, {
      branch: args.branch,
      executor: 'container',
      exceptCommitSha: args.commitSha,
      reason: 'superseded by newer push',
    });

    // (a) active in-flight build for this commit → always reuse.
    const [activeExisting] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.project_id, args.projectId),
          eq(builds.branch, args.branch),
          eq(builds.commit_sha, args.commitSha),
          eq(builds.executor, 'container'),
          inArray(builds.status, ['queued', 'starting', 'building', 'deploying']),
        ),
      )
      .orderBy(desc(builds.created_at))
      .limit(1);
    if (activeExisting) {
      // Re-stamp created_at to now() on reuse, so a concurrent branch-delete fence
      // captured BEFORE this push cannot cancel a build this push just re-adopted.
      // The branch-delete path cancels active builds with created_at <= a fence it
      // sampled before confirming the branch absent. On a SAME-SHA recreate (delete
      // then recreate at the same commit), this reuse path returns the pre-existing
      // active row instead of inserting a fresh one — so without re-stamping, the
      // reused row keeps its pre-fence created_at and a delete that interleaves AFTER
      // this push (it lost the connection FOR UPDATE race) would wrongly terminalize
      // a valid build. Bumping created_at makes the row post-fence, closing that
      // TOCTOU. Safe for every other consumer: the container reaper keys on
      // started_at (not created_at), the github_actions reaper filters
      // executor != container, and the dedup lookups order by created_at desc (this
      // row stays newest, which is correct — it is the current build for the commit).
      const [refreshed] = await tx
        .update(builds)
        .set({ created_at: sql`now()` })
        .where(eq(builds.id, activeExisting.id))
        .returning();
      return { build: refreshed ?? activeExisting, reused: true, cancelled };
    }

    // (b) completed build for this commit → reuse only if this commit is already live.
    const [completeExisting] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.project_id, args.projectId),
          eq(builds.branch, args.branch),
          eq(builds.commit_sha, args.commitSha),
          eq(builds.executor, 'container'),
          eq(builds.status, 'complete'),
        ),
      )
      .orderBy(desc(builds.created_at))
      .limit(1);
    if (completeExisting) {
      const [proj] = await tx
        .select({ active: projects.active_deployment_id })
        .from(projects)
        .where(eq(projects.id, args.projectId))
        .limit(1);
      let liveIsThisCommit = false;
      if (proj?.active) {
        if (completeExisting.deployment_id && completeExisting.deployment_id === proj.active) {
          liveIsThisCommit = true;
        } else {
          const [dep] = await tx
            .select({ commit: deployments.commit })
            .from(deployments)
            .where(eq(deployments.id, proj.active))
            .limit(1);
          liveIsThisCommit =
            dep?.commit !== null && dep?.commit !== undefined && dep.commit === args.commitSha;
        }
      }
      if (liveIsThisCommit) {
        return { build: completeExisting, reused: true, cancelled };
      }
      // else: rollback — fall through to insert a fresh queued build.
    }

    const id = generateId('bld');
    const [row] = await tx
      .insert(builds)
      .values({
        id,
        project_id: args.projectId,
        user_id: proj.user_id,
        executor: 'container',
        status: 'queued',
        commit_sha: args.commitSha,
        branch: args.branch,
        instance_type: instanceType,
      })
      .returning();
    return { build: row, reused: false, cancelled };
  });
}

/**
 * Resolve a build by `(project, run_id, run_attempt)`. A GitHub RERUN reuses
 * the same `run_id` with an incremented `run_attempt`, so the `workflow_run` completion
 * handler must scope to the attempt: a redelivered/late completion for attempt
 * 1 must NOT resolve to attempt 2's active build (which would let it finalize
 * the wrong attempt). Active builds are ordered first (then `created_at desc`),
 * so the in-flight attempt wins on a tie.
 */
export async function getBuildByProjectRunIdAndAttempt(
  db: Db,
  projectId: string,
  githubRunId: string,
  githubRunAttempt: string,
): Promise<Build | null> {
  const [row] = await db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.project_id, projectId),
        eq(builds.github_run_id, githubRunId),
        eq(builds.github_run_attempt, githubRunAttempt),
      ),
    )
    .orderBy(sql`(${inArray(builds.status, ACTIVE_BUILD_STATUSES)}) desc`, desc(builds.created_at))
    .limit(1);
  return row ?? null;
}

export type TerminatedBuild = Readonly<{
  id: string;
  executor: Build['executor'];
  status: Build['status'];
  instance_type: string | null;
}>;

/**
 * Terminalize (cancel) a project's QUEUED + ACTIVE builds, optionally filtered
 * by branch and/or executor. Used when a connection is disconnected or its
 * branch/executor changes, so in-flight builds for the old config can't keep a
 * live deploy token (the middleware guard rejects a token whose bound
 * build is no longer active). Returns the cancelled builds so the caller can
 * best-effort stop active container BuildManager DOs.
 */
export async function terminateBuildsForProject(
  db: Db,
  projectId: string,
  opts?: {
    branch?: string;
    executor?: Build['executor'];
    exceptCommitSha?: string;
    reason?: string;
    // Only terminalize builds created at or before this timestamp. Used by the
    // branch-delete path as a monotonic fence: the caller confirms the branch is
    // absent, then cancels — but a build enqueued in that window (a branch
    // recreated + pushed before this UPDATE runs) is created AFTER the fence and
    // must survive. Without it, a stale/out-of-order delete could clobber a fresh
    // valid build for the recreated branch. The caller MUST source this from the
    // database clock (`select now()`), the same clock that stamps `created_at`, so
    // the two are never compared across independent (Worker vs Postgres) clocks.
    // The boundary is inclusive (`<=`): a build whose created_at lands exactly on
    // the fence existed when absence-checking began and is an orphan, so cancel it
    // — a recreate-race build is always created strictly after the fence. Compared
    // as an absolute instant (`::timestamptz`): `created_at` is `timestamp without
    // time zone`, so a naive compare against a UTC `...Z` string drops the offset
    // and misfires under any non-UTC session timezone.
    createdBefore?: string;
  },
): Promise<ReadonlyArray<TerminatedBuild>> {
  const conds = [
    eq(builds.project_id, projectId),
    inArray(builds.status, ['queued', 'starting', 'building', 'deploying']),
  ];
  if (opts?.branch !== undefined) {
    conds.push(eq(builds.branch, opts.branch));
  }
  if (opts?.executor !== undefined) {
    conds.push(eq(builds.executor, opts.executor));
  }
  if (opts?.exceptCommitSha !== undefined) {
    conds.push(ne(builds.commit_sha, opts.exceptCommitSha));
  }
  if (opts?.createdBefore !== undefined) {
    conds.push(sql`${builds.created_at} <= ${opts.createdBefore}::timestamptz`);
  }
  const affected = await db
    .update(builds)
    .set({
      status: 'cancelled',
      error: sql`COALESCE(${builds.error}, ${opts?.reason ?? 'connection changed'})`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(and(...conds))
    .returning({
      id: builds.id,
      executor: builds.executor,
      status: builds.status,
      // Carried out so the post-commit DO teardown can address the SAME
      // container-size namespace the scheduler started this build on
      // (`buildManagerNamespace`); a paid (standard-4) build cancelled against
      // the base namespace would miss its live container.
      instance_type: builds.instance_type,
    });
  return affected;
}

/**
 * Fail GitHub Actions builds stuck ACTIVE beyond `maxAgeMinutes` (measured from
 * `created_at`). A missed `workflow_run` completion webhook — or a disconnect
 * mid-run that a reaper tick raced — would otherwise leave an Actions build
 * active forever, permanently consuming a concurrency slot. Scoped to
 * `executor = 'github_actions'`: container builds are reaped by their own
 * BuildManager DO timeout, so they're intentionally excluded here. Marks them
 * `failed` and stamps `completed_at`. Returns the number of builds failed.
 */
export async function failStaleActiveGithubActionsBuilds(
  db: Db,
  maxAgeMinutes: number,
): Promise<number> {
  const result = await db
    .update(builds)
    .set({
      status: 'failed',
      error: sql`COALESCE(${builds.error}, 'build timed out')`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(
      and(
        eq(builds.executor, 'github_actions'),
        inArray(builds.status, ACTIVE_BUILD_STATUSES),
        sql`${builds.created_at} < now() - (${maxAgeMinutes} * interval '1 minute')`,
      ),
    );
  return result.rowCount ?? 0;
}

/**
 * Fail container builds stuck ACTIVE beyond `maxAgeMinutes` (measured from
 * `started_at`, NOT `created_at`). DB-only backstop for the BuildManager DO:
 * the timeout/cancel path tears down the container and pokes the scheduler
 * INDEPENDENT of the Postgres terminal-status write, so if `markBuildTerminalIfActive`
 * throws (Hyperdrive/Postgres transient failure) the row stays ACTIVE forever —
 * permanently consuming the owner's concurrency slot, blocking the project's
 * queue (`claimBuildForStartWithinLimit` / `getQueuedBuilds`), and honoring the
 * bound deploy token until JWT expiry. The github_actions reaper above
 * intentionally excludes container builds on the assumption their DO timeout
 * reaps them; this covers exactly the case that assumption violates.
 *
 * Age is keyed off `started_at` (stamped at claim by `claimBuildForStartWithinLimit`
 * and never cleared) because a container build can sit `queued` a long time
 * (up to ~30 min under capacity backoff) before starting — `created_at` would
 * risk reaping a build that hasn't started yet. A null `started_at` never
 * matches the `<` comparison, so queued/unstarted rows are implicitly guarded.
 *
 * The DB terminalize is the authoritative slot-freeing + token-revoking action,
 * even if the DO is unreachable. Because the age predicate does not prove the
 * container is gone, the reaped builds are returned so the caller can
 * best-effort `cancelBuild` each one after commit; each carries its
 * `instance_type` so the cancel addresses the same container-size namespace the
 * scheduler started it on (`buildManagerNamespace`).
 *
 * Marks them `failed` and stamps `completed_at`. Returns the reaped builds.
 */
export async function failStaleActiveContainerBuilds(
  db: Db,
  maxAgeMinutes: number,
): Promise<ReadonlyArray<{ id: string; instance_type: string | null }>> {
  const rows = await db
    .update(builds)
    .set({
      status: 'failed',
      error: sql`COALESCE(${builds.error}, 'build exceeded max lifetime (stale reaper)')`,
      completed_at: sql`COALESCE(${builds.completed_at}, now())`,
    })
    .where(
      and(
        eq(builds.executor, 'container'),
        inArray(builds.status, ACTIVE_BUILD_STATUSES),
        sql`${builds.started_at} < now() - (${maxAgeMinutes} * interval '1 minute')`,
      ),
    )
    .returning({ id: builds.id, instance_type: builds.instance_type });
  return rows;
}

/**
 * Atomically acquire a per-user build slot for a GitHub Actions `run_id` and
 * create the `building` row, all under a single transaction that holds a
 * `SELECT … FOR UPDATE` lock on the owner's `users` row.
 *
 * A count-then-insert in separate operations would let two parallel OIDC
 * exchanges for DIFFERENT `run_id`s both read capacity below the cap and both
 * insert, bypassing `concurrentBuilds`; the composite partial-unique index only
 * guards the SAME `run_id`. Serializing slot acquisition per user (FOR UPDATE on
 * the user row) makes the second exchange block until the first commits, then
 * observe the updated count.
 *
 * Idempotent reuse of an already-ACTIVE build for the same `(project, run_id)`
 * neither counts against the cap nor double-inserts. `limit <= 0` means
 * unlimited. Returns `{ outcome: 'limit-exceeded' }` (no insert) when a NEW run
 * would exceed the cap; the caller maps that to 429.
 *
 * Per-project latest-wins supersede: after the idempotent same-run reuse check,
 * a NEWER run for the same project+branch (a DIFFERENT `run_id`) supersedes
 * older active Actions builds — marking them terminal so they free the owner's
 * concurrency slot and can't race `void deploy` for the project (the GitHub
 * Actions executor has no per-project active-build serialization like the
 * container scheduler's `claimBuildForStartWithinLimit`).
 */
export async function createGithubActionsBuildWithinLimit(
  db: Db,
  args: {
    projectId: string;
    commitSha?: string | null;
    branch?: string | null;
    githubRunId: string;
    githubRunAttempt: string;
    logsUrl?: string | null;
    connectionId: string;
    installationId: string;
    repositoryId: string;
    // The authorized workflow path the OIDC gate matched (the token's own
    // workflow file). Re-checked under the connection lock so a concurrent
    // PATCH that re-pins `workflow_path` can't let a now-de-authorized workflow
    // slip a build through the check→lock window. See the re-validation below.
    expectedWorkflowPath: string;
  },
): Promise<
  | { outcome: 'created'; build: Build; timeoutMinutes: number }
  | { outcome: 'reused'; build: Build }
  | { outcome: 'limit-exceeded' }
  | { outcome: 'connection-removed' }
  | { outcome: 'connection-replaced' }
  | { outcome: 'branch-mismatch' }
  | { outcome: 'workflow-mismatch' }
  | { outcome: 'install-revoked' }
  | { outcome: 'project-deleting' }
  | { outcome: 'owner-suspended' }
> {
  return db.transaction(async (tx) => {
    // Lock the PROJECT row FIRST — before the users + github_connections locks
    // below — so this path acquires projects-before-connection, the SAME order
    // as deleteProjectCascade / lockAndMarkDeleting (projects FOR UPDATE, then
    // the cascaded connection) and the push path (supersedeAndCreateContainerBuild).
    // Without it, the builds INSERT below takes an implicit FK `FOR KEY SHARE` on
    // the projects row AFTER we already hold the connection `FOR UPDATE`, inverting
    // the lock order against a concurrent teardown (which holds projects FOR UPDATE
    // then needs this connection) → a Postgres deadlock (40P01) aborts one of the
    // two. Reject a project being torn down (or already gone): minting a deploy
    // token for a deleting project would create an orphan build the cascade then
    // has to cancel.
    const [proj] = await tx
      .select({ status: projects.status, user_id: projects.user_id })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .for('update')
      .limit(1);
    if (!proj || proj.status === 'deleting') {
      return { outcome: 'project-deleting' };
    }

    // Serialize per-user slot acquisition. Concurrent exchanges for the same
    // owner block here until the holder commits, so the count below always
    // observes prior inserts.
    const [ownerState] = await tx
      .select({ plan: users.plan, suspendedReason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, proj.user_id))
      .for('update')
      .limit(1);
    if (ownerState && isAdminSuspended(ownerState.suspendedReason)) {
      return { outcome: 'owner-suspended' };
    }
    const ownerPlan = ownerState ? await resolvePlan(tx, ownerState.plan) : null;
    const limit = ownerPlan?.limits.concurrentBuilds ?? 0;

    // Serialize against DELETE /projects/:id/github: lock + re-read the connection
    // inside this tx. If a concurrent disconnect committed first, the row is gone
    // and we must NOT create a build / mint a token for a removed connection —
    // otherwise an orphan active build would never be finalized (the workflow_run
    // webhook ignores a missing connection) and a just-disconnected repo could
    // still deploy. The disconnect path takes the SAME `FOR UPDATE` lock on this
    // row, so the two are mutually exclusive: disconnect-first => we see no row
    // and reject; build-first => the disconnect's terminate step then cancels the
    // build we just created. Lock order is projects -> users -> github_connections
    // (projects locked above so it matches teardown's projects-first order); the
    // disconnect locks only github_connections, so there is no opposite-order
    // acquirer and no deadlock.
    const [conn] = await tx
      .select({
        id: githubConnections.id,
        branch: githubConnections.branch,
        workflow_path: githubConnections.workflow_path,
      })
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.project_id, args.projectId),
          eq(githubConnections.build_executor, 'github_actions'),
        ),
      )
      .for('update')
      .limit(1);
    if (!conn) {
      return { outcome: 'connection-removed' };
    }

    // Assert the locked connection is the SAME row the caller resolved. project_id
    // is UNIQUE, so a disconnect+reconnect to a DIFFERENT repo (same branch/executor)
    // DELETEs the old row and CREATEs a new one with a fresh id between resolution and
    // this tx. The install check below keys on the PASSED installationId, so a
    // same-installation two-repo swap passes it — the id-match is the only guard that
    // catches a cross-repo swap. Without it the old repo's workflow would create a
    // build + mint a deploy token for a project now bound to a different repo. Placed
    // before the install check because an id mismatch is more specific.
    if (conn.id !== args.connectionId) {
      return { outcome: 'connection-replaced' };
    }

    // Re-check installation status + repo membership under the connection lock.
    // The OIDC resolver (and the live getRepoInstallation call) checked the install
    // earlier, but a revocation (App suspend/uninstall, repo removal) can commit
    // AFTER those checks and BEFORE this tx — within the installation-token cache
    // window — and would otherwise create a `building` row + mint a deploy token
    // for a now-revoked install. The revocation webhooks lock these same connection
    // rows FIRST, so this plain read (under READ COMMITTED) sees their committed
    // status. Fails closed.
    if (
      !(await installationCoversRepoInTx(
        tx,
        args.connectionId,
        args.projectId,
        args.installationId,
        args.repositoryId,
      ))
    ) {
      return { outcome: 'install-revoked' };
    }

    // Re-validate the branch under the row lock. auth-oidc's pre-tx branch check
    // can race a PATCH that re-points the branch after the check but before this
    // lock; the locked row is authoritative. Reject if the connected branch moved.
    if (
      args.branch !== null &&
      args.branch !== undefined &&
      args.branch !== '' &&
      conn.branch !== args.branch
    ) {
      return { outcome: 'branch-mismatch' };
    }

    // Re-validate the authorized workflow path under the SAME row lock — the same
    // TOCTOU class as the branch check above. auth-oidc's pre-tx gate compares the
    // OIDC token's own workflow file against the connection SNAPSHOT; a PATCH that
    // re-pins workflow_path can commit between that check and this lock. A
    // workflow_path change cannot filter-cancel by workflow (builds don't record
    // the workflow that authorized them), so the locked row is the authority:
    // reject if the token's workflow no longer matches the current pin, closing the
    // window in which a just-de-authorized workflow could still mint a token.
    if (conn.workflow_path !== args.expectedWorkflowPath) {
      return { outcome: 'workflow-mismatch' };
    }

    // Idempotent reuse: an already in-flight build for this exact run ATTEMPT
    // does not consume a new slot and must not be double-inserted. Matching on
    // the attempt (not run_id alone) ensures a RERUN — same run_id, incremented
    // run_attempt — does NOT wrongly reuse the prior attempt's build.
    const existing = await getBuildByProjectRunIdAndAttempt(
      tx,
      args.projectId,
      args.githubRunId,
      args.githubRunAttempt,
    );
    if (existing && ACTIVE_BUILD_STATUSES.includes(existing.status)) {
      return { outcome: 'reused', build: existing };
    }

    // Latest-wins: a newer run for the same project+branch supersedes ALL other
    // active GitHub Actions builds — including an older ATTEMPT of the SAME
    // run_id (a rerun reuses run_id with an incremented run_attempt). The
    // idempotent-reuse check above already returned early for an ACTIVE exact
    // (run_id, attempt) row, and this row's INSERT happens AFTER this UPDATE, so
    // the current attempt can't self-cancel. Marking them terminal frees the
    // owner's concurrency slot and revokes their deploy token so they can't race
    // `void deploy` for the project — without this, a still-ACTIVE attempt-1
    // (whose completion webhook was missed) would survive until the stale-build reaper.
    // (The scaffolded workflow's `concurrency: cancel-in-progress` cancels the
    // older RUN on GitHub's side; this is the server-side backstop.)
    if (args.branch !== null && args.branch !== undefined && args.branch !== '') {
      await tx
        .update(builds)
        .set({ status: 'cancelled', error: 'superseded by newer run', completed_at: sql`now()` })
        .where(
          and(
            eq(builds.project_id, args.projectId),
            eq(builds.branch, args.branch),
            eq(builds.executor, 'github_actions'),
            inArray(builds.status, ACTIVE_BUILD_STATUSES),
          ),
        );
    }

    if (limit > 0) {
      const [result] = await tx
        .select({ count: count() })
        .from(builds)
        .where(
          and(eq(builds.user_id, proj.user_id), inArray(builds.status, ACTIVE_BUILD_STATUSES)),
        );
      if ((result?.count ?? 0) >= limit) {
        return { outcome: 'limit-exceeded' };
      }
    }

    const id = generateId('bld');
    const [row] = await tx
      .insert(builds)
      .values({
        id,
        project_id: args.projectId,
        user_id: proj.user_id,
        executor: 'github_actions',
        status: 'building',
        commit_sha: args.commitSha ?? null,
        branch: args.branch ?? null,
        github_run_id: args.githubRunId,
        github_run_attempt: args.githubRunAttempt,
        logs_url: args.logsUrl ?? null,
      })
      .returning();
    return {
      outcome: 'created',
      build: row,
      timeoutMinutes: ownerPlan?.limits.buildTimeoutMinutes ?? 0,
    };
  });
}

/**
 * Claims a queued container build under the same owner lock used by GitHub
 * Actions admission. The lock protects both the per-owner limit and the
 * one-active-build-per-project invariant.
 */
export async function claimBuildForStartWithinLimit(
  db: Db,
  args: {
    buildId: string;
    userId: string;
    projectId: string;
  },
): Promise<{ instanceType: string; ownerPlan: PlanId; timeoutMinutes: number } | null> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ plan: users.plan, suspendedReason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, args.userId))
      .for('update')
      .limit(1);
    if (!owner || isAdminSuspended(owner.suspendedReason)) {
      return null;
    }

    const plan = await resolvePlan(tx, owner.plan);
    const limit = plan.limits.concurrentBuilds;
    if (limit > 0) {
      const [result] = await tx
        .select({ count: count() })
        .from(builds)
        .where(and(eq(builds.user_id, args.userId), inArray(builds.status, ACTIVE_BUILD_STATUSES)));
      if ((result?.count ?? 0) >= limit) {
        return null;
      }
    }

    // All builds for a project share an owner, so this is protected by the
    // owner lock. GitHub Actions builds count because deployments serialize at
    // the project level regardless of executor.
    const [active] = await tx
      .select({ count: count() })
      .from(builds)
      .where(
        and(eq(builds.project_id, args.projectId), inArray(builds.status, ACTIVE_BUILD_STATUSES)),
      );
    if ((active?.count ?? 0) > 0) {
      return null;
    }

    const [claimed] = await tx
      .update(builds)
      .set({
        status: 'starting',
        started_at: sql`now()`,
        instance_type: sql`coalesce(${builds.instance_type}, ${plan.buildInstanceType})`,
      })
      .where(and(eq(builds.id, args.buildId), eq(builds.status, 'queued')))
      .returning();
    if (!claimed) {
      return null;
    }
    if (!claimed.instance_type) {
      throw new Error('claimed build has no instance type');
    }
    return {
      instanceType: claimed.instance_type,
      ownerPlan: owner.plan,
      timeoutMinutes: plan.limits.buildTimeoutMinutes,
    };
  });
}
