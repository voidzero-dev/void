---
outline: deep
---

<script setup>
import LegacyDocRedirect from "../../.vitepress/theme/LegacyDocRedirect.vue";
import links from "../../.vitepress/redirects/reference-api.json";

const zhLinks = Object.fromEntries(
  Object.entries(links).map(([anchor, target]) => [anchor, `/zh${target}`]),
);
</script>

<LegacyDocRedirect page="zh/reference/api.md" :links="zhLinks" />

# API 参考 {#api-reference}

本参考用于查找公开的导入路径、函数签名和返回类型。配置方法和示例请先参阅[指南](/zh/guide/)。

## API 主题 {#api-topics}

| 主题 | 用途 |
| --- | --- |
| [插件与配置](/zh/reference/api/plugin) | 将 Void 添加到 Vite，并配置应用。 |
| [处理函数与中间件](/zh/reference/api/handlers) | HTTP 路由、校验、定时任务、队列和渲染。 |
| [重写](/zh/reference/api/rewrites) | 在保留请求 URL 的情况下，返回其他路由的内容。 |
| [身份验证](/zh/reference/api/auth) | 会话、用户和身份验证客户端。 |
| [Fetch 客户端](/zh/reference/api/client) | 类型化请求与错误。 |
| [持久化状态与 WebSockets](/zh/reference/api/durable) | 持久化对象与类型化连接。 |
| [数据库与初始数据](/zh/reference/api/database) | 查询、运算符和种子脚本。 |
| [KV、存储、AI 与日志](/zh/reference/api/resources) | 资源客户端、缓存重新验证和日志。 |
| [部署产物](/zh/reference/api/deploy) | 将已构建的应用打包，用于托管部署。 |
| [类型](/zh/reference/api/types) | 处理函数上下文、路由类型和页面头部元数据。 |
| [环境变量](/zh/reference/api/env) | 经过校验的环境变量值和绑定类型。 |
| [Pages 适配器](/zh/reference/api/pages) | React、Vue、Svelte、Solid 和 Markdown。 |

## 面向应用开发的导入 {#user-facing-imports}

通过以下路径导入 Void 的应用开发 API：

| 导入路径 | 内容 |
| --- | --- |
| `void` | `voidPlugin`、处理函数和类型的重新导出、`defer`、`Deferred`、`DeferredState`、`InferProps`、`HeadDescriptor` |
| `void/handler` | `defineHandler`、`defineMiddleware`、`basicAuth`、`defineScheduled`、`defineQueue`、`defineRender`、`defineHead` 及相关类型 |
| `void/auth` | `defineAuth`、`getUser`、`getSession`、`requireAuth`、`AuthUser`、`AuthSession`、`AuthState` |
| `void/client` | `fetch`、`fetchStream`、`FetchError`、`auth`、`createAuthClient`、`AuthUser`、`AuthSession`、`AuthState` |
| `void/client/{framework}` | 与 `void/client` 相同，另提供适用于 `react`、`vue`、`svelte` 和 `solid` 的 Better Auth 客户端 |
| `void/ws` | `defineRoom`、`defineWebSocket`、`connect`，以及 WebSocket 上下文和连接类型 |
| `void/durable` | `defineDurableState`、`defineDurableObject`，以及类型化状态、RPC、上下文和迁移相关类型 |
| `void/sse` | `eventStream`、`formatSse`、`formatSseText`、`getLastEventId`、`SseStreamClosedError`，以及 SSE 消息和流类型 |
| `void/sse/client` | `connectEventStream`，以及浏览器 `EventSource` 封装的相关类型 |
| `void/live` | `defineLiveStream`，以及 SSE 主题事件分发的运行时类型。仅供服务端使用。 |
| `void/live/client` | `connectLiveStream`，通过一条 SSE 连接和 POST 请求实现订阅、取消订阅控制的浏览器辅助函数。 |
| `void/response` | `convertReturnValue` |
| `void/validator` | `runValidation`、`ValidatorSlots`、`HandlerInput` |
| `void/drizzle-zod` | 重新导出 [`drizzle-zod`](https://orm.drizzle.team/docs/zod)，用于从 Drizzle 表的 schema 派生 Zod 校验器 |
| `void/drizzle-valibot` | 重新导出 [`drizzle-valibot`](https://orm.drizzle.team/docs/valibot)，用于从 Drizzle 表的 schema 派生 Valibot 校验器 |
| `void/drizzle-arktype` | 重新导出 [`drizzle-arktype`](https://orm.drizzle.team/docs/arktype)，用于从 Drizzle 表的 schema 派生 ArkType 校验器 |
| `void/schema-d1` | 重新导出 [`drizzle-orm/sqlite-core`](https://orm.drizzle.team/docs/column-types/sqlite)，用于定义 D1 的表和列 |
| `void/schema-pg` | 重新导出 [`drizzle-orm/pg-core`](https://orm.drizzle.team/docs/column-types/pg)，用于定义 PostgreSQL 的表和列 |
| `void/schema-mysql` | 重新导出 `drizzle-orm/mysql-core`，用于定义 MySQL 的表和列 |
| `void/database-provider` | `defineDatabaseProvider`，以及供 `void db connect --provider` 使用的适配器类型 |
| `void/db` | `db`（当前方言对应的 Drizzle D1、PostgreSQL 或 MySQL 实例）、`createDb`，以及查询运算符（`eq`、`and`、`or`、`desc`、`like`、`inArray` 等） |
| `void/seed` | `defineSeed`、`SeedContext`、`SeedFn`，用于通过代码编写 `void db seed` 模块 |
| `void/kv` | `kv`、`createKV`，以及类型化 KV 客户端和映射类型 |
| `void/storage` | `storage`、`createStorage`，用于访问推断出的 R2 绑定或指定的 `R2Bucket` |
| `void/ai` | `ai`、`VoidAi`，以及模型输入和响应类型 |
| `void/limits` | `UsageLimit`、`UsageLimitData` 和 `readUsageLimit`。AI 或 Sandbox 达到用量限制时，返回的 Promise 会因 `UsageLimit` 错误而失败；Void 路由和 Pages Action 中未捕获该错误时，会返回结构化 HTTP 429 响应。 |
| `void/isr` | `revalidate(options)`，用于按需使 ISR 缓存失效 |
| `void/log` | `logger` 结构化日志辅助函数 |
| `void/routes` | `RouteMap` 和 `WebSocketRouteMap` 占位定义，仅包含类型 |
| `void/queues` | `queues` 代理，用于向类型化队列发送消息 |
| `void/email` | `sendEmail`、`createEmail`、`defineEmail`、`parseEmail`、`replyEmail`、`MimeError`、`ParseEmailError`，以及地址、附件、结果和处理函数类型。请参阅[邮件](/zh/guide/email)。 |
| `void/email/testing` | `createEmailTestHarness` 和 `createInboundTestHarness`，用于捕获发出的邮件，并向 `email/` 处理函数投递测试邮件。 |
| `void/sandbox` | `getSandbox`、`sandbox`、`SandboxLimitError`、`SandboxUnavailableError`，以及 SDK 1.0 的文件、备份和挂载辅助方法。`getSandbox(id)` 用于获取客户端。命令执行、文件操作、端口请求和等待进程结束都会返回 Promise；达到限制时，这些 Promise 会因 `SandboxLimitError` 错误而失败，该错误继承自 `UsageLimit`。容器会在空闲超时（默认十分钟）、崩溃或重启前保留状态。API 和部署要求请参阅 [Sandbox](/zh/guide/sandboxes)。 |
| `void/env` | `defineEnv`、`env`、schema 辅助函数（`string`、`number`、`boolean`、`url`、`email`、`oneOf`、`json`），以及全局 Cloudflare 环境类型 |
| `void/nitro` | 适用于 Nuxt 和 Analog 的 Nitro 模块。将 `'void/nitro'` 添加到 Nitro 的 `modules` 中，即可让服务端路由访问应用的 `void/db` 和 `@schema` |
| `void/sveltekit` | SvelteKit 集成辅助函数：`withVoidTSConfig()` 和 `mergeVoidSvelteKitTsconfig()` |
