---
outline: deep
---

# Pages Routing

Put UI components in `pages/` to make them routes. A page's server loader returns data, and the component receives it as props. This pattern is inspired by [Inertia.js](https://inertiajs.com/) and works with React, Vue, Svelte, and Solid.

Pages mode starts when a `pages/` directory exists. It can live alongside `routes/`: use pages for UI and routes for APIs. Page components normally run on the server for the first render and in the browser for navigation and interaction.

You can also use your own client-side router and call Void's APIs with [typed fetch](../typed-fetch.md). Pages mode is optional.

## Setup

In an empty project, `void init` can set up Pages for you. Choose Vite+ or plain Vite, then React, Vue, Svelte, or Solid and a database or static starter. The generated app includes the matching Vite config and page files.

If you're adding Pages mode manually, install a framework adapter alongside `void`:

::: code-group

```sh [React]
npm install @void/react
```

```sh [Vue]
npm install @void/vue
```

```sh [Svelte]
npm install @void/svelte
```

```sh [Solid]
npm install @void/solid
```

:::

Add both plugins to your Vite config:

::: code-group

```ts [React]
// vite.config.ts
import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

```ts [Vue]
// vite.config.ts
import { voidVue } from '@void/vue/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

```ts [Svelte]
// vite.config.ts
import { voidSvelte } from '@void/svelte/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

```ts [Solid]
// vite.config.ts
import { voidSolid } from '@void/solid/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

:::

Each adapter includes its framework's Vite plugin. Pass framework plugin options via `voidReact({ react: { ... } })`, `voidVue({ vue: { ... } })`, `voidSvelte({ svelte: { ... } })`, or `voidSolid({ solid: { ... } })` if needed.

## Directory Structure

Pages can be flat files such as `about.vue` or directory-based routes such as `about/index.vue`. Both map to the same route:

<PagesFileTree />

Use one page file per URL in each environment.

Pair a page with a `.server.ts` file for server code, such as `about.server.ts` for `about.vue`. Companions also support `.js`, `.mts`, `.mjs`, and [JSX](../server-routing.md#jsx-handlers) with `.tsx` or `.jsx`. They can export:

- A [**loader**](./loaders), which runs on `GET` and returns the data that becomes the page component's props
- [**Actions**](./actions-and-forms), which handle mutations from forms and programmatic calls. Export a single `action` or multiple [named actions](./actions-and-forms#named-actions) when a page has several mutations
- `ssr = false` to opt a route out of server-rendered component HTML while keeping server loaders and client-side routing

File-based routing rules are the same as [server routing](../server-routing.md): `[param]` for dynamic segments, `[...param]` for catch-all, `(group)/` for route groups, and a `.dev` or `.prod` suffix for [environment-only pages](#environment-only-pages).

### Environment-only pages

Add a `.dev` or `.prod` suffix before the extension to choose when a page is available:

```
pages/
  about.tsx       →  /about, always
  debug.dev.tsx   →  /debug, development only
  stats.prod.tsx  →  /stats, production only
  home.dev.tsx    →  /home in development
  home.prod.tsx   →  /home in production
```

`.dev` pages run only on the dev server; `.prod` pages run in builds, deployments, and production previews.

Keep the suffix in companion filenames (`home.dev.server.ts`) and place it before `.island` for island pages (`chart.dev.island.tsx`). Layouts are shared across environments.

Production deploys exclude resources used only by `.dev` pages and their companions. Run `void prepare` to generate types for both environments.

## How Navigation Works

The first request receives rendered HTML. Later navigations run the loader and update the page without reloading the document. Form submissions run an action, then refresh page props or redirect.

To opt a specific route out of server-rendered component HTML, export `ssr = false` from its companion `.server.ts` file:

```ts
// pages/dashboard.server.ts
import { defineHandler } from 'void';

export const ssr = false;

export const loader = defineHandler(async () => {
  return { title: 'Dashboard' };
});
```

The loader still runs on the first request, and its props are embedded in the HTML shell. The page component mounts in the browser instead of hydrating server-rendered markup.

Render and prerender flags combine like this:

| Page exports                           | Behavior                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `ssr` unset or `true`                  | Server-render component HTML on request.                                  |
| `ssr = false`                          | Return a client-mounted shell on request.                                 |
| `ssr = false` + `prerender = true`     | Prerender a client-mounted shell with embedded loader data.               |
| `ssr = false` + `prerender = false`    | Return the client-mounted shell only on request; never prerender it.      |
| Island page + `ssr = false`            | Invalid. Island pages already use the island renderer.                    |
| `output: "static"` + `prerender` unset | Auto-prerender pages that have known paths, including client-only shells. |

### Typed navigation

Use the `Link` component for SPA navigation between pages. Build dynamic URLs with [`routeUrl()`](../type-safety.md#typed-urls-and-navigation) to check the route pattern and its parameters:

::: code-group

```tsx [React]
import { Link } from "@void/react";
import { routeUrl } from 'void/routes';

<Link href="/users">Users</Link>
<Link href={routeUrl('/users/:id', { params: { id } })}>View</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from '@void/vue';
import { routeUrl } from 'void/routes';
</script>

<template>
  <Link href="/users">Users</Link>
  <Link :href="routeUrl('/users/:id', { params: { id } })">View</Link>
</template>
```

```svelte [Svelte]
<script>
  import { Link } from "@void/svelte";
  import { routeUrl } from 'void/routes';
</script>

<Link href="/users">Users</Link>
<Link href={routeUrl('/users/:id', { params: { id } })}>View</Link>
```

```tsx [Solid]
import { Link } from "@void/solid";
import { routeUrl } from 'void/routes';

<Link href="/users">Users</Link>
<Link href={routeUrl('/users/:id', { params: { id } })}>View</Link>
```

:::

With [`routing.typedRoutes`](../type-safety.md#checked-url-strings), which apps created with `void init` have on, `href` and the router methods below reject plain strings such as `"/user"` that don't match a route.

`Link` also supports query data, history replacement, full-page navigation, and cancellation:

```tsx
<Link href="/users" data={{ page: 2, tag: ['active', 'new'] }}>
  Filtered users
</Link>

<Link href="/users" replace>
  Users
</Link>

<Link href="/logout" reloadDocument>
  Sign out
</Link>

<Link
  href="/settings"
  onNavigate={(event) => {
    if (!confirm('Leave this page?')) {
      event.preventDefault();
    }
  }}
>
  Settings
</Link>
```

`prefetch` and `reloadDocument` work only with GET links. GET `data` becomes query parameters; use scalar values or arrays.

For programmatic navigation, use `useRouter()`. Pass a typed destination object to `visit()`, `prefetch()`, or `flush()`:

```ts
import { useRouter } from '@void/vue'; // or "@void/react", "@void/svelte", "@void/solid"
import type { RouteDestination } from 'void/routes';

const router = useRouter();
const profile = {
  pathname: '/users/:id',
  params: { id: 42 },
  query: { tab: 'activity' },
} satisfies RouteDestination;

await router.prefetch(profile);
await router.visit(profile);
router.flush(profile); // clear its prefetched data
router.refresh(); // re-fetch current page props, keeping the same history entry
router.visit('/logout', { method: 'POST' }); // non-GET navigation
```

You can also pass URL strings or `URL` instances to these router methods. See [Typed URLs and Navigation](../type-safety.md#typed-urls-and-navigation) for query values, fragments, and catch-all routes.

`router.visit()` updates the page in place for same-origin URLs. `http(s)` URLs on another origin get a full page load, and other schemes such as `javascript:` are rejected.

For dynamic route params, use `useParams()` from the same adapter package:

```tsx
import { useParams } from '@void/react';

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  return <h1>Post {id}</h1>;
}
```

## Scroll Restoration

Void manages scroll position for Pages automatically:

- **Back/forward navigation and reloads** restore the saved scroll position.
- **New navigation** scrolls to the top of the page.
- **Hash links** (`/docs#api`) scroll to the target element. Same-page hash links (`#section`) skip the server fetch entirely.

To keep the current scroll position, pass `preserveScroll: true`:

```ts
router.visit('/users', { preserveScroll: true });
```

`Link` also accepts `preserveScroll`:

::: code-group

```tsx [React]
<Link href="/users" preserveScroll>
  Users
</Link>
```

```vue [Vue]
<Link href="/users" preserve-scroll>Users</Link>
```

```svelte [Svelte]
<Link href="/users" preserveScroll>Users</Link>
```

```tsx [Solid]
<Link href="/users" preserveScroll>
  Users
</Link>
```

:::
