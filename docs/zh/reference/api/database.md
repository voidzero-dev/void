---
outline: deep
---

# 数据库与初始数据填充 {#database}

从 `"void/db"` 导入。`db` 是与所配置数据库方言对应的 [Drizzle ORM](https://orm.drizzle.team) 实例：默认使用 [Cloudflare D1](https://developers.cloudflare.com/d1/)，配置 `"database": "pg"` 时使用 PostgreSQL，配置 `"database": "mysql"` 时使用 MySQL。

## `db` {#db}

默认的 Drizzle 实例，已关联 `db/schema.ts` 中的 schema。

以下为 D1 的查询示例：

```ts
import { users } from '@schema';
import { db } from 'void/db';

const allUsers = await db.select().from(users).all();
```

`db` 使用已配置的数据库方言和 schema。

- D1 项目会解析 `DB` 绑定，并提供 `DrizzleD1Database<Schema>`。
- PostgreSQL 项目在本地开发时使用 `DATABASE_URL`，生产环境中使用 Hyperdrive 的 `connectionString`，并提供 `NodePgDatabase<Schema>`。
- MySQL 项目使用相同的连接来源，并提供 `MySql2Database<Schema>`。

## `createDb(database)` {#createdb-database}

为当前启用的数据库方言创建 Drizzle 实例。

D1 项目需要传入具体的 D1 绑定。存在多个 D1 数据库，或需要使用非默认绑定时，可以使用此方法。

```ts
import { env } from 'cloudflare:workers';
import { createDb } from 'void/db';

const db = createDb(env.MY_OTHER_DB);
```

PostgreSQL 和 MySQL 项目需要传入连接字符串。

```ts
import { createDb } from 'void/db';

const db = createDb('postgres://user:password@host:5432/app');
```

**签名：**

```ts
// D1
function createDb(d1: D1Database): DrizzleD1Database<Schema>;

// PostgreSQL
function createDb(connectionString: string): NodePgDatabase<Schema>;

// MySQL
function createDb(connectionString: string): MySql2Database<Schema>;
```

## 查询运算符 {#query-operators}

`void/db` 重新导出常用的 [Drizzle 运算符](https://orm.drizzle.team/docs/operators)，无需直接依赖 `drizzle-orm`：

```ts
import { db, eq, and, or, desc, like, inArray, sql } from 'void/db';
```

**完整列表：** `sql`、`eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`and`、`or`、`not`、`desc`、`asc`、`like`、`ilike`、`notLike`、`inArray`、`notInArray`、`isNull`、`isNotNull`、`between`、`notBetween`、`exists`、`notExists`、`count`、`sum`、`avg`、`min`、`max`。

## 填充初始数据 {#seeding}

从 `"void/seed"` 导入。

### `defineSeed(fn)` {#defineseed-fn}

为 `void db seed` 使用的编程式种子模块提供类型提示，并原样返回传入的函数。

```ts
import { defineSeed } from 'void/seed';

export default defineSeed<typeof import('./schema')>(async ({ db, schema }) => {
  await db.insert(schema.users).values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ]);
});
```

回调会收到：

- `dialect`：`"sqlite"`、`"postgresql"` 或 `"mysql"`
- `db`：当前数据库方言对应的本地 Drizzle 实例
- `schema`：`db/schema.ts` 或 `db/schema/` 中的导出

种子模块可以导出 `default`，也可以导出名为 `seed` 的函数。
