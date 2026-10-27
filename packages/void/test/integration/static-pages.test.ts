import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { collectPrerenderPaths } from '../../src/prerender.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/static-pages';
const DIST = join(ROOT, PLAYGROUND, 'dist');

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

describe('playground/static-pages build (output: static)', () => {
  beforeAll(() => {
    const pg = join(ROOT, PLAYGROUND);
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    rmSync(join(pg, '.void'), { recursive: true, force: true });
    removeWranglerConfig(pg);
    execSync(`vp run --filter ./${PLAYGROUND} build`, { cwd: ROOT, stdio: 'pipe' });
  });

  it('emits worker entry and client manifest', () => {
    const workerEntry = join(DIST, 'ssr/index.js');
    const clientManifest = join(DIST, 'client/.vite/manifest.json');

    expect(existsSync(workerEntry)).toBe(true);
    expect(existsSync(clientManifest)).toBe(true);
  });

  it('serves the generated 404 for missing static URLs with HTTP 404', async () => {
    const html = readFileSync(join(DIST, 'client/404.html'), 'utf8');
    expect(html).toContain('<title>404: Not Found</title>');
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        modules: true,
        script: 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } };',
        assets: {
          directory: join(DIST, 'client'),
          binding: 'ASSETS',
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
          assetConfig: { not_found_handling: '404-page' },
        },
      }),
    );
    try {
      for (const path of ['/missing', '/nested/missing']) {
        const response = await runtime.dispatchFetch(`http://localhost${path}`);
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(await response.text()).toBe(html);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('prerenders index.html with production asset URLs', () => {
    const indexPath = join(DIST, 'client/index.html');
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="home-title"');
    expect(html).toContain('Home');
    expect(html).toContain('static pages playground');

    // Must use production asset URLs, not dev-time URLs
    expect(html).toContain('src="/assets/');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('/@id/');
  });

  it('prerenders about.html with production asset URLs', () => {
    const aboutPath = join(DIST, 'client/about.html');
    expect(existsSync(aboutPath)).toBe(true);

    const html = readFileSync(aboutPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('data-testid="about-title"');
    expect(html).toContain('About');
    expect(html).toContain('static HTML');

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

    expect(indexData.component).toBe('index');
    expect(indexData.url).toBe('/');
    expect(indexData.props.title).toBe('Home');
    expect(aboutData.component).toBe('about');
    expect(aboutData.url).toBe('/about');
    expect(aboutData.props.content).toBe('About page content');
  });

  it('prerenders client-only pages as shells with static page data', () => {
    const clientOnlyPath = join(DIST, 'client/client-only.html');
    expect(existsSync(clientOnlyPath)).toBe(true);

    const html = readFileSync(clientOnlyPath, 'utf-8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('__VOID_PAGE_DATA__');
    expect(html).toContain('data-void-ssr="false"');
    expect(html).toContain('Client-only Static Page');
    expect(html).not.toContain('data-testid="client-only-title"');
    expect(html).not.toContain('client-only static page component rendered on the server');

    const pageData = JSON.parse(
      readFileSync(join(DIST, 'client/_void/pages/client-only.json'), 'utf-8'),
    ) as { component: string; props: Record<string, unknown>; url: string };
    expect(pageData.component).toBe('client-only');
    expect(pageData.url).toBe('/client-only');
    expect(pageData.props.title).toBe('Client-only Static Page');
    expect(pageData.props.marker).toBe('static-loader-props');
  });

  it('prerenders dynamic pages with getPrerenderPaths', () => {
    // posts/[slug] exports getPrerenderPaths returning [{slug:"hello"},{slug:"world"}]
    const helloPath = join(DIST, 'client/posts/hello.html');
    const worldPath = join(DIST, 'client/posts/world.html');
    expect(existsSync(helloPath)).toBe(true);
    expect(existsSync(worldPath)).toBe(true);

    const html = readFileSync(helloPath, 'utf-8');
    expect(html).toContain('data-testid="post-title"');
    expect(html).toContain('Post hello');
  });

  it('collects prerender paths from the built worker endpoint', async () => {
    const paths = await collectPrerenderPaths({
      root: join(ROOT, PLAYGROUND),
      workerDir: join(DIST, 'ssr'),
      clientDir: join(DIST, 'client'),
      persistDir: join(ROOT, PLAYGROUND, '.void'),
    });

    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/about',
        '/client-only',
        '/posts/hello',
        '/posts/world',
        '/tags/vue',
        '/tags/vite',
        '/docs/getting-started',
        '/docs/guides/sidebar-nesting',
      ]),
    );
    expect(paths).not.toContain('/items/:id');
    // Catch-all paths must not contain the raw pattern suffix
    for (const p of paths) {
      expect(p).not.toContain('{.+}');
    }
  });

  it('prerenders dynamic pages with getPrerenderPaths using virtual modules', () => {
    const vuePath = join(DIST, 'client/tags/vue.html');
    const vitePath = join(DIST, 'client/tags/vite.html');
    expect(existsSync(vuePath)).toBe(true);
    expect(existsSync(vitePath)).toBe(true);

    const html = readFileSync(vuePath, 'utf-8');
    expect(html).toContain('data-testid="tag-title"');
    expect(html).toContain('Tag vue');
  });

  it('prerenders catch-all pages with getPrerenderPaths', () => {
    // docs/[...slug] exports getPrerenderPaths returning single and multi-segment slugs
    const gettingStartedPath = join(DIST, 'client/docs/getting-started.html');
    const sidebarNestingPath = join(DIST, 'client/docs/guides/sidebar-nesting.html');
    expect(existsSync(gettingStartedPath)).toBe(true);
    expect(existsSync(sidebarNestingPath)).toBe(true);

    const html = readFileSync(gettingStartedPath, 'utf-8');
    expect(html).toContain('data-testid="doc-title"');
    expect(html).toContain('Doc getting-started');

    // Filenames must not contain the raw catch-all pattern suffix
    expect(existsSync(join(DIST, 'client/docs/getting-started{.+}.html'))).toBe(false);
    expect(existsSync(join(DIST, 'client/docs/guides/sidebar-nesting{.+}.html'))).toBe(false);
  });

  it('does not prerender dynamic pages without getPrerenderPaths', () => {
    // items/[id] has no getPrerenderPaths, so it should NOT be prerendered
    expect(existsSync(join(DIST, 'client/items'))).toBe(false);
  });

  it('wrangler.json has correct asset config', () => {
    const wranglerConfig = JSON.parse(readFileSync(join(DIST, 'ssr/wrangler.json'), 'utf-8')) as {
      assets?: {
        directory?: string;
        not_found_handling?: string;
        run_worker_first?: boolean | Array<string>;
      };
    };
    expect(wranglerConfig.assets?.directory).toBe('../client');
    expect(wranglerConfig.assets?.run_worker_first).toBeDefined();
    expect(wranglerConfig.assets?.not_found_handling).toBe('none');
  });
});
