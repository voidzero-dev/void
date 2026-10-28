---
outline: deep
---

# 前提条件 {#prerequisites}

运行 Void 平台需要：

- 已启用 Workers for Platforms、R2 和 Analytics Engine 的 Cloudflare 账号。
- 一个空的托管 PostgreSQL 数据库。
- 所选登录提供商的账号：GitHub、Google、OIDC 或 Cloudflare Access。
- 用于应用的域名；测试时也可以使用 `workers.dev`。你可以[稍后添加域名](/zh/guide/platform/installation/domains#adding-a-domain)。

Void 会通过 CLI 创建 Worker、存储、队列、路由和数据库表。

Workers for Platforms 需要单独订阅其付费套餐。Analytics Engine 可在 Workers Free 上使用，但必须先为账号启用。请查阅 [Analytics Engine 价格与额度](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)。数据库和 Cloudflare 用量分别计费。

## 准备 Cloudflare 账号和域名 {#prepare-your-cloudflare-account-and-domain}

在 [Cloudflare 控制台](https://dash.cloudflare.com/)中，选择用于托管平台的账号：

1. 打开一次 **Workers & Pages**，让 Cloudflare 为该账号开通 Workers。
2. 打开 **Workers for Platforms** 并启用其套餐。确认前请先查阅 [Workers for Platforms 定价](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)。
3. 打开 **R2 Object Storage（R2 对象存储）** 并完成启用。Void 会在后续创建存储桶。
4. 打开 **Analytics Engine**，如果出现提示，选择 **Enable（启用）**。无需手动创建数据集。如果页面没有 **Enable（启用）** 操作，且安装时报错代码为 10089，请按[下文步骤](#if-cloudflare-rejects-analytics-engine)处理。
5. 使用域名安装时，选择自己拥有的域名，例如 `example.app`。如果还没有域名，可向你选择的注册商注册。请使用一个空闲域名的根域：应用将通过 `my-app.example.app` 这样的地址提供服务。如果使用 workers.dev 测试，跳过本步骤及下面的 DNS 设置。

如果域名已经在这个 Cloudflare 账号中，使用已有的 DNS 区域。否则，先[将域名添加到 Cloudflare](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)，再按说明设置域名服务器，直到区域生效。区域（zone）是 Cloudflare 为域名保存的 DNS 配置；创建区域并不等于购买域名。

你也可以让 Void 在安装期间创建区域。提前设置的好处是，可以将 API 令牌的范围限定到这个区域，并在安装时省去等待 DNS 的步骤。平台 API 默认使用 `workers.dev`，因此不需要额外的域名。

### Cloudflare 拒绝 Analytics Engine 时 {#if-cloudflare-rejects-analytics-engine}

平台使用 Analytics Engine 存储请求指标和日志。如果安装因“You need to enable Analytics Engine”（需要启用 Analytics Engine，代码 10089）而停止，请打开错误中提供的 Analytics Engine 控制台链接，为该账号选择 **Enable（启用）**。Workers Free 也可以启用此功能；该错误不要求升级 Workers 套餐或更换 API 令牌。完成后，运行输出中给出的 `void platform install --resume` 命令。

如果账号的控制台没有 **Enable（启用）** 操作，请创建一个临时的 Hello World Worker，在 **Settings（设置）** > **Bindings（绑定）** 中添加 Analytics Engine 绑定，并通过控制台部署一次，再继续安装。此步骤请使用单独的 Worker，不要修改平台自身的 Worker。

## 安装 CLI 并预览 {#install-the-cli-and-preview}

使用 Node.js 24.21.0 或更高版本安装 CLI：

```sh
pnpm add --global void
void platform install --plan
```

按提示登录 Cloudflare，再选择安装名称和账号。`--plan` 只预览资源，不会更改资源，也不需要运行时密钥。预览完成后，所选配置会保存在本地。再次运行 `void platform install` 可选择已保存的计划；Void 会先检查 Cloudflare 当前状态，再询问是否应用。

使用域名安装时，请按下表填写。测试模式会跳过应用域名、区域和兜底流量的问题：

| 提示 | 填写内容 |
| --------------------------------------- | --------------------------------------------------- |
| Installation name（安装名称） | 简短名称，例如 `team` |
| Application base domain（应用基础域名） | 你的域名，例如 `example.app` |
| Cloudflare zone（Cloudflare 区域） | 与上面相同的域名 |
| Platform display name（平台显示名称） | 团队能够识别的任意名称 |
| Optional custom API hostname（可选的自定义 API 主机名） | 留空即可使用 `workers.dev` |
| Dedicate all unmatched traffic to Void?（将所有未匹配流量交给 Void？） | 仅在整个区域都属于该平台时选择 Yes（是） |

在账号内选择一个尚未使用的安装名称。例如，`team` 会创建 `void-team-api`、`void-team-proxy` 等资源。

预览会列出所需凭据。查阅[凭据](/zh/guide/platform/installation/credentials)后，运行最后输出的安装命令。安装向导会在需要时提供设置链接和登录回调地址。

也可以通过以下命令直接选择安装方式：

```sh
void platform install --application-domain example.app --plan
void platform install --workers-dev --plan
```

`--workers-dev` 不能与 `--application-domain`、`--zone` 或 `--dedicated-zone` 一起使用。

## 创建平台数据库 {#platform-database}

使用一个专供此平台使用的空 PostgreSQL 数据库，存储用户、项目和部署信息；各个应用仍可使用 D1。Void 会创建表和 Hyperdrive 连接，但不会创建 PostgreSQL 服务器。

可以使用任意允许你的电脑和 Cloudflare 连接的 PostgreSQL 提供商：

1. 新建一个专供平台使用的数据库或项目，其中不能有现有应用的表。所用数据库角色需要有权创建和管理表及 schema。
2. 打开提供商的连接详情，选择主数据库。使用直连或会话模式的连接池，不要使用事务模式连接池。你的电脑和 Cloudflare 都必须能够通过这个连接访问数据库。
3. 将包含密码和 SSL 设置的 PostgreSQL 连接 URL 保存到密码管理器中。按提供商给出的原样，将 URL 粘贴到 Void 的 `PostgreSQL DATABASE_URL` 提示中，保留 `sslmode=verify-full` 等 SSL 设置；只粘贴 URL，不要包含外层的 `psql` 命令。Void 创建的 Hyperdrive 仅信任公共证书颁发机构。如果数据库使用私有证书颁发机构，请按下文说明使用单独管理的 Hyperdrive。

| 提供商 | 连接设置 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PlanetScale Postgres](https://planetscale.com/docs/postgres/connecting) | 选择 **Postgres**，不要选择 Vitess/MySQL。打开 **Connect（连接）**，创建角色凭据，使用端口 `5432` 的主数据库直连地址，不要使用端口 `6432` 的 PgBouncer。 |
| [Neon](https://neon.com/docs/get-started-with-neon/connect-neon) | 打开 **Connect（连接）**，选择数据库和所有者角色，并**关闭 connection pooling（连接池）**。 |

确定数据库容量时，要计入共享该服务器的每个平台实例和应用各自使用的连接池。根据服务器容量调整各个 Hyperdrive 的[源站连接数上限](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/)，并为迁移、管理操作、提供商保留的连接和临时突发流量留出余量。

安装过程将数据库归属于此平台实例后，继续安装和执行维护命令时都应使用同一个数据库。如果安装因无法使用该数据库而停止，例如数据库不为空，请在继续安装前，将 `VOID_PLATFORM_DATABASE_URL` 设置为另一个数据库的 URL。卸载不会删除外部 PostgreSQL 数据库。

### 使用提供商 CLI {#use-a-provider-cli}

除了控制台，也可以通过上述任一提供商的 CLI 创建数据库并取得连接 URL。

::: details PlanetScale Postgres

安装最新版 [PlanetScale CLI](https://planetscale.com/docs/cli/planetscale-environment-setup)。macOS 可以使用 `brew install pscale`；安装指南也包含 Linux 和 Windows 的说明。

登录并列出组织和区域：

```sh
pscale auth login
pscale org list
pscale region list --org <organization>
```

将 `<organization>` 替换为组织 slug，再选择区域。列出该区域可用的 Postgres 集群规格和价格：

```sh
pscale size cluster list --org <organization> --engine postgresql --region <region>
```

按选定的集群规格创建专用 Postgres 数据库，再创建有权为 Void 创建表和执行迁移的角色：

```sh
pscale database create void-platform \
  --org <organization> \
  --engine postgresql \
  --region <region> \
  --cluster-size <cluster-size> \
  --wait

pscale role create void-platform main void_owner \
  --org <organization> \
  --inherited-roles postgres
```

将创建角色的命令输出的 **DATABASE URL（数据库 URL）** 保存到密码管理器，再粘贴到 Void 的 `PostgreSQL DATABASE_URL` 提示中。使用端口 `5432` 的主数据库直连地址，并保留 `sslmode=verify-full`。角色密码会在创建时显示，请在关闭终端前保存。

更多选项请参阅 PlanetScale 的[数据库命令](https://planetscale.com/docs/cli/database)和[角色命令](https://planetscale.com/docs/cli/role)。

:::

::: details Neon

安装最新版 [Neon CLI](https://neon.com/docs/cli/install) 并登录：

```sh
pnpm add --global neon@latest
neon login
```

创建专用项目、数据库和所有者角色。将 `<region-id>` 替换为 Neon [支持的区域](https://neon.com/docs/cli/projects#create)之一，例如 `aws-us-east-2`：

```sh
neon projects create --name void-platform \
  --database void_platform \
  --role void_owner \
  --region-id <region-id>
```

使用输出中的项目 ID，取得启用了 TLS 证书验证的主数据库直连 URL：

```sh
neon connection-string --project-id <project-id> \
  --database-name void_platform \
  --role-name void_owner \
  --endpoint-type read_write \
  --ssl verify-full
```

将输出的 URL 保存到密码管理器，再粘贴到 Void 的 `PostgreSQL DATABASE_URL` 提示中。此连接应保持不使用连接池。更多选项请参阅 Neon 的[连接字符串命令](https://neon.com/docs/cli/connection-string)。

:::

### 使用现有 Hyperdrive {#use-an-existing-hyperdrive}

安装程序可以为你创建 Hyperdrive，也可以使用你单独管理的 Hyperdrive。使用现有配置时：

1. 使用运行时用户将其连接到平台专用数据库，并关闭 SQL 结果缓存。
2. 在安装程序中选择它，并核对数据库、主机、端口和运行时用户。
3. 在 PostgreSQL URL 提示中提供数据库所有者的连接，以便 Void 执行迁移。

如果需要先创建一个，选择 **Set up a separately managed Hyperdrive（设置单独管理的 Hyperdrive）**，按照输出中的说明或 [Cloudflare 设置指南](https://developers.cloudflare.com/hyperdrive/get-started/)操作。准备好后重新运行安装程序。Void 会让你继续自行管理其配置。无人值守安装时，请使用[从 CI 安装](/zh/guide/platform/installation/ci)中列出的 Hyperdrive 变量。
