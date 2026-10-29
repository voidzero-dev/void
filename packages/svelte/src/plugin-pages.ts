import { readdirSync } from 'node:fs';
import type { Plugin } from 'vite';
import { createPagesPlugin, generateComponentManifest } from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';

const CLIENT_ENTRY_ID = 'virtual:void-pages-client';
const SVELTE_OPTIMIZE_DEPS = {
  // Exclude @void/svelte so the virtual module and user components share
  // the same Svelte context (identity).
  exclude: ['@void/svelte'],
  // Pre-include Svelte so it's not discovered late via dynamic imports.
  include: ['svelte', 'svelte/store', 'svelte/internal', 'svelte/internal/client'],
};

export type PrefetchConfig = {
  hoverDelay?: number;
  cacheFor?: number | string | [string, string];
};

type PagesPluginOptions = {
  root?: string;
  viewTransitions?: boolean;
  prefetch?: PrefetchConfig;
};

/** Check if the pages directory has any non-island Svelte page files. */
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
      if (name.endsWith('.svelte') && !name.includes('.island.')) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export function pagesPlugin(pagesDir: string, options?: PagesPluginOptions): Plugin {
  return createPagesPlugin(pagesDir, {
    name: 'void-svelte:pages',
    root: options?.root,
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
    config({ isDev }) {
      if (isDev) {
        return {
          optimizeDeps: SVELTE_OPTIMIZE_DEPS,
          environments: {
            void_worker: {
              optimizeDeps: {
                exclude: ['@void/svelte'],
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

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { render } from "svelte/server";
import App from "@void/svelte/App.svelte";
import { createSsrRouter, idleNavigationState } from "void/pages-client";
import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from "void/pages-head";
import { serializePageData } from "void/pages-server";

${generateComponentManifest(scan, pagesDir)}

export async function renderPage(pageObj, assetTags) {
  const PageComponent = (await components[pageObj.component]()).default;
  const layoutIds = layoutTree[pageObj.component] || [];
  const layoutComponents = await Promise.all(
    layoutIds.map(async (id) => (await components[id]()).default)
  );

  const { html, head } = render(App, {
    props: {
      page: PageComponent,
      layouts: layoutComponents,
      pageProps: pageObj.props,
      shared: pageObj.shared || {},
      params: pageObj.params || {},
      router: createSsrRouter(pageObj.url || "/", pageObj.params || {}),
      routeUrl: pageObj.url || "/",
      navigation: idleNavigationState(),
      stores: null,
    },
  });

  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${head}\${assetTags.css}\${assetTags.preloads}</head>
<body\${bodyAttrs}>
  <script id="__VOID_PAGE_DATA__" type="application/json">\${pageData}</script>
  <div id="app">\${html}</div>
  \${assetTags.body}
</body>
</html>\`;
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
  return `
import { hydrate, mount, tick } from "svelte";
import { writable } from "svelte/store";
import App from "@void/svelte/App.svelte";
import { setActionRouter } from "@void/svelte";
import { createRouterFacade, createVoidRouter, idleNavigationState } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

const pageStore = writable(null);
const propsStore = writable({});
const layoutsStore = writable([]);
const sharedStore = writable({});
const paramsStore = writable({});
let routeUrl = window.location.pathname + window.location.search + window.location.hash;
let routeParams = {};
const routeStore = writable(routeUrl);
const navigationStore = writable(idleNavigationState());

const { router, initialPageData, initialComponent, initialLayouts, start, commitInitialRender } =
  await createVoidRouter({
    adapter: {
      createDeferred: () => ({ value: null, loading: true, error: null }),
      resolveDeferred(ref, value) { return { value, loading: false, error: null }; },
      rejectDeferred(ref, error) { return { value: null, loading: false, error: new Error(error) }; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layouts) {
        propsStore.set(pageData.props);
        sharedStore.set(pageData.shared || {});
        routeParams = pageData.params || {};
        paramsStore.set(routeParams);
        layoutsStore.set(layouts);
        pageStore.set(comp);
      },
      onDeferredUpdate(props) {
        propsStore.set({ ...props });
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    staticPageData: ${!!staticPageData?.enabled},
    staticPageDataFastPath: ${!!staticPageData?.fastPath},
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
    onRouteChange(url) {
      routeUrl = url;
      routeStore.set(url);
    },
    onNavigationChange(navigation) {
      navigationStore.set(navigation);
    },
  });

const reactiveRouter = createRouterFacade(router, () => routeUrl, () => routeParams);

setActionRouter(router);

pageStore.set(initialComponent);
propsStore.set(initialPageData.props);
layoutsStore.set(initialLayouts);
sharedStore.set(initialPageData.shared || {});
routeParams = initialPageData.params || {};
paramsStore.set(routeParams);

const appEl = document.getElementById("app");
if (!appEl) throw new Error("pages: Missing #app element for Void Svelte pages hydration.");
const appOptions = {
  target: appEl,
  props: {
    page: initialComponent,
    layouts: initialLayouts,
    pageProps: initialPageData.props,
    shared: initialPageData.shared || {},
    params: initialPageData.params || {},
    router,
    routeUrl,
    navigation: idleNavigationState(),
    stores: {
      page: pageStore,
      props: propsStore,
      layouts: layoutsStore,
      shared: sharedStore,
      params: paramsStore,
      route: routeStore,
      navigation: navigationStore,
    },
  },
};
if (appEl.getAttribute("data-void-ssr") === "false") {
  mount(App, appOptions);
} else {
  hydrate(App, appOptions);
}

export { reactiveRouter as router };
start();
await tick();
commitInitialRender();
appEl.setAttribute("data-hydrated", "true");
`;
}
