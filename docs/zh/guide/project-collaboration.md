---
outline: deep
---

# 项目协作 {#project-collaboration}

托管在 Void 平台上的项目可以有一名所有者，以及多名只读成员、协作者和项目管理员。团队访问权限属于平台功能，直接部署到 Cloudflare 的项目不支持此功能。

## 角色 {#roles}

| 角色 | 权限 |
| --- | --- |
| 只读成员 | 查看项目、用量、资源、部署、构建、日志和成员列表，不能部署。 |
| 协作者 | 拥有只读成员权限，还可执行部署、回滚、取消操作和迁移，管理密钥、数据库配置及部署前置条件。 |
| 项目管理员 | 拥有协作者权限，还可管理域名、邮件目标地址、GitHub 配置、邀请、角色和成员移除。 |
| 所有者 | 拥有项目管理员权限，还可删除项目。 |

只有所有者可以创建、列出、续期或撤销项目的 CI 部署凭据。这些凭据以承担计费的所有者身份执行无人值守部署，且独立于成员的登录会话。因此，协作者和项目管理员应使用自己的账号部署，而不能创建长期有效的所有者凭据。

项目受所有者的套餐、额度和暂停状态约束。成员自己的套餐不会改变项目的可用额度，也不能通过协作者绕过所有者账号被暂停的限制。项目管理员不同于整个平台的安装管理员，不具有平台范围的访问权限。

## 邀请已注册用户 {#invite-a-registered-user}

所有者或项目管理员可以使用对方在同一平台上已有账号的注册邮箱发送邀请：

```sh
void project team invite teammate@example.com --role collaborator
```

要管理当前关联项目以外的项目，传入 `--project <slug>`。未注册的邮箱会被拒绝。项目邀请不会创建账号，也不会将邮箱加入限制注册的允许名单。

邀请在七天后过期。如果平台无法发送邀请邮件，CLI 会打印邀请 ID，以及连接平台和接受邀请的命令，你可以将这些信息发给受邀用户。该用户在同一平台运行 `void project team pending` 时，也能看到邀请。

查看成员列表和已发送的邀请：

```sh
void project team list
void project team invitations
```

## 接受或拒绝邀请 {#respond-to-an-invitation}

连接邀请对应的平台，查看发给当前账号的邀请，再通过邀请 ID 接受或拒绝：

```sh
void connect api.example.com
void project team pending
void project team accept <invitation-id>
# or
void project team decline <invitation-id>
```

邀请与注册账号绑定。即使转发邀请 ID，其他用户也无法接受该邀请。

这三个命令使用 `void connect` 选择的当前平台连接，即使当前目录关联了其他项目，或直接部署到 Cloudflare，也不受影响。如果设置了 `VOID_API_URL`，则优先使用该值。如果使用 `VOID_TOKEN`，还必须将 `VOID_API_URL` 设置为与令牌对应的平台。每个命令都会显示它正在访问的平台。

接受邀请只会授予访问权限，不会关联当前目录。进入受邀应用的目录；如果尚未关联，运行 `void project link`。如果该目录已关联其他项目，请使用一份不含 `.void/project.json` 的独立检出副本，在其中连接受邀平台，再运行 `void project link`。

如果找不到邀请，请检查平台和当前登录的账号。切换账号时，将 `VOID_API_URL` 设置为邀请对应的平台 URL，取消已设置的 `VOID_TOKEN`，然后运行 `void account logout`，再用受邀邮箱运行 `void account login`。如果邀请已过期或被撤销，请项目管理员重新邀请。

## 更改或移除权限 {#change-or-remove-access}

所有者和项目管理员可以更改任意非所有者成员的权限，或撤销待接受的邀请：

```sh
void project team role <user-id> reader
void project team remove <user-id>
void project team revoke <invitation-id>
```

非所有者成员可以通过 `void project team leave` 离开项目。所有者不能直接离开，必须先由安装管理员[转移所有权](/zh/guide/platform/administration/projects#transferring-project-ownership)。

当协作者或管理员被移除、主动离开，或降为只读成员时，平台会替换项目 Worker 用于调用 AI、邮件和远程绑定等平台服务的凭据。项目中所有 Worker 都收到新凭据后，旧凭据才会失效。这个过程通常约需 10 分钟；如果正在部署，则可能更久。如果替换未能完成，旧凭据会一直有效，直到替换完成；所有者和管理员会在 `void project status` 和 `void project team list` 中看到警告。WebSocket 连接会重新连接一次。Worker 切换到新凭据期间，平台服务调用可能短暂失败，定时任务可能跳过一次，队列消息则会在几分钟后重新投递。

被移除成员部署的代码会继续运行，直到你替换它。如果你不再信任这些代码，请部署可信代码；部署完成后，平台会再次替换凭据。该成员之前部署、为回滚而保留的版本仍使用旧凭据。因此，回滚到这些版本后，AI、邮件和 ISR 重新验证会失败，直到你再次部署。
