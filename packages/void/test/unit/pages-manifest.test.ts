import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { resolveLayoutIds } from '../../src/pages/layout-resolution.ts';
import { generateComponentManifest } from '../../src/pages/manifest.ts';
import type {
  LayoutDefinition,
  NamedLayoutDefinition,
  PageDefinition,
  PageScanResult,
} from '../../src/pages/types.ts';
import { decodePagePath } from '../../src/pages/url.ts';

/** Look a URL up the way the navigation engine does. */
function byUrl(matchRoute: (path: string) => string | null): (url: string) => string | null {
  return (url) => matchRoute(decodePagePath(new URL(url, 'http://x').pathname));
}

function matchRouteFor(pattern: string): (url: string) => string | null {
  const page: PageDefinition = {
    pattern,
    params: ['slug'],
    catchAll: true,
    componentPath: 'docs/[...slug].tsx',
    serverPath: null,
    methods: [],
    componentId: 'docs/[...slug]',
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
  };
  const source = generateComponentManifest(
    { pages: [page], layouts: [], namedLayouts: [] },
    '/project/pages',
  );
  return byUrl(new Function(`${source}\nreturn matchRoute;`)() as (path: string) => string | null);
}

describe('generated Pages client route manifest', () => {
  it('matches named catch-all pages across path segments', () => {
    const matchRoute = matchRouteFor('/docs/:slug{.+}');

    expect(matchRoute('/docs/a/b')).toBe('docs/[...slug]');
    expect(matchRoute('/docs/a')).toBe('docs/[...slug]');
    expect(matchRoute('/docs')).toBeNull();
  });
});

type GeneratedManifest = {
  components: Record<string, () => Promise<unknown>>;
  layoutTree: Record<string, Array<string>>;
  routeMeta: Record<string, { island?: boolean }>;
  matchRoute(url: string): string | null;
};

function evaluateManifest(scan: PageScanResult): GeneratedManifest {
  const source = generateComponentManifest(scan, '/project/pages');
  const manifest = new Function(
    `${source}\nreturn { components, layoutTree, routeMeta, matchRoute };`,
  )() as GeneratedManifest;
  return { ...manifest, matchRoute: byUrl(manifest.matchRoute) };
}

function definePage(
  componentId: string,
  pattern: string,
  componentPath: string,
  extra: Partial<PageDefinition> = {},
): PageDefinition {
  return {
    pattern,
    params: [],
    catchAll: false,
    componentPath,
    serverPath: null,
    methods: [],
    componentId,
    ssrMode: 'auto',
    prerenderMode: 'auto',
    renderMode: 'server',
    shouldPrerender: false,
    ...extra,
  };
}

/**
 * The ordered RegExp scan alone: a dynamic route placed first leaves no static
 * prefix, so every page is tested by its RegExp in route order.
 */
function regexOnlyMatchRoute(scan: PageScanResult): (url: string) => string | null {
  const first = definePage('__first', '/__first/:never', '__first.tsx', { params: ['never'] });
  return evaluateManifest({ ...scan, pages: [first, ...scan.pages] }).matchRoute;
}

const layouts: Array<LayoutDefinition> = [
  { directory: '', filePath: 'layout.tsx' },
  { directory: 'blog', filePath: 'blog/layout.tsx' },
];
const namedLayouts: Array<NamedLayoutDefinition> = [
  { name: 'marketing', directory: '', filePath: '_layouts/marketing.tsx' },
];
// Route order as the scanner sorts it, plus a static route after a dynamic one.
const pages = [
  definePage('index', '/', 'index.tsx'),
  definePage('about', '/about', 'about.tsx'),
  definePage('about/index', '/about', 'about/index.tsx'),
  definePage('blog', '/blog', 'blog/index.tsx'),
  definePage('(marketing)/pricing', '/pricing', '(marketing)/pricing.tsx', {
    layout: 'marketing',
  }),
  definePage('files/a*b', '/files/a*b', 'files/a*b.tsx', { layout: false }),
  definePage('blog/[slug]', '/blog/:slug', 'blog/[slug].tsx', { params: ['slug'] }),
  definePage('blog/featured', '/blog/featured', 'blog/featured.tsx'),
  definePage('legacy/[...rest]', '/legacy/*', 'legacy/[...rest].tsx', { catchAll: true }),
  definePage('docs/[...slug]', '/docs/:slug{.+}', 'docs/[...slug].tsx', {
    params: ['slug'],
    catchAll: true,
    island: true,
  }),
];

describe('compact Pages route manifest', () => {
  it('matches the same route as testing each page pattern in order', () => {
    const { matchRoute } = evaluateManifest({ pages, layouts, namedLayouts });
    const regexOnly = regexOnlyMatchRoute({ pages, layouts, namedLayouts });
    const urls = [
      '/',
      '/about',
      '/about/',
      '/blog',
      '/blog/post',
      '/blog/featured',
      '/pricing',
      '/(marketing)/pricing',
      '/files/a*b',
      '/files/axb',
      '/legacy/',
      '/legacy/a/b',
      '/docs',
      '/docs/a/b',
      '/caf%C3%A9',
      '/about?tab=1#top',
      'https://example.com/blog',
      '/missing',
    ];
    for (const url of urls) {
      expect([url, matchRoute(url)]).toEqual([url, regexOnly(url)]);
    }
  });

  it('keeps every component, layout chain and island flag', () => {
    const manifest = evaluateManifest({ pages, layouts, namedLayouts });

    expect(Object.keys(manifest.components).sort()).toEqual(
      [
        ...pages.map((page) => page.componentId),
        'layout',
        'blog/layout',
        '_layouts/marketing',
      ].sort(),
    );
    for (const page of pages) {
      const chain = resolveLayoutIds(page, layouts, namedLayouts);
      expect([page.componentId, manifest.layoutTree[page.componentId]]).toEqual([
        page.componentId,
        chain.length > 0 ? chain : undefined,
      ]);
    }
    expect(manifest.routeMeta).toEqual({ 'docs/[...slug]': { island: true } });
  });

  it('emits no RegExp for static routes', () => {
    const source = generateComponentManifest(
      {
        pages: [definePage('index', '/', 'index.tsx'), definePage('about', '/about', 'about.tsx')],
        layouts,
        namedLayouts: [],
      },
      '/project/pages',
    );
    expect(source).not.toContain('/^');
  });

  it('keeps a page in a "layout" folder apart from the layout beside it', () => {
    const manifest = evaluateManifest({
      pages: [
        definePage('layout', '/layout', 'layout/index.tsx'),
        definePage('blog/layout', '/blog/layout', 'blog/layout/index.island.tsx', {
          island: true,
        }),
      ],
      layouts,
      namedLayouts: [],
    });

    expect(String(manifest.components.layout)).toContain('"/project/pages/layout/index.tsx"');
    expect(String(manifest.components._layout)).toContain('"/project/pages/layout.tsx"');
    expect(String(manifest.components['blog/layout'])).toContain(
      '"/project/pages/blog/layout/index.island.tsx"',
    );
    expect(String(manifest.components['blog/_layout'])).toContain(
      '"/project/pages/blog/layout.tsx"',
    );
    expect(manifest.layoutTree).toEqual({
      layout: ['_layout'],
      'blog/layout': ['_layout', 'blog/_layout'],
    });
    expect(manifest.routeMeta).toEqual({ 'blog/layout': { island: true } });
    expect(manifest.matchRoute('/layout')).toBe('layout');
  });

  it('matches page file names that need URL encoding the same way as the server', async () => {
    const staticPages = [
      definePage('café', '/café', 'café.tsx'),
      definePage('a b', '/a b', 'a b.tsx'),
      definePage('100%', '/100%', '100%.tsx'),
      definePage('50%25', '/50%25', '50%25.tsx'),
      definePage('a+b', '/a+b', 'a+b.tsx'),
      definePage('x/y', '/x/y', 'x/y.tsx'),
    ];
    const dynamicPages = [
      definePage('blog/[slug]', '/blog/:slug', 'blog/[slug].tsx', { params: ['slug'] }),
      definePage('café/[id]', '/café/:id', 'café/[id].tsx', { params: ['id'] }),
      definePage('files/[...rest]', '/files/:rest{.+}', 'files/[...rest].tsx', {
        params: ['rest'],
        catchAll: true,
      }),
    ];
    const rootSlug = definePage('[slug]', '/:slug', '[slug].tsx', { params: ['slug'] });
    const urls = [
      '/caf%C3%A9',
      '/caf%c3%a9',
      '/café',
      '/a%20b',
      '/100%',
      '/100%25',
      '/50%25',
      '/50%2525',
      '/a+b',
      '/a%2Bb',
      '/x%2Fy',
      '/x/y',
      '/caf%C3%A9/1',
      '/blog/a%2Fb',
      '/blog/%zz',
      '/caf%C3',
      '/files/a%0Ab',
      '/abo%75t',
      '/caf%C3%A9?q=%C3%A9#top',
    ];
    for (const pages of [
      [...staticPages, ...dynamicPages],
      [...staticPages, rootSlug, ...dynamicPages],
    ]) {
      const { matchRoute } = evaluateManifest({ pages, layouts: [], namedLayouts: [] });
      const server = new Hono();
      for (const page of pages) {
        server.get(page.pattern, (c) => c.text(page.componentId));
      }
      for (const url of urls) {
        const response = await server.request(url);
        const expected = response.status === 200 ? await response.text() : null;
        expect([url, matchRoute(url)]).toEqual([url, expected]);
      }
    }
  });
});
