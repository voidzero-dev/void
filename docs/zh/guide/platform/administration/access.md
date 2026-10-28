---
outline: deep
---

# 登录与访问权限 {#sign-in-and-access}

## 登录 {#signing-in}

使用浏览器管理界面时，打开 `<API URL>/admin`，使用安装时选定的管理员登录方式。新安装的平台应按照输出的管理员设置说明，创建首个管理员用户。无需先创建应用或通过 CLI 登录。

连接平台的 API URL，再以管理员身份登录：

```sh
void connect platform.example.com --no-login
void platform auth login
```

第一条命令保存连接。第二条命令打开浏览器供你登录，并将管理员会话保存在系统钥匙串中。会话有效期为一小时，各平台的会话独立存储。

你随时可以查看当前登录的账号：

```sh
void platform auth status
```

该命令会显示账号、会话到期时间和平台可用功能。要结束会话，运行 `void platform auth logout`。

如果平台受到 Cloudflare Access 保护，`void connect <url>` 会先完成企业登录，再进入 Void 登录。交互式 Access 认证使用本地安装的 `cloudflared`，并按平台的源将短期凭据保存在系统钥匙串中，无需复制浏览器 cookie。

在 CI 中，使用[项目部署令牌](/zh/guide/platform/installation/first-deployment)，同时将 Access 凭据按源保存到 `VOID_ACCESS_CREDENTIALS`。Access 服务令牌本身不能授权 Void 部署。所需的源和数据结构见 [CI 部署设置](/zh/guide/platform/installation/first-deployment)。

## 选择平台 {#choosing-a-platform}

如果你管理多个平台，可以列出连接并选择默认连接：

```sh
void platform list
void platform use <connection-id>
```

也可以通过 `--connection` 仅为本次命令选择平台：

```sh
void platform user list --connection <connection-id>
```

使用连接列表中的 ID 或 URL。管理命令始终使用这一选择，即使在部署目标不同的应用目录内运行也是如此。

## 恢复管理员登录 {#recovering-administrator-login}

如果所有管理员都无法使用已配置的身份提供方，平台安装所有者可以通过 Cloudflare 管理权限、数据库直连权限，以及原始的加密恢复凭据，恢复已有管理员的访问：

```sh
void platform config auth recover company --installation <id> --file recovery.json
```

该文件用于标识已有账号，例如 `{"administratorUserId":"existing-admin-id"}`。恢复过程会发起真实的登录测试，并在恢复访问前要求你确认具体身份，不会创建新管理员。要更换身份提供方，请使用新的连接 ID，在文件中包含不含机密的 `configuration`，并通过 `--client-secret-env <name>` 提供密钥。要轮换现有提供方的密钥，请保留其连接 ID 和身份配置。

使用 `--yes` 时，还必须在文件中设置 `expectedIdentity`，固定准确的 `issuer` 和 `subject`。仍然需要在浏览器中成功登录。开始恢复前，可以使用 `--plan` 预览受影响的管理员和连接。

## 授予用户访问权限 {#giving-people-access}

在管理员界面打开 **Settings（设置）**，或运行 `void platform config auth`，以添加、测试、启用或禁用登录方式。访问防护与登录方式是独立设置。测试身份提供方时，会先显示已认证的账号，再由你明确关联身份或启用配置。

安装后要更改企业访问门禁，请在安装平台的工作站上使用已保存的恢复凭据：

```sh
void platform config auth protection show
void platform config auth protection enable --installation <id>
void platform config auth protection disable --installation <id>
```

启用时，可以创建 Access 应用或连接已有应用。系统会检查每个 API、代理和已配置的控制台源，并要求企业用户登录。更改防护会结束当前所有人员登录会话，之后需要重新登录。在移除用于企业注册的门禁前，请选择另一条已验证的企业规则，或改为限制注册。移除防护后，Cloudflare 应用仍会保留，供你明确决定如何清理。禁用 Access 登录方式不会移除门禁。

用户可以通过 `void account link <connection-id>`，或可选控制台中的 **Account（账号）**，为已有账号添加另一种已启用的登录方式。如果提示重新登录，请先登录，再通过额外的身份提供方认证，并确认页面显示的身份。仅凭邮箱相同，不会自动关联账号。

在管理控制台中，打开 **People → Access（人员 → 访问权限）**，选择谁可以加入、邀请用户，并管理单独的注册授权。选择 **Company-approved or individually approved users（企业批准或单独批准的用户）** 后，符合已配置企业规则的人可以自动创建账号，同时仍允许明确的邀请和允许名单授权。在任何人到达登录页面之前，平台边缘的企业访问防护仍会生效。

选择仅邀请或允许名单注册后，可以将同事的 GitHub 登录名加入允许名单，让其通过 GitHub 加入：

```sh
void platform signup allow github teammate
```

Void 会显示变更并要求确认。之后，同事即可使用平台 URL 运行 `void connect` 并登录。

你也可以用相同方式允许某个邮箱地址或整个邮箱域名：

```sh
void platform signup allow email teammate@example.com
void platform signup allow email '*@example.com'
```

邮箱匹配模式适用于平台的所有登录提供方。请用引号包裹域名模式，让 shell 将 `*` 原样传给 Void。

对于未提供已验证邮箱的 OIDC 登录，请改为通过登录连接和提供方的稳定主体标识授权该身份：

```sh
void platform signup allow identity company-sso 'Employee-42'
```

使用 `void platform config auth list` 显示的连接 ID，以及身份提供方返回的精确主体标识。匹配区分大小写，不会推断邮箱或关联其他账号。该登录方式配置的域名或群组限制仍然适用，账号会以普通用户身份加入。使用 `void platform signup disallow identity company-sso 'Employee-42'` 移除该授权。

要通过邮件邀请其他人，运行：

```sh
void platform invitation send alex@example.org
```

邀请只会授予该精确邮箱地址的注册权限。受邀者必须使用能提供同一个已验证邮箱的登录方式。配置了平台邮件投递后，Void 还会发送连接说明。如果邮件不可用或投递失败，授权仍然有效：请自行将平台的 `/invite` 页面或 `void connect '<platform URL>'` 命令分享给受邀者。管理控制台会单独显示投递结果，与邀请的待接受、已接受或已撤销状态分开呈现。

查看当前访问设置和邀请：

```sh
void platform signup show
void platform invitation list
```

相关账号被移除后，邀请历史仍会保留。即使该账号的登录方式已不存在，记录中的操作人 ID 仍然可见。

`void platform signup open` 允许任何人注册。所有注册用户都可以在你的应用域名上部署应用，因此开放注册前，请了解这些应用如何[共享 cookie](/zh/guide/platform/installation/domains#adding-a-domain)。使用 `void platform signup restrict` 可以重新要求匹配允许名单。移除允许名单条目只影响未来注册，不会暂停已有账号。

## 已连接应用 {#connected-apps}

通过[已连接应用](/zh/guide/platform/administration/connected-apps)将独立应用注册为 OAuth 客户端。用户连接自己的身份，并在 Void 上逐次批准发布。
