---
outline: deep
---

# 项目 {#project-commands}

## `void project status [name]` {#void-project-status-name}

显示已配置目标的部署情况。

- Void 目标会显示近期的托管部署；提供 `[name]` 时按 slug 查找项目，否则使用已关联的项目。
- Cloudflare 目标会列出 Worker Versions、标明当前生效的版本，并显示已记录的迁移数量。不接受项目名称，因为 Worker 名称由 `void.config.ts` 中的 `cloudflare.name` 确定。
- 如果平台无法完成[项目凭据更换](/zh/guide/project-collaboration#change-or-remove-access)，所有者和管理员还会看到警告。

## `void project link [name]` {#void-project-link-name}

通过 slug 将当前目录关联到已有的托管 Void 项目，省略名称时可交互式选择。状态保存在 `.void/project.json` 中。直接部署到 Cloudflare 的应用使用 `void.config.ts` 中的 `cloudflare.name`，无需关联项目。

## `void project list` {#void-project-list}

列出所有可访问的托管项目（slug、角色、类型和 URL），其中也包括共享项目；角色列可用于区分共享项目与自己拥有的项目。如果保存的目标是 Cloudflare，则会改为显示当前 Worker 的版本，因为 Cloudflare 没有 Void 项目注册表。

## `void project team` {#void-project-team}

管理 Void 平台上托管项目的访问权限：

```sh
void project team list [--project <slug>]
void project team invite <email> --role <reader|collaborator|admin> [--project <slug>]
void project team invitations [--project <slug>]
void project team role <user-id> <reader|collaborator|admin> [--project <slug>]
void project team remove <user-id> [--project <slug>]
void project team revoke <invitation-id> [--project <slug>]
void project team leave [--project <slug>]
void project team pending
void project team accept <invitation-id>
void project team decline <invitation-id>
```

项目级命令依次使用 `--project`、`VOID_PROJECT` 和已关联的项目。只能邀请已在该平台上注册账号的邮箱；邀请不会创建账号，也不会授予注册资格。只有受邀账号可以接受或拒绝自己的邀请。`list` 会显示与 `void project status` 相同的凭据警告。

只读成员可以查看项目，但不能部署。协作者可以部署并管理部署前置条件。项目管理员还可以管理域名、邮件收件地址、GitHub 配置和项目团队。只有所有者可以删除项目。完整的角色权限边界参见[项目协作](/zh/guide/project-collaboration)。

项目级团队管理命令不适用于直接部署到 Cloudflare 的项目。账号级的 `pending`、`accept` 和 `decline` 命令使用 `void connect <url>` 选中的当前连接，不受当前项目关联或部署目标影响。`VOID_API_URL` 优先；未限定平台的 `VOID_TOKEN` 会选择 Void Cloud。这些命令会显示所使用的平台，接受邀请也不会改变目录关联。要关联受邀应用，请在该应用尚未关联项目的本地检出目录中运行 `void project link`。

## `void project zero-trust` {#void-project-zero-trust}

检查或覆盖 Void 平台上项目的保护设置：

```sh
void project zero-trust status [--project <slug>]
void project zero-trust protect [--project <slug>]
void project zero-trust public [--project <slug>]
void project zero-trust reconcile [--project <slug>]
```

项目选择依次使用 `--project`、`VOID_PROJECT` 和已关联的项目。

只读成员可以查看状态。所有者或项目管理员可以保护项目、将其设为公开，或修复配置漂移。`public` 不会更改平台对未来新项目的默认设置。部署和回滚会等待保护设置变更完成；如果部署或回滚因此被拒绝，所有者或项目管理员可先运行 `void project zero-trust reconcile`，然后再重试。这些命令不适用于直接部署到 Cloudflare 的项目。

## `void project token <create|list|renew|revoke>` {#void-project-token-create-list-renew-revoke}

管理针对单个 Void 平台项目、可撤销的 `aud: deploy` 凭据。此凭据只能调用 `void deploy` 使用的端点，无法访问运维管理、账号管理、密钥写入、项目删除或其他项目的路由。

```sh
void project token create --name github-actions --expires-in 30
void project token list
void project token renew <credential-id> --expires-in 30
void project token revoke <credential-id>
```

在已关联项目的目录之外使用时，请传入 `--project <name>`。有效期限定为 1–90 天。创建和续期时只会显示一次 Bearer 凭据值；续期后请立即替换已保存的密钥，因为旧凭据会在同一次操作中撤销。项目被删除或所有者账号被暂停时，该凭据也将无法使用。禁用登录方式不会撤销这些独立的部署凭据。

将打印出的 `VOID_TOKEN` 和 `VOID_API_URL` 保存在 CI 密钥管理器中。Access 凭据对用于通过外围访问保护，而限定范围的 Void 凭据仅授权此项目的部署工作流。在受 Access 保护的平台上使用预渲染或远程代理绑定时，请将 `VOID_ACCESS_CREDENTIALS` 保存为以源（origin）为键的 JSON 密钥，并包含两个精确的 HTTPS 源，即使两者使用同一组服务令牌凭据：

```json
{
  "https://void-company-api.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  },
  "https://void-company-proxy.example.workers.dev": {
    "CF_ACCESS_CLIENT_ID": "<service-token client ID>",
    "CF_ACCESS_CLIENT_SECRET": "<service-token client secret>"
  }
}
```

`VOID_ACCESS_ORIGIN` 会将一组凭据限定到单个源，因此，如果工作流需要调用代理，仅选择 API 源是不够的。如果 Access 策略要求两者使用不同的凭据，请在这两个条目中分别配置。

## `void project logs` {#void-project-logs}

```
void project logs [--level <level>] [--filter <text>] [--range <duration>] [--deployment <id>]
```

显示已部署目标的运行时日志。托管 Void 目标会查询已保留的日志历史；Cloudflare 目标则会对 `void.config.ts` 中指定的 Worker 开启实时日志跟踪，不提供历史日志存储。

| 选项                 | 用途                                                                                                                                                                                                            | 默认值 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--range <duration>` | 向前查询的时间范围。格式为 `<number><unit>`（m/h/d），最长 7d。                                                                                                                                                  | `1h`    |
| `--level <level>`    | 按日志级别筛选，可选 `error`、`warn`、`info`、`log`、`debug`、`all`。`error` 还包含未捕获的异常、非 `ok` 结果和所有 5xx 响应，即使 Worker 既未抛错也未输出日志。                                                | `all`   |
| `--filter <text>`    | 对日志消息文本以及异常名称和消息进行不区分大小写的**子串**匹配，不是按级别筛选。任一内容匹配时，会显示完整的请求条目。                                                                                           | 无      |
| `--deployment <id>`  | 只显示指定部署 ID 的日志。                                                                                                                                                                                      | 无      |

输出中每个请求占一行（`HH:MM:SS METHOD URL STATUS`），其下方缩进显示控制台日志和异常。错误和异常以红色显示，警告以黄色显示。

示例：

```
void project logs --level error --range 12h
void project logs --level error --filter websocket
```

日志包含 Cloudflare Tail 捕获的顶层 `console.*` 调用和未捕获错误。如果捕获错误后只将其保存到数据库，它就不会出现在这里。请同时使用 `console.error()` 或 `void/log` 中的 `logger.error()` 记录。对于托管 Void 目标，请将 `Error` 对象本身传给 `console.error()`，例如 `console.error('Save failed:', error)`，这样才能在日志行下方看到堆栈跟踪。只记录 `error.message` 不会显示堆栈。

对于未到达 Worker 的错误，例如边缘路由错误或静态站点请求，请使用 `void project requests --status 5xx`。

对于直接部署到 Cloudflare 的目标，`--filter` 会转换为 Cloudflare 的实时搜索，`--deployment` 用于选择 Worker Version，`--level error` 用于选择出错的调用。不支持按其他单独的控制台日志级别筛选，`--range` 也不会查询历史记录。`void project requests` 仅适用于托管平台。

## `void project requests` {#void-project-requests}

```
void project requests [--status <filter>] [--range <duration>]
```

显示已关联项目的请求流量，包括不会出现在 Worker 日志中的静态资源请求和边缘错误。

| 选项                 | 用途                                                                                          | 默认值 |
| -------------------- | --------------------------------------------------------------------------------------------- | ------- |
| `--status <filter>`  | 按状态筛选：状态类别（`2xx`、`3xx`、`4xx`、`5xx`）或精确的三位状态码（例如 `500`）。         | 无      |
| `--range <duration>` | 向前查询的时间范围。格式为 `<number><unit>`（m/h/d），最长 7d。                                  | `1h`    |

输出中每个请求占一行（`HH:MM:SS METHOD STATUS TYPE DURATION`）。5xx 以红色显示，4xx 以黄色显示。注意：请求路径不会被记录，因此此视图显示状态和类型，而不显示 URL。对于确实到达 Worker 的请求，可使用 `void project logs` 查看具体 URL 和日志详情。

示例：

```
void project requests --status 5xx
void project requests --range 24h
```

## `void project rollback [deployId]` {#void-project-rollback-deployid}

```
void project rollback [deployId] [--platform cloudflare]
```

回滚到之前的部署或 Worker Version。

- 省略 `[deployId]` 时，会显示已保留部署的交互式选择菜单
- 如果目标部署已应用的迁移数量少于当前部署，会先显示列出迁移差异的警告，再请求确认

在 Void 平台上，可以选择已保留的部署。在 Cloudflare 上，请使用完整的 Worker Version ID，或能唯一确定版本的前缀。Void 会激活该版本，让其承接 100% 的流量。如果两个版本都具有完整的触发器快照，还会恢复所选版本的定时任务、队列、工作流、路由和自定义域名。否则，回滚会保留当前触发器并恢复代码，也支持最初在 Void 之外部署的版本。

如果项目保存的目标不是 Cloudflare，而你曾通过 `void deploy --platform cloudflare` 进行单次部署，回滚该 Worker 时请传入 `--platform cloudflare`。

回滚不会撤销数据库迁移。如果旧代码可能会使用较新的 schema，或缺少迁移元数据，Void 会说明风险并请求确认。在 Cloudflare 上，可使用 [`void db restore`](/zh/reference/cli/database#void-db-restore)，配合部署流程在执行迁移前打印的恢复点来撤销 D1 迁移；恢复窗口为 Workers Free 的 7 天或 Workers Paid 的 30 天。

## `void project cancel [deployId]` {#void-project-cancel-deployid}

```
void project cancel [deployId]
```

取消正在进行的部署。

- 省略 `[deployId]` 时，取消已关联项目当前正在进行的部署
- 提供 `[deployId]` 时，取消该部署；它必须仍在进行中

Void 会先请求确认，再发送取消请求。

此命令仅适用于托管平台。直接部署到 Cloudflare 是本地操作，不会提供可供取消的远程构建。

## `void project delete [name]` {#void-project-delete-name}

永久删除托管的 Void 项目及其全部资源（数据库、KV 命名空间、R2 存储桶和部署）。需要输入项目 slug 确认；`--force`（`-f`）会跳过提示。

省略 `[name]` 时，使用已关联的项目。

对于直接部署到 Cloudflare 的目标，此命令会拒绝执行。推断出的资源可能被共享，因此 Void 绝不会自动拆除这些资源；请先核实所有权，再使用 Cloudflare 工具显式删除。

## `void project purge-cache` {#void-project-purge-cache}

```
void project purge-cache [--project <name>]
```

清除已关联项目的所有缓存页面。边缘缓存会在几秒内清空。

提供 `--project` 时，清除指定项目的缓存，而不是已关联项目的缓存。

此命令仅适用于托管平台。对于直接部署到 Cloudflare 的目标，请重新部署，或自行清除配置的 ISR KV 命名空间。
