---
outline: deep
---

<script setup>
const dbFileItems = [
  {
    name: "db/",
    children: [
      { name: "schema.ts", description: "表定义（唯一依据）" },
      {
        name: "schema/",
        description: "拆分后的 schema 文件（可选）",
        children: [
          { name: "users.ts" },
          { name: "posts.ts" },
        ],
      },
      {
        name: "migrations/",
        description: "生成的 SQL 迁移文件",
        children: [
          { name: "20260410161500_create_users.sql" },
          { name: "20260410161501_add_posts.sql" },
        ],
      },
      { name: "seed.ts", description: "用于填充初始数据的脚本（可选）" },
      { name: "seed.sql", description: "用于填充初始数据的 SQL 文件（可选替代方案）" },
    ],
  },
]
</script>

# 数据库 {#database}

用 TypeScript 定义表，再通过 `void/db` 导出的 `db` 查询。Void 内置 [Drizzle ORM](https://orm.drizzle.team) 并负责配置连接，因此使用 D1、PostgreSQL 或 MySQL 时，都可以沿用相同的 schema 定义和查询流程。

<FileTree :items="dbFileItems" default-expanded />

## 选择数据库方言 {#choosing-a-dialect}

在 `void init` 过程中选择数据库，或在 `void.config.ts` 中设置 `database`：

| | [D1 (SQLite)](/zh/guide/database/d1) | [PostgreSQL](/zh/guide/database/postgresql) | [MySQL](/zh/guide/database/mysql) |
| ---------- | ---------------------------- | ----------------------------------- | ------------------------- |
| 配置 | 默认 | `"database": "pg"` | `"database": "mysql"` |
| 管理方式 | 由 Void 管理 | 自备数据库 | 自备数据库 |
| 连接方式 | 自动绑定 D1 | Hyperdrive | Hyperdrive |

Void 平台会关闭数据库连接的 Hyperdrive 查询缓存，使读取能够反映已完成的写入。已有连接会在项目下次部署时更新。

## 定义 schema {#schema-definition}

使用 `void/schema-d1`、`void/schema-pg` 或 `void/schema-mysql` 提供的列辅助函数，在 `db/schema.ts` 中定义表。

::: code-group

```ts [SQLite (D1)]
import { sql } from 'void/db';
// db/schema.ts
import { sqliteTable, text, integer } from 'void/schema-d1';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('user'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

```ts [PostgreSQL]
// db/schema.ts
import { pgTable, serial, text, timestamp } from 'void/schema-pg';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

```ts [MySQL]
// db/schema.ts
import { int, mysqlTable, text, timestamp } from 'void/schema-mysql';

export const users = mysqlTable('users', {
  id: int('id').autoincrement().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
```

:::

schema 辅助函数已包含在 `void` 中。你可以手动编写表定义，也可以通过 `void gen model` 生成初始代码。

还可以将 schema 拆分到 `db/schema/` 下的多个文件，再通过统一的入口文件重新导出：

```ts
// db/schema/users.ts
export const users = ...;

// db/schema/posts.ts
export const posts = ...;

// db/schema.ts (barrel)
export * from "./schema/users";
export * from "./schema/posts";
```

### 列名格式 {#column-casing}

默认情况下，未显式指定名称的列（例如 `createdAt: timestamp()`）使用对象键作为列名。将 `database.casing` 设为 `'snake_case'`，即可将这些列存储为 `created_at`。此设置同时作用于 `void/db` 查询，以及 `void db` 的 `generate`、`push`、`seed` 等命令。对于已显式命名的列，例如 `text('created_at')`，其名称保持不变。

```ts
// void.config.ts
import { defineConfig } from 'void/config';

export default defineConfig({
  database: { dialect: 'pg', casing: 'snake_case' },
});
```

```ts
// db/schema.ts
import { pgTable, serial, text, timestamp } from 'void/schema-pg';

export const posts = pgTable('posts', {
  id: serial().primaryKey(),
  title: text().notNull(),
  createdAt: timestamp().notNull().defaultNow(), // created_at
});
```

使用 D1 时可以省略 `dialect`。如果数据库中已经有表，在修改 `casing` 后运行 `void db generate`，并在应用迁移前审查生成的内容。

## 查询 {#querying}

Void 从 `void/db` 重新导出了常用的 [Drizzle 查询运算符](https://orm.drizzle.team/docs/select)，无需单独安装 `drizzle-orm`。从 `void/db` 导入 `db`，并从 `@schema` 导入表定义：

```ts
import { users } from '@schema';
import { db } from 'void/db';
```

::: info 什么是 `@schema`？
`@schema` 是 Void 插件自动配置的 Vite 路径别名，指向 `db/schema.ts` 文件。如果将表定义拆分到了多个文件，则指向 `db/schema/`。可以直接通过此别名导入表定义。
:::

本页中返回插入或更新后完整数据行的示例适用于 D1 和 PostgreSQL。使用 MySQL 时，如需取得完整数据行，请在写入后另行查询。

### 列出数据行 {#list-rows}

```ts
const allUsers = await db.select().from(users);
```

### 使用 `where` 筛选 {#filter-with-where}

```ts
import { users } from '@schema';
import { db, eq, and, or } from 'void/db';

// Single condition
const user = await db.select().from(users).where(eq(users.id, 1));

// Multiple conditions
const admins = await db
  .select()
  .from(users)
  .where(and(eq(users.role, 'admin'), eq(users.name, 'Alice')));

// OR conditions
const result = await db
  .select()
  .from(users)
  .where(or(eq(users.role, 'admin'), eq(users.role, 'editor')));
```

### 插入 {#insert}

```ts
// Single row
await db.insert(users).values({
  name: 'Alice',
  email: 'alice@example.com',
});

// Insert and return the created row
const [created] = await db
  .insert(users)
  .values({ name: 'Bob', email: 'bob@example.com' })
  .returning();

// Multiple rows
await db.insert(users).values([
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
]);
```

### 更新 {#update}

```ts
await db.update(users).set({ role: 'admin' }).where(eq(users.id, 1));

// Update and return the modified row
const [updated] = await db.update(users).set({ role: 'admin' }).where(eq(users.id, 1)).returning();
```

### 删除 {#delete}

```ts
await db.delete(users).where(eq(users.id, 1));
```

### 选择列 {#column-selection}

```ts
const names = await db.select({ name: users.name, email: users.email }).from(users);
// names: { name: string; email: string }[]
```

### 排序与分页 {#ordering-and-pagination}

```ts
import { users } from '@schema';
import { db, desc } from 'void/db';

const page = await db.select().from(users).orderBy(desc(users.createdAt)).limit(10).offset(20);
```

### 联接 {#joins}

```ts
import { users, posts } from '@schema';
import { db, eq } from 'void/db';

const results = await db
  .select({
    id: posts.id,
    title: posts.title,
    author: users.name,
  })
  .from(posts)
  .innerJoin(users, eq(posts.userId, users.id));
```

### 关系查询 {#relational-queries}

如果在 schema 中定义了[关系](https://orm.drizzle.team/docs/relations)，就可以使用 Drizzle 的关系查询 API：

```ts
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

## 填充初始数据 {#seeding}

使用 `void db seed` 重置本地数据库、重新应用迁移，再运行种子文件填充初始数据。

通过代码填充数据时使用 `db/seed.ts`，使用 SQL 时则使用 `db/seed.sql`。也支持 JavaScript 和 `.mts` / `.mjs` 文件。如果存在多个种子文件，可通过 `--file <path>` 指定。

### 通过代码填充数据 {#programmatic-seeding}

如果需要在代码中生成初始数据，使用 `db/seed.ts`，并导出默认函数或名为 `seed` 的函数。

```ts
// db/seed.ts
import { defineSeed } from 'void/seed';

export default defineSeed<typeof import('./schema')>(async ({ db, schema }) => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    text: `Seed message ${i + 1}`,
  }));

  await db.insert(schema.messages).values(rows);
});
```

种子函数的上下文包含：

- `dialect`：`"sqlite"`、`"postgresql"` 或 `"mysql"`
- `db`：连接本地数据库的 Drizzle 实例
- `schema`：`db/schema.ts` 或 `db/schema/` 模块的导出

### 通过 SQL 填充数据 {#sql-seeding}

如果更习惯原生 SQL，可以继续使用 `db/seed.sql`：

```sql
INSERT INTO messages (text) VALUES ('Hello from SQL');
```

## 从 schema 派生校验器 {#schema-derived-validators}

使用 `void/drizzle-zod`、`void/drizzle-valibot` 或 `void/drizzle-arktype`，从表定义派生请求校验器。将校验器写在表定义之后：

::: code-group

```ts [Zod]
// db/schema.ts
import { createInsertSchema } from 'void/drizzle-zod';

export const insertUserSchema = createInsertSchema(users, {
  name: (schema) => schema.min(1),
  email: (schema) => schema.email(),
});
```

```ts [Valibot]
import { pipe, minLength, email } from 'valibot';
// db/schema.ts
import { createInsertSchema } from 'void/drizzle-valibot';

export const insertUserSchema = createInsertSchema(users, {
  name: (schema) => pipe(schema, minLength(1)),
  email: (schema) => pipe(schema, email()),
});
```

```ts [ArkType]
import { type } from 'arktype';
// db/schema.ts
import { createInsertSchema } from 'void/drizzle-arktype';

export const insertUserSchema = createInsertSchema(users, {
  name: type('string > 0'),
  email: type('string.email'),
});
```

:::

`createInsertSchema` 会生成与 `$inferInsert` 匹配的校验器。有默认值或自增的列可以省略，其余 `NOT NULL` 列仍为必填字段。可选的第二个参数用于进一步约束各列：既可以传入回调，在回调中接收生成的 schema，也可以直接传入类型来覆盖字段。

在路由处理器中，通过 [`withValidator()`](/zh/guide/server-routing#validation) 使用派生的 schema：

```ts
import { users, insertUserSchema } from '@schema';
// routes/api/users/index.ts
import { defineHandler } from 'void';
import { db } from 'void/db';

export const POST = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  const [created] = await db.insert(users).values(body).returning();
  return created;
});
```

共有三个可用函数：

| 函数 | 用途 |
| -------------------- | ----------------------------------------------------------------------------- |
| `createInsertSchema` | 校验插入数据，排除始终自动生成的列，并允许省略有默认值的列 |
| `createSelectSchema` | 匹配查询结果行的结构 |
| `createUpdateSchema` | 与插入校验类似，但所有字段均为可选（局部更新） |

Void 已内置 Drizzle 适配器。如果在 schema 文件中直接使用验证库的 API，则需要安装对应的验证库：

```bash
npm install zod
# or
npm install valibot
# or
npm install arktype
```

## CLI 命令 {#cli-commands}

| 命令 | 用途 |
| ------------------ | ---------------------------------------------------- |
| `void db push` | 在本地应用 schema 变更，不生成迁移文件 |
| `void db generate` | 生成 SQL 迁移 |
| `void db migrate` | 在本地应用待执行的迁移 |
| `void db status` | 检查 schema 差异和待执行的迁移 |
| `void db seed` | 重置本地数据库并运行种子文件 |

连接配置、SQL 执行、Studio、导出及其他命令请参阅 [CLI 参考](/zh/reference/cli/database#database)。

## 手写迁移 {#hand-written-migrations}

部署时会比较 Drizzle schema 与 `db/migrations/meta/` 中的快照。如果已有 SQL 迁移却缺少这些元数据，运行 `void db generate` 会为相同的表再次生成迁移。

若要保留已有迁移历史：

1. 使 Drizzle schema 与现有 SQL 迁移创建的表一致。
2. 在项目的临时副本中删除 `db/migrations/`，然后运行 `void db generate`。
3. 将生成的 `meta/` 文件夹复制到原迁移目录。在 `_journal.json` 中，将 `entries` 替换为与已有 SQL 文件一一对应且顺序一致的条目。`idx` 使用从 `0` 开始的连续值，`tag` 使用去掉 `.sql` 后缀的文件名，`when` 使用递增的时间戳，`version` 使用生成条目的版本值。根据文件是否使用 `--> statement-breakpoint` 行来设置 `breakpoints`。
4. 将生成的快照重命名为 `<prefix>_snapshot.json`，其中 `<prefix>` 是最后一个迁移标签中第一个 `_` 之前的部分。例如，`001_create_users.sql` 对应 `001_snapshot.json`。

审查并提交这些元数据，然后再次运行 `void deploy`。如果还没有数据库应用过这些 SQL，也可以直接用 `void db generate` 生成的迁移替换它们。

对于包含触发器的 D1 迁移，以及包含触发器、存储过程、函数或事件的 MySQL 迁移，应在每条完整 SQL 语句后添加一行 `--> statement-breakpoint`，触发器结束的 `END;` 后也需要添加。不要拆开触发器体。

## 生成代码 {#scaffolding}

`void gen model` 命令会根据数据库方言生成相应的 `sqliteTable`、`pgTable` 或 `mysqlTable` 定义。

```bash
void gen model posts title:string body:text published:boolean
```

该命令会生成或更新以下内容：

1. `db/schema/posts.ts`：包含 `id`、`createdAt`、`updatedAt` 和指定列的 Drizzle 表定义
2. 更新 `db/schema.ts`，添加 `export * from "./schema/posts"`
3. `routes/api/posts/index.ts`：用于列出数据的 `GET` 和带校验的插入操作 `POST`
4. `routes/api/posts/[id].ts`：按 id 查询的 `GET`，包含 `404` 处理

完整的生成器列表请参阅 [CLI 参考](/zh/reference/cli/generate#code-generation)。
