import { existsSync, readdirSync } from 'node:fs';
import { dirname, relative } from 'pathslash';
import { normalizePath, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import {
  generateComponentManifest,
  resolveStaticPageDataBuildOptions,
  scanPages,
} from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';

const RENDERER_ID = 'virtual:void-pages-renderer';
const CLIENT_ENTRY_ID = 'virtual:void-pages-client';
const WORKER_ENVIRONMENT_NAME = 'void_worker';
const REACT_DEDUPE = ['react', 'react-dom'];
const REACT_OPTIMIZE_DEPS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'react-dom/server',
];
const WORKER_OPTIMIZE_DEPS = [...REACT_OPTIMIZE_DEPS, 'void/live/client'];

// SSR HTML bypasses transformIndexHtml, so @vitejs/plugin-react cannot inject
// its Fast Refresh preamble. Without it, the dev client entry fails to load.
export const REACT_REFRESH_PREAMBLE = `
<script type="module">
  import RefreshRuntime from "/@react-refresh"
  RefreshRuntime.injectIntoGlobalHook(window)
  window.$RefreshReg$ = () => {}
  window.$RefreshSig$ = () => (type) => type
  window.__vite_plugin_react_preamble_installed__ = true
</script>`;

export type PrefetchConfig = {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
};

type PagesPluginOptions = {
  root?: string;
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
};

/** Check if the pages directory has any non-island page files (.tsx/.jsx without .island.). */
function hasNonIslandPages(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) {
        continue;
      }
      const name = entry.name;
      if (name.startsWith('_') || name.startsWith('layout.')) {
        continue;
      }
      if (/\.(tsx|jsx)$/.test(name) && !name.includes('.island.')) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  let pageScan: PageScanResult | null = null;
  let isDev = false;
  let viteConfig: ResolvedConfig | undefined;
  const root = options?.root ?? dirname(pagesDir);
  const normalizedPagesDir = normalizePath(pagesDir);
  const pagesOptimizeEntries = `${relative(root, pagesDir)}/**/*.{js,jsx,ts,tsx}`;
  let pendingRescan: Promise<void> | null = null;
  const rescanPages = async () => {
    pageScan = existsSync(pagesDir) ? await scanPages(root, { pagesDir }) : null;
  };
  const runRescan = () => {
    pendingRescan ??= rescanPages().finally(() => {
      pendingRescan = null;
    });
    return pendingRescan;
  };

  const invalidatePageModules = (server: ViteDevServer) => {
    for (const env of Object.values(server.environments)) {
      for (const id of ['\0' + RENDERER_ID, '\0' + CLIENT_ENTRY_ID]) {
        const mod = env.moduleGraph.getModuleById(id);
        if (mod) {
          env.moduleGraph.invalidateModule(mod);
        }
      }
    }
  };

  return {
    name: 'void-react:pages',

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
          return generateRendererModule(pageScan, pagesDir, isDev);
        }
        if (id === '\0' + CLIENT_ENTRY_ID) {
          if (!pageScan) {
            return '';
          }
          return generateClientEntry(
            pageScan,
            pagesDir,
            options?.viewTransitions,
            options?.prefetch,
            resolveStaticPageDataBuildOptions(root, { publicDir: viteConfig?.publicDir }),
          );
        }
      },
    },

    configureServer(server) {
      const handlePagesChange = async (path: string, event: 'add' | 'change' | 'unlink') => {
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
        invalidatePageModules(server);
      };

      server.watcher.on('add', (path) => handlePagesChange(path, 'add'));
      server.watcher.on('change', (path) => handlePagesChange(path, 'change'));
      server.watcher.on('unlink', (path) => handlePagesChange(path, 'unlink'));
    },

    configResolved(config) {
      viteConfig = config;
    },

    config(_, env) {
      if (!existsSync(pagesDir)) {
        return;
      }

      // In dev mode, exclude @void/react from dep optimization so the
      // virtual module and user components share the same React context objects.
      // Without this, Vite pre-bundles @void/react, creating separate
      // context instances that break useContext (React contexts use object identity).
      if (env.command === 'serve') {
        isDev = true;
        return {
          resolve: {
            dedupe: REACT_DEDUPE,
          },
          optimizeDeps: {
            exclude: ['@void/react'],
            // Pre-include React entries that are discovered late via dynamic
            // imports during SPA navigation, avoiding a full-page reload
            // from Vite's dep optimizer.
            include: REACT_OPTIMIZE_DEPS,
          },
          ssr: {
            optimizeDeps: {
              include: REACT_OPTIMIZE_DEPS,
            },
          },
          environments: {
            [WORKER_ENVIRONMENT_NAME]: {
              optimizeDeps: {
                exclude: ['@void/react'],
                // Crawl page/layout modules before the first Worker request.
                // If the worker optimizer discovers React component deps while
                // SSR is already rendering, the program reload can mix React
                // and react-dom/server from different optimized-dep hashes.
                entries: [pagesOptimizeEntries],
                include: WORKER_OPTIMIZE_DEPS,
              },
            },
          },
        };
      }

      // Skip the pages-client bundle when all pages are island pages
      if (!hasNonIslandPages(pagesDir)) {
        return;
      }

      return {
        resolve: {
          dedupe: REACT_DEDUPE,
        },
        build: {
          manifest: true,
          rollupOptions: {
            input: { 'pages-client': CLIENT_ENTRY_ID },
          },
        },
      };
    },
  };
}

function generateRendererModule(scan: PageScanResult, pagesDir: string, isDev: boolean): string {
  const preambleScript = isDev ? REACT_REFRESH_PREAMBLE : '';

  return `
import { renderReactPage } from "@void/react/pages-server";

${generateComponentManifest(scan, pagesDir)}

	const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};
	
	export async function renderPage(pageObj, assetTags) {
	  return renderReactPage({
	    pageObj,
	    assetTags,
	    components,
	    layoutTree,
	    preambleScript: PREAMBLE_SCRIPT,
	  });
}
renderPage.preambleScript = PREAMBLE_SCRIPT;
`;
}

function generateClientEntry(
  scan: PageScanResult,
  pagesDir: string,
  viewTransitions?: boolean,
  prefetch?: PrefetchConfig,
  staticPageData?: StaticPageDataBuildOptions,
): string {
  return `
	import { startReactPages } from "@void/react/pages-client";
	import { parseCacheFor } from "void/pages-prefetch";
	
	${generateComponentManifest(scan, pagesDir)}

	const { router } = await startReactPages({
	  components,
	  layoutTree,
	  routeMeta,
	  matchRoute,
	  staticPageData: ${!!staticPageData?.enabled},
	  staticPageDataFastPath: ${!!staticPageData?.fastPath},
	  viewTransitions: ${!!viewTransitions},
	  prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
	  prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
	});
	export { router };
	`;
}
