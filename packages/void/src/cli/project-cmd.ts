import type { ProjectArgs } from './project-args.ts';
import { readDeploymentPlatform } from './project.ts';
import { runProjectsCommand } from './projects.ts';

export async function runProjectCommand(root: string, args: ProjectArgs): Promise<void> {
  const cloudflare = readDeploymentPlatform(root) === 'cloudflare';
  if (args.subcommand === 'status') {
    const { runListCommand } = await import('./list.ts');
    return runListCommand(root, args.name || undefined);
  }
  if (args.subcommand === 'link') {
    if (cloudflare) {
      throw new Error(
        'project: Direct Cloudflare apps are identified by cloudflare.name in void.config.ts and do not need linking.',
      );
    }
    const { runLink } = await import('./link.ts');
    return runLink(root, args.name || undefined);
  }
  if (args.subcommand === 'list') {
    if (cloudflare) {
      const { runListCommand } = await import('./list.ts');
      return runListCommand(root);
    }
    return runProjectsCommand(root);
  }
  if (args.subcommand === 'token') {
    if (cloudflare) {
      throw new Error(
        'project: CI deploy credentials are available only for Void platform projects.',
      );
    }
    const { runProjectTokenCommand } = await import('./project-token.ts');
    return runProjectTokenCommand(root, args);
  }
  if (args.subcommand === 'team') {
    if (args.action === '') {
      const { printHelpPage } = await import('./help.ts');
      printHelpPage(['project', 'team']);
      return;
    }
    const accountInvitationAction =
      args.action === 'pending' || args.action === 'accept' || args.action === 'decline';
    if (cloudflare && !accountInvitationAction) {
      throw new Error(
        'project: Teams are available only for projects hosted on a Void platform, not direct Cloudflare deployments.',
      );
    }
    const { runProjectTeamCommand } = await import('./project-team.ts');
    return runProjectTeamCommand(root, args);
  }
  if (args.subcommand === 'zero-trust') {
    if (cloudflare) {
      throw new Error(
        'project: Zero Trust overrides are available only for projects hosted on a Void platform.',
      );
    }
    if (args.action === '') {
      const { printHelpPage } = await import('./help.ts');
      printHelpPage(['project', 'zero-trust']);
      return;
    }
    const action = args.action;
    const { runProjectZeroTrustCommand } = await import('./project-zero-trust.ts');
    return runProjectZeroTrustCommand(root, { ...args, action });
  }
  if (args.subcommand === 'logs') {
    const { runLogsCommand } = await import('./logs.ts');
    return runLogsCommand(
      root,
      args.filter,
      args.range,
      args.deployment || undefined,
      args.level || undefined,
    );
  }
  if (args.subcommand === 'requests') {
    if (cloudflare) {
      throw new Error(
        'project: Historical request analytics require the Void platform. Use `void project logs` for a live Cloudflare tail.',
      );
    }
    const { runRequestsCommand } = await import('./requests.ts');
    return runRequestsCommand(root, args.range, args.status || undefined);
  }
  if (args.subcommand === 'rollback') {
    const { runRollbackCommand } = await import('./rollback.ts');
    return runRollbackCommand(root, args.deployId || undefined, args.platform);
  }
  if (args.subcommand === 'cancel') {
    if (cloudflare) {
      throw new Error(
        'project: Direct Cloudflare deploys activate only after readiness succeeds, so there is no remote build to cancel.',
      );
    }
    const { runCancelDeployCommand } = await import('./cancel-deploy.ts');
    return runCancelDeployCommand(root, args.deployId || undefined);
  }
  if (args.subcommand === 'delete') {
    if (cloudflare) {
      throw new Error(
        'project: Refusing to delete Cloudflare resources through this command. Direct deployments are additive and existing resources may be shared.',
      );
    }
    const { runDeleteCommand } = await import('./delete.ts');
    return runDeleteCommand(root, args.name || undefined, { force: args.force });
  }
  if (args.subcommand === 'purge-cache') {
    if (cloudflare) {
      throw new Error(
        'project: `void project purge-cache` is available only for projects hosted on a Void platform. For a direct Cloudflare deploy, redeploy or purge the configured ISR KV namespace.',
      );
    }
    const { runPurgeCacheCommand } = await import('./cache.ts');
    return runPurgeCacheCommand(root, args.projectSlug || undefined);
  }
}
