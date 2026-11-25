import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { cfAccessHeaders } from '../../src/shared/cf-access.ts';

const keyring = vi.hoisted(() => ({
  read: vi.fn((): string | null => null),
  write: vi.fn(() => true),
}));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: keyring.read,
  writeKeyringPassword: keyring.write,
}));

describe('cfAccessHeaders', () => {
  it('returns empty when nothing is set', () => {
    expect(cfAccessHeaders({}, 'https://api.staging.void.cloud')).toEqual({});
  });

  it('prefers service-token pair over CF_ACCESS_TOKEN', () => {
    expect(
      cfAccessHeaders(
        {
          CF_ACCESS_CLIENT_ID: 'id',
          CF_ACCESS_CLIENT_SECRET: 'secret',
          CF_ACCESS_TOKEN: 'jwt',
          VOID_ACCESS_ORIGIN: 'https://api.staging.void.cloud',
        },
        'https://api.staging.void.cloud',
      ),
    ).toEqual({
      'CF-Access-Client-Id': 'id',
      'CF-Access-Client-Secret': 'secret',
    });
  });

  it('falls back to CF_ACCESS_TOKEN when service token is incomplete', () => {
    expect(
      cfAccessHeaders(
        {
          CF_ACCESS_CLIENT_ID: 'id',
          CF_ACCESS_TOKEN: 'jwt',
          VOID_ACCESS_ORIGIN: 'https://proxy.staging.void.cloud',
        },
        'https://proxy.staging.void.cloud',
      ),
    ).toEqual({ 'cf-access-token': 'jwt' });
  });

  it('ignores empty strings', () => {
    expect(
      cfAccessHeaders(
        {
          CF_ACCESS_CLIENT_ID: '',
          CF_ACCESS_CLIENT_SECRET: '',
          CF_ACCESS_TOKEN: '',
        },
        'https://api.staging.void.cloud',
      ),
    ).toEqual({});
  });

  it('ignores non-string values', () => {
    expect(
      cfAccessHeaders(
        {
          CF_ACCESS_CLIENT_ID: 123,
          CF_ACCESS_CLIENT_SECRET: { a: 1 },
          CF_ACCESS_TOKEN: null,
        },
        'https://api.staging.void.cloud',
      ),
    ).toEqual({});
  });

  it('never sends shared Access credentials to a connected third-party origin', () => {
    expect(
      cfAccessHeaders(
        {
          CF_ACCESS_CLIENT_ID: 'staging-id',
          CF_ACCESS_CLIENT_SECRET: 'staging-secret',
          CF_ACCESS_TOKEN: 'staging-jwt',
        },
        'https://platform.example.test',
      ),
    ).toEqual({});
  });

  it('requires explicit exact-origin scoping before sending CI credentials to a self-hosted platform', () => {
    const env = {
      CF_ACCESS_CLIENT_ID: 'ci-id',
      CF_ACCESS_CLIENT_SECRET: 'ci-secret',
      VOID_ACCESS_ORIGIN: 'https://platform.example.com',
    };
    expect(cfAccessHeaders(env, 'https://platform.example.com/projects')).toEqual({
      'CF-Access-Client-Id': 'ci-id',
      'CF-Access-Client-Secret': 'ci-secret',
    });
    for (const target of [
      'https://other.example.com',
      'https://platform.example.com.evil.net',
      'http://platform.example.com',
      'https://user:password@platform.example.com',
      'https://api.staging.void.cloud',
    ]) {
      expect(cfAccessHeaders(env, target)).toEqual({});
    }
  });

  it('supports separate API and proxy credentials without sharing them across origins', () => {
    const env = {
      VOID_ACCESS_CREDENTIALS: JSON.stringify({
        'https://api.example.com': { CF_ACCESS_TOKEN: 'api-token' },
        'https://proxy.example.com': {
          CF_ACCESS_CLIENT_ID: 'proxy-id',
          CF_ACCESS_CLIENT_SECRET: 'proxy-secret',
        },
      }),
    };
    expect(cfAccessHeaders(env, 'https://api.example.com/me')).toEqual({
      'cf-access-token': 'api-token',
    });
    expect(cfAccessHeaders(env, 'https://proxy.example.com/kv')).toEqual({
      'CF-Access-Client-Id': 'proxy-id',
      'CF-Access-Client-Secret': 'proxy-secret',
    });
    expect(cfAccessHeaders(env, 'https://api.example.com:444/me')).toEqual({});
  });

  it('does not fall back to broad credentials when explicit scoping is malformed', () => {
    for (const encoded of [
      'invalid',
      '[]',
      'null',
      JSON.stringify({ 'https://api.staging.void.cloud': 'invalid' }),
    ]) {
      expect(
        cfAccessHeaders(
          { CF_ACCESS_TOKEN: 'shared-secret', VOID_ACCESS_CREDENTIALS: encoded },
          'https://api.staging.void.cloud',
        ),
      ).toEqual({});
    }
  });
});

const spawnSyncMock =
  vi.fn<
    (
      command: string,
      args: Array<string>,
      options: import('node:child_process').SpawnSyncOptionsWithStringEncoding,
    ) => { status: number; stdout: string }
  >();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: Parameters<typeof spawnSyncMock>) => spawnSyncMock(...args),
}));

describe('origin-scoped self-hosted Access login', () => {
  const jwt = (expiry: number) =>
    `e30.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`;
  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockReset();
    keyring.read.mockReset().mockReturnValue(null);
    keyring.write.mockReset().mockReturnValue(true);
    for (const name of [
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'CF_ACCESS_TOKEN',
      'VOID_ACCESS_CREDENTIALS',
      'VOID_ACCESS_ORIGIN',
    ]) {
      vi.stubEnv(name, '');
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it('loads a keychain token only for its selected origin', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 600);
    keyring.read.mockReturnValue(token);
    const { ensurePlatformAccessToken } = await import('../../src/cli/cf-access.ts');
    ensurePlatformAccessToken('https://api.example.com');
    expect(cfAccessHeaders(process.env, 'https://api.example.com')).toEqual({
      'cf-access-token': token,
    });
    expect(cfAccessHeaders(process.env, 'https://other.example.com')).toEqual({});
    expect(process.env.CF_ACCESS_TOKEN).toBe('');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('reuses a valid cached human token when Access is known to be required', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 600);
    keyring.read.mockReturnValue(token);
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    try {
      const { ensurePlatformAccessToken } = await import('../../src/cli/cf-access.ts');
      ensurePlatformAccessToken('https://api.example.com', false, true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty });
    }
    expect(cfAccessHeaders(process.env, 'https://api.example.com')).toEqual({
      'cf-access-token': token,
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('acquires a separate proxy token for development and never reuses the API audience', async () => {
    const apiToken = jwt(Math.floor(Date.now() / 1000) + 600);
    const proxyToken = jwt(Math.floor(Date.now() / 1000) + 900);
    process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({
      'https://api.example.com': { CF_ACCESS_TOKEN: apiToken },
    });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: proxyToken });
    const { ensurePlatformProxyAccess } = await import('../../src/cli/cf-access.ts');
    ensurePlatformProxyAccess('https://api.example.com', 'https://proxy.example.com');
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
      'access',
      'token',
      '-app=https://proxy.example.com',
    ]);
    expect(cfAccessHeaders(process.env, 'https://proxy.example.com')).toEqual({
      'cf-access-token': proxyToken,
    });
    expect(cfAccessHeaders(process.env, 'https://api.example.com')).toEqual({
      'cf-access-token': apiToken,
    });
  });
  it('does not probe Access for ordinary unprotected development', async () => {
    const { ensurePlatformProxyAccess } = await import('../../src/cli/cf-access.ts');
    ensurePlatformProxyAccess('https://api.example.com', 'https://proxy.example.com');
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(process.env.VOID_ACCESS_CREDENTIALS).toBe('');
  });
  it('refreshes an expired cached token without storing it in a project file', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 600);
    keyring.read.mockReturnValue(jwt(1));
    spawnSyncMock.mockReturnValue({ status: 0, stdout: token });
    const { ensurePlatformAccessToken } = await import('../../src/cli/cf-access.ts');
    ensurePlatformAccessToken('https://api.example.com');
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
      'access',
      'token',
      '-app=https://api.example.com',
    ]);
    expect(keyring.write).toHaveBeenCalledWith('dev.void.cli.access', expect.any(String), token);
    expect(cfAccessHeaders(process.env, 'https://api.example.com')).toEqual({
      'cf-access-token': token,
    });
  });

  it('forces interactive renewal after Access rejects an otherwise unexpired cached token', async () => {
    const rejected = jwt(Math.floor(Date.now() / 1000) + 600);
    const fresh = jwt(Math.floor(Date.now() / 1000) + 900);
    keyring.read.mockReturnValue(rejected);
    spawnSyncMock.mockImplementation((_command, args: Array<string>) =>
      args[1] === 'login' ? { status: 0, stdout: '' } : { status: 0, stdout: fresh },
    );
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      const { ensurePlatformAccessToken } = await import('../../src/cli/cf-access.ts');
      ensurePlatformAccessToken('https://api.example.com', true);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTty });
    }
    expect(spawnSyncMock.mock.calls.map((call) => call[1])).toEqual([
      ['access', 'login', 'https://api.example.com'],
      ['access', 'token', '-app=https://api.example.com'],
    ]);
    expect(cfAccessHeaders(process.env, 'https://api.example.com')).toEqual({
      'cf-access-token': fresh,
    });
    expect(keyring.write).toHaveBeenCalledWith('dev.void.cli.access', expect.any(String), fresh);
  });

  it('does not treat arbitrary redirects as company authentication challenges', async () => {
    const { isCloudflareAccessChallenge } = await import('../../src/cli/cf-access.ts');
    expect(
      isCloudflareAccessChallenge(
        new Response(null, {
          status: 302,
          headers: {
            Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com',
          },
        }),
      ),
    ).toBe(true);
    for (const location of [
      'https://team.cloudflareaccess.com.attacker.example/cdn-cgi/access/login',
      'https://attacker.example/login',
      'http://team.cloudflareaccess.com/cdn-cgi/access/login',
    ]) {
      expect(
        isCloudflareAccessChallenge(
          new Response(null, { status: 302, headers: { Location: location } }),
        ),
      ).toBe(false);
    }
  });

  it('retries only discovery at the original origin after acquiring its Access token', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 600);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: token });
    const discovery = {
      schemaVersion: 1,
      apiUrl: 'https://api.example.com',
      proxyUrl: 'https://proxy.example.com',
      applicationDomain: 'apps.example.com',
      displayName: 'Company',
      installationId: 'company',
      platformVersion: '0.20.0',
      authenticationProviders: ['github'],
      capabilities: {
        ai: true,
        email: false,
        customDomains: false,
        githubActions: false,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      },
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/api.example.com',
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(discovery));
    const { discoverPlatform } = await import('../../src/cli/platform-cmd.ts');
    expect(await discoverPlatform('https://api.example.com', request)).toMatchObject({
      apiUrl: discovery.apiUrl,
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.com/.well-known/void-platform',
      'https://api.example.com/.well-known/void-platform',
    ]);
    const [firstRequest, secondRequest] = request.mock.calls;
    expect(new Headers(firstRequest?.[1]?.headers).has('cf-access-token')).toBe(false);
    expect(new Headers(secondRequest?.[1]?.headers).get('cf-access-token')).toBe(token);
    expect(request.mock.calls.every(([, options]) => options?.redirect === 'manual')).toBe(true);
  });
});

describe('ensurePlatformAccessToken defaults', () => {
  it.each([
    'https://api.void.cloud',
    'https://api.staging.void.cloud',
    'https://proxy.staging.void.cloud',
  ])('does not implicitly authenticate a former hosted origin: %s', async (origin) => {
    vi.resetModules();
    spawnSyncMock.mockReset();
    keyring.read.mockReset().mockReturnValue(null);
    vi.stubEnv('CF_ACCESS_TOKEN', 'unscoped-token');
    vi.stubEnv('VOID_ACCESS_ORIGIN', '');
    vi.stubEnv('VOID_ACCESS_CREDENTIALS', '');
    const { ensurePlatformAccessToken } = await import('../../src/cli/cf-access.ts');
    ensurePlatformAccessToken(origin);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(cfAccessHeaders(process.env, origin)).toEqual({});
    vi.unstubAllEnvs();
  });
});
