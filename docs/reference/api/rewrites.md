---
outline: deep
---

# Rewrites {#rewrites}

URL rewrites re-dispatch a request at a different internal path without changing the browser's URL. `c.rewrite()`, `c.originalUrl()`, and `c.isRewritten()` are available on every Hono `Context` the Void runtime hands you. See the [Rewrites guide](../../guide/edge/rewrites.md) for the full overview, including static `routing.rewrites` / `routing.fallbacks` in [`void.config.ts`](../config.md#routing).

## `c.rewrite(destination)` {#c-rewrite-destination}

Re-dispatches the current request at `destination` and returns the resulting `Response`. The browser URL does not change — this is a server-side hop. If `destination` has no query string, the original request query is preserved. If `destination` includes a query string, it replaces the original query. `destination` must start with `/`; known generated routes autocomplete via [`RewriteDestination`](#rewritedestination), while arbitrary strings remain accepted for dynamic paths.

Pass a [`RouteDestination`](./types.md#route-types) object to check the route pattern and its parameters:

```ts
return c.rewrite({
  pathname: '/users/:id',
  params: { id: 42 },
  query: { tab: 'activity' },
});
```

With [`routing.typedRoutes`](../config.md#routing-typedroutes), a string destination must be a [`RouteUrl`](./types.md#route-types): a URL that matches one of your routes. Cast a path built at runtime, such as ``c.rewrite(`/${locale}${path}` as RouteUrl)``.

For a typed redirect, build the URL with [`routeUrl()`](./types.md#routeurl-path-options):

```ts
import { routeUrl } from 'void/routes';

return c.redirect(routeUrl('/users/:id', { params: { id: 42 } }));
```

`c.redirect()` merges request query parameters into internal destinations, with destination values taking precedence. Redirecting a [named action](../../guide/pages-routing/actions-and-forms.md#named-actions) to a GET page drops the action key: `POST /users/42?delete&tab=profile` redirects to `/users/42?tab=profile`. Redirects that preserve the request method keep the action key: `307` and `308`, or `301` and `302` after a `PUT`, `PATCH`, or `DELETE`.

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
  // RouteUrl instead of RewriteDestination with routing.typedRoutes
  rewrite(destination: RewriteDestination | RouteDestination): Promise<Response>;
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

- The parameter type of [`c.rewrite()`](#c-rewrite-destination), unless `routing.typedRoutes` is on.
- The type of `destination` entries in `routing.rewrites` and `routing.fallbacks` in [`void.config.ts`](../config.md#routing).

Like [`RouteMap`](./types.md#routemap), `RewriteDestination` lives in the virtual `void/routes` module and is refreshed whenever routes change.
