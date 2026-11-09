import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { createBoundaryManifest } from '../../src/pages/boundary-plans.ts';
import { generateComponentManifest } from '../../src/pages/manifest.ts';
import { scanPages } from '../../src/pages/scan.ts';
import { deserializePageData } from '../../src/pages/serialize.ts';
import { defineHandler } from '../../src/runtime/handler.ts';
import { createPageGetHandler } from '../../src/runtime/routing-pages.ts';

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
  it.each(['returned', 'thrown', 'unexpected'])(
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
              if (kind === 'thrown') {
                throw new HTTPException(404, { message: 'Deleted item' });
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
