---
description: 'Prerender every page at build time by setting the static output mode in void.config.ts.'
outline: deep
---

# Static Site Generation (SSG)

Set `output: "static"` in `void.config.ts` to prerender all pages at build time:

```json
{
  "output": "static"
}
```

When `output` is `"static"`:

- Pages default to `prerender = true` and are written as HTML files to `dist/client/`.
- Use `export const prerender = false` in a page's `.server.ts` to opt out. That page will be server-rendered on request.
- Dynamic pages without `getPrerenderPaths()` are implicitly not prerendered (the paths aren't known at build time).
- The build output is self-contained and works for direct Cloudflare deployment, self-hosting, or `void deploy`.

## Trailing slashes and directory indexes

For hosts such as GitHub Pages, enable trailing-slash Pages URLs and directory-style HTML output:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  output: 'static',
  routing: { trailingSlash: true },
});
```

Void writes `/posts/` to `posts/index.html` and `/posts/hello/` to `posts/hello/index.html`. Use trailing slashes in your links; generated route types follow this setting. In development and when served by Void, URLs without the slash redirect to it. API URLs stay the same.

The default is `false`, which writes `posts.html`. The error page stays at `404.html` in either mode.

On Cloudflare, use default HTML handling or `force-trailing-slash`, rather than `drop-trailing-slash`. Third-party frameworks use their own URL settings.

## Per-page overrides

Individual pages can opt out of prerendering:

```ts
// pages/dashboard.server.ts
export const prerender = false;
```

For dynamic pages, return the paths to render from `getPrerenderPaths()`. Annotate the return type with [`PageParams`](../reference/api/types.md#route-types) to check the parameter names:

```ts
// pages/blog/[slug].server.ts
import type { PageParams } from 'void/routes';

export async function getPrerenderPaths(): Promise<PageParams<'/blog/[slug]'>[]> {
  return [{ slug: 'hello-world' }, { slug: 'getting-started' }];
}
```

Return every required parameter as a string or number. Void URL-encodes the values. For a value containing `/`, use a catch-all page such as `pages/docs/[...slug]` with `{ slug: 'guides/intro' }`.

TypeScript needs the annotation above to check the keys. Invalid entries stop the build with their server filename and index.

## 404 pages

Static builds that prerender at least one page include a default `404.html` in `dist/client/`. To provide your own, add `public/404.html` or prerender a page at `/404`.

Fully static Void deployments serve this page for missing URLs with an HTTP 404 status by default. You can override this with [`routing.notFound`](../reference/config.md#routing-notfound). Hybrid deployments handle missing URLs in the Worker.

When hosting `dist/client/` yourself, configure your host to serve `404.html` with a 404 status for missing pages.

## Comparison with edge prerendering

| `output` value       | Default prerender | Per-page override                | Prerender timing           |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR) |
| `"static"`           | `true`            | `export const prerender = false` | Build or deploy post-build |

With the default `output: "server"`, use `export const prerender = true` for deploy-time [edge prerendering](./edge/prerendering.md).

## Deployment behavior

`void deploy` chooses the deployment automatically:

- **Fully static:** every page is prerendered, with no API routes, middleware, cron jobs, or queues. Void deploys the built files as a static site.
- **Hybrid:** some pages need server rendering, such as a dynamic page without `getPrerenderPaths()` or a page with `prerender = false`. Void deploys a Worker for those routes and serves prerendered pages as static assets.

On direct Cloudflare deployments, static files can bypass the Worker:

- Fully static apps serve files directly. [Edge rules](./edge/headers.md), including `_headers` or `_redirects` in `public/`, require a small Worker on every request.
- Hybrid apps serve prerendered pages directly when they have no `.server.ts` companion. API routes, dynamic pages, and pages with server companions run in the Worker.

Every page uses the Worker if the app has middleware, auth, live updates, edge rules, a custom Vite `base`, a `routing.notFound` value other than `"none"`, or a dynamic page at the root of `pages/`, such as `pages/[slug].vue`. With these settings, prerendered requests also run through the Worker.

## Relationship to `inference.appType: "static"`

The `inference.appType` field describes app type (SPA, static, void), while `output` controls rendering strategy:

|              | `inference.appType: "static"`                   | `output: "static"`                            |
| ------------ | ----------------------------------------------- | --------------------------------------------- |
| **What**     | Deploy a pre-built static site (no Void plugin) | Prerender a Void app at build time            |
| **Worker**   | None (static assets only)                       | Only for server code and edge rules           |
| **Use case** | VitePress, plain HTML, external SSG tools       | Void apps with mostly or fully static content |
