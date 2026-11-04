/// <reference lib="dom" />
import type { Href } from 'void/routes';
import { isModifiedEvent, mergeDataIntoHref } from './adapter-helpers.ts';
import type { NavigationMethod, VoidRouter } from './client.ts';
import type { PrefetchOptions } from './navigation-engine.ts';
import type { CacheForInput } from './prefetch.ts';
import { decodePagePath } from './url.ts';

export type LinkPrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
export type LinkNavigateEvent = { preventDefault(): void };
export type LinkActiveMatch = 'exact' | 'prefix';

/** Present only when the link matches the current URL. */
export type LinkActiveAttributes = {
  'aria-current'?: 'page';
  'data-void-active'?: '';
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
  prefetch?: boolean | LinkPrefetchStrategy | ReadonlyArray<LinkPrefetchStrategy>;
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

export function linkPrefetchStrategies(
  props: Pick<BaseLinkProps, 'prefetch' | 'reloadDocument'>,
): ReadonlyArray<LinkPrefetchStrategy> {
  const { prefetch } = props;
  if (prefetch === undefined || prefetch === false || props.reloadDocument) {
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
 * getPath. The query and hash are ignored. `prefix` also matches nested pages by
 * whole segment, except for `/`, but only an exact match is `aria-current`.
 * Spread the result before the user's attributes so theirs win.
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
  let target: URL;
  try {
    target = new URL(link.href, current);
  } catch {
    // A malformed href still renders; it just never matches.
    return {};
  }
  // Protocol and host rather than `origin`, which is opaque for custom schemes such as capacitor:.
  if (target.protocol !== current.protocol || target.host !== current.host) {
    return {};
  }

  const currentPath = decodePagePath(current.pathname);
  const linkPath = decodePagePath(target.pathname);
  if (linkPath === currentPath) {
    return { 'aria-current': 'page', 'data-void-active': '' };
  }

  if (match === 'prefix' && linkPath !== '/') {
    const parent = linkPath.endsWith('/') ? linkPath : `${linkPath}/`;
    if (currentPath.startsWith(parent)) {
      return { 'data-void-active': '' };
    }
  }

  return {};
}

export function prefetchLink(
  router: VoidRouter | null | undefined,
  href: Href,
  cacheFor: CacheForInput | undefined,
): void {
  if (!router?.prefetch) {
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

/** Calls `onVisible` once, the first time `element` enters the viewport. Returns a cleanup. */
export function observeLinkVisible(element: Element, onVisible: () => void): () => void {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible();
        observer.disconnect();
      }
    },
    { rootMargin: '0px' },
  );
  observer.observe(element);

  return () => observer.disconnect();
}
