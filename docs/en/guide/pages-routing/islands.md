---
outline: deep
---

<script setup>
function islandItems(ext) {
  return [
    {
      name: "pages/",
      children: [
        {
          name: "blog/",
          children: [
            { name: `index.island${ext}`, description: "← island page" },
            { name: "index.server.ts" },
            { name: `_Counter${ext}`, description: "regular component, used as island" },
            { name: `_PostForm${ext}` },
          ],
        },
      ],
    },
  ]
}

function mixedItems(ext) {
  return [
    {
      name: "pages/",
      children: [
        { name: `index${ext}`, description: "regular page (full hydration, Void Router)" },
        { name: `about${ext}`, description: "regular page" },
        {
          name: "blog/",
          children: [
            { name: `index.island${ext}`, description: "island page (partial hydration, static HTML)" },
            { name: `[slug].island${ext}`, description: "island page" },
          ],
        },
      ],
    },
  ]
}

</script>

# Islands

Islands let you add interactive components to an otherwise static page. The server renders the page as HTML, and only the components marked as islands send JavaScript to the browser. This approach is inspired by [Astro](https://docs.astro.build/en/concepts/islands/).

For example, a blog post can keep its article content static while loading JavaScript for a comment form or audio player.

::: tip Prerequisites
Islands mode builds on top of [Pages Routing](./overview). You need a working Pages setup (framework adapter installed, `pages/` directory, Vite config) before using islands.
:::

## When to Use Islands

Use islands for blogs, marketing pages, or documentation with a few interactive components. For dashboards and apps with shared client state, use regular [Pages Routing](./overview).

## Creating an Island Page

Name your page file with the `.island` suffix:

<FileTree :items="islandItems" adapter-tabs default-expanded />

Island pages render as HTML and hydrate only the components you mark as islands. Navigation uses full page loads.

Pages without a loader or dynamic parameters are automatically [prerendered](/guide/edge/prerendering). Opt out with `export const prerender = false` in the companion `.server.ts` file.

## Marking Components as Islands

Use [import attributes](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with) to mark which components should be interactive on the client:

::: code-group

```tsx [React]
// pages/blog/index.island.tsx
import Counter from './_Counter' with { island: 'load' };
import PostForm from './_PostForm' with { island: 'visible' };

export default function BlogIndex({ posts }) {
  return (
    <div>
      <h1>Blog</h1>
      <Counter />
      {posts.map((post) => (
        <a key={post.slug} href={`/blog/${post.slug}`}>
          {post.title}
        </a>
      ))}
      <PostForm />
    </div>
  );
}
```

```vue [Vue]
<!-- pages/blog/index.island.vue -->
<script setup>
import Counter from './_Counter.vue' with { island: 'load' };
import PostForm from './_PostForm.vue' with { island: 'visible' };

defineProps({ posts: Array });
</script>

<template>
  <div>
    <h1>Blog</h1>
    <Counter />
    <a v-for="post in posts" :key="post.slug" :href="`/blog/${post.slug}`">
      {{ post.title }}
    </a>
    <PostForm />
  </div>
</template>
```

```svelte [Svelte]
<!-- pages/blog/index.island.svelte -->
<script>
import Counter from "./_Counter.svelte" with { island: "load" };
import PostForm from "./_PostForm.svelte" with { island: "visible" };

let { posts } = $props();
</script>

<div>
  <h1>Blog</h1>
  <Counter />
  {#each posts as post}
    <a href="/blog/{post.slug}">{post.title}</a>
  {/each}
  <PostForm />
</div>
```

```tsx [Solid]
import { For } from 'solid-js';
// pages/blog/index.island.tsx
import Counter from './_Counter' with { island: 'load' };
import PostForm from './_PostForm' with { island: 'visible' };

export default function BlogIndex(props) {
  return (
    <div>
      <h1>Blog</h1>
      <Counter />
      <For each={props.posts}>{(post) => <a href={`/blog/${post.slug}`}>{post.title}</a>}</For>
      <PostForm />
    </div>
  );
}
```

:::

Components imported _without_ the `island` attribute are rendered as static HTML only. No JavaScript is sent to the browser for them.

::: warning TypeScript configuration
Import attributes require `"module": "ESNext"` in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "ESNext"
  }
}
```

:::

## Hydration Strategies

The `island` attribute value controls _when_ the component hydrates:

| Strategy          | Hydrates when...            | Use case                                   |
| ----------------- | --------------------------- | ------------------------------------------ |
| `"load"`          | Page loads                  | Critical interactive UI (forms, nav menus) |
| `"visible"`       | Element enters the viewport | Below-the-fold content                     |
| `"idle"`          | Browser is idle             | Non-critical enhancements                  |
| `"media:(query)"` | CSS media query matches     | Responsive components (e.g., mobile-only)  |

```tsx
import Comments from './_Comments' with { island: 'visible' };
import CookieBanner from './_CookieBanner' with { island: 'idle' };
import MobileMenu from './_MobileMenu' with { island: 'media:(max-width: 768px)' };
```

## Server Handlers

Island pages use the same `loader` and `action` pattern as regular pages. The `.server.ts` companion file works identically:

```ts
// pages/blog/index.server.ts
import { defineHandler } from 'void';

export const loader = defineHandler((c) => {
  return c.json({ posts: getAllPosts() });
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  // validate, create post...
  return c.json({ success: true });
});
```

After a successful action, an island page reloads or redirects through `window.location`. Regular Pages routes use the Void Router to fetch fresh props instead.

## Forms

Island pages cannot use `useForm` because it depends on the Void Router. Use `useIslandForm` instead. It has the same form state, but its submit helpers take the action URL and use `fetch()` directly:

::: code-group

```tsx [React]
import { useIslandForm } from '@void/react';

export default function PostForm() {
  const form = useIslandForm({ title: '', body: '' });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        return form.post('/blog');
      }}
    >
      <label htmlFor="title">Title:</label>
      <input
        id="title"
        value={form.data.title}
        onChange={(e) => form.setData('title', e.target.value)}
      />
      {form.errors.title && <span>{form.errors.title}</span>}

      <label htmlFor="body">Body:</label>
      <textarea
        id="body"
        value={form.data.body}
        onChange={(e) => form.setData('body', e.target.value)}
      />
      {form.errors.body && <span>{form.errors.body}</span>}

      <button disabled={form.pending}>{form.pending ? 'Saving...' : 'Add Post'}</button>
    </form>
  );
}
```

```vue [Vue]
<script setup>
import { useIslandForm } from '@void/vue';

const form = useIslandForm({ title: '', body: '' });

function submit() {
  return form.post('/blog');
}
</script>

<template>
  <form @submit.prevent="submit">
    <label for="title">Title:</label>
    <input id="title" v-model="form.data.title" />
    <span v-if="form.errors.title">{{ form.errors.title }}</span>

    <label for="body">Body:</label>
    <textarea id="body" v-model="form.data.body" />
    <span v-if="form.errors.body">{{ form.errors.body }}</span>

    <button :disabled="form.pending">
      {{ form.pending ? 'Saving...' : 'Add Post' }}
    </button>
  </form>
</template>
```

```svelte [Svelte]
<script>
import { useIslandForm } from "@void/svelte";

const form = useIslandForm({ title: "", body: "" });

function submit() {
  return form.post("/blog");
}
</script>

<form on:submit|preventDefault={submit}>
  <label for="title">Title:</label>
  <input id="title" bind:value={form.data.title} />
  {#if form.errors.title}<span>{form.errors.title}</span>{/if}

  <label for="body">Body:</label>
  <textarea id="body" bind:value={form.data.body} />
  {#if form.errors.body}<span>{form.errors.body}</span>{/if}

  <button disabled={form.pending}>
    {form.pending ? "Saving..." : "Add Post"}
  </button>
</form>
```

```tsx [Solid]
import { useIslandForm } from '@void/solid';
import { Show } from 'solid-js';

export default function PostForm() {
  const form = useIslandForm({ title: '', body: '' });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        return form.post('/blog');
      }}
    >
      <label for="title">Title:</label>
      <input
        id="title"
        value={form.data.title}
        onInput={(e) => form.setData('title', e.target.value)}
      />
      <Show when={form.errors.title}>
        <span>{form.errors.title}</span>
      </Show>

      <label for="body">Body:</label>
      <textarea
        id="body"
        value={form.data.body}
        onInput={(e) => form.setData('body', e.target.value)}
      />
      <Show when={form.errors.body}>
        <span>{form.errors.body}</span>
      </Show>

      <button disabled={form.pending}>{form.pending ? 'Saving...' : 'Add Post'}</button>
    </form>
  );
}
```

:::

`useIslandForm` provides the same form state as [`useForm`](./actions-and-forms#useform). Pass the action URL to `post`, `put`, `patch`, or `delete` to submit.

Successful submissions reload the page; redirects navigate to their destination. A `422` response populates `errors` from `{ errors: { field: "message" } }`. Submit helpers return `Promise<void>`.

## Navigation

Island pages do not have a Void Router. Use regular `<a>` tags for navigation:

```tsx
// ✅ Use regular links in island pages
<a href="/blog/my-post">Read more</a>

// ❌ Don't use <Link>; there is no Void Router to handle it
<Link href="/blog/my-post">Read more</Link>
```

When navigating _from_ a regular page to an island page (e.g., via `<Link>`), the router detects that the target is an island page and falls back to a full-page navigation automatically.

## Layouts

Island pages support [layouts](./layouts) the same way as regular pages. The layout wraps the page during server rendering. Layout components in island pages are **static only**, so they are not hydrated on the client.

## Mixing Island and Regular Pages

Island pages and regular pages can coexist in the same app:

<FileTree :items="mixedItems" adapter-tabs default-expanded />

The Void Router handles navigation between regular pages. Navigating to or from an island page triggers a full-page load.
