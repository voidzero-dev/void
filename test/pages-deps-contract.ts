import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { optimizeDeps, resolveConfig, type Plugin } from 'vite';
import { expect, it } from 'vite-plus/test';

export function registerPagesDependencyTests(
  root: string,
  plugins: (pagesDir: string) => ReadonlyArray<Plugin>,
): void {
  it('prebundles the Pages client runtime before the first browser request', async () => {
    const directory = mkdtempSync(join(root, 'test', '__tmp_pages_deps_'));
    const pagesDir = join(directory, 'pages');
    mkdirSync(pagesDir);
    try {
      const config = await resolveConfig(
        {
          root: directory,
          configFile: false,
          logLevel: 'error',
          cacheDir: join(directory, '.vite'),
          plugins: [...plugins(pagesDir)],
          // The generated virtual client entry is absent from the initial dependency crawl.
          optimizeDeps: { noDiscovery: true },
        },
        'serve',
      );
      const metadata = await optimizeDeps(config, true, true);
      for (const dependency of ['void/pages-client', 'void/pages-prefetch']) {
        expect(metadata.optimized[dependency], dependency).toBeDefined();
        expect(existsSync(metadata.optimized[dependency].file)).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
