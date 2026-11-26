import type { InstallationResource } from '@void/platform';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';

/** Slots kept free for operators, migrations, and other direct database clients. */
export const PLATFORM_DIRECT_CONNECTION_RESERVE = 5;
/** Cloudflare does not accept an origin connection limit below this. */
const HYPERDRIVE_MIN_ORIGIN_CONNECTIONS = 5;

/** The Hyperdrive origin limit that leaves the direct-connection reserve free. */
export function platformHyperdriveConnectionLimit(connectionSlots: number): number {
  return Math.max(
    HYPERDRIVE_MIN_ORIGIN_CONNECTIONS,
    connectionSlots - PLATFORM_DIRECT_CONNECTION_RESERVE,
  );
}

/**
 * Hyperdrive's default origin limit can exceed what a small database accepts. Once the
 * pool fills every slot, direct connections (upgrade, repair, `psql`) fail with 53300.
 * Lower the limit on the Hyperdrive this installation created; only warn for an adopted one,
 * which its owner manages. Never raise a limit, so the value stays within the account plan.
 */
export async function fitPlatformHyperdriveToDatabase(input: {
  readonly client: Pick<
    PlatformCloudflareClient,
    'getHyperdriveConfig' | 'setHyperdriveOriginConnectionLimit'
  >;
  readonly accountId: string;
  readonly resource: InstallationResource;
  readonly readConnectionSlots: (() => Promise<number>) | undefined;
  readonly onProgress?: (message: string) => void;
}): Promise<void> {
  const { client, accountId, resource, readConnectionSlots, onProgress } = input;
  if (!readConnectionSlots || resource.kind !== 'hyperdrive') {
    return;
  }
  const connectionSlots = await readConnectionSlots();
  const limit = platformHyperdriveConnectionLimit(connectionSlots);
  const current = (await client.getHyperdriveConfig(accountId, resource.id)).originConnectionLimit;
  if (current === undefined || current <= limit) {
    return;
  }
  if (resource.ownership !== 'created') {
    onProgress?.(
      `Warning: Hyperdrive ${resource.name} may open ${current} database connections, but the database accepts ${connectionSlots}. Set its origin connection limit to ${limit} or lower so upgrades and other direct connections can still connect.`,
    );
    return;
  }
  onProgress?.(
    `Lowering the Hyperdrive origin connection limit from ${current} to ${limit} to fit the database's ${connectionSlots} connections`,
  );
  await client.setHyperdriveOriginConnectionLimit(accountId, resource.id, limit);
}
