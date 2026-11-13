import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { definePagesPluginTests } from '../../../../test/pages-plugin-contract.ts';
import { installedDependencies, pagesPlugin } from '../../src/plugin-pages.ts';

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

function writePage(relativePath: string, source: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
}

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
        include: expect.arrayContaining(['react', 'react-dom/client']),
      },
      environments: {
        void_worker: {
          optimizeDeps: {
            exclude: ['@void/react'],
            entries: ['pages/**/*.{js,jsx,ts,tsx}'],
            include: expect.arrayContaining(['react', 'react-dom', 'react-dom/server']),
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

  it('serves the workspace-linked void as source instead of pre-bundling it', async () => {
    // This repository links void from packages/void, so a pre-bundled copy would
    // outlive the next void build.
    const config = (await loadServeConfig()) as {
      optimizeDeps: { include: Array<string> };
      environments: { void_worker: { optimizeDeps: { include: Array<string> } } };
    };

    expect(config.optimizeDeps.include).not.toContain('void/pages-client');
    expect(config.optimizeDeps.include).not.toContain('void/pages-prefetch');
    expect(config.environments.void_worker.optimizeDeps.include).not.toContain('void/live/client');
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
});

definePagesPluginTests(pagesPlugin, TMP, { reactRefresh: true });
