---
outline: deep
---

<script setup>
const items = [
  { name: "routes/", description: "API endpoints (file-based routing)", link: "#routes" },
  { name: "pages/", description: "Full-stack server-rendered pages", link: "#pages" },
  { name: "middleware/", description: "Global request middleware", link: "#middleware" },
  { name: "db/", description: "Drizzle schema and SQL migrations", link: "#db" },
  { name: "crons/", description: "Scheduled cron jobs", link: "#crons" },
  { name: "queues/", description: "Async queue consumers", link: "#queues" },
  { name: "email/", description: "Inbound email handlers", link: "#email" },
  { name: "durable-objects/", description: "Durable State modules", link: "#durable-objects" },
  { name: "src/", description: "Shared app code", link: "#src" },
  { name: "public/", description: "Static assets (served as-is)", link: "#public" },
  { name: ".void/", description: "Auto-generated (gitignored)", link: "#void" },
  { name: "vite.config.ts", description: "Vite config with voidPlugin()", link: "#config-files" },
  { name: "void.config.ts", description: "Void project config (optional)", link: "#config-files" },
  { name: ".env", description: "Local environment values", link: "#config-files" },
  { name: "env.ts", description: "Environment schema", link: "#config-files" },
  { name: "package.json" },
  { name: "tsconfig.json" },
];

const middlewareItems = [
  {
    name: "middleware/",
    children: [
      { name: "01.logger.ts", description: "Runs first" },
      { name: "02.auth.ts", description: "Runs second" },
    ],
  },
];

const dbItems = [
  {
    name: "db/",
    children: [
      { name: "schema.ts", description: "Drizzle schema (source of truth)" },
      { name: "schema/", description: "Optional: split into multiple files" },
      {
        name: "migrations/",
        children: [
          { name: "20260410161500_*.sql" },
          { name: "20260410161501_*.sql" },
        ],
      },
    ],
  },
];

</script>

# Project Structure

## Overview

A Void app uses file-based conventions to define routes, pages, middleware, and more. All directories are optional, so you only need the pieces your app actually uses.

<FileTree :items="items" />

## `routes/`

File-based HTTP API endpoints built on [Hono](https://hono.dev). Each file exports named HTTP method handlers.

<RoutesFileTree />

- **Named exports**: `export const GET = defineHandler(...)`, `export const POST = ...`
- **Extensions**: `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, or `.mjs`; use `.tsx` or `.jsx` for JSX handlers
- **Dynamic segments**: `[id]` becomes `:id` route parameter
- **Catch-all**: `[...slug]` matches the remaining path
- **Route groups**: `(admin)/` organizes files without affecting URL paths
- **Files starting with `_`** are ignored
- **Environment suffix**: `debug.dev.ts` builds in development only, `metrics.prod.ts` in production only

See [Server Routing](/guide/server-routing) for the full guide.

## `pages/`

Full-stack server-rendered pages with co-located data loading. Available with Vue, React, Svelte, and Solid adapters.

<PagesFileTree />

- **`.server.ts` (or `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`) files** export `loader` for `GET` data and `action` for mutations, paired with the page component of the same name
- **Layouts** nest automatically and persist across navigations
- **Markdown** pages are supported with frontmatter
- **Environment suffix**: `debug.dev.tsx` is served in development only, `stats.prod.tsx` in production only

See [Pages Routing](/guide/pages-routing/overview) for the full guide.

## `middleware/`

Global middleware that runs on every request. Numeric prefixes control execution order.

<FileTree :items="middlewareItems" default-expanded />

Each file default-exports a `defineMiddleware()` handler. Use middleware to set shared context (auth, logging, rate limiting) available to all routes.

## `db/`

[Drizzle schemas](/guide/database#schema-definition) and SQL migrations for D1, PostgreSQL, or MySQL.

<FileTree :items="dbItems" default-expanded />

- `db/schema.ts`: your Drizzle table definitions and the source of truth for DB types
- `db/schema/`: optional. Split tables into separate files and re-export them from `db/schema.ts`
- `db/migrations/`: generated SQL migration files, applied in order on deploy

Generate schema with `void gen model` or write it by hand. Generate migrations with `void db generate`.

## `crons/`

[Scheduled jobs](/guide/jobs). Each file exports a `cron` expression and a default `defineScheduled()` handler.

## `queues/`

[Queue consumers](/guide/queues). Each file default-exports a `defineQueue()` handler.

## `email/`

[Inbound email handlers](../guide/email/receiving.md#inbound). A file's name selects the recipient; `_default.ts` handles other addresses.

## `durable-objects/`

[Durable State](/guide/durable-state) modules. Each file default-exports a `defineDurableState()` definition.

## `src/`

Shared application code such as components, utilities, and types. This directory has no special convention, so organize it however you like.

## `public/`

Static assets served as-is at the root path. Files here are not processed by Vite.

## `.void/`

Generated types and local development state (gitignored). Run `void prepare` to create the types, or let `vite dev` and `vite build` update them.

## Config Files

| File             | Purpose                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.ts` | Vite configuration. Must include `voidPlugin()`.                                                                                                         |
| `void.config.ts` | Optional Void config for [routing](/reference/config#routing), [inference](/reference/config#inference), and [worker settings](/reference/config#worker) |
| `tsconfig.json`  | TypeScript config. Extend `.void/tsconfig.json` for auto-generated types; run `void init --tsconfig` when an existing config already uses `extends`.     |
| `.env`           | Local development values only (gitignored; never deployed)                                                                                               |
| `env.ts`         | Checked-in env names, types, defaults, and requiredness                                                                                                  |

See [Environment Variables](/guide/env-vars) for local, production-secret, and client build behavior.
