/**
 * Security notifications (design doc 0095 M15, M26; spec §12). `security_notifications` is
 * the outbox the `SecurityScanScheduler` alarm drains. A row stores no recipient and no
 * text: both are worked out at send time, so an owner transfer, a role change or a finding
 * resolved in between is respected (edge #25, #47, #69, #70). `EMAIL` unbound skips the
 * emails quietly (edge #27); webhook rows still go. With a webhook set, every event gets a
 * `webhook` twin row that posts ids and counts.
 */
import { and, asc, desc, eq, inArray, lte, max, min, ne, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import {
  sendSecurityBypassEmail,
  sendSecurityDigestEmail,
  sendSecurityFindingsEmail,
  sendSecurityInstallationStreakEmail,
  sendSecurityNowPublicEmail,
  sendSecurityPlatformCapEmail,
  sendSecurityProjectCapEmail,
  sendSecurityProjectStreakEmail,
  sendSecurityPublicCanceledEmail,
  sendSecurityPublicHeldEmail,
  sendSecurityReopenEmail,
} from '../email.ts';
import type { PlatformEmailEnv } from '../email.ts';
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
} from './budget.ts';
import type { SecuritySpendCaps } from './budget.ts';
import { readSecurityDigestCounts, securityDigestIsEmpty } from './digest.ts';
import { isUrgentSeverity, severityRank } from './findings.ts';
import { securityCfDefaultModel } from './models.ts';
import {
  SECURITY_EMAIL_MAX_FINDINGS,
  SECURITY_SCAN_TIER_LABELS,
  formatSecurityDay,
  securityActorRoleLabel,
} from './notification-copy.ts';
import type {
  SecurityEmailFinding,
  SecurityEmailReason,
  SecurityPublicHeldState,
} from './notification-copy.ts';
import { readSecurityPolicyLenient } from './policy.ts';
import { readSecurityProjectSettings, securityDuplicateHints } from './project-view.ts';
import { SECURITY_GATE_UNREAD_FILES } from './public-gate-judge.ts';
import {
  resolveInstallationAdminRecipients,
  resolveProjectAdminRecipients,
  resolveProjectSecurityRecipients,
  resolveProjectStreakRecipients,
  resolvePublicRequestRecipients,
} from './recipients.ts';
import type { SecurityRecipient } from './recipients.ts';
import {
  securityFindingEvents,
  securityFindings,
  securityNotifications,
  securityPlatformSpend,
  securityProjectSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
  SECURITY_PLATFORM_NOTIFICATION_KINDS,
} from './schema.ts';
import type { SecurityNotificationKind } from './schema.ts';
import {
  listSecurityProjectStreaks,
  readSecurityInstallationFailures,
  securityInstallationFailing,
} from './streaks.ts';
import { postSecurityWebhook, securityWebhookOn } from './webhook.ts';
import type { SecurityWebhookEnv, SecurityWebhookEvent } from './webhook.ts';

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
const DAY_MS = 24 * 60 * 60_000;
/** Scans listed in one streak email. */
const STREAK_SCANS_SHOWN = 5;

export type SecurityNotificationInput =
  | Readonly<{ kind: 'findings'; projectId: string; scanId: string }>
  | Readonly<{ kind: 'reopen'; projectId: string; findingId: string; reopenCount: number }>
  /** `month` is the spend month as stored, `2026-11-01`. */
  | Readonly<{ kind: 'cap_project'; projectId: string; month: string; percent: 80 | 100 }>
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
  | Readonly<{ kind: 'scan_bypass'; projectId: string; requestId: string; bypassId: string }>
  /** One per streak: keyed by the scan before it (`null`: the project never had one). */
  | Readonly<{ kind: 'streak_project'; projectId: string; sinceScanId: string | null }>
  /** At most one per UTC day, `2026-11-20`. */
  | Readonly<{ kind: 'streak_installation'; day: string }>
  /** One per covered week, keyed by its Monday, `2026-11-09`. */
  | Readonly<{ kind: 'digest'; week: string }>;

/** A webhook row's key is `webhook:` and the key of the event it copies. */
const WEBHOOK_PREFIX = 'webhook:';

/** The key of the event a row tells: a `webhook` row's key without its prefix. */
function eventKeyOf(row: Pick<Row, 'dedupe_key'>): string {
  return row.dedupe_key.startsWith(WEBHOOK_PREFIX)
    ? row.dedupe_key.slice(WEBHOOK_PREFIX.length)
    : row.dedupe_key;
}

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
    case 'public_canceled':
      return `${input.kind}:${input.requestId}`;
    case 'scan_bypass':
      return `scan_bypass:${input.bypassId}`;
    case 'streak_project':
      return `streak_project:${input.projectId}:${input.sinceScanId ?? 'start'}`;
    case 'streak_installation':
      return `streak_installation:${input.day}`;
    case 'digest':
      return `digest:${input.week}`;
  }
}

/**
 * Queues one notification; `false` when the same event is already queued (or sent). Pass
 * the transaction of the change that caused it and poke the scheduler after the commit.
 */
export async function enqueueSecurityNotification(
  db: DbOrTx,
  input: SecurityNotificationInput,
): Promise<boolean> {
  const key = securityNotificationDedupeKey(input);
  const platformKind = (SECURITY_PLATFORM_NOTIFICATION_KINDS as ReadonlyArray<string>).includes(
    input.kind,
  );
  const values = {
    kind: input.kind,
    project_id: platformKind || !('projectId' in input) ? null : input.projectId,
    scan_ids: input.kind === 'findings' ? [input.scanId] : [],
    request_id: 'requestId' in input ? input.requestId : null,
    scan_bypass_id: input.kind === 'scan_bypass' ? input.bypassId : null,
  };
  const rows = await db
    .insert(securityNotifications)
    .values({ id: generateId('sn'), dedupe_key: key, ...values })
    .onConflictDoNothing({ target: securityNotifications.dedupe_key })
    .returning({ id: securityNotifications.id });
  if (rows.length > 0 && (await securityWebhookOn(db))) {
    await db
      .insert(securityNotifications)
      .values({
        ...values,
        id: generateId('sn'),
        kind: 'webhook',
        dedupe_key: WEBHOOK_PREFIX + key,
      })
      .onConflictDoNothing({ target: securityNotifications.dedupe_key });
  }
  return rows.length > 0;
}

/**
 * After a model call settles: queue the 80% / 100% email of each cap the month's metered
 * spend has reached. The dedupe key makes it once per threshold, cap and month.
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
  const project = securityBudgetThresholds(input.projectSpentNano, input.caps.projectNano).at(-1);
  const platform = securityBudgetThresholds(input.platformSpentNano, input.caps.platformNano).at(
    -1,
  );
  let queued = false;
  if (project !== undefined) {
    queued = await enqueueSecurityNotification(db, {
      kind: 'cap_project',
      projectId: input.projectId,
      month: input.month,
      percent: project,
    });
  }
  if (platform !== undefined) {
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

type Row = typeof securityNotifications.$inferSelect;

/** `sent`: at least one email went out; `skip`: nobody to tell, or stale; `wait`: not yet. */
type Delivery = Readonly<{ kind: 'sent' } | { kind: 'skip' } | { kind: 'wait'; at: number }>;

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

function words(text: string): string {
  return text.split('_').join(' ');
}

const pendingIn = (ids: ReadonlyArray<string>) =>
  and(inArray(securityNotifications.id, [...ids]), eq(securityNotifications.status, 'pending'));

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
    .where(pendingIn(ids));
}

async function delayRows(db: Db, ids: ReadonlyArray<string>, at: number): Promise<void> {
  await db
    .update(securityNotifications)
    .set({ next_attempt_at: iso(at) })
    .where(pendingIn(ids));
}

/** An attempt threw: back off, or give up after the third. */
async function failRows(db: Db, rows: ReadonlyArray<Row>, now: number): Promise<boolean> {
  let failed = false;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    if (attempts >= SECURITY_NOTIFICATION_MAX_ATTEMPTS) {
      await finishRows(db, [row.id], 'failed', now);
      failed = true;
      continue;
    }
    await db
      .update(securityNotifications)
      .set({ attempts, next_attempt_at: iso(now + SECURITY_NOTIFICATION_BACKOFF_MS[attempts - 1]) })
      .where(pendingIn([row.id]));
  }
  return failed;
}

/** What the outbox needs: the mail binding, and the keyring that holds the webhook secret. */
export type SecurityNotifyEnv = PlatformEmailEnv & Partial<SecurityWebhookEnv>;

/** `fetch`: the webhook POST; tests replace it. */
export type SecurityNotifyOptions = Readonly<{ fetch?: typeof fetch }>;

/**
 * One alarm pass over the outbox. A findings row waits out the project's 30-minute
 * cooldown, then goes out with every other due findings row of the project as one email.
 */
export async function runSecurityNotifications(
  db: Db,
  env: SecurityNotifyEnv,
  now: number = Date.now(),
  options: SecurityNotifyOptions = {},
): Promise<SecurityNotificationRun> {
  const totals = { sent: 0, skipped: 0, failed: 0 };
  const emailOn = Boolean(env.EMAIL);
  if (!emailOn) {
    // Email is off: a later "on" does not replay old news. Webhook rows need no mail binding.
    await db
      .update(securityNotifications)
      .set({ status: 'skipped' })
      .where(
        and(eq(securityNotifications.status, 'pending'), ne(securityNotifications.kind, 'webhook')),
      );
  }
  const due = await db
    .select()
    .from(securityNotifications)
    .where(
      and(
        eq(securityNotifications.status, 'pending'),
        lte(securityNotifications.next_attempt_at, iso(now)),
        emailOn ? undefined : eq(securityNotifications.kind, 'webhook'),
      ),
    )
    .orderBy(asc(securityNotifications.created_at), asc(securityNotifications.id))
    .limit(BATCH);

  const stale = due.filter(
    (row) => now - stampMs(row.created_at) > SECURITY_NOTIFICATION_MAX_AGE_MS,
  );
  await finishRows(
    db,
    stale.map((row) => row.id),
    'skipped',
    now,
  );
  totals.skipped += stale.length;

  // A findings group is delivered as one; every other row on its own.
  const groups: Array<Array<Row>> = [];
  const byProject = new Map<string, Array<Row>>();
  for (const row of due.filter((entry) => !stale.includes(entry))) {
    const projectId = row.kind === 'findings' ? row.project_id : null;
    const group = projectId === null ? undefined : byProject.get(projectId);
    if (group) {
      group.push(row);
      continue;
    }
    const fresh = [row];
    groups.push(fresh);
    if (projectId !== null) {
      byProject.set(projectId, fresh);
    }
  }

  // After one failed webhook POST the rest of this pass's webhook rows wait: a dead
  // endpoint costs one timeout per pass, not one per row, and the emails keep going.
  let webhookDownUntil: number | null = null;
  for (const group of groups) {
    const ids = group.map((row) => row.id);
    const row = group[0];
    if (row.kind === 'webhook' && webhookDownUntil !== null) {
      await delayRows(db, ids, webhookDownUntil);
      continue;
    }
    try {
      const delivery = await DELIVER[row.kind]({ db, env, row, group, now, options });
      if (delivery.kind === 'wait') {
        await delayRows(db, ids, delivery.at);
        continue;
      }
      const status = delivery.kind === 'sent' ? 'sent' : 'skipped';
      await finishRows(db, ids, status, now);
      totals[status] += group.length;
    } catch (error) {
      console.error('[security-notify] delivery failed', {
        kind: row.kind,
        projectId: row.project_id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (await failRows(db, group, now)) {
        totals.failed += group.length;
      }
      if (row.kind === 'webhook') {
        webhookDownUntil = now + SECURITY_NOTIFICATION_BACKOFF_MS[0];
      }
    }
  }
  const [next] = await db
    .select({ at: min(securityNotifications.next_attempt_at) })
    .from(securityNotifications)
    .where(eq(securityNotifications.status, 'pending'));
  return { ...totals, nextAt: next?.at ? stampMs(next.at) : null };
}

type DeliveryInput = Readonly<{
  db: Db;
  env: SecurityNotifyEnv;
  row: Row;
  group: ReadonlyArray<Row>;
  now: number;
  options: SecurityNotifyOptions;
}>;

const DELIVER: Readonly<
  Record<SecurityNotificationKind, (input: DeliveryInput) => Promise<Delivery>>
> = {
  findings: deliverFindings,
  reopen: deliverReopen,
  cap_project: deliverProjectCap,
  cap_platform: deliverPlatformCap,
  public_held: deliverPublicHeld,
  public_now_public: deliverNowPublic,
  public_canceled: deliverPublicCanceled,
  scan_bypass: deliverBypass,
  streak_project: deliverProjectStreak,
  streak_installation: deliverInstallationStreak,
  digest: deliverDigest,
  webhook: deliverWebhook,
};

/**
 * Sends to everyone. One failed address does not repeat the email to the others: a retry
 * happens only when nobody got it.
 */
async function mailAll<T>(
  env: PlatformEmailEnv,
  recipients: ReadonlyArray<SecurityRecipient>,
  send: (env: PlatformEmailEnv, to: string, data: T, reason: SecurityEmailReason) => Promise<void>,
  data: NoInfer<T>,
): Promise<Delivery> {
  if (recipients.length === 0) {
    return SKIP;
  }
  let delivered = 0;
  let firstError: unknown;
  for (const recipient of recipients) {
    try {
      await send(env, recipient.email, data, recipient.reason);
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

/** `Anthropic` for a third-party model, else `null`. */
function provider(model: string | null): string | null {
  if (model === null || model.startsWith('@cf/')) {
    return null;
  }
  const host = model.split('/')[0];
  return host === 'anthropic' ? 'Anthropic' : host === 'openai' ? 'OpenAI' : (host ?? null);
}

type NewFinding = SecurityEmailFinding & Readonly<{ number: number }>;

/**
 * The findings that count as new for these scans (spec §9.4), read now from the scans'
 * stored trace: first seen as confirmed, promoted from a lead, or reopened or raised into
 * high or critical. A finding resolved since is not new any more.
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
    actions.set(
      event.findingId,
      (actions.get(event.findingId) ?? new Set<string>()).add(event.action),
    );
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
  const duplicates = await securityDuplicateHints(
    db,
    projectId,
    rows.flatMap((row) => (row.duplicateOf ? [row.duplicateOf] : [])),
  );
  const findings: Array<NewFinding> = [];
  let leads = 0;
  for (const row of rows) {
    const seen = actions.get(row.id) ?? new Set<string>();
    if (row.verdict === 'needs_validation') {
      leads += seen.has('created') ? 1 : 0;
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
    const duplicate = row.duplicateOf ? duplicates.get(row.duplicateOf) : undefined;
    findings.push({
      number: row.number,
      label: `F-${row.number}`,
      severity,
      title: row.title,
      file: row.file,
      urgent,
      duplicateNote: duplicate
        ? `possible duplicate of ${duplicate.id}${
            duplicate.resolution && duplicate.resolvedAt
              ? `, resolved ${words(duplicate.resolution)} on ${formatSecurityDay(stampMs(duplicate.resolvedAt))}`
              : ''
          }`
        : null,
    });
  }
  findings.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.number - b.number,
  );
  return { findings, leads };
}

async function deliverFindings({ db, env, row, group, now }: DeliveryInput): Promise<Delivery> {
  const projectId = row.project_id;
  if (projectId === null) {
    throw new Error('A findings notification has no project.');
  }
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
  const next = last?.at ? stampMs(last.at) + SECURITY_FINDINGS_COOLDOWN_MS : 0;
  if (next > now) {
    return { kind: 'wait', at: next };
  }
  const slug = await projectSlug(db, projectId);
  const scanIds = [...new Set(group.flatMap((entry) => entry.scan_ids))];
  if (slug === null || scanIds.length === 0) {
    return SKIP;
  }
  const { findings, leads } = await newFindingsOfScans(db, projectId, scanIds);
  if (findings.length === 0) {
    return SKIP;
  }
  const [headline] = await db
    .select({
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
    const [built] = await db
      .select({ commit: deployments.commit, createdAt: deployments.created_at })
      .from(deployments)
      .where(eq(deployments.id, headline.deploymentId))
      .limit(1);
    deployment = {
      id: headline.deploymentId,
      commit: built?.commit ?? null,
      at: built ? stampMs(built.createdAt) : null,
    };
  }
  const shown = findings.slice(0, SECURITY_EMAIL_MAX_FINDINGS);
  return mailAll(
    env,
    await resolveProjectSecurityRecipients(db, projectId, { scanIds }),
    sendSecurityFindingsEmail,
    {
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
    },
  );
}

async function deliverReopen({ db, env, row }: DeliveryInput): Promise<Delivery> {
  const findingId = row.dedupe_key.split(':')[1];
  if (!findingId || row.project_id === null) {
    return SKIP;
  }
  const slug = await projectSlug(db, row.project_id);
  const [finding] = await db
    .select({
      number: securityFindings.number,
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
  return mailAll(
    env,
    await resolveProjectAdminRecipients(db, row.project_id),
    sendSecurityReopenEmail,
    {
      slug,
      finding: { label: `F-${finding.number}`, severity, title: finding.title, file: finding.file },
      actorRole: event?.role ?? null,
      comment: event?.comment ?? null,
    },
  );
}

/** `cap_*:<…>:<month>:<percent>` → the month and percent the key was queued for. */
function capKeyParts(key: string): { month: string; percent: 80 | 100 } | null {
  const parts = key.split(':');
  const percent = Number(parts.at(-1));
  const month = parts.at(-2);
  return month && (percent === 80 || percent === 100) ? { month, percent } : null;
}

async function deliverProjectCap({ db, env, row }: DeliveryInput): Promise<Delivery> {
  const key = capKeyParts(row.dedupe_key);
  if (!key || row.project_id === null) {
    return SKIP;
  }
  const slug = await projectSlug(db, row.project_id);
  const policy = await readSecurityPolicyLenient(db);
  const { caps } = await readSecurityProjectSettings(db, row.project_id);
  const capNano = securitySpendCaps(caps, policy.budgets).projectNano;
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
  const ceiling = securityProjectCeilingCents(caps, policy.budgets);
  const own = caps.monthlyCapCents;
  const capCents = Math.round(capNano / securityCentsToNano(1));
  // The raise line that works now (spec §16.3): the project admin's while their own cap
  // is below the platform limit (or there is none), else the platform admin's.
  const raise =
    ceiling === null || (own !== null && own < ceiling)
      ? ({
          kind: 'project_admin',
          usdArgument: securityUsdArgument(ceiling ?? capCents * 2),
          limitUsd: ceiling === null ? null : formatSecurityUsd(securityCentsToNano(ceiling)),
        } as const)
      : ({
          kind: 'platform_admin',
          usdArgument: securityUsdArgument(Math.ceil(capCents * 1.5)),
          projectId: row.project_id,
        } as const);
  return mailAll(
    env,
    await resolveProjectAdminRecipients(db, row.project_id),
    sendSecurityProjectCapEmail,
    {
      slug,
      percent: key.percent,
      spentNano,
      capNano,
      resetLabel: securityBudgetResetLabel(Date.parse(key.month)),
      raise,
    },
  );
}

async function deliverPlatformCap({ db, env, row }: DeliveryInput): Promise<Delivery> {
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
  return mailAll(env, await resolveInstallationAdminRecipients(db), sendSecurityPlatformCapEmail, {
    percent: key.percent,
    spentNano,
    capNano,
    resetLabel: securityBudgetResetLabel(Date.parse(key.month)),
    raiseUsdArgument: securityUsdArgument(Math.ceil(capCents * 1.5)),
  });
}

/** The request a row is about, with its project's slug; `null` when either is gone. */
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
  const slug = await projectSlug(db, row.project_id);
  return request && slug !== null ? { request, slug } : null;
}

type PublicRequest = typeof securityPublicRequests.$inferSelect;

function requestRecipients(db: Db, request: PublicRequest) {
  return resolvePublicRequestRecipients(db, request.project_id, request.requested_by_user_id);
}

async function loadScanBrief(db: Db, projectId: string, scanId: string | null) {
  if (scanId === null) {
    return null;
  }
  const [scan] = await db
    .select({
      deploymentId: securityScans.deployment_id,
      tier: securityScans.tier,
      coverage: securityScans.coverage,
      status: securityScans.status,
      statusReason: securityScans.status_reason,
      failureCause: securityScans.failure_cause,
      model: securityScans.model_used,
    })
    .from(securityScans)
    .where(and(eq(securityScans.id, scanId), eq(securityScans.project_id, projectId)))
    .limit(1);
  return scan ?? null;
}

type ScanBrief = Awaited<ReturnType<typeof loadScanBrief>>;

/** `refused by <model>`, `timed out`, …: why a gate scan gave no result. */
function noResultReason(scan: ScanBrief): string | null {
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
  return words(scan.status);
}

function scanDescription(scan: ScanBrief): string | null {
  if (scan === null || scan.deploymentId === null) {
    return null;
  }
  return [
    scan.deploymentId,
    scan.tier ? SECURITY_SCAN_TIER_LABELS[scan.tier] : null,
    scan.status === 'succeeded' ? (scan.coverage ?? 'complete') : words(scan.status),
  ]
    .filter(Boolean)
    .join(' · ');
}

async function requesterLabel(db: Db, request: PublicRequest): Promise<string> {
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
  const numbers = ids.flatMap((id) => {
    const value = id.startsWith('F-') ? Number(id.slice(2)) : Number.NaN;
    return Number.isInteger(value) ? [value] : [];
  });
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

const HELD_STATES: ReadonlySet<string> = new Set([
  'held_findings',
  'held_no_result',
  'needs_deploy',
]);

async function deliverPublicHeld({ db, env, row }: DeliveryInput): Promise<Delivery> {
  const keyState = row.dedupe_key.split(':')[2] ?? '';
  const loaded = await loadRequest(db, row);
  if (!loaded || !HELD_STATES.has(keyState) || loaded.request.state !== keyState) {
    // The request moved on since this was queued: the news is stale.
    return SKIP;
  }
  const { request, slug } = loaded;
  const scan = await loadScanBrief(db, request.project_id, request.gate_scan_id);
  const noResult = keyState === 'held_no_result';
  return mailAll(env, await requestRecipients(db, request), sendSecurityPublicHeldEmail, {
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
    noResultReason: noResult ? noResultReason(scan) : null,
    unreadFiles: noResult && request.held_reason === SECURITY_GATE_UNREAD_FILES,
  });
}

async function deliverNowPublic({ db, env, row, now }: DeliveryInput): Promise<Delivery> {
  const loaded = await loadRequest(db, row);
  const how = loaded?.request.state;
  if (!loaded || (how !== 'passed' && how !== 'bypassed')) {
    return SKIP;
  }
  const { request, slug } = loaded;
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
    return now - stampMs(row.created_at) > DAY_MS
      ? SKIP
      : { kind: 'wait', at: now + SECURITY_NOW_PUBLIC_WAIT_MS };
  }
  return mailAll(env, await requestRecipients(db, request), sendSecurityNowPublicEmail, {
    slug,
    how,
  });
}

async function deliverPublicCanceled({ db, env, row }: DeliveryInput): Promise<Delivery> {
  const loaded = await loadRequest(db, row);
  const cause = loaded?.request.cancel_cause;
  // `protect` cancels quietly (edge #80): only a gate or policy turn-off is announced.
  if (
    !loaded ||
    loaded.request.state !== 'canceled' ||
    (cause !== 'gate_off' && cause !== 'policy_off')
  ) {
    return SKIP;
  }
  return mailAll(
    env,
    await requestRecipients(db, loaded.request),
    sendSecurityPublicCanceledEmail,
    {
      slug: loaded.slug,
      cause,
    },
  );
}

async function deliverBypass({ db, env, row, now }: DeliveryInput): Promise<Delivery> {
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
    bypass.request_state === 'held_no_result' && bypass.held_reason === SECURITY_GATE_UNREAD_FILES
      ? 'the scan could not read some project files'
      : bypass.request_state === 'held_no_result'
        ? `the scan did not finish${why ? ` (${why})` : ''}`
        : bypass.request_state === 'needs_deploy'
          ? 'the live deployment had no scan to judge'
          : 'the scan had not finished';
  const delivery = await mailAll(
    env,
    await resolveInstallationAdminRecipients(db),
    sendSecurityBypassEmail,
    {
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
    },
  );
  if (delivery.kind === 'sent') {
    await db
      .update(securityScanBypasses)
      .set({ notified_at: iso(now) })
      .where(eq(securityScanBypasses.id, bypass.id));
  }
  return delivery;
}

/** `refused by anthropic/…`, `timed out`, `bad output (not_json)`: why a scan gave no result. */
export function securityStreakOutcome(
  scan: Readonly<{
    status: string;
    statusReason: string | null;
    errorClass: string | null;
    model: string | null;
  }>,
): string {
  const reason = scan.statusReason;
  switch (scan.status) {
    case 'refused':
      return scan.model ? `refused by ${scan.model}` : 'refused';
    case 'timed_out':
      return 'timed out';
    case 'incomplete':
      return reason ? `incomplete (${words(reason)})` : 'incomplete';
    case 'failed':
      if (reason === 'bad_output') {
        return scan.errorClass ? `bad output (${scan.errorClass})` : 'bad output';
      }
      if (reason === 'input_missing') {
        return 'code not stored';
      }
      return reason ? `failed (${words(reason)})` : 'failed';
    default:
      return words(scan.status);
  }
}

/** The streak a `streak_project` row (or its webhook twin) was queued for, if still going. */
async function streakOfRow(db: Db, row: Row, now: number) {
  const since = eventKeyOf(row).split(':')[2];
  if (row.project_id === null || !since) {
    return null;
  }
  const streaks = await listSecurityProjectStreaks(db, {
    now,
    projectId: row.project_id,
    freshOnly: false,
  });
  const sinceScanId = since === 'start' ? null : since;
  return streaks.find((streak) => streak.sinceScanId === sinceScanId) ?? null;
}

async function deliverProjectStreak({ db, env, row, now }: DeliveryInput): Promise<Delivery> {
  const streak = await streakOfRow(db, row, now);
  const slug = row.project_id ? await projectSlug(db, row.project_id) : null;
  if (!streak || slug === null) {
    // A scan succeeded meanwhile, or the project is gone: the streak is over.
    return SKIP;
  }
  const shownIds = streak.scanIds.slice(0, STREAK_SCANS_SHOWN);
  const scans =
    shownIds.length === 0
      ? []
      : await db
          .select({
            id: securityScans.id,
            deploymentId: securityScans.deployment_id,
            status: securityScans.status,
            statusReason: securityScans.status_reason,
            errorClass: securityScans.error_class,
            model: securityScans.model_used,
            finishedAt: securityScans.finished_at,
          })
          .from(securityScans)
          .where(
            and(
              eq(securityScans.project_id, streak.projectId),
              inArray(securityScans.id, shownIds),
            ),
          )
          .orderBy(desc(securityScans.created_at), desc(securityScans.id));
  const newest = scans[0];
  const policy = await readSecurityPolicyLenient(db);
  return mailAll(
    env,
    await resolveProjectStreakRecipients(db, streak.projectId),
    sendSecurityProjectStreakEmail,
    {
      slug,
      failures: streak.failures,
      scans: scans.map((scan) => ({
        id: scan.id,
        deploymentId: scan.deploymentId,
        outcome: securityStreakOutcome(scan),
        at: scan.finishedAt ? stampMs(scan.finishedAt) : null,
      })),
      refusedModel:
        newest?.status === 'refused' && newest.model !== null && !newest.model.startsWith('@cf/')
          ? newest.model
          : null,
      cfModel: securityCfDefaultModel(policy),
      fallbackOn: policy.fallbackToCf,
    },
  );
}

async function deliverInstallationStreak({ db, env, row }: DeliveryInput): Promise<Delivery> {
  const day = eventKeyOf(row).split(':')[1];
  if (!day || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) {
    return SKIP;
  }
  // The 24 hours up to when the row was queued: a retry tells the same numbers.
  const failures = await readSecurityInstallationFailures(db, stampMs(row.created_at));
  if (!securityInstallationFailing(failures)) {
    return SKIP;
  }
  return mailAll(
    env,
    await resolveInstallationAdminRecipients(db),
    sendSecurityInstallationStreakEmail,
    { ended: failures.ended, failed: failures.failed, byReason: failures.byReason },
  );
}

/** The counts of the week a `digest` row (or its twin) covers; `null` with nothing to tell. */
async function digestOfRow(db: Db, row: Row, now: number) {
  const week = eventKeyOf(row).split(':')[1];
  const fromMs = week ? Date.parse(`${week}T00:00:00Z`) : Number.NaN;
  if (!week || !Number.isFinite(fromMs)) {
    return null;
  }
  const counts = await readSecurityDigestCounts(
    db,
    { week, fromMs, toMs: fromMs + 7 * DAY_MS },
    now,
  );
  return securityDigestIsEmpty(counts) ? null : { fromMs, counts };
}

async function deliverDigest({ db, env, row, now }: DeliveryInput): Promise<Delivery> {
  const digest = await digestOfRow(db, row, now);
  if (digest === null) {
    return SKIP;
  }
  const { week: _week, ...counts } = digest.counts;
  return mailAll(env, await resolveInstallationAdminRecipients(db), sendSecurityDigestEmail, {
    ...counts,
    weekLabel: `${formatSecurityDay(digest.fromMs)} – ${formatSecurityDay(digest.fromMs + 6 * DAY_MS)}`,
  });
}

/** The webhook body of the event a `webhook` row copies; `null` when there is nothing to tell. */
export async function securityWebhookEventOf(
  db: Db,
  row: Row,
  now: number,
): Promise<SecurityWebhookEvent | null> {
  if (!row.dedupe_key.startsWith(WEBHOOK_PREFIX)) {
    return null;
  }
  const key = eventKeyOf(row);
  const parts = key.split(':');
  const kind = parts[0] ?? '';
  const slug = row.project_id === null ? null : await projectSlug(db, row.project_id);
  if (row.project_id !== null && slug === null) {
    return null;
  }
  const event = (data: Record<string, unknown>): SecurityWebhookEvent => ({
    id: row.id,
    type: `security.${kind}`,
    createdAt: iso(stampMs(row.created_at)),
    project: row.project_id === null ? null : { id: row.project_id, slug },
    data,
  });
  switch (kind) {
    case 'findings': {
      if (row.project_id === null) {
        return null;
      }
      const { findings, leads } = await newFindingsOfScans(db, row.project_id, row.scan_ids);
      const bySeverity: Record<string, number> = {};
      for (const finding of findings) {
        bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
      }
      return event({
        scanIds: row.scan_ids,
        newFindings: findings.length,
        urgent: findings.filter((finding) => finding.urgent).length,
        bySeverity,
        findingIds: findings.map((finding) => finding.label),
        leads,
      });
    }
    case 'reopen': {
      const [finding] = await db
        .select({
          number: securityFindings.number,
          severity: securityFindings.severity,
          override: securityFindings.severity_override,
        })
        .from(securityFindings)
        .where(eq(securityFindings.id, parts[1] ?? ''))
        .limit(1);
      return finding
        ? event({
            findingId: `F-${finding.number}`,
            severity: finding.override ?? finding.severity,
            reopenCount: Number(parts[2]),
          })
        : null;
    }
    case 'cap_project':
    case 'cap_platform': {
      const cap = capKeyParts(key);
      return cap ? event({ month: cap.month, percent: cap.percent }) : null;
    }
    case 'public_held':
      return event({
        requestId: row.request_id,
        state: parts[2] ?? null,
        gateScanId: parts[3] && parts[3] !== '-' ? parts[3] : null,
      });
    case 'public_now_public':
    case 'public_canceled':
      return event({ requestId: row.request_id });
    case 'scan_bypass':
      return event({ requestId: row.request_id, bypassId: row.scan_bypass_id });
    case 'streak_project': {
      const streak = await streakOfRow(db, row, now);
      return streak
        ? event({
            failures: streak.failures,
            scanIds: streak.scanIds.slice(0, STREAK_SCANS_SHOWN),
            sinceScanId: streak.sinceScanId,
          })
        : null;
    }
    case 'streak_installation': {
      const failures = await readSecurityInstallationFailures(db, stampMs(row.created_at));
      return event({
        day: parts[1] ?? null,
        ended: failures.ended,
        failed: failures.failed,
        byReason: failures.byReason,
      });
    }
    case 'digest': {
      const digest = await digestOfRow(db, row, now);
      return digest ? event({ ...digest.counts }) : null;
    }
    default:
      return null;
  }
}

async function deliverWebhook({ db, env, row, now, options }: DeliveryInput): Promise<Delivery> {
  const event = await securityWebhookEventOf(db, row, now);
  if (event === null) {
    return SKIP;
  }
  const { PROJECT_SECRET_KEYS_JSON, PROJECT_SECRET_ACTIVE_KEY_VERSION } = env;
  if (!PROJECT_SECRET_KEYS_JSON || !PROJECT_SECRET_ACTIVE_KEY_VERSION) {
    throw new Error('The platform keyring is not bound; the webhook secret cannot be read.');
  }
  const webhookEnv: SecurityWebhookEnv = {
    PROJECT_SECRET_KEYS_JSON,
    PROJECT_SECRET_ACTIVE_KEY_VERSION,
    PLATFORM_INSTALLATION_ID: env.PLATFORM_INSTALLATION_ID,
  };
  const result = await postSecurityWebhook(webhookEnv, db, event, options.fetch);
  return result === 'sent' ? SENT : SKIP;
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
