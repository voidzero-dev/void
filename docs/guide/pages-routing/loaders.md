---
outline: deep
---

# Loaders & Props

A loader fetches the data a page needs. Define it in a companion `.server.ts` file using the same `defineHandler` API as [server routes](../server-routing.md).

## Defining a Loader

`loader` runs on GET requests and returns an object that becomes the page's props:

```ts
// pages/users/index.server.ts
import { users } from '@schema';
import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { db } from 'void/db';

export type Props = InferProps<typeof loader>; // [!code highlight]

export const loader = defineHandler(async (c) => {
  return { users: await db.select().from(users) };
});
```

`InferProps` infers the loader’s return type, so page props stay in sync with the data it returns.

## Using the Data in Page Components

The page component receives the loader's result as props. Export the inferred type from the server file so the component stays in sync:

::: code-group

```tsx [React]
// pages/users/index.tsx
import type { Props } from './index.server';

export default function UsersPage({ users }: Props) {
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
```

```vue [Vue]
<!-- pages/users/index.vue -->
<script setup lang="ts">
import type { Props } from './index.server';
defineProps<Props>();
</script>

<template>
  <h1>Users</h1>
  <ul>
    <li v-for="u in users" :key="u.id">{{ u.name }}</li>
  </ul>
</template>
```

```svelte [Svelte]
<!-- pages/users/index.svelte -->
<script lang="ts">
  import type { Props } from "./index.server";

  let { users }: Props = $props();
</script>

<h1>Users</h1>
<ul>
  {#each users as u (u.id)}
    <li>{u.name}</li>
  {/each}
</ul>
```

```tsx [Solid]
// pages/users/index.tsx
import { For } from 'solid-js';
import type { Props } from './index.server';

export default function UsersPage(props: Props) {
  return (
    <>
      <h1>Users</h1>
      <ul>
        <For each={props.users}>{(u) => <li>{u.name}</li>}</For>
      </ul>
    </>
  );
}
```

:::

## Deferred Props

Use `defer()` for slow data. The page renders immediately and receives the result when it is ready:

```ts
// pages/dashboard.server.ts
import { projects } from '@schema';
import { defineHandler, defer } from 'void';
import type { InferProps } from 'void';
import { db } from 'void/db';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const allProjects = await db.select().from(projects); // fast, returns immediately
  return {
    projects: allProjects,
    usage: defer(async () => {
      return await fetchUsageMetrics(); // slow, streams when ready
    }),
  };
});
```

The page can render `projects` while `usage` is still loading. In React, read `usage` with `use()` inside Suspense. Other adapters expose it as `{ loading, value, error }`.

### Handling Deferred State

In React, `Deferred<T>` is consumed as a promise. Put the deferred read under a `<Suspense>` boundary and call `use()` where the value is needed:

::: code-group

```tsx [React]
import { Suspense, use } from 'react';
import type { Props } from './dashboard.server';

function Usage({ usage }: Pick<Props, 'usage'>) {
  const resolved = use(usage);
  return <p>{resolved.requests} requests</p>;
}

export default function Dashboard({ projects, usage }: Props) {
  return (
    <div>
      <h1>Projects ({projects.length})</h1>
      <Suspense fallback={<p>Loading usage...</p>}>
        <Usage usage={usage} />
      </Suspense>
    </div>
  );
}
```

:::

Rejected deferred props throw from `use()`. Put a normal React error boundary
around the Suspense boundary when the page should render a custom failure state.
For explicit React prop annotations, import `Deferred` from `@void/react`; the
adapter export is typed as `Promise<T>`.

In production, an unexpected error in a deferred prop reaches the page as
`Internal Server Error`; throw an
[`HTTPException`](../../integrations/hono.md#utilities) to show your own message.

In Vue, Svelte, and Solid, `Deferred<T>` behaves as a [discriminated union](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions) with three states:

```ts
type Deferred<T> =
  | { loading: true; value: null; error: null } // pending
  | { loading: false; value: T; error: null } // resolved
  | { loading: false; value: null; error: Error }; // rejected
```

Check `loading` first, then `error`. TypeScript narrows `value` to `T` in the resolved branch:

::: code-group

```vue [Vue]
<script setup lang="ts">
import type { Props } from './dashboard.server';
defineProps<Props>();
</script>

<template>
  <div>
    <h1>Projects ({{ projects.length }})</h1>
    <p v-if="usage.loading">Loading usage...</p>
    <p v-else-if="usage.error">Failed: {{ usage.error.message }}</p>
    <p v-else>{{ usage.value.requests }} requests</p>
  </div>
</template>
```

```svelte [Svelte]
<script lang="ts">
  import type { Props } from "./dashboard.server";
  let { projects, usage }: Props = $props();
</script>

<div>
  <h1>Projects ({projects.length})</h1>
  {#if usage.loading}
    <p>Loading usage...</p>
  {:else if usage.error}
    <p>Failed: {usage.error.message}</p>
  {:else}
    <p>{usage.value.requests} requests</p>
  {/if}
</div>
```

```tsx [Solid]
import type { Props } from './dashboard.server';

export default function Dashboard(props: Props) {
  return (
    <div>
      <h1>Projects ({props.projects.length})</h1>
      {props.usage.loading ? (
        <p>Loading usage...</p>
      ) : props.usage.error ? (
        <p>Failed: {props.usage.error.message}</p>
      ) : (
        <p>{props.usage.value.requests} requests</p>
      )}
    </div>
  );
}
```

:::

### Deferred Props After Mutations

::: info
After an action, deferred props keep their last resolved values until the next page load or client-side navigation. Other loader props refresh immediately.
:::

### Grouped Deferred Props

When multiple props depend on the same slow operation, use a named group to resolve them together with a single function call:

```ts
export const loader = defineHandler<Props>(async (c) => {
  const analyticsResolver = async () => {
    const data = await fetchAnalytics(); // one slow call
    return { metrics: data.metrics, chart: data.chart };
  };

  return {
    projects: await db.select().from(projects),
    metrics: defer('analytics', analyticsResolver),
    chart: defer('analytics', analyticsResolver),
  };
});
```

Both `metrics` and `chart` resolve from a single invocation of the analytics resolver. The component receives them as separate `Deferred<T>` props.
