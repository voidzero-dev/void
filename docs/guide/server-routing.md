---
outline: deep
---

# Server Routing

Create a file in `routes/` to add an endpoint, and export a handler for each HTTP method you want to support. Void uses [Hono](https://hono.dev) for routing and middleware.

## Route Files

Create route handlers in `routes/` using `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, or `.mjs`. Each file maps to a URL path based on its location in the filesystem:

<RoutesFileTree />

Dynamic segments use brackets: `[id]` becomes a route parameter and `[...slug]` becomes a catch-all. Files or directories starting with `_` are ignored, and so are those starting with `.`, except `.well-known`. Directories wrapped in parentheses like `(admin)` are route groups. They help organize files without changing the URL.

### Environment-only routes

Add a `.dev` or `.prod` suffix before the extension to include a route in only one environment:

```
routes/
  api/health.ts        →  always
  api/debug.dev.ts     →  development only
  api/metrics.prod.ts  →  production only
  preview.dev.tsx      →  development only, with JSX
  report.prod.jsx      →  production only, with JSX
```

`.dev` routes run only in development; `.prod` routes run in builds, deployments, and production previews. A resource used only by `.dev` routes is not provisioned for production.

Suffixes apply in `routes/` and [`pages/`](./pages-routing/overview.md#environment-only-pages), not in `middleware/`, `crons/`, or `queues/`. `void prepare` generates types for both environments.

Each file exports named HTTP method constants to handle specific methods:

```ts
// routes/api/hello.ts  →  GET /api/hello
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return { message: 'Hello!', timestamp: Date.now() };
});
```

A file can export multiple methods:

```ts
// routes/api/users/index.ts  →  GET + POST /api/users
import { users } from '@schema';
import { defineHandler } from 'void';
import { db } from 'void/db';

export const GET = defineHandler(async () => {
  return await db.select().from(users);
});

export const POST = defineHandler(async (c) => {
  const body = await c.req.json();
  await db.insert(users).values({ name: body.name });
  return { created: true };
});
```

`GET` also answers `HEAD` requests, so route files can't export `HEAD`.

See [Database](./database.md) for queries with D1, PostgreSQL, or MySQL.

### JSX handlers

Use `.tsx` or `.jsx` when a server handler contains JSX. Void doesn't choose a JSX runtime: route files compile with the same JSX settings as the rest of your Vite app. In a React or Solid app, that is the framework's JSX, so render it with the framework's server renderer and return HTML. For example, in a React app:

```tsx
// routes/hello.tsx → GET /hello
import { renderToStaticMarkup } from 'react-dom/server';
import { defineHandler } from 'void';

export const GET = defineHandler((c) => c.html(renderToStaticMarkup(<h1>Hello!</h1>)));
```

In an app without a JSX framework (API only, Vue, or Svelte), use [Hono's JSX](https://hono.dev/docs/guides/jsx). Your app needs `hono` in its own dependencies (new Void apps have it). Set the runtime in `vite.config.ts`, so it applies to `.tsx` and `.jsx` files alike:

```ts
// vite.config.ts
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'hono/jsx' } },
  plugins: [voidPlugin()],
});
```

`c.html()` then takes the JSX directly:

```tsx
// routes/hello.tsx → GET /hello
import { defineHandler } from 'void';

export const GET = defineHandler((c) => c.html(<h1>Hello!</h1>));
```

## `defineHandler`

The handler receives a Hono `Context` with typed Cloudflare bindings on `c.env` (see [Cloudflare](../integrations/cloudflare.md)). You can use the full Hono API (`c.json()`, `c.text()`, `c.header()`, etc.).

Return values are automatically converted:

- **object/array/number/boolean** → JSON response
- **`string`** → `text/html; charset=utf-8`
- **`null`/`undefined`** → `204 No Content`
- **`Response`** → returned as-is

## Validation

`defineHandler.withValidator()` adds input validation for `body`, `query`, and `params`. The recommended approach is to derive validators from your [Drizzle schema](./database.md#schema-derived-validators), which keeps validation in sync with the database.

```ts
// routes/api/users/index.ts
import { users, insertUserSchema } from '@schema';
import { defineHandler } from 'void';
import { db } from 'void/db';

export const POST = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  const [created] = await db.insert(users).values(body).returning();
  return created;
});
```

See [Database: Schema-Derived Validators](./database.md#schema-derived-validators) for how to set up `createInsertSchema` with column refinements.

### Manual validators

For endpoints that don't map to a database table, you can write validators by hand using any [Standard Schema](https://standardschema.dev/)-compatible library (Valibot, Zod, ArkType, etc.):

```ts
import * as v from 'valibot';
import { defineHandler } from 'void';

export const POST = defineHandler.withValidator({
  body: v.object({
    query: v.pipe(v.string(), v.minLength(1)),
    limit: v.optional(v.pipe(v.number(), v.maxValue(100)), 10),
  }),
})(async (c, { body }) => {
  // body is typed as { query: string; limit: number }
  return search(body.query, body.limit);
});
```

### Validation errors

When validation fails, a `400` response is returned with structured error details:

```json
{
  "error": "Validation failed",
  "issues": [
    {
      "slot": "body",
      "issues": [{ "message": "Invalid email", "path": "email" }]
    }
  ]
}
```

Install your chosen validator library; no separate Standard Schema dependency is needed.

Validator schemas also power the [typed fetch client](./typed-fetch.md), so `body`, `query`, and `params` types are enforced at the call site.

## Middleware

Void uses Hono middleware. `defineMiddleware()` adds types to the usual `(c, next)` function, and `defineHandler()` also accepts Hono middleware directly.

```ts
import { defineMiddleware } from 'void';

export const addServerTiming = defineMiddleware(async (c, next) => {
  const start = performance.now();
  await next();
  c.header('Server-Timing', `app;dur=${Math.round(performance.now() - start)}`);
});
```

Any `hono/*` built-in middleware, response helpers, or third-party Hono ecosystem packages can be used in Void apps. If you want to import from `hono/*` in your app, make sure to install `hono` in your app first:

```bash
npm install hono
```

```ts
import { cors } from 'hono/cors';

const allowDashboard = cors({ origin: 'https://app.example.com' });
```

You can apply middleware globally or per-route.

### Global middleware

Global middleware runs on every request. Place files in `middleware/` and use numeric prefixes for ordering:

- `middleware/01.logger.ts`
- `middleware/02.auth.ts`

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  console.log(c.req.method, c.req.path);
  await next();
});
```

Use `basicAuth()` for a temporary site gate. Void's reserved `/__void` endpoints remain accessible for deployment and development tooling. Read credentials through callbacks:

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

Set `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` as local environment variables for development and production secrets before deploy.

For app-specific bypasses such as health checks or public webhooks, compose that logic in your own middleware before calling `basicAuth()`.

Use `c.set()` to share data with downstream handlers. Augment `CloudContextVariables` for typed access with `c.get()`. See [Context variables](./type-safety.md#context-variables).

### Per-route middleware

Pass middleware to `defineHandler` before the final route handler:

```ts
defineHandler(middleware1, middleware2, handler);
```

Middleware runs in order. Each can short-circuit (return a response without calling `next()`) or post-process (modify the response after `await next()`). Both `defineMiddleware`-wrapped functions and raw Hono `MiddlewareHandler` functions are accepted.

```ts
// routes/api/stats.ts
import { cors } from 'hono/cors';
import { defineHandler } from 'void';

export const GET = defineHandler(cors({ origin: 'https://app.example.com' }), (c) => ({
  stats: '...',
}));
```

Up to 5 middleware can be passed before the handler, with full type inference for each position.

See the [Hono integration guide](../integrations/hono.md) for more examples.
