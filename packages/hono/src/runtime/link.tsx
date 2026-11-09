import { useCallback, useContext, useEffect, useMemo, useRef } from 'hono/jsx';
import type { CSSProperties, JSX, PropsWithChildren } from 'hono/jsx';
import type { JSX as JSXRuntime } from 'hono/jsx/jsx-runtime';
import {
  handleLinkClick,
  linkActiveAttributes,
  linkPendingAttributes,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
  type BaseLinkProps,
} from 'void/pages-client';
import { NavigationContext, RouterContext } from './context.ts';

export type LinkProps = PropsWithChildren<
  BaseLinkProps &
    Omit<JSX.IntrinsicElements['a'], keyof BaseLinkProps> &
    Omit<JSX.IntrinsicElements['button'], keyof BaseLinkProps>
>;

// oxlint-disable-next-line no-explicit-any -- anchor and button handlers take different event types
type Handler = ((event: any) => void) | undefined;

function mergeStyle(style: CSSProperties | string | undefined): CSSProperties | string {
  if (typeof style === 'string') {
    return `touch-action: manipulation; ${style}`;
  }
  return { touchAction: 'manipulation', ...style };
}

export function Link({
  href,
  method = 'GET',
  data,
  preserveScroll = false,
  preserveState = false,
  replace = false,
  reloadDocument = false,
  viewTransition,
  prefetch,
  cacheFor,
  activeMatch,
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
}: LinkProps): JSXRuntime.Element {
  const router = useContext(RouterContext);
  const navigation = useContext(NavigationContext);
  const elementRef = useRef<HTMLElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const link = useMemo(
    () => resolveLink({ href, method, data, prefetch, reloadDocument }),
    [data, href, method, prefetch, reloadDocument],
  );
  const { isGet } = link;
  const defaultStrategy = router?._prefetchDefaultStrategy;
  const strategies = useMemo(
    () => linkPrefetchStrategies({ prefetch, reloadDocument }, { isGet }, defaultStrategy),
    [defaultStrategy, isGet, prefetch, reloadDocument],
  );
  const hoverDelay = router?._hoverDelay ?? 75;

  const doPrefetch = useCallback(
    () => prefetchLink(router, link.href, cacheFor),
    [cacheFor, link.href, router],
  );

  const clearHoverTimer = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (strategies.length === 0) {
      return;
    }

    if (strategies.includes('mount')) {
      doPrefetch();
    }

    const stopObserving =
      strategies.includes('visible') && elementRef.current
        ? observeLinkVisible(elementRef.current, doPrefetch)
        : null;

    return () => {
      clearHoverTimer();
      stopObserving?.();
    };
  }, [doPrefetch, strategies]);

  // Runs the app's own handler first, then prefetches unless that handler prevented it.
  const prefetchAfter =
    (handler: Handler) =>
    (event: Event): void => {
      handler?.(event);
      if (!event.defaultPrevented) {
        doPrefetch();
      }
    };

  const handlers: Record<string, Handler> = {
    onClick(event: MouseEvent) {
      (onClickProp as Handler)?.(event);
      handleLinkClick(event, router, link, {
        data,
        preserveScroll,
        preserveState,
        replace,
        reloadDocument,
        viewTransition,
        onNavigate,
      });
    },
    onFocus: onFocusProp as Handler,
    onMouseDown: onMouseDownProp as Handler,
    onMouseEnter: onMouseEnterProp as Handler,
    onMouseLeave: onMouseLeaveProp as Handler,
    onTouchStart: onTouchStartProp as Handler,
  };

  if (strategies.includes('hover')) {
    handlers.onMouseEnter = (event: Event) => {
      (onMouseEnterProp as Handler)?.(event);
      if (event.defaultPrevented) {
        return;
      }
      clearHoverTimer();
      hoverTimerRef.current = setTimeout(doPrefetch, hoverDelay);
    };
    handlers.onMouseLeave = (event: Event) => {
      (onMouseLeaveProp as Handler)?.(event);
      clearHoverTimer();
    };
    handlers.onFocus = prefetchAfter(onFocusProp as Handler);
    handlers.onTouchStart = prefetchAfter(onTouchStartProp as Handler);
  }

  if (strategies.includes('click')) {
    handlers.onMouseDown = prefetchAfter(onMouseDownProp as Handler);
    handlers.onTouchStart = prefetchAfter(onTouchStartProp as Handler);
  }

  // The router context changes with the route URL, so these follow navigations.
  const activeAttributes = linkActiveAttributes(router, link, activeMatch);
  const pendingAttributes = linkPendingAttributes(router, navigation, link);
  // Hono JSX prints `ref` as an attribute when it renders to a string.
  const refProps = typeof document === 'undefined' ? {} : { ref: elementRef };
  const resolvedStyle = mergeStyle(style);

  if (isGet) {
    return (
      <a
        {...refProps}
        href={String(link.href)}
        style={resolvedStyle}
        {...activeAttributes}
        {...pendingAttributes}
        {...(rest as JSX.IntrinsicElements['a'])}
        {...handlers}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      {...refProps}
      type="button"
      style={resolvedStyle}
      {...pendingAttributes}
      {...(rest as JSX.IntrinsicElements['button'])}
      {...handlers}
    >
      {children}
    </button>
  );
}
