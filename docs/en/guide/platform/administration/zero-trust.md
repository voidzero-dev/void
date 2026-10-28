---
outline: deep
---

# Project Zero Trust

Project Zero Trust puts Cloudflare Access in front of the hostnames of projects deployed to your platform, including custom domains. Visitors sign in with one of your identity providers before they reach a protected project. Each project can still be made public.

This is separate from the Access login and protection for the platform API. Projects deployed directly to Cloudflare are not affected.

Choose app access during `void platform install`, or configure it later using this page. The installer reuses the platform policy or helps you select separate company rules, and finishes setup before opening traffic.

If you choose public apps in an account with Default-Deny, Void manages scoped
public rules instead. New projects and custom domains remain public automatically.
Keep these rules enabled while Default-Deny is on; removing them can block traffic.
Public-only installations need no identity providers or company policies until you
choose to protect apps. To renew their token in Admin, leave the policy fields blank.

## Requirements

- A Cloudflare Zero Trust organization in the account that hosts the platform, with the identity providers and reusable Access policies you want to use. Select at least one Allow policy that matches people by identity. Void rejects Bypass and Service Auth policies, and rules that allow Everyone or any service token.
- A Cloudflare API token for that account with **Access: Apps and Policies Write** and **Access: Organizations, Identity Providers, and Groups Read**. Void keeps it separate from the platform runtime token, stores it encrypted, and never shows it again.
- Free Access applications in the account. Cloudflare's default limit is 500 per account. Count the applications you already manage outside Void, then add the ones Void needs, as described in [Access Applications Void Creates](#access-applications-void-creates).
- Platform API, proxy, and email gateway hostnames outside the project application domain. Configuration is rejected when project protection would cover one of them. Any other hostname under the project application domain also asks for sign-in, except the `/health` path of `void-platform-health.<your domain>`, which Void keeps open for its health checks and never serves from a project. New projects cannot use that name. A project that already uses it keeps every other path, protected or public like any other project.

## Enable Zero Trust

Open **Zero Trust** in the administrator UI, or use the operator CLI:

```sh
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --identity-providers <id[,id...]> \
  --policies <id[,id...]> \
  --existing-projects public \
  --protect-new-projects \
  --token-stdin \
  --yes
```

- `--existing-projects protected|public` decides what happens to the projects that already exist. It is required when you enable Zero Trust.
- `--protect-new-projects` protects projects created from now on. Omit it to make new projects public.
- Use `--plan` instead of `--yes` to check the change without applying it.

To change the identity providers, policies, token, or new-project default later, run the same command without `--existing-projects`. Existing projects keep their protection; use the project overrides below to change one project.

## Check Status

```sh
void platform zero-trust status
void platform zero-trust status --check
```

`status` shows the saved settings, the current operation, and how many projects are protected, public, or waiting. `--check` also compares the settings with Cloudflare Access. In the administrator UI, use **Check with Cloudflare**.

## Project Overrides

Project owners and project administrators can protect a project or make it public. Readers can see its state.

```sh
void project zero-trust status
void project zero-trust protect
void project zero-trust public
void project zero-trust reconcile
```

`status` also tells you whether protection can be changed right now. Making a project public does not change the default for new projects.

Installation administrators can do the same from the project page in the administrator UI or with `void platform zero-trust project-status|project-protect|project-public|project-reconcile <project-id>`.

Deploys and rollbacks wait until a project's protection change is finished. If one is refused, run `void project zero-trust status` to see why; the owner or a project administrator can run `void project zero-trust reconcile` before you try again. A protected project can have up to 100 custom domains.

## Disable Zero Trust

```sh
void platform zero-trust disable
```

This removes the Access applications Void created and makes all projects public. On large installations it runs in steps; run it again, or check `void platform zero-trust status`, until Zero Trust shows as disabled with no operation running.

Disable Zero Trust and wait for its applications to be removed before [uninstalling the platform](/guide/platform/installation/uninstall). If project deletion stopped partway, retry `void project delete` for that project.

## How Protection Works

Cloudflare Access handles sign-in and applies your policies. Void also verifies the token before serving a protected project. Public projects allow visitors without sign-in.

### What Visitors See

A protected project asks visitors to sign in with one of the identity providers you selected. If you selected exactly one, visitors go straight to it. Otherwise, they pick one of the selected providers. A sign-in lasts 12 hours. After that, Access asks again.

Protection follows the project to every hostname it answers on:

| Hostname                                  | Protected project | Public project |
| ----------------------------------------- | ----------------- | -------------- |
| `<slug>.<your domain>`                    | Sign-in required  | Open to anyone |
| The project's `workers.dev` testing URL   | Sign-in required  | Open to anyone |
| Custom domains, such as `app.example.com` | Sign-in required  | Open to anyone |

Void only covers the `workers.dev` testing URLs of this installation. Other Workers in the account are not affected. On an installation without a domain, the `workers.dev` testing URL is the only project URL, and the shared project application covers only those URLs.

#### The 403 Page

A request without a valid token receives `403 Cloudflare Access authentication required`. Page requests show an HTML error; API and asset requests receive plain text. These responses are never cached.

Visitors who went through the sign-in page normally never see it. They can see it:

- for a short time while the project is switching between protected and public;
- while a Zero Trust change is still being applied to the project;
- when a Void-managed Access application was deleted, or its hostnames were changed, in the Cloudflare dashboard. See [Editing Applications in the Dashboard](#editing-applications-in-the-dashboard).

#### Every Path Is Covered

Protection applies to the whole hostname. There are no path exceptions. `/api/*` routes, static files, hashed assets, `robots.txt`, `favicon.ico`, server-sent events, and WebSockets all require a signed-in visitor.

#### Webhooks and Other Non-Browser Clients

Project protection requires a person’s identity. Webhooks, CI jobs, uptime checks, and unauthenticated `curl` calls receive the sign-in page or a 403.

If a project must accept such requests:

- make the project public with `void project zero-trust public` and check callers in your own code, or
- move the endpoints that machines call into a separate project, and make only that project public.

### Access Applications Void Creates

Void creates and owns these self-hosted applications in your Zero Trust organization:

| Application                 | Covers                                                                    | Policy                                                                   | Exists                                                             |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Shared project application  | `*.<your domain>` and this installation's `workers.dev` testing URLs      | Your selected policies and identity providers                            | Once for protected-app configurations                              |
| Public app management check | A reserved, unused dispatch check path                                    | Deny Everyone; verifies management permissions without opening hostnames | Once, instead of the shared wildcard in public-only mode           |
| Public exception            | One public project's `<slug>.<your domain>` and `workers.dev` testing URL | A Bypass policy for Everyone, named `Void project is public`             | One for each public project                                        |
| Custom domain application   | All managed custom domains of one project                                 | Company policies for protected projects; Bypass for public ones          | One for each project with managed custom domains                   |
| Health check exception      | `void-platform-health.<your domain>/health`                               | A Bypass policy for Everyone, named `Void platform health check`         | Once, while Zero Trust is enabled on an installation with a domain |

Installations configured through the installer also manage public custom-domain
rules. Their custom-domain application changes policy when a project switches
between public and protected access.

If the installer already configured the same health-check exception, Zero Trust
reuses it. Disabling project Zero Trust leaves that existing exception in place
so platform health checks continue to work.

The number of applications Void needs is:

```text
1 + health-check applications + public projects + projects with managed custom domains
```

The first application is the shared company policy or the public-app management check. Count a health exception once, including when it is shared with the installer. For example, 40 projects with one health exception, 10 public projects, and 5 projects with managed custom domains need 1 + 1 + 10 + 5 = 17 applications. Void stops with an error when the account has more than 500 Access applications.

#### Recognizing Void's Applications

Run `void platform zero-trust status` for the shared and health-check applications, or `void platform zero-trust project-status <project-id>` for a project's applications. These commands show their exact names and IDs.

### Editing Applications in the Dashboard

Manage Void’s applications through `void platform zero-trust configure` and the project commands. Editing or deleting them in Cloudflare can block access until you reconcile. Dashboard edits may be replaced the next time Void updates an application.

You can edit a selected reusable policy’s rules in Cloudflare. Changes affect every project using that policy. Keep an identity-based Allow policy without Everyone or service tokens, then check it with:

```sh
void platform zero-trust status --check
```

- `drifted: true`: run `void platform zero-trust reconcile`.
- `present: false`: check the token, application, identity providers, and policies, then reconcile.

This checks the shared and health-check applications. For a public exception or custom-domain application, use the project's reconcile command.

#### Repair Commands

| Command                                                   | Scope                                 | Who can run it                           |
| --------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| `void platform zero-trust reconcile`                      | Platform and all projects             | Installation administrators              |
| `void platform zero-trust project-reconcile <project-id>` | One project                           | Installation administrators              |
| `void project zero-trust reconcile`                       | Linked project, or `--project <slug>` | Project owner and project administrators |

Project reconciliation requires platform status `ready`. Otherwise, reconcile the platform first.

If an application was renamed, restore its recorded name before reconciling. Remove duplicate copies yourself. Deleting the shared application temporarily blocks protected projects; deleting the health-check exception can block upgrades and repair until it is restored.

### What Happens During Changes

Protection changes can temporarily return a 403. If a step fails, a protected project stays protected or refuses visitors until the change finishes.

Protecting or making a project public usually finishes before the command returns. If it is still running or reports an error, inspect `void project zero-trust status`, fix the reported cause, and run `void project zero-trust reconcile`.

Platform-wide changes run in steps. During initial setup, custom domains stay public until Void reaches their project. During disable, hostnames can become public at different times. Follow progress with `void platform zero-trust status`.

A new custom domain becomes reachable only after its project’s protection is ready.

### Caching

Requests carrying an Access token bypass [ISR](/guide/edge/revalidation#cache-bypass) and the [static asset edge cache](/guide/edge/static-assets#non-hashed-assets). Protected pages render on each request, which can increase latency and request usage. Public projects keep their shared caches.

## Recovery

- **Status stays `configuring` or `disabling`.** Large changes run in steps. Scheduled maintenance continues them within a few minutes, or run `void platform zero-trust reconcile`.
- **Status shows an error.** Fix the cause shown, such as token permissions or the application limit, then run `void platform zero-trust reconcile`. Otherwise Void retries every hour.
- **One project shows an error.** The rest of the change still finishes. Void retries the project every hour, or its owner or a project administrator can run `void project zero-trust reconcile`. Until then, a project that was already protected stays protected, and a project being newly protected is never more open than before.
- **Adding a domain stays pending because of a project.** Void publishes the new domain only after every project is ready for it. Platform status shows an error that names the projects it could not update. Check each one with `void platform zero-trust project-status <project-id>`, fix the cause, then run `void platform zero-trust reconcile` or rerun the domain command. Void also retries every hour. Your `workers.dev` URLs keep working meanwhile.
- **A new project could not be set up.** Creating the project still succeeds with a warning. Void retries every hour, or run `void project zero-trust reconcile`.
- **The saved API token expired or was revoked.** Run `void platform zero-trust configure --token-stdin` with a replacement token and the same identity providers, policies, and `--protect-new-projects` choice. Omit `--existing-projects`. Void continues the unfinished change, including an unfinished disable. Finish it before changing other settings.
- **A selected identity provider or policy was deleted.** Run `void platform zero-trust disable` to stop the unfinished setup and remove its applications. This makes projects public. Then configure Zero Trust again with the new selections.
