---
outline: deep
---

# 用户与项目 {#users-and-projects}

## 管理用户与项目 {#managing-users-and-projects}

先查找要查看的用户：

```sh
void platform user list --search teammate
void platform user show <user-id>
```

将列表中的用户 ID 传给第二条命令，即可查看该用户的项目和用量。你还可以修改其套餐，或单独列出其项目：

```sh
void platform user plan <user-id> pro
void platform project list --user <user-id>
void platform project show <project-id>
```

项目详情包括资源、域名，以及最近的构建和部署记录。暂停或恢复用户、删除项目和移除账号等操作，见[命令参考](/zh/reference/cli/platform#operator-commands)。

在管理控制台中打开项目，即可查看团队成员。搜索平台用户并选择角色，就能直接将其加入团队，无需提供邮箱。你也可以调整或移除现有成员。通过其他项目流程发出的邀请会一直显示，直到被接受或撤销。如果无法通过邮件发送待处理的邀请，可以分享邀请 ID，让对方运行 `void project team accept <invitation-id>` 接受邀请。项目所有者不能直接从团队中移除，需要先转移所有权。移除协作者或管理员、将其降为只读成员，或者暂停、删除其账号时，都会[替换项目的平台凭据](/zh/guide/project-collaboration#change-or-remove-access)，与 CLI 的行为一致。

### 转移项目所有权 {#transferring-project-ownership}

只有平台实例的管理员可以更改项目所有者，新所有者必须已经在该平台上拥有账号。在控制台的项目页面搜索新所有者，先预览转移结果，再应用更改。使用 CLI 时，传入用户 ID：

```sh
void platform project owner <project-id> <new-owner-user-id> --plan
void platform project owner <project-id> <new-owner-user-id> --yes
```

预览会显示新旧所有者、各自的套餐和暂停状态、阻止转移的事项，以及路由和用量计数的变化。需要等待正在进行的回滚和构建完成。对于普通的活动部署，可以等待其完成，也可以使用 `void platform deployment cancel <id>` 取消；回滚部署不能取消。托管 Sandbox 控制器在清理完成前也会阻止转移，即使当前没有运行中的沙箱容器。预览会指出该控制器所属的部署。

转移完成后，原所有者会成为项目管理员。已有的项目级 CI 部署凭据会被撤销，需要以新所有者的身份重新创建。新所有者的套餐和限额立即生效；转移前的用量仍计入原所有者，之后的用量计入新所有者。如果应用更改后提示只有部分状态更新完成，应先检查项目和运维事件日志，再重试。

默认情况下，自托管安装的新用户使用 `custom` 配置，不限制应用请求数、AI 用量、部署频率或保留的 Worker 部署数量。`pro` 等具名配置会应用平台的配额和保留策略，但不会购买 Cloudflare 服务，也不会向用户收费。页面中的存储数据不代表强制执行的存储配额。在允许受邀团队之外的用户注册前，应先设置运行预算和保留策略。

自定义套餐、修改限额或更改新账号默认套餐的方法，见[套餐与限额](/zh/guide/platform/administration/plans)。

最后一位仍有访问权限的管理员不能被删除或暂停，在浏览器管理界面中操作也一样。必须始终有另一位管理员能够访问平台。自动用量限制不会移除管理员权限，也不等同于手动暂停账号。

移除其他管理员时，Void 会先撤销其管理员访问权限，再调整应用流量或删除资源。如果清理失败，访问权限仍保持撤销状态，错误信息会说明已完成的部分。仍有权限的管理员可以检查结果并重试清理。
