import { extname } from 'node:path';
import { createHasher } from 'blake3-jit';
import mime from 'mime';
import { retryWithBackoff } from './cf-api.ts';
import { isrObjectPrefix } from './isr-store.ts';
import type { AssetConfig } from './types.ts';

class AssetUploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Non-retriable error — the hash will never appear locally. */
class AssetHashMissError extends Error {}

export type AssetManifestEntry = Readonly<{
  hash: string;
  size: number;
  /** Platform serving store. Absent on deployments created before placement was persisted. */
  store?: 'kv' | 'r2';
  /** Set only after the platform verifies the project-scoped R2 object. */
  scope?: 'project';
}>;

export type AssetEntry = Readonly<{
  bytes: Uint8Array;
  contentType: string;
}>;

/** Resolve upload metadata using the first manifest path for each content hash. */
export function resolveAssetContentTypes(
  manifest: Readonly<Record<string, AssetManifestEntry>>,
  hashes: ReadonlyArray<string>,
): Map<string, string> {
  if (hashes.length === 0) {
    return new Map();
  }
  const pending = new Set(hashes);
  const paths = new Map<string, string>();
  for (const [path, entry] of Object.entries(manifest)) {
    if (pending.delete(entry.hash)) {
      paths.set(entry.hash, path);
      if (pending.size === 0) {
        break;
      }
    }
  }
  return new Map(hashes.map((hash) => [hash, getContentType(paths.get(hash) ?? '')]));
}

type UploadSessionResponse = Readonly<{
  result: {
    jwt: string;
    buckets: ReadonlyArray<ReadonlyArray<string>>;
  };
}>;

function tryParseJson<T>(text: string): T | null {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const ASSET_SESSION_MAX_RETRIES = 3;
// Cloudflare sets no subrequest time limit; 60 s matches the platform's other Cloudflare API calls.
const ASSET_SESSION_ATTEMPT_TIMEOUT_MS = 60_000;
const ASSET_SESSION_RETRY_DELAY_MS = 1000;
const ASSET_BUCKET_UPLOAD_RETRY_DELAY_MS = 1000;

const MAX_UPLOAD_RETRIES = 5; // 5 retries + 1 initial = 6 total tries (matching Wrangler)
const UPLOAD_CONCURRENCY = 3;
/** Maximum concurrent static-asset storage operations per deploy. */
export const STATIC_ASSET_UPLOAD_CONCURRENCY = 4;
const GATEWAY_BACKOFF_BASE_MS = 5000;
const MAX_GATEWAY_ERRORS = 5; // start counting attempts after this many 524s (4 free retries)

/**
 * Strip a manifest down to the exact `{ hash, size }` shape CF's
 * `assets-upload-session` endpoint documents. v2 manifests carry extra
 * fields (e.g. `blake3`, `md5`) that the platform persists for future
 * preflight reasoning — those must NOT be forwarded to CF, whose API
 * documents only `{ hash, size }` per entry. CF may strictly validate
 * extras and break the deploy. Use this at every CF-bound call site.
 *
 * Always returns a fresh object (no shared references with the input).
 */
export function normalizeForCfAssetSession(
  entries: Record<string, AssetManifestEntry>,
): Record<string, AssetManifestEntry> {
  const out: Record<string, AssetManifestEntry> = {};
  for (const [path, entry] of Object.entries(entries)) {
    out[path] = { hash: entry.hash, size: entry.size };
  }
  return out;
}

/**
 * Step 1: Create an asset upload session with CF.
 * Sends the asset manifest (path → {hash, size}) and receives a completion JWT
 * plus "buckets" — groups of hashes that CF needs uploaded.
 *
 * CF's WfP assets API sometimes returns plain text (e.g. "Assets have already
 * been uploaded") instead of JSON when all asset hashes already exist. This is
 * a CF bug — the response varies by edge node. Retrying typically hits a
 * different node that returns proper JSON.
 *
 * A 5xx or a network error (a dropped response body or a timed-out attempt
 * included) is retried. A 4xx is final, even when its body drops. That
 * includes a 429: the install shares one API token.
 */
export async function createAssetUploadSession(
  accountId: string,
  apiToken: string,
  namespace: string,
  workerName: string,
  manifest: Record<string, AssetManifestEntry>,
  { retryDelayMs = ASSET_SESSION_RETRY_DELAY_MS }: { retryDelayMs?: number } = {},
): Promise<{ jwt: string; buckets: ReadonlyArray<ReadonlyArray<string>> }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${workerName}/assets-upload-session`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ manifest });

  return retryWithBackoff(
    async (attempt) => {
      const lastAttempt = attempt === ASSET_SESSION_MAX_RETRIES;
      let response: Response | undefined;
      let text: string;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(ASSET_SESSION_ATTEMPT_TIMEOUT_MS),
        });
        text = await response.text();
      } catch (error) {
        if (response && !response.ok && response.status < 500) {
          throw new Error(`asset upload session failed (HTTP ${response.status})`, {
            cause: error,
          });
        }
        if (lastAttempt) {
          throw (error as { name?: unknown } | null)?.name === 'TimeoutError'
            ? new Error(
                `asset upload session did not finish within ${ASSET_SESSION_ATTEMPT_TIMEOUT_MS / 1000} seconds`,
                { cause: error },
              )
            : error;
        }
        console.warn(
          `[assets] upload session request failed, retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }

      if (!response.ok) {
        if (response.status >= 500 && !lastAttempt) {
          console.warn(
            `[assets] upload session failed (${response.status}), retrying: ${text.slice(0, 200)}`,
          );
          return undefined;
        }
        console.error(`[assets] upload session failed (${response.status}): ${text}`);
        throw new Error(`asset upload session failed: ${text}`);
      }

      const data = tryParseJson<UploadSessionResponse>(text);
      if (data?.result?.jwt && Array.isArray(data.result.buckets)) {
        const bucketCount = data.result.buckets.length;
        const hashCount = data.result.buckets.flat().length;
        console.log(
          `[assets] session created: ${bucketCount} bucket(s), ${hashCount} hash(es) to upload`,
        );
        if (hashCount === 0) {
          console.log('[assets] all assets cached — no uploads needed');
        }
        return { jwt: data.result.jwt, buckets: data.result.buckets };
      }
      console.warn(
        `[assets] session response missing jwt or buckets, retrying. raw: ${text.slice(0, 200)}`,
      );
      return undefined; // retry — likely CF plain-text bug
    },
    {
      maxRetries: ASSET_SESSION_MAX_RETRIES,
      delayMs: retryDelayMs,
      errorMessage: 'asset upload session returned invalid response after retries',
    },
  );
}

/**
 * Step 2: Upload asset file contents for each bucket.
 *
 * Buckets are uploaded concurrently (up to UPLOAD_CONCURRENCY). On CF gateway
 * errors (524), concurrency drops to 1 and gateway-specific backoff applies.
 * Gateway errors get several free retries before counting against the attempt
 * limit, matching Wrangler's behavior.
 */
export async function uploadAssetBuckets(
  accountId: string,
  jwt: string,
  buckets: ReadonlyArray<ReadonlyArray<string>>,
  assetsByHash: Map<string, AssetEntry>,
  {
    retryDelayMs = ASSET_BUCKET_UPLOAD_RETRY_DELAY_MS,
    gatewayDelayMs = GATEWAY_BACKOFF_BASE_MS,
  }: { retryDelayMs?: number; gatewayDelayMs?: number } = {},
): Promise<string> {
  if (!buckets.some((bucket) => bucket.length > 0)) {
    console.log('[assets] all assets cached — session JWT is completion token');
    return jwt;
  }

  let completionJwt = '';

  // Adaptive concurrency — shared across bucket tasks, drops to 1 on 524
  let concurrency = UPLOAD_CONCURRENCY;
  let activeCount = 0;
  const waiters: Array<() => void> = [];

  async function acquireSlot(): Promise<void> {
    while (activeCount >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    activeCount++;
  }

  function releaseSlot(): void {
    activeCount--;
    const next = waiters.shift();
    if (next) {
      next();
    }
  }

  async function uploadBucket(bucket: ReadonlyArray<string>, bucketIndex: number): Promise<void> {
    console.log(
      `[assets] uploading bucket ${bucketIndex + 1}/${buckets.length}: ${bucket.length} file(s)`,
    );

    let attempts = 0;
    let bucketGatewayErrors = 0;
    let lastErr: unknown;

    while (true) {
      // Short-circuit: another bucket already got the JWT — upload is complete
      if (completionJwt) {
        return;
      }

      await acquireSlot();
      try {
        const parts = resolveAssetUploadParts(bucket, bucketIndex, assetsByHash);
        const { body, contentType } = createBase64MultipartBody(parts);

        const result = await postAssetUpload(accountId, jwt, body, contentType);
        if (result) {
          completionJwt = result;
        }
        return;
      } catch (err) {
        if (err instanceof AssetHashMissError) {
          throw err;
        } // non-retriable
        lastErr = err;
        if (attempts >= MAX_UPLOAD_RETRIES) {
          break;
        }
      } finally {
        releaseSlot();
      }

      // Error path — slot already released, backoff outside the concurrency limit
      console.warn(
        `[assets] bucket ${bucketIndex + 1} upload failed, retrying...`,
        lastErr instanceof Error ? lastErr.message : lastErr,
      );

      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempts) * retryDelayMs));

      if (lastErr instanceof AssetUploadError && lastErr.status === 524) {
        // Gateway error — throttle concurrency + additional backoff
        concurrency = 1;
        while (waiters.length > 0) {
          waiters.shift()!();
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, bucketGatewayErrors) * gatewayDelayMs),
        );
        bucketGatewayErrors++;
        console.warn(
          `[assets] bucket ${bucketIndex + 1} gateway error (524), ` +
            `concurrency → 1, gateway errors: ${bucketGatewayErrors}/${MAX_GATEWAY_ERRORS}`,
        );
        if (bucketGatewayErrors >= MAX_GATEWAY_ERRORS) {
          attempts++;
        }
      } else {
        attempts++;
      }
    }

    // All retries exhausted
    if (isJwtExpired(jwt)) {
      throw new Error(
        `Asset upload timed out on bucket ${bucketIndex + 1}/${buckets.length} — the upload session has expired. ` +
          `Assets already uploaded have been saved, so the next attempt will automatically resume from this point.`,
      );
    }
    throw lastErr;
  }

  const tasks: Array<Promise<void>> = [];
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i].length === 0) {
      continue;
    }
    const bucketIndex = i;
    tasks.push(uploadBucket(buckets[bucketIndex], bucketIndex));
  }
  // Use allSettled so a late bucket failure doesn't abort the deploy when the
  // completion JWT was already received (CF confirmed all hashes are present).
  const results = await Promise.allSettled(tasks);

  if (completionJwt) {
    return completionJwt;
  }

  // No JWT — find the first bucket error to surface, or throw a generic message
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  throw (
    failed?.reason ?? new Error('asset upload completed but no completion JWT received from CF')
  );
}

async function postAssetUpload(
  accountId: string,
  jwt: string,
  body: BodyInit,
  contentType: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/assets/upload?base64=true`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': contentType,
      },
      body,
    },
  );

  if (!response.ok) {
    const status = response.status;
    const error = await response.text();
    console.error(`[assets] upload failed (${status}): ${error.slice(0, 500)}`);
    throw new AssetUploadError(status, `asset upload failed (${status}): ${error}`);
  }

  const text = await response.text();
  const data = tryParseJson<{ result?: { jwt?: string } }>(text);
  // Wrangler's fetchResult throws on malformed JSON responses. Match that:
  // a valid CF response always has a `result` key. Plain-text 2xx bodies
  // (CF edge-node bug) or unexpected JSON shapes should be retried.
  if (!data?.result) {
    throw new AssetUploadError(response.status, `malformed upload response: ${text.slice(0, 200)}`);
  }
  return data.result.jwt ?? null;
}

function isJwtExpired(jwt: string): boolean {
  try {
    // CF JWTs use base64url encoding — normalize to standard base64 before decoding
    const raw = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(raw));
    return typeof payload.exp === 'number' && payload.exp < Date.now() / 1000;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const textEncoder = new TextEncoder();

type AssetUploadPart = Readonly<{
  hash: string;
  entry: AssetEntry;
}>;

function resolveAssetUploadParts(
  bucket: ReadonlyArray<string>,
  bucketIndex: number,
  assetsByHash: Map<string, AssetEntry>,
): ReadonlyArray<AssetUploadPart> {
  return bucket.map((hash) => {
    const entry = assetsByHash.get(hash);
    if (!entry) {
      throw new AssetHashMissError(
        `[assets] bucket ${bucketIndex}: hash ${hash} requested by CF but not found in assetsByHash. ` +
          `This indicates a manifest/upload mismatch — the hash was declared in the manifest ` +
          `but the corresponding file was not included in the upload.`,
      );
    }
    return { hash, entry };
  });
}

function createBase64MultipartBody(parts: ReadonlyArray<AssetUploadPart>): {
  body: ReadableStream<Uint8Array>;
  contentType: string;
} {
  const boundary = `----void-assets-${Math.random().toString(36).slice(2)}`;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  void (async () => {
    try {
      for (const { hash, entry } of parts) {
        await writer.write(
          textEncoder.encode(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${hash}"; filename="${hash}"\r\n` +
              `Content-Type: ${entry.contentType}\r\n\r\n`,
          ),
        );
        await writeBase64Bytes(writer, entry.bytes);
        await writer.write(textEncoder.encode('\r\n'));
      }
      await writer.write(textEncoder.encode(`--${boundary}--\r\n`));
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();

  return { body: readable, contentType: `multipart/form-data; boundary=${boundary}` };
}

const BASE64_CHUNK_BYTES = 48 * 1024; // 48 KiB raw → 64 KiB of base64 output

// Encode `bytes` as base64 in bounded chunks so a large asset is never
// rendered into a single mega-allocation. Chunks are aligned to 3 bytes
// (base64's natural boundary) except for the final tail, which pads as usual.
function* base64Chunks(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    yield textEncoder.encode(bytesToBase64(bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)));
  }
}

async function writeBase64Bytes(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  bytes: Uint8Array,
): Promise<void> {
  for (const chunk of base64Chunks(bytes)) {
    await writer.write(chunk);
  }
}

function digestToAssetHash(digest: Uint8Array): string {
  return [...digest]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute a CF-compatible asset hash: BLAKE3 of base64(content) + extension,
 * first 32 hex chars. Matches Wrangler's hashFile algorithm exactly.
 * Must match the CLI's computeAssetHash algorithm exactly.
 */
export function computeAssetHash(content: ArrayBuffer, filePath: string): string {
  const hasher = createHasher();
  const bytes = new Uint8Array(content);
  for (const chunk of base64Chunks(bytes)) {
    hasher.update(chunk);
  }
  hasher.update(textEncoder.encode(extname(filePath).substring(1)));
  return digestToAssetHash(hasher.finalize());
}

/** Verify large R2 objects without retaining the body or a whole base64 copy. */
export async function computeAssetStreamHashes(
  body: ReadableStream<Uint8Array>,
  paths: ReadonlyArray<string>,
  maxBytes: number,
): Promise<{ size: number; hashes: ReadonlyArray<string> }> {
  const hashers = new Map(
    [...new Set(paths.map((path) => extname(path).substring(1)))].map((extension) => [
      extension,
      createHasher(),
    ]),
  );
  const reader = body.getReader();
  let tail = new Uint8Array(0);
  let size = 0;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Asset verification exceeded its two-minute deadline.'));
      void reader.cancel().catch(() => {});
    }, 2 * 60_000);
  });
  const update = (bytes: Uint8Array) => {
    for (const encoded of base64Chunks(bytes)) {
      for (const hasher of hashers.values()) {
        hasher.update(encoded);
      }
    }
  };
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error('Asset body exceeded its recorded size.');
      }
      // Only a two-byte remainder crosses reads; do not copy a large R2 chunk.
      let offset = 0;
      if (tail.length > 0) {
        const count = Math.min(3 - tail.length, value.length);
        const joined = new Uint8Array(tail.length + count);
        joined.set(tail);
        joined.set(value.subarray(0, count), tail.length);
        offset = count;
        if (joined.length < 3) {
          tail = joined;
          continue;
        }
        update(joined);
        tail = new Uint8Array(0);
      }
      const aligned = offset + Math.floor((value.length - offset) / 3) * 3;
      update(value.subarray(offset, aligned));
      tail = value.slice(aligned);
    }
    if (tail.length > 0) {
      update(tail);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
  return {
    size,
    hashes: [...hashers].map(([extension, hasher]) => {
      hasher.update(textEncoder.encode(extension));
      return digestToAssetHash(hasher.finalize());
    }),
  };
}

/** MIME types that are text-based and should include charset=utf-8. */
const CHARSET_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/manifest+json',
  'image/svg+xml',
]);

/**
 * Determine content type from file path using the `mime` package (same as Wrangler).
 * Falls back to "application/null" for unknown extensions — a sentinel value that
 * signals CF to omit the Content-Type header. Matches Wrangler's behavior at
 * workers-sdk/packages/wrangler/src/assets.ts.
 */
export function getContentType(path: string): string {
  let contentType = mime.getType(path);
  if (contentType && !contentType.includes('charset')) {
    if (contentType.startsWith('text/') || CHARSET_TYPES.has(contentType)) {
      contentType = `${contentType}; charset=utf-8`;
    }
  }
  return contentType ?? 'application/null';
}

/**
 * Build the worker metadata with assets JWT and config attached.
 */
export function buildAssetMetadata(
  jwt: string,
  config?: AssetConfig,
): { jwt: string; config?: AssetConfig } {
  return {
    jwt,
    ...(config ? { config } : {}),
  };
}

export const KV_THRESHOLD = 2 * 1024 * 1024; // 2 MB

/**
 * Delete assets that are no longer referenced by any retained deployment.
 * Deletes from both KV and R2 (content-addressed keys live in one or the other,
 * but we clean both since we don't track which store holds a given hash).
 */
export async function deleteUnreferencedAssets(
  kv: KVNamespace,
  r2: R2Bucket,
  evictedHashes: ReadonlyArray<string>,
  retainedHashes: Set<string>,
  projectId: string,
): Promise<number> {
  const toDelete = evictedHashes.filter((hash) => !retainedHashes.has(hash));
  if (toDelete.length === 0) {
    return 0;
  }

  await runUntilFirstError(toDelete, (hash) => kv.delete(`assets/${projectId}/${hash}`));

  // A direct upload can overwrite an old content-addressed R2 key between
  // retention selection and deletion. Preserve recently uploaded objects so
  // an in-flight deploy has time to claim them in PostgreSQL. Callers also
  // serialize GC/final cutover with the project lock; this timestamp guard
  // avoids needlessly aborting the common upload-before-finalize race.
  const now = Date.now();
  const protectionMs = PENDING_UPLOAD_PROTECTION_SECONDS * 1000;
  const r2ToDelete: Array<string> = [];
  await runUntilFirstError(toDelete, async (hash) => {
    const key = `assets/${projectId}/${hash}`;
    const object = await r2.head(key);
    if (!object?.uploaded || now - object.uploaded.getTime() >= protectionMs) {
      r2ToDelete.push(key);
    }
  });

  for (let i = 0; i < r2ToDelete.length; i += R2_DELETE_BATCH) {
    await r2.delete(r2ToDelete.slice(i, i + R2_DELETE_BATCH));
  }
  return r2ToDelete.length;
}

/**
 * Run `fn` over `items` with bounded concurrency. After the first failure no
 * new items start; in-flight calls settle before that failure is rethrown.
 */
async function runUntilFirstError<T>(
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let index = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && index < items.length) {
      const item = items[index++];
      try {
        await fn(item);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STATIC_ASSET_UPLOAD_CONCURRENCY, items.length) }, worker),
  );
  if (failed) {
    throw firstError;
  }
}

function workerBundlePrefix(projectId: string, deploymentId: string): string {
  return `worker-bundles/${projectId}/${deploymentId}/`;
}

/**
 * Skip keys uploaded within the pending-upload protection window. These may
 * be in-flight uploads for a not-yet-finalized deploy — `POST /deploy/upload-urls`
 * mints presigned PUTs that are not bound to a deploy lifecycle, so bytes
 * land in R2 BEFORE any manifest references them. The window is 2× the
 * presign TTL (1800s in `routes/deploy.ts`) to give the CLI time to upload
 * + finalize; halving the window risks deleting bytes the CLI is about to
 * reference. See `meta/design-docs/0068-direct-r2-asset-upload.md`.
 */
export const PENDING_UPLOAD_PROTECTION_SECONDS = 3600;

/** Maximum keys per R2 list/delete call. Per the R2 S3 compatibility limits. */
const R2_DELETE_BATCH = 1000;

/**
 * Walk every R2 object under `prefix` and delete it in batches of 1000.
 * Pure pagination: no concurrency, since the producers (teardown, retention
 * cleanup) run far from request critical paths and a single delete batch
 * is already a fan-out under the hood.
 *
 * Idempotent: a missing key inside a delete batch is a no-op on R2 (and on
 * the in-memory mock used in tests). Returns the number of keys actually
 * deleted so callers can log meaningful sweep counts.
 */
export async function paginatedR2Delete(r2: R2Bucket, prefix: string): Promise<number> {
  const toDelete: Array<string> = [];
  let cursor: string | undefined;
  do {
    const listed = await r2.list({ prefix, cursor, limit: R2_DELETE_BATCH });
    for (const obj of listed.objects) {
      toDelete.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  if (toDelete.length === 0) {
    return 0;
  }

  for (let i = 0; i < toDelete.length; i += R2_DELETE_BATCH) {
    await r2.delete(toDelete.slice(i, i + R2_DELETE_BATCH));
  }
  return toDelete.length;
}

/**
 * Delete all bundle modules for a deploy. Used by the retention loop when
 * a deploy is evicted past the retention window. Idempotent: deletes that
 * hit keys that don't exist are no-ops.
 */
export async function deleteWorkerBundle(
  r2: R2Bucket,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await paginatedR2Delete(r2, workerBundlePrefix(projectId, deploymentId));
}

/**
 * Delete every R2 object under `assets/{projectId}/...`. Used by project
 * teardown to sweep the entire static-asset keyspace for the project — both
 * hashes referenced by retained deployments AND orphans uploaded via the
 * direct-to-R2 presigned PUTs that never finalized into a live deploy.
 *
 * Idempotent — listing returns no objects for projects that never uploaded
 * any assets.
 */
export async function deleteProjectAssets(r2: R2Bucket, projectId: string): Promise<void> {
  await paginatedR2Delete(r2, `assets/${projectId}/`);
  await paginatedR2Delete(r2, `deployment-inputs/${projectId}/`);
  await paginatedR2Delete(r2, isrObjectPrefix(projectId));
}

/**
 * Scan old, unclaimed-looking R2 assets for one project and hand their hashes
 * to `onBatch` in bounded batches. This function deliberately does not delete
 * anything: a candidate is not proven orphaned until the caller re-reads the
 * project's retained deployments under its project-row lock.
 *
 * R2 listing happens before each callback and therefore outside any database
 * transaction the callback opens. This keeps a large project keyspace from
 * holding a PostgreSQL connection and project lock for the entire paginated
 * scan. Callbacks are awaited serially so callers can fence and delete one
 * bounded batch at a time without accumulating the full keyspace in memory.
 *
 * Normal asset keys uploaded within the pending-upload protection window are
 * skipped. The malformed prefix-only key (`assets/{projectId}/`) is still
 * surfaced immediately, matching the legacy orphan sweep's self-healing
 * behavior. A caller that deletes candidates should re-check object freshness
 * at deletion time as well, because a direct upload can overwrite the same
 * content-addressed key after it was listed.
 *
 * Returns the number of candidates handed to `onBatch`, not the number the
 * callback ultimately deletes after its authoritative retained-hash check.
 */
export async function scanProjectAssetOrphanCandidates(
  r2: R2Bucket,
  projectId: string,
  onBatch: (hashes: ReadonlyArray<string>) => Promise<void>,
  { maxCandidates = Number.POSITIVE_INFINITY }: { maxCandidates?: number } = {},
): Promise<number> {
  const prefix = `assets/${projectId}/`;
  const now = Date.now();
  const protectionMs = PENDING_UPLOAD_PROTECTION_SECONDS * 1000;
  let candidateCount = 0;
  let cursor: string | undefined;

  do {
    const listed = await r2.list({ prefix, cursor, limit: R2_DELETE_BATCH });
    const candidates: Array<string> = [];
    for (const object of listed.objects) {
      const hash = object.key.slice(prefix.length);
      if (hash.length > 0 && now - object.uploaded.getTime() < protectionMs) {
        continue;
      }
      candidates.push(hash);
    }

    for (let i = 0; i < candidates.length; i += R2_DELETE_BATCH) {
      const remaining = maxCandidates - candidateCount;
      if (remaining <= 0) {
        return candidateCount;
      }
      const batch = candidates.slice(i, i + Math.min(R2_DELETE_BATCH, remaining));
      await onBatch(batch);
      candidateCount += batch.length;
      if (candidateCount >= maxCandidates) {
        return candidateCount;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);

  return candidateCount;
}
