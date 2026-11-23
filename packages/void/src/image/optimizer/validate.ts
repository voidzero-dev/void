import type { ResolvedImageConfig } from '../config.ts';
import { hasLocalMatch, hasRemoteMatch } from '../patterns.ts';
import { NOT_ALLOWED } from './image-error.ts';

/** Validated `/_void/image` query parameters. */
export type ImageParams = {
  /** The local path (as requested) or the normalized absolute URL. */
  href: string;
  isAbsolute: boolean;
  width: number;
  quality: number;
};

export type ImageParamsResult = ImageParams | { errorMessage: string };

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `/\/_void\/image($|\/)/` for the default path: a local source may not point back at the endpoint. */
function recursionPattern(path: string): RegExp {
  return new RegExp(`${escapeRegExp(path.replace(/\/+$/, ''))}($|/)`);
}

/** Single value of a query key; `string[]` when it repeats (as Node's query parser reports it). */
function queryValue(query: URLSearchParams, key: string): string | Array<string> {
  const values = query.getAll(key);
  return values.length > 1 ? values : (values[0] ?? '');
}

/**
 * Validate `url`, `w` and `q` in Next.js's order with its exact messages
 * (`ImageOptimizerCache.validateParams`). Every `q` format check runs before
 * the width allow-list; the quality range and allow-list run last.
 *
 * Differences from Next.js: a malformed `%` sequence in a local path is
 * `"url" parameter is invalid` instead of a 500; a local path whose origin
 * changes when resolved (`/\host`) is treated as protocol-relative; and there
 * is no development allowance for `w <= 8` / `q=70`, which only Next.js's blur
 * placeholder requests.
 */
export function validateImageParams(
  query: URLSearchParams,
  config: Pick<
    ResolvedImageConfig,
    'allSizes' | 'qualities' | 'localPatterns' | 'remotePatterns' | 'domains' | 'path'
  >,
): ImageParamsResult {
  const url = queryValue(query, 'url');
  const w = queryValue(query, 'w');
  const q = queryValue(query, 'q');
  if (!url) {
    return { errorMessage: '"url" parameter is required' };
  } else if (Array.isArray(url)) {
    return { errorMessage: '"url" parameter cannot be an array' };
  }
  if (url.length > 3072) {
    return { errorMessage: '"url" parameter is too long' };
  }
  if (url.startsWith('//')) {
    return { errorMessage: '"url" parameter cannot be a protocol-relative URL (//)' };
  }
  let href: string;
  let isAbsolute: boolean;
  if (url.startsWith('/')) {
    href = url;
    isAbsolute = false;
    let pathname: string;
    try {
      const parsed = new URL(url, 'http://n');
      if (parsed.origin !== 'http://n') {
        return { errorMessage: '"url" parameter cannot be a protocol-relative URL (//)' };
      }
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      return { errorMessage: '"url" parameter is invalid' };
    }
    if (recursionPattern(config.path).test(pathname)) {
      return { errorMessage: '"url" parameter cannot be recursive' };
    }
    if (!hasLocalMatch(config.localPatterns, url)) {
      return { errorMessage: NOT_ALLOWED };
    }
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { errorMessage: '"url" parameter is invalid' };
    }
    href = parsed.toString();
    isAbsolute = true;
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { errorMessage: '"url" parameter is invalid' };
    }
    if (!hasRemoteMatch(config.domains, config.remotePatterns, parsed)) {
      return { errorMessage: NOT_ALLOWED };
    }
  }
  if (!w) {
    return { errorMessage: '"w" parameter (width) is required' };
  } else if (Array.isArray(w)) {
    return { errorMessage: '"w" parameter (width) cannot be an array' };
  } else if (!/^[0-9]+$/.test(w)) {
    return { errorMessage: '"w" parameter (width) must be an integer greater than 0' };
  }
  if (!q) {
    return { errorMessage: '"q" parameter (quality) is required' };
  } else if (Array.isArray(q)) {
    return { errorMessage: '"q" parameter (quality) cannot be an array' };
  } else if (!/^[0-9]+$/.test(q)) {
    return { errorMessage: '"q" parameter (quality) must be an integer between 1 and 100' };
  }
  const width = parseInt(w, 10);
  if (width <= 0 || Number.isNaN(width)) {
    return { errorMessage: '"w" parameter (width) must be an integer greater than 0' };
  }
  if (!config.allSizes.includes(width)) {
    return { errorMessage: `"w" parameter (width) of ${width} is not allowed` };
  }
  const quality = parseInt(q, 10);
  if (Number.isNaN(quality) || quality < 1 || quality > 100) {
    return { errorMessage: '"q" parameter (quality) must be an integer between 1 and 100' };
  }
  if (!config.qualities.includes(quality)) {
    return { errorMessage: `"q" parameter (quality) of ${q} is not allowed` };
  }
  return { href, isAbsolute, width, quality };
}
