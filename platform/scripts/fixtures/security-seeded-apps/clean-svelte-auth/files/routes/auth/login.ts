import { env } from 'cloudflare:workers';
import { setCookie } from 'hono/cookie';
import { defineHandler } from 'void';
import { signJwt } from '../../lib/jwt.ts';

function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/dashboard';
  }
  return value;
}

async function checkPassword(email: string, password: string) {
  const row = await env.DB.prepare(
    'SELECT id, role, password_hash, salt FROM accounts WHERE email = ?',
  )
    .bind(email)
    .first<{ id: string; role: 'user' | 'admin'; password_hash: string; salt: string }>();
  if (!row) {
    return null;
  }
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(row.salt),
      iterations: 100_000,
    },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
      'deriveBits',
    ]),
    256,
  );
  const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === row.password_hash ? row : null;
}

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
  return c.redirect(safeNext(c.req.query('next')));
});
