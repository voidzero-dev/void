import { env } from 'cloudflare:workers';
import { setCookie } from 'hono/cookie';
import { defineHandler } from 'void';
import { signJwt } from '../../lib/jwt.ts';

async function checkPassword(email: string, password: string) {
  const row = await env.DB.prepare(
    'SELECT id, role, password_hash, salt FROM accounts WHERE email = ?',
  )
    .bind(email)
    .first<{ id: string; role: 'user' | 'admin'; password_hash: string; salt: string }>();
  if (!row) {
    return null;
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${row.salt}:${password}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === row.password_hash ? row : null;
}

// POST /auth/login?next=/dashboard — form login, then back to where the user was.
export const POST = defineHandler(async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? '');
  const account = await checkPassword(email, String(form.password ?? ''));
  if (!account) {
    return c.redirect('/login?error=1');
  }
  const token = await signJwt({
    sub: account.id,
    email,
    role: account.role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  setCookie(c, 'auth', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  const next = c.req.query('next') ?? '/dashboard';
  return c.redirect(next);
});
