import { createHash } from 'node:crypto';
import { createApplicationRoutes, recordInstallationResource } from '@void/platform';
import type {
  InstallationResource,
  PlatformDeploymentManifest,
  PlatformInstallationManifest,
} from '@void/platform';
import type {
  CloudflareWorkerDomain,
  CloudflareWorkerRoute,
  PlatformManagedWorkerTraffic,
} from './platform-cloudflare.ts';

export function platformManagedWorkerTraffic(
  deployment: PlatformDeploymentManifest,
  workers?: ReadonlySet<string>,
): PlatformManagedWorkerTraffic {
  const includes = (worker: string) => workers === undefined || workers.has(worker);
  const names = deployment.resources;
  const customDomains: Array<{ hostname: string; service: string }> = [];
  if (deployment.controlPlane.apiHostname && includes(names.apiWorker)) {
    customDomains.push({
      hostname: deployment.controlPlane.apiHostname,
      service: names.apiWorker,
    });
  }
  if (deployment.controlPlane.proxyHostname && includes(names.proxyWorker)) {
    customDomains.push({
      hostname: deployment.controlPlane.proxyHostname,
      service: names.proxyWorker,
    });
  }
  return {
    customDomains,
    routes: includes(names.dispatchWorker)
      ? createApplicationRoutes(deployment.application).map((route) => ({
          pattern: route.pattern,
          script: names.dispatchWorker,
        }))
      : [],
  };
}

function trafficConfigHash(kind: 'worker-custom-domain' | 'worker-route', value: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, value })).digest('hex');
}

/**
 * The installer Worker that a recorded route or custom domain serves, when the
 * record matches exactly what the installer publishes for this deployment.
 */
export function platformTrafficAttachmentWorker(
  deployment: PlatformDeploymentManifest,
  resource: Pick<InstallationResource, 'configHash' | 'kind' | 'name'>,
): string | null {
  const managed = platformManagedWorkerTraffic(deployment);
  if (resource.kind === 'worker-route') {
    const target = managed.routes.find((route) => route.pattern === resource.name);
    return target && trafficConfigHash('worker-route', target) === resource.configHash
      ? target.script
      : null;
  }
  if (resource.kind === 'worker-custom-domain') {
    const target = managed.customDomains.find((domain) => domain.hostname === resource.name);
    return target && trafficConfigHash('worker-custom-domain', target) === resource.configHash
      ? target.service
      : null;
  }
  return null;
}

export function recordPlatformWorkerTraffic(
  manifest: PlatformInstallationManifest,
  workerName: string,
  inventory: Readonly<{
    customDomains: ReadonlyArray<CloudflareWorkerDomain>;
    routes: ReadonlyArray<CloudflareWorkerRoute>;
  }>,
  updatedAt: string,
): PlatformInstallationManifest {
  const desired = platformManagedWorkerTraffic(manifest.deployment, new Set([workerName]));
  let next = manifest;
  for (const target of desired.routes) {
    const matches = inventory.routes.filter(
      (route) => route.pattern === target.pattern && route.script === target.script,
    );
    if (matches.length !== 1) {
      throw new Error(
        `platform: Expected exactly one published Worker route for ${JSON.stringify(target.pattern)} and ${JSON.stringify(target.script)}.`,
      );
    }
    const route = matches[0]!;
    next = recordInstallationResource(
      next,
      {
        configHash: trafficConfigHash('worker-route', target),
        id: route.id,
        key: `worker-route:${route.id}`,
        kind: 'worker-route',
        name: route.pattern,
        ownership: 'external',
        state: 'retained',
      },
      updatedAt,
    );
  }
  for (const target of desired.customDomains) {
    const matches = inventory.customDomains.filter(
      (domain) => domain.hostname === target.hostname && domain.service === target.service,
    );
    if (matches.length !== 1) {
      throw new Error(
        `platform: Expected exactly one published Worker custom domain for ${JSON.stringify(target.hostname)} and ${JSON.stringify(target.service)}.`,
      );
    }
    const domain = matches[0]!;
    next = recordInstallationResource(
      next,
      {
        configHash: trafficConfigHash('worker-custom-domain', target),
        id: domain.id,
        key: `worker-custom-domain:${domain.id}`,
        kind: 'worker-custom-domain',
        name: domain.hostname,
        ownership: 'external',
        state: 'retained',
      },
      updatedAt,
    );
  }
  return next;
}
