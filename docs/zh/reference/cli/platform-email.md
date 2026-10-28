---
outline: deep
---

# 平台邮件 {#operator-email}

使用管理员会话运行这些命令。平台选择、预览和确认方式请参阅[平台管理](/zh/reference/cli/platform#operator-commands)。

设置共享发件地址可以向谁发信、由谁注册邮件域名，以及项目的发信限额：

```sh
void platform email policy
void platform email policy-set <verified|domains|any> [--domains <domain[,domain...]>]
void platform email settings
void platform email settings-set --domains <self-serve|admin>
void platform email limit <project-id|slug> [--monthly <n>] [--burst <n>]
void platform email logs <project-id|slug> [--page <n>] [--limit <n>] [--json]
void platform email attempts [--project <id|slug>] [--page <n>] [--limit <n>]
void platform email attempt-resolve <attempt-id> --ended --reason <text>
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason <text>
void platform email shared-recipients [--project <id|slug>] [--page <n>] [--limit <n>]
void platform email shared-recipient-resolve <recipient-id> --ended --outcome <applied|not-applied> --reason <text>
```

`policy` 决定项目的 `<slug>+tag@<mail domain>` 发件地址可以向哪些收件人发信：`verified` 为默认值，只允许该项目已验证的收件地址；`domains` 额外允许所列域名下的所有地址；`any` 取消这项检查。这些设置都不会放宽对平台自身邮件域名内地址的限制：仍只允许投递到该项目已验证的收件地址，因此项目不能未经同意就向其他项目的收件箱发信。在平台邮件域名完成 Email Sending 开通前，Cloudflare 仍会拒绝未验证的地址；因此，使用 `domains` 或 `any` 时，这类拒绝会作为逐个收件人的 `UNVERIFIED_DESTINATION` 结果返回。自定义域名发信不受此策略影响。

`settings-set --domains admin` 会让 `void email domain add` 输出管理员应执行的命令，而不是开始配置令牌。`limit` 用于覆盖项目每月及滚动 60 秒窗口内的限额，默认分别为 200 和 10；管理员界面的项目页面可以查看并清除这些覆盖设置。

`logs` 查看保留的收件记录和收件人处理结果，包括操作 ID、提供商引用、错误码和策略版本。每页最多 100 条记录，按最新记录在前排序；使用 `--json` 可以获取全部字段。项目删除后，在 30 天保留期结束前，仍可通过项目 ID 查询元数据。结果绝不包含邮件内容或凭据。

`attempts` 列出中断的提供商调用，以及最早可处理时间。原 Worker 执行已结束，且发送尝试开始至少 24 小时后，`attempt-resolve` 会将结果记录为 `outcome_unknown`，保留已占用的额度，并解除对项目/域名清理的阻断。`--ended` 表示你确认该调用已不再执行；`--reason` 会存入运维审计日志，原因中不得包含收件地址或邮件内容。该发送不会重试。使用 `--plan` 预览，或通过 `--yes` 跳过提示并执行。

`operation-resolve` 用于恢复结果仍未知的 Cloudflare 路由、Worker、密钥、兜底规则或 Sending 变更。原执行已结束，且操作开始至少 24 小时后，请检查预览中指定的确切资源，并确认写入是 `applied` 还是 `not-applied`。已应用的写入会从下一步继续，未应用的写入则会重试同一个已持久化的操作意图。当前运行的平台版本必须与该意图一致，因此，恢复旧代码创建的操作前，请先恢复到匹配的版本。仅仅经过一段时间，不会触发写入重试。

`shared-recipients` 查找共享入站地址、提供商规则名称和 ID，以及中断的创建意图，也包括等待删除的项目。如果创建结果未知，请在原执行已结束、创建意图记录至少已有 24 小时后，使用 `shared-recipient-resolve`。检查 `--plan` 指定的确切账号、DNS 区域、收件地址和规则，并通过 Cloudflare 提供商审计确定创建结果是 `applied` 还是 `not-applied`。仅凭规则不存在，不足以判定为 `not-applied`。请在 `--reason` 中提供这一调查结论，它会记录在平台事件中。

按已应用状态恢复时，必须存在精确匹配且归平台所有的规则，并会记录其 ID。按未应用状态恢复时，只有反复检查提供商状态并得到你的确认后，才会解除创建意图记录。无论选择哪种结果，在常规同步修复验证前，投递都仍未就绪。恢复本身不会创建或删除提供商规则，也绝不会重新开放正在删除的项目；如果是在恢复清理操作，之后请重试删除。使用 `--yes` 可跳过提示并执行预览。如果操作意图或提供商资源所有权发生变化，请查看新的计划。

为没有 Cloudflare 凭据的项目所有者注册和维护邮件域名：

```sh
void platform email domains [--project <id|slug>]
void platform email domain-add <domain> --project <id|slug> [--token-stdin] [--outbound-only]
void platform email domain-status <domain>
void platform email domain-sync <domain>
void platform email domain-rotate-secret <domain>
void platform email domain-remove <domain> [--token-stdin]
```

对于平台 Cloudflare 账号内的 DNS 区域，`domain-add` 使用平台的 Cloudflare 凭据。对于其他账号，请通过标准输入管道传入限定权限范围的 Cloudflare API 令牌，并使用 `--token-stdin --yes`。托管的自定义入站邮件要求使用 Cloudflare DNS 区域的根域名（`example.com`）。如果 MX 记录已经属于 Microsoft 365 或 Google Workspace 等其他邮件提供商，可以添加 `--outbound-only`，让项目从该根域名发信，同时继续由原提供商收信；请参阅[从已有收信服务的域名发信](/zh/guide/platform/administration/email#sending-from-a-domain-that-already-receives-mail)。否则，请使用项目的共享邮件地址，或选择其他未使用的 DNS 区域。原生 Cloudflare 部署还支持子域名上的固定收件地址；请参阅[自己的 Cloudflare 账号](/zh/guide/email/domains#your-own-cloudflare-account)。

`domain-status` 显示入站、出站和凭据管理的就绪状态，以及最新操作。被阻断的操作通过 `domain-sync` 继续；被阻断的轮换通过 `domain-rotate-secret` 继续，并保留已经确认的步骤和暂存凭据。结果不确定的操作会保持停止，直到回读能够确认结果，或管理员使用 `operation-resolve` 处理。管理员添加的域名会显示 `managed_by: admin`；项目所有者可以列出并查看这些域名，但执行 `sync`、`domain-rotate-secret` 和 `remove` 时，需要使用本页的管理员命令。

如果项目删除过程中，清理因 Cloudflare 令牌过期或被撤销而阻断，请使用 `domain-remove <domain> --token-stdin --yes`，提供限定于同一账号和 DNS 区域的替换令牌。只有在没有其他项目使用该连接时，才会继续保留的清理操作。对于尚未开始删除的项目，请改用 `domain-add` 更新令牌。
