import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getPlatformCapabilities } from '../../capabilities.ts';
import { deleteEmailDestination, getEmailDestinationsByProjectId, getProject } from '../../db.ts';
import { emailMonthlyUsage, emailProjectControls } from '../../email/admission-schema.ts';
import { setProjectEmailLimits, setProjectEmailSuspended } from '../../email/admission.ts';
import {
  emailDomainRoutes,
  emailOperations,
  emailZoneConnections,
} from '../../email/connection-schema.ts';
import {
  addEmailDomainForProject,
  removeEmailDomainForProject,
  rotateEmailIngressSecretForProject,
} from '../../email/domain-service.ts';
import {
  DEFAULT_EMAIL_BURST_LIMIT as DEFAULT_BURST_LIMIT,
  DEFAULT_EMAIL_MONTHLY_LIMIT as DEFAULT_MONTHLY_LIMIT,
  parseEmailLimitInput,
} from '../../email/limits.ts';
import {
  getEmailDomainManagement,
  getEmailRecipientPolicy,
  repairEmailRecipientPolicyMirror,
} from '../../email/settings.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import { setOperatorEmailPolicy, setOperatorEmailSettings } from '../../operator/email-routes.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { runEmailDestinationCleanup } from '../../provisioning/email-destination-cleanup.ts';
import { requestTimezone } from '../fate/page-data.ts';
import { renderFateDetailPage, renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);
// The same capability boundary the owner and operator email routes sit
// behind: a platform that does not enable email must not have its policy,
// settings or domains changed from the browser either.
app.use('*', async (context, next) => {
  if (!getPlatformCapabilities(context.env).email) {
    if (context.req.method === 'GET') {
      return renderAdminPage(context, 'email', 'Email', {
        path: new URL(context.req.url).pathname,
        platformName: getPlatformDisplayName(context.env, context.req.url),
        username: context.get('user').login,
        emailEnabled: false,
      });
    }
    return context.html('<h1>Email is not enabled on this platform</h1>', 501);
  }
  await next();
});

type AdminEmailOperationOutcome = {
  operationId?: string;
  operationStatus?: typeof emailOperations.$inferSelect.status | null;
  error?: string | null;
};

async function incompleteEmailOperationResponse(
  context: Context<ApiEnv>,
  projectId: string,
  label: string,
  outcome: AdminEmailOperationOutcome,
): Promise<Response> {
  const status = outcome.operationStatus ?? 'pending';
  return renderAdminPage(
    context,
    'emailOperation',
    label,
    {
      label,
      status,
      error: outcome.error,
      operationId: outcome.operationId,
      projectId,
      platformName: getPlatformDisplayName(context.env, context.req.url),
      username: context.get('user').login,
    },
    { status: status === 'blocked' || status === 'unknown' ? 409 : 202 },
  );
}

async function emailOperationResult(
  context: Context<ApiEnv>,
  projectId: string,
  label: string,
  result: Response,
): Promise<{ response: Response; succeeded: boolean }> {
  const outcome = (await result.json()) as AdminEmailOperationOutcome;
  if (outcome.operationStatus !== 'completed') {
    return {
      response: await incompleteEmailOperationResponse(context, projectId, label, outcome),
      succeeded: false,
    };
  }
  return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
}

export async function loadEmailSettingsData(context: Context<ApiEnv>) {
  const db = context.get('db');
  // Refresh the best-effort display mirror before showing the authoritative SQL policy.
  await repairEmailRecipientPolicyMirror(db, context.env.ROUTING);
  const [policy, management] = await Promise.all([
    getEmailRecipientPolicy(db),
    getEmailDomainManagement(db),
  ]);
  return {
    policy,
    management,
    senderDomain: context.env.EMAIL_SENDER_DOMAIN,
  };
}

// GET /email/ — installation-wide recipient policy and domain management
app.get('/', (context) => renderFateListPage(context, 'email'));

// POST /email/policy — the shared-sender recipient policy
app.post('/policy', async (context) => {
  const body = await context.req.parseBody();
  const mode = String(body.mode ?? '');
  const domains = typeof body.domains === 'string' ? body.domains : '';
  return executeAuditedMutation(
    context,
    operatorAuditIntent('email/policy', { mode, domains }),
    async () => {
      await setOperatorEmailPolicy(context, { mode, domains: domains || undefined });
      return { response: context.redirect('/admin/email'), succeeded: true };
    },
  );
});

// POST /email/settings — who manages email domains
app.post('/settings', async (context) => {
  const body = await context.req.parseBody();
  const domains = String(body.domains ?? '');
  return executeAuditedMutation(
    context,
    operatorAuditIntent('email/settings', { domains }),
    async () => {
      await setOperatorEmailSettings(context, domains);
      return { response: context.redirect('/admin/email'), succeeded: true };
    },
  );
});

export async function loadEmailProjectData(context: Context<ApiEnv>, projectId: string) {
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    throw new OperatorError(404, 'Project not found');
  }

  const month = monthBucket();
  const [usageRows, controls, destinations, domainRows] = await Promise.all([
    context
      .get('db')
      .select({
        attempts: emailMonthlyUsage.recipient_attempts,
        received: emailMonthlyUsage.inbound_receipts,
      })
      .from(emailMonthlyUsage)
      .where(
        sql`${emailMonthlyUsage.project_id} = ${projectId} AND ${emailMonthlyUsage.month} = ${month}`,
      ),
    context
      .get('db')
      .select()
      .from(emailProjectControls)
      .where(eq(emailProjectControls.project_id, projectId))
      .limit(1),
    getEmailDestinationsByProjectId(context.get('db'), projectId),
    context
      .get('db')
      .select({
        route: emailDomainRoutes,
        connection: emailZoneConnections,
      })
      .from(emailDomainRoutes)
      .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
      .where(eq(emailDomainRoutes.project_id, projectId))
      .orderBy(asc(emailDomainRoutes.created_at)),
  ]);
  const attempts = usageRows[0]?.attempts ?? 0;
  const received = usageRows[0]?.received ?? 0;
  const latestOperations = domainRows.length
    ? await context
        .get('db')
        .select({
          id: emailOperations.id,
          routeId: emailOperations.route_id,
          connectionId: emailOperations.connection_id,
          status: emailOperations.status,
        })
        .from(emailOperations)
        .where(
          inArray(
            emailOperations.connection_id,
            domainRows.map(({ connection }) => connection.id),
          ),
        )
        .orderBy(desc(emailOperations.created_at))
    : [];

  // Distinguish an override from the default in the project controls row.
  const control = controls[0];
  const monthlyLimit =
    control && control.monthly_limit !== DEFAULT_MONTHLY_LIMIT ? control.monthly_limit : undefined;
  const burstLimit =
    control && control.burst_limit !== DEFAULT_BURST_LIMIT ? control.burst_limit : undefined;
  const isSuspended = Boolean(control?.suspended_at);
  const domains = domainRows.map(({ route, connection }) => ({
    id: route.id,
    domain: route.domain,
    inbound: route.inbound_status,
    inboundReason: route.inbound_reason,
    outbound: route.outbound_status,
    outboundReason: route.outbound_reason,
    management: connection.management_status,
    managementReason: connection.management_reason,
    managed_by: route.managed_by,
    relay_worker_name: connection.ingress_worker_name,
    relay_version: connection.ingress_version,
    operation: latestOperations.find(
      (operation) =>
        operation.routeId === route.id ||
        (operation.routeId === null && operation.connectionId === connection.id),
    ),
  }));
  const senderDomain = context.env.EMAIL_SENDER_DOMAIN;
  const tz = requestTimezone(context);

  return {
    projectId,
    project,
    month,
    attempts,
    received,
    monthlyLimit,
    burstLimit,
    isSuspended,
    domains,
    destinations,
    senderDomain,
    tz,
  };
}

// GET /email/:projectId — usage, caps, kill switch, destinations
app.get('/:projectId', (context) => renderFateDetailPage(context, 'emailProject'));

// POST /email/:projectId/domains/add — register a domain for the project as
// an administrator (design doc 0078, "Administrator-managed domains"). The
// same operation the operator CLI runs; a blank token means the platform's
// own credential. The token is never echoed or audited.
app.post('/:projectId/domains/add', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (domain === '' || domain.length > 253) {
    throw new OperatorError(400, 'Enter the mail domain to register.');
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent('email/domains', { domain, project: projectId }),
    async () => {
      const res = await addEmailDomainForProject(context, project, {
        domain,
        apiToken: token || undefined,
        managedBy: 'admin',
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: unknown };
        throw new OperatorError(
          res.status,
          typeof json.error === 'string' ? json.error : 'Adding the email domain failed.',
        );
      }
      return emailOperationResult(context, projectId, `Adding ${domain}`, res);
    },
  );
});

// POST /email/:projectId/suspend — set the kill switch to a desired terminal state
app.post('/:projectId/suspend', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const desired = body.state;
  if (desired !== 'suspended' && desired !== 'active') {
    return context.html('<h1>Invalid state</h1><p>Expected "suspended" or "active".</p>', 400);
  }
  const suspended = desired === 'suspended';
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/projects/${projectId}/suspend`, { suspended }),
    async () => {
      await setProjectEmailSuspended(context.get('db'), projectId, suspended);
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
});

// POST /email/:projectId/limit — set (or clear) the monthly outbound override
app.post('/:projectId/limit', async (context) => {
  return setLimit(context, context.req.param('projectId'), 'monthly', 'limit');
});

// POST /email/:projectId/burst-limit — set (or clear) the per-minute override
app.post('/:projectId/burst-limit', async (context) => {
  return setLimit(context, context.req.param('projectId'), 'burst', 'burstLimit');
});

// POST /email/:projectId/destinations/:destId/delete — revoke one recipient
app.post('/:projectId/destinations/:destId/delete', async (context) => {
  const projectId = context.req.param('projectId');
  const destinationId = context.req.param('destId');
  const rows = await getEmailDestinationsByProjectId(context.get('db'), projectId);
  const destination = rows.find((row) => row.id === destinationId);
  if (!destination) {
    return context.html('<h1>Destination not found</h1>', 404);
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/projects/${projectId}/destinations/${destinationId}/remove`),
    async () => {
      const cleanupTag = await deleteEmailDestination(context.get('db'), destination.id);
      if (cleanupTag) {
        await runEmailDestinationCleanup(
          context.get('db'),
          { accountId: context.env.CF_ACCOUNT_ID, apiToken: context.env.CF_API_TOKEN },
          cleanupTag,
        );
      }
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
});

// An administrator removes one exact assignment through the same durable
// operation service as the owner API. Sibling routes keep their shared ingress.
app.post('/:projectId/domains/:domain/revoke', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  if (body.confirm !== project.slug) {
    return context.html('<h1>Not confirmed</h1>', 400);
  }
  const domain = context.req.param('domain');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/domains/${domain}/remove`, { force: false }),
    async () => {
      const result = await removeEmailDomainForProject(context, project, domain, 'admin');
      if (!result.ok) {
        return {
          response: context.html('<h1>Email domain removal failed</h1>', result.status as 400),
          succeeded: false,
        };
      }
      return emailOperationResult(context, projectId, 'Email domain removal', result);
    },
  );
});

app.post('/:projectId/domains/:domain/rotate-secret', async (context) => {
  const projectId = context.req.param('projectId');
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const domain = context.req.param('domain');
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/domains/${domain}/rotate-secret`),
    async () => {
      const result = await rotateEmailIngressSecretForProject(context, project, domain, 'admin');
      if (!result.ok) {
        return {
          response: context.html('<h1>Email ingress rotation failed</h1>', result.status as 400),
          succeeded: false,
        };
      }
      return emailOperationResult(context, projectId, 'Email ingress rotation', result);
    },
  );
});

/**
 * Shared body of the two limit forms. A blank submission clears the SQL
 * override so the project uses the platform default.
 */
async function setLimit(
  context: Context<ApiEnv>,
  projectId: string,
  kind: 'monthly' | 'burst',
  field: string,
): Promise<Response> {
  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.html('<h1>Project not found</h1>', 404);
  }
  const body = await context.req.parseBody();
  const submitted = body[field];
  const raw = typeof submitted === 'string' ? submitted.trim() : '';
  const limit = raw === '' ? null : parseEmailLimitInput(raw);
  if (limit === undefined) {
    return context.html('<h1>Invalid limit</h1><p>Expected a positive integer, or blank.</p>', 400);
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`email/projects/${projectId}/limit`, {
      [kind]: limit === null ? 'default' : String(limit),
    }),
    async () => {
      await setProjectEmailLimits(context.get('db'), projectId, { [kind]: limit });
      return { response: context.redirect(`/admin/email/${projectId}`), succeeded: true };
    },
  );
}

/** UTC `YYYY-MM` for the current usage window. */
function monthBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default app;
