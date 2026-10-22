import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
// Ownership IDs remain as audit identities after a user or project is deleted;
// authorization always joins the current user/project records.

/** Retained provider ownership, including ambiguous writes and project deletion. */
export const emailSharedRecipients = pgTable(
  'email_shared_recipients',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    project_id: text('project_id').notNull(),
    route_id: text('route_id').notNull(),
    recipient: text('recipient').notNull(),
    rule_name: text('rule_name').notNull(),
    rule_id: text('rule_id'),
    create_started_at: timestamp('create_started_at', { mode: 'string', withTimezone: true }),
    removing: boolean('removing').notNull().default(false),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'reconciling' | 'ready' | 'blocked' | 'unknown' | 'removed'>(),
    reason: text('reason'),
    attempt: integer('attempt').notNull().default(0),
    lease_started_at: timestamp('lease_started_at', { mode: 'string', withTimezone: true }),
    observed_at: timestamp('observed_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('email_shared_recipients_project_address_uq').on(
      table.installation_id,
      table.project_id,
      table.recipient,
    ),
    uniqueIndex('email_shared_recipients_rule_name_uq').on(table.rule_name),
    index('email_shared_recipients_reconcile_idx').on(table.status, table.updated_at),
  ],
);

/** One Cloudflare catch-all and ingress Worker per account/zone in an installation. */
export const emailZoneConnections = pgTable(
  'email_zone_connections',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    account_id: text('account_id').notNull(),
    zone_id: text('zone_id').notNull(),
    zone_name: text('zone_name').notNull(),
    managed_by: text('managed_by').notNull().$type<'owner' | 'admin'>(),
    manager_user_id: text('manager_user_id'),
    credential_id: text('credential_id'),
    ingress_worker_name: text('ingress_worker_name').notNull(),
    ingress_version: integer('ingress_version'),
    desired_generation: integer('desired_generation').notNull().default(1),
    active_secret_generation: integer('active_secret_generation').notNull().default(0),
    staged_secret_generation: integer('staged_secret_generation'),
    secret_ciphertext: text('secret_ciphertext').notNull(),
    secret_iv: text('secret_iv').notNull(),
    secret_key_version: text('secret_key_version').notNull(),
    staged_secret_ciphertext: text('staged_secret_ciphertext'),
    staged_secret_iv: text('staged_secret_iv'),
    staged_secret_key_version: text('staged_secret_key_version'),
    previous_secret_hash: text('previous_secret_hash'),
    previous_secret_until: timestamp('previous_secret_until', {
      mode: 'string',
      withTimezone: true,
    }),
    inbound_status: text('inbound_status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'ready' | 'disabled' | 'drifted'>(),
    inbound_reason: text('inbound_reason'),
    inbound_observed_at: timestamp('inbound_observed_at', { mode: 'string', withTimezone: true }),
    management_status: text('management_status')
      .notNull()
      .default('probe_failed')
      .$type<'healthy' | 'expired' | 'revoked' | 'refresh_unknown' | 'probe_failed'>(),
    management_reason: text('management_reason'),
    management_observed_at: timestamp('management_observed_at', {
      mode: 'string',
      withTimezone: true,
    }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('email_zone_connections_zone_uq').on(
      table.installation_id,
      table.account_id,
      table.zone_id,
    ),
    uniqueIndex('email_zone_connections_ingress_uq').on(
      table.account_id,
      table.ingress_worker_name,
    ),
    index('email_zone_connections_manager_idx').on(table.manager_user_id),
    check(
      'email_zone_connections_manager_check',
      sql`(${table.managed_by} = 'owner' AND ${table.manager_user_id} IS NOT NULL) OR (${table.managed_by} = 'admin')`,
    ),
  ],
);

/** An exact SMTP envelope domain, with a single project assignment or shared addressing. */
export type EmailInboundMode = 'managed' | 'none';

export const emailDomainRoutes = pgTable(
  'email_domain_routes',
  {
    id: text('id').primaryKey(),
    domain: text('domain').notNull(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => emailZoneConnections.id),
    project_id: text('project_id'),
    addressing: text('addressing').notNull().$type<'custom' | 'shared'>(),
    managed_by: text('managed_by').notNull().$type<'owner' | 'admin'>(),
    assigned_by_user_id: text('assigned_by_user_id'),
    desired_state: text('desired_state')
      .notNull()
      .default('active')
      .$type<'active' | 'disabled' | 'removed'>(),
    // 'none': outbound only. Inbound mail stays with the domain's own MX provider, so setup
    // never touches Email Routing and the route never becomes inbound-ready.
    inbound_mode: text('inbound_mode').notNull().default('managed').$type<EmailInboundMode>(),
    inbound_status: text('inbound_status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'ready' | 'disabled' | 'drifted'>(),
    inbound_reason: text('inbound_reason'),
    inbound_observed_at: timestamp('inbound_observed_at', { mode: 'string', withTimezone: true }),
    outbound_status: text('outbound_status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'verified_only' | 'ready' | 'blocked'>(),
    outbound_reason: text('outbound_reason'),
    outbound_observed_at: timestamp('outbound_observed_at', { mode: 'string', withTimezone: true }),
    desired_generation: integer('desired_generation').notNull().default(1),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('email_domain_routes_domain_uq').on(table.domain),
    index('email_domain_routes_connection_idx').on(table.connection_id),
    index('email_domain_routes_project_idx').on(table.project_id),
    check(
      'email_domain_routes_assignment_check',
      sql`(${table.addressing} = 'custom' AND ${table.project_id} IS NOT NULL) OR (${table.addressing} = 'shared' AND ${table.project_id} IS NULL)`,
    ),
    check(
      'email_domain_routes_inbound_mode_check',
      sql`${table.inbound_mode} = 'managed' OR (${table.inbound_mode} = 'none' AND ${table.addressing} = 'custom')`,
    ),
  ],
);

export const emailCredentials = pgTable(
  'email_credentials',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    managed_by: text('managed_by').notNull().$type<'owner' | 'admin'>(),
    manager_user_id: text('manager_user_id'),
    kind: text('kind').notNull().$type<'api_token' | 'platform'>(),
    account_id: text('account_id').notNull(),
    zone_id: text('zone_id').notNull(),
    ciphertext: text('ciphertext'),
    iv: text('iv'),
    key_version: text('key_version'),
    token_id: text('token_id'),
    expires_on: timestamp('expires_on', { mode: 'string', withTimezone: true }),
    generation: integer('generation').notNull().default(1),
    status: text('status')
      .notNull()
      .default('healthy')
      .$type<'healthy' | 'expired' | 'revoked' | 'probe_failed'>(),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('email_credentials_scope_idx').on(table.installation_id, table.account_id, table.zone_id),
    check(
      'email_credentials_material_check',
      sql`(${table.kind} = 'platform' AND ${table.ciphertext} IS NULL AND ${table.iv} IS NULL AND ${table.key_version} IS NULL) OR (${table.kind} = 'api_token' AND ${table.ciphertext} IS NOT NULL AND ${table.iv} IS NOT NULL AND ${table.key_version} IS NOT NULL)`,
    ),
  ],
);

export const emailOperations = pgTable(
  'email_operations',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    connection_id: text('connection_id')
      .notNull()
      .references(() => emailZoneConnections.id),
    route_id: text('route_id').references(() => emailDomainRoutes.id, { onDelete: 'set null' }),
    /** Route generation captured when the operation intent was committed. */
    route_generation: integer('route_generation'),
    actor_kind: text('actor_kind').notNull().$type<'owner' | 'admin' | 'system'>(),
    actor_user_id: text('actor_user_id'),
    actor_scope: text('actor_scope').notNull(),
    kind: text('kind').notNull().$type<'setup' | 'sync' | 'remove' | 'rotate_secret' | 'cleanup'>(),
    idempotency_key: text('idempotency_key').notNull(),
    request_digest: text('request_digest').notNull(),
    desired_generation: integer('desired_generation').notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'running' | 'blocked' | 'unknown' | 'completed'>(),
    current_step: text('current_step'),
    failure_code: text('failure_code'),
    failure_detail: text('failure_detail'),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('email_operations_key_uq').on(
      table.installation_id,
      table.actor_scope,
      table.idempotency_key,
    ),
    index('email_operations_work_idx').on(table.status, table.updated_at),
    index('email_operations_connection_idx').on(table.connection_id),
  ],
);

export const emailOperationSteps = pgTable(
  'email_operation_steps',
  {
    id: text('id').primaryKey(),
    operation_id: text('operation_id')
      .notNull()
      .references(() => emailOperations.id),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').notNull(),
    resource_identity: text('resource_identity').notNull(),
    request_digest: text('request_digest').notNull(),
    attempt: integer('attempt').notNull().default(0),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'in_flight' | 'confirmed' | 'blocked' | 'unknown'>(),
    outcome: jsonb('outcome').$type<Record<string, unknown> | null>(),
    failure_code: text('failure_code'),
    failure_detail: text('failure_detail'),
    started_at: timestamp('started_at', { mode: 'string', withTimezone: true }),
    finished_at: timestamp('finished_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [uniqueIndex('email_operation_steps_order_uq').on(table.operation_id, table.ordinal)],
);

export const emailCacheOutbox = pgTable(
  'email_cache_outbox',
  {
    id: text('id').primaryKey(),
    installation_id: text('installation_id').notNull(),
    resource_kind: text('resource_kind').notNull(),
    resource_id: text('resource_id').notNull(),
    version: integer('version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown> | null>(),
    published_at: timestamp('published_at', { mode: 'string', withTimezone: true }),
    created_at: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('email_cache_outbox_version_uq').on(
      table.resource_kind,
      table.resource_id,
      table.version,
    ),
    index('email_cache_outbox_pending_idx').on(table.published_at, table.created_at),
  ],
);
