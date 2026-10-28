---
outline: deep
---

# Install and Configure Login

Press Enter to accept a suggested zone or display name, or type to replace it. Enter your own installation name and application domain; examples such as `company` and `example.com` are placeholders.

For workers.dev testing, start the interactive install and choose your login method below:

```sh
void platform install --workers-dev
```

For a domain installation or Access setup, Void guides you to create a management API token and paste it into a masked prompt. Browser login can preview DNS, but cannot change it or configure Access. The token-creation link preselects the permissions for your choices. When using an existing domain, change the zone policy from **All Domains** to **Specified Domains** and select your zone, as the CLI prompt describes. No shell environment variable is needed for interactive installation.

::: details Use an existing management token from the shell

Set `CLOUDFLARE_API_TOKEN` to use an existing token instead of the prompt. In Bash or zsh, read it without displaying it or putting its value in command history:

```sh
printf 'Cloudflare management API token: '
read -rs CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
void platform install
```

In PowerShell:

```powershell
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Cloudflare management API token' -AsSecureString)).Password
void platform install
```

:::

After reviewing `--plan`, run `void platform install` and select your saved plan, or run the command printed under **Next, run this command to install the platform**. Both carry your choices into installation and check the current Cloudflare state. Review the refreshed plan. At **Apply this plan?**, **Yes** is selected; press Enter to continue to the credential prompts, or choose **No** to stop. Void opens the relevant setup pages and provides fallback links in the terminal. It reuses values you have already supplied.

Saved plans contain your installation choices, including paths to any authentication configuration or custom runtime. They contain no secrets or approval to install. Declining the plan or cancelling management-token setup keeps those choices for your next attempt.

## Choose login methods

The installer offers GitHub, Google, generic OIDC, and Cloudflare Access login. Select all methods you want to enable; none are selected initially.
Cloudflare Access protection is a separate choice from Access login. The
GitHub OAuth steps below apply when you select GitHub login.

## Choose who can access apps

The installer asks **Who should be able to access deployed apps?**

- **Same people allowed by the platform’s Access policy** reuses your selected company identities and policies. This is recommended when platform Access protection is enabled.
- **Anyone — public apps** allows public visits.
- **Choose a different Access policy** selects separate company rules for apps. Without platform protection, this option is **Set up Cloudflare Access protection**.

The plan shows the default app access. Void finishes and verifies app access before
opening application traffic; new projects inherit the selected default automatically.
If setup stops, use the printed resume command. Existing installations retain their
administrator settings during upgrades.

App protection uses the account hosting your platform. If platform login or
protection uses another account, select equivalent identity providers and policies
in the hosting account when prompted. Use the app domain’s apex or a workers.dev
hostname for the API so it stays outside the app wildcard.

Void checks account-wide Default-Deny during setup. For public apps in an account
that requires Access rules, it creates rules for each app and its verified custom
domains. Other subdomains keep their existing access rules. It leaves account-wide
Default-Deny enabled and does not bypass the platform API or proxy.

App rules need **Access: Apps and Policies Edit** and **Organizations, Identity
Providers, and Groups Read**. Void stores this management token encrypted for future
apps and domain changes. The installer asks before retaining a setup-only token for
that purpose, or guides you to create a dedicated token. Public apps without
Default-Deny need no ongoing Access-management credential.

For scripts, use `--app-access public|platform|custom`. Supply
`VOID_PLATFORM_APP_ACCESS_TOKEN` when app rules are needed, or add an `appAccess`
section to your `--auth-config` file:

```json
{
  "appAccess": {
    "mode": "custom",
    "identityProviderIds": ["hosting-account-identity-provider-id"],
    "policyIds": ["hosting-account-company-policy-id"],
    "tokenEnv": "APP_ACCESS_API_TOKEN"
  }
}
```

Keep the file’s existing `connections` configuration. For `mode: "platform"`,
same-account identity and policy selections are reused. Headless setup requires an
explicit app-management token; it never silently retains an installer-only token.

## Finish login configuration

For Google, create an OAuth client and register the printed callback URL. You
can restrict it to named Google Workspace domains. For OIDC or Access login,
provide the issuer URL, client ID, and client secret. Select **Company-approved
users** when the configured company policy should allow colleagues to create
accounts automatically without individual invitations.

When using the configurable setup, installation prints a one-time setup code
and a `/setup` URL. Enter the code, authenticate with the chosen administrator
method, and review the identity before confirming its administrator role. That
method becomes enabled; additional selected methods are saved as pending
configurations to test and enable in Settings. No GitHub account is required
for a Google-only or OIDC-only installation.

For scripts, pass `--auth-config <path>` with nonsecret configuration and
environment-variable references for secrets. For example:

```json
{
  "connections": [
    {
      "configuration": {
        "id": "google",
        "kind": "google",
        "label": "Company Google",
        "clientId": "your-google-client-id",
        "allowedDomains": ["example.com"]
      },
      "clientSecretEnv": "GOOGLE_CLIENT_SECRET"
    }
  ],
  "administratorConnectionId": "google",
  "admission": {
    "mode": "company",
    "connections": ["google"],
    "access": false
  }
}
```

`--plan` reads this configuration without requiring the referenced secret.
Supply the secret through your secret manager when applying the installation.

### Cloudflare Access

Choose Access login, platform protection, or both. Protection can also be used
with GitHub or another login method. With company-approved signup, a colleague
who passes the company gate can create an ordinary account using GitHub even
when their GitHub email differs from their company email.

Your identity provider determines how employees sign in, such as through Okta or
Google Workspace. Your Access policies determine who can reach the platform and
which MFA or device requirements apply.

Automatic setup uses an existing Zero Trust organization, selected identity
providers, and existing company policies. Void creates dedicated applications
and a scoped service token for protected installation checks. It preserves your
company policies, including device and MFA requirements.

If no policy fits, choose **Allow my company’s email domain** in the policy list
and enter your domains. Void creates that Allow policy in your account and keeps
it there for reuse; you can add MFA or device rules to it in Cloudflare later.
For identity-provider groups or other rules, choose **Create in Cloudflare** and
follow the printed steps.

An Allow policy must name who may sign in: emails, email domains or lists,
identity-provider groups (Okta, Microsoft Entra ID, Google Workspace, GitHub
organizations, or SAML), authentication contexts, members of a Cloudflare
account, or Access groups built from them. Microsoft Entra ID groups and
authentication contexts count only when they come from an identity provider you
select. A login method also counts when it is one of the identity providers you select and uses
Cloudflare's connector for a company directory: Microsoft Entra ID, Okta,
OneLogin, PingOne, Centrify, Google Workspace, or the Cloudflare login with
**Restrict to account members** turned on. Policies that allow everyone, any
service token, or bypass Access are rejected, and so are policies that rely
only on One-time PIN, a public login such as GitHub, or a login added with the
generic **OpenID Connect** or **SAML** option, even one that fronts your
company directory. Void cannot tell who can sign in through a generic login;
add a Require rule such as **Emails ending in** your company domain to that
policy.

The setup credential needs **Access: Apps and Policies Write** and
**Access: Organizations, Identity Providers, and Groups Read** in the identity
account. Creating protection also needs **Access: Service Tokens Write**.
For setup in the installation account, the initial management-token link includes
these permissions. Void checks Access reads before provisioning and reuses that
management token during Access setup, so you do not need a second API token.
For applications in another account, provide a token scoped to that identity
account when asked. Scripts can supply an explicit override through
`VOID_PLATFORM_ACCESS_SETUP_TOKEN`. The platform's runtime token does not need
Access management permissions. See Cloudflare's
[Access API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/)
and [service-token permissions](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/).

To automate Access setup, add this to the authentication configuration file:

```json
{
  "protection": true,
  "cloudflareAccess": {
    "mode": "create",
    "identityProviderIds": ["your-company-identity-provider-id"],
    "policyIds": ["your-company-allow-policy-id"]
  }
}
```

Keep the file's `connections` list from the example above, or use a connection
with `{"id":"access","kind":"cloudflare-access","label":"Company Access"}`
to create Access login as well. Omit `protection` for login-only setup.

To connect applications managed elsewhere, select **Use Access applications your company already manages**.
Enter the account that owns the Access applications; it can differ from the
account hosting Void.
Scripts use `mode: "existing"`, optional `accountId`, and `loginApplicationId`
and/or `protectionApplicationId`. For login, set `loginClientSecretEnv`. For
protection, supply `serviceToken` with `id`, `clientIdEnv`, and `clientSecretEnv`
for a token already admitted by the application. The selected policies must
cover both printed API and proxy origins. Connecting existing resources needs
read access to their applications, policies, organization, identity providers,
groups, and service tokens; Void leaves their policies unchanged.

Access login alone can connect to another account using only its issuer, client
ID, and secret, without a `cloudflareAccess` block or Cloudflare management token.
Follow Cloudflare's [OIDC application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/)
and register the exact callback printed by Void.

### GitHub

For GitHub login:

1. The installer opens [GitHub's new OAuth App form](https://github.com/settings/applications/new) when it needs OAuth credentials. Sign in as the account that will own the login integration.
2. Set **Application name** to your platform's display name and **Homepage URL** to the API URL Void just printed.
3. Set the **Redirect URI** (also called **Authorization callback URL**) to the exact printed URL ending in `/auth/callback`, then register the application. This URL is now pinned in your saved draft and remains the same if credential setup is interrupted.
4. Save the **Client ID**, generate a **Client Secret**, and save that too. GitHub's [registration guide](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) describes the form.

This OAuth App handles sign-in.

## Finish installation

The installer collects your runtime token, PostgreSQL URL, login-provider credentials, and R2 credentials, and generates the [signing and encryption keys](/guide/platform/installation/credentials#signing-and-encryption-keys). It masks secret values and saves setup progress encrypted through your system keychain. Keep a password-manager copy for recovery on another machine.

Once installation finishes, open the printed admin dashboard link. For GitHub-only setup, sign in as the administrator selected during installation. For configurable login, use the one-time `/setup` code to confirm the administrator’s identity. Use the printed API URL to [connect and deploy an app](/guide/platform/installation/first-deployment).

If you supplied a management token through the shell, remove it when finished:

```sh
unset CLOUDFLARE_API_TOKEN
```

In PowerShell, use `Remove-Item Env:CLOUDFLARE_API_TOKEN`. Keep the saved token for future maintenance.

::: details If setup pauses for DNS or is interrupted

If Void created a zone, it stops in `waiting-for-dns` and prints nameservers. Set those at your registrar, wait for the zone to become active, then resume using the installation ID printed by Void:

```sh
void platform install --resume --name <installation-id>
```

Resume reuses the saved management token and asks for one if it is missing or rejected by Cloudflare. You can override it through `CLOUDFLARE_API_TOKEN`. When using a source build, also pass the same `--runtime` directory. Resume uses the saved checkpoint and original secrets; do not start a second installation or generate replacement keys. If setup stopped before a checkpoint was saved, rerun `void platform install` and select your saved plan, or rerun the original command.

You can also rerun `void platform install` and choose **Continue setup** for an unfinished installation. For non-interactive recovery, use `--resume --name <id>`. Manage completed platforms with `platform status`, `repair`, or `upgrade`.

Resume restores your selected Hyperdrive. If that selection is missing from the saved checkpoint, add `--hyperdrive <existing-id>` when resuming, using the same configuration you originally selected.

If Cloudflare rejects a saved runtime token during continued credential setup, Void opens the token page and asks for a replacement in the same run. A missing [email permission](/guide/platform/installation/credentials#enable-email) does not discard the saved token: add the permission to the same token, then resume. Network or service failures do not discard saved tokens. Tokens supplied through the environment must be corrected there instead.

:::
