---
title: Security audits on deploy
status: implemented
created: 2026-11-18
---

# Security audits on deploy

The design as built for the approved PRD, all three phases. Product rules, copy and the
94 edge cases stay in the PRD and spec; this file says where the code is, how the parts
fit, which rules every change must keep, and what is still open.

- PRD: `void-prds/security-audits-prd.md` (short), spec: `void-prds/security-audits-spec.md`.
  Decision numbers D1–D52, Q1–Q15 and edge case numbers (#1–#94) come from there.
- Background: [project Zero Trust](./0083-project-zero-trust.md),
  [managed Sandbox restoration](./0082-managed-sandbox-restoration.md),
  [operator CLI](./0078-platform-operator-cli.md),
  [permission errors](./0081-project-permission-errors.md),
  [installation plans](./0090-installation-plans.md),
  [AI Gateway logging policy](./0094-ai-gateway-logging-policy.md).
- The spec calls this doc `0094-security-audits.md`; 0094 is taken, so it is 0095.
- Code comments name milestones (M1–M36) and risks (R1–R20); the
  [milestone index](#milestone-index) and [risks](#risks-and-items-for-the-user) map them.

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

## Scanner invariants

Every change to the scanner, the controller, the model proxy or the gate must keep these.
Each one has tests (named) or a spike that checks it.

| #   | Invariant                                                                                                                                            | Held by                                                                                      | Checked by                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | A scan never blocks, slows or fails a deploy, rollback, build or GitHub check (D45)                                                                  | go-live tx writes a row only; all scan work runs after commit; the GitHub check is `neutral` | `security-enqueue.test.ts`, `security-github-check.test.ts`                                                                                                                                            |
| I2  | The container has no internet. It reaches only `model.void.internal` and `copy.void.internal`, and the input comes in over `exec` stdin              | `start({ enableInternet: false, env: {} })`, outbound intercepts in the controller           | S11 (egress 19/19); S1 not recorded                                                                                                                                                                    |
| I3  | No credential enters the container: no token in env or files; identity is in service-binding props; own provider keys stay in the API (M33)          | `ScanModelOutbound` / `CopyOutbound` props, proxy adds headers                               | S11, `security-byok.test.ts`; S1 not recorded                                                                                                                                                          |
| I4  | Every controller write carries `(scan, attempt)`; a write from an ended or reaped attempt is refused                                                 | lease + attempt fence in `control.ts`                                                        | `security-scan-control.test.ts`                                                                                                                                                                        |
| I5  | Only a human closes a finding; a scan adds, confirms or reopens. A human severity is never changed by a scan                                         | `findings.ts` `decideSeenFinding`                                                            | `security-findings-rules.test.ts`                                                                                                                                                                      |
| I6  | No project goes public through a gated request without a gate pass or a recorded bypass; no bypass while an urgent finding is open (D46, D50)        | `public-gate-judge.ts`, bypass under the project lock                                        | `security-gate-bypass.test.ts` ("public gate bypass races", #94), `security-public-gate.test.ts` (bypass refused while urgent open), `security-gate-judge.test.ts`, `security-gate-zero-trust.test.ts` |
| I7  | A scan starts only when its worst case fits every cap; each model call is metered against the hold; own-key spend counts too (R14)                   | scheduler reserve, proxy `UPDATE … RETURNING`                                                | `security-budget.test.ts`, S11 (caps 12/12)                                                                                                                                                            |
| I8  | No code goes to a third-party model before its provider notice is accepted; a fallback never moves a `@cf` scan to a third party                     | model resolve, `fallback.ts`                                                                 | `security-fallback.test.ts`, `api-project-security.test.ts`                                                                                                                                            |
| I9  | Stored secret values are replaced before any model sees code; a secret finding never stores the value; no runtime copy when a value is in the bundle | `input/redact.ts`, `runtime-copy-plan.ts`                                                    | `security-redact.test.ts`, `security-runtime-copy.test.ts`                                                                                                                                             |
| I10 | A refused, timed-out, failed or incomplete scan is never "clean" for the gate, the page or the GitHub check                                          | `ingest.ts` outcome table                                                                    | S9 (24/24), `security-ingest.test.ts`                                                                                                                                                                  |
| I11 | Files from the scanned code (`AGENTS.md`, `.claude/`, `.codex/`, `.agents/skills`, `.mcp.json`) are input only, never engine config                  | Engine A `settingSources: []`, Engine C empty cwd and own `CODEX_HOME`                       | S2, S3, S11                                                                                                                                                                                            |
| I12 | A local check never opens, reopens, proves or holds anything (R13)                                                                                   | `storeLocalOutcome`                                                                          | `security-local-check.test.ts`                                                                                                                                                                         |
| I13 | Capability off: only the idle `SecurityScanScheduler` class is new; native Cloudflare deploys are unchanged                                          | runtime manifest, CLI target checks                                                          | capability-off cases in `security-enqueue.test.ts` and `api-project-security.test.ts`; `cloudflare-deploy.test.ts`, `cf-version-runner.test.ts`, `worker-config.test.ts`                               |

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
 │ ScannerController DO, one instance per scan attempt             │─────┘     └── owner, admins, deploy authors,
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

Main choices (the spec says the same promise another way; flagged in Risks):

| Choice                                                                                     | Why                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SecurityScanControl` RPC entrypoint, not `/internal/security-scans/*` HTTP                | Same as `SandboxControl`: identity comes from immutable binding `props`, nothing on the API hostname, no Access allowlist entry                                          |
| API builds the input and streams it to the controller                                      | Redaction needs project secrets; the controller and container get no R2, DB or secret                                                                                    |
| `@cf/*` through `env.AI.run`, third-party through REST `/ai/v1/*` with `cf-aig-gateway-id` | No new token permission for the default model; REST only when a third-party host is used (probe check 5 names a missing permission)                                      |
| Scheduler DO in the API Worker, scanner in a separate controller Worker                    | Losing Containers never breaks API upgrades (spec §5.1)                                                                                                                  |
| One installation-wide controller Worker + container app per engine                         | Created at first move away from `disabled`, verified by the probe                                                                                                        |
| API reaches the controller through a gate script in the platform dispatch namespace        | A service binding from the API cannot point at a Worker created later; the gate (`void-security-scanner-gate-<hash>`) holds one binding `SCANNER` and no logic or secret |

## Package and file layout

```
packages/platform/src/
  security-models.ts            model list, engines, hosts, badges, prices, reserves  → @void/platform/security-models
  security-policy.ts            policy type, defaults, strict + lenient parser, ranges, plan caps, form parsers
  security-lockfile.ts          package-lock / pnpm-lock readers (third-party identity)
  security-local-check.ts       local check path filter, limits, small ustar writer
platform/packages/security-scanner/          @voidcloud/security-scanner (private)
  src/runner/{main,phases,extract,status,validate-findings,coerce,prompts,report,limits}.ts
  src/runner/engines/{void-loop,claude,codex,proxy-failure}.ts, src/runner/mcp/{server,void-scan}.ts
  src/runner/tools/fs.ts        read_file / list_files / grep, realpath under /scan, no symlinks
  src/runner/runtime/copy.ts    copy_request tool (Engine B)
  src/runner/self-test.ts       probe checks 2–3 inside the container
  image/{Dockerfile.claude,Dockerfile.codex,claude/,codex/,codex-wrapper.sh,NOTICE}
  test/fake-model/server.ts, test/unit/*, test/e2e/recorded-run.e2e.test.ts (VOID_SCANNER_E2E=1)
platform/packages/api/src/security/
  schema.ts                     drizzle tables, re-exported from src/schema.ts
  policy.ts, project-policy.ts, models.ts, errors.ts
  enqueue.ts, queue.ts, scheduler.ts, call-ledger.ts, fence.ts, control.ts
  input/{tier,t1,t1-github,t2,filters,third-party,redact,phrase-check,memory,backlog,tar,source-tar,build,prepare,local,project-data}.ts
  model-proxy.ts, budget.ts, plan-caps.ts, provider-keys.ts, gateway-cost.ts
  ingest.ts, findings.ts, project-findings.ts, project-view.ts, project-settings.ts, project-page.ts
  public-gate{,-judge,-copy,-flow}.ts, exposure.ts
  notifications.ts, notification-copy.ts, recipients.ts, alerts.ts, streaks.ts, digest.ts, webhook.ts
  operator.ts, sweeps.ts, scan-candidates.ts, fallback.ts, local-check.ts, github-check.ts
  runtime-copy{,-names,-plan,-sources,-sweep}.ts, scanner-images.{json,ts}
  page-token.ts, probe.ts, maintenance.ts
platform/packages/api/src/
  provisioning/security-scanner{,-images}.ts      controller Worker, gate, apps, image copy
  security-scanner-controller-runtime.ts          controller Worker source (DOs, outbound entrypoints)
  routes/project-security.ts, routes/security-page.ts, operator/security-routes.ts
  admin/security-data.ts, admin/routes/security.ts, admin/react/views/{Security,ProjectSecuritySection}*.tsx
platform/packages/dashboard/pages/projects/{index,[slug]/security}.{tsx,server.ts}
packages/void/src/cli/
  project-security{,-args,-check}.ts, deploy-security-{notice,packages}.ts, security-sarif.ts,
  operator-security{,-args}.ts, platform-security-audits.ts
platform/scripts/publish-security-scanner-images.ts   release: publish the Engine A / C images
```

Main edits outside these files: capability parsing and worker config in `packages/platform`;
the deploy pipeline (`deploy/*`, `deployment-execution.ts`, rollback in `routes/projects.ts`);
the Zero Trust write paths (`zero-trust/*`, `routes/project-zero-trust.ts`,
`operator/zero-trust-routes.ts`, admin Zero Trust views); `email.ts`; the admin shell
(`Layout`, `renderAdminPage`, fate renders); `api.ts` typed routes; the CLI managed deploy
paths, `list.ts`, the operator and installer arguments; `platform-ci.yml`.

## Data model

Migration `0065_security_audits.sql`, 11 tables in `security/schema.ts`:

| Table                                                | Holds                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `project_security_settings`                          | per project: model pick, notice version, own cap, admin ceiling (`cap_ceiling_cents`), `policy_override`, `next_finding_number` |
| `security_scans`                                     | one row per scan: trigger, status/reason/error class/cause, attempt, lease, model, engine, tier, coverage, input keys, counts   |
| `security_findings`                                  | F-number, fingerprint key, state, severity + `severity_override`, verdict + `verdict_source`, revision, resolve columns         |
| `security_finding_events`                            | finding history (actions, comments, `severity_from/to`)                                                                         |
| `security_project_events`                            | cap changes, `protection_on/off`                                                                                                |
| `security_public_requests`, `security_scan_bypasses` | gate requests (one open per project) and recorded bypasses                                                                      |
| `security_project_spend`, `security_platform_spend`  | month rows: spent, scans, holds                                                                                                 |
| `security_memory_rejected`                           | rejected records, kept so they are never fed back (PK `(project_id, fingerprint_key)`)                                          |
| `security_notifications`                             | outbox: kind, dedupe key, attempts, `next_attempt_at` (email and webhook twins)                                                 |

- Project FKs cascade; no FK to deployments; `actor_user_id` has no FK. The bypass → request
  FK is `NO ACTION`, so retention cannot delete a request a bypass points to.
- Partial uniques: one running scan per project, one open request per project. The urgent
  index uses `COALESCE(severity_override, severity)`.
- Money is in whole units: spend, holds and costs in nano-dollars (`*_nano_usd`, `bigint`),
  caps in cents (`*_cents`, 0–100,000,000). `month` is a `date` with a first-of-month check.
- Status, trigger, state and kind lists are `CHECK`s built from TS lists; the migration test
  checks them against `@void/platform` (`SECURITY_MODES`, engines, max cap).
- Settings keys (`platform_settings`): `securityAudits.policy` (with `revision`),
  `securityAudits.providerKeys` (encrypted, M33), `securityAudits.webhook` (M26),
  `plans:security-caps` (M27), `security.bypasses-seen.<userId>` (admin badge).
- R2 (platform bucket): `security-scans/{project}/{deployment}/` head snapshot
  (`modules/`, `modules.json`, `sources.json`, `assets.json`, `packages.json`,
  `never-sent.json`), `security-scans/{project}/backlog.json`, and per scan
  `…/scans/{scan}/` (`backlog.json`, `server-leads.json`, `scope.json`, `status.json`,
  `findings.json`, `local-result.{attempt}.json`; raw output swept after 30 days).

## Flows

### Capability and policy

- `securityAudits` capability: optional in every parser (missing = false). The manifest
  writes schema 7 when it is on, so an old CLI refuses instead of dropping it (R17). The DO
  binding and the `security-audits-v1` migration tag follow the runtime manifest, not the
  capability; `ai` binding only when on. A rollback to a runtime without the class is
  refused (roll forward, R2).
- Policy in `security/policy.ts`: the strict parser guards writes; `readSecurityPolicy` is
  lenient (unknown blocked ids dropped, a bad default becomes the first priced `@cf` model,
  limits clamped; bad data reads as Off and keeps its revision). Every writer takes the
  advisory lock `void:platform:security-policy` and checks `expectedRevision` (409).
- Turning on from `disabled` first checks the whole proposal, then provisions and runs the
  probe outside the transaction; a failing check stores the result and answers 409 with each
  check's copy. Off cancels `pending_input` and `queued` scans (`policy_off`) and turns the
  gate off.
- Probe checks 1–6 (`probe.ts`): capability, container (provisioning), egress and self-test,
  `@cf` call, per third-party host credits + image + engine self-test (check 5), gateway. A
  daily re-probe runs while the mode is on.

### Deploy → scan row (outbox)

- `enqueueSecurityScanInTx` runs in a savepoint inside `commitCutoverLive`,
  `promoteProtectedDeployment` (`trigger=recovery`) and compensation's post-routing recovery
  (own short tx, R8). A failed statement is logged and the deploy commits with no row (D45).
- Lock order: project row, then the policy lock in shared mode, so an Off write cancels the
  new row instead of missing it.
- Skips (spec §6.1): `preview-*`, owner suspended, project deleting → no row; protected
  under `public` → `skipped:protected`; project rule `never` → `skipped:project_policy`.
  Both skip rows keep a copy of inline modules so a later public request can still scan
  that deployment. An open public request → `trigger=gate`.
- Coalescing supersedes waiting (`pending_input`, `queued`) rows and keeps `first_queued_at`.
- After commit (`finishSecurityScanEnqueue`): inline modules go to the head snapshot
  (≤ 50 MB / 30 s, `modules.json` last), then a compare-and-set moves the row to `queued`
  and pokes the scheduler. A staged deploy input is held (`input_prefix`) until the scan
  copies it.

### Scheduler, queue and hourly jobs

- `SecurityScanScheduler` DO, one instance. A pass claims queued rows round-robin by owner,
  oldest first, under the installation concurrency and one running scan per project.
- The claim (project lock + shared policy lock) resolves the model (`models.ts`: project
  pick, else default; unknown/blocked/unpriced → default; third-party without check 5, the
  installation notice or the project notice → first priced `@cf` model), bumps `attempt`,
  sets the lease (2× wall clock + 5 min) and re-checks deleting, suspended, 24 h backlog,
  protected under `public`, and the project rule.
- Then reserve the worst case on both month rows (`skipped:budget` on refusal), then start
  through the gate. A failed start is retried once after 60 s, then `failed
  (infrastructure, start_failed)`.
- `@cf` token bucket (10/min/model) and per-session call counts live in DO storage
  (`call-ledger.ts`); a Workers AI 429 puts the bucket into debt.
- Cancel writes the rows first (that is the fence), then cancels at the controller.
  `teardownProject` cancels before the cascade.
- Hourly (`maintenance.ts`, hourly tier only, R18): re-poke stale `pending_input`, reaper
  (`timed_out`, reserve back), 24 h backlog skip, raw output sweep, scan and request
  retention, daily probe, gateway cost, fallback, streak and digest alerts, sweeps, public
  gate backstop, exposure catch-up, runtime copy sweep, local check sweep. Policy Off stops
  the jobs that start work; cleanup jobs still run.

### Controller and container

- Names: `void-security-scanner[-gate]-<12 hex of sha256(installation id)>`; engine apps
  `void-security-scanner-engine-{a,c}-<suffix>`. Ownership marker on every object.
- One DO per attempt (`scan:<id>:<attempt>`) or probe; a start is accepted once. The alarm
  checks the fence, sets the egress lock (model host intercept, then deny all HTTP and
  HTTPS), starts with `enableInternet: false, env: {}`, creates the `scanner` user and
  `/scan` (0700), then runs the runner as `scanner` with the input tar on stdin.
- Engine B uses the managed `cloudflare/debian-trixie` image with the runner streamed in;
  Engines A/C use digest-pinned images copied into the operator registry by the probe (R1).
- Every 10 s: fence, read `/scan/out/status.json` then `findings.json` (≤ 5 MiB) with
  `O_NOFOLLOW`, hand both to `result`, destroy. Wall clock: `SIGTERM`, 60 s grace,
  `timed_out (wall_clock)`; hard cap: `timed_out (hard_cap)`.
- The runner (dependency-free `runner.mjs`): safe tar extract (regular files only), hunt →
  verify (≤ 10) → one repair turn → `findings.json` then `status.json` renamed into place.
  Tools read only `/scan/input` and `/scan/memory`; `grep` is plain text.

### Input

- Tier at scan start: rescan, sweep, local → full (T3); no base → `first-scan`; base
  snapshot gone → `no-usable-base`; else T1 when possible, else T2.
- T2: changed Worker modules by sha256 plus their source maps' `sourcesContent`; modules
  with no map as built code; changed text assets (≤ 256 KB). T1 (hosted, `managedBuilds`):
  GitHub compare of base and head commits plus the T2 changes, from one scoped
  `contents: read` token; truncated, force-pushed or mismatched commits fall back to T2 with a
  note.
- Filters (§7.4), secret-like files dropped, third-party code by lockfile identity (else
  kept, ranked last, `third-party-unverified`), caps 400 files / 2 MB focus, 32 MB read set.
  What does not fit goes to the backlog (`partial`); a project file the runner cannot read
  (bad path, oversize, binary) holds a public request (`held_no_result`).
- Redaction replaces stored secret values (4 forms) in every file, memory included. The
  phrase check (plain whole-word match) turns reviewer text into server leads. Redaction
  hits become `secret_in_output` server findings (M31).
- Memory: index (64 KB, 200 records) plus history files; rejected records are never fed.
- An empty diff scan is stored `succeeded` with no model call (`no_changes`, #14).

### Model proxy and budget

- `SecurityScanControl.model()` → `model-proxy.ts`. One route per host:
  `/v1/chat/completions` (`@cf`, `env.AI.run`), `/v1/messages` (`anthropic/*`),
  `/v1/responses` (`openai/*`). The model must equal `scan.model_used`.
- Checks per call: fence and lease, policy on, host passed check 5, notices, session (40)
  and scan call caps, token caps, provider-run tools refused (`tool_not_allowed`).
- Money: the call's worst case is held on both month rows in one `UPDATE … WHERE spent +
  worst ≤ cap RETURNING`, always scan → project → platform row. After the answer the hold
  becomes tokens × list price; an unreadable or lost answer keeps the worst case (the meter
  errs high). Stops answer 429 (402 for credits) with `x-void-scan-stop`.
- Headers are built from nothing: `cf-aig-gateway-id`, signed `cf-aig-metadata
  {"securityScan":tag}`, payload logging off, cache skipped; `access_programs` for `openai/*`.
- Caps (§16.2): ceiling = project ceiling → plan cap (`plans:security-caps`) → policy
  default; effective = lower of the ceiling and the project's own cap. 80/100 % alerts are
  queued after a settle and on `skipped:budget`.
- BYOK (M33): a saved provider key sends that host's calls through the AI binding's gateway
  `run` on the provider-native route with `cf-aig-no-wholesale: true`. Keys are tested with a
  1-token call before saving and are metered like any call.

### Ingest and findings

- `result()` → `ingest.ts`. `status.json` goes through a small parser and `findings.json`
  through the runner's own validator (`schema_version: 1`). Outcome table: `succeeded`
  stores all; `incomplete` stores confirmed only; the rest store none (I10). The first
  `failed (infrastructure)` attempt is requeued.
- One transaction: lock the project row, then the scan row, re-check the fence, write
  findings and events, end the scan, release the reserve.
- Key = sha256(source, project, skill fingerprint, sink path or file). Severity only rises;
  a confirmed finding is never demoted; a human severity is sticky (I5). 50 + 50 new keys
  per scan (`findings-capped`). Reopen and stale-scan rules per spec §9.3.
- After commit: promote the scan's backlog (only on `succeeded`), store raw output, forget
  the call ledger, queue notifications, re-check the public request, queue a fallback, send
  the GitHub check, poke.

### Notifications

- Outbox rows are queued in the same transaction as the change (findings at ingest, human
  reopen of an urgent finding, caps, public request states, bypass, streaks, digest). The
  scheduler alarm sends them: dedupe key, 30-min findings cooldown, retries at 1 and 5 min,
  third failure `failed`. `EMAIL` unbound marks rows `skipped`.
- Recipients are worked out at send time (`recipients.ts`); one email per person.
- The findings email rebuilds the new ids from the scan's events. A raise to critical counts
  as new even when it was already high. **Decision:** kept; the event stores no old severity
  and a schema change is not worth it.
- Webhook (M26): its own settings key and secret; every outbox event gets a `webhook` twin
  row. Body has ids and counts only, signed `X-Void-Signature: t=…,v1=HMAC-SHA256`.

### Scan before public (gate)

- Turning `publicGate` on holds the Zero Trust lock (shared) and re-reads Zero Trust.
  While on, disable and public-only are refused (409 `security public gate on`, 503 when the
  policy cannot be read).
- Asking to go public goes through `checkpointProjectReconciliation` with `gate: ask`. The
  pure judge (`public-gate-judge.ts`) reads the live deployment's newest scan and the open
  findings: pass → flip; else hold (`waiting_scan`, `held_findings`, `held_no_result`,
  `needs_deploy`). The project route answers 202 with an old-CLI-safe `state:'reconciling'`.
- Re-checks: ingest, resolve/reopen/severity edit, after a cutover commit, rollback, bypass,
  and the hourly backstop (shares the cron's routing budget).
- Bypass (D50): under the project lock, only while no urgent finding is open and the
  request waits for a scan or has no result. Installation admins get an email.
- Lock order: project row, Zero Trust shared, policy shared.
- Exposure catch-up (`exposure.ts`) scans a project that went public while out of scope.

### Surfaces

- Project API (`routes/project-security.ts`): status, findings list/show, comments
  (`configure`), resolve/reopen/severity (`settings`, `expectedRevision`), scans history,
  model and budget PUTs, page link, rescan, local checks. Role filter: `full` for a user
  session with `deploy`; `counts` for readers and deploy tokens (only `GET …/security` is on
  the deploy-token allowlist). Capability off: model, budget, scans and rescan answer 501;
  reads, comments, resolve and the bypass stay open.
- Operator API (`operator/security-routes.ts`, logic in `security/operator.ts`): policy,
  status, probe, budget, lists (page/limit, R16), cancel, rescan, backfill, sweeps, fallback,
  digest, webhook, provider keys, per-project model/ceiling/policy/finding writes, bypass.
  Every write takes `dryRun`; previews of finding, model and ceiling writes run the real
  write and roll back. Audit targets hold ids and known values only.
- Admin panel (`admin/security-data.ts`, `admin/routes/security.ts`): Settings, Findings,
  Scans, Public requests, Project detail section, Zero Trust page; banner and unseen-bypass
  badge through `renderAdminPage`. Writes call the operator functions inside
  `executeAuditedMutation`; policy and budget post twice (preview, apply).
- Signed page (`/security/projects/:slug`): 15-min HMAC token (`page-token.ts`) → HttpOnly
  path cookie → 303. Access is re-checked on every load; platform Access is not relaxed.
  Forms (resolve, comment, model, budget, bypass) check Origin/Referer, then call the same
  operations. `Referrer-Policy: same-origin` (not `no-referrer`: that sends `Origin: null`
  on the page's own posts).
- Dashboard: `/projects` and `/projects/:slug/security` through `apiClient` (`hc` for paths,
  `ProjectSecurity*Body` types from `api.ts` for bodies).
- CLI: `void project security …` (status, list, show, resolve, reopen, comment, severity,
  model, budget, scans, scan, check, open, `--format sarif`), `void project zero-trust
  bypass`, the deploy notice (one GET, 5 s, prints nothing on any error), the `Security`
  line in `void project status`, `void platform security …`, and `--security-audits` on
  install, upgrade and repair. Uninstall deletes the scanner (R11).

### Phase 2 and 3 additions

- Rescan, backfill, sweeps (M25): rescan is a full `trigger=rescan` scan after a cost
  preview; backfill queues up to 50 in-scope projects whose live deployment has no succeeded
  scan; sweeps (`sweeps: {on, everyDays}`, off by default) queue `standard`-profile full scans
  hourly. Candidates need stored code.
- Fallback (M26): opt-in `fallbackToCf`, one `@cf` scan after a third-party scan ended
  `refused`, `timed_out` or `failed (bad_output)`; never `@cf` → third party, never a
  fallback of a fallback or of a local check.
- GitHub check (M28, hosted): `Void Security Audit` check run, always `neutral`, counts and
  the page link only; a PR comment only while something is urgent; Re-run queues a rescan
  only for a sender who could rescan.
- Runtime copy (M30, Engine B): a copy of the live bundle in a separate dispatch namespace
  with empty stores, the live D1 schema, fake secrets and stubbed services, reachable only as
  `copy.void.internal`. A guard module blocks `fetch` and `WebSocket` from Durable Objects
  (S13). `confirmed (runtime)` only when the named request reached the copy. No copy when a
  secret value is in the bundle or schema. Deleted after the result and by the hourly sweep.
- Client assets and SARIF (M31): opt-in `--client-assets` rescan reads client source maps
  under `_client/`; SARIF 2.1.0 is built in the CLI from the list routes.
- Local check (M32): the CLI uploads git-tracked files (filtered) to a presigned R2 URL;
  `trigger=local`, no deployment, full scan; `storeLocalOutcome` writes a short-lived result
  file and ends the row only (I12).
- Per-project policy (M34): `inherit | always | never`; `never` never skips a gate scan (D46).
- Severity edits (M35): `severity_override`, event `severity_edited`, revision check; the
  reopen rule uses the human value.

## Milestone index

| M      | What                                             | Main code                                                           |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------- |
| M1     | capability, scheduler DO class, config           | `packages/platform` manifest / worker config, `scheduler.ts`        |
| M2     | shared model list and policy types               | `security-models.ts`, `security-policy.ts`                          |
| M3     | schema and migration 0065                        | `security/schema.ts`                                                |
| M4     | policy store and operator policy routes          | `policy.ts`, `operator/security-routes.ts`                          |
| M5     | scanner runner (Engine B)                        | `security-scanner/src/runner`                                       |
| M6     | controller Worker, provisioning, probe           | `security-scanner-controller-runtime.ts`, `probe.ts`                |
| M7     | model proxy and budget                           | `model-proxy.ts`, `budget.ts`, `call-ledger.ts`                     |
| M8     | outbox enqueue and input hold                    | `enqueue.ts`                                                        |
| M9     | scheduler and hourly jobs                        | `scheduler.ts`, `queue.ts`, `maintenance.ts`, `models.ts`           |
| M10    | input builder (T2, T3, filters, memory)          | `security/input/*`                                                  |
| M11    | T1 source diff                                   | `input/{t1,t1-github,source-tar}.ts`                                |
| M12    | ingest and findings                              | `ingest.ts`, `findings.ts`, `fence.ts`                              |
| M13    | Engines A and C, images, drift test              | `engines/{claude,codex}.ts`, `image/`                               |
| M13b   | engine images in the operator account, dispatch  | `provisioning/security-scanner-images.ts`, `scanner-images.json`    |
| M14    | project API routes                               | `routes/project-security.ts`, `project-{view,findings,settings}.ts` |
| M15    | notifications                                    | `notifications.ts`, `recipients.ts`, `email.ts`                     |
| M16    | scan before public (gate)                        | `public-gate*.ts`, `exposure.ts`, Zero Trust paths                  |
| M17    | operator security routes                         | `operator/security-routes.ts`, `security/operator.ts`               |
| M18    | admin panel                                      | `admin/security-data.ts`, `admin/routes/security.ts`                |
| M19    | signed project page                              | `routes/security-page.ts`, `project-page.ts`                        |
| M20–23 | CLI project, zero-trust, deploy notice, operator | `packages/void/src/cli/*security*`                                  |
| M24    | Phase 1 docs                                     | `docs/`                                                             |
| M25    | rescan, backfill, sweeps                         | `sweeps.ts`, `scan-candidates.ts`                                   |
| M26    | fallback, streak emails, digest, webhooks        | `fallback.ts`, `alerts.ts`, `webhook.ts`                            |
| M27    | per-plan caps                                    | `plan-caps.ts`, plans routes                                        |
| M28    | GitHub check                                     | `github-check.ts`, `routes/webhooks.ts`                             |
| M29    | page forms and dashboard pages                   | `routes/security-page.ts`, `platform/packages/dashboard`            |
| M30    | runtime checks on a throwaway copy               | `runtime-copy*.ts`                                                  |
| M31    | secret findings, client assets, SARIF            | `input/redact.ts`, `security-sarif.ts`                              |
| M32    | local check                                      | `local-check.ts`, `input/local.ts`                                  |
| M33    | BYOK                                             | `provider-keys.ts`                                                  |
| M34    | per-project policy override                      | `project-policy.ts`                                                 |
| M35    | severity edits                                   | `project-findings.ts`                                               |
| M36    | final docs and full verification                 | `docs/`                                                             |

## Decisions and known gaps that still matter

- Admin bypass with the capability off: the route is outside the capability guard. Held
  requests are no longer re-checked while off, so the bypass is how an admin releases one.
- A rollback to a deployment with no past scan queues a gate scan when its code is kept,
  else `needs_deploy` (safer than spec §12.4).
- Rescan is always a full scan, also for a live deployment with no succeeded scan
  (spec §13.3 says diff).
- Gateway cost needs `CF_API_TOKEN` with Analytics read; a failed query leaves the rows
  unknown, and after 7 days they stay `NULL`.
- A crash between an email send and the row update sends it twice on retry. Accepted.
- Not built: admin finding detail and resolve forms (spec §13.1; use the CLI or operator API),
  deploy `--json` `security` field (R4), the release smoke script.
- Codex `bio policy`, `misalignment policy violation`, `invalid prompt` and `content_filter`
  end `failed (infrastructure)` and are retried (product call; none of them opens the gate).

## Live check status

| Check                                    | Status                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 egress, S1b image copy                | S1 results are not recorded here; its egress lock is in M6 and S2 / S3 / S11 check egress again. S1b ran with a small image only (R1); a full engine image copy is unmeasured |
| S2 / S3 lockdown (Engines A / C)         | PASS locally through the gateway; live quality BLOCKED (scratch account had no Unified Billing credits)                                                                       |
| S4 / S8 Engine B quality, cost, time     | PASS on the default `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (10/10, 0 false, 8/8 valid); glm-5.3 FAILS                                                                     |
| S5 static confirmations                  | PASS (20/20 planted bugs confirmed with a trace)                                                                                                                              |
| S6 engine parity                         | Not run (needs Engines A / C live)                                                                                                                                            |
| S7 inputs, S9 refusals, S11 red team     | PASS locally after fixes (S7 26/26, S9 24/24, S11 160/160); S9 live refusal rates not run                                                                                     |
| S10 gateway                              | PASS for no bodies and no cache on REST; binding path and meter vs gateway not run (0094 check A pending)                                                                     |
| S12 legal                                | Open for the user (checklist below)                                                                                                                                           |
| S13 runtime copy                         | PASS (guard added); the M30 copy code itself is not run live                                                                                                                  |
| BYOK (M33)                               | Not run live; needs a real provider key. The first live probe with a saved key is the check                                                                                   |
| Engine A / C images                      | Digests stay `null` until the images are published at release (ghcr, then copied by the probe); until then probe check 5 keeps `openai/*` and `anthropic/*` unpickable        |
| Release smoke (`security-smoke-test.ts`) | Not written; to do before release                                                                                                                                             |

## Phase 0 spike conclusions

The Phase 0 spikes were one-off scripts. They ran from 2026-11-18 to 2026-11-20 on
scratch accounts (never production) against five seeded apps with planted bugs
(React+D1, Vue+KV, Svelte+auth, Solid+R2, plain Void API). Once their results were
built into the code, the scripts, images and seeded apps were removed. This section
keeps only what they settled. "Live check status" above lists what is still open.

| Spike                  | Result                                     | What it settled                                                                                     |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| S1 egress, cold start  | not recorded                               | the egress lock is in M6; S2, S3 and S11 check egress again                                         |
| S1b image source       | works with a ~2 MB image only              | option A of R1 (copy a digest-pinned image into the operator registry); full-size copy time unknown |
| S2 Engine A lockdown   | PASS locally through a real gateway        | live quality, cost and time BLOCKED (no Unified Billing credits)                                    |
| S3 Engine C lockdown   | PASS locally through a real gateway        | same block; Codex retries set to 0                                                                  |
| S4 Engine B quality    | PASS on deepseek, FAIL on glm-5.3          | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` is the default model everywhere                          |
| S5 static confirmation | PASS (20/20 planted bugs, with a trace)    | "confirmed (static)" stays; not every result is a lead                                              |
| S6 engine parity       | not run                                    | needs Engines A / C live                                                                            |
| S7 scan input          | PASS (26/26)                               | source maps cover every first-party server file; M8 covers every go-live path                       |
| S8 cost and time       | PASS (median $0.18, p95 15.7 min, default) | caps 1.2M input / 120k output tokens                                                                |
| S9 refusals            | PASS after fixes (24/24)                   | refusal mapping rules below; live refusal rates not run                                             |
| S10 gateway            | PASS for no bodies, no cache               | cost by `securityScan` tag cannot be read back, so the spend meter is the only cost source          |
| S11 red team           | PASS after fixes (160/160)                 | no escape, no egress, no token; caps and server rules hold                                          |
| S12 legal              | open                                       | checklist below                                                                                     |
| S13 runtime copy       | PASS with a copy guard                     | a copy is ready in ~9 s and costs ~$0.00001; Durable Objects need the guard                         |

### Engines A and C (S2, S3)

- The engines cannot reach `gateway.ai.cloudflare.com`, `api.cloudflare.com` or
  `1.1.1.1`. The token is in no process env and in no file of the container.
- Model names route as planned (`claude-sonnet-5.5` → `anthropic/…`, `gpt-6.1-terra` →
  `openai/…`). `@cf` models do not work on `/ai/v1/*`, so there is no free stand-in for
  a quality run.
- Engine A on a 402 returns `subtype: "success"` with `is_error: true`, so it is mapped by
  `is_error` and the status, not by `subtype`. On a 401 it retries until the wall clock
  stops it, so the proxy never passes a 401 through.
- Engine C retries a 402 or 401 five times; `request_max_retries = 0` and
  `stream_max_retries = 0`, and the proxy answers repeats after a credits stop itself.

### Gateway (S10)

- With logs off and the cache skipped, no request or response body is stored and no
  call is cached (also with a caller cache header).
- Third-party calls are always logged (Unified Billing), with metadata only.
- Not run: the binding path, and meter vs gateway cost (needs credits).

### Engine B quality and cost (S4, S5, S8)

T2 input, 5 seeded and 3 clean apps, 8 scans per model, runner at the final code:

|                                    | glm-5.3                 | deepseek-v4.1-flash-1017 (default) |
| ---------------------------------- | ----------------------- | ---------------------------------- |
| Planted crit/high found (bar 7/10) | 4/10                    | 10/10                              |
| False confirmed crit/high (bar 2)  | 0                       | 0                                  |
| Valid runs (bar 95%)               | 4/8                     | 8/8                                |
| Calls per scan (bar 80)            | median 28, max 78       | median 54, max 72                  |
| Cost per scan at list price        | median $0.74, max $1.34 | median $0.18, max $0.29            |
| Wall time (bar p95 < 20 min)       | p95 19.2 min            | p95 15.7 min                       |

- One unreadable verify session keeps that candidate as a lead and ends the scan
  `incomplete`; Engine B repairs harmless output slips (`coerce.ts`) and gets one retry for
  a bad report.
- glm-5.3 still fails the hunt session in half of its scans. It stays in the list and
  can be picked.
- `sink_path` is sometimes an expression (`fetch(url)`), not a file path, so ingest and
  the UI do not treat it as one.

### Scan input (S7)

- Every map entry has `sourcesContent`, and 100% of first-party server files are
  readable. Modules with no map go in as built code.
- Workspace packages count as first-party. Registry code matches the installed package
  byte for byte. With no lockfile all registry code is sent (input about 2× larger).
- A snapshot is 67–106 R2 objects per deployment, plus 3 per scan.
- GitHub compare lists at most 300 files. At that limit the scan falls back to T2.
- Go-live paths: cutover, protected promotion and post-routing recovery all enqueue a
  scan. Rollback and operator repair are not scanned (no new code).

### Refusals (S9)

- Codex prints `cyber policy: <msg>` with no code; `classifyCodexRun` compares letters and
  digits only, so every spelling ends `refused`.
- The proxy passes the provider's `cyber_policy` 400 on and records a refusal. A 402 stays
  a credits stop.
- A refused turn with no report ends `refused`, and fallback to another model is off.
- A session that read no code cannot clear the scan (`bad_output (nothing_read)`). Only
  reads that returned non-blank code under `/scan/input` count.
- Remaining risk: a model that reads one file and then declines still looks clean.

### Red team (S11)

160 checks with a hostile fake model: tool paths, tar input, MCP, engines, output,
reviewer phrases, egress, caps and ingest. Known risks, recorded and accepted:

- The reviewer-text check misses split, spaced, homoglyph and zero-width forms.
- A hard link in `/scan/input` would be readable, but the tar input refuses links.
- After two refused reports the MCP server still takes a third (bounded by the 40-call
  session cap).
- With a lockfile, app code placed under a registry package path is dropped (a
  malicious owner is a non-goal).

### Runtime copy (S13)

- 17/17 route checks pass. Ready in about 9 s, deleted in 2–4 s, about $0.00001 per copy.
  The copy is not reachable from the internet.
- Durable Objects bypass the outbound Worker, so the copy guard replaces `fetch` and
  `WebSocket`. It is not a boundary against code written to escape it; the outbound Worker
  stays as the second layer.
- The planted SQL injection and IDOR returned another owner's rows on a copy. A real
  outbound call carried the fake key, never the real one.

The release smoke check still needs one scratch account with Workers Paid, Containers,
Workers AI or AI Gateway credits, Unified Billing, and a token with Containers,
Cloudchamber and AI Gateway / Workers AI permissions.

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

| Fake                                                                                                       | Where                                                          |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Fake model server (scripted SSE for Messages, Responses, chat; records requests)                           | `platform/packages/security-scanner/test/fake-model/server.ts` |
| Fake container (`ctx.container` with `start`, `exec`, `interceptOutboundHttp`, `interceptAllOutboundHttp`) | `platform/packages/api/test/__mocks__/container.ts`            |
| Fake scanner controller binding (canned `findings.json`, status, delays, late results)                     | `test/integration/helpers.ts` (`createFakeSecurityScanner`)    |
| Fake AI (`fetch` for `/ai/v1/*`, `env.AI.run`) and `mockCfApi` containers / scanner state                  | `test/integration/helpers.ts`                                  |

- Business rules are pure functions with unit tests (tier, filters, redaction, memory,
  fingerprint, reopen, budget math, gate judge). Integration tests cover transactions, locks
  and route contracts, on the shared PGlite template.
- The real SDKs are not workspace dependencies (about 800 MB of native binaries); they
  install only in `image/`. The Docker recorded run is opt-in (`VOID_SCANNER_E2E=1`, CI image
  job).
- No live Cloudflare call in `vp test run`.
- Native and Workers Free regression: `cloudflare-deploy.test.ts` (no `/security`, no
  `/containers/` request, no AI binding), `cf-version-runner.test.ts` (`body.containers`
  undefined), `worker-config.test.ts` (capability off adds only the DO binding and tag),
  `project-zero-trust-command.test.ts` (`project security` and `zero-trust bypass` on a
  `cloudflare` target throw before any network call).
- The PR keeps its new tests under 10k lines. Each invariant keeps one strong test.

## Risks and items for the user

Items that need a user call are marked **(user)**.

| #   | Item                                                                                                                            | Plan                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **(user)** Image source. A `durable_object` container app only runs `registry.cloudflare.com/<operator account>/…` images.      | Engine B uses the managed image plus the streamed runner. Engines A/C: the probe copies a digest-pinned public image from `ghcr.io/voidzero-dev/void-security-scanner-engine-{a,c}` (option A). Pins stay `null` until the user agrees. |
| R2  | One PR vs spec "DO migration one release before the feature". **Decided: single PR.**                                           | The class and its `security-audits-v1` tag ship with the feature, idle while off. A Worker rollback cannot cross that release; roll forward.                                                                                            |
| R3  | **(user)** All three phases in one PR.                                                                                          | Very large review; the user chose one PR.                                                                                                                                                                                               |
| R4  | Deploy `--json` does not exist, so spec "deploy result gains `security`" has nothing to attach to.                              | Not built.                                                                                                                                                                                                                              |
| R5  | **(user)** Skill upstream repo URL for "security-audit-skill @ c1c8a8c" is not in the spec or repo.                             | Prompts and report schema are Void's own until the skill is vendored.                                                                                                                                                                   |
| R6  | **(user)** Sonnet 5.5 price is missing; the meter needs a price for every model.                                                | Listed but not pickable (`price: null`) until a price is filled in.                                                                                                                                                                     |
| R7  | **(user)** Legal (S12).                                                                                                         | A/C models stay unpickable until S12 is OK; `@cf` + Engine B ship first.                                                                                                                                                                |
| R8  | Compensate `post_routing_recovery` writes `live` outside any transaction.                                                       | Enqueue there in its own short tx, logged on failure. Gap accepted.                                                                                                                                                                     |
| R9  | Codex SDK cannot pass the lockdown flags.                                                                                       | Wrapper script via `codexPathOverride`, version checked by the drift test.                                                                                                                                                              |
| R10 | REST `/ai/v1/*` needs an AI permission and `cf-aig-gateway-id`; binding calls may ignore the payload-off header (0094 check A). | `@cf` on the binding, third party on REST; probe check 5 names a missing permission; `credentials.md` has the row.                                                                                                                      |
| R11 | Uninstall keeps platform Workers unless `--purge-resources`; the PRD says uninstall removes the scanner.                        | Uninstall always deletes the scanner Worker, gate, apps and copied images, found by name and ownership marker. R2 data follows the bucket rule.                                                                                         |
| R12 | Input build runs in the API Worker; large T3 inputs may hit CPU limits.                                                         | Modules are read one at a time; S7/S8 stayed in limits.                                                                                                                                                                                 |
| R13 | Local check findings would break reopen and gate rules.                                                                         | Separate short-lived result (I12).                                                                                                                                                                                                      |
| R14 | Does BYOK spend count toward caps?                                                                                              | Yes, metered and counted.                                                                                                                                                                                                               |
| R15 | Per-plan caps in `PlanLimits` need the exact key set; the two-release rule cannot fit one PR.                                   | Separate settings key `plans:security-caps` (0094 precedent).                                                                                                                                                                           |
| R16 | Paging: spec asks for cursors; operator API uses page/limit.                                                                    | Operator routes keep page/limit; project routes use a cursor.                                                                                                                                                                           |
| R17 | Old CLI on `void platform upgrade` drops the flag.                                                                              | Manifest v7 when on (old CLIs refuse).                                                                                                                                                                                                  |
| R18 | Cron fast tier is missing on some self-hosted installs.                                                                         | All security jobs in the hourly tier.                                                                                                                                                                                                   |
| R19 | Admin shell has no banner or badge slot.                                                                                        | New shared page data through `renderAdminPage` and fate renders.                                                                                                                                                                        |
| R20 | Model ids and prices may change before release.                                                                                 | One list in `@void/platform/security-models`, updated per release.                                                                                                                                                                      |

Hard or impossible as written in the PRD (flagged, not silently changed): R1, R2, R4, R8,
R15, and the `/internal/security-scans/*` HTTP routes (replaced by RPC with the same
promise: not on the public hostname).
