import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { fetchApi } from '../../lib/api.ts';
import { head, loader } from '../../pages/login.server.ts';

afterEach(() => vi.unstubAllGlobals());
describe('dashboard login discovery', () => {
  const app = new Hono().get('/login', async (c) => c.json(await loader(c as never)));
  it('offers the current named methods without hard-coded social providers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          schemaVersion: 3,
          displayName: 'Example Platform',
          authentication: { methods: [{ id: 'company', kind: 'oidc', label: 'Company <SSO>' }] },
        }),
      ),
    );
    const response = await app.request(
      'https://dashboard.example.com/login',
      { headers: { Host: 'dashboard.example.com' } },
      { API_URL: 'https://api.example.com' },
    );
    expect(await response.json()).toMatchObject({
      platformName: 'Example Platform',
      methods: [
        { id: 'company', label: 'Company <SSO>', url: expect.stringContaining('provider=company') },
      ],
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(head({} as never, { platformName: 'Example Platform', methods: [] })?.title).toBe(
      'Sign in · Example Platform · Void',
    );
  });
  it('binds localhost dashboard login to a complete PKCE code flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          schemaVersion: 3,
          authentication: { methods: [{ id: 'company', kind: 'oidc', label: 'Company' }] },
        }),
      ),
    );
    const response = await app.request(
      'http://localhost:5173/login',
      { headers: { Host: 'localhost:5173' } },
      { API_URL: 'http://localhost:8787' },
    );
    const method = (await response.json<{ methods: Array<{ url: string }> }>()).methods[0];
    const login = new URL(method.url);
    expect(login.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.searchParams.get('code_challenge_method')).toBe('S256');
    const redirect = new URL(login.searchParams.get('redirect')!);
    expect(redirect.origin).toBe('http://localhost:5173');
    expect(redirect.searchParams.get('state')).toBeTruthy();
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringContaining('void_auth_pkce=')]),
    );
  });
  it('does not classify localhost-prefixed public hosts as loopback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          schemaVersion: 3,
          authentication: { methods: [{ id: 'company', kind: 'oidc', label: 'Company' }] },
        }),
      ),
    );
    const response = await app.request(
      'https://localhost.attacker.example/login',
      { headers: { Host: 'localhost.attacker.example' } },
      { API_URL: 'https://api.example.com' },
    );
    const method = (await response.json<{ methods: Array<{ url: string }> }>()).methods[0];
    const login = new URL(method.url);
    expect(login.searchParams.has('code_challenge')).toBe(false);
    expect(new URL(login.searchParams.get('redirect')!).origin).toBe(
      'https://localhost.attacker.example',
    );
  });
  it('fails closed when discovery is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: 'https://company.cloudflareaccess.com' },
          }),
      ),
    );
    const response = await app.request(
      'https://dashboard.example.com/login',
      { headers: { Host: 'dashboard.example.com' } },
      {},
    );
    expect(await response.json()).toMatchObject({ methods: [], unavailable: true });
  });
  it('preserves the protected dashboard origin and human assertion through its API binding', async () => {
    const binding = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const bound = new Hono().get('/me', (c) => fetchApi(c, '/me'));
    await bound.request(
      'https://dashboard.example.com/me',
      { headers: { Host: 'dashboard.example.com', 'Cf-Access-Jwt-Assertion': 'human-proof' } },
      {
        API_URL: 'https://api.example.com',
        API: { fetch: binding },
        CF_ACCESS_CLIENT_ID: 'machine',
        CF_ACCESS_CLIENT_SECRET: 'secret',
      },
    );
    expect(binding.mock.calls[0][0].toString()).toBe('https://dashboard.example.com/me');
    const options = binding.mock.calls[0][1] as RequestInit;
    expect((options.headers as Headers).get('Cf-Access-Jwt-Assertion')).toBe('human-proof');
    expect((options.headers as Headers).has('CF-Access-Client-Secret')).toBe(false);
    expect(options.redirect).toBe('manual');
  });
});

describe('login presentation', () => {
  it('escapes the platform and provider names without changing the login URL', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: LoginPage } = await import('../../pages/login.tsx');
    const url =
      'https://api.example.com/auth/login?provider=company&redirect=https%3A%2F%2Fdash.example.com%2Fauth%2Fcallback';
    const html = renderToStaticMarkup(
      LoginPage({
        platformName: '<script>company</script>',
        methods: [{ id: 'company', label: '<script>SSO</script>', url }],
      }),
    );
    expect(html).toContain('Sign in to &lt;script&gt;company&lt;/script&gt;');
    expect(html).toContain('Continue with &lt;script&gt;SSO&lt;/script&gt;');
    expect(html).toContain(url.replaceAll('&', '&amp;'));
    expect(html).not.toContain('<script>');
  });
});
