---
outline: deep
---

# 页面路由 {#pages-routing}

将 UI 组件放在 `pages/` 中，即可将它们变成路由。页面的服务端 loader 返回数据，组件通过 props 接收这些数据。这一模式受 [Inertia.js](https://inertiajs.com/) 启发，适用于 React、Vue、Svelte 和 Solid。

存在 `pages/` 目录时，就会启用 Pages 模式。它可以与 `routes/` 共存：页面用于 UI，路由用于 API。页面组件通常先在服务端完成首次渲染，再由浏览器处理导航和交互。

你也可以使用自己的客户端路由，通过[类型化 fetch](/zh/guide/typed-fetch) 调用 Void API。Pages 模式是可选的。

## 设置 {#setup}

在空项目中，`void init` 可以帮你配置 Pages。先选择 Vite+ 或普通 Vite，再选择 React、Vue、Svelte 或 Solid，以及数据库或静态应用模板。生成的应用会包含对应的 Vite 配置和页面文件。

手动添加 Pages 模式时，除了 `void`，还需安装框架适配器：

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

将两个插件都添加到 Vite 配置中：

::: code-group

```ts [React]
import { voidReact } from '@void/react/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

```ts [Vue]
import { voidVue } from '@void/vue/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

```ts [Svelte]
import { voidSvelte } from '@void/svelte/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

```ts [Solid]
import { voidSolid } from '@void/solid/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

:::

每个适配器都已包含对应框架的 Vite 插件。如有需要，可通过 `voidReact({ react: { ... } })`、`voidVue({ vue: { ... } })`、`voidSvelte({ svelte: { ... } })` 或 `voidSolid({ solid: { ... } })` 传入框架插件选项。

## 目录结构 {#directory-structure}

页面可以是 `about.vue` 这样的独立文件，也可以是 `about/index.vue` 这样的目录路由，两者映射到相同的路由：

<PagesFileTree />

每个路由只保留一个页面文件。如果两个页面文件解析到同一路径，Void 会报错，例如同时存在 `about.vue` 和 `about/index.vue`，或两个路由组中包含同一页面。

每个页面都可以有一个配套的 `.server.ts`、`.server.tsx`、`.server.js`、`.server.jsx`、`.server.mts` 或 `.server.mjs` 文件，只在服务端运行。如果配套文件中包含 JSX，使用 `.server.tsx` 或 `.server.jsx`；JSX 运行时的说明见 [JSX 处理函数](/zh/guide/server-routing#jsx-handlers)。配套文件属于对应页面，不会创建独立路由：

| 文件 | 用途 |
| --- | --- |
| `pages/foo.tsx` | `/foo` 的页面组件 |
| `pages/foo.server.tsx` | 该页面的服务端配套文件 |

配套文件可以导出：

- [**loader**](/zh/guide/pages-routing/loaders)：在 `GET` 请求时运行，返回的数据会作为页面组件的 props
- [**Action**](/zh/guide/pages-routing/actions-and-forms)：处理表单和程序调用引起的数据变更。可以导出单个 `action`，页面包含多种数据变更操作时，也可以导出多个[命名 Action](/zh/guide/pages-routing/actions-and-forms#named-actions)
- `ssr = false`：让该路由不在服务端渲染组件 HTML，同时保留服务端 loader 和客户端路由

基于文件的路由规则与[服务端路由](/zh/guide/server-routing)相同：`[param]` 表示动态路径段，`[...param]` 匹配所有剩余路径，`(group)/` 表示路由组，`.dev` 或 `.prod` 后缀用于[仅在特定环境中启用的页面](#environment-only-pages)。

### 仅在特定环境中启用页面 {#environment-only-pages}

在扩展名前添加 `.dev` 或 `.prod` 后缀，可以让页面只在一种环境中启用。后缀不会出现在 URL 中：

```
pages/
  about.tsx       →  /about, always
  debug.dev.tsx   →  /debug, development only
  stats.prod.tsx  →  /stats, production only
  home.dev.tsx    →  /home in development
  home.prod.tsx   →  /home in production
```

`.dev` 页面只在开发服务器上运行；`.prod` 页面用于构建、部署和生产预览。

- `.dev` 页面与 `.prod` 页面可以共用一个 URL。如果无后缀页面与带后缀页面使用相同 URL，在两者同时启用的环境中会报错：`home.tsx` 与 `home.dev.tsx` 同时存在时，开发服务器会报错；`home.tsx` 与 `home.prod.tsx` 同时存在时，构建会失败。
- 环境后缀必须位于 `.island` **之前**：`chart.dev.island.tsx` 是仅在开发环境启用的 Islands 页面，`chart.island.dev.tsx` 则不是 Islands 页面。
- 配套文件必须使用相同后缀：`home.dev.server.ts` 属于 `home.dev.tsx`。
- 后缀只适用于页面文件，布局不使用后缀。
- 仅由 `.dev` 页面及其配套文件使用的资源，不会在生产环境中创建。
- 开发服务器和构建各自生成对应环境的类型。`void prepare` 会为两种环境生成类型。

## 导航如何工作 {#how-navigation-works}

首次请求会收到渲染好的 HTML。后续导航会运行 loader 并更新页面，无需重新加载文档。表单提交会运行 Action，随后刷新页面 props 或重定向。

如果希望某个路由不在服务端渲染组件 HTML，在它的配套 `.server.ts` 文件中导出 `ssr = false`：

```ts
// pages/dashboard.server.ts
import { defineHandler } from 'void';

export const ssr = false;

export const loader = defineHandler(async () => {
  return { title: 'Dashboard' };
});
```

loader 仍会在首次请求时运行，其 props 会嵌入 HTML 外壳。页面组件会在浏览器中挂载，而不是对服务端渲染的 HTML 进行水合。

渲染和预渲染标记可以按以下方式组合：

| 页面导出 | 行为 |
| --- | --- |
| 未设置 `ssr` 或设为 `true` | 收到请求时，在服务端渲染组件 HTML。 |
| `ssr = false` | 收到请求时，返回供客户端挂载的外壳。 |
| `ssr = false` + `prerender = true` | 预渲染供客户端挂载的外壳，并嵌入 loader 数据。 |
| `ssr = false` + `prerender = false` | 只在收到请求时返回供客户端挂载的外壳，始终不进行预渲染。 |
| Islands 页面 + `ssr = false` | 无效。Islands 页面已使用 Islands 渲染器。 |
| `output: "static"` + 未设置 `prerender` | 自动预渲染路径已知的页面，包括仅供客户端挂载的外壳。 |

使用 `Link` 组件在页面间进行 SPA 导航。它会渲染一个 `<a>` 标签，拦截点击并完成导航，无需重新加载整个页面：

::: code-group

```tsx [React]
import { Link } from "@void/react";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```vue [Vue]
<script setup lang="ts">
import { Link } from '@void/vue';
</script>

<template>
  <Link href="/users">Users</Link>
  <Link :href="`/users/${id}`">View</Link>
</template>
```

```svelte [Svelte]
<script>
  import { Link } from "@void/svelte";
</script>

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

```tsx [Solid]
import { Link } from "@void/solid";

<Link href="/users">Users</Link>
<Link href={`/users/${id}`}>View</Link>
```

:::

`Link` 还支持查询数据、替换历史记录、整页导航和取消导航：

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

`prefetch` 和 `reloadDocument` 只适用于 GET 链接。GET 链接的 `data` 会转为查询参数，请使用标量值或数组。

通过代码执行导航时，使用 `useRouter()`：

```ts
import { useRouter } from '@void/vue'; // or "@void/react", "@void/svelte", "@void/solid"

const router = useRouter();
router.visit('/users');
router.refresh(); // re-fetch current page props, keeping the same history entry
router.visit('/logout', { method: 'POST' }); // non-GET navigation
```

对于同源 URL，`router.visit()` 会直接更新当前页面。其他源的 `http(s)` URL 会触发整页加载，`javascript:` 等其他协议则会被拒绝。

要获取动态路由参数，从同一个适配器包中导入 `useParams()`：

```tsx
import { useParams } from '@void/react';

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  return <h1>Post {id}</h1>;
}
```

## 恢复滚动位置 {#scroll-restoration}

Void 会自动管理 Pages 的滚动位置：

- **后退、前进和重新加载**会恢复已保存的滚动位置。
- **新的导航**会滚动到页首。
- **锚点链接**（`/docs#api`）会滚动到目标元素。同页锚点链接（`#section`）完全不会向服务端请求数据。

要保留当前滚动位置，传入 `preserveScroll: true`：

```ts
router.visit('/users', { preserveScroll: true });
```

`Link` 也接受 `preserveScroll`：

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
