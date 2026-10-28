---
outline: deep
---

# 首次部署 {#first-deployment}

在浏览器中打开平台 API URL，可以看到欢迎页、CLI 连接说明和管理员控制台链接。将这个 URL 分享给团队成员，他们就可以连接到你的平台。

先检查新平台，再使用安装时选择的管理员登录方式登录：

```sh
void platform status
void platform auth login
void platform system health
```

管理员登录与部署应用所用的凭据彼此独立。在新建或尚未关联的 Void 应用目录中，使用安装后的 API URL 连接平台，部署第一个项目：

```sh
void connect void-company-api.example.workers.dev
void deploy --platform void --project my-first-app
```

`void connect` 会校验平台，并在需要时引导登录。部署询问时，确认创建项目。如果要使用已有项目，改为运行 `void project link`。已经关联其他平台的应用会保留原来的部署目标；首次测试时，请使用一个全新的应用目录。

平台接受部署后，部署会独立于 CLI 连接继续执行。连接故障后，CLI 会自动重连。关闭 CLI 后，可以用 `void project status` 查看部署，或用 `void project cancel` 请求取消。

CLI 会将登录凭据保存在系统钥匙串中，并按平台 URL 分别保存。不提供 URL 时，`void connect` 会让你选择 Cloudflare 或 Void 平台；`void connect --platform void` 会列出已保存的平台，并提供输入其他 URL 的选项。

如果用于 CI，请以项目所有者身份登录，创建有有效期限制、且作用范围限定到项目的部署凭据：

```sh
void project token create --name ci --expires-in 30
```

将输出的 `VOID_TOKEN` 和 `VOID_API_URL` 保存到 CI 密钥管理器。每次进入全新的 CI 环境，都先运行 `void connect "$VOID_API_URL" --no-login`，再部署；项目文件不能替代这一步连接。CI 无法回答选择项目的提示，因此必须在 `void deploy` 前选定项目：设置 `VOID_PROJECT`，传入 `--project <slug>`，或提交通过 `void project link` 生成的 `.void/project.json`。新应用会在 `.gitignore` 中忽略 `.void`；如果要提交关联信息，请将该行替换为 `.void/*` 和 `!.void/project.json`。通过 `void project token renew <id>` 轮换凭据，通过 `void project token revoke <id>` 撤销。人工登录令牌不能用作 CI 凭据。

如果平台由 Cloudflare Access 保护，则必须同时提供 Access 身份证明和项目凭据；服务令牌不会授予 Void 用户或运维权限。使用预渲染或远程绑定的部署会同时调用 API 和代理，因此应将 `VOID_ACCESS_CREDENTIALS` 保存到 CI 密钥管理器中，为两个确切的 HTTPS 源地址分别配置条目。即使两个源地址使用同一组已被允许的服务令牌凭据，也必须保留两个条目：

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

`VOID_ACCESS_ORIGIN` 只能将凭据范围限定到一个源地址；将它设置为 API 源地址，并不会授权代理请求。

使用以下命令检查连接和平台实例：

```sh
void platform list
void platform use [id]
void platform status [id]
```

## 管理访问权限 {#managing-access}

安装后，以首位管理员身份登录。如果团队成员使用 GitHub，将其登录名加入注册允许名单：

```sh
void platform auth login
void platform signup allow github teammate
```

Void 会显示拟议的访问权限变更，并要求你确认。批准后，`teammate` 就可以连接平台 API URL 并通过 GitHub 登录。

如果要允许邮箱地址、域名或 OIDC 身份，或开放注册，请参阅[授予访问权限](/zh/guide/platform/administration/access#giving-people-access)。

管理员会话的有效期为一小时，可以用来查看用户、项目、日志和平台健康状况。[平台管理指南](/zh/guide/platform-administration)介绍了这些操作、预览和自动化流程。也可以打开 `<API origin>/admin/login`，使用浏览器中的管理界面。

### 使用 Zero Trust 保护项目主机名 {#protect-project-hostnames-with-zero-trust}

安装后，管理员可以要求新项目的主机名使用 Cloudflare Access 保护，同时允许各项目的所有者或项目管理员选择退出。此功能独立于平台 API 自身的 Access 登录与保护，需要单独的 Cloudflare API 令牌。使用要求、设置命令和恢复方法见[项目 Zero Trust](/zh/guide/platform/administration/zero-trust)。
