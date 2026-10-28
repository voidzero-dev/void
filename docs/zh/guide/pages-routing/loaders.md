---
outline: deep
---

# Loader 与 props {#loaders-props}

loader 用于获取页面所需的数据。在配套的 `.server.ts` 文件中定义它，使用与[服务端路由](/zh/guide/server-routing)相同的 `defineHandler` API。

## 定义 loader {#defining-a-loader}

`loader` 在 GET 请求时运行，返回的对象会成为页面的 props：

```ts
import { users } from '@schema';
// pages/users/index.server.ts
import { defineHandler } from 'void';
import type { InferProps } from 'void';
import { db } from 'void/db';

export type Props = InferProps<typeof loader>; // [!code highlight]

export const loader = defineHandler(async (c) => {
  return { users: await db.select().from(users) };
});
```

`InferProps` 会推断 loader 的返回类型，使页面 props 始终与返回的数据保持一致。

## 在页面组件中使用数据 {#using-the-data-in-page-components}

页面组件通过 props 接收 loader 的结果。从服务端文件导出推断出的类型，即可让组件与数据保持一致：

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
import { For } from 'solid-js';
// pages/users/index.tsx
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

## 延迟加载的 props {#deferred-props}

对于加载较慢的数据，使用 `defer()`。页面会立即渲染，并在数据就绪后接收结果：

```ts
import { projects } from '@schema';
// pages/dashboard.server.ts
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

`usage` 仍在加载时，页面就可以渲染 `projects`。React 中，在 Suspense 内通过 `use()` 读取 `usage`；其他适配器则将其表示为 `{ loading, value, error }`。

### 处理延迟加载状态 {#handling-deferred-state}

在 React 中，`Deferred<T>` 作为 Promise 使用。将延迟数据的读取放在 `<Suspense>` 边界内，并在需要该值的位置调用 `use()`：

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

延迟加载的 props 被拒绝时，`use()` 会抛出错误。如果页面需要显示自定义的失败状态，请在 Suspense 边界外包裹普通的 React 错误边界。如果要显式标注 React props 的类型，从 `@void/react` 导入 `Deferred`；适配器导出的这个类型是 `Promise<T>`。

生产环境中，延迟加载的 props 出现非预期错误时，页面收到的消息为 `Internal Server Error`。如需显示自己的提示信息，请抛出 [`HTTPException`](/integrations/hono#utilities)。

在 Vue、Svelte 和 Solid 中，`Deferred<T>` 是一个包含三种状态的[可辨识联合类型](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)：

```ts
type Deferred<T> =
  | { loading: true; value: null; error: null } // pending
  | { loading: false; value: T; error: null } // resolved
  | { loading: false; value: null; error: Error }; // rejected
```

先检查 `loading`，再检查 `error`。在已完成的分支中，TypeScript 会将 `value` 收窄为 `T`：

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

### 数据变更后的延迟 props {#deferred-props-after-mutations}

::: info
Action 执行后，延迟 props 会保留上次已完成加载的值，直到下次加载页面或进行客户端导航。loader 返回的其他 props 则会立即刷新。
:::

### 为延迟 props 分组 {#grouped-deferred-props}

多个 props 依赖同一个较慢的操作时，可以将它们放入具名分组，通过一次函数调用一起取得结果：

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

`metrics` 和 `chart` 由同一次分析数据加载函数调用取得结果。组件接收到的仍是两个独立的 `Deferred<T>` props。
