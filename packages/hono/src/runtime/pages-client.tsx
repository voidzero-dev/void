import { ErrorBoundary, useLayoutEffect, useState } from 'hono/jsx';
import type { Child, FC } from 'hono/jsx';
import { createRoot, hydrateRoot } from 'hono/jsx/dom/client';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  createRouterFacade,
  createVoidRouter,
  idleNavigationState,
  type NavigationState,
  type VoidRouter,
  type VoidRouterConfig,
} from 'void/pages-client';
import type { PageObject } from 'void/pages-protocol';
import { setActionRouter } from './action.ts';
import {
  ErrorsContext,
  NavigationContext,
  ParamsContext,
  RouterContext,
  SharedContext,
} from './context.ts';

export type HonoPagesConfig = Omit<
  VoidRouterConfig,
  'adapter' | 'onRouteChange' | 'onNavigationChange'
>;

export type HonoPagesClient = Readonly<{
  router: VoidRouter;
}>;

type PageComponent = FC<Record<string, unknown>>;
type LayoutComponent = FC<{ children?: Child }>;

type View = {
  pageData: PageObject;
  component: PageComponent;
  layouts: Array<LayoutComponent>;
  /** Changes when the page must be created again, which drops its state. */
  key: number;
};

// Stable fallbacks: useForm() compares the errors object by identity.
const EMPTY_PARAMS: Record<string, string> = {};
const EMPTY_SHARED: Record<string, unknown> = {};
const EMPTY_ERRORS: Record<string, string> = {};

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export async function startHonoPages(config: HonoPagesConfig): Promise<HonoPagesClient> {
  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('pages: Missing #app element for Void Hono pages hydration.');
  }

  // Assigned by <App> on its first render.
  let setView: ((update: (view: View) => View) => void) | null = null;
  let setRouteUrl: ((url: string) => void) | null = null;
  let setNavigation: ((navigation: NavigationState) => void) | null = null;
  // The update the router is waiting for, and the last view that reached the DOM.
  let pendingCommit: { resolve(): void; reject(error: unknown): void } | null = null;
  let renderedView: View | null = null;

  const { router, initialPageData, initialComponent, initialLayouts, start, commitInitialRender } =
    await createVoidRouter({
      ...config,
      adapter: {
        createDeferred: () => ({ value: null, loading: true, error: null }),
        resolveDeferred: (_ref, value) => ({ value, loading: false, error: null }),
        rejectDeferred: (_ref, error) => ({ value: null, loading: false, error: new Error(error) }),
        isLoading: (ref) => (ref as { loading: boolean }).loading,
        // Resolves once the page is in the DOM, so the router can restore scroll.
        applyUpdate(pageData, component, layouts, { preserveState }) {
          return new Promise<void>((resolve, reject) => {
            // A newer update replaces this one before it renders. Settle it too.
            pendingCommit?.resolve();
            pendingCommit = { resolve, reject };
            setView?.((view) => {
              // Back/forward preserves state, but another route or another record
              // still needs a new page so useForm() targets that route and record.
              const keep =
                preserveState &&
                view.pageData.component === pageData.component &&
                view.component === component &&
                sameParams(view.pageData.params ?? EMPTY_PARAMS, pageData.params ?? EMPTY_PARAMS);
              return {
                pageData,
                component: component as PageComponent,
                layouts: layouts as Array<LayoutComponent>,
                key: keep ? view.key : view.key + 1,
              };
            });
          });
        },
        // A deferred prop settled: render the page again with the new props.
        onDeferredUpdate(props) {
          setView?.((view) => ({ ...view, pageData: { ...view.pageData, props: { ...props } } }));
        },
      },
      onRouteChange: (url) => setRouteUrl?.(url),
      onNavigationChange: (navigation) => setNavigation?.(navigation),
    });

  setActionRouter(createRouterFacade(router, currentUrl));

  // The router restores the document's scroll position in commitInitialRender(),
  // from what start() read. Hono JSX may render synchronously inside
  // hydrateRoot(), so commit once the page is in the DOM and the router started.
  let mounted = false;
  let started = false;
  let committed = false;
  function commitInitial(): void {
    if (!mounted || !started || committed) {
      return;
    }
    committed = true;
    commitInitialRender();
    appEl!.setAttribute('data-hydrated', 'true');
  }

  function App(): JSX.Element {
    const [view, updateView] = useState<View>({
      pageData: initialPageData,
      component: initialComponent as PageComponent,
      layouts: initialLayouts as Array<LayoutComponent>,
      key: 0,
    });
    const [routeUrl, updateRouteUrl] = useState(currentUrl);
    const [navigation, updateNavigation] = useState(idleNavigationState);
    setView = updateView;
    setRouteUrl = updateRouteUrl;
    setNavigation = updateNavigation;

    useLayoutEffect(() => {
      mounted = true;
      commitInitial();
    }, []);
    useLayoutEffect(() => {
      renderedView = view;
      pendingCommit?.resolve();
      pendingCommit = null;
    }, [view]);

    // Hono JSX keeps the previous DOM when an update throws, and runs no effect.
    // Go back to the view on screen, so later renders of the layouts succeed,
    // and fail the visit instead of leaving it pending.
    const onRenderError = (error: unknown): void => {
      if (renderedView && renderedView !== view) {
        const rendered = renderedView;
        updateView(() => rendered);
      }
      pendingCommit?.reject(error);
      pendingCommit = null;
    };

    const { pageData } = view;
    const params = pageData.params ?? EMPTY_PARAMS;
    const Page = view.component;
    let element = <Page key={view.key} {...pageData.props} />;
    for (let i = view.layouts.length - 1; i >= 0; i--) {
      const Layout = view.layouts[i];
      element = <Layout>{element}</Layout>;
    }

    return (
      <RouterContext.Provider
        value={createRouterFacade(
          router,
          () => routeUrl,
          () => params,
        )}
      >
        <NavigationContext.Provider value={navigation}>
          <SharedContext.Provider value={pageData.shared ?? EMPTY_SHARED}>
            <ParamsContext.Provider value={params}>
              <ErrorsContext.Provider value={pageData.errors ?? EMPTY_ERRORS}>
                {/* Without a fallback the boundary reports the error and rethrows it. */}
                <ErrorBoundary onError={onRenderError}>{element}</ErrorBoundary>
              </ErrorsContext.Provider>
            </ParamsContext.Provider>
          </SharedContext.Provider>
        </NavigationContext.Provider>
      </RouterContext.Provider>
    );
  }

  if (appEl.getAttribute('data-void-ssr') === 'false') {
    createRoot(appEl).render(<App />);
  } else {
    hydrateRoot(appEl, <App />);
  }
  start();
  started = true;
  commitInitial();

  return { router };
}
