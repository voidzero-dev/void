CREATE TABLE "project_security_settings" (
	"project_id" text PRIMARY KEY NOT NULL,
	"model" text,
	"provider_notice_version" integer,
	"provider_notice_by_user_id" text,
	"provider_notice_at" timestamp with time zone,
	"monthly_cap_cents" integer,
	"cap_ceiling_cents" integer,
	"cap_updated_by_user_id" text,
	"cap_updated_at" timestamp with time zone,
	"next_finding_number" integer DEFAULT 1 NOT NULL,
	"policy_override" text DEFAULT 'inherit' NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_security_settings_monthly_cap" CHECK (("project_security_settings"."monthly_cap_cents" IS NULL OR "project_security_settings"."monthly_cap_cents" BETWEEN 0 AND 100000000)),
	CONSTRAINT "project_security_settings_cap_ceiling" CHECK (("project_security_settings"."cap_ceiling_cents" IS NULL OR "project_security_settings"."cap_ceiling_cents" BETWEEN 0 AND 100000000)),
	CONSTRAINT "project_security_settings_next_finding" CHECK ("project_security_settings"."next_finding_number" > 0),
	CONSTRAINT "project_security_settings_policy_override" CHECK (("project_security_settings"."policy_override" IN ('inherit', 'always', 'never'))),
	CONSTRAINT "project_security_settings_notice" CHECK (("project_security_settings"."provider_notice_version" IS NULL) = ("project_security_settings"."provider_notice_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "security_finding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scan_id" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_role" text,
	"action" text NOT NULL,
	"resolution" text,
	"comment" text,
	"severity_from" text,
	"severity_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_finding_events_actor_kind" CHECK (("security_finding_events"."actor_kind" IN ('user', 'installation_admin', 'scanner', 'system'))),
	CONSTRAINT "security_finding_events_action" CHECK (("security_finding_events"."action" IN ('created', 'seen_again', 'seen_again_stale', 'severity_changed', 'promoted', 'not_seen', 'resolved', 'reopened', 'commented', 'severity_edited'))),
	CONSTRAINT "security_finding_events_resolution" CHECK (("security_finding_events"."resolution" IS NULL OR ("security_finding_events"."resolution" IN ('fixed', 'false_positive', 'accepted_risk')))),
	CONSTRAINT "security_finding_events_severity_from" CHECK (("security_finding_events"."severity_from" IS NULL OR ("security_finding_events"."severity_from" IN ('critical', 'high', 'medium', 'low', 'informational')))),
	CONSTRAINT "security_finding_events_severity_to" CHECK (("security_finding_events"."severity_to" IS NULL OR ("security_finding_events"."severity_to" IN ('critical', 'high', 'medium', 'low', 'informational')))),
	CONSTRAINT "security_finding_events_comment" CHECK ("security_finding_events"."comment" IS NULL OR char_length("security_finding_events"."comment") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "security_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"fingerprint_key" text NOT NULL,
	"model_fingerprint" text,
	"verdict" text NOT NULL,
	"verdict_source" text DEFAULT 'static' NOT NULL,
	"severity" text,
	"severity_override" text,
	"confidence" text,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"cwe" text,
	"file" text,
	"line_start" integer,
	"line_end" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sink_path" text,
	"sink_content_hash" text,
	"outside_diff" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'scanner' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_sink_hash" text,
	"resolved_severity" text,
	"not_seen_in_latest" boolean DEFAULT false NOT NULL,
	"possible_duplicate_of" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"fix_checked_scan_id" text,
	"first_scan_id" text NOT NULL,
	"last_seen_scan_id" text NOT NULL,
	"first_deployment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_findings_project_number" UNIQUE("project_id","number"),
	CONSTRAINT "security_findings_project_fingerprint" UNIQUE("project_id","fingerprint_key"),
	CONSTRAINT "security_findings_number" CHECK ("security_findings"."number" > 0),
	CONSTRAINT "security_findings_verdict" CHECK (("security_findings"."verdict" IN ('confirmed', 'needs_validation'))),
	CONSTRAINT "security_findings_verdict_source" CHECK (("security_findings"."verdict_source" IN ('static', 'runtime'))),
	CONSTRAINT "security_findings_severity" CHECK (("security_findings"."severity" IS NULL OR ("security_findings"."severity" IN ('critical', 'high', 'medium', 'low', 'informational')))),
	CONSTRAINT "security_findings_severity_override" CHECK (("security_findings"."severity_override" IS NULL OR ("security_findings"."severity_override" IN ('critical', 'high', 'medium', 'low', 'informational')))),
	CONSTRAINT "security_findings_resolved_severity" CHECK (("security_findings"."resolved_severity" IS NULL OR ("security_findings"."resolved_severity" IN ('critical', 'high', 'medium', 'low', 'informational')))),
	CONSTRAINT "security_findings_source" CHECK (("security_findings"."source" IN ('scanner', 'server'))),
	CONSTRAINT "security_findings_state" CHECK (("security_findings"."state" IN ('open', 'resolved'))),
	CONSTRAINT "security_findings_resolution" CHECK (("security_findings"."resolution" IS NULL) = ("security_findings"."state" = 'open') AND ("security_findings"."resolution" IS NULL OR ("security_findings"."resolution" IN ('fixed', 'false_positive', 'accepted_risk')))),
	CONSTRAINT "security_findings_resolved_at" CHECK ("security_findings"."state" = 'open' OR "security_findings"."resolved_at" IS NOT NULL),
	CONSTRAINT "security_findings_counts" CHECK ("security_findings"."reopen_count" >= 0 AND "security_findings"."revision" > 0),
	CONSTRAINT "security_findings_lines" CHECK ("security_findings"."line_start" IS NULL OR "security_findings"."line_end" IS NULL OR "security_findings"."line_end" >= "security_findings"."line_start"),
	CONSTRAINT "security_findings_detail_size" CHECK (octet_length("security_findings"."detail"::text) <= 32768)
);
--> statement-breakpoint
CREATE TABLE "security_memory_rejected" (
	"project_id" text NOT NULL,
	"fingerprint_key" text NOT NULL,
	"reason" text NOT NULL,
	"scan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_memory_rejected_project_id_fingerprint_key_pk" PRIMARY KEY("project_id","fingerprint_key"),
	CONSTRAINT "security_memory_rejected_reason" CHECK (octet_length("security_memory_rejected"."reason") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "security_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" text,
	"scan_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"request_id" text,
	"scan_bypass_id" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "security_notifications_dedupe_key" UNIQUE("dedupe_key"),
	CONSTRAINT "security_notifications_kind" CHECK (("security_notifications"."kind" IN ('findings', 'reopen', 'cap_project', 'cap_platform', 'public_held', 'public_now_public', 'public_canceled', 'scan_bypass', 'streak_project', 'streak_installation', 'digest', 'webhook'))),
	CONSTRAINT "security_notifications_status" CHECK (("security_notifications"."status" IN ('pending', 'sent', 'failed', 'skipped'))),
	CONSTRAINT "security_notifications_project" CHECK ("security_notifications"."kind" = 'webhook' OR ("security_notifications"."project_id" IS NULL) = ("security_notifications"."kind" IN ('cap_platform', 'streak_installation', 'digest'))),
	CONSTRAINT "security_notifications_attempts" CHECK ("security_notifications"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_platform_spend" (
	"month" date PRIMARY KEY NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_nano_usd" bigint DEFAULT 0 NOT NULL,
	"alerted_80_at" timestamp with time zone,
	"alerted_100_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_platform_spend_month" CHECK (EXTRACT(DAY FROM "security_platform_spend"."month") = 1),
	CONSTRAINT "security_platform_spend_nonnegative" CHECK ("security_platform_spend"."spent_nano_usd" >= 0 AND "security_platform_spend"."reserved_nano_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_project_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_role" text,
	"action" text NOT NULL,
	"cap_kind" text,
	"old_cents" integer,
	"new_cents" integer,
	"request_id" text,
	"request_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_project_events_actor_kind" CHECK (("security_project_events"."actor_kind" IN ('user', 'installation_admin', 'system'))),
	CONSTRAINT "security_project_events_action" CHECK (("security_project_events"."action" IN ('cap_changed', 'public_requested', 'public_held', 'public_passed', 'public_canceled', 'scan_bypassed'))),
	CONSTRAINT "security_project_events_cap_kind" CHECK (("security_project_events"."cap_kind" IS NULL OR ("security_project_events"."cap_kind" IN ('own', 'ceiling')))),
	CONSTRAINT "security_project_events_old_cents" CHECK (("security_project_events"."old_cents" IS NULL OR "security_project_events"."old_cents" BETWEEN 0 AND 100000000)),
	CONSTRAINT "security_project_events_new_cents" CHECK (("security_project_events"."new_cents" IS NULL OR "security_project_events"."new_cents" BETWEEN 0 AND 100000000)),
	CONSTRAINT "security_project_events_request_state" CHECK (("security_project_events"."request_state" IS NULL OR ("security_project_events"."request_state" IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy', 'passed', 'bypassed', 'canceled'))))
);
--> statement-breakpoint
CREATE TABLE "security_project_spend" (
	"project_id" text NOT NULL,
	"month" date NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_nano_usd" bigint DEFAULT 0 NOT NULL,
	"scans" integer DEFAULT 0 NOT NULL,
	"alerted_80_at" timestamp with time zone,
	"alerted_100_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_project_spend_project_id_month_pk" PRIMARY KEY("project_id","month"),
	CONSTRAINT "security_project_spend_month" CHECK (EXTRACT(DAY FROM "security_project_spend"."month") = 1),
	CONSTRAINT "security_project_spend_nonnegative" CHECK ("security_project_spend"."spent_nano_usd" >= 0 AND "security_project_spend"."reserved_nano_usd" >= 0 AND "security_project_spend"."scans" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_public_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"state" text NOT NULL,
	"held_reason" text,
	"requested_by_user_id" text,
	"requested_via" text NOT NULL,
	"target_deployment_id" text NOT NULL,
	"gate_scan_id" text,
	"blockers" integer DEFAULT 0 NOT NULL,
	"blocker_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"cancel_cause" text,
	"closed_by_user_id" text,
	"closed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_public_requests_state" CHECK (("security_public_requests"."state" IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy', 'passed', 'bypassed', 'canceled'))),
	CONSTRAINT "security_public_requests_requested_via" CHECK (("security_public_requests"."requested_via" IN ('project', 'admin', 'operator'))),
	CONSTRAINT "security_public_requests_cancel_cause" CHECK (("security_public_requests"."cancel_cause" IS NULL) = ("security_public_requests"."state" <> 'canceled') AND ("security_public_requests"."cancel_cause" IS NULL OR ("security_public_requests"."cancel_cause" IN ('protect', 'gate_off', 'policy_off')))),
	CONSTRAINT "security_public_requests_closed" CHECK (("security_public_requests"."closed_at" IS NULL) = ("security_public_requests"."state" IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy'))),
	CONSTRAINT "security_public_requests_blockers" CHECK ("security_public_requests"."blockers" >= 0),
	CONSTRAINT "security_public_requests_revision" CHECK ("security_public_requests"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "security_scan_bypasses" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"request_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_role" text,
	"reason" text NOT NULL,
	"request_state" text NOT NULL,
	"held_reason" text,
	"gate_scan_id" text,
	"blockers" integer DEFAULT 0 NOT NULL,
	"blocker_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_scan_bypasses_actor_kind" CHECK (("security_scan_bypasses"."actor_kind" IN ('user', 'installation_admin'))),
	CONSTRAINT "security_scan_bypasses_reason" CHECK (char_length("security_scan_bypasses"."reason") BETWEEN 1 AND 4000),
	CONSTRAINT "security_scan_bypasses_request_state" CHECK (("security_scan_bypasses"."request_state" IN ('waiting_scan', 'held_no_result', 'needs_deploy'))),
	CONSTRAINT "security_scan_bypasses_blockers" CHECK ("security_scan_bypasses"."blockers" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"deployment_id" text,
	"base_deployment_id" text,
	"base_scan_id" text,
	"status" text NOT NULL,
	"status_reason" text,
	"failure_cause" text,
	"error_class" text,
	"refusal_category" text,
	"superseded_by_scan_id" text,
	"trigger" text NOT NULL,
	"public_request_id" text,
	"tier" text,
	"coverage" text,
	"coverage_notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"backlog_files" integer DEFAULT 0 NOT NULL,
	"dropped_files" integer DEFAULT 0 NOT NULL,
	"dropped_bytes" bigint DEFAULT 0 NOT NULL,
	"files_scanned" integer DEFAULT 0 NOT NULL,
	"input_bytes" bigint DEFAULT 0 NOT NULL,
	"input_prefix" text,
	"input_r2_key" text,
	"ledger_summary" jsonb,
	"model_requested" text,
	"model_used" text,
	"engine" text,
	"engine_version" text,
	"skill_commit" text,
	"policy_mode_at_enqueue" text,
	"public_at_enqueue" boolean,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_nano_usd" bigint,
	"metered_nano_usd" bigint DEFAULT 0 NOT NULL,
	"reserved_nano_usd" bigint DEFAULT 0 NOT NULL,
	"summary" text,
	"first_queued_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_scans_status" CHECK (("security_scans"."status" IN ('pending_input', 'queued', 'running', 'succeeded', 'incomplete', 'failed', 'refused', 'timed_out', 'superseded', 'skipped', 'canceled'))),
	CONSTRAINT "security_scans_trigger" CHECK (("security_scans"."trigger" IN ('deploy', 'recovery', 'exposure', 'rescan', 'gate', 'local', 'sweep', 'backfill', 'fallback'))),
	CONSTRAINT "security_scans_deployment" CHECK ("security_scans"."deployment_id" IS NOT NULL OR "security_scans"."trigger" = 'local'),
	CONSTRAINT "security_scans_failure_cause" CHECK (("security_scans"."failure_cause" IS NULL OR ("security_scans"."failure_cause" IN ('installation', 'project')))),
	CONSTRAINT "security_scans_tier" CHECK (("security_scans"."tier" IS NULL OR ("security_scans"."tier" IN ('source_diff', 'built_diff', 'full')))),
	CONSTRAINT "security_scans_coverage" CHECK (("security_scans"."coverage" IS NULL OR ("security_scans"."coverage" IN ('complete', 'partial')))),
	CONSTRAINT "security_scans_engine" CHECK (("security_scans"."engine" IS NULL OR ("security_scans"."engine" IN ('void_loop', 'agent_sdk', 'codex_sdk')))),
	CONSTRAINT "security_scans_policy_mode" CHECK (("security_scans"."policy_mode_at_enqueue" IS NULL OR ("security_scans"."policy_mode_at_enqueue" IN ('disabled', 'public', 'all')))),
	CONSTRAINT "security_scans_running_lease" CHECK ("security_scans"."status" <> 'running' OR "security_scans"."lease_until" IS NOT NULL),
	CONSTRAINT "security_scans_counts" CHECK ("security_scans"."attempt" >= 0 AND "security_scans"."backlog_files" >= 0 AND "security_scans"."dropped_files" >= 0 AND "security_scans"."dropped_bytes" >= 0 AND "security_scans"."files_scanned" >= 0 AND "security_scans"."input_bytes" >= 0 AND "security_scans"."model_calls" >= 0 AND "security_scans"."tokens_in" >= 0 AND "security_scans"."tokens_out" >= 0 AND "security_scans"."metered_nano_usd" >= 0 AND "security_scans"."reserved_nano_usd" >= 0 AND ("security_scans"."cost_nano_usd" IS NULL OR "security_scans"."cost_nano_usd" >= 0)),
	CONSTRAINT "security_scans_ledger_size" CHECK ("security_scans"."ledger_summary" IS NULL OR octet_length("security_scans"."ledger_summary"::text) <= 8192),
	CONSTRAINT "security_scans_summary_size" CHECK ("security_scans"."summary" IS NULL OR octet_length("security_scans"."summary") <= 16384)
);
--> statement-breakpoint
ALTER TABLE "project_security_settings" ADD CONSTRAINT "project_security_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_finding_events" ADD CONSTRAINT "security_finding_events_finding_id_security_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."security_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_finding_events" ADD CONSTRAINT "security_finding_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_memory_rejected" ADD CONSTRAINT "security_memory_rejected_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_notifications" ADD CONSTRAINT "security_notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_project_events" ADD CONSTRAINT "security_project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_project_spend" ADD CONSTRAINT "security_project_spend_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_public_requests" ADD CONSTRAINT "security_public_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scan_bypasses" ADD CONSTRAINT "security_scan_bypasses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scan_bypasses" ADD CONSTRAINT "security_scan_bypasses_request_fk" FOREIGN KEY ("request_id") REFERENCES "public"."security_public_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_scans" ADD CONSTRAINT "security_scans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_security_finding_events_project_created" ON "security_finding_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_finding_events_finding_created" ON "security_finding_events" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_findings_urgent" ON "security_findings" USING btree ("project_id") WHERE "security_findings"."verdict" = 'confirmed' AND COALESCE("security_findings"."severity_override", "security_findings"."severity") IN ('critical', 'high') AND "security_findings"."state" = 'open';--> statement-breakpoint
CREATE INDEX "idx_security_findings_project_state" ON "security_findings" USING btree ("project_id","state","number");--> statement-breakpoint
CREATE INDEX "idx_security_memory_rejected_project_created" ON "security_memory_rejected" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_notifications_due" ON "security_notifications" USING btree ("next_attempt_at") WHERE "security_notifications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_security_notifications_project_created" ON "security_notifications" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_project_events_project_created" ON "security_project_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "security_public_requests_open_project" ON "security_public_requests" USING btree ("project_id") WHERE ("security_public_requests"."state" IN ('waiting_scan', 'held_findings', 'held_no_result', 'needs_deploy'));--> statement-breakpoint
CREATE INDEX "idx_security_public_requests_state_updated" ON "security_public_requests" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_security_public_requests_project_created" ON "security_public_requests" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_scan_bypasses_created" ON "security_scan_bypasses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_security_scan_bypasses_project_created" ON "security_scan_bypasses" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_security_scan_bypasses_request" ON "security_scan_bypasses" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_security_scans_project_status_finished" ON "security_scans" USING btree ("project_id","status","finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "security_scans_running_project" ON "security_scans" USING btree ("project_id") WHERE "security_scans"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_security_scans_waiting" ON "security_scans" USING btree ("status","first_queued_at") WHERE ("security_scans"."status" IN ('pending_input', 'queued', 'running'));--> statement-breakpoint
CREATE INDEX "idx_security_scans_input_hold" ON "security_scans" USING btree ("input_prefix") WHERE "security_scans"."input_prefix" IS NOT NULL AND ("security_scans"."status" IN ('pending_input', 'queued'));--> statement-breakpoint
CREATE INDEX "idx_security_scans_deployment" ON "security_scans" USING btree ("project_id","deployment_id");