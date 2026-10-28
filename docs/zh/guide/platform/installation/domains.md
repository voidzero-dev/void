---
outline: deep
---

# 域名与资源 {#domains-and-resources}

## 添加域名 {#adding-a-domain}

准备好域名后，运行：

```sh
void platform domain set example.app --plan
void platform domain set example.app
```

该命令会选择已安装的平台，或让你从列表中选择；随后查找或创建对应的 DNS 区域（Zone），设置 DNS 和路由，并在确认 HTTPS 可用后发布新的应用 URL。创建 DNS 记录或 DNS 区域时，请按[安装配置](/zh/guide/platform/installation/setup)中的说明设置管理令牌。还需要为现有运行时令牌授予新 DNS 区域上的 **Cache Purge: Purge（清除缓存）**权限；Void 会通过正在运行的平台检查该权限，无需你再次粘贴令牌。

如果域名服务器、证书或项目零信任保护尚未就绪，请按输出的指引处理，再运行同一个命令。Void 会先保留各个项目原有的公开或受保护设置，再启用新 URL。在配置期间和完成后，应用的 workers.dev URL 都会继续可用。项目、部署、密钥和平台 API URL 均保持不变，因此开发者无需重新连接，已配置的登录回调地址也不会改变。DNS 和配置变更可能需要一段时间才能传播生效。

使用 `--installation <id>` 可以显式选择安装实例；对于 `apps.example.com` 这样的应用域名，使用 `--zone example.com` 指定所属 DNS 区域；使用 `--dedicated-zone` 则可在专用 DNS 区域上配置兜底路由。嵌套域名仍需要下文所述的通配符证书。此命令用于添加第一个域名，目前不支持替换已有应用域名。命令会使用已安装的运行时，无需传入 `--runtime`，也无需重新部署应用。

选择应用域名时，请确保其通配符不会妨碍已有 Worker 自定义域名的访问。已有的、更具体且覆盖全部请求的路由可以让这些主机名保持可用。如果 Void 报告冲突，请选择其他应用域名；新安装时，也可以先运行 `void platform install --workers-dev`，稍后再添加合适的域名。

浏览器登录会话按源隔离。使用自有 OAuth Provider 的应用可能需要注册新的回调 URL。Void 内置的身份认证默认会自动使用请求的源，除非应用覆盖了该配置。

同一个应用域名下的应用可以设置 Cookie，让该域名下的其他应用也收到这些 Cookie。使用 `apps.example.com` 这样的嵌套域名时，应用还可以为 `example.com` 及其其他子域名设置 Cookie。使用 `workers.dev` 测试 URL 的应用，可以设置该账号 `workers.dev` 子域名下所有 Worker 都能收到的 Cookie。如果团队以外的人也能部署应用，请使用只承载 Void 应用的域名。为数千名独立开发者提供服务的平台，还可以申请将应用域名加入 [Public Suffix List（公共后缀列表）](https://github.com/publicsuffix/list/wiki/Guidelines)。

### 测试模式有何不同？ {#what-changes-in-testing-mode}

在测试模式下，每个应用都会获得一个 `workers.dev` URL。添加域名后，这些 URL 仍然可用，后续新建的应用则使用该域名。

测试 URL 支持 WebSockets、SSE 和共享 ISR 存储，但不会使用额外的边缘响应缓存。卸载后，它们的转发 Worker 会保留，需要手动清理。停用平台或暂停项目仍然会阻止这些 URL 的流量。

## 其他域名选项 {#other-domain-options}

::: details 自定义 API 主机名

安装时传入 `--control-plane-domain platform.example.net`。该主机名必须属于所选账号和管理令牌能够管理的 DNS 区域。省略此选项时，API 会继续使用 `workers.dev`。

:::

### 使用嵌套应用域名 {#using-a-nested-application-domain}

::: details 在已有公司 DNS 区域内使用 apps.example.com

位于 `my-app.apps.example.com` 的应用需要 `*.apps.example.com` 的证书。`example.com` 的 Universal SSL 仅覆盖一级主机名。安装前，请通过付费附加服务 [Advanced Certificate Manager（高级证书管理器）](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)配置有效的通配符证书，或使用已有的自定义通配符证书：

```sh
void platform install --application-domain apps.example.com --zone example.com --plan
```

管理令牌需要该 DNS 区域上的 **SSL and Certificates: Read（读取 SSL 和证书）**权限，也可以使用 Edit（编辑）权限，以便检查证书。Void 不会自动订购证书或启用付费产品。请勿启用 `--dedicated-zone`：该选项仅适用于应用域名与整个 DNS 区域相同的安装，会为其他路由未匹配的流量添加兜底路由。

:::

## 项目自定义域名 {#project-custom-domains}

项目可以通过 Cloudflare for SaaS 的自定义主机名功能，使用 `www.example.com` 等自有域名。这需要专用的应用 DNS 区域。你可以在安装时启用，也可以之后通过升级启用：

```sh
void platform install --application-domain example.app --zone example.app --dedicated-zone --custom-domains
void platform upgrade <installation-id> --custom-domains
```

运行时令牌需要应用 DNS 区域上的 **SSL and Certificates: Edit（编辑 SSL 和证书）**权限。Void 会在运行时令牌的创建链接中包含此权限，并在部署前检查；如果令牌创建于启用自定义域名之前，需要为其补充该权限。添加第一个域名前，请先在此 DNS 区域上配置 Cloudflare for SaaS，只需配置一次：

1. 为 `cname.<application domain>` 创建启用代理的 DNS 记录，例如指向 `100::` 的 `AAAA` 记录。
2. 打开 **SSL/TLS > Custom Hostnames（自定义主机名）**，启用 Cloudflare for SaaS，并将 `cname.<application domain>` 设为回退源站。

随后，项目所有者运行 `void domain add <hostname>`。Void 会输出 CNAME 目标 `cname.<application domain>`，以及用于证明所有权的 TXT 记录。记录解析生效且证书签发后，专用 DNS 区域的兜底路由就会将该主机名的请求转发给项目。

## 可选的用户控制台 {#optional-dashboard}

核心安装包含 API 的 `/admin/` 页面。你可以单独部署可选的用户控制台，并在安装时通过 `--dashboard-url https://dash.example.com` 配置其 HTTPS 源。

对于已有安装，使用以下命令预览并应用配置：

```sh
void platform repair <installation-id> --dashboard-url https://dash.example.com --plan
void platform repair <installation-id> --dashboard-url https://dash.example.com --yes
```

源地址不能包含凭据、路径、查询参数或片段。Void 会保存此地址用于登录回调，并在升级和修复时保留。该命令不会创建控制台 Worker 或 DNS 记录。请按源码应用的[独立控制台部署准备](https://github.com/voidzero-dev/void/tree/main/platform/packages/dashboard#standalone-deployment)进行操作，使用尚未占用的 Worker 名称、你的控制台主机名，以及指向已安装 API Worker 的服务绑定，部署自己的控制台。将其 `API_URL` 设为公开 API 源，`DASHBOARD_URL` 设为控制台源，`SITE_DOMAIN` 设为安装实例的应用域名。省略该选项则保留已保存的源地址。控制台提供登录、关联登录方式和退出登录；用户项目和团队管理请使用 CLI。

如果平台受 Access 保护，其 Access 应用也必须覆盖此控制台源。请在安装保护时配置该源地址。对于已经受保护的平台，如果要修改该地址，需要先通过身份认证配置显式移除保护，再应用新的源地址，之后重新启用保护。如果注册依赖 Access 网关的准入控制，请先选择其他准入规则。如果配置的源地址不在当前生效的保护范围内，维护操作会停止。

## Cloudflare 资源清单 {#cloudflare-footprint}

在 Cloudflare 允许的情况下，新建的平台资源会使用确定性的 `void-<installation-name>-<role>` 名称，例如 `void-team-api`。请在账号内选择尚未使用的安装名称；如果名称与不属于本次安装的资源冲突，Void 会停止，不会替换该资源。已有安装会保留记录中的名称，包括较早版本使用的带后缀名称。

| 资源 | 数量 | 用途 |
| --- | ---: | --- |
| Workers | 5 个，每个使用 workers.dev 的应用另需 1 个 | API/控制平面、代理、日志接收、请求分发、邮件网关和测试源转发 |
| KV 命名空间 | 3 | 路由、ISR 缓存和静态资源存储 |
| R2 存储桶 | 1 | 静态资源和部署资源 |
| Queues | 3 | 用量事件、定时任务触发和部署 |
| Workers for Platforms 分发命名空间 | 1 | 用户应用 Worker |
| Hyperdrive 配置 | 1 | 平台使用的外部 PostgreSQL |
| AI Gateway | 1 | 按安装实例隔离的 AI 路由和计量 |
| 启用代理的通配符 DNS 记录 | 0 或 1 | 仅在配置应用域名时创建 |
| DNS 区域（Zone） | 0 或 1 | 仅在所需应用 DNS 区域不存在时创建 |

API Worker 使用四个 Durable Object 类，分别处理用量、定时任务调度、错误监控和并发。Worker 绑定会在 Analytics Engine 中创建请求和日志数据集，因此必须先[为账号启用 Analytics Engine](/zh/guide/platform/installation/prerequisites#if-cloudflare-rejects-analytics-engine)。核心安装不会创建 Container 应用、GitHub App、控制台 Worker 或构建 Worker。
