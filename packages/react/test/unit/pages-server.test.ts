import { createElement, Suspense, use } from 'react';
import { expect, it } from 'vite-plus/test';
import { DEFERRED_SHELL_DIGEST } from '../../src/runtime/deferred-shell.ts';
import { renderReactPage } from '../../src/runtime/pages-server.ts';
import { usePageQuery } from '../../src/runtime/use-page-query.ts';

it('rejects with the error a page throws while rendering', async () => {
  const boom = new TypeError('page render failed');
  function Page(): never {
    throw boom;
  }

  await expect(
    renderReactPage({
      pageObj: {
        component: 'page',
        props: {},
        url: '/',
        params: {},
        query: {},
        shared: {},
        errors: null,
      },
      assetTags: { css: '', preloads: '', body: '' },
      components: { page: async () => ({ default: Page }) },
      layoutTree: {},
    }),
  ).rejects.toBe(boom);
});

it('finishes deferred fallbacks without waiting for the separate deferred transport', async () => {
  function Usage({ usage }: { usage: Promise<unknown> }) {
    return createElement('p', null, String(use(usage)));
  }
  function Page({ usage }: { usage: Promise<unknown> }) {
    return createElement(
      Suspense,
      { fallback: createElement('p', null, 'Loading usage') },
      createElement(Usage, { usage }),
    );
  }
  const stream = await renderReactPage({
    pageObj: {
      component: 'page',
      props: {},
      url: '/',
      params: {},
      query: {},
      shared: {},
      errors: null,
      deferredKeys: { usage: 'usage' },
    },
    assetTags: { css: '', preloads: '', body: '' },
    components: { page: async () => ({ default: Page }) },
    layoutTree: {},
  });
  const html = await new Response(stream).text();
  expect(html).toContain('Loading usage');
  expect(html).toContain(DEFERRED_SHELL_DIGEST);
  expect(html).toContain('</html>');
});

it('renders the validated page query on the server', async () => {
  function Page(): ReturnType<typeof createElement> {
    const query = usePageQuery<{ page: number; status: string }>();
    return createElement('p', null, `${query.status}:${query.page}`);
  }
  const stream = await renderReactPage({
    pageObj: {
      component: 'page',
      props: {},
      url: '/payments?status=paid',
      params: {},
      query: { status: 'paid', page: 2 },
      shared: {},
      errors: null,
    },
    assetTags: { css: '', preloads: '', body: '' },
    components: { page: async () => ({ default: Page }) },
    layoutTree: {},
  });
  const html = await new Response(stream).text();
  // A page reading `page.page` as a number would throw here if the query were dropped.
  expect(html).toContain('paid:2');
});
