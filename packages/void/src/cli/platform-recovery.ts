import { parsePlatformInstallationManifest, setInstallationEndpoints } from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';
import { REMOTE_INSTALLATION_MANIFEST_KEY } from './platform-installer.ts';
import {
  isPlatformManifestMonotonicExtension,
  recoverDurablyMarkedProvisionIntents,
  verifyPlatformInstallationOwnership,
} from './platform-management.ts';
import { createPlatformInstallPlan } from './platform-plan.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  listInstallationManifests,
  savePlatformConnection,
  writeInstallationManifest,
} from './platform-registry.ts';

type RecoveryClient = Pick<
  PlatformCloudflareClient,
  | 'findZone'
  | 'findZoneForHostname'
  | 'getHyperdriveConfig'
  | 'getKvValue'
  | 'getR2Object'
  | 'getWorkerPlainTextBindings'
  | 'getWorkersSubdomain'
  | 'hasActiveCertificateForHostname'
  | 'listAccounts'
  | 'listAiGateways'
  | 'listDispatchNamespaces'
  | 'listDnsRecords'
  | 'listHyperdriveConfigs'
  | 'listKvNamespaces'
  | 'listQueues'
  | 'listR2Buckets'
  | 'listWorkerNames'
  | 'listWorkerDomains'
  | 'listWorkerRoutes'
>;

export async function recoverPlatformInstallations(
  client: RecoveryClient,
  accountId: string,
  verifyEndpoint: (
    manifest: PlatformInstallationManifest,
  ) => Promise<void> = verifyInstallationEndpoint,
  selector = '',
): Promise<ReadonlyArray<PlatformInstallationManifest>> {
  // The routing namespace is the durable recovery root. Interrupted creates
  // can intentionally move it to a deterministic `-retry-*` name, and future
  // naming changes must not make an otherwise valid installation invisible.
  // The reserved manifest key plus the manifest's exact id/name binding is the
  // authoritative discriminator, not a human-readable namespace suffix.
  const namespaces = await client.listKvNamespaces(accountId);
  const recovered: Array<{
    manifest: PlatformInstallationManifest;
    plan: PlatformInstallPlan;
  }> = [];
  for (const namespace of namespaces) {
    const value = await client.getKvValue(
      accountId,
      namespace.id,
      REMOTE_INSTALLATION_MANIFEST_KEY,
    );
    if (value === null) {
      continue;
    }
    let manifest: PlatformInstallationManifest;
    try {
      manifest = parsePlatformInstallationManifest(JSON.parse(value) as unknown);
    } catch (error) {
      throw new Error(
        `platform: Routing namespace ${namespace.name} contains invalid Void ownership metadata: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (
      selector &&
      manifest.id !== selector &&
      manifest.deployment.installationSlug !== selector &&
      manifest.deployment.displayName.toLowerCase() !== selector.toLowerCase()
    ) {
      continue;
    }
    const routing = manifest.resources.find((resource) => resource.key === 'routing-kv');
    if (
      manifest.account.id !== accountId ||
      routing?.kind !== 'kv-namespace' ||
      routing.id !== namespace.id ||
      routing.name !== namespace.name ||
      routing.ownership !== 'created' ||
      routing.state !== 'ready'
    ) {
      throw new Error(
        `platform: Routing namespace ${namespace.name} does not match its ownership manifest.`,
      );
    }
    if (manifest.status === 'uninstalled') {
      continue;
    }
    manifest = await recoverDurablyMarkedProvisionIntents(client, manifest);
    const deployment = manifest.deployment;
    const plan = await createPlatformInstallPlan(
      client,
      {
        accountId,
        applicationDomain: deployment.application.baseDomain,
        controlPlaneDomain: deployment.controlPlane.apiHostname ?? '',
        dedicatedZone: deployment.application.dedicatedZone,
        displayName: deployment.displayName,
        installationSlug: deployment.installationSlug,
        zoneName: deployment.application.zoneName,
      },
      manifest,
      { repairMissing: true },
    );
    manifest = reconcileRecoveredEndpoints(manifest, plan);
    await verifyPlatformInstallationOwnership(client, manifest);
    const requiresRepair = plan.actions.some((action) => action.action === 'create');
    if (!requiresRepair && manifest.desiredState === 'enabled' && manifest.status === 'installed') {
      await verifyEndpoint(manifest);
    }
    recovered.push({ manifest, plan });
  }

  const resolved: Array<PlatformInstallationManifest> = [];
  for (const { manifest: recoveredManifest, plan } of recovered) {
    let manifest = recoveredManifest;
    const release = acquirePlatformLifecycleLock(
      manifest.account.id,
      manifest.deployment.installationSlug,
    );
    try {
      const collision = listInstallationManifests().find((entry) => entry.id === manifest.id);
      if (
        collision &&
        (collision.account.id !== manifest.account.id ||
          collision.ownershipNonce !== manifest.ownershipNonce)
      ) {
        throw new Error(`platform: Local installation ${manifest.id} has conflicting ownership.`);
      }
      if (collision && JSON.stringify(collision) !== JSON.stringify(manifest)) {
        if (isPlatformManifestMonotonicExtension(manifest, collision)) {
          await verifyPlatformInstallationOwnership(client, collision);
          manifest = collision;
        } else if (!isPlatformManifestMonotonicExtension(collision, manifest)) {
          throw new Error(
            `platform: Local installation ${manifest.id} differs from its remote checkpoint. Resolve or remove the local record before discovery; it was not overwritten.`,
          );
        }
      }
      manifest = reconcileRecoveredEndpoints(manifest, plan);
      if (!collision || JSON.stringify(collision) !== JSON.stringify(manifest)) {
        writeInstallationManifest(manifest);
      }
      if (manifest.endpoints.apiUrl !== null && manifest.endpoints.proxyUrl !== null) {
        savePlatformConnection({
          accountId: manifest.account.id,
          apiUrl: manifest.endpoints.apiUrl,
          applicationDomain: manifest.deployment.application.baseDomain,
          displayName: manifest.deployment.displayName,
          installationId: manifest.id,
          kind: 'installed',
          proxyUrl: manifest.endpoints.proxyUrl,
        });
      }
      resolved.push(manifest);
    } finally {
      release();
    }
  }
  return resolved;
}

function reconcileRecoveredEndpoints(
  manifest: PlatformInstallationManifest,
  plan: PlatformInstallPlan,
): PlatformInstallationManifest {
  if (manifest.endpoints.apiUrl !== null && manifest.endpoints.apiUrl !== plan.apiUrl) {
    throw new Error(`platform: Installation ${manifest.id} has inconsistent API metadata.`);
  }
  if (manifest.endpoints.proxyUrl !== null && manifest.endpoints.proxyUrl !== plan.proxyUrl) {
    throw new Error(`platform: Installation ${manifest.id} has inconsistent proxy metadata.`);
  }
  if (manifest.endpoints.apiUrl !== null && manifest.endpoints.proxyUrl === null) {
    return setInstallationEndpoints(
      manifest,
      { ...manifest.endpoints, proxyUrl: plan.proxyUrl },
      manifest.updatedAt,
    );
  }
  return manifest;
}

export async function verifyInstallationEndpoint(
  manifest: PlatformInstallationManifest,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const apiUrl = manifest.endpoints.apiUrl;
  if (!apiUrl) {
    throw new Error(`platform: Installation ${manifest.id} has no API endpoint.`);
  }
  const response = await fetcher(`${apiUrl}/.well-known/void-platform`, {
    headers: {
      Accept: 'application/json',
      ...cfAccessHeaders(process.env, apiUrl),
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error(
      `platform: Installation ${manifest.id} is not reachable (HTTP ${response.status}).`,
    );
  }
  const value = (await response.json()) as { installationId?: unknown };
  if (value.installationId !== manifest.id) {
    throw new Error(`platform: Installation ${manifest.id} endpoint identity does not match.`);
  }
}
