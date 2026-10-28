---
outline: deep
---

# 从 CI 安装 {#install-from-ci}

首次安装请按[交互式设置](/zh/guide/platform/installation/setup)操作。本文适用于将已经配置好的安装流程自动化的场景。

::: details 非交互式输入

从受保护的 CI Secret 中注入以下值。不要将它们写入工作流或明文密钥文件后提交到仓库。

| 环境变量 | 交互式设置中的对应值 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | 管理 API 令牌 |
| `VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN` | 运行时 API 令牌 |
| `VOID_PLATFORM_DATABASE_URL` | 专用 PostgreSQL URL |
| `VOID_PLATFORM_HYPERDRIVE_ID` | 已有、由外部单独管理的 Hyperdrive ID（如适用） |
| `VOID_PLATFORM_HYPERDRIVE_ORIGIN_HOST` | 该 Hyperdrive 的源站主机；与其 ID 和用户一起设置 |
| `VOID_PLATFORM_HYPERDRIVE_ORIGIN_USER` | 该 Hyperdrive 的运行时数据库用户；与其 ID 和主机一起设置 |
| `VOID_PLATFORM_R2_ACCESS_KEY_ID` | R2 Access Key ID（访问密钥 ID） |
| `VOID_PLATFORM_R2_SECRET_ACCESS_KEY` | R2 Secret Access Key（秘密访问密钥） |
| `VOID_PLATFORM_JWT_SECRET` | 原始 JWT 签名密钥 |
| `VOID_PLATFORM_EMAIL_SIGNING_SECRET` | 启用邮件时使用的专用邮件签名密钥 |
| `VOID_PLATFORM_PROJECT_SECRET_KEY` | 原始项目加密密钥，使用 base64 编码 |
| `VOID_PLATFORM_RECOVERY_KEY` | 无法使用钥匙串时，用于加密本地恢复状态的 32 字节密钥，使用 base64 编码 |
| `VOID_EMAIL_SENDER_DOMAIN` | 可选的共享邮件域名；必须同时提供 `VOID_EMAIL_SHARED_ZONE_ID` |
| `VOID_EMAIL_SHARED_ZONE_ID` | 该邮件域名的 Cloudflare 区域 ID；必须同时提供 `VOID_EMAIL_SENDER_DOMAIN` |

如果使用默认的纯 GitHub 登录，还需设置 `VOID_PLATFORM_GITHUB_CLIENT_ID`、`VOID_PLATFORM_GITHUB_CLIENT_SECRET` 和 `VOID_PLATFORM_ADMIN_GITHUB_LOGIN`。对于 Google、OIDC 或 Access 登录，请按照[配置格式](/zh/guide/platform/installation/setup#choose-login-methods)，通过 `--auth-config <path>` 传入文件。文件中每个 `clientSecretEnv` 指定的值，都应从 CI 密钥管理器注入。自动配置 Access 保护时，可能还需要提供具备[设置权限](/zh/guide/platform/installation/setup#cloudflare-access)的 `VOID_PLATFORM_ACCESS_SETUP_TOKEN`。

凡是继续安装或修复需要签名密钥和加密密钥，都应使用该平台实例保存的原始密钥。密钥环轮换后，请提供[完整的密钥环恢复输入](/zh/guide/platform/installation/maintenance#manage-an-installation-from-another-machine)。卸载后，数据库归属记录和表仍会保留；其他平台实例应使用新的数据库。

安装或升级时，同时设置两个邮件值即可启用邮件。后续升级会复用已记录的值。如果某个平台实例已经启用邮件却没有记录这些值，请在升级前同时提供两者。

```sh
void platform install \
  --name team \
  --display-name "Team Void" \
  --account <account-id> \
  --application-domain example.app \
  --zone example.app \
  --yes
```

在 CI 中，执行写入操作必须传入 `--yes`，只读的 `--plan` 不需要。自定义运行时还需要 `--runtime <directory>`。对于新平台实例，运行 `--plan` 时应使用与无人值守安装相同的账号、名称和域名选项。如果使用 `--auth-config`，两个命令应传入同一个文件。手动创建登录提供商的 OAuth 或 OIDC 客户端时，请注册 `<platform-api-url>/auth/callback`；自动配置 Access 时则会自行管理对应应用。自定义 API 主机名是可选的。

在 CI 中，如果平台 Worker 曾在 Cloudflare 控制台或通过 Cloudflare API 被修改，或其当前生效版本没有对应的 Void 部署记录，`upgrade`、`repair`、`enable`、`rollback` 和 `install --resume` 都会在修改平台 Worker 或暂停流量之前停止。详见[在 Void 之外修改的平台 Worker](/zh/guide/platform/installation/maintenance#workers-changed-outside-void)。

:::

## 自定义平台 {#customize-the-platform}

若要修改平台实现或部署自己的构建，请按[平台开发](/zh/guide/platform-development)操作。该指南涵盖本地开发、源码构建，以及 fork 仓库的 CI 配置。
