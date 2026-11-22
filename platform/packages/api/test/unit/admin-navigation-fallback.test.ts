import { NavigationContext } from '@void/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import type { PageObject } from 'void/pages-protocol';
import { AdminNavigationFallback } from '../../src/admin/react/AdminNavigationFallback.tsx';

it('renders the destination skeleton outside the Void page context', () => {
  const initialPageData: PageObject = {
    component: 'dashboard',
    props: { platformName: 'e2e Void', username: 'admin' },
    params: {},
    query: {},
    shared: {},
    url: '/admin/',
    errors: null,
  };
  const markup = renderToStaticMarkup(
    createElement(
      NavigationContext.Provider,
      {
        value: {
          state: 'loading',
          location: new URL('https://void.example/admin/users'),
          method: 'GET',
        },
      },
      createElement(AdminNavigationFallback, { initialPageData }),
    ),
  );

  expect(markup).toContain('Users');
  expect(markup).toContain('Loading users');
  expect(markup).toContain('void-admin-loading-lines');
});

it('renders the Zero Trust skeleton for client navigation', () => {
  const markup = renderToStaticMarkup(
    createElement(
      NavigationContext.Provider,
      {
        value: {
          state: 'loading',
          location: new URL('https://void.example/admin/zero-trust'),
          method: 'GET',
        },
      },
      createElement(AdminNavigationFallback, {
        initialPageData: {
          component: 'dashboard',
          props: { platformName: 'e2e Void', username: 'admin' },
          params: {},
          query: {},
          shared: {},
          url: '/admin/',
          errors: null,
        },
      }),
    ),
  );

  expect(markup).toContain('Loading zero trust');
  expect(markup).toContain('href="/admin/zero-trust"');
});
