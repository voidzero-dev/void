---
outline: deep
---

# 运维 {#operations}

## 预览变更 {#previewing-changes}

修改平台的命令会先显示受影响的对象，再请求确认。如果只想查看变更而不执行，请添加 `--plan`：

```sh
void platform user suspend <user-id> --reason "Investigating unexpected traffic" --plan
```

预览会显示将要停用的账号，以及对其项目的影响。去掉 `--plan` 再次运行命令，即可交互式确认；准备好执行变更后，也可以使用 `--yes`：

```sh
void platform user suspend <user-id> --reason "Investigating unexpected traffic" --yes
```

脚本必须使用 `--yes` 才能执行这些变更。`void platform auth` 下的会话命令会直接执行，不使用 `--plan` 或 `--yes`；而 `void platform config auth` 下的配置变更会提供预览并要求确认。变更后，`void platform system events` 会显示执行操作的管理员、受影响的对象和记录的结果。

账号拥有的资源较多时，变更可能需要更长时间。修改平台的请求默认最多等待五分钟；可以通过 `--timeout` 调整超时时间，单位为秒：

```sh
void platform user delete <user-id> --timeout 600 --plan
```

请求超时或连接断开时，部分操作可能已经完成。重试前，请先检查受影响的对象和 `system events`。Void 会在能够获取结果时报告已完成的部分，不会自动重复执行变更。

## 持续跟踪日志 {#following-logs}

排查某次部署时，可以先找到部署 ID，再持续查看其运行时日志：

```sh
void platform deployment list --project <project-id>
void platform deployment logs <deployment-id> --since 10m --follow
```

运行时日志包括应用消息、异常和 HTTP 状态码。未设置 `--follow` 时，命令会读取一页历史日志。使用 `--since` 可以指定时间范围、ISO 日期或毫秒时间戳。

日志可能在请求结束后才可查询。持续跟踪时，查询范围会向前重叠五分钟，以获取延迟到达的记录，同时避免重复输出。延迟超过五分钟的记录，可能需要稍后查询历史日志才能获取。

查看构建日志时，使用构建 ID：

```sh
void platform build logs <build-id> --follow
```

持续跟踪会等到最后的日志输出后才结束，包括构建状态变化后写入的诊断信息。如果是 GitHub Actions 构建，命令会提供对应的日志 URL。

## 检查平台 {#checking-the-platform}

### 健康检查 {#health-checks}

使用概览查看近期活动，或运行健康检查，检测平台服务和数据库：

```sh
void platform system overview
void platform system health
```

健康检查会检测所选平台已配置的服务。结果异常时，命令会以非零状态码退出，因此也可以在脚本中使用该命令。

控制台的 **System Status（系统状态）**页面每 30 秒刷新一次健康检查，并在出现问题的服务旁显示错误。

使用 `void platform upgrade`、`repair`、`disable` 和 `enable` 维护平台。请参阅[平台维护](/zh/guide/platform/installation/maintenance#resume-repair-recover-and-upgrade)。

升级或回滚期间，可以在管理界面的 `/admin/status` 查看进度。请参阅[跟踪升级和回滚进度](/zh/guide/platform/installation/maintenance#follow-upgrade-and-rollback-progress)。

有关备份和恢复，请参阅[为灾难恢复做好准备](/zh/guide/platform/installation/maintenance#prepare-for-disaster-recovery)。

## 在脚本中使用 {#using-scripts}

添加 `--json`，即可由其他程序读取命令结果：

```sh
void platform user list --page 1 --limit 50 --json
void platform system health --json
```

结果会写入标准输出。命令错误会以 JSON 格式写入标准错误，并以非零状态码退出。使用 `--follow` 时，每次日志响应会单独输出为一行 JSON。

运维令牌一小时后过期。在 CI 中，每个任务开始时，都应使用有效的完整 API 登录会话换取新的运维令牌，而且该会话所属的管理员账号必须处于启用状态。请显式选择平台，通过密钥管理器将完整会话注入 `VOID_TOKEN`，并将换取令牌的输出直接保存到受保护的任务环境中：

```sh
export VOID_API_URL=https://platform.example.com
VOID_OPERATOR_TOKEN="$(
  printf '%s' "$VOID_TOKEN" | void platform auth token --token-stdin
)" || exit 1
export VOID_OPERATOR_TOKEN
unset VOID_TOKEN
void platform system health --json
unset VOID_OPERATOR_TOKEN
```

换取令牌时，请关闭 Shell 命令跟踪，不要将任何一个令牌写入日志或明文文件。完整 API 登录会话会在 30 天后过期，也可能在此之前被撤销；请通过正常的身份认证登录流程获取新会话，并更新受保护的 CI 密钥。任务运行超过一小时时，必须在完整 API 会话仍然有效的情况下再次换取令牌。已过期的运维令牌无法自行刷新，Void 也不会为管理员自动化提供永久服务令牌。

`auth login --token-stdin` 会执行相同的权限提升，并将有效期一小时的运维令牌保存到系统钥匙串，供交互式使用。完整命令语法请参阅[运维身份认证](/zh/reference/cli/platform#operator-authentication)。
