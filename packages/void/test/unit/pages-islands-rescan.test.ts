import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hasIslandPages, watchPagesForRescan } from '../../src/pages/islands-plugin.ts';
import type { PageScanResult } from '../../src/pages/types.ts';

const TMP = join(import.meta.dirname, '__tmp_pages_islands_rescan__');
const PAGES_DIR = join(TMP, 'pages');

function writePage(relativePath: string, source: string): string {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, source);
  return full;
}

function setup(onRescan: (scan: PageScanResult) => void) {
  const watcher = new EventEmitter();
  const server = { watcher, environments: {} } as unknown as ViteDevServer;
  const { flush } = watchPagesForRescan(server, PAGES_DIR, TMP, onRescan);
  return {
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
    const scan = onRescan.mock.calls[0]![0] as PageScanResult;
    expect(scan.pages.map((page) => page.componentPath)).toEqual(['x.dev.island.tsx']);
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
