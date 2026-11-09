import { matchLiteralPattern, matchSegmentPattern } from '@void/edge';

/**
 * Bump when a cached response accepted by an older writer can no longer be
 * proven safe to share. Readers reject entries from earlier policies instead
 * of replaying opaque bodies whose private headers were stripped at write time.
 */
export const SHARED_CACHE_POLICY_VERSION = 3 as const;
export const SHARED_CACHE_POLICY_HEADER = 'x-void-shared-cache-policy';

/** Stamp an internal edge-cache representation with the policy that admitted it. */
export function markSharedCachePolicy(headers: Headers): void {
  headers.set(SHARED_CACHE_POLICY_HEADER, String(SHARED_CACHE_POLICY_VERSION));
}

/** Reject opaque edge entries admitted before the current privacy policy. */
export function hasCurrentSharedCachePolicy(response: Response): boolean {
  return response.headers.get(SHARED_CACHE_POLICY_HEADER) === String(SHARED_CACHE_POLICY_VERSION);
}

/**
 * KV metadata stored with every ISR cache entry. Writers should annotate it with
 * `satisfies IsrCacheMetadata` so a renamed field fails typecheck.
 */
export type IsrCacheMetadata = Readonly<{
  /** HTTP status code. */
  s: number;
  /** Creation time in milliseconds since the Unix epoch. */
  c: number;
  /** Freshness lifetime in seconds. */
  t: number;
  /** Shared-response privacy policy version. */
  p: typeof SHARED_CACHE_POLICY_VERSION;
}>;

export type IsrCacheEntry = Readonly<{
  body: ReadableStream;
  status: number;
  headers: Record<string, string>;
  createdAt: number;
  ttl: number;
}>;

const PAGE_DATA_SCRIPT_RE =
  /<script\b[^>]*\bid=(["'])__VOID_PAGE_DATA__\1[^>]*>([\s\S]*?)<\/script>/i;
const SKIP_HEADERS = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

/** Map of literal path pattern to the query names retained in an ISR cache variant. */
export type QueryAllowlist = Record<string, ReadonlyArray<string>>;

/**
 * Normalize a request URL for cache-key use by retaining only query parameters
 * explicitly allowlisted for its user-facing pathname.
 */
export function buildVariantOriginalUrl(
  requestUrl: string,
  pathname: string,
  queryAllowlist: QueryAllowlist | undefined,
): string {
  const url = new URL(requestUrl);
  if (!url.search) {
    return url.toString();
  }
  const allowed = resolveQueryAllowlist(queryAllowlist, pathname);
  if (allowed.size === 0) {
    url.search = '';
    return url.toString();
  }
  const keys = [...new Set(url.searchParams.keys())].filter((key) => allowed.has(key)).sort();
  const filtered = new URLSearchParams();
  for (const key of keys) {
    for (const value of url.searchParams.getAll(key)) {
      filtered.append(key, value);
    }
  }
  const filteredString = filtered.toString();
  url.search = filteredString ? `?${filteredString}` : '';
  return url.toString();
}

/**
 * True when the request carries a query parameter that the cache key leaves
 * out. A render made from such a URL may depend on that parameter, so it must
 * not be stored under the shared key.
 */
export function hasUnlistedQueryParams(
  requestUrl: string,
  pathname: string,
  allowlist: QueryAllowlist | undefined,
): boolean {
  const url = new URL(requestUrl);
  if (!url.search) {
    return false;
  }
  const allowed = resolveQueryAllowlist(allowlist, pathname);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return true;
    }
  }
  return false;
}

/** Keep only exact allowlist patterns for uncapped static-cache consumers. */
export function exactQueryAllowlist(
  allowlist: QueryAllowlist | undefined,
): QueryAllowlist | undefined {
  if (!allowlist) {
    return undefined;
  }
  const exact = Object.fromEntries(
    Object.entries(allowlist).filter(([pattern]) => !pattern.includes('*')),
  );
  return Object.keys(exact).length > 0 ? exact : undefined;
}

function resolveQueryAllowlist(
  allowlist: QueryAllowlist | undefined,
  pathname: string,
): Set<string> {
  if (!allowlist) {
    return new Set();
  }
  for (const [pattern, params] of Object.entries(allowlist)) {
    if (matchLiteralPattern(pattern, pathname)) {
      return new Set(params);
    }
  }
  return new Set();
}

/** Pack response headers and body into the canonical ISR binary value. */
export function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/** Unpack a canonical ISR binary value, returning null for malformed bytes. */
export function unpackIsrValue(
  buffer: ArrayBuffer,
): { headers: Record<string, string>; body: ArrayBuffer } | null {
  if (buffer.byteLength < 4) {
    return null;
  }
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0, true);
  if (buffer.byteLength < 4 + headerLength) {
    return null;
  }
  try {
    const headerBytes = new Uint8Array(buffer, 4, headerLength);
    const parsed = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        return null;
      }
      headers[name] = value;
    }
    return { headers, body: buffer.slice(4 + headerLength) };
  } catch {
    return null;
  }
}

/** Decode and validate a KV value plus metadata into a safe cache entry. */
export function decodeIsrCacheEntry(
  value: ArrayBuffer | null,
  metadata: IsrCacheMetadata | null,
): IsrCacheEntry | null {
  if (!value || !metadata) {
    return null;
  }
  const unpacked = unpackIsrValue(value);
  if (!unpacked) {
    return null;
  }
  if (!Number.isInteger(metadata.s) || metadata.s < 200 || metadata.s > 599) {
    return null;
  }
  if (
    !Number.isFinite(metadata.c) ||
    metadata.c <= 0 ||
    !Number.isFinite(metadata.t) ||
    metadata.t <= 0 ||
    metadata.p !== SHARED_CACHE_POLICY_VERSION
  ) {
    return null;
  }
  try {
    new Headers(unpacked.headers);
  } catch {
    return null;
  }
  return {
    body: new ReadableStream({
      start(controller): void {
        controller.enqueue(new Uint8Array(unpacked.body));
        controller.close();
      },
    }),
    status: metadata.s,
    headers: unpacked.headers,
    createdAt: metadata.c,
    ttl: metadata.t,
  };
}

/** Check whether an ISR cache entry has passed its freshness lifetime. */
export function isStale(entry: IsrCacheEntry, now: number = Date.now()): boolean {
  return now - entry.createdAt > entry.ttl * 1000;
}

/** Build an edge-cacheable response from a validated ISR cache entry. */
export function isrCacheResponse(
  entry: IsrCacheEntry,
  stale: boolean,
  now: number = Date.now(),
): Response {
  const headers = new Headers(entry.headers);
  headers.set('x-isr-cache', stale ? 'STALE' : 'HIT');
  if (stale) {
    headers.set(
      'Cache-Control',
      `public, s-maxage=${Math.min(10, entry.ttl)}, max-age=0, must-revalidate`,
    );
  } else {
    const remainingSeconds = Math.max(
      0,
      Math.floor((entry.createdAt + entry.ttl * 1000 - now) / 1000),
    );
    headers.set(
      'Cache-Control',
      `public, s-maxage=${remainingSeconds}, max-age=0, must-revalidate`,
    );
  }
  markSharedCachePolicy(headers);
  return new Response(entry.body, { status: entry.status, headers });
}

/** Resolve an x-revalidate override, falling back for absent or invalid values. */
export function resolveRevalidateTtl(response: Response, defaultTtl: number): number {
  const header = response.headers.get('x-revalidate');
  if (header === null) {
    return defaultTtl;
  }
  const value = Number.parseInt(header, 10);
  return Number.isNaN(value) || value < 0 ? defaultTtl : value;
}

function acceptsEventStream(request: Request): boolean {
  return (
    request.headers
      .get('Accept')
      ?.toLowerCase()
      .split(',')
      .some((part) => part.split(';', 1)[0]?.trim() === 'text/event-stream') ?? false
  );
}

/** Return whether credentials or EventSource semantics require an ISR bypass. */
export function shouldBypassIsr(request: Request): boolean {
  return (
    request.headers.has('Cookie') ||
    request.headers.has('Authorization') ||
    request.headers.has('Cf-Access-Jwt-Assertion') ||
    acceptsEventStream(request)
  );
}

/** Only document navigations may read a framework's shared HTML cache. */
export function isFrameworkDocumentRequest(request: Request): boolean {
  if (request.method !== 'GET' || request.headers.has('X-VoidPages')) {
    return false;
  }
  if (new URL(request.url).pathname.startsWith('/__void/')) {
    return false;
  }
  const acceptsHtml = request.headers
    .get('accept')
    ?.split(',')
    .some((value) => value.trim().toLowerCase().split(';', 1)[0] === 'text/html');
  if (!acceptsHtml) {
    return false;
  }
  const mode = request.headers.get('sec-fetch-mode')?.toLowerCase();
  if (mode && mode !== 'navigate') {
    return false;
  }
  const destination = request.headers.get('sec-fetch-dest')?.toLowerCase();
  if (destination && destination !== 'document') {
    return false;
  }
  if (request.headers.has('rsc') || request.headers.has('x-nextjs-data')) {
    return false;
  }
  return true;
}

/** Return whether a response explicitly forbids storage in a shared cache. */
export function hasSharedCacheOptOut(response: Response): boolean {
  // Only the Pages protocol has a separate cache representation. Every other
  // header-dependent response must render live, including Vary: *.
  if (
    response.headers
      .get('Vary')
      ?.split(',')
      .some((name) => {
        const header = name.trim().toLowerCase();
        return header !== '' && header !== 'x-voidpages' && header !== 'x-voidpages-version';
      })
  ) {
    return true;
  }
  if (response.headers.has('Set-Cookie')) {
    return true;
  }
  const cacheControl = response.headers.get('Cache-Control');
  if (!cacheControl) {
    return false;
  }
  return cacheControl.split(',').some((part) => {
    const directive = part.split('=', 1)[0]?.trim().toLowerCase();
    return directive === 'private' || directive === 'no-store' || directive === 'no-cache';
  });
}

/** Return whether a complete render may be persisted in the shared ISR cache. */
export function isSharedCacheableResponse(response: Response): boolean {
  return response.status === 200 && !hasSharedCacheOptOut(response);
}

/** Resolve the first matching path TTL using Void route-pattern semantics. */
export function resolvePathTtl(
  revalidate: number | Record<string, number> | undefined,
  pathname: string,
): number {
  if (revalidate == null) {
    return 0;
  }
  if (typeof revalidate === 'number') {
    return revalidate;
  }
  for (const [pattern, ttl] of Object.entries(revalidate)) {
    if (matchSegmentPattern(pattern, pathname)) {
      return ttl;
    }
  }
  return 0;
}

/** One ordered page-route entry in the shared ISR TTL policy. */
export type IsrPageTtl = Readonly<{ pattern: string; revalidate?: number }>;

/**
 * Resolve ISR TTL from the framework's ordered page table.
 *
 * The first matching page is authoritative. A baked positive TTL enables ISR,
 * a baked `0` opts out, and an absent TTL inherits from the raw per-path config.
 * Only requests that match no page fall back to the flattened revalidate config.
 */
export function resolvePageTtl(
  pages: ReadonlyArray<IsrPageTtl> | undefined,
  revalidate: number | Record<string, number> | undefined,
  pathRevalidate: Record<string, number> | undefined,
  pathname: string,
): number {
  if (pages) {
    for (const page of pages) {
      if (!matchSegmentPattern(page.pattern, pathname)) {
        continue;
      }
      return page.revalidate === undefined
        ? resolvePathTtl(pathRevalidate, pathname)
        : page.revalidate > 0
          ? page.revalidate
          : 0;
    }
  }
  return resolvePathTtl(revalidate, pathname);
}

/** Extract response headers while removing ISR-managed and private headers. */
export function serializeHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  });
  return result;
}

/** Validate page data before storing it as the JSON ISR variant. */
export function normalizePageDataForJsonCache(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { deferred?: unknown; deferredKeys?: unknown };
    return parsed.deferred === undefined && parsed.deferredKeys === undefined ? raw : null;
  } catch {
    return null;
  }
}

/** Extract validated Void Pages data embedded in an HTML response. */
export function extractPageDataFromHtml(html: string): string | null {
  const match = html.match(PAGE_DATA_SCRIPT_RE);
  return match ? normalizePageDataForJsonCache(match[2]!) : null;
}
