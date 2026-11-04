import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createRouterFacade,
  createSsrRouter,
  idleNavigationState,
  type NavigationMethod,
  type VoidRouter,
} from '../../src/pages/client.ts';
import {
  handleLinkClick,
  LINK_VISIBLE_PREFETCH_DELAY,
  linkActiveAttributes,
  linkPendingAttributes,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
  type BaseLinkProps,
  type LinkActiveMatch,
} from '../../src/pages/link.ts';

function createRouter() {
  return {
    visit: vi.fn(() => Promise.resolve()),
    prefetch: vi.fn(() => Promise.resolve()),
  } as unknown as VoidRouter & {
    visit: ReturnType<typeof vi.fn>;
    prefetch: ReturnType<typeof vi.fn>;
  };
}

function click(
  overrides: Partial<Record<string, unknown>> = {},
  attributes: Record<string, string> = {},
) {
  const preventDefault = vi.fn();
  const event = {
    currentTarget: {
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => name in attributes,
    } as unknown as EventTarget,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    button: 0,
    defaultPrevented: false,
    preventDefault,
    ...overrides,
  } as Parameters<typeof handleLinkClick>[0];
  return { event, preventDefault };
}

beforeEach(() => {
  vi.stubGlobal('window', {
    location: new URL('https://app.test/users?page=1'),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveLink', () => {
  it('merges GET data into the destination', () => {
    expect(resolveLink({ href: '/users', method: 'get', data: { page: 2 } })).toEqual({
      method: 'GET',
      isGet: true,
      href: '/users?page=2',
    });
  });

  it('keeps data out of the destination for other methods', () => {
    expect(resolveLink({ href: '/users', method: 'post', data: { name: 'Ada' } })).toEqual({
      method: 'POST',
      isGet: false,
      href: '/users',
    });
  });

  it('rejects prefetch on non-GET links', () => {
    expect(() => resolveLink({ href: '/users', method: 'POST', prefetch: 'mount' })).toThrow(
      'Link: prefetch only supports GET links',
    );
    expect(() => resolveLink({ href: '/users', method: 'POST', prefetch: false })).not.toThrow();
  });

  it('rejects reloadDocument on non-GET links', () => {
    expect(() => resolveLink({ href: '/users', method: 'DELETE', reloadDocument: true })).toThrow(
      'Link: reloadDocument only supports GET links.',
    );
  });
});

describe('linkPrefetchStrategies', () => {
  const get = { isGet: true };
  const post = { isGet: false };

  it.each([
    [undefined, []],
    [false, []],
    [true, ['hover']],
    ['visible', ['visible']],
    [['mount', 'click'] as const, ['mount', 'click']],
  ] as const)('maps prefetch=%j to %j', (prefetch, expected) => {
    expect(linkPrefetchStrategies({ prefetch }, get)).toEqual(expected);
  });

  it('disables prefetch for document reloads', () => {
    expect(linkPrefetchStrategies({ prefetch: 'mount', reloadDocument: true }, get)).toEqual([]);
    expect(linkPrefetchStrategies({ reloadDocument: true }, get, 'hover')).toEqual([]);
  });

  it.each([
    [true, ['hover']],
    ['visible', ['visible']],
    [['hover', 'click'] as const, ['hover', 'click']],
    [false, []],
  ] as const)(
    'uses defaultStrategy=%j for a Link without a prefetch prop',
    (fallback, expected) => {
      expect(linkPrefetchStrategies({}, get, fallback)).toEqual(expected);
    },
  );

  it('replaces the default with the Link prop', () => {
    expect(linkPrefetchStrategies({ prefetch: 'visible' }, get, ['hover', 'click'])).toEqual([
      'visible',
    ]);
    expect(linkPrefetchStrategies({ prefetch: true }, get, 'mount')).toEqual(['hover']);
    expect(linkPrefetchStrategies({ prefetch: false }, get, 'hover')).toEqual([]);
  });

  it('applies the default only to GET links', () => {
    expect(linkPrefetchStrategies({}, post, 'hover')).toEqual([]);
  });
});

describe('linkActiveAttributes', () => {
  const page = { 'aria-current': 'page', 'data-void-active': '' };
  const nested = { 'data-void-active': '' };

  function attributes(
    url: string,
    props: Pick<BaseLinkProps, 'href' | 'method' | 'data'>,
    match?: LinkActiveMatch,
  ) {
    const router = { url: new URL(url, 'https://app.test') } as VoidRouter;
    return linkActiveAttributes(router, resolveLink(props), match);
  }

  it('marks only the current page by default', () => {
    expect(attributes('/admin/users', { href: '/admin/users' })).toEqual(page);
    expect(attributes('/admin/users/42', { href: '/admin/users' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/users' })).toEqual({});
  });

  it('also marks nested pages by whole segment with prefix', () => {
    expect(attributes('/admin/users', { href: '/admin/users' }, 'prefix')).toEqual(page);
    expect(attributes('/admin/users/42', { href: '/admin/users' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin/users/42/edit', { href: '/admin/users' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin/users', { href: '/admin/' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin/users-archive', { href: '/admin/users' }, 'prefix')).toEqual({});
    expect(attributes('/admin', { href: '/admin/users' }, 'prefix')).toEqual({});
  });

  it('only matches / on the home page', () => {
    expect(attributes('/', { href: '/' }, 'prefix')).toEqual(page);
    expect(attributes('/admin/users', { href: '/' }, 'prefix')).toEqual({});
  });

  it('ignores the query and hash', () => {
    expect(attributes('/inbox?page=2', { href: '/inbox' })).toEqual(page);
    expect(attributes('/settings?tab=billing', { href: '/settings?tab=profile' })).toEqual(page);
    expect(attributes('/search', { href: '/search', data: { q: 'void' } })).toEqual(page);
    expect(attributes('/docs', { href: '/docs#install' })).toEqual(page);
    expect(attributes('/docs#install', { href: '#usage' })).toEqual(page);
  });

  it('compares paths the way the router matches them', () => {
    expect(attributes('/admin', { href: '/Admin' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/' })).toEqual({});
    expect(attributes('/admin/', { href: '/admin' })).toEqual({});
    expect(attributes('/caf%C3%A9', { href: '/café' })).toEqual(page);
    expect(attributes('/caf%c3%a9', { href: '/caf%C3%A9' })).toEqual(page);
  });

  it('resolves relative and absolute hrefs against the current URL', () => {
    expect(attributes('/admin/users/42', { href: '42' })).toEqual(page);
    expect(attributes('/admin/users/42', { href: '../users' }, 'prefix')).toEqual(nested);
    expect(attributes('/admin', { href: 'https://app.test/admin' })).toEqual(page);
    expect(attributes('/', { href: 'https://example.com/' })).toEqual({});
    expect(attributes('/', { href: 'http://app.test/' })).toEqual({});
  });

  it('uses the request origin when the SSR page URL is relative', () => {
    vi.stubGlobal('window', undefined);
    const router = createSsrRouter('/users?view=all', {}, 'https://app.test/users?view=all');
    expect(router.url.href).toBe('https://app.test/users?view=all');
    expect(linkActiveAttributes(router, resolveLink({ href: 'https://app.test/users' }))).toEqual(
      page,
    );
    expect(linkActiveAttributes(router, resolveLink({ href: '//app.test/users' }))).toEqual(page);
    expect(linkActiveAttributes(router, resolveLink({ href: 'http://localhost/users' }))).toEqual(
      {},
    );
  });

  it('preserves the router origin in a server-side facade', () => {
    vi.stubGlobal('window', undefined);
    const router = createRouterFacade(createSsrRouter('https://app.test/previous'), () => '/users');
    expect(router.url.href).toBe('https://app.test/users');
    expect(linkActiveAttributes(router, resolveLink({ href: '//app.test/users' }))).toEqual(page);
    expect(linkActiveAttributes(router, resolveLink({ href: 'http://localhost/users' }))).toEqual(
      {},
    );
  });

  it('never marks links that are not GET or have no router', () => {
    expect(attributes('/logout', { href: '/logout', method: 'post' })).toEqual({});
    expect(linkActiveAttributes(null, resolveLink({ href: '/' }))).toEqual({});
  });
});

describe('linkPendingAttributes', () => {
  const pending = { 'data-void-pending': '' };
  const router = { url: new URL('/admin/users?page=1', 'https://app.test') } as VoidRouter;

  /** A visit in flight to `destination`, as the router reports it. */
  function visiting(destination: string, method: NavigationMethod = 'GET') {
    return {
      state: method === 'GET' ? ('loading' as const) : ('submitting' as const),
      location: new URL(destination, 'https://app.test'),
      method,
    };
  }

  function attributes(destination: string, props: Pick<BaseLinkProps, 'href' | 'method' | 'data'>) {
    return linkPendingAttributes(
      router,
      visiting(destination, props.method?.toUpperCase() as NavigationMethod),
      resolveLink(props),
    );
  }

  it('marks a link while a visit to its destination loads', () => {
    expect(attributes('/admin/users/42', { href: '/admin/users/42' })).toEqual(pending);
    expect(attributes('/admin/users/42', { href: '/admin/users' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/users' })).toEqual({});
  });

  it('compares the query and hash', () => {
    expect(attributes('/inbox?page=3', { href: '/inbox?page=3' })).toEqual(pending);
    expect(attributes('/inbox?page=3', { href: '/inbox?page=2' })).toEqual({});
    expect(attributes('/inbox?page=3', { href: '/inbox' })).toEqual({});
    expect(attributes('/search?q=void', { href: '/search', data: { q: 'void' } })).toEqual(pending);
    expect(attributes('/docs#install', { href: '/docs#install' })).toEqual(pending);
    expect(attributes('/docs#install', { href: '/docs' })).toEqual({});
  });

  it('compares paths the way the router matches them', () => {
    expect(attributes('/admin', { href: '/Admin' })).toEqual({});
    expect(attributes('/admin', { href: '/admin/' })).toEqual({});
    expect(attributes('/caf%C3%A9', { href: '/café' })).toEqual(pending);
    expect(attributes('/caf%c3%a9', { href: '/caf%C3%A9' })).toEqual(pending);
  });

  it('resolves relative and absolute hrefs against the current URL', () => {
    expect(attributes('/admin/users?page=2', { href: '?page=2' })).toEqual(pending);
    expect(attributes('/admin/users/42', { href: 'users/42' })).toEqual(pending);
    expect(attributes('/admin/users/42', { href: 'https://app.test/admin/users/42' })).toEqual(
      pending,
    );
    expect(attributes('/admin/users/42', { href: 'https://example.com/admin/users/42' })).toEqual(
      {},
    );
  });

  it('marks a non-GET link only during a visit with its method', () => {
    expect(attributes('/logout', { href: '/logout', method: 'post' })).toEqual(pending);
    expect(attributes('/users/1', { href: '/users/1', method: 'DELETE' })).toEqual(pending);
    expect(
      linkPendingAttributes(
        router,
        visiting('/logout', 'GET'),
        resolveLink({ href: '/logout', method: 'post' }),
      ),
    ).toEqual({});
    expect(
      linkPendingAttributes(router, visiting('/users', 'POST'), resolveLink({ href: '/users' })),
    ).toEqual({});
  });

  it('marks nothing when no visit is loading or there is no router', () => {
    const link = resolveLink({ href: '/admin/users/42' });
    expect(linkPendingAttributes(router, idleNavigationState(), link)).toEqual({});
    expect(
      linkPendingAttributes(router, { state: 'loading', location: null, method: 'GET' }, link),
    ).toEqual({});
    expect(linkPendingAttributes(router, null, link)).toEqual({});
    expect(linkPendingAttributes(null, visiting('/admin/users/42'), link)).toEqual({});
  });
});

describe('prefetchLink', () => {
  it('prefetches other destinations with cacheFor only when given', () => {
    const router = createRouter();
    prefetchLink(router, '/users/42', undefined);
    prefetchLink(router, '/users/43', '30s');

    expect(router.prefetch.mock.calls).toEqual([
      ['/users/42', {}],
      ['/users/43', { cacheFor: '30s' }],
    ]);
  });

  it('skips the current page and missing routers', () => {
    const router = createRouter();
    prefetchLink(router, '/users?page=1', undefined);
    prefetchLink(null, '/users/42', undefined);

    expect(router.prefetch).not.toHaveBeenCalled();
  });

  it('prefetches same-origin URLs and skips other sites and schemes', () => {
    const router = createRouter();
    prefetchLink(router, 'https://app.test/users/42', undefined);
    prefetchLink(router, 'https://example.com/users/42', undefined);
    prefetchLink(router, 'mailto:ada@example.com', undefined);

    expect(router.prefetch.mock.calls).toEqual([['https://app.test/users/42', {}]]);
  });
});

describe('handleLinkClick', () => {
  it('visits same-origin destinations with the navigation options', () => {
    const router = createRouter();
    const { event, preventDefault } = click();
    handleLinkClick(event, router, resolveLink({ href: '/users/42' }), {
      data: { ignored: true },
      preserveScroll: true,
      replace: true,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(router.visit).toHaveBeenCalledWith('/users/42', {
      method: 'GET',
      data: undefined,
      preserveScroll: true,
      preserveState: undefined,
      replace: true,
      viewTransition: undefined,
    });
  });

  it('sends data as the body for other methods', () => {
    const router = createRouter();
    const { event } = click();
    const data = { name: 'Ada' };
    handleLinkClick(event, router, resolveLink({ href: '/users', method: 'post', data }), {
      data,
    });

    expect(router.visit).toHaveBeenCalledWith(
      '/users',
      expect.objectContaining({ method: 'POST', data }),
    );
  });

  it.each([
    ['a modified click', click({ metaKey: true }).event, '/users/42', {}],
    ['a new-tab target', click({}, { target: '_blank' }).event, '/users/42', {}],
    ['a download', click({}, { download: '' }).event, '/users/42', {}],
    ['a prevented click', click({ defaultPrevented: true }).event, '/users/42', {}],
    ['a cross-origin destination', click().event, 'https://example.com/', {}],
    ['a document reload', click().event, '/users/42', { reloadDocument: true }],
  ] as const)('leaves %s to the browser', (_name, event, href, props) => {
    const router = createRouter();
    handleLinkClick(event, router, resolveLink({ href }), props);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(router.visit).not.toHaveBeenCalled();
  });

  it('cancels the visit when onNavigate prevents it', () => {
    const router = createRouter();
    const { event, preventDefault } = click();
    handleLinkClick(event, router, resolveLink({ href: '/users/42' }), {
      onNavigate: (navigation) => navigation.preventDefault(),
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(router.visit).not.toHaveBeenCalled();
  });
});

describe('observeLinkVisible', () => {
  function observeStub() {
    let notify: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const element = {} as Element;
    const onVisible = vi.fn();
    const stop = observeLinkVisible(element, onVisible);
    const show = (isIntersecting: boolean) => notify([{ isIntersecting }]);
    return {
      element,
      observe,
      disconnect,
      onVisible,
      stop,
      show,
      notify: (...entries: Array<boolean>) =>
        notify(entries.map((isIntersecting) => ({ isIntersecting }))),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls back once the element has stayed visible for the delay', () => {
    const { element, observe, disconnect, onVisible, stop, show } = observeStub();

    expect(observe).toHaveBeenCalledWith(element);
    show(false);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    expect(onVisible).not.toHaveBeenCalled();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    expect(onVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onVisible).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    stop();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('skips an element that leaves before the delay', () => {
    const { onVisible, disconnect, show } = observeStub();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    show(false);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY * 2);

    expect(onVisible).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('restarts the delay when the element becomes visible again', () => {
    const { onVisible, show } = observeStub();

    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    show(false);
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY - 1);
    expect(onVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('uses the latest entry when one callback reports several changes', () => {
    const { onVisible, notify } = observeStub();

    notify(false, true, false);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    expect(onVisible).not.toHaveBeenCalled();

    notify(true, false, true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('calls back only once', () => {
    const { onVisible, show } = observeStub();

    show(true);
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);
    show(false);
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY * 2);

    expect(onVisible).toHaveBeenCalledOnce();
  });

  it('cancels a pending callback on cleanup', () => {
    const { onVisible, disconnect, stop, show } = observeStub();

    show(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    // An entry queued before the cleanup can still arrive.
    show(true);
    vi.advanceTimersByTime(LINK_VISIBLE_PREFETCH_DELAY);

    expect(onVisible).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
