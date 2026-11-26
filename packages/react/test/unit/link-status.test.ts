// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vite-plus/test';
import { createSsrRouter } from 'void/pages-client';
import type { LinkStatus, NavigationState } from 'void/pages-client';
import { NavigationContext, RouterContext } from '../../src/runtime/context.ts';
import { Link, useLinkStatus } from '../../src/runtime/link.tsx';
import type { LinkProps } from '../../src/runtime/link.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps the status object until current, active or pending changes', () => {
  const router = createSsrRouter('/posts');
  const hookStatuses: Array<LinkStatus> = [];
  const linkStatuses: Array<LinkStatus> = [];
  function Item() {
    hookStatuses.push(useLinkStatus('/about', { data: { page: 1 } }));
    const props: LinkProps = {
      href: '/about',
      data: { page: 1 },
      children: (status) => {
        linkStatuses.push(status);
        return 'About';
      },
    };
    return createElement(Link, props);
  }
  const visiting = (path: string): NavigationState => ({
    state: 'loading',
    location: new URL(path, router.url),
    method: 'GET',
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (navigation: NavigationState) =>
    act(() => {
      root.render(
        createElement(
          RouterContext.Provider,
          { value: router },
          createElement(NavigationContext.Provider, { value: navigation }, createElement(Item)),
        ),
      );
    });
  try {
    render(visiting('/posts/1'));
    render(visiting('/posts/2'));
    render(visiting('/about?page=1'));

    for (const statuses of [hookStatuses, linkStatuses]) {
      expect(statuses).toHaveLength(3);
      expect(statuses[1]).toBe(statuses[0]);
      expect(statuses[2]).toEqual({ current: false, active: false, pending: true });
    }
  } finally {
    act(() => root.unmount());
  }
});
