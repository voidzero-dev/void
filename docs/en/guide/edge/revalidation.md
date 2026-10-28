---
outline: deep
---

# Revalidation (ISR)

Revalidation caches rendered pages and refreshes them in the background. When a cached page becomes stale, visitors can keep reading it while the Worker renders an updated version. This is often called [Incremental Static Regeneration (ISR)](https://vercel.com/docs/incremental-static-regeneration).

Use revalidation with [Void SSR](../ssr.md), [Pages mode](../pages-routing/overview), or a [supported SSR framework](../../integrations/frameworks/overview.md). For framework apps, Void caches public HTML document responses, not framework data requests.

To disable Void's ISR caching across the app while keeping your per-page settings, set `"routing": { "isr": false }` in `void.config.ts`. This overrides per-page revalidate and prerender policies. Set `isr` back to `true` to enable those policies again. Build-time HTML generation with `output: "static"` is unaffected.

## Enabling revalidation

Add a `routing.revalidate` field to `void.config.ts` with a TTL in seconds:

```json
{
  "routing": {
    "revalidate": 60
  }
}
```

Setting `revalidate` to `0` disables revalidation (equivalent to plain SSR).

## Per-path revalidation

You can set different TTLs for different URL patterns using an object:

```json
{
  "routing": {
    "revalidate": {
      "/": 60,
      "/docs/*": 31536000,
      "/user/*": 0,
      "*": 30
    }
  }
}
```

Rules are matched in order, and the first match wins. The `*` glob matches any characters including `/`.

Special values:

- `31536000` (1 year): effectively cached until the next deploy, since deploys clear the ISR cache
- `0`: never cached and always rendered by the worker, which is equivalent to plain SSR for that path

## Per-page revalidation (Pages mode)

In [Pages mode](../pages-routing/overview), you can export a `revalidate` value from a `.server.ts` file to override the global config for that page:

```ts
// pages/products/index.server.ts
export const revalidate = 120; // cache for 2 minutes

export const loader = defineHandler(async (c) => {
  // ...
});
```

Per-page values take precedence over `void.config.ts` patterns.

A page's `revalidate` export also applies to `routes/` handlers whose URLs match the page pattern. For example, if `pages/[...slug].server.ts` exports `revalidate`, Void can also cache the `GET` response of `routes/now.ts`. Void never caches paths under `/api`. To keep a route handler's response out of the cache, set `x-revalidate: 0` on it. See [Per-response TTL override](#per-response-ttl-override).

## Precedence

When multiple sources set a revalidate TTL, the most specific wins:

1. `x-revalidate` response header (per-response)
2. `.server.ts` export (per-page, Pages mode only)
3. `void.config.ts` `routing.revalidate` path pattern match
4. `void.config.ts` `routing.revalidate` global number or `"*"` fallback

## How revalidation works

The first request renders and caches the page. While the cached page is fresh, visitors receive it immediately. Once it becomes stale, Void serves it while rendering an updated version in the background.

A request without a cached entry waits for the page to render.

## Per-response TTL override

Route handlers can set the `x-revalidate` response header to override the TTL for a specific response:

```ts
export const GET = defineHandler(async (c) => {
  // Don't cache this particular response
  c.header('x-revalidate', '0');

  return c.html('...');
});
```

- `x-revalidate: 0`: skip caching for this response
- `x-revalidate: 300`: cache for 5 minutes instead of the default

Only complete `200` responses are cached. A response with `Cache-Control: private`,
`no-store`, or `no-cache`, or any `Set-Cookie` header, stays private to that request.
If a public page starts returning one of those headers, Void removes its cached response.

Responses that vary by request headers, such as `Vary: Accept-Language` or `Vary: Origin`, are rendered live. `Vary: *` also disables shared caching. Void's `X-VoidPages` header is supported because HTML and Pages JSON have separate cached responses.

## Cache bypass

Requests with `Cookie`, `Authorization`, or Cloudflare Access's `Cf-Access-Jwt-Assertion` header bypass the ISR cache entirely and always dispatch to the worker. Authenticated responses are not shared between users, including when Access authentication supplies no cookie.

## Cache keys and rewrites

For a dispatch rewrite, the cache key includes both the destination and original pathname. A direct request to `/en/docs/foo` therefore uses a different entry from `/docs/foo` rewritten to that destination.

Query parameters are excluded by default. Add `routing.revalidateQueryAllowlist` when specific parameters should produce separate cached responses. Requests with other query parameters get the cached page. If nothing is cached yet, they render live and are not stored, so add every parameter a page reads to `routing.revalidateQueryAllowlist`. Middleware `c.rewrite()` runs after the ISR lookup, so it doesn't create an additional cache variant.

Purge the destination pathname with `revalidate({ paths })`. Purging `/en/docs/foo` clears both direct and rewritten variants. Purging only `/docs/foo` won't clear them, because the entries are stored under the destination.

## On-demand revalidation

You can purge ISR cache entries programmatically from a route handler:

```ts
import { revalidate } from 'void/isr';

export const POST = defineHandler(async (c) => {
  // ... update content in database ...

  // Purge specific pages
  await revalidate({ paths: ['/', '/blog/hello-world'] });

  // Or purge all cached pages
  await revalidate({ all: true });

  return c.json({ ok: true });
});
```
