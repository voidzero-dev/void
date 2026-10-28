---
outline: deep
---

# Operations

## Previewing Changes

Commands that change the platform show the affected objects before asking for confirmation. To inspect a change without applying it, add `--plan`:

```sh
void platform user suspend <user-id> --reason "Investigating unexpected traffic" --plan
```

The preview shows which account will be suspended and the effect on its projects. Run the command again without `--plan` to confirm interactively, or use `--yes` when the change is ready to apply:

```sh
void platform user suspend <user-id> --reason "Investigating unexpected traffic" --yes
```

Scripts must use `--yes` to apply these changes. The `void platform auth` session commands run directly and do not use `--plan` or `--yes`; changes under `void platform config auth` do use previews and confirmation. After a change, `void platform system events` shows the administrator, affected objects, and recorded outcome.

Changes can take longer when an account owns many resources. Requests that change the platform allow five minutes by default; use `--timeout` to set a different limit in seconds:

```sh
void platform user delete <user-id> --timeout 600 --plan
```

If a request times out or loses its connection, some work may already have finished. Check the affected objects and `system events` before retrying. Void reports partial results when it can and does not automatically repeat the change.

## Following Logs

To investigate a deployment, find its ID and follow its runtime logs:

```sh
void platform deployment list --project <project-id>
void platform deployment logs <deployment-id> --since 10m --follow
```

Runtime logs include application messages, exceptions, and HTTP status codes. Without `--follow`, the command reads a page of historical logs. Use `--since` to choose a duration, an ISO date, or a timestamp in milliseconds.

Logs can become available after a request finishes. Following checks a five-minute overlap to pick up delayed records without printing them again. Records delayed longer than that may need a later historical query.

Build logs use the build's ID:

```sh
void platform build logs <build-id> --follow
```

Following waits for the final logs before stopping, including diagnostics written after the build's status changes. For a GitHub Actions build, the command gives you the URL of its logs.

## Checking the Platform

### Health checks

Use the overview to see recent activity, or run a health check to test the platform's services and database:

```sh
void platform system overview
void platform system health
```

Health checks use the services configured for the selected platform. An unhealthy result exits with a nonzero status, so the same command can be used in a script.

The dashboard’s **System Status** page refreshes health checks every 30 seconds and shows errors beside the affected service.

Use `void platform upgrade`, `repair`, `disable`, and `enable` to maintain your platform. See [platform maintenance](/guide/platform/installation/maintenance#resume-repair-recover-and-upgrade).

During an upgrade or rollback, the admin UI shows progress at `/admin/status`. See [Follow upgrade and rollback progress](/guide/platform/installation/maintenance#follow-upgrade-and-rollback-progress).

For backups and restores, see [Prepare for disaster recovery](/guide/platform/installation/maintenance#prepare-for-disaster-recovery).

## Using Scripts

Add `--json` to read a command's result from another program:

```sh
void platform user list --page 1 --limit 50 --json
void platform system health --json
```

Results go to standard output. Command errors go to standard error as JSON and exit with a nonzero status. With `--follow`, each log response is a separate JSON line.

Operator tokens expire after one hour. For CI, mint a new operator token at the start of each job from a valid full API login session belonging to an active administrator. Choose the platform explicitly, inject the full session as `VOID_TOKEN` from your secret manager, and capture the exchange output directly into the protected job environment:

```sh
export VOID_API_URL=https://platform.example.com
VOID_OPERATOR_TOKEN="$(
  printf '%s' "$VOID_TOKEN" | void platform auth token --token-stdin
)" || exit 1
export VOID_OPERATOR_TOKEN
unset VOID_TOKEN
void platform system health --json
unset VOID_OPERATOR_TOKEN
```

Disable shell tracing for the exchange and do not write either token to logs or plaintext files. A full API login session expires after 30 days and can be revoked sooner; renew it through the normal authenticated login flow and update the protected CI secret. A job that runs longer than one hour must repeat the exchange while its full API session is still valid. An expired operator token cannot refresh itself, and Void does not issue permanent service tokens for administrator automation.

`auth login --token-stdin` performs the same elevation and saves the one-hour operator token in the system keychain for interactive use. See [operator authentication](../../../reference/cli/platform.md#operator-authentication) for the full command syntax.
