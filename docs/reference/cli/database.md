---
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

Show migration status. Displays which migrations are applied or pending locally, then uses the saved deployment target for remote status: the hosted API for Void projects, the pinned D1 database and its configured migration table for direct Cloudflare SQLite projects, or the shell `DATABASE_URL` for direct Cloudflare PostgreSQL/MySQL projects. If the remote credential or service is unavailable, local status is still shown. If the local PostgreSQL or MySQL database cannot be read, local status shows `unknown`; the command fails when remote status is not available either.

## `void db reset` {#void-db-reset}

```
void db reset [--yes]
```

Drop the development database and re-apply all migrations. D1 resets the local database. PostgreSQL drops the tables, views, sequences, and custom types in the `public` schema of the `DATABASE_URL` database from `.env` and keeps installed extensions. If a table, view, or function in another schema uses one of those views, sequences, or types, reset stops before it drops anything and lists those objects. MySQL drops every table and view in that database.

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
void db execute <sql>
void db execute --file <path>
void db execute --remote <sql>
```

Run ad-hoc SQL against the database. Provide SQL inline or from a file. SELECT queries display results as a formatted table; other statements execute silently.

By default, targets the local database. Pass `--remote` to run against the deployed database selected in `.void/project.json`:

- **Void platform D1 projects**: routes the query through the selected platform's registered proxy using your auth token.
- **Direct Cloudflare D1 projects**: invokes Cloudflare against the pinned D1 binding from `void.config.ts` or `void.lock.json`.
- **Hosted PostgreSQL and MySQL projects**: fetches the stored connection string from the platform and connects directly.
- **Direct Cloudflare PostgreSQL and MySQL projects**: uses `DATABASE_URL` from the current shell; Cloudflare cannot return the password from Hyperdrive.

For destructive statements (`DELETE`, `UPDATE`, `DROP`, etc.) when running in a TTY, you will be prompted to confirm before the query is sent to the deployed database. Non-TTY environments (CI) skip the prompt.

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
- **D1 projects**: remote Studio is not available. Use `void db execute --remote` to query your deployed D1 database.

## `void db restore` {#void-db-restore}

```
void db restore --bookmark <bookmark> [--platform cloudflare] [--yes]
void db restore --timestamp <iso-time> [--platform cloudflare] [--yes]
```

Restore the deployed D1 database of a direct Cloudflare deploy with D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Before `void deploy --platform cloudflare` applies migrations, it prints the `--bookmark` that undoes them. `--timestamp` restores the state at an ISO 8601 time with `Z` or an offset instead, such as `2026-10-16T09:30:00Z`, with at most millisecond precision. Time Travel keeps 7 days of history on Workers Free and 30 days on Workers Paid. An older bookmark or time can no longer be restored: Cloudflare rejects it and the database stays unchanged. To undo an older migration, write a new migration that reverses it.

If the project's saved destination is not Cloudflare and you deployed once with `void deploy --platform cloudflare`, pass `--platform cloudflare`; deploy prints the command with it.

Restoring replaces the whole database and discards every write made after that point. Void names the database and asks before it restores. Pass `--yes` to skip the prompt in scripts and CI; without a terminal, the command stops unless `--yes` is set. Afterwards Void prints the `void db restore` command that undoes the restore.

A restore also rewinds the record of applied migrations. Void lists the migration files the database no longer has applied; the next deploy applies them, so fix or remove the one that caused the problem first. Restoring does not change the deployed code: use [`void project rollback`](./project.md#void-project-rollback-deployid) if the live version needs the newer schema. After a one-off Cloudflare deploy, pass `--platform cloudflare` to `void project rollback` and `void deploy` as well.

## `void db rename-migrations` {#void-db-rename-migrations}

Rename existing migrations from the old numeric prefix format (`0001_name.sql`) to timestamp-based format (`20260410161500_name.sql`). Updates local tracking table and remote records if logged in with a linked project. A project that deploys to Void must be linked first with `void project link`; otherwise the command stops without changes.

Direct Cloudflare deploys are not supported: Void cannot rename the records in the deployed database, so the command stops without changes. Keep the existing names; new migrations use timestamps and run after them.

## `void db connect` {#void-db-connect}

Connect an existing PostgreSQL/MySQL database or provision one through an adapter:

```sh
void db connect 'postgresql://user:password@host/database'
NEON_API_KEY=... void db connect --provider neon --name my-app
void db connect --provider @acme/void-db-provider --region region-id
```

The command saves `DATABASE_URL` in `.env`. When authenticated with a linked Void project, it also updates the encrypted deployment URL; pass `--local-only` to skip that sync. `neon` is built in. Other adapters are project dependencies or local modules exporting a `DatabaseProviderAdapter` from `void/database-provider`.

Provider-created credentials are never printed. For direct Cloudflare deploys, configure the same URL as a protected `DATABASE_URL` in the shell or CI environment that runs deploy.

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
