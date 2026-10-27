---
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

## Per-page overrides

Individual pages can opt out of prerendering:

```ts
// pages/dashboard.server.ts
export const prerender = false;
```

Dynamic pages with `getPrerenderPaths()` are prerendered for the returned param combinations:

```ts
// pages/blog/[slug].server.ts
export async function getPrerenderPaths() {
  return [{ slug: 'hello-world' }, { slug: 'getting-started' }];
}
```

## Comparison with edge prerendering

| `output` value       | Default prerender | Per-page override                | Prerender timing           |
| -------------------- | ----------------- | -------------------------------- | -------------------------- |
| `"server"` (default) | `false`           | `export const prerender = true`  | Deploy-time (platform ISR) |
| `"static"`           | `true`            | `export const prerender = false` | Build or deploy post-build |

With the default `output: "server"`, use `export const prerender = true` for deploy-time [edge prerendering](./edge/prerendering.md).

## Deployment behavior

`void deploy` chooses the deployment automatically:

- **Fully static:** if every page is prerendered and there are no API routes, middleware, cron jobs, or queues, Void deploys as a pure static site with no worker.
- **Hybrid:** if any pages are not prerenderable, such as dynamic pages without `getPrerenderPaths()` or pages with `export const prerender = false`, a worker is deployed to handle those routes at runtime. Prerendered pages are still served as static assets.

## Relationship to `inference.appType: "static"`

The `inference.appType` field describes app type (SPA, static, void), while `output` controls rendering strategy:

|              | `inference.appType: "static"`                   | `output: "static"`                            |
| ------------ | ----------------------------------------------- | --------------------------------------------- |
| **What**     | Deploy a pre-built static site (no Void plugin) | Prerender a Void app at build time            |
| **Worker**   | None (static assets only)                       | Only if some pages can't be prerendered       |
| **Use case** | VitePress, plain HTML, external SSG tools       | Void apps with mostly or fully static content |
