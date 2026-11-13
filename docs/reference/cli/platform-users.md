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

Suspending a user blocks their applications, including scheduled jobs and queue consumers. While the account is suspended, each queue message is retried about once an hour, and each retry uses one of its queue's retries. Messages that run out of retries are dropped: after about 3 hours with the default of 3 retries, and at once for a queue with `maxRetries: 0`. Restore an account suspended by mistake promptly; queue delivery resumes within about an hour. Deleting a user also deletes their project resources. A plan change updates resource limits while preserving any administrator suspension. It also applies the new plan's [AI Gateway logging](#ai-gateway-logging) default to the account's projects, up to 100 projects per run. If the account has more, or if that step fails, the command says so; run the same plan change again until it completes. Each run continues where the last one stopped.

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

Administrators choose how AI Gateway logs a project's AI requests. Apps cannot change this setting.

| Mode       | AI Gateway stores                                                                     |
| ---------- | ------------------------------------------------------------------------------------- |
| `inherit`  | Whatever the gateway is set to. This is the default.                                  |
| `off`      | No log entry.                                                                         |
| `metadata` | Model, provider, status, token counts, cost, and duration, but no prompt or response. |
| `full`     | A log entry with the prompt and response.                                             |

`inherit` follows the installation gateway's own logging setting, which the platform does not read. A new installation creates its gateway with logging turned on, so `inherit` stores prompts and responses until you change the gateway in Cloudflare.

Each project uses the first setting that applies:

1. The project's own setting, from `void platform project ai-logging`.
2. The default of the owner's plan. See [Plans and Limits](../../guide/platform/administration/plans.md#ai-gateway-logging). An account whose plan is not in the catalog uses the default plan's setting.
3. `inherit`.

Preview a change, then apply it:

```sh
void platform project ai-logging <project-id> metadata --plan
void platform project ai-logging <project-id> metadata --yes
```

The preview shows the current and new setting. The result names the setting, where it comes from, and when new requests are expected to follow it:

```txt
AI logging for <project-id>: metadata (set on project; plan "pro" default: inherit)
New AI requests are expected to follow it by 14:03:20 UTC (normally within 2 minutes).
```

Set the project back to `inherit` to remove its own setting and use the plan default again. Changes apply to new requests without redeploying.

`void platform project show <project-id>` reports the setting and whether it is applied:

```txt
AI Gateway logging: metadata (from plan "pro") — applied
```

| `state`                | Meaning                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `applied`              | New AI requests follow the setting.                                                                                                              |
| `pending`              | The setting is published. New requests are expected to follow it by the time shown.                                                              |
| `pending_plan_publish` | The plan default is still being published. Run `void platform config plans sync --yes`, or repeat the account's `user plan` change, to continue. |
| `drift`                | The published setting differs from the saved one. An hourly check repairs it; to fix a project setting now, run `project ai-logging` again.      |
| `unknown`              | The published setting could not be read. Check again shortly.                                                                                    |

`show` prints the state in words, such as `pending (expected by 14:03:20 UTC)`. With `--json`, `aiLogging` holds `mode` (the project's own setting, or `inherit`), `planId`, `planKnown`, `defaultPlanId`, `planMode`, `effective`, `source` (`project`, `plan`, or `gateway`), `published`, `publishedAt`, and `state`.

#### What the Setting Covers

When an administrator sets a project's AI logging to `off` or `metadata`, the command prints the time by which new requests are expected to follow it (normally within 2 minutes). `void platform project show <project-id>` reports `applied` once that time has passed and the setting is published. From then on, for every new AI request the platform runs for that project (Workers AI calls, Markdown conversion and provider calls, from deployed Workers and from `void dev`), AI Gateway stores:

- `off`: no log entry.
- `metadata`: model, provider, status, token counts, cost and duration, but no prompt or response.

A plan default applies to a project once the plan change reports "AI logging published", then normally within 2 minutes.

If the platform cannot read the published setting, it refuses the AI request with status 503. `ai_logging_policy_unavailable` is temporary; the app can retry. `ai_logging_policy_invalid` means the published value is not valid; set the project's AI logging again. Until a change is published, the project keeps its previous behavior. `show` reports this as `pending_plan_publish` (a plan default not yet published to the project) or `drift` (a published setting that differs from the saved one). `pending` means the change is already published and is still reaching every location. On a new installation the previous behavior is full logging.

Not covered: requests already running, logs stored earlier, separately configured Logpush exports, billing details that Cloudflare always keeps for Unified Billing requests, and log retention, which Cloudflare sets per gateway. AI usage limits still apply in every mode. See [Cloudflare logging controls](https://developers.cloudflare.com/ai-gateway/observability/logging/).

If the command fails with `ai_logging_publish_failed`, this change was not saved; the message names the project setting that is still saved. With `ai_logging_publish_pending`, the setting was saved but not published, and the project keeps its previous behavior until it is. In both cases, run the same command again. A saved setting that is not published yet goes live at the next hourly repair even if you do not retry, so to cancel a pending change, set the previous value again.

Project settings need platform 1.8.0 or later. On an older platform, the CLI stops with "This platform does not support AI logging policies. Run `void platform upgrade`."

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
