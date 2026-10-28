---
outline: deep
---

# 平台用户与项目 {#operator-users}

这些命令需要管理员会话。平台选择、预览和确认方式，见[平台管理](/zh/reference/cli/platform#operator-commands)。

通过登录名、邮箱或 ID 查找用户，再查看其项目和用量：

```sh
void platform user list [--search <text>] [--page <n>] [--limit <n>]
void platform user show <id>
```

使用同一个 ID 更改套餐、暂停或恢复账号，或删除账号：

```sh
void platform user plan <id> <plan-id>
void platform user suspend <id> [--reason <text>]
void platform user restore <id>
void platform user delete <id>
```

暂停用户会阻断其应用，包括定时任务和队列消费者。账号暂停期间，每条队列消息约每小时重试一次，每次都会消耗该队列的一次重试机会。重试次数耗尽的消息会被丢弃：默认允许重试 3 次时，约 3 小时后丢弃；配置为 `maxRetries: 0` 时则立即丢弃。如果误暂停账号，请尽快恢复；队列会在约一小时内恢复投递。删除用户也会删除其项目资源。更改套餐会更新资源限制，但不会解除管理员设置的暂停。

不能删除或暂停最后一名处于启用状态的管理员。预览和实际变更都会执行此限制，浏览器管理界面也一样。允许移除管理员时，会先撤销其管理员权限，再清理资源。如果清理失败，权限仍保持撤销，部分完成的结果中会说明这一情况。

## 项目 {#operator-projects}

列出整个平台的项目，按所有者筛选，或查看某个项目的资源：

```sh
void platform project list [--user <user-id>] [--search <text>] [--page <n>] [--limit <n>]
void platform project show <id>
void platform project normalize <id> [--plan | --yes]
void platform project delete <id>
void platform project owner <project-id> <user-id>
```

搜索可匹配项目 slug、ID 或所有者的登录名。`show` 包含资源、域名、最近 10 次部署和最近 20 次构建。`delete` 会移除项目及其资源。

如果部署报告项目需要规范化，运维人员可以通过 `normalize <id> --plan` 预览，再用 `--yes` 执行。命令会先验证当前提供服务的部署和已记录的队列名称，再更新项目记录。流量和 Cloudflare 资源保持不变；部署或恢复进行中时，会拒绝更改。如果验证后的队列名称与预期投递路由名称不一致，规范化也会拒绝更改，请先协调修复该队列的路由，再重试。如果无法验证当前提供服务的部署，请先调查报告的路由，再重试。项目缺少活动部署时，升级前应先在之前兼容的平台运行时上完成中断部署的恢复。

`owner` 将项目转移给另一名已注册用户。通过 `--plan` 预览，再交互式执行或使用 `--yes`。预览会报告正在进行的工作所造成的阻碍，以及转移后适用的账号套餐。原所有者会成为项目管理员，已有的项目级 CI 部署凭据会被撤销，已经产生的用量仍归原所有者。

## 注册访问权限 {#operator-signup}

查看注册限制、向所有人开放注册，或要求匹配允许名单：

```sh
void platform signup show
void platform signup open
void platform signup restrict
```

按类型和匹配模式添加、移除 GitHub 或邮箱条目：

```sh
void platform signup allow <github|email> <pattern> [--note <text>]
void platform signup disallow <github|email> <pattern>
void platform signup remove <github|email> <pattern>
```

为兼容已有脚本，`remove` 仍可作为别名使用。GitHub 条目匹配登录名；邮箱条目可跨登录提供方匹配邮箱地址或域名模式，例如 `*@example.com`。请在 shell 中用引号包裹通配符模式。

对于没有已验证邮箱的 OIDC 身份，使用已配置的连接 ID 和身份提供方的稳定主体标识授予访问权限：

```sh
void platform signup allow identity <connection-id> <subject> [--note <text>]
void platform signup disallow identity <connection-id> <subject>
```

连接 ID 可通过 `void platform config auth list` 查看。身份主体标识必须精确匹配，且区分大小写；不会应用通配符、推断邮箱或关联账号。仍须满足该登录方式的域名或群组限制，新获准注册的账号具有普通用户角色。仅邀请或允许名单注册模式下，空允许名单会阻止新账号注册。企业批准注册模式下，除了符合企业规则的用户，显式授权也可以允许其他用户加入。

## 邀请 {#operator-invitations}

通过邮件邀请用户，并跟踪其是否已经加入：

```sh
void platform invitation list [--page <n>] [--limit <n>]
void platform invitation send <email[,email...]>
void platform invitation revoke <id>
```

发送命令最多接受 100 个以逗号分隔的地址。即使邮件投递不可用或失败，邀请仍会授予注册权限；投递结果会单独报告。如果没有发出邮件，请自行分享平台的 `/invite` 页面或 `void connect '<platform URL>'` 命令。撤销待接受的邀请会移除针对该精确邮箱的授权，但范围更广的域名条目仍可能允许此人注册。
