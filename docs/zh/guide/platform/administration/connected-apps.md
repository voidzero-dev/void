# 已连接应用 {#connected-apps}

已连接应用是注册为 Void 平台 OAuth 客户端的独立应用。用户在 Void 上登录，并决定是否连接该应用。应用运营者可能与平台管理员不同。

## 注册应用 {#register-an-application}

打开 **Admin → Connected apps（管理 → 已连接应用）**。填写应用名称、运营者，以及每个精确的 HTTPS 回调 URL，每个 URL 单独一行。不支持通配符，也不支持带查询字符串的回调 URL。如果应用需要构建和部署项目，请启用逐次发布审批；如果需要在发布前运行检查点，请启用私有预览。已有客户端可以通过 **Enable private previews（启用私有预览）** 按钮启用，用户需要重新连接应用，才能同意授予该权限。

将返回的客户端 ID 和密钥保存在应用的服务端。Void 只会显示密钥一次。客户端密钥用于验证应用身份，不会赋予访问用户账号的权限。如需替换凭据，请注册新客户端，再禁用旧客户端。

**Disable and revoke access（禁用并撤销访问）** 会使该客户端的授权、待完成的登录和发布审批失效。注册和禁用操作都会记录在运维审计中。

本地开发时，只有显式启用了平台的开发认证绕过功能，才允许使用 localhost 上的精确 HTTP 回调地址。生产客户端必须使用 HTTPS。

## 连接与断开连接 {#connect-and-disconnect}

应用会将用户引导到 Void 授权页面，页面会显示注册的应用名称、运营者、回调地址的源和请求的权限。登录授权只允许读取用户 ID 和用户名，不会提供账号令牌或项目管理权限。

用户可以在 `<platform API URL>/oauth/connections` 断开与应用的连接。授权会在一小时后过期；如果平台登录会话被撤销或账号被暂停，授权也会失效。访问权限过期后，应用必须请求用户重新登录。

## 私有预览 {#private-previews}

管理员启用相应功能后，登录时可以请求 `scope=profile preview:deploy`。用户同意后，应用即可构建私有预览，无需为每个检查点单独审批。发布到生产环境仍须逐次审批。

使用已获授权的 Bearer 令牌执行以下操作：

1. 将 `{ workspace: externalWorkspaceId }` POST 到 `/oauth/previews`。响应会返回该客户端、所有者和工作区对应的稳定 `project_id`，以及预览 `url`。
2. 将 `{ project_id, checkpoint, artifact: prepared.artifact }` POST 到 `/oauth/preview-deployment-requests`。使用返回的 `access_token` 和 `approval_id`，按与发布相同的资源上传和部署协议执行。
3. 部署完成后，向 `/oauth/previews/:id/launch` 发送 POST 请求，并打开返回的 URL。启动 URL 一分钟后过期，且只能使用一次。打开后，重新加载该源地址下的预览页面。

每个工作区都有独立的预览源和资源，不包含生产环境密钥。预览支持 HTTP 应用，并提供隔离的 D1、KV、R2、AI 和原生 Durable Objects。身份验证、外部数据库、邮件、定时任务、队列和容器需要发布到生产环境后才能使用。查看预览需要当前有效的用户授权；断开连接或禁用应用后，后续请求会被拒绝。写入预览的请求必须来自该预览自身的源。

账号的 Access 策略必须允许发往所生成预览源的请求到达 Void。阻止新 Worker 主机名的策略也会阻止预览。即使主机名可以访问，Void 仍要求具备有效的预览授权。

每个所有者最多可以有十个预览工作区。每个工作区每小时最多允许构建六十次，并与所有者共享平台资源和用量限制。不活跃的预览会在七天后过期，Void 会移除其资源。通过 `/oauth/previews` 打开工作区可以延长有效期。禁用预览权限会使对应预览过期。

## 批准发布 {#approve-a-publish}

应用先完成构建，再携带准备好的产物将用户引导到 Void。Void 会显示项目名称、检查点标签、资源、清单和产物摘要。用户必须在 Void 上明确批准。

一次批准只允许向用户选定的项目部署一次。项目不存在时，Void 会在审批期间创建；已有项目则要求用户拥有该项目。应用会获得最长十五分钟有效的凭据，仅可用于该产物的资源上传、部署和回执操作。重试使用同一份回执。

发布的代码可以使用该项目已有的密钥和资源。批准向已有项目发布代码前，请检查应用运营者和部署详情。已批准清单中的迁移和资源变更会在部署时生效。

禁用应用或断开其授权后，后续操作将不再获准；排队中的部署在正式发布前也会再次检查。断开连接不会移除已发布的应用，请通过 Void 管理对应项目。

## 开发 OAuth 客户端 {#build-an-oauth-client}

通过平台 API 源下的 `/.well-known/oauth-authorization-server` 发现端点。使用授权码流程，包含 `scope=profile`、随机 `state` 和 S256 PKCE。交换令牌时，使用 HTTP Basic 客户端认证。将访问令牌作为 Bearer 凭据发送到 `/oauth/userinfo`；响应包含 `sub`、`preferred_username` 和用户同意的 `scope`。

发布时，使用 [`prepareDeployArtifact`](/zh/reference/api/deploy) 打包已构建的应用。使用 profile 令牌向 `/oauth/deployment-requests` 发送 POST 请求：

```ts
{
  redirect_uri: registeredCallback,
  state: publishState,
  code_challenge: publishChallenge,
  code_challenge_method: 'S256',
  slug: projectSlug,
  checkpoint: checkpointLabel,
  artifact: prepared.artifact
}
```

将浏览器重定向到返回的 `authorization_url`。使用本次发布的 PKCE verifier 和同一已注册回调地址交换授权码。响应包含 `project_id`、`approval_id` 和权限范围为 `deploy:approve` 的访问令牌。此发布流程是 Void 的扩展；在普通登录中请求该权限范围，并不会获得部署权限。

使用令牌向 `POST /projects/:id/deploy/upload-urls` 请求上传 URL，上传已声明的资源，再将产物发送到 `POST /projects/:id/deploy`。将 `x-void-deploy-idempotency-key` 设置为 `approval_id`。部署采用 Void 的托管部署协议，并要求平台部署队列可用。该凭据不能读取密钥、创建项目令牌、删除项目，也不能部署字节内容不同的产物。

以客户端身份认证后，调用 `POST /oauth/revoke` 撤销身份授权。Void 不会签发刷新令牌或 OpenID Connect ID 令牌。

如果 API 受到 Cloudflare Access 保护，应用运营者还必须配置一个被该 Access 应用策略允许的服务身份。服务端 OAuth 端点和已批准的部署请求，仍会各自验证客户端、授权和项目权限；浏览器中的授权同意操作要求用户具有企业身份。
