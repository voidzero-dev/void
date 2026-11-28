import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { log, text, isCancel, cancel } from './interactive-prompts.ts';
import { printSuccess, createSpinner, note } from './output.ts';
import { readProjectConfig, removeProjectConfig } from './project.ts';
import { resolveProjectBySlug } from './resolve-project.ts';

export async function runDeleteCommand(
  root: string,
  slug?: string,
  options?: { force?: boolean },
): Promise<void> {
  console.log();

  const token = getToken(root);
  if (!token) {
    log.error('Not logged in. Run `void account login` first.');
    process.exit(1);
  }

  const client = new PlatformClient(token, { root });

  // Resolve project: positional arg, or fall back to linked project
  let projectId: string;
  let projectSlug: string;

  if (slug) {
    const projects = await client.listProjects();
    const config = resolveProjectBySlug(projects, slug);
    if (!config) {
      log.error(`project: No project found with slug '${slug}'.`);
      process.exit(1);
    }
    projectId = config.projectId;
    projectSlug = config.slug;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      log.error('No linked project found. Pass a project name: void project delete <name>');
      process.exit(1);
    }
    projectId = config.projectId;
    projectSlug = config.slug;
  }

  if (!options?.force) {
    note(
      [
        'Worker deployments',
        'D1 databases, KV namespaces, R2 buckets',
        'Static assets',
        'Deployment history',
      ].join('\n'),
      `Deleting ${projectSlug} will permanently remove`,
    );

    const confirmation = await text({
      message: `Type "${projectSlug}" to confirm deletion:`,
      validate(value) {
        if (value !== projectSlug) {
          return `Please type "${projectSlug}" exactly to confirm.`;
        }
      },
    });

    if (isCancel(confirmation)) {
      cancel('Delete cancelled.');
      process.exit(0);
    }
  }

  const s = createSpinner();
  s.start('Deleting project...');

  const result = await client.deleteProject(projectId);

  s.clear();

  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      log.warn(warning);
    }
  }

  const localConfig = readProjectConfig(root);
  if (localConfig?.projectId === projectId) {
    removeProjectConfig(root);
    log.step('Removed local .void/project.json');
  }

  printSuccess(`Deleted ${projectSlug}`);
}
