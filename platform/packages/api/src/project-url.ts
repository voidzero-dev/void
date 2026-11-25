import { platformProjectHostname, readPlatformApplication } from '@void/platform';
import type { PlatformApplicationProject } from '@void/platform';
import type { ApiEnv } from './env.ts';

export function projectUrl(project: PlatformApplicationProject, env: ApiEnv['Bindings']): string {
  return `https://${platformProjectHostname(project, readPlatformApplication(env))}`;
}

export function projectWithUrl<T extends PlatformApplicationProject>(
  project: T,
  env: ApiEnv['Bindings'],
): T & { url?: string } {
  return env.PLATFORM_APPLICATION ? { ...project, url: projectUrl(project, env) } : project;
}
