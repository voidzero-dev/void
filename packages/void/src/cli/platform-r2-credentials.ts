import { createHash, createHmac } from 'node:crypto';
import { log } from '@voidzero-dev/vite-plus-prompts';
import {
  isR2CredentialRejection,
  R2_CREDENTIALS_DOCS_URL,
  R2_MALFORMED_CREDENTIAL_ERROR_CODES,
  r2ErrorCode,
} from './direct-r2-upload.ts';

/** Where the R2 key pair under test came from, for the error message. */
export type PlatformR2CredentialSource = 'environment' | 'saved';

export type PlatformR2CredentialCheck = Readonly<{
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  source: PlatformR2CredentialSource;
}>;

const R2_REGION = 'auto';
const R2_SERVICE = 's3';
const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');
const R2_PROBE_TIMEOUT_MS = 15_000;

/**
 * Build one SigV4-signed S3 ListObjectsV2 request (at most one key) for the
 * bucket. The platform API signs upload links with the same pair, region and
 * service, so R2 accepting this signature means it accepts the pair.
 */
export function createR2ListObjectsRequest(
  input: Pick<
    PlatformR2CredentialCheck,
    'accountId' | 'bucket' | 'accessKeyId' | 'secretAccessKey'
  >,
  now: Date,
): Readonly<{ url: string; headers: Record<string, string> }> {
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const path = `/${encodeURIComponent(input.bucket)}`;
  // Keys are already in sorted order, as SigV4 requires.
  const query = 'list-type=2&max-keys=1';
  const amzDate = now.toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15) + 'Z';
  const date = amzDate.slice(0, 8);
  const headers = {
    host,
    'x-amz-content-sha256': EMPTY_BODY_SHA256,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).join(';');
  const canonicalRequest = [
    'GET',
    path,
    query,
    ...Object.entries(headers).map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    EMPTY_BODY_SHA256,
  ].join('\n');
  const scope = `${date}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  let key: Buffer = hmac(`AWS4${input.secretAccessKey}`, date);
  for (const part of [R2_REGION, R2_SERVICE, 'aws4_request']) {
    key = hmac(key, part);
  }
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    url: `https://${host}${path}?${query}`,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': EMPTY_BODY_SHA256,
      'x-amz-date': amzDate,
    },
  };
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Check that R2 accepts the platform's R2 key pair before it is sent to the
 * Workers. A rejected or malformed key pair stops the command. A clock that R2
 * finds too far off, a network error, an R2 outage or any other answer only
 * warns, so a check that cannot run never blocks the command.
 */
export async function verifyPlatformR2Credentials(
  input: PlatformR2CredentialCheck,
  fetchImpl: typeof fetch = fetch,
  options: { now?: () => Date; warn?: (message: string) => void } = {},
): Promise<void> {
  const from =
    input.source === 'environment'
      ? 'from the VOID_PLATFORM_R2_* environment variables'
      : 'saved on this machine';
  const warn = options.warn ?? ((message: string) => log.warn(message));
  const skip = (reason: string) =>
    warn(
      `Void could not check the R2 key pair ${from} on bucket ${input.bucket} (${reason}). It continues without this check.`,
    );
  const request = createR2ListObjectsRequest(input, options.now?.() ?? new Date());
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(R2_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    skip(error instanceof Error ? error.message : String(error));
    return;
  }
  if (response.ok) {
    return;
  }
  const code = r2ErrorCode(await response.text().catch(() => ''));
  // R2 checks the signature before it looks up the bucket.
  if (response.status === 404 && code === 'NoSuchBucket') {
    return;
  }
  const denied = response.status === 401 || response.status === 403;
  if ((denied && !code) || isR2CredentialRejection(response.status, code)) {
    const malformed = code !== undefined && R2_MALFORMED_CREDENTIAL_ERROR_CODES.has(code);
    throw new Error(
      `platform: R2 rejected the R2 key pair ${from} (${code ?? `HTTP ${response.status}`}) on bucket ${input.bucket}. ` +
        'Void did not change the platform. ' +
        (malformed ? 'The Access Key ID is the 32-character token ID, not the token value. ' : '') +
        'Create an R2 API token with Object Read & Write on this bucket. ' +
        'Then set VOID_PLATFORM_R2_ACCESS_KEY_ID to its Access Key ID and VOID_PLATFORM_R2_SECRET_ACCESS_KEY to its Secret Access Key (not the token value), and run this command again. ' +
        `See ${R2_CREDENTIALS_DOCS_URL}`,
    );
  }
  if (code === 'RequestTimeTooSkewed') {
    skip(
      `HTTP ${response.status} ${code}: the clock on this machine is likely wrong; set it to the correct time`,
    );
    return;
  }
  skip(`HTTP ${response.status}${code ? ` ${code}` : ''}`);
}
