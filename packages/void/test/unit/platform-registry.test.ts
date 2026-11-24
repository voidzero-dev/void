import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  setInstallationEndpoints,
} from '@void/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  acquirePlatformLifecycleLock,
  assertPlatformInstallationSlugAvailable,
  getActivePlatformConnection,
  findPlatformConnections,
  platformConnectionSlug,
  listInstallationManifests,
  listPlatformConnections,
  normalizePlatformApiUrl,
  platformCredentialAccount,
  savePlatformConnection,
  selectPlatformConnection,
  promoteInstallationSecrets,
  readInstallationRecoverySecrets,
  removeInstallationRecoverySecrets,
  resolveInstallationManifest,
  writePendingInstallationSecrets,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';

const roots: Array<string> = [];

beforeEach(() => {
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
});

function temporaryRegistry(): string {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-registry-'));
  roots.push(directory);
  return directory;
}

function exampleInstallation() {
  return setInstallationEndpoints(
    createPlatformInstallationManifest({
      account: { id: 'account_123', name: 'Developer Platform Experience' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '0.10.13',
    }),
    { apiUrl: 'https://api.example.com', dashboardUrl: null, proxyUrl: null },
    '2026-09-14T00:00:00.000Z',
  );
}

afterEach(() => {
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('platform registry', () => {
  it('serializes mutating lifecycle operations per installation', () => {
    const directory = temporaryRegistry();
    const release = acquirePlatformLifecycleLock('account_123', 'example', directory);
    expect(() => acquirePlatformLifecycleLock('account_123', 'example', directory)).toThrow(
      'Another lifecycle operation is active',
    );
    const releaseOther = acquirePlatformLifecycleLock('account_123', 'other', directory);
    releaseOther();
    release();
    const releaseAgain = acquirePlatformLifecycleLock('account_123', 'example', directory);
    releaseAgain();
  });

  it('rejects a fresh installation slug after a competing checkpoint appears', () => {
    const directory = temporaryRegistry();
    writeInstallationManifest({ ...exampleInstallation(), status: 'planned' }, directory);

    expect(() => assertPlatformInstallationSlugAvailable('example', directory)).toThrow(
      'already uses this name',
    );
    expect(() => assertPlatformInstallationSlugAvailable('other', directory)).not.toThrow();
  });

  it('normalizes and validates API origins', () => {
    expect(normalizePlatformApiUrl('https://platform.example.com/')).toBe(
      'https://platform.example.com',
    );
    expect(normalizePlatformApiUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizePlatformApiUrl('http://[::1]:8787')).toBe('http://[::1]:8787');
    expect(() => normalizePlatformApiUrl('http://platform.example.com')).toThrow('HTTPS');
    expect(() => normalizePlatformApiUrl('https://user@example.com')).toThrow('credentials');
    expect(() => normalizePlatformApiUrl('https://example.com/api')).toThrow(
      'must not contain a path',
    );
  });

  it('stores credentials under an origin-scoped key', () => {
    expect(platformCredentialAccount('https://one.example.com')).not.toBe(
      platformCredentialAccount('https://two.example.com'),
    );
  });

  it('automatically selects one connection and persists an explicit selection', () => {
    const directory = temporaryRegistry();
    const first = savePlatformConnection(
      {
        accountId: null,
        apiUrl: 'https://one.example.com',
        applicationDomain: null,
        displayName: 'One',
        installationId: null,
        kind: 'connected',
        proxyUrl: 'https://proxy.one.example.com',
      },
      directory,
    );
    expect(getActivePlatformConnection(directory)).toEqual(first);
    savePlatformConnection(
      {
        accountId: null,
        apiUrl: 'https://two.example.com',
        applicationDomain: null,
        displayName: 'Two',
        installationId: null,
        kind: 'connected',
        proxyUrl: 'https://proxy.two.example.com',
      },
      directory,
    );
    expect(selectPlatformConnection('One', directory).id).toBe(first.id);
    expect(getActivePlatformConnection(directory)?.displayName).toBe('One');
    expect(listPlatformConnections(directory)).toHaveLength(2);
    expect(readFileSync(join(directory, 'registry.json'), 'utf8')).not.toContain('token');
  });

  it('writes and discovers exact installation manifests', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    expect(listInstallationManifests(directory)).toEqual([manifest]);
  });

  it('resolves a local installation slug for selection without changing the default on lookup', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    const connection = savePlatformConnection(
      {
        accountId: manifest.account.id,
        apiUrl: manifest.endpoints.apiUrl!,
        applicationDomain: 'example.com',
        displayName: 'Friendly platform name',
        installationId: manifest.id,
        kind: 'installed',
        proxyUrl: null,
      },
      directory,
    );
    const before = readFileSync(join(directory, 'registry.json'), 'utf8');
    expect(platformConnectionSlug(connection, [manifest])).toBe('example');
    expect(findPlatformConnections('example', directory)).toEqual([connection]);
    expect(readFileSync(join(directory, 'registry.json'), 'utf8')).toBe(before);
    expect(selectPlatformConnection('example', directory).id).toBe(connection.id);
    expect(
      platformConnectionSlug({ ...connection, accountId: 'another-account' }, [manifest]),
    ).toBeNull();
    expect(platformConnectionSlug(connection, [{ ...manifest, status: 'uninstalled' }])).toBeNull();
  });

  it('refuses an ambiguous slug and lets an API URL select the intended account', () => {
    const directory = temporaryRegistry();
    const first = exampleInstallation();
    const second = {
      ...first,
      account: { id: 'account_456', name: 'Other account' },
      id: 'example-other',
    };
    for (const [index, manifest] of [first, second].entries()) {
      writeInstallationManifest(manifest, directory);
      savePlatformConnection(
        {
          accountId: manifest.account.id,
          apiUrl: `https://api-${index}.example.com`,
          applicationDomain: 'example.com',
          displayName: `Platform ${index}`,
          installationId: manifest.id,
          kind: 'installed',
          proxyUrl: null,
        },
        directory,
      );
    }
    expect(findPlatformConnections('example', directory)).toHaveLength(2);
    expect(() => selectPlatformConnection('example', directory)).toThrow('More than one platform');
    expect(selectPlatformConnection('https://api-0.example.com', directory).installationId).toBe(
      first.id,
    );
  });

  it('resolves connection IDs to local installations without changing the active connection', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    const connection = savePlatformConnection(
      {
        accountId: manifest.account.id,
        apiUrl: manifest.endpoints.apiUrl!,
        applicationDomain: 'example.com',
        displayName: 'Saved connection name',
        installationId: manifest.id,
        kind: 'installed',
        proxyUrl: null,
      },
      directory,
    );
    const otherConnection = savePlatformConnection(
      {
        accountId: null,
        apiUrl: 'https://other.example.com',
        applicationDomain: null,
        displayName: 'Other',
        installationId: null,
        kind: 'connected',
        proxyUrl: null,
      },
      directory,
    );
    const registryBeforeLookup = readFileSync(join(directory, 'registry.json'), 'utf8');
    for (const selector of [manifest.id, 'example', 'Example', connection.id]) {
      expect(resolveInstallationManifest(selector, directory)).toEqual(manifest);
    }
    expect(readFileSync(join(directory, 'registry.json'), 'utf8')).toBe(registryBeforeLookup);
    expect(getActivePlatformConnection(directory)?.id).toBe(otherConnection.id);
    expect(() => resolveInstallationManifest(otherConnection.id, directory)).toThrow(
      'No local installation matches',
    );
  });

  it('rejects connection IDs with mismatched, uninstalled, or missing local installations', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    const connection = savePlatformConnection(
      {
        accountId: manifest.account.id,
        apiUrl: manifest.endpoints.apiUrl!,
        applicationDomain: 'example.com',
        displayName: 'Example',
        installationId: manifest.id,
        kind: 'installed',
        proxyUrl: null,
      },
      directory,
    );
    savePlatformConnection({ ...connection, accountId: 'another_account' }, directory);
    expect(() => resolveInstallationManifest(connection.id, directory)).toThrow(
      'No local installation matches',
    );
    savePlatformConnection({ ...connection, accountId: null }, directory);
    expect(resolveInstallationManifest(connection.id, directory)).toEqual(manifest);
    writeInstallationManifest({ ...manifest, status: 'uninstalled' }, directory);
    expect(() => resolveInstallationManifest(connection.id, directory)).toThrow(
      'No local installation matches',
    );
    rmSync(join(directory, manifest.account.id), { recursive: true });
    expect(() => resolveInstallationManifest(connection.id, directory)).toThrow(
      'No local installation matches',
    );
  });

  it('keeps recovery material private and removes it explicitly', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://secret' }, directory);
    expect(readInstallationRecoverySecrets(manifest, directory)).toEqual({
      databaseUrl: 'postgres://secret',
    });
    promoteInstallationSecrets(manifest, directory);
    const recoveryPath = join(directory, 'account_123', 'example-a1b2c3d4.recovery.enc');
    if (process.platform !== 'win32') {
      expect(statSync(recoveryPath).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(recoveryPath, 'utf8')).not.toContain('postgres://secret');
    expect(readInstallationRecoverySecrets(manifest, directory)).toEqual({
      databaseUrl: 'postgres://secret',
    });
    writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://replacement' }, directory);
    promoteInstallationSecrets(manifest, directory);
    expect(readInstallationRecoverySecrets(manifest, directory)).toEqual({
      databaseUrl: 'postgres://replacement',
    });
    removeInstallationRecoverySecrets(manifest, directory);
    expect(readInstallationRecoverySecrets(manifest, directory)).toBeNull();
  });

  it('migrates legacy plaintext recovery material to an encrypted envelope', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    const legacyPath = join(directory, 'account_123', 'example-a1b2c3d4.recovery');
    writeFileSync(legacyPath, JSON.stringify({ databaseUrl: 'postgres://legacy-secret' }), {
      mode: 0o600,
    });

    expect(readInstallationRecoverySecrets(manifest, directory)).toEqual({
      databaseUrl: 'postgres://legacy-secret',
    });
    expect(existsSync(legacyPath)).toBe(false);
    expect(
      readFileSync(join(directory, 'account_123', 'example-a1b2c3d4.recovery.enc'), 'utf8'),
    ).not.toContain('legacy-secret');
  });

  it('authenticates encrypted recovery material to the installation identity', () => {
    const directory = temporaryRegistry();
    const manifest = exampleInstallation();
    writeInstallationManifest(manifest, directory);
    writePendingInstallationSecrets(manifest, { databaseUrl: 'postgres://secret' }, directory);
    promoteInstallationSecrets(manifest, directory);

    expect(() =>
      readInstallationRecoverySecrets(
        { ...manifest, ownershipNonce: 'fedcba9876543210fedcba9876543210' },
        directory,
      ),
    ).toThrow('Could not read encrypted recovery material');
  });
});
