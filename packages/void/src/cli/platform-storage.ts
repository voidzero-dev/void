import { isR2LocationHint, R2_LOCATION_HINTS } from '@void/deploy-core';
import type { R2LocationHint } from '@void/deploy-core';
import type { PlatformDeploymentManifest } from '@void/platform';

export type PlatformStorageLocation = R2LocationHint | 'automatic';

export function parsePlatformStorageLocation(value: string): PlatformStorageLocation {
  if (value !== 'automatic' && !isR2LocationHint(value)) {
    throw new Error(
      `platform: --storage-location must be automatic or one of: ${R2_LOCATION_HINTS.join(', ')}.`,
    );
  }
  return value;
}

export function assertPlatformStorageSupported(
  deployment: PlatformDeploymentManifest,
  runtime: Readonly<{ storageLocationHint?: 1 }>,
): void {
  if (deployment.storageLocationHint && runtime.storageLocationHint !== 1) {
    throw new Error(
      'platform: This runtime cannot apply the storage location hint. Use a current platform runtime, or run `void platform upgrade --storage-location automatic` first.',
    );
  }
}
