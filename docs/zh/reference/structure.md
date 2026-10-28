---
outline: deep
---

<script setup>
const items = [
  { name: "routes/", description: "API 端点（基于文件的路由）", link: "#routes" },
  { name: "pages/", description: "全栈服务端渲染页面", link: "#pages" },
  { name: "middleware/", description: "全局请求中间件", link: "#middleware" },
  { name: "db/", description: "Drizzle schema 和 SQL 迁移", link: "#db" },
  { name: "crons/", description: "Cron 定时任务", link: "#crons" },
  { name: "queues/", description: "异步队列消费者", link: "#queues" },
  { name: "email/", description: "收件处理函数", link: "#email" },
  { name: "durable-objects/", description: "持久化状态模块", link: "#durable-objects" },
  { name: "src/", description: "应用共享代码", link: "#src" },
  { name: "public/", description: "静态资源（原样提供）", link: "#public" },
  { name: ".void/", description: "自动生成（由 Git 忽略）", link: "#void" },
  { name: "vite.config.ts", description: "包含 voidPlugin() 的 Vite 配置", link: "#config-files" },
  { name: "void.config.ts", description: "Void 项目配置（可选）", link: "#config-files" },
  { name: ".env", description: "本地环境变量值", link: "#config-files" },
  { name: "env.ts", description: "环境变量 schema", link: "#config-files" },
  { name: "package.json" },
  { name: "tsconfig.json" },
];

const middlewareItems = [
  {
    name: "middleware/",
    children: [
      { name: "01.logger.ts", description: "第一个执行" },
      { name: "02.auth.ts", description: "第二个执行" },
    ],
  },
];

const dbItems = [
  {
    name: "db/",
    children: [
      { name: "schema.ts", description: "Drizzle schema（唯一依据）" },
      { name: "schema/", description: "可选：拆分为多个文件" },
      {
        name: "migrations/",
        children: [
          { name: "20260410161500_*.sql" },
          { name: "20260410161501_*.sql" },
        ],
      },
    ],
  },
];

</script>

# 项目结构 {#project-structure}

## 概览 {#overview}

Void 应用通过基于文件的约定定义路由、页面、中间件等。所有目录都是可选的，只需保留应用实际使用的部分。

<FileTree :items="items" />

## `routes/` {#routes}

基于 [Hono](https://hono.dev) 的文件式 HTTP API 端点。每个文件导出以 HTTP 方法命名的处理函数。

<RoutesFileTree />

- **具名导出**：`export const GET = defineHandler(...)`、`export const POST = ...`
- **扩展名**：`.ts`、`.tsx`、`.js`、`.jsx`、`.mts` 或 `.mjs`；包含 JSX 的处理函数使用 `.tsx` 或 `.jsx`
- **动态路径段**：`[id]` 会成为路由参数 `:id`
- **兜底匹配**：`[...slug]` 匹配剩余路径
- **路由组**：`(admin)/` 用于组织文件，不影响 URL 路径
- **以 `_` 开头的文件**会被忽略
- **环境后缀**：`debug.dev.ts` 仅在开发环境中构建，`metrics.prod.ts` 仅在生产环境中构建

完整指南见[服务端路由](/zh/guide/server-routing)。

## `pages/` {#pages}

全栈服务端渲染页面，数据加载代码与页面放在一起。支持 Vue、React、Svelte 和 Solid 适配器。

<PagesFileTree />

- **`.server.ts` 文件（或 `.tsx`、`.js`、`.jsx`、`.mts`、`.mjs`）**与同名页面组件配对，导出 `loader` 为 `GET` 请求加载数据，导出 `action` 处理数据变更
- **布局**会自动嵌套，并在页面导航时保留
- 支持带 frontmatter 的 **Markdown** 页面
- **环境后缀**：`debug.dev.tsx` 仅在开发环境中提供，`stats.prod.tsx` 仅在生产环境中提供

完整指南见[页面路由](/zh/guide/pages-routing/overview)。

## `middleware/` {#middleware}

每个请求都会执行的全局中间件，通过数字前缀控制执行顺序。

<FileTree :items="middlewareItems" default-expanded />

每个文件默认导出一个 `defineMiddleware()` 处理函数。使用中间件设置所有路由都能访问的共享上下文，例如身份验证、日志和限流信息。

## `db/` {#db}

用于 D1、PostgreSQL 或 MySQL 的 [Drizzle schema](/zh/guide/database#schema-definition) 和 SQL 迁移。

<FileTree :items="dbItems" default-expanded />

- `db/schema.ts`：Drizzle 表定义，也是数据库类型的唯一依据
- `db/schema/`：可选。将表拆分到独立文件，再从 `db/schema.ts` 重新导出
- `db/migrations/`：生成的 SQL 迁移文件，部署时按顺序执行

通过 `void gen model` 生成 schema，也可以手动编写。通过 `void db generate` 生成迁移。

## `crons/` {#crons}

[定时任务](/zh/guide/jobs)。每个文件导出 `cron` 表达式，并默认导出 `defineScheduled()` 处理函数。

## `queues/` {#queues}

[队列消费者](/zh/guide/queues)。每个文件默认导出 `defineQueue()` 处理函数。

## `email/` {#email}

[收件处理函数](/zh/guide/email/receiving#inbound)。文件名决定匹配的收件地址，`_default.ts` 处理其他地址。

## `durable-objects/` {#durable-objects}

[持久化状态](/zh/guide/durable-state)模块。每个文件默认导出一个 `defineDurableState()` 定义。

## `src/` {#src}

应用共享代码，例如组件、工具函数和类型。此目录没有特殊约定，可以按自己的需要组织。

## `public/` {#public}

在站点根路径下原样提供的静态资源。Vite 不会处理这里的文件。

## `.void/` {#void}

生成的类型和本地开发状态，由 Git 忽略。运行 `void prepare` 创建类型，也可以让 `vite dev` 和 `vite build` 更新类型。

## 配置文件 {#config-files}

| 文件 | 用途 |
| --- | --- |
| `vite.config.ts` | Vite 配置，必须包含 `voidPlugin()`。 |
| `void.config.ts` | 可选的 Void 配置，用于设置[路由](/zh/reference/config#routing)、[资源推断](/zh/reference/config#inference)和 [Worker 设置](/zh/reference/config#worker)。 |
| `tsconfig.json` | TypeScript 配置。继承 `.void/tsconfig.json` 可使用自动生成的类型；如果已有配置已经使用 `extends`，运行 `void init --tsconfig`。 |
| `.env` | 仅用于本地开发的值，由 Git 忽略，绝不会部署。 |
| `env.ts` | 提交到仓库的环境变量名称、类型、默认值和是否必填的定义。 |

本地开发、生产环境密钥和客户端构建的相关行为，见[环境变量](/zh/guide/env-vars)。
