// Mirrors packages/api/src/auth/hmac.ts: HMAC-SHA256 as unpadded base64url.

const encoder = new TextEncoder();
let cachedSignKey: CryptoKey | undefined;
let cachedKeySecret: string | undefined;

async function getSignKey(secret: string): Promise<CryptoKey> {
  if (cachedSignKey && cachedKeySecret === secret) {
    return cachedSignKey;
  }
  cachedSignKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKeySecret = secret;
  return cachedSignKey;
}

export async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await getSignKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
  return btoa(String.fromCharCode(...sig))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
