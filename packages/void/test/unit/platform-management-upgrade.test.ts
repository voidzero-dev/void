import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { encodeCloudflareVersionMessage } from '@void/deploy-cloudflare';
import {
  createPlatformDeploymentManifest,
  parsePlatformAuthenticationSetup,
  createPlatformInstallationManifest,
  createPlatformResourceOwnershipMarker,
  PLATFORM_DISABLED_KEY,
  recordInstallationResource,
  recordInstallationStep,
  transitionInstallation,
  type PlatformInstallationManifest,
} from '@void/platform';
import { getPlatformRuntimeDirectory, resolvePlatformRuntime } from '@void/platform/installer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { printSuccess } from '../../src/cli/output.ts';

const state = vi.hoisted(() => ({
  cfRunner: vi.fn(),
  createSecrets: vi.fn(),
  getWorkerLastDeployedFrom: vi.fn(),
  clientTokens: [] as Array<string>,
  listAccounts: vi.fn(),
  listWorkerNames: vi.fn(),
  request: vi.fn(),
  requiredGatewayToken: '',
  events: [] as Array<string>,
  manifest: undefined as PlatformInstallationManifest | undefined,
  prepareDatabase: vi.fn(),
  readAdministratorSetup: vi.fn(),
  readAuthenticationState: vi.fn(),
  readPlanZeroTrust: vi.fn(),
  readProjectZeroTrust: vi.fn(),
  releaseDatabase: vi.fn(),
  spinner: vi.fn(),
  progress: {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  },
  runtime: undefined as ReturnType<typeof resolvePlatformRuntime> | undefined,
  wait: vi.fn(),
}));

// Do not wait before a read is done again.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: state.wait,
}));

vi.mock('../../src/cli/output.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/output.ts')>()),
  createSpinner: state.spinner,
  printSuccess: vi.fn(),
}));

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  confirm: vi.fn(),
  isCancel: () => false,
  log: { info: vi.fn(), step: vi.fn(), success: vi.fn(), warn: vi.fn() },
  note: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
}));

vi.mock('../../src/cli/platform-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-auth.ts')>()),
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
}));

vi.mock('../../src/cli/platform-cloudflare.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-cloudflare.ts')>();
  return {
    ...actual,
    PlatformCloudflareClient: class {
      constructor(private readonly token: string) {
        state.clientTokens.push(token);
      }
      listAccounts = state.listAccounts;
      listWorkerNames = state.listWorkerNames;
      request = state.request;
      getWorkerLastDeployedFrom = state.getWorkerLastDeployedFrom;
      async getKvValue() {
        return JSON.stringify(state.manifest);
      }

      async listAiGateways() {
        if (state.requiredGatewayToken && this.token !== state.requiredGatewayToken) {
          throw new actual.PlatformCloudflareApiError(
            'Authentication error',
            403,
            '/accounts/account/ai-gateway/gateways',
          );
        }
        return [];
      }

      async listDispatchNamespaces() {
        return [];
      }

      async listHyperdriveConfigs() {
        return [];
      }

      async listKvNamespaces() {
        const routing = state.manifest?.resources.find((resource) => resource.key === 'routing-kv');
        return routing ? [{ id: routing.id, name: routing.name }] : [];
      }

      async listR2Buckets() {
        return [];
      }

      async putKvValue(_account: string, _namespace: string, key: string) {
        state.events.push(`put:${key}`);
      }
    },
  };
});

vi.mock('../../src/cli/platform-installer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-installer.ts')>();
  return {
    ...actual,
    acquirePlatformDatabaseLifecycleLock: vi.fn(async () => {
      const release = Object.assign(
        async () => {
          await state.releaseDatabase();
          state.events.push('outer-release');
        },
        {
          authoritativeManifest: state.manifest,
          checkpoint: vi.fn(),
          prepareDatabase: state.prepareDatabase,
          readAdministratorSetup: state.readAdministratorSetup,
          readAuthenticationState: state.readAuthenticationState,
          readProjectZeroTrust: state.readProjectZeroTrust,
        },
      );
      return release;
    }),
    createPlatformInstallationSecrets: state.createSecrets,
    installPlatform: vi.fn(async (...args: Parameters<typeof actual.installPlatform>) => {
      expect(state.progress.start).toHaveBeenCalled();
      expect(state.progress.stop).not.toHaveBeenCalled();
      const existing = args[2];
      const dependencies = args[3];
      const borrowed = await dependencies.acquireDatabaseLifecycleLock(
        'postgres://database',
        existing!.id,
        existing!.ownershipNonce,
      );
      expect(borrowed.prepareDatabase).toBe(state.prepareDatabase);
      expect(borrowed.readAuthenticationState).toBe(state.readAuthenticationState);
      await borrowed.readAuthenticationState!();
      state.events.push('installer-start');
      dependencies.onProgress?.('Deploying the api service');
      await borrowed.prepareDatabase!(
        state.runtime!.directory,
        state.runtime!.manifest.database,
        existing!.platformVersion,
        false,
      );
      state.events.push('installer-finish');
      dependencies.onProgress?.('Verifying the enabled platform');
      await borrowed();
      return {
        manifest: existing!,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
      };
    }),
    loadPlatformRuntime: vi.fn(() => state.runtime),
    readPlatformProjectZeroTrustState: state.readPlanZeroTrust,
    resolveBootstrapGitHubId: vi.fn(),
  };
});

vi.mock('../../src/cli/platform-installer-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/platform-installer-process.ts')>()),
  runPlatformWranglerAtApiBase: state.cfRunner,
}));

vi.mock('../../src/cli/platform-lifecycle.ts', () => ({
  assertNoninteractivePlatformMutationAcknowledged: vi.fn(),
  resolvePlatformInstallDatabaseUrl: () => 'postgres://database',
}));

vi.mock('../../src/cli/platform-plan.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-plan.ts')>();
  return {
    ...actual,
    createPlatformInstallPlan: vi.fn(async () => ({
      account: state.manifest!.account,
      actions: [
        {
          action: 'reuse',
          id: 'routing-kv-id',
          key: 'routing-kv',
          kind: 'kv-namespace',
          name: 'routing-kv',
          reason: 'already installed',
        },
      ],
      apiUrl: 'https://api.example.com',
      deployment: state.manifest!.deployment,
      installationId: state.manifest!.id,
      proxyUrl: 'https://proxy.example.com',
      workersSubdomain: 'workers.dev',
      zone: null,
    })),
    formatPlatformInstallPlan: vi.fn(() => 'upgrade plan'),
    revalidatePlatformInstallAction: vi.fn(),
  };
});

vi.mock('../../src/cli/platform-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/platform-registry.ts')>();
  return {
    ...actual,
    acquirePlatformLifecycleLock: vi.fn(() => () => state.events.push('local-release')),
    listInstallationManifests: vi.fn(() => [state.manifest]),
    readInstallationRecoverySecrets: vi.fn(() => ({ databaseUrl: 'postgres://database' })),
    readPendingInstallationSecrets: vi.fn(),
    resolveInstallationManifest: vi.fn(() => state.manifest),
    writeInstallationManifest: vi.fn(),
    writePendingInstallationSecrets: vi.fn(),
  };
});

import { confirm, log, note } from '@voidzero-dev/vite-plus-prompts';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import { authenticationSetupRequestHash } from '../../src/cli/platform-install-auth.ts';
import { recordWorkerCutoverStage } from '../../src/cli/platform-installer-cutover.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  installPlatform,
} from '../../src/cli/platform-installer.ts';
import {
  platformLifecycleResumeCommand,
  runInstalledPlatformCommand,
} from '../../src/cli/platform-management.ts';
import { createPlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  readInstallationRecoverySecrets,
  readPendingInstallationSecrets,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from '../../src/cli/platform-registry.ts';

const upgrade = (overrides: { plan?: boolean; yes?: boolean } = {}) =>
  runInstalledPlatformCommand({
    subcommand: 'upgrade',
    selector: state.manifest!.id,
    plan: false,
    runtime: '',
    yes: true,
    ...overrides,
  });

describe('installed platform upgrade', () => {
  it('prints an exact rollback resume command with quoted custom runtime paths', () => {
    expect(
      platformLifecycleResumeCommand(
        {
          subcommand: 'rollback',
          selector: '',
          plan: false,
          yes: true,
          runtime: '/tmp/earlier runtime',
          fromRuntime: "/tmp/current's runtime",
        },
        'installation',
      ),
    ).toBe(
      "void platform rollback installation --runtime '/tmp/earlier runtime' --from-runtime '/tmp/current'\\''s runtime' --yes",
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'token');
    vi.stubEnv('CF_API_TOKEN', '');
    state.clientTokens.length = 0;
    state.requiredGatewayToken = '';
    state.listAccounts.mockReset().mockResolvedValue([{ id: 'account', name: 'Account' }]);
    state.listWorkerNames.mockReset().mockResolvedValue([]);
    state.request.mockReset().mockResolvedValue({ name: 'assets' });
    state.getWorkerLastDeployedFrom.mockReset().mockResolvedValue('cf_cli');
    state.wait.mockReset().mockResolvedValue(undefined);
    state.cfRunner.mockReset();
    vi.mocked(readInstallationRecoverySecrets).mockReturnValue({
      databaseUrl: 'postgres://database',
    });
    state.spinner.mockReturnValue(state.progress);
    state.releaseDatabase.mockReset().mockResolvedValue(undefined);
    state.createSecrets.mockReset().mockReturnValue({});
    state.events.length = 0;
    state.prepareDatabase.mockReset().mockImplementation(async (_directory, database) => {
      state.events.push(`prepare:${database.schemaDigest}`);
      return {
        appliedMigrations: 1,
        previousSchemaDigest: 'old-schema',
        schemaDigest: database.schemaDigest,
      };
    });
    state.readAuthenticationState.mockReset().mockResolvedValue(null);
    state.runtime = resolvePlatformRuntime(getPlatformRuntimeDirectory());
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      displayName: 'Example',
      installationSlug: 'example',
    });
    let manifest = createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: '2026-09-14T00:00:00.000Z',
      deployment,
      id: 'example-a1b2c3d4',
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    manifest = recordInstallationResource(
      manifest,
      {
        configHash: 'hash',
        id: 'routing-kv-id',
        key: 'routing-kv',
        kind: 'kv-namespace',
        name: 'routing-kv',
        ownership: 'created',
        state: 'ready',
      },
      '2026-09-14T00:00:01.000Z',
    );
    manifest = recordInstallationStep(
      manifest,
      {
        completedAt: '2026-09-14T00:00:01.000Z',
        key: 'database-schema:old-schema',
        resultHash: 'old-schema',
      },
      '2026-09-14T00:00:01.000Z',
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
    state.manifest = manifest;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION;
    delete process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON;
  });

  it.each([false, true])(
    'plans an upgrade with management authority instead of its runtime token (environment override: %s)',
    async (override) => {
      vi.stubEnv('CLOUDFLARE_API_TOKEN', override ? 'explicit-manager' : '');
      state.requiredGatewayToken = override ? 'explicit-manager' : 'saved-manager';
      vi.mocked(readInstallationRecoverySecrets).mockReturnValue({
        databaseUrl: 'postgres://database',
        managementApiToken: 'saved-manager',
        cloudflareApiToken: 'runtime-without-ai-gateway',
      });
      const original = vi.mocked(createPlatformInstallPlan).getMockImplementation()!;
      vi.mocked(createPlatformInstallPlan).mockImplementationOnce(async (...args) => {
        await args[0].listAiGateways(args[1].accountId);
        return original(...args);
      });
      await upgrade();
      expect(state.clientTokens).toEqual([state.requiredGatewayToken]);
      expect(installPlatform).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ operatorApiToken: state.requiredGatewayToken }),
      );
      expect(state.events).toContain('installer-finish');
      expect(state.createSecrets).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpoint: expect.objectContaining({ managementApiToken: 'saved-manager' }),
        }),
      );
    },
  );

  it.each(['account', 'workers', 'r2'] as const)(
    'rejects denied %s access before taking locks or changing installation state',
    async (resource) => {
      state.manifest = recordInstallationResource(
        state.manifest!,
        {
          configHash: 'hash',
          id: 'assets',
          key: 'assets-r2',
          kind: 'r2-bucket',
          name: 'assets',
          ownership: 'created',
          state: 'ready',
        },
        '2026-09-14T00:00:03.000Z',
      );
      const check =
        resource === 'account'
          ? state.listAccounts
          : resource === 'workers'
            ? state.listWorkerNames
            : state.request;
      check.mockRejectedValueOnce(new PlatformCloudflareApiError('Authentication error', 403));
      await expect(upgrade()).rejects.toThrow('HTTP 403');
      expect(acquirePlatformLifecycleLock).not.toHaveBeenCalled();
      expect(acquirePlatformDatabaseLifecycleLock).not.toHaveBeenCalled();
      expect(writeInstallationManifest).not.toHaveBeenCalled();
      expect(createPlatformInstallPlan).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
      expect(state.progress.start).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalled();
    },
  );

  it('includes shared email configuration when planning an upgrade', async () => {
    vi.stubEnv('VOID_EMAIL_SHARED_ZONE_ID', 'mail-zone');
    vi.stubEnv('VOID_EMAIL_SENDER_DOMAIN', 'mail.example.com');
    await upgrade({ plan: true });
    expect(createPlatformInstallPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        emailSharedZoneId: 'mail-zone',
        emailSenderDomain: 'mail.example.com',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each(['upgrade', 'repair'] as const)(
    'passes an explicitly configured dashboard origin through %s planning',
    async (subcommand) => {
      await runInstalledPlatformCommand({
        subcommand,
        selector: state.manifest!.id,
        plan: true,
        runtime: '',
        yes: true,
        dashboardUrl: 'https://dash.example.org:8443',
      });
      expect(createPlatformInstallPlan).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dashboardUrl: 'https://dash.example.org:8443' }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it('borrows database preparation from the held lifecycle lock', async () => {
    await upgrade();

    expect(state.events).toEqual([
      'installer-start',
      `prepare:${state.runtime!.manifest.database.schemaDigest}`,
      'installer-finish',
      'outer-release',
      'local-release',
    ]);
    expect(state.progress.start).toHaveBeenCalledWith('Upgrading the platform');
    expect(state.progress.message).toHaveBeenCalledWith('Deploying the api service');
    expect(state.progress.message).toHaveBeenCalledWith('Verifying the enabled platform');
    expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith('Platform upgrade complete.');
    expect(state.progress.error).not.toHaveBeenCalled();
    expect(state.progress.stop.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(printSuccess).mock.invocationCallOrder[0]!,
    );
  });

  it('forwards an explicitly restored complete project-secret keyring during repair', async () => {
    const keysJson = JSON.stringify({
      v1: Buffer.alloc(32, 1).toString('base64'),
      v2: Buffer.alloc(32, 2).toString('base64'),
    });
    process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION = 'v2';
    process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON = keysJson;

    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest!.id,
      subcommand: 'repair',
      yes: true,
    });

    expect(state.createSecrets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectSecretActiveKeyVersion: 'v2',
        projectSecretKeysJson: keysJson,
      }),
    );
    expect(state.progress.start).toHaveBeenCalledWith('Repairing the platform');
  });

  it('forwards the dedicated email key and recorded capability during maintenance', async () => {
    const emailSigningSecret = 'restored-email-signing-secret-material';
    vi.stubEnv('VOID_PLATFORM_EMAIL_SIGNING_SECRET', emailSigningSecret);
    state.manifest = {
      ...state.manifest!,
      deployment: createPlatformDeploymentManifest({
        ...state.manifest!.deployment,
        capabilities: { ...state.manifest!.deployment.capabilities, email: true },
        emailSenderDomain: 'mail.example.com',
        emailSharedZoneId: 'mail-zone',
      }),
    };

    await runInstalledPlatformCommand({
      plan: false,
      runtime: '',
      selector: state.manifest.id,
      subcommand: 'repair',
      yes: true,
    });

    expect(state.createSecrets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emailEnabled: true,
        emailSigningSecret,
        existingEmailEnabled: true,
      }),
    );
  });

  it('releases the held lifecycle lock when database preparation fails', async () => {
    state.prepareDatabase.mockImplementationOnce(async () => {
      state.events.push('prepare:failed');
      throw new Error('migration failed');
    });

    await expect(upgrade()).rejects.toThrow('migration failed');

    expect(state.events).toEqual([
      'installer-start',
      'prepare:failed',
      'outer-release',
      'local-release',
    ]);
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`void platform upgrade ${state.manifest!.id} --yes`),
      'Recovery',
    );
    expect(state.progress.stop).not.toHaveBeenCalled();
  });

  it('does not start deployment progress for a plan-only run', async () => {
    await upgrade({ plan: true, yes: false });
    expect(state.spinner).not.toHaveBeenCalled();
    expect(installPlatform).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
  });

  it('does not claim deployment started when credential preparation fails', async () => {
    state.createSecrets.mockImplementationOnce(() => {
      throw new Error('invalid credentials');
    });
    await expect(upgrade()).rejects.toThrow('invalid credentials');
    expect(installPlatform).not.toHaveBeenCalled();
    expect(state.progress.start).not.toHaveBeenCalled();
    expect(state.progress.error).not.toHaveBeenCalled();
    expect(vi.mocked(note).mock.calls).not.toContainEqual([expect.anything(), 'Recovery']);
    expect(state.events).toEqual(['outer-release', 'local-release']);
  });

  it('keeps progress active through final database lock release', async () => {
    state.releaseDatabase.mockImplementationOnce(async () => {
      expect(state.progress.message).toHaveBeenLastCalledWith('Finalizing platform changes');
      expect(state.progress.stop).not.toHaveBeenCalled();
      expect(printSuccess).not.toHaveBeenCalled();
    });
    await upgrade();
    expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith('Platform upgrade complete.');
  });

  it('reports a finalization failure without claiming success and still releases the local lock', async () => {
    state.releaseDatabase.mockRejectedValueOnce(new Error('database release failed'));
    await expect(upgrade()).rejects.toThrow('database release failed');
    expect(state.progress.error).toHaveBeenCalledExactlyOnceWith('Platform upgrade failed.');
    expect(state.progress.stop).not.toHaveBeenCalled();
    expect(printSuccess).not.toHaveBeenCalled();
    expect(state.events.at(-1)).toBe('local-release');
  });

  it.each(['waitingForDns', 'waitingForSandboxDrain'] as const)(
    'stops progress before explaining a %s pause',
    async (reason) => {
      vi.mocked(installPlatform).mockResolvedValueOnce({
        manifest: state.manifest!,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
        [reason]: true,
      });
      await upgrade();
      expect(state.progress.stop).toHaveBeenCalledExactlyOnceWith(
        'Platform operation paused; progress is saved.',
      );
      expect(state.progress.error).not.toHaveBeenCalled();
      expect(printSuccess).not.toHaveBeenCalled();
      expect(state.progress.stop.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(note).mock.invocationCallOrder.at(-1)!,
      );
      expect(state.events).toEqual(['outer-release', 'local-release']);
    },
  );

  it('forwards spinner cancellation to coordinated CLI shutdown', async () => {
    await upgrade();
    const onCancel = state.spinner.mock.calls[0]![0].onCancel;
    const emit = vi.spyOn(process, 'emit').mockReturnValueOnce(true);
    onCancel();
    expect(emit).toHaveBeenCalledWith('SIGINT');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('test exit');
    });
    emit.mockReturnValueOnce(false);
    expect(onCancel).toThrow('test exit');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('reports a completed operation on a disabled installation without claiming enabled traffic', async () => {
    vi.mocked(installPlatform).mockResolvedValueOnce({
      manifest: { ...state.manifest!, desiredState: 'disabled', status: 'disabled' },
      waitingForDns: false,
      waitingForSandboxDrain: false,
      zoneNameServers: [],
    });
    await upgrade();
    expect(log.info).toHaveBeenCalledWith(
      'Application traffic remains paused. Enable the installation when you are ready.',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('Traffic is enabled'));
    expect(printSuccess).not.toHaveBeenCalledWith(expect.stringContaining('healthy'));
  });

  it('previews enabling a disabled installation without promising it will stay paused', async () => {
    state.manifest = { ...state.manifest!, desiredState: 'disabled', status: 'disabled' };
    await runInstalledPlatformCommand({
      subcommand: 'enable',
      selector: state.manifest.id,
      plan: true,
      runtime: '',
      yes: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      'Application traffic may pause briefly during a safe cutover.',
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining('Application traffic will stay paused'),
    );
  });

  describe('repair while first administrator setup is pending', () => {
    const previousCode = 'a'.repeat(64);
    const previousSetup = JSON.stringify(
      parsePlatformAuthenticationSetup({
        connections: [
          {
            configuration: {
              id: 'company',
              kind: 'oidc',
              label: 'Company SSO',
              issuer: 'https://sso.example.com',
              clientId: 'old-client',
            },
            clientSecret: 'old-secret',
          },
        ],
        administratorConnectionId: 'company',
        admission: { mode: 'restricted' },
        protection: null,
        bootstrapCredentialHash: createHash('sha256').update(previousCode).digest('hex'),
      }),
    );
    const recovery = {
      databaseUrl: 'postgres://database',
      authenticationSetupJson: previousSetup,
      authSetupToken: 'b'.repeat(64),
      authBootstrapCode: previousCode,
    };
    let directory: string;
    let authFile: string;
    const repair = (overrides: { authConfig?: string; plan?: boolean; yes?: boolean } = {}) =>
      runInstalledPlatformCommand({
        subcommand: 'repair',
        selector: state.manifest!.id,
        plan: false,
        runtime: '',
        yes: true,
        ...overrides,
      });
    const replacement = () => state.createSecrets.mock.calls.at(-1)![0];

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'void-repair-login-'));
      authFile = join(directory, 'auth.json');
      await writeFile(
        authFile,
        JSON.stringify({
          connections: [
            {
              configuration: {
                id: 'company',
                kind: 'oidc',
                label: 'Company SSO',
                issuer: 'https://sso.example.com',
                clientId: 'new-client',
              },
              clientSecretEnv: 'TEST_REPAIR_LOGIN_SECRET',
            },
          ],
        }),
      );
      vi.stubEnv('TEST_REPAIR_LOGIN_SECRET', 'new-secret');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(readInstallationRecoverySecrets).mockReturnValue(recovery);
      state.readAdministratorSetup.mockReset().mockResolvedValue({
        pending: true,
        usersExist: false,
        requestHash: authenticationSetupRequestHash(previousSetup),
      });
      state.manifest = {
        ...state.manifest!,
        deployment: createPlatformDeploymentManifest({
          ...state.manifest!.deployment,
          authentication: { providers: ['oidc'], configurable: true },
          capabilities: { ...state.manifest!.deployment.capabilities, githubOAuth: false },
        }),
      };
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('sends new login settings with a new setup code and keeps the setup authority', async () => {
      vi.mocked(installPlatform).mockResolvedValueOnce({
        manifest: state.manifest!,
        setupPending: true,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
      });
      await repair({ authConfig: authFile });
      const input = replacement();
      const setup = parsePlatformAuthenticationSetup(JSON.parse(input.authenticationSetupJson));
      expect(setup.resetPending).toBe(true);
      expect(setup.connections[0]).toMatchObject({
        configuration: { clientId: 'new-client' },
        clientSecret: 'new-secret',
      });
      expect(input.authBootstrapCode).toMatch(/^[a-f0-9]{64}$/);
      expect(input.authBootstrapCode).not.toBe(previousCode);
      expect(setup.bootstrapCredentialHash).toBe(
        createHash('sha256').update(input.authBootstrapCode).digest('hex'),
      );
      expect(input).not.toHaveProperty('authSetupToken');
      expect(input.checkpoint).toBe(recovery);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('/auth/callback'));
      expect(log.info).toHaveBeenCalledWith(
        `If sign-in fails, run \`void platform repair ${state.manifest!.id}\` to change the login settings.`,
      );
    });

    it.each([
      [
        'once the first administrator signed in',
        { pending: false, usersExist: true, requestHash: 'accepted' },
        'The first administrator has already signed in. Change login methods with `void platform config auth`.',
      ],
      [
        'when setup was never started',
        { pending: false, usersExist: false, requestHash: null },
        'Administrator setup was never started. Resume the install with `void platform install --resume --name',
      ],
    ])('refuses before any change %s', async (_label, setup, message) => {
      state.readAdministratorSetup.mockResolvedValueOnce(setup);
      await expect(repair({ authConfig: authFile })).rejects.toThrow(message);
      expect(state.createSecrets).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a GitHub-only installation',
        () => {
          state.manifest = {
            ...state.manifest!,
            deployment: createPlatformDeploymentManifest({
              ...state.manifest!.deployment,
              authentication: { providers: ['github'] },
              capabilities: { ...state.manifest!.deployment.capabilities, githubOAuth: true },
            }),
          };
        },
        'Set VOID_PLATFORM_GITHUB_CLIENT_ID and VOID_PLATFORM_GITHUB_CLIENT_SECRET',
      ],
      [
        'a computer without the saved setup authority',
        () => {
          vi.mocked(readInstallationRecoverySecrets).mockReturnValue({
            databaseUrl: 'postgres://database',
          });
        },
        'needs the setup authority saved on the computer that installed the platform',
      ],
    ])('refuses %s before planning', async (_label, arrange, message) => {
      arrange();
      await expect(repair({ authConfig: authFile })).rejects.toThrow(message);
      expect(createPlatformInstallPlan).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
    });

    it('refuses on a disabled platform before planning', async () => {
      state.manifest = { ...state.manifest!, desiredState: 'disabled', status: 'disabled' };
      await expect(repair({ authConfig: authFile })).rejects.toThrow(
        `Run \`void platform enable ${state.manifest.id}\` first`,
      );
      expect(createPlatformInstallPlan).not.toHaveBeenCalled();
      expect(installPlatform).not.toHaveBeenCalled();
    });

    it('checks the file in a plan without reading the database', async () => {
      await repair({ authConfig: authFile, plan: true, yes: false });
      expect(log.info).toHaveBeenCalledWith(
        `Login settings will be replaced from ${authFile}; a new setup code is printed at the end.`,
      );
      expect(acquirePlatformDatabaseLifecycleLock).not.toHaveBeenCalled();
      expect(state.readAdministratorSetup).not.toHaveBeenCalled();
      await writeFile(
        authFile,
        JSON.stringify({ connections: [{ configuration: { kind: 'github', clientId: 'id' } }] }),
      );
      await expect(repair({ authConfig: authFile, plan: true, yes: false })).rejects.toThrow(
        'not which login methods',
      );
    });

    it('asks in a terminal only while setup is pending, and No keeps the saved settings', async () => {
      const tty = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        vi.mocked(confirm).mockResolvedValueOnce(false);
        await repair({ yes: false });
        expect(confirm).toHaveBeenCalledExactlyOnceWith({
          message:
            'First administrator setup is not finished. Change the login settings before continuing?',
          initialValue: false,
        });
        expect(replacement()).not.toHaveProperty('authenticationSetupJson');

        vi.mocked(confirm).mockClear();
        state.progress.stop.mockClear();
        state.readAdministratorSetup.mockResolvedValueOnce({
          pending: false,
          usersExist: true,
          requestHash: 'accepted',
        });
        await repair({ yes: false });
        expect(confirm).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
      }
    });

    it('keeps the saved login settings when the first administrator signs in during repair', async () => {
      const pending = { ...recovery, authenticationSetupJson: 'new', authBootstrapCode: 'new' };
      vi.mocked(readPendingInstallationSecrets).mockReturnValueOnce(pending);
      state.readAdministratorSetup
        .mockResolvedValueOnce({
          pending: true,
          usersExist: false,
          requestHash: authenticationSetupRequestHash(previousSetup),
        })
        .mockResolvedValueOnce({
          pending: false,
          usersExist: true,
          requestHash: authenticationSetupRequestHash(previousSetup),
        });
      vi.mocked(installPlatform).mockRejectedValueOnce(
        new Error('platform: Authentication setup failed (HTTP 409).'),
      );
      await expect(repair({ authConfig: authFile })).rejects.toThrow(
        'The first administrator signed in before the new login settings were applied. Nothing changed.',
      );
      expect(writePendingInstallationSecrets).toHaveBeenCalledExactlyOnceWith(state.manifest, {
        ...pending,
        authenticationSetupJson: previousSetup,
        authBootstrapCode: previousCode,
      });
    });

    it('keeps the new login settings for a retry when the platform has not refused them', async () => {
      vi.mocked(installPlatform).mockRejectedValueOnce(new Error('Worker upload failed'));
      await expect(repair({ authConfig: authFile })).rejects.toThrow('Worker upload failed');
      expect(writePendingInstallationSecrets).not.toHaveBeenCalled();
    });
  });

  describe('runtime token email access', () => {
    const emailPaths = [
      '/zones/mail-zone',
      '/zones/mail-zone/email/routing',
      '/zones/mail-zone/email/routing/rules?per_page=5',
      '/accounts/account/email/routing/addresses?per_page=5',
    ];
    const emailRequests = () =>
      state.events.filter(
        (event) => event.startsWith('request:') && /mail-zone|\/email\//.test(event),
      );
    const enableEmail = (desiredState: 'disabled' | 'enabled' = 'enabled') => {
      state.manifest = {
        ...state.manifest!,
        deployment: createPlatformDeploymentManifest({
          application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
          capabilities: { email: true },
          displayName: 'Example',
          emailSenderDomain: 'mail.example.com',
          emailSharedZoneId: 'mail-zone',
          installationSlug: 'example',
        }),
        ...(desiredState === 'disabled' ? { desiredState, status: 'disabled' as const } : {}),
      };
    };

    beforeEach(() => {
      state.createSecrets.mockReturnValue({ cloudflareApiToken: 'saved-runtime-token' });
      state.request.mockImplementation(async (path: string) => {
        state.events.push(`request:${path}`);
        return { name: 'assets' };
      });
    });

    it('checks the saved runtime token before the installer can pause traffic', async () => {
      await upgrade();
      expect(emailRequests()).toEqual([]);
      expect(state.clientTokens).not.toContain('saved-runtime-token');

      state.events.length = 0;
      state.progress.stop.mockClear();
      enableEmail();
      await upgrade();

      expect(state.clientTokens).toContain('saved-runtime-token');
      expect(emailRequests()).toEqual(emailPaths.map((path) => `request:${path}`));
      const installerStart = state.events.indexOf('installer-start');
      expect(installerStart).toBeGreaterThan(-1);
      for (const request of emailRequests()) {
        expect(state.events.indexOf(request)).toBeLessThan(installerStart);
      }
    });

    it('checks an explicit replacement token with the core runtime checks', async () => {
      enableEmail();
      state.createSecrets.mockReturnValue({
        cloudflareApiToken: 'replacement-token',
        workerSecretUpdates: { CF_API_TOKEN: 'replacement-token' },
      });

      await upgrade();

      expect(state.clientTokens).toContain('replacement-token');
      expect(state.clientTokens).not.toContain('saved-runtime-token');
      expect(emailRequests()).toEqual(emailPaths.map((path) => `request:${path}`));
    });

    it('stops before the installer and names the missing email permissions', async () => {
      enableEmail();
      state.request.mockImplementation(async (path: string) => {
        state.events.push(`request:${path}`);
        if (path.includes('/email/routing')) {
          throw new PlatformCloudflareApiError('Authentication error', 403, path);
        }
        return { name: 'assets' };
      });

      // The Workers can use a newer token than the one saved on this machine.
      await expect(upgrade()).rejects.toThrow(
        'platform: The runtime API token saved on this machine cannot use platform email. Cloudflare denied: Zone → Zone Settings → Edit, Zone → Email Routing Rules → Edit, Account → Email Routing Addresses → Edit (HTTP 403). Void checked this token because VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN is not set. If the platform uses a different runtime token, set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to that token, and Void checks that token instead.',
      );
      expect(installPlatform).not.toHaveBeenCalled();

      // A token from VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN goes to the
      // Workers, so the message does not talk about the saved token.
      state.createSecrets.mockReturnValue({
        cloudflareApiToken: 'replacement-token',
        workerSecretUpdates: { CF_API_TOKEN: 'replacement-token' },
      });
      const explicit = await upgrade().then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      expect(explicit?.message).toContain(
        'platform: The runtime API token cannot use platform email. Cloudflare denied: Zone → Zone Settings → Edit, Zone → Email Routing Rules → Edit, Account → Email Routing Addresses → Edit (HTTP 403). Check that the token is valid',
      );
      expect(explicit?.message).not.toContain('saved on this machine');
      expect(installPlatform).not.toHaveBeenCalled();
      expect(state.events.filter((event) => event.startsWith('put:'))).toEqual([]);
    });

    it('continues with one warning only when the token saved on this machine is not valid', async () => {
      enableEmail();
      // Cloudflare's answers to a token that is not valid.
      state.request.mockImplementation(async (path: string) => {
        state.events.push(`request:${path}`);
        if (path === '/zones/mail-zone') {
          throw new PlatformCloudflareApiError('Invalid access token', 403, path);
        }
        if (path.includes('/email/routing')) {
          throw new PlatformCloudflareApiError('Authentication error', 401, path);
        }
        return { name: 'assets' };
      });

      await upgrade();

      expect(vi.mocked(log.warn).mock.calls).toEqual([
        [
          'The runtime API token saved on this machine is not valid (HTTP 401). Void cannot check the platform email permissions before it changes the platform, and it continues without this check. To do the check, set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to the runtime token of the platform.',
        ],
      ]);
      expect(emailRequests()).toEqual(emailPaths.map((path) => `request:${path}`));
      expect(installPlatform).toHaveBeenCalledOnce();

      vi.mocked(log.warn).mockClear();
      state.createSecrets.mockReturnValue({
        cloudflareApiToken: 'replacement-token',
        workerSecretUpdates: { CF_API_TOKEN: 'replacement-token' },
      });

      await expect(upgrade()).rejects.toThrow(
        'Cloudflare denied: Zone → Zone → Read, Zone → Zone Settings → Edit, Zone → Email Routing Rules → Edit, Account → Email Routing Addresses → Edit (HTTP 403)',
      );
      expect(log.warn).not.toHaveBeenCalled();
      expect(installPlatform).toHaveBeenCalledOnce();
    });

    it('checks a disabled installation only when the command enables it', async () => {
      enableEmail('disabled');
      await upgrade();
      expect(emailRequests()).toEqual([]);
      expect(installPlatform).toHaveBeenCalledOnce();

      state.progress.stop.mockClear();
      await runInstalledPlatformCommand({
        subcommand: 'enable',
        selector: state.manifest!.id,
        plan: false,
        runtime: '',
        yes: true,
      });

      expect(emailRequests()).toEqual(emailPaths.map((path) => `request:${path}`));
      expect(installPlatform).toHaveBeenCalledTimes(2);
    });
  });

  describe('uninstall with project Zero Trust', () => {
    const enabled = {
      active: true,
      destinations: ['*.apps.example.com'],
      applications: [{ role: 'shared project application', id: 'app', name: 'void-app' }],
      unfinishedDeletions: [],
    };
    const uninstall = (plan: boolean) =>
      runInstalledPlatformCommand({
        plan,
        purgeData: true,
        purgeResources: false,
        selector: state.manifest!.id,
        subcommand: 'uninstall',
        yes: true,
      });

    it('reads the state under the held lifecycle lock and refuses before disabling traffic', async () => {
      state.readProjectZeroTrust.mockResolvedValueOnce(enabled);
      await expect(uninstall(false)).rejects.toThrow(
        'Refusing to uninstall while project Zero Trust is enabled',
      );
      expect(state.readProjectZeroTrust).toHaveBeenCalledOnce();
      expect(state.readPlanZeroTrust).not.toHaveBeenCalled();
      expect(state.events).toEqual(['outer-release', 'local-release']);
    });

    it('reads the state for a plan without taking the lifecycle lock', async () => {
      state.readPlanZeroTrust.mockResolvedValueOnce(enabled);
      await expect(uninstall(true)).rejects.toThrow(
        'Refusing to uninstall while project Zero Trust is enabled',
      );
      expect(state.readPlanZeroTrust).toHaveBeenCalledExactlyOnceWith(
        'postgres://database',
        state.manifest!.id,
        state.manifest!.ownershipNonce,
      );
      expect(acquirePlatformDatabaseLifecycleLock).not.toHaveBeenCalled();
      expect(state.events).toEqual([]);
    });

    it('plans the uninstall when Zero Trust owns nothing', async () => {
      state.readPlanZeroTrust.mockResolvedValueOnce({
        active: false,
        destinations: [],
        applications: [],
      });
      await uninstall(true);
      expect(
        vi
          .mocked(note)
          .mock.calls.map(([message, title]) => [message, stripVTControlCharacters(title ?? '')]),
      ).toContainEqual([expect.any(String), 'Uninstall plan']);
      expect(state.events).toEqual([]);
    });
  });

  describe('platform Workers changed outside Void', () => {
    const apiWorker = () => state.manifest!.deployment.resources.apiWorker;
    const activeVersion = '44444444-4444-4444-8444-444444444444';
    const withApiWorker = () => {
      const original = vi.mocked(createPlatformInstallPlan).getMockImplementation()!;
      vi.mocked(createPlatformInstallPlan).mockImplementationOnce(async (...args) => {
        const plan = await original(...args);
        return {
          ...plan,
          actions: [
            ...plan.actions,
            {
              action: 'update',
              id: null,
              key: 'api-worker',
              kind: 'worker',
              name: apiWorker(),
              reason: 'installed',
            },
          ],
        };
      });
      // Void deployed the active version of the API Worker.
      state.request.mockImplementation(async (path: string) => {
        if (path.endsWith(`/${apiWorker()}/deployments`)) {
          return {
            deployments: [
              {
                id: 'deployment',
                created_on: '2026-09-14T00:00:03.000Z',
                versions: [{ version_id: activeVersion, percentage: 100 }],
              },
            ],
          };
        }
        if (path.endsWith(`/versions/${activeVersion}`)) {
          return {
            annotations: {
              'workers/message': encodeCloudflareVersionMessage([], {
                workers_dev: true,
                preview_urls: false,
                routes: [],
                crons: [],
                queueConsumers: [],
                workflows: [],
              }),
            },
          };
        }
        return { name: 'assets' };
      });
    };
    const gateWrites = () => state.events.filter((event) => event.startsWith('put:'));

    it('stops before any change when there is no terminal', async () => {
      withApiWorker();
      state.getWorkerLastDeployedFrom.mockResolvedValue('dash');

      const error = await upgrade().then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(
        `These platform Workers need your approval before this command replaces their configuration:\n${apiWorker()}: changed in the Cloudflare dashboard\nNo platform Worker changed. This command did not pause application traffic.`,
      );
      expect(error?.message).toContain(
        `Run this command once in a terminal to review them:\nvoid platform upgrade ${state.manifest!.id}`,
      );
      expect(error?.message).not.toContain('--yes');
      expect(state.getWorkerLastDeployedFrom).toHaveBeenCalledExactlyOnceWith(
        'account',
        apiWorker(),
      );
      expect(installPlatform).not.toHaveBeenCalled();
      expect(state.progress.start).not.toHaveBeenCalled();
      expect(gateWrites()).toEqual([]);
      expect(state.cfRunner).not.toHaveBeenCalled();
    });

    it('runs unchanged when Void made the last change', async () => {
      withApiWorker();

      await upgrade();

      expect(state.getWorkerLastDeployedFrom).toHaveBeenCalledExactlyOnceWith(
        'account',
        apiWorker(),
      );
      expect(installPlatform).toHaveBeenCalledOnce();
      expect(vi.mocked(installPlatform).mock.calls[0]![3]).not.toHaveProperty(
        'replaceOutsideChanges',
      );
      expect(state.cfRunner).not.toHaveBeenCalled();
    });

    it('warns in a plan and changes nothing', async () => {
      withApiWorker();
      state.getWorkerLastDeployedFrom.mockResolvedValue('api');

      await upgrade({ plan: true });

      expect(log.warn).toHaveBeenCalledWith(
        `These platform Workers need your approval before this command replaces their configuration:\n${apiWorker()}: changed in the Cloudflare API\nThis command replaces their configuration with the Void configuration. Run it in a terminal to review them first.`,
      );
      expect(installPlatform).not.toHaveBeenCalled();
      expect(state.events).toEqual([]);
    });

    describe('when Void cannot read the Worker', () => {
      const failure = (status: number) =>
        new PlatformCloudflareApiError('Cloudflare error', status);
      /** Answer the reads of one path with these answers, and the other reads as before. */
      const answer = (suffix: () => string, reply: () => Promise<unknown>) => {
        const original = state.request.getMockImplementation()!;
        state.request.mockImplementation(async (path: string) =>
          path.endsWith(suffix()) ? reply() : original(path),
        );
      };
      const reads = (suffix: string) =>
        state.request.mock.calls.filter(([path]) => String(path).endsWith(suffix)).length;

      it.each([
        {
          name: 'Cloudflare refuses the token',
          fail: () => state.getWorkerLastDeployedFrom.mockRejectedValue(failure(403)),
          attempts: () => state.getWorkerLastDeployedFrom.mock.calls.length,
          expected: { attempts: 1, message: '(HTTP 403)' },
        },
        {
          name: 'Cloudflare fails three times',
          fail: () => state.getWorkerLastDeployedFrom.mockRejectedValue(failure(500)),
          attempts: () => state.getWorkerLastDeployedFrom.mock.calls.length,
          expected: { attempts: 3, message: '(HTTP 500)' },
        },
        {
          name: 'the network fails three times',
          fail: () =>
            answer(
              () => `/${apiWorker()}/deployments`,
              async () => {
                throw new TypeError('fetch failed');
              },
            ),
          attempts: () => reads(`/${apiWorker()}/deployments`),
          expected: { attempts: 3, message: '(no HTTP response: fetch failed)' },
        },
        {
          name: 'the deployment data is malformed',
          fail: () =>
            answer(
              () => `/${apiWorker()}/deployments`,
              async () => ({ deployments: {} }),
            ),
          attempts: () => reads(`/${apiWorker()}/deployments`),
          expected: { attempts: 1, message: 'Cloudflare returned malformed deployment data' },
        },
        {
          name: 'the version read fails three times',
          fail: () =>
            answer(
              () => `/versions/${activeVersion}`,
              async () => {
                throw failure(503);
              },
            ),
          attempts: () => reads(`/versions/${activeVersion}`),
          expected: { attempts: 3, message: '(HTTP 503)' },
        },
      ])('stops before the installer when $name', async ({ fail, attempts, expected }) => {
        withApiWorker();
        fail();

        const error = await upgrade().then(
          () => null,
          (failure: unknown) => failure as Error,
        );

        expect(error?.message).toContain(apiWorker());
        expect(error?.message).toContain(expected.message);
        expect(error?.message).toContain(
          'No platform Worker changed. This command did not pause application traffic.',
        );
        expect(error?.message).toMatch(/run the command again\.$/i);
        expect(attempts()).toBe(expected.attempts);
        expect(installPlatform).not.toHaveBeenCalled();
        expect(state.progress.start).not.toHaveBeenCalled();
        expect(gateWrites()).toEqual([]);
        expect(state.cfRunner).not.toHaveBeenCalled();
      });

      it('reads again after a rate limit and runs', async () => {
        withApiWorker();
        state.getWorkerLastDeployedFrom
          .mockRejectedValueOnce(failure(429))
          .mockResolvedValue('cf_cli');

        await upgrade();

        expect(state.getWorkerLastDeployedFrom).toHaveBeenCalledTimes(2);
        expect(installPlatform).toHaveBeenCalledOnce();
        expect(vi.mocked(installPlatform).mock.calls[0]![3]).not.toHaveProperty(
          'replaceOutsideChanges',
        );
      });
    });

    describe('after a run stopped during a Worker cutover', () => {
      const voidVersion = '22222222-2222-4222-8222-222222222222';
      const earlierVersion = '33333333-3333-4333-8333-333333333333';
      const triggers = {
        workers_dev: true,
        preview_urls: false,
        routes: [],
        crons: [],
        queueConsumers: [],
        workflows: [],
      };
      // The run agreed to replace a change made outside Void on the API
      // Worker. It made Void's version active and stopped before the cutover
      // finished. The marker shows the Cloudflare CLI.
      const stoppedRun = (sessionsRequired: boolean) => {
        withApiWorker();
        state.manifest = recordWorkerCutoverStage(
          state.manifest!,
          1,
          'api',
          earlierVersion,
          voidVersion,
          apiWorker(),
          triggers,
          '2026-09-14T00:00:03.000Z',
        );
        state.request.mockImplementation(async (path: string) => {
          if (path.endsWith(`/${apiWorker()}/deployments`)) {
            return {
              deployments: [
                {
                  id: 'deployment',
                  created_on: '2026-09-14T00:00:03.000Z',
                  versions: [{ version_id: voidVersion, percentage: 100 }],
                },
              ],
            };
          }
          if (path.endsWith(`/versions/${voidVersion}`)) {
            return {
              annotations: { 'workers/message': encodeCloudflareVersionMessage([], triggers) },
            };
          }
          if (path.endsWith(`/versions/${earlierVersion}`)) {
            return { annotations: {} };
          }
          return { name: 'assets' };
        });
        // This installation has not changed to configurable sign-in yet.
        state.readAuthenticationState.mockResolvedValue({
          enabledProviders: [],
          protectedByAccess: false,
          sessionsRequired,
        });
      };

      it('stops before any change when the run restores an earlier version without a Void record', async () => {
        stoppedRun(false);

        const error = await upgrade().then(
          () => null,
          (failure: unknown) => failure as Error,
        );

        expect(error?.message).toContain(
          `${apiWorker()}: has an active version without a Void deployment record\nNo platform Worker changed.`,
        );
        expect(state.request).toHaveBeenCalledWith(
          `/accounts/account/workers/scripts/${apiWorker()}/versions/${earlierVersion}`,
        );
        expect(installPlatform).not.toHaveBeenCalled();
        expect(gateWrites()).toEqual([]);
      });

      it('runs when the installer keeps the version of Void, as the database shows', async () => {
        stoppedRun(true);

        await upgrade();

        expect(state.request).not.toHaveBeenCalledWith(
          `/accounts/account/workers/scripts/${apiWorker()}/versions/${earlierVersion}`,
        );
        expect(installPlatform).toHaveBeenCalledOnce();
        expect(vi.mocked(installPlatform).mock.calls[0]![3]).not.toHaveProperty(
          'replaceOutsideChanges',
        );
      });
    });

    describe('in a terminal, after the operator agrees', () => {
      const createdCacheId = 'isr-cache-created-in-run';
      const runInTerminal = async () => {
        withApiWorker();
        const version = '11111111-1111-4111-8111-111111111111';
        const marker = JSON.stringify(
          createPlatformResourceOwnershipMarker({
            accountId: 'account',
            installationId: state.manifest!.id,
            ownershipNonce: state.manifest!.ownershipNonce,
            resourceId: apiWorker(),
            resourceKey: 'api-worker',
            resourceKind: 'worker',
            resourceName: apiWorker(),
          }),
        );
        state.request.mockImplementation(async (path: string) => {
          if (path.endsWith('/deployments')) {
            return {
              deployments: [
                {
                  id: 'deployment',
                  created_on: '2026-10-15T00:00:00.000Z',
                  versions: [{ version_id: version, percentage: 100 }],
                },
              ],
            };
          }
          if (path.endsWith(`/versions/${version}`)) {
            return {
              resources: {
                bindings: [{ name: 'PLATFORM_OWNERSHIP_MARKER', type: 'plain_text', text: marker }],
              },
            };
          }
          return { name: 'assets' };
        });
        // Like the installer: it creates a resource, uploads the Workers changed
        // outside Void with the configs that the run deploys, then pauses traffic.
        const installer = vi.mocked(installPlatform).getMockImplementation()!;
        vi.mocked(installPlatform).mockImplementation(
          async (plan, _secrets, existing, dependencies) => {
            state.events.push('installer-start', 'create:isr-cache-kv');
            await dependencies.uploadOutsideChanges!([
              {
                account_id: 'account',
                compatibility_date: '2026-09-30',
                kv_namespaces: [{ binding: 'ISR_CACHE', id: createdCacheId }],
                main: join(state.runtime!.directory, state.runtime!.manifest.artifacts.api.path),
                name: apiWorker(),
                vars: { PLATFORM_OWNERSHIP_MARKER: marker },
              },
            ]);
            await dependencies.client.putKvValue(
              plan.account.id,
              'routing-kv-id',
              PLATFORM_DISABLED_KEY,
              'true',
            );
            return {
              manifest: existing!,
              waitingForDns: false,
              waitingForSandboxDrain: false,
              zoneNameServers: [],
            };
          },
        );
        state.progress.pause.mockImplementation(() => state.events.push('progress-pause'));
        state.progress.resume.mockImplementation(() => state.events.push('progress-resume'));
        vi.mocked(confirm).mockResolvedValueOnce(true);
        const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        try {
          return await upgrade({ yes: false }).then(
            () => null,
            (failure: unknown) => failure as Error,
          );
        } finally {
          vi.mocked(installPlatform).mockImplementation(installer);
          Object.defineProperty(process.stdin, 'isTTY', { value: tty.stdin, configurable: true });
          Object.defineProperty(process.stdout, 'isTTY', { value: tty.stdout, configurable: true });
        }
      };

      it('uploads with the run config when the installer asks, before traffic pauses', async () => {
        state.getWorkerLastDeployedFrom.mockResolvedValueOnce('api').mockResolvedValue('cf_cli');
        const uploaded: Array<string> = [];
        state.cfRunner.mockImplementation(async (operation: { configPath: string }) => {
          state.events.push('review-upload');
          uploaded.push(await readFile(operation.configPath, 'utf8'));
          return { status: 0, stdout: '', stderr: '' };
        });

        expect(await runInTerminal()).toBeNull();

        expect(confirm).toHaveBeenCalledWith({
          message: 'Replace the configuration of these Workers?',
          initialValue: false,
        });
        expect(state.cfRunner).toHaveBeenCalledOnce();
        expect(state.cfRunner.mock.calls[0]![0]).toMatchObject({
          type: 'versions.upload',
          interactive: true,
        });
        expect(state.events).toEqual([
          'installer-start',
          'create:isr-cache-kv',
          'progress-pause',
          'review-upload',
          'progress-resume',
          `put:${PLATFORM_DISABLED_KEY}`,
          'outer-release',
          'local-release',
        ]);
        expect(uploaded).toHaveLength(1);
        expect(uploaded[0]).toContain(createdCacheId);
        expect(JSON.stringify(state.manifest!.resources)).not.toContain(createdCacheId);
        expect(vi.mocked(installPlatform).mock.calls[0]![3]).toMatchObject({
          replaceOutsideChanges: [apiWorker()],
        });
      });

      it('stops before traffic pauses and shows why when the Cloudflare CLI refuses', async () => {
        state.getWorkerLastDeployedFrom.mockResolvedValue('api');
        state.cfRunner.mockImplementation(async () => {
          state.events.push('review-upload');
          return { status: 1, stdout: '', stderr: '' };
        });

        const error = await runInTerminal();

        expect(error?.message).toBe(
          `platform: The Cloudflare CLI did not replace the changes to ${apiWorker()}. Its output above shows why. No deployment changed. This command did not pause application traffic.`,
        );
        expect(state.events).toContain('review-upload');
        expect(gateWrites()).toEqual([]);
        expect(state.progress.resume).toHaveBeenCalledOnce();
        expect(state.progress.error).toHaveBeenCalledWith('Platform upgrade failed.');
      });

      it('replaces an active version that Void did not deploy without a review upload', async () => {
        // An earlier run replaced the change with the Cloudflare CLI and then
        // stopped. The marker shows the Cloudflare CLI, but the active version
        // in runInTerminal still has no Void record of its triggers.
        expect(await runInTerminal()).toBeNull();

        expect(confirm).toHaveBeenCalledOnce();
        expect(state.cfRunner).not.toHaveBeenCalled();
        expect(state.events).toEqual([
          'installer-start',
          'create:isr-cache-kv',
          `put:${PLATFORM_DISABLED_KEY}`,
          'outer-release',
          'local-release',
        ]);
        expect(vi.mocked(installPlatform).mock.calls[0]![3]).toMatchObject({
          replaceOutsideChanges: [apiWorker()],
        });
      });
    });
  });
});
