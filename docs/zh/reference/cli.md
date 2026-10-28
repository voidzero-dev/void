---
outline: deep
---

<script setup>
import LegacyDocRedirect from "../../.vitepress/theme/LegacyDocRedirect.vue";
import links from "../../.vitepress/redirects/reference-cli.json";

const zhLinks = Object.fromEntries(
  Object.entries(links).map(([anchor, target]) => [anchor, `/zh${target}`]),
);
</script>

<LegacyDocRedirect page="zh/reference/cli.md" :links="zhLinks" />

# CLI 参考 {#cli}

`void` 是已安装的 `void` 包提供的本地可执行文件。

本页用于查阅命令。首次配置项目时，请先阅读[快速开始](/zh/guide/quickstart)，需要了解命令的具体行为或选项时，再回到这里。

## 命令组 {#command-groups}

| 命令组 | 参考 |
| --- | --- |
| `init`, `prepare`, `info`, `migrate` | [项目配置](/zh/reference/cli/setup) |
| `connect`, `auth`, `account`, `cloudflare` | [连接与身份验证](/zh/reference/cli/auth) |
| `project` | [项目、团队、日志与回滚](/zh/reference/cli/project) |
| `deploy` | [部署](/zh/reference/cli/deploy) |
| `db` | [数据库](/zh/reference/cli/database) |
| `gen` | [代码生成](/zh/reference/cli/generate) |
| `secret`, `env` | [密钥与环境变量](/zh/reference/cli/secrets) |
| `github`, `build` | [GitHub 与构建](/zh/reference/cli/github) |
| `domain` | [自定义域名](/zh/reference/cli/domains) |
| `email` | [邮件](/zh/reference/cli/email) |
| `platform` | [平台安装与管理](/zh/reference/cli/platform) |

## 速查表 {#cheat-sheet}

| 命令 | 用途 |
| --- | --- |
| `void deploy` | 构建并部署到已配置的平台 |
| `void prepare` | 生成 `.void` 产物，不启动 Vite |
| `void info [--json]` | 移动资源代码前查看其已保存的名称 |
| `void gen model <name> [cols...]` | 生成 Drizzle 表和 API 路由的初始代码 |
| `void gen route <path>` | 创建 API 路由 |
| `void db push` | 直接应用 schema 变更，不生成迁移文件 |
| `void db generate` | 根据 schema 变更生成 SQL 迁移 |
| `void db status` | 显示本地或远程的迁移状态 |
| `void db reset` | 重置数据库并重新执行所有迁移 |
| `void db seed` | 重置本地数据库并填充初始数据 |
| `void db execute <sql>` | 对数据库执行 SQL（--remote 用于已部署的数据库） |
| `void db studio` | 打开 Drizzle Studio（--remote 用于已部署的外部数据库） |
| `void db restore --bookmark <b>` | 将已部署的 D1 数据库恢复到某个恢复点，适用于直接部署到 Cloudflare |
| `void secret put <name=value>` | 设置生产环境密钥 |
| `void secret list` | 列出生产环境密钥 |
| `void secret sync <file>` | 从 dotenv 文件批量上传密钥 |
| `void env check [--remote]` | 根据 env.ts schema 校验环境变量 |
| `void env types` | 根据 env.ts 重新生成 .void/env.d.ts |
| `void auth login` | 对项目已保存的部署目标进行身份认证，或选择目标 |
| `void account login` | 登录 Void 平台 |
| `void cloudflare login` | 通过 Void 登录 Cloudflare |
| `void platform install` | 在 Cloudflare 上安装团队 Void 平台 |
| `void connect <url>` | 将 CLI 连接到 Void 平台；主机名默认使用 HTTPS |
| `void project link` | 将目录关联到项目 |
| `void project logs` | 查看已部署项目的运行时日志 |
| `void project requests` | 查看请求级流量，包括状态、方法和耗时 |
| `void project rollback` | 回滚到之前的部署 |
| `void project cancel` | 取消正在进行的部署 |
| `void project zero-trust` | 检查或覆盖项目零信任防护设置 |
| `void project purge-cache` | 清除所有缓存页面，适用于 Void 平台 |
| `void build logs` | 流式查看、持续跟踪或下载构建日志 |
| `void email status` | 查看自己 Cloudflare 账号中的邮件就绪状态（`--platform cloudflare`） |
| `void email setup` | 在自己的 Cloudflare 账号中配置邮件，无需部署应用 |
| `void email usage` | 查看当月按收件地址计算的发送尝试次数、收到的邮件数量和额度 |
| `void email logs` | 查看近期邮件投递活动 |
| `void email destinations` | 列出已验证的收件地址 |
| `void email allow <address>` | 添加收件地址并发送验证邮件 |
| `void email disallow <address>` | 从允许名单中移除收件地址 |
| `void email alias [name]` | 查看共享邮件地址，或为其设置更短的永久名称 |
| `void email domain` | 在 Cloudflare DNS 区域中使用自己的域名收发邮件 |
| `void init` | 配置新项目或已有项目，包括编程 Agent |
| `void migrate` | 将旧版 `void.json` 和根目录的 Wrangler JSON/JSONC 配置转换为 `void.config.ts` |

## 运行命令 {#binary-invocation}

文档中为简洁起见，统一使用 `void`。在包脚本之外运行时，请通过包管理器执行：`npx void`、`pnpm void`、`yarn void`、`bunx void` 或 `vpx void`。

你也可以将 `./node_modules/.bin` 添加到 `PATH`，这样在应用根目录中就能直接运行 `void`。

:::warning ⚠️ 优先在项目中安装
请在项目中安装 `void`，确保 CLI 和运行时使用相同版本。
:::

## 帮助 {#help}

```
void --help
void help
void help <command>
void help <group> <command>
void <command> --help
void <group> <command> --help
void <group> help <command>
```

使用 `void --help` 查看命令列表，或通过 `void deploy --help` 查看某个命令的帮助。无需登录或配置项目即可查看帮助。

## 环境变量 {#environment-variables}

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `VOID_TOKEN` | 使用该认证令牌，覆盖已保存配置中的令牌 | 无 |
| `VOID_PROJECT` | 部署、密钥、域名和缓存清除命令使用的默认项目 slug | 无 |
