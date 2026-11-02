---
outline: deep
---

# Hono

Void handlers run on [Hono](https://hono.dev). Void depends on Hono internally, but if your app imports from `hono/*` directly, add `hono` to your app's dependencies first.

```bash
npm install hono
```

Once `hono` is installed in your app, you can use built-in middleware, helpers, and third-party Hono packages directly.

## Built-in Middleware

Use Hono's built-in middleware in your global middleware files or per-route:

```ts
// middleware/01.cors.ts
import { cors } from 'hono/cors';
import { defineMiddleware } from 'void';

export default defineMiddleware(cors({ origin: 'https://example.com' }));
```

```ts
// routes/api/products.ts (per-route cache)
import { cache } from 'hono/cache';
import { defineHandler } from 'void';
import { listProducts } from '../../lib/products';

export const GET = defineHandler(
  cache({ cacheName: 'products', cacheControl: 'max-age=3600' }),
  async () => ({ products: await listProducts() }),
);
```

::: warning
`cache()` stores one response per URL and returns it to every visitor. It skips requests with an `Authorization` header, but not cookies. Use it only on routes whose response is the same for everyone, never on a route that reads the signed-in user. To cache pages, use [revalidation](../guide/edge/revalidation.md), which skips requests that carry a cookie.
:::

```ts
// routes/api/webhooks/stripe.ts (per-route usage)
import { bearerAuth } from 'hono/bearer-auth';
import { defineHandler } from 'void';

export const POST = defineHandler(bearerAuth({ token: 'webhook-secret' }), async (c) => {
  const body = await c.req.json();
  return { received: true };
});
```

## Response Helpers

Hono's context helpers are available on `c` in every handler:

```ts
// routes/api/download.ts
import { stream } from 'hono/streaming';
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return stream(c, async (stream) => {
    await stream.write('chunk 1');
    await stream.write('chunk 2');
  });
});
```

```ts
// routes/api/data.ts
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  c.header('X-Custom', 'value');
  c.status(201);
  return c.json({ created: true });
});
```

## Third-party Middleware

Any `hono/*` or `@hono/*` package works. Install the package in your app, then use it directly:

```ts
// middleware/01.rate-limit.ts
import { rateLimiter } from 'hono-rate-limiter';
import { defineMiddleware } from 'void';

export default defineMiddleware(rateLimiter({ windowMs: 60_000, limit: 100 }));
```

## Utilities

Hono's standalone helpers work anywhere:

```ts
import { HTTPException } from 'hono/http-exception';

// Throw typed HTTP errors
throw new HTTPException(404, { message: 'User not found' });
```

For the full list of built-in middleware, see the [Hono documentation](https://hono.dev/docs/middleware/builtin).
