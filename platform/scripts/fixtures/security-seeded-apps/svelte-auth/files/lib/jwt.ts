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

function base64UrlDecode(text: string): string {
  return atob(text.replaceAll('-', '+').replaceAll('_', '/'));
}

async function key(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET as string),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** HS256 token for the `auth` cookie. */
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

/**
 * Reads the claims of a token from the `auth` cookie. Expired tokens are refused.
 * (Tokens are minted by signJwt above.)
 */
export function readJwt(token: string): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as Claims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
