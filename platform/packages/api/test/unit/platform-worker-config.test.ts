import {
  createPlatformDeploymentManifest,
  createPlatformWorkerConfigs,
  serializePlatformCapabilities,
} from '@void/platform';
import { describe, expect, it } from 'vite-plus/test';

describe('platform Worker configuration', () => {
  it('keeps the core installation free of containers and managed-build bindings', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://void-example-api.example.workers.dev',
      deployment,
      healthProbeToken: 'probe-token',
      installationId: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
      proxyUrl: 'https://void-example-proxy.example.workers.dev',
      emailGatewayUrl: 'https://void-example-email-gateway.example.workers.dev',
      resources: {
        hyperdrive: 'hyperdrive',
        isrCacheKv: 'isr',
        legacyAssetsKv: 'assets',
        routingKv: 'routing',
        zone: 'zone',
      },
      runtimeEntrypoints: {
        api: '/runtime/api.js',
        dispatch: '/runtime/dispatch.js',
        proxy: '/runtime/proxy.js',
        emailGateway: '/runtime/email-gateway.js',
        tail: '/runtime/tail.js',
      },
    });

    expect(configs.api).not.toHaveProperty('containers');
    expect(configs.api).not.toHaveProperty('send_email');
    expect(configs.emailGateway).not.toHaveProperty('send_email');
    expect(configs.emailGateway.vars).not.toHaveProperty('EMAIL_SHARED_ZONE_ID');
    expect(JSON.stringify(configs)).not.toContain('BuildManager');
    expect(JSON.stringify(configs)).not.toContain('BUILD_SCHEDULER');
    expect(configs.proxy.vars).toMatchObject({
      AI_GATEWAY_ID: deployment.resources.aiGateway,
      PLATFORM_CAPABILITIES: serializePlatformCapabilities(deployment.capabilities),
      PLATFORM_INSTALLATION_ID: 'example-a1b2c3d4',
    });
    expect(configs.tail.vars).toMatchObject({
      PLATFORM_DISPATCH_WORKER_NAME: deployment.resources.dispatchWorker,
    });
    for (const config of Object.values(configs)) {
      expect(
        JSON.parse(String((config.vars as Record<string, unknown>).PLATFORM_OWNERSHIP_MARKER)),
      ).toMatchObject({
        accountId: 'account',
        installationId: 'example-a1b2c3d4',
        ownershipNonce: '0123456789abcdef0123456789abcdef',
        resourceKind: 'worker',
      });
    }
    expect(configs.api.vars).toMatchObject({
      PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
      LOGS_DATASET: deployment.resources.logsDataset,
      REQUESTS_DATASET: deployment.resources.requestsDataset,
    });
    expect(configs.dispatch.routes).toEqual([
      { pattern: '*.apps.example.com/*', zone_name: 'example.com' },
      { pattern: '*.apps.example.com', zone_name: 'example.com' },
    ]);
    expect(configs.dispatch.vars).toMatchObject({
      PLATFORM_HEALTH_PROBE_TOKEN: 'probe-token',
      PLATFORM_INSTALLATION_ID: 'example-a1b2c3d4',
    });
  });

  it('can deploy an upgrade without exposing a disabled installation', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      controlPlane: { apiHostname: 'api.example.com', proxyHostname: 'proxy.example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    const configs = createPlatformWorkerConfigs({
      accountId: 'account',
      apiUrl: 'https://api.example.com',
      deployment,
      healthProbeToken: 'probe-token',
      installationId: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
      proxyUrl: 'https://proxy.example.com',
      emailGatewayUrl: 'https://void-example-email-gateway.example.workers.dev',
      publicEndpoints: false,
      trafficState: 'staging',
      resources: {
        hyperdrive: 'hyperdrive',
        isrCacheKv: 'isr',
        legacyAssetsKv: 'assets',
        routingKv: 'routing',
        zone: 'zone',
      },
      runtimeEntrypoints: {
        api: '/runtime/api.js',
        dispatch: '/runtime/dispatch.js',
        proxy: '/runtime/proxy.js',
        emailGateway: '/runtime/email-gateway.js',
        tail: '/runtime/tail.js',
      },
    });

    for (const config of Object.values(configs)) {
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
    }
    expect(configs.api.vars).toMatchObject({ PLATFORM_TRAFFIC_STATE: 'staging' });
    expect(configs.proxy.vars).toMatchObject({ PLATFORM_TRAFFIC_STATE: 'staging' });
    expect(configs.dispatch.vars).toMatchObject({ PLATFORM_TRAFFIC_STATE: 'staging' });
    expect(configs.api).not.toHaveProperty('routes');
    expect(configs.proxy).not.toHaveProperty('routes');
    expect(configs.dispatch).not.toHaveProperty('routes');
  });
});
