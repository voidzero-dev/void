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
    ASSETS: Fetcher;
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
