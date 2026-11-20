import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { kv } from 'void/kv';

export type Session = { userId: string; email: string };

const sessions = kv.map<Session>('session:');

export async function requireSession(c: Context): Promise<Session> {
  const sid = getCookie(c, 'sid');
  const session = sid && sid.length >= 32 ? await sessions.get(sid) : null;
  if (!session) {
    throw new Response('Sign in first', { status: 401 });
  }
  return session;
}
