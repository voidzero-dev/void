import type { Context } from 'hono';

const STATIC_ASSET_KEY = '__voidStaticAsset';

type StaticAssetMark = { policy: string; body: ReadableStream | null };

/**
 * Records that the fallback answered with a file from the ASSETS binding: the
 * Cache-Control it carried and its body stream. The value lives on the
 * context, not on the response object: `c.header()` after the handler rebuilds
 * `c.res`, so a response identity check would miss the file. The rebuild keeps
 * the body stream, while a middleware that swaps the body does not.
 */
export function markStaticAsset(c: Context, response: Response): Response {
  const mark: StaticAssetMark = {
    policy: response.headers.get('cache-control') ?? '',
    body: response.body,
  };
  c.set(STATIC_ASSET_KEY, mark);
  return response;
}

/**
 * True when the final response is still the marked file: a success status, the
 * same body and Cache-Control the fallback served, and no cookie added by
 * later middleware.
 */
export function isUnchangedStaticAsset(c: Context): boolean {
  const mark = c.get(STATIC_ASSET_KEY) as StaticAssetMark | undefined;
  return (
    mark !== undefined &&
    [200, 206, 304].includes(c.res.status) &&
    c.res.body === mark.body &&
    (c.res.headers.get('cache-control') ?? '') === mark.policy &&
    !c.res.headers.has('set-cookie')
  );
}
