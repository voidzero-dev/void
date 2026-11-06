import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { installedDependencies, pagesPlugin } from '../../src/plugin-pages.ts';

const TMP = join(import.meta.dirname, '__tmp_pages_plugin__');
const PAGES_DIR = join(TMP, 'pages');

type HookWithHandler<T> = { handler: T };
type ConfigHook = (config: Record<string, unknown>, env: { command: 'serve' | 'build' }) => unknown;
type LoadHook = (id: string) => Promise<string | undefined> | string | undefined;
type PagesPluginHooks = {
  name: string;
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  config?: ConfigHook | HookWithHandler<ConfigHook>;
  load?: LoadHook | HookWithHandler<LoadHook>;
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

async function loadConfig(command: 'serve' | 'build'): Promise<Record<string, unknown>> {
  const plugin = pagesPlugin(PAGES_DIR) as PagesPluginHooks;
  return (await getHookHandler(plugin.config)({}, { command })) as Record<string, unknown>;
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('pagesPlugin', () => {
  it('uses the plugin name @void/md detects', () => {
    expect((pagesPlugin(PAGES_DIR) as PagesPluginHooks).name).toBe('void-hono:pages');
  });
});

describe('pagesPlugin build config', () => {
  it('omits pages-client for an island-only app', async () => {
    writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    writePage('guide.md', '# Guide');

    expect(await loadConfig('build')).toBeUndefined();
  });

  it('keeps pages-client for an ordinary page alongside island pages', async () => {
    writePage('index.island.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    writePage('about.tsx', 'export default function About() { return <h1>About</h1>; }');

    expect(await loadConfig('build')).toMatchObject({
      build: {
        manifest: true,
        rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } },
      },
    });
  });
});

describe('pagesPlugin dev config', () => {
  it('pre-optimizes Hono JSX and page dependencies in both environments', async () => {
    writePage('index.tsx', 'export default function Home() { return <h1>Home</h1>; }');

    expect(await loadConfig('serve')).toMatchObject({
      optimizeDeps: {
        exclude: ['@void/hono'],
        entries: ['pages/index.tsx'],
        include: expect.arrayContaining(['hono/jsx', 'hono/jsx/dom', 'hono/jsx/dom/client']),
      },
      environments: {
        void_worker: {
          optimizeDeps: {
            exclude: ['@void/hono'],
            entries: ['pages/**/*.{js,jsx,ts,tsx}'],
            include: expect.arrayContaining([
              'hono',
              'hono/jsx',
              'hono/jsx/jsx-runtime',
              'hono/html',
            ]),
          },
        },
      },
    });
  });

  it('keeps the browser runtime out of the worker environment', async () => {
    writePage('index.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    const config = (await loadConfig('serve')) as {
      environments: { void_worker: { optimizeDeps: { include: Array<string> } } };
    };

    expect(config.environments.void_worker.optimizeDeps.include).not.toContain('hono/jsx/dom');
  });

  it('scans hydrated components of island pages, not the pages themselves', async () => {
    writePage(
      'index.island.tsx',
      `
      import Counter from './_Counter' with { island: 'load' };
      import './_worker-helper';
      export default function Home() { return <Counter />; }
    `,
    );
    writePage('_Counter.tsx', 'export default function Counter() { return null; }');
    writePage('_worker-helper.ts', 'import "worker-only-package";');

    const config = (await loadConfig('serve')) as { optimizeDeps: { entries: Array<string> } };
    expect(config.optimizeDeps.entries).toEqual(['pages/_Counter.tsx']);
  });

  it('serves the workspace-linked void as source instead of pre-bundling it', async () => {
    writePage('index.tsx', 'export default function Home() { return <h1>Home</h1>; }');
    const config = (await loadConfig('serve')) as { optimizeDeps: { include: Array<string> } };

    expect(config.optimizeDeps.include).not.toContain('void/pages-client');
    expect(config.optimizeDeps.include).not.toContain('void/pages-prefetch');
  });
});

describe('pagesPlugin generated modules', () => {
  it('renders and starts pages through the adapter runtime', async () => {
    writePage('index.tsx', 'export default function Home() { return <h1>Home</h1>; }');

    const plugin = pagesPlugin(PAGES_DIR, {
      viewTransitions: true,
      prefetch: { defaultStrategy: 'hover', hoverDelay: 120, cacheFor: '1m' },
    }) as PagesPluginHooks;
    await getHookHandler(plugin.config)({}, { command: 'build' });
    await getHookHandler(plugin.buildStart).call({});
    const load = getHookHandler(plugin.load);
    const renderer = await load('\0virtual:void-pages-renderer');
    const client = await load('\0virtual:void-pages-client');

    expect(renderer).toContain('import { renderHonoPage } from "@void/hono/pages-server"');
    expect(renderer).toContain('["index", () => import');
    expect(client).toContain('import { startHonoPages } from "@void/hono/pages-client"');
    expect(client).toContain('viewTransitions: true');
    expect(client).toContain('prefetchHoverDelay: 120');
    expect(client).toContain('prefetchDefaultCacheFor: parseCacheFor("1m")');
    expect(client).toContain('prefetchDefaultStrategy: "hover"');
  });
});

describe('installedDependencies', () => {
  it('keeps entries installed in node_modules and drops linked workspace entries', () => {
    const files: Record<string, string> = {
      'void/pages-client':
        '/app/node_modules/.pnpm/void@1.6.2/node_modules/void/dist/pages/client.mjs',
      'void/pages-prefetch': 'C:\\app\\node_modules\\void\\dist\\pages\\prefetch.mjs',
      'void/live/client': '/repo/packages/void/dist/runtime/live-client.mjs',
    };

    expect(installedDependencies(Object.keys(files), (specifier) => files[specifier]!)).toEqual([
      'void/pages-client',
      'void/pages-prefetch',
    ]);
  });
});
