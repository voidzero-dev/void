import { log, outro } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import type { ProjectZeroTrustResponse, ProjectZeroTrustUpdateResponse } from './client.ts';
import { printSuccess, note, sanitizeTerminalText } from './output.ts';
import type { ProjectArgs } from './project-args.ts';
import { readProjectConfig } from './project.ts';
import { getRequestedProjectSlug, requireProjectBySlug } from './resolve-project.ts';

type ZeroTrustArgs = Extract<ProjectArgs, { subcommand: 'zero-trust' }> & {
  action: 'status' | 'protect' | 'public' | 'reconcile';
};

async function resolveTarget(root: string, args: ZeroTrustArgs) {
  const token = getToken(root);
  if (!token) {
    throw new Error('project: Not logged in. Run `void account login` first.');
  }
  const client = new PlatformClient(token, { root });
  const requestedSlug = getRequestedProjectSlug({ projectSlug: args.projectSlug });
  if (requestedSlug) {
    const project = await requireProjectBySlug(client, requestedSlug);
    return { client, projectId: project.projectId, slug: project.slug };
  }
  const linked = readProjectConfig(root);
  if (!linked) {
    throw new Error('project: No linked project. Pass --project <name> or set VOID_PROJECT.');
  }
  return { client, projectId: linked.projectId, slug: linked.slug };
}

function statusLines(result: ProjectZeroTrustResponse): string {
  const project = result.project;
  const platformStatus = sanitizeTerminalText(result.platformStatus);
  const unavailableMessage =
    result.platformStatus === 'invalid_configuration'
      ? 'The platform Zero Trust configuration is invalid. Ask a platform administrator to review it.'
      : result.platformStatus === 'configuring'
        ? 'The platform is still applying Zero Trust configuration. A platform administrator can resume it with `void platform zero-trust reconcile`.'
        : result.platformStatus === 'disabling'
          ? 'The platform is disabling project Zero Trust. A platform administrator can resume it with `void platform zero-trust reconcile`.'
          : result.platformStatus === 'error'
            ? 'The platform Zero Trust configuration needs administrator attention. A platform administrator can inspect its status and reconcile it.'
            : result.platformStatus === 'ready'
              ? 'The platform administrator has disabled project Zero Trust.'
              : 'The platform administrator has not configured project Zero Trust.';
  return [
    `Available: ${result.available ? 'yes' : 'no'}`,
    `Platform: ${platformStatus}`,
    ...(result.platformStatus === 'not_configured' ||
    result.platformStatus === 'invalid_configuration'
      ? []
      : [`Default for new projects: ${result.protectNewProjects ? 'protected' : 'public'}`]),
    `Desired: ${project ? (project.desired_protected ? 'protected' : 'public') : 'not initialized'}`,
    `Effective: ${project ? (project.effective_protected ? 'protected' : 'public') : 'not initialized'}`,
    `State: ${project?.state ?? 'not initialized'}`,
    ...(project?.last_error ? [`Last error: ${sanitizeTerminalText(project.last_error)}`] : []),
    ...(!result.available ? [unavailableMessage] : []),
  ].join('\n');
}

export async function runProjectZeroTrustCommand(root: string, args: ZeroTrustArgs): Promise<void> {
  console.log();
  const { client, projectId, slug } = await resolveTarget(root, args);
  if (args.action === 'status') {
    note(statusLines(await client.getProjectZeroTrust(projectId)), slug);
    outro(`${slug} Zero Trust status`);
    return;
  }
  const result: ProjectZeroTrustUpdateResponse =
    args.action === 'reconcile'
      ? await client.reconcileProjectZeroTrust(projectId)
      : await client.setProjectZeroTrust(projectId, args.action === 'protect');
  if (result.project.last_error) {
    log.warn(sanitizeTerminalText(result.project.last_error));
  }
  if (result.project.state === 'reconciling') {
    outro(
      `${slug} Zero Trust update is still in progress. Run \`void project zero-trust reconcile\` to continue, or wait for scheduled maintenance.`,
    );
    return;
  }
  if (result.project.last_error || result.project.state === 'error') {
    outro(`${slug} Zero Trust needs attention (${result.project.state}).`);
    return;
  }
  printSuccess(
    args.action === 'protect'
      ? `${slug} is protected by Zero Trust.`
      : args.action === 'public'
        ? `${slug} is public.`
        : `${slug} Zero Trust reconciled (${result.project.state}).`,
  );
}
