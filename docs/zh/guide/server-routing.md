---
outline: deep
---

# 服务端路由 {#server-routing}

在 `routes/` 中创建文件即可添加端点，并为需要支持的每种 HTTP 方法导出一个处理函数。Void 使用 [Hono](https://hono.dev) 处理路由和中间件。

## 路由文件 {#route-files}

在 `routes/` 中使用 `.ts`、`.tsx`、`.js`、`.jsx`、`.mts` 或 `.mjs` 创建路由处理函数。每个文件会根据它在文件系统中的位置映射到一个 URL 路径：

<RoutesFileTree />

动态路径段用方括号表示：`[id]` 会成为路由参数，`[...slug]` 会匹配任意层级的剩余路径。以 `_` 开头的文件或目录会被忽略，以 `.` 开头的也一样，但 `.well-known` 除外。像 `(admin)` 这样用圆括号包裹的目录称为路由组，可以用来组织文件，而不改变 URL。

### 仅在特定环境中启用路由 {#environment-only-routes}

在扩展名前添加 `.dev` 或 `.prod` 后缀，可让路由只在一种环境中启用：

```
routes/
  api/health.ts        →  always
  api/debug.dev.ts     →  development only
  api/metrics.prod.ts  →  production only
  preview.dev.tsx      →  development only, with JSX
  report.prod.jsx      →  production only, with JSX
```

`.dev` 路由只在开发环境运行；`.prod` 路由用于构建、部署和生产预览。只有 `.dev` 路由使用的资源不会在生产环境中创建。

这些后缀适用于 `routes/` 和 [`pages/`](/zh/guide/pages-routing/overview#environment-only-pages)，不适用于 `middleware/`、`crons/` 或 `queues/`。`void prepare` 会为两种环境生成类型。

每个文件通过导出以 HTTP 方法命名的常量来处理相应请求：

```ts
// routes/api/hello.ts  →  GET /api/hello
import { defineHandler } from 'void';

export const GET = defineHandler((c) => {
  return { message: 'Hello!', timestamp: Date.now() };
});
```

一个文件可以导出多个方法：

```ts
import { users } from '@schema';
// routes/api/users/index.ts  →  GET + POST /api/users
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

`GET` 也会响应 `HEAD` 请求，因此路由文件不能导出 `HEAD`。

使用 D1、PostgreSQL 或 MySQL 查询数据的方法见[数据库](/zh/guide/database)。

### JSX 处理函数 {#jsx-handlers}

服务端处理函数中包含 JSX 时，使用 `.tsx` 或 `.jsx`。Void 不会替你选择 JSX 运行时：路由文件与 Vite 应用的其他代码使用相同的 JSX 编译设置。在 React 或 Solid 应用中，这意味着使用对应框架的 JSX，因此需要通过框架的服务端渲染器渲染它，再返回 HTML。例如，在 React 应用中：

```tsx
// routes/hello.tsx → GET /hello
import { renderToStaticMarkup } from 'react-dom/server';
import { defineHandler } from 'void';

export const GET = defineHandler((c) => c.html(renderToStaticMarkup(<h1>Hello!</h1>)));
```

对于没有使用 JSX 框架的应用，例如纯 API、Vue 或 Svelte 应用，可以使用 [Hono 的 JSX](https://hono.dev/docs/guides/jsx)。应用自身的依赖中需要包含 `hono`，新建的 Void 应用已包含它。在 `vite.config.ts` 中设置运行时，使其同时应用于 `.tsx` 和 `.jsx` 文件：

```ts
// vite.config.ts
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'hono/jsx' } },
  plugins: [voidPlugin()],
});
```

然后，`c.html()` 就可以直接接收 JSX：

```tsx
// routes/hello.tsx → GET /hello
import { defineHandler } from 'void';

export const GET = defineHandler((c) => c.html(<h1>Hello!</h1>));
```

## `defineHandler` {#definehandler}

处理函数接收 Hono `Context`，其 `c.env` 上带有类型化的 Cloudflare 绑定，见 [Cloudflare](/integrations/cloudflare)。你可以使用完整的 Hono API，例如 `c.json()`、`c.text()` 和 `c.header()`。

返回值会自动转换：

- **对象、数组、数字、布尔值** → JSON 响应
- **`string`** → `text/html; charset=utf-8`
- **`null`/`undefined`** → `204 No Content`
- **`Response`** → 原样返回

## 输入校验 {#validation}

`defineHandler.withValidator()` 为 `body`、`query` 和 `params` 添加输入校验。推荐从 [Drizzle schema](/zh/guide/database#schema-derived-validators) 派生校验器，让校验规则与数据库保持同步。

```ts
import { users, insertUserSchema } from '@schema';
// routes/api/users/index.ts
import { defineHandler } from 'void';
import { db } from 'void/db';

export const POST = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  const [created] = await db.insert(users).values(body).returning();
  return created;
});
```

如何使用列级约束配置 `createInsertSchema`，见[数据库：从 Schema 派生校验器](/zh/guide/database#schema-derived-validators)。

### 手动编写校验器 {#manual-validators}

对于不对应数据库表的端点，可以使用任何兼容 [Standard Schema](https://standardschema.dev/) 的库手动编写校验器，例如 Valibot、Zod 或 ArkType：

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

### 校验错误 {#validation-errors}

校验失败时，会返回带有结构化错误详情的 `400` 响应：

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

安装你选择的校验库即可，无需单独安装 Standard Schema 依赖。

这些校验 schema 也用于[类型化 fetch 客户端](/zh/guide/typed-fetch)，因此 `body`、`query` 和 `params` 的类型会在调用处得到检查。

## 中间件 {#middleware}

Void 使用 Hono 中间件。`defineMiddleware()` 为常见的 `(c, next)` 函数补充类型，`defineHandler()` 也可以直接接收 Hono 中间件。

```ts
import { defineMiddleware } from 'void';

export const addServerTiming = defineMiddleware(async (c, next) => {
  const start = performance.now();
  await next();
  c.header('Server-Timing', `app;dur=${Math.round(performance.now() - start)}`);
});
```

Void 应用可以使用所有 `hono/*` 内置中间件、响应辅助函数，以及 Hono 生态的第三方包。如果要在应用中从 `hono/*` 导入内容，请先在应用中安装 `hono`：

```bash
npm install hono
```

```ts
import { cors } from 'hono/cors';

const allowDashboard = cors({ origin: 'https://app.example.com' });
```

中间件可以全局应用，也可以只应用于单个路由。

### 全局中间件 {#global-middleware}

全局中间件会在每个请求中运行。将文件放在 `middleware/` 中，用数字前缀确定顺序：

- `middleware/01.logger.ts`
- `middleware/02.auth.ts`

```ts
import { defineMiddleware } from 'void';

export default defineMiddleware(async (c, next) => {
  console.log(c.req.method, c.req.path);
  await next();
});
```

使用 `basicAuth()` 可以为站点添加临时访问认证。Void 保留的 `/__void` 端点仍可供部署和开发工具访问。通过回调读取凭据：

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

开发时，将 `BASIC_AUTH_USERNAME` 和 `BASIC_AUTH_PASSWORD` 设置为本地环境变量；部署前，将它们设置为生产环境密钥。

如果应用需要让健康检查或公开 webhook 等请求跳过认证，请在自己的中间件中组合这部分逻辑，再调用 `basicAuth()`。

使用 `c.set()` 与后续处理函数共享数据。扩展 `CloudContextVariables`，即可通过 `c.get()` 进行类型化访问，见[上下文变量](/zh/guide/type-safety#context-variables)。

### 路由级中间件 {#per-route-middleware}

将中间件传给 `defineHandler`，放在最终的路由处理函数之前：

```ts
defineHandler(middleware1, middleware2, handler);
```

中间件按顺序执行。每个中间件都可以提前返回响应而不调用 `next()`，也可以在 `await next()` 之后修改响应。既支持经过 `defineMiddleware` 包装的函数，也支持原始的 Hono `MiddlewareHandler` 函数。

```ts
import { cors } from 'hono/cors';
// routes/api/stats.ts
import { defineHandler } from 'void';

export const GET = defineHandler(cors({ origin: 'https://app.example.com' }), (c) => ({
  stats: '...',
}));
```

处理函数之前最多可以传入 5 个中间件，每个位置都有完整的类型推导。

更多示例见 [Hono 集成指南](/integrations/hono)。
