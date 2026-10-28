---
outline: deep
---

# 数据库 {#database}

## `void db push` {#void-db-push}

将 Drizzle schema 直接应用到开发数据库，不创建迁移文件。D1 会更新本地数据库；PostgreSQL 和 MySQL 使用 `.env` 中的 `DATABASE_URL`。

此命令适合在原型开发期间快速调整 schema。部署前，请通过 `void db generate` 生成并审查迁移文件。

## `void db generate` {#void-db-generate}

根据 schema 变更生成 SQL 迁移文件。

将 schema 与最近一次 Drizzle 快照比较，并将迁移写入 `db/migrations/`。即使没有应用 schema，也会包含由 Void 管理的身份认证表和已配置的认证插件。部署前，请审查并提交生成的文件。

对于 SQLite，Void 会检查迁移历史能否应用到新数据库。如果生成过程未通过此检查，会恢复之前的 SQL、快照和迁移日志。如果失败的是已有迁移，请先修复那条尚未应用的迁移：重新生成只会比较快照，不会修复已有 SQL。此检查不验证迁移能否保留现有数据，因此请仔细审查表重建和外键操作。

## `void db status` {#void-db-status}

显示迁移状态。先列出本地已应用和待执行的迁移，再根据已保存的部署目标查询远程状态：Void 项目使用托管平台 API；直接部署到 Cloudflare 的 SQLite 项目使用已固定的 D1 数据库及其配置的迁移表；直接部署到 Cloudflare 的 PostgreSQL/MySQL 项目使用 Shell 中的 `DATABASE_URL`。如果远程凭据或服务不可用，仍会显示本地状态。如果无法读取本地 PostgreSQL 或 MySQL 数据库，本地状态会显示为 `unknown`；此时若远程状态也不可用，命令会失败。

## `void db reset` {#void-db-reset}

```
void db reset [--yes]
```

删除开发数据库的现有结构和数据，并重新应用所有迁移。D1 会重置本地数据库。PostgreSQL 会删除 `.env` 中 `DATABASE_URL` 所指数据库的 `public` schema 内的表、视图、序列和自定义类型，并保留已安装的扩展。如果其他 schema 中的表、视图或函数依赖这些视图、序列或类型，重置会在删除任何内容前停止，并列出相关对象。MySQL 会删除该数据库中的所有表和视图。

当该 `DATABASE_URL` 指向 `localhost` 以外的主机时，Void 会显示数据库名称，并在删除表前请求确认。在脚本和 CI 中可传入 `--yes` 跳过提示；没有终端时，若未设置 `--yes`，命令会停止。如果 `.env` 使用的 URL 与部署使用的 URL 相同，例如运行 `void db connect` 后，重置会删除已部署的表。

## `void db seed` {#void-db-seed}

```
void db seed [--file <path>] [--yes]
```

重置本地数据库、重新应用所有迁移，再执行种子文件填充初始数据。重置行为与 `void db reset` 相同，包括确认提示和 `--yes` 的处理。

省略 `--file` 时，Void 会依次查找以下默认种子文件：`db/seed.ts`、`db/seed.mts`、`db/seed.js`、`db/seed.mjs`、`db/seed.sql`。

如果存在多个默认种子文件，CLI 会停止，并要求通过 `--file <path>` 指定文件。

通过代码编写的种子模块必须导出默认函数或名为 `seed` 的函数。

## `void db execute` {#void-db-execute}

```
void db execute <sql>
void db execute --file <path>
void db execute --remote <sql>
```

对数据库执行临时 SQL。可以直接传入 SQL，也可以从文件读取。SELECT 查询会以格式化表格显示结果；其他语句执行时不输出结果。

默认操作本地数据库。传入 `--remote`，则对 `.void/project.json` 中所选部署目标的数据库执行：

- **Void 平台上的 D1 项目：** 使用你的认证令牌，通过所选平台已注册的代理执行查询。
- **直接部署到 Cloudflare 的 D1 项目：** 针对 `void.config.ts` 或 `void.lock.json` 中已固定的 D1 绑定调用 Cloudflare。
- **托管的 PostgreSQL 和 MySQL 项目：** 从平台获取已保存的连接串，并直接连接数据库。
- **直接部署到 Cloudflare 的 PostgreSQL 和 MySQL 项目：** 使用当前 Shell 中的 `DATABASE_URL`；Cloudflare 无法从 Hyperdrive 返回密码。

在 TTY 中运行破坏性语句（`DELETE`、`UPDATE`、`DROP` 等）时，会在将查询发送到已部署的数据库前请求确认。非 TTY 环境，例如 CI，会跳过提示。

## `void db migrate` {#void-db-migrate}

```
void db migrate [--remote]
```

将待执行迁移应用到本地数据库，不进行重置。与 `void db reset` 不同，此命令会保留现有数据，只执行尚未应用的迁移。

传入 `--remote`，可将待执行迁移应用到已保存的目标。托管项目需要登录 Void 并关联项目。直接部署到 Cloudflare 的 D1 项目使用绑定所配置的迁移目录、迁移表和匹配模式，D1 绑定必须设置 `migrations_dir`。直接部署的 PostgreSQL 和 MySQL 项目使用 Shell 中的 `DATABASE_URL`。

## `void db studio` {#void-db-studio}

```
void db studio [--remote]
```

为数据库打开 [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio)，通过网页图形界面浏览和编辑数据。

默认操作本地数据库。传入 `--remote`，可为已部署的数据库打开 Studio：

- **托管的 PostgreSQL 和 MySQL 项目：** 从平台获取已保存的连接串，并据此打开 Studio。如果尚未保存 URL，请先运行 `void db set-url`。
- **直接部署到 Cloudflare 的 PostgreSQL 和 MySQL 项目：** 使用当前 Shell 中的 `DATABASE_URL`。
- **D1 项目：** 不支持远程 Studio。请使用 `void db execute --remote` 查询已部署的 D1 数据库。

## `void db restore` {#void-db-restore}

```
void db restore --bookmark <bookmark> [--platform cloudflare] [--yes]
void db restore --timestamp <iso-time> [--platform cloudflare] [--yes]
```

使用 D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 恢复直接部署到 Cloudflare 的 D1 数据库。`void deploy --platform cloudflare` 应用迁移前，会输出可用于撤销迁移的 `--bookmark`。也可以通过 `--timestamp` 恢复到指定时间的状态；时间需使用带 `Z` 或时区偏移量的 ISO 8601 格式，例如 `2026-10-16T09:30:00Z`，精度最多为毫秒。Time Travel 在 Workers Free 上保留 7 天历史，在 Workers Paid 上保留 30 天历史。超出范围的书签或时间已无法恢复：Cloudflare 会拒绝操作，数据库保持不变。要撤销更早的迁移，请新建一条反向迁移。

如果项目保存的目标不是 Cloudflare，但曾通过 `void deploy --platform cloudflare` 部署过，请传入 `--platform cloudflare`；部署时输出的命令会包含该选项。

恢复会替换整个数据库，并丢弃恢复点之后的所有写入。Void 会显示数据库名称，并在恢复前请求确认。在脚本和 CI 中可传入 `--yes` 跳过提示；没有终端时，若未设置 `--yes`，命令会停止。完成后，Void 会输出可用于撤销此次恢复的 `void db restore` 命令。

恢复也会回退已应用迁移的记录。Void 会列出数据库不再标记为已应用的迁移文件；下次部署会重新应用这些迁移，因此请先修复或移除导致问题的那条迁移。恢复不会修改已部署的代码：如果线上版本依赖较新的 schema，请使用 [`void project rollback`](/zh/reference/cli/project#void-project-rollback-deployid)。临时部署到 Cloudflare 后，运行 `void project rollback` 和 `void deploy` 时，也应传入 `--platform cloudflare`。

## `void db rename-migrations` {#void-db-rename-migrations}

将已有迁移从旧的数字前缀格式（`0001_name.sql`）重命名为时间戳格式（`20260410161500_name.sql`）。已登录并关联项目时，会更新本地跟踪表和远程记录。部署到 Void 的项目必须先通过 `void project link` 关联，否则命令会停止，不会进行变更。

不支持直接部署到 Cloudflare 的项目：Void 无法重命名已部署数据库中的记录，因此命令会停止，不会进行变更。请保留已有名称；新迁移使用时间戳，并在旧迁移之后执行。

## `void db connect` {#void-db-connect}

连接已有的 PostgreSQL/MySQL 数据库，或通过适配器创建数据库：

```sh
void db connect 'postgresql://user:password@host/database'
NEON_API_KEY=... void db connect --provider neon --name my-app
void db connect --provider @acme/void-db-provider --region region-id
```

该命令会将 `DATABASE_URL` 保存到 `.env`。已登录并关联 Void 项目时，还会更新加密保存的部署 URL；传入 `--local-only` 可以跳过同步。`neon` 已内置。其他适配器可以是项目依赖或本地模块，需要导出 `void/database-provider` 中的 `DatabaseProviderAdapter`。

提供商创建的凭据不会输出到终端。直接部署到 Cloudflare 时，请在执行部署的 Shell 或 CI 环境中，将同一 URL 配置为受保护的 `DATABASE_URL`。

## `void db set-url` {#void-db-set-url}

更新部署使用的 PostgreSQL 或 MySQL 连接串。适用于配置了 `"database": "pg"` 或 `"database": "mysql"` 的项目。

提示输入连接串，再将其发送到平台 API，以创建或更新 Hyperdrive 配置。

## `void db export` {#void-db-export}

```
void db export [--output <path>] [--no-data] [--no-schema] [--table <name>]
```

将本地数据库导出为 SQL。默认写入标准输出，可通过管道传递；使用 `--output` 可以写入文件。

数据导出会保留 SQLite AUTOINCREMENT、PostgreSQL SERIAL 和标识列的计数器值，包括已删除行占用过的 ID。SQLite schema 导出包含索引、视图和触发器。PostgreSQL schema 导出会保留列类型、生成列、标识列定义、serial 序列、约束和索引。`--no-schema` 可将计数器值恢复到已有 schema；`--no-data` 则让计数器从 schema 定义的起始值开始。

如果 PostgreSQL schema 包含视图、触发器、自定义类型、函数或独立序列，请使用 `pg_dump` 获取完整备份。`void db export` 会在写入 schema 导出前报告这些对象。

| 选项 | 用途 |
| --- | --- |
| `--output <path>` | 写入文件，而不是标准输出 |
| `--no-data` | 仅导出 schema，不包含 INSERT 语句 |
| `--no-schema` | 仅导出数据，不包含 CREATE TABLE |
| `--table <name>` | 导出单张表 |
