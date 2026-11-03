import { bytesToBase64 } from '../../runtime/base64.ts';
import { getImageExtension } from './content-type.ts';

/**
 * Seconds from an upstream `Cache-Control`: `s-maxage`, else `max-age`, else
 * `0` (Next.js `getMaxAge`). `no-store`, `private` and `no-cache` are ignored,
 * so the endpoint's `minimumCacheTTL` still applies.
 */
export function getMaxAge(cacheControl: string | null | undefined): number {
  const directives = new Map<string, string | undefined>();
  for (const directive of cacheControl ? cacheControl.split(',') : []) {
    const [key = '', value] = directive.trim().split('=', 2);
    directives.set(key.toLowerCase(), value?.toLowerCase());
  }
  let age = directives.get('s-maxage') || directives.get('max-age') || '';
  if (age.startsWith('"') && age.endsWith('"')) {
    age = age.slice(1, -1);
  }
  const seconds = parseInt(age, 10);
  return Number.isNaN(seconds) ? 0 : seconds;
}

const toBase64Url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** SHA-256 of `bytes`, base64url without padding (Next.js `getImageEtag`). */
export async function getImageEtag(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * The upstream `ETag` header encoded as base64url (so weak validators stay
 * opaque), or the SHA-256 of the body when the upstream sent none.
 */
export async function extractEtag(
  etag: string | null | undefined,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return etag ? toBase64Url(new TextEncoder().encode(etag)) : getImageEtag(bytes);
}

/**
 * Whether a conditional request can be answered with `304` for the opaque
 * entity tag `etag` (the `fresh` rules Next.js uses). Void sends the tag
 * quoted, so a quoted, unquoted or weak `If-None-Match` member matches;
 * `*` matches anything and `Cache-Control: no-cache` never does. The endpoint
 * sends no `Last-Modified`, so `If-Modified-Since` never makes a request fresh.
 */
export function isFreshRequest(headers: Headers, etag: string): boolean {
  const modifiedSince = headers.get('if-modified-since');
  const noneMatch = headers.get('if-none-match');
  if (!modifiedSince && !noneMatch) {
    return false;
  }
  const cacheControl = headers.get('cache-control');
  if (cacheControl && /(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(cacheControl)) {
    return false;
  }
  if (noneMatch && noneMatch.trim() !== '*') {
    const matches = noneMatch.split(',').some((member) => {
      let tag = member.trim();
      if (tag.startsWith('W/')) {
        tag = tag.slice(2);
      }
      if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) {
        tag = tag.slice(1, -1);
      }
      return tag === etag;
    });
    if (!matches) {
      return false;
    }
  }
  return !modifiedSince;
}

/**
 * The download name for a response: the last path segment of the source URL
 * up to its first dot, plus the served type's extension (`my.photo.png` as
 * WebP is `my.webp`). `image.bin` when the URL ends in `/`.
 */
export function getFileNameWithExtension(url: string, contentType: string): string {
  const [path = ''] = url.split('?', 1);
  const name = path.split('/').pop();
  if (!contentType || !name) {
    return 'image.bin';
  }
  const [base] = name.split('.', 1);
  return `${base}.${getImageExtension(contentType)}`;
}

const NON_LATIN1 = /[^\x20-\x7e\xa0-\xff]/g;
const QUOTED_TEXT = /^[\x20-\x7e\x80-\xff]+$/;
const HEX_ESCAPE = /%[0-9A-Fa-f]{2}/;
// oxlint-disable-next-line no-control-regex -- RFC 8187 percent-encodes control characters
const ATTRIBUTE_ESCAPES = /[\x00-\x20"'()*,/:;<=>?@[\\\]{}\x7f]/g;

/**
 * `Content-Disposition` for `fileName`, formatted like the `content-disposition`
 * package Next.js uses: a quoted `filename` with non-Latin-1 characters
 * replaced by `?`, plus an RFC 8187 `filename*` when that fallback differs,
 * the name is not plain text, or it contains `%XX` sequences.
 */
export function getContentDisposition(fileName: string, type: 'inline' | 'attachment'): string {
  const fallback = fileName.replace(NON_LATIN1, '?');
  const hasFallback = fallback !== fileName;
  const quotable = QUOTED_TEXT.test(fileName);
  let header = type;
  if (quotable || hasFallback) {
    header += `; filename="${(hasFallback ? fallback : fileName).replace(/([\\"])/g, '\\$1')}"`;
  }
  if (hasFallback || !quotable || HEX_ESCAPE.test(fileName)) {
    // A lone surrogate cannot be percent-encoded; its fallback still can.
    const encoded = encodeURIComponent(fileName.replace(/[\ud800-\udfff]/gu, '?')).replace(
      ATTRIBUTE_ESCAPES,
      (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
    );
    header += `; filename*=UTF-8''${encoded}`;
  }
  return header;
}
