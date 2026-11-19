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
  invalid: …". Not built here: the controller still answers `engine_unavailable` for A/C
  (it needs the image copy by digest into the operator registry, spike S1b option A, and a
  second container app per engine), the CI job does not yet push images to ghcr, the
  `recorded-run.e2e` Docker test, and the upstream skill (R5). Without those, A/C models
  cannot run a scan; their live quality numbers are blocked on credits (S2/S3).
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

**M19 Signed project page.**

- Scope: `page-token.ts` (HMAC, own purpose label, 15 min, user + project);
  `routes/security-page.ts` at `/security/projects/:slug` mounted next to `/email`
  without `/projects` auth; token → HttpOnly cookie (path-scoped, Lax, 15 min) →
  redirect; access re-checked each load; landing page without token; `no-store`,
  `no-referrer`; role-based content; all values escaped.
- Tests: integration `security-page.test.ts` (expired, other user, other project,
  reader view, behind platform Access — extend `platform-access-protection.test.ts`).
- Exit: page renders for each role with no data leak.

**M20 CLI `void project security`.**

- Scope: parser, `project-security.ts` printers and `--json`, client methods with
  `permission`, 404-without-JSON → "does not support", 409/422 copy, length checks,
  `open` (TTY and not CI), terminal sanitizing. Help, hint, usage.
- Tests (unit): `project-args.test.ts`, `project-security-command.test.ts`,
  `cli-help.test.ts`, `project-lookup-client.test.ts` (404 split).
- Exit: mock replies print the spec §13.3 copy.

**M21 CLI `void project zero-trust` changes.**

- Scope: `bypass --reason [--yes]`, `--json` everywhere, 202 held output (never "is
  public"), status request block, error copy; project error JSON in `cli-main.ts`.
- Tests: `project-zero-trust-command.test.ts` (old platform unchanged; 202; bypass
  409s), `project-args.test.ts`.
- Exit: old-platform replies print exactly as today.

**M22 CLI deploy notice and `project status` line.**

- Scope: `deploy-security-notice.ts` called after `printDeploySuccess` in all three
  managed paths; one GET with 5 s abort; any error prints nothing; never touches
  `process.exitCode`; 5 rows + "… and N more"; counts only in CI/GitHub Actions or when
  the server says `counts`; extra lines (spec §6.5); cliLog entry. `list.ts` Security line.
  Deploy `--json` row is not built (R4).
- Tests: `deploy-security-notice.test.ts`, `list-command.test.ts`, native regression
  in `cloudflare-deploy.test.ts` (no `/security`, no `/containers/`, no AI binding).
- Exit: 404, timeout, 500 → no output, same exit code.

**M23 CLI operator group, installer flag, uninstall.**

- Scope: `group:'security'` entries (status, probe, policy, models, limits with
  `--scan-timeout`, budget + budget-set, findings with `--urgent` moved to the query,
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

**M24 Phase 1 docs.** See Docs below. Exit: `vp check`, docs links resolve.

### Phase 2

**M25 Project rescan, admin backfill, scheduled sweeps.** `POST /projects/:id/security/scans`
(`settings`; same rule as operator rescan, cost confirm), `void project security scan`,
operator `security backfill --plan` (cost preview, queued as `trigger=backfill`), policy
`sweeps: {on, everyDays}` run by the hourly job as `trigger=sweep` with the skill
`standard` profile. Tests: `api-project-security.test.ts`, `security-sweeps.test.ts`,
`project-security-command.test.ts`.

**M26 Fallback, failure-streak emails, digest, webhooks.** Policy `fallbackToCf` (opt-in,
never `@cf` → third party) → one `trigger=fallback` scan after refused / bad_output /
timed_out; streak email to installation admins split by cause; weekly digest; webhook
URL (signed body, ids and counts only). Tests: `security-fallback.test.ts`,
`security-notifications.test.ts`.

**M27 Per-plan caps.** Stored in a separate settings key `plans:security-caps`
(`{ <planId>: usdCents | null }`), not in `PlanLimits`, so the exact-key catalog parser
and rollback stay safe (same reason as `plans:ai-logging` in 0094). Ceiling order:
project ceiling → plan cap → policy default. Operator `config plans` gains
`--security-cap`; admin Plans page shows it. Tests: `security-budget.test.ts`,
`operator-plans.test.ts`, `admin-plans.test.ts`.

**M28 GitHub `Void Security Audit` check.** Hosted only; `createCheckRun` /
`completeCheckRun` at ingest, conclusion always `neutral`, counts + landing link; PR
comment (counts only); `check_run:rerequested` for this name queues a project rescan
only for callers who could rescan, else no-op. Tests: `security-github-check.test.ts`.

**M29 Page forms and dashboard pages.** Page forms (resolve, comment, model, budget,
bypass) with CSRF (`admin/middleware/csrf.ts` pattern) and the same server operations.
Dashboard: `pages/projects/index.tsx`, `pages/projects/[slug]/security.tsx` (+ `.server.ts`)
via typed `hc<ApiRoutes>`. Tests: `security-page.test.ts` (forms, CSRF),
dashboard page tests in `platform/packages/dashboard/test`.

**M30 Runtime checks on a throwaway copy.** Needs S13 pass. Per scan: copy bundle N into
the dispatch namespace as `sec-copy-<scan>` with empty D1/KV/R2, migrations, fake
secrets, stubbed AI/email/queue, outbound blocked by a dispatch outbound Worker,
reachable only from the scan's controller (a second intercepted host
`copy.void.internal`); deleted at scan end and by the reaper. Verdict source
`confirmed (runtime)`; cost in the meter. Tests: unit
`security-runtime-copy.test.ts` (mockCfApi), runner `verify-runtime.test.ts`;
live only for the real copy.

**M31 Server secret findings, client asset deep scan, SARIF.** Redaction hits become
server findings (`source=server`, category secret-in-output, no value stored);
optional client asset pass; `void project security list --format sarif` and operator
export. Tests: `security-redact.test.ts`, `security-sarif.test.ts`.

### Phase 3

**M32 Local tree scan (`void project security check`).** CLI collects git-tracked
files with the §7.4 filters and secret-file drop, shows the provider notice when the
model is third-party, uploads through `POST /projects/:id/security/checks` (`deploy`,
presigned R2 URLs), scan `trigger=local`, `deployment_id` null. Results are a separate,
short-lived result: they never open, reopen, prove or hold anything (R13). CLI polls and
prints. Tests: `security-local-check.test.ts`, `project-security-check-command.test.ts`.

**M33 BYOK.** Encrypted provider keys in `platform_settings['securityAudits.providerKeys']`
(`encryptPlatformCredential`); proxy adds the key server-side; probe check 5 per BYOK
host; BYOK spend still metered and counted (R14). Operator
`security models --provider anthropic --key-stdin`. Tests: `security-byok.test.ts`.

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

| #   | Item                                                                                                                                                                                                                                                                                                    | Plan                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **(user)** Image source. A container app with the `durable_object` scheduling policy (the Sandbox pattern) only runs `registry.cloudflare.com/<operator account>/…` images. "An image Void publishes at a pinned digest" cannot be used as is, and PRD §5.1 forbids building on the operator's machine. | Engine B (default `@cf` model) uses the managed `cloudflare/debian-trixie` image plus the runner streamed in at start (like `sandbox-shim.ts`): nothing to publish. Engines A/C: the API copies a digest-pinned Void image into the operator registry (option A), or the app uses the `default` policy (option B). S1b decides; we need the user's OK on A vs B and on where Void publishes the image.  |
| R2  | One PR vs spec "DO migration one release before the feature". **Decided: single PR.**                                                                                                                                                                                                                   | The `SecurityScanScheduler` class and its `security-audits-v1` migration tag ship in the same release as the feature. The feature is off by default (capability off, policy Off), so the class stays idle. A Worker rollback cannot cross that release (Cloudflare does not roll back past a DO migration): after it, a bad release is fixed by rolling forward. Release notes and the M24 docs say so. |
| R3  | **(user)** All three phases in one PR.                                                                                                                                                                                                                                                                  | Very large review. Phase 2 M30 depends on S13 and Phase 3 M32 is a new privacy promise (code leaves the developer machine). If S13 fails, M30 is dropped and noted. Suggest a stacked PR per phase if review load is too high.                                                                                                                                                                          |
| R4  | Deploy `--json` does not exist today, so spec "deploy result gains `security` in `--json`" has nothing to attach to.                                                                                                                                                                                    | Not built; noted in docs.                                                                                                                                                                                                                                                                                                                                                                               |
| R5  | **(user)** Skill upstream repo URL for "security-audit-skill @ c1c8a8c" is not in the spec or repo.                                                                                                                                                                                                     | Needed before M13 vendoring. M5 ships the Void companion + profile with a stub skill.                                                                                                                                                                                                                                                                                                                   |
| R6  | **(user)** Sonnet 5.5 price is missing; the meter needs a price for every model.                                                                                                                                                                                                                        | Ship Sonnet in the list but not pickable (treated as blocked) until a price is filled in.                                                                                                                                                                                                                                                                                                               |
| R7  | **(user)** Legal (S12): Agent SDK native binary in a Void-published image; OpenAI terms.                                                                                                                                                                                                                | M13 code lands; A/C models stay unpickable until S12 is OK. Fallback per PRD: ship `@cf` + Engine B first.                                                                                                                                                                                                                                                                                              |
| R8  | "No live deploy is missed" is weaker on one path: compensate `post_routing_recovery` writes `live` outside any transaction with errors swallowed.                                                                                                                                                       | Enqueue there in its own short tx, logged on failure. The gap is accepted and listed.                                                                                                                                                                                                                                                                                                                   |
| R9  | Codex SDK cannot pass the lockdown flags. Spec pins 0.167.1; latest is 0.170.0.                                                                                                                                                                                                                         | Wrapper script via `codexPathOverride`, covered by the drift test. Pin the version current at M13.                                                                                                                                                                                                                                                                                                      |
| R10 | REST `/ai/v1/*` needs an AI permission on the runtime token and the `cf-aig-gateway-id` header. Binding calls may ignore the payload-off header (0094 live check A still pending).                                                                                                                      | `@cf` on the binding (no new permission); third party on REST; probe check 5 names a missing permission; S10 can move `@cf` to REST. `credentials.md` gains the row.                                                                                                                                                                                                                                    |
| R11 | Uninstall keeps platform Workers unless `--purge-resources`; the PRD says uninstall removes the scanner.                                                                                                                                                                                                | Follow the PRD: uninstall always deletes the scanner Worker and container app (they hold no data; R2 data follows the bucket rule). Found by name + ownership marker, since the installer record does not list API-created resources.                                                                                                                                                                   |
| R12 | Input build runs in the API Worker (redaction needs secrets). Large T3 inputs may hit Worker CPU limits.                                                                                                                                                                                                | S7/S8 measure; if too slow, build in the scheduler DO alarm in chunks.                                                                                                                                                                                                                                                                                                                                  |
| R13 | Phase 3 local checks: findings would break reopen and gate rules that assume a deployment.                                                                                                                                                                                                              | Separate short-lived result; never touches project findings or the gate.                                                                                                                                                                                                                                                                                                                                |
| R14 | Phase 3 BYOK: does BYOK spend count toward caps?                                                                                                                                                                                                                                                        | Yes, metered and counted (installation still pays compute; one rule).                                                                                                                                                                                                                                                                                                                                   |
| R15 | Per-plan caps: catalog parser needs the exact key set; two-release rule cannot fit one PR.                                                                                                                                                                                                              | Separate settings key `plans:security-caps` (0094 precedent). No `PlanLimits` change.                                                                                                                                                                                                                                                                                                                   |
| R16 | Paging: spec asks for cursors; operator API uses page/limit.                                                                                                                                                                                                                                            | Operator routes keep page/limit (CLI consistency); project routes use a `before` cursor on `number`/`created_at`.                                                                                                                                                                                                                                                                                       |
| R17 | Old CLI on `void platform upgrade` drops the flag.                                                                                                                                                                                                                                                      | Manifest v7 when on (old CLIs refuse).                                                                                                                                                                                                                                                                                                                                                                  |
| R18 | Cron: fast tier is missing on some self-hosted installs and returns early.                                                                                                                                                                                                                              | All security jobs in the hourly tier only.                                                                                                                                                                                                                                                                                                                                                              |
| R19 | Admin shell has no banner or badge slot.                                                                                                                                                                                                                                                                | New props through `renderAdminPage` and fate renders (M18).                                                                                                                                                                                                                                                                                                                                             |
| R20 | Model ids and prices are for models that may change before release.                                                                                                                                                                                                                                     | One list in `@void/platform/security-models`, updated per release; S10 checks prices.                                                                                                                                                                                                                                                                                                                   |

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
