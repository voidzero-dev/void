---
outline: deep
---

# Platform Configuration {#plan-configuration}

Use your administrator session for these commands. See [Platform Management](./platform.md#operator-commands) for platform selection, previews, and confirmation.

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

Use `--plan` to preview changes and affected accounts; scripted mutations require `--yes`. Every command supports `--connection <slug-or-url>` and `--json`. `show` reports the effective limits, default, assignments, and pending account updates. `reset` restores a built-in plan's original limits and build instance size. Archived plans keep their existing accounts but cannot receive new assignments; change the default before archiving it. `remove` requires a replacement for a plan that has accounts or is the default. Changing the default affects only new accounts.

For `add` and `set`, `--file` reads a JSON object with optional `name`, `limits`, `buildInstanceType`, and boolean `allowShortSlugs`. `limits` is a partial object of nonnegative whole numbers; `0` means unlimited by the plan. Build timeouts remain capped at the platform maximum of 60 minutes; `0` uses that maximum. Omitted settings keep their current values or the copied plan's values. `buildInstanceType` is `standard-3` or `standard-4`. `allowShortSlugs` permits future assignments of project slugs of five characters or fewer; existing URLs remain available. Storage quotas are not editable. See [Plans and Limits](../../guide/platform/administration/plans.md) for supported limits and examples.

An apply checks the preview's revision and rejects concurrent changes. Lower quotas can restrict accounts already above them; usage history and billing periods are preserved. The CLI continues account updates until complete. If an update fails or stops making progress, the configuration remains saved and the command exits unsuccessfully. Run `sync --yes` to continue before editing plans again. Inspect `show` and operator events after an uncertain request outcome.

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
alternative; the last method cannot be disabled. Disabling revokes human sessions
created through that method, including operator sessions. Scoped deployment tokens
remain valid; a human login token used as `VOID_TOKEN` is still revoked.

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
and a human administrator session. They revoke current human sessions. Before
removing protection, change any signup rule that depends on that gate. Cloudflare
applications are retained for deliberate cleanup.

`recover <connection-id>` restores an existing administrator when normal login is
unavailable. Its file contains `administratorUserId`, optional nonsecret provider
`configuration`, and an `expectedIdentity` object with exact `issuer` and `subject`
when using `--yes`. Recovery requires Cloudflare management/database authority,
original recovery keys, and a successful browser provider test. Use
`--client-secret-env <name>` for new or rotated credentials.

For automation, see [operator authentication](./platform.md#operator-authentication).
