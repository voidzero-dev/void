import { resolvePathTtl } from '@void/isr/runtime';
import { describe, expect, it } from 'vite-plus/test';
import type { VoidConfig } from '../../src/config.ts';
import { collectPages, collectRevalidate, hasRevalidate } from '../../src/isr-config.ts';
import { makePage, makeScan } from '../helpers/page-scan.ts';

describe('hasRevalidate', () => {
  it('treats null / undefined / 0 / negative / {} as no ISR', () => {
    expect(hasRevalidate(null)).toBe(false);
    expect(hasRevalidate(undefined)).toBe(false);
    expect(hasRevalidate(0)).toBe(false);
    expect(hasRevalidate(-5)).toBe(false);
    expect(hasRevalidate({})).toBe(false);
  });

  it('treats a positive number or a non-empty path map as ISR on', () => {
    expect(hasRevalidate(60)).toBe(true);
    expect(hasRevalidate({ '/x': 10 })).toBe(true);
  });

  it('treats non-number/non-object values as no ISR', () => {
    expect(hasRevalidate('60')).toBe(false);
    expect(hasRevalidate(true)).toBe(false);
  });
});

function configWith(revalidate: number | Record<string, number> | undefined): VoidConfig {
  return revalidate === undefined ? {} : { routing: { revalidate } };
}

describe('collectRevalidate', () => {
  it('disables every page policy when routing.isr is false', () => {
    const scan = makeScan([makePage('/', 31_536_000), makePage('/dynamic', 60)]);
    expect(collectRevalidate({ routing: { isr: false, revalidate: 120 } }, scan)).toBeUndefined();
    expect(collectPages(scan, { '*': 120 }, false)).toEqual([
      { pattern: '/' },
      { pattern: '/dynamic' },
    ]);
    expect(collectRevalidate({ routing: { isr: true } }, scan)).toEqual({
      '/': 31_536_000,
      '/dynamic': 60,
    });
  });
  it('returns undefined with no config and no per-page rules', () => {
    expect(collectRevalidate(configWith(undefined), makeScan([]))).toBeUndefined();
    expect(collectRevalidate(configWith(undefined), null)).toBeUndefined();
  });

  it('passes the void.json config through when there are no per-page rules', () => {
    expect(collectRevalidate(configWith(60), makeScan([]))).toBe(60);
    expect(collectRevalidate(configWith({ '/docs/*': 30 }), makeScan([]))).toEqual({
      '/docs/*': 30,
    });
  });

  it('uses per-page rules alone when config is absent', () => {
    const scan = makeScan([makePage('/blog/:slug', 120), makePage('/about')]);
    expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/blog/:slug': 120 });
  });

  it('turns a numeric config into a path map with the number as the "*" fallback (per-page first)', () => {
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const result = collectRevalidate(configWith(60), scan);
    expect(result).toEqual({ '/blog/:slug': 120, '*': 60 });
    expect(Object.keys(result as Record<string, number>)).toEqual(['/blog/:slug', '*']);
  });

  it('does not let the numeric fallback overwrite a page catch-all opt-out', () => {
    const scan = makeScan([makePage('*', 0)]);
    expect(collectRevalidate(configWith(60), scan)).toEqual({ '*': 0 });
  });

  it('merges per-page rules ahead of an object config (per-page first in match order)', () => {
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const result = collectRevalidate(configWith({ '/docs/*': 30, '*': 10 }), scan);
    expect(Object.entries(result as Record<string, number>)).toEqual([
      ['/blog/:slug', 120],
      ['/docs/*', 30],
      ['*', 10],
    ]);
  });

  it('does not let a duplicate object-config key overwrite an explicit page opt-out', () => {
    const scan = makeScan([makePage('/private', 0)]);
    expect(collectRevalidate(configWith({ '/private': 60 }), scan)).toEqual({ '/private': 0 });
  });

  it('ignores pages that declare no revalidate', () => {
    const scan = makeScan([makePage('/about'), makePage('/contact')]);
    expect(collectRevalidate(configWith(undefined), scan)).toBeUndefined();
    expect(collectRevalidate(configWith(60), scan)).toBe(60);
  });

  describe('route-param → key conversion (generated page keys)', () => {
    it('converts a catch-all param `[...slug]` (`/blog/:slug{.+}`) to `/blog/*`', () => {
      const scan = makeScan([makePage('/blog/:slug{.+}', 90)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/blog/*': 90 });
    });

    it('converts a root catch-all (`/:all{.+}`) to `/*`', () => {
      const scan = makeScan([makePage('/:all{.+}', 15)]);
      expect(collectRevalidate(configWith(undefined), scan)).toEqual({ '/*': 15 });
    });

    it('does NOT convert user `routing.revalidate` literal keys (only generated page keys)', () => {
      const scan = makeScan([makePage('/blog/:slug', 120)]);
      const result = collectRevalidate(configWith({ '/legacy/:kept': 30 }), scan);
      expect(Object.entries(result as Record<string, number>)).toEqual([
        ['/blog/:slug', 120],
        ['/legacy/:kept', 30],
      ]);
    });
  });

  it('produces keys that resolvePathTtl anchors to a single dynamic path segment', () => {
    const scan = makeScan([makePage('/blog/:slug', 120)]);
    const revalidate = collectRevalidate(configWith(undefined), scan);
    expect(resolvePathTtl(revalidate, '/blog/hello')).toBe(120);
    expect(resolvePathTtl(revalidate, '/blog/a/b')).toBe(0);
    expect(resolvePathTtl(revalidate, '/about')).toBe(0);
  });
});

describe('collectPages', () => {
  it('returns undefined when there is no page scan', () => {
    expect(collectPages(null)).toBeUndefined();
  });

  it('returns undefined when the scan has no pages', () => {
    expect(collectPages(makeScan([]))).toBeUndefined();
  });

  it('emits every page in scan order with raw patterns; revalidate only when set', () => {
    const scan = makeScan([
      makePage('/docs/setup/install'),
      makePage('/blog/:slug', 120),
      makePage('/docs/:path{.+}', 3600),
    ]);
    expect(collectPages(scan)).toEqual([
      { pattern: '/docs/setup/install' },
      { pattern: '/blog/:slug', revalidate: 120 },
      { pattern: '/docs/:path{.+}', revalidate: 3600 },
    ]);
  });

  it('per-page export wins over config', () => {
    const scan = makeScan([makePage('/p', 120)]);
    expect(collectPages(scan, 3600)).toEqual([{ pattern: '/p', revalidate: 120 }]);
    expect(collectPages(scan, { '/p': 9999 })).toEqual([{ pattern: '/p', revalidate: 120 }]);
  });

  it('explicit per-page revalidate=0 bakes the distinguished opt-out marker (revalidate:0)', () => {
    const scan = makeScan([makePage('/p', 0)]);
    expect(collectPages(scan, 3600)).toEqual([{ pattern: '/p', revalidate: 0 }]);
    expect(collectPages(scan, { '/p': 9999 })).toEqual([{ pattern: '/p', revalidate: 0 }]);
  });

  // Dispatch relies on 0 (explicit opt-out) vs absent (resolve the per-path
  // config against the request path).
  it('emits all three states: baked N, explicit 0 opt-out, and absent (inherit)', () => {
    const scan = makeScan([
      makePage('/on', 120), // per-page export > 0 → baked N
      makePage('/off', 0), // per-page export 0 → explicit opt-out marker
      makePage('/inherit'), // no export, object config → inherit (absent)
    ]);
    expect(collectPages(scan, { '/inherit': 60 })).toEqual([
      { pattern: '/on', revalidate: 120 },
      { pattern: '/off', revalidate: 0 },
      { pattern: '/inherit' },
    ]);
  });

  // A global-number config turns ISR on for every no-export page; otherwise
  // dispatch's resolvePageTtl would return 0 and disable page ISR site-wide.
  it('a global-number config applies to every no-export page', () => {
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    expect(collectPages(scan, 3600)).toEqual([
      { pattern: '/blog/:slug', revalidate: 3600 },
      { pattern: '/about', revalidate: 3600 },
    ]);
  });

  // A page can straddle several entries, including a per-path 0, so the raw
  // config ships as `manifest.pathRevalidate` and dispatch resolves it per request.
  it('an object config bakes no per-page TTL (pages are inherit-eligible)', () => {
    const scan = makeScan([makePage('/blog/:slug'), makePage('/about')]);
    expect(collectPages(scan, { '/blog/private': 0, '/blog/*': 3600 })).toEqual([
      { pattern: '/blog/:slug' },
      { pattern: '/about' },
    ]);
  });

  it('a no-export page does not inherit a sibling catch-all export', () => {
    const scan = makeScan([makePage('/docs/:path{.+}', 300), makePage('/docs/setup/install')]);
    expect(collectPages(scan)).toEqual([
      { pattern: '/docs/:path{.+}', revalidate: 300 },
      { pattern: '/docs/setup/install' },
    ]);
  });
});
