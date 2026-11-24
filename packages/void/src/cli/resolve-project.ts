import { readFileSync } from 'node:fs';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { join } from 'pathslash';
import type { PlatformClient, ProjectResponse } from './client.ts';
import { readProjectConfig, type ProjectConfig } from './project.ts';

export function getRequestedProjectSlug(options?: { projectSlug?: string }): string | null {
  const cliSlug = options?.projectSlug?.trim();
  if (cliSlug) {
    return cliSlug;
  }

  const envSlug = process.env.VOID_PROJECT?.trim();
  if (envSlug) {
    return envSlug;
  }

  return null;
}

export function resolveProjectBySlug(
  projects: Array<ProjectResponse>,
  slug: string,
): ProjectConfig | null {
  const project = projects.find((candidate) => candidate.slug === slug);
  return project ? { projectId: project.id, slug: project.slug } : null;
}

export async function requireProjectBySlug(
  client: Pick<PlatformClient, 'listProjects'>,
  slug: string,
): Promise<ProjectConfig> {
  const project = resolveProjectBySlug(await client.listProjects(), slug);
  if (!project) {
    throw new Error(`project: No project found with slug '${slug}'.`);
  }
  return project;
}

/** Resolves --project, then VOID_PROJECT, then the linked project; exits with an error otherwise. */
export async function resolveCommandProjectId(
  client: Pick<PlatformClient, 'listProjects'>,
  root: string,
  projectSlug: string | undefined,
): Promise<string> {
  const requestedSlug = projectSlug ?? process.env.VOID_PROJECT?.trim();
  if (requestedSlug) {
    const project = resolveProjectBySlug(await client.listProjects(), requestedSlug);
    if (!project) {
      log.error(`project: No project found with slug '${requestedSlug}'.`);
      process.exit(1);
    }
    return project.projectId;
  }
  const config = readProjectConfig(root);
  if (!config) {
    log.error('No linked project. Run `void project link` or pass --project <name>.');
    process.exit(1);
  }
  return config.projectId;
}

export function inferDefaultSlug(root: string): string {
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const name: string = pkg.name ?? 'my-app';
  return name.replace(/^@[^/]+\//, '').replaceAll(/[^a-z0-9-]/g, '-');
}
