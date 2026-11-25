import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  parsePlatformInstallationManifest,
  transitionInstallation,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';

function manifestAt(status: 'deploying' | 'verifying') {
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    }),
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
  manifest = transitionInstallation(manifest, 'planned', '2026-09-14T00:00:01.000Z');
  manifest = transitionInstallation(manifest, 'provisioning', '2026-09-14T00:00:02.000Z');
  manifest = transitionInstallation(manifest, 'deploying', '2026-09-14T00:00:03.000Z');
  if (status === 'verifying') {
    manifest = transitionInstallation(manifest, 'verifying', '2026-09-14T00:00:04.000Z');
  }
  return manifest;
}

describe('platform installation resume states', () => {
  it('preserves validated lifecycle progress across recovery and accepts older checkpoints', () => {
    const manifest = manifestAt('verifying');
    expect(parsePlatformInstallationManifest(manifest).operation).toBeUndefined();
    const operation = {
      id: 'operation-1',
      action: 'rollback' as const,
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      phase: 'waiting-for-sandbox-drain' as const,
      startedAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    };
    const recovered = parsePlatformInstallationManifest(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise the JSON representation read by the parser.
      JSON.parse(JSON.stringify({ ...manifest, operation })),
    );
    expect(recovered.operation).toEqual(operation);
    expect(() =>
      parsePlatformInstallationManifest({
        ...manifest,
        operation: { ...operation, phase: 'online' },
      }),
    ).toThrow('operation');
    expect(() =>
      parsePlatformInstallationManifest({
        ...manifest,
        operation: { ...operation, updatedAt: 'invalid' },
      }),
    ).toThrow('timestamp');
  });
  it.each(['deploying', 'verifying'] as const)(
    're-enters provisioning from an interrupted %s checkpoint',
    (status) => {
      const resumed = transitionInstallation(
        manifestAt(status),
        'provisioning',
        '2026-09-14T00:00:05.000Z',
      );
      expect(resumed.status).toBe('provisioning');
    },
  );
});
