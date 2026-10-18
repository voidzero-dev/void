import type { CliLogger } from './log-file.ts';

/**
 * Concurrency for direct-to-R2 PUTs from the CLI. Bounded to 10 so we don't
 * fan out unboundedly into the user's outbound bandwidth — empirically the
 * sweet spot for typical asset bundles on residential connections.
 */
export const R2_PUT_CONCURRENCY = 10;

/**
 * Maximum retry attempts for a single R2 PUT before giving up. Matched to
 * the design doc 0068 spec: 5xx triggers retry, 4xx surfaces immediately.
 */
const MAX_R2_PUT_RETRIES = 3;

/**
 * Retry backoff delays in milliseconds. After attempt `i` fails (5xx) we
 * sleep `RETRY_BACKOFF_MS[i]` before retrying. Indexed from 0; once the
 * array is exhausted we surface the error.
 */
const RETRY_BACKOFF_MS = [250, 500, 1000];

export class DirectR2PutError extends Error {
  readonly status: number;
  readonly hash: string;
  readonly path: string;
  /**
   * `body` is the response body text (may be empty / non-text). Useful in
   * the surface error so users can correlate against R2-side errors like
   * `BadDigest` (Content-MD5 mismatch) or signature errors.
   */
  readonly body: string;

  constructor(status: number, hash: string, path: string, body: string) {
    super(`R2 PUT failed for ${path} (${hash}): ${status}${body ? ` ${body}` : ''}`);
    this.name = 'DirectR2PutError';
    this.status = status;
    this.hash = hash;
    this.path = path;
    this.body = body;
  }
}

export type DirectR2PutItem = {
  /**
   * Asset path relative to the build output (with leading `/`), or a Worker
   * module path relative to the Worker output.
   */
  path: string;
  /** Asset BLAKE3 storage hash or Worker module SHA-256, for log correlation. */
  hash: string;
  /**
   * Bytes to upload. Cleared (set to `undefined`) by `uploadAssetsToR2` after a
   * successful PUT so the buffer becomes eligible for GC as soon as the
   * upload is acknowledged. Callers should not read `body` after the upload
   * completes.
   */
  body: Buffer | undefined;
  /** Presigned URL from `requestUploadUrls` or `requestWorkerUploadUrls`. */
  url: string;
  /** Headers the platform required us to send (e.g. Content-Md5, Content-Type). */
  headers: Record<string, string>;
};

/**
 * Issue direct-to-R2 PUTs for every item in `items` (assets or Worker
 * modules), bounded to `R2_PUT_CONCURRENCY`. Surfaces the first failure
 * (4xx immediately, 5xx after retry exhaustion) as a `DirectR2PutError`
 * carrying the item path and hash so the user can correlate against the
 * JSONL log.
 *
 * Logs `r2_put_start` / `r2_put_end` per asset, plus `r2_put_retry` on
 * each retry attempt. Per-asset durations help identify slow uploads.
 *
 * Memory: each successful PUT clears `item.body` and invokes `onAfterPut`
 * so the caller can drop its own ref (e.g. delete from the in-memory
 * `assetFiles` cache). For huge deploys this keeps peak memory bounded by
 * the upload concurrency rather than the total bundle size.
 */
export async function uploadAssetsToR2(
  items: Array<DirectR2PutItem>,
  cliLog: CliLogger | undefined,
  fetchImpl: typeof fetch = fetch,
  onAfterPut?: (item: DirectR2PutItem) => void,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let firstError: unknown = null;
  let nextIndex = 0;

  // Bounded-pool worker pattern: each worker pulls the next index until
  // exhausted or a sibling worker captured an error. We surface the
  // first error so concurrent failures don't race the message.
  const workerCount = Math.min(R2_PUT_CONCURRENCY, items.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (firstError === null) {
          const i = nextIndex++;
          if (i >= items.length) {
            return;
          }
          try {
            await uploadOne(items[i], cliLog, fetchImpl);
          } catch (err) {
            if (firstError === null) {
              firstError = err;
            }
            return;
          }
          // Drop refs to the asset bytes now that R2 has them. Both the
          // local `body` ref on the item and any caller-side ref (via
          // `onAfterPut`) are released so the buffer becomes eligible
          // for GC under bounded concurrency.
          items[i].body = undefined;
          onAfterPut?.(items[i]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  if (firstError !== null) {
    throw firstError;
  }
}

async function uploadOne(
  item: DirectR2PutItem,
  cliLog: CliLogger | undefined,
  fetchImpl: typeof fetch,
): Promise<void> {
  // Capture the body up-front. The pool only clears `item.body` AFTER
  // `uploadOne` returns successfully, so it is guaranteed defined here for
  // all attempts of this single PUT.
  if (!item.body) {
    throw new Error(`internal: uploadOne invoked for ${item.path} with no body`);
  }
  const body = item.body;
  const startedAt = Date.now();
  cliLog?.info('r2_put_start', {
    hash: item.hash,
    path: item.path,
    sizeBytes: body.length,
  });

  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetchImpl(item.url, {
        method: 'PUT',
        // Clone the buffer into a fresh Uint8Array view so each retry sees
        // an independent body. Reusing the same Buffer across retries is
        // safe with `fetch` (it consumes once), but explicit here.
        body: new Uint8Array(body) as unknown as BodyInit,
        headers: item.headers,
      });
    } catch (err) {
      // Network-level error: behave like a 5xx for retry purposes (transient
      // by nature) but exhaustion still throws.
      if (attempt < MAX_R2_PUT_RETRIES) {
        cliLog?.warn('r2_put_retry', {
          hash: item.hash,
          path: item.path,
          attempt: attempt + 1,
          status: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(RETRY_BACKOFF_MS[attempt]);
        attempt++;
        continue;
      }
      cliLog?.error('r2_put_end', err, {
        hash: item.hash,
        path: item.path,
        durationMs: Date.now() - startedAt,
        status: 0,
      });
      throw new DirectR2PutError(
        0,
        item.hash,
        item.path,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (res.ok) {
      cliLog?.info('r2_put_end', {
        hash: item.hash,
        path: item.path,
        durationMs: Date.now() - startedAt,
        status: res.status,
      });
      return;
    }

    // Drain the body so the connection is reusable. Truncate for log
    // correlation — full R2 error bodies can be verbose.
    const errBody = await safeReadText(res);

    if (res.status >= 500 && attempt < MAX_R2_PUT_RETRIES) {
      cliLog?.warn('r2_put_retry', {
        hash: item.hash,
        path: item.path,
        attempt: attempt + 1,
        status: res.status,
        body: truncate(errBody),
      });
      await sleep(RETRY_BACKOFF_MS[attempt]);
      attempt++;
      continue;
    }

    cliLog?.error('r2_put_end', undefined, {
      hash: item.hash,
      path: item.path,
      durationMs: Date.now() - startedAt,
      status: res.status,
      body: truncate(errBody),
    });
    throw new DirectR2PutError(res.status, item.hash, item.path, truncate(errBody));
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function truncate(s: string): string {
  return s.length > 500 ? `${s.slice(0, 500)}...` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
