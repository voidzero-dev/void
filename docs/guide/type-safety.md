---
outline: deep
---

# Type Safety

Void infers types from your database schema, route handlers, and page loaders. When you change a field, TypeScript shows which queries, requests, and components need to change.

## The Type Pipeline

<img src="./type-pipeline.svg" alt="Type pipeline: Drizzle schema flows to DB types, branching into route handlers (typed fetch), page loaders (component props), and page actions (useForm / action())" style="max-width: 720px; width: 100%;" />

1. **Database types** come from your [Drizzle schema](./database.md#schema-definition). Column types are known at compile time.
2. **Route handlers:** return types and validator schemas become the generated `RouteMap`, which the [typed fetch](./typed-fetch) client consumes.
3. **Page loaders:** return types flow into page components as props via `InferProps`.
4. **Page actions:** validator schemas flow into `useForm` and `action()` for typed data, errors, and URL autocomplete.

All generated types live in `.void/` and update automatically when source files or schema change.

## Database → Handler → Client

Types flow from your Drizzle schema through handlers to the client without any manual annotations:

```ts
// routes/api/users.ts
export const GET = defineHandler(async (c) => {
  return db.select({ name: users.name, email: users.email }).from(users);
  //     ↑ return type inferred from schema columns
});

export const POST = defineHandler.withValidator({
  body: insertUserSchema, // ← derived from Drizzle schema
})(async (c, { body }) => {
  return db.insert(users).values(body).returning();
});
```

```ts
// Client: types inferred from handlers above
const users = await fetch('/api/users');
//    ↑ { name: string; email: string }[]

await fetch('/api/users', {
  method: 'POST',
  body: { name: 'Alice', email: 'alice@example.com' }, // ← typed from validator
});
```

The Drizzle schema defines database columns, runtime validation, handler input types, and client-side type checking all at once. For endpoints that don't map to a table, use any [Standard Schema](./server-routing.md#manual-validators) library.

## Loader → Page Props

In [pages mode](./pages-routing/overview), a loader's return type flows into the page component via `InferProps`:

```ts
// pages/users/index.server.ts
export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  return { users: await db.select().from(users) };
});
```

::: code-group

```tsx [React]
// pages/users/index.tsx
import type { Props } from './index.server';

export default function UsersPage({ users }: Props) {
  // users: { id: number; name: string; ... }[]
}
```

```vue [Vue]
<!-- pages/users/index.vue -->
<script setup lang="ts">
import type { Props } from './index.server';

const { users } = defineProps<Props>(); // users: { id: number; name: string; ... }[]
</script>
```

```svelte [Svelte]
<!-- pages/users/index.svelte -->
<script lang="ts">
  import type { Props } from './index.server';

  let { users }: Props = $props(); // users: { id: number; name: string; ... }[]
</script>
```

```tsx [Solid]
// pages/users/index.tsx
import type { Props } from './index.server';

export default function UsersPage(props: Props) {
  // props.users: { id: number; name: string; ... }[]
}
```

:::

No manual interface is needed. Props stay in sync with whatever the loader returns.

## Action → useForm

When a page action uses `withValidator()`, the body schema flows through to `useForm`. That gives you typed `data`, typed `errors` keys, and URL autocomplete:

```ts
// pages/users/create.server.ts
export const action = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  await db.insert(users).values(body);
});
```

```ts
const form = useForm('/users/create', { name: '', email: '' });
//                    ^ autocompletes     ^ must match body schema

form.errors.email; // ✓ string | undefined
form.errors.foo; // ✗ TypeScript error
```

[Named actions](./pages-routing/actions-and-forms#named-actions) work the same way. The `?actionName` suffix selects the right types for that action:

```ts
const updateForm = useForm('/users/:id?update', { name: '' }, { params: { id } });
const deleteForm = useForm('/users/:id?delete', { id: '' }, { params: { id } });
// Each form's data and errors are typed from their respective validators
```

The `action()` helper gets the same type checking. See [Actions & Forms](./pages-routing/actions-and-forms) for the full API.

## Typed URLs and Navigation

Use `routeUrl()` from `void/routes` to build URLs from your app's page, HTTP, and WebSocket route patterns. For a page at `pages/users/[id].tsx`, `.vue`, or `.svelte`, the pattern is `/users/:id`:

```ts
import { routeUrl } from 'void/routes';

const url = routeUrl('/users/:id', {
  params: { id: 42 },
  query: { tab: 'activity' },
  hash: 'details',
});
// /users/42?tab=activity#details
```

Your editor autocompletes route patterns and parameter names. TypeScript checks that the route exists and all required parameters are supplied. Parameter values accept strings or numbers; Void encodes them for the URL. Query keys are chosen by your app, and values can be strings, numbers, booleans, or arrays of those values. Arrays become repeated query parameters; `null` and `undefined` values are omitted.

Pass the returned string to `Link`, a plain `<a>`, or `c.redirect()`. For programmatic navigation and `c.rewrite()`, you can pass a destination object directly:

```ts
import type { RouteDestination } from 'void/routes';

const profile = {
  pathname: '/users/:id',
  params: { id: 42 },
  query: { tab: 'activity' },
  hash: 'details',
} satisfies RouteDestination;
```

Destination objects use the same parameter checking and URL encoding as `routeUrl()`. See [Pages Routing](./pages-routing/overview.md#typed-navigation) for links and router methods, and [Rewrites](../reference/api/rewrites.md#c-rewrite-destination) for server navigation.

For a catch-all page such as `pages/files/[...path].tsx`, `.vue`, or `.svelte`, use `/files/:path{.+}` and pass the full path as one value:

```ts
routeUrl('/files/:path{.+}', { params: { path: 'docs/get started' } });
// /files/docs/get%20started
```

### Page params

Pass a page's URL pattern as the type argument of `useParams()` to type the params it reads. For a page at `pages/users/[id].tsx`, `.vue`, or `.svelte`, the pattern is `/users/:id`:

::: code-group

```tsx [React]
import { useParams } from '@void/react';

const { id } = useParams<'/users/:id'>(); // id: string
useParams<'/users/:id'>().idd; // Type error: no such param
useParams<'/userz/:id'>(); // Type error: no page matches
```

```vue [Vue]
<script setup lang="ts">
import { useParams } from '@void/vue';

const params = useParams<'/users/:id'>();
params.id; // string
params.idd; // Type error: no such param
useParams<'/userz/:id'>(); // Type error: no page matches
</script>
```

```svelte [Svelte]
<script lang="ts">
  import { useParams } from '@void/svelte';

  const params = useParams<'/users/:id'>();
  params.id; // string
  params.idd; // Type error: no such param
  useParams<'/userz/:id'>(); // Type error: no page matches
</script>
```

```tsx [Solid]
import { useParams } from '@void/solid';

const params = useParams<'/users/:id'>();
params.id; // string
params.idd; // Type error: no such param
useParams<'/userz/:id'>(); // Type error: no page matches
```

:::

The pattern must be one of your pages; HTTP and WebSocket routes are not accepted. A catch-all page such as `pages/files/[...path].tsx`, `.vue`, or `.svelte` gives `{ path: string }`. An unnamed catch-all (`[...].tsx`, `[...].vue`, or `[...].svelte`) has no params.

The pattern is checked by TypeScript only. Pass the pattern of the page the component renders in; without a pattern, `useParams()` returns `Record<string, string>`.

On the server, `c.req.param('slug')` accepts any name. Read the params object through `PageParams` so a missing or misspelled name is a type error:

```ts
import type { PageParams } from 'void/routes';

const { slug } = c.req.param() as PageParams<'/posts/:slug'>;
```

### Prerender paths

On a dynamic page, annotate `getPrerenderPaths()` with `PageParams` for that page's URL pattern. Each returned object must then include the page's params, and a missing or misspelled key is a type error. Void does not infer this type from the filename, so the check applies only when the annotation is present:

```ts
// pages/blog/[slug].server.ts
import type { PageParams } from 'void/routes';

export async function getPrerenderPaths(): Promise<PageParams<'/blog/:slug'>[]> {
  return [{ slug: 'hello-world' }];
}
```

In custom SSR mode the function returns full path strings, so annotate it as `Promise<string[]>`. See [Edge Prerendering](./edge/prerendering.md#dynamic-pages-with-params) and [Static Site Generation](./ssg.md#per-page-overrides).

`revalidate({ paths })` and `routing.prerender` are lists of plain strings. Annotate the array with `satisfies RouteUrl[]` so each path has to match a route. The check applies when [`routing.typedRoutes`](../reference/config.md#routing-typedroutes) is on; otherwise `RouteUrl` is `string`:

```ts
import type { RouteUrl } from 'void/routes';

await revalidate({ paths: ['/', '/blog/hello-world'] satisfies RouteUrl[] });
```

### Checked URL strings

[`routing.typedRoutes`](../reference/config.md#routing-typedroutes) checks plain URL strings in `Link`'s `href`, `router.visit()`, `router.prefetch()`, `router.flush()`, and `c.rewrite()`. Apps created with `void init` have it on. To turn it on in an existing app:

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  routing: { typedRoutes: true },
});
```

A string must then match one of your routes, optionally followed by a query string or hash:

::: code-group

```tsx [React]
import { Link } from '@void/react';
import { routeUrl } from 'void/routes';

<Link href="/about">About</Link>
<Link href={`/users/${user.id}?tab=activity`}>Profile</Link>
<Link href={routeUrl('/users/:id', { params: { id } })}>Profile</Link>
<Link href="/abuot">About</Link> // Type error: no route matches
```

```vue [Vue]
<script setup lang="ts">
import { Link } from '@void/vue';
import { routeUrl } from 'void/routes';
</script>

<template>
  <Link href="/about">About</Link>
  <Link :href="`/users/${user.id}?tab=activity`">Profile</Link>
  <Link :href="routeUrl('/users/:id', { params: { id } })">Profile</Link>
  <!-- Type error: no route matches -->
  <Link href="/abuot">About</Link>
</template>
```

```svelte [Svelte]
<script lang="ts">
  import { Link } from '@void/svelte';
  import { routeUrl } from 'void/routes';
</script>

<Link href="/about">About</Link>
<Link href={`/users/${user.id}?tab=activity`}>Profile</Link>
<Link href={routeUrl('/users/:id', { params: { id } })}>Profile</Link>
<!-- Type error: no route matches -->
<Link href="/abuot">About</Link>
```

```tsx [Solid]
import { Link } from '@void/solid';
import { routeUrl } from 'void/routes';

<Link href="/about">About</Link>
<Link href={`/users/${user.id}?tab=activity`}>Profile</Link>
<Link href={routeUrl('/users/:id', { params: { id } })}>Profile</Link>
<Link href="/abuot">About</Link> // Type error: no route matches
```

:::

Links can also point to the current page (`?page=2`, `#comments`) and to `http://`, `https://`, `mailto:`, and `tel:` URLs. Relative paths such as `../settings` are rejected; use the absolute path. A fixed part with spaces or non-ASCII characters can be written as is (`/café menu`) or percent-encoded in uppercase, as `routeUrl()` returns it (`/caf%C3%A9%20menu`). A dynamic segment matches any text, including none, so `/users/:id` also accepts `/users/` and `/users/42/edit`. With a root dynamic page such as `pages/[slug].tsx`, `.vue`, or `.svelte`, a protocol-relative URL like `//example.com` passes too.

`c.redirect()` is not part of that check. It still accepts any string. Build an internal path with `routeUrl()`, or annotate a full path with `satisfies RouteUrl`. With `routing.typedRoutes` on, a path that matches no route is a type error. An external URL stays a plain string:

```ts
import { routeUrl, type RouteUrl } from 'void/routes';

c.redirect(routeUrl('/users/:id', { params: { id } }));
c.redirect('/users/42' satisfies RouteUrl);
c.redirect('https://example.com/login');
```

`void/routes` exports two types for these strings:

- `RouteUrl`: the URL of one of your routes. `routeUrl()` returns it, and `c.rewrite()` accepts it. Annotate a `c.redirect()` path or a prerender or revalidate path list with it.
- `Href`: anything a link can point to: a `RouteUrl`, a same-page query or hash, or an external URL.

Cast a string that TypeScript can't check, such as a path from your CMS or a file in `public/`:

::: code-group

```tsx [React]
import { Link } from '@void/react';
import type { Href, RouteUrl } from 'void/routes';

<Link href={post.path as RouteUrl}>{post.title}</Link>
<Link href={user.website as Href}>Website</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from '@void/vue';
import type { Href, RouteUrl } from 'void/routes';

const postHref = post.path as RouteUrl;
const website = user.website as Href;
</script>

<template>
  <Link :href="postHref">{{ post.title }}</Link>
  <Link :href="website">Website</Link>
</template>
```

```svelte [Svelte]
<script lang="ts">
  import { Link } from '@void/svelte';
  import type { Href, RouteUrl } from 'void/routes';

  const postHref = post.path as RouteUrl;
  const website = user.website as Href;
</script>

<Link href={postHref}>{post.title}</Link>
<Link href={website}>Website</Link>
```

```tsx [Solid]
import { Link } from '@void/solid';
import type { Href, RouteUrl } from 'void/routes';

<Link href={post.path as RouteUrl}>{post.title}</Link>
<Link href={user.website as Href}>Website</Link>
```

:::

Restart the dev server or run `void prepare` after changing `routing.typedRoutes`.

Route types update with the dev server. For CI or standalone typechecking, run `void prepare` and follow [Setup](#setup). The [API reference](../reference/api/types.md#void-routes) lists the URL helper and route types.

## What Gets Checked

| Layer               | What's type-checked                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Database            | Table columns, value types, insert/update shapes from Drizzle schema                                                  |
| Handlers            | `c.env` bindings, validator input, return type                                                                        |
| Fetch client        | Route paths, HTTP methods, `body`/`query`/`params`, response type                                                     |
| Navigation          | Route patterns and required parameter names and values in `routeUrl()` and destination objects                        |
| Links               | With `routing.typedRoutes`, URL strings in `Link`, router methods, and `c.rewrite()`                                  |
| `c.redirect`        | An internal path built with `routeUrl()`, or a full path annotated with `satisfies RouteUrl`                          |
| `useParams`         | Page patterns and the names of the params they return                                                                 |
| `c.req.param`       | Page param names, when the result is annotated with `PageParams`                                                      |
| `getPrerenderPaths` | Page param names, when the return type is annotated with `PageParams`                                                 |
| `revalidate`        | `paths`, and `routing.prerender`, when the array is annotated with `satisfies RouteUrl[]`                             |
| `useForm`           | Action URLs, `data` fields, `errors` keys, `reset()` args (including `{ initial: true }`), `params`, `resetOnSuccess` |
| `action()`          | Action URLs, `data` payload, `params`                                                                                 |

## Serialization

The client types reflect JSON serialization through `Serialize<T>`:

| Source type                       | Serialized type                                        |
| --------------------------------- | ------------------------------------------------------ |
| `string`, `number`, `boolean`     | unchanged                                              |
| `Date`                            | `string`                                               |
| `Response`                        | excluded (passed through at runtime)                   |
| `bigint`, `Function`, `undefined` | excluded                                               |
| `Array<T>` / `{ key: T }`         | recursively serialized (function-valued keys stripped) |

## Context Variables

Middleware and handlers share typed data through Hono's context variables. Augment `CloudContextVariables` to define your own:

```ts
// middleware/01.auth.ts
declare module 'void' {
  interface CloudContextVariables {
    requestId: string;
  }
}

export default defineMiddleware(async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});
```

Now `c.get("requestId")` returns `string` everywhere, with no assertion needed. Multiple augmentations across files are [merged together](https://www.typescriptlang.org/docs/handbook/declaration-merging.html).

## Setup

Extend the generated tsconfig in your project:

```json
{
  "extends": "./.void/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["void/env"]
  },
  "include": ["src", "routes", "middleware", "crons", "queues"]
}
```

If you already have a TypeScript config, run `void init --tsconfig` to add Void types while preserving your settings.

Run `void prepare` in CI or after a fresh clone, or let `vite dev` / `vite build` generate the `.void/` files during normal app workflows.
