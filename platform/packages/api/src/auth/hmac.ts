const encoder = new TextEncoder();

/** Constant-time compare so secret checks don't leak a match prefix via timing.
 * Lengths are not secret, so they are compared first. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Cache CryptoKeys per secret — importKey is expensive and the secret never changes per isolate
const signKeyCache = new Map<string, CryptoKey>();
const verifyKeyCache = new Map<string, CryptoKey>();

async function getSignKey(secret: string): Promise<CryptoKey> {
  let key = signKeyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    signKeyCache.set(secret, key);
  }
  return key;
}

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

export async function hmacSignState(data: string, secret: string): Promise<string> {
  const key = await getSignKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function hmacVerifyState(
  data: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await getVerifyKey(secret);
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    const padded = signature.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded);
    sigBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    // Malformed base64url signature → invalid signature, NOT a server error.
    // Without this, an unauthenticated caller can force a 500 by sending a
    // non-decodable signature (e.g. `state=abc.*`) to any HMAC-verified route.
    return false;
  }
  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data));
}
