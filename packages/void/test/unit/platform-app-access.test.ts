import { createHmac } from 'node:crypto';
import {
  createPlatformDeploymentManifest,
  parsePlatformAppAccessSetup,
  parsePlatformDeploymentManifest,
  PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX,
} from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  initializeInstalledAppAccess,
  prepareInstallationAppAccess,
  selectInstallationAppAccess,
  PlatformAppAccessCredentialError,
  turnOffInstalledProjectZeroTrust,
} from '../../src/cli/platform-app-access.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import type { PlatformAuthSelection } from '../../src/cli/platform-install-auth.ts';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';
import { platformInstallCommandArguments } from '../../src/cli/platform-setup.ts';

const prompts = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
  password: vi.fn(),
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  ...prompts,
}));
vi.mock('../../src/cli/platform-setup.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-setup.ts')>()),
  openPlatformSetupPage: vi.fn(),
}));
const originalTTY = process.stdin.isTTY;
function tty(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}
const protectedAuthentication: PlatformAuthSelection = {
  authentication: { providers: ['github'], configurable: true, accessProtection: true },
};
function plan(choice: 'public' | 'platform' | 'custom' = 'platform'): PlatformInstallPlan {
  return {
    account: { id: 'account', name: 'Hosting account' },
    installationId: 'team-12345678',
    apiUrl: 'https://platform.example.test',
    proxyUrl: 'https://proxy.example.test',
    workersSubdomain: 'team',
    zone: null,
    actions: [],
    deployment: createPlatformDeploymentManifest({
      appAccess: choice,
      application: { baseDomain: 'apps.example.test', zoneName: 'example.test' },
      displayName: 'Team',
      installationSlug: 'team',
      authentication: protectedAuthentication.authentication,
    }),
  };
}
function fixture(choice: 'public' | 'platform' | 'custom' = 'platform', deny = true) {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    const result = path.endsWith('/organizations')
      ? { auth_domain: 'company.cloudflareaccess.com', deny_unmatched_requests: deny }
      : path.endsWith('/identity_providers')
        ? [
            { id: 'hosting-idp', name: 'Hosting SSO' },
            { id: 'company-idp', name: 'Company SSO' },
          ]
        : path.endsWith('/policies')
          ? [{ id: 'hosting-policy', name: 'Employees', decision: 'allow' }]
          : path.includes('/policies/')
            ? {
                id: path.split('/').at(-1),
                decision: 'allow',
                include: [{ email_domain: { domain: 'example.test' } }],
              }
            : [];
    return Response.json({ success: true, result });
  });
  vi.stubGlobal('fetch', fetcher);
  const checkpoint: Record<string, string> = {};
  const input = {
    plan: plan(choice),
    authentication: protectedAuthentication,
    client: new PlatformCloudflareClient('operator-token'),
    managementToken: 'operator-token',
    checkpoint,
    save: (values: Record<string, string>) => {
      Object.assign(checkpoint, values);
    },
  };
  return { input, checkpoint, fetcher };
}
beforeEach(() => {
  vi.resetAllMocks();
  tty(false);
  prompts.confirm.mockResolvedValue(true);
  prompts.multiselect
    .mockResolvedValueOnce(['hosting-idp'])
    .mockResolvedValueOnce(['hosting-policy']);
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalTTY, configurable: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('guided installation app access', () => {
  it('recommends the platform policy and offers explicit alternatives', async () => {
    tty(true);
    prompts.select.mockResolvedValue('platform');
    expect(await selectInstallationAppAccess(protectedAuthentication)).toBe('platform');
    expect(prompts.select.mock.calls[0]?.[0]).toMatchObject({
      message: 'Who should be able to access deployed apps?',
      initialValue: 'platform',
      options: [{ value: 'platform' }, { value: 'public' }, { value: 'custom' }],
    });
    prompts.select.mockResolvedValue('public');
    await selectInstallationAppAccess({ authentication: { providers: ['github'] } });
    expect(
      // oxlint-disable-next-line typescript/no-unsafe-call -- Inspect the prompt options recorded by the partial prompt mock.
      prompts.select.mock.calls[1]?.[0].options.map((v: { value: string }) => v.value),
    ).toEqual(['public', 'custom']);
  });
  it('preserves legacy and completed installation choices without prompting', async () => {
    const legacy = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.test', zoneName: 'example.test' },
      displayName: 'Team',
      installationSlug: 'team',
    });
    tty(true);
    expect(await selectInstallationAppAccess(protectedAuthentication, legacy)).toBeUndefined();
    expect(await selectInstallationAppAccess(protectedAuthentication, plan().deployment)).toBe(
      'platform',
    );
    await expect(
      selectInstallationAppAccess(protectedAuthentication, plan().deployment, 'public'),
    ).rejects.toThrow('saved app access choice');
    expect(prompts.select).not.toHaveBeenCalled();
  });
  it('round-trips the app choice in a versioned manifest and install command', () => {
    const selected = plan().deployment;
    expect(selected.schemaVersion).toBe(4);
    expect(parsePlatformDeploymentManifest(selected)).toEqual(selected);
    expect(() => parsePlatformDeploymentManifest({ ...selected, schemaVersion: 3 })).toThrow(
      'schema version 4',
    );
    expect(
      parsePlatformArgs(['install', '--app-access', 'platform', '--access-protection']),
    ).toMatchObject({ appAccess: 'platform' });
    expect(() => parsePlatformArgs(['install', '--app-access', 'everyone'])).toThrow(
      '--app-access',
    );
    const args = platformInstallCommandArguments({
      commandName: 'void',
      accountId: 'account',
      installationSlug: 'team',
      displayName: 'Team',
      applicationDomain: 'apps.example.test',
      zoneName: 'example.test',
      controlPlaneDomain: 'platform.example.test',
      dedicatedZone: false,
      workersDev: false,
      authentication: protectedAuthentication.authentication,
      appAccess: 'platform',
      runtime: '',
      yes: false,
    });
    expect(args).toContain('--app-access');
    expect(parsePlatformArgs(args.slice(2))).toMatchObject({ appAccess: 'platform' });
  });
  it('reuses same-account selections only after consent to retain the installer token', async () => {
    tty(true);
    const { input, checkpoint } = fixture();
    checkpoint.accessSetupSpecJson = JSON.stringify({
      mode: 'create',
      identityProviderIds: ['company-idp'],
      policyIds: ['employees'],
    });
    const setup = JSON.parse(await prepareInstallationAppAccess(input));
    expect(setup).toMatchObject({
      mode: 'protected',
      managed: true,
      apiToken: 'operator-token',
      identityProviderIds: ['company-idp'],
      policyIds: ['employees'],
    });
    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Reuse the setup token for ongoing app access management?',
      }),
    );
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(await prepareInstallationAppAccess(input)).toBe(checkpoint.appAccessSetupJson);
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
  });
  it('does not silently retain installer credentials in headless mode', async () => {
    const { input } = fixture();
    await expect(prepareInstallationAppAccess(input)).rejects.toThrow(
      'VOID_PLATFORM_APP_ACCESS_TOKEN',
    );
    expect(input.checkpoint.appAccessToken).toBeUndefined();
  });
  it('selects hosting-account equivalents instead of reusing foreign-account policy IDs', async () => {
    tty(true);
    vi.stubEnv('VOID_PLATFORM_APP_ACCESS_TOKEN', 'hosting-token');
    const { input, checkpoint, fetcher } = fixture();
    checkpoint.accessSetupSpecJson = JSON.stringify({
      mode: 'existing',
      accountId: 'foreign',
      identityProviderIds: ['foreign-idp'],
      policyIds: ['foreign-policy'],
    });
    const setup = JSON.parse(await prepareInstallationAppAccess(input));
    expect(setup).toMatchObject({
      identityProviderIds: ['hosting-idp'],
      policyIds: ['hosting-policy'],
      accountId: 'account',
    });
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('/accounts/account/'))).toBe(
      true,
    );
  });
  it('keeps public setup credential-free when Default-Deny is off', async () => {
    const { input, checkpoint } = fixture('public', false);
    expect(JSON.parse(await prepareInstallationAppAccess(input))).toMatchObject({
      mode: 'public',
      managed: false,
    });
    expect(checkpoint.appAccessSetupJson).not.toContain('operator-token');
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.password).not.toHaveBeenCalled();
  });
  it('allows unmanaged public apps when Cloudflare explicitly reports Access disabled', async () => {
    const { input, fetcher } = fixture('public');
    fetcher.mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          errors: [{ code: 9999, message: 'access.api.error.not_enabled: Access is not enabled.' }],
        },
        { status: 403 },
      ),
    );
    expect(JSON.parse(await prepareInstallationAppAccess(input))).toMatchObject({
      mode: 'public',
      managed: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('requires an explicit credential when Cloudflare denies the public Access check', async () => {
    const { input, fetcher } = fixture('public');
    fetcher.mockResolvedValueOnce(
      Response.json(
        { success: false, errors: [{ code: 10_000, message: 'Authentication error' }] },
        { status: 403 },
      ),
    );
    await expect(prepareInstallationAppAccess(input)).rejects.toThrow(
      'VOID_PLATFORM_APP_ACCESS_TOKEN',
    );
  });
  it('prepares managed public rules under Default-Deny without asking for company policies', async () => {
    tty(true);
    const { input } = fixture('public');
    expect(JSON.parse(await prepareInstallationAppAccess(input))).toMatchObject({
      mode: 'public',
      managed: true,
      identityProviderIds: [],
      policyIds: [],
    });
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(prompts.multiselect).not.toHaveBeenCalled();
  });
  it('retains selections while replacing rejected or explicitly renewed credentials', async () => {
    tty(true);
    const { input, checkpoint } = fixture();
    checkpoint.accessSetupSpecJson = JSON.stringify({
      mode: 'create',
      identityProviderIds: ['company-idp'],
      policyIds: ['employees'],
    });
    await prepareInstallationAppAccess(input);
    vi.stubEnv('VOID_PLATFORM_APP_ACCESS_TOKEN', 'replacement');
    checkpoint.appAccessTokenRejected = 'true';
    expect(JSON.parse(await prepareInstallationAppAccess(input))).toMatchObject({
      apiToken: 'replacement',
      identityProviderIds: ['company-idp'],
      policyIds: ['employees'],
    });
    expect(checkpoint.appAccessTokenRejected).toBe('');
  });
  it('waits for the authenticated handoff to report readiness and rejects a different installation', async () => {
    const input = {
      apiUrl: 'https://platform.example.test',
      installationId: 'team',
      probeToken: 'proof',
      setupToken: 'one-time-setup-authority'.repeat(3),
      setupJson: JSON.stringify({
        version: 1,
        accountId: 'account',
        mode: 'public',
        managed: false,
        identityProviderIds: [],
        policyIds: [],
      }),
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ installationId: 'team', ready: false }, { status: 202 }),
      )
      .mockResolvedValueOnce(Response.json({ installationId: 'team', ready: true }));
    await initializeInstalledAppAccess(input, fetcher);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'manual',
      headers: { 'X-Void-Platform-Probe': 'proof' },
    });
    await expect(
      initializeInstalledAppAccess(input, async () =>
        Response.json({ installationId: 'other', ready: true }),
      ),
    ).rejects.toThrow('App access setup failed');
    await expect(
      initializeInstalledAppAccess(input, async () =>
        Response.json({ code: 'app_access_credentials' }, { status: 403 }),
      ),
    ).rejects.toBeInstanceOf(PlatformAppAccessCredentialError);
  });
  it('turns off project Zero Trust with a proof only the turn-off route accepts', async () => {
    const input = {
      apiUrl: 'https://platform.example.test',
      installationId: 'team',
      probeToken: 'proof',
      setupToken: 'one-time-setup-authority'.repeat(3),
      updateCommand: 'void platform upgrade team',
    };
    const fetcher = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({ installationId: 'team', turnedOff: true }),
    );
    await turnOffInstalledProjectZeroTrust(input, fetcher);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://platform.example.test/internal/platform/app-access/turn-off');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: '{"version":1}',
      headers: {
        'X-Void-Platform-Probe': 'proof',
        'X-Void-App-Access-Setup': createHmac('sha256', input.setupToken)
          .update(`${PLATFORM_APP_ACCESS_TURN_OFF_PROOF_PREFIX}\nteam\n{"version":1}`)
          .digest('base64url'),
      },
    });
    const answer =
      (body: unknown, status = 200) =>
      async () =>
        body === null ? new Response('404 Not Found', { status }) : Response.json(body, { status });
    // Runtimes from before the turn-off route answer in one of these ways.
    for (const old of [
      answer(null, 404),
      answer({ error: 'Platform disabled' }, 503),
      answer({ error: 'access_human_identity_required' }, 403),
    ]) {
      await expect(turnOffInstalledProjectZeroTrust(input, old)).rejects.toThrow(
        'Run `void platform upgrade team`, then retry the uninstall.',
      );
    }
    await expect(
      turnOffInstalledProjectZeroTrust(input, answer({ code: 'users_exist' }, 409)),
    ).rejects.toThrow('Run `void platform zero-trust disable`, then retry the uninstall.');
    await expect(
      turnOffInstalledProjectZeroTrust(input, answer({ code: 'app_access_credentials' }, 403)),
    ).rejects.toThrow('Cloudflare rejected the saved app access token');
    await expect(
      turnOffInstalledProjectZeroTrust(input, answer({ installationId: 'team', turnedOff: false })),
    ).rejects.toThrow('still turning off');
    await expect(
      turnOffInstalledProjectZeroTrust(input, answer({ installationId: 'other', turnedOff: true })),
    ).rejects.toThrow('Turning off project Zero Trust failed');
    await expect(
      turnOffInstalledProjectZeroTrust(
        input,
        answer({ installationId: 'team', turnedOff: true, usersExist: true }),
      ),
    ).rejects.toThrow(
      'A platform user signed in while project Zero Trust was turning off, so the uninstall stopped.',
    );
  });
  it('rejects tokens in unmanaged payloads and contradictory public protection', () => {
    const value = {
      version: 1,
      accountId: 'account',
      mode: 'public',
      managed: false,
      identityProviderIds: [],
      policyIds: [],
    };
    expect(() => parsePlatformAppAccessSetup({ ...value, apiToken: 'secret' })).toThrow(
      'must not retain',
    );
    expect(() => parsePlatformAppAccessSetup({ ...value, identityProviderIds: ['idp'] })).toThrow(
      'cannot include',
    );
  });
});
