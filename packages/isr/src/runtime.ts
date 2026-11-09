import { matchSegmentPattern, PAGES_PROTOCOL_VERSION } from '@void/edge';
import {
  buildVariantOriginalUrl,
  decodeIsrCacheEntry,
  extractPageDataFromHtml,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  hasUnlistedQueryParams,
  isFrameworkDocumentRequest,
  isSharedCacheableResponse,
  isrCacheResponse,
  isStale,
  normalizePageDataForJsonCache,
  packIsrValue,
  markSharedCachePolicy,
  resolvePageTtl,
  resolveRevalidateTtl,
  SHARED_CACHE_POLICY_VERSION,
  SHARED_CACHE_POLICY_HEADER,
  serializeHeaders,
  shouldBypassIsr,
  type IsrCacheEntry,
  type IsrCacheMetadata,
  type QueryAllowlist,
} from './core.ts';
import { isrCacheKey, isrCachePrefix, isrCacheVariantPrefix, isrEdgeCacheUrl } from './index.ts';

export {
  extractPageDataFromHtml,
  hasCurrentSharedCachePolicy,
  hasSharedCacheOptOut,
  isSharedCacheableResponse,
  isrCacheResponse,
  isStale,
  normalizePageDataForJsonCache,
  packIsrValue,
  markSharedCachePolicy,
  resolvePathTtl,
  resolveRevalidateTtl,
  serializeHeaders,
  shouldBypassIsr,
  SHARED_CACHE_POLICY_HEADER,
  SHARED_CACHE_POLICY_VERSION,
  unpackIsrValue,
  type IsrCacheEntry,
  type IsrCacheMetadata,
} from './core.ts';
export { matchSegmentPattern as matchLiteralPattern };
export { canonicalIsrPathname, denormalizeIsrPath, normalizeIsrPath } from './index.ts';

/**
 * Single-tenant ISR cache for a direct Cloudflare Worker (Void apps and
 * framework deploy wrappers). Every `ISR_CACHE` (KV) and `caches.default`
 * operation fails open: read errors render live, write errors are ignored.
 * KV helpers read the deployment id from `env.__VOID_ISR_DEPLOYMENT_ID`;
 * edge-cache keys use the `deploymentId` option. Both hold the same value.
 */

/** Env fields ISR reads. Both are optional: without them ISR fails open. */
export interface IsrCacheEnv {
  ISR_CACHE?: KVNamespace;
  __VOID_ISR_DEPLOYMENT_ID?: string;
}

/** Renders a live response for a request (worker dispatch + asset serving). */
export type RenderFn = (request: Request) => Promise<Response>;

export type HandleIsrOptions = Readonly<{
  revalidate: number | Record<string, number> | undefined;
  pages?: ReadonlyArray<{ pattern: string; revalidate?: number }>;
  pathRevalidate?: Record<string, number>;
  deploymentId: string;
  queryAllowlist?: QueryAllowlist;
}>;

// Caps rewrite-variant entries per path, so random values of an allowlisted
// query param cannot grow KV without bound. Existing variants still update.
export const MAX_ISR_VARIANTS_PER_PATH = 200;
// Match managed ISR: tolerate removal responses for 24 hours after expiry.
const ISR_STALE_EVICT_GRACE_MS = 86_400_000;

const DIRECT_ISR_PROJECT_ID = '__void_direct__';

/** Prefix for the current direct deployment's host-scoped cache entries. */
export function isrPrefix(deploymentId: string): string {
  return isrCachePrefix(DIRECT_ISR_PROJECT_ID, deploymentId);
}

/**
 * KV key for an ISR-cached page, scoped by deployment (a new deploy starts with
 * a cold cache) and by host (custom domain, workers.dev, apex, and www stay apart).
 */
export function isrKey(
  deploymentId: string,
  host: string,
  pathname: string,
  variantUrl?: string | null,
): string {
  return isrCacheKey(DIRECT_ISR_PROJECT_ID, deploymentId, host, pathname, variantUrl);
}

export function isrVariantPrefix(deploymentId: string, host: string, pathname: string): string {
  return isrCacheVariantPrefix(DIRECT_ISR_PROJECT_ID, deploymentId, host, pathname);
}

/**
 * Host-registry key. Every host that writes cached content registers here, so a
 * purge without a request host (cron or queue `revalidate({ paths })`) can find
 * the hosts to purge.
 */
export function hostRegistryKey(deploymentId: string, host: string): string {
  return `void-isr-hosts/${deploymentId}/${host}`;
}

/**
 * Edge-cache (`caches.default`) key for the HTML variant. The public URL stays
 * clean; this internal key carries the deployment id so a new deploy never
 * reads HTML produced by an older deploy.
 */
export function htmlEdgeKey(
  host: string,
  pathname: string,
  id: string,
  variantUrl?: string | null,
): string {
  return isrEdgeCacheUrl(host, pathname, id, 'html', variantUrl);
}

/**
 * Edge-cache key for the JSON (pages-protocol) variant. Separated from HTML by
 * the `&__void=json` marker.
 */
export function jsonEdgeKey(
  host: string,
  pathname: string,
  id: string,
  variantUrl?: string | null,
): string {
  return isrEdgeCacheUrl(host, pathname, id, 'json', variantUrl);
}

/** Read an ISR entry from KV. Returns null on a miss, a malformed entry, or any KV error. */
export async function readIsrCache(
  env: IsrCacheEnv,
  host: string,
  pathname: string,
  variantUrl?: string | null,
): Promise<IsrCacheEntry | null> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return null;
  }
  const key = isrKey(env.__VOID_ISR_DEPLOYMENT_ID ?? '', host, pathname, variantUrl);
  let value: ArrayBuffer | null;
  let metadata: IsrCacheMetadata | null;
  try {
    const result = await kv.getWithMetadata<IsrCacheMetadata>(key, 'arrayBuffer');
    value = result.value;
    metadata = result.metadata;
  } catch {
    return null;
  }
  return decodeIsrCacheEntry(value, metadata);
}

/**
 * Write an ISR entry to KV. The response is cloned before any `await`, so the
 * caller can stream the original body to the client. KV errors are ignored.
 */
export async function writeIsrCache(
  env: IsrCacheEnv,
  host: string,
  pathname: string,
  response: Response,
  ttl: number,
  variantUrl?: string | null,
): Promise<void> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return;
  }
  const responseClone = response.clone();
  const headers = serializeHeaders(responseClone);
  const status = responseClone.status;

  const id = env.__VOID_ISR_DEPLOYMENT_ID ?? '';
  try {
    const key = isrKey(id, host, pathname, variantUrl);
    if (variantUrl && !(await isVariantWriteAllowed(kv, id, host, pathname, key))) {
      await registerIsrHost(kv, id, host);
      return;
    }
    const body = await responseClone.arrayBuffer();
    const packed = packIsrValue(headers, body);
    await kv.put(key, packed, {
      metadata: {
        s: status,
        c: Date.now(),
        t: ttl,
        p: SHARED_CACHE_POLICY_VERSION,
      } satisfies IsrCacheMetadata,
    });
  } catch {
    // Fail open.
  }
  await registerIsrHost(kv, id, host);
}

async function isVariantWriteAllowed(
  kv: KVNamespace,
  deploymentId: string,
  host: string,
  pathname: string,
  key: string,
): Promise<boolean> {
  const listed = await kv.list({
    prefix: isrVariantPrefix(deploymentId, host, pathname),
    limit: 1000,
  });
  return (
    listed.keys.length < MAX_ISR_VARIANTS_PER_PATH ||
    listed.keys.some((entry) => entry.name === key)
  );
}

/** `${id}/${host}` pairs this isolate has registered: one registry write per pair, not per page. */
const registeredHosts = new Set<string>();

async function registerIsrHost(kv: KVNamespace, deploymentId: string, host: string): Promise<void> {
  const guardKey = `${deploymentId}/${host}`;
  if (registeredHosts.has(guardKey)) {
    return;
  }
  // Mark before the await so concurrent writes skip the put; clear on failure so
  // a later write retries instead of leaving the host out of `listIsrHosts()`.
  registeredHosts.add(guardKey);
  try {
    await kv.put(hostRegistryKey(deploymentId, host), '');
  } catch {
    registeredHosts.delete(guardKey);
  }
}

/**
 * List every host registered for a deployment. A registry read error returns
 * the hosts collected so far instead of throwing.
 */
export async function listIsrHosts(kv: KVNamespace, deploymentId: string): Promise<Array<string>> {
  const prefix = `void-isr-hosts/${deploymentId}/`;
  const hosts: Array<string> = [];
  try {
    let cursor: string | undefined;
    do {
      const list = await kv.list({ prefix, cursor });
      for (const key of list.keys) {
        hosts.push(key.name.slice(prefix.length));
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  } catch {
    // Fail open.
  }
  return hosts;
}

/** Delete an ISR entry from KV (for example after `x-revalidate: 0`). KV errors are ignored. */
export async function deleteIsrCache(
  env: IsrCacheEnv,
  host: string,
  pathname: string,
  variantUrl?: string | null,
): Promise<void> {
  const kv = env.ISR_CACHE;
  if (!kv) {
    return;
  }
  try {
    await kv.delete(isrKey(env.__VOID_ISR_DEPLOYMENT_ID ?? '', host, pathname, variantUrl));
  } catch {
    // Fail open.
  }
}

const CLIENT_REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export function clientRevalidateResponse(response: Response): Response {
  const res = new Response(response.body, response);
  res.headers.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
  res.headers.delete(SHARED_CACHE_POLICY_HEADER);
  return res;
}

function mediaType(response: Response): string | undefined {
  return response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim();
}

export function isEventStreamResponse(response: Response): boolean {
  return mediaType(response) === 'text/event-stream';
}

function isHtmlResponse(response: Response): boolean {
  return mediaType(response) === 'text/html';
}

/** Whether a fresh render may be written to the shared KV and edge caches. */
function isStorableRender(response: Response, ttl: number, htmlOnly: boolean): boolean {
  return ttl > 0 && isSharedCacheableResponse(response) && (!htmlOnly || isHtmlResponse(response));
}

/** Whether a successful render opts out of sharing, so cached copies must go. */
function isUncacheableRender(response: Response, ttl: number, htmlOnly: boolean): boolean {
  return (
    response.status === 200 &&
    (ttl === 0 || hasSharedCacheOptOut(response) || (htmlOnly && !isHtmlResponse(response)))
  );
}

/** Headers for a shared HTML cache copy, without ISR-managed or private headers. */
function sharedHtmlCacheHeaders(response: Response, ttl: number, state: 'HIT' | 'MISS'): Headers {
  const headers = new Headers(response.headers);
  headers.set('x-isr-cache', state);
  headers.set('Cache-Control', `public, s-maxage=${ttl}, max-age=0, must-revalidate`);
  markSharedCachePolicy(headers);
  headers.delete('set-cookie');
  headers.delete('x-void-page-data');
  return headers;
}

function jsonCacheResponse(pageData: string, ttl: number, state: 'HIT' | 'MISS'): Response {
  const response = new Response(pageData, {
    headers: {
      'content-type': 'application/json',
      // Match the live Pages JSON response: the client parses JSON only when
      // `X-VoidPages` is present, and otherwise reloads the whole page.
      'X-VoidPages': 'true',
      'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
      Vary: 'X-VoidPages, X-VoidPages-Version',
      'Cache-Control': `public, s-maxage=${ttl}, max-age=0, must-revalidate`,
      'x-isr-cache': state,
    },
  });
  markSharedCachePolicy(response.headers);
  return response;
}

/**
 * Fill the JSON edge cache from a response's page data (the `x-void-page-data`
 * header or the `__VOID_PAGE_DATA__` script). Does nothing without page data;
 * cache errors are ignored.
 */
export async function populateJsonEdgeCache(
  cache: Cache | undefined,
  cacheKey: string,
  response: Response,
  ttl: number,
  state: 'HIT' | 'MISS',
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    const fromHeader = response.headers.get('x-void-page-data');
    const pageData = fromHeader
      ? normalizePageDataForJsonCache(fromHeader)
      : extractPageDataFromHtml(await response.clone().text());
    if (!pageData) {
      return;
    }
    await cache.put(cacheKey, jsonCacheResponse(pageData, ttl, state));
  } catch {
    // Fail open.
  }
}

/** `caches.default`, or `undefined` when reading it throws (for example, with no Cache API). */
function edgeCache(): Cache | undefined {
  try {
    return caches.default;
  } catch {
    return undefined;
  }
}

async function safeCachePut(
  cache: Cache | undefined,
  key: string,
  response: Response,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, response);
  } catch {
    // Fail open.
  }
}

async function safeCacheDelete(cache: Cache | undefined, key: string): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.delete(key);
  } catch {
    // Fail open.
  }
}

async function deleteSharedIsrVariants(
  env: IsrCacheEnv,
  cache: Cache | undefined,
  host: string,
  pathname: string,
  keys: { htmlKey: string; jsonKey: string },
  variantUrl: string | null,
): Promise<void> {
  await deleteIsrCache(env, host, pathname, variantUrl);
  await safeCacheDelete(cache, keys.htmlKey);
  await safeCacheDelete(cache, keys.jsonKey);
}

/** Copy a request without its Pages protocol headers. */
export function cloneWithoutVoidPages(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('X-VoidPages');
  headers.delete('X-VoidPages-Version');
  // Construct from the Request, not its URL string, so workerd keeps `request.cf`.
  return new Request(request, { headers });
}

/**
 * Re-render a stale page in the background and refresh KV and the edge cache.
 * Errors are logged and the stale entry keeps serving. An explicit cache
 * opt-out (including `ttl === 0`) deletes the KV entry and both edge variants.
 */
async function revalidateInBackground(
  env: IsrCacheEnv,
  request: Request,
  host: string,
  pathname: string,
  defaultTtl: number,
  keys: { htmlKey: string; jsonKey: string },
  render: RenderFn,
  variantUrl: string | null,
  htmlOnly: boolean,
  staleSinceMs: number,
): Promise<void> {
  try {
    const response = await render(request);
    const ttl = resolveRevalidateTtl(response, defaultTtl);
    const cache = edgeCache();
    if (response.status === 200 && isEventStreamResponse(response)) {
      if (isUncacheableRender(response, ttl, false)) {
        await deleteSharedIsrVariants(env, cache, host, pathname, keys, variantUrl);
      }
      return;
    }
    if (isStorableRender(response, ttl, htmlOnly)) {
      await writeIsrCache(env, host, pathname, response, ttl, variantUrl);
      await safeCachePut(
        cache,
        keys.htmlKey,
        new Response(response.clone().body, {
          status: response.status,
          headers: sharedHtmlCacheHeaders(response, ttl, 'HIT'),
        }),
      );
      if (!htmlOnly) {
        await populateJsonEdgeCache(cache, keys.jsonKey, response, ttl, 'HIT');
      }
    } else if (
      isUncacheableRender(response, ttl, htmlOnly) ||
      ((response.status === 404 || response.status === 410) &&
        Date.now() - staleSinceMs > ISR_STALE_EVICT_GRACE_MS)
    ) {
      // Preserve the last good render during transient failures. Confirmed
      // removals converge after the grace measured from expiry, not creation.
      await deleteSharedIsrVariants(env, cache, host, pathname, keys, variantUrl);
    }
  } catch (err) {
    console.error('ISR revalidation failed:', err);
  }
}

/** Cache only framework document HTML; leave client data requests and other response types live. */
export async function handleFrameworkIsr(
  request: Request,
  env: IsrCacheEnv,
  ctx: ExecutionContext,
  options: HandleIsrOptions,
  render: RenderFn,
): Promise<Response | null> {
  if (!isFrameworkDocumentRequest(request)) {
    return null;
  }
  return handleIsrInternal(request, env, ctx, options, render, true);
}

/**
 * Run the ISR cache ladder for a request. Returns the response to send, or
 * `null` when the caller should render live: the request is not eligible
 * (not GET, `/api`, Range, `shouldBypassIsr`, or no TTL), a cache read failed,
 * or a miss carries query params outside the allowlist.
 *
 * Pages-protocol (`X-VoidPages`) requests read only the JSON edge cache, and a
 * miss renders live without caching; HTML renders fill the JSON variant. HTML
 * requests read the edge cache, then KV. A stale hit is served while it
 * revalidates in the background, and a cacheable miss fills KV and the edge
 * cache in the background.
 */
export async function handleIsr(
  request: Request,
  env: IsrCacheEnv,
  ctx: ExecutionContext,
  options: HandleIsrOptions,
  render: RenderFn,
): Promise<Response | null> {
  return handleIsrInternal(request, env, ctx, options, render, false);
}

async function handleIsrInternal(
  request: Request,
  env: IsrCacheEnv,
  ctx: ExecutionContext,
  options: HandleIsrOptions,
  render: RenderFn,
  htmlOnly: boolean,
): Promise<Response | null> {
  const { revalidate, pages, pathRevalidate, deploymentId, queryAllowlist } = options;

  if (request.method !== 'GET') {
    return null;
  }
  // A partial 206 must never read or replace the shared full-response entry.
  if (request.headers.has('range')) {
    return null;
  }
  if (shouldBypassIsr(request)) {
    return null;
  }

  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return null;
  }
  const isrTtl = resolvePageTtl(pages, revalidate, pathRevalidate, pathname);
  if (isrTtl <= 0) {
    return null;
  }

  // KV helpers and `revalidate()` read the id from env; fill it for callers
  // that pass only the option.
  env.__VOID_ISR_DEPLOYMENT_ID ??= deploymentId;

  const host = url.hostname;
  const normalizedVariantUrl = buildVariantOriginalUrl(request.url, pathname, queryAllowlist);
  const variantUrl = new URL(normalizedVariantUrl).search ? normalizedVariantUrl : null;
  // The key drops these params, but a render may still read them. Never store
  // such a render under the shared key.
  const unlisted = hasUnlistedQueryParams(request.url, pathname, queryAllowlist);
  const cache = edgeCache();
  const htmlKey = htmlEdgeKey(host, pathname, deploymentId, variantUrl);
  const jsonKey = jsonEdgeKey(host, pathname, deploymentId, variantUrl);

  // Pages protocol: JSON edge cache only (cold colo re-renders JSON).
  if (request.headers.has('X-VoidPages')) {
    // The app decides how to serve older clients. A cached rich payload would
    // bypass its reload response; a legacy request must not evict the new cache.
    if (request.headers.get('X-VoidPages-Version') !== PAGES_PROTOCOL_VERSION) {
      return render(request);
    }
    let jsonCached: Response | undefined;
    try {
      jsonCached = await cache?.match(jsonKey);
    } catch {
      return null; // fail open → caller renders live
    }
    if (jsonCached && hasCurrentSharedCachePolicy(jsonCached)) {
      return clientRevalidateResponse(jsonCached);
    }
    if (jsonCached) {
      await safeCacheDelete(cache, jsonKey);
    }
    const response = await render(request);
    const ttl = resolveRevalidateTtl(response, isrTtl);
    if (isUncacheableRender(response, ttl, false)) {
      ctx.waitUntil(
        deleteSharedIsrVariants(env, cache, host, pathname, { htmlKey, jsonKey }, variantUrl),
      );
    }
    return response;
  }

  // HTML path: L1 edge → L2 KV → live render.

  // L1: edge cache (per-colo, sub-ms).
  let edgeCached: Response | undefined;
  try {
    edgeCached = await cache?.match(htmlKey);
  } catch {
    return null; // fail open → caller renders live
  }
  if (edgeCached && hasCurrentSharedCachePolicy(edgeCached)) {
    return clientRevalidateResponse(edgeCached);
  }
  if (edgeCached) {
    await safeCacheDelete(cache, htmlKey);
  }

  // L2: KV (global, authoritative). `readIsrCache` fails open to null.
  const cached = await readIsrCache(env, host, pathname, variantUrl);
  if (cached) {
    try {
      const stale = isStale(cached);
      if (stale) {
        ctx.waitUntil(
          revalidateInBackground(
            env,
            // Refresh from the key's own URL, not the triggering one.
            unlisted
              ? new Request(normalizedVariantUrl, {
                  method: request.method,
                  headers: request.headers,
                  cf: request.cf,
                })
              : request,
            host,
            pathname,
            isrTtl,
            { htmlKey, jsonKey },
            render,
            variantUrl,
            htmlOnly,
            cached.createdAt + cached.ttl * 1000,
          ),
        );
      }
      const cacheResponse = isrCacheResponse(cached, stale);
      // A stale entry is being replaced or evicted by revalidation. Warming it
      // concurrently can race an authoritative private/no-store response and
      // restore stale public HTML after that response deletes the cache.
      if (!stale) {
        ctx.waitUntil(safeCachePut(cache, htmlKey, cacheResponse.clone()));
      }
      return clientRevalidateResponse(cacheResponse);
    } catch {
      return null; // fail open → caller renders live
    }
  }

  // Miss: render live, cache in the background (only when cacheable). A URL
  // with params outside the allowlist renders live without filling the cache.
  if (unlisted) {
    return null;
  }
  const response = await render(request);
  if (isEventStreamResponse(response)) {
    return response;
  }
  const ttl = resolveRevalidateTtl(response, isrTtl);
  if (isStorableRender(response, ttl, htmlOnly)) {
    // Every clone below is taken synchronously (before `response.body` is read
    // for the client) so no consumer races the body away.
    ctx.waitUntil(writeIsrCache(env, host, pathname, response, ttl, variantUrl));
    if (!htmlOnly) {
      ctx.waitUntil(populateJsonEdgeCache(cache, jsonKey, response, ttl, 'HIT'));
    }

    const cacheResponse = new Response(response.clone().body, {
      status: response.status,
      headers: sharedHtmlCacheHeaders(response, ttl, 'HIT'),
    });
    ctx.waitUntil(safeCachePut(cache, htmlKey, cacheResponse));

    const clientHeaders = sharedHtmlCacheHeaders(response, ttl, 'MISS');
    clientHeaders.set('Cache-Control', CLIENT_REVALIDATE_CACHE_CONTROL);
    clientHeaders.delete(SHARED_CACHE_POLICY_HEADER);
    return new Response(response.body, {
      status: response.status,
      headers: clientHeaders,
    });
  }
  if (isUncacheableRender(response, ttl, htmlOnly)) {
    ctx.waitUntil(
      deleteSharedIsrVariants(env, cache, host, pathname, { htmlKey, jsonKey }, variantUrl),
    );
  }
  return response;
}
