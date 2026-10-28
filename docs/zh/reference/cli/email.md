---
outline: deep
---

# 邮件 {#email}

查看邮件用量，并管理项目允许发送邮件的收件地址。运行时 API 请参阅[邮件](/zh/guide/email)。

邮件命令与部署命令按相同顺序确定项目：`--project`、`VOID_PROJECT`、已关联的项目。`void email setup` 和 `void email status --platform cloudflare` 例外：它们通过 Cloudflare 登录（`void cloudflare login`）操作你自己的 Cloudflare 账号，不需要 Void 项目。

## `void email usage` {#void-email-usage}

```
void email usage [--project <name>]
```

显示当月收件人发送尝试次数、收到的邮件数量、每月发送尝试上限，以及剩余额度。已预留的提交会计入限额；发送尝试一旦开始，即使投递失败或结果未知，也不会退回额度。已暂停的项目会在输出中标记。

## `void email logs` {#void-email-logs}

```
void email logs [--limit <n>] [--project <name>]
```

显示保留 30 天的近期邮件操作元数据，包括时间戳、方向、操作 ID、收件人和状态。`--limit` 接受 1–100。不会存储主题、正文或附件。提供商接受发送请求，并不代表邮件已投递到邮箱；结果未知时，请先检查再重试。

## `void email destinations` {#void-email-destinations}

```
void email destinations [--project <name>]
```

列出项目的收件地址及其状态（`verified`、`pending` 或 `failed`）。在默认收件人策略下，发出的邮件只会投递到已验证的地址。

## `void email allow` {#void-email-allow}

```
void email allow <address> [--project <name>]
```

将一个收件地址添加到项目的目标列表。Cloudflare 会向该地址发送验证链接，收件人无需 Void 或 Cloudflare 账号，点击即可验证。然后运行 `void email destinations`：这次查询才会记录点击结果。在此之前，向该地址发信会为该收件人返回 `UNVERIFIED_DESTINATION`。如果链接未送达或已经过期，请在地址仍处于待验证状态时再次运行 `void email allow <address>`；CLI 会重新发送链接，或说明如何获取新链接。

项目创建时会自动添加所有者的邮箱，因此无需手动添加，但仍需验证：除非 Cloudflare 已经为你之前的项目验证过该地址，否则请点击收到的验证链接，再运行 `void email destinations`。在此之前，向自己发送邮件也会为该收件人返回 `UNVERIFIED_DESTINATION`。

## `void email disallow` {#void-email-disallow}

```
void email disallow <address> [--project <name>]
```

从项目的目标列表中移除一个收件地址。之后发往该地址的新请求会立即被拒绝，之前已获准的发送尝试则可以完成。此操作无需部署。

## `void email alias` {#void-email-alias}

```
void email alias [--project <name>]
void email alias <name> [--yes] [--project <name>]
```

不传名称时，显示项目在平台共享邮件域名上的地址，以及入站邮件能否送达。

传入名称时，为该地址设置更短的名称：`void email alias acme` 会让 `acme@<mail domain>` 和 `acme+<tag>@<mail domain>` 的邮件到达项目，也允许项目从这些地址发信。只有项目所有者可以设置。名称遵循与项目 slug 相同的规则，且不能与任何其他项目的 slug 或别名重复。五个字符或更短的名称，需要套餐允许使用短名称。

别名是永久的，不能修改或移除，只会在项目删除后释放。原 slug 地址仍可正常收发邮件，不会影响已有使用方式。CLI 会请求确认；传入 `--yes` 可跳过提示，在非交互式终端中必须提供此选项。项目部署了 `email/` 处理函数，且收件规则就绪后，别名地址才开始接收入站邮件；可以运行 `void email alias` 检查。分享别名前，请使用当前版本的 `void` 重新部署：旧版构建的应用中，`message.to` 仍会带有别名前缀，即 `acme+support@…`，而不是 `support@…`。

## `void email domain` {#void-email-domain}

```
void email domain <add|status|list|sync|rotate-secret|remove> [<domain>] [--project <name>]
```

将你拥有的 Cloudflare DNS 区域中的自有域名注册到项目，用于收发邮件。仅适用于 Void 平台；直接使用自己的 Cloudflare 账号时，邮件域名来自 `email.from`，见 `void email setup`。操作步骤请参阅[在平台上使用自己的域名](/zh/guide/email/domains#your-own-domain-on-the-platform)。

### `void email domain add` {#void-email-domain-add}

```
void email domain add <domain> [--project <name>]
```

使用限定权限范围的 Cloudflare API 令牌，为项目注册指定域名。CLI 会打开令牌模板，接受隐藏输入的粘贴或刚复制的令牌，并要求确认账号和 DNS 区域限制。凭据会为该 DNS 区域连接加密存储。自定义入站邮件要求使用 Cloudflare DNS 区域的根域名，因为兜底规则不覆盖子域名。不属于本次配置的 MX 记录和兜底规则会保留；如果根域名已经用于收信，请选择其他 DNS 区域的根域名，或使用平台共享邮件地址。每个自定义根域名只能属于一个项目。配置会返回操作 ID，方便在请求中断后检查状态，无需重新开始操作。

### `void email domain status` {#void-email-domain-status}

```
void email domain status <domain> [--project <name>]
```

显示已记录的入站、出站和管理功能就绪状态、观测时间，以及最新操作。使用 `sync` 同步修复配置并刷新就绪状态。

### `void email domain list` {#void-email-domain-list}

```
void email domain list [--project <name>]
```

列出项目已注册的邮件域名及其就绪状态。

### `void email domain sync` {#void-email-domain-sync}

```
void email domain sync <domain> [--project <name>]
```

同步修复域名连接，并刷新就绪状态。同步不会轮换密钥。如果操作被阻断或结果不确定，命令会以失败状态退出，并指出需要检查的操作。

### `void email domain rotate-secret` {#void-email-domain-rotate-secret}

```sh
void email domain rotate-secret <domain> [--project <name>]
```

轮换当前域名与同一 DNS 区域中其他域名共用的连接密钥。入站投递必须已就绪；如果配置尚未完成，请先运行 `void email domain sync <domain>`。结果不确定时，请先检查再重试。

### `void email domain remove` {#void-email-domain-remove}

```
void email domain remove <domain> [--project <name>]
```

停用该域名的项目关联，并记录清理操作。其他域名使用的 DNS 区域资源仍会保留。未完成或结果不确定的清理会继续保留记录，直到能够安全地同步修复。

## `void email status` {#void-email-status}

```
void email status --platform cloudflare
```

检查 `email.from` 中配置的域名，包括权限、DNS、路由、发信、处理函数对应的地址和邮件绑定。配置不完整时，会以失败状态退出。Workers Free 上即使只允许向已验证地址发信，配置也可以达到就绪状态；升级到 Workers Paid 后，请运行 `void email setup --platform cloudflare`。

`void email status` 只读取你自己的 Cloudflare 账号，因此必须提供 `--platform cloudflare`。在 Void 平台上，请使用 `void email usage` 和 `void email destinations`。

## `void email setup` {#void-email-setup}

```
void email setup --platform cloudflare
```

在通过 CI 部署前配置邮件。需要在 `void.config.ts` 中设置 `email.from`，并提供交互式终端和 Cloudflare 邮件权限。

Void 会显示计划中的 DNS、路由、加号地址和发信变更，并在执行前请求确认。提交 `void.lock.json`，然后在 CI 中运行 `void deploy --platform cloudflare --require-email`。

Workers Free 仍支持接收入站邮件，以及向已验证的收件地址发信。升级到 Workers Paid 后，再次运行此命令即可启用向任意收件地址发信。请参阅[邮件配置](/zh/guide/email/domains#your-own-cloudflare-account)。
