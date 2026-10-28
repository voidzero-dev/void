---
outline: deep
---

# 停用与卸载 {#disable-and-uninstall}

要暂停平台并保留数据，运行：

```sh
void platform disable [id] --plan
void platform disable [id]
```

停用的平台会拒绝应用流量，但保留域名和路由。平台 API 也会拒绝请求，因此依赖该 API 的 CLI 命令，包括登录和部署，都会失败，直到平台重新启用。只有 `<api-url>/admin/status` 上的管理员状态页面和管理员登录仍然可用。修复和升级都会保留停用状态。

启用平台时，会使用所选运行时重新部署平台 Worker，验证后再恢复流量。如果要使用自定义平台构建，请传入 `--runtime <path>`：

```sh
void platform enable [id] --plan
void platform enable [id]
```

在非交互式 Shell 中执行变更命令时，请添加 `--yes`。

平台停用期间，不会将队列批次投递给应用，而是在五分钟后重试。队列的保留期限和重试次数限制仍然生效。如果需要长时间暂停，请规划死信队列或其他消息恢复方式。

## 卸载 {#uninstall}

执行卸载前，请先预览将要移除的内容：

```sh
void platform uninstall [id] --plan
void platform uninstall [id]
```

卸载会阻止平台流量，移除所有剩余平台 Worker 都不再使用的队列，并列出保留的资源，供你审查。变更前，请使用 `--plan` 查看将要删除和保留的资源。默认情况下，Worker、这些 Worker 使用的队列、KV、R2、Hyperdrive、分发命名空间和 AI Gateway 都会保留在账号中。接管的已有资源、外部 PostgreSQL 和 DNS 区域始终保留。再次安装平台时，请使用新的空 PostgreSQL 数据库。Email Routing 设置会保留；`--purge-resources` 只移除将邮件发送到平台的规则。除非使用 `--purge-resources`，否则 DNS 记录、路由、自定义域名和 Cloudflare Access 资源也会保留。

卸载完成后，保留资源的记录仍会存放在 `~/.void/platforms/<account-id>/<installation-id>.json`。未使用 `--purge-data` 时，同目录中的加密凭据文件 `<installation-id>.recovery.enc` 也会保留。完成下文的手动清理后，再删除这两个文件。

如果还要移除归安装器所有、且符合删除条件的数据资源，请运行：

```sh
void platform uninstall [id] --purge-data
```

即使使用 `--purge-data`，Void 仍会保留 Worker、这些 Worker 使用的队列、R2、AI Gateway、DNS 记录、路由、自定义域名、Access 资源、接管的已有资源、外部 PostgreSQL 和 DNS 区域。如果希望移除这些资源，请在 Cloudflare 控制台中审查，或使用 `--purge-resources`。

### 移除 Void 创建的全部资源 {#remove-everything-void-created}

要删除本次安装创建的全部 Cloudflare 资源，请运行：

```sh
void platform uninstall [id] --purge-resources --plan
void platform uninstall [id] --purge-resources
```

`--purge-resources` 包含 `--purge-data`。它还会删除平台 Worker、队列、分发命名空间中剩余的应用 Worker、R2 存储桶及其对象、AI Gateway、平台 DNS 记录、Worker 路由和自定义域名，以及安装程序创建的 Access 应用和服务令牌。预览计划会按删除顺序列出各项资源，同时列出所有保留内容。如果 Cloudflare 显示 AI Gateway 创建于安装之后，例如该网关曾被删除后又以同名重新创建，它会被保留并列出。

如果平台会发送邮件，卸载时会先删除发件域名所属 DNS 区域中，将邮件发送到平台邮件网关 Worker 的 Email Routing 规则；对应的 catch-all 规则会被重置为丢弃邮件。Email Routing 会保持启用，发件域名的 MX、SPF 和 DKIM 记录也会保留。

它绝不会移除 DNS 区域、接管的已有资源、外部 PostgreSQL、其他 Email Routing 设置、Analytics Engine 数据集、你选用的 Access 策略或身份提供商，以及 API 令牌。完成卸载后，请撤销你为平台创建的 API 令牌。

执行变更前，`--purge-resources` 会检查是否已没有剩余项目，以及能否读取计划删除的资源。请先使用 `void project delete <name>` 删除所有项目。

将 `CLOUDFLARE_API_TOKEN` 设为具有 `--plan` 所列 Edit（编辑）权限的令牌。浏览器登录无法删除 DNS 记录或 Access 资源。如果 Access 资源位于独立的身份账号中，还需要该账号内的相应权限；启用邮件的平台还需要发件域名所属 DNS 区域上的 **Zone → Email Routing Rules → Edit（编辑邮件路由规则）**权限。

读取检查无法验证 Edit（编辑）权限。如果删除操作被拒绝，卸载可能已经停用了流量或移除了部分资源。请更新令牌权限，再次运行命令以继续。

如果路由、自定义域名、DNS 记录或 Access 资源已与安装记录不符，例如某条路由现在将流量发送给另一个 Worker，该资源会被保留并列出原因，卸载则继续进行。其他人正在修改平台 Worker、路由或自定义域名时，请勿运行 `--purge-resources`：如果资源在 Void 检查后、删除前发生变化，Void 无法检测到此次变化。

如果 Cloudflare 拒绝删除，例如你自行创建的某个 Worker 仍向平台日志接收 Worker（tail Worker）发送日志，卸载会停止并指出相关资源。解决问题后，再次运行同一个命令即可继续。

如果普通卸载或带 `--purge-data` 的卸载尚未完成就停止，可以在重新运行时添加 `--purge-resources`，一并删除之前保留的资源。如果卸载已经完成，则应使用下文的手动步骤。

### 移除保留的资源 {#remove-retained-resources}

未使用 `--purge-resources` 卸载后，如果某个资源仍被平台 Worker 使用，Cloudflare 会拒绝删除它。请在 Cloudflare 控制台中按以下顺序移除剩余资源，跳过已经不存在的项：

1. 删除平台 DNS 记录、Worker 路由和自定义域名。
2. 如果平台会发送邮件，打开发件域名所属 DNS 区域的 **Email Routing（邮件路由）**。删除将邮件发送到平台邮件网关 Worker 的路由规则和所有 catch-all 规则。然后从 Email Routing 中移除发件子域名；如果你只是为平台启用了 Email Routing，也可以将其停用。
3. 打开每个平台队列，将平台 API Worker 从其消费者中移除。
4. 删除除日志接收 Worker 以外的平台 Worker；日志接收 Worker 的名称以 `-tail` 结尾。
5. 删除平台队列。
6. 删除分发命名空间中的应用 Worker，再删除该命名空间。
7. 删除日志接收 Worker。如果其他 Worker 仍向其发送日志，Cloudflare 会拒绝删除。
8. 删除平台 KV 命名空间和 Hyperdrive 配置。
9. 清空 R2 存储桶，再将其删除。
10. 删除 AI Gateway。

如果安装时配置了 Cloudflare Access，卸载计划会列出记录中的应用和服务令牌，包括其所有权和 ID。卸载后，请在 Zero Trust 中审查这些资源。只有确认没有其他用途时，才移除安装程序创建的资源；从公司已有配置中接入的资源，仍由原所有者管理。

卸载不会移除为[项目零信任访问](/zh/guide/platform/administration/zero-trust)创建的应用。零信任功能仍然启用，或仍有 Access 应用时，卸载和 `--plan` 都会在任何变更前停止，并列出这些应用。请先运行 `void platform zero-trust disable`。卸载会从安装数据库读取这些信息，因此数据库无法连接时也会停止。

如果安装数据库已永久丢失且无法恢复，没有卸载命令能够清除本地安装记录或列出对应的 Cloudflare 资源。决定不再恢复该安装后，请删除 `~/.void/platforms/<account-id>/<installation-id>.json`，以及同目录中的 `<installation-id>.recovery.enc` 或 `<installation-id>.secrets.enc` 文件。这样只会移除本地状态和加密凭据，不会删除 Cloudflare 资源。请按[移除保留的资源](#remove-retained-resources)手动审查并移除这些资源。

如果平台还没有任何用户，例如首位管理员的设置尚未完成，就没有人能够运行 `zero-trust disable`。此时，卸载会自行关闭项目零信任功能，并删除对应应用。请在安装平台的计算机上运行卸载。如果卸载提示需要升级，请先更新旧版平台运行时。

::: details 为什么有些资源需要手动清理

可能已被共享或改作他用的资源，需要在删除前人工审查。Void 会验证所有权，保留这些资源，并阻止平台流量。

移除操作中断时，再次运行命令即可继续。如果资源所有权已改变，请先解决报告的冲突，再重试。

外部 PostgreSQL 及其数据始终由你管理。

:::
