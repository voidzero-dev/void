import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformDiscoveryDocument,
  parsePlatformDiscoveryDocument,
} from '../../src/discovery.ts';
import {
  createPlatformInstallationManifest,
  parsePlatformInstallationManifest,
  setInstallationEndpoints,
} from '../../src/installation.ts';
import {
  createPlatformDeploymentManifest,
  normalizePlatformDashboardUrl,
  parsePlatformDeploymentManifest,
  platformDashboardUrl,
} from '../../src/manifest.ts';
import { deploymentInput, workerConfigs } from '../worker-config-fixture.ts';

function configs(dashboardUrl?: string) {
  return workerConfigs({
    deployment: createPlatformDeploymentManifest({
      ...deploymentInput,
      ...(dashboardUrl ? { controlPlane: { dashboardUrl } } : {}),
    }),
  });
}

describe('optional platform dashboard origin', () => {
  it.each([
    '',
    'not-a-url',
    'http://dash.example.com',
    'https://user:password@dash.example.com',
    'https://dash.example.com/account',
    'https://dash.example.com/../',
    'https://dash.example.com/%2e',
    'https://dash.example.com?return=evil',
    'https://dash.example.com?',
    'https://dash.example.com#fragment',
    'https://dash.example.com#',
    String.raw`https:\dash.example.com`,
    'https://dash.\nexample.com',
  ])('rejects an unsafe or non-origin configuration: %j', (url) => {
    expect(() => normalizePlatformDashboardUrl(url)).toThrow();
  });

  it('normalizes an HTTPS origin while preserving its explicit port', () => {
    expect(normalizePlatformDashboardUrl(' https://DASH.example.com:8443/ ')).toBe(
      'https://dash.example.com:8443',
    );
    expect(normalizePlatformDashboardUrl('https://dash.example.com:443')).toBe(
      'https://dash.example.com',
    );
  });

  it('adds no dashboard binding, Worker, or paid capability by default', () => {
    const deployment = createPlatformDeploymentManifest(deploymentInput);
    expect(platformDashboardUrl(deployment)).toBeNull();
    expect(deployment.controlPlane.dashboardHostname).toBeNull();
    expect(deployment.controlPlane).not.toHaveProperty('dashboardUrl');
    const without = configs();
    const withDashboard = configs('https://dash.example.com:8443');
    expect(without.api.vars).not.toHaveProperty('DASHBOARD_URL');
    expect(withDashboard.api.vars).toHaveProperty('DASHBOARD_URL', 'https://dash.example.com:8443');
    expect(Object.keys(withDashboard)).toEqual(Object.keys(without));
    expect(withDashboard.api.services).toEqual(without.api.services);
    expect(withDashboard.proxy.vars).not.toHaveProperty('DASHBOARD_URL');
    expect(withDashboard.api).not.toHaveProperty('send_email');
  });

  it('round-trips the complete origin in existing deployment and installation schemas', () => {
    const deployment = createPlatformDeploymentManifest({
      ...deploymentInput,
      controlPlane: { dashboardUrl: 'https://dash.example.com:8443/' },
    });
    expect(deployment.controlPlane.dashboardHostname).toBe('dash.example.com');
    expect(parsePlatformDeploymentManifest(JSON.parse(JSON.stringify(deployment)))).toEqual(
      deployment,
    );
    const createdAt = '2026-10-01T00:00:00.000Z';
    const manifest = setInstallationEndpoints(
      createPlatformInstallationManifest({
        account: { id: 'account', name: 'Account' },
        createdAt,
        deployment,
        id: 'installation',
        ownershipNonce: 'a'.repeat(43),
        platformVersion: '1.0.0',
      }),
      {
        apiUrl: 'https://api.example.com',
        proxyUrl: 'https://proxy.example.com',
        dashboardUrl: platformDashboardUrl(deployment),
      },
      createdAt,
    );
    expect(parsePlatformInstallationManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
    expect(manifest.endpoints.dashboardUrl).toBe('https://dash.example.com:8443');
  });

  it('advertises only an explicitly configured, validated dashboard in discovery', () => {
    const input = {
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      applicationDomain: 'apps.example.com',
      authenticationProviders: ['github'],
      capabilities: createPlatformDeploymentManifest(deploymentInput).capabilities,
      displayName: 'Example',
      installationId: 'installation',
      platformVersion: '1.0.0',
    };
    expect(createPlatformDiscoveryDocument(input)).not.toHaveProperty('dashboardUrl');
    const document = createPlatformDiscoveryDocument({
      ...input,
      dashboardUrl: 'https://dash.example.com:8443/',
    });
    expect(parsePlatformDiscoveryDocument(document).dashboardUrl).toBe(
      'https://dash.example.com:8443',
    );
    expect(() =>
      parsePlatformDiscoveryDocument({
        ...document,
        dashboardUrl: 'https://user:password@dash.example.com',
      }),
    ).toThrow('HTTPS origin');
  });

  it('retains a legacy dashboard hostname and refuses conflicting hostname metadata', () => {
    const deployment = createPlatformDeploymentManifest({
      ...deploymentInput,
      controlPlane: { dashboardHostname: 'dash.example.com' },
    });
    expect(platformDashboardUrl(parsePlatformDeploymentManifest(deployment))).toBe(
      'https://dash.example.com',
    );
    expect(() =>
      createPlatformDeploymentManifest({
        ...deploymentInput,
        controlPlane: {
          dashboardUrl: 'https://dash.example.com',
          dashboardHostname: 'other.example.com',
        },
      }),
    ).toThrow('must agree');
  });
});
