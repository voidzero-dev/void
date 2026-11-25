import {
  platformProjectWorkersDevHostname,
  platformWorkersDevAliasKey,
  readPlatformApplication,
} from '@void/platform';
import { readProjectAlias } from '@voidcloud/api/routing-records';
import type { Env } from './env.ts';
import { extractSlug } from './hostname.ts';

export async function resolveProjectHostname(
  hostname: string,
  env: Env,
): Promise<{ slug: string | null; projectId?: string; workersDev: boolean }> {
  const application = readPlatformApplication(env);
  const isWorkersDev =
    !!application.workersDev &&
    hostname.endsWith(`.${application.workersDev.subdomain}.workers.dev`);
  if (!isWorkersDev) {
    return { slug: extractSlug(hostname, env.BASE_HOSTNAME), workersDev: false };
  }
  const raw = await env.ROUTING.get(platformWorkersDevAliasKey(hostname));
  const project = raw ? readProjectAlias(raw) : null;
  if (project) {
    try {
      if (platformProjectWorkersDevHostname(project, application.workersDev) === hostname) {
        return { slug: project.slug, projectId: project.id, workersDev: true };
      }
    } catch {
      // The alias can survive a project identity change or a malformed write.
    }
  }
  return { slug: null, workersDev: true };
}

/** workers.dev has no operator-owned zone to purge. Retain shared ISR and omit this edge layer. */
function isTestHostname(request: RequestInfo | URL): boolean {
  return new URL(
    typeof request === 'string' || request instanceof URL ? request : request.url,
  ).hostname.endsWith('.workers.dev');
}

export const applicationEdgeCache: Cache = {
  async match(request, options) {
    return isTestHostname(request) ? undefined : caches.default.match(request, options);
  },
  async put(request, response) {
    if (!isTestHostname(request)) {
      await caches.default.put(request, response);
    }
  },
  async delete(request, options) {
    return isTestHostname(request) ? false : caches.default.delete(request, options);
  },
};
