import { dirname, relative } from 'pathslash';
import type { Plugin } from 'vite';
import { createPagesPlugin, generateComponentManifest } from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';

const CLIENT_ENTRY_ID = 'virtual:void-pages-client';
const WORKER_ENVIRONMENT_NAME = 'void_worker';
const REACT_DEDUPE = ['react', 'react-dom'];
const REACT_OPTIMIZE_DEPS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom'];
const CLIENT_OPTIMIZE_DEPS = [...REACT_OPTIMIZE_DEPS, 'react-dom/client'];
const WORKER_OPTIMIZE_DEPS = [...REACT_OPTIMIZE_DEPS, 'react-dom/server', 'void/live/client'];

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
            // Pre-include React entries that are discovered late via dynamic
            // imports during SPA navigation, avoiding a full-page reload
            // from Vite's dep optimizer.
            include: CLIENT_OPTIMIZE_DEPS,
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
                include: WORKER_OPTIMIZE_DEPS,
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
