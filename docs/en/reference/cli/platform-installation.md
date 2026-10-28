---
outline: deep
---

# Platform Installation {#void-platform-install}

```sh
void platform install [options] [--yes]
```

| Option                                    | Purpose                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `--name <slug>`                           | Installation name used in `void-<name>-<role>` resource names; choose an unused name |
| `--display-name <name>`                   | Human-readable platform name                                                         |
| `--account <id>`                          | Cloudflare account id                                                                |
| `--auth-config <path>`                    | Login methods, signup policy, and environment references for provider secrets        |
| `--login-methods <methods>`               | Comma-separated `github`, `google`, `oidc`, or `cloudflare-access` login methods     |
| `--access-protection`                     | Protect the platform UI and APIs with Cloudflare Access                              |
| `--no-access-protection`                  | Skip Cloudflare Access protection                                                    |
| `--app-access <public\|platform\|custom>` | Public apps, the platform's Access policy, or separately selected app policies       |
| `--hyperdrive <create\|id>`               | Create Hyperdrive or use the specified existing configuration                        |
| `--application-domain <domain>`           | Base domain for deployed apps                                                        |
| `--workers-dev`                           | Explicit testing mode; add an application domain later                               |
| `--zone <domain>`                         | Cloudflare zone containing the application domain                                    |
| `--dedicated-zone`                        | Add zone-wide catch-all routes; valid only when the app domain is the whole zone     |
| `--no-dedicated-zone`                     | Skip zone-wide application catch-all routes                                          |
| `--custom-domains`                        | Let projects add their own domains; needs a dedicated zone                           |
| `--control-plane-domain <domain>`         | Optional API custom hostname; defaults to `workers.dev`                              |
| `--no-control-plane-domain`               | Use the default `workers.dev` API hostname                                           |
| `--dashboard-url <origin>`                | HTTPS origin of an optional dashboard deployed separately                            |
| `--plan`                                  | Preview Cloudflare changes and save installation choices locally                     |
| `--resume`                                | Continue the matching checkpointed installation                                      |
| `--runtime <path>`                        | Deploy a locally built, integrity-checked runtime directory                          |
| `--yes`                                   | Acknowledge Cloudflare changes in non-interactive use                                |

For a first installation, follow [Install a Void Platform](../../guide/self-hosted-platform.md). The interactive installer recommends using a domain and offers **Use workers.dev for testing** as a visible alternative. Void creates the platform infrastructure and tables. External PostgreSQL and a configured login method are required in either mode. Select all login methods you want to enable; none are selected initially. Non-interactive installation defaults to GitHub when no login configuration is supplied. `--workers-dev` skips zone/DNS/certificate operations and cannot be combined with `--application-domain`, `--zone`, or `--dedicated-zone`.

Read-only plans, workers.dev installations with the default API hostname, and supported lifecycle operations can use Cloudflare browser login and the system keychain. Installation that writes DNS or creates a zone needs a management API token. The interactive installer guides you to create one and paste it into a masked prompt; scripts use `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN`.

The installed platform needs a separate runtime token to provision resources for apps. The interactive installer prompts for it and the other setup values. For non-interactive installs, inject the variables listed in [Install from CI](../../guide/platform/installation/ci.md).

To enable email during install or upgrade, set both `VOID_EMAIL_SENDER_DOMAIN` and `VOID_EMAIL_SHARED_ZONE_ID`. Void records the pair for later upgrades; supplying only one is an error.

Use `--dashboard-url `[`https://dash.example.com`](https://dash.example.com) when deploying the optional user
dashboard separately. The URL must be an HTTPS origin without credentials, a
path, query, or fragment. Void permits that origin's login callbacks and saves
it for later maintenance; it does not deploy a dashboard Worker. Omission keeps
an existing installation's saved dashboard origin.

`--plan` previews resource names, login methods, default app access, the login callback URL, database configuration, and credential requirements. An existing Hyperdrive shows its database and configuration name. Setup links are shown during guided credential setup. Completed previews save nonsecret installation choices locally. Rerun `void platform install` to choose a saved plan and review a fresh check of Cloudflare state, or run the install or resume command printed at the end. Started installations use their saved checkpoints; completed installations are excluded from the chooser. For login configuration, use either `--auth-config` or `--login-methods` with the Access protection flags.

App access is configured before traffic opens. With platform protection enabled,
the installer recommends reusing its company policy; otherwise it defaults to
public apps. Use `--app-access custom` to select separate hosting-account policies.
Public apps in a Default-Deny account receive scoped public Access rules. The
installer explains and collects the encrypted management credential when needed;
scripts supply `VOID_PLATFORM_APP_ACCESS_TOKEN` or `appAccess.tokenEnv` in the
authentication file. Upgrades preserve administrator settings.

New resources use `void-<name>-<role>` names; choose an unused installation name. The installer opens setup pages for missing credentials and reuses values already supplied.

During Access setup, choose existing company policies or **Create in Cloudflare**
for manual setup instructions and an account dashboard link. After you save the
policy and confirm completion, Void reloads the list so you can select it and
continue in the same run. When Void creates the Access applications, **Allow my
company’s email domain** creates an Allow policy for the domains you enter and
selects it. **Refresh list** reloads policies created in another window. Your
identity-provider choice and still-available policy selections are retained. If a
selected policy does not restrict sign-in to company identities, Void explains why
and asks again.

Installation progress and partial credentials are saved encrypted locally. Rerun the installer to continue unfinished setup, or pass `--resume --name <id>`. Use lifecycle commands for completed installations.

Use an empty PostgreSQL database dedicated to the installation. You can correct a failed initial connection, but after the database is claimed or Hyperdrive is provisioned, commands reject a different URL.

Choose whether Void creates Hyperdrive or uses an existing configuration. An existing Hyperdrive must point to the platform database with SQL result caching disabled. Supply a database owner URL for migrations. See [Use an existing Hyperdrive](../../guide/platform/installation/prerequisites.md#use-an-existing-hyperdrive) for setup and [Install from CI](../../guide/platform/installation/ci.md) for unattended inputs.

Recovery secrets are encrypted using your system keychain. Without one, supply a base64-encoded 32-byte `VOID_PLATFORM_RECOVERY_KEY`. Keep the original credentials in protected CI secrets for recovery.

If a newly created zone is waiting for registrar delegation, resume after it becomes active:

```sh
void platform install --resume --name <installation-id>
```

See [Self-host a Void platform](../../guide/self-hosted-platform.md) for prerequisites, token scope, exact footprint, domain behavior, and an end-to-end walkthrough.

## `void platform domain set` {#void-platform-domain-set}

```sh
void platform domain set <domain> [--installation <id>] [--zone <domain>] [--dedicated-zone] [--plan] [--yes]
```

Add an application domain to a workers.dev test platform. Domain-based installations remain the recommended default. The command detects the zone when possible, creates missing DNS and routes after confirmation, and checks HTTPS and project Zero Trust protection before making the domain canonical. If DNS, certificates, or protection are pending, rerun the same command to resume. `--plan` is read-only; non-interactive mutations require `--yes`.

Existing workers.dev URLs remain available, and the platform API origin, OAuth callback, projects, and deployments stay unchanged. The command verifies the running runtime token's Cache Purge permission for the new zone. A disabled platform stays disabled. Use the database URL from the original installation when administering from another machine. Replacing an already configured application domain is not supported. See [Adding a Domain](../../guide/platform/installation/domains.md#adding-a-domain).

## Lifecycle commands {#lifecycle-commands}

Use these commands to recover, update, pause, or remove an installation:

```sh
void platform discover [--account <id>] [--installation <id-or-name>]
void platform upgrade [id] [--runtime <path>] [--dashboard-url <origin>] [--custom-domains] [--plan] [--yes]
void platform rollback [id] --runtime <earlier-path> [--from-runtime <current-path>] [--plan] [--yes]
void platform repair [id] [--runtime <path>] [--dashboard-url <origin>] [--custom-domains] [--auth-config <path>] [--plan] [--yes]
void platform disable [id] [--plan] [--yes]
void platform enable [id] [--runtime <path>] [--plan] [--yes]
void platform uninstall [id] [--plan] [--purge-data | --purge-resources] [--yes]
```

`discover --installation` limits recovery and endpoint verification to one installation in a shared Cloudflare account.

Use the installation slug shown beside its name in `void platform list`. Installation IDs and saved connection IDs also work. Lifecycle commands require local installation records; use `discover` to restore them on another machine. Omit `id` when only one installation is configured, or choose from the interactive picker. Non-interactive commands need a slug or ID when several installations exist. Commands that make changes also require `--yes`; `--plan` only previews changes.

To add or explicitly change a separately deployed dashboard after installation,
use `repair --dashboard-url <origin>` or `upgrade --dashboard-url <origin>`.
Preview with `--plan` first. Existing Access protection must cover the configured
dashboard origin before maintenance can proceed. See [Optional Dashboard](../../guide/platform/installation/domains.md#optional-dashboard).

While first administrator setup is pending, `repair --auth-config <path>` replaces
the login settings from a file in the install format and prints a new setup code.
Interactive repair offers the same change with the saved values filled in. Login
methods and Access protection stay as installed. Run it on the computer that
installed the platform. See [First administrator sign-in fails](../../guide/platform/installation/maintenance.md#first-administrator-sign-in-fails).

After discovery on another machine, set `VOID_PLATFORM_DATABASE_URL`. See [Manage an installation from another machine](../../guide/platform/installation/maintenance.md#manage-an-installation-from-another-machine) for the secrets needed to recreate a missing Worker.

| Command     | Behavior                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `discover`  | Verifies remote ownership and restores local installation records without downloading secrets               |
| `repair`    | Recreates missing resources owned by the installer                                                          |
| `upgrade`   | Deploys the selected runtime and supported pending migrations                                               |
| `rollback`  | Restores a declared-compatible earlier runtime without reversing PostgreSQL migrations                      |
| `disable`   | Blocks app traffic and the platform API without removing data; only admin status and sign-in stay available |
| `enable`    | Redeploys and verifies the platform Workers, then restores traffic                                          |
| `uninstall` | Blocks traffic and removes eligible resources, retaining data by default                                    |

Repair and upgrade preserve disabled state. New, resumed, and previously disabled installations block user traffic until all target Workers pass verification; the installer's health probes can still run. Routes and custom domains remain attached.

If a platform Worker was changed outside Void, or has an active version without a Void deployment record, a command that deploys the platform Workers stops before it changes a platform Worker or pauses traffic, unless you agree in a terminal to replace the changes. See [Platform Workers changed outside Void](../../guide/platform/installation/maintenance.md#workers-changed-outside-void).

`--runtime` selects a custom platform build. Relative paths resolve from your current directory. Void verifies the build before making changes; see [Platform Development](../../guide/platform/development/runtime.md#deploying-your-runtime) for creating one.

Without `--runtime`, the CLI uses its packaged platform version.

Platform migrations only move forward. Void checks compatibility before updating the database and tells you if an intermediate release is needed.

An upgrade completes after the new Workers pass health checks. If rollout fails, Void attempts to restore the previous Workers. Retrying does not repeat completed migrations.

`platform rollback` restores a compatible earlier runtime without reversing database migrations. Pass its files with `--runtime`; if the installed version is custom, also supply that version with `--from-runtime`. Void refuses incompatible targets.

If project Zero Trust is on and no platform user exists yet, uninstall turns it off and deletes its Access applications first. Run it on the computer that installed the platform.

Uninstall verifies remote ownership before removing anything. Data resources are retained unless you pass `--purge-data`. Workers, the Queues they use, R2, AI Gateway, DNS records, routes, custom domains, adopted resources, external PostgreSQL, and zones are retained for manual review. `--keep-zone` is deprecated and has no effect; uninstall always keeps zones.

`--purge-resources` includes `--purge-data` and also deletes every other resource the installation created, including Workers, Queues, R2, AI Gateway, the platform DNS record, routes, custom domains, and installer-created Access resources. It removes only the Email Routing rules that send mail to the platform email gateway, and keeps zones, adopted resources, external PostgreSQL, other Email Routing settings, and API tokens. A route, custom domain, DNS record, or Access resource that no longer matches the installation's record is kept and listed. It refuses before any change while projects remain or resource reads are denied. Use the Edit permissions listed by `--plan`; read checks cannot verify them, so a denied deletion can stop uninstall after changes have begun. Rerun the same command to continue after an interruption, or after a plain or `--purge-data` uninstall stopped.

See [Disable and Uninstall](../../guide/platform/installation/uninstall.md#remove-retained-resources) for the full removal policy and the cleanup order.
