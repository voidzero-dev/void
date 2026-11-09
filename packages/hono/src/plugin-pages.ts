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
const JSX_OPTIMIZE_DEPS = [
  'hono/jsx',
  'hono/jsx/jsx-runtime',
  'hono/jsx/jsx-dev-runtime',
  'hono/html',
];
/** The Hono JSX entries pages and islands load in the browser. */
export const CLIENT_OPTIMIZE_DEPS: ReadonlyArray<string> = [
  ...JSX_OPTIMIZE_DEPS,
  'hono/jsx/dom',
  'hono/jsx/dom/client',
];
// Void's server routing imports `hono` too. Found late, it would re-optimize
// the JSX entries of the same package while the first page renders.
const WORKER_OPTIMIZE_DEPS = ['hono', ...JSX_OPTIMIZE_DEPS];
const NODE_MODULES_SEGMENT = /[\\/]node_modules[\\/]/;

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  const root = options?.root ?? dirname(pagesDir);
  const pagesOptimizeEntries = `${relative(root, pagesDir)}/**/*.{js,jsx,ts,tsx}`;
  return createPagesPlugin(pagesDir, {
    name: 'void-hono:pages',
    root,
    generateRenderer(scan) {
      return generateRendererModule(scan, pagesDir);
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
      // In dev mode, exclude @void/hono from dep optimization so the virtual
      // modules and user components share the same context objects. Hono JSX
      // matches contexts by identity, so a pre-bundled copy of the adapter
      // would make useContext() return the default value.
      if (isDev) {
        return {
          optimizeDeps: {
            exclude: ['@void/hono'],
            // Crawl page modules before the first client request so third-party
            // imports are pre-bundled instead of triggering a full reload.
            entries: clientOptimizeEntries(await scan(), pagesDir, root),
            // Pre-include the Hono JSX entries up front: a re-optimization in the
            // middle of a session would leave two copies of each context.
            // void/pages-client and void/pages-prefetch are reached only through
            // virtual entries and the excluded @void/hono, so the scanner cannot
            // see them.
            include: [
              ...CLIENT_OPTIMIZE_DEPS,
              ...installedDependencies(['void/pages-client', 'void/pages-prefetch']),
            ],
          },
          environments: {
            [WORKER_ENVIRONMENT_NAME]: {
              optimizeDeps: {
                exclude: ['@void/hono'],
                // Crawl page/layout modules before the first Worker request, so
                // the worker optimizer does not reload the program mid-render.
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
 * dev would keep serving that copy after the package is rebuilt.
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

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { renderHonoPage } from "@void/hono/pages-server";

${generateComponentManifest(scan, pagesDir)}

export async function renderPage(pageObj, assetTags, requestUrl) {
  return renderHonoPage({ pageObj, assetTags, components, layoutTree, requestUrl });
}
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
import { startHonoPages } from "@void/hono/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

const { router } = await startHonoPages({
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
