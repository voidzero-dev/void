---
outline: deep
---

# 处理函数与中间件 {#handlers}

从 `"void"` 或 `"void/handler"` 导入。

## `defineHandler(handler)` {#definehandler-handler}

包装路由处理函数。处理函数接收 [`CloudContext`](/zh/reference/api/types#cloudcontext)，可以返回普通值，由 Void 自动转换为 Response，也可以直接使用 Hono 的 `c.json()` / `c.text()` API。

```ts
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return { message: 'hello' };
});
```

**签名：**

```ts
function defineHandler<R>(handler: (c: CloudContext) => R): TypedHandler<{}, R>;
```

## `defineHandler(middleware..., handler)` {#definehandler-middleware-handler}

将最多 5 个路由级中间件与最终处理函数组合起来。中间件会在处理函数之前按顺序执行。

```ts
export const GET = defineHandler(authMiddleware, rateLimiter, (c) => {
  return { ok: true };
});
```

## `defineHandler.withValidator(validators)` {#definehandler-withvalidator-validators}

使用兼容 [Standard Schema](https://github.com/standard-schema/standard-schema) 的库，例如 zod、valibot 或 arktype，创建带输入校验的处理函数。返回一个接收处理函数的柯里化函数。

校验后的输入会作为第二个参数传给处理函数。

```ts
import * as v from 'valibot';
import { defineHandler } from 'void';

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})((c, { body }) => {
  return { received: body.name };
});
```

**签名：**

```ts
function withValidator<V extends ValidatorSlots>(
  validators: V,
): <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R) => TypedHandler<V, R>;
```

**类型：`ValidatorSlots`**

```ts
interface ValidatorSlots {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}
```

**类型：`HandlerInput<V>`**

各校验器槽位推断出的输出类型。例如，`ValidatorSlots` 包含 `body` 和 `query` 时，输入对象的结构为 `{ body: ..., query: ... }`，字段类型由 schema 的输出推断。

## `defineMiddleware(handler)` {#definemiddleware-handler}

为 Hono 中间件提供类型安全的包装。

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  console.log(`${c.req.method} ${c.req.path}`);
  await next();
});
```

**签名：**

```ts
function defineMiddleware(handler: MiddlewareHandler<CloudEnv>): MiddlewareHandler<CloudEnv>;
```

## `basicAuth(options)` {#basicauth-options}

内置的 Basic 身份认证中间件，适用于临时访问控制和上线前保护。在 `middleware/` 中使用，并从 `void/env` 读取凭据，即可保护整个应用；也可以传给 `defineHandler()`，仅保护单个路由。

Void 预留的 `/__void` 端点使用自己的身份认证，不受 Basic 认证保护。

凭据来自 `void/env` 时，请将读取操作包装在函数中，以便在 Void 绑定运行时环境后，为每个请求读取凭据。

如果 `password` 解析为空值，请求会返回服务端错误，不会通过认证。

如果应用需要让健康检查或公开 Webhook 等请求绕过认证，请先在自己的中间件中实现判断，再调用 `basicAuth()`。

```ts
// env.ts
import { defineEnv, string } from 'void/env';

export default defineEnv({
  BASIC_AUTH_USERNAME: string(),
  BASIC_AUTH_PASSWORD: string(),
});
```

```ts
// middleware/01.basic-auth.ts
import { basicAuth } from 'void';
import { env } from 'void/env';

export default basicAuth({
  username: () => env.BASIC_AUTH_USERNAME,
  password: () => env.BASIC_AUTH_PASSWORD,
  realm: 'Preview',
});
```

**签名：**

```ts
function basicAuth(options: {
  username: string | (() => string);
  password: string | (() => string);
  realm?: string | (() => string);
  message?: string | (() => string);
}): MiddlewareHandler<CloudEnv>;
```

## `defineScheduled(handler)` {#definescheduled-handler}

包装 Cloudflare [定时事件处理函数](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)，并提供类型推断。

```ts
import { defineScheduled } from 'void';

export default defineScheduled(async (controller, env, ctx) => {
  const { results } = await env.DB.prepare('SELECT * FROM stale').all();
  // ...
});
```

**签名：**

```ts
function defineScheduled(
  handler: (
    controller: ScheduledController,
    env: CloudEnv['Bindings'],
    ctx: ExecutionContext,
  ) => unknown | Promise<unknown>,
): ScheduledFn;
```

## `defineQueue<T>(handler)` {#definequeue-t-handler}

包装[队列](/zh/guide/queues)消费者处理函数，为消息体提供类型。泛型 `<T>` 定义消息体类型，并将其传递到类型化的 `queues` 代理，用于 `send()` 调用。

```ts
import { defineQueue } from 'void';

export default defineQueue<{ to: string; subject: string }>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

**签名：**

```ts
function defineQueue<T>(
  handler: (batch: QueueBatch<T>, env: CloudEnv['Bindings']) => void | Promise<void>,
): TypedQueueHandler<T>;
```

## `defineRender(handler)` {#definerender-handler}

包装 SSR 渲染入口。第二个参数提供预先生成的 `<head>` 和 `<body>` 资源标签，用于注入客户端脚本和样式。

```ts
import { defineRender } from "void";
import { renderToString } from "react-dom/server";

export default defineRender((c, assetTags) => {
  const html = renderToString(<App />);
  return c.html(`<!DOCTYPE html>
    <html><head>${assetTags.css}${assetTags.preloads}</head>
    <body><div id="root">${html}</div>${assetTags.body}</body></html>`);
});
```

**签名：**

```ts
function defineRender(
  handler: (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>,
): RenderFn;
```

**类型：`RenderAssetTags`**

```ts
interface RenderAssetTags {
  css: string; // Stylesheet links for <head>
  preloads: string; // Modulepreload and dev client tags for <head>
  body: string; // Script tags for before </body>
}
```

## `defineHead<P>(handler)` {#definehead-p-handler}

为 `.server.ts` 文件导出的页面 `head()` 函数提供类型安全的包装。第一个参数使用 [`CloudContext`](/zh/reference/api/types#cloudcontext) 类型，第二个参数通过泛型指定 props 类型。

```ts
import { defineHandler, defineHead } from 'void';
import type { InferProps } from 'void';

export type Props = InferProps<typeof loader>;

export const loader = defineHandler(async (c) => {
  const post = await getPost(c.req.param('slug'));
  return { post };
});

export const head = defineHead<Props>((c, props) => {
  return {
    title: props.post.title,
    meta: [
      { name: 'description', content: props.post.excerpt },
      { property: 'og:title', content: props.post.title },
    ],
  };
});
```

**签名：**

```ts
function defineHead<P = Record<string, unknown>>(
  handler: (c: CloudContext, props: P) => HeadDescriptor | undefined,
): (c: CloudContext, props: P) => HeadDescriptor | undefined;
```
