import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { encodeCloudflareVersionMessage } from '@void/deploy-cloudflare';
import {
  createPlatformDeploymentManifest,
  recordInstallationResource,
  transitionInstallation,
} from '@void/platform';
import { log, note, outro } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import * as terminalOutput from '../../src/cli/output.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import {
  PlatformCloudflareApiError,
  PlatformCloudflareClient,
  verifyPlatformRuntimeTokenEmailPermissions,
} from '../../src/cli/platform-cloudflare.ts';
import { recordWorkerCutoverStage } from '../../src/cli/platform-installer-cutover.ts';
import { PlatformAccessBlockedError } from '../../src/cli/platform-installer.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';
import {
  listInstallationManifests,
  readPendingInstallationSecrets,
  writePendingInstallationSecrets,
  writeInstallationManifest,
} from '../../src/cli/platform-registry.ts';
import { listSavedPlatformInstallPlans } from '../../src/cli/platform-saved-plans.ts';
import {
  completePlatformSetupDraft,
  isPlatformSetupDraft,
  isPlatformInstallInProgress,
  savePlatformSetupDraft,
} from '../../src/cli/platform-setup-draft.ts';
import { platformAccessFixture } from '../fixtures/platform-access.ts';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  operatorCredential: vi.fn(),
  open: vi.fn(),
  claim: vi.fn(),
  install: vi.fn(),
  preflight: vi.fn(),
  plan: vi.fn(),
  database: vi.fn(),
  spinner: vi.fn(),
  progress: {
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  },
  cfRunner: vi.fn(),
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  // These fixtures retain GitHub-only setup; Access choices have their own matrix.
  confirm: (input: { message: string }) =>
    input.message === 'Also protect the platform UI and APIs with Cloudflare Access?'
      ? Promise.resolve(false)
      : mocks.confirm(input),
  multiselect: mocks.multiselect,
  select: (input: { message: string; options: Array<{ value: string }> }) =>
    input.message === 'Who should be able to access deployed apps?'
      ? Promise.resolve('public')
      : input.message === 'How should Void set up Hyperdrive?'
        ? Promise.resolve(input.options[0]!.value)
        : mocks.select(input),
  text: mocks.text,
  password: mocks.password,
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}));
vi.mock('../../src/cli/auth.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/auth.ts')>()),
  openBrowser: mocks.open,
}));
vi.mock('../../src/cli/output.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/output.ts')>()),
  createSpinner: mocks.spinner,
}));
vi.mock('../../src/cli/platform-auth.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-auth.ts')>()),
  resolvePlatformCloudflareCredential: mocks.operatorCredential,
  resolvePlatformCloudflareCredentialWithInput: async (input: () => Promise<unknown>) => ({
    input: await input(),
    credential: await mocks.operatorCredential(),
  }),
}));
vi.mock('../../src/cli/platform-cloudflare.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-cloudflare.ts')>()),
  verifyPlatformRuntimeTokenPermissions: mocks.preflight,
}));
vi.mock('../../src/cli/platform-installer.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-installer.ts')>()),
  claimPlatformDatabase: mocks.claim,
  installPlatform: mocks.install,
  resolveBootstrapGitHubId: async () => '12345',
  readPlatformDatabaseLifecycleManifest: mocks.database,
}));
vi.mock('../../src/cli/platform-installer-process.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-installer-process.ts')>()),
  runPlatformWranglerAtApiBase: mocks.cfRunner,
}));
vi.mock('../../src/cli/platform-plan.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-plan.ts')>()),
  createPlatformInstallPlan: mocks.plan,
}));
let directory: string;
const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const args = [
  'install',
  '--name',
  'test-setup',
  '--account',
  'account',
  '--display-name',
  'Test',
  '--workers-dev',
];
const environment = {
  VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN: 'runtime-secret-value',
  VOID_PLATFORM_ADMIN_GITHUB_LOGIN: 'octocat',
  VOID_PLATFORM_ADMIN_GITHUB_ID: '12345',
  VOID_PLATFORM_DATABASE_URL: 'postgres://user:password@database.example.com/platform',
  VOID_PLATFORM_GITHUB_CLIENT_ID: 'github-id',
  VOID_PLATFORM_GITHUB_CLIENT_SECRET: 'github-secret-value',
  VOID_PLATFORM_R2_ACCESS_KEY_ID: 'r2-id',
  VOID_PLATFORM_R2_SECRET_ACCESS_KEY: 'r2-secret-value',
  VOID_PLATFORM_JWT_SECRET: 'a'.repeat(32),
  VOID_PLATFORM_PROJECT_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.database.mockReset();
  mocks.operatorCredential.mockResolvedValue({ source: 'oauth', token: 'operator-token' });
  mocks.multiselect.mockResolvedValue(['github']);
  directory = mkdtempSync(join(tmpdir(), 'void-credential-flow-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
  vi.stubEnv('VOID_PLATFORM_RECOVERY_KEY', Buffer.alloc(32, 3).toString('base64'));
  vi.stubEnv('DATABASE_URL', '');
  for (const key of [
    ...Object.keys(environment),
    'VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON',
    'VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION',
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'VOID_PLATFORM_ACCESS_SETUP_TOKEN',
    'VOID_ACCESS_CREDENTIALS',
  ]) {
    vi.stubEnv(key, '');
  }
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PlatformCloudflareClient.prototype, 'listAccounts').mockResolvedValue([
    { id: 'account', name: 'Account' },
  ]);
  vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([]);
  mocks.confirm.mockResolvedValue(true);
  mocks.spinner.mockReturnValue(mocks.progress);
  mocks.select.mockImplementation(async ({ message, options }) =>
    message === 'Continue a previous platform install?' ? options[0].value : 'workers-dev',
  );
  mocks.preflight.mockResolvedValue(undefined);
  mocks.plan.mockImplementation(async (_client, input, existing) => {
    const id = existing?.id ?? `${input.installationSlug}-123456abcdef`;
    const deployment = createPlatformDeploymentManifest({
      appAccess: input.appAccess ?? existing?.deployment.appAccess,
      installationSlug: input.installationSlug,
      displayName: input.displayName,
      ...(input.emailSharedZoneId && input.emailSenderDomain
        ? {
            capabilities: { email: true },
            emailSenderDomain: input.emailSenderDomain,
            emailSharedZoneId: input.emailSharedZoneId,
          }
        : {}),
      application: {
        baseDomain: 'account.workers.dev',
        zoneName: '',
        workersDev: { subdomain: 'account', installationId: id },
      },
      resources: existing?.deployment.resources,
    });
    return {
      account: { id: 'account', name: 'Account' },
      installationId: id,
      actions: [],
      apiUrl: 'https://' + deployment.resources.apiWorker + '.account.workers.dev',
      proxyUrl: 'https://proxy.account.workers.dev',
      workersSubdomain: 'account',
      deployment,
      zone: null,
    };
  });
  mocks.install.mockImplementation(async (_plan, _secrets, manifest) => ({
    manifest,
    waitingForDns: false,
    waitingForSandboxDrain: false,
  }));
  mocks.text.mockImplementation(async ({ message }) =>
    message.startsWith('Initial administrator')
      ? 'octocat'
      : message.startsWith('GitHub OAuth client ID')
        ? 'github-id'
        : message === 'Access Key ID:'
          ? 'r2-id'
          : '',
  );
  mocks.password.mockImplementation(async ({ message }) => {
    if (message.startsWith('Paste runtime')) {
      return environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN;
    }
    if (message.startsWith('PostgreSQL')) {
      return environment.VOID_PLATFORM_DATABASE_URL;
    }
    if (message.startsWith('GitHub OAuth')) {
      return environment.VOID_PLATFORM_GITHUB_CLIENT_SECRET;
    }
    if (message === 'Secret Access Key:') {
      return environment.VOID_PLATFORM_R2_SECRET_ACCESS_KEY;
    }
    if (message.startsWith('JWT')) {
      return environment.VOID_PLATFORM_JWT_SECRET;
    }
    if (message.startsWith('Project encryption')) {
      return environment.VOID_PLATFORM_PROJECT_SECRET_KEY;
    }
    throw new Error('Unexpected prompt: ' + message);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (tty) {
    Object.defineProperty(process.stdin, 'isTTY', tty);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  rmSync(directory, { recursive: true, force: true });
});

async function savedSetup(name = 'test-setup') {
  const plan = await mocks.plan(
    null,
    { installationSlug: name, displayName: `${name} Void` },
    null,
  );
  const draft = savePlatformSetupDraft(plan, '1.0.0');
  writePendingInstallationSecrets(draft, { cloudflareApiToken: 'saved-runtime-token' });
  mocks.plan.mockClear();
  return draft;
}

async function interruptedInstall() {
  const draft = await savedSetup();
  const manifest = transitionInstallation(
    completePlatformSetupDraft(draft),
    'failed',
    new Date().toISOString(),
  );
  writeInstallationManifest(manifest);
  writePendingInstallationSecrets(manifest, {
    cloudflareApiToken: 'saved-runtime-token',
    databaseUrl: environment.VOID_PLATFORM_DATABASE_URL,
    databaseClaimState: 'claimed',
  });
  return manifest;
}

async function externalHyperdrivePlanner() {
  const actual = await vi.importActual<typeof import('../../src/cli/platform-plan.ts')>(
    '../../src/cli/platform-plan.ts',
  );
  mocks.plan.mockImplementation(actual.createPlatformInstallPlan);
  mocks.database.mockResolvedValue(null);
  vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkersSubdomain').mockResolvedValue('account');
  for (const method of [
    'listAiGateways',
    'listKvNamespaces',
    'listR2Buckets',
    'listQueues',
    'listDispatchNamespaces',
    'listWorkerNames',
  ] as const) {
    vi.spyOn(PlatformCloudflareClient.prototype, method).mockResolvedValue([]);
  }
  const selected = {
    id: 'managed-drive',
    name: 'company-managed-postgres',
    database: 'platform',
    host: 'tunnel.example.com/cluster/primary',
    user: 'runtime_user',
  };
  vi.mocked(PlatformCloudflareClient.prototype.listHyperdriveConfigs).mockResolvedValue([
    { id: selected.id, name: selected.name },
  ]);
  const config = {
    id: selected.id,
    name: selected.name,
    cachingDisabled: true,
    origin: {
      scheme: 'postgresql' as const,
      host: selected.host,
      user: selected.user,
      database: selected.database,
      port: null,
      accessClientId: 'tunnel-client',
    },
  };
  const getConfig = vi
    .spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig')
    .mockResolvedValue(config);
  return { selected, config, getConfig };
}

function requireManagementToken() {
  const original = mocks.plan.getMockImplementation()!;
  mocks.plan.mockImplementation(async (...input) => {
    const plan = await original(...input);
    return {
      ...plan,
      deployment: createPlatformDeploymentManifest({
        installationSlug: plan.deployment.installationSlug,
        displayName: plan.deployment.displayName,
        application: { baseDomain: 'example.com', zoneName: 'example.com' },
      }),
      actions: [
        {
          action: 'adopt',
          kind: 'dns-record',
          key: 'wildcard-dns',
          id: 'dns-id',
          name: '*.example.com',
          reason: 'test',
        },
      ],
    };
  });
}

function accessManagementPlan() {
  const original = mocks.plan.getMockImplementation()!;
  mocks.plan.mockImplementation(async (...input) => {
    const plan = await original(...input);
    return {
      ...plan,
      deployment: createPlatformDeploymentManifest({
        installationSlug: plan.deployment.installationSlug,
        displayName: plan.deployment.displayName,
        application: plan.deployment.application,
        authentication: input[1].authentication,
        capabilities: { githubOAuth: false },
        resources: plan.deployment.resources,
      }),
    };
  });
  for (const [key, value] of Object.entries(environment)) {
    vi.stubEnv(key, value);
  }
  return [...args, '--login-methods', 'cloudflare-access', '--access-protection'];
}

describe('platform credential onboarding', () => {
  it('uses one management token from initial setup through automatic Access provisioning', async () => {
    const installArgs = accessManagementPlan();
    const access = platformAccessFixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer management-secret');
      const url = new URL(String(input));
      const path = url.pathname.slice(url.pathname.indexOf('/accounts/')) + url.search;
      const result = path.includes('/access/groups')
        ? []
        : await access.transport.request(path, init);
      return Response.json({ success: true, result });
    });
    vi.stubGlobal('fetch', fetcher);
    mocks.password.mockResolvedValueOnce('management-secret');
    mocks.select.mockImplementation(async ({ options }) => options[0].value);
    mocks.multiselect.mockImplementation(async ({ options }) =>
      options
        .map(({ value }: { value: string }) => value)
        .filter((value: string) => ['company-idp', 'employees'].includes(value)),
    );
    mocks.install.mockImplementation(async (_plan, _secrets, manifest, dependencies) => {
      await dependencies.prepareAuthentication(manifest);
      return { manifest, waitingForDns: false, waitingForSandboxDrain: false };
    });
    await runPlatformLifecycleCommand(parsePlatformArgs(installArgs));
    expect(mocks.password).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'Paste management API token:' }),
    );
    expect(access.apps.size).toBe(2);
    expect(access.tokens.size).toBe(1);
    expect(mocks.install.mock.calls[0]![1].cloudflareApiToken).toBe(
      environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN,
    );
    const manifest = listInstallationManifests()[0]!;
    writePendingInstallationSecrets(manifest, {
      ...readPendingInstallationSecrets(manifest),
      accessManagementToken: 'stale-separate-access-token',
    });
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
    );
    expect(mocks.password).not.toHaveBeenCalled();
    expect(readPendingInstallationSecrets(manifest)?.accessManagementToken).toBeUndefined();
    expect(access.apps.size).toBe(2);
    expect(access.tokens.size).toBe(1);
  });

  it('rejects missing Access permissions at the initial management prompt before provisioning', async () => {
    const installArgs = accessManagementPlan();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    mocks.password
      .mockResolvedValueOnce('missing-access')
      .mockResolvedValueOnce('complete-manager');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        new Headers(init?.headers).get('Authorization') === 'Bearer missing-access'
          ? Response.json(
              { success: false, errors: [{ message: 'Access denied', code: 10000 }] },
              { status: 403 },
            )
          : Response.json({ success: true, result: [] }),
      ),
    );
    await runPlatformLifecycleCommand(parsePlatformArgs(installArgs));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cloudflare API error: Access denied (code 10000) (HTTP 403; GET /accounts/account/access/organizations).',
      ),
    );
    expect(mocks.password.mock.calls.map(([input]) => input.message)).toEqual([
      'Paste management API token:',
      'Paste management API token:',
    ]);
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.install.mock.calls[0]![1].managementApiToken).toBe('complete-manager');
    expect(mocks.install.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.password.mock.invocationCallOrder[1]!,
    );
  });

  it('propagates Access service failures without reprompting or provisioning', async () => {
    const installArgs = accessManagementPlan();
    mocks.password.mockResolvedValueOnce('management-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { success: false, errors: [{ message: 'Access unavailable', code: 10000 }] },
          { status: 503 },
        ),
      ),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(installArgs))).rejects.toThrow(
      'Access unavailable',
    );
    expect(mocks.password).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });

  it('previews the Access management requirement without collecting or probing credentials', async () => {
    const installArgs = accessManagementPlan();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await runPlatformLifecycleCommand(parsePlatformArgs([...installArgs, '--plan']));
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Cloudflare management API token for Access setup'),
      expect.any(String),
    );
    expect(mocks.password).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('checks an explicit management token before provisioning without replacing it interactively', async () => {
    const installArgs = accessManagementPlan();
    mocks.operatorCredential.mockResolvedValue({
      source: 'environment',
      token: 'explicit-manager',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          { success: false, errors: [{ message: 'Access denied', code: 10000 }] },
          { status: 403 },
        ),
      ),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(installArgs))).rejects.toThrow(
      'Access denied',
    );
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });
  it.each([false, true])(
    'resumes external Hyperdrive before adoption with a saved selection: %s',
    async (savedSelection) => {
      const { selected, getConfig } = await externalHyperdrivePlanner();
      mocks.install.mockRejectedValueOnce(new Error('interrupted before adoption'));
      const originalArgs = [...args, '--hyperdrive', selected.id];
      await expect(runPlatformLifecycleCommand(parsePlatformArgs(originalArgs))).rejects.toThrow(
        'interrupted before adoption',
      );
      const manifest = listInstallationManifests()[0]!;
      expect(isPlatformSetupDraft(manifest)).toBe(false);
      expect(manifest.resources).toEqual([]);
      const checkpoint = readPendingInstallationSecrets(manifest)!;
      expect(JSON.parse(checkpoint.externalHyperdriveJson!)).toEqual(selected);
      if (!savedSelection) {
        delete checkpoint.externalHyperdriveJson;
        writePendingInstallationSecrets(manifest, checkpoint);
        await runPlatformLifecycleCommand(parsePlatformArgs([...originalArgs, '--plan']));
        expect(console.log).toHaveBeenLastCalledWith(
          expect.stringContaining(`--hyperdrive ${selected.id}`),
        );
        expect(readPendingInstallationSecrets(manifest)?.externalHyperdriveJson).toBeUndefined();
      }
      vi.clearAllMocks();
      await runPlatformLifecycleCommand(
        parsePlatformArgs(
          savedSelection ? ['install', '--resume', '--name', manifest.id] : originalArgs,
        ),
      );
      expect(getConfig).toHaveBeenCalledExactlyOnceWith('account', selected.id);
      expect(mocks.install).toHaveBeenCalledOnce();
      expect(mocks.install.mock.calls[0]![0].actions).toContainEqual(
        expect.objectContaining({ key: 'hyperdrive', action: 'adopt', id: selected.id }),
      );
      expect(mocks.install.mock.calls[0]![2].id).toBe(manifest.id);
      expect(mocks.password).not.toHaveBeenCalled();
      expect(JSON.parse(readPendingInstallationSecrets(manifest)!.externalHyperdriveJson!)).toEqual(
        selected,
      );
    },
  );

  it('keeps the selected Hyperdrive when credential collection is cancelled', async () => {
    const { selected, getConfig } = await externalHyperdrivePlanner();
    mocks.password.mockResolvedValueOnce(Symbol('cancel'));
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--hyperdrive', selected.id])),
    ).rejects.toThrow('Cancelled');
    const manifest = listInstallationManifests()[0]!;
    expect(isPlatformSetupDraft(manifest)).toBe(true);
    expect(JSON.parse(readPendingInstallationSecrets(manifest)!.externalHyperdriveJson!)).toEqual(
      selected,
    );
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', manifest.id, '--plan']),
    );
    expect(getConfig).toHaveBeenCalledExactlyOnceWith('account', selected.id);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.plan.mock.calls[0]![1].externalHyperdrive).toEqual(selected);
  });

  it.each(['id', 'origin', 'caching'] as const)(
    'rejects changed external Hyperdrive %s before resuming',
    async (change) => {
      const { selected, config, getConfig } = await externalHyperdrivePlanner();
      mocks.install.mockRejectedValueOnce(new Error('interrupted before adoption'));
      await expect(
        runPlatformLifecycleCommand(parsePlatformArgs([...args, '--hyperdrive', selected.id])),
      ).rejects.toThrow('interrupted before adoption');
      const manifest = listInstallationManifests()[0]!;
      const checkpoint = readPendingInstallationSecrets(manifest);
      vi.clearAllMocks();
      if (change === 'origin') {
        getConfig.mockResolvedValue({
          ...config,
          origin: { ...config.origin, database: 'different-database' },
        });
      }
      if (change === 'caching') {
        getConfig.mockResolvedValue({ ...config, cachingDisabled: false });
      }
      await expect(
        runPlatformLifecycleCommand(
          parsePlatformArgs([
            'install',
            '--resume',
            '--name',
            manifest.id,
            ...(change === 'id' ? ['--hyperdrive', 'another-drive'] : []),
          ]),
        ),
      ).rejects.toThrow(
        change === 'caching' ? 'Disable SQL result caching' : 'differs from the saved installation',
      );
      expect(mocks.plan).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      expect(readPendingInstallationSecrets(manifest)).toEqual(checkpoint);
    },
  );

  it('checks the authoritative Hyperdrive receipt before accepting a resume selection', async () => {
    const { selected, getConfig } = await externalHyperdrivePlanner();
    mocks.install.mockRejectedValueOnce(new Error('interrupted before adoption'));
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--hyperdrive', selected.id])),
    ).rejects.toThrow('interrupted before adoption');
    const manifest = listInstallationManifests()[0]!;
    mocks.database.mockResolvedValue(
      recordInstallationResource(
        manifest,
        {
          key: 'hyperdrive',
          kind: 'hyperdrive',
          id: 'different-drive',
          name: selected.name,
          ownership: 'adopted',
          state: 'ready',
          configHash: 'a'.repeat(64),
        },
        new Date().toISOString(),
      ),
    );
    vi.clearAllMocks();
    await expect(
      runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      ),
    ).rejects.toThrow('differs from the saved installation');
    expect(getConfig).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('explains the management token requirement in a preview without collecting secrets', async () => {
    requireManagementToken();
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const notes = vi
      .mocked(note)
      .mock.calls.map(([message, title]) => [
        stripVTControlCharacters(message ?? ''),
        stripVTControlCharacters(title ?? ''),
      ]);
    expect(outro).toHaveBeenCalledWith('Plan complete and ready to execute.');
    expect(notes).toContainEqual([
      expect.stringContaining('• Cloudflare management API token for DNS changes'),
      'Required Credentials',
    ]);
    expect(notes.map(([, title]) => title)).toEqual([
      'Read-only installation plan',
      'Platform runtime',
      'Required Credentials',
    ]);
    expect(notes).toContainEqual([
      expect.stringContaining(
        `Login callback: ${(await mocks.plan.mock.results[0]!.value).apiUrl}/auth/callback`,
      ),
      'Read-only installation plan',
    ]);
    const credentialSummary = notes.find(([, title]) => title === 'Required Credentials')![0];
    expect(credentialSummary).not.toContain('/auth/callback');
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });

  it('saves a prompted management token encrypted and keeps it separate from the runtime token', async () => {
    requireManagementToken();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: {} }));
    vi.stubGlobal('fetch', fetcher);
    mocks.password.mockResolvedValueOnce('  management-secret  ');
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.password.mock.calls[0]![0].message).toBe('Paste management API token:');
    expect(mocks.plan).toHaveBeenCalledTimes(2);
    const management = mocks.plan.mock.calls[1]![0] as PlatformCloudflareClient;
    expect(management).not.toBe(mocks.plan.mock.calls[0]![0]);
    expect(mocks.install.mock.calls[0]![3].client).toBe(management);
    await management.request('/test');
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer management-secret' }),
      }),
    );
    expect(mocks.open).toHaveBeenCalledWith(expect.stringContaining('name=Test+Management'));
    const secrets = readPendingInstallationSecrets(listInstallationManifests()[0]!);
    expect(secrets?.cloudflareApiToken).toBe(
      environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN,
    );
    expect(secrets?.managementApiToken).toBe('management-secret');
    expect(mocks.install.mock.calls[0]![1].managementApiToken).toBe('management-secret');
    const savedFiles = readdirSync(directory, { recursive: true }).filter(
      (entry): entry is string => typeof entry === 'string' && /\.(json|enc)$/.test(entry),
    );
    for (const file of savedFiles) {
      expect(readFileSync(join(directory, file), 'utf8')).not.toContain('management-secret');
    }
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe('');
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('management-secret');
  });

  it.each([true, false])(
    'reuses the saved management token on resume with pending DNS changes: %s',
    async (needsDns) => {
      if (needsDns) {
        requireManagementToken();
      }
      const manifest = await interruptedInstall();
      writePendingInstallationSecrets(manifest, {
        ...readPendingInstallationSecrets(manifest),
        managementApiToken: 'saved-management-secret',
      });
      for (const [key, value] of Object.entries(environment)) {
        vi.stubEnv(key, value);
      }
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: {} }));
      vi.stubGlobal('fetch', fetcher);

      await runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      );

      expect(mocks.password).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(mocks.plan).toHaveBeenCalledTimes(2);
      const client = mocks.install.mock.calls[0]![3].client as PlatformCloudflareClient;
      await client.request('/management-token-check');
      expect(fetcher).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer saved-management-secret' }),
        }),
      );
      expect(mocks.install.mock.calls[0]![1].cloudflareApiToken).toBe('saved-runtime-token');
      expect(readPendingInstallationSecrets(manifest)?.managementApiToken).toBe(
        'saved-management-secret',
      );
    },
  );

  it('retains a verified management token if the next credential prompt is cancelled', async () => {
    requireManagementToken();
    mocks.password
      .mockResolvedValueOnce('management-secret')
      .mockResolvedValueOnce(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow('Cancelled');
    const manifest = listInstallationManifests()[0]!;
    expect(isPlatformSetupDraft(manifest)).toBe(true);
    expect(readPendingInstallationSecrets(manifest)?.managementApiToken).toBe('management-secret');
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
    );
    expect(
      mocks.password.mock.calls.some(([input]) => input.message === 'Paste management API token:'),
    ).toBe(false);
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it.each(['unauthorized', 'wrong account', 'plan denied'] as const)(
    'replaces a rejected saved management token: %s',
    async (reason) => {
      requireManagementToken();
      const manifest = await interruptedInstall();
      writePendingInstallationSecrets(manifest, {
        ...readPendingInstallationSecrets(manifest),
        managementApiToken: 'rejected-secret',
      });
      const accounts = vi.mocked(PlatformCloudflareClient.prototype.listAccounts);
      accounts.mockResolvedValueOnce([{ id: 'account', name: 'Account' }]);
      if (reason === 'wrong account') {
        accounts.mockResolvedValueOnce([{ id: 'other', name: 'Other' }]);
      }
      if (reason === 'unauthorized') {
        accounts.mockRejectedValueOnce(new PlatformCloudflareApiError('expired', 401));
      }
      if (reason === 'plan denied') {
        const original = mocks.plan.getMockImplementation()!;
        mocks.plan
          .mockImplementationOnce(original)
          .mockRejectedValueOnce(new PlatformCloudflareApiError('denied', 403));
      }
      mocks.password.mockResolvedValueOnce('replacement-secret');
      await runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      );
      expect(
        mocks.password.mock.calls.filter(
          ([input]) => input.message === 'Paste management API token:',
        ),
      ).toHaveLength(1);
      expect(mocks.open).toHaveBeenCalledWith(expect.stringContaining('Management'));
      expect(readPendingInstallationSecrets(manifest)?.managementApiToken).toBe(
        'replacement-secret',
      );
      expect(mocks.install).toHaveBeenCalledOnce();
    },
  );

  it('forgets a rejected management token if replacement is cancelled, preserving other credentials', async () => {
    requireManagementToken();
    const manifest = await interruptedInstall();
    const checkpoint = readPendingInstallationSecrets(manifest)!;
    writePendingInstallationSecrets(manifest, {
      ...checkpoint,
      managementApiToken: 'expired-secret',
    });
    vi.mocked(PlatformCloudflareClient.prototype.listAccounts)
      .mockResolvedValueOnce([{ id: 'account', name: 'Account' }])
      .mockRejectedValueOnce(new PlatformCloudflareApiError('expired', 401));
    mocks.password.mockResolvedValueOnce(Symbol('cancel'));
    await expect(
      runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      ),
    ).rejects.toThrow('Cancelled');
    expect(readPendingInstallationSecrets(manifest)).toEqual(checkpoint);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('retains the saved management token after a service failure without requesting a replacement', async () => {
    requireManagementToken();
    const manifest = await interruptedInstall();
    const checkpoint = {
      ...readPendingInstallationSecrets(manifest),
      managementApiToken: 'saved-secret',
    };
    writePendingInstallationSecrets(manifest, checkpoint);
    vi.mocked(PlatformCloudflareClient.prototype.listAccounts)
      .mockResolvedValueOnce([{ id: 'account', name: 'Account' }])
      .mockRejectedValueOnce(new PlatformCloudflareApiError('unavailable', 503));
    await expect(
      runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      ),
    ).rejects.toThrow('unavailable');
    expect(readPendingInstallationSecrets(manifest)).toEqual(checkpoint);
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps an environment override ahead of a saved management token', async () => {
    requireManagementToken();
    const manifest = await interruptedInstall();
    writePendingInstallationSecrets(manifest, {
      ...readPendingInstallationSecrets(manifest),
      managementApiToken: 'saved-secret',
    });
    mocks.operatorCredential.mockResolvedValue({ source: 'environment', token: 'explicit-token' });
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
    );
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(
      mocks.password.mock.calls.some(([input]) => input.message === 'Paste management API token:'),
    ).toBe(false);
    expect(readPendingInstallationSecrets(manifest)?.managementApiToken).toBe('saved-secret');
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it.each(['wrong account', 'rejected token'])(
    'lets users replace a management token in the same run: %s',
    async (failure) => {
      requireManagementToken();
      const accounts = vi.mocked(PlatformCloudflareClient.prototype.listAccounts);
      accounts.mockResolvedValueOnce([{ id: 'account', name: 'Account' }]);
      if (failure === 'wrong account') {
        accounts.mockResolvedValueOnce([{ id: 'other', name: 'Other' }]);
      } else {
        accounts.mockRejectedValueOnce(new PlatformCloudflareApiError('denied', 403));
      }
      mocks.password.mockResolvedValueOnce('wrong-secret').mockResolvedValueOnce('correct-secret');
      await runPlatformLifecycleCommand(parsePlatformArgs(args));
      expect(
        mocks.password.mock.calls.filter(
          ([input]) => input.message === 'Paste management API token:',
        ),
      ).toHaveLength(2);
      expect(mocks.plan).toHaveBeenCalledTimes(2);
      expect(mocks.install).toHaveBeenCalledOnce();
    },
  );

  it('preserves permission guidance and provider diagnostics when a management check fails', async () => {
    requireManagementToken();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const original = mocks.plan.getMockImplementation()!;
    mocks.plan.mockImplementationOnce(original).mockImplementationOnce(async (client) => {
      try {
        await client.request('/zones/zone/dns_records?private=query-value');
      } catch (cause) {
        throw new Error('Add Zone → DNS → Edit for example.com to the management token.', {
          cause,
        });
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: 'Access denied for rejected-secret' }],
          },
          { status: 403 },
        ),
      ),
    );
    mocks.password.mockResolvedValueOnce('rejected-secret').mockResolvedValueOnce(Symbol('cancel'));

    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow('Cancelled');

    expect(warn).toHaveBeenCalledOnce();
    const warning = warn.mock.calls[0]![0];
    expect(warning).toContain('Add Zone → DNS → Edit for example.com to the management token.');
    expect(warning).toContain('Access denied for [redacted] (code 10000)');
    expect(warning).toContain('HTTP 403; GET /zones/zone/dns_records');
    expect(warning).not.toContain('rejected-secret');
    expect(warning).not.toContain('query-value');
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });

  it('leaves no draft when management token input is cancelled', async () => {
    requireManagementToken();
    mocks.password.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow('Cancelled');
    expect(listInstallationManifests()).toEqual([]);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listSavedPlatformInstallPlans()).toHaveLength(1);
    const savedFile = readdirSync(directory).find((file) => file.startsWith('plan-'))!;
    expect(readFileSync(join(directory, savedFile), 'utf8')).not.toContain('operator-token');
  });

  it('requires a management environment token for headless DNS changes', async () => {
    requireManagementToken();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--yes'])),
    ).rejects.toThrow('Set CLOUDFLARE_API_TOKEN');
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });

  it('does not replace tokens after a service failure or apply a changed plan', async () => {
    requireManagementToken();
    mocks.password.mockResolvedValueOnce('management-secret');
    vi.mocked(PlatformCloudflareClient.prototype.listAccounts)
      .mockResolvedValueOnce([{ id: 'account', name: 'Account' }])
      .mockRejectedValueOnce(new PlatformCloudflareApiError('unavailable', 503));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'unavailable',
    );
    expect(mocks.password).toHaveBeenCalledOnce();
    expect(listInstallationManifests()).toEqual([]);
    const original = mocks.plan.getMockImplementation()!;
    mocks.plan.mockImplementationOnce(original).mockImplementationOnce(async (...input) => ({
      ...(await original(...input)),
      installationId: 'changed-installation',
    }));
    mocks.password.mockResolvedValueOnce('management-secret');
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'Resources changed while checking management API token',
    );
    expect(listInstallationManifests()).toEqual([]);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps explicit environment credentials and declined plans out of management token setup', async () => {
    requireManagementToken();
    mocks.confirm.mockResolvedValueOnce(false);
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    mocks.operatorCredential.mockResolvedValue({ source: 'environment', token: 'explicit-token' });
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(
      mocks.password.mock.calls.some(([input]) => input.message === 'Paste management API token:'),
    ).toBe(false);
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it('prints a command to install a fresh read-only plan without saving a draft', async () => {
    const colors = pc.createColors(true);
    vi.spyOn(pc, 'bold').mockImplementation(colors.bold);
    vi.spyOn(pc, 'cyan').mockImplementation(colors.cyan);
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const lastOutput = vi.mocked(console.log).mock.calls.at(-1)![0] as string;
    expect(lastOutput).toContain(colors.bold('Next, run this command to install the platform'));
    expect(stripVTControlCharacters(lastOutput)).toMatch(
      /Next, run this command to install the platform\n\nvoid platform install /,
    );
    expect(vi.mocked(outro).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(console.log).mock.invocationCallOrder.at(-1)!,
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'void platform install --name test-setup --account account --display-name Test --workers-dev',
      ),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('--login-methods github --no-access-protection'),
    );
    expect(listInstallationManifests()).toEqual([]);
  });

  it('prints the checkpoint command when previewing an interrupted install', async () => {
    const interrupted = await interruptedInstall();
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--resume', '--name', interrupted.id]),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`void platform install --resume --name ${interrupted.id}`),
    );
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringContaining('Next step: run this command to resume'),
    );
  });

  it('offers an interrupted install after credential collection and reads its database state', async () => {
    const interrupted = await interruptedInstall();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: interrupted.id })]),
      }),
    );
    expect(mocks.database).toHaveBeenCalledWith(
      environment.VOID_PLATFORM_DATABASE_URL,
      interrupted.id,
      interrupted.ownershipNonce,
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      interrupted,
      expect.anything(),
    );
  });

  it('asks to resume when an existing unfinished name is entered after choosing new', async () => {
    const interrupted = await interruptedInstall();
    mocks.select.mockResolvedValue('new');
    mocks.text.mockResolvedValueOnce('test-setup');
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Resume installation for test-setup Void (test-setup)?',
      initialValue: true,
    });
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      interrupted,
      expect.anything(),
    );
    expect(listInstallationManifests()).toEqual([interrupted]);
  });

  it('lets the user choose another name when they decline resuming the typed name', async () => {
    const previous = await interruptedInstall();
    mocks.select.mockResolvedValue('new');
    mocks.text.mockResolvedValueOnce('test-setup').mockResolvedValueOnce('fresh-install');
    mocks.confirm.mockResolvedValueOnce(false);
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--workers-dev', '--display-name', 'Fresh']),
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'fresh-install' }),
      null,
      expect.anything(),
    );
    expect(listInstallationManifests()).toEqual([previous]);
  });

  it('cancels the typed-name resume confirmation without planning or changing saved state', async () => {
    const previous = await interruptedInstall();
    mocks.select.mockResolvedValue('new');
    mocks.text.mockResolvedValueOnce('test-setup');
    mocks.confirm.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([previous]);
  });

  it('recognizes unfinished phases but excludes completed platforms and maintenance failures', async () => {
    const draft = await savedSetup();
    for (const status of [
      'planned',
      'provisioning',
      'waiting-for-dns',
      'waiting-for-oauth',
      'deploying',
      'verifying',
      'failed',
    ] as const) {
      expect(isPlatformInstallInProgress({ ...draft, status })).toBe(true);
    }
    for (const status of [
      'installed',
      'disabled',
      'disabling',
      'uninstalling',
      'uninstalled',
    ] as const) {
      expect(isPlatformInstallInProgress({ ...draft, status })).toBe(false);
    }
    expect(
      isPlatformInstallInProgress({
        ...draft,
        status: 'failed',
        runtime: { source: 'package', sourceRevision: null, manifestSha256: 'a'.repeat(64) },
      }),
    ).toBe(false);
    expect(
      isPlatformInstallInProgress({ ...draft, status: 'failed', desiredState: 'disabled' }),
    ).toBe(false);
  });

  it('does not offer to reinstall an already completed platform when its name is entered', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const draft = await savedSetup();
    writeInstallationManifest({ ...draft, status: 'installed' });
    vi.clearAllMocks();
    mocks.text.mockResolvedValueOnce('test-setup');
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan'])),
    ).rejects.toThrow('void platform status');
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(listSavedPlatformInstallPlans()).toHaveLength(1);
  });

  it('stops if the database says a selected installation completed elsewhere', async () => {
    const interrupted = await interruptedInstall();
    mocks.database.mockResolvedValueOnce({
      ...interrupted,
      status: 'installed',
      runtime: {
        source: 'package',
        sourceRevision: null,
        manifestSha256: 'a'.repeat(64),
      },
    });
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'no longer unfinished',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listInstallationManifests()[0]!.status).toBe('installed');
  });

  it('starts installation progress before the installer runs, updates it, and stops on success', async () => {
    const success = vi.spyOn(terminalOutput, 'printSuccess').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    mocks.install.mockImplementation(async (_plan, _secrets, manifest, dependencies) => {
      expect(mocks.progress.start).toHaveBeenCalledWith('Installing the platform');
      dependencies.onProgress('Preparing the platform database');
      return { manifest, waitingForDns: false, waitingForSandboxDrain: false };
    });
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.progress.message).toHaveBeenCalledWith('Preparing the platform database');
    expect(mocks.progress.stop).toHaveBeenCalledWith('Platform installed.');
    expect(mocks.progress.error).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith(
      'Test is installed at https://void-test-setup-api.account.workers.dev/admin.',
    );
    expect(info).toHaveBeenCalledWith('API URL: https://void-test-setup-api.account.workers.dev');
    // Spinner cancellation must not swallow the CLI's cancellation signal.
    const emit = vi.spyOn(process, 'emit').mockReturnValueOnce(true);
    mocks.spinner.mock.calls[0]![0].onCancel();
    expect(emit).toHaveBeenCalledWith('SIGINT');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('test exit');
    });
    emit.mockReturnValueOnce(false);
    expect(() => mocks.spinner.mock.calls[0]![0].onCancel()).toThrow('test exit');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('clears failed progress before printing recovery instructions', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    mocks.install.mockRejectedValueOnce(new Error('checkpoint failed'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'checkpoint failed',
    );
    expect(mocks.progress.error).toHaveBeenCalledWith('Platform installation failed.');
    expect(mocks.progress.stop).not.toHaveBeenCalled();
    const recoveryIndex = info.mock.calls.findIndex(([message]) =>
      message.startsWith('Continue with:'),
    );
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.progress.error.mock.invocationCallOrder[0]).toBeLessThan(
      info.mock.invocationCallOrder[recoveryIndex]!,
    );
  });

  it('names the database variable while a refused database can still be replaced', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const hint =
      'To use another PostgreSQL database, set VOID_PLATFORM_DATABASE_URL to its URL first.';
    const refused =
      'platform: This PostgreSQL database is already claimed by Void platform installation old-team.';
    mocks.install.mockImplementationOnce(async (_plan, _secrets, manifest) => {
      writePendingInstallationSecrets(manifest, {
        ...readPendingInstallationSecrets(manifest),
        databaseClaimState: 'failed',
      });
      throw new Error(refused);
    });
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(refused);
    expect(info).toHaveBeenCalledWith(hint);
    const manifest = listInstallationManifests()[0]!;
    const saved = readPendingInstallationSecrets(manifest)!.databaseUrl;

    // A resume reuses the saved URL without asking for it again.
    info.mockClear();
    mocks.password.mockClear();
    mocks.database.mockRejectedValueOnce(
      new Error(
        'platform: The PostgreSQL database ownership claim does not match this installation.',
      ),
    );
    const resume = parsePlatformArgs(['install', '--resume', '--name', manifest.id]);
    await expect(runPlatformLifecycleCommand(resume)).rejects.toThrow(
      'ownership claim does not match',
    );
    expect(mocks.database).toHaveBeenCalledWith(saved, manifest.id, manifest.ownershipNonce);
    expect(
      mocks.password.mock.calls.some(([input]) => input.message.startsWith('PostgreSQL')),
    ).toBe(false);
    expect(info).toHaveBeenCalledWith(hint);

    const replacement = 'postgres://user:password@replacement.example.com/platform';
    vi.stubEnv('VOID_PLATFORM_DATABASE_URL', replacement);
    mocks.database.mockResolvedValueOnce(null);
    await runPlatformLifecycleCommand(resume);
    expect(mocks.database).toHaveBeenLastCalledWith(
      replacement,
      manifest.id,
      manifest.ownershipNonce,
    );
    expect(mocks.install.mock.lastCall![1].databaseUrl).toBe(replacement);
  });

  it('keeps the database hint out of failures after the database is claimed', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const manifest = await interruptedInstall();
    mocks.database.mockResolvedValueOnce(null);
    mocks.install.mockRejectedValueOnce(new Error('Worker upload failed'));
    await expect(
      runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      ),
    ).rejects.toThrow('Worker upload failed');
    expect(info.mock.calls.some(([message]) => message.startsWith('Continue with:'))).toBe(true);
    expect(
      info.mock.calls.some(([message]) => message.includes('VOID_PLATFORM_DATABASE_URL')),
    ).toBe(false);
  });

  it('keeps the database hint out of failures after this run claims the database', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    mocks.install.mockImplementationOnce(async (_plan, secrets, manifest, dependencies) => {
      await dependencies.claimDatabase?.(secrets.databaseUrl, manifest.id, manifest.ownershipNonce);
      // Later checkpoints save the values without the claim state.
      writePendingInstallationSecrets(manifest, { databaseUrl: secrets.databaseUrl });
      throw new Error('App access token rejected');
    });
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'App access token rejected',
    );
    expect(info.mock.calls.some(([message]) => message.startsWith('Continue with:'))).toBe(true);
    expect(
      info.mock.calls.some(([message]) => message.includes('VOID_PLATFORM_DATABASE_URL')),
    ).toBe(false);
  });

  it.each(['void', 'void-dev'])(
    'includes a %s resume command without a duplicate recovery hint',
    async (command) => {
      const originalArgv = process.argv;
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      process.argv = [process.execPath, `/usr/local/bin/${command}`, ...args];
      try {
        mocks.install.mockImplementationOnce(async (plan, _secrets, manifest, dependencies) => {
          expect(dependencies.healthCheckResumeCommand).toBe(
            `${command} platform install --resume --name ${manifest.id}`,
          );
          throw new PlatformAccessBlockedError(plan.apiUrl, {
            accountName: plan.account.name,
            workers: [
              plan.deployment.resources.apiWorker,
              plan.deployment.resources.proxyWorker,
              plan.deployment.resources.dispatchWorker,
            ],
            resumeCommand: dependencies.healthCheckResumeCommand,
          });
        });
        await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
          `${command} platform install --resume --name test-setup-123456abcdef`,
        );
        expect(mocks.progress.error).toHaveBeenCalledWith('Platform installation failed.');
        expect(info.mock.calls.some(([message]) => message.startsWith('Continue with:'))).toBe(
          false,
        );
      } finally {
        process.argv = originalArgv;
      }
    },
  );

  it.each(['waitingForDns', 'waitingForSandboxDrain'] as const)(
    'stops progress when installation pauses for %s',
    async (reason) => {
      mocks.install.mockImplementation(async (_plan, _secrets, manifest) => ({
        manifest,
        waitingForDns: false,
        waitingForSandboxDrain: false,
        zoneNameServers: [],
        [reason]: true,
      }));
      await runPlatformLifecycleCommand(parsePlatformArgs(args));
      expect(mocks.progress.stop).toHaveBeenCalledWith('Installation paused. Progress is saved.');
      expect(mocks.progress.error).not.toHaveBeenCalled();
    },
  );

  it('explains the database input and generates identity keys without displaying values', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'PostgreSQL DATABASE_URL:',
        placeholder: 'postgresql://user:pw@…/database',
      }),
    );
    expect(mocks.text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Access Key ID:' }));
    expect(mocks.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Secret Access Key:' }),
    );
    const prompts = [...mocks.password.mock.calls, ...mocks.text.mock.calls].map(
      ([input]) => input.message,
    );
    expect(prompts).not.toContain('JWT signing key:');
    expect(prompts).not.toContain('Project encryption key:');
    const secrets = mocks.install.mock.calls[0]![1];
    expect(Buffer.byteLength(secrets.jwtSecret, 'utf8')).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(secrets.projectSecretKey, 'base64').toString('base64')).toBe(
      secrets.projectSecretKey,
    );
    expect(Buffer.from(secrets.projectSecretKey, 'base64')).toHaveLength(32);
    const saved = readPendingInstallationSecrets(listInstallationManifests()[0]!)!;
    expect(saved.jwtSecret).toBe(secrets.jwtSecret);
    expect(saved.projectSecretKey).toBe(secrets.projectSecretKey);
    const descriptions = stripVTControlCharacters(
      info.mock.calls.map(([message]) => message).join('\n'),
    );
    expect(descriptions).toContain(
      'https://void.cloud/guide/platform/installation/prerequisites#platform-database',
    );
    expect(descriptions).toContain(
      'Void generated the JWT signing key and project encryption key and keeps them in this machine’s encrypted recovery data.',
    );
    expect(descriptions).not.toContain('openssl rand');
    expect(descriptions).not.toContain(environment.VOID_PLATFORM_DATABASE_URL);
    expect(descriptions).not.toContain(secrets.jwtSecret);
    expect(descriptions).not.toContain(secrets.projectSecretKey);
  });
  it('asks for missing identity keys with guidance when resuming a started install', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const manifest = await interruptedInstall();
    for (const [key, value] of Object.entries(environment)) {
      if (key !== 'VOID_PLATFORM_JWT_SECRET' && key !== 'VOID_PLATFORM_PROJECT_SECRET_KEY') {
        vi.stubEnv(key, value);
      }
    }
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
    );
    expect(mocks.password.mock.calls.map(([input]) => input.message)).toEqual([
      'JWT signing key:',
      'Project encryption key:',
    ]);
    const descriptions = stripVTControlCharacters(
      info.mock.calls.map(([message]) => message).join('\n'),
    );
    expect(descriptions).toContain(
      'Create a JWT signing key for platform login tokens. Run openssl rand -base64 32',
    );
    expect(descriptions).toContain(
      'Generate a project encryption key for app secrets. Run openssl rand -base64 32 separately',
    );
    expect(descriptions).not.toContain('Void generated');
    expect(mocks.install.mock.calls[0]![1]).toMatchObject({
      jwtSecret: environment.VOID_PLATFORM_JWT_SECRET,
      projectSecretKey: environment.VOID_PLATFORM_PROJECT_SECRET_KEY,
    });
  });
  it('requires identity keys from the environment on a non-interactive install', async () => {
    for (const [key, value] of Object.entries(environment)) {
      if (key !== 'VOID_PLATFORM_JWT_SECRET' && key !== 'VOID_PLATFORM_PROJECT_SECRET_KEY') {
        vi.stubEnv(key, value);
      }
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--yes'])),
    ).rejects.toThrow('JWT signing key is required in non-interactive mode');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('replaces a revoked saved token during the same continued setup', async () => {
    const draft = await savedSetup();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    mocks.preflight.mockRejectedValueOnce(
      new Error('Preflight failed', {
        cause: new PlatformCloudflareApiError('Authentication error', 403),
      }),
    );
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Cloudflare rejected the saved runtime token. Create a replacement to continue setup.',
    );
    expect(
      mocks.password.mock.calls.filter(([input]) => input.message === 'Paste runtime API token:'),
    ).toHaveLength(1);
    expect(new URL(mocks.open.mock.calls[0]![0]).searchParams.get('to')).toBe(
      '/account/api-tokens',
    );
    expect(mocks.install).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudflareApiToken: environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN,
      }),
      expect.objectContaining({ id: draft.id }),
      expect.anything(),
    );
  });

  it('does not retain a rejected cached token if replacement input is cancelled', async () => {
    const draft = await savedSetup();
    mocks.preflight.mockRejectedValueOnce(
      new PlatformCloudflareApiError('Authentication error', 401),
    );
    mocks.password.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBeUndefined();
    expect(mocks.preflight).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('preserves saved credentials and stops on service failures instead of opening replacement pages', async () => {
    const draft = await savedSetup();
    mocks.preflight.mockRejectedValueOnce(
      new PlatformCloudflareApiError('service unavailable', 503),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'service unavailable',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not blame the runtime token when operator authentication fails during AI Gateway replanning', async () => {
    const draft = await savedSetup();
    const original = mocks.plan.getMockImplementation()!;
    mocks.plan
      .mockImplementationOnce(async (...args) => ({
        ...(await original(...args)),
        actions: [
          {
            action: 'inspect',
            id: null,
            key: 'ai-gateway',
            kind: 'ai-gateway',
            name: 'gateway',
            reason: 'Needs runtime-token check.',
          },
        ],
      }))
      .mockRejectedValueOnce(
        new PlatformCloudflareApiError('Operator session expired', 403, '/accounts'),
      );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Operator session expired',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('does not replace an explicit environment token or clear a different saved token', async () => {
    const draft = await savedSetup();
    vi.stubEnv('VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN', 'environment-token');
    mocks.preflight.mockRejectedValueOnce(
      new PlatformCloudflareApiError('Authentication error', 403),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Authentication error',
    );
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps a saved token that lacks an email permission and asks for no replacement', async () => {
    const draft = await savedSetup();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    mocks.preflight.mockImplementationOnce(async (_client, input: { accountId: string }) =>
      verifyPlatformRuntimeTokenEmailPermissions(
        new PlatformCloudflareClient('saved-runtime-token', {
          fetcher: async (request) =>
            new URL(String(request)).pathname.endsWith('/email/routing/addresses')
              ? Response.json(
                  { success: false, errors: [{ message: 'upstream echoed saved-runtime-token' }] },
                  { status: 403 },
                )
              : Response.json({ success: true, result: {} }),
        }),
        { accountId: input.accountId, zoneId: 'mail-zone' },
      ),
    );

    const failure = await runPlatformLifecycleCommand(parsePlatformArgs(['install'])).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain(
      'Cloudflare denied: Account → Email Routing Addresses → Edit (HTTP 403)',
    );
    expect(failure?.message).toContain('The token value stays the same');
    expect(failure?.message).not.toContain('saved-runtime-token');
    expect(failure?.message).not.toContain('upstream echoed');
    expect(readPendingInstallationSecrets(draft)?.cloudflareApiToken).toBe('saved-runtime-token');
    expect(warn).not.toHaveBeenCalledWith(
      'Cloudflare rejected the saved runtime token. Create a replacement to continue setup.',
    );
    expect(mocks.preflight).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('offers a named saved setup and a fresh installation instead of automatically continuing', async () => {
    const draft = await savedSetup();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Continue a previous platform install?',
      options: [
        {
          value: draft.id,
          label: 'Continue setup for test-setup Void (test-setup)',
          hint: 'Account',
        },
        { value: 'new', label: 'Start a new platform install' },
      ],
    });
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'test-setup' }),
      draft,
      expect.anything(),
    );
  });

  it.each([false, true])(
    'starts fresh without reusing saved credentials, including with --name: %s',
    async (named) => {
      const previous = await savedSetup();
      mocks.select.mockResolvedValue('new');
      mocks.text.mockResolvedValue('fresh-install');
      mocks.password.mockResolvedValueOnce(Symbol('cancel'));
      await expect(
        runPlatformLifecycleCommand(
          parsePlatformArgs([
            'install',
            '--workers-dev',
            '--account',
            'account',
            '--display-name',
            'Fresh',
            ...(named ? ['--name', 'test-setup'] : []),
          ]),
        ),
      ).rejects.toThrow('Cancelled');
      const manifests = listInstallationManifests();
      expect(manifests).toHaveLength(2);
      expect(readPendingInstallationSecrets(previous)).toEqual({
        cloudflareApiToken: 'saved-runtime-token',
      });
      const fresh = manifests.find(
        (manifest) => manifest.deployment.installationSlug === 'fresh-install',
      )!;
      expect(readPendingInstallationSecrets(fresh)).toEqual({});
      expect(mocks.password).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Paste runtime API token:' }),
      );
      expect(mocks.preflight).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
      const namePrompt = mocks.text.mock.calls.find(
        ([prompt]) => prompt.message === 'Installation name:',
      )![0];
      expect(namePrompt.validate('test-setup')).toBeUndefined();
    },
  );

  it('lets the user select among multiple saved setups', async () => {
    const first = await savedSetup('first');
    const second = await savedSetup('second');
    mocks.select.mockResolvedValue(second.id);
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    const choices = mocks.select.mock.calls[0]![0].options;
    expect(choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: first.id,
          label: 'Continue setup for first Void (first)',
        }),
        expect.objectContaining({
          value: second.id,
          label: 'Continue setup for second Void (second)',
        }),
        { value: 'new', label: 'Start a new platform install' },
      ]),
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'second' }),
      second,
      expect.anything(),
    );
  });

  it('cancels before planning or collecting credentials when the chooser is cancelled', async () => {
    const draft = await savedSetup();
    mocks.select.mockResolvedValue(Symbol('cancel'));
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(readPendingInstallationSecrets(draft)).toEqual({
      cloudflareApiToken: 'saved-runtime-token',
    });
  });

  it('honors explicit --resume without asking and never auto-resumes in CI', async () => {
    const draft = await savedSetup();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--yes'])),
    ).rejects.toThrow('--resume');
    expect(mocks.plan).not.toHaveBeenCalled();
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--resume', '--name', draft.id, '--plan']),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'test-setup' }),
      draft,
      expect.anything(),
    );
  });

  it('does not silently adopt a selected draft that advanced while the chooser was open', async () => {
    const draft = await savedSetup();
    mocks.select.mockImplementation(async () => {
      completePlatformSetupDraft(draft);
      return draft.id;
    });
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Setup advanced in another process',
    );
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('keeps real resource names and the callback stable from preview through install and resume', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const actual = await vi.importActual<typeof import('../../src/cli/platform-plan.ts')>(
      '../../src/cli/platform-plan.ts',
    );
    mocks.plan.mockImplementation(actual.createPlatformInstallPlan);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkersSubdomain').mockResolvedValue(
      'void-platform-e2e-test',
    );
    for (const method of [
      'listAiGateways',
      'listKvNamespaces',
      'listR2Buckets',
      'listQueues',
      'listDispatchNamespaces',
      'listHyperdriveConfigs',
      'listWorkerNames',
    ] as const) {
      vi.spyOn(PlatformCloudflareClient.prototype, method).mockResolvedValue([]);
    }
    const normalText = mocks.text.getMockImplementation()!;
    mocks.text.mockImplementation(async (input) =>
      input.message === 'Installation name:'
        ? 'void-e2e'
        : input.message === 'Platform display name:'
          ? 'void-e2e Void'
          : normalText(input),
    );
    const normalPassword = mocks.password.getMockImplementation()!;
    mocks.password.mockImplementation(async (input) =>
      input.message.startsWith('GitHub OAuth') ? Symbol('cancel') : normalPassword(input),
    );
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    const preview = await mocks.plan.mock.results[0]!.value;
    expect(mocks.open).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(['install']))).rejects.toThrow(
      'Cancelled',
    );
    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Where do you want to host the Void Platform API? Leave empty for a workers.dev fallback.',
      }),
    );
    const draft = listInstallationManifests()[0]!;
    expect(draft.deployment.installationSlug).toBe('void-e2e');
    expect(draft.deployment.resources.apiWorker).toBe('void-void-e2e-api');
    expect(draft.deployment.resources).toEqual(preview.deployment.resources);
    expect(isPlatformSetupDraft(draft)).toBe(true);
    const callback = `https://${draft.deployment.resources.apiWorker}.void-platform-e2e-test.workers.dev/auth/callback`;
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Redirect URI: ' + callback));
    mocks.password.mockImplementation(normalPassword);
    mocks.open.mockClear();
    info.mockClear();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Redirect URI: ' + callback));
    const final = listInstallationManifests()[0]!;
    expect(final.id).toBe(draft.id);
    expect(final.deployment.resources).toEqual(draft.deployment.resources);
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(isPlatformSetupDraft(final)).toBe(false);
  });

  it('stops an interactive install at an existing resource without retrying or opening setup', async () => {
    const actual = await vi.importActual<typeof import('../../src/cli/platform-plan.ts')>(
      '../../src/cli/platform-plan.ts',
    );
    mocks.plan.mockImplementation(actual.createPlatformInstallPlan);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkersSubdomain').mockResolvedValue(
      'account',
    );
    for (const method of [
      'listAiGateways',
      'listKvNamespaces',
      'listR2Buckets',
      'listQueues',
      'listDispatchNamespaces',
      'listHyperdriveConfigs',
    ] as const) {
      vi.spyOn(PlatformCloudflareClient.prototype, method).mockResolvedValue([]);
    }
    vi.spyOn(PlatformCloudflareClient.prototype, 'listWorkerNames').mockResolvedValue([
      'void-test-setup-api',
    ]);
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'Resume the owning installation, or choose another installation name.',
    );
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
  });

  it('saves plan choices without Cloudflare changes, credentials, or browser launches', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(listInstallationManifests()).toEqual([]);
    expect(listSavedPlatformInstallPlans()).toEqual([
      expect.objectContaining({
        accountName: 'Account',
        args: expect.objectContaining({ name: 'test-setup', account: 'account', workersDev: true }),
      }),
    ]);
    expect(readdirSync(directory)).toHaveLength(1);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.spinner).not.toHaveBeenCalled();
  });
  it('continues from the printed command without repeating nonsecret choices', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const output = stripVTControlCharacters(vi.mocked(console.log).mock.calls.flat().join('\n'));
    const command = output
      .split('\n')
      .find((line) => /^void(?:-dev)? platform install /.test(line))!;
    expect(command).toContain('--no-control-plane-domain');
    expect(command).toContain('--hyperdrive create');
    expect(command).toContain('--login-methods github --no-access-protection');
    expect(listInstallationManifests()).toEqual([]);
    expect(mocks.password).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(parsePlatformArgs(command.split(' ').slice(2)));
    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(
      mocks.text.mock.calls.some(([input]) =>
        input.message.startsWith('Where do you want to host the Void Platform API?'),
      ),
    ).toBe(false);
    expect(mocks.password).toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
  });
  it('offers a saved preview on a bare invocation and replans before installation', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const saved = listSavedPlatformInstallPlans()[0]!;
    const firstInput = mocks.plan.mock.calls[0]![1];
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }

    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));

    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: [
          {
            value: `plan:${saved.id}`,
            label: 'Use saved plan for Test (test-setup)',
            hint: 'Account · workers.dev',
          },
          { value: 'new', label: 'Start a new platform install' },
        ],
      }),
    );
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(expect.anything(), firstInput, null, expect.anything());
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Apply this plan?',
      initialValue: true,
    });
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(listSavedPlatformInstallPlans()).toEqual([]);
    expect(listInstallationManifests()).toHaveLength(1);
  });
  it('never carries --yes from a saved plan and retains choices when applying is declined', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--yes', '--plan']));
    expect(listSavedPlatformInstallPlans()[0]?.args.yes).toBe(false);
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValueOnce(false);
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Apply this plan?',
      initialValue: true,
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listSavedPlatformInstallPlans()).toHaveLength(1);
    expect(listInstallationManifests()).toEqual([]);
  });
  it('can refresh a saved preview without prompting for its choices or applying it', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const firstInput = mocks.plan.mock.calls[0]![1];
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.plan).toHaveBeenCalledWith(expect.anything(), firstInput, null, expect.anything());
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(listSavedPlatformInstallPlans()).toHaveLength(1);
  });
  it('offers started setup instead of a stale preview for the same platform', async () => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--plan']));
    const draft = await savedSetup();
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--plan']));
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          {
            value: draft.id,
            label: `Continue setup for ${draft.deployment.displayName} (test-setup)`,
            hint: 'Account',
          },
          { value: 'new', label: 'Start a new platform install' },
        ],
      }),
    );
  });
  it('does not save a draft or open pages when the plan is declined', async () => {
    mocks.confirm.mockResolvedValue(false);
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(listInstallationManifests()).toEqual([]);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.spinner).not.toHaveBeenCalled();
    expect(listSavedPlatformInstallPlans()).toHaveLength(1);
  });
  it('opens each missing credential page and preserves encrypted progress and callback identity across cancellation', async () => {
    const normalPassword = mocks.password.getMockImplementation()!;
    mocks.password.mockImplementation(async (input) =>
      input.message.startsWith('GitHub OAuth') ? Symbol('cancel') : normalPassword(input),
    );
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow('Cancelled');
    const first = listInstallationManifests()[0]!;
    expect(isPlatformSetupDraft(first)).toBe(true);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    const saved = readPendingInstallationSecrets(first)!;
    expect(saved.cloudflareApiToken).toBe(environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN);
    expect(saved.githubClientId).toBeUndefined();
    const serialized = readdirSync(directory, { recursive: true })
      .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.enc'))
      .map((entry) => readFileSync(join(directory, entry), 'utf8'))
      .join('');
    expect(serialized).not.toContain(environment.VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN);
    const initialApi = mocks.plan.mock.results[0]!.value;
    mocks.password.mockImplementation(normalPassword);
    mocks.open.mockClear();
    // A bare invocation resumes only after selecting the named saved setup.
    await runPlatformLifecycleCommand(parsePlatformArgs(['install']));
    const final = listInstallationManifests()[0]!;
    expect(final.deployment.resources).toEqual(first.deployment.resources);
    expect(final.id).toBe(first.id);
    expect(isPlatformSetupDraft(final)).toBe(false);
    expect((await initialApi).apiUrl).toBe((await mocks.plan.mock.results.at(-1)!.value).apiUrl);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(
      mocks.open.mock.calls.map((call) => {
        const url = new URL(String(call[0]));
        return url.searchParams.get('to') ?? url.href;
      }),
    ).toEqual(['https://github.com/settings/applications/new', '/account/r2/api-tokens/create']);
    expect(JSON.stringify(mocks.open.mock.calls)).not.toContain('secret-value');
  });
  it('skips browsers and secret prompts for values supplied through the environment', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.password).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(info.mock.calls.map(([message]) => message).join('\n')).not.toContain('openssl rand');
  });
  it('checks runtime-token email access only when platform email is on', async () => {
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv('VOID_EMAIL_SHARED_ZONE_ID', '');
    vi.stubEnv('VOID_EMAIL_SENDER_DOMAIN', '');
    await runPlatformLifecycleCommand(parsePlatformArgs(args));
    expect(mocks.preflight.mock.calls[0]![1]).not.toHaveProperty('emailZoneId');

    vi.stubEnv('VOID_EMAIL_SHARED_ZONE_ID', 'mail-zone');
    vi.stubEnv('VOID_EMAIL_SENDER_DOMAIN', 'mail.example.com');
    const emailArgs = args.map((value) => (value === 'test-setup' ? 'email-setup' : value));
    await runPlatformLifecycleCommand(parsePlatformArgs(emailArgs));

    expect(mocks.preflight).toHaveBeenCalledTimes(2);
    expect(mocks.preflight.mock.calls[1]![1]).toMatchObject({ emailZoneId: 'mail-zone' });
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.preflight.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[1]!,
    );
  });
  it('checkpoints a generated email key before leaving the setup draft', async () => {
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv('VOID_EMAIL_SHARED_ZONE_ID', 'mail-zone');
    vi.stubEnv('VOID_EMAIL_SENDER_DOMAIN', 'mail.example.com');

    await runPlatformLifecycleCommand(parsePlatformArgs(args));

    const manifest = listInstallationManifests()[0]!;
    const saved = readPendingInstallationSecrets(manifest)!;
    const installSecrets = mocks.install.mock.calls[0]![1];
    expect(isPlatformSetupDraft(manifest)).toBe(false);
    expect(saved.emailSigningSecret).toBe(installSecrets.emailSigningSecret);
    expect(Buffer.byteLength(saved.emailSigningSecret, 'utf8')).toBeGreaterThanOrEqual(32);
    expect(saved.emailSigningSecret).not.toBe(environment.VOID_PLATFORM_JWT_SECRET);
  });
  it('does not persist an invalid signing key or begin provisioning', async () => {
    vi.stubEnv('VOID_PLATFORM_JWT_SECRET', 'short');
    await expect(runPlatformLifecycleCommand(parsePlatformArgs(args))).rejects.toThrow(
      'at least 32 bytes',
    );
    const draft = listInstallationManifests()[0]!;
    expect(isPlatformSetupDraft(draft)).toBe(true);
    expect(readPendingInstallationSecrets(draft)?.jwtSecret).toBeUndefined();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  const withApiWorker = (action: 'create' | 'update') => {
    const original = mocks.plan.getMockImplementation()!;
    mocks.plan.mockImplementation(async (...input: Parameters<typeof original>) => {
      const plan = await original(...input);
      return {
        ...plan,
        actions: [
          {
            action,
            id: null,
            key: 'api-worker',
            kind: 'worker',
            name: plan.deployment.resources.apiWorker,
            reason: 'installer Worker',
          },
        ],
      };
    });
  };
  it('stops a resumed install before the installer when its Worker was changed outside Void', async () => {
    const manifest = await interruptedInstall();
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    withApiWorker('update');
    const source = vi
      .spyOn(PlatformCloudflareClient.prototype, 'getWorkerLastDeployedFrom')
      .mockResolvedValue('api');
    // The deploy needs one active version, so the check reads the deployments.
    const request = vi
      .spyOn(PlatformCloudflareClient.prototype, 'request')
      .mockImplementation(async (path: string) => {
        if (path.endsWith(`/${manifest.deployment.resources.apiWorker}/deployments`)) {
          return {
            deployments: [
              {
                id: 'deployment',
                created_on: '2026-10-15T00:00:00.000Z',
                versions: [{ version_id: '11111111-1111-4111-8111-111111111111', percentage: 100 }],
              },
            ],
          };
        }
        throw new Error(`unexpected read ${path}`);
      });

    await expect(
      runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id, '--yes']),
      ),
    ).rejects.toThrow(
      new RegExp(
        `No platform Worker changed\\. This command did not pause application traffic\\.[\\s\\S]*platform install --resume --name ${manifest.id}$`,
      ),
    );
    expect(source).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('uploads a resumed install’s Worker changed outside Void when the installer asks', async () => {
    const manifest = await interruptedInstall();
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    withApiWorker('update');
    const apiWorker = manifest.deployment.resources.apiWorker;
    const createdCacheId = 'isr-cache-created-in-run';
    const marker = 'owned-by-this-installation';
    const version = '11111111-1111-4111-8111-111111111111';
    const source = vi
      .spyOn(PlatformCloudflareClient.prototype, 'getWorkerLastDeployedFrom')
      .mockResolvedValueOnce('dash')
      .mockResolvedValue('cf_cli');
    vi.spyOn(PlatformCloudflareClient.prototype, 'request').mockImplementation(
      async (path: string) => {
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
        throw new Error(`unexpected read ${path}`);
      },
    );
    const events: Array<string> = [];
    const uploaded: Array<string> = [];
    mocks.cfRunner.mockImplementation(async (operation: { configPath: string }) => {
      events.push('review-upload');
      uploaded.push(readFileSync(operation.configPath, 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    });
    mocks.progress.pause.mockImplementation(() => events.push('progress-pause'));
    mocks.progress.resume.mockImplementation(() => events.push('progress-resume'));
    // Like the installer: it creates a resource, uploads the Workers changed
    // outside Void with the configs that the run deploys, then pauses traffic.
    mocks.install.mockImplementation(async (_plan, _secrets, existing, dependencies) => {
      events.push('installer-start', 'create:isr-cache-kv');
      await dependencies.uploadOutsideChanges([
        {
          account_id: 'account',
          compatibility_date: '2026-09-30',
          kv_namespaces: [{ binding: 'ISR_CACHE', id: createdCacheId }],
          main: join(directory, 'api.js'),
          name: apiWorker,
          vars: { PLATFORM_OWNERSHIP_MARKER: marker },
        },
      ]);
      events.push('traffic-paused');
      return { manifest: existing, waitingForDns: false, waitingForSandboxDrain: false };
    });
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      );
    } finally {
      if (stdout) {
        Object.defineProperty(process.stdout, 'isTTY', stdout);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }

    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Replace the configuration of these Workers?',
      initialValue: false,
    });
    expect(events).toEqual([
      'installer-start',
      'create:isr-cache-kv',
      'progress-pause',
      'review-upload',
      'progress-resume',
      'traffic-paused',
    ]);
    expect(mocks.cfRunner.mock.calls[0]![0]).toMatchObject({
      type: 'versions.upload',
      interactive: true,
    });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toContain(createdCacheId);
    expect(JSON.stringify(manifest.resources)).not.toContain(createdCacheId);
    expect(source).toHaveBeenCalledTimes(2);
    expect(mocks.install.mock.calls[0]![3]).toMatchObject({
      replaceOutsideChanges: [apiWorker],
    });
  });
  it('replaces a resumed install’s active version that Void did not deploy without a review upload', async () => {
    const manifest = await interruptedInstall();
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    withApiWorker('update');
    const apiWorker = manifest.deployment.resources.apiWorker;
    const version = '11111111-1111-4111-8111-111111111111';
    // An earlier run stopped after the Cloudflare CLI replaced the change, so
    // the marker shows the Cloudflare CLI. The active version has no Void record.
    vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkerLastDeployedFrom').mockResolvedValue(
      'cf_cli',
    );
    vi.spyOn(PlatformCloudflareClient.prototype, 'request').mockImplementation(
      async (path: string) => {
        if (path.endsWith(`/${apiWorker}/deployments`)) {
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
        if (path.endsWith(`/${apiWorker}/versions/${version}`)) {
          return { annotations: { 'workers/triggered_by': 'upload' } };
        }
        throw new Error(`unexpected read ${path}`);
      },
    );
    mocks.install.mockImplementation(async (_plan, _secrets, existing, dependencies) => {
      await dependencies.uploadOutsideChanges([{ account_id: 'account', name: apiWorker }]);
      return { manifest: existing, waitingForDns: false, waitingForSandboxDrain: false };
    });
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id]),
      );
    } finally {
      if (stdout) {
        Object.defineProperty(process.stdout, 'isTTY', stdout);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }

    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Replace the configuration of these Workers?',
      initialValue: false,
    });
    expect(mocks.cfRunner).not.toHaveBeenCalled();
    expect(mocks.progress.pause).not.toHaveBeenCalled();
    expect(mocks.install.mock.calls[0]![3]).toMatchObject({
      replaceOutsideChanges: [apiWorker],
    });
  });
  it('stops a resumed install that restores an earlier version without a Void record', async () => {
    const manifest = await interruptedInstall();
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    withApiWorker('update');
    const apiWorker = manifest.deployment.resources.apiWorker;
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
    // An earlier run agreed to replace a change made outside Void, made
    // Void's version active and stopped before the cutover finished. The
    // installer first restores the earlier version.
    writeInstallationManifest(
      recordWorkerCutoverStage(
        manifest,
        1,
        'api',
        earlierVersion,
        voidVersion,
        apiWorker,
        triggers,
        new Date().toISOString(),
      ),
    );
    vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkerLastDeployedFrom').mockResolvedValue(
      'cf_cli',
    );
    const request = vi
      .spyOn(PlatformCloudflareClient.prototype, 'request')
      .mockImplementation(async (path: string) => {
        if (path.endsWith(`/${apiWorker}/deployments`)) {
          return {
            deployments: [
              {
                id: 'deployment',
                created_on: '2026-10-15T00:00:00.000Z',
                versions: [{ version_id: voidVersion, percentage: 100 }],
              },
            ],
          };
        }
        if (path.endsWith(`/${apiWorker}/versions/${voidVersion}`)) {
          return {
            annotations: { 'workers/message': encodeCloudflareVersionMessage([], triggers) },
          };
        }
        if (path.endsWith(`/${apiWorker}/versions/${earlierVersion}`)) {
          return { annotations: {} };
        }
        throw new Error(`unexpected read ${path}`);
      });

    await expect(
      runPlatformLifecycleCommand(
        parsePlatformArgs(['install', '--resume', '--name', manifest.id, '--yes']),
      ),
    ).rejects.toThrow(`${apiWorker}: has an active version without a Void deployment record\n`);
    expect(request).toHaveBeenCalledWith(
      `/accounts/${manifest.account.id}/workers/scripts/${apiWorker}/versions/${earlierVersion}`,
    );
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('reads no Worker that a fresh install creates', async () => {
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    withApiWorker('create');
    const source = vi.spyOn(PlatformCloudflareClient.prototype, 'getWorkerLastDeployedFrom');

    await runPlatformLifecycleCommand(parsePlatformArgs(args));

    expect(source).not.toHaveBeenCalled();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.install.mock.calls[0]![3]).not.toHaveProperty('replaceOutsideChanges');
  });
});
