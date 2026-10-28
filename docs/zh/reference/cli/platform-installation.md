---
outline: deep
---

# 平台安装 {#void-platform-install}

```sh
void platform install [options] [--yes]
```

| 选项 | 用途 |
| --- | --- |
| `--name <slug>` | 用于 `void-<name>-<role>` 资源名称的安装名称；请选择未使用的名称 |
| `--display-name <name>` | 便于识别的平台显示名称 |
| `--account <id>` | Cloudflare 账号 ID |
| `--auth-config <path>` | 登录方式、注册策略，以及提供方密钥的环境变量引用 |
| `--login-methods <methods>` | 以逗号分隔的登录方式：`github`、`google`、`oidc` 或 `cloudflare-access` |
| `--access-protection` | 使用 Cloudflare Access 保护平台 UI 和 API |
| `--no-access-protection` | 不启用 Cloudflare Access 防护 |
| `--app-access <public\|platform\|custom>` | 公开应用、复用平台的 Access 策略，或单独选择应用策略 |
| `--hyperdrive <create\|id>` | 创建 Hyperdrive，或使用指定的已有配置 |
| `--application-domain <domain>` | 已部署应用的基础域名 |
| `--workers-dev` | 显式选择测试模式，之后可添加应用域名 |
| `--zone <domain>` | 应用域名所在的 Cloudflare DNS 区域 |
| `--dedicated-zone` | 添加覆盖整个区域的兜底路由；仅当应用域名就是整个区域时有效 |
| `--no-dedicated-zone` | 不添加覆盖整个区域的应用兜底路由 |
| `--custom-domains` | 允许项目添加自有域名；需要专用区域 |
| `--control-plane-domain <domain>` | 可选的 API 自定义主机名，默认为 `workers.dev` |
| `--no-control-plane-domain` | 使用默认的 `workers.dev` API 主机名 |
| `--dashboard-url <origin>` | 单独部署的可选仪表盘的 HTTPS 源地址 |
| `--plan` | 预览 Cloudflare 变更，并在本地保存安装选项 |
| `--resume` | 从匹配的安装检查点继续 |
| `--runtime <path>` | 部署本地构建且通过完整性检查的运行时目录 |
| `--yes` | 非交互式运行时确认 Cloudflare 变更 |

首次安装请按[安装 Void 平台](/zh/guide/self-hosted-platform)操作。交互式安装程序推荐使用域名，也会明确提供 **Use workers.dev for testing（使用 workers.dev 测试）** 选项。Void 会创建平台基础设施和表。两种模式都需要外部 PostgreSQL 和已配置的登录方式。请选择所有希望启用的登录方式，初始状态下没有预选项。非交互式安装未提供登录配置时，默认使用 GitHub。`--workers-dev` 会跳过区域、DNS 和证书操作，不能与 `--application-domain`、`--zone` 或 `--dedicated-zone` 组合使用。

只读计划、使用默认 API 主机名的 workers.dev 安装，以及受支持的生命周期操作，都可以使用 Cloudflare 浏览器登录和系统钥匙串。需要写入 DNS 或创建区域的安装必须提供管理 API 令牌。交互式安装程序会引导你创建令牌，并在隐藏输入的提示中粘贴；脚本通过 `CLOUDFLARE_API_TOKEN` 或 `CF_API_TOKEN` 提供。

安装后的平台需要独立的运行时令牌，为应用创建资源。交互式安装程序会提示输入该令牌及其他配置值。非交互式安装请注入[从 CI 安装](/zh/guide/platform/installation/ci)列出的变量。

要在安装或升级时启用邮件，请同时设置 `VOID_EMAIL_SENDER_DOMAIN` 和 `VOID_EMAIL_SHARED_ZONE_ID`。Void 会记录这两个值，供后续升级使用；只提供其中一个会报错。

单独部署可选的用户仪表盘时，使用 `--dashboard-url `[`https://dash.example.com`](https://dash.example.com)。该 URL 必须是 HTTPS 源地址，不能包含凭据、路径、查询参数或片段。Void 会允许该源地址的登录回调，并保存它供后续维护使用，但不会部署仪表盘 Worker。省略时，会保留已有平台实例保存的仪表盘源地址。

`--plan` 会预览资源名称、登录方式、默认应用访问方式、登录回调 URL、数据库配置和凭据要求。选择已有 Hyperdrive 时，会显示其数据库和配置名称。配置向导会在设置凭据时提供相应链接。预览完成后，不含机密的安装选项会保存在本地。重新运行 `void platform install`，可以选择已保存的计划，并重新检查 Cloudflare 当前状态；也可以运行最后输出的安装或继续安装命令。已开始的安装会使用保存的检查点，已完成的安装不会出现在选择列表中。配置登录时，使用 `--auth-config`，或将 `--login-methods` 与 Access 防护选项一起使用。

应用访问配置会在开放流量前完成。启用平台防护时，安装程序推荐复用其企业策略；否则默认将应用公开。使用 `--app-access custom` 可单独选择托管账号中的策略。启用了 Default-Deny（默认拒绝）的账号中，公开应用会获得范围明确的公开 Access 规则。需要时，安装程序会说明并收集用于加密保存的管理凭据；脚本通过 `VOID_PLATFORM_APP_ACCESS_TOKEN`，或身份验证配置文件中的 `appAccess.tokenEnv` 提供。升级会保留管理员设置。

新资源使用 `void-<name>-<role>` 格式命名，请选择未使用的安装名称。缺少凭据时，安装程序会打开设置页面；已经提供的值会被复用。

配置 Access 时，可以选择已有企业策略，或选择 **Create in Cloudflare（在 Cloudflare 中创建）**，获取手动配置说明和账号控制台链接。保存策略并确认完成后，Void 会重新加载列表，让你在同一次运行中选择该策略并继续。由 Void 创建 Access 应用时，**Allow my company’s email domain（允许我的公司邮箱域名）** 会为输入的域名创建并选中一条 Allow（允许）策略。**Refresh list（刷新列表）** 会重新加载在其他窗口中创建的策略。身份提供方选择，以及仍然可用的已选策略，都会保留。如果选定策略没有将登录限制为企业身份，Void 会说明原因并要求重新选择。

安装进度和已提供的部分凭据会加密保存在本地。重新运行安装程序可继续未完成的配置，也可以传入 `--resume --name <id>`。已完成安装的平台应使用生命周期命令管理。

请使用专供此平台安装使用的空 PostgreSQL 数据库。初次连接失败时可以修正连接，但数据库归属已确认或 Hyperdrive 已创建后，命令会拒绝使用其他 URL。

选择由 Void 创建 Hyperdrive，或使用已有配置。已有 Hyperdrive 必须指向平台数据库，并关闭 SQL 结果缓存。执行迁移需要提供数据库所有者的连接 URL。配置方法见[使用现有 Hyperdrive](/zh/guide/platform/installation/prerequisites#use-an-existing-hyperdrive)，无人值守输入见[从 CI 安装](/zh/guide/platform/installation/ci)。

恢复所需的凭据通过系统钥匙串加密保存。没有钥匙串时，请提供以 base64 编码的 32 字节 `VOID_PLATFORM_RECOVERY_KEY`。请将原始凭据保存在受保护的 CI 密钥中，供恢复使用。

如果新建的 DNS 区域正在等待注册商处的域名服务器委派，请在区域激活后继续安装：

```sh
void platform install --resume --name <installation-id>
```

前提条件、令牌范围、具体资源组成、域名行为和完整操作流程，见[自托管 Void 平台](/zh/guide/self-hosted-platform)。

## `void platform domain set` {#void-platform-domain-set}

```sh
void platform domain set <domain> [--installation <id>] [--zone <domain>] [--dedicated-zone] [--plan] [--yes]
```

为 workers.dev 测试平台添加应用域名。使用域名安装仍是推荐的默认方式。该命令会尽可能自动识别 DNS 区域，经确认后创建缺少的 DNS 和路由，并在将域名设为主要访问地址前检查 HTTPS 和项目零信任防护。如果 DNS、证书或防护尚未就绪，重新运行同一命令即可继续。`--plan` 只读，非交互式变更需要 `--yes`。

原有 workers.dev URL 仍可使用，平台 API 源地址、OAuth 回调、项目和部署均保持不变。命令会检查平台当前使用的运行时令牌是否对新区域具有 Cache Purge（清除缓存）权限。已禁用的平台会保持禁用。从其他机器管理时，请使用原安装的数据库 URL。不支持替换已经配置的应用域名。见[添加域名](/zh/guide/platform/installation/domains#adding-a-domain)。

## 生命周期命令 {#lifecycle-commands}

使用以下命令恢复、更新、暂停或移除平台实例：

```sh
void platform discover [--account <id>] [--installation <id-or-name>]
void platform upgrade [id] [--runtime <path>] [--dashboard-url <origin>] [--custom-domains] [--plan] [--yes]
void platform rollback [id] --runtime <earlier-path> [--from-runtime <current-path>] [--plan] [--yes]
void platform repair [id] [--runtime <path>] [--dashboard-url <origin>] [--custom-domains] [--auth-config <path>] [--plan] [--yes]
void platform disable [id] [--plan] [--yes]
void platform enable [id] [--runtime <path>] [--plan] [--yes]
void platform uninstall [id] [--plan] [--purge-data | --purge-resources] [--yes]
```

`discover --installation` 将共享 Cloudflare 账号中的恢复和端点验证限定为单个平台实例。

使用 `void platform list` 中显示在平台名称旁的安装 slug，也支持安装 ID 和已保存的连接 ID。生命周期命令需要本地安装记录；在其他机器上，可以使用 `discover` 恢复。只配置了一个平台实例时，可以省略 `id`，也可以通过交互式列表选择。存在多个实例时，非交互式命令必须提供 slug 或 ID。非交互式执行变更还需要 `--yes`；`--plan` 仅预览变更。

安装后，要添加或显式更改单独部署的仪表盘，使用 `repair --dashboard-url <origin>` 或 `upgrade --dashboard-url <origin>`，先通过 `--plan` 预览。已有 Access 防护必须覆盖配置的仪表盘源地址，维护才能继续。见[可选仪表盘](/zh/guide/platform/installation/domains#optional-dashboard)。

首位管理员的设置尚未完成时，`repair --auth-config <path>` 可读取与安装时格式相同的文件，替换登录设置并输出新的设置码。交互式修复也提供相同操作，并预填已保存的值。登录方式和 Access 防护仍保持安装时的选择。请在安装平台的电脑上运行。见[首位管理员登录失败](/zh/guide/platform/installation/maintenance#first-administrator-sign-in-fails)。

在其他机器上发现平台后，设置 `VOID_PLATFORM_DATABASE_URL`。重新创建缺失 Worker 所需的密钥，见[从其他机器管理平台实例](/zh/guide/platform/installation/maintenance#manage-an-installation-from-another-machine)。

| 命令 | 行为 |
| --- | --- |
| `discover` | 验证远程所有权并恢复本地安装记录，不下载密钥 |
| `repair` | 重新创建安装程序拥有的缺失资源 |
| `upgrade` | 部署选定运行时，并执行受支持的待应用迁移 |
| `rollback` | 恢复声明兼容的旧版运行时，不撤销 PostgreSQL 迁移 |
| `disable` | 阻断应用流量和平台 API，不移除数据；仅管理员状态检查和登录仍可使用 |
| `enable` | 重新部署并验证平台 Worker，随后恢复流量 |
| `uninstall` | 阻断流量并移除符合条件的资源，默认保留数据 |

修复和升级会保留禁用状态。新安装、继续安装以及此前被禁用的平台，在所有目标 Worker 通过验证前都会阻断用户流量，但安装程序仍可执行健康探测。路由和自定义域名保持关联。

如果平台 Worker 在 Void 之外被修改，或当前生效版本没有对应的 Void 部署记录，部署平台 Worker 的命令会在修改 Worker 或暂停流量前停止，除非你在终端中同意替换这些变更。见[在 Void 之外修改的平台 Worker](/zh/guide/platform/installation/maintenance#workers-changed-outside-void)。

`--runtime` 用于选择自定义平台构建产物，相对路径基于当前目录解析。Void 会在执行变更前验证构建产物。如何创建产物，见[平台开发](/zh/guide/platform/development/runtime#deploying-your-runtime)。

未传入 `--runtime` 时，CLI 使用随包附带的平台版本。

平台迁移只能向前执行。Void 会在更新数据库前检查兼容性，并在需要先升级到中间版本时给出提示。

新的 Worker 通过健康检查后，升级才算完成。如果发布失败，Void 会尝试恢复之前的 Worker。重试不会重复执行已完成的迁移。

`platform rollback` 会恢复兼容的旧版运行时，不会撤销数据库迁移。通过 `--runtime` 提供旧版文件；如果当前已安装的版本是自定义版本，还需通过 `--from-runtime` 提供该版本。Void 会拒绝不兼容的目标。

如果项目零信任防护已启用，且平台尚无用户，卸载会先关闭该防护并删除它的 Access 应用。请在安装平台的电脑上运行。

卸载会在移除任何内容前验证远程所有权。除非传入 `--purge-data`，否则会保留数据资源。Worker、它们使用的队列、R2、AI Gateway、DNS 记录、路由、自定义域名、接管的资源、外部 PostgreSQL 和 DNS 区域会保留，供人工审查。`--keep-zone` 已弃用且不再生效；卸载始终保留 DNS 区域。

`--purge-resources` 包含 `--purge-data` 的效果，还会删除安装创建的其他所有资源，包括 Worker、队列、R2、AI Gateway、平台 DNS 记录、路由、自定义域名，以及安装程序创建的 Access 资源。邮件方面，它只移除将邮件发送到平台邮件网关的 Email Routing 规则，保留 DNS 区域、接管的资源、外部 PostgreSQL、其他 Email Routing 设置和 API 令牌。如果路由、自定义域名、DNS 记录或 Access 资源已不再匹配安装记录，则会保留并列出。仍有项目或无权读取资源时，命令会在任何变更前拒绝执行。请授予 `--plan` 列出的 Edit（编辑）权限；读取检查无法验证这些权限，因此删除被拒绝时，卸载可能已执行了部分变更。操作中断后，或普通卸载、`--purge-data` 卸载停止后，重新运行同一命令即可继续。

完整移除策略和清理顺序，见[停用与卸载](/zh/guide/platform/installation/uninstall#remove-retained-resources)。
