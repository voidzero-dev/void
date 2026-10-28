---
outline: deep
---

# Fetch Client {#fetch-client}

Imported from `"void/client"`.

## `fetch(path, options?)` {#fetch-path-options}

Type-safe fetch client for calling your API routes from client code, built on top of [ofetch](https://github.com/unjs/ofetch). Route paths and return types are inferred from the generated `RouteMap`.

```ts
import { fetch } from 'void/client';

// Types are fully inferred from your route handlers
const users = await fetch('/api/users');
const user = await fetch('/api/users/:id', {
  params: { id: '1' },
});
```

**Signature:**

```ts
function fetch<P extends keyof RouteMap, M extends MethodsOf<P>>(
  path: P,
  options?: FetchOptions<P, M>,
): Promise<OutputOf<P, M>>;
```

**Options:**

| Option    | Type                     | Description                                                |
| --------- | ------------------------ | ---------------------------------------------------------- |
| `method`  | `string`                 | HTTP method. Defaults to `"GET"`.                          |
| `body`    | `unknown`                | Request body (auto-serialized as JSON).                    |
| `query`   | `Record<string, string>` | Query string parameters.                                   |
| `params`  | `Record<string, string>` | URL path parameters (`:id` segments).                      |
| `headers` | `HeadersInit`            | Additional request headers.                                |
| `signal`  | `AbortSignal`            | Abort signal.                                              |
| `baseURL` | `string`                 | Base URL prepended to the path. Useful for external calls. |
| `retry`   | `number`                 | Number of retry attempts (ofetch default: 1 for GET).      |
| `timeout` | `number`                 | Request timeout in milliseconds.                           |

Returns the parsed JSON response body, or `undefined` for 204 responses. Throws `FetchError` on non-2xx responses.

## `FetchError` {#fetcherror}

Error class thrown by `fetch` on non-2xx responses.

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

**Properties:**

| Property   | Type       | Description                          |
| ---------- | ---------- | ------------------------------------ |
| `status`   | `number`   | HTTP status code.                    |
| `response` | `Response` | The raw `Response` object.           |
| `data`     | `unknown`  | Parsed response body (if available). |

## Differences from Native `fetch` {#differences-from-native-fetch}

The typed client is built on [ofetch](https://github.com/unjs/ofetch) with a typed route layer on top. Key differences from native `fetch`:

| Behavior               | Native `fetch`                                       | `void/client` `fetch`                                                                                                  |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Return type**        | `Promise<Response>`, so you call `.json()` yourself  | `Promise<T>`, which auto-parses JSON and returns the typed result directly (`undefined` for `204`)                     |
| **Error handling**     | Resolves on any HTTP status; you check `response.ok` | Throws `FetchError` on non-2xx responses                                                                               |
| **URL construction**   | Raw URL string                                       | Route path with `:param` interpolation from `options.params` + query string from `options.query`                       |
| **Body serialization** | Manual `JSON.stringify()` + `Content-Type` header    | Auto-serializes `options.body` as JSON and sets `Content-Type: application/json`                                       |
| **Type safety**        | Accepts any URL or method                            | Constrains paths to `RouteMap` keys and methods to those defined per route. Invalid combinations fail at compile time. |
| **Retry**              | None                                                 | Auto-retries on 408, 429, and 5xx (configurable via `retry` option)                                                    |
| **Timeout**            | None                                                 | Configurable via `timeout` option                                                                                      |

`headers` and `signal` are passed through to the underlying fetch unchanged.
