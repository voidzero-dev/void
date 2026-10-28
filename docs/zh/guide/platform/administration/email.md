---
outline: deep
---

# 邮件 {#email}

## 管理邮件 {#managing-email}

这些命令适用于已启用邮件功能的平台。每个项目都可以使用平台共享邮件域名下的 `<slug>+tag@<mail domain>` 发信。部署带有 `email/` 处理函数的应用后，待对应的收件路由规则准备就绪，该地址就可以收信。应用如何处理邮件，见[邮件指南](/zh/guide/email)。

共享收信会为每个启用收信的项目使用一条精确匹配的路由规则，并启用 Cloudflare 按 DNS 区域（Zone）配置的加号地址功能。创建项目或部署只发信的应用，不会占用收信规则。已有规则和根域名的兜底规则会保留。Cloudflare 通常允许[每个域名最多 200 条路由规则](https://developers.cloudflare.com/email-service/platform/limits/)；共享域名达到容量上限时，请移除未使用的规则，或申请提高上限。如果项目的基础地址或加号地址已有不属于本次配置的规则，配置会被阻断，直到冲突消除。

项目所有者可以用 `void email alias <name>` 为共享地址设置一个永久的短别名。带别名的收信项目会使用两条规则，分别对应 slug 和别名，因为原来的 slug 地址仍然有效。存在冲突规则或域名已达到规则上限时，不能设置别名。别名只有在项目删除后才会释放。

如果收件路由创建中断，请查看保留的操作意图记录：

```sh
void platform email shared-recipients --project my-app
void platform email shared-recipient-resolve <recipient-id> --ended --outcome not-applied --reason "Provider audit confirms the request did not create a rule" --plan
```

等待到报告的可恢复时间，确认原执行已结束，再检查计划中列出的具体服务提供方资源。只有精确匹配且归平台所有的规则确实存在时，才能使用 `applied`；只有服务提供方的审计记录能够确认创建从未发生时，才能使用 `not-applied`。仅凭资源不存在，不能确定操作结果。检查后，在同一命令中使用 `--yes`。恢复操作只会在平台事件中记录判断，不会创建或删除规则。后续常规配置同步会验证投递情况；正在删除的项目会保持关闭，可以重试删除。恢复要求见[运维邮件命令](/zh/reference/cli/platform-email#operator-email)。

### 平台自身发送的邮件 {#platform-sender}

平台也会发送自己的邮件，例如邀请、欢迎邮件、部署失败通知和错误告警。这些邮件来自 `noreply@<mail domain>`，发件人名称为平台显示名称。Void 会设置该发件人，无需额外配置。不要在 Cloudflare 控制台中为平台 Worker 设置其他发件人，否则下次 `upgrade`、`repair`、`enable` 或 `rollback` 会停止，直到你允许 Void 替换该设置。见[在 Void 之外修改的平台 Worker](/zh/guide/platform/installation/maintenance#workers-changed-outside-void)。

向未经验证的地址发信，需要完成 Cloudflare Email Sending 开通流程，并使用 [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans)。

### 设置允许的收件人范围 {#deciding-who-mail-may-reach}

默认情况下，共享发件人只能向各项目已验证的收件人发信。如果团队应用主要向同事发邮件，可以为整个平台统一扩大范围：

```sh
void platform email policy
void platform email policy-set domains --domains example.com,corp.example.net
void platform email policy-set any
void platform email policy-set verified
```

在管理员界面的 **Email（邮件）** 页面或通过上述命令选择策略：

- `verified`：仅允许各项目已验证的收件人。
- `domains`：允许已验证的收件人，以及所列域名下的任意地址。
- `any`：允许任意收件人。

向未验证的收件人发信，仍然需要完成 Cloudflare Email Sending 开通流程并使用 [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans)，否则发送会返回 `UNVERIFIED_DESTINATION`。使用项目自定义域名发出的邮件，以及发往平台自身邮件域名的邮件，始终要求验证收件人。

策略变更作用于新的发送请求；已获准开始的发送尝试可以继续完成。

### 项目限额 {#project-caps}

每个项目的发送提交量按收件人计数：默认每个 UTC 自然月最多 200 次，任意滚动的 60 秒窗口内最多 10 次。发送尝试一旦开始就计入额度，即使失败或结果无法确定，也不会退回额度。可以通过项目 ID 或 slug 调高或调低限额：

```sh
void platform email limit hr-portal --monthly 2000 --burst 30
```

在管理员界面的项目页面可以查看当前限额，并清除覆盖设置。

### 恢复中断的发送 {#recovering-an-interrupted-send}

如果发送程序在开始调用服务提供方后停止，结果尚未确定的发送尝试会阻止删除项目或发件域名。先查看尝试 ID 和开始时间：

```sh
void platform email attempts --project hr-portal
```

首先，通过 Worker 日志或事件记录确认原执行已经结束。该尝试开始至少 24 小时后，可以填写审计原因进行处理，原因中不得包含收件地址或邮件内容：

```sh
void platform email attempt-resolve <attempt-id> --ended --reason "Original Worker execution ended; provider outcome could not be verified" --plan
void platform email attempt-resolve <attempt-id> --ended --reason "Original Worker execution ended; provider outcome could not be verified"
```

这会将发送结果记为 `outcome_unknown`，并解除对应的清理阻断。该尝试仍计入额度，且永远不会重试。如果保留 30 天的投递记录已经过期，则只移除不含收件人信息的清理保护记录。原执行仍可能处于活动状态时，不要处理该尝试。

查看项目保留的回执及各收件人的处理结果：

```sh
void platform email logs hr-portal --page 1 --limit 50 --json
```

日志包含操作 ID、已记录的结果、服务提供方引用和错误码。项目删除后，在 30 天元数据保留期内仍可通过项目 ID 查询。日志不会记录邮件正文、主题、附件或凭据。

### 为项目注册邮件域名 {#registering-email-domains-for-projects}

用户可能没有 Cloudflare 账号。将平台设为由管理员注册邮件域名后，`void email domain add` 会输出需要请管理员执行的命令，而不是打开令牌创建页面：

```sh
void platform email settings-set --domains admin
```

然后为项目注册域名。DNS 区域必须位于平台的 Cloudflare 账号中；配置使用平台自身的凭据完成，不会为每个域名单独存储 Cloudflare 凭据：

```sh
void platform email domain-add example.com --project hr-portal
void platform email domain-status example.com
void platform email domain-rotate-secret example.com
void platform email domains
```

使用选定 Cloudflare DNS 区域的根域名。平台托管的自定义收信使用该 DNS 区域的兜底规则，不覆盖子域名；请选择没有其他邮件服务提供方的根域名，或使用平台共享邮件地址。`domain-status` 会分别报告收信、发信和管理功能的就绪状态。完成所需的 DNS 或 Cloudflare 控制台操作后，使用 `domain-sync` 同步配置。需要显式替换 DNS 区域的入站凭据时，使用 `domain-rotate-secret`。开通 Email Sending 需要 Workers Paid；升级后，`domain-sync` 会重新尝试开通。对于另一个 Cloudflare 账号中的 DNS 区域，通过标准输入提供该账号的 API 令牌：

```sh
void platform email domain-add other.example --project hr-portal --token-stdin --yes < token.txt
```

项目所有者可以在 `void email domain list` 和 `status` 中看到管理员注册的域名。对于所有者无法自行完成的步骤，`status` 会指出应使用的 `void platform email` 命令；`sync` 和 `remove` 则会提示使用 `domain-sync` 和 `domain-remove`。在切换到 `admin` 模式之前由所有者注册的域名，仍由其负责续期、同步和移除。运行时令牌需要具备[邮件权限](/zh/guide/platform/installation/credentials#enable-email)，这些操作才能正常工作。

权限被拒绝会使配置处于阻断状态。修正权限后，运行 `domain-sync` 继续原配置操作。再次运行 `domain-rotate-secret` 可以继续被阻断的轮换，并保留已暂存的新密钥。如果删除项目后留下了被阻断的域名清理，修正权限并运行 `domain-remove <domain>`，即可继续完成保留的清理操作。如果令牌已经过期或被撤销，请提供作用范围相同、对应同一账号和 DNS 区域的替换令牌：

```sh
void platform email domain-remove other.example --token-stdin --yes < token.txt
```

仅当项目删除已开始，且没有其他项目使用该连接时，才能采用此恢复方式。对于尚未开始删除的项目，请通过 `domain-add` 续期令牌。超时的 Cloudflare 变更会保持停止，因为重放操作可能导致服务提供方重复写入。确认原执行已经结束后，等待 24 小时，检查预览中指定的具体路由、Worker、密钥、兜底规则或 Sending 资源，再使用对应的恢复保护操作：

```sh
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason "Provider state verified" --plan
void platform email operation-resolve <operation-id> --ended --outcome <applied|not-applied> --reason "Provider state verified"
```

恢复时必须使用创建该持久化操作意图的平台版本。`applied` 会继续执行而不重放写入；`not-applied` 允许重试同一个步骤。密钥轮换会保留已暂存的那一代密钥，移除操作则从尚未解决的清理步骤继续。不能仅凭经过的时间决定重试。

### 从已有收信服务的域名发信 {#sending-from-a-domain-that-already-receives-mail}

如果根域名已经通过其他服务提供方收信，例如 Microsoft 365 或 Google Workspace，请将其注册为仅发信域名：

```sh
void platform email domain-add brand.example --project hr-portal --outbound-only
```

之后，项目可以从该根域名下的任意地址发信，例如 `support@brand.example`，但不能通过平台在该域名收信：MX 记录、根域名 SPF 记录和入站邮件仍由现有服务提供方管理。

- 必须能够使用 Cloudflare Email Sending，这需要 Workers Paid。不可用时会阻断配置，不会退回到只能向已验证收件人发信的模式。升级后运行 `domain-sync`。
- Email Sending 会在 `cf-bounce.<domain>` 和 `_dmarc.<domain>` 添加自己的记录。如果 Cloudflare 报告现有记录与其冲突，例如存在多条 DMARC 记录，配置会被阻断，错误信息会逐条列出记录。修正后运行 `domain-sync`。
- 只有管理员可以注册仅发信域名，且必须使用 DNS 区域的根域名。平台共享邮件 DNS 区域不能设为仅发信。
- `domain-rotate-secret` 不适用于此模式。`domain-remove` 会停止通过平台发信，且不会更改 MX 记录。
- 要在仅发信模式与平台托管收信模式之间切换，必须先移除域名，再重新添加。
