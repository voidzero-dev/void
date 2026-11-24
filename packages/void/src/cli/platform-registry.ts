import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { parsePlatformInstallationManifest } from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import { join, resolve } from 'pathslash';
import { writeFileAtomic } from '../shared/atomic-write.ts';
import { readKeyringPassword, writeKeyringPassword } from './keyring.ts';
import { Buffer } from './node-buffer.ts';

const PLATFORM_REGISTRY_SCHEMA_VERSION = 1 as const;

export type PlatformConnection = Readonly<{
  accountId: string | null;
  apiUrl: string;
  applicationDomain: string | null;
  displayName: string;
  id: string;
  installationId: string | null;
  kind: 'connected' | 'installed';
  lastUsedAt: string;
  proxyUrl: string | null;
}>;

type PlatformConnectionRegistry = Readonly<{
  activeConnectionId: string | null;
  connections: ReadonlyArray<PlatformConnection>;
  schemaVersion: typeof PLATFORM_REGISTRY_SCHEMA_VERSION;
}>;

const DEFAULT_REGISTRY: PlatformConnectionRegistry = {
  activeConnectionId: null,
  connections: [],
  schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
};

const PLATFORM_RECOVERY_KEYRING_SERVICE = 'dev.void.cli.platform';
const PLATFORM_RECOVERY_ENVELOPE_VERSION = 1 as const;

type PlatformRecoveryEnvelope = Readonly<{
  algorithm: 'aes-256-gcm';
  ciphertext: string;
  iv: string;
  schemaVersion: typeof PLATFORM_RECOVERY_ENVELOPE_VERSION;
  tag: string;
}>;

export function platformRegistryDirectory(): string {
  return process.env.VOID_PLATFORM_REGISTRY_DIR ?? join(homedir(), '.void', 'platforms');
}

export function normalizePlatformApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`platform: Invalid platform URL ${JSON.stringify(value)}.`);
  }
  const localHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('platform: Platform URLs must use HTTPS and must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('platform: Platform URLs must not contain query parameters or fragments.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('platform: Platform URLs must not contain a path.');
  }
  return url.origin;
}

function platformConnectionId(apiUrl: string): string {
  return createHash('sha256').update(normalizePlatformApiUrl(apiUrl)).digest('hex').slice(0, 20);
}

export function platformCredentialAccount(apiUrl: string): string {
  return `platform:${createHash('sha256').update(normalizePlatformApiUrl(apiUrl)).digest('hex')}`;
}

const optionalString = (input: unknown): string | null =>
  typeof input === 'string' && input !== '' ? input : null;

function parseConnection(value: unknown): PlatformConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('platform: Invalid connection entry in the local registry.');
  }
  const entry = value as Record<string, unknown>;
  const apiUrl = normalizePlatformApiUrl(String(entry.apiUrl ?? ''));
  const id = String(entry.id ?? '');
  if (id !== platformConnectionId(apiUrl)) {
    throw new Error('platform: Connection id does not match its API URL.');
  }
  if (entry.kind !== 'connected' && entry.kind !== 'installed') {
    throw new Error('platform: Invalid connection kind in the local registry.');
  }
  const lastUsedAt = String(entry.lastUsedAt ?? '');
  if (!Number.isFinite(Date.parse(lastUsedAt))) {
    throw new Error('platform: Invalid connection timestamp in the local registry.');
  }
  const proxyUrl = optionalString(entry.proxyUrl);
  return {
    accountId: optionalString(entry.accountId),
    apiUrl,
    applicationDomain: optionalString(entry.applicationDomain),
    displayName:
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : new URL(apiUrl).hostname,
    id,
    installationId: optionalString(entry.installationId),
    kind: entry.kind,
    lastUsedAt,
    proxyUrl: proxyUrl === null ? null : normalizePlatformApiUrl(proxyUrl),
  };
}

function readRegistry(directory: string): PlatformConnectionRegistry {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'registry.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('registry must be an object');
    }
    const value = parsed as Record<string, unknown>;
    if (
      value.schemaVersion !== PLATFORM_REGISTRY_SCHEMA_VERSION ||
      !Array.isArray(value.connections)
    ) {
      throw new Error('unsupported schema');
    }
    const connections = value.connections.map(parseConnection);
    const activeConnectionId =
      typeof value.activeConnectionId === 'string' &&
      connections.some((connection) => connection.id === value.activeConnectionId)
        ? value.activeConnectionId
        : null;
    return { activeConnectionId, connections, schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_REGISTRY;
    }
    throw new Error(
      `platform: Could not read ${join(directory, 'registry.json')}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function withRegistryLock<T>(directory: string, operation: () => T): T {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.registry.lock');
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < 10 * 60 * 1000) {
      throw new Error('platform: Another process is updating the platform registry.', {
        cause: error,
      });
    }
    rmSync(lockPath, { force: true });
    descriptor = openSync(lockPath, 'wx', 0o600);
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export function acquirePlatformLifecycleLock(
  accountId: string,
  installationSlug: string,
  directory: string = platformRegistryDirectory(),
): () => void {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(installationSlug)) {
    throw new Error('platform: Invalid lifecycle lock identity.');
  }
  const lockDirectory = join(directory, 'locks');
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDirectory, `${accountId}-${installationSlug}.lock`);
  const acquire = (): number => {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ host: hostname(), pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      return descriptor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
          host?: unknown;
          pid?: unknown;
          startedAt?: unknown;
        };
        if (owner.host === hostname() && typeof owner.pid === 'number') {
          try {
            process.kill(owner.pid, 0);
          } catch (ownerError) {
            stale = (ownerError as NodeJS.ErrnoException).code === 'ESRCH';
          }
        } else {
          const startedAt =
            typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : Number.NaN;
          stale = Number.isFinite(startedAt) && Date.now() - startedAt > 2 * 60 * 60 * 1000;
        }
      } catch {
        stale = Date.now() - statSync(lockPath).mtimeMs > 2 * 60 * 60 * 1000;
      }
      if (!stale) {
        throw new Error(
          `platform: Another lifecycle operation is active for ${installationSlug} in account ${accountId}.`,
          { cause: error },
        );
      }
      rmSync(lockPath, { force: true });
      return acquire();
    }
  };
  const descriptor = acquire();
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  };
}

export function listPlatformConnections(
  directory: string = platformRegistryDirectory(),
): ReadonlyArray<PlatformConnection> {
  return readRegistry(directory).connections;
}

export function assertPlatformInstallationSlugAvailable(
  installationSlug: string,
  directory: string = platformRegistryDirectory(),
): void {
  const collision = listInstallationManifests(directory).find(
    (manifest) =>
      manifest.status !== 'uninstalled' &&
      manifest.deployment.installationSlug === installationSlug,
  );
  if (collision) {
    throw new Error(
      `platform: Installation ${collision.id} already uses this name. Resume it with \`void platform install --resume --name ${collision.id}\`.`,
    );
  }
}

export function getActivePlatformConnection(
  directory: string = platformRegistryDirectory(),
): PlatformConnection | null {
  const registry = readRegistry(directory);
  return (
    registry.connections.find((connection) => connection.id === registry.activeConnectionId) ??
    (registry.connections.length === 1 ? registry.connections[0]! : null)
  );
}

export function platformConnectionSlug(
  connection: PlatformConnection,
  installations: ReadonlyArray<PlatformInstallationManifest>,
): string | null {
  const matches = installations.filter(
    (manifest) =>
      manifest.status !== 'uninstalled' &&
      manifest.id === connection.installationId &&
      (connection.accountId === null || connection.accountId === manifest.account.id),
  );
  return matches.length === 1 ? matches[0]!.deployment.installationSlug : null;
}

/** Resolve saved platforms without selecting one or changing its credentials. */
export function findPlatformConnections(
  selector: string,
  directory: string = platformRegistryDirectory(),
  connections: ReadonlyArray<PlatformConnection> = listPlatformConnections(directory),
): ReadonlyArray<PlatformConnection> {
  let normalizedUrl: string | null = null;
  try {
    normalizedUrl = normalizePlatformApiUrl(selector);
  } catch {
    // Names, slugs, and IDs are also valid selectors.
  }
  const installations = connections.some((connection) => connection.installationId)
    ? listInstallationManifests(directory)
    : [];
  return connections.filter(
    (entry) =>
      entry.id === selector ||
      entry.installationId === selector ||
      entry.displayName.toLowerCase() === selector.toLowerCase() ||
      entry.apiUrl === normalizedUrl ||
      platformConnectionSlug(entry, installations) === selector.toLowerCase(),
  );
}

export function savePlatformConnection(
  input: Omit<PlatformConnection, 'id' | 'lastUsedAt'> & { lastUsedAt?: string },
  directory: string = platformRegistryDirectory(),
): PlatformConnection {
  const apiUrl = normalizePlatformApiUrl(input.apiUrl);
  const id = platformConnectionId(apiUrl);
  const lastUsedAt = input.lastUsedAt ?? new Date().toISOString();
  const connection = parseConnection({ ...input, apiUrl, id, lastUsedAt });
  return withRegistryLock(directory, () => {
    const current = readRegistry(directory);
    const connections = current.connections.filter((entry) => entry.id !== id);
    connections.push(connection);
    connections.sort((left, right) => left.displayName.localeCompare(right.displayName));
    writeJsonAtomically(join(directory, 'registry.json'), {
      activeConnectionId: id,
      connections,
      schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
    });
    return connection;
  });
}

export function selectPlatformConnection(
  selector: string,
  directory: string = platformRegistryDirectory(),
): PlatformConnection {
  return withRegistryLock(directory, () => {
    const current = readRegistry(directory);
    const matches = findPlatformConnections(selector, directory, current.connections);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `platform: No installed or connected platform matches ${JSON.stringify(selector)}.`
          : `platform: More than one platform matches ${JSON.stringify(selector)}. Use its id or URL.`,
      );
    }
    const selected = { ...matches[0]!, lastUsedAt: new Date().toISOString() };
    const connections = current.connections.map((entry) =>
      entry.id === selected.id ? selected : entry,
    );
    writeJsonAtomically(join(directory, 'registry.json'), {
      activeConnectionId: selected.id,
      connections,
      schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
    });
    return selected;
  });
}

function installationManifestPath(
  accountId: string,
  installationId: string,
  directory: string = platformRegistryDirectory(),
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{7,79}$/.test(installationId)) {
    throw new Error('platform: Invalid account or installation id.');
  }
  return join(directory, accountId, `${installationId}.json`);
}

export function writeInstallationManifest(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const path = installationManifestPath(manifest.account.id, manifest.id, directory);
  const parent = join(directory, manifest.account.id);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeJsonAtomically(path, manifest);
}

export function listInstallationManifests(
  directory: string = platformRegistryDirectory(),
): ReadonlyArray<PlatformInstallationManifest> {
  const manifests: Array<PlatformInstallationManifest> = [];
  let accountDirectories: Array<string>;
  try {
    accountDirectories = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  for (const accountId of accountDirectories) {
    const accountPath = join(directory, accountId);
    for (const entry of readdirSync(accountPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const path = join(accountPath, entry.name);
      try {
        manifests.push(parsePlatformInstallationManifest(JSON.parse(readFileSync(path, 'utf8'))));
      } catch (error) {
        throw new Error(
          `platform: Invalid installation manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  }
  return manifests.sort((left, right) =>
    left.deployment.displayName.localeCompare(right.deployment.displayName),
  );
}

export function resolveInstallationManifest(
  selector: string,
  directory: string = platformRegistryDirectory(),
): PlatformInstallationManifest {
  const connection = selector
    ? listPlatformConnections(directory).find((entry) => entry.id === selector)
    : undefined;
  const manifests = listInstallationManifests(directory).filter(
    (manifest) =>
      manifest.status !== 'uninstalled' &&
      (!selector ||
        manifest.id === selector ||
        (manifest.id === connection?.installationId &&
          (connection.accountId === null || connection.accountId === manifest.account.id)) ||
        manifest.deployment.installationSlug === selector ||
        manifest.deployment.displayName.toLowerCase() === selector.toLowerCase()),
  );
  if (manifests.length !== 1) {
    throw new Error(
      manifests.length === 0
        ? `platform: No local installation matches ${JSON.stringify(selector)}.`
        : 'platform: Multiple local installations match; specify an installation id.',
    );
  }
  return manifests[0]!;
}

export function writePendingInstallationSecrets(
  manifest: PlatformInstallationManifest,
  secrets: Record<string, string>,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  writeEncryptedRecoveryMaterial(
    manifest,
    'pending',
    manifestPath.replace(/\.json$/, '.secrets.enc'),
    secrets,
    directory,
  );
  rmSync(manifestPath.replace(/\.json$/, '.secrets'), { force: true });
}

export function readPendingInstallationSecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): Record<string, string> | null {
  return readRecoveryMaterial(manifest, 'pending', directory);
}

export function promoteInstallationSecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  const values = readPendingInstallationSecrets(manifest, directory);
  if (!values) {
    throw new Error('platform: Pending installation recovery material is missing.');
  }
  const recovery = manifestPath.replace(/\.json$/, '.recovery.enc');
  writeEncryptedRecoveryMaterial(manifest, 'recovery', recovery, values, directory);
  rmSync(manifestPath.replace(/\.json$/, '.secrets.enc'), { force: true });
  rmSync(manifestPath.replace(/\.json$/, '.secrets'), { force: true });
  rmSync(manifestPath.replace(/\.json$/, '.recovery'), { force: true });
}

export function readInstallationRecoverySecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): Record<string, string> | null {
  const pending = readPendingInstallationSecrets(manifest, directory);
  if (!pending) {
    return readRecoveryMaterial(manifest, 'recovery', directory);
  }
  const updateState = pendingWorkerSecretUpdateState(manifest, pending.workerSecretUpdatesJson);
  if (updateState === 'stale') {
    return readRecoveryMaterial(manifest, 'recovery', directory);
  }
  if (updateState === 'committed') {
    return Object.fromEntries(
      Object.entries(pending).filter(([name]) => name !== 'workerSecretUpdatesJson'),
    );
  }
  return pending;
}

function pendingWorkerSecretUpdateState(
  manifest: PlatformInstallationManifest,
  value: string | undefined,
): 'active' | 'committed' | 'stale' {
  if (!value) {
    return 'active';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Preserve malformed pending material so the installer reports corruption.
    return 'active';
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('schema' in parsed) ||
    parsed.schema !== 1 ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    !('baselineGeneration' in parsed) ||
    !Number.isSafeInteger(parsed.baselineGeneration) ||
    !('generation' in parsed) ||
    (parsed.generation !== null && !Number.isSafeInteger(parsed.generation))
  ) {
    return 'active';
  }
  return platformWorkerSecretUpdateIntentState(manifest, {
    baselineGeneration: Number(parsed.baselineGeneration),
    generation: parsed.generation === null ? null : Number(parsed.generation),
    id: parsed.id,
  });
}

export function platformWorkerSecretUpdateIntentState(
  manifest: PlatformInstallationManifest,
  intent: Readonly<{
    baselineGeneration: number;
    generation: number | null;
    id: string;
  }>,
): 'active' | 'committed' | 'stale' {
  const latestGeneration = latestPlatformWorkerCutoverGeneration(manifest);
  const latestState = manifest.steps
    .flatMap((step) => {
      const match = /^worker-secret-updates:(\d+):(pending|committed)$/.exec(step.key);
      return match ? [{ generation: Number(match[1]), id: step.resultHash, state: match[2] }] : [];
    })
    .sort(
      (left, right) =>
        right.generation - left.generation ||
        (left.state === right.state ? 0 : left.state === 'committed' ? -1 : 1),
    )[0];
  if (!latestState) {
    return intent.generation === null && intent.baselineGeneration === latestGeneration
      ? 'active'
      : 'stale';
  }
  if (latestState.generation !== latestGeneration || latestState.id !== intent.id) {
    return 'stale';
  }
  return latestState.state === 'committed' ? 'committed' : 'active';
}

export function latestPlatformWorkerCutoverGeneration(
  manifest: PlatformInstallationManifest,
): number {
  return Math.max(
    0,
    ...manifest.steps.flatMap((step) => {
      const match = /^worker-(?:cutover|secret-updates|traffic-state):(\d+)/.exec(step.key);
      return match ? [Number(match[1])] : [];
    }),
  );
}

export function removeInstallationRecoverySecrets(
  manifest: PlatformInstallationManifest,
  directory: string = platformRegistryDirectory(),
): void {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  rmSync(manifestPath.replace(/\.json$/, '.recovery.enc'), { force: true });
  rmSync(manifestPath.replace(/\.json$/, '.secrets.enc'), { force: true });
  rmSync(manifestPath.replace(/\.json$/, '.recovery'), { force: true });
  rmSync(manifestPath.replace(/\.json$/, '.secrets'), { force: true });
}

function readRecoveryMaterial(
  manifest: PlatformInstallationManifest,
  kind: 'pending' | 'recovery',
  directory: string,
): Record<string, string> | null {
  const manifestPath = installationManifestPath(manifest.account.id, manifest.id, directory);
  const encryptedPath = manifestPath.replace(
    /\.json$/,
    `.${kind === 'pending' ? 'secrets' : 'recovery'}.enc`,
  );
  try {
    const envelope = parseRecoveryEnvelope(JSON.parse(readFileSync(encryptedPath, 'utf8')));
    const key = platformRecoveryKey(directory, false);
    if (!key) {
      throw new Error(
        'the encryption key is unavailable; restore it from the system keychain or set VOID_PLATFORM_RECOVERY_KEY',
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(recoveryAad(manifest, kind));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return parseRecoveryValues(JSON.parse(plaintext.toString('utf8')), `${kind} recovery material`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // oxlint-disable-next-line preserve-caught-error -- Do not attach the original error from reading credential material.
      throw new Error(
        `platform: Could not read encrypted ${kind} material: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const legacyPath = manifestPath.replace(/\.json$/, kind === 'pending' ? '.secrets' : '.recovery');
  try {
    const values = parseRecoveryValues(
      JSON.parse(readFileSync(legacyPath, 'utf8')),
      `legacy ${kind} recovery material`,
    );
    writeEncryptedRecoveryMaterial(manifest, kind, encryptedPath, values, directory);
    rmSync(legacyPath, { force: true });
    return values;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // oxlint-disable-next-line preserve-caught-error -- Do not attach the original error from reading credential material.
    throw new Error(
      `platform: Could not migrate legacy ${kind} material: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeEncryptedRecoveryMaterial(
  manifest: PlatformInstallationManifest,
  kind: 'pending' | 'recovery',
  path: string,
  values: Record<string, string>,
  directory: string,
): void {
  const key = platformRecoveryKey(directory, true)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(recoveryAad(manifest, kind));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(parseRecoveryValues(values, `${kind} recovery material`)), 'utf8'),
    cipher.final(),
  ]);
  const envelope: PlatformRecoveryEnvelope = {
    algorithm: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    schemaVersion: PLATFORM_RECOVERY_ENVELOPE_VERSION,
    tag: cipher.getAuthTag().toString('base64'),
  };
  writeJsonAtomically(path, envelope);
}

function recoveryAad(manifest: PlatformInstallationManifest, kind: 'pending' | 'recovery'): Buffer {
  return Buffer.from(
    `void-platform-recovery-v1\0${manifest.account.id}\0${manifest.id}\0${manifest.ownershipNonce}\0${kind}`,
  );
}

function platformRecoveryKey(directory: string, create: boolean): Buffer | null {
  const fromEnvironment = process.env.VOID_PLATFORM_RECOVERY_KEY;
  if (fromEnvironment) {
    return parseRecoveryKey(fromEnvironment, 'VOID_PLATFORM_RECOVERY_KEY');
  }
  const account = `recovery:${createHash('sha256').update(resolve(directory)).digest('hex')}`;
  const saved = readKeyringPassword(PLATFORM_RECOVERY_KEYRING_SERVICE, account);
  if (saved) {
    return parseRecoveryKey(saved, 'system keychain recovery key');
  }
  if (!create) {
    return null;
  }
  const generated = randomBytes(32);
  if (
    !writeKeyringPassword(PLATFORM_RECOVERY_KEYRING_SERVICE, account, generated.toString('base64'))
  ) {
    throw new Error(
      'platform: The system keychain is unavailable. Refusing to write platform secrets to disk. Configure a system keychain or set a base64-encoded 32-byte VOID_PLATFORM_RECOVERY_KEY from your secret manager.',
    );
  }
  return generated;
}

function parseRecoveryKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw new Error(`platform: ${name} must be a canonical base64-encoded 32-byte key.`);
  }
  return key;
}

function parseRecoveryEnvelope(value: unknown): PlatformRecoveryEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('encrypted recovery envelope must be an object');
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.schemaVersion !== PLATFORM_RECOVERY_ENVELOPE_VERSION ||
    envelope.algorithm !== 'aes-256-gcm' ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string'
  ) {
    throw new Error('encrypted recovery envelope is invalid');
  }
  if (Buffer.from(envelope.iv, 'base64').byteLength !== 12) {
    throw new Error('encrypted recovery IV is invalid');
  }
  if (Buffer.from(envelope.tag, 'base64').byteLength !== 16) {
    throw new Error('encrypted recovery tag is invalid');
  }
  return envelope as PlatformRecoveryEnvelope;
}

function parseRecoveryValues(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new Error(`${name} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function removePlatformConnectionForInstallation(
  installationId: string,
  directory: string = platformRegistryDirectory(),
): void {
  withRegistryLock(directory, () => {
    const current = readRegistry(directory);
    const connections = current.connections.filter(
      (connection) => connection.installationId !== installationId,
    );
    writeJsonAtomically(join(directory, 'registry.json'), {
      activeConnectionId:
        current.activeConnectionId &&
        connections.some((connection) => connection.id === current.activeConnectionId)
          ? current.activeConnectionId
          : (connections[0]?.id ?? null),
      connections,
      schemaVersion: PLATFORM_REGISTRY_SCHEMA_VERSION,
    });
  });
}
