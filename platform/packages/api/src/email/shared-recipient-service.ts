import type { DeployManifest } from '@void/deploy-core';
import { and, asc, eq, ne, notInArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import { deployments, projects } from '../schema.ts';
import { createCfCustomerClient, type CfEmailRoutingRule } from './cf-customer.ts';
import {
  emailDomainRoutes,
  emailSharedRecipients,
  emailZoneConnections,
} from './connection-schema.ts';
import {
  credentialFor,
  digest,
  EMAIL_OPERATION_RECOVERY_MIN_AGE_MS,
  EmailOperationError,
  emailInstallationId,
  inspectEmailInboundRoute,
} from './connection-service.ts';
import { projectMailbox, projectMailboxNames } from './mailbox.ts';

type Bindings = ApiEnv['Bindings'];
type Recipient = typeof emailSharedRecipients.$inferSelect;
const LEASE_MS = 15 * 60_000;
// Canonical deployment manifests already distinguish handlers from send-only apps.
const inboundManifest = sql`${deployments.manifest}::jsonb -> 'emailProtocolVersion' = '1'::jsonb`;

async function hasActiveEmailHandlers(db: DbOrTx, projectId: string) {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(
      deployments,
      and(
        eq(deployments.id, projects.active_deployment_id),
        eq(deployments.project_id, projects.id),
        eq(deployments.status, 'live'),
      ),
    )
    .where(and(eq(projects.id, projectId), eq(projects.status, 'active'), inboundManifest))
    .limit(1);
  return rows.length > 0;
}

async function recipientConnection(db: DbOrTx, env: Bindings, row: Recipient) {
  const [resolved] = await db
    .select()
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailZoneConnections.id, emailDomainRoutes.connection_id))
    .where(eq(emailDomainRoutes.id, row.route_id))
    .limit(1);
  const connection = resolved?.email_zone_connections;
  if (
    !connection ||
    resolved.email_domain_routes.addressing !== 'shared' ||
    connection.installation_id !== row.installation_id ||
    row.installation_id !== emailInstallationId(env) ||
    connection.managed_by !== 'admin' ||
    connection.account_id !== env.CF_ACCOUNT_ID ||
    connection.account_id !== env.EMAIL_SHARED_ACCOUNT_ID ||
    connection.zone_id !== env.EMAIL_SHARED_ZONE_ID ||
    connection.ingress_worker_name !== env.EMAIL_SHARED_INGRESS_NAME
  ) {
    throw new EmailOperationError(
      'Shared recipient cleanup identity does not match this installation',
    );
  }
  return connection;
}

/** Explicit operator recovery shares the existing 24-hour provider-write fence.
 * Absence alone never authorizes retry: the operator must attest execution ended
 * and its audited outcome, then apply the exact preview after fresh readback. */
export async function inspectSharedEmailRecipientRecovery(
  db: Db,
  env: Bindings,
  id: string,
  outcome: 'applied' | 'not-applied',
) {
  if (outcome !== 'applied' && outcome !== 'not-applied') {
    throw new EmailOperationError('Provider outcome must be applied or not-applied', 400);
  }
  const [row] = await db
    .select()
    .from(emailSharedRecipients)
    .where(eq(emailSharedRecipients.id, id));
  if (!row) {
    throw new EmailOperationError('Shared recipient intent not found', 404);
  }
  if (!row.create_started_at || row.rule_id || row.status === 'removed') {
    throw new EmailOperationError('Shared recipient has no ambiguous creation to resolve', 409);
  }
  const eligibleAt = new Date(
    Date.parse(row.create_started_at) + EMAIL_OPERATION_RECOVERY_MIN_AGE_MS,
  ).toISOString();
  if (
    Date.parse(eligibleAt) > Date.now() ||
    (row.status === 'reconciling' && Date.parse(row.lease_started_at ?? '') > Date.now() - LEASE_MS)
  ) {
    throw new EmailOperationError(
      `Shared recipient cannot be resolved before ${eligibleAt} or while reconciliation is running`,
      409,
    );
  }
  const connection = await recipientConnection(db, env, row);
  const [project] = await db.select().from(projects).where(eq(projects.id, row.project_id));
  if (!project) {
    throw new EmailOperationError('Shared recipient project is unavailable', 409);
  }
  const client = createCfCustomerClient(await credentialFor(env, db, connection));
  const inspectRules = async () => {
    const rules = await client.listRoutingRules(connection.zone_id);
    const named = rules.filter((rule) => rule.name === row.rule_name);
    if (
      named.length > 1 ||
      named.some(
        (rule) => !isOwnedSharedRecipientRule(rule, row, connection.ingress_worker_name),
      ) ||
      rules.some(
        (rule) =>
          ruleConflicts(rule, row.recipient) &&
          !isOwnedSharedRecipientRule(rule, row, connection.ingress_worker_name),
      )
    ) {
      throw new EmailOperationError(
        'Shared recipient provider ownership is conflicting or changed',
        409,
      );
    }
    return named[0] ?? null;
  };
  const listed = await inspectRules();
  let providerRuleId: string | null = null;
  if (outcome === 'applied') {
    const exact = listed?.id ? await client.getRoutingRule(connection.zone_id, listed.id) : null;
    if (!exact || !isOwnedSharedRecipientRule(exact, row, connection.ingress_worker_name)) {
      throw new EmailOperationError(
        'The exact owned shared recipient rule must be present to confirm applied',
        409,
      );
    }
    providerRuleId = exact.id;
  } else if (listed || (await inspectRules())) {
    throw new EmailOperationError(
      'A shared recipient rule is present; inspect its applied outcome instead',
      409,
    );
  }
  const target = {
    id: row.id,
    projectId: row.project_id,
    projectSlug: project.slug,
    projectStatus: project.status,
    recipient: row.recipient,
    ruleName: row.rule_name,
    createStartedAt: row.create_started_at,
    attempt: row.attempt,
    removing: row.removing,
    status: row.status,
    leaseStartedAt: row.lease_started_at,
    routeId: row.route_id,
    connectionId: connection.id,
    accountId: connection.account_id,
    zoneId: connection.zone_id,
    workerName: connection.ingress_worker_name,
    providerRuleId,
    eligibleAt,
    outcome,
  };
  const recoveryFence = await digest([
    target,
    row.route_id,
    row.status,
    row.lease_started_at,
    project.slug,
    project.status,
  ]);
  return { ...target, recoveryFence };
}

export async function resolveSharedEmailRecipientCreation(
  db: Db,
  env: Bindings,
  input: {
    id: string;
    outcome: 'applied' | 'not-applied';
    ended: true;
    reason: string;
    recoveryFence: string;
  },
) {
  if (input.ended !== true || !input.reason.trim()) {
    throw new EmailOperationError(
      'Confirm the original execution ended and provide a provider audit reason',
      400,
    );
  }
  const fence = await inspectSharedEmailRecipientRecovery(db, env, input.id, input.outcome);
  if (input.recoveryFence !== fence.recoveryFence) {
    throw new EmailOperationError(
      'Shared recipient recovery preview changed; inspect a new plan',
      409,
    );
  }
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, fence.projectId))
      .for('update');
    const [current] = await tx
      .select()
      .from(emailSharedRecipients)
      .where(eq(emailSharedRecipients.id, input.id))
      .for('update');
    if (
      !project ||
      project.slug !== fence.projectSlug ||
      project.status !== fence.projectStatus ||
      !current ||
      current.attempt !== fence.attempt ||
      current.create_started_at !== fence.createStartedAt ||
      current.rule_id ||
      current.removing !== fence.removing ||
      current.status !== fence.status ||
      current.lease_started_at !== fence.leaseStartedAt ||
      current.route_id !== fence.routeId ||
      (current.status === 'reconciling' &&
        Date.parse(current.lease_started_at ?? '') > Date.now() - LEASE_MS)
    ) {
      throw new EmailOperationError(
        'Shared recipient recovery was superseded; inspect a new plan',
        409,
      );
    }
    const currentConnection = await recipientConnection(tx, env, current);
    if (
      currentConnection.id !== fence.connectionId ||
      currentConnection.account_id !== fence.accountId ||
      currentConnection.zone_id !== fence.zoneId ||
      currentConnection.ingress_worker_name !== fence.workerName
    ) {
      throw new EmailOperationError(
        'Shared recipient recovery ownership changed; inspect a new plan',
        409,
      );
    }
    const [resolved] = await tx
      .update(emailSharedRecipients)
      .set({
        rule_id: fence.providerRuleId,
        create_started_at: null,
        status: current.removing ? 'blocked' : 'pending',
        reason: `Operator confirmed ${input.outcome}: ${input.reason}`,
        attempt: current.attempt + 1,
        lease_started_at: null,
        observed_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(emailSharedRecipients.id, current.id))
      .returning({ id: emailSharedRecipients.id, status: emailSharedRecipients.status });
    return resolved!;
  });
}

async function sharedRoute(db: Db, env: Bindings) {
  if (!env.EMAIL_SENDER_DOMAIN) {
    return null;
  }
  const [row] = await db
    .select()
    .from(emailDomainRoutes)
    .innerJoin(emailZoneConnections, eq(emailZoneConnections.id, emailDomainRoutes.connection_id))
    .where(
      and(
        eq(emailDomainRoutes.domain, env.EMAIL_SENDER_DOMAIN.toLowerCase()),
        eq(emailDomainRoutes.addressing, 'shared'),
        eq(emailDomainRoutes.desired_state, 'active'),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const connection = row.email_zone_connections;
  if (
    connection.installation_id !== emailInstallationId(env) ||
    connection.account_id !== env.CF_ACCOUNT_ID ||
    connection.account_id !== env.EMAIL_SHARED_ACCOUNT_ID ||
    connection.zone_id !== env.EMAIL_SHARED_ZONE_ID ||
    connection.ingress_worker_name !== env.EMAIL_SHARED_INGRESS_NAME ||
    connection.managed_by !== 'admin'
  ) {
    throw new EmailOperationError(
      'shared email ingress identity does not match this installation',
      503,
    );
  }
  return { route: row.email_domain_routes, connection };
}

export function isOwnedSharedRecipientRule(
  rule: CfEmailRoutingRule,
  row: Pick<Recipient, 'rule_id' | 'rule_name' | 'recipient'>,
  worker: string,
) {
  return Boolean(
    rule.id &&
    (!row.rule_id || rule.id === row.rule_id) &&
    rule.name === row.rule_name &&
    rule.literalWorker &&
    rule.workerName === worker &&
    rule.addresses.length === 1 &&
    rule.addresses[0] === row.recipient,
  );
}

function ruleConflicts(rule: CfEmailRoutingRule, recipient: string) {
  const at = recipient.lastIndexOf('@');
  const local = recipient.slice(0, at),
    domain = recipient.slice(at + 1);
  return rule.addresses.some((address) => {
    const split = address.lastIndexOf('@');
    return (
      address.slice(split + 1) === domain && address.slice(0, split).split('+', 1)[0] === local
    );
  });
}

/**
 * Read-only check before a permanent email alias is saved: Cloudflare must be
 * able to route it. No unrelated rule may own the address or its plus
 * addresses, and the shared mail domain needs room for one more rule.
 */
export async function checkSharedEmailAliasRoutable(
  db: Db,
  env: Bindings,
  slug: string,
  alias: string,
): Promise<void> {
  const shared = await sharedRoute(db, env);
  if (!shared) {
    return;
  }
  const recipient = `${alias}@${shared.route.domain}`;
  if (recipient.length > 90) {
    throw new EmailOperationError(
      'Shared email address exceeds Cloudflare’s 90-character routing-rule limit; choose a shorter alias',
      400,
    );
  }
  const client = createCfCustomerClient(await credentialFor(env, db, shared.connection));
  const rules = await client.listRoutingRules(shared.connection.zone_id);
  if (rules.some((rule) => ruleConflicts(rule, recipient))) {
    throw new EmailOperationError(
      `A Cloudflare Email Routing rule already routes ${recipient} or one of its plus addresses; choose another alias`,
      409,
    );
  }
  // A project that does not receive mail yet will need a slug rule too.
  const slugRecipient = `${slug}@${shared.route.domain}`;
  const needed = rules.some((rule) => rule.addresses.includes(slugRecipient)) ? 1 : 2;
  if (
    rules.filter((rule) =>
      rule.addresses.some((address) => address.endsWith(`@${shared.route.domain}`)),
    ).length +
      needed >
    200
  ) {
    throw new EmailOperationError(
      'Shared mail domain has no room for the alias under Cloudflare’s 200 routing-rule limit; ask a platform administrator to remove unused rules or request a higher limit',
      409,
    );
  }
}

async function ownershipName(installation: string, projectId: string, recipient: string) {
  return `void-shared-${await digest([installation, projectId, recipient])}`;
}

function failureReason(error: unknown) {
  if (error instanceof EmailOperationError) {
    return error.message;
  }
  if (error instanceof CloudflareApiError && error.status === 403) {
    return 'Cloudflare denied shared recipient management; grant Email Routing Rules Write and Zone Settings Write';
  }
  if (
    error instanceof CloudflareApiError &&
    (error.status === 409 || /limit|maximum|capacity/i.test(error.message))
  ) {
    return 'Cloudflare could not allocate an Email Routing rule; remove unused rules or review the Email Routing limits at https://developers.cloudflare.com/email-service/platform/limits/';
  }
  return 'Cloudflare shared recipient routing could not be verified; retry reconciliation';
}

function currentClaim(row: Recipient) {
  return and(
    eq(emailSharedRecipients.id, row.id),
    eq(emailSharedRecipients.attempt, row.attempt),
    eq(emailSharedRecipients.status, 'reconciling'),
    eq(emailSharedRecipients.removing, row.removing),
  );
}

async function finish(
  db: Db,
  row: Recipient,
  values: Partial<typeof emailSharedRecipients.$inferInsert>,
) {
  const rows = await db
    .update(emailSharedRecipients)
    .set({ ...values, lease_started_at: null, observed_at: sql`now()`, updated_at: sql`now()` })
    .where(currentClaim(row))
    .returning({ id: emailSharedRecipients.id });
  return rows.length === 1;
}

/** Provider reads can outlive a lease. Renew only the exact current claim;
 * a zero-row CAS must stop before any provider write or ownership checkpoint. */
async function renewClaim(
  db: Db,
  row: Recipient,
  values: Partial<typeof emailSharedRecipients.$inferInsert> = {},
) {
  const rows = await db
    .update(emailSharedRecipients)
    .set({ ...values, lease_started_at: sql`now()`, updated_at: sql`now()` })
    .where(currentClaim(row))
    .returning({ id: emailSharedRecipients.id });
  return rows.length === 1;
}

/** No transaction spans provider I/O. The project lock fences teardown and slug reuse. */
export async function reconcileSharedEmailRecipient(
  db: Db,
  env: Bindings,
  projectId: string,
  incomingManifest?: Pick<DeployManifest, 'emailProtocolVersion'>,
): Promise<void> {
  // Admission supplies its validated incoming manifest so a first receiving
  // deployment can provision before it has an active deployment pointer.
  if (
    incomingManifest
      ? incomingManifest.emailProtocolVersion !== 1
      : !(await hasActiveEmailHandlers(db, projectId))
  ) {
    return;
  }
  const shared = await sharedRoute(db, env);
  if (!shared) {
    return;
  }
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project || project.status !== 'active') {
    return;
  }
  // One exact rule per mailbox name: the slug, plus the email alias once set.
  const recipients = projectMailboxNames(project).map((name) => `${name}@${shared.route.domain}`);
  await removeSharedEmailRecipients(db, env, projectId, recipients);
  // Try every name before failing: a slug rule that keeps failing must not
  // stop the alias row from being created, or the cron, which orders by the
  // alias row, would pick this project first on every run.
  let failure: { error: unknown } | undefined;
  for (const recipient of recipients) {
    try {
      await reconcileProjectRecipient(db, env, project, shared, recipient, incomingManifest);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

async function reconcileProjectRecipient(
  db: Db,
  env: Bindings,
  project: typeof projects.$inferSelect,
  shared: NonNullable<Awaited<ReturnType<typeof sharedRoute>>>,
  recipient: string,
  incomingManifest: Pick<DeployManifest, 'emailProtocolVersion'> | undefined,
): Promise<void> {
  const projectId = project.id;
  const name = await ownershipName(shared.connection.installation_id, projectId, recipient);
  const claimed = await db.transaction(async (tx) => {
    const [lockedProject] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (
      !lockedProject ||
      lockedProject.status !== 'active' ||
      lockedProject.slug !== project.slug ||
      lockedProject.email_alias !== project.email_alias ||
      (!incomingManifest && !(await hasActiveEmailHandlers(tx, projectId)))
    ) {
      return null;
    }
    await tx
      .insert(emailSharedRecipients)
      .values({
        id: generateId('erec'),
        installation_id: shared.connection.installation_id,
        project_id: projectId,
        route_id: shared.route.id,
        recipient,
        rule_name: name,
      })
      .onConflictDoNothing();
    let [row] = await tx
      .select()
      .from(emailSharedRecipients)
      .where(
        and(
          eq(emailSharedRecipients.installation_id, shared.connection.installation_id),
          eq(emailSharedRecipients.project_id, projectId),
          eq(emailSharedRecipients.recipient, recipient),
        ),
      )
      .for('update');
    // A removed row for a wanted address comes back: an older runtime, after a
    // platform rollback, removes the alias rule it does not know about.
    if (row?.status === 'removed') {
      const [restored] = await tx
        .update(emailSharedRecipients)
        .set({
          status: 'pending',
          removing: false,
          rule_id: null,
          create_started_at: null,
          reason: null,
          updated_at: sql`now()`,
        })
        .where(eq(emailSharedRecipients.id, row.id))
        .returning();
      row = restored;
    } else if (
      row?.removing &&
      !(
        row.status === 'reconciling' &&
        Date.parse(row.lease_started_at ?? '') > Date.now() - LEASE_MS
      )
    ) {
      // A removal that stopped part way, also from an older runtime. Keep the
      // recorded rule and creation intent: the checks below adopt a rule that
      // still exists and refuse to guess about an unclear creation.
      const [restored] = await tx
        .update(emailSharedRecipients)
        .set({ status: 'pending', removing: false, reason: null, updated_at: sql`now()` })
        .where(eq(emailSharedRecipients.id, row.id))
        .returning();
      row = restored;
    }
    if (
      !row ||
      row.removing ||
      (row.status === 'reconciling' &&
        Date.parse(row.lease_started_at ?? '') > Date.now() - LEASE_MS)
    ) {
      return null;
    }
    const [claimedRow] = await tx
      .update(emailSharedRecipients)
      .set({
        status: 'reconciling',
        attempt: row.attempt + 1,
        lease_started_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(emailSharedRecipients.id, row.id))
      .returning();
    return claimedRow!;
  });
  if (!claimed) {
    return;
  }
  let row = claimed;
  try {
    // Record the refusal so scheduled repair remains fair even for long names.
    if (recipient.length > 90) {
      throw new EmailOperationError(
        'Shared email address exceeds Cloudflare’s 90-character routing-rule limit; use a shorter project slug or shared mail domain',
        400,
      );
    }
    const client = createCfCustomerClient(await credentialFor(env, db, shared.connection));
    const domainIssue = await inspectEmailInboundRoute(
      client,
      shared.connection,
      shared.route.domain,
      'shared',
    );
    if (domainIssue) {
      throw new EmailOperationError(domainIssue);
    }
    const rules = await client.listRoutingRules(shared.connection.zone_id);
    const named = rules.filter((rule) => rule.name === row.rule_name);
    if (
      named.length > 1 ||
      named.some(
        (rule) => !isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name),
      )
    ) {
      throw new EmailOperationError(
        'Shared recipient rule ownership changed; restore the recorded rule before reconciliation',
      );
    }
    if (
      rules.some(
        (rule) =>
          ruleConflicts(rule, recipient) &&
          !isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name),
      )
    ) {
      throw new EmailOperationError(
        `An unrelated Cloudflare Email Routing rule owns ${recipient} or one of its plus addresses; remove that conflict before reconciliation`,
      );
    }
    let rule = named[0];
    if (row.rule_id && !rule) {
      const existing = await client.getRoutingRule(shared.connection.zone_id, row.rule_id);
      if (existing) {
        throw new EmailOperationError(
          'Recorded shared recipient rule ownership changed; restore it before reconciliation',
        );
      }
      if (!(await renewClaim(db, row, { rule_id: null, create_started_at: null }))) {
        return;
      }
      row = { ...row, rule_id: null, create_started_at: null };
    }
    if (!rule) {
      if (row.create_started_at) {
        await finish(db, row, {
          status: 'unknown',
          reason:
            'A previous recipient-rule creation has an unknown outcome; inspect Cloudflare before retrying or deleting this project',
        });
        return;
      }
      if (
        rules.filter((candidate) =>
          candidate.addresses.some((address) => address.endsWith(`@${shared.route.domain}`)),
        ).length >= 200
      ) {
        throw new EmailOperationError(
          'Shared mail domain reached Cloudflare’s 200 routing-rule limit; remove unused rules or request a higher limit at https://developers.cloudflare.com/email-service/platform/limits/',
        );
      }
      // Persist creation intent before POST. A lost response is recovered only
      // by exact deterministic ownership; absence never authorizes another POST.
      const intent = new Date().toISOString();
      if (!(await renewClaim(db, row, { create_started_at: intent }))) {
        return;
      }
      row = { ...row, create_started_at: intent };
      rule = await client.putLiteralRule(shared.connection.zone_id, null, {
        name: row.rule_name,
        address: recipient,
        workerName: shared.connection.ingress_worker_name,
      });
    } else if (!rule.enabled) {
      if (!(await renewClaim(db, row))) {
        return;
      }
      rule = await client.putLiteralRule(shared.connection.zone_id, rule.id, {
        name: row.rule_name,
        address: recipient,
        workerName: shared.connection.ingress_worker_name,
      });
    }
    if (!isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name)) {
      throw new EmailOperationError('Cloudflare returned an incomplete shared recipient rule');
    }
    if (!(await renewClaim(db, row, { rule_id: rule.id, create_started_at: null }))) {
      return;
    }
    row = { ...row, rule_id: rule.id };
    const live = await client.getRoutingRule(shared.connection.zone_id, rule.id!);
    if (
      !live?.enabled ||
      !isOwnedSharedRecipientRule(live, row, shared.connection.ingress_worker_name)
    ) {
      throw new EmailOperationError('Cloudflare did not confirm the exact shared recipient rule');
    }
    const after = await client.listRoutingRules(shared.connection.zone_id);
    if (
      after.some((candidate) => candidate.id !== row.rule_id && ruleConflicts(candidate, recipient))
    ) {
      throw new EmailOperationError('A conflicting recipient rule appeared during reconciliation');
    }
    await finish(db, row, { status: 'ready', reason: null, create_started_at: null });
  } catch (error) {
    const rejected =
      error instanceof CloudflareApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408;
    await finish(db, row, {
      status: row.create_started_at && !row.rule_id && !rejected ? 'unknown' : 'blocked',
      reason: failureReason(error),
      ...(rejected ? { create_started_at: null } : {}),
    });
  }
}

/**
 * Readiness of one mailbox name, or of the whole project when `name` is left
 * out: then every name must be ready, and the result names the address the
 * project shows unless another one is the problem.
 */
export async function getSharedEmailRecipientReadiness(
  db: Db,
  env: Bindings,
  projectId: string,
  verifyProvider = false,
  name?: string,
) {
  const shared = await sharedRoute(db, env);
  if (!shared) {
    return null;
  }
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    return null;
  }
  const names = name ? [name] : projectMailboxNames(project);
  const results = [];
  for (const candidate of names) {
    results.push(
      await recipientReadiness(
        db,
        env,
        shared,
        project,
        `${candidate}@${shared.route.domain}`,
        verifyProvider,
      ),
    );
  }
  const shown = `${name ?? projectMailbox(project)}@${shared.route.domain}`;
  return (
    results.find((result) => result.status !== 'ready') ??
    results.find((result) => result.recipient === shown)!
  );
}

async function recipientReadiness(
  db: Db,
  env: Bindings,
  shared: NonNullable<Awaited<ReturnType<typeof sharedRoute>>>,
  project: typeof projects.$inferSelect,
  recipient: string,
  verifyProvider: boolean,
) {
  const projectId = project.id;
  const [row] = await db
    .select()
    .from(emailSharedRecipients)
    .where(
      and(
        eq(emailSharedRecipients.installation_id, shared.connection.installation_id),
        eq(emailSharedRecipients.project_id, projectId),
        eq(emailSharedRecipients.recipient, recipient),
      ),
    )
    .limit(1);
  let status =
    project.status !== 'active'
      ? 'disabled'
      : row?.status === 'ready' &&
          row.rule_id &&
          !row.removing &&
          shared.route.inbound_status === 'ready'
        ? 'ready'
        : row?.status === 'ready'
          ? 'pending'
          : (row?.status ?? 'pending');
  let reason =
    row?.reason ?? (shared.route.inbound_status !== 'ready' ? shared.route.inbound_reason : null);
  if (verifyProvider && status === 'ready' && row?.rule_id) {
    try {
      const client = createCfCustomerClient(await credentialFor(env, db, shared.connection));
      const [domainIssue, rule, rules] = await Promise.all([
        inspectEmailInboundRoute(client, shared.connection, shared.route.domain, 'shared'),
        client.getRoutingRule(shared.connection.zone_id, row.rule_id),
        client.listRoutingRules(shared.connection.zone_id),
      ]);
      reason =
        domainIssue ??
        (!rule?.enabled ||
        !isOwnedSharedRecipientRule(rule, row, shared.connection.ingress_worker_name)
          ? 'The exact shared recipient rule is missing or changed'
          : rules.some(
                (candidate) => candidate.id !== row.rule_id && ruleConflicts(candidate, recipient),
              )
            ? 'An unrelated rule conflicts with this shared recipient or its plus addresses'
            : null);
    } catch (error) {
      reason = failureReason(error);
    }
    if (reason) {
      status = 'blocked';
    }
    await db
      .update(emailSharedRecipients)
      .set({ status: status === 'ready' ? 'ready' : 'blocked', reason, observed_at: sql`now()` })
      .where(
        and(
          eq(emailSharedRecipients.id, row.id),
          eq(emailSharedRecipients.status, 'ready'),
          eq(emailSharedRecipients.attempt, row.attempt),
        ),
      );
  }
  return { recipient, status, reason, observedAt: row?.observed_at ?? null };
}

/** Critical cleanup: retain the project's reusable slug until exact deletion readback succeeds. */
export async function removeSharedEmailRecipients(
  db: Db,
  env: Bindings,
  projectId: string,
  keepRecipients: ReadonlyArray<string> = [],
): Promise<void> {
  const rows = await db
    .select()
    .from(emailSharedRecipients)
    .where(
      and(
        eq(emailSharedRecipients.project_id, projectId),
        ne(emailSharedRecipients.status, 'removed'),
        keepRecipients.length > 0
          ? notInArray(emailSharedRecipients.recipient, [...keepRecipients])
          : undefined,
      ),
    );
  for (const initial of rows) {
    const connection = await recipientConnection(db, env, initial);
    const row = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(emailSharedRecipients)
        .where(eq(emailSharedRecipients.id, initial.id))
        .for('update');
      if (!current || current.status === 'removed') {
        return null;
      }
      if (
        current.status === 'reconciling' &&
        Date.parse(current.lease_started_at ?? '') > Date.now() - LEASE_MS
      ) {
        throw new EmailOperationError(
          'Shared recipient reconciliation is still running; retry project deletion',
        );
      }
      const [claimed] = await tx
        .update(emailSharedRecipients)
        .set({
          removing: true,
          status: 'reconciling',
          attempt: current.attempt + 1,
          lease_started_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where(eq(emailSharedRecipients.id, current.id))
        .returning();
      return claimed!;
    });
    if (!row) {
      continue;
    }
    try {
      const client = createCfCustomerClient(await credentialFor(env, db, connection));
      const rules = await client.listRoutingRules(connection.zone_id);
      const owned = rules.filter(
        (rule) => rule.name === row.rule_name || (row.rule_id && rule.id === row.rule_id),
      );
      if (
        owned.length > 1 ||
        owned.some((rule) => !isOwnedSharedRecipientRule(rule, row, connection.ingress_worker_name))
      ) {
        throw new EmailOperationError(
          'Shared recipient cleanup ownership changed; restore the recorded rule before deleting this project',
        );
      }
      // Listing can be stale. A retained ID must be absent from an exact GET
      // before its reusable address can be released.
      const rule =
        owned[0] ??
        (row.rule_id ? await client.getRoutingRule(connection.zone_id, row.rule_id) : null);
      if (rule && !isOwnedSharedRecipientRule(rule, row, connection.ingress_worker_name)) {
        throw new EmailOperationError(
          'Shared recipient cleanup ownership changed; restore the recorded rule before deleting this project',
        );
      }
      if (!rule && row.create_started_at && !row.rule_id) {
        throw new EmailOperationError(
          'Shared recipient creation has an unknown outcome; resolve it before deleting this project',
        );
      }
      if (rule) {
        const exact = await client.getRoutingRule(connection.zone_id, rule.id!);
        if (exact && !isOwnedSharedRecipientRule(exact, row, connection.ingress_worker_name)) {
          throw new EmailOperationError('Shared recipient ownership changed before deletion');
        }
        if (exact) {
          if (!(await renewClaim(db, row))) {
            throw new EmailOperationError(
              'Shared recipient cleanup was superseded; retry project deletion',
            );
          }
          await client.deleteRoutingRule(connection.zone_id, exact.id!);
        }
        if (await client.getRoutingRule(connection.zone_id, rule.id!)) {
          throw new EmailOperationError('Cloudflare did not confirm shared recipient deletion');
        }
      }
      if (!(await finish(db, row, { status: 'removed', reason: null, create_started_at: null }))) {
        throw new EmailOperationError(
          'Shared recipient cleanup was superseded; retry project deletion',
        );
      }
    } catch (error) {
      await finish(db, row, { status: 'blocked', reason: failureReason(error) });
      throw error;
    }
  }
}

/** Fair bounded repair includes drifted ready rows; provider writes remain identity-fenced. */
export async function reconcileSharedEmailRecipients(db: Db, env: Bindings, limit = 10) {
  if (!(await sharedRoute(db, env))) {
    return;
  }
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(
      deployments,
      and(
        eq(deployments.id, projects.active_deployment_id),
        eq(deployments.project_id, projects.id),
        eq(deployments.status, 'live'),
      ),
    )
    // Order by the shown name's row, so a project whose new alias has no rule
    // yet comes first. Each run reconciles every name of the project.
    .leftJoin(
      emailSharedRecipients,
      and(
        eq(emailSharedRecipients.project_id, projects.id),
        eq(
          emailSharedRecipients.recipient,
          sql`coalesce(${projects.email_alias}, ${projects.slug}) || '@' || ${env.EMAIL_SENDER_DOMAIN!.toLowerCase()}`,
        ),
      ),
    )
    .where(and(eq(projects.status, 'active'), inboundManifest))
    .orderBy(sql`${emailSharedRecipients.updated_at} asc nulls first`, asc(projects.id))
    .limit(limit);
  for (const row of rows) {
    await reconcileSharedEmailRecipient(db, env, row.id);
  }
}
