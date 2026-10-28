---
outline: deep
---

# Node.js、Bun 和 Deno {#node-js-bun-and-deno}

在 `void.config.ts` 中设置 `target`，即可为 Node.js、Bun 或 Deno 构建应用。构建后的服务器可以在自己的机器、容器或托管服务上运行。

```json
{ "target": "node" }
```

## 快速开始 {#getting-started}

### 1. 配置目标运行时 {#_1-configure-the-target}

```json
// void.config.ts
{ "target": "node" }
```

### 2. 安装服务器依赖（仅 Node.js） {#_2-install-the-server-dependency-node-js-only}

Node.js 需要额外安装 `@hono/node-server` 依赖。Bun 和 Deno 则使用内置的 HTTP 服务器。

```bash
npm install @hono/node-server
```

### 3. 开发 {#_3-develop}

```bash
npx vite dev
```

编辑路由和页面时，开发服务器会自动重新加载。

### 4. 构建并运行 {#_4-build-and-run}

```bash
npx vite build
node dist/ssr/index.js
```

使用 Bun：

```bash
bunx vite build
bun dist/ssr/index.js
```

使用 Deno：

```bash
deno run -A npm:vite build
deno run -A dist/ssr/index.js
```

在应用目录下运行这些命令。服务器监听 `PORT` 环境变量指定的端口，默认为 `3000`。

部署时，将 `dist/ssr` 和 `dist/client` 一起部署。

## 构建产物 {#build-output}

构建会生成两个入口文件：

```
dist/
  ssr/
    app.js       ← Hono app with static asset middleware (default export)
    index.js     ← imports app.js and starts the HTTP server
  client/        ← static assets (pages mode only)
    .vite/manifest.json
    assets/
      ...
```

- **`app.js`：**导出 Hono 应用实例，可用于在代码中嵌入应用、测试或配置自定义服务器。
- **`index.js`：**导入 `app.js` 并启动服务器。生产环境中运行此文件。

`vite preview` 也通过 `app.js` 在本地运行构建后的应用。

已安装且依赖 `void` 的包会被打包到 `dist/ssr` 中。如果这些包的某个依赖使用原生扩展，或会读取其自身代码旁的文件，请将该依赖添加到应用的 `dependencies` 中，版本需与该包使用的版本一致。这样，构建时会将它留给 Node 加载。

## 支持的功能 {#what-works}

以下 Void 功能在所有目标运行时中的行为一致：

- [文件路由](/zh/guide/server-routing)（`routes/`、`middleware/`）
- 支持 SSR 的[页面模式](/zh/guide/pages-routing/overview)（React、Vue、Svelte、Solid）
- [类型安全的 fetch 客户端](/zh/guide/typed-fetch)（`void/client`）
- [自定义响应头](/zh/guide/edge/headers)（`routing.headers`）
- [重定向](/zh/guide/edge/redirects)（`routing.redirects`）
- [静态站点生成](/zh/guide/ssg)
- [Vite preview](https://vite.dev/guide/cli#vite-preview)，用于在本地测试生产构建

## 功能差异 {#what-s-different}

### 环境变量 {#environment-variables}

通过运行环境的环境变量提供服务端配置值。在 Node.js 或 Bun 中使用 `process.env` 读取，在 Deno 中使用 `Deno.env.get()` 读取。`void/env` 的 schema 和密钥管理工作流需要 Cloudflare。

浏览器端代码使用 Vite 的 `import.meta.env.VITE_*` 值。这些值会在构建时嵌入产物，不能包含密钥。

### 不支持 Cloudflare 绑定 {#no-cloudflare-bindings}

在非 Cloudflare 目标运行时中，以下导入**不可用**，使用时会产生编译错误：

| 导入         | Cloudflare 功能               |
| -------------- | ------------------------ |
| `void/db`      | D1（SQL 数据库）        |
| `void/kv`      | KV（键值存储）   |
| `void/storage` | R2（对象存储）        |
| `void/auth`    | 由 Void 管理的 Better Auth |
| `void/ai`      | Workers AI               |
| `void/sandbox` | Cloudflare Sandboxes     |
| `void/env`     | 类型化环境变量 schema |

如需数据库或存储，请使用外部服务，并通过标准 Node.js 库连接。

WebSocket 路由文件（`*.ws.ts`）需要 Cloudflare。你仍可使用 `void/ws` 浏览器客户端，连接单独托管的 WebSocket 服务器。

### 不提供定时任务运行时 {#no-cron-job-runtime}

你仍可在 `crons/` 中定义[定时任务](/zh/guide/jobs)，它们会被编译进产物，但没有内置调度器来调用。在 Cloudflare 上，Workers Cron Triggers 会自动调用 `scheduled` 处理函数。在 Node.js 上，则需要外部调度器（例如 `node-cron`、systemd 定时器或托管平台的 cron）来触发导出的处理函数。

### 不支持接收邮件 {#no-inbound-email}

[入站邮件处理函数](/zh/guide/email/receiving#inbound)和 `sendEmail` 需要 Cloudflare。其他目标运行时请使用外部邮件服务。

### 不支持预渲染 {#no-prerendering}

[边缘预渲染](/zh/guide/edge/prerendering)需要 Cloudflare。所有目标运行时都支持构建时的[静态生成](/zh/guide/ssg)。

### 不支持 `void deploy` {#no-void-deploy}

`void deploy` 用于部署到 Cloudflare 和 Void 平台。使用 Node.js、Bun 或 Deno 时，请运行 `vite build`，再按照托管服务的流程部署 `dist/`。

### 会被忽略的配置字段 {#ignored-config-fields}

使用其他目标运行时时，Void 会对 `void.config.ts` 中以下 Cloudflare 专用字段发出警告，并忽略它们：

- `inference.bindings`：Cloudflare 绑定配置
- `remote`：远程绑定代理
- `worker`：Cloudflare 专用配置
- `routing.revalidate`：边缘缓存，仅支持 Cloudflare

如果通过 `void/auth`、`void/client` 或 `auth.ts` 启用身份验证，非 Cloudflare 目标的构建会失败。部署到 Node/Bun/Deno 时，请直接使用 Better Auth。

## 通过代码调用 {#programmatic-usage}

`app.js` 导出了 Hono 应用，因此可以将它导入自定义服务器：

```ts
import app from './dist/ssr/app.js';

// Use with any Node.js HTTP framework
const response = await app.fetch(new Request('http://localhost/api/hello'));
console.log(await response.json()); // { message: "Hello from Node.js!" }
```

这适用于测试、将应用嵌入 Express/Fastify，或在支持 `fetch` 处理函数的无服务器环境中运行。
