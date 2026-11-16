---
description: 'Define resource limits for accounts on your platform. Plans do not bill users or purchase Cloudflare services.'
outline: deep
---

# Plans and Limits

Plans define the resource limits you assign to accounts on your platform. They do not bill users or purchase Cloudflare services. Sign in with an administrator account and open **Plans** in the administration dashboard, or use the CLI:

```sh
void platform auth login
void platform config plans
```

Choose a plan to inspect or edit it, copy one into a new plan, or choose the default for new accounts. Changes require no app or platform redeploy.

## Use the Dashboard

Open **Plans** to see each plan's stable ID, account count, and signup default. Choose **Add plan** to copy an existing plan, or **Edit** to change its display name, limits, build size, permission to use short project slugs, and [AI Gateway logging default](#ai-gateway-logging).

Choose **Review changes** to compare the current and proposed settings and see how many accounts are affected. Review any quota warnings, then choose **Apply changes**. If someone changed the catalog while you were reviewing, open the plan again and create a fresh review.

The edit page also lets you choose the signup default, archive or restore assignments, reset a built-in plan, or remove a plan with an active replacement. Every action has a review step.

Account updates continue automatically on the result page. If you leave the page or an update pauses, open **Plans** and choose **Continue account updates**. Finish pending account updates before changing plans again. Recorded usage and billing periods are preserved.

## Add a Plan

Each plan has a stable ID and an editable display name. Copy a plan to start with its limits, build size, short-slug permission, and AI logging default:

```sh
void platform config plans add team --copy pro --name "Team" --plan
void platform config plans add team --copy pro --name "Team" --yes
```

Assign it to an existing account or make it the default for new accounts:

```sh
void platform user plan <user-id> team --yes
void platform config plans default team --yes
```

Changing the default does not move existing accounts. Renaming a plan does not change its ID or assignments.

## Edit Limits

The interactive menu lets you change one limit at a time. For scripts or several changes, create a JSON file:

```json
{
  "name": "Team",
  "limits": {
    "requestsPerMonth": 10000000,
    "concurrentBuilds": 3,
    "buildTimeoutMinutes": 15
  },
  "buildInstanceType": "standard-4"
}
```

Omitted settings keep their current values. Preview, then apply:

```sh
void platform config plans set team --file team-plan.json --plan
void platform config plans set team --file team-plan.json --yes
```

Limits are nonnegative whole numbers; `0` means unlimited by the plan. Build timeouts always have a platform maximum of 60 minutes; `0` uses that maximum. You can configure:

| Setting                         | Limit                                             |
| ------------------------------- | ------------------------------------------------- |
| `requestsPerMonth`              | Application requests per account billing month    |
| `cpuMsPerRequest`               | Default CPU milliseconds per application request  |
| `maxCpuMsPerRequest`            | Highest CPU limit an application can request      |
| `subRequestsPerInvocation`      | Subrequests per invocation                        |
| `deploysPerDay`                 | Deployments per day                               |
| `aiNeuronsPerMonth`             | AI neurons per account billing month              |
| `retainedDeployments`           | Retained Worker deployments                       |
| `sandboxRuntimeSecondsPerMonth` | Sandbox runtime seconds per account billing month |
| `sandboxMaxConcurrentInstances` | Simultaneous Sandbox instances                    |
| `concurrentBuilds`              | Simultaneous builds                               |
| `buildTimeoutMinutes`           | Build timeout in minutes                          |

`cpuMsPerRequest` cannot exceed `maxCpuMsPerRequest`. An unlimited default CPU limit requires an unlimited ceiling. Build instance sizes are `standard-3` (2 vCPU, 8 GiB) and `standard-4` (4 vCPU, 12 GiB). New builds use the new size and timeout; running builds keep their recorded settings.

Advanced files can also set `"allowShortSlugs": true` to permit project slugs of five characters or fewer, or `false` to require longer slugs for future changes. Existing project URLs are preserved. Copying a plan inherits this setting; the built-in `free` plan disables it and the other built-in plans enable it.

Storage figures shown for D1, R2, and KV are informational and cannot be edited as enforced quotas. Static deployments keep their existing retention policy.

The preview shows the affected account count and checks a sample for accounts already above a proposed quota. Lowering a quota can restrict existing apps, including accounts outside that sample. Usage history and billing periods are preserved, so a plan change does not reset usage. Manual administrator suspensions remain in effect.

## AI Gateway Logging {#ai-gateway-logging}

Set a plan's AI logging default to control what AI Gateway records for its projects. In the dashboard, edit the plan's **AI Gateway logging default**. From the CLI, add `aiLogging` to a plan file:

```json
{
  "aiLogging": "metadata"
}
```

```sh
void platform config plans set team --file team-plan.json --plan
void platform config plans set team --file team-plan.json --yes
```

`metadata` keeps request details without prompts or responses. Use `off` for no log entries, `full` to include prompts and responses, or `inherit` to follow the gateway's own setting. A new installation's gateway logs prompts and responses. See [AI Gateway logging](../../../reference/cli/platform-users.md#ai-gateway-logging) for the full scope of these settings.

Leaving `aiLogging` out preserves the plan's current value. A project's [own logging setting](./projects.md#ai-logging) overrides its plan default. If an account's plan is missing from the catalog, it follows the signup default plan.

The preview shows the old and new defaults and how many projects are affected. After applying, the CLI publishes the change and reports when new requests are expected to use it:

```txt
AI logging published to 120 projects; expected by 14:03:20 UTC (normally within 2 minutes).
```

Projects keep their previous logging behavior until the new setting is published. Changes normally reach new requests within 2 minutes after publishing. Check a project with `void platform project show <project-id>`.

If publishing stops, run `void platform config plans sync --yes`, or choose **Continue AI logging publish** on the **Plans** page. The platform also resumes unfinished work every hour.

Moving an account to another plan, replacing a removed plan, or transferring a project applies the new owner's plan default. Changing the signup default also changes logging for accounts whose plan is missing from the catalog.

Inspect a plan's default with `void platform config plans show <plan-id>` or the dashboard's user detail page. If the CLI reports that your platform does not support plan defaults, run `void platform upgrade` first.

## Archive or Remove a Plan

Archive a plan to stop assigning it to new accounts while preserving its current accounts:

```sh
void platform config plans archive team --yes
void platform config plans restore team --yes
```

Choose another default before archiving the current default. To remove a plan with accounts, choose a replacement and review the changes first:

```sh
void platform config plans remove team --replacement pro --plan
void platform config plans remove team --replacement pro --yes
```

Removing the default also requires a replacement. An unused plan that is not the default can be removed without one. Accounts keep their usage when moved to a replacement plan. Restore the original limits and build size of a built-in plan with `void platform config plans reset <plan-id>`; custom plans have no built-in reset values.

The removal review shows the replacement plan and any changes to its limits, build size, and short-slug permission before you confirm.

## Complete Pending Updates

After applying a change, the CLI updates accounts and publishes AI logging defaults. If an update fails or stops making progress, your configuration stays saved and the command reports pending work with a nonzero exit status. Inspect the plans, then continue:

```sh
void platform config plans show
void platform config plans sync --yes
```

`sync` resumes the saved updates. Finish pending work before editing plans again. If a request loses its connection, inspect the plans and [operator events](/guide/platform/administration/operations) before retrying it.

All commands accept `--connection <registered-id-or-url>` and `--json`. Scripted changes require `--yes`; use `--plan` for a read-only preview.
