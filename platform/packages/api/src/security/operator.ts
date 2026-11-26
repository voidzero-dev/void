/**
 * The operator security rules beyond the project routes (spec §13.5, design doc 0095 M17):
 * the installation budget, cap ceilings, installation-wide lists (paged with `page` and
 * `limit`, R16) and the rescan. The CLI routes and the admin panel (M18) share them.
 */
import { parseSecurityUsd } from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, asc, count, desc, eq, inArray, ne, sql, TransactionRollbackError } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { OperatorError } from '../operator/common.ts';
import { deployments, projects, projectZeroTrust, users } from '../schema.ts';
import { NANO_USD_PER_USD, securityNextSpendMonth, securityScanReserveNano } from './budget.ts';
import { SecurityApiError, SecurityPolicyUnreadableError } from './errors.ts';
import { SECURITY_CLIENT_ASSETS_NOTE } from './input/build.ts';
import { SECURITY_FULL_REASON_NOTES } from './input/tier.ts';
import type { SecurityFallbackFullReason } from './input/tier.ts';
import {
  lockSecurityPolicy,
  parseSecurityWholeNumber,
  readSecurityPolicyLenient,
  readStoredSecurityPolicy,
  replaceSecurityPolicy,
  SecurityPolicyRevisionError,
  securitySpendMonth,
} from './policy.ts';
import { SECURITY_PROJECT_POLICY_COPY } from './project-policy.ts';
import type { SecurityProjectPolicyOverride } from './project-policy.ts';
import { parseSecurityMonthlyUsd, writeSecurityProjectCap } from './project-settings.ts';
import {
  effectiveSeverity,
  readSecurityProjectSettings,
  scanColumns,
  securityIso as iso,
  securityProjectBudgetView,
  securityProjectModelView,
  securityProjectPolicyView,
  securityScanView,
  securityUrgentSql,
} from './project-view.ts';
import { findLiveInput } from './public-gate.ts';
import {
  projectSecuritySettings,
  securityFindings,
  securityPlatformSpend,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  SECURITY_PUBLIC_REQUEST_STATES,
  SECURITY_SCAN_STATUSES,
  SECURITY_SEVERITIES,
} from './schema.ts';
import type { SecurityPublicRequestState, SecurityScanStatus, SecuritySeverity } from './schema.ts';

type Page = Readonly<{ page: number; limit: number; offset: number }>;

/** The page fields of a list: the rows of `table` (joined to their project) under `where`. */
async function pageOf(
  db: Db,
  table: PgTable & { project_id: AnyPgColumn },
  where: SQL | undefined,
  paging: Page,
) {
  const [row] = await db
    .select({ total: count() })
    .from(table)
    .innerJoin(projects, eq(projects.id, table.project_id))
    .where(where);
  const total = row?.total ?? 0;
  return {
    page: paging.page,
    limit: paging.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / paging.limit)),
  };
}

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

const BUDGET_KEYS = new Set(
  'dryRun expectedRevision platformMonthlyUsd projectDefaultMonthlyUsd'.split(' '),
);

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
    request.expectedRevision = parseSecurityWholeNumber(body.expectedRevision, 'expectedRevision');
  }
  for (const key of ['platformMonthlyUsd', 'projectDefaultMonthlyUsd'] as const) {
    if (body[key] !== undefined) {
      request[key] = usdOrNull(body[key], key);
    }
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

/** `POST /operator/v1/security/budget`, under the policy's lock and revision rule. */
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

/** The new ceiling in cents; `null` clears it (the policy default applies again). */
export function parseSecurityCeilingRequest(body: Record<string, unknown>): number | null {
  if (!('monthlyUsd' in body)) {
    throw SecurityApiError.invalid('Send {"monthlyUsd":50}, or {"monthlyUsd":null} to clear.');
  }
  return parseSecurityMonthlyUsd(body.monthlyUsd);
}

/** `POST /operator/v1/projects/:id/security/budget`: the most a project admin may set. */
export async function setProjectSecurityCeiling(
  db: Db,
  input: Readonly<{ projectId: string; userId: string; cents: number | null }>,
) {
  return writeSecurityProjectCap(db, { ...input, by: 'installation_admin' });
}

/**
 * `POST /operator/v1/projects/:id/security/policy`: the project's own scan rule (M34),
 * under the project row lock. Nothing is queued or canceled here.
 */
export async function setProjectSecurityPolicyOverride(
  db: Db,
  input: Readonly<{
    projectId: string;
    userId: string;
    override: SecurityProjectPolicyOverride;
  }>,
) {
  const from = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`);
    const [current] = await tx
      .select({ override: projectSecuritySettings.policy_override })
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, input.projectId))
      .for('update');
    const before: SecurityProjectPolicyOverride = current?.override ?? 'inherit';
    if (before === input.override) {
      return before;
    }
    await tx
      .insert(projectSecuritySettings)
      .values({
        project_id: input.projectId,
        policy_override: input.override,
        updated_by_user_id: input.userId,
      })
      .onConflictDoUpdate({
        target: projectSecuritySettings.project_id,
        set: {
          policy_override: input.override,
          updated_by_user_id: input.userId,
          updated_at: sql`now()`,
        },
      });
    return before;
  });
  const [project] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  const slug = project?.slug ?? input.projectId;
  const policy = await readSecurityPolicyLenient(db);
  const scope = await securityProjectPolicyView(db, {
    projectId: input.projectId,
    slug,
    capability: true,
    policy,
  });
  const lines = [`${slug}: ${SECURITY_PROJECT_POLICY_COPY[input.override]}.`];
  lines.push(`Scans apply: ${scope.applies ? 'yes' : 'no'} (${scope.reason}).`);
  if (from !== input.override) {
    if (input.override === 'never') {
      // `applies` under `never` means a public request is open: its gate scan (and the
      // fallback of it) still runs (D46).
      lines.push(
        scope.applies
          ? 'A waiting scan of it is skipped when it would start, unless it is the scan for its request to go public; a running scan finishes.'
          : 'A waiting scan of it is skipped when it would start; a running scan finishes.',
      );
    } else if (scope.applies) {
      lines.push(
        `Nothing is scanned now: its next deploy is. To scan it now: void platform security rescan ${input.projectId}`,
      );
    }
  }
  return {
    ok: true as const,
    slug,
    override: { from, to: input.override },
    policy: scope,
    preview: lines,
  };
}

/** Runs a write as the real request would, then rolls it back: a faithful `dryRun`. */
export async function previewInRollback<T>(db: Db, run: (tx: Db) => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await db.transaction(async (tx) => {
      result = { value: await run(tx) };
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError) || result === undefined) {
      throw error;
    }
  }
  return (result as { value: T }).value;
}

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
    filter.urgent ? securityUrgentSql : undefined,
    filter.severity ? sql`${effectiveSeverity} = ${filter.severity}` : undefined,
  );
  const [rows, page] = await Promise.all([
    db
      .select({
        projectId: securityFindings.project_id,
        slug: projects.slug,
        number: securityFindings.number,
        verdict: securityFindings.verdict,
        severity: effectiveSeverity,
        title: securityFindings.title,
        category: securityFindings.category,
        cwe: securityFindings.cwe,
        file: securityFindings.file,
        lineStart: securityFindings.line_start,
        lineEnd: securityFindings.line_end,
        verdictSource: securityFindings.verdict_source,
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
    pageOf(db, securityFindings, where, paging),
  ]);
  return {
    findings: rows.map(({ slug, number, lineStart, verdictSource, firstSeenAt, ...row }) => ({
      ...row,
      project: slug,
      id: `F-${number}`,
      line: lineStart,
      verdictSource: row.verdict === 'confirmed' ? verdictSource : null,
      firstSeenAt: iso(firstSeenAt),
    })),
    ...page,
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
  const [rows, page, summary] = await Promise.all([
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
    pageOf(db, securityScans, where, paging),
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
    ...page,
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
  const [rows, page] = await Promise.all([
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
    pageOf(db, securityPublicRequests, where, paging),
  ]);
  return {
    requests: rows.map(
      ({ slug, blockers, blockerIds, createdAt, updatedAt, closedAt, ...row }) => ({
        ...row,
        project: slug,
        blockers: { count: blockers, ids: blockerIds },
        requestedAt: iso(createdAt),
        updatedAt: iso(updatedAt),
        closedAt: iso(closedAt),
      }),
    ),
    ...page,
  };
}

/** The bypass record, newest first. Operators see the reason; audit rows never do. */
export async function listOperatorBypasses(
  db: Db,
  filter: Readonly<{ project?: string }>,
  paging: Page,
) {
  const where = projectFilter(filter.project);
  const [rows, page] = await Promise.all([
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
    pageOf(db, securityScanBypasses, where, paging),
  ]);
  return {
    bypasses: rows.map(({ slug, blockers, blockerIds, notifiedAt, createdAt, ...row }) => ({
      ...row,
      project: slug,
      blockers: { count: blockers, ids: blockerIds },
      notifiedAt: iso(notifiedAt),
      createdAt: iso(createdAt),
    })),
    ...page,
  };
}

const WAITING_OR_RUNNING = ['pending_input', 'queued', 'running'] as const;

/** A scan of the project that waits or runs. A local check (M32) scans no deployment. */
async function busyScan(db: DbOrTx, projectId: string) {
  const [busy] = await db
    .select({ id: securityScans.id, status: securityScans.status })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        inArray(securityScans.status, [...WAITING_OR_RUNNING]),
        ne(securityScans.trigger, 'local'),
      ),
    )
    .limit(1);
  return busy;
}

/** Scans of the live deployment queued by a person or a schedule, not by a deploy. */
export type SecurityManualTrigger = 'rescan' | 'backfill' | 'sweep' | 'fallback';

export type SecurityRescanOptions = Readonly<{
  trigger?: SecurityManualTrigger;
  /** Who asks, for the wording of a refusal: only an operator can cancel a scan. */
  by?: 'operator' | 'project';
  /** The open public request a fallback re-runs the gate scan for. */
  publicRequestId?: string | null;
  /** A fallback of a rescan or a sweep is the same full scan (a coverage note). */
  fallbackOf?: SecurityFallbackFullReason | null;
  /** M31: the client asset pass (a coverage note). */
  clientAssets?: boolean;
}>;

/** Every rescan check and the cost preview (edge #43). Reads only; `OperatorError` when refused. */
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
  // The rule `never` (M34) leaves only the scans of a public request: a gate scan, and
  // the fallback that re-runs it (`publicRequestId`).
  if (scope.override === 'never' && !options.publicRequestId) {
    throw new OperatorError(
      409,
      `${project.slug} is not scanned: a platform admin turned scans off for this project.`,
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
  const busy = await busyScan(db, projectId);
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
    target: { projectId, slug: project.slug, deploymentId: live.id },
    alreadyScanned: scanned !== undefined,
    tier: 'full' as const,
    clientAssets: options.clientAssets === true,
    model: model.id,
    thirdParty: model.thirdParty,
    worstCaseUsd: worstCase === null ? null : worstCase / NANO_USD_PER_USD,
    budget: await securityProjectBudgetView(db, projectId, policy, settings.caps),
  };
}

/**
 * Queues a full scan of the live deployment (edge #43), checking again under the project
 * lock that it is still live and that nothing else waits.
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
    const busy = await busyScan(tx, projectId);
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
      coverage_notes: [
        ...(options.fallbackOf ? [SECURITY_FULL_REASON_NOTES[options.fallbackOf]] : []),
        ...(options.clientAssets ? [SECURITY_CLIENT_ASSETS_NOTE] : []),
      ],
      input_r2_key: input.r2Key,
      input_prefix: input.inputPrefix,
      policy_mode_at_enqueue: policy.mode,
      public_at_enqueue: !isProtected,
      first_queued_at: sql`now()`,
      queued_at: sql`now()`,
    });
  });
  return { preview, scanId };
}

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
