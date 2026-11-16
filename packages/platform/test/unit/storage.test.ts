import { describe, expect, it } from 'vite-plus/test';
import { parsePlatformRuntimeManifest, platformDatabaseSchemaDigest } from '../../src/installer.ts';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';
import { deploymentInput, workerConfigs } from '../worker-config-fixture.ts';

describe('platform storage location', () => {
  it.each([undefined, 'minimal'] as const)(
    'persists the hint alongside runtime logs %s',
    (runtimeLogs) => {
      const deployment = createPlatformDeploymentManifest({
        ...deploymentInput,
        storageLocationHint: 'apac',
        runtimeLogs,
        appAccess: 'public',
      });
      expect(deployment.schemaVersion).toBe(6);
      expect(parsePlatformDeploymentManifest(JSON.parse(JSON.stringify(deployment)))).toEqual(
        deployment,
      );
      expect(workerConfigs({ deployment }).api.vars).toHaveProperty('R2_LOCATION_HINT', 'apac');
      expect(workerConfigs().api.vars).not.toHaveProperty('R2_LOCATION_HINT');
      expect(() =>
        parsePlatformDeploymentManifest({ ...deployment, schemaVersion: runtimeLogs ? 5 : 4 }),
      ).toThrow('storageLocationHint');
    },
  );
  it.each(['APAC', '', null, 1, undefined])(
    'rejects invalid persisted hints %j',
    (storageLocationHint) => {
      const deployment = createPlatformDeploymentManifest({
        ...deploymentInput,
        storageLocationHint: 'apac',
      });
      expect(() => parsePlatformDeploymentManifest({ ...deployment, storageLocationHint })).toThrow(
        'storageLocationHint',
      );
    },
  );
});

it('validates and retains the runtime storage location capability', () => {
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
  expect(parsePlatformRuntimeManifest(runtime)).not.toHaveProperty('storageLocationHint');
  expect(
    parsePlatformRuntimeManifest({ ...runtime, storageLocationHint: 1 }).storageLocationHint,
  ).toBe(1);
  for (const value of [0, 2, '1', true, null]) {
    expect(() => parsePlatformRuntimeManifest({ ...runtime, storageLocationHint: value })).toThrow(
      'storage location',
    );
  }
});
