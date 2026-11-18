import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformInstallationManifest,
  type PlatformInstallationManifest,
} from '@void/platform';
import { resolvePlatformRuntime } from '@void/platform/installer';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { verifyPlatformDeploymentExecutionDrain } from '../../src/cli/platform-installer-health.ts';
import {
  installPlatform,
  createPlatformInstallationSecrets,
} from '../../src/cli/platform-installer.ts';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import { writeInstallationManifest } from '../../src/cli/platform-registry.ts';

const directories: Array<string> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function probe(pendingDeployments = 0, admissionClosed = true) {
  return {
    protocolVersion: 1,
    installationId: 'team-12345678',
    pendingDeployments,
    admissionClosed,
  };
}

it('authenticates a closed, fully drained deployment executor before allowing downgrade', async () => {
  const fetcher = vi.fn(async () => Response.json(probe()));
  await verifyPlatformDeploymentExecutionDrain(
    'https://api.example.com',
    'probe',
    'team-12345678',
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.example.com/__void/platform/deployment-execution',
    expect.objectContaining({
      headers: expect.objectContaining({ 'X-Void-Platform-Probe': 'probe' }),
      redirect: 'manual',
    }),
  );
});

it.each([
  probe(1),
  probe(0, false),
  { ...probe(), installationId: 'other-12345678' },
  { ...probe(), pendingDeployments: -1 },
  { ...probe(), pendingDeployments: '0' },
  null,
])('rejects an unfinished, unfenced, or invalid executor drain document: %j', async (status) => {
  await expect(
    verifyPlatformDeploymentExecutionDrain(
      'https://api.example.com',
      'probe',
      'team-12345678',
      async () => Response.json(status),
    ),
  ).rejects.toThrow('platform:');
});

it.each([404, 503])(
  'fails closed when the current runtime drain probe is unavailable (%s)',
  async (status) => {
    await expect(
      verifyPlatformDeploymentExecutionDrain(
        'https://api.example.com',
        'probe',
        'team-12345678',
        async () => new Response('', { status }),
      ),
    ).rejects.toThrow('drain probe failed');
  },
);

it.each([1, 0])(
  'fences admission and checks %s pending operations before any provisioning',
  async (pendingDeployments) => {
    const directory = mkdtempSync(join(tmpdir(), 'void-deployment-drain-'));
    directories.push(directory);
    vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
    vi.stubEnv('VOID_PLATFORM_RECOVERY_KEY', Buffer.alloc(32, 7).toString('base64'));
    const plan = await createPlatformInstallPlan(
      {
        listAccounts: async () => [{ id: 'account', name: 'Account' }],
        getWorkersSubdomain: async () => 'team',
        hasActiveCertificateForHostname: async () => true,
        getKvValue: async () => null,
        listAiGateways: async () => [],
        findZone: async () => null,
        findZoneForHostname: async () => null,
        listDnsRecords: async () => [],
        getR2Object: async () => null,
        getWorkerPlainTextBindings: async () => ({}),
        listKvNamespaces: async () => [],
        listR2Buckets: async () => [],
        listQueues: async () => [],
        listDispatchNamespaces: async () => [],
        listHyperdriveConfigs: async () => [],
        listWorkerNames: async () => [],
        listWorkerDomains: async () => [],
        listWorkerRoutes: async () => [],
      },
      {
        accountId: 'account',
        displayName: 'Team',
        installationSlug: 'team',
        dedicatedZone: false,
        applicationDomain: 'team.workers.dev',
        controlPlaneDomain: '',
        zoneName: '',
        workersDev: true,
      },
      null,
    );
    const installed = {
      ...createPlatformInstallationManifest({
        account: plan.account,
        deployment: plan.deployment,
        deploymentExecution: 1,
        id: plan.installationId,
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        createdAt: '2026-10-01T00:00:00.000Z',
        platformVersion: '1.0.0',
      }),
      status: 'installed' as const,
    };
    const runtime = resolvePlatformRuntime();
    writeInstallationManifest(installed);
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId: '1',
      bootstrapGitHubLogin: 'test',
      cloudflareApiToken: 'fixture',
      databaseUrl: 'postgres://user:password@db.example.com/void',
      githubClientId: 'fixture',
      githubClientSecret: 'fixture',
      jwtSecret: 'test-only-platform-jwt-secret-material',
      projectSecretKey: Buffer.alloc(32, 5).toString('base64'),
      r2AccessKeyId: 'fixture',
      r2SecretAccessKey: 'fixture',
    });
    let checkpointStatus = '';
    const provision = vi.fn(async () => {
      throw new Error('provisioning reached');
    });
    const checkDrain = vi.fn(async (_url: string, _token: string, id: string) => {
      expect(checkpointStatus).toBe('provisioning');
      expect(provision).not.toHaveBeenCalled();
      await verifyPlatformDeploymentExecutionDrain(
        'https://api.example.com',
        'probe',
        id,
        async () => Response.json({ ...probe(pendingDeployments), installationId: id }),
      );
    });
    await expect(
      installPlatform(plan, secrets, installed, {
        runtime: { ...runtime, manifest: { ...runtime.manifest, deploymentExecution: undefined } },
        claimDatabase: async () => {},
        acquireDatabaseLifecycleLock: async () =>
          Object.assign(async () => {}, {
            checkpoint: async (manifest: PlatformInstallationManifest) => {
              checkpointStatus = manifest.status;
            },
          }),
        verifyDeploymentExecutionDrain: checkDrain,
        revalidateBeforeWorkerDeploy: async () => {},
        client: {
          apiBaseUrl: 'https://api.cloudflare.com/client/v4',
          createZone: provision,
          createAiGateway: provision,
          createDnsRecord: provision,
          createHyperdrive: provision,
          getHyperdriveConfig: provision,
          disableHyperdriveCaching: provision,
          createKvNamespace: provision,
          createQueue: provision,
          createR2Bucket: provision,
          createDispatchNamespace: provision,
          deleteKvBulk: provision,
          deleteKvValue: provision,
          getWorkerPlainTextBindings: provision,
          listKvKeys: provision,
          listWorkerDomains: provision,
          listWorkerNames: provision,
          listWorkerRoutes: provision,
          listWorkerServiceRoutes: provision,
          publishWorkerCustomDomainsSafely: provision,
          publishWorkerRoutesSafely: provision,
          putKvBulk: provision,
          putKvValue: async () => {},
          putR2Object: async () => {},
          request: provision,
        },
      }),
    ).rejects.toThrow(pendingDeployments ? 'unfinished' : 'provisioning reached');
    expect(checkDrain).toHaveBeenCalledOnce();
    expect(provision).toHaveBeenCalledTimes(pendingDeployments ? 0 : 1);
  },
);
