/// <reference lib="dom" />
import type { Href } from 'void/routes';
import { isModifiedEvent, mergeDataIntoHref } from './adapter-helpers.ts';
import type { NavigationMethod, NavigationState, VoidRouter } from './client.ts';
import type { PrefetchOptions } from './navigation-engine.ts';
import type { CacheForInput, LinkPrefetchValue, LinkPrefetchStrategy } from './prefetch.ts';
import { decodePagePath } from './url.ts';

export type { LinkPrefetchValue, LinkPrefetchStrategy };
export type LinkNavigateEvent = { preventDefault(): void };
export type LinkActiveMatch = 'exact' | 'prefix';

/** Present only when the link matches the current URL. */
export type LinkActiveAttributes = {
  'aria-current'?: 'page';
  'data-void-active'?: '';
};

/** Present only while a visit to the link's destination is loading. */
export type LinkPendingAttributes = {
  'data-void-pending'?: '';
};

/** Props every adapter's Link accepts. Adapters add element attributes and children. */
export type BaseLinkProps = {
  href: Href;
  method?: NavigationMethod | Lowercase<NavigationMethod>;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  reloadDocument?: boolean;
  viewTransition?: boolean;
  /** If omitted, the Link uses the app's `prefetch.defaultStrategy`. */
  prefetch?: LinkPrefetchValue;
  cacheFor?: CacheForInput;
  activeMatch?: LinkActiveMatch;
  onNavigate?: (event: LinkNavigateEvent) => void;
};

export type ResolvedLink = {
  method: NavigationMethod;
  isGet: boolean;
  /** The destination, with GET data merged into its query. */
  href: Href;
};

type LinkClickEvent = Pick<
  MouseEvent,
  | 'currentTarget'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'altKey'
  | 'button'
  | 'defaultPrevented'
  | 'preventDefault'
>;

type LinkClickProps = Pick<
  BaseLinkProps,
  | 'data'
  | 'preserveScroll'
  | 'preserveState'
  | 'replace'
  | 'reloadDocument'
  | 'viewTransition'
  | 'onNavigate'
>;

/** Normalizes the method and destination, rejecting options that only GET links support. */
export function resolveLink(
  props: Pick<BaseLinkProps, 'href' | 'method' | 'data' | 'prefetch' | 'reloadDocument'>,
): ResolvedLink {
  const method = (props.method ?? 'GET').toUpperCase() as NavigationMethod;
  const isGet = method === 'GET';

  if (props.prefetch !== undefined && props.prefetch !== false && !isGet) {
    throw new Error(
      'Link: prefetch only supports GET links. Remove `prefetch` or use method="GET".',
    );
  }
  if (props.reloadDocument && !isGet) {
    throw new Error('Link: reloadDocument only supports GET links.');
  }

  return {
    method,
    isGet,
    href: isGet ? mergeDataIntoHref(props.href, props.data) : props.href,
  };
}

/**
 * The events that prefetch a Link. A Link without a `prefetch` prop uses the app's
 * `defaultStrategy`, but only when it is a GET link, the only kind that can prefetch.
 */
export function linkPrefetchStrategies(
  props: Pick<BaseLinkProps, 'prefetch' | 'reloadDocument'>,
  link: Pick<ResolvedLink, 'isGet'>,
  defaultStrategy: LinkPrefetchValue = false,
): ReadonlyArray<LinkPrefetchStrategy> {
  if (props.reloadDocument) {
    return [];
  }

  const prefetch = props.prefetch ?? (link.isGet ? defaultStrategy : false);
  if (prefetch === false) {
    return [];
  }

  if (prefetch === true) {
    return ['hover'];
  }

  if (typeof prefetch === 'string') {
    return [prefetch];
  }

  return prefetch;
}

/**
 * Marks a GET link to the current page. Pathnames compare the way the server
 * matches pages: case-sensitive, trailing slash significant, decoded like Hono's
 * getPath. A link with a query also needs each of its params, with the same value,
 * in the current URL, which may have more params in any order. GET data counts as
 * query, and the hash is ignored. `prefix` also matches nested pages by whole
 * segment, except for `/`, comparing only the path, but only an exact match is
 * `aria-current`. Spread the result before the user's attributes so theirs win.
 */
export function linkActiveAttributes(
  router: VoidRouter | null | undefined,
  link: ResolvedLink,
  match: LinkActiveMatch = 'exact',
): LinkActiveAttributes {
  if (!router || !link.isGet) {
    return {};
  }

  const current = router.url;
  const target = resolveSameOrigin(link.href, current);
  if (!target) {
    return {};
  }

  const currentPath = decodePagePath(current.pathname);
  const linkPath = decodePagePath(target.pathname);
  if (linkPath === currentPath) {
    // A link that only changes the query, such as pagination, leads to another page.
    return hasQueryParams(current.searchParams, target.searchParams)
      ? { 'aria-current': 'page', 'data-void-active': '' }
      : {};
  }

  if (match === 'prefix' && linkPath !== '/') {
    const parent = linkPath.endsWith('/') ? linkPath : `${linkPath}/`;
    if (currentPath.startsWith(parent)) {
      return { 'data-void-active': '' };
    }
  }

  return {};
}

/**
 * Marks a link while a visit to its destination is loading: the visit uses the link's
 * method and goes to its path, query and hash. Unlike active links, the whole query and
 * the hash count, so `?tab=open` isn't pending during a visit to `?tab=open&page=2`.
 * Every link to the destination is marked, not only the one that was clicked.
 * Spread the result before the user's attributes so theirs win.
 */
export function linkPendingAttributes(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  link: ResolvedLink,
): LinkPendingAttributes {
  if (
    !router ||
    !navigation?.location ||
    navigation.state === 'idle' ||
    navigation.method !== link.method
  ) {
    return {};
  }

  const destination = navigation.location;
  const target = resolveSameOrigin(link.href, router.url);
  if (
    target &&
    target.host === destination.host &&
    target.protocol === destination.protocol &&
    decodePagePath(target.pathname) === decodePagePath(destination.pathname) &&
    target.search === destination.search &&
    target.hash === destination.hash
  ) {
    return { 'data-void-pending': '' };
  }

  return {};
}

/** Each of `params` has the same value in `current`. Extra params in `current` are allowed. */
function hasQueryParams(current: URLSearchParams, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (!current.getAll(key).includes(value)) {
      return false;
    }
  }
  return true;
}

/** Resolves `href` against `base`, or returns `null` for a malformed or other-origin href. */
function resolveSameOrigin(href: string, base: URL): URL | null {
  let target: URL;
  try {
    target = new URL(href, base);
  } catch {
    // A malformed href still renders; it just never matches.
    return null;
  }
  // Protocol and host rather than `origin`, which is opaque for custom schemes such as capacitor:.
  if (target.protocol !== base.protocol || target.host !== base.host) {
    return null;
  }
  return target;
}

/** The Network Information API fields Link reads. Only Chromium implements them. */
type NetworkConnection = { saveData?: boolean; effectiveType?: string };

/** Data saver is on, or the connection is 2G-class. Read per call: both change while the page is open. */
function isConstrainedConnection(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
  return (
    connection?.saveData === true ||
    connection?.effectiveType === '2g' ||
    connection?.effectiveType === 'slow-2g'
  );
}

/** Link's automatic prefetch. `router.prefetch()` called directly is not limited by the connection. */
export function prefetchLink(
  router: VoidRouter | null | undefined,
  href: Href,
  cacheFor: CacheForInput | undefined,
): void {
  if (!router?.prefetch || isConstrainedConnection()) {
    return;
  }

  // The router matches only the path, which on another site names a different page.
  if (new URL(href, window.location.href).origin !== window.location.origin) {
    return;
  }

  const current = window.location.pathname + window.location.search;
  if (href === current) {
    return;
  }

  const options: PrefetchOptions = {};
  if (cacheFor !== undefined) {
    options.cacheFor = cacheFor;
  }

  router.prefetch(href, options);
}

/**
 * Runs a client-side visit for a plain same-origin click. Modified clicks, downloads,
 * cross-origin destinations and `reloadDocument` links are left to the browser.
 * Call it after the user's own click handler so its `preventDefault()` is respected.
 */
export function handleLinkClick(
  event: LinkClickEvent,
  router: VoidRouter | null | undefined,
  link: ResolvedLink,
  props: LinkClickProps,
): void {
  if (props.reloadDocument || !router || event.defaultPrevented || isModifiedEvent(event)) {
    return;
  }

  if ((event.currentTarget as HTMLElement).hasAttribute('download')) {
    return;
  }

  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin) {
    return;
  }

  let navigatePrevented = false;
  props.onNavigate?.({
    preventDefault() {
      navigatePrevented = true;
    },
  });

  event.preventDefault();
  if (navigatePrevented) {
    return;
  }

  router.visit(link.href, {
    method: link.method,
    data: link.isGet ? undefined : props.data,
    preserveScroll: props.preserveScroll,
    preserveState: props.preserveState,
    replace: props.replace,
    viewTransition: props.viewTransition,
  });
}

/**
 * How long a `'visible'` link must stay in the viewport before it prefetches. Long enough
 * that a link scrolled past during a quick scroll or fling is skipped, short enough that
 * the prefetch still lands well before the user reads the link and clicks. Astro's
 * viewport prefetch uses the same delay. Separate from `prefetch.hoverDelay`, whose 75 ms
 * would only filter the fastest flings.
 */
export const LINK_VISIBLE_PREFETCH_DELAY = 300;

/**
 * Calls `onVisible` once, after `element` has stayed in the viewport for
 * `LINK_VISIBLE_PREFETCH_DELAY` ms. Leaving the viewport cancels the wait and entering
 * again restarts it. Returns a cleanup that also cancels a pending wait.
 */
export function observeLinkVisible(element: Element, onVisible: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set once the callback has run or the caller cleaned up. Entries queued before
  // `disconnect()` can still be delivered, and must not start another wait.
  let done = false;
  const stop = () => {
    done = true;
    clearTimeout(timer);
    timer = undefined;
    observer.disconnect();
  };

  const observer = new IntersectionObserver(
    (entries) => {
      if (done) {
        return;
      }
      // Leaving the viewport resets the visibility delay even if a later entry is visible again.
      if (entries.some((entry) => !entry.isIntersecting)) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Entries are in time order, so the last one is the element's current state.
      if (!entries.at(-1)?.isIntersecting) {
        return;
      }
      timer ??= setTimeout(() => {
        stop();
        onVisible();
      }, LINK_VISIBLE_PREFETCH_DELAY);
    },
    { rootMargin: '0px' },
  );
  observer.observe(element);

  return stop;
}
