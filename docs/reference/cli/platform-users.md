---
description: 'Manage platform users, their projects, and the plans assigned to their accounts.'
outline: deep
---

# Platform Users and Projects {#operator-users}

Use your administrator session for these commands. See [Platform Management](./platform.md#operator-commands) for platform selection, previews, and confirmation.

Find a user by login, email, or ID, then inspect their projects and usage:

```sh
void platform user list [--search <text>] [--page <n>] [--limit <n>]
void platform user show <id>
```

Use the same ID to change a plan, suspend or restore the account, or delete it:

```sh
void platform user plan <id> <plan-id>
void platform user suspend <id> [--reason <text>]
void platform user restore <id>
void platform user delete <id>
```

Changing a user's plan updates their resource limits and their projects' [AI Gateway logging default](#ai-gateway-logging). An administrator suspension stays in effect. The command updates AI logging for up to 100 projects per run; if it reports unfinished work, repeat the same command to continue.

Suspending a user blocks their apps, scheduled jobs, and queue consumers. While suspended, each queue message is retried about once an hour. Each attempt uses one of the queue's retries. Messages are dropped when retries run out: after about 3 hours with the default of 3 retries, or immediately with `maxRetries: 0`. Restore an account suspended by mistake promptly; delivery resumes within about an hour.

Deleting a user also deletes their project resources.

The last active administrator cannot be deleted or suspended. Both previews and
actual mutations enforce this rule, including in the browser admin UI. Allowed
administrator removals revoke administrator access before resource cleanup; if
cleanup fails, access stays revoked and the partial result reports it.

## Projects {#operator-projects}

List projects across the platform, filter them by owner, or inspect one project's resources:

```sh
void platform project list [--user <user-id>] [--search <text>] [--page <n>] [--limit <n>]
void platform project show <id>
void platform project normalize <id> [--plan | --yes]
void platform project delete <id>
void platform project owner <project-id> <user-id>
void platform project ai-logging <project-id> <inherit|off|metadata|full> [--plan | --yes]
```

Search matches a project's slug, ID, or owner's login. `show` includes resources, domains, the latest 10 deployments, and the latest 20 builds. `delete` removes the project and its resources.

If deployment reports that a project requires normalization, an operator can preview `normalize <id> --plan`, then apply it with `--yes`. It verifies the serving deployment and any recorded queue names before updating project records. It leaves traffic and Cloudflare resources in place and refuses changes while deployment or recovery is active. If a verified queue name differs from the expected delivery routing name, normalization refuses the change; reconcile that queue routing before retrying. If the serving deployment cannot be verified, investigate the reported route before retrying. Finish interrupted deployment recovery on the previous compatible platform runtime before upgrading a project whose active deployment is missing.

`owner` transfers a project to another registered user. Preview it with `--plan`; apply it interactively or with `--yes`. The preview reports active-work blockers and the account plan that will apply. The former owner becomes a project administrator, existing project-scoped CI deploy credentials are revoked, and usage already incurred remains with the former owner.

### AI Gateway Logging

Choose what AI Gateway records for a project. For example, keep request metadata without storing prompts or responses:

```sh
void platform project ai-logging <project-id> metadata --plan
void platform project ai-logging <project-id> metadata --yes
```

Only platform administrators can change the setting. Apps cannot override it.

| Mode       | Logging behavior                                                                      |
| ---------- | ------------------------------------------------------------------------------------- |
| `inherit`  | Follow the owner's plan default, then the gateway's setting. This is the default.     |
| `off`      | No log entry.                                                                         |
| `metadata` | Model, provider, status, token counts, cost, and duration, but no prompt or response. |
| `full`     | A log entry with the prompt and response.                                             |

Each project uses the first setting that applies:

1. The project's `off`, `metadata`, or `full` setting.
2. The [owner's plan default](../../guide/platform/administration/plans.md#ai-gateway-logging). If the plan is missing from the catalog, use the signup default plan.
3. The installation gateway's own logging setting.

Set a project to `inherit` to remove its override and follow that order. A new installation enables gateway logging, so prompts and responses are stored unless a project, plan, or gateway setting disables it. Void does not read the gateway's own setting.

#### Check a Change

Changes apply to new requests without redeploying, normally within 2 minutes after publishing. The command reports the effective setting, its source, and the expected time:

```txt
AI logging for <project-id>: metadata (set on project; plan "pro" default: inherit)
New AI requests are expected to follow it by 14:03:20 UTC (normally within 2 minutes).
```

Run `void platform project show <project-id>` to check progress:

```txt
AI Gateway logging: metadata (from plan "pro") — applied
```

| `state`                | Meaning                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `applied`              | The setting is published and the propagation period has passed. New requests follow it.                                           |
| `pending`              | Published; waiting until the expected time shown.                                                                                 |
| `pending_plan_publish` | The plan default has not reached this project. Run `void platform config plans sync --yes`, or repeat the user's plan change.     |
| `drift`                | The published setting differs from the saved one. Repeat `project ai-logging` to publish it again, or wait for the hourly repair. |
| `unknown`              | Void could not read the published setting. Check again shortly.                                                                   |

Until a change is published, requests keep the previous logging behavior. `show` prints the state in words, such as `pending (expected by 14:03:20 UTC)`. With `--json`, the `aiLogging` object contains:

| Fields                                             | Meaning                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `mode`                                             | Project override, or `inherit`                                                     |
| `planId`, `planKnown`, `defaultPlanId`, `planMode` | Owner's plan, whether it exists, the fallback plan, and the plan's logging default |
| `effective`, `source`                              | Resolved mode and its source: `project`, `plan`, or `gateway`                      |
| `published`, `publishedAt`, `state`                | Published mode, publication time, and progress                                     |

#### What the Setting Covers

The setting covers new Workers AI, Markdown conversion, and provider requests through the platform, including requests from deployed apps and linked projects running `void dev`. It also applies when an app supplies its own provider key.

It does not change requests already running, earlier logs, separately configured Logpush exports, Cloudflare's Unified Billing records, or gateway log retention. AI usage limits still apply in every mode. See [Cloudflare logging controls](https://developers.cloudflare.com/ai-gateway/observability/logging/).

#### Recover from a Failed Change

| Error                           | What to do                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ai_logging_publish_failed`     | The change was not saved. Check the previous setting in the error message, then retry the command.                |
| `ai_logging_publish_pending`    | The change was saved but is not active yet. Retry to publish it.                                                  |
| `ai_logging_policy_unavailable` | An AI request returned HTTP `503` because the platform could not read the setting. Retry the request.             |
| `ai_logging_policy_invalid`     | An AI request returned HTTP `503` because the published setting is invalid. Set the project's logging mode again. |

The platform also repairs unpublished settings every hour. To cancel a saved but pending change, set the previous value again; leaving it pending allows it to take effect later. For an interrupted plan change, [continue the plan updates](../../guide/platform/administration/plans.md#complete-pending-updates).

Project settings require platform 1.8.0 or later. If the CLI reports that the platform does not support them, run `void platform upgrade`.

## Signup Access {#operator-signup}

Inspect signup restrictions, open signup to everyone, or require an allowlist match:

```sh
void platform signup show
void platform signup open
void platform signup restrict
```

Add and remove GitHub or email entries by their type and pattern:

```sh
void platform signup allow <github|email> <pattern> [--note <text>]
void platform signup disallow <github|email> <pattern>
void platform signup remove <github|email> <pattern>
```

`remove` remains available as an alias for existing scripts. GitHub entries match a login. Email entries match an address or a domain pattern such as `*@example.com`, across sign-in providers. Quote wildcard patterns in your shell.

For an OIDC identity that has no verified email, grant access using its configured connection ID and stable provider subject:

```sh
void platform signup allow identity <connection-id> <subject> [--note <text>]
void platform signup disallow identity <connection-id> <subject>
```

Connection IDs are shown by `void platform config auth list`. Identity subjects match exactly and case-sensitively; wildcards, email inference, and account linking are not applied. The login method's domain or group restrictions must still pass, and a newly admitted account has the ordinary user role. Under invited/allowlisted signup, an empty allowlist blocks new accounts. Under company-approved signup, explicit grants admit people in addition to the company rules.

## Invitations {#operator-invitations}

Invite people by email and track whether they have joined:

```sh
void platform invitation list [--page <n>] [--limit <n>]
void platform invitation send <email[,email...]>
void platform invitation revoke <id>
```

Send accepts up to 100 comma-separated addresses. Invitations grant signup access even if email delivery is unavailable or fails; delivery is reported separately. Share the platform's `/invite` page or `void connect '<platform URL>'` command yourself when no email is sent. Revoking a pending invitation removes its exact email grant. A broader domain entry can still allow that person to sign up.
