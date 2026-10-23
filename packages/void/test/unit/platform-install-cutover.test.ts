import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import {
  createPlatformDeploymentManifest,
  PLATFORM_DISABLED_KEY,
  PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY,
  type PlatformInstallationManifest,
} from '@void/platform';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { hyperdriveOriginFromConnectionString } from '../../src/cli/platform-cloudflare.ts';
import { verifyPlatformWorkerCutoverVersions } from '../../src/cli/platform-installer-cutover.ts';
import {
  type PlatformInstallerDependencies,
  type PlatformInstallationSecrets,
} from '../../src/cli/platform-installer-types.ts';
import {
  createPlatformInstallationSecrets,
  installPlatform,
} from '../../src/cli/platform-installer.ts';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import {
  listInstallationManifests,
  readInstallationRecoverySecrets,
} from '../../src/cli/platform-registry.ts';
import type { RunWrangler } from '../../src/cli/provision.ts';

// Runs the real Worker deploy, cutover checkpoint, and pre-traffic verification
// against a stateful in-memory Cloudflare account. Only the provider process is
// replaced; the guarded create still goes through the conditional-create proxy.
const wrangler = vi.hoisted(() => ({ run: null as RunWrangler | null }));
vi.mock('../../src/cli/provision.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/provision.ts')>()),
  createDefaultRunWrangler: () => (args: CloudflareOperation, opts: Parameters<RunWrangler>[1]) =>
    wrangler.run!(args, opts),
}));

const TEST_PLATFORM_JWT_SECRET = 'test-only-platform-jwt-secret-material';
const TEST_PLATFORM_PROJECT_SECRET_KEY = Buffer.alloc(32, 5).toString('base64');
const directories: Array<string> = [];
const servers: Array<Server> = [];

beforeEach(() => {
  process.env.VOID_PLATFORM_RECOVERY_KEY = Buffer.alloc(32, 7).toString('base64');
  const directory = mkdtempSync(join(tmpdir(), 'void-platform-install-cutover-'));
  directories.push(directory);
  process.env.VOID_PLATFORM_REGISTRY_DIR = directory;
});

afterEach(async () => {
  wrangler.run = null;
  delete process.env.VOID_PLATFORM_RECOVERY_KEY;
  delete process.env.VOID_PLATFORM_REGISTRY_DIR;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

type FakeVersion = {
  annotations: Record<string, string>;
  id: string;
  resources: {
    bindings: Array<{ name: string; text: string; type: string }>;
    script_runtime?: { migration_tag: string };
  };
};
type FakeDeployment = {
  created_on: string;
  id: string;
  versions: Array<{ percentage: number; version_id: string }>;
};

async function createFakeCloudflare() {
  const upstream = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"success":true,"errors":[],"result":{}}');
    });
  });
  servers.push(upstream);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const apiBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/client/v4`;
  const workers = new Map<
    string,
    { deployments: Array<FakeDeployment>; versions: Map<string, FakeVersion> }
  >();
  const kv = new Map<string, string>();
  const r2 = new Map<string, string>();
  const named = new Map<string, Map<string, string>>();
  const commands: Array<{ args: CloudflareOperation; worker: string | null }> = [];
  let clock = Date.parse('2026-10-01T00:00:00.000Z');
  let failBlockedCreate: string | null = null;
  let failUpload: string | null = null;

  const configOf = (operation: CloudflareOperation): Record<string, unknown> | null => {
    return operation.configPath ? JSON.parse(readFileSync(operation.configPath, 'utf8')) : null;
  };
  const workerOf = (operation: CloudflareOperation) =>
    ('workerName' in operation ? operation.workerName : undefined) ??
    (configOf(operation)?.name as string | undefined) ??
    null;
  const ok = (data?: unknown) => ({ status: 0, stderr: '', stdout: '', data });
  const failed = (stderr: string) => ({ status: 1, stderr, stdout: '' });
  const storeVersion = (name: string, operation: CloudflareOperation): FakeVersion => {
    const config = configOf(operation)!;
    const vars = (config.vars ?? {}) as Record<string, string>;
    const migrations = Array.isArray(config.migrations) ? config.migrations : [];
    const tag = (migrations.at(-1) as { tag?: string } | undefined)?.tag;
    const version: FakeVersion = {
      annotations: { 'workers/message': 'message' in operation ? (operation.message ?? '') : '' },
      id: randomUUID(),
      resources: {
        bindings: [
          {
            name: 'PLATFORM_OWNERSHIP_MARKER',
            text: vars.PLATFORM_OWNERSHIP_MARKER ?? '',
            type: 'plain_text',
          },
        ],
        ...(tag ? { script_runtime: { migration_tag: tag } } : {}),
      },
    };
    const worker = workers.get(name) ?? { deployments: [], versions: new Map() };
    worker.versions.set(version.id, version);
    workers.set(name, worker);
    return version;
  };
  const activate = (name: string, versionId: string) => {
    workers.get(name)!.deployments.unshift({
      created_on: new Date((clock += 1000)).toISOString(),
      id: randomUUID(),
      versions: [{ percentage: 100, version_id: versionId }],
    });
  };

  wrangler.run = async (args, opts) => {
    const worker = workerOf(args);
    commands.push({ args, worker });
    if (args.type === 'worker.deploy') {
      const base = `${opts.apiBaseUrl}/accounts/${opts.accountId}/workers/scripts/${worker}`;
      if (failBlockedCreate === worker) {
        failBlockedCreate = null;
        await fetch(`${base}/unexpected-mutation`, { method: 'POST' });
        return failed('Mutation blocked until conditional Worker creation succeeds');
      }
      const created = await fetch(`${base}?excludeScript=true`, { method: 'PUT', body: '{}' });
      if (!created.ok) {
        return failed(`create failed (${created.status})`);
      }
      const version = storeVersion(worker!, args);
      activate(worker!, version.id);
      return ok({ versionId: version.id });
    }
    if (args.type === 'versions.upload') {
      if (failUpload === worker) {
        failUpload = null;
        return failed('upload failed');
      }
      const version = storeVersion(worker!, args);
      return ok({ versionId: version.id });
    }
    if (args.type === 'versions.deploy') {
      const entry = workers.get(worker!)!;
      entry.deployments.unshift({
        created_on: new Date((clock += 1000)).toISOString(),
        id: randomUUID(),
        versions: args.versions.map((target) => ({
          percentage: target.percentage,
          version_id: target.versionId,
        })),
      });
      return ok();
    }
    if (args.type === 'deployments.list') {
      const entry = workers.get(worker!);
      return entry ? ok(entry.deployments) : failed('Worker not found');
    }
    if (args.type === 'deployments.status') {
      const latest = workers.get(worker!)?.deployments[0];
      return latest ? ok({ versions: latest.versions }) : failed('not found');
    }
    if (args.type === 'versions.view') {
      const version = workers.get(worker!)?.versions.get(args.versionId);
      return version ? ok(version) : failed('version not found');
    }
    if (args.type === 'triggers.deploy') {
      return ok();
    }
    throw new Error(`Unexpected Cloudflare operation: ${args.type}`);
  };

  const create =
    (kind: string) =>
    async (_account: string, name: string, ..._rest: Array<unknown>) => {
      const resources = named.get(kind) ?? new Map<string, string>();
      named.set(kind, resources);
      // AI Gateways are addressed by name.
      const id =
        resources.get(name) ?? (kind === 'ai-gateway' ? name : `${kind}-${resources.size}`);
      resources.set(name, id);
      return {
        id,
        name,
        ...(kind === 'r2' ? { fingerprint: '2026-10-01T00:00:00.000Z' } : {}),
      };
    };
  const list = (kind: string, name?: string) =>
    [...(named.get(kind) ?? new Map<string, string>())]
      .filter(([entry]) => name === undefined || entry === name)
      .map(([entry, id]) => ({
        id,
        name: entry,
        ...(kind === 'r2' ? { fingerprint: '2026-10-01T00:00:00.000Z' } : {}),
      }));
  const plainTextBindings = async (_account: string, name: string) => {
    const entry = workers.get(name);
    const active = entry?.deployments[0]?.versions[0]?.version_id;
    const version = active ? entry!.versions.get(active) : undefined;
    return Object.fromEntries(
      (version?.resources.bindings ?? []).map((binding) => [binding.name, binding.text]),
    );
  };

  const client = {
    apiBaseUrl,
    createAiGateway: create('ai-gateway'),
    createDispatchNamespace: create('dispatch'),
    createDnsRecord: async (): Promise<never> => {
      throw new Error('No DNS expected');
    },
    createHyperdrive: create('hyperdrive'),
    createKvNamespace: create('kv'),
    createQueue: create('queue'),
    createR2Bucket: create('r2'),
    createZone: async (): Promise<never> => {
      throw new Error('No zone expected');
    },
    deleteKvValue: async (_account: string, namespace: string, key: string) => {
      kv.delete(`${namespace}/${key}`);
    },
    disableHyperdriveCaching: async () => {},
    getHyperdriveConfig: async (_account: string, id: string) => ({
      cachingDisabled: true,
      id,
      name: list('hyperdrive').find((entry) => entry.id === id)!.name,
      origin: hyperdriveOriginFromConnectionString(DATABASE_URL),
    }),
    getWorkerPlainTextBindings: plainTextBindings,
    listWorkerDomains: async () => [],
    listWorkerNames: async () => [...workers.keys()],
    listWorkerRoutes: async () => [],
    listWorkerServiceRoutes: async () => [],
    publishWorkerCustomDomainsSafely: async () => {},
    publishWorkerRoutesSafely: async () => {},
    putKvValue: async (_account: string, namespace: string, key: string, value: string) => {
      kv.set(`${namespace}/${key}`, value);
    },
    putR2Object: async (_account: string, bucket: string, key: string, value: string) => {
      r2.set(`${bucket}/${key}`, value);
    },
    // Worker reads fall back to the provider process, which this fake models.
    request: async (path: string): Promise<never> => {
      throw new Error(`No Cloudflare API read expected: ${path}`);
    },
  };
  const planningClient = {
    findZone: async (): Promise<never> => {
      throw new Error('No zone expected');
    },
    findZoneForHostname: async () => null,
    getKvValue: async (_account: string, namespace: string, key: string) =>
      kv.get(`${namespace}/${key}`) ?? null,
    getR2Object: async (_account: string, bucket: string, key: string) =>
      r2.get(`${bucket}/${key}`) ?? null,
    getWorkerPlainTextBindings: plainTextBindings,
    getWorkersSubdomain: async () => 'workers-subdomain',
    hasActiveCertificateForHostname: async () => true,
    listAccounts: async () => [{ id: 'account', name: 'Account' }],
    listAiGateways: async () => list('ai-gateway'),
    listDispatchNamespaces: async () => list('dispatch'),
    listDnsRecords: async () => [],
    listHyperdriveConfigs: async () => list('hyperdrive'),
    listKvNamespaces: async (_account: string, title?: string) => list('kv', title),
    listQueues: async (_account: string, name: string) => list('queue', name),
    listR2Buckets: async () => list('r2'),
    listWorkerDomains: async () => [],
    listWorkerNames: async () => [...workers.keys()],
    listWorkerRoutes: async () => [],
  };
  return {
    client,
    commands,
    failBlockedCreate: (worker: string) => {
      failBlockedCreate = worker;
    },
    failUpload: (worker: string) => {
      failUpload = worker;
    },
    kv,
    planningClient,
    replaceActiveVersion: (name: string) => {
      const worker = workers.get(name)!;
      const active = worker.versions.get(worker.deployments[0]!.versions[0]!.version_id)!;
      const replacement = { ...structuredClone(active), id: randomUUID() };
      worker.versions.set(replacement.id, replacement);
      activate(name, replacement.id);
    },
    restorePreviousVersion: (name: string) => {
      activate(name, workers.get(name)!.deployments[1]!.versions[0]!.version_id);
    },
  };
}

const DATABASE_URL = 'postgres://user:password@db.example.com/testing';

function installationSecrets(sharedEmail = false) {
  return createPlatformInstallationSecrets({
    bootstrapGitHubId: '583231',
    bootstrapGitHubLogin: 'octocat',
    cloudflareApiToken: 'test-token',
    databaseUrl: DATABASE_URL,
    emailEnabled: sharedEmail,
    githubClientId: 'id',
    githubClientSecret: 'secret',
    jwtSecret: TEST_PLATFORM_JWT_SECRET,
    projectSecretKey: TEST_PLATFORM_PROJECT_SECRET_KEY,
    r2AccessKeyId: 'id',
    r2SecretAccessKey: 'secret',
  });
}

function planInstallation(
  cloud: Awaited<ReturnType<typeof createFakeCloudflare>>,
  existing: PlatformInstallationManifest | null,
  sharedEmail = false,
) {
  return createPlatformInstallPlan(
    cloud.planningClient,
    {
      accountId: 'account',
      applicationDomain: '',
      controlPlaneDomain: '',
      dedicatedZone: false,
      displayName: 'Testing',
      ...(sharedEmail
        ? { emailSenderDomain: 'mail.example.com', emailSharedZoneId: 'email-zone' }
        : {}),
      installationSlug: 'testing',
      workersDev: true,
      zoneName: '',
    },
    existing,
  );
}

async function runInstall(
  cloud: Awaited<ReturnType<typeof createFakeCloudflare>>,
  existing: PlatformInstallationManifest | null,
  options: {
    sharedEmail?: boolean;
    bootstrapEmail?: PlatformInstallerDependencies['bootstrapEmail'];
    secrets?: PlatformInstallationSecrets;
    verifyHealth?: PlatformInstallerDependencies['verifyHealth'];
  } = {},
) {
  const plan = await planInstallation(cloud, existing, options.sharedEmail);
  return installPlatform(
    plan,
    options.secrets ?? installationSecrets(options.sharedEmail),
    existing,
    {
      acquireDatabaseLifecycleLock: async () =>
        Object.assign(async () => {}, {
          prepareSandboxDrain: async () => ({
            admissionProtocol: 3 as const,
            generation: 'generation-1',
            state: 'complete' as const,
          }),
        }),
      claimDatabase: async () => {},
      client: cloud.client,
      prepareDatabase: async () => ({
        appliedMigrations: 0,
        previousSchemaDigest: '',
        schemaDigest: '',
      }),
      revalidateBeforeWorkerDeploy: async () => {},
      verifyHealth: options.verifyHealth ?? (async () => {}),
      ...(options.bootstrapEmail ? { bootstrapEmail: options.bootstrapEmail } : {}),
    },
  );
}

function currentManifest(): PlatformInstallationManifest {
  return listInstallationManifests(process.env.VOID_PLATFORM_REGISTRY_DIR!)[0]!;
}

function workerStepKeys(manifest: PlatformInstallationManifest) {
  return manifest.steps.map((step) => step.key).filter((key) => key.startsWith('worker-'));
}

const WORKER_KEYS = ['api', 'proxy', 'emailGateway', 'tail', 'dispatch'];

function rotateSecrets(manifest: PlatformInstallationManifest) {
  return createPlatformInstallationSecrets({
    ...installationSecrets(),
    checkpoint: readInstallationRecoverySecrets(manifest),
    cloudflareApiToken: 'rotated-runtime-token',
    existingInstallation: true,
    updateExistingWorkers: true,
  });
}

function resumeSecrets(manifest: PlatformInstallationManifest) {
  return createPlatformInstallationSecrets({
    ...installationSecrets(),
    checkpoint: readInstallationRecoverySecrets(manifest),
    cloudflareApiToken: '',
    githubClientId: '',
    githubClientSecret: '',
    r2AccessKeyId: '',
    r2SecretAccessKey: '',
    existingInstallation: true,
    updateExistingWorkers: true,
  });
}

it('rolls forward a partially restored credential update without restoring old secret versions', async () => {
  const cloud = await createFakeCloudflare();
  const installed = await runInstall(cloud, null);
  const existing = {
    ...installed.manifest,
    deployment: createPlatformDeploymentManifest({
      ...installed.manifest.deployment,
      authentication: { ...installed.manifest.deployment.authentication, configurable: true },
    }),
  };
  const start = cloud.commands.length;
  await expect(
    runInstall(cloud, existing, {
      secrets: rotateSecrets(existing),
      verifyHealth: async () => {
        throw new Error('network unavailable');
      },
    }),
  ).rejects.toThrow('network unavailable');
  const failed = currentManifest();
  const routing = failed.resources.find((resource) => resource.key === 'routing-kv')!;
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(true);
  expect(
    cloud.commands
      .slice(start)
      .filter(
        ({ args }) =>
          args.type === 'versions.deploy' && args.message?.startsWith('Void platform restoration'),
      ),
  ).toEqual([]);

  // Older installers restored these Workers before Cloudflare rejected the
  // API/proxy rollback because CF_API_TOKEN and R2 credentials had changed.
  for (const name of [
    failed.deployment.resources.emailGatewayWorker,
    failed.deployment.resources.tailWorker,
    failed.deployment.resources.dispatchWorker,
  ]) {
    cloud.restorePreviousVersion(name);
  }
  const resumeStart = cloud.commands.length;
  let healthChecks = 0;
  const result = await runInstall(cloud, failed, {
    secrets: rotateSecrets(failed),
    verifyHealth: async () => {
      if (healthChecks++ === 0) {
        expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(true);
      }
    },
  });
  expect(result.manifest.status).toBe('installed');
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(false);
  expect(
    cloud.commands
      .slice(resumeStart)
      .filter(
        ({ args }) =>
          args.type === 'versions.deploy' && args.message?.startsWith('Void platform restoration'),
      ),
  ).toEqual([]);
  expect(readInstallationRecoverySecrets(result.manifest)?.workerSecretUpdatesJson).toBeUndefined();
});

it('refuses a concurrent version replacement while recovering a credential update', async () => {
  const cloud = await createFakeCloudflare();
  const installed = await runInstall(cloud, null);
  const existing = {
    ...installed.manifest,
    deployment: createPlatformDeploymentManifest({
      ...installed.manifest.deployment,
      authentication: { ...installed.manifest.deployment.authentication, configurable: true },
    }),
  };
  await expect(
    runInstall(cloud, existing, {
      secrets: rotateSecrets(existing),
      verifyHealth: async () => {
        throw new Error('network unavailable');
      },
    }),
  ).rejects.toThrow('network unavailable');
  const failed = currentManifest();
  cloud.replaceActiveVersion(failed.deployment.resources.apiWorker);
  const start = cloud.commands.length;
  await expect(runInstall(cloud, failed, { secrets: rotateSecrets(failed) })).rejects.toThrow(
    'changed concurrently after the credential update',
  );
  expect(
    cloud.commands
      .slice(start)
      .filter(({ args }) =>
        ['versions.deploy', 'versions.upload', 'worker.deploy'].includes(args.type),
      ),
  ).toEqual([]);
});

it('resumes from encrypted credentials after the prior generation commits but before staging', async () => {
  const cloud = await createFakeCloudflare();
  const installed = await runInstall(cloud, null);
  const existing = {
    ...installed.manifest,
    deployment: createPlatformDeploymentManifest({
      ...installed.manifest.deployment,
      authentication: { ...installed.manifest.deployment.authentication, configurable: true },
    }),
  };
  await expect(
    runInstall(cloud, existing, {
      secrets: rotateSecrets(existing),
      verifyHealth: async () => {
        throw new Error('network unavailable');
      },
    }),
  ).rejects.toThrow('network unavailable');
  const failed = currentManifest();
  const put = cloud.client.putKvValue;
  let stopped = false;
  cloud.client.putKvValue = async (...args) => {
    await put(...args);
    if (
      !stopped &&
      args[2] === PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY &&
      workerStepKeys(JSON.parse(args[3])).includes('worker-cutover:3:committed')
    ) {
      stopped = true;
      throw new Error('interrupted after recovery checkpoint');
    }
  };
  await expect(runInstall(cloud, failed, { secrets: rotateSecrets(failed) })).rejects.toThrow(
    'interrupted after recovery checkpoint',
  );
  const checkpoint = currentManifest();
  expect(stagedKeys(checkpoint, 4)).toEqual([]);
  const routing = checkpoint.resources.find((resource) => resource.key === 'routing-kv')!;
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(true);
  const recovered = resumeSecrets(checkpoint);
  expect(recovered.pendingWorkerSecretUpdateIntent?.updates.CF_API_TOKEN).toBe(
    'rotated-runtime-token',
  );
  const resumed = await runInstall(cloud, checkpoint, { secrets: recovered });
  expect(resumed.manifest.status).toBe('installed');
  expect(stagedKeys(resumed.manifest, 5)).toEqual([...WORKER_KEYS].sort());
});

it('resumes a credential update that stopped before activating any Worker', async () => {
  const cloud = await createFakeCloudflare();
  const installed = await runInstall(cloud, null);
  cloud.failUpload(installed.manifest.deployment.resources.apiWorker);
  await expect(
    runInstall(cloud, installed.manifest, { secrets: rotateSecrets(installed.manifest) }),
  ).rejects.toThrow('upload failed');
  const failed = currentManifest();
  expect(stagedKeys(failed, 3)).toEqual([]);
  const resumed = await runInstall(cloud, failed, { secrets: resumeSecrets(failed) });
  expect(resumed.manifest.status).toBe('installed');
  expect(stagedKeys(resumed.manifest, 5)).toEqual([...WORKER_KEYS].sort());
});

it('resumes when the next pending generation is saved before its encrypted checkpoint', async () => {
  const cloud = await createFakeCloudflare();
  const installed = await runInstall(cloud, null);
  const existing = {
    ...installed.manifest,
    deployment: createPlatformDeploymentManifest({
      ...installed.manifest.deployment,
      authentication: { ...installed.manifest.deployment.authentication, configurable: true },
    }),
  };
  await expect(
    runInstall(cloud, existing, {
      secrets: rotateSecrets(existing),
      verifyHealth: async () => {
        throw new Error('network unavailable');
      },
    }),
  ).rejects.toThrow('network unavailable');
  const failed = currentManifest();
  const intentId = resumeSecrets(failed).pendingWorkerSecretUpdateIntent!.id;
  const put = cloud.client.putKvValue;
  let stopped = false;
  cloud.client.putKvValue = async (...args) => {
    await put(...args);
    if (
      !stopped &&
      args[2] === PLATFORM_REMOTE_INSTALLATION_MANIFEST_KEY &&
      workerStepKeys(JSON.parse(args[3])).includes('worker-secret-updates:4:pending')
    ) {
      stopped = true;
      throw new Error('interrupted after next pending marker');
    }
  };
  await expect(runInstall(cloud, failed, { secrets: resumeSecrets(failed) })).rejects.toThrow(
    'interrupted after next pending marker',
  );
  const checkpoint = currentManifest();
  expect(workerStepKeys(checkpoint)).toContain('worker-secret-updates:4:pending');
  expect(stagedKeys(checkpoint, 4)).toEqual([]);
  const recovered = resumeSecrets(checkpoint);
  expect(recovered.pendingWorkerSecretUpdateIntent).toMatchObject({
    id: intentId,
    updates: { CF_API_TOKEN: 'rotated-runtime-token' },
  });
  const routing = checkpoint.resources.find((resource) => resource.key === 'routing-kv')!;
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(true);
  const resumed = await runInstall(cloud, checkpoint, { secrets: recovered });
  expect(resumed.manifest.status).toBe('installed');
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(false);
});

it('still restores a failed cutover without credential updates', async () => {
  const cloud = await createFakeCloudflare();
  const installed = await runInstall(cloud, null);
  const existing = {
    ...installed.manifest,
    usageProtocolVersion: 1 as const,
    deployment: createPlatformDeploymentManifest({
      ...installed.manifest.deployment,
      authentication: { ...installed.manifest.deployment.authentication, configurable: true },
    }),
  };
  const start = cloud.commands.length;
  await expect(
    runInstall(cloud, existing, {
      secrets: resumeSecrets(existing),
      verifyHealth: async () => {
        throw new Error('health unavailable');
      },
    }),
  ).rejects.toThrow('health unavailable');
  expect(workerStepKeys(currentManifest())).toContain('worker-cutover:3:restored');
  expect(
    cloud.commands
      .slice(start)
      .some(
        ({ args }) =>
          args.type === 'versions.deploy' && args.message?.startsWith('Void platform restoration'),
      ),
  ).toBe(true);
});

function stagedKeys(manifest: PlatformInstallationManifest, generation: number) {
  const prefix = `worker-cutover:${generation}:staged:`;
  return workerStepKeys(manifest)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .sort();
}

it('stages a fresh immutable version of every Worker before enabling a fresh install', async () => {
  const cloud = await createFakeCloudflare();

  const result = await runInstall(cloud, null);

  expect(result.manifest.status).toBe('installed');
  expect(stagedKeys(result.manifest, 1)).toEqual([...WORKER_KEYS].sort());
  expect(stagedKeys(result.manifest, 2)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(result.manifest)).toContain('worker-cutover:2:committed');
  // The tail Worker config is identical in both generations, yet it is still restaged.
  const tail = result.manifest.deployment.resources.tailWorker;
  expect(
    cloud.commands
      .filter((command) => command.worker === tail)
      .map((command) => command.args.type)
      .filter((command) => command === 'worker.deploy' || command === 'versions.upload'),
  ).toEqual(['worker.deploy', 'versions.upload']);
});

it('enables traffic when resuming after the first Worker create was refused', async () => {
  const cloud = await createFakeCloudflare();
  const plan = await planInstallation(cloud, null);
  cloud.failBlockedCreate(plan.deployment.resources.apiWorker);

  await expect(runInstall(cloud, null)).rejects.toThrow('unexpected mutation');
  const failed = currentManifest();
  expect(failed.status).toBe('failed');
  expect(workerStepKeys(failed)).toEqual([]);

  const resumed = await runInstall(cloud, failed);

  expect(resumed.manifest.status).toBe('installed');
  expect(stagedKeys(resumed.manifest, 1)).toEqual([...WORKER_KEYS].sort());
  expect(stagedKeys(resumed.manifest, 2)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(resumed.manifest)).toContain('worker-cutover:2:committed');
});

it('retries a restored enabling generation with every Worker restaged', async () => {
  const cloud = await createFakeCloudflare();
  const plan = await planInstallation(cloud, null);
  // The tail Worker is created with a guarded deploy, so its first version
  // upload is the enabling generation. Failing it leaves that generation restored.
  cloud.failUpload(plan.deployment.resources.tailWorker);

  await expect(runInstall(cloud, null)).rejects.toThrow('upload failed');
  const failed = currentManifest();
  expect(failed.status).toBe('failed');
  expect(workerStepKeys(failed)).toEqual(
    expect.arrayContaining(['worker-cutover:1:committed', 'worker-cutover:2:restored']),
  );
  expect(stagedKeys(failed, 2)).not.toContain('tail');

  const retried = await runInstall(cloud, failed);

  expect(retried.manifest.status).toBe('installed');
  // The staging generation still reuses an unchanged Worker version.
  expect(stagedKeys(retried.manifest, 3)).not.toContain('tail');
  expect(stagedKeys(retried.manifest, 4)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(retried.manifest)).toContain('worker-cutover:4:committed');
});

it('rechecks the committed immutable versions after shared email routing is prepared', async () => {
  const cloud = await createFakeCloudflare();
  const bootstrapEmail = vi.fn(async () => {
    expect(workerStepKeys(currentManifest())).toContain('worker-cutover:2:committed');
    return 'email-operation';
  });

  const result = await runInstall(cloud, null, { sharedEmail: true, bootstrapEmail });

  expect(result.manifest.status).toBe('installed');
  expect(bootstrapEmail).toHaveBeenCalledOnce();
  expect(stagedKeys(result.manifest, 2)).toEqual([...WORKER_KEYS].sort());
  const routing = result.manifest.resources.find((resource) => resource.key === 'routing-kv')!;
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(false);
});

it('rejects a concurrent version replacement after shared email commits the Worker generation', async () => {
  const cloud = await createFakeCloudflare();
  const plan = await planInstallation(cloud, null, true);
  const bootstrapEmail = async () => {
    cloud.replaceActiveVersion(plan.deployment.resources.apiWorker);
    return 'email-operation';
  };

  await expect(runInstall(cloud, null, { sharedEmail: true, bootstrapEmail })).rejects.toThrow(
    'changed concurrently from staged version',
  );

  const failed = currentManifest();
  expect(failed.status).toBe('failed');
  expect(workerStepKeys(failed)).toContain('worker-cutover:2:committed');
  expect(workerStepKeys(failed)).not.toContain('worker-cutover:2:restored');
  const routing = failed.resources.find((resource) => resource.key === 'routing-kv')!;
  expect(cloud.kv.has(`${routing.id}/${PLATFORM_DISABLED_KEY}`)).toBe(true);
});

it('resumes a shared email failure with a fresh verified immutable generation', async () => {
  const cloud = await createFakeCloudflare();
  const bootstrapEmail = vi
    .fn()
    .mockRejectedValueOnce(new Error('mail unavailable'))
    .mockResolvedValue('email-operation');
  await expect(runInstall(cloud, null, { sharedEmail: true, bootstrapEmail })).rejects.toThrow(
    'mail unavailable',
  );
  const failed = currentManifest();
  expect(workerStepKeys(failed)).toContain('worker-cutover:2:committed');

  const result = await runInstall(cloud, failed, { sharedEmail: true, bootstrapEmail });

  expect(result.manifest.status).toBe('installed');
  expect(bootstrapEmail).toHaveBeenCalledTimes(2);
  expect(stagedKeys(result.manifest, 4)).toEqual([...WORKER_KEYS].sort());
  expect(workerStepKeys(result.manifest)).toContain('worker-cutover:4:committed');
});

it('does not use a restored generation as authority to enable traffic', async () => {
  const cloud = await createFakeCloudflare();
  const result = await runInstall(cloud, null);
  const restored = {
    ...result.manifest,
    steps: result.manifest.steps.map((step) =>
      step.key === 'worker-cutover:2:committed'
        ? { ...step, key: 'worker-cutover:2:restored', resultHash: 'restored' }
        : step,
    ),
  };
  const runner = vi.fn();
  await expect(
    verifyPlatformWorkerCutoverVersions(
      restored,
      2,
      {} as Parameters<typeof verifyPlatformWorkerCutoverVersions>[2],
      'account',
      runner,
    ),
  ).rejects.toThrow('missing a complete immutable-version checkpoint');
  expect(runner).not.toHaveBeenCalled();
});
