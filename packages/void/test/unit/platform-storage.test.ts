import { createPlatformDeploymentManifest } from '@void/platform';
import { expect, it } from 'vite-plus/test';
import { assertPlatformStorageSupported } from '../../src/cli/platform-storage.ts';

it('rejects runtimes that would ignore the configured storage location', () => {
  const deployment = createPlatformDeploymentManifest({
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Example',
    installationSlug: 'example',
    storageLocationHint: 'apac',
  });
  expect(() => assertPlatformStorageSupported(deployment, {})).toThrow('storage location hint');
  expect(() =>
    assertPlatformStorageSupported(deployment, { storageLocationHint: 1 }),
  ).not.toThrow();
  expect(() =>
    assertPlatformStorageSupported({ ...deployment, storageLocationHint: undefined }, {}),
  ).not.toThrow();
});
