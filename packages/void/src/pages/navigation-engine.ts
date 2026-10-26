/// <reference lib="dom" />

import { searchWithoutActionKey } from './action-key.ts';
import { createActionErrorFromResponse, isAbortError } from './action-result.ts';
import { initClientHead, applyClientHead } from './head-client.ts';
import type { HeadDescriptor } from './head.ts';
import { PrefetchCache, parseCacheFor } from './prefetch.ts';
import type { CacheForInput, CacheForResult } from './prefetch.ts';
import type { PageObject } from './protocol.ts';
import { createScrollRestoration } from './scroll-restoration.ts';
import { decodePagePath, isSameOrigin } from './url.ts';

/**
 * The server leaves a named action's key out of the page URL. When the page URL
 * shows that, drop the key from the URL written to history as well.
 * Otherwise keep the requested URL: the page URL may reflect a server rewrite.
 */
function withoutActionKey(fetchUrl: string, pageUrl: string): string {
  const q = fetchUrl.indexOf('?');
  if (q === -1) {
    return fetchUrl;
  }
  const search = searchWithoutActionKey(fetchUrl.slice(q));
  const pageQ = pageUrl.indexOf('?');
  return search === (pageQ === -1 ? '' : pageUrl.slice(pageQ))
    ? fetchUrl.slice(0, q) + search
    : fetchUrl;
}

export type PageComponentModule = {
  default: unknown;
};

export type PageData = PageObject;

type DeferredWindow = Window & {
  __resolveDeferred?: (group: string, data: unknown) => void;
  __rejectDeferred?: (group: string, error: unknown) => void;
  __deferredQueue?: Array<[string, unknown] | [string, 0, unknown]>;
};

type PageFetchOptions = RequestInit & { headers: Record<string, string> };

type StaticPageDataResult = { pageData: PageData; resolvedDeferred: boolean };

export type VisitOptions = {
  method?: string;
  data?: unknown;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  viewTransition?: boolean;
  /** @internal Used by React Actions to avoid waiting for a commit blocked by the action itself. */
  _resolveOnShell?: boolean;
  /** @internal Used by popstate handler to pass saved scroll position */
  _scrollPosition?: { x: number; y: number } | null;
  /** @internal Used by popstate handler to avoid writing history while traversing */
  _popstate?: boolean;
  /** @internal Used by router.refresh() to refetch the current URL even when it has a hash */
  _refresh?: boolean;
};

export type PrefetchOptions = {
  method?: string;
  cacheFor?: CacheForInput;
};

export type VoidRouterAdapter = {
  createDeferred(): unknown;
  resolveDeferred(ref: unknown, value: unknown): unknown;
  rejectDeferred(ref: unknown, error: string): unknown;
  isLoading(ref: unknown): boolean;
  onDeferredUpdate?(props: Record<string, unknown>): void;
};

export type PageNavigationEngineConfig = {
  adapter: VoidRouterAdapter;
  components: Record<string, () => Promise<PageComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  routeMeta: Record<string, { island?: boolean }>;
  /** Page id for a decoded pathname (see `decodePagePath`). */
  matchRoute(path: string): string | null;
  staticPageData?: boolean;
  staticPageDataFastPath?: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
  /** Reuse successful GET page shells on later visits, refreshing stale shells in the background. */
  cacheVisitedPageData?: boolean;
};

export type PageNavigationResult = {
  pageData: PageData;
  component: unknown;
  layouts: Array<unknown>;
};

export type PageNavigationResource = {
  id: number;
  url: string;
  fetchUrl: string;
  hash: string;
  method: string;
  options: VisitOptions;
  immediate: boolean;
  shell: Promise<PageNavigationResult | undefined>;
  abort(): void;
  /** Resolves false when a newer visit has already set the URL, so nothing was committed. */
  commit(): Promise<boolean>;
  dispose(): void;
};

export type PageNavigationEngine = {
  _hoverDelay: number;
  initialPageData: PageData;
  initialComponent: unknown;
  initialLayouts: Array<unknown>;
  prepareVisit(url: string, options?: VisitOptions): PageNavigationResource;
  prefetch(url: string, options?: PrefetchOptions): Promise<unknown>;
  flush(url: string, method?: string): void;
  flushAll(): void;
  setPopStateHandler(handler: (url: string, options: VisitOptions) => void): void;
  start(): void;
  /** Called after the adapter commits the initial page DOM. */
  commitInitialRender(): void;
};

const PAGE_DATA_SCRIPT_ID = '__VOID_PAGE_DATA__';
const STATIC_PAGE_DATA_PREFIX = '/_void/pages';

export function isFile(value: unknown): boolean {
  return (
    (typeof File !== 'undefined' && value instanceof File) ||
    value instanceof Blob ||
    (typeof FileList !== 'undefined' && value instanceof FileList && value.length > 0)
  );
}

export function hasFiles(data: unknown): boolean {
  return (
    isFile(data) ||
    (typeof data === 'object' && data !== null && Object.values(data).some(hasFiles))
  );
}

export function objectToFormData(
  source: Record<string, unknown>,
  form?: FormData,
  parentKey?: string,
): FormData {
  form = form || new FormData();
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const composed = parentKey ? parentKey + '[' + key + ']' : key;
    const value = source[key];
    if (value instanceof File) {
      form.append(composed, value, value.name);
    } else if (value instanceof Blob) {
      form.append(composed, value);
    } else if (typeof FileList !== 'undefined' && value instanceof FileList) {
      for (let i = 0; i < value.length; i++) {
        form.append(composed + '[]', value[i], value[i].name);
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        objectToFormData({ [i]: value[i] }, form, composed);
      }
    } else if (value instanceof Date) {
      form.append(composed, value.toISOString());
    } else if (typeof value === 'boolean') {
      form.append(composed, value ? '1' : '0');
    } else if (typeof value === 'string') {
      form.append(composed, value);
    } else if (typeof value === 'number') {
      form.append(composed, String(value));
    } else if (value === null || value === undefined) {
      form.append(composed, '');
    } else {
      objectToFormData(value as Record<string, unknown>, form, composed);
    }
  }
  return form;
}

function clonePageData(pageData: PageData): PageData {
  return JSON.parse(JSON.stringify(pageData)) as PageData;
}

function readInitialPageData(): PageData {
  const scriptEl = document.getElementById(PAGE_DATA_SCRIPT_ID);
  if (scriptEl?.textContent) {
    return JSON.parse(scriptEl.textContent) as PageData;
  }

  throw new Error('pages: Missing initial page payload.');
}

function parsePageDataFromHtml(html: string): PageData | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scriptEl = doc.getElementById(PAGE_DATA_SCRIPT_ID);
  if (!scriptEl?.textContent) {
    return null;
  }
  try {
    return JSON.parse(scriptEl.textContent) as PageData;
  } catch {
    return null;
  }
}

function abortError(): DOMException {
  return new DOMException('Navigation aborted', 'AbortError');
}

function abortSignalPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

async function fetchPageResponse(fetchUrl: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(fetchUrl, init);
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) {
      throw abortError();
    }
    return null;
  }
}

export async function createPageNavigationEngine(
  config: PageNavigationEngineConfig,
): Promise<PageNavigationEngine> {
  const {
    adapter,
    components,
    layoutTree,
    routeMeta,
    staticPageData: STATIC_PAGE_DATA_ENABLED = false,
    staticPageDataFastPath: STATIC_PAGE_DATA_FAST_PATH = STATIC_PAGE_DATA_ENABLED,
    prefetchHoverDelay: PREFETCH_HOVER_DELAY,
    prefetchDefaultCacheFor: PREFETCH_DEFAULT_CACHE_FOR,
    cacheVisitedPageData: CACHE_VISITED_PAGE_DATA = false,
  } = config;

  const matchRoute = (url: string) =>
    config.matchRoute(decodePagePath(new URL(url, 'http://x').pathname));

  const _prefetchCache = new PrefetchCache();
  let _nextNavigationId = 0;
  // The newest visit whose URL is in the address bar: the last commit, or a back/forward
  // visit, which the browser has already moved to. An older visit must not commit over it.
  let _urlNavigationId = 0;
  let _pendingResource: PageNavigationResource | null = null;
  let _committedResource: PageNavigationResource | null = null;
  let _committedDeferredRegistry: DeferredRegistry | null = null;
  let _htmlDeferredRegistry: DeferredRegistry | null = null;
  let _currentFetchUrl = window.location.pathname + window.location.search;
  let popStateHandler: ((url: string, options: VisitOptions) => void) | null = null;
  let initialScrollPosition: { x: number; y: number } | null = null;
  const initialUrl = window.location.pathname + window.location.search + window.location.hash;
  const scrollRestoration = createScrollRestoration();

  async function resolveComponent(id: string): Promise<unknown> {
    const loader = components[id];
    if (!loader) {
      throw new Error(`pages: Unknown page component '${id}'.`);
    }
    return (await loader()).default;
  }

  async function resolveLayouts(componentId: string): Promise<Array<unknown>> {
    const ids = layoutTree[componentId] || [];
    return Promise.all(ids.map(async (id: string) => (await components[id]()).default));
  }

  function getStaticPageDataUrl(url: string): string {
    const { pathname } = new URL(url || '/', window.location.origin);
    const filePath = pathname === '/' ? 'index' : pathname.replace(/^\/+/, '');
    return `${STATIC_PAGE_DATA_PREFIX}/${filePath}.json`;
  }

  function isUsablePageData(pageData: unknown, matchedId: string): pageData is PageData {
    return (
      typeof pageData === 'object' &&
      pageData !== null &&
      'component' in pageData &&
      typeof pageData.component === 'string' &&
      'props' in pageData &&
      typeof pageData.props === 'object' &&
      pageData.props !== null &&
      pageData.component === matchedId &&
      !routeMeta[pageData.component]?.island &&
      Boolean(components[pageData.component])
    );
  }

  class DeferredRegistry {
    private active = true;
    private keyRefs: Record<string, unknown> = {};
    private props: Record<string, unknown> = {};
    private groups: Record<string, Array<string>> = {};
    private preservedSource: DeferredRegistry | null = null;
    private preservedKeys: Set<string> | null = null;

    /** Create a deferred ref per key; `resolved` payloads already carry the values inline. */
    setup(pageData: PageData, resolved = false): void {
      this.props = pageData.props;
      this.keyRefs = {};
      this.groups = {};

      if (!pageData.deferredKeys) {
        return;
      }

      for (const [key, group] of Object.entries(pageData.deferredKeys) as Array<[string, string]>) {
        let value = adapter.createDeferred();
        if (resolved) {
          const error = pageData.deferredErrors?.[group];
          value =
            error === undefined
              ? adapter.resolveDeferred(value, pageData.props[key])
              : adapter.rejectDeferred(value, error);
        }
        this.keyRefs[key] = value;
        this.props[key] = value;
        (this.groups[group] ??= []).push(key);
      }
    }

    preserveValuesFrom(source: DeferredRegistry | null, pageData: PageData): void {
      if (!source) {
        return;
      }
      const keys = source.applyPreservedValues(pageData);
      if (keys) {
        this.preservedSource = source;
        this.preservedKeys = keys;
      }
    }

    commitPreservedValues(
      source: DeferredRegistry | null,
      pageData: PageData,
    ): DeferredRegistry | null {
      if (!this.preservedSource || this.preservedSource !== source || !this.preservedKeys) {
        return null;
      }
      this.preservedSource.retainOnly(this.preservedKeys, pageData.props);
      return this.preservedSource;
    }

    private applyPreservedValues(pageData: PageData): Set<string> | null {
      let keys: Set<string> | null = null;
      for (const key of Object.keys(this.keyRefs)) {
        if (pageData.props[key] === null && this.props[key] !== undefined) {
          pageData.props[key] = this.props[key];
          (keys ??= new Set()).add(key);
        }
      }
      return keys;
    }

    resolve(group: string, data: unknown, error: unknown): void {
      if (!this.active) {
        return;
      }

      if (data !== undefined) {
        this.resolveGroup(group, data);
      } else if (error !== undefined) {
        this.rejectGroup(group, typeof error === 'string' ? error : String(error));
      }

      adapter.onDeferredUpdate?.(this.props);
    }

    rejectPending(error: string, notify = true): void {
      if (!this.active) {
        return;
      }

      for (const [key, ref] of Object.entries(this.keyRefs)) {
        if (adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, error);
          this.keyRefs[key] = updated;
          this.props[key] = updated;
        }
      }
      if (notify) {
        adapter.onDeferredUpdate?.(this.props);
      }
    }

    dispose(): void {
      if (!this.active) {
        return;
      }
      this.rejectPending('Navigation disposed before deferred props resolved', false);
      this.active = false;
    }

    private retainOnly(keys: Set<string>, props: Record<string, unknown>): void {
      const keyRefs: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(this.keyRefs)) {
        if (keys.has(key)) {
          keyRefs[key] = ref;
          props[key] = this.props[key];
        } else if (adapter.isLoading(ref)) {
          adapter.rejectDeferred(ref, 'Navigation disposed before deferred props resolved');
        }
      }
      // Groups keep every key so a group resolves with its original shape.
      // Keys dropped from keyRefs are skipped when the group settles.
      this.props = props;
      this.keyRefs = keyRefs;
      adapter.onDeferredUpdate?.(this.props);
    }

    /** A one-key group takes the raw value; a larger group takes each key from the object. */
    private resolveGroup(group: string, data: unknown): void {
      const keys = this.groups[group] ?? (this.keyRefs[group] ? [group] : []);
      if (keys.length === 1) {
        this.resolveKey(keys[0]!, data);
        return;
      }
      const values =
        typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
      for (const key of keys) {
        this.resolveKey(key, values[key]);
      }
    }

    private resolveKey(key: string, value: unknown): void {
      const ref = this.keyRefs[key];
      if (!ref || !adapter.isLoading(ref)) {
        return;
      }
      const updated = adapter.resolveDeferred(ref, value);
      this.keyRefs[key] = updated;
      this.props[key] = updated;
    }

    private rejectGroup(group: string, error: string): void {
      const keys = this.groups[group] ?? Object.keys(this.keyRefs);
      for (const key of keys) {
        const ref = this.keyRefs[key];
        if (ref && adapter.isLoading(ref)) {
          const updated = adapter.rejectDeferred(ref, error);
          this.keyRefs[key] = updated;
          this.props[key] = updated;
        }
      }
    }
  }

  const _resourceDeferredRegistries = new WeakMap<PageNavigationResource, DeferredRegistry>();
  const _preservedDeferredResources = new WeakMap<DeferredRegistry, PageNavigationResource>();

  /** Route id for a non-island page that static page data can serve, or null. */
  function matchStaticPageId(fetchUrl: string): string | null {
    const matchedId = matchRoute(fetchUrl || window.location.pathname + window.location.search);
    return matchedId && !routeMeta[matchedId]?.island && components[matchedId] ? matchedId : null;
  }

  async function loadStaticPageDataFile(
    fetchUrl: string,
    signal?: AbortSignal,
  ): Promise<StaticPageDataResult | null> {
    const matchedId = matchStaticPageId(fetchUrl);
    if (!matchedId) {
      return null;
    }

    try {
      const pageDataResponse = await fetch(getStaticPageDataUrl(fetchUrl), {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (pageDataResponse.ok) {
        const pageData = await pageDataResponse.json();
        if (isUsablePageData(pageData, matchedId)) {
          return { pageData, resolvedDeferred: true };
        }
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw abortError();
      }
    }

    return null;
  }

  async function loadStaticPageData(
    fetchUrl: string,
    response: Response,
    signal?: AbortSignal,
    verifyPageResponse = false,
  ): Promise<StaticPageDataResult | null> {
    if (!response.ok) {
      return null;
    }

    const matchedId = matchStaticPageId(fetchUrl);
    if (!matchedId) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.includes('text/html')) {
      return null;
    }

    if (verifyPageResponse) {
      const pageData = parsePageDataFromHtml(await response.text());
      if (!isUsablePageData(pageData, matchedId)) {
        return null;
      }
      if (!pageData.deferredKeys) {
        return { pageData, resolvedDeferred: false };
      }
      return loadStaticPageDataFile(fetchUrl, signal);
    }

    const filePageData = await loadStaticPageDataFile(fetchUrl, signal);
    if (filePageData) {
      return filePageData;
    }

    const pageData = parsePageDataFromHtml(await response.text());
    if (!isUsablePageData(pageData, matchedId) || pageData.deferredKeys) {
      return null;
    }
    return { pageData, resolvedDeferred: false };
  }

  /** Fetch page data for the prefetch cache; null means "fall back to a full page load". */
  function fetchPrefetchPageData(url: string): Promise<unknown> {
    const headers = {
      'X-VoidPages': 'true',
      Accept: 'application/json',
      Purpose: 'prefetch',
    };
    return (
      STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH
        ? loadStaticPageDataFile(url).then((result) => result?.pageData)
        : Promise.resolve(undefined)
    ).then((pageData) => {
      if (pageData !== undefined) {
        return pageData;
      }
      return fetchPageResponse(url, { method: 'GET', headers }).then(async (r) => {
        if (!r || r.redirected) {
          return null;
        }
        if (!r.headers.get('X-VoidPages')) {
          return (
            (await loadStaticPageData(url, r, undefined, !STATIC_PAGE_DATA_FAST_PATH))?.pageData ??
            null
          );
        }
        return r.json();
      });
    });
  }

  function restoreScroll(scrollPosition: VisitOptions['_scrollPosition'], hash: string): void {
    if (scrollPosition) {
      window.scrollTo(scrollPosition.x, scrollPosition.y);
      return;
    }
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, 0);
  }

  const deferredWindow = window as DeferredWindow;
  deferredWindow.__resolveDeferred = (group: string, data: unknown) =>
    _htmlDeferredRegistry?.resolve(group, data, undefined);
  deferredWindow.__rejectDeferred = (group: string, error: unknown) =>
    _htmlDeferredRegistry?.resolve(group, undefined, error);

  function commitHashNavigation(
    effectiveFetchUrl: string,
    hash: string,
    options: VisitOptions,
    writeHistory: boolean,
  ): void {
    if (writeHistory) {
      scrollRestoration.writeHistory(effectiveFetchUrl + hash, !!options.replace);
    }
    _currentFetchUrl = effectiveFetchUrl;
    scrollRestoration.commit();
    restoreScroll(options._scrollPosition, hash);
  }

  async function loadNavigationShell(
    id: number,
    url: string,
    fetchUrl: string,
    method: string,
    options: VisitOptions,
    signal: AbortSignal,
    commitTarget: { fetchUrl: string; hash: string },
    deferredRegistry: DeferredRegistry,
  ): Promise<PageNavigationResult | undefined> {
    // Page data only comes from this origin. Other http(s) URLs get a full page
    // load. Capacitor's iOS WebView uses capacitor: for local pages.
    // Unsafe schemes (javascript:, data:, ...) must never reach location.href.
    // Check the scheme first: a blob: URL reports the origin that created it.
    const target = new URL(url, window.location.origin);
    if (
      target.protocol !== 'http:' &&
      target.protocol !== 'https:' &&
      target.protocol !== 'capacitor:'
    ) {
      throw new Error(`Void Router: refusing to navigate to a ${target.protocol} URL.`);
    }
    if (!isSameOrigin(target, window.location.origin)) {
      if (method !== 'GET') {
        throw new Error('Void Router: non-GET visits must target the current origin.');
      }
      window.location.href = url;
      return undefined;
    }

    if (method !== 'GET') {
      _prefetchCache.flushAll();
    }

    const headers: Record<string, string> = {
      'X-VoidPages': 'true',
      Accept: 'application/json',
    };
    const fetchOptions: PageFetchOptions = { method, headers, signal };

    if (options.data && method !== 'GET') {
      if (hasFiles(options.data)) {
        fetchOptions.body = objectToFormData(options.data as Record<string, unknown>);
      } else {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(options.data);
      }
    }

    let pageData: PageData | undefined;
    const cacheEntry = method === 'GET' ? _prefetchCache.get(fetchUrl, method) : null;

    if (cacheEntry) {
      const cachedPageData = await cacheEntry.response;
      _prefetchCache.consume(fetchUrl, method);
      if (cachedPageData === null) {
        window.location.href = url;
        return undefined;
      }
      // Deferred initialization and adapters mutate props; retain the cached wire payload.
      pageData = clonePageData(cachedPageData as PageData);
      deferredRegistry.setup(pageData, true);
      if (!_prefetchCache.isFresh(cacheEntry)) {
        const bgFetch = fetchPrefetchPageData(fetchUrl);
        // Drop the stale entry so the revalidated data lands (set() won't overwrite a usable one).
        _prefetchCache.flush(fetchUrl, method);
        _prefetchCache.set(fetchUrl, method, bgFetch, PREFETCH_DEFAULT_CACHE_FOR);
      }
    } else {
      if (method === 'GET' && STATIC_PAGE_DATA_ENABLED && STATIC_PAGE_DATA_FAST_PATH) {
        const staticPageData = await loadStaticPageDataFile(fetchUrl, signal);
        if (staticPageData) {
          pageData = staticPageData.pageData;
          _prefetchCache.set(
            fetchUrl,
            method,
            Promise.resolve(clonePageData(pageData)),
            PREFETCH_DEFAULT_CACHE_FOR,
          );
          deferredRegistry.setup(pageData, staticPageData.resolvedDeferred);
        }
      }

      const response =
        pageData === undefined
          ? method === 'GET'
            ? await fetchPageResponse(fetchUrl, fetchOptions)
            : await fetch(fetchUrl, fetchOptions)
          : null;

      if (pageData === undefined && !response) {
        window.location.href = url;
        return undefined;
      }

      if (response?.redirected) {
        const redirectUrl = new URL(response.url, window.location.origin);
        if (!isSameOrigin(redirectUrl, window.location.origin)) {
          window.location.href = method === 'GET' ? url : response.url;
          return undefined;
        }
        // The browser already followed the redirect: treat the final response as the GET
        // result for the destination instead of fetching it a second time.
        method = 'GET';
        fetchUrl = redirectUrl.pathname + redirectUrl.search;
        url = fetchUrl + redirectUrl.hash;
        commitTarget.fetchUrl = fetchUrl;
        commitTarget.hash = redirectUrl.hash;
      }

      if (response && method !== 'GET' && !response.ok) {
        throw await createActionErrorFromResponse(response, fetchUrl);
      }

      if (response && !response.headers.get('X-VoidPages')) {
        if (method === 'GET') {
          const staticPageData = await loadStaticPageData(
            fetchUrl,
            response,
            signal,
            !STATIC_PAGE_DATA_FAST_PATH,
          );
          if (staticPageData) {
            pageData = staticPageData.pageData;
            deferredRegistry.setup(pageData, staticPageData.resolvedDeferred);
          } else {
            window.location.href = url;
            return undefined;
          }
        } else {
          window.location.href = url;
          return undefined;
        }
      }

      const contentType = response?.headers.get('content-type') || '';

      if (pageData !== undefined) {
        // Static page-data fallback already loaded the page object.
      } else if (contentType.includes('application/x-ndjson')) {
        const reader = response!.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstLine = true;

        const processLines = () => {
          let newlineIdx;
          while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) {
              continue;
            }

            if (firstLine) {
              pageData = JSON.parse(line) as PageData;
              deferredRegistry.setup(pageData);
              firstLine = false;
            } else {
              const msg = JSON.parse(line);
              if (msg.__deferred) {
                deferredRegistry.resolve(msg.__deferred, msg.data, msg.error);
              }
            }
          }
        };

        while (firstLine) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          processLines();
        }

        (async () => {
          try {
            while (!signal.aborted) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              buffer += decoder.decode(value, { stream: true });
              processLines();
            }
          } catch (e: unknown) {
            if (!(e instanceof Error) || e.name !== 'AbortError') {
              deferredRegistry.rejectPending('Stream closed before resolution');
            }
          }
        })();
      } else {
        pageData = (await response!.json()) as PageData;
        deferredRegistry.setup(pageData);
      }

      if (
        CACHE_VISITED_PAGE_DATA &&
        method === 'GET' &&
        response?.ok &&
        response.headers.get('X-VoidPages') &&
        pageData?.component === matchRoute(fetchUrl) &&
        !pageData.deferredKeys
      ) {
        _prefetchCache.set(
          fetchUrl,
          method,
          Promise.resolve(clonePageData(pageData)),
          PREFETCH_DEFAULT_CACHE_FOR,
        );
      }
    }

    if (!pageData) {
      throw new Error('pages: Missing page payload.');
    }

    if (method !== 'GET') {
      deferredRegistry.preserveValuesFrom(_committedDeferredRegistry, pageData);
      commitTarget.fetchUrl = withoutActionKey(fetchUrl, pageData.url);
    }

    const [component, layouts] = await Promise.race([
      Promise.all([resolveComponent(pageData.component), resolveLayouts(pageData.component)]),
      abortSignalPromise(signal),
    ]);

    if (id !== _nextNavigationId && signal.aborted) {
      throw abortError();
    }

    return { pageData, component, layouts };
  }

  function makeCommit(
    commitTarget: { fetchUrl: string; hash: string },
    options: VisitOptions,
    shell: Promise<PageNavigationResult | undefined>,
    deferredRegistry: DeferredRegistry,
    resourceId: number,
    getResource: () => PageNavigationResource,
  ): () => Promise<boolean> {
    let committed = false;
    return async () => {
      if (committed) {
        return false;
      }
      committed = true;
      const result = await shell;
      if (!result) {
        return false;
      }
      // A newer visit committed while this one was being applied. Committing now would put
      // back this page's URL, head, scroll and Deferred ownership over the newer page.
      if (resourceId < _urlNavigationId) {
        return false;
      }
      // Write history before anything else changes. Disposing the previous page and handing
      // over its Deferred values cannot be undone, so a failed write must find them untouched.
      // preserveState only controls component state; back/forward traversal already moved history.
      if (!options._popstate) {
        const historyUrl = commitTarget.fetchUrl + commitTarget.hash;
        const resource = getResource();
        const currentDocumentUrl = window.location.pathname + window.location.search;
        const replaceHistory =
          !!options.replace ||
          (resource.method !== 'GET' && historyUrl === currentDocumentUrl + commitTarget.hash);
        try {
          scrollRestoration.writeHistory(historyUrl, replaceHistory);
        } catch (error) {
          if (_pendingResource?.id === resourceId) {
            _pendingResource = null;
          }
          resource.dispose();
          throw error;
        }
      }
      _urlNavigationId = resourceId;
      if (_pendingResource?.id === resourceId) {
        _pendingResource = null;
      }
      const previousResource = _committedResource;
      const previousDeferredRegistry = _committedDeferredRegistry;
      const preservedDeferredRegistry = deferredRegistry.commitPreservedValues(
        previousDeferredRegistry,
        result.pageData,
      );
      _committedResource = getResource();
      const previousResourceOwnsPreservedRegistry = Boolean(
        previousResource &&
        preservedDeferredRegistry &&
        _resourceDeferredRegistries.get(previousResource) === preservedDeferredRegistry,
      );
      if (
        previousResource &&
        previousResource !== _committedResource &&
        !previousResourceOwnsPreservedRegistry
      ) {
        previousResource.dispose();
      }
      if (previousResource && preservedDeferredRegistry && previousResourceOwnsPreservedRegistry) {
        _preservedDeferredResources.set(preservedDeferredRegistry, previousResource);
      }
      _committedDeferredRegistry = preservedDeferredRegistry ?? deferredRegistry;
      const preservedDeferredResource = previousDeferredRegistry
        ? _preservedDeferredResources.get(previousDeferredRegistry)
        : undefined;
      if (previousDeferredRegistry && previousDeferredRegistry !== _committedDeferredRegistry) {
        previousDeferredRegistry.dispose();
        if (
          preservedDeferredResource &&
          preservedDeferredResource !== previousResource &&
          preservedDeferredResource !== _committedResource
        ) {
          preservedDeferredResource.dispose();
        }
        _preservedDeferredResources.delete(previousDeferredRegistry);
      }
      if (preservedDeferredRegistry && preservedDeferredRegistry !== deferredRegistry) {
        deferredRegistry.dispose();
      }
      applyClientHead(result.pageData.head as HeadDescriptor | undefined);
      _currentFetchUrl = commitTarget.fetchUrl;
      scrollRestoration.commit();

      requestAnimationFrame(() => {
        if (!options.preserveScroll) {
          restoreScroll(options._scrollPosition, commitTarget.hash);
        }
      });
      return true;
    };
  }

  const initialPageData = readInitialPageData();
  const [initialComponent, initialLayouts] = await Promise.all([
    resolveComponent(initialPageData.component),
    resolveLayouts(initialPageData.component),
  ]);

  if (
    CACHE_VISITED_PAGE_DATA &&
    initialPageData.url === _currentFetchUrl &&
    initialPageData.component === matchRoute(_currentFetchUrl) &&
    initialPageData.errors === null &&
    !initialPageData.deferredKeys
  ) {
    _prefetchCache.set(
      _currentFetchUrl,
      'GET',
      Promise.resolve(clonePageData(initialPageData)),
      PREFETCH_DEFAULT_CACHE_FOR,
    );
  }

  const initialDeferredRegistry = new DeferredRegistry();
  initialDeferredRegistry.setup(initialPageData);
  _committedDeferredRegistry = initialDeferredRegistry;
  _htmlDeferredRegistry = initialDeferredRegistry;

  const engine: PageNavigationEngine = {
    _hoverDelay: PREFETCH_HOVER_DELAY,
    initialPageData,
    initialComponent,
    initialLayouts,

    prepareVisit(url, options = {}) {
      if (!options._popstate) {
        // Capture the departing page before an adapter replaces or shrinks its DOM.
        scrollRestoration.save();
      }
      const hashIndex = url.indexOf('#');
      const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
      const fetchUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;
      const currentPath = window.location.pathname + window.location.search;
      const effectiveFetchUrl = fetchUrl || currentPath;
      const method = (options.method || 'GET').toUpperCase();
      const id = ++_nextNavigationId;
      const hashNavigationBaseUrl = options._popstate ? _currentFetchUrl : currentPath;

      _pendingResource?.abort();
      _pendingResource = null;

      const isSamePageHashNavigation =
        !options._refresh &&
        effectiveFetchUrl === hashNavigationBaseUrl &&
        method === 'GET' &&
        !options.data &&
        Boolean(hash || options._popstate);

      if (isSamePageHashNavigation) {
        // A failed history write ends this visit like any other failed visit: through its shell.
        let shell: Promise<undefined> = Promise.resolve(undefined);
        try {
          commitHashNavigation(effectiveFetchUrl, hash, options, !options._popstate);
        } catch (error) {
          shell = Promise.reject(error);
        }
        return {
          id,
          url,
          fetchUrl: effectiveFetchUrl,
          hash,
          method,
          options,
          immediate: true,
          shell,
          abort() {},
          // Same-page hash visits commit right away. They do not stop an older visit
          // whose page is already on screen from committing its URL.
          async commit() {
            return true;
          },
          dispose() {},
        };
      }

      if (options._popstate) {
        // The browser has already moved to this entry. A same-page hash entry is left out
        // above: it renders nothing, so an older page on screen still commits its URL.
        _urlNavigationId = id;
      }

      const controller = new AbortController();
      const deferredRegistry = new DeferredRegistry();
      const commitTarget = { fetchUrl: effectiveFetchUrl, hash };
      const shell = loadNavigationShell(
        id,
        url,
        effectiveFetchUrl,
        method,
        options,
        controller.signal,
        commitTarget,
        deferredRegistry,
      );

      let commitResource: () => Promise<boolean> = async () => false;
      const stop = () => {
        controller.abort(abortError());
        deferredRegistry.dispose();
      };
      const resource: PageNavigationResource = {
        id,
        url,
        fetchUrl: effectiveFetchUrl,
        hash,
        method,
        options,
        immediate: false,
        shell,
        abort: stop,
        commit() {
          return commitResource();
        },
        dispose: stop,
      };
      _resourceDeferredRegistries.set(resource, deferredRegistry);
      commitResource = makeCommit(
        commitTarget,
        options,
        shell,
        deferredRegistry,
        id,
        () => resource,
      );
      _pendingResource = resource;
      return resource;
    },

    prefetch(url, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      if (method !== 'GET') {
        throw new Error('Void Router: prefetch() only supports GET requests.');
      }

      const id = matchRoute(url);
      if (!id) {
        return Promise.resolve(undefined);
      }

      if (routeMeta[id]?.island) {
        if (!document.querySelector('link[rel="prefetch"][href="' + url + '"]')) {
          const link = document.createElement('link');
          link.rel = 'prefetch';
          link.href = url;
          link.as = 'document';
          document.head.appendChild(link);
        }
        return Promise.resolve(undefined);
      }

      if (components[id]) {
        components[id]();
      }
      const layoutIds = layoutTree[id] || [];
      for (const lid of layoutIds) {
        if (components[lid]) {
          components[lid]();
        }
      }

      const hashIdx = url.indexOf('#');
      const prefetchUrl = hashIdx !== -1 ? url.slice(0, hashIdx) : url;
      const existing = _prefetchCache.get(prefetchUrl, method);
      if (existing) {
        return existing.response;
      }
      const ttl = options.cacheFor ? parseCacheFor(options.cacheFor) : PREFETCH_DEFAULT_CACHE_FOR;
      const fetchPromise = fetchPrefetchPageData(prefetchUrl);
      _prefetchCache.set(prefetchUrl, method, fetchPromise, ttl);
      return fetchPromise;
    },

    flush(url, method = 'GET') {
      _prefetchCache.flush(url, method);
    },

    flushAll() {
      _prefetchCache.flushAll();
    },

    setPopStateHandler(handler) {
      popStateHandler = handler;
    },

    commitInitialRender() {
      const saved = initialScrollPosition;
      initialScrollPosition = null;
      scrollRestoration.commit();
      if (saved && _nextNavigationId === 0) {
        window.scrollTo(saved.x, saved.y);
      }
    },

    start() {
      initialScrollPosition = scrollRestoration.start();

      initClientHead(initialPageData.head as HeadDescriptor | undefined);

      if (deferredWindow.__deferredQueue) {
        for (const entry of deferredWindow.__deferredQueue) {
          if (entry.length === 3) {
            _htmlDeferredRegistry?.resolve(entry[0], undefined, entry[2]);
          } else {
            _htmlDeferredRegistry?.resolve(entry[0], entry[1], undefined);
          }
        }
        delete deferredWindow.__deferredQueue;
      }

      window.addEventListener('popstate', (e) => {
        const url = window.location.pathname + window.location.search + window.location.hash;
        const saved = scrollRestoration.pop(e.state);
        if (!scrollRestoration.ready && url === initialUrl) {
          initialScrollPosition = saved;
          return;
        }
        const options = {
          preserveState: true,
          _scrollPosition: saved,
          _popstate: true,
        };
        if (popStateHandler) {
          popStateHandler(url, options);
        }
      });
    },
  };

  return engine;
}
