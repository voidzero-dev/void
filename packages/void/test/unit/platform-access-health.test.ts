import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  recordInstallationStep,
} from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  ensurePlatformAccessHealthChecks,
  platformAccessHealthTargets,
} from '../../src/cli/platform-access-health.ts';
import {
  PlatformCloudflareApiError,
  PlatformCloudflareClient,
} from '../../src/cli/platform-cloudflare.ts';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import { platformAccessFixture } from '../fixtures/platform-access.ts';

function fixture(workersDev = false) {
  const env = platformAccessFixture();
  const deployment = createPlatformDeploymentManifest({
    installationSlug: 'team',
    displayName: 'Team',
    authentication: { providers: ['github'], configurable: true, accessProtection: true },
    application: workersDev
      ? {
          baseDomain: 'account.workers.dev',
          zoneName: '',
          workersDev: { subdomain: 'account', installationId: 'team-installation' },
        }
      : { baseDomain: 'apps.example.com', zoneName: 'example.com' },
  });
  const manifest = createPlatformInstallationManifest({
    account: { id: 'account', name: 'Account' },
    createdAt: new Date(0).toISOString(),
    deployment,
    id: 'team-installation',
    ownershipNonce: 'a'.repeat(43),
    platformVersion: '1.0.0',
  });
  const plan: PlatformInstallPlan = {
    account: manifest.account,
    actions: [],
    apiUrl: 'https://api.example.com',
    proxyUrl: 'https://proxy.example.com',
    installationId: manifest.id,
    deployment,
    workersSubdomain: 'account',
    zone: null,
  };
  const checkpoint: Record<string, string> = {
    accessSetupSpecJson: JSON.stringify({ mode: 'create' }),
  };
  const input = {
    plan,
    manifest,
    client: env.transport,
    checkpoint,
    save: (encoded: string) => {
      checkpoint.accessHealthProvisioningJson = encoded;
    },
  };
  return { env, input };
}

beforeEach(() => vi.stubEnv('VOID_PLATFORM_ACCESS_SETUP_TOKEN', ''));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('protected platform health checks', () => {
  it.each([false, true])(
    'does not reuse completed app setup credentials during maintenance (platform protection: %s)',
    async (protection) => {
      const { env, input } = fixture();
      const deployment = createPlatformDeploymentManifest({
        ...input.plan.deployment,
        appAccess: 'public',
        authentication: {
          providers: ['github'],
          ...(protection ? { accessProtection: true } : {}),
        },
      });
      const completedAt = new Date().toISOString();
      const manifest = recordInstallationStep(
        { ...input.manifest, deployment },
        { key: 'app-access-initialized:v1', completedAt, resultHash: 'setup-complete' },
        completedAt,
      );
      const retiredToken = vi
        .spyOn(PlatformCloudflareClient.prototype, 'request')
        .mockRejectedValue(new PlatformCloudflareApiError('retired app setup token', 403));
      await ensurePlatformAccessHealthChecks({
        ...input,
        plan: { ...input.plan, deployment },
        manifest,
        checkpoint: {
          ...input.checkpoint,
          appAccessSetupJson: JSON.stringify({
            version: 1,
            accountId: 'account',
            mode: 'public',
            managed: true,
            apiToken: 'retired-app-token',
            identityProviderIds: [],
            policyIds: [],
          }),
        },
      });
      expect(retiredToken).not.toHaveBeenCalled();
      expect(env.apps.size).toBe(protection ? 1 : 0);
    },
  );

  it('uses app-management authority for scoped health access without platform Access protection', async () => {
    const { env, input } = fixture(true);
    const deployment = createPlatformDeploymentManifest({
      ...input.plan.deployment,
      appAccess: 'public',
      authentication: { providers: ['github'] },
    });
    const appAccessSetupJson = JSON.stringify({
      version: 1,
      accountId: 'account',
      mode: 'public',
      managed: true,
      apiToken: 'app-management',
      identityProviderIds: [],
      policyIds: [],
    });
    vi.spyOn(PlatformCloudflareClient.prototype, 'request').mockImplementation(
      env.transport.request,
    );
    await ensurePlatformAccessHealthChecks({
      ...input,
      plan: { ...input.plan, deployment },
      manifest: { ...input.manifest, deployment },
      checkpoint: { appAccessSetupJson },
    });
    expect([...env.apps.values()]).toMatchObject([
      {
        domain: `${deployment.resources.dispatchWorker}.account.workers.dev/health`,
        policies: [{ decision: 'bypass', include: [{ everyone: {} }] }],
      },
    ]);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  it.each([false, true])(
    'creates and reuses only the reserved health path (workers.dev: %s)',
    async (workersDev) => {
      const { env, input } = fixture(workersDev);
      const destination = workersDev
        ? `${input.plan.deployment.resources.dispatchWorker}.account.workers.dev/health`
        : 'void-platform-health.apps.example.com/health';
      await ensurePlatformAccessHealthChecks(input);
      const app = [...env.apps.values()][0];
      expect(app).toMatchObject({
        type: 'self_hosted',
        domain: destination,
        destinations: [{ type: 'public', uri: destination }],
        policies: [
          {
            name: 'Void platform health check',
            decision: 'bypass',
            precedence: 1,
            include: [{ everyone: {} }],
          },
        ],
      });
      expect(app).not.toHaveProperty('target_criteria');
      expect(env.tokens.size).toBe(0);
      expect(
        JSON.parse(input.checkpoint.accessHealthProvisioningJson).resources[
          platformAccessHealthTargets(input.plan)[0].key
        ],
      ).toMatchObject({ id: app.id, pending: false });
      await ensurePlatformAccessHealthChecks(input);
      expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    },
  );

  it('leaves employee protection and unrelated applications untouched', async () => {
    const { env, input } = fixture();
    const employeeApp = {
      id: 'employee-app',
      name: 'Company gate',
      type: 'self_hosted',
      domain: '*.apps.example.com',
      policies: [{ id: 'employees' }],
    };
    env.apps.set(employeeApp.id, structuredClone(employeeApp));
    await ensurePlatformAccessHealthChecks(input);
    expect(env.apps.get(employeeApp.id)).toEqual(employeeApp);
    expect(env.calls.filter((call) => call.method !== 'GET')).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: 'apps',
        body: expect.objectContaining({ domain: 'void-platform-health.apps.example.com/health' }),
      }),
    ]);
  });

  it('retains the original exception when the platform adds an application domain', async () => {
    const { env, input } = fixture(true);
    await ensurePlatformAccessHealthChecks(input);
    const original = [...env.apps.values()][0];
    const deployment = createPlatformDeploymentManifest({
      ...input.plan.deployment,
      application: { baseDomain: 'apps.example.net', zoneName: 'example.net' },
    });
    await ensurePlatformAccessHealthChecks({ ...input, plan: { ...input.plan, deployment } });
    expect(env.apps.get(String(original.id))).toEqual(original);
    expect([...env.apps.values()].map((app) => app.domain)).toEqual([
      `${input.plan.deployment.resources.dispatchWorker}.account.workers.dev/health`,
      'void-platform-health.apps.example.net/health',
    ]);
  });

  it('recovers an uncertain create by its recorded identity without creating a duplicate', async () => {
    const { env, input } = fixture();
    env.loseNextApplicationResponse();
    await expect(ensurePlatformAccessHealthChecks(input)).rejects.toThrow('response lost');
    expect(
      JSON.parse(input.checkpoint.accessHealthProvisioningJson).resources[
        platformAccessHealthTargets(input.plan)[0].key
      ],
    ).toMatchObject({ pending: true });
    await ensurePlatformAccessHealthChecks(input);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(
      JSON.parse(input.checkpoint.accessHealthProvisioningJson).resources[
        platformAccessHealthTargets(input.plan)[0].key
      ],
    ).toMatchObject({ pending: false });
  });

  it('does not repeat an ambiguous create when the resource cannot be located', async () => {
    const { env, input } = fixture();
    env.loseNextApplicationResponse();
    await expect(ensurePlatformAccessHealthChecks(input)).rejects.toThrow('response lost');
    env.apps.clear();
    await expect(ensurePlatformAccessHealthChecks(input)).rejects.toThrow('uncertain outcome');
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('allows a new attempt after a definite authorization rejection', async () => {
    const { env, input } = fixture();
    const original = env.transport.request;
    const request = vi.spyOn(env.transport, 'request');
    request.mockImplementation(async (path, init) => {
      if (init?.method === 'POST') {
        throw new PlatformCloudflareApiError('denied', 403, path);
      }
      return original(path, init);
    });
    await expect(ensurePlatformAccessHealthChecks(input)).rejects.toThrow('denied');
    expect(
      JSON.parse(input.checkpoint.accessHealthProvisioningJson).resources[
        platformAccessHealthTargets(input.plan)[0].key
      ],
    ).toMatchObject({ pending: false });
    request.mockImplementation(original);
    await ensurePlatformAccessHealthChecks(input);
    expect(env.apps.size).toBe(1);
  });

  it.each(['hostname', 'worker', 'policy', 'identity', 'checkpoint'] as const)(
    'rejects changed exception %s without overwriting it',
    async (change) => {
      const { env, input } = fixture();
      await ensurePlatformAccessHealthChecks(input);
      const app = [...env.apps.values()][0];
      if (change === 'hostname') {
        app.domain = 'apps.example.com';
      }
      if (change === 'worker') {
        app.destinations = [{ type: 'worker', service: 'dispatch' }];
      }
      if (change === 'policy') {
        app.policies = [{ decision: 'allow', include: [{ everyone: {} }] }];
      }
      if (change === 'identity') {
        app.name = 'foreign-application';
      }
      if (change === 'checkpoint') {
        const state = JSON.parse(input.checkpoint.accessHealthProvisioningJson);
        state.installationId = 'another-installation';
        input.checkpoint.accessHealthProvisioningJson = JSON.stringify(state);
      }
      env.calls.length = 0;
      await expect(ensurePlatformAccessHealthChecks(input)).rejects.toThrow(
        /health|different installation/i,
      );
      expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
    },
  );

  it('verifies an existing project-managed exception without taking ownership', async () => {
    const { env, input } = fixture();
    const destination = platformAccessHealthTargets(input.plan)[0].destination;
    env.apps.set('project-health', {
      id: 'project-health',
      name: 'Project health',
      type: 'self_hosted',
      domain: destination,
      destinations: [{ type: 'public', uri: destination }],
      policies: [{ decision: 'bypass', include: [{ everyone: {} }] }],
    });
    await ensurePlatformAccessHealthChecks(input);
    expect(input.checkpoint.accessHealthProvisioningJson).toBeUndefined();
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('does not create resources when the operator chose externally managed Access', async () => {
    const { env, input } = fixture();
    input.checkpoint.accessSetupSpecJson = JSON.stringify({ mode: 'existing' });
    await expect(ensurePlatformAccessHealthChecks(input)).rejects.toThrow(
      'Configure an Access exception limited to',
    );
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('does nothing when Access protection is disabled', async () => {
    const { env, input } = fixture();
    await ensurePlatformAccessHealthChecks({
      ...input,
      plan: {
        ...input.plan,
        deployment: { ...input.plan.deployment, authentication: { providers: ['github'] } },
      },
    });
    expect(env.calls).toEqual([]);
  });
});
