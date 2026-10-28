---
outline: deep
---

# Handlers and Middleware {#handlers}

Imported from `"void"` or `"void/handler"`.

## `defineHandler(handler)` {#definehandler-handler}

Wraps a route handler function. The handler receives a [`CloudContext`](./types.md#cloudcontext) and can return a plain value (auto-converted to a Response) or use the Hono `c.json()` / `c.text()` APIs directly.

```ts
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return { message: 'hello' };
});
```

**Signature:**

```ts
function defineHandler<R>(handler: (c: CloudContext) => R): TypedHandler<{}, R>;
```

## `defineHandler(middleware..., handler)` {#definehandler-middleware-handler}

Composes up to 5 per-route middleware with a final handler. Middleware runs in order before the handler.

```ts
export const GET = defineHandler(authMiddleware, rateLimiter, (c) => {
  return { ok: true };
});
```

## `defineHandler.withValidator(validators)` {#definehandler-withvalidator-validators}

Creates a handler with input validation using any [Standard Schema](https://github.com/standard-schema/standard-schema) compatible library (zod, valibot, arktype, etc.). Returns a curried function that accepts the handler.

Validated input is passed as the second argument to the handler.

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

**Signature:**

```ts
function withValidator<V extends ValidatorSlots>(
  validators: V,
): <R>(handler: (c: CloudContext, input: HandlerInput<V>) => R) => TypedHandler<V, R>;
```

**Type: `ValidatorSlots`**

```ts
interface ValidatorSlots {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
}
```

**Type: `HandlerInput<V>`**

The inferred output types of each validator slot. For a `ValidatorSlots` with `body` and `query`, the input object has `{ body: ..., query: ... }` with types inferred from the schema output.

## `defineMiddleware(handler)` {#definemiddleware-handler}

Type-safe wrapper for Hono middleware.

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  console.log(`${c.req.method} ${c.req.path}`);
  await next();
});
```

**Signature:**

```ts
function defineMiddleware(handler: MiddlewareHandler<CloudEnv>): MiddlewareHandler<CloudEnv>;
```

## `basicAuth(options)` {#basicauth-options}

Built-in Basic authentication middleware for temporary site gates and pre-launch protection. Use it from `middleware/` with credentials from `void/env` to protect the whole app, or pass it to `defineHandler()` for a single route.

Void’s reserved `/__void` endpoints use their own authentication and are excluded from Basic auth.

When credentials come from `void/env`, wrap the reads in functions so they are resolved per request after Void has bound the runtime env.

If `password` resolves to an empty value, requests fail with a server error instead of passing the gate.

For app-specific bypasses such as health checks or public webhooks, compose that logic in your own middleware before calling `basicAuth()`.

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

**Signature:**

```ts
function basicAuth(options: {
  username: string | (() => string);
  password: string | (() => string);
  realm?: string | (() => string);
  message?: string | (() => string);
}): MiddlewareHandler<CloudEnv>;
```

## `defineScheduled(handler)` {#definescheduled-handler}

Wraps a Cloudflare [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) with type inference.

```ts
import { defineScheduled } from 'void';

export default defineScheduled(async (controller, env, ctx) => {
  const { results } = await env.DB.prepare('SELECT * FROM stale').all();
  // ...
});
```

**Signature:**

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

Wraps a [queue](../../guide/queues.md) consumer handler with typed message bodies. The generic `<T>` defines the message body type, which flows through to the typed `queues` proxy for `send()` calls.

```ts
import { defineQueue } from 'void';

export default defineQueue<{ to: string; subject: string }>(async (batch, env) => {
  for (const msg of batch.messages) {
    console.log(`Send to ${msg.body.to}: ${msg.body.subject}`);
  }
});
```

**Signature:**

```ts
function defineQueue<T>(
  handler: (batch: QueueBatch<T>, env: CloudEnv['Bindings']) => void | Promise<void>,
): TypedQueueHandler<T>;
```

## `defineRender(handler)` {#definerender-handler}

Wraps an SSR render entry. The second argument provides pre-built `<head>` and `<body>` asset tags for injecting client scripts and styles.

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

**Signature:**

```ts
function defineRender(
  handler: (c: CloudContext, assetTags: RenderAssetTags) => Response | Promise<Response>,
): RenderFn;
```

**Type: `RenderAssetTags`**

```ts
interface RenderAssetTags {
  css: string; // Stylesheet links for <head>
  preloads: string; // Modulepreload and dev client tags for <head>
  body: string; // Script tags for before </body>
}
```

## `defineHead<P>(handler)` {#definehead-p-handler}

Type-safe wrapper for the page `head()` export in `.server.ts` files. Provides [`CloudContext`](./types.md#cloudcontext) typing for the first argument and generic props typing for the second.

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

**Signature:**

```ts
function defineHead<P = Record<string, unknown>>(
  handler: (c: CloudContext, props: P) => HeadDescriptor | undefined,
): (c: CloudContext, props: P) => HeadDescriptor | undefined;
```
