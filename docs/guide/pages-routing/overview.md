---
description: 'Turn files in pages/ into routes. A server loader returns data, and the page component receives it as props.'
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

Export `ssr` and `prerender` directly from `.server.ts` as `true` or `false`. Computed values and re-exports are ignored with a warning.

### Typed navigation

Use the `Link` component for SPA navigation between pages. Build dynamic URLs with [`routeUrl()`](../type-safety.md#typed-urls-and-navigation) to check the route pattern and its parameters:

::: code-group

```tsx [React]
import { Link } from "@void/react";
import { routeUrl } from 'void/routes';

<Link href="/users">Users</Link>
<Link href={routeUrl('/users/[id]', { params: { id } })}>View</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from '@void/vue';
import { routeUrl } from 'void/routes';
</script>

<template>
  <Link href="/users">Users</Link>
  <Link :href="routeUrl('/users/[id]', { params: { id } })">View</Link>
</template>
```

```svelte [Svelte]
<script>
  import { Link } from "@void/svelte";
  import { routeUrl } from 'void/routes';
</script>

<Link href="/users">Users</Link>
<Link href={routeUrl('/users/[id]', { params: { id } })}>View</Link>
```

```tsx [Solid]
import { Link } from "@void/solid";
import { routeUrl } from 'void/routes';

<Link href="/users">Users</Link>
<Link href={routeUrl('/users/[id]', { params: { id } })}>View</Link>
```

:::

Enable [`routing.typedRoutes`](../type-safety.md#checked-url-strings) to catch misspelled URLs in links and router calls. Apps created with `void init` already have it enabled.

`Link` also supports query data, history replacement, full-page navigation, and cancellation:

::: code-group

```tsx [React]
import { Link } from '@void/react';

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

```vue [Vue]
<script setup lang="ts">
import { Link } from '@void/vue';

function onNavigate(event: { preventDefault(): void }) {
  if (!confirm('Leave this page?')) {
    event.preventDefault();
  }
}
</script>

<template>
  <Link href="/users" :data="{ page: 2, tag: ['active', 'new'] }">Filtered users</Link>
  <Link href="/users" replace>Users</Link>
  <Link href="/logout" reload-document>Sign out</Link>
  <Link href="/settings" :on-navigate="onNavigate">Settings</Link>
</template>
```

```svelte [Svelte]
<script lang="ts">
  import { Link } from '@void/svelte';
</script>

<Link href="/users" data={{ page: 2, tag: ['active', 'new'] }}>Filtered users</Link>

<Link href="/users" replace>Users</Link>

<Link href="/logout" reloadDocument>Sign out</Link>

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

```tsx [Solid]
import { Link } from '@void/solid';

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

:::

`prefetch` and `reloadDocument` work only with GET links. GET `data` becomes query parameters; use scalar values or arrays.

After an update that changes the page-data format, open tabs reload on their next navigation.

For programmatic navigation, use `useRouter()`. Pass a typed destination object to `visit()`, `prefetch()`, or `flush()`:

```ts
import { useRouter } from '@void/vue'; // or "@void/react", "@void/svelte", "@void/solid"
import type { RouteDestination } from 'void/routes';

const router = useRouter();
const profile = {
  pathname: '/users/[id]',
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

For dynamic route params, use `useParams()` from the same adapter package. Pass the page's URL pattern as the type argument to type the result:

::: code-group

```tsx [React]
// pages/posts/[id].tsx
import { useParams } from '@void/react';

export default function PostPage() {
  const { id } = useParams<'/posts/[id]'>(); // { id: string }
  return <h1>Post {id}</h1>;
}
```

```vue [Vue]
<!-- pages/posts/[id].vue -->
<script setup lang="ts">
import { useParams } from '@void/vue';

const params = useParams<'/posts/[id]'>(); // { id: string }
</script>

<template>
  <h1>Post {{ params.id }}</h1>
</template>
```

```svelte [Svelte]
<!-- pages/posts/[id].svelte -->
<script lang="ts">
  import { useParams } from '@void/svelte';

  const params = useParams<'/posts/[id]'>(); // { id: string }
</script>

<h1>Post {params.id}</h1>
```

```tsx [Solid]
// pages/posts/[id].tsx
import { useParams } from '@void/solid';

export default function PostPage() {
  const params = useParams<'/posts/[id]'>(); // { id: string }
  return <h1>Post {params.id}</h1>;
}
```

:::

See [Page params](../type-safety.md#page-params) for how patterns are checked.

### Active links

`Link` marks the link to the current page with `aria-current="page"` and `data-void-active`. Use them to style navigation:

```css
nav a[data-void-active] {
  font-weight: 600;
}
```

A link is active only on its own path by default. Set `activeMatch="prefix"` to keep it active on nested pages:

::: code-group

```tsx [React]
<nav>
  <Link href="/">Home</Link>
  <Link href="/users" activeMatch="prefix">
    Users
  </Link>
</nav>
```

```vue [Vue]
<nav>
  <Link href="/">Home</Link>
  <Link href="/users" active-match="prefix">Users</Link>
</nav>
```

```svelte [Svelte]
<nav>
  <Link href="/">Home</Link>
  <Link href="/users" activeMatch="prefix">Users</Link>
</nav>
```

```tsx [Solid]
<nav>
  <Link href="/">Home</Link>
  <Link href="/users" activeMatch="prefix">
    Users
  </Link>
</nav>
```

:::

| Current URL     | `href="/users"` | `href="/users" activeMatch="prefix"` |
| --------------- | --------------- | ------------------------------------ |
| `/users`        | both attributes | both attributes                      |
| `/users?page=2` | both attributes | both attributes                      |
| `/users/42`     | none            | `data-void-active`                   |
| `/users-admin`  | none            | none                                 |

`aria-current="page"` marks only the exact page, so select `[aria-current="page"]` to style it differently from its section. A link to `/` is active only on the home page.

Query parameters let you distinguish pagination links from filter tabs. A link is active when the current URL contains all of its query parameters with the same values. Extra parameters and their order don't matter, and a GET link's `data` counts as part of its query:

| Current URL                  | Link                           | Active          |
| ---------------------------- | ------------------------------ | --------------- |
| `/posts?page=2`              | `href="/posts?page=1"`         | none            |
| `/posts?page=2`              | `href="/posts?page=2"`         | both attributes |
| `/issues?status=open&page=2` | `href="/issues?status=open"`   | both attributes |
| `/issues?status=open`        | `href="/issues?status=closed"` | none            |

On nested pages, `activeMatch="prefix"` compares only the path, so `href="/reports?range=30d"` has `data-void-active` on `/reports/42`.

Paths are case-sensitive and respect trailing slashes; hashes are ignored. External and non-GET links are never active.

To mark a default filter such as an "All" tab, set `aria-current` or `data-void-active` yourself. Your value overrides the computed one.

### Pending links

While a page loads, `Link` adds `data-void-pending` to every link to it. Use it to show that a click is being handled:

```css
a[data-void-pending] {
  opacity: 0.6;
  /* Skip visits that finish quickly, such as to a prefetched page */
  transition: opacity 0.15s 0.1s;
}
```

A pending link matches the destination's path, query, and hash. A link to `/users?page=2` won't show as pending while page 3 loads. Non-GET links also match the request method. During `router.refresh()`, links to the current page are pending.

A `data-void-pending` you pass to `Link` replaces the computed value. For a loading indicator that covers the whole page, use [`useNavigation()`](../../reference/api/pages.md).

### Prefetching

Add `prefetch` to a `Link` to load its page before the user clicks. This markup works in all four adapters:

```html
<Link href="/dashboard" prefetch>Dashboard</Link>
```

The page loads on hover, keyboard focus, or touch. The next visit can use the cached data. Use `cacheFor` to choose how long to reuse it.

For an app-wide default, set `prefetch.defaultStrategy` in your [adapter plugin](../../reference/api/pages.md#prefetching). A link's own `prefetch` value overrides it. Prefer `'hover'` or `'click'`; `'mount'` and `'visible'` can load many pages in a long list.

`Link` skips prefetching when the browser reports data saver or a 2G connection. Only Chromium-based browsers report these settings. See [Prefetching](../../reference/api/pages.md#prefetching) for all strategies and cache options.

Prefetching runs the destination's loader, so keep loaders free of side effects such as counting views.

## Scroll Restoration

Void manages scroll position for Pages automatically:

- **Back/forward navigation and reloads** restore the saved scroll position.
- **New navigation** scrolls to the top of the page.
- **Actions and forms** keep scroll when updating the current page. Redirects follow normal navigation behavior.
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
