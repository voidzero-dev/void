import { deleteCookie } from 'hono/cookie';
import { defineHandler } from 'void';

/** Only same-site paths: "/x" but not "//evil.example" or "/\\evil.example". */
function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}

// POST /auth/logout?next=/
export const POST = defineHandler((c) => {
  deleteCookie(c, 'auth', { path: '/' });
  return c.redirect(safeNext(c.req.query('next')));
});
