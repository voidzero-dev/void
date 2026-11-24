/**
 * ISR cache keys and edge-cache URLs. Writers, readers, and purgers must build
 * byte-identical keys, so all of them use these helpers.
 *
 * Key shapes: `v3` = `<proj>/isr/v3/<D>/<host>/<path>[#rw=<token>]`;
 * `v2` = hostless `<proj>/isr/v2/<D>/<path>`, kept only to purge old entries.
 */

const ISR_CACHE_KEY_VERSION = 'v3';

/**
 * Hostless key version. Host scoping needed a new version: otherwise a hostless
 * key for `/example.com/about` would equal the host-scoped key for
 * (`example.com`, `/about`).
 */
const ISR_LEGACY_CACHE_KEY_VERSION = 'v2';

export type { IsrCacheMetadata } from './core.ts';

/**
 * Build the normalized path segment for an ISR-cached page.
 * Root path `/` maps to `__index__` to avoid trailing-slash ambiguity.
 */
export function normalizeIsrPath(pathname: string): string {
  let normalized = pathname;
  if (normalized === '/') {
    normalized = '__index__';
  } else {
    normalized = normalized.startsWith('/') ? normalized.slice(1) : normalized;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized;
}

/**
 * Inverse of `normalizeIsrPath`: turn a normalized segment back into a
 * pathname starting with `/`.
 */
export function denormalizeIsrPath(normalized: string): string {
  return normalized === '__index__' ? '/' : `/${normalized}`;
}

/**
 * Canonicalize an inbound pathname to the form used inside edge cache URLs.
 * Equivalent to `denormalizeIsrPath(normalizeIsrPath(pathname))` — strips any
 * trailing slash except for root.
 */
export function canonicalIsrPathname(pathname: string): string {
  return denormalizeIsrPath(normalizeIsrPath(pathname));
}

function versionedIsrCachePrefix(
  projectId: string,
  version: string,
  deploymentId: string | undefined,
): string {
  if (deploymentId !== undefined) {
    return `${projectId}/isr/${version}/${deploymentId}/`;
  }
  return `${projectId}/isr/`;
}

/**
 * Prefix for listing/purging ISR keys. An empty `deploymentId` still yields the
 * versioned prefix (`<projectId>/isr/v3//`), because writers may use an empty
 * id. Only `undefined` selects every key (`<projectId>/isr/`).
 */
export function isrCachePrefix(projectId: string, deploymentId?: string): string {
  return versionedIsrCachePrefix(projectId, ISR_CACHE_KEY_VERSION, deploymentId);
}

/**
 * Like `isrCachePrefix`, for hostless `v2` keys.
 *
 * @deprecated Void no longer writes hostless `v2` keys and does not use this
 * helper. Removed in the next major version.
 */
export function isrLegacyCachePrefix(projectId: string, deploymentId?: string): string {
  return versionedIsrCachePrefix(projectId, ISR_LEGACY_CACHE_KEY_VERSION, deploymentId);
}

/** `#` never appears in a request pathname, so it unambiguously marks the variant suffix. */
const ISR_VARIANT_SEPARATOR = '#rw=';

/**
 * KV key for an ISR-cached page: `<proj>/isr/v3/<D>/<host>/<path>`. Deployment
 * scoping keeps cached HTML from outliving its hashed assets; host scoping keeps
 * different hostnames apart. `host` is the request hostname.
 *
 * Pass `originalUrl` for a rewritten request (or a query variant). It adds a
 * `#rw=<token>` suffix, so a rewrite from `/docs` to `/en/docs` does not share
 * an entry with a direct hit on `/en/docs`.
 */
export function isrCacheKey(
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
  originalUrl?: string | null,
): string {
  const base = `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}`;
  if (!originalUrl) {
    return base;
  }
  return `${base}${ISR_VARIANT_SEPARATOR}${hashOriginalUrl(originalUrl)}`;
}

/** Prefix for listing/purging the `#rw=` variant keys of a pathname (not its direct-hit key). */
export function isrCacheVariantPrefix(
  projectId: string,
  deploymentId: string,
  host: string,
  pathname: string,
): string {
  return `${isrCachePrefix(projectId, deploymentId)}${host}/${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;
}

/**
 * Hostless `v2` direct-hit key for a pathname.
 *
 * @deprecated Void no longer writes hostless `v2` keys and does not use this
 * helper. Removed in the next major version.
 */
export function isrLegacyCacheKey(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${isrLegacyCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}`;
}

/**
 * Hostless `v2` rewrite-variant prefix for a pathname.
 *
 * @deprecated Void no longer writes hostless `v2` keys and does not use this
 * helper. Removed in the next major version.
 */
export function isrLegacyCacheVariantPrefix(
  projectId: string,
  deploymentId: string,
  pathname: string,
): string {
  return `${isrLegacyCachePrefix(projectId, deploymentId)}${normalizeIsrPath(pathname)}${ISR_VARIANT_SEPARATOR}`;
}

const FNV_OFFSET_BASIS = 0xcb_f2_9c_e4_84_22_23_25n;
const FNV_PRIME = 0x1_00_00_00_01_b3n;
const FNV_MASK = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/**
 * Hash an original URL into a 16-hex-char variant token (FNV-1a 64-bit), used
 * as both the KV-key suffix and the `__void_orig` edge-cache parameter. It is
 * sync so it fits every read/write path, and opaque so KV never exposes
 * original URLs or their query strings. Not cryptographic.
 */
export function hashOriginalUrl(originalUrl: string): string {
  const bytes = new TextEncoder().encode(originalUrl);
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i])) & FNV_MASK;
    h = (h * FNV_PRIME) & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Split an ISR KV key into its normalized path and its `#rw=` variant token
 * (`null` for a direct hit). Pass the token to `isrEdgeCacheUrlForToken` to
 * rebuild the matching edge-cache URL.
 */
export function splitIsrCacheKey(fullKey: string): {
  normalizedPath: string;
  variantToken: string | null;
} {
  const sepIdx = fullKey.indexOf(ISR_VARIANT_SEPARATOR);
  if (sepIdx === -1) {
    return { normalizedPath: fullKey, variantToken: null };
  }
  return {
    normalizedPath: fullKey.slice(0, sepIdx),
    variantToken: fullKey.slice(sepIdx + ISR_VARIANT_SEPARATOR.length),
  };
}

/**
 * Edge-cache (`caches.default`) URL for an ISR page. It carries the deployment
 * id so a new deploy never reads older HTML, and the `json` variant keeps
 * Pages-protocol JSON apart from HTML for the same path.
 */
export function isrEdgeCacheUrl(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  originalUrl?: string | null,
): string {
  return buildIsrEdgeCacheUrl(
    hostname,
    pathname,
    deploymentId,
    variant,
    originalUrl ? hashOriginalUrl(originalUrl) : null,
  );
}

/** Like `isrEdgeCacheUrl`, but takes a variant token from `splitIsrCacheKey`. */
export function isrEdgeCacheUrlForToken(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  variantToken?: string | null,
): string {
  return buildIsrEdgeCacheUrl(hostname, pathname, deploymentId, variant, variantToken ?? null);
}

function buildIsrEdgeCacheUrl(
  hostname: string,
  pathname: string,
  deploymentId: string,
  variant: 'html' | 'json',
  variantToken: string | null,
): string {
  const normalizedPathname = canonicalIsrPathname(pathname);
  const url = new URL(`https://${hostname}${normalizedPathname}`);
  if (variant === 'json') {
    url.searchParams.set('__void', 'json');
  }
  url.searchParams.set('__void_isr', deploymentId);
  if (variantToken) {
    url.searchParams.set('__void_orig', variantToken);
  }
  return url.toString();
}
