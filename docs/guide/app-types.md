---
outline: deep
---

# Supported App Types

Void supports three types of apps:

1. **Void apps:** Vite apps powered by Void's framework layer, including [API routes](./server-routing.md), [pages mode](./pages-routing/overview.md), [auth](./auth.md), [crons](./jobs.md), and [queues](./queues.md)
2. **Meta frameworks:** [TanStack Start](https://tanstack.com/start/latest), [React Router](https://reactrouter.com/), [SvelteKit](https://svelte.dev/docs/kit), [Nuxt](https://nuxt.com/), and [Astro](https://astro.build/)
3. **Static sites:** SPAs, sites built with tools like [VitePress](https://vitepress.dev/), or any directory of static files

The type is auto-detected from your project structure, or you can set it explicitly in [`void.config.ts`](../reference/config.md).

## Void Apps

In a Void app, Void handles server routing and deployment. Use React, Vue, Svelte, or Solid for server-rendered pages, or build a frontend with any library that works with Vite.

A Void app can be **API-only** (just `routes/`), a **SPA + API** (frontend in `src/` with API routes), or **full-stack with pages mode** (server-rendered pages in `pages/` with co-located data loading):

<VoidAppFileTree annotations />

Void serves API routes, page rendering, and optional [custom SSR](./ssr.md) alongside static assets. Resources such as D1, KV, and R2 are [inferred from your code](../reference/resource-inference.md) and provisioned when you deploy.

Void apps can also use [`output: 'static'`](./ssg.md) to pre-render all pages at build time. That gives you a fully static site that can be deployed anywhere, with no Cloudflare Worker required.

**Deploy:** `void deploy` builds the app, provisions resources, applies migrations, and uploads it to your saved Cloudflare or Void target. See [Deployment](./deployment.md) for setup.

## Meta Frameworks

Void supports deploying Vite-based meta-framework apps with `void deploy`. The framework owns routing and SSR. Void handles [binding inference](../reference/resource-inference.md), [typed DB queries](./database.md), migrations, and deployment.

| Framework                                           | Detected from package        | Setup guide                                           |
| --------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| [TanStack Start](https://tanstack.com/start/latest) | `@tanstack/react-start`      | [Guide](../integrations/frameworks/tanstack-start.md) |
| [React Router v7](https://reactrouter.com/)         | `@react-router/dev`          | [Guide](../integrations/frameworks/react-router.md)   |
| [SvelteKit](https://svelte.dev/docs/kit)            | `@sveltejs/kit`              | [Guide](../integrations/frameworks/sveltekit.md)      |
| [Nuxt](https://nuxt.com/)                           | `nuxt`                       | [Guide](../integrations/frameworks/nuxt.md)           |
| [Analog](https://analogjs.org/)                     | `@analogjs/platform`         | [Guide](../integrations/frameworks/analog.md)         |
| [Astro](https://astro.build/)                       | `astro`                      | [Guide](../integrations/frameworks/astro.md)          |
| [pracht](https://pracht.resynapse.dev/)             | `@pracht/adapter-cloudflare` | [Guide](../integrations/frameworks/pracht.md)         |

Add `voidPlugin()` to the framework's Vite config to get binding inference, typed DB generation, migration management, cron jobs, queues, and caching. Void-managed auth is not supported in framework mode; use Better Auth's official integration for your framework. See the [Meta Frameworks Integration](../integrations/frameworks/overview.md) for supported features and setup guides.

## Pre-built Static Sites

Any project that produces static files, whether that is an SPA, a static site, or a plain directory. Void serves the assets without requiring application code.

**SPAs** (client-side single-page apps) serve `index.html` with a 200 status for paths that match no file, so client-side routing works out of the box. On a Void platform, missing files under the hashed assets folder (`/assets/`) return 404 instead. Detected when `vite` is a dependency and no backend files exist.

**Static sites** (static site generators like VitePress, Docusaurus, or any pre-built directory) produce per-page HTML files. Detected when a known SSG is a dependency, or when using the `--dir` flag.

At the edge, the resolution order is:

1. Exact file path (`/styles.css` → `styles.css`)
2. Nested index (`/about` → `about/index.html`)
3. `404.html` with **status 404** (if the file exists)
4. Plain 404 response

**Deploy:** `void deploy` or `void deploy --dir <path>` uploads static files directly. Assets are served from the edge with automatic caching.

## Adding a backend to a static site

If you add API routes to a static site generator, tell Void whether to deploy the backend too. Auto-detection sees both the SSG dependency and backend files, and stops until you set `inference.appType`.

To deploy both, set `appType` to `"void"` and build the static site before the Void app:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  inference: {
    appType: 'void',
    build: 'vitepress build && vite build',
  },
});
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
  // The SSG's output becomes the static assets of the Void build.
  publicDir: '.vitepress/dist',
});
```

`vitepress build` emits the site, then `vite build` copies `publicDir` into `dist/client` and emits the worker into `dist/ssr`. Keep `voidPlugin()` in the **root** `vite.config.ts` only — not in the generator's own config (e.g. `.vitepress/config.ts`).

The Worker handles unmatched requests. Set [`routing.notFound`](../reference/config.md#routing-notfound) to serve the generator's `404.html` for those requests:

```json
{ "routing": { "notFound": "404-page" } }
```

To deploy only the static output, set:

```json
{ "inference": { "appType": "static" } }
```

## Explicit Configuration

To lock the app type and skip auto-detection, set `inference.appType` in [`void.config.ts`](../reference/config.md):

```json
{
  "inference": {
    "appType": "static",
    "outputDir": ".vitepress/dist"
  }
}
```

- `inference.appType`: `"void"`, `"framework"`, `"spa"`, or `"static"`
- `inference.outputDir`: output directory for static app types (relative to project root, defaults to `"dist"`)
