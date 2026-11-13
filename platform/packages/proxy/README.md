# @voidcloud/proxy

Shared proxy worker for platform-owned capabilities: AI metering, ISR revalidation, remote D1/KV/R2 access, and platform email submission. The dedicated email gateway owns inbound routing and reuses the proxy's admission and provider helpers.

## Architecture

- **AI traffic** goes through AI Gateway so usage cannot bypass platform metering.
- **ISR revalidation** forwards to the API worker over a service binding.
- **Remote bindings** resolve the active deployment on every operation, then try its user worker via `DISPATCH` and `/__void/*`. Read operations can fall back to Cloudflare REST APIs when native dispatch is unavailable.
- **Resource resolution** happens through internal API endpoints, not direct DB reads inside the proxy.
- **Email** submissions use the API’s PostgreSQL admission ledger. Shared senders use the platform `send_email` binding; custom senders use scoped credential leases. Inbound mail enters through the dedicated email gateway, which resolves exact-domain authority through the API before dispatch. Tenant workers hold neither mail bindings nor customer credentials.

```text
Deployed user worker            Proxy                       Downstream
┌────────────────────┐         ┌────────────────────┐      ┌────────────────────┐
│ ai.run()           │────────▶│ /ai/*              │─────▶│ AI Gateway / AI    │
│ revalidate()       │────────▶│ /revalidate        │─────▶│ void-api           │
│ remote D1/KV/R2    │────────▶│ /d1/* /kv/* /r2/*  │─────▶│ user worker / CF   │
│ sendEmail()        │────────▶│ /email/send        │─────▶│ CF email service  │
└────────────────────┘         └────────────────────┘      └────────────────────┘
```

## Authentication

Project requests use these authentication paths:

| Path            | When               | Auth                                                                                                                                                                                               |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service binding | Deployed Void apps | Project token (`aiToken`), checked against the project's accept floor; see [Project tokens](#project-tokens); requests use bare hosts (`https://ai-proxy`, `https://proxy`, `https://email-proxy`) |
| HTTPS           | Local development  | `Authorization: Bearer <api-jwt>`                                                                                                                                                                  |
| HTTPS           | Managed prerender  | Five-minute, project-scoped prerender JWT                                                                                                                                                          |

Project-scoped POST routes require `projectId` in the JSON body. The public
`GET /health` route has no project body, and `/email/verify-receipt` checks a
separate internal proof. Prerender JWTs are accepted only when their signed
project claim exactly matches `projectId`; they are not valid at deployment or
project-management APIs.

HTTPS callers must send `Authorization: Bearer`; the proxy verifies it before
reading the body, and a request to a public hostname without it gets 401 unread.
Service-binding bodies are bounded before their project token is checked:
control routes accept up to 1 MiB, while `/ai/run`, `/ai/provider`,
`/ai/toMarkdown`, `/kv/put`, and R2 put routes accept up to 8 MiB. Email sends
retain their 8 MiB envelope limit and receipt verification accepts up to 2 KiB.
A stalled body times out after five seconds; non-email routes return 413 for
oversized bodies and 408 for timeouts.

### Project tokens

Each deployed Worker holds its project token in the `__VOID_PROXY_TOKEN`
binding. Both forms are derived from `JWT_SECRET`:

| Form          | Generation | Value                                                                                                                                                       |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy        | 0          | base64url `HMAC-SHA256(JWT_SECRET, projectId)`                                                                                                              |
| `<gen>.<mac>` | 1 and up   | `<mac>` = base64url `HMAC-SHA256(K, "void-proxy-token:" + projectId + ":" + gen)`, `K` = HKDF of `JWT_SECRET` (salt `void-proxy-token`, info `proxy-token`) |

The ROUTING key `proxy-token:{projectId}` holds the project's accept floor,
`{"gen": N}`. A token is accepted when its MAC is valid and its generation is at
least `N`. A missing key means floor 0, so the legacy token is accepted.
Deleting a project sets its floor above every issued generation, so none of
its tokens work again. The
`projectId` must be a generated project id, and the MAC is checked before the
floor is read, so an invalid token never reads KV. A floor that cannot be read
or does not parse fails closed with 503 `project token state unavailable`. Each
isolate caches a floor for 15 seconds and reads KV with `cacheTtl: 30`, so with
KV propagation a raised floor rejects older tokens everywhere within about 105
seconds.

Service-binding auth and `/email/verify-receipt` use this check. `/revalidate`
forwards the token, and the API checks it against the same floor.

When the proxy calls a tenant Worker's `/__void/*` handler, it sends the token
for the generation `resolve-worker` reports (`proxyTokenGen`): the generation
recorded on the active deployment (`deployments.proxy_token_gen`), which is
the token that Worker holds. When the API does not report one, it sends the
token for the floor. It sends each call once. The Worker's own middleware runs
before its `/__void/*` handler checks the token, so a 403
`{"error":"unauthorized"}` is returned to the caller and never replayed with
another token. Cron fires and queue relays follow the same rule: each queue
entry and the cron scheduler hold the one token their Worker holds.

A rotation records a Worker's new generation, and updates its queue entries and
cron scheduler, only after Cloudflare confirms the PATCH. Until that step
commits, and while Cloudflare can still serve the Worker's previous version,
calls to it get a clean 403: proxy calls fail, cron fires are dropped with
`AUTH_DRIFT`, and queue batches are retried after 120 seconds.

The proxy authenticates its own `resolve-worker`, `resolve-resource`, and
`verify-prerender-build` calls with `x-void-proxy-internal`, an HMAC under a
separate HKDF key (salt `void-proxy-internal`, info `proxy-internal`) bound to
the route and project. That value never leaves the platform.

## Endpoints

### AI

| Endpoint              | Body                                                                             | Notes                                                |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `POST /ai/run`        | `{ model, inputs?, options?, projectId, aiToken? }`                              | Cloudflare AI binding inference                      |
| `POST /ai/provider`   | `{ provider, path, method?, headers?, body?, providerKey, projectId, aiToken? }` | Provider-native AI Gateway call                      |
| `POST /ai/models`     | `{ inputs?, projectId, aiToken? }`                                               | List models                                          |
| `POST /ai/toMarkdown` | `{ inputs, options?, projectId, aiToken? }`                                      | `AI.toMarkdown()` through the project-tagged gateway |

`/ai/*` also checks `ROUTING` for `ai-block:{projectId}` before forwarding.

`/ai/provider` forwards to `AI.gateway("void").getUrl(provider)` plus the relative `path`. JSON, text, binary, and multipart bodies are serialized by the SDK and reconstructed before forwarding. OpenAI-style providers default to `Authorization: Bearer <providerKey>`; Google AI Studio uses `x-goog-api-key`. Non-JSON responses are returned without JSON coercion so provider-native binary and streaming responses can pass through.

### Remote bindings

| Endpoint                                            | Purpose             |
| --------------------------------------------------- | ------------------- |
| `POST /d1/query`                                    | Query a D1 binding  |
| `POST /d1/batch`                                    | Batch D1 statements |
| `POST /kv/get` / `put` / `delete` / `list`          | KV access           |
| `POST /r2/get` / `put` / `delete` / `list` / `head` | R2 access           |

The remote-binding path is:

1. resolve the active deployment's versioned worker or resource via internal API
2. try the deployed worker's native binding handler through `DISPATCH`
3. fall back to the Cloudflare REST API when the operation is safe to retry and the worker does not support `/__void/*`

`D1Database.batch()` has no REST fallback. It runs once through the active worker's native D1 binding, which preserves D1's atomic batch contract, or fails before executing any statement when that capability is unavailable. If a write dispatch fails after it may have committed, the proxy returns an unknown-result error and does not replay the operation through REST.

### ISR revalidation

| Endpoint           | Body                                                      |
| ------------------ | --------------------------------------------------------- |
| `POST /revalidate` | `{ paths?: string[], all?: boolean, projectId, aiToken }` |

The proxy forwards the request to `API.fetch("https://api/internal/revalidate/:projectId")` with the project token in `x-void-internal`. The API accepts it under the same floor as the proxy.

### Email

`POST /email/send` accepts authenticated project identity, envelope sender and recipients, MIME bytes, a request ID, and an optional idempotency key. The proxy validates the message and asks the internal API to reserve each permitted recipient. PostgreSQL checks project ownership, consent, installation policy, suspension, domain readiness, and quota atomically.

```text
Tenant send → proxy validation → API admission → per-recipient attempt start
  → platform binding (shared sender) or scoped send_raw (custom sender)
  → record accepted, failed, or unknown outcome

Cloudflare Email Routing → gateway (native or authenticated zone relay)
  → API exact-domain resolution → receipt claim → active tenant dispatch
  → validate handler actions → same API admission and outcome ledger
```

An idempotency key binds an action to its payload digest. Replays return recorded recipient states; a conflicting payload fails. An uncertain provider outcome is never automatically retried. Unstarted reservations can be cancelled and refunded; started attempts retain quota. Provider submissions wait at most 30 seconds. Direct sends share one 50-second proxy budget, with the final 5 seconds reserved for finish or cancellation; inbound handler action batches retain a 60-second budget.

The gateway resolves the active project worker and dispatch limits from the API. Tenant requests and framed responses have an absolute deadline, and a durable receipt prevents replay after dispatch may have started. Native ingress can forward or reply using the original Cloudflare message. Relayed replies select delivery by sender domain: the shared binding for platform addresses, or scoped `send_raw` for custom addresses. Relayed forwarding returns `UNSUPPORTED_ACTION` without consuming quota because REST resending does not preserve native forwarding semantics.

All handler actions are validated again at the platform boundary. MIME is capped at 5 MiB per message, replies at 8 MiB in aggregate, and action lists at 100 entries. The shared protocol bounds encoded response size, recipient counts, and headers. See `packages/platform/src/email-protocol.ts` and `../email-gateway/src/router.ts` for the wire limits. PostgreSQL records inbound receipts and outbound recipient outcomes; KV hints cannot authorize delivery.

#### Sender domain

`EMAIL_SENDER_DOMAIN` configures the shared mail domain for each installation. Deployed apps receive `__VOID_EMAIL_DOMAIN` and `__VOID_PROJECT_SLUG` to construct their default `<slug>+noreply@<domain>` sender. Missing configuration fails closed. Email-enabled installations provision the shared binding and verify gateway ingress before opening traffic.

### Health

`GET /health` returns binding presence for `ai`, `kv`, `jwt`, `api`, `sendEmail`, and
`emailDomain`.

## Source Layout

```text
src/
  index.ts        # Hono app, CORS, auth middleware, route mounting
  ai.ts           # Workers AI + AI Gateway endpoints
  revalidate.ts   # ISR revalidation forwarding to API
  dispatch.ts     # Dispatch-to-user-worker fast path for remote bindings
  resolve.ts      # Internal API resource resolution + in-memory cache
  d1.ts           # D1 remote access
  kv.ts           # KV remote access
  r2.ts           # R2 remote access
  email.ts        # Outbound /email/send
  types.ts        # Env and JWT types
test/unit/
  proxy.test.ts
  dispatch.test.ts
  resolve.test.ts
  d1.test.ts
  kv.test.ts
  r2.test.ts
  email.test.ts
```

## Bindings

| Binding                | Type               | Purpose                                                |
| ---------------------- | ------------------ | ------------------------------------------------------ |
| `AI`                   | Workers AI         | Real inference binding                                 |
| `API`                  | Service binding    | Internal API calls (`revalidate`, resource resolution) |
| `DISPATCH`             | Dispatch namespace | Fast path to deployed user workers                     |
| `ROUTING`              | KV                 | AI limit flags and the platform disabled marker        |
| `SEND_EMAIL`           | send_email         | Account-level outbound mail                            |
| `JWT_SECRET`           | Secret             | HMAC/JWT verification                                  |
| `EMAIL_SIGNING_SECRET` | Secret             | Email request proofs, credential leases, and receipts  |
| `CF_ACCOUNT_ID`        | Secret             | Cloudflare account ID                                  |
| `CF_API_TOKEN`         | Secret             | Fallback REST API access                               |

| Var                   | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `EMAIL_SENDER_DOMAIN` | Platform mail zone for this environment (no code default) |

## Deploy

```bash
vp run --filter @voidcloud/proxy deploy --env production
vp run --filter @voidcloud/proxy deploy --env staging
```

For a full hosted-platform deployment from the repository root, run
`vp run --filter @voidcloud/platform deploy` or
`vp run --filter @voidcloud/platform deploy:staging`. The commands above deploy
only the proxy Worker.

## Tests

- `test/unit/proxy.test.ts` — auth, CORS, AI routes, revalidation
- `test/unit/dispatch.test.ts` — dispatch fast path and fallback behavior
- `test/unit/resolve.test.ts` — internal resource resolution cache
- `test/unit/d1.test.ts` — D1 query and batch behavior
- `test/unit/kv.test.ts` — KV operations
- `test/unit/r2.test.ts` — R2 operations
- `test/unit/email.test.ts` — wrangler binding/var coverage per env, sender-domain threading, suspension gates, inbound dispatch limits
