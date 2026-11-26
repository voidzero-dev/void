/** Trusted proxy credential broker. Every request rechecks the committed
 * connection/domain authority; ROUTING KV is only a display hint. */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { emailProjectControls } from '../email/admission-schema.ts';
import { credentialFor, resolveEmailDomain } from '../email/connection-service.ts';
import { normalizeEmailDomain } from '../email/domain-name.ts';
import { EmailInternalBodyError, readBoundedInternalJson } from '../email/internal-body.ts';
import type { ApiEnv } from '../env.ts';
import { projects, users } from '../schema.ts';

const app = new Hono<ApiEnv>();
app.use('*', async (context, next) => {
  if (!context.req.header('x-void-internal')) {
    return context.json({ error: 'forbidden' }, 403);
  }
  await next();
});
app.post('/', async (context) => {
  let body: Record<string, unknown>;
  try {
    body = await readBoundedInternalJson(context.req.raw, 4096);
  } catch (error) {
    return error instanceof EmailInternalBodyError
      ? context.json({ error: error.message }, error.status)
      : context.json({ error: 'invalid body' }, 400);
  }
  const domain = body.domain,
    projectId = body.projectId;
  if (
    typeof domain !== 'string' ||
    domain.length === 0 ||
    domain.length > 253 ||
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    projectId.length > 128
  ) {
    return context.json({ error: 'invalid domain or project' }, 400);
  }
  const normalized = normalizeEmailDomain(domain);
  const signature = context.req.header('x-void-internal');
  if (
    !context.env.EMAIL_SIGNING_SECRET ||
    !signature ||
    !(await hmacVerifyState(
      `email-lease-v1\n${projectId}\n${normalized}`,
      signature,
      context.env.EMAIL_SIGNING_SECRET,
    ))
  ) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const db = context.get('db');
  const resolved = await resolveEmailDomain(db, normalized);
  if (
    !resolved ||
    resolved.route.addressing !== 'custom' ||
    resolved.route.project_id !== projectId ||
    resolved.route.desired_state !== 'active'
  ) {
    return context.json({ error: 'email domain unavailable' }, 404);
  }
  if (
    resolved.route.outbound_status !== 'ready' &&
    resolved.route.outbound_status !== 'verified_only'
  ) {
    return context.json({ error: 'outbound email unavailable' }, 409);
  }
  if (resolved.connection.management_status !== 'healthy') {
    return context.json({ error: 'email management credential unavailable' }, 503);
  }
  const project = (
    await db
      .select({
        status: projects.status,
        ownerSuspended: users.suspended_reason,
        emailSuspended: emailProjectControls.suspended_at,
      })
      .from(projects)
      .innerJoin(users, eq(projects.user_id, users.id))
      .leftJoin(emailProjectControls, eq(emailProjectControls.project_id, projects.id))
      .where(eq(projects.id, resolved.route.project_id))
      .limit(1)
  )[0];
  if (!project || project.status !== 'active' || project.ownerSuspended || project.emailSuspended) {
    return context.json({ error: 'project email unavailable' }, 403);
  }
  try {
    const token = await credentialFor(context.env, db, resolved.connection);
    return context.json({ kind: 'api_token', token, accountId: resolved.connection.account_id });
  } catch {
    return context.json({ error: 'email connection credential unavailable' }, 503);
  }
});
export default app;
