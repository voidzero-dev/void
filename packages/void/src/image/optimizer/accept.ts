import { AVIF_MAX_WIDTH, type ImageFormat } from '../config.ts';

/** Media types an `Accept` header lists explicitly with `q > 0`, lowercased. Wildcards never count. */
function acceptedTypes(accept: string): Set<string> {
  const types = new Set<string>();
  for (const entry of accept.split(',')) {
    const [type = '', ...parameters] = entry.split(';').map((part) => part.trim());
    let quality = 1;
    for (const parameter of parameters) {
      const separator = parameter.indexOf('=');
      const name = (separator === -1 ? parameter : parameter.slice(0, separator)).trim();
      if (name.toLowerCase() !== 'q') {
        continue;
      }
      const value = separator === -1 ? '' : parameter.slice(separator + 1).trim();
      // A malformed weight disqualifies only its own entry. Next.js answers 500 here.
      quality = /^\d+(\.\d*)?$|^\.\d+$/.test(value) ? Number(value) : 0;
    }
    if (quality > 0 && !type.includes('*')) {
      types.add(type.toLowerCase());
    }
  }
  return types;
}

/**
 * The output format for a request: the first of `formats` that `accept` lists
 * explicitly (exact media type, case-insensitive, `q > 0`), or `''` when none
 * does. `image/avif` is skipped above Cloudflare's AVIF width limit so the
 * next preferred format is used.
 *
 * Next.js also needs an explicit listing (`accept.includes(type)`), but it
 * ranks AVIF over WebP regardless of the `formats` order; Void follows the
 * documented order. Media-type parameters (`image/webp;level=1`) are ignored
 * instead of leaking into the response type.
 */
export function getSupportedImageFormat(
  formats: ReadonlyArray<ImageFormat>,
  accept: string | null | undefined,
  width: number,
): ImageFormat | '' {
  if (!accept) {
    return '';
  }
  const accepted = acceptedTypes(accept);
  for (const format of formats) {
    if (format === 'image/avif' && width > AVIF_MAX_WIDTH) {
      continue;
    }
    if (accepted.has(format)) {
      return format;
    }
  }
  return '';
}
