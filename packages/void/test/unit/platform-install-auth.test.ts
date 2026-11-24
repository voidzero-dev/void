import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlatformAuthenticationSetup } from '@void/platform';
import { password, text } from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import type { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import {
  authenticationSetupRequestHash,
  collectInstallationAuthentication,
  replacePendingInstallationAuthentication,
  selectInstallationAuthentication,
  platformManagementAccessForAuthentication,
} from '../../src/cli/platform-install-auth.ts';
import { createPlatformInstallationSecrets } from '../../src/cli/platform-installer.ts';
import type { PlatformInstallPlan } from '../../src/cli/platform-plan.ts';

vi.mock('@voidzero-dev/vite-plus-prompts', async (original) => ({
  ...(await original<typeof import('@voidzero-dev/vite-plus-prompts')>()),
  password: vi.fn(),
  text: vi.fn(),
}));

let directory: string;
const plan = {
  apiUrl: 'https://api.example.com',
  proxyUrl: 'https://proxy.example.com',
} as PlatformInstallPlan;
const input = {
  connections: [
    {
      configuration: {
        id: 'google',
        kind: 'google',
        label: 'Company Google',
        clientId: 'google-client',
        allowedDomains: ['example.com'],
      },
      clientSecretEnv: 'TEST_PLATFORM_GOOGLE_SECRET',
    },
  ],
  admission: { mode: 'company', connections: ['google'], access: false },
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'void-install-auth-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('installer login selection', () => {
  it('requests Access management only for setup in the installation account', () => {
    const selection = {
      authentication: {
        providers: ['cloudflare-access'] as const,
        configurable: true as const,
        accessProtection: true as const,
      },
    };
    expect(platformManagementAccessForAuthentication(selection, 'account', null)).toEqual({
      protection: true,
      readOnly: false,
    });
    expect(
      platformManagementAccessForAuthentication(
        {
          ...selection,
          authentication: { providers: ['github'], configurable: true, accessProtection: true },
        },
        'account',
        null,
      ),
    ).toEqual({ protection: true, readOnly: false });
    expect(
      platformManagementAccessForAuthentication(selection, 'account', {
        accessSetupSpecJson: JSON.stringify({ mode: 'existing', accountId: 'other' }),
      }),
    ).toBeUndefined();
    expect(
      platformManagementAccessForAuthentication(selection, 'account', {
        accessSetupSpecJson: JSON.stringify({ mode: 'existing', accountId: 'account' }),
      }),
    ).toEqual({ protection: true, readOnly: true });
    expect(
      platformManagementAccessForAuthentication(
        {
          authentication: { providers: ['cloudflare-access'], configurable: true },
          file: { connections: [{ configuration: { kind: 'cloudflare-access' } }] },
        },
        'account',
        null,
      ),
    ).toBeUndefined();
    expect(
      platformManagementAccessForAuthentication(
        { authentication: { providers: ['github'] } },
        'account',
        null,
      ),
    ).toBeUndefined();
  });
  it('uses planned login and protection choices without interactive selection', async () => {
    expect(
      await selectInstallationAuthentication(undefined, undefined, {
        loginMethods: ['google', 'oidc'],
        accessProtection: true,
      }),
    ).toEqual({
      authentication: { providers: ['google', 'oidc'], configurable: true, accessProtection: true },
    });
    expect(
      await selectInstallationAuthentication(undefined, undefined, {
        loginMethods: ['github'],
        accessProtection: false,
      }),
    ).toEqual({ authentication: { providers: ['github'] } });
    await expect(
      selectInstallationAuthentication(
        undefined,
        { providers: ['github'] },
        { loginMethods: ['google'], accessProtection: false },
      ),
    ).rejects.toThrow('recorded');
    await expect(
      selectInstallationAuthentication(
        undefined,
        { providers: ['github'] },
        { accessProtection: true },
      ),
    ).rejects.toThrow('recorded');
  });
  it('connects Access login in a separate identity account without Cloudflare management calls', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(
      file,
      JSON.stringify({
        connections: [
          {
            configuration: {
              id: 'company-access',
              kind: 'cloudflare-access',
              label: 'Company Access',
              issuer:
                'https://identity.cloudflareaccess.com/cdn-cgi/access/sso/oidc/external-client',
              clientId: 'external-client',
            },
            clientSecretEnv: 'TEST_EXTERNAL_SECRET',
          },
        ],
      }),
    );
    vi.stubEnv('TEST_EXTERNAL_SECRET', 'external-secret');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const request = vi.fn(() => {
      throw new Error('No Cloudflare management calls expected');
    });
    const selection = await selectInstallationAuthentication(file);
    const result = await collectInstallationAuthentication(selection, plan, {}, () => {}, {
      client: { request } as unknown as PlatformCloudflareClient,
      ownershipNonce: 'owned',
      yes: true,
    });
    expect(JSON.parse(result!.authenticationSetupJson).connections[0].configuration.id).toBe(
      'company-access',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('reads a nonsecret plan without requiring provider credentials', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(file, JSON.stringify(input));
    const selection = await selectInstallationAuthentication(file);
    expect(selection.authentication).toEqual({ providers: ['google'], configurable: true });
  });
  it('keeps recorded GitHub-only installation selection unchanged', async () => {
    expect(await selectInstallationAuthentication(undefined, { providers: ['github'] })).toEqual({
      authentication: { providers: ['github'] },
    });
    expect(
      await collectInstallationAuthentication(
        { authentication: { providers: ['github'] } },
        plan,
        {},
        () => {},
      ),
    ).toBeUndefined();
  });
  it('resolves secrets only during credential collection and checkpoints each connection', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(file, JSON.stringify(input));
    vi.stubEnv('TEST_PLATFORM_GOOGLE_SECRET', 'secret-from-environment');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const values: Record<string, string> = {};
    const selection = await selectInstallationAuthentication(file);
    const result = (await collectInstallationAuthentication(selection, plan, values, (update) =>
      Object.assign(values, update),
    ))!;
    const setup = JSON.parse(result.authenticationSetupJson);
    expect(setup.connections[0].clientSecret).toBe('secret-from-environment');
    expect(setup.bootstrapCredentialHash).toBe(
      createHash('sha256').update(result.authBootstrapCode).digest('hex'),
    );
    expect(values['authenticationConnection:google']).toBeTruthy();
    expect(JSON.stringify(output.mock.calls)).not.toContain('secret-from-environment');
    const resumed = await collectInstallationAuthentication(
      { authentication: selection.authentication },
      plan,
      values,
      () => {
        throw new Error('no new checkpoint expected');
      },
    );
    expect(resumed).toEqual(result);
    const secrets = createPlatformInstallationSecrets({
      ...result,
      bootstrapGitHubId: '',
      bootstrapGitHubLogin: '',
      githubClientId: '',
      githubClientSecret: '',
      cloudflareApiToken: 'runtime',
      databaseUrl: 'postgresql://user:password@db.example.com/platform',
      jwtSecret: 'j'.repeat(32),
      projectSecretKey: Buffer.alloc(32, 3).toString('base64'),
      r2AccessKeyId: 'r2',
      r2SecretAccessKey: 'r2-secret',
    });
    expect(secrets.githubClientId).toBe('');
    expect(secrets.bootstrapGitHubLogin).toBe('');
    expect(secrets.authSetupToken).toBe(result.authSetupToken);
  });
  it('rejects plaintext credential files and incompatible resume choices', async () => {
    const file = join(directory, 'auth.json');
    await writeFile(
      file,
      JSON.stringify({ connections: [{ ...input.connections[0], clientSecret: 'plaintext' }] }),
    );
    await expect(selectInstallationAuthentication(file)).rejects.toThrow('plaintext');
    await writeFile(file, JSON.stringify(input));
    await expect(selectInstallationAuthentication(file, { providers: ['github'] })).rejects.toThrow(
      'recorded',
    );
  });
});

describe('pending login replacement', () => {
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const accessConnection = {
    configuration: {
      id: 'access',
      kind: 'cloudflare-access',
      label: 'Cloudflare Access',
      clientId: 'access-client',
      issuer: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client',
    },
    clientSecret: 'access-secret',
  };
  const protection = {
    teamDomain: 'https://team.cloudflareaccess.com',
    applications: [{ origin: 'https://api.example.com', audience: 'api-audience' }],
  };
  const previous = JSON.stringify(
    parsePlatformAuthenticationSetup({
      connections: [
        {
          configuration: {
            id: 'google',
            kind: 'google',
            label: 'Google',
            clientId: 'old-client',
            allowedDomains: ['example.com'],
          },
          clientSecret: 'old-google-secret',
        },
        accessConnection,
      ],
      administratorConnectionId: 'google',
      admission: { mode: 'restricted' },
      protection,
      bootstrapCredentialHash: sha256('previous-code'),
    }),
  );
  const authentication = {
    providers: ['google', 'cloudflare-access'] as Array<'google' | 'cloudflare-access'>,
    configurable: true as const,
    accessProtection: true as const,
  };
  const googleFile = {
    configuration: {
      id: 'google',
      kind: 'google',
      label: 'Google',
      clientId: 'new-client',
      allowedDomains: ['example.com'],
    },
    clientSecretEnv: 'TEST_NEW_GOOGLE_SECRET',
  };
  async function writeAuthFile(value: unknown): Promise<string> {
    const file = join(directory, 'replacement.json');
    await writeFile(file, JSON.stringify(value));
    return file;
  }
  function replace(file?: string) {
    return replacePendingInstallationAuthentication({
      ...(file ? { file } : {}),
      authentication,
      setupJson: previous,
      apiUrl: 'https://api.example.com',
    });
  }

  it('replaces the login settings from a file with a new setup code', async () => {
    vi.stubEnv('TEST_NEW_GOOGLE_SECRET', 'new-google-secret');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Listed in another order than installed, with the Access login kept by ID.
    const file = await writeAuthFile({
      connections: [{ configuration: { id: 'access', kind: 'cloudflare-access' } }, googleFile],
      protection,
    });
    const result = await replace(file);
    const setup = parsePlatformAuthenticationSetup(JSON.parse(result.authenticationSetupJson));
    expect(setup.resetPending).toBe(true);
    expect(setup.bootstrapCredentialHash).toBe(sha256(result.authBootstrapCode));
    expect(setup.bootstrapCredentialHash).not.toBe(sha256('previous-code'));
    expect(setup.connections.map((entry) => entry.configuration.id)).toEqual(['access', 'google']);
    expect(setup.connections[1]).toMatchObject({
      configuration: { clientId: 'new-client' },
      clientSecret: 'new-google-secret',
    });
    expect(setup.connections[0]).toEqual(JSON.parse(previous).connections[1]);
    expect(setup.protection).toEqual(protection);
    expect(setup.administratorConnectionId).toBe('google');
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('https://api.example.com/auth/callback'),
    );
    expect(JSON.stringify(output.mock.calls)).not.toContain('new-google-secret');
    // The platform records the same hash whether or not the request resets setup.
    expect(authenticationSetupRequestHash(result.authenticationSetupJson)).toBe(
      authenticationSetupRequestHash(JSON.stringify({ ...setup, resetPending: undefined })),
    );
  });

  it('refuses a file that changes login methods or Access protection', async () => {
    vi.stubEnv('TEST_NEW_GOOGLE_SECRET', 'new-google-secret');
    const otherMethod = await writeAuthFile({
      connections: [
        { configuration: { id: 'access', kind: 'cloudflare-access' } },
        {
          configuration: {
            kind: 'oidc',
            label: 'SSO',
            issuer: 'https://sso.example.com',
            clientId: 'c',
          },
          clientSecretEnv: 'TEST_NEW_GOOGLE_SECRET',
        },
      ],
      protection,
    });
    await expect(replace(otherMethod)).rejects.toThrow(
      'Repair changes login settings, not which login methods or Access protection',
    );
    const unprotected = await writeAuthFile({
      connections: [{ configuration: { id: 'access', kind: 'cloudflare-access' } }, googleFile],
    });
    await expect(replace(unprotected)).rejects.toThrow(
      'not which login methods or Access protection',
    );
  });

  it('keeps every installed connection when several share a kind', async () => {
    vi.stubEnv('TEST_NEW_OIDC_SECRET', 'new-oidc-secret');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const oidc = (id: string) => ({
      configuration: {
        id,
        kind: 'oidc',
        label: id,
        issuer: `https://${id}.example.com`,
        clientId: `${id}-client`,
      },
    });
    const installed = JSON.stringify(
      parsePlatformAuthenticationSetup({
        connections: [
          { ...oidc('company'), clientSecret: 'company-secret' },
          { ...oidc('partner'), clientSecret: 'partner-secret' },
        ],
        administratorConnectionId: 'company',
        admission: { mode: 'restricted' },
        protection: null,
        bootstrapCredentialHash: sha256('previous-code'),
      }),
    );
    const replaceInstalled = async (ids: Array<string>) =>
      replacePendingInstallationAuthentication({
        file: await writeAuthFile({
          connections: ids.map((id) => ({ ...oidc(id), clientSecretEnv: 'TEST_NEW_OIDC_SECRET' })),
        }),
        authentication: { providers: ['oidc'], configurable: true },
        setupJson: installed,
        apiUrl: 'https://api.example.com',
      });
    for (const ids of [['company'], ['company', 'partner', 'vendor'], ['company', 'vendor']]) {
      await expect(replaceInstalled(ids)).rejects.toThrow(
        'List each installed connection with its ID: company, partner.',
      );
    }
    const setup = parsePlatformAuthenticationSetup(
      JSON.parse((await replaceInstalled(['partner', 'company'])).authenticationSetupJson),
    );
    expect(setup.connections.map((entry) => entry.configuration.id)).toEqual([
      'partner',
      'company',
    ]);
    expect(setup.administratorConnectionId).toBe('company');
  });

  it('asks for each setting with the saved value and keeps a secret left blank', async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(text)
        .mockResolvedValueOnce('changed-client')
        .mockResolvedValueOnce('example.com, corp.example.com');
      vi.mocked(password).mockResolvedValueOnce('');
      const setup = parsePlatformAuthenticationSetup(
        JSON.parse((await replace()).authenticationSetupJson),
      );
      expect(text).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'old-client' }));
      expect(text).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'example.com' }));
      expect(setup.connections[0]).toMatchObject({
        configuration: {
          clientId: 'changed-client',
          allowedDomains: ['example.com', 'corp.example.com'],
        },
        clientSecret: 'old-google-secret',
      });
      expect(setup.connections[1]).toEqual(JSON.parse(previous).connections[1]);
      expect(setup.resetPending).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });
});
