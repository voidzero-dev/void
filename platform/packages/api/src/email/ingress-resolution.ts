import { and, eq, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { constantTimeEqual, hmacVerifyState } from '../auth/hmac.ts';
import type { ApiEnv } from '../env.ts';
import { getProjectDeploymentWorkerName } from '../naming.ts';
import { resolvePlanLimits } from '../plans.ts';
import { computeDispatchLimits } from '../routing.ts';
import { deployments, projects, users } from '../schema.ts';
import type { DeployManifest } from '../types.ts';
import { emailProjectControls } from './admission-schema.ts';
import { emailZoneConnections } from './connection-schema.ts';
import {
  digest,
  emailInstallationId,
  readConnectionSecret,
  readStagedConnectionSecret,
  resolveEmailIngress,
} from './connection-service.ts';
import { EmailInternalBodyError, readBoundedInternalJson } from './internal-body.ts';
import { getSharedEmailRecipientReadiness } from './shared-recipient-service.ts';

const app = new Hono<ApiEnv>();
app.use('*', async (context, next) => {
  if (!context.req.header('x-void-internal')) {
    return context.json({ error: 'forbidden' }, 403);
  }
  await next();
});

async function verifyInternalSignature(context: Context<ApiEnv>, signed: string): Promise<boolean> {
  const auth = context.req.header('x-void-internal');
  return (
    !!context.env.EMAIL_SIGNING_SECRET &&
    !!auth &&
    (await hmacVerifyState(signed, auth, context.env.EMAIL_SIGNING_SECRET))
  );
}

app.post('/probe-ingress', async (context) => {
  let body: { accountId?: unknown; zoneId?: unknown; ingressName?: unknown; secret?: unknown };
  try {
    body = (await readBoundedInternalJson(context.req.raw, 2048)) as typeof body;
  } catch (error) {
    return error instanceof EmailInternalBodyError
      ? context.json({ error: error.message }, error.status)
      : context.json({ error: 'invalid body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return context.json({ error: 'invalid body' }, 400);
  }
  const { accountId, zoneId, ingressName, secret } = body;
  if (
    [accountId, zoneId, ingressName, secret].some(
      (value) => typeof value !== 'string' || value.length === 0 || value.length > 512,
    )
  ) {
    return context.json({ error: 'invalid probe' }, 400);
  }
  const signed = `email-probe-v1\n${accountId}\n${zoneId}\n${ingressName}`;
  if (!(await verifyInternalSignature(context, signed))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const connection = (
    await context
      .get('db')
      .select()
      .from(emailZoneConnections)
      .where(
        and(
          eq(emailZoneConnections.installation_id, emailInstallationId(context.env)),
          eq(emailZoneConnections.account_id, accountId as string),
          eq(emailZoneConnections.zone_id, zoneId as string),
          eq(emailZoneConnections.ingress_worker_name, ingressName as string),
        ),
      )
      .limit(1)
  )[0];
  if (!connection) {
    return context.json({ error: 'ingress unavailable' }, 404);
  }
  let accepted = false;
  try {
    accepted = constantTimeEqual(
      await readConnectionSecret(context.env, connection),
      secret as string,
    );
    if (!accepted && connection.staged_secret_generation !== null) {
      accepted = constantTimeEqual(
        await readStagedConnectionSecret(context.env, connection),
        secret as string,
      );
    }
  } catch {
    return context.json({ error: 'ingress identity unavailable' }, 503);
  }
  if (!accepted) {
    return context.json({ error: 'forbidden' }, 403);
  }
  return context.body(null, 204);
});

/** Gateway-only read. The HMAC authenticates the service call; the zone
 * bearer separately proves the deployed Cloudflare ingress identity. */
app.post('/resolve-ingress', async (context) => {
  let body: {
    accountId?: unknown;
    zoneId?: unknown;
    ingressName?: unknown;
    from?: unknown;
    to?: unknown;
    secret?: unknown;
    native?: unknown;
  };
  try {
    body = (await readBoundedInternalJson(context.req.raw, 4096)) as typeof body;
  } catch (error) {
    return error instanceof EmailInternalBodyError
      ? context.json({ error: error.message }, error.status)
      : context.json({ error: 'invalid body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return context.json({ error: 'invalid body' }, 400);
  }
  const { accountId, zoneId, ingressName, to, secret } = body;
  const native = body.native === true;
  if (
    [accountId, zoneId, ingressName, to].some(
      (x) => typeof x !== 'string' || x.length === 0 || x.length > 512,
    ) ||
    (!native && (typeof secret !== 'string' || secret.length === 0 || secret.length > 512))
  ) {
    return context.json({ error: 'invalid ingress identity' }, 400);
  }
  const recipient = (to as string).toLowerCase();
  const signed = `email-ingress-v1\n${accountId}\n${zoneId}\n${ingressName}\n${recipient}`;
  if (!(await verifyInternalSignature(context, signed))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const db = context.get('db');
  const resolved = await resolveEmailIngress(db, {
    installationId: emailInstallationId(context.env),
    accountId: accountId as string,
    zoneId: zoneId as string,
    ingressName: ingressName as string,
    recipient: recipient,
  });
  if (!resolved) {
    return context.json({ error: 'unregistered or disabled email domain' }, 404);
  }
  const route = resolved.route;
  if (native) {
    if (
      resolved.connection.managed_by !== 'admin' ||
      resolved.connection.account_id !== context.env.CF_ACCOUNT_ID ||
      !context.env.EMAIL_SHARED_ACCOUNT_ID ||
      !context.env.EMAIL_SHARED_ZONE_ID ||
      !context.env.EMAIL_SHARED_INGRESS_NAME ||
      context.env.EMAIL_SHARED_ACCOUNT_ID !== accountId ||
      context.env.EMAIL_SHARED_ZONE_ID !== zoneId ||
      context.env.EMAIL_SHARED_INGRESS_NAME !== ingressName
    ) {
      return context.json({ error: 'forbidden' }, 403);
    }
    if (
      route.addressing === 'shared' &&
      route.domain !== context.env.EMAIL_SENDER_DOMAIN?.toLowerCase()
    ) {
      return context.json({ error: 'forbidden' }, 403);
    }
  } else {
    let expected: string;
    try {
      expected = await readConnectionSecret(context.env, resolved.connection);
    } catch {
      return context.json({ error: 'ingress identity unavailable' }, 503);
    }
    let authorized = constantTimeEqual(expected, secret as string);
    if (!authorized && resolved.connection.staged_secret_generation !== null) {
      try {
        authorized = constantTimeEqual(
          await readStagedConnectionSecret(context.env, resolved.connection),
          secret as string,
        );
      } catch {
        return context.json({ error: 'staged ingress identity unavailable' }, 503);
      }
    }
    if (
      !authorized &&
      resolved.connection.previous_secret_hash &&
      resolved.connection.previous_secret_until &&
      Date.parse(resolved.connection.previous_secret_until) > Date.now()
    ) {
      authorized = constantTimeEqual(
        resolved.connection.previous_secret_hash,
        await digest(secret),
      );
    }
    if (!authorized) {
      return context.json({ error: 'forbidden' }, 403);
    }
  }
  let projectId = route.project_id;
  let slug: string;
  // The shared-domain name the recipient used: the project's slug or its email alias.
  let mailbox: string | undefined;
  let alias: string | null = null;
  if (route.addressing === 'shared') {
    const local = recipient.slice(0, recipient.lastIndexOf('@'));
    const namePart = local.split('+', 1)[0];
    if (!namePart) {
      return context.json({ error: 'unknown shared recipient' }, 404);
    }
    // Slugs and aliases share one namespace, so at most one project matches.
    const project = (
      await db
        .select({ id: projects.id, slug: projects.slug, alias: projects.email_alias })
        .from(projects)
        .where(
          and(
            or(eq(projects.slug, namePart), eq(projects.email_alias, namePart)),
            eq(projects.status, 'active'),
          ),
        )
        .limit(1)
    )[0];
    if (!project) {
      return context.json({ error: 'unknown shared recipient' }, 404);
    }
    projectId = project.id;
    slug = project.slug;
    mailbox = namePart;
    alias = project.alias;
    if (
      (await getSharedEmailRecipientReadiness(db, context.env, projectId, false, namePart))
        ?.status !== 'ready'
    ) {
      return context.json({ error: 'shared recipient routing is not ready' }, 503);
    }
  } else {
    const project = (
      await db
        .select({ id: projects.id, slug: projects.slug, status: projects.status })
        .from(projects)
        .where(eq(projects.id, projectId!))
        .limit(1)
    )[0];
    if (!project || project.status !== 'active') {
      return context.json({ error: 'project unavailable' }, 404);
    }
    slug = project.slug;
  }
  const authority = (
    await db
      .select({
        projectStatus: projects.status,
        suspendedReason: users.suspended_reason,
        plan: users.plan,
        emailSuspendedAt: emailProjectControls.suspended_at,
        activeDeploymentId: projects.active_deployment_id,
      })
      .from(projects)
      .innerJoin(users, eq(projects.user_id, users.id))
      .leftJoin(emailProjectControls, eq(emailProjectControls.project_id, projects.id))
      .where(eq(projects.id, projectId!))
      .limit(1)
  )[0];
  if (
    !authority ||
    authority.projectStatus !== 'active' ||
    authority.suspendedReason ||
    authority.emailSuspendedAt
  ) {
    return context.json({ error: 'project email is suspended' }, 403);
  }
  const deploymentId = authority.activeDeploymentId;
  if (!deploymentId) {
    return context.json({ error: 'project has no deployment' }, 409);
  }
  const deployment = (
    await db
      .select({ manifest: deployments.manifest, status: deployments.status })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId!)))
      .limit(1)
  )[0];
  let manifest: Pick<DeployManifest, 'emailProtocolVersion' | 'limits'> | null;
  try {
    manifest = deployment?.manifest ? JSON.parse(deployment.manifest) : null;
  } catch {
    manifest = null;
  }
  if (deployment?.status !== 'live' || manifest?.emailProtocolVersion !== 1) {
    return context.json(
      { error: 'active deployment does not support email gateway protocol' },
      409,
    );
  }
  const limits = computeDispatchLimits(
    await resolvePlanLimits(db, authority.plan),
    manifest.limits,
  );
  return context.json({
    projectId,
    slug,
    ...(mailbox ? { mailbox } : {}),
    // Replies may come from either name, whichever one the mail arrived at.
    ...(alias ? { alias } : {}),
    deploymentId,
    workerName: getProjectDeploymentWorkerName(slug, deploymentId),
    addressing: route.addressing,
    domain: route.domain,
    routeId: route.id,
    routeGeneration: route.desired_generation,
    connectionId: resolved.connection.id,
    ...(limits ? { limits } : {}),
  });
});

export default app;
