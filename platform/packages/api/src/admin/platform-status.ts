import { parsePlatformInstallationManifest } from '@void/platform';
import type { InstallationStatus, PlatformLifecycleOperation } from '@void/platform';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ApiEnv } from '../env.ts';

export type PlatformStatusSnapshot = Readonly<{
  checkedAt: string;
  traffic: 'paused' | 'enabled';
  checkpoint: Readonly<{
    status: InstallationStatus;
    platformVersion: string;
    updatedAt: string;
    operation: PlatformLifecycleOperation | null;
  }> | null;
}>;

/** Project only display fields from the installer-owned authoritative checkpoint. */
export async function readPlatformStatus(
  context: Context<ApiEnv>,
): Promise<PlatformStatusSnapshot> {
  let checkpoint: PlatformStatusSnapshot['checkpoint'] = null;
  if (context.env.PLATFORM_INSTALLATION_ID) {
    const rows = await context.get('db').execute<{ lifecycle_manifest: unknown }>(sql`
      SELECT lifecycle_manifest FROM public.__void_platform_installation
      WHERE singleton = true AND installation_id = ${context.env.PLATFORM_INSTALLATION_ID}
    `);
    if (!rows.rows[0]) {
      throw new Error('Installation checkpoint unavailable.');
    }
    const manifest = parsePlatformInstallationManifest(rows.rows[0].lifecycle_manifest);
    if (manifest.id !== context.env.PLATFORM_INSTALLATION_ID) {
      throw new Error('Installation checkpoint identity mismatch.');
    }
    checkpoint = {
      status: manifest.status,
      platformVersion: manifest.platformVersion,
      updatedAt: manifest.updatedAt,
      operation: manifest.operation ?? null,
    };
  }
  return {
    checkedAt: new Date().toISOString(),
    traffic: context.get('platformTrafficPaused') ? 'paused' : 'enabled',
    checkpoint,
  };
}
