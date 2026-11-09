---
outline: deep
---

# Not Found & Errors

Add `_not-found` and `_error` components to `pages/` to show errors inside your app's layouts. Both receive an `error` prop with `status` and `message`.

::: code-group

```tsx [React]
// pages/_error.tsx (or pages/_not-found.tsx)
import type { ErrorPageProps } from '@void/react';

export default function ErrorPage({ error }: ErrorPageProps) {
  return (
    <main>
      <h1>{error.status}</h1>
      <p>{error.message}</p>
      <a href="/">Go home</a>
    </main>
  );
}
```

```vue [Vue]
<!-- pages/_error.vue (or pages/_not-found.vue) -->
<script setup lang="ts">
import type { ErrorPageProps } from '@void/vue';

defineProps<ErrorPageProps>();
</script>

<template>
  <main>
    <h1>{{ error.status }}</h1>
    <p>{{ error.message }}</p>
    <a href="/">Go home</a>
  </main>
</template>
```

```svelte [Svelte]
<!-- pages/_error.svelte (or pages/_not-found.svelte) -->
<script lang="ts">
  import type { ErrorPageProps } from '@void/svelte';

  let { error }: ErrorPageProps = $props();
</script>

<main><h1>{error.status}</h1><p>{error.message}</p><a href="/">Go home</a></main>
```

```tsx [Solid]
// pages/_error.tsx (or pages/_not-found.tsx)
import type { ErrorPageProps } from '@void/solid';

export default function ErrorPage(props: ErrorPageProps) {
  return (
    <main>
      <h1>{props.error.status}</h1>
      <p>{props.error.message}</p>
      <a href="/">Go home</a>
    </main>
  );
}
```

:::

`_not-found` handles a page loader returning a 404 or throwing `HTTPException(404)`. A root `pages/_not-found` also handles URLs that don't match a page or API route. Returning a 404 is the same in all four adapters:

```ts
// pages/products/[id].server.ts
import { defineHandler } from 'void/handler';

export const loader = defineHandler((c) => c.notFound());
```

`_error` handles unexpected loader and rendering failures. Unexpected errors use generic production messages; server details stay in your logs. Development shows the error message. Action errors that reach a client boundary retain their HTTP status and public message. Explicit responses such as redirects, authentication failures, and API errors keep their existing behavior.

Calling `c.notFound()` in middleware invokes the app's not-found handler, which uses the root `pages/_not-found`. It doesn't select a nested boundary or run the page loader. To send your own 404 response from middleware, return a response such as `c.text('Not Found', 404)`; Void leaves it unchanged.

## Nested errors

Put a boundary in a subdirectory to customize that section. The closest boundary wins, keeping its layout and outer layouts. A layout's own rendering failure goes to a boundary outside that layout. If an error component fails, Void tries an outer boundary, then its built-in error page.

Boundary components don't have `.server` companions, actions, or their own `layout` export. They aren't routes: `/error` and `/not-found` remain available for ordinary pages. `.dev` and `.prod` variants work like other Pages components.

## Recovery

Client rendering errors use the framework's error boundaries. Event handlers, detached async tasks, and independent islands keep the framework's normal error handling. Deferred props retain each adapter's usual behavior: React can throw a rejected deferred promise during rendering; Vue, Svelte, and Solid expose its error state for your component to display.

Use `useRouter().refresh()` in an interactive error component to retry the current page's GET loader. It bypasses Void's client page cache and never repeats a form submission. A regular link or document reload also works. Error responses aren't stored in the client page cache.

## Rendering modes

`ssr = false` pages show their error component in the browser. Island pages render error documents on the server; they don't gain a client router. Boundary components should work with the same shared context as the page they replace.

With `output: 'static'`, a root `_not-found` produces `404.html` unless an explicit 404 document already exists. It renders with empty shared data and parameters, without request middleware or client hydration. Keep that component and its layouts usable without a signed-in user or other request data. Your static host controls the response status for unknown URLs.
