# Pages not-found and error boundaries

Status: implemented.
Related: [#752](https://github.com/voidzero-dev/void/issues/752).

## Goal and scope

Provide application not-found/error components using the existing layouts, CSS,
routing context, and available shared data across React, Vue, Svelte, and Solid.
Support initial documents, GET/HEAD navigation, and client rendering. Preserve
API endpoints, explicit middleware/authentication responses, redirects, form
transport, external framework integrations, asset fallbacks, and applications
without boundary files. Require no new Cloudflare binding or paid service.

## Files

Recognize `_not-found` and `_error` component files in ordinary Pages directories.
Support the adapter's extensions, including `.jsx` where supported. Leading
underscores preserve existing `/not-found` and `/error` routes. These files are
not routes and never enter typed route maps, ordinary matching, sitemaps, or
prerender path collection. Recognize `.dev`/`.prod` variants using ordinary
Pages environment selection; reject ambiguous definitions in one environment.

Files inside `_layouts` or any other ignored underscore directory remain ignored.
The two exact basenames are the only exception to the scanner's ignored-file
rule. Boundary files cannot be islands, export a `layout` selection, or have
`.server` companions/loaders/actions. Report unsupported combinations with the
source filename. Multiple supported component extensions for the same boundary
are an error, just as competing ordinary routes are; do not guess an adapter.

Include components and transitive imports/CSS in client/server manifests, dev
HMR, asset discovery, and production bundles. Adding/removing a file refreshes
boundary metadata. No implementation source-string assertions substitute for
real generated app execution in tests.

## Public contract

Export framework-neutral types from the existing public Pages type surface and
re-export from all four adapters:

```ts
export type PageError = Readonly<{ status: number; message: string }>;
export type ErrorPageProps = Readonly<{ error: PageError }>;
```

Both file kinds receive these props. A returned/not-matched 404 uses `Not Found`;
a thrown HTTP 404 may use its explicitly supplied public message. Unexpected
exceptions use status 500 and `Internal Server Error` in production; development
may expose the exception message. Never expose the original exception, stack,
cause, custom fields, failed loader props, or server context through error props
or framework-generated hydration data. Test raw HTML/scripts/payloads using
secret markers in all original error fields. Keep detailed server diagnostics.

Existing params/shared/router contexts work in ordinary interactive boundaries.
The URL is the failed destination. Shared is only the request-local value already
established by completed middleware. Do not rerun middleware/loaders/actions,
borrow another request's data, or serialize arbitrary context variables. If shared
or established head defaults cannot be serialized/rendered safely, immediately
use the standalone server fallback rather than repeating attempts with bad data.

Use existing `router.refresh()` for interactive retry. No new public callback,
resolver, registry, reset hook, or retry API. Server-only documents use ordinary
links or document GET reload; they do not gain a router just to offer retry.

## Classification and opt-in compatibility

Intercept responses only inside the Pages loader leaf, before its middleware
finishes wrapping the rendered result:

| Failure                                                               | With an applicable component     | Without one                              |
| --------------------------------------------------------------------- | -------------------------------- | ---------------------------------------- |
| Loader returns any Response with status 404, including `c.notFound()` | nearest `_not-found`, 404        | preserve the original response           |
| Loader throws HTTPException(404)                                      | nearest `_not-found`, 404        | preserve the exception response          |
| Loader/import/head/serialization/render unexpectedly throws           | nearest `_error`, 500            | existing server 500 handling             |
| Wholly unmatched HTML page URL after routing/assets fallbacks         | root `_not-found`, 404           | existing unmatched/static 404 handling   |
| Client render throws                                                  | nearest native `_error` boundary | existing handling if no boundary applies |
| Explicit non-404 Response or non-404 HTTPException                    | preserve existing handling       | same                                     |

Do not reinterpret redirects, downloads, API/assets requests, authentication,
rate limits, explicit 500 Responses, or responses returned/replaced by middleware
after `next()`. Catch unexpected exceptions at the loader/render operation, not
around the whole composed middleware chain. No `_not-found` means the original
404 path; do not silently use `_error` for a normal not-found result.

A middleware call to `c.notFound()` deliberately invokes Hono's app-level
not-found handler. With a root `_not-found`, that handler renders the root
boundary and returns it unchanged; this does not select the matched page's
nested boundary or run its loader. Explicit middleware 404 responses keep their
own body. This distinction applies before and after `next()`.

For wholly unmatched URLs, use only the root `_not-found`, root layout, empty
params, and already completed global middleware shared/head defaults. Do not
infer a dynamic directory, execute nearby route middleware, or fabricate params.
Nested not-found components apply to matched routes that produce a 404. This
avoids ambiguous partial routing through route groups and dynamic directories.

## Actions and deferred values

Preserve mutation transport, `submitAction()` results, form callbacks, and the
existing `VoidActionError` classification exactly. In particular, action 404 and
429 remain call-site errors; boundary-classified 401/403 and 5xx remain such.
Do not decode new server boundary payloads for non-GET mutations or introduce a
new success/failure outcome. Loader errors while rendering after a mutation keep
the current mutation path, including its standalone fallback, rather than
pretending the mutation failed or returning a successful 200 error page.

New native client boundaries can catch only errors that the adapter already
throws into rendering. Do not promise that an async event-handler rejection
reaches a native boundary. Do not change non-React action helpers to bridge such
errors as part of this feature. An action error belongs to the submitting view;
it must not navigate to the action target. A retry refreshes that view with GET,
without a named action query key, and never replays the mutation. Preserve legacy
client protection: an action executes once before a protocol-reload response.

Keep existing deferred APIs: React `use()` throws rejected promises; Vue, Svelte,
and Solid expose error-valued deferred state. Capture a failure when consuming
it actually throws during rendering; do not turn locally handled deferred error
state into an automatic page error. Errors from superseded navigations cannot
replace the active view.

## Layout ownership and render plans

Matched routes find boundary candidates by source-directory ancestry, including
route groups, independent of the URL spelling. Put a native client boundary at
each owning directory slot, inside that directory's layout and around its nested
content, even where the directory has no layout file. A layout's own failure
therefore reaches an ancestor boundary, not its own directory boundary.

Extend the existing effective-layout resolver with internal logical slots. A
normal layout owns its source directory. A named replacement inherits the slot
of the default layout it replaced, regardless of where `_layouts/name` lives.
An exclusive named layout, or a named layout without a default chain, occupies
the page's source-directory slot. `layout: false` keeps an empty chain. Never
mount default layouts excluded by the failed page's effective layout selection.

Render an error/not-found component with only effective layout slots at or above
its directory; exclude deeper slots. For server recovery the entire tree may
execute again, but middleware/loaders/actions do not. For client rendering,
retain outer layout instances and their state; reset only the failed subtree.

A boundary can have different effective layout chains for different source
pages. Compile a finite set of internal render plans, identified by opaque
build-local IDs, mapping source page/boundary to component and ordered layout
slots. Carry the selected plan ID in the Pages object; validate it against the
compiled manifest before importing/rendering. Do not accept arbitrary layout
IDs from the network or equate the boundary component ID with its render plan.
Keep these IDs/types internal and absent from public route maps.

A failed `_not-found` may use `_error` in the same directory. A failed `_error`
skips itself and escalates outward. A failure in an owning layout skips boundaries
inside that layout. If the exact failing source is unavailable during SSR, use
the bounded-attempt algorithm below instead of guessing its identity.

Example with root layout/error and items layout/error/not-found:

- Missing item: root layout > items layout > items not-found.
- Item loader/component fails: root layout > items layout > items error.
- Items layout or items error fails: root layout > root error.
- Root layout/root error fails: standalone server fallback or terminal browser UI.

## Server recovery and response commit

Adapters render one attempt from a completed Page object and selected render
plan. Native catch boundaries recover only in the browser; server wrappers may
reserve matching hydration identities but must rethrow every failure. They must
not serialize original exceptions through framework SSR/hydration helpers. Detect SSR failures
using an adapter error collector/outer render failure, including failures that a
framework would otherwise swallow and render as an empty successful document.

On failure before the adapter returns a ready shell, cancel/discard that attempt,
select the nearest eligible error plan, sanitize the exception, and render a fresh
attempt using the same completed shared/params snapshot. If the whole fallback
attempt fails (including a retained layout or import), move to the next outward
candidate. Attempt each candidate at most once. Do not wait for all deferred
values or buffer the complete React response. Root layout failure ultimately
exhausts candidates and serves the existing standalone 500 document.

The adapter's return of a ready shell is the recovery cutoff. After that point,
retain streaming semantics: never append a second document, restart SSR, or claim
to change committed status. Deferred failures follow the existing protocol and
client consumption rules. Guaranteed document 404/500 statuses apply only to
failures determined before this cutoff.

Respect `ssr: false`: do not execute browser-dependent page/layout components on
the server during boundary rendering. Send a status-correct client-only shell
with the selected error plan, then render it on client startup. Component-import
failure during bootstrap must enter recovery or terminal UI even before the app's
native boundary tree exists.

## Response protocol, headers and browser recovery

A GET boundary result returns 404/500 with a valid marked Pages payload, or a
normal HTML document with application CSS/asset tags and page data. HEAD returns
the same status/headers and no body. The payload selects a compiled render plan,
component, params, shared data and sanitized error props. Preserve the failing URL
and document history entry; do not navigate to an invented `/404` or `/error`.

Add a Pages protocol-version bump and keep the current legacy reload behavior.
Unknown plans/build mismatches use the protocol's safe reload path, never an
unvalidated import. Marked non-success GET payloads render in-app; unmarked HTML
responses keep existing full-navigation fallback behavior.

When replacing a returned loader 404, retain its applicable headers together
with middleware response headers, including Set-Cookie, authentication, and
security headers. Remove stale representation headers (Content-Length,
Content-Type, Content-Encoding, Content-Range, ETag, Last-Modified), replace
cache/Vary headers with the Pages/error contract, and preserve multiple cookies.
Do not rerun the failed page's head function. Use successfully established
middleware/config defaults and a deterministic fallback title (`Not Found` or
`Internal Server Error`) if no title exists; clear stale abandoned-page metadata.

Client recovery owns its navigation generation and attempted URL. Commit the
attempted destination when an active error view is shown, even if normal page
mount effects never ran. Ignore failures/late commits from superseded resources.
On `router.refresh()` bypass the client visited/prefetch cache for that request,
reset the failed subtree for the new generation, preserve outer layouts, and
prevent older background results from resurrecting it. This does not promise a
bypass of HTTP/CDN/ISR caches or force revalidation on every normal navigation.

If all client error components fail, or imports prevent mounting, show a minimal
framework-independent terminal browser view with text and ordinary links to
retry the current destination by document GET and go home. No automatic reload
loop, mutation replay, URL change to `/500.html`, or fetching/injecting arbitrary
HTML. Client failures cannot change the document's received HTTP status.

## Caches

Fetched boundary/error responses carry `Cache-Control: no-store` and are excluded
from visited/prefetch, static page-data, and ISR caches. A fetched error is shown
on explicit navigation; a successful cached response may still satisfy ordinary
navigation according to existing freshness rules. Do not silently change that
policy. Transient background error results do not replace usable client cache
entries; explicit refresh can surface an error. Evict cached data that caused a
client render crash so retry does not keep replaying it.

For Pages routes opting into these boundaries, deferred responses are no-store
from the outset, because a post-shell error cannot change HTTP cache admission.
Keep behavior unchanged for routes without applicable boundaries. Do not change
ISR's existing authoritative private/no-store or confirmed 404/410 removal rules;
its stale-while-revalidate policy is not a client boundary policy.

## Islands and static output

Preserve rendering mode. An island document's pre-commit failure may render a
boundary server-only with the same island-compatible effective layouts and the
same island serialization rules. Do not switch to the interactive Pages renderer,
serialize the entire shared object, hydrate formerly server-only layouts, or add
a Pages router. Server shared context is available while rendering; only existing
explicit island data reaches independent client roots. Retry uses ordinary links
or document GET reload. A failed independent island on an already loaded document
keeps its existing framework handling; root Pages boundaries cannot catch it.

For `output: 'static'`, generate a root `_not-found` as a dedicated server-only
404 artifact when no explicit 404 document exists. Do not route this through the
normal success-only prerender path or emit static page-data for it. It receives
empty props beyond the error, empty shared/params, a stable `/404` build URL, and
no request-dependent middleware. Its layout/component must be valid with that
build-time context. No hydration/Pages router is injected; unknown static URLs
keep document navigation. The browser address remains the host's original URL.

Preserve existing explicit-document behavior: prerendered `/404` output and
`public/404.html` both take precedence over automatic `_not-found` output; the
built-in document is last. This feature does not change conflicts between the
two existing explicit sources.
Boundary-artifact rendering failure fails the build. Preserve failures for all
ordinary prerendered routes; never publish a 500 document as a successful page.
Static files cannot guarantee HTTP status/cache headers on arbitrary hosts; host
configuration owns those. Native boundaries still protect interactive matched
static pages in the browser, without adding dynamic handling for unknown URLs.

## Implementation and verification

The implementation uses scanner inventories, logical layout slots and finite render
plans shared by the routing compiler and all four adapter manifests. Native client
boundaries preserve healthy layouts. Solid/Svelte server wrappers retain hydration
identity and rethrow every failure; recovery discards that complete server attempt
before trying an outer plan. Original exceptions never become hydration payloads.

Production integration coverage exercises all four adapters: status/protocol and
privacy, nested fallback/layout escalation, refresh, retained layout state, terminal
navigation, independent island hydration and static documents. React additionally
builds a boundary-only static app through native Cloudflare prerendering. Unit
regressions cover scanning, named layout slots, JSON decoding, exhausted fallbacks,
import recovery, version mismatch, cache retention and the private build endpoint.

The spec received two GPT-6 Astra High reviews; the second approved the design.
Implementation review tightened outward recovery, cache retention, hydration
identity, redirected navigation and development asset handling. Regression tests
exercise those cases through the production runtime and generated applications.
