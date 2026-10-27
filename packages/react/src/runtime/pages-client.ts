import React, {
  Suspense,
  startTransition,
  use,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  useTransition,
  type ComponentType,
} from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import {
  createRouterFacade,
  createPageNavigationEngine,
  idleNavigationState,
  isAbortError,
  isCallSiteActionError,
  refreshPage,
  type PageNavigationResource,
  type PageNavigationResult,
  type NavigationState,
  type VisitOptions,
  type VoidRouter,
} from 'void/pages-client';
import type { CacheForResult } from 'void/pages-prefetch';
import type { PageObject } from 'void/pages-protocol';
import { setActionRouter } from './action.ts';
import {
  ErrorsContext,
  NavigationContext,
  ParamsContext,
  RouterContext,
  SharedContext,
} from './context.ts';
import { DEFERRED_SHELL_END_ID } from './deferred-shell.ts';

// oxlint-disable-next-line no-explicit-any -- component props are narrowed by generated route types
type ComponentModule = { default: ComponentType<any> };
type ReactPageData = PageObject;
type ReactPageComponent = ComponentType<Record<string, unknown>>;
type ReactLayoutComponent = ComponentType<{ children?: React.ReactNode }>;

export type ReactPagesConfig = Readonly<{
  components: Record<string, () => Promise<ComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  routeMeta: Record<string, { island?: boolean }>;
  /** Page id for a decoded pathname. */
  matchRoute(path: string): string | null;
  staticPageData: boolean;
  staticPageDataFastPath: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
  cacheVisitedPageData?: boolean;
  /** Show this fallback for client visits whose destination remains pending at the next paint. */
  navigationFallback?: ComponentType<{ initialPageData: PageObject }>;
}>;

export type ReactPagesClient = Readonly<{
  router: VoidRouter;
}>;

type DeferredResource = Promise<unknown>;

type DeferredResourceState =
  | {
      status: 'pending';
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }
  | { status: 'resolved' | 'rejected' };

type ReactPageResource = PageNavigationResource & {
  shell: Promise<PageNavigationResult | undefined>;
};

type VisitSettler = {
  resolve(pageData: ReactPageData | undefined): void;
  reject(error: unknown): void;
};

type AppState = {
  resource: ReactPageResource;
  rollbackResource: ReactPageResource | null;
  navigation: NavigationState;
  routeUrl: string;
  pendingId: number | null;
};

type AppAction =
  | {
      type: 'begin';
      resource: ReactPageResource;
      navigation: NavigationState;
    }
  | { type: 'reveal'; resource: ReactPageResource }
  | { type: 'finish'; resource: ReactPageResource; location: string }
  | { type: 'fail'; resource: ReactPageResource; location: string }
  | { type: 'abandon'; resource: ReactPageResource; location: string };

const deferredState = new WeakMap<DeferredResource, DeferredResourceState>();
const viewTransitionWaiters = new Map<number, () => void>();
const pendingVisitSettlers = new Map<number, VisitSettler>();
const committedResources = new Set<number>();
const EMPTY_PARAMS: Record<string, string> = {};

let activePendingNavigationId: number | null = null;
// The URL the prerendered HTML was rendered with, while it differs from the browser URL. The
// hydration commit clears it before effects run, so effects and later renders read the browser URL.
let prerenderedUrl: string | null = null;
let scheduleVisit:
  | ((url: string, options?: VisitOptions) => Promise<ReactPageData | undefined>)
  | null = null;

function createDeferredResource(): DeferredResource {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  deferredState.set(promise, { status: 'pending', resolve, reject });
  return promise;
}

function resolveDeferredResource(ref: unknown, value: unknown): unknown {
  const state = deferredState.get(ref as DeferredResource);
  if (state?.status === 'pending') {
    state.resolve(value);
    deferredState.set(ref as DeferredResource, { status: 'resolved' });
  }
  return ref;
}

function rejectDeferredResource(ref: unknown, error: string): unknown {
  const state = deferredState.get(ref as DeferredResource);
  if (state?.status === 'pending') {
    state.reject(new Error(error));
    deferredState.set(ref as DeferredResource, { status: 'rejected' });
  }
  return ref;
}

function isDeferredResourceLoading(ref: unknown): boolean {
  return deferredState.get(ref as DeferredResource)?.status === 'pending';
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function normalizeUrl(value: string | URL): string {
  if (typeof value === 'string' && value.startsWith('#')) {
    return value;
  }
  const url = value instanceof URL ? value : new URL(value, window.location.origin);
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : url.href;
}

/** Page data holds a decoded path. Compare it with browser URLs in their encoded form. */
function encodedPageUrl(url: string): string {
  if (!url) {
    return url;
  }
  const parsed = new URL(url, window.location.origin);
  return parsed.pathname + parsed.search;
}

/** Static hosts serve one page at `/a`, `/a/`, `/a.html` and `/a/index.html`. */
function staticPagePath(pathname: string): string {
  let path = pathname;
  if (path.endsWith('/index.html')) {
    path = path.slice(0, -'index.html'.length);
  } else if (path.endsWith('.html')) {
    path = path.slice(0, -'.html'.length);
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Static page data serves every query of a path, so its url has no query. Returns the query of
 * fetchUrl when the page data is such data for its path, or null.
 */
function staticVisitQuery(pageUrl: string, fetchUrl: string): string | null {
  if (!pageUrl || pageUrl.includes('?')) {
    return null;
  }
  const queryStart = fetchUrl.indexOf('?');
  const fetchPath = queryStart === -1 ? fetchUrl : fetchUrl.slice(0, queryStart);
  if (staticPagePath(fetchPath) !== staticPagePath(pageUrl)) {
    return null;
  }
  return queryStart === -1 ? '' : fetchUrl.slice(queryStart);
}

/**
 * The URL prerendered HTML was rendered with, when it lacks the visitor's query, or null.
 */
function prerenderedRouteUrl(pageData: ReactPageData): string | null {
  const pageUrl = encodedPageUrl(pageData.url);
  const query = staticVisitQuery(pageUrl, window.location.pathname + window.location.search);
  return query ? pageUrl + window.location.hash : null;
}

function navigationForResource(resource: PageNavigationResource): NavigationState {
  const method = resource.method.toUpperCase();
  const isSubmitting = method !== 'GET';
  return {
    state: isSubmitting ? 'submitting' : 'loading',
    location: new URL(resource.fetchUrl + resource.hash, window.location.origin),
    method:
      method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
        ? method
        : 'GET',
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'begin':
      return {
        resource: state.resource,
        rollbackResource: state.rollbackResource || state.resource,
        pendingId: action.resource.id,
        routeUrl: state.routeUrl,
        navigation: action.navigation,
      };
    case 'reveal':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        resource: action.resource,
      };
    case 'finish':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        resource: action.resource.immediate ? state.resource : action.resource,
        rollbackResource: null,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
    case 'fail':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        resource: state.rollbackResource || state.resource,
        rollbackResource: null,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
    case 'abandon':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        resource: state.rollbackResource || state.resource,
        rollbackResource: null,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
  }
}

function createRouter(engine: Awaited<ReturnType<typeof createPageNavigationEngine>>): VoidRouter {
  const router: VoidRouter = {
    _hoverDelay: engine._hoverDelay,
    get url() {
      return new URL(currentUrl(), window.location.origin);
    },
    get path() {
      return this.url.pathname;
    },
    get query() {
      return this.url.searchParams;
    },
    get params() {
      return {};
    },
    visit(url, options = {}) {
      if (!scheduleVisit) {
        return Promise.reject(new Error('router.visit() called before router initialized'));
      }
      return scheduleVisit(normalizeUrl(url), options);
    },
    refresh(options = {}) {
      return refreshPage(router, options);
    },
    prefetch(url, options = {}) {
      return engine.prefetch(normalizeUrl(url), options);
    },
    flush(url, method = 'GET') {
      engine.flush(normalizeUrl(url), method);
    },
    flushAll() {
      engine.flushAll();
    },
  };
  return router;
}

function RouteResource({
  resource,
  onCommit,
}: {
  resource: ReactPageResource;
  onCommit(resource: ReactPageResource, result: PageNavigationResult): void;
}): React.ReactNode {
  const result = use(resource.shell);
  const outerRouter = React.useContext(RouterContext);
  useLayoutEffect(() => {
    if (result) {
      onCommit(resource, result);
    }
  }, [onCommit, resource, result]);

  const pageData = result?.pageData as ReactPageData | undefined;
  const pageDataUrl = pageData?.url ?? '';
  const routeParams = pageData?.params ?? EMPTY_PARAMS;
  const routeRouter = useMemo(() => {
    const pageUrl = encodedPageUrl(pageDataUrl);
    return createRouterFacade(
      outerRouter!,
      () => {
        const outerUrl = outerRouter!.url;
        const outerPath = outerUrl.pathname + outerUrl.search;
        if (outerPath === pageUrl) {
          return outerPath + outerUrl.hash;
        }
        // Keep the query of a visit that loaded static page data. The outer URL keeps the hash
        // current after a same-page hash visit; during a reveal it still names the old page.
        const query = staticVisitQuery(pageUrl, resource.fetchUrl);
        if (query !== null) {
          return (
            pageUrl + query + (outerPath === resource.fetchUrl ? outerUrl.hash : resource.hash)
          );
        }
        return pageUrl + resource.hash;
      },
      () => routeParams,
    );
  }, [outerRouter, pageDataUrl, resource.fetchUrl, resource.hash, routeParams]);

  // Hooks above run on every render, so a resource with no result keeps the hook count.
  if (!result || !pageData) {
    return null;
  }

  const PageComponent = result.component as ReactPageComponent;
  let element = React.createElement(PageComponent, pageData.props);
  for (let i = result.layouts.length - 1; i >= 0; i--) {
    const Layout = result.layouts[i] as ReactLayoutComponent;
    element = React.createElement(Layout, null, element);
  }

  return React.createElement(
    RouterContext.Provider,
    { value: routeRouter },
    React.createElement(
      ParamsContext.Provider,
      { value: routeParams },
      React.createElement(
        SharedContext.Provider,
        { value: pageData.shared ?? {} },
        React.createElement(ErrorsContext.Provider, { value: pageData.errors ?? {} }, element),
      ),
    ),
  );
}

function startViewTransition(
  resource: ReactPageResource,
  reveal: () => void,
  enabled: boolean,
): void {
  if (!enabled || typeof document.startViewTransition !== 'function') {
    reveal();
    return;
  }

  let resolveViewTransition!: () => void;
  const readyForCapture = new Promise<void>((resolve) => {
    resolveViewTransition = resolve;
  });
  viewTransitionWaiters.set(resource.id, resolveViewTransition);
  document.startViewTransition(() => {
    reveal();
    return readyForCapture;
  });
}

function App({
  engine,
  router,
  viewTransitions,
  navigationFallback: NavigationFallback,
}: {
  engine: Awaited<ReturnType<typeof createPageNavigationEngine>>;
  router: VoidRouter;
  viewTransitions: boolean;
  navigationFallback?: ComponentType<{ initialPageData: PageObject }>;
}): React.ReactNode {
  const initialPageData = engine.initialPageData as ReactPageData;
  const [hydrated, setHydrated] = useState(prerenderedUrl === null);
  const initialResource = useMemo<ReactPageResource>(
    () => ({
      id: 0,
      url: initialPageData.url || currentUrl(),
      fetchUrl: window.location.pathname + window.location.search,
      hash: window.location.hash,
      method: 'GET',
      options: {},
      immediate: false,
      shell: Promise.resolve({
        pageData: initialPageData,
        component: engine.initialComponent,
        layouts: engine.initialLayouts,
      }),
      abort() {},
      async commit() {
        engine.commitInitialRender();
        document.getElementById('app')!.setAttribute('data-hydrated', 'true');
        if (prerenderedUrl !== null) {
          prerenderedUrl = null;
          // A transition waits for Suspense boundaries that are still dehydrated, where an urgent
          // update would replace their server HTML with the fallback. Those boundaries hydrate
          // with the browser URL, so one that renders the query falls back to a client render.
          React.startTransition(() => setHydrated(true));
        }
        return true;
      },
      dispose() {},
    }),
    [engine, initialPageData],
  );
  const [state, dispatch] = useReducer(appReducer, {
    resource: initialResource,
    rollbackResource: null,
    pendingId: null,
    routeUrl: currentUrl(),
    navigation: idleNavigationState(),
  });
  const [isTransitionPending, startTransition] = useTransition();

  const finishNavigation = useCallback(
    (resource: ReactPageResource, result: PageNavigationResult) => {
      if (committedResources.has(resource.id)) {
        return;
      }
      committedResources.add(resource.id);
      resource
        .commit()
        .then((committed) => {
          const resolveViewTransition = viewTransitionWaiters.get(resource.id);
          if (resolveViewTransition) {
            viewTransitionWaiters.delete(resource.id);
            resolveViewTransition();
          }
          const visitSettler = pendingVisitSettlers.get(resource.id);
          if (visitSettler) {
            pendingVisitSettlers.delete(resource.id);
            if (committed) {
              visitSettler.resolve(result.pageData);
            } else if (resource.method.toUpperCase() === 'GET') {
              // A newer visit committed first. Settle like any abandoned visit.
              visitSettler.resolve(undefined);
            } else {
              visitSettler.reject(new DOMException('Navigation aborted', 'AbortError'));
            }
          }
          if (!committed) {
            return;
          }
          if (activePendingNavigationId === resource.id) {
            activePendingNavigationId = null;
          }
          dispatch({ type: 'finish', resource, location: currentUrl() });
        })
        .catch((error) => {
          // The history write failed, so the address bar still shows the committed page.
          // End this visit and show that page again; a newer visit keeps its own state.
          const resolveViewTransition = viewTransitionWaiters.get(resource.id);
          if (resolveViewTransition) {
            viewTransitionWaiters.delete(resource.id);
            resolveViewTransition();
          }
          const visitSettler = pendingVisitSettlers.get(resource.id);
          if (visitSettler) {
            pendingVisitSettlers.delete(resource.id);
            visitSettler.reject(error);
          } else {
            // A form visit has already settled with its action result.
            reportError(error);
          }
          if (activePendingNavigationId === resource.id) {
            activePendingNavigationId = null;
          }
          dispatch({ type: 'fail', resource, location: currentUrl() });
        });
    },
    [],
  );

  const schedule = useCallback(
    (url: string, options: VisitOptions = {}) => {
      const prepared = engine.prepareVisit(url, options) as ReactPageResource;
      if (prepared.immediate) {
        const navigation = navigationForResource(prepared);

        activePendingNavigationId = prepared.id;
        dispatch({ type: 'begin', resource: prepared, navigation });

        return prepared.shell.then(
          (result) => {
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
            }
            dispatch({ type: 'finish', resource: prepared, location: currentUrl() });
            return result?.pageData;
          },
          (error) => {
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
            }
            dispatch({ type: 'fail', resource: prepared, location: currentUrl() });
            throw error;
          },
        );
      }

      let resolveVisit!: (pageData: ReactPageData | undefined) => void;
      let rejectVisit!: (error: unknown) => void;
      const pagePromise = new Promise<ReactPageData | undefined>((resolve, reject) => {
        resolveVisit = resolve;
        rejectVisit = reject;
      });

      const next: ReactPageResource = {
        ...prepared,
        shell: prepared.shell.then(
          (result) => {
            if (!result) {
              const resolveViewTransition = viewTransitionWaiters.get(prepared.id);
              if (resolveViewTransition) {
                viewTransitionWaiters.delete(prepared.id);
                resolveViewTransition();
              }
              pendingVisitSettlers.delete(prepared.id);
              if (activePendingNavigationId === prepared.id) {
                activePendingNavigationId = null;
              }
              // The browser is leaving or downloading a file: keep the current page.
              dispatch({ type: 'abandon', resource: prepared, location: currentUrl() });
              resolveVisit(undefined);
            } else if (prepared.options._resolveOnShell) {
              pendingVisitSettlers.delete(prepared.id);
              resolveVisit(result.pageData);
            }
            return result;
          },
          (error) => {
            const resolveViewTransition = viewTransitionWaiters.get(prepared.id);
            if (resolveViewTransition) {
              viewTransitionWaiters.delete(prepared.id);
              resolveViewTransition();
            }
            pendingVisitSettlers.delete(prepared.id);
            const abortingGetVisit =
              prepared.method.toUpperCase() === 'GET' &&
              !prepared.options._resolveOnShell &&
              isAbortError(error);
            if (abortingGetVisit) {
              resolveVisit(undefined);
            } else {
              rejectVisit(error);
            }
            if (activePendingNavigationId === prepared.id) {
              activePendingNavigationId = null;
            }
            if (
              NavigationFallback ||
              prepared.options._resolveOnShell ||
              isAbortError(error) ||
              isCallSiteActionError(error)
            ) {
              dispatch({ type: 'abandon', resource: prepared, location: currentUrl() });
              return undefined;
            }
            dispatch({ type: 'fail', resource: prepared, location: currentUrl() });
            throw error;
          },
        ),
      };
      const navigation = navigationForResource(next);

      pendingVisitSettlers.set(next.id, { resolve: resolveVisit, reject: rejectVisit });
      activePendingNavigationId = next.id;
      dispatch({ type: 'begin', resource: next, navigation });

      if (NavigationFallback) {
        let shellSettled = false;
        let revealed = false;
        const reveal = (settled: boolean) => {
          if (revealed || activePendingNavigationId !== next.id) {
            return;
          }
          revealed = true;
          if (settled) {
            startTransition(() => dispatch({ type: 'reveal', resource: next }));
          } else {
            dispatch({ type: 'reveal', resource: next });
          }
        };
        next.shell.then((result) => {
          shellSettled = true;
          if (result) {
            reveal(true);
          }
        });
        // A cached shell settles before the next paint. Avoid committing the fallback
        // for that visit, while still revealing it promptly for a network-bound shell.
        requestAnimationFrame(() => {
          if (!shellSettled) {
            reveal(false);
          }
        });
        return pagePromise;
      }

      const reveal = () => {
        startTransition(() => {
          dispatch({ type: 'reveal', resource: next });
        });
      };

      next.shell.then(
        (result) => {
          if (result && activePendingNavigationId === next.id) {
            startViewTransition(next, reveal, options.viewTransition ?? viewTransitions);
          }
        },
        () => {},
      );
      return pagePromise;
    },
    [engine, NavigationFallback, startTransition, viewTransitions],
  );

  useInsertionEffect(() => {
    scheduleVisit = schedule;
    return () => {
      if (scheduleVisit === schedule) {
        scheduleVisit = null;
      }
    };
  }, [schedule]);

  useEffect(() => {
    engine.setPopStateHandler((url, options) => {
      router.visit(url, options);
    });
  }, [engine, router]);

  const navigationValue = useMemo<NavigationState>(() => {
    if (state.navigation.state !== 'idle' || !isTransitionPending) {
      return state.navigation;
    }
    return {
      state: 'loading',
      location: null,
      method: 'GET',
    };
  }, [isTransitionPending, state.navigation]);

  const routerValue = useMemo(
    () =>
      createRouterFacade(router, () =>
        hydrated ? state.routeUrl : (prerenderedUrl ?? state.routeUrl),
      ),
    [router, state.routeUrl, hydrated],
  );

  return React.createElement(
    RouterContext.Provider,
    { value: routerValue },
    React.createElement(
      NavigationContext.Provider,
      { value: navigationValue },
      React.createElement(
        Suspense,
        {
          fallback:
            NavigationFallback && state.pendingId !== null
              ? React.createElement(NavigationFallback, { initialPageData })
              : null,
        },
        React.createElement(RouteResource, {
          resource: state.resource,
          onCommit: finishNavigation,
        }),
      ),
    ),
  );
}

export async function startReactPages(config: ReactPagesConfig): Promise<ReactPagesClient> {
  viewTransitionWaiters.clear();
  pendingVisitSettlers.clear();
  committedResources.clear();
  activePendingNavigationId = null;
  prerenderedUrl = null;

  const engine = await createPageNavigationEngine({
    adapter: {
      createDeferred: createDeferredResource,
      resolveDeferred: resolveDeferredResource,
      rejectDeferred: rejectDeferredResource,
      isLoading: isDeferredResourceLoading,
    },
    components: config.components,
    layoutTree: config.layoutTree,
    routeMeta: config.routeMeta,
    matchRoute: config.matchRoute,
    staticPageData: config.staticPageData,
    staticPageDataFastPath: config.staticPageDataFastPath,
    viewTransitions: config.viewTransitions,
    prefetchHoverDelay: config.prefetchHoverDelay,
    prefetchDefaultCacheFor: config.prefetchDefaultCacheFor,
    cacheVisitedPageData: config.cacheVisitedPageData,
  });
  const router = createRouter(engine);
  setActionRouter(router);

  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('pages: Missing #app element for Void React pages hydration.');
  }

  const isSsr = appEl.getAttribute('data-void-ssr') !== 'false';
  if (isSsr) {
    prerenderedUrl = prerenderedRouteUrl(engine.initialPageData as ReactPageData);
  }
  const appRoot = React.createElement(App, {
    engine,
    router,
    viewTransitions: config.viewTransitions,
    navigationFallback: config.navigationFallback,
  });
  const hasDeferred = Boolean((engine.initialPageData as ReactPageData).deferredKeys);
  const app =
    isSsr && hasDeferred
      ? React.createElement(
          React.Fragment,
          null,
          appRoot,
          React.createElement('template', { id: DEFERRED_SHELL_END_ID }),
        )
      : appRoot;
  startTransition(() => {
    if (!isSsr) {
      createRoot(appEl).render(app);
    } else {
      hydrateRoot(appEl, app);
    }
  });
  engine.start();

  return { router };
}
