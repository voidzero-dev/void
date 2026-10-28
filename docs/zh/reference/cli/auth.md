---
outline: deep
---

# 连接与身份验证 {#connect}

```sh
void connect
void connect platform.example.com
void connect --platform cloudflare
void connect --platform void
```

将项目连接到部署目标。不带参数时，可以交互式选择 Cloudflare 或 Void 平台。传入 URL 会直接选择对应的 Void 平台。使用 `--platform void` 时，可以选择已保存的平台，也可以输入其他 URL。

也可以只输入主机名：`void connect platform.example.com` 会通过 HTTPS 连接。回环地址（`localhost`、`127.0.0.1` 和 `[::1]`）默认使用 HTTP，因此连接本地平台时可以使用 `void connect localhost:8787`。交互式提示也支持这种写法。显式指定协议即可覆盖默认值，例如 `void connect https://localhost:8787`。

连接 Cloudflare 时，Void 会在需要时通过浏览器登录，选择有权访问的账号，并将 `cloudflare.account_id` 保存到 `void.config.ts`，或保存到 `void.lock.json` 的已解析状态中。此设置与 `void init` 共用。已有的账号选择会保留；如果账号设置冲突或账号不可访问，需要先解决问题才能继续。

连接 Void 平台时，Void 会检查连接，并在需要时通过浏览器登录。各平台的凭据会分别保存在系统钥匙串中。

部署目标偏好保存在 `.void/project.json` 中。连接其他 Void 平台时，已有的项目关联会保留；如果该关联或环境变量覆盖仍指向另一个目标，CLI 会说明原因。使用 `void project link` 可以明确选择项目。选择 Cloudflare 时也会保留已有的 Void 项目元数据，方便以后切换回来。

在非交互式 Shell 中，需要提供 URL 或明确指定目标。Cloudflare 要求有可用的凭据，并且账号能够唯一确定，必要时设置 `CLOUDFLARE_ACCOUNT_ID`。连接 Void 平台时，提供 `VOID_TOKEN` 和与其对应的 `VOID_API_URL`，或复用钥匙串中对该平台源地址有效的会话。使用 `void connect <url> --no-login` 可以保存已验证的连接而不进行身份验证；此选项仅适用于 Void 平台。

## 身份验证 {#authentication}

`void auth login`、`void auth status` 和 `void auth logout` 使用 `void init` 或 `void connect` 为当前项目保存的目标。如果尚未保存目标，交互式命令会让你选择 Cloudflare 或已连接的 Void 平台。在非交互式 Shell 中，请传入 `--platform cloudflare|void`，或明确使用 `void cloudflare` 和 `void account` 命令。为身份验证选择目标，不会改变项目的部署目标。

## Void 平台账号 {#void-platform-account}

### `void account login` {#void-account-login}

通过浏览器，使用平台当前启用的任一方式登录。令牌保存在操作系统钥匙串中，作用范围限定为该平台的源地址。钥匙串不可用时，登录会失败，不会将令牌写入明文文件；无图形界面的环境应通过密钥管理服务提供 `VOID_TOKEN`。

登录前，先通过 `void connect <url>` 连接平台。如果旧的项目关联没有记录平台 URL，请先连接平台，再运行 `void project link` 重新选择项目。

设置 `VOID_TOKEN` 时，还需同时设置 `VOID_API_URL`，指明签发令牌的平台。通过环境变量进行身份验证时，URL 和令牌缺一不可，并且该 URL 必须已建立连接。在全新的 CI 环境中，部署前先运行 `void connect "$VOID_API_URL" --no-login`。如果希望改用平台已保存的登录信息，请取消设置 `VOID_TOKEN`。

如果已在 `void connect` 或交互式 `void init` 流程中完成身份验证，则无需再次登录。

### `void account link [connection-id]` {#void-account-link-connection-id}

将另一种已启用的登录方式关联到当前账号。如果距上次登录已过较长时间，请重新登录，再完成新提供商的浏览器登录，并确认显示的身份。不提供连接 ID 时，可以交互式选择已启用的方式。可选的控制台也在 **Account（账号）** 中提供相同流程。

### `void account logout` {#void-account-logout}

移除已保存的凭据。

### `void account whoami` {#void-account-whoami}

显示当前登录信息。

### `void account token` {#void-account-token}

将你的个人身份验证令牌复制到系统剪贴板。此命令用于交互式排查问题，令牌仍会随登录方式的撤销而失效。不要将它与 Cloudflare Access 服务令牌组合用于 CI；机器的 Access 凭据不能将个人 Void 令牌变成自动化身份。应改用 `void project token create` 创建项目范围的凭据。

## Cloudflare 身份验证 {#cloudflare-authentication}

使用 Void 的 Cloudflare 命令登录和管理凭据，无需另装 Cloudflare CLI。浏览器登录凭据会加密保存，并由系统钥匙串保护。

- `void cloudflare login`：通过浏览器登录或切换 Cloudflare 用户。
- `void cloudflare status`：显示身份、凭据来源、有权访问的账号及部署账号。
- `void cloudflare logout`：移除本地浏览器登录会话。

交互式 `void connect --platform cloudflare`、`void init` 和 `void deploy --platform cloudflare` 会在需要时自动启动同一登录流程。非交互式 CI 必须设置 `CLOUDFLARE_API_TOKEN`。

登录会改变浏览器会话，但不会改变项目配置中的 `account_id`。切换用户后，请检查 `void cloudflare status`；如果新用户无法访问项目已指定的账号，需要在部署前单独调整项目目标。

环境变量中的 API 令牌或全局 API 密钥对优先于浏览器凭据。主动发起浏览器登录时，如果存在这些覆盖设置，命令会停止并列出对应的环境变量名；请先在当前 Shell 中移除它们，再登录。`status` 会报告当前生效的凭据来源；如果退出后环境凭据仍生效，`logout` 会给出提示。主动发起浏览器登录需要交互式终端；部署中的自动检查仍会复用有效会话。
