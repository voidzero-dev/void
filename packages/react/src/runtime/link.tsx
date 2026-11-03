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
import {
  handleLinkClick,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
  type BaseLinkProps,
} from 'void/pages-client';
import { RouterContext } from './context.ts';

export type LinkProps = BaseLinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof BaseLinkProps> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof BaseLinkProps>;

export function Link({
  href,
  method = 'GET',
  data,
  preserveScroll = false,
  preserveState = false,
  replace = false,
  reloadDocument = false,
  viewTransition,
  prefetch = false,
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
  const link = useMemo(
    () => resolveLink({ href, method, data, prefetch, reloadDocument }),
    [data, href, method, prefetch, reloadDocument],
  );
  const strategies = useMemo(
    () => linkPrefetchStrategies({ prefetch, reloadDocument }),
    [prefetch, reloadDocument],
  );
  const hoverDelay = router?._hoverDelay ?? 75;

  const doPrefetch = useCallback(
    () => prefetchLink(router, link.href, cacheFor),
    [cacheFor, link.href, router],
  );

  const onClick = useCallback(
    (event: MouseEvent) => {
      // oxlint-disable-next-line no-explicit-any -- React merges anchor/button handler types awkwardly here
      onClickProp?.(event as any);
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

  if (link.isGet) {
    return (
      <a
        ref={elementRef as RefObject<HTMLAnchorElement>}
        href={link.href}
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
