---
title: Security audits on deploy
status: planned
created: 2026-11-18
---

# Security audits on deploy

Plan for building the approved PRD, all three phases, in one PR with one commit
per milestone. Product rules, copy and the 94 edge cases stay in the PRD and spec;
this file says where the code goes, in what order, and how we test it.

- PRD: `void-prds/security-audits-prd.md` (short), spec: `void-prds/security-audits-spec.md`.
  Decision numbers D1–D52 and Q1–Q15 come from there.
- Background: [project Zero Trust](./0083-project-zero-trust.md),
  [managed Sandbox restoration](./0082-managed-sandbox-restoration.md),
  [operator CLI](./0078-platform-operator-cli.md),
  [permission errors](./0081-project-permission-errors.md),
  [installation plans](./0090-installation-plans.md),
  [AI Gateway logging policy](./0094-ai-gateway-logging-policy.md).
- The spec calls this doc `0094-security-audits.md`; 0094 is taken, so it is 0095.

## Contract (short)

- A deploy that reaches `live` writes a scan row in the same transaction. The scan
  runs later, in a container with no internet. Scans never block, slow or fail a
  deploy (D45).
- Open `confirmed` + `critical`/`high` findings are urgent. Only humans resolve.
- With "Scan before a project goes public" on, a protected project asked to go
  public stays protected until a scan of its live deployment passes, or someone
  bypasses the scan while no urgent finding is open (D46).
- Capability off: the install is the same as today, except the idle
  `SecurityScanScheduler` DO class in the API Worker.
- Native `void deploy --platform cloudflare` does not change at all.

## Architecture

```
                         ┌──────────────────────────── API Worker (trusted) ─────────────────────────────┐
 void deploy ──► admit ─►│ pipeline ─► commitCutoverLive tx ──► security_scans(pending_input)  [outbox]   │
 (CLI / CI / build)      │                │ after commit: copy inline files to R2, row → queued, poke    │
                         │                ▼                                                               │
                         │  SecurityScanScheduler DO (singleton 'global')                                 │
                         │    round-robin by owner · concurrency · @cf token bucket                       │
                         │    reserve budget (spend rows) · lease + attempt · notifications outbox sender │
                         │                │ start(scanId, attempt, engine, image)                         │
                         │                ▼                                                               │
                         │  SecurityScanControl (WorkerEntrypoint, RPC only, no HTTP route)               │
                         │    input(scan, attempt) → tar stream (tier, filters, redaction, memory)        │
                         │    model(scan, attempt, request) → model proxy                                 │
                         │    heartbeat / result(scan, attempt, findings.json) → ingest (one tx)          │
                         │                                                                                │
                         │  model proxy: allowlist · caps (UPDATE…RETURNING) · fixed gateway headers ─────┼──► AI Gateway
                         │               signed {"securityScan":tag} · access_programs for openai/*       │     (installation gateway)
                         │                                                                                │     @cf: env.AI binding
                         │  policy (platform_settings) · public gate (ZT checkpoint) · findings · budget  │     3rd party: REST /ai/v1/*
                         │  routes: /projects/:id/security* · /operator/v1/security* · /admin/security    │
                         │          /security/projects/:slug (signed page) · hourly cron jobs             │
                         └───────────────▲───────────────────────────────┬───────────────────────────────┘
                                         │ service binding (props = identity)  ▲ email (env.EMAIL)
 ┌──────── void-security-scanner controller Worker (ours) ────────┐     │     │
 │ ScannerController DO, one instance per scan id                  │─────┘     └── owner, admins, deploy authors,
 │   interceptOutboundHttp('model.void.internal', ScanModelOutbound)│               installation admins
 │   interceptAllOutboundHttp(DenyAll)                              │
 │   start({enableInternet:false, env: no tokens})                  │
 │   write input · exec runner (non-root) · poll /scan/out · alarm  │
 └──────────────┬──────────────────────────────────────────────────┘
                ▼
 ┌──────── scanner container (untrusted) ─────────┐        PostgreSQL (Hyperdrive)
 │ Void runner: hunt → verify (≤10) → findings    │          platform_settings['securityAudits.policy']
 │  A anthropic/*  Claude Agent SDK               │          project_security_settings, security_scans,
 │  C openai/*     Codex SDK + void-scan MCP      │          security_findings, security_finding_events,
 │  B @cf/*        Void tool loop                 │          security_public_requests, security_scan_bypasses,
 │ http://model.void.internal/* only              │          security_*_spend, security_notifications, …
 └────────────────────────────────────────────────┘
                                                            R2 STATIC_ASSETS_R2 (existing bucket)
 CLI: void project security · zero-trust bypass ·             security-scans/{project}/{deployment}/   inputs
      deploy notice · void platform security                  security-scans/{project}/backlog.json
 Admin: /admin/security · Project detail · Zero Trust page    security-scans/{project}/scans/{scan}/   raw, 30 d
```

Main choices (spec text says the same promise another way; flagged in Risks):

| Choice                                                                                     | Why                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecurityScanControl` RPC entrypoint, not `/internal/security-scans/*` HTTP                | Same as `SandboxControl`: identity comes from immutable binding `props`, nothing on the API hostname, no Access allowlist entry                                                                             |
| API builds the input and streams it to the controller                                      | Redaction needs project secrets; the controller and container get no R2, DB or secret                                                                                                                       |
| `@cf/*` through `env.AI.run`, third-party through REST `/ai/v1/*` with `cf-aig-gateway-id` | No new token permission for the default model; REST only when a third-party host is used (probe check 5 reports a missing permission). S10 can move `@cf` to REST if the binding ignores the payload header |
| Scheduler DO in the API Worker, scanner in a separate controller Worker                    | Losing Containers never breaks API upgrades (spec §5.1)                                                                                                                                                     |
| One installation-wide controller Worker + container app                                    | Created at first move away from `disabled`, verified by the probe                                                                                                                                           |

## Package and file layout

New code (paths from repo root):

```
packages/platform/src/
  security-models.ts            model list, engines, hosts, badges, prices, reserves  → @void/platform/security-models
  security-policy.ts            policy type, defaults, parser, limits ranges, copy keys → @void/platform/security-policy
platform/packages/security-scanner/          @voidcloud/security-scanner (private, new workspace package)
  src/runner/{main,phases,extract,status,validate-findings}.ts
  src/runner/engines/{void-loop,claude,codex}.ts
  src/runner/tools/fs.ts        read_file / list_files / grep, realpath under /scan, no symlinks
  src/runner/mcp/void-scan.ts   stdio MCP server, 4 tools (Engine C)
  src/self-test.ts              probe checks 2–3 inside the container
  skill/                        vendored skill + LICENSE, Void Workers companion, deploy-diff profile, report-schema.json
  config/codex/{config.toml,requirements.toml,model_catalog.json}, config/claude/managed-settings.json
  image/{Dockerfile.claude,Dockerfile.codex,package.json,pnpm-lock.yaml,codex-wrapper.sh,NOTICE}
  test/fake-model/server.ts     scripted Anthropic SSE, Responses SSE, chat completions
  test/unit/*.test.ts
  vite.config.ts / package.json (vp pack → dist/runner.mjs)
platform/packages/api/src/security/
  schema.ts                     drizzle tables, re-exported from src/schema.ts
  policy.ts                     lenient + strict readers, CAS write, preview builders
  models.ts                     "which model runs" resolver, notice checks
  enqueue.ts                    enqueueSecurityScanInTx, coalesce, after-commit copy + poke, input hold check
  scheduler.ts                  SecurityScanScheduler DO
  control.ts                    SecurityScanControl WorkerEntrypoint (input / model / heartbeat / result)
  input/{tier,t2,t1,filters,third-party,redact,phrase-check,memory,backlog,tar}.ts
  model-proxy.ts                allowlist, caps, headers, SSE metering, failure reasons
  budget.ts                     ceilings, reserve, per-call check, month math, alerts
  ingest.ts, findings.ts        validate (zod), fingerprint, state machine, reopen, F-numbers
  public-gate.ts                request store, judge, re-check, bypass, cancel, backstop
  notifications.ts, recipients.ts
  page-token.ts                 15-min signed page link
  maintenance.ts                hourly jobs (re-poke, reaper, backlog skip, sweeps, probe, exposure)
  probe.ts                      checks 1–6
  errors.ts                     typed errors → status + code
platform/packages/api/src/
  provisioning/security-scanner.ts           provision / verify / delete controller Worker + container app
  security-scanner-controller-runtime.ts     controller Worker source (DO, outbound entrypoints)
  security-scanner-controller-source.ts      reads the alias
  scripts/build-security-scanner-controller.mjs   (under platform/packages/api/scripts/)
  routes/project-security.ts, routes/security-page.ts
  operator/security-routes.ts
  admin/routes/security.tsx
  admin/react/views/{SecurityPage,SecurityFindingsPage,SecurityScansPage,SecurityPublicRequestsPage,ProjectSecuritySection,AdminBanner}.tsx
packages/void/src/cli/
  project-security.ts, deploy-security-notice.ts, platform-security-audits.ts (runtime guard)
platform/scripts/
  security-spike-*.ts + fixtures/security-seeded-apps/   (Phase 0, below)
```

Edited (main touch points; file:line refs are in the four maps kept with the PRD):

- Capability: `packages/platform/src/{manifest,discovery,worker-config,installer}.ts`,
  `packages/platform/scripts/build-runtime.mjs`, `platform/packages/api/src/capabilities.ts`,
  `platform/packages/proxy/src/capabilities.ts`, `platform/packages/api/wrangler.jsonc`,
  `platform/packages/api/src/{env,index}.ts`, `src/worker/index.ts`.
- Deploy: `deploy/{recovery,execute,compensate,publish-worker,publish-static}.ts`,
  `deployment-execution.ts`, `assets.ts`, `provisioning/cleanup.ts`, `routes/projects.ts` (rollback).
- Zero Trust: `zero-trust/{project,operation,installation,maintenance}.ts`,
  `routes/project-zero-trust.ts`, `operator/zero-trust-routes.ts`, `admin/routes/{zero-trust,projects}.tsx`.
- Shared: `email.ts`, `operator/{index,audit}.ts`, `admin/react/views/{Layout,ProjectDetailPage,ProjectZeroTrustSection,ZeroTrustPage}.tsx`,
  `admin/react/{pages,server}.ts`, `admin/fate/{page-server,page-data,render,views}.ts` (+ regenerated `client.generated.ts`),
  `api.ts` (typed routes for the dashboard), `test/integration/helpers.ts`, `vite.config.ts`, root `.dockerignore`,
  `.github/workflows/platform-ci.yml`, `pnpm-workspace.yaml` (nothing: `platform/packages/*` is already a glob).
- CLI: `project-{args,cmd,zero-trust}.ts`, `list.ts`, `client.ts`, `platform-errors.ts`, `help.ts`, `cli-main.ts`,
  `deploy-managed-{full,static,framework}.ts`, `operator-{args,cmd}.ts`, `platform-{args,lifecycle,setup,management,plan,teardown}.ts`.

## Milestones

One PR, one commit per milestone, in this order. Each commit passes
`vp check` and the exact test files it adds. "Exit" is the check that ends it.

```
P1  M1 cap+DO ─► M2 shared types ─► M3 schema ─► M4 policy ─► M6 controller+probe ─► M7 model proxy+budget
                                         │             └────────────► M5 runner (no deps) ─┘        │
                                         ├─► M8 outbox+hold ─► M9 scheduler+cron ─► M10 input ─► M11 T1
                                         │                                              └─► M12 ingest ─► M13 engines A/C
                                         └─► M14 project API ─► M15 email ─► M16 public gate ─► M17 operator
                                             M18 admin ─► M19 page ─► M20–M23 CLI ─► M24 docs
P2  M25 rescan/backfill/sweeps · M26 fallback+streaks+digest · M27 plan caps · M28 GitHub check
    M29 page forms + dashboard · M30 runtime copy · M31 secret findings, client assets, SARIF, webhooks
P3  M32 local check · M33 BYOK · M34 per-project policy · M35 severity edits · M36 final docs + full suite
```

### Phase 1 (MVP)

**M1 Capability, scheduler DO class, config.**

- Scope: optional `securityAudits` in all parsers (missing = false, non-boolean = error);
  `HOSTED_CAPABILITIES.securityAudits = false`; manifest writes `schemaVersion: 7` when true
  (v7 allows `storageLocationHint`/`runtimeLogs` absent) so an old CLI refuses instead of
  dropping it; `PlatformRuntimeManifest.securityAudits: 1`. `SecurityScanScheduler` stub
  (answers `/poke`, alarm no-op) exported from `src/worker/index.ts` and `src/index.ts`.
  `worker-config.ts`: DO binding + `{tag:'security-audits-v1', new_sqlite_classes:['SecurityScanScheduler']}`
  always; `ai:{binding:'AI'}` on the API Worker only when the capability is on. Hosted
  `wrangler.jsonc`: binding ×3 blocks, tag after v6 (sqlite). `env.ts`: `SECURITY_SCAN_SCHEDULER`, `AI?`.
- Tests (unit): `platform/packages/api/test/unit/capabilities.test.ts`,
  `packages/platform/test/unit/{worker-config,auth-discovery,auth-manifest}.test.ts`
  (old documents parse, v7 round-trip, v6 parser refuses v7),
  `platform/packages/api/test/unit/{platform-worker-config,hosted-config}.test.ts`,
  `platform/packages/api/test/unit/security-scheduler-stub.test.ts`.
- Exit: capability off → config diff is exactly the DO binding + tag; worker keys still
  `[api, dispatch, emailGateway, proxy, tail]`.
- As built: the DO binding + tag follow the runtime manifest (`securityAudits: 1`,
  input `securityScanScheduler`), not the capability, so a new CLI can still deploy an
  older runtime that has no such class. `PLATFORM_CAPABILITIES` leaves out
  `securityAudits` while it is off (`serializePlatformCapabilities`), so the vars are
  unchanged. The proxy never reads this capability, so `proxy/src/capabilities.ts` is
  unchanged.
  `assertPlatformRollbackCompatibility` refuses a rollback to a runtime without
  `securityAudits: 1` when the installed runtime has it or the capability is on, and says
  to roll forward (R2). `readPlatformCapability` in `@void/platform` is the one place that
  reads a missing optional capability as `false` (manifest, discovery, API). Deployment
  schema version 7 and the capability must go together; later versions may carry it too.
  Extra tests: `packages/void/test/unit/{platform-rollback,platform-installer}.test.ts`.

**M2 Shared model list and policy types.**

- Scope: `security-models.ts` (6 models, engine, host, badges, $/M, reserve =
  1.2M×in + 120k×out, notice version, provider names); `security-policy.ts` (type,
  defaults, strict parser, ranges, error code strings shared by API and CLI). Sonnet
  price: see Risks R6. New package exports in `packages/platform/package.json`.
- Tests (unit): `packages/platform/test/unit/security-models.test.ts` (every model has a
  price; reserves match spec §16.1 table; ids use catalog spelling),
  `packages/platform/test/unit/security-policy.test.ts`.
- Exit: API and CLI import one list.
- As built: Sonnet has `price: null`. "Every model has a price" holds for the five
  priced models; the policy parser refuses an unpriced default, and the M4/M14 pickers
  treat `isSecurityModelPriced() === false` as blocked (R6). Costs are kept in whole
  nano-dollars per token so metered sums do not drift. The spec gives ranges only for
  concurrency (1–10) and timeout (5–60); ours for the rest: `maxInputTokens`
  50k–2M, `maxOutputTokens` 5k–200k, `modelCallsPerScan` 10–200, caps $0–$1,000,000 in
  whole cents. The strict parser needs every known field, checks cross-field rules
  (default not blocked, priced, third-party default needs the notice, gate needs mode
  `public`/`all`) and ignores unknown fields; probe check names in
  `entitlement.missing` stay open text so a later probe still reads. The strict
  `parseSecurityPolicy` guards writes; the stored row is read with `readSecurityPolicy`,
  which survives an upgrade or rollback: unknown blocked ids are dropped, an unknown,
  unpriced or blocked default becomes the first non-blocked priced `@cf` model (spec
  edge case 23), limits are clamped into range. Otherwise one model change would make
  the whole policy unreadable (Off, or 503 with the public gate on). Runtime
  conditions (fresh probe, Zero Trust state) stay with the API writes (M4, M16). The
  provider notice text lives next to `SECURITY_PROVIDER_NOTICE_VERSION`. Exports
  also go in the `vp pack` entry list (`packages/platform/vite.config.ts`).

**M3 Schema and migration 0065.**

- Scope: all Phase 1 tables in `src/security/schema.ts` (spec §14). Project FKs cascade;
  no FK to deployments; `actor_user_id` no FK. Partial uniques: running scan per project,
  open request per project. F-numbers from `project_security_settings.next_finding_number`
  under the project lock. `security_notifications` gets `attempts`, `next_attempt_at`.
  Phase 2/3 columns that are cheap to add now are added now (one migration, see M25+):
  `security_scans.deployment_id` nullable + `trigger` incl. `local`/`sweep`/`backfill`/`fallback`,
  `security_findings.verdict_source static|runtime`, `severity_override`,
  `project_security_settings.policy_override`. Generate with `vp run --filter @voidcloud/api db:generate`.
- Data: `drizzle/0065_security_audits.sql`, `meta/0065_snapshot.json`, journal entry.
  `compatibility.json` edge added only after the old-runtime check (schema-ci guide).
- Tests: `platform/packages/api/test/unit/security-migration.test.ts` (PGlite; add to
  `pgliteUnitTests` in `vite.config.ts`); `test/integration/api-delete.test.ts` gains a
  case: project with scans, findings, requests, spend deletes cleanly; `clearTables`
  adds `security_platform_spend`, `security_notifications`.
- Exit: template DB rebuilds; project delete cascade test passes.
- As built: 11 tables, re-exported from `src/schema.ts`. Money is in whole units, not
  `numeric` USD, to match M2: spend, reserves and costs in nano-dollars (`*_nano_usd`,
  `bigint`), caps in cents (`*_cents`, `integer`, 0–100,000,000). `month` is a `date`
  with a first-of-month check (`EXTRACT(DAY …) = 1`, which does not depend on the session
  time zone). Status, trigger, state and kind lists are `CHECK`s built from exported TS
  lists in the same file; the migration test checks that the mode list, the engine list
  and the max cap match M2's `SECURITY_MODES`, `SecurityEngine` and
  `SECURITY_MAX_MONTHLY_USD`. A bypass row's `request_state` is limited to
  `waiting_scan`, `held_no_result` and `needs_deploy` (D50). The urgent index uses
  `COALESCE(severity_override, severity)` so M35 needs no new index. Extra, not in
  spec §14: `next_finding_number`, `policy_override` (default `inherit`), `created_at`
  on scans, a waiting-scan index and an input-hold index (M8/M9), `severity_edited` in
  the event actions (M35), `project_id` FK on finding events, PK
  `(project_id, fingerprint_key)` on `security_memory_rejected`. The bypass → request
  FK is `NO ACTION`: retention cannot delete a request a bypass points to, while a
  project delete still removes both. `security_notifications.project_id` cascades and
  is `NULL` only for `cap_platform`. `compatibility.json` is unchanged (old-runtime
  check first).

**M4 Policy store and operator policy routes.**

- Scope: `security/policy.ts` lenient reader (bad data → `disabled` + `console.error`),
  strict reader (`SecurityPolicyUnreadableError` → 503), CAS by `revision`. Operator
  `GET/POST /operator/v1/security/policy` (mode, default model, blocked models, notice,
  limits) with dryRun preview text (spec §5.4); `GET /security/status`. Mode change to
  Off also cancels queued scans (after M9) and turns the gate off (after M16). Audit
  targets for every path (ids + new state only).
- Tests: unit `security-policy-store.test.ts`; integration `operator-security-policy.test.ts`
  (CAS 409, preview counts, 501 when capability off, entitlement missing 409),
  `operator-audit.test.ts` (new targets).
- Exit: policy round-trips; nothing turns on without a fresh probe.
- As built: `security/policy.ts` + `security/errors.ts` (`SecurityApiError`, mapped to
  `OperatorError` by `operator/security-routes.ts`). The routes are
  `/operator/v1/security/{policy,status}`. Every policy writer takes the advisory lock
  `void:platform:security-policy`, then checks `expectedRevision` (409
  `revision_conflict`, like plans) and writes `revision + 1`. A preview takes the
  revision optionally and returns the one to send. Extra fields such as `missing[]` sit in
  `details`, the way every operator error does. Bad stored data reads as Off and keeps its
  revision, so an operator write can replace it (the preview says so). Body:
  `mode`, `defaultModel`, `blockedModels` (full list, admin panel) or `block`/`unblock`
  (CLI), `acceptProviderNoticeVersion` (must equal the current notice version), `limits`
  (patch). Unknown fields get a 400. A third-party default needs its host to pass probe check 5
  and the current notice; blocking the default and unpriced models get 422 `security model
  not allowed`. `publicGate: true` gets a 400 until M16. Off cancels `pending_input` and
  `queued` scans in the same transaction (`status_reason 'policy_off'`); the tables exist
  since M3, so this did not wait for M9. All → Public does not cancel queued protected
  scans: the scheduler (M9 scope) checks protection when it claims a scan. The "re-run the probe in
  set mode" step (spec §5.2) comes with the probe (M6 scope); until then a stored pass less than
  24 h old is required. GET policy and status work with the capability off; only POST
  answers 501. Status failure rate = `failed|refused|timed_out|incomplete` out of those plus
  `succeeded`, finished in the last 24 h.

**M5 Scanner runner package (Engine B first).**

- Scope: new `platform/packages/security-scanner`. `task.json` → phases (1 hunt, ≤10
  verify, 1 repair turn) → `/scan/out/findings.json` + `status.json`. Engine B loop
  (chat-completions messages, 4 tools, 40 turns). Safe tar extract (regular files only,
  reject symlink, `..`, absolute). Hand-written validator (≤5 MiB, ≤1000 records, no
  regex). Status mapping per engine. Base URL `http://model.void.internal`. Engine
  interface so A/C plug in at M13. Real SDKs are **not** workspace deps (see Test strategy).
- Tests (unit, `platform/packages/security-scanner/test/unit/`): `void-loop.test.ts`
  (fake model server), `fs-tools.test.ts` (temp dirs: symlink, `..`, big file),
  `extract.test.ts`, `validate-findings.test.ts`, `status.test.ts`, `phases.test.ts`.
- Exit: `dist/runner.mjs` built by `vp pack`; Engine B passes on the fake model.
- As built: the runner has no runtime dependency (63 kB, Node built-ins only). The
  controller (M6) starts `node runner.mjs --stdin-tar [--root /scan]` and streams the
  input tar on stdin (S1: short argv). The tar may hold only `task.json`, `input/**`
  and `memory/**`; any symlink, link, device, `..`, absolute path or duplicate refuses
  the whole input (`failed`, `error_class: input_invalid`). Of pax records only
  `path` and `size` are decoded; others (binary `SCHILY.xattr.*`) are skipped. Paths
  with a control character are refused in the tar, `changed_files` and the report,
  and the hunt prompt lists changed files as JSON strings. Files are written with
  `O_EXCL|O_NOFOLLOW`, mode 0444. `findings.json` is written first, then
  `status.json` is renamed into place whole, so the controller polls one file. Exit
  0 means `status.json` exists; SIGTERM writes `timed_out (wall_clock)`, also while
  the tar is still coming in (stdin is closed then, and after the tar). Model calls
  go to `POST http://model.void.internal/v1/chat/completions` with no credentials;
  M7 must answer a stop with a non-2xx status and `x-void-scan-stop:
  session_calls|scan_calls|tokens|budget|credits` (a bare 402 = credits); any other
  failure (other non-2xx, network error, unreadable body) is retried once, then
  `failed (infrastructure)`. The last allowed turn tells the model to submit now. Tools read only
  `/scan/input` and `/scan/memory`; relative paths mean `/scan/input`; `grep` is
  plain text (no regex). The verify phase keeps the hunt fingerprint, an empty
  verify answer rejects the candidate, and candidates past `max_verify` stay leads
  (confirmed needs the second session). The one repair turn is shared by a bad
  report and a plain-text answer. `status.ts` also maps Engine A/C signals (§8.4)
  so M13 only feeds them; S2/S3 confirm the wording. Deviations: the upstream
  skill at `c1c8a8c` is not in the repo, so the prompts are Void's own
  (`prompts.ts`: trust rule, verdicts, severity scale, Workers checks) and the
  report schema is ours (`report.ts`); vendoring the skill and its
  `report-schema.json` contract test move to M13 with `skill/`. `task.json` is
  defined here (M10 builds it): `version`, `scan_id`, `attempt`, `engine`, `model`,
  `tier`, `changed_files`, optional `limits`. Extra test file: none; `task.json`
  cases live in `phases.test.ts`, the CLI tar path in `void-loop.test.ts`.

**M6 Controller Worker, provisioning, probe.**

- Scope: `security-scanner-controller-runtime.ts` (DO per scan id; register model
  intercept then `DenyAll`; `start({enableInternet:false})`; stream input tar into the
  container; exec runner as `scanner`; poll result files; alarm at wall clock and hard
  cap; destroy after result). Build script + alias `void:security-scanner-controller-source`
  in `wrangler.jsonc`, `scripts/build-worker.mjs`, `packages/platform/scripts/build-runtime.mjs`,
  `vite.config.ts` mock. Runner bundle embedded for the managed image (Engine B, image
  option C). `provisioning/security-scanner.ts` (copy of `sandbox-controller.ts`: upload
  with `If-None-Match:*`, ownership marker, service binding to `SecurityScanControl`
  with props, `containers[]`, workers.dev off, container app create/find/verify, delete
  app then Worker). Name derived per installation. `SecurityScanControl` entrypoint
  with `heartbeat` (fenced). `security/probe.ts` checks 1–6 + operator `POST /security/probe`.
  Re-run the probe inside the policy change that leaves `disabled` (spec §5.2); this
  replaces the 24 h stored-pass check in `assertEntitlement` (`security/policy.ts`).
  Daily probe hook comes in M9.
- Tests: unit `security-scanner-controller-runtime.test.ts` (mocked `ctx.container`
  with `interceptOutbound*`: order, `enableInternet:false`, env has no token, alarm kill,
  stale attempt refused, two scans never share an instance id — edge #42),
  `security-scan-control.test.ts`; integration `api-security-provisioning.test.ts`
  (`mockCfApi` containers state: create, reuse, ownership mismatch, delete order),
  `operator-security-probe.test.ts` (each failing check copy; Off → on runs the probe
  and a failing check refuses the change).
- Exit: probe reports all six checks against fakes.
- As built: the plan did not say how the API calls the controller. A service binding
  from the API Worker cannot point at a Worker that does not exist yet (the deploy
  fails), and the controller is created only at turn-on. So `provisionSecurityScanner`
  also uploads a gate script into the platform dispatch namespace
  (`void-security-scanner-gate-<hash>`, one service binding `SCANNER` → the
  controller, no logic, no secret). The API calls `env.DISPATCH.get(gate).fetch(…)`:
  `POST /v1/scans/start | /v1/scans/cancel | /v1/self-test`. The controller keeps
  workers.dev off; nothing is on a public hostname and the installer config is
  unchanged. Names are `void-security-scanner[-gate]-<12 hex of sha256(installation
  id)>` (Worker and container app share one name). Unlike Sandbox controllers, this one
  is shared and is re-uploaded (no `If-None-Match`, no repeated migration) when a
  platform release ships a new bundle (`__VOID_SECURITY_SCANNER_SOURCE` digest).
  The control binding's props are `{protocol: 1, installation}`; `SecurityScanControl`
  refuses any other caller and everything while the capability is off.
  `heartbeat` is the fence (current attempt, `running`, lease not past, project not
  `deleting` → `ok`, else `stale` or `canceled`); `input`, `model` and `result` are
  present but refuse until M10, M7 and M12. One Durable Object per attempt
  (`scan:<id>:<attempt>`) or probe (`probe:<id>`), so an instance is never reused,
  and a start is accepted once. The start runs in the alarm: fence check first (a
  stale attempt never starts a container), then the S1 egress lock (model host
  intercept → all HTTP deny → all HTTPS deny), `start({image:
  'cloudflare/debian-trixie', enableInternet: false, env: {}})`, a root setup step
  (`useradd scanner`, `/scan` 0700, runner from stdin to
  `/opt/void-scanner/runner.mjs` 0555), then the runner as `user: 'scanner'` with
  the input tar piped to stdin. Alarms every 10 s: fence, read
  `/scan/out/status.json` (then `findings.json`, at most 5 MiB + 1 byte) as
  `scanner` with a 30 s limit (a short `node -e` reader: `/scan/out` must be a real
  directory, the file is opened `O_NOFOLLOW|O_NONBLOCK` and must be a regular file; a
  refused `status.json` reports `failed (bad_output)` with no findings), hand both to
  `result`, destroy. Every exec gets `env: {PATH, HOME=/scan}` and nothing else. At the wall clock: `kill -TERM`, 60 s
  grace, then `timed_out (wall_clock)`; at the hard cap: `timed_out (hard_cap)`. The
  container stays until `result` accepts, so nothing large is kept in DO storage.
  Engines A/C answer `engine_unavailable` until M13. The runner gained
  `--self-test` (`src/runner/self-test.ts`, not `src/self-test.ts`, so it ships in the
  one bundle): uid, model route answers with the probe id from the outbound props, the
  four egress targets fail or end in `DenyAll`, no credential-like env name; no file
  system walk (S1). The runner bundle is built by
  `build-security-scanner-controller.mjs` with Vite (SSR, Node built-ins external) and
  embedded through `void:security-scanner-runner-source`; `build-runtime.mjs` and
  `build-worker.mjs` build it. Probe: checks run in parallel (2+3 share one
  self-test); a skipped required check counts as missing (`container` failing gives
  `missing: ['container', 'egress']`). Check 4 calls `env.AI.run` with
  `skipCache` and `cf-aig-collect-log-payload: false`; "no cached entry after" is not
  read back (no gateway log read yet, S10). Check 5 calls REST `/ai/v1/messages` and
  `/ai/v1/responses` (with `access_programs`) on the first priced model of each host;
  401/403 names the token permission instead of credits. Probe calls carry
  `cf-aig-metadata {"securityScan":"probe"}`. `POST /operator/v1/security/probe` has no
  501 guard: with the capability off it returns check 1's copy and makes no other call
  and stores nothing. A stored row that cannot be read is not overwritten by a probe.
  Turning the policy on (`changeSecurityPolicy` with `probe`) runs the probe outside
  the transaction when the revision still matches, stores a failing result and
  answers 409, or writes the passing result with the mode in one write; a preview
  does not check the stored probe and says the probe runs on apply. Without `probe`
  (direct callers) the stored < 24 h check stays. `deleteSecurityScanner` (gate →
  container app → Worker) exists for uninstall; wiring it into `void platform
  uninstall` is left to the CLI milestone.
  Review fixes: turn-on first runs the full proposal (`probeOnApply`) so a change
  refused anyway (public gate, blocked or unpriced default, no provider notice) never
  provisions or calls a model; a third-party default is checked against the fresh
  probe, not the stored hosts. A failed turn-on probe answers 409 with `probeId` and
  each refusing check (`name`, `message`, `link`) in `details`. A gate with no marker
  or another installation's marker is refused. Timing: probe ready wait 90 s + setup
  30 s + self-test 90 s < the API's 240 s wait. Check 2 keeps the Workers Paid /
  permissions copy for plan and token errors and shows the provisioning error's own
  copy for `ownership`, `outdated`, `missing` and `gate`.

**M7 Model proxy and budget.**

- Scope: `SecurityScanControl.model()` → `security/model-proxy.ts`: scan id + attempt +
  lease; `model == scan.model_used`; allowlist minus blocked, host passed check 5, notice;
  per-session (40) and per-scan (80) call counts; token caps; pre-call worst case and
  post-call spend in one `UPDATE … RETURNING` on both spend rows; fixed headers
  (`cf-aig-gateway-id`, `cf-aig-metadata {"securityScan":tag}`, collect-log true,
  payload false, skip-cache true); `access_programs` for `openai/*`; SSE pass-through
  with usage read; failure reason store so the runner can ask why (Engine C). `@cf` rate
  token asked from the scheduler DO. `deriveSecurityScanTag` (own HMAC label).
  `security/budget.ts`: ceilings (spec §16.2), reserve, month math (UTC, cross-midnight),
  80/100% thresholds (alerts queued in M15).
- Tests (unit): `security-model-proxy.test.ts` (mock `fetch` + `AI`: headers, strips
  caller `cf-aig-*`, 402 → credits, cap stop → `incomplete (budget)`, wrong model 422),
  `security-budget.test.ts` (ceiling table, edges #49–#52); integration
  `security-spend.test.ts` (two reserves near the cap: one wins — edge #51, real SQL).
- Exit: metered spend equals tokens × list price in tests.
- As built: `SecurityScanControl.model()` calls `handleSecurityModelRequest`
  (`security/model-proxy.ts`). One route per host: `POST /v1/chat/completions`
  (`@cf`, `env.AI.run`), `/v1/messages` (`anthropic/*`), `/v1/responses` (`openai/*`)
  (REST `/ai/v1/*`); a route that does not match the model's host is a 422. Policy Off
  refuses every call (409). Check 5 uses the stored `entitlement.hosts` (no 24 h
  freshness: the daily probe in M9 keeps it current). A third-party call needs the
  project's own notice at the current version. REST headers are built from nothing
  (only `anthropic-version`/`anthropic-beta` pass on Messages), so no caller credential
  or `cf-aig-*` header passes. The binding answer is turned into chat-completions shape
  when it is the legacy `{response, tool_calls}` form (Engine B reads `choices`).
  Money: a call's worst case (request bytes as input tokens, since a token is at least
  one byte, plus its output limit) is held on `spent_nano_usd` of both month rows in
  the `UPDATE … WHERE spent + worst ≤ cap RETURNING` that checks the cap, after the
  scan row `UPDATE` that checks attempt, `running`, lease, call cap and token caps. One
  transaction, always scan → project → platform row (also for reserve, settle,
  release, so no lock cycle). After the answer the hold is replaced by tokens × list
  price; a failed upstream call costs 0; a paid answer with no usage, a dropped stream
  or a failed settle keeps the worst case (the meter errs high). The proxy clamps the
  output limit to what the scan has left (`max_tokens` / `max_output_tokens`; 16,384
  when the caller sets none) so the worst case is bounded. Stops answer 429 (402 for
  credits) with `x-void-scan-stop`; other failures carry no header (runner retries once).
  `budget.ts` also has `reserveSecurityScanBudget` (scan start, for M9: sets
  `started_at`, refuses a scan that already holds a reserve) and
  `releaseSecurityScanReserve` (month of `started_at`, edge #52), the §16.2 ceiling
  rules, the edge #49 refusal copy, 80/100 % thresholds (alerts stay M15) and the
  `Dec 1` reset label. Deviation: per-session counts (40), the `@cf` token bucket
  (10/min/model) and the last refused call live in the `SecurityScanScheduler` DO
  storage (`security/call-ledger.ts`, RPC `admitModelCall`, `recordModelCallFailure`,
  `modelCallFailure`, `forgetModelCalls`): Postgres has no column for them and M3 is
  done. The session comes from an optional `x-void-scan-session: 0–63` header (Engine C
  config in M13; Engine B sends none and counts its own turns); the per-scan cap in
  Postgres stays the hard bound. M9 adds 429 back-off to the bucket and calls
  `forgetModelCalls` when an attempt ends. `GET /v1/void/last-failure` answers the last
  refused or failed call of the attempt (Engine C). Waiting for a rate token (≤ 120 s)
  does not use a model call. `deriveSecurityScanTag` sits in `proxy-token.ts`
  (`<scanId>.<22-char MAC>`, HKDF label `void-security-scan`). Extra test cases: the
  call ledger in `security-budget.test.ts`; the proxy on real SQL in
  `security-spend.test.ts`.
  Review fixes: the proxy refuses (422 `tool_not_allowed`, failure `not_allowed`)
  any tool the provider runs (Messages: any typed tool except `custom`; Responses:
  anything but `function`/`custom`, also inside a `namespace` or an `additional_tools`
  input item) and `mcp_servers`, `container`, `background`; the container's tool
  lockdown is untrusted (spec T2). `anthropic-beta` keeps only an allowlist
  (`SECURITY_ALLOWED_ANTHROPIC_BETAS`, no `context-1m-*`); S2 recorded header names,
  not values, so M13 confirms the list and the Codex namespace type. When the output
  left is below the route minimum (16 on Responses) or a `budget_tokens` thinking
  budget cannot drop to ≥ 1,024 under it, the call answers the `tokens` stop before
  the hold; otherwise the budget is lowered to `max_tokens − 1`. A 2xx answer that is
  not JSON keeps the worst case (502 to the runner). Cache writes are priced 1.25×
  (5 min) / 2× (1 h) input and a Messages hold counts input at 2×; cache reads stay
  at 1× (over). On the binding only a 402 is a credits stop.

**M8 Outbox enqueue and input hold.**

- Scope: `enqueueSecurityScanInTx(tx, …)` called in `commitCutoverLive` after
  `setActiveDeployment` (pass `env`), in `promoteProtectedDeployment` (`trigger=recovery`),
  and in the compensate `post_routing_recovery` branch in its own short tx (best effort,
  logged; see Risks R8). Rules: policy lenient read; public state fresh (strict ZT read,
  any error = public); `preview-*`, owner suspended, deleting → no row; protected under
  `public` → `skipped:protected`; open request → `trigger=gate`; coalesce (old queued →
  `superseded`, keep `first_queued_at`). After commit: copy inline modules
  (`publish-worker.ts`, ≤50 MB / 30 s), then move the row with a compare-and-set
  (`UPDATE … SET status = 'queued' WHERE id = :id AND status = 'pending_input'`), so a
  scan canceled meanwhile (policy Off, `policy_off`) stays canceled; poke only when the
  row moved. Hold in
  `deleteDeploymentInputs` and `sweepStaleDeploymentInputs` (check `security_scans.input_prefix`).
  `deleteProjectAssets` adds `security-scans/{project}/`.
- Tests: integration `security-enqueue.test.ts` (row in same tx; rollback of the tx
  leaves none; skip table spec §6.1; coalesce keeps `first_queued_at` — edges #2, #37;
  recovery row — #41; unchanged static redeploy no row; policy Off between commit and
  the input copy leaves the row `canceled`), `deployment-execution.test.ts`
  (hold + release), `unread-deploy-cleanup.test.ts` unchanged pass.
- Exit: no live deploy path (except R8) can go live without a row while policy is on.
- As built: `security/enqueue.ts`. `enqueueSecurityScanInTx(tx, env, …)` runs in a
  savepoint, so a failed statement is logged and the deploy commits with no row (D45).
  Capability off → no row and no read. It takes the policy advisory lock in shared mode
  (lock order: project row, then policy), so an Off write waits for the deploy commit
  and cancels the new row instead of missing it. Owner suspended = any
  `users.suspended_reason`. Protection is spec §4 read in the transaction (the
  installation check is `installationZeroTrustProtects`, now exported from
  `policy.ts`). One row per live deployment: a second call (compensation after a
  committed cutover, R8) gets the same row back while it is still `pending_input`
  (or `skipped:protected` with no module copy yet).
  An open public request sets `trigger=gate` and `public_request_id` only; the
  request state (`needs_deploy` → `waiting_scan`, `gate_scan_id`) is M16. Coalescing
  supersedes `pending_input` and `queued` rows (not only `queued`), so an earlier
  deploy's after-commit step cannot queue a replaced row; a `skipped:protected` row
  supersedes them too (the old deployment is no longer live and the project is out of
  scope), without taking a `first_queued_at`. The hold is `input_prefix` = the
  deployment operation's prefix (operation id = deployment id) while `inputs_deleted`
  is false. Copy: when the row
  holds no staged input (inline `workerFiles`, no Queue) the modules go to
  `security-scans/{project}/{deployment}/modules/{i}`, then `modules.json` last (a
  copy without it is incomplete), and `input_r2_key` is that prefix. A
  `skipped:protected` row holds nothing, so its modules are copied too (staged or
  inline) for the exposure catch-up (spec §7.2). Over 50 MB, not done in 30 s, or a
  read error → `failed`, `status_reason`/`error_class` `input_missing`, `failure_cause
  project`. A copy whose compare-and-set misses (row canceled or superseded
  meanwhile) is deleted unless a row points at it; a timed-out copy is deleted again
  once its last `put` settles. `finishSecurityScanEnqueue` runs after `done` in both
  publish paths (so the copy never delays the result), right after the admission
  commit for `trigger=recovery`, and in compensation whenever a failed deploy is
  still live: an unclear cutover that did commit, or a step after the cutover commit
  that threw. There the pipeline hands over its `workerFiles`, and the short
  transaction gets the row the cutover wrote back (still `pending_input`) or, when
  live was written outside any transaction, writes one (R8). A `trigger=recovery`
  row of an inline deploy is queued with no input (the modules left with the request
  that died): M10 has to read it from the stored Worker bundle (`bundle_stored`), else
  it ends `input_missing`. A row left in `pending_input` by a lost after-commit step is
  for the M9 re-poke.
  `dispatchPendingDeployments` leaves held operations out of its page so they cannot
  starve the others. Unchanged static redeploy: the API has no such path (the CLI
  skips unchanged assets, but a deploy still makes a deployment); the test covers an
  idempotent replay, which makes no new deployment and no row.

**M9 Scheduler and hourly jobs.**

- Scope: real `SecurityScanScheduler`: claim queued rows round-robin by owner, oldest
  first; installation concurrency (policy) and 1 per project; `@cf` token bucket in DO
  storage (10/min/model, back off on 429); reserve at start (`skipped:budget`); set
  `attempt`, `lease_until`; call the controller; retry once on infra error; re-arm while
  work remains. At claim, a non-gate queued scan of a project that is now protected
  under `public` becomes `skipped:protected` (spec §5.4 All → Public). Cancel API for
  teardown and operator cancel. `security/maintenance.ts`
  in the hourly branch only (after `index.ts:768`, gated by capability and policy):
  re-poke, reaper (`timed_out`), 24 h → `skipped:backlog`, raw output sweep (cursor in
  ROUTING, capped deletes), scan row and closed request retention, daily probe
  (`entitlement.checkedAt` > 24 h, mode ≠ disabled). `teardownProject` cancels scans.
- Tests: unit `security-scheduler.test.ts` (round-robin, bucket, re-arm, back-off);
  integration `security-scheduler-claim.test.ts` (running unique index, lease fencing —
  edge #33; under `public` a queued non-gate scan of a now-protected project becomes
  `skipped:protected` at claim, a gate scan still runs), `scheduled.test.ts` (hourly jobs run only when on; fast tier untouched),
  `api-delete.test.ts` (mid-scan delete cancels — #26).
- Exit: fake controller drives queued → running → result.
- As built: the queue's Postgres side is a new `security/queue.ts` (read, claim, end,
  requeue, cancel, reaper, backlog skip, re-poke); `scheduler.ts` keeps the DO and
  `runSecurityScanQueue(deps)`, which tests drive with a fake store and controller.
  The "which model runs" resolver (`security/models.ts`, from the layout) landed here
  because the claim stores `model_requested`, `model_used` and `engine`: project model,
  else the default; unknown/blocked/unpriced → default (#23); third-party without a
  passing check 5 host, the current installation notice or the project's own notice →
  first non-blocked priced `@cf` model (#44, #84); none → `failed (infrastructure,
  no_model)`. A pass, per candidate in round-robin order (owners never served first,
  then least recently served, kept in DO storage, ≤ 1,000 owners): claim under the
  project lock + shared policy lock (attempt + 1, lease = 2× wall clock + 5 min); the
  claim re-checks what may have changed while the row waited: project `deleting` /
  owner suspended → `canceled` (`project_deleted` / `owner_suspended`), 24 h →
  `skipped:backlog`, `public` + protected + not `gate` → `skipped:protected`; a unique
  index hit is `busy` (row stays queued). Then reserve (refusal → `skipped`, reason
  `budget`, `error_class` `project_cap|platform_cap`), then `POST /v1/scans/start`
  through the gate. A failed start (throw, non-2xx, `ok:false`) cancels that attempt at
  the controller, forgets its ledger, gives the reserve back and requeues it with a
  60 s back-off; the second failure is `failed (infrastructure, start_failed)`. A
  container that started and then failed is M12's to retry (`requeueSecurityScan`,
  `endSecurityScanAttempt` are there). At most `floor(10 / 10) = 1` running scan per
  `@cf` model. A Workers AI 429 now reaches the scheduler (`rateLimited` proxy dep →
  RPC `backOffModelRate`): the bucket goes 5 tokens (30 s) into debt per 429, at most
  one minute; calls wait for the refill and no new scan starts on that model until it
  is paid. Re-arm 30 s while queued rows remain, sooner for a retry or back-off end, no
  alarm when empty; ingest (M12) should poke on completion. With the capability off
  the alarm does nothing. Cancel: `cancelSecurityScans` writes the rows first (that is
  the fence), then controller cancel + ledger forget, best effort; `teardownProject`
  calls it right after `lockAndMarkDeleting` (direct, not through the DO: the rows
  are the fence, and the running scan's reserve must go back to the platform month
  before the cascade); DO RPC `cancelScans(scanIds, reason)` is for M17. Hourly
  (`maintenance.ts`, after the "Hourly tier" line): the capability gates everything;
  policy Off skips re-poke, backlog and probe, but the reaper, the raw output sweep and
  retention still run (Off does not end running scans, and stored data still ages).
  Reaper: `timed_out` / `lease_expired` / `installation`, reserve back, controller
  cancel, ledger forget. Re-poke: `pending_input` older than 10 min → `queued`, then a
  poke if anything is queued. Raw output: `securityRawOutputPrefix` =
  `security-scans/{project}/scans/{scan}/` (M12 writes there), cursor `(finished_at,
  id)` in ROUTING `security-audits:raw-output-sweep`, 50 scans a run. Scan rows: deleted
  outside the newest 200 or past 180 days, never active, a current base (latest
  `succeeded`), an open request's gate scan, or a row the raw sweep has not passed;
  500 a run. Closed requests: newest 50 per project, never one a bypass names. Daily
  probe: `probeAndRecord` when the mode is on and the stored result is missing or
  ≥ 24 h old. The exit test ends with the reaper (`timed_out`), since `result()`
  refuses until M12. The M1 stub test now checks that the alarm does nothing with the
  capability off. Extra tests: the 429 back-off case in `security-model-proxy.test.ts`.
  Review fixes: the reserve is fenced on `running` + `attempt` (a cancel after the
  claim gives `gone`: no start, no end), and a start that worked re-reads the row and
  cancels at the controller if it moved; every end, requeue and cancel releases the
  reserve in the same transaction, and an hourly step releases any ended row that still
  holds one. The first failed start ends the pass and the alarm waits for the retry
  back-off (an outage costs one scan its retry, not the queue); an error on one
  candidate ends only it (`failed (infrastructure, scheduler_error)` once claimed).
  Cancel locks its rows in one `SELECT … FOR UPDATE` over every active status, so a
  claim in flight is waited for and still canceled. A pass keeps an earlier alarm (a
  poke). Teardown lets a failed cancel throw (retried before the cascade). The binding
  often throws only `3040: …` with no status: the proxy reads that leading code (3036
  and 3040 → 429). The month's `scans` count only goes up on the first attempt. The
  hourly security step stays first in the hourly tier, as planned; a due daily probe
  can add about 3 minutes before the jobs after it.

**M10 Input builder (T2, T3, filters, memory).**

- Scope: base selection at scan start; T2 from changed Worker modules by sha256 +
  source-map `sourcesContent`, changed text assets by hash; T3 full; claimed-commit
  check (sha256 of `sourcesContent` vs file at commit when T1 is possible); filters and
  secret-like file drop; third-party by lockfile registry identity (else keep, rank last,
  `third-party-unverified`); caps 400 files / 2 MB / 256 KB; priority by import graph;
  `backlog.json`; redaction (8+ mixed chars, 4 forms); phrase check (plain substring,
  no regex) → server lead; memory index (64 KB, 200 records, role only) + history files;
  copy staged inputs to `security-scans/…` at start and release the hold;
  `SecurityScanControl.input()` streams a tar.
- Tests (unit, pure): `security-input-tier.test.ts`, `security-input-t2.test.ts`
  (fixture bundles with source maps for React/Vue/Svelte/Solid), `security-filters.test.ts`,
  `security-third-party.test.ts`, `security-redact.test.ts` (4 forms, short values kept —
  #30), `security-phrase-check.test.ts`, `security-memory.test.ts` (order, caps, no model
  rejections — #40), `security-backlog.test.ts` (#13, #36); integration
  `security-input-capture.test.ts` (R2 copy, hold release, input_missing — #12).
- Exit: a fixture deploy produces the expected tar and coverage label.
- As built: `security/input/{tier,t2,filters,third-party,redact,phrase-check,memory,backlog,tar,build,prepare}.ts`.
  The pure parts take data already read; `build.ts` puts them together and
  `prepare.ts` does the I/O. `SecurityScanControl.input()` checks the fence, then
  `prepareSecurityScanInput` builds and checks every entry before it answers (the
  controller now waits 120 s for it, `INPUT_TIMEOUT_MS`), so a failure gives `null`, never
  half a tar; the tar is then encoded entry by entry as the controller reads it.
  Tar: own ustar writer, regular files only, pax `path` for long or non-ASCII names, same
  name rules as the runner's reader. Head modules, first match: the scan snapshot
  (`input_r2_key`), the staged deploy input (`input_prefix`), the stored Worker bundle
  (`bundle_stored`, new `loadStoredWorkerModules` in `durable-objects.ts`, for M8's
  recovered inline deploys); staged and stored modules are copied to
  `security-scans/{project}/{deployment}/` and the hold is released with a fenced write
  (`input_r2_key = prefix, input_prefix = NULL`). Modules are read one at a time (hashed,
  copied, decoded, a map cut to its `sourcesContent`), so the API isolate never holds the
  bundle's bytes. None, an incomplete snapshot, a missing object or > 50 MB counted as
  read (not as recorded) → `failed (input_missing)`, project cause, reserve back, poke (#12).
  Deviation: the claim moves the row to `running`, which used to drop the hold before the
  copy, so `SECURITY_SCAN_INPUT_HOLD_STATUSES` now includes `running` (a running row holds
  its prefix until the copy clears it); coalescing uses the new
  `SECURITY_SCAN_WAITING_STATUSES`. The `idx_security_scans_input_hold` partial index
  still names only the two waiting states (no migration change); the hold check is a
  small lookup either way. The snapshot gains `sha256` in `modules.json` (an inline copy
  from M8 has none: the first scan fills it in), `sources.json` (path → sha256 of the
  unredacted text) and `assets.json` (path → hash), so it can be the next scan's base
  without the deployment row. Base = last `succeeded` scan; tier: rescan → full (#43), no
  base → `first-scan`, snapshot gone → `no-usable-base`, else T2 (T1 is M11). T2: a source
  changed when its module or that module's map changed and its text hash differs from the
  base index (no index: every source of a changed module); modules with no map are read as
  built code under `input/_worker/` (`no-source-maps`); changed text assets (≤ 256 KB)
  under `input/_assets/`, read from R2 then KV. Priority: breadth-first over relative
  imports from `workerMain` (plain text scan), then assets, then `third-party-unverified`.
  Source paths: scheme and query cut, resolved against the map folder and `sourceRoot`,
  `..` above the root dropped, duplicates with other text get `~2`. Focus: backlog first,
  400 files / 2 MB, a file over 256 KB counts as 256 KB (T2 has no hunks); T3 sends no
  focus list; its backlog is only what it could not read. The backlog a scan leaves is written to
  `security-scans/{project}/scans/{scan}/backlog.json`, not the project's `backlog.json`:
  M12 must promote it only on `succeeded`, so a failed scan loses no file. Server leads
  (phrase check) go to `…/scans/{scan}/server-leads.json` for M12 to store. Empty diff:
  note `no-changes` and `no_changes: true` in `task.json` (the runner ignores the field
  today); M12 must take the "no changes" path (no model call, #14). A gate scan with no
  diff re-checks the files of `fixed` findings resolved since the base; with none it runs
  in full (`gate-recheck`, #85). Filters: `id_*` matches only key files (no extension or
  `.pub`) so `id_utils.ts` stays; binary = NUL or U+FFFD in the first 8 KiB. Third-party:
  `package-lock.json` and `pnpm-lock.yaml` readers exist, but no lockfile reaches the
  platform yet (S7), so `lockfile` is `null` and `node_modules/…` sources stay as
  unverified. Read set: 32 MB, and the runner's 16 MB a file (after redaction) and 20,000
  entries with memory (`security-scanner/src/runner/limits.ts`, shared by both sides);
  assets: 400 files / 16 MB. A changed or backlogged file left out (`input-capped`), and
  an asset not read (`assets-unread`, over the limits or gone from storage), goes to the
  backlog and stays out of `sources.json` / `assets.json`, so no later scan counts it as
  seen. A path over 960 characters becomes `_long/<hash>/<name>`; a path the runner still
  refuses is dropped (`dropped-bad-path`, partial), not the whole tar. Inline source maps
  are found at any length. `partial` = backlog left, a cut or bad-path file, or > 5 % of
  source bytes lost to registry drops or the cap; secret-like files are dropped and
  counted in `dropped_files` but do not make a scan partial; a partial from registry
  drops alone adds `partial-third-party-only` (#92). Redaction covers every file in the
  tar, memory included; a secret that cannot be decrypted fails the build (the
  controller reports `input_unavailable`). Phrase check: whole-word, case-insensitive,
  `LLM` upper case only (lower `llm` is common in identifiers); a full scan checks the
  project's own files. Memory: no `security_memory_rejected` read; history files capped
  at 8 MB and 2,000 files (oldest resolved first). The row gets tier, coverage, notes, counts and
  `base_scan_id`/`base_deployment_id` (fenced on `running` + attempt).
  `securityCoverageLabel` (tier.ts) builds the label from the row for M14+.

**M11 T1 source diff (hosted, `managedBuilds`).**

- Scope: `compareCommits` in `github/installation-token.ts` (files, patch, truncation);
  head tarball to R2; project root + source-map-listed shared files; OIDC `sha` match.
- Tests: unit `security-input-t1.test.ts` (truncated → T2, force push → T2/T3 — #9,
  monorepo — #32, mismatch → `commit-mismatch` — #38); integration
  `security-t1-github.test.ts` with mocked GitHub.
- Exit: self-hosted never takes T1.
- As built: `security/input/{t1,t1-github,source-tar}.ts`; `prepare.ts` tries T1 when the
  tier would be T2 (a base snapshot exists, not a rescan), after assets are read, and
  passes the files to `build.ts` as `sourceDiff` (or a fallback note as `notes`).
  `compareCommits(token, repo, base, head)` asks for one page of one commit (the file list
  is on page 1 only); ≥ 300 files or no list = truncated. Start: `managedBuilds`, a
  `github_connections` row, hex base and head commits; the bundle is parsed only past this
  point and handed to `build.ts`, so T2 parses it once. Before the token, the connection must
  pass `installationCoversRepo` (active installation, repo still selected, owner/admin
  authorizer), as a managed build does; else `source-diff-unavailable`. The head's build comes from
  `deployment_operations.build_id` (or `builds.deployment_id`): `container` = managed (no
  content check), `github_actions` = its `commit_sha` (the OIDC `sha` claim) must equal
  the claimed commit; a build whose commit differs → `commit-mismatch`. One scoped token
  (this repository, `contents: read`) for the compare and the tarball. Compare: only
  `ahead` / `identical` (`behind` / `diverged` = force push → `base-not-ancestor`; a 404 or
  error → `source-diff-unavailable`; truncated → `compare-truncated`), each T2 with that
  note. The tarball goes to R2 by multipart (100 MB compressed, 512 MB / 100,000 files
  unpacked, else `source-too-large`) at `…/scans/{scan}/source-{attempt}-{uuid}.tar.gz` (one key per call, so
  overlapping runs never delete each other's) in parts of exactly 8 MiB (R2 wants equal
  non-last parts) and is deleted as
  soon as the input is built (a retry fetches it again), so the whole repository is never
  kept. Pass 1 hashes every file, pass 2 reads the planned ones. Own streaming ustar/pax
  reader: regular files only, top folder cut, unsafe names and links skipped (but every
  entry counts toward the limits).
  Root: a source-map path is the map's path with `..` above the output folder dropped, so
  it ends a repo path; each source whose text is at exactly one such path votes for the
  folder in front. The folders must form one line (deepest = project root, the rest hold
  shared packages), else `monorepo-shared-code`; no vote → `commit-mismatch`. A managed
  build's root is `''` (it ran at the repo root). Content check (not managed): no source
  maps, or a mapped source whose text differs from the commit while it changed (in the
  compare or in the built output) → `commit-mismatch`. A file that differs but did not
  change is read from the bundle (its live text). Scope: the root (no `node_modules/`) plus
  repo files the maps list; secret-like files noted, filters as M10. Changed = compare
  files in scope ∪ T2's changed sources. Deviation (safer than the spec): the T2 changes
  are part of T1, so code that went live is scanned even when the base's claimed commit
  did not match what it shipped. Bundle sources with no repo file (packages, generated
  code) stay in the input under their own path. Input paths match T2 (a mapped file keeps
  its source-map path, others are relative to the root), so findings keep their file when
  a project moves between T1 and T2. Order: changed first; server code (bundle order),
  config, other code, tests and docs. Changed repo files may use the whole read budget,
  unchanged ones what bundle-only sources leave; the rest is unread. An unread file that changed
  (or waits in the backlog) is cut: capped, lost, back to the backlog. An unchanged one is
  read access only (§7.4): dropped, not capped, so a big repo is not `partial` on every
  scan (a gate scan that turns full caps it, as in T2). Deviation: no hunks for files over 256 KB: the runner takes only
  `changed_files` and reads whole files, so a big file counts as 256 KB in the focus, as in
  T2. `MemoryR2Bucket` gained `createMultipartUpload`. New note names beyond the spec:
  `compare-truncated`, `base-not-ancestor`, `source-diff-unavailable`, `source-too-large`.

**M12 Ingest and findings.**

- Scope: `SecurityScanControl.result()` → zod check → one tx: fingerprint key
  (project + skill fingerprint + sink path), dedupe, F-number, 50+50 cap
  (`findings_capped`), promote, `not_seen` hint, reopen rules and stale-scan rule,
  `fix_checked_scan_id`, `rejected` store (never fed), events only on change, base
  moves only on `succeeded`, `no changes` path for empty Worker diff, raw output to R2,
  `ledger_summary`. Late or reaped attempt rejected. Then (after commit) gate re-check
  (M16) and notification rows (M15).
- Tests: unit `security-findings-rules.test.ts` (reopen table, "new" rules spec §9.4,
  possible duplicate), `security-ingest-schema.test.ts`; integration
  `security-ingest.test.ts` (one tx; concurrent same key — #20; stale scan — #35;
  incomplete keeps confirmed only; refused stores none; #3, #4, #14, #18, #19).
- Exit: full fake path deploy → findings rows with the fake controller.
- As built: `security/ingest.ts` (status and report parsing, the outcome table, the one
  transaction), `security/findings.ts` (pure rules) and `security/fence.ts` (the fence,
  moved out of `control.ts`, which re-exports it). `result()` answers `ok: true` once the
  result is taken (stored, or requeued), `false` when fenced off or when the store threw
  (the controller keeps polling until the hard cap; the reaper ends a scan nobody
  stored). Deviation: no Zod in the API Worker; `findings.json` goes through the runner's
  own hand-written validator (`validate-findings.ts`, one copy of the rules on both
  sides) and must carry `schema_version: 1`. `status.json` is read by a small parser:
  unknown status, a reason that does not go with it, or another scan id / attempt →
  `failed (bad_output)` (`status_unreadable` / `status_mismatch`). Outcome: `succeeded`
  stores all; a report with `run_status: incomplete` makes the scan `incomplete
  (run_incomplete)`; `incomplete` stores validated confirmed only; the rest store none.
  Cause: `infrastructure`/`credits` installation, every other failure project. The
  first `failed (infrastructure)` attempt is requeued (`requeueSecurityScan`), the second
  ends. The transaction locks the project row (serializes ingests and F-numbers), then
  the scan row, re-checks the fence (attempt, `running`, lease, project not `deleting`),
  writes findings, events, scan status and gives the reserve back. After commit: the
  scan's `backlog.json` becomes the project's (only on `succeeded`, and only when the
  scan file exists), `status.json` + `findings.json` go to `…/scans/{scan}/`, the call
  ledger forgets the attempt, poke. Key = sha256(source, project, skill fingerprint, sink
  path or file): the source (`scanner` / `server`) comes first, so a model fingerprint
  such as `server:reviewer_text` never takes over a server lead's row (§10.3). The
  per-scan cap counts new keys only (a key the project has adds no row, so a capped scan
  still re-sees, reopens and promotes all it reported); of those it keeps the most
  severe confirmed and puts server leads first in the 50 leads; note `findings-capped`.
  Finding rows are locked in id order (`SELECT … ORDER BY id FOR UPDATE`); bulk resolve
  (later milestone) must take them in the same order. Severity only rises and a confirmed finding
  is never demoted (a scan cannot downgrade, §10.3). `revision` moves only on
  `reopened`, `promoted`, `severity_changed` (a re-see never makes a resolve in flight
  answer 409). Stale-scan rule: unknown admission time = stale; `rescan` uses
  `started_at`. A sink hash unknown on either side is not a change. One `seen_again` /
  `seen_again_stale` per resolve. `possible_duplicate_of` = id of the newest resolved
  finding with the same file + category. Server leads and `rejected` records are stored
  on `succeeded` only (otherwise the base does not move and the next scan finds them
  again). `prepare.ts` now also writes `…/scans/{scan}/scope.json` (diff focus, or every
  input file of a full scan, plus each input file's hash: a source's unredacted hash,
  else the hash of the text sent), used for `sink_content_hash` and the not-seen hint:
  set on `succeeded` scans for open findings not reported whose file the scan looked at
  (diff: focus; full: the files in its input, so a file the filters dropped, a backlog
  file or a file gone from the deployment never gets it), one `not_seen` event.
  `fix_checked_scan_id` is set by a `succeeded`, uncapped scan with no backlog, model
  calls on the row (proxy count, not the container's) and a model run, of a deployment
  admitted after the `fixed` resolve (compared in SQL). `ledger_summary` (succeeded
  only) is server-built from paths + `finding|scanned|backlog`, ≤ 6 KB of JSON; a diff
  scan (and a scan with no model run) merges the base scan's ledger (this scan wins a
  path; base `backlog` entries drop, this scan's backlog is the whole one), a full scan
  replaces it. Deviation: the server-side path (#14) is in `prepareSecurityScanInput`:
  a diff scan with an empty focus is stored as `succeeded` with no model call and
  `input()` answers `null`, so the runner never starts. `status_reason` is `no_changes`
  (and the `no-changes` note) only when nothing was cut; when changed files were all cut
  to the backlog the scan is a plain partial `succeeded`; the controller's `input_unavailable` report
  that follows is fenced off. Not yet: ingest returns `news` / `reopened` / `capped` for
  M15 (notification rows) and M16 (gate re-check); neither is written here.

**M13 Engines A and C, images, drift test.** (Code lands; turning models on depends on S2/S3.)

- Scope: `engines/claude.ts` (locked options spec §15.3, `ANTHROPIC_BASE_URL`, placeholder
  key, managed settings), `engines/codex.ts` (SDK with `codexPathOverride` → `codex-wrapper.sh`
  adding `--ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check`,
  empty `/work`, own `CODEX_HOME`, config/requirements/model catalog), `mcp/void-scan.ts`.
  Two images (`Dockerfile.claude`, `Dockerfile.codex`), exact pins in `image/package.json`
  with its own lockfile, `--ignore-scripts`, linux-x64 only, non-root, `LICENSE`/`NOTICE`.
  Image distribution per R1. CI job `build-security-scanner-images` next to
  `build-api-container` in `platform-ci.yml`; root `.dockerignore` allowlist.
- Tests: unit `claude-engine.test.ts`, `codex-engine.test.ts` (option shapes, env has no
  key, wrapper args), `void-scan-mcp.test.ts`, `image-pins.test.ts` (Dockerfile ↔
  `image/package.json` ↔ wrapper versions match; like `build-container-package.test.ts`);
  opt-in `recorded-run.e2e.test.ts` (`VOID_SCANNER_E2E=1`, Docker, `--network none`,
  fake model: tools list only Read/Glob/Grep(/Skill) or the 4 MCP tools; planted
  `AGENTS.md`, `.codex/`, `CLAUDE.md`, `.mcp.json` never load; `codex --version` matches).
- Exit: drift test green; models whose engine spike failed stay out of the list (blocked by default).
- As built: `engines/{claude,codex,proxy-failure}.ts`, `mcp/{server,void-scan}.ts`,
  `coerce.ts`, `image/{Dockerfile.claude,Dockerfile.codex,claude/,codex/,codex-wrapper.sh,NOTICE}`,
  CI job `build-security-scanner-images`, one `Dockerfile.<engine>.dockerignore` allowlist each
  (the root `.dockerignore` is pinned to the API build container by its own test). The SDKs are loaded
  by a variable specifier when the first session starts, so the runner bundle stays
  dependency-free and a managed (Engine B) image that gets an A/C task ends `failed
  (engine_unavailable)`. `vp pack` now writes `runner.mjs` and `void-scan-mcp.mjs`.
  Each image has its own exact-pin `package.json` and an npm `package-lock.json` (plan
  said one pnpm lockfile; two images need two sets, and the base image has npm), installed
  with `npm ci --ignore-scripts`; everything under `/opt/void-scanner` (the controller's
  `RUNNER_PATH` folder). The wrapper also refuses a `codex` that is not the pinned version.
  Engine A: `systemPrompt` is Void's own prompt (skill vendoring is still R5) plus a note
  that the tools are Read/Glob/Grep and the end is the structured output (size keywords
  stripped from the schema, `validate-findings` still enforces them); no plugin, no
  `Skill` tool; cwd `/scan/input` plus `/scan/memory`; the PreToolUse hook checks realpath.
  Both engines send `x-void-scan-session` (the proxy's per-session call cap), set the CLI
  retry caps from spikes S2/S3 (Codex 0 and 0; Claude Code 2, since a 401 retried for
  120 s), and after a session with no report ask the proxy `GET /v1/void/last-failure`;
  a failure that is new since the session started decides credits or a cap stop.
  `classifyClaudeResult` reads `is_error` + `API Error: 402` as credits (S2).
  The proxy (M7) now takes the gateway name (`claude-sonnet-5.5`, `gpt-6.1-terra`) as the
  scan's model and sends that name on, the form S2/S3 verified, and never passes an
  upstream 401 on to an engine. Engine B (and the other engines) read a report sent as JSON
  text, repair harmless slips (`coerce.ts`) and retry once with "your last output was
  invalid: …". Not built here: the controller dispatch for A/C, the image copy into the
  operator registry, the publish script and the `recorded-run.e2e` Docker test (all in
  M13b below), and the upstream skill (R5). Live quality numbers for A/C are blocked on
  credits (S2/S3).
  Checked locally on an arm64 colima build of both images: they build, `import()` of the SDK
  works, the wrapper refuses other subcommands and a missing version match, the catalog
  holds only `gpt-6.1-terra`/`gpt-6.1-sol` with `shell_type: disabled`, and the Codex SDK
  accepts our whole config under `--strict-config` (`http_headers` and the MCP server
  included) and reaches the model URL. Codex still prints "Reconnecting…" on a dropped
  connection after the retry caps are 0 (those caps cover HTTP statuses such as 402), so
  the wall clock ends such a session. `vp pack` runs two builds: one shared chunk would
  break the single-file `runner.mjs` the controller embeds. The Codex image keeps only the
  `codex` binary (the platform package also carries `bwrap`, `codex-code-mode-host` and
  LGPL voice libraries) and the Apache-2.0 `LICENSE` from the SDK package.

**M13b Engine A/C images in the operator account, controller dispatch, recorded run.**

- Scope: what M13 left out so A/C can run a real scan: copy the digest-pinned images into
  the operator registry (S1b option A), one container app per engine, controller dispatch
  by engine, a probe check for the images, uninstall, a release script (no push here),
  and the Docker recorded run with the fake model.
- As built:

  ```
  release: publish-security-scanner-images.ts --push (manual workflow)
    └─► ghcr.io/voidzero-dev/void-security-scanner-engine-{a,c}@sha256 (public)
          └─► api/src/security/scanner-images.json  { digest | null }
  probe (per host, right after its credits call passes, unless all its models are
         blocked; calls + copy end 45 s after the probe start):
    registry credentials (push, pull; 15 min) ─► HEAD dest manifest ─► skip if there
      └─► ghcr manifest (sha256 = pin, not an index) ─► config (linux/amd64)
            ─► layers missing in the account, deadline checked before each (resumable)
            ─► PUT manifest by tag sha256-<hex> ─► /containers/image-preparations
  provision: one Worker, classes ScannerController (B, managed image)
                                + ScannerControllerEngineA / ScannerControllerEngineC
             one container app per deployed engine: void-security-scanner-engine-{a,c}-<suffix>
             deployed = images it already runs at the current pin + images ready now
  scheduler start ─► SCANNER / SCANNER_ENGINE_A / SCANNER_ENGINE_C by task engine
  ```

  - Files: `security/scanner-images.{json,ts}` (pins; parse refuses a bad pin),
    `provisioning/security-scanner-images.ts` (copy, prepare, delete + `/v2/gc/layers`),
    `provisioning/security-scanner.ts` (engine classes, bindings, apps, images text
    `__VOID_SECURITY_SCANNER_IMAGES`, `assertSecurityScannerContainers`),
    `security-scanner-controller-runtime.ts` (dispatch, engine subclasses),
    `security/probe.ts`, CLI `platform-security-audits.ts` (uninstall),
    `platform/scripts/publish-security-scanner-images.ts`,
    `.github/workflows/platform-security-scanner-images.yml` (manual, main or a tag only,
    no cache, `packages: write`; images carry `org.opencontainers.image.revision`, which
    the script checks equals HEAD, and `--push` refuses a dirty tree),
    `security-scanner/test/e2e/{recorded-run.e2e.test.ts,fake-sdk-model.mjs}`, and a new step
    in `build-security-scanner-images` that runs the recorded run with `VOID_SCANNER_E2E=1`.
  - Deviations from the plan, with reasons:
    - The image check is a new row `image` per third-party host in check 5, after the
      credits row. A host can be picked only when credits, the image copy and that engine's
      self-test all pass. Checks 1–4 (the probe's pass) do not depend on it, so a missing
      image never blocks the `@cf` engine. No credits for a host, or every model of it
      blocked: no copy and no self-test for it (row `skipped`).
    - What is deployed never depends on one probe's results. The controller keeps every
      engine image it already runs whose ref matches the current release pin, and adds the
      ones made ready now; an image leaves only when its pin changes, or on uninstall. A
      failed credits call, registry call or `pending` prepare therefore never re-uploads
      the controller (an upload is a code deploy that restarts every scan). A deployed image
      of a callable, unblocked host is judged by its self-test even when this run's copy
      step failed. Two probes at once converge without a lock: each re-reads after its
      upload and uploads again (at most 3 times) until the controller runs at least its
      own images; only different code ends `outdated`.
    - The pins live in the API package (it does the copy), not in the scanner package.
      Both digests are `null` until the first release push; `null` reads as "this
      release has no image" (`unpublished`) and keeps those models unpickable.
    - The copy runs in the API Worker on each probe and goes on from the layers already
      copied, since a full image is too large for one request. The model calls and the copy
      end 45 s after the probe start; every registry request gets what is left (a layer
      still in flight is cut off and copied again next time), so with provisioning and the
      self-test (≤ 240 s) a probe stays under the CLI's 5-minute timeout. A layer must fit
      one window. Once copied, a probe does credentials, one HEAD and the prepare call.
    - A cancel without an engine goes to all three classes at once (`allSettled`); one
      class that fails answers 500 but never keeps the cancel from the others.
    - The engine images keep their baked `runner.mjs`; the controller does not stream it.
      As root it checks the `scanner` user and the runner file (exit 2 →
      `controller_error`), then makes `/scan` owned by `scanner`, mode 0700. The
      Dockerfiles now create `/scan` the same way: a root-owned `/scan` broke extraction.
      The egress lock and `EXEC_ENV` are the same as Engine B.
    - Each engine needs its own Durable Object class (one namespace binds one container
      app). A controller provisioned before M13b gets migration `v1 → v2` adding both
      classes; a new one gets all three in `v1`. Cancel without an engine goes to all three
      namespaces (the scheduler does not send the engine on cancel).
    - Names use `engine-a` / `engine-c`, never a vendor name (branding rule).
    - Uninstall also deletes the engine apps (namespace checked like the B app) and the
      copied images, then runs layer cleanup. A manifest the registry cannot read (not 200
      or 404) or a failed cleanup fails the uninstall instead of reporting it done; the API
      version also deletes the images when the controller is already gone, so a retry after
      a failed image delete finishes the job.
    - The recorded run builds for the host arch (arm64 locally, amd64 in CI). It is opt-in
      everywhere: only `VOID_SCANNER_E2E=1` with Docker present (the CI image job sets it),
      so the normal test suite never builds the images. Claude Code offers
      `DeferredToolPlaceholder` next to Read/Glob/Grep/StructuredOutput (S2), so the test
      allows it. The fake model also answers `/v1/void/last-failure`.
    - Admin and project copy for a host that cannot be picked now says "not ready (probe
      check 5: credits or scanner image)" instead of blaming credits only.
    - Not run here: the ghcr push (release step), a live A/C scan on Cloudflare (needs the
      push and credits, S2/S3), and the upstream skill (R5).
    - **Needs the user's OK (R1):** this builds option A (copy into the operator registry)
      with Void publishing public images at `ghcr.io/voidzero-dev/void-security-scanner-engine-{a,c}`.
      Both pins stay `null` (A/C models off) until the user agrees and a release pushes.

**M14 Project API routes.**

- Scope: `routes/project-security.ts` mounted with `/projects/*` auth: `GET /security`
  (spec §13.5 shape, role filtering, `detail:'counts'` for CI tokens and OIDC), findings
  list/show (scoped `WHERE project_id`, cursor paging), comment (`configure`),
  resolve/reopen (`settings`, `expectedRevision`, capability re-checked in tx — #21,
  #22), scans (`deploy`), model (notice version, 422s), budget (422 above ceiling),
  page-link. Capability off: write and scan routes 501, read/comment/resolve open.
  Add to `api.ts` typed routes.
- Tests: integration `api-project-security.test.ts` (role matrix PRD §3, 404 vs 403,
  cross-project id 404, readers get no titles or dollars, CI detail).
- Exit: role matrix test covers every row of PRD §3.
- As built: `routes/project-security.ts` (mounted after the zero-trust routes; in `api.ts`),
  with `security/project-view.ts` (status, policy reason, model and budget views, scan list,
  cursor and role filter), `project-findings.ts` (list, show, comment, resolve, reopen) and
  `project-settings.ts` (model, budget). Routes: status, findings list and show, comments,
  resolve, reopen, scans, `PUT model`, `PUT budget`, `POST page-link`. There is no project
  route that starts a scan: a manual rescan is operator only (spec §3), so "scans (`deploy`)"
  is the history list. Role filter: `full` = user session with `deploy`; `counts` = readers and
  any deploy token (`deployScope` set: CI, remote build, OIDC). `GET /projects/:id/security` is
  on the deploy-token allowlist (`middleware/auth.ts`); nothing else under `/security` is.
  Counts level shows F-id, severity, verdict and state of open findings; a resolved finding also
  shows its title (spec §3). `budget` is `null` unless `full`. Severity everywhere is
  `COALESCE(severity_override, severity)`. Finding lists page by `number` ascending (cursor =
  the last number); the scan list pages by `(created_at, id)` descending (opaque cursor).
  `limit` 1–100 (default 25), a bad limit, cursor, `state` or `severity` is a 400. A finding is
  addressed by `F-12`, `12` or its id, always scoped to the project. Resolve and reopen lock the
  project row (as ingest does), re-check `settings` with the same lock held (#22), lock the
  finding, then compare `expectedRevision` (#21); a resolved finding cannot be resolved again and
  an open one cannot be reopened (both 409 `finding changed`, with `state`, `resolution`,
  `revision`, `changedAt`, `byRole`). Resolve stores `resolved_sink_hash` and
  `resolved_severity`, clears `fix_checked_scan_id` and bumps the revision; reopen clears the
  resolved columns, bumps `reopen_count` and the revision. Comments need `configure`, 1–4,000
  characters, change no revision, and are events only. The route takes one finding per call:
  bulk resolve is the CLI looping (M20). Capability off: `PUT model` and `PUT budget` answer
  501 (after the access check, so a private project still 404s / 403s first); status, findings,
  comments, resolve, reopen, scans and page-link stay open. Model: a pick must be a listed,
  unblocked, priced model (422 `security model not allowed`); a third-party pick also needs the
  host's probe check 5 (same 422, as the policy picker does) and the notice
  (`acceptProviderNoticeVersion` = current, or accepted before; else 422 `provider notice not
  accepted` with the notice lines). `model:null` is always allowed; with a third-party
  default, `acceptProviderNoticeVersion` accepts it for the project. A wrong notice version is
  refused. Without the installation notice a third-party pick is stored but the next scan
  still falls back to `@cf` (`model.source: 'fallback'`). `model` in the status is
  `{id, requested, source: project|default|fallback, thirdParty, noticeAccepted, pendingDefault}`
  (`pendingDefault` is the model id or `null`). Budget: `monthlyUsd` whole cents, 0 to
  1,000,000 or `null`; above the ceiling is 422 with `ceilingUsd` and the operator command; a
  `cap_changed` project event is written only when the cap moves. `budget` in the status is
  `{capUsd, capSource: own|limit|none, ceilingUsd, spentUsd, month, resetsAt}`. Policy reason
  copy follows §11.4; a protected project in `public` mode with no open request reads
  `applies:false`. **Deviations:** (1) `publicRequest` is `null` and the status gains no
  request text until M16 (the table exists; the shape belongs to the gate). (2) `security/page-token.ts`
  (mint and verify, own HMAC label, 15 minutes, user + project, key `JWT_SECRET`) was added
  here because `page-link` needs it; M19 only adds the page route that calls
  `verifySecurityPageToken`. The link points at the request origin
  (`/security/projects/:slug?t=…`) and is a dead link until M19. (3) A human reopen
  does not enqueue the "reopened" email and resolve/reopen do not re-check a public request:
  both hook in at M15 and M16. (4) `packages/platform/dist` was stale (old model order); run
  `vp run --filter ./packages/platform build` before the tests. (5) `GET /security/scans` answers 501
  while the capability is off (spec §13.5); status, findings, comment and resolve stay open.
  A comment re-checks no role inside a transaction (it never changes state); the model PUT takes
  no lock (scan time re-checks the model).

**M15 Notifications.**

- Scope: senders in `email.ts` (findings, reopen, project and platform cap, public held /
  now public / canceled, bypass) with escaping and 120/300 char cuts; footer reason;
  `recipients.ts` worked out at send time (owner, project admins, deploy authors with
  `deploy`, requester while `settings`, installation admins); outbox in the scheduler
  alarm: dedupe key, 30-min findings cooldown per project, merged scan authors, attempts
  ×3 with backoff, skip quietly when `EMAIL` unbound.
- Tests: unit `email.test.ts` (new templates; never a bypass line in the held-urgent
  email), `security-notifications.test.ts`; integration `security-recipients.test.ts`
  (#25, #27, #46–#48, #69, #70).
- Exit: one email per scan; bypass email to every installation admin.
- As built: copy is pure in `security/notification-copy.ts`; the senders are in `email.ts`
  (`sendSecurity*Email`, subject prefix is `[<platform display name>]`, so `[Void Cloud]` on
  the hosted platform, not a fixed `[Void]`); `security/recipients.ts` works out who gets
  what at send time (suspended or email-less users skipped, one email per person and per
  address, reason order requester, owner/admin, author); `security/notifications.ts` has
  `enqueueSecurityNotification` (dedupe key per spec §12), the cap helpers and
  `runSecurityNotifications`, which the scheduler alarm runs after each queue pass and
  re-arms for the next due row. Rows are queued in the same transaction as the change: findings
  at ingest (`news` non-empty), human reopen of an urgent finding (`reopenSecurityFinding`,
  route pokes the scheduler), 80/100% after a model call settles (`notifyCaps` dep in the proxy)
  and 100% when a scan is `skipped:budget` (`onBudgetRefused` dep of the queue pass: a hold
  keeps `spent + hold ≤ cap`, so spend alone may never reach 100%). Public and bypass kinds
  have senders, builders and `enqueueSecurityNotification` inputs; **M16 calls them**.
  Deviations: (1) the table has no column for the new-finding ids, so the findings email
  rebuilds them at send time from the scan's `created` / `promoted` / `reopened` /
  `severity_changed` events (open, confirmed, not informational; reopened and raised ones only
  while urgent). A raise to critical counts as new there even when the finding was already high (ingest's own `news` is stricter). **Decision:** keep it. The event stores no old severity, so the email cannot tell high→critical from medium→critical, and a schema change is not worth it for a rare second email that reports a worse finding. A test pins it (`security-recipients`).
  (2) Cap, reopen and public rows keep their parameters in the dedupe key (no schema change);
  a held row whose request left that state, a cap-80 row whose cap was raised, a finding
  resolved since, and rows older than 7 days are dropped unsent. (3) Retries: 1 min, then 5
  min, third failure is `failed`; a recipient that failed while another got the email is
  logged and not retried (no double send). (4) `EMAIL` unbound marks every pending row
  `skipped` (a later "on" does not replay old news). (5) The hourly maintenance pokes the
  scheduler while any row is pending, also with the policy Off. (6) Unit
  `security-notifications.test.ts` covers keys, retry constants and the copy helpers; the
  database cases (recipients #25 #27 #46–#48 #69 #70, cooldown, merge, retry, email off, bypass
  to every installation admin) are in integration `security-recipients.test.ts`. (7) Tests that expected the old default model and scan limits (commits 9727781b8 and
  8d3a1a067) now name the new default, or pin glm where they price a glm reserve. (8) A crash
  between the send and the row update leaves the row pending, so the email goes out twice
  on the retry. Accepted: an email twice beats an email never, and no test covers it. (9)
  Test clocks: a row is due from the database clock at its insert, so tests that pass a
  time start it a few seconds ahead.

**M16 Scan before public (gate).**

- Scope: `publicGate` turn-on/off in the policy POST (conditions + copy spec §5.5;
  holds `lockZeroTrustConfiguration(shared)` and re-reads ZT); strict `publicGate`
  read inside `claimConfiguration` → 409 `security public gate on` / 503 for disable
  and public-only; `security/public-gate.ts` (`requestPublic`, `judge`, `recheck`,
  `bypass`, `cancelOpen`, `cancelAll`); `checkpointProjectReconciliation` hook with the
  new `publicRequestId` option; `setProjectZeroTrustProtection` returns
  `{row, publicRequest, held}` and `protect` with an open request only cancels (no
  reconcile). Re-check triggers: request, ingest, resolve/reopen, after
  `commitCutoverLive` commit (moves `target_deployment_id`), rollback tx in
  `routes/projects.ts` (moves target, re-check after commit), bypass, hourly backstop
  after `reconcilePendingProjectZeroTrust` (own query on open requests, flips only when
  the full reconcile fits the routing budget; on roll-forward cancels requests whose ZT
  row changed after creation). Exposure catch-up in `maintenance.ts`. Gate errors as a
  new error type (not `ZeroTrustUnavailableError`). Project routes: GET adds
  `publicRequest`/`publicGate`; PUT answers 202 with the old-CLI-safe `state:'reconciling'`
  - held line; new `POST …/public-request/bypass`. Operator `zero-trust/projects/:id`
    and admin form go through the same path with `requested_via` and actor.
- Tests (integration, nearest suites copied): `security-public-gate.test.ts` (states
  and transitions; #54–#62, #65–#68, #79–#85, #88, #91–#92), `security-gate-bypass.test.ts`
  (#72, #89, #93, #94: bypass races under the lock), `security-gate-zero-trust.test.ts`
  (disable / public-only refused, turn-on race — #64, #90; strict reader 503),
  extend `zero-trust-surface.test.ts`, `zero-trust-deploy-admission.test.ts` (deploys
  keep working while held — D45), `zero-trust-disable-bypass.test.ts`; unit
  `security-gate-judge.test.ts` (pure judge function over scan + findings + deployment).
- Exit: invariant tests: no flip without pass or bypass; no bypass with urgent open;
  no deploy ever refused because of a request.
- As built: pure judge in `security/public-gate-judge.ts` and copy in `public-gate-copy.ts`;
  tx-level code in `public-gate.ts`; drivers (re-check, bypass, hourly backstop) in
  `public-gate-flow.ts`, split so `zero-trust/project.ts` has no import cycle. The checkpoint
  takes `gate: ask | flip | bypass` and `requester`; `reconcileProjectZeroTrustGated` returns
  `{row, publicRequest, held, skipped}`. Lock order is project row, ZT shared, policy shared;
  the policy writer takes ZT shared first when turning the gate on. `security/exposure.ts`
  holds the exposure catch-up, run by `maintenance.ts` under `public` mode.
  Deviations: tests are fewer than listed. Built: `security-gate-judge.test.ts` (unit),
  `security-public-gate.test.ts` (ask, hold, pass, bypass, protect-cancel, ZT disable
  refused), `security-exposure.test.ts`; existing suites updated for the new
  `setProjectZeroTrustProtection` result and GET fields. Not built yet:
  `security-gate-bypass.test.ts`, `security-gate-zero-trust.test.ts` (race cases #64, #72,
  #89, #90, #93, #94, strict reader 503), and the `zero-trust-deploy-admission` and
  `zero-trust-disable-bypass` extensions. Review round: the hourly backstop judges every
  picked request (holds need no budget), rotates by touching `updated_at`, and shares the
  cron run's routing budget with `reconcilePendingProjectZeroTrust` (passed from `scheduled`);
  a pass with too little budget commits its checkpoint and the project stays reconciling,
  as the checkpoint already does. Any `trigger=exposure` scan of the live deployment stops
  further catch-up scans. `held_reason` for a failed gate scan is `failed_installation` or
  `failed_project`; copy varies on it. Still not built: the race tests (#64, #72, #89, #90,
  #93, #94, the two lock-based races), the strict-reader 503, the rollback retarget test and
  the operator 202 and dry-run shapes; the route test covers 403, 422 and 409 only.
  The scheduler poke after the hourly backstop runs only when a request was judged.

**M17 Operator security routes (rest).**

- Scope: `operator/security-routes.ts`: budget GET/POST, findings, scans, rescan (T3,
  never `no changes`, cost preview — #43), cancel, public-requests, bypasses, project
  findings resolve/reopen/comments, model, budget, public-request bypass. Paging with
  the existing `pagination()` (page/limit). All writes POST + dryRun; audit targets.
- Tests: integration `operator-security.test.ts`, `operator-audit.test.ts`.
- Exit: every route in spec §13.5 operator row exists and is audited.
- As built: routes in `operator/security-routes.ts`, logic in `security/operator.ts` (so the
  admin panel can call it). Added to the M4 routes: `GET/POST /security/budget`, `GET
  /security/{findings,scans,public-requests,bypasses}`, `POST /security/scans/:sid/cancel`
  (DO RPC `cancelScans`, reason `operator_canceled`), and under `/projects/:id/security`:
  `GET findings/:fid` (added for the CLI `show`), `POST findings/:fid/{resolve,reopen,comments}`,
  `POST scans` (rescan), `POST model`, `POST budget`, `POST public-request/bypass`. Reads stay
  open with the capability off; scans, cancel, model, budget and rescan answer 501. Lists use
  `page`/`limit`; findings and public requests list oldest first, scans and bypasses newest
  first. The scans list carries the month totals (metered, gateway, refused, failed, skipped
  for budget). Budget body: `platformMonthlyUsd` and `projectDefaultMonthlyUsd`, a number
  (cap on at that amount) or `null` (cap off), by `expectedRevision` under the policy lock
  (same revision as the policy, so the two writers never overwrite). The project budget route
  sets the per-project ceiling (`cap_ceiling_cents`, event `cap_kind=ceiling`, actor
  `installation_admin`). Previews of finding, model and ceiling writes run the real write in a
  transaction and roll it back (`previewInRollback`), so they fail wherever the write fails.
  Finding writers take `actor: 'installation_admin'` (no project role checked or recorded).
  Rescan: a `trigger=rescan` row, `queued`, reading the live deployment's snapshot
  (`findLiveInput`); refuses when the capability, policy or scope is off, nothing is live, the
  code is gone, or a scan already waits or runs (409, own codes). The preview is the cost check:
  `alreadyScanned`, `tier: full`, the model, `worstCaseUsd` (the reserve at list price) and the
  budget view; the CLI confirms from it. Deviation: spec §13.3 says a live deployment with no
  succeeded scan diffs from the base as usual; `chooseSecurityTier` makes every `rescan` a full
  scan (as the plan says), so that case also runs T3. Bypass: `gateBypass` writes its own
  `operator_events` row only for project members now; an installation admin's bypass is audited
  by the operator API (or the admin panel), so there is one row, not two. A Zero Trust not
  ready refusal maps to 409 `zero trust not ready`. Audit targets (`operator/audit.ts`) are ids,
  known values and numbers only: no comment, reason or note text; `security/probe` now records
  `{installation:'platform'}`.

**M18 Admin panel.**

- Scope: Security nav item with unseen-bypass badge; banner slot in `Layout` through
  `renderAdminPage` and fate renders (probe failing, platform cap); screens Settings
  (with previews), Findings (Urgent filter, oldest first), Scans (metered + gateway
  cost, top 5 spenders, silent-gap flags), Public requests (+ bypass list); Project
  detail Security section; Zero Trust page greys Disable/public-only;
  `ProjectZeroTrustSection` request state, Cancel, Bypass form. All writes through
  `executeAuditedMutation`. Regenerate `client.generated.ts`.
- Tests: integration `admin-security.test.ts`, extend `admin-zero-trust-actions.test.ts`;
  unit view snapshots where the admin suite already has them.
- Exit: every PRD §10.6 item reachable; no comment or reason text in audit rows.
- As built: data in `admin/security-data.ts` (one Fate source `AdminSecurity` with a
  `section` for the four pages, so the pages are `/admin/security`, `/findings`, `/scans`,
  `/requests`); writes in `admin/routes/security.ts` (`/admin/security/*` and
  `/admin/projects/:id/security/*`, the latter mounted beside the project routes with a guard scoped
  to its own paths). Every write calls the operator function (`changeSecurityPolicy`,
  `changeSecurityBudgets`, `setProjectSecurityModel`, `setProjectSecurityCeiling`,
  `queueSecurityRescan`, `bypassPublicRequest`) inside `executeAuditedMutation`; policy and
  budget forms post twice (`step=preview` renders the `securityPreview` page from the real
  `dryRun`, `step=apply` writes). Banner and badge: `renderAdminPage` puts `securityChrome`
  into the shared page data (read only while the capability is on, never throws) and `Layout`
  reads it with `useShared` (guarded, because the navigation fallback renders the shell outside a
  Void page). "Unseen" bypasses use a per-admin `platform_settings` row
  (`security.bypasses-seen.<userId>`) and an explicit "Mark all as seen" button, audited as
  `security/bypasses-seen`; no new table. "Cancel request" is the existing `protected=true` form.
  Deviations: (1) no finding detail page, resolve, reopen or comment forms in the panel (the plan's
  M18 scope lists none; the operator API has them); (2) the probe banner says "failing (checked
  <time>)" because the policy stores the last check time, not when it began to fail, and the cause
  text comes from the failed check name; (3) the silent-gap flags are the 3-project-cause-failures
  streak and the installation failure rate over 20% in 24 h; the "protection changed 2+ times in 7
  days" flag has no stored history to read, so it is not built; (4) Findings sort is the operator
  list order (oldest first), with the Urgent preset as a filter, not "urgent first"; (5) the
  "public-only switch" on the Zero Trust page is not a control in the admin form (blank fields only
  re-save an installation that is already public-only, which the gate cannot coexist with), so only
  Disable is greyed out; the server refusals are unchanged. `client.generated.ts` is regenerated
  with `node platform/packages/api/scripts/build-admin-client.mjs`.
  Review round: (a) "Mark all as seen" posts the newest bypass time the page listed (`through`);
  the server clamps it to the newest real `created_at` and stores the first millisecond after
  that row, so neither the app clock nor database microseconds can hide or re-show a bypass, and
  a bypass made after the page loaded stays new. (b) The admin bypass route is deliberately open
  with the capability off, like `POST /projects/:id/security/public-request/bypass`: held
  requests are no longer re-checked while the capability is off (the backstop returns early), so
  the bypass is how an admin releases one. Model, limit and rescan routes stay 501. (c) Deviation 1
  is a real gap against spec §13.1, which lists a finding detail page with a comment box and
  Resolve / Reopen. The panel does not have them; use the operator API or CLI until a later
  milestone adds them.

**M19 Signed project page.**

- Scope: `page-token.ts` (HMAC, own purpose label, 15 min, user + project);
  `routes/security-page.ts` at `/security/projects/:slug` mounted next to `/email`
  without `/projects` auth; token → HttpOnly cookie (path-scoped, Lax, 15 min) →
  redirect; access re-checked each load; landing page without token; `no-store`,
  `no-referrer`; role-based content; all values escaped.
- Tests: integration `security-page.test.ts` (expired, other user, other project,
  reader view, behind platform Access — extend `platform-access-protection.test.ts`).
- Exit: page renders for each role with no data leak.
- As built: `page-token.ts` already existed from M14. Route in `routes/security-page.ts`, mounted
  in `index.ts` as `/security/projects` right after `/email` (no capability middleware, so a
  platform with audits off still shows "Security audits are off on this platform." to a signed-in
  member); data and HTML in `security/project-page.ts` (`loadSecurityPage` reuses
  `projectSecurityStatus`, `listSecurityFindings`, `listSecurityScans`, `openPublicRequestView`,
  so the page and the API cannot disagree on detail level). The cookie `void_security_page`
  holds the same signed token (Path = the clean URL, HttpOnly, Lax, Secure on https, Max-Age =
  the token's remaining life); redeeming answers 303. Each load re-reads the user (missing or
  suspended) and the member role; any failure, an unknown slug, a token for another project or
  no cookie gives the same landing page. A bad `?t=` is a 400 "This link no longer works".
  Access protection is NOT relaxed for this route: behind platform Access the company
  identity is still required (a link alone, or a service token, gets 403). The page is
  read-only; findings and the open lists show at most 100 each, scans at most 10. Resolve and
  budget commands use `F-1`/`--usd 100` examples; the budget line shows only for deploy-level
  roles. CSS is an inline `<style>` in the content that widens the shared card to 860px.

**M20 CLI `void project security`.**

- Scope: parser, `project-security.ts` printers and `--json`, client methods with
  `permission`, 404-without-JSON → "does not support", 409/422 copy, length checks,
  `open` (TTY and not CI), terminal sanitizing. Help, hint, usage.
- Tests (unit): `project-args.test.ts`, `project-security-command.test.ts`,
  `cli-help.test.ts`, `project-lookup-client.test.ts` (404 split).
- Exit: mock replies print the spec §13.3 copy.
- As built: `project-security-args.ts` (parser, no regex), `project-security.ts` (printers and
  runner), `security-api-types.ts`, client methods `*ProjectSecurity*` with `securityApiError`: a 404 with
  no JSON body is "does not support security audits"; a 404 with JSON stays an API error; the
  platform `message` replaces the generic text for 400/409/422/501/503. Resolve reads the finding
  for its revision, then posts (one call per id; a failure on one id does not stop the rest, the
  command then fails). The model flag `--accept-provider-notice` first sends version 0, which the
  platform refuses with the current version and notice; the CLI prints the notice and resends.
  `list` hides leads unless `--leads`. **Deviations:** (1) `GET /projects/:id/security` returned
  `publicRequest: null` since M14; it now returns the open request (route change), so `status` can show
  the `Public` line. (2) The M19 page said `void project security findings`; the command is
  `list` (page text and its test fixed). (3) `status` cannot know the caller's role, so the
  public request lines always name the next command; a caller without `settings` gets the 403 copy
  when running it. (4) `--usd` is capped at 10000 in the parser (the API limit); a project ceiling
  comes back as the platform's 422 copy.

**M21 CLI `void project zero-trust` changes.**

- Scope: `bypass --reason [--yes]`, `--json` everywhere, 202 held output (never "is
  public"), status request block, error copy; project error JSON in `cli-main.ts`.
- Tests: `project-zero-trust-command.test.ts` (old platform unchanged; 202; bypass
  409s), `project-args.test.ts`.
- Exit: old-platform replies print exactly as today.
- As built: parser `parseZeroTrustArgs` in `project-args.ts` (`--json` on every action,
  `--reason` and `--yes` only for `bypass`; reason checked locally, 1 to 4000 characters).
  Every parsed zero-trust args object now carries `json`. A reply with an open
  `publicRequest` (waiting_scan, held_*, needs_deploy) from `public` prints the platform
  `message` (or the local copy), then "stays protected"; it is checked before the
  `reconciling` branch, so the old-CLI stand-in `last_error` never prints. `--json` of a held
  reply adds `held: true` and shows the stored state (`protected`, no `last_error`) instead
  of the stand-in. `status` adds a `Public request:` block (and one best-effort security GET
  for backlog and budget). `bypass` reads the request first (none → "has no public request to
  bypass"; old platform with no field → the bypass route's 404 gives "does not support security
  audits"), confirms unless `--yes` (no prompt in CI, non-TTY or `--json`: "Add --yes"),
  and turns the 409 `security public request has urgent findings` body into the spec copy.
  `held_findings` skips the prompt (nothing is skipped; the server refuses). `cli-main.ts`
  prints `{error,message,status?}` on stderr for failed `project zero-trust|security --json`
  runs. The `project` hint text lists `bypass`; `docs/reference/cli.md` row updated (full
  docs wait for M24).

**M22 CLI deploy notice and `project status` line.**

- Scope: `deploy-security-notice.ts` called after `printDeploySuccess` in all three
  managed paths; one GET with 5 s abort; any error prints nothing; never touches
  `process.exitCode`; 5 rows + "… and N more"; counts only in CI/GitHub Actions or when
  the server says `counts`; extra lines (spec §6.5); cliLog entry. `list.ts` Security line.
  Deploy `--json` row is not built (R4).
- Tests: `deploy-security-notice.test.ts`, `list-command.test.ts`, native regression
  in `cloudflare-deploy.test.ts` (no `/security`, no `/containers/`, no AI binding).
- Exit: 404, timeout, 500 → no output, same exit code.
- As built: `deploy-security-notice.ts` exports `printDeploySecurityNotice` (called after
  `printDeploySuccess` in `runStaticDeploy`, `runFrameworkDeploy` and `runFullDeploy`; the
  full-to-static redirect reaches it through the static path, so it prints once). It skips only `preview-*`.
  `published === false` means the deploy is committed live but routing was not published, so it
  still gets the notice (spec §11.1 excludes only failed deploys; a failed deploy never reaches the
  call). One shared quiet reader
  (`readSecurityStatusQuietly`: 5 s abort signal passed through `PlatformClient.getProjectSecurity`,
  plus a hard race 250 ms later) serves the deploy notice and `list.ts`; any error or an unusable
  reply gives `null`, and the notice logs `security_notice` / `security_notice_skipped` to the
  cliLog. Scan lines come from the same reply: they show only when `lastScan.deploymentId` is the
  deploy just made (queued/running/pending_input, skipped budget or protected, `no_changes`),
  so there is no extra request. The "did not finish" warning shows for a refused, timed-out or
  failed earlier scan. Counts-only output when the server says `counts` or `CI` /
  `GITHUB_ACTIONS` is set. Rows: the server's findings re-sorted critical first, then
  oldest `firstSeenAt` first (a missing date keeps the server order), 5 at most, rest as
  "… and N more". The queued case ends with `Check it:  void project security status`. The
  "A project admin or owner can resolve them" line always prints. Known gap: spec §11.1 wants
  `Fixed?  void project security resolve F-12 --reason fixed --comment "…"` for a caller with
  `settings`, but neither the `/security` reply nor the project response carries the caller's
  role (`requestedByRole` is the requester's). Closing it needs the server to add the caller's
  permission to the reply. `void project status` prints the `Security` line above the
  deployment table, only for managed platforms (the direct Cloudflare listing has no security).
  `cloudflare-deploy.test.ts` gained one regression: a native deploy makes no `/security` or
  `/containers/` request, no `containers` Wrangler call and emits no `ai` binding.

**M23 CLI operator group, installer flag, uninstall.**

- Scope: `group:'security'` entries (status, probe, policy, models, limits with
  `--scan-timeout`, budget, findings with `--urgent` moved to the query,
  show/resolve/reopen/comment with comma F-ids, model, scans, rescan, cancel,
  public-gate, public-requests, bypass, bypasses); paged list in `operator-args.ts` and
  `help.ts`; `outputMutation` treats an open `publicRequest` as not completed.
  `--security-audits` on install and upgrade (and repair, like `--custom-domains`),
  plan merge step, resume command, runtime guard; token link adds containers +
  cloudchamber when on. Uninstall deletes the scanner Worker + container app (R11).
- Tests: `operator-cli.test.ts`, `platform-args.test.ts`, `platform-plan.test.ts`,
  `platform-management-upgrade.test.ts`, `platform-setup.test.ts`,
  `platform-teardown.test.ts`, `cli-help.test.ts`.
- Exit: `void platform security --help` tree generated; old runtime refused.
- As built: the group lives in `operator-security-args.ts` (table + `applySecurityArgs`) and the
  runner in `operator-security.ts`; `operator-args.ts` spreads the table after `zero-trust`.
  `OperatorCommand` gained `paged` (security lists take `--limit`/`--page`; `help.ts` reads it) and
  `noConfirm` (the probe: one POST, no preview, no `--plan`/`--yes`, because its route has no dryRun and
  a preview would run it). Projects are addressed by id (`<project-id>`), like every operator command;
  `--project` filters take an id or a slug. `--default` is a value for `models` and a switch for
  `model`: `booleanFlagsFor` treats a name as a switch only for the command that declares it as one.
  Spec `--timeout MIN` is `--scan-timeout` (`--timeout` is the request deadline, as the plan says).
  `budget` follows spec §13.4: no flags reads (GET), any cap flag writes (POST); `applySecurityArgs` picks the
  method per call. Uninstall treats a 403 or 404 on the container application list as nothing to remove when the
  controller does not exist; with a controller it still fails.
  Policy-shaped writes (`policy`, `models`, `limits`, `public-gate`, platform `budget` with cap flags) preview, show
  the preview without the stored policy, then apply at the previewed `expectedRevision`.
  `--accept-provider-notice` reads the version from `GET /security/policy`. `--project-caps on` with no
  amount applies the saved default (read from `GET /security/budget`); `--project-default-usd N` also turns
  project caps on, since the route has one field for both. Finding commands take comma ids, read each
  finding's revision, preview every id first, ask once, then write one by one; a failed write is reported
  and the command exits with `partial_failure`. `rescan` prints the model, the reserve and whether the
  live deployment was scanned before it asks (spec §13.4 text). A 501 `platform capability unavailable`
  reads `Security audits are not installed. Run: void platform upgrade --security-audits`.
  `outputMutation` prints no success line while `publicRequest.state` is open.
  Installer: `--security-audits` on install, upgrade and repair (`platform-args.ts`); `createPlatformInstallPlan`
  sets the capability and merges it onto a recorded manifest together with schema 7 (otherwise the drift
  check would fail on the version); resume command, saved-plan guard and help text carry it; the runtime
  guard `assertPlatformSecurityAuditsSupported` (`platform-security-audits.ts`) runs in the lifecycle, the
  management upgrade and the installer, before anything changes. The runtime token link adds Containers +
  Cloudchamber when Sandbox or security audits are on; the management token link adds them for security
  audits too, because uninstall deletes the container application with the operator credential.
  Uninstall (plain and `--purge-resources`): with the capability on, after traffic is disabled and before
  any Worker is deleted, `deletePlatformSecurityScanner` removes the gate, the container application and
  the controller, each found by its derived name and proven by the ownership marker. An object with
  another installation's marker, or an application whose controller is gone or of another namespace, is
  kept and named in a warning. Any other API error fails the uninstall (re-run it). With the capability off
  it makes no call. The CLI cannot import the API's provisioning code (public packages never import
  `platform/`), so `securityScannerNames` and the marker are re-derived there; a test pins the name rule.
  Deviations: the plan did not name `platform-management.test.ts` / `platform-security-audits.test.ts`; the
  uninstall and scanner-teardown tests live there. No full-run docs page yet (M24); the reference page
  `docs/reference/cli/platform-security.md` and the `cli.md` row carry the commands (AGENTS.md CLI rule).

**M24 Phase 1 docs.** See Docs below. Exit: `vp check`, docs links resolve.

As built (M24): all Phase 1 rows of the Docs table are done. `platform-security.md`, the `cli.md` rows and
the `--security-audits` row of `platform-installation.md` already existed from M20-M23 and were kept. New:
`docs/guide/platform/administration/security-audits.md` (also linked from `platform-administration.md` and
the sidebar). Deviations: scan data sits under `security-scans/` in the platform R2 bucket, so the uninstall
page says it follows the bucket rule (`--purge-resources`), not `--purge-data` (R11). The `Security` status
line is in `void project status`. The credentials row names Workers AI Read, the permission the probe copy asks for.

### Phase 2

**M25 Project rescan, admin backfill, scheduled sweeps.** `POST /projects/:id/security/scans`
(`settings`; same rule as operator rescan, cost confirm), `void project security scan`,
operator `security backfill --plan` (cost preview, queued as `trigger=backfill`), policy
`sweeps: {on, everyDays}` run by the hourly job as `trigger=sweep` with the skill
`standard` profile. Tests: `api-project-security.test.ts`, `security-sweeps.test.ts`,
`project-security-command.test.ts`.

As built (M25):

```
project admin ─ void project security scan ─► POST /projects/:id/security/scans (settings)
operator ────── void platform security rescan ─► POST /operator/v1/projects/:id/security/scans
                                    both ─► previewSecurityRescan / queueSecurityRescan
operator ── security backfill ─► POST /operator/v1/security/backfill ─► trigger=backfill
hourly job ── policy sweeps.on ─► queueSecuritySweeps ─────────────────► trigger=sweep
backfill + sweeps: scan-candidates.ts (SQL list) ─► queueSecurityRescan per project
```

- Project rescan: same checks and the same `trigger=rescan` row as the operator rescan
  (`security/operator.ts` gained `{ trigger, by }` options). `dryRun: true` is the cost
  confirm (model, `worstCaseUsd`, budget). The busy refusal says "Wait for it to end." to a
  project caller (only an operator can cancel). `OperatorError` from those checks is mapped
  to the project error shape in `routes/project-security.ts`. CLI `void project security scan
  [--yes]` prints the operator rescan question; `--json` and non-interactive shells need
  `--yes`. Not recorded in `security_project_events`: that needs a new action value and a
  migration; the scan row itself is the record.
- Backfill (`security/sweeps.ts`): in-scope projects whose live deployment has no succeeded
  scan and nothing waiting, owner not suspended, at most 50 per call (`remaining` says how many
  wait; run it again). It uses the base rule (diff from the last good base; full only for a
  first scan), not a forced full scan: an unscanned live deployment is what a deploy scan would
  have covered. Policy Off refuses (409 `security_not_in_scope`). Audited as
  `{installation, backfill: true}`.
- Stored code (backfill and sweeps): the candidate SQL keeps only live deployments with
  `bundle_stored` or a scan row whose `input_r2_key` is set (the SQL side of
  `findLiveInput`; every snapshot writer records its key on a row). Without it a project
  live since before audits were on is refused every run and, holding the head of the list,
  blocks the batch. They are counted apart as `noStoredCode` (backfill preview and result,
  printed by the CLI). The list reads 10 past the batch size and stops once the batch is
  queued, so a refusal at queue time (R2 object lost under its row) does not take a slot.
- Sweeps: policy `sweeps: {on, everyDays}` (7–90, default 30, off by default) in
  `@void/platform/security-policy`. A row saved before M25 reads as off; the lenient reader
  reads bad sweeps data as off, so it never starts paid scans. Set with
  `void platform security sweeps <on|off> [--every-days N]` (a policy change with preview:
  projects due now). A project is due when it has no `trigger=sweep` row (any end, so a
  failed sweep waits for the next window, except one that never ran: `superseded` by a deploy
  scan, or `canceled` by policy Off; an operator cancel counts) and no succeeded `tier=full`
  scan within `everyDays`. The preview says "Turn on", "Turn off" or "Sweep interval: X → Y
  days" for an interval-only change. The hourly job queues at most `min(10, 2 × concurrency − waiting)` a run,
  never-swept first, only while the policy is not Off. Sweeps are `tier=full` with coverage
  note `sweep` (label `full scan (sweep)`) and use the deployment stale-scan rule (only an
  explicit rescan uses the started-after rule).
- `standard` profile: the skill is still not vendored (R5), so it is our own runner profile.
  `task.json` gets `profile: "standard"` for sweeps only. The runner runs one hunt session per
  focus area (access, injection and bindings, exposure) over the whole app, at half the session
  turn limit each, merges candidates by fingerprint keeping the strongest record (confirmed,
  lead, rejected, then severity: one area's rejection never hides another's confirmation),
  then the usual verify step (indexes stay unique: verify follows the hunts). Three hunts can
  return more than one report holds (1000 records, 5 MB): a final list that does not fit
  ends `incomplete` with only verified confirmed findings, instead of failing as
  `bad_output` (the check is shared, a no-op for deploy-diff in practice). An unreadable hunt costs its area and ends `incomplete`; a
  refusal or a cap stop in any hunt ends the scan as in deploy-diff. A runner that does not know
  the profile runs deploy-diff; the published Engine A/C images keep doing that until they are
  rebuilt with this runner.
- Deviations: the plan named only three test files; also changed `phases.test.ts`,
  `security-input-t2.test.ts`, `security-policy.test.ts` (platform package),
  `operator-cli.test.ts` and `operator-audit.test.ts`. Docs: only the CLI reference rows and
  pages (`cli.md`, `cli/project.md`, `cli/platform-security.md`, AGENTS.md CLI rule); the guide
  pages stay for M36.

**M26 Fallback, failure-streak emails, digest, webhooks.** Policy `fallbackToCf` (opt-in,
never `@cf` → third party) → one `trigger=fallback` scan after refused / bad_output /
timed_out; streak email to installation admins split by cause; weekly digest; webhook
URL (signed body, ids and counts only). Tests: `security-fallback.test.ts`,
`security-notifications.test.ts`.

As built (M26):

- Fallback: only third-party → `@cf` default (`securityCfDefaultModel`), one per failed
  scan, never a fallback of a fallback or of a `local` scan. Eligible: `refused`,
  `timed_out`, `failed` + `bad_output`, still the project's newest scan, its deployment
  still live, ended < 24 h ago. It uses the base tier rule, except that a fallback of a
  rescan or a sweep is that full scan again (a `rescan` / `sweep` coverage note set at
  queue time, read by `chooseSecurityTier`; a sweep's also gets the `standard` profile).
  Queued right after ingest and by the hourly backstop (covers reaper `timed_out`; the
  cron runs it before the public gate backstop). A fallback of a gate scan carries the
  open `public_request_id`, so it is still claimed under `public` and keeps the gate
  rule that it is never `no changes` (edge #85). `security/fallback.ts`.
- Streak emails are always on (no setting); the digest is opt-in (`policy.digest`,
  default off). Both are queued hourly (`security/alerts.ts`).
- Project-cause streak (≥ 3 ended scans in a row failed, newest < 48 h old) → owner +
  project admins + installation admins (spec §12; the line above said installation
  admins only). Skipped scans neither count nor break a streak (as the panel flag).
  Once per streak: the key is the newest non-failure scan before it, and no row is
  queued while the project has a `streak_project` row newer than its last good scan
  ended (the key can move past the 50-scan window or after retention). Skipped at send
  time if the streak already ended.
- Installation-cause flag: ≥ 3 installation-cause failures (`failure_cause =
  'installation'` or `skipped:backlog`) and > 20% of ended scans in the last 24 h →
  installation admins, at most once per UTC day.
- Digest: last full UTC week (Monday to Monday), counts only; an empty week sends nothing.
- Webhook: its own `platform_settings` key `securityAudits.webhook` (kept out of the
  policy) with a random secret, stored encrypted and shown once by `void platform
  security webhook <https-url|off>` (`POST /security/webhook`). Each outbox event gets a
  `webhook` twin row, sent even with no EMAIL binding. Body: ids and counts only;
  `X-Void-Signature: t=<s>,v1=<HMAC-SHA256("<t>.<body>")>`, `t` taken at send time; no
  redirects, 10 s timeout, outbox retries. After one failed POST the pass holds its other
  webhook rows for the first backoff, so a dead endpoint costs one timeout per pass. Audit keeps only the host. The milestone map lists webhooks under
  M31; they are built here as this section says.
- CLI: `void platform security fallback <on|off>`, `digest <on|off>`, `webhook`.
- Migration 0065 (unreleased) was edited in place for the new notification kinds; no 0066. Extra tests: `security-alerts.test.ts`. No admin panel change.

**M27 Per-plan caps.** Stored in a separate settings key `plans:security-caps`
(`{ <planId>: usdCents | null }`), not in `PlanLimits`, so the exact-key catalog parser
and rollback stay safe (same reason as `plans:ai-logging` in 0094). Ceiling order:
project ceiling → plan cap → policy default. Operator `config plans` gains
`--security-cap`; admin Plans page shows it. Tests: `security-budget.test.ts`,
`operator-plans.test.ts`, `admin-plans.test.ts`.

As built (M27):

```
plans:security-caps = { pro: 5000, lab: null }      missing plan = inherit
                         │
ceiling(p) = project limit (cap_ceiling_cents) ─► plan cap (cents | none) ─► policy default (caps on) ─► none
effective(p) = lower of ceiling(p) and the project's own cap
readers: scheduler reserve · model proxy (each call) · status/budget view · cap emails · budget PUT
         all via securityPlanCapSql(projects.user_id)  (security/plan-caps.ts)
```

- Three states per plan: whole cents, `null` = **no cap** (stored JSON null; overrides the
  policy default, so a plan can be uncapped while project caps are on), missing =
  **inherit** (the policy default while project caps are on). A numeric plan cap applies
  with project caps off too: an admin set it for that plan on purpose. A per-project limit
  still comes first. Nothing is published: every reader looks it up through one correlated
  subquery (`->` gives SQL `NULL` only for a missing key), so a change applies to the next
  scan start and the next model call.
- Shared parser in `@void/platform/security-policy` (`PLAN_SECURITY_CAPS_SETTING`,
  `readPlanSecurityCaps`, `parsePlanSecurityCapInput`, `planSecurityCap`,
  `withPlanSecurityCap`, `formatPlanSecurityCap`), so the CLI and API read one shape.
  Lenient on read: a bad entry (or a non-object row) reads as `inherit` and logs
  `[security] plan caps: ignored invalid entries`; it never blocks plan edits or scans.
- An account on a plan missing from the catalog has no entry, so it gets the policy
  default (AI logging uses the signup default plan instead; caps keep the simpler rule).
  `remove` drops the removed plan's entry (accounts move to the replacement and get its
  cap); `add` copies the source plan's cap unless `securityCap` is given; `reset` keeps it.
- Plan API: body field `securityCap` (USD number, `"none"`, `"inherit"`) on `add` / `set`
  only, written under the plan lock in the same transaction as the catalog (fresh read
  through a no-op `UPDATE`). Dry run and result carry `securityCaps: {caps, capsBefore}`;
  `GET /config/plans` returns `securityCaps`, `GET /config/plans/:id` returns `securityCap`.
  Audit keeps `securityCap`.
- CLI: `void platform config plans add|set <id> --security-cap <usd|none|inherit>`, file
  field `securityCap`, interactive picker entry, preview line `Security scan cap: X → Y`,
  `show <id>` line. Refused before any request on a platform that does not send
  `securityCaps`.
- Admin: Plans list column and edit field (mode selector + USD text field, cents allowed)
  shown only while the `securityAudits` capability is on; like the AI logging selector,
  only a changed value (against `securityCapInitial`) is sent. The review table shows the
  change.
- Budget view gained `ceilingSource: 'project' | 'plan' | 'default' | null`; the admin
  project section and `void project security budget` name where the limit comes from.
  `capSource` is unchanged (old CLIs keep working).
- Deviations: also changed `security-policy.test.ts` (platform package),
  `platform-plans-config.test.ts` (CLI), and the scheduler / model proxy unit fixtures
  (`planCap`). Docs: `cli/platform-config.md`, `cli/platform-security.md` and the
  spending caps section of the security audits guide.
- Review fixes: both budget writers read the plan cap in their `FOR UPDATE` select
  (`securityProjectPlanCapSql`), never a plain read Hyperdrive may cache. A refusal from
  a plan cap says "This project's plan limits it". The Off → on policy preview says only
  plans with a scan cap have a money limit when one does (`counts.planCapped`). The plan
  review table shows the scan cap row only while `securityAudits` is on.

**M28 GitHub `Void Security Audit` check.** Hosted only; `createCheckRun` /
`completeCheckRun` at ingest, conclusion always `neutral`, counts + landing link; PR
comment (counts only); `check_run:rerequested` for this name queues a project rescan
only for callers who could rescan, else no-op. Tests: `security-github-check.test.ts`.

As built (M28):

```
ingest stored (control.ts result / input "nothing to send") ─ waitUntil ─► reportSecurityScanToGitHub
  managedBuilds + securityAudits + GitHub App? ended scan (succeeded/incomplete/failed/refused/timed_out)?
  deployment made by a platform build (container / GitHub Actions), full 40-hex commit_sha,
  deployments.commit null or equal? connection passes installationCoversRepo?
  ├► createCheckRun (in_progress) ─► completeCheckRun (neutral)      external_id = scan id
  └► scoped token {pull_requests: write} ─► open PRs with head = commit ─► edit our comment / post one
check_run:rerequested, name "Void Security Audit" (webhooks.ts) ─► handleSecurityCheckRerequest
  scan (external_id) ─► connection matches installation + repo ─► sender GitHub id ─► Void user
  (oauth_accounts) ─► settings on the project ─► checked deployment still live ─► queueSecurityRescan
```

- `security/github-check.ts`. Reuses `github/check-run.ts` (create, then complete); no new
  column and no outbox kind: a lost check is not retried beyond the helpers' own retries
  (best-effort, as the spec says). Counts are the project's open urgent findings at ingest.
- Which deploys: only one a platform build made. A CLI deploy only claims its commit (GitHub may
  not know it, and the code may differ), so it gets no check; a deploy whose claimed commit is
  not the build's (or its OIDC `sha`) gets none either. `builds` keeps no repository, so a
  build older than the project's connection row (a reconnect replaces it) gets none: a fork or
  mirror could hold the same commit. A reconnect to the same repo loses checks until the next build.
- Which scans: every ended scan that ran. Skipped, superseded and canceled scans send nothing.
  An unfinished scan is never "clean": title `Security scan did not finish (refused)` (or
  `timed out`, or a project-cause `failed` reason: `bad output`, `input missing`), and an
  incomplete one says so in the summary. `credits` and `infrastructure` are the platform's,
  not the user's code, so the title is a plain `Security scan did not finish`. Spec
  §11.3 names only the two counts titles. A scan the reaper times out (no ingest) sends nothing.
- Copy: the spec title and summary, plus the landing link (`/security/projects/<slug>`, also the
  `details_url`). No title, file or line: public repos show check runs to anyone.
- PR comment: open PRs whose head is the commit (at most 5), one comment per project, found
  again by the marker `<!-- void-security-audit:<projectId> -->` on a comment our App wrote
  (`performed_via_github_app` is `GITHUB_APP_ID`, or the `<GITHUB_APP_SLUG>[bot]` login; a
  copied marker is not ours) and edited in place. A new comment only while something is urgent,
  so clean scans add no noise, and only when the whole list was read: a failed read or more
  than 3 pages of 100 skips that PR (logged) rather than risk a second comment. It needs the
  App's Pull requests **write** permission (`operations.md` listed read): without it the scoped
  token cannot be minted and only the check is sent.
- Re-run: the clicker's GitHub account must be a Void sign-in with `settings` (owner or admin),
  not suspended, on a connection the installation still covers, and the check must be about the
  live deployment (a rescan scans the live one, so an old commit's Re-run would not match).
  Then the project rescan rules apply (scope, one scan at a time, stored code; caps at start; no
  cost confirm: the click is the request). Every refusal is a no-op that writes nothing to
  GitHub; the webhook answer names the reason (`sender cannot rescan`, an `OperatorError`
  code); a database error stays a 500. An accepted Re-run writes nothing either: the rescan's result is a new check run.
  `check_suite:rerequested` (Re-run all) does not rescan; it stays a build rerun.
- Deviations: also changed `routes/webhooks.ts`, `security/control.ts`,
  `security-scan-control.test.ts` and `platform/meta/operations.md`. No user docs: hosted
  GitHub checks have no user page yet (M36).

**M29 Page forms and dashboard pages.** Page forms (resolve, comment, model, budget,
bypass) with CSRF (`admin/middleware/csrf.ts` pattern) and the same server operations.
Dashboard: `pages/projects/index.tsx`, `pages/projects/[slug]/security.tsx` (+ `.server.ts`)
via typed `hc<ApiRoutes>`. Tests: `security-page.test.ts` (forms, CSRF),
dashboard page tests in `platform/packages/dashboard/test`.

As built (M29):

```
API page  /security/projects/:slug  (cookie path = page path, so posts below it carry it)
  POST …/findings/:fid/resolve (settings) · …/findings/:fid/comment (configure)
       …/model · …/budget (settings, capability on) · …/bypass (settings)
  Origin, else Referer = our origin (admin CSRF rule) ─► cookie + member re-check
  ─► requireProjectCapability(cap) ─► the API route's server operation
  ─► 303 ?done=<key> (fixed copy)  |  refusal: page again with the reason + its status
Dashboard /projects ─► /projects/:slug/security  named actions ?resolve ?comment ?model ?budget ?bypass
  Origin = dashboard origin ─► API call with the session token ─► 303 ?done=  |  page again with the API reason
```

- API page: `routes/security-page.ts` (posts), forms rendered by `security/project-page.ts`.
  Comment is open to collaborators (`configure`, as `POST …/comments`); resolve, model, budget
  and bypass need `settings`. Resolve re-checks an open public request like the API route; the
  bypass flow pokes the scheduler itself. Model and budget answer 501 with the capability off.
  CSRF refusal (403) comes before the cookie is read; no cookie, an old one or another project's
  gives "This link no longer works" (403). The CLI commands stay on the page under "Or from the CLI".
- Model picker: `securityProjectModelChoices(policy)` (`project-settings.ts`) lists only what the
  model PUT accepts (priced, not blocked, third-party only with its host probed ready), with each
  provider's notice. A third-party pick needs the notice box ticked; the form sends the notice
  version the page showed, so a changed notice is refused. `GET /projects/:id/security` now also
  returns `modelChoices` (additive) for the dashboard.
- Bypass form: shown under the same rule as the bypass command (no urgent finding, request in
  `waiting_scan`, `held_no_result` or `needs_deploy`) and needs a confirm box.
- Dashboard: `pages/projects/index.{tsx,server.ts}`, `pages/projects/[slug]/security.{tsx,server.ts}`,
  `apiClient(context)` in `lib/api.ts` (an `hc<ApiRoutes>` client whose fetch is `fetchApi`:
  token, Access headers, timeout, service binding). Native forms post to named actions, like the
  account page. The slug is resolved through `GET /projects`; a project the user is not a
  member of shows the same "does not exist" line. Readers get no scans request.
- Deviations: (1) hc cannot type the bodies of the project security routes (their access check
  returns a plain `Response`), so `api.ts` exports `ProjectSecurityBody`,
  `ProjectSecurityFindingsBody` and `ProjectSecurityScansBody` (type-only) and the dashboard uses
  hc for paths (`$url`) and these types for bodies. (2) Also changed `routes/project-security.ts`,
  `api-project-security.test.ts`, the dashboard home page (Projects button), its README and
  styles, and two doc lines that called the page read-only (`cli/project.md`, the security audits
  guide). (3) Dashboard tests are unit tests with a stubbed API (`test/unit/project-security.test.ts`),
  as the other dashboard tests are. (4) The page sends `Referrer-Policy: same-origin`, not the
  `no-referrer` of spec §13.2 (M19). Under `no-referrer` a browser sends `Origin: null` on the
  page's own form posts, so the origin check refused every form (as `oauth.ts` found). Other
  sites still get no `Referer`, and the `?t=` token leaves the URL with the 303.
- Review fixes: a bypass whose Access update fails after the bypass committed re-renders the page
  with 502 and says the bypass is recorded, with the reconcile command (the API route's 502 line);
  the dashboard says a bypass that timed out may still go through. The model picker selects the
  saved choice (`modelChoices.saved`), so a project that named the default model keeps it on
  save. A third-party default waiting for its notice shows that notice (`modelChoices.defaultNotice`),
  so the box never asks to accept a notice the page did not show. The dashboard's "admin or owner
  can resolve" line is for collaborators only. Form text is read by small parsers shared from
  `@void/platform/security-policy` (`parseSecurityDigits`, `parseSecurityFindingLabel`,
  `parseSecurityUsdText`), not regexes.

**M30 Runtime checks on a throwaway copy.** Needs S13 pass. Per scan: copy bundle N into
the dispatch namespace as `sec-copy-<scan>` with empty D1/KV/R2, migrations, fake
secrets, stubbed AI/email/queue, outbound blocked by a dispatch outbound Worker,
reachable only from the scan's controller (a second intercepted host
`copy.void.internal`); deleted at scan end and by the reaper. Verdict source
`confirmed (runtime)`; cost in the meter. Tests: unit
`security-runtime-copy.test.ts` (mockCfApi), runner `verify-runtime.test.ts`;
live only for the real copy.

As built (M30):

```
prepare (input tar) ─► task.json runtime_copy: true   (Engine B, Worker app, manifest readable)
controller begin(): runner started, input piped ─► control.copy(scan, attempt)   (bounded, never fails the scan)
  SecurityScanControl.copy ─► fence ─► plan (manifest, secret names) ─► modules from the scan snapshot (R2)
  ─► empty D1 / KV / R2 (parallel) ─► each copy D1 gets the live D1 schema (sqlite_master, no rows)
  ─► PUT void-sec-copy-<h>-<scan>-a<n> into void-security-copies-<h>
       guard module ─► entry module (/__void_copy/ready|d1|kv) ─► deployed modules unchanged
  ─► charge the copy on the scan meter and both month rows
container ─http://copy.void.internal/…─► CopyOutbound (props scan, attempt) ─► dispatch namespace script
  copy fetch / DO fetch ─► guard ─► __VOID_COPY_EGRESS ─► copy sandbox (403)      WebSocket ─► throws
  copy global fetch ─► outbound Worker = copy sandbox (403)
runner verify (Engine B) ─► copy_request tool ─► proof_request "rN" ─► runner checks rN was dispatched
  ─► verdict_source runtime + runtime_proof ─► ingest (static → runtime only, never back)
result stored or requeued ─► delete this attempt's copy (script settings name its stores: script, then those stores)
hourly maintenance ─► sweep by name prefix, then read running scans: every copy whose attempt is not running · uninstall ─► sweep + namespace + sandbox
```

- Files: `security/runtime-copy{,-names,-plan,-sources,-sweep}.ts`; changes in `control.ts`
  (`copy()`, delete after `result()`), `maintenance.ts` (`runtime copies` step, `copiesReaped`),
  `budget.ts` (`chargeSecurityScanCopy`), `input/{prepare,build}.ts`, `findings.ts`,
  `ingest.ts`, `project-findings.ts` (`verdictSource`, `runtimeProof` in the full view),
  `provisioning/security-scanner.ts`, `security-scanner-controller-runtime.ts`
  (`CopyOutbound`, copy host intercept, `makeCopy`), the runner (`runtime/copy.ts`,
  `phases.ts`, `prompts.ts`, `report.ts`, `validate-findings.ts`, `engines/{types,void-loop}.ts`),
  and the CLI finding detail (`confirmed (runtime)` and the proof line).
- Name: `void-sec-copy-<installation hash>-<scan id letters/digits>-a<attempt>`, not
  `sec-copy-<scan>`: one copy per attempt (a retry gets a new, empty copy), and the prefix lets
  the reaper find leftovers from Cloudflare's own lists. No database table for copies.
- Namespace: a separate dispatch namespace `void-security-copies-<h>` and an account Worker
  `void-security-copy-sandbox-<h>` (owner marker, source digest, no workers.dev), made by
  `provisionSecurityScanner` before the controller upload. The controller gets a
  `dispatch_namespace` binding whose outbound Worker is the sandbox. Not the users' namespace:
  its outbound Worker cannot change per script and the gate lives there.
- S13 kept: Durable Objects bypass the outbound Worker, so the entry imports a guard first that
  sends `fetch` to the sandbox through a service binding and makes `WebSocket` connects throw.
- Migrations: the copy D1 gets the live D1's schema read from `sqlite_master` (tables, views,
  indexes, triggers; virtual-table shadow tables (the FTS3/4/5 and R*Tree suffixes only) left out; at most 500 statements), not the
  project's migration files: the deployed migrations are not in the scan snapshot, and the
  schema is what the code runs against. The live D1 is only read, and only `sqlite_master`.
- Stubs: `__VOID_PROXY` (AI, email, revalidation) is the sandbox's `PlatformStub` (503 JSON);
  queue producers are `QueueStub` (messages dropped); project secrets and secret-looking vars get
  `void-copy-fake-…` values, and `__VOID_PROXY_TOKEN` too. Left out: hyperdrive, sandbox,
  assets, cron triggers, queue consumers. Static apps get no copy.
- Engines: Engine B only (`void_loop`, its own tool loop). Engines A and C keep static verdicts:
  their SDK loops have no extra tool. The copy is made after the runner starts, so it never
  delays the hunt; verify waits up to 90 s for `/__void_copy/ready`, then runs static-only.
- Proof: the model names one `copy_request` id in `proof_request`; the runner keeps
  `verdict_source: runtime` only when that request of the same session reached the copy
  (`x-void-copy: dispatched`) and is not a `/__void_copy/` setup route (read as `fetch` reads the
  path): seeding a row proves nothing. Model-set `verdict_source` and `runtime_proof` are dropped.
  Hunt records never carry them. A finding stored as static and later proven gets the source and
  `detail.runtime_proof` (jsonb merge); nothing takes them back.
- Secrets (spec §7.3): the copy runs the raw bundle and its answers reach the model, so no copy is
  made when a stored secret value (the redactor's four forms) is in a module, a kept var
  (`secret_in_bundle`) or the live schema (`secret_in_schema`). Fakes replace secrets in `env` only.
- Delete: the result path reads the copy script's settings (one 404 for scans with no copy), deletes
  the script, then the D1/KV/R2 its bindings name, each name checked against the copy's prefix. A
  copy finished after its attempt ended (charge refused) or whose charge threw is deleted at once.
  The account-wide listing is for the hourly reaper and uninstall only; it reads the running scans
  after listing, so a scan that starts during the listing keeps its copy.
- Test data: the entry answers `POST /__void_copy/d1` (one statement on a copy D1 binding) and
  `POST /__void_copy/kv` (one key), so verify can seed rows; the copy starts empty.
- Cost: one script-hour of Workers for Platforms + D1 rows written + one R2 class A operation per
  bucket, charged once when the copy is made (no cap check: the scan's reserve already passed).
- Deviations: also changed `test/integration/helpers.ts` (`mockCfApi`: dispatch namespace
  GET/POST/DELETE, copy scripts list, D1/KV/R2 lists), `api-security-provisioning.test.ts`,
  `security-input-capture.test.ts`, `security-sweeps.test.ts`, `security-fallback.test.ts`,
  `project-security-command.test.ts`, `security-ingest.test.ts` (runtime proof on a stored finding),
  the new integration test `security-runtime-copy-prepare.test.ts` (secret skip, charge refused),
  one paragraph of the security audits guide and the uninstall page. Not run
  live: the real copy (S13 already measured the guard and the namespace on the VoidZero account).
  `security-runtime-copy.test.ts` is a unit test with its own small fake Cloudflare API, not
  `mockCfApi` (an integration helper); `mockCfApi` covers the provisioning side.

**M31 Server secret findings, client asset deep scan, SARIF.** Redaction hits become
server findings (`source=server`, category secret-in-output, no value stored);
optional client asset pass; `void project security list --format sarif` and operator
export. Tests: `security-redact.test.ts`, `security-sarif.test.ts`.

As built (M31):

```
input build: read set ─► redact ─► text changed? ─► redactor.hitsIn(original) ─┐
             every built module (searched only) ───────────────────────────────┤
             text assets over 256 KB (prepare searches them, hits only) ───────┴─► one lead per
             secret and side: secret_in_output { first file + line, forms, client, alsoIn, files }
ingest: lead ─► confirmed server finding, key = server + project + "server:secret_in_output:<NAME>"
        + side (client | worker), never the file; a re-seen row takes the latest file/line/title
        client file (_assets/, _client/) ─► high, CWE-200 (urgent)    server code ─► medium, CWE-798
rescan --client-assets ─► coverage note `client-assets` ─► scan start (full only) ─► source maps of
        client bundles ─► `_client/<source>` after everything else, in what is left of the read limits
list --format sarif / platform security findings --format sarif ─► SARIF 2.1.0 (CLI side)
```

- Secret findings: `redact.ts` gains `hitsIn(text)` (each secret once, forms seen, first line, a
  form inside a longer match is not counted). `build.ts` checks every file it puts in the read
  set (all scans, not just the focus: the check is free and the finding is about the deployed
  output), at most 200 leads a scan. `ingest.ts` stores them with the reviewer-text leads in
  `server-leads.json`; the lead type is a union in `phrase-check.ts`. Confirmed, so an
  `incomplete` scan keeps them too (it keeps confirmed records only, so its reviewer-text leads
  are still dropped). The detail has the secret's name, the forms, `client`, an evidence and a
  fix line; no value is read back or stored. A model record cannot take one over (the key has
  `server`). Review fixes: the key has the side, not the file (hashed bundle names changed
  it every deploy, and an accepted risk did not carry over); the sink hash is `null` for the
  same reason; built modules are searched too (a `define` value is not in `sourcesContent`),
  and text assets over the read limit are searched in prepare (50 files, 8 MB each, 64 MB;
  the rest noted `secret-check-unread N files` and left out of the asset index); a cap past
  200 leads is noted `secret-leads-capped N`; `hitsIn` checks overlaps in linear time; the
  client wording follows `public_at_enqueue` ("public file" only when public). Severity is the platform's call (it is confirmed by an exact match): a public file
  is a leak (high), Worker code is a hard-coded secret (medium). A stored secret that is meant
  to be public (a publishable key) is resolved as accepted risk.
- Client asset pass: opt-in per rescan, not a policy item (`--client-assets` on `void project
  security scan` and `void platform security rescan`; `clientAssets: true` on both
  `POST …/security/scans` routes, echoed in the preview and the reply so a new CLI refuses the
  flag on an old platform). A coverage note set at queue time carries it, like `rescan` /
  `sweep`; the builder keeps the note, and a fallback of that rescan copies it. Maps: the
  bundle's `sourceMappingURL` (file or inline), else `<bundle>.map` next to it (so bundles over
  the 256 KB asset limit are covered too); 100 maps, 8 MB each, 24 MB in all; only
  `sourcesContent` is kept, and only what the read set can still take after the bundle's
  sources and the assets (the rest of the maps count as unread). Sources go under `_client/` with the §7.4 filters and the
  third-party rule; they are extra input: one that does not fit is only noted
  (`client-sources-left N files`), never backlogged, and never makes a scan partial. Notes:
  `client-assets`, `client-sources N files`, `client-maps-unread N files`.
- SARIF: built in the CLI (`packages/void/src/cli/security-sarif.ts`), not the API: both
  commands read the existing list routes. Rule = category (readers' findings, with no category,
  get `finding`), level from severity, `security-severity` per rule (highest of its results),
  `partialFingerprints` = (project/) finding id, resolved → `suppressions`. The project list
  keeps the 500 cap and the leads filter; notes go to stderr so stdout is the file. The
  operator export reads every page (100 pages of 100 at most) and does not take
  `--page`/`--limit` or `--json`; the operator findings list now also returns `cwe`, `lineEnd` and
  `verdictSource`.
- Webhooks were built in M26.
- Deviations: no policy item, admin panel or dashboard control for the client asset pass
  (per rescan only); no SARIF on the API. Also changed `fallback.ts`, `operator/audit.ts`
  (`clientAssets` in the rescan audit), the help text, and the tests
  `security-input-t2.test.ts`, `security-ingest-schema.test.ts`, `security-ingest.test.ts`,
  `security-input-capture.test.ts`, `api-project-security.test.ts`, `operator-security.test.ts`,
  `security-fallback.test.ts`, `project-security-command.test.ts`, `operator-cli.test.ts`.

### Phase 3

**M32 Local tree scan (`void project security check`).** CLI collects git-tracked
files with the §7.4 filters and secret-file drop, shows the provider notice when the
model is third-party, uploads through `POST /projects/:id/security/checks` (`deploy`,
presigned R2 URLs), scan `trigger=local`, `deployment_id` null. Results are a separate,
short-lived result: they never open, reopen, prove or hold anything (R13). CLI polls and
prints. Tests: `security-local-check.test.ts`, `project-security-check-command.test.ts`.

As built (M32):

```
CLI: git ls-files ─► securityInputFilter ─► tar (tree/) + gzip ─► POST checks {dryRun} ─► confirm
     ─► POST checks (row: local, no deployment, pending_input; presigned PUT, md5 + length signed)
     ─► PUT R2 scans/{scan}/local-tree.tar.gz ─► POST checks/:id/start (head ok ─► queued, poke)
     ─► GET checks/:id every 5 s, up to 60 min
API: claim as any scan ─► input/local.ts (walk tar, full scan, reason local) ─► runner
     ─► ingest: R2 local-result.{attempt}.json ─► storeLocalOutcome (row + reserve only)
     ─► tree deleted
```

- Shared code: the path filter moved to `packages/platform/src/security-local-check.ts`
  (`@void/platform/security-local-check`, new subpath) with the limits (10,000 files,
  32 MB code, 32 MB archive) and a small ustar writer. `input/filters.ts` re-exports the
  filter, so the CLI and every scan drop the same files.
- API: `security/local-check.ts` (parse, preview, create, start, read, hourly sweep),
  `security/input/local.ts` (input), `security/input/project-data.ts` (secrets and
  memory loaders moved out of `prepare.ts` so both inputs share them). Routes in
  `routes/project-security.ts`, all `deploy`: `POST /checks` (`dryRun` preview: model,
  provider notice lines, worst-case cost, budget), `POST /checks/:id/start`,
  `GET /checks/:id`. The plan named one route; the upload needs a second step (start after
  the PUT) and a read for polling.
- Scope as a rescan: the policy must apply to the project (so `public` mode is kept), the owner
  not suspended, a model must resolve. One queued or running local check per project (409
  `security_check_in_progress`); a new check cancels one still waiting for its upload
  (`upload_replaced`: it never ran and holds no reserve). Create re-reads the policy under
  the project lock and the shared policy lock (same order as a deploy enqueue), so a
  check never outlives a policy Off; start does the same and cancels (`policy_off`)
  instead of queueing. Too large is 413 `security_check_too_large` (413 added to
  `SecurityApiError`). Deploy tokens cannot call the routes (not on the allowlist).
- Input: tier `full`, new full reason `local` (note `local-check`, label
  `full scan (local check)`), no `no-commit` note, no base snapshot, backlog, scope file
  or runtime copy. Order: files under `routes|server|api|middleware|functions` or
  `*.server.*` first, then `securityRepoRank`. Past findings are read as memory only.
  Server leads (secret values in the tree, reviewer text) go to `server-leads.json`.
  Nothing readable ─► no model run, `succeeded`.
- Result (R13): `storeLocalOutcome` ends the row and releases the reserve only: no finding,
  event, ledger, email, backlog promote or fallback. `local-result.{attempt}.json` holds at
  most 200 records (same store rules as a deploy scan: all when succeeded, confirmed when
  incomplete), confirmed first by severity, and is written before the transaction that
  ends the row (a failed write fails the ingest, which the controller retries), so an
  ended check always has its result; per attempt, so a fenced-off attempt replaces
  nothing. Secret findings say "your code (not deployed yet)". Kept with the raw output
  (30-day sweep). The tree is deleted at ingest; the hourly `sweepSecurityLocalChecks`
  cancels a check still waiting for its upload 35 min after create (upload URL 30 min +
  margin, `upload_missing`) and deletes trees of checks that ended elsewhere (claim
  refusal, policy Off, reaper).
- Kept apart from deployment scans: a deploy no longer supersedes a waiting local check;
  rescan busy checks, the stale `pending_input` re-poke, project streaks, the sweep
  "recent full scan" rule, the retention "keep last succeeded" row, the policy preview
  "never scanned" count, the `@cf` fallback's "newest scan" pick, and `status` last
  scan / last successful scan all skip `trigger = 'local'` (or `deployment_id IS NULL`).
  Retention ranks local checks and deployment scans apart (200 rows each).
  `scans` history still lists it.
  The installation failure rate and the digest count it like any scan.
- CLI: `void project security check [<check-id>] [--yes] [--no-wait]` in
  `project-security-check.ts` (collect, pack, upload with `uploadAssetsToR2`, poll, print).
  Only `git ls-files --cached` paths under the folder, read from disk; symlinks, deleted
  files and NUL-byte files are skipped; the size limit is checked from `lstat` before a
  file is read. Always asks (it costs money and sends code); `--json` / non-interactive
  need `--yes`, checked before any request. A 412 on the archive PUT (`If-None-Match: *`:
  an earlier PUT landed, its reply was lost) counts as uploaded. `check <id>` on a
  `pending_input` check calls start once. Exits non-zero when the check ends without a
  result, including a succeeded check whose result is missing. A platform without the routes (plain 404) is named as
  too old. Help, `docs/reference/cli/project.md`, `docs/reference/cli.md` and the
  security guide are updated; the no-args hint lists groups, so it is unchanged.

**M33 BYOK.** Encrypted provider keys in `platform_settings['securityAudits.providerKeys']`
(`encryptPlatformCredential`); proxy adds the key server-side; probe check 5 per BYOK
host; BYOK spend still metered and counted (R14). Operator
`security models --provider anthropic --key-stdin`. Tests: `security-byok.test.ts`.

As built (M33):

```
CLI: models --provider <host> --key-stdin ─► read stdin once ─► POST provider-keys {dryRun} ─► confirm
     ─► POST provider-keys {host, key} ─► 1-token test call on the key ─ fail ─► 422, nothing saved
                                                                       └ ok ──► encrypted, policy lock
proxy (messages / responses): key saved? ─ no ─► REST /ai/v1/* + CF token (Unified Billing, as before)
                                          └ yes ► env.AI.gateway(id).run({provider, endpoint, headers + key})
probe check 5: same split per host; report.keyIds ─► stored under the policy lock, a host whose key
               changed meanwhile keeps the value the key write stored (save: kept, removal: false)
```

- Storage: `security/provider-keys.ts`, `platform_settings['securityAudits.providerKeys']`,
  one entry per host `{key: encryptPlatformCredential, keyId, setAt, setByUserId}`. The
  credential id is `security-provider-key:<host>`, so one host's ciphertext never opens as
  the other's. A malformed entry is a saved key that cannot be used, never "no key": the
  proxy refuses the call (503), the probe shows `ownKeyUnreadable` (key id `malformed`), and
  reads show `{setAt: null, unreadable: true}`; a save replaces it. Reads (`GET /security/policy`,
  `status`) show `setAt` only.
- Route (deviation): the plan said "proxy adds the key". The REST `/ai/v1/*` routes the proxy
  uses only read keys stored in AI Gateway itself (Cloudflare docs: request keys count on
  provider-native routes only). So a saved key goes to the provider-native route through the
  AI binding's gateway `run` (`anthropic` `v1/messages` with `x-api-key`, `openai` `responses`
  with a bearer key), which authenticates to the gateway itself: the runtime token needs no AI
  Gateway Run permission. The same fixed `cf-aig-*` headers go along, plus
  `cf-aig-no-wholesale: true`, so the gateway refuses instead of billing credits if it ever
  does not read the key. The model is named the provider's way there
  (`claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6.1-*`; table in `provider-keys.ts`). The
  `access_programs` field is still added for `openai/*`; the save-time test call and the probe
  send it, so an org that rejects it is caught there. Not run live yet (needs a real provider
  key): the first live probe with a saved key is the check.
- Proxy: `deps.providerKey(host)` is read per call before the policy read and the hold. A
  removal clears the host's probe result in the key's transaction, so a policy read after the
  key read sees it; the other order could pass the check and then find no key (Unified Billing). A saved key that cannot
  be opened fails the call (503 `upstream_failed`, no hold, no Unified Billing fallback). Caps,
  holds, settle and the ledger are unchanged, so BYOK spend is metered and counted (R14).
- Operator route `POST /operator/v1/security/provider-keys` (`capability`; `{host, key}` or
  `{host, key: null}`, `dryRun` preview). Save runs a 1-token test call first (the probe's
  call); a non-2xx or unreachable gateway is 422 `security provider key rejected` and nothing
  is stored. A save keeps the host's probe result (same image, key just checked); a host that
  never passed still needs the probe (`probeNeeded`). Removing a saved key clears the host's
  probe result (its scans go back to Unified Billing, unchecked); removing none changes
  nothing. Audit target: `{installation, host, key: set|removed}`, never the key.
- Probe: `runSecurityProbe(env, db, policy, deps?)` now takes the db and reads the key slots
  once (`loadSecurityProviderKeySlots`). A host with a key shows `Own key     <host>/*` and its
  own copy (refused key, failed call, unreadable key); no Unified Billing link. Key writes and
  entitlement writes both take the policy lock; `recordSecurityEntitlement` and the turn-on
  probe in `changeSecurityPolicy` compare the probe's `keyIds` with the saved ones under it. A
  host whose key changed keeps its stored value (`entitlementForSavedKeys`): the key write set
  it under the same lock, so a long probe on the old key never undoes a save reported as OK.
- CLI: `void platform security models --provider <openai|anthropic> (--key-stdin | --remove-key)`,
  its own action `provider-key`, not combinable with `--default/--block/--unblock`. The key is
  read once from stdin (one line, no spaces) before any request, sent for the preview and the
  change, and never printed. Non-interactive runs need `--yes` (stdin is the key). No admin
  panel form: operator CLI only, as planned.

**M34 Per-project policy override.** `project_security_settings.policy_override`
(`inherit|always|never`, installation admin only); enqueue reads it; `never` never
skips a gate scan (D46). Operator `security policy --project`, admin Project detail.
Tests: `security-enqueue.test.ts`, `operator-security.test.ts`.

**M35 Severity edits.** `POST …/findings/:fid/severity {severity, comment, expectedRevision}`
(`settings`); `severity_override` sticky across scans; event `severity_edited`;
lowering crit/high counts like a resolve for the gate (comment required, recorded,
reopen rule uses the human value). CLI `void project security severity`. Tests:
`security-findings-rules.test.ts`, `api-project-security.test.ts`.

**M36 Final docs and full verification.** Phase 2/3 docs; `vp run test --base origin/main`,
`vp check`, then `vp test run` once.

## Phase 0 spikes

Scripts are Node TypeScript in `platform/scripts/` (top level, so the existing
`tsconfig.json` `include: ["*.ts"]` covers them). Seeded apps go in
`platform/scripts/fixtures/security-seeded-apps/` (5 apps: React+D1, Vue+KV,
Svelte+auth, Solid+R2, plain Void API), each with `bugs.json` (planted crit/high and
decoys). Every script prints one JSON report and a PASS/FAIL line, and exits non-zero
on FAIL.

| Spike             | Script                                                                                                   | Runs                                                                              | Measures                                                                                                                                                                                                                                   | Pass (PRD §15.2 / spec §20)                                                                     | Fail                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S1 egress         | `security-spike-s1-egress.ts`                                                                            | **live** (Workers Paid, Containers)                                               | deploy a scratch controller + app; model call via `ScanModelOutbound`; `fetch https://example.com` and unknown DNS fail fast (< 2 s with `DenyAll`); env + FS have no token; identity reaches API props; cold start p50/p95 over 10 starts | call works, internet blocked, no token, cold start < 60 s                                       | Sandbox outbound pattern; still failing → stop (no MVP)                  |
| S1b image         | `security-spike-s1-image.ts`                                                                             | **live**                                                                          | copy a digest-pinned image into `registry.cloudflare.com/<acct>` from a Worker (credentials API, streaming), then `prepareContainerImage`; also test `default` scheduling policy pulling `docker.io`                                       | one of the two works with a scoped token, < 15 min, Worker memory OK                            | raise R1 to the user                                                     |
| S2 Agent SDK      | `security-spike-engine.ts --engine claude`                                                               | lockdown **local** (Docker + fake model), quality **live** (credits)              | tools list, planted config files, valid output 10/10 on 3 apps, time                                                                                                                                                                       | lockdown holds; 10/10 valid; ≤ 20 min                                                           | stop and ask the user (D37)                                              |
| S3 Codex          | `security-spike-engine.ts --engine codex` + `security-spike-codex-lockdown.ts`                           | items 1, 2, 5, 7 **local**; 3, 4, 6, 8 **live**                                   | the 8 items in spec §20                                                                                                                                                                                                                    | all 8 hold                                                                                      | stop and ask the user (D37)                                              |
| S4 Engine B       | `security-spike-engine.ts --engine void-loop --model @cf/deepseek-ai/deepseek-v4.1-flash-1017 --tier t2` | **live** (Workers Paid / AI credits); harness checked locally with the fake model | recall on 10 planted bugs, false confirmed, valid runs, calls, p95 at 10 req/min                                                                                                                                                           | ≥ 7/10, ≤ 2 false, ≥ 95% valid, ≤ 80 calls, p95 < 20 min                                        | done: deepseek is default; glm-5.3 fails                                 |
| S5 static confirm | same script, `--report confirmations`                                                                    | **live**                                                                          | share of seeded bugs reaching `confirmed` with a trace                                                                                                                                                                                     | seeded issues confirm                                                                           | define "confirmed (static)", re-run S2/S4; none → every result is a lead |
| S6 parity         | `security-spike-parity.ts`                                                                               | **live** (3 engines)                                                              | same issue → same key over 3 repeats                                                                                                                                                                                                       | ≥ 80%                                                                                           | server key normalization                                                 |
| S7 inputs         | `security-spike-inputs.ts`                                                                               | **local**                                                                         | builds `playground/*` React/Vue/Svelte/Solid; `sourcesContent` coverage; lockfile identity; workspace packages kept; snapshot size in R2 terms; lists every go-live call site                                                              | ≥ 90% server files readable; one cutover path covers all (or the extra paths are listed for M8) | more T3 / `no-source-maps`                                               |
| S8 cost/time      | `security-spike-engine.ts --all-models --report cost`                                                    | **live**                                                                          | tokens, calls, $, minutes per tier and model, T3 gate scans                                                                                                                                                                                | glm median ≤ $3 per ~2k-line diff, p95 ≤ 20 min                                                 | tighten caps; the default is deepseek                                    |
| S9 refusals       | `security-spike-refusals.ts`                                                                             | mapping **local** (recorded fixtures), rates **live**                             | 10 runs × 4 third-party models                                                                                                                                                                                                             | 100% refusals → `refused`, 0 → `succeeded`                                                      | fix mapping, badges                                                      |
| S10 gateway       | `security-spike-gateway.ts`                                                                              | **live**                                                                          | payload off and skip-cache on binding and REST paths; cost by `securityScan` tag; meter vs gateway                                                                                                                                         | no bodies, no cache, cost readable, ±10%                                                        | dedicated scan gateway with logs off; fix prices; Engine B moves to REST |
| S11 red team      | `security-spike-redteam.ts`                                                                              | server rules and tool escapes **local** (fake model); model misses **live**       | fixtures listed in spec §20 S11                                                                                                                                                                                                            | no escape, no egress, server rules and caps hold                                                | fix before MVP                                                           |
| S12 legal         | none (document review)                                                                                   | –                                                                                 | Agent SDK terms for operators and image redistribution, OpenAI terms, naming                                                                                                                                                               | written OK                                                                                      | raise to the user                                                        |
| S13 copy          | `security-spike-copy.ts`                                                                                 | **live** (Workers for Platforms)                                                  | copy serves a seeded app, outbound fails, not reachable from the internet, < 60 s, no leftovers, cost                                                                                                                                      | all hold                                                                                        | Phase 2 stays static-only (M30 not built)                                |

Spike results, 2026-11-18 (S2/S3 local runs through the gateway, S10). Scratch
account (not VoidZero), gateway `void-spike-sa-gw`, deleted afterwards (gateway list
empty). The engines ran in local Docker: the scan network has no route out, and
`model.scan.internal` is a model-proxy stand-in (`security-spike-images/model-proxy.mjs`)
that adds the token and calls REST `/ai/v1/messages` or `/ai/v1/responses` with
`cf-aig-gateway-id`, payload logging off, cache skipped. Scripts:
`security-spike-s2.ts --local-gateway`, `security-spike-s3.ts --local-gateway`,
`security-spike-s10.ts` (token and account from env or `~/.config/void-spike/`).

- Gateway sent `collect_logs: false`, `cache_ttl: 0`, `cache_invalidate_on_update: false`,
  rate limit 0; read back the same plus `authentication: true`, `logpush: false`,
  `log_classification: false`, `zdr: false`, `workers_ai_billing_mode: postpaid`.
- The account has no Unified Billing credits. Both third-party models answer 402
  (no charge): Messages `{"type":"error","error":{"type":"invalid_request_error","message":"Insufficient unified billing credits. Please add additional credits on the AI Gateway Cloudflare dashboard to continue using provider models."}}`,
  Responses the same message with `"code":"invalid_prompt"`. So model quality, findings,
  tokens, cost and scan time for `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-terra`
  stay BLOCKED. `@cf` models do not work on `/ai/v1/messages` or `/ai/v1/responses`
  (400 "Anthropic Messages API is not supported", schema error), so no free stand-in.
- Held for both engines: the names route (`claude-sonnet-5.5` → `anthropic/…`,
  `gpt-6.1-terra` → `openai/…`; an unknown name answers 404 "Model not found", these
  answer 402); the container sends only a placeholder key or none; without the proxy
  token the gateway answers 401 (code 10000); the engine cannot reach
  `gateway.ai.cloudflare.com` or `api.cloudflare.com` (DNS `EAI_AGAIN`) or `1.1.1.1`
  (`ENETUNREACH`); the token is in no process env and nowhere in the exported file
  system (600–670 MB searched); the lockdown checks of `--local` still pass.
- Engine A (Claude Code 2.1.324) on 402: one call, stops in 1.5 s, result `subtype:
  "success"` with `is_error: true` and text `API Error: 402 Insufficient unified
  billing credits…`. M13 maps by `is_error` + the 402, not by `subtype`. On 401 it
  retries: 9 calls in 120 s until the wall clock stopped it, so the proxy must never pass
  a 401 through (answer a stop instead).
- Engine C (Codex 0.169.0) on 402: 6 calls (1 + "Reconnecting... 1/5" to 5/5) in 8.4 s,
  then `turn.failed` "unexpected status 402 Payment Required: …". Same on 401. Mitigation,
  both confirmed: `request_max_retries = 0` and `stream_max_retries = 0` on the
  `void-proxy` provider (1 call, 0.6 s); and the proxy answering every repeat after a
  credits stop itself (1 upstream call, 5 answered locally). M13 sets both.
- S10 (`@cf/zai-org/glm-5.3-flash`, ~50 tokens a call): no call was cached
  (`cf-aig-cache-status: MISS` on every repeat, also with a caller `cf-aig-cache-ttl: 60`
  and on the provider-native `compat` endpoint). With logs off, `@cf` calls leave no log
  entry. Third-party calls are always logged (Unified Billing): metadata only, stored
  request and response read 404, `metadata: null` although `cf-aig-metadata` was sent,
  cost 0. A control call with payload logging forced on stored both bodies, so the
  reads work. Result: no bodies, no cache (PASS). Cost by `securityScan` tag is not
  readable from the logs, so the spend meter stays the only cost source (the fail
  branch). Not covered: the binding path and meter vs gateway (needs credits).

S4/S8 follow-up (2026-11-19, first run on VoidZero: glm-5.3 found 2/10 with 25% valid
runs, deepseek 8/10 with 75% valid; both stopped at the caps). Changes:

- Runner. One unreadable verify session no longer drops the scan: that candidate stays a
  lead, the other candidates still get a session, and the scan ends `incomplete
  (run_incomplete)` (only confirmed findings are stored, so the gate does not pass it).
  Engine B repairs harmless slips before the strict check (`coerce.ts`: enum case,
  fields the schema lacks, a severity on a lead, line numbers as strings), takes a report
  sent as JSON text (also in a fence), gives the no-tool-call nudge and the invalid-report
  repair a retry each, and tells the model "your last output was invalid: <reason>". The
  API ingest still uses the strict validator.
- Controller. `EXEC_ENV.PATH` now ends with `/usr/sbin:/sbin`; without it `useradd`
  failed with ENOENT, so no live scan could start.
- Caps. Defaults go to 1.2M input and 120k output tokens (ranges unchanged). At the cap
  the worst-case reserve is $2.21 for glm-5.3 and $0.50 for deepseek (was $1.10 / $0.25);
  S8 measured a median $0.99 (glm) and $0.22 (deepseek) when a scan stops at the old cap.

S4 rerun after those changes (2026-11-19, VoidZero, runner at HEAD, caps 1.2M / 120k; `security-spike-s4.ts
--live`, T2 input, 5 seeded + 3 clean apps, n = 8 scans per model; glm-5.3 ran in two
batches because the harness budget guard skipped four of its apps in the first). Spend
$7.49 at list prices; `void-spike-sa-s4` Worker and container app deleted, lists back to
the baseline (20 Workers, 87 container apps).

|                                      | glm-5.3                 | deepseek-v4.1-flash-1017 (default) |
| ------------------------------------ | ----------------------- | ---------------------------------- |
| Planted crit/high found (bar ≥ 7/10) | 4/10, all confirmed     | 10/10, all confirmed               |
| False confirmed crit/high (bar ≤ 2)  | 0                       | 0                                  |
| Valid runs (bar ≥ 95%)               | 4/8 (50%)               | 8/8 (100%)                         |
| Calls per scan (bar ≤ 80)            | median 28, max 78       | median 54, max 72                  |
| Cost per scan at list price          | median $0.74, max $1.34 | median $0.18, max $0.29            |
| Wall time (bar p95 < 20 min)         | p95 19.2 min            | p95 15.7 min                       |
| Result                               | FAIL                    | PASS                               |

- Before the fix, deepseek was 8/10 with 75% valid runs: the tolerant parsing and the
  separate retry for a bad report took it to 10/10 and 100%. One deepseek scan ended
  `incomplete (token_cap)` and still kept its confirmed findings.
- glm-5.3 still fails in the hunt session in 4 of 8 scans (`bad_output`: three
  `shape`, one `no_submit`), so those scans have nothing to keep. Both seeded apps that got
  through the hunt (react-d1, svelte-auth) had all 4 planted bugs found and confirmed; the
  three seeded apps whose hunt failed (api-plain, solid-r2, vue-kv) count as missed.
- The cost bar (median ≤ $3) passes for both. Stopping at the cap is rarer: glm-5.3
  hit it in 2 of 8 scans, deepseek in 1 of 8.
- Decision: `@cf/deepseek-ai/deepseek-v4.1-flash-1017` is the default model everywhere
  (`DEFAULT_SECURITY_MODEL`, policy default, probe fallback, first in the model list so it
  is also the first `@cf/*` fallback). On this harness it meets every S4 bar and glm-5.3
  does not. glm-5.3 stays in the list and can be picked.

Live spikes need one scratch account with Workers Paid, Containers, Workers AI or
AI Gateway credits, Unified Billing for third-party hosts, and a runtime token with
Containers Edit, Cloudchamber Edit and AI Gateway / Workers AI permissions. Scripts read
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` and delete everything they create.

S13 throwaway copy (2026-11-19, VoidZero, `security-spike-copy.ts`; the account has
Workers for Platforms). Per run the script makes a dispatch namespace, a sandbox Worker
(no workers.dev; it is the namespace's outbound Worker, serves the AI / email / queue
stubs as RPC entrypoints and keeps a call log) and a scratch controller (workers.dev +
key header; the only way in, as `https://copy.void.internal/...`). Per copy: the built
seeded app uploaded unchanged into the namespace, a new empty D1 / KV / R2 per binding,
`db/migrations` applied, fake values for secrets (and for text vars with a secret name),
stubs for AI / email / queue, cron and queue-consumer triggers dropped. Apps: react-d1
(D1, Durable Object, assets, a secret), api-plain (D1, KV, vars, a cron, a real outbound
call), solid-r2 (R2), and react-d1 again (warm). Result: **PASS**, with one design change
(the copy guard below).

| Measure                      | Result                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Copy serves the app          | 17/17 route checks; pages, assets, migrated tables, fake-secret cookie accepted                                           |
| Time to ready (bar < 60 s)   | 9.0 / 9.1 / 9.3 s cold, 9.3 s warm (first create call → first 200)                                                        |
| Where the time goes          | stores 0.7–1.2 s, migrations 0.2–0.5 s, assets 3.8–4.1 s (3 buckets in parallel), script upload 3.0–3.4 s, first hit ~1 s |
| Outbound blocked             | yes, with the copy guard (see below); without it a Durable Object reaches the internet                                    |
| Not reachable from internet  | workers.dev name 404, not an account script (10007), controller 403 without or with a wrong key                           |
| Delete                       | 2.1–3.6 s per copy (script + its stores); lists back to baseline                                                          |
| Cost per copy (list prices)  | $0.000006–0.000014 (requests, D1 rows, one KV write, prorated script); WfP's $25/month base is already paid here          |
| One-time setup (per install) | namespace 1.2 s, sandbox Worker 11.5 s, controller 12.6 s                                                                 |

- Egress from the copy's Worker code: `fetch` to https, http, a bare IP,
  `api.cloudflare.com` and another workers.dev Worker all end in the outbound Worker
  (403); `connect()` fails ("proxy request failed"); a `waitUntil` fetch is blocked too.
- **Durable Objects bypass the outbound Worker** (Cloudflare documents this; measured with
  `--no-guard`): from a Durable Object in the copy, `fetch` reached example.com,
  1.1.1.1 and `api.cloudflare.com`, and an outbound WebSocket opened. `connect()` still
  failed there. So M30 adds a **copy guard**: a module loaded before the app's entry that
  replaces `globalThis.fetch` (non-writable) with a call to the sandbox through a service
  binding, and `WebSocket` with a constructor that throws. With it, every probe from the
  Worker and from the Durable Object was blocked, and the sandbox log still names each
  call. The guard runs in the app's own isolate: it stops the app's own calls, it is not a
  boundary against code written to escape it; the outbound Worker stays as the second
  layer.
- Real app code: api-plain's charge route called its payments API; the call reached the
  sandbox (403) carrying the fake key, never the real `sk_live_…` var. react-d1 with test
  rows seeded through the D1 API: the planted SQL injection returned another owner's
  invoice and the planted IDOR returned owner 2's invoice to user 1, so `confirmed
  (runtime)` checks are possible on a copy.
- Stubs: `AI.run`, `EMAIL.send`, `QUEUE.send` from the copy to the sandbox entrypoints work
  (service-binding RPC from a namespace script to an account Worker).
- Findings for M30: assets are uploaded again for every copy (no reuse across scripts,
  about 4 s; the copy could skip assets when no check needs them); a KV key written through
  the API was visible to the copy after ~10 s, so seed KV through the copy or wait;
  `kv.map('sid:')` stores under `sid::<key>`; a fresh copy's Durable Object answered its
  first call with "internal error" in 2 of 17 copies (one retry worked); Void does not
  catch a thrown `Response` in a handler, so the dispatcher sees `#<Response>` (same on a
  native deploy); the solid-r2 build has no `KV` binding although its code uses `void/kv`
  (fixture/inference gap, not the copy).
- Cleanup: every `void-spike-sa-s13-*` namespace, namespace script, Worker, D1, KV and R2
  deleted; final lists show none, and the account totals match the baseline (4 dispatch
  namespaces, 21 Workers, 80 KV namespaces, 40 R2 buckets). Other `void-spike-sa-*`
  resources are never listed for deletion.

S5 static confirmations (2026-11-19, VoidZero, `security-spike-s4.ts --live --report
confirmations`, deepseek-v4.1-flash-1017, T2 input, the 5 seeded apps × 2 runs = 10
scans, harness Worker `void-spike-sa-s5`). A planted bug counts when its best match is
`confirmed` (the runner keeps that verdict only after the separate verify session reported
it again), has a sink_path and a trace step in the planted file. Result: **PASS**.

| Measure                                       | Result                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| Planted bugs confirmed with a trace (bar 70%) | 20/20 (100%); all 20 traces have 2+ steps, median 11         |
| Leads / missed among planted bugs             | 0 / 0                                                        |
| All findings                                  | 38 confirmed, 4 needs_validation, 25 rejected                |
| Verify sessions per scan                      | 3–7                                                          |
| False confirmed crit/high                     | 2 (both in decoy files, see below)                           |
| Runs                                          | 9 succeeded, 1 `incomplete (run_incomplete)`                 |
| Calls / cost / wall time per scan             | median 52 (max 62) / median $0.15 (max $0.25) / p95 12.7 min |
| Spend                                         | $1.68 (cap $3)                                               |

- "confirmed (static)" works on this input: no planted bug stayed a lead, so the
  fail branch (every result is a lead) does not apply. The S4 bars also pass on this run.
- The two false confirmed are in decoy files and are debatable rather than wrong:
  api-plain's charge route has no idempotency key (repeat charges), and react-d1's HMAC
  key becomes the string "undefined" when `SESSION_SECRET` is unset.
- `sink_path` is sometimes an expression, not a path (`fetch(url)`,
  `void/storage:storage.get(key)`); the trace still names the file, so ingest and the UI
  should not treat `sink_path` as a file path.
- Cleanup: `void-spike-sa-s5` Worker and its container app deleted; the lists are back to
  the baseline (21 Workers, 88 container apps). The harness now deletes only its own
  container apps (`<worker>-*`), not every `void-spike-sa-*` app, because other spikes can
  run on the account at the same time.

### Spike results S7 / S9 / S11 (local, 2026-11-19)

Scripts: `security-spike-inputs.ts` (S7), `security-spike-refusals.ts` with
`fixtures/security-refusals.json` (S9), `security-spike-redteam.ts` (S11). They share
`security-spike-local.ts`, which runs the script again with a small loader: stand-ins for
`cloudflare:workers` and the build-time `void:*` sources, and the DB packages resolved from
the API package. They run the real runner, engines, MCP server, controller, model proxy,
budget SQL and ingest (PGlite) in plain Node with the fake model. No product code changed.

| Spike        | Result           | Numbers                                                                                         |
| ------------ | ---------------- | ----------------------------------------------------------------------------------------------- |
| S7 inputs    | **PASS** 26/26   | 100% of first-party server files readable in all 4 apps; 8 go-live sites, 6 enqueue, 2 excluded |
| S9 refusals  | **FAIL** 15/20   | 9/12 refusals end `refused` (75%), 0 end `succeeded`; 3 mapping bugs                            |
| S11 red team | **FAIL** 149/150 | no escape, no egress, no token, caps and server rules hold; 1 tool-path gap (Engine A Glob)     |

**S7.** Each Pages playground is copied to `playground-local/security-spike-s7/<app>` and
built with `vp build`. The worker files come from the CLI's own `collectWorkerFiles`, the
scan input from the real `bundleSources` / `buildSecurityScanInput`.

| App    | Build | Modules (code / maps), bytes | First-party readable (app + workspace) | Registry sources (same as disk), packages | Full input (no lockfile) | With repo lockfile           | Snapshot          |
| ------ | ----- | ---------------------------- | -------------------------------------- | ----------------------------------------- | ------------------------ | ---------------------------- | ----------------- |
| React  | 1.9 s | 103 (52 / 51), 4.49 MB       | 81/81 (46 + 35)                        | 43 (43/43), 6                             | 163 files, 2.34 MB       | 122 files, 41 dropped, 2 unv | 4.52 MB, 106 objs |
| Vue    | 1.6 s | 70 (35 / 35), 2.08 MB        | 57/57 (33 + 24)                        | 34 (34/34), 8                             | 115 files, 1.28 MB       | 86 files, 29 dropped, 5 unv  | 2.11 MB, 73 objs  |
| Svelte | 3.7 s | 64 (32 / 32), 1.50 MB        | 62/62 (31 + 31)                        | 55 (55/55), 6                             | 141 files, 0.89 MB       | 87 files, 54 dropped, 1 unv  | 1.52 MB, 67 objs  |
| Solid  | 2.4 s | 65 (34 / 31), 1.67 MB        | 63/63 (32 + 31)                        | 35 (35/35), 6                             | 129 files, 0.94 MB       | 96 files, 33 dropped, 2 unv  | 1.70 MB, 68 objs  |

- Every map entry has `sourcesContent`. First-party text equals the file on disk, except
  virtual modules (`virtual:void-routes`, `@void-island-wrap/*`) and 9 Vue SFCs (the Vue
  plugin's text is a few bytes off, e.g. 353 vs 360 bytes for `pages/index.vue`).
- Modules with no map go in as built code (`_worker/…`, note `no-source-maps`): React 1
  (`rolldown-runtime`), Solid 3 (two tiny island chunks, `pages-client.js`). Coverage
  stays `complete`.
- Workspace packages (`packages/*/dist/…`, the map path after `..` is dropped) are
  first-party and always sent. Registry code under `node_modules/.pnpm/<pkg>@<ver>/` is
  byte-equal to the installed package in all 167 cases.
- Lockfile: the platform gets none today, so all registry code is `unverified` and sent
  (input about 2× larger). With the repo's `pnpm-lock.yaml`, registry files are dropped
  and coverage turns `partial (partial-third-party-only)`; 1–5 files an app stay
  `unverified` because `parsePnpmLock` reads only direct `importers` deps (transitive
  ones such as `scheduler`, `devalue`).
- Snapshot per deployment: the module bytes + `modules.json` + `sources.json` (+
  `assets.json`), 67–106 R2 objects; 3 more per scan (`backlog`, `server-leads`, `scope`).
- T2 after a one-line change to `routes/api/health.ts`: `built_diff`, 2 modules changed
  (the chunk's map and `index.js.map`), focus = that file + `virtual:void-routes`.
- GitHub compare lists at most 300 files (`GITHUB_COMPARE_MAX_FILES`): at or above that
  it counts as truncated and the scan falls back to T2.
- Go-live sites (plain-text search of `platform/packages/api/src`; every write of status
  `live` or of the active pointer):

  ```
  deploy/recovery.ts:111,114     commitCutoverLive (publish-static :237, publish-worker :437)
                                   └─► enqueueSecurityScanInTx                   trigger deploy
  deploy/execute.ts:875,884      promoteProtectedDeployment ─► enqueueSecurityScanInTx  recovery
  deploy/compensate.ts:492,501   post-routing recovery ─► finishLiveSecurityScan
                                   └─► enqueueSecurityScanForLiveDeployment ─► …InTx
  routes/projects.ts:1286        rollback                 not scanned (spec §6.1)
  operator/project-normalization.ts:162  operator repair  not scanned (no new code)
  ```

  Managed builds run `void deploy` in the build container, so they take the same path.
  M8 covers every site; nothing to add.

**S9.** 18 recorded fixtures (refusal, plain-text refusal, controls) for the 3 engines, run
through the real `runScan` and engine code, then the API's `parseRunnerStatus` /
`securityScanOutcome` / `shouldRetrySecurityScan`; plus 3 provider refusals sent through the
real model proxy. Live refusal rates stay BLOCKED (no Unified Billing credits, see S2/S3).

| Engine      | Refusals → `refused` | Notes                                                                        |
| ----------- | -------------------- | ---------------------------------------------------------------------------- |
| B void-loop | 1/1                  | plain-text refusals (2) end `failed (bad_output)`, never `succeeded`         |
| A Agent SDK | 4/4                  | the refusal category is lost (bug 3)                                         |
| C Codex SDK | 4/7                  | `cyber policy:` text (bug 1) and proxy-hidden 400 (bug 2) end infrastructure |

- Controls hold: 402 → `failed (credits)` for A and C, a dropped stream → `failed
  (infrastructure)`, clean submits → `succeeded`.
- A model that "declines" by sending an empty report (`B5`) ended `succeeded`, the same
  as a clean scan, so it would pass the public gate. Fixed after the spikes (item 5 below).

**S11.** 150 checks in 10 groups: tools 30, tar 20, MCP 8, engines 24, output 12, phrases
7, input 9, egress 19, caps 12, ingest 9. All hold except one.

- Held: every path trick (`..`, absolute, `/proc/self/environ`, symlinks, backslashes,
  NUL, long paths) is refused by the Engine B tools and the MCP server; `bash` / `fetch` /
  `web_search` / `shell` do not exist; all 20 bad tars end `failed (input_invalid)` with
  nothing written outside the root (planted `out/status.json` included); planted
  `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.codex/config.toml`, `.agents/skills`,
  `.claude/settings.json` are not read (no setting sources, project docs off); the
  controller locks egress before start, `DenyAll` answers 403, scan identity comes from
  props; the proxy refuses provider-run tools, `mcp_servers`, `container`, `background`,
  `additional_tools`, filters `anthropic-beta`, replaces caller auth and `cf-aig-*`, and
  never answers with the token; 30 concurrent calls → exactly 10 reach the model; the
  session cap (40), token cap, `max_tokens` clamp, $0.01 project cap under concurrency,
  worst-case charge for a stream with no usage, fences (409) and 16 MiB (413) hold; a
  forged `server:reviewer_text` fingerprint gets its own row; scan N+1 writing `rejected`
  or a weaker lead does not close, demote or hide scan N's confirmed high bug; a status
  for another scan ends `bad_output`; a 300-record flood stores ≤ 100; `incomplete`
  keeps confirmed only; a secret and its base64 form never reach the tar.
- Known risks (recorded, not fails): the reviewer-text check misses split, spaced,
  homoglyph, zero-width and other-word forms (8 tried); a hard link in `/scan/input` is
  readable (not reachable: the tar refuses links); after two refused reports the MCP
  server still takes a third submit (bounded by the 40-call session cap); app code placed
  under a registry package's `node_modules/` path is dropped when a lockfile is used (a
  malicious owner is a non-goal).

**Product bugs found** (not fixed here):

1. `platform/packages/security-scanner/src/runner/status.ts:214` (`CODEX_POLICY_CODES`,
   used at :224). Codex 0.162.1 prints `CodexErr::CyberPolicy` as `cyber policy: <msg>`
   (space, no code). Repro: fixture C1 (`turn.failed` "cyber policy: This request has been
   flagged…"). Got `failed (infrastructure, codex_turn_failed)`, retried once and blamed
   on the install. Expected `refused`.
2. `platform/packages/api/src/security/model-proxy.ts:1096-1102` (upstream-failed branch of
   `handleSecurityModelRequest`). The provider body is kept only for the log, so an OpenAI
   400 `code: cyber_policy` reaches Codex as `upstream_failed` "The model call failed.",
   and the last failure says `upstream`. Repro: chain P1. Got `failed (infrastructure)`.
   Expected `refused` (pass the policy code on, or record a refusal as the last failure).
3. `platform/packages/security-scanner/src/runner/engines/claude.ts:293` reads
   `result.stop_details?.category`. In Claude Code 2.1.328 `stop_details` is on the
   assistant message, not on the result. Repro: fixtures A1, P3. Got `refusal_category:
   null`. Expected `cyber`.
4. `platform/packages/security-scanner/src/runner/engines/claude.ts:148`
   (`createPathHook`): `pattern` is checked only when it starts with `/`. Repro:
   `createPathHook(root)({ tool_name: 'Glob', tool_input: { pattern: '../../**/*' } })`
   answers `{}` (allowed). Glob could list file names outside `/scan/input` and
   `/scan/memory` (Read stays blocked). Expected deny: resolve a relative pattern against
   the cwd, or refuse a `..` segment.

**Fixed after the spikes** (re-run: S7 26/26, S9 21/21, S11 150/150):

1. `classifyCodexRun` reads spaces and dashes as `_` before it looks for a policy code,
   so `cyber policy: <msg>` ends `refused (cyber_policy)`.
2. The proxy reads the provider error body: `error.code` `cyber_policy` or
   `trusted_access_for_cyber` is answered with that code as the `error` (same HTTP
   status) and recorded as last failure `refused`, so Codex shows the code and the scan
   ends `refused`, not retried.
3. Engine A takes the refusal category from the last assistant message that stopped with
   `refusal` when the result has no `stop_details`.
4. The Engine A hook reads every Glob `pattern` as a path: a `..`, `~`, backslash or a
   brace choice that starts a new root (`{/etc,x}`) is refused; otherwise the fixed
   leading part, under the search `path` or `/scan/input`, must stay in the scan folders.
   A Grep `pattern` is search text and is not read as a path. A path that starts with
   `~` (the CLI's home, its config folder) is refused for every tool.
5. A session that read no file cannot clear code (`phases.ts` `readNothing`): the prompt
   names files but never holds their text. Each engine counts the scan tool calls that
   answered (`stats.reads`: Engine B's own tools, Engine A's hook allows, Engine C's
   void-scan MCP calls). A report with only rejections from a session with no read is
   `bad_output (nothing_read)`: a hunt fails the scan (a `standard` focus hunt costs its
   area, the scan ends `incomplete`), a verify keeps the candidate as a lead and ends the
   scan `incomplete`. Either way the public gate stays closed. B5 is now an `unsignalled`
   fixture; the clean controls (B4, A5, C7) read a file first.

The S11 egress harness now expects the M30 copy-host intercept (`copy.void.internal`)
between the model host and the catch-alls.

**Fixed after a review of those fixes** (re-run: S9 24/24, S11 160/160):

1. Glob and Grep `path` with whitespace at either end is refused. Claude Code trims a
   Glob or Grep `path` before it reads `~` or resolves it, and those two tools reach
   the hook untrimmed (Read reaches it already made absolute). `path: " /"` passed as a
   folder named ` ` under input and searched `/`; `" ~"` and `".. "` the same way.
   Checked live against Claude Code 2.1.328 with a fake Messages API. A `path` that is
   not a string is refused too.
2. `stats.reads` now counts only reads that returned code: a read of a file under
   `/scan/input` with non-blank lines. Reading the memory index (the hunt prompt asks for
   it first), listing, searching, a failed read or a Glob that matched nothing does not
   count, so "obey step 1, then decline" no longer passes. Engine B: `FsTools.readFile`
   marks such a result. Engine C: the void-scan server writes the count to
   `<out>.reads`; Codex events are not read for it. Engine A: a PostToolUse hook on Read
   reads `tool_response.file.content` (PreToolUse runs before the tool, so it cannot
   see whether the read worked). S9 fixtures B6, A6 and C9 cover the three engines.
   Remaining risk: a model that reads one file and then declines still looks like a
   clean scan. A deployment whose `/scan/input` holds no non-blank file cannot end clean.
3. Engine A: a turn that stopped with `refusal` and no report ends `refused`, even when
   the result after it says `is_error` or `end_turn`. The env pins
   `CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL=0` so a refused turn is not retried on
   another model (no `fallbackModel` is set either).
4. `classifyCodexRun` compares letters and digits only, so `cyber  policy`, a line break
   between the words and the Debug form `CyberPolicy { … }` all end `refused`.
5. The proxy looks for `cyber_policy` / `trusted_access_for_cyber` in any `code` or
   `type` field at any depth (a Cloudflare `errors[]` envelope, `error[]`, a provider
   body held as JSON text in a message), keeps 8000 characters of the body instead of
   2000, and searches a body that does not parse for the quoted code. A 402 stays a
   credits stop even with a policy code in its body (the dead 402 mapping is gone).
   Release check: compare with a recorded `/ai/v1` refusal 400 once credits allow; the
   real shape has not been seen.

Handed back, not changed: Codex also prints `bio policy: …`, `misalignment policy
violation: …`, `invalid prompt: …` and `Incomplete response returned, reason:
content_filter`, and the provider can answer `invalid_prompt` / `bio_policy`. These end
`failed (infrastructure)` and are retried. Spec §8.4 names only the two cyber codes, so
whether they count as refusals is a product decision. None of them opens the gate.

### S12 legal checklist (open questions for the user)

Not decided here. Each needs a written answer before MVP.

1. Anthropic terms for operators. A self-hosted operator runs Engine A with their own
   Cloudflare account and Unified Billing. Who is the "Customer" under the Anthropic
   Commercial Terms / Agent SDK terms: the operator, Cloudflare, or VoidZero? Do the
   Agent SDK terms allow it inside a product that other people install?
2. Redistributing Claude Code. The Engine A image ships the Claude Code native binary
   (via the Agent SDK package) and Void publishes that image on ghcr. Is publishing that
   image allowed, or must each operator build or pull it from Anthropic?
3. Codex licence. The Engine C image ships the `codex` binary and the SDK (Apache-2.0,
   plus `bwrap`, `codex-code-mode-host` and LGPL voice libraries in the platform
   package). Is shipping `LICENSE` enough, or do we need a `NOTICE` and the LGPL texts
   (and the source offer for LGPL parts)?
4. OpenAI usage policies. Is automated vulnerability scanning of a customer's own code
   allowed for `openai/*` models through Cloudflare? Does `access_programs.cyber:
   standard` (sent by the proxy) need an agreement, and is the trusted-access-for-cyber
   program needed for scan prompts?
5. Naming. Can docs, UI and CLI say "Claude", "Claude Code", "Codex" or "GPT" (as model
   or engine names)? Proposal to check: Void names only ("Engine A / C", "security
   audits") and plain model ids, with no third-party names in product names, badges or
   the image names.
6. Data terms. Unified Billing sends customer source code to Anthropic / OpenAI through
   Cloudflare. Does the provider notice (`SECURITY_PROVIDER_NOTICE_VERSION`) cover what
   each provider's terms require (retention, training, zero-data-retention)?

## Test strategy

Fakes:

| Fake                                                                                                         | Where                                                          | Used by                                                      |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Fake model server (scripted SSE for Messages, Responses, chat; records requests)                             | `platform/packages/security-scanner/test/fake-model/server.ts` | runner unit tests, e2e recorded runs, S2/S3 local parts      |
| Fake container (`ctx.container` with `start`, `exec`, `interceptOutboundHttp`, `interceptAllOutboundHttp`)   | `platform/packages/api/test/__mocks__/container.ts`            | controller runtime unit tests                                |
| Fake scanner controller binding (canned `findings.json` per scan, configurable status, delays, late results) | `test/integration/helpers.ts` (`createFakeSecurityScanner`)    | enqueue → ingest → gate integration tests without containers |
| Fake AI (mock `fetch` for `/ai/v1/*`, mock `env.AI.run`)                                                     | helpers                                                        | model proxy, probe                                           |
| `mockCfApi` containers/scanner state                                                                         | extend `test/integration/helpers.ts`                           | provisioning, probe, uninstall                               |

Keeping tests fast:

- Business rules are pure functions with unit tests: tier choice, filters, redaction,
  memory, fingerprint, reopen, "new", budget math, gate judge. Integration tests cover
  only transactions, locks and route contracts.
- Integration tests reuse the PGlite template (it rebuilds once for 0065). No new PGlite
  unit file except the migration test.
- The real SDKs are not workspace dependencies (about 800 MB of native binaries, and
  `catalogMode: strict`). The runner imports an engine interface; SDKs install only in
  `image/` from their own lockfile. Docker e2e runs only with `VOID_SCANNER_E2E=1` and in
  the CI image job.
- No live Cloudflare call in `vp test run`. Live checks are the spike scripts plus one
  release smoke script, `platform/scripts/security-smoke-test.ts` (probe, one scan on a
  seeded app, one gate request, cleanup), run by hand before release.
- Watch the scheduled and zero-trust suites: they are already the slowest; new cases go
  in new files so the forks runner spreads them.

Native and Workers Free regression (AGENTS.md rule):

- `packages/void/test/unit/cloudflare-deploy.test.ts`: a native deploy of an app with no
  AI makes no `/security` request, no `/containers/` request, emits no AI binding.
- `packages/void/test/unit/cf-version-runner.test.ts`: `body.containers` stays undefined.
- `packages/platform/test/unit/worker-config.test.ts`: capability off → only the DO binding
  and tag are new; capability on → only `ai` added on the API Worker; no scanner Worker in
  `workerConfigs`.
- `platform/packages/api/test/integration/security-capability-off.test.ts`: capability off
  → no probe, no provisioning call, no scan row on deploy, write routes 501.
- `packages/void/test/unit/project-cmd.test.ts`: `project security` and `zero-trust bypass`
  on a `cloudflare` target throw before any network call.

Verification per AGENTS.md: exact file first (`-t` for a case), `vp run test --list`,
`vp run test` per milestone batch, `vp check` per batch, `vp test run` once at M36.

## Risks and items for the user

Items that need a user call are marked **(user)**. The rest are decided here and can
be pushed back on.

| #   | Item                                                                                                                                                                                                                                                                                                    | Plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **(user)** Image source. A container app with the `durable_object` scheduling policy (the Sandbox pattern) only runs `registry.cloudflare.com/<operator account>/…` images. "An image Void publishes at a pinned digest" cannot be used as is, and PRD §5.1 forbids building on the operator's machine. | Engine B (default `@cf` model) uses the managed `cloudflare/debian-trixie` image plus the runner streamed in at start (like `sandbox-shim.ts`): nothing to publish. Engines A/C: the API copies a digest-pinned Void image into the operator registry (option A), or the app uses the `default` policy (option B). **Status:** S1b (`security-spike-s1b.ts`) tested option A only with a ~2 MB busybox image (Worker copy by digest with short-lived registry credentials, then `image-preparations`); its numbers were not written down. A full-size engine image has not been copied live with the M13b code, so copy time per probe window is unmeasured. M13b builds option A with public images at `ghcr.io/voidzero-dev/void-security-scanner-engine-{a,c}` and both pins `null`. **Still open for the user:** OK on option A and on that publish location before the first push. |
| R2  | One PR vs spec "DO migration one release before the feature". **Decided: single PR.**                                                                                                                                                                                                                   | The `SecurityScanScheduler` class and its `security-audits-v1` migration tag ship in the same release as the feature. The feature is off by default (capability off, policy Off), so the class stays idle. A Worker rollback cannot cross that release (Cloudflare does not roll back past a DO migration): after it, a bad release is fixed by rolling forward. Release notes and the M24 docs say so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R3  | **(user)** All three phases in one PR.                                                                                                                                                                                                                                                                  | Very large review. Phase 2 M30 depends on S13 and Phase 3 M32 is a new privacy promise (code leaves the developer machine). If S13 fails, M30 is dropped and noted. Suggest a stacked PR per phase if review load is too high.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R4  | Deploy `--json` does not exist today, so spec "deploy result gains `security` in `--json`" has nothing to attach to.                                                                                                                                                                                    | Not built; noted in docs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R5  | **(user)** Skill upstream repo URL for "security-audit-skill @ c1c8a8c" is not in the spec or repo.                                                                                                                                                                                                     | Needed before M13 vendoring. M5 ships the Void companion + profile with a stub skill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R6  | **(user)** Sonnet 5.5 price is missing; the meter needs a price for every model.                                                                                                                                                                                                                        | Ship Sonnet in the list but not pickable (treated as blocked) until a price is filled in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R7  | **(user)** Legal (S12): Agent SDK native binary in a Void-published image; OpenAI terms.                                                                                                                                                                                                                | M13 code lands; A/C models stay unpickable until S12 is OK. Fallback per PRD: ship `@cf` + Engine B first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R8  | "No live deploy is missed" is weaker on one path: compensate `post_routing_recovery` writes `live` outside any transaction with errors swallowed.                                                                                                                                                       | Enqueue there in its own short tx, logged on failure. The gap is accepted and listed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R9  | Codex SDK cannot pass the lockdown flags. Spec pins 0.167.1; latest is 0.170.0.                                                                                                                                                                                                                         | Wrapper script via `codexPathOverride`, covered by the drift test. Pin the version current at M13.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R10 | REST `/ai/v1/*` needs an AI permission on the runtime token and the `cf-aig-gateway-id` header. Binding calls may ignore the payload-off header (0094 live check A still pending).                                                                                                                      | `@cf` on the binding (no new permission); third party on REST; probe check 5 names a missing permission; S10 can move `@cf` to REST. `credentials.md` gains the row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R11 | Uninstall keeps platform Workers unless `--purge-resources`; the PRD says uninstall removes the scanner.                                                                                                                                                                                                | Follow the PRD: uninstall always deletes the scanner Worker and container app (they hold no data; R2 data follows the bucket rule). Found by name + ownership marker, since the installer record does not list API-created resources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R12 | Input build runs in the API Worker (redaction needs secrets). Large T3 inputs may hit Worker CPU limits.                                                                                                                                                                                                | S7/S8 measure; if too slow, build in the scheduler DO alarm in chunks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R13 | Phase 3 local checks: findings would break reopen and gate rules that assume a deployment.                                                                                                                                                                                                              | Separate short-lived result; never touches project findings or the gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R14 | Phase 3 BYOK: does BYOK spend count toward caps?                                                                                                                                                                                                                                                        | Yes, metered and counted (installation still pays compute; one rule).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R15 | Per-plan caps: catalog parser needs the exact key set; two-release rule cannot fit one PR.                                                                                                                                                                                                              | Separate settings key `plans:security-caps` (0094 precedent). No `PlanLimits` change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R16 | Paging: spec asks for cursors; operator API uses page/limit.                                                                                                                                                                                                                                            | Operator routes keep page/limit (CLI consistency); project routes use a `before` cursor on `number`/`created_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R17 | Old CLI on `void platform upgrade` drops the flag.                                                                                                                                                                                                                                                      | Manifest v7 when on (old CLIs refuse).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R18 | Cron: fast tier is missing on some self-hosted installs and returns early.                                                                                                                                                                                                                              | All security jobs in the hourly tier only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R19 | Admin shell has no banner or badge slot.                                                                                                                                                                                                                                                                | New props through `renderAdminPage` and fate renders (M18).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R20 | Model ids and prices are for models that may change before release.                                                                                                                                                                                                                                     | One list in `@void/platform/security-models`, updated per release; S10 checks prices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Hard or impossible as written in the PRD (flagged, not silently changed): R1 (image),
R2 (release order), R4 (deploy `--json`), R8 (one go-live path outside a transaction),
R15 (per-plan caps in `PlanLimits`), and the `/internal/security-scans/*` HTTP routes
(replaced by RPC with the same promise: not on the public hostname).

## Docs to update

| File                                                                                                                                                                                                | Change                                                                                            | Milestone |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `docs/guide/platform/administration/security-audits.md` (new) + sidebar in `docs/.vitepress/config.ts`                                                                                              | enable, probe, policy, models and notice, outcomes, caps, emails, scan before public, bypass      | M24       |
| `docs/guide/platform/administration/zero-trust.md`                                                                                                                                                  | gate effects; disable and public-only refused while on                                            | M24       |
| `docs/reference/cli.md`                                                                                                                                                                             | rows for `void project security`, `void project zero-trust bypass`, `void platform security`      | M24       |
| `docs/reference/cli/project.md`                                                                                                                                                                     | new security section; zero-trust held output, status lines, `bypass`, `protect` cancels, `--json` | M24       |
| `docs/reference/cli/deploy.md`                                                                                                                                                                      | short paragraph on the deploy notice (user session vs CI)                                         | M24       |
| `docs/reference/cli/platform-security.md` (new) + `platform.md` link and paging list + sidebar                                                                                                      | operator commands                                                                                 | M24       |
| `docs/reference/cli/platform-zero-trust.md`                                                                                                                                                         | `project-public` goes through the gate; refusals                                                  | M24       |
| `docs/reference/cli/platform-installation.md`                                                                                                                                                       | `--security-audits` on install and upgrade                                                        | M24       |
| `docs/guide/self-hosted-platform.md`                                                                                                                                                                | feature row: Workers Paid + Containers + AI credits                                               | M24       |
| `docs/guide/platform/installation/credentials.md`                                                                                                                                                   | AI permission for third-party models (R10)                                                        | M24       |
| `docs/guide/platform/installation/uninstall.md`                                                                                                                                                     | scanner Worker, container app, `security-scans/` data                                             | M24       |
| `packages/void/skills/void/SKILL.md`                                                                                                                                                                | routing rows + one working-rule bullet (no copied instructions)                                   | M24       |
| `platform/meta/design-docs/README.md`                                                                                                                                                               | index row (Administration and AI)                                                                 | M24       |
| this file                                                                                                                                                                                           | status → implemented, live check results, scanner invariants                                      | M36       |
| Phase 2/3: `project.md` (`scan`, `check`, `severity`, `--format sarif`), `platform-security.md` (backfill, sweeps, fallback, keys, `--project` policy), `plans.md` (security cap), dashboard README | –                                                                                                 | M36       |
| `packages/void/AGENTS_TEMPLATE.md`, root `README.md`                                                                                                                                                | no change                                                                                         | –         |

CLI help, the `void project` hint (`cli-main.ts`) and the `void platform` hint (from
`operatorGroups`) change with M20–M23, as the AGENTS.md CLI rule requires.
