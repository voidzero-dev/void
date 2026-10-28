---
outline: deep
---

# Fetch 客户端 {#fetch-client}

从 `"void/client"` 导入。

## `fetch(path, options?)` {#fetch-path-options}

基于 [ofetch](https://github.com/unjs/ofetch) 构建的类型安全 fetch 客户端，用于在客户端代码中调用 API 路由。路由路径和返回类型由生成的 `RouteMap` 推断。

```ts
import { fetch } from 'void/client';

// Types are fully inferred from your route handlers
const users = await fetch('/api/users');
const user = await fetch('/api/users/:id', {
  params: { id: '1' },
});
```

**签名：**

```ts
function fetch<P extends keyof RouteMap, M extends MethodsOf<P>>(
  path: P,
  options?: FetchOptions<P, M>,
): Promise<OutputOf<P, M>>;
```

**选项：**

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `method` | `string` | HTTP 方法，默认为 `"GET"`。 |
| `body` | `unknown` | 请求体，会自动序列化为 JSON。 |
| `query` | `Record<string, string>` | 查询字符串参数。 |
| `params` | `Record<string, string>` | URL 路径参数，即 `:id` 这样的路由段。 |
| `headers` | `HeadersInit` | 额外的请求头。 |
| `signal` | `AbortSignal` | 中止信号。 |
| `baseURL` | `string` | 添加到路径前的基础 URL，适用于外部调用。 |
| `retry` | `number` | 重试次数，ofetch 对 GET 请求默认重试 1 次。 |
| `timeout` | `number` | 请求超时时间，单位为毫秒。 |

返回解析后的 JSON 响应体；204 响应返回 `undefined`。非 2xx 响应会抛出 `FetchError`。

## `FetchError` {#fetcherror}

`fetch` 收到非 2xx 响应时抛出的错误类。

```ts
import { fetch, FetchError } from 'void/client';

try {
  await fetch('/api/users/:id', { params: { id: '999' } });
} catch (e) {
  if (e instanceof FetchError) {
    console.log(e.status); // 404
    console.log(e.response); // raw Response
  }
}
```

**属性：**

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `number` | HTTP 状态码。 |
| `response` | `Response` | 原始 `Response` 对象。 |
| `data` | `unknown` | 解析后的响应体，如果可用。 |

## 与原生 `fetch` 的区别 {#differences-from-native-fetch}

类型化客户端在 [ofetch](https://github.com/unjs/ofetch) 之上增加了类型化路由层，与原生 `fetch` 的主要区别如下：

| 行为 | 原生 `fetch` | `void/client` `fetch` |
| --- | --- | --- |
| **返回类型** | `Promise<Response>`，需要自行调用 `.json()` | `Promise<T>`，自动解析 JSON 并直接返回带类型的结果，`204` 时返回 `undefined` |
| **错误处理** | 任何 HTTP 状态都会返回响应，需要自行检查 `response.ok` | 非 2xx 响应会抛出 `FetchError` |
| **URL 构造** | 原始 URL 字符串 | 根据 `options.params` 替换路由路径中的 `:param`，并根据 `options.query` 添加查询字符串 |
| **请求体序列化** | 手动调用 `JSON.stringify()` 并设置 `Content-Type` 请求头 | 将 `options.body` 自动序列化为 JSON，并设置 `Content-Type: application/json` |
| **类型安全** | 接受任意 URL 或方法 | 路径限定为 `RouteMap` 的键，方法限定为对应路由定义的方法。无效组合会在编译时出错。 |
| **重试** | 无 | 遇到 408、429 和 5xx 时自动重试，可通过 `retry` 选项配置 |
| **超时** | 无 | 可通过 `timeout` 选项配置 |

`headers` 和 `signal` 会原样传递给底层 fetch。
