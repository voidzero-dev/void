/** Shared owner/operator email-domain service. Cloudflare writes are driven by
 * committed operations in connection-service; no database transaction spans a
 * provider request. */
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import type { Project } from '../types.ts';
import { createCfCustomerClient } from './cf-customer.ts';
import {
  emailDomainRoutes,
  emailOperations,
  emailZoneConnections,
  type EmailInboundMode,
} from './connection-schema.ts';
import {
  EmailOperationError,
  credentialFor,
  EmailCredentialExpiredError,
  getEmailOperation,
  inspectEmailInboundRoute,
  requestEmailDomainAdd,
  requestEmailDomainRemove,
  requestEmailDomainSync,
  requestEmailSecretRotation,
  resolveEmailDomain,
  runEmailOperation,
} from './connection-service.ts';
import { normalizeEmailDomain } from './domain-name.ts';
import { getEmailDomainManagement } from './settings.ts';

export const MAX_CREDENTIAL_LENGTH = 2048;
export type EmailDomainAddInput = Readonly<{
  domain: string;
  apiToken?: string;
  attemptId?: unknown;
  managedBy: 'owner' | 'admin';
  inboundMode?: EmailInboundMode;
}>;
export async function getEmailDomainRowByDomain(db: Db, domain: string) {
  return (
    (
      await db
        .select()
        .from(emailDomainRoutes)
        .where(eq(emailDomainRoutes.domain, normalizeEmailDomain(domain)))
        .limit(1)
    )[0] ?? null
  );
}
export function serializeEmailRoute(
  route: typeof emailDomainRoutes.$inferSelect,
  connection: typeof emailZoneConnections.$inferSelect,
  operationId?: string,
) {
  return {
    id: route.id,
    domain: route.domain,
    projectId: route.project_id,
    managed_by: route.managed_by,
    inboundMode: route.inbound_mode,
    // An outbound-only route is as ready as its sending.
    status:
      route.desired_state !== 'active'
        ? 'disabled'
        : route.inbound_mode === 'none'
          ? route.outbound_status
          : route.inbound_status,
    connectionId: connection.id,
    account_id: connection.account_id,
    zone_id: connection.zone_id,
    relay_worker_name: connection.ingress_worker_name,
    relay_version: connection.ingress_version,
    operationId: operationId ?? null,
    readiness: {
      inbound: {
        status: route.inbound_status,
        reason: route.inbound_reason,
        observedAt: route.inbound_observed_at,
      },
      outbound: {
        status: route.outbound_status,
        reason: route.outbound_reason,
        observedAt: route.outbound_observed_at,
      },
      management: {
        status: connection.management_status,
        reason: connection.management_reason,
        observedAt: connection.management_observed_at,
      },
    },
  };
}
async function getOperationById(db: Db, operationId: string) {
  const [operation] = await db
    .select()
    .from(emailOperations)
    .where(eq(emailOperations.id, operationId))
    .limit(1);
  return operation;
}
function serviceError(context: Context<ApiEnv>, error: unknown): Response {
  if (error instanceof EmailOperationError) {
    return context.json(
      { error: error.message, ...(error.userMessage ? { message: error.userMessage } : {}) },
      error.status as 400,
    );
  }
  throw error;
}
async function domainResult(
  context: Context<ApiEnv>,
  project: Project,
  domain: string,
  operationId: string,
): Promise<Response> {
  const resolved = await resolveEmailDomain(context.get('db'), domain);
  const found = await getEmailOperation(context.get('db'), project.id, operationId);
  if (!resolved || !found || resolved.route.project_id !== project.id) {
    return context.json({ error: 'email operation is unavailable', operationId }, 503);
  }
  return context.json({
    ...serializeEmailRoute(resolved.route, resolved.connection, operationId),
    attemptId: found.operation.idempotency_key,
    operationStatus: found.operation.status,
    error: found.operation.failure_detail,
  });
}
export async function addEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  input: EmailDomainAddInput,
): Promise<Response> {
  try {
    if (project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }
    if (
      input.managedBy === 'owner' &&
      (await getEmailDomainManagement(context.get('db'))) === 'admin'
    ) {
      const existing = await resolveEmailDomain(context.get('db'), input.domain);
      if (
        !existing ||
        existing.route.project_id !== project.id ||
        existing.route.managed_by !== 'owner' ||
        existing.connection.managed_by !== 'owner' ||
        existing.connection.manager_user_id !== context.get('user').id
      ) {
        return context.json(
          {
            error: 'email domains on this platform are managed by its administrator',
            adminCommand: `void platform email domain-add ${input.domain} --project ${project.slug}`,
          },
          403,
        );
      }
    }
    if (input.apiToken && input.apiToken.length > MAX_CREDENTIAL_LENGTH) {
      return context.json({ error: 'invalid credential' }, 400);
    }
    const { operationId } = await requestEmailDomainAdd(context.get('db'), context.env, {
      projectId: project.id,
      domain: input.domain,
      actor: { kind: input.managedBy, userId: context.get('user').id },
      token: input.apiToken,
      attemptId: typeof input.attemptId === 'string' ? input.attemptId : undefined,
      inboundMode: input.inboundMode,
    });
    await runEmailOperation(context.get('db'), context.env, operationId);
    return domainResult(context, project, input.domain, operationId);
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function getEmailDomainStatusForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
): Promise<Response> {
  const db = context.get('db');
  let resolved = await resolveEmailDomain(db, rawDomain);
  if (!resolved || resolved.route.project_id !== project.id) {
    return context.json({ error: 'email domain not found' }, 404);
  }
  const snapshot = resolved;
  if (snapshot.route.desired_state === 'active') {
    let managementStatus: 'healthy' | 'expired' | 'probe_failed' = 'healthy';
    let managementReason: string | null = null;
    let inboundIssue: string | null = null;
    let outbound: 'ready' | 'verified_only' | 'blocked' = 'blocked';
    let outboundReason: string | null = null;
    try {
      const client = createCfCustomerClient(
        await credentialFor(context.env, db, snapshot.connection),
      );
      // An outbound-only apex keeps its own MX, so there is no inbound route to inspect.
      if (snapshot.route.inbound_mode !== 'none') {
        inboundIssue = await inspectEmailInboundRoute(
          client,
          snapshot.connection,
          snapshot.route.domain,
          snapshot.route.addressing,
        );
      }
      try {
        const senders = await client.listSendingSubdomains(snapshot.connection.zone_id);
        // Verified-only sending works from Email Routing domains, which an outbound-only
        // route is not, so a domain without Sending cannot send at all.
        outbound = senders.some(
          (sender) => sender.enabled && sender.name.toLowerCase() === snapshot.route.domain,
        )
          ? 'ready'
          : snapshot.route.inbound_mode === 'none'
            ? 'blocked'
            : 'verified_only';
        outboundReason =
          outbound === 'ready' ? null : 'Cloudflare Sending is not enabled for this domain';
      } catch {
        outboundReason = 'Cloudflare Sending status could not be verified';
      }
    } catch (error) {
      if (error instanceof EmailCredentialExpiredError) {
        managementStatus = 'expired';
        managementReason = 'Cloudflare API token has expired';
      } else {
        managementStatus = 'probe_failed';
        managementReason =
          'Cloudflare routing status could not be verified; check the connection credential';
      }
    }
    await db.transaction(async (tx) => {
      // Keep every route/connection mutation on the same lock order as setup,
      // removal and recovery. The provider reads above may have raced a route
      // transition, so validate that exact route before recording observations.
      const currentRoute = (
        await tx
          .select()
          .from(emailDomainRoutes)
          .where(eq(emailDomainRoutes.id, snapshot.route.id))
          .for('update')
          .limit(1)
      )[0];
      if (
        !currentRoute ||
        currentRoute.project_id !== snapshot.route.project_id ||
        currentRoute.connection_id !== snapshot.connection.id ||
        currentRoute.desired_generation !== snapshot.route.desired_generation ||
        currentRoute.desired_state !== 'active'
      ) {
        return;
      }
      const currentConnection = (
        await tx
          .select()
          .from(emailZoneConnections)
          .where(eq(emailZoneConnections.id, snapshot.connection.id))
          .for('update')
          .limit(1)
      )[0];
      if (
        !currentConnection ||
        currentConnection.desired_generation !== snapshot.connection.desired_generation
      ) {
        return;
      }
      const updated = await tx
        .update(emailZoneConnections)
        .set({
          management_status: managementStatus,
          management_reason: managementReason,
          management_observed_at: sql`now()`,
        })
        .where(
          and(
            eq(emailZoneConnections.id, snapshot.connection.id),
            eq(emailZoneConnections.desired_generation, snapshot.connection.desired_generation),
          ),
        )
        .returning({ id: emailZoneConnections.id });
      // A failed credential probe does not revoke independently authenticated ingress.
      if (updated.length && managementStatus === 'healthy') {
        // Routing reads cannot replace the setup operation's ingress identity proof.
        const revalidateInbound =
          snapshot.connection.inbound_status === 'ready' &&
          (snapshot.route.inbound_status === 'ready' ||
            snapshot.route.inbound_status === 'drifted');
        // A setup step may have recorded a newer Sending result after the read above.
        // Keep it: for an outbound-only route a stale 'blocked' would stop all sending.
        const outboundUnchanged =
          currentRoute.outbound_status === snapshot.route.outbound_status &&
          currentRoute.outbound_observed_at === snapshot.route.outbound_observed_at;
        await tx
          .update(emailDomainRoutes)
          .set({
            ...(revalidateInbound
              ? {
                  inbound_status: inboundIssue ? ('drifted' as const) : ('ready' as const),
                  inbound_reason: inboundIssue,
                  inbound_observed_at: sql`now()`,
                }
              : {}),
            ...(outboundUnchanged
              ? {
                  outbound_status: outbound,
                  outbound_reason: outboundReason,
                  outbound_observed_at: sql`now()`,
                }
              : {}),
            updated_at: sql`now()`,
          })
          .where(
            and(
              eq(emailDomainRoutes.id, snapshot.route.id),
              eq(emailDomainRoutes.project_id, snapshot.route.project_id!),
              eq(emailDomainRoutes.connection_id, snapshot.connection.id),
              eq(emailDomainRoutes.desired_generation, snapshot.route.desired_generation),
              eq(emailDomainRoutes.desired_state, 'active'),
            ),
          );
      }
    });
    resolved = await resolveEmailDomain(db, rawDomain);
    if (!resolved || resolved.route.project_id !== project.id) {
      return context.json({ error: 'email domain not found' }, 404);
    }
  }
  const op = (
    await context
      .get('db')
      .select()
      .from(emailOperations)
      .where(eq(emailOperations.route_id, resolved.route.id))
      .orderBy(sql`${emailOperations.created_at} DESC`)
      .limit(1)
  )[0];
  return context.json({
    ...serializeEmailRoute(resolved.route, resolved.connection, op?.id),
    operationStatus: op?.status ?? null,
    error: op?.failure_detail ?? null,
  });
}
export async function syncEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  actor: 'owner' | 'admin',
): Promise<Response> {
  try {
    const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
    if (!resolved || resolved.route.project_id !== project.id) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    const operationId = await requestEmailDomainSync(
      context.get('db'),
      context.env,
      resolved.route.id,
      { kind: actor, userId: context.get('user').id },
      undefined,
      project.id,
    );
    await runEmailOperation(context.get('db'), context.env, operationId);
    return domainResult(context, project, rawDomain, operationId);
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function rotateEmailIngressSecretForProject(
  context: Context<ApiEnv>,
  project: Project,
  rawDomain: string,
  actor: 'owner' | 'admin',
  attemptId?: string,
): Promise<Response> {
  try {
    const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
    if (
      !resolved ||
      resolved.route.project_id !== project.id ||
      resolved.route.desired_state !== 'active'
    ) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    if (resolved.route.inbound_mode === 'none') {
      return context.json(
        { error: 'outbound-only email domains have no ingress secret to rotate' },
        409,
      );
    }
    const operationId = await requestEmailSecretRotation(
      context.get('db'),
      context.env,
      resolved.connection.id,
      { kind: actor, userId: context.get('user').id },
      attemptId,
      project.id,
    );
    await runEmailOperation(context.get('db'), context.env, operationId);
    const operation = await getOperationById(context.get('db'), operationId);
    const current = await resolveEmailDomain(context.get('db'), rawDomain);
    if (!current || current.route.project_id !== project.id) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    return context.json({
      ...serializeEmailRoute(current.route, current.connection, operationId),
      operationStatus: operation?.status,
      error: operation?.failure_detail,
    });
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function removeEmailDomainForProject(
  context: Context<ApiEnv>,
  project: Pick<Project, 'id'>,
  rawDomain: string,
  actor: 'owner' | 'admin',
): Promise<Response> {
  try {
    const resolved = await resolveEmailDomain(context.get('db'), rawDomain);
    if (!resolved || resolved.route.project_id !== project.id) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    const operationId = await requestEmailDomainRemove(
      context.get('db'),
      context.env,
      resolved.route.id,
      { kind: actor, userId: context.get('user').id },
      undefined,
      project.id,
    );
    if (!operationId) {
      return context.json({ error: 'email domain not found' }, 404);
    }
    await runEmailOperation(context.get('db'), context.env, operationId);
    const op = await getOperationById(context.get('db'), operationId);
    return context.json({
      ok: op?.status === 'completed',
      removed: op?.status === 'completed',
      operationId,
      operationStatus: op?.status,
      error: op?.failure_detail,
    });
  } catch (error) {
    return serviceError(context, error);
  }
}
export async function getEmailOperationForProject(
  context: Context<ApiEnv>,
  project: Project,
  key: string,
): Promise<Response> {
  const found = await getEmailOperation(context.get('db'), project.id, key);
  if (!found) {
    return context.json({ error: 'email operation not found' }, 404);
  }
  const resolved = await resolveEmailDomain(context.get('db'), found.route.domain);
  if (!resolved || resolved.route.project_id !== project.id) {
    return context.json({ error: 'email domain not found' }, 404);
  }
  const domain = serializeEmailRoute(resolved.route, resolved.connection);
  return context.json({
    operationId: found.operation.id,
    attemptId: found.operation.idempotency_key,
    status: found.operation.status,
    domain: found.route.domain,
    readiness: domain.readiness,
    failedStep: found.operation.current_step,
    error: found.operation.failure_detail,
  });
}
