import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { pagesPlugin } from '../../src/plugin-pages.ts';
import { IMAGE_PAGE_PRELOADS, importRendererWithImagePage } from './image-page-fixture.ts';

const TMP = join(import.meta.dirname, '__tmp_pages_plugin__');
const PAGES_DIR = join(TMP, 'pages');

type HookWithHandler<T> = { handler: T };
type PagesPluginHooks = {
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  configureServer?: (server: unknown) => void;
  config?:
    | ((config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown)
    | HookWithHandler<
        (config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown
      >;
  load?:
    | ((id: string) => Promise<string | undefined> | string | undefined)
    | HookWithHandler<(id: string) => Promise<string | undefined> | string | undefined>;
};

function getHookHandler<T>(hook: T | HookWithHandler<T> | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

function writePage(relativePath: string, source: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
}

function setupWatcher(plugin: PagesPluginHooks) {
  const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
  plugin.configureServer?.({
    watcher: {
      on(event: string, handler: (path: string) => Promise<void> | void) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
    },
    environments: {},
  });
  return handlers;
}

describe('pagesPlugin dev HMR', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('rescans dev renderer loads after adding a page file', async () => {
    writePage('index.vue', '<template><h1>Home</h1></template>\n');

    const plugin = pagesPlugin(PAGES_DIR).find((p) => p.name === 'void-vue:pages') as
      | PagesPluginHooks
      | undefined;
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }
    getHookHandler(plugin.config)({}, { command: 'serve' });
    await getHookHandler(plugin.buildStart).call({});
    const handlers = setupWatcher(plugin);

    writePage('test.vue', '<template><h1>Test</h1></template>\n');
    for (const handler of handlers.get('add') ?? []) {
      await handler(join(PAGES_DIR, 'test.vue'));
    }

    const load = getHookHandler(plugin.load);
    const renderer = await load('\0virtual:void-pages-renderer');

    expect(renderer).toContain('"test": () => import');
  });
});

describe('pagesPlugin renderer image preloads', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('renders with an SSR context and puts Image preloads in <head> before CSS', async () => {
    writePage('index.vue', '<template><h1>Home</h1></template>\n');
    const plugin = pagesPlugin(PAGES_DIR).find((p) => p.name === 'void-vue:pages') as
      | PagesPluginHooks
      | undefined;
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }
    await getHookHandler(plugin.buildStart).call({});
    const renderer = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');
    if (!renderer) {
      throw new Error('Expected the pages renderer module.');
    }
    expect(renderer).toContain('const html = await renderToString(app, ssrContext);');
    expect(renderer).toContain(
      '<head>${headHtml}${imagePreloads}${assetTags.css}${assetTags.preloads}</head>',
    );

    const { renderPage } = (await importRendererWithImagePage(
      renderer,
      join(PAGES_DIR, 'index.vue'),
      TMP,
    )) as {
      renderPage: (pageObj: unknown, assetTags: Record<string, string>) => Promise<string>;
    };
    const assetTags = {
      css: '<link rel="stylesheet" href="/app.css">',
      preloads: '<link rel="modulepreload" href="/app.js">',
      body: '<script type="module" src="/app.js"></script>',
    };
    const html = await renderPage(
      { component: 'index', props: {}, url: '/', params: {}, shared: {}, head: { title: 'Home' } },
      assetTags,
    );
    expect(html).toContain(
      `<head><title>Home</title>${IMAGE_PAGE_PRELOADS}${assetTags.css}${assetTags.preloads}</head>`,
    );
    expect(html.match(/rel="preload" as="image"/g)).toHaveLength(2);

    const plain = await renderPage(
      { component: 'index', props: {}, url: '/', params: {}, shared: {} },
      assetTags,
    );
    expect(plain).toContain(`<head>${IMAGE_PAGE_PRELOADS}${assetTags.css}`);
  });
});
