---
outline: deep
---

# 平台管理 {#platform-management}

由 Void 管理的项目部署到显式选择的平台。通过 [`void connect`](/zh/reference/cli/auth#connect) 连接平台。连接按 API 源地址分别保存，凭据的作用范围也限定为对应源地址。

## 连接命令 {#connection-commands}

```sh
void platform list
void platform use [id]
void platform status [id]
```

`list` 会先显示当前选定的平台，再显示其他已保存的平台。具有本地安装记录的平台，会在名称旁显示安装 slug，例如 `Cloudflare Void (cloudflare)`；可以通过 `void platform use cloudflare` 选择。已连接的平台如果没有本地安装 slug，请使用输出的 API URL。

`use` 和 `status` 接受安装 slug、显示名称、已保存的 ID 或 API URL。如果 slug 或名称匹配多个平台，请使用 API URL 明确选择。仅配置一个平台时会自动选中；有多个平台时，交互式运行会显示选择列表，非交互式运行则必须显式指定。已记录平台 URL 的项目，在全局默认平台更改后仍会使用原平台。

对于自托管平台，`status <installation-id>` 会先输出本地保存的生命周期进度，再检查在线 API。本地检查点可能已过时。如果维护期间在线发现失败，命令仍会显示该检查点，但会报错退出；这并不能确认平台当前可用。

## 运维命令 {#operator-commands}

使用 `void platform` 管理所选平台上的用户和应用。登录、授予访问权限和调查部署的方法，见[平台管理指南](/zh/guide/platform-administration)。

以下每个命令都支持通过 `--connection <slug-or-url>` 选择已注册的平台，并通过 `--json` 输出结构化结果，也接受显示名称和已保存的 ID。不传 `--connection` 时，Void 会先使用已设置的 `VOID_API_URL`，否则使用当前平台连接。应用的项目文件不会改变这一选择。

### 执行变更 {#making-changes}

更改用户、项目、注册访问权限、邀请或 Worker 的命令，都会先显示预览，再要求确认：

```sh
void platform user plan <user-id> pro --plan
void platform user plan <user-id> pro --yes
```

`--plan` 会校验变更并显示影响，不实际执行。`--yes` 会跳过提示直接执行，脚本中必须使用。两者只能选一个，不能组合使用。这些选项也适用于取消部署和维护命令，但不适用于身份认证命令。

每次预览和执行请求的超时上限默认为五分钟。可将 `--timeout <seconds>` 设为 1 到 3600 的整数来调整。读取请求和单次日志轮询的超时上限为 30 秒。

Void 不会自动重试变更。如果请求断开连接或超时，请先检查受影响的对象和 `void platform system events`，再重新执行。部分完成的结果会说明哪些工作已完成，并以非零状态退出。

### 身份认证 {#operator-authentication}

登录、查看会话或退出登录：

```sh
void platform auth login [--provider <connection-id>] [--token-stdin]
void platform auth status
void platform auth logout
void platform auth token [--token-stdin]
```

浏览器登录会提供平台已启用的登录方式，`--provider <connection-id>` 可指定其中一种。登录会将有效期一小时的管理员会话保存在系统钥匙串中。退出登录会撤销该会话，并移除本地凭据。

`auth token` 会输出当前运维令牌。使用 `--token-stdin` 时，会从标准输入读取完整的管理员 API 登录会话，换取新的运维令牌。`auth login --token-stdin` 则将换取的令牌保存到钥匙串，而不是输出。

用于自动化时，请提供 `VOID_OPERATOR_TOKEN`，并通过 `VOID_API_URL` 或 `--connection` 显式指定平台。运维令牌与应用部署凭据分开保存。API 会在每次请求中检查你当前是否拥有管理员权限。示例见[使用脚本](/zh/guide/platform/administration/operations#using-scripts)。

## 分页与 JSON {#pagination-and-json}

用户、项目、部署、邀请和事件列表默认返回第 `1` 页，每页 20 项。这些列表的 `--limit` 接受 1 到 100，JSON 响应包含页码、每页数量和总数。

使用 `--json` 时，结果写入标准输出，命令错误以 JSON 写入标准错误。错误和部分失败都会以非零状态退出。`system health` 的不健康结果仍写入标准输出，同时以非零状态退出。日志跟踪会为每个响应写入一个 JSON 对象，包括每一页以及空响应。

## 平台命令分组 {#platform-command-groups}

- [安装与维护](/zh/reference/cli/platform-installation)
- [套餐与身份认证配置](/zh/reference/cli/platform-config)
- [用户、项目和注册访问权限](/zh/reference/cli/platform-users)
- [项目零信任防护](/zh/reference/cli/platform-zero-trust)
- [部署、构建和系统运维](/zh/reference/cli/platform-operations)
- [邮件管理](/zh/reference/cli/platform-email)
