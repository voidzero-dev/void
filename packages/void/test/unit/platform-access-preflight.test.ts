import { createHash } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import { verifyInstalledPlatformAccessProtection } from '../../src/cli/platform-access-preflight.ts';
import { provisionPlatformAccess } from '../../src/cli/platform-access-provision.ts';
import type { PlatformAccessCheckpoint } from '../../src/cli/platform-access-provision.ts';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { platformAccessFixture } from '../fixtures/platform-access.ts';

const apiUrl = 'https://api.example.com';
const proxyUrl = 'https://proxy.example.com';
const manifest = createPlatformInstallationManifest({
  account: { id: 'account', name: 'Account' },
  createdAt: new Date(0).toISOString(),
  deployment: createPlatformDeploymentManifest({
    application: { baseDomain: 'example.com', zoneName: 'example.com' },
    displayName: 'Example',
    installationSlug: 'example',
  }),
  id: 'example-platform',
  ownershipNonce: '0123456789abcdef0123456789abcdef',
  platformVersion: '1.0.0',
});
async function fixture(options: { loseFirstCreate?: boolean } = {}) {
  const env = platformAccessFixture();
  let state: PlatformAccessCheckpoint = {
    version: 1,
    accountId: 'account',
    installationId: manifest.id,
    nonce: createHash('sha256')
      .update(`void-access:${manifest.ownershipNonce}`)
      .digest('hex')
      .slice(0, 32),
    resources: {},
  };
  const provisionInput = {
    accountId: 'account',
    installationId: manifest.id,
    apiUrl,
    proxyUrl,
    identityProviderIds: ['company-idp'],
    policyIds: ['employees'],
    protection: {},
  };
  const save = (value: PlatformAccessCheckpoint) => {
    state = structuredClone(value);
  };
  if (options.loseFirstCreate) {
    env.loseNextApplicationResponse();
    await expect(provisionPlatformAccess(env.client, provisionInput, state, save)).rejects.toThrow(
      'response lost',
    );
  }
  const result = await provisionPlatformAccess(env.client, provisionInput, state, save);
  env.calls.length = 0;
  const input = {
    client: {
      ...env.transport,
      listWorkerDomains: vi.fn(async () => []),
      listWorkerServiceRoutes: vi.fn(async () => []),
    },
    manifest,
    plan: { apiUrl, proxyUrl, actions: [] },
    protection: result.protection!,
    checkpoint: {
      accessProvisioningJson: JSON.stringify(state),
      accessSetupSpecJson: JSON.stringify({
        mode: 'create',
        identityProviderIds: ['company-idp'],
        policyIds: ['employees'],
      }),
      accessCredentialsJson: JSON.stringify(result.credentials),
    },
  };
  return { env, state, input };
}

describe('installed Access protection preflight', () => {
  it('refuses a newly configured dashboard outside the active protected-origin coverage', async () => {
    const { env, input } = await fixture();
    await expect(
      verifyInstalledPlatformAccessProtection({
        ...input,
        dashboardUrl: 'https://dash.example.org',
      }),
    ).rejects.toThrow('complete origin coverage');
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('checks current policies, audiences, coverage, and machine admission with reads only', async () => {
    const { env, input } = await fixture();
    await verifyInstalledPlatformAccessProtection(input);
    expect(env.calls.some((call) => call.path.endsWith('/policies'))).toBe(true);
    expect(env.calls.some((call) => call.path === 'service_tokens')).toBe(true);
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('checks alternate origins for normal update actions while skipping recreated Workers', async () => {
    const { env, input } = await fixture();
    const listWorkerDomains = vi.fn(async () => [
      {
        id: 'unprotected-domain',
        hostname: 'unprotected.example.net',
        service: manifest.deployment.resources.proxyWorker,
      },
    ]);
    const request = vi.fn(async (path: string, init?: RequestInit) =>
      path.includes('/workers/scripts/')
        ? { enabled: false, previews_enabled: false }
        : env.transport.request(path, init),
    );
    const workerRequest = request as unknown as PlatformCloudflareClient['request'];
    const client = { ...input.client, request: workerRequest, listWorkerDomains };
    await expect(
      verifyInstalledPlatformAccessProtection({
        ...input,
        client,
        plan: {
          ...input.plan,
          actions: [
            {
              action: 'update',
              id: manifest.deployment.resources.proxyWorker,
              key: 'proxy-worker',
              kind: 'worker',
              name: manifest.deployment.resources.proxyWorker,
              reason: 'Deploy the current platform version.',
            },
          ],
        },
      }),
    ).rejects.toThrow('additional Worker domain');
    expect(listWorkerDomains).toHaveBeenCalledOnce();

    listWorkerDomains.mockClear();
    await verifyInstalledPlatformAccessProtection({
      ...input,
      client: { ...input.client, request: workerRequest, listWorkerDomains },
      plan: {
        ...input.plan,
        actions: [
          {
            action: 'create',
            id: null,
            key: 'proxy-worker',
            kind: 'worker',
            name: manifest.deployment.resources.proxyWorker,
            reason: 'Recreate the Worker.',
          },
        ],
      },
    });
    expect(listWorkerDomains).not.toHaveBeenCalled();
  });
  it('does not read Access or Worker state for an unprotected installation', async () => {
    const { env, input } = await fixture();
    await verifyInstalledPlatformAccessProtection({ ...input, protection: null, checkpoint: {} });
    expect(env.calls).toHaveLength(0);
    expect(input.client.listWorkerDomains).not.toHaveBeenCalled();
  });
  it.each(['policy', 'audience', 'origin', 'idp', 'shadow', 'token', 'credentials', 'checkpoint'])(
    'fails closed on changed %s without provisioning',
    async (change) => {
      const { env, state, input } = await fixture();
      const app = env.apps.get(state.resources.protection!.id!)!;
      if (change === 'policy') {
        env.policy.include = [{ everyone: {} }];
      }
      if (change === 'audience') {
        app.aud = 'replaced-audience';
      }
      if (change === 'origin') {
        app.destinations = [];
      }
      if (change === 'idp') {
        app.allowed_idps = ['unreviewed-idp'];
      }
      if (change === 'shadow') {
        env.apps.set('shadow', {
          id: 'shadow',
          type: 'self_hosted',
          domain: 'api.example.com/admin',
        });
      }
      if (change === 'token') {
        env.tokens.get(state.resources['service-token']!.id!)!.expires_at = new Date(
          0,
        ).toISOString();
      }
      if (change === 'credentials') {
        input.checkpoint.accessCredentialsJson = '{}';
      }
      if (change === 'checkpoint') {
        input.checkpoint.accessProvisioningJson = '';
      }
      await expect(verifyInstalledPlatformAccessProtection(input)).rejects.toThrow(
        change === 'audience' ? 'active platform protection' : 'platform:',
      );
      expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
    },
  );
  it('reads a separately managed identity account without using the deployment account for Access', async () => {
    const { env, state, input } = await fixture();
    const requested: Array<string> = [];
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      requested.push(path);
      return env.transport.request(
        path.replace('/accounts/identity-account/', '/accounts/account/'),
        init,
      );
    };
    await verifyInstalledPlatformAccessProtection({
      ...input,
      client: { ...input.client, request },
      checkpoint: {
        ...input.checkpoint,
        accessProvisioningJson: JSON.stringify({ ...state, accountId: 'identity-account' }),
        accessSetupSpecJson: JSON.stringify({
          mode: 'existing',
          accountId: 'identity-account',
          protectionApplicationId: state.resources.protection!.id,
          identityProviderIds: ['company-idp'],
          policyIds: ['employees'],
        }),
      },
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((path) => path.startsWith('/accounts/identity-account/access/'))).toBe(
      true,
    );
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('accepts a protection application reconciled after its create response was lost', async () => {
    const { state, input } = await fixture({ loseFirstCreate: true });
    expect(state.resources.protection).toMatchObject({ pending: false });
    await verifyInstalledPlatformAccessProtection(input);
  });
});
