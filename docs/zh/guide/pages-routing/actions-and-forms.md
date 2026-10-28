---
outline: deep
---

# Action 与表单 {#actions-forms}

使用 Action，从表单或按钮发起服务端数据变更。在页面配套的 `.server.ts` 文件中，通过 `defineHandler` 定义 Action，用法与 [loader](/zh/guide/pages-routing/loaders) 或[服务端路由](/zh/guide/server-routing)相同。Action 处理 `POST`、`PUT`、`PATCH` 和 `DELETE` 请求。

## 定义 Action {#defining-an-action}

从 `.server.ts` 文件导出 `action`。将 `withValidator()` 与[从 schema 派生的校验器](/zh/guide/database#schema-derived-validators)结合使用，校验请求体：

```ts
import { users, insertUserSchema } from '@schema';
// pages/users/index.server.ts
import { defineHandler } from 'void';
import { db } from 'void/db';

export const action = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  await db.insert(users).values(body);
  // No return → re-runs loader, page re-renders with fresh data
});
```

| Action 的返回值 | 行为 |
| --------------------- | ----------------------------------------------------- |
| 无返回值（void） | 重新运行 loader，页面使用最新 props 重新渲染。 |
| `c.redirect('/path')` | 导航到其他页面。 |

## Form {#form}

配合使用 `Form` 和 `useForm`，可以提交表单值并显示校验错误和 Action 错误。提交失败后，输入框仍可编辑。

从框架适配器导入 `Form`，传入 `form`，也可指定 `method="put"`、`"patch"` 或 `"delete"`；默认为 `"post"`。通过 `renderError` 自定义 Action 错误的渲染方式；Svelte 中使用 snippet。

## `useForm` {#useform}

`useForm` 负责提交、加载状态和校验错误。URL、表单值和错误字段的类型都由 Action 推断。

向上面定义的 `/users` Action 提交：

::: code-group

```tsx [React]
// pages/users/index.tsx
import { Form, useForm } from '@void/react';
import { useFormStatus } from 'react-dom';

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>Create</button>;
}

export default function CreateUser() {
  const form = useForm('/users', { name: '', email: '' });

  return (
    <Form form={form}>
      <input
        name="name"
        value={form.data.name}
        onChange={(e) => form.setData('name', e.target.value)}
      />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input
        name="email"
        value={form.data.email}
        onChange={(e) => form.setData('email', e.target.value)}
      />
      {form.errors.email && <span>{form.errors.email}</span>}

      <SubmitButton />
    </Form>
  );
}
```

```vue [Vue]
<!-- pages/users/index.vue -->
<script setup lang="ts">
import { Form, useForm } from '@void/vue';

const form = useForm('/users', { name: '', email: '' });
</script>

<template>
  <Form :form="form">
    <input v-model="form.data.name" />
    <span v-if="form.errors.name">{{ form.errors.name }}</span>

    <input v-model="form.data.email" />
    <span v-if="form.errors.email">{{ form.errors.email }}</span>

    <button :disabled="form.pending">Create</button>
  </Form>
</template>
```

```svelte [Svelte]
<!-- pages/users/index.svelte -->
<script>
  import { Form, useForm } from "@void/svelte";

  const form = useForm("/users", { name: "", email: "" });
</script>

<Form {form}>
  <input bind:value={form.data.name} />
  {#if form.errors.name}<span>{form.errors.name}</span>{/if}

  <input bind:value={form.data.email} />
  {#if form.errors.email}<span>{form.errors.email}</span>{/if}

  <button disabled={form.pending}>Create</button>
</Form>
```

```tsx [Solid]
// pages/users/index.tsx
import { Form, useForm } from '@void/solid';

export default function CreateUser() {
  const form = useForm('/users', { name: '', email: '' });

  return (
    <Form form={form}>
      <input value={form.data.name} onInput={(e) => form.setData('name', e.target.value)} />
      {form.errors.name && <span>{form.errors.name}</span>}

      <input value={form.data.email} onInput={(e) => form.setData('email', e.target.value)} />
      {form.errors.email && <span>{form.errors.email}</span>}

      <button disabled={form.pending}>Create</button>
    </Form>
  );
}
```

:::

类型会根据配套 `.server.ts` 文件中 Action 的 `withValidator()` schema 推断。如果没有定义校验器，请求体类型会回退为 `Record<string, unknown>`，但仍提供 URL 自动补全。

### `useForm` API {#useform-api}

`useForm` 返回一个响应式对象，包含：

| 属性 / 方法 | 用途 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data` / `setData` | 当前表单值，类型与 Action 请求体的 schema 一致。 |
| `errors` | 字段级校验错误，键的类型限定为请求体字段名。 |
| `error` | Action 错误，或 `null`。 |
| `post`、`put`、`patch`、`delete` | 使用对应方法提交表单。在 React 中，它们是原生表单的 Action 回调。 |
| `pending` | 提交进行期间为 `true`。 |
| `hasChanges` | 表单数据与当前默认值不同时为 `true`。提交成功后，默认值会更新为本次提交的值，因此 `hasChanges` 会变为 `false`。 |
| `wasSuccessful` | 提交成功后为 `true`，直到下一次提交前都保持为 `true`。 |
| `recentlySuccessful` | 提交成功后的 2 秒内为 `true`，适合显示短暂的成功提示。 |
| `reset(...fields)` | 将表单数据重置为当前默认值（提交成功后，默认值会更新为上次提交的值）。字段名支持自动补全。将 `{ initial: true }` 作为第一个参数传入，可以重置为最初传给 `useForm` 的值。 |
| `resetOnSuccess`（选项） | 设为 `true` 时，提交成功后会将表单数据和默认值都重置为组件挂载时的值。适用于保存后需要清空的创建表单。 |
| `setError(field, message)` | 为某个字段设置客户端校验错误。 |
| `clearErrors(...fields)` | 清除校验错误，字段名支持自动补全。 |
| `clearError()` | 清除 `error`。 |

使用 `setError()` 显示自行执行客户端校验时产生的错误。设置某个字段的错误不会清除其他字段的错误。修改字段会自动清除该字段的校验错误：React 和 Solid 通过 `setData` 修改，Vue 和 Svelte 则直接给 `data` 赋值。

使用 React 原生表单时，将 `form.post`、`form.put`、`form.patch` 或 `form.delete` 作为原生表单 Action。如果需要等待变更完成，则使用 `action()`。在 Vue、Svelte 和 Solid 中，表单提交返回 `Promise<void>`；请捕获抛出的错误，或使用框架的错误处理机制。

对于动态路由，在选项中传入 `params`：

```ts
// pages/users/[id].server.ts has an action
const form = useForm('/users/:id', { name: '' }, { params: { id: '42' } });
<Form form={form} method="put">{/* submits to /users/42 */}</Form>
```

创建表单通常需要在保存成功后重新清空字段。可以在第三个参数中传入 `resetOnSuccess: true`，也可以在 `form.wasSuccessful` 变为 `true` 时调用 `form.reset({ initial: true })`。

### React 提交回调 {#react-submission-callbacks}

在 React 中，向 `useForm()` 传入 `onSuccess` 和 `onError`，即可在提交后执行相应处理：

```tsx
const form = useForm(
  '/users',
  { name: '', email: '' },
  {
    onSuccess: () => setDialogOpen(false),
    onError: (error) => {
      // A field-error map or VoidActionError for a handled action failure.
      console.error(error);
    },
  },
);
```

每次提交都使用发起时的回调。回调在 React Action 内执行，此时 UI 更新尚未提交。如果要聚焦提交后才出现的元素，请使用 effect 或 ref 回调。

回调可以返回 `Promise<void>`。Action 会等待其完成，在此期间 `form.pending` 始终为 true。回调抛出错误或返回的 Promise 被拒绝时，错误会交给最近的 React 错误边界。已中止的提交不会调用上述任一回调。

Vue、Svelte 和 Solid 的提交会返回 Promise；使用 `await form.post()`，即可在提交后继续执行其他操作。

## 具名 Action {#named-actions}

如果页面需要执行多种数据变更，例如在同一页面中更新和删除用户，请导出 `actions`（复数），而不是 `action`：

```ts
import { users, updateUserSchema } from '@schema';
// pages/users/[id].server.ts
import { defineHandler } from 'void';
import { db, eq } from 'void/db';

export const actions = {
  update: defineHandler.withValidator({
    body: updateUserSchema,
  })(async (c, { body }) => {
    await db
      .update(users)
      .set(body)
      .where(eq(users.id, Number(c.req.param('id'))));
  }),

  delete: defineHandler(async (c) => {
    await db.delete(users).where(eq(users.id, Number(c.req.param('id'))));
  }),
};
```

具名 Action 通过 URL 上的 `?actionName` 后缀分发，例如 `/users/42?update`。客户端的 `useForm` 和 `action()` 会自动处理。Action 名称不会保留在页面 URL 中。当 `POST /users/42?update&tab=profile` 导致页面再次渲染时，`useForm` 和 `action()` 会让地址栏保持为 `/users/42?tab=profile`，而 `c.redirect('/users/42')` 也会跳转到 `/users/42?tab=profile`。

一个文件中使用 `action` 或 `actions` 之一，不要同时使用。

还可以定义 `actions.default`，作为未指定名称时执行的 Action，也就是直接向页面 URL 发起 POST 的情况：

```ts
export const actions = {
  default: defineHandler(async (c) => {
    // runs on POST /users/edit (no ?suffix)
  }),
  delete: defineHandler(async (c) => {
    // runs on POST /users/edit?delete
  }),
};
```

### 在 `useForm` 中使用具名 Action {#named-actions-with-useform}

页面导出具名 Action 时，在 URL 后添加 `?actionName`：

```ts
const form = useForm('/users/:id?update', { name: '' }, { params: { id } });
<Form form={form} method="put">{/* submits to /users/42?update */}</Form>
```

每个具名 Action 都有自己的校验 schema，为其 URL、请求体和错误键提供类型。示例见[类型安全](/zh/guide/type-safety#action-%E2%86%92-useform)。

## `action()` 辅助函数 {#action-helper}

对于不需要表单状态的按钮或其他数据变更操作，使用 `action()`。请求成功后，它会更新页面：

```ts
import { action } from '@void/react'; // or "@void/vue", "@void/svelte", "@void/solid"

const result = await action('/users/:id?delete', {
  params: { id: '42' },
  method: 'DELETE',
});
if (!result.ok) {
  showToast(result.error.message);
}
```

`action()` 默认使用 `POST`。传入 `data`、`params` 和 `method`，分别设置请求体、路由参数和 HTTP 方法。

调用成功时返回 `{ ok: true, pageData }`。校验失败或冲突等预期错误则返回 `{ ok: false, error }`。

## 校验错误 {#validation-errors}

`withValidator()` 和 `ValidationError` 会自动填充 `form.errors`。

`400`、`404`、`409`、`422` 和 `429` 等预期错误由对应的表单或 Action 调用处理。`useForm` 将它们保存在 `form.errors` 或 `form.error` 中；`action()` 则返回 `{ ok: false, error }`。

身份验证和权限错误（`401`、`403`）、服务端错误（`500`、`502`）及其他非预期失败会直接抛出。请使用框架的错误边界或错误处理机制处理。

Action 可以抛出 `ValidationError`，实现自定义校验逻辑：

```ts
import { defineHandler, ValidationError } from 'void/handler';

export const action = defineHandler(async (c) => {
  const body = await c.req.json();
  if (await emailExists(body.email)) {
    throw new ValidationError({ email: 'Email already taken' });
  }
  // ...
});
```

### 用量限制 {#usage-limits}

在调用 [AI](/zh/guide/ai#usage-limits) 和 [Sandbox](/zh/guide/sandboxes#usage-limits) 的 Action 中，未捕获的 `UsageLimit` 会自动生成结构化的 HTTP 429 响应。如需自定义提示信息，使用 `instanceof UsageLimit` 捕获错误，再返回 `error.response({ message: 'Try again shortly. Your draft is still editable.' })`。`Form` 会显示提示；如果已知可重试时间，会等待到该时间后才允许重新提交。字段仍可编辑，且不会自动重试。

## 身份验证与源检查 {#authentication-and-origin-checks}

浏览器提交必须与页面同源，包括协议、主机名和端口。Void 会以 `403 Forbidden` 拒绝跨源的页面 Action。服务端客户端可以在不带浏览器来源请求头的情况下调用 Action，但访问受保护数据时，Action 仍需执行身份验证和权限检查。

## 文件上传 {#file-uploads}

将 `File`、`Blob` 或 `FileList` 放入表单数据后提交，`useForm` 会以 `multipart/form-data` 发送：

::: code-group

```tsx [React]
import { Form, useForm } from '@void/react';

export default function Upload() {
  const form = useForm('/photos', { title: '', photo: null as File | null });

  return (
    <Form form={form}>
      <input value={form.data.title} onChange={(e) => form.setData('title', e.target.value)} />
      <input type="file" onChange={(e) => form.setData('photo', e.target.files?.[0] ?? null)} />
      <button disabled={form.pending}>Upload</button>
    </Form>
  );
}
```

```vue [Vue]
<script setup lang="ts">
import { ref } from 'vue';
import { Form, useForm } from '@void/vue';

const form = useForm('/photos', { title: '', photo: null as File | null });
const fileInput = ref<HTMLInputElement>();

function onFileChange() {
  form.data.photo = fileInput.value?.files?.[0] ?? null;
}
</script>

<template>
  <Form :form="form">
    <input v-model="form.data.title" />
    <input type="file" ref="fileInput" @change="onFileChange" />
    <button :disabled="form.pending">Upload</button>
  </Form>
</template>
```

```svelte [Svelte]
<script>
  import { Form, useForm } from "@void/svelte";

  const form = useForm("/photos", { title: "", photo: null });
</script>

<Form {form}>
  <input bind:value={form.data.title} />
  <input type="file" onchange={(e) => { form.data.photo = e.target.files?.[0] ?? null; }} />
  <button disabled={form.pending}>Upload</button>
</Form>
```

```tsx [Solid]
import { Form, useForm } from '@void/solid';

export default function Upload() {
  const form = useForm('/photos', { title: '', photo: null as File | null });

  return (
    <Form form={form}>
      <input value={form.data.title} onInput={(e) => form.setData('title', e.target.value)} />
      <input type="file" onChange={(e) => form.setData('photo', e.target.files?.[0] ?? null)} />
      <button disabled={form.pending}>Upload</button>
    </Form>
  );
}
```

:::

在服务端，使用 `c.req.parseBody()` 访问上传文件：

```ts
// pages/photos.server.ts
import { defineHandler, ValidationError } from 'void/handler';
import { storage } from 'void/storage';

// file.name and file.type come from the browser. Don't use them as the key or trust the type.
const imageTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export const action = defineHandler(async (c) => {
  const body = await c.req.parseBody();
  const file = body['photo'];
  if (!(file instanceof File) || file.size === 0) return;
  const ext = imageTypes.get(file.type);
  if (!ext) {
    throw new ValidationError({ photo: 'Upload a JPEG, PNG, or WebP image.' });
  }
  await storage.put(`uploads/${crypto.randomUUID()}.${ext}`, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
});
```

由服务端决定存储键，并只允许预期的文件类型。如何安全地返回文件，请参阅[提供文件访问](/zh/guide/storage#serving-files)。

## 选择合适的调用方式 {#choosing-a-primitive}

| 调用方式 | 更新页面 | 表单状态 | 是否与框架相关 |
| ---------------- | ----------- | -------------------------- | ------------------ |
| `useForm` | 是 | 是（错误、修改状态、重置） | 是 |
| `action()` | 是 | 否 | 是 |
| 原生 `fetch()` | 否 | 否 | 否 |
