import { createHash } from 'node:crypto';
import type { CloudflareTriggerConfig } from '@void/deploy-cloudflare';
import {
  createPlatformResourceOwnershipMarker,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  recordInstallationStep,
} from '@void/platform';
import type { InstallationResource, PlatformInstallationManifest } from '@void/platform';
import { PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY as REMOTE_INSTALLATION_MANIFEST_KEY } from '@void/platform';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
} from './platform-cloudflare.ts';
import type {
  CloudflareNamedResource,
  CloudflareWorkerCustomDomainOrigin,
} from './platform-cloudflare.ts';
import { writePlatformTiming } from './platform-installer-process.ts';
import type {
  PlatformInstallationSecrets,
  PlatformInstallerDependencies,
  InstallationCheckpointWriter,
  InstallerClient,
  PlatformDatabaseLifecycleLock,
  PlatformWorkerConfig,
} from './platform-installer-types.ts';
import {
  dnsRecordConfigHash,
  hasProvisionIntentStep,
  legacyResourceConfigHash,
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
  r2BucketConfigHash,
} from './platform-plan.ts';
import type { PlatformInstallPlan, PlatformInstallPlanAction } from './platform-plan.ts';
import { savePlatformConnection, writeInstallationManifest } from './platform-registry.ts';
import { platformManagedWorkerTraffic } from './platform-traffic.ts';

// Keep the outer installer's failure handler on the latest manifest even when a
// remote create or checkpoint throws partway through this phase.
export async function reconcilePlatformInstallationResources(
  manifest: PlatformInstallationManifest,
  plan: PlatformInstallPlan,
  secrets: PlatformInstallationSecrets,
  zoneId: string,
  externalHyperdriveOriginHash: string | undefined,
  dependencies: PlatformInstallerDependencies,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
  onManifestChange: (manifest: PlatformInstallationManifest) => void,
): Promise<PlatformInstallationManifest> {
  for (const action of plan.actions.filter(
    (entry) => entry.key !== 'routing-kv' && entry.kind !== 'zone' && entry.kind !== 'worker',
  )) {
    const retainedManifest = retainReplacedInstallationResource(manifest, action, now());
    if (retainedManifest !== manifest) {
      manifest = retainedManifest;
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
    if (action.action === 'adopt') {
      if (!action.id) {
        throw new Error(`platform: Adopted ${action.kind} ${action.name} has no id.`);
      }
      manifest = recordAdoptionIntent(manifest, action, action.id, now());
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      manifest = recordResource(
        manifest,
        action,
        action.id,
        'adopted',
        now(),
        secrets.databaseUrl,
        action.kind === 'hyperdrive' ? externalHyperdriveOriginHash : undefined,
      );
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      continue;
    }
    if (action.action === 'reuse') {
      if (
        action.id &&
        (action.kind === 'hyperdrive' ||
          !manifest.resources.some((resource) => resource.key === action.key))
      ) {
        manifest = recordResource(
          manifest,
          action,
          action.id,
          undefined,
          now(),
          secrets.databaseUrl,
          action.kind === 'hyperdrive' ? externalHyperdriveOriginHash : undefined,
        );
        onManifestChange(manifest);
        writeInstallationManifest(manifest);
        await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
        await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
      }
      continue;
    }
    manifest = recordProvisionIntent(manifest, action, now());
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    const resource = await createResource(
      dependencies.client,
      plan,
      action,
      secrets.databaseUrl,
      zoneId,
    );
    manifest = recordResource(
      manifest,
      action,
      resource.id,
      'created',
      now(),
      secrets.databaseUrl,
      action.kind === 'hyperdrive' ? externalHyperdriveOriginHash : resource.fingerprint,
    );
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeR2OwnershipMarkerIfNeeded(dependencies.client, plan, manifest, action);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
  }

  return manifest;
}

async function writeR2OwnershipMarkerIfNeeded(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): Promise<void> {
  if (action.kind !== 'r2-bucket') {
    return;
  }
  const bucket = manifest.resources.find(
    (resource) => resource.key === action.key && resource.state === 'ready',
  );
  if (!bucket || bucket.ownership !== 'created') {
    return;
  }
  await client.putR2Object(
    plan.account.id,
    bucket.name,
    PLATFORM_R2_OWNERSHIP_MARKER_KEY,
    JSON.stringify(
      createPlatformResourceOwnershipMarker({
        accountId: plan.account.id,
        installationId: manifest.id,
        ownershipNonce: manifest.ownershipNonce,
        resourceId: bucket.id,
        resourceKey: bucket.key,
        resourceKind: bucket.kind,
        resourceName: bucket.name,
      }),
    ),
  );
}

export function saveInstalledPlatformConnection(
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
): void {
  savePlatformConnection({
    accountId: plan.account.id,
    apiUrl: plan.apiUrl,
    applicationDomain: plan.deployment.application.baseDomain,
    displayName: plan.deployment.displayName,
    installationId: manifest.id,
    kind: 'installed',
    proxyUrl: plan.proxyUrl,
  });
}

export async function writeRemoteInstallationCheckpointWithoutDatabase(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  databaseLock?: PlatformDatabaseLifecycleLock,
): Promise<void> {
  const startedAt = performance.now();
  await databaseLock?.checkpoint?.(manifest);
  writePlatformTiming('database checkpoint', startedAt);
  const routing = manifest.resources.find(
    (resource) =>
      resource.key === 'routing-kv' &&
      resource.kind === 'kv-namespace' &&
      resource.ownership === 'created' &&
      resource.state === 'ready',
  );
  if (!routing) {
    return;
  }
  const kvStartedAt = performance.now();
  await client.putKvValue(
    plan.account.id,
    routing.id,
    REMOTE_INSTALLATION_MANIFEST_KEY,
    JSON.stringify(manifest),
  );
  writePlatformTiming('remote checkpoint', kvStartedAt);
}

export function recordProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  now: string,
): PlatformInstallationManifest {
  const previousResourceId =
    manifest.resources.find((resource) => resource.key === action.key)?.id ?? null;
  if (hasProvisionIntentStep(manifest, action.key, action.kind, action.name, previousResourceId)) {
    return manifest;
  }
  const resultHash = platformProvisionIntentHash(
    manifest,
    action.key,
    action.kind,
    action.name,
    previousResourceId,
  );
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `provision-intent:${action.key}:${resultHash.slice(0, 16)}`,
      resultHash,
    },
    now,
  );
}

export function recordAdoptionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  now: string,
): PlatformInstallationManifest {
  return recordInstallationStep(
    manifest,
    {
      completedAt: now,
      key: `adoption-intent:${action.key}`,
      resultHash: platformAdoptionIntentHash(manifest, action.key, action.kind, id, action.name),
    },
    now,
  );
}

export function hasProvisionIntent(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
): boolean {
  const previousResourceId =
    manifest.resources.find((resource) => resource.key === action.key)?.id ?? null;
  return hasProvisionIntentStep(manifest, action.key, action.kind, action.name, previousResourceId);
}

export async function createResource(
  client: InstallerClient,
  plan: PlatformInstallPlan,
  action: PlatformInstallPlanAction,
  databaseUrl: string,
  zoneId: string,
): Promise<CloudflareNamedResource> {
  switch (action.kind) {
    case 'ai-gateway':
      return client.createAiGateway(plan.account.id, action.name);
    case 'dns-record':
      return client.createDnsRecord(zoneId, action.name);
    case 'kv-namespace':
      return client.createKvNamespace(plan.account.id, action.name);
    case 'r2-bucket':
      return client.createR2Bucket(plan.account.id, action.name);
    case 'queue':
      return client.createQueue(plan.account.id, action.name);
    case 'dispatch-namespace':
      return client.createDispatchNamespace(plan.account.id, action.name);
    case 'hyperdrive':
      return client.createHyperdrive(plan.account.id, action.name, databaseUrl);
    default:
      throw new Error(`platform: Cannot provision ${action.kind} in the resource phase.`);
  }
}

export function recordResource(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  id: string,
  ownership: InstallationResource['ownership'] | undefined,
  now: string,
  databaseUrl?: string,
  resourceFingerprint?: string,
): PlatformInstallationManifest {
  const previous = manifest.resources.find((resource) => resource.key === action.key);
  return recordInstallationResource(
    manifest,
    {
      configHash:
        action.kind === 'dns-record'
          ? dnsRecordConfigHash(action.name, 'AAAA', '100::', true)
          : action.kind === 'hyperdrive' && resourceFingerprint
            ? resourceFingerprint
            : action.kind === 'hyperdrive' && databaseUrl
              ? hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(databaseUrl))
              : action.kind === 'r2-bucket' && resourceFingerprint
                ? r2BucketConfigHash(action.name, resourceFingerprint)
                : legacyResourceConfigHash(action.kind, action.name),
      id,
      key: action.key,
      kind: action.kind,
      name: action.name,
      ownership: ownership ?? previous?.ownership ?? 'created',
      state: 'ready',
    },
    now,
  );
}

export function retainReplacedInstallationResource(
  manifest: PlatformInstallationManifest,
  action: PlatformInstallPlanAction,
  now: string,
): PlatformInstallationManifest {
  const previous = manifest.resources.find((resource) => resource.key === action.key);
  if (
    action.action !== 'create' ||
    !previous ||
    previous.state !== 'ready' ||
    previous.name === action.name
  ) {
    return manifest;
  }
  const retainedKey = `retained:${action.key}:${hash(previous.id).slice(0, 16)}`;
  const resources = manifest.resources
    .filter((resource) => resource.key !== action.key && resource.key !== retainedKey)
    .concat({ ...previous, key: retainedKey, state: 'retained' as const })
    .sort((left, right) => left.key.localeCompare(right.key));
  return { ...manifest, resources, updatedAt: now };
}

export function validateReplannedWorkerActions(
  original: PlatformInstallPlan,
  manifest: PlatformInstallationManifest,
  actions: ReadonlyArray<PlatformInstallPlanAction>,
): ReadonlyArray<PlatformInstallPlanAction> {
  const expected = original.actions.filter((action) => action.kind === 'worker');
  if (actions.length !== expected.length) {
    throw new Error('platform: Fresh Cloudflare planning did not return every platform Worker.');
  }
  for (const previous of expected) {
    const matches = actions.filter((action) => action.key === previous.key);
    const current = matches[0];
    if (
      matches.length !== 1 ||
      !current ||
      current.kind !== 'worker' ||
      current.name !== previous.name
    ) {
      throw new Error(
        `platform: Fresh Cloudflare planning changed the identity of Worker ${JSON.stringify(previous.name)}.`,
      );
    }
    const resource = manifest.resources.find((entry) => entry.key === current.key);
    if (resource?.state === 'deleted' && current.action !== 'create') {
      throw new Error(
        `platform: Fresh Cloudflare planning did not recreate deleted Worker ${JSON.stringify(current.name)}.`,
      );
    }
  }
  return actions;
}

export async function inventoryUnmanagedPlatformWorkerTraffic(
  client: Pick<InstallerClient, 'listWorkerDomains' | 'listWorkerServiceRoutes'>,
  plan: PlatformInstallPlan,
  workerName: string,
): Promise<ReadonlyArray<unknown>> {
  const [routes, domains] = await Promise.all([
    client.listWorkerServiceRoutes(plan.account.id, workerName),
    client.listWorkerDomains(plan.account.id),
  ]);
  const managed = platformManagedWorkerTraffic(plan.deployment, new Set([workerName]));
  const managedRoutes = new Set(managed.routes.map((route) => route.pattern));
  const managedDomains = new Set(managed.customDomains.map((domain) => domain.hostname));
  return uniqueTriggerRoutes([
    ...routes
      .filter((route) => !managedRoutes.has(route.pattern))
      .map((route) => ({ pattern: route.pattern, zone_name: route.zoneName })),
    ...domains
      .filter((domain) => domain.service === workerName && !managedDomains.has(domain.hostname))
      .map((domain) => ({
        pattern: domain.hostname,
        custom_domain: true,
        ...(domain.zoneName ? { zone_name: domain.zoneName } : {}),
      })),
  ]);
}

export function mergePlatformWorkerTrafficConfig(
  config: PlatformWorkerConfig,
  preservedRoutes: ReadonlyArray<unknown>,
): PlatformWorkerConfig {
  if (preservedRoutes.length === 0) {
    return config;
  }
  return {
    ...config,
    routes: uniqueTriggerRoutes([
      ...(Array.isArray(config.routes) ? (config.routes as Array<unknown>) : []),
      ...preservedRoutes,
    ]),
  };
}

export function mergePreservedTriggerRoutes(
  config: CloudflareTriggerConfig,
  preservedRoutes: ReadonlyArray<unknown>,
): CloudflareTriggerConfig {
  return preservedRoutes.length === 0
    ? config
    : { ...config, routes: uniqueTriggerRoutes([...config.routes, ...preservedRoutes]) };
}

type PlatformWorkerCustomDomains = {
  customDomains: ReadonlyArray<CloudflareWorkerCustomDomainOrigin>;
  wranglerConfig: PlatformWorkerConfig;
};

export function isolatePlatformWorkerCustomDomains(
  config: PlatformWorkerConfig,
): PlatformWorkerCustomDomains {
  if (config.routes === undefined) {
    return { customDomains: [], wranglerConfig: config };
  }
  if (!Array.isArray(config.routes)) {
    throw new Error('platform: Generated Worker routes must be an array.');
  }
  const customDomains: Array<CloudflareWorkerCustomDomainOrigin> = [];
  const wranglerRoutes: Array<unknown> = [];
  for (const route of config.routes) {
    if (
      typeof route !== 'object' ||
      route === null ||
      (route as Record<string, unknown>).custom_domain !== true
    ) {
      wranglerRoutes.push(route);
      continue;
    }
    const entry = route as Record<string, unknown>;
    const hostname = requiredNonEmptyString(entry.pattern, 'Worker Custom Domain hostname');
    customDomains.push({
      hostname,
      ...(entry.zone_id === undefined
        ? {}
        : { zoneId: requiredNonEmptyString(entry.zone_id, `zone id for ${hostname}`) }),
      ...(entry.zone_name === undefined
        ? {}
        : { zoneName: requiredNonEmptyString(entry.zone_name, `zone name for ${hostname}`) }),
      ...(entry.enabled === undefined
        ? {}
        : { enabled: requiredBoolean(entry.enabled, `enabled for ${hostname}`) }),
      ...(entry.previews_enabled === undefined
        ? {}
        : {
            previewsEnabled: requiredBoolean(
              entry.previews_enabled,
              `previews_enabled for ${hostname}`,
            ),
          }),
    });
  }
  return {
    customDomains,
    wranglerConfig: { ...config, routes: wranglerRoutes },
  };
}

export function withoutPlatformWorkerTrafficAttachments(
  config: PlatformWorkerConfig,
): PlatformWorkerConfig {
  const isolated = { ...config };
  delete isolated.route;
  delete isolated.routes;
  return isolated;
}

export function withoutPlatformCustomDomainTriggers(
  config: CloudflareTriggerConfig,
): CloudflareTriggerConfig {
  return {
    ...config,
    routes: config.routes.filter(
      (route) =>
        typeof route !== 'object' ||
        route === null ||
        (route as Record<string, unknown>).custom_domain !== true,
    ),
  };
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`platform: ${field} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`platform: ${field} must be a boolean.`);
  }
  return value;
}

function uniqueTriggerRoutes(routes: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = JSON.stringify(route);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function requireId(ids: Record<string, string>, key: string): string {
  const id = ids[key];
  if (!id) {
    throw new Error(`platform: Installation manifest is missing ${key}.`);
  }
  return id;
}
