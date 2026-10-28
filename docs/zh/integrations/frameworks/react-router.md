---
outline: deep
---

# React Router v7 {#react-router-v7}

在 [React Router v7](https://reactrouter.com/) 的 Vite 配置中同时添加框架插件和 `voidPlugin()`，即可使用 Void 的数据库、存储和部署功能，无需单独安装 Cloudflare 适配器。

## 配置 {#setup}

### 1. 创建新项目 {#_1-create-a-new-project}

```bash
npm create react-router@latest my-app
cd my-app
```

### 2. 安装依赖 {#_2-install-dependencies}

```bash
npm install -D void
```

### 3. 配置 `vite.config.ts` {#_3-configure-vite-config-ts}

```ts
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    voidPlugin(), // must come before the framework plugin
    reactRouter(),
  ],
});
```

### 4. 部署 {#_4-deploy}

```bash
void auth login
void deploy
```

## 使用 Void 功能 {#using-void-features}

大多数 [Void 平台功能](/zh/guide/app-types#void-apps)都可以与 React Router 配合使用。请在 loader 和 action 中使用这些功能：

框架模式目前尚不支持由 Void 管理的身份验证。现阶段请直接使用 Better Auth 官方提供的 React Router 集成。

### 数据库 {#database}

```tsx
import { users } from '@schema';
import { db } from 'void/db';
import type { Route } from './+types/users';

export async function loader({}: Route.LoaderArgs) {
  return { users: await db.select().from(users) };
}
```

### 其他资源 {#other-resources}

在服务端代码中，可以使用与 Void 应用相同的导入方式来访问 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和 [AI](/zh/guide/ai)。在 `crons/` 中添加[定时任务](/zh/guide/jobs)，在 `queues/` 中添加[队列消费者](/zh/guide/queues)。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，并通过 `import { env } from "void/env"` 读取。有关本地变量值、生产环境密钥和公开的 `VITE_*` 变量值，请参阅[环境变量](/zh/guide/env-vars)。

在配套的 `.server.ts` 模块中读取服务端密钥，再将该模块导入 loader 或 action。对于同时包含浏览器组件的路由文件，Void 不允许在其中读取服务端密钥。

## 直接访问绑定 {#accessing-bindings-directly}

也可以通过 `cloudflare:workers` 模块访问 Cloudflare 绑定：

```tsx
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```
