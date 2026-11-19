/**
 * What the operator security routes do beyond the project routes (spec §13.5, design
 * doc 0095 M17): the installation budget, per-project cap ceilings, installation-wide
 * lists, and the operator rescan. The routes (`operator/security-routes.ts`) are thin;
 * every rule lives here so the admin panel (M18) can call the same functions.
 *
 * Operator lists page with `page` and `limit` (R16), like every other operator list.
 */
import { parseSecurityUsd, type SecurityPolicy } from '@void/platform/security-policy';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  sql,
  TransactionRollbackError,
  type SQL,
} from 'drizzle-orm';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { OperatorError } from '../operator/common.ts';
import { deployments, projects, projectZeroTrust, users } from '../schema.ts';
import {
  NANO_USD_PER_USD,
  securityNextSpendMonth,
  securityScanReserveNano,
  securityUsdToCents,
} from './budget.ts';
import { SecurityApiError, SecurityPolicyUnreadableError } from './errors.ts';
import { SECURITY_FULL_REASON_NOTES, type SecurityFallbackFullReason } from './input/tier.ts';
import {
  lockSecurityPolicy,
  readSecurityPolicyLenient,
  readStoredSecurityPolicy,
  replaceSecurityPolicy,
  SecurityPolicyRevisionError,
  securitySpendMonth,
} from './policy.ts';
import {
  effectiveSeverity,
  readSecurityProjectSettings,
  scanColumns,
  securityProjectBudgetView,
  securityProjectModelView,
  securityProjectPolicyView,
  securityScanView,
} from './project-view.ts';
import { findLiveInput } from './public-gate.ts';
import {
  MAX_CAP_CENTS,
  projectSecuritySettings,
  securityFindings,
  securityPlatformSpend,
  securityProjectEvents,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  SECURITY_PUBLIC_REQUEST_STATES,
  SECURITY_SCAN_STATUSES,
  type SecurityPublicRequestState,
  type SecurityScanStatus,
  SECURITY_SEVERITIES,
  type SecuritySeverity,
} from './schema.ts';

type Page = Readonly<{ page: number; limit: number; offset: number }>;

function pageOf(total: number, paging: Page) {
  return {
    page: paging.page,
    limit: paging.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / paging.limit)),
  };
}

function iso(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

// ---------------------------------------------------------------------------
// Installation budget
// ---------------------------------------------------------------------------

/** `GET /operator/v1/security/budget`: caps and what was spent this month. */
export async function securityBudgetStatus(db: Db, now = Date.now()) {
  const policy = await readSecurityPolicyLenient(db);
  const month = securitySpendMonth(now);
  const [platform] = await db
    .select({
      spent: securityPlatformSpend.spent_nano_usd,
      reserved: securityPlatformSpend.reserved_nano_usd,
    })
    .from(securityPlatformSpend)
    .where(eq(securityPlatformSpend.month, month))
    .limit(1);
  const [top, ceilings] = await Promise.all([
    db
      .select({
        projectId: securityProjectSpend.project_id,
        slug: projects.slug,
        spent: securityProjectSpend.spent_nano_usd,
        scans: securityProjectSpend.scans,
      })
      .from(securityProjectSpend)
      .innerJoin(projects, eq(projects.id, securityProjectSpend.project_id))
      .where(eq(securityProjectSpend.month, month))
      .orderBy(desc(securityProjectSpend.spent_nano_usd), asc(securityProjectSpend.project_id))
      .limit(5),
    db
      .select({
        projectId: projectSecuritySettings.project_id,
        slug: projects.slug,
        ceiling: projectSecuritySettings.cap_ceiling_cents,
        own: projectSecuritySettings.monthly_cap_cents,
      })
      .from(projectSecuritySettings)
      .innerJoin(projects, eq(projects.id, projectSecuritySettings.project_id))
      .where(
        sql`${projectSecuritySettings.cap_ceiling_cents} IS NOT NULL OR ${projectSecuritySettings.monthly_cap_cents} IS NOT NULL`,
      )
      .orderBy(asc(projects.slug))
      .limit(100),
  ]);
  const { budgets } = policy;
  return {
    revision: policy.revision,
    month,
    resetsAt: `${securityNextSpendMonth(month)}T00:00:00.000Z`,
    platform: {
      capOn: budgets.platformCapOn,
      monthlyUsd: budgets.platformMonthlyUsd,
      spentUsd: (platform?.spent ?? 0) / NANO_USD_PER_USD,
      reservedUsd: (platform?.reserved ?? 0) / NANO_USD_PER_USD,
    },
    projectDefault: { capsOn: budgets.projectCapsOn, monthlyUsd: budgets.projectDefaultMonthlyUsd },
    topSpenders: top.map((row) => ({
      projectId: row.projectId,
      slug: row.slug,
      spentUsd: row.spent / NANO_USD_PER_USD,
      scans: row.scans,
    })),
    projectCaps: ceilings.map((row) => ({
      projectId: row.projectId,
      slug: row.slug,
      ceilingUsd: row.ceiling === null ? null : row.ceiling / 100,
      ownCapUsd: row.own === null ? null : row.own / 100,
    })),
  };
}

const BUDGET_KEYS = new Set([
  'dryRun',
  'expectedRevision',
  'platformMonthlyUsd',
  'projectDefaultMonthlyUsd',
]);

export type SecurityBudgetChangeRequest = Readonly<{
  expectedRevision?: number;
  /** `null` turns the platform cap off; a number turns it on at that amount. */
  platformMonthlyUsd?: number | null;
  /** `null` turns project caps off; a number turns them on at that default amount. */
  projectDefaultMonthlyUsd?: number | null;
}>;

function usdOrNull(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  try {
    return parseSecurityUsd(value, label);
  } catch (error) {
    throw SecurityApiError.invalid(error instanceof Error ? error.message : `Invalid ${label}.`);
  }
}

/** Parses an operator budget body. Unknown fields are refused so a typo is not ignored. */
export function parseSecurityBudgetChange(
  body: Record<string, unknown>,
): SecurityBudgetChangeRequest {
  for (const key of Object.keys(body)) {
    if (!BUDGET_KEYS.has(key)) {
      throw SecurityApiError.invalid(`Unknown security budget field: ${key}.`);
    }
  }
  const request: {
    -readonly [Key in keyof SecurityBudgetChangeRequest]: SecurityBudgetChangeRequest[Key];
  } = {};
  if (body.expectedRevision !== undefined) {
    if (
      typeof body.expectedRevision !== 'number' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0
    ) {
      throw SecurityApiError.invalid('expectedRevision must be a nonnegative whole number.');
    }
    request.expectedRevision = body.expectedRevision;
  }
  if (body.platformMonthlyUsd !== undefined) {
    request.platformMonthlyUsd = usdOrNull(body.platformMonthlyUsd, 'platformMonthlyUsd');
  }
  if (body.projectDefaultMonthlyUsd !== undefined) {
    request.projectDefaultMonthlyUsd = usdOrNull(
      body.projectDefaultMonthlyUsd,
      'projectDefaultMonthlyUsd',
    );
  }
  if (request.platformMonthlyUsd === undefined && request.projectDefaultMonthlyUsd === undefined) {
    throw SecurityApiError.invalid(
      'Send platformMonthlyUsd, projectDefaultMonthlyUsd, or both (a dollar amount, or null to turn the cap off).',
    );
  }
  return request;
}

function proposeBudgets(policy: SecurityPolicy, request: SecurityBudgetChangeRequest) {
  const platform = request.platformMonthlyUsd;
  const project = request.projectDefaultMonthlyUsd;
  return {
    ...policy.budgets,
    ...(platform === undefined
      ? {}
      : platform === null
        ? { platformCapOn: false }
        : { platformCapOn: true, platformMonthlyUsd: platform }),
    ...(project === undefined
      ? {}
      : project === null
        ? { projectCapsOn: false }
        : { projectCapsOn: true, projectDefaultMonthlyUsd: project }),
  };
}

/**
 * `POST /operator/v1/security/budget`: the platform cap, the project default and
 * whether project caps are on. Same lock and revision rule as the policy, so the two
 * never overwrite each other. A preview needs no `expectedRevision` and returns it.
 */
export async function changeSecurityBudgets(
  db: Db,
  body: Record<string, unknown>,
  options: Readonly<{ preview: boolean }>,
) {
  const request = parseSecurityBudgetChange(body);
  if (!options.preview && request.expectedRevision === undefined) {
    throw SecurityApiError.invalid(
      'expectedRevision must be the policy revision from a fresh preview.',
    );
  }
  return db.transaction(async (tx) => {
    await lockSecurityPolicy(tx);
    const stored = await readStoredSecurityPolicy(tx);
    if (stored.unreadable !== null) {
      throw new SecurityPolicyUnreadableError(stored.unreadable);
    }
    const current = stored.policy;
    if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
      throw new SecurityPolicyRevisionError(request.expectedRevision, current.revision);
    }
    const budgets = proposeBudgets(current, request);
    if (options.preview) {
      return {
        dryRun: true as const,
        action: 'security.budget' as const,
        target: 'platform' as const,
        expectedRevision: current.revision,
        from: current.budgets,
        to: budgets,
      };
    }
    const written = await replaceSecurityPolicy(tx, current, { ...current, budgets });
    return { ok: true as const, budgets: written.budgets, revision: written.revision };
  });
}

// ---------------------------------------------------------------------------
// Per-project cap ceiling
// ---------------------------------------------------------------------------

/** The new ceiling in cents; `null` clears it (the policy default applies again). */
export function parseSecurityCeilingRequest(body: Record<string, unknown>): number | null {
  if (!('monthlyUsd' in body)) {
    throw SecurityApiError.invalid('Send {"monthlyUsd":50}, or {"monthlyUsd":null} to clear.');
  }
  const usd = body.monthlyUsd;
  if (usd === null) {
    return null;
  }
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw SecurityApiError.invalid('monthlyUsd must be a dollar amount of 0 or more, or null.');
  }
  const cents = securityUsdToCents(usd);
  if (Math.abs(usd * 100 - cents) > 1e-6 || cents > MAX_CAP_CENTS) {
    throw SecurityApiError.invalid(
      `monthlyUsd must be whole cents, at most ${MAX_CAP_CENTS / 100}.`,
    );
  }
  return cents;
}

/**
 * `POST /operator/v1/projects/:id/security/budget`: an installation admin sets the
 * most a project admin may give the project (`cap_ceiling_cents`). Writes a
 * `cap_changed` event with `cap_kind = ceiling` when it moves.
 */
export async function setProjectSecurityCeiling(
  db: Db,
  input: Readonly<{
    projectId: string;
    userId: string;
    cents: number | null;
  }>,
) {
  const policy = await readSecurityPolicyLenient(db);
  const caps = await db.transaction(async (tx) => {
    await tx
      .insert(projectSecuritySettings)
      .values({ project_id: input.projectId })
      .onConflictDoNothing();
    const [current] = await tx
      .select({
        monthlyCapCents: projectSecuritySettings.monthly_cap_cents,
        capCeilingCents: projectSecuritySettings.cap_ceiling_cents,
      })
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, input.projectId))
      .for('update');
    const before = {
      monthlyCapCents: current?.monthlyCapCents ?? null,
      capCeilingCents: current?.capCeilingCents ?? null,
    };
    if (before.capCeilingCents !== input.cents) {
      await tx
        .update(projectSecuritySettings)
        .set({
          cap_ceiling_cents: input.cents,
          cap_updated_by_user_id: input.userId,
          cap_updated_at: sql`now()`,
          updated_by_user_id: input.userId,
          updated_at: sql`now()`,
        })
        .where(eq(projectSecuritySettings.project_id, input.projectId));
      await tx.insert(securityProjectEvents).values({
        id: generateId('spe'),
        project_id: input.projectId,
        actor_kind: 'installation_admin',
        actor_user_id: input.userId,
        actor_role: null,
        action: 'cap_changed',
        cap_kind: 'ceiling',
        old_cents: before.capCeilingCents,
        new_cents: input.cents,
      });
    }
    return { monthlyCapCents: before.monthlyCapCents, capCeilingCents: input.cents };
  });
  return {
    ok: true as const,
    budget: await securityProjectBudgetView(db, input.projectId, policy, caps),
  };
}

/**
 * Runs a write the way the real request would, then undoes it: a preview that fails
 * wherever the real call fails and shows what it would return (`dryRun`). Everything
 * `run` writes is inside the transaction, so nothing is kept.
 */
export async function previewInRollback<T>(db: Db, run: (tx: Db) => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      result = { value: await run(tx as unknown as Db) };
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError) || result === undefined) {
      throw error;
    }
  }
  return (result as { value: T }).value;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Project filter: a project id or a slug. */
function projectFilter(value: string | undefined): SQL | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  return sql`(${projects.id} = ${value} OR ${projects.slug} = ${value})`;
}

export type OperatorFindingFilter = Readonly<{
  project?: string;
  state: 'open' | 'resolved' | 'all';
  urgent: boolean;
  severity: SecuritySeverity | null;
}>;

export function parseOperatorFindingFilter(query: (name: string) => string | undefined) {
  const state = query('state') ?? 'open';
  if (state !== 'open' && state !== 'resolved' && state !== 'all') {
    throw new OperatorError(400, 'state must be open, resolved or all.', 'invalid_argument');
  }
  const severity = query('severity') ?? null;
  if (severity !== null && !SECURITY_SEVERITIES.some((value) => value === severity)) {
    throw new OperatorError(
      400,
      `severity must be one of: ${SECURITY_SEVERITIES.join(', ')}.`,
      'invalid_argument',
    );
  }
  const urgent = query('urgent');
  return {
    project: query('project'),
    state,
    urgent: urgent === '1' || urgent === 'true',
    severity: severity as SecuritySeverity | null,
  } satisfies OperatorFindingFilter;
}

/** Findings of every project. Oldest first: the ones waiting longest come first. */
export async function listOperatorSecurityFindings(
  db: Db,
  filter: OperatorFindingFilter,
  paging: Page,
) {
  const where = and(
    projectFilter(filter.project),
    filter.state === 'all' ? undefined : eq(securityFindings.state, filter.state),
    filter.urgent
      ? sql`${securityFindings.verdict} = 'confirmed' AND ${securityFindings.state} = 'open' AND COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) IN ('critical', 'high')`
      : undefined,
    filter.severity ? sql`${effectiveSeverity} = ${filter.severity}` : undefined,
  );
  const [rows, totals] = await Promise.all([
    db
      .select({
        projectId: securityFindings.project_id,
        slug: projects.slug,
        number: securityFindings.number,
        verdict: securityFindings.verdict,
        severity: effectiveSeverity,
        title: securityFindings.title,
        category: securityFindings.category,
        file: securityFindings.file,
        lineStart: securityFindings.line_start,
        state: securityFindings.state,
        resolution: securityFindings.resolution,
        notSeenInLatest: securityFindings.not_seen_in_latest,
        possibleDuplicateOf: securityFindings.possible_duplicate_of,
        revision: securityFindings.revision,
        deploymentId: securityFindings.first_deployment_id,
        firstSeenAt: securityFindings.created_at,
      })
      .from(securityFindings)
      .innerJoin(projects, eq(projects.id, securityFindings.project_id))
      .where(where)
      .orderBy(asc(securityFindings.created_at), asc(securityFindings.id))
      .limit(paging.limit)
      .offset(paging.offset),
    db
      .select({ total: count() })
      .from(securityFindings)
      .innerJoin(projects, eq(projects.id, securityFindings.project_id))
      .where(where),
  ]);
  return {
    findings: rows.map((row) => ({
      projectId: row.projectId,
      project: row.slug,
      id: `F-${row.number}`,
      verdict: row.verdict,
      severity: row.severity,
      title: row.title,
      category: row.category,
      file: row.file,
      line: row.lineStart,
      state: row.state,
      resolution: row.resolution,
      notSeenInLatest: row.notSeenInLatest,
      possibleDuplicateOf: row.possibleDuplicateOf,
      revision: row.revision,
      deploymentId: row.deploymentId,
      firstSeenAt: iso(row.firstSeenAt),
    })),
    ...pageOf(totals[0]?.total ?? 0, paging),
  };
}

export type OperatorScanFilter = Readonly<{
  project?: string;
  status: SecurityScanStatus | null;
  /** `gate` shows the public gate scans only. */
  gate: boolean;
}>;

export function parseOperatorScanFilter(query: (name: string) => string | undefined) {
  const status = query('status') ?? null;
  if (status !== null && !SECURITY_SCAN_STATUSES.some((value) => value === status)) {
    throw new OperatorError(
      400,
      `status must be one of: ${SECURITY_SCAN_STATUSES.join(', ')}.`,
      'invalid_argument',
    );
  }
  const trigger = query('trigger') ?? null;
  if (trigger !== null && trigger !== 'gate') {
    throw new OperatorError(400, 'trigger must be gate.', 'invalid_argument');
  }
  return {
    project: query('project'),
    status: status as SecurityScanStatus | null,
    gate: trigger === 'gate',
  } satisfies OperatorScanFilter;
}

/** Scans of every project, newest first, with this month's totals (spec §11.4 Scans screen). */
export async function listOperatorSecurityScans(
  db: Db,
  filter: OperatorScanFilter,
  paging: Page,
  now = Date.now(),
) {
  const where = and(
    projectFilter(filter.project),
    filter.status ? eq(securityScans.status, filter.status) : undefined,
    filter.gate ? eq(securityScans.trigger, 'gate') : undefined,
  );
  const month = securitySpendMonth(now);
  // The month figures are installation-wide (they track the installation budget), so the
  // project, status and trigger filters shape the list only.
  const [rows, totals, summary] = await Promise.all([
    db
      .select({
        ...scanColumns,
        projectId: securityScans.project_id,
        slug: projects.slug,
        modelCalls: securityScans.model_calls,
        tokensIn: securityScans.tokens_in,
        tokensOut: securityScans.tokens_out,
        gatewayNanoUsd: securityScans.cost_nano_usd,
      })
      .from(securityScans)
      .innerJoin(projects, eq(projects.id, securityScans.project_id))
      .where(where)
      .orderBy(desc(securityScans.created_at), desc(securityScans.id))
      .limit(paging.limit)
      .offset(paging.offset),
    db
      .select({ total: count() })
      .from(securityScans)
      .innerJoin(projects, eq(projects.id, securityScans.project_id))
      .where(where),
    db
      .select({
        status: securityScans.status,
        total: count(),
        metered: sql<number>`COALESCE(SUM(${securityScans.metered_nano_usd}), 0)::float8`,
        gateway: sql<number>`COALESCE(SUM(${securityScans.cost_nano_usd}), 0)::float8`,
        budgetSkipped: sql<number>`COUNT(*) FILTER (WHERE ${securityScans.status} = 'skipped' AND ${securityScans.status_reason} LIKE 'budget%')::int`,
      })
      .from(securityScans)
      .where(sql`${securityScans.created_at} >= ${`${month}T00:00:00Z`}::timestamptz`)
      .groupBy(securityScans.status),
  ]);
  const monthTotal = (status: string) => summary.find((row) => row.status === status)?.total ?? 0;
  return {
    scans: rows.map((row) => ({
      ...securityScanView(row, 'full'),
      projectId: row.projectId,
      project: row.slug,
      modelCalls: row.modelCalls,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      gatewayUsd: row.gatewayNanoUsd === null ? null : row.gatewayNanoUsd / NANO_USD_PER_USD,
    })),
    month: {
      month,
      scans: summary.reduce((sum, row) => sum + row.total, 0),
      meteredUsd: summary.reduce((sum, row) => sum + row.metered, 0) / NANO_USD_PER_USD,
      gatewayUsd: summary.reduce((sum, row) => sum + row.gateway, 0) / NANO_USD_PER_USD,
      refused: monthTotal('refused'),
      failed: monthTotal('failed') + monthTotal('timed_out'),
      skippedBudget: summary.reduce((sum, row) => sum + row.budgetSkipped, 0),
    },
    ...pageOf(totals[0]?.total ?? 0, paging),
  };
}

export function parseOperatorRequestFilter(query: (name: string) => string | undefined) {
  const state = query('state') ?? 'open';
  const known: ReadonlyArray<string> = ['open', 'closed', 'all', ...SECURITY_PUBLIC_REQUEST_STATES];
  if (!known.includes(state)) {
    throw new OperatorError(400, `state must be one of: ${known.join(', ')}.`, 'invalid_argument');
  }
  return { project: query('project'), state };
}

/** Public requests of every project: open ones by default, the longest-waiting first. */
export async function listOperatorPublicRequests(
  db: Db,
  filter: Readonly<{ project?: string; state: string }>,
  paging: Page,
) {
  const open = [...SECURITY_PUBLIC_REQUEST_OPEN_STATES] as Array<SecurityPublicRequestState>;
  const where = and(
    projectFilter(filter.project),
    filter.state === 'all'
      ? undefined
      : filter.state === 'open'
        ? inArray(securityPublicRequests.state, open)
        : filter.state === 'closed'
          ? sql`${securityPublicRequests.state} NOT IN (${sql.join(
              open.map((state) => sql`${state}`),
              sql`, `,
            )})`
          : eq(securityPublicRequests.state, filter.state as SecurityPublicRequestState),
  );
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: securityPublicRequests.id,
        projectId: securityPublicRequests.project_id,
        slug: projects.slug,
        state: securityPublicRequests.state,
        heldReason: securityPublicRequests.held_reason,
        requestedVia: securityPublicRequests.requested_via,
        targetDeploymentId: securityPublicRequests.target_deployment_id,
        gateScanId: securityPublicRequests.gate_scan_id,
        blockers: securityPublicRequests.blockers,
        blockerIds: securityPublicRequests.blocker_ids,
        cancelCause: securityPublicRequests.cancel_cause,
        createdAt: securityPublicRequests.created_at,
        updatedAt: securityPublicRequests.updated_at,
        closedAt: securityPublicRequests.closed_at,
      })
      .from(securityPublicRequests)
      .innerJoin(projects, eq(projects.id, securityPublicRequests.project_id))
      .where(where)
      .orderBy(asc(securityPublicRequests.created_at), asc(securityPublicRequests.id))
      .limit(paging.limit)
      .offset(paging.offset),
    db
      .select({ total: count() })
      .from(securityPublicRequests)
      .innerJoin(projects, eq(projects.id, securityPublicRequests.project_id))
      .where(where),
  ]);
  return {
    requests: rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      project: row.slug,
      state: row.state,
      heldReason: row.heldReason,
      requestedVia: row.requestedVia,
      targetDeploymentId: row.targetDeploymentId,
      gateScanId: row.gateScanId,
      blockers: { count: row.blockers, ids: row.blockerIds },
      cancelCause: row.cancelCause,
      requestedAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      closedAt: iso(row.closedAt),
    })),
    ...pageOf(totals[0]?.total ?? 0, paging),
  };
}

/** The bypass record, newest first. Operators see the reason; audit rows never do. */
export async function listOperatorBypasses(
  db: Db,
  filter: Readonly<{ project?: string }>,
  paging: Page,
) {
  const where = projectFilter(filter.project);
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: securityScanBypasses.id,
        projectId: securityScanBypasses.project_id,
        slug: projects.slug,
        requestId: securityScanBypasses.request_id,
        deploymentId: securityScanBypasses.deployment_id,
        actorKind: securityScanBypasses.actor_kind,
        actorUserId: securityScanBypasses.actor_user_id,
        actorRole: securityScanBypasses.actor_role,
        reason: securityScanBypasses.reason,
        requestState: securityScanBypasses.request_state,
        heldReason: securityScanBypasses.held_reason,
        gateScanId: securityScanBypasses.gate_scan_id,
        blockers: securityScanBypasses.blockers,
        blockerIds: securityScanBypasses.blocker_ids,
        notifiedAt: securityScanBypasses.notified_at,
        createdAt: securityScanBypasses.created_at,
      })
      .from(securityScanBypasses)
      .innerJoin(projects, eq(projects.id, securityScanBypasses.project_id))
      .where(where)
      .orderBy(desc(securityScanBypasses.created_at), desc(securityScanBypasses.id))
      .limit(paging.limit)
      .offset(paging.offset),
    db
      .select({ total: count() })
      .from(securityScanBypasses)
      .innerJoin(projects, eq(projects.id, securityScanBypasses.project_id))
      .where(where),
  ]);
  return {
    bypasses: rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      project: row.slug,
      requestId: row.requestId,
      deploymentId: row.deploymentId,
      actorKind: row.actorKind,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole,
      reason: row.reason,
      requestState: row.requestState,
      heldReason: row.heldReason,
      gateScanId: row.gateScanId,
      blockers: { count: row.blockers, ids: row.blockerIds },
      notifiedAt: iso(row.notifiedAt),
      createdAt: iso(row.createdAt),
    })),
    ...pageOf(totals[0]?.total ?? 0, paging),
  };
}

// ---------------------------------------------------------------------------
// Rescan
// ---------------------------------------------------------------------------

const WAITING_OR_RUNNING = ['pending_input', 'queued', 'running'] as const;

type RescanTarget = Readonly<{
  projectId: string;
  slug: string;
  deploymentId: string;
}>;

/**
 * Scans queued by a person or a schedule for the live deployment, not by a deploy.
 * `fallback` (M26) is the one re-scan on the `@cf` default after a failed scan.
 */
export type SecurityManualTrigger = 'rescan' | 'backfill' | 'sweep' | 'fallback';

export type SecurityRescanOptions = Readonly<{
  trigger?: SecurityManualTrigger;
  /** Who asks, for the wording of a refusal: only an operator can cancel a scan. */
  by?: 'operator' | 'project';
  /**
   * The open public request a fallback re-runs the gate scan for: the row carries it,
   * so a protected project's fallback still runs under `public` (like a gate scan).
   */
  publicRequestId?: string | null;
  /**
   * A fallback of a rescan or a sweep is the same full scan: the note set here makes the
   * scan start choose it (`securityFallbackFullReason`).
   */
  fallbackOf?: SecurityFallbackFullReason | null;
}>;

/**
 * Checks everything a rescan needs and says what it would do (cost preview, edge #43).
 * Reads only. Throws an `OperatorError` for a rescan that cannot run. The project
 * route (M25) and the batch scans (backfill, sweeps) use the same checks.
 */
export async function previewSecurityRescan(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: Db,
  projectId: string,
  options: SecurityRescanOptions = {},
) {
  const [project] = await db
    .select({
      slug: projects.slug,
      status: projects.status,
      active: projects.active_deployment_id,
      suspended: users.suspended_reason,
    })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    throw new OperatorError(404, 'Project not found.', 'not_found');
  }
  if (project.status === 'deleting') {
    throw new OperatorError(409, 'Project is being deleted.', 'project_deleting');
  }
  const policy = await readSecurityPolicyLenient(db);
  const scope = await securityProjectPolicyView(db, {
    projectId,
    slug: project.slug,
    capability: true,
    policy,
  });
  if (!scope.applies) {
    throw new OperatorError(
      409,
      `${project.slug} is not scanned: ${scope.reason}.`,
      'security_not_in_scope',
    );
  }
  if (project.suspended !== null) {
    throw new OperatorError(409, `${project.slug}'s owner is suspended.`, 'security_not_in_scope');
  }
  const [live] = project.active
    ? await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(and(eq(deployments.id, project.active), eq(deployments.status, 'live')))
        .limit(1)
    : [];
  if (!live) {
    throw new OperatorError(
      409,
      `${project.slug} has no live deployment to scan.`,
      'no_live_deployment',
    );
  }
  const [busy] = await db
    .select({ id: securityScans.id, status: securityScans.status })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        inArray(securityScans.status, [...WAITING_OR_RUNNING]),
      ),
    )
    .limit(1);
  if (busy) {
    throw new OperatorError(
      409,
      `${project.slug} already has a scan ${busy.status === 'running' ? 'running' : 'waiting'} (${busy.id}). ${options.by === 'project' ? 'Wait for it to end.' : 'Wait for it, or cancel it first.'}`,
      'security_scan_in_progress',
      { scanId: busy.id },
    );
  }
  if (!(await findLiveInput(env, db, projectId, live.id))) {
    throw new OperatorError(
      409,
      `The code of ${live.id} is no longer stored, so it cannot be scanned. Deploy ${project.slug} again.`,
      'security_input_unavailable',
    );
  }
  const [scanned] = await db
    .select({ id: securityScans.id })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        eq(securityScans.deployment_id, live.id),
        eq(securityScans.status, 'succeeded'),
      ),
    )
    .limit(1);
  const settings = await readSecurityProjectSettings(db, projectId);
  const model = securityProjectModelView(policy, settings);
  const worstCase = model.id === null ? null : securityScanReserveNano(model.id, policy.limits);
  return {
    target: { projectId, slug: project.slug, deploymentId: live.id } satisfies RescanTarget,
    alreadyScanned: scanned !== undefined,
    tier: 'full' as const,
    model: model.id,
    thirdParty: model.thirdParty,
    worstCaseUsd: worstCase === null ? null : worstCase / NANO_USD_PER_USD,
    budget: await securityProjectBudgetView(db, projectId, policy, settings.caps),
  };
}

/**
 * Queues a manual rescan of the live deployment: a full scan, never `no changes`
 * (edge #43). It waits in the queue like any scan, and the monthly caps apply when it
 * starts. Under the project lock it checks again that the deployment is still live and
 * that nothing else waits. `trigger` `backfill` and `sweep` queue the same row for
 * the batch scans.
 */
export async function queueSecurityRescan(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: Db,
  projectId: string,
  options: SecurityRescanOptions = {},
) {
  const trigger = options.trigger ?? 'rescan';
  const preview = await previewSecurityRescan(env, db, projectId, options);
  const input = await findLiveInput(env, db, projectId, preview.target.deploymentId);
  if (!input) {
    throw new OperatorError(
      409,
      'The live deployment cannot be scanned.',
      'security_input_unavailable',
    );
  }
  const policy = await readSecurityPolicyLenient(db);
  const scanId = generateId('scan');
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const [live] = await tx
      .select({ id: projects.active_deployment_id })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (live?.id !== preview.target.deploymentId) {
      throw new OperatorError(
        409,
        'A new deployment went live meanwhile. Run the rescan again.',
        'security_scan_in_progress',
      );
    }
    const [busy] = await tx
      .select({ id: securityScans.id })
      .from(securityScans)
      .where(
        and(
          eq(securityScans.project_id, projectId),
          inArray(securityScans.status, [...WAITING_OR_RUNNING]),
        ),
      )
      .limit(1);
    if (busy) {
      throw new OperatorError(
        409,
        `${preview.target.slug} already has a scan in the queue (${busy.id}).`,
        'security_scan_in_progress',
        { scanId: busy.id },
      );
    }
    const [zeroTrust] = await tx
      .select({
        status: projectZeroTrust.status,
        desired: projectZeroTrust.desired_protected,
        effective: projectZeroTrust.effective_protected,
      })
      .from(projectZeroTrust)
      .where(eq(projectZeroTrust.project_id, projectId));
    const isProtected =
      zeroTrust?.status === 'ready' && zeroTrust.desired === true && zeroTrust.effective === true;
    await tx.insert(securityScans).values({
      id: scanId,
      project_id: projectId,
      deployment_id: preview.target.deploymentId,
      status: 'queued',
      trigger,
      public_request_id: options.publicRequestId ?? null,
      coverage_notes: options.fallbackOf ? [SECURITY_FULL_REASON_NOTES[options.fallbackOf]] : [],
      input_r2_key: input.r2Key,
      policy_mode_at_enqueue: policy.mode,
      public_at_enqueue: !isProtected,
      first_queued_at: sql`now()`,
      queued_at: sql`now()`,
    });
  });
  return { preview, scanId };
}

// ---------------------------------------------------------------------------
// Scan lookup for cancel
// ---------------------------------------------------------------------------

/** The scan (any project) and whether it can still be canceled. */
export async function readCancelableScan(db: Db, scanId: string) {
  const [row] = await db
    .select({
      id: securityScans.id,
      projectId: securityScans.project_id,
      slug: projects.slug,
      status: securityScans.status,
    })
    .from(securityScans)
    .innerJoin(projects, eq(projects.id, securityScans.project_id))
    .where(eq(securityScans.id, scanId))
    .limit(1);
  return row ?? null;
}

export const SECURITY_SCAN_CANCELABLE: ReadonlyArray<SecurityScanStatus> = WAITING_OR_RUNNING;
