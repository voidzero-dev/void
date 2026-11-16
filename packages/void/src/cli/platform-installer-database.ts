import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  parsePlatformInstallationManifest,
  recordInstallationStep,
  type PlatformInstallationManifest,
  parsePlatformAccessProtection,
  type PlatformLoginKind,
} from '@void/platform';
import type {
  PlatformRuntimeDatabaseManifest,
  PlatformRuntimeManifest,
} from '@void/platform/installer';
import { platformDatabaseSchemaDigest } from '@void/platform/installer';
import { join } from 'pathslash';
import type { Pool } from 'pg';
import { projectPlatformAiLoggingConnection } from './platform-ai-logging-projection.ts';
import { verifyPlatformDatabaseArtifacts } from './platform-installer-runtime.ts';
import {
  type PlatformAdministratorSetupState,
  type PlatformInstallerDependencies,
  type PlatformDatabaseLifecycleLock,
  type InstallationCheckpointWriter,
  type PlatformDatabaseState,
  type PlatformDatabaseMigrationResult,
  type PlatformSandboxDrainPreparation,
} from './platform-installer-types.ts';
import { type PlatformInstallPlan } from './platform-plan.ts';
import { writeInstallationManifest } from './platform-registry.ts';
import {
  fencePlatformProjectZeroTrustConnection,
  liftPlatformProjectZeroTrustFenceConnection,
  lockPlatformProjectZeroTrustConnection,
  readPlatformProjectZeroTrustStateConnection,
  type PlatformProjectZeroTrustState,
  type QueryConnection,
} from './platform-zero-trust-uninstall.ts';

// onManifestChange keeps migration checkpoints visible to the outer failure handler.
export async function preparePlatformDatabaseSchema(
  manifest: PlatformInstallationManifest,
  runtime: PlatformRuntimeManifest,
  runtimeDirectory: string,
  sourcePlatformVersion: string | null,
  hadPriorWorkers: boolean,
  plan: PlatformInstallPlan,
  dependencies: PlatformInstallerDependencies,
  releaseDatabaseLock: PlatformDatabaseLifecycleLock,
  now: () => string,
  writeRemoteInstallationCheckpoint: InstallationCheckpointWriter,
  onManifestChange: (manifest: PlatformInstallationManifest) => void,
): Promise<PlatformInstallationManifest> {
  dependencies.onProgress?.('Checking the platform database schema');
  const rollbackDatabase = dependencies.databaseRollbackSource;
  const migrationStep = `database-schema:${runtime.database.schemaDigest}`;
  if (rollbackDatabase) {
    const verifyDatabase = releaseDatabaseLock.verifyDatabase;
    if (!verifyDatabase) {
      throw new Error(
        'platform: The PostgreSQL lifecycle lock cannot verify the forward-only rollback schema.',
      );
    }
    await verifyDatabase(rollbackDatabase.directory, rollbackDatabase.manifest.database);
    manifest = {
      ...manifest,
      databaseSchemaDigest: rollbackDatabase.manifest.database.schemaDigest,
      updatedAt: now(),
    };
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
  } else if (!manifest.steps.some((step) => step.key === migrationStep)) {
    dependencies.onProgress?.('Applying platform database migrations');
    const prepareDatabase = dependencies.prepareDatabase ?? releaseDatabaseLock.prepareDatabase;
    if (!prepareDatabase) {
      throw new Error(
        'platform: The PostgreSQL lifecycle lock cannot verify or migrate this database.',
      );
    }
    await prepareDatabase(
      runtimeDirectory,
      runtime.database,
      sourcePlatformVersion,
      hadPriorWorkers,
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: now(),
        key: migrationStep,
        resultHash: runtime.database.schemaDigest,
      },
      now(),
    );
    manifest = {
      ...manifest,
      databaseSchemaDigest: runtime.database.schemaDigest,
      updatedAt: now(),
    };
    onManifestChange(manifest);
    writeInstallationManifest(manifest);
    await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
  } else if (releaseDatabaseLock.verifyDatabase) {
    await releaseDatabaseLock.verifyDatabase(runtimeDirectory, runtime.database);
    if (manifest.databaseSchemaDigest !== runtime.database.schemaDigest) {
      manifest = {
        ...manifest,
        databaseSchemaDigest: runtime.database.schemaDigest,
        updatedAt: now(),
      };
      onManifestChange(manifest);
      writeInstallationManifest(manifest);
      await writeRemoteInstallationCheckpoint(dependencies.client, plan, manifest);
    }
  }

  return manifest;
}

function databaseInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

/**
 * A Hyperdrive that Void creates validates the server against public certificate authorities
 * only, so it cannot honor a private CA that the local database client would trust.
 */
export function assertVoidCreatedHyperdriveTrustsDatabase(databaseUrl: string): void {
  // Same last-value-wins rule as the local client; pg ignores an empty value.
  const sslrootcert = new URL(databaseUrl).searchParams.getAll('sslrootcert').at(-1);
  if (sslrootcert && sslrootcert !== 'system') {
    throw new Error(
      'platform: A Hyperdrive created by Void trusts only public certificate authorities, so it cannot use the certificate authority in DATABASE_URL sslrootcert. If the database certificate comes from a public certificate authority, use sslrootcert=system. Otherwise create a separately managed Hyperdrive that trusts it, then select it with "Use an existing Hyperdrive" when you start a new installation, or set VOID_PLATFORM_HYPERDRIVE_ID, VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST, and VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER.',
    );
  }
}

/** Make pg's current strict TLS behavior explicit without rewriting saved connection details. */
export function platformDatabaseClientUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return databaseUrl;
  }
  // Match pg's last-value-wins query parsing. libpq reads `sslrootcert=system` as the system
  // trust store and requires verify-full with it, while pg would open it as a file path. Node's
  // default CAs with hostname verification give pg the same policy.
  if (url.searchParams.getAll('sslrootcert').at(-1) === 'system') {
    url.searchParams.delete('sslrootcert');
    url.searchParams.set('sslmode', 'verify-full');
    return url.toString();
  }
  // Respect explicit libpq compatibility.
  if (
    url.searchParams.getAll('sslmode').at(-1) !== 'require' ||
    url.searchParams.getAll('uselibpqcompat').at(-1) === 'true'
  ) {
    return databaseUrl;
  }
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

async function withPlatformDatabasePool<T>(
  databaseUrl: string,
  use: (pool: Pool) => Promise<T>,
): Promise<T> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: platformDatabaseClientUrl(databaseUrl), max: 1 });
  try {
    return await use(pool);
  } finally {
    await pool.end();
  }
}

export function claimPlatformDatabase(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  return withPlatformDatabasePool(databaseUrl, async (pool) => {
    const client = await pool.connect();
    try {
      await claimPlatformDatabaseConnection(client, installationId, ownershipNonce);
    } finally {
      client.release();
    }
  });
}

export async function acquirePlatformDatabaseLifecycleLock(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformDatabaseLifecycleLock> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: platformDatabaseClientUrl(databaseUrl), max: 1 });
  const client = await pool.connect();
  try {
    const releaseConnectionLock = await acquirePlatformDatabaseLifecycleLockConnection(
      client,
      installationId,
      ownershipNonce,
    );
    const release: PlatformDatabaseLifecycleLock = async () => {
      try {
        await releaseConnectionLock();
      } finally {
        client.release();
        await pool.end();
      }
    };
    // Keep the complete session-lock contract when adding pool cleanup. Safety
    // and verification hooks must not disappear at this wrapper boundary.
    return Object.assign(release, releaseConnectionLock);
  } catch (error) {
    client.release();
    await pool.end();
    throw error;
  }
}

export async function readPlatformDatabaseLifecycleManifest(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformInstallationManifest | null> {
  return withPlatformDatabasePool(databaseUrl, async (pool) => {
    try {
      return await readPlatformDatabaseLifecycleManifestConnection(
        pool,
        installationId,
        ownershipNonce,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('platform:')) {
        throw error;
      }
      throw new Error(
        `platform: Could not read the PostgreSQL lifecycle checkpoint: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

/** Plans hold no lifecycle lock, so verify the installation claim before reading. */
async function readClaimedPlatformDatabase<T>(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
  read: (pool: Pool) => Promise<T>,
): Promise<T> {
  if (!databaseUrl) {
    throw new Error('the installation database URL is not recorded on this machine');
  }
  return withPlatformDatabasePool(databaseUrl, async (pool) => {
    await readPlatformDatabaseLifecycleManifestConnection(pool, installationId, ownershipNonce);
    return read(pool);
  });
}

/** Read project Zero Trust state for a plan. */
export function readPlatformProjectZeroTrustState(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformProjectZeroTrustState> {
  return readClaimedPlatformDatabase(
    databaseUrl,
    installationId,
    ownershipNonce,
    readPlatformProjectZeroTrustStateConnection,
  );
}

/** Read project slugs for a --purge-resources plan. */
export function readPlatformProjectSlugs(
  databaseUrl: string,
  installationId: string,
  ownershipNonce: string,
): Promise<ReadonlyArray<string>> {
  return readClaimedPlatformDatabase(
    databaseUrl,
    installationId,
    ownershipNonce,
    readPlatformProjectSlugsConnection,
  );
}

/** Read the first administrator setup row and whether any user exists. */
export async function readPlatformAdministratorSetupConnection(
  client: QueryConnection,
): Promise<PlatformAdministratorSetupState> {
  const tables = await client.query<{ setup: boolean; users: boolean }>(
    `SELECT to_regclass('public.platform_auth_bootstrap') IS NOT NULL AS "setup",
            to_regclass('public.users') IS NOT NULL AS "users"`,
  );
  const present = tables.rows[0];
  const setup = present?.setup
    ? (
        await client.query<{ request_hash: string; consumed_at: unknown }>(
          'SELECT "request_hash", "consumed_at" FROM "platform_auth_bootstrap" WHERE "singleton" = true',
        )
      ).rows[0]
    : undefined;
  const usersExist = present?.users
    ? (
        await client.query<{ present: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM "users") AS "present"',
        )
      ).rows[0]?.present === true
    : false;
  return {
    pending: !!setup && setup.consumed_at === null,
    usersExist,
    requestHash: setup?.request_hash ?? null,
  };
}

/** Slugs of every project row, including projects whose deletion stopped partway. */
export async function readPlatformProjectSlugsConnection(
  client: QueryConnection,
): Promise<ReadonlyArray<string>> {
  const table = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.projects') IS NOT NULL AS "present"`,
  );
  if (table.rows[0]?.present !== true) {
    return [];
  }
  const rows = await client.query<{ slug: string }>(
    'SELECT "slug" FROM "projects" ORDER BY "slug"',
  );
  return rows.rows.map((row) => row.slug);
}

type PlatformDatabaseMigrationRow = Readonly<{
  created_at: unknown;
  hash: unknown;
  id: unknown;
}>;

export async function inspectPlatformDatabaseStateConnection(
  client: QueryConnection,
  database: PlatformRuntimeDatabaseManifest,
): Promise<PlatformDatabaseState> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"drizzle"."__drizzle_migrations"')::text AS "relation"`,
  );
  if (relation.rows.length === 0 || relation.rows[0]?.relation === null) {
    return {
      pendingMigrations: database.migrations,
      schemaDigest: platformDatabaseSchemaDigest(database.lineage, []),
    };
  }
  const result = await client.query<PlatformDatabaseMigrationRow>(
    `SELECT "id", "hash", "created_at"
     FROM "drizzle"."__drizzle_migrations"
     ORDER BY "created_at", "id"`,
  );
  if (result.rows.length > database.migrations.length) {
    throw new Error(
      'platform: PostgreSQL contains migrations newer than this Void Platform package.',
    );
  }
  let previousTimestamp = -1;
  for (const [position, row] of result.rows.entries()) {
    const timestampMillis = databaseInteger(row.created_at);
    if (timestampMillis === null || timestampMillis <= previousTimestamp) {
      throw new Error(
        'platform: PostgreSQL migration history is duplicated or not strictly ordered.',
      );
    }
    const expected = database.migrations[position];
    if (!expected || timestampMillis !== expected.timestampMillis || row.hash !== expected.sha256) {
      throw new Error(
        'platform: PostgreSQL migration history is not an exact prefix of this Void Platform package. Refusing to apply edited, forked, or out-of-order migrations.',
      );
    }
    previousTimestamp = timestampMillis;
  }
  const applied = database.migrations.slice(0, result.rows.length);
  return {
    pendingMigrations: database.migrations.slice(result.rows.length),
    schemaDigest: platformDatabaseSchemaDigest(database.lineage, applied),
  };
}

export async function preparePlatformDatabaseConnection(
  client: QueryConnection,
  runtimeDirectory: string,
  database: PlatformRuntimeDatabaseManifest,
  sourcePlatformVersion: string | null,
  hasPriorWorkers: boolean,
): Promise<PlatformDatabaseMigrationResult> {
  verifyPlatformDatabaseArtifacts(runtimeDirectory, database);
  const before = await inspectPlatformDatabaseStateConnection(client, database);
  if (before.pendingMigrations.length === 0) {
    if (before.schemaDigest !== database.schemaDigest) {
      throw new Error('platform: PostgreSQL schema digest does not match the packaged runtime.');
    }
    return {
      appliedMigrations: 0,
      previousSchemaDigest: before.schemaDigest,
      schemaDigest: before.schemaDigest,
    };
  }
  if (
    hasPriorWorkers &&
    !database.rollbackSafeFrom.some(
      (entry) =>
        entry.platformVersion === sourcePlatformVersion &&
        entry.schemaDigest === before.schemaDigest,
    )
  ) {
    throw new Error(
      `platform: Void Platform ${sourcePlatformVersion ?? 'unknown'} cannot safely roll back after migrating database schema ${before.schemaDigest} to this release. Upgrade through a supported intermediate version or install into a fresh database.`,
    );
  }

  await client.query('BEGIN');
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        "id" serial PRIMARY KEY,
        "hash" text NOT NULL,
        "created_at" bigint
      )
    `);
    const rechecked = await inspectPlatformDatabaseStateConnection(client, database);
    if (rechecked.schemaDigest !== before.schemaDigest) {
      throw new Error(
        'platform: PostgreSQL migration history changed while preparing this upgrade.',
      );
    }
    for (const migration of rechecked.pendingMigrations) {
      const sql = readFileSync(join(runtimeDirectory, 'drizzle', `${migration.tag}.sql`), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean)) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
         VALUES ($1, $2)`,
        [migration.sha256, migration.timestampMillis],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => ({ rows: [] }));
    throw error;
  }
  const after = await inspectPlatformDatabaseStateConnection(client, database);
  if (after.pendingMigrations.length !== 0 || after.schemaDigest !== database.schemaDigest) {
    throw new Error(
      'platform: PostgreSQL migration transaction completed without reaching the packaged schema.',
    );
  }
  return {
    appliedMigrations: before.pendingMigrations.length,
    previousSchemaDigest: before.schemaDigest,
    schemaDigest: after.schemaDigest,
  };
}

export async function readPlatformDatabaseLifecycleManifestConnection(
  client: QueryConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformInstallationManifest | null> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"__void_platform_installation"')::text AS "relation"`,
  );
  if (relation.rows[0]?.relation === null || relation.rows.length === 0) {
    return null;
  }
  const result = await client.query<{
    installation_id: string;
    lifecycle_manifest: unknown;
    ownership_nonce: string;
  }>(
    `SELECT "installation_id", "ownership_nonce", "lifecycle_manifest"
     FROM "__void_platform_installation"
     WHERE "singleton" = true`,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.installation_id !== installationId ||
    row.ownership_nonce !== ownershipNonce
  ) {
    throw new Error(
      'platform: The PostgreSQL database ownership claim does not match this installation.',
    );
  }
  if (row.lifecycle_manifest === null || row.lifecycle_manifest === undefined) {
    return null;
  }
  const manifest = parsePlatformInstallationManifest(row.lifecycle_manifest);
  if (manifest.id !== installationId || manifest.ownershipNonce !== ownershipNonce) {
    throw new Error(
      'platform: The PostgreSQL lifecycle checkpoint does not match this installation.',
    );
  }
  return manifest;
}

export async function acquirePlatformDatabaseLifecycleLockConnection(
  client: QueryConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<PlatformDatabaseLifecycleLock> {
  await client.query(
    `ALTER TABLE "__void_platform_installation"
     ADD COLUMN IF NOT EXISTS "lifecycle_manifest" jsonb`,
  );
  const claim = await client.query<{ installation_id: string; ownership_nonce: string }>(
    `SELECT "installation_id", "ownership_nonce"
     FROM "__void_platform_installation"
     WHERE "singleton" = true`,
  );
  const owner = claim.rows[0];
  if (
    !owner ||
    owner.installation_id !== installationId ||
    owner.ownership_nonce !== ownershipNonce
  ) {
    throw new Error(
      'platform: The PostgreSQL database ownership claim does not match this installation.',
    );
  }
  const lockIdentity = `void-platform-lifecycle-v1:${installationId}:${ownershipNonce}`;
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS "acquired"',
    [lockIdentity],
  );
  if (result.rows[0]?.acquired !== true) {
    throw new Error(
      `platform: Another lifecycle operation is active for installation ${installationId} on another host.`,
    );
  }
  let authoritativeManifest: PlatformInstallationManifest | null = null;
  try {
    const checkpoint = await client.query<{ lifecycle_manifest: unknown }>(
      `SELECT "lifecycle_manifest"
       FROM "__void_platform_installation"
       WHERE "singleton" = true
         AND "installation_id" = $1
         AND "ownership_nonce" = $2`,
      [installationId, ownershipNonce],
    );
    const value = checkpoint.rows[0]?.lifecycle_manifest;
    if (checkpoint.rows.length !== 1) {
      throw new Error('platform: The PostgreSQL database ownership claim changed unexpectedly.');
    }
    if (value !== null && value !== undefined) {
      authoritativeManifest = parsePlatformInstallationManifest(value);
      if (
        authoritativeManifest.id !== installationId ||
        authoritativeManifest.ownershipNonce !== ownershipNonce
      ) {
        throw new Error(
          'platform: The PostgreSQL lifecycle checkpoint does not match this installation.',
        );
      }
    }
  } catch (error) {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
    if (error instanceof Error && error.message.startsWith('platform:')) {
      throw error;
    }
    throw new Error(
      `platform: The PostgreSQL lifecycle checkpoint is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let released = false;
  const release: PlatformDatabaseLifecycleLock = async () => {
    if (released) {
      return;
    }
    released = true;
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockIdentity]);
  };
  release.authoritativeManifest = authoritativeManifest;
  release.readAuthenticationState = async () => {
    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.platform_auth_settings') IS NOT NULL AS present",
    );
    if (!table.rows[0]?.present) {
      return null;
    }
    const [result, enabledProviders] = await Promise.all([
      client.query<{ sessions_required: boolean; protection: unknown }>(
        'SELECT sessions_required, protection FROM platform_auth_settings WHERE singleton = true',
      ),
      client.query<{ kind: PlatformLoginKind }>(
        'SELECT DISTINCT kind FROM platform_login_connections WHERE enabled = true ORDER BY kind',
      ),
    ]);
    const settings = result.rows[0];
    return settings
      ? {
          enabledProviders: enabledProviders.rows.map((row) => row.kind),
          sessionsRequired: settings.sessions_required,
          protectedByAccess: settings.protection !== null,
          protection: parsePlatformAccessProtection(settings.protection),
        }
      : null;
  };
  release.readAdministratorSetup = () => readPlatformAdministratorSetupConnection(client);
  release.readProjectZeroTrust = () => readPlatformProjectZeroTrustStateConnection(client);
  release.readProjects = () => readPlatformProjectSlugsConnection(client);
  release.publishAiLogging = (kv, onProgress) =>
    projectPlatformAiLoggingConnection(client, kv, { onProgress });
  release.lockProjectZeroTrust = () => lockPlatformProjectZeroTrustConnection(client);
  release.fenceProjectZeroTrust = () => fencePlatformProjectZeroTrustConnection(client);
  release.liftProjectZeroTrustFence = () => liftPlatformProjectZeroTrustFenceConnection(client);
  release.requiredSafetyProtocols = await readRequiredPlatformSafetyProtocols(client);
  release.checkpoint = async (manifest) => {
    if (released) {
      throw new Error('platform: Cannot checkpoint lifecycle state after releasing its lock.');
    }
    if (manifest.id !== installationId || manifest.ownershipNonce !== ownershipNonce) {
      throw new Error('platform: Refusing to checkpoint lifecycle state for another installation.');
    }
    const updated = await client.query<{ singleton: boolean }>(
      `UPDATE "__void_platform_installation"
       SET "lifecycle_manifest" = $1::jsonb
       WHERE "singleton" = true
         AND "installation_id" = $2
         AND "ownership_nonce" = $3
       RETURNING "singleton"`,
      [JSON.stringify(manifest), installationId, ownershipNonce],
    );
    if (updated.rows.length !== 1) {
      throw new Error('platform: The PostgreSQL database ownership claim changed unexpectedly.');
    }
    release.authoritativeManifest = manifest;
  };
  release.prepareDatabase = (runtimeDirectory, database, sourcePlatformVersion, hasPriorWorkers) =>
    preparePlatformDatabaseConnection(
      client,
      runtimeDirectory,
      database,
      sourcePlatformVersion,
      hasPriorWorkers,
    );
  release.prepareSandboxDrain = (requiredAdmissionProtocol) =>
    preparePlatformSandboxDrainConnection(client, requiredAdmissionProtocol);
  release.verifyDatabase = (runtimeDirectory, database) =>
    verifyPlatformDatabaseConnection(client, runtimeDirectory, database);
  return release;
}

type SandboxDrainCheckpointRow = {
  admission_protocol: number;
  completed_at: string | null;
  cursor: unknown;
  generation: string;
  phase: string;
  started_at: string;
  state: string;
  updated_at: string;
};

/** Null when the sandbox-drain checkpoint table does not exist. */
async function readSandboxDrainTable(
  client: QueryConnection,
): Promise<{ hasAdmissionColumn: boolean } | null> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('"sandbox_drain_checkpoints"')::text AS "relation"`,
  );
  if (!relation.rows[0]?.relation) {
    return null;
  }
  const admissionColumn = await client.query<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'sandbox_drain_checkpoints'
         AND column_name = 'admission_protocol'
     ) AS "present"`,
  );
  return { hasAdmissionColumn: admissionColumn.rows[0]?.present === true };
}

export async function preparePlatformSandboxDrainConnection(
  client: QueryConnection,
  requiredAdmissionProtocol: 0 | 2 | 3 = 0,
): Promise<PlatformSandboxDrainPreparation> {
  const table = await readSandboxDrainTable(client);
  if (!table) {
    throw new Error(
      'platform: Runtime declares sandbox-drain safety but its database checkpoint table is missing.',
    );
  }
  const { hasAdmissionColumn } = table;
  if (requiredAdmissionProtocol >= 2 && !hasAdmissionColumn) {
    throw new Error(
      'platform: The runtime database does not include the sandbox deployment admission barrier.',
    );
  }
  const readCheckpoint = () =>
    client.query<SandboxDrainCheckpointRow>(
      `SELECT ${hasAdmissionColumn ? '"admission_protocol"' : '0 AS "admission_protocol"'}, "generation", "state", "phase", "cursor", "started_at", "updated_at", "completed_at"
       FROM "sandbox_drain_checkpoints"
       WHERE "singleton" = true`,
    );
  const classify = (
    row: SandboxDrainCheckpointRow | undefined,
  ): PlatformSandboxDrainPreparation | null => {
    if (!row) {
      return null;
    }
    const cursor = row.cursor as Record<string, unknown> | null;
    if (
      !row.generation ||
      (row.admission_protocol !== 0 &&
        row.admission_protocol !== 2 &&
        row.admission_protocol !== 3) ||
      !row.started_at ||
      !row.updated_at ||
      (row.state !== 'draining' && row.state !== 'complete') ||
      (row.phase !== 'deployments' && row.phase !== 'resources') ||
      !cursor ||
      (cursor.pass !== '1' && cursor.pass !== '2') ||
      (row.state === 'complete' &&
        (!row.completed_at || row.phase !== 'resources' || cursor.pass !== '2')) ||
      (row.state === 'draining' && row.completed_at !== null)
    ) {
      throw new Error(
        'platform: The authoritative sandbox-drain database checkpoint is invalid. Traffic remains disabled.',
      );
    }
    return {
      admissionProtocol: row.admission_protocol,
      generation: row.generation,
      state: row.state === 'complete' ? 'complete' : 'pending',
    };
  };
  const existing = await readCheckpoint();
  const existingState = classify(existing.rows[0]);
  if (
    existingState &&
    (requiredAdmissionProtocol === 0 ||
      existingState.admissionProtocol >= requiredAdmissionProtocol)
  ) {
    return existingState;
  }
  if (requiredAdmissionProtocol >= 2) {
    // Protocol 2 already drained tenant-owned containers. Advancing authority
    // must not restart that drain against the new platform-owned controllers.
    if (existingState && existingState.admissionProtocol >= 2) {
      await client.query('BEGIN');
      try {
        await client.query('LOCK TABLE "deployments" IN SHARE MODE');
        await client.query(
          `UPDATE "sandbox_drain_checkpoints"
           SET "admission_protocol" = GREATEST("admission_protocol", $1), "updated_at" = now()
           WHERE "singleton" = true`,
          [requiredAdmissionProtocol],
        );
        const advanced = classify((await readCheckpoint()).rows[0]);
        if (!advanced || advanced.admissionProtocol < requiredAdmissionProtocol) {
          throw new Error('platform: The Sandbox controller admission barrier could not be armed.');
        }
        await client.query('COMMIT');
        return advanced;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    const generation = randomUUID();
    await client.query('BEGIN');
    try {
      await client.query('LOCK TABLE "deployments" IN SHARE MODE');
      await client.query(
        `INSERT INTO "sandbox_drain_checkpoints" (
           "singleton", "admission_protocol", "generation", "state", "phase", "cursor"
         ) VALUES (true, 2, $1, 'draining', 'deployments', '{"pass":"1"}'::jsonb)
         ON CONFLICT ("singleton") DO UPDATE
         SET "admission_protocol" = 2,
             "generation" = EXCLUDED."generation",
             "state" = 'draining',
             "phase" = 'deployments',
             "cursor" = '{"pass":"1"}'::jsonb,
             "lease_owner" = NULL,
             "lease_expires_at" = NULL,
             "started_at" = now(),
             "updated_at" = now(),
             "completed_at" = NULL`,
        [generation],
      );
      const inventory = await client.query<{ empty: boolean }>(
        `SELECT
           NOT EXISTS(SELECT 1 FROM "deployments" LIMIT 1)
           AND NOT EXISTS(SELECT 1 FROM "resources" WHERE "type" = 'container' LIMIT 1)
           AS "empty"`,
      );
      if (inventory.rows[0]?.empty === true) {
        await client.query(
          `UPDATE "sandbox_drain_checkpoints"
           SET "state" = 'complete',
               "phase" = 'resources',
               "cursor" = '{"pass":"2"}'::jsonb,
               "lease_owner" = NULL,
               "lease_expires_at" = NULL,
               "updated_at" = now(),
               "completed_at" = now()
           WHERE "singleton" = true
             AND "admission_protocol" = 2
             AND "generation" = $1`,
          [generation],
        );
      }
      if (requiredAdmissionProtocol >= 3) {
        await client.query(
          `UPDATE "sandbox_drain_checkpoints" SET "admission_protocol" = $1
           WHERE "singleton" = true`,
          [requiredAdmissionProtocol],
        );
      }
      const armed = classify((await readCheckpoint()).rows[0]);
      if (!armed || armed.admissionProtocol < requiredAdmissionProtocol) {
        throw new Error('platform: The sandbox deployment admission barrier could not be armed.');
      }
      await client.query('COMMIT');
      return armed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  const inventory = await client.query<{ empty: boolean }>(
    `SELECT
       NOT EXISTS(SELECT 1 FROM "deployments" LIMIT 1)
       AND NOT EXISTS(SELECT 1 FROM "resources" WHERE "type" = 'container' LIMIT 1)
       AS "empty"`,
  );
  const empty = inventory.rows[0]?.empty === true;
  const generation = randomUUID();
  const state = empty ? 'complete' : 'draining';
  const phase = empty ? 'resources' : 'deployments';
  const cursor = JSON.stringify({ pass: empty ? '2' : '1' });
  await client.query(
    `INSERT INTO "sandbox_drain_checkpoints" (
       "singleton", "generation", "state", "phase", "cursor", "completed_at"
     ) VALUES (true, $1, $2, $3, $4::jsonb, CASE WHEN $2 = 'complete' THEN now() ELSE NULL END)
     ON CONFLICT ("singleton") DO NOTHING`,
    [generation, state, phase, cursor],
  );
  const checkpoint = await readCheckpoint();
  const preparedState = classify(checkpoint.rows[0]);
  if (!preparedState) {
    throw new Error('platform: The sandbox-drain database checkpoint could not be established.');
  }
  return preparedState;
}

async function verifyPlatformDatabaseConnection(
  client: QueryConnection,
  runtimeDirectory: string,
  database: PlatformRuntimeDatabaseManifest,
): Promise<void> {
  verifyPlatformDatabaseArtifacts(runtimeDirectory, database);
  const state = await inspectPlatformDatabaseStateConnection(client, database);
  if (state.pendingMigrations.length !== 0 || state.schemaDigest !== database.schemaDigest) {
    throw new Error(
      'platform: PostgreSQL is not at the exact forward-only schema recorded by the installed runtime.',
    );
  }
}

async function readRequiredPlatformSafetyProtocols(
  client: QueryConnection,
): Promise<Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>> {
  const table = await readSandboxDrainTable(client);
  if (!table) {
    return { sandboxDrain: 0 };
  }
  if (table.hasAdmissionColumn) {
    const admission = await client.query<{ required: boolean; protocol: number | null }>(
      `SELECT EXISTS(
         SELECT 1
         FROM "sandbox_drain_checkpoints"
         WHERE "singleton" = true
           AND "admission_protocol" >= 2
       ) AS "required", (SELECT "admission_protocol" FROM "sandbox_drain_checkpoints"
                         WHERE "singleton" = true) AS "protocol"`,
    );
    if (admission.rows[0]?.required === true) {
      if (admission.rows[0].protocol != null && admission.rows[0].protocol > 3) {
        throw new Error('platform: The database requires a newer Sandbox controller protocol.');
      }
      return { sandboxDrain: admission.rows[0].protocol === 3 ? 3 : 2 };
    }
  }
  const checkpoint = await client.query<{ required: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM "sandbox_drain_checkpoints"
       WHERE "singleton" = true
     ) AS "required"`,
  );
  return { sandboxDrain: checkpoint.rows[0]?.required === true ? 1 : 0 };
}

export function assertPlatformRuntimeSafety(
  runtime: Pick<PlatformRuntimeManifest, 'platformVersion' | 'safetyProtocols'>,
  installed: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>,
  database: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }> = { sandboxDrain: 0 },
): void {
  const requiredSandboxDrain = Math.max(installed.sandboxDrain, database.sandboxDrain);
  if ((runtime.safetyProtocols?.sandboxDrain ?? 0) < requiredSandboxDrain) {
    throw new Error(
      `platform: Void Platform ${runtime.platformVersion} predates the required sandbox-drain safety protocol. Refusing to upload or activate a runtime that could reopen sandbox creation after drain.`,
    );
  }
}

async function claimPlatformDatabaseConnection(
  client: QueryConnection,
  installationId: string,
  ownershipNonce: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('void-platform-installation-ownership-v1'))`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__void_platform_installation" (
        "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
        "installation_id" text NOT NULL,
        "ownership_nonce" text NOT NULL,
        "claimed_at" timestamptz NOT NULL DEFAULT now(),
        "lifecycle_manifest" jsonb
      )
    `);
    await client.query(
      `ALTER TABLE "__void_platform_installation"
       ADD COLUMN IF NOT EXISTS "lifecycle_manifest" jsonb`,
    );
    const result = await client.query<{
      installation_id: string;
      ownership_nonce: string;
    }>(
      `SELECT "installation_id", "ownership_nonce"
       FROM "__void_platform_installation"
       WHERE "singleton" = true
       FOR UPDATE`,
    );
    const claim = result.rows[0];
    if (!claim) {
      // Migration history lives outside search_path. Leftover history would be
      // read as already-applied migrations only after the claim, so check it
      // here. Other provider-owned schemas stay out of scope.
      const contents = await client.query<{ schemaname: string; tablename: string }>(
        `SELECT "schemaname", "tablename"
         FROM "pg_catalog"."pg_tables"
         WHERE ("schemaname" = ANY (current_schemas(false)) OR "schemaname" = 'drizzle')
           AND "tablename" <> '__void_platform_installation'
         ORDER BY "schemaname", "tablename"
         LIMIT 1`,
      );
      if (contents.rows.length > 0) {
        const table = contents.rows[0]!;
        throw new Error(
          `platform: Refusing to claim a non-empty PostgreSQL database (found ${table.schemaname}.${table.tablename}). Use a dedicated empty database for each installation.`,
        );
      }
      await client.query(
        `INSERT INTO "__void_platform_installation"
           ("singleton", "installation_id", "ownership_nonce")
         VALUES (true, $1, $2)`,
        [installationId, ownershipNonce],
      );
    } else if (
      claim.installation_id !== installationId ||
      claim.ownership_nonce !== ownershipNonce
    ) {
      throw new Error(
        `platform: This PostgreSQL database is already claimed by Void platform installation ${claim.installation_id}. Uninstall keeps the database and its data, so use a dedicated empty database for each installation.`,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => ({ rows: [] }));
    throw error;
  }
}
