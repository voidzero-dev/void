import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { getAccountCredential, getToken } from './auth.ts';
import {
  PlatformApiError,
  PlatformClient,
  type ProjectInvitationResponse,
  type ProjectMemberResponse,
} from './client.ts';
import { printSuccess, formatCount, formatUrl, note, sanitizeTerminalText } from './output.ts';
import { parsePlatformErrorBody, platformErrorMessage } from './platform-errors.ts';
import type { ProjectArgs } from './project-args.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, requireProjectBySlug } from './resolve-project.ts';

type ProjectTeamArgs = Exclude<Extract<ProjectArgs, { subcommand: 'team' }>, { action: '' }>;

function clean(value: string | null | undefined): string {
  // Tenant text must not execute terminal control sequences.
  // eslint-disable-next-line no-control-regex
  return (value ?? '—').replaceAll(/[\u0000-\u001f\u007f]/g, ' ');
}

function memberLines(members: Array<ProjectMemberResponse>): string {
  const rows = members.map((member) => ({
    id: member.user.id,
    login: member.user.login ?? '—',
    role: member.role,
  }));
  const widths = {
    id: Math.max(2, ...rows.map((row) => clean(row.id).length)),
    login: Math.max(5, ...rows.map((row) => clean(row.login).length)),
  };
  return [
    `${'ID'.padEnd(widths.id)}  ${'LOGIN'.padEnd(widths.login)}  ROLE`,
    ...rows.map(
      (row) =>
        `${clean(row.id).padEnd(widths.id)}  ${clean(row.login).padEnd(widths.login)}  ${row.role}`,
    ),
  ].join('\n');
}

function invitationEmail(invitation: ProjectInvitationResponse): string {
  return invitation.target?.email ?? invitation.target_email ?? '—';
}

function invitationLines(invitations: Array<ProjectInvitationResponse>, pending: boolean): string {
  return invitations
    .map((invitation) => {
      const project = pending ? `  ${clean(invitation.project?.slug)}` : '';
      const target = pending ? '' : `  ${clean(invitationEmail(invitation))}`;
      const status = pending ? '' : `  ${invitation.status ?? 'pending'}`;
      return `${clean(invitation.id)}${project}${target}  ${invitation.role}${status}  expires ${clean(invitation.expires_at)}`;
    })
    .join('\n');
}

async function resolveProjectId(
  root: string,
  client: PlatformClient,
  projectSlug: string,
): Promise<string> {
  const requestedSlug = getRequestedProjectSlug({ projectSlug });
  if (requestedSlug) {
    return (await requireProjectBySlug(client, requestedSlug)).projectId;
  }
  const linked = readProjectConfig(root);
  if (!linked) {
    throw new Error('No linked project. Run `void project link` or pass --project <slug>.');
  }
  return linked.projectId;
}

function invitationResponseError(error: unknown, apiUrl: string): unknown {
  if (!(error instanceof PlatformApiError)) {
    return error;
  }
  // New APIs explain the rejection, including scoped-token and suspension cases.
  // Do not mistake every 403 for an invitation addressed to another account.
  if (platformErrorMessage(parsePlatformErrorBody(error.body))) {
    return error;
  }
  let message: string;
  if (error.code === 'project invitation not found') {
    message = `Invitation not found on ${apiUrl}. Check VOID_API_URL if set, connect to the platform in your invitation with \`void connect <url>\`, then run \`void project team pending\` to check the invitation ID. If it is missing, ask a project administrator for a new invitation.`;
  } else if (error.code === 'forbidden') {
    message = `Your account cannot respond to this invitation on ${apiUrl}. Sign in with the account whose registered email received the invitation. To switch accounts, set VOID_API_URL to ${apiUrl}, unset VOID_TOKEN if present, then run \`void account logout\` and \`void account login\`. Run \`void project team pending\` to see that account's invitations.`;
  } else if (error.code === 'project invitation has expired') {
    message =
      'This invitation has expired. Ask a project administrator to invite you again, then run `void project team pending`.';
  } else if (error.code === 'project invitation is no longer pending') {
    message =
      'This invitation has already been answered or revoked. Run `void project team pending` to see invitations awaiting your response, or ask a project administrator to check your access.';
  } else {
    return error;
  }
  error.message = message;
  return error;
}

export async function runProjectTeamCommand(root: string, args: ProjectTeamArgs): Promise<void> {
  console.log();

  const accountScoped =
    args.action === 'pending' || args.action === 'accept' || args.action === 'decline';
  const { apiUrl, token } = accountScoped
    ? getAccountCredential()
    : { apiUrl: undefined, token: getToken(root) };
  if (apiUrl) {
    log.info(`Platform: ${formatUrl(apiUrl)}`);
  }
  if (!token) {
    log.error(
      apiUrl
        ? `Not logged in to ${apiUrl}. Run \`void connect ${apiUrl}\` to sign in.`
        : 'Not logged in. Run `void account login` first.',
    );
    process.exit(1);
  }
  const client = new PlatformClient(token, apiUrl ? { apiUrl } : { root });

  if (args.action === 'pending') {
    const invitations = await client.listPendingProjectInvitations();
    if (invitations.length === 0) {
      outro('No pending project invitations.');
      return;
    }
    note(invitationLines(invitations, true), 'Pending Project Invitations');
    outro(formatCount(invitations.length, 'invitation'));
    return;
  }
  if (args.action === 'accept' || args.action === 'decline') {
    try {
      await client.respondToProjectInvitation(args.invitationId, args.action);
    } catch (error) {
      throw invitationResponseError(error, client.apiUrl);
    }
    if (args.action === 'accept') {
      log.info(
        'Open the invited application’s directory and run `void project link` if it is not linked yet. If it is linked to another project, use a separate checkout. Accepting an invitation keeps existing project links.',
      );
    }
    printSuccess(`Project invitation ${args.action === 'accept' ? 'accepted' : 'declined'}.`);
    return;
  }

  const projectId = await resolveProjectId(
    root,
    client,
    'projectSlug' in args ? args.projectSlug : '',
  );
  if (args.action === 'list') {
    const { members, warnings } = await client.listProjectMembers(projectId);
    for (const warning of warnings ?? []) {
      log.warn(sanitizeTerminalText(warning));
    }
    note(memberLines(members), 'Project Team');
    outro(formatCount(members.length, 'member'));
    return;
  }
  if (args.action === 'invitations') {
    const invitations = await client.listProjectInvitations(projectId);
    if (invitations.length === 0) {
      outro('No project invitations found.');
      return;
    }
    note(invitationLines(invitations, false), 'Project Invitations');
    outro(formatCount(invitations.length, 'invitation'));
    return;
  }
  if (args.action === 'invite') {
    const result = await client.inviteProjectMember(projectId, args.email, args.role);
    const delivery =
      result.delivery.status === 'sent'
        ? ''
        : ` (email delivery: ${result.delivery.status.replace('_', ' ')})`;
    const action = result.refreshed ? 'Updated invitation for' : 'Invited';
    if (result.delivery.status !== 'sent') {
      note(
        `Invitation: ${clean(result.invitation.id)}\nShare these steps with the invited user:\n\nvoid connect '${client.apiUrl.replaceAll("'", "'\\''")}'\nvoid project team pending\nvoid project team accept ${clean(result.invitation.id)}`,
        'Invitation saved; email was not sent',
      );
    }
    printSuccess(
      `${action} ${clean(invitationEmail(result.invitation))} as ${args.role}${delivery}.`,
    );
    return;
  }
  if (args.action === 'role') {
    await client.updateProjectMemberRole(projectId, args.userId, args.role);
    printSuccess(`Changed ${args.userId} to ${args.role}.`);
    return;
  }
  if (args.action === 'remove') {
    await client.removeProjectMember(projectId, args.userId);
    printSuccess(`Removed ${args.userId} from the project.`);
    return;
  }
  if (args.action === 'revoke') {
    await client.revokeProjectInvitation(projectId, args.invitationId);
    printSuccess(`Revoked invitation ${args.invitationId}.`);
    return;
  }
  await client.leaveProject(projectId);
  printSuccess('Left the project.');
}
