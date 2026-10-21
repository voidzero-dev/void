import { describe, expect, it } from 'vite-plus/test';
import { resolveLayoutIds } from '../../src/pages/layout-resolution.ts';
import { generateComponentManifest } from '../../src/pages/manifest.ts';
import type {
  LayoutDefinition,
  NamedLayoutDefinition,
  PageDefinition,
  PageScanResult,
} from '../../src/pages/types.ts';

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
  return new Function('URL', `${source}\nreturn matchRoute;`)(URL) as (
    url: string,
  ) => string | null;
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
  return new Function(
    'URL',
    `${source}\nreturn { components, layoutTree, routeMeta, matchRoute };`,
  )(URL) as GeneratedManifest;
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

/** The previous matcher: test each page's RegExp in route order. */
function linearMatchRoute(pages: Array<PageDefinition>, url: string): string | null {
  const path = new URL(url, 'http://x').pathname;
  for (const page of pages) {
    const source = page.pattern
      .split('/')
      .map((segment) => {
        if (segment === '*') {
          return '(.*)';
        }
        if (/^:[^/{}]+\{\.\+\}$/.test(segment)) {
          return '(.+)';
        }
        if (/^:[^/]+$/.test(segment)) {
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    if (new RegExp(`^${source}$`).test(path)) {
      return page.componentId;
    }
  }
  return null;
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
      expect([url, matchRoute(url)]).toEqual([url, linearMatchRoute(pages, url)]);
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
    expect(source).not.toMatch(/\/\^/);
  });
});
