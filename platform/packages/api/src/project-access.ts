import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from './db.ts';
import { projectMembers, projects, users } from './schema.ts';
import { isAdminSuspended } from './suspension.ts';
import type { Project, ProjectCapability, ProjectRole, User } from './types.ts';

export type ProjectAccess = Readonly<{
  project: Project;
  role: ProjectRole;
  owner: User;
}>;

const PROJECT_ROLE_CAPABILITIES = {
  reader: ['read'],
  collaborator: ['read', 'deploy', 'configure'],
  admin: ['read', 'deploy', 'configure', 'settings', 'members'],
  owner: ['read', 'deploy', 'configure', 'settings', 'members', 'delete'],
} as const satisfies Record<ProjectRole, ReadonlyArray<ProjectCapability>>;

// These messages describe requirements, not the caller's role or private project data.
export const PROJECT_PERMISSION_MESSAGES = {
  read: 'You need project access to view this project. Ask a project admin or owner to invite you.',
  deploy:
    'Deploying requires the collaborator, admin, or owner role. Ask a project admin or owner to update your access.',
  configure:
    'Changing project configuration requires the collaborator, admin, or owner role. Ask a project admin or owner to update your access.',
  settings:
    'Changing project settings requires the admin or owner role. Ask a project admin or owner to update your access.',
  members:
    'Managing project members and invitations requires the admin or owner role. Ask a project admin or owner to update your access.',
  delete: 'Only the project owner can delete this project. Ask the owner to delete it.',
  tokens:
    'Only the project owner can manage deploy tokens. Ask the owner to create or manage a token.',
  'database-url':
    'Only the project owner can view the database connection URL. Ask the owner to share the connection details you need.',
  'email-alias': 'Only the project owner can set the project email alias. Ask the owner to set it.',
  'owner-suspended':
    "This project's owner account is suspended. Ask the owner to contact the platform administrator to restore access.",
  'not-found':
    'This project could not be found. Check the project ID or refresh your project list.',
} as const satisfies Record<
  ProjectCapability | 'tokens' | 'database-url' | 'email-alias' | 'owner-suspended' | 'not-found',
  string
>;

export function hasProjectCapability(role: ProjectRole, capability: ProjectCapability): boolean {
  return (PROJECT_ROLE_CAPABILITIES[role] as ReadonlyArray<ProjectCapability>).includes(capability);
}

/** Whether a member change from `previous` to `next` (null = removed) takes away deploy. */
export function roleLosesDeployCapability(
  previous: ProjectRole,
  next: ProjectRole | null,
): boolean {
  return (
    hasProjectCapability(previous, 'deploy') && !(next && hasProjectCapability(next, 'deploy'))
  );
}

const projectOwner = alias(users, 'project_owner');

async function selectProjectAccess(
  db: Db,
  projectId: string,
  actorUserId: string,
): Promise<Readonly<{ project: Project; owner: User; memberRole: ProjectRole | null }> | null> {
  const [row] = await db
    .select({
      project: projects,
      owner: projectOwner,
      memberRole: projectMembers.role,
    })
    .from(projects)
    .innerJoin(projectOwner, eq(projects.user_id, projectOwner.id))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.project_id, projects.id), eq(projectMembers.user_id, actorUserId)),
    )
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    project: row.project,
    owner: row.owner,
    memberRole: row.project.user_id === actorUserId ? 'owner' : row.memberRole,
  };
}

/** The user's current role on the project, null without one. Owner suspension is not checked. */
export async function projectRoleForUser(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  return (await selectProjectAccess(db, projectId, userId))?.memberRole ?? null;
}

export class ProjectNotFoundError extends Error {
  readonly status = 404 as const;
  readonly userMessage = PROJECT_PERMISSION_MESSAGES['not-found'];

  constructor() {
    super('project not found');
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectAccessDeniedError extends Error {
  readonly status = 403 as const;

  constructor(
    message = 'forbidden',
    readonly userMessage: string = PROJECT_PERMISSION_MESSAGES.read,
  ) {
    super(message);
    this.name = 'ProjectAccessDeniedError';
  }
}

export class ProjectOwnerSuspendedError extends ProjectAccessDeniedError {
  constructor() {
    super('project owner suspended', PROJECT_PERMISSION_MESSAGES['owner-suspended']);
    this.name = 'ProjectOwnerSuspendedError';
  }
}

export function projectAccessErrorBody(error: ProjectNotFoundError | ProjectAccessDeniedError): {
  error: string;
  message: string;
} {
  return { error: error.message, message: error.userMessage };
}

/**
 * Assert a live project role and an owner not manually suspended. The owner is
 * returned separately so plan/quota callers do not consult the actor.
 */
export async function requireProjectCapability(
  db: Db,
  projectId: string,
  actorUserId: string,
  capability: ProjectCapability,
): Promise<ProjectAccess> {
  const row = await selectProjectAccess(db, projectId, actorUserId);
  if (!row) {
    throw new ProjectNotFoundError();
  }
  if (!row.memberRole || !hasProjectCapability(row.memberRole, capability)) {
    throw new ProjectAccessDeniedError('forbidden', PROJECT_PERMISSION_MESSAGES[capability]);
  }
  if (isAdminSuspended(row.owner.suspended_reason)) {
    throw new ProjectOwnerSuspendedError();
  }
  return { project: row.project, role: row.memberRole, owner: row.owner };
}
