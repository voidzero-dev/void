import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPagesPlugin } from '../../src/pages/plugin.ts';
import { scanPages } from '../../src/pages/scan.ts';
import type { PageScanResult } from '../../src/pages/types.ts';

vi.mock('../../src/pages/scan.ts', () => ({ scanPages: vi.fn() }));

type Hook<T> = T | { handler: T };
type PagesPluginHooks = {
  buildStart: Hook<() => Promise<void>>;
  config: (config: object, env: { command: 'serve' | 'build' }) => unknown;
  load: Hook<(id: string) => Promise<string | undefined>>;
  configureServer: (server: unknown) => void;
};

function handler<T>(hook: Hook<T>): T {
  return typeof hook === 'object' && hook !== null && 'handler' in hook ? hook.handler : hook;
}

function scanWithLayout(filePath: string): PageScanResult {
  return { pages: [], layouts: [{ directory: '', filePath }], namedLayouts: [] };
}

function pendingScan() {
  let resolve!: (scan: PageScanResult) => void;
  const promise = new Promise<PageScanResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('shared Pages plugin scan lifecycle', () => {
  let root: string;
  let pagesDir: string;

  beforeEach(() => {
    vi.mocked(scanPages).mockReset();
    root = mkdtempSync(join(tmpdir(), 'void-pages-plugin-'));
    pagesDir = join(root, 'pages');
    mkdirSync(pagesDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    return createPagesPlugin(pagesDir, {
      name: 'test:pages',
      generateRenderer(scan) {
        return JSON.stringify(scan.layouts);
      },
      generateClient(scan) {
        return JSON.stringify(scan.layouts);
      },
      config() {},
    }) as unknown as PagesPluginHooks;
  }

  it('shares a pending scan between buildStart and simultaneous lazy module loads', async () => {
    const pending = pendingScan();
    vi.mocked(scanPages).mockReturnValueOnce(pending.promise);
    const plugin = setup();
    plugin.config({}, { command: 'serve' });

    const build = handler(plugin.buildStart)();
    const renderer = handler(plugin.load)('\0virtual:void-pages-renderer');
    const client = handler(plugin.load)('\0virtual:void-pages-client');
    expect(scanPages).toHaveBeenCalledExactlyOnceWith(root, { pagesDir, environment: 'dev' });

    pending.resolve(scanWithLayout('layout.tsx'));
    await build;
    await expect(renderer).resolves.toContain('layout.tsx');
    await expect(client).resolves.toContain('layout.tsx');
    expect(scanPages).toHaveBeenCalledTimes(1);
  });

  it('waits for a watcher rescan before serving either dev module', async () => {
    vi.mocked(scanPages).mockResolvedValueOnce(scanWithLayout('before.tsx'));
    const plugin = setup();
    plugin.config({}, { command: 'serve' });
    await handler(plugin.buildStart)();

    const events = new Map<string, (path: string) => Promise<void>>();
    plugin.configureServer({
      watcher: {
        on(event: string, callback: (path: string) => Promise<void>) {
          return events.set(event, callback);
        },
      },
      environments: {},
      config: { logger: { error: vi.fn() } },
    });
    const pending = pendingScan();
    vi.mocked(scanPages).mockReturnValueOnce(pending.promise);
    const change = events.get('add')!(join(pagesDir, 'added.tsx'));
    const renderer = handler(plugin.load)('\0virtual:void-pages-renderer');
    const client = handler(plugin.load)('\0virtual:void-pages-client');

    pending.resolve(scanWithLayout('after.tsx'));
    await change;
    await expect(renderer).resolves.toContain('after.tsx');
    await expect(client).resolves.toContain('after.tsx');
    expect(scanPages).toHaveBeenCalledTimes(2);
  });

  it('propagates build scan errors and allows a later lazy load to retry', async () => {
    const failure = new Error('Invalid page layout');
    vi.mocked(scanPages).mockRejectedValueOnce(failure);
    const plugin = setup();
    plugin.config({}, { command: 'build' });
    await expect(handler(plugin.buildStart)()).rejects.toBe(failure);

    vi.mocked(scanPages).mockResolvedValueOnce(scanWithLayout('recovered.tsx'));
    await expect(handler(plugin.load)('\0virtual:void-pages-renderer')).resolves.toContain(
      'recovered.tsx',
    );
    expect(scanPages).toHaveBeenLastCalledWith(root, { pagesDir, environment: 'prod' });
    expect(scanPages).toHaveBeenCalledTimes(2);
  });

  it('drops a previous scan when the pages directory is removed', async () => {
    vi.mocked(scanPages).mockResolvedValueOnce(scanWithLayout('removed.tsx'));
    const plugin = setup();
    await handler(plugin.buildStart)();
    rmSync(pagesDir, { recursive: true });
    await handler(plugin.buildStart)();

    await expect(handler(plugin.load)('\0virtual:void-pages-client')).resolves.toBe('');
    await expect(handler(plugin.load)('\0virtual:void-pages-renderer')).resolves.not.toContain(
      'removed.tsx',
    );
    expect(scanPages).toHaveBeenCalledTimes(1);
  });
});
