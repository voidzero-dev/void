import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vite-plus/test';
import { defer } from '../../src/pages/defer.ts';
import {
  handlePageGet,
  handlePageMutation,
  flattenValidationErrors,
  ValidationError,
} from '../../src/pages/protocol.ts';
import { defineHandler, defineMiddleware } from '../../src/runtime/handler.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

type TestContext = Context & { set(key: string, value: unknown): void };
type RenderPage = { component: string };
type PageResponse = {
  component: string;
  props: Record<string, unknown>;
  params?: Record<string, string>;
  url: string;
  errors: Record<string, string> | null;
  shared?: Record<string, unknown>;
  deferred?: Array<string>;
  deferredKeys?: Record<string, string>;
};

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Create a minimal Hono context for testing */
function createTestContext(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: string;
    routePattern?: string;
    shared?: Record<string, unknown>;
  } = {},
): Promise<Context> {
  const app = new Hono();
  let resolveContext!: (c: Context) => void;
  const contextPromise = new Promise<Context>((resolve) => {
    resolveContext = resolve;
  });

  app.use(async (c, next) => {
    if (options.shared) {
      (c as TestContext).set('shared', options.shared);
    }
    await next();
  });

  app.all(options.routePattern ?? '*', (c) => {
    resolveContext!(c);
    return c.text('ok');
  });

  const url = `http://localhost${path}`;
  const init: RequestInit = { method, headers: options.headers };
  if (options.body !== undefined) {
    init.body = options.body;
  }
  const req = new Request(url, init);
  void app.fetch(req);

  return contextPromise;
}

const mockRenderFn = vi.fn(async (pageObj: RenderPage) => `<html>${pageObj.component}</html>`);
const mockGetAssetTags = vi.fn(async () => ({ css: '', preloads: '', body: '' }));

describe('handlePageGet', () => {
  it.each([false, true])(
    'preserves loader Vary headers on Pages JSON (deferred=%s)',
    async (deferred) => {
      const c = await createTestContext('GET', '/users', { headers: { 'x-voidpages': 'true' } });
      const response = await handlePageGet(
        (ctx) => {
          ctx.header('Vary', 'Accept-Language');
          return deferred ? { users: defer(async () => []) } : { users: [] };
        },
        undefined,
        c,
        'users',
        mockRenderFn,
        mockGetAssetTags,
      );
      expect(response.headers.get('X-VoidPages')).toBe('true');
      expect(response.headers.get('Vary')).toBe('Accept-Language, X-VoidPages');
      await response.text();
    },
  );

  it('returns JSON page object when X-VoidPages header present', async () => {
    const c = await createTestContext('GET', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const handler = vi.fn(() => ({ users: [1, 2, 3] }));
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('X-VoidPages')).toBe('true');
    expect(response.headers.get('Vary')).toBe('X-VoidPages');
    const body = await json<PageResponse>(response);
    expect(body.component).toBe('users');
    expect(body.props).toEqual({ users: [1, 2, 3] });
    expect(body.url).toBe('/users');
    expect(body.errors).toBeNull();
    expect(body.deferred).toBeUndefined();
  });

  it('preserves headers set by loaders on X-VoidPages JSON responses', async () => {
    const c = await createTestContext('GET', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const handler = vi.fn((ctx: Context) => {
      ctx.header('Set-Cookie', 'void_auth_nonce=abc; Path=/auth; HttpOnly');
      return { users: [] };
    });
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('Set-Cookie')).toContain('void_auth_nonce=abc');
    expect(response.headers.get('X-VoidPages')).toBe('true');
  });

  it('includes route params in page objects without requiring loader props', async () => {
    const c = await createTestContext('GET', '/posts/abc-123?preview=true', {
      headers: { 'x-voidpages': 'true' },
      routePattern: '/posts/:id',
    });

    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      'posts/[id]',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.props).toEqual({});
    expect(body.params).toEqual({ id: 'abc-123' });
    expect(body.url).toBe('/posts/abc-123?preview=true');
  });

  it('passes route params to rendered page objects', async () => {
    const c = await createTestContext('GET', '/posts/abc-123', {
      routePattern: '/posts/:id',
    });
    const renderFn = vi.fn(async () => '<html>post</html>');

    await handlePageGet(undefined, undefined, c, 'posts/[id]', renderFn, mockGetAssetTags);

    expect(renderFn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'posts/[id]',
        params: { id: 'abc-123' },
        props: {},
        url: '/posts/abc-123',
      }),
      expect.anything(),
    );
  });

  it('calls renderFn and returns HTML when no X-VoidPages header', async () => {
    const c = await createTestContext('GET', '/users');

    const handler = vi.fn(() => ({ users: [] }));
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('users');
  });

  it('preserves headers set by loaders on rendered HTML responses', async () => {
    const c = await createTestContext('GET', '/login');

    const handler = vi.fn((ctx: Context) => {
      ctx.header('Set-Cookie', 'void_auth_nonce=abc; Path=/auth; HttpOnly');
      return { githubUrl: '/auth/github' };
    });
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'login',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('Set-Cookie')).toContain('void_auth_nonce=abc');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('passes through redirect Response from loader', async () => {
    const c = await createTestContext('GET', '/auth/callback');

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: '/' },
    });
    const handler = vi.fn(() => redirect);
    const renderFn = vi.fn(async (pageObj: RenderPage) => `<html>${pageObj.component}</html>`);
    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'callback',
      renderFn,
      mockGetAssetTags,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('island=true always renders HTML even with X-VoidPages header', async () => {
    const c = await createTestContext('GET', '/', {
      headers: { 'x-voidpages': 'true' },
    });

    const renderFn = vi.fn(async () => '<html>island</html>');
    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      'index',
      renderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'island' },
    );

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(renderFn).toHaveBeenCalled();
  });

  it('serializes dev CSS records with a nonce before rendering HTML', async () => {
    const c = await createTestContext('GET', '/styled');
    const renderFn = vi.fn(
      async (_pageObj: RenderPage, assetTags) => `<html><head>${assetTags.css}</head></html>`,
    );
    const response = await handlePageGet(undefined, undefined, c, 'styled', renderFn, async () => ({
      css: '',
      preloads: '',
      body: '',
      devCss: [{ url: '/pages/styled.tsx?x=1', css: '.x:before{content:"</STYLE>"}' }],
    }));

    const html = await response.text();
    expect(html).toContain('data-vite-dev-id="/pages/styled.tsx?x=1"');
    expect(html).toContain('nonce="');
    expect(html).toContain('<\\/style>');
    expect(html).not.toContain('</STYLE>');
  });

  it('adds a quoted dev CSS nonce source to strict style CSP responses', async () => {
    const c = await createTestContext('GET', '/styled');
    const response = await handlePageGet(
      (ctx: Context) => {
        ctx.header('Content-Security-Policy', "default-src 'self'; style-src 'self'");
        return {};
      },
      undefined,
      c,
      'styled',
      vi.fn(async (_pageObj: RenderPage, assetTags) => `<html>${assetTags.css}</html>`),
      async () => ({
        css: '',
        preloads: '',
        body: '',
        devCss: [{ url: '/pages/styled.css', css: '.x{color:red}' }],
      }),
    );

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("style-src 'self' 'nonce-");
    expect(csp).not.toContain("style-src 'self' nonce-");
  });

  it('adds style-src with a quoted nonce when only default-src is present', async () => {
    const c = await createTestContext('GET', '/styled');
    const response = await handlePageGet(
      (ctx: Context) => {
        ctx.header('Content-Security-Policy', "default-src 'self'");
        return {};
      },
      undefined,
      c,
      'styled',
      vi.fn(async (_pageObj: RenderPage, assetTags) => `<html>${assetTags.css}</html>`),
      async () => ({
        css: '',
        preloads: '',
        body: '',
        devCss: [{ url: '/pages/styled.css', css: '.x{color:red}' }],
      }),
    );

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'nonce-");
  });

  it('adds the generated dev CSS nonce when CSP already has another nonce', async () => {
    const c = await createTestContext('GET', '/styled');
    const response = await handlePageGet(
      (ctx: Context) => {
        ctx.header('Content-Security-Policy', "style-src 'self' 'nonce-existing'");
        return {};
      },
      undefined,
      c,
      'styled',
      vi.fn(async (_pageObj: RenderPage, assetTags) => `<html>${assetTags.css}</html>`),
      async () => ({
        css: '',
        preloads: '',
        body: '',
        devCss: [{ url: '/pages/styled.css', css: '.x{color:red}' }],
      }),
    );

    const html = await response.text();
    const nonce = html.match(/nonce="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("'nonce-existing'");
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it('attaches prepared asset tags to render errors for styled 500 pages', async () => {
    const c = await createTestContext('GET', '/styled');
    const error = new Error('render failed');

    await expect(
      handlePageGet(
        undefined,
        undefined,
        c,
        'styled',
        vi.fn(async () => {
          throw error;
        }),
        async () => ({
          css: '',
          preloads: '',
          body: '',
          devCss: [{ url: '/pages/styled.css', id: '/root/pages/styled.css', css: '.x{}' }],
        }),
      ),
    ).rejects.toThrow(error);

    expect(
      (error as Error & { __voidPageAssetTags?: { css: string } }).__voidPageAssetTags?.css,
    ).toContain('data-vite-dev-id="/root/pages/styled.css"');
  });

  it('includes shared data from context', async () => {
    const c = await createTestContext('GET', '/', {
      headers: { 'x-voidpages': 'true' },
      shared: { auth: { user: { name: 'Test' } } },
    });

    const response = await handlePageGet(
      undefined,
      undefined,
      c,
      'index',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.shared).toEqual({ auth: { user: { name: 'Test' } } });
  });

  it('prefetch request — resolves deferred props inline as plain JSON', async () => {
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true', purpose: 'prefetch' },
    });

    const handler = vi.fn(() => ({
      stats: { count: 42 },
      usage: defer(async () => ({ requests: 1200 })),
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'dashboard',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('content-type')).not.toContain('ndjson');
    expect(response.headers.get('X-VoidPages')).toBe('true');

    const body = await json<PageResponse & { props: { usage: { requests: number } } }>(response);
    expect(body.props.usage).toEqual({ requests: 1200 });
    expect(body.deferred).toBeUndefined();
    // deferredKeys is preserved so clients can wrap resolved values
    expect(body.deferredKeys).toEqual({ usage: 'usage' });
  });

  it.each([
    { dev: false, message: 'Internal Server Error' },
    { dev: true, message: 'db down' },
  ])(
    'prefetch request — sends a failed deferred group as an inline error (dev=$dev)',
    async ({ dev, message }) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const c = await createTestContext('GET', '/dashboard', {
        headers: { 'x-voidpages': 'true', purpose: 'prefetch' },
      });
      const error = new Error('db down');

      try {
        const response = await handlePageGet(
          () => ({
            stats: { count: 1 },
            usage: defer(async () => {
              throw error;
            }),
            ok: defer(async () => 1),
          }),
          undefined,
          c,
          'dashboard',
          mockRenderFn,
          mockGetAssetTags,
          undefined,
          { dev },
        );

        const body = await json<PageResponse & { deferredErrors?: Record<string, string> }>(
          response,
        );
        expect(body.deferredErrors).toEqual({ usage: message });
        expect(body.props).toEqual({ stats: { count: 1 }, ok: 1 });
        expect(body.deferredKeys).toEqual({ usage: 'usage', ok: 'ok' });
        expect(consoleError).toHaveBeenCalledExactlyOnceWith(error);
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it('prefetch request — resolves empty deferred results like the stream does', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true', purpose: 'prefetch' },
    });

    try {
      const response = await handlePageGet(
        () => ({
          post: defer(async () => undefined),
          a: defer('g', async () => null),
          b: defer('g', async () => null),
        }),
        undefined,
        c,
        'dashboard',
        mockRenderFn,
        mockGetAssetTags,
      );

      const body = await json<PageResponse & { deferredErrors?: Record<string, string> }>(response);
      expect(body.props).toEqual({ post: null });
      expect(body.deferredErrors).toBeUndefined();
      expect(body.deferredKeys).toEqual({ post: 'post', a: 'g', b: 'g' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('handlePageMutation', () => {
  it.each<Record<string, string>>([
    { origin: 'https://attacker.test' },
    { origin: 'http://sibling.localhost', 'sec-fetch-site': 'same-site' },
    { origin: 'null' },
    { origin: 'http://localhost:3000' },
    { origin: 'https://localhost' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { referer: 'https://attacker.test/form' },
  ])('rejects cross-origin page actions before invoking application code: %j', async (headers) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const c = await createTestContext(method, '/settings', {
        headers: { ...headers, cookie: 'session=victim' },
      });
      const action = vi.fn(() => new Response(null, { status: 204 }));
      const loader = vi.fn(() => ({}));
      const render = vi.fn(async () => '');
      const assets = vi.fn(async () => ({ css: '', preloads: '', body: '' }));
      const response = await handlePageMutation(
        action,
        loader,
        undefined,
        c,
        'settings',
        render,
        assets,
      );
      expect(response.status).toBe(403);
      expect(action).not.toHaveBeenCalled();
      expect(loader).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(assets).not.toHaveBeenCalled();
    }
  });

  it.each<Record<string, string>>([
    { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'same-origin' },
    { referer: 'http://localhost/form' },
    {},
  ])(
    'allows same-origin browser actions and requests without browser metadata: %j',
    async (headers) => {
      const c = await createTestContext('POST', '/settings', {
        headers: headers,
      });
      const action = vi.fn(() => Response.redirect('http://localhost/settings', 303));
      const response = await handlePageMutation(
        action,
        undefined,
        undefined,
        c,
        'settings',
        mockRenderFn,
        mockGetAssetTags,
      );
      expect(response.status).toBe(303);
      expect(action).toHaveBeenCalledOnce();
    },
  );

  it('void return — re-runs GET, returns fresh props', async () => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const mutationHandler = vi.fn(() => undefined);
    const getHandler = vi.fn(() => ({ users: ['new'] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.props).toEqual({ users: ['new'] });
    expect(body.errors).toBeNull();
  });

  it('includes the request query string in mutation page object URLs', async () => {
    const c = await createTestContext('POST', '/users?page=2', {
      headers: { 'x-voidpages': 'true' },
    });

    const response = await handlePageMutation(
      () => undefined,
      () => ({ users: [] }),
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.url).toBe('/users?page=2');
  });

  it('Response redirect — passes through', async () => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: '/users/1' },
    });
    const mutationHandler = vi.fn(() => redirect);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/users/1');
  });

  it('ValidationError thrown — re-runs GET with errors', async () => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ name: 'required' });
    });
    const getHandler = vi.fn(() => ({ users: [] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.errors).toEqual({ name: 'required' });
    expect(body.props).toEqual({ users: [] });
  });

  it('ValidationError HTML responses include collected dev CSS', async () => {
    const c = await createTestContext('POST', '/users');
    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ name: 'required' });
    });
    const getHandler = vi.fn(() => ({ users: [] }));
    const renderFn = vi.fn(
      async (_pageObj: RenderPage, assetTags) => `<html><head>${assetTags.css}</head></html>`,
    );

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'users',
      renderFn,
      async () => ({
        css: '',
        preloads: '',
        body: '',
        devCss: [{ url: '/pages/users.css', css: '.error{color:red}' }],
      }),
    );

    const html = await response.text();
    expect(html).toContain('data-vite-dev-id="/pages/users.css"');
    expect(html).toContain('.error{color:red}');
  });

  it('Response 400 (withValidator) — extracts errors, re-runs GET', async () => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const validationResponse = Response.json(
      {
        issues: [
          {
            slot: 'body',
            issues: [{ message: 'required', path: 'name' }],
          },
        ],
      },
      { status: 400 },
    );
    const mutationHandler = vi.fn(() => validationResponse);
    const getHandler = vi.fn(() => ({ users: [] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.errors).toEqual({ name: 'required' });
  });

  it.each([
    {
      name: 'JSON without withValidator issues',
      response: () => Response.json({ error: 'Slug taken' }, { status: 400 }),
      body: '{"error":"Slug taken"}',
    },
    {
      name: 'text',
      response: () => new Response('Missing title', { status: 400 }),
      body: 'Missing title',
    },
  ])('Response 400 with $name passes through unchanged', async ({ response, body }) => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });
    const getHandler = vi.fn(() => ({ users: [] }));

    const result = await handlePageMutation(
      () => response(),
      getHandler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(result.status).toBe(400);
    expect(await result.text()).toBe(body);
    expect(getHandler).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    headers: Record<string, string>;
    action: () => undefined;
    loader: (c: Context) => Response | Promise<Response>;
    status: number;
  }>([
    {
      name: 'void action passes through a loader redirect',
      headers: { 'x-voidpages': 'true' },
      action: () => undefined,
      loader: (c: Context) => c.redirect('/posts'),
      status: 302,
    },
    {
      name: 'void action passes through a loader 404',
      headers: {},
      action: () => undefined,
      loader: (c: Context) => c.notFound(),
      status: 404,
    },
    {
      name: 'ValidationError passes through a loader redirect',
      headers: { 'x-voidpages': 'true' },
      action: () => {
        throw new ValidationError({ title: 'required' });
      },
      loader: (c: Context) => c.redirect('/posts'),
      status: 302,
    },
  ])('$name', async ({ headers, action, loader, status }) => {
    const c = await createTestContext('POST', '/posts/1', { headers });
    const render = vi.fn(async () => '<html></html>');

    const response = await handlePageMutation(
      action,
      loader,
      undefined,
      c,
      'post',
      render,
      mockGetAssetTags,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get('Location')).toBe(status === 302 ? '/posts' : null);
    expect(render).not.toHaveBeenCalled();
  });

  it('Response 204 (void from withValidator) — re-runs GET', async () => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const voidResponse = new Response(null, { status: 204 });
    const mutationHandler = vi.fn(() => voidResponse);
    const getHandler = vi.fn(() => ({ users: ['created'] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'users',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(body.props).toEqual({ users: ['created'] });
    expect(body.errors).toBeNull();
  });

  it('post-mutation HTML rerenders include collected dev CSS', async () => {
    const c = await createTestContext('POST', '/users');
    const renderFn = vi.fn(
      async (_pageObj: RenderPage, assetTags) => `<html><head>${assetTags.css}</head></html>`,
    );

    const response = await handlePageMutation(
      () => undefined,
      () => ({ users: ['created'] }),
      undefined,
      c,
      'users',
      renderFn,
      async () => ({
        css: '',
        preloads: '',
        body: '',
        devCss: [{ url: '/pages/users.css', css: '.created{color:green}' }],
      }),
    );

    const html = await response.text();
    expect(html).toContain('data-vite-dev-id="/pages/users.css"');
    expect(html).toContain('.created{color:green}');
  });

  it('re-throws non-ValidationError errors', async () => {
    const c = await createTestContext('POST', '/users', {
      headers: { 'x-voidpages': 'true' },
    });

    const mutationHandler = vi.fn(() => {
      throw new Error('boom');
    });

    await expect(
      handlePageMutation(
        mutationHandler,
        undefined,
        undefined,
        c,
        'users',
        mockRenderFn,
        mockGetAssetTags,
      ),
    ).rejects.toThrow('boom');
  });

  it('island mutation — ValidationError returns JSON 422', async () => {
    const c = await createTestContext('POST', '/contact');

    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ email: 'required' });
    });

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      'contact',
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'island' },
    );

    expect(response.status).toBe(422);
    const body = await json<{ errors: Record<string, string> }>(response);
    expect(body.errors).toEqual({ email: 'required' });
  });

  it('island mutation — withValidator 400 returns JSON 422', async () => {
    const c = await createTestContext('POST', '/contact');

    const validationResponse = Response.json(
      {
        issues: [
          {
            slot: 'body',
            issues: [{ message: 'required', path: 'email' }],
          },
        ],
      },
      { status: 400 },
    );
    const mutationHandler = vi.fn(() => validationResponse);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      'contact',
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'island' },
    );

    expect(response.status).toBe(422);
    const body = await json<{ errors: Record<string, string> }>(response);
    expect(body.errors).toEqual({ email: 'required' });
  });

  it('island mutation — success returns JSON 200', async () => {
    const c = await createTestContext('POST', '/contact');

    const mutationHandler = vi.fn(() => undefined);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      'contact',
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'island' },
    );

    expect(response.status).toBe(200);
    const body = await json<{ success: boolean }>(response);
    expect(body.success).toBe(true);
  });

  it('island mutation — redirect passes through', async () => {
    const c = await createTestContext('POST', '/contact');

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: '/dashboard' },
    });
    const mutationHandler = vi.fn(() => redirect);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      undefined,
      c,
      'contact',
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'island' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/dashboard');
  });
});

describe('handlePageGet with deferred props', () => {
  it('SPA — streams NDJSON with immediate props first, then deferred', async () => {
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true' },
    });

    const handler = vi.fn(() => ({
      projects: [1, 2],
      usage: defer(() => Promise.resolve({ requests: 100 })),
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'dashboard',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    const text = await response.text();
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(2);

    const pageObj = JSON.parse(lines[0]);
    expect(pageObj.props).toEqual({
      projects: [1, 2],
      usage: { value: null, loading: true, error: null },
    });
    expect(pageObj.deferred).toEqual(['usage']);
    expect(pageObj.deferredKeys).toEqual({ usage: 'usage' });

    const deferredLine = JSON.parse(lines[1]);
    expect(deferredLine.__deferred).toBe('usage');
    expect(deferredLine.data).toEqual({ requests: 100 });
  });

  it('SPA — streams null for a deferred resolver that returns undefined', async () => {
    const c = await createTestContext('GET', '/post', {
      headers: { 'x-voidpages': 'true' },
    });

    const response = await handlePageGet(
      () => ({ title: 'x', post: defer(() => Promise.resolve(undefined)) }),
      undefined,
      c,
      'post',
      mockRenderFn,
      mockGetAssetTags,
    );

    const lines = (await response.text()).trim().split('\n');
    expect(JSON.parse(lines[1])).toEqual({ __deferred: 'post', data: null });
  });

  it('SPA — dev streams the raw error for a failed deferred resolver', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true' },
    });

    const handler = vi.fn(() => ({
      projects: [],
      usage: defer(() => Promise.reject(new Error('timeout'))),
    }));

    try {
      const response = await handlePageGet(
        handler,
        undefined,
        c,
        'dashboard',
        mockRenderFn,
        mockGetAssetTags,
        undefined,
        { dev: true },
      );

      const text = await response.text();
      const lines = text.trim().split('\n');
      expect(lines.length).toBe(2);

      const deferredLine = JSON.parse(lines[1]);
      expect(deferredLine.__deferred).toBe('usage');
      expect(deferredLine.error).toBe('timeout');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('SPA — production streams a generic error and logs the original', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true' },
    });
    const error = new Error('db 10.0.0.5 refused');

    try {
      const response = await handlePageGet(
        () => ({ usage: defer(() => Promise.reject(error)) }),
        undefined,
        c,
        'dashboard',
        mockRenderFn,
        mockGetAssetTags,
      );

      const text = await response.text();
      expect(text).not.toContain('10.0.0.5');
      expect(JSON.parse(text.trim().split('\n')[1])).toEqual({
        __deferred: 'usage',
        error: 'Internal Server Error',
      });
      expect(consoleError).toHaveBeenCalledWith(error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('SSR — production rejects deferred props with a generic error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await createTestContext('GET', '/dashboard');
    const error = new Error('db 10.0.0.5 refused');

    try {
      const response = await handlePageGet(
        () => ({ usage: defer(() => Promise.reject(error)) }),
        undefined,
        c,
        'dashboard',
        mockRenderFn,
        mockGetAssetTags,
      );

      const text = await response.text();
      expect(text).not.toContain('10.0.0.5');
      expect(text).toContain('window.__rejectDeferred("usage",');
      expect(text).toContain('"Internal Server Error"');
      expect(consoleError).toHaveBeenCalledWith(error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('SPA — production keeps HTTPException messages for deferred props', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true' },
    });

    try {
      const response = await handlePageGet(
        () => ({
          usage: defer(() =>
            Promise.reject(new HTTPException(403, { message: 'Upgrade required' })),
          ),
        }),
        undefined,
        c,
        'dashboard',
        mockRenderFn,
        mockGetAssetTags,
      );

      const text = await response.text();
      expect(JSON.parse(text.trim().split('\n')[1])).toEqual({
        __deferred: 'usage',
        error: 'Upgrade required',
      });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('SSR — streams HTML then deferred script tags', async () => {
    const c = await createTestContext('GET', '/dashboard');

    const handler = vi.fn(() => ({
      projects: [1],
      usage: defer(() => Promise.resolve({ requests: 100 })),
    }));

    const renderFn = vi.fn(
      async (pageObj: RenderPage) =>
        `<script id="__VOID_PAGE_DATA__" type="application/json">${JSON.stringify(pageObj)}</script><div id="app"></div>`,
    );

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'dashboard',
      renderFn,
      mockGetAssetTags,
    );

    const text = await response.text();
    expect(text).toContain('__VOID_PAGE_DATA__');
    expect(text).toContain('"deferred":["usage"]');
    expect(text).toContain('window.__resolveDeferred("usage",');
    expect(text).toContain('"requests":100');
  });

  it('client-only page — returns an empty app shell with initial page data', async () => {
    const c = await createTestContext('GET', '/analytics');

    const handler = vi.fn(() => ({ title: 'Analytics' }));
    const renderFn = Object.assign(
      vi.fn(async () => '<html>server rendered</html>'),
      {
        preambleScript: '<script type="module">window.__reactPreamble = true</script>',
      },
    );
    const response = await handlePageGet(
      handler,
      () => ({ title: 'Analytics | App' }),
      c,
      'analytics',
      renderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'client' },
    );

    const html = await response.text();
    expect(renderFn).not.toHaveBeenCalled();
    expect(html).toContain('<title>Analytics | App</title>');
    expect(html).toContain('window.__reactPreamble = true');
    expect(html).toContain('<div id="app" data-void-ssr="false"></div>');
    expect(html).toContain('__VOID_PAGE_DATA__');
    expect(html).toContain('"component":"analytics"');
    expect(html).toContain('"title":"Analytics"');
    expect(html).not.toContain('server rendered');
  });

  it('client-only page — streams deferred script tags after the shell', async () => {
    const c = await createTestContext('GET', '/analytics');

    const response = await handlePageGet(
      () => ({
        title: 'Analytics',
        stats: defer(() => Promise.resolve({ visits: 12 })),
      }),
      undefined,
      c,
      'analytics',
      mockRenderFn,
      mockGetAssetTags,
      undefined,
      { renderMode: 'client' },
    );

    const html = await response.text();
    expect(html).toContain('<div id="app" data-void-ssr="false"></div>');
    expect(html).toContain('"deferred":["stats"]');
    expect(html).toContain('window.__resolveDeferred("stats",');
    expect(html).toContain('"visits":12');
  });

  it('deferred named group — resolves all keys together', async () => {
    const c = await createTestContext('GET', '/dashboard', {
      headers: { 'x-voidpages': 'true' },
    });

    const analyticsResolver = () =>
      Promise.resolve({ metrics: { count: 5 }, chart: { data: [1] } });

    const analytics = defer('analytics', analyticsResolver);
    const handler = vi.fn(() => ({
      projects: [1],
      metrics: analytics,
      chart: analytics,
    }));

    const response = await handlePageGet(
      handler,
      undefined,
      c,
      'dashboard',
      mockRenderFn,
      mockGetAssetTags,
    );

    const text = await response.text();
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(2);

    const pageObj = JSON.parse(lines[0]);
    expect(pageObj.deferred).toEqual(['analytics']);
    expect(pageObj.deferredKeys).toEqual({ metrics: 'analytics', chart: 'analytics' });

    const deferredLine = JSON.parse(lines[1]);
    expect(deferredLine.__deferred).toBe('analytics');
    expect(deferredLine.data).toHaveProperty('metrics');
    expect(deferredLine.data).toHaveProperty('chart');
  });
});

function passSchema(): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return { value };
      },
    },
  };
}

function failSchema(message: string): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate() {
        return { issues: [{ message }] };
      },
    },
  };
}

describe('defineHandler middleware composition (pages)', () => {
  const passThrough = defineMiddleware(async (_c, next) => {
    await next();
  });

  it('loader with pass-through middleware returns page props', async () => {
    const c = await createTestContext('GET', '/db', { headers: { 'x-voidpages': 'true' } });
    const loader = defineHandler(passThrough, async () => ({ notes: ['a'] }));

    const response = await handlePageGet(
      loader,
      undefined,
      c,
      'db',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(response.status).toBe(200);
    expect(body.props).toEqual({ notes: ['a'] });
  });

  it('loader middleware after-next can mutate the final page response', async () => {
    const addHeader = defineMiddleware(async (c, next) => {
      await next();
      c.res.headers.set('X-Loader-Mw', 'yes');
    });
    const c = await createTestContext('GET', '/db', { headers: { 'x-voidpages': 'true' } });
    const loader = defineHandler(addHeader, async () => ({ ok: true }));

    const response = await handlePageGet(
      loader,
      undefined,
      c,
      'db',
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.headers.get('X-Loader-Mw')).toBe('yes');
    expect((await json<PageResponse>(response)).props).toEqual({ ok: true });
  });

  it('action with middleware re-renders the page after a successful mutation', async () => {
    const c = await createTestContext('POST', '/db?create', {
      headers: {
        'x-voidpages': 'true',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'a' }),
    });

    const getHandler = defineHandler(async () => ({ notes: ['fresh'] }));
    const mutationHandler = defineHandler(
      passThrough,
      defineHandler.withValidator({
        body: passSchema(),
      })(async (_c, { body }) => {
        void body;
      }),
    );

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'db',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(response.status).toBe(200);
    expect(body.props).toEqual({ notes: ['fresh'] });
    expect(body.errors).toBeNull();
  });

  it('action with middleware maps validation failures to page field errors', async () => {
    const c = await createTestContext('POST', '/db?create', {
      headers: {
        'x-voidpages': 'true',
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: '' }),
    });

    const getHandler = defineHandler(async () => ({ notes: [] }));
    const mutationHandler = defineHandler(
      passThrough,
      defineHandler.withValidator({
        body: failSchema('title is required'),
      })(async (_c, { body }) => {
        void body;
      }),
    );

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      undefined,
      c,
      'db',
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = await json<PageResponse>(response);
    expect(response.status).toBe(200);
    expect(body.errors).toEqual({ body: 'title is required' });
    expect(body.props).toEqual({ notes: [] });
  });
});

describe('flattenValidationErrors', () => {
  it('flattens nested issues format into flat map', () => {
    const body = {
      issues: [
        {
          slot: 'body',
          issues: [
            { message: 'required', path: 'name' },
            { message: 'invalid', path: 'email' },
          ],
        },
      ],
    };

    expect(flattenValidationErrors(body)).toEqual({
      name: 'required',
      email: 'invalid',
    });
  });

  it('uses slot as key fallback when no path', () => {
    const body = {
      issues: [
        {
          slot: 'body',
          issues: [{ message: 'invalid body' }],
        },
      ],
    };

    expect(flattenValidationErrors(body)).toEqual({
      body: 'invalid body',
    });
  });

  it('returns empty object for null/undefined input', () => {
    expect(flattenValidationErrors(null)).toEqual({});
    expect(flattenValidationErrors(undefined)).toEqual({});
  });
});
