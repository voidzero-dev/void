---
outline: deep
---

# Types {#types}

## `CloudContext` {#cloudcontext}

Hono `Context` pre-typed with [`CloudEnv`](#cloudenv). This is the type of the `c` parameter in all route handlers and middleware.

```ts
import type { CloudContext } from 'void';
```

## `CloudEnv` {#cloudenv}

Hono environment type for Void workers. Extends Hono's `Env` with Cloudflare bindings and context variables.

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

The context variables type used by `c.set()` / `c.get()`. Augment this interface to add typed variables that flow through all middleware and handlers:

```ts
interface CloudContextVariables {
  user: AuthUser | null;
  session: AuthSession | null;
  [key: string]: unknown;
}
```

**Augmentation example:**

```ts
declare module 'void' {
  interface CloudContextVariables {
    requestId: string;
  }
}

// c.get("requestId") → string
```

See [Type Safety](../../guide/type-safety.md#context-variables) for details.

## `TypedHandler<V, R>` {#typedhandler-v-r}

The return type of `defineHandler`, with validator types (`V`) and the handler’s return type (`R`).

```ts
interface TypedHandler<V extends ValidatorSlots = {}, R = unknown> {
  (c: CloudContext): Promise<Response> | Response | unknown;
  readonly __validators: V; // type-level only
  readonly __output: R; // type-level only
}
```

## `HeadDescriptor` {#headdescriptor}

Shape of page head metadata returned by `defineHead`. All fields are optional.

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

Generated route types used by the typed `fetch` client. Contains each route’s methods, inputs, and outputs.

```ts
import type { RouteMap } from 'void/routes';
```

## `void/routes` {#void-routes}

### `routeUrl(path, options?)` {#routeurl-path-options}

Build a relative URL string from a known page, HTTP, or WebSocket route pattern:

```ts
import { routeUrl } from 'void/routes';

routeUrl('/users/:id', {
  params: { id: 42 },
  query: { tab: 'activity' },
  hash: 'details',
});
// /users/42?tab=activity#details
```

| Option   | Type           | Description                                                                        |
| -------- | -------------- | ---------------------------------------------------------------------------------- |
| `params` | Route-specific | Required for dynamic routes. Each parameter accepts a `string` or `number`.        |
| `query`  | `RouteQuery`   | Query parameters. Arrays become repeated keys; `null` and `undefined` are omitted. |
| `hash`   | `string`       | URL fragment, such as `'details'` or `'#details'`.                                 |

Static routes accept optional `query` and `hash` options. Pass raw parameter values for URL encoding. Catch-all parameters preserve `/` separators between segments. Invalid or missing path parameters throw a `TypeError`.

Use the returned [`RouteUrl`](#route-types) with `Link`, `<a>`, and `c.redirect()`. See [Typed URLs and Navigation](../../guide/type-safety.md#typed-urls-and-navigation) for setup and examples.

### Route types {#route-types}

Import these types from `void/routes`:

| Type                  | Description                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `RoutePathMap`        | Generated map of page, HTTP, and WebSocket route patterns to their parameter names.               |
| `RoutePath`           | Union of the known route patterns in `RoutePathMap`.                                              |
| `RouteOptions<P>`     | Options for a route pattern `P`, including its required `params`, optional `query`, and `hash`.   |
| `RouteDestination<P>` | `{ pathname: P }` with `RouteOptions<P>`. Defaults to all known routes when `P` is omitted.       |
| `RouteUrl`            | The URL of one of your routes, returned by `routeUrl()`. `string` unless `typedRoutes` is on.     |
| `Href`                | A `RouteUrl`, a same-page query or hash, or an external URL. `string` unless `typedRoutes` is on. |
| `RouteUrlInput`       | `Href`, `URL`, or `RouteDestination`; accepted by router navigation methods.                      |
| `RouteQuery`          | Query keys mapped to `RouteQueryValue` or readonly arrays of those values.                        |
| `RouteQueryValue`     | `string`, `number`, `boolean`, `null`, or `undefined`.                                            |

`typedRoutes` is [`routing.typedRoutes`](../config.md#routing-typedroutes). See [Checked URL strings](../../guide/type-safety.md#checked-url-strings).
