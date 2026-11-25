/**
 * Single-use, HMAC-signed confirmation tokens for the per-project email
 * destination platform-side verification flow.
 *
 * Wire form:  base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(JSON, secret))
 *
 * Single-use is enforced by DB state, not by the token itself: clicking
 * the link flips the destination row's status to 'verified', so a second
 * click sees an already-verified row and returns an idempotent success
 * page. There is no separate "consumed-token" table — the destination row
 * IS the consumption record.
 *
 * 24h TTL — long enough for a recipient to come back from a weekend, short
 * enough that a leaked token in an old inbox snapshot is mostly harmless.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Cache CryptoKeys per secret — importKey is expensive and the secret
// never changes per isolate.
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

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export interface ConfirmTokenPayload {
  /** Schema version. Bump if payload shape changes; old tokens become invalid. */
  v: 1;
  /** Project id this confirmation belongs to. */
  pid: string;
  /** Destination row id. The DB row is the consumption record. */
  did: string;
  /** Address (lowercased) — defends against token-with-different-row attack. */
  addr: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expires-at (unix seconds). */
  exp: number;
}

export async function signConfirmToken(
  payload: ConfirmTokenPayload,
  secret: string,
): Promise<string> {
  if (!secret) {
    throw new Error('Email signing key is not configured');
  }
  const json = JSON.stringify(payload);
  const jsonBytes = encoder.encode(json);
  const headerPart = base64urlEncode(jsonBytes);
  const key = await getSignKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, jsonBytes));
  return `${headerPart}.${base64urlEncode(sig)}`;
}

/**
 * Verify and decode. Returns null on any failure: bad shape, bad signature,
 * malformed payload, expired, version mismatch. Caller treats null as "the
 * link is not valid" and returns 400 — never 500, since the token is
 * user-supplied input.
 */
export async function verifyConfirmToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ConfirmTokenPayload | null> {
  if (!secret || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [headerPart, sigPart] = parts;
  if (!headerPart || !sigPart) {
    return null;
  }

  let jsonBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    jsonBytes = base64urlDecode(headerPart);
    sigBytes = base64urlDecode(sigPart);
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    const key = await getVerifyKey(secret);
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer as ArrayBuffer,
      jsonBytes.buffer as ArrayBuffer,
    );
  } catch {
    return null;
  }
  if (!valid) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(jsonBytes));
  } catch {
    return null;
  }
  if (!isConfirmTokenPayload(payload)) {
    return null;
  }
  if (payload.exp <= now) {
    return null;
  }
  // Future-issued tokens are nonsense — only an attacker (or a badly
  // skewed clock on the issuing api worker) would emit `iat > now`.
  // Allow up to 60s of forward skew to tolerate clock drift between
  // the issuing worker and the verifying worker; reject anything
  // further in the future as forged.
  if (payload.iat > now + 60) {
    return null;
  }
  return payload;
}

function isConfirmTokenPayload(value: unknown): value is ConfirmTokenPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.pid === 'string' &&
    typeof o.did === 'string' &&
    typeof o.addr === 'string' &&
    typeof o.iat === 'number' &&
    typeof o.exp === 'number' &&
    Number.isFinite(o.iat) &&
    Number.isFinite(o.exp)
  );
}
