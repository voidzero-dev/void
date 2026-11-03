import { createMemo, onCleanup, onMount, splitProps, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import {
  handleLinkClick,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
  type BaseLinkProps,
} from 'void/pages-client';
import { RouterContext } from './context.ts';

type CommonProps = BaseLinkProps & {
  children?: JSX.Element;
};

export type LinkProps = CommonProps &
  Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> &
  Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps>;

function mergeStyle(style: JSX.CSSProperties | string | undefined): JSX.CSSProperties | string {
  if (typeof style === 'string') {
    return `touch-action: manipulation; ${style}`;
  }
  return {
    touchAction: 'manipulation',
    ...style,
  } as JSX.CSSProperties;
}

function callHandler(handler: unknown, event: Event): void {
  if (Array.isArray(handler)) {
    const [fn, data] = handler;
    if (typeof fn === 'function') {
      fn(data, event);
    }
  } else if (typeof handler === 'function') {
    handler(event);
  }
}

export function Link(props: LinkProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'href',
    'method',
    'data',
    'preserveScroll',
    'preserveState',
    'replace',
    'reloadDocument',
    'viewTransition',
    'prefetch',
    'cacheFor',
    'onNavigate',
    'children',
    'style',
    'onClick',
    'onMouseEnter',
    'onMouseLeave',
    'onFocus',
    'onMouseDown',
    'onTouchStart',
  ]);
  const router = useContext(RouterContext);

  const link = createMemo(() => resolveLink(local));
  const strategies = createMemo(() => linkPrefetchStrategies(local));
  const resolvedStyle = createMemo(() => mergeStyle(local.style));

  function doPrefetch() {
    prefetchLink(router, link().href, local.cacheFor);
  }

  function onClick(event: MouseEvent) {
    callHandler(local.onClick, event);
    handleLinkClick(event, router, link(), local);
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let stopObserving: (() => void) | null = null;
  let el: HTMLElement | undefined;

  function onMouseEnter(event: MouseEvent) {
    callHandler(local.onMouseEnter, event);
    if (event.defaultPrevented) {
      return;
    }
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    hoverTimer = setTimeout(doPrefetch, router?._hoverDelay ?? 75);
  }

  function onMouseLeave(event: MouseEvent) {
    callHandler(local.onMouseLeave, event);
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function onFocus(event: FocusEvent) {
    callHandler(local.onFocus, event);
    if (!event.defaultPrevented) {
      doPrefetch();
    }
  }

  function onMouseDown(event: MouseEvent) {
    callHandler(local.onMouseDown, event);
    if (!event.defaultPrevented) {
      doPrefetch();
    }
  }

  function onTouchStart(event: TouchEvent) {
    callHandler(local.onTouchStart, event);
    if (!event.defaultPrevented) {
      doPrefetch();
    }
  }

  onMount(() => {
    if (strategies().includes('mount')) {
      doPrefetch();
    }
    if (strategies().includes('visible') && el) {
      stopObserving = observeLinkVisible(el, doPrefetch);
    }
  });

  onCleanup(() => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    stopObserving?.();
  });

  const eventHandlers = createMemo(() => {
    const handlers = {
      onClick,
      onFocus: local.onFocus,
      onMouseDown: local.onMouseDown,
      onMouseEnter: local.onMouseEnter,
      onMouseLeave: local.onMouseLeave,
      onTouchStart: local.onTouchStart,
    };

    if (strategies().includes('hover')) {
      handlers.onMouseEnter = onMouseEnter;
      handlers.onMouseLeave = onMouseLeave;
      handlers.onFocus = onFocus;
      handlers.onTouchStart = onTouchStart;
    }

    if (strategies().includes('click')) {
      handlers.onMouseDown = onMouseDown;
      handlers.onTouchStart = onTouchStart;
    }

    return handlers;
  });

  return (
    <>
      {link().isGet ? (
        <a
          ref={(r) => {
            el = r;
          }}
          href={link().href}
          {...rest}
          style={resolvedStyle()}
          {...eventHandlers()}
        >
          {local.children}
        </a>
      ) : (
        <button
          ref={(r) => {
            el = r;
          }}
          type="button"
          {...(rest as JSX.ButtonHTMLAttributes<HTMLButtonElement>)}
          style={resolvedStyle()}
          {...eventHandlers()}
        >
          {local.children}
        </button>
      )}
    </>
  );
}
