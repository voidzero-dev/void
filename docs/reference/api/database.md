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

For a fresh D1 read, pass `{ session: 'first-primary' }` and create the client inside the request. The default, `'first-unconstrained'`, allows the first query to use a replica. Both keep your schema and query types. See [Avoid stale reads with a primary-first session](../../guide/database/d1.md#reading-from-the-primary).

The `session` option also accepts `{ bookmark }` to resume from a D1 bookmark from a previous request. Use `getBookmark(client)` after queries to obtain the bookmark string to return to your client. See [Using `createDb`](../../guide/database/d1.md#using-createdb) for an example.

For PostgreSQL and MySQL projects, pass a connection string.

```ts
import { createDb } from 'void/db';

const db = createDb('postgres://user:password@host:5432/app');
```

**Signature:**

```ts
// D1
type DbSessionStart = 'first-primary' | 'first-unconstrained' | { bookmark: string };

function createDb(
  d1: D1Database,
  options?: { session?: DbSessionStart },
): DrizzleD1Database<Schema>;

// PostgreSQL
function createDb(connectionString: string): NodePgDatabase<Schema>;

// MySQL
function createDb(connectionString: string): MySql2Database<Schema>;
```

## `setSession(start)` {#setsession}

D1 only. Set the starting bookmark or constraint for the default request's `db`. Call it in middleware before the first use of `db`. It does not change explicitly created clients or later requests.

Pass `'first-primary'`, `'first-unconstrained'`, or `{ bookmark: string }`. Wrap bookmark strings in an object, including strings returned by `getBookmark()`. If no incoming bookmark is available, pass `'first-unconstrained'`.

Use bookmarks only with the database that issued them. Keep client-side storage database-specific and clear saved bookmarks when switching databases; clearing them starts a new consistency chain.

The session opens when you read a database property, including extracting a method or accessing `$client`; it does not wait for a query to execute. Awaiting or inspecting the `db` object does not open it.

Passing `'first-unconstrained'` preserves any bookmark or primary-first requirement already configured, even before the first use of `db`. Other starting values replace the configuration until the session opens.

After the session opens, repeated calls preserve it when the requirement is already satisfied: the original starting value, `'first-unconstrained'`, or a bookmark no newer than the session's current bookmark. This lets middleware run again during a local server-side fetch without resetting database progress. Repeating `'first-primary'` does not force another primary read.

A newer bookmark or changing an opened session to `'first-primary'` throws. Configure these before using `db`, or use `createDb(binding, { session })` for an independent session.

```ts
function setSession(start: DbSessionStart): void;
```

## `getBookmark(client?)` {#getbookmark}

D1 only. Return the default request session's bookmark, or pass a client returned by `createDb()` to read that client's bookmark. Returns `null` when no bookmark is available. Reading the default bookmark does not open a database session.

Await consistency-critical database work before capturing the bookmark you send to the client. Deferred or background queries that finish after capture are not guaranteed to be reflected in that bookmark.

```ts
function getBookmark<TSchema extends Record<string, unknown>>(
  client?: DrizzleD1Database<TSchema>,
): D1SessionBookmark | null;
```

`setSession()` and the no-argument `getBookmark()` require Void's request scope. For a framework-owned endpoint, such as an Astro API route, use an [explicit client](../../guide/database/d1.md#using-createdb) instead.

For cookie and header middleware, a browser fetch wrapper, and guidance on combining both transports, see [See your writes in subsequent requests](../../guide/database/d1.md#cross-request-bookmarks).

## Query Operators {#query-operators}

`void/db` re-exports commonly used [Drizzle operators](https://orm.drizzle.team/docs/operators) so you never need to depend on `drizzle-orm` directly:

```ts
import { db, eq, and, or, desc, like, inArray, sql } from 'void/db';
```

**Full list:** `sql`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `desc`, `asc`, `like`, `ilike`, `notLike`, `inArray`, `notInArray`, `isNull`, `isNotNull`, `between`, `notBetween`, `exists`, `notExists`, `count`, `sum`, `avg`, `min`, `max`.

Use the exported Drizzle types `SQL`, `SQLWrapper`, `AnyColumn`, and `BatchItem` to type query helpers and batches:

```ts
import { posts } from '@schema';
import { db, sql, type BatchItem, type SQL, type SQLWrapper } from 'void/db';

function contains(column: SQLWrapper, text: string): SQL {
  return sql`instr(${column}, ${text}) > 0`;
}

// D1 only: `db.batch()` takes at least one query.
const writes: [BatchItem<'sqlite'>, ...Array<BatchItem<'sqlite'>>] = [
  db.update(posts).set({ published: true }).where(contains(posts.title, 'void')),
];
await db.batch(writes);
```

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
