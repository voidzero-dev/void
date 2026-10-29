import type { Plugin } from 'vite';
import { createPagesPlugin, generateComponentManifest } from 'void/pages';
import type { PageScanResult, StaticPageDataBuildOptions } from 'void/pages';

const CLIENT_ENTRY_ID = 'virtual:void-pages-client';

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
  return createPagesPlugin(pagesDir, {
    name: 'void-solid:pages',
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
    async config({ isDev, scan }) {
      if (isDev) {
        return {
          optimizeDeps: {
            // Pre-include Solid entries discovered late via dynamic imports
            include: ['solid-js', 'solid-js/web', 'solid-js/store'],
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

function generateRendererModule(scan: PageScanResult, pagesDir: string): string {
  return `
import { renderToStringAsync, generateHydrationScript } from "solid-js/web";
import { createComponent } from "solid-js";
import { SharedContext, ErrorsContext, ParamsContext, RouterContext, NavigationContext } from "@void/solid";
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

  function ServerApp() {
    return createComponent(SharedContext.Provider, {
      value: pageObj.shared || {},
      get children() {
        return createComponent(ErrorsContext.Provider, {
          value: pageObj.errors || {},
          get children() {
            return createComponent(RouterContext.Provider, {
              value: createSsrRouter(pageObj.url || "/", pageObj.params || {}),
              get children() {
                return createComponent(NavigationContext.Provider, {
                  value: () => idleNavigationState(),
                  get children() {
                    return createComponent(ParamsContext.Provider, {
                      value: pageObj.params || {},
                      get children() {
                        // Build layout chain inside providers so contexts are available
                        let element = createComponent(PageComponent, pageObj.props);
                        for (let i = layoutComponents.length - 1; i >= 0; i--) {
                          const Layout = layoutComponents[i];
                          const child = element;
                          element = createComponent(Layout, { get children() { return child; } });
                        }
                        return element;
                      }
                    });
                  }
                });
              }
            });
          }
        });
      }
    });
  }

  // Use createComponent to match the client's hydration tree structure
  const html = await renderToStringAsync(() => createComponent(ServerApp, {}));

  const pageData = serializePageData(pageObj);
  const headHtml = pageObj.head ? renderHeadToString(pageObj.head) : "";
  const htmlAttrs = pageObj.head ? renderHtmlAttrs(pageObj.head) : "";
  const bodyAttrs = pageObj.head ? renderBodyAttrs(pageObj.head) : "";

  return \`<!doctype html>
<html\${htmlAttrs}>
<head>\${headHtml}\${assetTags.css}\${assetTags.preloads}\${generateHydrationScript()}</head>
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
import { createSignal, createComponent, createMemo, mergeProps, untrack, batch } from "solid-js";
import { createMutable } from "solid-js/store";
import { hydrate, render } from "solid-js/web";
import { SharedContext, ErrorsContext, ParamsContext, RouterContext, NavigationContext, setActionRouter } from "@void/solid";
import { createRouterFacade, createVoidRouter, idleNavigationState } from "void/pages-client";
import { parseCacheFor } from "void/pages-prefetch";

${generateComponentManifest(scan, pagesDir)}

// A new page object re-creates the page; props alone update it in place.
const [page, setPage] = createSignal({ component: null });
const [pageProps, setPageProps] = createSignal({});
const [layouts, setLayouts] = createSignal([]);
const shared = createMutable({});
const [errors, setErrors] = createSignal({});
const [routeUrl, setRouteUrl] = createSignal(window.location.pathname + window.location.search + window.location.hash);
const [routeParams, setRouteParams] = createSignal({});
const [navigation, setNavigation] = createSignal(idleNavigationState());

// Keep the context object stable for layouts that call useShared() once.
function replaceShared(next) {
  for (const key of Object.keys(shared)) delete shared[key];
  Object.assign(shared, next || {});
}

function sameParams(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

const { router, initialPageData, initialComponent, initialLayouts, start, commitInitialRender } =
  await createVoidRouter({
    adapter: {
      createDeferred: () => ({ value: null, loading: true, error: null }),
      resolveDeferred(ref, value) { return { value, loading: false, error: null }; },
      rejectDeferred(ref, error) { return { value: null, loading: false, error: new Error(error) }; },
      isLoading: (ref) => ref.loading,
      applyUpdate(pageData, comp, layoutComps, options) {
        const params = pageData.params || {};
        // Back/forward preserves state, but another route or another record
        // still needs a new page so useForm() targets that route and record.
        const current = page();
        const keep = options?.preserveState && current.id === pageData.component && current.component === comp && sameParams(routeParams(), params);
        batch(() => {
          if (!keep) setPage({ component: comp, id: pageData.component });
          setPageProps(pageData.props);
          setLayouts(layoutComps);
          replaceShared(pageData.shared);
          setErrors(pageData.errors || {});
          setRouteParams(params);
        });
      },
      onDeferredUpdate(props) {
        batch(() => { setPageProps({ ...props }); });
      },
    },
    components, layoutTree, routeMeta, matchRoute,
    staticPageData: ${!!staticPageData?.enabled},
    staticPageDataFastPath: ${!!staticPageData?.fastPath},
    viewTransitions: ${!!viewTransitions},
    prefetchHoverDelay: ${prefetch?.hoverDelay ?? 75},
    prefetchDefaultCacheFor: parseCacheFor(${JSON.stringify(prefetch?.cacheFor ?? '30s')}),
    onRouteChange(url) {
      setRouteUrl(url);
    },
    onNavigationChange(next) {
      setNavigation(next);
    },
  });

const reactiveRouter = createRouterFacade(router, () => routeUrl(), () => routeParams());

setActionRouter(reactiveRouter);

batch(() => {
  setPage({ component: initialComponent, id: initialPageData.component });
  setPageProps(initialPageData.props);
  setLayouts(initialLayouts);
  replaceShared(initialPageData.shared);
  setErrors(initialPageData.errors || {});
  setRouteParams(initialPageData.params || {});
});

// Each slot re-renders only when its own layout or page changes, so
// layouts above it keep their state. The inner slot is created before its
// layout to match the server render order for hydration.
function renderSlot(depth) {
  const entry = createMemo(() => {
    const list = layouts();
    return depth < list.length ? list[depth] : page();
  });
  return createMemo(() => {
    const current = entry();
    return untrack(() => {
      if (typeof current === "function") {
        const child = renderSlot(depth + 1);
        return createComponent(current, { get children() { return child; } });
      }
      return current.component ? createComponent(current.component, mergeProps(pageProps)) : null;
    });
  });
}

function App() {
  return createComponent(SharedContext.Provider, {
    value: shared,
    get children() {
      return createComponent(ErrorsContext.Provider, {
        value: errors,
        get children() {
          return createComponent(RouterContext.Provider, {
            value: reactiveRouter,
            get children() {
              return createComponent(ParamsContext.Provider, {
                get value() { return routeParams(); },
                get children() {
                  return createComponent(NavigationContext.Provider, {
                    value: navigation,
                    get children() {
                      return renderSlot(0);
                    }
                  });
                }
              });
            }
          });
        }
      });
    }
  });
}

const appEl = document.getElementById("app");
if (!appEl) throw new Error("pages: Missing #app element for Void Solid pages hydration.");
if (appEl.getAttribute("data-void-ssr") === "false") {
  render(() => createComponent(App, {}), appEl);
} else {
  hydrate(() => createComponent(App, {}), appEl);
}
appEl.setAttribute("data-hydrated", "true");
export { reactiveRouter as router };
start();
commitInitialRender();
`;
}
