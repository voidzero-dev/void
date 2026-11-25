import {
  and,
  count,
  desc,
  asc,
  eq,
  ne,
  inArray,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { lockAuthSettings } from '../auth/configuration.ts';
import { generateId } from '../id.ts';
import {
  requestProxyTokenRotation,
  requestProxyTokenRotationsForMember,
} from '../proxy-token-rotation-request.ts';
import {
  users,
  projects,
  projectMembers,
  projectInvitations,
  projectOwnershipPeriods,
  deployments,
  platformEvents,
  invitations,
  githubConnections,
  platformLoginConnections,
  platformLoginIdentities,
} from '../schema.ts';
import type { AllowlistEntry } from '../signup-allowlist.ts';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
} from '../suspension.ts';
import type { Deployment, Invitation, PlatformEvent, Project, User } from '../types.ts';
import type { TerminatedBuild } from './builds.ts';
import type { Db } from './client.ts';
import { invalidateGitHubConnectionAuthorizedBy } from './github.ts';
import { getUser } from './users.ts';

export type AllowlistEntryStatus = AllowlistEntry & {
  accepted: boolean;
  deployed: boolean;
};

// --- Counts ---

export async function countUsers(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(users);
  return result?.count ?? 0;
}

export async function countProjects(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(projects);
  return result?.count ?? 0;
}

// --- Admin ---

export async function getAllUsers(
  db: Db,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<User>> {
  return db.select().from(users).orderBy(desc(users.created_at)).limit(limit).offset(offset);
}

export async function searchUsers(db: Db, query: string): Promise<ReadonlyArray<User>> {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(users)
    .where(or(ilike(users.login, pattern), ilike(users.email, pattern), ilike(users.id, pattern)))
    .orderBy(desc(users.created_at))
    .limit(50);
}

export async function getSystemStats(
  db: Db,
): Promise<{ users: number; projects: number; deployments: number }> {
  const [[u], [p], [d]] = await Promise.all([
    db.select({ count: count() }).from(users),
    db.select({ count: count() }).from(projects),
    db.select({ count: count() }).from(deployments),
  ]);
  return {
    users: u?.count ?? 0,
    projects: p?.count ?? 0,
    deployments: d?.count ?? 0,
  };
}

export type CliVersionDeploymentStats = Readonly<{
  cli_version: string | null;
  deployments: number;
  projects: number;
  users: number;
  first_seen: string;
  last_seen: string;
}>;

export async function getCliVersionDeploymentStats(
  db: Db,
  options?: { sinceDays?: number },
): Promise<ReadonlyArray<CliVersionDeploymentStats>> {
  const sinceDays = options?.sinceDays;
  return db
    .select({
      cli_version: deployments.cli_version,
      deployments: sql<number>`count(*)::int`,
      projects: sql<number>`count(distinct ${deployments.project_id})::int`,
      users: sql<number>`count(distinct ${projects.user_id})::int`,
      first_seen: sql<string>`min(${deployments.created_at})`,
      last_seen: sql<string>`max(${deployments.created_at})`,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      sinceDays && sinceDays > 0
        ? sql`${deployments.created_at} >= now() - (${sinceDays} * interval '1 day')`
        : sql`true`,
    )
    .groupBy(deployments.cli_version)
    .orderBy(desc(sql`count(*)`));
}

export class LastAdminError extends Error {
  constructor() {
    super('The last active administrator cannot be deleted, suspended, or demoted.');
    this.name = 'LastAdminError';
  }
}

/** Keep this transaction limited to database work, never external cleanup. */
async function withAdminRemovalGuard<T>(
  db: Db,
  id: string,
  change: (db: Db, user: User | null) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Serialize the check and access change with other removals and bootstrap.
    // A count outside this lock lets two administrators remove each other.
    const authSettings = await lockAuthSettings(tx);
    await tx.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
    const user = await getUser(tx, id);
    if (user?.role === 'admin') {
      const others = authSettings?.sessions_required
        ? await tx
            .select({ suspended_reason: users.suspended_reason })
            .from(users)
            .innerJoin(platformLoginIdentities, eq(platformLoginIdentities.user_id, users.id))
            .innerJoin(
              platformLoginConnections,
              eq(platformLoginConnections.id, platformLoginIdentities.connection_id),
            )
            .where(
              and(
                eq(users.role, 'admin'),
                ne(users.id, id),
                eq(platformLoginConnections.enabled, true),
              ),
            )
        : await tx
            .select({ suspended_reason: users.suspended_reason })
            .from(users)
            .where(and(eq(users.role, 'admin'), ne(users.id, id)));
      if (!others.some((admin) => !isAdminSuspended(admin.suspended_reason))) {
        throw new LastAdminError();
      }
    }
    return change(tx, user);
  });
}

/** An admin suspension ends deploy access, like account deletion. */
async function requestRotationsForAdminSuspension(tx: Db, id: string): Promise<void> {
  await requestProxyTokenRotationsForMember(tx, id, 'user-suspended');
}

/**
 * Revoke administrator access before external deletion/suspension work begins.
 * This durable change prevents another removal from counting this administrator
 * while cleanup is in flight. Keep it on cleanup failure so retries stay safe.
 */
export async function prepareUserRemoval(
  db: Db,
  id: string,
  action: { kind: 'delete' } | { kind: 'suspend'; reason: string },
  dryRun = false,
): Promise<User | null> {
  return withAdminRemovalGuard(db, id, async (tx, user) => {
    if (user?.role === 'admin' && !dryRun) {
      await tx
        .update(users)
        .set(action.kind === 'delete' ? { role: 'user' } : { suspended_reason: action.reason })
        .where(eq(users.id, id));
      // The suspension is in force from here, even when the rest of the
      // removal fails.
      if (action.kind === 'suspend' && isAdminSuspended(action.reason)) {
        await requestRotationsForAdminSuspension(tx, id);
      }
    }
    return user;
  });
}

export async function suspendUser(db: Db, id: string, reason: string): Promise<void> {
  const suspend = async (target: Db) => {
    await target.update(users).set({ suspended_reason: reason }).where(eq(users.id, id));
  };
  if (isAdminSuspended(reason)) {
    await withAdminRemovalGuard(db, id, async (tx) => {
      await suspend(tx);
      await requestRotationsForAdminSuspension(tx, id);
    });
  } else {
    // Usage limits suspend app traffic, not administrator access. A delayed
    // quota write must not undo an administrator's manual access revocation.
    await db
      .update(users)
      .set({ suspended_reason: reason })
      .where(
        and(
          eq(users.id, id),
          or(
            isNull(users.suspended_reason),
            inArray(users.suspended_reason, [
              REASON_REQUESTS_EXCEEDED,
              REASON_SANDBOX_RUNTIME_EXCEEDED,
            ]),
          ),
        ),
      );
  }
}

export async function unsuspendUser(db: Db, id: string): Promise<void> {
  await db.update(users).set({ suspended_reason: null }).where(eq(users.id, id));
}

export async function deleteUser(db: Db, id: string): Promise<ReadonlyArray<TerminatedBuild>> {
  return withAdminRemovalGuard(db, id, async (tx) => {
    const cancelledBuilds: Array<TerminatedBuild> = [];
    // Discover every project from one statement snapshot. Separate reads could
    // miss an invitation accepted between the membership and invitation reads.
    const affectedProjects = await tx
      .select({ projectId: projectMembers.project_id })
      .from(projectMembers)
      .where(eq(projectMembers.user_id, id))
      .union(
        tx
          .select({ projectId: projectInvitations.project_id })
          .from(projectInvitations)
          .where(
            and(
              eq(projectInvitations.target_user_id, id),
              eq(projectInvitations.status, 'pending'),
            ),
          ),
      )
      .union(
        tx
          .select({ projectId: githubConnections.project_id })
          .from(githubConnections)
          .where(eq(githubConnections.authorized_by_user_id, id)),
      );
    const projectIds = affectedProjects.map(({ projectId }) => projectId).sort();
    if (projectIds.length > 0) {
      // GitHub connection CRUD and build creation take the project lock before
      // the connection lock. Preserve that order here so deleting an
      // authorizing member serializes with both paths without deadlocking.
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(inArray(projects.id, projectIds))
        .orderBy(asc(projects.id))
        .for('update');

      // Pending invitations are in the lock set so acceptance cannot add a
      // membership after discovery. Re-read the connections under every lock:
      // a creator that acquired a project lock first may have inserted after
      // discovery and would otherwise block the user delete below.
      const authorizedConnections = await tx
        .select({ projectId: githubConnections.project_id })
        .from(githubConnections)
        .where(
          and(
            eq(githubConnections.authorized_by_user_id, id),
            inArray(githubConnections.project_id, projectIds),
          ),
        )
        .orderBy(asc(githubConnections.project_id));
      for (const { projectId } of authorizedConnections) {
        cancelledBuilds.push(
          ...(await invalidateGitHubConnectionAuthorizedBy(
            tx,
            projectId,
            id,
            'github connection authorizer account deleted',
          )),
        );
      }

      const deployMemberships = await tx
        .select({ projectId: projectMembers.project_id })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.user_id, id),
            inArray(projectMembers.role, ['collaborator', 'admin']),
            inArray(projectMembers.project_id, projectIds),
          ),
        )
        .orderBy(asc(projectMembers.project_id));
      for (const { projectId } of deployMemberships) {
        await requestProxyTokenRotation(tx, projectId, 'user-deleted', 'member');
      }
    }
    await tx.delete(users).where(eq(users.id, id));
    return cancelledBuilds;
  });
}

type ProjectWithOwner = Project & {
  owner_login: string | null;
  last_deploy: string | null;
  last_deploy_id: string | null;
  last_deploy_status: string | null;
};

function selectProjectsWithOwner(db: Db) {
  const lastDeploy = db
    .selectDistinctOn([deployments.project_id], {
      project_id: deployments.project_id,
      last_deploy: deployments.created_at,
      last_deploy_id: deployments.id,
      last_deploy_status: deployments.status,
    })
    .from(deployments)
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id))
    .as('last_deploy_sq');
  const query = db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
      last_deploy: lastDeploy.last_deploy,
      last_deploy_id: lastDeploy.last_deploy_id,
      last_deploy_status: lastDeploy.last_deploy_status,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .leftJoin(lastDeploy, eq(projects.id, lastDeploy.project_id));
  return { lastDeploy, query };
}

export async function searchProjects(
  db: Db,
  query: string,
): Promise<ReadonlyArray<ProjectWithOwner>> {
  const pattern = `%${query}%`;
  const { lastDeploy, query: projectsWithOwner } = selectProjectsWithOwner(db);
  return projectsWithOwner
    .where(
      or(
        ilike(projects.slug, pattern),
        ilike(users.login, pattern),
        ilike(projects.id, pattern),
        ilike(projects.type, pattern),
        ilike(lastDeploy.last_deploy_status, pattern),
      ),
    )
    .orderBy(desc(projects.created_at))
    .limit(50);
}

export async function searchDeployments(
  db: Db,
  query: string,
): Promise<
  ReadonlyArray<Deployment & { project_slug: string | null; active_deployment_id: string | null }>
> {
  const pattern = `%${query}%`;
  return db
    .select({
      ...getTableColumns(deployments),
      project_slug: projects.slug,
      active_deployment_id: projects.active_deployment_id,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      or(
        ilike(deployments.id, pattern),
        ilike(projects.slug, pattern),
        ilike(deployments.status, pattern),
        ilike(deployments.commit, pattern),
        ilike(deployments.source, pattern),
        ilike(deployments.cli_version, pattern),
        ilike(deployments.error_message, pattern),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(50);
}

export async function getAllProjectsWithOwner(
  db: Db,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<ProjectWithOwner>> {
  return selectProjectsWithOwner(db)
    .query.orderBy(desc(projects.created_at))
    .limit(limit)
    .offset(offset);
}

// --- Users ---

export async function getFirstAdmin(db: Db) {
  const [row] = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);
  return row ?? null;
}

export async function updateUserProviderId(db: Db, id: string, providerId: string): Promise<void> {
  await db.update(users).set({ provider_id: providerId }).where(eq(users.id, id));
}

export async function getUsersWithProjectsBatch(db: Db, limit: number, offset: number) {
  const userRows = await db
    .select({
      id: users.id,
      plan: users.plan,
      billing_cycle_start: users.billing_cycle_start,
      suspended_reason: users.suspended_reason,
    })
    .from(users)
    .orderBy(asc(users.id))
    .limit(limit)
    .offset(offset);

  if (userRows.length === 0) {
    return [];
  }

  const userIds = userRows.map((u) => u.id);
  const [projectRows, ownershipRows] = await Promise.all([
    db
      .select({
        id: projects.id,
        slug: projects.slug,
        user_id: projects.user_id,
        created_at: projects.created_at,
      })
      .from(projects)
      .where(inArray(projects.user_id, userIds)),
    db
      .selectDistinct({ user_id: projectOwnershipPeriods.owner_user_id })
      .from(projectOwnershipPeriods)
      .where(inArray(projectOwnershipPeriods.owner_user_id, userIds)),
  ]);

  const projectsByUser = new Map<string, typeof projectRows>();
  for (const p of projectRows) {
    const list = projectsByUser.get(p.user_id) ?? [];
    list.push(p);
    projectsByUser.set(p.user_id, list);
  }

  const usersWithOwnership = new Set(ownershipRows.map((row) => row.user_id));
  return userRows.map((user) => {
    const projects = projectsByUser.get(user.id) ?? [];
    return {
      user,
      projects,
      needsUsageReconciliation: projects.length > 0 || usersWithOwnership.has(user.id),
    };
  });
}

function emailMatchesEntry(email: string, entry: AllowlistEntry): boolean {
  if (entry.type !== 'email') {
    return false;
  }
  const normalizedEmail = email.toLowerCase();
  const pattern = entry.pattern.toLowerCase();
  return pattern.startsWith('*@')
    ? normalizedEmail.endsWith(pattern.slice(1))
    : normalizedEmail === pattern;
}

export async function getAllowlistEntryStatuses(
  db: Db,
  entries: ReadonlyArray<AllowlistEntry>,
): Promise<ReadonlyArray<AllowlistEntryStatus>> {
  if (entries.length === 0) {
    return [];
  }

  const exactEmails = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.type === 'email' && !entry.pattern.startsWith('*@')
          ? [entry.pattern.toLowerCase()]
          : [],
      ),
    ),
  );
  const emailDomains = Array.from(
    new Set(
      entries.flatMap((entry) =>
        entry.type === 'email' && entry.pattern.startsWith('*@')
          ? [entry.pattern.slice(1).toLowerCase()]
          : [],
      ),
    ),
  );
  const githubLogins = Array.from(
    new Set(
      entries.flatMap((entry) => (entry.type === 'github' ? [entry.pattern.toLowerCase()] : [])),
    ),
  );

  const userConditions = [
    exactEmails.length > 0 ? inArray(sql<string>`lower(${users.email})`, exactEmails) : undefined,
    githubLogins.length > 0
      ? and(eq(users.provider, 'github'), inArray(sql<string>`lower(${users.login})`, githubLogins))
      : undefined,
    ...emailDomains.map((domain) => sql`lower(${users.email}) like ${`%${domain}`}`),
  ].filter((condition) => condition !== undefined);

  const matchingUsers =
    userConditions.length > 0
      ? await db
          .select({
            id: users.id,
            provider: users.provider,
            login: users.login,
            email: users.email,
          })
          .from(users)
          .where(or(...userConditions))
      : [];

  const identityEntries = entries.filter((entry) => entry.type === 'identity');
  const matchingIdentities =
    identityEntries.length > 0
      ? await db
          .select({
            userId: platformLoginIdentities.user_id,
            connectionId: platformLoginIdentities.connection_id,
            subject: platformLoginIdentities.subject,
          })
          .from(platformLoginIdentities)
          .where(
            or(
              ...identityEntries.map((entry) =>
                and(
                  eq(platformLoginIdentities.connection_id, entry.connectionId),
                  eq(platformLoginIdentities.subject, entry.subject),
                ),
              ),
            ),
          )
      : [];

  const invitationConditions = [
    exactEmails.length > 0
      ? inArray(sql<string>`lower(${invitations.email})`, exactEmails)
      : undefined,
    ...emailDomains.map((domain) => sql`lower(${invitations.email}) like ${`%${domain}`}`),
  ].filter((condition) => condition !== undefined);

  const acceptedInvitations =
    invitationConditions.length > 0
      ? await db
          .select({ email: invitations.email })
          .from(invitations)
          .where(and(eq(invitations.status, 'accepted'), or(...invitationConditions)))
      : [];

  const matchingUserIds = Array.from(
    new Set([
      ...matchingUsers.map((user) => user.id),
      ...matchingIdentities.map((row) => row.userId),
    ]),
  );
  const deployedUserRows =
    matchingUserIds.length > 0
      ? await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(projects, eq(projects.user_id, users.id))
          .innerJoin(deployments, eq(deployments.project_id, projects.id))
          .where(and(inArray(users.id, matchingUserIds), isNotNull(deployments.deployed_at)))
      : [];
  const deployedUserIds = new Set(deployedUserRows.map((row) => row.id));

  function userMatchesEntry(user: (typeof matchingUsers)[number], entry: AllowlistEntry): boolean {
    if (entry.type === 'github') {
      return user.provider === 'github' && user.login.toLowerCase() === entry.pattern.toLowerCase();
    }
    return !!user.email && emailMatchesEntry(user.email, entry);
  }

  return entries.map((entry) => {
    if (entry.type === 'identity') {
      const userIds = matchingIdentities
        .filter(
          (identity) =>
            identity.connectionId === entry.connectionId && identity.subject === entry.subject,
        )
        .map((identity) => identity.userId);
      return {
        ...entry,
        accepted: userIds.length > 0,
        deployed: userIds.some((userId) => deployedUserIds.has(userId)),
      };
    }
    const usersForEntry = matchingUsers.filter((user) => userMatchesEntry(user, entry));
    const hasAcceptedInvitation = acceptedInvitations.some((invitation) =>
      emailMatchesEntry(invitation.email, entry),
    );

    return {
      ...entry,
      accepted: usersForEntry.length > 0 || hasAcceptedInvitation,
      deployed: usersForEntry.some((user) => deployedUserIds.has(user.id)),
    };
  });
}

export async function unsuspendUserIfReason(db: Db, id: string, reason: string): Promise<void> {
  await db
    .update(users)
    .set({ suspended_reason: null })
    .where(and(eq(users.id, id), eq(users.suspended_reason, reason)));
}

// --- Platform Events ---

export async function updatePlatformEventStatus(
  db: Db,
  id: string,
  status: PlatformEvent['status'],
  errorMessage?: string,
): Promise<void> {
  await db
    .update(platformEvents)
    .set({ status, error_message: errorMessage ?? null })
    .where(eq(platformEvents.id, id));
}

export async function getPlatformEventsByBatchId(
  db: Db,
  batchId: string,
): Promise<ReadonlyArray<PlatformEvent>> {
  return db
    .select()
    .from(platformEvents)
    .where(eq(platformEvents.batch_id, batchId))
    .orderBy(asc(platformEvents.created_at));
}

// --- Invitations ---

export async function createInvitation(
  db: Db,
  email: string,
  invitedBy: string,
): Promise<Invitation> {
  const id = generateId('inv');
  const [row] = await db
    .insert(invitations)
    .values({ id, email: email.toLowerCase(), invited_by: invitedBy })
    .returning();
  return row;
}

export async function setInvitationEmailDeliveryStatus(
  db: Db,
  id: string,
  status: NonNullable<Invitation['email_delivery_status']>,
): Promise<Invitation> {
  const [row] = await db
    .update(invitations)
    .set({ email_delivery_status: status })
    .where(eq(invitations.id, id))
    .returning();
  if (!row) {
    throw new Error(`Invitation ${id} disappeared before its email status could be saved.`);
  }
  return row;
}

export async function revokeInvitation(db: Db, id: string, revokedBy: string): Promise<boolean> {
  const rows = await db
    .update(invitations)
    .set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: revokedBy })
    .where(and(eq(invitations.id, id), eq(invitations.status, 'pending')))
    .returning({ id: invitations.id });
  return rows.length > 0;
}

export async function acceptInvitationByEmail(
  db: Db,
  email: string,
  userId: string,
): Promise<void> {
  await db
    .update(invitations)
    .set({ status: 'accepted', accepted_by: userId, accepted_at: sql`now()` })
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        eq(invitations.status, 'pending'),
      ),
    );
}

export async function getAllInvitations(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  ReadonlyArray<Invitation & { invited_by_login: string | null; revoked_by_login: string | null }>
> {
  const invitedByUser = alias(users, 'invited_by_user');
  const revokedByUser = alias(users, 'revoked_by_user');
  return db
    .select({
      ...getTableColumns(invitations),
      invited_by_login: invitedByUser.login,
      revoked_by_login: revokedByUser.login,
    })
    .from(invitations)
    .leftJoin(invitedByUser, eq(invitations.invited_by, invitedByUser.id))
    .leftJoin(revokedByUser, eq(invitations.revoked_by, revokedByUser.id))
    .orderBy(desc(invitations.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countInvitations(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(invitations);
  return result?.count ?? 0;
}

export async function getInvitation(db: Db, id: string): Promise<Invitation | null> {
  const [row] = await db.select().from(invitations).where(eq(invitations.id, id)).limit(1);
  return row ?? null;
}

export async function getPendingInvitationByEmail(
  db: Db,
  email: string,
): Promise<Invitation | null> {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, email.toLowerCase()), eq(invitations.status, 'pending')))
    .limit(1);
  return row ?? null;
}
