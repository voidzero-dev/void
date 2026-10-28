---
outline: deep
---

# Astro {#astro}

将 Void 与 [Astro](https://astro.build/) 配合使用，即可获得绑定推断、类型化数据库查询和迁移功能。Astro 继续负责构建和 Cloudflare 集成，Void 则接入其 Vite 配置。

::: warning 需要 Astro 6

- 在 Astro 应用中使用 `import { x } from "void/x"` 辅助函数需要 [Astro 6+](https://astro.build/blog/astro-6/)。
- 还需要在 Cloudflare 配置的 `compatibility_flags` 中启用 `"nodejs_als"`。
:::

## 配置 {#setup}

### 1. 创建新项目 {#_1-create-a-new-project}

```bash
npm create astro@latest my-app
cd my-app
```

### 2. 安装依赖 {#_2-install-dependencies}

```bash
npm install -D @astrojs/cloudflare void
```

### 3. 配置 `astro.config.mjs` {#_3-configure-astro-config-mjs}

```js
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';
import { voidPlugin } from 'void';

export default defineConfig({
  adapter: cloudflare({ configPath: './.void-wrangler.jsonc' }),
  vite: { plugins: [voidPlugin()] },
});
```

### 4. 创建 `void.config.ts` {#_4-create-void-config-ts}

开发和部署时，Void 会将以下配置用于 Cloudflare 适配器：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'my-app',
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_als'],
  },
});
```

在 Astro 中使用 `void/*` 运行时辅助函数（例如 `void/db`、`void/kv`）需要启用 `nodejs_als`。

### 5. 部署 {#_5-deploy}

```bash
void auth login
void deploy
```

## 使用 Void 功能 {#using-void-features}

使用 Astro 6+ 并启用 `nodejs_als` 后，大多数 [Void 平台功能](/zh/guide/app-types#void-apps)都可以在 Astro 的本地开发和生产环境中使用。

框架模式目前尚不支持由 Void 管理的身份验证。请直接使用 Better Auth 的官方 Astro 集成。

访问运行时绑定的页面必须关闭预渲染：

```astro
---
export const prerender = false;
// now Astro.locals.runtime is available
---
```

### 数据库 {#database}

在 API 路由和服务端代码中使用 `void/db`：

```ts
import { users } from '@schema';
import type { APIRoute } from 'astro';
import { db } from 'void/db';

export const GET: APIRoute = async () => {
  const rows = await db.select().from(users);
  return Response.json(rows);
};
```

### 其他资源 {#other-resources}

在服务端代码中使用 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和 [AI](/zh/guide/ai)，导入方式与 Void 应用相同。在 `crons/` 中添加[定时任务](/zh/guide/jobs)，在 `queues/` 中添加[队列消费者](/zh/guide/queues)。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，然后通过 `import { env } from "void/env"` 读取。有关本地值、生产环境密钥和公开的 `VITE_*` 值，请参阅[环境变量](/zh/guide/env-vars)。

Void 向客户端公开的 schema 键名统一使用 `VITE_*` 前缀，Astro 项目也不例外。直接通过 `import.meta.env` 访问时，仍需遵循 Astro 自身的 `PUBLIC_*` 约定，但该约定不会改变 `void/env` 的服务端与客户端边界。

读取环境变量时，使用 `void/env` 代替 [`astro:env`](https://docs.astro.build/en/guides/environment-variables/) 和 `Astro.locals.runtime.env`。需要直接访问 D1、KV、R2 等原始绑定时，继续使用 `Astro.locals.runtime.env`。

## 直接访问绑定 {#accessing-bindings-directly}

通过 `Astro.locals.runtime.env` 访问绑定（开发和生产环境均可使用）：

```ts
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;
  const { results } = await DB.prepare('SELECT * FROM users').all();
  return Response.json(results);
};
```

在 `.astro` 页面中访问（记得设置 `prerender = false`）：

```astro
---
export const prerender = false;
const { DB } = Astro.locals.runtime.env;
const { results } = await DB.prepare("SELECT * FROM users").all();
---
```
