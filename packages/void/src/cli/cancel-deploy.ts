import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import type { DeploymentResponse } from './client.ts';
import { outro, log, confirm, isCancel } from './interactive-prompts.ts';
import { printSuccess } from './output.ts';
import { readProjectConfig } from './project.ts';

const ACTIVE_STATUSES = new Set(['pending', 'uploading', 'migrating', 'prerendering']);

export async function runCancelDeployCommand(root: string, deployId?: string): Promise<void> {
  console.log();

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const linked = readProjectConfig(root);
  if (!linked) {
    log.error('No linked project found. Run `void project link` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });
  const { deployments } = await client.listDeployments(linked.projectId);
  const target = deployId
    ? deployments.find((d) => d.id === deployId)
    : deployments.find((d) => ACTIVE_STATUSES.has(d.status));

  if (!target) {
    if (deployId) {
      log.error(`project: Deployment '${deployId}' was not found.`);
      process.exit(1);
    }
    log.warn('No active deploy found.');
    outro('Nothing canceled.');
    return;
  }

  if (!ACTIVE_STATUSES.has(target.status)) {
    if (deployId) {
      log.error(`project: Deployment '${target.id}' is already '${target.status}'.`);
      process.exit(1);
    }
    log.warn(`project: Deployment '${target.id}' is already '${target.status}'.`);
    outro('Nothing canceled.');
    return;
  }

  const ok = await confirm({
    message: `Cancel deployment ${formatDeployment(target)}?`,
  });
  if (isCancel(ok) || !ok) {
    outro('Canceled.');
    return;
  }

  await client.cancelDeployment(linked.projectId, target.id);
  printSuccess(`Cancellation requested for deployment ${target.id}.`);
}

function formatDeployment(deployment: DeploymentResponse): string {
  const suffix = deployment.commit ? ` (${deployment.commit.slice(0, 7)})` : '';
  return `${deployment.id} [${deployment.status}]${suffix}`;
}
