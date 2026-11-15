import type { InstallationResource } from '@void/platform';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  hyperdriveOriginLocationMatches,
  hyperdriveOriginMatches,
  type CloudflareHyperdriveConfig,
  type CloudflareHyperdriveOriginLocation,
  type PlatformCloudflareClient,
} from './platform-cloudflare.ts';
import type { PlatformExternalHyperdrive } from './platform-plan.ts';

/** Restore the selected external origin before an adoption receipt exists. */
export function readPlatformHyperdriveSelection(
  checkpoint: Readonly<Record<string, string>> | null,
): PlatformExternalHyperdrive | undefined {
  if (!checkpoint?.externalHyperdriveJson) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(checkpoint.externalHyperdriveJson);
  } catch {
    throw new Error('platform: The saved Hyperdrive selection is invalid.');
  }
  return parsePlatformHyperdriveSelection(value);
}

export function parsePlatformHyperdriveSelection(value: unknown): PlatformExternalHyperdrive {
  const selected = value as Partial<PlatformExternalHyperdrive> | null;
  const nonempty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== '';
  if (
    !selected ||
    typeof selected !== 'object' ||
    Array.isArray(selected) ||
    !nonempty(selected.id) ||
    (nonempty(selected.serviceId)
      ? selected.host !== undefined
      : selected.serviceId !== undefined || !nonempty(selected.host)) ||
    !nonempty(selected.user) ||
    (selected.name !== undefined && (typeof selected.name !== 'string' || !selected.name)) ||
    (selected.database !== undefined &&
      (typeof selected.database !== 'string' || !selected.database))
  ) {
    throw new Error('platform: The saved Hyperdrive selection is invalid.');
  }
  return {
    id: selected.id,
    ...(selected.serviceId !== undefined
      ? { serviceId: selected.serviceId }
      : { host: selected.host! }),
    user: selected.user,
    ...(selected.name ? { name: selected.name } : {}),
    ...(selected.database ? { database: selected.database } : {}),
  };
}

/** Read the database name from an owner URL without applying Hyperdrive origin restrictions. */
export function platformDatabaseNameFromOwnerUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('platform: DATABASE_URL must be a PostgreSQL connection string.');
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
    throw new Error('platform: DATABASE_URL must use postgres:// or postgresql://.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error('platform: DATABASE_URL must include a database.');
  }
  return database;
}

/** Pin an externally managed Hyperdrive without treating the owner URL as its runtime origin. */
export function verifyExternalPlatformHyperdrive(input: {
  config: CloudflareHyperdriveConfig;
  databaseUrl?: string;
  expected: CloudflareHyperdriveOriginLocation & {
    id: string;
    name?: string;
    database?: string;
    user: string;
  };
  recordedHash?: string;
}): string {
  const { config, expected } = input;
  const database =
    input.databaseUrl === undefined
      ? undefined
      : platformDatabaseNameFromOwnerUrl(input.databaseUrl);
  const hash = hyperdriveOriginConfigHash(config.origin);
  if (
    config.id !== expected.id ||
    (expected.name !== undefined && config.name !== expected.name) ||
    !hyperdriveOriginLocationMatches(config.origin, expected) ||
    config.origin.user !== expected.user ||
    (database !== undefined && config.origin.database !== database) ||
    (expected.database !== undefined && config.origin.database !== expected.database) ||
    (input.recordedHash && input.recordedHash !== hash)
  ) {
    throw new Error(
      'platform: The externally managed Hyperdrive does not match the expected database origin.',
    );
  }
  if (config.cachingDisabled !== true) {
    throw new Error(
      'platform: Disable SQL result caching on the externally managed Hyperdrive before installing.',
    );
  }
  return hash;
}

/** Authentication requires fresh reads; mutate only the installation-owned configuration. */
export async function verifyPlatformAuthenticationDatabase(
  client: Pick<PlatformCloudflareClient, 'getHyperdriveConfig' | 'disableHyperdriveCaching'>,
  accountId: string,
  resource: InstallationResource,
  databaseUrl: string,
): Promise<void> {
  if (
    resource.kind !== 'hyperdrive' ||
    resource.key !== 'hyperdrive' ||
    resource.state !== 'ready'
  ) {
    throw new Error(
      'platform: Authentication database verification requires the platform Hyperdrive resource.',
    );
  }
  const expectedDatabase =
    resource.ownership === 'adopted' ? platformDatabaseNameFromOwnerUrl(databaseUrl) : undefined;
  const expectedOrigin =
    resource.ownership !== 'adopted'
      ? hyperdriveOriginFromConnectionString(databaseUrl)
      : undefined;
  const read = async () => {
    const current = await client.getHyperdriveConfig(accountId, resource.id);
    if (
      current.id !== resource.id ||
      current.name !== resource.name ||
      (resource.ownership === 'adopted'
        ? current.origin.database !== expectedDatabase ||
          hyperdriveOriginConfigHash(current.origin) !== resource.configHash
        : expectedOrigin === undefined || !hyperdriveOriginMatches(current.origin, expectedOrigin))
    ) {
      throw new Error(
        'platform: Hyperdrive does not match this installation’s pinned database. No authentication configuration was activated.',
      );
    }
    return current;
  };
  if ((await read()).cachingDisabled === true) {
    return;
  }
  if (resource.ownership !== 'created') {
    throw new Error(
      'platform: The adopted Hyperdrive must have SQL result caching disabled by its owner before authentication can be configured.',
    );
  }
  await client.disableHyperdriveCaching(accountId, resource.id);
  if ((await read()).cachingDisabled !== true) {
    throw new Error(
      'platform: Could not verify uncached Hyperdrive reads. Authentication setup remains closed.',
    );
  }
}
