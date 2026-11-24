import { describe, it, expect } from 'vite-plus/test';
import {
  compilePattern,
  matchLiteralPattern,
  matchSegmentPattern,
  matchPattern,
  matchPatternCaptures,
  substituteParams,
} from '../../src/pattern.ts';

describe('matchPattern', () => {
  it('matches exact path', () => {
    expect(matchPattern('/index.html', '/index.html')).toBe(true);
  });

  it('rejects non-matching exact path', () => {
    expect(matchPattern('/index.html', '/about.html')).toBe(false);
  });

  it('matches wildcard at end', () => {
    expect(matchPattern('/assets/*', '/assets/app.js')).toBe(true);
  });

  it('matches wildcard across slashes', () => {
    expect(matchPattern('/assets/*', '/assets/js/app.js')).toBe(true);
  });

  it('matches leading wildcard extension', () => {
    expect(matchPattern('/*.html', '/index.html')).toBe(true);
  });

  it('rejects wildcard extension mismatch', () => {
    expect(matchPattern('/*.html', '/app.js')).toBe(false);
  });

  it('matches catch-all wildcard', () => {
    expect(matchPattern('/*', '/any/path/here')).toBe(true);
  });

  it('matches root with catch-all', () => {
    expect(matchPattern('/*', '/')).toBe(true);
  });

  it('matches path with special regex chars', () => {
    expect(matchPattern('/foo.bar', '/foo.bar')).toBe(true);
  });

  it('rejects dot as regex wildcard', () => {
    // The . in the pattern is a literal dot, not regex wildcard
    expect(matchPattern('/foo.html', '/fooXhtml')).toBe(false);
  });
});

describe('compilePattern', () => {
  it('captures :name as single path segment', () => {
    expect(compilePattern('/blog/:slug').paramNames).toEqual(['slug']);
    expect(matchPatternCaptures('/blog/:slug', '/blog/hello')).toEqual({ slug: 'hello' });
    expect(matchPatternCaptures('/blog/:slug', '/blog/hello/world')).toBeNull();
  });

  it('captures :name* as zero-or-more segments', () => {
    expect(compilePattern('/docs/:path*').paramNames).toEqual(['path']);
    expect(matchPatternCaptures('/docs/:path*', '/docs/a/b/c')).toEqual({ path: 'a/b/c' });
    expect(matchPatternCaptures('/docs/:path*', '/docs/')).toEqual({ path: '' });
  });

  it('captures legacy * as splat', () => {
    expect(compilePattern('/assets/*').paramNames).toEqual(['splat']);
    expect(matchPatternCaptures('/assets/*', '/assets/js/app.js')).toEqual({ splat: 'js/app.js' });
  });

  it('captures middle * as only what actually matched, not prefix-slice', () => {
    expect(matchPatternCaptures('/blog/*/edit', '/blog/hello/edit')).toEqual({ splat: 'hello' });
    expect(matchPatternCaptures('/blog/*/edit', '/blog/a/b/edit')).toEqual({ splat: 'a/b' });
    expect(matchPatternCaptures('/blog/*/edit', '/blog/hello')).toBeNull();
  });

  it('matches legacy patterns with multiple anonymous wildcards', () => {
    expect(compilePattern('/a/*/b/*').paramNames).toEqual(['splat']);
    expect(matchPattern('/a/*/b/*', '/a/x/b/y')).toBe(true);
    expect(matchPattern('/a/*/b/*', '/a/x/c/y')).toBe(false);
  });

  it('captures multiple named params in one pattern', () => {
    expect(compilePattern('/blog/:author/:slug').paramNames).toEqual(['author', 'slug']);
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello')).toEqual({
      author: 'alice',
      slug: 'hello',
    });
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello/world')).toBeNull();
  });

  it('escapes regex-special characters in literals', () => {
    expect(matchPattern('/foo.html', '/foo.html')).toBe(true);
    expect(matchPattern('/foo.html', '/fooXhtml')).toBe(false);
  });

  it('treats bare colon (no name chars after) as literal', () => {
    expect(compilePattern('/foo:/bar').paramNames).toEqual([]);
    expect(matchPattern('/foo:/bar', '/foo:/bar')).toBe(true);
    expect(matchPattern('/foo:/bar', '/fooX/bar')).toBe(false);
  });

  it('matchPattern supports legacy patterns with multiple anonymous wildcards', () => {
    expect(matchPattern('/a/*/b/*', '/a/x/b/y')).toBe(true);
    expect(matchPattern('/a/*/b/*', '/a/x/c/y')).toBe(false);
  });

  it('matchPatternCaptures returns the first legacy splat for multi-splat patterns', () => {
    expect(matchPatternCaptures('/a/*/b/*', '/a/x/b/y')).toEqual({ splat: 'x' });
  });

  it('returns cached CompiledPattern for repeated input', () => {
    const a = compilePattern('/cache-test/:id');
    const b = compilePattern('/cache-test/:id');
    expect(b).toBe(a);
  });
});

describe('matchPatternCaptures', () => {
  it('returns null when pattern does not match', () => {
    expect(matchPatternCaptures('/blog/:slug', '/articles/hello')).toBeNull();
  });

  it('returns captured groups on match', () => {
    expect(matchPatternCaptures('/blog/:author/:slug', '/blog/alice/hello')).toEqual({
      author: 'alice',
      slug: 'hello',
    });
  });

  it('returns empty object when pattern has no captures', () => {
    expect(matchPatternCaptures('/about', '/about')).toEqual({});
  });

  it('returns splat for legacy * pattern', () => {
    expect(matchPatternCaptures('/assets/*', '/assets/js/app.js')).toEqual({
      splat: 'js/app.js',
    });
  });
});

describe('matchLiteralPattern', () => {
  it('treats `:` as a literal character (no named capture)', () => {
    // `:health` would be a named capture in `matchPattern`, but the literal
    // matcher must keep the pre-feat/rewrites semantics where `:` was just a
    // regex-safe literal. Existing tenant header/revalidate configs may rely
    // on this (e.g. `/api/v1:health`, `:batchGet`-style URLs).
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1foo')).toBe(false);
  });

  it('does NOT anchor a whole-segment `:name` — it stays a literal (regression guard)', () => {
    // REGRESSION (3282937e): `matchLiteralPattern` briefly treated a
    // whole-segment `:name` as a single-segment wildcard, so a user header rule
    // or revalidateQueryAllowlist key like `/:batchGet` over-matched every
    // single-segment path (`/foo`, `/about`, …). The literal matcher must treat
    // `:batchGet` as a literal so it matches ONLY the literal `/:batchGet`.
    expect(matchLiteralPattern('/:batchGet', '/foo')).toBe(false);
    expect(matchLiteralPattern('/:batchGet', '/:batchGet')).toBe(true);
    // A whole-segment `:name` inside a longer path is likewise literal.
    expect(matchLiteralPattern('/blog/:slug', '/blog/hello')).toBe(false);
    expect(matchLiteralPattern('/blog/:slug', '/blog/:slug')).toBe(true);
  });

  it('keeps a mid-segment literal `:` a literal (Google custom-method form)', () => {
    // `/api/v1:health`, `/api/documents:batchGet` — the `:` is mid-segment, so
    // it matches only itself.
    expect(matchLiteralPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1anything')).toBe(false);
    expect(matchLiteralPattern('/api/v1:health', '/api/v1/health')).toBe(false);
    expect(matchLiteralPattern('/api/documents:batchGet', '/api/documents:batchGet')).toBe(true);
    expect(matchLiteralPattern('/api/documents:batchGet', '/api/documents')).toBe(false);
  });

  it('still expands `*` to match any characters including slashes', () => {
    expect(matchLiteralPattern('/assets/*', '/assets/js/app.js')).toBe(true);
    expect(matchLiteralPattern('/assets/*', '/other/file')).toBe(false);
    expect(matchLiteralPattern('/blog/*', '/blog/a/b')).toBe(true);
    expect(matchLiteralPattern('/blog/*', '/blog/hello')).toBe(true);
    expect(matchLiteralPattern('/*', '/')).toBe(true);
    expect(matchLiteralPattern('/*', '/x/y')).toBe(true);
  });
});

describe('matchSegmentPattern', () => {
  // Segment-anchored matcher for revalidate ROUTE keys ONLY. A whole-segment
  // `:name` (a route param key, `[slug]` → `/blog/:slug`, whose name is any
  // non-empty run of non-`/` chars — hyphens/dots included, NOT just
  // JS-identifier chars) anchors to exactly ONE non-empty path segment
  // (`[^/]+`); `*` stays a splat that crosses `/`; a mid-segment `:` stays
  // literal.
  it('anchors whole-segment `:name` to exactly one path segment', () => {
    expect(matchSegmentPattern('/blog/:slug', '/blog/hello')).toBe(true);
    // `:slug` must NOT cross a slash…
    expect(matchSegmentPattern('/blog/:slug', '/blog/a/b')).toBe(false);
    // …and must require a non-empty segment.
    expect(matchSegmentPattern('/blog/:slug', '/blog/')).toBe(false);
    expect(matchSegmentPattern('/blog/:slug', '/blog')).toBe(false);
  });

  it('anchors a leading whole-segment `:name` (root-level single segment)', () => {
    expect(matchSegmentPattern('/:token', '/foo')).toBe(true);
    expect(matchSegmentPattern('/:token', '/foo/bar')).toBe(false);
    expect(matchSegmentPattern('/:token', '/')).toBe(false);
  });

  it('keeps `*` a catch-all that crosses slashes', () => {
    expect(matchSegmentPattern('/blog/*', '/blog/a/b')).toBe(true);
    expect(matchSegmentPattern('/blog/*', '/blog/hello')).toBe(true);
    expect(matchSegmentPattern('/*', '/')).toBe(true);
    expect(matchSegmentPattern('/*', '/x/y')).toBe(true);
  });

  it('matches multiple whole-segment params, each a single segment', () => {
    expect(matchSegmentPattern('/shop/:cat/:id', '/shop/shoes/42')).toBe(true);
    expect(matchSegmentPattern('/shop/:cat/:id', '/shop/shoes/42/extra')).toBe(false);
    expect(matchSegmentPattern('/shop/:cat/:id', '/shop/shoes')).toBe(false);
  });

  it('leaves a mid-segment `:` a literal (only whole-segment `:name` anchors)', () => {
    // `/api/v1:health` — the `:` is mid-segment (preceded by `v1`, not `/`),
    // so it stays a literal and the pattern matches only itself.
    expect(matchSegmentPattern('/api/v1:health', '/api/v1:health')).toBe(true);
    expect(matchSegmentPattern('/api/v1:health', '/api/v1anything')).toBe(false);
    // Must NOT over-match a same-prefix single segment: `/api/v1x` differs.
    expect(matchSegmentPattern('/api/v1:health', '/api/v1x')).toBe(false);
    expect(matchSegmentPattern('/api/v1:health', '/api/v1/health')).toBe(false);
  });

  it('anchors a whole-segment `:name` whose name contains a hyphen', () => {
    // The bug: `pages/blog/[post-id].vue` → manifest/revalidate key
    // `/blog/:post-id`. The `-` is not a JS-identifier char, so the old
    // `[A-Za-z0-9_]+` param class failed to anchor `:post-id` and the whole
    // pattern compiled to a dead literal — ISR silently disabled. `[^/]+` fixes
    // it: `:post-id` now anchors to exactly one segment.
    expect(matchSegmentPattern('/blog/:post-id', '/blog/hello')).toBe(true);
    // Still a single segment — must not cross a slash.
    expect(matchSegmentPattern('/blog/:post-id', '/blog/a/b')).toBe(false);
  });

  it('anchors multiple hyphenated whole-segment params, each a single segment', () => {
    expect(matchSegmentPattern('/shop/:cat-x/:id-y', '/shop/a/b')).toBe(true);
    expect(matchSegmentPattern('/shop/:cat-x/:id-y', '/shop/a/b/c')).toBe(false);
    expect(matchSegmentPattern('/shop/:cat-x/:id-y', '/shop/a')).toBe(false);
  });

  it('leaves an empty param name (`:` with no name) a literal', () => {
    // `[^/]+` requires at least one char after `:`, so a bare `:` at the start
    // of a segment is NOT a whole-segment param — it stays a literal `:` and the
    // pattern matches only itself, never an arbitrary segment.
    expect(matchSegmentPattern('/blog/:', '/blog/hello')).toBe(false);
    expect(matchSegmentPattern('/blog/:', '/blog/:')).toBe(true);
    expect(matchSegmentPattern('/:', '/foo')).toBe(false);
    expect(matchSegmentPattern('/:', '/:')).toBe(true);
  });

  it('swallows a `*` adjacent to a `:name` into the single-segment param', () => {
    // Documented behavior, not a bug. Because `[^/]+` is greedy over ALL
    // non-`/` chars, a `*` glued to a param name (`/:foo*`) is consumed INTO the
    // param, so `/:foo*` compiles to a single-segment matcher (`^/[^/]+$`) — the
    // `*` does NOT become an independent cross-slash splat here.
    //
    // This is acceptable and, in fact, matches the framework's own route matcher
    // (`patternToRegex` in pages/manifest.ts also collapses `/:foo*` to
    // `\/([^/]+)`). Machine-generated route params never contain `*` — named
    // catch-alls serialize to `:name{.+}` (handled as a cross-slash `.+`
    // catch-all, see the `{.+}` block below), unnamed catch-alls to a bare `*` —
    // and this matcher is revalidate-only boolean matching. Crucially, the
    // IDIOMATIC catch-all — a bare `*` NOT glued to a `:name` — is unaffected
    // (see below).
    expect(matchSegmentPattern('/:foo*', '/bar')).toBe(true);
    expect(matchSegmentPattern('/:foo*', '/bar/baz')).toBe(false);
    // Idiomatic catch-all still crosses slashes.
    expect(matchSegmentPattern('/blog/*', '/blog/a/b/c')).toBe(true);
  });

  it('expands a NAMED CATCH-ALL `:name{.+}` to a cross-slash `.+` (>=1 char)', () => {
    // A named catch-all page (`pages/docs/[...path].tsx`) serializes to the
    // revalidate key `/docs/:path{.+}`. The `{.+}` must cross `/` (nested paths)
    // AND require at least one char — mirroring Hono's `{.+}` and the framework's
    // own client route matcher (`patternToRegex` maps `:path{.+}` -> `(.+)`).
    //
    // Regression guard: with the plain `:[^/]+` rule alone, `path{.+}` was
    // swallowed whole as an ordinary param name, so `/docs/:path{.+}` compiled to
    // `^/docs/[^/]+$` and every NESTED path (`/docs/a/b`) silently got TTL 0 —
    // dispatch never cached it and the deploy prerender-warm skipped it.
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs/a')).toBe(true);
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs/a/b')).toBe(true);
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs/a/b/c')).toBe(true);
    // `.+` requires >=1 char: the bare parent and a trailing-slash-only path
    // must NOT match (Hono `{.+}` is not `{.*}`).
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs')).toBe(false);
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs/')).toBe(false);
    // Catch-all anchored at the root.
    expect(matchSegmentPattern('/:path{.+}', '/a/b')).toBe(true);
  });

  it('does NOT widen a REGEX-constrained `:name{...}` param (only exact `{.+}`)', () => {
    // Only the literal `{.+}` constraint widens to a catch-all. A regex-
    // constrained param like `:path{[0-9]+}` keeps its single-segment meaning
    // (`[^/]+`) — a name that contains a brace is not a catch-all name.
    // Over-widening it would be a correctness bug.
    expect(matchSegmentPattern('/docs/:path{[0-9]+}', '/docs/a')).toBe(true);
    expect(matchSegmentPattern('/docs/:path{[0-9]+}', '/docs/a/b')).toBe(false);
  });

  it('leaves literal braces (no `:name` prefix) untouched', () => {
    // `/files/{id}` has no whole-segment `:name`, so both `{` and `}` stay
    // literal — the pattern matches only itself, never an arbitrary segment.
    expect(matchSegmentPattern('/files/{id}', '/files/{id}')).toBe(true);
    expect(matchSegmentPattern('/files/{id}', '/files/abc')).toBe(false);
  });

  it('leaves a mid-segment `:name{.+}` a literal (only whole-segment anchors)', () => {
    // The `:` is mid-segment (preceded by `v1`, not `/`), so it is not a
    // whole-segment param and the whole token stays literal — consistent with
    // the `/api/v1:health` literal rule above.
    expect(matchSegmentPattern('/api/v1:path{.+}', '/api/v1/a/b')).toBe(false);
  });

  it('treats private-use characters in the pattern as literal text', () => {
    expect(matchSegmentPattern('/a\uE000b', '/axyzb')).toBe(false);
    expect(matchSegmentPattern('/a\uE001b', '/ax/yb')).toBe(false);
    expect(matchSegmentPattern('/a\uE000b', '/a\uE000b')).toBe(true);
  });

  it('does not share a cache with matchLiteralPattern', () => {
    // The SAME pattern string parses DIFFERENTLY in the two matchers.
    // A shared cache would let whichever ran first poison the other. Prime the
    // literal matcher first, then assert the segment matcher still anchors.
    expect(matchLiteralPattern('/blog/:slug', '/blog/hello')).toBe(false);
    expect(matchSegmentPattern('/blog/:slug', '/blog/hello')).toBe(true);
    // And the reverse ordering, with a fresh pattern string.
    expect(matchSegmentPattern('/news/:id', '/news/42')).toBe(true);
    expect(matchLiteralPattern('/news/:id', '/news/42')).toBe(false);
    // Cache isolation for the NAMED CATCH-ALL form too: matchLiteralPattern
    // treats `{.+}` as literal, matchSegmentPattern expands it to a cross-slash
    // `.+`. Priming the literal cache first must not poison the segment matcher.
    expect(matchLiteralPattern('/docs/:path{.+}', '/docs/a/b')).toBe(false);
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs/a/b')).toBe(true);
  });
});

describe('regex-compatible details', () => {
  it('lets `*` and `{.+}` stop at line terminators, while `:name` takes them', () => {
    expect(matchPatternCaptures('/*', '/a\nb')).toBeNull();
    expect(matchPatternCaptures('/:x', '/\n')).toEqual({ x: '\n' });
    expect(matchLiteralPattern('/*', '/a\u2028b')).toBe(false);
    expect(matchSegmentPattern('/docs/:path{.+}', '/docs/a\nb')).toBe(false);
    expect(matchSegmentPattern('/blog/:slug', '/blog/a\nb')).toBe(true);
  });

  it('gives each wildcard, left to right, the longest text that still matches', () => {
    expect(matchPatternCaptures('/:a*/:b*', '/x/y/z')).toEqual({ a: 'x/y', b: 'z' });
    expect(matchPatternCaptures('/:a:b', '/xyz')).toEqual({ a: 'xy', b: 'z' });
    expect(matchPatternCaptures('/:a**', '/x/y')).toEqual({ a: 'x/y', splat: '' });
    expect(matchPatternCaptures('/*/static/*', '/a/static/b/static/c')).toEqual({
      splat: 'a/static/b',
    });
    expect(matchPatternCaptures('/u/:id*/files/*', '/u/files/files/x')).toEqual({
      id: 'files',
      splat: 'x',
    });
  });

  it('rejects a name that starts with a digit', () => {
    expect(() => compilePattern('/:1')).toThrow(/invalid capture group name/i);
    expect(() => compilePattern('/:2fa')).toThrow(/invalid capture group name/i);
    expect(matchPattern('/:1', '/x')).toBe(false);
    expect(matchPatternCaptures('/:1', '/x')).toBeNull();
    expect(matchPatternCaptures('/:id/:id', '/a/b')).toBeNull();
  });

  it('returns names as own keys of a null-prototype object', () => {
    const params = matchPatternCaptures('/:__proto__/:constructor', '/a/b')!;
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.entries(params)).toEqual([
      ['__proto__', 'a'],
      ['constructor', 'b'],
    ]);
    expect(Object.getPrototypeOf(matchPatternCaptures('/old', '/old'))).toBeNull();
  });

  it('still offers the deprecated regex view', () => {
    const { regex } = compilePattern('/u/:id*/files/*');
    expect(regex.source).toBe(String.raw`^\/u\/(?<id>.*)\/files\/(?<splat>.*)$`);
    expect(regex.exec('/u/42/extra/files/a/b')?.groups).toEqual({ id: '42/extra', splat: 'a/b' });
  });
});

describe('large and adversarial patterns', () => {
  it('matches a pattern too long for a RegExp instead of throwing', () => {
    const big = '/' + 'a'.repeat(40_000);
    expect(matchLiteralPattern(big, big)).toBe(true);
    expect(matchSegmentPattern(big, big)).toBe(true);
    expect(matchPattern(big, big)).toBe(true);
    expect(matchPatternCaptures(big + '/:x', big + '/y')).toEqual({ x: 'y' });
    expect(matchPatternCaptures(big, '/foo')).toBeNull();
  });

  it('returns quickly for many wildcards on a long path that does not match', () => {
    // A backtracking matcher takes seconds or more on each of these.
    expect(matchLiteralPattern('/' + '*'.repeat(20) + 'x', '/' + 'a'.repeat(13) + '\nx')).toBe(
      false,
    );
    expect(
      matchLiteralPattern('/' + '*a'.repeat(40) + '\nb', '/' + 'a'.repeat(16_000) + 'x\nb'),
    ).toBe(false);
    const rest = '/' + Array.from({ length: 10 }, (_, i) => `:p${i}*`).join('/') + '/x';
    expect(matchPatternCaptures(rest, '/a'.repeat(40) + '\n/x')).toBeNull();
    const plus = '/' + Array.from({ length: 10 }, (_, i) => `:p${i}{.+}`).join('/') + '/x';
    expect(matchSegmentPattern(plus, '/a'.repeat(41) + '\n/x')).toBe(false);
  });
});

describe('substituteParams', () => {
  it('substitutes :name tokens', () => {
    expect(substituteParams('/articles/:slug', { slug: 'hello' })).toBe('/articles/hello');
  });

  it('substitutes :name* tokens', () => {
    expect(substituteParams('/new/:path*', { path: 'a/b/c' })).toBe('/new/a/b/c');
  });

  it('substitutes :splat for legacy * destinations', () => {
    expect(substituteParams('/new/:splat', { splat: 'a/b' })).toBe('/new/a/b');
  });

  it('substitutes multiple tokens in one destination', () => {
    expect(substituteParams('/posts/:author/:slug', { author: 'alice', slug: 'hello' })).toBe(
      '/posts/alice/hello',
    );
  });

  it('leaves token untouched when param missing', () => {
    expect(substituteParams('/articles/:slug', {})).toBe('/articles/:slug');
  });

  it('leaves token untouched when :name* param missing', () => {
    expect(substituteParams('/new/:path*', {})).toBe('/new/:path*');
  });

  it('ignores extra params not referenced by destination', () => {
    expect(substituteParams('/articles/:slug', { slug: 'hi', extra: 'x' })).toBe('/articles/hi');
  });

  it('keeps a path destination on the same site when a capture starts with a slash', () => {
    expect(substituteParams('/:splat', { splat: '/evil.com' })).toBe('/evil.com');
    expect(substituteParams('/:splat', { splat: String.raw`\evil.com` })).toBe('/evil.com');
    expect(substituteParams(':splat', { splat: '//evil.com' })).toBe('/evil.com');
    expect(substituteParams('/:path*', { path: '//evil.com/x' })).toBe('/evil.com/x');
  });

  it('leaves protocol-relative, absolute and prefixed destinations unchanged', () => {
    expect(substituteParams('//cdn.example.com/:splat', { splat: 'a' })).toBe(
      '//cdn.example.com/a',
    );
    expect(substituteParams('https://x.com/:splat', { splat: '/a' })).toBe('https://x.com//a');
    expect(substituteParams('/posts/:splat', { splat: '/x' })).toBe('/posts//x');
  });
});
