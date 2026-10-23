import { isrCacheKey, isrCacheVariantPrefix, isrEdgeCacheUrl } from '@void/isr';
import {
  decodeIsrCacheEntry,
  extractPageDataFromHtml,
  isrCacheResponse,
  isStale,
  normalizePageDataForJsonCache,
  packIsrValue,
  resolvePathTtl,
  resolveRevalidateTtl,
  SHARED_CACHE_POLICY_VERSION,
  serializeHeaders,
  shouldBypassIsr,
  type IsrCacheEntry,
  type IsrCacheMetadata,
} from '@void/isr/core';
import { MAX_ISR_VARIANTS_PER_PATH } from '@void/isr/runtime';
import { createIsrStore } from '@voidcloud/api/isr-store';
import type { Env } from './env.ts';
import { matchSegmentPattern } from './pattern.ts';

// Re-exported for index.ts and tests.
export {
  extractPageDataFromHtml,
  isFrameworkDocumentRequest,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  isrCacheResponse,
  isStale,
  normalizePageDataForJsonCache,
  packIsrValue,
  resolvePageTtl,
  resolvePathTtl,
  resolveRevalidateTtl,
  serializeHeaders,
  shouldBypassIsr,
  SHARED_CACHE_POLICY_HEADER,
  SHARED_CACHE_POLICY_VERSION,
  markSharedCachePolicy,
  unpackIsrValue,
} from '@void/isr/core';
export { isrCacheKey } from '@void/isr';
export type { IsrCacheEntry, IsrCacheMetadata } from '@void/isr/core';

/**
 * Read an ISR cache entry from the strongly consistent shared store.
 * Returns null on cache miss, malformed metadata, or a storage read failure so the
 * caller renders the page live.
 */
export async function readIsrCache(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null,
): Promise<IsrCacheEntry | null> {
  const key = isrCacheKey(projectId, deploymentId, host, pathname, originalUrl);
  try {
    const { value, metadata } = await createIsrStore(env.STATIC_ASSETS_R2).getWithMetadata(key);
    return decodeIsrCacheEntry(value, metadata);
  } catch {
    return null;
  }
}

/**
 * Delete an ISR cache entry from the shared store.
 * Used when a worker permanently opts out via x-revalidate: 0.
 */
export async function deleteIsrCache(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null,
): Promise<void> {
  const key = isrCacheKey(projectId, deploymentId, host, pathname, originalUrl);
  await createIsrStore(env.STATIC_ASSETS_R2, env.ISR_CACHE).delete(key);
}

/**
 * Write an ISR cache entry to R2. Variant writes are gated by
 * `MAX_ISR_VARIANTS_PER_PATH` — past the cap, only updates to existing
 * variant slots go through. Direct-hit entries (no `originalUrl`) are
 * never gated.
 */
export async function writeIsrCache(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  response: Response,
  ttl: number,
  originalUrl?: string | null,
): Promise<void> {
  const key = isrCacheKey(projectId, deploymentId, host, pathname, originalUrl);
  // Clone synchronously so the cap-check `await` below cannot race with
  // callers (in `index.ts`) that consume `response.body` for the client
  // response after kicking us off via `ctx.waitUntil`. The clone has its
  // own independent body; the original is free to be consumed elsewhere.
  const responseClone = response.clone();
  const headers = serializeHeaders(responseClone);
  const status = responseClone.status;

  if (
    originalUrl &&
    !(await isVariantWriteAllowed(env, projectId, deploymentId, host, pathname, key))
  ) {
    return;
  }

  const body = await responseClone.arrayBuffer();
  const packed = packIsrValue(headers, body);

  await createIsrStore(env.STATIC_ASSETS_R2).put(key, packed, {
    metadata: {
      s: status,
      c: Date.now(),
      t: ttl,
      p: SHARED_CACHE_POLICY_VERSION,
    } satisfies IsrCacheMetadata,
  });
}

/**
 * Returns true if writing the given variant key is allowed under the
 * per-pathname cap. Always allows updates to existing variants (so ISR
 * revalidation keeps working after a path saturates).
 *
 * R2 can return short or empty nonfinal pages. Count until the cap or end;
 * once full, a point lookup permits updating an existing variant without
 * scanning beyond the cap.
 */
async function isVariantWriteAllowed(
  env: Env,
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  key: string,
): Promise<boolean> {
  const prefix = isrCacheVariantPrefix(projectId, deploymentId, host, pathname);
  const cache = createIsrStore(env.STATIC_ASSETS_R2);
  let count = 0;
  let cursor: string | undefined;
  do {
    const listed = await cache.list({ prefix, cursor, limit: MAX_ISR_VARIANTS_PER_PATH });
    if (listed.keys.some((entry) => entry.name === key)) {
      return true;
    }
    count += listed.keys.length;
    if (count >= MAX_ISR_VARIANTS_PER_PATH) {
      return cache.has(key);
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return true;
}

/**
 * Effective ISR TTL for a `pages` entry that ALREADY matched `pathname`,
 * decoding the 3-STATE table the framework's `collectPages` emits:
 *   - a baked number is authoritative — `> 0` = ISR on, `0` = an EXPLICIT
 *     opt-out (a per-page `export const revalidate = 0`, or a global-0 config);
 *   - an ABSENT `revalidate` is INHERIT-eligible — resolve the RAW per-path
 *     `pathRevalidate` OBJECT config against the ACTUAL path, so a per-path `0`
 *     opt-out (or a wildcard / exact rule) that a dynamic page pattern straddles
 *     is honored at the edge (build-time baking cannot — hence the split).
 * Keep in sync with `collectPages` (`packages/void/src/isr-config.ts`) and the api
 * prewarm mirror (`packages/api/src/routes/deploy.ts`).
 */
function matchedPageTtl(
  page: { pattern: string; revalidate?: number },
  pathRevalidate: Record<string, number> | undefined,
  pathname: string,
): number {
  if (page.revalidate === undefined) {
    return resolvePathTtl(pathRevalidate, pathname);
  }
  return page.revalidate > 0 ? page.revalidate : 0;
}

/**
 * A pattern is LITERAL when it has no param (`:name`), regex (`{...}`), or
 * wildcard (`*`) marker — so `matchSegmentPattern` matches ONLY the exact path,
 * never an arbitrary one. Used by `matchesLiteralPage` (applied to the whole
 * pattern).
 */
function isLiteralPattern(pattern: string): boolean {
  return !/[:{*]/.test(pattern);
}

/**
 * True iff `target` EXACTLY matches a declared LITERAL ISR page (positive TTL).
 * A literal page pattern matches exactly one path, so a match POSITIVELY
 * identifies the fallback target as that specific author-declared ISR page.
 * A catch-all (`/:path{.+}`) or param page (`/:slug`) is NOT literal and never
 * vouches — it matches arbitrary paths, so it cannot certify an arbitrary
 * fallback target as public page content.
 */
export function matchesLiteralPage(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  target: string,
  pathRevalidate: Record<string, number> | undefined,
): boolean {
  if (!pages) {
    return false;
  }
  for (const page of pages) {
    if (matchSegmentPattern(page.pattern, target)) {
      // First matching route WINS — mirror resolvePageTtl / the framework's
      // matchRoute order (0077's invariant: never re-order, never skip a matching
      // route). Authorize shared-caching of a fallback render only when that WINNING
      // route is an exact literal page with a positive effective TTL; a catch-all/param
      // winner means the framework renders this path dynamically, so it must NOT be
      // cached. `matchedPageTtl` resolves an inherit-eligible literal page against the
      // per-path config (a literal page maps to exactly one path — no straddle).
      return isLiteralPattern(page.pattern) && matchedPageTtl(page, pathRevalidate, target) > 0;
    }
  }
  return false;
}

/**
 * A pattern is a BROAD catch-all when it crosses segment boundaries — a named
 * catch-all `:name{.+}` (compiles to `.+`) or a `*` wildcard (compiles to `.*`).
 * Such a pattern matches ANY path, including genuine static assets, so it cannot
 * certify a dotted path as page ISR content. A single-segment param (`/blog/:slug`
 * → `[^/]+`) or a literal (`/feed.xml`) is NOT broad. See `pattern.ts`'s
 * catch-all syntax (`:[^/{}]+\{\.\+\}` and `*`).
 */
export function isBroadCatchAll(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('{.+}');
}

/**
 * A dotted request path is ISR page content (not a static asset) when it matches a
 * declared page route that is NOT a broad catch-all: a literal (`/feed.xml`) or a
 * single-segment param (`/blog/:slug`) that matches means the framework serves it
 * as that page, so `/blog/release.v2` gets ISR even though it has a dot. A broad
 * catch-all (`/:path{.+}`, `*`) matches everything including genuine static assets
 * (`/robots.txt`), so it does NOT make a dotted path ISR content. Mirrors
 * `resolvePageTtl`'s match order: pages first-match, then the flat map. A bare
 * global-NUMBER `revalidate` declares no pattern, so dotted paths under it are NOT
 * treated as ISR-eligible page content (documented narrow residual).
 */
export function isDottedPathIsrEligible(
  pages: ReadonlyArray<{ pattern: string; revalidate?: number }> | undefined,
  revalidate: number | Record<string, number> | undefined,
  pathRevalidate: Record<string, number> | undefined,
  pathname: string,
): boolean {
  if (pages && pages.length > 0) {
    for (const page of pages) {
      if (matchSegmentPattern(page.pattern, pathname)) {
        // `matchedPageTtl` resolves an inherit-eligible page against the per-path
        // config; a broad catch-all winner never certifies a dotted path as page
        // content (it also matches genuine static assets like `/robots.txt`).
        return matchedPageTtl(page, pathRevalidate, pathname) > 0 && !isBroadCatchAll(page.pattern);
      }
    }
    // no page matched → fall through to the flat map (mirror resolvePageTtl)
  }
  if (revalidate && typeof revalidate === 'object') {
    for (const [pattern, ttl] of Object.entries(revalidate)) {
      if (matchSegmentPattern(pattern, pathname)) {
        return ttl > 0 && !isBroadCatchAll(pattern);
      }
    }
  }
  return false;
}

/**
 * Build a normalized cache key Request for the edge cache (caches.default).
 * The public URL stays clean; the internal cache key carries the deployment
 * id so a new deploy never reads HTML produced by an older deploy.
 *
 * When `originalUrl` is provided (the request was dispatch-rewritten), it is
 * mixed into the key so direct and rewritten requests to the same rewritten
 * pathname do not share a cache slot. See `isrCacheKey` for rationale.
 */
export function isrEdgeCacheKey(
  request: Request,
  pathname: string,
  deploymentId: string,
  originalUrl?: string | null,
): Request {
  return new Request(
    isrEdgeCacheUrl(new URL(request.url).hostname, pathname, deploymentId, 'html', originalUrl),
    { method: 'GET' },
  );
}

/**
 * Build an edge cache key for the JSON variant (pages protocol navigation).
 * Uses `?__void=json` plus the deployment id to separate it from both HTML
 * and JSON generated by other deployments. `originalUrl` is mixed in under
 * the same rules as `isrEdgeCacheKey`.
 */
export function isrEdgeCacheKeyJson(
  request: Request,
  pathname: string,
  deploymentId: string,
  originalUrl?: string | null,
): Request {
  return new Request(
    isrEdgeCacheUrl(new URL(request.url).hostname, pathname, deploymentId, 'json', originalUrl),
    { method: 'GET' },
  );
}
