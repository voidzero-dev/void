# @voidcloud/dispatch

Edge router for deployed Void apps. It routes requests to user workers, serves static deployments, manages ISR caching, applies redirect/rewrite/header rules, and records request usage.

## Request Flow

1. Extract slug from hostname or fall back to `domain:{hostname}` routing.
2. Read routing data from `ROUTING` KV.
3. Reject suspended projects with `429`.
4. Apply `redirectRules` (pre-asset) before any worker invocation. Redirects short-circuit with a `Location` header; status-200 entries are "force" rewrites that mutate `url.pathname` and continue.
5. Serve hashed assets from edge cache when possible.
6. For static/SPA projects, serve current direct-upload assets from `STATIC_ASSETS_R2`; preserve `STATIC_ASSETS` KV reads for assets carried forward from legacy deploys. Storage reads get one delayed hedge within the existing 10-second request budget, then use `assetConfig` path resolution.
7. Apply `fallbackRules` (post-asset) only when static asset resolution misses — instead of returning 404, match the pathname against fallback rules (status=200 only) and rewrite. Intended for SPA shells (`/* → /index.html`) and default-locale catch-alls. On static deployments, a matched fallback serves the resolved asset directly without dispatching to a user worker, so `X-Void-Original-URL` is never set, `c.originalUrl()` is unavailable, and the response is not ISR-cached (see `packages/dispatch/test/unit/fallback-rules.test.ts`).
8. For `/api/*`, forward to the user worker in the dispatch namespace with plan-specific CPU/subrequest limits. Foreground worker responses, including SSR and ISR cache misses, have no default wall-time deadline while the client remains connected.
9. For SSR with ISR enabled, use `caches.default` plus `ISR_CACHE` KV for stale-while-revalidate behavior.
10. For WfP deploys, inspect worker and cache responses for the Cloudflare asset-dedupe-poisoning stub (`Assets have not yet been deployed to this script.`). On detection, purge any poisoned cache entry and re-serve from the platform-owned mirror (`STATIC_ASSETS`/`STATIC_ASSETS_R2`). If the mirror is unavailable or incomplete, return an attributed `503` instead of passing through and caching the known-bad `200` stub. See the [asset fallback design](../../meta/design-docs/0066-wfp-asset-r2-fallback.md).
11. Apply header rules and record usage in Analytics Engine. If `userId` is present on the routing entry, enqueue usage events as well. Platform-owned static storage failures carry a `failureKind`: they remain metered and queryable but are excluded from customer application-error emails.

Two rule lists exist so dispatch never has to reason about per-rule phase flags at the edge:

1. **`redirectRules` — pre-asset.** Evaluated on every request before static-asset resolution or worker invocation. Handles 3xx redirects (`status: 301|302|303|307|308`) and status-200 rewrites that pre-empt the asset pipeline (from `routing.rewrites` or `_redirects` `200!` entries).
2. **`fallbackRules` — post-asset.** Evaluated only when the static-asset resolver would otherwise 404. Always `status: 200` rewrites. Used for SPA shells and default-locale catch-alls.

## Static and ISR Storage

- **Static/SPA deploys**: manifest in `ROUTING`; current direct-upload assets in `STATIC_ASSETS_R2`. `STATIC_ASSETS` KV remains readable for small assets carried forward from legacy multipart deploys.
- **WfP deploys with asset mirror**: same project-scoped storage and manifest format as static (manifest at `manifest:{deploymentId}`, assets at `assets/{projectId}/{hash}`). `RoutingEntry.assetManifestId` points at the manifest. CF's `ASSETS` binding remains primary — this mirror is only consulted when the CF stub is detected.
- **ISR cache**: packed HTML/headers stored in `ISR_CACHE` KV, with edge-cache copies in `caches.default`. Keys are (project, deployment, pathname, optional rewrite-variant token) so a direct hit to `/en/docs` and a request rewritten from `/docs → /en/docs` live in distinct slots — user code can branch on `c.isRewritten()` / `c.originalUrl()` and the cache honors that. The variant suffix is derived from `X-Void-Original-URL` via the shared helpers in [`@void/isr`](../../../packages/isr/README.md); direct hits (no rewrite, no header) use the unsuffixed key.
- **ISR TTL resolution**: a request's TTL resolves route-aware — dispatch first-matches the path against the manifest's ordered `pages` table (`{ pattern, revalidate }`, in the framework's route order, **not** re-sorted) so a specific page shadows a broad catch-all, then falls back to the flat `revalidate` pattern→TTL map for deploys that predate `pages`. Only a positive-TTL, non-catch-all match is ISR-eligible; API routes and asset-extension paths that merely match a catch-all render live (`resolvePageTtl` / `isIsrEligiblePath` in `isr.ts`).
- **Hashed assets**: immutable edge-cache entries keyed by URL path

## Queue Relay

The dispatch worker also exports `queue()`:

1. Cloudflare delivers a `MessageBatch`
2. Self-hosted dispatch checks the installation traffic gate before any app lookup; staging, disabled, and unreadable gate states retry the batch after five minutes
3. `queue:{queueId}` is resolved from `ROUTING` KV
4. The batch is serialized and forwarded to the active user worker at `/__void/queue`
5. Success acks the whole batch; failure retries the batch

Lifecycle retries preserve the batch only within the Queue consumer's configured retry count and Cloudflare's retention and dead-letter policy. A long disable can exhaust those limits; disabling the platform does not provide indefinite message storage.

## Source Layout

```text
src/
  index.ts        # Main fetch + queue handlers
  hostname.ts     # Hostname/slug extraction
  static.ts       # Static manifest path resolution + content types
  isr.ts          # ISR cache packing, KV read/write, edge cache keys
  routing-rules.ts # Redirect and rewrite rule matching (applyRoutingRules)
  headers.ts      # Header rule application
  pattern.ts      # Shared path-pattern compiler (compilePattern, matchPattern, substituteParams)
  metering.ts     # Analytics Engine writes + usage queue events
  constants.ts
  env.ts
test/unit/
  index.test.ts
  hostname.test.ts
  static.test.ts
  isr.test.ts
  routing-rules.test.ts
  fallback-rules.test.ts
  headers.test.ts
  pattern.test.ts
  metering.test.ts
```

## Metering

Any request that resolves to a routing entry and is not suspended records:

- project ID
- request type (`api`, `static`, `ssr`, `isr`)
- method
- status
- response bytes
- duration
- slug/hostname

Analytics Engine is the source for usage reporting. Dispatch also publishes
lightweight usage events to `USAGE_QUEUE` when the routing entry includes a
`userId`. Queue messages use a platform-only signing key read from `ROUTING`;
if the API health bootstrap has not created that key, dispatch reports a metering
error instead of emitting an unsigned compatibility frame. The API consumer
resolves account ownership and the canonical project slug from Postgres before
applying a valid event.

### Explaining a dispatch-generated 503

`DISPATCH_TIMEOUT_MS` optionally imposes a foreground worker response deadline. Without it, requests follow Cloudflare's client-connected lifetime; platform storage and background ISR revalidation retain their 10-second budgets. An explicitly configured deadline can cancel a worker after an external side effect has completed, so a timeout does not establish that a mutation failed.

A user worker cut at that configured budget never returns, so it emits no log of its own and its tail event records only `canceled` — the same outcome a real client hang-up produces. Dispatch is the only party that knows it was the one that hung up.

On those three worker-timeout paths, `recordPlatformLog` (`metering.ts`) writes one row into the `void_logs` dataset through the `LOGS` binding, so `void project logs` explains the 503 instead of showing nothing. The row uses the same seven-blob/two-double shape `packages/tail` writes, and is keyed by splitting `RoutingEntry.workerName` (`user-<slug>-dpl_<id>`) into `index1` and `blob7` exactly as the tail worker does — the read path in `GET /projects/:id/logs` selects on `index1`, so a differently-keyed row would be unreadable. Do not key it off the metering `slug`, which falls back to the hostname on a custom domain.

The write is best effort and swallows its own failures: every call site is already returning a 503, and a throw there would surface as a 500.

Because the failure is swallowed, the row must never be one Analytics Engine would drop. AE caps the **sum** of a data point's blobs at 16 KB (there is no per-blob limit), and this row would otherwise carry the request URL twice — raw in `blob4` and as the pathname inside the `blob2` message. The longest URL already recorded in `void_logs` is 6,703 bytes against a p99 of 195, so the exposure is real. `truncateUtf8` bounds the URL at 2048 bytes and the message pathname at 1024, which holds any blob set under ~3.5 KB. The budget is measured in UTF-8 bytes and cuts on a character boundary; a split sequence would decode to U+FFFD, which is itself 3 bytes. `index1` is deliberately **not** truncated — it is the read key, so a shortened one would be unselectable, which is worse than a dropped row.

## Edge Caching

- **Hashed assets**: `Cache-Control: public, max-age=31536000, immutable`
- **Versioned static assets**: `s-maxage=31536000, max-age=0, must-revalidate`
- **ISR HTML/JSON**: edge cache backed by `ISR_CACHE` KV

The deploy-versioned static cache accepts only uncredentialed GET requests. In
SSR deployments, a dotted URL is cached there only when the deployment's asset
manifest contains that exact path. Unknown legacy assets render through the
worker without entering this shared cache. Hashed assets use their earlier
content-addressed cache path.

Not cached:

- `/api/*`
- non-GET requests
- requests with `Cookie`, `Authorization`, `Range`, Pages protocol, or EventSource semantics
- private/no-store/no-cache responses
- SSR pages without ISR

## Tests

- `test/unit/index.test.ts` — main routing behavior
- `test/unit/static.test.ts` — static path resolution and serving
- `test/unit/isr.test.ts` — ISR cache packing and TTL behavior
- `test/unit/routing-rules.test.ts` — redirect and rewrite rule matching
- `test/unit/pattern.test.ts` — shared path-pattern compiler
- `test/unit/fallback-rules.test.ts` — post-asset fallback rewrite rules (static deployments)
- `test/unit/headers.test.ts` — header rule application
- `test/unit/hostname.test.ts` — slug extraction
- `test/unit/metering.test.ts` — Analytics Engine payload shape and signed usage envelopes
- `test/unit/platform-log.test.ts` — `void_logs` row shape, and lockstep with `packages/tail`'s script-name split
