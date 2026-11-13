---
title: AI Gateway logging policy
status: implemented
created: 2026-11-13
---

# AI Gateway logging policy

Related: [#793](https://github.com/voidzero-dev/void/issues/793). User docs:
[AI Gateway logging](../../../docs/reference/cli/platform-users.md#ai-gateway-logging) and
[plan defaults](../../../docs/guide/platform/administration/plans.md#ai-gateway-logging).
Background: [Workers AI](./0019-workers-ai.md), [multi-provider AI](./0049-multi-provider-ai.md),
[installation plans](./0090-installation-plans.md).

## Contract

The platform, not the app, chooses how AI Gateway logs a project's AI requests:
`inherit`, `off`, `metadata` or `full`. The effective mode is the project's own
setting, else the owner's plan default, else `inherit`. A project setting wins in
both directions; only administrators set either. An account whose plan ID is not
in the catalog takes the catalog **default plan's** logging (limits keep their
older fallback to `free`), because an operator who sets `off` on every plan expects
every account to be off.

`inherit` sends no logging option, so the gateway's own `collect_logs` applies. The
installer creates gateways with logging on, and the platform never reads the value.

The proxy applies the mode to Workers AI `run`, `toMarkdown` and provider-native
calls, from deployed Workers and from `void dev` of a linked project. It still
strips every caller-supplied `collectLog`, `collectLogPayload` and `cf-aig-*` key
first, including `sessionOptions.extraHeaders`.

The written promise and its limits (requests already running, earlier logs,
Logpush, Unified Billing details, retention) are in the user docs. "Normally
within 2 minutes" is a target, not a guarantee: KV says a write can take up to
60 s, or the `cacheTtl`, to reach other locations. The readback `state` is the
authority.

## Why a KV projection

Release 1.8.0 read the policy from the API, and so from PostgreSQL, on every AI
call, and the API refused that read unless `PLATFORM_AUTH_DATABASE_UNCACHED=true`.
That flag is a self-hosted statement about the auth database path. Hosted Void
Cloud never sets it, so every hosted AI call returned 503. A setting that changes
rarely does not belong on the per-call path.

The policy now reaches the proxy the same way the `aiNeuronsPerMonth` block does
(`ai-block:<id>`): PostgreSQL is the source of truth and ROUTING KV holds a
projection.

```
operator / plan / account events          per AI call (run, provider, toMarkdown)
  PostgreSQL                                proxy
    project_ai_logging (0064)                 ROUTING.get('ai-logging:<id>', {cacheTtl: 30})
    platform_settings 'plans:ai-logging'        null       -> inherit
        │                                       known mode -> apply
        │ publishProjectAiLogging()             KV error   -> 503 ai_logging_policy_unavailable
        │ (under the project row lock)          other      -> 503 ai_logging_policy_invalid
        v                                            ▲
  ROUTING KV  ai-logging:<projectId> ────────────────┘   no API call, no PostgreSQL, no flag
    value 'off' | 'metadata' | 'full'
    metadata { mode, at }
    absent = inherit
```

## Data

- `project_ai_logging` (migration 0064): one row per project override. No row
  means the project follows its plan.
- `platform_settings` key `plans:ai-logging`:
  `{ modes: { <planId>: mode }, publish: { revision, planIds, includeUnknown, cursor, complete, error? } | null }`.
  Entries for plans no longer in the catalog are ignored. A missing row means every
  plan inherits.
- KV `ai-logging:<projectId>`: a bare mode string with metadata `{ mode, at }`
  (`at` is the publish time in ms). A key exists only when the effective mode is not
  `inherit`, so inherit projects need no backfill. A literal `inherit` value, or any
  value the proxy does not know, fails closed: an older proxy refuses a newer mode
  instead of treating it as inherit.

Plan defaults live in their own settings key, not in `plans:catalog`. Older APIs
rebuild every plan from known keys and save that object on every catalog write,
including each `plans sync` step, so after a rollback one edit would erase every
plan default and loosen logging on re-upgrade. Plan limits must also be an exact
numeric key set, and the plan publish must not wait on the usage-counter Durable
Object calls that account reconciliation makes.

Shared code lives in `@void/platform/ai-logging`
([source](../../../packages/platform/src/ai-logging.ts)), so the proxy, the API and
the installer in `packages/void` use one resolver, one key name and one parser
without importing `platform/`.

## Request path

The proxy reads the key only in `/ai/run`, `/ai/provider` and `/ai/toMarkdown`,
after body validation, so a 400 body, `/ai/models` and unknown `/ai/*` paths never
read it. The read is separate from the `ai-block` read, which keeps that shared
error path and `/ai/models` unchanged. `cacheTtl: 30` is the KV minimum; there is no
isolate cache on top. Failures log
`[ai] logging setting unavailable { projectId, reason, error | valueLength }`,
never the value.

All mode-to-option mapping is in `BINDING_LOGGING` and `PROVIDER_LOGGING` in
[proxy/src/ai-logging.ts](../../packages/proxy/src/ai-logging.ts):

| mode     | binding (`run`, `toMarkdown`)                                         | provider calls                              |
| -------- | --------------------------------------------------------------------- | ------------------------------------------- |
| inherit  | nothing                                                               | nothing                                     |
| off      | `collectLog: false`                                                   | `cf-aig-collect-log: false`                 |
| metadata | `collectLog: true` + extra header `cf-aig-collect-log-payload: false` | `cf-aig-collect-log: true`, payload `false` |
| full     | `collectLog: true` + payload `true`                                   | `cf-aig-collect-log: true`, payload `true`  |

Cloudflare documents only `gateway.collectLog` for the binding. The binding
`metadata` row depends on live check A below.

## Publishing

`publishProjectAiLogging(tx, routing, projectId, …)` in
[api/src/ai-logging.ts](../../packages/api/src/ai-logging.ts) is the only API writer.

**Rule 1: every KV write happens while the project row lock is held, and writes a
value read under that lock.** A later publisher waits for the lock, reads newer
inputs and writes last; KV keeps the last write.

1. Lock the row on its own (`UPDATE projects SET id = id WHERE id = … RETURNING status`),
   then read every input in a second write statement, which Hyperdrive never caches:
   `UPDATE projects … FROM users … LEFT JOIN project_ai_logging, plans:catalog, plans:ai-logging … RETURNING`.
   The order matters. Under READ COMMITTED a statement that waits for a row lock
   re-checks only the locked row and keeps the joined rows from the snapshot it took
   before the wait, so a publisher queued behind a newer change would write the old
   value. The second statement never waits and gets a fresh snapshot. A test records
   statements and fails if a plain SELECT feeds the publish; a PostgreSQL-only test
   covers the wait.
2. Resolve in TypeScript. Skip projects whose status is `deleting`.
3. `put` with metadata, or `delete` for inherit. A KV 429 is retried under the lock
   after 1 s, 2 s and 4 s; any other error, or a fourth 429, throws.

The operator POST orders the write by direction, using effective values.
`publishOrder` knows only `off < metadata < full`; any change to or from `inherit`
is `unknown`, because inherit means the gateway setting.

```
tx1: lock row, read previous effective, save project_ai_logging
  tighten | same    -> KV write in tx1; KV fails -> rollback, 503 ai_logging_publish_failed
  loosen | unknown  -> commit tx1
                       tx2: lock again, re-read, KV write
                            KV fails -> 503 ai_logging_publish_pending (row kept)
reply: mode, planId, planKnown, defaultPlanId, planMode, effective, source, previous, expectedBy = at + 120 s
```

So for a known order, KV is never looser than PostgreSQL. For changes with
`inherit`, every failure is an error to the operator and readback shows `drift`.
`same` still writes, so a retry after `ai_logging_publish_pending` repairs KV.
A tx1 rollback undoes only that call. A row saved by an earlier call that ended in
`ai_logging_publish_pending` stays, and the hourly sweep publishes it, so the
`ai_logging_publish_failed` message names the saved project mode and does not say
that nothing changed. The pending message says the sweep publishes the saved row
if the operator does not retry.

| Event                         | Publish                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project override              | operator POST, ordered as above                                                                                                                                                       |
| Plan default edit or clear    | plan route saves `plans:ai-logging` with a `publish` record, then runs one page                                                                                                       |
| Signup default change         | same, with `includeUnknown`                                                                                                                                                           |
| Plan removed with replacement | a page for the replacement plan's projects                                                                                                                                            |
| User plan change              | the user's active projects without an override, one page per call, after the plan update and before the usage-counter calls; an unfinished or failed publish is 500 `partial_failure` |
| Ownership transfer            | one publish after the transfer commits                                                                                                                                                |
| Project create                | inside the create transaction when the plan is not inherit; a KV error fails the create. The transaction starts with the plan lock shared                                             |
| Project delete                | key removed after the project row is deleted; a failed delete is left to the sweep                                                                                                    |
| Drift                         | hourly sweep and installer projection                                                                                                                                                 |

Plan publish pages select active projects on the affected plans (or not in the
catalog, with `includeUnknown`) with no override, `id > cursor`, ordered by id, 100
per page. The page and the user plan change list their projects through a no-op
`UPDATE … RETURNING id`, so a cached list cannot leave out a project created or
moved in the last minute. A user plan change does not compare the two plans first:
those reads could be cached, and a retry after a failed publish sees the new plan
on both sides, so every project without an override is published. One user plan
change call publishes at most one page (100 projects), so a large account stays
inside the 1000 KV operations allowed per invocation. Its cursor is saved in
`platform_settings` under `ai-logging:user-publish:<userId>` with the plan it is
for. Running the same plan change again continues from that cursor; a change to a
different plan starts from the first project, because projects before the cursor
were published for another plan. The row also holds a run ID, new for each change
that does not resume. A page saves progress only while the run ID still matches, so
after B -> C -> B a page left over from the first B change cannot move the new
run's cursor or remove its row. A page for a plan the account has since left
does nothing. The row is removed after the last page. The usage-counter calls run on
every call, whether or not the publish finished. A project create
holds the plan lock shared from its first statement, so a plan change or plan default
edit either waits for the create to commit and then lists the new project, or the
create reads the change. The dry run of a plan change reports `aiLoggingPublish`
with the number of projects it would publish. Each project runs the helper in its own short transaction; no
usage-counter call. The cursor is saved under the plan lock only when the record's
`revision` still matches and the cursor moves forward. The record's `revision` is the
new catalog revision, and the plan change reads the catalog it builds on through
the same no-op write as the defaults, so two changes never share a revision even
when Hyperdrive caches the plain catalog read. A newer plan change folds
into a running publish (plan IDs joined, `includeUnknown` ORed, cursor reset). On a
page failure the cursor stops at the last project written and `publish.error` is
set. `plans sync`, the dashboard and the hourly sweep each run one more page; the
CLI repeats `sync` until both account updates and the publish report complete.
A route answers `ok: false` when the catalog saved but a page failed; the CLI keeps
that body and stops with `plan_sync_pending` and the `plans sync --yes` hint rather
than a generic `partial_failure`.

The dry run returns `aiLogging.modesBefore`, the defaults it read under the plan
lock. The dashboard review and the CLI preview show those as the current values,
because the page and the listing read a row Hyperdrive may cache. The dashboard
edit form sends `aiLogging` only when the selector differs from the value the page
loaded, so an untouched selector on a stale page cannot clear a newer default. The
dashboard progress page counts accounts and projects separately.

The hourly sweep ([api/src/ai-logging-sweep.ts](../../packages/api/src/ai-logging-sweep.ts))
lists `ai-logging:` keys with metadata, compares them with the expected effective
modes, repairs mismatches through the helper, runs one page of an unfinished plan
publish, and logs `{ listed, expected, mismatched, repaired }`. A mismatch is a
key without metadata, a different mode, a missing key, or a key for a project that
is gone or now inherit. Keys for missing projects are removed only when they have no
metadata or are at least 10 minutes old, because a create writes its key before
commit. Keys of projects being deleted are left alone. The statuses of keys with no
expected mode are read 1000 IDs per query, inside the Postgres bind limit. The
sweep is the only place a KV read decides "no write": a stale list can only hide a
write the helper made under the lock in the last minute.

One run uses at most 400 KV operations (`AI_LOGGING_SWEEP_KV_BUDGET`), because a
Worker invocation may make 1000 and the other hourly jobs share them. List pages
count first, and 200 stay free for the plan publish page when one is running. The
rest goes to repairs: setting a key costs one write, removing one costs two (its
cleared marker, then the delete), and keys of missing projects are deleted with
what is left. With no plan page and one list page, a run fixes between 199 and 399
mismatches, so M mismatches are fixed within `ceil(M / 199)` hours at worst, plus
about 2 minutes to spread.

API log lines: `[ai-logging] published { projectId, mode, source, previous, trigger }`
and `[ai-logging] publish failed { projectId, step, status, trigger }`. The audit
target for the project route is unchanged; `config/plans` audit targets record
`aiLogging`.

## Readback

`project show`, `GET …/ai-logging` and the admin project page return `aiLogging`
with the saved `mode` (unchanged since 1.8.0) plus `planId`, `planKnown`,
`defaultPlanId`, `planMode`, `effective`, `source`, `published`, `publishedAt` and
`state`:

| state                  | when                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `applied`              | published matches effective and `at + 120 s` has passed, or both are inherit                                 |
| `pending`              | published matches effective and `at + 120 s` has not passed                                                  |
| `pending_plan_publish` | no match, the project has no override, and a plan publish or the owner's plan change publish is not complete |
| `drift`                | no match otherwise (also an unknown value, or metadata missing or not matching the value)                    |
| `unknown`              | the KV read failed                                                                                           |

The key is read without `cacheTtl`, so the API sees its own writes at once. So the
saved inputs must be current too: a cached Hyperdrive row (up to a minute old) next
to a fresh key would show a false `drift` right after a change. Readback reads its
inputs through the same no-op write statements as the helper, in a transaction that
holds the project lock while it reads the key, so no publish can land between the
two reads.

## Installer projection

[platform-ai-logging-projection.ts](../../../packages/void/src/cli/platform-ai-logging-projection.ts)
runs on every install, upgrade and repair, twice: after the database schema is
prepared and before the Worker upload (the new proxy may go live before the new
API), and after the upload (to catch writes the old API made to PostgreSQL only).
It uses the installer's direct database connection, skips when
`project_ai_logging` does not exist, lists existing keys, then in one transaction
locks the candidate project rows `FOR NO KEY UPDATE` in id order (the lock an API
`UPDATE` takes, so it does not block new rows that reference a project), reads the inputs again in
a new statement, and writes with `putKvBulk` / `deleteKvBulk`. A KV failure rolls
back and fails the command. Key and marker `at` values come from the database
clock (`clock_timestamp()`), not the operator's machine, because readback and the
sweep compare them with the API's clock. The same 10-minute orphan grace applies. Invalid saved
plan settings fail the command before any upload.

## Rollout and compatibility

- Hosted deploys the proxy first. The new proxy works against the old API because a
  missing key is inherit, so hosted AI recovers as soon as the proxy is live.
- Self-hosted uploads may make either Worker live first. A 1.8.0 proxy calls
  `GET /internal/ai-logging/<id>`. That route is kept: it reads the published KV
  value and returns `{ mode }` with no flag. Remove it only when no supported upgrade
  source and no hosted rollback target is 1.8.x.
- Self-hosted rollback to 1.8.0: its proxy reads overrides through its own API.
  Plan defaults are not applied while rolled back, but stay saved and the next
  upgrade publishes them again.
- Never roll the hosted API back to 1.8.x: its route returns 503 without the flag.
  Rolling only the proxy back works against the new API.
- No new binding, variable, secret or Hyperdrive change. Native
  `void deploy --platform cloudflare` is untouched.

## Known limits

- An unpublished change keeps the previous behavior. Failing closed on a missing
  key would need a key for every project and turn any gap into an AI outage.
- On project delete, the policy key stays until the project row is gone, so a token
  that still passes the owner check keeps the project's setting while teardown runs
  or waits for a retry. Once the row is gone, human tokens fail the live owner check.
  A project token stops working once proxies see the closed token floor, which
  teardown writes before the row is deleted; if a proxy has not seen it yet when the
  key is removed, that token can run as inherit for the rest of the floor's cache
  time. A key left by a failed delete is removed by the next hourly sweep.
- Every projection run rewrites non-inherit keys with a new `at`, so readback shows
  `pending` for about 2 minutes after each install or upgrade.

## Live checks A and B

Status: **pending**. Run them by hand on a scratch Cloudflare account before the
release that ships the promise, then record the results here.

- A: binding `run` and `toMarkdown` with `collectLog: true` and
  `extraHeaders['cf-aig-collect-log-payload'] = 'false'` store a log entry without
  bodies.
- B: a binding call with `collectLog: false` still appears in
  `aiGatewayRequestsAdaptiveGroups` with its metadata and cost, which metering reads.
- Provider calls through the gateway are also checked for each mode: `full` has a
  body, `metadata` an entry without body, `off` no entry.

Use a scratch gateway with logging turned on, and a token with Workers Scripts
Edit, Workers AI Read, AI Gateway Read and Account Analytics Read:

```sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... AI_LOGGING_CHECK_GATEWAY=... \
  node platform/scripts/ai-logging-live-check.ts
```

The [script](../../scripts/ai-logging-live-check.ts) uploads a temporary Worker,
calls each mode, polls gateway logs (up to 5 minutes) and analytics (up to 15
minutes), deletes the Worker, and prints one line per call plus the A and B
results. It exits nonzero on any failure.

| A    | B    | Binding `metadata`                                | Follow-up                                                                       |
| ---- | ---- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| pass | pass | keep the current mapping                          | none                                                                            |
| pass | fail | keep                                              | `off` escapes `aiNeuronsPerMonth`; decide whether to refuse it on metered plans |
| fail | pass | change to `{ collectLog: false, payload: false }` | docs: Workers AI and Markdown calls in `metadata` are not logged                |
| fail | fail | change as above                                   | `off` and `metadata` escape metering on Workers AI; decide as above             |

Results: not run yet.

## Decisions

- Plan defaults are offered on hosted too, with the same code. Built-in plans stay
  inherit.
- Commands print the expected time and do not wait. A `--wait` option can come later.
- No installation-wide default flag; plan defaults cover it.
- The dashboard project page is read-only for the project setting; the CLI is the
  edit path. Project owners do not see the mode.
- A missing key means inherit.
- A saved `plans:ai-logging` value this release cannot parse stops every AI logging
  write (project create, plan and project changes, the sweep and the projection)
  rather than guessing a mode. Plan commands read it first, so they cannot repair it;
  the message points to upgrading to the release that saved it. A repair command is
  not built.
- Refusing `off` or `metadata` on metered plans is not built; it depends on check B.

## Rejected alternatives

| Alternative                                                 | Why not                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Keep the per-call API read without the flag                 | Cached Hyperdrive reads can be stale; adds a hop to the API's region; all AI depends on API and DB |
| A second, cache-disabled Hyperdrive binding                 | New infrastructure on every install, still a per-call hop                                          |
| Set `PLATFORM_AUTH_DATABASE_UNCACHED` on hosted             | Not true for the hosted auth database, and it changes platform-access behavior                     |
| Policy in the tenant token, JWT or a Worker binding         | The token covers only project and generation; a binding is app-readable and needs a re-PATCH       |
| One gateway per mode                                        | Splits the metering filter on gateway id                                                           |
| Durable Object lookup per call                              | KV is the recommended store for config read on every request                                       |
| Fold into the `ai-block` read                               | Changes that shared error path and makes `/ai/models` read the policy                              |
| A publication table                                         | The `UPDATE … RETURNING` read, row lock and KV metadata give the same safety                       |
| Plan default inside `plans:catalog`                         | Older APIs erase it on any catalog write after a rollback; its publish would wait on counter calls |
| Loosen KV write after commit, outside the lock              | A later tighten can finish first, and the late loosen then wins                                    |
| A fixed rank for `inherit`                                  | Its meaning is the gateway setting, which operators change                                         |
| Read the gateway's `collect_logs` at publish time           | Extra API call and token scope per publish, and the value can change afterward                     |
| Fail closed on a missing key                                | Needs a key for every project; any gap becomes an AI outage                                        |
| Skip a publish write when KV already matches                | KV reads can be stale; only the sweep skips                                                        |
| One-time backfill, or projection only before the upload     | Misses rollback then re-upgrade, and old-API writes during the upload                              |
| Delete the old internal route                               | A 1.8.x proxy left live would refuse every AI call                                                 |
| Refuse `metadata` if the binding ignores the payload header | Strands saved settings; mapping to `collectLog: false` is stricter                                 |
| Block the command until the change has spread               | Slow; the expected time plus readback state gives the same information                             |
| Per-project only                                            | #793 asks for per project or per plan, managed like `aiNeuronsPerMonth`                            |
