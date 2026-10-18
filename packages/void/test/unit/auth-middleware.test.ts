import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('better-auth', () => ({
  betterAuth: mocks.betterAuth,
}));

import { getUser, requireAuth, type AuthState, type AuthUser } from '../../src/runtime/auth.ts';
import {
  createVoidAuthRuntime,
  type VoidAuthRuntimeOptions,
} from '../../src/runtime/better-auth-shared.ts';

const authRuntimeOptions: VoidAuthRuntimeOptions = {
  dialect: 'sqlite',
  providers: null,
};

const runtime = createVoidAuthRuntime('sqlite', async () => {});

function createApp(sessionResult: { response: AuthState | null; headers: Headers }): Hono {
  mocks.getSession.mockResolvedValue(sessionResult);
  mocks.betterAuth.mockReturnValue({
    api: { getSession: mocks.getSession },
  });

  const app = new Hono();
  app.use(async (c, next) => {
    await runtime.runVoidAuthMiddleware(c, next, authRuntimeOptions, {} as never);
  });
  return app;
}

beforeEach(() => {
  mocks.betterAuth.mockReset();
  mocks.getSession.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runVoidAuthMiddleware response headers', () => {
  it('adds auth headers to an immutable response without changing its body or status', async () => {
    const authHeaders = new Headers();
    authHeaders.set('x-auth-refresh', 'refreshed');
    authHeaders.append('set-cookie', 'session=one; Path=/; HttpOnly');
    authHeaders.append('set-cookie', 'csrf=two; Path=/');
    const app = createApp({ response: null, headers: authHeaders });

    app.get('/public', () => fetch('data:text/plain,public%20content'));

    const response = await app.request('http://localhost/public', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-auth-refresh')).toBe('refreshed');
    expect(response.headers.getSetCookie()).toEqual([
      'session=one; Path=/; HttpOnly',
      'csrf=two; Path=/',
    ]);
    await expect(response.text()).resolves.toBe('public content');
  });

  it('appends auth cookies while replacing other response headers', async () => {
    const authHeaders = new Headers();
    authHeaders.set('cache-control', 'private, no-store');
    authHeaders.append('set-cookie', 'session=auth; Path=/; HttpOnly');
    const app = createApp({ response: null, headers: authHeaders });

    app.get(
      '/response',
      () =>
        new Response('ok', {
          status: 202,
          headers: {
            'cache-control': 'public, max-age=60',
            'set-cookie': 'route=existing; Path=/',
          },
        }),
    );

    const response = await app.request('http://localhost/response', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual([
      'route=existing; Path=/',
      'session=auth; Path=/; HttpOnly',
    ]);
    await expect(response.text()).resolves.toBe('ok');
  });

  it('preserves an anonymous application cache policy', async () => {
    const app = createApp({
      response: null,
      headers: new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' }),
    });
    app.get('/public', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
    const response = await app.request('http://localhost/public', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.has('pragma')).toBe(false);
  });

  it.each(['cookie', 'authorization', 'cf-access-jwt-assertion'])(
    'keeps the session lookup private for requests with %s',
    async (header) => {
      const app = createApp({
        response: null,
        headers: new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' }),
      });
      app.get('/private', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
      const response = await app.request(
        'http://localhost/private',
        { headers: { [header]: 'synthetic-credential' } },
        { BETTER_AUTH_SECRET: 'test-secret' },
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    },
  );

  it('keeps a resolved authenticated session private even without a request credential header', async () => {
    const now = new Date();
    const app = createApp({
      response: {
        user: {
          id: 'local-user',
          name: 'Local user',
          email: 'user@example.test',
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        session: {
          id: 'local-session',
          userId: 'local-user',
          token: 'synthetic-token',
          expiresAt: now,
          createdAt: now,
          updatedAt: now,
        },
      },
      headers: new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' }),
    });
    app.get('/private', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
    const response = await app.request('http://localhost/private', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  it('does not allow a cookie rotation without its own cache policy to retain a public response', async () => {
    const app = createApp({
      response: null,
      headers: new Headers({ 'set-cookie': 'session=rotated; Path=/; HttpOnly' }),
    });
    app.get('/refresh', (c) => c.text('content', 200, { 'cache-control': 'public, max-age=60' }));
    const response = await app.request('http://localhost/refresh', undefined, {
      BETTER_AUTH_SECRET: 'test-secret',
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual(['session=rotated; Path=/; HttpOnly']);
  });

  it.each([
    ['without its own cache policy', new Headers()],
    ['with a no-store policy', new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' })],
  ])(
    'keeps a private, no-cache route policy through a cookie rotation %s',
    async (_label, authHeaders) => {
      authHeaders.append('set-cookie', 'session=rotated; Path=/; HttpOnly');
      const app = createApp({ response: null, headers: authHeaders });
      app.get('/refresh', (c) =>
        c.text('content', 200, { 'cache-control': 'private, no-cache', etag: 'W/"v1"' }),
      );
      const response = await app.request(
        'http://localhost/refresh',
        { headers: { cookie: 'session=current' } },
        { BETTER_AUTH_SECRET: 'test-secret' },
      );
      expect(response.headers.get('cache-control')).toBe('private, no-cache');
      expect(response.headers.has('pragma')).toBe(false);
      expect(response.headers.getSetCookie()).toEqual(['session=rotated; Path=/; HttpOnly']);
    },
  );

  it('does not let a cookie rotation keep a private route policy the browser may reuse', async () => {
    const app = createApp({
      response: null,
      headers: new Headers({ 'set-cookie': 'session=rotated; Path=/; HttpOnly' }),
    });
    app.get('/refresh', (c) => c.text('content', 200, { 'cache-control': 'private, max-age=60' }));
    const response = await app.request(
      'http://localhost/refresh',
      { headers: { cookie: 'session=current' } },
      { BETTER_AUTH_SECRET: 'test-secret' },
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual(['session=rotated; Path=/; HttpOnly']);
  });
});

describe('cross-origin cookie sessions', () => {
  const env = { BETTER_AUTH_SECRET: 'test-secret' };
  const now = new Date();
  const signedIn: AuthState = {
    user: {
      id: 'victim',
      name: 'Victim',
      email: 'victim@example.test',
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
    session: {
      id: 'victim-session',
      userId: 'victim',
      token: 'synthetic-token',
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    },
  };

  // Better Auth's context matches origins against `this.trustedOrigins`.
  function mockAuth(
    options: Record<string, unknown> = {},
    trustedOrigins: Array<string> = ['https://app.void.app'],
  ) {
    mocks.getSession.mockImplementation(async ({ headers }: { headers: Headers }) => ({
      response: headers.has('cookie') ? signedIn : null,
      headers: new Headers(),
    }));
    mocks.betterAuth.mockReturnValue({
      api: { getSession: mocks.getSession },
      options,
      $context: Promise.resolve({
        trustedOrigins,
        isTrustedOrigin(this: { trustedOrigins: Array<string> }, url: string) {
          return this.trustedOrigins.includes(url);
        },
      }),
    });
  }

  function upgradeRequest(headers: Record<string, string>): Request {
    return new Request('https://app.void.app/chat/general', {
      headers: { upgrade: 'websocket', cookie: 'session=victim', ...headers },
    });
  }

  async function sessionCookieFor(request: Request): Promise<string | null> {
    await runtime.resolveVoidAuthState(request, env, authRuntimeOptions, {} as never);
    expect(mocks.getSession).toHaveBeenCalledOnce();
    return (mocks.getSession.mock.calls[0]![0] as { headers: Headers }).headers.get('cookie');
  }

  function routeApp() {
    const app = new Hono<{ Variables: { user: AuthUser | null } }>();
    app.use(async (c, next) => {
      await runtime.runVoidAuthMiddleware(c, next, authRuntimeOptions, {} as never);
    });
    return app;
  }

  it('ignores the cookie on a WebSocket upgrade from another origin', async () => {
    mockAuth();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'https://evil.void.app' })),
    ).resolves.toBeNull();
  });

  it('ignores the cookie on a WebSocket upgrade from a plain http page on the same host', async () => {
    mockAuth();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'http://app.void.app' })),
    ).resolves.toBeNull();
  });

  it('keeps the cookie when Vite HTTPS hands the upgrade over as http', async () => {
    // The default base URL follows the request, so Better Auth trusts only http.
    mockAuth({}, ['http://app.void.app']);
    const request = new Request('http://app.void.app/chat/general', {
      headers: { upgrade: 'websocket', cookie: 'session=victim', origin: 'https://app.void.app' },
    });
    await expect(sessionCookieFor(request)).resolves.toBe('session=victim');
  });

  it.each([
    ['the same origin', { origin: 'https://app.void.app' }],
    ['no origin', {}],
    [
      'an opaque origin the browser marks same-origin',
      { origin: 'null', 'sec-fetch-site': 'same-origin' },
    ],
  ])('keeps the cookie on a WebSocket upgrade from %s', async (_label, headers) => {
    mockAuth();
    await expect(sessionCookieFor(upgradeRequest(headers))).resolves.toBe('session=victim');
  });

  it('keeps the cookie for an origin Better Auth trusts', async () => {
    mockAuth({}, ['https://app.void.app', 'https://admin.example.com']);
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'https://admin.example.com' })),
    ).resolves.toBe('session=victim');
  });

  it('evaluates function-form trustedOrigins with the request', async () => {
    const trustedOrigins = vi.fn(async (request?: Request) =>
      request?.headers.get('origin') === 'https://admin.example.com'
        ? ['https://admin.example.com', null]
        : [],
    );
    mockAuth({ trustedOrigins });
    const request = upgradeRequest({ origin: 'https://admin.example.com' });
    await expect(sessionCookieFor(request)).resolves.toBe('session=victim');
    expect(trustedOrigins).toHaveBeenCalledWith(request);
  });

  it('follows the Better Auth CSRF opt-out options', async () => {
    mockAuth({ advanced: { disableCSRFCheck: true } });
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'https://evil.void.app' })),
    ).resolves.toBe('session=victim');

    mocks.getSession.mockClear();
    mockAuth({ advanced: { disableOriginCheck: true } });
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'https://evil.void.app' })),
    ).resolves.toBe('session=victim');

    mocks.getSession.mockClear();
    mockAuth({ advanced: { disableOriginCheck: true, disableCSRFCheck: false } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'https://evil.void.app' })),
    ).resolves.toBeNull();
  });

  it('ignores the cookie for an opaque origin that is not same-origin', async () => {
    mockAuth();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      sessionCookieFor(upgradeRequest({ origin: 'null', 'sec-fetch-site': 'same-site' })),
    ).resolves.toBeNull();
  });

  it('leaves a cross-origin WebSocket upgrade without a user in the middleware', async () => {
    mockAuth();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = routeApp();
    app.get('/chat/general', (c) => c.json({ user: c.get('user') }));
    const response = await app.request(
      upgradeRequest({ origin: 'https://evil.void.app' }),
      undefined,
      env,
    );
    await expect(response.json()).resolves.toEqual({ user: null });
  });

  it('does not sign in a cross-origin POST but keeps its raw cookies', async () => {
    mockAuth();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = routeApp();
    app.post('/api/profile', (c) => {
      const cookie = c.req.header('cookie');
      return c.json({ id: requireAuth(c).id, cookie });
    });
    app.post('/api/whoami', (c) => c.json({ user: c.get('user'), cookie: c.req.header('cookie') }));
    const init = {
      method: 'POST',
      headers: { cookie: 'session=victim', origin: 'https://evil.void.app' },
      body: '{}',
    };
    const denied = await app.request('https://app.void.app/api/profile', init, env);
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe('Unauthorized');

    const whoami = await app.request('https://app.void.app/api/whoami', init, env);
    await expect(whoami.json()).resolves.toEqual({ user: null, cookie: 'session=victim' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain('https://evil.void.app');
    expect(String(warn.mock.calls[0]![0])).toContain('trustedOrigins');
  });

  it.each([
    ['a same-origin POST', 'POST', { origin: 'https://app.void.app' }],
    ['a POST without an Origin header', 'POST', {}],
    ['a cross-origin GET', 'GET', { origin: 'https://evil.void.app' }],
  ])('keeps the session for %s', async (_label, method, headers) => {
    mockAuth();
    const warn = vi.spyOn(console, 'warn');
    const app = routeApp();
    app.on(method, '/api/profile', (c) => c.json({ id: requireAuth(c).id }));
    const response = await app.request(
      'https://app.void.app/api/profile',
      { method, headers: { cookie: 'session=victim', ...headers } },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'victim' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('runVoidAuthMiddleware skipped paths', () => {
  const user = { id: 'user-1', email: 'ada@example.com' } as AuthUser;
  const env = { BETTER_AUTH_SECRET: 'test-secret' };
  const imageUrl = 'http://localhost/_void/image?url=%2Fa.png&w=64&q=75';

  function createSkipApp(response: AuthState | null) {
    const authHeaders = new Headers();
    authHeaders.append('set-cookie', 'session=refresh; Path=/');
    authHeaders.set('cache-control', 'no-store');
    mocks.getSession.mockResolvedValue({ response, headers: authHeaders });
    mocks.betterAuth.mockReturnValue({ api: { getSession: mocks.getSession } });
    const app = new Hono<{ Variables: { user: AuthUser | null; session: unknown } }>();
    app.use(async (c, next) => {
      await runtime.runVoidAuthMiddleware(
        c,
        next,
        { ...authRuntimeOptions, skipPaths: ['/_void/image'] },
        {} as never,
      );
    });
    // A site-wide login wall, as in `middleware/auth.ts`.
    app.use(async (c, next) => {
      if (c.req.path !== '/login') {
        requireAuth(c);
      }
      await next();
    });
    app.get('/_void/image', (c) =>
      c.json(
        { user: c.get('user'), current: getUser() },
        { headers: { 'cache-control': 'public, max-age=60, must-revalidate' } },
      ),
    );
    app.get('/page', (c) => c.text('page'));
    return app;
  }

  it('keeps the signed-in user for guards on the image optimizer path without auth headers', async () => {
    const app = createSkipApp({ user, session: { id: 'session-1' } } as AuthState);
    const init = { headers: { cookie: 'session=abc' } };

    const image = await app.request(imageUrl, init, env);
    expect(image.status).toBe(200);
    expect(await image.json()).toEqual({ user, current: user });
    expect(image.headers.getSetCookie()).toEqual([]);
    expect(image.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    expect(mocks.getSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: { disableRefresh: true } }),
    );

    const page = await app.request('http://localhost/page', init, env);
    expect(page.headers.getSetCookie()).toEqual(['session=refresh; Path=/']);
    expect(mocks.getSession).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ query: expect.anything() }),
    );
  });

  it('skips the session lookup for anonymous image requests', async () => {
    const app = createSkipApp(null);

    const image = await app.request(imageUrl, undefined, env);
    expect(image.status).toBe(401);
    expect(image.headers.getSetCookie()).toEqual([]);
    expect(mocks.betterAuth).not.toHaveBeenCalled();
  });
});
