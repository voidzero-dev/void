---
outline: deep
---

# 类型安全 {#type-safety}

Void 会从数据库 schema、路由处理函数和页面 loader 中推断类型。修改字段后，TypeScript 会指出哪些查询、请求和组件需要随之调整。

## 类型传递流程 {#the-type-pipeline}

<img src="./type-pipeline.svg" alt="Type pipeline: Drizzle schema flows to DB types, branching into route handlers (typed fetch), page loaders (component props), and page actions (useForm / action())" style="max-width: 720px; width: 100%;" />

1. **数据库类型**来自 [Drizzle schema](/zh/guide/database#schema-definition)，在编译时即可确定列类型。
2. **路由处理函数：** 返回类型和校验器 schema 会生成 `RouteMap`，供[带类型的 fetch](/zh/guide/typed-fetch) 客户端使用。
3. **页面 loader：** 返回类型通过 `InferProps` 传入页面组件，作为 props 的类型。
4. **页面 Action：** 校验器 schema 传递给 `useForm` 和 `action()`，提供带类型的数据、错误信息及 URL 自动补全。

所有生成的类型都保存在 `.void/` 中，并在源文件或 schema 变更时自动更新。

## 数据库 → 处理函数 → 客户端 {#database-→-handler-→-client}

类型从 Drizzle schema 经由处理器传递到客户端，无需手动添加类型标注：

```ts
// routes/api/users.ts
export const GET = defineHandler(async (c) => {
  return db.select({ name: users.name, email: users.email }).from(users);
  //     ↑ return type inferred from schema columns
});

export const POST = defineHandler.withValidator({
  body: insertUserSchema, // ← derived from Drizzle schema
})(async (c, { body }) => {
  return db.insert(users).values(body).returning();
});
```

```ts
// Client: types inferred from handlers above
const users = await fetch('/api/users');
//    ↑ { name: string; email: string }[]

await fetch('/api/users', {
  method: 'POST',
  body: { name: 'Alice', email: 'alice@example.com' }, // ← typed from validator
});
```

Drizzle schema 同时定义了数据库列、运行时校验、处理函数输入类型和客户端类型检查。对于不直接对应数据表的接口，可以使用任意兼容 [Standard Schema](/zh/guide/server-routing#manual-validators) 的库。

## 从 loader 到页面 props {#loader-→-page-props}

在[页面模式](/zh/guide/pages-routing/overview)中，loader 的返回类型通过 `InferProps` 传递到页面组件：

```ts
// pages/users/index.server.ts
export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  return { users: await db.select().from(users) };
});
```

```vue
<!-- pages/users/index.vue -->
<script setup lang="ts">
import type { Props } from './index.server';
defineProps<Props>(); // ← { users: { id: number; name: string; ... }[] }
</script>
```

无需手写接口定义，props 会始终与 loader 的返回值保持同步。

## 从 Action 到 useForm {#action-→-useform}

当页面 Action 使用 `withValidator()` 时，请求体的 schema 会传递给 `useForm`。这样便能获得带类型的 `data`、受类型约束的 `errors` 键，以及 URL 自动补全：

```ts
// pages/users/create.server.ts
export const action = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  await db.insert(users).values(body);
});
```

```ts
const form = useForm('/users/create', { name: '', email: '' });
//                    ^ autocompletes     ^ must match body schema

form.errors.email; // ✓ string | undefined
form.errors.foo; // ✗ TypeScript error
```

[具名 Action](/zh/guide/pages-routing/actions-and-forms#named-actions) 也使用相同机制，`?actionName` 后缀会选用对应 Action 的类型：

```ts
const updateForm = useForm('/users/:id?update', { name: '' }, { params: { id } });
const deleteForm = useForm('/users/:id?delete', { id: '' }, { params: { id } });
// Each form's data and errors are typed from their respective validators
```

`action()` 辅助函数也提供相同的类型检查。完整 API 请参阅 [Action 与表单](/zh/guide/pages-routing/actions-and-forms)。

## 类型检查范围 {#what-gets-checked}

| 层级 | 类型检查内容 |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| 数据库 | Drizzle schema 定义的表列、值类型以及插入和更新的数据结构 |
| 处理函数 | `c.env` 绑定、校验器输入、返回类型 |
| Fetch 客户端 | 路由路径、HTTP 方法、`body`/`query`/`params`、响应类型 |
| `useForm` | Action URL、`data` 字段、`errors` 键、`reset()` 参数（包括 `{ initial: true }`）、`params`、`resetOnSuccess` |
| `action()` | Action URL、`data` 载荷、`params` |

## 序列化 {#serialization}

客户端类型通过 `Serialize<T>` 反映 JSON 序列化后的结果：

| 源类型 | 序列化后的类型 |
| --------------------------------- | ------------------------------------------------------ |
| `string`、`number`、`boolean` | 不变 |
| `Date` | `string` |
| `Response` | 排除在序列化类型之外（运行时直接透传） |
| `bigint`、`Function`、`undefined` | 排除 |
| `Array<T>` / `{ key: T }` | 递归序列化（移除值为函数的键） |

## 上下文变量 {#context-variables}

中间件和处理器通过 Hono 上下文变量共享带类型的数据。扩展 `CloudContextVariables` 即可定义自己的变量：

```ts
// middleware/01.auth.ts
declare module 'void' {
  interface CloudContextVariables {
    requestId: string;
  }
}

export default defineMiddleware(async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});
```

此后，在任意位置调用 `c.get("requestId")` 都会返回 `string`，无需类型断言。分散在不同文件中的多个扩展会[合并](https://www.typescriptlang.org/docs/handbook/declaration-merging.html)。

## 配置 {#setup}

在项目中继承生成的 tsconfig：

```json
{
  "extends": "./.void/tsconfig.json",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "types": ["void/env"]
  },
  "include": ["src", "routes", "middleware", "crons", "queues"]
}
```

如果已有 TypeScript 配置，运行 `void init --tsconfig` 即可添加 Void 类型，同时保留原有设置。

在 CI 中或首次克隆后运行 `void prepare`。也可以在应用的常规开发流程中，让 `vite dev` / `vite build` 自动生成 `.void/` 文件。
