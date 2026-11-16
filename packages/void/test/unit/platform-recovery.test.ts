import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationResource,
  recordInstallationStep,
  setInstallationEndpoints,
  transitionInstallation,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
} from '@void/platform';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { hyperdriveOriginConfigHash } from '../../src/cli/platform-cloudflare.ts';
import { REMOTE_INSTALLATION_MANIFEST_KEY } from '../../src/cli/platform-installer.ts';
import {
  createPlatformInstallPlan,
  platformProvisionIntentHash,
} from '../../src/cli/platform-plan.ts';
import {
  recoverPlatformInstallations,
  verifyInstallationEndpoint,
} from '../../src/cli/platform-recovery.ts';
import {
  listInstallationManifests,
  listPlatformConnections,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';
import { ownershipMarker } from '../helpers/platform-installation.ts';

const directories: Array<string> = [];

afterEach(() => {
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
  delete process.env.VOID_ACCESS_ORIGIN;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function remoteManifest() {
  const deployment = createPlatformDeploymentManifest({
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Example',
    installationSlug: 'example',
  });
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment,
    id: 'example-a1b2c3d4',
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
  const resources: Array<[string, InstallationResourceKind, string, string]> = [
    ['zone', 'zone', 'zone-id', 'example.com'],
    ['application-dns', 'dns-record', 'dns-id', '*.apps.example.com'],
    ['ai-gateway', 'ai-gateway', deployment.resources.aiGateway, deployment.resources.aiGateway],
    ['routing-kv', 'kv-namespace', 'routing-id', deployment.resources.routingKv],
    ['isr-cache-kv', 'kv-namespace', 'isr-id', deployment.resources.isrCacheKv],
    ['legacy-assets-kv', 'kv-namespace', 'legacy-id', deployment.resources.legacyAssetsKv],
    [
      'assets-bucket',
      'r2-bucket',
      deployment.resources.assetsBucket,
      deployment.resources.assetsBucket,
    ],
    ['usage-queue', 'queue', 'usage-id', deployment.resources.usageQueue],
    ['cron-queue', 'queue', 'cron-id', deployment.resources.cronQueue],
    [
      'dispatch-namespace',
      'dispatch-namespace',
      'dispatch-id',
      deployment.resources.dispatchNamespace,
    ],
    ['hyperdrive', 'hyperdrive', 'hyperdrive-id', deployment.resources.hyperdrive],
    ['api-worker', 'worker', deployment.resources.apiWorker, deployment.resources.apiWorker],
    ['proxy-worker', 'worker', deployment.resources.proxyWorker, deployment.resources.proxyWorker],
    [
      'email-gateway-worker',
      'worker',
      deployment.resources.emailGatewayWorker,
      deployment.resources.emailGatewayWorker,
    ],
    ['tail-worker', 'worker', deployment.resources.tailWorker, deployment.resources.tailWorker],
    [
      'dispatch-worker',
      'worker',
      deployment.resources.dispatchWorker,
      deployment.resources.dispatchWorker,
    ],
  ];
  for (const [key, kind, id, name] of resources) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash:
          kind === 'dns-record'
            ? createHash('sha256')
                .update(
                  JSON.stringify({
                    content: '100::',
                    kind,
                    name,
                    proxied: true,
                    type: 'AAAA',
                  }),
                )
                .digest('hex')
            : kind === 'hyperdrive'
              ? hyperdriveOriginConfigHash({
                  database: 'void',
                  host: 'db.example.com',
                  port: 5432,
                  scheme: 'postgresql',
                  user: 'user',
                })
              : kind === 'r2-bucket'
                ? createHash('sha256')
                    .update(
                      JSON.stringify({
                        fingerprint: '2026-09-14T00:00:00.000Z',
                        kind: 'r2-bucket',
                        name,
                      }),
                    )
                    .digest('hex')
                : 'hash',
        id,
        key,
        kind,
        name,
        ownership: 'created',
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
  return setInstallationEndpoints(
    manifest,
    {
      apiUrl: 'https://void-example-api.example-workers.workers.dev',
      dashboardUrl: null,
      proxyUrl: 'https://void-example-proxy.example-workers.workers.dev',
    },
    '2026-09-14T00:00:03.000Z',
  );
}

function useRegistryDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-recovery-test-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
  return directory;
}

function client(manifest = remoteManifest()) {
  const byName = new Map(manifest.resources.map((resource) => [resource.name, resource]));
  return {
    deleteKvValue: async () => {},
    deleteResource: async () => {},
    deleteR2Object: async () => {},
    emptyR2Bucket: async () => {},
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    getWorkersSubdomain: async () => 'example-workers',
    hasActiveCertificateForHostname: async () => true,
    listAiGateways: async () => [
      {
        id: manifest.deployment.resources.aiGateway,
        name: manifest.deployment.resources.aiGateway,
      },
    ],
    findZone: async () => ({
      id: 'zone-id',
      name: 'example.com',
      nameServers: [],
      status: 'active',
    }),
    findZoneForHostname: async () => null,
    listDnsRecords: async () => [
      {
        content: '100::',
        id: 'dns-id',
        name: '*.apps.example.com',
        proxied: true,
        type: 'AAAA',
      },
    ],
    listKvNamespaces: async (_account: string, title?: string) => {
      if (!title) {
        return [{ id: 'routing-id', name: manifest.deployment.resources.routingKv }];
      }
      const resource = byName.get(title);
      return resource?.kind === 'kv-namespace' ? [{ id: resource.id, name: resource.name }] : [];
    },
    getKvValue: async (_account: string, namespace: string, key: string) =>
      namespace === 'routing-id' && key === REMOTE_INSTALLATION_MANIFEST_KEY
        ? JSON.stringify(manifest)
        : null,
    putKvValue: async (_account: string, _namespace: string, _key: string, _value: string) => {},
    getR2Object: async () => {
      const resource = manifest.resources.find((entry) => entry.kind === 'r2-bucket')!;
      return ownershipMarker(manifest, resource);
    },
    getWorkerPlainTextBindings: async (_account: string, name: string) => {
      const resource = manifest.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name,
      )!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(manifest, resource) };
    },
    listR2Buckets: async () => [
      {
        fingerprint: '2026-09-14T00:00:00.000Z',
        id: manifest.deployment.resources.assetsBucket,
        name: manifest.deployment.resources.assetsBucket,
      },
    ],
    listQueues: async (_account: string, name: string) => {
      const resource = byName.get(name);
      return resource?.kind === 'queue' ? [{ id: resource.id, name: resource.name }] : [];
    },
    listDispatchNamespaces: async () => [
      { id: 'dispatch-id', name: manifest.deployment.resources.dispatchNamespace },
    ],
    listHyperdriveConfigs: async () => [
      { id: 'hyperdrive-id', name: manifest.deployment.resources.hyperdrive },
    ],
    getHyperdriveConfig: async () => ({
      id: 'hyperdrive-id',
      name: manifest.deployment.resources.hyperdrive,
      origin: {
        database: 'void',
        host: 'db.example.com',
        port: 5432,
        scheme: 'postgresql' as const,
        user: 'user',
      },
    }),
    listWorkerNames: async () => [
      manifest.deployment.resources.apiWorker,
      manifest.deployment.resources.proxyWorker,
      manifest.deployment.resources.emailGatewayWorker,
      manifest.deployment.resources.tailWorker,
      manifest.deployment.resources.dispatchWorker,
    ],
    listWorkerDomains: async () => [],
    listWorkerRoutes: async () => [],
  };
}

describe('platform recovery', () => {
  it('authenticates endpoint verification with explicitly scoped Access proof', async () => {
    process.env.CF_ACCESS_CLIENT_ID = 'service-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'service-secret';
    process.env.VOID_ACCESS_ORIGIN = 'https://api.staging.void.cloud';
    const manifest = {
      ...remoteManifest(),
      endpoints: {
        ...remoteManifest().endpoints,
        apiUrl: 'https://api.staging.void.cloud',
      },
    };
    let headers = new Headers();
    let redirect: RequestRedirect | undefined;

    await verifyInstallationEndpoint(manifest, (async (_input, init) => {
      headers = new Headers(init?.headers);
      redirect = init?.redirect;
      return Response.json({ installationId: manifest.id });
    }) as typeof fetch);

    expect(headers.get('CF-Access-Client-Id')).toBe('service-id');
    expect(headers.get('CF-Access-Client-Secret')).toBe('service-secret');
    expect(redirect).toBe('manual');
  });

  it('limits shared-account discovery before verifying unrelated endpoints', async () => {
    let verified = false;
    await expect(
      recoverPlatformInstallations(
        client(),
        'account',
        async () => {
          verified = true;
          throw new Error('must not verify an unrelated installation');
        },
        'different-installation',
      ),
    ).resolves.toEqual([]);
    expect(verified).toBe(false);
  });

  it('recovers a fully verified remote ownership manifest', async () => {
    const directory = useRegistryDir();
    const verified: Array<string> = [];
    const recovered = await recoverPlatformInstallations(client(), 'account', async (manifest) => {
      verified.push(manifest.id);
    });
    expect(recovered).toHaveLength(1);
    expect(verified).toEqual(['example-a1b2c3d4']);
    expect(listInstallationManifests(directory)).toEqual(recovered);
    expect(listPlatformConnections(directory)[0]).toMatchObject({
      installationId: 'example-a1b2c3d4',
      kind: 'installed',
    });
  });

  it('recovers a Workers VPC Hyperdrive by origin identity even when caching is enabled', async () => {
    const directory = useRegistryDir();
    const remote = remoteManifest();
    const resource = remote.resources.find((entry) => entry.key === 'hyperdrive')!;
    const manifest = recordInstallationResource(
      remote,
      {
        ...resource,
        ownership: 'adopted',
        configHash: 'fa8ba14273c6fe1dce2e7b58bfac73a3049b0a8a7e30e37d59f47544cc1702f2',
      },
      remote.updatedAt,
    );
    const live = {
      id: resource.id,
      name: resource.name,
      cachingDisabled: true,
      origin: {
        database: 'void',
        scheme: 'postgresql' as const,
        serviceId: 'f537187c-73f7-4ad8-bcb6-38e3e3ac1177',
        user: 'user',
      },
    };
    const fake = client(manifest);
    await expect(
      recoverPlatformInstallations(
        {
          ...fake,
          getHyperdriveConfig: async () => ({
            ...live,
            origin: { ...live.origin, serviceId: live.origin.serviceId.toUpperCase() },
          }),
        },
        'account',
        async () => {},
      ),
    ).resolves.toHaveLength(1);
    expect(listInstallationManifests(directory)[0]?.id).toBe(remote.id);
    await expect(
      recoverPlatformInstallations(
        {
          ...fake,
          getHyperdriveConfig: async () => ({
            ...live,
            origin: { ...live.origin, serviceId: 'different-service' },
          }),
        },
        'account',
        async () => {},
      ),
    ).rejects.toThrow('changed configuration');
    await expect(
      recoverPlatformInstallations(
        { ...fake, getHyperdriveConfig: async () => ({ ...live, cachingDisabled: false }) },
        'account',
        async () => {},
      ),
    ).resolves.toHaveLength(1);
  });

  it('recovers a verified installation with a missing owned Worker so repair can recreate it', async () => {
    const directory = useRegistryDir();
    const remote = remoteManifest();
    const missingWorker = remote.deployment.resources.apiWorker;
    const fake = client(remote);
    fake.listWorkerNames = async () =>
      remote.resources
        .filter((resource) => resource.kind === 'worker' && resource.name !== missingWorker)
        .map((resource) => resource.name);
    let endpointChecks = 0;

    const recovered = await recoverPlatformInstallations(fake, 'account', async () => {
      endpointChecks++;
    });

    expect(recovered).toHaveLength(1);
    expect(listInstallationManifests(directory)).toEqual(recovered);
    expect(endpointChecks).toBe(0);
    const manifest = recovered[0]!;
    const repairPlan = await createPlatformInstallPlan(
      fake,
      {
        accountId: manifest.account.id,
        applicationDomain: manifest.deployment.application.baseDomain,
        controlPlaneDomain: manifest.deployment.controlPlane.apiHostname ?? '',
        dedicatedZone: manifest.deployment.application.dedicatedZone,
        displayName: manifest.deployment.displayName,
        installationSlug: manifest.deployment.installationSlug,
        zoneName: manifest.deployment.application.zoneName,
      },
      manifest,
      { repairMissing: true },
    );
    expect(repairPlan.actions.find((action) => action.key === 'api-worker')).toMatchObject({
      action: 'create',
      id: null,
      name: missingWorker,
    });
  });

  it('rejects discovery when a surviving Worker belongs to another installation', async () => {
    const directory = useRegistryDir();
    const remote = remoteManifest();
    const fake = client(remote);
    const conflicting = {
      ...remote,
      ownershipNonce: 'fedcba9876543210fedcba9876543210',
    };
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource = remote.resources.find(
        (entry) => entry.kind === 'worker' && entry.name === name,
      )!;
      return {
        PLATFORM_OWNERSHIP_MARKER:
          name === remote.deployment.resources.apiWorker
            ? ownershipMarker(conflicting, resource)
            : ownershipMarker(remote, resource),
      };
    };

    await expect(recoverPlatformInstallations(fake, 'account', async () => {})).rejects.toThrow(
      'belongs to another installation',
    );
    expect(listInstallationManifests(directory)).toEqual([]);
  });

  it('discovers a routing namespace created under a retry name', async () => {
    const directory = useRegistryDir();
    const base = remoteManifest();
    const retryName = `${base.deployment.resources.routingKv}-retry-0123456789`;
    const manifest = {
      ...base,
      deployment: {
        ...base.deployment,
        resources: { ...base.deployment.resources, routingKv: retryName },
      },
      resources: base.resources.map((resource) =>
        resource.key === 'routing-kv' ? { ...resource, name: retryName } : resource,
      ),
    };

    await expect(
      recoverPlatformInstallations(client(manifest), 'account', async () => {}),
    ).resolves.toHaveLength(1);
    expect(listInstallationManifests(directory)[0]?.resources).toContainEqual(
      expect.objectContaining({ key: 'routing-kv', name: retryName }),
    );
  });

  it('refuses ownership metadata from a different routing namespace', async () => {
    const directory = useRegistryDir();
    const manifest = remoteManifest();
    const tampered = {
      ...manifest,
      resources: manifest.resources.map((resource) =>
        resource.key === 'routing-kv' ? { ...resource, id: 'different-id' } : resource,
      ),
    };
    await expect(
      recoverPlatformInstallations(client(tampered), 'account', async () => {}),
    ).rejects.toThrow('does not match');
    expect(listInstallationManifests(directory)).toEqual([]);
  });

  it('recovers a disabled installation without probing its private endpoint', async () => {
    useRegistryDir();
    const installed = remoteManifest();
    const disabled = {
      ...installed,
      desiredState: 'disabled' as const,
      status: 'disabled' as const,
    };
    let endpointChecks = 0;
    const recovered = await recoverPlatformInstallations(client(disabled), 'account', async () => {
      endpointChecks++;
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ desiredState: 'disabled', status: 'disabled' });
    expect(endpointChecks).toBe(0);
  });

  it('recovers an interrupted uninstall without probing its removed endpoint', async () => {
    useRegistryDir();
    const interrupted = { ...remoteManifest(), status: 'uninstalling' as const };
    let endpointChecks = 0;

    const recovered = await recoverPlatformInstallations(
      client(interrupted),
      'account',
      async () => {
        endpointChecks++;
      },
    );

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('uninstalling');
    expect(endpointChecks).toBe(0);
  });

  it('recovers an interrupted install before endpoints were checkpointed', async () => {
    const directory = useRegistryDir();
    const interrupted = {
      ...remoteManifest(),
      endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
      status: 'deploying' as const,
    };
    let endpointChecks = 0;

    const recovered = await recoverPlatformInstallations(
      client(interrupted),
      'account',
      async () => {
        endpointChecks++;
      },
    );

    expect(recovered).toEqual([interrupted]);
    expect(listInstallationManifests(directory)).toEqual([interrupted]);
    expect(listPlatformConnections(directory)).toEqual([]);
    expect(endpointChecks).toBe(0);
  });

  it('recovers a Worker deployed before its resource checkpoint', async () => {
    useRegistryDir();
    const base = remoteManifest();
    const installationId = 'example-a1b2c3d4e5f6';
    const workerName = 'void-example-a1b2c3d4e5f6-api';
    let interrupted: PlatformInstallationManifest = {
      ...base,
      deployment: {
        ...base.deployment,
        resources: { ...base.deployment.resources, apiWorker: workerName },
      },
      endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
      id: installationId,
      resources: base.resources.filter((resource) => resource.key !== 'api-worker'),
      status: 'deploying' as const,
    };
    interrupted = recordInstallationStep(
      interrupted,
      {
        completedAt: '2026-09-14T00:00:04.000Z',
        key: 'provision-intent:api-worker',
        resultHash: platformProvisionIntentHash(interrupted, 'api-worker', 'worker', workerName),
      },
      '2026-09-14T00:00:04.000Z',
    );
    const fake = client(interrupted);
    const workerResource = {
      configHash: 'hash',
      id: workerName,
      key: 'api-worker',
      kind: 'worker' as const,
      name: workerName,
      ownership: 'created' as const,
      state: 'ready' as const,
    };
    fake.getWorkerPlainTextBindings = async (_account, name) => {
      const resource =
        name === workerName
          ? workerResource
          : interrupted.resources.find((entry) => entry.kind === 'worker' && entry.name === name)!;
      return { PLATFORM_OWNERSHIP_MARKER: ownershipMarker(interrupted, resource) };
    };

    const [recovered] = await recoverPlatformInstallations(fake, 'account', async () => {});
    expect(recovered?.resources.find((resource) => resource.key === 'api-worker')).toMatchObject({
      id: workerName,
      key: 'api-worker',
      kind: 'worker',
      name: workerName,
      ownership: 'created',
      state: 'ready',
    });
  });

  it('keeps locally advanced lifecycle progress during discovery', async () => {
    useRegistryDir();
    const remote = remoteManifest();
    const local = {
      ...remote,
      status: 'failed' as const,
      updatedAt: '2026-09-14T00:00:04.000Z',
    };
    writeInstallationManifest(local);

    await expect(
      recoverPlatformInstallations(client(remote), 'account', async () => {}),
    ).resolves.toEqual([local]);
    expect(listInstallationManifests()).toEqual([local]);
  });

  it('rejects a locally advanced manifest with a different proxy origin', async () => {
    useRegistryDir();
    const remote = remoteManifest();
    const local = {
      ...remote,
      endpoints: { ...remote.endpoints, proxyUrl: 'https://attacker.example' },
      status: 'failed' as const,
      updatedAt: '2026-09-14T00:00:04.000Z',
    };
    writeInstallationManifest(local);

    await expect(
      recoverPlatformInstallations(client(remote), 'account', async () => {}),
    ).rejects.toThrow('inconsistent proxy metadata');
    expect(listPlatformConnections()).toEqual([]);
    expect(listInstallationManifests()).toEqual([local]);
  });

  it('accepts a deterministic endpoint advancement from a local checkpoint', async () => {
    useRegistryDir();
    const complete = remoteManifest();
    const remote = {
      ...complete,
      endpoints: { apiUrl: null, dashboardUrl: null, proxyUrl: null },
      status: 'deploying' as const,
    };
    const local = {
      ...remote,
      endpoints: complete.endpoints,
      updatedAt: '2026-09-14T00:00:04.000Z',
    };
    writeInstallationManifest(local);

    await expect(
      recoverPlatformInstallations(client(remote), 'account', async () => {}),
    ).resolves.toEqual([local]);
    expect(listPlatformConnections()).toHaveLength(1);
  });
});
