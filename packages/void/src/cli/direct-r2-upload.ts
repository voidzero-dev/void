import type { CliLogger } from './log-file.ts';

/**
 * Concurrency for direct-to-R2 PUTs from the CLI. Bounded to 10 so we don't
 * fan out unboundedly into the user's outbound bandwidth — empirically the
 * sweet spot for typical asset bundles on residential connections.
 */
export const R2_PUT_CONCURRENCY = 10;

/**
 * Maximum retry attempts for a single R2 PUT before giving up. Matched to
 * the design doc 0068 spec, with rate limits retried alongside 5xx errors.
 */
const MAX_R2_PUT_RETRIES = 3;

/**
 * Retry backoff delays in milliseconds. After transient attempt `i` fails we
 * sleep `RETRY_BACKOFF_MS[i]` before retrying. Indexed from 0; once the
 * array is exhausted we surface the error.
 */
const RETRY_BACKOFF_MS = [250, 500, 1000];

export const R2_CREDENTIALS_DOCS_URL =
  'https://void.cloud/guide/platform/installation/credentials#r2-upload-credentials';

/**
 * S3 error codes that mean R2 did not accept the signature on a presigned
 * upload link. The platform signs every link with its own R2 key pair, so
 * these usually point at that pair. Expiry and clock-skew codes are left out:
 * they have other causes.
 */
export const R2_CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'Unauthorized',
  'AccessDenied',
  'SignatureDoesNotMatch',
  'InvalidAccessKeyId',
]);

/**
 * S3 error codes R2 answers with HTTP 400 when the Access Key ID is malformed,
 * for example the token value pasted in place of the 32-character key ID.
 */
export const R2_MALFORMED_CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'InvalidArgument',
  'AuthorizationHeaderMalformed',
]);

/** Whether an R2 error answer means R2 rejected the key pair itself. */
export function isR2CredentialRejection(status: number, code: string | undefined): boolean {
  if (!code) {
    return false;
  }
  if (status === 401 || status === 403) {
    return R2_CREDENTIAL_ERROR_CODES.has(code);
  }
  return status === 400 && R2_MALFORMED_CREDENTIAL_ERROR_CODES.has(code);
}

/**
 * Read the `<Code>` value from an S3-style XML error body. Returns
 * `undefined` when the body has no complete, non-empty `<Code>` element.
 */
export function r2ErrorCode(body: string): string | undefined {
  const open = '<Code>';
  const start = body.indexOf(open);
  if (start === -1) {
    return undefined;
  }
  const valueStart = start + open.length;
  const end = body.indexOf('</Code>', valueStart);
  if (end === -1) {
    return undefined;
  }
  const code = body.slice(valueStart, end).trim();
  return code === '' ? undefined : code;
}

function directR2PutErrorMessage(
  status: number,
  hash: string,
  path: string,
  body: string,
  code: string | undefined,
): string {
  if (isR2CredentialRejection(status, code)) {
    return (
      `R2 rejected the upload signature (${code}) for ${path} (${hash}). ` +
      "This usually means the platform's R2 upload credentials are wrong. " +
      'Ask the platform operator to fix it. ' +
      'If you run this platform: set VOID_PLATFORM_R2_ACCESS_KEY_ID and VOID_PLATFORM_R2_SECRET_ACCESS_KEY ' +
      `to a working pair and run \`void platform repair\`. See ${R2_CREDENTIALS_DOCS_URL}`
    );
  }
  return `R2 PUT failed for ${path} (${hash}): ${status}${body ? ` ${body}` : ''}`;
}

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
  /** S3 `<Code>` parsed from `body`, when R2 returned an XML error. */
  readonly code: string | undefined;

  constructor(status: number, hash: string, path: string, body: string) {
    const code = r2ErrorCode(body);
    super(directR2PutErrorMessage(status, hash, path, body, code));
    this.name = 'DirectR2PutError';
    this.status = status;
    this.hash = hash;
    this.path = path;
    this.body = body;
    this.code = code;
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
 * (429/5xx after retry exhaustion, other 4xx immediately) as a `DirectR2PutError`
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
        body: new Uint8Array(body) as BodyInit,
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

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_R2_PUT_RETRIES) {
      cliLog?.warn('r2_put_retry', {
        hash: item.hash,
        path: item.path,
        attempt: attempt + 1,
        status: res.status,
        body: truncate(errBody),
      });
      // R2 permits one write per second to the same object key.
      await sleep(
        res.status === 429 ? Math.max(1000, RETRY_BACKOFF_MS[attempt]) : RETRY_BACKOFF_MS[attempt],
      );
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
