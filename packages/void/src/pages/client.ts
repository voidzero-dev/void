/// <reference lib="dom" />

import type { ActionUrl, ResolveActionBody, ResolveActionParams } from 'void/routes';
import { interpolateRouteParams } from '../runtime/route-url.ts';
import {
  VoidActionError,
  isAbortError,
  isCallSiteActionError,
  type ActionResult,
} from './action-result.ts';
import {
  createPageNavigationEngine,
  type PageData,
  type PageNavigationEngineConfig,
  type PageNavigationResult,
  type VisitOptions,
  type VoidRouterAdapter as PageNavigationAdapter,
  type PrefetchOptions,
} from './navigation-engine.ts';
import { ISLAND_FRONTMATTER_ID } from './serialize.ts';
import { isSameOrigin } from './url.ts';

export { getValidationErrors, isModifiedEvent, mergeDataIntoHref } from './adapter-helpers.ts';
export {
  VoidActionError,
  categorizeActionError,
  isAbortError,
  isCallSiteActionError,
} from './action-result.ts';
export type { ActionErrorHandlingScope, ActionResult } from './action-result.ts';
export { isEqualFormValue } from './form-value-equality.ts';
export {
  cloneFormValue,
  isFormResetOptions,
  parseFormResetArgs,
  type FormResetOptions,
} from './form-reset.ts';
export { interpolateRouteParams };
export {
  createPageNavigationEngine,
  hasFiles,
  isFile,
  objectToFormData,
} from './navigation-engine.ts';
export type {
  PageNavigationEngine,
  PageNavigationResource,
  PageNavigationResult,
  PrefetchOptions,
  VisitOptions,
} from './navigation-engine.ts';

// --- Types ---

export type NavigationStateType = 'idle' | 'loading' | 'submitting';
export type NavigationMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type NavigationState = {
  state: NavigationStateType;
  location: URL | null;
  method: NavigationMethod | null;
};

export type VoidRouter = {
  _hoverDelay: number;
  readonly url: URL;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly params: Record<string, string>;
  visit(url: string | URL, options?: VisitOptions): Promise<unknown>;
  refresh(options?: VisitOptions): Promise<unknown>;
  prefetch(url: string | URL, options?: PrefetchOptions): Promise<unknown>;
  flush(url: string | URL, method?: string): void;
  flushAll(): void;
};

export type VoidRouterAdapter = PageNavigationAdapter & {
  applyUpdate(
    pageData: PageData,
    component: unknown,
    layouts: Array<unknown>,
    options: { preserveState: boolean },
  ): void | Promise<void>;
};

export type VoidRouterConfig = Omit<PageNavigationEngineConfig, 'adapter'> & {
  adapter: VoidRouterAdapter;
  onRouteChange?(url: string): void;
  onNavigationChange?(navigation: NavigationState): void;
};

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function getUrlOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}

function toUrl(value: string | URL): URL {
  return value instanceof URL ? new URL(value.href) : new URL(value || '/', getUrlOrigin());
}

function normalizeUrl(value: string | URL): string {
  if (typeof value === 'string' && value.startsWith('#')) {
    return value;
  }
  const url = toUrl(value);
  return isSameOrigin(url, getUrlOrigin()) ? url.pathname + url.search + url.hash : url.href;
}

function navigationMethod(method: string): NavigationMethod {
  const normalized = method.toUpperCase();
  if (
    normalized === 'POST' ||
    normalized === 'PUT' ||
    normalized === 'PATCH' ||
    normalized === 'DELETE'
  ) {
    return normalized;
  }
  return 'GET';
}

function navigationStateFor(url: string, method: string): NavigationState {
  const normalized = navigationMethod(method);
  return {
    state: normalized === 'GET' ? 'loading' : 'submitting',
    location: toUrl(url),
    method: normalized,
  };
}

export function idleNavigationState(): NavigationState {
  return {
    state: 'idle',
    location: null,
    method: null,
  };
}

export function createRouterFacade(
  router: VoidRouter,
  getCurrentUrl: () => string,
  getCurrentParams: () => Record<string, string> = () => router.params,
): VoidRouter {
  return {
    get _hoverDelay() {
      return router._hoverDelay;
    },

    get url() {
      return toUrl(getCurrentUrl());
    },

    get path() {
      return this.url.pathname;
    },

    get query() {
      return this.url.searchParams;
    },

    get params() {
      return getCurrentParams();
    },

    visit(url, options = {}) {
      return router.visit(url, options);
    },

    refresh(options = {}) {
      return router.refresh(options);
    },

    prefetch(url, options = {}) {
      return router.prefetch(url, options);
    },

    flush(url, method = 'GET') {
      router.flush(url, method);
    },

    flushAll() {
      router.flushAll();
    },
  };
}

export function createSsrRouter(url = '/', params: Record<string, string> = {}): VoidRouter {
  const router = {
    _hoverDelay: 75,
    get url() {
      return toUrl(url);
    },
    get path() {
      return this.url.pathname;
    },
    get query() {
      return this.url.searchParams;
    },
    get params() {
      return params;
    },
    visit() {
      throw new Error('Void Router: visit() is not available during SSR.');
    },
    refresh() {
      throw new Error('Void Router: refresh() is not available during SSR.');
    },
    prefetch() {
      throw new Error('Void Router: prefetch() is not available during SSR.');
    },
    flush() {
      throw new Error('Void Router: flush() is not available during SSR.');
    },
    flushAll() {
      throw new Error('Void Router: flushAll() is not available during SSR.');
    },
  };

  return router as VoidRouter;
}

// --- SSR proxy ---

export const ssrProxy: VoidRouter = createSsrRouter();

/** Refetch the current page in place: same history entry, URL hash, state and scroll. */
export function refreshPage(
  router: Pick<VoidRouter, 'visit'>,
  options: VisitOptions = {},
): Promise<unknown> {
  const { pathname, search, hash } = window.location;
  return router.visit(pathname + search + hash, {
    preserveState: true,
    preserveScroll: true,
    replace: true,
    ...options,
    _refresh: true,
  });
}

export async function submitAction(
  router: VoidRouter,
  url: string,
  options: VisitOptions,
): Promise<ActionResult> {
  try {
    const pageData = await router.visit(url, options);
    if (
      typeof pageData === 'object' &&
      pageData !== null &&
      'errors' in pageData &&
      pageData.errors
    ) {
      return {
        ok: false,
        error: new VoidActionError({
          body: { errors: pageData.errors as Record<string, string> },
          status: 422,
          statusText: 'Unprocessable Content',
          url,
        }),
      };
    }
    return { ok: true, pageData: pageData as PageData };
  } catch (error) {
    if (isCallSiteActionError(error)) {
      return { ok: false, error };
    }
    throw error;
  }
}

type ActionMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type HasParams<U extends string> = [ResolveActionParams<U>] extends [never] ? false : true;

type ActionOptions<U extends string> = {
  data?: ResolveActionBody<U>;
  method?: ActionMethod;
} & (HasParams<U> extends true ? { params: ResolveActionParams<U> } : { params?: never });

export type ActionClient = {
  setActionRouter(router: VoidRouter): void;
  action<U extends ActionUrl & string>(
    url: U,
    ...args: HasParams<U> extends true ? [options: ActionOptions<U>] : [options?: ActionOptions<U>]
  ): Promise<ActionResult>;
};

/** Creates an action client with its own router for each framework adapter. */
export function createActionClient(): ActionClient {
  let _router: VoidRouter | null = null;

  /** Called during app initialization to store the router instance */
  function setActionRouter(router: VoidRouter): void {
    _router = router;
  }

  /** Programmatic page action call with a router update */
  async function action<U extends ActionUrl & string>(
    url: U,
    ...args: HasParams<U> extends true ? [options: ActionOptions<U>] : [options?: ActionOptions<U>]
  ): Promise<ActionResult> {
    if (!_router) {
      throw new Error('action(): called before router initialization.');
    }

    const options = args[0] as ActionOptions<U> | undefined;
    const data = options?.data;
    const method = options?.method || 'POST';

    const resolvedUrl = interpolateRouteParams(
      url,
      options?.params as Record<string, string> | undefined,
    );
    return submitAction(_router, resolvedUrl, { method, data });
  }

  return { action, setActionRouter };
}

// --- createVoidRouter factory ---

export async function createVoidRouter(config: VoidRouterConfig): Promise<{
  router: VoidRouter;
  initialPageData: PageData;
  initialComponent: unknown;
  initialLayouts: Array<unknown>;
  start(): void;
  commitInitialRender(): void;
}> {
  const engine = await createPageNavigationEngine(config);
  let routeUrl = currentUrl();
  let routeParams = engine.initialPageData.params ?? {};
  let activeNavigationId: number | null = null;
  // The page in the address bar, and the page on screen. They differ while a visit has
  // rendered but not committed, and after its commit fails.
  type RenderedPage = Pick<PageNavigationResult, 'pageData' | 'component' | 'layouts'>;
  let committedPage: RenderedPage = {
    pageData: engine.initialPageData,
    component: engine.initialComponent,
    layouts: engine.initialLayouts,
  };
  let renderedPage = committedPage;
  // Set when the page on screen is one whose commit failed; the last visit to settle puts
  // the committed page back.
  let failedRender: { preserveState: boolean } | null = null;
  const setRouteState = (url: string, params: Record<string, string> = routeParams) => {
    routeUrl = url;
    routeParams = params;
    config.onRouteChange?.(url);
  };
  const setNavigation = (navigation: NavigationState) => {
    config.onNavigationChange?.(navigation);
  };

  async function applyNavigationResource(resource: ReturnType<typeof engine.prepareVisit>) {
    activeNavigationId = resource.id;
    setNavigation(navigationStateFor(resource.fetchUrl + resource.hash, resource.method));
    try {
      const result = await resource.shell;
      if (!result) {
        return undefined;
      }

      setRouteState(
        result.pageData.url || resource.fetchUrl + resource.hash,
        result.pageData.params ?? {},
      );

      const preserveState = resource.options.preserveState ?? resource.method !== 'GET';
      const applyUpdate = () => {
        renderedPage = result;
        failedRender = null;
        return config.adapter.applyUpdate(result.pageData, result.component, result.layouts, {
          preserveState,
        });
      };

      let applied = true;
      const useTransition = resource.options.viewTransition ?? config.viewTransitions;
      if (useTransition && document.startViewTransition) {
        // The callback runs on a later frame. A newer visit started by then renders instead.
        const transition = document.startViewTransition(() => {
          if (activeNavigationId !== resource.id) {
            applied = false;
            return;
          }
          return applyUpdate();
        });
        await transition.updateCallbackDone;
      } else {
        await applyUpdate();
      }

      // A newer visit can commit while this page is being applied; its URL stays.
      let committed = false;
      if (applied) {
        try {
          committed = await resource.commit();
        } catch (error) {
          if (renderedPage === result) {
            failedRender = { preserveState };
          }
          throw error;
        }
      }
      if (!committed) {
        throw new DOMException('Navigation aborted', 'AbortError');
      }
      committedPage = result;
      if (renderedPage === result) {
        failedRender = null;
      }
      if (activeNavigationId === resource.id) {
        setRouteState(currentUrl(), result.pageData.params ?? {});
      }
      return result.pageData;
    } catch (error) {
      if (
        resource.method.toUpperCase() === 'GET' &&
        !resource.options._resolveOnShell &&
        isAbortError(error)
      ) {
        return undefined;
      }
      throw error;
    } finally {
      // A same-page hash visit can settle before this one, so no visit may be active.
      const ownsNavigation = activeNavigationId === resource.id;
      if (ownsNavigation || activeNavigationId === null) {
        let restored = false;
        if (failedRender && renderedPage !== committedPage) {
          const { preserveState } = failedRender;
          failedRender = null;
          renderedPage = committedPage;
          restored = true;
          const page = committedPage;
          try {
            await config.adapter.applyUpdate(page.pageData, page.component, page.layouts, {
              preserveState,
            });
          } catch (error) {
            // The visit already rejects with the history error; keep that one.
            reportError(error);
          }
        }
        // A newer visit may have started while the committed page was applied.
        if (ownsNavigation && activeNavigationId === resource.id) {
          activeNavigationId = null;
          setRouteState(currentUrl(), restored ? (committedPage.pageData.params ?? {}) : undefined);
          setNavigation(idleNavigationState());
        } else if (restored && activeNavigationId === null) {
          setRouteState(currentUrl(), committedPage.pageData.params ?? {});
        }
      }
    }
  }

  const router: VoidRouter = {
    _hoverDelay: engine._hoverDelay,

    get url() {
      return toUrl(routeUrl);
    },

    get path() {
      return this.url.pathname;
    },

    get query() {
      return this.url.searchParams;
    },

    get params() {
      return routeParams;
    },

    visit(url, options = {}) {
      const resource = engine.prepareVisit(normalizeUrl(url), options);
      return applyNavigationResource(resource);
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

  engine.setPopStateHandler((url, options) => {
    router.visit(url, options);
  });

  return {
    router,
    initialPageData: engine.initialPageData,
    initialComponent: engine.initialComponent,
    initialLayouts: engine.initialLayouts,
    start: engine.start,
    commitInitialRender: engine.commitInitialRender,
  };
}

// --- Island hydration ---

export function scheduleHydration(
  el: Element,
  loader: () => Promise<unknown>,
  props: Record<string, unknown>,
  strategy: string,
  hydrateFn: (el: Element, mod: unknown, props: Record<string, unknown>) => void | Promise<void>,
): void {
  const hydrate = () => loader().then((mod) => hydrateFn(el, mod, props));

  if (strategy === 'load') {
    hydrate();
  } else if (strategy === 'visible') {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        observer.disconnect();
        hydrate();
      }
    });
    observer.observe(el);
  } else if (strategy === 'idle') {
    const schedule =
      window.requestIdleCallback?.bind(window) ?? ((cb: () => void) => setTimeout(cb, 1));
    schedule(() => hydrate());
  } else if (strategy.startsWith('media:')) {
    const query = strategy.slice(6);
    const mql = matchMedia(query);
    const check = () => {
      if (mql.matches) {
        mql.removeEventListener('change', check);
        hydrate();
      }
    };
    mql.addEventListener('change', check);
    check();
  }
}

export function initIslands(
  islands: Record<string, () => Promise<unknown>>,
  hydrateFn: (
    el: Element,
    mod: unknown,
    props: Record<string, unknown>,
    frontmatter: Record<string, unknown>,
  ) => void | Promise<void>,
): void {
  // Islands hydrate as separate roots, so they read the page frontmatter here
  // to match what useFrontmatter() returned during server rendering.
  const frontmatterText = document.getElementById(ISLAND_FRONTMATTER_ID)?.textContent;
  const frontmatter = frontmatterText ? JSON.parse(frontmatterText) : {};
  const hydrate = (el: Element, mod: unknown, props: Record<string, unknown>) =>
    hydrateFn(el, mod, props, frontmatter);
  document.querySelectorAll('[data-island]').forEach((el) => {
    const id = el.getAttribute('data-island')!;
    const props = JSON.parse(el.getAttribute('data-props') || '{}');
    const strategy = el.getAttribute('data-hydrate') || 'load';
    const loader = islands[id];
    if (loader) {
      scheduleHydration(el, loader, props, strategy, hydrate);
    }
  });
}

export {
  formErrorMessage,
  formRetryMessage,
  formSubmissionBlocked,
  scheduleFormRetry,
  type FormModel,
  type FormMethod,
} from './form-presentation.ts';
