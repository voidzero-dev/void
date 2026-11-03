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

async function loadServeConfig(): Promise<Record<string, unknown>> {
  mkdirSync(PAGES_DIR, { recursive: true });
  const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
  if (typeof plugin.config === 'function') {
    return (await plugin.config({}, { command: 'serve' })) as Record<string, unknown>;
  }
  return (await plugin.config?.handler({}, { command: 'serve' })) as Record<string, unknown>;
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

  it.each([
    '_ui/frame.tsx',
    'blog/_private/frame.jsx',
    '_layouts/docs.tsx',
    'blog/_layouts/docs.jsx',
    '_helper.tsx',
  ])('omits pages-client for an island-only app with %s', async (helper) => {
    writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    writePage(
      helper,
      'export default function Helper(props) { return <main>{props.children}</main>; }',
    );

    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    expect(await getHookHandler(plugin.config)({}, { command: 'build' })).toBeUndefined();
  });

  it.each([
    ['debug.dev.tsx', false],
    ['debug.prod.tsx', true],
  ] as const)('selects pages-client from production pages for %s', async (page, included) => {
    writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    writePage(page, 'export default function Debug() { return <p>Debug</p>; }');

    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    const config = await getHookHandler(plugin.config)({}, { command: 'build' });
    if (included) {
      expect(config).toMatchObject({
        build: { rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } } },
      });
    } else {
      expect(config).toBeUndefined();
    }
  });

  it.each([false, true])(
    'scans a custom pages root under an underscore path, ordinary page=%s',
    async (ordinary) => {
      const customPages = join(TMP, '_source', '_views');
      mkdirSync(customPages, { recursive: true });
      writeFileSync(
        join(customPages, 'index.island.tsx'),
        'export default function Home() { return <h1>Home</h1>; }',
      );
      if (ordinary) {
        writeFileSync(
          join(customPages, 'about.tsx'),
          'export default function About() { return <p>About</p>; }',
        );
      }

      const plugin = pagesPlugin(customPages, { root: TMP }) as PagesPluginHooks;
      const config = await getHookHandler(plugin.config)({}, { command: 'build' });
      if (ordinary) {
        expect(config).toMatchObject({
          build: { rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } } },
        });
      } else {
        expect(config).toBeUndefined();
      }
    },
  );

  it('omits pages-client for Markdown pages', async () => {
    writePage('index.md', '# Home');
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    expect(await getHookHandler(plugin.config)({}, { command: 'build' })).toBeUndefined();
  });

  it.each([
    ['other.vue', '<template><p>Other</p></template>'],
    ['other.svelte', '<p>Other</p>'],
  ])('uses the scanner inventory for a non-island %s component', async (page, component) => {
    writePage(page, component);
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    expect(await getHookHandler(plugin.config)({}, { command: 'build' })).toMatchObject({
      build: { rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } } },
    });
  });

  it('returns no build config when the pages directory is missing', async () => {
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    expect(await getHookHandler(plugin.config)({}, { command: 'build' })).toBeUndefined();
  });

  it('reports invalid production routes during build configuration', async () => {
    writePage('index.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    writePage('index.jsx', 'export default function Duplicate() { return <h1>Duplicate</h1>; }');
    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    await expect(getHookHandler(plugin.config)({}, { command: 'build' })).rejects.toThrow(
      'Multiple page files resolve to the same route',
    );
  });

  it.each(['tsx', 'jsx'])(
    'omits pages-client for island-only pages with .server.%s files',
    async (extension) => {
      writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
      writePage(`index.server.${extension}`, 'export const loader = () => ({ count: 0 });');

      const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
      expect(await getHookHandler(plugin.config)({}, { command: 'build' })).toBeUndefined();
    },
  );

  it.each([
    'about.tsx',
    'about.jsx',
    'blog/about.tsx',
    'blog/about.jsx',
    'status.server.v2.tsx',
    'status.island.v2.tsx',
    'layout.extra.tsx',
  ])('keeps pages-client for an ordinary %s page alongside island pages', async (page) => {
    writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    writePage('index.server.tsx', 'export const loader = () => ({});');
    writePage('index.server.jsx', 'export const loader = () => ({});');
    writePage(page, 'export default function About() { return <h1>About</h1>; }');

    const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
    expect(await getHookHandler(plugin.config)({}, { command: 'build' })).toMatchObject({
      build: {
        manifest: true,
        rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } },
      },
    });
  });
});

describe('pagesPlugin dev config', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('pre-optimizes page dependencies in the client and Cloudflare worker environments', async () => {
    writePage('index.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    const config = await loadServeConfig();

    expect(config).toMatchObject({
      optimizeDeps: {
        entries: ['pages/index.tsx'],
        include: expect.arrayContaining(['void/pages-client', 'void/pages-prefetch']),
      },
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

  it('scans browser roots without promoting server-only helpers to client entries', async () => {
    writePage('index.tsx', 'export default function Home() { return null; }');
    writePage('index.server.ts', 'import "./_worker-helper";');
    writePage('_worker-helper.ts', 'import "worker-only-package";');
    writePage('layout.tsx', 'export default function Layout({ children }) { return children; }');
    writePage(
      'users/[id].dev.tsx',
      'export const layout = "profile"; export default function User() { return null; }',
    );
    writePage('users/[id].prod.tsx', 'export default function User() { return null; }');
    writePage('_layouts/profile.tsx', 'export default function Profile() { return null; }');
    writePage('_layouts/unused.tsx', 'import "worker-only-package";');
    writePage('static/layout.tsx', 'import "worker-only-package";');
    writePage('static/index.island.tsx', 'export default function Static() { return null; }');
    writePage('__tests__/page.test.tsx', 'import "test-only-package";');

    const config = await loadServeConfig();
    expect(config).toMatchObject({
      optimizeDeps: {
        entries: expect.arrayContaining([
          'pages/index.tsx',
          'pages/layout.tsx',
          'pages/users/\\[id\\].dev.tsx',
          'pages/_layouts/profile.tsx',
        ]),
      },
    });
    expect((config.optimizeDeps as { entries: Array<string> }).entries).toHaveLength(4);
  });

  it('scans hydrated components in island pages and layouts, including outside pages', async () => {
    writePage(
      'index.island.tsx',
      `
      import Counter from './_Counter' with { island: 'load' };
      import './_worker-helper';
      export default function Home() { return <Counter />; }
    `,
    );
    writePage(
      'layout.island.tsx',
      `
      import Header from '../components/Header.tsx' with { island: 'visible' };
      export default function Layout({ children }) { return <><Header />{children}</>; }
    `,
    );
    writePage('_Counter.tsx', 'export default function Counter() { return null; }');
    writePage('../components/Header.tsx', 'export default function Header() { return null; }');
    writePage('_worker-helper.ts', 'import "worker-only-package";');

    const config = await loadServeConfig();
    expect(config).toMatchObject({
      optimizeDeps: {
        entries: expect.arrayContaining(['pages/_Counter.tsx', 'components/Header.tsx']),
      },
    });
    expect((config.optimizeDeps as { entries: Array<string> }).entries).toHaveLength(2);
  });

  it('includes only the React entry points needed by each environment', async () => {
    const config = (await loadServeConfig()) as {
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
    await getHookHandler(plugin.config)({}, { command: 'serve' });
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
    await getHookHandler(plugin.config)({}, { command: 'serve' });
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
    await getHookHandler(plugin.config)({}, { command });
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
    expect(await getHookHandler(plugin.config)({}, { command: 'serve' })).toBeUndefined();

    writePage('debug.dev.tsx', 'export default function Debug() { return <h1>Debug</h1>; }\n');
    await getHookHandler(plugin.buildStart).call({});
    const renderer = await getHookHandler(plugin.load)('\0virtual:void-pages-renderer');

    expect(renderer).toContain('debug.dev.tsx');
    expect(renderer).toContain('/@react-refresh');
  });
});
