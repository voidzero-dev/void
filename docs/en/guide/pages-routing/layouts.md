---
outline: deep
---

<script setup>
function layoutBasicItems(ext) {
  return [
    {
      name: "pages/",
      children: [
        { name: `layout${ext}`, description: "Root layout (nav, footer)" },
        { name: `index${ext}` },
        {
          name: "users/",
          children: [
            { name: `layout${ext}`, description: "Nested layout for /users/*" },
            { name: `index${ext}` },
            { name: `[id]${ext}` },
          ],
        },
      ],
    },
  ]
}

function namedLayoutItems(ext) {
  return [
    {
      name: "pages/",
      children: [
        {
          name: "_layouts/",
          children: [
            { name: `landing${ext}`, description: 'named "landing"' },
            { name: `post${ext}`, description: 'named "post"' },
          ],
        },
        { name: `layout${ext}`, description: "default root layout" },
        { name: `index${ext}` },
        {
          name: "blog/",
          children: [
            { name: "hello.md", description: "layout: post" },
            { name: "archive.md", description: "layout: landing" },
          ],
        },
        { name: `pricing${ext}`, description: "layout: !landing (exclusive)" },
      ],
    },
  ]
}

</script>

# Layouts & Shared Data

Use layouts for navigation, headers, and other UI shared by several pages. Layouts nest with your directories and keep their component state as you navigate.

## Layouts

Place a layout file in a `pages/` directory to wrap its pages:

<FileTree :items="layoutBasicItems" adapter-tabs default-expanded />

::: code-group

```tsx [React]
// pages/layout.tsx
import { useShared, Link } from '@void/react';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { auth } = useShared();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {auth?.user && <span>{auth.user.name}</span>}
      </nav>
      <main>{children}</main>
    </>
  );
}
```

```vue [Vue]
<!-- pages/layout.vue -->
<script setup lang="ts">
import { useShared, Link } from '@void/vue';
const { auth } = useShared();
</script>

<template>
  <nav>
    <Link href="/">Home</Link>
    <Link href="/users">Users</Link>
    <span v-if="auth?.user">{{ auth.user.name }}</span>
  </nav>
  <main>
    <slot />
  </main>
</template>
```

```svelte [Svelte]
<!-- pages/layout.svelte -->
<script>
  import { useShared, Link } from "@void/svelte";
  let { children } = $props();
  const { auth } = useShared();
</script>

<nav>
  <Link href="/">Home</Link>
  <Link href="/users">Users</Link>
  {#if auth?.user}<span>{auth.user.name}</span>{/if}
</nav>
<main>
  {@render children()}
</main>
```

```tsx [Solid]
// pages/layout.tsx
import { useShared, Link } from '@void/solid';
import type { JSX } from 'solid-js';

export default function Layout(props: { children: JSX.Element }) {
  const shared = useShared();
  return (
    <>
      <nav>
        <Link href="/">Home</Link>
        <Link href="/users">Users</Link>
        {shared.auth?.user && <span>{shared.auth.user.name}</span>}
      </nav>
      <main>{props.children}</main>
    </>
  );
}
```

:::

When a page renders, the layout wraps it. The page component is injected as the layout's children in React, Solid, and Svelte, or as a slot in Vue:

<img src="./layout-nesting.svg" alt="Layout nesting diagram: pages/layout wraps pages/users/layout wraps pages/users/[id] page component" style="max-width: 520px; width: 100%;" />

## Named Layouts

Named layouts let individual pages opt into a different layout without changing the URL structure. Define them in `_layouts/` directories within `pages/`:

<FileTree :items="namedLayoutItems" adapter-tabs default-expanded />

### Selecting a named layout

Export a `layout` constant from any page:

::: code-group

```tsx [React]
export const layout = 'landing';

export default function Page() {
  return <div>This page uses the landing layout</div>;
}
```

```vue [Vue]
<script>
export const layout = 'landing';
</script>

<template>
  <div>This page uses the landing layout</div>
</template>
```

```svelte [Svelte]
<script context="module">
export const layout = "landing";
</script>

<div>This page uses the landing layout</div>
```

```tsx [Solid]
export const layout = 'landing';

export default function Page() {
  return <div>This page uses the landing layout</div>;
}
```

:::

For markdown pages, use frontmatter:

```md
---
layout: post
---

# My Blog Post
```

### Layout modes

| Value        | Behavior                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| `"landing"`  | Replace the innermost layout in the chain. Outer ancestor layouts still apply. |
| `"!landing"` | Replace the **entire** chain. Only the named layout wraps the page.            |
| `false`      | No layout wrapping at all. Page renders standalone.                            |

A named layout replaces the deepest default layout: in `[root, docs/layout]`, it replaces `docs/layout`; in `[root]`, it replaces the root.

Void uses the closest matching `_layouts/` file in the page's directory or an ancestor. A missing named layout fails the build.

## Shared Data

Middleware can inject data available on every page via `c.set("shared", {...})`. Augment `CloudContextVariables` to type the shared data, and `useShared()` will infer the type automatically:

```ts
// middleware/01.auth.ts
import { defineMiddleware } from 'void';
import { getUser, type AuthUser } from 'void/auth';

declare module 'void' {
  interface CloudContextVariables {
    shared: { auth: { user: AuthUser | null } };
  }
}

export default defineMiddleware(async (c, next) => {
  const user = getUser();
  c.set('shared', { auth: { user } });
  await next();
});
```

Call `useShared()` from your framework adapter, as in the layout examples above. Its return type is inferred from `CloudContextVariables`. Shared data comes from middleware; page props come from the loader. See [Context variables](../type-safety.md#context-variables).
