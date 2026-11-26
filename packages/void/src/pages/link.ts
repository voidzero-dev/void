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

export type LinkStatusOptions = Pick<BaseLinkProps, 'method' | 'data' | 'activeMatch'>;

export type LinkStatus = {
  current: boolean;
  active: boolean;
  pending: boolean;
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

type ActiveMatch = 'current' | 'ancestor' | undefined;

function matchActive(current: URL, target: URL, match: LinkActiveMatch): ActiveMatch {
  const currentPath = decodePagePath(current.pathname);
  const linkPath = decodePagePath(target.pathname);
  if (linkPath === currentPath) {
    return hasQueryParams(current.searchParams, target.searchParams) ? 'current' : undefined;
  }

  if (match === 'prefix' && linkPath !== '/') {
    const parent = linkPath.endsWith('/') ? linkPath : `${linkPath}/`;
    if (currentPath.startsWith(parent)) {
      return 'ancestor';
    }
  }
}

function matchPending(
  navigation: NavigationState | null | undefined,
  method: NavigationMethod,
  target: URL,
): boolean {
  const destination = navigation?.location;
  return Boolean(
    destination &&
    navigation.state !== 'idle' &&
    navigation.method === method &&
    target.host === destination.host &&
    target.protocol === destination.protocol &&
    decodePagePath(target.pathname) === decodePagePath(destination.pathname) &&
    target.search === destination.search &&
    target.hash === destination.hash,
  );
}

/** Reads the same current, active and pending state used by a Link with these props. */
export function getLinkStatus(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  href: Href,
  { method, data, activeMatch }: LinkStatusOptions = {},
): LinkStatus {
  return resolvedLinkStatus(router, navigation, resolveLink({ href, method, data }), activeMatch);
}

export function resolvedLinkStatus(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  link: ResolvedLink,
  match: LinkActiveMatch = 'exact',
): LinkStatus {
  const current = router?.url;
  const target = current && resolveSameOrigin(link.href, current);
  const active = current && target && link.isGet ? matchActive(current, target, match) : undefined;
  return {
    current: active === 'current',
    active: active !== undefined,
    pending: !!target && matchPending(navigation, link.method, target),
  };
}

/** Returns true for the current page and, with prefix matching, its parent paths. */
export function isLinkActive(
  router: VoidRouter | null | undefined,
  href: Href,
  options?: LinkStatusOptions,
): boolean {
  return getLinkStatus(router, null, href, options).active;
}

/** Returns true during a visit with the link's method, path, full query and hash. */
export function isLinkPending(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  href: Href,
  { method, data }: LinkStatusOptions = {},
): boolean {
  return pendingForLink(router, navigation, resolveLink({ href, method, data }));
}

function pendingForLink(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  link: ResolvedLink,
): boolean {
  const target = router && navigation?.location && resolveSameOrigin(link.href, router.url);
  return !!target && matchPending(navigation, link.method, target);
}

/** Spread before authored attributes so the user's values win. */
export function linkStatusAttributes(
  status: LinkStatus,
): LinkActiveAttributes & LinkPendingAttributes {
  const attributes: LinkActiveAttributes & LinkPendingAttributes = {};
  if (status.current) {
    attributes['aria-current'] = 'page';
  }
  if (status.active) {
    attributes['data-void-active'] = '';
  }
  if (status.pending) {
    attributes['data-void-pending'] = '';
  }
  return attributes;
}

export function linkActiveAttributes(
  router: VoidRouter | null | undefined,
  link: ResolvedLink,
  match?: LinkActiveMatch,
): LinkActiveAttributes {
  return linkStatusAttributes(resolvedLinkStatus(router, null, link, match));
}

export function linkPendingAttributes(
  router: VoidRouter | null | undefined,
  navigation: NavigationState | null | undefined,
  link: ResolvedLink,
): LinkPendingAttributes {
  return pendingForLink(router, navigation, link) ? { 'data-void-pending': '' } : {};
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

  void router.prefetch(href, options);
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

  void router.visit(link.href, {
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
