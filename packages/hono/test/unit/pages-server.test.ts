import { jsx, useContext } from 'hono/jsx';
import type { Child } from 'hono/jsx';
import { describe, expect, it } from 'vite-plus/test';
import type { PageObject } from 'void/pages-protocol';
import { FrontmatterContext } from '../../src/runtime/context.ts';
import { renderHonoIslandPage, renderHonoPage } from '../../src/runtime/pages-server.ts';
import { useParams } from '../../src/runtime/use-params.ts';
import { useRouter } from '../../src/runtime/use-router.ts';
import { useShared } from '../../src/runtime/use-shared.ts';

const assetTags = {
  css: '<link rel="stylesheet" href="/app.css">',
  preloads: '<link rel="modulepreload" href="/app.js">',
  body: '<script type="module" src="/app.js"></script>',
};

function pageObject(overrides: Partial<PageObject> = {}): PageObject {
  return {
    component: 'page',
    props: {},
    url: '/',
    params: {},
    shared: {},
    errors: null,
    ...overrides,
  };
}

function Layout(props: { children?: Child }) {
  return jsx('main', {}, props.children);
}

describe('renderHonoPage', () => {
  it('renders the page inside its layouts with the page data', async () => {
    function Page(props: { title: string }) {
      const router = useRouter();
      const shared = useShared<{ appName: string }>();
      return jsx('h1', {}, `${props.title} ${useParams().id} ${shared.appName} ${router.path}`);
    }

    const html = await renderHonoPage({
      pageObj: pageObject({
        props: { title: 'User' },
        url: '/users/7',
        params: { id: '7' },
        shared: { appName: 'Demo' },
      }),
      assetTags,
      components: {
        page: async () => ({ default: Page }),
        layout: async () => ({ default: Layout }),
      },
      layoutTree: { page: ['layout'] },
    });

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<div id="app"><main><h1>User 7 Demo /users/7</h1></main></div>');
    expect(html).toContain('<script id="__VOID_PAGE_DATA__" type="application/json">');
    expect(html).toContain(assetTags.css + assetTags.preloads);
    expect(html).toContain(assetTags.body);
  });

  it('waits for async components', async () => {
    async function Page() {
      await Promise.resolve();
      return jsx('p', {}, 'loaded');
    }

    const html = await renderHonoPage({
      pageObj: pageObject(),
      assetTags,
      components: { page: async () => ({ default: Page }) },
      layoutTree: {},
    });

    expect(html).toContain('<div id="app"><p>loaded</p></div>');
  });

  it('rejects with the error a page throws while rendering', async () => {
    const boom = new TypeError('page render failed');
    function Page(): never {
      throw boom;
    }

    await expect(
      renderHonoPage({
        pageObj: pageObject(),
        assetTags,
        components: { page: async () => ({ default: Page }) },
        layoutTree: {},
      }),
    ).rejects.toBe(boom);
  });
});

describe('renderHonoIslandPage', () => {
  function FrontmatterLayout(props: { children?: Child }) {
    const frontmatter = useContext(FrontmatterContext) as { title?: string };
    return jsx('main', { 'data-title': frontmatter.title }, props.children);
  }

  function StaticPage() {
    return jsx('p', {}, 'static');
  }

  function IslandPage() {
    return jsx('div', { 'data-island': 'pages/Counter' }, 'island');
  }

  it('ships no JavaScript for a built page without islands', async () => {
    const html = await renderHonoIslandPage({
      pageObj: pageObject(),
      assetTags,
      components: { page: async () => ({ default: StaticPage }) },
      layoutTree: {},
      mdClientScriptIds: new Set(),
      pagesNeedingClientJS: new Set(),
      isDev: false,
    });

    expect(html).toContain('<div id="app"><p>static</p></div>');
    expect(html).toContain(assetTags.css);
    expect(html).not.toContain(assetTags.preloads);
    expect(html).not.toContain(assetTags.body);
    expect(html).not.toContain('__VOID_PAGE_DATA__');
  });

  it('loads the dev client on a page without islands', async () => {
    const html = await renderHonoIslandPage({
      pageObj: pageObject(),
      assetTags,
      components: { page: async () => ({ default: StaticPage }) },
      layoutTree: {},
      mdClientScriptIds: new Set(),
      pagesNeedingClientJS: new Set(),
      isDev: true,
    });

    expect(html).toContain(assetTags.body);
  });

  it('provides frontmatter to layouts and sends it to the islands', async () => {
    const html = await renderHonoIslandPage({
      pageObj: pageObject(),
      assetTags,
      components: {
        page: async () => ({ default: IslandPage, frontmatter: { title: 'Guide' } }),
        layout: async () => ({ default: FrontmatterLayout }),
      },
      layoutTree: { page: ['layout'] },
      mdClientScriptIds: new Set(['page']),
      pagesNeedingClientJS: new Set(['page']),
      isDev: false,
    });

    expect(html).toContain('<div id="app" data-md-script="page">');
    expect(html).toContain('<main data-title="Guide">');
    expect(html).toContain('"title":"Guide"');
    expect(html).toContain(assetTags.preloads);
    expect(html).toContain(assetTags.body);
  });
});
