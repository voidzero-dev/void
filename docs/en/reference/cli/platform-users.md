---
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

Suspending a user blocks their applications, including scheduled jobs and queue consumers. While the account is suspended, each queue message is retried about once an hour, and each retry uses one of its queue's retries. Messages that run out of retries are dropped: after about 3 hours with the default of 3 retries, and at once for a queue with `maxRetries: 0`. Restore an account suspended by mistake promptly; queue delivery resumes within about an hour. Deleting a user also deletes their project resources. A plan change updates resource limits while preserving any administrator suspension.

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
```

Search matches a project's slug, ID, or owner's login. `show` includes resources, domains, the latest 10 deployments, and the latest 20 builds. `delete` removes the project and its resources.

If deployment reports that a project requires normalization, an operator can preview `normalize <id> --plan`, then apply it with `--yes`. It verifies the serving deployment and any recorded queue names before updating project records. It leaves traffic and Cloudflare resources in place and refuses changes while deployment or recovery is active. If a verified queue name differs from the expected delivery routing name, normalization refuses the change; reconcile that queue routing before retrying. If the serving deployment cannot be verified, investigate the reported route before retrying. Finish interrupted deployment recovery on the previous compatible platform runtime before upgrading a project whose active deployment is missing.

`owner` transfers a project to another registered user. Preview it with `--plan`; apply it interactively or with `--yes`. The preview reports active-work blockers and the account plan that will apply. The former owner becomes a project administrator, existing project-scoped CI deploy credentials are revoked, and usage already incurred remains with the former owner.

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
