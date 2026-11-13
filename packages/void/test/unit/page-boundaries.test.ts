import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { createActionErrorFromResponse } from '../../src/pages/action-result.ts';
import { clientPageError } from '../../src/pages/boundary-client.ts';
import { createBoundaryManifest } from '../../src/pages/boundary-plans.ts';
import { generateComponentManifest } from '../../src/pages/manifest.ts';
import { scanPages } from '../../src/pages/scan.ts';
import { deserializePageData } from '../../src/pages/serialize.ts';
import { defineHandler } from '../../src/runtime/handler.ts';
import { createErrorRenderer } from '../../src/runtime/routing-errors.ts';
import { createPageGetHandler, createPagesFallback } from '../../src/runtime/routing-pages.ts';
import { createRoutingRuntime } from '../../src/runtime/routing.ts';

const roots: Array<string> = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'void-boundaries-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, 'pages', path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('client boundary errors', () => {
  it.each([
    [401, 'Unauthorized', 'Please sign in', 'Please sign in'],
    [403, 'Forbidden', 'Access denied', 'Access denied'],
    [
      503,
      'Service Unavailable',
      'SECRET_SERVER_DETAILS',
      'Action failed with 503 Service Unavailable',
    ],
  ] as const)(
    'preserves the public action error for HTTP %s',
    async (status, statusText, body, message) => {
      const error = await createActionErrorFromResponse(
        new Response(body, { status, statusText, headers: { 'Content-Type': 'text/plain' } }),
        '/settings',
      );
      expect(clientPageError(error)).toEqual({ status, message });
      expect(clientPageError({ ...error, message: error.message })).toEqual({ status, message });
    },
  );

  it('keeps unexpected production errors private', () => {
    const error = new Error('SECRET_COMPONENT_DETAILS');
    expect(clientPageError(error)).toEqual({ status: 500, message: 'Internal Server Error' });
    expect(clientPageError(error, true)).toEqual({ status: 500, message: error.message });
  });
});

describe('Pages boundary inventory', () => {
  it('collects boundaries without reserving ordinary routes or ignored directories', async () => {
    const root = fixture({
      'layout.tsx': 'export default () => null',
      'index.tsx': 'export default () => null',
      'error.tsx': 'export default () => null',
      'not-found.tsx': 'export default () => null',
      '_error.tsx': 'export default () => null',
      'items/_not-found.tsx': 'export default () => null',
      'items/[id].tsx': 'export default () => null',
      '_private/_error.tsx': 'export default () => null',
      '_layouts/_error.tsx': 'export default () => null',
    });
    const scan = await scanPages(root);
    expect(scan.pages.map((p) => p.pattern).sort()).toEqual([
      '/',
      '/error',
      '/items/:id',
      '/not-found',
    ]);
    expect(scan).toHaveProperty('boundaries', [
      { kind: 'error', directory: '', componentId: '_error', filePath: '_error.tsx' },
      {
        kind: 'not-found',
        directory: 'items',
        componentId: 'items/_not-found',
        filePath: 'items/_not-found.tsx',
      },
    ]);
    const manifest = generateComponentManifest(scan, join(root, 'pages'));
    expect(manifest).toContain('items/_not-found.tsx');
    expect(manifest).toContain('_error.tsx');
  });

  it('rejects unsupported companions and layout overrides with an actionable filename', async () => {
    for (const files of [
      {
        '_error.tsx': 'export default () => null',
        '_error.server.ts': 'export const loader = () => ({})',
      },
      { '_error.tsx': 'export const layout = false; export default () => null' },
      { '_error.island.tsx': 'export default () => null' },
    ] as Array<Record<string, string>>) {
      await expect(scanPages(fixture(files))).rejects.toThrow(/_error/);
    }
  });
  it('selects environment-specific boundaries and rejects competing definitions', async () => {
    const root = fixture({
      '_error.dev.tsx': 'export default () => null',
      '_error.prod.tsx': 'export default () => null',
    });
    for (const environment of ['dev', 'prod'] as const) {
      const scan = await scanPages(root, { environment });
      expect(scan.boundaries?.map((boundary) => boundary.filePath)).toEqual([
        `_error.${environment}.tsx`,
      ]);
    }
    writeFileSync(join(root, 'pages/_error.tsx'), 'export default () => null');
    await expect(scanPages(root)).rejects.toThrow('Ambiguous boundary');
  });
});

describe('boundary render plans', () => {
  it('keeps named replacements at their logical slot instead of their file directory', async () => {
    const root = fixture({
      'layout.tsx': 'export default () => null',
      'items/layout.tsx': 'export default () => null',
      '_layouts/alternate.tsx': 'export default () => null',
      '_error.tsx': 'export default () => null',
      'items/_error.tsx': 'export default () => null',
      'items/page.tsx': 'export const layout = "alternate"; export default () => null',
    });
    const inventory = createBoundaryManifest(await scanPages(root));
    const candidates = inventory.pages['items/page'];
    expect(candidates.errors.map((id) => inventory.plans[id].layouts)).toEqual([
      ['layout', '_layouts/alternate'],
      ['layout'],
    ]);
    expect(candidates.catches.map((c) => c.depth)).toEqual([2, 1]);
    expect(new Set(candidates.errors).size).toBe(2);
  });
  it.each([false, '!alternate'] as const)(
    'respects the effective layout chain with layout = %s',
    async (layout) => {
      const root = fixture({
        'layout.tsx': 'export default () => null',
        'items/layout.tsx': 'export default () => null',
        '_layouts/alternate.tsx': 'export default () => null',
        '_error.tsx': 'export default () => null',
        'items/_error.tsx': 'export default () => null',
        'items/page.tsx': `export const layout = ${JSON.stringify(layout)}; export default () => null`,
      });
      const manifest = createBoundaryManifest(await scanPages(root));
      const candidates = manifest.pages['items/page'];
      expect(candidates.errors.map((id) => manifest.plans[id].layouts)).toEqual(
        layout === false ? [[], []] : [['_layouts/alternate'], []],
      );
      expect(candidates.catches.map((entry) => entry.depth)).toEqual(
        layout === false ? [0, 0] : [1, 0],
      );
    },
  );
});

describe('Pages loader boundary protocol', () => {
  describe.each(['HTML', 'Pages JSON'] as const)(
    'HTTP exception recovery through page boundaries (%s)',
    (format) => {
      it.each([
        [401, 'Please sign in'],
        [403, 'Your account is banned'],
        [410, 'This item was deleted'],
        [429, 'Too many requests'],
        [503, 'Down for maintenance'],
      ] as const)('renders HTTP %s through the nearest error boundary', async (status, message) => {
        const app = new Hono();
        app.onError(createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError);
        let loaderCalls = 0;
        app.get(
          '/items/1',
          createPageGetHandler({
            componentId: 'items/item',
            load: async () => ({
              loader: defineHandler((c) => {
                loaderCalls++;
                c.header('Retry-After', '120');
                throw new HTTPException(status, { message });
              }),
            }),
            render: async (page) =>
              `<main data-component="${page.component}">${JSON.stringify(page.props)}</main>`,
            assets: async () => ({ css: '', body: '', preloads: '' }),
            headConfig: null,
            renderOptions: {
              boundaries: { notFound: 'not-found-plan', errors: ['items-error', 'root-error'] },
            },
          }),
        );
        const response = await app.request('https://app.test/items/1', {
          headers:
            format === 'Pages JSON'
              ? { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }
              : { Accept: 'text/html' },
        });
        const body = await response.text();
        expect(loaderCalls).toBe(1);
        expect(response.status).toBe(status);
        if (format === 'Pages JSON') {
          expect(response.headers.get('X-VoidPages')).toBe('true');
          expect(deserializePageData(body)).toMatchObject({
            component: 'items-error',
            props: { error: { status, message } },
            url: '/items/1',
          });
        } else {
          expect(response.headers.get('Content-Type')).toContain('text/html');
          expect(body).toContain('data-component="items-error"');
          expect(body).toContain(JSON.stringify({ error: { status, message } }));
        }
        expect(response.headers.get('Retry-After')).toBe('120');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      });

      it.each([302, 503] as const)(
        'passes through HTTP %s with an explicit response',
        async (status) => {
          const app = new Hono();
          app.onError(createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError);
          app.get(
            '/',
            createPageGetHandler({
              componentId: 'index',
              load: async () => ({
                loader: () => {
                  throw new HTTPException(status, {
                    res: new Response('Explicit response', {
                      status,
                      headers: status === 302 ? { Location: '/login' } : { 'Retry-After': '120' },
                    }),
                  });
                },
              }),
              render: async () => '<main>Error boundary</main>',
              assets: async () => ({ css: '', body: '', preloads: '' }),
              headConfig: null,
              renderOptions: { boundaries: { errors: ['root-error'] } },
            }),
          );
          const response = await app.request('https://app.test/', {
            headers:
              format === 'Pages JSON'
                ? { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }
                : { Accept: 'text/html' },
          });
          expect(response.status).toBe(status);
          expect(response.headers.has('X-VoidPages')).toBe(false);
          expect(response.headers.get(status === 302 ? 'Location' : 'Retry-After')).toBe(
            status === 302 ? '/login' : '120',
          );
          expect(await response.text()).toBe('Explicit response');
        },
      );
    },
  );

  it.each(['returned', 'thrown', 'empty-message', 'unexpected'])(
    'renders %s failures as marked, uncached Pages data',
    async (kind) => {
      const app = new Hono<{ Variables: { shared: Record<string, unknown> } }>();
      app.use('*', async (c, next) => {
        c.set('shared', { viewer: 'alice' });
        c.header('X-Security', 'retained');
        c.header('Cache-Control', 'public, max-age=3600');
        c.header('Vary', 'Accept-Language');
        await next();
      });
      app.get(
        '/items/1',
        createPageGetHandler({
          componentId: 'items/item',
          load: async () => ({
            loader: defineHandler((c) => {
              if (kind === 'thrown' || kind === 'empty-message') {
                throw new HTTPException(
                  404,
                  kind === 'thrown' ? { message: 'Deleted item' } : undefined,
                );
              }
              if (kind === 'unexpected') {
                throw new Error('SECRET_DATABASE_PASSWORD');
              }
              return c.text('Deleted item', 404, {
                'Set-Cookie': 'renewed=yes; HttpOnly',
                ETag: 'stale',
              });
            }),
          }),
          render: async (page) => '<main>' + page.component + '</main>',
          assets: async () => ({ css: '', body: '', preloads: '' }),
          headConfig: null,
          renderOptions: { boundaries: { notFound: 'not-found-plan', errors: ['error-plan'] } },
        }),
      );
      const response = await app.request('https://app.test/items/1', {
        headers: { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION },
      });
      expect(response.status).toBe(kind === 'unexpected' ? 500 : 404);
      expect(response.headers.get('X-VoidPages')).toBe('true');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Vary')).toContain('Accept-Language');
      expect(response.headers.get('Vary')).toContain('X-VoidPages-Version');
      expect(response.headers.get('X-Security')).toBe('retained');
      expect(response.headers.has('ETag')).toBe(false);
      if (kind === 'returned') {
        expect(response.headers.get('Set-Cookie')).toContain('renewed=yes');
      }
      const text = await response.text();
      expect(text).not.toContain('SECRET_DATABASE_PASSWORD');
      const data = deserializePageData(text);
      expect(data).toMatchObject({
        component: kind === 'unexpected' ? 'error-plan' : 'not-found-plan',
        props: {
          error: {
            status: kind === 'unexpected' ? 500 : 404,
            message:
              kind === 'thrown'
                ? 'Deleted item'
                : kind === 'unexpected'
                  ? 'Internal Server Error'
                  : 'Not Found',
          },
        },
        shared: { viewer: 'alice' },
        url: '/items/1',
      });
    },
  );
  it('keeps both middleware and thrown not-found response cookies', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.header('Set-Cookie', 'middleware=yes; HttpOnly');
      c.header('Cache-Control', 'public, max-age=3600');
      c.header('Vary', 'Accept-Language');
      await next();
    });
    app.get(
      '/',
      createPageGetHandler({
        componentId: 'index',
        load: async () => ({
          loader: () => {
            throw new HTTPException(404, {
              res: new Response('Missing', {
                status: 404,
                headers: { 'Set-Cookie': 'loader=yes; HttpOnly' },
              }),
            });
          },
        }),
        render: async () => '<main>Missing</main>',
        assets: async () => ({ css: '', body: '', preloads: '' }),
        headConfig: null,
        renderOptions: { boundaries: { notFound: 'missing', errors: [] } },
      }),
    );
    const response = await app.request('https://app.test/');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vary')).toContain('Accept-Language');
    expect(response.headers.get('Vary')).toContain('X-VoidPages-Version');
    expect(response.headers.getSetCookie().sort()).toEqual([
      'loader=yes; HttpOnly',
      'middleware=yes; HttpOnly',
    ]);
  });
});

describe('loader not-found dispatch', () => {
  it('preserves a custom app not-found redirect', async () => {
    const app = new Hono();
    app.notFound((c) => c.redirect('/login'));
    app.get(
      '/',
      createPageGetHandler({
        componentId: 'index',
        load: async () => ({ loader: (c) => c.notFound() }),
        render: async () => '<main>Missing page</main>',
        assets: async () => ({ css: '', body: '', preloads: '' }),
        headConfig: null,
        renderOptions: { boundaries: { notFound: 'missing', errors: [] } },
      }),
    );
    const response = await app.request('https://app.test/');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login');
  });

  it.each([
    { pages: false, boundary: true },
    { pages: true, boundary: true },
    { pages: false, boundary: false },
  ])(
    'renders a loader not-found once (Pages: $pages, boundary: $boundary)',
    async ({ pages, boundary }) => {
      let rootCalls = 0;
      let loaderCalls = 0;
      const rendered: Array<string> = [];
      const app = new Hono();
      app.notFound(
        createPagesFallback({
          routing: createRoutingRuntime(app, { nodeTarget: true }),
          errors: createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }),
          pageNotFound: createPageGetHandler({
            componentId: 'root',
            load: async () => ({ loader: () => new Response(null, { status: 404 }) }),
            render: async () => {
              rootCalls++;
              return '<main>Root not found</main>';
            },
            assets: async () => ({ css: '', body: '', preloads: '' }),
            headConfig: null,
            renderOptions: { boundaries: { notFound: 'root/not-found', errors: [] } },
          }),
        }),
      );
      app.get(
        '/items/:id',
        createPageGetHandler({
          componentId: 'items/item',
          load: async () => ({
            loader: defineHandler(
              async (c, next) => {
                const notFound = c.notFound;
                await next();
                expect(c.notFound).toBe(notFound);
              },
              async (c) => {
                loaderCalls++;
                await Promise.resolve();
                return c.notFound();
              },
            ),
          }),
          render: async (page) => {
            rendered.push(page.component);
            return '<main>' + page.component + '</main>';
          },
          assets: async () => ({ css: '', body: '', preloads: '' }),
          headConfig: null,
          renderOptions: boundary
            ? { boundaries: { notFound: 'items/not-found', errors: [] } }
            : undefined,
        }),
      );
      const response = await app.request('https://app.test/items/1', {
        headers: pages
          ? { 'X-VoidPages': 'true', 'X-VoidPages-Version': PAGES_PROTOCOL_VERSION }
          : {},
      });
      expect(response.status).toBe(404);
      expect(rootCalls).toBe(boundary ? 0 : 1);
      expect(loaderCalls).toBe(1);
      expect(rendered).toEqual(pages || !boundary ? [] : ['items/not-found']);
      const body = await response.text();
      if (pages) {
        expect(deserializePageData(body)).toMatchObject({ component: 'items/not-found' });
      } else {
        expect(body).toBe(
          boundary ? '<main>items/not-found</main>' : '<main>Root not found</main>',
        );
      }
    },
  );
});

describe('boundary recovery failures', () => {
  it.each(['malformed JSON', 'body rejection', 'exhausted fallback'])(
    'handles %s without replaying the loader',
    async (kind) => {
      let calls = 0;
      const app = new Hono();
      app.get(
        '/',
        createPageGetHandler({
          componentId: 'index',
          load: async () => ({
            loader: () => {
              calls++;
              return kind === 'exhausted fallback'
                ? new Response(null, { status: 404 })
                : new Response(
                    kind === 'malformed JSON'
                      ? '{broken'
                      : new ReadableStream({
                          start(controller) {
                            controller.error(new Error('SECRET_BODY'));
                          },
                        }),
                    { headers: { 'Content-Type': 'application/json' } },
                  );
            },
          }),
          render: async (page) => {
            if (kind === 'exhausted fallback') {
              throw new Error('SECRET_FALLBACK');
            }
            return '<h1>' + (page.props.error as { message: string }).message + '</h1>';
          },
          assets: async () => ({ css: '', body: '', preloads: '' }),
          headConfig: null,
          renderOptions: { boundaries: { notFound: 'missing', errors: ['error'] } },
        }),
      );
      const response = await app.request('http://localhost/');
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('SECRET_');
      expect(calls).toBe(1);
    },
  );
  it('never escalates a root not-found inward to a nested error boundary', async () => {
    const root = fixture({
      'index.tsx': 'export default()=>null',
      '_not-found.tsx': 'export default()=>null',
      '_error.tsx': 'export default()=>null',
      'items/_error.tsx': 'export default()=>null',
      'items/[id].tsx': 'export default()=>null',
    });
    const manifest = createBoundaryManifest(await scanPages(root));
    expect(
      manifest.pages['items/[id]'].notFoundErrors!.map((id) => manifest.plans[id].directory),
    ).toEqual(['']);
  });
});
