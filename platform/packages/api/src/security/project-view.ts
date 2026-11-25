/**
 * What the project API shows about security audits (spec §13.5) and who sees what (spec
 * §3), in one place so every route applies it: `full` (a user session with `deploy`) gets
 * titles, files, lines and dollars; `counts` (readers, CI tokens, OIDC) F-ids, severities
 * and counts only.
 */
import { isRecord } from '@void/deploy-core';
import {
  isThirdPartySecurityModel,
  SECURITY_PROVIDER_NOTICE_VERSION,
} from '@void/platform/security-models';
import type { SecurityModelId } from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { hasProjectCapability } from '../project-access.ts';
import { deployments, projectZeroTrust } from '../schema.ts';
import type { ProjectRole } from '../types.ts';
import { readZeroTrustConfigurationStrict } from '../zero-trust/configuration.ts';
import {
  NANO_USD_PER_USD,
  securityEffectiveProjectCapCents,
  securityNextSpendMonth,
  securityProjectCeiling,
  securityScanReserveNano,
  securitySpendMonth,
} from './budget.ts';
import type { SecurityProjectCapSettings } from './budget.ts';
import { securityCoverageLabel } from './input/tier.ts';
import { resolveSecurityScanModel, securityPickProblem } from './models.ts';
import { readSecurityPlanCap } from './plan-caps.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import { readSecurityProjectPolicyOverride } from './project-policy.ts';
import {
  projectSecuritySettings,
  securityFindings,
  securityProjectSpend,
  securityPublicRequests,
  securityScans,
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
} from './schema.ts';
import type { SecuritySeverity } from './schema.ts';

export type SecurityDetailLevel = 'full' | 'counts';

/** The caller as the security routes see it. `credential` = a deploy token (CI, build, OIDC). */
export type SecurityViewer = Readonly<{ role: ProjectRole; credential: boolean }>;

export function securityDetailLevel(viewer: SecurityViewer): SecurityDetailLevel {
  return !viewer.credential && hasProjectCapability(viewer.role, 'deploy') ? 'full' : 'counts';
}

/** `F-12`. */
export function securityFindingLabel(number: number): string {
  return `F-${number}`;
}

/** A finding reference from a URL: `F-12`, `12` (a number) or a finding id. */
export function parseSecurityFindingRef(
  value: string,
): Readonly<{ number: number } | { id: string }> {
  const label = /^F-(\d{1,9})$/i.exec(value);
  const digits = label?.[1] ?? (/^\d{1,9}$/.test(value) ? value : null);
  if (digits !== null) {
    return { number: Number(digits) };
  }
  return { id: value };
}

/** Postgres `timestamptz` text as an ISO string; anything unparseable is returned as is. */
export function securityIso(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** The severity a finding counts with: a human edit (Phase 3) wins over the model's. */
export const effectiveSeverity = sql<SecuritySeverity | null>`COALESCE(${securityFindings.severity_override}, ${securityFindings.severity})`;

/** Open, confirmed, critical or high. */
export const securityUrgentSql = sql`${securityFindings.verdict} = 'confirmed' AND ${securityFindings.state} = 'open' AND COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) IN ('critical', 'high')`;

const MAX_URGENT_ROWS = 5;
const notLocal = ne(securityScans.trigger, 'local');

/**
 * Whether scans apply to this project now, and why (spec §11.4). A project counts as
 * protected only when every part says so. The project rule (M34) comes after the mode:
 * `never` takes the project out (a public request still scans it), `always` keeps a
 * protected project in under `public`.
 */
export async function securityProjectPolicyView(
  db: DbOrTx,
  input: Readonly<{ projectId: string; slug: string; capability: boolean; policy: SecurityPolicy }>,
) {
  const { policy } = input;
  const override = await readSecurityProjectPolicyOverride(db, input.projectId);
  const view = (applies: boolean, reason: string) => ({
    mode: policy.mode,
    applies,
    reason,
    publicGate: input.capability && policy.publicGate,
    override,
  });
  if (!input.capability || policy.mode === 'disabled') {
    return {
      ...view(false, 'Security audits are off on this platform.'),
      mode: 'disabled' as const,
    };
  }
  if (input.slug.startsWith('preview-')) {
    return view(false, 'preview projects are not scanned');
  }
  if (override === 'never') {
    return (await hasOpenPublicRequest(db, input.projectId))
      ? view(
          true,
          'a platform admin turned scans off for this project; it is still scanned before it goes public (public request)',
        )
      : view(false, 'a platform admin turned scans off for this project');
  }
  if (policy.mode === 'all') {
    return view(true, 'the platform scans all projects');
  }
  if (override === 'always') {
    return view(true, 'a platform admin turned scans on for this project');
  }
  const [row] = await db
    .select({
      status: projectZeroTrust.status,
      desired: projectZeroTrust.desired_protected,
      effective: projectZeroTrust.effective_protected,
    })
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, input.projectId));
  if (!row || !row.desired) {
    return view(true, 'not protected by Zero Trust');
  }
  if (row.status === 'error') {
    return view(true, 'Zero Trust protection failed; run void project zero-trust status');
  }
  if (row.status === 'reconciling' || row.desired !== row.effective) {
    return view(
      true,
      'Zero Trust protection is still being set up; it counts as public until ready',
    );
  }
  let configuration;
  try {
    configuration = await readZeroTrustConfigurationStrict(db);
  } catch {
    configuration = null;
  }
  if (!configuration?.enabled) {
    return view(true, 'not protected by Zero Trust');
  }
  if (configuration.publicAccess) {
    return view(true, "the platform's Zero Trust is in public-only mode");
  }
  if (await hasOpenPublicRequest(db, input.projectId)) {
    return view(true, 'scanned before it goes public (public request)');
  }
  return view(
    false,
    'this project is protected by Zero Trust and the platform scans public projects only',
  );
}

async function hasOpenPublicRequest(db: DbOrTx, projectId: string): Promise<boolean> {
  const [open] = await db
    .select({ id: securityPublicRequests.id })
    .from(securityPublicRequests)
    .where(
      and(
        eq(securityPublicRequests.project_id, projectId),
        inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
      ),
    )
    .limit(1);
  return open !== undefined;
}

export async function readSecurityProjectSettings(
  db: DbOrTx,
  projectId: string,
): Promise<
  Readonly<{ model: string | null; noticeVersion: number | null; caps: SecurityProjectCapSettings }>
> {
  const [row] = await db
    .select({
      model: projectSecuritySettings.model,
      noticeVersion: projectSecuritySettings.provider_notice_version,
      monthlyCapCents: projectSecuritySettings.monthly_cap_cents,
      capCeilingCents: projectSecuritySettings.cap_ceiling_cents,
    })
    .from(projectSecuritySettings)
    .where(eq(projectSecuritySettings.project_id, projectId));
  return {
    model: row?.model ?? null,
    noticeVersion: row?.noticeVersion ?? null,
    caps: {
      monthlyCapCents: row?.monthlyCapCents ?? null,
      capCeilingCents: row?.capCeilingCents ?? null,
      planCap: await readSecurityPlanCap(db, projectId),
    },
  };
}

/**
 * `id`: what the next scan runs on (`null`: every model is blocked); `requested`: the
 * project's pick, else the default; `source` is `fallback` whenever the pick does not run;
 * `pendingDefault`: a third-party default that waits for the provider notice.
 */
export function securityProjectModelView(
  policy: SecurityPolicy,
  settings: Readonly<{ model: string | null; noticeVersion: number | null }>,
) {
  const resolved = resolveSecurityScanModel(policy, settings);
  const noticeAccepted = settings.noticeVersion === SECURITY_PROVIDER_NOTICE_VERSION;
  const used = resolved?.used ?? null;
  const pending =
    settings.model === null &&
    !noticeAccepted &&
    isThirdPartySecurityModel(policy.defaultModel) &&
    used !== policy.defaultModel
      ? policy.defaultModel
      : null;
  const source: 'project' | 'default' | 'fallback' | null =
    used === null
      ? null
      : used === (settings.model ?? policy.defaultModel)
        ? settings.model === null
          ? 'default'
          : 'project'
        : 'fallback';
  return {
    id: used,
    requested: settings.model ?? policy.defaultModel,
    source,
    pickProblem: securityPickProblem(policy, settings, used),
    thirdParty: used !== null && isThirdPartySecurityModel(used),
    noticeAccepted,
    pendingDefault: pending,
  };
}

/**
 * `capUsd` is the cap that applies now (the lower of the limit and the project's own) and
 * `ceilingUsd` the most a project admin may set; `null` is none. `scanReserveUsd` is the
 * most one scan with `model` can cost (spec §16.1): a scan starts only when it still fits.
 */
export async function securityProjectBudgetView(
  db: DbOrTx,
  projectId: string,
  policy: SecurityPolicy,
  caps: SecurityProjectCapSettings,
  now = Date.now(),
  model: SecurityModelId | null = null,
) {
  const month = securitySpendMonth(now);
  const [spend] = await db
    .select({ spent: securityProjectSpend.spent_nano_usd })
    .from(securityProjectSpend)
    .where(
      and(eq(securityProjectSpend.project_id, projectId), eq(securityProjectSpend.month, month)),
    );
  const limit = securityProjectCeiling(caps, policy.budgets);
  const ceiling = limit?.cents ?? null;
  const effective = securityEffectiveProjectCapCents(caps, policy.budgets);
  const own = caps.monthlyCapCents;
  const reserve = model === null ? null : securityScanReserveNano(model, policy.limits);
  const capSource: 'own' | 'limit' | 'none' =
    effective === null
      ? 'none'
      : own !== null && (ceiling === null || own <= ceiling)
        ? 'own'
        : 'limit';
  return {
    capUsd: effective === null ? null : effective / 100,
    capSource,
    ceilingUsd: ceiling === null ? null : ceiling / 100,
    ceilingSource: limit?.source ?? null,
    spentUsd: (spend?.spent ?? 0) / NANO_USD_PER_USD,
    month,
    resetsAt: `${securityNextSpendMonth(month)}T00:00:00.000Z`,
    scanReserveUsd: reserve === null ? null : reserve / NANO_USD_PER_USD,
  };
}

export const scanColumns = {
  id: securityScans.id,
  status: securityScans.status,
  statusReason: securityScans.status_reason,
  failureCause: securityScans.failure_cause,
  errorClass: securityScans.error_class,
  refusalCategory: securityScans.refusal_category,
  trigger: securityScans.trigger,
  deploymentId: securityScans.deployment_id,
  baseDeploymentId: securityScans.base_deployment_id,
  tier: securityScans.tier,
  coverage: securityScans.coverage,
  coverageNotes: securityScans.coverage_notes,
  backlogFiles: securityScans.backlog_files,
  filesScanned: securityScans.files_scanned,
  modelUsed: securityScans.model_used,
  engine: securityScans.engine,
  meteredNanoUsd: securityScans.metered_nano_usd,
  queuedAt: securityScans.queued_at,
  startedAt: securityScans.started_at,
  finishedAt: securityScans.finished_at,
  createdAt: securityScans.created_at,
};

/** Scan rows with `scanColumns`, newest first. */
function scanRows(db: DbOrTx, where: SQL | undefined) {
  return db
    .select(scanColumns)
    .from(securityScans)
    .where(where)
    .orderBy(desc(securityScans.created_at), desc(securityScans.id));
}

type ScanRow = Awaited<ReturnType<typeof scanRows>>[number];

/**
 * Why the budget skipped a scan (spec §16.1), from the scheduler's `error_class`: `*_cap`
 * = that cap is used up, `*_reserve` = one scan's worst case does not fit in what is left.
 */
const BUDGET_CAUSES = [
  'project_cap',
  'platform_cap',
  'project_reserve',
  'platform_reserve',
] as const;
export type SecurityBudgetCause = (typeof BUDGET_CAUSES)[number];

export type SecurityScanView = ReturnType<typeof securityScanView>;

export function securityScanView(row: ScanRow, level: SecurityDetailLevel) {
  return {
    id: row.id,
    status: row.status,
    statusReason: row.statusReason,
    failureCause: row.failureCause,
    /** Which cap skipped a `skipped:budget` scan; `null` for any other scan. */
    budgetCause:
      row.status === 'skipped' && row.statusReason === 'budget'
        ? (BUDGET_CAUSES.find((cause) => cause === row.errorClass) ?? null)
        : null,
    refusalCategory: row.refusalCategory,
    trigger: row.trigger,
    deploymentId: row.deploymentId,
    baseDeploymentId: row.baseDeploymentId,
    tier: row.tier,
    coverage: row.coverage,
    coverageLabel: securityCoverageLabel({
      tier: row.tier,
      coverage: row.coverage,
      coverageNotes: row.coverageNotes,
      filesScanned: row.filesScanned,
      backlogFiles: row.backlogFiles,
    }),
    backlogFiles: row.backlogFiles,
    filesScanned: row.filesScanned,
    model: row.modelUsed,
    engine: row.engine,
    /** Live spend of the scan, only for the `full` level. */
    meteredUsd: level === 'full' ? row.meteredNanoUsd / NANO_USD_PER_USD : null,
    queuedAt: securityIso(row.queuedAt),
    startedAt: securityIso(row.startedAt),
    finishedAt: securityIso(row.finishedAt),
    createdAt: securityIso(row.createdAt) ?? row.createdAt,
  };
}

export type SecurityCursor = Readonly<{ at: string; id: string }>;

export function encodeSecurityCursor(cursor: SecurityCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** `null` for a cursor this server did not issue. */
export function decodeSecurityCursor(value: string): SecurityCursor | null {
  try {
    const parsed: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (
      isRecord(parsed) &&
      typeof parsed.at === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.at))
    ) {
      return { at: parsed.at, id: parsed.id };
    }
  } catch {
    // Not ours.
  }
  return null;
}

export const SECURITY_PAGE_LIMIT_MAX = 100;
export const SECURITY_PAGE_LIMIT_DEFAULT = 25;

/** `limit` query value: 1..100, default 25; `null` for anything else. */
export function parseSecurityPageLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return SECURITY_PAGE_LIMIT_DEFAULT;
  }
  if (!/^\d{1,4}$/.test(value)) {
    return null;
  }
  const limit = Number(value);
  return limit >= 1 && limit <= SECURITY_PAGE_LIMIT_MAX ? limit : null;
}

export async function listSecurityScans(
  db: Db,
  projectId: string,
  level: SecurityDetailLevel,
  page: Readonly<{ limit: number; cursor: SecurityCursor | null }>,
): Promise<Readonly<{ scans: ReadonlyArray<SecurityScanView>; nextCursor: string | null }>> {
  const rows = await scanRows(
    db,
    and(
      eq(securityScans.project_id, projectId),
      page.cursor
        ? sql`(${securityScans.created_at}, ${securityScans.id}) < (${page.cursor.at}::timestamptz, ${page.cursor.id})`
        : undefined,
    ),
  ).limit(page.limit + 1);
  const more = rows.length > page.limit;
  const shown = more ? rows.slice(0, page.limit) : rows;
  const last = shown.at(-1);
  return {
    scans: shown.map((row) => securityScanView(row, level)),
    nextCursor:
      more && last
        ? encodeSecurityCursor({ at: securityIso(last.createdAt) ?? last.createdAt, id: last.id })
        : null,
  };
}

export type SecurityDuplicateHint = Readonly<{
  id: string;
  resolution: string | null;
  resolvedAt: string | null;
}>;

/** Hints for `possible_duplicate_of`, keyed by finding id. */
export async function securityDuplicateHints(
  db: DbOrTx,
  projectId: string,
  ids: ReadonlyArray<string>,
): Promise<Map<string, SecurityDuplicateHint>> {
  const out = new Map<string, SecurityDuplicateHint>();
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) {
    return out;
  }
  const rows = await db
    .select({
      key: securityFindings.id,
      number: securityFindings.number,
      resolution: securityFindings.resolution,
      resolvedAt: securityFindings.resolved_at,
    })
    .from(securityFindings)
    .where(and(eq(securityFindings.project_id, projectId), inArray(securityFindings.id, wanted)));
  for (const row of rows) {
    out.set(row.key, {
      id: securityFindingLabel(row.number),
      resolution: row.resolution,
      resolvedAt: securityIso(row.resolvedAt),
    });
  }
  return out;
}

/** `open`: open and confirmed, by severity; `leads`: open `needs_validation`. */
async function securityCounts(db: DbOrTx, projectId: string) {
  const rows = await db
    .select({
      state: securityFindings.state,
      verdict: securityFindings.verdict,
      severity: effectiveSeverity,
      total: count(),
    })
    .from(securityFindings)
    .where(eq(securityFindings.project_id, projectId))
    .groupBy(securityFindings.state, securityFindings.verdict, effectiveSeverity);
  const open: Record<SecuritySeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  let leads = 0;
  let resolved = 0;
  for (const row of rows) {
    if (row.state === 'resolved') {
      resolved += row.total;
    } else if (row.verdict === 'needs_validation') {
      leads += row.total;
    } else if (row.severity) {
      open[row.severity] += row.total;
    }
  }
  return { open, leads, resolved, urgent: open.critical + open.high };
}

/** `GET /projects/:id/security` (spec §13.5). */
export async function projectSecurityStatus(
  input: Readonly<{
    db: Db;
    project: Readonly<{ id: string; slug: string }>;
    viewer: SecurityViewer;
    capability: boolean;
    now?: number;
  }>,
) {
  const { db, project, viewer } = input;
  const now = input.now ?? Date.now();
  const level = securityDetailLevel(viewer);
  const policy = await readSecurityPolicyLenient(db);
  const settings = await readSecurityProjectSettings(db, project.id);
  const [policyView, counts, urgentRows, urgentTotals, lastScan, lastSuccess] = await Promise.all([
    securityProjectPolicyView(db, {
      projectId: project.id,
      slug: project.slug,
      capability: input.capability,
      policy,
    }),
    securityCounts(db, project.id),
    db
      .select({
        id: securityFindings.id,
        number: securityFindings.number,
        severity: effectiveSeverity,
        title: securityFindings.title,
        file: securityFindings.file,
        line: securityFindings.line_start,
        deploymentId: securityFindings.first_deployment_id,
        createdAt: securityFindings.created_at,
        notSeen: securityFindings.not_seen_in_latest,
        duplicate: securityFindings.possible_duplicate_of,
      })
      .from(securityFindings)
      .where(and(eq(securityFindings.project_id, project.id), securityUrgentSql))
      .orderBy(
        sql`CASE COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) WHEN 'critical' THEN 0 ELSE 1 END`,
        asc(securityFindings.created_at),
        asc(securityFindings.number),
      )
      .limit(MAX_URGENT_ROWS),
    db
      .select({ oldest: sql<string | null>`min(${securityFindings.created_at})` })
      .from(securityFindings)
      .where(and(eq(securityFindings.project_id, project.id), securityUrgentSql)),
    // The last scan of what the project serves: a local check (M32) is a separate result.
    scanRows(db, and(eq(securityScans.project_id, project.id), notLocal)).limit(1),
    db
      .select(scanColumns)
      .from(securityScans)
      .where(
        and(
          eq(securityScans.project_id, project.id),
          eq(securityScans.status, 'succeeded'),
          notLocal,
        ),
      )
      .orderBy(desc(securityScans.finished_at), desc(securityScans.id))
      .limit(1),
  ]);
  const duplicates =
    level === 'full'
      ? await securityDuplicateHints(
          db,
          project.id,
          urgentRows.flatMap((row) => (row.duplicate ? [row.duplicate] : [])),
        )
      : new Map<string, SecurityDuplicateHint>();
  const findings = urgentRows.map((row) =>
    level === 'full'
      ? {
          id: securityFindingLabel(row.number),
          severity: row.severity,
          title: row.title,
          file: row.file,
          line: row.line,
          deploymentId: row.deploymentId,
          firstSeenAt: securityIso(row.createdAt) ?? row.createdAt,
          notSeenInLatest: row.notSeen,
          possibleDuplicateOf: row.duplicate ? (duplicates.get(row.duplicate) ?? null) : null,
        }
      : { id: securityFindingLabel(row.number), severity: row.severity },
  );
  const lastSuccessfulScan = lastSuccess[0] ?? null;
  // The deploy notice warns about the scan before this deploy's own (spec §6.5): the
  // newest one of another deployment that was not replaced by a newer deploy.
  const lastDeploymentId = lastScan[0]?.deploymentId ?? null;
  const [previous] = lastDeploymentId
    ? await scanRows(
        db,
        and(
          eq(securityScans.project_id, project.id),
          notLocal,
          ne(securityScans.status, 'superseded'),
          ne(securityScans.deployment_id, lastDeploymentId),
        ),
      ).limit(1)
    : [];
  let deploysSinceLastSuccess: number | null = null;
  if (lastSuccessfulScan?.deploymentId) {
    const [base] = await db
      .select({ createdAt: deployments.created_at })
      .from(deployments)
      .where(
        and(
          eq(deployments.project_id, project.id),
          eq(deployments.id, lastSuccessfulScan.deploymentId),
        ),
      );
    if (base) {
      const [since] = await db
        .select({ total: count() })
        .from(deployments)
        .where(
          and(
            eq(deployments.project_id, project.id),
            eq(deployments.status, 'live'),
            sql`${deployments.created_at} > ${base.createdAt}`,
          ),
        );
      deploysSinceLastSuccess = since?.total ?? 0;
    }
  }
  const model = securityProjectModelView(policy, settings);
  return {
    policy: policyView,
    urgent: {
      count: counts.urgent,
      counts: { critical: counts.open.critical, high: counts.open.high },
      oldestFirstSeenAt: securityIso(urgentTotals[0]?.oldest ?? null),
      findings,
      more: Math.max(0, counts.urgent - findings.length),
      detail: level,
    },
    model,
    budget:
      level === 'full'
        ? await securityProjectBudgetView(db, project.id, policy, settings.caps, now, model.id)
        : null,
    lastScan: lastScan[0] ? securityScanView(lastScan[0], level) : null,
    previousScan: previous ? securityScanView(previous, level) : null,
    lastSuccessfulScan: lastSuccessfulScan ? securityScanView(lastSuccessfulScan, level) : null,
    deploysSinceLastSuccess,
    backlogFiles: lastSuccessfulScan?.backlogFiles ?? 0,
    counts,
    // The request itself (state, blockers, copy) comes with the public gate (M16).
    publicRequest: null,
  };
}
