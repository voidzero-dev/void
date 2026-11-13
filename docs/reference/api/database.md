---
description: 'Query D1, PostgreSQL, or MySQL with the Drizzle client from void/db, and seed data from a script.'
outline: deep
---

# Database and Seeding {#database}

Imported from `"void/db"`. The `db` export is a [Drizzle ORM](https://orm.drizzle.team) instance for the configured database dialect: [Cloudflare D1](https://developers.cloudflare.com/d1/) by default, PostgreSQL with `"database": "pg"`, or MySQL with `"database": "mysql"`.

## `db` {#db}

Default Drizzle instance, pre-wired with your schema from `db/schema.ts`.

```ts
import { users } from '@schema';
import { db } from 'void/db';

const allUsers = await db.select().from(users).all();
```

`db` uses your configured dialect and schema.

- D1 projects resolve the `DB` binding and expose `DrizzleD1Database<Schema>`.
- PostgreSQL projects use `DATABASE_URL` during local development and Hyperdrive's `connectionString` in production, exposing `NodePgDatabase<Schema>`.
- MySQL projects use the same connection sources and expose `MySql2Database<Schema>`.

## `createDb(database)` {#createdb-database}

Creates a Drizzle instance for the active dialect.

For D1 projects, pass a specific D1 binding. Use this when you have multiple D1 databases or need a non-default binding.

```ts
import { env } from 'cloudflare:workers';
import { createDb } from 'void/db';

const db = createDb(env.MY_OTHER_DB);
```

Pass `{ session: 'first-primary' }` to start the D1 session with a query on the primary, keeping your app's schema and query types. Create this client inside the request that needs a fresh read. The default is `'first-unconstrained'`, which allows the first query to use a replica. See [read replication](../../guide/database/d1.md#read-replication).

The `session` option also accepts a D1 bookmark from a previous request. Use `getBookmark(client)` after queries to obtain the bookmark to return to your client.

For PostgreSQL and MySQL projects, pass a connection string.

```ts
import { createDb } from 'void/db';

const db = createDb('postgres://user:password@host:5432/app');
```

**Signature:**

```ts
// D1
function createDb(
  d1: D1Database,
  options?: { session?: D1SessionConstraint | D1SessionBookmark },
): DrizzleD1Database<Schema>;

// PostgreSQL
function createDb(connectionString: string): NodePgDatabase<Schema>;

// MySQL
function createDb(connectionString: string): MySql2Database<Schema>;
```

## `setSession(start)` {#setsession}

D1 only. Set the starting bookmark or constraint for the default request's `db`. Call it in middleware before the first use of `db`; calling it after that throws. It does not change explicitly created clients or later requests.

```ts
function setSession(start: D1SessionConstraint | D1SessionBookmark): void;
```

## `getBookmark(client?)` {#getbookmark}

D1 only. Return the default request session's bookmark, or pass a client returned by `createDb()` to read that client's bookmark. Returns `null` when no bookmark is available. Reading the default bookmark does not open a database session.

```ts
function getBookmark(client?: DrizzleD1Database<Schema>): D1SessionBookmark | null;
```

`setSession()` and the no-argument `getBookmark()` require Void's request scope. For framework handlers outside that scope, use `createDb(binding, { session: bookmark })` and `getBookmark(client)` instead. See [carrying bookmarks between requests](../../guide/database/d1.md#cross-request-bookmarks) for middleware examples.

## Query Operators {#query-operators}

`void/db` re-exports commonly used [Drizzle operators](https://orm.drizzle.team/docs/operators) so you never need to depend on `drizzle-orm` directly:

```ts
import { db, eq, and, or, desc, like, inArray, sql } from 'void/db';
```

**Full list:** `sql`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `desc`, `asc`, `like`, `ilike`, `notLike`, `inArray`, `notInArray`, `isNull`, `isNotNull`, `between`, `notBetween`, `exists`, `notExists`, `count`, `sum`, `avg`, `min`, `max`.

## Seeding {#seeding}

Imported from `"void/seed"`.

### `defineSeed(fn)` {#defineseed-fn}

Identity helper for programmatic seed modules used by `void db seed`.

```ts
import { defineSeed } from 'void/seed';

export default defineSeed<typeof import('./schema')>(async ({ db, schema }) => {
  await db.insert(schema.users).values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ]);
});
```

The callback receives:

- `dialect`: `"sqlite"`, `"postgresql"`, or `"mysql"`
- `db`: a local Drizzle instance for the active dialect
- `schema`: the exports from `db/schema.ts` or `db/schema/`

Seed modules can export either `default` or a named `seed` function.
