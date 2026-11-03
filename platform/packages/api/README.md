# @voidcloud/api

Control-plane API and administrator UI for a Void platform.

It owns platform auth, projects, deployments, domains, secrets, provisioning, rollback, usage/account enforcement, and Deploy-on-GitHub (GitHub App connect, push-triggered builds, GitHub Actions OIDC). The worker uses Hono plus Drizzle over PostgreSQL via Hyperdrive.

## Architecture

- **Platform DB**: PostgreSQL via `HYPERDRIVE.connectionString`
- **Public API**: CLI and dashboard-facing JSON routes
- **Internal API**: resource resolution and revalidation used by other platform workers
- **Admin UI**: React pages under `/admin/*`, server-rendered for first load and backed by a private Fate endpoint
- **Lifecycle status**: `/admin/status` and its GET JSON endpoint project display fields from the installer-owned PostgreSQL checkpoint. Maintenance admits these routes and administrator sign-in through normal Access and admin authentication. Keep the exception narrow, retain existing Sandbox drain operator access, and keep the Fate POST endpoint and administrator writes gated.
- **Self-hosted owner setup**: dashboard OAuth and normal signup share the first-user transaction and configured GitHub identity check. Dashboard login can create the first owner without a CLI login; it never promotes existing users. Void Cloud keeps its existing admin-only login behavior.
- **Background work**:
  - `scheduled()` for periodic usage enforcement and rollover checks
  - `queue()` for usage-event ingestion
- **Deploy on GitHub**: GitHub App install/connect, webhook-driven builds, and GitHub Actions OIDC. Builds run in a Cloudflare Container (default; one of two plan-sized DO classes, `BuildManager` or `BuildManagerLarge`) or via GitHub Actions, queued and concurrency-gated by the `BuildScheduler` Durable Object

## Source Layout

```text
src/
  index.ts                    # Hono app, Drizzle setup, scheduled(), queue()
  worker/index.ts             # Deploy entry: default handler and Durable Object exports only
  env.ts                      # Worker env types
  schema.ts                   # Drizzle schema
  db.ts                       # Query layer
  types.ts                    # Shared types including DeployManifest
  assets.ts                   # Static asset upload/session helpers
  routing.ts                  # Routing KV updates
  cf-api.ts                   # Cloudflare API helpers
  cron-scheduler.ts           # Durable Object for project crons
  usage-counter.ts            # Durable Object for per-user usage counters
  sandbox-concurrency-counter.ts # Trusted sandbox leases and server-clock metering
  usage-queue.ts              # Queue consumer logic
  usage-auth.ts               # Platform-only signing envelope and ROUTING key bootstrap
  plans.ts                    # Installation plan catalog and effective policy resolution
  tiers.ts                    # Built-in compatibility defaults and billing-period helpers
  build-scheduler.ts          # Durable Object: global build queue + per-tier concurrency
  build-manager.ts            # Durable Objects (extend @cloudflare/containers Container): BuildManager (free standard-3 = 2/8/16) + BuildManagerLarge (paid standard-4)
  build-namespace.ts          # buildManagerNamespace: maps builds.instance_type -> the BuildManager/BuildManagerLarge DO class
  build-types.ts              # BuildConfig, BuildLogLine
  github/                     # GitHub App crypto: app-jwt, installation-token, webhook-verify, oidc-verify
  provisioning/               # Worker/resource provisioning + cleanup
  migrations/                 # Validation + remote D1 migration runner
  auth/
    deploy-token.ts           # Mint short-lived project-scoped deploy JWT (aud: "deploy")
  routes/
    auth.ts                   # OAuth login/callback (also backfills GitHub installation -> user)
    me.ts                     # Current user
    projects.ts               # Project CRUD, migrations, logs, PG DB ops
    deploy.ts                 # Deploy pipeline (accepts api- or deploy-scoped tokens)
    delete.ts                 # Project deletion
    github.ts                 # GitHub App install/connect + per-project connection routes
    webhooks.ts               # POST /webhooks/github (HMAC-verified push/installation/workflow_run)
    internal-github-webhook.ts # fixed optional ingress operation (proof + GitHub HMAC)
    auth-oidc.ts              # POST /auth/github-oidc (verify Actions OIDC, mint scoped token)
    revalidate.ts             # Dashboard/admin ISR revalidation
    internal-revalidate.ts    # Proxy -> API ISR revalidation
    internal-resolve-resource.ts
    internal-resolve-worker.ts
    secrets.ts
    domains.ts
    usage.ts
  admin/
    fate/                     # Admin-only Fate schema, data loaders, typed client, and SSR snapshots
    react/                    # React page components and Void page-router entry
    routes/                   # Admin page shells, audited form actions, and log polling
    middleware/auth.ts        # Admin cookie auth + same-origin guard on every write
container/
  Dockerfile                  # node:26.12.1-slim + pinned corepack + bun build image
  build-agent.mjs             # Downloads source tarball, installs deps, runs `npx void deploy`
drizzle/
  0000_*.sql
  ...
  0027_github_deploy.sql      # builds, github_connections, github_installations tables
  0028_check_runs.sql         # builds.check_run_id
```

## Main Route Groups

### Public API

- `GET /` — server-rendered welcome page with the platform name, CLI installation and connection instructions, and links to the administrator dashboard and Void quickstart.
- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `GET /me`
- `/projects/*`
  - CRUD
  - `GET /projects/choices` — list accessible projects for interactive selection without deployment or traffic summaries.
  - `GET /projects/resolve?slug=...` — look up one accessible project for deploy setup. Returns `{ "project": null }` when the slug does not exist or is not accessible.
  - deploys and rollbacks
  - migrations and logs
    - Managed D1 apply submits each migration's SQL and `_void_migrations` insert in one transactional query batch. Retries require a tracking row to establish success; an existing table or column alone is insufficient. Failures retain the confirmed committed prefix in project metadata. Reconcile older untracked schema changes explicitly before retrying.
  - secrets
    - Secret changes hold the project row lock through active-Worker propagation. A nonterminal deployment or rollback lease returns HTTP 409 before storage changes; retry after that operation completes. Propagation requests time out after 30 seconds so an unavailable upstream cannot hold the project fence indefinitely.
  - domains
  - usage
  - project-scoped CI deploy credentials (`GET|POST /projects/:id/tokens`,
    `POST /projects/:id/tokens/:credentialId/renew`, and
    `DELETE /projects/:id/tokens/:credentialId`)
  - project members and invitations
  - project Zero Trust status and owner/admin overrides
  - PostgreSQL and MySQL project database provisioning/update
  - `POST /projects/:id/prerender-token` — mint a five-minute, project-scoped token accepted only by the remote-binding proxy
  - `/projects/:id/github` — connect/inspect/update/disconnect the GitHub repo (POST/GET/PATCH/DELETE; readers may inspect, owners and project administrators may mutate)
  - `/projects/:id/email/*` — monthly usage, and the verified-recipient list the project may send to (`GET|POST|DELETE`). Adding a recipient triggers a verification email; the address only becomes sendable once the recipient consents. See [Email](#email).
- `GET /usage`

Project and account usage endpoints return HTTP 503 when upstream analytics are unavailable, so clients can distinguish missing data from zero usage.

Project authorization resolves the implicit owner from `projects.user_id` and
shared access from `project_members`. Readers can inspect, collaborators can
deploy and manage deploy prerequisites, project administrators additionally
manage domains, email, GitHub, and membership, and only the owner can delete.
The owner's plan, quota, and suspension state govern every role's work.

### Deploy on GitHub

- `GET /github/install-url` (auth) — start GitHub App installation
- `GET /github/installations` (auth) — installations accessible to the user
- `GET /github/callback` (public, HMAC-signed state) — App install callback
- `POST /webhooks/github` (public, HMAC-verified) — `push` queues a container build and pokes the scheduler; `installation`/`installation_repositories` sync access; `workflow_run` completes GitHub Actions builds
- `POST /auth/github-oidc` (public) — verify a GitHub Actions OIDC token, create the Actions build row, and mint a scoped `VOID_TOKEN` (`{ oidcToken, project }` -> `{ token, projectId, buildId }`)

The webhook and OIDC endpoints return `503` when the GitHub App secrets are unset,
so the worker runs without them. Do not add an Access `Everyone` or path bypass
policy to the API hostname. For an Access-protected source installation, deploy
the standalone `src/github-webhook-ingress.ts` Worker with
`wrangler.github-webhook-ingress.jsonc`. It validates the raw GitHub HMAC and
forwards only `POST /internal/github-webhook` over its `API` service binding with
a short-lived, body-bound proof. The API revalidates that proof and the GitHub
HMAC. See [Platform Development](../../../docs/guide/platform/development/runtime.md#optional-github-webhook-ingress-for-access-protected-apis).

### Service-to-service API

- `POST /internal/github-webhook` — optional ingress only; requires the dedicated
  time-bounded ingress HMAC and the original valid GitHub signature
- `POST /internal/revalidate/:projectId`
- `POST /internal/resolve-resource/:projectId`
- `POST /internal/resolve-worker/:projectId` — resolve the active deployment's versioned worker; static active deployments report that no worker exists
- `POST /internal/verify-prerender-build/:projectId` — live-check that a prerender JWT's user, build, and deploy credential are still active
- `POST /internal/verify-owner/:projectId` — legacy URL that live-checks the caller's project deploy capability

`resolve-resource`, `resolve-worker` and `verify-prerender-build` authenticate
the proxy with its own key (`x-void-proxy-internal`) and do not accept project
tokens. `revalidate` checks the project token forwarded by the proxy against
the project's accept floor (see the proxy README).

### Operator API

`/operator/v1` exposes administrative operations as JSON. `POST /session`
explicitly exchanges a full API session for an administrator into a one-hour,
origin-bound `operator` bearer token. The database stores revocable session IDs;
every request verifies expiry, current role, and administrator suspension.
`POST /session/logout` revokes the current session. Browser cookies and project
deploy tokens cannot authenticate this API, including in development bypass mode.

Routes under `src/operator/` share user/project/access and operational services
with `src/admin/routes/`. Operational POSTs accept `dryRun: true` for validation
and a concrete preview without side effects. CLI and browser mutations persist an
audit intent before execution and its outcome afterward. `/system/events`
paginates those records. Audit targets contain JSON-encoded, action-specific
identifiers and bounded change arguments; unrelated request fields and
credentials are excluded. JSON errors use `{ error, message, details? }`;
partial external failures report completed work instead of silently retrying.
Requests are bounded to 32 KiB, list pages to 100 rows, and responses disable
caching.

`GET /operator/v1/email/projects/:project/logs` provides administrator access to
retained receipt and recipient outcomes, with `page` and `limit` pagination.
Accept a current project ID or slug; deleted projects remain inspectable by ID
until ledger retention expires. Responses exclude message content and credentials.

`POST /operator/v1/projects/:id/owner` previews or applies an ownership transfer through the
same service used by the browser admin UI. The database transaction updates the
owner and ownership periods atomically; usage counters and routing converge
afterward, and retries repair an already-committed transfer without moving its
billing boundary.

Managed Sandbox disablement uses `void platform system sandbox-drain`. The
preview inventories bounded pages of deployment manifests and container
resources without writing. Apply closes the activation gate, cancels active
Sandbox deployments, and deletes only container applications corroborated by a
managed dispatch binding. A leased PostgreSQL checkpoint advances each page and
requires two passes, so incomplete and concurrent runs resume without accepting
stale completion. A probe-authenticated installer preflight trusts that database
checkpoint; platform activation must remain closed until it reports complete.
Operator retries terminalize an abandoned ordinary cancellation after its
10-minute grace period. Protected cutovers wait 90 minutes before ownership is
fenced and external state is compensated; retryable rollback leases are adopted
through their database owner token and reconciled to the committed deployment.

Integration tests cover operator authentication, tenant operations, operational
parity, dry runs, and capability guards in `test/integration/operator-*.test.ts`.

User deletion, demotion, and manual suspension preserve at least one active
administrator. Short PostgreSQL transactions serialize the check and access
revocation before external cleanup. Deleting an administrator first demotes the
account; failed cleanup retains that revocation and reports it as a partial
result. Project teardown checkpoints still commit independently. Automatic quota
suspensions retain administrator access and cannot overwrite manual suspension.
The CLI and browser UI return the same last-administrator rejection, with no
recovery or promotion bypass.

### Admin UI

- `/admin/users`
- `/admin/projects`
- `/admin/builds/:id` — build detail page (live log panel for container builds; GitHub link for `github_actions`)
- `/admin/builds/:id/logs?since=N` — build-log poll endpoint backing the live tail; container builds front the `BuildManager`/`BuildManagerLarge` DO's read-only `GET /logs?since=N` (routed by `instance_type` via `buildManagerNamespace`), `github_actions` builds return the external `logs_url`
- `/admin/deployments`
- `/admin/email/:projectId` — per-project email usage, caps, inbound/outbound suspension, and destination list
- `/admin/signup-control`
- `/admin/config/plans` — installation plan catalog, reviewed edits and management actions, and resumable account updates

## Auth Flow

`GET /auth/login?redirect=...&provider=<connection-id>` starts an enabled
login method. Configurable installations read GitHub, Google, OIDC, or
Cloudflare Access connections from the database; older installations retain
their deployment-time GitHub/Google configuration. After callback, the API
validates the signed state and provider identity, then signs in the linked
account or applies the installation's signup policy to a new account. In a
configurable installation, a matching email address does not automatically
link another login method; users link it explicitly with `void account link` or
the optional dashboard's **Account** page.

A successful login signs a JWT and redirects back:

- dashboard redirects receive a short-lived `?code=...` for `POST /auth/exchange`
- new CLI redirects with `code_challenge_method=S256` receive a short-lived `?code=...` for `POST /auth/cli/token`
- legacy localhost CLI redirects still receive `?token=...`

The CLI entrypoint is `void auth login`, not `void login`.

Dashboard auth uses the same JWT model, stored in the `void_token` cookie.

## Deploy Flow

`POST /projects/:id/deploy` handles both worker and static deploys. Before either branch runs, the deploy endpoint validates the manifest wire-shape — including `redirectRules` / `fallbackRules` structure and destination constraints (path-absolute, no embedded query on `status: 200` entries) — so malformed routing rules are rejected before any resources are provisioned. See [`src/routes/deploy.ts`](./src/routes/deploy.ts).

Queued deployment input uses the existing R2 staging marker
`deployment-inputs/<projectId>/<attemptId>/receipt-void-platform-<kind>`, where
`kind` is `spa` for SPA manifests, `worker` for apps with Worker modules, or
`static` for other apps without Worker modules. The marker
identifies prepared deployment attempts, including cached redeploys and attempts
that fail after staging; it does not attest admission or live publication.
Queue redelivery reuses the input without writing another marker. HTTP retries
can stage new input, and R2 retries can repeat a write for the same key.
Synchronous runtimes without `DEPLOYMENTS_QUEUE` do not stage these markers.
The object remains under its original input prefix, so cleanup also handles
older `receipt` markers. No additional R2 write or analytics binding is needed.

### Worker deploys

1. validate the actor's deploy capability and the owner's deploy limits
2. provision bindings and queues from the manifest
3. upload worker modules and assets to CF via `assets-upload-session`
4. also mirror assets to platform `STATIC_ASSETS`/`STATIC_ASSETS_R2` and write a serving manifest to `ROUTING` (safety net for CF asset dedupe poisoning — see `meta/design-docs/0066`)
5. upload a versioned worker: `user-{slug}-{deploymentId}`
6. call `POST /__void/migrate` on that new worker
7. update routing KV (with `assetManifestId`) and active domains only after migrations succeed
8. mark the deployment live and run retention cleanup (evicts mirrored assets + serving manifests for deployments dropped from the retention window)

### Static/SPA deploys

1. content-address assets by hash
2. issue presigned uploads that store every new asset directly in `STATIC_ASSETS_R2` (`STATIC_ASSETS` KV is retained for carry-forward assets from legacy multipart deploys)
3. write a manifest to `ROUTING`
4. point routing at `staticDeploymentId` instead of a worker

## Deploy on GitHub

Connect a repo through a GitHub App; a `git push` then builds and deploys automatically.

- **Connect**: an owner or project administrator installs or joins the App (`/github/install-url` -> `/github/callback`) and links a repo they can access via `/projects/:id/github`. The connection records that authorizing user and is invalidated if they lose that level of project access. Installation-to-user mapping lives in `github_installations`; the OAuth callback backfills it on sign-in.
- **Trigger**: `POST /webhooks/github` verifies the HMAC signature, then on `push` writes a `builds` row and pokes the `BuildScheduler`.
- **Executors** (per `github_connections.build_executor`, default `container`):
  - **CF Container** — `BuildScheduler` (global, alarm-driven queue with per-plan concurrency from the installation catalog) atomically claims a build and starts its configured instance size: `BuildManager` (`standard-3` = 2 vCPU / 8 GiB / 16 GB) or `BuildManagerLarge` (`standard-4` = 4 vCPU / 12 GiB / 20 GB). The class is routed by the persisted `builds.instance_type` (`standard-3` / `standard-4`, captured from the effective plan at admission) via `buildManagerNamespace` in `build-namespace.ts`; cancel and reaper paths use the same picker, so they address the same class the build started on. `BuildManagerLarge` extends `BuildManager`, which extends `@cloudflare/containers` `Container`, enforces a timeout alarm, and persists status to Postgres via Hyperdrive.
  - **GitHub Actions** — `void init --github` scaffolds a workflow that calls `POST /auth/github-oidc`; the verified job runs `void deploy` and reports back via the `workflow_run` webhook.
- **Build mechanism**: both executors run the real `void deploy` CLI with a short-lived, project-scoped deploy token (`aud: "deploy"`, minted by `auth/deploy-token.ts`). There is no artifact-upload endpoint; `routes/deploy.ts` is unchanged. The container agent (`container/build-agent.mjs`) downloads the source tarball, installs deps, and runs `npx void deploy --project <slug>` with `VOID_TOKEN` + `VOID_API_URL`.
- **Check Run**: container builds publish a "Void Build" GitHub Check Run (head SHA = the build's `commit_sha`/webhook `after`), created `in_progress` at build start and finalized `success`/`failure`/`cancelled` at every terminal site. Best-effort — a Check Run API error never fails or perturbs a build/deploy. `details_url` is the application URL derived from the configured `SITE_DOMAIN` for the in-progress/success/failure states (omitted on cancel). The helper (`github/check-run.ts`) is executor-agnostic; Actions check-runs are deferred (the native workflow check already covers them) and the helper is ready for a future PR. Configure Checks write permission and the relevant webhook subscriptions when enabling this integration. `builds.check_run_id` has no index (nothing queries by it — deferred).
- **Build logs**: `BuildManager` pulls container stdout/stderr into the DO with a `pollLogs()` loop — a non-starting `getTcpPort().fetch()` against the agent's paged `GET /logs?since=N` (deliberately NOT `containerFetch`, which would auto-resurrect an exited container) on a ~1s cadence, advancing its cursor only after SQLite ingestion and feeding the SQLite `logs` table + WebSocket fan-out. On natural exit, the agent keeps its control server alive with an 8s idle deadline that resets only when the acknowledged cursor advances and a 120s non-resettable absolute cap. After a moving final page, the same pull callback sends one empty follow-up request so `since=<last ingested seq>` acknowledges durable ingestion without waiting another tick. Forced teardown instead single-flights the whole join, fresh bounded pull, liveness recheck, and signal sequence so concurrent callers cannot ingest after the termination marker. The DO also serves a read-only `GET /logs?since=N` -> `{ lines, lastSeq }`. The admin build views (below) consume this; `github_actions` builds have no DO log store and link out to their GitHub Actions run.

## Email

Projects send and receive mail through `void/email`. The API authorizes routing, consent, suspension, and quota reservations in PostgreSQL. The proxy submits outbound mail, and the dedicated email gateway authenticates inbound zone traffic and dispatches it to the active project worker.

### Sender identity is per-environment

The platform mail domain is a configured var, `EMAIL_SENDER_DOMAIN` — never a literal in code. Production and staging run different domains (`mail.void.cloud` / `mail.voidcloud.dev`), and the proxy builds its sender regex from the same var, so a hard-coded domain would make a staging send unroutable.

A project's sender address is `<slug>+noreply@<EMAIL_SENDER_DOMAIN>`. Deployed user workers receive the two halves as plain-text bindings:

- `__VOID_EMAIL_DOMAIN` — the value of `EMAIL_SENDER_DOMAIN`
- `__VOID_PROJECT_SLUG` — the project slug, injected for **every** project (it predates this feature but used to be sandbox-only)

The runtime defaults `from` from those two bindings and refuses to send when either is missing, rather than falling back to a baked-in domain.

### Who a project may send to

`email_destinations` records consent per project and recipient. Admission reads verified destinations, current ownership, and installation policy from PostgreSQL. The default shared-sender policy requires verified destinations; operators may allow exact external domains or all external recipients. Destinations on the platform’s shared mail domain always require project consent. Custom senders may send externally when their domain and credential are ready, subject to transport capability, suspension, and quotas.

KV contains routing and policy hints; it cannot authorize a send. Cloudflare destination addresses are account-level, so upstream cleanup occurs only after the last project reference is removed.

### Quotas and outcomes

`emailProjectControls` holds suspension and per-project limits. Admission atomically records a deduplicated action, reserves quota in `emailMonthlyUsage`, and creates per-recipient states in `emailActionRecipients`. The defaults are 200 recipient attempts per UTC month and 10 per minute. Direct sends and inbound actions use the same ledger.

Only reservations that never started can be cancelled and refunded. Started or uncertain submissions retain their quota and are never automatically replayed. Suspension blocks new attempts; already-started submissions may finish. `emailReceipts` records inbound processing, and unresolved attempt records preserve the removal fence after detailed logs expire.

### Operator page

`/admin/email/:projectId` displays current-month recipient attempts and inbound receipts, effective limits, sender identity, verified destinations, and custom-domain readiness. Operators can suspend email, change monthly or burst limits, revoke destination consent, and manage domain operations. A blank limit restores the default.

Destinations are added through the owner/project-administrator `POST /projects/:id/email/destinations` consent flow. Operators cannot consent on a recipient’s behalf. Incomplete provider operations retain their operation ID and outcome for reconciliation or audited recovery; the page must not report them as completed.

Shared inbound recipient creation has the same explicit recovery boundary:
operators discover intents with `void platform email shared-recipients`, inspect
the exact provider resource, and use `shared-recipient-resolve --plan` before
applying an attested outcome. Recovery waits at least 24 hours, requires the
original execution to have ended, and pins the inspected identity and attempt.
Not-applied recovery requires provider-audit evidence as well as repeated
absence readback. Applied recovery records only the exact owned rule ID.
Recovery performs no provider writes and keeps deleting projects closed; normal
reconciliation or cleanup verifies the remaining work. Operator intents and
outcomes use the existing `operator_events` audit.

Allocate shared inbound rules only for the validated incoming manifest or an
active live deployment declaring `emailProtocolVersion: 1`. Project creation
and send-only apps must not allocate them. Scheduled repair filters eligible
deployments before its batch limit. Preserve existing ownership records for
rollback and deletion cleanup when a later deployment removes its handlers.

Every admin write is additionally same-origin checked in `admin/middleware/auth.ts` before authentication runs; a `POST` whose `Origin` (or, failing that, `Referer`) does not match the request host is rejected with `403`, as is one that carries neither.

## Usage and Plan Enforcement

- **Deploy/day limits** are checked from the platform Postgres database.
- **Request usage** is counted asynchronously through `USAGE_QUEUE` and the `UsageCounter` DO.
- **Usage provenance** is authenticated before accounting. The API health check
  creates a purpose-separated signing key in the private routing KV; dispatch
  and the API-owned sandbox lease counter sign every accepted queue envelope.
  The consumer resolves project ownership and the canonical slug from Postgres,
  validates finite nonnegative quantities, and acknowledges unsigned or invalid
  frames without applying them.
- **Sandbox runtime** comes from the API-owned lease clock at acquire, heartbeat,
  release, and stale-lease cleanup. Each lease generation publishes cumulative
  intervals, so reordered messages and retries count elapsed time once. Separate
  durable receipts are committed atomically with account totals and survive billing
  rollover. Signed intervals and receipts expire after eight days; expired usage
  cannot be replayed after its receipt has been pruned.
  Tenant Workers do not receive the usage queue producer or account identity
  bindings. Workers deployed by older platform versions may still have the
  dormant producer binding; their unsigned SDK frames are ignored. Redeploying
  removes those legacy bindings but is not required for trusted gate metering.
- **Scheduled enforcement** runs hourly from the worker cron and reconciles request/AI usage against plan limits.
- **Per-request runtime limits** are carried in routing data and enforced by `dispatch`.

Build cancellation invalidates pending startup immediately. If container startup
has already begun, the manager stops any late producer before publishing final
log completion. Startup claims and recovery reads are bounded; terminal recovery
still releases container capacity when Postgres is unavailable.

## Admin UI

The admin surface is built into this worker under `/admin/*`.
For installed platforms, System Status probes the proxy through the private
`PLATFORM_PROXY` service binding while the installer separately verifies its public
URL. The binding is attached only during enabled cutover, after the proxy exists,
so API/proxy bootstrap does not introduce a circular provisioning dependency.
Older deployments without the binding retain the HTTP probe fallback.

Project Zero Trust verifies and reuses an existing exact dispatch `/health`
Access exception without taking ownership. Its saved application name differs
from the committed project-owned creation name; reconciliation never updates
that external application, and disabling project protection never deletes it.

The installer calls `/internal/platform/app-access` with its private probe proof
and a purpose-bound HMAC over the installation ID and request body, using a separate
setup secret that is never published as a Worker variable,
while app traffic is gated. A database receipt records the initial choice before
provider writes and marks it complete only after live Access verification. Completed
receipts make upgrade/retry calls preserve administrator changes. Public-only rules
use scoped bypass applications in Default-Deny accounts; their custom-domain rules
are managed with the same project reconciliation and ownership checks.

Uninstall calls `/internal/platform/app-access/turn-off` with the same probe proof
and setup secret under its own HMAC purpose. It runs the normal Zero Trust disable
only while no platform user exists, so an installation whose first administrator
never signed in can still be removed. First administrator setup does not wait
for it, so the route reports a user who appeared during the disable, and the CLI
then stops the uninstall. The CLI calls it before it takes the Zero Trust lock,
because the disable claims the same lock.

The browser uses `POST /admin/fate` for administrator page data. It runs under the
existing admin-cookie and same-origin middleware, while the CLI/operator API
stays on `/operator/v1`. First loads hydrate a request-scoped Fate snapshot into
the React adapter. Page-object navigations send a small shell and read from the
session-scoped Fate cache, refreshing cached pages in the background. Recently
visited page shells are also reused immediately and revalidated in the
background. The dashboard defers the Analytics Engine top-projects view so it
does not delay the initial page. Existing audited form actions remain HTML POST
endpoints and reload the page after writes, which also creates a fresh cache
instance.

The Fate schema and loaders live in `src/admin/fate/`. The generated client is
`src/admin/fate/client.generated.ts`; rebuild it through
`scripts/build-admin-client.mjs` when changing Fate roots or types. Keep page
loaders restricted to their matching `/admin/*` paths, and never add admin
queries to the CLI API.

Notable sections:

- user search, plan changes, suspension controls
- project and deployment inspection
- deployment log viewing
- per-project Builds section (ongoing build highlighted) plus a build detail page with a client-side polling live-log tail for container builds (mirrors the deployment live-tail; not a WebSocket), or a GitHub Actions link for `github_actions` builds. The tail polls `GET /admin/builds/:id/logs?since=N`, which fronts the `BuildManager`/`BuildManagerLarge` DO's read-only `GET /logs?since=N` (DO chosen by `instance_type` via `buildManagerNamespace`).
- per-project email page (linked from the project detail view): usage, caps, inbound/outbound suspension, destinations
- signup restrictions and allowlists
- project Zero Trust page (saved state; the "Check with Cloudflare" link adds `?check=1` for a live Access check) with configure, reconcile, and disable, plus a Zero Trust section on the project detail page (saved state only) with protect, make public, and reconcile
- CLI version deployment history

Admin writes are same-origin guarded: `admin/middleware/auth.ts` rejects any non-`GET` request whose `Origin`/`Referer` host does not match the request host, before the cookie is even read.

## Local Setup and Secrets

From the repository root, with PostgreSQL and its client tools available:

```sh
vp run build:core
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

Open `http://localhost:8787/admin/`. Setup creates the local database, applies
migrations, and seeds the administrator. It writes development-only configuration
to the ignored API `.dev.vars` and dashboard `.env` files. See
[Platform Development](../../../docs/guide/platform-development.md) for local
frontend setup and installing a runtime built from a fork.

Use the platform installer for deployed configuration. The values below depend
on the capabilities and bindings enabled in that installation.

Secrets used at runtime:

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `CF_ZONE_ID`
- `JWT_SECRET`
- `EMAIL_SIGNING_SECRET` (email-enabled installations)
- `PROJECT_SECRET_KEYS_JSON`
- `PROJECT_SECRET_ACTIVE_KEY_VERSION`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

`PROJECT_SECRET_KEYS_JSON` is a JSON object mapping key-version strings to base64-encoded 32-byte AES keys. `PROJECT_SECRET_ACTIVE_KEY_VERSION` selects which version is used for new project-secret writes.

`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are the OAuth app used for **user sign-in**. They are distinct from the Deploy-on-GitHub App secrets below.

Optional vars:

- `AUTH_REDIRECT_URI`
- `DASHBOARD_URL` — optional frontend origin for project links
- `PLATFORM_DISPLAY_NAME` — name shown on onboarding pages and emails
- `EMAIL_FROM` — optional sender override for the `EMAIL` binding. Without it, an installation sends from `noreply@<EMAIL_SENDER_DOMAIN>` with `PLATFORM_DISPLAY_NAME` as the name
- `VOID_PROXY_SERVICE`
- `SITE_DOMAIN`
- `EMAIL_SENDER_DOMAIN` — platform mail domain for this environment (`mail.void.cloud` in production). Set on the proxy worker too, and handed to deployed user workers as `__VOID_EMAIL_DOMAIN`. See [Email](#email).
- `GITHUB_APP_ID` — Deploy-on-GitHub App identifier
- `GITHUB_APP_PRIVATE_KEY` — PKCS#8 PEM (convert GitHub's PKCS#1 with `openssl pkcs8 -topk8 -nocrypt`)
- `GITHUB_APP_SLUG` — App slug, used to build the install URL
- `GITHUB_WEBHOOK_SECRET` — HMAC secret for `POST /webhooks/github`
- `GITHUB_WEBHOOK_INGRESS_SECRET` — separate HMAC secret shared only by the API
  and optional standalone webhook ingress; required on both Workers when used

The GitHub App secrets are optional: when unset, `/webhooks/github` and `/auth/github-oidc` return `503` and the rest of the worker runs normally. They are the App for Deploy-on-GitHub, separate from the sign-in OAuth app above. The ingress secret is also optional and does not enable any route unless the standalone Worker and service binding are configured.

The core installer includes the email gateway and enables platform email when
both `VOID_EMAIL_SENDER_DOMAIN` and `VOID_EMAIL_SHARED_ZONE_ID` are configured.
It sets `AUTH_REDIRECT_URI` to the platform's OAuth callback URL, and it sets
`PLATFORM_DISPLAY_NAME` and `EMAIL_SENDER_DOMAIN`. Platform mail uses the origin
of `AUTH_REDIRECT_URI` for links and comes from
`noreply@<EMAIL_SENDER_DOMAIN>`; an installed platform does not default to Void
Cloud senders or dashboard links. Do not set these values or `EMAIL_FROM` on
installed Workers in the Cloudflare dashboard. The next lifecycle command stops
until the operator lets Void replace that change; see
[Platform Workers changed outside Void](../../../docs/guide/platform/installation/maintenance.md#workers-changed-outside-void).

Administrators manage access with `void platform signup` and `void platform invitation`. Signup eligibility comes from the installation's own allowlist and bootstrap administrator configuration.

## Tests

Unit coverage includes provisioning, JWT/auth helpers, deploy manifest validation, usage counters, cron scheduling, legacy D1 migration helpers, and Deploy-on-GitHub crypto (App JWT, installation token, webhook HMAC verification, OIDC verification) plus the scoped deploy-token minting.

Integration coverage includes:

- auth and `/me`
- project CRUD
- deploy/rollback/revalidation
- custom domains and secrets
- admin dashboard
- scheduled usage enforcement
- GitHub App connect/webhook/OIDC routes and the `BuildScheduler` queue/concurrency behavior

## Managed custom Durable Objects

Manifest version 4 declares local SQLite-backed classes. Clients supply class and binding names; namespace IDs are server-owned. The API records a project resource before provisioning its stable dispatch Worker, then verifies the project marker and pinned namespace before changing or deleting it. Tenant code stays inside the installation's dispatch namespace; each stable Worker's default fetch returns 404.

Cutover, rollback, and recovery reconcile class code under the project lock. Removed classes become inactive and retain storage; only project deletion force-deletes their owned Workers. Deployment retention removes release bundles without removing these project resources. A project can create at most 32 distinct custom classes.

Release modules and encrypted binding metadata are stored under the deployment's private `worker-bundles/` R2 prefix. Snapshot ciphertext is bound to the project and deployment; module hashes are checked before replay. Keep encryption key versions available for every retained snapshot. Publication reads the retained application Worker's current proxy token, and token rotation patches active class Workers before revoking the old generation. Rollback changes code, never stored data.

## Connected apps

Registered confidential OAuth clients use code + S256 PKCE with identity-only grants. Each publish requires Void consent for an exact artifact and project, then uses an audience-separated, revocable credential and a durable deployment receipt. Admin registration/disablement lives at `/admin/connected-apps`; user disconnection lives at `/oauth/connections`. See [the design record](../../meta/design-docs/0091-connected-apps.md) and [operator guide](../../../docs/guide/platform/administration/connected-apps.md).
