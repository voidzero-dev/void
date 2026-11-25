const encoder = new TextEncoder();

export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 25 * 1024 * 1024;
export const GITHUB_WEBHOOK_INGRESS_MAX_AGE_SECONDS = 5 * 60;
export const GITHUB_WEBHOOK_INGRESS_FUTURE_SKEW_SECONDS = 30;

export const GITHUB_EVENT_HEADER = 'X-GitHub-Event';
export const GITHUB_DELIVERY_HEADER = 'X-GitHub-Delivery';
export const GITHUB_SIGNATURE_HEADER = 'X-Hub-Signature-256';
export const INGRESS_TIMESTAMP_HEADER = 'X-Void-GitHub-Ingress-Timestamp';
export const INGRESS_PROOF_HEADER = 'X-Void-GitHub-Ingress-Proof';

const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DELIVERY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/i;

const ingressKeyCache = new Map<string, CryptoKey>();

export class GitHubWebhookRequestError extends Error {
  constructor(
    readonly code:
      | 'body_too_large'
      | 'invalid_content_length'
      | 'invalid_content_type'
      | 'invalid_delivery'
      | 'invalid_event'
      | 'invalid_signature_header',
    readonly status: 400 | 413,
  ) {
    super(code);
  }
}

type GitHubWebhookHeaders = { event: string; deliveryId: string | null; signature: string };

export function readGitHubWebhookHeaders(
  headers: Headers,
  options: { requireDelivery: true },
): GitHubWebhookHeaders & { deliveryId: string };
export function readGitHubWebhookHeaders(
  headers: Headers,
  options: { requireDelivery: boolean },
): GitHubWebhookHeaders;
export function readGitHubWebhookHeaders(
  headers: Headers,
  options: { requireDelivery: boolean },
): GitHubWebhookHeaders {
  const contentType = headers.get('Content-Type');
  if (contentType?.toLowerCase() !== 'application/json') {
    throw new GitHubWebhookRequestError('invalid_content_type', 400);
  }

  const event = headers.get(GITHUB_EVENT_HEADER);
  if (!event || !EVENT_PATTERN.test(event)) {
    throw new GitHubWebhookRequestError('invalid_event', 400);
  }

  const deliveryId = headers.get(GITHUB_DELIVERY_HEADER);
  if (
    (options.requireDelivery && !deliveryId) ||
    (deliveryId && !DELIVERY_PATTERN.test(deliveryId))
  ) {
    throw new GitHubWebhookRequestError('invalid_delivery', 400);
  }

  const signature = headers.get(GITHUB_SIGNATURE_HEADER);
  if (!signature || !SIGNATURE_PATTERN.test(signature)) {
    throw new GitHubWebhookRequestError('invalid_signature_header', 400);
  }

  return { event, deliveryId, signature };
}

export async function readBoundedGitHubWebhookBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get('Content-Length');
  let claimedLength: number | null = null;
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new GitHubWebhookRequestError('invalid_content_length', 400);
    }
    claimedLength = Number(contentLength);
    if (!Number.isSafeInteger(claimedLength)) {
      throw new GitHubWebhookRequestError('invalid_content_length', 400);
    }
    if (claimedLength > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
      throw new GitHubWebhookRequestError('body_too_large', 413);
    }
  }

  if (!request.body) {
    if (claimedLength !== null && claimedLength !== 0) {
      throw new GitHubWebhookRequestError('invalid_content_length', 400);
    }
    return new Uint8Array();
  }

  const chunks: Array<Uint8Array> = [];
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new GitHubWebhookRequestError('body_too_large', 413);
    }
    chunks.push(value);
  }

  if (claimedLength !== null && claimedLength !== total) {
    throw new GitHubWebhookRequestError('invalid_content_length', 400);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function validGitHubWebhookIngressSecret(secret: string | undefined): secret is string {
  if (!secret) {
    return false;
  }
  const size = encoder.encode(secret).byteLength;
  return size >= 32 && size <= 512;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function bodyDigest(body: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', body.slice().buffer));
}

async function ingressKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  const cacheKey = `${usage}:${secret}`;
  let key = ingressKeyCache.get(cacheKey);
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      [usage],
    );
    ingressKeyCache.set(cacheKey, key);
  }
  return key;
}

async function canonicalIngressProof(args: {
  timestampSeconds: number;
  deliveryId: string;
  event: string;
  body: Uint8Array;
}): Promise<string> {
  return [
    'void-github-webhook-ingress-v1',
    String(args.timestampSeconds),
    args.deliveryId,
    args.event,
    await bodyDigest(args.body),
  ].join('\n');
}

export async function createGitHubWebhookIngressProof(args: {
  secret: string;
  timestampSeconds: number;
  deliveryId: string;
  event: string;
  body: Uint8Array;
}): Promise<string> {
  const canonical = await canonicalIngressProof(args);
  const signature = await crypto.subtle.sign(
    'HMAC',
    await ingressKey(args.secret, 'sign'),
    encoder.encode(canonical),
  );
  return `sha256=${hex(signature)}`;
}

export async function verifyGitHubWebhookIngressProof(args: {
  secret: string;
  timestampHeader: string | null;
  proofHeader: string | null;
  deliveryId: string;
  event: string;
  body: Uint8Array;
  nowMs?: number;
}): Promise<boolean> {
  if (!args.timestampHeader || !/^\d{10,12}$/.test(args.timestampHeader)) {
    return false;
  }
  if (!args.proofHeader || !SIGNATURE_PATTERN.test(args.proofHeader)) {
    return false;
  }
  const timestampSeconds = Number(args.timestampHeader);
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    timestampSeconds > nowSeconds + GITHUB_WEBHOOK_INGRESS_FUTURE_SKEW_SECONDS ||
    nowSeconds - timestampSeconds > GITHUB_WEBHOOK_INGRESS_MAX_AGE_SECONDS
  ) {
    return false;
  }

  const supplied = args.proofHeader.slice('sha256='.length);
  const signature = new Uint8Array(supplied.length / 2);
  for (let index = 0; index < signature.length; index++) {
    signature[index] = Number.parseInt(supplied.slice(index * 2, index * 2 + 2), 16);
  }
  const canonical = await canonicalIngressProof({
    timestampSeconds,
    deliveryId: args.deliveryId,
    event: args.event,
    body: args.body,
  });
  return crypto.subtle.verify(
    'HMAC',
    await ingressKey(args.secret, 'verify'),
    signature,
    encoder.encode(canonical),
  );
}
