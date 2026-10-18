import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Plugin, type Rolldown } from 'vite';
import solid from 'vite-plugin-solid';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { pagesPlugin } from '../../src/plugin-pages.ts';

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
    writePage('index.tsx', 'export default function Index() { return <h1>Home</h1>; }\n');

    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    getHookHandler(plugin.config)({}, { command: 'serve' });
    await getHookHandler(plugin.buildStart).call({});
    const handlers = setupWatcher(plugin);

    writePage('test.tsx', 'export default function Test() { return <h1>Test</h1>; }\n');
    for (const handler of handlers.get('add') ?? []) {
      await handler(join(PAGES_DIR, 'test.tsx'));
    }

    const load = getHookHandler(plugin.load);
    const renderer = await load('\0virtual:void-pages-renderer');

    expect(renderer).toContain('"test": () => import');
  });
});

describe('pagesPlugin image preloads', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  async function loadModules() {
    writePage('index.tsx', 'export default function Index() { return <h1>Home</h1>; }\n');
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    getHookHandler(plugin.config)({}, { command: 'build' });
    await getHookHandler(plugin.buildStart).call({});
    const load = getHookHandler(plugin.load);
    return {
      renderer: (await load('\0virtual:void-pages-renderer')) ?? '',
      client: (await load('\0virtual:void-pages-client')) ?? '',
    };
  }

  /** The first `createComponent` call inside a generated root function. */
  function outermostComponent(code: string, root: string): string | undefined {
    const body = code.slice(code.indexOf(`function ${root}() {`));
    return /createComponent\(([\w.]+)/.exec(body)?.[1];
  }

  it('collects preloads per request and puts them into <head>', async () => {
    const { renderer } = await loadModules();

    expect(renderer).toContain('import { createImagePreloadCollector } from "void/image";');
    expect(
      renderer.indexOf('const imagePreloads = createImagePreloadCollector();'),
    ).toBeGreaterThan(renderer.indexOf('export async function renderPage('));
    expect(renderer).toContain('<head>${headHtml}${imagePreloads.render()}${assetTags.css}');
  });

  it('wraps the server and client trees in the same outermost provider', async () => {
    const { renderer, client } = await loadModules();

    expect(outermostComponent(renderer, 'ServerApp')).toBe('ImagePreloadContext.Provider');
    expect(renderer).toContain('value: imagePreloads,');
    expect(outermostComponent(client, 'App')).toBe('ImagePreloadContext.Provider');
    expect(client).toMatch(/createComponent\(ImagePreloadContext\.Provider, \{\s+value: null,/);
    for (const code of [renderer, client]) {
      expect(code).toMatch(/import \{[^}]*\bImagePreloadContext\b[^}]*\} from "@void\/solid";/);
      expect(code.match(/createComponent\(\w+Context\.Provider/g)).toHaveLength(6);
    }
  });
});

describe('pagesPlugin renderer', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('renders the preload links of a page into <head>', async () => {
    writePage(
      'index.tsx',
      `import { Image } from '@void/solid';
export default function Index() {
  return <main><Image src="/lcp.jpg" alt="LCP" width={800} height={400} preload /></main>;
}
`,
    );
    // The renderer's own input only: the plugin's config hook adds the client entry.
    const { config: _config, ...plugin } = pagesPlugin(PAGES_DIR);
    const output = (await build({
      root: TMP,
      configFile: false,
      logLevel: 'silent',
      plugins: [solid({ ssr: true }), plugin as Plugin],
      resolve: {
        alias: { '@void/solid': join(import.meta.dirname, '../../src/runtime/index.ts') },
      },
      build: {
        ssr: true,
        write: false,
        minify: false,
        rollupOptions: {
          input: 'virtual:void-pages-renderer',
          external: [/^solid-js(\/|$)/, /^void(\/|$)/],
          output: { codeSplitting: false },
        },
      },
    })) as Rolldown.RolldownOutput;
    const chunk = output.output.find((item) => item.type === 'chunk' && item.isEntry);
    if (!chunk || chunk.type !== 'chunk') {
      throw new Error('Expected a renderer chunk.');
    }
    const file = join(TMP, 'renderer.mjs');
    writeFileSync(file, chunk.code);
    const { renderPage } = (await import(pathToFileURL(file).href)) as {
      renderPage(
        pageObj: Record<string, unknown>,
        assetTags: Record<string, string>,
      ): Promise<string>;
    };
    const assetTags = { css: '<link rel="stylesheet" href="/app.css">', preloads: '', body: '' };
    const page = { component: 'index', props: {}, url: '/', params: {} };

    const html = await renderPage(page, assetTags);
    const link =
      '<link rel="preload" as="image" imagesrcset="/_void/image?url=%2Flcp.jpg&amp;w=828&amp;q=75 1x, /_void/image?url=%2Flcp.jpg&amp;w=1920&amp;q=75 2x">';

    expect(html).toContain(`<head>${link}<link rel="stylesheet" href="/app.css">`);
    expect(html).toMatch(/<div id="app"><main data-hk="[^"]+"><img data-hk="[^"]+" alt="LCP" /);
    // Each request collects its own preloads.
    expect((await renderPage(page, assetTags)).split(link)).toHaveLength(2);
  }, 30_000);
});
