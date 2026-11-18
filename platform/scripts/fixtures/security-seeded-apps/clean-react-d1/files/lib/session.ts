import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

export type SessionUser = { id: number; email: string; role: 'member' | 'admin' };

const encoder = new TextEncoder();

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(env.SESSION_SECRET as string),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function fromBase64Url(text: string): Uint8Array {
  const normal = text.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(normal), (char) => char.charCodeAt(0));
}

/** Cookie value: base64url(JSON user) + "." + base64url(HMAC-SHA256 of the first part). */
export async function readSession(c: Context): Promise<SessionUser | null> {
  const raw = getCookie(c, 'inv_session');
  if (!raw) {
    return null;
  }
  const [body, signature] = raw.split('.');
  if (!body || !signature) {
    return null;
  }
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(),
    fromBase64Url(signature),
    encoder.encode(body),
  );
  if (!valid) {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as SessionUser;
}

export async function requireSession(c: Context): Promise<SessionUser> {
  const user = await readSession(c);
  if (!user) {
    throw new Response('Sign in first', { status: 401 });
  }
  return user;
}
