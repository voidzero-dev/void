---
outline: deep
---

# Rewrites {#rewrites}

URL rewrites re-dispatch a request at a different internal path without changing the browser's URL. `c.rewrite()`, `c.originalUrl()`, and `c.isRewritten()` are available on every Hono `Context` the Void runtime hands you. See the [Rewrites guide](../../guide/edge/rewrites.md) for the full overview, including static `routing.rewrites` / `routing.fallbacks` in [`void.config.ts`](../config.md#routing).

## `c.rewrite(destination)` {#c-rewrite-destination}

Re-dispatches the current request at `destination` and returns the resulting `Response`. The browser URL does not change — this is a server-side hop. If `destination` has no query string, the original request query is preserved. If `destination` includes a query string, it replaces the original query. `destination` must start with `/`; known generated routes autocomplete via [`RewriteDestination`](#rewritedestination), while arbitrary strings remain accepted for dynamic paths.

`c.redirect()` also preserves request query params for internal destinations, but it merges rather than replaces: destination params win on collision, and request-only params are appended. On a request to a [named action](../../guide/pages-routing/actions-and-forms.md#named-actions), the action key (`?delete` in `POST /users/42?delete`) is not carried over, whether the action or middleware redirects. A redirect after which the browser sends the same request again keeps it: `307` and `308`, and `301` or `302` after a `PUT`, `PATCH` or `DELETE`.

```ts
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  const locale = c.req.header('accept-language')?.startsWith('de') ? 'de' : 'en';
  return c.rewrite(`/${locale}${new URL(c.req.url).pathname}`);
});
```

**Signature:**

```ts
interface CloudContext {
  rewrite(destination: RewriteDestination): Promise<Response>;
}
```

**Caveats:**

- `destination` must start with a single `/` and point at an internal path. External URLs, protocol-relative destinations (`//host/...`), and anything non-path-absolute throw immediately — use `fetch()` for cross-origin calls.
- Destinations whose final path segment ends in a known static-asset extension (e.g. `/hero.png`, `/app.css`, `/data.json`) throw `VoidAssetRewriteError` (exported from `"void"`) before the re-dispatch. Runtime rewrites cannot reach assets — use a static `routing.rewrites` rule or a `_redirects` `200!` entry. `.html` is deliberately excluded from this guard because `.html` paths may be legitimate route handlers. See [Rewrites](../../guide/edge/rewrites.md#runtime-rewrites-cannot-reach-static-assets).
- Middleware re-runs on every rewrite hop. Guard side-effects with [`c.isRewritten()`](#c-originalurl-c-isrewritten).
- Client-side SPA navigation via `Link` does not trigger server rewrites; only full HTTP requests do.
- Purge the destination path to clear rewritten [ISR entries](../../guide/edge/revalidation.md#cache-keys-and-rewrites).

## `c.originalUrl()` / `c.isRewritten()` {#c-originalurl-c-isrewritten}

Context methods for inspecting rewrite state. `c.originalUrl()` returns the pre-rewrite URL as a `URL` object, or `null` on the first, non-rewritten hop. `c.isRewritten()` returns `true` on any re-dispatched context and `false` on the original. Use them for both static and middleware rewrites.

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (!c.isRewritten()) {
    // Only log the user-visible request, not internal rewrite hops.
    console.log(`${c.req.method} ${c.req.path}`);
  }
  await next();
});
```

**Signature:**

```ts
interface CloudContext {
  originalUrl(): URL | null;
  isRewritten(): boolean;
}
```

## `RewriteDestination` {#rewritedestination}

```ts
import type { RewriteDestination } from 'void/routes';
```

Suggests known route patterns in your editor while also accepting dynamic strings. Used as:

- The parameter type of [`c.rewrite()`](#c-rewrite-destination).
- The type of `destination` entries in `routing.rewrites` and `routing.fallbacks` in [`void.config.ts`](../config.md#routing).

Like [`RouteMap`](./types.md#routemap), `RewriteDestination` lives in the virtual `void/routes` module and is refreshed whenever routes change.
