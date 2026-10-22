---
outline: deep
---

<script setup>
import LegacyDocRedirect from "../.vitepress/theme/LegacyDocRedirect.vue";
import links from "../.vitepress/redirects/reference-cli.json";
</script>

<LegacyDocRedirect page="reference/cli.md" :links="links" />

# CLI Reference {#cli}

`void` is a local binary from the installed `void` package.

Use this page as a command reference. If you are setting up a project for the first time, start with [Quickstart](../guide/quickstart.md) and come back here when you need exact command behavior or flags.

## Command Groups

| Command group                              | Reference                                                     |
| ------------------------------------------ | ------------------------------------------------------------- |
| `init`, `prepare`, `info`, `migrate`       | [Project setup](./cli/setup.md)                               |
| `connect`, `auth`, `account`, `cloudflare` | [Connections and authentication](./cli/auth.md)               |
| `project`                                  | [Projects, teams, logs, and rollback](./cli/project.md)       |
| `deploy`                                   | [Deployment](./cli/deploy.md)                                 |
| `db`                                       | [Database](./cli/database.md)                                 |
| `gen`                                      | [Code generation](./cli/generate.md)                          |
| `secret`, `env`                            | [Secrets and environment](./cli/secrets.md)                   |
| `github`, `build`                          | [GitHub and builds](./cli/github.md)                          |
| `domain`                                   | [Custom domains](./cli/domains.md)                            |
| `email`                                    | [Email](./cli/email.md)                                       |
| `platform`                                 | [Platform installation and administration](./cli/platform.md) |

## Cheat Sheet {#cheat-sheet}

| Command                           | Purpose                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `void deploy`                     | Build and deploy to the configured platform                                   |
| `void prepare`                    | Generate `.void` artifacts without starting Vite                              |
| `void info [--json]`              | Inspect persistent resource names before moving their code                    |
| `void gen model <name> [cols...]` | Scaffold a Drizzle table and API routes                                       |
| `void gen route <path>`           | Create an API route                                                           |
| `void db push`                    | Apply schema directly without migration files                                 |
| `void db generate`                | Generate SQL migrations from schema changes                                   |
| `void db status`                  | Show local/remote migration status                                            |
| `void db reset`                   | Drop and re-apply all migrations                                              |
| `void db seed`                    | Reset + seed local database                                                   |
| `void db execute <sql>`           | Run SQL against the database (--remote for deployed)                          |
| `void db studio`                  | Open Drizzle Studio (--remote for a deployed external database)               |
| `void db restore --bookmark <b>`  | Restore the deployed D1 database to a restore point (direct Cloudflare)       |
| `void secret put <name=value>`    | Set a production secret                                                       |
| `void secret list`                | List production secrets                                                       |
| `void secret sync <file>`         | Bulk upload secrets from dotenv file                                          |
| `void env check [--remote]`       | Validate env.ts schema                                                        |
| `void env types`                  | Regenerate .void/env.d.ts from env.ts                                         |
| `void auth login`                 | Authenticate with the project’s saved destination, or choose one              |
| `void account login`              | Authenticate with a Void platform                                             |
| `void cloudflare login`           | Authenticate with Cloudflare through Void                                     |
| `void platform install`           | Install a company Void platform in Cloudflare                                 |
| `void connect <url>`              | Connect the CLI to a Void platform; hostnames default to HTTPS                |
| `void project link`               | Link directory to a project                                                   |
| `void project logs`               | Show runtime logs from deployed project                                       |
| `void project requests`           | Show request-level traffic (status, method, timing)                           |
| `void project rollback`           | Roll back to a previous deployment                                            |
| `void project cancel`             | Cancel an active deployment                                                   |
| `void project zero-trust`         | Inspect or override project Zero Trust protection                             |
| `void project purge-cache`        | Purge all cached pages (Void platform)                                        |
| `void build logs`                 | Stream, tail, or download build logs                                          |
| `void email status`               | Show email readiness on your own Cloudflare account (`--platform cloudflare`) |
| `void email setup`                | Set email up on your own Cloudflare account, without deploying                |
| `void email usage`                | Show monthly recipient attempts, inbound receipts, and quota                  |
| `void email logs`                 | Show recent email delivery activity                                           |
| `void email destinations`         | List verified recipient addresses                                             |
| `void email allow <address>`      | Add a recipient and send a verification email                                 |
| `void email disallow <address>`   | Remove a recipient from the allowlist                                         |
| `void email alias [name]`         | Show the shared mail address, or give it a shorter permanent name             |
| `void email domain`               | Send and receive at your own domain on a Cloudflare zone                      |
| `void init`                       | Set up a new or existing project, including coding agents                     |
| `void migrate`                    | Convert legacy `void.json` and root Wrangler JSON/JSONC into `void.config.ts` |

## Binary Invocation {#binary-invocation}

The docs use `void` for brevity. Outside package scripts, run it with your package manager: `npx void`, `pnpm void`, `yarn void`, `bunx void`, or `vpx void`.

Alternatively, you can add `./node_modules/.bin` to your `PATH` so that you can invoke `void` directly when you are in the root directory of your app.

:::warning ⚠️ Prefer local install
Install `void` in your project so the CLI and runtime use the same version.
:::

## Help {#help}

```
void --help
void help
void help <command>
void help <group> <command>
void <command> --help
void <group> <command> --help
void <group> help <command>
```

Use `void --help` for the command list, or `void deploy --help` for a specific command. Help is available without signing in or setting up a project.

## Environment variables {#environment-variables}

| Variable       | Purpose                                                                   | Default |
| -------------- | ------------------------------------------------------------------------- | ------- |
| `VOID_TOKEN`   | Auth token override instead of saved config                               | none    |
| `VOID_PROJECT` | Default project slug for deploy, secret, domain, and cache purge commands | none    |
