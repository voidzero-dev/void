import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'pathslash';
import type { Plugin } from 'vite';
import {
  createPagesPlugin,
  generateComponentManifest,
  resolveEffectiveLayoutChain,
  resolvePrefetchConfig,
} from 'void/pages';
import type {
  PageScanResult,
  PagesPluginOptions,
  PrefetchConfig,
  StaticPageDataBuildOptions,
} from 'void/pages';
import { findIslandImports, resolveSpecifier } from 'void/pages-islands-plugin';

export type { PrefetchConfig } from 'void/pages';

const CLIENT_ENTRY_ID = 'virtual:void-pages-client';
const WORKER_ENVIRONMENT_NAME = 'void_worker';
const REACT_DEDUPE = ['react', 'react-dom'];
const REACT_OPTIMIZE_DEPS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom'];
const CLIENT_OPTIMIZE_DEPS = [...REACT_OPTIMIZE_DEPS, 'react-dom/client'];
const WORKER_OPTIMIZE_DEPS = [...REACT_OPTIMIZE_DEPS, 'react-dom/server'];
const NODE_MODULES_SEGMENT = /[\\/]node_modules[\\/]/;

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

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  const root = options?.root ?? dirname(pagesDir);
  const pagesOptimizeEntries = `${relative(root, pagesDir)}/**/*.{js,jsx,ts,tsx}`;
  return createPagesPlugin(pagesDir, {
    name: 'void-react:pages',
    root,
    generateRenderer(scan, isDev) {
      return generateRendererModule(scan, pagesDir, isDev);
    },
    generateClient(scan, staticPageData) {
      return generateClientEntry(
        scan,
        pagesDir,
        options?.viewTransitions,
        options?.prefetch,
        staticPageData,
      );
    },
    async config({ isDev, scan }) {
      // In dev mode, exclude @void/react from dep optimization so the
      // virtual module and user components share the same React context objects.
      // Without this, Vite pre-bundles @void/react, creating separate
      // context instances that break useContext (React contexts use object identity).
      if (isDev) {
        return {
          resolve: {
            dedupe: REACT_DEDUPE,
          },
          optimizeDeps: {
            exclude: ['@void/react'],
            // Crawl page modules before the first client request so third-party
            // imports are pre-bundled instead of triggering a full reload.
            entries: clientOptimizeEntries(await scan(), pagesDir, root),
            // Pre-include React entries that are discovered late via dynamic
            // imports during SPA navigation, avoiding a full-page reload
            // from Vite's dep optimizer. void/pages-client and
            // void/pages-prefetch are reached only through virtual entries and
            // the excluded @void/react, so the scanner cannot see them.
            include: [
              ...CLIENT_OPTIMIZE_DEPS,
              ...installedDependencies(['void/pages-client', 'void/pages-prefetch']),
            ],
          },
          ssr: {
            optimizeDeps: {
              include: [...CLIENT_OPTIMIZE_DEPS, 'react-dom/server'],
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
                include: [...WORKER_OPTIMIZE_DEPS, ...installedDependencies(['void/live/client'])],
              },
            },
          },
        };
      }

      // Skip the pages-client bundle when all pages are island pages
      const pageScan = await scan();
      if (!pageScan?.pages.some((page) => !page.island)) {
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
  });
}

/**
 * Keeps the specifiers that resolve into `node_modules`. Vite serves a linked
 * package, such as `void` in a workspace, as source unless
 * `optimizeDeps.include` lists it. A listed linked package is pre-bundled into
 * a cache keyed by the lockfile and config rather than the package's files, so
 * dev would keep serving that copy after the package is rebuilt. A client built
 * against the new exports then fails to load and never hydrates.
 */
export function installedDependencies(
  specifiers: ReadonlyArray<string>,
  resolveFile: (specifier: string) => string = (specifier) =>
    fileURLToPath(import.meta.resolve(specifier)),
): Array<string> {
  return specifiers.filter((specifier) => NODE_MODULES_SEGMENT.test(resolveFile(specifier)));
}

function clientOptimizeEntries(
  scan: PageScanResult | null,
  pagesDir: string,
  root: string,
): Array<string> {
  if (!scan) {
    return [];
  }
  const browserFiles = new Set<string>();
  const islandFiles = new Set<string>();
  for (const page of scan.pages) {
    const layouts = resolveEffectiveLayoutChain(page, scan.layouts, scan.namedLayouts);
    if (page.island) {
      islandFiles.add(resolve(pagesDir, page.componentPath));
      for (const layout of layouts) {
        if (layout.island) {
          islandFiles.add(resolve(pagesDir, layout.filePath));
        }
      }
    } else {
      browserFiles.add(resolve(pagesDir, page.componentPath));
      for (const layout of layouts) {
        browserFiles.add(resolve(pagesDir, layout.filePath));
      }
    }
  }
  // Only hydrated components run in the browser; island pages and their
  // unmarked imports may depend on Worker-only packages.
  for (const file of islandFiles) {
    if (!/\.island\.(tsx|jsx)$/.test(file)) {
      continue;
    }
    for (const { specifier } of findIslandImports(readFileSync(file, 'utf8'), file)) {
      const component = resolveSpecifier(specifier, dirname(file), ['.tsx', '.jsx', '.ts', '.js']);
      if (component) {
        browserFiles.add(component);
      }
    }
  }
  // Entries are glob patterns, so route names such as [id] must be literal.
  return [...browserFiles].map((file) => relative(root, file).replace(/[()[\]{}*?!|]/g, '\\$&'));
}

function generateRendererModule(scan: PageScanResult, pagesDir: string, isDev: boolean): string {
  const preambleScript = isDev ? REACT_REFRESH_PREAMBLE : '';

  return `
import { renderReactPage } from "@void/react/pages-server";

${generateComponentManifest(scan, pagesDir)}

	const PREAMBLE_SCRIPT = ${JSON.stringify(preambleScript)};
	
	export async function renderPage(pageObj, assetTags, requestUrl) {
	  return renderReactPage({
	    pageObj,
	    assetTags,
	    components,
	    layoutTree,
	    requestUrl,
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
  const { defaultStrategy, hoverDelay, cacheFor } = resolvePrefetchConfig(prefetch);
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
	  prefetchHoverDelay: ${hoverDelay},
	  prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(cacheFor)}),
	  prefetchDefaultStrategy: ${JSON.stringify(defaultStrategy)},
	});
	export { router };
	`;
}
