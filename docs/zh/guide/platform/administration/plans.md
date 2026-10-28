---
outline: deep
---

# 套餐与限额 {#plans-and-limits}

套餐用于设置平台账号可使用的资源限额，不会向用户收费，也不会替用户购买 Cloudflare 服务。以管理员身份登录后，打开管理控制台的 **Plans（套餐）** 页面，或使用 CLI：

```sh
void platform auth login
void platform config plans
```

你可以选择套餐查看或修改设置，以已有套餐为基础创建新套餐，也可以设置新账号默认使用的套餐。修改后无需重新部署应用或平台。

## 使用控制台 {#use-the-dashboard}

打开 **Plans（套餐）**，可以查看各套餐的固定 ID、账号数量，以及哪个套餐是注册时的默认选项。点击 **Add plan（添加套餐）** 可以复制已有套餐；点击 **Edit（编辑）** 可以修改显示名称、限额、构建实例规格，以及是否允许使用较短的项目 slug。

点击 **Review changes（审阅更改）**，对比修改前后的设置，并查看受影响的账号数量。确认配额警告后，点击 **Apply changes（应用更改）**。如果审阅期间有人修改了套餐配置，需要重新打开套餐，再次审阅。

在编辑页面，你还可以设置注册时的默认套餐、暂停或恢复套餐分配、重置内置套餐，或者选择一个可用的替代套餐后删除原套餐。每项操作都需要先审阅再确认。

结果页面会自动继续更新受影响的账号。如果离开页面或更新暂停，可以重新打开 **Plans（套餐）**，点击 **Continue account updates（继续更新账号）**。再次修改套餐前，应先完成待处理的账号更新。已有用量记录和计费周期会保留。

## 添加套餐 {#add-a-plan}

每个套餐都有固定的 ID，显示名称则可以修改。复制套餐时，会一并复制限额、构建实例规格，以及是否允许短项目 slug 的设置：

```sh
void platform config plans add team --copy pro --name "Team" --plan
void platform config plans add team --copy pro --name "Team" --yes
```

将套餐分配给已有账号，或设为新账号的默认套餐：

```sh
void platform user plan <user-id> team --yes
void platform config plans default team --yes
```

修改默认套餐不会迁移已有账号。重命名套餐也不会改变其 ID 或账号分配关系。

## 修改限额 {#edit-limits}

交互式菜单每次可修改一项限额。如果需要通过脚本操作，或同时修改多项设置，可以准备一个 JSON 文件：

```json
{
  "name": "Team",
  "limits": {
    "requestsPerMonth": 10000000,
    "concurrentBuilds": 3,
    "buildTimeoutMinutes": 15
  },
  "buildInstanceType": "standard-4"
}
```

未写入文件的设置会保留当前值。先预览，再应用更改：

```sh
void platform config plans set team --file team-plan.json --plan
void platform config plans set team --file team-plan.json --yes
```

限额必须是非负整数；`0` 表示套餐不限制该项资源。构建超时时间仍受平台 60 分钟的上限约束，设为 `0` 时会采用这个上限。可配置的限额包括：

| 配置项 | 含义 |
| --- | --- |
| `requestsPerMonth` | 每个账号计费月内的应用请求数 |
| `cpuMsPerRequest` | 每次应用请求默认可用的 CPU 时间，单位为毫秒 |
| `maxCpuMsPerRequest` | 应用可申请的 CPU 时间上限 |
| `subRequestsPerInvocation` | 每次调用可发起的子请求数 |
| `deploysPerDay` | 每天的部署次数 |
| `aiNeuronsPerMonth` | 每个账号计费月内可使用的 AI neurons 数量 |
| `retainedDeployments` | 保留的 Worker 部署数量 |
| `sandboxRuntimeSecondsPerMonth` | 每个账号计费月内的沙箱运行时长，单位为秒 |
| `sandboxMaxConcurrentInstances` | 同时运行的沙箱实例数 |
| `concurrentBuilds` | 同时执行的构建数 |
| `buildTimeoutMinutes` | 构建超时时间，单位为分钟 |

`cpuMsPerRequest` 不能超过 `maxCpuMsPerRequest`。如果默认 CPU 时间设为不限，上限也必须设为不限。构建实例支持 `standard-3`（2 vCPU、8 GiB）和 `standard-4`（4 vCPU、12 GiB）两种规格。新的规格和超时设置只对后续构建生效，正在运行的构建仍使用启动时记录的设置。

需要更细致的控制时，还可以在配置文件中设置 `"allowShortSlugs": true`，允许使用不超过五个字符的项目 slug；设为 `false` 后，之后的变更必须使用更长的 slug。已有项目的 URL 会保留。复制套餐会继承这项设置；内置的 `free` 套餐默认关闭，其他内置套餐默认开启。

页面中显示的 D1、R2 和 KV 存储数据仅供参考，不能修改为强制执行的存储配额。静态部署仍使用原有的保留策略。

预览会显示受影响的账号数量，并抽样检查是否已有账号超过拟设置的配额。降低配额可能限制现有应用，也可能影响未被抽样检查的账号。用量历史和计费周期会保留，修改套餐不会重置用量。管理员手动暂停的账号仍保持暂停状态。

## 归档或删除套餐 {#archive-or-remove-a-plan}

将套餐归档后，它会保留现有账号，但不再分配给新账号：

```sh
void platform config plans archive team --yes
void platform config plans restore team --yes
```

归档当前默认套餐前，需要先设置另一个默认套餐。如果要删除的套餐仍有账号使用，应先选择替代套餐并审阅更改：

```sh
void platform config plans remove team --replacement pro --plan
void platform config plans remove team --replacement pro --yes
```

删除默认套餐同样需要指定替代套餐。如果套餐既不是默认选项，也没有账号使用，就可以直接删除。账号迁移到替代套餐后，已有用量会保留。使用 `void platform config plans reset <plan-id>` 可以恢复内置套餐最初的限额和构建实例规格；自定义套餐没有可供重置的内置值。

确认删除前，审阅页面会显示替代套餐，以及限额、构建实例规格和短 slug 权限的变化。

## 完成待处理的更新 {#complete-pending-updates}

应用更改后，CLI 会持续更新账号，直到全部完成。如果更新失败或不再推进，配置仍会保存，结果会列出待处理的工作，命令则以非零状态码退出。先检查套餐配置，再继续更新：

```sh
void platform config plans show
void platform config plans sync --yes
```

`sync` 会按已保存的策略继续更新账号，直到全部完成。再次编辑套餐配置前，应先完成待处理的更新。如果请求连接中断，先检查套餐配置和[运维事件](/zh/guide/platform/administration/operations)，再重试。

所有命令都接受 `--connection <registered-id-or-url>` 和 `--json`。通过脚本修改时需要加上 `--yes`；使用 `--plan` 可以只读预览更改。
