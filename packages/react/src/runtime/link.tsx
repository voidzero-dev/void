import { useCallback, useContext, useEffect, useMemo, useRef, type JSX } from 'react';
import type {
  MouseEvent,
  TouchEvent,
  FocusEvent,
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  RefObject,
} from 'react';
import { isModifiedEvent, mergeDataIntoHref } from 'void/pages-client';
import type { Href } from 'void/routes';
import { RouterContext } from './context.ts';

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type PrefetchOptions = { cacheFor?: LinkProps['cacheFor'] };

type CommonProps = {
  href: Href;
  method?: LinkMethod | Lowercase<LinkMethod>;
  data?: Record<string, unknown>;
  preserveScroll?: boolean;
  preserveState?: boolean;
  replace?: boolean;
  reloadDocument?: boolean;
  viewTransition?: boolean;
  prefetch?: boolean | PrefetchStrategy | ReadonlyArray<PrefetchStrategy>;
  cacheFor?: number | string | [string, string];
  onNavigate?: (event: { preventDefault(): void }) => void;
};

export type LinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps>;

export function Link({
  href,
  method = 'GET',
  data,
  preserveScroll = false,
  preserveState = false,
  replace = false,
  reloadDocument = false,
  viewTransition,
  prefetch: prefetchProp = false,
  cacheFor,
  onNavigate,
  children,
  style,
  onClick: onClickProp,
  onMouseEnter: onMouseEnterProp,
  onMouseLeave: onMouseLeaveProp,
  onFocus: onFocusProp,
  onMouseDown: onMouseDownProp,
  onTouchStart: onTouchStartProp,
  ...rest
}: LinkProps): JSX.Element {
  const router = useContext(RouterContext);
  const elementRef = useRef<HTMLElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const normalizedMethod = useMemo(() => method.toUpperCase() as LinkMethod, [method]);
  const isGet = normalizedMethod === 'GET';
  const hrefWithData = useMemo(
    () => (isGet ? mergeDataIntoHref(href, data) : href),
    [data, href, isGet],
  );
  const strategies = useMemo<ReadonlyArray<PrefetchStrategy>>(() => {
    if (prefetchProp === false || reloadDocument) {
      return [];
    }
    if (prefetchProp === true) {
      return ['hover'];
    }
    if (typeof prefetchProp === 'string') {
      return [prefetchProp];
    }
    return prefetchProp;
  }, [prefetchProp, reloadDocument]);
  const hoverDelay = router?._hoverDelay ?? 75;

  if (prefetchProp !== false && !isGet) {
    throw new Error(
      'Link: prefetch only supports GET links. Remove `prefetch` or use method="GET".',
    );
  }
  if (reloadDocument && !isGet) {
    throw new Error('Link: reloadDocument only supports GET links.');
  }

  const doPrefetch = useCallback(() => {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (hrefWithData === current) {
      return;
    }
    const options: PrefetchOptions = {};
    if (cacheFor !== undefined) {
      options.cacheFor = cacheFor;
    }
    router.prefetch(hrefWithData, options);
  }, [cacheFor, hrefWithData, router]);

  const shouldHandleClick = useCallback(
    (event: MouseEvent): boolean => {
      if (reloadDocument || !router || event.defaultPrevented || isModifiedEvent(event)) {
        return false;
      }
      if ((event.currentTarget as HTMLElement).hasAttribute('download')) {
        return false;
      }

      const url = new URL(hrefWithData, window.location.origin);
      if (url.origin !== window.location.origin) {
        return false;
      }

      return true;
    },
    [hrefWithData, reloadDocument, router],
  );

  const onClick = useCallback(
    (event: MouseEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onClickProp?.(event as any);
      if (!shouldHandleClick(event)) {
        return;
      }

      let navigatePrevented = false;
      onNavigate?.({
        preventDefault() {
          navigatePrevented = true;
        },
      });
      if (navigatePrevented) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      router?.visit(hrefWithData, {
        method: normalizedMethod,
        data: isGet ? undefined : data,
        preserveScroll,
        preserveState,
        replace,
        viewTransition,
      });
    },
    [
      data,
      hrefWithData,
      isGet,
      normalizedMethod,
      onClickProp,
      onNavigate,
      preserveScroll,
      preserveState,
      replace,
      router,
      shouldHandleClick,
      viewTransition,
    ],
  );

  const onMouseEnter = useCallback(
    (event: MouseEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onMouseEnterProp?.(event as any);
      if (event.defaultPrevented) {
        return;
      }
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = setTimeout(doPrefetch, hoverDelay);
    },
    [doPrefetch, hoverDelay, onMouseEnterProp],
  );

  const onMouseLeave = useCallback(
    (event: MouseEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onMouseLeaveProp?.(event as any);
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    },
    [onMouseLeaveProp],
  );

  const onFocus = useCallback(
    (event: FocusEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onFocusProp?.(event as any);
      if (!event.defaultPrevented) {
        doPrefetch();
      }
    },
    [doPrefetch, onFocusProp],
  );

  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onMouseDownProp?.(event as any);
      if (!event.defaultPrevented) {
        doPrefetch();
      }
    },
    [doPrefetch, onMouseDownProp],
  );

  const onTouchStart = useCallback(
    (event: TouchEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onTouchStartProp?.(event as any);
      if (!event.defaultPrevented) {
        doPrefetch();
      }
    },
    [doPrefetch, onTouchStartProp],
  );

  useEffect(() => {
    if (strategies.length === 0) {
      return;
    }

    if (strategies.includes('mount')) {
      doPrefetch();
    }

    let observer: IntersectionObserver | null = null;
    if (strategies.includes('visible') && elementRef.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            doPrefetch();
            observer?.disconnect();
            observer = null;
          }
        },
        { rootMargin: '0px' },
      );
      observer.observe(elementRef.current);
    }

    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (observer) {
        observer.disconnect();
      }
    };
  }, [doPrefetch, strategies]);

  // oxlint-disable-next-line no-explicit-any -- spread props need a loose cross-element event map
  const eventHandlers = useMemo<Record<string, any>>(() => {
    // oxlint-disable-next-line no-explicit-any -- spread props need a loose cross-element event map
    const handlers: Record<string, any> = {
      onClick,
      onFocus: onFocusProp,
      onMouseDown: onMouseDownProp,
      onMouseEnter: onMouseEnterProp,
      onMouseLeave: onMouseLeaveProp,
      onTouchStart: onTouchStartProp,
    };

    if (strategies.includes('hover')) {
      handlers.onMouseEnter = onMouseEnter;
      handlers.onMouseLeave = onMouseLeave;
      handlers.onFocus = onFocus;
      handlers.onTouchStart = onTouchStart;
    }

    if (strategies.includes('click')) {
      handlers.onMouseDown = onMouseDown;
      handlers.onTouchStart = onTouchStart;
    }

    return handlers;
  }, [
    onClick,
    onFocus,
    onFocusProp,
    onMouseDown,
    onMouseDownProp,
    onMouseEnter,
    onMouseEnterProp,
    onMouseLeave,
    onMouseLeaveProp,
    onTouchStart,
    onTouchStartProp,
    strategies,
  ]);

  const resolvedStyle = useMemo(
    () => ({
      touchAction: 'manipulation',
      ...(style as CSSProperties | undefined),
    }),
    [style],
  );

  if (isGet) {
    return (
      <a
        ref={elementRef as RefObject<HTMLAnchorElement>}
        href={hrefWithData}
        style={resolvedStyle}
        {...rest}
        {...eventHandlers}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      ref={elementRef as RefObject<HTMLButtonElement>}
      type="button"
      style={resolvedStyle}
      {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
      {...eventHandlers}
    >
      {children}
    </button>
  );
}
