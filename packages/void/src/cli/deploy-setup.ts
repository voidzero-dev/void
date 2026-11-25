import { cancel, confirm, isCancel, log } from '@voidzero-dev/vite-plus-prompts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { promptAndCreateProject } from './create-project.ts';
import { promptForLoginToken } from './login.ts';
import { attachSelectedPlatform, readProjectConfig, writeProjectConfig } from './project.ts';
import type { ProjectConfig } from './project.ts';
import { promptProjectSelection } from './prompt.ts';

export async function maybeSetupDeployProject(root: string): Promise<ProjectConfig | null> {
  const existing = readProjectConfig(root);
  if (existing) {
    log.info(`Project already linked: ${existing.slug}`);
    return existing;
  }

  const existingToken = getToken(root);
  const shouldSetup = await confirm({
    message: existingToken
      ? 'Link your Void project now?'
      : 'Log in now and link or create a Void project?',
  });
  if (isCancel(shouldSetup)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  if (!shouldSetup) {
    return null;
  }

  let token = existingToken;
  if (!token) {
    token = await promptForLoginToken(root);
    log.step('Token saved.');
  }
  const client = new PlatformClient(token, { root });
  const projects = await client.listProjects();

  if (projects.length === 0) {
    return promptAndCreateProject(root, client);
  }

  const result = await promptProjectSelection(projects, 'Select a project to link:', root, {
    confirmExisting: true,
  });
  if (result.action === 'select') {
    const config = { projectId: result.project.id, slug: result.project.slug };
    writeProjectConfig(root, attachSelectedPlatform(config, client.apiUrl));
    log.step(`Linked project: ${config.slug}`);
    return config;
  }

  return promptAndCreateProject(root, client);
}
