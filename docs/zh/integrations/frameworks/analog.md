---
outline: deep
---

# Analog {#analog}

将 Void 与 [Analog](https://analogjs.org/) 配合使用，即可获得绑定推断、类型化数据库查询和迁移功能。Analog 继续负责构建和 Cloudflare 集成，Void 则接入其 Vite 配置。

## 配置 {#setup}

### 1. 创建新项目 {#_1-create-a-new-project}

```bash
npx create-analog@latest my-app
cd my-app
```

### 2. 安装依赖 {#_2-install-dependencies}

```bash
npm install -D void nitro-cloudflare-dev
```

Void 提供本地 Cloudflare 绑定运行时。`nitro-cloudflare-dev` 在开发期间创建平台代理，使 `void/db`、`void/kv` 等运行时辅助函数能够访问绑定。

### 3. 配置 `vite.config.ts` {#_3-configure-vite-config-ts}

```ts
import analog from '@analogjs/platform';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    analog({
      ssr: true,
      nitro: {
        preset: 'cloudflare-module',
        cloudflareDev: { configPath: './.void-wrangler.jsonc' },
        modules: ['nitro-cloudflare-dev', 'void/nitro'],
      },
    }),
    voidPlugin(),
  ],
});
```

`void/nitro` 模块让 Analog 的 API 路由和页面服务端加载函数可以使用应用的 `void/db` 和 `@schema`。

### 4. 创建 `void.config.ts` {#_4-create-void-config-ts}

Void 会生成 Analog 开发运行时使用的 Cloudflare 配置：

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

Nitro 的 Cloudflare 运行时需要启用 `nodejs_compat`。`void/*` 运行时辅助函数（例如 `void/db`、`void/kv`）需要启用 `nodejs_als`。

### 5. 部署 {#_5-deploy}

```bash
void auth login
void deploy
```

## 使用 Void 功能 {#using-void-features}

大多数 [Void 平台功能](/zh/guide/app-types#void-apps)都可以在 Analog 中使用。你可以在页面服务端加载函数、action 和 API 路由中使用这些功能：

框架模式目前尚不支持由 Void 管理的身份验证。请直接使用 Better Auth 的官方集成。

### 数据库 {#database}

```ts
// src/app/pages/users.server.ts
import type { PageServerLoad } from '@analogjs/router';
import { users } from '@schema';
import { db } from 'void/db';

export const load = async ({ event }: PageServerLoad) => {
  return { users: await db.select().from(users) };
};
```

### 其他资源 {#other-resources}

在服务端代码中使用 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和 [AI](/zh/guide/ai)，导入方式与 Void 应用相同。在 `crons/` 中添加[定时任务](/zh/guide/jobs)，在 `queues/` 中添加[队列消费者](/zh/guide/queues)。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，然后通过 `import { env } from "void/env"` 读取。有关本地值、生产环境密钥和公开的 `VITE_*` 值，请参阅[环境变量](/zh/guide/env-vars)。

读取环境变量时，使用 `void/env` 代替 H3 事件上下文和 `import { env } from "cloudflare:workers"`。需要直接访问 D1、KV、R2 等原始绑定时，继续使用后两种方式。

## 直接访问绑定 {#accessing-bindings-directly}

你也可以通过 H3 事件上下文或 `cloudflare:workers` 模块访问原始 Cloudflare 绑定：

```ts
import { env } from 'cloudflare:workers';
// src/server/routes/api/users.ts
import { eventHandler } from 'h3';

export default eventHandler(async () => {
  const { results } = await env.DB.prepare('SELECT * FROM users').all();
  return results;
});
```
