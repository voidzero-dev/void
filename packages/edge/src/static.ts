import type { AssetConfig } from '@void/deploy-core';

export type { AssetConfig } from '@void/deploy-core';

export type ResolvedAsset = Readonly<{
  path: string;
  hash: string;
  redirect?: string;
  notFound?: boolean;
  spa?: boolean;
}>;

/**
 * Percent-decode a request pathname for a manifest lookup, honoring required
 * URL encodings and encoded square brackets. Returns the raw value unchanged
 * on a malformed sequence (e.g. a lone `%`) or other over-encoded spellings.
 *
 * Request pathnames arrive percent-encoded — WHATWG `URL.pathname` never
 * decodes — but manifest keys are the asset's decoded on-disk path (a file
 * named `oxc masthead.riv` is stored under `/assets/oxc masthead.riv`, not
 * `%20`). Callers try the raw key first, then this decoded form.
 *
 * The decoded form is accepted only when re-encoding it reproduces the request
 * path (up to percent-escape letter case and square-bracket encoding). Next.js
 * encodes brackets in dynamic-page chunk URLs even though URL.pathname leaves
 * them literal. Other accepted escapes are characters a URL MUST encode
 * (space, `#`, non-ASCII, …). This rejects
 * over-encoded spellings of ordinary path text (`%2F`→`/`, `%61`→`a`, `%5F`→`_`,
 * `%2e%2e`→`..`), which a browser would never send and which would otherwise let
 * a request reconstruct a guarded path (`/assets%2Fx`, `/%61ssets/x`,
 * `/%5F%5Fvoid/x`) and serve the manifest entry while the raw-`url.pathname`
 * policy gates — the `/__void/*` reserved-route block, the hashed-asset prefix
 * gate, and the header/redirect rules — never fire. The URL pathname setter
 * applies exactly the WHATWG "path percent-encode set", making it the canonical
 * re-encoder.
 *
 * Known limitation: a file whose name contains a literal `%` (e.g. `logo%20.svg`,
 * requested as `logo%2520.svg`) is not resolved — the path encoder leaves `%`
 * as-is, so the round-trip can't reproduce the double-escaped request.
 */
export function safeDecodePathname(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
  if (decoded === pathname) {
    return pathname;
  }
  const canonical = reencodePathname(decoded);
  if (canonical === null) {
    return pathname;
  }
  // Compare up to percent-escape letter case: the URL encoder emits upper-case
  // (`%C3`), but a client may send lower-case (`%c3`), and both are valid.
  const normalized = normalizePercentCase(pathname).replace(/%5B/g, '[').replace(/%5D/g, ']');
  return normalizePercentCase(canonical) === normalized ? decoded : pathname;
}

/** Uppercase the hex digits of every `%xx` escape so encodings compare equal
 * regardless of the letter case a client used. */
function normalizePercentCase(pathname: string): string {
  return pathname.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
}

/**
 * Serialize a decoded path back to a safe URL pathname via the WHATWG "path
 * percent-encode set" (the `URL.pathname` setter). Returns null if the value
 * can't be encoded. Used to canonicalize the decoded lookup key and to make a
 * redirect Location URL-safe.
 */
function reencodePathname(pathname: string): string | null {
  try {
    const encoder = new URL('https://void.invalid/');
    encoder.pathname = pathname;
    return encoder.pathname;
  } catch {
    return null;
  }
}

/**
 * Match a pathname against the manifest via exact match + html_handling rules
 * (no not-found fallback). Returns null when nothing matches.
 */
function matchManifestEntry(
  pathname: string,
  manifest: Record<string, string>,
  htmlHandling: NonNullable<AssetConfig['html_handling']>,
): ResolvedAsset | null {
  // Exact match always wins
  if (manifest[pathname]) {
    return { path: pathname, hash: manifest[pathname] };
  }

  switch (htmlHandling) {
    case 'auto-trailing-slash': {
      // Try appending .html first (preferred over /index.html)
      const withHtml = pathname + '.html';
      if (manifest[withHtml]) {
        return { path: withHtml, hash: manifest[withHtml] };
      }
      // Try /index.html
      const withIndex = (pathname.endsWith('/') ? pathname : pathname + '/') + 'index.html';
      if (manifest[withIndex]) {
        return { path: withIndex, hash: manifest[withIndex] };
      }
      break;
    }
    case 'force-trailing-slash': {
      // If path doesn't end with /, redirect to trailing slash version
      if (!pathname.endsWith('/') && pathname !== '/') {
        const withIndex = pathname + '/index.html';
        if (manifest[withIndex]) {
          return {
            path: withIndex,
            hash: manifest[withIndex],
            redirect: pathname + '/',
          };
        }
      }
      // Serve /path/ from /path/index.html
      const indexPath = pathname + 'index.html';
      if (manifest[indexPath]) {
        return { path: indexPath, hash: manifest[indexPath] };
      }
      break;
    }
    case 'drop-trailing-slash': {
      // Root path: serve /index.html directly
      if (pathname === '/') {
        if (manifest['/index.html']) {
          return { path: '/index.html', hash: manifest['/index.html'] };
        }
        break;
      }
      // If path ends with /, redirect to non-trailing-slash version
      if (pathname.endsWith('/')) {
        const withoutSlash = pathname.slice(0, -1);
        const withHtml = withoutSlash + '.html';
        if (manifest[withHtml]) {
          return {
            path: withHtml,
            hash: manifest[withHtml],
            redirect: withoutSlash,
          };
        }
      }
      // Serve /path from /path.html
      const withHtml = pathname + '.html';
      if (manifest[withHtml]) {
        return { path: withHtml, hash: manifest[withHtml] };
      }
      break;
    }
    case 'none':
      break;
  }

  return null;
}

/**
 * Resolve a request pathname to a manifest entry using AssetConfig rules.
 * Replicates Cloudflare Workers Assets path resolution behavior.
 */
export function resolveStaticPath(
  pathname: string,
  manifest: Record<string, string>,
  config: AssetConfig,
): ResolvedAsset | null {
  const htmlHandling = config.html_handling ?? 'auto-trailing-slash';

  // Try the raw (percent-encoded) path first — the fast path, and it lets a
  // filename that literally contains a `%` win. On a miss, retry with the
  // decoded path so a file named e.g. `a b.txt` resolves for an `a%20b.txt`
  // request (manifest keys are decoded on-disk paths).
  let matched = matchManifestEntry(pathname, manifest, htmlHandling);
  if (!matched) {
    const decoded = safeDecodePathname(pathname);
    if (decoded !== pathname) {
      matched = matchManifestEntry(decoded, manifest, htmlHandling);
      if (matched?.redirect !== undefined) {
        // The Location was derived from the decoded path; serialize it back to
        // a safe URL pathname (`/docs/a#b/` → `/docs/a%23b/`) so the client
        // doesn't read `#`/space/etc. as URL structure.
        const safeRedirect = reencodePathname(matched.redirect);
        if (safeRedirect !== null) {
          matched = { ...matched, redirect: safeRedirect };
        }
      }
    }
  }
  if (matched) {
    return matched;
  }

  // Not found handling
  switch (config.not_found_handling ?? 'none') {
    case 'single-page-application':
      if (manifest['/index.html']) {
        return {
          path: '/index.html',
          hash: manifest['/index.html'],
          spa: true,
        };
      }
      break;
    case '404-page':
      if (manifest['/404.html']) {
        return {
          path: '/404.html',
          hash: manifest['/404.html'],
          notFound: true,
        };
      }
      break;
  }

  return null;
}

const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  toml: 'application/toml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

/**
 * Get the Content-Type header value for a given file path based on its extension.
 */
export function getContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve the Content-Type to serve for a stored asset, reconciling the value
 * persisted at upload time (R2 `httpMetadata.contentType` / KV `ct` metadata)
 * with a fresh path-based lookup. Returns `undefined` when no Content-Type
 * header should be emitted.
 *
 * `application/null` is a sentinel (matching Wrangler) meaning "omit the
 * Content-Type header entirely".
 *
 * `application/octet-stream` is the uploader's no-information default: older
 * CLI versions stamped it on any extension their MIME table did not recognize
 * (e.g. `.md`). Because assets are content-addressed and never re-uploaded,
 * those stale octet-stream values can't be corrected at the source, so we
 * treat a stored octet-stream as "unknown" and re-derive from the path here.
 * Any other stored value is authoritative and honored as-is.
 */
export function resolveAssetContentType(
  stored: string | null | undefined,
  path: string,
): string | undefined {
  if (stored === 'application/null') {
    return undefined;
  }
  if (!stored || stored === 'application/octet-stream') {
    return getContentType(path);
  }
  return stored;
}
