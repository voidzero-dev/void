---
outline: deep
---

# TanStack Start {#tanstack-start}

在 [TanStack Start](https://tanstack.com/start/latest) 的 Vite 配置中同时添加框架插件和 `voidPlugin()`，即可使用 Void 的数据库、存储和部署功能，无需单独安装 Cloudflare 适配器。

## 配置 {#setup}

### 1. 创建新项目 {#_1-create-a-new-project}

```bash
npm create @tanstack/start@latest my-app
cd my-app
```

### 2. 安装依赖 {#_2-install-dependencies}

```bash
npm install -D void
```

### 3. 配置 `vite.config.ts` {#_3-configure-vite-config-ts}

```ts
import { tanstackStart } from '@tanstack/react-start/plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    voidPlugin(), // must come before the framework plugin
    tanstackStart(),
    react(),
  ],
});
```

### 4. 部署 {#_4-deploy}

```bash
void auth login
void deploy
```

## 使用 Void 功能 {#using-void-features}

大多数 [Void 平台功能](/zh/guide/app-types#void-apps)都可以与 TanStack Start 配合使用。请在服务端函数中使用这些功能：

框架模式目前尚不支持由 Void 管理的身份验证。现阶段请直接使用 Better Auth 官方提供的 TanStack Start 集成。

### 数据库 {#database}

```tsx
import { users } from '@schema';
import { createServerFn } from '@tanstack/react-start';
import { db } from 'void/db';

const getUsers = createServerFn().handler(async () => {
  return db.select().from(users);
});
```

### 其他资源 {#other-resources}

在服务端代码中，可以使用与 Void 应用相同的导入方式来访问 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和 [AI](/zh/guide/ai)。在 `crons/` 中添加[定时任务](/zh/guide/jobs)，在 `queues/` 中添加[队列消费者](/zh/guide/queues)。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，并通过 `import { env } from "void/env"` 读取。有关本地变量值、生产环境密钥和公开的 `VITE_*` 变量值，请参阅[环境变量](/zh/guide/env-vars)。

## 自定义 Worker 入口 {#custom-worker-entry}

当 Worker 需要自定义入口模块时（例如要导出 Durable Object 类），请将 `cloudflare.main` 配置到 `void.config.ts` 中：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: { main: './server.ts' },
});
```

该路径相对于应用根目录。在这个模块中默认导出 TanStack 请求处理函数，并添加所需的具名导出：

```ts
import handler from '@tanstack/react-start/server-entry';

export { Counter } from './counter';
export default handler;
```

Void 会在开发、生产构建和部署时保留这些具名导出。未设置 `cloudflare.main` 时，Void 使用 TanStack 的默认服务端入口。对于 `@tanstack/react-start/server-entry` 这样的包入口，Void 会将其作为模块解析。

还需要在 `cloudflare` 下配置导出的 Durable Object 或 Workflow 类的绑定，例如在 `cloudflare.durable_objects` 中配置。这些设置适用于使用 `void deploy --platform cloudflare` 部署的情况。在 Void 平台上，请使用[持久化状态](/zh/guide/durable-state)。

## 直接访问绑定 {#accessing-bindings-directly}

也可以通过 `cloudflare:workers` 模块访问 Cloudflare 绑定：

```tsx
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```
