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
  600k×in + 60k×out, notice version, provider names); `security-policy.ts` (type,
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

**M11 T1 source diff (hosted, `managedBuilds`).**

- Scope: `compareCommits` in `github/installation-token.ts` (files, patch, truncation);
  head tarball to R2; project root + source-map-listed shared files; OIDC `sha` match.
- Tests: unit `security-input-t1.test.ts` (truncated → T2, force push → T2/T3 — #9,
  monorepo — #32, mismatch → `commit-mismatch` — #38); integration
  `security-t1-github.test.ts` with mocked GitHub.
- Exit: self-hosted never takes T1.

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

**M17 Operator security routes (rest).**

- Scope: `operator/security-routes.ts`: budget GET/POST, findings, scans, rescan (T3,
  never `no changes`, cost preview — #43), cancel, public-requests, bypasses, project
  findings resolve/reopen/comments, model, budget, public-request bypass. Paging with
  the existing `pagination()` (page/limit). All writes POST + dryRun; audit targets.
- Tests: integration `operator-security.test.ts`, `operator-audit.test.ts`.
- Exit: every route in spec §13.5 operator row exists and is audited.

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

| Spike             | Script                                                                              | Runs                                                                              | Measures                                                                                                                                                                                                                                   | Pass (PRD §15.2 / spec §20)                                                                     | Fail                                                                     |
| ----------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S1 egress         | `security-spike-s1-egress.ts`                                                       | **live** (Workers Paid, Containers)                                               | deploy a scratch controller + app; model call via `ScanModelOutbound`; `fetch https://example.com` and unknown DNS fail fast (< 2 s with `DenyAll`); env + FS have no token; identity reaches API props; cold start p50/p95 over 10 starts | call works, internet blocked, no token, cold start < 60 s                                       | Sandbox outbound pattern; still failing → stop (no MVP)                  |
| S1b image         | `security-spike-s1-image.ts`                                                        | **live**                                                                          | copy a digest-pinned image into `registry.cloudflare.com/<acct>` from a Worker (credentials API, streaming), then `prepareContainerImage`; also test `default` scheduling policy pulling `docker.io`                                       | one of the two works with a scoped token, < 15 min, Worker memory OK                            | raise R1 to the user                                                     |
| S2 Agent SDK      | `security-spike-engine.ts --engine claude`                                          | lockdown **local** (Docker + fake model), quality **live** (credits)              | tools list, planted config files, valid output 10/10 on 3 apps, time                                                                                                                                                                       | lockdown holds; 10/10 valid; ≤ 20 min                                                           | stop and ask the user (D37)                                              |
| S3 Codex          | `security-spike-engine.ts --engine codex` + `security-spike-codex-lockdown.ts`      | items 1, 2, 5, 7 **local**; 3, 4, 6, 8 **live**                                   | the 8 items in spec §20                                                                                                                                                                                                                    | all 8 hold                                                                                      | stop and ask the user (D37)                                              |
| S4 Engine B       | `security-spike-engine.ts --engine void-loop --model @cf/zai-org/glm-5.3 --tier t2` | **live** (Workers Paid / AI credits); harness checked locally with the fake model | recall on 10 planted bugs, false confirmed, valid runs, calls, p95 at 10 req/min                                                                                                                                                           | ≥ 7/10, ≤ 2 false, ≥ 95% valid, ≤ 80 calls, p95 < 20 min                                        | ask the user; glm-5.3 stays default                                      |
| S5 static confirm | same script, `--report confirmations`                                               | **live**                                                                          | share of seeded bugs reaching `confirmed` with a trace                                                                                                                                                                                     | seeded issues confirm                                                                           | define "confirmed (static)", re-run S2/S4; none → every result is a lead |
| S6 parity         | `security-spike-parity.ts`                                                          | **live** (3 engines)                                                              | same issue → same key over 3 repeats                                                                                                                                                                                                       | ≥ 80%                                                                                           | server key normalization                                                 |
| S7 inputs         | `security-spike-inputs.ts`                                                          | **local**                                                                         | builds `playground/*` React/Vue/Svelte/Solid; `sourcesContent` coverage; lockfile identity; workspace packages kept; snapshot size in R2 terms; lists every go-live call site                                                              | ≥ 90% server files readable; one cutover path covers all (or the extra paths are listed for M8) | more T3 / `no-source-maps`                                               |
| S8 cost/time      | `security-spike-engine.ts --all-models --report cost`                               | **live**                                                                          | tokens, calls, $, minutes per tier and model, T3 gate scans                                                                                                                                                                                | glm median ≤ $3 per ~2k-line diff, p95 ≤ 20 min                                                 | tighten caps; ask before changing the default                            |
| S9 refusals       | `security-spike-refusals.ts`                                                        | mapping **local** (recorded fixtures), rates **live**                             | 10 runs × 4 third-party models                                                                                                                                                                                                             | 100% refusals → `refused`, 0 → `succeeded`                                                      | fix mapping, badges                                                      |
| S10 gateway       | `security-spike-gateway.ts`                                                         | **live**                                                                          | payload off and skip-cache on binding and REST paths; cost by `securityScan` tag; meter vs gateway                                                                                                                                         | no bodies, no cache, cost readable, ±10%                                                        | dedicated scan gateway with logs off; fix prices; Engine B moves to REST |
| S11 red team      | `security-spike-redteam.ts`                                                         | server rules and tool escapes **local** (fake model); model misses **live**       | fixtures listed in spec §20 S11                                                                                                                                                                                                            | no escape, no egress, server rules and caps hold                                                | fix before MVP                                                           |
| S12 legal         | none (document review)                                                              | –                                                                                 | Agent SDK terms for operators and image redistribution, OpenAI terms, naming                                                                                                                                                               | written OK                                                                                      | raise to the user                                                        |
| S13 copy          | `security-spike-copy.ts`                                                            | **live** (Workers for Platforms)                                                  | copy serves a seeded app, outbound fails, not reachable from the internet, < 60 s, no leftovers, cost                                                                                                                                      | all hold                                                                                        | Phase 2 stays static-only (M30 not built)                                |

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
