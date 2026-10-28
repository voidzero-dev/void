---
outline: deep
---

# Hono {#hono}

Void 处理函数运行在 [Hono](https://hono.dev) 之上。Void 内部依赖 Hono，但如果你的应用直接从 `hono/*` 导入，请先将 `hono` 添加到应用的依赖中。

```bash
npm install hono
```

在应用中安装 `hono` 后，就可以直接使用其内置中间件、辅助函数和第三方 Hono 包。

## 内置中间件 {#built-in-middleware}

在全局中间件文件中使用 Hono 的内置中间件，或为单个路由配置：

```ts
import { cors } from 'hono/cors';
// middleware/01.cors.ts
import { defineMiddleware } from 'void';

export default defineMiddleware(cors({ origin: 'https://example.com' }));
```

```ts
import { cache } from 'hono/cache';
// routes/api/products.ts (per-route cache)
import { defineHandler } from 'void';
import { listProducts } from '../../lib/products';

export const GET = defineHandler(
  cache({ cacheName: 'products', cacheControl: 'max-age=3600' }),
  async () => ({ products: await listProducts() }),
);
```

::: warning
`cache()` 为每个 URL 缓存一份响应，并将其返回给所有访问者。它会跳过带有 `Authorization` 请求头的请求，但不会跳过带有 Cookie 的请求。仅在对所有人返回相同响应的路由上使用它，切勿用于读取当前登录用户的路由。要缓存页面，请使用[重新验证](/zh/guide/edge/revalidation)，它会跳过携带 Cookie 的请求。
:::

```ts
import { bearerAuth } from 'hono/bearer-auth';
// routes/api/webhooks/stripe.ts (per-route usage)
import { defineHandler } from 'void';

export const POST = defineHandler(bearerAuth({ token: 'webhook-secret' }), async (c) => {
  const body = await c.req.json();
  return { received: true };
});
```

## 响应辅助函数 {#response-helpers}

在每个处理函数中，都可以通过 `c` 使用 Hono 的上下文辅助函数：

```ts
import { stream } from 'hono/streaming';
// routes/api/download.ts
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

## 第三方中间件 {#third-party-middleware}

任何 `hono/*` 或 `@hono/*` 包都可以使用。在应用中安装对应的包后，即可直接使用：

```ts
import { rateLimiter } from 'hono-rate-limiter';
// middleware/01.rate-limit.ts
import { defineMiddleware } from 'void';

export default defineMiddleware(rateLimiter({ windowMs: 60_000, limit: 100 }));
```

## 实用工具 {#utilities}

Hono 的独立辅助函数可以在任何地方使用：

```ts
import { HTTPException } from 'hono/http-exception';

// Throw typed HTTP errors
throw new HTTPException(404, { message: 'User not found' });
```

完整的内置中间件列表，请参阅 [Hono 文档](https://hono.dev/docs/middleware/builtin)。
