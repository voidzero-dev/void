import { MAX_ISR_VARIANTS_PER_PATH } from '@void/isr/runtime';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import {
  SHARED_CACHE_POLICY_VERSION,
  isrCacheKey,
  isStale,
  resolveRevalidateTtl,
  resolvePathTtl,
  resolvePageTtl,
  matchesLiteralPage,
  isBroadCatchAll,
  isDottedPathIsrEligible,
  shouldBypassIsr,
  isrCacheResponse,
  isrEdgeCacheKey,
  isrEdgeCacheKeyJson,
  serializeHeaders,
  packIsrValue,
  unpackIsrValue,
  extractPageDataFromHtml,
  normalizePageDataForJsonCache,
  writeIsrCache,
  type IsrCacheEntry,
} from '../../src/isr.ts';

describe('isrCacheKey', () => {
  it('maps root path to __index__', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'my-app.void.app', '/')).toBe(
      'proj_1/isr/v3/dpl_1/my-app.void.app/__index__',
    );
  });

  it('strips leading slash', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'my-app.void.app', '/about')).toBe(
      'proj_1/isr/v3/dpl_1/my-app.void.app/about',
    );
  });

  it('strips trailing slash', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'my-app.void.app', '/about/')).toBe(
      'proj_1/isr/v3/dpl_1/my-app.void.app/about',
    );
  });

  it('handles nested paths', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'my-app.void.app', '/blog/hello-world')).toBe(
      'proj_1/isr/v3/dpl_1/my-app.void.app/blog/hello-world',
    );
  });

  it('handles path without leading slash', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'my-app.void.app', 'about')).toBe(
      'proj_1/isr/v3/dpl_1/my-app.void.app/about',
    );
  });

  // Host-scoping: the same path under two hostnames never shares a cache slot.
  it('scopes the key to the host segment', () => {
    const a = isrCacheKey('proj_1', 'dpl_1', 'a.example.com', '/about');
    const b = isrCacheKey('proj_1', 'dpl_1', 'b.example.com', '/about');
    expect(a).toBe('proj_1/isr/v3/dpl_1/a.example.com/about');
    expect(b).toBe('proj_1/isr/v3/dpl_1/b.example.com/about');
    expect(a).not.toBe(b);
  });

  // User code can branch on `c.isRewritten()` / `c.originalUrl()`; a direct
  // hit to /en/docs and a rewrite from /docs → /en/docs must not share a slot.
  it('appends a rewrite-variant token when originalUrl is provided', () => {
    const direct = isrCacheKey('proj_1', 'dpl_1', 'host.void.app', '/en/docs');
    const rewritten = isrCacheKey(
      'proj_1',
      'dpl_1',
      'host.void.app',
      '/en/docs',
      'https://host/docs',
    );
    expect(direct).toBe('proj_1/isr/v3/dpl_1/host.void.app/en/docs');
    expect(rewritten).not.toBe(direct);
    expect(rewritten.startsWith('proj_1/isr/v3/dpl_1/host.void.app/en/docs#rw=')).toBe(true);
  });

  it('produces distinct keys for different originalUrl values', () => {
    const a = isrCacheKey('proj_1', 'dpl_1', 'host.void.app', '/en/docs', 'https://host/docs');
    const b = isrCacheKey('proj_1', 'dpl_1', 'host.void.app', '/en/docs', 'https://host/other');
    expect(a).not.toBe(b);
  });

  it('treats null originalUrl as a direct hit (backward-compatible key)', () => {
    expect(isrCacheKey('proj_1', 'dpl_1', 'host.void.app', '/x', null)).toBe(
      'proj_1/isr/v3/dpl_1/host.void.app/x',
    );
    expect(isrCacheKey('proj_1', 'dpl_1', 'host.void.app', '/x', undefined)).toBe(
      'proj_1/isr/v3/dpl_1/host.void.app/x',
    );
  });
});

describe('ISR edge cache URL variants', () => {
  // The edge cache URL and the KV key must include the same rewrite-variant
  // token so both layers see the same direct-vs-rewritten split.
  it('appends __void_orig when originalUrl is provided', () => {
    const direct = isrEdgeCacheKey(
      new Request('https://app.void.app/en/docs'),
      '/en/docs',
      'dpl_1',
    );
    const rewritten = isrEdgeCacheKey(
      new Request('https://app.void.app/docs'),
      '/en/docs',
      'dpl_1',
      'https://app.void.app/docs',
    );
    expect(direct.url).toBe('https://app.void.app/en/docs?__void_isr=dpl_1');
    expect(
      rewritten.url.startsWith('https://app.void.app/en/docs?__void_isr=dpl_1&__void_orig='),
    ).toBe(true);
  });

  it('appends __void_orig on the JSON variant too', () => {
    const rewritten = isrEdgeCacheKeyJson(
      new Request('https://app.void.app/docs'),
      '/en/docs',
      'dpl_1',
      'https://app.void.app/docs',
    );
    expect(rewritten.url.includes('__void=json')).toBe(true);
    expect(rewritten.url.includes('__void_isr=dpl_1')).toBe(true);
    expect(rewritten.url.includes('__void_orig=')).toBe(true);
  });
});

describe('isStale', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when entry is fresh', () => {
    vi.setSystemTime(1000000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(false);
  });

  it('returns true when entry is expired', () => {
    vi.setSystemTime(1000000 + 61 * 1000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(true);
  });

  it('returns false at exact TTL boundary', () => {
    vi.setSystemTime(1000000 + 60 * 1000);
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: 1000000,
      ttl: 60,
    };
    expect(isStale(entry)).toBe(false);
  });
});

describe('resolveRevalidateTtl', () => {
  it('returns default when no header present', () => {
    const response = new Response('ok');
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });

  it('returns header value when present', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': '120' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(120);
  });

  it('returns 0 for opt-out header', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': '0' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(0);
  });

  it('returns default for invalid header value', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': 'abc' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });

  it('returns default for negative header value', () => {
    const response = new Response('ok', {
      headers: { 'x-revalidate': '-5' },
    });
    expect(resolveRevalidateTtl(response, 60)).toBe(60);
  });
});

describe('resolvePathTtl', () => {
  it('returns 0 for undefined', () => {
    expect(resolvePathTtl(undefined, '/')).toBe(0);
  });

  it('returns the number for numeric revalidate', () => {
    expect(resolvePathTtl(60, '/anything')).toBe(60);
  });

  it('matches exact path in object', () => {
    expect(resolvePathTtl({ '/': 60, '*': 30 }, '/')).toBe(60);
  });

  it('matches glob pattern', () => {
    expect(resolvePathTtl({ '/docs/*': 120, '*': 30 }, '/docs/intro')).toBe(120);
  });

  it('returns 0 when no pattern matches', () => {
    expect(resolvePathTtl({ '/docs/*': 120 }, '/about')).toBe(0);
  });

  it('uses first-match-wins ordering', () => {
    expect(resolvePathTtl({ '/docs/*': 120, '*': 30 }, '/docs/intro')).toBe(120);
    expect(resolvePathTtl({ '*': 30, '/docs/*': 120 }, '/docs/intro')).toBe(30);
  });

  it('supports zero TTL for specific paths', () => {
    expect(resolvePathTtl({ '/user/*': 0, '*': 60 }, '/user/profile')).toBe(0);
  });

  // Segment-aware manifest keys: `:slug` anchors to ONE segment,
  // `*` still crosses `/`. Mirrors the matcher tests in pattern.test.ts.
  it('anchors a `:slug` manifest key to a single path segment', () => {
    expect(resolvePathTtl({ '/blog/:slug': 90 }, '/blog/hello')).toBe(90);
    expect(resolvePathTtl({ '/blog/:slug': 90 }, '/blog/a/b')).toBe(0);
    expect(resolvePathTtl({ '/blog/:slug': 90, '/blog/*': 30 }, '/blog/a/b')).toBe(30);
  });
});

describe('resolvePageTtl', () => {
  // Emitted in framework scan order: static → dynamic → catch-all last.
  const pages = [
    { pattern: '/docs/setup/install' }, // specific, no TTL (opts out of ISR)
    { pattern: '/blog/:slug', revalidate: 120 }, // single-segment dynamic
    { pattern: '/docs/:path{.+}', revalidate: 3600 }, // named catch-all (crosses '/')
  ];

  it('a specific page without a TTL wins over a catch-all and opts OUT (0)', () => {
    expect(resolvePageTtl(pages, undefined, undefined, '/docs/setup/install')).toBe(0);
  });
  it("a catch-all's own nested path gets the catch-all TTL", () => {
    expect(resolvePageTtl(pages, undefined, undefined, '/docs/a/b')).toBe(3600);
  });
  it('a single-segment dynamic page gets its own TTL, anchored to one segment', () => {
    expect(resolvePageTtl(pages, undefined, undefined, '/blog/hello')).toBe(120);
    // /blog/a/b does not match :slug; it also matches no other page → flat-map fallback (none) → 0
    expect(resolvePageTtl(pages, undefined, undefined, '/blog/a/b')).toBe(0);
  });

  it('when pages is undefined it is exactly the flat-map behavior', () => {
    expect(resolvePageTtl(undefined, { '/docs/*': 300 }, undefined, '/docs/a')).toBe(300);
    expect(resolvePageTtl(undefined, undefined, undefined, '/docs/a')).toBe(0);
  });

  // An EXPLICIT `revalidate: 0` opt-out is authoritative and never consults pathRevalidate.
  it('an explicit revalidate: 0 opt-out wins over any pathRevalidate rule', () => {
    expect(
      resolvePageTtl(
        [{ pattern: '/secret', revalidate: 0 }],
        undefined,
        { '/secret': 3600 },
        '/secret',
      ),
    ).toBe(0);
  });
  // A baked positive TTL is authoritative and never consults pathRevalidate.
  it('a baked positive TTL wins over pathRevalidate', () => {
    expect(
      resolvePageTtl([{ pattern: '/p', revalidate: 120 }], undefined, { '/p': 3600 }, '/p'),
    ).toBe(120);
  });
  // Inherit-eligible page with NO pathRevalidate → resolvePathTtl(undefined) → 0.
  it('an inherit-eligible page with NO pathRevalidate resolves 0', () => {
    expect(resolvePageTtl([{ pattern: '/x' }], undefined, undefined, '/x')).toBe(0);
  });
});

describe('isBroadCatchAll', () => {
  it('a named catch-all `:name{.+}` is broad (crosses segment boundaries)', () => {
    expect(isBroadCatchAll('/:path{.+}')).toBe(true);
    expect(isBroadCatchAll('/docs/:path{.+}')).toBe(true);
  });
  it('a `*` wildcard is broad', () => {
    expect(isBroadCatchAll('*')).toBe(true);
    expect(isBroadCatchAll('/docs/*')).toBe(true);
  });
  it('a single-segment param is NOT broad', () => {
    expect(isBroadCatchAll('/blog/:slug')).toBe(false);
  });
  it('a literal is NOT broad', () => {
    expect(isBroadCatchAll('/feed.xml')).toBe(false);
    expect(isBroadCatchAll('/about')).toBe(false);
  });
});

describe('isDottedPathIsrEligible', () => {
  it('a dotted dynamic param VALUE under a single-segment page IS eligible', () => {
    // `/blog/:slug` compiles to `^/blog/[^/]+$` and matches `/blog/release.v2` — the
    // framework serves it as that page, so it gets ISR even though it has a dot.
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/blog/:slug', revalidate: 60 }],
        undefined,
        undefined,
        '/blog/release.v2',
      ),
    ).toBe(true);
  });
  it('a literal extension page with a positive TTL IS eligible', () => {
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/feed.xml', revalidate: 60 }],
        undefined,
        undefined,
        '/feed.xml',
      ),
    ).toBe(true);
  });
  it('a broad named catch-all matching a static asset is NOT eligible', () => {
    // `/:path{.+}` matches everything, including genuine static assets like
    // `/robots.txt` — it does NOT make a dotted path ISR page content.
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/:path{.+}', revalidate: 3600 }],
        undefined,
        undefined,
        '/robots.txt',
      ),
    ).toBe(false);
  });
  it('a `*` wildcard page matching a dotted asset is NOT eligible', () => {
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/docs/*', revalidate: 3600 }],
        undefined,
        undefined,
        '/docs/x.js',
      ),
    ).toBe(false);
  });
  it('a matching page with a zero/absent TTL is not eligible', () => {
    expect(
      isDottedPathIsrEligible([{ pattern: '/feed.xml' }], undefined, undefined, '/feed.xml'),
    ).toBe(false);
  });
  it('falls through to the flat map when no page matches', () => {
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/blog/:slug', revalidate: 120 }],
        { '/feed.xml': 60 },
        undefined,
        '/feed.xml',
      ),
    ).toBe(true);
  });
  it('a broad catch-all key in the flat map is NOT eligible', () => {
    expect(
      isDottedPathIsrEligible(undefined, { '/:path{.+}': 3600 }, undefined, '/robots.txt'),
    ).toBe(false);
  });
  it('a bare global-number revalidate declares no pattern → not eligible', () => {
    expect(isDottedPathIsrEligible(undefined, 60, undefined, '/feed.xml')).toBe(false);
  });
  it('an unmatched path is not eligible', () => {
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/feed.xml', revalidate: 60 }],
        undefined,
        undefined,
        '/about',
      ),
    ).toBe(false);
  });
  // 3-STATE: an inherit-eligible LITERAL dotted page resolves the per-path config.
  it('an inherit-eligible literal dotted page resolves the per-path config (positive → true, 0 → false)', () => {
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/feed.xml' }],
        undefined,
        { '/feed.xml': 60 },
        '/feed.xml',
      ),
    ).toBe(true);
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/feed.xml' }],
        undefined,
        { '/feed.xml': 0 },
        '/feed.xml',
      ),
    ).toBe(false);
  });
  // An inherit-eligible BROAD catch-all is never eligible even when pathRevalidate
  // resolves > 0 — a catch-all also matches genuine static assets.
  it('an inherit-eligible broad catch-all is never eligible even when pathRevalidate resolves > 0', () => {
    expect(
      isDottedPathIsrEligible(
        [{ pattern: '/:path{.+}' }],
        undefined,
        { '/docs/x.txt': 3600 },
        '/docs/x.txt',
      ),
    ).toBe(false);
  });
});

describe('matchesLiteralPage', () => {
  it('a LITERAL page pattern that exactly matches the target vouches for it', () => {
    expect(matchesLiteralPage([{ pattern: '/catch', revalidate: 60 }], '/catch', undefined)).toBe(
      true,
    );
  });
  it('a catch-all page does NOT vouch for an arbitrary target', () => {
    // `resolvePageTtl` would return 60 for `/graphql` here (the catch-all
    // first-matches ANY path) — that is exactly the bypass this closes. A
    // catch-all is not literal, so it must NOT positively identify the target.
    expect(
      matchesLiteralPage([{ pattern: '/:path{.+}', revalidate: 60 }], '/graphql', undefined),
    ).toBe(false);
  });
  it('a single-segment param page does NOT vouch for an arbitrary target', () => {
    expect(matchesLiteralPage([{ pattern: '/:slug', revalidate: 60 }], '/x', undefined)).toBe(
      false,
    );
  });
  it('a wildcard page does NOT vouch for an arbitrary target', () => {
    expect(matchesLiteralPage([{ pattern: '/a/*', revalidate: 60 }], '/a/b', undefined)).toBe(
      false,
    );
  });
  it('a literal page with a zero/absent TTL does not vouch', () => {
    expect(matchesLiteralPage([{ pattern: '/catch', revalidate: 0 }], '/catch', undefined)).toBe(
      false,
    );
  });
  it('a later literal does NOT vouch when an earlier catch-all is the first-match winner', () => {
    // First-match precedence: the catch-all `/:path{.+}` is declared FIRST, so it
    // is the winning route the framework's matchRoute resolves — it renders
    // `/graphql` dynamically. The later literal `/graphql` must NOT bypass that
    // and authorize shared-caching (pre-fix, the any-literal-match scan skipped
    // the catch-all and returned true on the later literal → cross-user leak).
    expect(
      matchesLiteralPage(
        [
          { pattern: '/:path{.+}', revalidate: 60 },
          { pattern: '/graphql', revalidate: 60 },
        ],
        '/graphql',
        undefined,
      ),
    ).toBe(false);
  });
  it('a literal vouches when it is the first-match winner ahead of a catch-all', () => {
    // Reverse ordering: the literal `/graphql` is declared FIRST, so it is the
    // winning route → an exact declared literal page, which legitimately vouches.
    expect(
      matchesLiteralPage(
        [
          { pattern: '/graphql', revalidate: 60 },
          { pattern: '/:path{.+}', revalidate: 60 },
        ],
        '/graphql',
        undefined,
      ),
    ).toBe(true);
  });
  it('undefined pages never vouch', () => {
    expect(matchesLiteralPage(undefined, '/catch', undefined)).toBe(false);
  });
  // 3-STATE: an inherit-eligible LITERAL page with a positive per-path rule vouches.
  it('an inherit-eligible literal page with a positive per-path rule vouches', () => {
    expect(matchesLiteralPage([{ pattern: '/catch' }], '/catch', { '/catch': 60 })).toBe(true);
  });
  // An inherit-eligible literal page whose per-path rule resolves 0 does NOT vouch.
  it('an inherit-eligible literal page whose per-path rule is 0 does NOT vouch', () => {
    expect(matchesLiteralPage([{ pattern: '/catch' }], '/catch', { '/catch': 0 })).toBe(false);
  });
});

describe('shouldBypassIsr', () => {
  it('returns true when Cookie header is present', () => {
    const request = new Request('https://example.com', {
      headers: { Cookie: 'session=abc' },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it('returns true when Authorization header is present', () => {
    const request = new Request('https://example.com', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it.each(['signed-access-assertion', ''])(
    'returns true when Cf-Access-Jwt-Assertion is present: %j',
    (assertion) => {
      const request = new Request('https://example.com', {
        headers: { 'Cf-Access-Jwt-Assertion': assertion },
      });
      expect(shouldBypassIsr(request)).toBe(true);
    },
  );

  it('returns false for X-VoidPages header (uses JSON edge cache instead)', () => {
    const request = new Request('https://example.com', {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(shouldBypassIsr(request)).toBe(false);
  });

  it('returns true when the request accepts event streams', () => {
    const request = new Request('https://example.com', {
      headers: { Accept: 'text/html, text/event-stream; q=1' },
    });
    expect(shouldBypassIsr(request)).toBe(true);
  });

  it('returns false for plain GET request', () => {
    const request = new Request('https://example.com');
    expect(shouldBypassIsr(request)).toBe(false);
  });
});

describe('isrCacheResponse', () => {
  it('sets x-isr-cache: HIT with edge-cacheable headers for fresh entry', () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: { 'Content-Type': 'text/html' },
      createdAt: Date.now(),
      ttl: 60,
    };
    const response = isrCacheResponse(entry, false);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-isr-cache')).toBe('HIT');
    expect(response.headers.get('Content-Type')).toBe('text/html');
    const cc = response.headers.get('Cache-Control')!;
    expect(cc).toContain('public');
    expect(cc).toContain('s-maxage=');
    expect(cc).toContain('must-revalidate');
  });

  it('sets x-isr-cache: STALE with short edge TTL for stale entry', () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 120000,
      ttl: 60,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get('x-isr-cache')).toBe('STALE');
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=10, max-age=0, must-revalidate',
    );
  });

  it('caps stale edge TTL at entry.ttl for short ISR windows', () => {
    const entry: IsrCacheEntry = {
      body: new ReadableStream(),
      status: 200,
      headers: {},
      createdAt: Date.now() - 10000,
      ttl: 5,
    };
    const response = isrCacheResponse(entry, true);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=5, max-age=0, must-revalidate',
    );
  });
});

describe('ISR edge cache keys', () => {
  it('adds the deployment id to HTML edge cache keys', () => {
    const request = new Request('https://app.void.app/about?q=1');
    const key = isrEdgeCacheKey(request, '/about', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/about?__void_isr=dpl_1');
    expect(key.method).toBe('GET');
  });

  it('canonicalizes trailing slashes for edge cache keys', () => {
    const request = new Request('https://app.void.app/about/');
    const key = isrEdgeCacheKey(request, '/about/', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/about?__void_isr=dpl_1');
  });

  it('adds JSON and deployment parameters to JSON edge cache keys', () => {
    const request = new Request('https://app.void.app/about?q=1');
    const key = isrEdgeCacheKeyJson(request, '/about', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/about?__void=json&__void_isr=dpl_1');
    expect(key.method).toBe('GET');
  });

  it('handles root path', () => {
    const request = new Request('https://app.void.app/');
    const key = isrEdgeCacheKeyJson(request, '/', 'dpl_1');
    expect(key.url).toBe('https://app.void.app/?__void=json&__void_isr=dpl_1');
  });
});

describe('serializeHeaders', () => {
  it('skips x-void-page-data header', () => {
    const response = new Response('ok', {
      headers: {
        'content-type': 'text/html',
        'x-void-page-data': '{"component":"Index"}',
        'x-custom': 'keep',
      },
    });
    const result = serializeHeaders(response);
    expect(result['content-type']).toBe('text/html');
    expect(result['x-custom']).toBe('keep');
    expect(result['x-void-page-data']).toBeUndefined();
  });

  it('skips cache-control and x-isr-cache', () => {
    const response = new Response('ok', {
      headers: {
        'cache-control': 'public',
        'x-isr-cache': 'HIT',
        'content-type': 'text/html',
      },
    });
    const result = serializeHeaders(response);
    expect(result['cache-control']).toBeUndefined();
    expect(result['x-isr-cache']).toBeUndefined();
    expect(result['content-type']).toBe('text/html');
  });

  it('strips set-cookie to prevent cross-user session replay', () => {
    const response = new Response('ok', {
      headers: {
        'content-type': 'text/html',
        'set-cookie': 'session=abc123; Path=/; HttpOnly',
        'x-custom': 'keep',
      },
    });
    const result = serializeHeaders(response);
    expect(result['set-cookie']).toBeUndefined();
    expect(result['content-type']).toBe('text/html');
    expect(result['x-custom']).toBe('keep');
  });
});

describe('page data extraction', () => {
  it('extracts embedded page data from the JSON script tag', () => {
    const pageData = '{"component":"Index","props":{"title":"hello"}}';
    const html = `<html><body><script id="__VOID_PAGE_DATA__" type="application/json">${pageData}</script><div id="app"></div></body></html>`;
    expect(extractPageDataFromHtml(html)).toBe(pageData);
  });

  it('skips embedded payloads with deferred metadata', () => {
    const html =
      '<script id="__VOID_PAGE_DATA__" type="application/json">{"component":"Index","props":{},"deferred":["stats"],"deferredKeys":{"stats":"stats"}}</script>';
    expect(extractPageDataFromHtml(html)).toBeNull();
  });

  it('normalizes legacy header payloads and rejects deferred ones', () => {
    expect(normalizePageDataForJsonCache('{"component":"Index","props":{}}')).toBe(
      '{"component":"Index","props":{}}',
    );
    expect(
      normalizePageDataForJsonCache(
        '{"component":"Index","props":{},"deferred":["stats"],"deferredKeys":{"stats":"stats"}}',
      ),
    ).toBeNull();
  });
});

/**
 * `MAX_ISR_VARIANTS_PER_PATH` defends against fanout when an attacker varies
 * an *allowlisted* query param (the queryAllowlist already drops everything
 * else). Past the cap, new variants are not written — the worker still
 * renders fresh content per request, but KV growth and revalidation cost
 * stay bounded.
 */
describe('writeIsrCache — variant cap', () => {
  function createKvMock(seed: Map<string, ArrayBuffer> = new Map()): {
    env: Env;
    kvStore: Map<string, ArrayBuffer>;
  } {
    const kvStore = seed;
    const env = {
      STATIC_ASSETS_R2: {
        head: async (key: string) => (kvStore.has(key.slice('isr-cache/'.length)) ? { key } : null),
        get: async (key: string) => {
          const value = kvStore.get(key.slice('isr-cache/'.length));
          return value
            ? {
                arrayBuffer: async () => value,
                customMetadata: {
                  isr: JSON.stringify({
                    s: 200,
                    c: Date.now(),
                    t: 60,
                    p: SHARED_CACHE_POLICY_VERSION,
                  }),
                },
              }
            : null;
        },
        put: async (key: string, value: ArrayBuffer) => {
          kvStore.set(key.slice('isr-cache/'.length), value);
        },
        delete: async (key: string) => {
          kvStore.delete(key.slice('isr-cache/'.length));
        },
        list: async (opts: { prefix: string; limit?: number; cursor?: string }) => {
          const all = [...kvStore.keys()]
            .map((key) => `isr-cache/${key}`)
            .filter((k) => k.startsWith(opts.prefix))
            .sort();
          const limit = opts.limit ?? 1000;
          const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
          const slice = all.slice(start, start + limit);
          const list_complete = start + limit >= all.length;
          return {
            objects: slice.map((key) => ({ key })),
            truncated: !list_complete,
            cursor: list_complete ? '' : String(start + limit),
          };
        },
      },
    } as unknown as Env;
    return { env, kvStore };
  }

  function seedVariants(kv: Map<string, ArrayBuffer>, count: number): void {
    for (let i = 0; i < count; i++) {
      const key = isrCacheKey('p', 'd', 'h', '/search', `https://h/search?q=${i}`);
      kv.set(key, new ArrayBuffer(4));
    }
  }

  it('writes a new variant when the path is under the cap', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH - 1);
    const before = kvStore.size;

    await writeIsrCache(
      env,
      'p',
      'd',
      'h',
      '/search',
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      'https://h/search?q=NEW',
    );

    expect(kvStore.size).toBe(before + 1);
    expect(kvStore.has(isrCacheKey('p', 'd', 'h', '/search', 'https://h/search?q=NEW'))).toBe(true);
  });

  it('refuses to write a brand-new variant once the cap is reached', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    const before = kvStore.size;

    await writeIsrCache(
      env,
      'p',
      'd',
      'h',
      '/search',
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      'https://h/search?q=OVERFLOW',
    );

    // No new key written; existing kv state is untouched.
    expect(kvStore.size).toBe(before);
    expect(kvStore.has(isrCacheKey('p', 'd', 'h', '/search', 'https://h/search?q=OVERFLOW'))).toBe(
      false,
    );
  });

  it('does not treat an empty nonfinal R2 page as free variant capacity', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    const list = vi.spyOn(env.STATIC_ASSETS_R2, 'list').mockResolvedValueOnce({
      objects: [],
      truncated: true,
      cursor: '0',
      delimitedPrefixes: [],
    });
    const url = 'https://h/search?q=OVERFLOW';
    await writeIsrCache(env, 'p', 'd', 'h', '/search', new Response('fresh'), 600, url);
    expect(list).toHaveBeenCalledTimes(2);
    expect(kvStore.has(isrCacheKey('p', 'd', 'h', '/search', url))).toBe(false);
    expect(kvStore.size).toBe(MAX_ISR_VARIANTS_PER_PATH);
  });

  it('still updates an existing variant past the cap (revalidation must keep working)', async () => {
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    // Pick one of the seeded URLs to update.
    const updateUrl = 'https://h/search?q=5';
    const updateKey = isrCacheKey('p', 'd', 'h', '/search', updateUrl);
    expect(kvStore.has(updateKey)).toBe(true);
    const before = kvStore.size;
    const beforeBytes = kvStore.get(updateKey)!.byteLength;

    await writeIsrCache(
      env,
      'p',
      'd',
      'h',
      '/search',
      new Response('<html>fresh</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      updateUrl,
    );

    // Same key, but value should be updated (different size — packed value
    // includes header JSON + body, both larger than the 4-byte seed).
    expect(kvStore.size).toBe(before);
    expect(kvStore.get(updateKey)!.byteLength).toBeGreaterThan(beforeBytes);
  });

  it('always writes direct-hit (non-variant) entries — cap only applies to #rw= entries', async () => {
    // Different pathnames each get their own cap; direct hits at one path
    // do not get squeezed by another path's variant fanout.
    const { env, kvStore } = createKvMock();
    seedVariants(kvStore, MAX_ISR_VARIANTS_PER_PATH);
    const before = kvStore.size;

    await writeIsrCache(
      env,
      'p',
      'd',
      'h',
      '/search',
      new Response('<html>x</html>', { headers: { 'Content-Type': 'text/html' } }),
      60,
      undefined, // direct hit, no originalUrl
    );

    expect(kvStore.size).toBe(before + 1);
    expect(kvStore.has(isrCacheKey('p', 'd', 'h', '/search'))).toBe(true);
  });
});

describe('packIsrValue / unpackIsrValue', () => {
  it('round-trips headers and body', () => {
    const headers = { 'content-type': 'text/html', etag: '"abc"' };
    const body = new TextEncoder().encode('<html>hello</html>').buffer as ArrayBuffer;
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(new TextDecoder().decode(result!.body)).toBe('<html>hello</html>');
  });

  it('handles empty body', () => {
    const headers = { 'content-type': 'text/html' };
    const body = new ArrayBuffer(0);
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(headers);
    expect(result!.body.byteLength).toBe(0);
  });

  it('handles empty headers', () => {
    const headers = {};
    const body = new TextEncoder().encode('hello').buffer as ArrayBuffer;
    const packed = packIsrValue(headers, body);
    const result = unpackIsrValue(packed);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual({});
    expect(new TextDecoder().decode(result!.body)).toBe('hello');
  });

  it('returns null for buffer too small', () => {
    expect(unpackIsrValue(new ArrayBuffer(2))).toBeNull();
  });

  it('returns null for truncated header', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 999, true); // claims 999 bytes of headers
    expect(unpackIsrValue(buf)).toBeNull();
  });
});
