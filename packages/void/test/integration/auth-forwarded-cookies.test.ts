import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { getCookieCache } from 'better-auth/cookies';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { getAuth, getSession, getUser, type VoidAuthConfig } from '../../src/runtime/auth.ts';
import {
  createVoidAuthRuntime,
  type VoidAuthRuntimeOptions,
} from '../../src/runtime/better-auth-shared.ts';
import { createPageMutationHandler } from '../../src/runtime/routing-pages.ts';
import { createRoutingRuntime, type RoutingContext } from '../../src/runtime/routing.ts';

const env = { BETTER_AUTH_SECRET: 'local-test-secret-with-at-least-32-characters' };
const origin = 'https://app.test';
const email = 'cookies@example.test';
const password = 'correct-horse-battery-staple';
const cdnHeaders = ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control'];
const cookieCache = { session: { cookieCache: { enabled: true, maxAge: 60 } } };

/** A browser cookie store: later cookies replace earlier ones, Max-Age=0 removes one. */
class CookieJar {
  readonly cookies = new Map<string, string>();

  apply(response: Response): this {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const name = cookieName(cookie);
      const value = pair.slice(pair.indexOf('=') + 1).trim();
      if (
        value === '' ||
        attributes.some((attribute) => /^\s*max-age\s*=\s*0\s*$/i.test(attribute))
      ) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return this;
  }

  clone(): CookieJar {
    const jar = new CookieJar();
    for (const [name, value] of this.cookies) {
      jar.cookies.set(name, value);
    }
    return jar;
  }

  without(suffix: string): CookieJar {
    const jar = this.clone();
    for (const name of jar.cookies.keys()) {
      if (name.endsWith(`better-auth.${suffix}`)) {
        jar.cookies.delete(name);
      }
    }
    return jar;
  }

  header(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }
}

function cookieName(cookie: string): string {
  return cookie.slice(0, cookie.indexOf('=')).trim();
}

/** Better Auth cookies with this name suffix (it adds `__Secure-` on https). */
function authCookies(response: Response, suffix: string): Array<string> {
  return response.headers
    .getSetCookie()
    .filter((cookie) => cookieName(cookie).endsWith(`better-auth.${suffix}`));
}

/** The user inside a session cache cookie. */
function cachedUser(cookie: string): { name: string; image?: string | null } {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1).split(';')[0]!);
  const cache = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
    session: { user: { name: string; image?: string | null } };
  };
  return cache.session.user;
}

function cachedName(cookie: string): string {
  return cachedUser(cookie).name;
}

function isCleared(cookie: string): boolean {
  return /;\s*max-age=0(?:;|$)/i.test(cookie);
}

function expectNoDuplicateCookies(response: Response): void {
  const names = response.headers.getSetCookie().map(cookieName);
  expect(names).toEqual([...new Set(names)]);
}

/** `beforeRoutes` registers user middleware after auth and before every route. */
function fixture(userConfig: VoidAuthConfig = cookieCache, beforeRoutes?: (app: Hono) => void) {
  const database = memoryAdapter({ user: [], session: [], account: [], verification: [] });
  const runtime = createVoidAuthRuntime('sqlite', async () => {});
  const options: VoidAuthRuntimeOptions = { dialect: 'sqlite', providers: null, userConfig };
  const app = new Hono();
  const routing = createRoutingRuntime(app, { nodeTarget: true });
  app.use(routing.contextMiddleware);
  app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options, database));
  beforeRoutes?.(app);
  app.on(['GET', 'POST'], '/api/auth/*', (c) =>
    runtime.handleVoidAuthRequest(c, options, database),
  );
  app.get('/me', (c) =>
    c.json({ user: getUser()?.name ?? null, session: getSession()?.user.name ?? null }),
  );
  return { app, runtime, options, database };
}

/** A GET, or a same-origin JSON POST when there is a body. */
async function send(
  app: Hono,
  path: string,
  { jar, body }: { jar?: CookieJar; body?: unknown } = {},
): Promise<Response> {
  const cookie = jar?.header();
  return app.request(
    origin + path,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json', origin }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

async function me(
  app: Hono,
  jar: CookieJar,
): Promise<{ user: string | null; session: string | null }> {
  const response = await send(app, '/me', { jar });
  expect(response.status).toBe(200);
  return response.json();
}

/** Signs up, then signs in through the auth router and returns the browser's cookies. */
async function signIn(app: Hono, name = 'Old name', address = email): Promise<CookieJar> {
  const signUp = await send(app, '/api/auth/sign-up/email', {
    body: { name, email: address, password },
  });
  expect(signUp.status).toBe(200);
  await signUp.arrayBuffer();
  const response = await send(app, '/api/auth/sign-in/email', {
    body: { email: address, password },
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const jar = new CookieJar().apply(response);
  expect([...jar.cookies.keys()].some((key) => key.endsWith('better-auth.session_token'))).toBe(
    true,
  );
  return jar;
}

describe('cookies set by auth.api calls during a request', () => {
  it('refreshes the session cache cookie after updateUser in a route', async () => {
    const { app } = fixture();
    app.post('/profile', async (c) => {
      const { name } = await c.req.json<{ name: string }>();
      await getAuth(c).api.updateUser({ body: { name }, headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    const jar = await signIn(app);
    const stale = jar.clone();

    const response = await send(app, '/profile', { jar, body: { name: 'New name' } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    expect(response.headers.get('cache-control')).toBe('no-store');

    await expect(me(app, jar.apply(response))).resolves.toEqual({
      user: 'New name',
      session: 'New name',
    });
    // Without the forwarded cookie the browser keeps the cached old name,
    // although the stored user has changed.
    await expect(me(app, stale)).resolves.toEqual({ user: 'Old name', session: 'Old name' });
    const uncached = await send(app, '/api/auth/get-session?disableCookieCache=true', {
      jar: stale,
    });
    await expect(uncached.json()).resolves.toMatchObject({ user: { name: 'New name' } });
  });

  it('clears the session cookies after signOut in a route', async () => {
    const { app } = fixture();
    app.post('/logout', async (c) => {
      await getAuth(c).api.signOut({ headers: c.req.raw.headers });
      return c.redirect('/', 303);
    });
    const jar = await signIn(app);
    const stale = jar.clone();

    const response = await send(app, '/logout', { jar, body: {} });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    const token = authCookies(response, 'session_token');
    const data = authCookies(response, 'session_data');
    expect(token).toHaveLength(1);
    expect(data).toHaveLength(1);
    expect(isCleared(token[0]!)).toBe(true);
    expect(isCleared(data[0]!)).toBe(true);
    expectNoDuplicateCookies(response);

    jar.apply(response);
    expect([...jar.cookies.keys()].filter((name) => name.includes('better-auth.'))).toEqual([]);
    await expect(me(app, jar)).resolves.toEqual({ user: null, session: null });
    // The old cache cookie would still look signed in until it expires.
    await expect(me(app, stale)).resolves.toEqual({ user: 'Old name', session: 'Old name' });
  });

  it('keeps a single copy of each cookie from the auth router', async () => {
    const { app, runtime, options, database } = fixture();
    const signUp = await send(app, '/api/auth/sign-up/email', {
      body: { name: 'Router', email, password },
    });
    expect(signUp.status).toBe(200);
    expect(authCookies(signUp, 'session_token')).toHaveLength(1);
    expectNoDuplicateCookies(signUp);

    const signIn = await send(app, '/api/auth/sign-in/email', { body: { email, password } });
    expect(signIn.status).toBe(200);
    expect(authCookies(signIn, 'session_token')).toHaveLength(1);
    expect(authCookies(signIn, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(signIn);
    expect(signIn.headers.get('cache-control')).toBe('no-store');

    // Sign-out sends the same cookies as Better Auth's own handler.
    const jar = new CookieJar().apply(signIn);
    const signOut = await send(app, '/api/auth/sign-out', { jar, body: {} });
    expect(signOut.status).toBe(200);
    expect(authCookies(signOut, 'session_token')).toHaveLength(1);
    const other = new CookieJar().apply(
      await send(app, '/api/auth/sign-in/email', { body: { email, password } }),
    );
    const request = new Request(origin + '/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: other.header() },
      body: '{}',
    });
    const auth = await runtime.createVoidAuth(request, env, options, database);
    const direct = await auth.handler(request);
    expect(direct.status).toBe(200);
    expect(signOut.headers.getSetCookie()).toEqual(direct.headers.getSetCookie());
  });

  it('keeps a single copy when the route returns an asResponse result', async () => {
    const { app } = fixture();
    app.post('/profile', async (c) =>
      getAuth(c).api.updateUser({
        body: { name: 'As response' },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    const jar = await signIn(app);

    const response = await send(app, '/profile', { jar, body: {} });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: true });
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    await expect(me(app, jar.apply(response))).resolves.toEqual({
      user: 'As response',
      session: 'As response',
    });
  });

  it('keeps a single copy when the route appends returned headers itself', async () => {
    const { app } = fixture();
    app.post('/profile', async (c) => {
      const { headers } = await getAuth(c).api.updateUser({
        body: { name: 'Returned headers' },
        headers: c.req.raw.headers,
        returnHeaders: true,
      });
      for (const cookie of headers.getSetCookie()) {
        c.header('set-cookie', cookie, { append: true });
      }
      return c.json({ ok: true });
    });
    const jar = await signIn(app);

    const response = await send(app, '/profile', { jar, body: {} });

    expect(response.status).toBe(200);
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    await expect(me(app, jar.apply(response))).resolves.toMatchObject({
      user: 'Returned headers',
    });
  });

  it('leaves requests without an auth.api cookie unchanged', async () => {
    const { app } = fixture();
    const routeHeaders = {
      'cache-control': 'public, max-age=60',
      ...Object.fromEntries(cdnHeaders.map((name) => [name, 'max-age=600'])),
    };
    app.get('/public', (c) => c.text('public', 200, routeHeaders));
    app.get('/sessions', async (c) => {
      const sessions = await getAuth(c).api.listSessions({ headers: c.req.raw.headers });
      return c.json({ count: sessions.length });
    });

    const anonymous = await send(app, '/public');
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.has('set-cookie')).toBe(false);
    expect(anonymous.headers.get('cache-control')).toBe('public, max-age=60');
    expect(anonymous.headers.has('pragma')).toBe(false);
    for (const name of cdnHeaders) {
      expect(anonymous.headers.get(name)).toBe('max-age=600');
    }

    const jar = await signIn(app);
    const signedIn = await send(app, '/me', { jar });
    expect(signedIn.headers.has('set-cookie')).toBe(false);
    const sessions = await send(app, '/sessions', { jar });
    await expect(sessions.json()).resolves.toEqual({ count: 2 });
    expect(sessions.headers.has('set-cookie')).toBe(false);
  });

  it('makes an anonymous response private when an auth.api call sets a cookie', async () => {
    const { app } = fixture();
    app.post('/login', async (c) => {
      const credentials = await c.req.json<{ email: string; password: string }>();
      await getAuth(c).api.signInEmail({ body: credentials, headers: c.req.raw.headers });
      return c.text('signed in', 200, {
        'cache-control': 'public, max-age=60',
        ...Object.fromEntries(cdnHeaders.map((name) => [name, 'max-age=600'])),
      });
    });
    await signIn(app, 'Custom login');

    const response = await send(app, '/login', { body: { email, password } });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('signed in');
    expect(authCookies(response, 'session_token')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    for (const name of cdnHeaders) {
      expect(response.headers.has(name)).toBe(false);
    }
    await expect(me(app, new CookieJar().apply(response))).resolves.toEqual({
      user: 'Custom login',
      session: 'Custom login',
    });
  });

  it('sends only the latest cookie per key after a session lookup refresh', async () => {
    const { app } = fixture();
    app.post('/logout', async (c) => {
      await getAuth(c).api.signOut({ headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    app.post('/profile', async (c) => {
      await getAuth(c).api.updateUser({ body: { name: 'Latest' }, headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    // Without the cache cookie, the session lookup sets a new one.
    const jar = (await signIn(app)).without('session_data');
    const lookup = await send(app, '/me', { jar });
    expect(authCookies(lookup, 'session_data')).toHaveLength(1);

    // The lookup, updateUser's own session check and its result each set the
    // cache cookie. The browser only needs the last one.
    const profile = await send(app, '/profile', { jar, body: {} });
    expect(authCookies(profile, 'session_data').map(cachedName)).toEqual(['Latest']);
    expectNoDuplicateCookies(profile);
    await expect(me(app, jar.clone().apply(profile))).resolves.toEqual({
      user: 'Latest',
      session: 'Latest',
    });

    // The lookup refreshes the cache cookie and signOut then clears it.
    const logout = await send(app, '/logout', { jar, body: {} });
    const data = authCookies(logout, 'session_data');
    const token = authCookies(logout, 'session_token');
    expect(data).toHaveLength(1);
    expect(token).toHaveLength(1);
    expect(isCleared(data[0]!)).toBe(true);
    expect(isCleared(token[0]!)).toBe(true);
    expectNoDuplicateCookies(logout);
    jar.apply(logout);
    expect([...jar.cookies.keys()].filter((name) => name.includes('better-auth.'))).toEqual([]);
    await expect(me(app, jar)).resolves.toEqual({ user: null, session: null });
  });

  it.each(['asResponse', 'returnHeaders'] as const)(
    'lets cookies returned through %s win over the session lookup refresh',
    async (mode) => {
      const { app } = fixture();
      app.post('/profile', async (c) => {
        const input = { body: { name: 'Returned' }, headers: c.req.raw.headers };
        if (mode === 'asResponse') {
          return getAuth(c).api.updateUser({ ...input, asResponse: true });
        }
        const { headers } = await getAuth(c).api.updateUser({ ...input, returnHeaders: true });
        for (const cookie of headers.getSetCookie()) {
          c.header('set-cookie', cookie, { append: true });
        }
        return c.json({ ok: true });
      });
      // An expired cache cookie makes the session lookup set a new one first.
      const jar = (await signIn(app)).without('session_data');

      const response = await send(app, '/profile', { jar, body: {} });

      expect(response.status).toBe(200);
      expect(authCookies(response, 'session_data').map(cachedName).at(-1)).toBe('Returned');
      await expect(me(app, jar.apply(response))).resolves.toEqual({
        user: 'Returned',
        session: 'Returned',
      });
    },
  );

  it('keeps a single copy of cookies from a rewritten route', async () => {
    const { app } = fixture();
    app.post('/profile', (c) => (c as RoutingContext).rewrite('/profile/save'));
    app.post('/profile/save', async (c) => {
      await getAuth(c).api.updateUser({ body: { name: 'Rewritten' }, headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    const jar = await signIn(app);

    const response = await send(app, '/profile', { jar, body: {} });

    expect(response.status).toBe(200);
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    await expect(me(app, jar.apply(response))).resolves.toMatchObject({ user: 'Rewritten' });
  });

  it.each([
    ['object', (config: BetterAuthOptions) => config],
    [
      'function',
      (config: BetterAuthOptions) =>
        ({ defaults }: { defaults: BetterAuthOptions }) => ({ ...defaults, ...config }),
    ],
  ] as const)('forwards cookies set by user hooks and plugins (%s config)', async (_form, wrap) => {
    const plugin = {
      id: 'app-plugin',
      hooks: {
        after: [
          {
            matcher: (ctx) => ctx.path === '/update-user',
            handler: createAuthMiddleware(async (ctx) => {
              ctx.setCookie('app_plugin', 'updated', { path: '/' });
            }),
          },
        ],
      },
    } satisfies BetterAuthPlugin;
    const plugins = [plugin];
    const { app } = fixture(
      wrap({
        ...cookieCache,
        plugins,
        hooks: {
          after: createAuthMiddleware(async (ctx) => {
            if (ctx.path === '/update-user') {
              ctx.setCookie('app_hook', 'updated', { path: '/' });
            }
          }),
        },
      }),
    );
    app.post('/profile', async (c) => {
      const auth = getAuth(c);
      await auth.api.updateUser({ body: { name: 'Hooked' }, headers: c.req.raw.headers });
      return c.json({ plugins: auth.options.plugins?.map((entry) => entry.id) });
    });
    const jar = await signIn(app);

    const response = await send(app, '/profile', { jar, body: {} });

    await expect(response.json()).resolves.toEqual({ plugins: ['app-plugin', 'void-cookies'] });
    expect(plugins).toEqual([plugin]);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith('app_hook=updated'))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('app_plugin=updated'))).toBe(true);
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    jar.apply(response);
    expect(jar.cookies.get('app_hook')).toBe('updated');
    await expect(me(app, jar)).resolves.toMatchObject({ user: 'Hooked' });
  });

  it('lets a route answer an APIError from an auth.api call', async () => {
    const { app } = fixture();
    app.post('/password', async (c) => {
      try {
        await getAuth(c).api.changePassword({
          body: { currentPassword: 'wrong-password-value', newPassword: 'another-long-password' },
          headers: c.req.raw.headers,
        });
      } catch (error) {
        if (error instanceof APIError) {
          return c.json({ error: error.body?.code ?? error.message }, 400);
        }
        throw error;
      }
      return c.json({ ok: true });
    });
    const jar = await signIn(app);

    const response = await send(app, '/password', { jar, body: {} });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'INVALID_PASSWORD' });
    // changePassword reads the session without its cache, so Better Auth
    // refreshes the cache cookie before the password check fails.
    expect(authCookies(response, 'session_token')).toEqual([]);
    expect(authCookies(response, 'session_data').map(cachedName)).toEqual(['Old name']);
    expectNoDuplicateCookies(response);
    await expect(me(app, jar.apply(response))).resolves.toEqual({
      user: 'Old name',
      session: 'Old name',
    });
  });

  it('forwards cookies from a successful call when the route then fails', async () => {
    const { app } = fixture();
    app.onError((_error, c) => c.text('failed', 500));
    app.post('/profile', async (c) => {
      await getAuth(c).api.updateUser({ body: { name: 'Saved' }, headers: c.req.raw.headers });
      throw new Error('after save');
    });
    const jar = await signIn(app);

    const response = await send(app, '/profile', { jar, body: {} });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('failed');
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    await expect(me(app, jar.apply(response))).resolves.toMatchObject({ user: 'Saved' });
  });

  it('forwards calls from middleware after auth and from the route', async () => {
    const { app } = fixture();
    app.use('/settings/*', async (c, next) => {
      await getAuth(c).api.updateUser({
        body: { name: 'From middleware' },
        headers: c.req.raw.headers,
      });
      await next();
    });
    app.post('/settings/avatar', async (c) => {
      await getAuth(c).api.updateUser({
        body: { image: 'https://app.test/avatar.png' },
        headers: c.req.raw.headers,
      });
      return c.json({ ok: true });
    });
    app.get('/settings/view', (c) => c.json({ ok: true }));
    const jar = await signIn(app);

    const view = await send(app, '/settings/view', { jar });
    expect(authCookies(view, 'session_data')).toHaveLength(1);
    await expect(me(app, jar.clone().apply(view))).resolves.toMatchObject({
      user: 'From middleware',
    });

    // Both calls set the cache cookie. The route's later one has both changes.
    const response = await send(app, '/settings/avatar', { jar, body: {} });
    const data = authCookies(response, 'session_data');
    expect(data.map(cachedUser)).toMatchObject([
      { name: 'From middleware', image: 'https://app.test/avatar.png' },
    ]);
    expectNoDuplicateCookies(response);
    jar.apply(response);
    const session = await send(app, '/api/auth/get-session', { jar });
    await expect(session.json()).resolves.toMatchObject({
      user: { name: 'From middleware', image: 'https://app.test/avatar.png' },
    });
  });

  it('does not share cookies between concurrent requests', async () => {
    const { app } = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    app.post('/profile', async (c) => {
      await getAuth(c).api.updateUser({ body: { name: 'Concurrent' }, headers: c.req.raw.headers });
      await held;
      return c.json({ ok: true });
    });
    app.get('/plain', async (c) => {
      await held;
      return c.text('plain');
    });
    const jar = await signIn(app);

    const pending = Promise.all([
      send(app, '/profile', { jar, body: {} }),
      send(app, '/plain', { jar }),
      send(app, '/plain'),
    ]);
    setTimeout(release, 10);
    const [profile, signedIn, anonymous] = await pending;

    expect(authCookies(profile, 'session_data')).toHaveLength(1);
    expect(signedIn.headers.has('set-cookie')).toBe(false);
    expect(anonymous.headers.has('set-cookie')).toBe(false);
  });
});

describe('merging session lookup cookies with auth.api cookies', () => {
  function authCookieName(jar: CookieJar, suffix: string): string {
    const name = [...jar.cookies.keys()].find((key) => key.endsWith(`better-auth.${suffix}`));
    expect(name).toBeDefined();
    return name!;
  }

  it('signs out after a route reads a session whose cache cookie is unreadable', async () => {
    const { app } = fixture();
    app.post('/switch', async (c) => {
      const headers = c.req.raw.headers;
      await getAuth(c).api.getSession({ headers });
      await getAuth(c).api.signOut({ headers });
      return c.json({ ok: true });
    });
    const jar = await signIn(app);
    jar.cookies.set(authCookieName(jar, 'session_data'), 'not-a-cache-cookie');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await send(app, '/switch', { jar, body: {} });

    logged.mockRestore();
    expect(response.status).toBe(200);
    const data = authCookies(response, 'session_data');
    const token = authCookies(response, 'session_token');
    expect(data).toHaveLength(1);
    expect(token).toHaveLength(1);
    expect(isCleared(data[0]!)).toBe(true);
    expect(isCleared(token[0]!)).toBe(true);
    expectNoDuplicateCookies(response);
    jar.apply(response);
    expect([...jar.cookies.keys()].filter((name) => name.includes('better-auth.'))).toEqual([]);
    await expect(me(app, jar)).resolves.toEqual({ user: null, session: null });
    const cache = await getCookieCache(new Request(origin, { headers: { cookie: jar.header() } }), {
      secret: env.BETTER_AUTH_SECRET,
      isSecure: true,
    });
    expect(cache).toBeNull();
  });

  it('clears the token from a signOut asResponse after the lookup refreshed it', async () => {
    const { app } = fixture({ session: { updateAge: 0 } });
    app.post('/logout', (c) =>
      getAuth(c).api.signOut({ headers: c.req.raw.headers, asResponse: true }),
    );
    const jar = await signIn(app);
    // With updateAge 0 the session lookup sends a refreshed token every time.
    const refresh = await send(app, '/me', { jar });
    expect(authCookies(refresh, 'session_token')).toHaveLength(1);
    expect(isCleared(authCookies(refresh, 'session_token')[0]!)).toBe(false);

    const response = await send(app, '/logout', { jar, body: {} });

    expect(response.status).toBe(200);
    const token = authCookies(response, 'session_token');
    expect(token).toHaveLength(1);
    expect(isCleared(token[0]!)).toBe(true);
    jar.apply(response);
    expect([...jar.cookies.keys()].filter((name) => name.includes('better-auth.'))).toEqual([]);
    await expect(me(app, jar)).resolves.toEqual({ user: null, session: null });
  });

  it('keeps a cookie the route set under an auth cookie key', async () => {
    const { app } = fixture();
    let cleared = '';
    app.post('/forget-cache', (c) => {
      c.header('set-cookie', cleared, { append: true });
      return c.json({ ok: true });
    });
    const signedIn = await signIn(app);
    const dataName = authCookieName(signedIn, 'session_data');
    cleared = `${dataName}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
    // Without the cache cookie, the session lookup sets a new one.
    const jar = signedIn.without('session_data');

    const response = await send(app, '/forget-cache', { jar, body: {} });

    expect(authCookies(response, 'session_data')).toEqual([cleared]);
    expectNoDuplicateCookies(response);
    jar.apply(response);
    expect(jar.cookies.has(dataName)).toBe(false);
    await expect(me(app, jar)).resolves.toEqual({ user: 'Old name', session: 'Old name' });
  });

  it('leaves app cookies and their cache policy to the route', async () => {
    const { app } = fixture();
    app.get('/theme', (c) => {
      c.header('set-cookie', 'theme=dark; Path=/; Max-Age=600', { append: true });
      return c.text('theme', 200, { 'cache-control': 'public, max-age=60' });
    });
    app.post('/profile', async (c) => {
      c.header('set-cookie', 'theme=light; Path=/', { append: true });
      await getAuth(c).api.updateUser({ body: { name: 'Themed' }, headers: c.req.raw.headers });
      return c.json({ ok: true });
    });

    const anonymous = await send(app, '/theme');
    expect(anonymous.headers.getSetCookie()).toEqual(['theme=dark; Path=/; Max-Age=600']);
    expect(anonymous.headers.get('cache-control')).toBe('public, max-age=60');
    expect(anonymous.headers.has('pragma')).toBe(false);

    const jar = await signIn(app);
    const response = await send(app, '/profile', { jar, body: {} });
    const cookies = response.headers.getSetCookie();
    expect(cookies.filter((cookie) => cookie.startsWith('theme='))).toEqual([
      'theme=light; Path=/',
    ]);
    expect(authCookies(response, 'session_data').map(cachedName)).toEqual(['Themed']);
    expectNoDuplicateCookies(response);
  });

  it('sends only the last cookie for a key the session lookup set twice', async () => {
    const visit = (value: string) =>
      createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/get-session') {
          ctx.setCookie('app_visit', value, { path: '/' });
        }
      });
    const { app } = fixture({
      ...cookieCache,
      hooks: { after: visit('first') },
      plugins: [
        {
          id: 'app-visit',
          hooks: { after: [{ matcher: () => true, handler: visit('second') }] },
        },
      ],
    });
    app.get('/page', (c) => c.text('page'));

    const response = await send(app, '/page');

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(['app_visit=second; Path=/']);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('auth router responses after auth.api calls in middleware', () => {
  // A user middleware reads the session again. Without the cache cookie, that
  // call sets a new one for the signed-in user.
  const readSession = (app: Hono) =>
    app.use(async (c, next) => {
      await getAuth(c).api.getSession({ headers: c.req.raw.headers });
      await next();
    });

  it('keeps the router sign-out over a cache cookie from middleware', async () => {
    const { app } = fixture(cookieCache, readSession);
    const jar = (await signIn(app)).without('session_data');

    const response = await send(app, '/api/auth/sign-out', { jar, body: {} });

    expect(response.status).toBe(200);
    expect(authCookies(response, 'session_data').every(isCleared)).toBe(true);
    expect(authCookies(response, 'session_token').every(isCleared)).toBe(true);
    jar.apply(response);
    expect([...jar.cookies.keys()].filter((name) => name.includes('better-auth.'))).toEqual([]);
    await expect(me(app, jar)).resolves.toEqual({ user: null, session: null });
  });

  it('keeps the router sign-in of another user over a cache cookie from middleware', async () => {
    const { app } = fixture(cookieCache, readSession);
    await signIn(app, 'Second user', 'second@example.test');
    const jar = (await signIn(app, 'First user')).without('session_data');

    const response = await send(app, '/api/auth/sign-in/email', {
      jar,
      body: { email: 'second@example.test', password },
    });

    expect(response.status).toBe(200);
    expect(authCookies(response, 'session_data').map(cachedName)).toEqual(['Second user']);
    expectNoDuplicateCookies(response);
    await expect(me(app, jar.apply(response))).resolves.toEqual({
      user: 'Second user',
      session: 'Second user',
    });
  });
});

describe('auth.api cookies on requests from another origin', () => {
  const evil = 'https://evil.test';
  const partner = 'https://partner.test';

  function loginFixture(config: BetterAuthOptions = cookieCache) {
    const { app } = fixture(config);
    app.post('/login', async (c) => {
      const credentials = await c.req.json<{ email: string; password: string }>();
      await getAuth(c).api.signInEmail({ body: credentials, headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    app.get('/login', async (c) => {
      const { email, password } = c.req.query();
      await getAuth(c).api.signInEmail({ body: { email: email!, password: password! } });
      return c.json({ ok: true });
    });
    return app;
  }

  async function postLogin(app: Hono, origin?: string): Promise<Response> {
    return app.request(
      'https://app.test/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ email, password }),
      },
      env,
    );
  }

  async function expectSignedIn(app: Hono, response: Response): Promise<void> {
    expect(response.status).toBe(200);
    expect(authCookies(response, 'session_token')).toHaveLength(1);
    await expect(me(app, new CookieJar().apply(response))).resolves.toEqual({
      user: 'Old name',
      session: 'Old name',
    });
  }

  it('does not send session cookies from a cross-origin POST', async () => {
    const app = loginFixture();
    await signIn(app);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await postLogin(app, evil);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/^auth: Did not send cookies set by auth\.api calls/);
    warn.mockRestore();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.getSetCookie()).toEqual([]);
    await expect(me(app, new CookieJar().apply(response))).resolves.toEqual({
      user: null,
      session: null,
    });
  });

  it.each([
    ['the request origin', 'https://app.test'],
    ['no Origin header', undefined],
  ])('sends session cookies for %s', async (_label, origin) => {
    const app = loginFixture();
    await signIn(app);
    const warn = vi.spyOn(console, 'warn');

    await expectSignedIn(app, await postLogin(app, origin));

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each<[string, BetterAuthOptions, string]>([
    [
      'a trustedOrigins list',
      { ...cookieCache, trustedOrigins: ['https://app.test', partner] },
      partner,
    ],
    ['trustedOrigins function', { ...cookieCache, trustedOrigins: async () => [partner] }, partner],
    ['disableCSRFCheck', { ...cookieCache, advanced: { disableCSRFCheck: true } }, evil],
  ])('sends session cookies for a foreign origin allowed by %s', async (_label, config, origin) => {
    const app = loginFixture(config);
    await signIn(app);

    await expectSignedIn(app, await postLogin(app, origin));
  });

  it('sends session cookies for a GET from another origin', async () => {
    const app = loginFixture();
    await signIn(app);
    const query = new URLSearchParams({ email, password });

    const response = await app.request(
      `https://app.test/login?${query}`,
      { headers: { origin: evil } },
      env,
    );

    await expectSignedIn(app, response);
  });
});

describe('cookie keys and positions', () => {
  it('treats cookie domains without case or a leading dot, and paths with case', async () => {
    const plugin = {
      id: 'app-cookies',
      hooks: {
        after: [
          {
            matcher: (ctx) => ctx.path === '/update-user',
            handler: createAuthMiddleware(async (ctx) => {
              ctx.setCookie('x', 'forwarded', { domain: '.example.com', path: '/' });
              ctx.setCookie('y', 'forwarded', { path: '/a' });
            }),
          },
        ],
      },
    } satisfies BetterAuthPlugin;
    const { app } = fixture({ ...cookieCache, plugins: [plugin] });
    app.post('/profile', async (c) => {
      c.header('set-cookie', 'x=route; Domain=Example.com; Path=/', { append: true });
      c.header('set-cookie', 'y=route; Path=/A', { append: true });
      await getAuth(c).api.updateUser({ body: { name: 'Keys' }, headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    const jar = await signIn(app);

    const response = await send(app, '/profile', { jar, body: {} });

    const cookies = response.headers.getSetCookie();
    expect(cookies.filter((cookie) => cookie.startsWith('x='))).toEqual([
      'x=route; Domain=Example.com; Path=/',
    ]);
    const y = cookies.filter((cookie) => cookie.startsWith('y='));
    expect(y).toHaveLength(2);
    expect(y[0]).toBe('y=route; Path=/A');
    expect(y[1]).toMatch(/^y=forwarded;.*Path=\/a(?:;|$)/);
  });

  it('sends a later signOut after the route copied returned headers', async () => {
    const { app } = fixture();
    app.post('/rename-and-leave', async (c) => {
      const { headers } = await getAuth(c).api.updateUser({
        body: { name: 'Leaving' },
        headers: c.req.raw.headers,
        returnHeaders: true,
      });
      for (const cookie of headers.getSetCookie()) {
        c.header('set-cookie', cookie, { append: true });
      }
      await getAuth(c).api.signOut({ headers: c.req.raw.headers });
      return c.json({ ok: true });
    });
    const jar = await signIn(app);

    const response = await send(app, '/rename-and-leave', { jar, body: {} });

    expect(response.status).toBe(200);
    expect(isCleared(authCookies(response, 'session_data').at(-1)!)).toBe(true);
    expect(isCleared(authCookies(response, 'session_token').at(-1)!)).toBe(true);
    jar.apply(response);
    expect([...jar.cookies.keys()].filter((name) => name.includes('better-auth.'))).toEqual([]);
    await expect(me(app, jar)).resolves.toEqual({ user: null, session: null });
  });
});

describe('cookies from auth.api calls in Pages actions', () => {
  function pagesFixture() {
    const { app } = fixture();
    app.post(
      '/settings',
      createPageMutationHandler({
        componentId: 'settings',
        render: async () => '<html></html>',
        assets: async () => ({ css: '', body: '', preloads: '' }),
        headConfig: null,
        renderOptions: { renderMode: 'server' },
        load: async () => ({
          action: async (c) => {
            const form = await c.req.formData();
            await getAuth(c).api.updateUser({
              body: { name: String(form.get('name')) },
              headers: c.req.raw.headers,
            });
            return c.redirect('/settings', 303);
          },
        }),
      }),
    );
    return app;
  }

  function submit(app: Hono, jar: CookieJar, name: string, headers: Record<string, string>) {
    const body = new FormData();
    body.set('name', name);
    return app.request(
      origin + '/settings',
      { method: 'POST', body, headers: { cookie: jar.header(), origin, ...headers } },
      env,
    );
  }

  it('keeps the refreshed cookie on a manual Pages redirect', async () => {
    const app = pagesFixture();
    const jar = await signIn(app);

    const response = await submit(app, jar, 'Pages action', {
      'X-VoidPages': 'true',
      'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      'X-VoidPages-Redirect': 'manual',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-VoidPages-Redirect')).toBe('303');
    expect(response.headers.get('location')).toBe('/settings');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    expectNoDuplicateCookies(response);
    await expect(me(app, jar.apply(response))).resolves.toEqual({
      user: 'Pages action',
      session: 'Pages action',
    });
  });

  it('keeps the refreshed cookie on a document form redirect', async () => {
    const app = pagesFixture();
    const jar = await signIn(app);

    const response = await submit(app, jar, 'Form action', {});

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/settings');
    expect(authCookies(response, 'session_data')).toHaveLength(1);
    await expect(me(app, jar.apply(response))).resolves.toMatchObject({ user: 'Form action' });
  });
});
