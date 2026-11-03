import { PLAN_EDITABLE_LIMIT_KEYS } from '@void/platform/plans';
import { count, desc, eq } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { AuthenticationConfigurationError } from '../auth/configuration.ts';
import type { ApiEnv } from '../env.ts';
import { isProjectId } from '../id.ts';
import { operatorEvents } from '../schema.ts';
import { dryRun, OperatorError, pagination, readBody } from './common.ts';

const WORKER_NAMES = ['dispatch', 'dashboard', 'api', 'tail', 'proxy', 'email-gateway'] as const;

function boundedString(value: unknown, maximum: number, lowerCase = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    return undefined;
  }
  const trimmed = value.trim();
  return lowerCase ? trimmed.toLowerCase() : trimmed;
}

function boundedExactString(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function pathIdentifier(value: string | undefined) {
  return boundedString(value, 512);
}

function boundedList(value: unknown, maxItems: number, maxLength: number, lowerCase = false) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    return undefined;
  }
  const values = value.map((entry) => boundedString(entry, maxLength, lowerCase));
  return values.every((entry): entry is string => entry !== undefined)
    ? [...new Set(values)]
    : undefined;
}

function rollbackVersions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const versions = Object.fromEntries(
    WORKER_NAMES.flatMap((name) => {
      const version = boundedString(input[name], 128);
      return version ? [[name, version]] : [];
    }),
  );
  return Object.keys(versions).length > 0 ? versions : undefined;
}

function auditTarget(
  path: string,
  body: Record<string, unknown>,
  platformEnvironment?: unknown,
): string | undefined {
  const segments = path.split('/');
  const id = pathIdentifier(segments[1]);
  if (segments[0] === 'oauth' && segments[1] === 'clients') {
    if (segments[2] === 'register') {
      return JSON.stringify({
        name: boundedString(body.name, 80),
        operator: boundedString(body.operator, 160),
        redirectUris: boundedList(body.redirectUris, 10, 2048),
        scopes: boundedList(body.scopes, 3, 32),
      });
    }
    if (segments[2] === 'disable' || segments[2] === 'preview-permission') {
      return JSON.stringify({
        clientId: boundedString(body.id, 128),
        ...(segments[2] === 'preview-permission' ? { enabled: body.enabled === true } : {}),
      });
    }
  }
  if (segments[0] === 'config' && segments[1] === 'auth') {
    return JSON.stringify({
      connectionId: pathIdentifier(segments[3]),
      action: pathIdentifier(segments[4] ?? segments[2]),
      revision: typeof body.revision === 'number' ? body.revision : undefined,
    });
  }
  if (segments[0] === 'config' && segments[1] === 'plans') {
    const limits =
      body.limits && typeof body.limits === 'object' && !Array.isArray(body.limits)
        ? Object.fromEntries(
            Object.entries(body.limits).filter(
              ([key, value]) =>
                (PLAN_EDITABLE_LIMIT_KEYS as ReadonlyArray<string>).includes(key) &&
                Number.isSafeInteger(value) &&
                (value as number) >= 0,
            ),
          )
        : undefined;
    return JSON.stringify({
      planId: segments[3] ? pathIdentifier(segments[2]) : boundedString(body.id, 64),
      action: pathIdentifier(segments[3] ?? segments[2]),
      expectedRevision: Number.isSafeInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined,
      name: boundedString(body.name, 80),
      copyFrom: boundedString(body.copyFrom, 64),
      replacementPlanId: boundedString(body.replacementPlanId, 64),
      defaultPlanId: boundedString(body.planId, 64),
      archived: typeof body.archived === 'boolean' ? body.archived : undefined,
      buildInstanceType: boundedString(body.buildInstanceType, 32),
      allowShortSlugs: typeof body.allowShortSlugs === 'boolean' ? body.allowShortSlugs : undefined,
      limits,
    });
  }
  if (segments[0] === 'users' && id) {
    if (segments[2] === 'plan') {
      return JSON.stringify({ userId: id, plan: boundedString(body.plan, 512) });
    }
    if (segments[2] === 'suspend') {
      return JSON.stringify({
        userId: id,
        reason: body.reason === undefined ? 'admin_suspended' : boundedString(body.reason, 1000),
      });
    }
    if (segments[2] === 'restore' || segments[2] === 'delete') {
      return JSON.stringify({ userId: id });
    }
  }
  if (segments[0] === 'projects' && id) {
    if (segments[2] === 'team') {
      if (segments[3] === 'add') {
        return JSON.stringify({
          projectId: id,
          userId: boundedString(body.userId, 512),
          role: boundedString(body.role, 32),
        });
      }
      if (segments[3] === 'invite') {
        return JSON.stringify({
          projectId: id,
          email: boundedString(body.email, 320, true),
          role: boundedString(body.role, 32),
        });
      }
      if (segments[3] === 'invitations' && segments[5] === 'revoke') {
        return JSON.stringify({ projectId: id, invitationId: pathIdentifier(segments[4]) });
      }
      if (segments[4] === 'role' || segments[4] === 'remove') {
        return JSON.stringify({
          projectId: id,
          userId: pathIdentifier(segments[3]),
          role: segments[4] === 'role' ? boundedString(body.role, 32) : undefined,
        });
      }
    }
    if (segments[2] === 'owner') {
      return JSON.stringify({ projectId: id, userId: boundedString(body.userId, 512) });
    }
    if (segments[2] === 'delete' || segments[2] === 'normalize') {
      return JSON.stringify({ projectId: id });
    }
  }
  if (segments[0] === 'email' && segments[1] === 'operations' && segments[3] === 'resolve') {
    return JSON.stringify({
      operationId: pathIdentifier(segments[2]),
      stepId: boundedString(body.stepId, 128),
      attempt: typeof body.attempt === 'number' ? body.attempt : undefined,
      requestDigest: boundedString(body.requestDigest, 128),
      outcome: boundedString(body.outcome, 32),
      ended: body.ended === true,
      reason: boundedString(body.reason, 500),
    });
  }
  if (segments[0] === 'signup') {
    if (segments[1] === 'restrict' || segments[1] === 'open') {
      return JSON.stringify({ restrictionsEnabled: segments[1] === 'restrict' });
    }
    if (segments[1] === 'allow' || segments[1] === 'remove' || segments[1] === 'disallow') {
      const patterns = boundedList(body.patterns, 100, 320, true);
      const type = boundedString(body.type, 512);
      return JSON.stringify({
        type,
        ...(type === 'identity'
          ? {
              connectionId: boundedString(body.connectionId, 64),
              subject: boundedExactString(body.subject, 255),
            }
          : { pattern: boundedString(body.pattern, 320, true) }),
        ...(patterns ? { patterns } : {}),
        ...(segments[1] === 'allow' ? { note: boundedString(body.note, 1000) } : {}),
      });
    }
  }
  if (segments[0] === 'invitations') {
    if (segments[1] === 'send') {
      return JSON.stringify({ emails: boundedList(body.emails, 100, 320, true) });
    }
    if (id && segments[2] === 'revoke') {
      return JSON.stringify({ invitationId: id });
    }
  }
  if (segments[0] === 'deployments' && id && segments[2] === 'cancel') {
    return JSON.stringify({ deploymentId: id });
  }
  if (segments[0] === 'email') {
    if (segments[1] === 'policy') {
      return JSON.stringify({
        mode: boundedString(body.mode, 512),
        domains: boundedString(body.domains, 100 * 254, true),
      });
    }
    if (segments[1] === 'settings') {
      return JSON.stringify({ domains: boundedString(body.domains, 512) });
    }
    if (segments[1] === 'attempts' && segments[3] === 'resolve') {
      return JSON.stringify({
        attemptId: pathIdentifier(segments[2]),
        ended: body.ended === true,
        reason: boundedString(body.reason, 500),
      });
    }
    if (segments[1] === 'shared-recipients' && segments[3] === 'resolve') {
      return JSON.stringify({
        recipientId: pathIdentifier(segments[2]),
        ended: body.ended === true,
        outcome: boundedString(body.outcome, 32),
        reason: boundedString(body.reason, 500),
        recoveryFence: boundedString(body.recoveryFence, 64),
      });
    }
    // Never the credential: `apiToken` rides the add body and stays out.
    const domain = boundedString(segments[2], 253, true);
    if (segments[1] === 'domains' && segments.length === 2) {
      return JSON.stringify({
        domain: boundedString(body.domain, 253, true),
        project: boundedString(body.project, 512),
        ...(body.outboundOnly === true ? { outboundOnly: true } : {}),
      });
    }
    if (
      segments[1] === 'domains' &&
      domain &&
      (segments[3] === 'sync' || segments[3] === 'rotate-secret')
    ) {
      return JSON.stringify({ domain });
    }
    if (segments[1] === 'domains' && domain && segments[3] === 'remove') {
      return JSON.stringify({ domain, force: body.force === true });
    }
    const project = pathIdentifier(segments[2]);
    if (segments[1] === 'projects' && project) {
      if (segments[3] === 'limit') {
        return JSON.stringify({
          project,
          monthly: boundedString(body.monthly, 16),
          burst: boundedString(body.burst, 16),
        });
      }
      if (segments[3] === 'suspend') {
        return JSON.stringify({ project, suspended: body.suspended === true });
      }
      const destinationId = boundedString(segments[4], 128);
      if (segments[3] === 'destinations' && destinationId && segments[5] === 'remove') {
        return JSON.stringify({ project, destinationId });
      }
    }
  }
  if (segments[0] === 'zero-trust') {
    if (segments[1] === 'configure') {
      return JSON.stringify({
        accountId: boundedString(body.accountId, 128),
        identityProviderIds: boundedList(body.identityProviderIds, 16, 128),
        policyIds: boundedList(body.policyIds, 16, 128),
        protectNewProjects: body.protectNewProjects === true,
        existingProjects: boundedString(body.existingProjects, 16),
      });
    }
    if (segments[1] === 'reconcile' || segments[1] === 'disable') {
      return JSON.stringify({ installation: 'platform' });
    }
    if (segments[1] === 'projects' && segments[2]) {
      return JSON.stringify({
        projectId: pathIdentifier(segments[2]),
        ...(segments[3] === 'reconcile'
          ? { reconcile: true }
          : { protected: body.protected === true }),
      });
    }
  }
  if (segments[0] === 'system' && segments[1] === 'backfill-queue-tokens') {
    return JSON.stringify({ entries: 'queue:*' });
  }
  if (segments[0] === 'system' && segments[1] === 'sandbox-drain') {
    return JSON.stringify({ applications: 'managed-sandbox-containers' });
  }
  if (segments[0] === 'system' && segments[1] === 'rotate-proxy-tokens') {
    return JSON.stringify({ projects: isProjectId(body.project) ? body.project : 'all' });
  }
  if (segments[0] === 'workers') {
    const environment = boundedString(body.environment ?? platformEnvironment, 512) ?? 'production';
    if (segments[1] === 'rollback-all') {
      return JSON.stringify({ environment, versions: rollbackVersions(body.versions) });
    }
    if (id && segments[2] === 'rollback') {
      return JSON.stringify({
        workerName: id,
        environment,
        versionId: boundedString(body.versionId, 128),
      });
    }
  }
  return undefined;
}

export type OperatorAuditIntent = Readonly<{
  action: string;
  target: string;
}>;

/**
 * Normalize a mutation to the operator API's canonical action and its
 * action-specific, allowlisted audit target. Browser handlers use this before
 * calling a shared operation so form field names and route aliases never leak
 * into the durable audit log.
 */
export function operatorAuditIntent(
  action: string,
  body: Record<string, unknown> = {},
  platformEnvironment?: unknown,
): OperatorAuditIntent {
  const target = auditTarget(action, body, platformEnvironment);
  if (target === undefined) {
    throw new Error(`Unknown audited operator mutation: ${action}`);
  }
  return { action, target };
}

async function mutationSucceeded(response: Response) {
  if (!response.ok) {
    return false;
  }
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    return true;
  }
  try {
    const result: unknown = await response.clone().json();
    return !(
      typeof result === 'object' &&
      result !== null &&
      'ok' in result &&
      result.ok === false
    );
  } catch {
    return true;
  }
}

async function insertAuditIntent(context: Context<ApiEnv>, intent: OperatorAuditIntent) {
  const id = crypto.randomUUID();
  const user = context.get('user');
  await context.get('db').insert(operatorEvents).values({
    id,
    user_id: user.id,
    login: user.login,
    action: intent.action,
    target: intent.target,
    status: 'pending',
  });
  return id;
}

async function completeAudit(
  context: Context<ApiEnv>,
  id: string,
  succeeded: boolean,
  httpStatus: number,
  response?: Response,
): Promise<Response | undefined> {
  let pending = false;
  try {
    await context
      .get('db')
      .update(operatorEvents)
      .set({ status: succeeded ? 'success' : 'failed', http_status: httpStatus })
      .where(eq(operatorEvents.id, id));
  } catch (error) {
    // The mutation may already have completed. Its durable pending intent is
    // the recovery signal, so preserve the original response or thrown error.
    console.error('[operator] audit completion failed', id, error);
    pending = true;
    if (!response) {
      context.header('X-Void-Audit-Status', 'pending');
    }
  }
  if (response) {
    // Redirect responses have immutable headers. Clone all responses so the
    // audit metadata is applied consistently without changing their body or
    // status.
    const headers = new Headers(response.headers);
    headers.set('X-Void-Audit-Id', id);
    if (pending) {
      headers.set('X-Void-Audit-Status', 'pending');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } else {
    context.header('X-Void-Audit-Id', id);
  }
}

export type AuditedMutationResult = Readonly<{
  response: Response;
  succeeded: boolean;
}>;

/** Execute a browser mutation behind the same durable intent/outcome audit as the CLI. */
export async function executeAuditedMutation(
  context: Context<ApiEnv>,
  intent: OperatorAuditIntent,
  mutation: () => Promise<AuditedMutationResult>,
): Promise<Response> {
  // Deliberately outside the try block: an intent insert failure must prevent
  // the mutation instead of becoming an unaudited change.
  const id = await insertAuditIntent(context, intent);
  try {
    const result = await mutation();
    return (
      (await completeAudit(
        context,
        id,
        result.succeeded,
        result.response.status,
        result.response,
      )) ?? result.response
    );
  } catch (error) {
    await completeAudit(
      context,
      id,
      false,
      error instanceof OperatorError || error instanceof AuthenticationConfigurationError
        ? error.status
        : 500,
    );
    throw error;
  }
}

/** Persist intent before a mutation so an interrupted request stays observable. */
export const operatorAudit: MiddlewareHandler<ApiEnv> = async (context, next) => {
  if (context.req.method !== 'POST' || context.req.path.endsWith('/session/logout')) {
    return next();
  }
  const body = await readBody(context);
  if (dryRun(body)) {
    return next();
  }
  const path = context.req.path.replace(/^\/operator\/v1\//, '');
  // Known operations use the canonical allowlist; any other authenticated POST
  // still records an observable intent with an empty target.
  const id = await insertAuditIntent(context, {
    action: path,
    target: auditTarget(path, body, context.env.PLATFORM_ENV) ?? '',
  });
  await next();
  const succeeded = await mutationSucceeded(context.res);
  context.res =
    (await completeAudit(context, id, succeeded, context.res.status, context.res)) ?? context.res;
};

export const operatorAuditRoutes = new Hono<ApiEnv>();
operatorAuditRoutes.get('/system/events', async (context) => {
  const { page, limit, offset } = pagination(context);
  const db = context.get('db');
  const [events, totals] = await Promise.all([
    db
      .select()
      .from(operatorEvents)
      .orderBy(desc(operatorEvents.created_at), desc(operatorEvents.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(operatorEvents),
  ]);
  const total = totals[0]?.total ?? 0;
  return context.json({
    events,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});
