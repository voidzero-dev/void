---
outline: deep
---

# 部署 {#deploy}

## `void deploy` {#void-deploy}

```
void deploy [--project <name>] [--dir <path>] [--spa] [--skip-build] [--debug]
void deploy [--platform <cloudflare|void>] [--require-email]
void deploy --platform cloudflare --atomic
void deploy --platform cloudflare --provision
```

自动检测项目类型，并选择相应的部署流程。详见[支持的应用类型](/zh/guide/app-types)和[部署](/zh/guide/deployment)。

部署到 Void 平台前，必须通过 `void connect <url>` 显式建立连接。仅有已保存的项目 URL 或 `VOID_API_URL` 不会建立连接。在全新的 CI 环境中，请先运行 `void connect "$VOID_API_URL" --no-login`。

在 Void 平台上，部署被接受后，即使 CLI 断开连接也会继续执行。CLI 会自动重新连接以跟踪进度。按 Ctrl+C 只会停止观察；如需请求取消，请使用 `void project cancel`，并通过 `void project status` 检查结果。如果执行中断后需要恢复，请等待其处理结果，再次部署。

CLI 会报告进度停滞和自动恢复的情况，并在部署被接受后最多等待 30 分钟。等待超时后，部署仍可能继续；再次部署前，请先检查 `void project status`。

对于已有的 Void Worker，`void deploy` 可以关联该 Worker 并迁移其根目录的 Cloudflare 配置。首次部署应专注于现有应用。相关要求和 ISR 缓存选择，参见[部署已有的 Worker](/zh/integrations/cloudflare#deploy-an-existing-worker)。

对于 Drizzle 项目，部署时会以只读方式检查 schema 是否发生漂移。如果检查发现需要生成新迁移，部署会停止，并提示你运行 `void db generate`、审查迁移、自行提交，然后重新运行 `void deploy`。

| 选项                            | 用途                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--platform <cloudflare\|void>` | 覆盖 `.void/project.json` 中保存的平台                                                                                                                              |
| `--project <name>`              | 通过 slug 指定目标 Void 项目；不支持与 `--platform cloudflare` 一起使用                                                                                              |
| `--dir <path>`                  | 部署已构建的静态目录（跳过构建）                                                                                                                                     |
| `--spa`                         | 静态部署时使用 SPA 模式，而非 SSG                                                                                                                                     |
| `--skip-build`                  | 跳过构建步骤；在 Cloudflare 上仅支持静态、SPA 和 SSG 部署                                                                                                             |
| `--require-email`               | 无法配置邮件时使部署失败，而不是不带邮件功能继续部署；需要 `--platform cloudflare`                                                                                   |
| `--provision`                   | 即使所有资源都已存在，也重新执行资源配置，例如为已有数据库启用 D1 读副本；需要 `--platform cloudflare`                                                               |
| `--atomic`                      | 直接发布已有的 Durable Object Worker；流量切换后才检查是否就绪                                                                                                       |
| `--debug`                       | 将结构化部署日志同步输出到 stderr（日志也会写入 `~/.void/logs/`）                                                                                                    |

`--atomic` 仅作用于一次部署。如果已有的 Durable Object Worker 始终无法进行分阶段部署，可在 `void.config.ts` 中设置 `deploy: { cloudflare: { mode: 'atomic' } }`，使不带额外选项的 `void deploy` 使用原子发布。默认模式为 `staged`。

每次部署都会将 JSONL 日志写入 `~/.void/logs/`。失败时会打印日志路径和相关详情。使用 `--debug` 或 `VOID_DEPLOY_DEBUG=1`，可将日志同步输出到 stderr。

不要将凭据放入构建命令，应将它们注册为 CI 密钥，以便 CI 提供商在日志中遮蔽其值。

平台解析的优先级：

1. `--platform <cloudflare|void>`
2. `.void/project.json` 中的 `platform`
3. 对于通过旧版 SDK 初始化、且未保存平台的项目，使用 Void

选择 Skip deployment setup（跳过部署配置）会保存 `"platform": "none"`；之后运行 `void deploy` 会停止并给出提示，直到提供平台覆盖选项。

对于 Void 平台，项目解析的优先级为：

1. `--project <name>`
2. `VOID_PROJECT`
3. `.void/project.json` 中关联的项目

如果未关联项目，也未提供覆盖值，CLI 会提示关联或创建项目。在 CI（非 TTY）中，`void deploy` 会直接报错；请设置 `VOID_PROJECT` 或传入 `--project <slug>`。

要仅在一次调用中部署到另一个已连接的 Void 平台：

```sh
void connect second.example.com
VOID_API_URL=https://second.example.com void deploy --platform void --project my-app
```

`VOID_API_URL` 选择平台，`--project` 选择该平台中的项目。覆盖另一个平台已保存的项目关联时，必须指定项目名称。即使创建了目标项目，现有项目关联和部署偏好也保持不变。使用 `VOID_PROJECT`，或选择当前平台中的另一个项目时，也遵循相同规则。如果尚未配置任何目标，首次部署仍会关联项目。参见[部署到另一个 Void 平台](/zh/guide/deployment#deploy-to-another-void-platform)。

## `void deploy --platform cloudflare` {#void-deploy-platform-cloudflare}

使用 `void.config.ts` 构建并部署到自己的 Cloudflare 账号：

```sh
void deploy --platform cloudflare
void deploy --platform cloudflare --require-email   # fail instead of deploying without email
```

Void 会在需要时通过浏览器引导登录，并保存选中的账号。在 CI 中，请设置 `CLOUDFLARE_API_TOKEN`；如果令牌可以访问多个账号，还需设置 `CLOUDFLARE_ACCOUNT_ID`。

| 选项或设置                     | Cloudflare 上的行为                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `--dir`, `--spa`               | 通过一个小型 Worker 和 Workers Assets 部署静态输出                                      |
| `--skip-build`                 | 复用已有的静态、SPA 或 SSG 输出；不适用于 Worker 应用                                   |
| `--project`                    | 不可用；Worker 和账号由 `void.config.ts` 和 `void.lock.json` 确定                       |
| 命名环境                      | 不可用；请使用顶层 `cloudflare` 配置                                                    |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | 在全新 CI 环境中，如果版本没有预览 URL，则需要此值；部署后会缓存在本地                  |
| `--require-email`              | 邮件配置步骤无法运行时（例如在 CI 中）使部署失败，而不是不带邮件功能继续部署              |
| `DATABASE_URL`                 | 为 PostgreSQL 或 MySQL 配置资源和执行迁移时，部署环境中必须提供此值                      |

令牌需要 Workers Scripts: Edit 权限、所绑定资源的读取权限，以及 Void 要配置的产品的编辑权限。首次部署后，请先提交 `void.lock.json`，再在其他机器或 CI 中使用。

使用 `void secret put <NAME>` 设置生产环境的服务器端值。本地 `.env` 值绝不会部署。部署前，请运行 `void db generate` 并提交 schema 变更。

沙箱需要 [Workers Paid](https://dash.cloudflare.com/?to=/:account/workers/plans)、Docker 和 Containers 访问权限。API 令牌需要 Account / Containers: Edit 和 Account / Cloudchamber: Edit 权限。

对于邮件功能，请设置 `email.from`，并在本地运行 `void email setup --platform cloudflare`。提交锁文件，并在 CI 中传入 `--require-email`。参见[邮件设置](/zh/guide/email/domains#your-own-cloudflare-account)。

Access 凭据、Hyperdrive 权限、就绪检查和回滚的说明，参见[Cloudflare 部署](/zh/integrations/cloudflare#deploy-to-your-own-cloudflare-account)。
