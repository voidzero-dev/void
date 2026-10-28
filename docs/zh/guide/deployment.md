---
outline: deep
---

# 部署 {#deployment}

`void deploy` 会构建应用、创建资源、执行迁移并完成部署。你可以选择自己的 Cloudflare 账号，或团队运营的 Void 平台。

部署成功后，Void 会在摘要框中显示部署 URL，以及部署目标返回的详细信息。

## 部署到 Cloudflare {#deploy-to-cloudflare}

在运行 `void init` 时选择 Cloudflare，也可以之后再连接：

```sh
void connect --platform cloudflare
void deploy --platform cloudflare
```

Void 会打开浏览器供你登录，并询问使用哪个账号。后续部署会使用已保存的目标，直接运行 `void deploy` 即可。

原生应用可以在 Workers Free 的配额范围内运行。[沙箱](/zh/guide/sandboxes#requirements)需要 Workers Paid 和 Containers 访问权限。配置、令牌权限，以及有额外要求的功能，见 [Cloudflare 指南](/integrations/cloudflare)。

如果你已有 Worker，且项目根目录中有 `wrangler.jsonc` 或 `wrangler.json`，`void deploy` 可以关联该 Worker 并保留它的资源，见[部署现有 Worker](/integrations/cloudflare#deploy-an-existing-worker)。

## 准备应用 {#prepare-your-app}

### 迁移 {#migrations}

部署时会执行 `db/migrations/` 中尚未应用的 SQL 迁移。如果 schema 已变更却没有对应迁移，部署会停止：

```sh
void db generate
```

审阅并提交 SQL 后，再次部署。回滚不会撤销数据库迁移。本地工作流程见[数据库](/zh/guide/database)。

部署到自己的 Cloudflare 账号时，Void 会在执行待应用的迁移之前，保存一个 D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 恢复点，并打印对应的 [`void db restore`](/zh/reference/cli/database#void-db-restore) 命令。如果无法保存恢复点，部署会在迁移前停止。如果迁移已执行，而后续步骤失败，例如上传失败，Void 会再次打印恢复命令。

通常只需修复错误并重新部署；只有线上版本无法兼容新 schema 时，才需要恢复数据库。如果要从错误的迁移中恢复，且新版本已上线，先用 `void project rollback` 回滚代码，再恢复数据库，随后修复或移除该迁移，再次部署。如果此前只是临时运行了 `void deploy --platform cloudflare`，以上每个命令都需要加上 `--platform cloudflare`。

恢复会丢弃恢复点之后的所有写入。恢复点在 Workers Free 上保留 7 天，在 Workers Paid 上保留 30 天；过期后，需要编写新的迁移来撤销原迁移。

### 环境变量 {#environment-variables}

在 `env.ts` 中声明变量，通过 `void secret put` 设置生产环境的服务端密钥。部署不会上传本地 `.env`。公开的 `VITE_*` 值应通过构建环境提供，见[环境变量](/zh/guide/env-vars)。

CLI 与框架适配器应使用匹配的版本。生成 `void.config.ts` 和 `void.lock.json` 后，将它们提交到仓库。

## 从 GitHub 部署 {#github}

根据已保存的目标和所用包管理器生成工作流：

```sh
void init --github
```

对于 Cloudflare，将 `CLOUDFLARE_API_TOKEN` 添加到仓库密钥。该令牌需要能访问应用使用的账号和产品。使用 PostgreSQL 或 MySQL 的应用还需要 `DATABASE_URL`。

Worker 预览 URL 和 Cloudflare Access 凭据的配置方法见 [Cloudflare CI 设置](/integrations/cloudflare#deploying-from-ci)。

### 团队平台 CI {#team-platform-ci}

对于核心自托管平台，使用自己的工作流和[项目部署令牌](/zh/guide/platform/installation/first-deployment)。设置 `VOID_TOKEN`、`VOID_API_URL` 和项目 slug，然后在每个全新的 CI 环境中连接平台：

```sh
void connect "$VOID_API_URL" --no-login
void deploy --platform void --project "$VOID_PROJECT"
```

启用了可选 GitHub Actions 集成的平台使用短期 OIDC 凭据。运行 `void github connect <project> --repo <owner/repo> --executor github_actions` 授权仓库，设置仓库的 `VOID_API_URL`，并在生成的工作流中保留 `permissions: id-token: write`。

如果平台支持托管 GitHub 构建，GitHub App 可以在推送后自动部署，无需工作流文件。安装 App 并连接仓库的方法见 [GitHub 命令](/zh/reference/cli/github#github)。

如果 CI 在部署前执行类型检查，请在安装依赖后运行 `void prepare`，生成 `.void/` 中的类型。

## 部署到团队平台 {#deploy-to-a-team-platform}

使用管理员提供的 API URL。在新应用或尚未关联的应用中运行：

```sh
void connect platform.example.com
void deploy --platform void --project my-app
```

按提示登录并确认创建项目。如果要使用现有项目，运行 `void project link`。后续部署会使用已保存的目标。

项目所有者可以[共享访问权限](/zh/guide/project-collaboration)。为团队安装平台可从[安装 Void 平台](/zh/guide/self-hosted-platform)开始，该指南也比较了两种目标的部署功能。

### 部署到另一个 Void 平台 {#deploy-to-another-void-platform}

如果只想将本次部署发送到其他平台，先连接该平台，再指定项目：

```sh
void connect second.example.com
VOID_API_URL=https://second.example.com void deploy --platform void --project my-app
```

这样会保留原先保存的部署目标。每个平台都有独立的项目、密钥和数据。目标选择及其他选项见 [CLI 参考](/zh/reference/cli/deploy)。

## 日志与回滚 {#logs-and-rollback}

查看部署状态、读取运行时日志，或选择一个历史部署：

```sh
void project status
void project logs
void project rollback
```

Cloudflare 日志以实时流的形式提供；团队平台会保留日志历史。回滚前，检查旧代码是否兼容当前数据库 schema，见[项目命令](/zh/reference/cli/project)。

## 其他运行时 {#other-runtimes}

通过 `target` 设置，可以为 [Node.js、Bun 或 Deno](/integrations/nodejs-bun-deno) 构建独立服务器。将 `dist/ssr` 和 `dist/client` 一起部署到你选择的托管环境。这些目标无法使用 D1、KV、R2 和 Workers AI 等 Cloudflare 绑定。

## 用量与执行限制页面 {#usage-and-execution-limit-pages}

在团队平台上，如果应用超出请求数或 CPU 配额，API 和 Pages action 请求会收到结构化的 HTTP 429 响应；浏览器请求会显示错误页面。

要自定义页面，为请求限制添加 `public/usage-limit.html`，为执行限制添加 `public/execution-limit.html`。页面应为独立 HTML，使用内联 CSS 和 data URL 图片。脚本、外部资源和表单提交均被禁用。未提供自定义页面时会使用内置页面。

这些响应不会被缓存。已经开始的流式响应无法替换成错误页面，请在 UI 中处理流中断。
