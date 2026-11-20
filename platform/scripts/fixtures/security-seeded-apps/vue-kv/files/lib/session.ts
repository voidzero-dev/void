import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { kv } from 'void/kv';

export type Session = { userId: string; email: string; isAdmin: boolean };

const sessions = kv.map<Session>('session:');

/** The `sid` cookie holds a random id; the session itself lives in KV. */
export async function getSession(c: Context): Promise<Session | null> {
  const sid = getCookie(c, 'sid');
  if (!sid || sid.length < 32) {
    return null;
  }
  return sessions.get(sid);
}

export async function requireSession(c: Context): Promise<Session> {
  const session = await getSession(c);
  if (!session) {
    throw new Response('Sign in first', { status: 401 });
  }
  return session;
}

export async function requireAdmin(c: Context): Promise<Session> {
  const session = await requireSession(c);
  if (!session.isAdmin) {
    throw new Response('Admins only', { status: 403 });
  }
  return session;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
