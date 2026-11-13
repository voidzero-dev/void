import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { matchedRoutes } from 'hono/route';
import { describe, expect, it, vi } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { deserializePageData } from '../../src/pages/serialize.ts';
import { defineHandler, defineMiddleware } from '../../src/runtime/handler.ts';
import { createErrorRenderer } from '../../src/runtime/routing-errors.ts';
import {
  createPageErrorHandler,
  createPageGetHandler,
  createPageMutationHandler,
  type PageRouteOptions,
} from '../../src/runtime/routing-pages.ts';
import { createHttpRouteHandler } from '../../src/runtime/routing.ts';

const pagesHeaders = { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION };
const origins = ['loader', 'handler middleware', 'application middleware'] as const;
type Origin = (typeof origins)[number];

function fixture({
  origin = 'loader',
  fail = () => {
    throw new HTTPException(403, { message: 'Access denied' });
  },
  render = async (page) => `<main>${page.component}:${JSON.stringify(page.props)}</main>`,
  boundaries = { notFound: 'nested-not-found', errors: ['nested-error', 'root-error'] },
  middlewareBoundaries = { notFound: 'root-not-found', errors: ['root-error'] },
}: {
  origin?: Origin;
  fail?: (c: Context) => unknown;
  render?: PageRouteOptions['render'];
  boundaries?: NonNullable<PageRouteOptions['renderOptions']>['boundaries'];
  middlewareBoundaries?: PageRouteOptions['middlewareBoundaries'];
} = {}) {
  const app = new Hono<{ Variables: { shared: Record<string, unknown> } }>();
  const fallback = createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError;
  app.onError(createPageErrorHandler(matchedRoutes, fallback));
  const loader = vi.fn(() => ({ ok: true }));
  const moduleLoad = vi.fn();
  const failure = vi.fn(fail);
  app.use(async (c, next) => {
    c.set('shared', { viewer: 'alice' });
    c.header('X-Security', 'retained');
    c.header('Set-Cookie', 'session=retained; Path=/');
    c.header('Retry-After', '120');
    c.header('Cache-Control', 'public, max-age=3600');
    if (origin === 'application middleware') {
      return failure(c) as Response;
    }
    await next();
  });
  const options: PageRouteOptions = {
    componentId: 'items/item',
    load: async () => {
      moduleLoad();
      return {
        loader:
          origin === 'loader'
            ? defineHandler((c) => {
                loader();
                return failure(c);
              })
            : defineHandler(
                defineMiddleware(async (c) => failure(c) as Response),
                loader,
              ),
        action: (c) => failure(c),
      };
    },
    render,
    assets: async () => ({ css: '', body: '', preloads: '' }),
    headConfig: null,
    renderOptions: { boundaries },
    middlewareBoundaries,
  };
  app.get('/items/:id', createPageGetHandler(options));
  app.post('/items/:id', createPageMutationHandler(options));
  // A broad page must not make an API endpoint eligible for recovery.
  app.get(
    '/api/profile',
    createHttpRouteHandler(async () => ({ GET: (c) => failure(c) }), 'GET'),
  );
  app.get('/api/*', createPageGetHandler(options));
  return { app, loader, moduleLoad, failure };
}

describe.each(origins)('Pages HTTP errors from %s', (origin) => {
  it.each([false, true])('renders the appropriate boundary (Pages request: %s)', async (pages) => {
    const { app, loader, moduleLoad, failure } = fixture({ origin });
    const response = await app.request('/items/123?tab=details', {
      headers: pages ? pagesHeaders : {},
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Security')).toBe('retained');
    expect(response.headers.get('Retry-After')).toBe('120');
    expect(response.headers.getSetCookie()).toEqual(['session=retained; Path=/']);
    const component = origin === 'application middleware' ? 'root-error' : 'nested-error';
    if (pages) {
      expect(response.headers.get('X-VoidPages')).toBe('true');
      expect(deserializePageData(await response.text())).toMatchObject({
        component,
        props: { error: { status: 403, message: 'Access denied' } },
        params: { id: '123' },
        shared: { viewer: 'alice' },
        url: '/items/123?tab=details',
      });
    } else {
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(await response.text()).toContain(component);
    }
    expect(failure).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(origin === 'loader' ? 1 : 0);
    expect(moduleLoad).toHaveBeenCalledTimes(origin === 'application middleware' ? 0 : 1);
  });

  it.each([302, 503] as const)('preserves an explicit HTTP %s response', async (status) => {
    const { app } = fixture({
      origin,
      fail: () => {
        throw new HTTPException(status, {
          res: new Response('Explicit response', {
            status,
            headers: {
              Location: '/login',
              'Content-Disposition': 'attachment; filename=error.txt',
            },
          }),
        });
      },
    });
    const response = await app.request('/items/123', { headers: pagesHeaders });
    expect(response.status).toBe(status);
    expect(response.headers.has('X-VoidPages')).toBe(false);
    expect(response.headers.get('Location')).toBe('/login');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(await response.text()).toBe('Explicit response');
  });

  it('does not reinterpret a returned response', async () => {
    const { app } = fixture({ origin, fail: (c) => c.text('Explicit response', 503) });
    const response = await app.request('/items/123', { headers: pagesHeaders });
    expect(response.status).toBe(503);
    expect(response.headers.has('X-VoidPages')).toBe(false);
    expect(await response.text()).toBe('Explicit response');
  });

  it('keeps action failures outside GET recovery', async () => {
    const { app } = fixture({ origin });
    const response = await app.request('/items/123', { method: 'POST', headers: pagesHeaders });
    expect(response.status).toBe(403);
    expect(response.headers.has('X-VoidPages')).toBe(false);
    expect(await response.text()).toBe('Access denied');
  });

  it('keeps API exceptions outside Pages recovery', async () => {
    const { app } = fixture({ origin });
    const response = await app.request('/api/profile', { headers: pagesHeaders });
    expect(response.status).toBe(403);
    expect(response.headers.has('X-VoidPages')).toBe(false);
    expect(await response.text()).toBe('Access denied');
  });

  it('returns a bodyless HEAD response with the recovered status', async () => {
    const { app } = fixture({ origin });
    const response = await app.request('/items/123', { method: 'HEAD' });
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toBe('');
  });

  it('keeps unsupported Pages clients on the document fallback', async () => {
    const { app } = fixture({ origin });
    const response = await app.request('/items/123', { headers: { 'X-VoidPages': 'true' } });
    expect(response.status).toBe(200);
    expect(response.headers.has('X-VoidPages')).toBe(false);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });
});

describe('Pages HTTP error recovery compatibility', () => {
  it('recovers HTTP exceptions from a separate Hono constructor', async () => {
    class OtherHTTPException extends Error {
      readonly status = 403;
      getResponse() {
        return new Response(this.message, { status: this.status });
      }
    }
    const error = new OtherHTTPException('Access denied');
    expect(error).not.toBeInstanceOf(HTTPException);
    const { app } = fixture({
      fail: () => {
        throw error;
      },
    });
    const response = await app.request('/items/123', { headers: pagesHeaders });
    expect(response.status).toBe(403);
    expect(deserializePageData(await response.text())).toMatchObject({
      component: 'nested-error',
      props: { error: { status: 403, message: 'Access denied' } },
    });
  });

  it('does not render a nested boundary for application middleware without a root boundary', async () => {
    const render = vi.fn<PageRouteOptions['render']>();
    const { app } = fixture({
      origin: 'application middleware',
      middlewareBoundaries: { errors: [] },
      render,
    });
    const response = await app.request('/items/123', { headers: pagesHeaders });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Access denied');
    expect(render).not.toHaveBeenCalled();
  });

  it('does not rerender a completed page after middleware next()', async () => {
    const app = new Hono();
    app.onError(
      createPageErrorHandler(
        matchedRoutes,
        createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError,
      ),
    );
    app.use(async (_c, next) => {
      await next();
      throw new HTTPException(403, { message: 'After next' });
    });
    const render = vi.fn(async () => '<main>Healthy page</main>');
    app.get(
      '/',
      createPageGetHandler({
        componentId: 'index',
        render,
        assets: async () => ({ css: '', body: '', preloads: '' }),
        headConfig: null,
        renderOptions: { boundaries: { errors: ['nested-error'] } },
        middlewareBoundaries: { errors: ['root-error'] },
      }),
    );
    const response = await app.request('/');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('After next');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('recovers response-less HTTP exceptions without configuration', async () => {
    const app = new Hono();
    app.onError(createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError);
    app.get(
      '/',
      createPageGetHandler({
        componentId: 'index',
        load: async () => ({
          loader: () => {
            throw new HTTPException(401, { message: 'Unauthorized' });
          },
        }),
        render: async () => '<main>Error boundary</main>',
        assets: async () => ({ css: '', body: '', preloads: '' }),
        headConfig: null,
        renderOptions: { boundaries: { errors: ['root-error'] } },
      }),
    );
    const response = await app.request('/', { headers: pagesHeaders });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-VoidPages')).toBe('true');
    expect(deserializePageData(await response.text())).toMatchObject({
      component: 'root-error',
      props: { error: { status: 401, message: 'Unauthorized' } },
    });
  });

  it('uses the root not-found boundary for an application-middleware 404', async () => {
    const { app } = fixture({
      origin: 'application middleware',
      fail: () => {
        throw new HTTPException(404);
      },
    });
    const response = await app.request('/items/123', { headers: pagesHeaders });
    expect(response.status).toBe(404);
    expect(deserializePageData(await response.text())).toMatchObject({
      component: 'root-not-found',
    });
  });

  it('passes through exceptions when no error boundary exists', async () => {
    const { app } = fixture({ boundaries: { errors: [] } });
    const response = await app.request('/items/123', { headers: pagesHeaders });
    expect(response.status).toBe(403);
    expect(response.headers.has('X-VoidPages')).toBe(false);
    expect(await response.text()).toBe('Access denied');
  });

  it('escalates a failed boundary to an uncached generic 500 without replaying the loader', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const render = vi.fn<PageRouteOptions['render']>(async (page) => {
        if (page.component === 'nested-error') {
          throw new Error('SECRET');
        }
        return `<main>${JSON.stringify(page.props)}</main>`;
      });
      const { app, failure } = fixture({ render });
      const response = await app.request('/items/123');
      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toContain('Internal Server Error');
      expect(render).toHaveBeenCalledTimes(2);
      expect(failure).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it('does not retry a failed application-middleware boundary', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const render = vi.fn<PageRouteOptions['render']>(async () => {
        throw new Error('SECRET');
      });
      const { app, moduleLoad, failure } = fixture({ origin: 'application middleware', render });
      const response = await app.request('/items/123');
      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).not.toContain('SECRET');
      expect(render).toHaveBeenCalledTimes(1);
      expect(moduleLoad).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
