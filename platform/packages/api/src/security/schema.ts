import type { SecurityEngine } from '@void/platform/security-models';
import type { SecurityMode } from '@void/platform/security-policy';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { projects } from '../schema.ts';

// ---------------------------------------------------------------------------
// Security audits (design doc 0095, spec §14). Every per-project table
// cascades with the project. Deployment, scan and user ids are plain text with
// no FK: scans outlive retention of the rows they point at, deployments are
// pruned on their own schedule, and audit rows keep the id of a deleted user.
//
// Money is stored in whole units so sums never drift: metered spend and
// reserves in nano-dollars (`bigint`, `$1M` = 1e15 fits a safe integer), caps
// in cents (`integer`, the policy allows at most `$1,000,000`).
// ---------------------------------------------------------------------------

export const SECURITY_SCAN_STATUSES = [
  'pending_input',
  'queued',
  'running',
  'succeeded',
  'incomplete',
  'failed',
  'refused',
  'timed_out',
  'superseded',
  'skipped',
  'canceled',
] as const;
export type SecurityScanStatus = (typeof SECURITY_SCAN_STATUSES)[number];

/** `local`, `sweep`, `backfill` and `fallback` are Phase 2/3 triggers, allowed now. */
export const SECURITY_SCAN_TRIGGERS = [
  'deploy',
  'recovery',
  'exposure',
  'rescan',
  'gate',
  'local',
  'sweep',
  'backfill',
  'fallback',
] as const;
export type SecurityScanTrigger = (typeof SECURITY_SCAN_TRIGGERS)[number];

export const SECURITY_SCAN_TIERS = ['source_diff', 'built_diff', 'full'] as const;
export type SecurityScanTier = (typeof SECURITY_SCAN_TIERS)[number];

export const SECURITY_ENGINES = [
  'void_loop',
  'agent_sdk',
  'codex_sdk',
] as const satisfies ReadonlyArray<SecurityEngine>;

/** The policy modes from `SECURITY_MODES`; the migration test checks the two lists match. */
export const SECURITY_POLICY_MODES = [
  'disabled',
  'public',
  'all',
] as const satisfies ReadonlyArray<SecurityMode>;

export const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

export const SECURITY_RESOLUTIONS = ['fixed', 'false_positive', 'accepted_risk'] as const;
export type SecurityResolution = (typeof SECURITY_RESOLUTIONS)[number];

export const SECURITY_PUBLIC_REQUEST_OPEN_STATES = [
  'waiting_scan',
  'held_findings',
  'held_no_result',
  'needs_deploy',
] as const;
export const SECURITY_PUBLIC_REQUEST_STATES = [
  ...SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  'passed',
  'bypassed',
  'canceled',
] as const;
export type SecurityPublicRequestState = (typeof SECURITY_PUBLIC_REQUEST_STATES)[number];
/** A bypass skips the scan only, so it is allowed only while no urgent finding holds the request (D50). */
export const SECURITY_BYPASSABLE_REQUEST_STATES = [
  'waiting_scan',
  'held_no_result',
  'needs_deploy',
] as const satisfies ReadonlyArray<SecurityPublicRequestState>;
export type SecurityBypassableRequestState = (typeof SECURITY_BYPASSABLE_REQUEST_STATES)[number];

export const SECURITY_FINDING_EVENT_ACTIONS = [
  'created',
  'seen_again',
  'seen_again_stale',
  'severity_changed',
  'promoted',
  'not_seen',
  'resolved',
  'reopened',
  'commented',
  // Phase 3 (M35): a human edit of the severity.
  'severity_edited',
] as const;
export type SecurityFindingEventAction = (typeof SECURITY_FINDING_EVENT_ACTIONS)[number];

export const SECURITY_PROJECT_EVENT_ACTIONS = [
  'cap_changed',
  'public_requested',
  'public_held',
  'public_passed',
  'public_canceled',
  'scan_bypassed',
  /** Zero Trust protection turned on / off for the project (silent-gap flag, spec edge #39). */
  'protection_on',
  'protection_off',
] as const;
export type SecurityProjectEventAction = (typeof SECURITY_PROJECT_EVENT_ACTIONS)[number];

export const SECURITY_NOTIFICATION_KINDS = [
  'findings',
  'reopen',
  'cap_project',
  'cap_platform',
  'public_held',
  'public_now_public',
  'public_canceled',
  'scan_bypass',
  // Phase 2 (M26): failure streaks, the weekly digest and the webhook copy of an event.
  'streak_project',
  'streak_installation',
  'digest',
  'webhook',
] as const;
export type SecurityNotificationKind = (typeof SECURITY_NOTIFICATION_KINDS)[number];

/** Kinds about the whole installation: their rows have no project. */
export const SECURITY_PLATFORM_NOTIFICATION_KINDS = [
  'cap_platform',
  'streak_installation',
  'digest',
] as const satisfies ReadonlyArray<SecurityNotificationKind>;

export const SECURITY_NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type SecurityNotificationStatus = (typeof SECURITY_NOTIFICATION_STATUSES)[number];

/** Highest cap in cents (`SECURITY_MAX_MONTHLY_USD` × 100, checked by the migration test). */
export const MAX_CAP_CENTS = 100_000_000;
const MAX_TEXT_CHARS = 4000;

/** `column IN ('a', 'b')` from a fixed list of literals defined in this file. */
function oneOf(column: AnyPgColumn, values: ReadonlyArray<string>): SQL {
  return sql`(${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(', '))}))`;
}

function nullOrOneOf(column: AnyPgColumn, values: ReadonlyArray<string>): SQL {
  return sql`(${column} IS NULL OR ${oneOf(column, values)})`;
}

function capCents(column: AnyPgColumn): SQL {
  return sql`(${column} IS NULL OR ${column} BETWEEN 0 AND ${sql.raw(String(MAX_CAP_CENTS))})`;
}

function at(name: string) {
  return timestamp(name, { mode: 'string', withTimezone: true });
}

function createdAt() {
  return at('created_at').notNull().defaultNow();
}

function nanoUsd(name: string) {
  return bigint(name, { mode: 'number' }).notNull().default(0);
}

function firstOfMonth(column: AnyPgColumn): SQL {
  // EXTRACT on a `date` does not depend on the session time zone; date_trunc does.
  return sql`EXTRACT(DAY FROM ${column}) = 1`;
}

/** Per-project settings. The row is created on first write; a missing row means defaults. */
export const projectSecuritySettings = pgTable(
  'project_security_settings',
  {
    project_id: text('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** `NULL` = the installation default model. */
    model: text('model'),
    provider_notice_version: integer('provider_notice_version'),
    provider_notice_by_user_id: text('provider_notice_by_user_id'),
    provider_notice_at: at('provider_notice_at'),
    /** The project's own cap; `NULL` = none. */
    monthly_cap_cents: integer('monthly_cap_cents'),
    /** Per-project limit set by an installation admin; `NULL` = policy default. */
    cap_ceiling_cents: integer('cap_ceiling_cents'),
    cap_updated_by_user_id: text('cap_updated_by_user_id'),
    cap_updated_at: at('cap_updated_at'),
    /** Next F-number. Taken and bumped under the project lock at ingest. */
    next_finding_number: integer('next_finding_number').notNull().default(1),
    /** Phase 3 (M34). Installation admins only. */
    policy_override: text('policy_override')
      .notNull()
      .default('inherit')
      .$type<'inherit' | 'always' | 'never'>(),
    updated_by_user_id: text('updated_by_user_id'),
    updated_at: at('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('project_security_settings_monthly_cap', capCents(table.monthly_cap_cents)),
    check('project_security_settings_cap_ceiling', capCents(table.cap_ceiling_cents)),
    check('project_security_settings_next_finding', sql`${table.next_finding_number} > 0`),
    check(
      'project_security_settings_policy_override',
      oneOf(table.policy_override, ['inherit', 'always', 'never']),
    ),
    check(
      'project_security_settings_notice',
      sql`(${table.provider_notice_version} IS NULL) = (${table.provider_notice_at} IS NULL)`,
    ),
  ],
);

/** Project-level audit trail (cap changes, public requests, bypasses). Append-only; never fed to scans. */
export const securityProjectEvents = pgTable(
  'security_project_events',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actor_kind: text('actor_kind').notNull().$type<'user' | 'installation_admin' | 'system'>(),
    actor_user_id: text('actor_user_id'),
    actor_role: text('actor_role'),
    action: text('action').notNull().$type<SecurityProjectEventAction>(),
    cap_kind: text('cap_kind').$type<'own' | 'ceiling'>(),
    old_cents: integer('old_cents'),
    new_cents: integer('new_cents'),
    request_id: text('request_id'),
    request_state: text('request_state').$type<SecurityPublicRequestState>(),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_security_project_events_project_created').on(table.project_id, table.created_at),
    check(
      'security_project_events_actor_kind',
      oneOf(table.actor_kind, ['user', 'installation_admin', 'system']),
    ),
    check('security_project_events_action', oneOf(table.action, SECURITY_PROJECT_EVENT_ACTIONS)),
    check('security_project_events_cap_kind', nullOrOneOf(table.cap_kind, ['own', 'ceiling'])),
    check('security_project_events_old_cents', capCents(table.old_cents)),
    check('security_project_events_new_cents', capCents(table.new_cents)),
    check(
      'security_project_events_request_state',
      nullOrOneOf(table.request_state, SECURITY_PUBLIC_REQUEST_STATES),
    ),
  ],
);

/**
 * Public gate requests (spec §5.5). The Zero Trust row stays protected while a
 * request is open; at most one open request per project.
 */
export const securityPublicRequests = pgTable(
  'security_public_requests',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    state: text('state').notNull().$type<SecurityPublicRequestState>(),
    held_reason: text('held_reason'),
    requested_by_user_id: text('requested_by_user_id'),
    requested_via: text('requested_via').notNull().$type<'project' | 'admin' | 'operator'>(),
    /** The live deployment it judges; follows cutover and rollback. */
    target_deployment_id: text('target_deployment_id').notNull(),
    gate_scan_id: text('gate_scan_id'),
    blockers: integer('blockers').notNull().default(0),
    /** F-ids, e.g. `F-12`. */
    blocker_ids: text('blocker_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    cancel_cause: text('cancel_cause').$type<'protect' | 'gate_off' | 'policy_off'>(),
    closed_by_user_id: text('closed_by_user_id'),
    closed_at: at('closed_at'),
    revision: integer('revision').notNull().default(1),
    created_at: createdAt(),
    updated_at: at('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('security_public_requests_open_project')
      .on(table.project_id)
      .where(oneOf(table.state, SECURITY_PUBLIC_REQUEST_OPEN_STATES)),
    index('idx_security_public_requests_state_updated').on(table.state, table.updated_at),
    index('idx_security_public_requests_project_created').on(table.project_id, table.created_at),
    check('security_public_requests_state', oneOf(table.state, SECURITY_PUBLIC_REQUEST_STATES)),
    check(
      'security_public_requests_requested_via',
      oneOf(table.requested_via, ['project', 'admin', 'operator']),
    ),
    check(
      'security_public_requests_cancel_cause',
      sql`(${table.cancel_cause} IS NULL) = (${table.state} <> 'canceled') AND ${nullOrOneOf(table.cancel_cause, ['protect', 'gate_off', 'policy_off'])}`,
    ),
    check(
      'security_public_requests_closed',
      sql`(${table.closed_at} IS NULL) = ${oneOf(table.state, SECURITY_PUBLIC_REQUEST_OPEN_STATES)}`,
    ),
    check('security_public_requests_blockers', sql`${table.blockers} >= 0`),
    check('security_public_requests_revision', sql`${table.revision} > 0`),
  ],
);

/** One row per scan bypass. Append-only; the request it names is kept while it exists. */
export const securityScanBypasses = pgTable(
  'security_scan_bypasses',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    request_id: text('request_id').notNull(),
    deployment_id: text('deployment_id').notNull(),
    actor_kind: text('actor_kind').notNull().$type<'user' | 'installation_admin'>(),
    actor_user_id: text('actor_user_id').notNull(),
    actor_role: text('actor_role'),
    reason: text('reason').notNull(),
    // The request as it was at bypass time.
    request_state: text('request_state').notNull().$type<SecurityBypassableRequestState>(),
    held_reason: text('held_reason'),
    gate_scan_id: text('gate_scan_id'),
    blockers: integer('blockers').notNull().default(0),
    blocker_ids: text('blocker_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notified_at: at('notified_at'),
    created_at: createdAt(),
  },
  (table) => [
    // No action (not restrict): a project delete removes both tables in one statement.
    foreignKey({
      name: 'security_scan_bypasses_request_fk',
      columns: [table.request_id],
      foreignColumns: [securityPublicRequests.id],
    }),
    index('idx_security_scan_bypasses_created').on(table.created_at),
    index('idx_security_scan_bypasses_project_created').on(table.project_id, table.created_at),
    index('idx_security_scan_bypasses_request').on(table.request_id),
    check(
      'security_scan_bypasses_actor_kind',
      oneOf(table.actor_kind, ['user', 'installation_admin']),
    ),
    check(
      'security_scan_bypasses_reason',
      sql`char_length(${table.reason}) BETWEEN 1 AND ${sql.raw(String(MAX_TEXT_CHARS))}`,
    ),
    check(
      'security_scan_bypasses_request_state',
      oneOf(table.request_state, SECURITY_BYPASSABLE_REQUEST_STATES),
    ),
    check('security_scan_bypasses_blockers', sql`${table.blockers} >= 0`),
  ],
);

/** Live spend meter per project and UTC month, written by the model proxy. */
export const securityProjectSpend = pgTable(
  'security_project_spend',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** First day of the month, UTC. */
    month: date('month', { mode: 'string' }).notNull(),
    spent_nano_usd: nanoUsd('spent_nano_usd'),
    reserved_nano_usd: nanoUsd('reserved_nano_usd'),
    scans: integer('scans').notNull().default(0),
    alerted_80_at: at('alerted_80_at'),
    alerted_100_at: at('alerted_100_at'),
    updated_at: at('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.month] }),
    check('security_project_spend_month', firstOfMonth(table.month)),
    check(
      'security_project_spend_nonnegative',
      sql`${table.spent_nano_usd} >= 0 AND ${table.reserved_nano_usd} >= 0 AND ${table.scans} >= 0`,
    ),
  ],
);

/** Installation month total. Not per project, so it survives project deletes. */
export const securityPlatformSpend = pgTable(
  'security_platform_spend',
  {
    month: date('month', { mode: 'string' }).primaryKey(),
    spent_nano_usd: nanoUsd('spent_nano_usd'),
    reserved_nano_usd: nanoUsd('reserved_nano_usd'),
    alerted_80_at: at('alerted_80_at'),
    alerted_100_at: at('alerted_100_at'),
    updated_at: at('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('security_platform_spend_month', firstOfMonth(table.month)),
    check(
      'security_platform_spend_nonnegative',
      sql`${table.spent_nano_usd} >= 0 AND ${table.reserved_nano_usd} >= 0`,
    ),
  ],
);

export const securityScans = pgTable(
  'security_scans',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** `NULL` only for a Phase 3 `local` check of a working tree. */
    deployment_id: text('deployment_id'),
    base_deployment_id: text('base_deployment_id'),
    base_scan_id: text('base_scan_id'),
    status: text('status').notNull().$type<SecurityScanStatus>(),
    status_reason: text('status_reason'),
    failure_cause: text('failure_cause').$type<'installation' | 'project'>(),
    error_class: text('error_class'),
    refusal_category: text('refusal_category'),
    superseded_by_scan_id: text('superseded_by_scan_id'),
    trigger: text('trigger').notNull().$type<SecurityScanTrigger>(),
    public_request_id: text('public_request_id'),
    tier: text('tier').$type<SecurityScanTier>(),
    coverage: text('coverage').$type<'complete' | 'partial'>(),
    coverage_notes: text('coverage_notes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    backlog_files: integer('backlog_files').notNull().default(0),
    dropped_files: integer('dropped_files').notNull().default(0),
    dropped_bytes: bigint('dropped_bytes', { mode: 'number' }).notNull().default(0),
    files_scanned: integer('files_scanned').notNull().default(0),
    input_bytes: bigint('input_bytes', { mode: 'number' }).notNull().default(0),
    /** Staged deploy inputs held for this scan (`deleteDeploymentInputs` skips them). */
    input_prefix: text('input_prefix'),
    input_r2_key: text('input_r2_key'),
    /** Server-built, ≤ 8 KB, kept for the project's lifetime. */
    ledger_summary: jsonb('ledger_summary'),
    model_requested: text('model_requested'),
    model_used: text('model_used'),
    engine: text('engine').$type<SecurityEngine>(),
    engine_version: text('engine_version'),
    skill_commit: text('skill_commit'),
    policy_mode_at_enqueue: text('policy_mode_at_enqueue').$type<SecurityMode>(),
    public_at_enqueue: boolean('public_at_enqueue'),
    /** Fencing token: every start bumps it; a write with an older attempt is refused. */
    attempt: integer('attempt').notNull().default(0),
    lease_until: at('lease_until'),
    model_calls: integer('model_calls').notNull().default(0),
    tokens_in: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokens_out: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    /** From the gateway, filled in later; `NULL` until known. */
    cost_nano_usd: bigint('cost_nano_usd', { mode: 'number' }),
    /** Live, from the model proxy. */
    metered_nano_usd: nanoUsd('metered_nano_usd'),
    reserved_nano_usd: nanoUsd('reserved_nano_usd'),
    /** ≤ 16 KB. */
    summary: text('summary'),
    first_queued_at: at('first_queued_at'),
    queued_at: at('queued_at'),
    started_at: at('started_at'),
    finished_at: at('finished_at'),
    notified_at: at('notified_at'),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_security_scans_project_status_finished').on(
      table.project_id,
      table.status,
      table.finished_at,
    ),
    uniqueIndex('security_scans_running_project')
      .on(table.project_id)
      .where(sql`${table.status} = 'running'`),
    index('idx_security_scans_waiting')
      .on(table.status, table.first_queued_at)
      .where(oneOf(table.status, ['pending_input', 'queued', 'running'])),
    index('idx_security_scans_input_hold')
      .on(table.input_prefix)
      .where(
        sql`${table.input_prefix} IS NOT NULL AND ${oneOf(table.status, ['pending_input', 'queued'])}`,
      ),
    index('idx_security_scans_deployment').on(table.project_id, table.deployment_id),
    check('security_scans_status', oneOf(table.status, SECURITY_SCAN_STATUSES)),
    check('security_scans_trigger', oneOf(table.trigger, SECURITY_SCAN_TRIGGERS)),
    check(
      'security_scans_deployment',
      sql`${table.deployment_id} IS NOT NULL OR ${table.trigger} = 'local'`,
    ),
    check(
      'security_scans_failure_cause',
      nullOrOneOf(table.failure_cause, ['installation', 'project']),
    ),
    check('security_scans_tier', nullOrOneOf(table.tier, SECURITY_SCAN_TIERS)),
    check('security_scans_coverage', nullOrOneOf(table.coverage, ['complete', 'partial'])),
    check('security_scans_engine', nullOrOneOf(table.engine, SECURITY_ENGINES)),
    check(
      'security_scans_policy_mode',
      nullOrOneOf(table.policy_mode_at_enqueue, SECURITY_POLICY_MODES),
    ),
    check(
      'security_scans_running_lease',
      sql`${table.status} <> 'running' OR ${table.lease_until} IS NOT NULL`,
    ),
    check(
      'security_scans_counts',
      sql`${table.attempt} >= 0 AND ${table.backlog_files} >= 0 AND ${table.dropped_files} >= 0 AND ${table.dropped_bytes} >= 0 AND ${table.files_scanned} >= 0 AND ${table.input_bytes} >= 0 AND ${table.model_calls} >= 0 AND ${table.tokens_in} >= 0 AND ${table.tokens_out} >= 0 AND ${table.metered_nano_usd} >= 0 AND ${table.reserved_nano_usd} >= 0 AND (${table.cost_nano_usd} IS NULL OR ${table.cost_nano_usd} >= 0)`,
    ),
    check(
      'security_scans_ledger_size',
      sql`${table.ledger_summary} IS NULL OR octet_length(${table.ledger_summary}::text) <= 8192`,
    ),
    check(
      'security_scans_summary_size',
      sql`${table.summary} IS NULL OR octet_length(${table.summary}) <= 16384`,
    ),
  ],
);

export const securityFindings = pgTable(
  'security_findings',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The `F-n` number, unique per project. */
    number: integer('number').notNull(),
    fingerprint_key: text('fingerprint_key').notNull(),
    model_fingerprint: text('model_fingerprint'),
    verdict: text('verdict').notNull().$type<'confirmed' | 'needs_validation'>(),
    /** Phase 2 (M30): `runtime` when confirmed on a throwaway copy. */
    verdict_source: text('verdict_source')
      .notNull()
      .default('static')
      .$type<'static' | 'runtime'>(),
    severity: text('severity').$type<SecuritySeverity>(),
    /** Phase 3 (M35): a human edit, sticky across scans. */
    severity_override: text('severity_override').$type<SecuritySeverity>(),
    confidence: text('confidence'),
    title: text('title').notNull(),
    category: text('category').notNull(),
    cwe: text('cwe'),
    file: text('file'),
    line_start: integer('line_start'),
    line_end: integer('line_end'),
    /** Trace, evidence, conditions, fix; ≤ 32 KB. */
    detail: jsonb('detail').notNull().default({}),
    sink_path: text('sink_path'),
    sink_content_hash: text('sink_content_hash'),
    outside_diff: boolean('outside_diff').notNull().default(false),
    source: text('source').notNull().default('scanner').$type<'scanner' | 'server'>(),
    state: text('state').notNull().default('open').$type<'open' | 'resolved'>(),
    resolution: text('resolution').$type<SecurityResolution>(),
    resolved_by_user_id: text('resolved_by_user_id'),
    resolved_at: at('resolved_at'),
    resolved_sink_hash: text('resolved_sink_hash'),
    resolved_severity: text('resolved_severity').$type<SecuritySeverity>(),
    not_seen_in_latest: boolean('not_seen_in_latest').notNull().default(false),
    possible_duplicate_of: text('possible_duplicate_of'),
    reopen_count: integer('reopen_count').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    /** First clean scan after the latest `fixed` resolve that no longer reports it. */
    fix_checked_scan_id: text('fix_checked_scan_id'),
    first_scan_id: text('first_scan_id').notNull(),
    last_seen_scan_id: text('last_seen_scan_id').notNull(),
    first_deployment_id: text('first_deployment_id'),
    created_at: createdAt(),
    updated_at: at('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('security_findings_project_number').on(table.project_id, table.number),
    unique('security_findings_project_fingerprint').on(table.project_id, table.fingerprint_key),
    // Urgent = confirmed, critical/high, open. The effective severity is the human
    // override when one is set (M35), so the index stays right after that ships.
    index('idx_security_findings_urgent')
      .on(table.project_id)
      .where(
        sql`${table.verdict} = 'confirmed' AND COALESCE(${table.severity_override}, ${table.severity}) IN ('critical', 'high') AND ${table.state} = 'open'`,
      ),
    index('idx_security_findings_project_state').on(table.project_id, table.state, table.number),
    check('security_findings_number', sql`${table.number} > 0`),
    check('security_findings_verdict', oneOf(table.verdict, ['confirmed', 'needs_validation'])),
    check('security_findings_verdict_source', oneOf(table.verdict_source, ['static', 'runtime'])),
    check('security_findings_severity', nullOrOneOf(table.severity, SECURITY_SEVERITIES)),
    check(
      'security_findings_severity_override',
      nullOrOneOf(table.severity_override, SECURITY_SEVERITIES),
    ),
    check(
      'security_findings_resolved_severity',
      nullOrOneOf(table.resolved_severity, SECURITY_SEVERITIES),
    ),
    check('security_findings_source', oneOf(table.source, ['scanner', 'server'])),
    check('security_findings_state', oneOf(table.state, ['open', 'resolved'])),
    check(
      'security_findings_resolution',
      sql`(${table.resolution} IS NULL) = (${table.state} = 'open') AND ${nullOrOneOf(table.resolution, SECURITY_RESOLUTIONS)}`,
    ),
    check(
      'security_findings_resolved_at',
      sql`${table.state} = 'open' OR ${table.resolved_at} IS NOT NULL`,
    ),
    check('security_findings_counts', sql`${table.reopen_count} >= 0 AND ${table.revision} > 0`),
    check(
      'security_findings_lines',
      sql`${table.line_start} IS NULL OR ${table.line_end} IS NULL OR ${table.line_end} >= ${table.line_start}`,
    ),
    check('security_findings_detail_size', sql`octet_length(${table.detail}::text) <= 32768`),
  ],
);

/** Audit trail and memory source for findings. Append-only. */
export const securityFindingEvents = pgTable(
  'security_finding_events',
  {
    id: text('id').primaryKey(),
    finding_id: text('finding_id')
      .notNull()
      .references(() => securityFindings.id, { onDelete: 'cascade' }),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    scan_id: text('scan_id'),
    actor_kind: text('actor_kind')
      .notNull()
      .$type<'user' | 'installation_admin' | 'scanner' | 'system'>(),
    actor_user_id: text('actor_user_id'),
    actor_role: text('actor_role'),
    action: text('action').notNull().$type<SecurityFindingEventAction>(),
    resolution: text('resolution').$type<SecurityResolution>(),
    comment: text('comment'),
    // M35 `severity_edited`: the shown severity before and after the human edit.
    severity_from: text('severity_from').$type<SecuritySeverity>(),
    severity_to: text('severity_to').$type<SecuritySeverity>(),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_security_finding_events_project_created').on(table.project_id, table.created_at),
    index('idx_security_finding_events_finding_created').on(table.finding_id, table.created_at),
    check(
      'security_finding_events_actor_kind',
      oneOf(table.actor_kind, ['user', 'installation_admin', 'scanner', 'system']),
    ),
    check('security_finding_events_action', oneOf(table.action, SECURITY_FINDING_EVENT_ACTIONS)),
    check(
      'security_finding_events_resolution',
      nullOrOneOf(table.resolution, SECURITY_RESOLUTIONS),
    ),
    check(
      'security_finding_events_severity_from',
      nullOrOneOf(table.severity_from, SECURITY_SEVERITIES),
    ),
    check(
      'security_finding_events_severity_to',
      nullOrOneOf(table.severity_to, SECURITY_SEVERITIES),
    ),
    check(
      'security_finding_events_comment',
      sql`${table.comment} IS NULL OR char_length(${table.comment}) BETWEEN 1 AND ${sql.raw(String(MAX_TEXT_CHARS))}`,
    ),
  ],
);

/** Model-written rejections. Debugging only; never fed to scans. */
export const securityMemoryRejected = pgTable(
  'security_memory_rejected',
  {
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint_key: text('fingerprint_key').notNull(),
    reason: text('reason').notNull(),
    scan_id: text('scan_id').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.fingerprint_key] }),
    index('idx_security_memory_rejected_project_created').on(table.project_id, table.created_at),
    check('security_memory_rejected_reason', sql`octet_length(${table.reason}) <= 1024`),
  ],
);

/**
 * Outbox for the scheduler DO. Recipients are not stored: they are worked out at
 * send time. `project_id` is `NULL` only for installation-wide kinds
 * (`SECURITY_PLATFORM_NOTIFICATION_KINDS`); a `webhook` row copies its event's project.
 */
export const securityNotifications = pgTable(
  'security_notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().$type<SecurityNotificationKind>(),
    project_id: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** Authors of every merged scan get the findings email. */
    scan_ids: text('scan_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    request_id: text('request_id'),
    scan_bypass_id: text('scan_bypass_id'),
    dedupe_key: text('dedupe_key').notNull(),
    status: text('status').notNull().default('pending').$type<SecurityNotificationStatus>(),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: at('next_attempt_at').notNull().defaultNow(),
    created_at: createdAt(),
    sent_at: at('sent_at'),
  },
  (table) => [
    unique('security_notifications_dedupe_key').on(table.dedupe_key),
    index('idx_security_notifications_due')
      .on(table.next_attempt_at)
      .where(sql`${table.status} = 'pending'`),
    index('idx_security_notifications_project_created').on(table.project_id, table.created_at),
    check('security_notifications_kind', oneOf(table.kind, SECURITY_NOTIFICATION_KINDS)),
    check('security_notifications_status', oneOf(table.status, SECURITY_NOTIFICATION_STATUSES)),
    check(
      'security_notifications_project',
      sql`${table.kind} = 'webhook' OR (${table.project_id} IS NULL) = ${oneOf(table.kind, SECURITY_PLATFORM_NOTIFICATION_KINDS)}`,
    ),
    check('security_notifications_attempts', sql`${table.attempts} >= 0`),
  ],
);
