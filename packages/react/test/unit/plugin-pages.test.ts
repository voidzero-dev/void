import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
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

function loadServeConfig(): Record<string, unknown> {
  mkdirSync(PAGES_DIR, { recursive: true });
  const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
  if (typeof plugin.config === 'function') {
    return plugin.config({}, { command: 'serve' }) as Record<string, unknown>;
  }
  return plugin.config?.handler({}, { command: 'serve' }) as Record<string, unknown>;
}

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

function setupWatcher(plugin: PagesPluginHooks, logError = vi.fn(), invalidateModule = vi.fn()) {
  const handlers = new Map<string, Array<(path: string) => Promise<void> | void>>();
  plugin.configureServer?.({
    watcher: {
      on(event: string, handler: (path: string) => Promise<void> | void) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
    },
    environments: {
      client: { moduleGraph: { getModuleById: (id: string) => ({ id }), invalidateModule } },
    },
    config: { logger: { error: logError } },
  });
  return handlers;
}

describe('pagesPlugin build config', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it.each(['tsx', 'jsx'])(
    'omits pages-client for island-only pages with .server.%s files',
    (extension) => {
      writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
      writePage(`index.server.${extension}`, 'export const loader = () => ({ count: 0 });');

      const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
      expect(getHookHandler(plugin.config)({}, { command: 'build' })).toBeUndefined();
    },
  );

  it.each(['about.tsx', 'about.jsx', 'blog/about.tsx', 'blog/about.jsx', 'status.server.v2.tsx'])(
    'keeps pages-client for an ordinary %s page alongside island pages',
    (page) => {
      writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
      writePage('index.server.tsx', 'export const loader = () => ({});');
      writePage('index.server.jsx', 'export const loader = () => ({});');
      writePage(page, 'export default function About() { return <h1>About</h1>; }');

      const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
      expect(getHookHandler(plugin.config)({}, { command: 'build' })).toMatchObject({
        build: {
          manifest: true,
          rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } },
        },
      });
    },
  );
});

describe('pagesPlugin dev config', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('pre-optimizes React dependencies in the Cloudflare worker environment', () => {
    const config = loadServeConfig();

    expect(config).toMatchObject({
      environments: {
        void_worker: {
          optimizeDeps: {
            exclude: ['@void/react'],
            entries: ['pages/**/*.{js,jsx,ts,tsx}'],
            include: expect.arrayContaining([
              'react',
              'react-dom',
              'react-dom/server',
              'void/live/client',
            ]),
          },
        },
      },
    });
  });

  it('includes only the React entry points needed by each environment', () => {
    const config = loadServeConfig() as {
      optimizeDeps: { include: Array<string> };
      ssr?: { optimizeDeps?: { include?: Array<string> } };
      environments: {
        void_worker: { optimizeDeps: { include: Array<string> } };
      };
    };

    expect(config.optimizeDeps.include).toContain('react-dom/client');
    expect(config.optimizeDeps.include).not.toContain('react-dom/server');
    expect(config.environments.void_worker.optimizeDeps.include).toContain('react-dom/server');
    expect(config.environments.void_worker.optimizeDeps.include).not.toContain('react-dom/client');
    expect(config.ssr?.optimizeDeps?.include).toEqual([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'react-dom/server',
    ]);
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

    expect(renderer).toContain('["test", () => import');
  });

  it('logs a page scan error from the watcher and keeps the last scan', async () => {
    writePage('index.tsx', 'export default function Index() { return <h1>Home</h1>; }\n');

    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    getHookHandler(plugin.config)({}, { command: 'serve' });
    await getHookHandler(plugin.buildStart).call({});
    const logError = vi.fn();
    const invalidateModule = vi.fn();
    const handlers = setupWatcher(plugin, logError, invalidateModule);
    const emitAdd = async (relativePath: string) => {
      for (const handler of handlers.get('add') ?? []) {
        await expect(handler(join(PAGES_DIR, relativePath))).resolves.toBeUndefined();
      }
    };

    writePage('about.md', '---\nlayout: docs\n---\n# About\n');
    await emitAdd('about.md');

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toContain("specifies layout 'docs'");
    expect(invalidateModule).not.toHaveBeenCalled();
    const renderer = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');
    expect(renderer).toContain('["index", () => import');
    expect(renderer).not.toContain('"about"');

    writePage(
      '_layouts/docs.tsx',
      'export default function Docs({ children }) { return <main>{children}</main>; }\n',
    );
    await emitAdd('_layouts/docs.tsx');

    expect(logError).toHaveBeenCalledTimes(1);
    expect(invalidateModule).toHaveBeenCalled();
    const recovered = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');
    expect(recovered).toContain('"about"');
  });
});

describe('pagesPlugin environment suffixes', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  function writeSuffixPages(): void {
    writePage('index.tsx', 'export default function Index() { return <h1>Home</h1>; }\n');
    writePage('debug.dev.tsx', 'export default function Debug() { return <h1>Debug</h1>; }\n');
    writePage('home.dev.tsx', 'export default function Home() { return <h1>Dev</h1>; }\n');
    writePage('home.prod.tsx', 'export default function Home() { return <h1>Prod</h1>; }\n');
  }

  async function loadModules(command: 'serve' | 'build') {
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    getHookHandler(plugin.config)({}, { command });
    await getHookHandler(plugin.buildStart).call({});
    const load = getHookHandler(plugin.load);
    return {
      renderer: await load('\0virtual:void-pages-renderer'),
      client: await load('\0virtual:void-pages-client'),
    };
  }

  it('leaves .dev pages out of the build renderer and client entry', async () => {
    writeSuffixPages();

    const { renderer, client } = await loadModules('build');

    for (const code of [renderer, client]) {
      expect(code).not.toContain('debug.dev');
      expect(code).not.toContain('home.dev');
      expect(code).toContain('home.prod.tsx');
      expect(code).toContain('index.tsx');
    }
  });

  it('keeps .dev pages and leaves out .prod pages in serve', async () => {
    writeSuffixPages();

    const { renderer, client } = await loadModules('serve');

    for (const code of [renderer, client]) {
      expect(code).toContain('debug.dev.tsx');
      expect(code).toContain('home.dev.tsx');
      expect(code).not.toContain('home.prod');
    }
  });

  it('scans for dev when pages/ is created after the serve config', async () => {
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    expect(getHookHandler(plugin.config)({}, { command: 'serve' })).toBeUndefined();

    writePage('debug.dev.tsx', 'export default function Debug() { return <h1>Debug</h1>; }\n');
    await getHookHandler(plugin.buildStart).call({});
    const renderer = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');

    expect(renderer).toContain('debug.dev.tsx');
    expect(renderer).toContain('/@react-refresh');
  });
});
