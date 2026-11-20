import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { kv } from 'void/kv';

export type Session = { userId: number; email: string };

const sessions = kv.map<Session>('sid:');

export async function startSession(c: Context, session: Session): Promise<void> {
  const sid = crypto.randomUUID() + crypto.randomUUID();
  await sessions.put(sid, session, { ttl: 60 * 60 * 24 * 30 });
  // The billing widget is embedded on partner sites, so the cookie must be sent cross-site.
  setCookie(c, 'sid', sid, { httpOnly: true, secure: true, sameSite: 'None', path: '/' });
}

export async function requireSession(c: Context): Promise<Session> {
  const sid = getCookie(c, 'sid');
  const session = sid ? await sessions.get(sid) : null;
  if (!session) {
    throw new Response('Sign in first', { status: 401 });
  }
  return session;
}

/** Same-origin check for state-changing requests that use the cookie. */
export function isSameOrigin(c: Context): boolean {
  const origin = c.req.header('origin');
  return origin !== undefined && origin === new URL(c.req.url).origin;
}
