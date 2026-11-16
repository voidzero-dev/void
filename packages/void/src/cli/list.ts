import { outro, log } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient, type DeploymentResponse } from './client.ts';
import {
  dim,
  formatCount,
  formatRelativeTime,
  pc,
  sanitizeTerminalText,
  tablePrefix,
} from './output.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';
import { resolveProjectBySlug } from './resolve-project.ts';

export async function runListCommand(root: string, slug?: string): Promise<void> {
  console.log();

  const platform = readDeploymentPlatform(root);
  if (platform === 'cloudflare') {
    return showCloudflareDeployments(root, slug);
  }
  if (platform === 'none') {
    throw new Error('project: Deployment is disabled. Run `void init` to choose a platform.');
  }

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  let projectId: string;
  let projectSlug: string;
  let client: PlatformClient;

  if (slug) {
    client = new PlatformClient(token, { root });
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, slug);
    if (!config) {
      log.error(`project: No project found with slug '${slug}'.`);
      process.exit(1);
    }
    projectId = config.projectId;
    projectSlug = slug;
  } else {
    const linked = readProjectConfig(root);
    if (!linked) {
      log.error('No linked project found. Pass a project name: void project status <name>');
      process.exit(1);
    }
    projectId = linked.projectId;
    projectSlug = linked.slug;
    client = new PlatformClient(token, { root });
  }

  await showDeployments(client, projectId, projectSlug);
}

async function showCloudflareDeployments(root: string, slug?: string): Promise<void> {
  if (slug) {
    throw new Error(
      'project: A project name selects a Void platform project and is not used for direct Cloudflare apps.',
    );
  }
  const { readCloudflareWorkerStatus, resolveCloudflareOperationContext } =
    await import('./cloudflare-operations.ts');
  const status = await readCloudflareWorkerStatus(resolveCloudflareOperationContext(root));
  if (status.versions.length === 0) {
    outro(`No deployments for ${status.workerName}.`);
    return;
  }
  const rows = [...status.versions].reverse().map((version) => ({
    id: version.id,
    status: version.id === status.activeVersionId ? 'live' : 'available',
    migrations: version.metadata?.migrations ? String(version.metadata.migrations.length) : '-',
    deployed: version.createdAt ? formatRelativeTime(version.createdAt) : '-',
  }));
  const idWidth = Math.max('id'.length, ...rows.map((row) => row.id.length));
  const statusWidth = Math.max('status'.length, ...rows.map((row) => row.status.length));
  const prefix = tablePrefix();
  console.log(prefix);
  console.log(
    `${prefix}${dim(`${'id'.padEnd(idWidth)}  ${'status'.padEnd(statusWidth)}  migrations  deployed`)}`,
  );
  for (const row of rows) {
    const renderedStatus = row.status === 'live' ? pc.bold(pc.green(row.status)) : dim(row.status);
    console.log(
      `${prefix}${row.id.padEnd(idWidth)}  ${renderedStatus}${''.padEnd(statusWidth - row.status.length)}  ${row.migrations.padEnd(10)}  ${row.deployed}`,
    );
  }
  outro(`${status.workerName} — ${formatCount(rows.length, 'version')}`);
}

async function showDeployments(
  client: PlatformClient,
  projectId: string,
  slug: string,
): Promise<void> {
  const { deployments, activeDeploymentId, warnings } = await client.listDeployments(projectId);
  for (const warning of warnings ?? []) {
    log.warn(sanitizeTerminalText(warning));
  }

  if (deployments.length === 0) {
    outro(`No deployments for ${slug}.`);
    return;
  }

  const latest = deployments[0];
  if (latest.status === 'failed' && latest.error_message) {
    log.error(`project: Latest deploy failed: '${latest.error_message}'.`);
  }

  const rows = deployments.map((d) => formatDeploymentRow(d, activeDeploymentId));

  const idWidth = Math.max('id'.length, ...rows.map((r) => r.id.length));
  const typeWidth = Math.max('type'.length, ...rows.map((r) => r.appType.length));
  const statusWidth = Math.max('status'.length, ...rows.map((r) => r.statusRaw.length));
  const sourceWidth = Math.max('source'.length, ...rows.map((r) => r.source.length));
  const commitWidth = Math.max('commit'.length, ...rows.map((r) => r.commit.length));
  const isrWidth = Math.max('isr'.length, ...rows.map((r) => r.isr.length));

  const prefix = tablePrefix();
  const header = `${prefix}${dim(`${'id'.padEnd(idWidth)}  ${'type'.padEnd(typeWidth)}  ${'status'.padEnd(statusWidth)}  ${'source'.padEnd(sourceWidth)}  ${'commit'.padEnd(commitWidth)}  ${'isr'.padEnd(isrWidth)}  deployed`)}`;

  const lines = rows.map(
    (row) =>
      `${prefix}${row.id.padEnd(idWidth)}  ${row.appType.padEnd(typeWidth)}  ${row.statusColored}${''.padEnd(statusWidth - row.statusRaw.length)}  ${row.source.padEnd(sourceWidth)}  ${row.commit.padEnd(commitWidth)}  ${row.isr.padEnd(isrWidth)}  ${row.deployed}`,
  );

  console.log(prefix);
  console.log(header);
  for (const line of lines) {
    console.log(line);
  }
  outro(`${slug} — ${formatCount(deployments.length, 'deployment')}`);
}

type DeploymentRow = {
  id: string;
  appType: string;
  statusRaw: string;
  statusColored: string;
  source: string;
  commit: string;
  isr: string;
  deployed: string;
};

function computeDisplayStatus(d: DeploymentResponse, activeDeploymentId: string | null): string {
  if (d.status === 'failed') {
    return 'failed';
  }
  if (d.status !== 'live') {
    return d.status;
  }
  if (d.id === activeDeploymentId) {
    return 'live';
  }
  if (d.retained) {
    return 'retained';
  }
  return 'evicted';
}

function colorStatus(status: string): string {
  switch (status) {
    case 'live':
      return pc.bold(pc.green(status));
    case 'retained':
      return dim(pc.green(status));
    case 'evicted':
      return dim(status);
    case 'failed':
    case 'canceled':
      return pc.red(status);
    case 'canceling':
      return pc.yellow(status);
    default:
      return status;
  }
}

function formatDeploymentRow(
  d: DeploymentResponse,
  activeDeploymentId: string | null,
): DeploymentRow {
  let manifest: {
    type?: string;
    static?: string;
    framework?: string;
    revalidate?: number;
    pathRevalidate?: Record<string, number>;
  } | null = null;
  if (d.manifest) {
    try {
      manifest = JSON.parse(d.manifest);
    } catch {
      // ignore
    }
  }

  const appType = manifest?.type ?? (manifest?.framework ? 'framework' : 'void');
  const pathRuleCount = Object.keys(manifest?.pathRevalidate ?? {}).length;
  const isr =
    manifest?.revalidate && manifest.revalidate > 0
      ? `${manifest.revalidate}s`
      : pathRuleCount > 0
        ? formatCount(pathRuleCount, 'rule')
        : '-';
  const source = d.source ?? '-';
  const commit = d.commit ? d.commit.slice(0, 7) : '-';

  const statusRaw = computeDisplayStatus(d, activeDeploymentId);
  const statusColored = colorStatus(statusRaw);

  const deployed = d.deployed_at ? formatRelativeTime(d.deployed_at) : '-';

  return { id: d.id, appType, statusRaw, statusColored, source, commit, isr, deployed };
}
