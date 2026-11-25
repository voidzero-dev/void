import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import {
  createIslandManifest,
  generateIslandClientEntry,
  hasIslandPages,
  ISLANDS_CLIENT_ENTRY_ID,
  ISLANDS_RENDERER_ID,
  watchPagesForRescan,
} from '../../src/pages/islands-plugin.ts';
import { scanPages } from '../../src/pages/scan.ts';
import type { PageScanResult } from '../../src/pages/types.ts';

const TMP = packageFixturePath(import.meta.dirname, '__tmp_pages_islands_rescan__');
const PAGES_DIR = join(TMP, 'pages');

function writePage(relativePath: string, source: string): string {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
  return full;
}

/** A dev server with file events and the virtual modules it has loaded. */
function fakeServer() {
  const watcher = new EventEmitter();
  const invalidated: Array<string> = [];
  const moduleGraph = {
    getModuleById: (id: string) => ({ id }),
    invalidateModule: (mod: { id: string }) => invalidated.push(mod.id),
  };
  const server = { watcher, environments: { client: { moduleGraph } } } as unknown as ViteDevServer;
  return { server, watcher, invalidated };
}

function setup(onRescan: (scan: PageScanResult) => void) {
  const { server, watcher, invalidated } = fakeServer();
  const { flush } = watchPagesForRescan(server, PAGES_DIR, TMP, onRescan);
  return {
    watcher,
    invalidated,
    /** Emit a watcher event, run the debounce timer, and return the scan promise. */
    emitAdd(path: string): Promise<void> {
      watcher.emit('add', path);
      vi.runAllTimers();
      return flush();
    },
  };
}

describe('watchPagesForRescan', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('keeps the last scan when a rescan fails and recovers on the next change', async () => {
    writePage('index.md', '# Home\n');
    const onRescan = vi.fn();
    const { emitAdd } = setup(onRescan);

    await expect(
      emitAdd(writePage('about.md', '---\nlayout: docs\n---\n# About\n')),
    ).resolves.toBeUndefined();
    expect(onRescan).not.toHaveBeenCalled();

    await emitAdd(writePage('_layouts/docs.vue', '<template><slot /></template>\n'));
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error thrown after a good scan', async () => {
    writePage('index.md', '# Home\n');
    const { emitAdd } = setup(() => {
      throw new Error('rescan failed');
    });

    await expect(emitAdd(writePage('about.md', '# About\n'))).rejects.toThrow('rescan failed');
  });

  it('keeps only dev pages', async () => {
    writePage('x.dev.island.tsx', 'export default () => null;');
    const onRescan = vi.fn();
    const { emitAdd } = setup(onRescan);

    await emitAdd(writePage('x.prod.island.tsx', 'export default () => null;'));
    const scan = onRescan.mock.calls[0][0] as PageScanResult;
    expect(scan.pages.map((page) => page.componentPath)).toEqual(['x.dev.island.tsx']);
  });

  it('regenerates the renderer when a page or layout changes', () => {
    const page = writePage('index.island.tsx', 'export default () => null;');
    const { watcher, invalidated } = setup(vi.fn());

    watcher.emit('change', join(TMP, 'components/Counter.tsx'));
    expect(invalidated).toEqual([]);

    // The renderer reads the page sources to decide which pages need client JS.
    watcher.emit('change', page);
    expect(invalidated).toEqual(['\0' + ISLANDS_RENDERER_ID]);
  });
});

describe('createIslandManifest in dev', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  function setupManifest() {
    const counter = writePage('../components/Counter.tsx', 'export default () => null;');
    const { server, watcher, invalidated } = fakeServer();
    const manifest = createIslandManifest(TMP, ['.tsx']);
    manifest.configureServer(server, PAGES_DIR);
    const entry = () =>
      generateIslandClientEntry({
        manifest,
        cssFiles: new Set(),
        styles: null,
        needsRuntime: true,
        isDev: true,
        hydrateIsland: '',
      });
    return { manifest, watcher, invalidated, counter, entry };
  }

  it('regenerates the client entry only when an island is new', () => {
    const { manifest, invalidated } = setupManifest();

    manifest.register('../components/Counter', PAGES_DIR, 'load');
    expect(invalidated).toEqual(['\0' + ISLANDS_CLIENT_ENTRY_ID]);

    manifest.register('../components/Counter', PAGES_DIR, 'idle');
    expect(invalidated).toHaveLength(1);
  });

  it('skips a deleted island and brings it back with its file', () => {
    const { manifest, watcher, invalidated, counter, entry } = setupManifest();
    manifest.register('../components/Counter', PAGES_DIR, 'load');
    invalidated.length = 0;

    watcher.emit('unlink', join(TMP, 'components/Other.tsx'));
    expect(invalidated).toEqual([]);

    rmSync(counter);
    watcher.emit('unlink', counter);
    expect(invalidated).toEqual(['\0' + ISLANDS_CLIENT_ENTRY_ID]);
    expect(entry()).not.toContain('components/Counter');

    writeFileSync(counter, 'export default () => null;');
    watcher.emit('add', counter);
    expect(invalidated).toHaveLength(2);
    expect(entry()).toContain('components/Counter');
  });

  it('records the islands of a Markdown page when it is saved', () => {
    const { watcher, invalidated, entry } = setupManifest();
    const page = writePage('index.md', '# Home\n');
    watcher.emit('add', page);
    expect(invalidated).toEqual([]);

    writePage(
      'index.md',
      '<script>\nimport Counter from "../components/Counter.tsx" with { island: "load" };\n</script>\n\n<Counter />\n',
    );
    watcher.emit('change', page);
    expect(invalidated).toEqual(['\0' + ISLANDS_CLIENT_ENTRY_ID]);
    expect(entry()).toContain('components/Counter');
  });

  it('skips a page deleted before its islands are read', async () => {
    const { manifest, watcher } = setupManifest();
    const page = writePage('index.md', '# Home\n');
    const scan = await scanPages(TMP, { pagesDir: PAGES_DIR, environment: 'dev' });
    rmSync(page);

    expect(() => manifest.registerPages(scan, PAGES_DIR)).not.toThrow();
    expect(() => watcher.emit('change', page)).not.toThrow();
  });
});

describe('hasIslandPages', () => {
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('counts only the island pages a build keeps', async () => {
    writePage('index.tsx', 'export default () => null;');
    writePage('x.dev.island.tsx', 'export default () => null;');
    expect(await hasIslandPages(TMP, PAGES_DIR)).toBe(false);

    writePage('y.prod.island.tsx', 'export default () => null;');
    expect(await hasIslandPages(TMP, PAGES_DIR)).toBe(true);
  });
});
