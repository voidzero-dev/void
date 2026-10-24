import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createVoidRouter, ssrProxy, type VoidRouterConfig } from '../../src/pages/client.ts';
import { createPageNavigationEngine } from '../../src/pages/navigation-engine.ts';
import { parseCacheFor } from '../../src/pages/prefetch.ts';

type DeferredTestWindow = Window & {
  __resolveDeferred(group: string, data: unknown): void;
};

type TestRouterConfig = Partial<Omit<VoidRouterConfig, 'adapter'>> & {
  adapter?: Partial<VoidRouterConfig['adapter']>;
};

function stubClientGlobals(origin = 'http://localhost') {
  const documentStub = {
    createElement: vi.fn(() => ({})),
    getElementById: vi.fn((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            props: {},
          }),
        };
      }
      if (id === 'app') {
        return {
          getAttribute: vi.fn((): string | null => null),
        };
      }
      return null;
    }),
    head: {
      appendChild: vi.fn(),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
    querySelector: vi.fn(() => null),
  };

  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    location: {
      origin,
      pathname: '/',
      search: '',
      hash: '',
    },
    scrollX: 0,
    scrollY: 0,
    scrollTo: vi.fn(),
  });
  vi.stubGlobal('history', {
    pushState: vi.fn(),
    replaceState: vi.fn(),
    scrollRestoration: 'auto',
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });

  return documentStub;
}

function pageJson(body: unknown): Response {
  return Response.json(body, { headers: { 'X-VoidPages': 'true' } });
}

const loadComponent = async () => ({ default: {} });

function createTestRouter({ adapter, ...config }: TestRouterConfig = {}) {
  return createVoidRouter({
    components: { home: loadComponent },
    layoutTree: {},
    routeMeta: {},
    matchRoute: () => 'home',
    viewTransitions: false,
    prefetchHoverDelay: 75,
    prefetchDefaultCacheFor: parseCacheFor('30s'),
    ...config,
    adapter: {
      applyUpdate: vi.fn(),
      createDeferred: () => ({}),
      isLoading: () => false,
      resolveDeferred: (_ref, value) => value,
      rejectDeferred: (_ref, error) => error,
      ...adapter,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createVoidRouter', () => {
  it('requires the page-data script even when a legacy data-page attribute is present', async () => {
    const documentStub = stubClientGlobals();
    documentStub.getElementById.mockImplementation((id: string) =>
      id === 'app'
        ? { getAttribute: vi.fn(() => JSON.stringify({ component: 'home', props: {} })) }
        : null,
    );
    await expect(createTestRouter()).rejects.toThrow('pages: Missing initial page payload.');
  });

  it.each([
    [{}, false],
    [{ method: 'POST' }, true],
    [{ preserveState: true }, true],
    [{ method: 'POST', preserveState: false }, false],
  ] as const)('passes page preservation to the adapter for %j', async (options, preserveState) => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson({ component: 'home', props: {} })),
    );
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({ adapter: { applyUpdate } });
    await router.visit('/next', options);
    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState });
  });

  it('returns stable route values from the SSR proxy', () => {
    expect(ssrProxy.path).toBe('/');
    expect(ssrProxy.url.pathname).toBe('/');
    expect(ssrProxy.query.toString()).toBe('');
    expect(() => ssrProxy.visit('/users')).toThrow(
      'Void Router: visit() is not available during SSR.',
    );
  });

  it('rejects non-GET methods before route side effects', async () => {
    const documentStub = stubClientGlobals();
    const homeLoader = vi.fn(async () => ({ default: {} }));
    const usersLoader = vi.fn(async () => ({ default: {} }));
    const layoutLoader = vi.fn(async () => ({ default: {} }));
    const matchRoute = vi.fn(() => 'users');

    const { router } = await createTestRouter({
      components: {
        home: homeLoader,
        layout: layoutLoader,
        users: usersLoader,
      },
      layoutTree: {
        users: ['layout'],
      },
      matchRoute,
      routeMeta: {
        users: {},
      },
    });

    expect(() => router.prefetch('/users', { method: 'POST' })).toThrow(
      'Void Router: prefetch() only supports GET requests.',
    );
    expect(matchRoute).not.toHaveBeenCalled();
    expect(usersLoader).not.toHaveBeenCalled();
    expect(layoutLoader).not.toHaveBeenCalled();
    expect(documentStub.createElement).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();
  });

  it('returns a promise that resolves when page data is prefetched', async () => {
    stubClientGlobals();
    const pageData = {
      component: 'users',
      props: { users: [] },
    };
    const fetchMock = vi.fn(() => Promise.resolve(pageJson(pageData)));
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
      routeMeta: {
        users: {},
      },
    });

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(router.prefetch('/users')).resolves.toEqual(pageData);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['replace', 'mutate'])(
    'keeps prefetched deferred data intact with %s adapters',
    async (mode) => {
      stubClientGlobals();
      const pageData = {
        component: 'users',
        props: { stats: { count: 42 } },
        deferredKeys: { stats: 'stats' },
      };
      const fetchMock = vi.fn(async () => pageJson(pageData));
      vi.stubGlobal('fetch', fetchMock);
      const applyUpdate = vi.fn();
      const { router } = await createTestRouter({
        adapter: {
          applyUpdate,
          createDeferred: () => ({ loading: true, value: null, error: null }),
          isLoading: (ref) => (ref as { loading: boolean }).loading,
          resolveDeferred: (ref, value) =>
            mode === 'mutate'
              ? Object.assign(ref as object, { loading: false, value })
              : { loading: false, value, error: null },
          rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        },
        components: { home: loadComponent, users: loadComponent },
        matchRoute: () => 'users',
      });
      try {
        await router.prefetch('/users');
        for (let visit = 0; visit < 3; visit++) {
          await router.visit('/users');
          const rendered = applyUpdate.mock.calls.at(-1)![0];
          expect(rendered.props.stats).toEqual({
            loading: false,
            value: { count: 42 },
            error: null,
          });
          // Component mutations must not become part of the next cached visit either.
          rendered.props.stats.value.count = 100;
          expect(await router.prefetch('/users')).toEqual(pageData);
        }
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        router.flushAll();
      }
    },
  );

  it('rejects a failed deferred group from a prefetched payload', async () => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        pageJson({
          component: 'users',
          props: { stats: { count: 1 } },
          deferredKeys: { stats: 'stats', usage: 'usage' },
          deferredErrors: { usage: 'Internal Server Error' },
        }),
      ),
    );
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: {
        applyUpdate,
        createDeferred: () => ({ loading: true, value: null, error: null }),
        isLoading: (ref) => (ref as { loading: boolean }).loading,
        resolveDeferred: (_ref, value) => ({ loading: false, value, error: null }),
        rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
      },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: () => 'users',
    });
    try {
      await router.prefetch('/users');
      await router.visit('/users');

      const rendered = applyUpdate.mock.calls.at(-1)![0];
      expect(rendered.props.stats).toEqual({ loading: false, value: { count: 1 }, error: null });
      expect(rendered.props.usage).toEqual({
        loading: false,
        value: null,
        error: 'Internal Server Error',
      });
    } finally {
      router.flushAll();
    }
  });

  it('serves revalidated data after a stale-while-revalidate refresh', async () => {
    stubClientGlobals();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        n += 1;
        return Promise.resolve(pageJson({ component: 'users', props: { v: n } }));
      }),
    );

    const { router } = await createTestRouter({
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
      prefetchDefaultCacheFor: parseCacheFor(['5ms', '10s']),
      routeMeta: { users: {} },
    });

    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { v: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Visit while stale: serves v:1 and fires the background revalidate to v:2.
    await router.visit('/users');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The next read must return the revalidated v:2, not the discarded-refresh stale v:1.
    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { v: 2 } });
  });

  it('reuses visited GET page shells while their refresh is pending when opted in', async () => {
    stubClientGlobals();
    let requests = 0;
    let finishRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => {
      requests += 1;
      if (requests === 3) {
        return new Promise<Response>((resolve) => {
          finishRefresh = resolve;
        });
      }
      return Promise.resolve(
        pageJson({ component: requests === 2 ? 'other' : 'users', props: { version: requests } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: loadComponent, other: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'other'),
      prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
      cacheVisitedPageData: true,
    });

    await router.visit('/users');
    await router.visit('/other');
    const revisit = await router.visit('/users');
    expect(revisit).toMatchObject({ props: { version: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(applyUpdate.mock.lastCall?.[0]).toMatchObject({ props: { version: 1 } });

    expect(finishRefresh).toBeTypeOf('function');
    finishRefresh!(pageJson({ component: 'users', props: { version: 3 } }));
    await expect(router.prefetch('/users')).resolves.toMatchObject({ props: { version: 3 } });
  });

  it('reuses the server-rendered initial page on a return visit', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/dashboard';
    vi.mocked(documentStub.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'dashboard',
            props: { version: 1 },
            params: {},
            shared: {},
            url: '/dashboard',
            errors: null,
          }),
        };
      }
      return id === 'app' ? { getAttribute: () => null } : null;
    });
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        pageJson({
          component: url === '/users' ? 'users' : 'dashboard',
          props: { version: url === '/users' ? 2 : 3 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      components: { dashboard: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/dashboard' ? 'dashboard' : 'users'),
      prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
      cacheVisitedPageData: true,
    });

    await router.visit('/users');
    await expect(router.visit('/dashboard')).resolves.toMatchObject({ props: { version: 1 } });
    await expect(router.prefetch('/dashboard')).resolves.toMatchObject({ props: { version: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not resolve disposed initial deferred props into a later page', async () => {
    stubClientGlobals();
    const initialPayload = {
      component: 'home',
      deferredKeys: { stats: 'stats' },
      props: { stats: { loading: true, value: null, error: null } },
    };
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return { textContent: JSON.stringify(initialPayload) } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const rejectDeferred = vi.fn((_ref, error) => ({
      loading: false,
      value: null,
      error: new Error(error),
    }));
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(pageJson({ component: 'next', props: { title: 'Next' } }))),
    );

    const { router, start } = await createTestRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: { home: loadComponent, next: loadComponent },
      matchRoute: () => 'next',
    });

    start();
    await router.visit('/next');

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'next' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
    expect(rejectDeferred).toHaveBeenCalledTimes(1);

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'routes an ungrouped deferred object to its own prop only',
      deferredKeys: { stats: 'stats', comments: 'comments' },
      messages: [
        ['stats', { comments: 12, views: 100 }],
        ['comments', [{ id: 1 }]],
      ],
      pendingAfterFirst: ['comments'],
      expected: { stats: { comments: 12, views: 100 }, comments: [{ id: 1 }] },
    },
    {
      name: 'splits a named group object across its props',
      deferredKeys: { metrics: 'analytics', chart: 'analytics' },
      messages: [['analytics', { metrics: 1, chart: 2 }]],
      pendingAfterFirst: [],
      expected: { metrics: 1, chart: 2 },
    },
    {
      name: 'resolves each named group prop to undefined for non-object data',
      deferredKeys: { metrics: 'analytics', chart: 'analytics' },
      messages: [['analytics', null]],
      pendingAfterFirst: [],
      expected: { metrics: undefined, chart: undefined },
    },
  ])('$name', async ({ deferredKeys, messages, pendingAfterFirst, expected }) => {
    stubClientGlobals();
    const initialPayload = { component: 'home', deferredKeys, props: {} };
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return { textContent: JSON.stringify(initialPayload) } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });
    let props: Record<string, unknown> = {};
    const { start } = await createTestRouter({
      adapter: {
        createDeferred: () => ({ loading: true, value: null, error: null }),
        isLoading: (ref) => Boolean((ref as { loading?: boolean })?.loading),
        resolveDeferred: (_ref, value) => ({ loading: false, value, error: null }),
        rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        onDeferredUpdate: (next) => {
          props = { ...next };
        },
      },
    });

    start();
    const resolveDeferred = (window as unknown as DeferredTestWindow).__resolveDeferred;
    for (const [index, [group, data]] of messages.entries()) {
      resolveDeferred(group as string, data);
      if (index === 0) {
        for (const key of pendingAfterFirst) {
          expect(props[key]).toEqual({ loading: true, value: null, error: null });
        }
      }
    }

    expect(props).toEqual(
      Object.fromEntries(
        Object.entries(expected).map(([key, value]) => [
          key,
          { loading: false, value, error: null },
        ]),
      ),
    );
  });

  it.each([
    ['/books?delete&page=2', '/books?page=2', '/books?page=2'],
    ['/books?delete', '/books', '/books'],
    ['/books?page=2', '/books?page=2', '/books?page=2'],
    ['/books?a&b', '/books?a&b', '/books?a&b'],
  ])('writes POST %s with page URL %s to history as %s', async (url, pageUrl, historyUrl) => {
    stubClientGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => pageJson({ component: 'home', props: {}, url: pageUrl, errors: null })),
    );
    const { router } = await createTestRouter();

    await router.visit(url, { method: 'POST' });

    expect(history.pushState).toHaveBeenCalledWith(expect.anything(), '', historyUrl);
  });

  it('runs navigation listeners for same-page hash visits', async () => {
    const documentStub = stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    const matchRoute = vi.fn(() => 'home');
    vi.stubGlobal('fetch', vi.fn());

    const events: Array<string> = [];
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      matchRoute,
      onNavigationChange(navigation) {
        events.push(navigation.state);
      },
    });

    await router.visit('#section');

    expect(events).toEqual(['loading', 'idle']);
    expect(history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/docs?tab=api#section',
    );
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(matchRoute).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();
  });

  it('keeps pending navigation state when an older visit aborts', async () => {
    stubClientGlobals();
    let resolveFast!: (response: Response) => void;
    const events: Array<string> = [];
    const applyUpdate = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        if (url === '/fast') {
          return new Promise<Response>((resolve) => {
            resolveFast = resolve;
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { fast: loadComponent, home: loadComponent, slow: loadComponent },
      matchRoute: (url) => {
        if (url === '/slow') {
          return 'slow';
        }
        if (url === '/fast') {
          return 'fast';
        }
        return 'home';
      },
      onNavigationChange(navigation) {
        events.push(navigation.state);
      },
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const fastVisit = router.visit('/fast');
    await slowVisit;

    expect(events).toEqual(['loading', 'loading']);

    resolveFast(pageJson({ component: 'fast', props: { title: 'Fast' } }));
    await fastVisit;

    expect(events).toEqual(['loading', 'loading', 'idle']);
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'fast' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
  });

  it('resolves abandoned GET visits without surfacing abort errors to fire-and-forget callers', async () => {
    stubClientGlobals();

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        if (url === '/fast') {
          return Promise.resolve(pageJson({ component: 'fast', props: { title: 'Fast' } }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const { router } = await createTestRouter({
      components: { fast: loadComponent, home: loadComponent, slow: loadComponent },
      matchRoute: (url) => {
        if (url === '/slow') {
          return 'slow';
        }
        if (url === '/fast') {
          return 'fast';
        }
        return 'home';
      },
    });

    const slowVisit = router.visit('/slow');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.visit('/fast');

    await expect(slowVisit).resolves.toBeUndefined();
  });

  it('does not fetch or write history for same-page hash popstate visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn());

    const { router } = await createTestRouter({ adapter: { applyUpdate } });

    await router.visit('/docs?tab=api#section', {
      preserveState: true,
      _popstate: true,
      _scrollPosition: { x: 0, y: 42 },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 42);
  });

  it('does not fetch or write history for same-page hash removal popstate visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    const matchRoute = vi.fn(() => 'home');
    vi.stubGlobal('fetch', vi.fn());

    const { router } = await createTestRouter({ adapter: { applyUpdate }, matchRoute });

    await router.visit('/docs?tab=api', {
      preserveState: true,
      _popstate: true,
      _scrollPosition: { x: 0, y: 42 },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(matchRoute).not.toHaveBeenCalled();
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 42);
  });

  it('writes history for same-page hash visits when state is preserved', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    window.location.search = '?tab=api';
    const applyUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn());

    const { router } = await createTestRouter({ adapter: { applyUpdate } });

    await router.visit('#section', { preserveState: true });

    expect(fetch).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/docs?tab=api#section',
    );
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('uses the browser URL for non-popstate hash visits after preserved navigation', async () => {
    stubClientGlobals();
    window.location.pathname = '/';
    const applyUpdate = vi.fn();
    const fetchMock = vi.fn((url: string) => {
      if (url !== '/next') {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Promise.resolve(pageJson({ component: 'next', props: { title: 'Next' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, next: loadComponent },
      matchRoute: (url) => (url === '/next' ? 'next' : 'home'),
    });

    await router.visit('/next', { preserveState: true });
    expect(fetchMock).toHaveBeenCalledWith(
      '/next',
      expect.objectContaining({ headers: { 'X-VoidPages': 'true', Accept: 'application/json' } }),
    );
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'next' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );

    fetchMock.mockClear();
    applyUpdate.mockClear();
    vi.mocked(history.pushState).mockClear();
    vi.mocked(history.replaceState).mockClear();
    vi.mocked(window.scrollTo).mockClear();

    await router.visit('#section');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/#section',
    );
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('aborts pending navigations before same-page hash popstate visits', async () => {
    stubClientGlobals();
    window.location.pathname = '/docs';
    const applyUpdate = vi.fn();
    let aborted = false;
    let resolveSlow!: (response: Response) => void;
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      if (url !== '/slow') {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      init.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<Response>((resolve) => {
        resolveSlow = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, slow: loadComponent },
      matchRoute: (url) => (url === '/slow' ? 'slow' : 'home'),
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await router.visit('/docs#section', {
      preserveState: true,
      _popstate: true,
      _scrollPosition: { x: 0, y: 42 },
    });

    expect(aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 42);

    resolveSlow(pageJson({ component: 'slow', props: { title: 'Slow' } }));
    await slowVisit;

    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it('fetches when a popstate hash visit targets a different committed page', async () => {
    stubClientGlobals();
    window.location.pathname = '/users';
    const applyUpdate = vi.fn();
    const fetchMock = vi.fn(() =>
      Promise.resolve(pageJson({ component: 'docs', props: { title: 'Docs' } })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { docs: loadComponent, home: loadComponent },
      matchRoute: () => 'docs',
    });

    window.location.pathname = '/docs';
    await router.visit('/docs#section', {
      preserveState: true,
      _popstate: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/docs',
      expect.objectContaining({ headers: { 'X-VoidPages': 'true', Accept: 'application/json' } }),
    );
    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'docs' }),
      {},
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
  });

  it('keeps preserved initial deferred props alive after a mutation commits', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { stats: 'stats' },
            props: { stats: { loading: true, value: null, error: null } },
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const initialRef = { loading: true, value: null, error: null };
    const resolveDeferred = vi.fn((ref, value) => {
      ref.loading = false;
      ref.value = value;
      return ref;
    });
    const rejectDeferred = vi.fn((ref, error) => {
      ref.loading = false;
      ref.error = new Error(error);
      return ref;
    });
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(pageJson({ component: 'home', props: { stats: null, title: 'Updated' } })),
      ),
    );

    const { router, start } = await createTestRouter({
      adapter: {
        applyUpdate,
        createDeferred: vi.fn(() => initialRef),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
    });

    start();
    await router.visit('/', { method: 'POST', data: { ok: true } });

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        props: expect.objectContaining({ stats: initialRef, title: 'Updated' }),
      }),
      expect.anything(),
      [],
      expect.objectContaining({ preserveState: expect.any(Boolean) }),
    );
    expect(rejectDeferred).not.toHaveBeenCalled();

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });

    expect(resolveDeferred).toHaveBeenCalledWith(initialRef, { count: 42 });
    expect(initialRef).toMatchObject({
      loading: false,
      value: { count: 42 },
      error: null,
    });
  });

  it('splits a group object when a mutation preserves only part of the group', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { metrics: 'analytics', chart: 'analytics' },
            props: {},
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(pageJson({ component: 'home', props: { metrics: null, chart: 'new' } })),
      ),
    );
    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));

    const { router, start } = await createTestRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: () => ({ loading: true, value: null, error: null }),
        isLoading: (ref) => Boolean((ref as { loading?: boolean })?.loading),
        rejectDeferred: (_ref, error) => ({ loading: false, value: null, error }),
        resolveDeferred,
      },
    });

    start();
    await router.visit('/', { method: 'POST', data: { ok: true } });
    (window as unknown as DeferredTestWindow).__resolveDeferred('analytics', {
      metrics: 1,
      chart: 2,
    });

    expect(resolveDeferred).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1);
  });

  it('keeps the committed page deferred registry alive while a new navigation is pending', async () => {
    stubClientGlobals();
    vi.mocked(document.getElementById).mockImplementation((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            deferredKeys: { stats: 'stats' },
            props: { stats: { loading: true, value: null, error: null } },
          }),
        } as HTMLElement;
      }
      if (id === 'app') {
        return { getAttribute: vi.fn(() => null) } as unknown as HTMLElement;
      }
      return null;
    });

    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const rejectDeferred = vi.fn((_ref, error) => ({
      loading: false,
      value: null,
      error: new Error(error),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (url === '/slow') {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('Navigation aborted', 'AbortError'));
            });
          });
        }
        return Promise.resolve(pageJson({ component: 'fast', props: { title: 'Fast' } }));
      }),
    );

    const { router, start } = await createTestRouter({
      adapter: {
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred,
        resolveDeferred,
      },
      components: { fast: loadComponent, home: loadComponent },
      matchRoute: (url) => (url === '/slow' ? 'slow' : 'fast'),
    });

    start();
    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    (window as unknown as DeferredTestWindow).__resolveDeferred('stats', { count: 42 });
    expect(resolveDeferred).toHaveBeenCalledWith(expect.anything(), { count: 42 });

    await router.visit('/fast');
    await slowVisit;
    expect(rejectDeferred).not.toHaveBeenCalled();
  });

  it('ignores deferred chunks from an aborted pending navigation', async () => {
    stubClientGlobals();

    let slowStreamController!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const resolveDeferred = vi.fn((_ref, value) => ({ loading: false, value, error: null }));
    const slowComponent = new Promise<{ default: unknown }>(() => {});

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/slow') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              slowStreamController = controller;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    component: 'slow',
                    deferredKeys: { stats: 'stats' },
                    props: { title: 'Slow', stats: { loading: true, value: null, error: null } },
                  }) + '\n',
                ),
              );
            },
          });
          return Promise.resolve(
            new Response(stream, {
              headers: {
                'content-type': 'application/x-ndjson',
                'X-VoidPages': 'true',
              },
            }),
          );
        }
        return Promise.resolve(pageJson({ component: 'fast', props: { title: 'Fast' } }));
      }),
    );

    const { router } = await createTestRouter({
      adapter: {
        createDeferred: vi.fn(() => ({ loading: true, value: null, error: null })),
        isLoading: vi.fn((ref) => Boolean(ref?.loading)),
        rejectDeferred: vi.fn((_ref, error) => ({
          loading: false,
          value: null,
          error: new Error(error),
        })),
        resolveDeferred,
      },
      components: {
        fast: loadComponent,
        home: loadComponent,
        slow: vi.fn(() => slowComponent),
      },
      matchRoute: (url) => (url === '/slow' ? 'slow' : 'fast'),
    });

    const slowVisit = router.visit('/slow').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.visit('/fast');

    slowStreamController.enqueue(
      encoder.encode(JSON.stringify({ __deferred: 'stats', data: { count: 1 } }) + '\n'),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await slowVisit;

    expect(resolveDeferred).not.toHaveBeenCalled();
  });
});

describe('createVoidRouter other-origin visits', () => {
  async function createRouter(origin = 'http://localhost') {
    stubClientGlobals(origin);
    const fetchMock = vi.fn(async () => pageJson({ component: 'users', props: { users: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const applyUpdate = vi.fn();
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, users: loadComponent },
      matchRoute: (url) => (url === '/users' ? 'users' : 'home'),
    });
    return { router, fetchMock, applyUpdate };
  }

  it.each([
    ['GET', '/users'],
    ['GET', 'capacitor://localhost/users'],
    ['POST', '/users'],
    ['POST', 'capacitor://localhost/users'],
  ])('loads Capacitor %s visits to %s in place', async (method, url) => {
    const { router, fetchMock, applyUpdate } = await createRouter('capacitor://localhost');
    await router.visit(url, { method });
    expect(fetchMock).toHaveBeenCalledWith('/users', expect.objectContaining({ method }));
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBeUndefined();
  });

  it('follows a same-host Capacitor action redirect in place', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter('capacitor://localhost');
    const response = pageJson({ component: 'users', props: { users: [] } });
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: 'capacitor://localhost/users' },
    });
    fetchMock.mockResolvedValueOnce(response);
    await router.visit('/submit', { method: 'POST' });
    // The redirect destination is rendered from the followed response, not fetched again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBeUndefined();
  });

  it('does not fetch another Capacitor host for GET navigation', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter('capacitor://localhost');
    await router.visit('capacitor://other/users');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(window.location.href).toBe('capacitor://other/users');
  });

  it('does not treat different Capacitor hosts as the same origin', async () => {
    const { router, fetchMock } = await createRouter('capacitor://localhost');
    await expect(router.visit('capacitor://other/users', { method: 'POST' })).rejects.toThrow(
      'Void Router: non-GET visits must target the current origin.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///users', 'app://localhost/users'])(
    'still rejects %s from Capacitor',
    async (url) => {
      const { router, fetchMock } = await createRouter('capacitor://localhost');
      await expect(router.visit(url)).rejects.toThrow(/refusing to navigate/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(window.location.href).toBeUndefined();
    },
  );

  it.each(['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,x'])(
    'rejects %j without fetching or assigning location',
    async (url) => {
      const { router, fetchMock, applyUpdate } = await createRouter();

      await expect(router.visit(url)).rejects.toThrow(/refusing to navigate/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(applyUpdate).not.toHaveBeenCalled();
      expect(window.location.href).toBeUndefined();
    },
  );

  it('rejects a same-origin blob URL passed straight to the navigation engine', async () => {
    stubClientGlobals();
    const fetchMock = vi.fn(
      async () => new Response('<script></script>', { headers: { 'Content-Type': 'text/html' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const engine = await createPageNavigationEngine({
      adapter: {
        createDeferred: () => ({}),
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: (_ref, error) => error,
        isLoading: () => false,
      },
      components: { home: loadComponent },
      layoutTree: {},
      routeMeta: {},
      matchRoute: () => 'home',
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
    });

    const resource = engine.prepareVisit(
      'blob:http://localhost/0b5e4c1a-7f0d-4f9e-9b52-1c3d2e4f5a6b',
    );

    await expect(resource.shell).rejects.toThrow('refusing to navigate to a blob: URL');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it('sends other-origin http(s) GET visits to a full page load without fetching', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();

    await expect(router.visit('https://other.example/x?y=1#z')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(window.location.href).toBe('https://other.example/x?y=1#z');
  });

  it('rejects non-GET visits to another origin without sending them', async () => {
    const { router, fetchMock } = await createRouter();

    await expect(
      router.visit('https://other.example/x', { method: 'POST', data: { a: 1 } }),
    ).rejects.toThrow('Void Router: non-GET visits must target the current origin.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.href).toBeUndefined();
  });

  it('still loads absolute same-origin URLs in place', async () => {
    const { router, fetchMock, applyUpdate } = await createRouter();

    await router.visit('http://localhost/users');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/users',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-VoidPages': 'true' }),
      }),
    );
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    expect(applyUpdate.mock.calls[0][0]).toMatchObject({ component: 'users' });
    expect(window.location.href).toBeUndefined();
  });
});

describe('preserveState history updates (#506)', () => {
  function setup() {
    stubClientGlobals();
    window.location.pathname = '/case';
    const applyUpdate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          pageJson({
            component: url.startsWith('/settings') ? 'settings' : 'home',
            props: {},
            url,
          }),
        ),
      ),
    );
    return { applyUpdate };
  }

  async function router(applyUpdate: ReturnType<typeof setup>['applyUpdate']) {
    const { router } = await createTestRouter({
      adapter: { applyUpdate },
      components: { home: loadComponent, settings: loadComponent },
      matchRoute: (url) => (url.startsWith('/settings') ? 'settings' : 'home'),
    });
    vi.mocked(history.pushState).mockClear();
    vi.mocked(history.replaceState).mockClear();
    return router;
  }

  it('pushes the destination URL while preserving state', async () => {
    const { applyUpdate } = setup();
    const r = await router(applyUpdate);

    await r.visit('/settings', { preserveState: true });

    expect(applyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'settings' }),
      expect.anything(),
      expect.anything(),
      { preserveState: true },
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);
    expect(history.pushState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/settings',
    );
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('replaces the current entry with replace: true while preserving state', async () => {
    const { applyUpdate } = setup();
    const r = await router(applyUpdate);

    await r.visit('/settings?tab=a#top', { preserveState: true, replace: true });

    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState: true });
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/settings?tab=a#top',
    );
  });

  it('refetches the current URL in place on router.refresh(), hash included', async () => {
    const { applyUpdate } = setup();
    window.location.search = '?tab=a';
    window.location.hash = '#top';
    const r = await router(applyUpdate);

    await r.refresh();

    expect(fetch).toHaveBeenCalledWith('/case?tab=a', expect.anything());
    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState: true });
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledWith(
      expect.objectContaining({ __voidScrollKey: expect.any(String) }),
      '',
      '/case?tab=a#top',
    );
  });

  it('does not write history for back/forward navigation', async () => {
    const { applyUpdate } = setup();
    const r = await router(applyUpdate);

    await r.visit('/settings', { preserveState: true, _popstate: true, _scrollPosition: null });

    expect(applyUpdate.mock.calls[0][3]).toEqual({ preserveState: true });
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});

describe('superseded navigation commits (#507)', () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  // pushState and replaceState move window.location, like a browser.
  function setup() {
    const documentStub = stubClientGlobals();
    Object.assign(documentStub, { title: 'Home' });
    const writeHistory = (_state: unknown, _title: string, url?: string | URL | null) => {
      if (url != null) {
        const target = new URL(url, window.location.origin);
        Object.assign(window.location, {
          pathname: target.pathname,
          search: target.search,
          hash: target.hash,
        });
      }
    };
    vi.mocked(history.pushState).mockImplementation(writeHistory);
    vi.mocked(history.replaceState).mockImplementation(writeHistory);
    const fetchGates = new Map<string, Promise<void>>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        await fetchGates.get(url);
        return url === '/a'
          ? pageJson({ component: 'a', url, props: {}, head: { title: 'A' } })
          : pageJson({
              component: 'b',
              url,
              props: { stats: null },
              deferredKeys: { stats: 'stats' },
              head: { title: 'B' },
            });
      }),
    );
    const updateGates = new Map<string, Promise<void>>();
    const rendered: Array<string> = [];
    const applyUpdate = vi.fn((pageData: { url?: string }) => {
      rendered.push(pageData.url ?? '');
      return updateGates.get(pageData.url ?? '');
    });
    const rejectDeferred = vi.fn((_ref, error) => error);
    return { documentStub, fetchGates, updateGates, rendered, applyUpdate, rejectDeferred };
  }

  async function router(page: ReturnType<typeof setup>, config: TestRouterConfig = {}) {
    const created = await createTestRouter({
      ...config,
      adapter: {
        applyUpdate: page.applyUpdate,
        createDeferred: () => ({ loading: true }),
        isLoading: () => true,
        rejectDeferred: page.rejectDeferred,
      },
      components: { a: loadComponent, b: loadComponent, home: loadComponent },
      matchRoute: (url) => (url.startsWith('/a') ? 'a' : url.startsWith('/b') ? 'b' : 'home'),
    });
    vi.mocked(history.pushState).mockClear();
    vi.mocked(history.replaceState).mockClear();
    vi.mocked(window.scrollTo).mockClear();
    return created.router;
  }

  async function entered(page: ReturnType<typeof setup>, url: string) {
    await vi.waitFor(() => expect(page.rendered).toContain(url));
  }

  it('commits each visit in order when they do not overlap', async () => {
    const page = setup();
    const r = await router(page);

    await r.visit('/a');
    await r.visit('/b');

    expect(vi.mocked(history.pushState).mock.calls.map((call) => call[2])).toEqual(['/a', '/b']);
    expect(window.location.pathname).toBe('/b');
    expect(page.documentStub).toMatchObject({ title: 'B' });
  });

  it('keeps the newer page when an older visit finishes applying after it commits', async () => {
    const page = setup();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);

    const visitA = r.visit('/a');
    await entered(page, '/a');
    await r.visit('/b');
    vi.mocked(window.scrollTo).mockClear();
    a.release();

    await expect(visitA).resolves.toBeUndefined();
    expect(window.location.pathname).toBe('/b');
    expect(r.url.pathname).toBe('/b');
    expect(vi.mocked(history.pushState).mock.calls.map((call) => call[2])).toEqual(['/b']);
    expect(page.documentStub).toMatchObject({ title: 'B' });
    expect(window.scrollTo).not.toHaveBeenCalled();
    // A's commit would have disposed B and rejected its pending Deferred prop.
    expect(page.rejectDeferred).not.toHaveBeenCalled();
  });

  it('commits an older visit that finishes before the newer one commits', async () => {
    const page = setup();
    const a = gate();
    const b = gate();
    page.updateGates.set('/a', a.promise);
    page.fetchGates.set('/b', b.promise);
    const r = await router(page);

    const visitA = r.visit('/a');
    await entered(page, '/a');
    const visitB = r.visit('/b');
    a.release();
    // A is on screen, so its URL is written until B commits.
    await expect(visitA).resolves.toMatchObject({ url: '/a' });
    expect(window.location.pathname).toBe('/a');

    b.release();
    await visitB;
    expect(vi.mocked(history.pushState).mock.calls.map((call) => call[2])).toEqual(['/a', '/b']);
    expect(window.location.pathname).toBe('/b');
  });

  it('lets a visit started while the new page mounts replace that page', async () => {
    const page = setup();
    const r = await router(page);
    // Like a redirect from Vue's onMounted, which runs before applyUpdate settles.
    page.applyUpdate.mockImplementation((pageData: { url?: string }) => {
      page.rendered.push(pageData.url ?? '');
      if (pageData.url === '/a') {
        void r.visit('/b', { replace: true });
      }
      return Promise.resolve();
    });

    await r.visit('/a');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/b'));

    expect(vi.mocked(history.pushState).mock.calls.map((call) => call[2])).toEqual(['/a']);
    expect(vi.mocked(history.replaceState).mock.calls.at(-1)?.[2]).toBe('/b');
  });

  it('keeps page and URL together when a same-page hash visit starts during an update', async () => {
    const page = setup();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);

    const visitA = r.visit('/a');
    await entered(page, '/a');
    await r.visit('#x');
    a.release();

    await expect(visitA).resolves.toMatchObject({ url: '/a' });
    expect(window.location.pathname).toBe('/a');
    expect(page.documentStub).toMatchObject({ title: 'A' });
  });

  it('does not push an older URL after a back/forward visit', async () => {
    const page = setup();
    const a = gate();
    const b = gate();
    page.updateGates.set('/a', a.promise);
    page.fetchGates.set('/b', b.promise);
    const r = await router(page);

    const visitA = r.visit('/a');
    await entered(page, '/a');
    // The browser has already moved to /b when popstate fires, before /b loads.
    window.location.pathname = '/b';
    const visitB = r.visit('/b', { _popstate: true, _scrollPosition: null });
    a.release();
    await expect(visitA).resolves.toBeUndefined();
    b.release();
    await visitB;

    expect(history.pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/b');
  });

  it('keeps page and URL together after Back to a same-page hash entry during an update', async () => {
    const page = setup();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);
    await r.visit('#s');

    const visitA = r.visit('/a');
    await entered(page, '/a');
    // Back from /#s to /: a same-page entry, so nothing new renders.
    window.location.hash = '';
    await r.visit('/', { _popstate: true, _scrollPosition: null });
    a.release();

    await expect(visitA).resolves.toMatchObject({ url: '/a' });
    expect(window.location.pathname).toBe('/a');
    expect(page.documentStub).toMatchObject({ title: 'A' });
  });

  it('rejects a superseded form submission with an AbortError', async () => {
    const page = setup();
    const a = gate();
    page.updateGates.set('/a', a.promise);
    const r = await router(page);

    const submitA = r.visit('/a', { method: 'post', data: { name: 'x' } });
    await entered(page, '/a');
    await r.visit('/b');
    a.release();

    await expect(submitA).rejects.toMatchObject({ name: 'AbortError' });
    expect(window.location.pathname).toBe('/b');
  });

  it('does not apply an older view transition after a newer visit rendered', async () => {
    const page = setup();
    const callbacks: Array<() => unknown> = [];
    Object.assign(document, {
      startViewTransition(callback: () => unknown) {
        const updateCallbackDone = new Promise<void>((resolve) => {
          callbacks.push(async () => {
            await callback();
            resolve();
          });
        });
        return { updateCallbackDone };
      },
    });
    const r = await router(page);

    const visitA = r.visit('/a', { viewTransition: true });
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    await r.visit('/b', { viewTransition: false });
    await callbacks[0]();

    await expect(visitA).resolves.toBeUndefined();
    expect(page.rendered).toEqual(['/b']);
    expect(window.location.pathname).toBe('/b');
  });

  it('skips an older engine commit after a newer one, as the React adapter calls it', async () => {
    const page = setup();
    const engine = await createPageNavigationEngine({
      adapter: {
        createDeferred: () => ({ loading: true }),
        isLoading: () => true,
        resolveDeferred: (_ref, value) => value,
        rejectDeferred: page.rejectDeferred,
      },
      components: { a: loadComponent, b: loadComponent, home: loadComponent },
      layoutTree: {},
      routeMeta: {},
      matchRoute: (url) => (url.startsWith('/a') ? 'a' : 'b'),
      viewTransitions: false,
      prefetchHoverDelay: 75,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
    });

    const a = engine.prepareVisit('/a');
    await a.shell;
    const b = engine.prepareVisit('/b');
    await b.shell;
    await b.commit();
    await a.commit();

    expect(vi.mocked(history.pushState).mock.calls.map((call) => call[2])).toEqual(['/b']);
    expect(page.documentStub).toMatchObject({ title: 'B' });
    expect(page.rejectDeferred).not.toHaveBeenCalled();
  });
});
