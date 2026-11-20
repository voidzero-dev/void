/**
 * What the project API shows about security audits (spec §13.5), and who sees what
 * (spec §3). The role filter lives here, in one place, so every route applies it.
 *
 *   full   (user session, `deploy` and up): titles, files, lines, dollars
 *   counts (readers, CI tokens, GitHub Actions OIDC): F-ids and severities of open
 *          findings, counts, no titles, files, lines or dollars
 */
import {
  isThirdPartySecurityModel,
  SECURITY_PROVIDER_NOTICE_VERSION,
  type SecurityModelId,
} from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
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
  securitySpendMonth,
  type SecurityCeilingSource,
  type SecurityProjectCapSettings,
} from './budget.ts';
import { securityCoverageLabel } from './input/tier.ts';
import { resolveSecurityScanModel } from './models.ts';
import { readSecurityPlanCap } from './plan-caps.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import {
  projectSecuritySettings,
  securityFindings,
  securityProjectSpend,
  securityPublicRequests,
  securityScans,
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  type SecurityScanStatus,
  type SecurityScanTier,
  type SecuritySeverity,
} from './schema.ts';

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

const urgentCondition = sql`${securityFindings.verdict} = 'confirmed' AND ${securityFindings.state} = 'open' AND COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) IN ('critical', 'high')`;

const MAX_URGENT_ROWS = 5;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type SecurityProjectPolicyView = Readonly<{
  mode: SecurityPolicy['mode'];
  applies: boolean;
  reason: string;
  publicGate: boolean;
}>;

/**
 * Whether scans apply to this project now, and why (spec §11.4 policy reason copy).
 * A project counts as protected only when every part says so; anything else is public.
 */
export async function securityProjectPolicyView(
  db: DbOrTx,
  input: Readonly<{ projectId: string; slug: string; capability: boolean; policy: SecurityPolicy }>,
): Promise<SecurityProjectPolicyView> {
  const { policy } = input;
  const view = (applies: boolean, reason: string): SecurityProjectPolicyView => ({
    mode: policy.mode,
    applies,
    reason,
    publicGate: input.capability && policy.publicGate,
  });
  if (!input.capability || policy.mode === 'disabled') {
    return { ...view(false, 'Security audits are off on this platform.'), mode: 'disabled' };
  }
  if (input.slug.startsWith('preview-')) {
    return view(false, 'preview projects are not scanned');
  }
  if (policy.mode === 'all') {
    return view(true, 'the platform scans all projects');
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
  const [open] = await db
    .select({ id: securityPublicRequests.id })
    .from(securityPublicRequests)
    .where(
      and(
        eq(securityPublicRequests.project_id, input.projectId),
        inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
      ),
    )
    .limit(1);
  if (open) {
    return view(true, 'scanned before it goes public (public request)');
  }
  return view(
    false,
    'this project is protected by Zero Trust and the platform scans public projects only',
  );
}

// ---------------------------------------------------------------------------
// Settings, model, budget
// ---------------------------------------------------------------------------

export type SecurityProjectSettingsRow = Readonly<{
  model: string | null;
  noticeVersion: number | null;
  caps: SecurityProjectCapSettings;
}>;

export async function readSecurityProjectSettings(
  db: DbOrTx,
  projectId: string,
): Promise<SecurityProjectSettingsRow> {
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

export type SecurityProjectModelView = Readonly<{
  /** The model the next scan runs on; `null` when every model is blocked. */
  id: SecurityModelId | null;
  /** What the project asked for: its own pick, else the installation default. */
  requested: string;
  source: 'project' | 'default' | 'fallback' | null;
  thirdParty: boolean;
  /** This project accepted the current provider notice. */
  noticeAccepted: boolean;
  /** A third-party installation default that waits for this project to accept the notice. */
  pendingDefault: SecurityModelId | null;
}>;

export function securityProjectModelView(
  policy: SecurityPolicy,
  settings: Pick<SecurityProjectSettingsRow, 'model' | 'noticeVersion'>,
): SecurityProjectModelView {
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
  return {
    id: used,
    requested: settings.model ?? policy.defaultModel,
    source:
      used === null
        ? null
        : settings.model !== null && used === settings.model
          ? 'project'
          : used === policy.defaultModel
            ? 'default'
            : 'fallback',
    thirdParty: used !== null && isThirdPartySecurityModel(used),
    noticeAccepted,
    pendingDefault: pending,
  };
}

export type SecurityProjectBudgetView = Readonly<{
  /** The cap that applies now (the lower of the limit and the project's own); `null` = none. */
  capUsd: number | null;
  /** `own` = the project's cap decides, `limit` = the platform's per-project limit, `none`. */
  capSource: 'own' | 'limit' | 'none';
  /** The most a project admin may set; `null` = any amount. */
  ceilingUsd: number | null;
  /**
   * Where `ceilingUsd` comes from: this project's limit, its plan's cap (M27) or the
   * default for every project; `null` with no ceiling.
   */
  ceilingSource: SecurityCeilingSource | null;
  spentUsd: number;
  month: string;
  resetsAt: string;
}>;

export async function securityProjectBudgetView(
  db: DbOrTx,
  projectId: string,
  policy: SecurityPolicy,
  caps: SecurityProjectCapSettings,
  now = Date.now(),
): Promise<SecurityProjectBudgetView> {
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
  return {
    capUsd: effective === null ? null : effective / 100,
    capSource:
      effective === null
        ? 'none'
        : own !== null && (ceiling === null || own <= ceiling)
          ? 'own'
          : 'limit',
    ceilingUsd: ceiling === null ? null : ceiling / 100,
    ceilingSource: limit?.source ?? null,
    spentUsd: (spend?.spent ?? 0) / NANO_USD_PER_USD,
    month,
    resetsAt: `${securityNextSpendMonth(month)}T00:00:00.000Z`,
  };
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export const scanColumns = {
  id: securityScans.id,
  status: securityScans.status,
  statusReason: securityScans.status_reason,
  failureCause: securityScans.failure_cause,
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

type ScanRow = Readonly<{
  id: string;
  status: SecurityScanStatus;
  statusReason: string | null;
  failureCause: 'installation' | 'project' | null;
  refusalCategory: string | null;
  trigger: string;
  deploymentId: string | null;
  baseDeploymentId: string | null;
  tier: SecurityScanTier | null;
  coverage: 'complete' | 'partial' | null;
  coverageNotes: Array<string>;
  backlogFiles: number;
  filesScanned: number;
  modelUsed: string | null;
  engine: string | null;
  meteredNanoUsd: number;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}>;

export type SecurityScanView = Readonly<{
  id: string;
  status: string;
  statusReason: string | null;
  failureCause: string | null;
  refusalCategory: string | null;
  trigger: string;
  deploymentId: string | null;
  baseDeploymentId: string | null;
  tier: string | null;
  coverage: string | null;
  coverageLabel: string | null;
  backlogFiles: number;
  filesScanned: number;
  model: string | null;
  engine: string | null;
  /** Live spend of the scan, only for the `full` level. */
  meteredUsd: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}>;

export function securityScanView(row: ScanRow, level: SecurityDetailLevel): SecurityScanView {
  return {
    id: row.id,
    status: row.status,
    statusReason: row.statusReason,
    failureCause: row.failureCause,
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
    meteredUsd: level === 'full' ? row.meteredNanoUsd / NANO_USD_PER_USD : null,
    queuedAt: securityIso(row.queuedAt),
    startedAt: securityIso(row.startedAt),
    finishedAt: securityIso(row.finishedAt),
    createdAt: securityIso(row.createdAt) ?? row.createdAt,
  };
}

export type SecurityCursor = Readonly<{ at: string; id: string }>;

export function encodeSecurityCursor(cursor: SecurityCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `null` for a cursor this server did not issue. */
export function decodeSecurityCursor(value: string): SecurityCursor | null {
  try {
    const parsed: unknown = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as SecurityCursor).at === 'string' &&
      typeof (parsed as SecurityCursor).id === 'string' &&
      !Number.isNaN(Date.parse((parsed as SecurityCursor).at))
    ) {
      return { at: (parsed as SecurityCursor).at, id: (parsed as SecurityCursor).id };
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
  const rows = await db
    .select(scanColumns)
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        page.cursor
          ? sql`(${securityScans.created_at}, ${securityScans.id}) < (${page.cursor.at}::timestamptz, ${page.cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(securityScans.created_at), desc(securityScans.id))
    .limit(page.limit + 1);
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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SecurityUrgentRow = Readonly<{
  id: string;
  severity: SecuritySeverity | null;
  title?: string;
  file?: string | null;
  line?: number | null;
  deploymentId?: string | null;
  firstSeenAt?: string;
  notSeenInLatest?: boolean;
  possibleDuplicateOf?: SecurityDuplicateHint | null;
}>;

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

export type SecurityCounts = Readonly<{
  /** Open and confirmed, by severity. */
  open: Readonly<Record<SecuritySeverity, number>>;
  /** Open leads (`needs_validation`). */
  leads: number;
  resolved: number;
  urgent: number;
}>;

async function securityCounts(db: DbOrTx, projectId: string): Promise<SecurityCounts> {
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

export type SecurityStatusInput = Readonly<{
  db: Db;
  project: Readonly<{ id: string; slug: string }>;
  viewer: SecurityViewer;
  capability: boolean;
  now?: number;
}>;

/** `GET /projects/:id/security` (spec §13.5). */
export async function projectSecurityStatus(input: SecurityStatusInput) {
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
      .where(and(eq(securityFindings.project_id, project.id), urgentCondition))
      .orderBy(
        sql`CASE COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) WHEN 'critical' THEN 0 ELSE 1 END`,
        asc(securityFindings.created_at),
        asc(securityFindings.number),
      )
      .limit(MAX_URGENT_ROWS),
    db
      .select({ oldest: sql<string | null>`min(${securityFindings.created_at})` })
      .from(securityFindings)
      .where(and(eq(securityFindings.project_id, project.id), urgentCondition)),
    // The last scan of what the project serves: a local check (M32) is a separate result.
    db
      .select(scanColumns)
      .from(securityScans)
      .where(and(eq(securityScans.project_id, project.id), ne(securityScans.trigger, 'local')))
      .orderBy(desc(securityScans.created_at), desc(securityScans.id))
      .limit(1),
    db
      .select(scanColumns)
      .from(securityScans)
      .where(
        and(
          eq(securityScans.project_id, project.id),
          eq(securityScans.status, 'succeeded'),
          ne(securityScans.trigger, 'local'),
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
  const findings: ReadonlyArray<SecurityUrgentRow> = urgentRows.map((row) =>
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
    model: securityProjectModelView(policy, settings),
    budget:
      level === 'full'
        ? await securityProjectBudgetView(db, project.id, policy, settings.caps, now)
        : null,
    lastScan: lastScan[0] ? securityScanView(lastScan[0], level) : null,
    lastSuccessfulScan: lastSuccessfulScan ? securityScanView(lastSuccessfulScan, level) : null,
    deploysSinceLastSuccess,
    backlogFiles: lastSuccessfulScan?.backlogFiles ?? 0,
    counts,
    // The request itself (state, blockers, copy) comes with the public gate (M16).
    publicRequest: null,
  };
}
