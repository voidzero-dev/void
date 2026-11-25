import { describe, expect, it } from 'vite-plus/test';
import {
  parsePlatformApplication,
  platformProjectHostname,
  platformProjectHostnames,
  platformProjectIngressName,
} from '../../src/application.ts';
import {
  createPlatformDiscoveryDocument,
  parsePlatformDiscoveryDocument,
} from '../../src/discovery.ts';
import {
  createApplicationRoutes,
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';

const project = { id: 'proj_123456abcdef', slug: 'kitchen-sink' };
const workersDev = { subdomain: 'my-account', installationId: 'team-123456abcdef' };
const application = {
  baseDomain: 'my-account.workers.dev',
  zoneName: '',
  dedicatedZone: false,
  workersDev,
};

describe('platform application addressing', () => {
  it('validates the dedicated-zone flag on standalone application settings', () => {
    expect(parsePlatformApplication(application)).toEqual(application);
    expect(parsePlatformApplication({ ...application, dedicatedZone: null })).toEqual(application);
    expect(() => parsePlatformApplication({ ...application, dedicatedZone: 'false' })).toThrow(
      'dedicatedZone must be a boolean',
    );
  });

  it('version-gates discovery and verifies its application identity', () => {
    const manifest = createPlatformDeploymentManifest({
      installationSlug: 'team',
      displayName: 'Team',
      application,
    });
    const document = createPlatformDiscoveryDocument({
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      applicationDomain: application.baseDomain,
      applicationRouting: application,
      installationId: workersDev.installationId,
      displayName: 'Team',
      platformVersion: '1.0.0',
      authenticationProviders: ['github'],
      capabilities: manifest.capabilities,
    });
    expect(document.schemaVersion).toBe(2);
    expect(parsePlatformDiscoveryDocument(document)).toEqual(document);
    expect(() => parsePlatformDiscoveryDocument({ ...document, installationId: 'other' })).toThrow(
      'installation identity',
    );
    expect(() => parsePlatformDiscoveryDocument({ ...document, schemaVersion: 1 })).toThrow(
      'schema version 2',
    );
  });
  it('preserves existing domain manifests and routes', () => {
    const manifest = createPlatformDeploymentManifest({
      installationSlug: 'team',
      displayName: 'Team',
      application: { baseDomain: 'example.com', zoneName: 'example.com' },
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(platformProjectHostname(project, manifest.application)).toBe('kitchen-sink.example.com');
    expect(createApplicationRoutes(manifest.application)).toHaveLength(2);
    expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
  });
  it('uses a distinct stable Worker origin per project without zone routes', () => {
    const manifest = createPlatformDeploymentManifest({
      installationSlug: 'team',
      displayName: 'Team',
      application,
    });
    expect(manifest.schemaVersion).toBe(2);
    expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
    expect(createApplicationRoutes(application)).toEqual([]);
    expect(platformProjectHostname(project, application)).toBe(
      'void-123456abcdef-kitchen-sink-123456abcdef.my-account.workers.dev',
    );
    expect(
      platformProjectIngressName({ ...project, slug: 'a'.repeat(63) }, workersDev).length,
    ).toBeLessThanOrEqual(63);
    expect(platformProjectHostname({ ...project, id: 'proj_other123456' }, application)).not.toBe(
      platformProjectHostname(project, application),
    );
  });
  it('keeps the original origin when a domain becomes canonical', () => {
    const attached = { ...application, zoneName: 'example.com', baseDomain: 'example.com' };
    expect(platformProjectHostnames(project, attached)).toEqual([
      'kitchen-sink.example.com',
      platformProjectHostname(project, application),
    ]);
    expect(createApplicationRoutes(attached)).toHaveLength(2);
  });
  it('rejects disguised legacy manifests and invalid workers.dev configuration', () => {
    expect(() =>
      createPlatformDeploymentManifest({
        installationSlug: 'team',
        displayName: 'Team',
        application: { ...application, baseDomain: 'other.workers.dev' },
      }),
    ).toThrow('account subdomain');
    const manifest = createPlatformDeploymentManifest({
      installationSlug: 'team',
      displayName: 'Team',
      application,
    });
    expect(() => parsePlatformDeploymentManifest({ ...manifest, schemaVersion: 1 })).toThrow(
      'schema version 2',
    );
    expect(() => createApplicationRoutes({ ...application, dedicatedZone: true })).toThrow(
      'catch-all',
    );
  });
});
