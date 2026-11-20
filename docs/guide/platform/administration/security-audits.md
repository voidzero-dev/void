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

The scanner runs in its own container with no internet access. It reaches models only through the platform. Uninstalling the platform removes the scanner Worker, its container applications, the scanner images it copied, and any leftover scan copies. See [Disable and Uninstall](/guide/platform/installation/uninstall).

::: warning Roll forward after you upgrade
The upgrade that adds security audits includes a database migration for the scan scheduler. Cloudflare does not roll a Worker back past such a migration, so after you upgrade, fix a bad release by deploying a newer one.
:::

## Turn it on

```sh
void platform upgrade --security-audits
void platform security probe
void platform security policy public
```

The probe checks that the account can run scans and names anything missing. Turning a scan mode on runs it first and refuses when it fails. The probe runs again each day while scans are on. If it starts failing, the policy stays on, new deploys are not scanned, and the admin pages show a banner.

Choose a scan mode:

| Mode                 | Scans                                                           |
| -------------------- | --------------------------------------------------------------- |
| Off (default)        | Nothing                                                         |
| Public projects only | Projects that are public, or that have no Zero Trust protection |
| All projects         | Every project                                                   |

Turning a mode on scans nothing right away. Each project is scanned at its next deploy, and the first scan of a project reviews the whole deployment. Later scans review what changed since the last good scan. Use `--plan` to preview how many projects a change reaches.

A platform admin can also give one project its own rule, from the project's **Security** section in the administrator UI or with the CLI:

```sh
void platform security policy --project <project-id> <inherit|always|never>
```

| Rule              | Scans                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| inherit (default) | What the scan mode says                                                 |
| always            | Every deploy, also while Zero Trust protects the project                |
| never             | Nothing, except the scan before the project goes public when that is on |

A project's rule has no effect while the mode is Off. Its project page and `void project security status` say why the project is or is not scanned.

Platform administrators can also manage all of this from **Security** in the administrator UI.

## What is scanned

A scan starts when a deploy goes live. Rollbacks, failed deploys, and `preview-*` projects are not scanned. A newer deploy replaces a scan that is still queued. A redeploy with no code change is recorded as "no changes" and costs nothing.

Void reviews the source that changed when it can see it, and otherwise the built output mapped back to source. Third-party package code, lockfiles, binaries, and secret-like files are left out, and stored secret values are replaced before any model sees the code. A full rescan can also review the sources of the client bundles, from the source maps deployed with them: `void project security scan --client-assets`. Each result states what it covered, such as `Changes since dpl_7c20 · source diff · 14 files · complete`. Large changes are scanned in parts, and the page shows the files still waiting.

### Check code before you deploy

Developers who can deploy a project can scan their code before it goes out:

```sh
void project security check
```

It sends the git-tracked files of the current folder, as they are on disk, to the platform, and the scan runs on the project's model. Untracked files, secret-like files, lockfiles, and binaries stay on the developer's machine. The command shows what it sends, which model reviews it, and the most it can cost, then asks before it uploads anything. The check needs the policy to apply to the project, and is refused while a platform admin has set the project's rule to `never`. It waits in the queue like any scan and counts toward the monthly caps. Its result is shown in the terminal and kept for 30 days. It is not saved as project findings, sends no email, and does not affect a request to go public. See [`void project security check`](../../../reference/cli/project.md#void-project-security).

## Models and the provider notice

| Model                                                | Run by     |
| ---------------------------------------------------- | ---------- |
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (default) | Cloudflare |
| `@cf/zai-org/glm-5.3`                                | Cloudflare |
| `openai/gpt-6.1-terra`, `openai/gpt-6.1-sol`         | OpenAI     |
| `anthropic/claude-sonnet-5.5`                        | Anthropic  |
| `anthropic/claude-opus-5.5`                          | Anthropic  |

A model run by a third party sees the project's changed code, the files it uses, and past findings and comments. The provider may keep request data for a limited time and may refuse security-looking code. A refused scan shows as refused, never as passed. For that reason code does not go to a third party until someone has accepted the notice: you accept it once for a third-party platform default, and a project owner or administrator accepts it once per project. Until then the project uses a Cloudflare model. To keep all code in Cloudflare, block the third-party models.

A project that picks a third-party model also needs an AI permission on the platform's runtime token, unless you [saved your own key](#own-provider-key) for that provider. See [Permissions to select for each token](/guide/platform/installation/credentials). The probe names a missing permission and lists models that cannot be picked yet. For these models the probe also copies a scanner image into the account's container registry. The first copy can take more than one probe run; until it is done, those models cannot be picked. When you block every model of one provider, the probe does not copy that provider's image.

Project owners and administrators pick their project's model from the same list with `void project security model`.

### Use your own provider key {#own-provider-key}

By default, OpenAI and Anthropic models are paid from the platform account's [AI Gateway Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) credits. To use your own API key and your own agreement with the provider instead, save the key:

```sh
printf "%s" "$ANTHROPIC_API_KEY" | void platform security models --provider anthropic --key-stdin --yes
void platform security probe
```

Void makes a 1-token test call with the key and saves it only if the call works. The key is stored encrypted and never reaches the scanner; the platform adds it to each model call. Scans with that provider then bill to your key, still through AI Gateway. They are still metered at list price and count toward the [spending caps](#spending-caps). The provider notice and model blocking work the same way.

Run the probe after saving a key if that provider's models could not be picked before. Saving a new key replaces the old one right away. `void platform security models --provider anthropic --remove-key` deletes it: that provider's scans go back to Unified Billing credits, and its models cannot be picked until the probe passes again. `void platform security status` shows which keys are saved and when, never the key itself.

## Findings

Only a human closes a finding. A scan can add one, confirm it again, or reopen it, but never close it. Resolve a finding as fixed, false positive, or accepted risk, with a comment of up to 4,000 characters. The comment and the resolution feed the next scan, so the same false alarm does not come back. Comments never hide anything; only a false-positive resolution does.

A finding is **urgent** when it is confirmed, critical or high, and still open. Weaker or unconfirmed findings are listed as leads or lower severity and are never urgent.

A project admin or the owner can change the severity of an open finding, with a comment: `void project security severity F-12 medium --comment "Only reachable by admins"`. The new severity sticks across scans. Lowering a critical or high finding takes it out of the urgent count, as a resolve does. See [`void project security`](../../../reference/cli/project.md#void-project-security).

When the value of a project secret appears in the deployed Worker code or in a static text file (`.js`, `.html`, `.json`, `.css`, `.txt`, up to 8 MB), as is or encoded, the platform reports it itself as a `secret-in-output` finding that names the secret but never shows its value. There is one finding per secret for static files and one for Worker code, whatever files it is in. In a static file it is high and urgent, since anyone can download the file once the project is public: rotate the secret and keep it on the server. In Worker code it is medium: read it from `env` instead of writing it into the code. If the value is meant to be public, such as a publishable key, resolve the finding as accepted risk; it stays resolved when later deploys change the bundle.

When a project uses a Cloudflare model, a scan can also test a possible finding on a throwaway copy of the deployment: the same code with empty databases, fake secrets, and no internet access. Only the scanner can reach the copy, and it is deleted when the scan ends. A finding proven this way shows as `confirmed (runtime)` in `void project security show`. The copy is part of the scan cost.

| Who sees what                   | Reader | Collaborator and up |
| ------------------------------- | ------ | ------------------- |
| Urgent count and finding ids    | Yes    | Yes                 |
| Titles, files, and details      | No     | Yes                 |
| Scans, cost, and bypass reasons | No     | Yes                 |

Open urgent findings show:

- at the end of each `void deploy` to a Void platform, with titles only for a signed-in user who can deploy. CI runs and readers see counts and ids,
- in `void project security status`, and as a `Security` line in `void project status`,
- on the project's security page, opened with `void project security open`, where project members can also comment, resolve, pick the model and set the budget,
- in the administrator UI, with an **Urgent** filter.

To use findings in a code scanning tool, export them as SARIF with `void project security list --format sarif` (or `void platform security findings --format sarif` for every project).

Every scan that does not succeed says what happened, and the next scan covers those changes. A refused, timed-out, or failed scan is never counted as clean.

## Spending caps

The platform pays for scans, and they do not count against the plan's AI limits. Two monthly caps, both off by default, use the calendar month in UTC:

- A **platform cap** that stops all scans when it is used up.
- A **project cap**, with a default amount for every project. A project owner or administrator can set a lower cap for their own project. The most they can set is the limit you give that project, else the cap of the owner's plan, else the default when project caps are on.

A scan starts only if its worst case fits under both caps. A used-up cap skips scans, never deploys, and the first scan after the reset or a raise covers what was skipped. Rescans and scans before public count too. At 80% and 100% of a cap, the owner and project administrators (project cap) or platform administrators (platform cap) get one email per month.

```sh
void platform security budget --platform-usd 500 --project-default-usd 50
void platform config plans set pro --security-cap 200
```

A plan cap applies to each project whose owner is on that plan, even with project caps off. `--security-cap none` gives the plan's projects no cap, and `inherit` returns it to the default.

## Emails

| Email                                        | Sent to                                            |
| -------------------------------------------- | -------------------------------------------------- |
| New findings, one per scan                   | Owner, project admins, and the people who deployed |
| A human reopens an urgent finding            | Owner and project admins                           |
| Project cap at 80% and 100%                  | Owner and project admins                           |
| Platform cap at 80% and 100%                 | Platform administrators                            |
| Public request held, now public, or canceled | Who asked, the owner, and project admins           |
| Scan bypassed                                | Every platform administrator, with the reason      |

Emails carry titles, severity, and file paths, never code. Without a configured [email domain](./email.md) the same information is in the CLI and on the project page, and bypasses still show in the admin pages.

## Scan before a project goes public {#scan-before-public}

With [project Zero Trust](./zero-trust.md) on, you can hold a project's change from protected to public until a scan of the live deployment finds nothing urgent:

```sh
void platform security public-gate on
```

The gate needs a scan mode of Public or All, a recent probe pass, and platform Zero Trust on and not public-only. While it is on, platform Zero Trust cannot be disabled or switched to public-only. Turn the gate off first. Turning it off, or setting the scan mode to Off, cancels open requests. Those projects stay protected.

When someone runs `void project zero-trust public`, the project **stays protected** and the request waits for a scan. Deploys keep working. The request is in one of these states:

| State            | Meaning                                                      | What to do                                  |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Waiting          | The scan is queued or running                                | Wait, or bypass                             |
| Held by findings | An urgent finding is open                                    | Resolve it. There is no bypass              |
| No result        | The scan failed, was refused, timed out, or hit a cap        | Run `public` again, deploy again, or bypass |
| Needs a deploy   | The live code cannot prove it, or a fix needs a newer deploy | Deploy again, or bypass                     |

A finding resolved as false positive or accepted risk lets the request go on at once. A finding resolved as **fixed** only counts after a clean scan of a newer deploy. A rescan of the same deployment proves nothing. An unchanged Worker redeploy is enough to prove a fix. A static site needs a changed deploy.

The gate covers only the change from protected to public for an existing project. Projects that start public, and `preview-*` projects, are not covered. After a project is public, a later finding never makes it private again.

### Bypass the scan

An owner or a project administrator can skip the scan with a reason:

```sh
void project zero-trust bypass --reason "Scanner down since 09:00; launch today."
```

Platform administrators use the platform command with the project ID:

```sh
void platform security bypass <project-id> --reason "Scanner down since 09:00; launch today."
```

A bypass skips the scan, never an open urgent finding. With one open, it is refused and nothing is recorded. Every bypass is recorded with its reason, and every platform administrator gets an email. Platform administrators can list them with `void platform security bypasses`. Later findings follow the normal flow.

## What users see

Project members use these commands. See [Projects](/reference/cli/project#void-project-security).

```sh
void project security status
void project security list --urgent
void project zero-trust status
```

A new CLI talking to a platform without security audits says so and asks the user to contact a platform administrator. Older CLIs print nothing extra after a deploy, and they never report a held request as public.
