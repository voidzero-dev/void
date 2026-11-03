import {
  and,
  count,
  desc,
  asc,
  eq,
  ne,
  gt,
  inArray,
  isNull,
  or,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { generateId } from '../id.ts';
import { roleLosesDeployCapability } from '../project-access.ts';
import { requestProxyTokenRotation } from '../proxy-token-rotation-request.ts';
import {
  users,
  projects,
  projectMembers,
  projectInvitations,
  projectOwnershipPeriods,
  projectAccessEvents,
  deployments,
} from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import type {
  Deployment,
  ProjectAccessEventAction,
  ProjectInvitation,
  ProjectMember,
  ProjectMemberRole,
  ProjectOwnershipPeriod,
  ProjectRole,
  Project,
  User,
} from '../types.ts';
import { type TerminatedBuild } from './builds.ts';
import { type Db } from './client.ts';
import { invalidateGitHubConnectionAuthorizedBy } from './github.ts';

// --- Projects ---

export async function createProject(db: Db, userId: string, slug: string): Promise<Project> {
  const id = generateId('proj');
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(projects).values({ id, user_id: userId, slug }).returning();
    await tx
      .insert(projectOwnershipPeriods)
      .values({
        id: generateId('pown'),
        project_id: created.id,
        owner_user_id: userId,
        starts_at: created.created_at,
      })
      .onConflictDoNothing();
    return created;
  });
}

export async function getProject(db: Db, id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
}

export async function getProjectBySlug(db: Db, slug: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  return row ?? null;
}

/** The project whose email alias is `alias`, if any. Aliases and slugs share one namespace. */
export async function getProjectByEmailAlias(db: Db, alias: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.email_alias, alias)).limit(1);
  return row ?? null;
}

export async function getOwnedProjectsByUserId(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<Project>> {
  return db
    .select()
    .from(projects)
    .where(eq(projects.user_id, userId))
    .orderBy(desc(projects.created_at));
}

type AccessibleProject = Readonly<{
  project: Project;
  role: ProjectRole;
  owner: User;
}>;

const accessibleProjectOwner = alias(users, 'accessible_project_owner');

/** Accessible projects whose billing owner is not manually suspended. */
export async function getAccessibleProjectsByUserId(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<AccessibleProject>> {
  const rows = await db
    .select({ project: projects, memberRole: projectMembers.role, owner: accessibleProjectOwner })
    .from(projects)
    .innerJoin(accessibleProjectOwner, eq(projects.user_id, accessibleProjectOwner.id))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.project_id, projects.id), eq(projectMembers.user_id, userId)),
    )
    .where(or(eq(projects.user_id, userId), eq(projectMembers.user_id, userId)))
    .orderBy(desc(projects.created_at));

  return rows
    .filter((row) => !isAdminSuspended(row.owner.suspended_reason))
    .map((row) => ({
      project: row.project,
      role: row.project.user_id === userId ? 'owner' : row.memberRole!,
      owner: row.owner,
    }));
}

/** Resolve one accessible project without loading the user's project list. */
export async function getAccessibleProjectBySlug(
  db: Db,
  userId: string,
  slug: string,
): Promise<AccessibleProject | null> {
  const [row] = await db
    .select({ project: projects, memberRole: projectMembers.role, owner: accessibleProjectOwner })
    .from(projects)
    .innerJoin(accessibleProjectOwner, eq(projects.user_id, accessibleProjectOwner.id))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.project_id, projects.id), eq(projectMembers.user_id, userId)),
    )
    .where(
      and(
        eq(projects.slug, slug),
        or(eq(projects.user_id, userId), eq(projectMembers.user_id, userId)),
      ),
    )
    .limit(1);

  if (!row || isAdminSuspended(row.owner.suspended_reason)) {
    return null;
  }
  return {
    project: row.project,
    role: row.project.user_id === userId ? 'owner' : row.memberRole!,
    owner: row.owner,
  };
}

// --- Project team membership and invitations ---

const PROJECT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_PROJECT_INVITATIONS = 100;

type ProjectMemberWithUser = Readonly<{ member: ProjectMember; user: User }>;

async function getProjectMember(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectMember | null> {
  const [row] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.project_id, projectId), eq(projectMembers.user_id, userId)))
    .limit(1);
  return row ?? null;
}

export async function getProjectMembers(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectMemberWithUser>> {
  return db
    .select({ member: projectMembers, user: users })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.user_id, users.id))
    .where(eq(projectMembers.project_id, projectId))
    .orderBy(asc(projectMembers.created_at), asc(projectMembers.user_id));
}

type ProjectTeamMutationErrorReason =
  | 'project-not-found'
  | 'project-deleting'
  | 'target-user-not-found'
  | 'owner-conflict'
  | 'member-conflict'
  | 'member-not-found'
  | 'invitation-not-found'
  | 'invitation-not-pending'
  | 'invitation-not-target'
  | 'invitation-expired'
  | 'pending-invitation-limit'
  | 'owner-suspended'
  | 'forbidden';

export class ProjectTeamMutationError extends Error {
  readonly status: 403 | 404 | 409;

  constructor(readonly reason: ProjectTeamMutationErrorReason) {
    super(reason);
    this.name = 'ProjectTeamMutationError';
    this.status =
      reason === 'invitation-not-target' || reason === 'owner-suspended' || reason === 'forbidden'
        ? 403
        : reason.endsWith('not-found')
          ? 404
          : 409;
  }
}

async function lockProject(db: Db, projectId: string): Promise<Project> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update')
    .limit(1);
  if (!project) {
    throw new ProjectTeamMutationError('project-not-found');
  }
  if (project.status === 'deleting') {
    throw new ProjectTeamMutationError('project-deleting');
  }
  return project;
}

/** Re-check team-management access while the project lock is held. */
async function requireLockedMembersCapability(
  db: Db,
  project: Project,
  actorUserId: string,
  platformAdmin = false,
): Promise<void> {
  await requireLockedProjectOwnerActive(db, project);
  if (platformAdmin || project.user_id === actorUserId) {
    return;
  }
  const actorMember = await getProjectMember(db, project.id, actorUserId);
  if (actorMember?.role !== 'admin') {
    throw new ProjectTeamMutationError('forbidden');
  }
}

async function requireLockedProjectOwnerActive(db: Db, project: Project): Promise<void> {
  const [owner] = await db
    .select({ suspendedReason: users.suspended_reason })
    .from(users)
    .where(eq(users.id, project.user_id))
    .for('share')
    .limit(1);
  if (owner && isAdminSuspended(owner.suspendedReason)) {
    throw new ProjectTeamMutationError('owner-suspended');
  }
}

async function createProjectAccessEvent(
  db: Db,
  args: {
    projectId: string;
    actorUserId: string;
    action: ProjectAccessEventAction;
    subjectUserId?: string | null;
    invitationEmailSnapshot?: string | null;
    previousRole?: ProjectMemberRole | null;
    newRole?: ProjectMemberRole | null;
  },
): Promise<void> {
  await db.insert(projectAccessEvents).values({
    id: generateId('pae'),
    project_id: args.projectId,
    actor_user_id: args.actorUserId,
    subject_user_id: args.subjectUserId ?? null,
    invitation_email_snapshot: args.invitationEmailSnapshot ?? null,
    previous_role: args.previousRole ?? null,
    new_role: args.newRole ?? null,
    action: args.action,
  });
}

export async function addProjectMember(
  db: Db,
  args: {
    projectId: string;
    subjectUserId: string;
    role: ProjectMemberRole;
    actorUserId: string;
    platformAdmin?: boolean;
  },
): Promise<ProjectMember> {
  return db.transaction(async (tx) => {
    const project = await lockProject(tx, args.projectId);
    await requireLockedMembersCapability(tx, project, args.actorUserId, args.platformAdmin);
    if (project.user_id === args.subjectUserId) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, args.subjectUserId))
      .for('share')
      .limit(1);
    if (!target) {
      throw new ProjectTeamMutationError('target-user-not-found');
    }
    if (await getProjectMember(tx, args.projectId, args.subjectUserId)) {
      throw new ProjectTeamMutationError('member-conflict');
    }

    // A direct grant supersedes an invitation. The project lock also serializes
    // this with an attempt to accept that invitation.
    const [pending] = await tx
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.project_id, args.projectId),
          eq(projectInvitations.target_user_id, args.subjectUserId),
          eq(projectInvitations.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);
    if (pending) {
      await tx
        .update(projectInvitations)
        .set({ status: 'revoked', revoked_at: sql`now()`, revoked_by_user_id: args.actorUserId })
        .where(eq(projectInvitations.id, pending.id));
      await createProjectAccessEvent(tx, {
        projectId: args.projectId,
        actorUserId: args.actorUserId,
        subjectUserId: args.subjectUserId,
        invitationEmailSnapshot: pending.target_email_snapshot,
        action: 'invitation_revoked',
        previousRole: pending.role,
      });
    }

    const [member] = await tx
      .insert(projectMembers)
      .values({
        project_id: args.projectId,
        user_id: args.subjectUserId,
        role: args.role,
        added_by_user_id: args.actorUserId,
      })
      .returning();
    await createProjectAccessEvent(tx, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: args.subjectUserId,
      action: 'member_added',
      newRole: args.role,
    });
    return member;
  });
}

export async function setProjectMemberRole(
  db: Db,
  args: {
    projectId: string;
    subjectUserId: string;
    role: ProjectMemberRole;
    actorUserId: string;
    platformAdmin?: boolean;
  },
): Promise<{ member: ProjectMember; cancelledBuilds: ReadonlyArray<TerminatedBuild> }> {
  return db.transaction(async (tx) => {
    const project = await lockProject(tx, args.projectId);
    await requireLockedMembersCapability(tx, project, args.actorUserId, args.platformAdmin);
    if (project.user_id === args.subjectUserId) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    const current = await getProjectMember(tx, args.projectId, args.subjectUserId);
    if (!current) {
      throw new ProjectTeamMutationError('member-not-found');
    }
    if (current.role === args.role) {
      return { member: current, cancelledBuilds: [] };
    }
    const [member] = await tx
      .update(projectMembers)
      .set({ role: args.role, updated_at: sql`now()` })
      .where(
        and(
          eq(projectMembers.project_id, args.projectId),
          eq(projectMembers.user_id, args.subjectUserId),
        ),
      )
      .returning();
    await createProjectAccessEvent(tx, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: args.subjectUserId,
      action: 'role_changed',
      previousRole: current.role,
      newRole: args.role,
    });
    if (roleLosesDeployCapability(current.role, args.role)) {
      await requestProxyTokenRotation(tx, args.projectId, 'member-role-changed', 'member');
    }
    const cancelledBuilds =
      args.role === 'admin'
        ? []
        : await invalidateGitHubConnectionAuthorizedBy(
            tx,
            args.projectId,
            args.subjectUserId,
            'github connection authorizer lost admin access',
          );
    return { member, cancelledBuilds };
  });
}

export async function removeProjectMember(
  db: Db,
  args: { projectId: string; subjectUserId: string; actorUserId: string; platformAdmin?: boolean },
): Promise<{ cancelledBuilds: ReadonlyArray<TerminatedBuild> }> {
  return db.transaction(async (tx) => {
    const project = await lockProject(tx, args.projectId);
    if (project.user_id === args.subjectUserId) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    const current = await getProjectMember(tx, args.projectId, args.subjectUserId);
    if (!current) {
      throw new ProjectTeamMutationError('member-not-found');
    }
    if (args.platformAdmin || args.actorUserId !== args.subjectUserId) {
      await requireLockedMembersCapability(tx, project, args.actorUserId, args.platformAdmin);
    } else {
      await requireLockedProjectOwnerActive(tx, project);
    }
    const [member] = await tx
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.project_id, args.projectId),
          eq(projectMembers.user_id, args.subjectUserId),
        ),
      )
      .returning();
    if (!member) {
      throw new ProjectTeamMutationError('member-not-found');
    }
    await createProjectAccessEvent(tx, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: args.subjectUserId,
      action:
        !args.platformAdmin && args.actorUserId === args.subjectUserId ? 'left' : 'member_removed',
      previousRole: member.role,
    });
    if (roleLosesDeployCapability(member.role, null)) {
      await requestProxyTokenRotation(tx, args.projectId, 'member-removed', 'member');
    }
    const cancelledBuilds = await invalidateGitHubConnectionAuthorizedBy(
      tx,
      args.projectId,
      args.subjectUserId,
      'github connection authorizer removed from project',
    );
    return { cancelledBuilds };
  });
}

async function getProjectInvitation(
  db: Db,
  invitationId: string,
): Promise<ProjectInvitation | null> {
  const [row] = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.id, invitationId))
    .limit(1);
  return row ?? null;
}

export async function getProjectInvitations(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectInvitation>> {
  return db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.project_id, projectId))
    .orderBy(desc(projectInvitations.created_at));
}

export async function getPendingProjectInvitations(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<ProjectInvitation>> {
  return db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.project_id, projectId),
        eq(projectInvitations.status, 'pending'),
        gt(projectInvitations.expires_at, sql`now()`),
      ),
    )
    .orderBy(desc(projectInvitations.created_at))
    .limit(MAX_PENDING_PROJECT_INVITATIONS);
}

export async function getPendingProjectInvitationsByUserId(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<ProjectInvitation>> {
  const rows = await db
    .select({ invitation: projectInvitations })
    .from(projectInvitations)
    .innerJoin(projects, eq(projects.id, projectInvitations.project_id))
    .where(
      and(
        eq(projectInvitations.target_user_id, userId),
        eq(projectInvitations.status, 'pending'),
        gt(projectInvitations.expires_at, sql`now()`),
        eq(projects.status, 'active'),
      ),
    )
    .orderBy(desc(projectInvitations.created_at));
  return rows.map((row) => row.invitation);
}

/** The project lock must be held while checking capacity and writing the invitation. */
async function requireLockedProjectInvitationCapacity(
  db: Db,
  projectId: string,
  existingInvitationId?: string,
): Promise<void> {
  const [pendingCount] = await db
    .select({ count: count() })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.project_id, projectId),
        eq(projectInvitations.status, 'pending'),
        gt(projectInvitations.expires_at, sql`now()`),
        // A live invitation already occupies its slot; an expired one needs a free slot.
        existingInvitationId ? ne(projectInvitations.id, existingInvitationId) : undefined,
      ),
    );
  if ((pendingCount?.count ?? 0) >= MAX_PENDING_PROJECT_INVITATIONS) {
    throw new ProjectTeamMutationError('pending-invitation-limit');
  }
}

export async function createOrRefreshProjectInvitation(
  db: Db,
  args: {
    projectId: string;
    email: string;
    role: ProjectMemberRole;
    actorUserId: string;
    platformAdmin?: boolean;
  },
): Promise<Readonly<{ invitation: ProjectInvitation; target: User; refreshed: boolean }>> {
  const normalizedEmail = args.email.trim().toLowerCase();
  const targets = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizedEmail}`)
    .limit(2);
  if (targets.length !== 1) {
    throw new ProjectTeamMutationError('target-user-not-found');
  }
  const target = targets[0]!;
  const expiresAt = new Date(Date.now() + PROJECT_INVITATION_TTL_MS).toISOString();

  return db.transaction(async (tx) => {
    const project = await lockProject(tx, args.projectId);
    const lockedUsers = await tx
      .select()
      .from(users)
      .where(inArray(users.id, [...new Set([project.user_id, target.id])].sort()))
      .orderBy(asc(users.id))
      .for('update');
    const lockedById = new Map(lockedUsers.map((user) => [user.id, user]));
    const lockedOwner = lockedById.get(project.user_id);
    const lockedTarget = lockedById.get(target.id);
    if (!lockedTarget || lockedTarget.email?.trim().toLowerCase() !== normalizedEmail) {
      throw new ProjectTeamMutationError('target-user-not-found');
    }
    if (lockedOwner && isAdminSuspended(lockedOwner.suspended_reason)) {
      throw new ProjectTeamMutationError('owner-suspended');
    }
    if (!args.platformAdmin && project.user_id !== args.actorUserId) {
      const actorMember = await getProjectMember(tx, project.id, args.actorUserId);
      if (actorMember?.role !== 'admin') {
        throw new ProjectTeamMutationError('forbidden');
      }
    }
    if (project.user_id === target.id) {
      throw new ProjectTeamMutationError('owner-conflict');
    }
    if (await getProjectMember(tx, args.projectId, target.id)) {
      throw new ProjectTeamMutationError('member-conflict');
    }
    const [pending] = await tx
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.project_id, args.projectId),
          eq(projectInvitations.target_user_id, target.id),
          eq(projectInvitations.status, 'pending'),
        ),
      )
      .for('update')
      .limit(1);

    await requireLockedProjectInvitationCapacity(tx, args.projectId, pending?.id);

    let invitation: ProjectInvitation;
    if (pending) {
      [invitation] = await tx
        .update(projectInvitations)
        .set({
          role: args.role,
          target_email_snapshot: normalizedEmail,
          invited_by_user_id: args.actorUserId,
          expires_at: expiresAt,
        })
        .where(eq(projectInvitations.id, pending.id))
        .returning();
    } else {
      [invitation] = await tx
        .insert(projectInvitations)
        .values({
          id: generateId('pinv'),
          project_id: args.projectId,
          target_user_id: target.id,
          target_email_snapshot: normalizedEmail,
          role: args.role,
          invited_by_user_id: args.actorUserId,
          expires_at: expiresAt,
        })
        .returning();
    }
    await createProjectAccessEvent(tx, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: target.id,
      invitationEmailSnapshot: normalizedEmail,
      action: 'invited',
      previousRole: pending?.role,
      newRole: args.role,
    });
    return { invitation, target: lockedTarget, refreshed: !!pending };
  });
}

export async function resendProjectInvitation(
  db: Db,
  args: { projectId: string; invitationId: string; actorUserId: string },
): Promise<Readonly<{ invitation: ProjectInvitation; target: User }>> {
  const expiresAt = new Date(Date.now() + PROJECT_INVITATION_TTL_MS).toISOString();
  return db.transaction(async (tx) => {
    const project = await lockProject(tx, args.projectId);
    await requireLockedMembersCapability(tx, project, args.actorUserId);
    const [invitation] = await tx
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.id, args.invitationId),
          eq(projectInvitations.project_id, args.projectId),
        ),
      )
      .for('update')
      .limit(1);
    if (!invitation) {
      throw new ProjectTeamMutationError('invitation-not-found');
    }
    if (invitation.status !== 'pending') {
      throw new ProjectTeamMutationError('invitation-not-pending');
    }
    const [target] = await tx
      .select()
      .from(users)
      .where(eq(users.id, invitation.target_user_id))
      .for('share')
      .limit(1);
    if (!target?.email) {
      throw new ProjectTeamMutationError('target-user-not-found');
    }
    await requireLockedProjectInvitationCapacity(tx, args.projectId, invitation.id);
    const normalizedEmail = target.email.trim().toLowerCase();
    const [updated] = await tx
      .update(projectInvitations)
      .set({ target_email_snapshot: normalizedEmail, expires_at: expiresAt })
      .where(eq(projectInvitations.id, invitation.id))
      .returning();
    await createProjectAccessEvent(tx, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: target.id,
      invitationEmailSnapshot: normalizedEmail,
      action: 'invitation_resent',
      newRole: invitation.role,
    });
    return { invitation: updated, target };
  });
}

export async function revokeProjectInvitation(
  db: Db,
  args: { projectId: string; invitationId: string; actorUserId: string; platformAdmin?: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const project = await lockProject(tx, args.projectId);
    await requireLockedMembersCapability(tx, project, args.actorUserId, args.platformAdmin);
    const [invitation] = await tx
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.id, args.invitationId),
          eq(projectInvitations.project_id, args.projectId),
        ),
      )
      .for('update')
      .limit(1);
    if (!invitation) {
      throw new ProjectTeamMutationError('invitation-not-found');
    }
    if (invitation.status !== 'pending') {
      throw new ProjectTeamMutationError('invitation-not-pending');
    }
    await tx
      .update(projectInvitations)
      .set({
        status: 'revoked',
        revoked_at: sql`now()`,
        revoked_by_user_id: args.actorUserId,
      })
      .where(eq(projectInvitations.id, invitation.id));
    await createProjectAccessEvent(tx, {
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      subjectUserId: invitation.target_user_id,
      invitationEmailSnapshot: invitation.target_email_snapshot,
      action: 'invitation_revoked',
      previousRole: invitation.role,
    });
  });
}

export async function respondToProjectInvitation(
  db: Db,
  args: { invitationId: string; actorUserId: string; response: 'accept' | 'decline' },
): Promise<Readonly<{ member: ProjectMember | null }>> {
  const locator = await getProjectInvitation(db, args.invitationId);
  if (!locator) {
    throw new ProjectTeamMutationError('invitation-not-found');
  }

  const result = await db.transaction(async (tx) => {
    const project = await lockProject(tx, locator.project_id);
    const [locked] = await tx
      .select({
        invitation: projectInvitations,
        expired: sql<boolean>`${projectInvitations.expires_at} <= now()`,
      })
      .from(projectInvitations)
      .where(eq(projectInvitations.id, args.invitationId))
      .for('update')
      .limit(1);
    if (!locked) {
      throw new ProjectTeamMutationError('invitation-not-found');
    }
    const invitation = locked.invitation;
    if (invitation.target_user_id !== args.actorUserId) {
      throw new ProjectTeamMutationError('invitation-not-target');
    }
    const resultingStatus = args.response === 'accept' ? 'accepted' : 'declined';
    if (invitation.status === resultingStatus) {
      if (args.response === 'accept' && project.user_id === args.actorUserId) {
        throw new ProjectTeamMutationError('owner-conflict');
      }
      const member =
        args.response === 'accept'
          ? await getProjectMember(tx, project.id, args.actorUserId)
          : null;
      // Acceptance is idempotent only while the access it created still
      // exists. Once an administrator removes that member, replaying the old
      // invitation must not produce a 500 or recreate access; a fresh invite
      // is required.
      if (args.response === 'accept' && !member) {
        throw new ProjectTeamMutationError('invitation-not-pending');
      }
      return { member };
    }
    if (invitation.status !== 'pending') {
      throw new ProjectTeamMutationError('invitation-not-pending');
    }
    if (locked.expired) {
      await tx
        .update(projectInvitations)
        .set({ status: 'expired' })
        .where(eq(projectInvitations.id, invitation.id));
      return { error: 'invitation-expired' as const };
    }
    let member: ProjectMember | null = null;
    if (args.response === 'accept') {
      if (project.user_id === args.actorUserId) {
        throw new ProjectTeamMutationError('owner-conflict');
      }
      if (await getProjectMember(tx, project.id, args.actorUserId)) {
        throw new ProjectTeamMutationError('member-conflict');
      }
      await requireLockedProjectOwnerActive(tx, project);
      [member] = await tx
        .insert(projectMembers)
        .values({
          project_id: project.id,
          user_id: args.actorUserId,
          role: invitation.role,
          added_by_user_id: invitation.invited_by_user_id,
        })
        .returning();
    }
    await tx
      .update(projectInvitations)
      .set({
        status: resultingStatus,
        accepted_by_user_id: args.response === 'accept' ? args.actorUserId : null,
        accepted_at: args.response === 'accept' ? sql`now()` : null,
      })
      .where(eq(projectInvitations.id, invitation.id));
    await createProjectAccessEvent(tx, {
      projectId: project.id,
      actorUserId: args.actorUserId,
      subjectUserId: args.actorUserId,
      invitationEmailSnapshot: invitation.target_email_snapshot,
      action: args.response === 'accept' ? 'accepted' : 'declined',
      newRole: args.response === 'accept' ? invitation.role : null,
    });
    return { member };
  });

  if ('error' in result) {
    throw new ProjectTeamMutationError(result.error!);
  }
  return result;
}

// --- Project ownership history ---

export async function getProjectOwnershipPeriodsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<ProjectOwnershipPeriod>> {
  if (projectIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(projectOwnershipPeriods)
    .where(inArray(projectOwnershipPeriods.project_id, projectIds))
    .orderBy(asc(projectOwnershipPeriods.project_id), asc(projectOwnershipPeriods.starts_at));
}

export async function getProjectUsageOwnershipSnapshot(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<
  Readonly<{
    projects: ReadonlyArray<Project>;
    ownershipPeriods: ReadonlyArray<ProjectOwnershipPeriod>;
  }>
> {
  const ids = [...new Set(projectIds)].sort();
  if (ids.length === 0) {
    return { projects: [], ownershipPeriods: [] };
  }
  return db.transaction(async (tx) => {
    const lockedProjects = await tx
      .select()
      .from(projects)
      .where(inArray(projects.id, ids))
      .orderBy(asc(projects.id))
      .for('share');
    const lockedProjectIds = lockedProjects.map((project) => project.id);
    const ownershipPeriods =
      lockedProjectIds.length === 0
        ? []
        : await tx
            .select()
            .from(projectOwnershipPeriods)
            .where(inArray(projectOwnershipPeriods.project_id, lockedProjectIds))
            .orderBy(
              asc(projectOwnershipPeriods.project_id),
              asc(projectOwnershipPeriods.starts_at),
            );
    return { projects: lockedProjects, ownershipPeriods };
  });
}

export async function getOpenProjectOwnershipPeriodsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<ProjectOwnershipPeriod>> {
  if (projectIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(projectOwnershipPeriods)
    .where(
      and(
        inArray(projectOwnershipPeriods.project_id, projectIds),
        isNull(projectOwnershipPeriods.ends_at),
      ),
    );
}

export async function getLatestDeploymentsByProjectIds(
  db: Db,
  projectIds: ReadonlyArray<string>,
): Promise<
  Map<
    string,
    Pick<
      Deployment,
      'id' | 'project_id' | 'status' | 'source' | 'commit' | 'created_at' | 'deployed_at'
    >
  >
> {
  if (projectIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .selectDistinctOn([deployments.project_id], {
      id: deployments.id,
      project_id: deployments.project_id,
      status: deployments.status,
      source: deployments.source,
      commit: deployments.commit,
      created_at: deployments.created_at,
      deployed_at: deployments.deployed_at,
    })
    .from(deployments)
    .where(inArray(deployments.project_id, projectIds))
    .orderBy(deployments.project_id, desc(deployments.created_at), desc(deployments.id));

  return new Map(rows.map((row) => [row.project_id, row]));
}

export async function getProjectsByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<Project>> {
  if (ids.length === 0) {
    return [];
  }

  return db.select().from(projects).where(inArray(projects.id, ids));
}

export async function getProjectsWithOwnerByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<
  ReadonlyArray<
    Project & {
      owner_login: string | null;
    }
  >
> {
  if (ids.length === 0) {
    return [];
  }

  return db
    .select({
      ...getTableColumns(projects),
      owner_login: users.login,
    })
    .from(projects)
    .leftJoin(users, eq(projects.user_id, users.id))
    .where(inArray(projects.id, ids));
}

export async function updateProjectType(db: Db, id: string, type: Project['type']): Promise<void> {
  await db.update(projects).set({ type }).where(eq(projects.id, id));
}

export async function updateProjectWebSocketVersion(
  db: Db,
  id: string,
  websocketVersion: number,
): Promise<void> {
  await db.update(projects).set({ websocket_version: websocketVersion }).where(eq(projects.id, id));
}
