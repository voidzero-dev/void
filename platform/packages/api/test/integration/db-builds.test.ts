import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  cancelQueuedContainerBuildsForUsers,
  claimBuildForStartWithinLimit,
  createGitHubConnection as createGitHubConnectionRecord,
  createGithubActionsBuildWithinLimit,
  deleteGitHubConnection,
  deleteProjectCascade,
  failStaleActiveContainerBuilds,
  getBuild,
  getBuildByProjectRunIdAndAttempt,
  getDeploymentByProjectAndCommit,
  getGitHubConnection,
  getGitHubConnectionsByRepo,
  getGitHubInstallation,
  getGitHubInstallationsByUser,
  getProject,
  getProjectBuilds,
  getProjectResources,
  getQueuedBuilds,
  getUsersWithQueuedContainerBuilds,
  hasQueuedContainerBuilds,
  installationCoversRepo,
  linkGitHubInstallationToUser,
  markBuildBuildingIfStarting,
  markBuildProgressIfActive,
  markGitHubInstallationStatus,
  requeueBuildIfStarting,
  setBuildCheckRunId,
  setGitHubInstallationRepositories,
  supersedeAndCreateContainerBuild,
  terminateBuildsForProject,
  updateBuildStatus,
  updateGitHubConnection,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import {
  builds,
  deployments,
  projectMembers,
  projects,
  resources,
  users,
} from '../../src/schema.ts';
import {
  createTestBuild,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

// The immutable numeric repo id (as text) used by the in-tx install
// re-check. The build txns confirm the install still covers this repo, so
// every test reaching that check seeds an install whose selection includes it
// (or an `all`-repos install). Connections also carry it so the helper's
// repositoryId arg is non-null (a null id fails closed).
const DEFAULT_REPO_ID = '42';

async function createGitHubConnection(
  db: Db,
  args: Omit<Parameters<typeof createGitHubConnectionRecord>[1], 'authorizedByUserId'> & {
    authorizedByUserId?: string;
  },
) {
  const project = await getProject(db, args.projectId);
  if (!project) {
    throw new Error('test project missing');
  }
  return createGitHubConnectionRecord(db, {
    ...args,
    authorizedByUserId: args.authorizedByUserId ?? project.user_id,
  });
}

// Seed an ACTIVE GitHub App installation so the in-tx re-check
// (`installationCoversRepoInTx`) passes. Defaults to an `all`-repos install
// (membership not enforced); pass `repositories` for a `selected` install.
async function seedActiveInstall(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<{ full_name: string; id: number }> = [],
  repositorySelection: 'all' | 'selected' = repositories.length > 0 ? 'selected' : 'all',
): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: `acct-${installationId}`,
    accountId: installationId,
    accountType: 'Organization',
    repositories,
    repositorySelection,
  });
}

beforeEach(async () => {
  await clearTables(env.db);
});

describe('builds', () => {
  it('createTestBuild defaults executor=container, status=queued and getBuild reads it back', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      commitSha: 'abc123',
      branch: 'main',
    });

    expect(build.id.startsWith('bld_')).toBe(true);
    expect(build.executor).toBe('container');
    expect(build.status).toBe('queued');
    expect(build.commit_sha).toBe('abc123');
    expect(build.branch).toBe('main');
    expect(build.deployment_id).toBeNull();
    expect(build.started_at).toBeNull();

    const fetched = await getBuild(env.db, build.id);
    expect(fetched?.id).toBe(build.id);
  });

  it('createTestBuild records github_actions executor + run/log metadata', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'deadbeef',
      branch: 'release',
      githubRunId: '99887766',
      logsUrl: 'https://github.com/acme/app/actions/runs/99887766',
      instanceType: 'standard-2',
    });

    expect(build.executor).toBe('github_actions');
    expect(build.status).toBe('building');
    expect(build.github_run_id).toBe('99887766');
    expect(build.logs_url).toBe('https://github.com/acme/app/actions/runs/99887766');
    expect(build.instance_type).toBe('standard-2');
  });

  it('getProjectBuilds returns newest-first and honors the limit', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const first = await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    const second = await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    const third = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    const all = await getProjectBuilds(env.db, project.id);
    expect(all.map((b) => b.id)).toEqual([third.id, second.id, first.id]);

    const limited = await getProjectBuilds(env.db, project.id, 2);
    expect(limited).toHaveLength(2);
  });

  it('getQueuedBuilds returns the oldest queued container build per idle project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const q1 = await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    const q2 = await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    // q1 is older than q2 so the per-project candidate is q1 (oldest).
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '2 minute'` })
      .where(eq(builds.id, q1.id));
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '1 minute'` })
      .where(eq(builds.id, q2.id));
    // queued github_actions build — wrong executor.
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
    });

    // One row for the (idle) project, and it is that project's OLDEST queued build.
    const queued = await getQueuedBuilds(env.db);
    expect(queued.map((b) => b.id)).toEqual([q1.id]);
  });

  it("getQueuedBuilds surfaces an idle project even when another of the user's projects is active", async () => {
    // A per-user scan (DISTINCT ON user_id) would surface the user's oldest
    // build across ALL projects; if that project were active, the user's OTHER
    // startable project would never be surfaced. The per-idle-project scan
    // excludes the busy project and returns the idle one's build.
    const user = await createTestUser(env.db);
    const busy = await createTestProject(env.db, user.id, 'starve-busy');
    const idle = await createTestProject(env.db, user.id, 'starve-idle');

    // Project X (busy): an active build PLUS an older queued build.
    await createTestBuild(env.db, { projectId: busy.id, userId: user.id, status: 'building' });
    const busyQueued = await createTestBuild(env.db, { projectId: busy.id, userId: user.id });
    // Project Y (idle): a NEWER queued build that must still be surfaced.
    const idleQueued = await createTestBuild(env.db, { projectId: idle.id, userId: user.id });

    // busy's queued build is OLDER than idle's, so a per-user "oldest" scan would
    // have picked busy (and hidden idle behind it).
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '2 minute'` })
      .where(eq(builds.id, busyQueued.id));
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '1 minute'` })
      .where(eq(builds.id, idleQueued.id));

    const queued = await getQueuedBuilds(env.db, 50);
    expect(queued.map((b) => b.id)).toEqual([idleQueued.id]);
  });

  it('getQueuedBuilds excludes a project that already has an active build', async () => {
    // A project with an active build must not be surfaced at all,
    // regardless of how many queued builds it has.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    await createTestBuild(env.db, { projectId: project.id, userId: user.id, status: 'starting' });
    await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    expect(await getQueuedBuilds(env.db, 50)).toEqual([]);
  });

  it("getQueuedBuilds surfaces both of a user's idle projects (one per project)", async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'two-idle-a');
    const projectB = await createTestProject(env.db, user.id, 'two-idle-b');

    const a = await createTestBuild(env.db, { projectId: projectA.id, userId: user.id });
    const b = await createTestBuild(env.db, { projectId: projectB.id, userId: user.id });

    const queued = await getQueuedBuilds(env.db, 50);
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((bld) => bld.id))).toEqual(new Set([a.id, b.id]));
  });

  it('getQueuedBuilds excludes builds owned by excludeUserIds', async () => {
    // The scheduler passes ids of users AT their plan cap so the scan
    // never wastes its window on rows the claim step would only reject. An empty
    // exclude list must NOT change behavior (no `NOT IN ()`).
    const capped = await createTestUser(env.db, 'capped-user');
    const eligible = await createTestUser(env.db, 'eligible-user');
    const cappedProj = await createTestProject(env.db, capped.id, 'r95-capped');
    const eligibleProj = await createTestProject(env.db, eligible.id, 'r95-eligible');

    const cappedBuild = await createTestBuild(env.db, {
      projectId: cappedProj.id,
      userId: capped.id,
    });
    const eligibleBuild = await createTestBuild(env.db, {
      projectId: eligibleProj.id,
      userId: eligible.id,
    });

    // No exclusions → both surface.
    const all = await getQueuedBuilds(env.db, 50);
    expect(new Set(all.map((b) => b.id))).toEqual(new Set([cappedBuild.id, eligibleBuild.id]));

    // Exclude the capped owner → only the eligible owner's build remains.
    const filtered = await getQueuedBuilds(env.db, 50, [capped.id]);
    expect(filtered.map((b) => b.id)).toEqual([eligibleBuild.id]);
  });

  it('getQueuedBuilds orders globally oldest-first across idle projects (age-fair)', async () => {
    // The scan must surface the globally oldest-waiting startable build
    // first, not the lowest project_id. Three idle projects across two users;
    // the LIMIT must keep the oldest two regardless of project_id.
    const user = await createTestUser(env.db);
    const projA = await createTestProject(env.db, user.id, 'age-a');
    const projB = await createTestProject(env.db, user.id, 'age-b');
    const projC = await createTestProject(env.db, user.id, 'age-c');

    const oldest = await createTestBuild(env.db, { projectId: projB.id, userId: user.id });
    const middle = await createTestBuild(env.db, { projectId: projC.id, userId: user.id });
    const newest = await createTestBuild(env.db, { projectId: projA.id, userId: user.id });
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '3 minute'` })
      .where(eq(builds.id, oldest.id));
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '2 minute'` })
      .where(eq(builds.id, middle.id));
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '1 minute'` })
      .where(eq(builds.id, newest.id));

    // Full scan: oldest-waiting first.
    const ordered = await getQueuedBuilds(env.db, 50);
    expect(ordered.map((b) => b.id)).toEqual([oldest.id, middle.id, newest.id]);

    // Limit applies AFTER the age sort, so the two oldest survive — not the two
    // lowest project_ids.
    const limited = await getQueuedBuilds(env.db, 2);
    expect(limited.map((b) => b.id)).toEqual([oldest.id, middle.id]);
  });

  it('getUsersWithQueuedContainerBuilds reports queue owners + their active build counts', async () => {
    // Drives the scheduler's cap computation. Only users owning a QUEUED
    // CONTAINER build appear; the active count includes any executor (a
    // github_actions build also occupies a concurrency slot).
    const withQueued = await createTestUser(env.db, 'has-queued');
    const noQueued = await createTestUser(env.db, 'no-queued');
    const projWith = await createTestProject(env.db, withQueued.id, 'owners-with');
    const projNo = await createTestProject(env.db, noQueued.id, 'owners-no');

    // withQueued: one active container build + one active github_actions build
    // (both count) on one project, plus a QUEUED container build on a second
    // project so the project-serialization filter doesn't hide their queued work.
    const projWith2 = await createTestProject(env.db, withQueued.id, 'owners-with-2');
    await createTestBuild(env.db, {
      projectId: projWith.id,
      userId: withQueued.id,
      status: 'building',
    });
    await createTestBuild(env.db, {
      projectId: projWith.id,
      userId: withQueued.id,
      executor: 'github_actions',
      status: 'deploying',
    });
    await createTestBuild(env.db, { projectId: projWith2.id, userId: withQueued.id });
    await createTestBuild(env.db, {
      projectId: projWith.id,
      userId: withQueued.id,
      status: 'complete',
    });
    await createTestBuild(env.db, {
      projectId: projWith.id,
      userId: withQueued.id,
      status: 'failed',
    });

    // noQueued: only a completed build — must NOT appear (no queued container work).
    await createTestBuild(env.db, {
      projectId: projNo.id,
      userId: noQueued.id,
      status: 'complete',
    });

    const owners = await getUsersWithQueuedContainerBuilds(env.db);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toEqual({
      userId: withQueued.id,
      plan: 'free',
      suspendedReason: null,
      activeBuilds: 2,
    });
  });

  it('cancels all queued container builds for suspended owners, including blocked projects', async () => {
    const suspended = await createTestUser(env.db, 'batch-suspended-owner');
    const usageSuspended = await createTestUser(env.db, 'batch-usage-suspended-owner');
    const activeProject = await createTestProject(env.db, suspended.id, 'batch-active');
    const idleProject = await createTestProject(env.db, suspended.id, 'batch-idle');
    const usageProject = await createTestProject(env.db, usageSuspended.id, 'batch-usage');
    await createTestBuild(env.db, {
      projectId: activeProject.id,
      userId: suspended.id,
      status: 'building',
    });
    const blocked = await createTestBuild(env.db, {
      projectId: activeProject.id,
      userId: suspended.id,
    });
    const idle = await createTestBuild(env.db, { projectId: idleProject.id, userId: suspended.id });
    const usageQueued = await createTestBuild(env.db, {
      projectId: usageProject.id,
      userId: usageSuspended.id,
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, suspended.id));
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, usageSuspended.id));

    expect(
      (await getUsersWithQueuedContainerBuilds(env.db)).find(
        (owner) => owner.userId === suspended.id,
      ),
    ).toMatchObject({
      userId: suspended.id,
      suspendedReason: 'platform policy violation',
      activeBuilds: 1,
    });
    expect(
      await cancelQueuedContainerBuildsForUsers(env.db, [suspended.id, usageSuspended.id]),
    ).toBe(2);
    expect((await getBuild(env.db, blocked.id))?.status).toBe('cancelled');
    expect((await getBuild(env.db, idle.id))?.status).toBe('cancelled');
    expect((await getBuild(env.db, usageQueued.id))?.status).toBe('queued');
    expect(await hasQueuedContainerBuilds(env.db)).toBe(true);
  });

  it('hasQueuedContainerBuilds reflects whether any queued container build exists', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Empty queue.
    expect(await hasQueuedContainerBuilds(env.db)).toBe(false);

    // A queued container build for an ACTIVE project — getQueuedBuilds returns []
    // (it is blocked), but hasQueuedContainerBuilds must still report true so the
    // scheduler keeps a heartbeat until the project frees.
    await createTestBuild(env.db, { projectId: project.id, userId: user.id, status: 'building' });
    await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    expect(await getQueuedBuilds(env.db, 50)).toEqual([]);
    expect(await hasQueuedContainerBuilds(env.db)).toBe(true);

    // Only a queued github_actions build — not a container build.
    await env.db.delete(builds);
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
    });
    expect(await hasQueuedContainerBuilds(env.db)).toBe(false);
  });

  it('terminateBuildsForProject cancels every queued+active build (both executors), leaves terminal+other-project alone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const otherProject = await createTestProject(env.db, user.id);

    // Cancelled: queued/starting/building/deploying, both executors.
    // Stamp a known instance_type on this one so the returned object's
    // instance_type can be asserted to round-trip (the post-commit DO teardown
    // needs it to address the right container-size namespace).
    const queuedContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'queued',
      instanceType: 'standard-4',
    });
    const startingContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'starting',
    });
    const buildingContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'building',
    });
    const deployingActions = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'deploying',
    });
    // Left alone: terminal rows.
    const complete = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'complete',
    });
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'failed',
    });
    // Left alone: in-flight build on a DIFFERENT project.
    const otherProj = await createTestBuild(env.db, {
      projectId: otherProject.id,
      userId: user.id,
      status: 'building',
    });

    const cancelled = await terminateBuildsForProject(env.db, project.id, {
      reason: 'project disconnected',
    });

    // Returns id + executor + new status for exactly the four in-flight rows.
    expect(cancelled.map((b) => b.id).sort()).toEqual(
      [queuedContainer.id, startingContainer.id, buildingContainer.id, deployingActions.id].sort(),
    );
    expect(cancelled.every((b) => b.status === 'cancelled')).toBe(true);
    expect(cancelled.filter((b) => b.executor === 'container')).toHaveLength(3);
    expect(cancelled.filter((b) => b.executor === 'github_actions')).toHaveLength(1);
    // instance_type is carried out so the caller can address the right
    // container-size namespace; the stamped build round-trips its value, the
    // unstamped ones surface null.
    expect(cancelled.find((b) => b.id === queuedContainer.id)?.instance_type).toBe('standard-4');
    expect(cancelled.find((b) => b.id === startingContainer.id)?.instance_type).toBeNull();

    for (const id of [
      queuedContainer.id,
      startingContainer.id,
      buildingContainer.id,
      deployingActions.id,
    ]) {
      const row = await getBuild(env.db, id);
      expect(row!.status).toBe('cancelled');
      expect(row!.error).toBe('project disconnected');
      expect(row!.completed_at).not.toBeNull();
    }
    expect((await getBuild(env.db, complete.id))!.status).toBe('complete');
    expect((await getBuild(env.db, failed.id))!.status).toBe('failed');
    expect((await getBuild(env.db, otherProj.id))!.status).toBe('building');
  });

  it('terminateBuildsForProject filters by branch / executor and no-ops when nothing matches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const mainContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'building',
      branch: 'main',
    });
    const developContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      status: 'building',
      branch: 'develop',
    });
    const mainActions = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      branch: 'main',
    });

    // Branch filter: only the main-branch builds (both executors) cancel.
    const byBranch = await terminateBuildsForProject(env.db, project.id, {
      branch: 'main',
      reason: 'branch changed',
    });
    expect(byBranch.map((b) => b.id).sort()).toEqual([mainContainer.id, mainActions.id].sort());
    expect((await getBuild(env.db, developContainer.id))!.status).toBe('building');
    expect((await getBuild(env.db, mainContainer.id))!.error).toBe('branch changed');

    // Executor filter: only the remaining container build cancels.
    const byExecutor = await terminateBuildsForProject(env.db, project.id, {
      executor: 'container',
      reason: 'executor changed',
    });
    expect(byExecutor.map((b) => b.id)).toEqual([developContainer.id]);
    expect((await getBuild(env.db, developContainer.id))!.status).toBe('cancelled');

    // Nothing in-flight left -> no-op, empty result.
    const empty = await terminateBuildsForProject(env.db, project.id);
    expect(empty).toHaveLength(0);
  });

  it('supersedeAndCreateContainerBuild creates, supersedes older queued, and reuses in-flight/complete', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // First push for aaa -> a brand new queued build (nothing to supersede), so
    // the cancelled set is empty.
    const created = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(created.reused).toBe(false);
    expect(created.build!.status).toBe('queued');
    expect(created.build!.commit_sha).toBe('aaa');
    expect(created.build!.instance_type).toBe('standard-3');
    expect(created.cancelled).toEqual([]);

    // Newer push for bbb -> the aaa build is superseded (cancelled) and a new
    // bbb build is queued. The cancelled set reports the superseded aaa build.
    const superseded = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'bbb',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(superseded.reused).toBe(false);
    expect(superseded.build!.id).not.toBe(created.build!.id);
    // The returned `status` reflects the post-UPDATE row (RETURNING returns new
    // values), so the superseded build reports `cancelled`.
    expect(superseded.cancelled).toEqual([
      {
        id: created.build!.id,
        executor: 'container',
        status: 'cancelled',
        instance_type: 'standard-3',
      },
    ]);
    const cancelledAaa = await getBuild(env.db, created.build!.id);
    expect(cancelledAaa!.status).toBe('cancelled');
    expect(cancelledAaa!.error).toBe('superseded by newer push');

    // Redelivery while bbb is still queued -> reuse, no new row, cancels nothing.
    const reusedQueued = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'bbb',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(reusedQueued.reused).toBe(true);
    expect(reusedQueued.build!.id).toBe(superseded.build!.id);
    expect(reusedQueued.cancelled).toEqual([]);

    // Mark bbb complete AND make it the project's LIVE deployment, then redeliver
    // -> reuse the COMPLETE build (no re-enqueue of an already-deployed commit),
    // cancels nothing. The live-deployment link is what proves this is a true
    // redelivery (not a rollback), so the complete build is reused.
    const depBbb = await createTestDeployment(env.db, project.id, 'live');
    await updateBuildStatus(env.db, superseded.build!.id, 'complete', { deploymentId: depBbb.id });
    const reusedComplete = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'bbb',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(reusedComplete.reused).toBe(true);
    expect(reusedComplete.build!.id).toBe(superseded.build!.id);
    expect(reusedComplete.cancelled).toEqual([]);
  });

  it('uses the locked current owner and plan when ownership changed after webhook resolution', async () => {
    const staleOwner = await createTestUser(
      env.db,
      'container-stale-owner',
      'github',
      undefined,
      'pro',
    );
    const currentOwner = await createTestUser(env.db, 'container-current-owner');
    const project = await createTestProject(env.db, staleOwner.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'container-owner-race',
      repoFullName: 'acme/owner-race',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, 'container-owner-race');
    await env.db
      .update(projects)
      .set({ user_id: currentOwner.id })
      .where(eq(projects.id, project.id));
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: staleOwner.id,
      role: 'admin',
      added_by_user_id: currentOwner.id,
    });

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'owner-race',
      installationId: 'container-owner-race',
      repositoryId: DEFAULT_REPO_ID,
    });

    expect(result.build?.user_id).toBe(currentOwner.id);
    expect(result.build?.instance_type).toBe('standard-3');
  });

  // Same-SHA recreate race — a branch-delete cancellation samples a DB-clock fence
  // BEFORE confirming the branch absent, then cancels active builds with
  // created_at <= fence. If the branch is deleted then recreated at the SAME commit
  // and the recreate push REUSES the still-active in-flight row (path a) instead of
  // inserting a fresh post-fence row, the reused row would keep its pre-fence
  // created_at and be wrongly cancelled when the delete tx interleaves after the
  // push (it lost the connection FOR UPDATE race). The reuse path re-stamps
  // created_at to now(), making the row post-fence so it survives. github_actions is
  // immune (a recreate is a new workflow run → new run_id → a fresh row).
  it('supersedeAndCreateContainerBuild re-stamps created_at on active reuse so a pre-push branch-delete fence spares it', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');
    const connId = (await getGitHubConnection(env.db, project.id))!.id;

    // An in-flight build for commit 'A'.
    const first = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: connId,
      branch: 'main',
      commitSha: 'A',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(first.reused).toBe(false);
    // Age it well before the fence (a build that has been running a while).
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '1 hour'` })
      .where(eq(builds.id, first.build!.id));

    // The branch-delete handler sampled its DB-clock fence BEFORE the recreate push
    // is processed. Model that ordering with a fence one minute in the past: the
    // build's original stamp (now()-1h) sits below it (so WITHOUT the re-stamp it
    // would be cancelled), while the reuse re-stamp
    // (now()) sits above it (so WITH the re-stamp it survives). A literal `now()`
    // here would tie the re-stamp's instant and make the assertion racy.
    const fenceRes = (await env.db.execute(
      sql`select (now() - interval '1 minute')::text as now`,
    )) as {
      rows: ReadonlyArray<{ now: string }>;
    };
    const fence = fenceRes.rows[0]!.now;

    // SAME-SHA recreate: a push for commit 'A' arrives and REUSES the in-flight row.
    const reused = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: connId,
      branch: 'main',
      commitSha: 'A',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(reused.reused).toBe(true);
    expect(reused.build!.id).toBe(first.build!.id);

    // The interleaved branch-delete cancellation runs with the pre-push fence. The
    // reused row was re-stamped to now() (> fence), so it MUST survive. Without the
    // re-stamp it would still carry its pre-fence created_at and be wrongly cancelled.
    const cancelled = await terminateBuildsForProject(env.db, project.id, {
      branch: 'main',
      reason: 'branch deleted',
      createdBefore: fence,
    });
    expect(cancelled).toEqual([]);
    expect((await getBuild(env.db, first.build!.id))!.status).not.toBe('cancelled');
  });

  // A force-push ROLLBACK to a previously-`complete` SHA that is
  // NOT what the project is currently live on must RE-DEPLOY it (enqueue a fresh
  // build), NOT reuse the stale complete row — otherwise the project stays live
  // on the newer commit while the branch head is the rolled-back SHA. A NEWER
  // in-flight build for the now-off-branch commit must STILL be cancelled
  // (otherwise it keeps a live deploy token and publishes the stale newer
  // commit). The supersede runs FIRST, before the reuse lookup, so it fires even
  // on a complete-SHA push.
  it('supersedeAndCreateContainerBuild rebuilds a complete SHA that is not live AND cancels a newer active build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // B1: a previously-deployed commit C1 on main, already `complete`. No live
    // deployment links to it (the project is not currently on C1).
    const b1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'C1',
      branch: 'main',
    });
    // B2: a NEWER in-flight (building) build for C2 on the same project+branch.
    const b2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'C2',
      branch: 'main',
    });

    // Roll back: push C1 again. C1 is NOT provably live (B1 has no deployment_id
    // link and there is no live deployment for C1) → REBUILD: a fresh queued C1
    // build is enqueued (not B1 reused), AND B2 is cancelled.
    const rollback = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'C1',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(rollback.reused).toBe(false);
    expect(rollback.build!.id).not.toBe(b1.id);
    expect(rollback.build!.status).toBe('queued');
    expect(rollback.build!.commit_sha).toBe('C1');
    // The newer active B2 is in the cancelled set with its post-UPDATE status.
    expect(rollback.cancelled).toEqual([
      { id: b2.id, executor: 'container', status: 'cancelled', instance_type: null },
    ]);
    const cancelledB2 = await getBuild(env.db, b2.id);
    expect(cancelledB2!.status).toBe('cancelled');
    expect(cancelledB2!.error).toBe('superseded by newer push');
    // B1 is left intact (complete builds are never terminalized by supersede).
    expect((await getBuild(env.db, b1.id))!.status).toBe('complete');
    // A fresh queued C1 build now exists alongside the old complete B1.
    const c1Builds = await getProjectBuilds(env.db, project.id);
    const queuedC1 = c1Builds.filter((b) => b.commit_sha === 'C1' && b.status === 'queued');
    expect(queuedC1).toHaveLength(1);
    expect(queuedC1[0]!.id).toBe(rollback.build!.id);

    // Same-commit redelivery of the rollback now reuses the freshly-queued C1
    // build (it is active/in-flight) — no self-cancel, no re-enqueue.
    const redeliver = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'C1',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(redeliver.reused).toBe(true);
    expect(redeliver.build!.id).toBe(rollback.build!.id);
    expect(redeliver.cancelled).toEqual([]);
  });

  // Rollback via the authoritative deployment_id link — deploy A
  // (live=depA, B1.deployment_id=depA), deploy B (live=depB), force-push A. A is
  // no longer live, so it must REBUILD even though B1 is `complete` AND linked to
  // depA (which is no longer the active deployment).
  it('supersedeAndCreateContainerBuild rebuilds on rollback when the complete SHA is no longer the live deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // Deploy A: complete build A linked to live deployment depA.
    const depA = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'A',
    });
    const buildA = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'A',
      branch: 'main',
    });
    await updateBuildStatus(env.db, buildA.id, 'complete', { deploymentId: depA.id });

    // Deploy B: complete build B linked to live deployment depB (now the active).
    const depB = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'B',
    });
    const buildB = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'B',
      branch: 'main',
    });
    await updateBuildStatus(env.db, buildB.id, 'complete', { deploymentId: depB.id });
    // Sanity: depB is the active deployment.
    const [projRow] = await env.db
      .select({ active: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, project.id));
    expect(projRow!.active).toBe(depB.id);

    // Force-push back to A → A is not live → REBUILD (new queued A build).
    const rollback = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'A',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(rollback.reused).toBe(false);
    expect(rollback.build!.id).not.toBe(buildA.id);
    expect(rollback.build!.status).toBe('queued');
    expect(rollback.build!.commit_sha).toBe('A');
  });

  // Genuine redelivery — A is the current live deployment (live=depA,
  // buildA.deployment_id=depA). A redelivered push for A must REUSE the complete
  // build via the authoritative deployment_id link, with no new build and no
  // cancellations.
  it('supersedeAndCreateContainerBuild reuses a complete build whose deployment is currently live', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    const depA = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'A',
    });
    const buildA = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'A',
      branch: 'main',
    });
    await updateBuildStatus(env.db, buildA.id, 'complete', { deploymentId: depA.id });

    const redeliver = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'A',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(redeliver.reused).toBe(true);
    expect(redeliver.build!.id).toBe(buildA.id);
    expect(redeliver.cancelled).toEqual([]);
    // No new build was enqueued.
    const all = await getProjectBuilds(env.db, project.id);
    expect(all.filter((b) => b.commit_sha === 'A')).toHaveLength(1);
  });

  // In-flight idempotency — an ACTIVE (building) build for A is always
  // reused regardless of what is (or isn't) live, so a redelivered push doesn't
  // duplicate an in-flight build.
  it('supersedeAndCreateContainerBuild reuses an in-flight build for the commit regardless of live deployment', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // Project is live on a different (unrelated) commit B.
    await createTestDeployment(env.db, project.id, 'live', undefined, undefined, { commit: 'B' });
    const activeA = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'A',
      branch: 'main',
    });

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'A',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.reused).toBe(true);
    expect(result.build!.id).toBe(activeA.id);
  });

  it('supersedeAndCreateContainerBuild cancels an older ACTIVE build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // An ACTIVE (building) container build for C1 on main.
    const active = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c1',
      branch: 'main',
    });

    // A newer push for C2 supersedes the active C1 build and returns it in the
    // cancelled set with its prior status.
    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'c2',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.reused).toBe(false);
    expect(result.build!.commit_sha).toBe('c2');
    // The returned `status` reflects the post-UPDATE row (RETURNING returns new
    // values), so the cancelled active build reports `cancelled`, not `building`.
    expect(result.cancelled).toEqual([
      { id: active.id, executor: 'container', status: 'cancelled', instance_type: null },
    ]);
    const updated = await getBuild(env.db, active.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('superseded by newer push');
  });

  it('supersedeAndCreateContainerBuild spares an active build AT the new commit (exceptCommitSha)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // An ACTIVE build already in flight for the new head commit C2 (a redelivery
    // race that already enqueued/started for C2).
    const atHead = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c2',
      branch: 'main',
    });

    // A push for the SAME commit C2 dedups to the existing in-flight build and
    // cancels nothing (a delivery must never cancel itself).
    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'c2',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.reused).toBe(true);
    expect(result.build!.id).toBe(atHead.id);
    expect(result.cancelled).toEqual([]);
    expect((await getBuild(env.db, atHead.id))!.status).toBe('building');
  });

  it('supersedeAndCreateContainerBuild retries after a failed build (failed does not block)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    const first = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    await updateBuildStatus(env.db, first.build!.id, 'failed');

    // Re-pushing aaa after the failure must enqueue a NEW queued build.
    const retry = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(retry.reused).toBe(false);
    expect(retry.build!.id).not.toBe(first.build!.id);
    expect(retry.build!.status).toBe('queued');
    expect((await getBuild(env.db, first.build!.id))!.status).toBe('failed');
  });

  // The enqueue tx locks + re-reads the connection and skips when a
  // concurrent PATCH changed the branch/executor first. A skip returns
  // `{ build: null, skipped: 'config-changed', cancelled: [] }` and inserts no row.
  it('supersedeAndCreateContainerBuild skips when the connection branch no longer matches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Connection now points at 'dev'; a delayed push for 'main' must skip.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'dev',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.build).toBeNull();
    expect(result.reused).toBe(false);
    expect(result.skipped).toBe('config-changed');
    expect(result.cancelled).toEqual([]);
    // No queued row was inserted.
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('supersedeAndCreateContainerBuild skips when the connection executor is no longer container', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // Connection switched to github_actions; a container enqueue must skip.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, '12345');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.build).toBeNull();
    expect(result.skipped).toBe('config-changed');
    expect(result.cancelled).toEqual([]);
    // No container build row was inserted.
    expect(
      (await getProjectBuilds(env.db, project.id)).filter((b) => b.executor === 'container'),
    ).toEqual([]);
  });

  it('supersedeAndCreateContainerBuild skips when the project is being deleted', async () => {
    // A push landing after teardownProject flipped the project to `deleting`
    // (but before the cascade deleted the connection) must not enqueue a build
    // for a project being torn down — it would burn a build slot. Mirrors the
    // GitHub Actions path's project-deleting guard.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');
    const connectionId = (await getGitHubConnection(env.db, project.id))!.id;
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.build).toBeNull();
    expect(result.reused).toBe(false);
    expect(result.skipped).toBe('project-deleting');
    expect(result.cancelled).toEqual([]);
    // No build row was inserted.
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('supersedeAndCreateContainerBuild skips manual owner suspension but permits usage suspension', async () => {
    const user = await createTestUser(env.db, 'container-suspended-owner');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'container-suspended-owner',
      repoFullName: 'acme/suspended-owner',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, 'container-suspended-owner');
    const connectionId = (await getGitHubConnection(env.db, project.id))!.id;
    const args = {
      projectId: project.id,
      connectionId,
      userId: user.id,
      branch: 'main',
      commitSha: 'suspended-owner',
      installationId: 'container-suspended-owner',
      repositoryId: DEFAULT_REPO_ID,
    } as const;

    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, user.id));
    const suspended = await supersedeAndCreateContainerBuild(env.db, args);
    expect(suspended).toMatchObject({ build: null, skipped: 'owner-suspended' });
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));
    const usageSuspended = await supersedeAndCreateContainerBuild(env.db, args);
    expect(usageSuspended.build?.status).toBe('queued');
  });

  it('supersedeAndCreateContainerBuild inserts when the connection branch+executor match', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.skipped).toBeUndefined();
    expect(result.reused).toBe(false);
    expect(result.build!.status).toBe('queued');
    expect(result.build!.commit_sha).toBe('aaa');
  });

  // The enqueue tx re-checks installation status + repo membership under
  // the connection lock. A revocation (App suspend/uninstall, repo removal) that
  // commits AFTER the push resolver's checks but BEFORE this tx is caught here:
  // no build row is enqueued, no deploy token is minted. Fails closed.
  it('supersedeAndCreateContainerBuild skips when the installation is SUSPENDED', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');
    await markGitHubInstallationStatus(env.db, '12345', 'suspended');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.build).toBeNull();
    expect(result.skipped).toBe('install-revoked');
    expect(result.cancelled).toEqual([]);
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('supersedeAndCreateContainerBuild skips when the installation is DELETED', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');
    await markGitHubInstallationStatus(env.db, '12345', 'deleted');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.build).toBeNull();
    expect(result.skipped).toBe('install-revoked');
    expect(result.cancelled).toEqual([]);
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('supersedeAndCreateContainerBuild skips when a SELECTED install no longer covers the repo', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    // A 'selected' install whose cached set does NOT include this repo's id (42).
    await seedActiveInstall(env.db, '12345', [{ full_name: 'acme/other', id: 999 }], 'selected');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.build).toBeNull();
    expect(result.skipped).toBe('install-revoked');
    expect(result.cancelled).toEqual([]);
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('supersedeAndCreateContainerBuild builds when a SELECTED install covers the repo', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    // A 'selected' install whose cached set INCLUDES this repo by id (42).
    await seedActiveInstall(env.db, '12345', [{ full_name: 'acme/app', id: 42 }], 'selected');

    const result = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(result.skipped).toBeUndefined();
    expect(result.build!.status).toBe('queued');
    expect(result.build!.commit_sha).toBe('aaa');
  });

  // The enqueue tx must assert the LOCKED connection is the SAME row the
  // caller resolved. `github_connections.project_id` is UNIQUE, so a
  // disconnect+reconnect to a DIFFERENT repo (same branch/executor, and crucially
  // the SAME installation_id + repository_id) DELETEs the old row and CREATEs a
  // new one with a fresh id between resolution and this tx. The branch/executor
  // guard and the install check both PASS for such a swap (the install check
  // keys on the PASSED installationId), so the id-match is the only guard that
  // catches it. A stale resolved id => `connection-replaced`, no build row.
  it('supersedeAndCreateContainerBuild skips when the connection was disconnected+reconnected', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const cOld = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, '12345');

    // Disconnect + reconnect to the SAME repo/branch/executor/install — proving the
    // install check does NOT catch this (identical installation_id +
    // repository_id) — only the row id changes.
    await deleteGitHubConnection(env.db, project.id);
    const cNew = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'container',
    });
    expect(cNew.id).not.toBe(cOld.id);

    // The caller resolved the OLD connection id; the locked row is now the NEW one.
    const replaced = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: cOld.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(replaced.build).toBeNull();
    expect(replaced.reused).toBe(false);
    expect(replaced.skipped).toBe('connection-replaced');
    expect(replaced.cancelled).toEqual([]);
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);

    // Matching-id happy case: resolving the CURRENT connection builds normally.
    const ok = await supersedeAndCreateContainerBuild(env.db, {
      projectId: project.id,
      connectionId: cNew.id,
      branch: 'main',
      commitSha: 'aaa',
      installationId: '12345',
      repositoryId: DEFAULT_REPO_ID,
    });
    expect(ok.skipped).toBeUndefined();
    expect(ok.build!.status).toBe('queued');
    expect(ok.build!.commit_sha).toBe('aaa');
  });

  it('failStaleActiveContainerBuilds fails over-age container builds (by started_at) and frees the slot', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Over-age active container build: started 90 min ago (> 75 min cutoff).
    // Stamp a known instance_type so the reaped object round-trips it out — the
    // scheduled reaper needs it to address the right container-size namespace.
    const stale = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      instanceType: 'standard-4',
    });
    await env.db
      .update(builds)
      .set({ started_at: sql`now() - interval '90 minute'` })
      .where(eq(builds.id, stale.id));

    // Fresh active container build: started 5 min ago — must be left alone.
    const fresh = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    await env.db
      .update(builds)
      .set({ started_at: sql`now() - interval '5 minute'` })
      .where(eq(builds.id, fresh.id));

    // Returns the reaped builds with their instance_type so the scheduled
    // handler can best-effort stop the
    // still-alive containers via the correctly-sized BuildManager namespace.
    const reaped = await failStaleActiveContainerBuilds(env.db, 75);
    expect(reaped).toEqual([{ id: stale.id, instance_type: 'standard-4' }]);

    const staleRow = await getBuild(env.db, stale.id);
    expect(staleRow?.status).toBe('failed');
    expect(staleRow?.completed_at).not.toBeNull();
    expect(staleRow?.error).toBe('build exceeded max lifetime (stale reaper)');

    // Fresh build is untouched.
    const freshRow = await getBuild(env.db, fresh.id);
    expect(freshRow?.status).toBe('building');
    expect(freshRow?.completed_at).toBeNull();
  });

  it('failStaleActiveContainerBuilds leaves over-age github_actions builds alone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Over-age active GitHub Actions build — the CONTAINER reaper must not touch it.
    const actions = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    await env.db
      .update(builds)
      .set({ started_at: sql`now() - interval '90 minute'` })
      .where(eq(builds.id, actions.id));

    const reaped = await failStaleActiveContainerBuilds(env.db, 75);
    expect(reaped).toEqual([]);

    const actionsRow = await getBuild(env.db, actions.id);
    expect(actionsRow?.status).toBe('building');
    expect(actionsRow?.completed_at).toBeNull();
  });

  it('claimBuildForStartWithinLimit atomically flips queued -> starting once', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    const claimed = await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    expect(claimed).toMatchObject({ instanceType: 'standard-3', ownerPlan: 'free' });
    const row = await getBuild(env.db, build.id);
    expect(row?.status).toBe('starting');
    expect(row?.started_at).not.toBeNull();

    // Second claim of the same build sees it is no longer queued.
    const reclaimed = await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    expect(reclaimed).toBeNull();
  });

  it('claimBuildForStartWithinLimit does not start a queued build for a manually suspended owner', async () => {
    const user = await createTestUser(env.db, 'claim-suspended-owner');
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, user.id));

    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: build.id,
        userId: user.id,
        projectId: project.id,
      }),
    ).toBeNull();
    expect((await getBuild(env.db, build.id))?.status).toBe('queued');
  });

  it('claimBuildForStartWithinLimit uses the locked owner plan', async () => {
    const user = await createTestUser(env.db, 'claim-current-plan');
    const activeProject = await createTestProject(env.db, user.id);
    const queuedProject = await createTestProject(env.db, user.id);
    await createTestBuild(env.db, {
      projectId: activeProject.id,
      userId: user.id,
      status: 'building',
    });
    const queued = await createTestBuild(env.db, {
      projectId: queuedProject.id,
      userId: user.id,
    });

    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: queued.id,
        userId: user.id,
        projectId: queuedProject.id,
      }),
    ).toBeNull();
    expect((await getBuild(env.db, queued.id))?.status).toBe('queued');
  });

  it('requeueBuildIfStarting returns a starting row to queued (CAS)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    // Claim flips queued -> starting.
    await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    expect((await getBuild(env.db, build.id))!.status).toBe('starting');

    // The CAS matches the `starting` row and bounces it back to `queued`.
    expect(await requeueBuildIfStarting(env.db, build.id)).toBe(true);
    expect((await getBuild(env.db, build.id))!.status).toBe('queued');
  });

  it('requeueBuildIfStarting no-ops on a cancelled row (terminal preserved)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    // Claim -> starting, then a concurrent terminalizer cancels it.
    await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    await terminateBuildsForProject(env.db, project.id, { reason: 'project disconnected' });
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    // The CAS does NOT resurrect a cancelled row — the terminal status stands.
    expect(await requeueBuildIfStarting(env.db, build.id)).toBe(false);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');
  });

  it('requeueBuildIfStarting no-ops on a building row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    // Claim -> starting, then onStart's CAS flips starting -> building.
    await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    await markBuildBuildingIfStarting(env.db, build.id);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');

    // The CAS only matches `starting`, so a building row is untouched.
    expect(await requeueBuildIfStarting(env.db, build.id)).toBe(false);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });

  // Real-PGlite proof that the progress CAS reads `affectedRows`
  // (PGlite) not just `rowCount` (pg), so a successful update is not mistaken
  // for a no-op.
  it('markBuildProgressIfActive advances an active building row to deploying (CAS, true)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    // Drive the row active: queued -> starting -> building.
    await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    await markBuildBuildingIfStarting(env.db, build.id);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');

    expect(await markBuildProgressIfActive(env.db, build.id, 'deploying')).toBe(true);
    expect((await getBuild(env.db, build.id))!.status).toBe('deploying');
  });

  // A row a concurrent terminalizer already
  // drove `cancelled` must NOT be resurrected to a progress status by a
  // forged/late agent report.
  it('markBuildProgressIfActive no-ops on a cancelled row (terminal preserved)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    // Claim -> starting, then a concurrent terminalizer cancels it.
    await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    await terminateBuildsForProject(env.db, project.id, { reason: 'project disconnected' });
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    // The CAS does NOT resurrect a cancelled row → false, status stands.
    expect(await markBuildProgressIfActive(env.db, build.id, 'deploying')).toBe(false);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');
  });

  // A `complete` row is terminal: the progress CAS no-ops against it.
  it('markBuildProgressIfActive no-ops on a complete row (false)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    await updateBuildStatus(env.db, build.id, 'complete');
    expect(await markBuildProgressIfActive(env.db, build.id, 'deploying')).toBe(false);
    expect((await getBuild(env.db, build.id))!.status).toBe('complete');
  });

  it('setBuildCheckRunId persists the check-run id and getBuild reads it back', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    // A fresh build has no check run yet.
    expect((await getBuild(env.db, build.id))!.check_run_id).toBeNull();

    await setBuildCheckRunId(env.db, build.id, '99001');
    expect((await getBuild(env.db, build.id))!.check_run_id).toBe('99001');
  });

  it('claimBuildForStartWithinLimit serializes builds per project (at most one active)', async () => {
    // pro plan has concurrentBuilds=3 (>= 2), so the per-user cap is NOT what
    // blocks the second build here — the per-project guard is.
    const user = await createTestUser(env.db, 'serialuser', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    // Two queued container builds for the SAME project: commit A older, B newer.
    const a = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      commitSha: 'aaa',
      branch: 'main',
    });
    const b = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      commitSha: 'bbb',
      branch: 'main',
    });

    // 1. A claims successfully -> starting.
    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: a.id,
        userId: user.id,
        projectId: project.id,
      }),
    ).not.toBeNull();
    expect((await getBuild(env.db, a.id))!.status).toBe('starting');

    // 2. B is blocked: the project already has an active build (A is starting),
    //    even though the user is well under the per-user cap. B stays queued.
    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: b.id,
        userId: user.id,
        projectId: project.id,
      }),
    ).toBeNull();
    expect((await getBuild(env.db, b.id))!.status).toBe('queued');

    // 3. Once A reaches a terminal status, the project has no active build, so
    //    a later tick claims B (latest-wins via FIFO drain).
    await updateBuildStatus(env.db, a.id, 'complete', {
      completedAt: new Date().toISOString(),
    });
    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: b.id,
        userId: user.id,
        projectId: project.id,
      }),
    ).not.toBeNull();
    expect((await getBuild(env.db, b.id))!.status).toBe('starting');
  });

  it('claimBuildForStartWithinLimit guard is per-project: two projects can both go active', async () => {
    // Same user, pro plan (cap 3). The per-project guard must not serialize
    // builds across DIFFERENT projects — both should claim.
    const user = await createTestUser(env.db, 'twoproj', 'github', undefined, 'pro');
    const projectA = await createTestProject(env.db, user.id);
    const projectB = await createTestProject(env.db, user.id);
    const a = await createTestBuild(env.db, { projectId: projectA.id, userId: user.id });
    const b = await createTestBuild(env.db, { projectId: projectB.id, userId: user.id });

    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: a.id,
        userId: user.id,
        projectId: projectA.id,
      }),
    ).not.toBeNull();
    expect(
      await claimBuildForStartWithinLimit(env.db, {
        buildId: b.id,
        userId: user.id,
        projectId: projectB.id,
      }),
    ).not.toBeNull();

    expect((await getBuild(env.db, a.id))!.status).toBe('starting');
    expect((await getBuild(env.db, b.id))!.status).toBe('starting');
  });

  it('claimBuildForStartWithinLimit persists the effective instance_type at claim time', async () => {
    const user = await createTestUser(env.db, 'claiminst', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      instanceType: null,
    });
    expect((await getBuild(env.db, build.id))!.instance_type).toBeNull();

    const claimed = await claimBuildForStartWithinLimit(env.db, {
      buildId: build.id,
      userId: user.id,
      projectId: project.id,
    });
    expect(claimed).toEqual({ instanceType: 'standard-4', ownerPlan: 'pro', timeoutMinutes: 15 });

    const row = await getBuild(env.db, build.id);
    expect(row!.status).toBe('starting');
    expect(row!.instance_type).toBe('standard-4');
  });

  it('updateBuildStatus sets terminal metadata and leaves untouched fields alone', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id);
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      instanceType: 'standard-1',
    });

    await updateBuildStatus(env.db, build.id, 'complete', {
      exitCode: 0,
      deploymentId: deployment.id,
      completedAt: new Date().toISOString(),
    });

    const updated = await getBuild(env.db, build.id);
    expect(updated?.status).toBe('complete');
    expect(updated?.exit_code).toBe(0);
    expect(updated?.deployment_id).toBe(deployment.id);
    expect(updated?.completed_at).not.toBeNull();
    expect(updated?.error).toBeNull();
    // instance_type was set at create time and not passed to the update.
    expect(updated?.instance_type).toBe('standard-1');
  });

  it('updateBuildStatus records an error + exit code on failure', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });

    await updateBuildStatus(env.db, build.id, 'failed', { error: 'boom', exitCode: 1 });

    const updated = await getBuild(env.db, build.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.error).toBe('boom');
    expect(updated?.exit_code).toBe(1);
  });

  it('deleteProjectCascade removes builds (incl. one pointing at a deleted deployment)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const deployment = await createTestDeployment(env.db, project.id);
    const build = await createTestBuild(env.db, { projectId: project.id, userId: user.id });
    // Point the build at the deployment so both build->project and
    // build->deployment FKs (ON DELETE NO ACTION) are in play during teardown.
    await updateBuildStatus(env.db, build.id, 'complete', { deploymentId: deployment.id });

    // Builds reference the project and deployment, so the cascade deletes them
    // inside its transaction (no foreign_key_violation). It terminalizes
    // in-flight builds first and returns them; a completed build is
    // already terminal, so nothing is returned for cancellation. No resources
    // exist, so deletedResources is empty too.
    await expect(deleteProjectCascade(env.db, project.id)).resolves.toEqual({
      cancelledBuilds: [],
      deletedResources: [],
    });
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('terminalizes + returns in-flight builds so the caller can stop their container DOs', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    const container = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      instanceType: 'standard-4',
    });
    const actions = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'deploying',
    });

    const { cancelledBuilds } = await deleteProjectCascade(env.db, project.id);

    // Both in-flight builds are returned (terminalized under the project lock)
    // so teardownProject can cancel the still-running container DO. The
    // github_actions build has no DO, but its row — and thus its deploy token —
    // is gone.
    expect(cancelledBuilds.map((b) => b.id).sort()).toEqual([container.id, actions.id].sort());
    expect(cancelledBuilds.find((b) => b.id === container.id)?.executor).toBe('container');
    expect(cancelledBuilds.find((b) => b.id === actions.id)?.executor).toBe('github_actions');
    // instance_type round-trips so teardownProject stops the container DO on the
    // correctly-sized BuildManager namespace.
    expect(cancelledBuilds.find((b) => b.id === container.id)?.instance_type).toBe('standard-4');
    // The rows are deleted by the cascade.
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('returns the deleted resource rows so teardown can clean race-window CF orphans', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // A resource whose row exists at cascade time — deleteProjectCascade must
    // return it so teardownProject can delete the CF object behind any resource
    // that raced the pre-cascade snapshot (its row is gone after this).
    await env.db.insert(resources).values({
      id: 'res_hd_cascade',
      project_id: project.id,
      type: 'hyperdrive',
      cf_id: 'hd-cf-id-cascade',
      binding_name: 'HYPERDRIVE',
    });

    const { deletedResources } = await deleteProjectCascade(env.db, project.id);

    expect(deletedResources.map((r) => r.cf_id)).toEqual(['hd-cf-id-cascade']);
    expect(deletedResources[0]?.type).toBe('hyperdrive');
    expect(await getProjectResources(env.db, project.id)).toEqual([]);
  });
});

describe('createGithubActionsBuildWithinLimit', () => {
  it('rejects manual owner suspension but permits usage suspension', async () => {
    const user = await createTestUser(env.db, 'actions-suspended-owner');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'actions-suspended-owner',
      repoFullName: 'acme/actions-suspended-owner',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'actions-suspended-owner');
    const args = {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: 'suspended-owner-1',
      githubRunAttempt: '1',
      installationId: 'actions-suspended-owner',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    } as const;

    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, user.id));
    expect((await createGithubActionsBuildWithinLimit(env.db, args)).outcome).toBe(
      'owner-suspended',
    );
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);

    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));
    expect(
      (
        await createGithubActionsBuildWithinLimit(env.db, {
          ...args,
          githubRunId: 'suspended-owner-2',
        })
      ).outcome,
    ).toBe('created');
  });

  it('recomputes concurrency and attribution from the locked current owner after transfer', async () => {
    const staleOwner = await createTestUser(
      env.db,
      'actions-stale-owner',
      'github',
      undefined,
      'pro',
    );
    const currentOwner = await createTestUser(env.db, 'actions-current-owner');
    const project = await createTestProject(env.db, staleOwner.id);
    const otherProject = await createTestProject(env.db, currentOwner.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'actions-owner-race',
      repoFullName: 'acme/actions-owner-race',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'actions-owner-race');
    await env.db
      .update(projects)
      .set({ user_id: currentOwner.id })
      .where(eq(projects.id, project.id));
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: staleOwner.id,
      role: 'admin',
      added_by_user_id: currentOwner.id,
    });
    const occupying = await createTestBuild(env.db, {
      projectId: otherProject.id,
      userId: currentOwner.id,
      executor: 'container',
      status: 'building',
    });
    const args = {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: 'owner-race-1',
      githubRunAttempt: '1',
      installationId: 'actions-owner-race',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    } as const;

    expect((await createGithubActionsBuildWithinLimit(env.db, args)).outcome).toBe(
      'limit-exceeded',
    );
    await updateBuildStatus(env.db, occupying.id, 'complete');
    const created = await createGithubActionsBuildWithinLimit(env.db, {
      ...args,
      githubRunId: 'owner-race-2',
    });
    expect(created.outcome).toBe('created');
    if (created.outcome === 'created') {
      expect(created.build.user_id).toBe(currentOwner.id);
    }
  });

  // The workflow_path gate in auth-oidc runs against the connection SNAPSHOT; the
  // locked re-read here is the authority. A concurrent PATCH that re-pins
  // workflow_path between the gate and this lock must fail the exchange closed so
  // a just-de-authorized workflow can't mint a token through the race window.
  it('rejects with workflow-mismatch when the pin no longer matches the token workflow', async () => {
    const user = await createTestUser(env.db, 'gha-wf-mismatch', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-wf',
      repoFullName: 'acme/wf',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
      // Pin (the locked row) is the default void-deploy.yml.
    });
    await seedActiveInstall(env.db, 'inst-wf');

    // expectedWorkflowPath is the OIDC token's OWN workflow (ci.yml) — it passed
    // the pre-tx gate when the pin was ci.yml, but the pin is now the default.
    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      githubRunId: '9001',
      githubRunAttempt: '1',
      installationId: 'inst-wf',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/ci.yml',
    });
    expect(result.outcome).toBe('workflow-mismatch');
  });

  it('supersedes an older active run for the same project+branch (latest-wins)', async () => {
    const user = await createTestUser(env.db, 'gha-supersede', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-supersede',
      repoFullName: 'acme/supersede',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-supersede');

    const first = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '1001',
      githubRunAttempt: '1',
      installationId: 'inst-supersede',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      throw new Error('unreachable');
    }
    expect(first.build.status).toBe('building');

    const second = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '1002',
      githubRunAttempt: '1',
      installationId: 'inst-supersede',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(second.outcome).toBe('created');
    if (second.outcome !== 'created') {
      throw new Error('unreachable');
    }
    expect(second.build.status).toBe('building');

    // The first (older run) was superseded; the second (newer run) is active.
    const superseded = await getBuild(env.db, first.build.id);
    expect(superseded!.status).toBe('cancelled');
    expect(superseded!.error).toBe('superseded by newer run');
    expect(superseded!.completed_at).not.toBeNull();
    expect((await getBuild(env.db, second.build.id))!.status).toBe('building');
  });

  it('reuses (does not supersede) on a repeated exchange for the SAME run', async () => {
    const user = await createTestUser(env.db, 'gha-reuse', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-reuse',
      repoFullName: 'acme/reuse',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-reuse');

    const first = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '2001',
      githubRunAttempt: '1',
      installationId: 'inst-reuse',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      throw new Error('unreachable');
    }

    const repeat = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '2001',
      githubRunAttempt: '1',
      installationId: 'inst-reuse',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(repeat.outcome).toBe('reused');
    if (repeat.outcome !== 'reused') {
      throw new Error('unreachable');
    }
    expect(repeat.build.id).toBe(first.build.id);

    // No duplicate row, and the single build stays active (not superseded).
    const all = await getProjectBuilds(env.db, project.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('building');
  });

  it('does NOT supersede an active Actions build on a DIFFERENT branch', async () => {
    const user = await createTestUser(env.db, 'gha-branch', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    // Connection is on `main` (schema default). A connection only ever has ONE
    // branch, so the OIDC helper only creates builds for THAT branch (the branch
    // re-check rejects others). Seed the off-branch (`develop`) build DIRECTLY to
    // model a stray build from a prior connection branch.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-branch',
      repoFullName: 'acme/branch',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-branch');

    const onDevelop = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      branch: 'develop',
      githubRunId: '3001',
    });

    const onMain = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '3002',
      githubRunAttempt: '1',
      installationId: 'inst-branch',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(onMain.outcome).toBe('created');

    // The develop build is untouched — supersede is scoped to project+branch.
    expect((await getBuild(env.db, onDevelop.id))!.status).toBe('building');
  });

  it('enforces the per-user cap, and a superseded build frees the slot', async () => {
    // free plan => concurrentBuilds = 1.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-cap',
      repoFullName: 'acme/cap',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-cap');

    const first = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '4001',
      githubRunAttempt: '1',
      installationId: 'inst-cap',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      throw new Error('unreachable');
    }

    // A newer run for the same project+branch supersedes the first (freeing the
    // single slot), so it is admitted rather than capped.
    const second = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '4002',
      githubRunAttempt: '1',
      installationId: 'inst-cap',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(second.outcome).toBe('created');
    if (second.outcome !== 'created') {
      throw new Error('unreachable');
    }
    expect((await getBuild(env.db, first.build.id))!.status).toBe('cancelled');

    // Only one active build remains; another project's NEW run for this owner is
    // now capped (the slot is held by the second build).
    const otherProject = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: otherProject.id,
      installationId: 'inst-cap-other',
      repoFullName: 'acme/cap-other',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-cap-other');
    const capped = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: otherProject.id,
      connectionId: (await getGitHubConnection(env.db, otherProject.id))!.id,
      // Simulate a stale pro-plan snapshot; the locked DB owner is free and
      // already occupies its single slot.
      branch: 'main',
      githubRunId: '4003',
      githubRunAttempt: '1',
      installationId: 'inst-cap-other',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(capped.outcome).toBe('limit-exceeded');
  });

  // A concurrent DELETE /projects/:id/github can remove the connection mid-OIDC
  // exchange. The tx locks + re-reads the github_actions connection row; if it is
  // gone the helper must reject (no build, no token) rather than orphan an active
  // build the workflow_run webhook can never finalize.
  it('returns connection-removed and inserts no build when no github_actions connection exists', async () => {
    const user = await createTestUser(env.db, 'gha-no-conn', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      // No connection is seeded, so any id is fine — the helper returns
      // `connection-removed` from the locked re-read before the id-match check.
      connectionId: 'ghc_absent',
      branch: 'main',
      githubRunId: '5001',
      githubRunAttempt: '1',
      installationId: 'none',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('connection-removed');

    // No build row was inserted for the project.
    const all = await getProjectBuilds(env.db, project.id);
    expect(all).toHaveLength(0);
  });

  // A `container` connection must NOT authorize the github_actions build path:
  // the OIDC exchange is github_actions-only, and the lock/re-read is scoped to
  // build_executor='github_actions'.
  it('returns connection-removed when the project connection is a container executor', async () => {
    const user = await createTestUser(env.db, 'gha-container-conn', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-container',
      repoFullName: 'acme/container',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'container',
    });
    await seedActiveInstall(env.db, 'inst-container');

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '5002',
      githubRunAttempt: '1',
      installationId: 'inst-container',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('connection-removed');

    const all = await getProjectBuilds(env.db, project.id);
    expect(all).toHaveLength(0);
  });

  // The branch is re-validated UNDER the FOR UPDATE row lock: a PATCH can
  // re-point the connection's branch after auth-oidc's pre-tx branch check but
  // before this lock, so the locked row is authoritative. A mismatch rejects
  // with `branch-mismatch` and inserts NO build.
  it('returns branch-mismatch and inserts no build when the locked connection branch differs', async () => {
    const user = await createTestUser(env.db, 'gha-branch-mismatch', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    // Connection is on `main` (schema default); the exchange requests `feature`.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-branch-mismatch',
      repoFullName: 'acme/branch-mismatch',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-branch-mismatch');

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'feature',
      githubRunId: '7001',
      githubRunAttempt: '1',
      installationId: 'inst-branch-mismatch',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('branch-mismatch');

    // No build row was inserted for the project.
    const all = await getProjectBuilds(env.db, project.id);
    expect(all).toHaveLength(0);
  });

  // Tolerant null-guard: a caller that passes NO branch (legacy/backward-compat)
  // skips the branch re-check entirely and still creates a build.
  it('creates a build when no branch is supplied (tolerant null-guard)', async () => {
    const user = await createTestUser(env.db, 'gha-no-branch', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-no-branch',
      repoFullName: 'acme/no-branch',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-no-branch');

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      githubRunId: '7002',
      githubRunAttempt: '1',
      installationId: 'inst-no-branch',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('created');

    const all = await getProjectBuilds(env.db, project.id);
    expect(all).toHaveLength(1);
  });

  // Rerun-correctness — a RERUN reuses the same run_id with an incremented
  // run_attempt. The idempotent reuse query matches on the ATTEMPT, so a new
  // attempt does NOT reuse the prior attempt's active build: it creates a
  // distinct row (the prior active row is superseded as a different attempt).
  it('does NOT reuse the prior attempt build for a new run_attempt (same run_id)', async () => {
    const user = await createTestUser(env.db, 'gha-rerun', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-rerun',
      repoFullName: 'acme/rerun',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-rerun');

    const attempt1 = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '6001',
      githubRunAttempt: '1',
      installationId: 'inst-rerun',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(attempt1.outcome).toBe('created');
    if (attempt1.outcome !== 'created') {
      throw new Error('unreachable');
    }
    expect(attempt1.build.github_run_attempt).toBe('1');

    // Same run_id, attempt 2 — must create a DISTINCT row, not reuse attempt 1.
    const attempt2 = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '6001',
      githubRunAttempt: '2',
      installationId: 'inst-rerun',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(attempt2.outcome).toBe('created');
    if (attempt2.outcome !== 'created') {
      throw new Error('unreachable');
    }
    expect(attempt2.build.id).not.toBe(attempt1.build.id);
    expect(attempt2.build.github_run_attempt).toBe('2');

    // A repeated exchange for attempt 2 reuses the attempt-2 row (idempotent).
    const repeat = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '6001',
      githubRunAttempt: '2',
      installationId: 'inst-rerun',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(repeat.outcome).toBe('reused');
    if (repeat.outcome !== 'reused') {
      throw new Error('unreachable');
    }
    expect(repeat.build.id).toBe(attempt2.build.id);
  });

  // a rerun reuses run_id with an incremented run_attempt. The supersede
  // UPDATE must cancel ALL other active github_actions builds on the same
  // project+branch, INCLUDING a still-ACTIVE older attempt of the SAME run_id
  // (whose completion webhook was missed). Otherwise attempt 1 stays ACTIVE,
  // counting against the limit and keeping its deploy token live until the reaper.
  it('supersedes a still-ACTIVE older attempt of the same run_id on rerun', async () => {
    const user = await createTestUser(env.db, 'gha-rerun-supersede', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-rerun-supersede',
      repoFullName: 'acme/rerun-supersede',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-rerun-supersede');

    const attempt1 = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '6101',
      githubRunAttempt: '1',
      installationId: 'inst-rerun-supersede',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(attempt1.outcome).toBe('created');
    if (attempt1.outcome !== 'created') {
      throw new Error('unreachable');
    }

    // Attempt 1's completion webhook was missed, so it is still ACTIVE when the
    // rerun (same run_id, attempt 2) arrives. Attempt 2 must supersede attempt 1.
    const attempt2 = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '6101',
      githubRunAttempt: '2',
      installationId: 'inst-rerun-supersede',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(attempt2.outcome).toBe('created');
    if (attempt2.outcome !== 'created') {
      throw new Error('unreachable');
    }
    expect(attempt2.build.status).toBe('building');

    // Attempt 1 (same run_id) is now cancelled/superseded — not left ACTIVE.
    const superseded = await getBuild(env.db, attempt1.build.id);
    expect(superseded!.status).toBe('cancelled');
    expect(superseded!.error).toBe('superseded by newer run');
    expect(superseded!.completed_at).not.toBeNull();
  });

  // The build-creation tx re-checks installation status + repo
  // membership under the connection lock. A revocation (App suspend/uninstall,
  // repo removal) that commits AFTER the OIDC resolver + live-install checks but
  // BEFORE this tx is caught here: no `building` row, no deploy token. Fails
  // closed.
  it('returns install-revoked when the installation is SUSPENDED', async () => {
    const user = await createTestUser(env.db, 'gha-revoked-susp', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-revoked-susp',
      repoFullName: 'acme/revoked',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-revoked-susp');
    await markGitHubInstallationStatus(env.db, 'inst-revoked-susp', 'suspended');

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '8001',
      githubRunAttempt: '1',
      installationId: 'inst-revoked-susp',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('install-revoked');
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });

  it('returns install-revoked when the installation is DELETED', async () => {
    const user = await createTestUser(env.db, 'gha-revoked-del', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-revoked-del',
      repoFullName: 'acme/revoked',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-revoked-del');
    await markGitHubInstallationStatus(env.db, 'inst-revoked-del', 'deleted');

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '8002',
      githubRunAttempt: '1',
      installationId: 'inst-revoked-del',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('install-revoked');
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });

  it('returns install-revoked when a SELECTED install no longer covers the repo', async () => {
    const user = await createTestUser(env.db, 'gha-revoked-sel', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-revoked-sel',
      repoFullName: 'acme/revoked',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    // A 'selected' install whose cached set does NOT include this repo's id (42).
    await seedActiveInstall(
      env.db,
      'inst-revoked-sel',
      [{ full_name: 'acme/other', id: 999 }],
      'selected',
    );

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '8003',
      githubRunAttempt: '1',
      installationId: 'inst-revoked-sel',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('install-revoked');
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });

  it('creates a build when a SELECTED install covers the repo', async () => {
    const user = await createTestUser(env.db, 'gha-revoked-ok', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-revoked-ok',
      repoFullName: 'acme/covered',
      repositoryId: DEFAULT_REPO_ID,
      buildExecutor: 'github_actions',
    });
    // A 'selected' install whose cached set INCLUDES this repo by id (42).
    await seedActiveInstall(
      env.db,
      'inst-revoked-ok',
      [{ full_name: 'acme/covered', id: 42 }],
      'selected',
    );

    const result = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: (await getGitHubConnection(env.db, project.id))!.id,
      branch: 'main',
      githubRunId: '8004',
      githubRunAttempt: '1',
      installationId: 'inst-revoked-ok',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(result.outcome).toBe('created');
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(1);
  });

  // The build-creation tx must assert the LOCKED connection is the SAME
  // row the caller resolved. `github_connections.project_id` is UNIQUE, so a
  // disconnect+reconnect to a DIFFERENT repo (same branch/executor, and crucially
  // the SAME installation_id + repository_id) DELETEs the old row and CREATEs a
  // new one with a fresh id between resolution and this tx. The install check
  // keys on the PASSED installationId, so this same-install swap PASSES it — the
  // id-match is the only guard that catches it. A stale resolved id =>
  // `connection-replaced`, no `building` row, no deploy token.
  it('returns connection-replaced when the connection was disconnected+reconnected', async () => {
    const user = await createTestUser(env.db, 'gha-replaced', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id);
    const cOld = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-replaced',
      repoFullName: 'acme/replaced',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedActiveInstall(env.db, 'inst-replaced');

    // Disconnect + reconnect to the SAME repo/branch/executor/install — proving the
    // install check does NOT catch this (identical installation_id +
    // repository_id) — only the row id changes.
    await deleteGitHubConnection(env.db, project.id);
    const cNew = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'inst-replaced',
      repoFullName: 'acme/replaced',
      repositoryId: DEFAULT_REPO_ID,
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    expect(cNew.id).not.toBe(cOld.id);

    // The caller resolved the OLD connection id; the locked row is now the NEW one.
    const replaced = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: cOld.id,
      branch: 'main',
      githubRunId: '9001',
      githubRunAttempt: '1',
      installationId: 'inst-replaced',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(replaced.outcome).toBe('connection-replaced');
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);

    // Matching-id happy case: resolving the CURRENT connection builds normally.
    const ok = await createGithubActionsBuildWithinLimit(env.db, {
      projectId: project.id,
      connectionId: cNew.id,
      branch: 'main',
      githubRunId: '9001',
      githubRunAttempt: '1',
      installationId: 'inst-replaced',
      repositoryId: DEFAULT_REPO_ID,
      expectedWorkflowPath: '.github/workflows/void-deploy.yml',
    });
    expect(ok.outcome).toBe('created');
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(1);
  });
});

describe('getBuildByProjectRunIdAndAttempt', () => {
  it('matches a build by run_id and run_attempt', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    // Attempt 1 (terminal) and attempt 2 (active) for the same run_id.
    const a1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'failed',
      githubRunId: '7001',
      githubRunAttempt: '1',
    });
    const a2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '7001',
      githubRunAttempt: '2',
    });

    // Exact attempt match.
    expect((await getBuildByProjectRunIdAndAttempt(env.db, project.id, '7001', '1'))!.id).toBe(
      a1.id,
    );
    expect((await getBuildByProjectRunIdAndAttempt(env.db, project.id, '7001', '2'))!.id).toBe(
      a2.id,
    );
    // A non-matching attempt resolves nothing.
    expect(await getBuildByProjectRunIdAndAttempt(env.db, project.id, '7001', '3')).toBeNull();
    // A different run_id resolves nothing.
    expect(await getBuildByProjectRunIdAndAttempt(env.db, project.id, '7002', '1')).toBeNull();
  });
});

describe('getDeploymentByProjectAndCommit', () => {
  it('returns null when no deployment matches and the newest row when it does', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    expect(await getDeploymentByProjectAndCommit(env.db, project.id, 'sha1')).toBeNull();

    // Seed a deployment, then stamp its commit (createTestDeployment doesn't set one).
    const older = await createTestDeployment(env.db, project.id);
    await env.db.update(deployments).set({ commit: 'sha1' }).where(eq(deployments.id, older.id));
    const newer = await createTestDeployment(env.db, project.id);
    await env.db.update(deployments).set({ commit: 'sha1' }).where(eq(deployments.id, newer.id));

    const found = await getDeploymentByProjectAndCommit(env.db, project.id, 'sha1');
    expect(found?.id).toBe(newer.id);

    // A different commit for the same project does not match.
    expect(await getDeploymentByProjectAndCommit(env.db, project.id, 'sha2')).toBeNull();
  });
});

describe('github_connections', () => {
  it('create/get round-trips with defaults', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);

    const conn = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    expect(conn.id.startsWith('ghc_')).toBe(true);
    expect(conn.branch).toBe('main');
    expect(conn.build_executor).toBe('container');

    const fetched = await getGitHubConnection(env.db, project.id);
    expect(fetched?.repo_full_name).toBe('acme/app');
  });

  it('getGitHubConnectionsByRepo joins the owning user_id (active install)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // The resolver INNER JOINs github_installations and requires status=active
    // + repo membership, so an active 'all'-repos install must exist.
    await upsertGitHubInstallation(env.db, {
      installationId: '12345',
      userId: null,
      accountLogin: 'acme',
      accountId: '111',
      accountType: 'Organization',
      repositories: [],
      repositorySelection: 'all',
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
      branch: 'release',
      buildExecutor: 'github_actions',
    });

    const rows = await getGitHubConnectionsByRepo(env.db, '12345', '42');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(user.id);
    expect(rows[0].project_id).toBe(project.id);
    expect(rows[0].branch).toBe('release');
    expect(rows[0].build_executor).toBe('github_actions');

    // Wrong repo / wrong installation -> empty.
    expect(await getGitHubConnectionsByRepo(env.db, '12345', '43')).toEqual([]);
    expect(await getGitHubConnectionsByRepo(env.db, '99999', '42')).toEqual([]);
  });

  // The push resolver is revocation-aware: a suspended/deleted install
  // resolves nothing, so a delayed/redelivered signed push after suspend/uninstall
  // can't mint a fresh deploy token within the installation-token cache window.
  it('getGitHubConnectionsByRepo rejects a suspended or deleted installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await upsertGitHubInstallation(env.db, {
      installationId: '12345',
      userId: null,
      accountLogin: 'acme',
      accountId: '111',
      accountType: 'Organization',
      repositories: [],
      repositorySelection: 'all',
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    expect(await getGitHubConnectionsByRepo(env.db, '12345', '42')).toHaveLength(1);

    await markGitHubInstallationStatus(env.db, '12345', 'suspended');
    expect(await getGitHubConnectionsByRepo(env.db, '12345', '42')).toEqual([]);

    await markGitHubInstallationStatus(env.db, '12345', 'deleted');
    expect(await getGitHubConnectionsByRepo(env.db, '12345', '42')).toEqual([]);
  });

  // A `selected` install enforces repo membership: a repo dropped from
  // the install (not in the cached set) resolves nothing.
  it('getGitHubConnectionsByRepo enforces selected-install membership', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    // 'selected' install whose cached set does NOT include this repo.
    await upsertGitHubInstallation(env.db, {
      installationId: '12345',
      userId: null,
      accountLogin: 'acme',
      accountId: '111',
      accountType: 'Organization',
      repositories: [{ id: 999, full_name: 'acme/other' }],
      repositorySelection: 'selected',
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    // Repo is not a member -> empty.
    expect(await getGitHubConnectionsByRepo(env.db, '12345', '42')).toEqual([]);

    // Add the repo to the cached set by id -> now a member -> resolves.
    await setGitHubInstallationRepositories(
      env.db,
      '12345',
      [
        { id: 999, full_name: 'acme/other' },
        { id: 42, full_name: 'acme/app' },
      ],
      'selected',
    );
    const byId = await getGitHubConnectionsByRepo(env.db, '12345', '42');
    expect(byId).toHaveLength(1);
    expect(byId[0].project_id).toBe(project.id);
  });

  it('updateGitHubConnection patches only provided fields', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    await updateGitHubConnection(env.db, project.id, { branch: 'develop' });
    let conn = await getGitHubConnection(env.db, project.id);
    expect(conn?.branch).toBe('develop');
    expect(conn?.build_executor).toBe('container');

    await updateGitHubConnection(env.db, project.id, { buildExecutor: 'github_actions' });
    conn = await getGitHubConnection(env.db, project.id);
    // branch unchanged by the executor-only update.
    expect(conn?.branch).toBe('develop');
    expect(conn?.build_executor).toBe('github_actions');
  });

  it('deleteGitHubConnection removes the row', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    await deleteGitHubConnection(env.db, project.id);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The build manager re-checks coverage from stored build state, which may lack
  // either id; both fail closed even on an `all`-repos install.
  it('installationCoversRepo fails closed without a connection id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await seedActiveInstall(env.db, '12345');
    const conn = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    expect(await installationCoversRepo(env.db, conn.id, project.id, '12345', '42')).toBe(true);
    expect(
      await installationCoversRepo(
        env.db,
        undefined as unknown as string,
        project.id,
        '12345',
        '42',
      ),
    ).toBe(false);
  });
});

describe('github_installations', () => {
  it('upsert refreshes metadata but PRESERVES membership on installation_id conflict', async () => {
    const user = await createTestUser(env.db);

    const inserted = await upsertGitHubInstallation(env.db, {
      installationId: '555',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    expect(inserted.id.startsWith('ghi_')).toBe(true);
    expect(inserted.status).toBe('active');
    expect(inserted.repositories).toEqual([{ full_name: 'acme/app', id: 1 }]);

    // Conflict upsert refreshes account metadata and preserves an existing
    // user_id link, but must NOT overwrite repo membership / selection. GitHub
    // never reuses installation_ids, so any `created` that conflicts is a stale
    // redelivery whose payload membership is never newer than what we hold; the
    // `installation_repositories` handler is the authoritative membership writer.
    // A conflict-path overwrite here would let a redelivered original `created`
    // roll a cache the handler already advanced (e.g. [A,B] back to [A]).
    const updated = await upsertGitHubInstallation(env.db, {
      installationId: '555',
      accountLogin: 'acme-renamed',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [
        { full_name: 'acme/app', id: 1 },
        { full_name: 'acme/web', id: 2 },
      ],
    });
    expect(updated.id).toBe(inserted.id);
    expect(updated.user_id).toBe(user.id);
    expect(updated.account_login).toBe('acme-renamed');
    // Membership preserved (NOT rolled forward to the conflicting payload's 2).
    expect(updated.repositories).toEqual([{ full_name: 'acme/app', id: 1 }]);
  });

  // The OAuth callback caller (refreshMembership: true) just refetched the LIVE
  // membership, so on an existing-row conflict (reconnect / setup_action=update)
  // it MUST roll the cache forward — both the repo list AND the selection.
  it('upsert rolls membership forward on conflict when refreshMembership is true', async () => {
    const user = await createTestUser(env.db);

    const inserted = await upsertGitHubInstallation(env.db, {
      installationId: '559',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
      repositorySelection: 'selected',
    });
    expect(inserted.repository_selection).toBe('selected');
    expect(inserted.repositories).toEqual([{ full_name: 'acme/app', id: 1 }]);

    // Authoritative callback re-upsert: widen to `all` and add a repo.
    const refreshed = await upsertGitHubInstallation(env.db, {
      installationId: '559',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [
        { full_name: 'acme/app', id: 1 },
        { full_name: 'acme/api', id: 2 },
      ],
      repositorySelection: 'all',
      refreshMembership: true,
    });
    expect(refreshed.id).toBe(inserted.id);
    expect(refreshed.repository_selection).toBe('all');
    expect(refreshed.repositories).toEqual([
      { full_name: 'acme/app', id: 1 },
      { full_name: 'acme/api', id: 2 },
    ]);

    // NULL-safe branch: refreshMembership with the selection OMITTED must roll the
    // repo list forward but leave the existing selection ('all') untouched.
    const refreshedNoSelection = await upsertGitHubInstallation(env.db, {
      installationId: '559',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
      refreshMembership: true,
    });
    expect(refreshedNoSelection.repository_selection).toBe('all');
    expect(refreshedNoSelection.repositories).toEqual([{ full_name: 'acme/app', id: 1 }]);
  });

  // the conflict handler must never re-own a personal installation already
  // linked to a DIFFERENT user (two install callbacks racing), but must still
  // adopt the user on an unowned (NULL) row.
  it('upsert never re-owns an installation linked to another user', async () => {
    const userA = await createTestUser(env.db);
    const userB = await createTestUser(env.db, 'user-b');

    await upsertGitHubInstallation(env.db, {
      installationId: '557',
      userId: userA.id,
      accountLogin: 'acme',
      accountId: 'acc_x',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    // A second concurrent callback tries to adopt the SAME row for userB.
    const reOwned = await upsertGitHubInstallation(env.db, {
      installationId: '557',
      userId: userB.id,
      accountLogin: 'acme',
      accountId: 'acc_x',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    // Ownership stays with the original user; the second caller does not re-own.
    expect(reOwned.user_id).toBe(userA.id);
  });

  it('upsert adopts the user on an unowned (NULL) installation row', async () => {
    const userB = await createTestUser(env.db, 'user-b');

    // Install-before-signin: the row starts unowned.
    await upsertGitHubInstallation(env.db, {
      installationId: '558',
      accountLogin: 'acme',
      accountId: 'acc_y',
      accountType: 'User',
      repositories: [],
    });

    const adopted = await upsertGitHubInstallation(env.db, {
      installationId: '558',
      userId: userB.id,
      accountLogin: 'acme',
      accountId: 'acc_y',
      accountType: 'User',
      repositories: [],
    });
    expect(adopted.user_id).toBe(userB.id);
  });

  // GitHub can convert a personal account into an organization; later payloads
  // report the same installation with the organization type.
  it('upsert drops the owner when a personal installation becomes an organization', async () => {
    const owner = await createTestUser(env.db, 'converted');
    await upsertGitHubInstallation(env.db, {
      installationId: '559',
      userId: owner.id,
      accountLogin: 'acme',
      accountId: 'acc_z',
      accountType: 'User',
      repositories: [],
    });

    const converted = await upsertGitHubInstallation(env.db, {
      installationId: '559',
      userId: null,
      accountLogin: 'acme',
      accountId: 'acc_z',
      accountType: 'Organization',
      repositories: [],
    });
    expect(converted.account_type).toBe('Organization');
    expect(converted.user_id).toBeNull();
  });

  it('getGitHubInstallation + getGitHubInstallationsByUser read by key/user', async () => {
    const user = await createTestUser(env.db);
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [],
    });

    const byId = await getGitHubInstallation(env.db, '555');
    expect(byId?.account_login).toBe('acme');

    const byUser = await getGitHubInstallationsByUser(env.db, user.id);
    expect(byUser).toHaveLength(1);
    expect(byUser[0]!.installation_id).toBe('555');
  });

  it('setGitHubInstallationRepositories replaces the repo list', async () => {
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    await setGitHubInstallationRepositories(env.db, '555', [{ full_name: 'acme/web', id: 2 }]);
    const updated = await getGitHubInstallation(env.db, '555');
    expect(updated?.repositories).toEqual([{ full_name: 'acme/web', id: 2 }]);
  });

  it('markGitHubInstallationStatus transitions status', async () => {
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'Organization',
      repositories: [],
    });

    await markGitHubInstallationStatus(env.db, '555', 'suspended');
    expect((await getGitHubInstallation(env.db, '555'))?.status).toBe('suspended');

    await markGitHubInstallationStatus(env.db, '555', 'deleted');
    expect((await getGitHubInstallation(env.db, '555'))?.status).toBe('deleted');
  });

  it('linkGitHubInstallationToUser backfills only NULL user_id by account_id', async () => {
    const user = await createTestUser(env.db);
    const otherUser = await createTestUser(env.db, 'other');

    // Unlinked install for acc_1 (install-before-signin).
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [],
    });
    // Already-linked install for the SAME account — must not be clobbered.
    await upsertGitHubInstallation(env.db, {
      installationId: '556',
      userId: otherUser.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [],
    });

    await linkGitHubInstallationToUser(env.db, 'acc_1', user.id);

    const unlinked = await getGitHubInstallation(env.db, '555');
    const alreadyLinked = await getGitHubInstallation(env.db, '556');
    expect(unlinked?.user_id).toBe(user.id);
    // The already-linked installation keeps its original owner.
    expect(alreadyLinked?.user_id).toBe(otherUser.id);
  });

  it('github_connections cascade-deletes with the project', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '12345',
      repoFullName: 'acme/app',
      repositoryId: '42',
    });

    // Delete the project row directly; the FK ON DELETE cascade should remove
    // the connection (mirrors project_secrets behaviour).
    await env.db.delete(projects).where(eq(projects.id, project.id));
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });
});
