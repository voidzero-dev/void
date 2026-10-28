---
outline: deep
---

# 运行时与源码构建 {#runtime-and-source-builds}

## 部署自己的运行时 {#deploying-your-runtime}

先构建运行时。如果使用 Git 检出副本，构建会自动将当前提交记录到运行时清单中。如果检出副本有未提交的更改，记录的版本会带有 `-dirty` 后缀：

```sh
vp run build:core
```

如果构建系统需要使用另一个不可变版本标识来覆盖自动检测结果，可以设置 `VOID_PLATFORM_SOURCE_REVISION`。不包含 Git 元数据的源码归档仍可正常构建，但不会记录版本标识。

运行时产物位于 `packages/platform/dist/runtime`。使用构建出的 CLI，可以基于这些文件预览一次新安装：

```sh
void-dev platform install \
  --name my-team \
  --application-domain example.app \
  --zone example.app \
  --runtime packages/platform/dist/runtime \
  --plan
```

执行计划前，请先完成[安装指南](/zh/guide/self-hosted-platform)中的准备。去掉 `--plan` 后运行命令即可安装。如果域名尚未准备好，想先进行测试，可以用 `--workers-dev` 替换 `--application-domain` 和 `--zone`；仍然需要 PostgreSQL，以及运行时、登录提供方和 R2 凭据。请用 `void-dev` 代替 `void`，并在安装和恢复安装的命令中保留 `--runtime packages/platform/dist/runtime`。如果安装中断，请保留该运行时构建产物，直到安装完成。

之后可以运行 `void-dev platform domain set example.app`。域名配置会使用已安装的运行时，无需 `--runtime`、重新构建或重新部署应用。平台 API URL 和原有的 workers.dev 应用 URL 仍会保留并继续可用。

对于已安装的平台，可以使用其连接 ID 预览升级：

```sh
void-dev platform upgrade <installation-id> \
  --runtime packages/platform/dist/runtime --plan
```

然后去掉 `--plan`，再次运行以执行升级。源码构建的运行时与已发布运行时会经过相同的产物、数据库、所有权和健康检查。CLI 会保留已禁用平台的状态，并在安装检查点中记录源码版本。

## 为受 Access 保护的 API 配置可选 GitHub Webhook 入口 {#optional-github-webhook-ingress-for-access-protected-apis}

核心安装程序不会部署控制台、GitHub App、构建容器或 Webhook 入口。通过 `--runtime` 提供源码构建产物，也不会创建这些服务的基础设施、绑定、凭据或平台能力。仓库中的托管部署脚本面向 Void Cloud，并非为自托管平台添加这些服务的通用配置流程。除非你的 fork 自行提供并维护这项可选集成，否则请使用核心 CLI 部署流程。

如果你的 fork 已添加托管 GitHub 构建，且 API 主机名受到 Cloudflare Access 保护，GitHub 就无法直接向 `/webhooks/github` 投递，因为 GitHub 不会提供你的 Access 凭据。不要为 API 应用添加 Everyone（所有人）或绕过策略。

请将可选 Webhook 入口部署在独立的公开主机名上。它会在 `POST /github` 接收经过签名的 GitHub 投递，并通过服务绑定转发到 API。如果没有 Access 防护，直接使用 API 的 `/webhooks/github` 端点即可。

部署可选入口的步骤：

1. 在 fork 中准备 GitHub App、构建执行器、API 绑定、凭据和托管构建能力，然后通过内部操作部署源码 API 运行时。仅执行核心安装或升级，不会添加托管构建。
2. 编辑 `platform/packages/api/wrangler.github-webhook-ingress.jsonc`。为入口设置该平台实例专属的名称，并将其 `API` 服务绑定准确指向已安装的 API Worker 名称。入口的公开主机名必须与 Access 保护的所有用户访问和 API 主机名分开。
3. 从仓库根目录部署：

   ```sh
   vp run --filter @voidcloud/api deploy:github-webhook-ingress --env production
   ```

   使用 `--env staging` 可以选择同一配置中的预发布环境条目。

4. 在 Cloudflare 控制台中添加加密的 Worker 密钥。将 GitHub App 已有的 `GITHUB_WEBHOOK_SECRET` 同时设置到 API 和入口 Worker 上。单独生成一个高熵值，例如使用 `openssl rand -base64 32`，并在两个 Worker 上将其设为 `GITHUB_WEBHOOK_INGRESS_SECRET`。不要复用平台管理、JWT、Access 或 GitHub Webhook 凭据。
5. 在 GitHub App 设置中，将 **Content type（内容类型）** 保持为 `application/json`，保留相同的 Webhook 密钥，并将 **Webhook URL** 改为以 `/github` 结尾的独立入口 URL。先使用 GitHub 测试投递并确认收到 2xx 响应，再依赖推送触发构建。

入口最多接收 25 MiB 的载荷。见 [GitHub 载荷限制](https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap)。

## 从 CI 部署源码构建产物 {#deploying-source-builds-from-ci}

从检出副本构建 `@void/platform`，并通过 `--runtime` 将运行时目录传给 `install`、`upgrade`、`repair`、`enable` 或 `rollback`。自定义运行时与打包发布的版本会经过相同的完整性、迁移、健康和回滚检查。

使用没有未提交更改的 Git 检出副本，或设置 `VOID_PLATFORM_SOURCE_REVISION`，以标明部署的版本。

全新的 CI 运行器可以在每次运行时发现已安装的平台。通过受保护的环境设置 `CLOUDFLARE_API_TOKEN` 和 `VOID_PLATFORM_DATABASE_URL`，然后执行：

::: details CI 命令与恢复所需信息

```sh
vp run build:core

export VOID_PLATFORM_REGISTRY_DIR="$RUNNER_TEMP/void-platform-registry"
export VOID_PLATFORM_RECOVERY_KEY="$(openssl rand -base64 32)"
node packages/void/dist/cli/cli.mjs platform discover --account "$CLOUDFLARE_ACCOUNT_ID" \
  --installation "$VOID_PLATFORM_INSTALLATION"
node packages/void/dist/cli/cli.mjs platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --plan
node packages/void/dist/cli/cli.mjs platform upgrade "$VOID_PLATFORM_INSTALLATION" \
  --runtime packages/platform/dist/runtime --yes
```

只有账号中恰好有一个可发现的平台安装时，才能省略安装选择参数。同一平台安装每次只能执行一个部署，必须等它完成后再开始下一个。在迁移或 Worker 发布期间取消操作，可能使平台进入等待恢复的状态。

将管理令牌、数据库 URL、JWT 签名密钥、已启用邮件功能的平台所需的邮件签名密钥，以及完整的项目加密密钥环，保存在受保护的 CI 环境中。升级会继承已部署 Worker 的密钥。重新创建缺失的 Worker 时需要原始值；显式轮换配置凭据时，也需要提供相应凭据。

:::
