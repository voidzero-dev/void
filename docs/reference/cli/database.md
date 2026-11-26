---
description: 'Generate migrations, apply them, and update the local database from your Drizzle schema.'
outline: deep
---

# Database {#database}

## `void db push` {#void-db-push}

Apply your Drizzle schema directly to the development database without creating migration files. D1 updates the local database; PostgreSQL and MySQL use `DATABASE_URL` from `.env`.

Use this for quick schema iteration while prototyping. Before deploying, generate and review migration files with `void db generate`.

## `void db generate` {#void-db-generate}

Generate SQL migration files from schema changes.

Compares your schema with the last Drizzle snapshot and writes migrations under `db/migrations/`. It includes Void-managed auth tables and configured auth plugins, even without an application schema. Review and commit the generated files before deploying.

For SQLite, Void checks that the migration history applies to a fresh database. If generation fails this check, the previous SQL, snapshots, and journal are restored. If an existing migration fails, repair that unapplied migration first: rerunning generation compares snapshots and does not repair existing SQL. This check does not verify that a migration preserves existing data; review table rebuilds and foreign-key actions carefully.

## `void db status` {#void-db-status}

Show applied and pending migrations locally and on the saved deployment target. Direct Cloudflare PostgreSQL and MySQL projects use `DATABASE_URL` from the current shell for remote status.

## `void db reset` {#void-db-reset}

```
void db reset [--yes]
```

Reset the development database and re-apply all migrations. D1 resets local data. PostgreSQL clears tables, views, sequences, and custom types from the `public` schema while preserving extensions; dependencies from other schemas must be resolved first. MySQL drops all tables and views. PostgreSQL and MySQL use `DATABASE_URL` from `.env`.

When that `DATABASE_URL` points to a host other than `localhost`, Void names the database and asks before dropping its tables. Pass `--yes` to skip the prompt in scripts and CI; without a terminal, the command stops unless `--yes` is set. If `.env` uses the same URL as your deployment (for example after `void db connect`), reset drops the deployed tables.

## `void db seed` {#void-db-seed}

```
void db seed [--file <path>] [--yes]
```

Reset the local database, re-apply all migrations, then execute a seed file. The reset works like `void db reset`, including the prompt and `--yes`.

If `--file` is omitted, Void looks for default seed files in this order: `db/seed.ts`, `db/seed.mts`, `db/seed.js`, `db/seed.mjs`, `db/seed.sql`.

If more than one default seed file exists, the CLI stops and asks you to pass `--file <path>`.

Programmatic seed modules must export either a default function or a named `seed` function.

## `void db execute` {#void-db-execute}

```
void db execute <sql> [--json]
void db execute --file <path> [--json]
void db execute --remote <sql> [--yes] [--json]
void db execute --remote --file <path> [--yes] [--json]
```

Run ad-hoc SQL against the database. Provide SQL inline or from a file. A statement that returns rows prints them as a formatted table, and statements that change data print nothing. SQL with several statements runs as a script without printed results. Pass `--json` to get every statement's rows.

By default, targets the local database. Pass `--remote` to run against the deployed database selected in `.void/project.json`:

- **Void platform D1 projects**: routes the query through the selected platform's registered proxy using your auth token.
- **Direct Cloudflare D1 projects**: invokes Cloudflare against the pinned D1 binding from `void.config.ts` or `void.lock.json`.
- **Hosted PostgreSQL and MySQL projects**: fetches the stored connection string from the platform and connects directly.
- **Direct Cloudflare PostgreSQL and MySQL projects**: uses `DATABASE_URL` from the current shell; Cloudflare cannot return the password from Hyperdrive.

On direct Cloudflare D1 deployments, a `--file` larger than 100 KB runs as a D1 import: Void waits for it to finish, the database cannot serve queries until then, and query rows are not printed. Smaller files print rows like inline SQL.

For destructive statements (`DELETE`, `UPDATE`, `DROP`, etc.) when running in a TTY, you will be prompted to confirm before the query is sent to the deployed database. A TTY also asks before a D1 import, whatever the file contains. Pass `--yes` to skip the prompt. Non-TTY environments (CI) never prompt, so `--yes` is optional there.

### JSON output {#void-db-execute-json}

Pass `--json` to read results from a script. stdout receives only a JSON array with one entry per statement, including statements in SQL with several statements. Prompts, warnings, errors and any other output, such as messages that `void.config.ts` or a process it starts prints, go to stderr, and a failure exits with a non-zero status.

```sh
void db execute --json "select count(*) as total from users; select id from users limit 1"
```

```json
[
  {
    "results": [{ "total": 2 }],
    "success": true,
    "meta": { "changes": 0, "last_row_id": 0, "duration": 0.04 }
  },
  {
    "results": [{ "id": 1 }],
    "success": true,
    "meta": { "changes": 0, "last_row_id": 0, "duration": 0.02 }
  }
]
```

Each entry has the same shape as a D1 result and as an entry of `wrangler d1 execute --json`:

- `results`: the rows the statement returned, or `[]`. `NULL` prints as `null`, numbers and text keep their types, and binary values print as arrays of bytes. An integer outside ±9007199254740991, which a JSON number cannot hold exactly, prints as a string of its digits, and infinite or not-a-number values print as `"Infinity"`, `"-Infinity"` and `"NaN"`. PostgreSQL `bigint` and `numeric` values print as strings, in arrays too, and numbers in `json` and `jsonb` values keep the digits the database returned. MySQL dates and times print as the text MySQL returns, such as `"2024-01-02 03:04:05.123456"`. A remote D1 database returns values as D1's API reports them. A MySQL `CALL` is one entry, with the rows of every result set the procedure returns. So are an `EXECUTE` of a prepared `CALL`, and a compound statement that MariaDB runs outside a stored program, such as `BEGIN NOT ATOMIC ... END` or `IF ... END IF`.
- `success`: `true` for a statement that ran.
- `meta`: what the database reports about the statement. D1 databases report D1's metadata, such as `changes` and `last_row_id` (locally `changes`, `last_row_id` and `duration`). PostgreSQL reports `command` and `rowCount`, and MySQL reports `affectedRows` and `insertId` for a statement that changes data.

If a statement fails, stdout stays empty.

`--json` is not available for a direct Cloudflare D1 import of a file larger than 100 KB, which returns no rows. On a Void platform D1 database, `--remote --json` runs one statement per command; a `CREATE TRIGGER` counts as one statement. On MySQL, `--json` stops without running anything when it cannot tell which results belong to which statement:

- An `EXECUTE` runs a statement that the same SQL does not prepare from a quoted string, such as `PREPARE s FROM @sql`, and so may be a `CALL`. A procedure may prepare statements too, so after a `CALL`, prepare a statement again before you run it. Run SQL that prepares a statement from a variable without `--json`.
- A `SET sql_mode` sets anything other than a quoted list of modes, such as `SET sql_mode = @saved`, and a quoted string with a backslash after it reads as different statements in different modes, with a `CALL` or another statement that returns several results among them. Set `sql_mode` to a quoted list such as `'ANSI_QUOTES'`, or run that statement in a separate command.

## `void db migrate` {#void-db-migrate}

```
void db migrate [--remote]
```

Apply pending migrations to the local database without resetting. Unlike `void db reset`, this preserves existing data and only runs migrations that haven't been applied yet.

Pass `--remote` to apply pending migrations to the saved target. Hosted projects require a Void login and link. Direct Cloudflare D1 projects use the binding's configured migration directory, table, and pattern. The D1 binding must set `migrations_dir`. Direct PostgreSQL and MySQL projects use the shell `DATABASE_URL`.

## `void db studio` {#void-db-studio}

```
void db studio [--remote]
```

Open [Drizzle Studio](https://orm.drizzle.team/docs/drizzle-kit-studio) for the database. Launches a web-based GUI for browsing and editing your data.

By default, targets the local database. Pass `--remote` to open Studio against the deployed database:

- **Hosted PostgreSQL and MySQL projects**: fetch the stored connection string from the platform and open Studio against it. If the URL isn't stored yet, run `void db set-url` first.
- **Direct Cloudflare PostgreSQL and MySQL projects**: use `DATABASE_URL` from the current shell.
- **D1 projects**: use `void db execute --remote` to query the deployed database.

## `void db restore` {#void-db-restore}

```
void db restore --bookmark <bookmark> [--platform cloudflare] [--yes]
void db restore --timestamp <iso-time> [--platform cloudflare] [--yes]
```

Restore a directly deployed Cloudflare D1 database using [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Use the bookmark printed before deployment migrations, or an ISO 8601 timestamp with a timezone, such as `2026-10-16T09:30:00Z`.

Time Travel keeps 7 days of history on Workers Free and 30 days on Workers Paid. Reverse older migrations with a new migration.

Restoring discards every write made after the selected point. Void asks for confirmation and prints a command to undo the restore afterward. Pass `--yes` for scripts and CI.

To recover from a bad migration:

1. Roll back the code with [`void project rollback`](./project.md#void-project-rollback-deployid) if the live version needs the newer schema.
2. Restore the database using the printed bookmark.
3. Fix or remove the failed migration before deploying again. The restore also rewinds migration history, so the next deploy reapplies pending files.

For a one-off Cloudflare deployment, add `--platform cloudflare` to restore, rollback, and deploy commands.

## `void db rename-migrations` {#void-db-rename-migrations}

For linked Void platform projects, rename migrations from numeric prefixes (`0001_name.sql`) to timestamps (`20260410161500_name.sql`) and update local and remote migration records. Sign in and run `void project link` first.

For direct Cloudflare deployments, keep existing filenames. New migrations use timestamps and run after them.

## `void db connect` {#void-db-connect}

Connect an existing PostgreSQL/MySQL database or provision one through an adapter:

```sh
void db connect 'postgresql://user:password@host/database'
NEON_API_KEY=... void db connect --provider neon --name my-app
void db connect --provider @acme/void-db-provider --region region-id
```

The command saves `DATABASE_URL` in `.env`. When authenticated with a linked Void project, it also updates the encrypted deployment URL; pass `--local-only` to skip that sync. `neon` is built in. Other adapters are project dependencies or local modules exporting a `DatabaseProviderAdapter` from `void/database-provider`.

Provider-created credentials are never printed. For direct Cloudflare deploys, configure the same URL as a protected `DATABASE_URL` in the shell or CI environment that runs deploy.

For an existing PostgreSQL database migrated by Drizzle, [adopt its applied migration history](../../guide/database.md#adopt-existing-drizzle) before the first Void deployment.

## `void db set-url` {#void-db-set-url}

Update the PostgreSQL or MySQL connection string for deployment. Available for projects with `"database": "pg"` or `"database": "mysql"`.

Prompts for a connection string and sends it to the platform API to create or update the Hyperdrive configuration.

## `void db export` {#void-db-export}

```
void db export [--output <path>] [--no-data] [--no-schema] [--table <name>]
```

Dump the local database as SQL. Outputs to stdout by default (pipeable), or to a file with `--output`.

Data exports preserve SQLite AUTOINCREMENT and PostgreSQL SERIAL and identity counters, including IDs consumed by deleted rows. SQLite schema exports include indexes, views, and triggers. PostgreSQL schema exports preserve column types, generated columns, identity definitions, serial sequences, constraints, and indexes. `--no-schema` restores counter values into an existing schema; `--no-data` starts counters at their schema-defined starting values.

For PostgreSQL schemas with views, triggers, custom types, functions, or standalone sequences, use `pg_dump` for a complete backup. `void db export` reports these objects before writing a schema dump.

| Flag              | Purpose                            |
| ----------------- | ---------------------------------- |
| `--output <path>` | Write to a file instead of stdout  |
| `--no-data`       | Schema only (no INSERT statements) |
| `--no-schema`     | Data only (no CREATE TABLE)        |
| `--table <name>`  | Export a single table              |
