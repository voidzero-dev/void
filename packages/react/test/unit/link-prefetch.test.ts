// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { LinkPrefetchValue, VoidRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { Link, type LinkProps } from '../../src/runtime/link.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function createRouter(defaultStrategy?: LinkPrefetchValue) {
  const prefetch = vi.fn(() => Promise.resolve());
  const router: VoidRouter = {
    _hoverDelay: 75,
    _prefetchDefaultStrategy: defaultStrategy,
    get url() {
      return new URL(window.location.href);
    },
    get path() {
      return window.location.pathname;
    },
    get query() {
      return new URLSearchParams(window.location.search);
    },
    get params() {
      return {};
    },
    visit: vi.fn(),
    refresh: vi.fn(),
    prefetch,
    flush: vi.fn(),
    flushAll: vi.fn(),
  };
  return { router, prefetch };
}

async function mountLink(router: VoidRouter, props: LinkProps) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(RouterContext.Provider, { value: router }, createElement(Link, props, 'Go')),
    );
  });
  return container.firstElementChild as HTMLElement;
}

describe('Link default prefetch strategy', () => {
  it('prefetches a Link without a prefetch prop with the app default', async () => {
    const { router, prefetch } = createRouter('mount');
    await mountLink(router, { href: '/users' });

    expect(prefetch).toHaveBeenCalledWith('/users', {});
  });

  it('lets the Link prop replace the default', async () => {
    const { router, prefetch } = createRouter('mount');
    const link = await mountLink(router, { href: '/users', prefetch: 'hover' });
    expect(prefetch).not.toHaveBeenCalled();

    await act(async () => {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(prefetch).toHaveBeenCalledWith('/users', {});
  });

  it('turns the default off with prefetch={false}', async () => {
    const { router, prefetch } = createRouter('mount');
    await mountLink(router, { href: '/users', prefetch: false });

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('skips non-GET links without throwing', async () => {
    const { router, prefetch } = createRouter('mount');
    const button = await mountLink(router, { href: '/users', method: 'POST' });

    expect(button.tagName).toBe('BUTTON');
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('skips links to other sites', async () => {
    const { router, prefetch } = createRouter('mount');
    await mountLink(router, { href: 'https://example.com/users' });

    expect(prefetch).not.toHaveBeenCalled();
  });

  it('does not prefetch without an app default', async () => {
    const { router, prefetch } = createRouter();
    await mountLink(router, { href: '/users' });

    expect(prefetch).not.toHaveBeenCalled();
  });
});
