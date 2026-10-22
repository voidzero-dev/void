import type { Context } from 'hono';

const STATIC_ASSET_KEY = '__voidStaticAsset';

/**
 * Records that the fallback answered with a file from the ASSETS binding, and
 * the Cache-Control it carried. The value lives on the context, not on the
 * response object: `c.header()` after the handler rebuilds `c.res`, so a
 * response identity check would miss the file.
 */
export function markStaticAsset(c: Context, response: Response): Response {
  c.set(STATIC_ASSET_KEY, response.headers.get('cache-control') ?? '');
  return response;
}

/**
 * True when the final response is still the marked file: a success status, the
 * Cache-Control the fallback served, and no cookie added by later middleware.
 */
export function isUnchangedStaticAsset(c: Context): boolean {
  const policy: unknown = c.get(STATIC_ASSET_KEY);
  return (
    typeof policy === 'string' &&
    [200, 206, 304].includes(c.res.status) &&
    (c.res.headers.get('cache-control') ?? '') === policy &&
    !c.res.headers.has('set-cookie')
  );
}
