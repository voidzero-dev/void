import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  parsePlatformInstallationManifest,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';

const now = '2026-09-14T00:00:00.000Z';

function installation() {
  return createPlatformInstallationManifest({
    account: { id: 'account-id', name: 'Developer Platform Experience' },
    createdAt: now,
    deployment: createPlatformDeploymentManifest({
      application: { baseDomain: 'example.com', zoneName: 'example.com' },
      displayName: 'Test Platform',
      installationSlug: 'test-platform',
    }),
    id: 'test-platform-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '0.10.13',
  });
}

describe('platform installation manifest', () => {
  it('records exact resource ownership and completed steps', () => {
    let manifest = transitionInstallation(installation(), 'planned', now);
    manifest = transitionInstallation(manifest, 'provisioning', now);
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'namespace-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'void-test-platform-routing',
        ownership: 'created',
        state: 'ready',
      },
      now,
    );
    manifest = recordInstallationStep(
      manifest,
      { completedAt: now, key: 'create-routing-kv', resultHash: 'namespace-id' },
      now,
    );
    expect(parsePlatformInstallationManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
  });

  it('infers disabled intent when reading a legacy disabled manifest', () => {
    const legacy = JSON.parse(JSON.stringify(installation())) as Record<string, unknown>;
    delete legacy.desiredState;
    legacy.status = 'disabled';
    expect(parsePlatformInstallationManifest(legacy).desiredState).toBe('disabled');
  });

  it('preserves validated runtime provenance while accepting older manifests', () => {
    expect(parsePlatformInstallationManifest(installation()).runtime).toBeNull();
    const withRuntime = {
      ...installation(),
      runtime: {
        manifestSha256: 'a'.repeat(64),
        source: 'custom',
        sourceRevision: 'abc1234',
      },
    };
    expect(parsePlatformInstallationManifest(withRuntime).runtime).toEqual(withRuntime.runtime);
    expect(() =>
      parsePlatformInstallationManifest({
        ...withRuntime,
        runtime: { ...withRuntime.runtime, manifestSha256: 'not-a-digest' },
      }),
    ).toThrow('SHA-256');
  });

  it('treats manifests before authenticated usage as protocol zero', () => {
    const legacy = JSON.parse(JSON.stringify(installation())) as Record<string, unknown>;
    delete legacy.usageProtocolVersion;
    expect(parsePlatformInstallationManifest(legacy).usageProtocolVersion).toBe(0);
    expect(
      parsePlatformInstallationManifest({ ...installation(), usageProtocolVersion: 1 })
        .usageProtocolVersion,
    ).toBe(1);
    expect(
      parsePlatformInstallationManifest({ ...installation(), usageProtocolVersion: 2 })
        .usageProtocolVersion,
    ).toBe(2);
    expect(() =>
      parsePlatformInstallationManifest({ ...installation(), usageProtocolVersion: 3 }),
    ).toThrow('usageProtocolVersion must be 0, 1, or 2');
  });

  it('rejects invalid state transitions', () => {
    expect(() => transitionInstallation(installation(), 'installed', now)).toThrow(
      'draft -> installed',
    );
  });

  it('refuses to rewrite a completed step with a different result', () => {
    const manifest = recordInstallationStep(
      installation(),
      { completedAt: now, key: 'step', resultHash: 'first' },
      now,
    );
    expect(() =>
      recordInstallationStep(
        manifest,
        { completedAt: now, key: 'step', resultHash: 'second' },
        now,
      ),
    ).toThrow('different result');
  });

  it('prevents one resource id from being claimed by two logical resources', () => {
    const manifest = recordInstallationResource(
      installation(),
      {
        configHash: 'hash',
        id: 'shared-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'routing',
        ownership: 'created',
        state: 'ready',
      },
      now,
    );
    expect(() =>
      recordInstallationResource(
        manifest,
        {
          configHash: 'hash',
          id: 'shared-id',
          key: 'isr-kv',
          kind: 'kv-namespace',
          name: 'isr',
          ownership: 'created',
          state: 'ready',
        },
        now,
      ),
    ).toThrow('already owned');
  });
});
