---
outline: deep
---

# 资源推断 {#resource-inference}

Void 会在启动时扫描源码文件，自动检测项目使用的 Cloudflare 资源，大多数情况下无需手动配置。只要在代码中使用资源，Void 就会为本地开发准备对应的绑定。

## 可检测的绑定 {#detected-bindings}

| 绑定 | 类型 | 通过导入检测 | 通过环境访问检测 |
| --- | --- | --- | --- |
| `DB` | `D1Database` | `import { db } from "void/db"` | `env.DB` 或 `c.env.DB` |
| `KV` | `KVNamespace` | `import { kv } from "void/kv"` | `env.KV` 或 `c.env.KV` |
| `STORAGE` | `R2Bucket` | `import { storage } from "void/storage"` | `env.STORAGE` 或 `c.env.STORAGE` |
| `AI` | `Ai` | `import { ai } from "void/ai"` | `env.AI` 或 `c.env.AI` |
| `SANDBOX` | 托管沙箱能力 | `import { getSandbox } from "void/sandbox"` | `getSandbox()`；Cloudflare 原生部署也提供 `env.SANDBOX` / `c.env.SANDBOX` |
| 身份验证 | 无 | `import { ... } from "void/auth"` 或 `import { auth } from "void/client"` / `void/client/react` / `void/client/vue` / `void/client/svelte` / `void/client/solid` | 无 |
| `QUEUE_*` | `Queue` | `import { queues } from "void/queues"` | `env.QUEUE_*` |
| `VOID_LIVE` | `DurableObjectNamespace` | `import { defineLiveStream } from "void/live"` | 不适用 |
| 根据文件名生成 | `DurableObjectNamespace` | `durable-objects/` 中默认导出 `defineDurableState()` 的模块 | 不适用 |

从 `void/client` 或 `void/client/react` 等框架专用客户端子路径导入 `auth` 时，也会触发身份验证检测；只导入 `fetch` 则不会。

静态方括号访问，例如 `c.env['KV']`，以及解构属性，例如 `const { DB, KV: cache } = c.env`，同样可以被检测到。如果键名在运行时才确定，请使用[显式绑定覆盖](#explicit-binding-overrides)。

持久化状态根据 `durable-objects/` 中的文件推断。例如，`durable-objects/shopping-cart.ts` 会创建 `SHOPPING_CART` 绑定，导出 `ShoppingCartDurableObject`，并记录对应迁移。见[持久化状态](/zh/guide/durable-state)。

## 扫描目录 {#scanned-directories}

### 标准模式 {#standard-mode}

原生 Void 应用默认扫描以下目录。配置了 [`sourceDir`](/zh/reference/config#sourcedir) 后，Void 会改为扫描指定的源码树：

| 目录 | 内容 |
| --- | --- |
| `routes/` | API 路由处理函数 |
| `middleware/` | Hono 中间件 |
| `queues/` | 队列消费者 |
| `pages/` | 页面组件及配套的 `.server.ts` 文件 |
| `crons/` | 定时任务处理函数 |
| `email/` | 收件处理函数 |
| `src/` | 应用源码 |

### 元框架模式 {#framework-mode}

对于[受支持的元框架](/zh/integrations/frameworks/overview)，Void 会扫描以下目录：

| 目录 | 内容 |
| --- | --- |
| `src/` | 应用源码 |
| `app/` | 框架应用目录 |
| `routes/` | 框架路由 |
| `server/` | 服务端代码 |
| `pages/` | 框架页面 |
| `crons/` | 定时任务处理函数 |
| `queues/` | 队列消费者 |

框架检测依据 `package.json` 中的依赖和开发依赖。将 `voidPlugin()` 添加到框架的 Vite 配置，即可在开发期间启用资源推断。各框架的集成指南介绍了具体配置方式。

### 始终扫描的内容 {#always-scanned}

无论使用哪种模式，以下内容都会检查：

- **SSR 入口**，例如 `src/main.ssr.ts`，用于在渲染期间访问绑定的 SSR 应用
- **应用源码**，位于 `src/` 或配置的 `sourceDir` 中，包括资源和身份验证相关的导入
- **`durable-objects/`**：在原生 Void 应用中，会扫描此目录以查找类型化的 Durable Object 状态模块

## 自定义扫描目录 {#custom-scan-directories}

如果代码放在非标准目录中，可以覆盖要扫描的目录：

```json
{
  "inference": {
    "scanDirs": ["src", "lib", "workers"]
  }
}
```

路径相对于项目根目录。设置 `inference.scanDirs` 后，会完整替换默认目录列表，但 SSR 入口和应用源码仍会被扫描。

## 显式绑定覆盖 {#explicit-binding-overrides}

如果推断结果不符合项目需要，可以通过 [`inference.bindings`](/zh/reference/config#inference-bindings) 启用、禁用或重命名绑定。它只覆盖你指定的绑定，其余绑定仍会自动推断。

## 文件类型 {#file-types}

资源推断会扫描 `.ts`、`.tsx`、`.mts`、`.js`、`.jsx`、`.mjs` 文件，以及 Astro frontmatter。请将服务端资源导入写在这些文件中，或写在页面配套的 `.server.ts` 文件中；Vue 和 Svelte 组件文件不会被直接扫描。
