---
outline: deep
---

# MySQL {#mysql}

通过 [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) 连接自己的 MySQL 数据库，再使用 Drizzle 定义表并查询数据。Void 会在部署时配置连接并执行迁移。

## 配置 {#configure}

在 `void.config.ts` 中设置数据库方言：

```json
{
  "database": "mysql"
}
```

为本地开发添加直连地址：

```dotenv
DATABASE_URL=mysql://user:password@host:3306/app
```

开发服务器和 `void db` 命令会从 `.env` 读取配置。在生产环境中，Worker 通过自动推断出的 `HYPERDRIVE` 绑定连接数据库。

## 定义 schema {#define-a-schema}

```ts
// db/schema.ts
import { int, mysqlTable, text, timestamp } from 'void/schema-mysql';

export const messages = mysqlTable('messages', {
  id: int('id').autoincrement().primaryKey(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

项目使用 MySQL 方言时，`void gen model` 会自动生成对应的 MySQL 表定义代码。

## 迁移 {#migrations}

使用常规流程：

```sh
void db generate
void db migrate
void deploy
```

直接部署到 Cloudflare 时，请在运行 `void deploy --platform cloudflare` 的 Shell 中导出生产环境的 `DATABASE_URL`。Void 会在上传 Worker 前，使用该地址创建 Hyperdrive，并执行已提交到仓库、尚未应用的迁移；该地址不会写入 Worker 配置。

同一数据库上同时只能执行一项迁移操作。这一限制适用于 `void db migrate`、`void db reset`、`void db seed` 在加载数据前执行的重置、`void deploy --platform cloudflare`，以及使用该数据库的任何项目的 `void deploy`。Better Auth 的表变更也在同一轮迁移中执行。若已有迁移在执行，后续操作会等待：通过 `DATABASE_URL` 直连的命令最多等待约 20 秒，部署到 Void 平台的 `void deploy` 最多等待约 2 分钟。超时后会报错并停止，提示你重试。

### 迁移失败 {#failed-migrations}

每个迁移文件都在事务中执行，因此，如果文件只修改数据，执行失败后数据库会保持不变。但在启用分片的 Vitess 键空间（keyspace）中，例如采用分片的 PlanetScale 数据库，某个分片提交失败，不会撤销其他分片已经完成的提交。MySQL 会立即提交 `CREATE TABLE`、`ALTER TABLE` 等 schema 变更，因此，包含 schema 变更的迁移文件如果中途失败，之前已执行的语句仍然生效。错误信息会指出失败的文件。

恢复时，请先撤销已应用的语句，修正迁移文件，再次运行 `void db migrate` 或 `void deploy`：

```sh
void db execute "DROP TABLE comments"
void db execute --remote "DROP TABLE comments" # deployed database
```

MySQL 不允许在 `ADD COLUMN` 和 `CREATE INDEX` 上使用 `IF NOT EXISTS`，因此，撤销语句通常比将其改写为可安全重复执行的形式更简单。迁移越小，需要撤销的内容就越少。

## 数据库命令 {#database-commands}

`void db push`、`generate`、`migrate`、`status`、`reset`、`seed`、`execute`、`studio`、`export`、`rename-migrations` 和 `set-url` 均支持 MySQL。本地命令使用 `.env` 中的 `DATABASE_URL`；`--remote` 执行和 Studio 则使用已关联 Void 项目所保存的加密 URL。
