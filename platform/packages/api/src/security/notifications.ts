/**
 * Security notifications (design doc 0095 M15, spec §12). The `security_notifications`
 * table is the outbox; the `SecurityScanScheduler` alarm drains it.
 *
 *   write side                           read side (alarm)
 *   ingest (new finding)  ─ findings ─┐  due rows ─► group findings by project
 *   human reopen          ─ reopen ───┤    │          30-min cooldown, merge scans
 *   spend crosses 80/100% ─ cap_* ────┼──► │  recipients worked out now
 *   public gate (M16)     ─ public_* ─┤    │  one email per person
 *   bypass (M16)          ─ bypass ───┘    └► sent | skipped | retry ×3 (1 min, 5 min)
 *
 * A row stores no recipient and no text: both are worked out at send time, so an owner
 * transfer, a role change or a finding resolved in between is respected (edge #25, #47,
 * #69, #70). `EMAIL` unbound skips quietly (edge #27).
 */
import { and, asc, desc, eq, inArray, lte, max, min, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import {
  sendSecurityBypassEmail,
  sendSecurityFindingsEmail,
  sendSecurityNowPublicEmail,
  sendSecurityPlatformCapEmail,
  sendSecurityProjectCapEmail,
  sendSecurityPublicCanceledEmail,
  sendSecurityPublicHeldEmail,
  sendSecurityReopenEmail,
  type PlatformEmailEnv,
} from '../email.ts';
import { generateId } from '../id.ts';
import { projectRoleForUser } from '../project-access.ts';
import { deployments, projects, projectZeroTrust, users } from '../schema.ts';
import {
  formatSecurityUsd,
  securityBudgetResetLabel,
  securityBudgetThresholds,
  securityCentsToNano,
  securityPlatformCapCents,
  securityProjectCeilingCents,
  securitySpendCaps,
  securityUsdArgument,
  type SecuritySpendCaps,
} from './budget.ts';
import { isUrgentSeverity, severityRank } from './findings.ts';
import {
  SECURITY_EMAIL_MAX_FINDINGS,
  formatSecurityDay,
  securityActorRoleLabel,
  type SecurityEmailFinding,
  type SecurityPublicHeldState,
} from './notification-copy.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import {
  resolveInstallationAdminRecipients,
  resolveProjectAdminRecipients,
  resolveProjectSecurityRecipients,
  resolvePublicRequestRecipients,
  type SecurityRecipient,
} from './recipients.ts';
import {
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityNotifications,
  securityPlatformSpend,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
  type SecurityNotificationKind,
  type SecurityPublicRequestState,
} from './schema.ts';

/** At most one findings email per project in this window; later scans merge into the next one. */
export const SECURITY_FINDINGS_COOLDOWN_MS = 30 * 60_000;
export const SECURITY_NOTIFICATION_MAX_ATTEMPTS = 3;
/** Delay before attempt 2 and attempt 3 (the `error-alert-monitor.ts` pattern). */
export const SECURITY_NOTIFICATION_BACKOFF_MS = [60_000, 5 * 60_000] as const;
/** A row this old is dropped unsent: the news is stale. */
export const SECURITY_NOTIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** The "now public" email waits this long for Zero Trust to finish going public. */
export const SECURITY_NOW_PUBLIC_WAIT_MS = 60_000;
const BATCH = 50;

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

export type SecurityNotificationInput =
  | Readonly<{ kind: 'findings'; projectId: string; scanId: string }>
  | Readonly<{ kind: 'reopen'; projectId: string; findingId: string; reopenCount: number }>
  | Readonly<{
      kind: 'cap_project';
      projectId: string;
      /** The spend month as stored, `2026-11-01`. */
      month: string;
      percent: 80 | 100;
    }>
  | Readonly<{ kind: 'cap_platform'; month: string; percent: 80 | 100 }>
  | Readonly<{
      kind: 'public_held';
      projectId: string;
      requestId: string;
      state: SecurityPublicHeldState;
      gateScanId: string | null;
    }>
  | Readonly<{ kind: 'public_now_public'; projectId: string; requestId: string }>
  | Readonly<{ kind: 'public_canceled'; projectId: string; requestId: string }>
  | Readonly<{ kind: 'scan_bypass'; projectId: string; requestId: string; bypassId: string }>;

/** The unique key of a notification; the same event queued twice is one email. */
export function securityNotificationDedupeKey(input: SecurityNotificationInput): string {
  switch (input.kind) {
    case 'findings':
      return `findings:${input.projectId}:${input.scanId}`;
    case 'reopen':
      return `reopen:${input.findingId}:${input.reopenCount}`;
    case 'cap_project':
      return `cap_project:${input.projectId}:${input.month}:${input.percent}`;
    case 'cap_platform':
      return `cap_platform:${input.month}:${input.percent}`;
    case 'public_held':
      return `public_held:${input.requestId}:${input.state}:${input.gateScanId ?? '-'}`;
    case 'public_now_public':
      return `public_now_public:${input.requestId}`;
    case 'public_canceled':
      return `public_canceled:${input.requestId}`;
    case 'scan_bypass':
      return `scan_bypass:${input.bypassId}`;
  }
}

/**
 * Queues one notification. Returns `false` when the same event is already queued (or
 * sent). Pass the transaction of the change that caused it, so the row and the change
 * commit together; poke the scheduler after the commit.
 */
export async function enqueueSecurityNotification(
  db: DbOrTx,
  input: SecurityNotificationInput,
): Promise<boolean> {
  const rows = await db
    .insert(securityNotifications)
    .values({
      id: generateId('sn'),
      kind: input.kind,
      project_id: input.kind === 'cap_platform' ? null : input.projectId,
      scan_ids: input.kind === 'findings' ? [input.scanId] : [],
      request_id: 'requestId' in input ? input.requestId : null,
      scan_bypass_id: input.kind === 'scan_bypass' ? input.bypassId : null,
      dedupe_key: securityNotificationDedupeKey(input),
    })
    .onConflictDoNothing({ target: securityNotifications.dedupe_key })
    .returning({ id: securityNotifications.id });
  return rows.length > 0;
}

/** The highest threshold a total has reached on a cap, or `null`. */
function highestThreshold(spentNano: number, capNano: number | null): 80 | 100 | null {
  const reached = securityBudgetThresholds(spentNano, capNano);
  return reached.length === 0 ? null : reached[reached.length - 1]!;
}

/**
 * After a model call settles: queue the 80% / 100% email of each cap the month's metered
 * spend has reached. Once per threshold per cap per month (the dedupe key), so calling it
 * after every call is cheap and safe. Returns whether any row was queued.
 */
export async function enqueueSecurityCapNotifications(
  db: DbOrTx,
  input: Readonly<{
    projectId: string;
    month: string;
    caps: SecuritySpendCaps;
    projectSpentNano: number;
    platformSpentNano: number;
  }>,
): Promise<boolean> {
  let queued = false;
  const project = highestThreshold(input.projectSpentNano, input.caps.projectNano);
  if (project !== null) {
    queued =
      (await enqueueSecurityNotification(db, {
        kind: 'cap_project',
        projectId: input.projectId,
        month: input.month,
        percent: project,
      })) || queued;
  }
  const platform = highestThreshold(input.platformSpentNano, input.caps.platformNano);
  if (platform !== null) {
    queued =
      (await enqueueSecurityNotification(db, {
        kind: 'cap_platform',
        month: input.month,
        percent: platform,
      })) || queued;
  }
  return queued;
}

/** A scan was skipped because a cap is used up: that cap's 100% email. */
export async function enqueueSecurityCapRefused(
  db: DbOrTx,
  input: Readonly<{ projectId: string; month: string; cap: 'project' | 'platform' }>,
): Promise<boolean> {
  return enqueueSecurityNotification(
    db,
    input.cap === 'project'
      ? { kind: 'cap_project', projectId: input.projectId, month: input.month, percent: 100 }
      : { kind: 'cap_platform', month: input.month, percent: 100 },
  );
}

// ---------------------------------------------------------------------------
// Read side: the outbox
// ---------------------------------------------------------------------------

type Row = typeof securityNotifications.$inferSelect;

type Delivery =
  /** At least one email went out. */
  | Readonly<{ kind: 'sent' }>
  /** Nobody to tell, or the news went stale. */
  | Readonly<{ kind: 'skip' }>
  /** Not yet: look again at this time (no attempt is counted). */
  | Readonly<{ kind: 'wait'; at: number }>;

const SENT: Delivery = { kind: 'sent' };
const SKIP: Delivery = { kind: 'skip' };

export type SecurityNotificationRun = Readonly<{
  sent: number;
  skipped: number;
  failed: number;
  /** When the alarm should look again; `null` when nothing is pending. */
  nextAt: number | null;
}>;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stampMs(value: string): number {
  return Date.parse(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`);
}

async function nextPendingAt(db: Db): Promise<number | null> {
  const [row] = await db
    .select({ at: min(securityNotifications.next_attempt_at) })
    .from(securityNotifications)
    .where(eq(securityNotifications.status, 'pending'));
  return row?.at ? stampMs(row.at) : null;
}

async function finishRows(
  db: Db,
  ids: ReadonlyArray<string>,
  status: 'sent' | 'skipped' | 'failed',
  now: number,
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db
    .update(securityNotifications)
    .set({
      status,
      attempts: sql`${securityNotifications.attempts} + ${status === 'skipped' ? 0 : 1}`,
      sent_at: status === 'sent' ? iso(now) : null,
    })
    .where(
      and(inArray(securityNotifications.id, [...ids]), eq(securityNotifications.status, 'pending')),
    );
}

async function delayRows(db: Db, ids: ReadonlyArray<string>, at: number): Promise<void> {
  await db
    .update(securityNotifications)
    .set({ next_attempt_at: iso(at) })
    .where(
      and(inArray(securityNotifications.id, [...ids]), eq(securityNotifications.status, 'pending')),
    );
}

/** An attempt threw: back off, or give up after the third. */
async function failRows(
  db: Db,
  rows: ReadonlyArray<Row>,
  now: number,
): Promise<'failed' | 'retry'> {
  let outcome: 'failed' | 'retry' = 'retry';
  for (const row of rows) {
    const attempts = row.attempts + 1;
    if (attempts >= SECURITY_NOTIFICATION_MAX_ATTEMPTS) {
      await finishRows(db, [row.id], 'failed', now);
      outcome = 'failed';
      continue;
    }
    await db
      .update(securityNotifications)
      .set({
        attempts,
        next_attempt_at: iso(now + SECURITY_NOTIFICATION_BACKOFF_MS[attempts - 1]!),
      })
      .where(
        and(eq(securityNotifications.id, row.id), eq(securityNotifications.status, 'pending')),
      );
  }
  return outcome;
}

/**
 * One alarm pass over the outbox. Due rows are delivered; a findings row waits out the
 * project's 30-minute cooldown and then goes out with every other due findings row of the
 * project as one email.
 */
export async function runSecurityNotifications(
  db: Db,
  env: PlatformEmailEnv,
  now: number = Date.now(),
): Promise<SecurityNotificationRun> {
  const totals = { sent: 0, skipped: 0, failed: 0 };
  if (!env.EMAIL) {
    // Email is off: nothing to send now, and a later "on" does not replay old news.
    await db
      .update(securityNotifications)
      .set({ status: 'skipped' })
      .where(eq(securityNotifications.status, 'pending'));
    return { ...totals, nextAt: null };
  }
  const due = await db
    .select()
    .from(securityNotifications)
    .where(
      and(
        eq(securityNotifications.status, 'pending'),
        lte(securityNotifications.next_attempt_at, iso(now)),
      ),
    )
    .orderBy(asc(securityNotifications.created_at), asc(securityNotifications.id))
    .limit(BATCH);

  const live: Array<Row> = [];
  const stale: Array<string> = [];
  for (const row of due) {
    if (now - stampMs(row.created_at) > SECURITY_NOTIFICATION_MAX_AGE_MS) {
      stale.push(row.id);
    } else {
      live.push(row);
    }
  }
  await finishRows(db, stale, 'skipped', now);
  totals.skipped += stale.length;

  // A findings group is delivered as one; every other row on its own.
  const groups: Array<ReadonlyArray<Row>> = [];
  const byProject = new Map<string, Array<Row>>();
  for (const row of live) {
    if (row.kind === 'findings' && row.project_id !== null) {
      const group = byProject.get(row.project_id) ?? [];
      group.push(row);
      byProject.set(row.project_id, group);
      if (group.length === 1) {
        groups.push(group);
      }
    } else {
      groups.push([row]);
    }
  }

  for (const group of groups) {
    try {
      const delivery = await deliver(db, env, group, now);
      if (delivery.kind === 'wait') {
        await delayRows(
          db,
          group.map((row) => row.id),
          delivery.at,
        );
        continue;
      }
      const status = delivery.kind === 'sent' ? 'sent' : 'skipped';
      await finishRows(
        db,
        group.map((row) => row.id),
        status,
        now,
      );
      totals[status] += group.length;
    } catch (error) {
      console.error('[security-notify] delivery failed', {
        kind: group[0]!.kind,
        projectId: group[0]!.project_id,
        error: error instanceof Error ? error.message : String(error),
      });
      if ((await failRows(db, group, now)) === 'failed') {
        totals.failed += group.length;
      }
    }
  }
  return { ...totals, nextAt: await nextPendingAt(db) };
}

async function deliver(
  db: Db,
  env: PlatformEmailEnv,
  group: ReadonlyArray<Row>,
  now: number,
): Promise<Delivery> {
  const row = group[0]!;
  switch (row.kind) {
    case 'findings':
      return deliverFindings(db, env, row.project_id!, group, now);
    case 'reopen':
      return deliverReopen(db, env, row);
    case 'cap_project':
      return deliverProjectCap(db, env, row);
    case 'cap_platform':
      return deliverPlatformCap(db, env, row);
    case 'public_held':
      return deliverPublicHeld(db, env, row);
    case 'public_now_public':
      return deliverNowPublic(db, env, row, now);
    case 'public_canceled':
      return deliverPublicCanceled(db, env, row);
    case 'scan_bypass':
      return deliverBypass(db, env, row, now);
  }
}

/**
 * Sends to everyone. One failed address does not repeat the email to the others: a retry
 * happens only when nobody got it.
 */
async function sendToAll(
  recipients: ReadonlyArray<SecurityRecipient>,
  send: (recipient: SecurityRecipient) => Promise<void>,
): Promise<Delivery> {
  if (recipients.length === 0) {
    return SKIP;
  }
  let delivered = 0;
  let firstError: unknown;
  for (const recipient of recipients) {
    try {
      await send(recipient);
      delivered++;
    } catch (error) {
      firstError ??= error;
      console.error('[security-notify] one recipient failed', {
        userId: recipient.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (delivered === 0) {
    throw firstError;
  }
  return SENT;
}

async function projectSlug(db: Db, projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.slug ?? null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const RESOLUTION_WORDS = {
  fixed: 'fixed',
  false_positive: 'false positive',
  accepted_risk: 'accepted risk',
} as const;

function provider(model: string | null): string | null {
  if (model === null || model.startsWith('@cf/')) {
    return null;
  }
  const host = model.split('/')[0];
  if (host === 'anthropic') {
    return 'Anthropic';
  }
  if (host === 'openai') {
    return 'OpenAI';
  }
  return host ?? null;
}

type NewFinding = SecurityEmailFinding & Readonly<{ number: number }>;

/**
 * The findings that count as new for these scans (spec §9.4), read now: first seen as
 * confirmed, promoted from a lead, or reopened or raised into high or critical. A finding
 * resolved since is not new any more. The scan's own `news` list is not stored; this is
 * its stored trace (`created` / `promoted` / `reopened` / `severity_changed` events).
 */
async function newFindingsOfScans(
  db: Db,
  projectId: string,
  scanIds: ReadonlyArray<string>,
): Promise<Readonly<{ findings: Array<NewFinding>; leads: number }>> {
  const events = await db
    .select({ findingId: securityFindingEvents.finding_id, action: securityFindingEvents.action })
    .from(securityFindingEvents)
    .where(
      and(
        eq(securityFindingEvents.project_id, projectId),
        inArray(securityFindingEvents.scan_id, [...scanIds]),
        inArray(securityFindingEvents.action, [
          'created',
          'promoted',
          'reopened',
          'severity_changed',
        ]),
      ),
    );
  const actions = new Map<string, Set<string>>();
  for (const event of events) {
    const set = actions.get(event.findingId) ?? new Set<string>();
    set.add(event.action);
    actions.set(event.findingId, set);
  }
  if (actions.size === 0) {
    return { findings: [], leads: 0 };
  }
  const rows = await db
    .select({
      id: securityFindings.id,
      number: securityFindings.number,
      verdict: securityFindings.verdict,
      severity: securityFindings.severity,
      override: securityFindings.severity_override,
      title: securityFindings.title,
      file: securityFindings.file,
      duplicateOf: securityFindings.possible_duplicate_of,
    })
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, projectId),
        inArray(securityFindings.id, [...actions.keys()]),
        eq(securityFindings.state, 'open'),
      ),
    );
  const duplicates = await duplicateNotes(
    db,
    projectId,
    rows.map((row) => row.duplicateOf).filter((id): id is string => id !== null),
  );
  const findings: Array<NewFinding> = [];
  let leads = 0;
  for (const row of rows) {
    const seen = actions.get(row.id)!;
    if (row.verdict === 'needs_validation') {
      if (seen.has('created')) {
        leads++;
      }
      continue;
    }
    const severity = row.override ?? row.severity;
    if (severity === null || severity === 'informational') {
      continue;
    }
    const urgent = isUrgentSeverity(severity);
    const isNew =
      seen.has('created') ||
      seen.has('promoted') ||
      (urgent && (seen.has('reopened') || seen.has('severity_changed')));
    if (!isNew) {
      continue;
    }
    findings.push({
      number: row.number,
      label: `F-${row.number}`,
      severity,
      title: row.title,
      file: row.file,
      urgent,
      duplicateNote: row.duplicateOf ? (duplicates.get(row.duplicateOf) ?? null) : null,
    });
  }
  findings.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.number - b.number,
  );
  return { findings, leads };
}

async function duplicateNotes(
  db: Db,
  projectId: string,
  ids: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) {
    return out;
  }
  const rows = await db
    .select({
      id: securityFindings.id,
      number: securityFindings.number,
      resolution: securityFindings.resolution,
      resolvedAt: securityFindings.resolved_at,
    })
    .from(securityFindings)
    .where(and(eq(securityFindings.project_id, projectId), inArray(securityFindings.id, [...ids])));
  for (const row of rows) {
    const how = row.resolution ? RESOLUTION_WORDS[row.resolution] : null;
    out.set(
      row.id,
      `possible duplicate of F-${row.number}${
        how && row.resolvedAt
          ? `, resolved ${how} on ${formatSecurityDay(stampMs(row.resolvedAt))}`
          : ''
      }`,
    );
  }
  return out;
}

async function deliverFindings(
  db: Db,
  env: PlatformEmailEnv,
  projectId: string,
  group: ReadonlyArray<Row>,
  now: number,
): Promise<Delivery> {
  const [last] = await db
    .select({ at: max(securityNotifications.sent_at) })
    .from(securityNotifications)
    .where(
      and(
        eq(securityNotifications.kind, 'findings'),
        eq(securityNotifications.project_id, projectId),
        eq(securityNotifications.status, 'sent'),
      ),
    );
  if (last?.at) {
    const next = stampMs(last.at) + SECURITY_FINDINGS_COOLDOWN_MS;
    if (next > now) {
      return { kind: 'wait', at: next };
    }
  }
  const slug = await projectSlug(db, projectId);
  const scanIds = [...new Set(group.flatMap((row) => row.scan_ids))];
  if (slug === null || scanIds.length === 0) {
    return SKIP;
  }
  const { findings, leads } = await newFindingsOfScans(db, projectId, scanIds);
  if (findings.length === 0) {
    return SKIP;
  }
  const [headline] = await db
    .select({
      id: securityScans.id,
      deploymentId: securityScans.deployment_id,
      baseDeploymentId: securityScans.base_deployment_id,
      tier: securityScans.tier,
      coverage: securityScans.coverage,
      filesScanned: securityScans.files_scanned,
      model: securityScans.model_used,
    })
    .from(securityScans)
    .where(and(eq(securityScans.project_id, projectId), inArray(securityScans.id, scanIds)))
    .orderBy(desc(securityScans.finished_at), desc(securityScans.id))
    .limit(1);
  let deployment: { id: string; commit: string | null; at: number | null } | null = null;
  if (headline?.deploymentId) {
    const [row] = await db
      .select({ commit: deployments.commit, createdAt: deployments.created_at })
      .from(deployments)
      .where(eq(deployments.id, headline.deploymentId))
      .limit(1);
    deployment = {
      id: headline.deploymentId,
      commit: row?.commit ?? null,
      at: row ? stampMs(row.createdAt) : null,
    };
  }
  const shown = findings.slice(0, SECURITY_EMAIL_MAX_FINDINGS);
  const data = {
    slug,
    scanCount: scanIds.length,
    deployment,
    tier: headline?.tier ?? null,
    baseDeploymentId: headline?.baseDeploymentId ?? null,
    filesScanned: headline?.filesScanned ?? null,
    coverage: headline?.coverage ?? null,
    model: headline?.model ?? null,
    provider: provider(headline?.model ?? null),
    findings: shown,
    moreFindings: findings.length - shown.length,
    leads,
  };
  const recipients = await resolveProjectSecurityRecipients(db, projectId, { scanIds });
  return sendToAll(recipients, (recipient) =>
    sendSecurityFindingsEmail(env, recipient.email, data, recipient.reason),
  );
}

async function deliverReopen(db: Db, env: PlatformEmailEnv, row: Row): Promise<Delivery> {
  const findingId = row.dedupe_key.split(':')[1];
  if (!findingId || row.project_id === null) {
    return SKIP;
  }
  const slug = await projectSlug(db, row.project_id);
  const [finding] = await db
    .select({
      number: securityFindings.number,
      verdict: securityFindings.verdict,
      severity: securityFindings.severity,
      override: securityFindings.severity_override,
      title: securityFindings.title,
      file: securityFindings.file,
      state: securityFindings.state,
    })
    .from(securityFindings)
    .where(and(eq(securityFindings.id, findingId), eq(securityFindings.project_id, row.project_id)))
    .limit(1);
  const severity = finding ? (finding.override ?? finding.severity) : null;
  if (slug === null || !finding || finding.state !== 'open' || severity === null) {
    return SKIP;
  }
  const [event] = await db
    .select({ role: securityFindingEvents.actor_role, comment: securityFindingEvents.comment })
    .from(securityFindingEvents)
    .where(
      and(
        eq(securityFindingEvents.finding_id, findingId),
        eq(securityFindingEvents.action, 'reopened'),
      ),
    )
    .orderBy(desc(securityFindingEvents.created_at), desc(securityFindingEvents.id))
    .limit(1);
  const data = {
    slug,
    finding: { label: `F-${finding.number}`, severity, title: finding.title, file: finding.file },
    actorRole: event?.role ?? null,
    comment: event?.comment ?? null,
  };
  const recipients = await resolveProjectAdminRecipients(db, row.project_id);
  return sendToAll(recipients, (recipient) =>
    sendSecurityReopenEmail(env, recipient.email, data, recipient.reason),
  );
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** `cap_*:<…>:<month>:<percent>` → the month and percent the key was queued for. */
function capKeyParts(key: string): { month: string; percent: 80 | 100 } | null {
  const parts = key.split(':');
  const percent = Number(parts[parts.length - 1]);
  const month = parts[parts.length - 2];
  return month && (percent === 80 || percent === 100) ? { month, percent } : null;
}

async function deliverProjectCap(db: Db, env: PlatformEmailEnv, row: Row): Promise<Delivery> {
  const key = capKeyParts(row.dedupe_key);
  if (!key || row.project_id === null) {
    return SKIP;
  }
  const slug = await projectSlug(db, row.project_id);
  const policy = await readSecurityPolicyLenient(db);
  const [settings] = await db
    .select({
      own: projectSecuritySettings.monthly_cap_cents,
      ceiling: projectSecuritySettings.cap_ceiling_cents,
    })
    .from(projectSecuritySettings)
    .where(eq(projectSecuritySettings.project_id, row.project_id))
    .limit(1);
  const capSettings = {
    monthlyCapCents: settings?.own ?? null,
    capCeilingCents: settings?.ceiling ?? null,
  };
  const capNano = securitySpendCaps(capSettings, policy.budgets).projectNano;
  const [spend] = await db
    .select({ spent: securityProjectSpend.spent_nano_usd })
    .from(securityProjectSpend)
    .where(
      and(
        eq(securityProjectSpend.project_id, row.project_id),
        eq(securityProjectSpend.month, key.month),
      ),
    )
    .limit(1);
  const spentNano = spend?.spent ?? 0;
  if (slug === null || capNano === null || capNano <= 0) {
    return SKIP;
  }
  if (key.percent === 80 && !securityBudgetThresholds(spentNano, capNano).includes(80)) {
    // The cap was raised before this went out.
    return SKIP;
  }
  const ceiling = securityProjectCeilingCents(capSettings, policy.budgets);
  const own = capSettings.monthlyCapCents;
  const capCents = Math.round(capNano / securityCentsToNano(1));
  // The raise line that works now (spec §16.3): the project admin's while their own cap
  // is below the platform limit (or there is none), else the platform admin's.
  const projectAdminCanRaise = ceiling === null || (own !== null && own < ceiling);
  const raise = projectAdminCanRaise
    ? ({
        kind: 'project_admin',
        usdArgument: securityUsdArgument(ceiling ?? capCents * 2),
        limitUsd: ceiling === null ? null : formatSecurityUsd(securityCentsToNano(ceiling)),
      } as const)
    : ({
        kind: 'platform_admin',
        usdArgument: securityUsdArgument(Math.ceil(capCents * 1.5)),
      } as const);
  const data = {
    slug,
    percent: key.percent,
    spentNano,
    capNano,
    resetLabel: securityBudgetResetLabel(Date.parse(key.month)),
    raise,
  };
  const recipients = await resolveProjectAdminRecipients(db, row.project_id);
  return sendToAll(recipients, (recipient) =>
    sendSecurityProjectCapEmail(env, recipient.email, data, recipient.reason),
  );
}

async function deliverPlatformCap(db: Db, env: PlatformEmailEnv, row: Row): Promise<Delivery> {
  const key = capKeyParts(row.dedupe_key);
  if (!key) {
    return SKIP;
  }
  const policy = await readSecurityPolicyLenient(db);
  const capCents = securityPlatformCapCents(policy.budgets);
  const [spend] = await db
    .select({ spent: securityPlatformSpend.spent_nano_usd })
    .from(securityPlatformSpend)
    .where(eq(securityPlatformSpend.month, key.month))
    .limit(1);
  const spentNano = spend?.spent ?? 0;
  if (capCents === null || capCents <= 0) {
    return SKIP;
  }
  const capNano = securityCentsToNano(capCents);
  if (key.percent === 80 && !securityBudgetThresholds(spentNano, capNano).includes(80)) {
    return SKIP;
  }
  const data = {
    percent: key.percent,
    spentNano,
    capNano,
    resetLabel: securityBudgetResetLabel(Date.parse(key.month)),
    raiseUsdArgument: securityUsdArgument(Math.ceil(capCents * 1.5)),
  };
  const recipients = await resolveInstallationAdminRecipients(db);
  return sendToAll(recipients, (recipient) =>
    sendSecurityPlatformCapEmail(env, recipient.email, data, recipient.reason),
  );
}

// ---------------------------------------------------------------------------
// Public requests and bypasses (rows are queued by the gate, M16)
// ---------------------------------------------------------------------------

async function loadRequest(db: Db, row: Row) {
  if (row.request_id === null || row.project_id === null) {
    return null;
  }
  const [request] = await db
    .select()
    .from(securityPublicRequests)
    .where(
      and(
        eq(securityPublicRequests.id, row.request_id),
        eq(securityPublicRequests.project_id, row.project_id),
      ),
    )
    .limit(1);
  return request ?? null;
}

const SCAN_TIER_WORDS = {
  source_diff: 'source diff',
  built_diff: 'built diff',
  full: 'full scan',
} as const;

type ScanBrief = Readonly<{
  deploymentId: string | null;
  tier: keyof typeof SCAN_TIER_WORDS | null;
  coverage: string | null;
  status: string;
  statusReason: string | null;
  failureCause: string | null;
  model: string | null;
  refusalCategory: string | null;
}>;

async function loadScanBrief(db: Db, projectId: string, scanId: string | null) {
  if (scanId === null) {
    return null;
  }
  const [scan]: Array<ScanBrief> = await db
    .select({
      deploymentId: securityScans.deployment_id,
      tier: securityScans.tier,
      coverage: securityScans.coverage,
      status: securityScans.status,
      statusReason: securityScans.status_reason,
      failureCause: securityScans.failure_cause,
      model: securityScans.model_used,
      refusalCategory: securityScans.refusal_category,
    })
    .from(securityScans)
    .where(and(eq(securityScans.id, scanId), eq(securityScans.project_id, projectId)))
    .limit(1);
  return scan ?? null;
}

/** `refused by <model>`, `timed out`, …: why a gate scan gave no result. */
function noResultReason(scan: ScanBrief | null): string | null {
  if (scan === null) {
    return null;
  }
  if (scan.status === 'refused') {
    return scan.model ? `refused by ${scan.model}` : 'refused';
  }
  if (scan.status === 'timed_out') {
    return 'timed out';
  }
  if (scan.failureCause === 'installation') {
    return 'a platform problem';
  }
  if (scan.status === 'skipped' && scan.statusReason === 'budget') {
    return 'the monthly scan budget is used up';
  }
  return scan.status.split('_').join(' ');
}

function scanDescription(scan: ScanBrief | null): string | null {
  if (scan === null || scan.deploymentId === null) {
    return null;
  }
  return [
    scan.deploymentId,
    scan.tier ? SCAN_TIER_WORDS[scan.tier] : null,
    scan.status === 'succeeded' ? (scan.coverage ?? 'complete') : scan.status.split('_').join(' '),
  ]
    .filter(Boolean)
    .join(' · ');
}

async function requesterLabel(
  db: Db,
  request: typeof securityPublicRequests.$inferSelect,
): Promise<string> {
  if (request.requested_via !== 'project') {
    return 'a platform admin';
  }
  if (request.requested_by_user_id === null) {
    return 'a project member';
  }
  const role = await projectRoleForUser(db, request.project_id, request.requested_by_user_id);
  return securityActorRoleLabel(role === 'owner' || role === 'admin' ? role : null);
}

/** F-ids, e.g. `F-12`, to the findings' public parts. */
async function blockerFindings(
  db: Db,
  projectId: string,
  ids: ReadonlyArray<string>,
): Promise<Array<SecurityEmailFinding>> {
  const numbers = ids
    .map((id) => (id.startsWith('F-') ? Number(id.slice(2)) : Number.NaN))
    .filter((value) => Number.isInteger(value));
  if (numbers.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      number: securityFindings.number,
      severity: securityFindings.severity,
      override: securityFindings.severity_override,
      title: securityFindings.title,
      file: securityFindings.file,
    })
    .from(securityFindings)
    .where(
      and(eq(securityFindings.project_id, projectId), inArray(securityFindings.number, numbers)),
    )
    .orderBy(asc(securityFindings.number));
  return rows
    .map((row) => ({
      label: `F-${row.number}`,
      severity: row.override ?? row.severity ?? 'high',
      title: row.title,
      file: row.file,
      urgent: false,
      duplicateNote: null,
    }))
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        a.label.localeCompare(b.label, 'en', { numeric: true }),
    )
    .slice(0, SECURITY_EMAIL_MAX_FINDINGS);
}

const HELD_STATES: ReadonlyArray<string> = ['held_findings', 'held_no_result', 'needs_deploy'];

async function deliverPublicHeld(db: Db, env: PlatformEmailEnv, row: Row): Promise<Delivery> {
  const keyState = row.dedupe_key.split(':')[2] ?? '';
  const request = await loadRequest(db, row);
  const slug = row.project_id ? await projectSlug(db, row.project_id) : null;
  if (!request || slug === null || !HELD_STATES.includes(keyState) || request.state !== keyState) {
    // The request moved on since this was queued: the news is stale.
    return SKIP;
  }
  const scan = await loadScanBrief(db, request.project_id, request.gate_scan_id);
  const data = {
    slug,
    state: keyState as SecurityPublicHeldState,
    requestedBy: await requesterLabel(db, request),
    requestedAt: stampMs(request.created_at),
    scanned: scanDescription(scan),
    blockers:
      keyState === 'held_findings'
        ? await blockerFindings(db, request.project_id, request.blocker_ids)
        : [],
    blockerCount: request.blockers,
    noResultReason: keyState === 'held_no_result' ? noResultReason(scan) : null,
  };
  const recipients = await resolvePublicRequestRecipients(
    db,
    request.project_id,
    request.requested_by_user_id,
  );
  return sendToAll(recipients, (recipient) =>
    sendSecurityPublicHeldEmail(env, recipient.email, data, recipient.reason),
  );
}

async function deliverNowPublic(
  db: Db,
  env: PlatformEmailEnv,
  row: Row,
  now: number,
): Promise<Delivery> {
  const request = await loadRequest(db, row);
  const slug = row.project_id ? await projectSlug(db, row.project_id) : null;
  if (!request || slug === null || (request.state !== 'passed' && request.state !== 'bypassed')) {
    return SKIP;
  }
  const [zeroTrust] = await db
    .select({
      status: projectZeroTrust.status,
      desired: projectZeroTrust.desired_protected,
      effective: projectZeroTrust.effective_protected,
    })
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, request.project_id))
    .limit(1);
  const isPublic =
    !zeroTrust || (zeroTrust.status === 'ready' && !zeroTrust.desired && !zeroTrust.effective);
  if (!isPublic) {
    // Sent once Zero Trust really is off, not when the request closes (spec §12).
    return now - stampMs(row.created_at) > 24 * 60 * 60_000
      ? SKIP
      : { kind: 'wait', at: now + SECURITY_NOW_PUBLIC_WAIT_MS };
  }
  const data = { slug, how: request.state } as const;
  const recipients = await resolvePublicRequestRecipients(
    db,
    request.project_id,
    request.requested_by_user_id,
  );
  return sendToAll(recipients, (recipient) =>
    sendSecurityNowPublicEmail(env, recipient.email, data, recipient.reason),
  );
}

async function deliverPublicCanceled(db: Db, env: PlatformEmailEnv, row: Row): Promise<Delivery> {
  const request = await loadRequest(db, row);
  const slug = row.project_id ? await projectSlug(db, row.project_id) : null;
  const state: SecurityPublicRequestState | undefined = request?.state;
  // `protect` cancels quietly (edge #80): only a gate or policy turn-off is announced.
  if (
    !request ||
    slug === null ||
    state !== 'canceled' ||
    (request.cancel_cause !== 'gate_off' && request.cancel_cause !== 'policy_off')
  ) {
    return SKIP;
  }
  const data = { slug, cause: request.cancel_cause } as const;
  const recipients = await resolvePublicRequestRecipients(
    db,
    request.project_id,
    request.requested_by_user_id,
  );
  return sendToAll(recipients, (recipient) =>
    sendSecurityPublicCanceledEmail(env, recipient.email, data, recipient.reason),
  );
}

async function deliverBypass(
  db: Db,
  env: PlatformEmailEnv,
  row: Row,
  now: number,
): Promise<Delivery> {
  if (row.scan_bypass_id === null || row.project_id === null) {
    return SKIP;
  }
  const [bypass] = await db
    .select()
    .from(securityScanBypasses)
    .where(eq(securityScanBypasses.id, row.scan_bypass_id))
    .limit(1);
  const slug = await projectSlug(db, row.project_id);
  if (!bypass || slug === null) {
    return SKIP;
  }
  const [actor] = await db
    .select({ email: users.email, login: users.login })
    .from(users)
    .where(eq(users.id, bypass.actor_user_id))
    .limit(1);
  const scan = await loadScanBrief(db, row.project_id, bypass.gate_scan_id);
  const unchecked = await db
    .select({ number: securityFindings.number })
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, row.project_id),
        eq(securityFindings.state, 'resolved'),
        eq(securityFindings.resolution, 'fixed'),
        sql`${securityFindings.fix_checked_scan_id} IS NULL`,
      ),
    )
    .orderBy(asc(securityFindings.number));
  const why = noResultReason(scan);
  const skipped =
    bypass.request_state === 'held_no_result'
      ? `the scan did not finish${why ? ` (${why})` : ''}`
      : bypass.request_state === 'needs_deploy'
        ? 'the live deployment had no scan to judge'
        : 'the scan had not finished';
  const data = {
    slug,
    actor: actor?.email?.trim() || actor?.login || bypass.actor_user_id,
    actorRole:
      bypass.actor_kind === 'installation_admin'
        ? 'installation admin'
        : bypass.actor_role === 'owner'
          ? 'owner'
          : 'project admin',
    at: stampMs(bypass.created_at),
    reason: bypass.reason,
    skipped,
    deploymentId: bypass.deployment_id,
    uncheckedFixes: unchecked.map((finding) => `F-${finding.number}`),
  };
  const recipients = await resolveInstallationAdminRecipients(db);
  const delivery = await sendToAll(recipients, (recipient) =>
    sendSecurityBypassEmail(env, recipient.email, data, recipient.reason),
  );
  if (delivery.kind === 'sent') {
    await db
      .update(securityScanBypasses)
      .set({ notified_at: iso(now) })
      .where(eq(securityScanBypasses.id, bypass.id));
  }
  return delivery;
}

/** Hourly backstop: are there rows an alarm should still deliver? */
export async function hasPendingSecurityNotifications(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ id: securityNotifications.id })
    .from(securityNotifications)
    .where(eq(securityNotifications.status, 'pending'))
    .limit(1);
  return row !== undefined;
}

export type { SecurityNotificationKind };
