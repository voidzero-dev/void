/**
 * `images.remotePatterns` / `images.localPatterns` matching, ported from
 * Next.js 16 (`match-remote-pattern.js`, `match-local-pattern.js`).
 *
 * Next.js runs picomatch at request time. Void compiles every glob to a
 * `RegExp` source at config time (`compileRemotePattern` /
 * `compileLocalPattern` in `image-config.ts`, as Next's `writeImagesManifest`
 * does), so this module stays Worker- and browser-safe.
 */
import type { CompiledLocalPattern, CompiledRemotePattern } from './config.ts';

const compiled = new Map<string, RegExp>();

/** One `RegExp` per compiled source. The sources are anchored and have no `g` flag, so `test` is stateless. */
function toRegExp(source: string): RegExp {
  let re = compiled.get(source);
  if (!re) {
    re = new RegExp(source);
    compiled.set(source, re);
  }
  return re;
}

/** Whether `url` (a parsed absolute URL) matches one remote pattern. */
export function matchRemotePattern(pattern: CompiledRemotePattern, url: URL): boolean {
  if (pattern.protocol !== undefined) {
    if (pattern.protocol.replace(/:$/, '') !== url.protocol.replace(/:$/, '')) {
      return false;
    }
  }
  if (pattern.port !== undefined) {
    if (pattern.port !== url.port) {
      return false;
    }
  }
  if (pattern.hostname === undefined) {
    throw new Error(`Pattern should define hostname but found\n${JSON.stringify(pattern)}`);
  } else {
    if (!toRegExp(pattern.hostnameRe).test(url.hostname)) {
      return false;
    }
  }
  if (pattern.search !== undefined) {
    if (pattern.search !== url.search) {
      return false;
    }
  }
  if (!toRegExp(pattern.pathnameRe).test(url.pathname)) {
    return false;
  }
  return true;
}

/** Whether `url` matches `images.domains` (exact hostname) or any remote pattern. */
export function hasRemoteMatch(
  domains: ReadonlyArray<string>,
  remotePatterns: ReadonlyArray<CompiledRemotePattern>,
  url: URL,
): boolean {
  return (
    domains.some((domain) => url.hostname === domain) ||
    remotePatterns.some((p) => matchRemotePattern(p, url))
  );
}

/** Whether `url` (parsed against any base) matches one local pattern. */
export function matchLocalPattern(pattern: CompiledLocalPattern, url: URL): boolean {
  if (pattern.search !== undefined) {
    if (pattern.search !== url.search) {
      return false;
    }
  }
  if (!toRegExp(pattern.pathnameRe).test(url.pathname)) {
    return false;
  }
  return true;
}

/**
 * Whether a local `path?query` matches any local pattern. Without patterns
 * every local path is allowed (Next.js semantics; resolved configs always
 * carry the default `[{ pathname: '**', search: '' }]`).
 */
export function hasLocalMatch(
  localPatterns: ReadonlyArray<CompiledLocalPattern> | undefined,
  urlPathAndQuery: string,
): boolean {
  if (!localPatterns) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(urlPathAndQuery, 'http://n');
  } catch {
    // Next.js lets this throw. A value that is not a URL path matches nothing.
    return false;
  }
  return localPatterns.some((p) => matchLocalPattern(p, url));
}
