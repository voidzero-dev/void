import { readFileSync } from 'node:fs';
import type {
  PlatformRuntime,
  PlatformRuntimeDatabaseManifest,
  PlatformRuntimeManifest,
} from '@void/platform/installer';
import { resolvePlatformRuntime } from '@void/platform/installer';
import { join } from 'pathslash';
import { getErrorMessage } from './output.ts';
import { hash } from './platform-installer-resources.ts';

export function loadPlatformRuntime(customRuntimeDirectory: string): PlatformRuntime {
  const runtime = resolvePlatformRuntime(customRuntimeDirectory || undefined);
  verifyRuntimeArtifacts(runtime.directory, runtime.manifest);
  return runtime;
}

export function verifyRuntimeArtifacts(
  runtimeDirectory: string,
  manifest: PlatformRuntimeManifest,
): void {
  for (const artifact of [
    ...Object.values(manifest.artifacts),
    ...(manifest.assets
      ? [
          manifest.assets.adminClient,
          ...(manifest.assets.adminStyle ? [manifest.assets.adminStyle] : []),
        ]
      : []),
  ]) {
    const path = join(runtimeDirectory, artifact.path);
    let contents: Buffer;
    try {
      contents = readFileSync(path);
    } catch (error) {
      throw new Error(`platform: Runtime artifact is missing: ${getErrorMessage(error)}`, {
        cause: error,
      });
    }
    if (contents.byteLength !== artifact.size || hash(contents) !== artifact.sha256) {
      throw new Error(`platform: Runtime artifact failed integrity verification: ${path}.`);
    }
  }
  verifyPlatformDatabaseArtifacts(runtimeDirectory, manifest.database);
}

export function verifyPlatformDatabaseArtifacts(
  runtimeDirectory: string,
  database: PlatformRuntimeDatabaseManifest,
): void {
  const journalPath = join(runtimeDirectory, 'drizzle', 'meta', '_journal.json');
  let journal: Buffer;
  try {
    journal = readFileSync(journalPath);
  } catch (error) {
    throw new Error(
      `platform: Runtime database migration journal is missing: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (hash(journal) !== database.journalSha256) {
    throw new Error(
      `platform: Runtime database migration journal failed integrity verification: ${journalPath}.`,
    );
  }
  for (const migration of database.migrations) {
    const path = join(runtimeDirectory, 'drizzle', `${migration.tag}.sql`);
    let contents: Buffer;
    try {
      contents = readFileSync(path);
    } catch (error) {
      throw new Error(
        `platform: Runtime database migration is missing: ${getErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (hash(contents) !== migration.sha256) {
      throw new Error(
        `platform: Runtime database migration failed integrity verification: ${path}.`,
      );
    }
  }
}
