---
outline: deep
---

# 环境变量 {#environment}

从 `"void/env"` 导入。

## `defineEnv(schema)` {#defineenv-schema}

注册环境变量 schema，并返回类型化的 [`env`](#env) 代理。Void 会自动发现 `env.ts`，在开发、构建和部署时导入它，生成 `.void/env.d.ts`，在部署前校验生产环境密钥，并在 Worker 启动时校验值。

```ts
import { defineEnv, string, number, oneOf, url } from 'void/env';

export default defineEnv({
  STRIPE_KEY: string(),
  PORT: number().default(3000),
  NODE_ENV: oneOf(['development', 'production']),
  VITE_PUBLIC_URL: url(),
});
```

## `env` {#env}

已声明环境变量键的类型化运行时代理。未声明的键和绑定仍可透传访问，其类型为 `unknown`。

```ts
import { env } from 'void/env';

const port = env.PORT;
```

## Schema 辅助函数 {#schema-helpers}

`void/env` 提供兼容 Standard Schema 的辅助函数：`string()`、`number()`、`boolean()`、`url()`、`email()`、`oneOf([...])` 和 `json<T>()`。每个辅助函数都支持 `.optional()` 和 `.default(value)`。

非客户端键属于服务端值，在生产环境中使用远程密钥存储。`VITE_*` 键是构建时提供给客户端的公开值。无效输入会统一隐藏，存储方式不由 schema 修饰方法决定。

## 类型 {#types-1}

`void/env` 也提供全局 Cloudflare 环境类型：

```ts
/// <reference types="void/env" />
```

声明 `Cloudflare.Env` 命名空间，包含 `DB`、`KV`、`STORAGE`、`AI`、`SANDBOX` 和 `ASSETS` 的绑定类型。

对于通过 `c.set()` 和 `c.get()` 等方法访问的处理函数上下文变量，请扩展 [`CloudContextVariables`](/zh/reference/api/types#cloudcontextvariables)。它与用于定义 Worker 绑定类型的 `Cloudflare.Env` 相互独立。`@void/vue`、`@void/react` 和 `@void/svelte` 等框架适配器也会扩展 `CloudContextVariables`，加入 `useShared()` 使用的 `shared` 键。
