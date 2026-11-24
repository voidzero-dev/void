import { describe, expect, it } from 'vite-plus/test';
import { hasUnlistedQueryParams } from '../../src/core.ts';
import {
  isrCacheKey,
  isrCachePrefix,
  isrCacheVariantPrefix,
  isrEdgeCacheUrl,
  isrEdgeCacheUrlForToken,
  isrLegacyCacheKey,
  isrLegacyCachePrefix,
  isrLegacyCacheVariantPrefix,
} from '../../src/index.ts';

describe('ISR variant token hashing', () => {
  function variantSuffix(key: string): string {
    const idx = key.indexOf('#rw=');
    expect(idx).toBeGreaterThan(-1);
    return key.slice(idx + '#rw='.length);
  }

  it('produces a fixed-length hex token regardless of URL length', () => {
    const short = isrCacheKey('p', 'd', 'h', '/x', 'https://h/');
    const long = isrCacheKey(
      'p',
      'd',
      'h',
      '/x',
      'https://h/' + 'A'.repeat(4096) + '?q=' + 'B'.repeat(4096),
    );
    const a = variantSuffix(short);
    const b = variantSuffix(long);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(b).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeLessThanOrEqual(64); // bounded, not URL-length-dependent
  });

  it('is deterministic — same URL produces the same token', () => {
    const a = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    const b = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    expect(a).toBe(b);
  });

  it('produces distinct tokens for distinct URLs', () => {
    const a = isrCacheKey('p', 'd', 'h', '/x', 'https://h/foo');
    const b = isrCacheKey('p', 'd', 'h', '/x', 'https://h/bar');
    expect(a).not.toBe(b);
  });

  it('current (v3) key strings are host-scoped', () => {
    expect(isrCacheKey('p', 'd', 'h', '/about')).toBe('p/isr/v3/d/h/about');
    expect(isrCacheKey('p', 'd', 'h', '/')).toBe('p/isr/v3/d/h/__index__');
    expect(isrCachePrefix('p', 'd')).toBe('p/isr/v3/d/');
    expect(isrCacheVariantPrefix('p', 'd', 'h', '/en/docs')).toBe('p/isr/v3/d/h/en/docs#rw=');
  });

  it('legacy (v2) helpers produce hostless isr/v2 strings', () => {
    expect(isrLegacyCachePrefix('p', 'd')).toBe('p/isr/v2/d/');
    expect(isrLegacyCacheKey('p', 'd', '/en/docs')).toBe('p/isr/v2/d/en/docs');
    expect(isrLegacyCacheKey('p', 'd', '/')).toBe('p/isr/v2/d/__index__');
    expect(isrLegacyCacheKey('p', 'd', '/about/')).toBe('p/isr/v2/d/about');
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/en/docs')).toBe('p/isr/v2/d/en/docs#rw=');
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/')).toBe('p/isr/v2/d/__index__#rw=');
    expect(isrLegacyCacheVariantPrefix('p', 'd', '/about/')).toBe('p/isr/v2/d/about#rw=');
  });

  it('isrEdgeCacheUrl and isrEdgeCacheUrlForToken agree for the same URL', () => {
    // The purger knows only the hashed token, not the original URL.
    const original = 'https://app.void.app/docs?utm=x';
    const fromUrl = isrEdgeCacheUrl('app.void.app', '/en/docs', 'dpl_1', 'html', original);
    const m = /__void_orig=([^&]+)/.exec(fromUrl);
    expect(m).not.toBeNull();
    const token = m![1];
    const fromToken = isrEdgeCacheUrlForToken('app.void.app', '/en/docs', 'dpl_1', 'html', token);
    expect(fromToken).toBe(fromUrl);
  });
});

describe('hasUnlistedQueryParams', () => {
  const allowlist = { '/search': ['q'], '/products/*': ['variant'] };

  it('is false without a query string', () => {
    expect(hasUnlistedQueryParams('https://h/search', '/search', allowlist)).toBe(false);
    expect(hasUnlistedQueryParams('https://h/page?', '/page', undefined)).toBe(false);
  });

  it('is false when every param is allowlisted for the path', () => {
    expect(hasUnlistedQueryParams('https://h/search?q=a&q=b', '/search', allowlist)).toBe(false);
  });

  it('is true when any param is outside the allowlist', () => {
    expect(hasUnlistedQueryParams('https://h/search?q=a&utm=x', '/search', allowlist)).toBe(true);
    expect(hasUnlistedQueryParams('https://h/page?msg=x', '/page', undefined)).toBe(true);
    expect(hasUnlistedQueryParams('https://h/page?q=a', '/page', allowlist)).toBe(true);
  });

  it('resolves wildcard allowlist patterns', () => {
    expect(
      hasUnlistedQueryParams('https://h/products/shoe?variant=red', '/products/shoe', allowlist),
    ).toBe(false);
    expect(
      hasUnlistedQueryParams(
        'https://h/products/shoe?variant=red&q=a',
        '/products/shoe',
        allowlist,
      ),
    ).toBe(true);
  });

  it('treats param names case-sensitively', () => {
    expect(hasUnlistedQueryParams('https://h/search?Q=a', '/search', allowlist)).toBe(true);
  });

  it('ignores empty separators that carry no param', () => {
    expect(hasUnlistedQueryParams('https://h/search?&', '/search', allowlist)).toBe(false);
    expect(hasUnlistedQueryParams('https://h/search?&q=a&', '/search', allowlist)).toBe(false);
  });
});
