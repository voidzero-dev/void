import { createHmac } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  platformProtectionProofMessage,
} from '@void/platform';
import type { PlatformInstallationManifest } from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  runPlatformProtectionConfig,
  verifyProtectionWorkerOrigins,
} from '../../src/cli/platform-auth-protection.ts';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { parsePlatformConfigArgs } from '../../src/cli/platform-config-args.ts';

const state = vi.hoisted(() => ({
  currentLifecycleVersion: 'lifecycle-v1',
  databaseReleases: 0,
  events: [] as Array<string>,
  manifest: undefined as unknown,
  operatorRequest: vi.fn(),
  originVerificationRuns: 0,
  prepareAccess: vi.fn(),
  previewOpen: false,
  raceArmed: false,
  revision: 1,
}));

vi.mock('../../src/cli/cf-access.ts', () => ({
  ensurePlatformAccessToken: vi.fn(),
}));

vi.mock('../../src/cli/operator-auth.ts', () => ({
  readOperatorToken: vi.fn(() => 'operator-token'),
  resolveOperatorOrigin: vi.fn(() => 'https://api.example.com'),
}));

vi.mock('../../src/cli/operator-client.ts', () => ({
  OperatorClient: class {
    request(path: string, options?: Record<string, unknown>) {
      return state.operatorRequest(path, options ?? {});
    }
  },
}));

vi.mock('../../src/cli/platform-access-setup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-access-setup.ts')>();
  return {
    ...actual,
    checkpointPlatformAccessResources: (
      current: PlatformInstallationManifest,
      _encoded: string | undefined,
      updatedAt: string,
    ) => ({ ...current, updatedAt }),
    preparePlatformAccessSetup: (...args: Array<unknown>) => state.prepareAccess(...args),
  };
});

vi.mock('../../src/cli/platform-auth.ts', () => ({
  platformOperatorCredentialLabel: () => ({ role: 'management' }),
  resolvePlatformCloudflareCredential: vi.fn(async () => ({ token: 'cloudflare-token' })),
}));

vi.mock('../../src/cli/platform-cloudflare.ts', () => ({
  PlatformCloudflareClient: class {
    async request(path: string, init?: RequestInit) {
      state.events.push(`cloudflare:${init?.method ?? 'GET'}:${path}`);
      if (init?.method === 'POST') {
        state.previewOpen = false;
      }
      return { enabled: false, previews_enabled: state.previewOpen };
    }

    async listWorkerDomains() {
      state.originVerificationRuns += 1;
      state.events.push(`verify-origins:${state.originVerificationRuns}`);
      return [];
    }

    async listWorkerServiceRoutes(_accountId: string, worker: string) {
      const current = state.manifest as PlatformInstallationManifest;
      const isProxy = worker === current.deployment.resources.proxyWorker;
      if (state.raceArmed && state.originVerificationRuns === 2 && isProxy) {
        state.raceArmed = false;
        state.currentLifecycleVersion = 'lifecycle-v3-maintenance';
        state.previewOpen = true;
        state.events.push('maintenance-reopened-preview');
      }
      return [
        {
          pattern: `${isProxy ? 'proxy' : 'api'}.example.com/*`,
          zoneName: 'example.com',
        },
      ];
    }
  },
}));

vi.mock('../../src/cli/platform-installer.ts', () => ({
  acquirePlatformDatabaseLifecycleLock: vi.fn(async () => {
    const release = Object.assign(
      async () => {
        state.databaseReleases += 1;
        if (state.databaseReleases === 1) {
          state.currentLifecycleVersion = 'lifecycle-v2-checkpoint';
        }
        state.events.push('database-lock-released');
      },
      {
        authoritativeManifest: state.manifest,
        checkpoint: vi.fn(async () => {}),
      },
    );
    return release;
  }),
}));

vi.mock('../../src/cli/platform-lifecycle.ts', () => ({
  resolvePlatformInstallDatabaseUrl: vi.fn(() => 'postgres://database'),
}));

vi.mock('../../src/cli/platform-management.ts', () => ({
  selectAuthoritativePlatformManifest: (
    local: PlatformInstallationManifest,
    authoritative: PlatformInstallationManifest | null | undefined,
  ) => authoritative ?? local,
  verifyPlatformInstallationOwnership: vi.fn(async () => {}),
}));

vi.mock('../../src/cli/platform-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-registry.ts')>();
  return {
    ...actual,
    acquirePlatformLifecycleLock: vi.fn(() => () => state.events.push('local-lock-released')),
    promoteInstallationSecrets: vi.fn(),
    readInstallationRecoverySecrets: vi.fn(() => ({
      databaseUrl: 'postgres://database',
      jwtSecret: 'installation-recovery-secret',
    })),
    resolveInstallationManifest: vi.fn(() => state.manifest),
    writeInstallationManifest: vi.fn(),
    writePendingInstallationSecrets: vi.fn(),
  };
});

const manifest = createPlatformInstallationManifest({
  account: { id: 'account', name: 'Account' },
  createdAt: '2026-09-18T00:00:00.000Z',
  deployment: createPlatformDeploymentManifest({
    application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
    displayName: 'Example',
    installationSlug: 'example',
  }),
  id: 'example-a1b2c3d4',
  ownershipNonce: '0123456789abcdef0123456789abcdef',
  platformVersion: '1.0.0',
});
const origins = ['https://api.example.com', 'https://proxy.example.com'];
const protection = {
  teamDomain: 'https://company.cloudflareaccess.com',
  applications: origins.map((origin) => ({ origin, audience: 'company-audience' })),
};

beforeEach(() => {
  vi.clearAllMocks();
  state.currentLifecycleVersion = 'lifecycle-v1';
  state.databaseReleases = 0;
  state.events.length = 0;
  state.manifest = {
    ...manifest,
    endpoints: {
      apiUrl: origins[0],
      dashboardUrl: 'https://dashboard.example.com',
      proxyUrl: origins[1],
    },
    status: 'installed',
  } satisfies PlatformInstallationManifest;
  state.originVerificationRuns = 0;
  state.previewOpen = false;
  state.raceArmed = false;
  state.revision = 1;
  state.prepareAccess.mockReset().mockImplementation(async (input) => {
    input.save({ accessProvisioningJson: '{"version":1}' });
    process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
      [origins[0]!]: {
        CF_ACCESS_CLIENT_ID: 'machine-client',
        CF_ACCESS_CLIENT_SECRET: 'machine-secret',
      },
    });
    return { protection };
  });
  state.operatorRequest.mockReset().mockImplementation(async (path, options) => {
    if (path !== '/config/auth/protection') {
      throw new Error(`Unexpected operator path ${path}`);
    }
    if (options.method !== 'POST') {
      state.events.push(`context:${state.currentLifecycleVersion}`);
      return {
        installationId: manifest.id,
        lifecycleVersion: state.currentLifecycleVersion,
        origins,
        protection: null,
        revision: state.revision,
        sessionId: 'human-session',
        userId: 'human-user',
      };
    }
    const body = options.body as Record<string, unknown>;
    state.events.push(
      `post:${String(body.lifecycleVersion)}:${body.dryRun === true ? 'dry-run' : 'apply'}`,
    );
    const expectedSignature = createHmac('sha256', 'installation-recovery-secret')
      .update(
        platformProtectionProofMessage({
          installationId: manifest.id,
          origin: origins[0]!,
          userId: 'human-user',
          sessionId: 'human-session',
          revision: body.revision as number,
          lifecycleVersion: body.lifecycleVersion as string,
          protection,
          expiresAt: body.expiresAt as string,
        }),
      )
      .digest('base64url');
    expect(body.signature).toBe(expectedSignature);
    if (body.revision !== state.revision) {
      throw new Error('revision_conflict: authentication settings changed');
    }
    if (body.lifecycleVersion !== state.currentLifecycleVersion) {
      throw new Error('revision_conflict: installation lifecycle changed');
    }
    if (body.dryRun === true) {
      return { dryRun: true, revision: state.revision + 1 };
    }
    state.revision += 1;
    return { revision: state.revision };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function client(
  options: {
    preview?: boolean;
    workersDev?: boolean;
    extraDomain?: boolean;
    wildcard?: boolean;
  } = {},
) {
  const states = new Map<string, { enabled: boolean; previews_enabled: boolean }>();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      states.set(path, JSON.parse(init.body as string));
    }
    return (
      states.get(path) ?? {
        enabled: options.workersDev ?? false,
        previews_enabled: options.preview ?? false,
      }
    );
  });
  return {
    request: request as unknown as PlatformCloudflareClient['request'],
    listWorkerDomains: vi.fn(async () =>
      options.extraDomain
        ? [
            {
              id: 'extra',
              hostname: 'unprotected.example.com',
              service: manifest.deployment.resources.apiWorker,
            },
          ]
        : [],
    ),
    listWorkerServiceRoutes: vi.fn(async () => [
      {
        pattern: options.wildcard ? '*.example.com/*' : 'api.example.com/*',
        zoneName: 'example.com',
      },
    ]),
    calls: request,
  };
}
describe('platform protection configuration', () => {
  it('captures lifecycle state before final origin verification and requires a fresh retry after maintenance', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const humanCredentials = JSON.stringify({
      [origins[0]!]: { CF_ACCESS_TOKEN: 'human-access-token' },
    });
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', humanCredentials);
    state.raceArmed = true;
    const args = parsePlatformConfigArgs([
      'auth',
      'protection',
      'enable',
      '--installation',
      manifest.id,
      '--yes',
    ]);

    await expect(runPlatformProtectionConfig(args)).rejects.toThrow(
      'revision_conflict: installation lifecycle changed',
    );

    const captured = state.events.indexOf('context:lifecycle-v2-checkpoint');
    const finalVerification = state.events.indexOf('verify-origins:2');
    const maintenance = state.events.indexOf('maintenance-reopened-preview');
    const rejectedProof = state.events.indexOf('post:lifecycle-v2-checkpoint:dry-run');
    expect(captured).toBeGreaterThan(-1);
    expect(captured).toBeLessThan(finalVerification);
    expect(finalVerification).toBeLessThan(maintenance);
    expect(maintenance).toBeLessThan(rejectedProof);
    expect(state.originVerificationRuns).toBe(2);
    expect(state.previewOpen).toBe(true);
    expect(process.env.VOID_ACCESS_CREDENTIALS).toBe(humanCredentials);

    await expect(runPlatformProtectionConfig(args)).resolves.toBeUndefined();

    expect(state.originVerificationRuns).toBe(4);
    expect(state.events).toContain('post:lifecycle-v3-maintenance:dry-run');
    expect(state.events).toContain('post:lifecycle-v3-maintenance:apply');
    expect(state.previewOpen).toBe(false);
    expect(process.env.VOID_ACCESS_CREDENTIALS).toBe(humanCredentials);
  });

  it('parses independent protection and owner recovery actions with no secret-bearing flags', () => {
    expect(
      parsePlatformConfigArgs([
        'auth',
        'protection',
        'enable',
        '--installation',
        'example',
        '--file',
        'access.json',
        '--yes',
      ]),
    ).toMatchObject({
      action: 'protection',
      target: 'enable',
      installation: 'example',
      file: 'access.json',
      yes: true,
    });
    expect(
      parsePlatformConfigArgs([
        'auth',
        'recover',
        'company',
        '--installation',
        'example',
        '--file',
        'recovery.json',
        '--client-secret-env',
        'OIDC_SECRET',
      ]),
    ).toMatchObject({ action: 'recover', target: 'company', installation: 'example' });
    expect(() => parsePlatformConfigArgs(['auth', 'protection', 'github'])).toThrow();
    expect(() => parsePlatformConfigArgs(['auth', 'list', '--installation', 'example'])).toThrow();
    expect(() =>
      parsePlatformConfigArgs(['auth', 'protection', 'enable', '--client-secret', 'plaintext']),
    ).toThrow();
  });
  it('rejects uncovered alternate and wildcard origins before performing any change', async () => {
    for (const options of [{ extraDomain: true }, { wildcard: true }]) {
      const fixture = client({ preview: true, ...options });
      await expect(verifyProtectionWorkerOrigins(fixture, manifest, origins, true)).rejects.toThrow(
        /additional|wildcard/,
      );
      expect(fixture.calls.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    }
  });
  it('disables unprotected workers.dev and previews then verifies the resulting configuration', async () => {
    const fixture = client({ preview: true, workersDev: true });
    await verifyProtectionWorkerOrigins(fixture, manifest, origins, true);
    const changes = fixture.calls.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(changes).toHaveLength(2);
    expect(changes.map(([, init]) => JSON.parse(init!.body as string))).toEqual([
      { enabled: false, previews_enabled: false },
      { enabled: false, previews_enabled: false },
    ]);
  });
  it('preserves explicitly protected workers.dev main origins while disabling preview URLs', async () => {
    const fixture = client({ preview: true, workersDev: true });
    fixture.listWorkerServiceRoutes.mockResolvedValue([]);
    const protectedOrigins = [
      manifest.deployment.resources.apiWorker,
      manifest.deployment.resources.proxyWorker,
    ].map((worker) => `https://${worker}.account.workers.dev`);
    await verifyProtectionWorkerOrigins(fixture, manifest, protectedOrigins, true);
    expect(
      fixture.calls.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => JSON.parse(init!.body as string)),
    ).toEqual([
      { enabled: true, previews_enabled: false },
      { enabled: true, previews_enabled: false },
    ]);
  });
  it('fails closed on unverifiable or concurrently reenabled previews', async () => {
    const fixture = client();
    fixture.calls.mockImplementation(async () => ({ enabled: true, previews_enabled: true }));
    await expect(verifyProtectionWorkerOrigins(fixture, manifest, origins, true)).rejects.toThrow(
      'changed',
    );
    fixture.calls.mockImplementation(async () => ({ enabled: false }) as never);
    await expect(verifyProtectionWorkerOrigins(fixture, manifest, origins, false)).rejects.toThrow(
      'Cannot verify',
    );
  });
});
