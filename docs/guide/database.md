---
outline: deep
---

<script setup>
const dbFileItems = [
  {
    name: "db/",
    children: [
      { name: "schema.ts", description: "Table definitions (source of truth)" },
      {
        name: "schema/",
        description: "Split schema files (optional)",
        children: [
          { name: "users.ts" },
          { name: "posts.ts" },
        ],
      },
      {
        name: "migrations/",
        description: "Generated SQL migration files",
        children: [
          { name: "20260410161500_create_users.sql" },
          { name: "20260410161501_add_posts.sql" },
        ],
      },
      { name: "seed.ts", description: "Programmatic seed script (optional)" },
      { name: "seed.sql", description: "Raw SQL seed file (optional alternative)" },
    ],
  },
]
</script>

# Database

Define your tables in TypeScript, then query them with `db` from `void/db`. Void includes [Drizzle ORM](https://orm.drizzle.team) and configures the connection, so you can use the same schema and query workflow with D1, PostgreSQL, or MySQL.

<FileTree :items="dbFileItems" default-expanded />

## Choosing a Dialect

Choose a database during `void init`, or set `database` in `void.config.ts`:

|            | [D1 (SQLite)](./database/d1) | [PostgreSQL](./database/postgresql) | [MySQL](./database/mysql) |
| ---------- | ---------------------------- | ----------------------------------- | ------------------------- |
| Config     | Default                      | `"database": "pg"`                  | `"database": "mysql"`     |
| Managed by | Void                         | Bring your own database             | Bring your own database   |
| Connection | Automatic D1 binding         | Hyperdrive                          | Hyperdrive                |

A Void platform keeps Hyperdrive query caching off for your database connection, so reads reflect completed writes. An existing connection is updated on the project's next deploy.

## Schema Definition

Define your tables in `db/schema.ts` using column helpers from `void/schema-d1`, `void/schema-pg`, or `void/schema-mysql`.

::: code-group

```ts [SQLite (D1)]
// db/schema.ts
import { sql } from 'void/db';
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

The schema helpers are included in `void`. You can write tables yourself or generate a starting point with `void gen model`.

You can also split your schema across multiple files under `db/schema/` and re-export from a barrel file:

```ts
// db/schema/users.ts
export const users = ...;

// db/schema/posts.ts
export const posts = ...;

// db/schema.ts (barrel)
export * from "./schema/users";
export * from "./schema/posts";
```

### Column casing

By default, a column declared without a name, such as `createdAt: timestamp()`, uses its key as the column name. Set `database.casing` to `'snake_case'` to store these columns as `created_at` instead. It applies to `void/db` queries and to `void db` commands such as `generate`, `push`, and `seed`. Columns with an explicit name, such as `text('created_at')`, keep that name.

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

Omit `dialect` for D1. If your database already has tables, run `void db generate` after you change `casing` and review the migration before you apply it.

## Querying

Void re-exports all common [Drizzle query operators](https://orm.drizzle.team/docs/select) from `void/db` so you don't need to install `drizzle-orm` separately. Import `db` from `void/db` and your tables from `@schema`:

```ts
import { users } from '@schema';
import { db } from 'void/db';
```

::: info What is `@schema`?
`@schema` is a Vite path alias that the Void plugin configures automatically. It points to your `db/schema.ts` file, or `db/schema/` if you split tables across files. You can just use it to import table definitions.
:::

### List rows

```ts
const allUsers = await db.select().from(users);
```

### Filter with `where`

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

### Insert

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

### Update

```ts
await db.update(users).set({ role: 'admin' }).where(eq(users.id, 1));

// Update and return the modified row
const [updated] = await db.update(users).set({ role: 'admin' }).where(eq(users.id, 1)).returning();
```

### Delete

```ts
await db.delete(users).where(eq(users.id, 1));
```

### Column selection

```ts
const names = await db.select({ name: users.name, email: users.email }).from(users);
// names: { name: string; email: string }[]
```

### Ordering and pagination

```ts
import { users } from '@schema';
import { db, desc } from 'void/db';

const page = await db.select().from(users).orderBy(desc(users.createdAt)).limit(10).offset(20);
```

### Joins

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

### Relational queries

If your schema defines [relations](https://orm.drizzle.team/docs/relations), you can use Drizzle's relational query API:

```ts
const usersWithPosts = await db.query.users.findMany({
  with: { posts: true },
});
```

## Seeding

Use `void db seed` to reset your local database, re-apply migrations, and then run a seed file.

Use `db/seed.ts` for a programmatic seed or `db/seed.sql` for SQL. JavaScript and `.mts` / `.mjs` files also work. If more than one seed file exists, choose one with `--file <path>`.

### Programmatic seeding

Use `db/seed.ts` when you want to generate seed data in code. Export a default function or a named `seed` function.

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

The seed context includes:

- `dialect`: `"sqlite"`, `"postgresql"`, or `"mysql"`
- `db`: a Drizzle instance for the local database
- `schema`: the exports from your `db/schema.ts` or `db/schema/` modules

### SQL seeding

If you prefer raw SQL, keep using `db/seed.sql`:

```sql
INSERT INTO messages (text) VALUES ('Hello from SQL');
```

## Schema-Derived Validators

Derive request validators from your tables with `void/drizzle-zod`, `void/drizzle-valibot`, or `void/drizzle-arktype`. Add the validator after your table definition:

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
// db/schema.ts
import { pipe, minLength, email } from 'valibot';
import { createInsertSchema } from 'void/drizzle-valibot';

export const insertUserSchema = createInsertSchema(users, {
  name: (schema) => pipe(schema, minLength(1)),
  email: (schema) => pipe(schema, email()),
});
```

```ts [ArkType]
// db/schema.ts
import { type } from 'arktype';
import { createInsertSchema } from 'void/drizzle-arktype';

export const insertUserSchema = createInsertSchema(users, {
  name: type('string > 0'),
  email: type('string.email'),
});
```

:::

`createInsertSchema` generates a validator that matches `$inferInsert`. Columns with defaults or auto-increments become optional, while `NOT NULL` columns stay required. The optional second argument lets you refine individual columns, either with a callback that receives the generated schema or by passing a type directly to override a field.

Use the derived schema in your route handlers with [`withValidator()`](./server-routing.md#validation):

```ts
// routes/api/users/index.ts
import { users, insertUserSchema } from '@schema';
import { defineHandler } from 'void';
import { db } from 'void/db';

export const POST = defineHandler.withValidator({
  body: insertUserSchema,
})(async (c, { body }) => {
  const [created] = await db.insert(users).values(body).returning();
  return created;
});
```

Three functions are available:

| Function             | Purpose                                                                       |
| -------------------- | ----------------------------------------------------------------------------- |
| `createInsertSchema` | Validates insert data, excluding auto-generated columns and applying defaults |
| `createSelectSchema` | Matches the shape of selected rows                                            |
| `createUpdateSchema` | Like insert but all fields are optional (partial update)                      |

Void already bundles the Drizzle adapters. Install the validator library itself if you use its direct APIs in your schema file:

```bash
npm install zod
# or
npm install valibot
# or
npm install arktype
```

## CLI Commands

| Command            | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `void db push`     | Apply schema changes locally without migration files |
| `void db generate` | Generate SQL migrations                              |
| `void db migrate`  | Apply pending migrations locally                     |
| `void db status`   | Check schema drift and pending migrations            |
| `void db seed`     | Reset the local database and run a seed file         |

See the [CLI reference](../reference/cli/database.md#database) for connection setup, SQL execution, Studio, exports, and other commands.

## Hand-written migrations {#hand-written-migrations}

Deploy compares your Drizzle schema with the snapshots in `db/migrations/meta/`. If you have SQL migrations without this metadata, running `void db generate` would create another migration for the same tables.

To keep an existing migration history:

1. Make your Drizzle schema match the tables your SQL migrations create.
2. In a scratch copy of the project, remove `db/migrations/` and run `void db generate`.
3. Copy the generated `meta/` folder into your original migration directory. In `_journal.json`, replace `entries` with an entry for each existing SQL file in order. Use consecutive `idx` values starting at `0`, the file name without `.sql` as `tag`, increasing timestamps as `when`, and the generated entry's `version`. Set `breakpoints` to whether the file uses `--> statement-breakpoint` lines.
4. Rename the generated snapshot to `<prefix>_snapshot.json`, where `<prefix>` is the part of the last migration tag before its first `_`. For `001_create_users.sql`, use `001_snapshot.json`.

Review and commit the metadata, then run `void deploy` again. If no database has applied the SQL yet, you can instead replace it with migrations from `void db generate`.

For D1 migrations containing triggers, and MySQL migrations containing triggers, procedures, functions or events, add a `--> statement-breakpoint` line after each complete SQL statement, including the trigger's closing `END;`. Keep the trigger body together.

## Scaffolding

The `void gen model` command generates dialect-appropriate `sqliteTable`, `pgTable`, or `mysqlTable` definitions.

```bash
void gen model posts title:string body:text published:boolean
```

This creates:

1. `db/schema/posts.ts`: a Drizzle table definition with `id`, `createdAt`, `updatedAt`, and your columns
2. Updates `db/schema.ts` with `export * from "./schema/posts"`
3. `routes/api/posts/index.ts`: `GET` for list and `POST` for insert with validation
4. `routes/api/posts/[id].ts`: `GET` by id with `404` handling

See the [CLI reference](../reference/cli/generate.md#code-generation) for the full list of generators.
