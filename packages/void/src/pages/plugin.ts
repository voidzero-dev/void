import { existsSync } from 'node:fs';
import { dirname } from 'pathslash';
import { normalizePath, type Plugin, type ResolvedConfig, type UserConfig } from 'vite';
import { scanPages } from './scan.ts';
import {
  resolveStaticPageDataBuildOptions,
  type StaticPageDataBuildOptions,
} from './static-data.ts';
import type { PageScanResult } from './types.ts';

const RENDERER_ID = 'virtual:void-pages-renderer';
const CLIENT_ENTRY_ID = 'virtual:void-pages-client';

type PagesPluginContext = {
  isDev: boolean;
  scan: () => Promise<PageScanResult | null>;
};

type PagesPluginOptions = {
  name: string;
  root?: string;
  generateRenderer: (scan: PageScanResult, isDev: boolean) => string;
  generateClient: (scan: PageScanResult, staticPageData: StaticPageDataBuildOptions) => string;
  config: (context: PagesPluginContext) => UserConfig | void | Promise<UserConfig | void>;
};

/** Shared Vite lifecycle; adapters own their generated code and environment configuration. */
export function createPagesPlugin(pagesDir: string, options: PagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  let viteConfig: ResolvedConfig | undefined;
  const root = options.root ?? dirname(pagesDir);
  const normalizedPagesDir = normalizePath(pagesDir);
  let pendingRescan: Promise<void> | null = null;
  async function rescanPages(): Promise<void> {
    pageScan = existsSync(pagesDir)
      ? await scanPages(root, { pagesDir, environment: isDev ? 'dev' : 'prod' })
      : null;
  }

  function runRescan(): Promise<void> {
    pendingRescan ??= rescanPages().finally(() => {
      pendingRescan = null;
    });
    return pendingRescan;
  }

  return {
    name: options.name,

    async buildStart() {
      await runRescan();
    },

    resolveId: {
      filter: { id: /^virtual:void-pages-(renderer|client)$/ },
      handler(id) {
        return '\0' + id;
      },
    },

    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void-pages-(renderer|client)$/ },
      async handler(id) {
        if (isDev && pendingRescan) {
          await pendingRescan;
        }
        if (!pageScan && existsSync(pagesDir)) {
          await runRescan();
        }
        if (id === '\0' + RENDERER_ID) {
          if (!pageScan) {
            return "export function renderPage() { throw new Error('No pages found'); }";
          }
          return options.generateRenderer(pageScan, isDev);
        }
        if (id === '\0' + CLIENT_ENTRY_ID) {
          if (!pageScan) {
            return '';
          }
          return options.generateClient(
            pageScan,
            resolveStaticPageDataBuildOptions(root, { publicDir: viteConfig?.publicDir }),
          );
        }
      },
    },

    configureServer(server) {
      async function handlePagesChange(
        path: string,
        event: 'add' | 'change' | 'unlink',
      ): Promise<void> {
        const normalizedPath = normalizePath(path);
        if (
          normalizedPath !== normalizedPagesDir &&
          !normalizedPath.startsWith(normalizedPagesDir + '/')
        ) {
          return;
        }
        if (event === 'change' && !normalizedPath.endsWith('.md')) {
          return;
        }
        try {
          await runRescan();
        } catch (error) {
          // Keep the last good scan; the next change rescans.
          server.config.logger.error(error instanceof Error ? error.message : String(error), {
            error: error instanceof Error ? error : undefined,
            timestamp: true,
          });
          return;
        }
        for (const env of Object.values(server.environments)) {
          for (const id of ['\0' + RENDERER_ID, '\0' + CLIENT_ENTRY_ID]) {
            const mod = env.moduleGraph.getModuleById(id);
            if (mod) {
              env.moduleGraph.invalidateModule(mod);
            }
          }
        }
      }

      server.watcher.on('add', (path) => handlePagesChange(path, 'add'));
      server.watcher.on('change', (path) => handlePagesChange(path, 'change'));
      server.watcher.on('unlink', (path) => handlePagesChange(path, 'unlink'));
    },

    configResolved(config) {
      viteConfig = config;
    },

    config(_, env) {
      // Set before the early return: pages/ may be created after the server starts.
      isDev = env.command === 'serve';
      if (!existsSync(pagesDir)) {
        return;
      }
      return options.config({
        isDev,
        async scan() {
          await runRescan();
          return pageScan;
        },
      });
    },
  };
}
