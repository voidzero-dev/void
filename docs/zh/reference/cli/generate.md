---
outline: deep
---

# 代码生成 {#code-generation}

## `void gen model` {#void-gen-model}

```
void gen model <name> [columns...]
```

生成 Drizzle 表、用于列出和创建数据的路由，以及按 ID 查询单条数据的路由。

```sh
void gen model posts title:string body:text published:boolean
```

生成以下内容：

- `db/schema/posts.ts`：包含 `id`、`createdAt`、`updatedAt` 和指定列的表
- 在 `db/schema.ts` 中添加对应导出
- `routes/api/posts/index.ts`：用于列出数据的 `GET` 和带校验的插入操作 `POST`
- `routes/api/posts/[id].ts`：按 id 查询的 `GET`，包含 `404` 处理
- 在 `.void/` 中重新生成类型和 TypeScript 配置

生成路由时，会从 `package.json` 自动检测使用的校验库（`valibot`、`zod` 或 `arktype`）。如果没有找到，会提示你选择一个，或跳过校验。运行 `void db push` 可在本地应用 schema，也可以在部署前运行 `void db generate` 创建迁移。

列的格式为 `name:type` 或 `name:type?`（允许为空）。支持的类型为 `string`、`text`、`datetime`、`integer`、`boolean`、`real` 和 `blob`。

模型名只能包含小写字母、数字和下划线，例如 `posts`、`user_roles`。已有文件不会被覆盖。

## `void gen migration` {#void-gen-migration}

```
void gen migration <name>
```

创建带时间戳前缀（`YYYYMMDDHHMMSS`）的空迁移文件。

```sh
void gen migration add_avatar_to_users
# → db/migrations/20260410161500_add_avatar_to_users.sql
```

已有项目如果使用旧的数字前缀（`0001_`、`0002_` 等），可以通过 `void db rename-migrations` 重命名。

## `void gen route` {#void-gen-route}

```
void gen route <path> [--methods get,post,...]
```

创建包含 `defineHandler` 导出的路由文件，默认使用 GET 方法。

```sh
void gen route api/health
void gen route api/users --methods get,post,delete
```

生成 `routes/<path>.ts`，为每种方法导出一个处理函数。支持的方法为 `get`、`post`、`put`、`patch` 和 `delete`。

## `void gen middleware` {#void-gen-middleware}

```
void gen middleware <name>
```

创建带数字前缀的中间件文件，默认导出 `defineMiddleware`。

```sh
void gen middleware auth
# → middleware/01.auth.ts (or 02, 03, etc.)
```

前缀会根据已有的中间件文件自动确定。

## `void gen ssr` {#void-gen-ssr}

```
void gen ssr [--react | --vue | --svelte | --solid]
```

为所用框架生成 SSR 入口和最小的 App 组件。

生成三个文件：

- `src/main.ssr.{tsx,ts}`：使用 `defineRender` 的服务端入口
- `src/main.client.{tsx,ts}`：执行水合的客户端入口
- `src/App.{tsx,vue,svelte}`：最小的交互组件

未指定选项时，会从 `package.json` 的依赖中自动检测框架。

## `void gen cron` {#void-gen-cron}

```
void gen cron <name>
```

在 `crons/` 中创建定时任务文件，包含 `defineScheduled` 和占位的 cron 表达式。

```sh
void gen cron hourly-sync
```

## `void gen queue` {#void-gen-queue}

```
void gen queue <name>
```

在 `queues/` 中创建队列消费者文件，包含 `defineQueue`、`Message` 类型，以及以注释形式提供的批处理选项。

```sh
void gen queue emails
```
