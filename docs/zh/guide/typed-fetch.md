---
outline: deep
---

# 类型化 Fetch {#typed-fetch}

从 `void/client` 导入 `fetch`，即可获得路由自动补全、请求体类型检查和响应类型推导。

## 基本用法 {#basic-usage}

```ts
import { fetch } from 'void/client';

// GET: return type inferred from your handler
const users = await fetch('/api/users');

// POST: body type-checked against your handler's validator
await fetch('/api/users', {
  method: 'POST',
  body: { name: 'Alice', email: 'alice@example.com' },
});

// Dynamic params interpolated from the route pattern
const user = await fetch('/api/users/:id', {
  params: { id: '42' },
});
```

## 类型检查范围 {#what-gets-type-checked}

客户端会约束请求的各个部分：

- **路径：** 只接受 `routes/` 中定义的路由。路径拼写错误会在编译时被发现。
- **方法：** 只允许路由文件导出的方法。如果文件只导出 `GET`，传入 `method: "POST"` 就会报错。
- **请求体、查询参数、路径参数：** 当处理函数使用 [`defineHandler.withValidator()`](/zh/guide/server-routing#validation) 时，校验 schema 会成为输入类型，客户端会在调用处检查这些类型。
- **响应类型：** 返回类型与处理函数的返回值经过 [JSON 序列化](/zh/guide/type-safety#serialization) 后的类型一致。

## 查询参数 {#query-parameters}

GET 请求需要查询参数时，传入 `query`：

```ts
// routes/api/search.ts
export const GET = defineHandler.withValidator({
  query: z.object({ q: z.string(), page: z.string().optional() }),
})((c, { query }) => {
  return { results: [], term: query.q };
});

// Client: query is type-checked
const data = await fetch('/api/search', {
  query: { q: 'hello' },
});
// data: { results: never[]; term: string }
```

## 错误处理 {#error-handling}

非 2xx 响应会抛出 `FetchError`：

```ts
import { fetch, FetchError } from 'void/client';

try {
  await fetch('/api/users/:id', { params: { id: '999' } });
} catch (e) {
  if (e instanceof FetchError) {
    console.log(e.status); // 404
    console.log(e.data); // parsed response body
    console.log(e.response); // raw Response
  }
}
```

## 选项 {#options}

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `method` | `string` | HTTP 方法，默认为 `"GET"`。 |
| `body` | `object` | 请求体，自动序列化为 JSON。 |
| `query` | `Record<string, string>` | 查询字符串参数。 |
| `params` | `Record<string, string>` | URL 路径参数，即 `:id` 形式的路径段。 |
| `headers` | `HeadersInit` | 额外的请求头。 |
| `signal` | `AbortSignal` | 中止信号。 |
| `baseURL` | `string` | 添加在路径前的基础 URL，可用于调用外部服务。 |
| `retry` | `number` | 重试次数，GET 请求默认为 1。 |
| `timeout` | `number` | 请求超时时间，单位为毫秒。 |

## SSR 中的同构 Fetch {#isomorphic-fetch-during-ssr}

`fetch()` 也可用于服务端渲染和路由处理函数。调用应用自身的接口时，不会经过 HTTP 往返。

```ts
// src/main.ssr.tsx
import { fetch } from "void/client";
import { defineRender } from "void";

export default defineRender(async (c, assetTags) => {
  // This calls your API route directly with no HTTP request
  const data = await fetch("/api/users");

  const html = renderToString(<App users={data} />);
  return new Response(html, {
    headers: { "content-type": "text/html" },
  });
});
```

服务端调用应用自身的接口时，会转发传入请求的 `cookie` 和 `authorization` 请求头；显式传入的请求头优先。调用外部 `baseURL` 时会使用 HTTP，且不会继承这些请求头。
