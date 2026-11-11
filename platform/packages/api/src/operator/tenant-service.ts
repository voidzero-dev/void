import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import type { Context } from 'hono';
import { readProjectAiLogging } from '../ai-logging.ts';
import {
  type Db,
  ACTIVE_BUILD_STATUSES,
  countUserDeploymentsToday,
  deleteUser,
  getDomainsByProjectId,
  getProject,
  getProjectBuilds,
  getProjectDeployments,
  getProjectResources,
  getOwnedProjectsByUserId,
  getOpenProjectOwnershipPeriodsByProjectIds,
  getUser,
  TERMINAL_DEPLOYMENT_STATUSES,
  LastAdminError,
  prepareUserRemoval,
  suspendUser,
  unsuspendUser,
  updateUserPlan,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import { generateId } from '../id.ts';
import { requireAssignablePlan, resolvePlanLimits } from '../plans.ts';
import { teardownProject } from '../provisioning/cleanup.ts';
import {
  getAccountUsageProjectWindows,
  getRequestsDataset,
  queryBatchProjectUsageWindows,
  ZERO_USAGE,
} from '../routes/usage.ts';
import {
  computeDispatchLimits,
  sandboxBlockKey,
  setProjectsRoutingSuspension,
} from '../routing.ts';
import {
  builds,
  deployments,
  githubConnections,
  projectDeployCredentials,
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  projects,
  users,
} from '../schema.ts';
import { isAdminSuspended, projectSuspensionKey, routingSuspensionReason } from '../suspension.ts';
import { getCurrentBillingPeriodStart } from '../tiers.ts';
import type { DeployManifest, Project, User } from '../types.ts';
import {
  resolveProjectZeroTrustRoutingForPublication,
  rewriteProjectRouteMetadata,
} from '../zero-trust/routing.ts';
import { OperatorError, preview } from './common.ts';

type Page = { page: number; limit: number; offset: number };

const USAGE_CONSUMER_ROLLOUT_GRACE_MS = 15 * 60_000;

function assertOwnershipTransferRolloutComplete(env: ApiEnv['Bindings']): void {
  if (env.PLATFORM_ENV !== 'production' && env.PLATFORM_ENV !== 'staging') {
    return;
  }
  const deployedAt = Date.parse(env.VERSION_METADATA?.timestamp ?? '');
  const remainingMs = deployedAt + USAGE_CONSUMER_ROLLOUT_GRACE_MS - Date.now();
  if (!Number.isFinite(deployedAt) || remainingMs > 0) {
    throw new OperatorError(
      503,
      'Project ownership transfers are temporarily unavailable while the usage consumer rollout completes.',
      'ownership_transfer_rollout_pending',
      remainingMs > 0 ? { retryAfterSeconds: Math.ceil(remainingMs / 1_000) } : undefined,
    );
  }
}

function pageInfo(page: Page, total: number) {
  return {
    page: page.page,
    limit: page.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / page.limit)),
  };
}

export async function listOperatorUsers(db: Db, page: Page, search?: string) {
  const pattern = `%${search}%`;
  const where = search
    ? or(ilike(users.login, pattern), ilike(users.email, pattern), ilike(users.id, pattern))
    : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.created_at), desc(users.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ count: count() }).from(users).where(where),
  ]);
  return { users: rows, ...pageInfo(page, total.count) };
}

export async function listOperatorProjects(db: Db, page: Page, search?: string, user?: string) {
  const pattern = `%${search}%`;
  const where = and(
    user ? eq(projects.user_id, user) : undefined,
    search
      ? or(ilike(projects.slug, pattern), ilike(users.login, pattern), ilike(projects.id, pattern))
      : undefined,
  );
  const lastDeploy = db
    .selectDistinctOn([deployments.project_id], {
      project_id: deployments.project_id,
      last_deploy: deployments.created_at,
      last_deploy_id: deployments.id,
      last_deploy_status: deployments.status,
    })
    .from(deployments)
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id))
    .as('operator_last_deploy');
  const [rows, [total]] = await Promise.all([
    db
      .select({
        ...getTableColumns(projects),
        owner_login: users.login,
        last_deploy: lastDeploy.last_deploy,
        last_deploy_id: lastDeploy.last_deploy_id,
        last_deploy_status: lastDeploy.last_deploy_status,
      })
      .from(projects)
      .leftJoin(users, eq(projects.user_id, users.id))
      .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id))
      .where(where)
      .orderBy(desc(projects.created_at), desc(projects.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ count: count() })
      .from(projects)
      .leftJoin(users, eq(projects.user_id, users.id))
      .where(where),
  ]);
  return { projects: rows, ...pageInfo(page, total.count) };
}

async function requireUser(db: Db, id: string) {
  const user = await getUser(db, id);
  if (!user) {
    throw new OperatorError(404, 'User not found');
  }
  return user;
}

async function prepareRemoval(
  db: Db,
  id: string,
  action: Parameters<typeof prepareUserRemoval>[2],
  dryRun: boolean,
) {
  try {
    const user = await prepareUserRemoval(db, id, action, dryRun);
    if (!user) {
      throw new OperatorError(404, 'User not found');
    }
    return user;
  } catch (error) {
    if (error instanceof LastAdminError) {
      throw new OperatorError(409, error.message, 'last_admin');
    }
    throw error;
  }
}

async function requireProject(db: Db, id: string) {
  const project = await getProject(db, id);
  if (!project) {
    throw new OperatorError(404, 'Project not found');
  }
  return project;
}

export async function getOperatorUser(context: Context<ApiEnv>, id: string) {
  const user = await requireUser(context.get('db'), id);
  const [projects, deploysToday] = await Promise.all([
    getOwnedProjectsByUserId(context.get('db'), id),
    countUserDeploymentsToday(context.get('db'), id),
  ]);
  const since = user.billing_cycle_start
    ? getCurrentBillingPeriodStart(user.billing_cycle_start)
    : new Date();
  const usageWindows = await getAccountUsageProjectWindows(
    context.get('db'),
    id,
    since,
    new Date(),
  );
  const usageMap = await queryBatchProjectUsageWindows(
    context.env.CF_ACCOUNT_ID,
    context.env.CF_API_TOKEN,
    getRequestsDataset(context.env),
    usageWindows,
  );
  const projectUsages = usageWindows.map(({ project }) => ({
    projectId: project.id,
    slug: project.slug,
    ...(usageMap.get(project.id) ?? ZERO_USAGE),
  }));
  return {
    user,
    projects,
    deploysToday,
    usage: {
      billingPeriodStart: since.toISOString(),
      totalRequests: projectUsages.reduce((sum, p) => sum + p.requests, 0),
      totalBandwidth: projectUsages.reduce((sum, p) => sum + p.bandwidthBytes, 0),
      projects: projectUsages,
    },
  };
}

export async function getOperatorProject(db: Db, id: string) {
  const project = await requireProject(db, id);
  const [deployments, resources, owner, domains, builds] = await Promise.all([
    getProjectDeployments(db, id, 10),
    getProjectResources(db, id),
    getUser(db, project.user_id),
    getDomainsByProjectId(db, id),
    getProjectBuilds(db, id),
  ]);
  const aiLogging = await readProjectAiLogging(db, id);
  return { project, deployments, resources, owner, domains, builds, aiLogging };
}

type OwnershipTransferBlocker = Readonly<{
  kind: 'deletion' | 'deployment' | 'rollback' | 'build' | 'sandbox_controller';
  id: string;
  status: string;
}>;

function accountSummary(user: User) {
  return {
    id: user.id,
    login: user.login,
    email: user.email,
    plan: user.plan,
    suspended: user.suspended_reason !== null,
    suspendedReason: user.suspended_reason,
  };
}

function historicalAccountSummary(user: User | null, userId: string) {
  return user ? accountSummary(user) : { id: userId, deleted: true as const };
}

async function getOwnershipTransferBlockers(
  db: Db,
  projectId: string,
): Promise<Array<OwnershipTransferBlocker>> {
  const [activeDeployments, activeBuilds, sandboxControllers] = await Promise.all([
    db
      .select({ id: deployments.id, status: deployments.status, source: deployments.source })
      .from(deployments)
      .where(
        and(
          eq(deployments.project_id, projectId),
          notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        ),
      )
      .orderBy(asc(deployments.created_at), asc(deployments.id)),
    db
      .select({ id: builds.id, status: builds.status })
      .from(builds)
      .where(
        and(
          eq(builds.project_id, projectId),
          inArray(builds.status, ['queued', ...ACTIVE_BUILD_STATUSES]),
        ),
      )
      .orderBy(asc(builds.created_at), asc(builds.id)),
    // Live/failed/canceled deployments no longer block as active work, but
    // their owner-bound Sandbox controllers still do until cleanup completes.
    db
      .select({ id: deployments.id, status: deployments.status })
      .from(deployments)
      .where(
        and(
          eq(deployments.project_id, projectId),
          inArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
          sql`${deployments.manifest}::jsonb #>> '{sandbox,runtime,protocol}' IN ('1', '2')`,
          sql`COALESCE(${deployments.manifest}::jsonb #>> '{sandbox,runtime,cleanupComplete}', 'false') <> 'true'`,
        ),
      )
      .orderBy(asc(deployments.created_at), asc(deployments.id)),
  ]);
  return [
    ...activeDeployments.map((deployment) => ({
      kind:
        deployment.source === 'rollback-lease' ? ('rollback' as const) : ('deployment' as const),
      id: deployment.id,
      status: deployment.status,
    })),
    ...activeBuilds.map((build) => ({
      kind: 'build' as const,
      id: build.id,
      status: build.status,
    })),
    ...sandboxControllers.map((deployment) => ({
      kind: 'sandbox_controller' as const,
      id: deployment.id,
      status: deployment.status,
    })),
  ];
}

async function inspectOwnershipTransfer(db: Db, projectId: string, targetUserId: string) {
  const project = await requireProject(db, projectId);
  const [currentOwner, newOwner, activeWork, targetMembership, github, domains] = await Promise.all(
    [
      requireUser(db, project.user_id),
      requireUser(db, targetUserId),
      getOwnershipTransferBlockers(db, projectId),
      db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, targetUserId)),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({
          installationId: githubConnections.installation_id,
          repository: githubConnections.repo_full_name,
          authorizedByUserId: githubConnections.authorized_by_user_id,
          executor: githubConnections.build_executor,
        })
        .from(githubConnections)
        .where(eq(githubConnections.project_id, projectId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      getDomainsByProjectId(db, projectId),
    ],
  );
  const blockers: Array<OwnershipTransferBlocker> = [
    ...(project.status === 'deleting'
      ? [{ kind: 'deletion' as const, id: project.id, status: project.status }]
      : []),
    ...activeWork,
  ];
  const previousTransfer =
    currentOwner.id === newOwner.id ? await getPreviousOwnershipTransfer(db, projectId) : null;
  return {
    project,
    currentOwner,
    previousOwner: previousTransfer ? previousTransfer.owner : currentOwner,
    previousOwnerId: previousTransfer?.ownerId ?? currentOwner.id,
    newOwner,
    blockers,
    targetMembership,
    github,
    domains,
  };
}

async function getPreviousOwnershipTransfer(
  db: Db,
  projectId: string,
): Promise<{ owner: User | null; ownerId: string; startsAt: string } | null> {
  const [period] = await db
    .select()
    .from(projectOwnershipPeriods)
    .where(
      and(
        eq(projectOwnershipPeriods.project_id, projectId),
        isNotNull(projectOwnershipPeriods.ends_at),
      ),
    )
    .orderBy(desc(projectOwnershipPeriods.ends_at))
    .limit(1);
  if (!period) {
    return null;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, period.owner_user_id)).limit(1);
  return { owner: owner ?? null, ownerId: period.owner_user_id, startsAt: period.starts_at };
}

type OwnershipTransferCommit = Readonly<{
  project: Project;
  previousOwner: User | null;
  previousOwnerId: string;
  previousOwnerBillingCycleStart: string | null;
  newOwner: User;
  previousOwnershipStartedAt: string;
  transferredAt: string;
  changed: boolean;
}>;

async function commitOwnershipTransfer(
  db: Db,
  projectId: string,
  targetUserId: string,
  operatorUserId: string,
): Promise<OwnershipTransferCommit> {
  return db.transaction(async (tx) => {
    const [lockedProject] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    if (!lockedProject) {
      throw new OperatorError(404, 'Project not found');
    }

    const lockedUsers = await tx
      .select()
      .from(users)
      .where(inArray(users.id, [...new Set([lockedProject.user_id, targetUserId])].sort()))
      .orderBy(asc(users.id))
      .for('update');
    const byId = new Map(lockedUsers.map((user) => [user.id, user]));
    const currentOwner = byId.get(lockedProject.user_id);
    const newOwner = byId.get(targetUserId);
    if (!currentOwner) {
      throw new OperatorError(409, 'The current project owner no longer exists.', 'owner_missing');
    }
    if (!newOwner) {
      throw new OperatorError(404, 'User not found');
    }
    if (lockedProject.status === 'deleting') {
      throw new OperatorError(
        409,
        'Project ownership cannot change while deletion is active.',
        'ownership_transfer_blocked',
        { blockers: [{ kind: 'deletion', id: projectId, status: lockedProject.status }] },
      );
    }
    const [openPeriod] = await tx
      .select()
      .from(projectOwnershipPeriods)
      .where(
        and(
          eq(projectOwnershipPeriods.project_id, projectId),
          isNull(projectOwnershipPeriods.ends_at),
        ),
      )
      .for('update')
      .limit(1);

    // Ownership is implicit. Keep these convergence writes before the
    // idempotent branch so a retry also removes target access left behind by
    // an owner change that committed without cleaning it.
    await tx
      .delete(projectMembers)
      .where(
        and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, newOwner.id)),
      );
    await tx
      .update(projectInvitations)
      .set({
        status: 'revoked',
        revoked_at: sql`now()`,
        revoked_by_user_id: operatorUserId,
      })
      .where(
        and(
          eq(projectInvitations.project_id, projectId),
          eq(projectInvitations.target_user_id, newOwner.id),
          eq(projectInvitations.status, 'pending'),
        ),
      );

    if (lockedProject.user_id === targetUserId) {
      const previousTransfer = await getPreviousOwnershipTransfer(tx, projectId);
      return {
        project: lockedProject,
        previousOwner: previousTransfer ? previousTransfer.owner : newOwner,
        previousOwnerId: previousTransfer?.ownerId ?? newOwner.id,
        previousOwnerBillingCycleStart: previousTransfer
          ? (previousTransfer.owner?.billing_cycle_start ?? null)
          : newOwner.billing_cycle_start,
        newOwner,
        previousOwnershipStartedAt: previousTransfer?.startsAt ?? lockedProject.created_at,
        transferredAt: openPeriod?.starts_at ?? lockedProject.created_at,
        changed: false,
      };
    }

    const blockers = await getOwnershipTransferBlockers(tx, projectId);
    if (blockers.length > 0) {
      throw new OperatorError(
        409,
        'Project ownership cannot change while project work or a managed Sandbox controller remains.',
        'ownership_transfer_blocked',
        { blockers },
      );
    }

    if (openPeriod && openPeriod.owner_user_id !== lockedProject.user_id) {
      throw new OperatorError(
        409,
        'Project ownership history does not match the current owner.',
        'ownership_state_conflict',
      );
    }
    const [clock] = await tx
      .select({
        transferredAt: sql<string>`to_char(date_trunc('milliseconds', clock_timestamp()), 'YYYY-MM-DD HH24:MI:SS.MS')`,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const transferBoundary = clock!.transferredAt;
    if (openPeriod) {
      await tx
        .update(projectOwnershipPeriods)
        .set({ ends_at: transferBoundary })
        .where(eq(projectOwnershipPeriods.id, openPeriod.id));
    } else {
      await tx.insert(projectOwnershipPeriods).values({
        id: generateId('pown'),
        project_id: projectId,
        owner_user_id: currentOwner.id,
        starts_at: lockedProject.created_at,
        ends_at: transferBoundary,
      });
    }
    const [newPeriod] = await tx
      .insert(projectOwnershipPeriods)
      .values({
        id: generateId('pown'),
        project_id: projectId,
        owner_user_id: newOwner.id,
        starts_at: transferBoundary,
        changed_by_user_id: operatorUserId,
      })
      .returning({ startsAt: projectOwnershipPeriods.starts_at });
    const transferredAt = newPeriod!.startsAt;
    await tx
      .update(projectDeployCredentials)
      .set({ revoked_at: transferBoundary })
      .where(
        and(
          eq(projectDeployCredentials.project_id, projectId),
          isNull(projectDeployCredentials.revoked_at),
        ),
      );
    const [updatedProject] = await tx
      .update(projects)
      .set({ user_id: newOwner.id })
      .where(eq(projects.id, projectId))
      .returning();
    await tx
      .insert(projectMembers)
      .values({
        project_id: projectId,
        user_id: currentOwner.id,
        role: 'admin',
        added_by_user_id: operatorUserId,
      })
      .onConflictDoUpdate({
        target: [projectMembers.project_id, projectMembers.user_id],
        set: { role: 'admin', updated_at: sql`now()` },
      });
    return {
      project: updatedProject!,
      previousOwner: currentOwner,
      previousOwnerId: currentOwner.id,
      previousOwnerBillingCycleStart: currentOwner.billing_cycle_start,
      newOwner,
      previousOwnershipStartedAt: openPeriod?.starts_at ?? lockedProject.created_at,
      transferredAt,
      changed: true,
    };
  });
}

async function updateOwnershipCounters(
  context: Context<ApiEnv>,
  transfer: OwnershipTransferCommit,
): Promise<void> {
  const request = async (userId: string, path: string, body: Record<string, unknown>) => {
    const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(userId));
    const response = await stub.fetch(
      new Request(`https://do${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) {
      throw new Error(`UsageCounter ${path} returned HTTP ${response.status}`);
    }
  };
  if (transfer.previousOwnerId !== transfer.newOwner.id) {
    await request(transfer.previousOwnerId, '/detach-project', {
      projectId: transfer.project.id,
      userId: transfer.previousOwnerId,
      ...(transfer.previousOwnerBillingCycleStart
        ? {
            billingPeriodStart: getCurrentBillingPeriodStart(
              transfer.previousOwnerBillingCycleStart,
            ).toISOString(),
          }
        : {}),
      ownershipStartedAt: transfer.previousOwnershipStartedAt,
      ownershipEndedAt: transfer.transferredAt,
    });
  }
  await request(transfer.newOwner.id, '/attach-project', {
    projectId: transfer.project.id,
    userId: transfer.newOwner.id,
    slug: transfer.project.slug,
    billingPeriodStart: getCurrentBillingPeriodStart(
      transfer.newOwner.billing_cycle_start,
    ).toISOString(),
    ownershipStartedAt: transfer.transferredAt,
  });
}

async function republishProjectOwnerState(
  context: Context<ApiEnv>,
  projectId: string,
  expectedOwnerUserId: string,
): Promise<User | null> {
  const db = context.get('db');
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    if (!project || project.user_id !== expectedOwnerUserId || project.status === 'deleting') {
      return null;
    }
    const [owner, activeDeployment, domains] = await Promise.all([
      requireUser(tx, project.user_id),
      project.active_deployment_id
        ? tx
            .select({ manifest: deployments.manifest })
            .from(deployments)
            .where(eq(deployments.id, project.active_deployment_id))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null,
      getDomainsByProjectId(tx, project.id),
    ]);
    let manifest: DeployManifest | null = null;
    if (activeDeployment?.manifest) {
      manifest = JSON.parse(activeDeployment.manifest) as DeployManifest;
    }
    const dispatchLimits = computeDispatchLimits(
      await resolvePlanLimits(tx, owner.plan),
      manifest?.limits,
    );
    const protection = await resolveProjectZeroTrustRoutingForPublication(tx, project.id);
    for (const key of [project.slug, ...domains.map((domain) => `domain:${domain.hostname}`)]) {
      const raw = await context.env.ROUTING.get(key);
      if (!raw) {
        continue;
      }
      await context.env.ROUTING.put(
        key,
        rewriteProjectRouteMetadata(JSON.parse(raw) as Record<string, unknown>, {
          projectId: project.id,
          userId: owner.id,
          limits: dispatchLimits,
          suspended: routingSuspensionReason(owner.suspended_reason),
          zeroTrust: protection,
        }),
      );
    }
    // Background runs (cron, queues) pause only for an administrator suspension;
    // usage-limit suspensions keep them running.
    const markerKey = projectSuspensionKey(project.id);
    const marker = await context.env.ROUTING.get(markerKey);
    const reason = owner.suspended_reason;
    if (reason !== null && isAdminSuspended(reason)) {
      if (marker !== reason) {
        await context.env.ROUTING.put(markerKey, reason);
      }
    } else if (marker !== null) {
      await context.env.ROUTING.delete(markerKey);
    }
    return owner;
  });
}

async function republishTransferredProject(
  context: Context<ApiEnv>,
  transfer: OwnershipTransferCommit,
): Promise<User> {
  const owner = await republishProjectOwnerState(
    context,
    transfer.project.id,
    transfer.newOwner.id,
  );
  if (!owner) {
    throw new Error('Project ownership changed again before routing convergence.');
  }
  return owner;
}

async function reconcileOperatorUserProjects(
  context: Context<ApiEnv>,
  userId: string,
): Promise<void> {
  const projects = await getOwnedProjectsByUserId(context.get('db'), userId);
  for (const project of projects) {
    await republishProjectOwnerState(context, project.id, userId);
  }
}

export async function previewOperatorProjectOwner(
  context: Context<ApiEnv>,
  projectId: string,
  targetUserId: string,
) {
  const inspection = await inspectOwnershipTransfer(context.get('db'), projectId, targetUserId);
  return preview(
    'project.owner',
    { id: inspection.project.id, slug: inspection.project.slug, userId: targetUserId },
    {
      currentOwner: accountSummary(inspection.currentOwner),
      previousOwner: historicalAccountSummary(inspection.previousOwner, inspection.previousOwnerId),
      newOwner: accountSummary(inspection.newOwner),
      changed: inspection.currentOwner.id !== inspection.newOwner.id,
      formerOwnerRole: inspection.previousOwnerId === inspection.newOwner.id ? null : 'admin',
      targetPreviousRole: inspection.targetMembership?.role ?? null,
      blockers: inspection.blockers,
      github: inspection.github,
      routingUpdates: [
        inspection.project.slug,
        ...inspection.domains.map((domain) => `domain:${domain.hostname}`),
      ],
      counterUpdates: {
        detachUserId:
          inspection.previousOwnerId === inspection.newOwner.id ? null : inspection.previousOwnerId,
        attachUserId: inspection.newOwner.id,
      },
      usageTransfer: 'non-retroactive',
    },
  );
}

export async function transferOperatorProjectOwner(
  context: Context<ApiEnv>,
  projectId: string,
  targetUserId: string,
  dryRun = false,
) {
  if (dryRun) {
    return previewOperatorProjectOwner(context, projectId, targetUserId);
  }
  assertOwnershipTransferRolloutComplete(context.env);

  const db = context.get('db');
  const transfer = await commitOwnershipTransfer(
    db,
    projectId,
    targetUserId,
    context.get('user').id,
  );
  const convergence = { countersComplete: false, routingComplete: false };
  let convergedOwner = transfer.newOwner;
  // Publish immediately even if counter reconciliation fails, then repeat after
  // it settles so a concurrent plan or suspension change wins in the final state.
  const [counterResult, earlyRoutingResult] = await Promise.allSettled([
    updateOwnershipCounters(context, transfer),
    republishTransferredProject(context, transfer),
  ]);
  if (counterResult.status === 'fulfilled') {
    convergence.countersComplete = true;
  }
  if (earlyRoutingResult.status === 'fulfilled') {
    convergedOwner = earlyRoutingResult.value;
  }
  const [finalRoutingResult] = await Promise.allSettled([
    republishTransferredProject(context, transfer),
  ] as const);
  if (finalRoutingResult.status === 'fulfilled') {
    convergedOwner = finalRoutingResult.value;
    convergence.routingComplete = true;
  }
  if (counterResult.status === 'rejected' || finalRoutingResult.status === 'rejected') {
    console.error('[admin] project owner convergence failed', {
      projectId,
      targetUserId,
      counterError: counterResult.status === 'rejected' ? counterResult.reason : undefined,
      routingError:
        finalRoutingResult.status === 'rejected' ? finalRoutingResult.reason : undefined,
    });
    throw new OperatorError(
      500,
      'Project ownership changed, but external accounting or routing convergence is incomplete. Inspect the project and retry this ownership transfer.',
      'partial_failure',
      {
        partial: true,
        target: { id: transfer.project.id, slug: transfer.project.slug, userId: targetUserId },
        ownershipTransferred: true,
        transferredAt: transfer.transferredAt,
        previousOwner: historicalAccountSummary(transfer.previousOwner, transfer.previousOwnerId),
        newOwner: accountSummary(convergedOwner),
        convergence,
      },
    );
  }
  return {
    action: 'project.owner',
    target: { id: transfer.project.id, slug: transfer.project.slug, userId: targetUserId },
    previousOwner: historicalAccountSummary(transfer.previousOwner, transfer.previousOwnerId),
    newOwner: accountSummary(convergedOwner),
    transferredAt: transfer.transferredAt,
    formerOwnerRole: transfer.previousOwnerId === transfer.newOwner.id ? null : 'admin',
    changed: transfer.changed,
    convergence,
  };
}

export async function changeOperatorUserPlan(
  context: Context<ApiEnv>,
  id: string,
  plan: string,
  dryRun = false,
) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  await requireAssignablePlan(db, plan);
  const target = { id, login: user.login };
  if (dryRun) {
    const projects = await getOwnedProjectsByUserId(db, id);
    return preview('user.plan', target, {
      previousPlan: user.plan,
      plan,
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
    });
  }
  await updateUserPlan(db, id, plan);
  try {
    await reconcileOperatorUserPlan(context, id);
  } catch (error) {
    console.error('[admin] plan-change cleanup failed', { userId: id, error });
    throw new OperatorError(
      500,
      'Plan changed, cleanup incomplete. The user may still be blocked. Retry the plan change; cleanup is idempotent.',
      'partial_failure',
      { partial: true, target, plan, cleanupComplete: false },
    );
  }
  return { action: 'user.plan', target, plan, cleanupComplete: true };
}

/** Refresh policy without resetting usage or lifting an administrator suspension. */
export async function reconcileOperatorUserPlan(context: Context<ApiEnv>, id: string) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  const owned = await getOwnedProjectsByUserId(db, id);
  const periods = await getOpenProjectOwnershipPeriodsByProjectIds(
    db,
    owned.map((project) => project.id),
  );
  const ownershipStarts = new Map(periods.map((period) => [period.project_id, period.starts_at]));
  const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(id));
  const initialized = await stub.fetch(
    new Request('https://do/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: id,
        plan: user.plan,
        billingPeriodStart: getCurrentBillingPeriodStart(
          user.billing_cycle_start ?? user.created_at,
        ).toISOString(),
        projectSlugs: Object.fromEntries(owned.map((project) => [project.id, project.slug])),
        projectOwnershipStarts: Object.fromEntries(
          owned.map((project) => [
            project.id,
            ownershipStarts.get(project.id) ?? project.created_at,
          ]),
        ),
      }),
    }),
  );
  if (!initialized.ok) {
    throw new Error(`Usage counter initialization returned HTTP ${initialized.status}`);
  }
  const reevaluated = await stub.fetch(
    new Request('https://do/reevaluate-limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: id }),
    }),
  );
  if (!reevaluated.ok) {
    throw new Error(`Usage counter limit reevaluation returned HTTP ${reevaluated.status}`);
  }
  // Ownership and quota writes can settle while a transfer is publishing. Each
  // project is reread under its row fence before its final route publication.
  await reconcileOperatorUserProjects(context, id);
}

export async function suspendOperatorUser(
  context: Context<ApiEnv>,
  id: string,
  reason = 'admin_suspended',
  dryRun = false,
) {
  const db = context.get('db');
  if (!isAdminSuspended(reason)) {
    throw new OperatorError(
      400,
      'Reserved reason: automatic usage enforcement reasons cannot be used for an admin suspension.',
    );
  }
  const projects = await getOwnedProjectsByUserId(db, id);
  const user = await prepareRemoval(db, id, { kind: 'suspend', reason }, dryRun);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.suspend', target, {
      reason,
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
      effect:
        'Requests, cron jobs and queue delivery stop for these projects. Queue messages are dropped when their retries run out: after about 3 hours by default, at once with maxRetries 0. Restore does not bring them back.',
    });
  }
  // Ordinary users remain edge-first. Administrators have already lost access
  // atomically, so concurrent removals cannot count them during this fan-out.
  try {
    await setProjectsRoutingSuspension(context.env.ROUTING, db, projects, {
      op: 'suspend',
      reason,
      force: true,
    });
    await suspendUser(db, id, reason);
    await reconcileOperatorUserProjects(context, id);
  } catch (error) {
    console.error('[admin] suspend failed', { userId: id, error });
    throw new OperatorError(
      500,
      'Suspend incomplete. Edge enforcement could not be fully stamped. ' +
        (user.role === 'admin' ? 'Administrator access remains revoked. ' : '') +
        'Retry the suspend; the stamp is idempotent.',
      'partial_failure',
      { partial: true, target, reason, adminAccessRevoked: user.role === 'admin' },
    );
  }
  return { action: 'user.suspend', target, reason };
}

export async function restoreOperatorUser(context: Context<ApiEnv>, id: string, dryRun = false) {
  const db = context.get('db');
  const user = await requireUser(db, id);
  const projects = await getOwnedProjectsByUserId(db, id);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.restore', target, {
      previousReason: user.suspended_reason,
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
    });
  }
  // Preserve the DB suspension until every routing, sandbox and DO latch clears.
  try {
    const stub = context.env.USAGE_COUNTER.get(context.env.USAGE_COUNTER.idFromName(id));
    const results = await Promise.allSettled([
      setProjectsRoutingSuspension(context.env.ROUTING, db, projects, {
        op: 'unsuspend',
        matchReason: null,
      }),
      context.env.ROUTING.delete(sandboxBlockKey(id)),
      stub.fetch(new Request('https://do/clear-suspension', { method: 'POST' })),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
    const cleared = results[2];
    if (cleared.status === 'fulfilled' && !cleared.value.ok) {
      throw new Error(`clear-suspension DO returned HTTP ${cleared.value.status}`);
    }
    await unsuspendUser(db, id);
    await reconcileOperatorUserProjects(context, id);
  } catch (error) {
    console.error('[admin] unsuspend cleanup failed', { userId: id, error });
    throw new OperatorError(
      500,
      'Unsuspend incomplete. Edge enforcement state could not be fully cleared. Retry the unsuspend; cleanup is idempotent.',
      'partial_failure',
      { partial: true, target, cleanupComplete: false },
    );
  }
  return { action: 'user.restore', target, cleanupComplete: true };
}

export async function deleteOperatorProject(context: Context<ApiEnv>, id: string, dryRun = false) {
  const project = await requireProject(context.get('db'), id);
  const target = { id, slug: project.slug, userId: project.user_id };
  if (dryRun) {
    const [resources, domains] = await Promise.all([
      getProjectResources(context.get('db'), id),
      getDomainsByProjectId(context.get('db'), id),
    ]);
    return preview('project.delete', target, { resources, domains });
  }
  try {
    const { warnings } = await teardownProject(context, id, project);
    return { action: 'project.delete', target, deleted: true, warnings };
  } catch (error) {
    console.error('[admin] project delete failed', { projectId: id, error });
    throw new OperatorError(
      500,
      'Project deletion incomplete. Some resources may already be removed; inspect the project before retrying.',
      'partial_failure',
      { partial: true, target },
    );
  }
}

export async function deleteOperatorUser(context: Context<ApiEnv>, id: string, dryRun = false) {
  const db = context.get('db');
  const projects = await getOwnedProjectsByUserId(db, id);
  const user = await prepareRemoval(db, id, { kind: 'delete' }, dryRun);
  const target = { id, login: user.login };
  if (dryRun) {
    return preview('user.delete', target, {
      projects: projects.map((p) => ({ id: p.id, slug: p.slug })),
      deletesAllProjectResources: true,
    });
  }
  const deletedProjects: Array<string> = [];
  const warnings: Array<string> = [];
  let currentProject: string | undefined;
  try {
    for (const project of projects) {
      currentProject = project.id;
      const result = await teardownProject(context, project.id, project, {
        expectedOwnerUserId: id,
      });
      if (result.ownerChanged) {
        continue;
      }
      deletedProjects.push(project.id);
      warnings.push(...result.warnings);
    }
    currentProject = undefined;
    const cancelledBuilds = await deleteUser(db, id);
    await cancelContainerBuildDos(
      context.env,
      cancelledBuilds,
      'github connection authorizer account deleted',
    );
  } catch (error) {
    console.error('[admin] user delete failed', { userId: id, error });
    throw new OperatorError(
      500,
      'User deletion incomplete. Some projects or resources may already be removed. ' +
        (user.role === 'admin' ? 'Administrator access remains revoked. ' : '') +
        'Inspect the user before retrying.',
      'partial_failure',
      {
        partial: true,
        target,
        deletedProjects,
        currentProject,
        warnings,
        adminAccessRevoked: user.role === 'admin',
      },
    );
  }
  return { action: 'user.delete', target, deleted: true, deletedProjects, warnings };
}
