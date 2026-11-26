import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import type { Plugin } from 'vite';
import { expect, it } from 'vite-plus/test';
import { createPackageFixtureDir } from '../../../../test/integration-helpers.ts';
import { pagesPlugin } from '../../src/plugin-pages.ts';

type HookWithHandler<T> = { handler: T };
type LoadHook = (id: string) => Promise<string | undefined> | string | undefined;
type PagesPluginHooks = {
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  config?: ((config: Record<string, unknown>, env: { command: 'build' }) => void) | object;
  load?: LoadHook | HookWithHandler<LoadHook>;
};
type Renderer = {
  renderPage: (
    pageObj: Record<string, unknown>,
    assetTags: Record<string, string>,
    requestUrl: string,
  ) => Promise<string>;
};

function handler<T>(hook: T | HookWithHandler<T> | undefined): T {
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  if (hook === undefined) {
    throw new Error('Expected Vite hook handler.');
  }
  return hook;
}

const PAGE = `<script>
  import { usePageQuery } from "@void/svelte";
  const query = usePageQuery();
</script>
<p id="status">status={query.status}</p>
`;

it('renders usePageQuery() on the server with the page query', async () => {
  const root = createPackageFixtureDir(join(import.meta.dirname, '../..'), '.tmp-page-query-ssr-');
  const pagesDir = join(root, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, 'index.svelte'), PAGE);

  // The renderer the build ships, so the test sees the props it really passes.
  const pages = pagesPlugin(pagesDir) as PagesPluginHooks;
  const config = handler(pages.config);
  if (typeof config === 'function') {
    config({}, { command: 'build' });
  }
  await handler(pages.buildStart).call({});
  const rendererCode = await handler(pages.load)('\0virtual:void-pages-renderer');
  const renderer: Plugin = {
    name: 'test-renderer',
    resolveId: (id) => (id === 'virtual:test-renderer' ? '\0virtual:test-renderer' : undefined),
    load: (id) => (id === '\0virtual:test-renderer' ? rendererCode : undefined),
  };

  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    plugins: [svelte(), renderer],
  });
  try {
    const { renderPage } = (await server.ssrLoadModule('virtual:test-renderer')) as Renderer;
    const html = await renderPage(
      {
        component: 'index',
        props: {},
        url: '/?status=paid',
        params: {},
        query: { status: 'paid' },
      },
      { css: '', preloads: '', body: '' },
      'http://localhost/?status=paid',
    );
    // The client hydrates with the same query, so the server must render it too.
    expect(html).toContain('<p id="status">status=paid</p>');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
