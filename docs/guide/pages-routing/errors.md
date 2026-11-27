---
description: 'Show not-found and error states inside your layouts with _not-found and _error components.'
outline: deep
---

# Not Found & Errors

Keep your app's navigation and layout visible when a page is missing or fails. Add `_not-found` and `_error` components to `pages/`; both receive an `error` prop with `status` and `message`:

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

## Missing pages

To show `_not-found` when a product doesn't exist, return a 404 from its loader. This works the same way in all four adapters:

```ts
// pages/products/[id].server.ts
import { defineHandler } from 'void/handler';

export const loader = defineHandler((c) => c.notFound());
```

Throwing `HTTPException(404)` also shows `_not-found`. A root `pages/_not-found` handles URLs that don't match any page or API route.

In middleware, `c.notFound()` shows the root `_not-found` without running a page loader. To send a custom response instead, return `c.text('Not Found', 404)`.

## Failed pages

`_error` handles unexpected loader and rendering failures. In production, visitors see a generic message and error details stay in your server logs. Development shows the error message.

Action errors that reach a client boundary keep their HTTP status and public message. See [Actions & Forms](./actions-and-forms.md) for handling failures inline.

## HTTP exceptions

Throw an `HTTPException` to show a specific error. Void renders the selected `_error` inside the page's layouts at or above the error component's directory, including any named layout at those positions. Deeper layouts are dropped. With `layout = false`, the error renders on its own. To keep a section's navigation, [add an `_error` in that section](#nested-errors).

A suspended account can return `403` with an explanation.

```ts
// pages/account.server.ts
import { HTTPException } from 'hono/http-exception';
import { defineHandler } from 'void/handler';

export const loader = defineHandler(() => {
  throw new HTTPException(403, { message: 'Your account is suspended' });
});
```

The nearest `_error` receives `{ status: 403, message: 'Your account is suspended' }`, and the response uses HTTP `403`. This works for both document requests and client-side page navigation. Use only messages that are safe to show to visitors.

Use a 4xx or 5xx status; `404` shows `_not-found`. If middleware throws before the loader runs, Void shows the root error component and skips the loader. Without a matching error component, Void returns the exception's response.

Error components handle these exceptions on page GET and HEAD requests. API routes and actions keep their own error handling. Return `c.text()` or `c.json()` to send a custom response, or [throw a redirect](../../integrations/hono.md#redirects) to send the visitor elsewhere. Checks that determine the response status must finish before deferred streaming starts.

Use [`c.status()`](./loaders.md#response-status) instead when you want an error status while rendering the requested page with its normal props.

## Nested errors

Put an error component in a subdirectory to customize that section. Void uses the closest one and keeps its surrounding layouts. If a layout fails, an error component outside that layout handles it. If an error component fails, Void tries an outer one, then its built-in error page.

Boundary components don't have `.server` companions, actions, or their own `layout` export. They aren't routes: `/error` and `/not-found` remain available for ordinary pages. `.dev` and `.prod` variants work like other Pages components.

## Recovery

Call `useRouter().refresh()` from an interactive error component to retry the page's loader. It fetches fresh data without repeating a form submission. A regular link or document reload also works. Error responses aren't cached by the client router.

Client rendering errors use your framework's error boundaries. Event handlers, detached async tasks, and independent islands keep the framework's usual error handling. For deferred data, React can throw rejected promises during rendering; Vue, Svelte, and Solid expose an error state your component can display.

## Rendering modes

With `ssr = false`, the error component renders in the browser. Island pages render errors on the server without a client router. Error components receive the shared context of the page they replace.

With `output: 'static'`, a root `_not-found` produces `404.html` unless you provide one. It renders at build time with empty shared data and parameters, without request middleware or hydration. Keep it and its layouts usable without a signed-in user. Your static host sets the response status for unknown URLs.
