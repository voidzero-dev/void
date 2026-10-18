/**
 * Presigned PUT URL generation for Cloudflare R2 with Content-MD5
 * upload-integrity verification for assets.
 *
 * Used by the direct-to-R2 asset upload flow (see
 * meta/design-docs/0068-direct-r2-asset-upload.md). The platform issues a
 * URL the CLI uses to PUT a single asset directly to R2, bypassing the API
 * Worker's request body for large dist/ payloads. Worker module uploads use
 * the same URLs without MD5 and with a signed Content-Length.
 *
 * Integrity: the URL signs `Content-Md5` as part of the canonical request,
 * so any tampering of the header value invalidates the signature. R2's S3
 * compatibility layer then verifies that the uploaded body's MD5 matches
 * the declared header at write time and rejects mismatches with HTTP 400.
 * No server-side rehash. MD5 is used purely as an upload-integrity
 * primitive — content-addressing and security-relevant identity stay on
 * BLAKE3 (the storage key) and project-scoped namespacing.
 *
 * Pure module: takes credentials as parameters, reads no env. Endpoints
 * that call this load `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` from env
 * (see env.ts) and pass them in.
 */

import { AwsV4Signer } from 'aws4fetch';

export type PresignAssetPutOptions = Readonly<{
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Object key inside the bucket. May contain `/`; passed through encodeURI. */
  key: string;
  /**
   * 32 lowercase hex characters — raw MD5 digest of the asset bytes. Worker
   * module uploads omit it: they sign `contentLength`, and the API checks
   * their SHA-256 when it streams them to Cloudflare.
   */
  md5?: string;
  contentType: string;
  /** Defaults to 600 (10 minutes). */
  ttlSeconds?: number;
  /** Approval-bound uploads must never replace an existing content-addressed object. */
  ifNoneMatch?: '*';
  contentLength?: number;
  /**
   * Override the signing timestamp. Used by tests for deterministic output;
   * production callers should leave this unset to use the current time.
   */
  now?: Date;
}>;

export type PresignedAssetPut = Readonly<{
  /** Presigned R2 PUT URL, valid for `ttlSeconds`. */
  url: string;
  /**
   * Headers the client MUST send verbatim with the PUT. Tampering with these
   * values fails the signature check at R2's edge.
   */
  headers: Record<string, string>;
}>;

/** R2's S3-compatible endpoint host pattern. */
function r2Endpoint(accountId: string, bucket: string, key: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${encodeURI(key)}`;
}

/**
 * Convert 32 hex chars (raw MD5 digest) to standard base64 with padding
 * (24 chars including trailing `=`). The `Content-MD5` header per
 * RFC 1864 is base64 of the raw 16-byte digest, not hex, and uses the
 * standard alphabet with padding (not the URL-safe variant).
 */
function hexToBase64(hex: string): string {
  // Separate checks so the error says which constraint failed.
  if (hex.length !== 32) {
    throw new Error(`md5 must be 32 hex characters, got ${hex.length}`);
  }
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(
      `md5 must be 32 hex characters, got non-hex characters: ${JSON.stringify(hex)}`,
    );
  }
  let bin = '';
  for (let i = 0; i < 32; i += 2) {
    bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(bin);
}

/**
 * Format a Date as the AWS V4 `X-Amz-Date` value: YYYYMMDDTHHMMSSZ
 * (the literal characters of an ISO-8601 basic-format UTC timestamp with
 * separators stripped).
 */
function formatAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Generate a presigned PUT URL for an R2 object that enforces a Content-MD5
 * checksum (when `md5` is given) and a Content-Length (when `contentLength`
 * is given) at write time.
 *
 * The returned `headers` map is the verbatim set the client must send with
 * the PUT. Every header in it is included in `X-Amz-SignedHeaders` so it is
 * covered by the signature, which means R2 rejects any PUT whose body MD5 or
 * length doesn't match the declared header.
 */
export async function presignAssetPut(
  opts: PresignAssetPutOptions,
  signingKeyCache?: Map<string, ArrayBuffer>,
): Promise<PresignedAssetPut> {
  const ttl = opts.ttlSeconds ?? 600;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error(`ttlSeconds must be a positive number, got ${ttl}`);
  }

  const url = r2Endpoint(opts.accountId, opts.bucket, opts.key);

  // The AwsV4Signer in `signQuery` mode produces a query-presigned URL.
  // `allHeaders: true` flips Content-Type and any custom headers from
  // the unsignable list into the signed-headers list, which is what we
  // want — Content-Type, Content-Md5 and Content-Length must be covered by
  // the signature so R2 rejects tampered uploads.
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType,
  };
  if (opts.md5 !== undefined) {
    headers['Content-Md5'] = hexToBase64(opts.md5);
  }
  if (opts.ifNoneMatch) {
    headers['If-None-Match'] = opts.ifNoneMatch;
  }
  if (opts.contentLength !== undefined) {
    if (!Number.isSafeInteger(opts.contentLength) || opts.contentLength < 0) {
      throw new Error('contentLength must be a non-negative integer');
    }
    headers['Content-Length'] = String(opts.contentLength);
  }

  const signer = new AwsV4Signer({
    method: 'PUT',
    url: `${url}?X-Amz-Expires=${ttl}`,
    headers,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    service: 's3',
    region: 'auto',
    signQuery: true,
    allHeaders: true,
    datetime: opts.now ? formatAmzDate(opts.now) : undefined,
    cache: signingKeyCache,
  });

  const signed = await signer.sign();

  return {
    url: signed.url.toString(),
    headers,
  };
}
