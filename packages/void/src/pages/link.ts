/// <reference lib="dom" />
import type { Href } from 'void/routes';
import { isModifiedEvent, mergeDataIntoHref } from './adapter-helpers.ts';
import type { NavigationMethod, VoidRouter } from './client.ts';
import type { PrefetchOptions } from './navigation-engine.ts';
import type { CacheForInput, LinkPrefetchValue, LinkPrefetchStrategy } from './prefetch.ts';

export type { LinkPrefetchValue, LinkPrefetchStrategy };
export type LinkNavigateEvent = { preventDefault(): void };

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

export function prefetchLink(
  router: VoidRouter | null | undefined,
  href: Href,
  cacheFor: CacheForInput | undefined,
): void {
  if (!router?.prefetch) {
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
