---
outline: deep
---

# Code Generation {#code-generation}

## `void gen model` {#void-gen-model}

```
void gen model <name> [columns...]
```

Scaffold a Drizzle table, list and create routes, and a route to fetch one row by ID.

```sh
void gen model posts title:string body:text published:boolean
```

Creates:

- `db/schema/posts.ts`: a table with `id`, `createdAt`, `updatedAt`, and your columns
- An export from `db/schema.ts`
- `routes/api/posts/index.ts`: `GET` for list and `POST` for insert with validation
- `routes/api/posts/[id].ts`: `GET` by id with `404` handling
- Regenerated types and TypeScript configuration in `.void/`

The generated routes automatically detect your validation library from `package.json` (`valibot`, `zod`, or `arktype`). If none is found, you will be prompted to choose one or skip validation. Run `void db push` to apply the schema locally, or `void db generate` to create migrations before deploying.

Column format: `name:type` or `name:type?` (nullable). Types: `string`, `text`, `datetime`, `integer`, `boolean`, `real`, `blob`.

Model names must be lowercase alphanumeric with underscores (e.g. `posts`, `user_roles`). Existing files are never overwritten.

## `void gen migration` {#void-gen-migration}

```
void gen migration <name>
```

Create an empty migration file with a timestamp prefix (`YYYYMMDDHHMMSS`).

```sh
void gen migration add_avatar_to_users
# → db/migrations/20260410161500_add_avatar_to_users.sql
```

Existing projects using the old numeric prefix (`0001_`, `0002_`, ...) can rename with `void db rename-migrations`.

## `void gen route` {#void-gen-route}

```
void gen route <path> [--methods get,post,...]
```

Create a route file with `defineHandler` exports. Defaults to GET.

```sh
void gen route api/health
void gen route api/users --methods get,post,delete
```

Creates `routes/<path>.ts` with an exported handler for each method. Supported methods: `get`, `post`, `put`, `patch`, `delete`.

## `void gen middleware` {#void-gen-middleware}

```
void gen middleware <name>
```

Create a numbered middleware file with `defineMiddleware` default export.

```sh
void gen middleware auth
# → middleware/01.auth.ts (or 02, 03, etc.)
```

The prefix is auto-detected from existing middleware files.

## `void gen ssr` {#void-gen-ssr}

```
void gen ssr [--react | --vue | --svelte | --solid]
```

Scaffold SSR entry points and a minimal App component for your framework.

Creates three files:

- `src/main.ssr.{tsx,ts}`: server entry with `defineRender`
- `src/main.client.{tsx,ts}`: client entry with hydration
- `src/App.{tsx,vue,svelte}`: minimal interactive component

If no flag is provided, the framework is auto-detected from `package.json` dependencies.

## `void gen cron` {#void-gen-cron}

```
void gen cron <name>
```

Create a cron job file in `crons/` with `defineScheduled` and a placeholder cron expression.

```sh
void gen cron hourly-sync
```

## `void gen queue` {#void-gen-queue}

```
void gen queue <name>
```

Create a queue consumer file in `queues/` with `defineQueue`, a `Message` type, and commented-out batch options.

```sh
void gen queue emails
```
