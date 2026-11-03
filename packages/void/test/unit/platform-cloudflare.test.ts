import { describe, expect, it } from 'vite-plus/test';
import {
  hyperdriveOriginConfigHash,
  hyperdriveOriginFromConnectionString,
  parsePostgresConnectionString,
  PlatformCloudflareApiError,
  PlatformCloudflareClient,
  PlatformRuntimeTokenEmailPermissionError,
  PlatformWorkerCustomDomainsChangedError,
  verifyPlatformRuntimeTokenEmailPermissions,
  verifyPlatformRuntimeTokenPermissions,
} from '../../src/cli/platform-cloudflare.ts';

describe('platform Cloudflare client', () => {
  it('uses the runtime credential only for AI Gateway operations while keeping the API origin pinned', async () => {
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const client = new PlatformCloudflareClient('operator-token', {
      apiBase: 'https://cloudflare.example.test/client/v4',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('https://cloudflare.example.test');
        requests.push({
          path: url.pathname,
          authorization: new Headers(init?.headers).get('Authorization'),
        });
        return Response.json({
          success: true,
          result: init?.method === 'POST' ? { id: 'gateway' } : [],
        });
      },
    }).withAiGatewayToken('runtime-token');
    await client.listAiGateways('account');
    await client.createAiGateway('account', 'gateway');
    await client.listWorkerNames('account');
    expect(requests.map((request) => request.authorization)).toEqual([
      'Bearer runtime-token',
      'Bearer runtime-token',
      'Bearer operator-token',
    ]);
  });

  it('identifies the rejected API operation without including query parameters or credentials', async () => {
    const client = new PlatformCloudflareClient('secret-token', {
      fetcher: async () =>
        Response.json(
          { success: false, errors: [{ message: 'Authentication error' }] },
          { status: 403 },
        ),
    });
    const error = await client
      .request('/accounts/account/ai-gateway/gateways?secret=query-value')
      .catch((error) => error as Error);
    expect((error as Error).message).toContain(
      'HTTP 403; GET /accounts/account/ai-gateway/gateways',
    );
    expect((error as Error).message).not.toContain('query-value');
    expect((error as Error).message).not.toContain('secret-token');
  });

  it.each([
    {
      code: 10042,
      path: '/accounts/account/r2/buckets',
      message: 'Please enable R2 through the Cloudflare Dashboard.',
      guidance: 'Cloudflare R2 is not enabled for this account (code 10042).',
      dashboard: 'https://dash.cloudflare.com/account/r2/overview',
    },
    {
      code: 10121,
      path: '/accounts/account/workers/dispatch/namespaces',
      message:
        'You do not have access to dispatch namespaces. Purchase at https://dash.cloudflare.com?to=/:account/workers-for-platforms',
      guidance:
        'Cloudflare Workers for Platforms requires a paid subscription for this account (code 10121).',
      dashboard: 'https://dash.cloudflare.com/account/workers-for-platforms',
    },
  ])('explains prerequisite code $code while preserving provider diagnostics', async (test) => {
    const client = new PlatformCloudflareClient('secret-token', {
      fetcher: async () =>
        Response.json(
          { success: false, errors: [{ code: test.code, message: test.message }] },
          { status: 403 },
        ),
    });
    const error = await client.request(`${test.path}?secret=query-value`).catch((error) => error);
    if (!(error instanceof PlatformCloudflareApiError)) {
      throw new Error('Expected a Cloudflare API error', { cause: error });
    }
    expect(error).toMatchObject({ status: 403, requestPath: test.path });
    expect(error.message.startsWith(test.guidance)).toBe(true);
    expect(error.message).toContain(test.dashboard);
    expect(error.message).toContain('retry the same command');
    expect(error.cause).toBeInstanceOf(PlatformCloudflareApiError);
    expect(error.cause).toMatchObject({
      status: 403,
      requestPath: test.path,
      message: `Cloudflare API error: ${test.message} (code ${test.code}) (HTTP 403; GET ${test.path}).`,
    });
    expect(error.message).not.toContain(test.message);
    expect(error.message).not.toContain('HTTP 403');
    expect(error.message).not.toContain(test.path);
    expect(error.message).not.toContain('--resume');
    expect(error.message).not.toContain('query-value');
    expect(error.message).not.toContain('secret-token');
    if (test.code === 10121) {
      expect(error.message).toContain('Enterprise customers');
    }
  });

  it.each([
    { status: 401, code: 10000, path: '/accounts/account/r2/buckets' },
    { status: 403, code: 10000, path: '/accounts/account/r2/buckets' },
    { status: 403, code: 10042, path: '/accounts/account/ai-gateway/gateways' },
    { status: 500, code: 7000, path: '/accounts/account/ai-gateway/gateways' },
  ])('keeps unrelated provider errors unchanged: $status/$code', async ({ status, code, path }) => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json(
          { success: false, errors: [{ code, message: 'Please enable R2' }] },
          { status },
        ),
    });
    await expect(client.request(path)).rejects.toMatchObject({
      status,
      requestPath: path,
      message: `Cloudflare API error: Please enable R2 (code ${code}) (HTTP ${status}; GET ${path}).`,
    });
  });

  it.each([401, 403, 429, 500, 503])(
    'distinguishes HTTP %s from missing workers.dev onboarding',
    async (status) => {
      const client = new PlatformCloudflareClient('secret-token', {
        fetcher: async () =>
          Response.json({ success: false, errors: [{ message: 'provider failure' }] }, { status }),
      });
      const error = await client.getWorkersSubdomain('account').catch((error) => error as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).not.toContain('finish Workers onboarding');
      expect((error as Error).message).not.toContain('secret-token');
      expect((error as Error).message).toContain(
        status === 401 || status === 403 ? 'permissions' : 'Rerun',
      );
    },
  );

  it('does not infer missing onboarding from a failed network request', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(client.getWorkersSubdomain('account')).rejects.toThrow('the request failed');
    await expect(client.getWorkersSubdomain('account')).rejects.toThrow(
      'no Workers onboarding change is needed',
    );
  });

  it('accepts an existing subdomain and handles an empty result without a property access error', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({ success: true, result: { subdomain: 'void-platform-e2e-test' } }),
    });
    await expect(client.getWorkersSubdomain('account')).resolves.toBe('void-platform-e2e-test');
    const empty = new PlatformCloudflareClient('token', {
      fetcher: async () => Response.json({ success: true, result: null }),
    });
    await expect(empty.getWorkersSubdomain('account')).rejects.toThrow(
      'does not have a workers.dev subdomain',
    );
  });
  it('explains workers.dev onboarding for a fresh account', async () => {
    const missing = new PlatformCloudflareClient('token', {
      fetcher: async () => Response.json({ success: true, result: { subdomain: null } }),
    });
    await expect(missing.getWorkersSubdomain('account')).rejects.toThrow(
      'https://dash.cloudflare.com/account/workers-and-pages',
    );

    const notOnboarded = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json(
          { errors: [{ message: 'workers.dev subdomain is not registered' }], success: false },
          { status: 404 },
        ),
    });
    await expect(notOnboarded.getWorkersSubdomain('account')).rejects.toThrow(
      'platform: Could not read the workers.dev subdomain for account account (HTTP 404). Open https://dash.cloudflare.com/account/workers-and-pages once to provision your account for Workers automatically, then retry the install.',
    );
  });

  it('requires an active deployed certificate for the exact application wildcard', async () => {
    const requested: Array<string> = [];
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const cert = (hosts: Array<string>, status = 'active', expires_on = future) => ({
      hosts,
      status,
      expires_on,
    });
    const client = new PlatformCloudflareClient('token', {
      apiBase: 'https://cloudflare.example.test/client/v4',
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        expect(init?.method ?? 'GET').toBe('GET');
        if (url.pathname.endsWith('/certificate_packs')) {
          expect(url.searchParams.get('deploy')).toBe('production');
          return Response.json({
            success: true,
            result: [
              {
                status: 'active',
                hosts: ['*.apps.example.com'],
                certificates: [cert(['*.example.com'])],
              },
              { certificates: [cert(['*.apps.example.com'], 'pending_validation')] },
              { certificates: [cert(['*.apps.example.com'], 'active', '2020-01-01T00:00:00Z')] },
            ],
          });
        }
        return Response.json({ success: true, result: [cert(['*.APPS.EXAMPLE.COM.'])] });
      },
    });
    await expect(
      client.hasActiveCertificateForHostname('zone', '*.apps.example.com'),
    ).resolves.toBe(true);
    expect(requested).toEqual([
      '/client/v4/zones/zone/ssl/certificate_packs',
      '/client/v4/zones/zone/custom_certificates',
    ]);
  });

  it('finds covering certificates on later pages and rejects pending-only coverage', async () => {
    const requested: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        requested.push(url.searchParams.get('page')!);
        return Response.json({
          success: true,
          result:
            url.searchParams.get('page') === '1'
              ? [{ certificates: [{ status: 'active', hosts: ['*.example.com'] }] }]
              : [{ certificates: [{ status: 'active', hosts: ['*.apps.example.com'] }] }],
          result_info: { total_pages: 2 },
        });
      },
    });
    await expect(
      client.hasActiveCertificateForHostname('zone', '*.apps.example.com'),
    ).resolves.toBe(true);
    expect(requested).toEqual(['1', '2']);
    const pending = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: [
            {
              status: 'pending_validation',
              hosts: ['*.apps.example.com'],
              certificates: [],
            },
          ],
        }),
    });
    await expect(
      pending.hasActiveCertificateForHostname('zone', '*.apps.example.com'),
    ).resolves.toBe(false);
  });

  it('pins the Cloudflare API base from the environment at construction', () => {
    const keys = [
      'CLOUDFLARE_API_BASE_URL',
      'CF_API_BASE_URL',
      'WRANGLER_API_ENVIRONMENT',
      'CLOUDFLARE_COMPLIANCE_REGION',
    ] as const;
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const cases: Array<[Record<string, string>, string]> = [
      [{ CF_API_BASE_URL: 'https://legacy.example/client/v4' }, 'https://legacy.example/client/v4'],
      [
        {
          CLOUDFLARE_COMPLIANCE_REGION: 'fedramp_high',
          WRANGLER_API_ENVIRONMENT: 'staging',
        },
        'https://api.fed.staging.cloudflare.com/client/v4',
      ],
    ];
    try {
      for (const [environment, expected] of cases) {
        for (const key of keys) {
          delete process.env[key];
        }
        Object.assign(process.env, environment);
        const client = new PlatformCloudflareClient('token');
        expect(client.apiBaseUrl).toBe(expected);
        process.env.CLOUDFLARE_API_BASE_URL = 'https://changed.example/client/v4';
        expect(client.apiBaseUrl).toBe(expected);
      }
    } finally {
      for (const key of keys) {
        const value = original[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('parses PostgreSQL credentials without exposing them', () => {
    expect(
      parsePostgresConnectionString('postgres://user:p%40ss@db.example.com:5433/void'),
    ).toEqual({
      database: 'void',
      host: 'db.example.com',
      password: 'p@ss',
      port: 5433,
      user: 'user',
    });
    expect(() => parsePostgresConnectionString('mysql://user:secret@db.example.com/db')).toThrow(
      'postgres://',
    );
  });

  it('resolves an R2 creation fingerprint before returning a new bucket', async () => {
    const methods: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return init?.method === 'POST'
          ? Response.json({ success: true, result: { name: 'assets' } })
          : Response.json({
              success: true,
              result: {
                buckets: [{ creation_date: '2026-09-14T00:00:00.000Z', name: 'assets' }],
              },
            });
      },
    });

    await expect(client.createR2Bucket('account', 'assets')).resolves.toEqual({
      fingerprint: '2026-09-14T00:00:00.000Z',
      id: 'assets',
      name: 'assets',
    });
    expect(methods).toEqual(['POST', 'GET']);
  });

  it.each([
    ['?sslmode=verify-full', { sslmode: 'require' }],
    ['?sslmode=verify-full&sslrootcert=system', { sslmode: 'require' }],
    ['?sslmode=verify-ca', { sslmode: 'require' }],
    ['?sslmode=require', { sslmode: 'require' }],
    ['', undefined],
  ])('sends a Hyperdrive TLS mode Cloudflare accepts for %j', async (query, mtls) => {
    let payload: Record<string, unknown> = {};
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ success: true, result: { id: 'hyperdrive-id', name: 'void-db' } });
      },
    });

    await client.createHyperdrive(
      'account',
      'void-db',
      `postgresql://user:secret@db.example.com/void${query}`,
    );

    expect(payload).toMatchObject({ caching: { disabled: true } });
    expect(payload.mtls).toEqual(mtls);
    expect('mtls' in payload).toBe(mtls !== undefined);
  });

  it('keeps unsupported PostgreSQL TLS modes out of Hyperdrive requests', () => {
    for (const sslmode of ['prefer', 'disable', 'allow']) {
      expect(() =>
        parsePostgresConnectionString(
          `postgresql://user:secret@db.example.com/void?sslmode=${sslmode}`,
        ),
      ).toThrow('Unsupported sslmode');
    }
  });

  it('fingerprints a Hyperdrive origin independently of the URL TLS mode', () => {
    const base = 'postgresql://user:secret@db.example.com:5432/void';
    expect(
      hyperdriveOriginConfigHash(
        hyperdriveOriginFromConnectionString(`${base}?sslmode=verify-full`),
      ),
    ).toBe(
      hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(`${base}?sslmode=require`)),
    );
    expect(
      hyperdriveOriginConfigHash(
        hyperdriveOriginFromConnectionString(`${base}?sslmode=verify-full&sslrootcert=system`),
      ),
    ).toBe(hyperdriveOriginConfigHash(hyperdriveOriginFromConnectionString(base)));
  });

  it.each([5432, '5432'])(
    'reads and fingerprints a public Hyperdrive with port %s',
    async (port) => {
      const client = new PlatformCloudflareClient('token', {
        fetcher: async () =>
          Response.json({
            success: true,
            result: {
              id: 'hyperdrive-id',
              name: 'void-db',
              origin: {
                database: 'void',
                host: 'DB.EXAMPLE.COM',
                port,
                scheme: 'postgres',
                user: 'void-user',
              },
            },
          }),
      });
      const config = await client.getHyperdriveConfig('account', 'hyperdrive-id');
      expect(config.origin).toEqual({
        database: 'void',
        host: 'db.example.com',
        port: 5432,
        scheme: 'postgresql',
        user: 'void-user',
      });
      // Existing installation manifests retain the public-origin fingerprint.
      expect(hyperdriveOriginConfigHash(config.origin)).toBe(
        '42174d71533f2c756129f46b5136972989ad67eb145ee62b7786ebc329c0ea61',
      );
      expect(hyperdriveOriginConfigHash(config.origin)).toBe(
        hyperdriveOriginConfigHash(
          hyperdriveOriginFromConnectionString(
            'postgres://void-user:secret@db.example.com:5432/void',
          ),
        ),
      );
    },
  );

  it.each([undefined, null])('reads a Tunnel-backed Hyperdrive with port %s', async (port) => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: {
            id: 'hyperdrive-id',
            name: 'managed-db',
            caching: { disabled: true },
            origin: {
              database: 'void',
              host: 'db.example.com/primary',
              port,
              scheme: 'postgres',
              user: 'runtime-user',
              access_client_id: 'tunnel-client-id',
              access_client_secret: 'secret',
            },
          },
        }),
    });
    const config = await client.getHyperdriveConfig('account', 'hyperdrive-id');
    expect(config).toEqual({
      id: 'hyperdrive-id',
      name: 'managed-db',
      cachingDisabled: true,
      origin: {
        database: 'void',
        host: 'db.example.com/primary',
        port: null,
        scheme: 'postgresql',
        user: 'runtime-user',
        accessClientId: 'tunnel-client-id',
      },
    });
    expect(hyperdriveOriginConfigHash(config.origin)).not.toBe(
      hyperdriveOriginConfigHash({ ...config.origin, accessClientId: 'different-client-id' }),
    );
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it.each([undefined, null, 0, 65_536, 5432.5, 'invalid', true, [5432]])(
    'rejects a public Hyperdrive with invalid port %s',
    async (port) => {
      const client = new PlatformCloudflareClient('token', {
        fetcher: async () =>
          Response.json({
            success: true,
            result: {
              id: 'hyperdrive-id',
              name: 'void-db',
              origin: { database: 'void', host: 'db.example.com', port, scheme: 'postgres' },
            },
          }),
      });
      await expect(client.getHyperdriveConfig('account', 'hyperdrive-id')).rejects.toThrow(
        'invalid origin port',
      );
    },
  );

  it('never includes the API token in errors', async () => {
    const token = 'super-secret-token';
    const client = new PlatformCloudflareClient(token, {
      fetcher: async () => new Response('not json', { status: 500 }),
    });
    let message = '';
    try {
      await client.listAccounts();
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(token);
    expect(message).toContain('non-JSON');
  });

  it('preflights core runtime-token access with a nonexistent cache URL', async () => {
    const requests: Array<{ body: string; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: String(init?.body ?? ''),
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        if (url.pathname.endsWith('/hyperdrive/configs')) {
          return Response.json({ success: true, result: [] });
        }
        return Response.json({ success: true, result: { id: 'zone' } });
      },
    });

    await verifyPlatformRuntimeTokenPermissions(client, {
      accountId: 'account',
      applicationDomain: 'apps.example.com',
      customDomains: false,
      zoneId: 'zone',
    });

    expect(requests.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
      'GET /client/v4/accounts/account/hyperdrive/configs',
      'POST /client/v4/zones/zone/purge_cache',
    ]);
    const purge = JSON.parse(requests[1]!.body) as { files: ReadonlyArray<string> };
    expect(purge.files).toHaveLength(1);
    expect(purge.files[0]).toMatch(
      /^https:\/\/apps\.example\.com\/\.well-known\/void\/runtime-token-preflight-[a-f0-9-]+$/,
    );
  });

  it('checks custom-hostname access only when the runtime enables it', async () => {
    const paths: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        if (url.pathname.endsWith('/hyperdrive/configs')) {
          return Response.json({ success: true, result: [] });
        }
        return Response.json({ success: true, result: [] });
      },
    });

    await verifyPlatformRuntimeTokenPermissions(client, {
      accountId: 'account',
      applicationDomain: 'example.com',
      customDomains: true,
      zoneId: 'zone',
    });

    expect(paths.at(-1)).toBe('/client/v4/zones/zone/custom_hostnames');
  });

  it.each([401, 403, 404, 429, 500, 503])(
    'distinguishes HTTP %s during token preflight without leaking upstream text',
    async (status) => {
      const secret = 'synthetic-runtime-secret';
      const client = new PlatformCloudflareClient(secret, {
        fetcher: async () =>
          Response.json(
            { success: false, errors: [{ message: `upstream echoed ${secret}` }] },
            { status },
          ),
      });
      const failure = await verifyPlatformRuntimeTokenPermissions(client, {
        accountId: 'account',
        applicationDomain: '',
        customDomains: false,
        zoneId: null,
      }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = String(failure);
      expect(message).toContain(`HTTP ${status}`);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('upstream echoed');
      if (status === 401 || status === 403) {
        expect(message).toContain('Cloudflare denied');
        expect(message).toContain('token is valid, scoped to this account');
        expect(message).toContain('Hyperdrive → Write');
      } else if (status === 429) {
        expect(message).toContain('rate-limited');
      } else {
        expect(message).toContain('does not establish that a permission is missing');
        expect(message).not.toContain('Cloudflare denied');
      }
      expect((failure as Error).cause).toBeInstanceOf(PlatformCloudflareApiError);
    },
  );

  it('does not describe transport failures as missing token permissions', async () => {
    const client = new PlatformCloudflareClient('synthetic-runtime-secret', {
      fetcher: async () => {
        throw new Error('network failure with synthetic-runtime-secret');
      },
    });
    const failure = verifyPlatformRuntimeTokenPermissions(client, {
      accountId: 'account',
      applicationDomain: '',
      customDomains: false,
      zoneId: null,
    });
    await expect(failure).rejects.toThrow('does not establish that a permission is missing');
    await expect(failure).rejects.not.toThrow('synthetic-runtime-secret');
    await expect(failure).rejects.not.toThrow('Required permission or scope');
  });

  describe('runtime-token email access', () => {
    const emailProbes = [
      ['Zone → Zone → Read', '/client/v4/zones/mail-zone'],
      ['Zone → Zone Settings → Edit', '/client/v4/zones/mail-zone/email/routing'],
      ['Zone → Email Routing Rules → Edit', '/client/v4/zones/mail-zone/email/routing/rules'],
      [
        'Account → Email Routing Addresses → Edit',
        '/client/v4/accounts/account/email/routing/addresses',
      ],
    ] as const;
    const emailClient = (answer: (pathname: string) => Response | Promise<Response>) => {
      const requests: Array<string> = [];
      const client = new PlatformCloudflareClient('synthetic-runtime-secret', {
        fetcher: async (input, init) => {
          const url = new URL(String(input));
          requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
          return answer(url.pathname);
        },
      });
      return { client, requests };
    };
    const verifyEmail = (client: PlatformCloudflareClient) =>
      verifyPlatformRuntimeTokenPermissions(client, {
        accountId: 'account',
        applicationDomain: '',
        customDomains: false,
        emailZoneId: 'mail-zone',
        zoneId: null,
      });

    it('reads each Email Routing area of the shared email zone only when email is on', async () => {
      const { client, requests } = emailClient(() => Response.json({ success: true, result: [] }));

      await verifyPlatformRuntimeTokenPermissions(client, {
        accountId: 'account',
        applicationDomain: 'apps.example.com',
        customDomains: true,
        zoneId: 'zone',
      });
      expect(requests.filter((request) => /\/email\/|\/zones\/zone$/.test(request))).toEqual([]);

      requests.length = 0;
      await verifyEmail(client);

      expect(requests).toEqual([
        'GET /client/v4/accounts/account/hyperdrive/configs?page=1&per_page=50',
        'GET /client/v4/zones/mail-zone',
        'GET /client/v4/zones/mail-zone/email/routing',
        'GET /client/v4/zones/mail-zone/email/routing/rules?per_page=5',
        'GET /client/v4/accounts/account/email/routing/addresses?per_page=5',
      ]);
    });

    it.each(emailProbes)('names %s when Cloudflare denies its check', async (permission, path) => {
      const { client } = emailClient((pathname) =>
        pathname === path
          ? Response.json(
              { success: false, errors: [{ message: 'upstream echoed synthetic-runtime-secret' }] },
              { status: 403 },
            )
          : Response.json({ success: true, result: [] }),
      );

      const failure = await verifyEmail(client).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(PlatformRuntimeTokenEmailPermissionError);
      expect((failure as PlatformRuntimeTokenEmailPermissionError).tokenNotValid).toBe(false);
      const message = String(failure);
      expect(message).toContain(`Cloudflare denied: ${permission} (HTTP 403)`);
      for (const [other] of emailProbes) {
        if (other !== permission) {
          expect(message).not.toContain(other);
        }
      }
      expect(message).toContain('email zone mail-zone');
      expect(message).toContain('The token value stays the same');
      expect(message).toContain('VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN');
      expect(message).not.toContain('synthetic-runtime-secret');
      expect(message).not.toContain('upstream echoed');
      expect((failure as Error).cause).toBeInstanceOf(PlatformCloudflareApiError);
    });

    it('marks a token that Cloudflare does not accept', async () => {
      // Cloudflare's answers to a token that is not valid: 403 on the zone
      // read and 401 on the Email Routing reads.
      const { client } = emailClient((pathname) =>
        pathname.endsWith('/hyperdrive/configs')
          ? Response.json({ success: true, result: [] })
          : Response.json(
              {
                success: false,
                errors: [
                  pathname === '/client/v4/zones/mail-zone'
                    ? { code: 9109, message: 'Invalid access token synthetic-runtime-secret' }
                    : { code: 10000, message: 'Authentication error synthetic-runtime-secret' },
                ],
              },
              { status: pathname === '/client/v4/zones/mail-zone' ? 403 : 401 },
            ),
      );

      const failure = await verifyEmail(client).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(PlatformRuntimeTokenEmailPermissionError);
      expect((failure as PlatformRuntimeTokenEmailPermissionError).tokenNotValid).toBe(true);
      expect(String(failure)).not.toContain('synthetic-runtime-secret');
      expect(String(failure)).not.toContain('Invalid access token');
      expect(String(failure)).not.toContain('Authentication error');
    });

    it('says that it checked the token saved on this machine', async () => {
      // The run does not send the saved token to the platform Workers, so
      // they can use a different token.
      const { client } = emailClient((pathname) =>
        pathname.endsWith('/email/routing/rules')
          ? Response.json({ success: false, errors: [] }, { status: 403 })
          : Response.json({ success: true, result: [] }),
      );
      const check = (savedToken?: boolean) =>
        verifyPlatformRuntimeTokenEmailPermissions(client, {
          accountId: 'account',
          zoneId: 'mail-zone',
          ...(savedToken === undefined ? {} : { savedToken }),
        }).catch((error: Error) => error.message);

      await expect(check(true)).resolves.toBe(
        'platform: The runtime API token saved on this machine cannot use platform email. Cloudflare denied: Zone → Email Routing Rules → Edit (HTTP 403). Void checked this token because VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN is not set. If the platform uses a different runtime token, set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to that token, and Void checks that token instead. Otherwise, check that the zone permissions of the saved token include the email zone mail-zone. To add a missing permission, edit the token in the Cloudflare dashboard. The token value stays the same. Then run the command again.',
      );
      // A token from VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN, or one that
      // the run sends to the Workers, keeps the message.
      for (const savedToken of [undefined, false]) {
        await expect(check(savedToken)).resolves.toBe(
          'platform: The runtime API token cannot use platform email. Cloudflare denied: Zone → Email Routing Rules → Edit (HTTP 403). Check that the token is valid and that its zone permissions include the email zone mail-zone. To add a missing permission, edit the token in the Cloudflare dashboard. The token value stays the same. Or set VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN to a valid token that has these permissions. Then run the command again.',
        );
      }
    });

    it('names every denied permission in one failure', async () => {
      const { client, requests } = emailClient((pathname) =>
        pathname.endsWith('/hyperdrive/configs')
          ? Response.json({ success: true, result: [] })
          : Response.json({ success: false, errors: [] }, { status: 401 }),
      );

      await expect(verifyEmail(client)).rejects.toThrow(
        `Cloudflare denied: ${emailProbes.map(([permission]) => permission).join(', ')} (HTTP 401)`,
      );
      expect(requests).toHaveLength(5);
    });

    it.each([429, 500, 503])(
      'does not treat HTTP %s as a missing email permission',
      async (status) => {
        const { client, requests } = emailClient((pathname) =>
          pathname.endsWith('/hyperdrive/configs')
            ? Response.json({ success: true, result: [] })
            : Response.json({ success: false, errors: [] }, { status }),
        );

        await expect(verifyEmail(client)).resolves.toBeUndefined();
        expect(requests).toHaveLength(5);
      },
    );

    it('does not treat a network failure as a missing email permission', async () => {
      const { client, requests } = emailClient((pathname) => {
        if (pathname.endsWith('/hyperdrive/configs')) {
          return Response.json({ success: true, result: [] });
        }
        throw new Error('network failure');
      });

      await expect(verifyEmail(client)).resolves.toBeUndefined();
      expect(requests).toHaveLength(5);
    });
  });

  it('filters KV namespaces by exact title instead of trusting an unsupported API filter', async () => {
    const entries = [
      { id: 'routing-id', title: 'void-example-routing' },
      { id: 'isr-id', title: 'void-example-isr-cache' },
      { id: 'legacy-id', title: 'void-example-legacy-assets' },
      { id: 'other-id', title: 'void-example-routing-other' },
    ];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () => Response.json({ success: true, result: entries }),
    });
    await expect(client.listKvNamespaces('account', 'void-example-routing')).resolves.toEqual([
      { id: 'routing-id', name: 'void-example-routing' },
    ]);
    await expect(client.listKvNamespaces('account', 'missing')).resolves.toEqual([]);
    await expect(client.listKvNamespaces('account')).resolves.toHaveLength(4);
  });

  it('keeps paginating before filtering and retains genuinely duplicate titles', async () => {
    const pages: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const page = new URL(String(input)).searchParams.get('page')!;
        pages.push(page);
        const result =
          page === '1'
            ? Array.from({ length: 100 }, (_, index) => ({
                id: `id-${index}`,
                title: index === 99 ? 'routing' : `unrelated-${index}`,
              }))
            : [{ id: 'another-routing', title: 'routing' }];
        return Response.json({ success: true, result });
      },
    });
    await expect(client.listKvNamespaces('account', 'routing')).resolves.toEqual([
      { id: 'id-99', name: 'routing' },
      { id: 'another-routing', name: 'routing' },
    ]);
    expect(pages).toEqual(['1', '2']);
  });

  it('does not turn malformed KV inventory into an empty search result', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({ success: true, result: [{ id: 'unknown', title: null }] }),
    });
    await expect(client.listKvNamespaces('account', 'routing')).rejects.toThrow(
      'KV namespace title',
    );
  });

  it('exhausts paginated collision checks for platform resource names', async () => {
    const calls: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        calls.push(`${url.pathname}?${url.searchParams}`);
        const page = Number(url.searchParams.get('page') ?? '1');
        if (url.pathname.endsWith('/ai-gateway/gateways')) {
          return Response.json({
            success: true,
            result:
              page === 1
                ? Array.from({ length: 50 }, (_, index) => ({ id: `gateway-${index}` }))
                : [{ id: 'gateway-50' }],
          });
        }
        return Response.json({
          success: true,
          result:
            page === 1
              ? Array.from({ length: 50 }, (_, index) => ({
                  id: `hyperdrive-${index}`,
                  name: `hyperdrive-${index}`,
                }))
              : [{ id: 'hyperdrive-50', name: 'hyperdrive-50' }],
        });
      },
    });

    await expect(client.listAiGateways('account')).resolves.toHaveLength(51);
    await expect(client.listHyperdriveConfigs('account')).resolves.toHaveLength(51);
    expect(calls.filter((call) => call.includes('ai-gateway'))).toHaveLength(2);
    expect(calls.filter((call) => call.includes('hyperdrive'))).toHaveLength(2);
  });

  it('paginates R2 buckets with a stable start-after cursor', async () => {
    const cursors: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const url = new URL(String(input));
        const cursor = url.searchParams.get('start_after') ?? '';
        cursors.push(cursor);
        const buckets = cursor
          ? [{ creation_date: '2026-09-14T00:00:01.000Z', name: 'bucket-1000' }]
          : Array.from({ length: 1000 }, (_, index) => ({
              creation_date: '2026-09-14T00:00:00.000Z',
              name: `bucket-${String(index).padStart(4, '0')}`,
            }));
        return Response.json({ success: true, result: { buckets } });
      },
    });

    await expect(client.listR2Buckets('account')).resolves.toHaveLength(1001);
    expect(cursors).toEqual(['', 'bucket-0999']);
  });

  it('preserves R2 key path separators while encoding reserved characters', async () => {
    const requests: Array<{ body: string; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: String(init?.body ?? ''),
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        return init?.method === 'PUT'
          ? new Response(null, { status: 200 })
          : new Response('marker');
      },
    });

    await client.putR2Object('account', 'bucket/name', '__void/platform/ownership/v1', 'marker');
    await expect(
      client.getR2Object('account', 'bucket/name', '__void/platform/ownership/v1'),
    ).resolves.toBe('marker');
    await client.putR2Object('account', 'bucket/name', 'reserved/what? #%.json', 'reserved');
    await expect(
      client.getR2Object('account', 'bucket/name', 'reserved/what? #%.json'),
    ).resolves.toBe('marker');
    expect(requests).toEqual([
      {
        body: 'marker',
        method: 'PUT',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/__void/platform/ownership/v1',
      },
      {
        body: '',
        method: 'GET',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/__void/platform/ownership/v1',
      },
      {
        body: 'reserved',
        method: 'PUT',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/reserved/what%3F%20%23%25.json',
      },
      {
        body: '',
        method: 'GET',
        pathname:
          '/client/v4/accounts/account/r2/buckets/bucket%2Fname/objects/reserved/what%3F%20%23%25.json',
      },
    ]);
  });

  it('reads only plain-text Worker ownership bindings', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: {
            bindings: [
              { name: 'PLATFORM_OWNERSHIP_MARKER', text: 'owned', type: 'plain_text' },
              { name: 'SECRET', type: 'secret_text' },
            ],
          },
        }),
    });
    await expect(client.getWorkerPlainTextBindings('account', 'worker')).resolves.toEqual({
      PLATFORM_OWNERSHIP_MARKER: 'owned',
    });
  });

  it('empties every paginated R2 object before bucket deletion', async () => {
    const deleted: Array<ReadonlyArray<string>> = [];
    const cursors: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'DELETE') {
          const keys = JSON.parse(String(init.body)) as Array<string>;
          deleted.push(keys);
          return Response.json({
            success: true,
            result: keys.map((key) => ({ key })),
          });
        }
        const cursor = url.searchParams.get('cursor') ?? '';
        cursors.push(cursor);
        return Response.json(
          cursor
            ? { success: true, result: [{ key: 'nested/c.txt' }] }
            : {
                success: true,
                result: [
                  { key: 'a.txt' },
                  { key: '__void/platform/ownership/v1' },
                  { key: 'b.txt' },
                ],
                result_info: { cursor: 'next-page' },
              },
        );
      },
    });

    await client.emptyR2Bucket('account', 'void-assets', new Set(['__void/platform/ownership/v1']));
    expect(cursors).toEqual(['', 'next-page']);
    expect(deleted).toEqual([['a.txt', 'b.txt'], ['nested/c.txt']]);
  });

  it('checks ownership again before each page of R2 object deletes', async () => {
    const events: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'DELETE') {
          const keys = JSON.parse(String(init.body)) as Array<string>;
          events.push(`delete ${keys.join(',')}`);
          return Response.json({ success: true, result: keys.map((key) => ({ key })) });
        }
        const cursor = url.searchParams.get('cursor') ?? '';
        return Response.json(
          cursor
            ? { success: true, result: [{ key: 'b.txt' }] }
            : { success: true, result: [{ key: 'a.txt' }], result_info: { cursor: 'next' } },
        );
      },
    });

    await client.emptyR2Bucket('account', 'void-assets', new Set(), async () => {
      events.push('check');
    });
    expect(events).toEqual(['check', 'delete a.txt', 'check', 'delete b.txt']);

    await expect(
      client.emptyR2Bucket('account', 'void-assets', new Set(), async () => {
        throw new Error('replaced');
      }),
    ).rejects.toThrow('replaced');
    expect(events).toEqual(['check', 'delete a.txt', 'check', 'delete b.txt']);
  });

  it('uses the documented teardown endpoints, never sends force, and treats 404 as gone', async () => {
    const requests: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        requests.push(`${method} ${url.pathname}${url.search}`);
        if (url.pathname.endsWith('/gone')) {
          return Response.json(
            { success: false, errors: [{ code: 10007, message: 'not found' }] },
            { status: 404 },
          );
        }
        if (method === 'DELETE') {
          // Some Cloudflare DELETE endpoints answer without a result field.
          return Response.json({ success: true, errors: [], messages: [] });
        }
        if (url.pathname.endsWith('/consumers')) {
          return Response.json({
            success: true,
            result: [
              {
                consumer_id: 'c1',
                queue_name: 'void-team-usage',
                script_name: 'void-team-api',
                settings: { batch_size: 10 },
                type: 'worker',
              },
              {
                consumer_id: 'c2',
                queue_name: 'void-team-usage',
                script_name: 'other',
                type: 'worker',
              },
              { consumer_id: 'c3', queue_name: 'void-team-usage', type: 'http_pull' },
            ],
          });
        }
        if (url.pathname.endsWith('/scripts')) {
          return Response.json({ success: true, result: [{ id: 'app-one' }] });
        }
        if (url.pathname.includes('/access/')) {
          return Response.json({ success: true, result: { id: 'app-id', name: 'void-app' } });
        }
        return Response.json({ success: true, result: [] });
      },
    });

    await client.deleteResource('account', {
      id: 'worker-id',
      kind: 'worker',
      name: 'void-team-api',
    });
    await client.deleteResource('account', { id: 'gone', kind: 'worker', name: 'gone' });
    await client.deleteWorkerRoute('zone', 'route-id');
    await client.deleteWorkerRoute('zone', 'gone');
    await client.deleteWorkerDomain('account', 'domain-id');
    await expect(client.listQueueConsumers('account', 'queue-id')).resolves.toEqual([
      { id: 'c1', script: 'void-team-api' },
      { id: 'c2', script: 'other' },
      { id: 'c3', script: null },
    ]);
    await client.deleteQueueConsumer('account', 'queue-id', 'c1');
    await expect(client.listDispatchNamespaceScripts('account', 'void-users')).resolves.toEqual([
      'app-one',
    ]);
    await client.deleteDispatchNamespaceScript('account', 'void-users', 'app-one');
    await expect(client.getAccessResource('account', 'application', 'app-id')).resolves.toEqual({
      id: 'app-id',
      name: 'void-app',
    });
    await expect(client.getAccessResource('account', 'service-token', 'gone')).resolves.toBeNull();
    await client.deleteAccessResource('account', 'application', 'app-id');
    await client.deleteAccessResource('account', 'service-token', 'token-id');

    expect(requests).toEqual([
      'DELETE /client/v4/accounts/account/workers/scripts/void-team-api',
      'DELETE /client/v4/accounts/account/workers/scripts/gone',
      'DELETE /client/v4/zones/zone/workers/routes/route-id',
      'DELETE /client/v4/zones/zone/workers/routes/gone',
      'DELETE /client/v4/accounts/account/workers/domains/domain-id',
      'GET /client/v4/accounts/account/queues/queue-id/consumers',
      'DELETE /client/v4/accounts/account/queues/queue-id/consumers/c1',
      'GET /client/v4/accounts/account/workers/dispatch/namespaces/void-users/scripts',
      'DELETE /client/v4/accounts/account/workers/dispatch/namespaces/void-users/scripts/app-one',
      'GET /client/v4/accounts/account/access/apps/app-id',
      'GET /client/v4/accounts/account/access/service_tokens/gone',
      'DELETE /client/v4/accounts/account/access/apps/app-id',
      'DELETE /client/v4/accounts/account/access/service_tokens/token-id',
    ]);
    expect(requests.some((request) => request.includes('force'))).toBe(false);
  });

  it('reads what depends on a Worker like wrangler delete, and forces only on request', async () => {
    const requests: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        if (url.pathname.endsWith('/references')) {
          // The shape Cloudflare returned for a platform API Worker.
          return Response.json({
            success: true,
            result: {
              services: {
                outgoing: [{ name: 'PLATFORM_PROXY', service: 'void-team-proxy' }],
                incoming: [{ name: 'API', service: 'void-team-proxy', environment: 'production' }],
              },
              domains: [],
              durable_objects: [
                { name: 'USAGE_COUNTER', service: 'void-team-api', environment: 'production' },
                { name: 'SHARED', service: 'customer-worker', environment: 'production' },
              ],
              dispatch_outbounds: [{ script: 'outbound-user', namespace: 'ns' }],
            },
          });
        }
        if (url.pathname.includes('/workers/tails/by-consumer/')) {
          return Response.json({
            success: true,
            result: [{ producer: { script: 'void-team-proxy' }, consumer: { script: 'x' } }],
          });
        }
        return Response.json({ success: true, result: null });
      },
    });

    await expect(client.listWorkerDependents('account', 'void-team-api')).resolves.toEqual({
      pagesFunction: false,
      workers: ['void-team-proxy', 'customer-worker', 'outbound-user'],
    });
    await client.forceDeleteWorker('account', 'void-team-api');

    expect(requests).toEqual([
      'GET /client/v4/accounts/account/workers/scripts/void-team-api/references',
      'GET /client/v4/accounts/account/workers/tails/by-consumer/void-team-api',
      'DELETE /client/v4/accounts/account/workers/scripts/void-team-api?force=true',
    ]);
  });

  it('reads a queue consumer Worker from script_name and refuses a Worker consumer without one', async () => {
    const respond = (rows: ReadonlyArray<Record<string, unknown>>) =>
      new PlatformCloudflareClient('token', {
        fetcher: async () => Response.json({ success: true, result: rows }),
      }).listQueueConsumers('account', 'queue-id');

    // Wrangler still reads these older names for the same Worker.
    await expect(
      respond([
        { consumer_id: 'c1', script: 'void-team-api', type: 'worker' },
        { consumer_id: 'c2', service: 'other', type: 'worker' },
      ]),
    ).resolves.toEqual([
      { id: 'c1', script: 'void-team-api' },
      { id: 'c2', script: 'other' },
    ]);
    await expect(respond([{ consumer_id: 'c1', type: 'worker' }])).rejects.toThrow(
      'platform: Queue consumer Worker name is missing from the Cloudflare response.',
    );
  });

  it('reads and detaches Email Routing rules through the documented endpoints', async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const worker = (name: string) => [{ type: 'worker', value: [name] }];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        requests.push(`${method} ${url.pathname}${url.search}`);
        if (init?.body) {
          bodies.push(JSON.parse(String(init.body)));
        }
        if (url.pathname.endsWith('/catch_all') && method === 'GET') {
          return url.pathname.includes('/empty-zone/')
            ? Response.json(
                { success: false, errors: [{ code: 1000, message: 'not found' }] },
                { status: 404 },
              )
            : Response.json({
                success: true,
                result: { enabled: true, actions: worker('void-team-email-gateway') },
              });
        }
        if (method === 'GET') {
          const page = url.searchParams.get('page');
          return Response.json({
            success: true,
            result:
              page === '1'
                ? [
                    { id: 'r1', enabled: true, actions: worker('void-team-email-gateway') },
                    ...Array.from({ length: 48 }, (_, index) => ({
                      id: `other-${index}`,
                      enabled: true,
                      actions: [{ type: 'forward', value: ['a@example.com'] }],
                    })),
                    // The catch-all has its own endpoint.
                    { id: 'all', enabled: true, matchers: [{ type: 'all' }], actions: [] },
                  ]
                : [
                    {
                      tag: 'r2',
                      enabled: false,
                      actions: [...worker('void-team-email-gateway'), { type: 'drop' }],
                    },
                  ],
          });
        }
        return Response.json({ success: true, result: {} });
      },
    });

    const rules = await client.listEmailRoutingRules('zone');
    expect(rules[0]).toEqual({ id: 'r1', enabled: true, workerName: 'void-team-email-gateway' });
    expect(rules.at(-1)).toEqual({ id: 'r2', enabled: false, workerName: null });
    expect(rules.some((rule) => rule.id === 'all')).toBe(false);
    await expect(client.getEmailRoutingCatchAll('zone')).resolves.toEqual({
      enabled: true,
      workerName: 'void-team-email-gateway',
    });
    await expect(client.getEmailRoutingCatchAll('empty-zone')).resolves.toBeNull();
    await client.deleteEmailRoutingRule('zone', 'r1');
    await client.resetEmailRoutingCatchAll('zone');

    expect(requests).toEqual([
      'GET /client/v4/zones/zone/email/routing/rules?page=1&per_page=50',
      'GET /client/v4/zones/zone/email/routing/rules?page=2&per_page=50',
      'GET /client/v4/zones/zone/email/routing/rules/catch_all',
      'GET /client/v4/zones/empty-zone/email/routing/rules/catch_all',
      'DELETE /client/v4/zones/zone/email/routing/rules/r1',
      'PUT /client/v4/zones/zone/email/routing/rules/catch_all',
    ]);
    expect(bodies).toEqual([
      { matchers: [{ type: 'all' }], actions: [{ type: 'drop' }], enabled: false },
    ]);
  });

  it('reports a refused Worker deletion with Cloudflare error codes', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json(
          {
            success: false,
            errors: [
              {
                code: 100109,
                message:
                  'Cannot delete this Worker as it is a Tail Worker consumer for other Workers.',
              },
            ],
          },
          { status: 422 },
        ),
    });

    await expect(
      client.deleteResource('account', { id: 'tail', kind: 'worker', name: 'void-team-tail' }),
    ).rejects.toThrow(
      'Cannot delete this Worker as it is a Tail Worker consumer for other Workers. (code 100109)',
    );
  });

  it('reads AI Gateway creation times as UTC, with or without a zone', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async () =>
        Response.json({
          success: true,
          result: [
            // The live API answers in this form.
            { id: 'void-team', created_at: '2026-10-05 18:29:14' },
            { id: 'zoned', created_at: '2026-09-14T00:00:01.400Z' },
            { id: 'odd', created_at: 'not a time' },
          ],
        }),
    });

    await expect(client.listAiGateways('account')).resolves.toEqual([
      { createdAt: '2026-10-05T18:29:14.000Z', id: 'void-team', name: 'void-team' },
      { createdAt: '2026-09-14T00:00:01.400Z', id: 'zoned', name: 'zoned' },
      { id: 'odd', name: 'odd' },
    ]);
  });

  it('deletes an AI Gateway with the runtime credential when one is set', async () => {
    const authorizations: Array<string | null> = [];
    const client = new PlatformCloudflareClient('operator-token', {
      fetcher: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get('Authorization'));
        return Response.json({ success: true, result: null });
      },
    }).withAiGatewayToken('runtime-token');

    await client.deleteResource('account', {
      id: 'void-team',
      kind: 'ai-gateway',
      name: 'void-team',
    });
    expect(authorizations).toEqual(['Bearer runtime-token']);
  });

  it('deletes a dispatch namespace by its name, not its id', async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        requests.push({
          method: init?.method ?? 'GET',
          pathname: new URL(String(input)).pathname,
        });
        return Response.json({ success: true, result: null });
      },
    });

    await client.deleteResource('account', {
      id: '5f2f1fa4-9a2f-4f4f-9713-9c27b6a1dd7f',
      kind: 'dispatch-namespace',
      name: 'void-team-users',
    });

    expect(requests).toEqual([
      {
        method: 'DELETE',
        pathname: '/client/v4/accounts/account/workers/dispatch/namespaces/void-team-users',
      },
    ]);
  });

  it('uses the documented AI Gateway lifecycle endpoints and creation shape', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        const result =
          init?.method === 'POST'
            ? { id: 'void-team' }
            : init?.method === 'DELETE'
              ? null
              : [{ id: 'void-team' }];
        return Response.json({ success: true, result });
      },
    });

    await expect(client.listAiGateways('account')).resolves.toEqual([
      { id: 'void-team', name: 'void-team' },
    ]);
    await expect(client.createAiGateway('account', 'void-team')).resolves.toEqual({
      id: 'void-team',
      name: 'void-team',
    });
    await client.deleteResource('account', {
      id: 'void-team',
      kind: 'ai-gateway',
      name: 'void-team',
    });

    expect(requests).toEqual([
      {
        body: null,
        method: 'GET',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways',
      },
      {
        body: {
          cache_invalidate_on_update: false,
          cache_ttl: null,
          collect_logs: true,
          id: 'void-team',
          rate_limiting_interval: null,
          rate_limiting_limit: null,
        },
        method: 'POST',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways',
      },
      {
        body: null,
        method: 'DELETE',
        pathname: '/client/v4/accounts/account/ai-gateway/gateways/void-team',
      },
    ]);
  });

  it('creates and deletes the proxied wildcard application DNS record in its zone', async () => {
    const requests: Array<{ body: unknown; method: string; pathname: string }> = [];
    const dns = {
      content: '100::',
      id: 'dns-id',
      name: '*.apps.example.com',
      proxied: true,
      type: 'AAAA',
    };
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          pathname: url.pathname,
        });
        return Response.json({
          success: true,
          result:
            init?.method === 'GET' || !init?.method ? [dns] : init.method === 'POST' ? dns : null,
        });
      },
    });

    await expect(client.listDnsRecords('zone-id', '*.apps.example.com')).resolves.toEqual([dns]);
    await expect(client.createDnsRecord('zone-id', '*.apps.example.com')).resolves.toEqual(dns);
    await client.deleteResource(
      'account',
      { id: 'dns-id', kind: 'dns-record', name: '*.apps.example.com' },
      'zone-id',
    );

    expect(requests).toEqual([
      { body: null, method: 'GET', pathname: '/client/v4/zones/zone-id/dns_records' },
      {
        body: {
          content: '100::',
          name: '*.apps.example.com',
          proxied: true,
          ttl: 1,
          type: 'AAAA',
        },
        method: 'POST',
        pathname: '/client/v4/zones/zone-id/dns_records',
      },
      {
        body: null,
        method: 'DELETE',
        pathname: '/client/v4/zones/zone-id/dns_records/dns-id',
      },
    ]);
  });

  it('inventories Worker custom domains before installer deployment', async () => {
    const pages: Array<string | null> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        const page = new URL(String(input)).searchParams.get('page');
        pages.push(page);
        return Response.json({
          success: true,
          result:
            page === '1'
              ? [
                  {
                    hostname: 'api.platform.example.com',
                    id: 'domain-id',
                    service: 'existing-worker',
                    zone_name: 'example.com',
                  },
                ]
              : [
                  {
                    hostname: 'admin.platform.example.net',
                    id: 'domain-id-2',
                    service: 'existing-worker',
                  },
                ],
          result_info: { page: Number(page), per_page: 1, total_pages: 2 },
        });
      },
    });
    await expect(client.listWorkerDomains('account')).resolves.toEqual([
      {
        hostname: 'api.platform.example.com',
        id: 'domain-id',
        service: 'existing-worker',
        zoneName: 'example.com',
      },
      {
        hostname: 'admin.platform.example.net',
        id: 'domain-id-2',
        service: 'existing-worker',
      },
    ]);
    expect(pages).toEqual(['1', '2']);
  });

  it('adds only missing managed routes while preserving concurrent routes', async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    let inventories = 0;
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          url,
        });
        if (init?.method === 'POST') {
          return Response.json({
            success: true,
            result: { id: 'managed-id', pattern: 'apps.example.com/*', script: 'void-dispatch' },
          });
        }
        return Response.json({
          success: true,
          result:
            inventories++ === 0
              ? [{ id: 'manual-id', pattern: 'manual.example.net/*', script: 'void-dispatch' }]
              : [
                  { id: 'manual-id', pattern: 'manual.example.net/*', script: 'void-dispatch' },
                  { id: 'managed-id', pattern: 'apps.example.com/*', script: 'void-dispatch' },
                  {
                    id: 'concurrent-id',
                    pattern: 'concurrent.example.net/*',
                    script: 'void-dispatch',
                  },
                ],
        });
      },
    });

    await client.publishWorkerRoutesSafely('zone', 'void-dispatch', ['apps.example.com/*']);

    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'GET']);
    expect(requests[1]).toMatchObject({
      body: { pattern: 'apps.example.com/*', script: 'void-dispatch' },
    });
  });

  it('treats an ambiguous managed route publication as unsafe', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        if (init?.method === 'POST') {
          throw new Error('connection reset');
        }
        return Response.json({ success: true, result: [] });
      },
    });

    await expect(
      client.publishWorkerRoutesSafely('zone', 'void-dispatch', ['apps.example.com/*']),
    ).rejects.toMatchObject({ name: 'PlatformWorkerRoutesChangedError' });
  });

  it('publishes Worker custom domains without takeover flags and verifies ownership', async () => {
    const requests: Array<{ body: unknown; method: string; url: string }> = [];
    let inventories = 0;
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          method: init?.method ?? 'GET',
          url,
        });
        return url.endsWith('/domains/records')
          ? Response.json({ success: true, result: null })
          : Response.json({
              success: true,
              result:
                inventories++ === 0
                  ? []
                  : [
                      {
                        hostname: 'api.example.com',
                        id: 'domain-id',
                        service: 'void-api',
                        zone_name: 'example.com',
                      },
                      {
                        hostname: 'concurrent.example.net',
                        id: 'concurrent-domain-id',
                        service: 'void-api',
                      },
                    ],
              result_info: { page: 1, per_page: 100, total_pages: 1 },
            });
      },
    });

    await client.publishWorkerCustomDomainsSafely('account', 'void-api', [
      { hostname: 'api.example.com', zoneName: 'example.com' },
    ]);

    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(requests[1]).toMatchObject({
      body: {
        origins: [{ hostname: 'api.example.com', zone_name: 'example.com' }],
        override_existing_dns_record: false,
        override_existing_origin: false,
        override_scope: false,
      },
      method: 'PUT',
    });
    expect(requests[1]!.url).toContain(
      '/accounts/account/workers/scripts/void-api/domains/records',
    );
    expect(requests[2]).toMatchObject({ method: 'GET' });
  });

  it('does not mutate a Worker when every custom domain is already attached', async () => {
    const methods: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (_input, init) => {
        methods.push(init?.method ?? 'GET');
        return Response.json({
          success: true,
          result: [{ hostname: 'api.example.com', id: 'domain-id', service: 'void-api' }],
          result_info: { page: 1, per_page: 100, total_pages: 1 },
        });
      },
    });

    await client.publishWorkerCustomDomainsSafely('account', 'void-api', [
      { hostname: 'api.example.com' },
    ]);
    expect(methods).toEqual(['GET']);
  });

  it('treats an ambiguous custom-domain publication as unsafe', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        if (String(input).endsWith('/domains/records')) {
          throw new Error('connection reset');
        }
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, per_page: 100, total_pages: 1 },
        });
      },
    });

    await expect(
      client.publishWorkerCustomDomainsSafely('account', 'void-api', [
        { hostname: 'api.example.com' },
      ]),
    ).rejects.toBeInstanceOf(PlatformWorkerCustomDomainsChangedError);
  });

  it('fails closed when a published Worker custom domain changes ownership', async () => {
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) =>
        String(input).endsWith('/domains/records')
          ? Response.json({ success: true, result: null })
          : Response.json({
              success: true,
              result: [{ hostname: 'api.example.com', id: 'domain-id', service: 'other-worker' }],
              result_info: { page: 1, per_page: 100, total_pages: 1 },
            }),
    });

    const publication = client.publishWorkerCustomDomainsSafely('account', 'void-api', [
      { hostname: 'api.example.com' },
    ]);
    await expect(publication).rejects.toBeInstanceOf(PlatformWorkerCustomDomainsChangedError);
    await expect(publication).rejects.toThrow('changed concurrently');
  });

  it('inventories every route for a Worker without requiring zone visibility', async () => {
    let requestUrl = '';
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (input) => {
        requestUrl = String(input);
        return Response.json({
          success: true,
          result: [{ pattern: 'manual.example.com/*', zone_name: 'example.com' }],
        });
      },
    });

    await expect(client.listWorkerServiceRoutes('account', 'worker')).resolves.toEqual([
      { pattern: 'manual.example.com/*', zoneName: 'example.com' },
    ]);
    expect(requestUrl).toContain(
      '/accounts/account/workers/services/worker/environments/production/routes?show_zonename=true',
    );
  });
});
