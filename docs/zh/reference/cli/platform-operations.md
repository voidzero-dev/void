---
outline: deep
---

# 平台运维 {#operator-deployments}

这些命令需要管理员会话。平台选择、预览和确认方式，见[平台管理](/zh/reference/cli/platform#operator-commands)。

查找部署、检查清单，或请求取消部署：

```sh
void platform deployment list [--project <id-or-slug>] [--status <status>] [--search <text>] [--page <n>] [--limit <n>]
void platform deployment show <id>
void platform deployment cancel <id>
void platform deployment migrate-assets <id> [--cursor <cursor>] [--plan|--yes]
```

部署处于等待、上传、迁移或预渲染阶段时可以取消；正在取消时，也可以再次提出请求。部署已经开始切换流量、正在进行失败后的补偿操作，或已经结束时，不能通过此命令取消。

`migrate-assets` 会将部署的旧版资源复制到限定作用范围的 R2 存储，不改变应用流量。通过 `--plan` 预览，通过 `--cursor` 从已成功处理的批次继续。原资源会保留。

读取运行时日志：

```sh
void platform deployment logs <id> [--since <time>] [--cursor <cursor>] [--limit <n>] [--follow]
```

默认读取最近一小时的日志，按时间从早到晚排列，最多返回 100 条。`--since` 接受 `10m`、`2h` 或 `1d` 这样的时长、ISO 日期，或 Unix 纪元毫秒时间戳。`--limit` 可设为 1 到 500，将响应的 `nextCursor` 作为 `--cursor` 传入，即可读取下一页。

`--follow` 会读取剩余分页，并每两秒检查一次新日志，直到按 Ctrl+C 退出。它会重查五分钟的重叠时间段，以捕获延迟到达的记录，并去除重复行。更晚到达的记录可能需要之后查询历史日志。某个时间窗口超过 10,000 条记录时，跟踪会报错并停止；此时请缩小时间范围查询历史日志。

## 构建 {#operator-builds}

检查构建或读取输出：

```sh
void platform build show <id>
void platform build logs <id> [--since <sequence>] [--limit <n>] [--follow]
```

构建日志从序号 `0` 开始，最多返回 500 行。将返回的 `lastSeq` 作为 `--since` 传入即可继续；`--limit` 接受 1 到 500。读取容器日志需要启用托管构建。GitHub Actions 构建会返回外部日志 URL。

构建进入终态后，跟踪模式还会等待最后的日志。如果两分钟内无法确认日志已全部输出，命令会报错退出。

## 系统 {#operator-system}

查看活动、检查服务健康状况，或审查管理变更：

```sh
void platform system overview
void platform system health
void platform system cli-versions
void platform system asset-migrations [--page <n>] [--limit <n>]
void platform system events [--page <n>] [--limit <n>]
void platform system backfill-queue-tokens
void platform system sandbox-drain [--cursor <opaque-cursor>]
void platform system rotate-proxy-tokens [--project <id> | --all]
```

`overview` 显示平台汇总信息和近期活动。`health` 检查已配置的服务和数据库，任一检查失败时都会以非零状态退出。`cli-versions` 报告各部署使用的 CLI 版本。

`asset-migrations` 清点已存储的部署资源，并报告 `needsMigration` 和 `invalid` 的数量。通过响应中的分页字段可以读取全部条目。

`events` 显示变更的管理员、目标和结果。待处理事件表示结果尚未记录。预览、会话登录和退出不会创建这些事件。`backfill-queue-tokens` 修复缺少认证令牌的旧队列条目，执行修复前可通过 `--plan` 预览。

`sandbox-drain` 移除由租户拥有的旧版沙箱资源。使用 `--plan` 预览，使用 `--yes` 执行，再将 `nextCursor` 作为 `--cursor` 传入以继续。清理期间，应用流量会一直暂停。

`rotate-proxy-tokens` 为项目当前在线的 Worker 和保留用于回滚的 Worker 分配新的平台凭据，无需重新部署应用。对于保留用于回滚、但其部署者已不再有权部署的 Worker，会保留旧凭据。使用 `--project <id>` 选择单个项目，或用 `--all` 选择所有项目，通过 `--plan` 预览、`--yes` 执行。单独使用 `--plan` 会显示所有尚在进行的轮换。每次运行只处理有限批次，其余工作由平台在后台完成。每个项目的轮换约需 6 分钟；部署进行中时可能更久。请通过 `--plan` 检查进度，直到没有待处理或失败的项目。轮换尚未完成时，再次带 `--project` 或 `--all` 运行 `--yes`，会为对应项目再启动一次轮换。轮换完成后，旧凭据会失效。每次轮换都会启动项目在线 Worker 的新版本，因此 WebSocket 连接会重新连接一次。

维护平台实例自身的 Worker，请使用[平台生命周期命令](/zh/reference/cli/platform-installation#lifecycle-commands)。

## 托管平台 Worker {#operator-workers}

以下命令管理托管 Void Cloud 平台的 Worker，不适用于自托管平台。自托管平台请使用[生命周期命令](/zh/reference/cli/platform-installation#lifecycle-commands)。

```sh
void platform worker list [--environment <production|staging>]
void platform worker show <worker-name> [--environment <production|staging>]
void platform worker rollback <worker-name> <version-id> [--environment <production|staging>]
void platform worker rollback-all [--environment <production|staging>]
void platform worker events [batch-id] [--environment <production|staging>]
```

使用 `worker list` 列出的名称，例如 `api` 或 `proxy`。`show` 会列出版本和当前部署。两种回滚都应先通过 `--plan` 预览，再交互式执行，或在脚本中通过 `--yes` 执行。`events` 可列出 Worker 操作事件，也可按 ID 查看某个批次。
