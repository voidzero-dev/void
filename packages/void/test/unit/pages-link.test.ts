import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { VoidRouter } from '../../src/pages/client.ts';
import {
  handleLinkClick,
  linkPrefetchStrategies,
  observeLinkVisible,
  prefetchLink,
  resolveLink,
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
  it.each([
    [undefined, []],
    [false, []],
    [true, ['hover']],
    ['visible', ['visible']],
    [['mount', 'click'] as const, ['mount', 'click']],
  ] as const)('maps prefetch=%j to %j', (prefetch, expected) => {
    expect(linkPrefetchStrategies({ prefetch })).toEqual(expected);
  });

  it('disables prefetch for document reloads', () => {
    expect(linkPrefetchStrategies({ prefetch: 'mount', reloadDocument: true })).toEqual([]);
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
  it('calls back once when the element becomes visible', () => {
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

    notify([{ isIntersecting: false }]);
    expect(onVisible).not.toHaveBeenCalled();
    notify([{ isIntersecting: true }]);

    expect(observe).toHaveBeenCalledWith(element);
    expect(onVisible).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    stop();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
