import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformRuntimeManifest, platformDatabaseSchemaDigest } from '../../src/installer.ts';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';

describe('configurable authentication deployment manifests', () => {
  it.each(['google', 'oidc', 'cloudflare-access'] as const)(
    'round-trips %s without enabling GitHub',
    (kind) => {
      const manifest = createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Team',
        installationSlug: 'team',
        authentication: { providers: [kind], configurable: true },
        capabilities: { githubOAuth: false, googleOAuth: kind === 'google' },
      });
      expect(manifest.schemaVersion).toBe(3);
      expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
    },
  );
  it('supports workers.dev with independently selected Access protection', () => {
    const manifest = createPlatformDeploymentManifest({
      application: {
        baseDomain: 'team.workers.dev',
        zoneName: '',
        workersDev: { subdomain: 'team', installationId: 'team-12345678' },
      },
      displayName: 'Team',
      installationSlug: 'team',
      authentication: { providers: ['github'], accessProtection: true },
    });
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.authentication.configurable).toBe(true);
    expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
  });
  it('keeps legacy manifests unchanged and rejects stripping the new contract into an old version', () => {
    const legacy = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Team',
      installationSlug: 'team',
    });
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.authentication).toEqual({ providers: ['github'] });
    expect(() =>
      parsePlatformDeploymentManifest({
        ...legacy,
        authentication: { ...legacy.authentication, configurable: true },
      }),
    ).toThrow('schema version 3');
  });
});

describe('security audits deployment manifests', () => {
  const input = {
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Team',
    installationSlug: 'team',
  };
  const roundTrip = (manifest: unknown) =>
    parsePlatformDeploymentManifest(JSON.parse(JSON.stringify(manifest)));

  it('keeps the schema version and reads a missing capability as off', () => {
    const manifest = createPlatformDeploymentManifest(input);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.capabilities.securityAudits).toBe(false);
    const { securityAudits: _, ...olderCapabilities } = manifest.capabilities;
    const older = { ...manifest, capabilities: olderCapabilities };
    expect(roundTrip(older)).toEqual(manifest);
  });

  it('writes schema version 7 when on and round-trips it', () => {
    const manifest = createPlatformDeploymentManifest({
      ...input,
      capabilities: { securityAudits: true },
    });
    expect(manifest.schemaVersion).toBe(7);
    expect(manifest).not.toHaveProperty('runtimeLogs');
    expect(manifest).not.toHaveProperty('storageLocationHint');
    expect(manifest).not.toHaveProperty('appAccess');
    expect(roundTrip(manifest)).toEqual(manifest);
  });

  it('keeps every other setting at schema version 7', () => {
    const manifest = createPlatformDeploymentManifest({
      ...input,
      appAccess: 'platform',
      authentication: { providers: ['oidc'], configurable: true },
      capabilities: { githubOAuth: false, securityAudits: true },
      runtimeLogs: 'minimal',
      storageLocationHint: 'apac',
    });
    expect(manifest.schemaVersion).toBe(7);
    expect(roundTrip(manifest)).toEqual(manifest);
    expect(manifest).toMatchObject({
      appAccess: 'platform',
      authentication: { providers: ['oidc'], configurable: true },
      runtimeLogs: 'minimal',
      storageLocationHint: 'apac',
    });
  });

  it.each([1, 2, 3, 4, 5, 6])('refuses the capability at schema version %i', (schemaVersion) => {
    const manifest = createPlatformDeploymentManifest({
      ...input,
      // Version 2 is the workers.dev document, so give it one.
      ...(schemaVersion === 2
        ? {
            application: {
              baseDomain: 'team.workers.dev',
              zoneName: '',
              workersDev: { subdomain: 'team', installationId: 'team-12345678' },
            },
          }
        : {}),
      capabilities: { securityAudits: true },
    });
    expect(() => roundTrip({ ...manifest, schemaVersion })).toThrow(
      'Security audits require deployment schema version 7.',
    );
  });

  it('refuses schema version 7 without the capability', () => {
    const manifest = createPlatformDeploymentManifest(input);
    expect(() => roundTrip({ ...manifest, schemaVersion: 7 })).toThrow(
      'Deployment schema version 7 requires capabilities.securityAudits.',
    );
    const { securityAudits: _, ...olderCapabilities } = manifest.capabilities;
    expect(() =>
      roundTrip({ ...manifest, capabilities: olderCapabilities, schemaVersion: 7 }),
    ).toThrow('Deployment schema version 7 requires capabilities.securityAudits.');
  });

  it('refuses a schema version newer than 7', () => {
    const manifest = createPlatformDeploymentManifest({
      ...input,
      capabilities: { securityAudits: true },
    });
    expect(() => roundTrip({ ...manifest, schemaVersion: 8 })).toThrow(
      'Unsupported platform deployment schema version: 8.',
    );
  });

  it.each(['true', 1, null])('rejects securityAudits %j', (securityAudits) => {
    const manifest = createPlatformDeploymentManifest(input);
    expect(() =>
      roundTrip({ ...manifest, capabilities: { ...manifest.capabilities, securityAudits } }),
    ).toThrow('capabilities.securityAudits must be a boolean.');
  });

  it('validates the storage hint when present at schema version 7', () => {
    const manifest = createPlatformDeploymentManifest({
      ...input,
      capabilities: { securityAudits: true },
    });
    expect(() => roundTrip({ ...manifest, storageLocationHint: 'APAC' })).toThrow(
      'storageLocationHint',
    );
    expect(() => roundTrip({ ...manifest, runtimeLogs: 'full' })).toThrow('runtime logs');
  });
});

describe('runtime manifest securityAudits protocol', () => {
  const digest = '0'.repeat(64);
  const artifact = (path: string) => ({ path, sha256: digest, size: 1 });
  const runtime = {
    artifacts: {
      api: artifact('api.mjs'),
      dispatch: artifact('dispatch.mjs'),
      proxy: artifact('proxy.mjs'),
      tail: artifact('tail.mjs'),
    },
    database: {
      journalSha256: digest,
      lineage: 'void',
      migrations: [],
      protocolVersion: 1,
      rollbackSafeFrom: [],
      schemaDigest: platformDatabaseSchemaDigest('void', []),
    },
    platformVersion: '1.0.0',
    schemaVersion: 2,
  };

  it('leaves the protocol out of older runtime manifests', () => {
    expect(parsePlatformRuntimeManifest(runtime)).not.toHaveProperty('securityAudits');
  });

  it('accepts and keeps securityAudits: 1', () => {
    expect(parsePlatformRuntimeManifest({ ...runtime, securityAudits: 1 }).securityAudits).toBe(1);
  });

  it.each([0, 2, '1', true, null])('rejects securityAudits %j', (securityAudits) => {
    expect(() => parsePlatformRuntimeManifest({ ...runtime, securityAudits })).toThrow(
      'Unsupported security audits protocol.',
    );
  });
});
