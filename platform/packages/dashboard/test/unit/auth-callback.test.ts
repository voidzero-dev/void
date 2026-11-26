import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { loader } from '../../pages/auth/callback.server.ts';

function createApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  app.get('/auth/callback', (c) => {
    vi.stubGlobal('fetch', fetchImpl);
    return loader(c as never) as Response | Promise<Response>;
  });
  return app;
}

describe('dashboard auth callback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exchanges a dashboard auth code into a void_token cookie', async () => {
    const app = createApp(
      vi.fn(async () =>
        Response.json({
          token: 'dashboard-jwt',
        }),
      ) as typeof fetch,
    );

    const res = await app.request(
      'https://dash.staging.void.cloud/auth/callback?code=auth-code&login_nonce=nonce',
      {
        headers: {
          Cookie: 'void_auth_nonce=nonce',
          Host: 'dash.staging.void.cloud',
        },
        redirect: 'manual',
      },
      { API_URL: 'https://api.staging.void.cloud' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://dash.staging.void.cloud/');
    expect(res.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('void_auth_nonce=;'),
        expect.stringContaining('void_token=dashboard-jwt;'),
      ]),
    );
  });

  it('redirects failed exchanges to a clean login URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(
      vi.fn(async () =>
        Response.json({ error: 'invalid or expired code' }, { status: 400 }),
      ) as typeof fetch,
    );

    const res = await app.request(
      'https://dash.staging.void.cloud/auth/callback?code=auth-code&login_nonce=nonce',
      {
        headers: {
          Cookie: 'void_auth_nonce=nonce',
          Host: 'dash.staging.void.cloud',
        },
        redirect: 'manual',
      },
      { API_URL: 'https://api.staging.void.cloud' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://dash.staging.void.cloud/login');
    expect(warn).toHaveBeenCalledWith(
      '[dashboard] /auth/exchange returned 400: invalid or expired code',
    );
  });

  it('returns to login when the code exchange cannot reach the API', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(vi.fn().mockRejectedValue(new Error('API request timed out')));

    const response = await app.request(
      'https://dashboard.example.com/auth/callback?code=auth-code&login_nonce=nonce',
      {
        headers: { Cookie: 'void_auth_nonce=nonce', Host: 'dashboard.example.com' },
        redirect: 'manual',
      },
      { API_URL: 'https://api.example.com' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://dashboard.example.com/login');
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('void_token='))).toBe(
      false,
    );
  });

  it('redeems localhost managed-login codes with the cookie-bound PKCE verifier', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ token: 'managed-local-jwt' }));
    const app = createApp(request);
    const verifier = 'a'.repeat(43);
    const res = await app.request(
      'http://localhost:5173/auth/callback?code=auth-code&login_nonce=nonce&state=pkce-state',
      {
        headers: {
          Cookie: `void_auth_nonce=nonce; void_auth_pkce=pkce-state:${verifier}`,
          Host: 'localhost:5173',
        },
        redirect: 'manual',
      },
      { API_URL: 'http://localhost:8787' },
    );
    expect(res.status).toBe(302);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('http://localhost:8787/auth/cli/token');
    expect(JSON.parse(init!.body as string)).toEqual({
      code: 'auth-code',
      state: 'pkce-state',
      code_verifier: verifier,
    });
    expect(res.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('void_auth_pkce=;'),
        expect.stringContaining('void_token=managed-local-jwt;'),
      ]),
    );
  });
});

describe('localhost token bypass', () => {
  const noApiFetch = vi.fn(async () => {
    throw new Error('should not call API');
  }) as typeof fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sets void_token cookie when token + matching nonce arrive on localhost', async () => {
    const app = createApp(noApiFetch);

    const res = await app.request(
      'http://localhost:5173/auth/callback?token=test-jwt&login_nonce=devnonce',
      {
        headers: {
          Cookie: 'void_auth_nonce=devnonce',
          Host: 'localhost:5173',
        },
        redirect: 'manual',
      },
      { API_URL: 'http://localhost:8787' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://localhost:5173/');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toEqual(
      expect.arrayContaining([expect.stringContaining('void_token=test-jwt;')]),
    );
    expect(cookies).toEqual(expect.arrayContaining([expect.stringContaining('void_auth_nonce=;')]));
  });

  it('rejects token without nonce cookie on localhost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(noApiFetch);

    const res = await app.request(
      'http://localhost:5173/auth/callback?token=test-jwt&login_nonce=devnonce',
      {
        headers: {
          Host: 'localhost:5173',
        },
        redirect: 'manual',
      },
      { API_URL: 'http://localhost:8787' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://localhost:5173/login');
    expect(res.headers.getSetCookie()).not.toEqual(
      expect.arrayContaining([expect.stringContaining('void_token=')]),
    );
    expect(warn).toHaveBeenCalledWith('[dashboard] auth callback nonce mismatch');
  });

  it('rejects token without nonce query param on localhost', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(noApiFetch);

    const res = await app.request(
      'http://localhost:5173/auth/callback?token=test-jwt',
      {
        headers: {
          Cookie: 'void_auth_nonce=devnonce',
          Host: 'localhost:5173',
        },
        redirect: 'manual',
      },
      { API_URL: 'http://localhost:8787' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://localhost:5173/login');
    expect(res.headers.getSetCookie()).not.toEqual(
      expect.arrayContaining([expect.stringContaining('void_token=')]),
    );
    expect(warn).toHaveBeenCalledWith('[dashboard] auth callback nonce mismatch');
  });

  it('rejects token when nonce cookie does not match query param', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp(noApiFetch);

    const res = await app.request(
      'http://localhost:5173/auth/callback?token=test-jwt&login_nonce=mismatch',
      {
        headers: {
          Cookie: 'void_auth_nonce=devnonce',
          Host: 'localhost:5173',
        },
        redirect: 'manual',
      },
      { API_URL: 'http://localhost:8787' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('http://localhost:5173/login');
    expect(res.headers.getSetCookie()).not.toEqual(
      expect.arrayContaining([expect.stringContaining('void_token=')]),
    );
    expect(warn).toHaveBeenCalledWith('[dashboard] auth callback nonce mismatch');
  });

  it('rejects token on non-localhost host regardless of nonce', async () => {
    const app = createApp(noApiFetch);

    const res = await app.request(
      'https://dash.void.cloud/auth/callback?token=test-jwt&login_nonce=devnonce',
      {
        headers: {
          Cookie: 'void_auth_nonce=devnonce',
          Host: 'dash.void.cloud',
        },
        redirect: 'manual',
      },
      { API_URL: 'https://api.void.cloud' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://dash.void.cloud/login');
    expect(res.headers.getSetCookie()).not.toEqual(
      expect.arrayContaining([expect.stringContaining('void_token=')]),
    );
  });
});
