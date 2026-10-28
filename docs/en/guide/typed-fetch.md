---
outline: deep
---

# Typed Fetch

Import `fetch` from `void/client` for route autocomplete, checked request bodies, and inferred response types.

## Basic Usage

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

## What Gets Type-Checked

The client constrains every part of the request:

- **Paths:** only routes defined in `routes/` are accepted. Typos fail at compile time.
- **Methods:** only methods exported from the route file are allowed. If a file only exports `GET`, passing `method: "POST"` is an error.
- **Body, query, params:** when your handler uses [`defineHandler.withValidator()`](./server-routing.md#validation), validator schemas become the input types and the client enforces them at the call site.
- **Response type:** the return type matches what your handler returns after [JSON serialization](./type-safety.md#serialization).

## Query Parameters

Pass `query` for GET requests with search parameters:

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

## Error Handling

Non-2xx responses throw a `FetchError`:

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

## Options

| Option    | Type                     | Description                                                |
| --------- | ------------------------ | ---------------------------------------------------------- |
| `method`  | `string`                 | HTTP method. Defaults to `"GET"`.                          |
| `body`    | `object`                 | Request body (auto-serialized as JSON).                    |
| `query`   | `Record<string, string>` | Query string parameters.                                   |
| `params`  | `Record<string, string>` | URL path parameters (`:id` segments).                      |
| `headers` | `HeadersInit`            | Additional request headers.                                |
| `signal`  | `AbortSignal`            | Abort signal.                                              |
| `baseURL` | `string`                 | Base URL prepended to the path. Useful for external calls. |
| `retry`   | `number`                 | Number of retry attempts (default: 1 for GET).             |
| `timeout` | `number`                 | Request timeout in milliseconds.                           |

## Isomorphic Fetch During SSR

`fetch()` also works in server-side rendering and route handlers. Calls to your app run without an HTTP round-trip.

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

Server-side calls to your app forward the incoming request's `cookie` and `authorization` headers. Explicit headers take precedence. Calls to an external `baseURL` use HTTP and do not inherit these headers.
