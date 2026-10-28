---
outline: deep
---

# Maintenance and Recovery

## Resume, repair, recover, and upgrade

Run `void platform list` to find the installation slug beside its name. Lifecycle commands accept this slug, an installation ID, or a saved connection ID. You can omit the selector when only one installation is configured. With several installations, choose one interactively or pass its slug or ID in CI.

### Resume an installation

If setup stops or fails, continue from the saved progress:

```sh
void platform install --resume --name <id>
```

You can correct the database URL if the initial connection failed. Once Void has claimed the database or provisioned Hyperdrive, that database is fixed for the installation. A later command with a different URL stops before making changes.

### Cloudflare Access blocks the health check {#cloudflare-access}

If installation reports **Default-Deny (error 1050)**, Cloudflare blocked the HTTP health check before it reached Void. This is separate from the API token used to deploy the Workers.

Keep the company protection in place. Automatic Access setup saves its scoped
service credentials with the installation's encrypted recovery material. For an
existing gate, verify that its service policy admits the installation token and
that the application covers the printed API and proxy origins. A Cloudflare
management API token does not authenticate an Access-protected HTTP request.

For automatic setup, resuming also creates or verifies an Access exception
limited to `/health` on the reserved dispatch health hostname. Void still requires
its private probe token on that endpoint; requests without it cannot reach an
application. This lets installation check routing while employee protection and
account-wide Default-Deny remain enabled. It does not bypass Access for an entire
Worker or for deployed apps.

For externally supplied credentials, set `VOID_ACCESS_CREDENTIALS` from your
secret manager to an object keyed by each exact API/proxy origin, with
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in each entry. Then rerun
`void platform install --resume --name <id>`. Void retains the saved resources
and stops if the gate still rejects its checks. Account-wide Default-Deny and
deployed-application policies remain your responsibility.

### Expired administrator setup code

Resume an unfinished installation with `void platform install --resume --name <id>`.
For completed provisioning whose administrator setup is still pending, run
`void platform repair <id>`. Void prints a fresh setup code if the earlier code
expired. Enter it at `/setup`, sign in, and confirm the displayed identity.
An installation that already has an administrator does not reopen setup.

### First administrator sign-in fails

If sign-in fails after you enter the setup code, the page shows the reason and an
error code. When a provider setting may be the cause, it also shows the callback
URL the provider must have.

| Error code                                                                  | What to check                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `github_incorrect_client_credentials`, `github_failed`, `oidc_token_failed` | The client ID and client secret, and that the provider has the callback URL |
| `github_redirect_uri_mismatch`                                              | The callback URL registered in the GitHub OAuth app                         |
| `oidc_discovery_failed`                                                     | The issuer URL, exactly, including any trailing slash                       |
| `github_unverified_user_email`                                              | Verify the primary email of the GitHub account                              |
| `google_domain_not_allowed`, `oidc_group_not_allowed`                       | Sign in with an allowed account, or change the allowed domains or groups    |
| `login_denied`, `github_bad_verification_code`                              | Start a new sign-in                                                         |

If the provider shows its own error page instead, register exactly the callback
URL printed with your setup code.

To change the login settings, run repair on the computer that installed the
platform:

```sh
void platform repair <id>
void platform repair <id> --auth-config <path>
```

Interactive repair asks whether to change the login settings, with the saved
values filled in; leave the client secret blank to keep it. `--auth-config`
takes a file in the [install format](/guide/platform/installation/setup#finish-login-configuration)
and is the way to change OIDC allowed groups. Login methods and Access protection
stay as installed. Repair prints a new setup code and the callback URL.

A GitHub-only installation signs in with the GitHub OAuth App from its
installation settings. To replace its client ID and secret, set
`VOID_PLATFORM_GITHUB_CLIENT_ID` and `VOID_PLATFORM_GITHUB_CLIENT_SECRET` when
you run `void platform repair <id>`.

### Repair missing resources

Preview what needs repair, then apply it:

```sh
void platform repair [id] --plan
void platform repair [id]
```

Repair recreates missing infrastructure that the installer owns. It does not restore PostgreSQL rows or data stored in provider resources. If an adopted or external resource is missing, restore it yourself before continuing. A disabled platform stays disabled through repair and upgrade.

### Upgrade the platform

Keep the platform runtime current when updating the Void CLI. Upgrade the platform before your team updates its CLI: a newer CLI refuses to work with an older platform and asks for `void platform upgrade`. Install the new CLI on the administrator's machine, run the upgrade below, then have the team update.

If the platform will deploy apps that use `void/sandbox`, its runtime token needs **Account → Containers → Edit** and **Account → Cloudchamber → Edit**. A token made from an older setup link may lack them, and an upgrade does not add them. Edit the token in the Cloudflare dashboard, or set `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` to a new token when you upgrade. See [Cloudflare API Tokens](/guide/platform/installation/credentials#runtime-token-permissions).

Use the installed CLI's packaged runtime to upgrade:

```sh
void platform upgrade [id] --plan
void platform upgrade [id]
```

An upgrade validates the runtime, applies supported pending migrations, deploys the Workers, and checks their health. Existing Worker secrets are preserved.

Before starting, Void checks access to the installation's Cloudflare account, Workers, and existing R2 buckets. If credentials are rejected, set `CLOUDFLARE_API_TOKEN` to a management token scoped to that account and retry. This overrides the installation's saved management token.

Some upgrades pause application traffic during the cutover to the new version. Traffic resumes after the new version passes its health checks. If an upgrade or another lifecycle command fails after it paused traffic, traffic stays paused until a later run succeeds. To resume:

1. Run `void platform status <id>` to see the saved progress.
2. Fix the problem that the error names.
3. Run the resume command that the CLI printed. It is the same command, with the same runtime.

::: details Migration safety, credential rotation, and rollback

To update the runtime Cloudflare token, GitHub OAuth credentials when GitHub login is enabled, or R2 credentials,
provide their `VOID_PLATFORM_*` environment variables when running the upgrade.
Only the supplied values replace live credentials. Recovery data from an older
workstation does not overwrite them, and upgrades preserve the live signing keys
and complete project-encryption keyring. Keep current credentials in your secret
manager so they can also restore a missing Worker during repair.

Database migrations only move forward. Void checks compatibility before upgrading and tells you if an intermediate release is needed. If deployment fails, it attempts to restore the previous Workers against the compatible database schema. Retrying does not repeat completed migrations.

After a successful upgrade, you can restore a declared-compatible earlier runtime without reversing migrations:

```sh
void platform rollback [id] --runtime /path/to/earlier/runtime --plan
void platform rollback [id] --runtime /path/to/earlier/runtime
```

Keep the earlier runtime files if you need rollback. If the installed version is a custom build, also pass its files with `--from-runtime /path/to/current/runtime`. Void checks that the earlier version can run against your current database and refuses incompatible rollbacks. A later `upgrade` can move forward again. See [Platform Development](/guide/platform/development/runtime#deploying-your-runtime) for working with custom builds.

Do not roll back to 0.26.0 or earlier after upgrading to a later release. Void does not refuse this rollback, but those releases reject the credentials that later releases give your apps. Every project deployed or rotated since the upgrade loses AI, email, ISR revalidation, remote D1, KV, and R2, and prerendering until you upgrade again. If you have rolled back that far, upgrade again, then run `void platform system rotate-proxy-tokens --all --yes` and check with `--plan` until nothing is pending or failed.

Let running rotations finish before you roll back. If an older proxy runs next to a newer API, prerendering and remote D1, KV, and R2 fail until both run the same release. After a rollback to the release just before credential rotation, projects deployed since the upgrade lose prerendering and remote D1, KV, and R2 until they are deployed again or you upgrade again. A rotated project deployed during any rollback stays broken after you upgrade again, and 0.26.0 and earlier also drop rotations that have not finished. After upgrading again from any rollback, run the same `rotate-proxy-tokens` commands.

:::

### Platform Workers changed outside Void {#workers-changed-outside-void}

Void manages the platform's own Workers. Do not change them in the Cloudflare dashboard or with the Cloudflare API. To change the platform, use the Void commands on this page.

`upgrade`, `repair`, `enable`, `rollback`, and `install --resume` deploy the platform Workers again. Before they change a platform Worker or pause traffic, Void finds each platform Worker that:

- was changed in the Cloudflare dashboard or with the Cloudflare API.
- has an active version without a Void deployment record. This can occur when an earlier run replaced a change made outside Void, and then stopped or failed. If that run stopped during the cutover to the new version, the command first makes the earlier versions active again. Void checks those earlier versions too. A version that an older Void release deployed can also have no record.

The `--plan` preview of `upgrade`, `repair`, `enable`, and `rollback` shows the same list as a warning.

In a terminal, Void lists these Workers and asks **Replace the configuration of these Workers?** The default answer is No.

- If you answer No, the command stops. No platform Worker changed, and the command did not pause traffic.
- If you answer Yes, the command continues. First, Void prepares the platform resources and the database. Then, before it pauses traffic or deploys a Worker, the Cloudflare CLI asks you again for each Worker changed in the dashboard or with the API. For a dashboard change, it shows the differences. Void uploads a new version of each of these Workers and does not deploy it yet. For a Worker that has an active version without a Void deployment record, the Cloudflare CLI does not ask again.

If you refuse in the Cloudflare CLI, the command stops. Void does not undo the resource and database changes. No deployment changed, and the command did not pause traffic.

The replacement removes values that Void does not set, for example an `EMAIL_FROM` variable that you added. It also resets values that Void sets, for example `AUTH_REDIRECT_URI`.

Without a terminal, for example in CI, or with `--yes`, the command stops before it changes a platform Worker, and it does not pause traffic. Run the command that Void prints once in a terminal, and answer the questions there. After that run completes, the command works in CI again.

If Void cannot read a platform Worker, the command also stops before it changes a platform Worker or pauses traffic. Run the command again. If a platform Worker has no single version that gets 100% of traffic, for example after a gradual deployment, deploy one version of it to 100% of traffic in the Cloudflare dashboard. Then run the command once in a terminal, so that you can approve the dashboard change.

If an earlier run failed after it paused traffic, traffic stays paused after these stops. To resume traffic, see [Upgrade the platform](#upgrade-the-platform).

### Follow upgrade and rollback progress

Watching progress is optional: a running upgrade or rollback proceeds through
the CLI without action on the status page. During maintenance, navigating the
admin UI automatically redirects to `/admin/status`. You can also open it
directly on your platform API origin and sign in as an administrator.

The read-only page shows the saved operation, source and target versions, and
the traffic state reported by the API. It refreshes automatically every five
seconds while visible. If updates fail, it keeps the last confirmed snapshot
and marks it as out of date. Normal administrator changes remain paused.

Sign-in and status remain available while the API and authentication database
are reachable. An operation completing
does not confirm every project's health. A disabled installation keeps traffic
paused after an upgrade or rollback.

If an operation fails or waits for DNS or Sandbox drain work, the CLI prints
the recovery instructions and command needed to resume. Resolve the reported
problem, then resume with the same runtime files. For a custom rollback, retain
the source runtime files too. `void platform status <id>` also prints locally saved progress
before checking the live API; this local checkpoint can be out of date if another
administrator changed the installation.

When application traffic is paused, visitors receive a temporary-unavailability
page with a **Try again** link. API requests and form submissions still receive
HTTP 503 responses. Void does not automatically replay requests; visitors who
submitted a form should check its result before submitting it again.

### Manage an installation from another machine

Use `discover` to restore the administrator's local installation records:

```sh
void platform discover --account <account-id> --installation <id-or-name>
```

Discovery restores local installation records after verifying the resources belong to your platform. It also works for interrupted or disabled installations. If infrastructure is missing, run `void platform repair [id]` after discovery. If ownership cannot be verified, the command stops without changing resources.

After discovery, provide `VOID_PLATFORM_DATABASE_URL` for migrations and to coordinate administrator commands. You don't need to re-enter the other secrets for an upgrade that preserves every deployed Worker. For an email-enabled installation without its encrypted recovery file, restore `VOID_PLATFORM_EMAIL_SIGNING_SECRET`; recreating only the email gateway needs that key and no Cloudflare runtime token or JWT signing key. Recreating the API or proxy also requires the email key when email is enabled, in addition to their normal secrets. Recreating the API requires its original runtime token (`VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`), R2, JWT, and project-encryption values through the `VOID_PLATFORM_*` variables; a GitHub-only installation also needs its original GitHub OAuth values. Recreating the proxy requires the runtime token and JWT signing key. Cloudflare can't return these values, so keep them in your organization's secret manager.

If you have not rotated the project-encryption key, restore it with `VOID_PLATFORM_PROJECT_SECRET_KEY`. After rotation, supply `VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON` with all retained keys and `VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION` with the active key's name. Keep older keys needed to decrypt existing project secrets. These values are used to recreate a missing API Worker; they do not replace the live keys during an ordinary upgrade. Supply them from your secret manager.

### Prepare for disaster recovery

`discover` reconstructs verified installation metadata on another machine. It does not download credentials, key material, or backed-up data. `repair` can then recreate missing installer-owned infrastructure, but it does not recover the data that infrastructure previously held.

Keep a coordinated recovery set for each installation:

- a PostgreSQL backup;
- the installation identity—the JWT signing secret, the email signing secret when email is enabled, and the complete project-encryption keyring—in a secret manager;
- provider-supported backups or exports for every data-bearing provider resource;
- the immutable runtime artifacts and manifest for the installed version or custom source revision.

Capture and label these items as one recovery point so PostgreSQL, provider data, identity, and encryption keys match. Backup and retention capabilities vary by provider and resource; choose and test the supported recovery process for each resource you use.

During a restore, keep platform and application traffic disabled before changing resources. Restore the matching PostgreSQL and provider data with their supported recovery tools, supply the original identity and keyring, and use the preserved runtime artifact. Then run `discover`, preview `repair` with `--plan`, and review every ownership decision and proposed resource change before applying it. Enable traffic only after the restored data and platform health have been verified. Discovery and repair are not substitutes for those backups and do not provide a recovery bypass when required secrets or data are unavailable.

### Where local state lives

Installation records live in `~/.void/platforms/`. Credentials are stored separately in encrypted recovery files, with the encryption key in your operating system's keychain. Keep your original secrets in a password manager for recovery on another machine. Signing and encryption keys that Void generated exist only in these files; to keep your own copy, [supply them when installing](/guide/platform/installation/credentials#signing-and-encryption-keys).

If the keychain isn't available, Void stops before writing secrets. Headless environments can supply `VOID_PLATFORM_RECOVERY_KEY`: a canonical base64-encoded 32-byte key from a secret manager. A temporary CI runner can use a new recovery-encryption key for each run only when every original credential remains available in protected CI secrets, including `VOID_PLATFORM_JWT_SECRET`, `VOID_PLATFORM_EMAIL_SIGNING_SECRET` for an email-enabled installation, and either the original `VOID_PLATFORM_PROJECT_SECRET_KEY` or the complete rotated keyring and active-version pair.

::: details Ownership and interrupted maintenance

Void checks resource ownership and the configured database before making changes. Concurrent maintenance commands are coordinated so one administrator cannot overwrite another's work.

If maintenance is interrupted, rerun the same command. Traffic may stay paused until verification succeeds. Existing routes, domains, and data are preserved.

:::
