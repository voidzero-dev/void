import { Hono } from 'hono';
import {
  addProjectMember,
  createOrRefreshProjectInvitation,
  getProject,
  ProjectTeamMutationError,
  removeProjectMember,
  revokeProjectInvitation,
  setProjectMemberRole,
} from '../../db.ts';
import type { ApiEnv } from '../../env.ts';
import { cancelContainerBuildDos } from '../../github/cancel-builds.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  deleteOperatorProject,
  previewOperatorProjectOwner,
  transferOperatorProjectOwner,
} from '../../operator/tenant-service.ts';
import { zeroTrustOperatorError } from '../../operator/zero-trust-routes.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { deliverInvitation } from '../../routes/project-team.ts';
import type { ProjectMemberRole } from '../../types.ts';
import {
  reconcileProjectZeroTrust,
  setProjectZeroTrustProtection,
} from '../../zero-trust/project.ts';
import { renderFateDetailPage, renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

function transferTarget(body: Record<string, string | File>) {
  const value = body.userId;
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new OperatorError(400, 'New owner user ID is required.');
  }
  return value.trim();
}

function teamRole(value: string | File | undefined): ProjectMemberRole {
  if (value === 'reader' || value === 'collaborator' || value === 'admin') {
    return value;
  }
  throw new OperatorError(400, 'Choose a valid project team role.');
}

function teamMutationError(error: unknown): never {
  if (error instanceof ProjectTeamMutationError) {
    const messages: Partial<Record<ProjectTeamMutationError['reason'], string>> = {
      'project-not-found': 'Project not found.',
      'project-deleting': 'This project is being deleted.',
      'owner-conflict': 'Transfer ownership before changing or removing the project owner.',
      'member-conflict': 'This user is already a project team member.',
      'member-not-found': 'Project team member not found. Refresh the page and try again.',
      'target-user-not-found': 'Choose an existing platform user.',
      'invitation-not-found': 'Invitation not found. Refresh the page and try again.',
      'invitation-not-pending': 'This invitation is no longer pending.',
      'pending-invitation-limit':
        'This project has too many pending invitations. Revoke an unused invitation first.',
      'owner-suspended': 'The project owner is suspended. Restore their account first.',
    };
    throw new OperatorError(error.status, messages[error.reason] ?? error.message);
  }
  throw error;
}

function projectZeroTrustError(error: unknown): never {
  throw zeroTrustOperatorError(error, 'admin project operation failed');
}

app.get('/', (context) => renderFateListPage(context, 'projects'));

app.get('/:id', (context) => renderFateDetailPage(context, 'projectDetail'));

app.post('/:id/team/add', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  if (!userId || userId.length > 512) {
    throw new OperatorError(400, 'Choose a user to add to the team.');
  }
  const role = teamRole(body.role);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/team/add`, { userId, role }),
    async () => {
      try {
        await addProjectMember(context.get('db'), {
          projectId,
          subjectUserId: userId,
          role,
          actorUserId: context.get('user').id,
          platformAdmin: true,
        });
        return { response: context.redirect(`/admin/projects/${projectId}#team`), succeeded: true };
      } catch (error) {
        teamMutationError(error);
      }
    },
  );
});

app.post('/:id/team/invite', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new OperatorError(400, 'Choose a registered user with a valid email address.');
  }
  const role = teamRole(body.role);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/team/invite`, { email, role }),
    async () => {
      try {
        const { invitation, target } = await createOrRefreshProjectInvitation(context.get('db'), {
          projectId,
          email,
          role,
          actorUserId: context.get('user').id,
          platformAdmin: true,
        });
        const project = await getProject(context.get('db'), projectId);
        if (project) {
          await deliverInvitation(context, invitation, target, project.slug);
        }
        return { response: context.redirect(`/admin/projects/${projectId}#team`), succeeded: true };
      } catch (error) {
        teamMutationError(error);
      }
    },
  );
});

app.post('/:id/team/:userId/role', async (context) => {
  const projectId = context.req.param('id');
  const userId = context.req.param('userId');
  const role = teamRole((await context.req.parseBody()).role);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/team/${userId}/role`, { role }),
    async () => {
      try {
        const { cancelledBuilds } = await setProjectMemberRole(context.get('db'), {
          projectId,
          subjectUserId: userId,
          role,
          actorUserId: context.get('user').id,
          platformAdmin: true,
        });
        await cancelContainerBuildDos(
          context.env,
          cancelledBuilds,
          'github connection authorizer lost admin access',
        );
        return { response: context.redirect(`/admin/projects/${projectId}#team`), succeeded: true };
      } catch (error) {
        teamMutationError(error);
      }
    },
  );
});

app.post('/:id/team/:userId/remove', async (context) => {
  const projectId = context.req.param('id');
  const userId = context.req.param('userId');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/team/${userId}/remove`),
    async () => {
      try {
        const { cancelledBuilds } = await removeProjectMember(context.get('db'), {
          projectId,
          subjectUserId: userId,
          actorUserId: context.get('user').id,
          platformAdmin: true,
        });
        await cancelContainerBuildDos(
          context.env,
          cancelledBuilds,
          'github connection authorizer removed from project',
        );
        return { response: context.redirect(`/admin/projects/${projectId}#team`), succeeded: true };
      } catch (error) {
        teamMutationError(error);
      }
    },
  );
});

app.post('/:id/team/invitations/:invitationId/revoke', async (context) => {
  const projectId = context.req.param('id');
  const invitationId = context.req.param('invitationId');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/team/invitations/${invitationId}/revoke`),
    async () => {
      try {
        await revokeProjectInvitation(context.get('db'), {
          projectId,
          invitationId,
          actorUserId: context.get('user').id,
          platformAdmin: true,
        });
        return { response: context.redirect(`/admin/projects/${projectId}#team`), succeeded: true };
      } catch (error) {
        teamMutationError(error);
      }
    },
  );
});

app.post('/:id/zero-trust', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  if (body.protected !== 'true' && body.protected !== 'false') {
    throw new OperatorError(400, 'Project protection must be true or false.', 'invalid_argument');
  }
  const protectedProject = body.protected === 'true';
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`zero-trust/projects/${projectId}`, { protected: protectedProject }),
    async () => {
      try {
        // With the public gate on this stores a public request instead of going public.
        await setProjectZeroTrustProtection(
          context.env,
          context.get('db'),
          projectId,
          protectedProject,
          { requester: { userId: context.get('user').id, via: 'admin' } },
        );
      } catch (error) {
        projectZeroTrustError(error);
      }
      return {
        response: context.redirect(`/admin/projects/${encodeURIComponent(projectId)}#zero-trust`),
        succeeded: true,
      };
    },
  );
});

app.post('/:id/zero-trust/reconcile', async (context) => {
  const projectId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`zero-trust/projects/${projectId}/reconcile`),
    async () => {
      try {
        await reconcileProjectZeroTrust(context.env, context.get('db'), projectId);
      } catch (error) {
        projectZeroTrustError(error);
      }
      return {
        response: context.redirect(`/admin/projects/${encodeURIComponent(projectId)}#zero-trust`),
        succeeded: true,
      };
    },
  );
});

app.post('/:id/owner/preview', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = transferTarget(body);
  const result = await previewOperatorProjectOwner(context, projectId, userId);
  const convergenceOnly = !result.changed;
  const operationBlocked = result.blockers.some(
    (blocker) => !convergenceOnly || blocker.kind === 'deletion',
  );

  return renderAdminPage(
    context,
    'projectOwnerPreview',
    `${convergenceOnly ? 'Converge' : 'Transfer'} ${result.target.slug}`,
    {
      result,
      convergenceOnly,
      operationBlocked,
      projectId,
      userId,
      platformName: getPlatformDisplayName(context.env, context.req.url),
      username: context.get('user').login,
    },
  );
});

app.post('/:id/owner', async (context) => {
  const projectId = context.req.param('id');
  const body = await context.req.parseBody();
  const userId = transferTarget(body);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/owner`, { userId }),
    async () => {
      await transferOperatorProjectOwner(context, projectId, userId);
      return { response: context.redirect(`/admin/projects/${projectId}`), succeeded: true };
    },
  );
});

app.post('/:id/delete', async (context) => {
  const projectId = context.req.param('id');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`projects/${projectId}/delete`),
    async () => {
      await deleteOperatorProject(context, projectId);
      return { response: context.redirect('/admin/projects'), succeeded: true };
    },
  );
});

export default app;
