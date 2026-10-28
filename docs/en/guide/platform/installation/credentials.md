---
outline: deep
---

# Credentials

Keep one password-manager entry for this platform. Paste the saved values into the installer when asked; most do not need shell environment variables.

| Credential                             | Created by                       | Why the platform needs it                                                                |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Management API token                   | You, in Cloudflare               | Lets the CLI change DNS and Access for a domain installation or Access setup.            |
| Runtime API token                      | You, in Cloudflare               | Stored as a Worker secret so the platform can deploy apps after you close your terminal. |
| PostgreSQL URL                         | You, with your database provider | Stores platform users, projects, and deployments.                                        |
| Login provider client ID and secret    | You, or Void for Access login    | Signs people in to the platform.                                                         |
| R2 Access Key ID and Secret Access Key | You, in Cloudflare               | Lets the platform sign upload links so `void deploy` sends static files straight to R2.  |
| Access setup and app-access tokens     | You, in Cloudflare               | Only with Cloudflare Access: create and manage Access applications.                      |
| JWT signing key                        | Void, on interactive installs    | Signs platform login tokens.                                                             |
| Project encryption key                 | Void, on interactive installs    | Encrypts app secrets stored by your platform.                                            |
| Email signing key                      | Void, when email is enabled      | Signs confirmation links and email requests.                                             |

## Cloudflare API Tokens {#runtime-token-permissions}

For a domain installation or Cloudflare Access setup, the installer guides you through creating separate management and runtime tokens using Cloudflare's [API token setup](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/). Its links preselect the permissions and suggest names based on your platform's display name, but Cloudflare's form cannot preselect a zone: for a domain installation, change the zone policy from **All Domains** to **Specified Domains** and select your zone. If Void will create the zone, keep **All Domains** on both tokens: the zone does not exist yet, and the runtime token needs it to purge cache. Save the tokens in your password manager and paste them into the masked CLI prompts.

For workers.dev testing with the default API hostname, browser login can authorize
infrastructure setup. Void also checks account-wide Access requirements; if the
current credential cannot read them, the installer asks for a scoped Access token.
Protected apps and public apps under Default-Deny need an ongoing app-management
token, stored encrypted. Access setup requires a management token even on
workers.dev. Skip zone permissions until you add a domain.

Browser login does not grant AI Gateway access. Include **Account → AI Gateway → Edit** on the runtime token so Void can verify and create that resource.

The management token lets your CLI install and maintain the platform. The runtime token is stored as a Worker secret so the platform can deploy apps after you close your terminal. They are separate credentials.

Compare each token's form with the permission checklist below. The installer saves a management token entered at the prompt in this installation’s encrypted local checkpoint and reuses it on resume. Upgrades, repairs, and other lifecycle maintenance also use that saved management token. During installation, a rejected token can be replaced at the prompt. An explicit `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN` takes precedence. Keep your password-manager copy for maintenance or another machine; scripts supply it through `CLOUDFLARE_API_TOKEN`.

::: details Permissions to select for each token

Use the following permissions for the core platform. Cloudflare may label write access as **Edit** or **Write**, depending on the token screen; see its [permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

| Scope   | Permission         | Management | Runtime                                 |
| ------- | ------------------ | ---------- | --------------------------------------- |
| Account | Account Settings   | Read       | Read                                    |
| Account | Workers Scripts    | Edit       | Edit                                    |
| Account | Workers Tail       | Read       | Read                                    |
| Account | D1                 | Edit       | Edit                                    |
| Account | Workers KV Storage | Edit       | Edit                                    |
| Account | Workers R2 Storage | Edit       | Edit                                    |
| Account | Queues             | Edit       | Edit                                    |
| Account | Hyperdrive         | Write      | Write                                   |
| Account | Account Analytics  | Read       | Read                                    |
| Account | AI Gateway         | Edit       | Edit when installing with browser login |
| Account | Containers         | —          | Edit                                    |
| Account | Cloudchamber       | —          | Edit                                    |
| Zone    | Zone               | Read       | —                                       |
| Zone    | DNS                | Edit       | —                                       |
| Zone    | Workers Routes     | Edit       | —                                       |
| Zone    | Cache Purge        | —          | Purge                                   |

When Void configures Access in the installation account, the initial management-token link also selects **Account → Access: Apps and Policies → Edit** and **Account → Access: Organizations, Identity Providers, and Groups → Read**. Protection adds **Account → Access: Service Tokens → Edit**. When the authentication configuration or saved setup selects existing applications, the link requests Read access instead of Edit. These permissions belong to the management token; the runtime token does not need them.

The management token also needs **Zone Edit** with authority to create zones if you ask Void to create the zone. If it already exists, use the selected zone with Zone Read and DNS Edit. Nested application domains additionally need **SSL and Certificates: Read** on the management token. An installation with [project custom domains](/guide/platform/installation/domains#project-custom-domains) needs **SSL and Certificates: Edit** on the runtime token.

Void checks access before provisioning. If it reports a missing permission, update the token's permissions for the selected account or zone and retry.

:::

## Enable Email {#enable-email}

Choose a shared sender domain and its Cloudflare zone ID. The mail zone may differ from the application zone, but it must belong to the platform's Cloudflare account.

Before you enable email, enable [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/) for the exact shared sender domain and confirm that its MX records point to Cloudflare. For a subdomain, add that name under the zone's **Email Routing → Settings → Subdomains**. Cloudflare adds the required MX and SPF records. The installer's shared-mail bootstrap verifies those records; it does not add them. Keep existing mail-provider records on other domain names in place.

Enabling email lets administrators [register email domains for projects](/guide/platform/administration/email#registering-email-domains-for-projects) and lets projects register destination addresses through the runtime token. The runtime token needs these permissions:

| Scope   | Permission              | Access |
| ------- | ----------------------- | ------ |
| Account | Email Routing Addresses | Edit   |
| Account | Email Sending           | Edit   |
| Zone    | Zone                    | Read   |
| Zone    | Zone Settings           | Edit   |
| Zone    | Email Routing Rules     | Edit   |

The zone permissions must include each zone that will carry mail, including the mail zone. Email Sending onboarding for arbitrary recipients needs Workers Paid.

For a new installation, set `VOID_EMAIL_SENDER_DOMAIN` and `VOID_EMAIL_SHARED_ZONE_ID` before `void platform install`. The runtime-token link then preselects these permissions.

For an existing installation, add the permissions to its runtime token first. Edit the token in the Cloudflare dashboard. The token value stays the same. Or set `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` to a new token that has all runtime permissions. Then run:

```sh
VOID_EMAIL_SENDER_DOMAIN=mail.example.com \
VOID_EMAIL_SHARED_ZONE_ID=your-zone-id \
void platform upgrade your-installation-id
```

Void records the domain and zone for later upgrades; an ordinary upgrade cannot replace them.

Before the CLI changes anything or pauses traffic, it checks that the runtime token can read the mail zone and its Email Routing settings, rules, and addresses. If Cloudflare denies a request, the command stops and names each missing permission. Void keeps a saved runtime token, so you can add the permission to the same token and run the command again. The check cannot confirm Edit access or Email Sending, so select those permissions as the table shows.

Without `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`, `upgrade`, `repair`, `enable`, and `rollback` check the runtime token saved on this machine. The platform can use a newer token, for example one set from another machine. If Cloudflare does not accept the saved token, the CLI shows a warning and continues without the check. To check the token that the platform uses, set `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` to it.

The installer deploys the email gateway, prepares the shared mail route, and verifies inbound readiness before opening platform traffic. If setup fails, fix the problem that the error names, for example a missing permission, the exact-domain MX records, or a routing conflict. Then run the same install or upgrade command again. A fresh install resumes with `void platform install --resume --name <installation-id>`; it continues the recorded email operation after the configuration is corrected.

## R2 Upload Credentials

`void deploy --platform void` uploads your app's static files straight to R2 instead of through the platform API. The API signs short-lived upload links for them with an R2 key pair.

The installer opens the **R2 token creation** form with a token name based on your platform's display name, **Object Read & Write**, and **Apply to all buckets in this account (including newly created buckets)** preselected. Review the settings and create an account token, or a user token if your role requires it. Save its **Access Key ID** and **Secret Access Key** in your password manager, then paste both into the installer. These differ from the management and runtime API tokens. See [R2’s token instructions](https://developers.cloudflare.com/r2/api/tokens/).

## Signing and Encryption Keys {#signing-and-encryption-keys}

The **JWT signing key** signs platform login tokens. The **Project encryption key** encrypts app secrets stored by your platform. An interactive install generates both and keeps them in this machine's encrypted recovery data. Lifecycle commands on this machine read them from there.

To keep your own copy, for example to repair the platform from CI or another machine, create both keys before installing and set `VOID_PLATFORM_JWT_SECRET` and `VOID_PLATFORM_PROJECT_SECRET_KEY`. Non-interactive installs must set both. Generate a separate key for each by running this command twice:

```sh
openssl rand -base64 32
```

Save each result in your password manager. The command generates 32 random bytes encoded as base64, suitable for either field. Keep the two original keys for recovery; do not regenerate them when resuming or upgrading.

::: details Generate the keys without printing them to your terminal

On macOS, this copies a suitable random value to the clipboard:

```sh
openssl rand -base64 32 | pbcopy
```

Paste it into your password manager as **JWT signing key**. Run the command again and save the second value as **Project encryption key**. On PowerShell, use `Set-Clipboard` instead of `pbcopy`. If OpenSSL is unavailable, use your secret manager's secure generator for 32 random bytes in base64, or `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'`.

:::

When email is enabled, Void also creates an independent **Email signing key** for confirmation links and service-to-service email requests. The installer keeps it in encrypted recovery state. Set `VOID_PLATFORM_EMAIL_SIGNING_SECRET` to a separate value of at least 32 random bytes when you need an externally custodied copy, including a headless installation whose local recovery files will not persist.
