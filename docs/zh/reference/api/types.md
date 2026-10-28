---
outline: deep
---

# 类型 {#types}

## `CloudContext` {#cloudcontext}

预先使用 [`CloudEnv`](#cloudenv) 设置好类型的 Hono `Context`。所有路由处理函数和中间件的 `c` 参数都使用此类型。

```ts
import type { CloudContext } from 'void';
```

## `CloudEnv` {#cloudenv}

Void Worker 使用的 Hono 环境类型，在 Hono 的 `Env` 基础上扩展了 Cloudflare 绑定和上下文变量。

```ts
interface CloudEnv extends Env {
  Bindings: {
    DB: D1Database;
    KV: KVNamespace;
    STORAGE: R2Bucket;
    AI: Ai;
    SANDBOX: DurableObjectNamespace<import('void/sandbox').VoidPlatformSandbox>;
    ASSETS: { fetch(request: Request): Promise<Response> };
    [key: string]: unknown;
  };
  Variables: CloudContextVariables;
}
```

## `CloudContextVariables` {#cloudcontextvariables}

`c.set()` / `c.get()` 使用的上下文变量类型。扩展此接口，可以添加在所有中间件和处理函数间传递的类型化变量：

```ts
interface CloudContextVariables {
  user: AuthUser | null;
  session: AuthSession | null;
  [key: string]: unknown;
}
```

**类型扩展示例：**

```ts
declare module 'void' {
  interface CloudContextVariables {
    requestId: string;
  }
}

// c.get("requestId") → string
```

详见[类型安全](/zh/guide/type-safety#context-variables)。

## `TypedHandler<V, R>` {#typedhandler-v-r}

`defineHandler` 的返回类型，包含校验器类型（`V`）和处理函数的返回类型（`R`）。

```ts
interface TypedHandler<V extends ValidatorSlots = {}, R = unknown> {
  (c: CloudContext): Promise<Response> | Response | unknown;
  readonly __validators: V; // type-level only
  readonly __output: R; // type-level only
}
```

## `HeadDescriptor` {#headdescriptor}

`defineHead` 返回的页面 head 元数据结构，所有字段都是可选的。

```ts
interface HeadDescriptor {
  title?: string;
  meta?: Array<{ name?: string; property?: string; content?: string; charset?: string }>;
  link?: Array<{ rel: string; href: string; [key: string]: string | undefined }>;
  script?: Array<{ src?: string; innerHTML?: string; [key: string]: string | undefined }>;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
}
```

## `RouteMap` {#routemap}

自动生成的路由类型，供类型化的 `fetch` 客户端使用，包含每条路由的方法、输入和输出。

```ts
import type { RouteMap } from 'void/routes';
```
