import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { pagesPlugin as reactPagesPlugin } from '../../../react/src/plugin-pages.ts';
import { pagesPlugin as solidPagesPlugin } from '../../../solid/src/plugin-pages.ts';
import { pagesPlugin as sveltePagesPlugin } from '../../../svelte/src/plugin-pages.ts';
import { pagesPlugin as vuePagesPlugin } from '../../../vue/src/plugin-pages.ts';

type Hook<T> = T | { handler: T; filter?: { id: RegExp } };
type PagesPluginHooks = {
  config: Hook<(config: object, env: { command: 'serve' | 'build' }) => unknown>;
  configResolved: (config: { publicDir: string | false }) => void;
  buildStart: Hook<() => Promise<void>>;
  resolveId: Hook<(id: string) => string | undefined>;
  load: Hook<(id: string) => Promise<string | undefined>>;
  configureServer: (server: unknown) => void;
};

function handler<T>(hook: Hook<T>): T {
  return typeof hook === 'object' && hook !== null && 'handler' in hook ? hook.handler : hook;
}

const adapters = [
  { name: 'react', extension: 'tsx', create: reactPagesPlugin, scansBuild: true },
  { name: 'solid', extension: 'tsx', create: solidPagesPlugin, scansBuild: true },
  { name: 'svelte', extension: 'svelte', create: sveltePagesPlugin, scansBuild: false },
  { name: 'vue', extension: 'vue', create: vuePagesPlugin, scansBuild: false },
];

describe.each(adapters)('$name Pages plugin contract', (adapter) => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
    root = undefined;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), `void-${adapter.name}-pages-plugin-`));
    const pagesDir = join(root, '_source', '_views');
    const plugins = adapter.create(pagesDir, {
      root,
      viewTransitions: true,
      prefetch: { hoverDelay: 123, cacheFor: '45s' },
    });
    const plugin = (Array.isArray(plugins) ? plugins : [plugins]).find(
      (candidate: Plugin) => candidate.name === `void-${adapter.name}:pages`,
    ) as unknown as PagesPluginHooks;
    function write(file: string, source = ''): string {
      const path = join(pagesDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
      return path;
    }
    return { plugin, pagesDir, write };
  }

  it.each([
    ['island only', undefined, false, false],
    ['Markdown', 'about.md', false, false],
    ['ordinary page', 'about.$ext', true, true],
    ['dev-only page', 'debug.dev.$ext', false, true],
    ['private directory', '_private/helper.$ext', false, true],
    ['layout-prefixed page', 'layout.extra.$ext', true, false],
    ['island-like page name', 'feature.island.demo.$ext', true, false],
    ['foreign component', 'other.$foreign', true, false],
  ])('preserves client build selection for %s', async (_, file, scanned, filenames) => {
    const { plugin, write } = setup();
    write(`index.island.${adapter.extension}`);
    if (file) {
      write(
        file
          .replace('$ext', adapter.extension)
          .replace('$foreign', adapter.name === 'vue' ? 'svelte' : 'vue'),
      );
    }

    const config = await handler(plugin.config)({}, { command: 'build' });
    if (adapter.scansBuild ? scanned : filenames) {
      const clientConfig = {
        build: {
          manifest: true,
          rollupOptions: { input: { 'pages-client': 'virtual:void-pages-client' } },
        },
      };
      expect(config).toEqual(
        adapter.name === 'vue'
          ? { environments: { client: clientConfig } }
          : adapter.name === 'react'
            ? { ...clientConfig, resolve: { dedupe: ['react', 'react-dom'] } }
            : clientConfig,
      );
    } else {
      expect(config).toBeUndefined();
    }
  });

  it('resolves only the Pages virtual module IDs', async () => {
    const { plugin } = setup();
    const hook = plugin.resolveId as { filter: { id: RegExp } };
    for (const id of ['virtual:void-pages-renderer', 'virtual:void-pages-client']) {
      expect(hook.filter.id.test(id)).toBe(true);
      expect(handler(plugin.resolveId)(id)).toBe('\0' + id);
    }
    expect(hook.filter.id.test('virtual:void-islands-renderer')).toBe(false);
    expect(hook.filter.id.test('virtual:void-pages-client-extra')).toBe(false);
    await expect(handler(plugin.load)('\0virtual:unrelated')).resolves.toBeUndefined();
  });

  it('handles a missing directory and lazily scans pages created after config', async () => {
    const { plugin, write } = setup();
    expect(await handler(plugin.config)({}, { command: 'serve' })).toBeUndefined();
    expect(await handler(plugin.load)('\0virtual:void-pages-renderer')).toBe(
      "export function renderPage() { throw new Error('No pages found'); }",
    );
    expect(await handler(plugin.load)('\0virtual:void-pages-client')).toBe('');

    write(`debug.dev.${adapter.extension}`);
    write(`home.prod.${adapter.extension}`);
    const renderer = await handler(plugin.load)('\0virtual:void-pages-renderer');
    expect(renderer).toContain(`debug.dev.${adapter.extension}`);
    expect(renderer).not.toContain('home.prod');
    if (adapter.name === 'react') {
      expect(renderer).toContain('/@react-refresh');
    }
  });

  it('passes client options and resolved publicDir into generated modules', async () => {
    const { plugin, write } = setup();
    write(`index.${adapter.extension}`);
    writeFileSync(join(root!, 'void.config.ts'), 'export default { output: "static" };');
    const publicDir = join(root!, 'custom-public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, '_redirects'), '/old /new 302');
    await handler(plugin.config)({}, { command: 'build' });
    plugin.configResolved({ publicDir });
    await handler(plugin.buildStart)();

    const client = await handler(plugin.load)('\0virtual:void-pages-client');
    expect(client).toContain('staticPageData: true');
    expect(client).toContain('staticPageDataFastPath: false');
    expect(client).toContain('viewTransitions: true');
    expect(client).toContain('prefetchHoverDelay: 123');
    expect(client).toContain('parseCacheFor("45s")');

    plugin.configResolved({ publicDir: false });
    expect(await handler(plugin.load)('\0virtual:void-pages-client')).toContain(
      'staticPageDataFastPath: true',
    );
  });

  it('rescans structural and Markdown changes, invalidating both modules in every environment', async () => {
    const { plugin, pagesDir, write } = setup();
    write(`index.${adapter.extension}`);
    await handler(plugin.config)({}, { command: 'serve' });
    await handler(plugin.buildStart)();
    const events = new Map<string, (path: string) => Promise<void>>();
    const moduleIds = ['\0virtual:void-pages-renderer', '\0virtual:void-pages-client'];
    const invalidations = [vi.fn(), vi.fn()];
    plugin.configureServer({
      watcher: {
        on(event: string, callback: (path: string) => Promise<void>) {
          return events.set(event, callback);
        },
      },
      environments: Object.fromEntries(
        ['client', 'void_worker'].map((name, index) => [
          name,
          {
            moduleGraph: {
              getModuleById(id: string) {
                return { id };
              },
              invalidateModule: invalidations[index],
            },
          },
        ]),
      ),
      config: { logger: { error: vi.fn() } },
    });

    const added = write(`added.${adapter.extension}`);
    await events.get('add')!(join(pagesDir + '-other', 'outside.md'));
    await events.get('change')!(added);
    for (const invalidate of invalidations) {
      expect(invalidate).not.toHaveBeenCalled();
    }

    await events.get('add')!(added);
    for (const invalidate of invalidations) {
      expect(invalidate.mock.calls.map(([module]) => module.id)).toEqual(moduleIds);
      invalidate.mockClear();
    }
    expect(await handler(plugin.load)(moduleIds[0])).toContain(`added.${adapter.extension}`);
    expect(await handler(plugin.load)(moduleIds[1])).toContain(`added.${adapter.extension}`);

    const markdown = write('about.md', '# About');
    await events.get('change')!(markdown);
    expect(await handler(plugin.load)(moduleIds[0])).toContain('about.md');
    for (const invalidate of invalidations) {
      expect(invalidate).toHaveBeenCalledTimes(2);
    }

    rmSync(added);
    await events.get('unlink')!(added);
    expect(await handler(plugin.load)(moduleIds[0])).not.toContain(`added.${adapter.extension}`);
    expect(await handler(plugin.load)(moduleIds[1])).not.toContain(`added.${adapter.extension}`);
  });
});
