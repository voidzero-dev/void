---
outline: deep
---

# Projects {#project-commands}

## `void project status [name]` {#void-project-status-name}

Show deployments for the configured target.

- Void targets show recent hosted deployments; `[name]` looks up a project by slug and otherwise the linked project is used.
- Cloudflare targets list Worker Versions, identify the active version, and show the recorded migration count. A project name is not accepted because the Worker name comes from `cloudflare.name` in `void.config.ts`.
- Owners and admins also see a warning when the platform cannot finish [replacing the project's credentials](../../guide/project-collaboration.md#change-or-remove-access).

## `void project link [name]` {#void-project-link-name}

Link current directory to an existing hosted Void project by slug, or select interactively if omitted. State is stored in `.void/project.json`. Direct Cloudflare apps use `cloudflare.name` in `void.config.ts` and do not need linking.

## `void project list` {#void-project-list}

List all accessible hosted projects (slug, role, type, URL). Shared projects are included and the role column distinguishes them from projects you own. For a saved Cloudflare target, this displays the current Worker's versions instead because there is no Void project registry.

## `void project team` {#void-project-team}

Manage access to a project hosted on a Void platform:

```sh
void project team list [--project <slug>]
void project team invite <email> --role <reader|collaborator|admin> [--project <slug>]
void project team invitations [--project <slug>]
void project team role <user-id> <reader|collaborator|admin> [--project <slug>]
void project team remove <user-id> [--project <slug>]
void project team revoke <invitation-id> [--project <slug>]
void project team leave [--project <slug>]
void project team pending
void project team accept <invitation-id>
void project team decline <invitation-id>
```

Project-scoped commands use `--project`, then `VOID_PROJECT`, then the linked project. Invitations can target only an email address already registered to a user on that platform; they do not create accounts or grant signup access. Only the invited account can accept or decline its invitation. `list` shows the same credential warning as `void project status`.

Readers can view the project but cannot deploy. Collaborators can deploy and manage deploy prerequisites. Project administrators can additionally manage domains, email destinations, GitHub configuration, and the project team. The owner alone can delete the project. See [Project Collaboration](../../guide/project-collaboration.md) for the full role boundaries.

Project-scoped team management commands are not available for projects deployed
directly to Cloudflare. The account-scoped `pending`, `accept`, and `decline`
commands use the active connection selected by `void connect <url>`, regardless
of the current project's link or deploy target. `VOID_API_URL` takes precedence;
an unscoped `VOID_TOKEN` selects Void Cloud. These commands display their
platform, and accepting an invitation leaves directory links intact. To link
the invited application, run `void project link` in an unlinked checkout of
that application.

## `void project zero-trust` {#void-project-zero-trust}

Inspect or override protection for a project on a Void platform:

```sh
void project zero-trust status [--project <slug>]
void project zero-trust protect [--project <slug>]
void project zero-trust public [--project <slug>]
void project zero-trust reconcile [--project <slug>]
```

Project selection follows `--project`, then `VOID_PROJECT`, then the linked
project.

Readers can inspect the state. The owner or a project administrator can protect
the project, make it public, or repair drift. `public` does not change the
platform default for future projects. Deploys and rollbacks wait until a
protection change is finished; if one is refused, the owner or a project
administrator can run `void project zero-trust reconcile` before you retry.
These commands do not apply to direct Cloudflare deployments.

## `void project token <create|list|renew|revoke>` {#void-project-token-create-list-renew-revoke}

Manage revocable `aud: deploy` credentials for one Void platform project. The
credential can only call the endpoints used by `void deploy`; it cannot access
operator, account, secret-writing, project-deletion, or other projects' routes.

```sh
void project token create --name github-actions --expires-in 30
void project token list
void project token renew <credential-id> --expires-in 30
void project token revoke <credential-id>
```

Pass `--project <name>` outside a linked project. Expiry is bounded to 1–90
days. Create and renew display the bearer value once; replace the stored secret
immediately after renewal because the previous credential is revoked in the
same operation. Project deletion and owner suspension also stop its use. Login
method disablement does not revoke these independent deploy credentials.

Store the printed `VOID_TOKEN` and `VOID_API_URL` in the CI secret manager. The
Access pair passes the perimeter; the scoped Void credential authorizes only
this project's deploy workflow. When prerendering or remote proxy bindings are
used on an Access-protected platform, store `VOID_ACCESS_CREDENTIALS` as an
origin-keyed JSON secret containing both exact HTTPS origins, even if both use
the same service-token pair:

```json
{
  "https://void-company-api.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  },
  "https://void-company-proxy.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  }
}
```

`VOID_ACCESS_ORIGIN` scopes a pair to one origin, so selecting only the API
origin is insufficient for a workflow that calls the proxy. Use distinct pairs
in the two entries when the Access policies require them.

## `void project logs` {#void-project-logs}

```
void project logs [--level <level>] [--filter <text>] [--range <duration>] [--deployment <id>]
```

Show runtime logs from the deployed target. Hosted Void targets query retained log history. Cloudflare targets open a live tail for the Worker named in `void.config.ts`; they do not provide historical log storage.

| Flag                 | Purpose                                                                                                                                                                                                         | Default |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                                                                                                                                                 | `1h`    |
| `--level <level>`    | Filter by log level. One of `error`, `warn`, `info`, `log`, `debug`, `all`. `error` also includes uncaught exceptions, non-`ok` outcomes, and any 5xx response — even when the worker neither threw nor logged. | `all`   |
| `--filter <text>`    | Case-insensitive **substring** match against log message text and exception name/message — not a level filter. Shows the full request entry on any hit.                                                         | none    |
| `--deployment <id>`  | Filter logs to a specific deployment ID.                                                                                                                                                                        | none    |

Output shows one line per request (`HH:MM:SS METHOD URL STATUS`) with indented console log and exception lines beneath. Errors and exceptions are colored red, warnings yellow.

Examples:

```
void project logs --level error --range 12h
void project logs --level error --filter websocket
```

Logs include top-level `console.*` calls and uncaught errors captured by Cloudflare Tail. If you catch an error and save it only to your database, it won't appear here. Also log it with `console.error()` or `logger.error()` from `void/log`. On hosted Void targets, pass the `Error` object itself to `console.error()`, as in `console.error('Save failed:', error)`, to see its stack trace under the log line. Logging only `error.message` shows no stack.

For errors that never reach your Worker, such as edge routing errors or static site requests, use `void project requests --status 5xx`.

On a direct Cloudflare target, `--filter` becomes Cloudflare's live search, `--deployment` selects a Worker Version, and `--level error` selects error invocations. Other individual console levels cannot be filtered, and `--range` does not select history. `void project requests` is hosted-only.

## `void project requests` {#void-project-requests}

```
void project requests [--status <filter>] [--range <duration>]
```

Show request traffic for the linked project, including static assets and edge errors that do not appear in Worker logs.

| Flag                 | Purpose                                                                                       | Default |
| -------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `--status <filter>`  | Filter by status: a class (`2xx`, `3xx`, `4xx`, `5xx`) or an exact 3-digit code (e.g. `500`). | none    |
| `--range <duration>` | How far back to look. Format: `<number><unit>` (m/h/d). Max 7d.                               | `1h`    |

Output shows one line per request (`HH:MM:SS METHOD STATUS TYPE DURATION`). 5xx are colored red, 4xx yellow. Note: request paths are not recorded, so this view shows status and type rather than URLs — use `void project logs` for per-URL, per-log detail on requests that do reach your worker.

Examples:

```
void project requests --status 5xx
void project requests --range 24h
```

## `void project rollback [deployId]` {#void-project-rollback-deployid}

```
void project rollback [deployId] [--platform cloudflare]
```

Roll back to a previous deployment or Worker Version.

- If `[deployId]` is omitted, shows an interactive select menu of retained deployments
- If the target deployment has fewer applied migrations than the current one, a warning is shown listing the migration diff before confirmation

On a Void platform, you can select a retained deployment. On Cloudflare, use a complete Worker Version ID or an unambiguous prefix. Void activates that version at 100%. When both versions have complete trigger snapshots, it also restores the selected version's schedules, queues, workflows, routes, and custom domains. Otherwise, rollback keeps the current triggers and restores the code, including versions originally deployed outside Void.

If the project's saved destination is not Cloudflare and you deployed once with `void deploy --platform cloudflare`, pass `--platform cloudflare` to roll back that Worker.

Rollback doesn't reverse database migrations. If older code may run against a newer schema, or migration metadata is missing, Void explains the risk and asks for confirmation. On Cloudflare, undo D1 migrations with [`void db restore`](./database.md#void-db-restore) and the restore point that deploy printed before it applied them, within 7 days on Workers Free or 30 days on Workers Paid.

## `void project cancel [deployId]` {#void-project-cancel-deployid}

```
void project cancel [deployId]
```

Cancel an active deployment.

- If `[deployId]` is omitted, targets the linked project's active deployment
- If `[deployId]` is provided, targets that deployment; it must still be active

Void asks for confirmation before it requests cancellation.

This command is hosted-only. Direct Cloudflare deploys are local operations and do not expose a remote build to cancel.

## `void project delete [name]` {#void-project-delete-name}

Permanently delete a hosted Void project and all its resources (databases, KV namespaces, R2 buckets, deployments). Requires typing the project slug to confirm; `--force` (`-f`) skips the prompt.

If `[name]` is omitted, uses the linked project.

For direct Cloudflare targets this command refuses to run. Inferred resources can be shared, so Void never performs automatic teardown; verify ownership and remove resources explicitly with Cloudflare tooling.

## `void project purge-cache` {#void-project-purge-cache}

```
void project purge-cache [--project <name>]
```

Purge all cached pages for the linked project. The edge cache will clear within seconds.

If `--project` is provided, purges that project's cache instead of the linked project.

This command is hosted-only. For direct Cloudflare targets, redeploy or purge the configured ISR KV namespace yourself.
