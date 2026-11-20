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
void platform security models --provider <openai|anthropic> (--key-stdin | --remove-key) [--plan] [--yes]
void platform security limits [--concurrency <n>] [--scan-timeout <minutes>] [--plan] [--yes]
void platform security budget [--platform-usd <n> | --platform-off] [--project-default-usd <n> | --project-caps <on|off>] [--plan] [--yes]
void platform security budget --project <project-id> (--usd <n> | --clear) [--plan] [--yes]
void platform security model <project-id> <model-id|--default> [--accept-provider-notice] [--plan] [--yes]
```

A model run by a third party needs its provider notice accepted with `--accept-provider-notice`. `--provider <name> --key-stdin` saves your own OpenAI or Anthropic API key, read from standard input, for that provider's models; pipe it from your password manager and add `--yes`. Void makes a 1-token test call with the key and saves it only if the call works. `--remove-key` deletes it. See [Use your own provider key](/guide/platform/administration/security-audits#own-provider-key). `budget` with no flags shows the caps and this month's spend; with a cap flag it changes them. `--platform-usd` sets the platform cap and turns it on. `--project-default-usd` sets the default cap for every project and turns project caps on; `--project-caps off` removes it. `--project <id> --usd <n>` sets the most that project's admins may give it, and `--clear` removes that limit. A lower cap that a project admin set for their own project still applies. Without a project limit, a project gets the [plan cap](./platform-config.md#plans) of its owner's plan, then the default.

## Findings and scans {#findings-scans}

```sh
void platform security findings [--project <id-or-slug>] [--urgent] [--state <open|resolved|all>] [--severity <level>] [--format sarif]
void platform security show <project-id> <finding-id,...>
void platform security resolve <project-id> <finding-id,...> --reason <fixed|false-positive|accepted-risk> --comment "<text>" [--yes]
void platform security reopen <project-id> <finding-id,...> --comment "<text>" [--yes]
void platform security comment <project-id> <finding-id,...> "<text>" [--yes]
void platform security scans [--project <id-or-slug>] [--status <status>] [--trigger gate]
void platform security rescan <project-id> [--client-assets] [--yes]
void platform security backfill [--plan] [--yes]
void platform security sweeps <on|off> [--every-days <n>] [--plan] [--yes]
void platform security fallback <on|off> [--plan] [--yes]
void platform security cancel <scan-id> [--yes]
```

Lists show one page at a time; use `--limit` (up to 100) and `--page`. Findings list the oldest first. `findings --format sarif` prints every matching finding, across projects, as one SARIF 2.1.0 file (up to 10,000 findings); it does not take `--limit` or `--page`. Name several findings with commas to change them together; they are checked before any change is made.

`rescan` runs a full scan of the live deployment. It tells you which model it uses and the most it can cost, then asks before it starts. Monthly caps apply to rescans too. `--client-assets` also reviews the sources of the project's client bundles from the source maps deployed with them. Project admins can start the same scan with `void project security scan`.

Turning security audits on scans nothing that is already live. `backfill` scans each live deployment in scope that has never been scanned, up to 50 projects at a time; run it again for the rest. `--plan` shows how many projects it reaches and the most the scans can cost. A deployment whose code is no longer stored cannot be scanned; the preview counts these, and the next deploy of each project scans it.

`sweeps on` reviews every live app in full on a schedule, with a deeper review than a deploy scan: a project is swept when it has had no full scan for `--every-days` days (7 to 90, default 30). A few sweeps start each hour, so deploy scans keep moving. Projects whose live code is no longer stored are not swept until they deploy again. Sweeps are off by default; each one costs more than a deploy scan, and the monthly caps apply.

`fallback on` scans a deployment once more on the `@cf` default model when a scan on a third-party model is refused, returns output that cannot be read, or times out. That scan keeps the code on Cloudflare and covers the same changes. It never switches from a `@cf` model to a third-party one. Fallback is off by default; each fallback scan costs one more scan, and the monthly caps apply.

## Alerts, summary, and webhook {#alerts}

```sh
void platform security digest <on|off> [--plan] [--yes]
void platform security webhook <https-url|off> [--plan] [--yes]
```

When three scans of a project in a row do not succeed for a project reason (refused, unreadable output, timed out, or incomplete), the project owner, its admins, and every installation admin get one email for that run of failures. When more than 20% of the scans in the last 24 hours fail for a platform reason (no AI credits, a scanner error, or a long queue), installation admins get one email that day.

`digest on` sends installation admins a weekly email each Monday with the counts for the week before: scans, new and resolved findings, urgent findings still open, and public requests. It is off by default.

`webhook` sends each security event to an `https` URL as a signed JSON body that holds ids and counts only, never titles, file paths, or code. Setting the URL shows a signing secret once; setting it again makes a new secret. Each request has an `X-Void-Event` type such as `security.findings`, an `X-Void-Delivery` id that stays the same on retries, and `X-Void-Signature: t=<seconds>,v1=<hex>`, where `t` is the send time and `v1` the HMAC-SHA256 of `<t>.<body>` with the secret. A request that does not answer 2xx within 10 seconds is retried twice. Webhooks are sent even when platform email is off.

## Scan before a project goes public {#public-gate}

With [project Zero Trust](./platform-zero-trust.md) on, you can hold a project's change from protected to public until a scan passes:

```sh
void platform security public-gate <on|off> [--plan] [--yes]
void platform security public-requests [--project <id-or-slug>] [--state <open|closed|all>]
void platform security bypass <project-id> --reason "<text>" [--yes]
void platform security bypasses [--project <id-or-slug>]
```

`public-gate on` is refused while platform Zero Trust is off. A bypass skips the scan, never an open urgent finding, and is recorded with its reason.
