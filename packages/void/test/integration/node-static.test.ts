import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';
import { collectPrerenderPathsNode } from '../../src/prerender.ts';

declare global {
  interface Window {
    __SPA_MARKER?: boolean;
  }
}

type NavElement = HTMLElement & { __STAMP?: number };

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/node-static';
const DIST = join(ROOT, PLAYGROUND, 'dist');
const VOID_CONFIG = join(ROOT, PLAYGROUND, 'void.config.ts');

let staticServer: Server | undefined;
let staticBase: string;

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function resolveStaticFile(clientDir: string, requestUrl: string): string | null {
  const url = new URL(requestUrl, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const candidates =
    pathname === '/'
      ? ['index.html']
      : [pathname.slice(1), `${pathname.slice(1)}.html`, `${pathname.slice(1)}/index.html`];

  const root = resolve(clientDir);
  for (const candidate of candidates) {
    const filePath = resolve(root, candidate);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      continue;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return filePath;
    }
  }
  return null;
}

describe('playground/node-static build (target: node, output: static)', () => {
  beforeAll(async () => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    execSync(`vp run --filter ./${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });

    const clientDir = join(DIST, 'client');
    staticServer = createServer((req, res) => {
      const filePath = resolveStaticFile(clientDir, req.url || '/');
      if (!filePath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(filePath) });
      res.end(readFileSync(filePath));
    });
    await new Promise<void>((resolveListen) => {
      staticServer!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = staticServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start static test server');
    }
    staticBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (staticServer) {
      await new Promise<void>((resolveClose) => staticServer!.close(() => resolveClose()));
    }
  });

  it('emits Node SSR entry', () => {
    expect(existsSync(join(DIST, 'ssr/app.js'))).toBe(true);
  });

  it('emits the default 404 page', () => {
    const html = readFileSync(join(DIST, 'client/404.html'), 'utf8');
    expect(html).toContain('<title>404: Not Found</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
  });

  it('prerenders index.html with production asset URLs', () => {
    const indexPath = join(DIST, 'client/index.html');
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="home-title"');
    expect(html).toContain('Home');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('proves rendering happened in Node.js via process.versions.node', () => {
    const html = readFileSync(join(DIST, 'client/index.html'), 'utf-8');
    const match = html.match(/data-testid="runtime"[^>]*>([^<]+)</);
    expect(match).not.toBeNull();
    // Node.js version string like "24.13.1"
    expect(match![1]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prerenders about.html with production asset URLs', () => {
    const aboutPath = join(DIST, 'client/about.html');
    expect(existsSync(aboutPath)).toBe(true);

    const html = readFileSync(aboutPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain('About');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('emits static page data for prerendered routes', () => {
    const indexData = JSON.parse(
      readFileSync(join(DIST, 'client/_void/pages/index.json'), 'utf-8'),
    ) as { component: string; props: Record<string, unknown>; url: string };
    const aboutData = JSON.parse(
      readFileSync(join(DIST, 'client/_void/pages/about.json'), 'utf-8'),
    ) as { component: string; props: Record<string, unknown>; url: string };
    const legacyData = JSON.parse(
      readFileSync(join(DIST, 'client/_void/pages/legacy.json'), 'utf-8'),
    ) as { component: string; props: Record<string, unknown>; url: string };

    expect(indexData.component).toBe('index');
    expect(indexData.url).toBe('/');
    expect(indexData.props.title).toBe('Home');
    expect(aboutData.component).toBe('about');
    expect(aboutData.url).toBe('/about');
    expect(aboutData.props.description).toBe('A statically prerendered page from Node.js.');
    expect(legacyData.component).toBe('legacy');
    expect(legacyData.url).toBe('/legacy');
  });

  it('serves static output with SPA navigation between prerendered Link routes', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${staticBase}/`);
      await page.waitForSelector('#app[data-hydrated="true"]');

      await page.evaluate(() => {
        window.__SPA_MARKER = true;
        (document.querySelector('nav') as NavElement | null)!.__STAMP = 1;
      });

      await page.click('a[href="/about"]');
      await page.waitForSelector('[data-testid="about-title"]');

      expect(page.url()).toBe(`${staticBase}/about`);
      expect(await page.evaluate(() => window.__SPA_MARKER)).toBe(true);
      expect(
        await page.evaluate(() => (document.querySelector('nav') as NavElement | null)?.__STAMP),
      ).toBe(1);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('loads static page data directly during SPA navigation', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${staticBase}/`);
      await page.waitForSelector('#app[data-hydrated="true"]');

      const requests: Array<string> = [];
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith(staticBase)) {
          requests.push(`${request.resourceType()} ${url.slice(staticBase.length)}`);
        }
      });

      await page.evaluate(() => {
        (document.querySelector('a[href="/about"]') as HTMLAnchorElement).click();
      });
      await page.waitForSelector('[data-testid="about-title"]');

      expect(requests).toContain('fetch /_void/pages/about.json');
      expect(requests).not.toContain('fetch /about');
      expect(requests).not.toContain('document /about');
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('reuses on-demand static page data for non-prefetched Link routes', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${staticBase}/`);
      await page.waitForSelector('#app[data-hydrated="true"]');

      const requests: Array<string> = [];
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith(staticBase)) {
          requests.push(`${request.resourceType()} ${url.slice(staticBase.length)}`);
        }
      });

      await page.evaluate(() => {
        (document.querySelector('a[href="/legacy"]') as HTMLAnchorElement).click();
      });
      await page.waitForSelector('[data-testid="legacy-title"]');

      await page.evaluate(() => {
        (document.querySelector('a[href="/"]') as HTMLAnchorElement).click();
      });
      await page.waitForSelector('[data-testid="home-title"]');

      await page.evaluate(() => {
        (document.querySelector('a[href="/legacy"]') as HTMLAnchorElement).click();
      });
      await page.waitForSelector('[data-testid="legacy-title"]');

      expect(
        requests.filter((request) => request === 'fetch /_void/pages/legacy.json'),
      ).toHaveLength(1);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('keeps the query string in router.url on a prerendered React page', async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      const errors: Array<string> = [];
      page.on('console', (message) => {
        const text = message.text();
        // React reports a hydration text mismatch as minified error #418.
        if (text.toLowerCase().includes('hydrat') || text.includes('#418')) {
          errors.push(text);
        }
      });
      page.on('pageerror', (error) => errors.push(error.message));
      // Mark the server-rendered lazy note before React hydrates it.
      await page.addInitScript(() => {
        document.addEventListener('readystatechange', () => {
          if (document.readyState === 'interactive') {
            const note = document.querySelector<NavElement>('[data-testid="lazy-note"]');
            if (note) {
              note.__STAMP = 1;
            }
          }
        });
      });
      const routerUrl = () => page.textContent('[data-testid="router-url"]');

      // The page HTML and its static page data were rendered for the path, without a query.
      const pageData = JSON.parse(
        readFileSync(join(DIST, 'client/_void/pages/router-url/plain.json'), 'utf-8'),
      ) as { url: string };
      expect(pageData.url).toBe('/router-url/plain');
      await page.goto(`${staticBase}/router-url/plain?foo=bar#baz`);
      await page.waitForSelector('#app[data-hydrated="true"]');
      await expect.poll(routerUrl).toBe('/router-url/plain?foo=bar#baz');
      expect(await page.textContent('[data-testid="router-path"]')).toBe(
        '/router-url/plain?foo=bar',
      );
      // An effect that runs once, on mount, sees the query too.
      expect(await page.textContent('[data-testid="router-mount-search"]')).toBe('?foo=bar');
      // The URL switch after hydration keeps the server HTML of a Suspense boundary that has not
      // hydrated yet.
      expect(
        await page.$eval('[data-testid="lazy-note"]', (note: NavElement) => note.__STAMP),
      ).toBe(1);

      await page.click('a[href="#details"]');
      await expect.poll(routerUrl).toBe('/router-url/plain?foo=bar#details');

      await page.click('a[href="/router-url/plain?foo=two"]');
      await page.waitForURL(`${staticBase}/router-url/plain?foo=two`);
      await expect.poll(routerUrl).toBe('/router-url/plain?foo=two');
      expect(await page.textContent('[data-testid="router-path"]')).toBe(
        '/router-url/plain?foo=two',
      );

      // Page data holds the decoded path of a page served at an encoded path.
      await page.goto(`${staticBase}/router-url/a%20b?x=1#a`);
      await page.waitForSelector('#app[data-hydrated="true"]');
      await expect.poll(routerUrl).toBe('/router-url/a%20b?x=1#a');
      await page.click('a[href="#details"]');
      await expect.poll(routerUrl).toBe('/router-url/a%20b?x=1#details');

      // Static hosts also serve the page at its .html path. router.url keeps the page path.
      await page.goto(`${staticBase}/router-url/plain.html?foo=bar#baz`);
      await page.waitForSelector('#app[data-hydrated="true"]');
      await expect.poll(routerUrl).toBe('/router-url/plain?foo=bar#baz');

      // A page rendered only in the browser has no prerendered HTML to match.
      await page.goto(`${staticBase}/router-url-client?foo=bar`);
      await page.waitForSelector('#app[data-hydrated="true"]');
      expect(await page.textContent('[data-testid="router-first-search"]')).toBe('?foo=bar');

      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('collects prerender paths from the built node app endpoint', async () => {
    const paths = await collectPrerenderPathsNode({
      root: join(ROOT, PLAYGROUND),
      ssrDir: join(DIST, 'ssr'),
      clientDir: join(DIST, 'client'),
    });

    expect(paths).toEqual(expect.arrayContaining(['/', '/about', '/legacy']));
  });

  it('does not emit wrangler.json (Node target)', () => {
    expect(existsSync(join(DIST, 'ssr/wrangler.json'))).toBe(false);
    expect(existsSync(join(DIST, 'ssr/wrangler.jsonc'))).toBe(false);
  });
});

describe('playground/node-static redirects (target: node, output: static)', () => {
  let redirectedServer: Server | undefined;
  let externalServer: Server | undefined;
  let redirectedBase: string;
  let externalBase: string;
  let originalConfig: string | undefined;

  beforeAll(async () => {
    originalConfig = readFileSync(VOID_CONFIG, 'utf-8');
    writeFileSync(
      VOID_CONFIG,
      renderVoidConfig({
        ...readConfig(join(ROOT, PLAYGROUND)),
        routing: {
          redirects: {
            '/legacy': '/about',
            '/external-legacy': 'https://example.com/external',
          },
        },
      }),
    );

    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    execSync(`vp run --filter ./${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
    writeFileSync(VOID_CONFIG, originalConfig);

    externalServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>External Target</title><h1>External Target</h1>');
    });
    await new Promise<void>((resolveListen) => {
      externalServer!.listen(0, '127.0.0.1', resolveListen);
    });
    const externalAddress = externalServer.address();
    if (!externalAddress || typeof externalAddress === 'string') {
      throw new Error('Failed to start external static test server');
    }
    externalBase = `http://127.0.0.1:${externalAddress.port}`;

    const clientDir = join(DIST, 'client');
    redirectedServer = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/legacy') {
        res.writeHead(302, { location: '/about' });
        res.end();
        return;
      }
      if (url.pathname === '/external-legacy') {
        res.writeHead(302, { location: `${externalBase}/external-target` });
        res.end();
        return;
      }

      const filePath = resolveStaticFile(clientDir, req.url || '/');
      if (!filePath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'content-type': contentType(filePath) });
      res.end(readFileSync(filePath));
    });
    await new Promise<void>((resolveListen) => {
      redirectedServer!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = redirectedServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start redirected static test server');
    }
    redirectedBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (originalConfig !== undefined) {
      writeFileSync(VOID_CONFIG, originalConfig);
    }
    if (redirectedServer) {
      await new Promise<void>((resolveClose) => redirectedServer!.close(() => resolveClose()));
    }
    if (externalServer) {
      await new Promise<void>((resolveClose) => externalServer!.close(() => resolveClose()));
    }
  });

  it('honors page redirects before loading static page data sidecars', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${redirectedBase}/`);
      await page.waitForSelector('#app[data-hydrated="true"]');

      const requests: Array<string> = [];
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith(redirectedBase)) {
          requests.push(`${request.method()} ${url.slice(redirectedBase.length)}`);
        }
      });

      await page.click('a[href="/legacy"]');
      await page.waitForURL(`${redirectedBase}/about`);
      await page.waitForSelector('[data-testid="about-title"]');

      expect(requests).toContain('GET /legacy');
      expect(requests).not.toContain('GET /_void/pages/legacy.json');
      expect(await page.locator('[data-testid="legacy-title"]').count()).toBe(0);
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it('falls back to document navigation for external page redirects', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await page.goto(`${redirectedBase}/`);
      await page.waitForSelector('#app[data-hydrated="true"]');

      await page.click('a[href="/external-legacy"]');
      await page.waitForURL(`${externalBase}/external-target`);
      await page.waitForSelector('text=External Target');
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
