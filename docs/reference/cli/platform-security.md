---
description: 'Turn security audits on, choose a scan mode and model, set monthly spending caps, and handle findings and public requests from an administrator session.'
outline: deep
---

# Platform Security Audits {#operator-security}

Use your administrator session for these commands. See [Platform Management](./platform.md#operator-commands) for platform selection, previews, and confirmation. Projects are named by id; `--project` filters also accept a slug.

## Turn security audits on {#enable}

Security audits need Cloudflare Containers and Workers AI on the platform's Cloudflare account. Allow them when you install or upgrade:

```sh
void platform install --security-audits [options]
void platform upgrade [id] --security-audits
void platform repair [id] --security-audits
```

This allows the feature and nothing more. No project is scanned until you set a scan mode. The runtime token needs the Containers permissions that the token page lists. Uninstalling the platform also deletes the scanner, its container applications, and the scanner images it copied.

Then check the account and choose a mode:

```sh
void platform security probe
void platform security policy <disabled|public|all> [--plan] [--yes]
void platform security status
```

`probe` checks that the account can run scans and reports each missing requirement. `policy` selects which projects are scanned, and `--plan` shows how many projects the change reaches. Turning the mode on runs the probe first and refuses when it fails.

## Models, limits, and spending {#models-limits-budget}

```sh
void platform security models [--default <id>] [--block <id,...>] [--unblock <id,...>] [--accept-provider-notice] [--plan] [--yes]
void platform security limits [--concurrency <n>] [--scan-timeout <minutes>] [--plan] [--yes]
void platform security budget [--platform-usd <n> | --platform-off] [--project-default-usd <n> | --project-caps <on|off>] [--plan] [--yes]
void platform security budget --project <project-id> (--usd <n> | --clear) [--plan] [--yes]
void platform security model <project-id> <model-id|--default> [--accept-provider-notice] [--plan] [--yes]
```

A model run by a third party needs its provider notice accepted with `--accept-provider-notice`. `budget` with no flags shows the caps and this month's spend; with a cap flag it changes them. `--platform-usd` sets the platform cap and turns it on. `--project-default-usd` sets the default cap for every project and turns project caps on; `--project-caps off` removes it. `--project <id> --usd <n>` sets the most that project's admins may give it, and `--clear` removes that limit. A lower cap that a project admin set for their own project still applies.

## Findings and scans {#findings-scans}

```sh
void platform security findings [--project <id-or-slug>] [--urgent] [--state <open|resolved|all>] [--severity <level>]
void platform security show <project-id> <finding-id,...>
void platform security resolve <project-id> <finding-id,...> --reason <fixed|false-positive|accepted-risk> --comment "<text>" [--yes]
void platform security reopen <project-id> <finding-id,...> --comment "<text>" [--yes]
void platform security comment <project-id> <finding-id,...> "<text>" [--yes]
void platform security scans [--project <id-or-slug>] [--status <status>] [--trigger gate]
void platform security rescan <project-id> [--yes]
void platform security cancel <scan-id> [--yes]
```

Lists show one page at a time; use `--limit` (up to 100) and `--page`. Findings list the oldest first. Name several findings with commas to change them together; they are checked before any change is made.

`rescan` runs a full scan of the live deployment. It tells you which model it uses and the most it can cost, then asks before it starts. Monthly caps apply to rescans too.

## Scan before a project goes public {#public-gate}

With [project Zero Trust](./platform-zero-trust.md) on, you can hold a project's change from protected to public until a scan passes:

```sh
void platform security public-gate <on|off> [--plan] [--yes]
void platform security public-requests [--project <id-or-slug>] [--state <open|closed|all>]
void platform security bypass <project-id> --reason "<text>" [--yes]
void platform security bypasses [--project <id-or-slug>]
```

`public-gate on` is refused while platform Zero Trust is off. A bypass skips the scan, never an open urgent finding, and is recorded with its reason.
