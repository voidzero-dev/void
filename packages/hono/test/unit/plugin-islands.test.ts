import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vite-plus/test';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const TMP = join(import.meta.dirname, '__tmp_islands_plugin__');
const PAGES_DIR = join(TMP, 'pages');
type HookWithHandler<T> = { handler: T };
type LoadHook = (id: string) => string | undefined;
type TransformHook = (code: string, id: string) => { code: string; map: null } | undefined;
type IslandsPluginHooks = {
  configResolved?: (config: {
    root: string;
    command: 'serve' | 'build';
    plugins: ReadonlyArray<unknown>;
  }) => void;
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  load?: LoadHook | HookWithHandler<LoadHook>;
  transform?: TransformHook | HookWithHandler<TransformHook>;
};

function writeFile(relativePath: string, content: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function setupPlugin(options?: { dev?: boolean }) {
  const plugin = islandsPlugin(PAGES_DIR)[0] as IslandsPluginHooks;
  const warn = vi.fn();

  plugin.configResolved?.({ root: TMP, command: options?.dev ? 'serve' : 'build', plugins: [] });

  function load(id: string): string | undefined {
    if (typeof plugin.load === 'function') {
      return plugin.load(id);
    }
    return plugin.load?.handler(id);
  }

  return {
    warn,
    async buildStart() {
      if (typeof plugin.buildStart === 'function') {
        await plugin.buildStart.call({});
      } else {
        await plugin.buildStart?.handler.call({});
      }
    },
    loadClientEntry: () => load('\0virtual:void-islands-client'),
    loadRenderer: () => load('\0virtual:void-islands-renderer'),
    transform(relativePath: string): { code: string; map: null } | undefined {
      const id = join(PAGES_DIR, relativePath);
      const code = readFileSync(id, 'utf-8');
      if (typeof plugin.transform === 'function') {
        return plugin.transform.call({ warn }, code, id);
      }
      return plugin.transform?.handler.call({ warn }, code, id);
    },
  };
}

function writeCounterPage(): void {
  writeFile(
    'index.island.tsx',
    `import Counter from "./Counter" with { island: "visible" }
export default function Home() { return <Counter initial={1} />; }`,
  );
  writeFile('Counter.tsx', `export default function Counter() { return <button>0</button>; }`);
}

beforeEach(() => {
  mkdirSync(PAGES_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('islandsPlugin — island imports', () => {
  it('wraps an island import with a Hono JSX element that carries its hydration data', async () => {
    writeCounterPage();

    const { buildStart, transform } = setupPlugin();
    await buildStart();
    const code = transform('index.island.tsx')?.code;

    expect(code).toContain('import { jsx as _jsx_island } from "hono/jsx";');
    expect(code).toContain('import _raw_island_0 from "./Counter"');
    expect(code).toContain('"data-island": "pages/Counter"');
    expect(code).toContain('"data-props": JSON.stringify(props)');
    expect(code).toContain('"data-hydrate": "visible"');
    expect(code).toContain('_jsx_island(_raw_island_0, props)');
  });

  it('leaves a page without island imports unchanged', async () => {
    writeFile('index.island.tsx', `export default function Home() { return <h1>Home</h1>; }`);

    const { buildStart, transform } = setupPlugin();
    await buildStart();

    expect(transform('index.island.tsx')).toBeUndefined();
  });

  it('warns when an island page imports useForm', async () => {
    writeFile(
      'index.island.tsx',
      `import { useForm } from "@void/hono";
export default function Home() { return <h1>Home</h1>; }`,
    );

    const { buildStart, transform, warn } = setupPlugin();
    await buildStart();
    transform('index.island.tsx');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Use useIslandForm instead'));
  });

  it('pre-scans island imports from island layouts into the manifest', async () => {
    writeFile(
      'blog/layout.island.tsx',
      `import Counter from "../_components/Counter" with { island: "load" }
export default function Layout({ children }) { return <div><Counter />{children}</div>; }`,
    );
    writeFile(
      'blog/index.island.tsx',
      `export default function Blog() { return <div>Blog</div>; }`,
    );
    writeFile(
      '_components/Counter.tsx',
      `export default function Counter() { return <button>0</button>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();

    expect(loadClientEntry()).toContain('pages/_components/Counter');
  });
});

describe('islandsPlugin — client entry', () => {
  it('hydrates islands with Hono JSX', async () => {
    writeCounterPage();

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toContain('import("hono/jsx/dom/client")');
    expect(clientEntry).toContain('initIslands(islands, hydrateIsland);');
  });

  it('copies static stylesheet imports into the production client entry', async () => {
    writeFile(
      'index.island.tsx',
      `import './first.css';
export default function Home() { return <div>Home</div>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();

    expect(loadClientEntry()).toContain('first.css');
  });
});

describe('islandsPlugin — island updates in dev', () => {
  type HmrPlugin = {
    name: string;
    apply?: string;
    transform: { handler: (code: string, id: string) => { code: string } | undefined };
  };

  async function transformInDev(relativePath: string, environment: string) {
    const plugins = islandsPlugin(PAGES_DIR);
    const islands = plugins[0] as IslandsPluginHooks;
    const hmr = plugins[1] as unknown as HmrPlugin;
    islands.configResolved?.({ root: TMP, command: 'serve', plugins: [] });
    await (islands.buildStart as () => Promise<void>).call({});
    return {
      hmr,
      result: hmr.transform.handler.call(
        { environment: { name: environment } },
        'export default function Component() {}',
        join(PAGES_DIR, relativePath),
      ),
    };
  }

  it('runs on the dev server only', async () => {
    writeCounterPage();
    const { hmr } = await transformInDev('Counter.tsx', 'client');

    expect(hmr.name).toBe('void-hono:islands-hmr');
    expect(hmr.apply).toBe('serve');
  });

  it('makes an island component accept its own updates in the browser', async () => {
    writeCounterPage();
    const { result } = await transformInDev('Counter.tsx', 'client');

    expect(result?.code).toContain('import.meta.hot.accept(');
    expect(result?.code).toContain('globalThis.__voidHonoIslands?.get("pages/Counter")');
    expect(result?.code).toContain('import.meta.hot.invalidate()');
  });

  it('leaves the worker module and other components unchanged', async () => {
    writeCounterPage();
    writeFile('Other.tsx', 'export default function Other() { return null; }');

    expect((await transformInDev('Counter.tsx', 'void_worker')).result).toBeUndefined();
    expect((await transformInDev('Other.tsx', 'client')).result).toBeUndefined();
  });
});

describe('islandsPlugin — renderer', () => {
  it.each([
    [true, 'isDev: true'],
    [false, 'isDev: false'],
  ])('renders island pages through the adapter runtime, dev=%s', async (dev, expected) => {
    writeCounterPage();

    const { buildStart, loadRenderer } = setupPlugin({ dev });
    await buildStart();
    const renderer = loadRenderer();

    expect(renderer).toContain('import { renderHonoIslandPage } from "@void/hono/pages-server"');
    expect(renderer).toContain('const __pagesNeedingClientJS = new Set(["index"]);');
    expect(renderer).toContain(expected);
  });
});
