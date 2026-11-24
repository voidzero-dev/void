/**
 * What the admin panel shows for security audits (spec §13.1, design doc 0095 M18).
 * Every function reads through the same operations the operator API and the CLI use, so
 * the panel never has its own rule. Writes live in `routes/security.ts`.
 */
import {
  getSecurityModel,
  securityProviderNotice,
  securityModelThirdPartyHost,
  SECURITY_PROVIDER_NOTICE_VERSION,
} from '@void/platform/security-models';
import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { projects } from '../schema.ts';
import {
  formatSecurityUsd,
  NANO_USD_PER_USD,
  securityBudgetResetLabel,
  securityScanReserveNano,
  SECURITY_BUDGET_THRESHOLDS,
} from '../security/budget.ts';
import {
  listOperatorBypasses,
  listOperatorPublicRequests,
  listOperatorSecurityFindings,
  listOperatorSecurityScans,
  parseOperatorFindingFilter,
  parseOperatorRequestFilter,
  parseOperatorScanFilter,
  securityBudgetStatus,
} from '../security/operator.ts';
import {
  readSecurityPolicyLenient,
  readSecurityZeroTrustFact,
  readStoredSecurityPolicy,
  securityPolicyView,
  securityStatus,
} from '../security/policy.ts';
import {
  readSecurityHighRefusalModels,
  SECURITY_HIGH_REFUSAL_BADGE,
  securityPickerBadges,
} from '../security/project-settings.ts';
import { projectSecurityStatus, listSecurityScans } from '../security/project-view.ts';
import { publicRequestCopy } from '../security/public-gate-copy.ts';
import { openPublicRequestView, openUrgentFindingLabels } from '../security/public-gate.ts';
import {
  securityFindings,
  securityPlatformSpend,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
  SECURITY_BYPASSABLE_REQUEST_STATES,
} from '../security/schema.ts';
import { readZeroTrustConfigurationStrict } from '../zero-trust/configuration.ts';

type AdminContext = Context<ApiEnv>;

export const SECURITY_HOME = '/admin/security';

interface SecuritySectionsByPath {
  readonly [path: string]: SecuritySection;
}

const SECTION_BY_PATH: SecuritySectionsByPath = {
  [SECURITY_HOME]: 'settings',
  [`${SECURITY_HOME}/findings`]: 'findings',
  [`${SECURITY_HOME}/scans`]: 'scans',
  [`${SECURITY_HOME}/requests`]: 'requests',
};

export type SecuritySection = 'settings' | 'findings' | 'scans' | 'requests';

const PAGE_SIZE = 20;
/** A request held this long is listed as stale (spec §11.4). */
const STALE_REQUEST_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function capabilityOn(context: Pick<AdminContext, 'env'>): boolean {
  try {
    return getPlatformCapabilities(context.env).securityAudits;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Unseen bypasses (per installation admin)
// ---------------------------------------------------------------------------

function seenKey(userId: string): string {
  return `security.bypasses-seen.${userId}`;
}

async function readSeenAt(db: Db, userId: string): Promise<string | null> {
  const value = await getPlatformSetting(db, seenKey(userId));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const at = (value as Record<string, unknown>).at;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) {
      return at;
    }
  }
  return null;
}

/**
 * Marks the bypasses the admin was shown as seen. `through` is the newest bypass time the
 * page listed (the page's own value, not the clock here), so a bypass made after the page
 * loaded stays new. It is clamped to the newest real row, and the stored mark is the first
 * millisecond after that row, so the compare in `countUnseenBypasses` never depends on the
 * microseconds the database keeps.
 */
export async function markBypassesSeen(db: Db, userId: string, through: string): Promise<void> {
  const time = Date.parse(through);
  if (Number.isNaN(time)) {
    throw new OperatorError(
      400,
      'through must be a time from the bypass list.',
      'invalid_argument',
    );
  }
  const [row] = await db
    .select({ createdAt: securityScanBypasses.created_at })
    .from(securityScanBypasses)
    .where(lt(securityScanBypasses.created_at, new Date(time + 1).toISOString()))
    .orderBy(desc(securityScanBypasses.created_at))
    .limit(1);
  if (!row) {
    return;
  }
  const at = new Date(Date.parse(row.createdAt) + 1).toISOString();
  const current = await readSeenAt(db, userId);
  if (current !== null && Date.parse(current) >= Date.parse(at)) {
    return;
  }
  await setPlatformSetting(db, seenKey(userId), { at });
}

async function countUnseenBypasses(db: Db, seenAt: string | null): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(securityScanBypasses)
    .where(seenAt === null ? undefined : gte(securityScanBypasses.created_at, seenAt));
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Banners and the nav badge (every admin page)
// ---------------------------------------------------------------------------

export type SecurityBanner = Readonly<{ status: 'warning' | 'error'; text: string; href: string }>;
export type SecurityChrome = Readonly<{
  banners: ReadonlyArray<SecurityBanner>;
  unseenBypasses: number;
}>;

interface ProbeFailureCopy {
  readonly [check: string]: string;
}

const PROBE_FAILURE_COPY: ProbeFailureCopy = {
  container:
    'Scans run in a Cloudflare Container. They need Workers Paid, and the runtime token needs Account → Containers → Edit and Account → Cloudchamber → Edit.',
  egress:
    'The scanner network lock failed. The scanner could reach the internet, so scans stay off to keep code private.',
  workers_ai: 'A Workers AI model could not run. It needs Workers Paid or prepaid AI credits.',
};

function utcLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month} ${date.getUTCDate()}, ${hh}:${mm} UTC`;
}

/**
 * The banner and badge shown on every admin page. Nothing is read while the capability
 * is off, and a failure here never breaks a page.
 */
export async function loadSecurityChrome(
  context: Pick<AdminContext, 'env' | 'get'>,
): Promise<SecurityChrome | null> {
  if (!capabilityOn(context)) {
    return null;
  }
  try {
    const db = context.get('db');
    const user = context.get('user');
    const now = Date.now();
    const policy = await readSecurityPolicyLenient(db);
    const banners: Array<SecurityBanner> = [];
    if (policy.mode !== 'disabled' && policy.entitlement && !policy.entitlement.ok) {
      const cause =
        PROBE_FAILURE_COPY[policy.entitlement.missing[0] ?? ''] ?? 'A required check failed.';
      const since = policy.entitlement.failingSince ?? policy.entitlement.checkedAt;
      let text = `Security probe failing since ${utcLabel(since)}: ${cause} New deploys are not being scanned.`;
      if (policy.publicGate) {
        const [open] = await db
          .select({ total: count() })
          .from(securityPublicRequests)
          .where(
            sql`${securityPublicRequests.state} IN ('waiting_scan','held_findings','held_no_result','needs_deploy')`,
          );
        const held = open?.total ?? 0;
        text += ` Projects waiting to go public stay protected (${held} public ${held === 1 ? 'request' : 'requests'} held). Those with no urgent finding open can be bypassed with a reason.`;
      }
      banners.push({ status: 'error', text, href: SECURITY_HOME });
    }
    if (policy.mode !== 'disabled' && policy.budgets.platformCapOn) {
      const month = `${new Date(now).toISOString().slice(0, 7)}-01`;
      const [spend] = await db
        .select({ spent: securityPlatformSpend.spent_nano_usd })
        .from(securityPlatformSpend)
        .where(eq(securityPlatformSpend.month, month))
        .limit(1);
      const spent = spend?.spent ?? 0;
      const capNano = policy.budgets.platformMonthlyUsd * NANO_USD_PER_USD;
      const [warn, stop] = SECURITY_BUDGET_THRESHOLDS;
      // Holds keep spend at or under the cap, so "used up" is: the next scan on the
      // default model no longer fits (the scheduler then skips it, `skipped:budget`).
      const nextScan = securityScanReserveNano(policy.defaultModel, policy.limits) ?? 0;
      if (capNano > 0 && (spent >= capNano || spent + nextScan > capNano)) {
        banners.push({
          status: 'error',
          text: `Security scans stopped: platform monthly budget used up (${formatSecurityUsd(capNano)}). Raise it: Security → Settings, or void platform security budget --platform-usd ${Math.ceil(policy.budgets.platformMonthlyUsd * 1.5)}`,
          href: SECURITY_HOME,
        });
      } else if (capNano > 0 && (spent / capNano) * 100 >= warn && warn < stop) {
        banners.push({
          status: 'warning',
          text: `Security scans: ${warn}% of the platform's monthly budget used (${formatSecurityUsd(spent)} of ${formatSecurityUsd(capNano)}). Resets ${securityBudgetResetLabel(now)}.`,
          href: SECURITY_HOME,
        });
      }
    }
    const seenAt = await readSeenAt(db, user.id);
    return { banners, unseenBypasses: await countUnseenBypasses(db, seenAt) };
  } catch (error) {
    console.error('[admin-security] chrome failed', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The Security pages
// ---------------------------------------------------------------------------

function paging(url: URL) {
  const raw = url.searchParams.get('page');
  const parsed = raw === null ? 1 : Number(raw);
  // The number must print back as the same text, which rules out "1e3", " 2" and "0x10".
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > 1_000_000 ||
    String(parsed) !== (raw ?? '1')
  ) {
    throw new OperatorError(400, 'page must be a positive whole number.', 'invalid_argument');
  }
  return { page: parsed, limit: PAGE_SIZE, offset: (parsed - 1) * PAGE_SIZE };
}

type SecurityLocation = { url: URL; section: SecuritySection };

function securityLocation(path: string): SecurityLocation {
  const url = new URL(path, 'https://admin.invalid');
  const section = SECTION_BY_PATH[url.pathname];
  if (!path.startsWith('/admin/') || url.origin !== 'https://admin.invalid' || !section) {
    throw new OperatorError(400, 'Invalid admin page request.');
  }
  return { url, section };
}

/** Projects with three project-cause scans in a row that did not succeed (spec §11.4). */
async function silentGapProjects(db: Db) {
  const result = await db.execute(sql`
    SELECT p.id, p.slug FROM (
      SELECT project_id,
             count(*) AS total,
             bool_and(status IN ('failed', 'refused', 'timed_out', 'incomplete') AND failure_cause = 'project') AS all_bad
      FROM (
        SELECT project_id, status, failure_cause,
               row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rn
        FROM ${securityScans}
        WHERE status NOT IN ('pending_input', 'queued', 'running', 'superseded', 'canceled', 'skipped')
      ) recent
      WHERE rn <= 3
      GROUP BY project_id
    ) streak
    JOIN ${projects} p ON p.id = streak.project_id
    WHERE streak.total = 3 AND streak.all_bad
    ORDER BY p.slug
    LIMIT 20`);
  return (result.rows as Array<{ id: string; slug: string }>).map((row) => ({
    projectId: row.id,
    slug: row.slug,
  }));
}

/** Days of Zero Trust protection changes the churn flag looks at. */
export const SECURITY_PROTECTION_CHURN_DAYS = 7;

/**
 * Projects with 2+ protection changes in 7 days and an urgent finding open (spec §11.4,
 * edge #39): a protect → deploy → unprotect with the gate off skips the scan.
 */
async function protectionChurnProjects(db: Db, now: number) {
  const since = new Date(now - SECURITY_PROTECTION_CHURN_DAYS * DAY_MS).toISOString();
  const result = await db.execute(sql`
    SELECT p.id, p.slug, count(*)::int AS changes
    FROM ${securityProjectEvents} e
    JOIN ${projects} p ON p.id = e.project_id
    WHERE e.action IN ('protection_on', 'protection_off')
      AND e.created_at >= ${since}::timestamptz
      AND EXISTS (
        SELECT 1 FROM ${securityFindings} f
        WHERE f.project_id = e.project_id
          AND f.state = 'open'
          AND f.verdict = 'confirmed'
          AND COALESCE(f.severity_override, f.severity) IN ('critical', 'high')
      )
    GROUP BY p.id, p.slug
    HAVING count(*) >= 2
    ORDER BY p.slug
    LIMIT 20`);
  return (result.rows as Array<{ id: string; slug: string; changes: number }>).map((row) => ({
    projectId: row.id,
    slug: row.slug,
    changes: Number(row.changes),
  }));
}

export async function loadSecurityAdminPage(context: AdminContext, path: string) {
  const { url, section } = securityLocation(path);
  const db = context.get('db');
  const user = context.get('user');
  const capability = capabilityOn(context);
  const query = (name: string) => url.searchParams.get(name) ?? undefined;
  const now = Date.now();
  const seenAt = await readSeenAt(db, user.id);
  const [stored, urgent, unseen] = await Promise.all([
    readStoredSecurityPolicy(db),
    listOperatorSecurityFindings(
      db,
      { state: 'open', urgent: true, severity: null },
      { page: 1, limit: 1, offset: 0 },
    ),
    countUnseenBypasses(db, seenAt),
  ]);
  const base = {
    id: path,
    section,
    capability,
    emailEnabled: Boolean(context.env.EMAIL),
    urgentTotal: urgent.total,
    unseenBypasses: unseen,
    seenAt,
    revision: stored.policy.revision,
    tz: context.req.raw.cf?.timezone as string | undefined,
    page: 1,
    totalPages: 1,
    settings: null as null | Awaited<ReturnType<typeof loadSettings>>,
    findings: null as null | Awaited<ReturnType<typeof listOperatorSecurityFindings>>,
    findingFilter: null as null | { state: string; urgent: boolean; severity: string | null },
    scans: null as null | Awaited<ReturnType<typeof loadScans>>,
    requests: null as null | Awaited<ReturnType<typeof loadRequests>>,
  };
  if (section === 'settings') {
    return { ...base, settings: await loadSettings(context, stored, now) };
  }
  if (section === 'findings') {
    const filter = parseOperatorFindingFilter(query);
    const page = paging(url);
    const findings = await listOperatorSecurityFindings(db, filter, page);
    return {
      ...base,
      findings,
      findingFilter: { state: filter.state, urgent: filter.urgent, severity: filter.severity },
      page: findings.page,
      totalPages: findings.totalPages,
    };
  }
  if (section === 'scans') {
    const scans = await loadScans(db, url, query, now);
    return { ...base, scans, page: scans.page, totalPages: scans.totalPages };
  }
  const requests = await loadRequests(db, url, query, seenAt, now);
  return { ...base, requests, page: requests.page, totalPages: requests.totalPages };
}

/** Days of model findings the low-confirmation warning looks at. */
export const SECURITY_LOW_CONFIRMATION_DAYS = 30;

/**
 * The Settings warning of PRD §8.1 (D44): static-only scans rarely confirm, so it shows
 * while fewer than half of the model's findings of the last 30 days are confirmed, and
 * while there are none yet. Server findings (secrets) are always confirmed; they do not
 * count.
 */
async function fewFindingsConfirmed(db: Db, now: number): Promise<boolean> {
  const since = new Date(now - SECURITY_LOW_CONFIRMATION_DAYS * DAY_MS).toISOString();
  const [row] = await db
    .select({
      total: count(),
      confirmed: sql<number>`count(*) FILTER (WHERE ${securityFindings.verdict} = 'confirmed')::int`,
    })
    .from(securityFindings)
    .where(and(eq(securityFindings.source, 'scanner'), gte(securityFindings.created_at, since)));
  const total = row?.total ?? 0;
  return total === 0 || (row?.confirmed ?? 0) * 2 < total;
}

async function loadSettings(
  context: AdminContext,
  stored: Awaited<ReturnType<typeof readStoredSecurityPolicy>>,
  now: number,
) {
  const db = context.get('db');
  const capability = capabilityOn(context);
  const [status, budget, zeroTrustFact, zeroTrust, lowConfirmation, highRefusal] =
    await Promise.all([
      securityStatus(db, capability, now),
      securityBudgetStatus(db, now),
      readSecurityZeroTrustFact(db),
      readZeroTrustConfigurationStrict(db).catch(() => null),
      fewFindingsConfirmed(db, now),
      readSecurityHighRefusalModels(db, now),
    ]);
  const view = securityPolicyView(stored, capability, now);
  return {
    unreadable: stored.unreadable,
    mode: stored.policy.mode,
    publicGate: stored.policy.publicGate,
    defaultModel: stored.policy.defaultModel,
    limits: {
      concurrency: stored.policy.limits.concurrency,
      timeoutMinutes: stored.policy.limits.timeoutMinutes,
    },
    budgets: stored.policy.budgets,
    entitlement: stored.policy.entitlement
      ? {
          checkedAt: stored.policy.entitlement.checkedAt,
          ok: stored.policy.entitlement.ok,
          missing: [...stored.policy.entitlement.missing],
          fresh: view.entitlementFresh,
        }
      : null,
    models: view.models.map((model) => ({
      id: model.id,
      host: model.host,
      badges: highRefusal.has(model.id)
        ? [...model.badges, SECURITY_HIGH_REFUSAL_BADGE]
        : [...model.badges],
      blocked: model.blocked,
      hostOk: model.hostOk,
      priced: model.priced,
      pickable: model.pickable,
      default: model.default,
    })),
    providerNotice: {
      version: SECURITY_PROVIDER_NOTICE_VERSION,
      accepted: view.providerNotice.accepted,
    },
    zeroTrustFact,
    newProjectsStartPublic: zeroTrust?.protectNewProjects === false,
    spentUsd: status.month.spentUsd,
    platformSpent: budget.platform.spentUsd,
    resetsAt: budget.resetsAt,
    lastDayFailureRate: status.last24h.failureRate,
    lowConfirmation,
  };
}

async function loadScans(
  db: Db,
  url: URL,
  query: (name: string) => string | undefined,
  now: number,
) {
  const filter = parseOperatorScanFilter(query);
  const [list, budget, status, gaps, churn] = await Promise.all([
    listOperatorSecurityScans(db, filter, paging(url), now),
    securityBudgetStatus(db, now),
    securityStatus(db, true, now),
    silentGapProjects(db),
    protectionChurnProjects(db, now),
  ]);
  return {
    ...list,
    topSpenders: budget.topSpenders,
    installationFailureAlert:
      status.last24h.finished > 0 && status.last24h.failureRate > 0.2
        ? { rate: status.last24h.failureRate, finished: status.last24h.finished }
        : null,
    silentGaps: gaps,
    protectionChurn: churn,
    filter: { status: filter.status, gate: filter.gate },
  };
}

async function loadRequests(
  db: Db,
  url: URL,
  query: (name: string) => string | undefined,
  seenAt: string | null,
  now: number,
) {
  const filter = parseOperatorRequestFilter(query);
  const [list, bypasses] = await Promise.all([
    listOperatorPublicRequests(db, filter, paging(url)),
    listOperatorBypasses(db, {}, { page: 1, limit: 20, offset: 0 }),
  ]);
  const cutoff = now - STALE_REQUEST_DAYS * DAY_MS;
  return {
    ...list,
    state: filter.state,
    staleIds: list.requests
      .filter(
        (request) =>
          ['waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy'].includes(
            request.state,
          ) && Date.parse(request.requestedAt ?? '') < cutoff,
      )
      .map((request) => request.id),
    bypasses: bypasses.bypasses.map((bypass) => ({
      ...bypass,
      unseen: seenAt === null || Date.parse(bypass.createdAt ?? '') >= Date.parse(seenAt),
    })),
  };
}

// ---------------------------------------------------------------------------
// Project detail
// ---------------------------------------------------------------------------

/** Whether "Scan before a project goes public" applies now (the Zero Trust page greys out on it). */
export async function loadPublicGateOn(context: AdminContext): Promise<boolean> {
  if (!capabilityOn(context)) {
    return false;
  }
  const policy = await readSecurityPolicyLenient(context.get('db'));
  return policy.mode !== 'disabled' && policy.publicGate;
}

/**
 * The public request part of the project Zero Trust section. `on` is the gate; a request
 * can be bypassed only in a state that allows it and with no urgent finding open.
 */
export async function loadProjectGate(
  context: AdminContext,
  project: Readonly<{ id: string; slug: string }>,
) {
  const off = {
    on: false,
    request: null,
    copy: null,
    bypassable: false,
    urgentIds: [] as Array<string>,
  };
  if (!capabilityOn(context)) {
    return off;
  }
  const db = context.get('db');
  const policy = await readSecurityPolicyLenient(db);
  const on = policy.mode !== 'disabled' && policy.publicGate;
  const request = await openPublicRequestView(db, project.id);
  if (!request) {
    return { ...off, on };
  }
  const urgentIds = await openUrgentFindingLabels(db, project.id);
  return {
    on,
    request: {
      ...request,
      blockers: { count: request.blockers.count, ids: [...request.blockers.ids] },
    },
    copy: publicRequestCopy({
      slug: project.slug,
      state: request.state,
      reason: request.heldReason,
      blockerIds: request.blockers.ids,
      deploymentId: request.targetDeploymentId,
    }),
    bypassable:
      urgentIds.length === 0 &&
      (SECURITY_BYPASSABLE_REQUEST_STATES as ReadonlyArray<string>).includes(request.state),
    urgentIds,
  };
}

/** The Security section of the project detail page. `null` while the capability is off. */
export async function loadProjectSecurity(
  context: AdminContext,
  project: Readonly<{ id: string; slug: string }>,
) {
  if (!capabilityOn(context)) {
    return null;
  }
  const db = context.get('db');
  const now = Date.now();
  const stored = await readStoredSecurityPolicy(db);
  const [status, scans, bypasses, highRefusal] = await Promise.all([
    projectSecurityStatus({
      db,
      project,
      // An installation admin sees what a project owner sees.
      viewer: { role: 'owner', credential: false },
      capability: true,
      now,
    }),
    listSecurityScans(db, project.id, 'full', { limit: 5, cursor: null }),
    listOperatorBypasses(db, { project: project.id }, { page: 1, limit: 5, offset: 0 }),
    readSecurityHighRefusalModels(db, now),
  ]);
  const view = securityPolicyView(stored, true, now);
  const models = view.models.map((model) => {
    const host = securityModelThirdPartyHost(model.id);
    return {
      id: model.id,
      badges: securityPickerBadges(model.id, highRefusal),
      pickable: model.pickable,
      thirdParty: host !== null,
      notice: host === null ? null : [...securityProviderNotice(host)],
      label: getSecurityModel(model.id).id,
    };
  });
  return {
    policy: status.policy,
    urgent: {
      count: status.urgent.count,
      oldestFirstSeenAt: status.urgent.oldestFirstSeenAt,
      ids: status.urgent.findings.map((finding) => finding.id),
    },
    counts: {
      urgent: status.counts.urgent,
      leads: status.counts.leads,
      resolved: status.counts.resolved,
      open: status.counts.open,
    },
    model: status.model,
    models,
    noticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
    budget: status.budget,
    backlogFiles: status.backlogFiles,
    scans: scans.scans.map((scan) => ({
      id: scan.id,
      status: scan.status,
      statusReason: scan.statusReason,
      failureCause: scan.failureCause,
      coverageLabel: scan.coverageLabel,
      model: scan.model,
      meteredUsd: scan.meteredUsd,
      createdAt: scan.createdAt,
    })),
    bypasses: bypasses.bypasses.map((bypass) => ({
      id: bypass.id,
      actorKind: bypass.actorKind,
      actorRole: bypass.actorRole,
      reason: bypass.reason,
      requestState: bypass.requestState,
      blockers: bypass.blockers,
      deploymentId: bypass.deploymentId,
      createdAt: bypass.createdAt,
    })),
  };
}
