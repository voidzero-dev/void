import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createPlatformDeploymentManifest } from '@void/platform';
import { CANCEL_SYMBOL, intro } from '@voidzero-dev/vite-plus-prompts';
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { loadPlatformRuntime } from '../../src/cli/platform-installer.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';
import { listSavedPlatformInstallPlans } from '../../src/cli/platform-saved-plans.ts';

type Prompts = typeof import('@voidzero-dev/vite-plus-prompts');

const mocks = vi.hoisted(() => ({
  confirm: vi.fn<Prompts['confirm']>(),
  multiselect: vi.fn(),
  note: vi.fn<Prompts['note']>(),
  select: vi.fn<typeof import('@voidzero-dev/vite-plus-prompts').select<string>>(),
  text: vi.fn<Prompts['text']>(),
  plan: vi.fn(),
}));

function notesWithoutColors(): Array<[string, string]> {
  return mocks.note.mock.calls.map(([message, title]) => {
    assert(typeof message === 'string' && typeof title === 'string');
    return [stripVTControlCharacters(message), stripVTControlCharacters(title)];
  });
}
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  // These fixtures retain GitHub-only setup; Access choices have their own matrix.
  confirm: (input: { message: string }) =>
    input.message === 'Also protect the platform UI and APIs with Cloudflare Access?'
      ? Promise.resolve(false)
      : mocks.confirm(input),
  multiselect: mocks.multiselect,
  select: (input: Parameters<typeof mocks.select>[0]) =>
    input.message === 'Who should be able to access deployed apps?'
      ? Promise.resolve('public')
      : mocks.select(input),
  text: mocks.text,
  intro: vi.fn(),
  note: mocks.note,
  outro: vi.fn(),
}));
vi.mock('../../src/cli/platform-auth.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-auth.ts')>()),
  resolvePlatformCloudflareCredential: async () => ({ source: 'oauth', token: 'test-token' }),
  resolvePlatformCloudflareCredentialWithInput: async (input: () => Promise<unknown>) => ({
    input: await input(),
    credential: { source: 'oauth', token: 'test-token' },
  }),
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
}));
vi.mock('../../src/cli/platform-registry.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-registry.ts')>()),
  assertPlatformInstallationSlugAvailable: vi.fn(),
  listInstallationManifests: () => [],
}));
vi.mock('../../src/cli/platform-plan.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-plan.ts')>()),
  createPlatformInstallPlan: mocks.plan,
}));

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let directory: string;
const args = [
  'install',
  '--plan',
  '--name',
  'test',
  '--display-name',
  'Test',
  '--account',
  'account',
];

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'void-install-prompts-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
  mocks.multiselect.mockResolvedValue(['github']);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PlatformCloudflareClient.prototype, 'listAccounts').mockResolvedValue([
    { id: 'account', name: 'Account' },
  ]);
  vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([]);
  mocks.text.mockImplementation(async ({ defaultValue }) => defaultValue ?? '');
  mocks.select.mockImplementation(async ({ message, options }) =>
    message === 'How should Void set up Hyperdrive?' ||
    message === 'Which Hyperdrive should Void use?'
      ? options[0].value
      : 'workers-dev',
  );
  mocks.confirm.mockResolvedValue(false);
  mocks.plan.mockResolvedValue({
    account: { id: 'account', name: 'Account' },
    actions: [],
    apiUrl: 'https://api.test.workers.dev',
    proxyUrl: 'https://proxy.test.workers.dev',
    deployment: createPlatformDeploymentManifest({
      installationSlug: 'test',
      displayName: 'Test',
      application: { baseDomain: 'example.com', zoneName: 'example.com' },
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
  if (ttyDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
});

describe('interactive platform installation prompts', () => {
  it('uses the selected Hyperdrive without a second confirmation', async () => {
    mocks.multiselect.mockResolvedValueOnce(['google', 'oidc']);
    vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([
      { id: 'other-id', name: 'another-database' },
      { id: 'terraform-id', name: 'company-managed-postgres' },
    ]);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue({
      id: 'terraform-id',
      name: 'company-managed-postgres',
      origin: {
        database: 'void_platform',
        host: 'hyperdrive-productiondb.databases.cfdata.org/itdb/primary',
        accessClientId: 'tunnel-client-id',
        port: null,
        scheme: 'postgresql',
        user: 'hyperdrive_void_platform_service',
      },
      cachingDisabled: true,
    });
    mocks.select.mockImplementation(async ({ message }) =>
      message === 'How should Void set up Hyperdrive?'
        ? 'existing'
        : message === 'Which Hyperdrive should Void use?'
          ? 'terraform-id'
          : 'workers-dev',
    );
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(intro).not.toHaveBeenCalled();

    expect(notesWithoutColors()).toContainEqual([
      expect.stringContaining('Port: configured by Cloudflare Tunnel'),
      'Existing Hyperdrive company-managed-postgres',
    ]);
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'How should Void set up Hyperdrive?',
      options: [
        { value: 'existing', label: 'Use an existing Hyperdrive' },
        { value: 'create', label: 'Let Void create Hyperdrive', hint: 'recommended' },
        { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
      ],
    });
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Which Hyperdrive should Void use?',
      options: [
        { value: 'other-id', label: 'another-database', hint: 'other-id' },
        { value: 'terraform-id', label: 'company-managed-postgres', hint: 'terraform-id' },
      ],
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Platform login methods (select all that apply):',
        initialValues: [],
        required: true,
      }),
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authentication: { providers: ['google', 'oidc'], configurable: true },
        externalHyperdrive: {
          id: 'terraform-id',
          name: 'company-managed-postgres',
          database: 'void_platform',
          host: 'hyperdrive-productiondb.databases.cfdata.org/itdb/primary',
          user: 'hyperdrive_void_platform_service',
        },
      }),
      null,
      expect.anything(),
    );
    vi.clearAllMocks();
    await runPlatformLifecycleCommand(
      parsePlatformArgs([
        ...args,
        '--workers-dev',
        '--no-control-plane-domain',
        '--hyperdrive',
        'terraform-id',
        '--login-methods',
        'github',
        '--no-access-protection',
      ]),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(notesWithoutColors()).not.toContainEqual([
      expect.any(String),
      'Existing Hyperdrive company-managed-postgres',
    ]);
    expect(PlatformCloudflareClient.prototype.getHyperdriveConfig).toHaveBeenCalledWith(
      'account',
      'terraform-id',
    );
    expect(mocks.plan.mock.calls[0][1].externalHyperdrive.id).toBe('terraform-id');
  });

  it('keeps the environment override for unattended installation', async () => {
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', 'terraform-id');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST', 'db.example.com');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', 'runtime_user');

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(PlatformCloudflareClient.prototype.listHyperdriveConfigs).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalHyperdrive: {
          id: 'terraform-id',
          host: 'db.example.com',
          user: 'runtime_user',
        },
      }),
      null,
      expect.anything(),
    );
  });

  it.each([
    { origin: { serviceId: 'f537187c-73f7-4ad8-bcb6-38e3e3ac1178' } },
    { origin: { user: 'different_user' } },
    { origin: { database: 'different_database' } },
    { name: 'renamed-postgres' },
  ])('rejects Workers VPC selection drift on saved-plan replay: %j', async (drift) => {
    const serviceId = 'f537187c-73f7-4ad8-bcb6-38e3e3ac1177';
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', 'terraform-id');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_SERVICE_ID', serviceId);
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', 'runtime_user');
    vi.stubEnv('VOID_PLATFORM_DATABASE_URL', 'postgresql://iam_owner@127.0.0.1/void_platform');
    const live = {
      id: 'terraform-id',
      name: 'company-managed-postgres',
      cachingDisabled: true,
      origin: {
        database: 'void_platform',
        scheme: 'postgresql' as const,
        serviceId,
        user: 'runtime_user',
      },
    };
    const getConfig = vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig');
    const changed = {
      ...live,
      name: drift.name ?? live.name,
      origin: { ...live.origin, ...drift.origin },
    };
    getConfig.mockResolvedValueOnce(live).mockResolvedValueOnce(changed);

    const command = parsePlatformArgs([...args, '--workers-dev']);
    await runPlatformLifecycleCommand(command);
    const saved = listSavedPlatformInstallPlans()[0];
    expect(saved.args.hyperdrive).toBe(live.id);
    expect(saved.externalHyperdrive).toEqual({
      id: live.id,
      name: live.name,
      database: live.origin.database,
      serviceId,
      user: live.origin.user,
    });
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', undefined);
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_SERVICE_ID', undefined);
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', undefined);
    vi.mocked(PlatformCloudflareClient.prototype.listHyperdriveConfigs).mockResolvedValue([
      { id: changed.id, name: changed.name },
    ]);
    await expect(runPlatformLifecycleCommand({ ...saved.args, yes: true })).rejects.toThrow(
      'expected database origin',
    );
    expect(mocks.plan).toHaveBeenCalledTimes(1);
  });

  it('selects a Workers VPC Hyperdrive by configuration ID', async () => {
    const origin = {
      serviceId: 'f537187c-73f7-4ad8-bcb6-38e3e3ac1177',
      database: 'platform',
      scheme: 'postgresql' as const,
      user: 'runtime',
    };
    const live = { id: 'terraform-id', name: 'managed-postgres', origin, cachingDisabled: true };
    vi.mocked(PlatformCloudflareClient.prototype.listHyperdriveConfigs).mockResolvedValue([
      { id: live.id, name: live.name },
    ]);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue(live);
    await runPlatformLifecycleCommand(
      parsePlatformArgs([...args, '--workers-dev', '--hyperdrive', live.id]),
    );
    expect(mocks.plan.mock.calls[0]?.[1].externalHyperdrive).toMatchObject({
      id: live.id,
      serviceId: origin.serviceId,
      user: origin.user,
    });
  });

  it('uses the new Hyperdrive selection after declining a saved plan', async () => {
    const live = {
      id: 'terraform-id',
      name: 'managed-postgres',
      cachingDisabled: true,
      origin: {
        database: 'platform',
        scheme: 'postgresql' as const,
        serviceId: 'f537187c-73f7-4ad8-bcb6-38e3e3ac1177',
        user: 'runtime',
      },
    };
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', live.id);
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_SERVICE_ID', live.origin.serviceId);
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', live.origin.user);
    const getConfig = vi
      .spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig')
      .mockResolvedValueOnce(live);
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    const currentUser = 'replacement_runtime';
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', currentUser);
    getConfig.mockResolvedValueOnce({ ...live, origin: { ...live.origin, user: currentUser } });
    mocks.select.mockResolvedValueOnce('new').mockResolvedValueOnce('workers-dev');
    mocks.text.mockResolvedValueOnce('test');

    await runPlatformLifecycleCommand(parsePlatformArgs(['install', '--account', 'account']));
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Continue a previous platform install?',
        options: expect.arrayContaining([
          expect.objectContaining({ label: 'Start a new platform install' }),
        ]),
      }),
    );
    expect(listSavedPlatformInstallPlans()).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ name: 'test', hyperdrive: live.id }),
        externalHyperdrive: expect.objectContaining({ user: currentUser }),
      }),
    ]);
  });

  it('refreshes a saved Workers VPC origin when asked for a new CI plan', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    const serviceId = 'f537187c-73f7-4ad8-bcb6-38e3e3ac1177';
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', 'terraform-id');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_SERVICE_ID', serviceId);
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', 'runtime');
    const live = {
      id: 'terraform-id',
      name: 'managed-postgres',
      cachingDisabled: true,
      origin: { database: 'platform', scheme: 'postgresql' as const, serviceId, user: 'runtime' },
    };
    const getConfig = vi
      .spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig')
      .mockResolvedValueOnce(live);
    const command = parsePlatformArgs([
      ...args,
      '--workers-dev',
      '--login-methods',
      'github',
      '--no-access-protection',
      '--app-access',
      'public',
    ]);
    await runPlatformLifecycleCommand(command);

    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', 'replacement_runtime');
    getConfig.mockResolvedValueOnce({
      ...live,
      origin: { ...live.origin, user: 'replacement_runtime' },
    });
    await runPlatformLifecycleCommand(command);

    expect(listSavedPlatformInstallPlans()).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ name: 'test', hyperdrive: 'terraform-id' }),
        externalHyperdrive: expect.objectContaining({ user: 'replacement_runtime' }),
      }),
    ]);
  });

  it('accepts an uppercase Workers VPC service ID in CI', async () => {
    const serviceId = 'f537187c-73f7-4ad8-bcb6-38e3e3ac1177';
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ID', 'terraform-id');
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_SERVICE_ID', serviceId.toUpperCase());
    vi.stubEnv('VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER', 'runtime');
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue({
      id: 'terraform-id',
      name: 'managed-postgres',
      cachingDisabled: true,
      origin: { database: 'platform', scheme: 'postgresql', serviceId, user: 'runtime' },
    });

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));
    expect(listSavedPlatformInstallPlans()[0]?.externalHyperdrive?.serviceId).toBe(serviceId);
  });

  it('suggests a matching name without requiring it', async () => {
    vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([
      { id: 'other-id', name: 'company-managed-postgres' },
      { id: 'suggested-id', name: 'void-test-database' },
    ]);
    vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig').mockResolvedValue({
      id: 'suggested-id',
      name: 'void-test-database',
      origin: {
        database: 'void_platform',
        host: 'db.example.com',
        port: 5432,
        scheme: 'postgresql',
        user: 'runtime_user',
      },
      cachingDisabled: true,
    });

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(mocks.select).toHaveBeenCalledWith({
      message: 'How should Void set up Hyperdrive?',
      options: [
        { value: 'existing', label: 'Use an existing Hyperdrive' },
        { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
      ],
    });
    expect(mocks.select).toHaveBeenCalledWith({
      message: 'Which Hyperdrive should Void use?',
      options: [
        {
          value: 'suggested-id',
          label: 'void-test-database',
          hint: 'suggested · suggested-id',
        },
        { value: 'other-id', label: 'company-managed-postgres', hint: 'other-id' },
      ],
    });
  });

  it('explains how to set up a separately managed Hyperdrive before planning', async () => {
    mocks.select.mockResolvedValue('setup');

    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));

    expect(mocks.select).toHaveBeenCalledWith({
      message: 'How should Void set up Hyperdrive?',
      options: [
        { value: 'create', label: 'Let Void create Hyperdrive', hint: 'recommended' },
        { value: 'setup', label: 'Set up a separately managed Hyperdrive' },
      ],
    });
    expect(notesWithoutColors()).toContainEqual([
      expect.stringContaining('with any unused name such as void-test-database'),
      'Set up Hyperdrive first',
    ]);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('stops before planning if Hyperdrive selection is cancelled', async () => {
    vi.spyOn(PlatformCloudflareClient.prototype, 'listHyperdriveConfigs').mockResolvedValue([
      { id: 'terraform-id', name: 'void-test-database' },
    ]);
    const getConfig = vi.spyOn(PlatformCloudflareClient.prototype, 'getHyperdriveConfig');
    mocks.select.mockImplementation(async ({ message }) =>
      message === 'Which Hyperdrive should Void use?' ? CANCEL_SYMBOL : 'existing',
    );

    await expect(
      runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev'])),
    ).rejects.toThrow('Cancelled');
    expect(getConfig).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('bolds all section headings and runtime labels without styling their values', async () => {
    vi.spyOn(pc, 'bold').mockImplementation(pc.createColors(true).bold);
    const runtime = loadPlatformRuntime('');
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));
    expect(mocks.note).toHaveBeenCalledWith(
      [
        `\u001b[1mVersion:\u001b[22m ${runtime.manifest.platformVersion}`,
        `\u001b[1mSource:\u001b[22m ${runtime.source}`,
        `\u001b[1mRevision:\u001b[22m ${runtime.manifest.sourceRevision ?? 'not recorded'}`,
        `\u001b[1mManifest SHA-256:\u001b[22m ${runtime.manifestSha256}`,
      ].join('\n'),
      '\u001b[1mPlatform runtime\u001b[22m',
    );
    expect(mocks.note.mock.calls.map(([, title]) => title)).toEqual([
      '\u001b[1mRead-only installation plan\u001b[22m',
      '\u001b[1mPlatform runtime\u001b[22m',
      '\u001b[1mRequired Credentials\u001b[22m',
    ]);
  });

  it('preserves the entered name in the display name suggestion', async () => {
    mocks.text.mockResolvedValueOnce('My Team');
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--account', 'account', '--workers-dev']),
    );
    const prompt = mocks.text.mock.calls[0][0];
    expect(prompt).toMatchObject({ message: 'Installation name:', placeholder: 'company' });
    expect(prompt).not.toHaveProperty('initialValue');
    assert(typeof prompt.validate === 'function');
    expect(prompt.validate('')).toBe('A value is required.');
    expect(prompt.validate('My Team')).toBeUndefined();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'my-team' }),
      null,
      expect.anything(),
    );
    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Platform display name:',
        placeholder: 'My Team Void',
        defaultValue: 'My Team Void',
      }),
    );
  });

  it('accepts suggested zones and display names while requiring an application domain', async () => {
    mocks.select.mockResolvedValue('domain');
    mocks.text.mockResolvedValueOnce('apps.example.com');
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--name', 'team', '--account', 'account']),
    );
    const domainPrompt = mocks.text.mock.calls.find(
      ([input]) => input.message === 'Application base domain:',
    )![0];
    assert(typeof domainPrompt.validate === 'function');
    expect(domainPrompt.validate('')).toBe('A value is required.');
    expect(domainPrompt).not.toHaveProperty('defaultValue');
    for (const [message, suggestion] of [
      ['Cloudflare zone:', 'apps.example.com'],
      ['Platform display name:', 'team Void'],
    ]) {
      const prompt = mocks.text.mock.calls.find(([input]) => input.message === message)![0];
      expect(prompt).toMatchObject({ placeholder: suggestion, defaultValue: suggestion });
      expect(prompt).not.toHaveProperty('initialValue');
      assert(typeof prompt.validate === 'function');
      expect(prompt.validate('')).toBeUndefined();
    }
    const apiPrompt = mocks.text.mock.calls.find(([input]) =>
      input.message.startsWith('Where do you want to host the Void Platform API?'),
    )![0];
    expect(apiPrompt).toMatchObject({
      message:
        'Where do you want to host the Void Platform API? Leave empty for a workers.dev fallback.',
      placeholder: 'apps.example.com',
    });
    expect(apiPrompt).not.toHaveProperty('initialValue');
    expect(apiPrompt).not.toHaveProperty('defaultValue');
    assert(typeof apiPrompt.validate === 'function');
    expect(apiPrompt.validate('')).toBeUndefined();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        zoneName: 'apps.example.com',
        displayName: 'team Void',
        controlPlaneDomain: '',
      }),
      null,
      expect.anything(),
    );
  });

  it.each([
    { name: 'explicit flag', flags: ['--workers-dev'] },
    { name: 'interactive selection', flags: [] },
  ])('skips the dedicated-zone question for testing mode: $name', async ({ flags }) => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, ...flags]));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Where do you want to host the Void Platform API? Leave empty for a workers.dev fallback.',
        placeholder: 'platform.example.com',
      }),
    );
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workersDev: true, zoneName: '', dedicatedZone: false }),
      null,
      expect.anything(),
    );
  });

  it('keeps the named catch-all choice for an application domain at the zone apex', async () => {
    mocks.confirm.mockResolvedValue(true);
    await runPlatformLifecycleCommand(
      parsePlatformArgs([...args, '--application-domain', 'example.com', '--zone', 'example.com']),
    );
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Dedicate all unmatched example.com traffic to Void apps?',
      initialValue: false,
    });
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dedicatedZone: true }),
      null,
      expect.anything(),
    );
  });

  it('does not offer zone-wide routing for a nested application domain', async () => {
    await runPlatformLifecycleCommand(
      parsePlatformArgs([
        ...args,
        '--application-domain',
        'apps.example.com',
        '--zone',
        'example.com',
      ]),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
