import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  createOrRefreshProjectInvitation,
  getPendingProjectInvitationsByUserId,
  getProjectInvitations,
  getProjectMembers,
  getProjectsByIds,
  getUser,
  getUsersByIds,
  ProjectTeamMutationError,
  removeProjectMember,
  resendProjectInvitation,
  respondToProjectInvitation,
  revokeProjectInvitation,
  setProjectMemberRole,
} from '../db.ts';
import { sendProjectInvitationEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import { PROJECT_PERMISSION_MESSAGES } from '../project-access.ts';
import { proxyTokenRotationWarnings } from '../proxy-token-rotation.ts';
import type {
  ProjectInvitation,
  ProjectInvitationStatus,
  ProjectMember,
  ProjectMemberRole,
  User,
} from '../types.ts';
import { dayBucket, minuteBucket, parseCounter } from './email.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const MEMBER_ROLES = new Set<ProjectMemberRole>(['reader', 'collaborator', 'admin']);
const INVITATION_EMAILS_PER_MINUTE = 5;
const INVITATION_EMAILS_PER_DAY = 50;

type MemberJson = Readonly<{
  user: Readonly<Pick<User, 'id' | 'login'>>;
  role: ProjectMemberRole | 'owner';
  created_at: string;
}>;

type InvitationJson = Readonly<{
  id: string;
  target: Readonly<Pick<User, 'id' | 'login' | 'email'>>;
  target_email: string;
  role: ProjectMemberRole;
  status: ProjectInvitationStatus;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}>;

function userSummary(user: User): Pick<User, 'id' | 'login'> {
  return { id: user.id, login: user.login };
}

function memberJson(member: ProjectMember, user: User): MemberJson {
  return {
    user: userSummary(user),
    role: member.role,
    created_at: member.created_at,
  };
}

function effectiveInvitationStatus(invitation: ProjectInvitation): ProjectInvitationStatus {
  if (invitation.status === 'pending' && Date.parse(invitation.expires_at) <= Date.now()) {
    return 'expired';
  }
  return invitation.status;
}

function invitationJson(invitation: ProjectInvitation, target: User): InvitationJson {
  return {
    id: invitation.id,
    target: { ...userSummary(target), email: target.email },
    target_email: invitation.target_email_snapshot,
    role: invitation.role,
    status: effectiveInvitationStatus(invitation),
    created_at: invitation.created_at,
    expires_at: invitation.expires_at,
    accepted_at: invitation.accepted_at,
    revoked_at: invitation.revoked_at,
  };
}

async function readJsonObject(context: Context<ApiEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await context.req.json();
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseRole(value: unknown): ProjectMemberRole | null {
  return typeof value === 'string' && MEMBER_ROLES.has(value as ProjectMemberRole)
    ? (value as ProjectMemberRole)
    : null;
}

function mutationErrorResponse(context: Context<ApiEnv>, error: unknown): Response {
  if (!(error instanceof ProjectTeamMutationError)) {
    throw error;
  }
  const errors: Record<ProjectTeamMutationError['reason'], string> = {
    'project-not-found': 'project not found',
    'project-deleting': 'project is being deleted',
    'target-user-not-found': 'registered user not found',
    'owner-conflict': 'the project owner cannot be invited or changed as a member',
    'member-conflict': 'user is already a project member',
    'member-not-found': 'project member not found',
    'invitation-not-found': 'project invitation not found',
    'invitation-not-pending': 'project invitation is no longer pending',
    'invitation-not-target': 'forbidden',
    'invitation-expired': 'project invitation has expired',
    'pending-invitation-limit': 'project has too many pending invitations',
    'owner-suspended': 'project owner suspended',
    forbidden: 'forbidden',
  };
  const messages: Record<ProjectTeamMutationError['reason'], string> = {
    'project-not-found': PROJECT_PERMISSION_MESSAGES['not-found'],
    'project-deleting':
      'This project is being deleted. Wait for deletion to finish and select another project.',
    'target-user-not-found':
      'No eligible registered account matches that email. Check the address and ask the person to sign in to this platform before inviting them.',
    'owner-conflict':
      'The project owner already has full access and cannot be managed as a team member. Manage other members instead.',
    'member-conflict':
      'This account is already a project member. Refresh the member list to review its access.',
    'member-not-found':
      'This project member could not be found. Refresh the member list and send a new invitation if access is still needed.',
    'invitation-not-found':
      'This invitation could not be found. Check your pending invitations or ask a project admin or owner to send a new one.',
    'invitation-not-pending':
      'This invitation is no longer pending. If you still need access, ask a project admin or owner to send a new invitation.',
    'invitation-not-target':
      'This invitation belongs to a different account. Sign in with the account that received it, or ask a project admin or owner to invite your current account.',
    'invitation-expired':
      'This invitation has expired. Ask a project admin or owner to resend it, then accept the renewed invitation.',
    'pending-invitation-limit':
      'This project has reached its pending invitation limit. Revoke unused invitations or wait for them to expire, then try again.',
    'owner-suspended': PROJECT_PERMISSION_MESSAGES['owner-suspended'],
    forbidden: PROJECT_PERMISSION_MESSAGES.members,
  };
  return context.json(
    { error: errors[error.reason], message: messages[error.reason] },
    error.status,
  );
}

export async function deliverInvitation(
  context: Context<ApiEnv>,
  invitation: ProjectInvitation,
  target: User,
  projectSlug: string,
): Promise<{ status: 'sent' | 'not_configured' | 'rate_limited' | 'failed' }> {
  if (!context.env.EMAIL || !target.email) {
    return { status: 'not_configured' };
  }
  try {
    if (!(await consumeInvitationEmailDelivery(context.env.ROUTING, invitation.project_id))) {
      return { status: 'rate_limited' };
    }
    await sendProjectInvitationEmail(context.env, {
      to: target.email,
      invitationId: invitation.id,
      projectSlug,
      inviterLogin: context.get('user').login,
      role: invitation.role,
    });
    return { status: 'sent' };
  } catch (error) {
    console.error('[api] project invitation email delivery failed', {
      invitationId: invitation.id,
      error,
    });
    return { status: 'failed' };
  }
}

/**
 * Approximate per-project delivery limit. KV can briefly undercount concurrent
 * requests across colos, which is acceptable for an email abuse guard. The
 * counter is consumed before sending so provider failures cannot be retried to
 * generate unlimited delivery attempts.
 */
async function consumeInvitationEmailDelivery(
  kv: KVNamespace,
  projectId: string,
): Promise<boolean> {
  const now = new Date();
  const minuteKey = `project-invitation-email-rate:${projectId}:${minuteBucket(now)}`;
  const dayKey = `project-invitation-email-rate:${projectId}:${dayBucket(now)}`;
  const [minuteRaw, dayRaw] = await Promise.all([kv.get(minuteKey), kv.get(dayKey)]);
  const minuteCount = parseCounter(minuteRaw);
  const dayCount = parseCounter(dayRaw);

  if (minuteCount >= INVITATION_EMAILS_PER_MINUTE || dayCount >= INVITATION_EMAILS_PER_DAY) {
    return false;
  }
  await Promise.all([
    kv.put(minuteKey, String(minuteCount + 1), { expirationTtl: 5 * 60 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 25 * 60 * 60 }),
  ]);
  return true;
}

export const projectTeamRoutes = new Hono<ApiEnv>()
  .get('/:id/members', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    const members = await getProjectMembers(context.get('db'), projectId);
    const warnings = await proxyTokenRotationWarnings(
      context.get('db'),
      projectId,
      access.role,
      !!context.get('deployScope'),
    );
    return context.json({
      members: [
        {
          user: userSummary(access.owner),
          role: 'owner' as const,
          created_at: access.project.created_at,
        },
        ...members.map(({ member, user }) => memberJson(member, user)),
      ],
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  })

  .get('/:id/invitations', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'members');
    if (access instanceof Response) {
      return access;
    }
    const invitations = await getProjectInvitations(context.get('db'), projectId);
    const targets = await getUsersByIds(
      context.get('db'),
      invitations.map((invitation) => invitation.target_user_id),
    );
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    return context.json({
      invitations: invitations.flatMap((invitation) => {
        const target = targetsById.get(invitation.target_user_id);
        return target ? [invitationJson(invitation, target)] : [];
      }),
    });
  })

  .post('/:id/invitations', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'members');
    if (access instanceof Response) {
      return access;
    }
    const body = await readJsonObject(context);
    const role = parseRole(body?.role);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      return context.json({ error: 'a valid registered email is required' }, 400);
    }
    if (!role) {
      return context.json({ error: 'role must be reader, collaborator, or admin' }, 400);
    }
    try {
      const result = await createOrRefreshProjectInvitation(context.get('db'), {
        projectId,
        email,
        role,
        actorUserId: context.get('user').id,
      });
      const delivery = await deliverInvitation(
        context,
        result.invitation,
        result.target,
        access.project.slug,
      );
      return context.json(
        {
          invitation: invitationJson(result.invitation, result.target),
          refreshed: result.refreshed,
          delivery,
        },
        result.refreshed ? 200 : 201,
      );
    } catch (error) {
      return mutationErrorResponse(context, error);
    }
  })

  .post('/:id/invitations/:invitationId/resend', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'members');
    if (access instanceof Response) {
      return access;
    }
    try {
      const result = await resendProjectInvitation(context.get('db'), {
        projectId,
        invitationId: context.req.param('invitationId'),
        actorUserId: context.get('user').id,
      });
      return context.json({
        invitation: invitationJson(result.invitation, result.target),
        delivery: await deliverInvitation(
          context,
          result.invitation,
          result.target,
          access.project.slug,
        ),
      });
    } catch (error) {
      return mutationErrorResponse(context, error);
    }
  })

  .delete('/:id/invitations/:invitationId', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'members');
    if (access instanceof Response) {
      return access;
    }
    try {
      await revokeProjectInvitation(context.get('db'), {
        projectId,
        invitationId: context.req.param('invitationId'),
        actorUserId: context.get('user').id,
      });
      return context.body(null, 204);
    } catch (error) {
      return mutationErrorResponse(context, error);
    }
  })

  .patch('/:id/members/:userId', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'members');
    if (access instanceof Response) {
      return access;
    }
    const body = await readJsonObject(context);
    const role = parseRole(body?.role);
    if (!role) {
      return context.json({ error: 'role must be reader, collaborator, or admin' }, 400);
    }
    try {
      const { member, cancelledBuilds } = await setProjectMemberRole(context.get('db'), {
        projectId,
        subjectUserId: context.req.param('userId'),
        role,
        actorUserId: context.get('user').id,
      });
      await cancelContainerBuildDos(
        context.env,
        cancelledBuilds,
        'github connection authorizer lost admin access',
      );
      const user = await getUser(context.get('db'), member.user_id);
      if (!user) {
        return context.json(
          {
            error: 'project member not found',
            message:
              'This project member could not be found. Refresh the member list and send a new invitation if access is still needed.',
          },
          404,
        );
      }
      return context.json({ member: memberJson(member, user) });
    } catch (error) {
      return mutationErrorResponse(context, error);
    }
  })

  .delete('/:id/members/:userId', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'members');
    if (access instanceof Response) {
      return access;
    }
    try {
      const { cancelledBuilds } = await removeProjectMember(context.get('db'), {
        projectId,
        subjectUserId: context.req.param('userId'),
        actorUserId: context.get('user').id,
      });
      await cancelContainerBuildDos(
        context.env,
        cancelledBuilds,
        'github connection authorizer removed from project',
      );
      return context.body(null, 204);
    } catch (error) {
      return mutationErrorResponse(context, error);
    }
  })

  .post('/:id/leave', async (context) => {
    const projectId = context.req.param('id');
    const access = await requireProjectRouteCapability(context, projectId, 'read');
    if (access instanceof Response) {
      return access;
    }
    if (access.role === 'owner') {
      return context.json(
        {
          error: 'the project owner cannot leave the project',
          message:
            'The project owner cannot leave. Ask a platform administrator to transfer ownership before leaving the project.',
        },
        409,
      );
    }
    try {
      const { cancelledBuilds } = await removeProjectMember(context.get('db'), {
        projectId,
        subjectUserId: context.get('user').id,
        actorUserId: context.get('user').id,
      });
      await cancelContainerBuildDos(
        context.env,
        cancelledBuilds,
        'github connection authorizer removed from project',
      );
      return context.body(null, 204);
    } catch (error) {
      return mutationErrorResponse(context, error);
    }
  });

export const myProjectInvitationRoutes = new Hono<ApiEnv>().get(
  '/project-invitations',
  async (context) => {
    const invitations = await getPendingProjectInvitationsByUserId(
      context.get('db'),
      context.get('user').id,
    );
    const projectIds = Array.from(new Set(invitations.map((invitation) => invitation.project_id)));
    const projects = await getProjectsByIds(context.get('db'), projectIds);
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const users = await getUsersByIds(
      context.get('db'),
      Array.from(
        new Set([
          ...projects.map((project) => project.user_id),
          ...invitations.map((invitation) => invitation.invited_by_user_id),
        ]),
      ),
    );
    const usersById = new Map(users.map((user) => [user.id, user]));

    return context.json({
      invitations: invitations.flatMap((invitation) => {
        const project = projectsById.get(invitation.project_id);
        if (!project) {
          return [];
        }
        const owner = usersById.get(project.user_id);
        const inviter = usersById.get(invitation.invited_by_user_id);
        return [
          {
            id: invitation.id,
            project: {
              id: project.id,
              slug: project.slug,
              owner: owner ? userSummary(owner) : { id: project.user_id, login: null },
            },
            invited_by: inviter
              ? userSummary(inviter)
              : { id: invitation.invited_by_user_id, login: null },
            role: invitation.role,
            created_at: invitation.created_at,
            expires_at: invitation.expires_at,
          },
        ];
      }),
    });
  },
);

async function respond(context: Context<ApiEnv>, response: 'accept' | 'decline') {
  const invitationId = context.req.param('invitationId');
  if (!invitationId) {
    return context.json({ error: 'Invitation not found' }, 404);
  }
  try {
    const result = await respondToProjectInvitation(context.get('db'), {
      invitationId,
      actorUserId: context.get('user').id,
      response,
    });
    if (response === 'decline') {
      return context.body(null, 204);
    }
    if (!result.member) {
      throw new Error('accepted project invitation has no membership');
    }
    return context.json({ member: memberJson(result.member, context.get('user')) });
  } catch (error) {
    return mutationErrorResponse(context, error);
  }
}

export const projectInvitationResponseRoutes = new Hono<ApiEnv>()
  .post('/:invitationId/accept', (context) => respond(context, 'accept'))
  .post('/:invitationId/decline', (context) => respond(context, 'decline'));
