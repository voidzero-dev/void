import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { renderPrerenderPaths } from '../../src/prerender-render.ts';
import { buildPrerenderPath } from '../../src/runtime/prerender-path.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;
let PROD_BASE: string;

describe('playground/node-app dev', () => {
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, 'playground/node-app');
    const server = await startServer((port) => {
      child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
  });

  it('serves API routes via Hono in Node.js', async () => {
    const response = await fetch(`${DEV_BASE}/api/hello`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ message: 'Hello from Node.js!' });
  });

  it('returns JSON content-type for API routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/hello`);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
  });

  it('serves pages with SSR HTML at root', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // React inserts <!-- --> comment nodes between text siblings
    expect(html).toContain('data-testid="title"');
    expect(html).toContain('Welcome');
    expect(html).toContain('<title>Home | Node App</title>');
  });

  it('serves the about page with SSR HTML', async () => {
    const response = await fetch(`${DEV_BASE}/about`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain('Void running on Node.js with React Pages');
    expect(html).toContain('<title>About | Node App</title>');
  });

  it('returns 404 for unregistered routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/nonexistent`);
    expect(response.status).toBe(404);
  });
});

describe('playground/node-app build + production', () => {
  let playground: IsolatedPlayground;
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, 'playground/node-app');
    const build = spawn.sync('vp', ['build'], {
      cwd: playground.root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    expect(build.status, `${build.stdout ?? ''}${build.stderr ?? ''}`).toBe(0);

    const server = await startServer((port) => {
      child = spawn('node', ['dist/ssr/index.js'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port) },
      });
      return child;
    }, 20_000);
    PROD_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
  });

  it('emits app.js, index.js, and client assets', () => {
    expect(existsSync(join(playground.root, 'dist/ssr/app.js'))).toBe(true);
    expect(existsSync(join(playground.root, 'dist/ssr/index.js'))).toBe(true);
    expect(existsSync(join(playground.root, 'dist/client'))).toBe(true);

    const index = readFileSync(join(playground.root, 'dist/ssr/index.js'), 'utf-8');
    expect(index).toContain('@hono/node-server');
  });

  it('production server serves API routes', async () => {
    const response = await fetch(`${PROD_BASE}/api/hello`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ message: 'Hello from Node.js!' });
  });

  it('production server serves pages with SSR HTML', async () => {
    const response = await fetch(`${PROD_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Welcome');
    expect(html).toContain('<title>Home | Node App</title>');
  });

  it.each(['plain', 'a b?c#d', 'a%b', '%20', 'café'])(
    'serves prerendered HTML and page data for parameter %j',
    async (slug) => {
      const path = buildPrerenderPath(
        '/assets/prerender/:slug',
        { slug },
        'pages/[slug].server.ts',
        0,
      );
      const data = { component: 'prerender', props: { slug }, url: path };
      const html = `<script id="__VOID_PAGE_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
      const result = await renderPrerenderPaths(
        [path],
        join(playground.root, 'dist/client'),
        async () => new Response(html),
        undefined,
        undefined,
        'node',
      );
      expect(result).toEqual({ rendered: [path], failed: [] });

      const document = await fetch(`${PROD_BASE}${path}.html`);
      expect(document.status).toBe(200);
      expect(await document.text()).toBe(html);

      const pageData = await fetch(`${PROD_BASE}/_void/pages${path}.json`);
      expect(pageData.status).toBe(200);
      expect(await pageData.json()).toEqual(data);
    },
  );

  it.each([
    '/assets/%252e%252e/%252e%252e/%252e%252e/package.json',
    '/assets/..%2F..%2F..%2Fpackage.json',
    '/assets/%5C..%5C..%5C..%5Cpackage.json',
  ])('does not serve files outside the client directory via %s', async (path) => {
    const response = await fetch(`${PROD_BASE}${path}`);
    expect(response.status).toBe(404);
    await response.text();
  });
});
