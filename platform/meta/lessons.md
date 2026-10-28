# Lessons

## Operating rules

- Keep the current branch, including `main`, unless the user requests another
  branch or worktree. Create requested worktrees with `git worktree add` under
  `.worktrees/`; do not copy their changes back without authorization.
- Keep design work separate from implementation until implementation is
  requested. Prefer a clean cutover for features that have never been live.
- Preserve existing features when asked to fix defects. If a feature-removal
  choice was explicitly left pending, do not silently treat a later broad
  bug-fixing request as resolving it; reconcile that product decision directly.
- Code defines current behavior; public docs may intentionally omit paused
  features. Distinguish implemented code from shipped behavior and verified
  release status. Read package scripts before documenting their scope.
- Keep the bundled matching platform payload when it supports the existing installation workflow. Propose a packaging split only with a concrete user or maintenance benefit.
- Trace existing contracts before proposing replacements. `void.config.ts`
  already owns authored configuration and `void.lock.json` owns generated
  resource state; prioritize a replacement only after demonstrating its payoff.
- Keep inferred persistent resource identities as the default. Offer discovery
  and optional explicit names before source moves; preserve existing instance
  keys separately when route parameters change. Copy requested CLI wording
  exactly rather than substituting a more technical explanation.
- Introduce one idea, show a small example, then explain its behavior, following
  [Fate's guides](https://fate.technology/guide/requests). Put implementation
  details in maintainer docs and keep command references easy to scan.
- User installation guides describe the published CLI. Keep `void-dev`, checkout
  builds, and source-release workflows in contributor guidance; keep Void Cloud
  maintenance in repository runbooks. Do not turn a one-off development failure
  into a prerequisite for every user.
- Run commands from the repository root. Use `vp run build:all` for the full
  SDK/platform/playground build and [TESTING.md](../../TESTING.md) for verification.
- `vp run <script> -- <args>` forwards the literal `--`. For Wrangler that
  hides `--env`: use `vp run --filter <pkg> deploy --env production|staging`.
  Production deploys must select `--env production` explicitly.
- There is no separate `void-platform` repo: the platform was merged into
  the unified `voidzero-dev/void` repo. Framework code is `packages/`,
  platform code is `platform/packages/`, platform meta is `platform/meta/`.
  Do not reason about submodule pointers or a sibling platform checkout.

## Stale branches and reviews

- Prefer reapplying a very stale branch over replaying its obsolete intermediate
  changes. Reconstruct stacked branches and resolved review context before
  assigning a fix to a branch.
- Clean merges can still drop new parameters or paths. Compare current
  signatures and generated output; use named options for growing interfaces.
  Resolve project directories through the current path abstraction.
- Codemods must preserve comments attached to positional arguments correctly.
- Reproduce mechanically checkable review claims before fixing them. Measure
  performance under real input caps; do not adopt a reviewer's unverified number.

## Email and routing

- Route platform email on the preserved wire recipient `__voidPlatformTo`;
  strip its project prefix exactly once for the handler-facing message.
- Match addresses case-insensitively without lowercasing captured parameters.
- Check the zone's `support_subaddress` setting; it is not implied by a
  literal Email Routing rule.
- Use documented credential handoffs such as `wrangler auth token --json`
  rather than inferring capabilities from on-disk credential formats.
- Execute generated dispatch code with realistic messages in tests. Matching
  generated substrings alone does not prove a handler can receive an event.

## Framework and schema

- Config changes update `packages/void/schema.json`,
  `docs/en/reference/config.md`, types, validation and affected examples together.
- Preserve CLI namespaces and prefer conventions over configuration. Runtime
  APIs belong at package roots; Vite plugin factories use `/plugin` subpaths.
- Switching an existing database from schema push to migrations requires
  establishing the correct migration journal baseline first.
- Keep dialect-specific imports in separate modules so Worker bundles do not
  pull in an unrelated database driver. Database dialect support includes
  manifests, validation, capabilities, credentials, migrations and tests.
- Use the appropriate Drizzle validator adapter and the `@schema` alias.
  SQLite PRAGMA arguments use bare names or single-quoted identifiers.
- Keep schema changes compatible while old Workers can run. Renames, drops
  and type changes require staged rollout. Use `VOID_TEST_DATABASE_URL`
  for real PostgreSQL checks; preserve integration-file serialization.

## Cloudflare and deployment

- Preflight shared secrets before migrations or Worker changes, and upload them
  with a new Worker's first deployment. An existing staging secret does not
  prove that first-production bootstrap works.
- Install CommonJS interoperability on the actual Worker build environment,
  whose name comes from Wrangler rather than a presumed `ssr` name.
- Analytics Engine queries include timestamps used in filtering/sorting, use
  `GROUP BY` rather than `DISTINCT`, avoid timestamp aliases and format
  datetime literals consistently. Project queries use `blob1`.
- Deployment manifests include the database binding whenever the app needs
  D1, auth or migrations. Dedupe comparisons include Worker module hashes.
- Cancellation remains blocking until cleanup completes. Synchronize crons
  only after routing cutover so a failed candidate preserves the live schedule.
- Verify uploaded bytes against client-declared asset hashes. Preserve the
  cache-buster, early hash persistence and KV/R2 mirror fallback described in
  [the asset fallback record](./design-docs/0066-wfp-asset-r2-fallback.md).
- API changes tolerate both the currently deployed dashboard and its next
  version. Use staged rollouts for incompatible changes.
- A new platform database migration needs a rollback-safe prefix entry for the
  currently installed version when old Workers can run on the new schema.
- Hosted staging requires its explicit API origin and Access credentials;
  `STAGING=1` alone does not select it. Keep OAuth callback bypasses.
- Wrangler vars are strings: compare flags to `'true'` explicitly.
- Local Wrangler redirects to `localhost:<port>` can be rewritten incorrectly.
  The dev-login path uses an HTML navigation response; test that response,
  not an assumed redirect header.
- Resolve a dispatched Worker's DO namespace through its bindings endpoint,
  not an account-wide namespace scan. Preserve the Queue-based dispatch path
  where a DO or WorkerEntrypoint cannot make the required service fetch.
- Legacy container namespace bindings are immutable. Verify namespaces on recovery,
  handle concurrent creation, and delete container applications explicitly;
  deleting their Workers is insufficient. The [managed Sandbox design](./design-docs/0082-managed-sandbox-restoration.md)
  records the current controller path and legacy drain boundary.
- Recovery lookups after provider conflicts must preserve retryable rate-limit
  errors and otherwise fall back to the original diagnostic.
- Preserve chronological DO migration tags and configured class names.
  Read nested `script.migration_tag`; omit migrations when already at the
  target instead of resending the same tag.

## Build logs and concurrency

- Set `CI=true` on build children so interactive tools do not animate into
  captured output. Keep the fallback CLI version equal to the SDK version
  through a test, not only a comment.
- Capture raw logs and sanitize at rendering time, before the visible-tail
  budget. Use `@xterm/headless` for terminal semantics instead of maintaining
  another emulator or treating an ANSI stripper as one.
- Terminal fixtures cover C1 control forms, intermediate-bearing escapes,
  wide glyphs and combining marks. Preserve raw control bytes when capturing
  fixtures; a tool that rewrites them cannot establish parser behavior.
- Only DO storage operations hold its input gate. Network I/O can interleave;
  shared cursor reads, pulls, ingestion and teardown need single-flight
  ordering or the appropriate concurrency gate.
- A pull transport needs a producer drain barrier acknowledged after durable
  ingestion. Bound it with both an idle-progress deadline and an absolute cap.
  Forced teardown serializes joining, fresh draining, liveness checks and
  signaling, so no pull can appear after the terminal marker.
- Tests must construct reachable complete peer state, including marker
  ownership and live-container state, or drive the real producer path.
- Timing out a database wait does not cancel the write. Reconcile when the
  underlying work settles; an immediate reread or unrelated stale reaper is
  insufficient.
- Bound work and elapsed time independently. Worker clocks do not advance
  during synchronous CPU work. Charge payload bytes, rows and fan-out, and
  preserve atomic cursor advancement.
- Byte budgets count the serialized bytes that travel, not UTF-16 length.
  Producer and consumer limits must use the same units. Cap buffer bytes as
  well as rows, and trim to a low-water mark for amortized eviction.
- A bounded data structure can still permit unbounded processing. Limit
  parameter-driven terminal work before invoking expensive handlers.
- See [build-log decisions](./design-docs/0076-build-logs.md) for the protocol
  and the production regression tests for detailed cases.

## Dashboard and product surfaces

- Present signup policy, manual grants, and invitations as one access workflow;
  show notification delivery separately from the permission it creates.
- Show a short, fixed set of administrator setup steps directly; a disclosure
  adds friction when there is no meaningful detail to hide.
- Keep admin settings readable by grouping independent controls into clear sections
  with visible status and actions beside the item they affect.
- A disabled admin feature still needs to render inside the dashboard layout
  for both direct visits and client-side page navigation.
- Render the expected system-health check slots before polling and keep their
  status details on one line so asynchronous updates do not shift dashboard content.
- Cloudflare Tail sees top-level logs and uncaught throws. Log caught errors
  explicitly; `void project logs --filter` filters message text and
  `--level` filters severity.
- Test the dashboard against a local API or an explicitly selected
  installation. Put local Worker vars in its `.dev.vars` or local config.
- Verify the generated Worker config and dry-run bindings for staging OAuth;
  callbacks must tolerate Access interposition.
- Dashboard tokens live in `packages/dashboard/ui/styles/tokens.css`.
  The palette resets with `--color-*: initial`; define a color scale before
  using its utility classes.
- Keep marketing shells as full-height column layouts with a flexible page
  area and full-width wrappers, so footers and border lines remain aligned on
  short pages.
