import { extractEtag } from './headers.ts';
import {
  ImageError,
  INTERNAL_INVALID,
  NOT_ALLOWED,
  UPSTREAM_INVALID,
  UPSTREAM_TIMED_OUT,
} from './image-error.ts';
import { isPrivateIpLiteral } from './private-ip.ts';

/** A source image, fully buffered. */
export type ImageUpstream = {
  bytes: Uint8Array<ArrayBuffer>;
  /** Upstream `Content-Type`; informational only, the bytes are sniffed. */
  contentType: string | null;
  cacheControl: string | null;
  /** Opaque validator: the base64url upstream `ETag`, or the SHA-256 of the bytes. */
  etag: string;
};

export type ImageFetch = (input: string, init: RequestInit) => Promise<Response>;

export type AssetFetcher = { fetch: (request: Request) => Promise<Response> };

/** Next.js's upstream request timeout, covering headers and body. */
export const UPSTREAM_TIMEOUT_MS = 7000;

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

const canParse = (location: string, base: string): boolean => {
  try {
    new URL(location, base);
    return true;
  } catch {
    return false;
  }
};

const discard = (response: Response): void => {
  response.body?.cancel().catch(() => {});
};

/**
 * Read `body` into one array, failing with `413` once more than `limit`
 * bytes arrive. `signal` cancels the read (Next.js's timeout also covers the body).
 */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  message: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const abort = (): void => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) {
    abort();
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        throw new ImageError(413, message);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type RemoteImageOptions = {
  dangerouslyAllowLocalIP: boolean;
  maximumResponseBody: number;
  /** Redirects still allowed; each followed redirect lowers it by one. */
  maximumRedirects: number;
  /**
   * Whether an `http`/`https` redirect target may be fetched (the endpoint
   * checks `images.remotePatterns`); a refused target is `400`.
   */
  isAllowedRedirect?: (url: URL) => boolean;
  fetch?: ImageFetch;
  timeoutMs?: number;
};

/**
 * Fetch an allowed remote source like Next.js's `fetchExternalImage`: no
 * client headers or cookies, manual redirects (each hop checked again for a
 * private host, `508` past `maximumRedirects`), a 7-second timeout (`504`), a
 * streamed body limit (`413`), and the upstream status for any non-2xx answer.
 * Workers decode `Content-Encoding` themselves, so the limit applies to the
 * decoded bytes as in Next.js.
 *
 * Unlike Next.js, redirect targets must also pass `isAllowedRedirect`.
 * Next.js resolves every hop's hostname and refuses private addresses; a
 * Worker cannot resolve DNS, and the local runtime behind `vp dev` and
 * preview may reach private networks, so a redirect from an allowed host
 * to a name such as `127.0.0.1.nip.io` must not be followed.
 */
export async function fetchRemoteImage(
  href: string,
  options: RemoteImageOptions,
): Promise<ImageUpstream> {
  const url = new URL(href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageError(500, UPSTREAM_INVALID);
  }
  if (!options.dangerouslyAllowLocalIP && isPrivateIpLiteral(url.hostname)) {
    throw new ImageError(400, NOT_ALLOWED);
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await request(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { accept: '*/*', 'accept-language': '*', 'sec-fetch-mode': 'cors' },
    });
  } catch {
    if (signal.aborted) {
      throw new ImageError(504, UPSTREAM_TIMED_OUT);
    }
    throw new ImageError(500, UPSTREAM_INVALID);
  }
  const location = response.headers.get('location');
  if (REDIRECT_STATUSES.includes(response.status) && location && canParse(location, url.href)) {
    // The body of a redirect is never read: only the final response is size-limited.
    discard(response);
    if (options.maximumRedirects <= 0) {
      throw new ImageError(508, UPSTREAM_INVALID);
    }
    const target = new URL(location, url.href);
    if (
      options.isAllowedRedirect &&
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      !options.isAllowedRedirect(target)
    ) {
      throw new ImageError(400, NOT_ALLOWED);
    }
    return fetchRemoteImage(target.href, {
      ...options,
      maximumRedirects: options.maximumRedirects - 1,
    });
  }
  if (response.status < 200 || response.status > 299) {
    discard(response);
    throw new ImageError(response.status, UPSTREAM_INVALID);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBody(response.body, options.maximumResponseBody, UPSTREAM_INVALID, signal);
  } catch (error) {
    if (error instanceof ImageError) {
      throw error;
    }
    if (signal.aborted) {
      throw new ImageError(504, UPSTREAM_TIMED_OUT);
    }
    throw new ImageError(500, UPSTREAM_INVALID);
  }
  if (signal.aborted) {
    throw new ImageError(504, UPSTREAM_TIMED_OUT);
  }
  if (bytes.byteLength === 0) {
    throw new ImageError(400, UPSTREAM_INVALID);
  }
  return {
    bytes,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    etag: await extractEtag(response.headers.get('etag'), bytes),
  };
}

/** Runs a request through the application (middleware, routes and page fallbacks). */
export type LocalImageDispatch = (request: Request) => Promise<Response>;

/**
 * Load a local source with an empty header set (`GET`, no cookies or
 * conditional headers), like Next.js's internal image request.
 *
 * With `dispatch`, the request takes the Worker's own path: the application
 * answers first, so middleware that guards the source path applies, and a
 * `404` falls back to the static assets. Any other non-2xx answer (a
 * middleware `401`, a redirect) fails with its status. Without `dispatch`,
 * the static assets binding is read directly.
 */
export async function loadLocalImage(
  assets: AssetFetcher | undefined,
  href: string,
  requestUrl: string,
  maximumResponseBody: number,
  dispatch?: LocalImageDispatch,
): Promise<ImageUpstream> {
  const hasAssets = !!assets && typeof assets.fetch === 'function';
  if (!hasAssets && !dispatch) {
    throw new ImageError(500, UPSTREAM_INVALID);
  }
  const url = new URL(href, requestUrl);
  let response: Response | undefined;
  try {
    if (dispatch) {
      response = await dispatch(new Request(url));
      if (response.status === 404 && hasAssets) {
        discard(response);
        response = undefined;
      }
    }
    response ??= await assets!.fetch(new Request(url));
  } catch {
    throw new ImageError(500, UPSTREAM_INVALID);
  }
  if (response.status < 200 || response.status > 299) {
    discard(response);
    throw new ImageError(response.status, INTERNAL_INVALID);
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBody(response.body, maximumResponseBody, INTERNAL_INVALID);
  } catch (error) {
    throw error instanceof ImageError ? error : new ImageError(500, UPSTREAM_INVALID);
  }
  if (bytes.byteLength === 0) {
    throw new ImageError(400, INTERNAL_INVALID);
  }
  return {
    bytes,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    etag: await extractEtag(response.headers.get('etag'), bytes),
  };
}
