---
description: 'Run an AI security review of each deploy on your Void platform, choose which projects and models it covers, cap its cost, and hold a project private until a scan passes.'
outline: deep
---

# Security Audits

Security audits run an AI review of the code that changed in each deploy, and report serious problems to the people who own the project. The scan starts after the deploy is live. A scan or a finding never blocks, delays, or fails a deploy.

AI review can be wrong. "No findings" means nothing was found, not that the code is safe. Treat it as a second pair of eyes next to human review.

This feature is off until you turn it on. Projects deployed directly to Cloudflare are not affected.

## Requirements

- A platform installed or upgraded with `--security-audits`. See [Turn security audits on](/reference/cli/platform-security#enable).
- Workers Paid on the platform's Cloudflare account, with Cloudflare Containers.
- Workers AI access for the default model: Workers Paid or prepaid AI credits.
- For the optional scan before a project goes public, [project Zero Trust](./zero-trust.md) must be on and not public-only.

The scanner runs in its own container with no internet access and reaches models only through the platform. Uninstalling the platform removes it. See [Disable and Uninstall](/guide/platform/installation/uninstall).

::: warning Roll forward after you upgrade
The upgrade that adds security audits includes a database migration for the scan scheduler. Cloudflare does not roll a Worker back past such a migration, so after you upgrade, fix a bad release by deploying a newer one.
:::

## Turn it on

```sh
void platform upgrade --security-audits
void platform security probe
void platform security budget --platform-usd 500
void platform security policy public
```

The probe checks that the account can run scans and names anything missing. Spending caps are off by default, so set a [platform cap](#spending-caps) before you choose a mode. Turning a scan mode on runs the probe first and refuses when it fails. The probe runs again each day while scans are on; if it starts failing, the policy stays on, new deploys are not scanned, and the admin pages show a banner.

| Mode                 | Scans                                                           |
| -------------------- | --------------------------------------------------------------- |
| Off (default)        | Nothing                                                         |
| Public projects only | Projects that are public, or that have no Zero Trust protection |
| All projects         | Every project                                                   |

A mode change scans nothing right away. Each project is scanned at its next deploy: the first scan reviews the whole deployment, later scans what changed since the last good scan. Use `--plan` to preview how many projects a change reaches. To scan apps that are already live, see [Scan live apps again](#scan-live-apps).

A platform admin can give one project its own rule, from the project's **Security** section in the administrator UI or with `void platform security policy --project <project-id> <inherit|always|never>`:

| Rule              | Scans                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| inherit (default) | What the scan mode says                                                 |
| always            | Every deploy, also while Zero Trust protects the project                |
| never             | Nothing, except the scan before the project goes public when that is on |

A project's rule has no effect while the mode is Off. Its project page and `void project security status` say why the project is or is not scanned. Platform administrators can manage all of this from **Security** in the administrator UI.

## What is scanned

A scan starts when a deploy goes live. Rollbacks, failed deploys, and `preview-*` projects are not scanned. A newer deploy replaces a scan that is still queued. A redeploy with no code change is recorded as "no changes" and costs nothing.

Void reviews the source that changed when it can see it, and otherwise the built output mapped back to source. Third-party package code, lockfiles, binaries, and secret-like files are left out, and stored secret values are replaced before any model sees the code. Void tells registry packages from your code by the project's `pnpm-lock.yaml` or `package-lock.json`; without one, package code is reviewed too and the result notes `third-party-unverified`. Each result states what it covered, such as `Changes since dpl_7c20 · source diff · 14 files · complete`. Large changes are scanned in parts, and the page shows the files still waiting.

### Check code before you deploy

Developers who can deploy a project can scan their code first with `void project security check`. It sends the git-tracked files of the current folder, as they are on disk; untracked files, secret-like files, lockfiles, and binaries stay on the machine. It shows what it sends, which model reviews it, and the most it can cost, then asks before it uploads. It needs the policy to apply to the project (not the `never` rule), waits in the queue like any scan, and counts toward the caps. The result shows in the terminal and is kept for 30 days. It is not saved as project findings, sends no email, and does not affect a request to go public. See [`void project security check`](../../../reference/cli/project.md#void-project-security).

## Models and the provider notice

| Model                                                | Run by     |
| ---------------------------------------------------- | ---------- |
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (default) | Cloudflare |
| `@cf/zai-org/glm-5.3`                                | Cloudflare |
| `openai/gpt-6.1-terra`, `openai/gpt-6.1-sol`         | OpenAI     |
| `anthropic/claude-sonnet-5.5`                        | Anthropic  |
| `anthropic/claude-opus-5.5`                          | Anthropic  |

A model run by a third party sees the project's changed code, the files it uses, and past findings and comments. The provider may keep request data for a limited time and may refuse security-looking code; a refused scan shows as refused, never as passed. So code does not go to a third party until someone accepts the notice: you once for a third-party platform default, and a project owner or administrator once per project. Until then the project uses a Cloudflare model. To keep all code in Cloudflare, block the third-party models.

A third-party model also needs an AI permission on the platform's runtime token, unless you [saved your own key](#own-provider-key). See [Permissions to select for each token](/guide/platform/installation/credentials). The probe names a missing permission and lists models that cannot be picked yet. For these models the probe also copies a scanner image into the account's container registry, which can take more than one probe run; a provider whose models are all blocked gets no copy.

Project owners and administrators pick their project's model from the same list with `void project security model`.

### Use your own provider key {#own-provider-key}

By default, OpenAI and Anthropic models are paid from the account's [AI Gateway Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) credits. To bill your own key and agreement with the provider instead:

```sh
printf "%s" "$ANTHROPIC_API_KEY" | void platform security models --provider anthropic --key-stdin --yes
void platform security probe
```

Void saves the key, encrypted, only if a 1-token test call with it works. Calls still go through AI Gateway, are metered at list price, and count toward the [spending caps](#spending-caps). Run the probe after saving if that provider's models could not be picked before. Saving a new key replaces the old one. `--remove-key` deletes it: scans go back to Unified Billing, and the models cannot be picked until the probe passes again. `void platform security status` shows which keys are saved, never the key.

## Findings

Only a human closes a finding. A scan can add one, confirm it again, or reopen it, never close it. Resolve a finding as fixed, false positive, or accepted risk, with a comment of up to 4,000 characters. The comment and resolution feed the next scan, so the same false alarm does not come back. Comments never hide anything; only a false-positive resolution does.

A finding is **urgent** when it is confirmed, critical or high, and still open. Leads and lower severities are never urgent.

A project admin or the owner can change the severity of an open finding, with a comment: `void project security severity F-12 medium --comment "Only reachable by admins"`. The new severity sticks across scans; lowering a critical or high finding takes it out of the urgent count, as a resolve does.

When a project secret's value appears, as is or encoded, in the deployed Worker code or a static text file (`.js`, `.html`, `.json`, `.css`, `.txt`, up to 8 MB), the platform reports a `secret-in-output` finding that names the secret but never shows its value, one per secret for static files and one for Worker code. In a static file it is high and urgent, since anyone can download it once the project is public: rotate the secret and keep it on the server. In Worker code it is medium: read it from `env` instead. A value meant to be public, such as a publishable key, can be resolved as accepted risk; it stays resolved when later deploys change the bundle.

With a Cloudflare model, a scan can test a possible finding on a throwaway copy of the deployment: the same code with empty databases, fake secrets, and no internet access, reachable only by the scanner and deleted when the scan ends. Such a finding shows as `confirmed (runtime)` in `void project security show`. The copy is part of the scan cost.

| Who sees what                   | Reader | Collaborator and up |
| ------------------------------- | ------ | ------------------- |
| Urgent count and finding ids    | Yes    | Yes                 |
| Titles, files, and details      | No     | Yes                 |
| Scans, cost, and bypass reasons | No     | Yes                 |

Open urgent findings show:

- at the end of each `void deploy` to a Void platform, with titles only for a signed-in user who can deploy (CI runs and readers see counts and ids),
- in `void project security status`, and as a `Security` line in `void project status`,
- on the project's security page (`void project security open`), where collaborators and up can comment, and the owner and project admins can also resolve, pick the model, set the budget, and bypass a held public request. A platform with the user dashboard has the same page behind **Security** on its **Projects** list,
- on GitHub, for deploys built from a [connected repository](#github-checks),
- in the administrator UI, with an **Urgent** filter.

Export findings as SARIF with `void project security list --format sarif` (or `void platform security findings --format sarif` for every project).

A scan that does not succeed says what happened, and the next scan covers those changes. A refused, timed-out, or failed scan is never counted as clean.

## Scan live apps again {#scan-live-apps}

These scans review more than a deploy scan. Each costs money and counts toward the [spending caps](#spending-caps):

| To                                                      | Run                                                                           | Who                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Scan one project's live deployment in full now          | `void project security scan`, or `void platform security rescan <project-id>` | Project owner or admin, or a platform administrator |
| Scan live apps deployed before security audits were on  | `void platform security backfill`                                             | Platform administrators                             |
| Review every live app in full on a schedule             | `void platform security sweeps on --every-days 30`                            | Platform administrators                             |
| Scan again on Cloudflare when a third-party model fails | `void platform security fallback on`                                          | Platform administrators                             |

A full scan names its model and the most it can cost, then asks first. Add `--client-assets` to also review the client bundles' sources, from the source maps deployed with them. Backfill handles up to 50 projects at a time; run it again for the rest. Only a few sweeps start each hour, so deploy scans keep moving. Fallback scans the same changes once more on the default `@cf` model when a third-party model refuses, times out, or returns unreadable output; it never sends code from a `@cf` scan to a third party. Sweeps and fallback are off by default. A deployment whose code is no longer stored cannot be scanned again until the project deploys. See [Findings and scans](/reference/cli/platform-security#findings-scans).

## GitHub checks {#github-checks}

Each scan of a deploy built from a repository connected with `void github connect` (either executor) adds a `Void Security Audit` check to the commit. A `void deploy` from a terminal or an unconnected CI job gets none. The check is always **neutral**, so it never blocks a merge, and shows only the urgent count and a link to the project's security page, because anyone who can see the repository can read it. A scan that did not finish says so.

While an urgent finding is open, each open pull request for that commit (up to five) gets one comment with the same counts, updated in place by later scans. The comment needs the GitHub App's **Pull requests: Read and write** permission; with read-only access, only the check is posted.

**Re-run** on the check starts a full rescan of the live deployment when the person who clicks it signs in to the platform with that GitHub account and is the project's owner or an admin. Otherwise, or on a check of an older deployment, it does nothing. **Re-run all** reruns the build.

## Spending caps

The platform pays for scans; they do not count against the plan's AI limits. Two monthly caps (calendar month, UTC) are off by default:

- A **platform cap** that stops all scans when it is used up.
- A **project cap**, with a default for every project. A project owner or administrator can set a lower cap for their project, up to the limit you give that project, else the owner's plan cap, else the default when project caps are on.

A scan starts only if its worst case fits under both caps. A used-up cap skips scans, never deploys, and the first scan after the reset or a raise covers what was skipped. Rescans and scans before public count too. The Scans page in the administrator UI shows the metered cost next to what AI Gateway reports about an hour later. At 80% and 100% of a cap, the owner and project administrators (project cap) or platform administrators (platform cap) get one email per month.

```sh
void platform security budget --platform-usd 500 --project-default-usd 50
void platform config plans set pro --security-cap 200
```

A plan cap applies to each project whose owner is on that plan, even with project caps off. `--security-cap none` removes it and `inherit` returns to the default. See [Security scan cap](./plans.md#security-scan-cap).

## Emails

| Email                                                                  | Sent to                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| New findings, one per scan                                             | Owner, project admins, and the people who deployed |
| A human reopens an urgent finding                                      | Owner and project admins                           |
| Project cap at 80% and 100%                                            | Owner and project admins                           |
| Platform cap at 80% and 100%                                           | Platform administrators                            |
| Public request held, now public, or canceled                           | Who asked, the owner, and project admins           |
| Scan bypassed                                                          | Every platform administrator, with the reason      |
| Three scans of a project in a row failed                               | Owner, project admins, and platform administrators |
| Many scans failed for a platform reason, at most once a day            | Platform administrators                            |
| Weekly summary, when turned on with `void platform security digest on` | Platform administrators                            |

Emails carry titles, severity, and file paths, never code. A scan that finishes after the mode was set to Off sends no email. Without an [email domain](./email.md) the same information is in the CLI and on the project page, and bypasses still show in the admin pages. To send these events to your own system, set `void platform security webhook <https-url>`: a signed body with ids and counts only, sent even without an email domain. See [Alerts, summary, and webhook](/reference/cli/platform-security#alerts).

## Scan before a project goes public {#scan-before-public}

With [project Zero Trust](./zero-trust.md) on, you can hold a project's change from protected to public until a scan of the live deployment finds nothing urgent:

```sh
void platform security public-gate on
```

The gate needs a scan mode of Public or All, a recent probe pass, and platform Zero Trust on and not public-only. While it is on, platform Zero Trust cannot be disabled or switched to public-only. Turning the gate off, or setting the mode to Off, cancels open requests; those projects stay protected.

When someone runs `void project zero-trust public`, the project **stays protected** and the request waits for a scan. Deploys keep working.

| State            | Meaning                                                                                    | What to do                                  |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Waiting          | The scan is queued or running                                                              | Wait, or bypass                             |
| Held by findings | An urgent finding is open                                                                  | Resolve it. There is no bypass              |
| No result        | The scan failed, was refused, timed out, or hit a cap                                      | Run `public` again, deploy again, or bypass |
| Files not read   | The scan could not read some project files (too large, not text, or a path it cannot send) | Fix them and deploy again, or bypass        |
| Needs a deploy   | The live code cannot prove it, or a fix needs a newer deploy                               | Deploy again, or bypass                     |

A finding resolved as false positive or accepted risk lets the request go on at once. One resolved as **fixed** counts only after a clean scan of a newer deploy (an unchanged Worker redeploy is enough; a static site needs a changed deploy). A rescan of the same deployment proves nothing.

The gate covers only the change from protected to public for an existing project. Projects that start public, and `preview-*` projects, are not covered. A later finding never makes a public project private again.

### Bypass the scan

An owner or a project administrator can skip the scan with a reason; platform administrators use the platform command with the project ID:

```sh
void project zero-trust bypass --reason "Scanner down since 09:00; launch today."
void platform security bypass <project-id> --reason "Scanner down since 09:00; launch today."
```

A bypass never skips an open urgent finding: it is refused and nothing is recorded. Every bypass is recorded with its reason and emailed to every platform administrator; list them with `void platform security bypasses`. Later findings follow the normal flow.

## What users see

Project members use `void project security status`, `list --urgent`, `check`, and `void project zero-trust status`. See [Projects](/reference/cli/project#void-project-security). A new CLI talking to a platform without security audits says so. Older CLIs print nothing extra after a deploy, and never report a held request as public.
