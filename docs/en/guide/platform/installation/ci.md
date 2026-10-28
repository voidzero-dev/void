---
outline: deep
---

# Install from CI

For your first installation, follow the [interactive setup](/guide/platform/installation/setup). Use this page when automating a configured installation.

::: details Non-interactive inputs

Inject the following values from protected CI secrets. Do not commit them in a workflow or a plaintext secrets file.

| Environment variable                         | Value from the interactive setup                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                       | Management API token                                                                        |
| `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` | Runtime API token                                                                           |
| `VOID_PLATFORM_DATABASE_URL`                 | Dedicated PostgreSQL URL                                                                    |
| `VOID_PLATFORM_HYPERDRIVE_ID`                | Existing externally managed Hyperdrive ID, when applicable                                  |
| `VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST`       | Origin host of that Hyperdrive; set with its ID and user                                    |
| `VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER`       | Runtime database user of that Hyperdrive; set with its ID and host                          |
| `VOID_PLATFORM_R2_ACCESS_KEY_ID`             | R2 Access Key ID                                                                            |
| `VOID_PLATFORM_R2_SECRET_ACCESS_KEY`         | R2 Secret Access Key                                                                        |
| `VOID_PLATFORM_JWT_SECRET`                   | Original JWT signing secret                                                                 |
| `VOID_PLATFORM_EMAIL_SIGNING_SECRET`         | Dedicated email signing secret when email is enabled                                        |
| `VOID_PLATFORM_PROJECT_SECRET_KEY`           | Original base64-encoded project-encryption key                                              |
| `VOID_PLATFORM_RECOVERY_KEY`                 | Base64-encoded 32-byte key for local encrypted recovery state when no keychain is available |
| `VOID_EMAIL_SENDER_DOMAIN`                   | Optional shared mail domain; requires `VOID_EMAIL_SHARED_ZONE_ID`                           |
| `VOID_EMAIL_SHARED_ZONE_ID`                  | Cloudflare zone ID for that mail domain; requires `VOID_EMAIL_SENDER_DOMAIN`                |

For the default GitHub-only login, also set `VOID_PLATFORM_GITHUB_CLIENT_ID`,
`VOID_PLATFORM_GITHUB_CLIENT_SECRET`, and `VOID_PLATFORM_ADMIN_GITHUB_LOGIN`.
For Google, OIDC, or Access login, pass `--auth-config <path>` using the
[configuration format](/guide/platform/installation/setup#choose-login-methods).
Inject each `clientSecretEnv` named in that file from your CI secret manager.
Automatic Access protection may also need `VOID_PLATFORM_ACCESS_SETUP_TOKEN`
with the [setup permissions](/guide/platform/installation/setup#cloudflare-access).

Use that installation's saved signing and encryption keys on every resume or repair that needs them. After a keyring rotation, use the [complete keyring recovery inputs](/guide/platform/installation/maintenance#manage-an-installation-from-another-machine). The database claim and tables remain after uninstall; use a fresh database for a different installation.

Set both email values to enable email during install or upgrade. Later upgrades reuse the recorded values. If an email-enabled installation has no recorded values, supply both before upgrading.

```sh
void platform install \
  --name team \
  --display-name "Team Void" \
  --account <account-id> \
  --application-domain example.app \
  --zone example.app \
  --yes
```

Mutations require `--yes` in CI; a read-only `--plan` does not. Custom runtimes also require `--runtime <directory>`. For a new installation, run `--plan` with the same account, name, and domain options as the unattended install. If you use `--auth-config`, pass the same file to both commands. Register `<platform-api-url>/auth/callback` when creating a login provider's OAuth or OIDC client manually; automatic Access setup manages its own application. A custom API hostname is optional.

In CI, `upgrade`, `repair`, `enable`, `rollback`, and `install --resume` stop before they change a platform Worker or pause traffic when a platform Worker was changed in the Cloudflare dashboard or with the Cloudflare API, or has an active version without a Void deployment record. See [Platform Workers changed outside Void](/guide/platform/installation/maintenance#workers-changed-outside-void).

:::

## Customize the Platform

To change the platform's implementation or deploy your own build, follow [Platform Development](/guide/platform-development). It covers local development, source builds, and CI for a fork.
