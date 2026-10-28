---
outline: deep
---

# 本地开发 {#local-development}

## 准备仓库 {#setting-up-the-repository}

克隆自己的 fork，然后使用 Vite+ 安装工作区依赖：

```sh
git clone https://github.com/your-org/void.git
cd void
vp install
vpr install:void-dev
void-dev --help
```

使用 `.node-version` 中指定的 Node.js 版本。

`install:void-dev` 会构建 CLI、共享包和平台运行时，再将当前工作副本构建出的 CLI 注册为全局命令 `void-dev`。公共包导出的是构建产物，因此后续修改源码后，需要运行 `vp run build:core` 更新该命令使用的产物。安装程序不会覆盖其他来源的全局命令；使用 `vpr uninstall:void-dev` 只会移除当前工作副本注册的别名。这些开发指南中的命令都在仓库根目录执行。

## 查找对应实现 {#finding-the-implementation}

| 目录 | 职责 |
| --- | --- |
| `packages/void` | 框架、应用运行时和 CLI |
| `packages/platform` | 安装器约定、打包的 Worker 和平台迁移 |
| `packages/deploy-core`, `packages/deploy-cloudflare` | 共享部署约定和 Cloudflare 上传代码 |
| `platform/packages/api` | 用户、项目、部署、资源创建，以及管理员 API 和界面 |
| `platform/packages/dispatch` | 应用路由和静态资源 |
| `platform/packages/proxy` | AI、远程绑定和缓存重新验证 |
| `platform/packages/email-gateway` | 入站邮件路由和租户投递 |
| `platform/packages/tail` | 收集运行时日志 |
| `platform/packages/dashboard` | 控制台源码，以及 `ui/` 中的本地 UI 组件 |

`@voidcloud/*` 是工作区内部实现包的名称。它们通过 `private: true` 防止发布到 npm。可部署的核心 Worker 会打包到公共的 `@void/platform` 包中。

核心安装器会创建 API、dispatch、proxy、tail 和邮件网关 Worker。源码中也包含控制台和托管 GitHub 构建服务，但核心安装不包含这些服务。添加可选服务时，需要一并提供其基础设施、绑定、身份验证和功能配置。

## 在本地运行 API {#running-the-api-locally}

启动本地 PostgreSQL 服务器，并确保可以在命令行中找到 `psql` 和 `pg_isready`。然后创建开发数据库、执行迁移，并初始化管理员账号：

```sh
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev:admin
```

该命令会关闭可选的构建容器，因此基本的 API 和管理界面开发不需要 Docker。如果要开发托管构建功能，则需要安装 Docker，并在运行 API 时启用容器。

打开 `http://localhost:8787/admin/`。初始化过程会将 API 的本地数据库连接和开发环境的身份验证绕过设置写入 `platform/packages/api/.dev.vars`，并为独立控制台配置 `platform/packages/dashboard/.env`。这两个文件都被 Git 忽略。生产环境安装使用由安装器单独配置的凭据。

借助 API 的开发环境验证绕过机制，无需配置 OAuth 就能开发浏览器中的管理界面。但运维 CLI 会话仍需要管理员身份验证，不会使用浏览器的绕过机制。

`dev:admin` 会监听源码变化，并在编辑后自动刷新浏览器。开发管理控制台的 React 组件和样式时，保持该命令运行即可，无需部署平台。初始化过程还会创建示例用户、项目和部署，方便在本地查看各个页面。

## 在本地运行控制台 {#running-the-dashboard-locally}

控制台是源码中的独立应用。完成 API 初始化后，在另一个终端中启动它：

```sh
vp run --filter @voidcloud/dashboard dev
```

初始化过程会在控制台的本地 `.env` 中指向刚启动的 API：

```dotenv
API_URL=http://localhost:8787
SITE_DOMAIN=apps.example.com
```

打开 Vite 显示的地址，点击 **Dev login (local API)（开发登录：本地 API）**。只有使用 localhost API 时才会显示这个按钮，它调用的是本地开发登录端点。

你也可以让控制台连接自己运营的 API。如果该 API 受到 Cloudflare Access 保护，需要安装 `cloudflared`，并通过匹配的源地址启用控制台的本地令牌辅助功能：

```dotenv
API_URL=https://platform.example.com
CF_ACCESS_APP_URL=https://platform.example.com
SITE_DOMAIN=apps.example.com
```

辅助程序会在开发服务器启动前刷新 Access 会话。用户通过控制台发出的请求，需要同时具备该用户的 Access 会话和 Void 登录状态；服务令牌不能代表该用户。服务令牌凭据用于限定范围的机器操作。这些设置仅用于控制台开发，Access 凭据与平台登录凭据相互独立。

部署控制台时，将它的 `API` 服务绑定到平台 API，在控制台和 API 两端配置 `DASHBOARD_URL`，并将控制台的准确源地址加入平台的 Access 保护应用。控制台通过该服务绑定，将浏览器中的企业身份传递给 API。登录页面会显示平台当前启用的登录方式，**Account（账号）** 页面还支持添加其他登录身份。

## 验证修改 {#testing-changes}

开发过程中，运行与修改范围对应的测试：

```sh
vp test run platform/packages/api/test/integration/operator-auth.test.ts
vp run check
```

准备发布前，构建各个包并执行完整检查：

```sh
vp run build:all
vp run check
vp lint
vp run lint:platform
vp fmt --check
vp test run
vp run build:docs
```

平台集成测试默认使用本地测试数据库。如果要使用 PostgreSQL 运行测试，应将 `VOID_TEST_DATABASE_URL` 指向可随时丢弃的数据库，因为测试会在各个用例之间清空数据表。

如果要验证已部署的应用，可以部署一份仅供测试的 `playground/kitchen-sink` 副本，再将其 URL 作为 `SMOKE_URL` 传给 `platform/scripts/kitchen-sink-smoke-test.md` 中说明的冒烟测试。该测试会创建和删除应用数据。
