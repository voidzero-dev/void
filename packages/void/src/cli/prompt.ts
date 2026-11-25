import { select, text, isCancel, cancel, confirm } from '@voidzero-dev/vite-plus-prompts';
import { getSiteDomain } from './auth.ts';
import type { ProjectResponse } from './client.ts';
import { validateProjectSlug } from './project-slug.ts';

type SelectResult = {
  action: 'select';
  project: ProjectResponse;
};

type CreateResult = {
  action: 'create';
};

export type PromptResult = SelectResult | CreateResult;
export type ProjectSetupAction = 'create' | 'link';

export async function promptProjectSetupAction(
  message = 'Set up a Void project:',
  options: { includeLink?: boolean; link?: boolean } = {},
): Promise<ProjectSetupAction> {
  const result = await select({
    message,
    options: [
      { value: 'create', label: 'Create a new project' },
      ...(options.includeLink === false
        ? []
        : [
            {
              value: 'link',
              label:
                options.link === false ? 'Use an existing project' : 'Link an existing project',
            },
          ]),
    ],
  });

  if (isCancel(result) || typeof result === 'symbol') {
    cancel('Deploy cancelled.');
    process.exit(0);
  }

  return result as ProjectSetupAction;
}

export async function promptProjectSelection(
  projects: Array<ProjectResponse>,
  message = 'Select a project:',
  root: string = process.cwd(),
  options: { confirmExisting?: boolean; includeCreate?: boolean; link?: boolean } = {},
): Promise<PromptResult> {
  const choices = [
    ...(options.includeCreate === false
      ? []
      : [{ value: '__create__', label: 'Create new project' }]),
    ...projects.map((p) => ({
      value: p.id,
      label: `${p.slug} (${p.url ?? `${p.slug}.${getSiteDomain(root)}`})`,
      hint: p.role === 'reader' ? 'reader (read-only)' : p.role,
    })),
  ];

  const result = await select({
    message,
    options: choices,
  });

  if (isCancel(result)) {
    cancel('Deploy cancelled.');
    process.exit(0);
  }

  if (result === '__create__') {
    return { action: 'create' };
  }

  const project = projects.find((p) => p.id === result);
  if (!project) {
    throw new Error('The selected project is unavailable.');
  }
  if (options.confirmExisting) {
    const confirmed = await confirm({
      message:
        project.role === 'reader'
          ? `Link to ${project.slug} with read-only access? Deploying requires collaborator access or higher.`
          : (options.link === false
              ? 'This deployment will overwrite the current deployment of '
              : `Linking to an existing project. Running \`void deploy\` will overwrite the current deployment of `) +
            `${project.url ?? `${project.slug}.${getSiteDomain(root)}`}. Continue?`,
    });
    if (isCancel(confirmed) || !confirmed) {
      cancel('Project link cancelled.');
      process.exit(0);
    }
  }
  return { action: 'select', project };
}

export async function promptProjectSlug(defaultSlug: string): Promise<string> {
  const result = await text({
    message: 'Choose a slug for your new Void project:',
    placeholder: defaultSlug,
    defaultValue: defaultSlug,
    validate: (value) => validateProjectSlug(value || defaultSlug),
  });

  if (isCancel(result) || typeof result === 'symbol') {
    cancel('Deploy cancelled.');
    process.exit(0);
  }

  return result.trim();
}
