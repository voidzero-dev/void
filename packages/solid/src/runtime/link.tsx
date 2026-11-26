import { createMemo, onCleanup, onMount, splitProps, useContext } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import {
  handleLinkClick,
  getLinkStatus,
  linkStatusAttributes,
  resolvedLinkStatus,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
} from 'void/pages-client';
import type { BaseLinkProps, LinkStatus, LinkStatusOptions } from 'void/pages-client';
import { NavigationContext, RouterContext } from './context.ts';

type CommonProps = BaseLinkProps & {
  children?: JSX.Element | ((status: LinkStatus) => JSX.Element);
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
    const [fn, data] = handler as Array<unknown>;
    if (typeof fn === 'function') {
      (fn as (data: unknown, event: Event) => void)(data, event);
    }
  } else if (typeof handler === 'function') {
    (handler as (event: Event) => void)(event);
  }
}

export function useLinkStatus(
  href: BaseLinkProps['href'] | Accessor<BaseLinkProps['href']>,
  options: LinkStatusOptions | Accessor<LinkStatusOptions> = {},
): Accessor<LinkStatus> {
  const router = useContext(RouterContext);
  const navigation = useContext(NavigationContext);
  return createMemo(() =>
    getLinkStatus(
      router,
      navigation?.(),
      typeof href === 'function' ? href() : href,
      typeof options === 'function' ? options() : options,
    ),
  );
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
    'activeMatch',
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
  const navigation = useContext(NavigationContext);

  const link = createMemo(() => resolveLink(local));
  const strategies = createMemo(() =>
    linkPrefetchStrategies(local, link(), router?._prefetchDefaultStrategy),
  );
  const resolvedStyle = createMemo(() => mergeStyle(local.style));
  const status = createMemo(() =>
    resolvedLinkStatus(router, navigation?.(), link(), local.activeMatch),
  );
  const attributes = createMemo(() => linkStatusAttributes(status()));
  function content() {
    const children = local.children;
    return typeof children === 'function' ? children(status()) : children;
  }

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
          {...attributes()}
          {...rest}
          style={resolvedStyle()}
          {...eventHandlers()}
        >
          {content()}
        </a>
      ) : (
        <button
          ref={(r) => {
            el = r;
          }}
          type="button"
          {...attributes()}
          {...rest}
          style={resolvedStyle()}
          {...eventHandlers()}
        >
          {content()}
        </button>
      )}
    </>
  );
}
