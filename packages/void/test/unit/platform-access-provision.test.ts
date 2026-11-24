import { describe, expect, it } from 'vite-plus/test';
import {
  inspectPlatformAccess,
  provisionPlatformAccess,
} from '../../src/cli/platform-access-provision.ts';
import type {
  PlatformAccessCheckpoint,
  PlatformAccessProvisionInput,
} from '../../src/cli/platform-access-provision.ts';
import { platformAccessFixture as fixture } from '../fixtures/platform-access.ts';

const base: PlatformAccessProvisionInput = {
  accountId: 'account',
  installationId: 'team-installation',
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
  identityProviderIds: ['company-idp'],
  policyIds: ['employees'],
};
const fresh = (): PlatformAccessCheckpoint => ({
  version: 1,
  accountId: base.accountId,
  installationId: base.installationId,
  nonce: '0123456789abcdef0123456789abcdef',
  resources: {},
});

describe('Cloudflare Access provisioning', () => {
  it.each(['', '  ', undefined, null])(
    'uses the provider ID for a missing built-in provider label (%j) without changing identity selection',
    async (name) => {
      const env = fixture();
      env.identityProviders[0] = { id: 'company-idp', type: 'cloudflare', name };
      const result = await inspectPlatformAccess(env.client, base);
      expect(result.identityProviders).toEqual([{ id: 'company-idp', name: 'company-idp' }]);
      expect(result.policies).toEqual([env.policy]);
      expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
    },
  );
  it.each([
    { id: '', name: '' },
    { name: '' },
    { id: 'company-idp', name: 123 },
    { id: 'company-idp', name: 'x'.repeat(8193) },
  ])('rejects malformed provider identity or label before writes (%j)', async (provider) => {
    const env = fixture();
    env.identityProviders[0] = provider;
    await expect(
      provisionPlatformAccess(
        env.client,
        { ...base, login: { id: 'access', label: 'Company Access' } },
        fresh(),
        () => {},
      ),
    ).rejects.toThrow('Cloudflare Access did not return identity provider');
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('connects externally managed protection and records its service token without writes', async () => {
    const env = fixture();
    env.tokens.set('ci-token', { id: 'ci-token', name: 'Managed CI', client_id: 'external-ci' });
    env.apps.set('external-gate', {
      id: 'external-gate',
      name: 'Managed perimeter',
      type: 'self_hosted',
      allowed_idps: ['company-idp'],
      aud: 'external-audience',
      destinations: [base.apiUrl, base.proxyUrl].map((origin) => ({
        type: 'public',
        uri: new URL(origin).hostname,
      })),
      policies: [
        { id: 'employees' },
        { decision: 'non_identity', include: [{ service_token: { token_id: 'ci-token' } }] },
      ],
    });
    const output = await provisionPlatformAccess(
      env.client,
      {
        ...base,
        protection: { applicationId: 'external-gate' },
        serviceToken: { id: 'ci-token', clientId: 'external-ci', clientSecret: 'external-secret' },
      },
      fresh(),
      () => {},
    );
    expect(output.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ci-token', adopted: true }),
        expect.objectContaining({ id: 'external-gate', adopted: true }),
      ]),
    );
    expect(env.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('creates OIDC login without a perimeter application or service token', async () => {
    const env = fixture();
    let state = fresh();
    const input = { ...base, login: { id: 'access', label: 'Company Access' } };
    const result = await provisionPlatformAccess(env.client, input, state, (value) => {
      state = structuredClone(value);
    });
    expect(result.login?.configuration).toMatchObject({
      kind: 'cloudflare-access',
      issuer: 'https://company.cloudflareaccess.com/cdn-cgi/access/sso/oidc/app-1-client',
    });
    expect(result.login?.clientSecret).toBe('oidc-secret');
    expect(result.protection).toBeUndefined();
    expect(env.tokens.size).toBe(0);
    const repeated = await provisionPlatformAccess(env.client, input, state, (value) => {
      state = structuredClone(value);
    });
    expect(repeated.login).toEqual(result.login);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('creates independent protection with a narrow machine policy and origin-scoped credentials', async () => {
    const env = fixture();
    let saved: PlatformAccessCheckpoint | undefined;
    const result = await provisionPlatformAccess(
      env.client,
      { ...base, protection: {} },
      fresh(),
      (state) => {
        saved = structuredClone(state);
      },
    );
    expect(result.login).toBeUndefined();
    expect(result.protection?.applications.map((app) => app.origin)).toEqual([
      base.apiUrl,
      base.proxyUrl,
    ]);
    expect(Object.keys(result.credentials!)).toEqual([base.apiUrl, base.proxyUrl]);
    const app = [...env.apps.values()][0]!;
    expect(app.policies).toEqual([
      { id: 'employees', precedence: 1 },
      {
        name: 'Void installer and CI',
        decision: 'non_identity',
        precedence: 0,
        include: [{ service_token: { token_id: 'token-1' } }],
      },
    ]);
    expect(env.policy.require).toEqual([
      { device_posture: { integration_uid: 'managed-devices' } },
    ]);
    expect(saved?.resources['service-token']?.clientSecret).toBe('service-secret');
  });

  it('rejects broad or bypass company policies before any mutation', async () => {
    for (const replacement of [
      { decision: 'bypass' },
      { include: [{ everyone: {} }] },
      { include: [{ ip: { ip: '0.0.0.0/0' } }] },
    ]) {
      const env = fixture();
      Object.assign(env.policy, replacement);
      await expect(
        provisionPlatformAccess(env.client, { ...base, protection: {} }, fresh(), () => {}),
      ).rejects.toThrow();
      expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
    }
  });

  it.each([
    { azureAD: { id: 'company-group', identity_provider_id: 'company-idp' } },
    { login_method: { id: 'company-idp' } },
    { auth_context: { id: 'context', ac_id: 'c1', identity_provider_id: 'company-idp' } },
    { cloudflare_account_member: {} },
    { cloudflare_account_member: { account_id: '023e105f4ecef8ad9ca31a8372d0c353' } },
    { okta: { identity_provider_id: 'subsidiary-idp', name: 'Engineering' } },
  ])('accepts %j as a company identity rule', async (rule) => {
    const env = fixture();
    env.policy.include = [rule];
    delete env.policy.require;
    const result = await provisionPlatformAccess(
      env.client,
      { ...base, login: { id: 'access', label: 'Company Access' } },
      fresh(),
      () => {},
    );
    expect(result.login?.configuration.kind).toBe('cloudflare-access');
    expect(env.apps.size).toBe(1);
  });

  it.each([
    { include: [{ login_method: { id: 'subsidiary-idp' } }] },
    {
      include: [{ ip: { ip: '203.0.113.0/24' } }],
      require: [{ login_method: { id: 'subsidiary-idp' } }],
    },
    { include: [{ azureAD: { id: 'company-group', identity_provider_id: 'subsidiary-idp' } }] },
    {
      include: [{ ip: { ip: '203.0.113.0/24' } }],
      require: [
        { auth_context: { id: 'context', ac_id: 'c1', identity_provider_id: 'subsidiary-idp' } },
      ],
    },
  ])('accepts a company provider rule only when it is a selected provider (%j)', async (rules) => {
    const env = fixture();
    env.identityProviders.push({ id: 'subsidiary-idp', type: 'azureAD', name: 'Subsidiary SSO' });
    delete env.policy.require;
    Object.assign(env.policy, rules);
    const login = { id: 'access', label: 'Company Access' };
    await expect(
      provisionPlatformAccess(env.client, { ...base, login }, fresh(), () => {}),
    ).rejects.toThrow(
      'An Access allow policy uses an identity provider that is not one of the selected identity providers.',
    );
    expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
    const result = await provisionPlatformAccess(
      env.client,
      { ...base, identityProviderIds: ['company-idp', 'subsidiary-idp'], login },
      fresh(),
      () => {},
    );
    expect(result.login?.configuration.kind).toBe('cloudflare-access');
    expect([...env.apps.values()][0]?.allowed_idps).toEqual(['company-idp', 'subsidiary-idp']);
  });

  it.each([{ azureAD: { id: 'company-group' } }, { auth_context: { id: 'context', ac_id: 'c1' } }])(
    'rejects %j without its identity provider',
    async (rule) => {
      const env = fixture();
      env.policy.include = [rule];
      delete env.policy.require;
      await expect(
        provisionPlatformAccess(
          env.client,
          { ...base, login: { id: 'access', label: 'Company Access' } },
          fresh(),
          () => {},
        ),
      ).rejects.toThrow('Select Access allow policies restricted to company identities.');
      expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
    },
  );

  it.each([
    { type: 'onetimepin' },
    { type: 'github' },
    { type: 'cloudflare', config: { restrict_to_account_members: false } },
    { type: 'oidc', config: { auth_url: 'https://accounts.google.com/o/oauth2/auth' } },
    { type: 'saml', config: { sso_target_url: 'https://idp.example.net/sso/saml' } },
  ])('rejects a policy that admits anyone who signs in with %j', async (provider) => {
    const env = fixture();
    env.identityProviders.push({ id: 'public-login', name: 'Public login', ...provider });
    env.policy.include = [{ login_method: { id: 'public-login' } }];
    delete env.policy.require;
    await expect(
      provisionPlatformAccess(
        env.client,
        {
          ...base,
          identityProviderIds: ['company-idp', 'public-login'],
          login: { id: 'access', label: 'Company Access' },
        },
        fresh(),
        () => {},
      ),
    ).rejects.toThrow('Select Access allow policies restricted to company identities.');
    expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('rejects more specific overlapping Access apps before creating even an OIDC app', async () => {
    const env = fixture();
    env.apps.set('foreign', {
      id: 'foreign',
      name: 'Existing admin route',
      domain: 'api.example.com/admin',
      type: 'self_hosted',
    });
    await expect(
      provisionPlatformAccess(
        env.client,
        { ...base, login: { id: 'access', label: 'Access' }, protection: {} },
        fresh(),
        () => {},
      ),
    ).rejects.toThrow('overlaps');
    expect(env.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('reconciles an ambiguous create without duplicating the app or inventing its secret', async () => {
    const env = fixture();
    let state = fresh();
    const save = (value: PlatformAccessCheckpoint) => {
      state = structuredClone(value);
    };
    const input = { ...base, login: { id: 'access', label: 'Access' } };
    env.loseNextApplicationResponse();
    await expect(provisionPlatformAccess(env.client, input, state, save)).rejects.toThrow(
      'response lost',
    );
    await expect(provisionPlatformAccess(env.client, input, state, save)).rejects.toThrow(
      'secret was not recovered',
    );
    expect(env.apps.size).toBe(1);
    expect(env.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const recovered = await provisionPlatformAccess(
      env.client,
      { ...input, login: { ...input.login, clientSecret: 'recovered-secret' } },
      state,
      save,
    );
    expect(recovered.login?.clientSecret).toBe('recovered-secret');
    expect(env.apps.size).toBe(1);
  });

  it('connects an existing application without mutating its policies', async () => {
    const env = fixture();
    env.apps.set('external', {
      id: 'external',
      name: 'Externally managed',
      type: 'saas',
      allowed_idps: ['company-idp'],
      policies: [{ id: 'employees' }],
      saas_app: {
        auth_type: 'oidc',
        client_id: 'external-client',
        redirect_uris: [`${base.apiUrl}/auth/callback`],
        grant_types: ['authorization_code_with_pkce'],
        allow_pkce_without_client_secret: false,
      },
    });
    const result = await provisionPlatformAccess(
      env.client,
      {
        ...base,
        login: {
          id: 'access',
          label: 'Access',
          applicationId: 'external',
          clientSecret: 'external-secret',
        },
      },
      fresh(),
      () => {},
    );
    expect(result.resources).toMatchObject([{ id: 'external', adopted: true }]);
    expect(env.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
});
