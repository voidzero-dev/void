import { createMemo, onCleanup, onMount, splitProps, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { isModifiedEvent, mergeDataIntoHref } from 'void/pages-client';
import type { Href } from 'void/routes';
import { RouterContext } from './context.ts';

type PrefetchStrategy = 'hover' | 'click' | 'mount' | 'visible';
type LinkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type NavigateEvent = { preventDefault(): void };
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
  onNavigate?: (event: NavigateEvent) => void;
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

  const linkState = createMemo(() => {
    const method = (local.method || 'GET').toUpperCase() as LinkMethod;
    const isGet = method === 'GET';

    if (local.prefetch !== false && local.prefetch !== undefined && !isGet) {
      throw new Error(
        'Link: prefetch only supports GET links. Remove `prefetch` or use method="GET".',
      );
    }
    if (local.reloadDocument && !isGet) {
      throw new Error('Link: reloadDocument only supports GET links.');
    }

    return {
      href: isGet ? mergeDataIntoHref(local.href, local.data) : local.href,
      isGet,
      method,
    };
  });
  const normalizedMethod = () => linkState().method;
  const isGet = () => linkState().isGet;
  const hrefWithData = () => linkState().href;
  const strategies = createMemo<ReadonlyArray<PrefetchStrategy>>(() => {
    if (local.prefetch === false || local.prefetch === undefined || local.reloadDocument) {
      return [];
    }
    if (local.prefetch === true) {
      return ['hover'];
    }
    if (typeof local.prefetch === 'string') {
      return [local.prefetch];
    }
    return local.prefetch;
  });
  const resolvedStyle = createMemo(() => mergeStyle(local.style));

  function doPrefetch() {
    if (!router?.prefetch) {
      return;
    }
    const current = window.location.pathname + window.location.search;
    if (hrefWithData() === current) {
      return;
    }
    const options: PrefetchOptions = {};
    if (local.cacheFor !== undefined) {
      options.cacheFor = local.cacheFor;
    }
    router.prefetch(hrefWithData(), options);
  }

  function shouldHandleClick(event: MouseEvent): boolean {
    if (local.reloadDocument || !router || event.defaultPrevented || isModifiedEvent(event)) {
      return false;
    }
    if ((event.currentTarget as HTMLElement).hasAttribute('download')) {
      return false;
    }

    const url = new URL(hrefWithData(), window.location.href);
    if (url.origin !== window.location.origin) {
      return false;
    }

    return true;
  }

  function onClick(event: MouseEvent) {
    callHandler(local.onClick, event);
    if (!shouldHandleClick(event)) {
      return;
    }

    let navigatePrevented = false;
    local.onNavigate?.({
      preventDefault() {
        navigatePrevented = true;
      },
    });
    if (navigatePrevented) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    router?.visit(hrefWithData(), {
      method: normalizedMethod(),
      data: isGet() ? undefined : local.data,
      preserveScroll: local.preserveScroll,
      preserveState: local.preserveState,
      replace: local.replace,
      viewTransition: local.viewTransition,
    });
  }

  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: IntersectionObserver | null = null;
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
      observer.observe(el);
    }
  });

  onCleanup(() => {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
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
      {isGet() ? (
        <a
          ref={(r) => {
            el = r;
          }}
          href={hrefWithData()}
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
