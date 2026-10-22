import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { capabilityMiddleware } from '../capabilities.ts';
import { getProject, getProjectBySlug, type Db } from '../db.ts';
import {
  emailActionRecipients,
  emailProjectControls,
  emailUnresolvedAttempts,
} from '../email/admission-schema.ts';
import {
  EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS,
  EmailAdmissionError,
  getProjectEmailLogs,
  resolveEmailUnresolvedAttempt,
  setProjectEmailLimits,
} from '../email/admission.ts';
import { lookupMxOverDns } from '../email/cf-domain-probes.ts';
import {
  emailDomainRoutes,
  emailSharedRecipients,
  emailZoneConnections,
} from '../email/connection-schema.ts';
import {
  EmailOperationError,
  EMAIL_OPERATION_RECOVERY_MIN_AGE_MS,
  emailInstallationId,
  inspectUnknownEmailOperationRecovery,
  replaceBlockedSystemEmailCleanupCredential,
  resolveUnknownEmailOperation,
} from '../email/connection-service.ts';
import {
  MAX_DOMAIN_LENGTH,
  isValidEmailDomain,
  normalizeEmailDomain,
} from '../email/domain-name.ts';
import {
  addEmailDomainForProject,
  getEmailDomainRowByDomain,
  getEmailDomainStatusForProject,
  MAX_CREDENTIAL_LENGTH,
  removeEmailDomainForProject,
  rotateEmailIngressSecretForProject,
  serializeEmailRoute,
  syncEmailDomainForProject,
} from '../email/domain-service.ts';
import { parseEmailLimitInput, MAX_EMAIL_LIMIT } from '../email/limits.ts';
import {
  EmailSettingsError,
  getEmailDomainManagement,
  getEmailRecipientPolicy,
  isEmailDomainManagement,
  normalizeEmailRecipientPolicy,
  repairEmailRecipientPolicyMirror,
  setEmailDomainManagement,
  setEmailRecipientPolicy,
  type EmailRecipientPolicy,
} from '../email/settings.ts';
import {
  inspectSharedEmailRecipientRecovery,
  resolveSharedEmailRecipientCreation,
} from '../email/shared-recipient-service.ts';
import type { ApiEnv } from '../env.ts';
import { projects } from '../schema.ts';
import { dryRun, OperatorError, pagination, preview, readBody, stringField } from './common.ts';

/**
 * Installation-wide email administration (design doc 0078, "Recipient
 * policy" and "Administrator-managed domains"). The browser admin UI calls
 * the same service functions below so both surfaces write one contract.
 */
export const emailOperatorRoutes = new Hono<ApiEnv>().use(
  '/email/*',
  capabilityMiddleware('email'),
);

function policyEffect(policy: EmailRecipientPolicy): string {
  switch (policy.mode) {
    case 'any':
      return "Shared-sender mail reaches any recipient; addresses on the platform's own mail domain stay verified-destination-only, so no project reaches another project's inbox without its consent. Cloudflare still refuses unverified destinations until the platform mail domain is onboarded for Email Sending.";
    case 'domains':
      return `Shared-sender mail reaches verified destinations and any address on ${policy.domains.join(', ')}; addresses on the platform's own mail domain stay verified-destination-only. Cloudflare still refuses unverified destinations until the platform mail domain is onboarded for Email Sending.`;
    default:
      return "Shared-sender mail reaches only each project's verified destinations.";
  }
}

export async function getOperatorEmailPolicy(context: Context<ApiEnv>) {
  const db = context.get('db');
  const policy = await getEmailRecipientPolicy(db);
  await repairEmailRecipientPolicyMirror(db, context.env.ROUTING);
  return { policy: { mode: policy.mode, domains: [...policy.domains] } };
}

export async function setOperatorEmailPolicy(
  context: Context<ApiEnv>,
  input: { mode: string; domains?: string },
  dryRunRequested = false,
) {
  let policy: EmailRecipientPolicy;
  try {
    policy = normalizeEmailRecipientPolicy(input);
  } catch (err) {
    if (err instanceof EmailSettingsError) {
      throw new OperatorError(400, err.message, 'invalid_argument');
    }
    throw err;
  }
  const db = context.get('db');
  const previous = await getEmailRecipientPolicy(db);
  const action = 'email.policy.set';
  const target = { mode: policy.mode, domains: [...policy.domains] };
  if (dryRunRequested) {
    return preview(action, target, {
      previous: { mode: previous.mode, domains: [...previous.domains] },
      effect: policyEffect(policy),
    });
  }
  try {
    await setEmailRecipientPolicy(db, context.env.ROUTING, policy);
  } catch (err) {
    throw new OperatorError(503, err instanceof Error ? err.message : String(err), 'mirror_failed');
  }
  return { action, target, policy: target };
}

export async function getOperatorEmailSettings(context: Context<ApiEnv>) {
  return { domains: { management: await getEmailDomainManagement(context.get('db')) } };
}

export async function setOperatorEmailSettings(
  context: Context<ApiEnv>,
  domains: string,
  dryRunRequested = false,
) {
  if (!isEmailDomainManagement(domains)) {
    throw new OperatorError(400, 'domains must be self-serve or admin.', 'invalid_argument');
  }
  const db = context.get('db');
  const previous = await getEmailDomainManagement(db);
  const action = 'email.settings.set';
  const target = { domains };
  if (dryRunRequested) {
    return preview(action, target, {
      previous: { domains: previous },
      effect:
        domains === 'admin'
          ? 'Project owners are told to ask an administrator; `void email domain add` no longer opens a Cloudflare consent.'
          : 'Project owners register email domains with their own Cloudflare credential.',
    });
  }
  await setEmailDomainManagement(db, domains);
  return { action, target, domains: { management: domains } };
}

function emailOperationError(error: unknown): never {
  if (error instanceof EmailOperationError) {
    throw new OperatorError(
      error.status === 404 ? 404 : error.status === 400 ? 400 : 409,
      error.message,
      error.status === 404 ? 'not_found' : 'invalid_state',
    );
  }
  throw error;
}

async function resolveProject(db: Db, selector: string) {
  const project = (await getProject(db, selector)) ?? (await getProjectBySlug(db, selector));
  if (!project) {
    throw new OperatorError(404, 'Project not found');
  }
  return project;
}

export async function setOperatorEmailLimit(
  context: Context<ApiEnv>,
  selector: string,
  input: { monthly?: string; burst?: string },
  dryRunRequested = false,
) {
  const parse = (name: 'monthly' | 'burst'): number | undefined => {
    const raw = input[name];
    if (raw === undefined || raw === '') {
      return undefined;
    }
    const value = parseEmailLimitInput(raw);
    if (value === undefined) {
      throw new OperatorError(
        400,
        `${name} must be an integer from 1 to ${MAX_EMAIL_LIMIT}.`,
        'invalid_argument',
      );
    }
    return value;
  };
  const monthly = parse('monthly');
  const burst = parse('burst');
  if (monthly === undefined && burst === undefined) {
    throw new OperatorError(400, 'Supply --monthly, --burst, or both.', 'invalid_argument');
  }
  const db = context.get('db');
  const project = await resolveProject(db, selector);
  const controls = (
    await db
      .select()
      .from(emailProjectControls)
      .where(eq(emailProjectControls.project_id, project.id))
      .limit(1)
  )[0];
  const action = 'email.limit.set';
  const target = {
    projectId: project.id,
    slug: project.slug,
    ...(monthly === undefined ? {} : { monthly }),
    ...(burst === undefined ? {} : { burst }),
  };
  const previous = {
    monthly: controls?.monthly_limit ?? 200,
    burst: controls?.burst_limit ?? 10,
  };
  if (dryRunRequested) {
    return preview(action, target, { previous });
  }
  await setProjectEmailLimits(db, project.id, { monthly, burst });
  return { action, target, previous };
}

emailOperatorRoutes.get('/email/policy', async (context) =>
  context.json(await getOperatorEmailPolicy(context)),
);
emailOperatorRoutes.post('/email/policy', async (context) => {
  const body = await readBody(context);
  return context.json(
    await setOperatorEmailPolicy(
      context,
      {
        mode: stringField(body, 'mode', { maxLength: 32 }),
        domains:
          stringField(body, 'domains', { optional: true, maxLength: 100 * 254 }) || undefined,
      },
      dryRun(body),
    ),
  );
});
emailOperatorRoutes.get('/email/settings', async (context) =>
  context.json(await getOperatorEmailSettings(context)),
);
emailOperatorRoutes.post('/email/settings', async (context) => {
  const body = await readBody(context);
  return context.json(
    await setOperatorEmailSettings(
      context,
      stringField(body, 'domains', { maxLength: 32 }),
      dryRun(body),
    ),
  );
});
emailOperatorRoutes.post('/email/projects/:project/limit', async (context) => {
  const body = await readBody(context);
  const result = await setOperatorEmailLimit(
    context,
    context.req.param('project'),
    {
      monthly: stringField(body, 'monthly', { optional: true, maxLength: 16 }) || undefined,
      burst: stringField(body, 'burst', { optional: true, maxLength: 16 }) || undefined,
    },
    dryRun(body),
  );
  return context.json(result);
});

emailOperatorRoutes.get('/email/projects/:project/logs', async (context) => {
  const { page, limit, offset } = pagination(context);
  const selector = context.req.param('project');
  if (!selector || selector.length > 128) {
    throw new OperatorError(
      400,
      'Project ID or slug must be at most 128 characters.',
      'invalid_argument',
    );
  }
  const db = context.get('db');
  const project = (await getProject(db, selector)) ?? (await getProjectBySlug(db, selector));
  const projectId = project?.id ?? selector;
  return context.json({
    projectId,
    page,
    limit,
    ...(await getProjectEmailLogs(db, projectId, limit, offset)),
  });
});

emailOperatorRoutes.get('/email/attempts', async (context) => {
  const { page, limit, offset } = pagination(context);
  const db = context.get('db');
  const selector = context.req.query('project');
  const project = selector ? await resolveProject(db, selector) : undefined;
  const filter = project ? eq(emailUnresolvedAttempts.project_id, project.id) : undefined;
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(emailUnresolvedAttempts)
      .where(filter)
      .orderBy(asc(emailUnresolvedAttempts.started_at), asc(emailUnresolvedAttempts.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(emailUnresolvedAttempts).where(filter),
  ]);
  return context.json({
    page,
    limit,
    total: totals[0]?.total ?? 0,
    attempts: rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      senderDomain: row.sender_domain,
      startedAt: row.started_at,
      eligibleAt: new Date(
        new Date(row.started_at).getTime() + EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS,
      ).toISOString(),
    })),
  });
});

emailOperatorRoutes.post('/email/attempts/:id/resolve', async (context) => {
  const body = await readBody(context);
  const id = context.req.param('id');
  const reason = stringField(body, 'reason', { maxLength: 500 });
  if (body.ended !== true) {
    throw new OperatorError(
      400,
      'Confirm the original provider execution has ended with --ended.',
      'invalid_argument',
    );
  }
  const db = context.get('db');
  const [fence] = await db
    .select()
    .from(emailUnresolvedAttempts)
    .where(eq(emailUnresolvedAttempts.id, id))
    .limit(1);
  if (!fence) {
    throw new OperatorError(404, 'Unresolved email attempt not found.', 'not_found');
  }
  const eligibleAt = new Date(
    new Date(fence.started_at).getTime() + EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS,
  );
  if (eligibleAt.getTime() > Date.now()) {
    throw new OperatorError(
      409,
      `Email attempt cannot be resolved before ${eligibleAt.toISOString()}.`,
      'attempt_too_recent',
    );
  }
  const action = 'email.attempt.resolve';
  const target = { attemptId: id, projectId: fence.project_id, senderDomain: fence.sender_domain };
  if (dryRun(body)) {
    const [recipient] = await db
      .select({
        state: emailActionRecipients.state,
        projectId: emailActionRecipients.project_id,
        attemptStartedAt: emailActionRecipients.attempt_started_at,
      })
      .from(emailActionRecipients)
      .where(eq(emailActionRecipients.id, id))
      .limit(1);
    if (
      recipient &&
      (recipient.state !== 'attempt_started' ||
        recipient.projectId !== fence.project_id ||
        new Date(recipient.attemptStartedAt ?? new Date()).getTime() >
          Date.now() - EMAIL_ATTEMPT_RECOVERY_MIN_AGE_MS)
    ) {
      throw new OperatorError(409, 'Email attempt ledger disagrees with fence.', 'invalid_state');
    }
    return context.json(
      preview(action, target, {
        startedAt: fence.started_at,
        metadataExpired: !recipient,
        reason,
        effect:
          'Mark the original send outcome unknown, retain its quota charge, and release its cleanup fence. No send is retried.',
      }),
    );
  }
  try {
    const result = await resolveEmailUnresolvedAttempt(db, { id, ended: true, reason });
    return context.json({ action, target, ...result });
  } catch (error) {
    if (error instanceof EmailAdmissionError) {
      throw new OperatorError(
        error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_STATE' ? 409 : 400,
        error.message,
        error.code.toLowerCase(),
      );
    }
    throw error;
  }
});

emailOperatorRoutes.get('/email/shared-recipients', async (context) => {
  const db = context.get('db');
  const selector = context.req.query('project');
  const projectId = selector ? (await resolveProject(db, selector)).id : undefined;
  const { page, limit, offset } = pagination(context);
  const where = and(
    eq(emailSharedRecipients.installation_id, emailInstallationId(context.env)),
    projectId ? eq(emailSharedRecipients.project_id, projectId) : undefined,
  );
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(emailSharedRecipients)
      .where(where)
      .orderBy(asc(emailSharedRecipients.created_at), asc(emailSharedRecipients.id))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(emailSharedRecipients).where(where),
  ]);
  const recipients = rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    recipient: row.recipient,
    ruleName: row.rule_name,
    ruleId: row.rule_id,
    status: row.status,
    reason: row.reason,
    removing: row.removing,
    attempt: row.attempt,
    createStartedAt: row.create_started_at,
    eligibleAt: row.create_started_at
      ? new Date(
          Date.parse(row.create_started_at) + EMAIL_OPERATION_RECOVERY_MIN_AGE_MS,
        ).toISOString()
      : null,
  }));
  const total = totals[0]?.total ?? 0;
  return context.json({
    recipients,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  });
});

emailOperatorRoutes.post('/email/shared-recipients/:id/resolve', async (context) => {
  const body = await readBody(context);
  const id = context.req.param('id');
  const outcome = stringField(body, 'outcome', { maxLength: 32 });
  const reason = stringField(body, 'reason', { maxLength: 500 });
  if ((outcome !== 'applied' && outcome !== 'not-applied') || body.ended !== true) {
    throw new OperatorError(
      400,
      'Supply --ended, --outcome applied|not-applied, and a provider audit --reason.',
      'invalid_argument',
    );
  }
  try {
    const db = context.get('db');
    const action = 'email.shared-recipient.resolve';
    if (dryRun(body)) {
      const target = await inspectSharedEmailRecipientRecovery(db, context.env, id, outcome);
      return context.json(
        preview(action, target, {
          reason,
          effect:
            outcome === 'applied'
              ? 'Record the exact owned provider rule without replaying creation. Delivery remains unready until normal reconciliation verifies it.'
              : 'Release the verified creation intent for normal reconciliation or project cleanup. No provider write occurs during recovery.',
        }),
      );
    }
    const recoveryFence = stringField(body, 'recoveryFence', { maxLength: 64 });
    const result = await resolveSharedEmailRecipientCreation(db, context.env, {
      id,
      outcome,
      ended: true,
      reason,
      recoveryFence,
    });
    return context.json({ action, target: { id, outcome }, ...result });
  } catch (error) {
    emailOperationError(error);
  }
});

emailOperatorRoutes.post('/email/operations/:id/resolve', async (context) => {
  const body = await readBody(context);
  const id = context.req.param('id');
  const reason = stringField(body, 'reason', { maxLength: 500 });
  const outcome = stringField(body, 'outcome', { maxLength: 32 });
  if (outcome !== 'applied' && outcome !== 'not-applied') {
    throw new OperatorError(400, 'Outcome must be applied or not-applied.', 'invalid_argument');
  }
  if (body.ended !== true) {
    throw new OperatorError(
      400,
      'Confirm the original provider execution has ended with --ended.',
      'invalid_argument',
    );
  }
  const db = context.get('db');
  let fence;
  try {
    fence = await inspectUnknownEmailOperationRecovery(db, context.env, id);
  } catch (error) {
    emailOperationError(error);
  }
  if (new Date(fence.eligibleAt).getTime() > Date.now()) {
    throw new OperatorError(
      409,
      `Email operation cannot be resolved before ${fence.eligibleAt}.`,
      'operation_too_recent',
    );
  }
  const action = 'email.operation.resolve';
  const target = { ...fence, outcome };
  if (dryRun(body)) {
    return context.json(
      preview(action, target, {
        reason,
        effect:
          outcome === 'applied'
            ? 'Confirm the exact provider write and continue from the next step without replaying it.'
            : 'Return the exact provider write to pending so the same fenced step can be retried.',
      }),
    );
  }
  const stepId = stringField(body, 'stepId', { maxLength: 128 });
  const requestDigest = stringField(body, 'requestDigest', { maxLength: 128 });
  const resourceIdentity = stringField(body, 'resourceIdentity', { maxLength: 500 });
  const connectionId = stringField(body, 'connectionId', { maxLength: 128 });
  const attempt = body.attempt;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new OperatorError(400, 'Attempt must be a positive integer.', 'invalid_argument');
  }
  const desiredGeneration = body.desiredGeneration;
  if (
    typeof desiredGeneration !== 'number' ||
    !Number.isSafeInteger(desiredGeneration) ||
    desiredGeneration < 1
  ) {
    throw new OperatorError(
      400,
      'Desired generation must be a positive integer.',
      'invalid_argument',
    );
  }
  const routeId = body.routeId === null ? null : stringField(body, 'routeId', { maxLength: 128 });
  const routeDesiredGeneration = body.routeDesiredGeneration;
  if (
    routeDesiredGeneration !== null &&
    (typeof routeDesiredGeneration !== 'number' ||
      !Number.isSafeInteger(routeDesiredGeneration) ||
      routeDesiredGeneration < 1)
  ) {
    throw new OperatorError(
      400,
      'Route desired generation must be a positive integer or null.',
      'invalid_argument',
    );
  }
  try {
    const result = await resolveUnknownEmailOperation(db, context.env, {
      operationId: id,
      stepId,
      attempt,
      requestDigest,
      resourceIdentity,
      connectionId,
      desiredGeneration,
      routeId,
      routeDesiredGeneration,
      ended: true,
      outcome,
      reason,
    });
    return context.json({ action, target, ...result });
  } catch (error) {
    emailOperationError(error);
  }
});

// ---------------------------------------------------------------------------
// Administrator-managed domains. The operations are the owner routes' own
// (email/domain-service.ts); this layer resolves the project for the
// administrator, previews without touching Cloudflare, and re-shapes the
// service's JSON responses into operator results.
// ---------------------------------------------------------------------------

/** The service answers with the owner routes' JSON; carry a refusal over as an OperatorError. */
async function operatorResult(
  response: Response,
  action: string,
  target: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof body.error === 'string' && body.error !== ''
        ? body.error
        : 'The email domain operation failed.';
    throw new OperatorError(response.status, message, 'email_domain_error', body);
  }
  // Owner routes return durable operation state with HTTP 200. The operator
  // contract also needs a failure signal for its audit log and CLI exit status.
  const failed = body.ok === false || body.operationStatus !== 'completed';
  return { action, target, ...(failed ? { ok: false } : {}), domain: body };
}

function requireDomain(raw: string): string {
  if (raw.length > MAX_DOMAIN_LENGTH) {
    throw new OperatorError(400, 'Invalid domain.', 'invalid_argument');
  }
  const domain = normalizeEmailDomain(raw);
  if (!isValidEmailDomain(domain)) {
    throw new OperatorError(400, 'Invalid domain.', 'invalid_argument');
  }
  return domain;
}

async function requireRemovableDomainRow(db: Db, raw: string) {
  const domain = requireDomain(raw);
  const row = await getEmailDomainRowByDomain(db, domain);
  if (!row) {
    throw new OperatorError(404, 'Email domain not found.');
  }
  if (!row.project_id) {
    throw new OperatorError(404, 'Project not found.');
  }
  const projectId = row.project_id;
  return { domain, row, projectId, project: await getProject(db, projectId) };
}

async function requireDomainRow(db: Db, raw: string) {
  const { domain, row, project } = await requireRemovableDomainRow(db, raw);
  if (!project) {
    throw new OperatorError(404, 'Project not found.');
  }
  return { domain, row, project };
}

export async function listOperatorEmailDomains(context: Context<ApiEnv>, selector?: string) {
  const db = context.get('db');
  const project = selector ? await resolveProject(db, selector) : null;
  const rows = await db
    .select({ route: emailDomainRoutes, connection: emailZoneConnections })
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailDomainRoutes.connection_id, emailZoneConnections.id))
    .where(project ? eq(emailDomainRoutes.project_id, project.id) : undefined)
    .orderBy(asc(emailDomainRoutes.created_at));
  const projectIds = [
    ...new Set(rows.map(({ route }) => route.project_id).filter((id): id is string => id !== null)),
  ];
  const owners =
    projectIds.length === 0
      ? []
      : await db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, projectIds));
  const slugs = new Map(owners.map((owner) => [owner.id, owner.slug]));
  return {
    domains: rows.map(({ route, connection }) => ({
      ...serializeEmailRoute(route, connection),
      project: {
        id: route.project_id,
        slug: route.project_id ? (slugs.get(route.project_id) ?? null) : null,
      },
    })),
  };
}

export async function addOperatorEmailDomain(
  context: Context<ApiEnv>,
  input: { domain: string; project: string; apiToken?: string; outboundOnly?: boolean },
  dryRunRequested = false,
) {
  const db = context.get('db');
  const domain = requireDomain(input.domain);
  const project = await resolveProject(db, input.project);
  const existing = await getEmailDomainRowByDomain(db, domain);
  if (existing && existing.project_id !== project.id) {
    throw new OperatorError(409, 'This email domain is registered to another project.');
  }
  if (existing && existing.managed_by === 'owner') {
    throw new OperatorError(
      409,
      'This email domain was registered by its project owner; ask them to remove it first.',
    );
  }
  const credentialKind = input.apiToken ? 'api_token' : 'platform';
  const inboundMode = input.outboundOnly ? 'none' : 'managed';
  const action = 'email.domain.add';
  const target = { domain, projectId: project.id, slug: project.slug, credentialKind, inboundMode };
  if (dryRunRequested) {
    // Read-only: the engine's own MX rule, previewed over public DNS. No
    // Cloudflare call — the preview must never spend the credential.
    let mx: 'apex' | 'subdomain' | 'unknown' = 'unknown';
    try {
      mx = (await lookupMxOverDns(domain)).length > 0 ? 'subdomain' : 'apex';
    } catch {
      // A failed lookup leaves the placement unknown.
    }
    // The engine refuses to switch an active domain between inbound and outbound-only.
    const modeChange =
      existing?.desired_state === 'active' && existing.inbound_mode !== inboundMode;
    return preview(action, target, {
      existing: existing
        ? {
            status:
              existing.inbound_mode === 'none' ? existing.outbound_status : existing.inbound_status,
            managed_by: existing.managed_by,
            inboundMode: existing.inbound_mode,
          }
        : null,
      plan: modeChange ? 'refuse' : existing ? 'sync' : 'setup',
      mx,
      effect: modeChange
        ? `${domain} is ${existing.inbound_mode === 'none' ? 'outbound-only' : 'set up to receive mail'}; setup will refuse to change that — remove it first, then add it again.`
        : existing
          ? `The existing assignment for ${domain} belongs to ${project.slug}; use sync to reconcile it.`
          : input.outboundOnly
            ? `Onboards ${domain} for ${project.slug} to Cloudflare Email Sending only; its MX records and inbound mail stay with its current mail provider.`
            : mx === 'subdomain'
              ? `${domain} already receives mail; setup will refuse it — use an unused domain apex or a platform shared email address instead.`
              : credentialKind === 'platform'
                ? `Registers ${domain} for ${project.slug} on the platform's own Cloudflare credential; the zone must be in the platform's account.`
                : `Registers ${domain} for ${project.slug} with the supplied API token.`,
    });
  }
  return operatorResult(
    await addEmailDomainForProject(context, project, {
      domain,
      apiToken: input.apiToken,
      managedBy: 'admin',
      inboundMode,
    }),
    action,
    target,
  );
}

export async function getOperatorEmailDomain(context: Context<ApiEnv>, rawDomain: string) {
  const { row, project } = await requireDomainRow(context.get('db'), rawDomain);
  const response = await getEmailDomainStatusForProject(context, project, row.domain);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorError(response.status, String(body.error ?? 'status failed'));
  }
  return { ...body, project: { id: project.id, slug: project.slug } };
}

export async function syncOperatorEmailDomain(
  context: Context<ApiEnv>,
  rawDomain: string,
  dryRunRequested = false,
) {
  const { domain, row, project } = await requireDomainRow(context.get('db'), rawDomain);
  const action = 'email.domain.sync';
  const target = { domain, projectId: project.id, slug: project.slug };
  if (dryRunRequested) {
    return preview(action, target, {
      status: row.inbound_mode === 'none' ? row.outbound_status : row.inbound_status,
      managed_by: row.managed_by,
      connection_id: row.connection_id,
      effect:
        row.inbound_mode === 'none'
          ? 'Re-attempts Cloudflare Email Sending onboarding for this outbound-only domain; its MX records and inbound mail are not touched.'
          : 'Reconciles the shared zone ingress and this exact mail-domain assignment.',
    });
  }
  return operatorResult(
    await syncEmailDomainForProject(context, project, domain, 'admin'),
    action,
    target,
  );
}

export async function removeOperatorEmailDomain(
  context: Context<ApiEnv>,
  rawDomain: string,
  dryRunRequested = false,
  apiToken?: string,
) {
  const { domain, row, projectId, project } = await requireRemovableDomainRow(
    context.get('db'),
    rawDomain,
  );
  const action = 'email.domain.remove';
  const target = {
    domain,
    projectId,
    slug: project?.slug ?? null,
    ...(apiToken ? { credentialReplacement: true } : {}),
  };
  if (dryRunRequested) {
    return preview(action, target, {
      status: row.inbound_status,
      managed_by: row.managed_by,
      connection_id: row.connection_id,
      effect: apiToken
        ? 'Verifies the replacement scoped token and resumes the retained blocked project cleanup operation.'
        : 'Disables this assignment; shared ingress remains while sibling domains use it.',
    });
  }
  if (apiToken) {
    try {
      await replaceBlockedSystemEmailCleanupCredential(
        context.get('db'),
        context.env,
        row.id,
        apiToken,
      );
    } catch (error) {
      if (error instanceof EmailOperationError) {
        throw new OperatorError(error.status, error.message, 'email_domain_error');
      }
      throw error;
    }
  }
  return operatorResult(
    await removeEmailDomainForProject(context, { id: projectId }, domain, 'admin'),
    action,
    target,
  );
}

export async function rotateOperatorEmailIngressSecret(
  context: Context<ApiEnv>,
  rawDomain: string,
  dryRunRequested = false,
  attemptId?: string,
) {
  const { domain, row, project } = await requireDomainRow(context.get('db'), rawDomain);
  const action = 'email.domain.rotate-secret',
    target = { domain, projectId: project.id, slug: project.slug, connectionId: row.connection_id };
  if (row.inbound_mode === 'none') {
    throw new OperatorError(409, 'Outbound-only email domains have no ingress secret to rotate.');
  }
  if (dryRunRequested) {
    return preview(action, target, {
      effect:
        'Stages a new ingress secret and promotes it only after the deployed Worker proves it received the value.',
    });
  }
  return operatorResult(
    await rotateEmailIngressSecretForProject(context, project, domain, 'admin', attemptId),
    action,
    target,
  );
}

function outboundOnlyField(body: Record<string, unknown>): boolean {
  if (body.outboundOnly !== undefined && typeof body.outboundOnly !== 'boolean') {
    throw new OperatorError(400, 'outboundOnly must be a boolean.', 'invalid_argument');
  }
  return body.outboundOnly === true;
}

emailOperatorRoutes.get('/email/domains', async (context) =>
  context.json(await listOperatorEmailDomains(context, context.req.query('project') || undefined)),
);
emailOperatorRoutes.post('/email/domains', async (context) => {
  const body = await readBody(context);
  return context.json(
    await addOperatorEmailDomain(
      context,
      {
        domain: stringField(body, 'domain', { maxLength: MAX_DOMAIN_LENGTH }),
        project: stringField(body, 'project'),
        apiToken: stringField(body, 'apiToken', { optional: true, maxLength: 2048 }) || undefined,
        outboundOnly: outboundOnlyField(body),
      },
      dryRun(body),
    ),
  );
});
emailOperatorRoutes.get('/email/domains/:domain', async (context) =>
  context.json(await getOperatorEmailDomain(context, context.req.param('domain'))),
);
emailOperatorRoutes.post('/email/domains/:domain/sync', async (context) => {
  const body = await readBody(context);
  return context.json(
    await syncOperatorEmailDomain(context, context.req.param('domain'), dryRun(body)),
  );
});
emailOperatorRoutes.post('/email/domains/:domain/rotate-secret', async (context) => {
  const body = await readBody(context);
  return context.json(
    await rotateOperatorEmailIngressSecret(
      context,
      context.req.param('domain'),
      dryRun(body),
      body.attemptId === undefined ? undefined : stringField(body, 'attemptId', { maxLength: 128 }),
    ),
  );
});
emailOperatorRoutes.post('/email/domains/:domain/remove', async (context) => {
  const body = await readBody(context);
  return context.json(
    await removeOperatorEmailDomain(
      context,
      context.req.param('domain'),
      dryRun(body),
      stringField(body, 'apiToken', { optional: true, maxLength: MAX_CREDENTIAL_LENGTH }) ||
        undefined,
    ),
  );
});
