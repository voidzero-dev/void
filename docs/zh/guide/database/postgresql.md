---
outline: deep
---

# PostgreSQL {#postgresql}

通过 [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) 连接自己的 PostgreSQL 数据库，再沿用与 D1 相同的 Drizzle schema 定义和查询流程。

## 什么是 Hyperdrive？ {#what-is-hyperdrive}

Hyperdrive 在 Worker 和 PostgreSQL 之间提供连接池。请求会复用已有连接，无需每次都新建 TCP 和 TLS 连接。

Void 可以根据连接串创建 Hyperdrive 配置。直接部署到 Cloudflare 时，首次创建资源还需要 API 令牌；请参阅 [Cloudflare 指南](/integrations/cloudflare#databases-and-secrets)。

## 配置 {#configuration}

### 1. 设置数据库 {#_1-set-the-database}

在 `void.config.ts` 中添加：

```json
{
  "database": "pg"
}
```

### 2. 添加连接串 {#_2-add-your-connection-string}

本地开发时，将 `DATABASE_URL` 添加到 `.env`：

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/mydb?sslmode=require
```

本地使用 Vite 开发时，会通过该地址直接连接 Postgres 数据库。

### 3. 部署 {#_3-deploy}

部署到 Void 平台时，命令会在需要时提示输入连接串，也可以通过 `void db set-url` 设置。直接部署到 Cloudflare 时，请在 Shell 中导出生产环境的 `DATABASE_URL`。

Void 会创建 Hyperdrive，但不会将连接串保存在项目配置中。支持 `postgres://` 和 `postgresql://` 两种 URL，也支持提供商使用的查询参数，例如 `?sslmode=require`。

Void 创建的 Hyperdrive 会使用 Cloudflare 默认的 `require` 模式建立 TLS 连接。Hyperdrive 不会采用连接串中的 `sslmode=verify-ca`、`sslmode=verify-full` 或 `sslrootcert` 设置。如果直接部署到 Cloudflare，并希望 Hyperdrive 根据指定的证书颁发机构验证数据库，请[在 Cloudflare 中使用该证书创建 Hyperdrive](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)，再将其 ID 添加到 [`cloudflare.hyperdrive`](/integrations/cloudflare#databases-and-secrets)。

## 定义 schema {#schema-definition}

从 `void/schema-pg` 导入 schema 辅助函数：

```ts
// db/schema.ts
import { pgTable, serial, text, timestamp, boolean } from 'void/schema-pg';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('user'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

`database` 设为 `"pg"` 时，`void gen model` 会生成适用于 PostgreSQL 的代码。

## 迁移 {#migrations}

迁移流程与 D1 相同：

```bash
# Generate migration files from schema changes
void db generate

# Apply pending migrations locally
void db migrate

# Check migration status
void db status
```

主要区别在于 PostgreSQL 支持**事务性 DDL**。每次迁移都包裹在 `BEGIN` 和 `COMMIT` 之间，因此失败时会回滚整次迁移，不会让数据库停留在只更新了一部分的状态。

`void deploy` 会在新版本上线前执行待处理的迁移。请参阅[部署](/zh/guide/deployment)。

## 更新连接串 {#updating-the-connection-string}

如果需要更新已关联 Void 项目的连接，例如将数据库迁移到另一台主机后，请运行：

```bash
void db set-url
```

该命令会提示输入新的连接串，并更新 Hyperdrive 配置。
