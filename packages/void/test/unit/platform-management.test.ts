vi.mock('../../src/cli/output.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/output.ts')>()),
  printSuccess: vi.fn(),
}));
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  PLATFORM_DISABLED_KEY,
  PLATFORM_DISABLED_VALUE,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
} from '@void/platform';
import type {
  InstallationResourceKind,
  PlatformInstallationManifest,
  ResourceOwnership,
} from '@void/platform';
import { note } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { printSuccess } from '../../src/cli/output.ts';
import {
  disablePlatform,
  resolvePlatformRuntimeTokenToPreflight,
  resolveInstalledPlatformManifest,
  selectAuthoritativePlatformManifest,
  uninstallPlatform,
  verifyPlatformInstallationOwnership,
} from '../../src/cli/platform-management.ts';
import {
  platformAdoptionIntentHash,
  platformProvisionIntentHash,
} from '../../src/cli/platform-plan.ts';
import {
  listInstallationManifests,
  readInstallationRecoverySecrets,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';
import { recordPlatformWorkerTraffic } from '../../src/cli/platform-traffic.ts';
import {
  projectZeroTrustUninstallState,
  readPlatformProjectZeroTrustStateConnection,
} from '../../src/cli/platform-zero-trust-uninstall.ts';
import {
  expectInOrder,
  noteText,
  ownershipMarker,
  persistInstallation,
} from '../helpers/platform-installation.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => {
  const actual = await original<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return { ...actual, log: { ...actual.log, step: vi.fn(), success: vi.fn() }, note: vi.fn() };
});

const directories: Array<string> = [];

beforeEach(() => {
  vi.mocked(note).mockClear();
  vi.mocked(printSuccess).mockClear();
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function installedManifest(zoneOwnership: ResourceOwnership = 'created') {
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
  const resources: Array<[string, InstallationResourceKind, ResourceOwnership]> = [
    ['zone', 'zone', zoneOwnership],
    ['application-dns', 'dns-record', 'created'],
    ['ai-gateway', 'ai-gateway', 'created'],
    ['routing-kv', 'kv-namespace', 'created'],
    ['isr-cache-kv', 'kv-namespace', 'created'],
    ['legacy-assets-kv', 'kv-namespace', 'created'],
    ['assets-bucket', 'r2-bucket', 'created'],
    ['usage-queue', 'queue', 'created'],
    ['cron-queue', 'queue', 'created'],
    ['dispatch-namespace', 'dispatch-namespace', 'created'],
    ['hyperdrive', 'hyperdrive', 'created'],
    ['api-worker', 'worker', 'created'],
    ['proxy-worker', 'worker', 'created'],
    ['tail-worker', 'worker', 'created'],
    ['dispatch-worker', 'worker', 'created'],
  ];
  for (const [key, kind, ownership] of resources) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash:
          kind === 'dns-record'
            ? createHash('sha256')
                .update(
                  JSON.stringify({
                    content: '100::',
                    kind: 'dns-record',
                    name: key,
                    proxied: true,
                    type: 'AAAA',
                  }),
                )
                .digest('hex')
            : kind === 'r2-bucket'
              ? createHash('sha256')
                  .update(
                    JSON.stringify({
                      fingerprint: '2026-09-14T00:00:00.000Z',
                      kind: 'r2-bucket',
                      name: key,
                    }),
                  )
                  .digest('hex')
              : 'hash',
        id: kind === 'worker' ? `void-example-${key.replace('-worker', '')}` : `${key}-id`,
        key,
        kind,
        name: key,
        ownership,
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
  }
  for (const status of [
    'planned',
    'provisioning',
    'deploying',
    'verifying',
    'installed',
  ] as const) {
    manifest = transitionInstallation(manifest, status, '2026-09-14T00:00:02.000Z');
  }
  return manifest;
}

function client(manifest: PlatformInstallationManifest) {
  const deleted: Array<[string, string]> = [];
  const emptiedBuckets: Array<string> = [];
  const deletedBucketMarkers: Array<string> = [];
  const remoteWrites: Array<string> = [];
  const disabledWrites: Array<string> = [];
  const deletedKvValues: Array<string> = [];
  const fake = {
    deleted,
    emptiedBuckets,
    deletedBucketMarkers,
    remoteWrites,
    disabledWrites,
    deletedKvValues,
    deleteResource: async (
      _account: string,
      { id, kind }: Readonly<{ id: string; kind: string; name: string }>,
    ): Promise<void> => {
      // Like Cloudflare, refuse to delete a Queue while a platform Worker
      // still binds it.
      const bindingWorker = (await fake.listWorkerNames())[0];
      if (kind === 'queue' && bindingWorker) {
        throw new Error(
          `Cloudflare API error: Cannot delete queue '${id}' that is still referenced by a binding in a Worker. Unbind queue '${id}' from the Workers '${bindingWorker}'; then try again. (HTTP 400)`,
        );
      }
      deleted.push([kind, id]);
    },
    deleteKvValue: async (_account: string, _namespace: string, key: string) => {
      deletedKvValues.push(key);
    },
    deleteR2Object: async (_account: string, bucket: string) => {
      deletedBucketMarkers.push(bucket);
    },
    emptyR2Bucket: async (_account: string, bucket: string) => {
      emptiedBuckets.push(bucket);
    },
    findZone: async (_account: string, name: string) => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'zone' && entry.name === name && entry.state === 'ready',
      );
      return resource
        ? { id: resource.id, name: resource.name, nameServers: [], status: 'active' }
        : null;
    },
    getHyperdriveConfig: async (_account: string, id: string) => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'hyperdrive' && entry.id === id && entry.state === 'ready',
      );
      if (!resource) {
        throw new Error('missing Hyperdrive');
      }
      return {
        id: resource.id,
        name: resource.name,
        origin: {
          database: 'void',
          host: 'db.example.com',
          port: 5432,
          scheme: 'postgresql' as const,
          user: 'user',
        },
      };
    },
    getKvValue: async (): Promise<string | null> => JSON.stringify(manifest),
    getR2Object: async () => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'r2-bucket' && entry.state === 'ready',
      );
      return resource ? ownershipMarker(manifest, resource) : null;
    },
    getWorkerPlainTextBindings: async (
      _account: string,
      name: string,
    ): Promise<Record<string, string>> => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name && entry.state === 'ready',
      );
      if (!resource) {
        return {};
      }
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    },
    listAiGateways: async () => namedResources(manifest, 'ai-gateway'),
    listDispatchNamespaces: async () => namedResources(manifest, 'dispatch-namespace'),
    listDnsRecords: async (_zone: string, name: string) =>
      namedResources(manifest, 'dns-record')
        .filter((resource) => resource.name === name)
        .map((resource) => ({ ...resource, content: '100::', proxied: true, type: 'AAAA' })),
    listHyperdriveConfigs: async () => namedResources(manifest, 'hyperdrive'),
    listKvNamespaces: async () => namedResources(manifest, 'kv-namespace'),
    listQueues: async (_account: string, name: string) =>
      namedResources(manifest, 'queue').filter((resource) => resource.name === name),
    listR2Buckets: async () =>
      namedResources(manifest, 'r2-bucket').map((resource) => ({
        ...resource,
        fingerprint: '2026-09-14T00:00:00.000Z',
      })),
    listWorkerDomains: async (): Promise<
      Array<{ hostname: string; id: string; service: string }>
    > => [],
    listWorkerNames: async () =>
      namedResources(manifest, 'worker').map((resource) => resource.name),
    listWorkerServiceRoutes: async (
      _accountId: string,
      _workerName: string,
    ): Promise<Array<{ pattern: string; zoneName: string }>> => [],
    putKvValue: async (_account: string, _namespace: string, key: string, value: string) => {
      if (key === PLATFORM_DISABLED_KEY) {
        disabledWrites.push(value);
      } else {
        remoteWrites.push(value);
      }
    },
    // Only --purge-resources calls these; platform-teardown.test.ts covers it.
    deleteAccessResource: unexpectedPurgeCall,
    deleteDispatchNamespaceScript: unexpectedPurgeCall,
    deleteEmailRoutingRule: unexpectedPurgeCall,
    deleteQueueConsumer: unexpectedPurgeCall,
    deleteWorkerDomain: unexpectedPurgeCall,
    deleteWorkerRoute: unexpectedPurgeCall,
    forceDeleteWorker: unexpectedPurgeCall,
    getAccessResource: unexpectedPurgeCall,
    getEmailRoutingCatchAll: unexpectedPurgeCall,
    listDispatchNamespaceScripts: unexpectedPurgeCall,
    listEmailRoutingRules: unexpectedPurgeCall,
    listQueueConsumers: unexpectedPurgeCall,
    listWorkerDependents: unexpectedPurgeCall,
    listWorkerRoutes: unexpectedPurgeCall,
    resetEmailRoutingCatchAll: unexpectedPurgeCall,
  };
  return fake;
}

async function unexpectedPurgeCall(): Promise<never> {
  throw new Error('Unexpected --purge-resources Cloudflare call.');
}

function namedResources(manifest: PlatformInstallationManifest, kind: InstallationResourceKind) {
  return manifest.resources
    .filter((resource) => resource.kind === kind && resource.state === 'ready')
    .map((resource) => ({ id: resource.id, name: resource.name }));
}

function trafficRetentionSteps(): Array<string> {
  return (listInstallationManifests()[0]?.steps ?? [])
    .map((step) => step.key)
    .filter((key) => /^disable:\d+:routes$|^uninstall:routes:/.test(key));
}

const uninstallArgs = {
  subcommand: 'uninstall' as const,
  selector: '',
  plan: false,
  purgeData: false,
  purgeResources: false,
  yes: true,
};

const unlockedProjectZeroTrust = {
  lockProjectZeroTrust: async () => async () => {},
  fenceProjectZeroTrust: async () => {},
  liftProjectZeroTrustFence: async () => {},
};

const uninstallDependencies = {
  interactive: false,
  ...unlockedProjectZeroTrust,
  readProjectZeroTrust: async () => projectZeroTrustUninstallState(undefined, []),
};

const wildcardName = 'void-example-a1b2c3d4-0123456789abcdef-aaaa-project-zero-trust';
const healthName = 'void-example-a1b2c3d4-0123456789abcdef-bbbb-platform-health';

function zeroTrustSetting(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    revision: 4,
    enabled: true,
    protectNewProjects: false,
    accountId: 'account',
    teamDomain: 'https://example.cloudflareaccess.com',
    identityProviderIds: ['idp'],
    policyIds: ['policy'],
    credential: { ciphertext: 'c', iv: 'i', keyVersion: 'v1' },
    wildcardApplicationName: wildcardName,
    wildcardApplication: {
      id: 'wildcard-app',
      name: wildcardName,
      audience: 'wildcard-aud',
      destinations: ['*.apps.example.com'],
    },
    healthApplicationName: healthName,
    healthApplication: {
      id: 'health-app',
      name: healthName,
      audience: 'health-aud',
      destinations: ['void-platform-health.apps.example.com/health'],
    },
    operation: null,
    lastError: null,
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

const disabledZeroTrust = zeroTrustSetting({
  enabled: false,
  wildcardApplication: null,
  healthApplication: null,
});

function projectApplications(projectId: string, bypass: string | null, custom: string | null) {
  return {
    project_id: projectId,
    bypass_application_id: bypass ? `${bypass}-id` : null,
    bypass_application_name: bypass,
    protected_application_id: custom ? `${custom}-id` : null,
    protected_application_name: custom,
  };
}

describe('uninstall with project Zero Trust', () => {
  function expectNothingChanged(fake: ReturnType<typeof client>) {
    expect(fake.disabledWrites).toEqual([]);
    expect(fake.remoteWrites).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(trafficRetentionSteps()).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  }

  it('refuses before any change while Zero Trust is enabled', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const error = await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
      readProjectZeroTrust: async () =>
        projectZeroTrustUninstallState(zeroTrustSetting(), [
          projectApplications('proj_public', 'void-example-public-proj_public', null),
        ]),
    }).catch((reason: unknown) => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('Refusing to uninstall while project Zero Trust is enabled');
    expect(error!.message).toContain('`void platform zero-trust disable`');
    expect(error!.message).toContain('*.apps.example.com');
    expect(error!.message).toContain(`shared project application: ${wildcardName} (wildcard-app)`);
    expect(error!.message).toContain(`health check exception: ${healthName} (health-app)`);
    expect(error!.message).toContain(
      'public exception for proj_public: void-example-public-proj_public',
    );
    expect(error!.message).toContain('Zero Trust → Access → Applications');
    expectNothingChanged(fake);
  });

  it('shows the same refusal in the plan', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await expect(
      uninstallPlatform(
        fake,
        manifest,
        { ...uninstallArgs, plan: true },
        {
          interactive: false,
          readProjectZeroTrust: async () => projectZeroTrustUninstallState(zeroTrustSetting(), []),
        },
      ),
    ).rejects.toThrow('Refusing to uninstall while project Zero Trust is enabled');
    expectNothingChanged(fake);
  });

  it('refuses while an unfinished operation may still own applications', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const error = await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
      readProjectZeroTrust: async () =>
        projectZeroTrustUninstallState(
          zeroTrustSetting({
            enabled: false,
            wildcardApplication: null,
            healthApplication: null,
            operation: { id: 'operation', kind: 'configure', phase: 'wildcard' },
          }),
          [],
        ),
    }).catch((reason: unknown) => reason as Error);
    expect(error!.message).toContain('Refusing to uninstall while project Zero Trust is enabled');
    expect(error!.message).toContain(`shared project application: ${wildcardName}`);
    expectNothingChanged(fake);
  });

  it('refuses while a finished disable left project applications behind', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const error = await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
      readProjectZeroTrust: async () =>
        projectZeroTrustUninstallState(disabledZeroTrust, [
          projectApplications('proj_skipped', 'void-example-public-proj_skipped', null),
        ]),
    }).catch((reason: unknown) => reason as Error);
    expect(error!.message).toContain(
      'Refusing to uninstall while Void-managed Access applications from project Zero Trust remain',
    );
    expect(error!.message).toContain(
      'public exception for proj_skipped: void-example-public-proj_skipped (void-example-public-proj_skipped-id)',
    );
    expect(error!.message).not.toContain(wildcardName);
    expectNothingChanged(fake);
  });

  it('points to finishing the deletion of a project that stopped partway', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const read = (rows: Parameters<typeof projectZeroTrustUninstallState>[1]) => () =>
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...unlockedProjectZeroTrust,
        readProjectZeroTrust: async () => projectZeroTrustUninstallState(disabledZeroTrust, rows),
      }).catch((reason: unknown) => reason as Error);
    const deleting = {
      ...projectApplications('proj_gone', 'void-example-public-proj_gone', null),
      project_slug: 'gone-app',
      project_status: 'deleting',
    };

    const onlyDeleting = (await read([deleting])())!;
    expect(onlyDeleting.message).toContain(
      'public exception for proj_gone: void-example-public-proj_gone',
    );
    expect(onlyDeleting.message).toContain('Deletion of project gone-app stopped');
    expect(onlyDeleting.message).toContain('Rerun `void project delete <name>`');
    expect(onlyDeleting.message).not.toContain('Hourly maintenance');

    const mixed = (await read([
      deleting,
      {
        ...projectApplications('proj_live', 'void-example-public-proj_live', null),
        project_slug: 'live-app',
        project_status: 'active',
      },
    ])())!;
    expect(mixed.message).toContain('Deletion of project gone-app stopped');
    expect(mixed.message).not.toContain('live-app');
    expect(mixed.message).toContain('Hourly maintenance retries the other applications');
    expectNothingChanged(fake);
  });

  it('refuses when the Zero Trust state cannot be read', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const error = await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
      readProjectZeroTrust: async () => {
        throw new Error('platform: connect ECONNREFUSED');
      },
    }).catch((reason: unknown) => reason as Error);
    expect(error!.message).toContain(
      'Refusing to uninstall because the project Zero Trust state could not be read from the platform database: connect ECONNREFUSED',
    );
    expect(error!.message).toContain('VOID_PLATFORM_DATABASE_URL');
    expectNothingChanged(fake);

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, { interactive: false }),
    ).rejects.toThrow('no platform database connection is available');
    expectNothingChanged(fake);
  });

  it('refuses when the saved configuration is malformed', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        readProjectZeroTrust: async () =>
          projectZeroTrustUninstallState(zeroTrustSetting({ enabled: 'yes' }), []),
      }),
    ).rejects.toThrow('the saved Zero Trust configuration is malformed');
    expectNothingChanged(fake);
  });

  it.each([
    ['was never configured', undefined],
    ['is fully disabled', disabledZeroTrust],
  ])('proceeds when Zero Trust %s', async (_label, setting) => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
      ...unlockedProjectZeroTrust,
      readProjectZeroTrust: async () =>
        projectZeroTrustUninstallState(setting, [projectApplications('proj_settled', null, null)]),
    });
    expect(fake.disabledWrites).toEqual([PLATFORM_DISABLED_VALUE]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  // Models the PostgreSQL advisory lock and the uninstall fence: an API Zero
  // Trust writer that asks for the lock while uninstall holds it gets it only
  // after the release, then refuses if the fence is still in place.
  function zeroTrustLock(events: Array<string>) {
    let release: (() => void) | undefined;
    let free = Promise.resolve();
    let fence = false;
    return {
      get fenced() {
        return fence;
      },
      dependencies: {
        lockProjectZeroTrust: async () => {
          await free;
          free = new Promise<void>((resolve) => {
            release = resolve;
          });
          events.push('lock');
          return async () => {
            events.push('unlock');
            release!();
          };
        },
        fenceProjectZeroTrust: async () => {
          fence = true;
          events.push('fence');
        },
        liftProjectZeroTrustFence: async () => {
          fence = false;
          events.push('lift fence');
        },
      },
      writer: async () => {
        await free;
        events.push(fence ? 'zero-trust write refused' : 'zero-trust write');
      },
    };
  }

  it('refuses Zero Trust writers that were waiting on the lock once traffic is disabled', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const events: Array<string> = [];
    const putKvValue = fake.putKvValue;
    fake.putKvValue = async (account, namespace, key, value) => {
      if (key === PLATFORM_DISABLED_KEY) {
        events.push('disable traffic');
      }
      await putKvValue(account, namespace, key, value);
    };
    const gate = zeroTrustLock(events);
    let writer: Promise<void> | undefined;
    await uninstallPlatform(fake, manifest, uninstallArgs, {
      interactive: false,
      ...gate.dependencies,
      readProjectZeroTrust: async () => {
        events.push('check');
        if (events.includes('lock')) {
          // A configure request admitted before traffic was disabled arrives
          // right after the final check and waits on the lock.
          writer = gate.writer();
        }
        return projectZeroTrustUninstallState(disabledZeroTrust, []);
      },
    });
    await writer;
    expect(events).toEqual([
      'check',
      'lock',
      'check',
      'fence',
      'disable traffic',
      'unlock',
      'zero-trust write refused',
    ]);
    expect(gate.fenced).toBe(true);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('lifts the fence when uninstall stops before it disables traffic', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const events: Array<string> = [];
    fake.putKvValue = async () => {
      throw new Error('KV write failed');
    };
    const gate = zeroTrustLock(events);
    let writer: Promise<void> | undefined;
    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...gate.dependencies,
        readProjectZeroTrust: async () => {
          if (events.includes('lock')) {
            writer = gate.writer();
          }
          return projectZeroTrustUninstallState(disabledZeroTrust, []);
        },
      }),
    ).rejects.toThrow('KV write failed');
    await writer;
    // The platform still serves traffic, so the waiting writer proceeds.
    expect(events).toEqual(['lock', 'fence', 'lift fence', 'unlock', 'zero-trust write']);
    expect(gate.fenced).toBe(false);
    expect(fake.disabledWrites).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('failed');
  });

  it('keeps the fence when uninstall fails after it started disabling traffic', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const events: Array<string> = [];
    const putKvValue = fake.putKvValue;
    fake.putKvValue = async (account, namespace, key, value) => {
      if (key === PLATFORM_DISABLED_KEY) {
        events.push('disable traffic');
        throw new Error('KV write failed after it was applied');
      }
      await putKvValue(account, namespace, key, value);
    };
    const gate = zeroTrustLock(events);
    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...gate.dependencies,
        readProjectZeroTrust: async () => projectZeroTrustUninstallState(disabledZeroTrust, []),
      }),
    ).rejects.toThrow('KV write failed after it was applied');
    // Only enabling the platform again lifts the fence.
    expect(events).toEqual(['lock', 'fence', 'disable traffic', 'unlock']);
    expect(gate.fenced).toBe(true);
    expect(listInstallationManifests()[0]?.status).toBe('failed');
  });

  it('checks again under the lock and refuses when Zero Trust changed after the first check', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const events: Array<string> = [];
    const gate = zeroTrustLock(events);
    const states = [
      projectZeroTrustUninstallState(disabledZeroTrust, []),
      projectZeroTrustUninstallState(
        zeroTrustSetting({
          enabled: false,
          wildcardApplication: null,
          healthApplication: null,
          operation: { id: 'operation', kind: 'configure', phase: 'seed' },
        }),
        [],
      ),
    ];
    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...gate.dependencies,
        readProjectZeroTrust: async () => states.shift()!,
      }),
    ).rejects.toThrow('Refusing to uninstall while project Zero Trust is enabled');
    expect(events).toEqual(['lock', 'unlock']);
    expect(gate.fenced).toBe(false);
    expectNothingChanged(fake);
  });

  describe('before any platform user exists', () => {
    const noUser = () => ({
      ...projectZeroTrustUninstallState(zeroTrustSetting(), []),
      usersExist: false,
    });

    it('turns off Zero Trust through the platform API before taking the lock', async () => {
      const manifest = installedManifest();
      persistInstallation(manifest, directories);
      const fake = client(manifest);
      const events: Array<string> = [];
      const putKvValue = fake.putKvValue;
      fake.putKvValue = async (account, namespace, key, value) => {
        if (key === PLATFORM_DISABLED_KEY) {
          events.push('disable traffic');
        }
        await putKvValue(account, namespace, key, value);
      };
      let turnedOff = false;
      await uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...zeroTrustLock(events).dependencies,
        readProjectZeroTrust: async () => {
          events.push('check');
          return turnedOff ? projectZeroTrustUninstallState(disabledZeroTrust, []) : noUser();
        },
        turnOffProjectZeroTrust: async () => {
          events.push('turn off');
          turnedOff = true;
        },
      });
      expect(events).toEqual([
        'check',
        'turn off',
        'lock',
        'check',
        'fence',
        'disable traffic',
        'unlock',
      ]);
      expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    });

    it('lists the applications it will delete in the plan without changing anything', async () => {
      const manifest = installedManifest();
      persistInstallation(manifest, directories);
      const fake = client(manifest);
      const turnOff = vi.fn();
      await uninstallPlatform(
        fake,
        manifest,
        { ...uninstallArgs, plan: true },
        {
          interactive: false,
          readProjectZeroTrust: async () => noUser(),
          turnOffProjectZeroTrust: turnOff,
        },
      );
      const plan = noteText('Uninstall plan');
      expect(plan).toContain(
        'Turn off project Zero Trust; no platform user exists yet. Delete its Access applications:',
      );
      expect(plan).toContain(`shared project application: ${wildcardName} (wildcard-app)`);
      expect(turnOff).not.toHaveBeenCalled();
      expectNothingChanged(fake);
    });

    it('keeps refusing once a platform user exists', async () => {
      const manifest = installedManifest();
      persistInstallation(manifest, directories);
      const fake = client(manifest);
      const turnOff = vi.fn();
      await expect(
        uninstallPlatform(fake, manifest, uninstallArgs, {
          interactive: false,
          ...unlockedProjectZeroTrust,
          readProjectZeroTrust: async () => ({ ...noUser(), usersExist: true }),
          turnOffProjectZeroTrust: turnOff,
        }),
      ).rejects.toThrow('Run `void platform zero-trust disable`');
      expect(turnOff).not.toHaveBeenCalled();
      expectNothingChanged(fake);
    });

    it('points to the installing computer instead of an administrator command', async () => {
      const manifest = installedManifest();
      persistInstallation(manifest, directories);
      const fake = client(manifest);
      const error = await uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...unlockedProjectZeroTrust,
        readProjectZeroTrust: async () => noUser(),
      }).catch((reason: unknown) => reason as Error);
      expect(error!.message).toContain('Refusing to uninstall while project Zero Trust is enabled');
      expect(error!.message).toContain(
        'No platform user exists yet. Run this command on the computer that installed the platform',
      );
      expect(error!.message).not.toContain('Run `void platform zero-trust disable`');
      expectNothingChanged(fake);
    });

    it('stops before any change when turning off fails', async () => {
      const manifest = installedManifest();
      persistInstallation(manifest, directories);
      const fake = client(manifest);
      const events: Array<string> = [];
      await expect(
        uninstallPlatform(fake, manifest, uninstallArgs, {
          interactive: false,
          ...zeroTrustLock(events).dependencies,
          readProjectZeroTrust: async () => noUser(),
          turnOffProjectZeroTrust: async () => {
            throw new Error('platform: Project Zero Trust is still turning off.');
          },
        }),
      ).rejects.toThrow('Project Zero Trust is still turning off.');
      expect(events).toEqual([]);
      expectNothingChanged(fake);
    });
  });

  it('refuses without a database session that can hold off Zero Trust changes', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        readProjectZeroTrust: async () => projectZeroTrustUninstallState(undefined, []),
      }),
    ).rejects.toThrow('no platform database connection is available');
    const { fenceProjectZeroTrust: _fence, ...withoutFence } = unlockedProjectZeroTrust;
    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, {
        interactive: false,
        ...withoutFence,
        readProjectZeroTrust: async () => projectZeroTrustUninstallState(undefined, []),
      }),
    ).rejects.toThrow('no platform database connection is available');
    expectNothingChanged(fake);
  });
});

describe('project Zero Trust database read', () => {
  function connection(
    tables: { settings: boolean; projects: boolean; users?: boolean },
    setting: unknown,
    usersExist = false,
  ) {
    const queries: Array<string> = [];
    return {
      queries,
      query: async (sql: string, values?: ReadonlyArray<unknown>) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) {
          return { rows: [tables] };
        }
        if (sql.includes('FROM "users"')) {
          return { rows: [{ present: usersExist }] };
        }
        if (sql.includes('"platform_settings"')) {
          expect(values).toEqual(['zeroTrust.configuration']);
          return { rows: setting === undefined ? [] : [{ value: setting }] };
        }
        return {
          rows: [projectApplications('proj_public', 'void-example-public-proj_public', null)],
        };
      },
    };
  }

  it('treats a database without Zero Trust tables as never configured', async () => {
    const db = connection({ settings: false, projects: false }, undefined);
    await expect(readPlatformProjectZeroTrustStateConnection(db as never)).resolves.toEqual({
      active: false,
      applications: [],
      destinations: [],
      unfinishedDeletions: [],
    });
    expect(db.queries).toHaveLength(1);
  });

  it('reads whether a platform user exists only while Zero Trust is active', async () => {
    const active = connection({ settings: true, projects: true, users: true }, zeroTrustSetting());
    expect(await readPlatformProjectZeroTrustStateConnection(active as never)).toMatchObject({
      active: true,
      usersExist: false,
    });
    const withUser = connection(
      { settings: true, projects: true, users: true },
      zeroTrustSetting(),
      true,
    );
    expect(await readPlatformProjectZeroTrustStateConnection(withUser as never)).toMatchObject({
      usersExist: true,
    });
    const inactive = connection({ settings: true, projects: true, users: true }, disabledZeroTrust);
    expect(await readPlatformProjectZeroTrustStateConnection(inactive as never)).not.toHaveProperty(
      'usersExist',
    );
    expect(inactive.queries.some((sql) => sql.includes('FROM "users"'))).toBe(false);
  });

  it('reads the saved configuration and project applications', async () => {
    const db = connection({ settings: true, projects: true }, zeroTrustSetting());
    const state = await readPlatformProjectZeroTrustStateConnection(db as never);
    expect(state.active).toBe(true);
    expect(state.destinations).toEqual(['*.apps.example.com']);
    expect(state.applications.map((application) => application.role)).toEqual([
      'shared project application',
      'health check exception',
      'public exception for proj_public',
    ]);
  });
});

describe('platform lifecycle management', () => {
  it('preflights only a runtime token that will be applied', () => {
    const updatePlan = {
      actions: [{ action: 'update', key: 'api-worker', kind: 'worker' }],
    };
    expect(
      resolvePlatformRuntimeTokenToPreflight(updatePlan, {
        cloudflareApiToken: 'stale-checkpoint-token',
        workerSecretUpdates: {},
      }),
    ).toBe('');
    expect(
      resolvePlatformRuntimeTokenToPreflight(updatePlan, {
        cloudflareApiToken: 'stale-checkpoint-token',
        workerSecretUpdates: { CF_API_TOKEN: 'explicit-rotation-token' },
      }),
    ).toBe('explicit-rotation-token');
    expect(
      resolvePlatformRuntimeTokenToPreflight(
        { actions: [{ action: 'create', key: 'api-worker', kind: 'worker' }] },
        {
          cloudflareApiToken: 'recovery-token',
          workerSecretUpdates: {},
        },
      ),
    ).toBe('recovery-token');
    expect(
      resolvePlatformRuntimeTokenToPreflight(
        { actions: [{ action: 'create', key: 'email-gateway-worker', kind: 'worker' }] },
        {
          cloudflareApiToken: 'stale-checkpoint-token',
          workerSecretUpdates: {},
        },
      ),
    ).toBe('');
  });

  it('prompts for an installation when a lifecycle selector is omitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'void-platform-management-selection-test-'));
    directories.push(directory);
    process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
    const first = installedManifest();
    const second = {
      ...installedManifest(),
      deployment: {
        ...installedManifest().deployment,
        displayName: 'Second',
        installationSlug: 'second',
      },
      id: 'second-b2c3d4e5',
    };
    writeInstallationManifest(first);
    writeInstallationManifest(second);

    await expect(
      resolveInstalledPlatformManifest('', {
        interactive: true,
        selectInstallation: async (manifests) => {
          expect(manifests.map((manifest) => manifest.id)).toEqual([first.id, second.id]);
          return second.id;
        },
      }),
    ).resolves.toMatchObject({ id: second.id });
    await expect(resolveInstalledPlatformManifest('', { interactive: false })).rejects.toThrow(
      'specify an installation id',
    );
  });

  it('retries an eventually consistent ownership checkpoint before mutation', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'api-worker'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    let reads = 0;
    fake.getKvValue = async () => JSON.stringify(++reads === 1 ? stale : manifest);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('rejects Hyperdrive origin drift from the pinned lifecycle database', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getHyperdriveConfig = async (_account: string, id: string) => ({
      id,
      name: 'hyperdrive',
      origin: {
        database: 'replacement',
        host: 'db2.example.com',
        port: 5432,
        scheme: 'postgresql' as const,
        user: 'user',
      },
    });

    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        databaseUrl: 'postgres://user:secret@db.example.com/void',
      }),
    ).rejects.toThrow('different PostgreSQL origin');
  });

  it('allows authoritative repair to recreate a confirmed-missing routing checkpoint', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;
    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote installation checkpoint is missing',
    );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowMissingRoutingCheckpoint: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('restores an uninitialized live routing checkpoint only from database authority', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote installation checkpoint is missing',
    );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowUninitializedRoutingCheckpoint: true,
      }),
    ).resolves.toBeUndefined();

    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').map((resource) =>
        resource.id === 'routing-kv-id' ? { ...resource, id: 'replacement-id' } : resource,
      );
    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowUninitializedRoutingCheckpoint: true,
      }),
    ).rejects.toThrow('remote installation checkpoint is missing');
  });

  it('still rejects a replacement R2 bucket while repairing a missing routing checkpoint', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getKvValue = async () => null;
    fake.getR2Object = async () => null;
    fake.listKvNamespaces = async () =>
      namedResources(manifest, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );

    await expect(
      verifyPlatformInstallationOwnership(fake, manifest, {
        allowMissingRoutingCheckpoint: true,
      }),
    ).rejects.toThrow('r2-bucket assets-bucket has no ownership marker');
  });

  it('rejects an R2 bucket whose live creation fingerprint changed', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.listR2Buckets = async () =>
      namedResources(manifest, 'r2-bucket').map((resource) => ({
        ...resource,
        fingerprint: '2026-09-14T00:00:02.000Z',
      }));

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'r2-bucket assets-bucket changed creation fingerprint',
    );
  });

  it('accepts a live immutable resource recorded ahead of stale routing KV', async () => {
    let manifest = installedManifest();
    const resource = manifest.resources.find((entry) => entry.key === 'isr-cache-kv')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `provision-intent:${resource.key}`,
      resultHash: platformProvisionIntentHash(manifest, resource.key, resource.kind, resource.name),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((resource) => resource.key !== 'isr-cache-kv'),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
  });

  it('rejects a locally appended live resource without a remote provision intent', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'cron-queue'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'remote checkpoint does not own queue cron-queue',
    );
  });

  it('accepts an exact adopted resource recorded ahead of its remote checkpoint', async () => {
    let manifest = installedManifest('adopted');
    const resource = manifest.resources.find((entry) => entry.key === 'zone')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `adoption-intent:${resource.key}`,
      resultHash: platformAdoptionIntentHash(
        manifest,
        resource.key,
        resource.kind,
        resource.id,
        resource.name,
      ),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((entry) => entry.key !== resource.key),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).resolves.toBeUndefined();
  });

  it('rejects an adopted resource id changed after its remote intent', async () => {
    let manifest = installedManifest('adopted');
    const resource = manifest.resources.find((entry) => entry.key === 'zone')!;
    const intent = {
      completedAt: '2026-09-14T00:00:01.000Z',
      key: `adoption-intent:${resource.key}`,
      resultHash: platformAdoptionIntentHash(
        manifest,
        resource.key,
        resource.kind,
        resource.id,
        resource.name,
      ),
    };
    manifest = recordInstallationStep(manifest, intent, '2026-09-14T00:00:02.000Z');
    const stale = recordInstallationStep(
      {
        ...manifest,
        resources: manifest.resources.filter((entry) => entry.key !== resource.key),
      },
      intent,
      '2026-09-14T00:00:01.000Z',
    );
    const changed = {
      ...manifest,
      resources: manifest.resources.map((entry) =>
        entry.key === resource.key ? { ...entry, id: 'replacement-zone-id' } : entry,
      ),
    };
    const fake = client(changed);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, changed)).rejects.toThrow(
      'remote checkpoint does not own zone zone',
    );
  });

  it('never recovers a reusable AI Gateway name from stale routing KV', async () => {
    const manifest = installedManifest();
    const stale = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'ai-gateway'),
      updatedAt: '2026-09-14T00:00:01.000Z',
    };
    const fake = client(manifest);
    fake.getKvValue = async () => JSON.stringify(stale);

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'does not own ai-gateway',
    );
  });

  it('refuses to resume installation over a replacement Worker', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getWorkerPlainTextBindings = async () => ({});

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'has no ownership marker',
    );
  });

  it('refuses to resume installation into a replacement R2 bucket', async () => {
    const manifest = installedManifest();
    const fake = client(manifest);
    fake.getR2Object = async () => null;

    await expect(verifyPlatformInstallationOwnership(fake, manifest)).rejects.toThrow(
      'has no ownership marker',
    );
  });

  it('disables routes without deleting resources', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const databaseCheckpoints: Array<PlatformInstallationManifest> = [];
    await disablePlatform(fake, manifest, false, {
      checkpoint: async (checkpoint) => {
        databaseCheckpoints.push(checkpoint);
      },
    });
    expect(trafficRetentionSteps()).toEqual(['disable:0:routes']);
    expect(fake.disabledWrites).toEqual([PLATFORM_DISABLED_VALUE]);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
    expect(JSON.parse(fake.remoteWrites[0])).toMatchObject({ status: 'disabling' });
    expect(JSON.parse(fake.remoteWrites.at(-1)!)).toMatchObject({ status: 'disabled' });
    expect(databaseCheckpoints.at(-1)?.status).toBe('disabled');
  });

  it('describes the disable plan in user terms', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await disablePlatform(fake, manifest, true);

    expect(noteText('Disable plan')).toBe(
      'Block all platform traffic and the platform API. Routes, custom domains, Workers, and data stay installed.',
    );
    expect(fake.disabledWrites).toEqual([]);
  });

  it('selects cross-host disabled and uninstalled state over a stale local manifest', () => {
    const local = installedManifest();
    const disabled = { ...local, desiredState: 'disabled' as const, status: 'disabled' as const };
    const uninstalled = { ...disabled, status: 'uninstalled' as const };

    expect(selectAuthoritativePlatformManifest(local, disabled)).toBe(disabled);
    expect(selectAuthoritativePlatformManifest(local, uninstalled)).toBe(uninstalled);
  });

  it('removes public endpoints again after a platform is re-enabled', async () => {
    let manifest = installedManifest();
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'traffic-enabled:1',
        resultHash: '1',
      },
      '2026-09-14T00:00:03.000Z',
    );
    persistInstallation(manifest, directories);
    const first = client(manifest);
    await disablePlatform(first, manifest, false);

    let reenabled = listInstallationManifests()[0];
    reenabled = recordInstallationStep(
      reenabled,
      {
        completedAt: '2026-09-14T00:00:04.000Z',
        key: 'traffic-enabled:2',
        resultHash: '2',
      },
      '2026-09-14T00:00:04.000Z',
    );
    reenabled = { ...reenabled, desiredState: 'enabled', status: 'installed' };
    writeInstallationManifest(reenabled);

    const second = client(reenabled);
    await disablePlatform(second, reenabled, false);
    expect(trafficRetentionSteps()).toEqual(['disable:1:routes', 'disable:2:routes']);
    expect(second.disabledWrites).toHaveLength(1);
  });

  it('disables public Workers from an interrupted deployment', async () => {
    const manifest = { ...installedManifest(), status: 'deploying' as const };
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await disablePlatform(fake, manifest, false);

    expect(trafficRetentionSteps()).toEqual(['disable:0:routes']);
    expect(fake.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('uses routing storage when one recorded Worker is missing', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.listWorkerNames = async () => ['api-worker', 'proxy-worker', 'tail-worker'];

    await disablePlatform(fake, manifest, false);

    expect(fake.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables workers.dev through routing storage when the recorded zone is missing', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.findZone = async () => null;

    await disablePlatform(fake, manifest, false);

    expect(fake.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('disables a marked Worker deployed before its local resource checkpoint', async () => {
    let manifest = installedManifest();
    const recordedApi = manifest.resources.find((resource) => resource.key === 'api-worker')!;
    const api = {
      ...recordedApi,
      id: manifest.deployment.resources.apiWorker,
      name: manifest.deployment.resources.apiWorker,
    };
    manifest = {
      ...manifest,
      resources: manifest.resources.filter((resource) => resource.key !== 'api-worker'),
      status: 'deploying',
    };
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:03.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(manifest, api.key, api.kind, api.name),
      },
      '2026-09-14T00:00:03.000Z',
    );
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.listWorkerNames = async () => [
      api.name,
      ...manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.name),
    ];
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource =
        name === api.name
          ? api
          : manifest.resources.find((entry) => entry.kind === 'worker' && entry.name === name)!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    };

    await disablePlatform(fake, manifest, false);

    expect(fake.disabledWrites).toHaveLength(1);
    expect(
      listInstallationManifests()[0]?.resources.find((resource) => resource.key === api.key),
    ).toMatchObject({
      id: api.id,
      kind: api.kind,
      name: api.name,
      ownership: 'created',
      state: 'ready',
    });
  });

  it('retains every resource and records the uninstall in routing storage by default', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);
    expect(fake.deleted).toEqual([]);
    expect(
      fake.remoteWrites.map((value) => (JSON.parse(value) as { status?: unknown }).status),
    ).toContain('uninstalled');
    const result = listInstallationManifests()[0];
    expect(result.status).toBe('uninstalled');
    expect(result.resources.filter((resource) => resource.state === 'retained')).toHaveLength(15);
    expect(readInstallationRecoverySecrets(result)).toEqual({
      databaseUrl: 'postgres://recovery',
    });
  });

  it('retains observed traffic attachments when disabling', async () => {
    let manifest = installedManifest();
    const dispatchWorker = manifest.deployment.resources.dispatchWorker;
    manifest = recordPlatformWorkerTraffic(
      manifest,
      dispatchWorker,
      {
        customDomains: [],
        routes: [
          {
            id: 'route-one',
            pattern: '*.apps.example.com/*',
            script: dispatchWorker,
          },
          {
            id: 'route-two',
            pattern: '*.apps.example.com',
            script: dispatchWorker,
          },
        ],
      },
      '2026-09-14T00:00:03.000Z',
    );
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await disablePlatform(fake, manifest, false);

    expect(
      listInstallationManifests()[0]
        ?.resources.filter((resource) => resource.kind === 'worker-route')
        .map((resource) => resource.state),
    ).toEqual(['retained', 'retained']);
  });

  it('retains Workers and their unmanaged traffic for manual cleanup', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.listWorkerServiceRoutes = async (_accountId: string, workerName: string) =>
      workerName === 'api-worker'
        ? [
            {
              pattern: 'manual.other.example/*',
              zoneName: 'other.example',
            },
          ]
        : [];
    fake.listWorkerDomains = async () => [
      { hostname: 'manual.example.com', id: 'manual-domain', service: 'proxy-worker' },
    ];

    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);

    expect(fake.deleted.some(([kind]) => kind === 'worker')).toBe(false);
    expect(trafficRetentionSteps()).toEqual([
      'uninstall:routes:api-worker',
      'uninstall:routes:dispatch-worker',
      'uninstall:routes:proxy-worker',
      'uninstall:routes:tail-worker',
    ]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('retains an installer DNS record even when it was repurposed', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.listDnsRecords = async (_zone: string, name: string) =>
      namedResources(manifest, 'dns-record')
        .filter((resource) => resource.name === name)
        .map((resource) => ({
          ...resource,
          content: 'origin.unrelated.example',
          proxied: false,
          type: 'CNAME',
        }));

    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);

    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(
      listInstallationManifests()[0]?.resources.find(
        (resource) => resource.key === 'application-dns',
      ),
    ).toMatchObject({ state: 'retained' });
  });

  it('lists every kept resource in manual cleanup order after uninstall', async () => {
    const manifest = {
      ...installedManifest(),
      authenticationResources: [
        {
          key: 'login-access',
          kind: 'application' as const,
          accountId: 'account',
          id: 'access-app-id',
          name: 'login-access',
          ownership: 'created' as const,
        },
      ],
    };
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);

    const kept = noteText('Kept resources');
    expectInOrder(kept, [
      'dns-record: application-dns (application-dns-id)',
      'queue: cron-queue (cron-queue-id)',
      'queue: usage-queue (usage-queue-id)',
      'worker: api-worker (void-example-api)',
      'worker: dispatch-worker (void-example-dispatch)',
      'dispatch-namespace: dispatch-namespace (dispatch-namespace-id)',
      // Cloudflare refuses the tail Worker while other Workers send it logs.
      'worker: tail-worker (void-example-tail)',
      'kv-namespace: routing-kv (routing-kv-id)',
      'hyperdrive: hyperdrive (hyperdrive-id)',
      'r2-bucket: assets-bucket (assets-bucket-id)',
      'ai-gateway: ai-gateway (ai-gateway-id)',
      'zone: zone (zone-id)',
      'created application: login-access (access-app-id, account account)',
    ]);
    expect(vi.mocked(printSuccess).mock.calls.at(-1)?.[0]).toBe('Uninstalled Example.');
  });

  it('names the resources a purge plan keeps', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, plan: true, purgeData: true },
      uninstallDependencies,
    );

    const plan = noteText('Uninstall plan');
    expectInOrder(plan, [
      'dns-record: application-dns (application-dns-id)',
      'queue: usage-queue (usage-queue-id)',
      'worker: api-worker (void-example-api)',
      'r2-bucket: assets-bucket (assets-bucket-id)',
      'ai-gateway: ai-gateway (ai-gateway-id)',
      'zone: zone (zone-id)',
    ]);
    expect(plan).not.toContain('kv-namespace:');
    expect(plan).not.toContain('hyperdrive:');
    expect(plan).not.toContain('dispatch-namespace:');
    expect(plan).not.toContain('Email Routing');
    expect(fake.deleted).toEqual([]);
  });

  it('says Email Routing is kept when the installation sends email', async () => {
    const base = installedManifest();
    const manifest = {
      ...base,
      deployment: {
        ...base.deployment,
        capabilities: { ...base.deployment.capabilities, email: true },
        emailSenderDomain: 'mail.example.com',
        emailSharedZoneId: 'zone-id',
      },
    };
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const emailLine = `Email Routing for mail.example.com (zone zone-id): its routing DNS records and any catch-all rule that sends mail to ${base.deployment.resources.emailGatewayWorker}.`;

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, plan: true },
      uninstallDependencies,
    );
    expect(noteText('Uninstall plan')).toContain(emailLine);

    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);
    expect(noteText('Kept resources')).toContain(emailLine);
  });

  it('records an AI Gateway already removed in Cloudflare as deleted', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.listAiGateways = async () => [];

    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);

    expect(fake.deleted).toEqual([]);
    expect(
      listInstallationManifests()[0]?.resources.find((resource) => resource.key === 'ai-gateway')
        ?.state,
    ).toBe('deleted');
    expect(noteText('Kept resources')).not.toContain('ai-gateway:');
  });

  it('purges installer-owned data while never deleting an adopted zone', async () => {
    const manifest = installedManifest('adopted');
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      uninstallDependencies,
    );
    expect(fake.deleted).toHaveLength(5);
    expect(fake.deleted).not.toContainEqual(['ai-gateway', 'ai-gateway-id']);
    expect(fake.deleted.some(([kind]) => kind === 'zone')).toBe(false);
    expect(readInstallationRecoverySecrets(listInstallationManifests()[0])).toBeNull();
  });

  it('refuses every mutation when the remote installation identity changed', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.getKvValue = async () =>
      JSON.stringify({ ...manifest, ownershipNonce: 'different-ownership-nonce-000000' });

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies),
    ).rejects.toThrow('remote installation identity does not match');
    expect(trafficRetentionSteps()).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('refuses to delete a replacement Worker with a reused name', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    const replacement = {
      ...manifest,
      ownershipNonce: 'replacement-owner-nonce-00000000',
    };
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource = replacement.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name,
      )!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(replacement, resource) };
    };

    await expect(
      uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies),
    ).rejects.toThrow('belongs to another installation');
    expect(trafficRetentionSteps()).toEqual([]);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('does not inspect or mutate R2 during purge', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.getR2Object = async () => null;

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      uninstallDependencies,
    );
    expect(fake.emptiedBuckets).toEqual([]);
    expect(fake.deletedBucketMarkers).toEqual([]);
    expect(fake.deleted).not.toContainEqual(['r2-bucket', 'assets-bucket-id']);
    const result = listInstallationManifests()[0];
    expect(result.status).toBe('uninstalled');
    expect(result.resources.find((resource) => resource.key === 'assets-bucket')?.state).toBe(
      'retained',
    );
  });

  it('resumes safely after a deletion failure without retrying completed deletions', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const first = client(manifest);
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account, resource) => {
      if (resource.kind === 'dispatch-namespace') {
        throw new Error('temporary deletion failure');
      }
      await originalDelete(account, resource);
    };
    await expect(
      uninstallPlatform(
        first,
        manifest,
        { ...uninstallArgs, purgeData: true },
        uninstallDependencies,
      ),
    ).rejects.toThrow('temporary deletion failure');
    const checkpoint = listInstallationManifests()[0];
    expect(checkpoint.status).toBe('failed');
    expect(checkpoint.resources.filter((resource) => resource.state === 'deleted')).toHaveLength(0);

    const second = client(checkpoint);
    await uninstallPlatform(
      second,
      checkpoint,
      { ...uninstallArgs, purgeData: true },
      uninstallDependencies,
    );
    expect(second.deleted.filter(([kind]) => kind === 'worker')).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('retains Queues that retained Workers still use', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      uninstallDependencies,
    );

    expect(fake.deleted.some(([kind]) => kind === 'queue')).toBe(false);
    const result = listInstallationManifests()[0];
    expect(result.status).toBe('uninstalled');
    expect(
      result.resources
        .filter((resource) => resource.kind === 'queue')
        .map((resource) => resource.state),
    ).toEqual(['retained', 'retained']);
  });

  it('finishes an uninstall that stopped on a Queue still bound to a retained Worker', async () => {
    let manifest = installedManifest();
    manifest = transitionInstallation(manifest, 'uninstalling', '2026-09-14T00:00:03.000Z');
    manifest = transitionInstallation(
      {
        ...manifest,
        resources: manifest.resources.map((resource) =>
          resource.kind === 'worker' ? { ...resource, state: 'retained' as const } : resource,
        ),
      },
      'failed',
      '2026-09-14T00:00:04.000Z',
    );
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    fake.listWorkerNames = async () =>
      manifest.resources
        .filter((resource) => resource.kind === 'worker')
        .map((resource) => resource.name);

    await uninstallPlatform(
      fake,
      manifest,
      { ...uninstallArgs, purgeData: true },
      uninstallDependencies,
    );

    expect(fake.deleted.some(([kind]) => kind === 'queue')).toBe(false);
    const result = listInstallationManifests()[0];
    expect(result.status).toBe('uninstalled');
    expect(
      result.resources
        .filter((resource) => resource.kind === 'queue')
        .map((resource) => resource.state),
    ).toEqual(['retained', 'retained']);
  });

  it('deletes Queues once no installation Worker remains', async () => {
    const installed = installedManifest();
    const manifest = {
      ...installed,
      resources: installed.resources.filter((resource) => resource.kind !== 'worker'),
    };
    persistInstallation(manifest, directories);
    const fake = client(manifest);

    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);

    expect(fake.deleted).toEqual([
      ['queue', 'cron-queue-id'],
      ['queue', 'usage-queue-id'],
    ]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('resumes a purge after the final routing checkpoint was ambiguously deleted', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const first = client(manifest);
    const originalDelete = first.deleteResource;
    first.deleteResource = async (account, resource) => {
      await originalDelete(account, resource);
      if (resource.kind === 'kv-namespace' && resource.id === 'routing-kv-id') {
        throw new Error('connection closed after routing deletion');
      }
    };
    await expect(
      uninstallPlatform(
        first,
        manifest,
        { ...uninstallArgs, purgeData: true },
        uninstallDependencies,
      ),
    ).rejects.toThrow('connection closed after routing deletion');
    const checkpoint = listInstallationManifests()[0];
    expect(checkpoint.status).toBe('failed');
    expect(checkpoint.resources.find((resource) => resource.key === 'routing-kv')?.state).toBe(
      'ready',
    );
    expect(
      checkpoint.resources.every(
        (resource) => resource.key === 'routing-kv' || resource.state !== 'ready',
      ),
    ).toBe(true);

    const second = client(checkpoint);
    second.getKvValue = async () => null;
    second.listKvNamespaces = async () =>
      namedResources(checkpoint, 'kv-namespace').filter(
        (resource) => resource.id !== 'routing-kv-id',
      );
    await uninstallPlatform(
      second,
      checkpoint,
      { ...uninstallArgs, purgeData: true },
      uninstallDependencies,
    );
    expect(second.deleted).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('cleans up a partial installation without PostgreSQL or a recorded zone', async () => {
    const manifest = {
      ...installedManifest(),
      resources: installedManifest().resources.filter((resource) => resource.key !== 'zone'),
    };
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);
    expect(trafficRetentionSteps()).toEqual([]);
    expect(fake.deleted.some(([kind]) => kind === 'worker')).toBe(false);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(
      listInstallationManifests()[0]?.resources.find(
        (resource) => resource.key === 'application-dns',
      )?.state,
    ).toBe('retained');
  });

  it('safely uninstalls a DNS-wait checkpoint created before routing storage', async () => {
    const manifest = {
      ...installedManifest(),
      endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
      resources: installedManifest().resources.filter((resource) => resource.key === 'zone'),
      status: 'waiting-for-dns' as const,
    };
    persistInstallation(manifest, directories);
    const fake = client(manifest);
    await uninstallPlatform(fake, manifest, uninstallArgs, uninstallDependencies);
    expect(fake.deleted).toEqual([]);
    expect(listInstallationManifests()[0]).toMatchObject({ status: 'uninstalled' });
    expect(listInstallationManifests()[0].resources[0]).toMatchObject({ state: 'retained' });
  });

  it('resumes after routes were removed but remote disable checkpointing failed', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const first = client(manifest);
    first.putKvValue = async () => {
      throw new Error('temporary KV failure');
    };
    await expect(disablePlatform(first, manifest, false)).rejects.toThrow('temporary KV failure');
    expect(listInstallationManifests()[0]?.status).toBe('failed');

    const failed = listInstallationManifests()[0];
    const second = client(failed);
    await disablePlatform(second, failed, false);
    expect(trafficRetentionSteps()).toEqual(['disable:0:routes']);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });

  it('reasserts every public endpoint when disabling an already-disabled installation', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const first = client(manifest);
    await disablePlatform(first, manifest, false);

    const disabled = listInstallationManifests()[0];
    const second = client(disabled);
    await disablePlatform(second, disabled, false);

    expect(trafficRetentionSteps()).toEqual(['disable:0:routes']);
    expect(second.disabledWrites).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('disabled');
  });
});
