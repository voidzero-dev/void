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
            { name: `index.island${ext}`, description: "← Islands 页面" },
            { name: "index.server.ts" },
            { name: `_Counter${ext}`, description: "常规组件，用作交互岛" },
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
        { name: `index${ext}`, description: "常规页面（完整水合，Void Router）" },
        { name: `about${ext}`, description: "常规页面" },
        {
          name: "blog/",
          children: [
            { name: `index.island${ext}`, description: "Islands 页面（局部水合，静态 HTML）" },
            { name: `[slug].island${ext}`, description: "Islands 页面" },
          ],
        },
      ],
    },
  ]
}

</script>

# Islands（交互岛） {#islands}

Islands 让你可以在静态页面中添加交互组件。服务端将页面渲染为 HTML，只有标记为交互岛的组件才会向浏览器发送 JavaScript。这种方式受到了 [Astro](https://docs.astro.build/en/concepts/islands/) 的启发。

例如，博客文章的正文可以保持静态，只为评论表单或音频播放器加载 JavaScript。

::: tip 准备工作
Islands 模式基于[页面路由](/zh/guide/pages-routing/overview)。使用前，需要先完成可正常运行的 Pages 配置，包括安装框架适配器、创建 `pages/` 目录和配置 Vite。
:::

## 何时使用 Islands {#when-to-use-islands}

对于只有少量交互组件的博客、营销页面或文档，可以使用 Islands。对于仪表盘或需要共享客户端状态的应用，请使用常规[页面路由](/zh/guide/pages-routing/overview)。

## 创建 Islands 页面 {#creating-an-island-page}

为页面文件名添加 `.island` 后缀：

<FileTree :items="islandItems" adapter-tabs default-expanded />

Islands 页面会渲染为 HTML，并只对标记为交互岛的组件进行水合。页面导航会完整加载目标页面。

没有 loader 且不含动态参数的页面会自动[预渲染](/zh/guide/edge/prerendering)。如果不希望预渲染，可以在配套的 `.server.ts` 文件中设置 `export const prerender = false`。

## 将组件标记为交互岛 {#marking-components-as-islands}

使用[导入属性](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import/with)标记需要在客户端交互的组件：

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

导入时_未添加_ `island` 属性的组件只会渲染为静态 HTML，不会为这些组件向浏览器发送 JavaScript。

::: warning TypeScript 配置
使用导入属性时，需要在 `tsconfig.json` 中设置 `"module": "ESNext"`：

```json
{
  "compilerOptions": {
    "module": "ESNext"
  }
}
```

:::

## 水合策略 {#hydration-strategies}

`island` 属性的值决定组件_何时_进行水合：

| 策略 | 水合时机 | 适用场景 |
| --- | --- | --- |
| `"load"` | 页面加载时 | 表单、导航菜单等关键交互界面 |
| `"visible"` | 元素进入视口时 | 首屏以外的内容 |
| `"idle"` | 浏览器空闲时 | 非关键的增强功能 |
| `"media:(query)"` | CSS 媒体查询匹配时 | 响应式组件，例如仅在移动端显示的组件 |

```tsx
import Comments from './_Comments' with { island: 'visible' };
import CookieBanner from './_CookieBanner' with { island: 'idle' };
import MobileMenu from './_MobileMenu' with { island: 'media:(max-width: 768px)' };
```

## 服务端处理函数 {#server-handlers}

Islands 页面与常规页面使用相同的 `loader` 和 `action` 模式，配套 `.server.ts` 文件的用法也完全相同：

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

Action 成功后，Islands 页面会通过 `window.location` 重新加载或重定向。常规 Pages 路由则使用 Void Router 获取最新的 props。

## 表单 {#forms}

Islands 页面不能使用 `useForm`，因为它依赖 Void Router。请改用 `useIslandForm`：它提供相同的表单状态，但提交辅助方法需要接收 Action URL，并直接使用 `fetch()`：

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

`useIslandForm` 提供与 [`useForm`](/zh/guide/pages-routing/actions-and-forms#useform) 相同的表单状态。提交时，将 Action URL 传给 `post`、`put`、`patch` 或 `delete`。

提交成功后会重新加载页面；如果响应是重定向，则跳转到目标地址。收到 `422` 响应时，会使用 `{ errors: { field: "message" } }` 中的内容填充 `errors`。提交辅助方法返回 `Promise<void>`。

## 导航 {#navigation}

Islands 页面没有 Void Router。请使用普通的 `<a>` 标签进行导航：

```tsx
// ✅ Use regular links in island pages
<a href="/blog/my-post">Read more</a>

// ❌ Don't use <Link>; there is no Void Router to handle it
<Link href="/blog/my-post">Read more</Link>
```

_从_常规页面导航到 Islands 页面时，例如通过 `<Link>`，路由器会检测到目标是 Islands 页面，并自动改为整页导航。

## 布局 {#layouts}

Islands 页面与常规页面一样支持[布局](/zh/guide/pages-routing/layouts)。服务端渲染时，布局会包裹页面。Islands 页面的布局组件**仅为静态内容**，不会在客户端进行水合。

## 混合使用 Islands 页面与常规页面 {#mixing-island-and-regular-pages}

同一个应用中可以同时存在 Islands 页面与常规页面：

<FileTree :items="mixedItems" adapter-tabs default-expanded />

常规页面之间的导航由 Void Router 处理。导航到 Islands 页面，或从 Islands 页面导航出去时，都会触发整页加载。
