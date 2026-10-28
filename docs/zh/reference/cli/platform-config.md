---
outline: deep
---

# 平台配置 {#plan-configuration}

使用管理员会话运行这些命令。平台选择、预览和确认方式请参阅[平台管理](/zh/reference/cli/platform#operator-commands)。

`void platform config plans` 使用管理员会话打开交互式套餐菜单。套餐具有稳定的 ID，显示名称可以修改。你可以复制已有套餐来创建新套餐，直接调整限额而无需重新部署，归档套餐以停止新的分配，或在明确指定其账号的替代套餐后移除它。

```sh
void platform config plans show [plan-id]
void platform config plans add <plan-id> --copy <existing-id> --name "Team"
void platform config plans set <plan-id> [--name "Team"] [--file plan.json]
void platform config plans reset <builtin-plan-id>
void platform config plans archive <plan-id>
void platform config plans restore <plan-id>
void platform config plans remove <plan-id> [--replacement <plan-id>]
void platform config plans default <plan-id>
void platform config plans sync
```

使用 `--plan` 预览变更和受影响的账号；在脚本中执行变更需要 `--yes`。所有命令都支持 `--connection <slug-or-url>` 和 `--json`。`show` 会显示生效的限额、默认套餐、分配情况和待处理的账号更新。`reset` 会恢复内置套餐的原始限额和构建实例规格。归档后的套餐保留已有账号，但不能再接受新的分配；归档默认套餐前，请先更改默认设置。对于已有账号或被设为默认的套餐，`remove` 要求指定替代套餐。更改默认套餐只影响新账号。

对于 `add` 和 `set`，`--file` 会读取一个 JSON 对象，其中可包含 `name`、`limits`、`buildInstanceType`，以及布尔值 `allowShortSlugs`。`limits` 可以只提供部分字段，值必须为非负整数；`0` 表示套餐不作限制。构建超时仍受平台最长 60 分钟的上限约束，`0` 表示使用该上限。省略的设置会保留当前值或被复制套餐的值。`buildInstanceType` 可以是 `standard-3` 或 `standard-4`。`allowShortSlugs` 允许后续分配五个字符或更短的项目 slug，已有 URL 仍然可用。存储配额不可修改。支持的限额和示例请参阅[套餐与限额](/zh/guide/platform/administration/plans)。

应用变更时，会检查预览对应的修订版本，并拒绝并发变更。降低配额可能限制已经超额的账号，但会保留用量历史和计费周期。CLI 会持续处理账号更新，直到完成。如果更新失败或不再推进，配置仍会保留，命令则以失败状态退出。再次编辑套餐前，请运行 `sync --yes` 继续处理。如果请求结果不确定，请检查 `show` 和运维事件。

## 身份认证配置 {#authentication-configuration}

`void platform config auth` 打开交互式配置。这些命令使用通过 `void platform auth login` 建立的管理员会话：

```sh
void platform config auth list
void platform config auth show company
void platform config auth add google
void platform config auth add oidc --id company
void platform config auth add cloudflare-access --id access
void platform config auth configure company
void platform config auth test company
void platform config auth link company
void platform config auth enable company
void platform config auth disable github
void platform config auth admission
void platform config auth protection show
void platform config auth protection enable --installation <id>
void platform config auth protection disable --installation <id>
void platform config auth recover company --installation <id> --file recovery.json
```

首次为已有安装实例配置时，请运行 `void platform config auth initialize`，然后重新登录。现有的登录方式和注册策略会保留。

添加或编辑登录方式时，会保存一份待启用的配置。启用时，会先在浏览器中验证登录，再应用配置。将已验证的身份关联到账号，是另一项需要明确执行的操作。禁用某种方式前，请先验证已关联的替代登录方式；最后一种登录方式不能禁用。禁用会撤销通过该方式建立的用户登录会话，包括运维会话。限定权限范围的部署令牌仍然有效；用作 `VOID_TOKEN` 的用户登录令牌仍会被撤销。

命令接受 `--connection <slug-or-url>` 和 `--json`，变更操作接受 `--plan` 或 `--yes`。通过脚本配置时，使用 `--file <path>` 提供非敏感字段，使用 `--client-secret-env <name>` 指定存放密钥的环境变量。编辑时省略密钥，即可保留已保存的值。在脚本中运行 `enable` 或 `link` 时，请提供已完成测试返回的 `--test-id <id>`。`test --json` 会返回浏览器 URL、测试 ID 和到期时间，不会等待测试完成。

`admission` 用于选择邀请/允许名单注册、企业批准注册，或公开注册。企业批准注册会在用户通过已配置的企业规则后，自动创建普通账号。请选择已启用且限制为企业成员的 OIDC 或 Google Workspace 登录方式，或已启用的 Cloudflare Access 访问保护。在脚本中，`admission --file <path> --yes` 会读取类似 `{"mode":"company","connections":["company"],"access":false}` 的策略。

`protection enable` 创建或连接 Cloudflare Access 应用，与登录方式相互独立。其 `--file` 接受[安装配置](/zh/guide/platform/installation/setup#choose-login-methods)中说明的 `cloudflareAccess` 对象。修改保护设置需要安装实例的所有权、已保存的恢复凭据，以及管理员本人的登录会话，并会撤销当前的用户登录会话。移除保护前，请先修改所有依赖该访问保护的注册规则。Cloudflare 应用会保留，由你明确决定如何清理。

正常登录不可用时，`recover <connection-id>` 用于恢复已有管理员。其文件包含 `administratorUserId`、可选的非敏感提供商 `configuration`，以及使用 `--yes` 时必须提供的 `expectedIdentity` 对象，其中应固定准确的 `issuer` 和 `subject`。恢复需要 Cloudflare 管理权限、数据库权限、原始恢复密钥，以及成功的浏览器提供商登录测试。新增或轮换凭据时，请使用 `--client-secret-env <name>`。

自动化用法请参阅[运维身份认证](/zh/reference/cli/platform#operator-authentication)。
