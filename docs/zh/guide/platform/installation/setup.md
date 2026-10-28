---
outline: deep
---

# 安装并配置登录 {#install-and-configure-login}

按 Enter 接受建议的区域或显示名称，也可以输入其他值替换。安装名称和应用域名应填写你自己的值；`company`、`example.com` 等都只是占位示例。

如果使用 workers.dev 测试，启动交互式安装，然后按下文选择登录方式：

```sh
void platform install --workers-dev
```

使用域名安装或配置 Access 时，Void 会引导你创建管理 API 令牌，并将其粘贴到隐藏输入内容的提示中。浏览器登录可以预览 DNS，但不能修改 DNS 或配置 Access。创建令牌的链接会根据你的选择预选权限。如果使用现有域名，请按 CLI 提示，将区域策略从 **All Domains（所有域名）** 改为 **Specified Domains（指定域名）**，再选择你的区域。交互式安装无需设置 Shell 环境变量。

::: details 通过 Shell 使用现有管理令牌

设置 `CLOUDFLARE_API_TOKEN`，即可使用已有令牌而不在提示中输入。在 Bash 或 zsh 中，可按以下方式读取，避免显示令牌或将其值写入命令历史：

```sh
printf 'Cloudflare management API token: '
read -rs CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
void platform install
```

PowerShell 中使用：

```powershell
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Cloudflare management API token' -AsSecureString)).Password
void platform install
```

:::

查看 `--plan` 后，运行 `void platform install` 并选择保存的计划，或运行 **Next, run this command to install the platform（接下来，运行此命令安装平台）** 下方输出的命令。两种方式都会将之前的选择带入安装，并检查 Cloudflare 当前状态。请审阅更新后的计划。在 **Apply this plan?（应用此计划？）** 提示中，默认选中 **Yes（是）**；按 Enter 继续输入凭据，或选择 **No（否）** 停止。Void 会打开相应的设置页面，并在终端提供备用链接。已经提供的值会被复用。

保存的计划包含安装选项，包括身份验证配置或自定义运行时的路径，但不包含密钥，也不代表已经授权安装。拒绝计划或取消管理令牌设置后，这些选择仍会保留，供下次尝试使用。

## 选择登录方式 {#choose-login-methods}

安装程序提供 GitHub、Google、通用 OIDC 和 Cloudflare Access 登录。请选择所有希望启用的方式，初始状态下没有预选项。Cloudflare Access 保护与 Access 登录是两个独立选项。选择 GitHub 登录时，按下方 GitHub OAuth 步骤配置。

## 选择谁可以访问应用 {#choose-who-can-access-apps}

安装程序会询问 **Who should be able to access deployed apps?（谁可以访问已部署的应用？）**

- **Same people allowed by the platform’s Access policy（与平台 Access 策略允许的人员相同）**：复用已选的公司身份和策略。启用了平台 Access 保护时，推荐使用此选项。
- **Anyone — public apps（任何人——公开应用）**：允许公开访问。
- **Choose a different Access policy（选择其他 Access 策略）**：为应用选择独立的公司规则。如果未启用平台保护，此选项会显示为 **Set up Cloudflare Access protection（设置 Cloudflare Access 保护）**。

计划会显示默认的应用访问设置。Void 会在开放应用流量前完成并验证应用访问配置；新项目会自动继承所选默认设置。如果设置中断，请使用输出中的继续安装命令。已有平台实例升级时，会保留管理员设置。

应用保护使用托管平台的账号。如果平台登录或保护使用其他账号，请按提示在托管账号中选择对应的身份提供商和策略。API 请使用应用基础域名本身或 workers.dev 主机名，使其不受应用通配域名覆盖。

设置期间，Void 会检查账号级的 Default-Deny（默认拒绝）。对于所在账号要求 Access 规则的公开应用，它会为每个应用及其已验证的自定义域名创建规则。其他子域名保留原有的访问规则。账号级 Default-Deny 会继续启用，Void 不会绕过平台 API 或代理的保护。

应用规则需要 **Access: Apps and Policies Edit（Access：应用和策略，编辑）** 和 **Organizations, Identity Providers, and Groups Read（组织、身份提供商和组，读取）** 权限。Void 会加密保存这个管理令牌，以便之后创建应用或修改域名。安装程序会在为此用途保留仅供设置使用的令牌之前询问你，或引导你创建专用令牌。没有 Default-Deny 的公开应用不需要持续使用的 Access 管理凭据。

在脚本中，使用 `--app-access public|platform|custom`。需要应用规则时，提供 `VOID_PLATFORM_APP_ACCESS_TOKEN`，或在 `--auth-config` 文件中添加 `appAccess` 配置：

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

保留文件中已有的 `connections` 配置。使用 `mode: "platform"` 时，会复用同一账号中选定的身份和策略。无界面设置必须显式提供应用管理令牌，不会悄悄保留仅供安装程序使用的令牌。

## 完成登录配置 {#finish-login-configuration}

对于 Google，创建 OAuth 客户端并注册输出的回调 URL。可以将登录范围限制到指定的 Google Workspace 域。对于 OIDC 或 Access 登录，提供签发者 URL、客户端 ID 和客户端密钥。如果希望已配置的公司策略允许同事自动创建账号，而无需逐个邀请，请选择 **Company-approved users（公司批准的用户）**。

使用可配置的登录设置时，安装程序会输出一次性设置码和 `/setup` URL。输入设置码，以选定的管理员登录方式完成身份验证，核对身份后再确认授予管理员角色。该登录方式随后会启用；其他选定方式会保存为待处理配置，之后在 Settings（设置）中测试并启用。仅使用 Google 或仅使用 OIDC 的安装不需要 GitHub 账号。

在脚本中，通过 `--auth-config <path>` 传入配置文件，其中只包含非敏感配置和用于引用密钥的环境变量名称。例如：

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

`--plan` 可以读取此配置，无需提供其中引用的密钥。实际应用安装计划时，通过密钥管理器提供密钥。

### Cloudflare Access {#cloudflare-access}

可以选择 Access 登录、平台保护，或同时启用两者。平台保护也可搭配 GitHub 或其他登录方式。启用公司批准注册后，通过公司访问校验的同事可以使用 GitHub 创建普通账号，即使其 GitHub 邮箱与公司邮箱不同。

身份提供商决定员工如何登录，例如通过 Okta 或 Google Workspace。Access 策略决定谁可以访问平台，以及需要满足哪些 MFA 或设备要求。

自动设置会使用现有的 Zero Trust 组织、选定的身份提供商，以及已有公司策略。Void 会创建专用应用，并创建一个限定范围的服务令牌，用于受保护平台的安装检查。公司策略会予以保留，包括设备和 MFA 要求。

如果没有合适的策略，请在策略列表中选择 **Allow my company’s email domain（允许我的公司邮箱域名）**，再输入域名。Void 会在账号中创建该 Allow（允许）策略并保留以供复用；之后可以在 Cloudflare 中为它添加 MFA 或设备规则。若需要身份提供商的组或其他规则，请选择 **Create in Cloudflare（在 Cloudflare 中创建）**，再按输出的步骤操作。

Allow（允许）策略必须明确指定谁可以登录：邮箱地址、邮箱域名或列表，身份提供商的组（Okta、Microsoft Entra ID、Google Workspace、GitHub 组织或 SAML），身份验证上下文，Cloudflare 账号成员，或基于上述条件建立的 Access 组。Microsoft Entra ID 组和身份验证上下文仅在来自所选身份提供商时才有效。登录方式本身也可作为有效条件，但它必须属于所选身份提供商，并使用 Cloudflare 的公司目录连接器：Microsoft Entra ID、Okta、OneLogin、PingOne、Centrify、Google Workspace，或启用了 **Restrict to account members（仅限账号成员）** 的 Cloudflare 登录。允许所有人、任意服务令牌或绕过 Access 的策略会被拒绝；仅依赖 One-time PIN（一次性 PIN）、GitHub 等公开登录，或通过通用 **OpenID Connect** / **SAML** 选项添加的登录方式，也会被拒绝，即使该登录方式背后连接的是公司目录。Void 无法判断谁能通过通用登录方式进入；请为该策略添加 Require（必须满足）规则，例如将 **Emails ending in（邮箱地址以指定内容结尾）** 设为公司域名。

设置凭据需要在身份资源所在账号中具备 **Access: Apps and Policies Write（Access：应用和策略，写入）** 和 **Access: Organizations, Identity Providers, and Groups Read（Access：组织、身份提供商和组，读取）** 权限。创建保护还需要 **Access: Service Tokens Write（Access：服务令牌，写入）** 权限。如果在安装账号中设置，初始管理令牌链接已经包含这些权限。Void 会在创建资源前检查 Access 读取权限，并在设置 Access 时复用管理令牌，因此无需第二个 API 令牌。如果 Access 应用位于其他账号，请按提示提供限定到该身份资源账号的令牌。脚本可通过 `VOID_PLATFORM_ACCESS_SETUP_TOKEN` 显式覆盖。平台的运行时令牌不需要 Access 管理权限。详见 Cloudflare 的 [Access API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/) 和[服务令牌权限](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/)。

如需自动设置 Access，在身份验证配置文件中添加：

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

保留上例文件中的 `connections` 列表；也可以使用 `{"id":"access","kind":"cloudflare-access","label":"Company Access"}` 连接，同时创建 Access 登录。如果只设置登录，则省略 `protection`。

若要连接由其他方管理的应用，选择 **Use Access applications your company already manages（使用公司已经管理的 Access 应用）**。输入拥有这些 Access 应用的账号，它可以不同于托管 Void 的账号。在脚本中使用 `mode: "existing"`、可选的 `accountId`，以及 `loginApplicationId` 和/或 `protectionApplicationId`。对于登录，设置 `loginClientSecretEnv`。对于保护，使用已被该应用允许的服务令牌，通过 `serviceToken` 提供其 `id`、`clientIdEnv` 和 `clientSecretEnv`。所选策略必须同时覆盖输出的 API 和代理源地址。连接现有资源需要对其应用、策略、组织、身份提供商、组和服务令牌拥有读取权限；Void 不会修改已有策略。

如果只使用 Access 登录，可以仅凭签发者、客户端 ID 和密钥连接到其他账号，无需 `cloudflareAccess` 配置块或 Cloudflare 管理令牌。请按 Cloudflare 的 [OIDC 应用指南](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/)操作，并注册 Void 输出的确切回调地址。

### GitHub {#github}

使用 GitHub 登录时：

1. 需要 OAuth 凭据时，安装程序会打开 [GitHub 新建 OAuth App 表单](https://github.com/settings/applications/new)。请使用将拥有此登录集成的账号登录。
2. 将 **Application name（应用名称）** 设置为平台显示名称，将 **Homepage URL（主页 URL）** 设置为 Void 刚输出的 API URL。
3. 将 **Redirect URI（重定向 URI）**，也称为 **Authorization callback URL（授权回调 URL）**，设置为输出中以 `/auth/callback` 结尾的确切 URL，然后注册应用。此 URL 已固定在保存的草稿中，即使凭据设置中断也不会改变。
4. 保存 **Client ID（客户端 ID）**，生成 **Client Secret（客户端密钥）** 后也将其保存。表单说明见 GitHub 的[注册指南](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)。

此 OAuth App 用于处理登录。

## 完成安装 {#finish-installation}

安装程序会收集运行时令牌、PostgreSQL URL、登录提供商凭据和 R2 凭据，并生成[签名与加密密钥](/zh/guide/platform/installation/credentials#signing-and-encryption-keys)。密钥值会隐藏显示，设置进度则借助系统钥匙串加密保存。请在密码管理器中保留副本，以便在其他机器上恢复。

安装完成后，打开输出的管理员控制台链接。如果只启用 GitHub 登录，使用安装时选择的管理员身份登录。如果使用可配置的登录方式，则使用一次性 `/setup` 码确认管理员身份。通过输出的 API URL [连接并部署应用](/zh/guide/platform/installation/first-deployment)。

如果通过 Shell 提供了管理令牌，完成后将它从环境变量中移除：

```sh
unset CLOUDFLARE_API_TOKEN
```

PowerShell 中使用 `Remove-Item Env:CLOUDFLARE_API_TOKEN`。请保留已保存的令牌，以便后续维护。

::: details 安装因 DNS 暂停或意外中断时

如果区域由 Void 创建，安装会停在 `waiting-for-dns` 状态，并输出域名服务器地址。在注册商处设置这些地址，等待区域生效，再使用 Void 输出的安装 ID 继续：

```sh
void platform install --resume --name <installation-id>
```

继续安装时，会复用已保存的管理令牌；如果令牌缺失或被 Cloudflare 拒绝，则会要求提供令牌。也可以通过 `CLOUDFLARE_API_TOKEN` 覆盖。使用源码构建时，还应传入相同的 `--runtime` 目录。继续安装依赖已保存的检查点和原始密钥；不要启动第二次安装，也不要生成替代密钥。如果中断发生在保存检查点之前，请重新运行 `void platform install` 并选择保存的计划，或重新运行原命令。

也可以重新运行 `void platform install`，为未完成的平台实例选择 **Continue setup（继续设置）**。非交互式恢复使用 `--resume --name <id>`。已完成安装的平台通过 `platform status`、`repair` 或 `upgrade` 管理。

继续安装会恢复所选的 Hyperdrive。如果保存的检查点中缺少这个选择，请在继续时添加 `--hyperdrive <existing-id>`，使用最初选择的同一个配置。

如果在继续设置凭据时，Cloudflare 拒绝了已保存的运行时令牌，Void 会打开令牌页面，并在本次运行中要求更换。缺少[邮件权限](/zh/guide/platform/installation/credentials#enable-email)时，不会丢弃已保存的令牌：为同一个令牌添加权限，再继续安装即可。网络或服务故障也不会导致已保存的令牌被丢弃。通过环境变量提供的令牌则必须在环境变量中修正。

:::
