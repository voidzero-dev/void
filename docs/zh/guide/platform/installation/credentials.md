---
outline: deep
---

# 凭据 {#credentials}

在密码管理器中为此平台建立一个条目，集中保存凭据。安装程序询问时，将保存的值粘贴进去即可；大多数凭据无需通过 Shell 环境变量提供。

| 凭据 | 创建方 | 平台为何需要它 |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| 管理 API 令牌 | 你，在 Cloudflare 中创建 | 允许 CLI 在使用域名安装或配置 Access 时修改 DNS 和 Access。 |
| 运行时 API 令牌 | 你，在 Cloudflare 中创建 | 作为 Worker Secret 保存，让平台在终端关闭后仍能部署应用。 |
| PostgreSQL URL | 你，通过数据库提供商创建 | 用于存储平台用户、项目和部署信息。 |
| 登录提供商的客户端 ID 和密钥 | 你，或在使用 Access 登录时由 Void 创建 | 让用户登录平台。 |
| R2 Access Key ID 和 Secret Access Key | 你，在 Cloudflare 中创建 | 让平台签发上传链接，使 `void deploy` 将静态文件直接上传到 R2。 |
| Access 设置令牌和应用访问令牌 | 你，在 Cloudflare 中创建 | 仅在使用 Cloudflare Access 时需要：用于创建和管理 Access 应用。 |
| JWT 签名密钥 | 交互式安装时由 Void 创建 | 为平台登录令牌签名。 |
| 项目加密密钥 | 交互式安装时由 Void 创建 | 加密平台存储的应用 Secret。 |
| 邮件签名密钥 | 启用邮件时由 Void 创建 | 为确认链接和邮件请求签名。 |

## Cloudflare API 令牌 {#runtime-token-permissions}

使用域名安装或配置 Cloudflare Access 时，安装程序会通过 Cloudflare 的 [API 令牌设置](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)引导你分别创建管理令牌和运行时令牌。链接会预选权限，并根据平台显示名称建议令牌名称，但 Cloudflare 表单无法预选区域。使用域名安装时，请将区域策略从 **All Domains（所有域名）** 改为 **Specified Domains（指定域名）**，再选择你的区域。如果将由 Void 创建区域，则两个令牌都应保留 **All Domains（所有域名）**：此时区域还不存在，而运行时令牌需要对它拥有清除缓存的权限。将令牌保存到密码管理器，再粘贴到 CLI 隐藏输入内容的提示中。

使用默认 API 主机名进行 workers.dev 测试时，可以通过浏览器登录授权基础设施设置。Void 还会检查账号级的 Access 要求；如果当前凭据无法读取这些要求，安装程序会请求一个限定范围的 Access 令牌。受保护的应用，以及 Default-Deny（默认拒绝）下的公开应用，都需要持续使用的应用管理令牌，该令牌会加密存储。即使使用 workers.dev，配置 Access 也需要管理令牌。添加域名之前，可以省去区域权限。

浏览器登录不会授予 AI Gateway 访问权限。请为运行时令牌添加 **Account → AI Gateway → Edit（账号 → AI Gateway → 编辑）**，让 Void 能够检查并创建该资源。

管理令牌供 CLI 安装和维护平台。运行时令牌则保存为 Worker Secret，让平台在终端关闭后仍能部署应用。两者是独立的凭据。

请将各个令牌的表单与下方权限清单逐项核对。在提示中输入的管理令牌，会保存在该平台实例加密的本地检查点中，并在继续安装时复用。升级、修复和其他生命周期维护也会使用这个已保存的管理令牌。安装期间，如果令牌被拒绝，可以在提示中更换。显式设置的 `CLOUDFLARE_API_TOKEN` 或 `CF_API_TOKEN` 优先使用。请保留密码管理器中的副本，以便维护或在其他机器上使用；脚本通过 `CLOUDFLARE_API_TOKEN` 提供管理令牌。

::: details 各令牌需要选择的权限

核心平台需要下列权限。Cloudflare 的不同令牌页面可能将写入权限标为 **Edit（编辑）** 或 **Write（写入）**，详见其[权限参考](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。

| 范围 | 权限 | 管理令牌 | 运行时令牌 |
| ------- | ------------------ | ---------- | --------------------------------------- |
| 账号（Account） | Account Settings（账号设置） | 读取（Read） | 读取（Read） |
| 账号（Account） | Workers Scripts | 编辑（Edit） | 编辑（Edit） |
| 账号（Account） | Workers Tail | 读取（Read） | 读取（Read） |
| 账号（Account） | D1 | 编辑（Edit） | 编辑（Edit） |
| 账号（Account） | Workers KV Storage | 编辑（Edit） | 编辑（Edit） |
| 账号（Account） | Workers R2 Storage | 编辑（Edit） | 编辑（Edit） |
| 账号（Account） | Queues（队列） | 编辑（Edit） | 编辑（Edit） |
| 账号（Account） | Hyperdrive | 写入（Write） | 写入（Write） |
| 账号（Account） | Account Analytics（账号分析） | 读取（Read） | 读取（Read） |
| 账号（Account） | AI Gateway | 编辑（Edit） | 通过浏览器登录安装时需要编辑（Edit）权限 |
| 账号（Account） | Containers（容器） | — | 编辑（Edit） |
| 账号（Account） | Cloudchamber | — | 编辑（Edit） |
| 区域（Zone） | Zone（区域） | 读取（Read） | — |
| 区域（Zone） | DNS | 编辑（Edit） | — |
| 区域（Zone） | Workers Routes（Worker 路由） | 编辑（Edit） | — |
| 区域（Zone） | Cache Purge（缓存清除） | — | 清除（Purge） |

当 Void 在安装账号中配置 Access 时，初始管理令牌链接还会预选 **Account → Access: Apps and Policies → Edit（账号 → Access：应用和策略 → 编辑）**，以及 **Account → Access: Organizations, Identity Providers, and Groups → Read（账号 → Access：组织、身份提供商和组 → 读取）**。启用保护还会增加 **Account → Access: Service Tokens → Edit（账号 → Access：服务令牌 → 编辑）**。如果身份验证配置或已保存的设置选择了现有应用，链接会请求 Read（读取）权限，而不是 Edit（编辑）权限。这些权限属于管理令牌，运行时令牌不需要它们。

如果让 Void 创建区域，管理令牌还需要能够创建区域的 **Zone Edit（区域编辑）** 权限。如果区域已经存在，则选择该区域，并授予 Zone Read（区域读取）和 DNS Edit（DNS 编辑）权限。使用嵌套应用域名时，管理令牌还需要 **SSL and Certificates: Read（SSL 和证书：读取）** 权限。支持[项目自定义域名](/zh/guide/platform/installation/domains#project-custom-domains)的平台实例，其运行时令牌需要 **SSL and Certificates: Edit（SSL 和证书：编辑）** 权限。

Void 会在创建资源前检查访问权限。如果提示缺少权限，请为令牌更新所选账号或区域的权限后重试。

:::

## 启用邮件 {#enable-email}

选择一个共享发件域名及其 Cloudflare 区域 ID。邮件区域可以不同于应用区域，但必须属于平台所在的 Cloudflare 账号。

启用邮件前，先为这个确切的共享发件域名启用 [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/)，并确认其 MX 记录指向 Cloudflare。如果使用子域名，在区域的 **Email Routing → Settings → Subdomains（邮件路由 → 设置 → 子域名）** 中添加该名称。Cloudflare 会添加所需的 MX 和 SPF 记录。安装程序在初始化共享邮件功能时只会校验这些记录，不会添加它们。其他域名上已有的邮件服务商记录应予以保留。

启用邮件后，管理员可以[为项目注册邮件域名](/zh/guide/platform/administration/email#registering-email-domains-for-projects)，项目也可以通过运行时令牌注册目标地址。运行时令牌需要下列权限：

| 范围 | 权限 | 访问级别 |
| ------- | ----------------------- | ------ |
| 账号（Account） | Email Routing Addresses（邮件路由地址） | 编辑（Edit） |
| 账号（Account） | Email Sending（邮件发送） | 编辑（Edit） |
| 区域（Zone） | Zone（区域） | 读取（Read） |
| 区域（Zone） | Zone Settings（区域设置） | 编辑（Edit） |
| 区域（Zone） | Email Routing Rules（邮件路由规则） | 编辑（Edit） |

区域权限必须覆盖所有承载邮件的区域，包括上述邮件区域。若要开通向任意收件人发送邮件的 Email Sending，需要 Workers Paid。

对于新平台实例，在运行 `void platform install` 前设置 `VOID_EMAIL_SENDER_DOMAIN` 和 `VOID_EMAIL_SHARED_ZONE_ID`，运行时令牌链接就会预选上述权限。

对于已有平台实例，先为其运行时令牌添加权限。可以在 Cloudflare 控制台编辑该令牌，令牌值不变；也可以将 `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` 设置为一个具备全部运行时权限的新令牌。随后运行：

```sh
VOID_EMAIL_SENDER_DOMAIN=mail.example.com \
VOID_EMAIL_SHARED_ZONE_ID=your-zone-id \
void platform upgrade your-installation-id
```

Void 会记录域名和区域，供后续升级使用；普通升级不能替换这两项。

在 CLI 更改任何配置或暂停流量之前，它会检查运行时令牌能否读取邮件区域，以及该区域的 Email Routing 设置、规则和地址。如果 Cloudflare 拒绝请求，命令会停止，并逐项指出缺少的权限。Void 会保留已保存的运行时令牌，因此可以为同一个令牌添加权限后再次运行命令。此检查无法确认 Edit（编辑）权限或 Email Sending 权限，所以仍需按表格选择这些权限。

未设置 `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` 时，`upgrade`、`repair`、`enable` 和 `rollback` 会检查本机保存的运行时令牌。平台可能已经使用更新的令牌，例如从其他机器设置的新令牌。如果 Cloudflare 不接受本机保存的令牌，CLI 会显示警告，跳过这项检查并继续执行。若要检查平台实际使用的令牌，请将 `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` 设置为该令牌。

安装程序会部署邮件网关、准备共享邮件路由，并在开放平台流量前确认入站邮件已就绪。如果设置失败，请修复错误指出的问题，例如缺少权限、对应域名的 MX 记录不正确或路由冲突，再次运行相同的安装或升级命令。新安装通过 `void platform install --resume --name <installation-id>` 继续；配置修正后，会接着执行已记录的邮件操作。

## R2 上传凭据 {#r2-upload-credentials}

`void deploy --platform void` 会将应用的静态文件直接上传到 R2，不经过平台 API。API 使用一对 R2 密钥为这些文件签发短期上传链接。

安装程序会打开 **R2 token creation（创建 R2 令牌）** 表单，预填根据平台显示名称生成的令牌名称，并预选 **Object Read & Write（对象读写）** 和 **Apply to all buckets in this account (including newly created buckets)（应用于此账号的所有存储桶，包括新建存储桶）**。核对设置后创建账号令牌；如果你的角色要求使用用户令牌，则创建用户令牌。将 **Access Key ID（访问密钥 ID）** 和 **Secret Access Key（秘密访问密钥）** 保存到密码管理器，再将两者粘贴到安装程序中。它们与管理 API 令牌和运行时 API 令牌不同。详见 [R2 令牌说明](https://developers.cloudflare.com/r2/api/tokens/)。

## 签名与加密密钥 {#signing-and-encryption-keys}

**JWT signing key（JWT 签名密钥）**用于为平台登录令牌签名。**Project encryption key（项目加密密钥）**用于加密平台存储的应用 Secret。交互式安装会生成这两个密钥，并保存在本机加密的恢复数据中。本机执行生命周期命令时，会从这里读取密钥。

如果需要自行保留副本，例如在 CI 或其他机器上修复平台，请在安装前创建两个密钥，并设置 `VOID_PLATFORM_JWT_SECRET` 和 `VOID_PLATFORM_PROJECT_SECRET_KEY`。非交互式安装必须设置这两个值。将以下命令运行两次，为两个用途分别生成独立的密钥：

```sh
openssl rand -base64 32
```

将每次生成的结果分别保存到密码管理器。该命令会生成以 base64 编码的 32 个随机字节，适用于上述任一字段。请保留两个原始密钥供恢复使用；继续安装或升级时，不要重新生成。

::: details 生成密钥而不在终端中显示

在 macOS 上，以下命令会将一个符合要求的随机值复制到剪贴板：

```sh
openssl rand -base64 32 | pbcopy
```

将它以 **JWT signing key（JWT 签名密钥）** 的名称保存到密码管理器。再次运行命令，将第二个值保存为 **Project encryption key（项目加密密钥）**。PowerShell 使用 `Set-Clipboard` 替代 `pbcopy`。如果没有 OpenSSL，可以使用密钥管理器的安全生成器，生成以 base64 编码的 32 个随机字节，或运行 `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))'`。

:::

启用邮件时，Void 还会创建独立的 **Email signing key（邮件签名密钥）**，用于确认链接和服务之间的邮件请求。安装程序会将它保存在加密的恢复状态中。如果需要由外部系统保管副本，请将 `VOID_PLATFORM_EMAIL_SIGNING_SECRET` 设置为独立的、至少包含 32 个随机字节的值；这也适用于本地恢复文件不会持久保留的无界面安装。
