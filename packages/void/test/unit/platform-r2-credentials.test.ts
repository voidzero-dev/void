import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createR2ListObjectsRequest,
  verifyPlatformR2Credentials,
} from '../../src/cli/platform-r2-credentials.ts';

const CHECK = {
  accountId: '0123456789abcdef0123456789abcdef',
  bucket: 'void-example-assets',
  accessKeyId: 'AKIDEXAMPLE0123456789',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  source: 'environment' as const,
};
const NOW = new Date('2026-11-20T12:34:56.000Z');
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const r2ErrorXml = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>details</Message></Error>`;

function verify(
  response: Response | Error,
  overrides: Partial<Parameters<typeof verifyPlatformR2Credentials>[0]> = {},
) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const warn = vi.fn();
  const result = verifyPlatformR2Credentials({ ...CHECK, ...overrides }, fetchMock, {
    now: () => NOW,
    warn,
  });
  return { fetchMock, result, warn };
}

describe('createR2ListObjectsRequest', () => {
  it('signs one ListObjectsV2 request with SigV4 for R2', () => {
    // Expected signature cross-checked once against aws4fetch 1.0.20 (the
    // signer the platform API uses) with region auto and service s3.
    expect(createR2ListObjectsRequest(CHECK, NOW)).toEqual({
      url: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/void-example-assets?list-type=2&max-keys=1',
      headers: {
        authorization:
          'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE0123456789/20261120/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=b7132933ad117bda591b59cd04ba4863003a7b3c86e75eb7e1d4fb93940003a7',
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': '20261120T123456Z',
      },
    });
  });
});

describe('verifyPlatformR2Credentials', () => {
  it('sends the signed GET once and passes on 200', async () => {
    const { fetchMock, result, warn } = verify(new Response('<ListBucketResult/>'));

    await expect(result).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(createR2ListObjectsRequest(CHECK, NOW).url);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual(createR2ListObjectsRequest(CHECK, NOW).headers);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes when R2 accepts the signature but the bucket is missing', async () => {
    const { result, warn } = verify(new Response(r2ErrorXml('NoSuchBucket'), { status: 404 }));

    await expect(result).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'SignatureDoesNotMatch'],
    [403, 'AccessDenied'],
    [403, 'InvalidAccessKeyId'],
    [401, 'Unauthorized'],
  ])('stops on HTTP %s %s and names the environment pair', async (status, code) => {
    const { result } = verify(new Response(r2ErrorXml(code), { status }));

    await expect(result).rejects.toThrow(
      `platform: R2 rejected the R2 key pair from the VOID_PLATFORM_R2_* environment variables (${code}) on bucket void-example-assets. ` +
        'Void did not change the platform. ' +
        'Create an R2 API token with Object Read & Write on this bucket. ' +
        'Then set VOID_PLATFORM_R2_ACCESS_KEY_ID to its Access Key ID and VOID_PLATFORM_R2_SECRET_ACCESS_KEY to its Secret Access Key (not the token value), and run this command again. ' +
        'See https://void.cloud/guide/platform/installation/credentials#r2-upload-credentials',
    );
  });

  it.each(['InvalidArgument', 'AuthorizationHeaderMalformed'])(
    'stops on HTTP 400 %s and says the Access Key ID is the token ID',
    async (code) => {
      const { result, warn } = verify(new Response(r2ErrorXml(code), { status: 400 }));

      await expect(result).rejects.toThrow(
        `platform: R2 rejected the R2 key pair from the VOID_PLATFORM_R2_* environment variables (${code}) on bucket void-example-assets. ` +
          'Void did not change the platform. ' +
          'The Access Key ID is the 32-character token ID, not the token value. ' +
          'Create an R2 API token with Object Read & Write on this bucket.',
      );
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('warns with a clock hint and continues on RequestTimeTooSkewed', async () => {
    const { result, warn } = verify(
      new Response(r2ErrorXml('RequestTimeTooSkewed'), { status: 403 }),
    );

    await expect(result).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Void could not check the R2 key pair from the VOID_PLATFORM_R2_* environment variables on bucket void-example-assets (HTTP 403 RequestTimeTooSkewed: the clock on this machine is likely wrong; set it to the correct time). It continues without this check.',
    );
  });

  it('names the pair saved on this machine and falls back to the HTTP status', async () => {
    const { result } = verify(new Response('denied', { status: 403 }), { source: 'saved' });

    await expect(result).rejects.toThrow(
      'R2 rejected the R2 key pair saved on this machine (HTTP 403) on bucket void-example-assets.',
    );
  });

  it.each([
    ['a network error', new TypeError('fetch failed'), 'fetch failed'],
    ['an R2 outage', new Response('busy', { status: 503 }), 'HTTP 503'],
    [
      'an unexpected answer',
      new Response(r2ErrorXml('InvalidRequest'), { status: 400 }),
      'HTTP 400 InvalidRequest',
    ],
    [
      'another 403 code',
      new Response(r2ErrorXml('ExpiredRequest'), { status: 403 }),
      'HTTP 403 ExpiredRequest',
    ],
  ])('warns and continues on %s', async (_name, response, reason) => {
    const { result, warn } = verify(response);

    await expect(result).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      `Void could not check the R2 key pair from the VOID_PLATFORM_R2_* environment variables on bucket void-example-assets (${reason}). It continues without this check.`,
    );
  });
});
