---
outline: deep
---

# SvelteKit {#sveltekit}

将 Void 与 [SvelteKit](https://svelte.dev/docs/kit) 配合使用，即可获得绑定推断、类型化数据库查询和迁移功能。SvelteKit 继续使用自身的构建流程和 Cloudflare 集成；Void 通过其 Vite 配置接入。

Void 支持 SvelteKit 3，以及 SvelteKit 2.62 及以上版本。以下配置使用 SvelteKit 3 和 `@sveltejs/adapter-cloudflare` 8。

## 配置 {#setup}

### 1. 创建新项目 {#_1-create-a-new-project}

```bash
npx sv create my-app
cd my-app
```

### 2. 安装依赖 {#_2-install-dependencies}

```bash
npm install -D @sveltejs/adapter-cloudflare void
```

### 3. 配置 `vite.config.ts` {#_3-configure-vite-config-ts}

```ts
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { voidPlugin } from 'void';

export default {
  plugins: [
    voidPlugin(),
    sveltekit({
      adapter: adapter({
        config: './.void-wrangler.jsonc',
        platformProxy: { configPath: './.void-wrangler.jsonc' },
      }),
    }),
  ],
};
```

### 4. 创建 `void.config.ts` {#_4-create-void-config-ts}

如上所示，将 SvelteKit 适配器指向 Void 生成的 Cloudflare 配置。在 `void.config.ts` 中添加 Cloudflare 设置：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'my-app',
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat'],
  },
});
```

### 5. 配置 `tsconfig.json` {#_5-configure-tsconfig-json}

继承 SvelteKit 生成的配置，以及 Void 生成的类型和数据库别名：

```json
{
  "extends": ["$app/tsconfig", "./.void/tsconfig.json"],
  "compilerOptions": {
    "types": ["$app/types", "void/env"]
  },
  "include": ["src", "db", "crons", "queues", "*.ts"]
}
```

首次克隆项目后，或在 CI 中进行类型检查前，运行 `void prepare`，确保 SvelteKit 同步配置之前 `.void/tsconfig.json` 已存在。对于 SvelteKit 3 的 `#lib` 等别名，请使用 `package.json` 子路径导入。

### 6. 部署 {#_6-deploy}

```bash
void auth login
void deploy
```

## 使用 Void 功能 {#using-void-features}

大多数 [Void 平台功能](/zh/guide/app-types#void-apps)都可用于 SvelteKit。请在服务端加载函数、action 和 API 路由中使用这些功能：

框架模式暂不支持由 Void 管理的身份验证。目前请直接使用 Better Auth 的官方 SvelteKit 集成。

### 数据库 {#database}

```ts
import { users } from '@schema';
// src/routes/users/+page.server.ts
import { db } from 'void/db';

export async function load() {
  return { users: await db.select().from(users) };
}
```

### 其他资源 {#other-resources}

在服务端代码中使用 [KV](/zh/guide/kv)、[对象存储](/zh/guide/storage)和 [AI](/zh/guide/ai) 时，导入方式与 Void 应用相同。在 `crons/` 中添加[定时任务](/zh/guide/jobs)，在 `queues/` 中添加[队列消费者](/zh/guide/queues)。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，并通过 `import { env } from "void/env"` 读取。有关本地值、生产环境密钥和公开的 `VITE_*` 值，请参阅[环境变量](/zh/guide/env-vars)。

## 直接访问绑定 {#accessing-bindings-directly}

在 SvelteKit 3 的服务端代码中使用 `cloudflare:workers` 模块：

```ts
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```

## 现有 SvelteKit 2 应用 {#existing-sveltekit-2-apps}

使用 SvelteKit 2.62 及以上版本，并搭配 `@sveltejs/adapter-cloudflare` 7。上面的 Vite 配置同样适用于 Kit 2；请在 `sveltekit()` 选项中添加 Void 的 tsconfig 钩子：

```ts
import { withVoidTSConfig } from 'void/sveltekit';

sveltekit({
  adapter: adapter({
    config: './.void-wrangler.jsonc',
    platformProxy: { configPath: './.void-wrangler.jsonc' },
  }),
  typescript: {
    config: withVoidTSConfig(),
  },
});
```

保留 Kit 2 的 tsconfig 配置：

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "types": ["void/env"]
  }
}
```

如果应用使用 `svelte.config.js` 或 `svelte.config.ts`，请保留其中的配置，并在 `kit` 下添加 `typescript.config: withVoidTSConfig()`。Kit 2 的 `platform.env` 仍可在钩子和加载函数中使用。
