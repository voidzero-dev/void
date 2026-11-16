import { describe, expect, it } from 'vite-plus/test';
import { resolveVoidAuthOptions } from '../../src/runtime/auth/better-auth-d1.ts';
import { voidAuthPassword } from '../../src/runtime/auth/better-auth-shared.ts';

describe('resolveVoidAuthOptions', () => {
  it('defaults to email auth when no providers are configured', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
      },
      {
        dialect: 'sqlite',
        providers: null,
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password: voidAuthPassword,
    });
    expect(options.socialProviders).toBeUndefined();
  });

  it('resolves configured social providers from standardized env vars', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
        AUTH_DISCORD_CLIENT_ID: 'discord-id',
        AUTH_DISCORD_CLIENT_SECRET: 'discord-secret',
        AUTH_GITHUB_CLIENT_ID: 'github-id',
        AUTH_GITHUB_CLIENT_SECRET: 'github-secret',
      },
      {
        dialect: 'sqlite',
        providers: ['email', 'discord', 'github'],
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password: voidAuthPassword,
    });
    expect(options.socialProviders).toEqual({
      discord: {
        clientId: 'discord-id',
        clientSecret: 'discord-secret',
      },
      github: {
        clientId: 'github-id',
        clientSecret: 'github-secret',
      },
    });
  });

  it('preserves the default password handler when email auth is customized', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
      },
      {
        dialect: 'sqlite',
        providers: null,
        userConfig: {
          emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
          },
        },
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password: voidAuthPassword,
      requireEmailVerification: true,
    });
  });

  it('requires both standardized credential names for a social provider', async () => {
    const legacy = { GITHUB_OAUTH_ID: 'old-id', GITHUB_OAUTH_SECRET: 'old-secret' };
    for (const credentials of [
      legacy,
      { ...legacy, AUTH_GITHUB_CLIENT_ID: 'new-id' },
      { ...legacy, AUTH_GITHUB_CLIENT_SECRET: 'new-secret' },
    ]) {
      await expect(
        resolveVoidAuthOptions(
          new Request('https://example.com/api/auth'),
          { BETTER_AUTH_SECRET: 'secret', ...credentials },
          { dialect: 'sqlite', providers: ['github'] },
          {} as never,
        ),
      ).rejects.toThrow(
        "auth: Missing credentials for provider 'github'. Set AUTH_GITHUB_CLIENT_ID and AUTH_GITHUB_CLIENT_SECRET",
      );
    }
  });

  it('passes the Cognito domain, region and user pool id from env', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
        AUTH_COGNITO_CLIENT_ID: 'cognito-id',
        AUTH_COGNITO_CLIENT_SECRET: 'cognito-secret',
        AUTH_COGNITO_DOMAIN: 'app.auth.us-east-1.amazoncognito.com',
        AUTH_COGNITO_REGION: 'us-east-1',
        AUTH_COGNITO_USER_POOL_ID: 'us-east-1_abc',
      },
      { dialect: 'sqlite', providers: ['email', 'cognito'] },
      {} as never,
    );

    expect(options.socialProviders).toEqual({
      cognito: {
        clientId: 'cognito-id',
        clientSecret: 'cognito-secret',
        domain: 'app.auth.us-east-1.amazoncognito.com',
        region: 'us-east-1',
        userPoolId: 'us-east-1_abc',
      },
    });
  });

  it('names only the missing Cognito settings', async () => {
    for (const [settings, message] of [
      [
        {},
        'auth: Missing domain, region and userPoolId for the cognito provider. Set AUTH_COGNITO_DOMAIN, AUTH_COGNITO_REGION and AUTH_COGNITO_USER_POOL_ID, or set domain, region and userPoolId in auth.ts.',
      ],
      [
        {
          AUTH_COGNITO_DOMAIN: 'app.auth.us-east-1.amazoncognito.com',
          AUTH_COGNITO_USER_POOL_ID: 'us-east-1_abc',
        },
        'auth: Missing region for the cognito provider. Set AUTH_COGNITO_REGION, or set region in auth.ts.',
      ],
    ] as const) {
      await expect(
        resolveVoidAuthOptions(
          new Request('https://example.com/api/auth'),
          {
            BETTER_AUTH_SECRET: 'secret',
            AUTH_COGNITO_CLIENT_ID: 'cognito-id',
            AUTH_COGNITO_CLIENT_SECRET: 'cognito-secret',
            ...settings,
          },
          { dialect: 'sqlite', providers: ['cognito'] },
          {} as never,
        ),
      ).rejects.toThrow(message);
    }
  });

  it('accepts Cognito settings from auth.ts', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
        AUTH_COGNITO_CLIENT_ID: 'cognito-id',
        AUTH_COGNITO_CLIENT_SECRET: 'cognito-secret',
        AUTH_COGNITO_REGION: 'us-east-1',
      },
      {
        dialect: 'sqlite',
        providers: ['cognito'],
        userConfig: ({ defaults }) => ({
          ...defaults,
          socialProviders: {
            ...defaults.socialProviders,
            cognito: {
              ...(defaults.socialProviders?.cognito as {
                clientId: string;
                clientSecret: string;
                region: string;
              }),
              domain: 'app.auth.us-east-1.amazoncognito.com',
              userPoolId: 'us-east-1_abc',
            },
          },
        }),
      },
      {} as never,
    );

    expect(options.socialProviders).toEqual({
      cognito: {
        clientId: 'cognito-id',
        clientSecret: 'cognito-secret',
        domain: 'app.auth.us-east-1.amazoncognito.com',
        region: 'us-east-1',
        userPoolId: 'us-east-1_abc',
      },
    });
  });

  it('preserves a custom password handler when email auth is customized', async () => {
    const password = {
      async hash(value: string) {
        return `custom:${value}`;
      },
      async verify() {
        return true;
      },
    };

    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
      },
      {
        dialect: 'sqlite',
        providers: null,
        userConfig: {
          emailAndPassword: {
            enabled: true,
            password,
          },
        },
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password,
    });
  });

  it('requires BETTER_AUTH_SECRET in production when none is set', async () => {
    await expect(
      resolveVoidAuthOptions(
        new Request('https://example.com/api/auth'),
        {
          AUTH_SECRET: 'legacy-secret',
        },
        {
          dialect: 'sqlite',
          providers: null,
        },
        {} as never,
      ),
    ).rejects.toThrow('auth: Missing Better Auth secret. Set BETTER_AUTH_SECRET.');
  });

  it('uses the fallback only in dev, regardless of the request host', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {},
      {
        dialect: 'sqlite',
        providers: null,
        dev: true,
      },
      {} as never,
    );

    expect(options.secret).toBe('void-dev-better-auth-secret-1234567890');
  });

  it('prefers BETTER_AUTH_SECRET over the dev fallback', async () => {
    const options = await resolveVoidAuthOptions(
      new Request('http://localhost:3000/api/auth'),
      { BETTER_AUTH_SECRET: 'configured-secret' },
      { dialect: 'sqlite', providers: null, dev: true },
      {} as never,
    );

    expect(options.secret).toBe('configured-secret');
  });

  it('uses a native scrypt password handler compatible with Better Auth hashes', async () => {
    const hash = await voidAuthPassword.hash('correct horse battery staple');

    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    await expect(
      voidAuthPassword.verify({
        hash,
        password: 'correct horse battery staple',
      }),
    ).resolves.toBe(true);
    await expect(
      voidAuthPassword.verify({
        hash,
        password: 'wrong password',
      }),
    ).resolves.toBe(false);
  });

  it('verifies existing Better Auth scrypt hashes', async () => {
    const hash =
      '0123456789abcdeffedcba9876543210:bb68a5c89332e634a98a2ca6f60e2d68861b64f1fa59446dd8669396e5b76a66059da52a9ce48b43bddfc319aceddf788125882ae27c395f90306cb47e8264ae';

    await expect(
      voidAuthPassword.verify({
        hash,
        password: 'correct horse battery staple',
      }),
    ).resolves.toBe(true);
  });

  it('treats unsupported password hash formats as invalid credentials', async () => {
    await expect(
      voidAuthPassword.verify({
        hash: 'sha256-pbkdf2:1000:salt:hash',
        password: 'password',
      }),
    ).resolves.toBe(false);
    await expect(
      voidAuthPassword.verify({
        hash: '0123456789abcdeffedcba9876543210:not-hex',
        password: 'password',
      }),
    ).resolves.toBe(false);
  });
});

describe('resolveVoidAuthOptions auth rate limits', () => {
  function plainRequest(headers: Record<string, string>): Request {
    return new Request('https://example.com/api/auth/sign-in/email', { headers });
  }

  function edgeRequest(headers: Record<string, string>): Request {
    const request = plainRequest(headers);
    Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });
    return request;
  }

  function resolve(
    request: Request,
    runtime: Partial<Parameters<typeof resolveVoidAuthOptions>[2]> = {},
  ) {
    return resolveVoidAuthOptions(
      request,
      { BETTER_AUTH_SECRET: 'secret' },
      { dialect: 'sqlite', providers: null, ...runtime },
      {} as never,
    );
  }

  it('limits auth requests per Cloudflare client IP on a deployed Worker', async () => {
    const options = await resolve(edgeRequest({ 'cf-connecting-ip': '203.0.113.7' }));
    expect(options.rateLimit?.enabled).toBe(true);
    expect(options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['cf-connecting-ip']);
  });

  it('leaves the dev server unlimited', async () => {
    const options = await resolve(edgeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {
      dev: true,
    });
    expect(options.rateLimit).toBeUndefined();
  });

  it('does not trust the Cloudflare IP header outside a Worker', async () => {
    const options = await resolve(plainRequest({ 'cf-connecting-ip': '203.0.113.7' }));
    expect(options.rateLimit).toBeUndefined();
    expect(options.advanced).toBeUndefined();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'leaves a local preview from %s unlimited',
    async (ip) => {
      const options = await resolve(edgeRequest({ 'cf-connecting-ip': ip }));
      expect(options.rateLimit).toBeUndefined();
      expect(options.advanced).toBeUndefined();
    },
  );

  it('does not share one bucket for requests without a client IP', async () => {
    const options = await resolve(edgeRequest({}));
    expect(options.rateLimit).toBeUndefined();
    expect(options.advanced).toBeUndefined();
  });

  it('keeps an explicit rateLimit setting', async () => {
    const options = await resolve(edgeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {
      userConfig: { rateLimit: { enabled: false, window: 60 } },
    });
    expect(options.rateLimit).toEqual({ enabled: false, window: 60 });
  });

  it('adds the client IP header next to other advanced settings', async () => {
    const options = await resolve(edgeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {
      userConfig: { advanced: { cookiePrefix: 'x' } },
    });
    expect(options.advanced).toEqual({
      cookiePrefix: 'x',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    });
  });

  it('keeps an explicit ipAddress setting', async () => {
    const ipAddress = { ipAddressHeaders: ['x-real-ip'], ipv6Subnet: 48 };
    const options = await resolve(edgeRequest({ 'cf-connecting-ip': '203.0.113.7' }), {
      userConfig: { advanced: { ipAddress } },
    });
    expect(options.advanced?.ipAddress).toBe(ipAddress);
    expect(options.rateLimit?.enabled).toBe(true);
  });
});
