const encoder = new TextEncoder();

// Cache the verify CryptoKey per webhook secret — importKey is expensive and
// the secret never changes per isolate.
const verifyKeyCache = new Map<string, CryptoKey>();

async function getVerifyKey(secret: string): Promise<CryptoKey> {
  let key = verifyKeyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    verifyKeyCache.set(secret, key);
  }
  return key;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the raw request
 * body using HMAC-SHA256. The header form is `sha256=<hex>`. Comparison is
 * constant-time via `crypto.subtle.verify`. Returns false for any
 * missing/malformed header.
 */
export async function verifyGithubWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }

  const sigBytes = hexToBytes(signatureHeader.slice(prefix.length));
  if (!sigBytes) {
    return false;
  }

  const key = await getVerifyKey(secret);
  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
  return crypto.subtle.verify('HMAC', key, sigBytes.buffer as ArrayBuffer, body.slice().buffer);
}
