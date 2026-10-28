---
outline: deep
---

# Pages 适配器 {#framework-adaptors}

[页面路由](/zh/guide/pages-routing/overview)的框架适配器。每个适配器都提供 Vite 插件和客户端运行时。

## `@void/vue` {#void-vue}

### `voidVue(options?)` {#voidvue-options}

从 `"@void/vue/plugin"` 导入。返回一个 Vite 插件数组，用于编译 Vue SFC，并生成 SSR 或水合入口。已包含 `@vitejs/plugin-vue`，无需单独安装或配置。

```ts
import { voidVue } from '@void/vue/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
});
```

**签名：**

```ts
function voidVue(options?: VoidVueOptions): Plugin[];
```

**选项：**

```ts
interface VoidVueOptions {
  vue?: VuePluginOptions; // passed through to @vitejs/plugin-vue
  viewTransitions?: boolean; // enable View Transitions API for navigations
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### Vue 运行时 {#vue-runtime}

从 `"@void/vue"` 导入。

| 导出                               | 说明                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | 用于 SPA 导航的 Vue 组件。GET 方法渲染为 `<a>`，非 GET 方法渲染为 `<button>`。Props：`href`、`method`、`data`、`prefetch`、`cacheFor`、`preserveScroll`、`preserveState`、`replace`、`reloadDocument`、`viewTransition`、`onNavigate`。 |
| `useRouter()`                      | 返回 Void Router，包含当前路由状态（`url`、`path`、`query`、`params`）和导航方法：`visit`、`refresh`、可等待完成的 `prefetch`、`flush`、`flushAll`。                                                                                                |
| `useParams()`                      | 返回当前正在渲染的页面的动态路由参数。                                                                                                                                                                                                            |
| `useNavigation()`                  | 返回正在进行的导航状态：`{ state, location, method }`。其中，`state` 为 `"idle"`、`"loading"` 或 `"submitting"`，`location` 为待前往的目标位置。                                                                                                |
| `useForm(url, defaults, options?)` | 绑定到页面 Action URL 的类型化响应式表单辅助函数。返回 `{ data, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, setError, clearErrors, clearError }`。                                                   |
| `useIslandForm(defaults)`          | 交互岛组件的表单辅助函数。表单状态与 `useForm()` 相同，并额外提供 `submit(url, method)`。`post(url)`、`put(url)`、`patch(url)` 和 `delete(url)` 接受 Action URL，通过 `fetch()` 提交。                                                                  |
| `action(url, options?)`            | 执行单次页面 Action 的辅助函数，支持等待完成。默认使用 `POST`，接受 `{ data, method, params }`，其中 `method` 可以为 `"PUT"`、`"PATCH"` 或 `"DELETE"`。返回 `ActionResult`。                                                                         |
| `useShared()`                      | 返回中间件通过 `c.set("shared", {...})` 注入的共享数据。                                                                                                                                                                                           |

Vue `Link` 的 GET `data` 会合并到渲染后的 `href` 查询字符串中。原始类型的值通过 `String(value)` 序列化，数组会转换为重复的键，`null` 和 `undefined` 会被省略，嵌套对象则会抛出异常。`prefetch` 和 `reloadDocument` 仅支持 GET，用于数据变更链接时会抛出异常。

Vue 在 GET 导航时会重新挂载页面，让 `useForm()` 获取目标路由记录的 URL 和默认值；布局会保留。数据变更操作和 `router.refresh()` 默认保留页面状态。在同一路由记录内导航时，可显式设置 `preserveState` 覆盖默认行为。

## `@void/react` {#void-react}

### `voidReact(options?)` {#voidreact-options}

从 `"@void/react/plugin"` 导入。返回一个 Vite 插件数组，用于生成 SSR 和水合入口。已包含 `@vitejs/plugin-react`，无需单独安装或配置。

```ts
import { voidReact } from '@void/react/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

**签名：**

```ts
function voidReact(options?: VoidReactOptions): Plugin[];
```

**选项：**

```ts
interface VoidReactOptions {
  react?: ReactPluginOptions; // passed through to @vitejs/plugin-react
  viewTransitions?: boolean; // enable View Transitions API for navigations
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### React 运行时 {#react-runtime}

从 `"@void/react"` 导入。

| 导出                               | 说明                                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | 用于 SPA 导航的 React 组件。GET 方法渲染为 `<a>`，非 GET 方法渲染为 `<button>`。Props：`href`、`method`、`data`、`prefetch`、`cacheFor`、`preserveScroll`、`preserveState`、`replace`、`reloadDocument`、`viewTransition`、`onNavigate`。 |
| `useRouter()`                      | 返回 Void Router，包含当前路由状态（`url`、`path`、`query`、`params`）和导航方法：`visit`、`refresh`、可等待完成的 `prefetch`、`flush`、`flushAll`。React 导航会作为过渡更新（transition）调度。                                                             |
| `useParams()`                      | 返回当前正在渲染的页面的动态路由参数。                                                                                                                                                                                                              |
| `useNavigation()`                  | 返回正在进行的导航状态：`{ state, location, method }`。其中，`state` 为 `"idle"`、`"loading"` 或 `"submitting"`，`location` 为待前往的目标位置。                                                                                                  |
| `useForm(url, defaults, options?)` | 表单辅助 Hook。返回 `{ data, setData, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, setError, clearErrors, clearError }`。                                                                 |
| `useIslandForm(defaults)`          | 交互岛组件的表单辅助 Hook。表单状态与 `useForm()` 相同。`post(url)`、`put(url)`、`patch(url)` 和 `delete(url)` 接受 Action URL，通过 `fetch()` 提交。                                                                                                  |
| `action(url, options?)`            | 执行单次页面 Action 的辅助函数，支持等待完成。默认使用 `POST`，接受 `{ data, method, params }`，其中 `method` 可以为 `"PUT"`、`"PATCH"` 或 `"DELETE"`。返回 `ActionResult`。                                                                           |
| `useShared()`                      | 返回中间件通过 `c.set("shared", {...})` 注入的共享数据。                                                                                                                                                                                             |
| `Deferred<T>`                      | React 专用的 prop 类型，用于 `defer()` 的结果。它是 `Promise<T>`，通过 React 的 `use()` 读取。                                                                                                                                                        |

React `Link` 的 GET `data` 会合并到渲染后的 `href` 查询字符串中。原始类型的值通过 `String(value)` 序列化，数组会转换为重复的键，`null` 和 `undefined` 会被省略，嵌套对象则会抛出异常。`prefetch` 和 `reloadDocument` 仅支持 GET，用于数据变更链接时会抛出异常。

React `useForm()` 的选项支持 `onSuccess?: () => void | Promise<void>` 和 `onError?: (error: Record<string, string> | VoidActionError) => void | Promise<void>`。每次提交都会捕获当次回调，在 UI 更新提交前执行，并等待回调返回的 Promise 完成。参见[提交回调](/zh/guide/pages-routing/actions-and-forms#react-submission-callbacks)。

React 中，`defer()` 返回的延迟加载 props 是 Suspense 资源。请在 `<Suspense>` 边界内通过 React 的 `use()` 读取它们。React Pages 要求 React 19，并通过流式 SSR 渲染初始的延迟加载页面外壳。Promise 被拒绝时，`use()` 会抛出错误，因此自定义延迟加载错误 UI 应使用普通的 React 错误边界。Vue、Svelte 和 Solid 仍使用 `{ loading, value, error }` 延迟加载状态对象。显式标注 props 类型时，请从框架适配器包（`@void/react`、`@void/vue`、`@void/svelte` 或 `@void/solid`）导入 `Deferred`，确保类型与该适配器的客户端运行时结构一致。

## `@void/svelte` {#void-svelte}

### `voidSvelte(options?)` {#voidsvelte-options}

从 `"@void/svelte/plugin"` 导入。返回一个 Vite 插件数组，用于为 Svelte 5 生成 SSR 和水合入口。已包含 `@sveltejs/vite-plugin-svelte`，无需单独安装或配置。

```ts
import { voidSvelte } from '@void/svelte/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

**签名：**

```ts
function voidSvelte(options?: VoidSvelteOptions): Plugin[];
```

**选项：**

```ts
interface VoidSvelteOptions {
  svelte?: SveltePluginOptions; // passed through to @sveltejs/vite-plugin-svelte
  viewTransitions?: boolean; // enable View Transitions API
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### Svelte 运行时 {#svelte-runtime}

从 `"@void/svelte"` 导入。

| 导出                               | 说明                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | 用于 SPA 导航的 Svelte 组件。GET 方法渲染为 `<a>`，非 GET 方法渲染为 `<button>`。Props：`href`、`method`、`data`、`prefetch`、`cacheFor`、`preserveScroll`、`preserveState`、`replace`、`reloadDocument`、`viewTransition`、`onNavigate`。 |
| `useForm(url, defaults, options?)` | 使用 Svelte 5 runes 的表单辅助函数。返回 `{ data, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, setError, clearErrors, clearError }`。                                                           |
| `useIslandForm(defaults)`          | 交互岛组件的表单辅助函数。表单状态与 `useForm()` 相同，并额外提供 `submit(url, method)`。`post(url)`、`put(url)`、`patch(url)` 和 `delete(url)` 接受 Action URL，通过 `fetch()` 提交。                                                                     |
| `action(url, options?)`            | 执行单次页面 Action 的辅助函数，支持等待完成。默认使用 `POST`，接受 `{ data, method, params }`，其中 `method` 可以为 `"PUT"`、`"PATCH"` 或 `"DELETE"`。返回 `ActionResult`。                                                                            |
| `useShared()`                      | 返回中间件通过 `c.set("shared", {...})` 注入的共享数据。                                                                                                                                                                                              |
| `useRouter()`                      | 返回 Void Router，包含当前路由状态（`url`、`path`、`query`、`params`）和导航方法：`visit`、`refresh`、可等待完成的 `prefetch`、`flush`、`flushAll`。                                                                                                   |
| `useParams()`                      | 返回当前正在渲染的页面的动态路由参数。                                                                                                                                                                                                               |
| `useNavigation()`                  | 返回正在进行的导航状态：`{ state, location, method }`。其中，`state` 为 `"idle"`、`"loading"` 或 `"submitting"`，`location` 为待前往的目标位置。                                                                                                   |

Svelte `Link` 的 GET `data` 会合并到渲染后的 `href` 查询字符串中。原始类型的值通过 `String(value)` 序列化，数组会转换为重复的键，`null` 和 `undefined` 会被省略，嵌套对象则会抛出异常。`prefetch` 和 `reloadDocument` 仅支持 GET，用于数据变更链接时会抛出异常。

## `@void/solid` {#void-solid}

### `voidSolid(options?)` {#voidsolid-options}

从 `"@void/solid/plugin"` 导入。返回一个 Vite 插件数组，用于为 Solid 生成 SSR 和水合入口。已包含 `vite-plugin-solid`，无需单独安装或配置。

```ts
import { voidSolid } from '@void/solid/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
});
```

**签名：**

```ts
function voidSolid(options?: VoidSolidOptions): Plugin[];
```

**选项：**

```ts
interface VoidSolidOptions {
  solid?: SolidPluginOptions; // passed through to vite-plugin-solid
  viewTransitions?: boolean; // enable View Transitions API
  prefetch?: {
    hoverDelay?: number;
    cacheFor?: number | string | [string, string];
  };
}
```

### Solid 运行时 {#solid-runtime}

从 `"@void/solid"` 导入。

| 导出                               | 说明                                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Link`                             | 用于 SPA 导航的 Solid 组件。GET 方法渲染为 `<a>`，非 GET 方法渲染为 `<button>`。Props：`href`、`method`、`data`、`prefetch`、`cacheFor`、`preserveScroll`、`preserveState`、`replace`、`reloadDocument`、`viewTransition`、`onNavigate`。 |
| `useForm(url, defaults, options?)` | 使用 Solid store 的表单辅助函数。返回 `{ data, setData, post, put, patch, delete, pending, errors, error, hasChanges, wasSuccessful, recentlySuccessful, reset, setError, clearErrors, clearError }`。                                                   |
| `useIslandForm(defaults)`          | 交互岛组件的表单辅助函数。表单状态与 `useForm()` 相同。`post(url)`、`put(url)`、`patch(url)` 和 `delete(url)` 接受 Action URL，通过 `fetch()` 提交。                                                                                                       |
| `action(url, options?)`            | 执行单次页面 Action 的辅助函数，支持等待完成。默认使用 `POST`，接受 `{ data, method, params }`，其中 `method` 可以为 `"PUT"`、`"PATCH"` 或 `"DELETE"`。返回 `ActionResult`。                                                                           |
| `useShared()`                      | 返回中间件通过 `c.set("shared", {...})` 注入的共享数据。                                                                                                                                                                                             |
| `useRouter()`                      | 返回 Void Router，包含当前路由状态（`url`、`path`、`query`、`params`）和导航方法：`visit`、`refresh`、可等待完成的 `prefetch`、`flush`、`flushAll`。                                                                                                  |
| `useParams()`                      | 返回当前正在渲染的页面的动态路由参数。                                                                                                                                                                                                              |
| `useNavigation()`                  | 返回正在进行的导航状态：`{ state, location, method }`。其中，`state` 为 `"idle"`、`"loading"` 或 `"submitting"`，`location` 为待前往的目标位置。                                                                                                  |

Solid `Link` 的 GET `data` 会合并到渲染后的 `href` 查询字符串中。原始类型的值通过 `String(value)` 序列化，数组会转换为重复的键，`null` 和 `undefined` 会被省略，嵌套对象则会抛出异常。`prefetch` 和 `reloadDocument` 仅支持 GET，用于数据变更链接时会抛出异常。

Solid 在 GET 导航时，以及路由或其参数变化时，会重新创建页面，让 `useForm()` 获取目标路由记录的 URL 和默认值；布局会保留。在同一路由记录内，后退/前进、数据变更操作和 `router.refresh()` 会保留页面，并原地更新 props；延迟加载的 props 就绪时也会如此。因此，请在 JSX 或 memo 中读取 props，不要在组件函数体中复制这些值。在同一路由记录内导航时，可显式设置 `preserveState` 覆盖默认行为。

## Markdown 包 {#markdown-package}

可选的 `@void/md` 包为页面路由添加 Markdown 页面支持。请与 Pages 适配器一起安装，并将 `voidMarkdown()` 添加到 Vite 插件中。

```ts
import { voidMarkdown } from '@void/md/plugin';

export default defineConfig({
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});
```

| 导入路径                     | 内容                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `@void/md/plugin`            | `voidMarkdown(options?)`, `MarkdownOptions`, `MdPage`                                    |
| `@void/md`                   | `useFrontmatter()`, `MdPage`                                                             |
| `@void/md/pages`             | 为 Markdown 页面生成的元数据，可用于导航、侧边栏和搜索索引                                |
| `@void/md/theme.css`         | 完整的 Markdown 主题样式                                                                 |
| `@void/md/theme-content.css` | 仅包含内容区域的 Markdown 样式，适用于自行提供外壳或布局的应用                            |

`FrontmatterContext` 和 `setFrontmatter()` 已弃用，请使用 `useFrontmatter()`。

配置方法和各框架专用示例，参见 [Markdown 页面](/zh/guide/pages-routing/markdown)。

## Form {#form}

每个 Pages 适配器都导出 `Form`。将 `useForm()` 返回的对象作为 `form` 传入；`method` 默认为 `post`。它会渲染校验错误和 Action 错误，保留受控输入状态，并遵守已知的配额重试等待时间，但不会自动提交。`renderError` 用于自定义 Action 错误的展示方式；Svelte 使用 snippet。参见 [Action 与表单](/zh/guide/pages-routing/actions-and-forms)。
