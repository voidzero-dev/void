import type { ImageFormat, ResolvedImageConfig } from '../config.ts';
import { hasRemoteMatch } from '../patterns.ts';
import { getSupportedImageFormat } from './accept.ts';
import {
  ANIMATABLE_TYPES,
  AVIF,
  BYPASS_TYPES,
  detectContentType,
  isAnimated,
  JPEG,
  PNG,
  WEBP,
} from './content-type.ts';
import {
  getContentDisposition,
  getFileNameWithExtension,
  getImageEtag,
  getMaxAge,
  isFreshRequest,
} from './headers.ts';
import { ImageError, NOT_AN_IMAGE, TYPE_NOT_ALLOWED } from './image-error.ts';
import {
  fetchRemoteImage,
  loadLocalImage,
  type AssetFetcher,
  type ImageFetch,
  type ImageUpstream,
  type LocalImageDispatch,
} from './upstream.ts';
import { validateImageParams, type ImageParams } from './validate.ts';

/** Formats the Images binding can encode. Other output types serve the original. */
type OutputFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';
const OUTPUT_FORMATS: ReadonlyArray<string> = [JPEG, PNG, WEBP, AVIF];

/** The part of the Cloudflare Images binding the endpoint uses. */
export type ImageTransformerLike = {
  transform(transform: { width: number; fit: 'scale-down' }): ImageTransformerLike;
  output(options: {
    format: OutputFormat;
    quality: number;
  }): Promise<{ image(): ReadableStream<Uint8Array> }>;
};
export type ImagesBindingLike = {
  input(stream: ReadableStream<Uint8Array>): ImageTransformerLike;
};

/** The part of the Workers Cache API the endpoint uses. */
export type ImageCacheLike = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

export type ImageRequestOptions = {
  config: ResolvedImageConfig;
  /** Compile-time deployment id; scopes cached local sources to one deployment. */
  deploymentId: string;
  /** Static assets binding local sources load from. */
  assets?: AssetFetcher;
  /**
   * Runs a local source request through the application first, so middleware
   * sees the source path; its `404` falls back to `assets`. Without it,
   * local sources are read from `assets` directly.
   */
  fetchLocal?: LocalImageDispatch;
  /** Images binding; without it, sources that need a transform are served unchanged. */
  binding?: ImagesBindingLike;
  /** Binding name for the missing-binding warning. */
  bindingName?: string;
  /** Response cache (`caches.default`). Ignored in development. */
  cache?: ImageCacheLike;
  /** Keeps cache writes alive after the response; nothing is cached without it. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Whether a local source path is a fingerprinted build asset. */
  isImmutable?: (pathname: string) => boolean | Promise<boolean>;
  /** `fetch` for remote sources. */
  fetch?: ImageFetch;
  /** Remote source timeout in milliseconds (default 7000). */
  timeoutMs?: number;
};

type ImageResult = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  /** Opaque validator, sent quoted. */
  etag: string;
  maxAge: number;
  /**
   * The original served because the transform failed or the binding is
   * missing. It never gets the immutable policy, so the next request after
   * `maxAge` (`minimumCacheTTL`) tries the transform again.
   */
  fallback?: boolean;
};

/** Next.js's `Cache-Control` for statically imported (fingerprinted) images. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=315360000, immutable';
/** Bump when the stored entry format changes. */
const CACHE_VERSION = '2';
const CACHE_MAX_AGE_HEADER = 'X-Void-Image-Max-Age';
const CACHE_FALLBACK_HEADER = 'X-Void-Image-Fallback';
const IMMUTABLE_CACHE_TTL = 31536000;

const warned = new Set<string>();
/** One warning per key per isolate; bounded, because animated-image keys include the source. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key) || warned.size >= 256) {
    return;
  }
  warned.add(key);
  console.warn(message);
}

function warnTransformFailure(error: unknown, path: string): void {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 9422) {
    warnOnce(
      'code:9422',
      `[void] The Cloudflare Images Free allowance is used up, so ${path} serves the original image for new sizes until next month (error 9422).`,
    );
    return;
  }
  const message = (error as { message?: unknown } | null)?.message;
  const detail = typeof message === 'string' ? message : String(error);
  warnOnce(
    `code:${typeof code === 'number' ? code : 'unknown'}`,
    typeof code === 'number'
      ? `[void] Cloudflare Images could not transform an image (error ${code}: ${detail}), so ${path} serves the original image.`
      : `[void] Image transformation failed (${detail}), so ${path} serves the original image.`,
  );
}

const text = (status: number, message: string): Response => new Response(message, { status });

function cacheKey(
  requestUrl: URL,
  params: ImageParams,
  format: ImageFormat | '',
  options: ImageRequestOptions,
): Request {
  // Built only from validated values. The Cache API ignores `Vary`, so the
  // negotiated format is part of the key; local sources change with each
  // deployment, remote ones do not.
  const key = new URL(options.config.path, requestUrl.origin);
  key.searchParams.set('url', params.href);
  key.searchParams.set('w', String(params.width));
  key.searchParams.set('q', String(params.quality));
  key.searchParams.set('__void_img_fmt', format || 'auto');
  key.searchParams.set('__void_img_v', CACHE_VERSION);
  if (!params.isAbsolute) {
    key.searchParams.set('__void_img_dpl', options.deploymentId);
  }
  return new Request(key);
}

async function readCache(cache: ImageCacheLike, key: Request): Promise<ImageResult | undefined> {
  // Fail open: any Cache API problem is a miss.
  try {
    const response = await cache.match(key);
    if (!response) {
      return undefined;
    }
    const contentType = response.headers.get('content-type');
    const etag = response.headers.get('etag');
    const maxAge = response.headers.get(CACHE_MAX_AGE_HEADER);
    if (!response.ok || !contentType || !etag || !maxAge || !/^\d+$/.test(maxAge)) {
      await response.body?.cancel();
      return undefined;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return undefined;
    }
    return {
      bytes,
      contentType,
      etag: etag.replace(/^"|"$/g, ''),
      maxAge: Number(maxAge),
      fallback: response.headers.get(CACHE_FALLBACK_HEADER) === '1',
    };
  } catch {
    return undefined;
  }
}

function writeCache(
  options: ImageRequestOptions,
  key: Request,
  result: ImageResult,
  isStatic: boolean,
): void {
  const ttl = isStatic && !result.fallback ? IMMUTABLE_CACHE_TTL : result.maxAge;
  if (!options.cache || !options.waitUntil || ttl <= 0) {
    return;
  }
  const headers: Record<string, string> = {
    'Content-Type': result.contentType,
    'Cache-Control': `public, max-age=${ttl}`,
    ETag: `"${result.etag}"`,
    [CACHE_MAX_AGE_HEADER]: String(result.maxAge),
  };
  if (result.fallback) {
    headers[CACHE_FALLBACK_HEADER] = '1';
  }
  const entry = new Response(result.bytes, { headers });
  let write: Promise<void>;
  try {
    write = options.cache.put(key, entry).catch(() => {});
  } catch {
    return;
  }
  options.waitUntil(write);
}

async function optimize(
  upstream: ImageUpstream,
  params: ImageParams,
  format: ImageFormat | '',
  options: ImageRequestOptions,
): Promise<ImageResult> {
  const { config } = options;
  const maxAge = Math.max(config.minimumCacheTTL, getMaxAge(upstream.cacheControl));
  const type = detectContentType(upstream.bytes);
  if (!type || !type.startsWith('image/') || type.includes(',')) {
    throw new ImageError(400, NOT_AN_IMAGE);
  }
  if (type.startsWith('image/svg') && !config.dangerouslyAllowSVG) {
    throw new ImageError(400, TYPE_NOT_ALLOWED);
  }
  const original: ImageResult = {
    bytes: upstream.bytes,
    contentType: type,
    etag: upstream.etag,
    maxAge,
  };
  if (ANIMATABLE_TYPES.includes(type) && isAnimated(upstream.bytes)) {
    warnOnce(
      `animated:${params.href}`,
      `[void] The requested resource "${params.href}" is an animated image so it will not be optimized. Consider adding the "unoptimized" property to the <Image>.`,
    );
    return original;
  }
  if (BYPASS_TYPES.includes(type)) {
    return original;
  }
  // Without a negotiated format, keep the source type, except that WebP and
  // AVIF fall back to JPEG for clients that did not ask for them.
  const output = format || (type === WEBP || type === AVIF ? JPEG : type);
  if (!OUTPUT_FORMATS.includes(output)) {
    // The binding cannot encode GIF (locally), TIFF or JPEG 2000.
    return original;
  }
  // Next.js serves the original with `minimumCacheTTL` when its encoder fails.
  const fallback: ImageResult = { ...original, maxAge: config.minimumCacheTTL, fallback: true };
  if (!options.binding) {
    warnOnce(
      'binding',
      `[void] Image optimization is unavailable because the Worker has no Images binding (env.${options.bindingName ?? 'IMAGES'}), so ${config.path} serves original images.`,
    );
    return fallback;
  }
  try {
    // Quality is passed through unchanged: Next.js's AVIF quality scaling is
    // tuned for sharp's encoder, not Cloudflare's. `scale-down` never enlarges.
    const result = await options.binding
      .input(new Response(upstream.bytes).body as ReadableStream<Uint8Array>)
      .transform({ width: params.width, fit: 'scale-down' })
      .output({ format: output as OutputFormat, quality: params.quality });
    const bytes = new Uint8Array(await new Response(result.image()).arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error('empty output');
    }
    return { bytes, contentType: output, etag: await getImageEtag(bytes), maxAge };
  } catch (error) {
    // Binding errors carry a numeric `code` (9422 when the Free allowance is
    // used up) but no global class to test against. The source stream is
    // spent, so the buffered bytes are served instead.
    warnTransformFailure(error, config.path);
    return fallback;
  }
}

function respond(
  request: Request,
  href: string,
  result: ImageResult,
  isStatic: boolean,
  cacheStatus: 'HIT' | 'MISS',
  config: ResolvedImageConfig,
): Response {
  const headers = new Headers();
  headers.set('Vary', 'Accept');
  // Next.js also marks an original served after a failed transform
  // immutable. Void keeps `minimumCacheTTL` for it, so browsers pick up the
  // optimized image once the transform works again (the Free allowance resets
  // monthly, while a static image's URL survives deployments).
  headers.set(
    'Cache-Control',
    isStatic && !result.fallback
      ? IMMUTABLE_CACHE_CONTROL
      : `public, max-age=${config.dev ? 0 : result.maxAge}, must-revalidate`,
  );
  // Next.js sends the tag unquoted; Void quotes it as RFC 9110 requires.
  headers.set('ETag', `"${result.etag}"`);
  if (isFreshRequest(request.headers, result.etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Type', result.contentType);
  headers.set(
    'Content-Disposition',
    getContentDisposition(
      getFileNameWithExtension(href, result.contentType),
      config.contentDispositionType,
    ),
  );
  headers.set('Content-Security-Policy', config.contentSecurityPolicy);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Void-Image-Cache', cacheStatus);
  headers.set('Content-Length', String(result.bytes.byteLength));
  return new Response(request.method === 'HEAD' ? null : result.bytes, { status: 200, headers });
}

/**
 * Serve one `/_void/image` request with Next.js `/_next/image` semantics:
 * validate `url`/`w`/`q` (400 with Next's messages), negotiate the output
 * format from `Accept`, answer from the cache, load the source (static
 * assets or an allowed remote URL), sniff it, resize it with the Images
 * binding and respond with Next's caching headers.
 *
 * Void differences: `GET`/`HEAD` only (405 otherwise), a quoted `ETag`,
 * `X-Content-Type-Options: nosniff`, `X-Void-Image-Cache` instead of
 * `X-Nextjs-Cache`, no stale-while-revalidate (the Cache API has none), any
 * binding failure serves the original image (never marked immutable), and
 * remote redirect targets must match `images.remotePatterns`.
 */
export async function handleImageRequest(
  request: Request,
  options: ImageRequestOptions,
): Promise<Response> {
  const { config } = options;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (config.unoptimized || config.loader !== 'default' || config.loaderFile) {
    return text(404, 'Not Found');
  }
  const requestUrl = new URL(request.url);
  const params = validateImageParams(requestUrl.searchParams, config);
  if ('errorMessage' in params) {
    return text(400, params.errorMessage);
  }
  const format = getSupportedImageFormat(
    config.formats,
    request.headers.get('accept'),
    params.width,
  );
  try {
    let isStatic = false;
    if (!params.isAbsolute && options.isImmutable) {
      try {
        isStatic = await options.isImmutable(new URL(params.href, 'http://n').pathname);
      } catch {
        isStatic = false;
      }
    }
    const key =
      options.cache && !config.dev ? cacheKey(requestUrl, params, format, options) : undefined;
    const cached = key ? await readCache(options.cache!, key) : undefined;
    if (cached) {
      return respond(request, params.href, cached, isStatic, 'HIT', config);
    }
    const upstream = params.isAbsolute
      ? await fetchRemoteImage(params.href, {
          dangerouslyAllowLocalIP: config.dangerouslyAllowLocalIP,
          maximumResponseBody: config.maximumResponseBody,
          maximumRedirects: config.maximumRedirects,
          isAllowedRedirect: (target) => {
            if (hasRemoteMatch(config.domains, config.remotePatterns, target)) {
              return true;
            }
            warnOnce(
              `redirect:${target.origin}`,
              `[void] An image source redirected to ${target.origin}, which images.remotePatterns doesn't allow, so ${config.path} refused it. Add the redirect target to images.remotePatterns to optimize it.`,
            );
            return false;
          },
          fetch: options.fetch,
          timeoutMs: options.timeoutMs,
        })
      : await loadLocalImage(
          options.assets,
          params.href,
          request.url,
          config.maximumResponseBody,
          options.fetchLocal,
        );
    const result = await optimize(upstream, params, format, options);
    if (key) {
      writeCache(options, key, result, isStatic);
    }
    return respond(request, params.href, result, isStatic, 'MISS', config);
  } catch (error) {
    if (error instanceof ImageError) {
      return text(error.statusCode, error.message);
    }
    throw error;
  }
}
