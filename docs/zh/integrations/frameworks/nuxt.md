---
outline: deep
---

# Nuxt {#nuxt}

将 Void 与 [Nuxt](https://nuxt.com/) 配合使用，即可获得绑定推断、类型化数据库查询和迁移功能。Nuxt 继续使用自身的构建流程和 Cloudflare 集成；Void 通过其 Vite 配置接入。

## 配置 {#setup}

### 1. 创建新项目 {#_1-create-a-new-project}

```bash
npm create nuxt@latest my-app
cd my-app
```

### 2. 安装依赖 {#_2-install-dependencies}

```bash
npm install -D void
```

Void 包含 Nuxt 平台代理在开发期间使用的 Cloudflare 工具。

### 3. 配置 `nuxt.config.ts` {#_3-configure-nuxt-config-ts}

```ts
import { resolve } from 'node:path';
import { voidPlugin } from 'void';

export default defineNuxtConfig({
  alias: {
    '@schema': resolve(import.meta.dirname, 'db/schema.ts'),
  },
  nitro: {
    preset: 'cloudflare-module',
    modules: ['void/nitro'],
    cloudflare: { dev: { configPath: './.void-wrangler.jsonc' } },
    // Required for Nuxt 4.6.0 on Windows.
    externals: {
      inline: [/[\\/]node_modules[\\/]nuxt[\\/]dist[\\/]/],
    },
  },
  vite: { plugins: [voidPlugin()] },
});
```

`void/nitro` 模块让 Nuxt 服务端路由可以使用应用的 `void/db` 和 `@schema`。顶层 `alias` 让 `nuxi typecheck` 能够解析 `@schema`，因为 Nuxt 也会使用应用的类型来检查服务端路由。`cloudflare.dev` 为开发服务器提供 Void 生成的 Cloudflare 配置中的绑定；当 `compatibilityDate` 为 `2025-07-15` 或更晚的日期时，Nuxt 会在开发期间运行该代理。

### 4. 创建 `void.config.ts` {#_4-create-void-config-ts}

Void 生成供 Nuxt 开发运行时使用的 Cloudflare 配置：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'my-app',
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat', 'nodejs_als'],
  },
});
```

### 5. 部署 {#_5-deploy}

```bash
void auth login
void deploy
```

## 使用 Void 功能 {#using-void-features}

大多数 [Void 平台功能](/zh/guide/app-types#void-apps)都可用于 Nuxt。请在服务端路由、API 处理函数和中间件中使用这些功能：

框架模式暂不支持由 Void 管理的身份验证。目前请直接使用 Better Auth 的官方 Nuxt 集成。

### 数据库 {#database}

```ts
import { users } from '@schema';
// server/api/users.get.ts
import { db } from 'void/db';

export default defineEventHandler(async () => {
  return db.select().from(users);
});
```

### 其他资源 {#other-resources}

在服务端代码中使用 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和 [AI](/zh/guide/ai) 时，导入方式与 Void 应用相同。在 `crons/` 中添加[定时任务](/zh/guide/jobs)，在 `queues/` 中添加[队列消费者](/zh/guide/queues)。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，并通过 `import { env } from "void/env"` 读取。有关本地值、生产环境密钥和公开的 `VITE_*` 值，请参阅[环境变量](/zh/guide/env-vars)。

访问环境变量时，使用 `void/env` 替代 `useRuntimeConfig()` 和 `event.context.cloudflare.env`。需要访问原始绑定（D1、KV、R2 等）时，继续使用 `event.context.cloudflare.env`；需要与环境变量无关的运行时配置时，继续使用 `useRuntimeConfig()`。

## 直接访问绑定 {#accessing-bindings-directly}

也可以通过 Nitro 的事件上下文访问原始 Cloudflare 绑定：

```ts
// server/api/users.get.ts
export default defineEventHandler(async (event) => {
  const { DB } = event.context.cloudflare.env;
  const { results } = await DB.prepare('SELECT * FROM users').all();
  return results;
});
```
