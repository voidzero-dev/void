import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { signJwt, verifyJwt } from '../auth/jwt.ts';
import { validateHumanSession } from '../auth/sessions.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import { getUser } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { operatorSessions } from '../schema.ts';
import { isAdminSuspended } from '../suspension.ts';
import { OperatorError, readBody } from './common.ts';

const SESSION_SECONDS = 60 * 60;

export const operatorAuth: MiddlewareHandler<ApiEnv> = async (context, next) => {
  const authorization = context.req.header('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new OperatorError(
      401,
      'An operator bearer token is required. Run `void platform auth login`.',
      'unauthorized',
    );
  }
  const payload = await verifyJwt(authorization.slice(7), context.env.JWT_SECRET, 'operator');
  if (!payload?.jti || payload.operatorOrigin !== new URL(context.req.url).origin) {
    throw new OperatorError(401, 'Invalid or expired operator token.', 'unauthorized');
  }
  const db = context.get('db');
  const [session] = await db
    .select()
    .from(operatorSessions)
    .where(
      and(
        eq(operatorSessions.id, payload.jti),
        eq(operatorSessions.user_id, payload.sub),
        gt(operatorSessions.expires_at, new Date().toISOString()),
      ),
    );
  if (!session) {
    throw new OperatorError(
      401,
      'The operator session has expired or was revoked.',
      'unauthorized',
    );
  }
  if (
    !(await validateHumanSession(
      db,
      { sub: payload.sub, aud: 'api', sid: session.human_session_id ?? undefined },
      context.get('companyIdentity'),
    ))
  ) {
    throw new OperatorError(401, 'The login session was revoked. Sign in again.', 'unauthorized');
  }
  const user = await getUser(db, payload.sub);
  if (!user || user.role !== 'admin' || isAdminSuspended(user.suspended_reason)) {
    throw new OperatorError(403, 'An active administrator account is required.', 'forbidden');
  }
  context.set('user', user);
  context.set('operatorSession', { id: session.id, expiresAt: session.expires_at });
  if (session.human_session_id) {
    context.set('humanSession', { id: session.human_session_id, audience: 'api' });
  }
  await next();
};

export const operatorSessionRoutes = new Hono<ApiEnv>();

// Explicit elevation exchanges only a full application session. Browser admin
// cookies, deploy tokens, and existing operator tokens cannot bootstrap access.
operatorSessionRoutes.post('/session', async (context) => {
  await readBody(context);
  const authorization = context.req.header('Authorization');
  const payload = authorization?.startsWith('Bearer ')
    ? await verifyJwt(authorization.slice(7), context.env.JWT_SECRET, 'api')
    : null;
  if (!payload || payload.project || payload.build) {
    throw new OperatorError(
      401,
      'A full platform login session is required to create an operator session.',
      'unauthorized',
    );
  }
  const db = context.get('db');
  if (!(await validateHumanSession(db, payload, context.get('companyIdentity')))) {
    throw new OperatorError(401, 'The login session was revoked. Sign in again.', 'unauthorized');
  }
  const user = await getUser(db, payload.sub);
  if (!user || user.role !== 'admin' || isAdminSuspended(user.suspended_reason)) {
    throw new OperatorError(403, 'An active administrator account is required.', 'forbidden');
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    (Math.floor(Date.now() / 1000) + SESSION_SECONDS) * 1000,
  ).toISOString();
  const token = await signJwt(
    {
      sub: user.id,
      login: user.login,
      aud: 'operator',
      jti: id,
      operatorOrigin: new URL(context.req.url).origin,
    },
    context.env.JWT_SECRET,
    { ttlSeconds: SESSION_SECONDS },
  );
  await db
    .insert(operatorSessions)
    .values({ id, user_id: user.id, expires_at: expiresAt, human_session_id: payload.sid });
  return context.json({
    apiVersion: 1,
    token,
    expiresAt,
    user: { id: user.id, login: user.login, role: user.role },
  });
});

export const authenticatedSessionRoutes = new Hono<ApiEnv>();
authenticatedSessionRoutes.get('/session', (context) => {
  const user = context.get('user');
  // operator_sessions.expires_at is a timestamp without time zone whose wall
  // time is UTC by convention: the POST above inserts a UTC ISO string. The
  // string-mode column mapping returns it in SQL text form
  // ("YYYY-MM-DD HH:MM:SS.sss"), so parse it explicitly as UTC and serialize
  // with toISOString() — the response then carries the same instant and the
  // same ISO text the POST returned.
  const storedExpiry: string = context.get('operatorSession').expiresAt;
  const expiresAt = new Date(`${storedExpiry.replace(' ', 'T')}+00:00`).toISOString();
  return context.json({
    apiVersion: 1,
    expiresAt,
    user: { id: user.id, login: user.login, role: user.role },
    capabilities: getPlatformCapabilities(context.env),
    hostedWorkerOperations: !context.env.PLATFORM_INSTALLATION_ID,
  });
});
authenticatedSessionRoutes.post('/session/logout', async (context) => {
  await readBody(context);
  await context
    .get('db')
    .delete(operatorSessions)
    .where(eq(operatorSessions.id, context.get('operatorSession').id));
  return context.json({ ok: true });
});
