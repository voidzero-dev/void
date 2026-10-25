# Testing Void

## Local verification

Start with the smallest relevant test file or case while developing:

```sh
vp test run packages/void/test/unit/plugin-routing.test.ts
vp test run packages/void/test/unit/plugin-routing.test.ts -t 'routing'
vp run check
```

Type-only contracts use `*.typecheck.ts`. Package typechecking verifies them; the Vitest runtime
does not need to execute their `expectTypeOf` assertions.

### Affected local tests

`vp run test` is the local affected-tests default; `vp test run`, `vp run test:full`, and CI still
run the full suite. The selector's result caching is disabled: Git state must be inspected on every run.
Do not pass `vp run --cache` to this task.

```sh
vp run test --list                 # Preview files and fallback reasons; no builds or test hooks
vp run test                       # Staged, unstaged, and untracked changes against HEAD
vp run test --base origin/main     # Branch commits since merge-base, plus local changes
vp run test --unit                 # Faster iteration only; explicitly skips integration projects
```

Pass shortcut arguments directly after the task name, without an extra `--`. A clean working tree
selects nothing unless `--base` includes earlier commits. Invalid Git refs or selection failures
fail the command rather than silently skipping coverage.

The runner uses Vitest's static import graph, including transitive and literal dynamic imports.
It supplies changed paths through [Vitest's `experimental.vcsProvider` hook](https://vitest.dev/config/experimental#experimental-vcsprovider).
Independent Git queries run asynchronously in parallel, and filtering reuses one snapshot per invocation.
Neither test results nor Git state are cached between commands. Built public exports join that snapshot
before import-based selection. The hook is specific to the smart runner: native `vp test run --changed`
still lacks the repository's integration fallbacks.

The runner adds coverage that imports cannot describe:

- SDK source changes rebuild public packages, select all SDK build/server/browser integrations,
  and include built public exports in the related graph so platform and adapter consumers are covered.
- Platform source, migration, and fixture changes select the owning package's tests, including
  both API integration worker pools. Ordinary changed test files use the native related graph.
- Playground changes select suites mentioning that fixture path. An unmapped playground selects
  all SDK integrations; shared test tooling, configuration, dependencies, deletions/renames,
  and unknown ownership fall back to the full selection.
- Documentation-only changes skip runtime tests. Verify documentation rendering/examples separately.

`--list` does not refresh builds, so built-export coverage can expand when the command executes.
Affected selection is conservative, not a proof that all behavior is covered: computed imports,
filesystem reads, generated artifacts, and external services can introduce additional dependencies.
Explicitly run a known consumer when changing one of those boundaries. Changes to packaging still
need the packed checks below; changes to metaframework output still need `build:all` and the
artifact check.

For a leaf-module edit with known import-based consumers, Vitest's native related command is useful:

```sh
vp test related --run packages/void/src/runtime/sse.ts --project unit --project unit-pglite --project cli-unit
vp test list packages/void/test/unit/plugin-routing.test.ts --filesOnly
```

Agents should run a focused regression first, then affected verification and `vp run check` after a
batch. Use unit-only runs during iteration, but run the affected integration selection before
handoff. Run the full suite once for final verification, not after every edit. For interactive
development, `vp test watch <test-file>` keeps the transform graph in memory between edits.

The named shortcuts select the current test projects:

```sh
vp run test:unit
vp run test:integration
vp run test:metaframeworks
vp run test:pages:react-vue
vp run test:pages:svelte-solid
vp run test:platform
```

Run the complete SDK and platform verification before handing off a finished change:

```sh
vpr test:all
```

`vpr test:all` formats, lints, builds, typechecks, and tests the merged monorepo. Investigate slow
or hanging tests when they occur instead of routinely increasing timeouts.

Subprocess and provisioning-lock unit tests start alongside the platform projects so their real
process deadlines can overlap database work. The remaining SDK unit and integration files then
share a scheduling phase. `vp run test:unit` includes `unit`, `unit-pglite`, and `cli-unit`; CI does the same.
Unit files and most API integration files use isolated worker threads to reduce startup time. On Linux and macOS,
API integration files and the PGlite unit files (`unit-pglite`, `platform-unit-pglite`) use forks to isolate PGlite's
WebAssembly JIT allocations after native Node 24 crashes in shared worker processes. API tests
that change the process timezone also use forks, because threads cannot change Node's timezone. Select every
API file with `vp test run --project 'platform-api-integration*'`. SDK integration files use forks.
This keeps database engines from competing with all framework compilers at startup. Keep module
isolation enabled: these suites mock globals, keep database state, and exercise real process/lock boundaries.
The full verification command builds before running the platform's type-aware lint, so it also
works without a pre-existing dashboard `.void/tsconfig.json`.

## Reusing transforms

Persistent `fsModuleCache` is enabled to reuse transformations across invocations. It does not
cache test results or remove per-file module isolation. The first run primes it; compare repeated
runs with the same selection and machine load. For a control use `--no-fsModuleCache`; use
`vp test --clearCache` only when diagnosing cache problems, not before ordinary tests.

## Profiling slow tests

Vitest 5's import diagnostics are opt-in so ordinary runs stay quiet:

```sh
vp run test:profile packages/void/test/unit/plugin-routing.test.ts
vp run test:profile --project 'platform-api-integration*' api-delete-accounting.test.ts
vp test doctor packages/void/test/unit/plugin-routing.test.ts
```

The profile shortcut enables `experimental.importDurations.print` and reports the top 20 imports
with the default reporter. Use `--experimental.importDurations.print=verbose` or `=tree` when more
detail is useful. `Self` is work attributed to the module; `Total` includes imported dependencies,
so do not add totals together. Prefer narrow entry points and production lazy loading when an
optional feature brings in a heavy graph. Do not replace production imports with mocks just to
make the measurement smaller. See [Vitest's profiling guide](https://main.vitest.dev/guide/profiling-test-performance).

If import/transform time dominates, inspect import diagnostics or a main-thread CPU profile. If
test time dominates, investigate real code, database setup/reset, server readiness, and teardown.
Worker phase percentages are aggregated and are not independent wall-clock savings. `doctor`
executes its selection multiple times; never run it on the whole monorepo as a routine agent step.
Its suggestions require correctness checks: this repository's native dependencies and timezone
tests rule out blanket VM pools, and shared mocks/state require keeping isolation enabled.

## Suite organization and CI scheduling

CI builds and typechecks every playground once per OS in a dedicated required job. Integration
shards build the public packages and then only the fixtures their tests use; they do not depend
on generated output from another job. The `done` check requires both the tests and build/type
checks. Linux and Windows coverage and the credentialed live-deploy gate are unchanged.
The build job runs `test/check-playground-build-artifacts.mjs` after `build:all` to verify the
metaframework worker entries and inferred bindings. Their dev-server integration suites do not
repeat those production builds. `vpr test:all` runs the same artifact check locally.

Integration sharding uses [measured duration estimates](test/integration-timings.ts), rather than
filename hashes. [The sequencer](test/sequencer.ts) packs the longest files first and starts costly
fixtures early. Estimates affect scheduling only: new files receive a fallback estimate. Refresh
the estimates when the suite's costs change materially. Seeded file shuffling remains available
for isolation checks.

The four adapter suites share their client and island test definitions in `test/`. Each runs the
full browser behavior contract against its production preview build, plus a dev-mode navigation,
island hydration/interaction smoke check, SSR/protocol assertions, and HMR checks. This keeps both
runtime modes covered without repeating the full browser matrix.

Use production functions in unit tests. A copy of a hook's implementation inside a test cannot
catch regressions in the real hook. Shared form-value equality has one direct suite, and actual
form interactions run in the adapter browser matrix.

The in-memory API deletion tests schedule the fixed container-orphan sweep delay immediately.
They still execute both sweeps and all provider/database assertions. Production timing and the
real subprocess/lock deadline tests retain their actual timing semantics.

API integration fixtures reset their tables with one ordered SQL block. Use `clearTables` rather
than repeating per-table cleanup; it keeps foreign-key delete behavior and migration history
intact in PGlite and PostgreSQL.

The cached PGlite database template persists a UTC session default, independently of the
creating or consuming process's timezone. Increment `TEMPLATE_VERSION` in
`platform/packages/api/test/integration/db-template.ts` when changing template configuration
so existing local dumps are rebuilt. For database-clock assertions, compare timestamps in SQL;
JavaScript interprets timestamps without a timezone as local time. Keep explicit non-UTC
regressions for behavior that must work across timezones.

Platform CI runs the candidate's PostgreSQL concurrency cases in a separate job. The selector
finds API integration files that read `process.env.VOID_TEST_DATABASE_URL`, excluding mentions
in comments or strings. Each selected file runs against its own database clone, with two files
in flight, using the same bounded runner as schema compatibility. This exercises real locks
without repeating the entire API suite. To run it locally, migrate a disposable loopback
`void_schema_compat` database as `void_ci`, then set `COMPAT_DATABASE_URL` and run
`node .github/scripts/postgres-concurrency-tests.ts`.

Staging CI on main also runs the production schema-compatibility gate, so its failures are caught
before tagging a release. The job copies the candidate's `.github/scripts/schema-compat-tests.ts` runner
before checking out the deployed revision. It runs every deployed API test file against its own
clone of the upgraded PostgreSQL database, with two files in flight. Separate databases
prevent cross-project cleanup races and leaked fixture tables while preserving real multi-connection
tests within each file. The original upgraded database and its seeded compatibility records remain
untouched. The runner accepts only the disposable loopback `void_schema_compat` database as `void_ci`.
It also repairs two legacy fixtures, each gated by its full file checksum: the email concurrency
fixture must return the same zone ID for both lookups and model DNS for whichever request wins,
and the oversized deploy-body fixture must
consume its response before the next test clears its tables. Deployed runtime source and all test
assertions stay intact. Unknown revisions are left untouched, so a new failure cannot silently
inherit an old fixture exception.

CLI and deploy tests that stub their network boundary and call production functions directly run
in the unit project. The integration project is reserved for real builds, subprocesses, servers,
and browser behavior.

## Prepublish Test

Packed tests install the current tarballs into fresh applications through a temporary local
registry. They catch dependency, export, type-declaration, and installed-runtime problems that
workspace links can hide. They do not publish packages or deploy applications.

| Change or trigger                                                                                    | Packed coverage                         |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Documentation only                                                                                   | Skip install/build/browser jobs         |
| Routine code changes                                                                                 | One React app with each of npm and pnpm |
| Package manifests, lockfiles, packaging configuration, adapters, scaffolding, or packed-test tooling | Full four-framework matrix              |
| Release tags                                                                                         | Full matrix on Linux and macOS          |
| Manual workflow run                                                                                  | Choose smoke or full                    |

Smoke coverage checks package contents and exports, real initialization, CLI help, a frozen
reinstall, public Vite builds, TypeScript, and development HTTP requests for pages, assets, and
KV. It uses no browser. Full coverage adds Vue, Svelte, Solid, Markdown, production preview,
and browser hydration/navigation. Superseded PR/main runs are cancelled; release runs are not.

The selector reads all PR file pages or the complete pushed commit range. Renames consider both
paths. Incomplete or unavailable change lists fall back to full coverage.

Run these checks on Linux or macOS:

```sh
vp run build
node .github/scripts/packed-consumer.mjs
VOID_PACKED_SUITE=full node .github/scripts/packed-consumer.mjs
node --test --test-timeout=10000 .github/scripts/packed-*.test.mjs
```

`VOID_PACKED_PM=npm|pnpm` and `VOID_PACKED_FRAMEWORK=react|vue|svelte|solid` select a focused
local run. `VOID_PACKED_TOOLCHAIN=vite-plus` verifies Vite+ initialization, the workspace's
tested Vite+ version, and the generated `vp` build/dev/preview commands. CI checks a React
app with Vite+ for both package managers alongside the plain Vite coverage.
The interactive initializer is a Node.js script using the system `script` PTY
utility and Bash; it has no Python or native npm dependency.

## Browser readiness and Windows CI

Pages scroll regressions run in Chromium by default. On a machine with Playwright WebKit support,
run the same document navigation, reload, SPA navigation, and suspended-render cases in WebKit:

```sh
vp exec playwright install webkit
VOID_TEST_BROWSER=webkit vp test run packages/react/test/integration packages/vue/test/integration packages/svelte/test/integration packages/solid/test/integration -t 'restores.*scroll'
```

Use `waitForIslandsHydrated` from `test/browser-helpers.ts` before asserting island state or
interacting with islands. Pass the expected minimum count when checking a multi-island fixture.
Each island imports and hydrates independently, so a selector matching one hydrated island does
not establish that its siblings are ready. The helper rejects empty or partially hydrated pages.

For SPA navigation, wait for a client readiness signal before setting the document marker and
clicking. The Nuxt and SvelteKit playgrounds expose `h1[data-hydrated="true"]` after client startup.
`networkidle` and server-rendered HTML do not establish router readiness. Keep the document-marker
assertion so a full reload still fails the test. These suites attach recent browser console,
navigation, failed-request, HMR, and dev-server output to failures.

Give real subprocess tests a measured, suite-local timeout. The Drizzle drift suite can launch
three processes per case and uses 30 seconds on Windows and 10 seconds elsewhere. Ordinary unit
tests retain their default timeout. `waitForServer` already scales its timeout on Windows;
callers should pass an unscaled value and leave enough hook time for that wait and setup.

Start integration servers with `startServer` from `test/integration-helpers.ts`, and pass
`--strictPort` to Vite. A server binds its port seconds after the port is chosen, so another
process can take it first. Vite without `--strictPort` then moves to the next port, which can be
another test's port. With it, the server exits and `startServer` starts it again on a new port.
Another process that took the port can answer on it too, so answers count only after the server
prints its own URL with the port (`Local: http://…:<port>/` or `Listening on http://…:<port>`).
For a server that prints no URL, pass `printsUrl: false` and an `expectBody` only that app serves.

Windows integration tests also use `maxConcurrency: 2`. `maxWorkers` caps files, not concurrent
tests inside each file: two CI workers with Vitest's default concurrency of five can open ten
isolated browser contexts at once. The Windows cap reduces that to four without serializing
files or changing Linux/macOS concurrency. Do not retry browser navigation to hide
`ERR_NO_BUFFER_SPACE`; it reports a Windows socket resource failure, not a readiness timeout.

The Windows setup hook prints one resource snapshot per integration file at the first failed
test, before suite teardown. It records memory, the largest processes, dynamic TCP port ranges,
and connection counts by state/PID. Collection is read-only, limited to ten seconds and 64 KiB,
and retains partial output if it fails. Concurrent failures share the snapshot. It does not log
environment variables, process command lines, or remote addresses, and does not replace the
original test failure. Use this evidence to distinguish port, queue, and memory pressure rather
than assuming every socket error is port exhaustion.

## Native Cloudflare live E2E tests

Live tests are opt-in. They provision or update real resources and can write data, enqueue messages,
invoke AI, and start scheduled work. They must not run as part of the ordinary local or CI test
suite.

### Do not use the local fixtures as configuration

`playground-local/` is ignored scratch space. It may contain an operator's account IDs, resource
IDs, Worker names, generated output, Access tokens, and an ad hoc validator. Those values are not
portable and must never be copied into tracked documentation or treated as the canonical E2E
setup.

Each operator should create their own fixture in `playground-local/` or copy a tracked
`playground/` app there. Keep all account-specific configuration in that ignored copy. Run deploy
commands from the fixture's project root; `--dir` selects a static output directory but does not
change the project root.

### Choose reusable, account-local names

Pick a short namespace unique to the operator or test account, such as a team or username. Reuse
stable names across runs:

```text
void-e2e-<namespace>-static
void-e2e-<namespace>-kitchen
void-e2e-<namespace>-websockets
void-e2e-<namespace>-framework
void-e2e-<namespace>-sandbox
```

Use lowercase letters, numbers, and hyphens. Keep the namespace short because Cloudflare combines
Worker and version-preview alias names under a 63-character hostname limit. Resource names should
derive from the same namespace so the deploy adopts the operator's existing test resources instead
of colliding with another operator.

Do not use a production Worker or production resource name. E2E automation must never delete
Workers, databases, buckets, namespaces, queues, versions, or other remote resources. Live checks
may leave uniquely named test records and objects behind. Any eventual cleanup must be a separate,
explicit, manually reviewed operation against exact resource IDs.

### Select the Cloudflare account

Authenticate and inspect the accounts available to Void:

```sh
void cloudflare login
void cloudflare status
```

Use the intended test account rather than an account name embedded in a script. Pin it by either:

- letting `void init` write `account_id` to the ignored fixture's `wrangler.jsonc`; or
- setting `CLOUDFLARE_ACCOUNT_ID` in the current shell.

When a version has no preview URL, also set `CLOUDFLARE_WORKERS_SUBDOMAIN` to the account's
workers.dev subdomain. For [`https://my-worker.my-team.workers.dev`](https://my-worker.my-team.workers.dev), the value is `my-team`. The
account name shown in the dashboard is not necessarily the workers.dev subdomain.

Never commit account IDs, resource IDs, API tokens, or Access credentials. CI should receive them
through repository secrets or variables.

### Cloudflare Access

Prefer an unprotected or explicitly bypassed hostname for the baseline deployment suite. In an
Access application, **Allow + Everyone** still requires the requester to authenticate. A genuinely
public E2E hostname uses **Bypass + Everyone** and needs no Access credentials.

For a separate Access-protected readiness test:

- locally, set `CF_ACCESS_TOKEN` to the short-lived JWT returned by
  `cloudflared access token --app=https://<worker>.<account-subdomain>.workers.dev`;
- in CI, use an admitted `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` service-token pair.

Void sends these credentials only to its guarded readiness request. Do not put them in
`wrangler.jsonc`, `.env`, fixture source, command-line arguments, or tracked files.

### Baseline smoke test

From the ignored fixture's root, initialize it for the operator's account and deploy through the
same path a user runs:

```sh
void init
void deploy --platform cloudflare
```

For a static fixture whose output already exists:

```sh
void deploy --dir <output-directory> --platform cloudflare
```

At minimum, verify that the reported URL serves the new build and that a second deploy safely
updates the same Worker. Static coverage should also exercise headers, redirects, rewrites, and
404 handling. A failed readiness check must leave or restore the previous production version.

### Full feature matrix

Run deeper fixtures only after the baseline succeeds:

| Fixture      | Expected coverage                                                      |
| ------------ | ---------------------------------------------------------------------- |
| Kitchen sink | SSR/hydration, D1, KV, R2, queues, cron, ISR, auth, and Workers AI     |
| WebSockets   | Durable Object migrations, typed WebSocket routing, and socket traffic |
| Framework    | At least one detected third-party framework build and deployment       |
| Static       | Assets, headers, redirects, rewrites, ignores, and 404 handling        |
| Sandbox      | Containers and Sandbox runtime; paid-plan test only                    |

The default matrix must remain Workers Free-compatible. Do not run the Sandbox/Containers fixture
unless the selected account is known to have Workers Paid and the operator intentionally opted into
that test. An app that does not use a paid feature must not emit a paid binding or perform an
entitlement probe.

Record the Worker names and URLs in ignored local state or pass them to a validator as environment
variables. A reusable validator must derive hostnames from those inputs; it must not hardcode an
employee's account ID, workers.dev subdomain, dated Worker names, or a token file path.
