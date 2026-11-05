import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import type { PlatformRuntime, PlatformRuntimeMigration } from '@void/platform/installer';
import { describe, expect, it } from 'vite-plus/test';
import { assertPlatformRuntimeSafety } from '../../src/cli/platform-installer-database.ts';
import { assertPlatformRollbackCompatibility } from '../../src/cli/platform-management.ts';

const firstMigration: PlatformRuntimeMigration = {
  index: 0,
  sha256: '1'.repeat(64),
  tag: '0000_initial',
  timestampMillis: 1,
};
const secondMigration: PlatformRuntimeMigration = {
  index: 1,
  sha256: '2'.repeat(64),
  tag: '0001_expand',
  timestampMillis: 2,
};

function runtime(input: {
  digest: string;
  migrations: ReadonlyArray<PlatformRuntimeMigration>;
  platformVersion: string;
  rollbackSafeFrom?: ReadonlyArray<{ platformVersion: string; schemaDigest: string }>;
  safety?: 0 | 1;
  schemaDigest: string;
  usageProtocolVersion?: 0 | 1 | 2;
}): PlatformRuntime {
  return {
    directory: `/runtime/${input.digest.slice(0, 4)}`,
    manifest: {
      artifacts: {} as PlatformRuntime['manifest']['artifacts'],
      database: {
        journalSha256: 'f'.repeat(64),
        lineage: 'void-platform-postgresql-v1',
        migrations: input.migrations,
        protocolVersion: 1,
        rollbackSafeFrom: input.rollbackSafeFrom ?? [],
        schemaDigest: input.schemaDigest,
      },
      platformVersion: input.platformVersion,
      safetyProtocols: { sandboxDrain: input.safety ?? 1 },
      schemaVersion: 2,
      sourceRevision: null,
      usageProtocolVersion: input.usageProtocolVersion ?? 1,
    },
    manifestSha256: input.digest,
    source: 'custom',
  };
}

function installed(source: PlatformRuntime) {
  return {
    ...createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-16T00:00:00.000Z',
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: source.manifest.platformVersion,
      safetyProtocols: source.manifest.safetyProtocols,
      usageProtocolVersion: source.manifest.usageProtocolVersion,
    }),
    databaseSchemaDigest: source.manifest.database.schemaDigest,
    runtime: {
      manifestSha256: source.manifestSha256,
      source: source.source,
      sourceRevision: source.manifest.sourceRevision,
    },
  };
}

describe('platform post-success rollback', () => {
  it('blocks rollback to a four-Worker runtime after the email gateway was installed', () => {
    const target = runtime({
      digest: 'a'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.0.0',
      schemaDigest: 'c'.repeat(64),
    });
    const source = runtime({
      digest: 'b'.repeat(64),
      migrations: [firstMigration, secondMigration],
      platformVersion: '1.1.0',
      schemaDigest: 'd'.repeat(64),
      rollbackSafeFrom: [{ platformVersion: '1.0.0', schemaDigest: 'c'.repeat(64) }],
    });
    const installation = installed(source);
    expect(() =>
      assertPlatformRollbackCompatibility(
        {
          ...installation,
          resources: [
            ...installation.resources,
            {
              configHash: '',
              key: 'email-gateway-worker',
              kind: 'worker',
              id: installation.deployment.resources.emailGatewayWorker,
              name: installation.deployment.resources.emailGatewayWorker,
              ownership: 'created',
              state: 'ready',
            },
          ],
        },
        target,
        source,
      ),
    ).toThrow('predates the email gateway');
    expect(() =>
      assertPlatformRollbackCompatibility(
        {
          ...installation,
          deployment: {
            ...installation.deployment,
            capabilities: { ...installation.deployment.capabilities, email: true },
          },
        },
        target,
        source,
      ),
    ).toThrow('predates the email gateway');
  });
  it('blocks a runtime without human-session revocation even when its database rollback is declared safe', () => {
    const target = runtime({
      digest: 'a'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.0.0',
      schemaDigest: 'c'.repeat(64),
    });
    const source = runtime({
      digest: 'b'.repeat(64),
      migrations: [firstMigration, secondMigration],
      platformVersion: '1.1.0',
      schemaDigest: 'd'.repeat(64),
      rollbackSafeFrom: [{ platformVersion: '1.0.0', schemaDigest: 'c'.repeat(64) }],
    });
    const authenticatedSource = {
      ...source,
      manifest: { ...source.manifest, authenticationProtocolVersion: 1 as const },
    };
    expect(() =>
      assertPlatformRollbackCompatibility(
        installed(authenticatedSource),
        target,
        authenticatedSource,
      ),
    ).toThrow('session revocation protocol');
    const authenticatedTarget = {
      ...target,
      manifest: { ...target.manifest, authenticationProtocolVersion: 1 as const },
    };
    expect(() =>
      assertPlatformRollbackCompatibility(
        installed(authenticatedSource),
        authenticatedTarget,
        authenticatedSource,
      ),
    ).not.toThrow();
  });
  it('blocks rollback below the installed ownership-aware usage protocol', () => {
    const target = runtime({
      digest: 'a'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.0.0',
      schemaDigest: 'c'.repeat(64),
      usageProtocolVersion: 1,
    });
    const source = runtime({
      digest: 'b'.repeat(64),
      migrations: [firstMigration, secondMigration],
      platformVersion: '1.1.0',
      rollbackSafeFrom: [{ platformVersion: '1.0.0', schemaDigest: 'c'.repeat(64) }],
      schemaDigest: 'd'.repeat(64),
      usageProtocolVersion: 2,
    });

    expect(() => assertPlatformRollbackCompatibility(installed(source), target, source)).toThrow(
      'ownership-aware usage attribution',
    );
    expect(() =>
      assertPlatformRollbackCompatibility(
        installed(source),
        {
          ...target,
          manifest: { ...target.manifest, usageProtocolVersion: 2 },
        },
        source,
      ),
    ).not.toThrow();
  });
  it('compares artifact digests for same-version custom runtimes', () => {
    const target = runtime({
      digest: 'a'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.0.0',
      schemaDigest: 'c'.repeat(64),
    });
    const source = runtime({
      digest: 'b'.repeat(64),
      migrations: [firstMigration, secondMigration],
      platformVersion: '1.0.0',
      rollbackSafeFrom: [{ platformVersion: '1.0.0', schemaDigest: 'c'.repeat(64) }],
      schemaDigest: 'd'.repeat(64),
    });
    const installation = installed(source);

    expect(() => assertPlatformRollbackCompatibility(installation, target, source)).not.toThrow();
    expect(() =>
      assertPlatformRollbackCompatibility(installation, target, {
        ...source,
        manifestSha256: 'e'.repeat(64),
      }),
    ).toThrow('artifact digest');
  });

  it('refuses rollback to a runtime without minimal runtime logs while they are on', () => {
    const target = runtime({
      digest: 'a'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.0.0',
      schemaDigest: 'c'.repeat(64),
    });
    const source = runtime({
      digest: 'b'.repeat(64),
      migrations: [firstMigration, secondMigration],
      platformVersion: '1.0.0',
      rollbackSafeFrom: [{ platformVersion: '1.0.0', schemaDigest: 'c'.repeat(64) }],
      schemaDigest: 'd'.repeat(64),
    });
    const installation = installed(source);
    const minimal = {
      ...installation,
      deployment: { ...installation.deployment, runtimeLogs: 'minimal' as const },
    };
    expect(() => assertPlatformRollbackCompatibility(minimal, target, source)).toThrow(
      'Run `void platform upgrade --runtime-logs full` first',
    );
    expect(() =>
      assertPlatformRollbackCompatibility(
        minimal,
        { ...target, manifest: { ...target.manifest, runtimeLogs: 1 } },
        source,
      ),
    ).not.toThrow();
    expect(() => assertPlatformRollbackCompatibility(installation, target, source)).not.toThrow();
  });

  it('rejects a runtime that can reopen sandbox creation after drain', () => {
    const legacy = runtime({
      digest: 'a'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.0.0',
      safety: 0,
      schemaDigest: 'c'.repeat(64),
    });

    expect(() =>
      assertPlatformRuntimeSafety(legacy.manifest, { sandboxDrain: 0 }, { sandboxDrain: 1 }),
    ).toThrow('Refusing to upload or activate');
    expect(() =>
      assertPlatformRuntimeSafety(legacy.manifest, { sandboxDrain: 1 }, { sandboxDrain: 0 }),
    ).toThrow('sandbox-drain safety protocol');

    const drainWithoutAdmissionBarrier = runtime({
      digest: 'b'.repeat(64),
      migrations: [firstMigration],
      platformVersion: '1.1.0',
      safety: 1,
      schemaDigest: 'd'.repeat(64),
    });
    expect(() =>
      assertPlatformRuntimeSafety(
        drainWithoutAdmissionBarrier.manifest,
        { sandboxDrain: 1 },
        { sandboxDrain: 2 },
      ),
    ).toThrow('Refusing to upload or activate');
  });
});
