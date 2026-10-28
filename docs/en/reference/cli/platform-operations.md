---
outline: deep
---

# Platform Operations {#operator-deployments}

Use your administrator session for these commands. See [Platform Management](./platform.md#operator-commands) for platform selection, previews, and confirmation.

Find a deployment, inspect its manifest, or request cancellation:

```sh
void platform deployment list [--project <id-or-slug>] [--status <status>] [--search <text>] [--page <n>] [--limit <n>]
void platform deployment show <id>
void platform deployment cancel <id>
void platform deployment migrate-assets <id> [--cursor <cursor>] [--plan|--yes]
```

Cancellation applies while a deployment is pending, uploading, migrating, or prerendering, and can be requested again while it is canceling. A deployment that has begun switching traffic, is compensating for a failure, or has finished cannot be canceled through this command.

`migrate-assets` copies a deployment's legacy assets to scoped R2 storage without changing application traffic. Use `--plan` to preview and `--cursor` to resume from a successful batch. Original assets remain in place.

Read its runtime logs with:

```sh
void platform deployment logs <id> [--since <time>] [--cursor <cursor>] [--limit <n>] [--follow]
```

The default is the last hour, oldest first, with up to 100 records. `--since` accepts a duration such as `10m`, `2h`, or `1d`, an ISO date, or epoch milliseconds. Set `--limit` from 1 to 500 and pass the response's `nextCursor` as `--cursor` to read another page.

`--follow` reads the remaining pages and checks for new logs every two seconds until you press Ctrl+C. It checks a five-minute overlap for delayed records and suppresses replayed rows. Records that arrive later may need a subsequent historical query. Following stops with an error if a window exceeds 10,000 records; use a narrower historical query in that case.

## Builds {#operator-builds}

Inspect a build or read its output:

```sh
void platform build show <id>
void platform build logs <id> [--since <sequence>] [--limit <n>] [--follow]
```

Build logs start at sequence `0` and return up to 500 lines. Use the returned `lastSeq` as `--since` to continue; `--limit` accepts 1 to 500. Container log retrieval requires managed builds to be enabled. GitHub Actions builds return an external log URL.

Following waits for the final logs after the build becomes terminal. If completion cannot be confirmed within two minutes, the command exits with an error.

## System {#operator-system}

Inspect activity, check service health, or review administrative changes:

```sh
void platform system overview
void platform system health
void platform system cli-versions
void platform system asset-migrations [--page <n>] [--limit <n>]
void platform system events [--page <n>] [--limit <n>]
void platform system backfill-queue-tokens
void platform system sandbox-drain [--cursor <opaque-cursor>]
void platform system rotate-proxy-tokens [--project <id> | --all]
```

`overview` shows platform totals and recent activity. `health` checks the configured services and database, and exits with a nonzero status if a check fails. `cli-versions` reports the CLI versions used by deployments.

`asset-migrations` inventories stored deployment assets and reports `needsMigration` and `invalid` counts. Use the response's pagination fields to read all entries.

`events` shows the administrator, target, and outcome of changes. A pending event means the outcome has not been recorded. Previews and session login/logout do not create these events. `backfill-queue-tokens` repairs older queue entries that are missing authentication tokens and supports `--plan` before applying the repair.

`sandbox-drain` removes legacy tenant-owned Sandbox resources. Use `--plan` to preview and `--yes` to apply, then pass `nextCursor` as `--cursor` to continue. Application traffic stays paused during cleanup.

`rotate-proxy-tokens` gives projects new platform credentials on their live Worker and the Workers kept for rollback, without a redeploy. Workers kept for rollback whose author can no longer deploy keep the old credentials. Use `--project <id>` for one project or `--all` for every project, with `--plan` to preview and `--yes` to apply. `--plan` alone shows every rotation that is still running. Each run does a bounded batch and the platform finishes the rest in the background; a rotation takes about 6 minutes per project, longer while a deploy is running. Use `--plan` to check progress until nothing is pending or failed. Running `--yes` again with `--project` or `--all` while a rotation is still running starts one more rotation for that project. When a rotation is finished, the previous credentials no longer work. Each rotation starts a new version of the project's live Worker, so WebSocket connections reconnect once.

Use the [platform lifecycle commands](./platform-installation.md#lifecycle-commands) to maintain your installation's Workers.

## Hosted Workers {#operator-workers}

The following commands manage the Workers of the hosted Void Cloud platform.
They are unavailable on a self-hosted installation; use the
[lifecycle commands](./platform-installation.md#lifecycle-commands) there instead.

```sh
void platform worker list [--environment <production|staging>]
void platform worker show <worker-name> [--environment <production|staging>]
void platform worker rollback <worker-name> <version-id> [--environment <production|staging>]
void platform worker rollback-all [--environment <production|staging>]
void platform worker events [batch-id] [--environment <production|staging>]
```

Use a name from `worker list`, such as `api` or `proxy`. `show` lists its
versions and current deployment. Preview either rollback with `--plan`, then
apply it interactively or with `--yes` in a script. `events` lists worker
operation events or inspects one batch by ID.
