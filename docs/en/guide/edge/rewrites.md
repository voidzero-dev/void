---
outline: deep
---

# Rewrites

A rewrite serves a route at a different URL without changing the browser's address. For example, `/docs` can serve `/en/docs`. Use a [redirect](./redirects) when the browser should move to the destination instead.

Define rewrites in [`void.config.ts`](../../reference/config):

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: {
    rewrites: {
      '/': '/en',
      '/docs': '/en/docs',
      '/docs/*': '/en/docs/:splat',
    },
  },
});
```

A request to `/docs/getting-started` serves `/en/docs/getting-started`. Other locales, such as `/ja/docs/getting-started`, keep their own routes.

## Rules

- Sources and destinations start with `/`. Destinations must be paths within the app.
- `*` matches any characters, including `/`. Use `:splat` in the destination for the matched portion.
- The first matching rule wins. Put specific patterns before catch-all patterns.
- Rewrites run before static assets and application routes.

## Programmatic rewrites in middleware

Use `c.rewrite()` when the destination depends on the request, such as a locale chosen from a cookie:

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  if (c.req.path.match(/^\/(en|ja)(\/|$)/)) return next();

  const locale = detectLocale(c.req);
  return c.rewrite(`/${locale}${c.req.path}`);
});
```

Return the result of `c.rewrite()`. Middleware runs again at the destination, so skip paths that are already rewritten to avoid a loop. Use `c.isRewritten()` to skip work that should happen only once:

```ts
if (c.isRewritten()) return next();
```

Keep access checks on any destination that needs them.

A destination without `?` preserves the incoming query string. `c.rewrite('/search')` keeps `?q=...`, while `c.rewrite('/search?q=all')` replaces it.

Your editor suggests known routes through the [`RewriteDestination`](../../reference/api/rewrites.md#rewritedestination) type. Dynamic strings are also accepted.

### Runtime rewrites cannot reach static assets

`c.rewrite()` targets application routes. To serve an asset such as `/hero.png` at another URL, use `routing.rewrites` or a `_redirects` rule instead. A middleware rewrite to a recognized asset extension throws `VoidAssetRewriteError`.

## Original URL access

`c.originalUrl()` returns the URL requested before a static or middleware rewrite, or `null` when no rewrite occurred. Use it for canonical links or locale detection:

```ts
import { defineHandler } from 'void';

export default defineHandler((c) => {
  const original = c.originalUrl();
  return c.json({ pathname: original?.pathname ?? c.req.path });
});
```

## Fallbacks

`routing.fallbacks` uses the same patterns as rewrites, but applies only when no asset or route matches:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: {
    fallbacks: { '/*': '/index.html' },
  },
});
```

Use a fallback for a client-side router or a default-locale catch-all. An intentional `404` from a Void route remains a `404`. For third-party frameworks, fallbacks can also replace the framework's `404` response.

SPA apps already fall back to `/index.html`. Custom fallback rules run first; unmatched paths still use the SPA shell. You don't need to add `'/*': '/index.html'` yourself.

## `_redirects` file

You can also place rules in Vite's `publicDir`, which defaults to `public/`:

```text
# Fallback: only when no asset or route matches
/*         /index.html     200

# Rewrite: before assets and routes
/docs/*    /en/docs/:splat  200!
```

The file can include [3xx redirects](./redirects) too. Rules in `void.config.ts` take precedence over file rules; within each group, the first match wins.

## Client navigation

Rewrites run on the server. In Pages mode, a client-side `<Link href="/docs">` navigation may fetch loader data for `/docs` rather than the rewritten route `/en/docs`.

Use `<a href="/docs">` to make a full server request when the destination has a different loader. Use a redirect if the URL should change.

## ISR cache keys with rewrites

Purge the destination path, such as `/en/docs/foo`, to clear rewritten cache entries. See [Cache keys and rewrites](./revalidation#cache-keys-and-rewrites).

## Debugging with `X-Void-Routing`

During development, inspect the `X-Void-Routing` response header in your browser's Network tab. It shows the matching rule and where it was declared:

```text
X-Void-Routing: rewrite[/docs/*] -> /en/docs/:splat (void.config.ts#routing.rewrites)
X-Void-Routing: c.rewrite -> /new-path (middleware)
X-Void-Routing: pass-through
```
