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
    return fetchRemoteImage(new URL(location, url.href).href, {
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

/**
 * Load a local source from the static assets binding with an empty header
 * set (`GET`, no cookies or conditional headers), like Next.js's internal
 * image request. Application routes are not consulted.
 */
export async function loadLocalImage(
  assets: AssetFetcher | undefined,
  href: string,
  requestUrl: string,
  maximumResponseBody: number,
): Promise<ImageUpstream> {
  if (!assets || typeof assets.fetch !== 'function') {
    throw new ImageError(500, UPSTREAM_INVALID);
  }
  let response: Response;
  try {
    response = await assets.fetch(new Request(new URL(href, requestUrl)));
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
