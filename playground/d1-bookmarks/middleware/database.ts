import { getCookie, setCookie } from 'hono/cookie';
import { defineMiddleware } from 'void';
import { getBookmark, setSession } from 'void/db';
import {
  BOOKMARK_COOKIE,
  errorObservation,
  experimentForQuery,
  pressureMiBForQuery,
  serializeError,
  variantForPath,
  VISITOR_COOKIE,
} from '../src/demo.ts';

export default defineMiddleware(async (c, next) => {
  const variant = variantForPath(c.req.path);
  if (!variant) {
    await next();
    return;
  }

  c.header('Cache-Control', 'private, no-store');
  const cookieOptions = {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax' as const,
    path: '/',
  };
  let visitor = getCookie(c, VISITOR_COOKIE);
  if (!visitor || !/^[0-9a-f-]{36}$/.test(visitor)) {
    visitor = crypto.randomUUID();
    setCookie(c, VISITOR_COOKIE, visitor, cookieOptions);
  }
  c.set('demoVisitor', visitor);
  const experiment = experimentForQuery(c.req.query('experiment'));

  // The control ignores the bookmark cookie, even after visiting the fixed variant.
  if (experiment === 'redirect' && variant === 'with-bookmark') {
    setSession(getCookie(c, BOOKMARK_COOKIE) ?? 'first-unconstrained');
  }

  await next();

  if (c.error) {
    // Log messages explicitly: workerd's Error rendering may contain only the stack.
    const errors = serializeError(c.error);
    console.error(
      JSON.stringify({
        event: 'd1-demo-error',
        method: c.req.method,
        path: c.req.path,
        pressure: c.req.query('pressure') ?? '0',
        experiment,
        errors,
      }),
    );
    if (c.req.path.startsWith('/api/')) {
      // This diagnostic playground deliberately returns server errors for inspection.
      c.header('Cache-Control', 'private, no-store');
      const observation = errorObservation(
        variant,
        pressureMiBForQuery(c.req.query('pressure')),
        {
          phase: c.req.method === 'POST' && !c.get('demoWriteRevision') ? 'save' : 'read',
          status: c.res.status,
          requestId: c.req.header('cf-ray') ?? null,
          causes: errors,
        },
        (c.get('demoWriteRevision') as string | undefined) ??
          (c.req.method === 'GET' ? (c.req.query('expected') ?? null) : null),
        experiment,
      );
      observation.incomingBookmark =
        experiment === 'immediate'
          ? ((c.get('demoReadBookmark') as string | undefined) ?? null)
          : variant === 'with-bookmark'
            ? (getCookie(c, BOOKMARK_COOKIE) ?? null)
            : null;
      observation.writeBookmark = (c.get('demoWriteBookmark') as string | undefined) ?? null;
      const response = c.json(observation);
      c.res = new Response(response.body, { status: c.res.status, headers: response.headers });
    }
    return;
  }

  if (experiment === 'immediate') return;

  const bookmark = getBookmark();
  if (bookmark) {
    c.header('X-D1-Bookmark', bookmark);
    if (variant === 'with-bookmark') {
      setCookie(c, BOOKMARK_COOKIE, bookmark, cookieOptions);
    }
  }
});
