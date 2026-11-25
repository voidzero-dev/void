import { describe, expect, it } from 'vite-plus/test';
import {
  createPlatformDeploymentManifest,
  parsePlatformDeploymentManifest,
} from '../../src/manifest.ts';

describe('configurable authentication deployment manifests', () => {
  it.each(['google', 'oidc', 'cloudflare-access'] as const)(
    'round-trips %s without enabling GitHub',
    (kind) => {
      const manifest = createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Team',
        installationSlug: 'team',
        authentication: { providers: [kind], configurable: true },
        capabilities: { githubOAuth: false, googleOAuth: kind === 'google' },
      });
      expect(manifest.schemaVersion).toBe(3);
      expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
    },
  );
  it('supports workers.dev with independently selected Access protection', () => {
    const manifest = createPlatformDeploymentManifest({
      application: {
        baseDomain: 'team.workers.dev',
        zoneName: '',
        workersDev: { subdomain: 'team', installationId: 'team-12345678' },
      },
      displayName: 'Team',
      installationSlug: 'team',
      authentication: { providers: ['github'], accessProtection: true },
    });
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.authentication.configurable).toBe(true);
    expect(parsePlatformDeploymentManifest(manifest)).toEqual(manifest);
  });
  it('keeps legacy manifests unchanged and rejects stripping the new contract into an old version', () => {
    const legacy = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Team',
      installationSlug: 'team',
    });
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.authentication).toEqual({ providers: ['github'] });
    expect(() =>
      parsePlatformDeploymentManifest({
        ...legacy,
        authentication: { ...legacy.authentication, configurable: true },
      }),
    ).toThrow('schema version 3');
  });
});

describe('security audits deployment manifests', () => {
  const input = {
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Team',
    installationSlug: 'team',
  };
  const roundTrip = (manifest: unknown) =>
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise the JSON representation read by the parser.
    parsePlatformDeploymentManifest(JSON.parse(JSON.stringify(manifest)));

  it('reads a missing capability as off and needs schema version 7 to turn it on', () => {
    const off = createPlatformDeploymentManifest(input);
    expect(off.schemaVersion).toBe(1);
    const { securityAudits: _, ...olderCapabilities } = off.capabilities;
    expect(roundTrip({ ...off, capabilities: olderCapabilities })).toEqual(off);

    const on = createPlatformDeploymentManifest({
      ...input,
      capabilities: { securityAudits: true },
    });
    expect(on.schemaVersion).toBe(7);
    expect(roundTrip(on)).toEqual(on);
    expect(() => roundTrip({ ...on, schemaVersion: 1 })).toThrow('schema version 7');
    expect(() => roundTrip({ ...off, schemaVersion: 7 })).toThrow('schema version 7');
  });
});
