import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
} from '@void/platform';
import { CANCEL_SYMBOL } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { platformAccessNonce } from '../../src/cli/platform-access-provision.ts';
import {
  activatePlatformAccessCredentials,
  checkpointPlatformAccessResources,
  parsePlatformAccessSetupSpec,
  platformAccessResourceInventory,
  preparePlatformAccessSetup,
} from '../../src/cli/platform-access-setup.ts';
import { PlatformCloudflareApiError } from '../../src/cli/platform-cloudflare.ts';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { platformAccessFixture } from '../fixtures/platform-access.ts';

const prompts = vi.hoisted(() => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => {
  const actual = await original<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return {
    ...actual,
    ...prompts,
    log: { ...actual.log, info: prompts.info, warn: prompts.warn },
  };
});

const plan = {
  account: { id: 'account', name: 'Account' },
  installationId: 'team-installation',
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Access installer setup', () => {
  it('publishes recovered ambiguous resource IDs without replacing deployment configuration', () => {
    const deployment = createPlatformDeploymentManifest({
      application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
      authentication: { providers: ['google'], configurable: true },
      capabilities: { githubOAuth: false, googleOAuth: true },
      displayName: 'Team',
      installationSlug: 'team',
    });
    const manifest = createPlatformInstallationManifest({
      account: plan.account,
      createdAt: new Date(0).toISOString(),
      deployment,
      id: plan.installationId,
      ownershipNonce: '0123456789abcdef0123456789abcdef',
      platformVersion: '1.0.0',
    });
    const checkpointed = checkpointPlatformAccessResources(
      manifest,
      JSON.stringify({
        version: 1,
        accountId: 'identity-account',
        installationId: plan.installationId,
        resources: {
          protection: {
            id: 'reconciled-app',
            name: 'Protection',
            fingerprint: 'fingerprint',
            pending: true,
          },
        },
      }),
      '2026-09-18T00:00:00.000Z',
    );
    expect(checkpointed.deployment).toEqual(deployment);
    expect(checkpointed.authenticationResources).toEqual([
      {
        accountId: 'identity-account',
        id: 'reconciled-app',
        key: 'protection',
        kind: 'application',
        name: 'Protection',
        ownership: 'created',
      },
    ]);
  });

  it.each([
    { login: true, protection: false, applications: 1, tokens: 0 },
    { login: false, protection: true, applications: 1, tokens: 1 },
    { login: true, protection: true, applications: 2, tokens: 1 },
    { login: false, protection: false, applications: 0, tokens: 0 },
  ])(
    'provisions only selected capabilities: $login / $protection and resumes without duplicate resources',
    async ({ login, protection, applications, tokens }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubEnv('VOID_ACCESS_CREDENTIALS', '');
      const env = platformAccessFixture();
      const checkpoint: Record<string, string> = {};
      const input = {
        plan,
        ownershipNonce: 'owned-installation',
        ...(login ? { login: { id: 'access', label: 'Company' } } : {}),
        protection,
        yes: true,
        spec: {
          mode: 'create' as const,
          identityProviderIds: ['company-idp'],
          policyIds: ['employees'],
        },
        client: env.transport as PlatformCloudflareClient,
        checkpoint,
        save: (values: Record<string, string>) => Object.assign(checkpoint, values),
      };
      const result = await preparePlatformAccessSetup(input);
      expect(env.apps.size).toBe(applications);
      expect(env.tokens.size).toBe(tokens);
      const resumed = await preparePlatformAccessSetup({ ...input, spec: undefined });
      expect(resumed).toEqual(result);
      expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(
        applications + tokens,
      );
      const resources = platformAccessResourceInventory(
        checkpoint.accessProvisioningJson,
        plan.installationId,
      );
      expect(resources).toHaveLength(applications + tokens);
      expect(JSON.stringify(resources)).not.toContain('secret');
      if (!login && !protection) {
        expect(env.calls).toHaveLength(0);
      }
      if (protection) {
        expect(Object.keys(JSON.parse(process.env.VOID_ACCESS_CREDENTIALS!))).toEqual([
          plan.apiUrl,
          plan.proxyUrl,
        ]);
      }
    },
  );

  it('validates nonsecret Access setup without reading environment credentials', () => {
    expect(
      parsePlatformAccessSetupSpec({ mode: 'existing', loginClientSecretEnv: 'UNSET_SECRET' }),
    ).toEqual({ mode: 'existing', loginClientSecretEnv: 'UNSET_SECRET' });
    for (const value of [
      { mode: 'create', clientSecret: 'plaintext' },
      { mode: 'existing', serviceToken: { id: 'token', clientSecret: 'plaintext' } },
      { mode: 'existing', loginClientSecretEnv: '$(secret)' },
      { mode: 'create', policyIds: ['duplicate', 'duplicate'] },
    ]) {
      expect(() => parsePlatformAccessSetupSpec(value)).toThrow();
    }
  });

  it('rejects recovery credentials for unrelated origins without activating any of them', () => {
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', '{}');
    expect(() =>
      activatePlatformAccessCredentials(
        JSON.stringify({
          [plan.apiUrl]: { CF_ACCESS_CLIENT_ID: 'client', CF_ACCESS_CLIENT_SECRET: 'secret' },
          'https://unrelated.example.com': {
            CF_ACCESS_CLIENT_ID: 'client',
            CF_ACCESS_CLIENT_SECRET: 'secret',
          },
        }),
        [plan.apiUrl, plan.proxyUrl],
      ),
    ).toThrow('scoped');
    expect(process.env.VOID_ACCESS_CREDENTIALS).toBe('{}');
  });
});

describe('interactive Access policy creation', () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  beforeEach(() => {
    Object.values(prompts).forEach((mock) => mock.mockReset());
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    prompts.multiselect.mockImplementation(async ({ message }) =>
      message === 'Company identity providers:' ? ['company-idp'] : ['employees'],
    );
  });
  afterEach(() => {
    if (tty) {
      Object.defineProperty(process.stdin, 'isTTY', tty);
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  function setup(initialPolicies: Array<Record<string, unknown>> = []) {
    const env = platformAccessFixture();
    let policies = initialPolicies;
    const request = vi.fn(async <T>(path: string, init?: RequestInit): Promise<T> => {
      const target = path.split('?')[0]!;
      if (target === '/accounts/account/access/policies' && init?.method === 'POST') {
        const created = { ...JSON.parse(String(init.body)), id: 'company-domain' };
        policies = [...policies, created];
        return structuredClone(created) as T;
      }
      if (target === '/accounts/account/access/policies') {
        return structuredClone(policies) as T;
      }
      if (target.startsWith('/accounts/account/access/policies/')) {
        return structuredClone(
          policies.find((policy) => policy.id === target.split('/').at(-1)),
        ) as T;
      }
      if (target.startsWith('/accounts/account/access/apps/') && target.endsWith('/policies')) {
        const app = env.apps.get(target.split('/').at(-2)!)!;
        const references = app.policies as Array<{ id: string }>;
        return structuredClone(
          references.map((reference) => policies.find((policy) => policy.id === reference.id)),
        ) as T;
      }
      return env.transport.request<T>(path, init);
    });
    const checkpoint: Record<string, string> = {};
    return {
      env,
      request,
      checkpoint,
      setPolicies: (next: Array<Record<string, unknown>>) => {
        policies = next;
      },
      input: {
        plan,
        ownershipNonce: 'owned-installation',
        login: { id: 'access', label: 'Company' },
        protection: false,
        yes: true,
        spec: { mode: 'create' as const },
        client: { request } as unknown as PlatformCloudflareClient,
        checkpoint,
        save: (values: Record<string, string>) => Object.assign(checkpoint, values),
      },
    };
  }

  it('guides an empty account through manual creation, reloads, and continues without restarting', async () => {
    const fixture = setup();
    prompts.select.mockImplementation(
      async ({ options }) =>
        options.find((option: { label: string }) => option.label === 'Create in Cloudflare').value,
    );
    prompts.confirm.mockImplementation(async () => {
      expect(fixture.env.apps.size).toBe(0);
      expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!)).toMatchObject({
        identityProviderIds: ['company-idp'],
      });
      fixture.setPolicies([fixture.env.policy]);
      return true;
    });
    const result = await preparePlatformAccessSetup(fixture.input);
    expect(result?.login?.configuration.kind).toBe('cloudflare-access');
    expect(prompts.select).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({ label: 'Allow my company’s email domain' }),
          expect.objectContaining({ label: 'Create in Cloudflare' }),
          expect.objectContaining({ label: 'Refresh list' }),
        ],
      }),
    );
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('Access controls → Policies → Add a policy'),
      expect.stringContaining('Create an Access policy'),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('https://dash.cloudflare.com/account'),
    );
    expect(prompts.confirm).toHaveBeenCalledExactlyOnceWith({
      message: 'Have you saved the new policy?',
      initialValue: true,
    });
    expect(
      fixture.request.mock.calls.filter(
        ([path]) => path.split('?')[0] === '/accounts/account/access/policies',
      ),
    ).toHaveLength(2);
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!)).toMatchObject({
      policyIds: ['employees'],
    });
    expect([...fixture.env.apps.values()][0]?.policies).toEqual([
      { id: 'employees', precedence: 1 },
    ]);
    expect(
      fixture.request.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([path]) => path),
    ).toEqual(['/accounts/account/access/apps']);
  });

  it('offers creation alongside existing policies and preserves selections after a reload', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy]);
    let policyPrompts = 0;
    prompts.multiselect.mockImplementation(async ({ message, options, initialValues }) => {
      if (message === 'Company identity providers:') {
        return ['company-idp'];
      }
      if (policyPrompts++ === 0) {
        expect(options).toContainEqual(expect.objectContaining({ value: 'employees' }));
        return [
          'employees',
          options.find((option: { label: string }) => option.label === 'Create in Cloudflare')
            .value,
        ];
      }
      expect(initialValues).toEqual(['employees']);
      expect(options).toContainEqual(expect.objectContaining({ value: 'managers' }));
      return ['employees', 'managers'];
    });
    prompts.confirm.mockImplementation(async () => {
      fixture.setPolicies([
        fixture.env.policy,
        { ...fixture.env.policy, id: 'managers', name: 'Managers' },
      ]);
      return true;
    });
    await preparePlatformAccessSetup(fixture.input);
    expect(prompts.select).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!).policyIds).toEqual([
      'employees',
      'managers',
    ]);
  });

  it('keeps the creation and refresh actions available when the new policy is not visible yet', async () => {
    const fixture = setup([
      { id: 'bypass', decision: 'bypass' },
      { id: 'service', decision: 'non_identity' },
    ]);
    let menus = 0;
    prompts.select.mockImplementation(async ({ options }) => {
      expect(options.map((option: { label: string }) => option.label)).toEqual([
        'Allow my company’s email domain',
        'Create in Cloudflare',
        'Refresh list',
      ]);
      if (menus++ === 0) {
        return options[1].value;
      }
      fixture.setPolicies([fixture.env.policy]);
      return options[2].value;
    });
    prompts.confirm.mockResolvedValue(true);
    await preparePlatformAccessSetup(fixture.input);
    expect(menus).toBe(2);
    expect(
      fixture.request.mock.calls.filter(
        ([path]) => path.split('?')[0] === '/accounts/account/access/policies',
      ),
    ).toHaveLength(3);
    expect(
      prompts.multiselect.mock.calls.filter(([input]) =>
        input.message.startsWith('Company Access policies'),
      ),
    ).toHaveLength(1);
  });

  it('returns to policy selection without reloading when manual setup is not complete', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy]);
    let policyPrompts = 0;
    prompts.multiselect.mockImplementation(async ({ message, options, initialValues }) => {
      if (message === 'Company identity providers:') {
        return ['company-idp'];
      }
      if (policyPrompts++ === 0) {
        return [
          'employees',
          options.find((option: { label: string }) => option.label === 'Create in Cloudflare')
            .value,
        ];
      }
      expect(initialValues).toEqual(['employees']);
      return ['employees'];
    });
    prompts.confirm.mockResolvedValue(false);
    await preparePlatformAccessSetup(fixture.input);
    expect(
      fixture.request.mock.calls.filter(
        ([path]) => path.split('?')[0] === '/accounts/account/access/policies',
      ),
    ).toHaveLength(1);
  });

  it.each(['picker', 'completion'])(
    'cancels at the %s without creating resources or losing the identity provider',
    async (stage) => {
      const fixture = setup();
      prompts.select.mockImplementation(async ({ options }) =>
        stage === 'picker'
          ? CANCEL_SYMBOL
          : options.find((option: { label: string }) => option.label === 'Create in Cloudflare')
              .value,
      );
      prompts.confirm.mockResolvedValue(CANCEL_SYMBOL);
      await expect(preparePlatformAccessSetup(fixture.input)).rejects.toThrow(
        'platform: Cancelled.',
      );
      expect(
        fixture.request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
      ).toBe(true);
      expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!)).toEqual({
        mode: 'create',
        identityProviderIds: ['company-idp'],
      });
    },
  );

  it('does not prompt for manual policy creation in noninteractive mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const fixture = setup();
    await expect(
      preparePlatformAccessSetup({
        ...fixture.input,
        spec: { mode: 'create', identityProviderIds: ['company-idp'] },
      }),
    ).rejects.toThrow('explicit identityProviderIds and policyIds');
    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(fixture.env.apps.size).toBe(0);
  });

  it('explains how to attach the new policy when connecting existing Access applications', async () => {
    const fixture = setup();
    prompts.select.mockImplementation(async ({ options }) => {
      expect(options.map((option: { label: string }) => option.label)).toEqual([
        'Create in Cloudflare',
        'Refresh list',
      ]);
      return options[0].value;
    });
    prompts.confirm
      .mockImplementationOnce(async () => {
        fixture.setPolicies([fixture.env.policy]);
        return true;
      })
      .mockResolvedValueOnce(false);
    await expect(
      preparePlatformAccessSetup({
        ...fixture.input,
        yes: false,
        spec: { mode: 'existing', loginApplicationId: 'existing-login' },
      }),
    ).rejects.toThrow('Access setup changes require confirmation');
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('attach it to the existing Access applications'),
      expect.stringContaining('Create an Access policy'),
    );
    expect(fixture.env.apps.size).toBe(0);
    expect(
      fixture.request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
    ).toBe(true);
  });

  const broad = { id: 'broad', name: 'Everyone', decision: 'allow', include: [{ everyone: {} }] };
  const policyPrompts = () =>
    prompts.multiselect.mock.calls.filter(([input]) =>
      input.message.startsWith('Company Access policies'),
    );
  const action =
    (label: string) =>
    async ({ options }: { options: Array<{ label: string; value: string }> }) =>
      options.find((option) => option.label === label)!.value;

  it('creates an Allow policy for the company email domains and preselects it', async () => {
    const fixture = setup();
    prompts.select.mockImplementation(action('Allow my company’s email domain'));
    prompts.text.mockResolvedValue('Example.com, @corp.example.com example.com');
    prompts.multiselect.mockImplementation(async ({ message, initialValues }) => {
      if (message === 'Company identity providers:') {
        return ['company-idp'];
      }
      expect(initialValues).toEqual(['company-domain']);
      return ['company-domain'];
    });
    await preparePlatformAccessSetup(fixture.input);
    const posts = fixture.request.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([path]) => path)).toEqual([
      '/accounts/account/access/policies',
      '/accounts/account/access/apps',
    ]);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({
      name: 'Emails ending in @example.com and 1 more',
      decision: 'allow',
      include: [
        { email_domain: { domain: 'example.com' } },
        { email_domain: { domain: 'corp.example.com' } },
      ],
    });
    expect(prompts.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Created the Access policy “Emails ending in @example.com and 1 more” in Cloudflare.',
      ),
    );
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!).policyIds).toEqual([
      'company-domain',
    ]);
    expect([...fixture.env.apps.values()][0]?.policies).toEqual([
      { id: 'company-domain', precedence: 1 },
    ]);
  });

  it.each([400, 403])(
    'returns to the picker when Cloudflare refuses to create the policy (HTTP %i)',
    async (status) => {
      const fixture = setup();
      const respond = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation(async (path, init) => {
        if (init?.method === 'POST' && path === '/accounts/account/access/policies') {
          throw new PlatformCloudflareApiError('Cloudflare API error: refused.', status);
        }
        return respond(path, init);
      });
      prompts.select
        .mockImplementationOnce(action('Allow my company’s email domain'))
        .mockImplementationOnce(action('Create in Cloudflare'));
      prompts.text.mockResolvedValue('example.com');
      prompts.confirm.mockImplementation(async () => {
        fixture.setPolicies([fixture.env.policy]);
        return true;
      });
      await preparePlatformAccessSetup(fixture.input);
      expect(prompts.warn).toHaveBeenCalledWith(
        'Cloudflare API error: refused. Choose “Create in Cloudflare” instead.',
      );
      expect(prompts.select).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!).policyIds).toEqual(['employees']);
    },
  );

  it.each(['creating', 'checking'])(
    'stops on a network failure while %s a policy instead of asking again',
    async (stage) => {
      const fixture = setup(stage === 'checking' ? [broad] : []);
      const respond = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation(async (path, init) => {
        if (
          stage === 'creating'
            ? init?.method === 'POST' && path === '/accounts/account/access/policies'
            : path === '/accounts/account/access/policies/broad'
        ) {
          throw new TypeError('fetch failed');
        }
        return respond(path, init);
      });
      prompts.select.mockImplementation(action('Allow my company’s email domain'));
      prompts.text.mockResolvedValue('example.com');
      prompts.multiselect.mockImplementation(async ({ message }) =>
        message === 'Company identity providers:' ? ['company-idp'] : ['broad'],
      );
      await expect(preparePlatformAccessSetup(fixture.input)).rejects.toThrow('fetch failed');
      expect(prompts.warn).not.toHaveBeenCalled();
      expect(prompts.select.mock.calls.length + policyPrompts().length).toBe(1);
    },
  );

  it('asks again when a picked policy does not restrict company identities', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy, broad]);
    let picks = 0;
    prompts.multiselect.mockImplementation(async ({ message, initialValues }) => {
      if (message === 'Company identity providers:') {
        return ['company-idp'];
      }
      if (picks++ === 0) {
        return ['broad'];
      }
      expect(initialValues).toEqual(['broad']);
      return ['employees'];
    });
    await preparePlatformAccessSetup(fixture.input);
    expect(prompts.warn).toHaveBeenCalledExactlyOnceWith(
      'Company Access policies must not allow Everyone or any valid service token. Choose other policies, or fix the policy in Cloudflare and refresh the list.',
    );
    expect(policyPrompts()).toHaveLength(2);
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!).policyIds).toEqual(['employees']);
    expect(
      fixture.request.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([path]) => path),
    ).toEqual(['/accounts/account/access/apps']);
  });

  it('asks again when a picked policy admits anyone who receives a one-time PIN', async () => {
    const fixture = setup();
    fixture.env.identityProviders.push({ id: 'pin', type: 'onetimepin', name: 'One-time PIN' });
    fixture.setPolicies([
      fixture.env.policy,
      {
        id: 'pin-only',
        name: 'PIN',
        decision: 'allow',
        include: [{ login_method: { id: 'pin' } }],
      },
    ]);
    let picks = 0;
    prompts.multiselect.mockImplementation(async ({ message }) => {
      if (message === 'Company identity providers:') {
        return ['company-idp', 'pin'];
      }
      return picks++ === 0 ? ['pin-only'] : ['employees'];
    });
    await preparePlatformAccessSetup(fixture.input);
    expect(prompts.warn).toHaveBeenCalledExactlyOnceWith(
      'Select Access allow policies restricted to company identities. Choose other policies, or fix the policy in Cloudflare and refresh the list.',
    );
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!).policyIds).toEqual(['employees']);
  });

  it('asks again when a picked policy uses a login method that was not selected', async () => {
    const fixture = setup();
    fixture.env.identityProviders.push({ id: 'subsidiary-idp', type: 'okta', name: 'Subsidiary' });
    fixture.setPolicies([
      fixture.env.policy,
      {
        id: 'subsidiary',
        name: 'Subsidiary SSO',
        decision: 'allow',
        include: [{ login_method: { id: 'subsidiary-idp' } }],
      },
    ]);
    let picks = 0;
    prompts.multiselect.mockImplementation(async ({ message }) => {
      if (message === 'Company identity providers:') {
        return ['company-idp'];
      }
      return picks++ === 0 ? ['subsidiary'] : ['employees'];
    });
    await preparePlatformAccessSetup(fixture.input);
    expect(prompts.warn).toHaveBeenCalledExactlyOnceWith(
      'An Access allow policy uses an identity provider that is not one of the selected identity providers. Choose other policies, or fix the policy in Cloudflare and refresh the list.',
    );
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!).policyIds).toEqual(['employees']);
  });

  it('forgets a rejected saved pick so the next interactive run asks again', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy, broad]);
    fixture.checkpoint.accessSetupSpecJson = JSON.stringify({
      mode: 'create',
      identityProviderIds: ['company-idp'],
      policyIds: ['broad'],
    });
    const resumed = { ...fixture.input, spec: undefined };
    await expect(preparePlatformAccessSetup(resumed)).rejects.toThrow(
      'must not allow Everyone or any valid service token. Choose other policies when you run the command again, or fix the policy in Cloudflare.',
    );
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson)).toEqual({ mode: 'create' });
    await preparePlatformAccessSetup(resumed);
    expect(policyPrompts()).toHaveLength(1);
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson)).toEqual({
      mode: 'create',
      identityProviderIds: ['company-idp'],
      policyIds: ['employees'],
    });
    expect(fixture.env.apps.size).toBe(1);
  });

  it('forgets a saved policy that was deleted in Cloudflare', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy]);
    const spec = {
      mode: 'create',
      identityProviderIds: ['company-idp'],
      policyIds: ['old-policy'],
    };
    fixture.checkpoint.accessSetupSpecJson = JSON.stringify(spec);
    const respond = fixture.request.getMockImplementation()!;
    let status = 503;
    fixture.request.mockImplementation(async (path, init) => {
      if (path === '/accounts/account/access/policies/old-policy') {
        throw new PlatformCloudflareApiError('Cloudflare API error.', status, path);
      }
      return respond(path, init);
    });
    const resumed = { ...fixture.input, spec: undefined };
    await expect(preparePlatformAccessSetup(resumed)).rejects.toThrow(PlatformCloudflareApiError);
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson)).toEqual(spec);
    status = 404;
    await expect(preparePlatformAccessSetup(resumed)).rejects.toThrow(
      'The selected Access policy old-policy is unavailable in this account. Choose other policies when you run the command again',
    );
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson)).toEqual({ mode: 'create' });
    await preparePlatformAccessSetup(resumed);
    expect(policyPrompts()).toHaveLength(1);
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson).policyIds).toEqual(['employees']);
  });

  it('keeps a rejected saved pick when Access resources already depend on it', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy, broad]);
    const spec = { mode: 'create', identityProviderIds: ['company-idp'], policyIds: ['broad'] };
    fixture.checkpoint.accessSetupSpecJson = JSON.stringify(spec);
    fixture.checkpoint.accessProvisioningJson = JSON.stringify({
      version: 1,
      accountId: 'account',
      installationId: plan.installationId,
      nonce: platformAccessNonce('owned-installation'),
      resources: {
        'login-access': { name: 'login', fingerprint: 'previous', id: 'app-1', pending: false },
      },
    });
    await expect(preparePlatformAccessSetup({ ...fixture.input, spec: undefined })).rejects.toThrow(
      'Fix the selected policy in Cloudflare, then resume.',
    );
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson)).toEqual(spec);
    expect(prompts.multiselect).not.toHaveBeenCalled();
  });

  it('keeps a rejected pick that the Access setup file owns', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy, broad]);
    const spec = {
      mode: 'create' as const,
      identityProviderIds: ['company-idp'],
      policyIds: ['broad'],
    };
    await expect(preparePlatformAccessSetup({ ...fixture.input, spec })).rejects.toThrow(
      'Fix the selected policy in Cloudflare, then resume.',
    );
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson!)).toEqual(spec);
  });

  it('keeps the saved pick when provisioning fails for another reason', async () => {
    const fixture = setup();
    fixture.setPolicies([fixture.env.policy]);
    const spec = { mode: 'create', identityProviderIds: ['company-idp'], policyIds: ['employees'] };
    fixture.checkpoint.accessSetupSpecJson = JSON.stringify(spec);
    const respond = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (path, init) => {
      if (init?.method === 'POST' && path === '/accounts/account/access/apps') {
        throw new TypeError('fetch failed');
      }
      return respond(path, init);
    });
    const failure = preparePlatformAccessSetup({ ...fixture.input, spec: undefined });
    await expect(failure).rejects.toThrow(TypeError);
    await expect(failure).rejects.toThrow(/^fetch failed$/);
    expect(JSON.parse(fixture.checkpoint.accessSetupSpecJson)).toEqual(spec);
  });
});
