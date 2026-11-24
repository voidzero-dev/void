import type { VoidConfig } from './config.ts';
import type { PageDefinition, PageScanResult } from './pages/types.ts';

/**
 * Whether a resolved `revalidate` value represents an active ISR configuration.
 * `null`/`undefined`/`0`/`{}` are treated as "no ISR", a positive number or a
 * non-empty path map is treated as "ISR on".
 */
export function hasRevalidate(r: unknown): boolean {
  if (r == null) {
    return false;
  }
  if (typeof r === 'number') {
    return r > 0;
  }
  if (typeof r === 'object') {
    return Object.keys(r as object).length > 0;
  }
  return false;
}

/**
 * Merge `routing.revalidate` with per-page `export const revalidate` rules into
 * the flat fallback map baked into managed and native builds. With page rules,
 * page entries come first and a number config becomes the `*` fallback. At
 * runtime, page requests use the `collectPages()` table instead.
 */
export function collectRevalidate(
  config: VoidConfig,
  pageScan: PageScanResult | null,
): number | Record<string, number> | undefined {
  if (config.routing?.isr === false) {
    return undefined;
  }
  const vcRevalidate = config.routing?.revalidate;
  let revalidate: number | Record<string, number> | undefined;
  if (vcRevalidate != null) {
    revalidate = vcRevalidate;
  }
  if (pageScan) {
    const perPageRules: Record<string, number> = {};
    for (const page of pageScan.pages) {
      if (page.revalidate != null) {
        // Catch-alls become '*' (a splat across '/'); `:slug` stays one segment.
        // Only scanned page patterns are rewritten; config keys pass through.
        const key = page.pattern.replaceAll(/:[A-Za-z0-9_]+\{[^}]*\}/g, '*');
        perPageRules[key] = page.revalidate;
      }
    }
    if (Object.keys(perPageRules).length > 0) {
      if (typeof revalidate === 'number') {
        if (!Object.hasOwn(perPageRules, '*')) {
          perPageRules['*'] = revalidate;
        }
        revalidate = perPageRules;
      } else if (typeof revalidate === 'object') {
        // Page entries first (first match wins). Drop duplicate config keys so
        // Object.fromEntries cannot overwrite a page value, such as a 0 opt-out.
        revalidate = Object.fromEntries([
          ...Object.entries(perPageRules),
          ...Object.entries(revalidate).filter(
            ([pattern]) => !Object.hasOwn(perPageRules, pattern),
          ),
        ]);
      } else {
        revalidate = perPageRules;
      }
    }
  }
  return revalidate;
}

/** A page export wins, then a number config; an object config (or none) gives `undefined`. */
function resolvePageBuildTtl(
  page: PageDefinition,
  revalidateConfig: number | Record<string, number> | undefined,
): number | undefined {
  if (page.revalidate != null) {
    return page.revalidate > 0 ? page.revalidate : 0;
  }
  if (typeof revalidateConfig === 'number') {
    return revalidateConfig > 0 ? revalidateConfig : 0;
  }
  return undefined;
}

/**
 * Build the ordered page table shipped in the deploy manifest as `pages`, in
 * `pageScan.pages` order with raw patterns (catch-alls are not collapsed).
 *
 * Each entry's `revalidate` has three states: N > 0 turns ISR on, 0 is an
 * explicit opt-out, and absent lets dispatch resolve the per-path object config
 * (`manifest.pathRevalidate`) against the request path. Object configs are not
 * baked because one dynamic page can span several entries, including a 0.
 *
 * Built from pages only, so a catch-all page TTL can also cache a non-`/api`
 * `routes/` handler at dispatch (bounded by `shouldBypassIsr` and `isApiPath`).
 */
export function collectPages(
  pageScan: PageScanResult | null,
  revalidateConfig?: number | Record<string, number> | undefined,
  isrEnabled = true,
): Array<{ pattern: string; revalidate?: number }> | undefined {
  if (!pageScan || pageScan.pages.length === 0) {
    return undefined;
  }
  return pageScan.pages.map((page) => {
    const ttl = isrEnabled ? resolvePageBuildTtl(page, revalidateConfig) : undefined;
    return ttl === undefined
      ? { pattern: page.pattern }
      : { pattern: page.pattern, revalidate: ttl };
  });
}
