---
outline: deep
---

# 项目零信任防护 {#operator-zero-trust}

使用管理员会话运行这些命令。平台选择、预览和确认方式请参阅[平台管理](/zh/reference/cli/platform#operator-commands)。

配置整个安装实例的 Cloudflare Access 策略，以及各个项目的覆盖设置：

```sh
void platform zero-trust status [--check]
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --identity-providers <id[,id...]> \
  --policies <id[,id...]> \
  [--existing-projects <protected|public>] \
  [--protect-new-projects] \
  --token-stdin \
  --yes
void platform zero-trust reconcile
void platform zero-trust disable

void platform zero-trust project-status <project-id>
void platform zero-trust project-protect <project-id>
void platform zero-trust project-public <project-id>
void platform zero-trust project-reconcile <project-id>
```

新安装时，通过 `void platform install` 配置应用访问方式，之后可以使用这些命令查看或修改。要为启用了 Default-Deny 的账号配置或续期仅公开应用的规则，请省略身份策略，并使用 `--public-apps`：

```sh
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --public-apps --token-stdin --yes
```

从禁用状态启用时，请添加 `--existing-projects public`。仅公开应用的规则不能与受保护项目选项组合使用。如果要将已有的受保护配置改为仅公开规则，请先禁用；在启用了 Default-Deny 的账号中，Access 可能在此切换期间阻断流量。

变更操作支持 `--plan`、`--yes` 和 `--timeout`。使用 `--plan` 代替 `--yes`，可以只查看变更而不执行。Access 管理令牌只接受通过标准输入提供。零信任防护使用托管平台的 Cloudflare 账号。省略 `--protect-new-projects` 时，新项目默认公开。启用零信任防护时必须提供 `--existing-projects`，启用后再提供此选项则会被拒绝；之后的配置变更会保留各个项目的防护设置。`status` 报告已保存的状态，`--check` 还会将其与 Cloudflare Access 比较。如果状态一直为 `configuring` 或 `disabling`，请运行 `void platform zero-trust reconcile`，继续已保存的操作。受保护的项目最多支持 100 个自定义域名。

令牌需要平台 Cloudflare 账号范围内的 **Access: Apps and Policies Write** 和 **Access: Organizations, Identity Providers, and Groups Read** 权限。配置受保护模式时，请至少选择一条根据身份匹配人员的 Allow（允许）策略；Void 不接受 Bypass（绕过）或 Service Auth（服务认证）策略，也不接受允许 Everyone（所有人）或任意服务令牌的规则。使用要求和恢复方式请参阅[项目零信任防护](/zh/guide/platform/administration/zero-trust)。
