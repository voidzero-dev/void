---
outline: deep
---

# 项目零信任防护 {#project-zero-trust}

项目零信任防护会在部署到平台上的项目域名前接入 Cloudflare Access，自定义域名也包括在内。访客必须先通过你配置的某个身份提供方登录，才能访问受保护的项目。你仍然可以单独将某个项目设为公开。

此功能独立于平台 API 的 Access 登录和访问防护，不影响直接部署到 Cloudflare 的项目。

你可以在 `void platform install` 期间选择应用的访问方式，也可以按本页说明稍后配置。安装程序会复用平台策略，或协助你选择独立的企业规则，并在开放流量前完成配置。

如果账号启用了 Default-Deny（默认拒绝），而你选择将应用公开，Void 会改为管理范围明确的公开访问规则。新建项目和自定义域名也会自动保持公开。只要 Default-Deny 仍启用，就应保留这些规则；移除它们可能阻断流量。仅提供公开应用的平台在启用应用防护前，无需配置身份提供方或企业策略。在管理界面续期这类平台的令牌时，将策略字段留空即可。

## 使用要求 {#requirements}

- 托管平台的账号中已有 Cloudflare Zero Trust 组织，并配置了要使用的身份提供方和可复用的 Access 策略。至少选择一条根据身份匹配人员的 Allow（允许）策略。Void 不接受 Bypass（绕过）或 Service Auth（服务认证）策略，也不接受允许 Everyone（所有人）或任意服务令牌的规则。
- 该账号的 Cloudflare API 令牌，具有 **Access: Apps and Policies Write** 和 **Access: Organizations, Identity Providers, and Groups Read** 权限。Void 将它与平台运行时令牌分开管理，加密存储，保存后不会再次显示。
- 账号中的 Access 应用配额有余量。Cloudflare 默认每个账号最多允许 500 个应用。先统计你在 Void 以外管理的应用，再加上 Void 所需的应用数量，见 [Void 创建的 Access 应用](#access-applications-void-creates)。
- 平台 API、代理和邮件网关的主机名必须位于项目应用域名之外。如果项目防护会覆盖其中任何一个主机名，配置就会被拒绝。项目应用域名下的其他主机名也会要求登录，唯一例外是 `void-platform-health.<your domain>` 的 `/health` 路径：Void 会为健康检查保留该路径的公开访问，且绝不会从项目中提供这个路径。新项目不能使用该名称。已经使用该名称的项目会保留其他所有路径，并与其他项目一样按配置受到保护或公开访问。

## 启用零信任防护 {#enable-zero-trust}

在管理员界面打开 **Zero Trust（零信任）**，或使用运维 CLI：

```sh
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --identity-providers <id[,id...]> \
  --policies <id[,id...]> \
  --existing-projects public \
  --protect-new-projects \
  --token-stdin \
  --yes
```

- `--existing-projects protected|public` 决定如何处理已有项目。首次启用零信任防护时必须提供此选项。
- `--protect-new-projects` 用于保护从此刻起创建的新项目。省略此选项则使新项目公开。
- 用 `--plan` 代替 `--yes`，可以只检查变更而不执行。

日后如需更改身份提供方、策略、令牌或新项目的默认访问方式，运行同一命令，但不传 `--existing-projects`。已有项目会保留各自的防护设置；如需更改某一个项目，请使用下面的项目覆盖设置。

## 检查状态 {#check-status}

```sh
void platform zero-trust status
void platform zero-trust status --check
```

`status` 会显示已保存的设置、当前操作，以及受保护、公开或等待中的项目数量。`--check` 还会将设置与 Cloudflare Access 中的实际情况进行比较。在管理员界面中，使用 **Check with Cloudflare（与 Cloudflare 核对）**。

## 项目覆盖设置 {#project-overrides}

项目所有者和项目管理员可以保护项目或将其公开，只读成员可以查看状态。

```sh
void project zero-trust status
void project zero-trust protect
void project zero-trust public
void project zero-trust reconcile
```

`status` 还会说明当前是否允许更改防护设置。将某个项目设为公开，不会改变新项目的默认设置。

平台安装管理员可以在管理员界面的项目页面执行相同操作，也可以使用 `void platform zero-trust project-status|project-protect|project-public|project-reconcile <project-id>`。

部署和回滚会等待项目的防护变更完成。如果部署或回滚被拒绝，运行 `void project zero-trust status` 查看原因；所有者或项目管理员可以先运行 `void project zero-trust reconcile`，然后再重试。受保护的项目最多可以有 100 个自定义域名。

## 禁用零信任防护 {#disable-zero-trust}

```sh
void platform zero-trust disable
```

这会移除 Void 创建的 Access 应用，并将所有项目设为公开。大型平台会分步执行；请再次运行此命令，或检查 `void platform zero-trust status`，直到状态显示零信任防护已禁用，且没有正在执行的操作。

[卸载平台](/zh/guide/platform/installation/uninstall)前，请先禁用零信任防护，并等待对应应用被移除。如果某个项目的删除中途停止，请为该项目重试 `void project delete`。

## 防护如何工作 {#how-protection-works}

Cloudflare Access 负责登录并应用你设置的策略。Void 也会在提供受保护项目的内容前验证令牌。公开项目允许访客无需登录即可访问。

### 访客看到的流程 {#what-visitors-see}

受保护的项目会要求访客使用你选定的身份提供方之一登录。如果只选了一个，访客会直接跳转过去；否则，访客需要从所选提供方中选择一个。一次登录有效期为 12 小时，之后 Access 会再次要求登录。

项目防护会覆盖该项目响应的所有主机名：

| 主机名 | 受保护的项目 | 公开项目 |
| --- | --- | --- |
| `<slug>.<your domain>` | 需要登录 | 任何人都可访问 |
| 项目的 `workers.dev` 测试 URL | 需要登录 | 任何人都可访问 |
| 自定义域名，例如 `app.example.com` | 需要登录 | 任何人都可访问 |

Void 只覆盖当前平台的 `workers.dev` 测试 URL，不影响账号中的其他 Worker。如果平台没有配置域名，`workers.dev` 测试 URL 就是项目唯一的 URL，共享项目应用也只覆盖这些 URL。

#### 403 页面 {#the-403-page}

没有有效令牌的请求会收到 `403 Cloudflare Access authentication required`。页面请求会显示 HTML 错误页面；API 和资源请求会收到纯文本。这些响应从不缓存。

正常经过登录页面的访客通常不会看到此错误，但以下情况可能出现：

- 项目正在受保护与公开状态之间切换时，可能短暂出现；
- 项目的零信任变更尚未完成时；
- 在 Cloudflare 控制台中删除了 Void 管理的 Access 应用，或修改了它的主机名时。见[在控制台中编辑应用](#editing-applications-in-the-dashboard)。

#### 覆盖所有路径 {#every-path-is-covered}

防护作用于整个主机名，没有路径例外。`/api/*` 路由、静态文件、带哈希的资源、`robots.txt`、`favicon.ico`、服务端发送事件和 WebSocket 都要求访客已登录。

#### Webhook 与其他非浏览器客户端 {#webhooks-and-other-non-browser-clients}

项目防护要求具备人员身份。Webhook、CI 任务、可用性检查和未认证的 `curl` 调用会收到登录页面或 403。

如果项目必须接收此类请求：

- 使用 `void project zero-trust public` 将项目公开，并在自己的代码中验证调用方；或者
- 将机器调用的端点移到独立项目中，只公开该项目。

### Void 创建的 Access 应用 {#access-applications-void-creates}

Void 会在你的 Zero Trust 组织中创建并管理以下自托管应用：

| 应用 | 覆盖范围 | 策略 | 创建数量或条件 |
| --- | --- | --- | --- |
| 共享项目应用 | `*.<your domain>` 和当前平台的 `workers.dev` 测试 URL | 你选择的策略和身份提供方 | 配置了应用防护时创建一个 |
| 公开应用管理检查 | 保留且未使用的分发检查路径 | Deny Everyone（拒绝所有人）；验证管理权限，同时不开放主机名 | 仅公开模式下创建一个，代替共享通配应用 |
| 公开访问例外 | 某个公开项目的 `<slug>.<your domain>` 和 `workers.dev` 测试 URL | 面向 Everyone（所有人）的 Bypass（绕过）策略，名称为 `Void project is public` | 每个公开项目一个 |
| 自定义域名应用 | 某个项目的所有托管自定义域名 | 受保护的项目使用企业策略，公开项目使用 Bypass（绕过） | 每个具有托管自定义域名的项目一个 |
| 健康检查例外 | `void-platform-health.<your domain>/health` | 面向 Everyone（所有人）的 Bypass（绕过）策略，名称为 `Void platform health check` | 配置了域名的平台在启用零信任防护期间创建一个 |

通过安装程序配置的平台也会管理公开的自定义域名规则。项目在公开与受保护状态之间切换时，对应的自定义域名应用会更换策略。

如果安装程序已经配置了相同的健康检查例外，零信任防护会复用它。禁用项目零信任防护后，这条已有例外仍会保留，以便平台健康检查继续工作。

Void 所需的应用数量为：

```text
1 + health-check applications + public projects + projects with managed custom domains
```

第一个应用是使用共享企业策略的应用，或公开应用管理检查。健康检查例外只计一次，即使它与安装程序共用。例如，共有 40 个项目，其中有一条健康检查例外、10 个公开项目，以及 5 个具有托管自定义域名的项目，则需要 1 + 1 + 10 + 5 = 17 个应用。账号中的 Access 应用超过 500 个时，Void 会报错并停止。

#### 识别 Void 的应用 {#recognizing-void-s-applications}

运行 `void platform zero-trust status` 可以查看共享应用和健康检查应用；运行 `void platform zero-trust project-status <project-id>` 可以查看某个项目的应用。这些命令会显示应用的准确名称和 ID。

### 在控制台中编辑应用 {#editing-applications-in-the-dashboard}

请通过 `void platform zero-trust configure` 和项目命令管理 Void 的应用。在 Cloudflare 中编辑或删除这些应用，可能导致访问受阻，直到执行同步修复。下次 Void 更新应用时，可能会覆盖你在控制台中的编辑。

你可以在 Cloudflare 中编辑已选定的可复用策略规则。变更会影响使用该策略的所有项目。请保留基于身份的 Allow（允许）策略，不包含 Everyone（所有人）或服务令牌，然后运行以下命令检查：

```sh
void platform zero-trust status --check
```

- `drifted: true`：运行 `void platform zero-trust reconcile`。
- `present: false`：检查令牌、应用、身份提供方和策略，然后执行同步修复。

该命令检查共享应用和健康检查应用。对于公开访问例外或自定义域名应用，请使用项目的同步命令。

#### 修复命令 {#repair-commands}

| 命令 | 范围 | 谁可以运行 |
| --- | --- | --- |
| `void platform zero-trust reconcile` | 平台及所有项目 | 平台安装管理员 |
| `void platform zero-trust project-reconcile <project-id>` | 单个项目 | 平台安装管理员 |
| `void project zero-trust reconcile` | 当前关联的项目，或 `--project <slug>` 指定的项目 | 项目所有者和项目管理员 |

同步项目的零信任配置时，平台状态必须为 `ready`；否则请先同步平台配置。

如果应用被重命名，请在同步前恢复为记录中的名称。重复副本需要自行移除。删除共享应用会暂时阻断受保护项目的访问；删除健康检查例外可能阻断升级和修复，直到恢复该例外。

### 变更期间的行为 {#what-happens-during-changes}

防护变更期间可能暂时返回 403。如果某个步骤失败，受保护的项目会继续受到保护，或拒绝访客访问，直到变更完成。

保护项目或将其公开，通常会在命令返回前完成。如果仍在执行或报告错误，请查看 `void project zero-trust status`，修复报告的原因，然后运行 `void project zero-trust reconcile`。

平台范围的变更会分步执行。首次配置时，自定义域名会保持公开，直到 Void 处理到对应项目。禁用期间，不同主机名可能在不同时间变为公开。通过 `void platform zero-trust status` 跟踪进度。

新的自定义域名只有在对应项目的防护准备就绪后，才会开放访问。

### 缓存 {#caching}

携带 Access 令牌的请求会绕过 [ISR](/zh/guide/edge/revalidation#cache-bypass) 和[静态资源边缘缓存](/zh/guide/edge/static-assets#non-hashed-assets)。受保护的页面会在每次请求时渲染，因此可能增加延迟和请求用量。公开项目会保留共享缓存。

## 故障恢复 {#recovery}

- **状态停留在 `configuring` 或 `disabling`。** 大型变更会分步执行，定时维护会在几分钟内继续处理；你也可以运行 `void platform zero-trust reconcile`。
- **状态显示错误。** 修复报告的原因，例如令牌权限或应用数量限制，然后运行 `void platform zero-trust reconcile`。否则 Void 会每小时重试。
- **某个项目显示错误。** 其余变更仍会继续完成。Void 会每小时重试该项目，项目所有者或项目管理员也可以运行 `void project zero-trust reconcile`。在此之前，原本受保护的项目会继续受到保护，正在首次启用防护的项目也不会比变更前更加开放。
- **添加域名因某个项目而一直处于待处理状态。** 只有所有项目都准备就绪，Void 才会开放新域名。平台状态中的错误会列出无法更新的项目。使用 `void platform zero-trust project-status <project-id>` 逐一检查，修复原因后运行 `void platform zero-trust reconcile`，或重新运行域名命令。Void 也会每小时重试。在此期间，`workers.dev` URL 仍可正常使用。
- **新项目配置失败。** 项目仍会创建成功，但会显示警告。Void 会每小时重试，你也可以运行 `void project zero-trust reconcile`。
- **已保存的 API 令牌过期或被撤销。** 运行 `void platform zero-trust configure --token-stdin`，提供替换令牌，并保持身份提供方、策略和 `--protect-new-projects` 选项不变。不要传入 `--existing-projects`。Void 会继续未完成的变更，也包括未完成的禁用操作。完成之后再更改其他设置。
- **选定的身份提供方或策略被删除。** 运行 `void platform zero-trust disable`，停止未完成的配置并移除对应应用。这会将项目设为公开。然后使用新的选项重新配置零信任防护。
