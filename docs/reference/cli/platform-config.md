---
description: 'Create and edit platform plans and their limits from an administrator session.'
outline: deep
---

# Platform Configuration {#plan-configuration}

Use your administrator session for these commands. See [Platform Management](./platform.md#operator-commands) for platform selection, previews, and confirmation.

## Plans

`void platform config plans` opens an interactive plan menu using your administrator session. Plans have stable IDs and editable display names. Copy an existing plan to add one, edit limits without redeploying, archive it to stop new assignments, or remove it with an explicit replacement for its accounts.

```sh
void platform config plans show [plan-id]
void platform config plans add <plan-id> --copy <existing-id> --name "Team"
void platform config plans set <plan-id> [--name "Team"] [--file plan.json]
void platform config plans reset <builtin-plan-id>
void platform config plans archive <plan-id>
void platform config plans restore <plan-id>
void platform config plans remove <plan-id> [--replacement <plan-id>]
void platform config plans default <plan-id>
void platform config plans sync
```

Use `--plan` to preview changes and affected accounts, then `--yes` to apply them in a script. Every command supports `--connection <slug-or-url>` and `--json`.

### Inspect and Manage Plans

- `show` reports limits, the signup default, assignments, and pending updates. `show <plan-id>` includes the plan's AI logging default.
- `reset` restores a built-in plan's original limits and build size.
- `archive` stops new assignments while keeping existing accounts. Choose another signup default before archiving the current one.
- `remove` requires a replacement if the plan has accounts or is the signup default.
- `default` chooses the plan for new accounts. It also changes AI logging for accounts whose assigned plan is missing from the catalog.

### Plan Files

For `add` and `set`, `--file` reads a JSON object. All fields are optional; omitted fields keep their current values or the copied plan's values.

| Field               | Values                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `name`              | Display name                                                                                    |
| `limits`            | Partial object of resource limits as nonnegative whole numbers; `0` means unlimited by the plan |
| `buildInstanceType` | `standard-3` or `standard-4`                                                                    |
| `allowShortSlugs`   | `true` permits future project slugs of five characters or fewer; `false` requires longer names  |
| `aiLogging`         | `off`, `metadata`, or `full`; `inherit` clears the plan's override                              |

Build timeouts have a platform maximum of 60 minutes; `0` uses that maximum. Storage quotas are not editable. Changing `allowShortSlugs` preserves existing URLs. See [Plans and Limits](../../guide/platform/administration/plans.md) for the supported limits and file examples, and [AI Gateway logging](./platform-users.md#ai-gateway-logging) for logging modes.

### Apply and Resume Changes

If someone changes the plans after your preview, create a new preview before applying. Lower quotas can restrict accounts already above them. Usage history and billing periods stay unchanged.

The CLI updates affected accounts and publishes AI logging defaults, then reports when new AI requests are expected to follow them. If updates fail or stop making progress, the command exits with a nonzero status and the configuration stays saved. Run `void platform config plans sync --yes` to continue before editing plans again. After a lost connection, inspect `show` and [operator events](../../guide/platform/administration/operations.md) before retrying.

## Authentication configuration {#authentication-configuration}

`void platform config auth` opens interactive configuration. These commands use
your administrator session from `void platform auth login`:

```sh
void platform config auth list
void platform config auth show company
void platform config auth add google
void platform config auth add oidc --id company
void platform config auth add cloudflare-access --id access
void platform config auth configure company
void platform config auth test company
void platform config auth link company
void platform config auth enable company
void platform config auth disable github
void platform config auth admission
void platform config auth protection show
void platform config auth protection enable --installation <id>
void platform config auth protection disable --installation <id>
void platform config auth recover company --installation <id> --file recovery.json
```

When configuring an existing installation for the first time, run
`void platform config auth initialize`, then sign in again. Its current login
methods and signup policy are preserved.

Adding or editing a method saves a pending configuration. Enabling it verifies the
login in your browser before applying it. Linking the verified identity to your
account is a separate, explicit action. Before disabling a method, verify a linked
alternative; the last method cannot be disabled. Disabling a method signs out
users who logged in through it, including administrators. Scoped deployment tokens
remain valid; a login token used as `VOID_TOKEN` is revoked.

Commands accept `--connection <slug-or-url>` and `--json`. Changes accept
`--plan` or `--yes`. For scripted configuration, use `--file <path>` for the
nonsecret fields and `--client-secret-env <name>` for the environment variable
containing the secret. Omit the secret when editing to retain its saved value.
For `enable` or `link` in scripts, supply `--test-id <id>` from a completed test.
`test --json` returns a browser URL, test ID, and expiry without waiting for completion.

`admission` chooses invited/allowlisted, company-approved, or public signup.
Company-approved signup creates ordinary accounts automatically when a user
passes a configured company rule. Select an enabled, company-restricted OIDC or
Google Workspace method, or an enabled Cloudflare Access gate. In scripts,
`admission --file <path> --yes` reads a policy such as
`{"mode":"company","connections":["company"],"access":false}`.

`protection enable` creates or connects Cloudflare Access applications independently
of login methods. Its `--file` accepts the `cloudflareAccess` object described in
[installation setup](../../guide/platform/installation/setup.md#choose-login-methods).
Protection changes require installation ownership, the saved recovery credentials,
and a signed-in administrator. They sign out all users. Before
removing protection, change any signup rule that depends on that gate. Cloudflare
applications are retained for deliberate cleanup.

`recover <connection-id>` restores an existing administrator when normal login is
unavailable. Its file contains `administratorUserId`, optional nonsecret provider
`configuration`, and an `expectedIdentity` object with exact `issuer` and `subject`
when using `--yes`. Recovery requires Cloudflare management/database authority,
original recovery keys, and a successful browser provider test. Use
`--client-secret-env <name>` for new or rotated credentials.

For automation, see [operator authentication](./platform.md#operator-authentication).
