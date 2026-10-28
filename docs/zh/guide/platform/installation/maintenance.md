---
outline: deep
---

# 维护与恢复 {#maintenance-and-recovery}

## 继续安装、修复、恢复和升级 {#resume-repair-recover-and-upgrade}

运行 `void platform list`，可以在安装名称旁找到短标识（slug）。生命周期管理命令接受该短标识、安装 ID 或已保存的连接 ID。只配置了一个安装实例时，可以省略选择参数。如果有多个安装实例，可以交互式选择；在 CI 中则传入短标识或 ID。

### 继续未完成的安装 {#resume-an-installation}

如果安装中断或失败，可以从已保存的进度继续：

```sh
void platform install --resume --name <id>
```

如果最初的数据库连接失败，可以更正数据库 URL。一旦 Void 已登记数据库归属或创建了 Hyperdrive，该安装使用的数据库就会固定。之后如果命令传入不同的 URL，会在任何变更前停止。

### Cloudflare Access 阻止健康检查 {#cloudflare-access}

如果安装报告 **Default-Deny（错误 1050）**，说明 HTTP 健康检查在到达 Void 前就被 Cloudflare 拦截了。这与部署 Worker 所使用的 API 令牌是两回事。

请保留公司的保护措施。自动配置 Access 时，会将限定权限范围的服务凭据与安装实例的加密恢复资料一起保存。对于已有的 Access 保护，请确认其服务策略允许安装令牌访问，并确认 Access 应用覆盖输出中所列的 API 和代理源。Cloudflare 管理 API 令牌无法用于认证受 Access 保护的 HTTP 请求。

对于自动配置，继续安装时还会创建或验证一条 Access 例外规则，仅适用于预留的分发健康检查主机名上的 `/health`。该端点仍然要求 Void 的私有探测令牌；没有令牌的请求无法访问应用。这样，安装过程可以在员工访问保护和账号级 Default-Deny 仍然启用的情况下检查路由。这不会为整个 Worker 或已部署的应用绕过 Access。

如果使用外部提供的凭据，请从密钥管理器设置 `VOID_ACCESS_CREDENTIALS`。它应是一个以各个 API/代理源的完整地址为键的对象，每项都包含 `CF_ACCESS_CLIENT_ID` 和 `CF_ACCESS_CLIENT_SECRET`。然后重新运行 `void platform install --resume --name <id>`。Void 会保留已保存的资源；如果 Access 仍拒绝检查，安装会停止。账号级 Default-Deny 和已部署应用的策略仍需由你负责。

### 管理员设置码过期 {#expired-administrator-setup-code}

使用 `void platform install --resume --name <id>` 继续未完成的安装。如果资源创建已完成，但管理员尚未设置，请运行 `void platform repair <id>`。如果之前的设置码已过期，Void 会输出一个新设置码。在 `/setup` 输入该码，登录并确认显示的身份。已经有管理员的安装实例不会重新开放设置流程。

### 首位管理员登录失败 {#first-administrator-sign-in-fails}

输入设置码后，如果登录失败，页面会显示原因和错误码。如果可能是身份提供商配置导致的，页面还会显示该提供商必须配置的回调 URL。

| 错误码 | 检查内容 |
| --- | --- |
| `github_incorrect_client_credentials`, `github_failed`, `oidc_token_failed` | 检查客户端 ID 和客户端密钥，以及提供商是否已配置所需的回调 URL |
| `github_redirect_uri_mismatch` | 检查 GitHub OAuth 应用中注册的回调 URL |
| `oidc_discovery_failed` | 检查签发者 URL 是否完全一致，包括末尾的斜杠 |
| `github_unverified_user_email` | 验证 GitHub 账号的主要邮箱 |
| `google_domain_not_allowed`, `oidc_group_not_allowed` | 使用被允许的账号登录，或修改允许的域名或用户组 |
| `login_denied`, `github_bad_verification_code` | 重新发起登录 |

如果提供商直接显示了自己的错误页面，请将随设置码一同输出的回调 URL 原样注册到提供商。

要修改登录设置，请在安装平台的计算机上运行修复：

```sh
void platform repair <id>
void platform repair <id> --auth-config <path>
```

交互式修复会询问是否修改登录设置，并填入已保存的值；客户端密钥留空即可保留原值。`--auth-config` 接受符合[安装配置格式](/zh/guide/platform/installation/setup#finish-login-configuration)的文件，修改 OIDC 允许的用户组也需要使用此选项。登录方式和 Access 保护保持安装时的设置。修复会输出新的设置码和回调 URL。

仅支持 GitHub 登录的安装实例，会使用安装设置中的 GitHub OAuth App 进行登录。要替换其客户端 ID 和密钥，请在运行 `void platform repair <id>` 时设置 `VOID_PLATFORM_GITHUB_CLIENT_ID` 和 `VOID_PLATFORM_GITHUB_CLIENT_SECRET`。

### 修复缺失的资源 {#repair-missing-resources}

先预览需要修复的内容，再执行：

```sh
void platform repair [id] --plan
void platform repair [id]
```

修复会重建归安装器所有、但已缺失的基础设施，不会恢复 PostgreSQL 数据行或提供商资源中存储的数据。如果缺失的是接管的已有资源或外部资源，请先自行恢复，再继续。已停用的平台在修复和升级后仍会保持停用。

### 升级平台 {#upgrade-the-platform}

更新 Void CLI 时，也要保持平台运行时为相应版本。请在团队更新 CLI 之前先升级平台：较新的 CLI 会拒绝连接旧平台，并要求运行 `void platform upgrade`。请先在管理员计算机上安装新版 CLI，执行以下升级，再让团队更新。

如果平台要部署使用 `void/sandbox` 的应用，运行时令牌需要 **Account → Containers → Edit** 和 **Account → Cloudchamber → Edit** 权限。通过较早安装链接创建的令牌可能没有这些权限，升级也不会自动补充。请在 Cloudflare 控制台中编辑令牌，或在升级时将 `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` 设为新令牌。请参阅 [Cloudflare API 令牌](/zh/guide/platform/installation/credentials#runtime-token-permissions)。

使用已安装 CLI 随附的运行时进行升级：

```sh
void platform upgrade [id] --plan
void platform upgrade [id]
```

升级会验证运行时、执行受支持的待处理迁移、部署 Worker，并检查其健康状态。已有的 Worker 密钥会保留。

开始前，Void 会检查对安装所用 Cloudflare 账号、Worker 和已有 R2 存储桶的访问权限。如果凭据被拒绝，请将 `CLOUDFLARE_API_TOKEN` 设为限定于该账号的管理令牌，再重试。此值会覆盖安装实例已保存的管理令牌。

部分升级会在切换到新版本期间暂停应用流量。新版本通过健康检查后，流量才会恢复。如果升级或其他生命周期管理命令在暂停流量后失败，流量会继续暂停，直到后续执行成功。要恢复，请：

1. 运行 `void platform status <id>`，查看已保存的进度。
2. 解决错误中指出的问题。
3. 运行 CLI 输出的继续执行命令，使用相同的命令和运行时。

::: details 迁移安全、凭据轮换与回滚

如果要更新运行时 Cloudflare 令牌、已启用 GitHub 登录时的 GitHub OAuth 凭据，或 R2 凭据，请在升级时提供相应的 `VOID_PLATFORM_*` 环境变量。只有显式提供的值才会替换正在使用的凭据。旧工作站上的恢复数据不会覆盖这些凭据，升级也会保留当前签名密钥和完整的项目加密密钥环。请将当前凭据保存在密钥管理器中，以便修复时也能用它们重建缺失的 Worker。

数据库迁移只会向前执行。Void 会在升级前检查兼容性，如果需要先升级到某个中间版本，会给出提示。如果部署失败，会尝试在兼容的数据库 schema 上恢复之前的 Worker。重试不会重复执行已完成的迁移。

升级成功后，可以恢复到已声明兼容的旧版运行时，而不撤销迁移：

```sh
void platform rollback [id] --runtime /path/to/earlier/runtime --plan
void platform rollback [id] --runtime /path/to/earlier/runtime
```

如果需要回滚，请保留旧版运行时文件。如果当前安装的是自定义构建，还需要通过 `--from-runtime /path/to/current/runtime` 传入其文件。Void 会检查旧版本能否使用当前数据库运行，并拒绝不兼容的回滚。之后仍可以通过 `upgrade` 再次升级。自定义构建的用法请参阅[平台开发](/zh/guide/platform/development/runtime#deploying-your-runtime)。

升级到较新版本后，请勿回滚到 0.26.0 或更早版本。Void 不会拒绝这种回滚，但这些旧版本会拒绝较新版本向应用签发的凭据。自升级后部署或轮换过凭据的所有项目，都会失去 AI、邮件、ISR 重新验证、远程 D1、KV、R2 和预渲染能力，直到再次升级。如果已经回滚到这些旧版本，请重新升级，再运行 `void platform system rotate-proxy-tokens --all --yes`，并通过 `--plan` 检查，直到没有待处理或失败的项目。

回滚前，请等待正在进行的轮换完成。如果旧版代理与新版 API 同时运行，预渲染和远程 D1、KV、R2 都会失败，直到两者使用相同版本。回滚到凭据轮换前的那个版本后，自升级以来部署的项目会失去预渲染和远程 D1、KV、R2 能力，直到重新部署这些项目或再次升级。如果已轮换凭据的项目在任一次回滚期间被部署，那么重新升级后仍会处于异常状态；0.26.0 及更早版本还会丢弃尚未完成的轮换。从任何回滚中重新升级后，都请运行上述 `rotate-proxy-tokens` 命令。

:::

### 平台 Worker 在 Void 之外被修改 {#workers-changed-outside-void}

平台自身的 Worker 由 Void 管理。请勿在 Cloudflare 控制台或通过 Cloudflare API 修改它们。要修改平台，请使用本页列出的 Void 命令。

`upgrade`、`repair`、`enable`、`rollback` 和 `install --resume` 会重新部署平台 Worker。在修改任何平台 Worker 或暂停流量前，Void 会查找符合以下条件的平台 Worker：

- 曾在 Cloudflare 控制台或通过 Cloudflare API 被修改。
- 当前活动版本没有对应的 Void 部署记录。如果之前执行命令时替换了 Void 之外的修改，之后又停止或失败，就可能出现这种情况。如果上次执行在切换到新版本期间停止，命令会先重新启用旧版本，Void 也会检查这些旧版本。较早 Void 版本部署的版本，也可能没有部署记录。

`upgrade`、`repair`、`enable` 和 `rollback` 的 `--plan` 预览会以警告形式显示同一份列表。

在终端中，Void 会列出这些 Worker，并询问 **Replace the configuration of these Workers?（是否替换这些 Worker 的配置？）**，默认回答为 No（否）。

- 回答 No（否）时，命令会停止，不会修改任何平台 Worker，也不会暂停流量。
- 回答 Yes（是）时，命令会继续。Void 首先准备平台资源和数据库，然后在暂停流量或部署 Worker 前，由 Cloudflare CLI 对每个在控制台或通过 API 被修改的 Worker 再次请求确认。对于控制台中的修改，它会显示差异。Void 会为这些 Worker 分别上传新版本，此时尚不部署。如果 Worker 只是当前活动版本没有 Void 部署记录，Cloudflare CLI 不会再次询问。

如果你在 Cloudflare CLI 中拒绝，命令会停止。Void 不会撤销资源和数据库变更，但不会更改任何部署，也不会暂停流量。

替换会移除不由 Void 设置的值，例如你自行添加的 `EMAIL_FROM` 变量；也会重置由 Void 设置的值，例如 `AUTH_REDIRECT_URI`。

如果没有终端，例如在 CI 中运行，或使用了 `--yes`，命令会在修改平台 Worker 前停止，也不会暂停流量。请在终端中运行一次 Void 输出的命令，并回答其中的问题。此次执行完成后，命令即可重新在 CI 中使用。

如果 Void 无法读取某个平台 Worker，命令同样会在修改平台 Worker 或暂停流量前停止。请再次运行命令。如果某个平台 Worker 没有单个版本承接 100% 的流量，例如渐进式部署后，请在 Cloudflare 控制台中将某个版本部署为承接 100% 流量。然后在终端中运行一次命令，以便确认这次控制台变更。

如果之前执行命令时在暂停流量后失败，那么上述停止情况发生后，流量仍会保持暂停。恢复方式请参阅[升级平台](#upgrade-the-platform)。

### 跟踪升级和回滚进度 {#follow-upgrade-and-rollback-progress}

查看进度不是必需的：升级或回滚会由 CLI 持续执行，无需在状态页面上操作。维护期间，访问管理界面会自动跳转到 `/admin/status`。你也可以在平台 API 源地址下直接打开该页面，并以管理员身份登录。

该只读页面会显示已保存的操作、源版本和目标版本，以及 API 报告的流量状态。页面可见时，每五秒自动刷新一次。如果更新失败，会保留最后确认的快照，并标记为已过时。常规的管理员变更操作仍会暂停。

只要 API 和身份认证数据库可以连接，登录和状态查询就仍然可用。某项操作完成，并不代表每个项目的健康状态都已确认。已停用的安装实例在升级或回滚后，流量仍会保持暂停。

如果操作失败，或正在等待 DNS 操作或 Sandbox 排空完成，CLI 会输出恢复说明和继续执行所需的命令。请解决报告的问题，再使用相同的运行时文件继续。自定义回滚还需要保留源运行时文件。`void platform status <id>` 也会在检查实时 API 前显示本地保存的进度；如果其他管理员修改了安装，此本地检查点可能已经过时。

应用流量暂停时，访客会看到暂时不可用页面，其中提供 **Try again（重试）**链接。API 请求和表单提交仍会收到 HTTP 503 响应。Void 不会自动重放请求；已经提交表单的访客，应先确认上次提交的结果，再决定是否重新提交。

### 从另一台计算机管理安装实例 {#manage-an-installation-from-another-machine}

使用 `discover` 恢复管理员本地的安装记录：

```sh
void platform discover --account <account-id> --installation <id-or-name>
```

发现操作会先验证资源确实属于你的平台，再恢复本地安装记录，也适用于中断或已停用的安装。如果有基础设施缺失，请在发现操作后运行 `void platform repair [id]`。如果无法验证所有权，命令会停止，不会修改资源。

发现操作后，请提供 `VOID_PLATFORM_DATABASE_URL`，用于执行迁移，并协调各管理员命令的执行。如果升级会保留所有已部署的 Worker，则无需重新输入其他密钥。对于已启用邮件但缺少加密恢复文件的安装，请恢复 `VOID_PLATFORM_EMAIL_SIGNING_SECRET`；如果只是重建邮件网关，只需要该密钥，不需要 Cloudflare 运行时令牌或 JWT 签名密钥。启用邮件时，重建 API 或代理除了各自通常所需的密钥，还需要邮件签名密钥。重建 API 需要通过 `VOID_PLATFORM_*` 变量提供原来的运行时令牌（`VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN`），以及 R2、JWT 和项目加密相关的值；仅支持 GitHub 登录的安装还需要原来的 GitHub OAuth 值。重建代理需要运行时令牌和 JWT 签名密钥。Cloudflare 无法返回这些值，因此请将它们保存在组织的密钥管理器中。

如果尚未轮换项目加密密钥，请通过 `VOID_PLATFORM_PROJECT_SECRET_KEY` 恢复。轮换后，则需要用 `VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON` 提供所有保留的密钥，并用 `VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION` 提供当前活动密钥的名称。请保留解密现有项目 Secret 所需的旧加密密钥。这些值用于重建缺失的 API Worker，不会在普通升级中替换正在使用的密钥。请通过密钥管理器提供它们。

### 为灾难恢复做好准备 {#prepare-for-disaster-recovery}

`discover` 会在另一台计算机上重建经过验证的安装元数据，不会下载凭据、密钥材料或备份数据。之后，`repair` 可以重建归安装器所有、但已缺失的基础设施，不过不会恢复这些基础设施原先存储的数据。

为每个安装实例保存一套相互匹配的恢复资料：

- PostgreSQL 备份；
- 保存在密钥管理器中的安装身份材料，包括 JWT 签名密钥、启用邮件时的邮件签名密钥，以及完整的项目加密密钥环；
- 每个承载数据的提供商资源所支持的备份或导出；
- 对应已安装版本或自定义源码修订版本的不可变运行时产物和清单。

请将这些资料作为同一个恢复点采集和标记，确保 PostgreSQL、提供商数据、身份材料和加密密钥相互匹配。备份与保留能力因提供商和资源而异；请为每种使用的资源选择受支持的恢复流程，并进行验证。

恢复时，请在修改资源前停用平台和应用流量，并在恢复期间保持停用。使用各自支持的恢复工具，还原相匹配的 PostgreSQL 和提供商数据，提供原来的身份材料和密钥环，并使用保留的运行时产物。然后运行 `discover`，通过 `--plan` 预览 `repair`，在执行前逐项审查所有权判定和计划中的资源变更。只有在恢复的数据和平台健康状态都经过验证后，才能启用流量。发现和修复不能替代这些备份；缺少必需的密钥或数据时，它们也不能绕过这些要求来恢复。

### 本地状态的存储位置 {#where-local-state-lives}

安装记录存放在 `~/.void/platforms/`。凭据单独存放在加密恢复文件中，加密密钥则保存在操作系统钥匙串中。请将原始密钥保存在密码管理器中，以便在另一台计算机上恢复。Void 生成的签名密钥和加密密钥只存在于这些文件中；如果希望自行保留副本，请[在安装时提供这些密钥](/zh/guide/platform/installation/credentials#signing-and-encryption-keys)。

如果钥匙串不可用，Void 会在写入密钥前停止。无图形界面的环境可以通过密钥管理器提供 `VOID_PLATFORM_RECOVERY_KEY`，它必须是使用规范 Base64 编码的 32 字节密钥。只有在所有原始凭据仍完整保存在受保护的 CI 密钥中时，临时 CI 执行器才可以每次使用新的恢复文件加密密钥。这些凭据包括 `VOID_PLATFORM_JWT_SECRET`、启用邮件时的 `VOID_PLATFORM_EMAIL_SIGNING_SECRET`，以及原始的 `VOID_PLATFORM_PROJECT_SECRET_KEY`，或轮换后的完整密钥环及其活动版本。

::: details 所有权与维护中断

Void 会在变更前检查资源所有权和配置的数据库，并协调并发维护命令，防止一个管理员覆盖另一个管理员的操作。

维护中断时，请再次运行同一个命令。验证成功前，流量可能会一直暂停。已有路由、域名和数据都会保留。

:::
