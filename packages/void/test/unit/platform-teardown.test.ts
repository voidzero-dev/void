vi.mock('../../src/cli/output.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/output.ts')>()),
  printSuccess: vi.fn(),
}));
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  PLATFORM_DISABLED_KEY,
  PLATFORM_R2_OWNERSHIP_MARKER_KEY,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
  type InstallationResourceKind,
  type PlatformInstallationManifest,
  type ResourceOwnership,
} from '@void/platform';
import { log, note } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { printSuccess } from '../../src/cli/output.ts';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import { readPlatformProjectSlugsConnection } from '../../src/cli/platform-installer-database.ts';
import { uninstallPlatform } from '../../src/cli/platform-management.ts';
import {
  listInstallationManifests,
  readInstallationRecoverySecrets,
} from '../../src/cli/platform-registry.ts';
import { recordPlatformWorkerTraffic } from '../../src/cli/platform-traffic.ts';
import { projectZeroTrustUninstallState } from '../../src/cli/platform-zero-trust-uninstall.ts';
import {
  expectInOrder,
  noteText,
  ownershipMarker,
  persistInstallation,
} from '../helpers/platform-installation.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => {
  const actual = await original<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return {
    ...actual,
    log: { ...actual.log, step: vi.fn(), success: vi.fn(), warn: vi.fn() },
    note: vi.fn(),
    outro: vi.fn(),
  };
});

const directories: Array<string> = [];

beforeEach(() => {
  vi.mocked(note).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(printSuccess).mockClear();
  vi.mocked(log.step).mockClear();
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const deployment = createPlatformDeploymentManifest({
  application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
  controlPlane: { apiHostname: 'api.example.com' },
  displayName: 'Example',
  installationSlug: 'example',
});
const names = deployment.resources;
const emailDeployment = createPlatformDeploymentManifest({
  application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
  capabilities: { email: true },
  controlPlane: { apiHostname: 'api.example.com' },
  displayName: 'Example',
  emailSenderDomain: 'mail.example.com',
  emailSharedZoneId: 'mail-zone',
  installationSlug: 'example',
});
const INSTALLATION_ID = 'example-a1b2c3d4';
const FINGERPRINT = '2026-09-14T00:00:00.000Z';
const RESUME = `void platform uninstall ${INSTALLATION_ID} --purge-resources`;
// The installer records its intent right before it creates the AI Gateway.
const AI_GATEWAY_INTENT_AT = '2026-09-14T00:00:01.000Z';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function installedManifest(
  options: { dispatchNamespace?: boolean; email?: boolean } = {},
): PlatformInstallationManifest {
  let manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: '2026-09-14T00:00:00.000Z',
    deployment: options.email ? emailDeployment : deployment,
    id: INSTALLATION_ID,
    ownershipNonce: '0123456789abcdef0123456789abcdef',
    platformVersion: '1.0.0',
  });
  const resources: Array<[string, InstallationResourceKind, ResourceOwnership, string, string]> = [
    ['zone', 'zone', 'adopted', 'zone-id', 'example.com'],
    ['application-dns', 'dns-record', 'created', 'dns-id', '*.apps.example.com'],
    ['routing-kv', 'kv-namespace', 'created', 'routing-id', names.routingKv],
    ['isr-cache-kv', 'kv-namespace', 'created', 'isr-id', names.isrCacheKv],
    ['customer-kv', 'kv-namespace', 'adopted', 'customer-kv-id', 'customer-kv'],
    ['assets-bucket', 'r2-bucket', 'created', names.assetsBucket, names.assetsBucket],
    ['cron-queue', 'queue', 'created', 'cron-id', names.cronQueue],
    ['usage-queue', 'queue', 'created', 'usage-id', names.usageQueue],
    ['hyperdrive', 'hyperdrive', 'created', 'hyperdrive-id', names.hyperdrive],
    ['ai-gateway', 'ai-gateway', 'created', names.aiGateway, names.aiGateway],
    ['api-worker', 'worker', 'created', names.apiWorker, names.apiWorker],
    ['proxy-worker', 'worker', 'created', names.proxyWorker, names.proxyWorker],
    [
      'email-gateway-worker',
      'worker',
      'created',
      names.emailGatewayWorker,
      names.emailGatewayWorker,
    ],
    ['dispatch-worker', 'worker', 'created', names.dispatchWorker, names.dispatchWorker],
    ['tail-worker', 'worker', 'created', names.tailWorker, names.tailWorker],
    ...(options.dispatchNamespace === false
      ? []
      : [
          [
            'dispatch-namespace',
            'dispatch-namespace',
            'created',
            'namespace-uuid',
            names.dispatchNamespace,
          ] as [string, InstallationResourceKind, ResourceOwnership, string, string],
        ]),
  ];
  for (const [key, kind, ownership, id, name] of resources) {
    manifest = recordInstallationResource(
      manifest,
      {
        configHash:
          kind === 'dns-record'
            ? hash({ content: '100::', kind, name, proxied: true, type: 'AAAA' })
            : kind === 'r2-bucket'
              ? hash({ fingerprint: FINGERPRINT, kind, name })
              : 'hash',
        id,
        key,
        kind,
        name,
        ownership,
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
  }
  manifest = recordPlatformWorkerTraffic(
    manifest,
    names.dispatchWorker,
    {
      customDomains: [],
      routes: [
        { id: 'route-1', pattern: '*.apps.example.com/*', script: names.dispatchWorker },
        { id: 'route-2', pattern: '*.apps.example.com', script: names.dispatchWorker },
      ],
    },
    '2026-09-14T00:00:01.000Z',
  );
  manifest = recordPlatformWorkerTraffic(
    manifest,
    names.apiWorker,
    {
      customDomains: [{ hostname: 'api.example.com', id: 'domain-1', service: names.apiWorker }],
      routes: [],
    },
    '2026-09-14T00:00:01.000Z',
  );
  manifest = {
    ...manifest,
    authenticationResources: [
      {
        key: 'login',
        kind: 'application',
        accountId: 'account',
        id: 'access-app',
        name: `void-${INSTALLATION_ID}-login-0123456789abcdef`,
        ownership: 'created',
      },
      {
        key: 'service-token',
        kind: 'service-token',
        accountId: 'account',
        id: 'access-token',
        name: `void-${INSTALLATION_ID}-access-probes-0123456789abcdef`,
        ownership: 'created',
      },
      {
        key: 'company',
        kind: 'application',
        accountId: 'account',
        id: 'company-app',
        name: 'company-app',
        ownership: 'adopted',
      },
    ],
  };
  manifest = recordInstallationStep(
    manifest,
    {
      completedAt: AI_GATEWAY_INTENT_AT,
      key: 'provision-intent:ai-gateway:0123456789abcdef',
      resultHash: 'intent',
    },
    AI_GATEWAY_INTENT_AT,
  );
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

/** A Cloudflare account that enforces the delete rules seen live. */
function cloudflare(manifest: PlatformInstallationManifest) {
  const calls: Array<string> = [];
  const ready = (kind: InstallationResourceKind) =>
    manifest.resources
      .filter((resource) => resource.kind === kind && resource.state === 'ready')
      .map((resource) => ({ id: resource.id, name: resource.name }));
  const workerMarkers = new Map(
    manifest.resources
      .filter((resource) => resource.kind === 'worker')
      .map((resource) => [resource.name, ownershipMarker(manifest, resource)]),
  );
  const bucket = manifest.resources.find((resource) => resource.kind === 'r2-bucket')!;
  const live = {
    aiGateways: ready('ai-gateway').map(
      (entry): { id: string; name: string; createdAt?: string } => ({
        ...entry,
        createdAt: '2026-09-14T00:00:01.400Z',
      }),
    ),
    dispatchNamespaces: ready('dispatch-namespace'),
    namespaceScripts: new Set(
      manifest.resources.some((resource) => resource.kind === 'dispatch-namespace')
        ? ['leftover-app']
        : [],
    ),
    dns: ready('dns-record'),
    hyperdrives: ready('hyperdrive'),
    kv: ready('kv-namespace'),
    queues: ready('queue'),
    consumers: new Map<string, Array<{ id: string; script: string | null }>>([
      ['cron-id', [{ id: 'cron-consumer', script: names.apiWorker }]],
      [
        'usage-id',
        [
          { id: 'usage-consumer', script: names.apiWorker },
          { id: 'foreign-consumer', script: 'someone-else' },
        ],
      ],
    ]),
    buckets: new Map([
      [
        bucket.name,
        {
          fingerprint: FINGERPRINT,
          objects: new Map([
            [PLATFORM_R2_OWNERSHIP_MARKER_KEY, ownershipMarker(manifest, bucket)],
            ['assets/a.txt', 'a'],
          ]),
        },
      ],
    ]),
    workers: workerMarkers,
    routes: [
      { id: 'route-1', pattern: '*.apps.example.com/*', script: names.dispatchWorker as string },
      { id: 'route-2', pattern: '*.apps.example.com', script: names.dispatchWorker as string },
    ],
    domains: [{ hostname: 'api.example.com', id: 'domain-1', service: names.apiWorker as string }],
    access: new Map(
      (manifest.authenticationResources ?? []).map((resource) => [
        resource.id,
        { accountId: resource.accountId, name: resource.name },
      ]),
    ),
    // A Worker the installation did not create that sends logs to the tail Worker.
    foreignTailProducer: false,
    // Service bindings as the installer deploys them: the API Worker checks
    // the proxy through one, and the proxy and email gateway call the API.
    serviceBindings: [
      { from: names.apiWorker as string, to: names.proxyWorker as string },
      { from: names.proxyWorker as string, to: names.apiWorker as string },
      { from: names.emailGatewayWorker as string, to: names.apiWorker as string },
    ],
    // Workers outside the installation, which bind like any other Worker.
    foreignWorkers: new Set<string>(),
    emailRules: [] as Array<{ id: string; enabled: boolean; workerName: string | null }>,
    catchAll: null as { enabled: boolean; workerName: string | null } | null,
  };
  let remote: string | null = JSON.stringify(manifest);
  const failures = new Map<string, Error>();
  const fail = (call: string) => {
    const error = failures.get(call);
    if (error) {
      failures.delete(call);
      throw error;
    }
  };
  const routingLive = () => live.kv.some((entry) => entry.id === 'routing-id');
  const bindersOf = (name: string) =>
    live.serviceBindings
      .filter(
        (binding) =>
          binding.to === name &&
          binding.from !== name &&
          (live.workers.has(binding.from) || live.foreignWorkers.has(binding.from)),
      )
      .map((binding) => binding.from);
  const remove = <T extends { id: string }>(list: Array<T>, id: string) => {
    const index = list.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      list.splice(index, 1);
    }
  };
  const fake = {
    calls,
    live,
    failures,
    deleteKvValue: async () => {},
    deleteResource: async (
      _account: string,
      resource: Readonly<{ id: string; kind: string; name: string }>,
      zoneId?: string,
    ): Promise<void> => {
      const call = `DELETE ${resource.kind} ${resource.name}`;
      calls.push(call);
      fail(call);
      if (resource.kind === 'worker') {
        if (
          resource.name === names.tailWorker &&
          (live.foreignTailProducer ||
            live.workers.has(names.dispatchWorker) ||
            live.namespaceScripts.size > 0)
        ) {
          throw new PlatformCloudflareApiError(
            'Cloudflare API error: Cannot delete this Worker as it is a Tail Worker consumer for other Workers. (code 100109) (HTTP 422; DELETE /workers/scripts).',
            422,
          );
        }
        if ([...live.consumers.values()].flat().some((entry) => entry.script === resource.name)) {
          throw new PlatformCloudflareApiError('Worker is a queue consumer.', 400);
        }
        const binders = bindersOf(resource.name);
        if (binders.length) {
          throw new PlatformCloudflareApiError(
            `Cloudflare API error: Cannot delete service '${resource.name}' because it is still referenced by service bindings in Workers '${binders.join("', '")}'. Please remove bindings pointing to it and try again. (code 10142) (HTTP 400; DELETE /workers/scripts).`,
            400,
          );
        }
        live.workers.delete(resource.name);
      } else if (resource.kind === 'queue') {
        // The API and dispatch Workers produce to the platform Queues.
        const bound = [names.apiWorker, names.dispatchWorker].find((name) =>
          live.workers.has(name),
        );
        if (bound) {
          throw new PlatformCloudflareApiError(`Queue is bound by ${bound}.`, 400);
        }
        remove(live.queues, resource.id);
      } else if (resource.kind === 'dispatch-namespace') {
        expect(resource.name).toBe(names.dispatchNamespace);
        if (live.namespaceScripts.size > 0) {
          throw new PlatformCloudflareApiError('Namespace has scripts.', 400);
        }
        remove(live.dispatchNamespaces, resource.id);
      } else if (resource.kind === 'r2-bucket') {
        if ((live.buckets.get(resource.name)?.objects.size ?? 0) > 0) {
          throw new PlatformCloudflareApiError('The bucket you tried to delete is not empty.', 409);
        }
        live.buckets.delete(resource.name);
      } else if (resource.kind === 'dns-record') {
        expect(zoneId).toBe('zone-id');
        remove(live.dns, resource.id);
      } else if (resource.kind === 'kv-namespace') {
        remove(live.kv, resource.id);
      } else if (resource.kind === 'hyperdrive') {
        remove(live.hyperdrives, resource.id);
      } else if (resource.kind === 'ai-gateway') {
        remove(live.aiGateways, resource.id);
      } else {
        throw new Error(`unexpected delete ${resource.kind}`);
      }
    },
    forceDeleteWorker: async (_account: string, name: string) => {
      const call = `DELETE worker ${name} force`;
      calls.push(call);
      fail(call);
      live.workers.delete(name);
    },
    listWorkerDependents: async (_account: string, name: string) => {
      calls.push(`GET worker-dependents ${name}`);
      return { pagesFunction: false, workers: bindersOf(name) };
    },
    deleteR2Object: async (_account: string, name: string, key: string) => {
      calls.push(`DELETE r2-object ${key}`);
      live.buckets.get(name)?.objects.delete(key);
    },
    emptyR2Bucket: async (
      _account: string,
      name: string,
      preserved: ReadonlySet<string> = new Set(),
      beforeDelete?: () => Promise<void>,
    ) => {
      calls.push(`EMPTY r2-bucket ${name}`);
      const objects = live.buckets.get(name)?.objects;
      const keys = [...(objects?.keys() ?? [])].filter((key) => !preserved.has(key));
      if (keys.length) {
        await beforeDelete?.();
        for (const key of keys) {
          objects!.delete(key);
        }
      }
    },
    deleteWorkerRoute: async (_zone: string, id: string) => {
      calls.push(`DELETE worker-route ${id}`);
      remove(live.routes, id);
    },
    deleteWorkerDomain: async (_account: string, id: string) => {
      calls.push(`DELETE worker-custom-domain ${id}`);
      remove(live.domains, id);
    },
    deleteQueueConsumer: async (_account: string, queue: string, id: string) => {
      calls.push(`DELETE queue-consumer ${queue} ${id}`);
      remove(live.consumers.get(queue) ?? [], id);
    },
    deleteDispatchNamespaceScript: async (_account: string, namespace: string, script: string) => {
      calls.push(`DELETE dispatch-script ${namespace} ${script}`);
      live.namespaceScripts.delete(script);
    },
    deleteAccessResource: async (account: string, kind: string, id: string) => {
      calls.push(`DELETE access ${kind} ${id}`);
      if (live.access.get(id)?.accountId === account) {
        live.access.delete(id);
      }
    },
    // Access ids are scoped to their account, like Cloudflare's API.
    getAccessResource: async (account: string, kind: string, id: string) => {
      calls.push(`GET access ${kind} ${id}`);
      const entry = live.access.get(id);
      return entry?.accountId === account ? { id, name: entry.name } : null;
    },
    findZone: async (_account: string, name: string) =>
      name === 'example.com' ? { id: 'zone-id', name, nameServers: [], status: 'active' } : null,
    getHyperdriveConfig: async (_account: string, id: string) => {
      const entry = live.hyperdrives.find((candidate) => candidate.id === id);
      if (!entry) {
        throw new PlatformCloudflareApiError('missing', 404);
      }
      return {
        ...entry,
        origin: {
          database: 'void',
          host: 'db.example.com',
          port: 5432,
          scheme: 'postgresql' as const,
          user: 'user',
        },
      };
    },
    getKvValue: async () => (routingLive() ? remote : null),
    getR2Object: async (_account: string, name: string, key: string) =>
      live.buckets.get(name)?.objects.get(key) ?? null,
    getWorkerPlainTextBindings: async (
      _account: string,
      name: string,
    ): Promise<Record<string, string>> => {
      const value = live.workers.get(name);
      return value ? { PLATFORM_OWNERSHIP_MARKER: value } : {};
    },
    listAiGateways: async () => [...live.aiGateways],
    listDispatchNamespaces: async () => {
      calls.push('GET dispatch-namespaces');
      return [...live.dispatchNamespaces];
    },
    listDispatchNamespaceScripts: async (_account: string, namespace: string) => {
      calls.push(`GET dispatch-scripts ${namespace}`);
      return [...live.namespaceScripts];
    },
    listDnsRecords: async (_zone: string, name: string) =>
      live.dns
        .filter((entry) => entry.name === name)
        .map((entry) => ({ ...entry, content: '100::', proxied: true, type: 'AAAA' })),
    listHyperdriveConfigs: async () => [...live.hyperdrives],
    listKvNamespaces: async () => [...live.kv],
    listQueues: async (_account: string, name: string) =>
      live.queues.filter((entry) => entry.name === name),
    listQueueConsumers: async (_account: string, queue: string) => [
      ...(live.consumers.get(queue) ?? []),
    ],
    listR2Buckets: async () =>
      [...live.buckets].map(([name, value]) => ({
        fingerprint: value.fingerprint,
        id: name,
        name,
      })),
    listWorkerDomains: async () => [...live.domains],
    listWorkerNames: async () => [...live.workers.keys()],
    listWorkerRoutes: async () => [...live.routes],
    listWorkerServiceRoutes: async (): Promise<Array<{ pattern: string; zoneName: string }>> => [],
    putKvValue: async (_account: string, _namespace: string, key: string, value: string) => {
      calls.push(key === PLATFORM_DISABLED_KEY ? 'PUT disabled' : 'PUT checkpoint');
      if (key !== PLATFORM_DISABLED_KEY) {
        remote = value;
      }
    },
    listEmailRoutingRules: async (zone: string) => {
      calls.push(`GET email-rules ${zone}`);
      return [...live.emailRules];
    },
    deleteEmailRoutingRule: async (zone: string, id: string) => {
      calls.push(`DELETE email-rule ${zone} ${id}`);
      remove(live.emailRules, id);
    },
    getEmailRoutingCatchAll: async (zone: string) => {
      calls.push(`GET email-catch-all ${zone}`);
      return live.catchAll;
    },
    resetEmailRoutingCatchAll: async (zone: string) => {
      calls.push(`RESET email-catch-all ${zone}`);
      live.catchAll = { enabled: false, workerName: null };
    },
  };
  return fake;
}

const purgeResourcesArgs = {
  subcommand: 'uninstall' as const,
  selector: '',
  plan: false,
  purgeData: true,
  purgeResources: true,
  yes: true,
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    interactive: false,
    lockProjectZeroTrust: async () => async () => {},
    fenceProjectZeroTrust: async () => {},
    liftProjectZeroTrustFence: async () => {},
    readProjectZeroTrust: async () => projectZeroTrustUninstallState(undefined, []),
    readProjects: async (): Promise<ReadonlyArray<string>> => [],
    credential: { source: 'environment' as const, aiGatewayToken: false },
    ...overrides,
  };
}

function deletes(fake: ReturnType<typeof cloudflare>): Array<string> {
  return fake.calls.filter((call) => call.startsWith('DELETE') || call.startsWith('EMPTY'));
}

function changes(fake: ReturnType<typeof cloudflare>): Array<string> {
  return fake.calls.filter((call) => !call.startsWith('GET'));
}

/** Runs a plain uninstall that stops at its last write, after every resource was recorded as kept. */
async function stopPlainUninstallAtLastWrite(
  fake: ReturnType<typeof cloudflare>,
  manifest: PlatformInstallationManifest,
): Promise<PlatformInstallationManifest> {
  const putKvValue = fake.putKvValue;
  let failed = false;
  fake.putKvValue = async (account, namespace, key, value) => {
    if (!failed && value.includes('"status":"uninstalled"')) {
      failed = true;
      throw new Error('checkpoint write failed');
    }
    return putKvValue(account, namespace, key, value);
  };
  await expect(
    uninstallPlatform(
      fake,
      manifest,
      { ...purgeResourcesArgs, purgeResources: false, purgeData: false },
      dependencies(),
    ),
  ).rejects.toThrow('checkpoint write failed');
  return listInstallationManifests()[0]!;
}

const FULL_ORDER = [
  'DELETE worker-custom-domain domain-1',
  'DELETE worker-route route-1',
  'DELETE worker-route route-2',
  'DELETE dns-record *.apps.example.com',
  'DELETE access application access-app',
  'DELETE access service-token access-token',
  'DELETE queue-consumer cron-id cron-consumer',
  'DELETE queue-consumer usage-id usage-consumer',
  `DELETE worker ${names.emailGatewayWorker}`,
  `DELETE worker ${names.proxyWorker}`,
  `DELETE worker ${names.proxyWorker} force`,
  `DELETE worker ${names.dispatchWorker}`,
  `DELETE worker ${names.apiWorker}`,
  `DELETE queue ${names.cronQueue}`,
  `DELETE queue ${names.usageQueue}`,
  `DELETE dispatch-script ${names.dispatchNamespace} leftover-app`,
  `DELETE dispatch-namespace ${names.dispatchNamespace}`,
  `DELETE worker ${names.tailWorker}`,
  `DELETE hyperdrive ${names.hyperdrive}`,
  `DELETE kv-namespace ${names.isrCacheKv}`,
  `EMPTY r2-bucket ${names.assetsBucket}`,
  `DELETE r2-object ${PLATFORM_R2_OWNERSHIP_MARKER_KEY}`,
  `DELETE r2-bucket ${names.assetsBucket}`,
  `DELETE ai-gateway ${names.aiGateway}`,
  `DELETE kv-namespace ${names.routingKv}`,
];

describe('uninstall --purge-resources', () => {
  it('plans every deletion in order and every kept resource, using only reads', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    await uninstallPlatform(fake, manifest, { ...purgeResourcesArgs, plan: true }, dependencies());

    const plan = noteText('Uninstall plan');
    expectInOrder(plan, [
      'Delete every resource this installation created (--purge-resources), in this order:',
      `1. worker-custom-domain: api.example.com (domain-1) -> ${names.apiWorker}`,
      `1. worker-route: *.apps.example.com/* (route-1) -> ${names.dispatchWorker}`,
      `1. worker-route: *.apps.example.com (route-2) -> ${names.dispatchWorker}`,
      '2. dns-record: *.apps.example.com (dns-id)',
      `3. Access application: void-${INSTALLATION_ID}-login-0123456789abcdef (access-app)`,
      `3. Access service-token: void-${INSTALLATION_ID}-access-probes-0123456789abcdef (access-token)`,
      "4. queue consumers run by this installation's Workers on:",
      names.cronQueue,
      names.usageQueue,
      `5. worker: ${names.emailGatewayWorker}`,
      `5. worker: ${names.proxyWorker}`,
      `5. worker: ${names.dispatchWorker}`,
      `5. worker: ${names.apiWorker}, with its Durable Object data`,
      `6. queue: ${names.cronQueue} (cron-id)`,
      `6. queue: ${names.usageQueue} (usage-id)`,
      `7. dispatch-namespace: ${names.dispatchNamespace} (namespace-uuid), with any application Workers still in it`,
      `8. worker: ${names.tailWorker}, the tail Worker, after the others`,
      `9. hyperdrive: ${names.hyperdrive} (hyperdrive-id)`,
      `9. kv-namespace: ${names.isrCacheKv} (isr-id)`,
      `10. r2-bucket: ${names.assetsBucket}, emptied first`,
      `11. ai-gateway: ${names.aiGateway}`,
      `12. kv-namespace: ${names.routingKv} (routing-id), last; it holds uninstall progress`,
      'Keep for manual cleanup:',
      'kv-namespace: customer-kv (customer-kv-id)',
      'zone: example.com (zone-id)',
      'Keep Access resources you connected:',
      'adopted application: company-app (company-app, account account)',
      'Always kept:',
      'The external PostgreSQL database and its data.',
      'Analytics Engine datasets',
      'API tokens you created for this platform.',
      'API token needs: Account → Access: Apps and Policies → Edit',
      'Zone → DNS → Edit',
    ]);
    expect(plan).not.toContain(`Access application: company-app`);
    expect(changes(fake)).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('shows the deletion plan before interactive confirmation and leaves cancellation unchanged', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const confirm = vi.fn(async () => {
      expect(noteText('Uninstall plan')).toContain(`5. worker: ${names.apiWorker}`);
      return false;
    });

    await uninstallPlatform(
      fake,
      manifest,
      { ...purgeResourcesArgs, yes: false },
      dependencies({ interactive: true, confirm }),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(changes(fake)).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
    expect(log.step).toHaveBeenCalledWith('Checking platform projects');
    expect(log.step).not.toHaveBeenCalledWith(`Uninstalling ${manifest.deployment.displayName}...`);
    expect(printSuccess).not.toHaveBeenCalled();
  });

  it('deletes in an order Cloudflare accepts, with the tail Worker after its producers and routing KV last', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).toEqual(FULL_ORDER);
    expect(fake.calls.indexOf('PUT disabled')).toBeLessThan(fake.calls.indexOf(FULL_ORDER[0]!));
    // Only the proxy Worker, which the API Worker binds to, is forced, and
    // only after Cloudflare refused it and named no Worker outside the
    // installation.
    expect(fake.calls.filter((call) => call.includes('force'))).toEqual([
      `DELETE worker ${names.proxyWorker} force`,
    ]);
    expect(fake.calls.indexOf(`GET worker-dependents ${names.proxyWorker}`)).toBeGreaterThan(
      fake.calls.indexOf(`DELETE worker ${names.proxyWorker}`),
    );
    // Never touched: the adopted zone and KV, the adopted Access application,
    // and a Queue consumer run by a Worker the installation did not create.
    expect(fake.live.kv).toEqual([{ id: 'customer-kv-id', name: 'customer-kv' }]);
    expect(fake.live.access.has('company-app')).toBe(true);
    expect(fake.live.consumers.get('usage-id')).toEqual([
      { id: 'foreign-consumer', script: 'someone-else' },
    ]);
    const final = listInstallationManifests()[0]!;
    expect(final.status).toBe('uninstalled');
    expect(
      final.resources
        .filter((resource) => resource.state !== 'deleted')
        .map((resource) => `${resource.key}:${resource.state}`),
    ).toEqual(['customer-kv:retained', 'zone:retained']);
    expect(readInstallationRecoverySecrets(final)).toBeNull();
    const kept = noteText('Kept resources');
    expectInOrder(kept, [
      'kv-namespace: customer-kv (customer-kv-id)',
      'zone: example.com (zone-id)',
      'adopted application: company-app',
    ]);
    expect(kept).not.toContain('access-app');
    expect(kept).not.toContain('Always kept:');
    expect(noteText('Uninstall plan')).toBe('');
    expect(log.step).toHaveBeenCalledWith('Uninstalling Example...');
    expect(printSuccess).toHaveBeenCalledWith('Uninstalled Example.');
  });

  it('resumes after a failure without repeating finished deletions', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.failures.set(`DELETE queue ${names.usageQueue}`, new Error('temporary failure'));

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow('temporary failure');
    const stopped = listInstallationManifests()[0]!;
    expect(stopped.status).toBe('failed');
    expect(fake.live.workers.has(names.apiWorker)).toBe(false);
    expect(fake.live.workers.has(names.tailWorker)).toBe(true);

    await uninstallPlatform(fake, stopped, purgeResourcesArgs, dependencies());

    // The failed DELETE is retried once; nothing else is sent twice.
    const sent = deletes(fake);
    const retried = `DELETE queue ${names.usageQueue}`;
    expect(sent.filter((call) => call === retried)).toHaveLength(2);
    expect(sent.filter((call, index) => call !== retried && sent.indexOf(call) !== index)).toEqual(
      [],
    );
    expect(new Set(sent)).toEqual(new Set(FULL_ORDER));
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it.each([
    { bucket: 'with a creation fingerprint', legacy: false },
    { bucket: 'recorded before creation fingerprints', legacy: true },
  ])(
    'resumes an R2 deletion after its ownership marker was removed, for a bucket $bucket',
    async ({ legacy }) => {
      let manifest = installedManifest();
      if (legacy) {
        const bucket = manifest.resources.find((resource) => resource.kind === 'r2-bucket')!;
        manifest = recordInstallationResource(
          manifest,
          { ...bucket, configHash: hash({ kind: 'r2-bucket', name: bucket.name }) },
          manifest.updatedAt,
        );
      }
      persistInstallation(manifest, directories);
      const fake = cloudflare(manifest);
      fake.failures.set(`DELETE r2-bucket ${names.assetsBucket}`, new Error('temporary failure'));

      await expect(
        uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
      ).rejects.toThrow('temporary failure');
      expect(fake.live.buckets.get(names.assetsBucket)?.objects.size).toBe(0);

      await uninstallPlatform(
        fake,
        listInstallationManifests()[0]!,
        purgeResourcesArgs,
        dependencies(),
      );
      expect(fake.live.buckets.has(names.assetsBucket)).toBe(false);
      expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    },
  );

  it('refuses an R2 bucket replaced after its ownership marker was removed', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.failures.set(`DELETE r2-bucket ${names.assetsBucket}`, new Error('temporary failure'));
    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow('temporary failure');
    fake.live.buckets.set(names.assetsBucket, {
      fingerprint: '2026-10-01T00:00:00.000Z',
      objects: new Map([['someone-else.txt', 'x']]),
    });

    await expect(
      uninstallPlatform(fake, listInstallationManifests()[0]!, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(`Refusing to delete R2 bucket ${names.assetsBucket}`);
    expect(fake.live.buckets.get(names.assetsBucket)?.objects.has('someone-else.txt')).toBe(true);
  });

  it('refuses before any change when a Worker no longer carries this installation marker', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const replacement = { ...manifest, ownershipNonce: 'replacement-owner-nonce-00000000' };
    fake.live.workers.set(
      names.proxyWorker,
      ownershipMarker(
        replacement,
        manifest.resources.find((resource) => resource.key === 'proxy-worker')!,
      ),
    );

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow('belongs to another installation');
    expect(changes(fake)).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('keeps a route that now serves another Worker, lists why, and does not let it block a rerun', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.routes[1]!.script = 'someone-else';
    // A later, unrelated stop makes the run resume.
    fake.live.foreignTailProducer = true;

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(`Cloudflare refused to delete worker ${names.tailWorker}`);
    const stopped = listInstallationManifests()[0]!;
    expect(
      stopped.resources.find((resource) => resource.key === 'worker-route:route-2')?.state,
    ).toBe('retained');
    expect(deletes(fake)).toContain(`DELETE worker ${names.apiWorker}`);

    fake.live.foreignTailProducer = false;
    await uninstallPlatform(fake, stopped, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).not.toContain('DELETE worker-route route-2');
    expect(fake.live.routes).toEqual([
      { id: 'route-2', pattern: '*.apps.example.com', script: 'someone-else' },
    ]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(noteText('Kept resources')).toContain(
      'worker-route: *.apps.example.com (route-2), kept because it now sends "*.apps.example.com" to "someone-else"',
    );
  });

  it('keeps a custom domain that now serves another Worker and continues', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.domains[0]!.service = 'someone-else';

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).not.toContain('DELETE worker-custom-domain domain-1');
    expect(fake.live.domains).toHaveLength(1);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(noteText('Kept resources')).toContain(
      'worker-custom-domain: api.example.com (domain-1), kept because it now sends "api.example.com" to "someone-else"',
    );
  });

  it('keeps a DNS record whose configuration changed and continues', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.listDnsRecords = async (_zone: string, name: string) =>
      fake.live.dns
        .filter((entry) => entry.name === name)
        .map((entry) => ({ ...entry, content: '192.0.2.1', proxied: false, type: 'A' }));

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).not.toContain('DELETE dns-record *.apps.example.com');
    expect(fake.live.dns).toHaveLength(1);
    const final = listInstallationManifests()[0]!;
    expect(final.status).toBe('uninstalled');
    expect(final.resources.find((resource) => resource.key === 'application-dns')?.state).toBe(
      'retained',
    );
    expect(noteText('Kept resources')).toContain(
      'dns-record: *.apps.example.com (dns-id), kept because its configuration changed after installation',
    );
  });

  it('keeps an Access application whose name changed and continues', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.access.set('access-app', { accountId: 'account', name: 'renamed' });

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).not.toContain('DELETE access application access-app');
    expect(deletes(fake)).toContain('DELETE access service-token access-token');
    expect(fake.live.access.get('access-app')?.name).toBe('renamed');
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(noteText('Kept resources')).toContain(
      `created application: void-${INSTALLATION_ID}-login-0123456789abcdef (access-app, account account), kept because its live name "renamed" is not the name this installation recorded`,
    );
  });

  it('detaches Email Routing rules that send mail to the gateway Worker before deleting it', async () => {
    const manifest = installedManifest({ email: true });
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const gateway = names.emailGatewayWorker;
    fake.live.emailRules.push(
      { id: 'ours', enabled: true, workerName: gateway },
      { id: 'ours-disabled', enabled: false, workerName: gateway },
      { id: 'theirs', enabled: true, workerName: 'someone-else' },
      { id: 'forward', enabled: true, workerName: null },
    );
    fake.live.catchAll = { enabled: true, workerName: gateway };

    await uninstallPlatform(fake, manifest, { ...purgeResourcesArgs, plan: true }, dependencies());
    expect(noteText('Uninstall plan')).toContain(
      `4. Email Routing rules in zone mail-zone that send mail to ${gateway}, and its catch-all rule if it does (reset to drop mail, disabled)`,
    );
    expect(changes(fake)).toEqual([]);

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expectInOrder(changes(fake).join('\n'), [
      'DELETE access service-token access-token',
      'DELETE email-rule mail-zone ours',
      'DELETE email-rule mail-zone ours-disabled',
      'RESET email-catch-all mail-zone',
      `DELETE worker ${gateway}`,
    ]);
    expect(fake.live.emailRules.map((rule) => rule.id)).toEqual(['theirs', 'forward']);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
    expect(noteText('Kept resources')).toContain(
      "Email Routing for mail.example.com (zone mail-zone): its settings and the sender domain's MX, SPF, and DKIM records.",
    );
  });

  it('leaves an Email Routing catch-all that sends mail to another Worker', async () => {
    const manifest = installedManifest({ email: true });
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.catchAll = { enabled: true, workerName: 'someone-else' };

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(fake.calls).not.toContain('RESET email-catch-all mail-zone');
    expect(fake.live.catchAll).toEqual({ enabled: true, workerName: 'someone-else' });
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('names the Email Routing permission when the credential cannot read the rules', async () => {
    const manifest = installedManifest({ email: true });
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.listEmailRoutingRules = async () => {
      throw new PlatformCloudflareApiError('Authentication error', 403);
    };

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(
      'Add Zone → Email Routing Rules → Edit for account account and zone example.com and Email Routing zone mail-zone, then rerun. No Cloudflare resource was changed.',
    );
    expect(changes(fake)).toEqual([]);
  });

  it('makes no Email Routing call when the platform does not send email', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    await uninstallPlatform(fake, manifest, { ...purgeResourcesArgs, plan: true }, dependencies());
    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(fake.calls.filter((call) => /email-(rule|catch-all)/.test(call))).toEqual([]);
    expect(noteText('Uninstall plan')).not.toContain('Email Routing Rules');
  });

  it('finishes with --purge-resources what a stopped --purge-data uninstall kept', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    // The namespace still holds an application Worker, so --purge-data stops.
    await expect(
      uninstallPlatform(
        fake,
        manifest,
        { ...purgeResourcesArgs, purgeResources: false },
        dependencies(),
      ),
    ).rejects.toThrow('Namespace has scripts.');
    const stopped = listInstallationManifests()[0]!;
    expect(stopped.status).toBe('failed');
    expect(stopped.resources.find((resource) => resource.key === 'api-worker')?.state).toBe(
      'retained',
    );

    await uninstallPlatform(fake, stopped, purgeResourcesArgs, dependencies());

    expect(new Set(deletes(fake))).toEqual(new Set(FULL_ORDER));
    const final = listInstallationManifests()[0]!;
    expect(final.status).toBe('uninstalled');
    expect(
      final.resources
        .filter((resource) => resource.state !== 'deleted')
        .map((resource) => `${resource.key}:${resource.state}`),
    ).toEqual(['customer-kv:retained', 'zone:retained']);
  });

  it('finishes with --purge-resources what a stopped plain uninstall kept, including routing KV', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    const stopped = await stopPlainUninstallAtLastWrite(fake, manifest);
    expect(stopped.status).toBe('failed');
    expect(stopped.resources.find((resource) => resource.key === 'routing-kv')?.state).toBe(
      'retained',
    );
    expect(deletes(fake)).toEqual([]);

    await uninstallPlatform(fake, stopped, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).toEqual(FULL_ORDER);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('refuses before any change when a Worker a stopped uninstall kept no longer carries this installation marker', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const stopped = await stopPlainUninstallAtLastWrite(fake, manifest);
    expect(stopped.resources.find((resource) => resource.key === 'proxy-worker')?.state).toBe(
      'retained',
    );
    const replacement = { ...manifest, ownershipNonce: 'replacement-owner-nonce-00000000' };
    fake.live.workers.set(
      names.proxyWorker,
      ownershipMarker(
        replacement,
        manifest.resources.find((resource) => resource.key === 'proxy-worker')!,
      ),
    );
    const before = changes(fake).length;

    await expect(
      uninstallPlatform(fake, stopped, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow('belongs to another installation');
    expect(changes(fake).slice(before)).toEqual([]);
    const final = listInstallationManifests()[0]!;
    expect(final.status).toBe('failed');
    // Kept resources stay recorded as kept.
    expect(final.resources.find((resource) => resource.key === 'proxy-worker')?.state).toBe(
      'retained',
    );
  });

  it('lists an Access resource an earlier --purge-resources kept with the other kept resources, not as connected', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.access.set('access-app', { accountId: 'account', name: 'renamed' });
    // A later, unrelated stop makes the run resume.
    fake.live.foreignTailProducer = true;
    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(`Cloudflare refused to delete worker ${names.tailWorker}`);
    const stopped = listInstallationManifests()[0]!;

    await uninstallPlatform(fake, stopped, { ...purgeResourcesArgs, plan: true }, dependencies());

    const plan = noteText('Uninstall plan');
    const kept = `created application: void-${INSTALLATION_ID}-login-0123456789abcdef (access-app, account account), kept because its live name "renamed" is not the name this installation recorded`;
    expectInOrder(plan, [
      'Keep for manual cleanup:',
      kept,
      'Keep Access resources you connected:',
      'adopted application: company-app',
    ]);
    expect(plan.slice(plan.indexOf('Keep Access resources you connected:'))).not.toContain(
      'access-app',
    );
  });

  it('never reopens an uninstall that finished', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    await uninstallPlatform(
      fake,
      manifest,
      { ...purgeResourcesArgs, purgeResources: false, purgeData: false },
      dependencies(),
    );
    const finished = listInstallationManifests()[0]!;
    expect(finished.status).toBe('uninstalled');
    const before = changes(fake).length;

    await uninstallPlatform(fake, finished, { ...purgeResourcesArgs, plan: true }, dependencies());
    expect(noteText('Uninstall plan')).toContain('--purge-resources finds no resource');
    await expect(
      uninstallPlatform(fake, finished, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow('Invalid installation transition: uninstalled -> uninstalling.');

    expect(changes(fake).slice(before)).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('never forces a Worker that a Worker outside the installation binds to, and names it', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.foreignWorkers.add('customer-worker');
    fake.live.serviceBindings.push({ from: 'customer-worker', to: names.proxyWorker as string });

    const error = await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(
      `Cloudflare refused to delete worker ${names.proxyWorker}: Cloudflare API error: Cannot delete service`,
    );
    expect(error?.message).toContain(
      'Workers outside this installation still use it: customer-worker.',
    );
    expect(error?.message).toContain(`Progress is saved. Rerun: ${RESUME}`);
    expect(fake.calls.some((call) => call.includes('force'))).toBe(false);
    expect(fake.live.workers.has(names.proxyWorker)).toBe(true);
    expect(fake.live.workers.has(names.apiWorker)).toBe(true);
    expect(listInstallationManifests()[0]?.status).toBe('failed');

    fake.live.serviceBindings.pop();
    await uninstallPlatform(
      fake,
      listInstallationManifests()[0]!,
      purgeResourcesArgs,
      dependencies(),
    );
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('never forces a Worker whose dependent has a recorded name but is not proven to be the installation’s', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    // While the run is going, another Worker takes the API Worker's name and
    // still binds to the proxy.
    const replacement = { ...manifest, ownershipNonce: 'replacement-owner-nonce-00000000' };
    const deleteResource = fake.deleteResource;
    fake.deleteResource = async (...args: Parameters<typeof deleteResource>) => {
      if (args[1].name === names.proxyWorker) {
        fake.live.workers.set(
          names.apiWorker as string,
          ownershipMarker(
            replacement,
            manifest.resources.find((resource) => resource.key === 'api-worker')!,
          ),
        );
      }
      return deleteResource(...args);
    };

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(`worker ${names.apiWorker} belongs to another installation`);
    expect(fake.calls.some((call) => call.includes('force'))).toBe(false);
    expect(fake.live.workers.has(names.proxyWorker)).toBe(true);
  });

  it('never forces a Worker whose dependent was recorded as deleted', async () => {
    const recorded = installedManifest();
    const manifest = {
      ...recorded,
      resources: recorded.resources.map((resource) =>
        resource.key === 'api-worker' ? { ...resource, state: 'deleted' as const } : resource,
      ),
    };
    persistInstallation(manifest, directories);
    const fake = cloudflare(recorded);

    const error = await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(
      `Workers outside this installation still use it: ${names.apiWorker}.`,
    );
    expect(fake.calls.some((call) => call.includes('force'))).toBe(false);
    expect(fake.live.workers.has(names.proxyWorker)).toBe(true);
  });

  it('never forces a Worker when Cloudflare cannot list what depends on it', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.listWorkerDependents = async () => {
      throw new PlatformCloudflareApiError('Authentication error (code 10000)', 403);
    };

    const error = await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(`Cloudflare refused to delete worker ${names.proxyWorker}`);
    expect(fake.calls.some((call) => call.includes('force'))).toBe(false);
    expect(fake.live.workers.has(names.proxyWorker)).toBe(true);
  });

  it('stops with a clear message when Cloudflare refuses the tail Worker, and never forces it', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.live.foreignTailProducer = true;

    const error = await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(
      `Cloudflare refused to delete worker ${names.tailWorker}: Cloudflare API error: Cannot delete this Worker as it is a Tail Worker consumer for other Workers. (code 100109)`,
    );
    expect(error?.message).toContain('for example by sending it logs as a tail Worker');
    expect(error?.message).toContain(`Progress is saved. Rerun: ${RESUME}`);
    expect(
      deletes(fake).filter((call) => call === `DELETE worker ${names.tailWorker}`),
    ).toHaveLength(1);
    expect(fake.calls).not.toContain(`DELETE worker ${names.tailWorker} force`);
    expect(listInstallationManifests()[0]?.status).toBe('failed');

    fake.live.foreignTailProducer = false;
    await uninstallPlatform(
      fake,
      listInstallationManifests()[0]!,
      purgeResourcesArgs,
      dependencies(),
    );
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('refuses before any change while projects remain, in the plan too', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const withProjects = dependencies({ readProjects: async () => ['blog', 'shop'] });
    const message = [
      'platform: Refusing --purge-resources while the platform still has 2 projects.',
      "--purge-resources deletes the platform, and only the running platform can delete each project's Workers, storage, and domains.",
      'Delete each project first with `void project delete <name>`, then retry:',
      '  blog',
      '  shop',
    ].join('\n');

    await expect(
      uninstallPlatform(fake, manifest, { ...purgeResourcesArgs, plan: true }, withProjects),
    ).rejects.toThrow(message);
    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, withProjects),
    ).rejects.toThrow(message);
    await expect(
      uninstallPlatform(
        fake,
        manifest,
        purgeResourcesArgs,
        dependencies({
          readProjects: async () => {
            throw new Error('connection refused');
          },
        }),
      ),
    ).rejects.toThrow(
      'project list could not be read from the platform database: connection refused',
    );
    expect(fake.calls).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');
  });

  it('reads project slugs, including a database without projects', async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('to_regclass') ? [{ present: true }] : [{ slug: 'blog' }],
    }));
    await expect(readPlatformProjectSlugsConnection({ query } as never)).resolves.toEqual(['blog']);
    await expect(
      readPlatformProjectSlugsConnection({
        query: async () => ({ rows: [{ present: false }] }),
      } as never),
    ).resolves.toEqual([]);
  });

  it('refuses browser login before any change and names the token permissions', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const oauth = dependencies({ credential: { source: 'oauth', aiGatewayToken: true } });

    await expect(uninstallPlatform(fake, manifest, purgeResourcesArgs, oauth)).rejects.toThrow(
      'Browser login is missing: Zone → DNS → Edit, Account → Access: Apps and Policies → Edit, Account → Access: Service Tokens → Edit. No Cloudflare resource was changed.',
    );
    expect(changes(fake)).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('installed');

    // The plan still prints and warns instead of failing.
    await uninstallPlatform(fake, manifest, { ...purgeResourcesArgs, plan: true }, oauth);
    expect(noteText('Uninstall plan')).toContain('Delete every resource');
    expect(String(vi.mocked(log.warn).mock.calls.at(-1)?.[0])).toContain(
      'Set CLOUDFLARE_API_TOKEN',
    );
  });

  it('names a token permission that a read probe shows is missing', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    fake.listDnsRecords = async () => {
      throw new PlatformCloudflareApiError('Authentication error', 403);
    };

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(
      'cannot read every resource --purge-resources would delete. Add Zone → DNS → Edit for account account and zone example.com, then rerun. No Cloudflare resource was changed.',
    );
    expect(changes(fake)).toEqual([]);
  });

  it('makes no Workers for Platforms call when the installation has no dispatch namespace', async () => {
    const manifest = installedManifest({ dispatchNamespace: false });
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    await uninstallPlatform(fake, manifest, { ...purgeResourcesArgs, plan: true }, dependencies());
    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(fake.calls.filter((call) => /dispatch-(namespace|script)/.test(call))).toEqual([]);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('deletes an Access service token in the identity account that holds it', async () => {
    const base = installedManifest();
    const manifest = {
      ...base,
      authenticationResources: base.authenticationResources!.map((resource) =>
        resource.key === 'service-token' ? { ...resource, accountId: 'identity' } : resource,
      ),
    };
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(fake.live.access.has('access-token')).toBe(false);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('names the identity account when the credential cannot read its Access resources', async () => {
    const base = installedManifest();
    const manifest = {
      ...base,
      authenticationResources: base.authenticationResources!.map((resource) =>
        resource.key === 'service-token' ? { ...resource, accountId: 'identity' } : resource,
      ),
    };
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    const getAccessResource = fake.getAccessResource;
    fake.getAccessResource = async (account: string, kind: string, id: string) => {
      if (account === 'identity') {
        throw new PlatformCloudflareApiError('Authentication error', 403);
      }
      return getAccessResource(account, kind, id);
    };

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies()),
    ).rejects.toThrow(
      'Add Account → Access: Service Tokens → Edit for accounts account and identity and zone example.com, then rerun.',
    );
    expect(changes(fake)).toEqual([]);
  });

  it('keeps an AI Gateway that Cloudflare shows was not created during installation', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    // Someone deleted the original gateway and made a new one with the same id.
    fake.live.aiGateways[0]!.createdAt = '2026-10-01T00:00:00.000Z';

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).not.toContain(`DELETE ai-gateway ${names.aiGateway}`);
    expect(fake.live.aiGateways.map((gateway) => gateway.id)).toEqual([names.aiGateway]);
    const final = listInstallationManifests()[0]!;
    expect(final.status).toBe('uninstalled');
    expect(final.resources.find((resource) => resource.key === 'ai-gateway')?.state).toBe(
      'retained',
    );
    expect(noteText('Kept resources')).toContain(`ai-gateway: ${names.aiGateway}`);
  });

  it('keeps an AI Gateway whose creation time Cloudflare does not report', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    delete fake.live.aiGateways[0]!.createdAt;

    await uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies());

    expect(deletes(fake)).not.toContain(`DELETE ai-gateway ${names.aiGateway}`);
    expect(listInstallationManifests()[0]?.status).toBe('uninstalled');
  });

  it('stops before deleting application Workers when a project appears during the run', async () => {
    const manifest = installedManifest();
    persistInstallation(manifest, directories);
    const fake = cloudflare(manifest);
    let reads = 0;
    // Both checks before the first change see no project; one is created after.
    const readProjects = async () => (++reads > 2 ? ['late-project'] : []);

    await expect(
      uninstallPlatform(fake, manifest, purgeResourcesArgs, dependencies({ readProjects })),
    ).rejects.toThrow(
      `platform: Stopped before deleting the application Workers in dispatch namespace ${names.dispatchNamespace} because a project was created while this uninstall ran: late-project.`,
    );
    expect(deletes(fake).some((call) => call.startsWith('DELETE dispatch-'))).toBe(false);
    expect(fake.live.namespaceScripts.has('leftover-app')).toBe(true);
    expect(listInstallationManifests()[0]?.status).toBe('failed');
  });
});
