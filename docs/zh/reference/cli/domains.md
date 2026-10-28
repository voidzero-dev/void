---
outline: deep
---

# 自定义域名 {#custom-domains}

## `void domain add` {#void-domain-add}

```
void domain add <hostname> [--project <name>]
```

为已保存的部署目标添加自定义域名。托管的 Void 项目会显示 SaaS 主机名验证所需的 DNS 记录。直接部署到 Cloudflare 的项目会添加一条 `custom_domain` 路由，并立即同步路由配置；定时任务、队列和工作流触发器保持不变。Cloudflare 会在项目指定账号的 DNS 区域中管理 DNS 记录和 TLS 证书。如果仍在使用旧的单数 `route` 字段，请先将其转换为 `routes` 数组，避免新增域名时覆盖已有路由。

> 不支持通配符自定义主机名（`*.example.com`），请分别注册每个子域名。

## `void domain delete` {#void-domain-delete}

```
void domain delete <hostname> [--project <name>]
```

直接部署到 Cloudflare 的项目会立即应用此变更。删除最后一个自定义域名时，需要使用 `void cloudflare login` 建立的浏览器会话，或具有 Workers Scripts: Edit 权限的 API 令牌。如果 Cloudflare 拒绝变更，Void 会尝试恢复之前的域名配置，并报告恢复是否成功。

## `void domain list` {#void-domain-list}

```
void domain list [--project <name>]
```

列出所有自定义域名。托管项目会显示平台提供的已激活或待处理状态；直接部署到 Cloudflare 的项目则列出 `void.config.ts` 中当前配置的自定义域名路由。

## `void domain status` {#void-domain-status}

```
void domain status <hostname> [--project <name>] [--verbose]
```

显示域名验证和 TLS 证书状态，包括需要配置的 DNS 记录及待完成的操作。验证和证书签发完成后，域名会自动激活。

对于直接部署到 Cloudflare 的项目，状态仅报告该路由是否存在于 Void 的 Cloudflare 配置中，不会检查远程证书的签发状态；该状态由 Cloudflare 管理，可在其控制台中查看。`--project` 仅适用于托管项目。
