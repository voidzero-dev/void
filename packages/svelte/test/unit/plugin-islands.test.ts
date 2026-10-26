import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { compile } from 'svelte/compiler';
import { build, normalizePath, type Rolldown } from 'vite';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const TMP = join(import.meta.dirname, '__tmp_islands_plugin__');
const PAGES_DIR = join(TMP, 'pages');
type HookWithHandler<T> = { handler: T };
type IslandsPluginHooks = {
  configResolved?: (config: {
    root: string;
    command: 'build';
    plugins: ReadonlyArray<unknown>;
  }) => void;
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  load?: ((id: string) => string | undefined) | HookWithHandler<(id: string) => string | undefined>;
};

function writeFile(relativePath: string, content: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function setupPlugin() {
  const plugins = islandsPlugin(PAGES_DIR);
  const plugin = plugins[0] as IslandsPluginHooks;

  const config = { root: TMP, command: 'build' as const, plugins: [] };
  plugin.configResolved?.(config);

  return {
    async buildStart() {
      if (typeof plugin.buildStart === 'function') {
        await plugin.buildStart.call({});
      } else {
        await plugin.buildStart?.handler.call({});
      }
    },
    loadClientEntry(): string | undefined {
      if (typeof plugin.load === 'function') {
        return plugin.load('\0virtual:void-islands-client');
      }
      return plugin.load?.handler('\0virtual:void-islands-client');
    },
  };
}

describe('islandsPlugin — layout island import scanning', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('pre-scans island imports from island layouts into the manifest', async () => {
    writeFile(
      'blog/layout.island.svelte',
      `<script>
import Counter from "../_components/Counter.svelte" with { island: "load" }
</script>
<Counter /><slot />`,
    );
    writeFile('blog/index.island.svelte', `<p>Blog</p>`);
    writeFile(
      '_components/Counter.svelte',
      `<script>let count = $state(0)</script>
<button onclick={() => count++}>{count}</button>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Counter');
  });

  it('pre-scans island imports from island pages into the manifest', async () => {
    writeFile(
      'index.island.svelte',
      `<script>
import Toggle from "./Toggle.svelte" with { island: "idle" }
</script>
<Toggle />`,
    );
    writeFile(
      'Toggle.svelte',
      `<script>let on = $state(false)</script>
<button onclick={() => on = !on}>{on}</button>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/Toggle');
  });

  it('includes island imports from both pages and layouts', async () => {
    writeFile(
      'app/layout.island.svelte',
      `<script>
import Nav from "../_components/Nav.svelte" with { island: "load" }
</script>
<Nav /><slot />`,
    );
    writeFile(
      'app/index.island.svelte',
      `<script>
import Widget from "../_components/Widget.svelte" with { island: "idle" }
</script>
<Widget />`,
    );
    writeFile('_components/Nav.svelte', `<nav>Nav</nav>`);
    writeFile('_components/Widget.svelte', `<div>Widget</div>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Nav');
    expect(clientEntry).toContain('pages/_components/Widget');
  });

  it('pre-scans island imports from named island layouts into the manifest', async () => {
    writeFile(
      '_layouts/sidebar.island.svelte',
      `<script>
import Clock from "../_components/Clock.svelte" with { island: "load" }
</script>
<Clock /><slot />`,
    );
    writeFile('_components/Clock.svelte', `<span>12:00</span>`);
    writeFile(
      'index.island.svelte',
      `<script context="module">
export const layout = "sidebar"
</script>
<p>Home</p>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Clock');
  });

  it('skips non-island layouts during pre-scan', async () => {
    writeFile(
      'layout.svelte',
      `<script>
import Sidebar from "./Sidebar.svelte" with { island: "load" }
</script>
<slot />`,
    );
    writeFile('index.island.svelte', `<p>Home</p>`);
    writeFile('Sidebar.svelte', `<aside>Sidebar</aside>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).not.toContain('Sidebar');
  });
});

describe('islandsPlugin — island style loader', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('bundles the scoped CSS of island pages and their layouts', async () => {
    // Island pages and their layouts render only on the server, so they may
    // import packages the client build cannot resolve.
    const serverOnlyDir = join(TMP, 'node_modules', 'server-only-pkg');
    mkdirSync(serverOnlyDir, { recursive: true });
    writeFileSync(
      join(serverOnlyDir, 'package.json'),
      JSON.stringify({
        name: 'server-only-pkg',
        type: 'module',
        exports: { '.': { node: './index.js', workerd: './index.js' } },
      }),
    );
    writeFileSync(join(serverOnlyDir, 'index.js'), 'export const label = "Nav";');
    const layout = `<script>import { label } from 'server-only-pkg'; let { children } = $props();</script>
<nav>{label}</nav>
{@render children()}
<style>nav { padding: 8px; }</style>`;
    const page = `<script>import { label } from 'server-only-pkg';</script>
<p>{label}</p>
<style>p { color: red; } :global(body) { margin: 0; }</style>`;
    writeFile('layout.svelte', layout);
    writeFile('index.island.svelte', page);

    const output = (await build({
      root: TMP,
      configFile: false,
      logLevel: 'silent',
      plugins: [svelte(), ...islandsPlugin(PAGES_DIR, { root: TMP })],
      build: { write: false, rollupOptions: { external: ['void/pages-client'] } },
    })) as Rolldown.RolldownOutput;
    const css = output.output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => String((item as Rolldown.OutputAsset).source))
      .join('');

    const scopeOf = (source: string, file: string) =>
      /svelte-[a-z0-9]+/.exec(
        compile(source, { filename: normalizePath(join(PAGES_DIR, file)), generate: 'server' }).js
          .code,
      )![0];
    expect(css).toContain(`nav.${scopeOf(layout, 'layout.svelte')}{padding:8px}`);
    expect(css).toContain(`p.${scopeOf(page, 'index.island.svelte')}{color:red}`);
    expect(css).toContain('body{margin:0}');
  });

  it('watches files the style preprocessor reads', async () => {
    const partial = join(PAGES_DIR, '_theme.css');
    writeFile('_theme.css', 'nav { padding: 8px; }');
    writeFile(
      'layout.svelte',
      `<script>let { children } = $props();</script>
<nav>Nav</nav>
{@render children()}
<style>nav { margin: 0; }</style>`,
    );
    writeFile('index.island.svelte', '<p>Home</p>');

    const watched: Array<string> = [];
    const plugins = islandsPlugin(PAGES_DIR, { root: TMP });
    const stylePlugin = plugins.find((plugin) => plugin.name === 'void-svelte:islands-style')!;
    const load = stylePlugin.load as HookWithHandler<
      (this: Rolldown.PluginContext, id: string) => unknown
    >;
    const handler = load.handler;
    load.handler = function (id) {
      const context = new Proxy(this, {
        get(target, key) {
          if (key === 'addWatchFile') {
            return (file: string) => {
              watched.push(normalizePath(file));
              target.addWatchFile(file);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return handler.call(context, id);
    };

    await build({
      root: TMP,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        svelte({
          preprocess: {
            style: ({ content }) => ({ code: content, dependencies: [partial] }),
          },
        }),
        ...plugins,
      ],
      build: { write: false, rollupOptions: { external: ['void/pages-client'] } },
    });

    expect(watched).toContain(normalizePath(partial));
  });
});

describe('islandsPlugin — environment suffixes', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('registers no .dev island page in a build', async () => {
    writeFile(
      'x.dev.island.svelte',
      `<script>
import Toggle from "./Toggle.svelte" with { island: "load" }
</script>
<Toggle />`,
    );
    writeFile('Toggle.svelte', `<button>Toggle</button>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();

    expect(loadClientEntry()).not.toContain('pages/Toggle');
  });

  it('registers the .prod island page of a .dev + .prod pair in a build', async () => {
    writeFile(
      'x.dev.island.svelte',
      `<script>
import Toggle from "./Toggle.svelte" with { island: "load" }
</script>
<Toggle />`,
    );
    writeFile(
      'x.prod.island.svelte',
      `<script>
import Counter from "./Counter.svelte" with { island: "load" }
</script>
<Counter />`,
    );
    writeFile('Toggle.svelte', `<button>Toggle</button>`);
    writeFile('Counter.svelte', `<button>Counter</button>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toContain('pages/Counter');
    expect(clientEntry).not.toContain('pages/Toggle');
  });
});
