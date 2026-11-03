import { handleIsr, type IsrCacheEnv } from '@void/isr/runtime';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Hono, type NotFoundHandler } from 'hono';
import { etag } from 'hono/etag';
import { describe, expect, it } from 'vite-plus/test';
import { createVoidAuthRuntime } from '../../src/runtime/better-auth-shared.ts';
import { createErrorRenderer } from '../../src/runtime/routing-errors.ts';
import {
  createAssetNotFound,
  createPagesFallback,
  createSsrFallback,
} from '../../src/runtime/routing-pages.ts';
import { createRoutingRuntime } from '../../src/runtime/routing.ts';

const env = { BETTER_AUTH_SECRET: 'local-test-secret-with-at-least-32-characters' };
const options = { dialect: 'sqlite' as const, providers: null };

function fixture() {
  const database = memoryAdapter({});
  const runtime = createVoidAuthRuntime('sqlite', async () => {});
  const app = new Hono();
  app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options, database));
  return { app, runtime, database };
}

describe('real anonymous Better Auth lookup cache policy', () => {
  it('does not copy the null-session lookup policy onto an ordinary response', async () => {
    const { app, runtime, database } = fixture();
    const request = new Request('https://app.test/assets/client-abcdefgh.js');
    const auth = await runtime.createVoidAuth(request, env, options, database);
    const lookup = await auth.api.getSession({
      headers: request.headers,
      asResponse: false,
      returnHeaders: true,
    });
    expect(lookup.response).toBeNull();
    expect(lookup.headers.get('cache-control')).toBe('no-store');
    expect(lookup.headers.get('pragma')).toBe('no-cache');
    expect(lookup.headers.has('set-cookie')).toBe(false);
    app.get(
      '/assets/client-abcdefgh.js',
      () =>
        new Response('export const value = 1;', {
          headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        }),
    );
    const response = await app.fetch(request, env);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.has('pragma')).toBe(false);
    await expect(response.text()).resolves.toBe('export const value = 1;');
  });

  it('allows anonymous ISR to populate KV and serve a hit on the next request', async () => {
    const { app } = fixture();
    let renders = 0;
    app.get('/revalidate', (c) => c.html(`<html>render ${++renders}</html>`));
    const records = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
    const cacheEnv: IsrCacheEnv = {
      ISR_CACHE: {
        async getWithMetadata(key: string) {
          return records.get(key) ?? { value: null, metadata: null };
        },
        async put(key: string, value: ArrayBuffer, config: { metadata: unknown }) {
          records.set(key, { value, metadata: config.metadata });
        },
        async list() {
          return { keys: [...records.keys()].map((name) => ({ name })), list_complete: true };
        },
      } as unknown as KVNamespace,
    };
    const request = new Request('https://app.test/revalidate', {
      headers: { 'x-fixture-guard': 'allowed' },
    });
    const tasks: Array<Promise<unknown>> = [];
    const context = {
      waitUntil: (task: Promise<unknown>) => tasks.push(task),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;
    const render = async (input: Request): Promise<Response> => app.fetch(input, env);
    const policy = { deploymentId: 'test-deployment', revalidate: { '/revalidate': 60 } };
    const first = await handleIsr(request, cacheEnv, context, policy, render);
    expect(first?.headers.get('x-isr-cache')).toBe('MISS');
    await Promise.all(tasks);
    expect(records.size).toBeGreaterThan(0);
    const second = await handleIsr(request, cacheEnv, context, policy, render);
    expect(second?.headers.get('x-isr-cache')).toBe('HIT');
    expect(renders).toBe(1);
    await expect(second?.text()).resolves.toBe('<html>render 1</html>');
  });

  it('retains the actual auth endpoint no-store and no-cache headers', async () => {
    const { app, runtime, database } = fixture();
    app.get('/api/auth/get-session', (c) => runtime.handleVoidAuthRequest(c, options, database));
    const response = await app.request('https://app.test/api/auth/get-session', undefined, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    await expect(response.json()).resolves.toBeNull();
  });
});

describe('real authenticated Better Auth session cache policy', () => {
  async function signedInApp(
    routeHeaders: Record<string, string>,
    {
      withEtag = false,
      fallback,
    }: { withEtag?: boolean; fallback?: (app: Hono) => NotFoundHandler } = {},
  ) {
    const database = memoryAdapter({ user: [], session: [], account: [], verification: [] });
    const runtime = createVoidAuthRuntime('sqlite', async () => {});
    const app = new Hono();
    if (fallback) {
      app.notFound(fallback(app));
    }
    app.use(async (c, next) => runtime.runVoidAuthMiddleware(c, next, options, database));
    app.on(['GET', 'POST'], '/api/auth/*', (c) =>
      runtime.handleVoidAuthRequest(c, options, database),
    );
    if (withEtag) {
      app.use('/api/report', etag());
    }
    app.get('/api/report', (c) => c.text('report', 200, routeHeaders));
    const signUp = await app.request(
      'https://app.test/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Cache user',
          email: 'cache-user@example.test',
          password: 'correct-horse-battery-staple',
        }),
      },
      env,
    );
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = await app.request(
      'https://app.test/api/auth/get-session',
      { headers: { cookie } },
      env,
    );
    await expect(session.json()).resolves.toMatchObject({
      user: { email: 'cache-user@example.test' },
    });
    return { app, cookie };
  }

  it.each(['private, no-cache', 'no-store', 'Private, No-Cache, max-age=60', 'private,\tno-cache'])(
    'keeps a no-store or private, no-cache route policy: %s',
    async (policy) => {
      const { app, cookie } = await signedInApp({ 'cache-control': policy, etag: 'W/"report-1"' });
      const response = await app.request(
        'https://app.test/api/report',
        { headers: { cookie } },
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe(policy);
      expect(response.headers.has('pragma')).toBe(false);
      expect(response.headers.get('etag')).toBe('W/"report-1"');
    },
  );

  it.each([
    null,
    'public, max-age=60',
    'no-cache',
    'private="set-cookie", max-age=60',
    'private',
    'private, max-age=60',
    'private, no-cache="set-cookie"',
    'no-cache="x,private,y", public, max-age=600',
    'no-cache="x,no-store,y", public, max-age=600',
    'no-cache="a\\",no-store,b", public, max-age=600',
  ])('applies the session lookup no-store to a route policy of %s', async (policy) => {
    const { app, cookie } = await signedInApp(policy ? { 'cache-control': policy } : {});
    const response = await app.request('https://app.test/api/report', { headers: { cookie } }, env);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });

  it('answers a signed-in repeat request with 304 through etag()', async () => {
    const { app, cookie } = await signedInApp(
      { 'cache-control': 'private, no-cache' },
      { withEtag: true },
    );
    const first = await app.request('https://app.test/api/report', { headers: { cookie } }, env);
    expect(first.status).toBe(200);
    const tag = first.headers.get('etag');
    expect(tag).toBeTruthy();
    const repeat = await app.request(
      'https://app.test/api/report',
      { headers: { cookie, 'if-none-match': tag! } },
      env,
    );
    expect(repeat.status).toBe(304);
    expect(repeat.headers.get('cache-control')).toBe('private, no-cache');
    expect(repeat.headers.has('pragma')).toBe(false);
    expect(repeat.headers.get('etag')).toBe(tag);
  });

  describe('static assets', () => {
    const revalidate = 'public, max-age=0, must-revalidate';
    const assetEnv = {
      ...env,
      ASSETS: {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          if (path === '/.vite/manifest.json') {
            return Response.json({
              'src/client.ts': {
                file: 'assets/client-abcdefgh.js',
                immutableFiles: ['assets/client-abcdefgh.js'],
              },
            });
          }
          if (!['/assets/client-abcdefgh.js', '/favicon.ico'].includes(path)) {
            return new Response('Not Found', { status: 404 });
          }
          const headers = { 'cache-control': revalidate, etag: '"file"' };
          return request.headers.get('if-none-match') === '"file"'
            ? new Response(null, { status: 304, headers })
            : new Response('file', { headers });
        },
      },
    };
    const errors = createErrorRenderer({ projectRoot: '/project', homeDir: '/home' });
    const fallbacks: Array<[string, (app: Hono) => NotFoundHandler]> = [
      ['Pages', (app) => createPagesFallback({ routing: createRoutingRuntime(app, {}), errors })],
      [
        'SSR',
        (app) =>
          createSsrFallback({
            routing: createRoutingRuntime(app, {}),
            load: async () => ({ render: async () => new Response('rendered') }),
            assets: async () => ({ css: '', body: '', preloads: '' }),
          }),
      ],
      ['asset-only', (app) => createAssetNotFound({ routing: createRoutingRuntime(app, {}) })],
    ];

    async function fetchAsset(
      app: Hono,
      path: string,
      headers: Record<string, string> = {},
    ): Promise<Response> {
      return app.request('https://app.test' + path, { headers }, assetEnv);
    }

    it.each(fallbacks)(
      'keeps the file policy private from the %s fallback',
      async (_label, fallback) => {
        const { app, cookie } = await signedInApp({}, { fallback });
        const signedIn = await fetchAsset(app, '/assets/client-abcdefgh.js', { cookie });
        expect(signedIn.status).toBe(200);
        expect(signedIn.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
        expect(signedIn.headers.has('pragma')).toBe(false);
        expect(signedIn.headers.get('etag')).toBe('"file"');
        await expect(signedIn.text()).resolves.toBe('file');

        const unrelatedCookie = await fetchAsset(app, '/assets/client-abcdefgh.js', {
          cookie: '_ga=1',
        });
        expect(unrelatedCookie.headers.get('cache-control')).toBe(
          'private, max-age=31536000, immutable',
        );
        expect(unrelatedCookie.headers.has('pragma')).toBe(false);

        const anonymous = await fetchAsset(app, '/assets/client-abcdefgh.js');
        expect(anonymous.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

        const publicFile = await fetchAsset(app, '/favicon.ico', { cookie });
        expect(publicFile.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
        expect(publicFile.headers.has('pragma')).toBe(false);

        const revalidated = await fetchAsset(app, '/favicon.ico', {
          cookie,
          'if-none-match': '"file"',
        });
        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.get('cache-control')).toBe(
          'private, max-age=0, must-revalidate',
        );
        expect(revalidated.headers.has('pragma')).toBe(false);
      },
    );

    it('still applies no-store to a signed-in page miss', async () => {
      const { app, cookie } = await signedInApp({}, { fallback: fallbacks[0]![1] });
      const response = await fetchAsset(app, '/missing', { cookie });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
    });
  });
});
