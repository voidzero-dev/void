import { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import type {
  MouseEvent,
  MouseEventHandler,
  HTMLAttributes,
  FocusEventHandler,
  TouchEventHandler,
  TouchEvent,
  FocusEvent,
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
} from 'react';
import {
  handleLinkClick,
  linkActiveAttributes,
  linkPendingAttributes,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
} from 'void/pages-client';
import type { BaseLinkProps } from 'void/pages-client';
import { NavigationContext, RouterContext } from './context.ts';

export type LinkProps = BaseLinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof BaseLinkProps> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof BaseLinkProps>;

type LinkEventHandlers = Pick<
  HTMLAttributes<HTMLElement>,
  'onClick' | 'onFocus' | 'onMouseDown' | 'onMouseEnter' | 'onMouseLeave' | 'onTouchStart'
>;

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
}: LinkProps): JSX.Element {
  const router = useContext(RouterContext);
  const navigation = useContext(NavigationContext);
  const elementRef = useRef<HTMLElement | null>(null);
  const setElementRef = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
  }, []);
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
  // The router context changes with the route URL, so this follows navigations.
  const activeAttributes = useMemo(
    () => linkActiveAttributes(router, link, activeMatch),
    [activeMatch, link, router],
  );
  const pendingAttributes = useMemo(
    () => linkPendingAttributes(router, navigation, link),
    [link, navigation, router],
  );
  const hoverDelay = router?._hoverDelay ?? 75;

  const doPrefetch = useCallback(
    () => prefetchLink(router, link.href, cacheFor),
    [cacheFor, link.href, router],
  );

  const onClick = useCallback(
    (event: MouseEvent) => {
      const callback: MouseEventHandler | undefined = onClickProp;
      callback?.(event);
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
    [
      data,
      link,
      onClickProp,
      onNavigate,
      preserveScroll,
      preserveState,
      reloadDocument,
      replace,
      router,
      viewTransition,
    ],
  );

  const onMouseEnter = useCallback(
    (event: MouseEvent) => {
      const callback: MouseEventHandler | undefined = onMouseEnterProp;
      callback?.(event);
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
      const callback: MouseEventHandler | undefined = onMouseLeaveProp;
      callback?.(event);
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    },
    [onMouseLeaveProp],
  );

  const onFocus = useCallback(
    (event: FocusEvent) => {
      const callback: FocusEventHandler | undefined = onFocusProp;
      callback?.(event);
      if (!event.defaultPrevented) {
        doPrefetch();
      }
    },
    [doPrefetch, onFocusProp],
  );

  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      const callback: MouseEventHandler | undefined = onMouseDownProp;
      callback?.(event);
      if (!event.defaultPrevented) {
        doPrefetch();
      }
    },
    [doPrefetch, onMouseDownProp],
  );

  const onTouchStart = useCallback(
    (event: TouchEvent) => {
      const callback: TouchEventHandler | undefined = onTouchStartProp;
      callback?.(event);
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

    const stopObserving =
      strategies.includes('visible') && elementRef.current
        ? observeLinkVisible(elementRef.current, doPrefetch)
        : null;

    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      stopObserving?.();
    };
  }, [doPrefetch, strategies]);

  const eventHandlers = useMemo(() => {
    const handlers: LinkEventHandlers = {
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
      ...style,
    }),
    [style],
  );

  if (link.isGet) {
    return (
      <a
        ref={setElementRef}
        href={link.href}
        style={resolvedStyle}
        {...activeAttributes}
        {...pendingAttributes}
        {...rest}
        {...eventHandlers}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      ref={setElementRef}
      type="button"
      style={resolvedStyle}
      {...pendingAttributes}
      {...rest}
      {...eventHandlers}
    >
      {children}
    </button>
  );
}
