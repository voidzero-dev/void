# Void Platform

The Void platform runs in your Cloudflare account and lets developers deploy
applications through the Void CLI. This repository contains its control plane,
routing, proxy, log ingestion, and optional dashboard and build services.

The API, dispatch, proxy, tail, and email gateway Workers are packaged into
[`@void/platform`](../packages/platform/README.md). A released or source-built
runtime can be installed and upgraded with `void platform`. The installer tracks
resource ownership, applies compatible migrations, and preserves credentials
across upgrades.

Start with [Self-host a Void Platform](../docs/en/guide/self-hosted-platform.md) to
install it, [Platform Administration](../docs/en/guide/platform-administration.md) to
operate it, or [Platform Development](../docs/en/guide/platform-development.md) to
work on a fork. The dashboard and managed builds are optional source components;
they are not provisioned by the core installer.

Commands below run from the repository root. Package paths in the tables are
relative to `platform/` unless they begin with `../`.

## Context Overview

- **Important**: The source of truth of this file on disk is `README.md`. Both `AGENTS.md` and `CLAUDE.md` are symlinks to this file. When asked to update any of these, always update `README.md` (the actual file).
- Read the [architecture](./meta/architecture.md) for the current component map.
- Use the [maintainer documentation index](./meta/README.md) and [design archive](./meta/design-docs/README.md) for implementation context. Archived plans are not a current roadmap.
- Public SDK: repository-level `packages/`. If work involves the SDK, read the root `AGENTS.md` and the affected package instructions first.
- Public-facing docs: repository-level `docs/` (VitePress site).

## Contributor guidance

- Read [the operating lessons](./meta/lessons.md) before changing the platform.
- **Never** commit without asking for confirmation.
- Keep technical design records in `meta/design-docs/`, following its naming and
  frontmatter conventions. Keep commercial strategy, pricing research,
  competitor analysis, and private operational inventories out of the repository.
- Follow the root [instructions](../AGENTS.md) and
  [testing guide](../TESTING.md) for verification. Update the affected package
  guide when its behavior or contributor workflow changes.

## Quick Reference

| Command                                      | Purpose                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| `vp run build:core`                          | Build shared packages, CLI, and packaged platform runtime |
| `vp run build:platform`                      | Build the platform source apps                            |
| `vp run --filter @voidcloud/platform dev`    | Start the dashboard development server                    |
| `vp run build:all`                           | Build all packages, platform apps, and playgrounds        |
| `vp test run --project 'platform-*'`         | Run platform tests                                        |
| `vp run check`                               | Typecheck the workspace                                   |
| `vp run --filter @voidcloud/platform health` | Check the selected platform using operator authentication |

The workspace `dev` and `build` scripts in `platform/package.json` apply to the
dashboard. They do not start the API or install a platform. Deployment scripts
in that file serve the existing Void Cloud deployment; see [operations](#operations).

## Operator CLI

Use [Platform Administration](../docs/en/guide/platform-administration.md) for users, projects, plans, logs, and health checks. The [CLI reference](../docs/en/reference/cli/platform.md#operator-commands) lists administrator commands and options.

## Local Development

With a local PostgreSQL server running, build the shared packages and set up the API:

```sh
vp run build:core
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

Open `http://localhost:8787/admin/`. To work on the dashboard, start it separately:

```sh
vp run --filter @voidcloud/dashboard dev
```

The [development guide](../docs/en/guide/platform-development.md) explains the local
configuration, fork CI, schema changes, and how to deploy a source-built runtime
into your own installation.

## Monorepo structure

Platform source lives in `platform/packages/`; public SDK packages live in the repository-level `packages/`. Platform packages may depend on SDK packages; SDK packages must not depend on `platform/`. See the [architecture](./meta/architecture.md) for the component map.

## Operations

For an installed platform, use `void platform` lifecycle and administrator
commands. `vp run --filter @voidcloud/platform health` forwards to
`void platform system health`, using the selected connection and operator login.
Automation supplies `VOID_OPERATOR_TOKEN` and an explicit `VOID_API_URL`.

Void Cloud maintains an existing deployment that predates the installer. Its
`platform/package.json` deployment scripts and `platform/deployments/void-cloud.json`
descriptor belong to that deployment. The [Void Cloud operations note](./meta/operations.md)
explains its environments and credentials without storing account-specific
inventories or personal access assignments in the repository.

The hosted deploy/smoke workflows target the existing Void Cloud deployment.
Forks build their own runtime and use `void platform install` or
`void platform upgrade --runtime`, as shown in the development guide.

## Implementation Notes

- Platform metadata uses PostgreSQL through Hyperdrive. Application databases
  still default to D1 unless an app selects PostgreSQL or MySQL.
- Keep Worker TypeScript libraries explicit. DOM globals can hide the Workers
  types, including `CacheStorage.default`.
- Deploy protocol and database changes must tolerate the previous Worker version
  during rollout. Use additive migrations and verified compatibility edges.
- Static applications are served from platform assets. Worker applications also
  mirror assets in KV/R2 so dispatch can recover from the Cloudflare missing-asset
  response; see the [fallback design](./meta/design-docs/0066-wfp-asset-r2-fallback.md).
- Managed ISR bodies use the existing assets R2 bucket under `isr-cache/` so a
  deleted KV value cannot repopulate the edge cache during propagation. Reads
  never fall back to legacy ISR KV. Purges and deployment cleanup still scan
  legacy KV to remove old edge entries; project cleanup removes the R2 prefix.
  This storage change needs no new binding and does not change native app ISR.
- Keep routing changes, cron synchronization, and resource cleanup ordered around
  the successful deployment cutover. A pre-cutover failure must preserve the
  previous application's active configuration.
- Build subprocesses need `CI=true` so terminal prompts and animations do not
  interfere with captured output. Preserve raw logs for terminal consumers and
  sanitize them when rendering HTML or Markdown.
- Only Durable Object storage operations hold its input gate. Network I/O can
  interleave with cancellation and polling; shared log drains and teardown must
  keep their existing single-flight ordering.
- Bound retries and log processing by both time and input size. A timeout on a
  wait does not cancel the underlying database operation, and a row-count limit
  alone does not bound payload bytes or processing work.
- Drain build logs before publishing completion. Cancellation must preserve the
  authoritative final marker even when another handler has already changed the
  build's status. See the build-manager regression tests.
- GitHub build reruns require `check_run` and `check_suite` webhook subscriptions
  in addition to Checks write permission. Reuse the same ownership, branch-head,
  and deduplication checks as push-triggered builds.
- The fallback build-container CLI version is derived from the SDK package
  version. The version equality test enforces this during updates.

The [lessons](./meta/lessons.md) and affected package tests contain more detailed
invariants. The [design archive](./meta/design-docs/README.md) explains historical
tradeoffs without acting as a live deployment runbook.
