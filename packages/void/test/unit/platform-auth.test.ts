import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudflareAuthRunResult } from '../../src/cli/cloudflare-auth.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  readWranglerOAuthCredential,
  resolvePlatformCloudflareCredential,
  resolvePlatformCloudflareCredentialWithInput,
  platformOperatorNeedsManagementToken,
  verifyPlatformManagementAccess,
  verifyPlatformCloudflareCredential,
} from '../../src/cli/platform-auth.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_API_TOKEN;
  vi.restoreAllMocks();
});

describe('platform Cloudflare authentication', () => {
  it('verifies the selected account, Workers and installed R2 buckets using only reads', async () => {
    const paths: Array<string> = [];
    const client = new PlatformCloudflareClient('token', {
      fetcher: async (url, init) => {
        expect(init?.method ?? 'GET').toBe('GET');
        const path = new URL(String(url)).pathname;
        paths.push(path);
        const result = path.endsWith('/accounts')
          ? [{ id: 'account', name: 'Account' }]
          : path.endsWith('/workers/scripts')
            ? []
            : { name: 'assets' };
        return Response.json({ success: true, result });
      },
    });
    await verifyPlatformCloudflareCredential(client, {
      account: { id: 'account', name: 'Account' },
      source: 'saved',
      r2Buckets: ['assets'],
    });
    expect(paths).toEqual([
      '/client/v4/accounts',
      '/client/v4/accounts/account/workers/scripts',
      '/client/v4/accounts/account/r2/buckets/assets',
    ]);
  });

  it('rejects credentials scoped to another account before reading its resources', async () => {
    const client = {
      listAccounts: async () => [{ id: 'other', name: 'Other' }],
      listWorkerNames: vi.fn(),
      request: vi.fn(),
    };
    await expect(
      verifyPlatformCloudflareCredential(client as never, {
        account: { id: 'account', name: 'Account' },
        source: 'environment',
        r2Buckets: [],
      }),
    ).rejects.toThrow('cannot access Cloudflare account "Account" (account)');
    expect(client.listWorkerNames).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])(
    'reports an R2 credential check failure with HTTP %s without echoing provider secrets',
    async (status) => {
      const client = new PlatformCloudflareClient('token', {
        fetcher: async (url) => {
          const path = new URL(String(url)).pathname;
          return path.includes('/r2/')
            ? Response.json({ success: false, errors: [{ message: 'secret-token' }] }, { status })
            : Response.json({
                success: true,
                result: path.endsWith('/accounts') ? [{ id: 'account', name: 'Account' }] : [],
              });
        },
      });
      const error = await verifyPlatformCloudflareCredential(client, {
        account: { id: 'account', name: 'Account' },
        source: 'saved',
        r2Buckets: ['assets'],
      }).catch((error) => error);
      expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).toContain('saved management token');
      expect(error.message).not.toContain('secret-token');
      expect(error.message).toContain(
        status === 401 || status === 403 ? 'Workers R2 Storage → Edit' : 'Retry',
      );
    },
  );

  it.each([false, true])(
    'only permits a missing bucket when repairing (repair: %s)',
    async (repair) => {
      const client = new PlatformCloudflareClient('token', {
        fetcher: async (url) => {
          const path = new URL(String(url)).pathname;
          return path.includes('/r2/')
            ? Response.json({ success: false }, { status: 404 })
            : Response.json({
                success: true,
                result: path.endsWith('/accounts') ? [{ id: 'account', name: 'Account' }] : [],
              });
        },
      });
      const promise = verifyPlatformCloudflareCredential(client, {
        account: { id: 'account', name: 'Account' },
        source: 'saved',
        r2Buckets: ['assets'],
        allowMissingR2Buckets: repair,
      });
      if (repair) {
        await expect(promise).resolves.toBeUndefined();
      } else {
        await expect(promise).rejects.toThrow('R2 bucket "assets" is unavailable (HTTP 404)');
      }
    },
  );

  it('requires a management token for Access even without DNS writes', () => {
    const credential = { source: 'oauth' as const, token: 'browser' };
    const plan = { actions: [] };
    expect(platformOperatorNeedsManagementToken(credential, plan)).toBe(false);
    expect(
      platformOperatorNeedsManagementToken(credential, plan, { protection: true, readOnly: false }),
    ).toBe(true);
    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(credential, plan, {
        protection: true,
        readOnly: false,
      }),
    ).toThrow('Access: Service Tokens → Edit');
    expect(
      platformOperatorNeedsManagementToken({ source: 'environment', token: 'manager' }, plan, {
        protection: true,
        readOnly: false,
      }),
    ).toBe(false);
  });
  it.each([false, true])(
    'checks Access permissions using only reads, with protection: %s',
    async (protection) => {
      const request = vi.fn(async (_path: string) => ({}));
      await verifyPlatformManagementAccess({ request } as never, 'account', {
        protection,
        readOnly: false,
      });
      expect(request.mock.calls.map(([path]) => path)).toEqual([
        '/accounts/account/access/organizations',
        '/accounts/account/access/identity_providers?per_page=1',
        '/accounts/account/access/groups?per_page=1',
        '/accounts/account/access/policies?per_page=1',
        '/accounts/account/access/apps?per_page=1',
        ...(protection ? ['/accounts/account/access/service_tokens?per_page=1'] : []),
      ]);
      expect(request.mock.calls.every((call) => call.length === 1)).toBe(true);
    },
  );
  const action = (kind: 'dns-record' | 'zone', action: 'adopt' | 'create' | 'reuse') => ({
    action,
    id: action === 'create' ? null : `${kind}-id`,
    key: kind,
    kind,
    name: 'example.com',
    reason: 'test',
  });

  it('requires an API token before browser OAuth applies zone or DNS writes', () => {
    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(
        { source: 'oauth', token: 'browser-token' },
        { actions: [action('zone', 'create'), action('dns-record', 'create')] },
      ),
    ).toThrow('Account → Zone → Edit and Zone → DNS → Edit');
    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(
        { source: 'oauth', token: 'browser-token' },
        { actions: [action('zone', 'reuse'), action('dns-record', 'reuse')] },
      ),
    ).not.toThrow();
    expect(() =>
      assertPlatformOperatorCredentialCanApplyPlan(
        { source: 'environment', token: 'scoped-token' },
        { actions: [action('zone', 'create'), action('dns-record', 'create')] },
      ),
    ).not.toThrow();
  });

  it('does not require an API token for a DNS record the install only adopts', () => {
    const oauth = { source: 'oauth' as const, token: 'browser-token' };

    const adopt = { actions: [action('zone', 'reuse'), action('dns-record', 'adopt')] };
    expect(platformOperatorNeedsManagementToken(oauth, adopt)).toBe(false);
    expect(() => assertPlatformOperatorCredentialCanApplyPlan(oauth, adopt)).not.toThrow();
    const create = { actions: [action('zone', 'reuse'), action('dns-record', 'create')] };
    expect(platformOperatorNeedsManagementToken(oauth, create)).toBe(true);
    expect(() => assertPlatformOperatorCredentialCanApplyPlan(oauth, create)).toThrow(
      'Zone → DNS → Edit',
    );
    const reuse = { actions: [action('zone', 'reuse'), action('dns-record', 'reuse')] };
    expect(platformOperatorNeedsManagementToken(oauth, reuse)).toBe(false);
    const zone = { actions: [action('zone', 'create'), action('dns-record', 'adopt')] };
    expect(platformOperatorNeedsManagementToken(oauth, zone)).toBe(true);
    expect(() => assertPlatformOperatorCredentialCanApplyPlan(oauth, zone)).toThrow(
      'Account → Zone → Edit',
    );
  });

  it.each([false, true])(
    'uses saved management authority before browser login (interactive: %s)',
    async (interactive) => {
      const runWrangler = vi.fn();
      const credential = await resolvePlatformCloudflareCredential({
        interactive,
        runWrangler,
        savedManagementToken: ' saved-manager ',
      });
      expect(credential).toEqual({ source: 'saved', token: 'saved-manager' });
      expect(runWrangler).not.toHaveBeenCalled();
      expect(() =>
        assertPlatformOperatorCredentialCanApplyPlan(
          credential,
          { actions: [] },
          {
            protection: true,
            readOnly: false,
          },
        ),
      ).not.toThrow();
    },
  );

  it.each(['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'])(
    'keeps explicit %s ahead of the saved token',
    async (name) => {
      process.env[name] = 'explicit-manager';
      const runWrangler = vi.fn();
      await expect(
        resolvePlatformCloudflareCredential({
          interactive: false,
          runWrangler,
          savedManagementToken: 'saved-manager',
        }),
      ).resolves.toEqual({ source: 'environment', token: 'explicit-manager' });
      expect(runWrangler).not.toHaveBeenCalled();
    },
  );

  it('reads OAuth through the Cloudflare session command', async () => {
    await expect(
      readWranglerOAuthCredential(() => ({
        status: 0,
        stderr: '',
        stdout: '',
        data: { token: 'oauth-token', type: 'oauth' },
      })),
    ).resolves.toEqual({ source: 'oauth', token: 'oauth-token' });
  });

  it('uses cf browser login when no session exists', async () => {
    const calls: Array<string> = [];
    let tokenAttempts = 0;
    const credential = await resolvePlatformCloudflareCredential({
      interactive: true,
      runWrangler: (args) => {
        calls.push(args.type);
        if (args.type === 'auth.token') {
          tokenAttempts++;
          return tokenAttempts === 1
            ? { status: 1, stderr: 'not logged in', stdout: '', data: '' }
            : {
                status: 0,
                stderr: '',
                stdout: '',
                data: { token: 'browser-token', type: 'oauth' },
              };
        }
        return { status: 0, stderr: '', stdout: '', data: '' };
      },
    });

    expect(credential).toEqual({ source: 'oauth', token: 'browser-token' });
    expect(calls).toEqual(['auth.token', 'auth.login', 'auth.token']);
  });

  it('requires an explicit environment token in non-interactive environments', async () => {
    const runWrangler = vi.fn(() => ({ status: 1, stderr: 'not logged in', stdout: '', data: '' }));
    await expect(
      resolvePlatformCloudflareCredential({
        interactive: false,
        runWrangler,
      }),
    ).rejects.toThrow('set CLOUDFLARE_API_TOKEN in CI');
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('does not accept a Wrangler API token from an implicit plaintext profile', async () => {
    await expect(
      readWranglerOAuthCredential(() => ({
        status: 0,
        stderr: '',
        stdout: '',
        data: { token: 'implicit-token', type: 'api_token' },
      })),
    ).resolves.toBeNull();
  });
});

describe('platform authentication during input', () => {
  const success: CloudflareAuthRunResult = { status: 0, stderr: '', stdout: '', data: '' };
  const oauth = {
    ...success,
    stdout: '',
    data: { token: 'browser-token', type: 'oauth' },
  };

  it('shows input while the saved-login check is still pending', async () => {
    const check = deferred<typeof success>();
    const runWrangler = vi.fn().mockReturnValueOnce(check.promise).mockResolvedValue(oauth);
    const readInput = vi.fn(async () => 'team');
    const result = resolvePlatformCloudflareCredentialWithInput(readInput, {
      interactive: true,
      runWrangler,
    });
    expect(readInput).toHaveBeenCalledOnce();
    expect(runWrangler.mock.calls).toEqual([[{ type: 'auth.token' }, true]]);
    check.resolve(oauth);
    await expect(result).resolves.toEqual({
      input: 'team',
      credential: { source: 'oauth', token: 'browser-token' },
    });
    expect(runWrangler.mock.calls).toHaveLength(1);
  });

  it('waits for the name before opening browser login', async () => {
    const input = deferred<string>();
    const runWrangler = vi
      .fn()
      .mockResolvedValueOnce({ ...success, status: 1 })
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce(oauth);
    const result = resolvePlatformCloudflareCredentialWithInput(() => input.promise, {
      interactive: true,
      runWrangler,
    });
    await vi.waitFor(() => expect(runWrangler).toHaveBeenCalledTimes(1));
    input.resolve('team');
    await expect(result).resolves.toEqual({
      input: 'team',
      credential: { source: 'oauth', token: 'browser-token' },
    });
    expect(runWrangler.mock.calls.map(([args]) => args.type)).toEqual([
      'auth.token',
      'auth.login',
      'auth.token',
    ]);
  });

  it('does not start another auth command after input is cancelled', async () => {
    const check = deferred<typeof success>();
    const runWrangler = vi.fn().mockReturnValue(check.promise);
    await expect(
      resolvePlatformCloudflareCredentialWithInput(
        async () => {
          throw new Error('platform: Cancelled.');
        },
        { interactive: true, runWrangler },
      ),
    ).rejects.toThrow('Cancelled.');
    check.resolve(success);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runWrangler).toHaveBeenCalledOnce();
  });

  it('handles background auth failure without interrupting the name prompt', async () => {
    const input = deferred<string>();
    const runWrangler = vi.fn().mockRejectedValue(new Error('secure storage unavailable'));
    let settled = false;
    const result = resolvePlatformCloudflareCredentialWithInput(() => input.promise, {
      interactive: true,
      runWrangler,
    }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    input.resolve('team');
    await expect(result).rejects.toThrow('secure storage unavailable');
    expect(runWrangler).toHaveBeenCalledOnce();
  });

  it('still collects input when an environment credential skips authentication', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'ci-token';
    const runWrangler = vi.fn();
    await expect(
      resolvePlatformCloudflareCredentialWithInput(async () => 'team', {
        interactive: false,
        runWrangler,
      }),
    ).resolves.toEqual({ input: 'team', credential: { source: 'environment', token: 'ci-token' } });
    expect(runWrangler).not.toHaveBeenCalled();
  });
});
