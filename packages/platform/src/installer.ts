import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'pathslash';
import {
  isRecord,
  isSandboxDrainProtocol,
  isSourceRevision,
  isUsageProtocolVersion,
} from './validate.ts';

export type PlatformRuntimeArtifact = Readonly<{
  path: string;
  sha256: string;
  size: number;
}>;

export const PLATFORM_ADMIN_ASSETS_DIRECTORY = 'api/assets';
export const PLATFORM_ADMIN_CLIENT_ASSET_PATH: string = `${PLATFORM_ADMIN_ASSETS_DIRECTORY}/admin/client.js`;
export const PLATFORM_ADMIN_STYLE_ASSET_PATH: string = `${PLATFORM_ADMIN_ASSETS_DIRECTORY}/admin/style.css`;

export type PlatformRuntimeMigration = Readonly<{
  index: number;
  sha256: string;
  tag: string;
  timestampMillis: number;
}>;

export type PlatformRuntimeDatabaseCompatibility = Readonly<{
  platformVersion: string;
  schemaDigest: string;
}>;

export type PlatformRuntimeDatabaseManifest = Readonly<{
  journalSha256: string;
  lineage: string;
  migrations: ReadonlyArray<PlatformRuntimeMigration>;
  protocolVersion: 1;
  rollbackSafeFrom: ReadonlyArray<PlatformRuntimeDatabaseCompatibility>;
  schemaDigest: string;
}>;

export type PlatformRuntimeManifest = Readonly<{
  appAccessSetup?: 1;
  /** The runtime honours `runtimeLogs: minimal` (PLATFORM_RUNTIME_LOGS). */
  runtimeLogs?: 1;
  /** Durable deployment Queue payload and PostgreSQL operation journal contract. */
  deploymentExecution?: 1;
  authenticationProtocolVersion?: 1;
  applicationRoutingVersion?: 1;
  privatePreviews?: 1;
  artifacts: Readonly<
    Record<'api' | 'dispatch' | 'proxy' | 'tail', PlatformRuntimeArtifact> &
      Partial<Record<'emailGateway', PlatformRuntimeArtifact>>
  >;
  assets?: Readonly<{
    adminClient: PlatformRuntimeArtifact;
    adminStyle?: PlatformRuntimeArtifact;
  }>;
  emailProtocolVersion?: 1;
  database: PlatformRuntimeDatabaseManifest;
  platformVersion: string;
  safetyProtocols: Readonly<{ sandboxDrain: 0 | 1 | 2 | 3 }>;
  schemaVersion: 2;
  sourceRevision: string | null;
  /** Queue payload contract shared by the API consumer and trusted producers. */
  usageProtocolVersion: 0 | 1 | 2;
}>;

export type PlatformRuntime = Readonly<{
  directory: string;
  manifest: PlatformRuntimeManifest;
  manifestSha256: string;
  source: 'custom' | 'package';
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/;

export function platformDatabaseSchemaDigest(
  lineage: string,
  migrations: ReadonlyArray<PlatformRuntimeMigration>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        lineage,
        migrations: migrations.map(({ index, sha256, tag, timestampMillis }) => ({
          index,
          sha256,
          tag,
          timestampMillis,
        })),
      }),
    )
    .digest('hex');
}

export function parsePlatformRuntimeManifest(value: unknown): PlatformRuntimeManifest {
  const root = record(value, 'runtime manifest');
  if (root.privatePreviews !== undefined && root.privatePreviews !== 1) {
    throw new Error('Unsupported private preview protocol.');
  }
  if (root.schemaVersion !== 2) {
    throw new Error('runtime manifest schemaVersion must be 2');
  }
  if (root.appAccessSetup !== undefined && root.appAccessSetup !== 1) {
    throw new Error('Unsupported app access setup protocol.');
  }
  if (root.runtimeLogs !== undefined && root.runtimeLogs !== 1) {
    throw new Error('Unsupported runtime logs protocol.');
  }
  if (root.deploymentExecution !== undefined && root.deploymentExecution !== 1) {
    throw new Error('Unsupported deployment execution protocol.');
  }
  if (
    root.authenticationProtocolVersion !== undefined &&
    root.authenticationProtocolVersion !== 1
  ) {
    throw new Error('Unsupported authentication protocol version.');
  }
  if (root.emailProtocolVersion !== undefined && root.emailProtocolVersion !== 1) {
    throw new Error('Unsupported email protocol version.');
  }
  const artifactsValue = record(root.artifacts, 'runtime manifest artifacts');
  if (root.emailProtocolVersion === 1 && artifactsValue.emailGateway === undefined) {
    throw new Error('Email protocol version 1 requires an emailGateway runtime artifact.');
  }
  if (artifactsValue.emailGateway !== undefined && root.emailProtocolVersion !== 1) {
    throw new Error('An emailGateway runtime artifact requires email protocol version 1.');
  }
  const artifactNames = [
    'api',
    'dispatch',
    'proxy',
    'tail',
    ...(artifactsValue.emailGateway === undefined ? [] : ['emailGateway']),
  ] as const;
  const artifacts = Object.fromEntries(
    artifactNames.map((name) => [name, parseArtifact(artifactsValue[name], name)]),
  ) as PlatformRuntimeManifest['artifacts'];
  let assets: PlatformRuntimeManifest['assets'];
  if (root.assets !== undefined) {
    const assetsValue = record(root.assets, 'runtime manifest assets');
    const adminClient = parseArtifact(assetsValue.adminClient, 'admin client asset');
    if (adminClient.path !== PLATFORM_ADMIN_CLIENT_ASSET_PATH) {
      throw new Error(
        `runtime manifest admin client asset path must be ${PLATFORM_ADMIN_CLIENT_ASSET_PATH}`,
      );
    }
    const adminStyle =
      assetsValue.adminStyle === undefined
        ? undefined
        : parseArtifact(assetsValue.adminStyle, 'admin style asset');
    if (adminStyle && adminStyle.path !== PLATFORM_ADMIN_STYLE_ASSET_PATH) {
      throw new Error(
        `runtime manifest admin style asset path must be ${PLATFORM_ADMIN_STYLE_ASSET_PATH}`,
      );
    }
    assets = { adminClient, ...(adminStyle ? { adminStyle } : {}) };
  }
  const databaseValue = record(root.database, 'runtime manifest database');
  if (databaseValue.protocolVersion !== 1) {
    throw new Error('runtime manifest database protocolVersion must be 1');
  }
  const lineage = nonemptyString(databaseValue.lineage, 'database lineage');
  const migrationsValue = array(databaseValue.migrations, 'database migrations');
  const migrations = migrationsValue.map((migration, position) =>
    parseMigration(migration, position),
  );
  const seenIndexes = new Set<number>();
  const seenTags = new Set<string>();
  const seenTimestamps = new Set<number>();
  let previousIndex = -1;
  let previousTimestamp = -1;
  for (const migration of migrations) {
    if (
      seenIndexes.has(migration.index) ||
      seenTags.has(migration.tag) ||
      seenTimestamps.has(migration.timestampMillis)
    ) {
      throw new Error('runtime manifest database migrations must be unique');
    }
    if (migration.index <= previousIndex || migration.timestampMillis <= previousTimestamp) {
      throw new Error('runtime manifest database migrations must be strictly ordered');
    }
    seenIndexes.add(migration.index);
    seenTags.add(migration.tag);
    seenTimestamps.add(migration.timestampMillis);
    previousIndex = migration.index;
    previousTimestamp = migration.timestampMillis;
  }
  const schemaDigest = sha256(databaseValue.schemaDigest, 'database schema digest');
  if (schemaDigest !== platformDatabaseSchemaDigest(lineage, migrations)) {
    throw new Error('runtime manifest database schema digest does not match its migrations');
  }
  const rollbackSafeFrom = array(
    databaseValue.rollbackSafeFrom,
    'database rollback compatibility entries',
  ).map((entry, position) => {
    const compatibility = record(entry, `database rollback compatibility entry ${position}`);
    return {
      platformVersion: nonemptyString(
        compatibility.platformVersion,
        `database rollback compatibility entry ${position} platformVersion`,
      ),
      schemaDigest: sha256(
        compatibility.schemaDigest,
        `database rollback compatibility entry ${position} schemaDigest`,
      ),
    };
  });
  const compatibilityKeys = rollbackSafeFrom.map(
    ({ platformVersion, schemaDigest: digest }) => `${platformVersion}\0${digest}`,
  );
  if (new Set(compatibilityKeys).size !== compatibilityKeys.length) {
    throw new Error('runtime manifest database rollback compatibility entries must be unique');
  }
  const prefixDigests = new Set(
    Array.from({ length: migrations.length + 1 }, (_, length) =>
      platformDatabaseSchemaDigest(lineage, migrations.slice(0, length)),
    ),
  );
  if (rollbackSafeFrom.some((entry) => !prefixDigests.has(entry.schemaDigest))) {
    throw new Error(
      'runtime manifest database rollback compatibility must reference this migration lineage',
    );
  }
  return {
    artifacts,
    ...(root.appAccessSetup === 1 ? { appAccessSetup: 1 as const } : {}),
    ...(root.runtimeLogs === 1 ? { runtimeLogs: 1 as const } : {}),
    ...(root.deploymentExecution === 1 ? { deploymentExecution: 1 as const } : {}),
    ...(assets ? { assets } : {}),
    ...(root.authenticationProtocolVersion === 1
      ? { authenticationProtocolVersion: 1 as const }
      : {}),
    ...(root.emailProtocolVersion === 1 ? { emailProtocolVersion: 1 as const } : {}),
    ...(root.applicationRoutingVersion === 1 ? { applicationRoutingVersion: 1 as const } : {}),
    ...(root.privatePreviews === 1 ? { privatePreviews: 1 as const } : {}),
    database: {
      journalSha256: sha256(databaseValue.journalSha256, 'database journal digest'),
      lineage,
      migrations,
      protocolVersion: 1,
      rollbackSafeFrom,
      schemaDigest,
    },
    platformVersion: nonemptyString(root.platformVersion, 'runtime manifest platformVersion'),
    safetyProtocols: parseSafetyProtocols(root.safetyProtocols),
    schemaVersion: 2,
    sourceRevision:
      root.sourceRevision === undefined || root.sourceRevision === null
        ? null
        : sourceRevision(root.sourceRevision),
    // Runtime manifests released before authenticated usage envelopes did not
    // declare a protocol. Keep them usable for explicit rollback while making
    // the installer treat every move to or from that legacy contract as a
    // traffic-fenced transition.
    usageProtocolVersion: usageProtocolVersion(root.usageProtocolVersion),
  };
}

function parseSafetyProtocols(value: unknown): PlatformRuntimeManifest['safetyProtocols'] {
  if (value === undefined) {
    return { sandboxDrain: 0 };
  }
  const { sandboxDrain } = record(value, 'runtime manifest safetyProtocols');
  if (!isSandboxDrainProtocol(sandboxDrain)) {
    throw new Error('runtime manifest safetyProtocols.sandboxDrain must be 0, 1, 2, or 3');
  }
  return { sandboxDrain };
}

function usageProtocolVersion(value: unknown): 0 | 1 | 2 {
  if (value === undefined) {
    return 0;
  }
  if (!isUsageProtocolVersion(value)) {
    throw new Error('runtime manifest usageProtocolVersion must be 0, 1, or 2');
  }
  return value;
}

export function getPlatformRuntimeDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime');
}

export function readPlatformRuntimeManifest(
  runtimeDirectory: string = getPlatformRuntimeDirectory(),
): PlatformRuntimeManifest {
  return readRuntimeManifestFile(join(runtimeDirectory, 'manifest.json')).manifest;
}

export function resolvePlatformRuntime(
  customRuntimeDirectory?: string,
  baseDirectory: string = process.cwd(),
): PlatformRuntime {
  const source = customRuntimeDirectory ? 'custom' : 'package';
  const requestedDirectory = customRuntimeDirectory
    ? isAbsolute(customRuntimeDirectory)
      ? customRuntimeDirectory
      : resolve(baseDirectory, customRuntimeDirectory)
    : getPlatformRuntimeDirectory();
  let directory: string;
  try {
    directory = realpathSync(requestedDirectory);
    if (!statSync(directory).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch (error) {
    throw new Error(
      `Void Platform runtime directory is unavailable at ${requestedDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { contents, manifest } = readRuntimeManifestFile(join(directory, 'manifest.json'));
  return {
    directory,
    manifest,
    manifestSha256: createHash('sha256').update(contents).digest('hex'),
    source,
  };
}

function readRuntimeManifestFile(path: string): {
  contents: Buffer;
  manifest: PlatformRuntimeManifest;
} {
  try {
    const contents = readFileSync(path);
    return {
      contents,
      manifest: parsePlatformRuntimeManifest(JSON.parse(contents.toString('utf8'))),
    };
  } catch (error) {
    throw new Error(
      `Void Platform deployment artifacts are missing or invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseArtifact(value: unknown, name: string): PlatformRuntimeArtifact {
  const artifact = record(value, `runtime manifest artifact ${name}`);
  const path = nonemptyString(artifact.path, `runtime manifest artifact ${name} path`);
  if (path.startsWith('/') || path.split(/[\\/]/u).includes('..')) {
    throw new Error(`runtime manifest artifact ${name} path must stay inside the package`);
  }
  const size = safeInteger(artifact.size, `runtime manifest artifact ${name} size`);
  if (size < 0) {
    throw new Error(`runtime manifest artifact ${name} size must not be negative`);
  }
  return {
    path,
    sha256: sha256(artifact.sha256, `runtime manifest artifact ${name} digest`),
    size,
  };
}

function parseMigration(value: unknown, position: number): PlatformRuntimeMigration {
  const migration = record(value, `database migration ${position}`);
  const tag = nonemptyString(migration.tag, `database migration ${position} tag`);
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`database migration ${position} tag is invalid`);
  }
  const index = safeInteger(migration.index, `database migration ${position} index`);
  const timestampMillis = safeInteger(
    migration.timestampMillis,
    `database migration ${position} timestampMillis`,
  );
  if (index < 0 || timestampMillis < 0) {
    throw new Error(`database migration ${position} index and timestampMillis must be positive`);
  }
  return {
    index,
    sha256: sha256(migration.sha256, `database migration ${position} digest`),
    tag,
    timestampMillis,
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function array(value: unknown, name: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function nonemptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function sourceRevision(value: unknown): string {
  const revision = nonemptyString(value, 'runtime manifest sourceRevision');
  if (!isSourceRevision(revision)) {
    throw new Error('runtime manifest sourceRevision is invalid');
  }
  return revision;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}
