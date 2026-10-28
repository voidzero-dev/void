---
outline: deep
---

# 安装 Void 平台 {#install-a-void-platform}

Void 平台让团队可以共用一个 Cloudflare 账号部署应用。管理员负责安装和维护平台；开发者只需通过 Void CLI 连接平台地址，使用平台已启用的方式登录，即可部署自己的应用。

如果只是为自己部署应用，可以[直接部署到 Cloudflare](/integrations/cloudflare#deploy-to-your-own-cloudflare-account)，无需先安装平台。

核心平台支持 GitHub、Google、通用 OIDC 和 Cloudflare Access 登录，以及 CLI 部署、D1、KV、R2、Queues、定时任务、Workers AI、WebSockets、SSE、ISR、路由、日志和回滚。

核心安装包含托管 Sandbox 和邮件网关。配置共享邮件域名及对应的 Cloudflare DNS 区域（Zone）后，即可启用邮件功能。用户控制台、GitHub 构建与 Webhook，以及用于构建的 Containers 不在核心安装范围内。[项目自定义域名](/zh/guide/platform/installation/domains#project-custom-domains)需要通过 `--custom-domains` 显式启用。如果基于源码构建的平台添加了可选的 GitHub 服务，且 API 受到 Access 保护，请按[独立 Webhook 入口的配置步骤](/zh/guide/platform/development/runtime#optional-github-webhook-ingress-for-access-protected-apis)进行设置。

## 部署能力 {#deployment-features}

两种部署目标使用相同的应用 API。核心平台额外提供共享访问和部署历史保留：

| 功能 | 直接部署到 Cloudflare | 自托管核心平台 |
| --- | --- | --- |
| 静态站点、SPA 和原生 Pages SSR | 支持 | 支持 |
| 路由规则、WebSockets、队列、定时任务和 ISR | 支持 | 支持 |
| D1、KV、R2，以及通过 Hyperdrive 访问外部 SQL 数据库 | 支持 | 支持 |
| Workers AI 和 Provider 请求 | 使用你自己的账号和网关 | 使用安装时配置的网关和代理 |
| 运行时日志 | 实时查看 Cloudflare 日志 | 保留平台日志 |
| 应用回滚 | 使用 Worker 版本 | 使用平台保留的部署记录 |
| 类型化的 Durable State 和原生 Durable Objects | 支持 | 支持 |
| Sandbox | 需要 Workers Paid 和 Docker | 平台账号需要 Workers Paid |
| 应用自定义域名 | 支持 | 核心安装不提供 |
| 自动生成 GitHub 部署工作流 | 支持 | 在自己的 CI 中使用限定权限的开发者令牌 |
| 用户控制台和托管 GitHub 构建 | 不需要 | 标准安装不包含 |

团队平台需要 Workers for Platforms，以及文档中列出的[基础设施](/zh/guide/platform/installation/domains#cloudflare-footprint)。实际可用功能取决于平台安装时的配置。

## 安装指南 {#installation-guides}

- [准备工作](/zh/guide/platform/installation/prerequisites)
- [凭据](/zh/guide/platform/installation/credentials)
- [安装平台并配置登录](/zh/guide/platform/installation/setup)
- [首次部署](/zh/guide/platform/installation/first-deployment)
- [域名与资源](/zh/guide/platform/installation/domains)
- [维护与恢复](/zh/guide/platform/installation/maintenance)
- [通过 CI 安装](/zh/guide/platform/installation/ci)
- [停用与卸载](/zh/guide/platform/installation/uninstall)
