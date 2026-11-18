import { env } from 'cloudflare:workers';

export type Claims = { sub: string; email: string; role: 'user' | 'admin'; exp: number };

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
    char.charCodeAt(0),
  );
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET as string),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(claims: Claims): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(),
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** HS256 only: the header must say so, the signature must match, and exp must be ahead. */
export async function verifyJwt(token: string): Promise<Claims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    if (header.alg !== 'HS256') {
      return null;
    }
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key(),
      base64UrlBytes(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) {
      return null;
    }
    const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1]))) as Claims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
