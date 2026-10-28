---
outline: deep
---

# Edge Prerendering

Prerender pages at deploy time so the first visitor receives cached HTML.

- [Markdown pages](../pages-routing/markdown.md) are auto-prerendered.
- [Island pages](../pages-routing/islands) with no companion loader and no dynamic params are also auto-prerendered.

## Static pages (no params)

Export `prerender = true` from the companion `.server.ts` file:

```ts
// pages/about.server.ts
export const prerender = true;
```

Pages without dynamic params do not need `getPrerenderPaths()`.

## Dynamic pages (with params)

For pages with URL params, also export `getPrerenderPaths()` to specify which param combinations to prerender:

```ts
// pages/blog/[slug].server.ts
export const prerender = true;

export async function getPrerenderPaths() {
  // Return param objects matching the URL pattern
  return [{ slug: 'hello-world' }, { slug: 'getting-started' }];
}
```

## Custom SSR

In custom SSR mode (`src/main.ssr.ts`), export `getPrerenderPaths()` at the top level. Since there's no file-based routing, return full path strings:

```ts
// src/main.ssr.ts
export const prerender = true;

export async function getPrerenderPaths() {
  return ['/', '/about', '/blog/hello-world'];
}
```

## Relationship to revalidation

Setting `routing.isr: false` in `void.config.ts` disables ISR and this edge-prerendering behavior, including per-page exports. It does not disable build-time HTML generation with `output: "static"`.

Prerendered pages default to a one-year revalidate TTL. Deploys clear the ISR cache.

Override the TTL per page:

```ts
// pages/about.server.ts
export const prerender = true;
export const revalidate = 3600;
```

If the cached page expires before your next deploy, the next request waits for a fresh render.

## Behavior details

- Prerender happens once per deployment, before traffic is routed to the new version. Prerendered pages are cached at the edge.
- Only paths with a positive revalidate TTL are prerendered (TTL `0` is skipped).
- Prerender failures are logged but never block the deploy. The page will render on the first request as usual.
